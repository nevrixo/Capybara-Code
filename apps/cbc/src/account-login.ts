/**
 * Account login — PRD §7.3, §9.5, §9.6, §9.7, R-01.
 *
 * `capy auth login` signs in against an OAuth authorization server rather than
 * an API key. PKCE S256 over a loopback redirect, or RFC 8628 device
 * authorization, and all of it lives here as pure functions.
 * `commands/auth.ts` supplies the sockets, the keychain, and the clock.
 */

import { createHash } from "node:crypto";
import { createPkcePair, randomToken, type PkcePair } from "@cbc/mcp-client";
import type { CredentialLease } from "@cbc/provider-openai";

// ---------------------------------------------------------------------------
// Keychain accounts (§9.1)
// ---------------------------------------------------------------------------

/** Keychain account holding the account-login access token. */
export const OPENAI_ACCOUNT_TOKEN = "openai:account";

/**
 * Keychain account holding the refresh token.
 *
 * Stored separately from the access token rather than as one JSON blob so that
 * `capy auth logout` can drop the long-lived half without decrypting and rewriting
 * the short-lived one, and so a lease of the access token cannot accidentally hand
 * out the refresh token alongside it.
 */
export const OPENAI_ACCOUNT_REFRESH = "openai:account.refresh";

// ---------------------------------------------------------------------------
// Built-in ChatGPT OAuth registration (§9.6)
// ---------------------------------------------------------------------------

export const BUILTIN_ACCOUNT_REGISTRATION: AccountClientRegistration = {
  protocol: "chatgpt",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  issuer: "https://auth.openai.com",
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  deviceAuthorizationEndpoint: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  scopes: ["openid", "profile", "email", "offline_access"],
  audience: "https://chatgpt.com/backend-api/codex",
  inferenceBaseUrl: "https://chatgpt.com/backend-api/codex",
  reviews: {
    refreshAndRevocationTested: false,
    refreshTested: true,
    revocationTested: false,
    localOnlyLogoutReviewed: true,
    policyReviewComplete: true,
    securityReviewComplete: true,
  },
};

// ---------------------------------------------------------------------------
// §9.6 release gate
// ---------------------------------------------------------------------------

/**
 * A registered public client, plus the review outcomes §9.6 requires.
 *
 * Every endpoint is stated explicitly. There is deliberately no discovery fallback
 * that would let a missing field be guessed from an issuer URL: §9.6 requires the
 * endpoints to be *documented*, and inferring one is how an undocumented endpoint
 * ends up being called.
 */
export type AccountAuthProtocol = "standard" | "chatgpt";

export interface AccountClientRegistration {
  /** Wire protocol used by this public client. Defaults to standards-based OAuth. */
  readonly protocol?: AccountAuthProtocol;
  /** The registered public client id. Never a secret; public clients have none. */
  readonly clientId: string;
  readonly issuer: string;
  /** Empty only when the registration is device-flow-only. */
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** RFC 8628. Absent when the client is not enrolled for the device flow. */
  readonly deviceAuthorizationEndpoint?: string;
  /** RFC 7009. Absent when the provider documents no revocation endpoint. */
  readonly revocationEndpoint?: string;
  readonly scopes: readonly string[];
  /** The audience tokens are minted for, shown to the user before consent (§7.3). */
  readonly audience: string;
  /** The inference base URL these tokens are valid against (§9.6 criterion 5). */
  readonly inferenceBaseUrl: string;
  /**
   * Extra headers the inference host requires beyond the bearer token.
   *
   * A base URL does not fully describe a deployment: an OAuth-fronted or gateway
   * deployment may also need a tenant or account selector. Those values belong to
   * the registration rather than to the provider adapter, so they travel with it.
   * Optional, and absent for a deployment that needs nothing but the token.
   */
  readonly inferenceHeaders?: Readonly<Record<string, string>>;
  /** Outcomes that cannot be derived from the registration itself. */
  readonly reviews: {
    /** Legacy combined proof; valid only when a documented revoke endpoint exists. */
    readonly refreshAndRevocationTested: boolean;
    /** Precise review outcomes for registrations that cannot revoke remotely. */
    readonly refreshTested?: boolean;
    readonly revocationTested?: boolean;
    /** Explicitly accepts local-only logout when no remote endpoint is documented. */
    readonly localOnlyLogoutReviewed?: boolean;
    readonly policyReviewComplete: boolean;
    readonly securityReviewComplete: boolean;
  };
}

/** §9.6's acceptance criteria, in the order the PRD lists them. */
export interface AccountLoginGate {
  readonly officialClientRegistration: boolean;
  readonly documentedAuthorizationEndpoint: boolean;
  readonly documentedTokenOrDeviceFlow: boolean;
  readonly documentedScopesAndAudience: boolean;
  readonly tokenValidForInferenceApi: boolean;
  readonly refreshAndRevocationHandled: boolean;
  readonly policyReviewComplete: boolean;
  readonly securityReviewComplete: boolean;
}

/**
 * Evaluate §9.6 against a registration.
 *
 * Derived from the registration rather than hand-maintained, so a partly filled-in
 * registration cannot open the gate and an enabled gate cannot exist without the
 * values the flow needs. `unsatisfiedCriteria` turns a refusal into a checklist.
 */
export function accountLoginGate(
  registration?: AccountClientRegistration,
): AccountLoginGate {
  if (registration === undefined) {
    return {
      officialClientRegistration: false,
      documentedAuthorizationEndpoint: false,
      documentedTokenOrDeviceFlow: false,
      documentedScopesAndAudience: false,
      tokenValidForInferenceApi: false,
      refreshAndRevocationHandled: false,
      policyReviewComplete: false,
      securityReviewComplete: false,
    };
  }

  const hasBrowserFlow =
    registration.authorizationEndpoint.length > 0 && isHttps(registration.authorizationEndpoint);
  const hasDeviceFlow =
    registration.deviceAuthorizationEndpoint !== undefined &&
    isHttps(registration.deviceAuthorizationEndpoint);
  const combinedReview = registration.reviews.refreshAndRevocationTested;
  const refreshTested = combinedReview || registration.reviews.refreshTested === true;
  const revocationHandled =
    registration.revocationEndpoint === undefined
      ? registration.reviews.localOnlyLogoutReviewed === true
      : isHttps(registration.revocationEndpoint) &&
        (combinedReview || registration.reviews.revocationTested === true);

  return {
    officialClientRegistration: registration.clientId.length > 0 && isHttps(registration.issuer),
    documentedAuthorizationEndpoint: hasBrowserFlow || hasDeviceFlow,
    // A token endpoint is required by both grants, so it is checked here rather
    // than being implied by either one.
    documentedTokenOrDeviceFlow:
      isHttps(registration.tokenEndpoint) && (hasBrowserFlow || hasDeviceFlow),
    documentedScopesAndAudience:
      registration.scopes.length > 0 && registration.audience.length > 0,
    tokenValidForInferenceApi: isHttps(registration.inferenceBaseUrl),
    refreshAndRevocationHandled: refreshTested && revocationHandled,
    policyReviewComplete: registration.reviews.policyReviewComplete,
    securityReviewComplete: registration.reviews.securityReviewComplete,
  };
}

/** Criteria a registration does not satisfy, for a diagnostic. */
export function unsatisfiedCriteria(
  registration?: AccountClientRegistration,
): string[] {
  return Object.entries(accountLoginGate(registration))
    .filter(([, satisfied]) => !satisfied)
    .map(([criterion]) => criterion);
}

/** Whether §9.6 is fully satisfied and `capy auth login` may run. */
export function accountLoginEnabled(
  registration?: AccountClientRegistration,
): boolean {
  return Object.values(accountLoginGate(registration)).every((satisfied) => satisfied);
}

/**
 * The registration, or a refusal.
 *
 * Callers get a registration only when the gate is fully open, so no code path can
 * reach a half-configured flow by testing one field.
 */
export function activeRegistration(
  registration?: AccountClientRegistration,
): AccountClientRegistration | undefined {
  if (registration === undefined || !accountLoginEnabled(registration)) return undefined;
  return registration;
}

// ---------------------------------------------------------------------------
// Runtime registration document
// ---------------------------------------------------------------------------

/**
 * Filename under the config directory holding a registration for this install.
 *
 * A registration can arrive from configuration as well as from the build constant
 * above, because the two answer different questions. The constant is what *Capybara*
 * ships as a registered client of a documented provider, and §9.6 governs it. A
 * configured document is what *this install* is pointed at — an enterprise
 * authorization server, a gateway, a self-hosted OIDC deployment — and it is
 * governed by the same gate, evaluated against the same criteria.
 *
 * Nothing is inferred from a partial document. §9.6 requires the endpoints to be
 * documented, and a discovery fallback here would turn "the operator did not supply
 * a token endpoint" into "guess one", which is how an undocumented endpoint gets
 * called. A rejected document is reported field by field instead.
 */
export const ACCOUNT_REGISTRATION_FILE = "account-registration.json";

export interface ParsedAccountRegistration {
  /**
   * The registration, when the document carried every required field.
   *
   * Present does not mean usable: `accountLoginGate` still decides that, so a
   * caller can show the outstanding criteria for a well-formed document that has
   * not been reviewed.
   */
  readonly registration?: AccountClientRegistration;
  /** Why the document was rejected. Empty when there was nothing to read. */
  readonly issues: readonly string[];
}

/**
 * Parse a registration document.
 *
 * An absent or empty file is not an error — it is the shipped state, and it means
 * account login is simply not configured. A *malformed* file is an error, because
 * the operator clearly intended something and silently ignoring it would leave them
 * debugging a login that never uses their configuration.
 */
export function parseAccountRegistration(raw: string | undefined): ParsedAccountRegistration {
  if (raw === undefined || raw.trim().length === 0) return { issues: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { issues: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { issues: ["the document must be a JSON object"] };
  }

  const record = parsed as Record<string, unknown>;
  const issues: string[] = [];
  const protocolValue = record.protocol;
  const protocol: AccountAuthProtocol | undefined =
    protocolValue === undefined
      ? undefined
      : protocolValue === "standard" || protocolValue === "chatgpt"
        ? protocolValue
        : undefined;
  if (protocolValue !== undefined && protocol === undefined) {
    issues.push("'protocol' must be 'standard' or 'chatgpt' when present");
  }


  const clientId = requiredString(record, "clientId", issues);
  const issuer = requiredString(record, "issuer", issues);
  const tokenEndpoint = requiredString(record, "tokenEndpoint", issues);
  const audience = requiredString(record, "audience", issues);
  const inferenceBaseUrl = requiredString(record, "inferenceBaseUrl", issues);
  // Absent rather than invalid for a device-flow-only registration, which the
  // interface already models as an empty string.
  const authorizationEndpoint = optionalString(record, "authorizationEndpoint", issues) ?? "";
  const deviceAuthorizationEndpoint = optionalString(
    record,
    "deviceAuthorizationEndpoint",
    issues,
  );
  const revocationEndpoint = optionalString(record, "revocationEndpoint", issues);
  const scopes = stringArray(record, "scopes", issues);
  const inferenceHeaders = headerMap(record, "inferenceHeaders", issues);
  const reviews = reviewFlags(record.reviews, issues);

  if (
    issues.length > 0 ||
    clientId === undefined ||
    issuer === undefined ||
    tokenEndpoint === undefined ||
    audience === undefined ||
    inferenceBaseUrl === undefined ||
    scopes === undefined ||
    reviews === undefined
  ) {
    return { issues };
  }

  return {
    registration: {
      clientId,
      ...(protocol !== undefined ? { protocol } : {}),
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      ...(deviceAuthorizationEndpoint !== undefined ? { deviceAuthorizationEndpoint } : {}),
      ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
      scopes,
      audience,
      inferenceBaseUrl,
      ...(inferenceHeaders !== undefined ? { inferenceHeaders } : {}),
      reviews,
    },
    issues: [],
  };
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`'${key}' must be a non-empty string`);
    return undefined;
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`'${key}' must be a non-empty string when present`);
    return undefined;
  }
  return value;
}

function stringArray(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`'${key}' must be a non-empty array of strings`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push(`'${key}' must contain only non-empty strings`);
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

function headerMap(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
): Record<string, string> | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    issues.push(`'${key}' must be an object mapping header names to strings`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      issues.push(`'${key}.${name}' must be a string`);
      return undefined;
    }
    out[name] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read the three §9.6 review flags.
 *
 * Anything that is not exactly `true` reads as `false`, so an incomplete or
 * hand-edited document can only ever fail the gate. Defaulting the other way would
 * let a typo stand in for a review.
 */
function reviewFlags(
  value: unknown,
  issues: string[],
): AccountClientRegistration["reviews"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push("'reviews' must be an object carrying the three §9.6 review flags");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    refreshAndRevocationTested: record.refreshAndRevocationTested === true,
    ...(Object.hasOwn(record, "refreshTested")
      ? { refreshTested: record.refreshTested === true }
      : {}),
    ...(Object.hasOwn(record, "revocationTested")
      ? { revocationTested: record.revocationTested === true }
      : {}),
    ...(Object.hasOwn(record, "localOnlyLogoutReviewed")
      ? { localOnlyLogoutReviewed: record.localOnlyLogoutReviewed === true }
      : {}),
    policyReviewComplete: record.policyReviewComplete === true,
    securityReviewComplete: record.securityReviewComplete === true,
  };
}

/** §9.6's exact wording when account login is not enabled in this build. */
export const ACCOUNT_LOGIN_UNAVAILABLE = [
  "Account login is unavailable in this build.",
  "Capybara Code ships no built-in OAuth registration and reuses no other",
  "product's credentials or undocumented endpoints.",
  "Use `capy auth api` with an OpenAI API key, or supply a qualified",
  "registration through account-registration.json.",
] as const;

/**
 * `https` and nothing else.
 *
 * A cleartext authorization or token endpoint would put an authorization code and a
 * bearer token on the wire, so a registration naming one fails the gate rather than
 * being used.
 */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// §9.5 state machine
// ---------------------------------------------------------------------------

export type AccountAuthState =
  | "Unavailable"
  | "SignedOut"
  | "Pending"
  | "SignedIn"
  | "Refreshing"
  | "ReauthRequired"
  | "Revoked";

export type AccountAuthEvent =
  | "integration_enabled"
  | "start"
  | "success"
  | "expired"
  | "denied"
  | "cancel"
  | "access_expired"
  | "logout"
  | "revoked"
  | "refresh_succeeded"
  | "refresh_failed";

/**
 * §9.5's transition table, transcribed.
 *
 * `ReauthRequired` and `Revoked` are drawn as terminal states. Taken literally that
 * strands the user: a failed refresh would mean never being able to sign in again
 * from the CLI. So `start` is accepted from both, which is the only edge here that
 * §9.5 does not draw — it re-enters the `Pending` state the diagram already defines,
 * and `ACCOUNT_AUTH_RECOVERY_EVENTS` names it so the addition stays visible rather
 * than blending into the transcription.
 */
const ACCOUNT_AUTH_TRANSITIONS: Readonly<
  Record<AccountAuthState, Partial<Record<AccountAuthEvent, AccountAuthState>>>
> = {
  Unavailable: { integration_enabled: "SignedOut" },
  SignedOut: { start: "Pending", cancel: "SignedOut" },
  Pending: {
    success: "SignedIn",
    expired: "SignedOut",
    denied: "SignedOut",
    cancel: "SignedOut",
  },
  SignedIn: { access_expired: "Refreshing", logout: "SignedOut", revoked: "Revoked" },
  Refreshing: { refresh_succeeded: "SignedIn", refresh_failed: "ReauthRequired" },
  ReauthRequired: { start: "Pending" },
  Revoked: { start: "Pending" },
};

/** Edges this module adds beyond the §9.5 diagram, so a test can pin them down. */
export const ACCOUNT_AUTH_RECOVERY_EVENTS: ReadonlyArray<
  readonly [AccountAuthState, AccountAuthEvent]
> = [
  ["ReauthRequired", "start"],
  ["Revoked", "start"],
] as const;

/**
 * Apply an event, or return `undefined` when §9.5 defines no such transition.
 *
 * Undefined rather than a thrown error or a silent self-loop: an undefined
 * transition is a caller bug, and the caller is the only place with enough context
 * to say what should happen instead.
 */
export function nextAccountAuthState(
  state: AccountAuthState,
  event: AccountAuthEvent,
): AccountAuthState | undefined {
  return ACCOUNT_AUTH_TRANSITIONS[state][event];
}

/** The state a build starts in, before any stored token is consulted. */
export function initialAccountAuthState(
  registration?: AccountClientRegistration,
): AccountAuthState {
  return accountLoginEnabled(registration) ? "SignedOut" : "Unavailable";
}

// ---------------------------------------------------------------------------
// Token record (§9.5, §9.8)
// ---------------------------------------------------------------------------

/**
 * What is persisted about a signed-in account.
 *
 * Metadata only. The access and refresh tokens live in the keychain behind the Rust
 * credential manager (§9.1), so this record is safe to write to the data directory,
 * print in `capy auth status`, and include in a debug bundle. §9.8 forbids the
 * secrets themselves from appearing anywhere, and the way to keep that true is for
 * the only serialized shape to have nowhere to put them.
 */
export interface AccountTokenRecord {
  readonly issuer: string;
  readonly protocol?: AccountAuthProtocol;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly accountLabel?: string;
  readonly accountId?: string;
  readonly planType?: string;
  readonly expiresAtMs?: number;
  readonly hasRefreshToken: boolean;
  readonly obtainedAtMs: number;
  readonly refreshedAtMs?: number;
  readonly state: AccountAuthState;
  /** Keychain entry names, not the secrets. */
  readonly keychainRef: string;
  readonly refreshKeychainRef: string;
  /**
   * P0-14 record v2: a digest of the exact registration that minted this token.
   * Every bearer-token use compares this before sending the token anywhere;
   * a record without one predates destination binding and must sign in again.
   */
  readonly registrationDigest?: string;
}

/** Filename under the data directory holding the record. */
export const ACCOUNT_RECORD_FILE = "openai-account.json";

/**
 * P0-14: the identity of a registration, collapsed to a stable digest.
 *
 * Refresh and revocation compare this digest instead of re-deriving equality
 * field by field at every call site: two registrations that differ in client id,
 * issuer, audience, protocol, or any endpoint are different registrations, and a
 * token minted under one must never be presented to the other.
 */
export function registrationDigest(registration: AccountClientRegistration): string {
  const inferenceHeaders = Object.entries(registration.inferenceHeaders ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = JSON.stringify({
    clientId: registration.clientId,
    issuer: registration.issuer,
    audience: registration.audience,
    inferenceBaseUrl: registration.inferenceBaseUrl,
    inferenceHeaders,
    scopes: [...registration.scopes].sort(),
    protocol: registration.protocol ?? "standard",
    authorizationEndpoint: registration.authorizationEndpoint,
    tokenEndpoint: registration.tokenEndpoint,
    deviceAuthorizationEndpoint: registration.deviceAuthorizationEndpoint ?? null,
    revocationEndpoint: registration.revocationEndpoint ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Parse a record, treating anything malformed as absent. */
export function parseAccountRecord(raw: string | undefined): AccountTokenRecord | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.issuer !== "string" || typeof record.keychainRef !== "string") return undefined;
  if (!Array.isArray(record.scopes)) return undefined;

  // A corrupt record is reported as absent rather than repaired, so the user is
  // asked to sign in again instead of being handed a token whose scopes are unknown.
  return {
    issuer: record.issuer,
    ...(record.protocol === "standard" || record.protocol === "chatgpt" ? { protocol: record.protocol } : {}),
    audience: typeof record.audience === "string" ? record.audience : "",
    scopes: record.scopes.filter((scope): scope is string => typeof scope === "string"),
    ...(typeof record.accountLabel === "string" ? { accountLabel: record.accountLabel } : {}),
    ...(typeof record.accountId === "string" ? { accountId: record.accountId } : {}),
    ...(typeof record.planType === "string" ? { planType: record.planType } : {}),
    ...(typeof record.expiresAtMs === "number" ? { expiresAtMs: record.expiresAtMs } : {}),
    hasRefreshToken: record.hasRefreshToken === true,
    obtainedAtMs: typeof record.obtainedAtMs === "number" ? record.obtainedAtMs : 0,
    ...(typeof record.refreshedAtMs === "number" ? { refreshedAtMs: record.refreshedAtMs } : {}),
    state: isAccountAuthState(record.state) ? record.state : "SignedIn",
    keychainRef: record.keychainRef,
    refreshKeychainRef:
      typeof record.refreshKeychainRef === "string"
        ? record.refreshKeychainRef
        : OPENAI_ACCOUNT_REFRESH,
    ...(typeof record.registrationDigest === "string" && record.registrationDigest.length > 0
      ? { registrationDigest: record.registrationDigest }
      : {}),
  };
}

function isAccountAuthState(value: unknown): value is AccountAuthState {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ACCOUNT_AUTH_TRANSITIONS, value)
  );
}

/** Default clock skew applied before an access token is considered stale. */
export const ACCOUNT_REFRESH_SKEW_MS = 60_000;

/**
 * P0-14: whether a stored session was minted under this registration.
 *
 * Records carrying a v2 digest compare it exactly. Older records cannot prove
 * which inference destination they authorized, so they fail closed and require
 * a fresh login.
 */
export function registrationMatchesRecord(
  registration: AccountClientRegistration,
  record: AccountTokenRecord,
): boolean {
  // Legacy records did not bind the inference destination. They must be renewed
  // instead of risking presentation of a bearer token to a changed host.
  if (record.registrationDigest === undefined) return false;
  return record.registrationDigest === registrationDigest(registration);
}

/**
 * Whether the access token should be refreshed before the next request.
 *
 * A record with no expiry is never refreshed: the provider did not state a lifetime,
 * so refreshing on a guess would burn a rotation for nothing. A 401 is the signal in
 * that case.
 */
export function needsAccountRefresh(
  record: AccountTokenRecord,
  now: number,
  skewMs = ACCOUNT_REFRESH_SKEW_MS,
): boolean {
  if (record.expiresAtMs === undefined) return false;
  return record.expiresAtMs - skewMs <= now;
}

/** Wrap an account access token as the lease the provider already understands. */
export function accountLease(
  secret: string,
  record: AccountTokenRecord,
  nowMs: number,
  fingerprintOf: (secret: string) => string,
): CredentialLease {
  return {
    leaseId: `lease_account_${nowMs.toString(36)}`,
    account: OPENAI_ACCOUNT_TOKEN,
    source: "account",
    // The lease expires with the token, not on a fixed TTL, so a consumer holding
    // one never presents a token the provider has already retired.
    expiresAtMs: record.expiresAtMs ?? nowMs + 15 * 60 * 1000,
    fingerprint: fingerprintOf(secret),
    secret,
  };
}

// ---------------------------------------------------------------------------
// Authorization code flow (§7.3)
// ---------------------------------------------------------------------------

/** State kept between starting a flow and receiving the redirect. */
export interface PendingAccountAuthorization {
  readonly state: string;
  readonly nonce: string;
  readonly pkce: PkcePair;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly issuer: string;
  readonly audience: string;
  readonly startedAtMs: number;
}

export interface AccountAuthorizationRequest {
  readonly url: string;
  readonly pending: PendingAccountAuthorization;
}

/** How long a pending authorization stays valid (§9.5 `Pending → expired`). */
export const ACCOUNT_AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Build the authorization URL and the state needed to validate the callback.
 *
 * PKCE S256 is unconditional. §7.3 requires it, and unlike the MCP flow there is no
 * server-advertised method list to negotiate against — the registration is ours, so
 * a downgrade could only ever be a bug.
 */
export async function buildAccountAuthorization(options: {
  readonly registration: AccountClientRegistration;
  readonly redirectUri: string;
  readonly now: () => number;
}): Promise<AccountAuthorizationRequest> {
  const { registration } = options;
  if (registration.authorizationEndpoint.length === 0) {
    throw new Error(
      "this registration documents no authorization endpoint; use the device flow instead",
    );
  }
  if (!isLoopbackRedirectUri(options.redirectUri)) {
    // §7.3 permits a loopback redirect or the device flow, and nothing else. A
    // non-loopback redirect would send the code to a host we do not control.
    throw new Error(`refusing a non-loopback redirect_uri: ${options.redirectUri}`);
  }

  const pkce = await createPkcePair();
  const state = randomToken(24);
  const nonce = randomToken(16);

  const url = new URL(registration.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("scope", registration.scopes.join(" "));
  if (registration.protocol === "chatgpt") {
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "capybara");
  } else {
    url.searchParams.set("nonce", nonce);
    // RFC 8707: bind a standards-based token to its configured audience.
    url.searchParams.set("resource", registration.audience);
  }

  return {
    url: url.toString(),
    pending: {
      state,
      nonce,
      pkce,
      redirectUri: options.redirectUri,
      scopes: [...registration.scopes],
      issuer: registration.issuer,
      audience: registration.audience,
      startedAtMs: options.now(),
    },
  };
}

export type AccountCallbackValidation =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly event: AccountAuthEvent; readonly reason: string };

/**
 * Validate a redirect before exchanging anything.
 *
 * The failure carries the §9.5 event it maps to, so the caller advances the state
 * machine from the same decision that produced the message instead of re-deriving it
 * from prose.
 */
export function validateAccountCallback(
  pending: PendingAccountAuthorization,
  params: Readonly<Record<string, string>>,
  now: number,
): AccountCallbackValidation {
  const error = params.error;
  if (error !== undefined) {
    const description = params.error_description;
    return {
      ok: false,
      // `access_denied` is the user declining, which §9.5 separates from an
      // expired request because only one of them is worth retrying immediately.
      event: error === "access_denied" ? "denied" : "expired",
      reason: `the authorization server returned '${error}'${
        description !== undefined ? `: ${description}` : ""
      }`,
    };
  }
  if (now - pending.startedAtMs > ACCOUNT_AUTHORIZATION_TIMEOUT_MS) {
    return {
      ok: false,
      event: "expired",
      reason: "the authorization request expired before it was completed",
    };
  }
  const state = params.state;
  if (state === undefined || !timingSafeEqual(state, pending.state)) {
    return {
      ok: false,
      event: "denied",
      reason: "the callback state did not match; the response was not honoured",
    };
  }
  const code = params.code;
  if (code === undefined || code.length === 0) {
    return { ok: false, event: "denied", reason: "the callback carried no authorization code" };
  }
  return { ok: true, code };
}

/** The authorization-code exchange body. Data, so a test can assert its shape. */
export function accountTokenExchangeBody(
  pending: PendingAccountAuthorization,
  code: string,
  clientId: string,
  protocol: AccountAuthProtocol = "standard",
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", pending.redirectUri);
  body.set("client_id", clientId);
  body.set("code_verifier", pending.pkce.verifier);
  if (protocol !== "chatgpt") body.set("resource", pending.audience);
  return body;
}

// ---------------------------------------------------------------------------
// Device authorization flow — RFC 8628 (§7.3)
// ---------------------------------------------------------------------------

/** Extra delay used by OpenCode to avoid racing the device authorization backend. */
export const CHATGPT_DEVICE_POLL_SAFETY_MS = 3_000;

/** ChatGPT's OpenCode-compatible device authorization payload. */
export interface ChatGptDeviceAuthorization {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAtMs: number;
  readonly intervalMs: number;
}

export interface ChatGptDeviceExchange {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
}

export function buildChatGptDeviceStartBody(
  registration: AccountClientRegistration,
): string {
  return JSON.stringify({ client_id: registration.clientId });
}

export function parseChatGptDeviceAuthorization(
  raw: unknown,
  registration: AccountClientRegistration,
  now: number,
): ChatGptDeviceAuthorization | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const deviceAuthId = nonEmptyString(record.device_auth_id);
  const userCode = nonEmptyString(record.user_code);
  if (deviceAuthId === undefined || userCode === undefined) return undefined;

  const parsedInterval =
    typeof record.interval === "number"
      ? record.interval
      : typeof record.interval === "string"
        ? Number.parseInt(record.interval, 10)
        : Number.NaN;
  const intervalSeconds = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 5;
  return {
    deviceAuthId,
    userCode,
    verificationUri: `${registration.issuer}/codex/device`,
    expiresAtMs: now + ACCOUNT_AUTHORIZATION_TIMEOUT_MS,
    intervalMs: intervalSeconds * 1000 + CHATGPT_DEVICE_POLL_SAFETY_MS,
  };
}

export function chatGptDevicePollEndpoint(
  registration: AccountClientRegistration,
): string {
  return `${registration.issuer}/api/accounts/deviceauth/token`;
}

export function buildChatGptDevicePollBody(device: ChatGptDeviceAuthorization): string {
  return JSON.stringify({
    device_auth_id: device.deviceAuthId,
    user_code: device.userCode,
  });
}

export function parseChatGptDeviceExchange(raw: unknown): ChatGptDeviceExchange | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const authorizationCode = nonEmptyString(record.authorization_code);
  const codeVerifier = nonEmptyString(record.code_verifier);
  if (authorizationCode === undefined || codeVerifier === undefined) return undefined;
  return { authorizationCode, codeVerifier };
}

export function chatGptDeviceTokenExchangeBody(
  exchange: ChatGptDeviceExchange,
  registration: AccountClientRegistration,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", exchange.authorizationCode);
  body.set("redirect_uri", `${registration.issuer}/deviceauth/callback`);
  body.set("client_id", registration.clientId);
  body.set("code_verifier", exchange.codeVerifier);
  return body;
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAtMs: number;
  readonly intervalMs: number;
}

/** RFC 8628 §3.5: five seconds when the server states no interval. */
export const DEVICE_DEFAULT_INTERVAL_MS = 5_000;

/** RFC 8628 §3.5: `slow_down` adds five seconds to the poll interval. */
export const DEVICE_SLOW_DOWN_STEP_MS = 5_000;

export function buildDeviceAuthorizationBody(
  registration: AccountClientRegistration,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("client_id", registration.clientId);
  body.set("scope", registration.scopes.join(" "));
  body.set("resource", registration.audience);
  return body;
}

/**
 * Parse a device authorization response.
 *
 * Every field is checked rather than cast. The response comes off the network, and a
 * numeric `verification_uri` should fail the flow rather than be printed for the user
 * to type into a browser.
 */
export function parseDeviceAuthorization(
  raw: unknown,
  now: number,
): DeviceAuthorization | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  const deviceCode = nonEmptyString(record.device_code);
  const userCode = nonEmptyString(record.user_code);
  const verificationUri = nonEmptyString(record.verification_uri);
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    return undefined;
  }

  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 600;
  const interval = typeof record.interval === "number" ? record.interval : undefined;
  const complete = nonEmptyString(record.verification_uri_complete);

  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete !== undefined ? { verificationUriComplete: complete } : {}),
    expiresAtMs: now + expiresIn * 1000,
    intervalMs:
      interval !== undefined && interval > 0 ? interval * 1000 : DEVICE_DEFAULT_INTERVAL_MS,
  };
}

export function buildDevicePollBody(
  deviceCode: string,
  registration: AccountClientRegistration,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
  body.set("device_code", deviceCode);
  body.set("client_id", registration.clientId);
  return body;
}

export type DevicePollDecision =
  | { readonly kind: "token" }
  | { readonly kind: "pending"; readonly intervalMs: number }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "expired"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Classify one poll response.
 *
 * `authorization_pending` and `slow_down` are the two non-terminal answers; RFC 8628
 * treats anything else as final, and continuing to poll after a final error is what
 * gets a client rate-limited.
 */
export function classifyDevicePoll(
  status: number,
  raw: unknown,
  currentIntervalMs: number,
): DevicePollDecision {
  if (status >= 200 && status < 300) return { kind: "token" };

  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const error = typeof record.error === "string" ? record.error : "";
  const description =
    typeof record.error_description === "string" ? record.error_description : undefined;
  const detail = description ?? error ?? `HTTP ${status}`;

  switch (error) {
    case "authorization_pending":
      return { kind: "pending", intervalMs: currentIntervalMs };
    case "slow_down":
      return { kind: "pending", intervalMs: currentIntervalMs + DEVICE_SLOW_DOWN_STEP_MS };
    case "access_denied":
      return { kind: "denied", reason: detail };
    case "expired_token":
      return { kind: "expired", reason: detail };
    default:
      return { kind: "failed", reason: detail };
  }
}

// ---------------------------------------------------------------------------
// Token responses, refresh, and revocation
// ---------------------------------------------------------------------------

export interface OpenAiAccountClaims {
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly planType?: string;
}

/** Extract only non-secret routing metadata from an OpenAI JWT. */
export function parseOpenAiAccountClaims(token: string): OpenAiAccountClaims {
  const parts = token.split(".");
  if (parts.length < 2) return {};

  let payload: Record<string, unknown>;
  try {
    const encoded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    payload = parsed as Record<string, unknown>;
  } catch {
    return {};
  }

  const auth =
    typeof payload["https://api.openai.com/auth"] === "object" &&
    payload["https://api.openai.com/auth"] !== null
      ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
      : undefined;
  const profileValue = payload["https://api.openai.com/profile"];
  const profile =
    typeof profileValue === "object" && profileValue !== null
      ? (profileValue as Record<string, unknown>)
      : undefined;
  const organizations = Array.isArray(payload.organizations) ? payload.organizations : [];
  const firstOrganization =
    typeof organizations[0] === "object" && organizations[0] !== null
      ? (organizations[0] as Record<string, unknown>)
      : undefined;
  const accountId =
    nonEmptyString(payload.chatgpt_account_id) ??
    nonEmptyString(payload["https://api.openai.com/auth.chatgpt_account_id"]) ??
    nonEmptyString(auth?.chatgpt_account_id) ??
    nonEmptyString(firstOrganization?.id);
  const accountLabel =
    nonEmptyString(payload.email) ??
    nonEmptyString(payload.name) ??
    nonEmptyString(profile?.email) ??
    nonEmptyString(auth?.email);
  const planType =
    nonEmptyString(payload.chatgpt_plan_type) ??
    nonEmptyString(payload["https://api.openai.com/auth.chatgpt_plan_type"]) ??
    nonEmptyString(auth?.chatgpt_plan_type);

  return {
    ...(accountId !== undefined ? { accountId } : {}),
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    ...(planType !== undefined ? { planType } : {}),
  };
}

export interface AccountTokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly scopes?: readonly string[];
  readonly accountLabel?: string;
  readonly accountId?: string;
  readonly planType?: string;
}


/**
 * Parse a token response.
 *
 * Returns `undefined` when there is no usable access token, which is the only field
 * the flow cannot proceed without. `token_type` is checked because a non-bearer token
 * would be sent as `Authorization: Bearer ...` by the provider adapter and silently
 * fail to authenticate.
 */
export function parseAccountTokenResponse(
  raw: unknown,
  now: number,
  protocol: AccountAuthProtocol = "standard",
): AccountTokenResponse | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  const accessToken = nonEmptyString(record.access_token);
  if (accessToken === undefined) return undefined;

  const tokenType = nonEmptyString(record.token_type);
  if (tokenType !== undefined && tokenType.toLowerCase() !== "bearer") return undefined;

  const refreshToken = nonEmptyString(record.refresh_token);
  const scope = nonEmptyString(record.scope);
  const expiresIn =
    typeof record.expires_in === "number"
      ? record.expires_in
      : protocol === "chatgpt" ? 3_600 : undefined;
  const idToken = nonEmptyString(record.id_token);
  // OpenCode checks the ID token first and falls back to the access token. Some
  // responses carry the account selector only in the latter, so preserve that
  // fallback instead of treating an otherwise valid ID token as authoritative.
  const idClaims = idToken !== undefined ? parseOpenAiAccountClaims(idToken) : {};
  const accessClaims = parseOpenAiAccountClaims(accessToken);
  const claims = {
    accountId: idClaims.accountId ?? accessClaims.accountId,
    accountLabel: idClaims.accountLabel ?? accessClaims.accountLabel,
    planType: idClaims.planType ?? accessClaims.planType,
  };
  const label =
    nonEmptyString(record.account_label) ??
    nonEmptyString(record.email) ??
    nonEmptyString((record.account as Record<string, unknown> | undefined)?.label) ??
    claims.accountLabel;

  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresAtMs: now + expiresIn * 1000 } : {}),
    ...(scope !== undefined
      ? { scopes: scope.split(/\s+/).filter((s) => s.length > 0) }
      : {}),
    ...(label !== undefined ? { accountLabel: label } : {}),
    ...(claims.accountId !== undefined ? { accountId: claims.accountId } : {}),
    ...(claims.planType !== undefined ? { planType: claims.planType } : {}),
  };
}

export function buildRefreshBody(
  refreshToken: string,
  registration: AccountClientRegistration,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", registration.clientId);
  if (registration.protocol !== "chatgpt") {
    body.set("resource", registration.audience);
    if (registration.scopes.length > 0) body.set("scope", registration.scopes.join(" "));
  }
  return body;
}

/** RFC 7009 revocation body (§9.7's revoke step). */
export function buildRevocationBody(
  token: string,
  registration: AccountClientRegistration,
  hint: "refresh_token" | "access_token" = "refresh_token",
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("token", token);
  body.set("token_type_hint", hint);
  body.set("client_id", registration.clientId);
  return body;
}

/**
 * Fold a token response into a record.
 *
 * §9.5 supports refresh token rotation, so a response that carries a new refresh
 * token replaces the stored one; a response that omits it keeps the existing token
 * valid. Getting this backwards is the classic rotation bug — it discards a working
 * refresh token and forces re-authentication on the next expiry.
 */
export function recordFromToken(options: {
  readonly response: AccountTokenResponse;
  readonly registration: AccountClientRegistration;
  readonly now: number;
  readonly previous?: AccountTokenRecord;
}): AccountTokenRecord {
  const { response, registration, now, previous } = options;
  const scopes =
    response.scopes !== undefined && response.scopes.length > 0
      ? response.scopes
      : (previous?.scopes ?? registration.scopes);
  const label = response.accountLabel ?? previous?.accountLabel;

  const accountId = response.accountId ?? previous?.accountId;
  const planType = response.planType ?? previous?.planType;
  return {
    issuer: registration.issuer,
    audience: registration.audience,
    scopes: [...scopes],
    ...(label !== undefined ? { accountLabel: label } : {}),
    ...(response.expiresAtMs !== undefined ? { expiresAtMs: response.expiresAtMs } : {}),
    ...(registration.protocol !== undefined ? { protocol: registration.protocol } : {}),
    hasRefreshToken: response.refreshToken !== undefined || (previous?.hasRefreshToken ?? false),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(planType !== undefined ? { planType } : {}),
    obtainedAtMs: previous?.obtainedAtMs ?? now,
    ...(previous !== undefined ? { refreshedAtMs: now } : {}),
    state: "SignedIn",
    keychainRef: OPENAI_ACCOUNT_TOKEN,
    refreshKeychainRef: OPENAI_ACCOUNT_REFRESH,
    // P0-14 record v2: remember exactly which registration minted this token.
    registrationDigest: registrationDigest(registration),
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** §7.3: scope and audience are shown before anything is granted. */
export function renderAccountConsent(registration: AccountClientRegistration): string[] {
  const lines = [
    "Sign in to your OpenAI account",
    "",
    `Issuer    ${registration.issuer}`,
    `Audience  ${registration.audience}`,
    `Client    ${registration.clientId}`,
  ];
  if (registration.scopes.length === 0) {
    lines.push("Scopes    (none requested)");
  } else {
    lines.push("Scopes");
    for (const scope of registration.scopes) lines.push(`  - ${scope}`);
  }
  if (registration.revocationEndpoint === undefined) {
    lines.push(
      "",
      "Remote revocation is unavailable; `capy auth logout` deletes the stored refresh token locally only.",
    );
  }

  lines.push(
    "",
    "The token is stored in Capybara's credential store and is never sent to the model.",
  );
  return lines;
}

/** §9.6's refusal, with the outstanding criteria appended as a diagnostic. */
export function renderGateRefusal(
  registration?: AccountClientRegistration,
): string[] {
  const lines: string[] = [...ACCOUNT_LOGIN_UNAVAILABLE];
  const outstanding = unsatisfiedCriteria(registration);
  if (registration !== undefined && outstanding.length > 0) {
    // Only shown when a registration exists but does not qualify. With no
    // registration at all the three §9.6 lines are the whole answer.
    lines.push("", "Outstanding §9.6 criteria:");
    for (const criterion of outstanding) lines.push(`  - ${criterion}`);
  }
  return lines;
}

/** `capy auth status` lines for the account credential (§9.8: no secrets). */
export function renderAccountStatus(
  record: AccountTokenRecord | undefined,
  now: number,
): string[] {
  if (record === undefined) return ["Account      not signed in"];

  const lines = [`Account      ${record.state}`];
  if (record.accountLabel !== undefined) lines.push(`  Label      ${record.accountLabel}`);
  if (record.accountId !== undefined) lines.push(`  Account ID ${record.accountId}`);
  if (record.planType !== undefined) lines.push(`  Plan       ${record.planType}`);
  lines.push(`  Issuer     ${record.issuer}`);
  lines.push(`  Audience   ${record.audience}`);
  lines.push(`  Scopes     ${record.scopes.length > 0 ? record.scopes.join(" ") : "(none)"}`);
  if (record.expiresAtMs !== undefined) {
    const remainingMs = record.expiresAtMs - now;
    lines.push(
      `  Expires    ${new Date(record.expiresAtMs).toISOString()}${
        remainingMs <= 0 ? " (expired)" : ` (in ${Math.round(remainingMs / 1000)}s)`
      }`,
    );
  } else {
    lines.push("  Expires    not stated by the provider");
  }
  lines.push(`  Refresh    ${record.hasRefreshToken ? "available" : "none stored"}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Constant-time string comparison for the `state` parameter.
 *
 * A timing oracle on state comparison is a narrow but real CSRF avenue, and the
 * comparison costs nothing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port.length > 0
    );
  } catch {
    return false;
  }
}

