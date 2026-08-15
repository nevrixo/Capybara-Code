/**
 * Credential resolution — PRD §9.1, §9.2, §9.3, §9.4, §9.5, AC-02, AC-39.
 *
 * §9.1 keeps persistent storage in the Rust runtime; this module only decides
 * *which* credential to use and hands the resulting short-lived lease to the
 * provider. §9.2's precedence is implemented literally, and its last rule matters
 * most: in headless mode an ambiguity never becomes a prompt.
 *
 * Account-login tokens (§9.5) are resolved here too, which is why this module also
 * owns the on-disk token record and the refresh step. A refresh has to happen at
 * *resolution* time rather than when a request fails: by the time the provider sees a
 * 401 the turn has already started, and §9.5's `Refreshing → SignedIn` edge is
 * supposed to be invisible. The flow logic itself is in `account-login.ts`; this file
 * supplies the keychain, the filesystem, and the clock.
 */

import { createHash } from "node:crypto";

import type { CredentialLease, FetchLike } from "@cbc/provider-openai";

import {
  BUILTIN_ACCOUNT_REGISTRATION,
  OPENAI_ACCOUNT_REFRESH,
  OPENAI_ACCOUNT_TOKEN,
  ACCOUNT_RECORD_FILE,
  ACCOUNT_REGISTRATION_FILE,
  accountLease,
  activeRegistration,
  buildRefreshBody,
  needsAccountRefresh,
  parseAccountRecord,
  parseAccountRegistration,
  parseOpenAiAccountClaims,
  parseAccountTokenResponse,
  recordFromToken,
  registrationMatchesRecord,
  type AccountAuthState,
  type AccountClientRegistration,
  type AccountTokenRecord,
  type AccountTokenResponse,
  type ParsedAccountRegistration,
} from "./account-login.ts";
import { CliError, EXIT } from "./exit.ts";
import { join, type CbcPaths, type Host } from "./host.ts";
import { safeOAuthFetch } from "./oauth-fetch.ts";

/**
 * The credential operations this module needs from the runtime.
 *
 * Declared structurally rather than as `Runtime` for two reasons: it is the whole of
 * §20.3 that a credential decision is allowed to reach, and it lets the refresh path
 * be tested against a fake store instead of a live sidecar. `Runtime` satisfies it.
 */
export interface CredentialStore {
  leaseCredential(account: string, source?: string): Promise<CredentialLease>;
  storeCredential(
    account: string,
    secret: string,
  ): Promise<{
    readonly account: string;
    readonly backend: string;
    readonly persistent: boolean;
    readonly fingerprint: string;
  }>;
  deleteCredential(account: string): Promise<{ readonly removed: boolean }>;
}

/**
 * Re-exported so importers keep one entry point for credential concerns.
 *
 * §9.6's gate and its wording live in `account-login.ts` next to the flow they
 * govern, but `capy auth` has always reached for them here.
 */
export {
  ACCOUNT_LOGIN_UNAVAILABLE,
  ACCOUNT_REGISTRATION_FILE,
  OPENAI_ACCOUNT_REFRESH,
  OPENAI_ACCOUNT_TOKEN,
  accountLoginEnabled,
  accountLoginGate,
  parseAccountRegistration,
  unsatisfiedCriteria,
} from "./account-login.ts";

/** Keychain account name for the default OpenAI API key. */
export const OPENAI_ACCOUNT = "openai:api-key";

export type CredentialSource = "cli" | "environment" | "keychain" | "account" | "none";

export interface ResolvedCredential {
  readonly lease: CredentialLease;
  readonly source: CredentialSource;
}

export interface ResolveCredentialOptions {
  readonly runtime: CredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** An explicit `--api-key`-style selection, which outranks everything (§9.2). */
  readonly explicitKey?: string;
  readonly now?: () => number;
  /**
   * Needed to read the §9.5 token record. When absent the account-login branch is
   * skipped rather than guessed at, so a caller that has no filesystem access still
   * resolves an API key correctly.
   */
  readonly host?: Pick<Host, "fs">;
  readonly paths?: Pick<CbcPaths, "data">;
  readonly fetchImpl?: FetchLike;
  /** Overridden in tests; production reads the build's registration. */
  readonly registration?: AccountClientRegistration | undefined;
}

/**
 * Resolve a credential following §9.2.
 *
 * An environment key is turned into a lease-shaped value rather than being passed
 * around as a bare string, so every consumer downstream handles exactly one type and
 * `fingerprint` is always available for status output without exposing the secret.
 *
 * Account tokens never come out of this resolver (P0-14). They are minted for the
 * registration's own endpoint, and a generic resolver cannot know which base URL
 * is about to receive them — a lost or corrupt auth-mode file used to route an
 * account token to whatever API URL happened to be configured. Account mode
 * resolves its session explicitly through `resolveAccountSession`, which carries
 * the registration's URL with the credential.
 */
export async function resolveCredential(
  options: ResolveCredentialOptions,
): Promise<ResolvedCredential | undefined> {
  const now = options.now ?? (() => Date.now());

  if (options.explicitKey !== undefined && options.explicitKey.length > 0) {
    return {
      lease: syntheticLease(options.explicitKey, "cli", now()),
      source: "cli",
    };
  }

  const envKey = options.env.OPENAI_API_KEY;
  if (envKey !== undefined && envKey.trim().length > 0) {
    return {
      lease: syntheticLease(envKey.trim(), "environment", now()),
      source: "environment",
    };
  }

  try {
    const lease = await options.runtime.leaseCredential(OPENAI_ACCOUNT);
    return { lease, source: "keychain" };
  } catch {
    // Nothing stored, or the keychain is locked. There is no API key to use.
    return undefined;
  }
}

/** The §9.6-shaped error a command raises when no credential is available. */
export function missingCredentialError(): CliError {
  return new CliError(EXIT.auth, "no OpenAI credential is available", [
    "Run `capy auth api` or set OPENAI_API_KEY.",
    "ChatGPT sign-in credentials are not general OpenAI API credentials.",
  ]);
}

/**
 * Wrap a raw key as a lease.
 *
 * The TTL is nominal: an environment-supplied key has no server-side lifetime, but
 * the field is on the type so a consumer never has to branch on where the secret
 * came from.
 */
export function syntheticLease(
  secret: string,
  source: CredentialSource,
  nowMs: number,
  ttlMs = 15 * 60 * 1000,
): CredentialLease {
  return {
    leaseId: `lease_${source}_${nowMs.toString(36)}`,
    account: source === "environment" ? "OPENAI_API_KEY" : "cli",
    source,
    expiresAtMs: nowMs + ttlMs,
    fingerprint: fingerprint(secret),
    secret,
  };
}

/**
 * Non-reversible fingerprint, matching the runtime's purpose if not its algorithm.
 *
 * Used only to correlate "the same key" across status output and logs. §9.8 forbids
 * the secret itself from appearing anywhere, so status shows this instead.
 */
export function fingerprint(secret: string): string {
  // Credential status only needs a compact correlation label; derive it from a
  // cryptographic digest rather than exposing a reversible/low-entropy checksum.
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * Mask a secret for display (§9.8).
 *
 * Only the last four characters survive, and only when the value is long enough that
 * four characters are not most of it.
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "•".repeat(secret.length);
  return `${"•".repeat(20)}${secret.slice(-4)}`;
}

/**
 * Minimal shape check before spending a network round trip (§7.2 step 2).
 *
 * Deliberately permissive about the prefix: OpenAI has shipped several key formats,
 * and rejecting an unfamiliar but valid key would be worse than letting validation
 * give the authoritative answer.
 */
export function looksLikeApiKey(value: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: "the key is empty" };
  if (/\s/.test(trimmed)) return { ok: false, reason: "the key contains whitespace" };
  if (trimmed.length < 20) return { ok: false, reason: "the key is too short to be valid" };
  if (!/^[A-Za-z0-9_\-.]+$/.test(trimmed)) {
    return { ok: false, reason: "the key contains characters an API key never uses" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §9.5 account token store
// ---------------------------------------------------------------------------

export function accountRecordPath(paths: Pick<CbcPaths, "data">): string {
  return join(paths.data, "auth", ACCOUNT_RECORD_FILE);
}

export async function readAccountRecord(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
): Promise<AccountTokenRecord | undefined> {
  return parseAccountRecord(await host.fs.read(accountRecordPath(paths)));
}

export async function writeAccountRecord(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
  record: AccountTokenRecord,
): Promise<void> {
  await host.fs.mkdirp(join(paths.data, "auth"));
  await host.fs.atomicWrite(accountRecordPath(paths), `${JSON.stringify(record, null, 2)}\n`);
}

export async function deleteAccountRecord(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
): Promise<void> {
  await host.fs.remove(accountRecordPath(paths));
}

type StoredCredential = Awaited<ReturnType<CredentialStore["storeCredential"]>>;

async function snapshotSecret(
  runtime: CredentialStore,
  account: string,
): Promise<string | undefined> {
  try {
    return (await runtime.leaseCredential(account, "account")).secret;
  } catch {
    return undefined;
  }
}

async function restoreSecret(
  runtime: CredentialStore,
  account: string,
  secret: string | undefined,
): Promise<void> {
  if (secret === undefined) await runtime.deleteCredential(account);
  else await runtime.storeCredential(account, secret);
}

export interface ReplaceAccountTokenSetOptions {
  readonly runtime: CredentialStore;
  readonly host: Pick<Host, "fs">;
  readonly paths: Pick<CbcPaths, "data">;
  readonly registration: AccountClientRegistration;
  readonly response: AccountTokenResponse;
  readonly now: number;
  readonly previous?: AccountTokenRecord;
  readonly preserveExistingRefresh?: boolean;
}

/**
 * Store access, refresh, and metadata with compensating rollback.
 *
 * The record is committed last. A login response without a refresh token removes
 * any stale refresh entry; a refresh response may explicitly retain the old token.
 */
export async function replaceAccountTokenSet(
  options: ReplaceAccountTokenSetOptions,
): Promise<{ readonly record: AccountTokenRecord; readonly stored: StoredCredential }> {
  const recordPath = accountRecordPath(options.paths);
  const previousRaw = await options.host.fs.read(recordPath);
  const accessBefore = await snapshotSecret(options.runtime, OPENAI_ACCOUNT_TOKEN);
  const refreshBefore = await snapshotSecret(options.runtime, OPENAI_ACCOUNT_REFRESH);
  const retainRefresh =
    options.preserveExistingRefresh === true &&
    options.previous?.hasRefreshToken === true &&
    refreshBefore !== undefined;
  const computed = recordFromToken({
    response: options.response,
    registration: options.registration,
    now: options.now,
    ...(options.previous !== undefined ? { previous: options.previous } : {}),
  });
  const record: AccountTokenRecord = {
    ...computed,
    hasRefreshToken: options.response.refreshToken !== undefined || retainRefresh,
  };

  try {
    const stored = await options.runtime.storeCredential(
      OPENAI_ACCOUNT_TOKEN,
      options.response.accessToken,
    );
    if (options.response.refreshToken !== undefined) {
      await options.runtime.storeCredential(OPENAI_ACCOUNT_REFRESH, options.response.refreshToken);
    } else if (!retainRefresh) {
      await options.runtime.deleteCredential(OPENAI_ACCOUNT_REFRESH);
    }
    await writeAccountRecord(options.host, options.paths, record);
    return { record, stored };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await restoreSecret(options.runtime, OPENAI_ACCOUNT_TOKEN, accessBefore);
    } catch (rollbackError) {
      rollbackErrors.push(
        "access: " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
      );
    }
    try {
      await restoreSecret(options.runtime, OPENAI_ACCOUNT_REFRESH, refreshBefore);
    } catch (rollbackError) {
      rollbackErrors.push(
        "refresh: " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
      );
    }
    try {
      if (previousRaw === undefined) await options.host.fs.remove(recordPath);
      else await options.host.fs.atomicWrite(recordPath, previousRaw);
    } catch (rollbackError) {
      rollbackErrors.push(
        "record: " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackErrors.length === 0
        ? "account credential update failed; previous values were restored: " + reason
        : "account credential update failed and rollback was incomplete: " +
            reason +
            " (" +
            rollbackErrors.join("; ") +
            ")",
    );
  }
}
export interface AccountRefreshOptions {
  readonly runtime: CredentialStore;
  readonly host: Pick<Host, "fs">;
  readonly paths: Pick<CbcPaths, "data">;
  readonly registration: AccountClientRegistration;
  readonly record: AccountTokenRecord;
  readonly now: number;
  readonly fetchImpl?: FetchLike;
}

export type AccountRefreshOutcome =
  | {
      readonly state: "SignedIn";
      readonly lease: CredentialLease;
      readonly record: AccountTokenRecord;
    }
  | { readonly state: "ReauthRequired"; readonly reason: string }
  /**
   * The refresh could not complete, but nothing indicates the grant itself is
   * dead (network failure, timeout, 5xx/429). The session must stay `SignedIn`
   * so the next attempt can retry; only an authorization-level failure may
   * permanently invalidate it (P0-14).
   */
  | { readonly state: "TransientFailure"; readonly reason: string };

/**
 * §9.5's `SignedIn → Refreshing → SignedIn | ReauthRequired` path.
 *
 * Rotation is handled the way §9.5 requires: a response carrying a new refresh token
 * replaces the stored one, and a response omitting it leaves the existing token in
 * place. Every failure lands on `ReauthRequired` with a reason rather than being
 * retried here — a refresh that fails for an authorization reason will fail again,
 * and the retry policy for transport failures belongs to the caller.
 */
export async function refreshAccountToken(
  options: AccountRefreshOptions,
): Promise<AccountRefreshOutcome> {
  const { registration, record, now } = options;
  const doFetch = options.fetchImpl ?? safeOAuthFetch;

  // P0-14: a refresh token must never be sent to a registration that did not mint
  // it. A digest mismatch means the configured registration changed since login, so
  // the only honest outcome is re-authentication under the current registration.
  if (!registrationMatchesRecord(registration, record)) {
    return {
      state: "ReauthRequired",
      reason:
        "the stored session was minted under a different registration; sign in again with `capy auth login`",
    };
  }

  let refreshToken: string;
  try {
    const lease = await options.runtime.leaseCredential(record.refreshKeychainRef, "account");
    refreshToken = lease.secret;
  } catch {
    return {
      state: "ReauthRequired",
      reason: "no refresh token is stored; sign in again with `capy auth login`",
    };
  }

  let response: Response;
  try {
    response = await doFetch(registration.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: buildRefreshBody(refreshToken, registration).toString(),
    });
  } catch (error) {
    // A transport failure says nothing about the grant itself; the session stays
    // usable and the next attempt retries (P0-14).
    return {
      state: "TransientFailure",
      reason: `could not reach the token endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!response.ok) {
    const status = response.status;
    // 401/403 are authorization verdicts. A 400 is only terminal when the token
    // endpoint names a grant-level OAuth error; any other 4xx/5xx is treated as
    // transient so a flaky endpoint cannot permanently sign the user out.
    if (status === 401 || status === 403) {
      return { state: "ReauthRequired", reason: `the token endpoint returned ${status}` };
    }
    if (status === 400) {
      const body = await response.json().catch(() => undefined);
      const code =
        body !== undefined && typeof body === "object" && body !== null
          ? (body as Record<string, unknown>).error
          : undefined;
      const grantLevel =
        code === "invalid_grant" ||
        code === "unauthorized_client" ||
        code === "access_denied" ||
        code === "invalid_client";
      return grantLevel
        ? { state: "ReauthRequired", reason: `the token endpoint refused the grant (${String(code)})` }
        : { state: "TransientFailure", reason: `the token endpoint returned ${status}` };
    }
    return { state: "TransientFailure", reason: `the token endpoint returned ${status}` };
  }

  const parsed = parseAccountTokenResponse(
    await response.json().catch(() => undefined),
    now,
    registration.protocol,
  );
  if (parsed === undefined) {
    return { state: "ReauthRequired", reason: "the refresh response carried no usable token" };
  }

  try {
    const persisted = await replaceAccountTokenSet({
      runtime: options.runtime,
      host: options.host,
      paths: options.paths,
      registration,
      response: parsed,
      now,
      previous: record,
      preserveExistingRefresh: true,
    });
    return {
      state: "SignedIn",
      lease: accountLease(parsed.accessToken, persisted.record, now, fingerprint),
      record: persisted.record,
    };
  } catch (error) {
    return {
      state: "TransientFailure",
      reason:
        "credential rotation could not be committed: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Resolve the account-login credential, refreshing it first if it is due.
 *
 * Returns `undefined` for every "not signed in" case, including a token that can no
 * longer be refreshed. The caller then reports "no credential" rather than a refresh
 * failure, because from the user's side those are the same situation and the
 * remedy — `capy auth login` — is identical.
 */
export async function resolveAccountCredential(
  options: ResolveCredentialOptions,
): Promise<ResolvedCredential | undefined> {
  const host = options.host;
  const paths = options.paths;
  if (host === undefined || paths === undefined) return undefined;

  // Account credentials are usable only with an explicit qualified registration.
  const registration = activeRegistration(options.registration);
  if (registration === undefined) return undefined;

  const record = await readAccountRecord(host, paths);
  if (record === undefined) return undefined;
  // Bind both refresh and ordinary inference use to the exact destination that
  // minted the token. Legacy records deliberately fail this check.
  if (!registrationMatchesRecord(registration, record)) return undefined;
  if (record.issuer !== registration.issuer || record.audience !== registration.audience) {
    return undefined;
  }
  if (registration.protocol === "chatgpt" && record.protocol !== "chatgpt") {
    return undefined;
  }
  if (record.state === "Revoked" || record.state === "ReauthRequired") return undefined;

  const now = (options.now ?? (() => Date.now()))();

  if (needsAccountRefresh(record, now)) {
    const outcome = await refreshAccountToken({
      runtime: options.runtime,
      host,
      paths,
      registration,
      record,
      now,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (outcome.state === "ReauthRequired") {
      await markAccountState(host, paths, record, "ReauthRequired");
      return undefined;
    }
    if (outcome.state !== "SignedIn") {
      // A refresh attempted in the skew window may fail transiently while the
      // current access token is still valid. Keep serving it until actual expiry.
      if (record.expiresAtMs === undefined || record.expiresAtMs <= now) return undefined;
      try {
        const lease = await options.runtime.leaseCredential(record.keychainRef, "account");
        return { lease: accountLease(lease.secret, record, now, fingerprint), source: "account" };
      } catch {
        return undefined;
      }
    }
    return { lease: outcome.lease, source: "account" };
  }

  try {
    const lease = await options.runtime.leaseCredential(record.keychainRef, "account");
    return { lease: accountLease(lease.secret, record, now, fingerprint), source: "account" };
  } catch {
    return undefined;
  }
}

/** Persist a §9.5 state change without touching the stored secrets. */
export async function markAccountState(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
  record: AccountTokenRecord,
  state: AccountAuthState,
): Promise<AccountTokenRecord> {
  const next: AccountTokenRecord = { ...record, state };
  await writeAccountRecord(host, paths, next);
  return next;
}

// ---------------------------------------------------------------------------
// Account session (§9.5, §9.6, §10.1)
// ---------------------------------------------------------------------------

/**
 * Where a per-install registration document lives.
 *
 * Under the *config* directory rather than the data directory: it is something an
 * operator writes and would reasonably keep in version control or push with a
 * dotfile manager, unlike the token record, which is derived state. The environment
 * override matches the convention `CBC_RUNTIME_BINARY` and `CBC_MOCK_PROVIDER`
 * already set.
 */
export function accountRegistrationPath(
  paths: Pick<CbcPaths, "config">,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const override = env.CBC_ACCOUNT_REGISTRATION;
  if (override !== undefined && override.length > 0) return override;
  return join(paths.config, "auth", ACCOUNT_REGISTRATION_FILE);
}

/** Read the registration document, if there is one. */
export async function loadAccountRegistration(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "config">,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ParsedAccountRegistration> {
  const raw = await host.fs.read(accountRegistrationPath(paths, env));
  if (raw !== undefined && raw.trim().length > 0) return parseAccountRegistration(raw);
  return { registration: BUILTIN_ACCOUNT_REGISTRATION, issues: [] };
}

/**
 * Everything the provider needs to run a turn on an account token.
 *
 * The registration travels with the credential rather than being looked up again
 * downstream, because `inferenceBaseUrl` and `inferenceHeaders` are part of what
 * makes the token usable. Splitting them would let a token be sent to the default
 * base URL, which is the failure mode that produces a bare 401 with nothing to go on.
 */
export interface AccountSession {
  readonly registration: AccountClientRegistration;
  readonly lease: CredentialLease;
  readonly source: CredentialSource;
  readonly baseUrl: string;
  readonly protocol: "standard" | "chatgpt";
  readonly accountId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ResolveAccountSessionOptions {
  readonly runtime: CredentialStore;
  readonly host: Pick<Host, "fs">;
  readonly paths: Pick<CbcPaths, "config" | "data">;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly fetchImpl?: FetchLike;
  /** Overridden in tests; production reads the configured document. */
  readonly registration?: AccountClientRegistration;
}

/**
 * Resolve the account session, refreshing the access token if it is due.
 *
 * Note that this does *not* go through `resolveCredential`. §9.2 ranks a stored API
 * key above an account token, which is the right default when nothing has been
 * selected — but a session that was explicitly put in account mode must not silently
 * fall back to API billing because a key happens to be in the keychain. So the
 * account credential is resolved directly, and "not signed in" stays distinguishable
 * from "signed in as someone else".
 */
export async function resolveAccountSession(
  options: ResolveAccountSessionOptions,
): Promise<AccountSession | undefined> {
  const env = options.env ?? {};
  const configured =
    options.registration ??
    (await loadAccountRegistration(options.host, options.paths, env)).registration;

  // An absent configured document keeps account mode unavailable.
  const registration = activeRegistration(configured);
  if (registration === undefined) return undefined;

  const resolved = await resolveAccountCredential({
    runtime: options.runtime,
    env,
    host: options.host,
    paths: options.paths,
    registration,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (resolved === undefined) return undefined;

  const record = await readAccountRecord(options.host, options.paths);
  const accountId =
    record?.accountId ?? parseOpenAiAccountClaims(resolved.lease.secret).accountId;
  if (registration.protocol === "chatgpt" && accountId === undefined) {
    return undefined;
  }

  return {
    registration,
    lease: resolved.lease,
    source: resolved.source,
    baseUrl: registration.inferenceBaseUrl,
    protocol: registration.protocol ?? "standard",
    ...(accountId !== undefined ? { accountId } : {}),
    ...(registration.inferenceHeaders !== undefined
      ? { headers: registration.inferenceHeaders }
      : {}),
  };
}
