/**
 * MCP authorization — PRD §17.9, §17.12 (T7), §9.5.
 *
 * §17.9's requirements: authorization-server metadata discovery, PKCE, state and
 * nonce validation, loopback or device flow, scope display, tokens in the OS
 * keychain, refresh rotation, per-server credential isolation, logout and revoke,
 * and no token exposure to the model.
 *
 * The last one is structural rather than a rule to remember: no function here
 * returns a token to a caller that could put it in a prompt. The transport asks for
 * an `Authorization` header value at request time and never keeps it.
 *
 * §17.12's confused-deputy threat (T7) is why audience is tracked per resource: a
 * token minted for one MCP server must never be presented to another.
 */

/** RFC 8414 / RFC 9728 discovery documents, reduced to what CBC uses. */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly scopesSupported?: readonly string[];
  readonly codeChallengeMethodsSupported?: readonly string[];
  readonly grantTypesSupported?: readonly string[];
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported?: readonly string[];
}

/** Well-known paths §17.9's discovery step consults. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";

export function parseAuthorizationServerMetadata(
  raw: unknown,
): AuthorizationServerMetadata | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  const issuer = str(record.issuer);
  const authorizationEndpoint = str(record.authorization_endpoint);
  const tokenEndpoint = str(record.token_endpoint);
  if (issuer === undefined || tokenEndpoint === undefined) return undefined;

  // A device flow needs no authorization endpoint, so it is not required outright,
  // but one of the two paths must exist.
  const deviceAuthorizationEndpoint = str(record.device_authorization_endpoint);
  if (authorizationEndpoint === undefined && deviceAuthorizationEndpoint === undefined) {
    return undefined;
  }

  // Hoisted so each optional key is decided from one narrowed value.
  const registrationEndpoint = str(record.registration_endpoint);
  const revocationEndpoint = str(record.revocation_endpoint);
  const scopesSupported = strArray(record.scopes_supported);
  const codeChallengeMethodsSupported = strArray(record.code_challenge_methods_supported);
  const grantTypesSupported = strArray(record.grant_types_supported);

  return {
    issuer,
    authorizationEndpoint: authorizationEndpoint ?? "",
    tokenEndpoint,
    ...(registrationEndpoint !== undefined ? { registrationEndpoint } : {}),
    ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
    ...(deviceAuthorizationEndpoint !== undefined ? { deviceAuthorizationEndpoint } : {}),
    ...(scopesSupported !== undefined ? { scopesSupported } : {}),
    ...(codeChallengeMethodsSupported !== undefined ? { codeChallengeMethodsSupported } : {}),
    ...(grantTypesSupported !== undefined ? { grantTypesSupported } : {}),
  };
}

export function parseProtectedResourceMetadata(
  raw: unknown,
): ProtectedResourceMetadata | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const resource = str(record.resource);
  const servers = strArray(record.authorization_servers);
  if (resource === undefined || servers === undefined || servers.length === 0) return undefined;
  const scopesSupported = strArray(record.scopes_supported);
  return {
    resource,
    authorizationServers: servers,
    ...(scopesSupported !== undefined ? { scopesSupported } : {}),
  };
}

/**
 * §17.9 requires PKCE. S256 is the only method CBC will use: `plain` offers no
 * protection against an intercepted authorization code, so a server that supports
 * only `plain` is refused rather than downgraded to.
 */
export function requiresS256(metadata: AuthorizationServerMetadata): boolean {
  const methods = metadata.codeChallengeMethodsSupported;
  if (methods === undefined) return true;
  return methods.includes("S256");
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

/** Cryptographically random URL-safe string. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64Url(new Uint8Array(digest)),
    method: "S256",
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** State §17.9 keeps between starting a flow and receiving the redirect. */
export interface PendingAuthorization {
  readonly server: string;
  readonly state: string;
  readonly nonce: string;
  readonly pkce: PkcePair;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly issuer: string;
  /** The resource this token will be scoped to (§17.12 T7 audience). */
  readonly resource: string;
  readonly startedAtMs: number;
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly pending: PendingAuthorization;
}

export interface BuildAuthorizationOptions {
  readonly server: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly now?: () => number;
}

/** Build the authorization URL and the pending state to validate the callback. */
export async function buildAuthorizationRequest(
  options: BuildAuthorizationOptions,
): Promise<AuthorizationRequest> {
  if (!requiresS256(options.metadata)) {
    throw new Error(
      `authorization server ${options.metadata.issuer} does not support PKCE S256; Capybara Code will not fall back to a weaker method (§17.9)`,
    );
  }
  if (options.metadata.authorizationEndpoint.length === 0) {
    throw new Error(
      `authorization server ${options.metadata.issuer} advertises no authorization endpoint`,
    );
  }

  const pkce = await createPkcePair();
  const state = randomToken(24);
  const nonce = randomToken(16);

  const url = new URL(options.metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  if (options.scopes.length > 0) url.searchParams.set("scope", options.scopes.join(" "));
  // RFC 8707: bind the token to one resource so it cannot be replayed elsewhere.
  url.searchParams.set("resource", options.resource);

  return {
    url: url.toString(),
    pending: {
      server: options.server,
      state,
      nonce,
      pkce,
      redirectUri: options.redirectUri,
      scopes: [...options.scopes],
      issuer: options.metadata.issuer,
      resource: options.resource,
      startedAtMs: (options.now ?? Date.now)(),
    },
  };
}

/** How long a pending authorization stays valid. */
export const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;

export type CallbackValidation =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate the redirect before exchanging anything.
 *
 * State is compared in constant time: a timing oracle on state comparison is a
 * real, if narrow, CSRF avenue, and the comparison costs nothing.
 */
export function validateCallback(
  pending: PendingAuthorization,
  params: { code?: string; state?: string; error?: string; errorDescription?: string },
  now = Date.now(),
): CallbackValidation {
  if (params.error !== undefined) {
    return {
      ok: false,
      reason: `the authorization server returned '${params.error}'${
        params.errorDescription !== undefined ? `: ${params.errorDescription}` : ""
      }`,
    };
  }
  if (now - pending.startedAtMs > AUTHORIZATION_TIMEOUT_MS) {
    return { ok: false, reason: "the authorization request expired before it was completed" };
  }
  if (params.state === undefined || !timingSafeEqual(params.state, pending.state)) {
    return { ok: false, reason: "the callback state did not match; the request was not honoured" };
  }
  if (params.code === undefined || params.code.length === 0) {
    return { ok: false, reason: "the callback carried no authorization code" };
  }
  return { ok: true, code: params.code };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The token-exchange body. Kept as data so it can be asserted in a test. */
export function tokenExchangeBody(
  pending: PendingAuthorization,
  code: string,
  clientId: string,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", pending.redirectUri);
  body.set("client_id", clientId);
  body.set("code_verifier", pending.pkce.verifier);
  body.set("resource", pending.resource);
  return body;
}

export function refreshBody(
  refreshToken: string,
  clientId: string,
  resource: string,
  scopes: readonly string[],
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", clientId);
  body.set("resource", resource);
  if (scopes.length > 0) body.set("scope", scopes.join(" "));
  return body;
}

/**
 * Token metadata CBC records.
 *
 * The token *values* live in the OS keychain behind the Rust credential manager
 * (§9.1, §19.6). This record deliberately holds none of them, so it is safe to log,
 * show in `mcp doctor`, and persist alongside session state.
 */
export interface McpCredentialRecord {
  readonly server: string;
  readonly issuer: string;
  /** §17.12 T7: the resource this token is valid for, and only this one. */
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAtMs?: number;
  readonly hasRefreshToken: boolean;
  readonly obtainedAtMs: number;
  /** Keychain entry name, not the secret. */
  readonly keychainRef: string;
  /** Validated endpoint used for refresh; absent only on legacy records. */
  readonly tokenEndpoint?: string;
  /** Optional endpoint used by an explicit logout/revoke flow. */
  readonly revocationEndpoint?: string;
}

/** Whether a token needs refreshing, with a skew margin. */
export function needsRefresh(
  record: McpCredentialRecord,
  now = Date.now(),
  skewMs = 60_000,
): boolean {
  if (record.expiresAtMs === undefined) return false;
  return record.expiresAtMs - skewMs <= now;
}

/**
 * §17.12 T7: refuse to present a token to a resource it was not minted for.
 *
 * This is the concrete defence against token passthrough. Without it, a compromised
 * server could induce a call whose token belongs to a different service.
 */
export function isTokenValidForResource(record: McpCredentialRecord, resource: string): boolean {
  return normalizeResource(record.resource) === normalizeResource(resource);
}

function normalizeResource(resource: string): string {
  try {
    const url = new URL(resource);
    // Trailing-slash and default-port differences are not audience differences.
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return resource.replace(/\/+$/, "");
  }
}

/**
 * Per-server keychain entry name, so credentials stay isolated (§17.9).
 *
 * The `capy.` prefix is a storage key, not a command name. It was renamed alongside
 * the executable while the product is pre-release, because that is the only point at
 * which no stored token has to be migrated. A token saved under the previous prefix
 * is not read back; the interactive authorization flow obtains a fresh one.
 */
export function keychainRefFor(server: string, issuer: string): string {
  return `capy.mcp.${server}.${issuer.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * Read a string field from an untrusted discovery document.
 *
 * Every field arrives over the network from a server CBC does not control, so each
 * one is checked rather than cast: a metadata document with a numeric
 * `token_endpoint` should fail discovery, not produce a request to `"42"`.
 */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out.length === value.length ? out : undefined;
}

/** Render the scope list §17.9 requires to be shown before granting. */
export function renderScopeConsent(input: {
  server: string;
  issuer: string;
  resource: string;
  scopes: readonly string[];
}): string[] {
  const lines = [
    `Authorize MCP server '${input.server}'`,
    "",
    `Issuer    ${input.issuer}`,
    `Resource  ${input.resource}`,
  ];
  if (input.scopes.length === 0) {
    lines.push("Scopes    (none requested)");
  } else {
    lines.push("Scopes");
    for (const scope of input.scopes) lines.push(`  - ${scope}`);
  }
  lines.push("", "The token is stored in Capybara's credential store and is never sent to the model.");
  return lines;
}
