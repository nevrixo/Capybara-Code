/**
 * `capy auth` — PRD §7.2, §7.3, §8.4, §9.1–§9.8, AC-02, AC-03.
 */

import { OpenAiResponsesProvider, type CredentialValidation } from "@cbc/provider-openai";

import {
  ACCOUNT_AUTHORIZATION_TIMEOUT_MS,
  accountLease,
  activeRegistration,
  buildAccountAuthorization,
  buildChatGptDevicePollBody,
  buildChatGptDeviceStartBody,
  chatGptDevicePollEndpoint,
  chatGptDeviceTokenExchangeBody,
  parseChatGptDeviceExchange,
  buildDeviceAuthorizationBody,
  buildDevicePollBody,
  buildRevocationBody,
  classifyDevicePoll,
  accountTokenExchangeBody,
  initialAccountAuthState,
  nextAccountAuthState,
  parseAccountTokenResponse,
  parseDeviceAuthorization,
  recordFromToken,
  registrationMatchesRecord,
  parseChatGptDeviceAuthorization,
  renderAccountConsent,
  renderAccountStatus,
  unsatisfiedCriteria,
  validateAccountCallback,
  type AccountAuthEvent,
  type AccountAuthState,
  type AccountClientRegistration,
  type AccountTokenRecord,
  type PendingAccountAuthorization,
} from "../account-login.ts";
import { clearAuthMode, readAuthMode, writeAuthMode } from "../auth-mode.ts";
import { authError, CliError, EXIT } from "../exit.ts";
import {
  OPENAI_ACCOUNT,
  OPENAI_ACCOUNT_REFRESH,
  OPENAI_ACCOUNT_TOKEN,
  accountRegistrationPath,
  deleteAccountRecord,
  fingerprint,
  loadAccountRegistration,
  looksLikeApiKey,
  readAccountRecord,
  resolveAccountSession,
  resolveCredential,
  replaceAccountTokenSet,

} from "../credentials.ts";
import { startLoopback } from "../loopback.ts";
import { safeOAuthFetch } from "../oauth-fetch.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export interface AuthLoginArgs {
  readonly device: boolean;
}

/** §7.3 / §9.5 / §9.6 — runs against the resolved registration (built-in or configured). */
export async function authLogin(
  context: CommandContext,
  args: AuthLoginArgs,
): Promise<CommandResult> {
  if (context.nonInteractive && !args.device) {
    throw authError("capy auth login needs an interactive terminal", [
      "Use `capy auth login --device` on a terminal without a local browser.",
      "For automation, use `capy auth api` with an OpenAI API key.",
    ]);
  }

  const registration = await selectRegistration(context);
  if (registration !== undefined) {
    return await accountLogin(context, args, registration);
  }

  throw authError("Account sign-in is unavailable in this build", [
    "Capybara ships no built-in OAuth registration and reuses no other product's",
    "credentials or undocumented endpoints.",
    "Use `capy auth api` with an OpenAI API key, or supply a qualified",
    "registration through account-registration.json.",
  ]);
}

/**
 * The registration to sign in against, or `undefined` when account login is unavailable.
 *
 * A malformed or unqualified document is an error rather than a shrug. The operator
 * wrote it on purpose, so ignoring it would leave them debugging a login that never
 * consults their configuration — and both failures are recoverable by deleting one
 * file, which the message says.
 */
async function selectRegistration(
  context: CommandContext,
): Promise<AccountClientRegistration | undefined> {
  const path = accountRegistrationPath(context.paths, context.host.env);
  const loaded = await loadAccountRegistration(context.host, context.paths, context.host.env);

  if (loaded.issues.length > 0) {
    throw new CliError(EXIT.config, "the account registration document could not be read", [
      path,
      ...loaded.issues.map((issue) => `  ${issue}`),
      "",
      "Fix the document, or delete it and use `capy auth api`.",
    ]);
  }

  if (loaded.registration !== undefined) {
    const qualified = activeRegistration(loaded.registration);
    if (qualified === undefined) {
      throw authError("the configured account registration does not satisfy §9.6", [
        path,
        "",
        "Outstanding criteria:",
        ...unsatisfiedCriteria(loaded.registration).map((criterion) => `  - ${criterion}`),
        "",
        "Fix or delete the document, then use `capy auth api`.",
      ]);
    }
    return qualified;
  }

  // No configured document means account login is unavailable in this build.
  return undefined;
}

/**
 * Sign in against a registration and put the session in account mode.
 *
 * §7.3: scope and audience are shown before consent is requested, so the user sees
 * what the token will be able to do before a browser is opened.
 */
async function accountLogin(
  context: CommandContext,
  args: AuthLoginArgs,
  registration: AccountClientRegistration,
): Promise<CommandResult> {
  context.outLines(renderAccountConsent(registration));

  const machine = new AuthMachine(initialAccountAuthState(registration));
  const token = args.device
    ? await runDeviceFlow(context, registration, machine)
    : await runLoopbackFlow(context, registration, machine);
  // A cancel is not a failure: the flow already said so and stored nothing.
  if (token === undefined) return ok();

  machine.apply("success");
  const record = await persistAccountToken(context, registration, token);
  // Written last, so an interrupted login leaves the previous mode in place rather
  // than selecting a surface whose token was never stored.
  await writeAuthMode(context.host, context.paths, "account");

  context.out("");
  context.out("✓ Signed in with ChatGPT");
  if (record.accountLabel !== undefined) context.out(`  Account   ${record.accountLabel}`);
  context.out(`  Inference ${registration.inferenceBaseUrl}`);
  context.out("  New Capybara sessions run Capybara's own agent loop on this token.");
  context.out("  Run `capy auth api` to switch to API billing.");
  return ok();
}

// ---------------------------------------------------------------------------
// §9.5 state tracking
// ---------------------------------------------------------------------------
class AuthMachine {
  #state: AccountAuthState;

  constructor(initial: AccountAuthState) {
    this.#state = initial;
  }

  get state(): AccountAuthState {
    return this.#state;
  }

  apply(event: AccountAuthEvent): AccountAuthState {
    const next = nextAccountAuthState(this.#state, event);
    if (next === undefined) {
      throw new CliError(
        EXIT.internal,
        `§9.5 defines no '${event}' transition from '${this.#state}'`,
      );
    }
    this.#state = next;
    return next;
  }
}

interface AcquiredToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly scopes?: readonly string[];
  readonly accountLabel?: string;
  readonly accountId?: string;
  readonly planType?: string;
}

// ---------------------------------------------------------------------------
// Authorization code flow over a loopback redirect (§7.3)
// ---------------------------------------------------------------------------

async function runLoopbackFlow(
  context: CommandContext,
  registration: AccountClientRegistration,
  machine: AuthMachine,
): Promise<AcquiredToken | undefined> {
  const loopback = startLoopback({
    ...(registration.protocol === "chatgpt"
      ? { path: "/auth/callback", port: 1455, redirectHost: "localhost" as const }
      : {}),
    message: "Capybara Code received the authorization response. You can close this tab.",
  });

  // P0-14: the advertised Ctrl+C actually cancels — SIGINT aborts the wait, the
  // pending state is discarded, and the flow reports a clean cancellation instead
  // of dying mid-redirect.
  const cancel = cancelOnSigint();
  try {
    const request = await buildAccountAuthorization({
      registration,
      redirectUri: loopback.redirectUri,
      now: () => context.host.now(),
    });
    machine.apply("start");

    context.out("");
    context.out("Open this URL to sign in:");
    context.out(`  ${request.url}`);
    context.out("");
    // The URL is printed rather than launched: opening a browser would mean
    // spawning a process, and §19.5 keeps OS access on the runtime's side of the
    // boundary. Printing it also works over SSH, where launching would not.
    context.warn("Waiting for OpenAI authorization... [Ctrl+C to cancel]");

    const outcome = await loopback.wait({
      timeoutMs: ACCOUNT_AUTHORIZATION_TIMEOUT_MS,
      signal: cancel.signal,
    });
    if (outcome.kind === "timeout") {
      machine.apply("expired");
      throw authError("the authorization request expired before it was completed", [
        "No token was stored. Run `capy auth login` again to retry.",
      ]);
    }
    if (outcome.kind === "cancelled") {
      machine.apply("cancel");
      context.out("Cancelled. No token was stored.");
      return undefined;
    }

    const validation = validateOrThrow(request.pending, outcome.params, context, machine);
    return await exchangeAuthorizationCode(context, registration, request.pending, validation);
  } finally {
    cancel.dispose();
    // §7.3: the pending state is discarded on every exit path. It only ever existed
    // in this function's locals, so returning is what deletes it — there is no
    // partial authorization written to disk to clean up.
    loopback.close();
  }
}

/**
 * P0-14: Ctrl+C aborts a running authorization flow instead of killing the
 * process mid-flight. The listener is removed when the flow ends, so the rest of
 * the command keeps the default SIGINT behaviour.
 */
function cancelOnSigint(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  return { signal: controller.signal, dispose: () => process.off("SIGINT", onSigint) };
}

/**
 * Validate the redirect, or fail with the §9.5 event the failure maps to.
 *
 * The state transition happens here rather than at the call site so the message and
 * the state can never disagree about what went wrong.
 */
function validateOrThrow(
  pending: PendingAccountAuthorization,
  params: Readonly<Record<string, string>>,
  context: CommandContext,
  machine: AuthMachine,
): string {
  const result = validateAccountCallback(pending, params, context.host.now());
  if (!result.ok) {
    machine.apply(result.event);
    throw authError(`authorization failed: ${result.reason}`, ["No token was stored."]);
  }
  return result.code;
}

async function exchangeAuthorizationCode(
  context: CommandContext,
  registration: AccountClientRegistration,
  pending: PendingAccountAuthorization,
  code: string,
): Promise<AcquiredToken> {
  const response = await safeOAuthFetch(registration.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: accountTokenExchangeBody(pending, code, registration.clientId, registration.protocol).toString(),
  }).catch((error: unknown) => {
    throw authError(
      `could not reach the token endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  if (!response.ok) {
    throw authError(`the token endpoint returned ${response.status}`);
  }

  const parsed = parseAccountTokenResponse(
    await response.json().catch(() => undefined),
    context.host.now(),
    registration.protocol,
  );
  if (parsed === undefined) {
    throw authError("the token response carried no usable bearer token");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Device authorization flow — RFC 8628 (§7.3)
// ---------------------------------------------------------------------------

async function runChatGptDeviceFlow(
  context: CommandContext,
  registration: AccountClientRegistration,
  machine: AuthMachine,
): Promise<AcquiredToken | undefined> {
  const deviceEndpoint = registration.deviceAuthorizationEndpoint;
  if (deviceEndpoint === undefined) {
    throw authError("this ChatGPT registration has no device authorization endpoint");
  }

  const startResponse = await safeOAuthFetch(deviceEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "User-Agent": "capybara-code/0.1.0",
    },
    body: buildChatGptDeviceStartBody(registration),
  }).catch((error: unknown) => {
    throw authError(
      `could not reach the ChatGPT device endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (!startResponse.ok) {
    throw authError(`the ChatGPT device endpoint returned ${startResponse.status}`);
  }

  const device = parseChatGptDeviceAuthorization(
    await startResponse.json().catch(() => undefined),
    registration,
    context.host.now(),
  );
  if (device === undefined) {
    throw authError("the ChatGPT device authorization response was malformed");
  }
  machine.apply("start");

  context.out("");
  context.out(`Visit  ${device.verificationUri}`);
  context.out(`Code   ${device.userCode}`);
  context.out("");
  context.warn("Waiting for ChatGPT authorization... [Ctrl+C to cancel]");

  const cancel = cancelOnSigint();
  try {
    for (;;) {
      if (cancel.signal.aborted) {
        machine.apply("cancel");
        context.out("Cancelled. No token was stored.");
        return undefined;
      }
      if (context.host.now() >= device.expiresAtMs) {
        machine.apply("expired");
        throw authError("the ChatGPT device code expired before it was authorized", [
          "No token was stored. Run `capy auth login --device` again to retry.",
        ]);
      }

      if (await sleep(device.intervalMs, cancel.signal)) continue;
      const pollResponse = await safeOAuthFetch(chatGptDevicePollEndpoint(registration), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "User-Agent": "capybara-code/0.1.0",
        },
        body: buildChatGptDevicePollBody(device),
      }).catch(() => undefined);
      if (pollResponse === undefined) continue;
      if (!pollResponse.ok) {
        if (pollResponse.status === 403 || pollResponse.status === 404) continue;
        machine.apply("denied");
        throw authError(
          `the ChatGPT device authorization failed with HTTP ${pollResponse.status}`,
        );
      }

      const exchange = parseChatGptDeviceExchange(
        await pollResponse.json().catch(() => undefined),
      );
      if (exchange === undefined) continue;

      const tokenResponse = await safeOAuthFetch(registration.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: chatGptDeviceTokenExchangeBody(exchange, registration).toString(),
      }).catch((error: unknown) => {
        throw authError(
          `could not reach the token endpoint: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      if (!tokenResponse.ok) {
        throw authError(`the token endpoint returned ${tokenResponse.status}`);
      }
      const parsed = parseAccountTokenResponse(
        await tokenResponse.json().catch(() => undefined),
        context.host.now(),
        registration.protocol,
      );
      if (parsed === undefined) {
        throw authError("the token response carried no usable bearer token");
      }
      return parsed;
    }
  } finally {
    cancel.dispose();
  }
}

async function runDeviceFlow(
  context: CommandContext,
  registration: AccountClientRegistration,
  machine: AuthMachine,
): Promise<AcquiredToken | undefined> {
  if (registration.protocol === "chatgpt") {
    return await runChatGptDeviceFlow(context, registration, machine);
  }

  const deviceEndpoint = registration.deviceAuthorizationEndpoint;
  if (deviceEndpoint === undefined) {

    throw authError("this build's registration documents no device authorization endpoint");
  }

  const startResponse = await safeOAuthFetch(deviceEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: buildDeviceAuthorizationBody(registration).toString(),
  }).catch((error: unknown) => {
    throw authError(
      `could not reach the device authorization endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  if (!startResponse.ok) {
    throw authError(`the device authorization endpoint returned ${startResponse.status}`);
  }

  const device = parseDeviceAuthorization(
    await startResponse.json().catch(() => undefined),
    context.host.now(),
  );
  if (device === undefined) {
    throw authError("the device authorization response was malformed");
  }
  machine.apply("start");

  context.out("");
  context.out(`Visit  ${device.verificationUri}`);
  context.out(`Code   ${device.userCode}`);
  if (device.verificationUriComplete !== undefined) {
    context.out("");
    context.out("Or open this URL, which carries the code:");
    context.out(`  ${device.verificationUriComplete}`);
  }
  context.out("");
  context.warn("Waiting for authorization... [Ctrl+C to cancel]");

  const cancel = cancelOnSigint();
  try {
    let intervalMs = device.intervalMs;
    for (;;) {
      if (cancel.signal.aborted) {
        machine.apply("cancel");
        context.out("Cancelled. No token was stored.");
        return undefined;
      }
      if (context.host.now() >= device.expiresAtMs) {
        machine.apply("expired");
        throw authError("the device code expired before it was authorized", [
          "No token was stored. Run `capy auth login --device` again to retry.",
        ]);
      }

      if (await sleep(intervalMs, cancel.signal)) {
        // The sleep ended in a cancellation; the next loop iteration reports it.
        continue;
      }

      const pollResponse = await safeOAuthFetch(registration.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: buildDevicePollBody(device.deviceCode, registration).toString(),
      }).catch(() => undefined);

      if (pollResponse === undefined) {
        // A single transport failure mid-poll is not a decision from the server, so
        // the loop keeps its schedule rather than treating it as a denial.
        continue;
      }

      const body: unknown = await pollResponse.json().catch(() => undefined);
      const decision = classifyDevicePoll(pollResponse.status, body, intervalMs);

      switch (decision.kind) {
        case "pending":
          intervalMs = decision.intervalMs;
          continue;
        case "denied":
          machine.apply("denied");
          throw authError(`authorization was denied: ${decision.reason}`);
        case "expired":
          machine.apply("expired");
          throw authError(`the device code expired: ${decision.reason}`);
        case "failed":
          machine.apply("denied");
          throw authError(`the device authorization failed: ${decision.reason}`);
        case "token": {
          const parsed = parseAccountTokenResponse(body, context.host.now());
          if (parsed === undefined) {
            throw authError("the token response carried no usable bearer token");
          }
          return parsed;
        }
      }
    }
  } finally {
    cancel.dispose();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Persistence (§9.1, §9.5)
// ---------------------------------------------------------------------------

/**
 * Store the tokens and the metadata record.
 *
 * The secrets go to the keychain through the runtime and the record holds neither of
 * them (§9.1, §9.8). `success` is applied only after both writes land, so a crash
 * between them leaves the record absent rather than claiming a signed-in state whose
 * token was never stored.
 */
async function persistAccountToken(
  context: CommandContext,
  registration: AccountClientRegistration,
  token: AcquiredToken,
): Promise<AccountTokenRecord> {
  const runtime = await context.runtime();
  const now = context.host.now();

  const persisted = await replaceAccountTokenSet({
    runtime,
    host: context.host,
    paths: context.paths,
    registration,
    response: token,
    now,
  });
  const { stored, record } = persisted;

  if (!stored.persistent) {
    // §9.3: a session-only backend is a different promise than a keychain, and a
    // token that disappears on exit should not be a surprise.
    context.out("");
    context.out(
      `  Stored in ${stored.backend}; this backend is not persistent, so the session ends with this process.`,
    );
  }
  // Referencing the lease keeps the fingerprint helper honest about the value that
  // was actually stored, without printing the token.
  const lease = accountLease(token.accessToken, record, now, fingerprint);
  context.out(`  Fingerprint ${lease.fingerprint}`);
  return record;
}

// ---------------------------------------------------------------------------
// §7.2 API key
// ---------------------------------------------------------------------------

export interface AuthApiArgs {
  readonly fromStdin: boolean;
}

/**
 * §7.2's flow: read, shape-check, validate, store, record metadata.
 *
 * The key never touches the filesystem or a log. It is read from a masked prompt or
 * stdin, handed to the runtime for keychain storage, and used once for validation
 * (§9.3).
 */
export async function authApi(
  context: CommandContext,
  args: AuthApiArgs,
): Promise<CommandResult> {
  let key: string;

  if (args.fromStdin) {
    // §8.4: strip the trailing newline only, so a key is not silently altered.
    const raw = await context.host.io.readStdin();
    key = raw.replace(/\r?\n$/, "");
  } else if (context.nonInteractive) {
    throw authError("capy auth api needs a terminal for the masked prompt", [
      "Pipe the key instead: `printf '%s' \"$KEY\" | capy auth api --stdin`.",
    ]);
  } else {
    key = await context.host.io.prompt("OpenAI API key: ", { masked: true });
  }

  const shape = looksLikeApiKey(key);
  if (!shape.ok) {
    throw authError(`that does not look like an API key: ${shape.reason}`);
  }
  const secret = key.trim();

  context.warn("Validating credential...");

  const runtime = await context.runtime();
  const candidate = {
    leaseId: "validation",
    account: OPENAI_ACCOUNT,
    source: "cli",
    expiresAtMs: context.host.now() + 60_000,
    fingerprint: "pending",
    secret,
  } as const;
  const provider = new OpenAiResponsesProvider({ credential: candidate });
  const validation = await provider.validateCredential(candidate);

  // §9.4: a network failure is not an invalid key. Storing anyway would be wrong
  // too, so the user is told to retry rather than left with an unverified key.
  if (validation.status === "network_error") {
    throw authError("could not reach the OpenAI API to validate the key", [
      "The key was not stored. Check connectivity and try again.",
    ]);
  }
  if (validation.status === "invalid") {
    throw authError("the OpenAI API rejected that key");
  }

  const stored = await runtime.storeCredential(OPENAI_ACCOUNT, secret);
  await writeAuthMode(context.host, context.paths, "api");

  context.out(`\u2713 Authenticated with OpenAI API`);
  context.out(`\u2713 Stored in ${stored.backend}`);
  if (!stored.persistent) {
    // §9.3: an encrypted-file or session-only fallback is a different promise than
    // a real keychain, and the user should know which one they got.
    context.out("  This backend is not persistent; the key is available for this session only.");
  }
  if (validation.status === "restricted") {
    context.out("  The key is valid but restricted; some models may be unavailable.");
  }
  if (validation.accountLabel !== undefined) {
    context.out(`  Account: ${validation.accountLabel}`);
  }
  context.out(`  Fingerprint: ${stored.fingerprint}`);
  return ok();
}

// ---------------------------------------------------------------------------
// §8.4 status
// ---------------------------------------------------------------------------

/** §8.4 `capy auth status`. Reports presence and source, never a value (§9.8). */
export async function authStatus(context: CommandContext): Promise<CommandResult> {
  const lines: string[] = [];
  const mode = await readAuthMode(context.host, context.paths);
  const envKey = context.host.env.OPENAI_API_KEY;
  lines.push(`Active       ${mode ?? "automatic (API credential precedence)"}`);
  lines.push(
    `Environment  ${
      envKey !== undefined && envKey.length > 0 ? "OPENAI_API_KEY is set" : "not set"
    }`,
  );

  let resolved: Awaited<ReturnType<typeof resolveCredential>>;
  if (mode === "account") return await accountStatus(context, lines);

  let validation: CredentialValidation | undefined;
  try {
    const runtime = await context.runtime();
    resolved = await resolveCredential({
      runtime,
      env: context.host.env,
      host: context.host,
      paths: context.paths,
      now: () => context.host.now(),
    });
    if (resolved !== undefined) {
      const provider = new OpenAiResponsesProvider({ credential: resolved.lease });
      validation = await provider.validateCredential(resolved.lease);
    }
  } catch (error) {
    lines.push(`Keychain     unavailable (${error instanceof Error ? error.message : String(error)})`);
    resolved = undefined;
  }

  const record = await readAccountRecord(context.host, context.paths).catch(() => undefined);
  if (resolved === undefined) {
    lines.push("Credential   none");
    lines.push(...renderAccountStatus(record, context.host.now()));
    lines.push("");
    lines.push("Run `capy auth api` to store an API key.");
    lines.push("Or run `capy auth login` to use your ChatGPT account plan.");
    context.outLines(lines);
    return { code: EXIT.auth };
  }

  lines.push(`Credential   present via ${resolved.source}`);
  lines.push(`Fingerprint  ${resolved.lease.fingerprint}`);
  lines.push("Billing      OpenAI API usage");
  if (validation !== undefined) {
    lines.push(`Validation   ${validation.status} at ${validation.checkedAt}`);
    if (validation.organizationId !== undefined) {
      lines.push(`Organization ${validation.organizationId}`);
    }
    if (validation.availableModels !== undefined && validation.availableModels.length > 0) {
      lines.push(`Models       ${validation.availableModels.slice(0, 6).join(", ")}`);
    }
  }
  lines.push(...renderAccountStatus(record, context.host.now()));
  context.outLines(lines);
  return validation?.status === "valid" || validation === undefined ? ok() : { code: EXIT.auth };
}

/**
 * `capy auth status` for an account session (§9.5, §9.8).
 *
 * The registration path is reported because "signed in but pointed at the wrong
 * inference host" and "not signed in" look identical from a failed turn, and the
 * difference is in a file the user can open.
 */
async function accountStatus(context: CommandContext, lines: string[]): Promise<CommandResult> {
  const path = accountRegistrationPath(context.paths, context.host.env);
  const loaded = await loadAccountRegistration(context.host, context.paths, context.host.env);
  const reg = activeRegistration(loaded.registration);
  const isBuiltIn = loaded.registration !== undefined && loaded.issues.length === 0 && !(await context.host.fs.exists(path));
  lines.push(
    `Registration ${loaded.registration !== undefined ? (isBuiltIn ? "built-in ChatGPT OAuth" : path) : "none"}`,
  );
  for (const issue of loaded.issues) lines.push(`  ${issue}`);

  let session: Awaited<ReturnType<typeof resolveAccountSession>>;
  try {
    const runtime = await context.runtime();
    session = await resolveAccountSession({
      runtime,
      host: context.host,
      paths: context.paths,
      env: context.host.env,
      now: () => context.host.now(),
    });
  } catch (error) {
    lines.push(
      `Keychain     unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
    session = undefined;
  }

  // Read after resolution: a due refresh rewrites the record, and the pre-refresh
  // copy would report an expiry that is already stale.
  const record = await readAccountRecord(context.host, context.paths).catch(() => undefined);

  if (session === undefined) {
    lines.push("Credential   none");
    lines.push(...renderAccountStatus(record, context.host.now()));
    lines.push("");
    lines.push("Run `capy auth login` to sign in to your OpenAI account again.");
    context.outLines(lines);
    return { code: EXIT.auth };
  }

  lines.push(`Credential   present via ${session.source}`);
  lines.push(`Fingerprint  ${session.lease.fingerprint}`);
  lines.push(`Inference    ${session.baseUrl}`);
  lines.push("Billing      ChatGPT account plan usage");
  lines.push(...renderAccountStatus(record, context.host.now()));
  context.outLines(lines);
  return ok();
}

// ---------------------------------------------------------------------------
// 짠9.7 logout
// ---------------------------------------------------------------------------
export interface AuthLogoutArgs {
  readonly all: boolean;
}

/**
 * §9.7 `capy auth logout`.
 *
 * Session transcripts are explicitly kept — §9.7 says so, and §8.6 makes deleting
 * them a separate, deliberate command.
 *
 * `--all` also ends the account session, which means revoking the refresh token
 * before deleting it. Order matters: a deleted token cannot be revoked, so a failed
 * revocation is reported and the local deletion still proceeds. Leaving a token on
 * disk because the server was unreachable would be the worse outcome.
 */
export async function authLogout(
  context: CommandContext,
  args: AuthLogoutArgs,
): Promise<CommandResult> {
  const mode = await readAuthMode(context.host, context.paths);
  // An account session is revoked whenever it is the session being ended, not only
  // under `--all`: leaving a live refresh token on the authorization server after the
  // user asked to sign out would be the wrong default.
  if (args.all || mode === "account") await revokeAccountSession(context);

  const accounts = args.all
    ? [OPENAI_ACCOUNT, OPENAI_ACCOUNT_TOKEN, OPENAI_ACCOUNT_REFRESH]
    : mode === "account"
      ? [OPENAI_ACCOUNT_TOKEN, OPENAI_ACCOUNT_REFRESH]
      : [OPENAI_ACCOUNT];

  let removed = 0;
  if (accounts.length > 0) {
    const runtime = await context.runtime();
    for (const account of accounts) {
      try {
        const result = await runtime.deleteCredential(account);
        if (result.removed) {
          removed += 1;
          context.out(`✓ Removed ${account}`);
        }
      } catch {
        // The desired end state already holds when no credential is stored.
      }
    }
  }

  if (args.all || mode === "account") {
    await deleteAccountRecord(context.host, context.paths).catch(() => undefined);
  }
  if (args.all || mode !== undefined) {
    await clearAuthMode(context.host, context.paths).catch(() => undefined);
  }

  if (removed === 0) context.out("No stored credential to remove.");
  context.out("Session transcripts were kept.");

  if (context.host.env.OPENAI_API_KEY !== undefined && context.host.env.OPENAI_API_KEY.length > 0) {
    context.out("");
    context.out("OPENAI_API_KEY is still set in this environment and can be selected with `capy auth api`.");
  }
  return ok();
}
async function revokeAccountSession(context: CommandContext): Promise<void> {
  // The configured document first, then the build's own registration. Revocation has
  // to use the same registration the token was minted under, so it is resolved the
  // same way login resolved it rather than assuming the build constant.
  const loaded = await loadAccountRegistration(
    context.host,
    context.paths,
    context.host.env,
  ).catch(() => undefined);
  const registration = loaded?.registration;
  const record = await readAccountRecord(context.host, context.paths).catch(() => undefined);
  if (registration === undefined || record === undefined) return;

  // P0-14: never hand a refresh token to a registration that did not mint it.
  // If the configured registration changed since login, the token belongs to a
  // different issuer/audience; sending it to the new revocation endpoint would
  // leak it. The local record is still cleaned up by the caller. Records with a
  // v2 registration digest are compared by exact digest; older records fall back
  // to field-wise identity.
  if (!registrationMatchesRecord(registration, record)) {
    context.warn(
      "The stored session was minted under a different registration; it was deleted locally without calling the revocation endpoint.",
    );
    return;
  }

  const endpoint = registration.revocationEndpoint;
  if (!record.hasRefreshToken) return;
  if (endpoint === undefined) {
    context.warn(
      "This registration has no documented remote revocation endpoint; the refresh token will be deleted locally only.",
    );
    return;
  }

  let refreshToken: string;
  try {
    const runtime = await context.runtime();
    const lease = await runtime.leaseCredential(record.refreshKeychainRef, "account");
    refreshToken = lease.secret;
  } catch {
    return;
  }

  const response = await safeOAuthFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: buildRevocationBody(refreshToken, registration, "refresh_token").toString(),
  }).catch(() => undefined);

  if (response?.ok === true) {
    context.out("\u2713 Revoked the refresh token");
  } else {
    context.warn(
      "The refresh token could not be revoked; it is being deleted locally. Revoke it in your account settings if it may still be active.",
    );
  }
}
