/** MCP OAuth credential records and runtime-only bearer-token access. */

import {
  isTokenValidForResource,
  needsRefresh,
  refreshBody,
  type McpCredentialRecord,
} from "@cbc/mcp-client";

import { join, type CbcPaths, type Host } from "./host.ts";
import { OAuthNetworkError, safeOAuthRequest, validateOAuthEndpoint } from "./oauth-network.ts";
import type { Runtime } from "./runtime.ts";

export const MCP_PUBLIC_CLIENT_ID = "capybara-code";
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type McpCredentialRuntime = Pick<
  Runtime,
  "storeCredential" | "leaseCredential" | "deleteCredential"
>;

export type OAuthRequester = typeof safeOAuthRequest;

export class McpCredentialError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient = false) {
    super(message);
    this.name = "McpCredentialError";
    this.transient = transient;
  }
}

export function mcpCredentialRecordPath(paths: CbcPaths, server: string): string {
  if (!SERVER_NAME.test(server)) throw new McpCredentialError(`invalid MCP server name '${server}'`);
  return join(paths.data, "mcp", `${server}.json`);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse persisted metadata as untrusted input; token values are never in this file. */
export function parseMcpCredentialRecord(
  raw: unknown,
  expectedServer?: string,
): McpCredentialRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const server = nonEmptyString(value.server);
  const issuer = nonEmptyString(value.issuer);
  const resource = nonEmptyString(value.resource);
  const keychainRef = nonEmptyString(value.keychainRef);
  if (
    server === undefined ||
    issuer === undefined ||
    resource === undefined ||
    keychainRef === undefined ||
    !SERVER_NAME.test(server) ||
    (expectedServer !== undefined && server !== expectedServer) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === "string") ||
    typeof value.hasRefreshToken !== "boolean" ||
    typeof value.obtainedAtMs !== "number" ||
    !Number.isFinite(value.obtainedAtMs)
  ) {
    return undefined;
  }
  const expiresAtMs = value.expiresAtMs;
  if (expiresAtMs !== undefined && (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs))) {
    return undefined;
  }
  const tokenEndpoint = value.tokenEndpoint;
  const revocationEndpoint = value.revocationEndpoint;
  if (tokenEndpoint !== undefined && nonEmptyString(tokenEndpoint) === undefined) return undefined;
  if (revocationEndpoint !== undefined && nonEmptyString(revocationEndpoint) === undefined) return undefined;

  return {
    server,
    issuer,
    resource,
    scopes: [...(value.scopes as string[])],
    hasRefreshToken: value.hasRefreshToken,
    obtainedAtMs: value.obtainedAtMs,
    keychainRef,
    ...(typeof expiresAtMs === "number" ? { expiresAtMs } : {}),
    ...(typeof tokenEndpoint === "string" ? { tokenEndpoint } : {}),
    ...(typeof revocationEndpoint === "string" ? { revocationEndpoint } : {}),
  };
}

export async function readMcpCredentialRecord(
  host: Pick<Host, "fs">,
  paths: CbcPaths,
  server: string,
): Promise<McpCredentialRecord | undefined> {
  const raw = await host.fs.read(mcpCredentialRecordPath(paths, server));
  if (raw === undefined) return undefined;
  try {
    return parseMcpCredentialRecord(JSON.parse(raw), server);
  } catch {
    return undefined;
  }
}

export async function writeMcpCredentialRecord(
  host: Pick<Host, "fs">,
  paths: CbcPaths,
  record: McpCredentialRecord,
): Promise<void> {
  await host.fs.mkdirp(join(paths.data, "mcp"));
  await host.fs.atomicWrite(
    mcpCredentialRecordPath(paths, record.server),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

async function leaseSecret(runtime: McpCredentialRuntime, account: string): Promise<string | undefined> {
  try {
    return (await runtime.leaseCredential(account)).secret;
  } catch {
    return undefined;
  }
}

async function restoreSecret(
  runtime: McpCredentialRuntime,
  account: string,
  secret: string | undefined,
): Promise<void> {
  if (secret === undefined) await runtime.deleteCredential(account);
  else await runtime.storeCredential(account, secret);
}

export interface ReplaceMcpTokenSetOptions {
  readonly host: Pick<Host, "fs">;
  readonly paths: CbcPaths;
  readonly runtime: McpCredentialRuntime;
  readonly record: McpCredentialRecord;
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** RFC 6749: a refresh response that omits refresh_token retains the old one. */
  readonly preserveExistingRefresh?: boolean;
}

/** Replace access token, refresh token, and metadata as one recoverable operation. */
export async function replaceMcpTokenSet(options: ReplaceMcpTokenSetOptions): Promise<McpCredentialRecord> {
  const path = mcpCredentialRecordPath(options.paths, options.record.server);
  const previousRaw = await options.host.fs.read(path);
  const previous = previousRaw === undefined
    ? undefined
    : (() => {
        try {
          return parseMcpCredentialRecord(JSON.parse(previousRaw), options.record.server);
        } catch {
          return undefined;
        }
      })();
  const accounts = new Set([
    options.record.keychainRef,
    `${options.record.keychainRef}.refresh`,
    ...(previous === undefined ? [] : [previous.keychainRef, `${previous.keychainRef}.refresh`]),
  ]);
  const snapshots = new Map<string, string | undefined>();
  for (const account of accounts) snapshots.set(account, await leaseSecret(options.runtime, account));

  const retainPreviousRefresh =
    options.preserveExistingRefresh === true &&
    previous?.keychainRef === options.record.keychainRef &&
    previous.hasRefreshToken &&
    snapshots.get(`${options.record.keychainRef}.refresh`) !== undefined;
  const next: McpCredentialRecord = {
    ...options.record,
    hasRefreshToken: options.refreshToken !== undefined || retainPreviousRefresh,
  };

  try {
    await options.runtime.storeCredential(next.keychainRef, options.accessToken);
    if (options.refreshToken !== undefined) {
      await options.runtime.storeCredential(`${next.keychainRef}.refresh`, options.refreshToken);
    } else if (!retainPreviousRefresh) {
      await options.runtime.deleteCredential(`${next.keychainRef}.refresh`);
    }
    await writeMcpCredentialRecord(options.host, options.paths, next);
    if (previous !== undefined && previous.keychainRef !== next.keychainRef) {
      await options.runtime.deleteCredential(previous.keychainRef);
      await options.runtime.deleteCredential(`${previous.keychainRef}.refresh`);
    }
    return next;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const [account, secret] of snapshots) {
      try {
        await restoreSecret(options.runtime, account, secret);
      } catch (rollbackError) {
        rollbackErrors.push(`${account}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    try {
      if (previousRaw === undefined) await options.host.fs.remove(path);
      else await options.host.fs.atomicWrite(path, previousRaw);
    } catch (rollbackError) {
      rollbackErrors.push(`record: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    const base = error instanceof Error ? error.message : String(error);
    throw new McpCredentialError(
      rollbackErrors.length === 0
        ? `could not store MCP credentials: ${base}; previous credentials were restored`
        : `could not store MCP credentials: ${base}; rollback also failed (${rollbackErrors.join("; ")})`,
    );
  }
}

function validateRefreshBinding(record: McpCredentialRecord): string | undefined {
  if (record.tokenEndpoint === undefined) return undefined;
  const issuer = validateOAuthEndpoint(record.issuer);
  const endpoint = validateOAuthEndpoint(record.tokenEndpoint);
  if (issuer.origin !== endpoint.origin) {
    throw new McpCredentialError(
      `MCP token endpoint ${endpoint.origin} does not match issuer ${issuer.origin}`,
    );
  }
  return endpoint.toString();
}

interface ResolveAuthorizationOptions {
  readonly host: Pick<Host, "fs">;
  readonly paths: CbcPaths;
  readonly runtime: McpCredentialRuntime;
  readonly server: string;
  readonly resource: string;
  readonly now?: () => number;
  readonly request?: OAuthRequester;
}

const refreshLocks = new Map<string, Promise<string | undefined>>();

async function resolveAuthorizationUnlocked(options: ResolveAuthorizationOptions): Promise<string | undefined> {
  let record = await readMcpCredentialRecord(options.host, options.paths, options.server);
  if (record === undefined) return undefined;
  if (record.server !== options.server || !isTokenValidForResource(record, options.resource)) {
    throw new McpCredentialError(`stored token for '${options.server}' is not valid for ${options.resource}`);
  }

  const now = (options.now ?? Date.now)();
  const actuallyExpired = record.expiresAtMs !== undefined && record.expiresAtMs <= now;
  if (needsRefresh(record, now)) {
    const tokenEndpoint = record.hasRefreshToken ? validateRefreshBinding(record) : undefined;
    if (tokenEndpoint !== undefined) {
      try {
        const refreshToken = await leaseSecret(options.runtime, `${record.keychainRef}.refresh`);
        if (refreshToken === undefined) throw new McpCredentialError("the MCP refresh token is missing");
        const response = await (options.request ?? safeOAuthRequest)(tokenEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: refreshBody(refreshToken, MCP_PUBLIC_CLIENT_ID, record.resource, record.scopes).toString(),
        });
        if (!response.ok) {
          throw new McpCredentialError(
            `MCP token refresh returned ${response.status}`,
            response.status === 429 || response.status >= 500,
          );
        }
        let token: Record<string, unknown>;
        try {
          token = JSON.parse(response.body) as Record<string, unknown>;
        } catch {
          throw new McpCredentialError("MCP token refresh returned malformed JSON");
        }
        const accessToken = nonEmptyString(token.access_token);
        if (accessToken === undefined) throw new McpCredentialError("MCP token refresh returned no access token");
        const refreshTokenNext = nonEmptyString(token.refresh_token);
        const expiresIn = token.expires_in;
        if (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)) {
          throw new McpCredentialError("MCP token refresh returned an invalid expires_in");
        }
        const scope = nonEmptyString(token.scope);
        record = await replaceMcpTokenSet({
          host: options.host,
          paths: options.paths,
          runtime: options.runtime,
          accessToken,
          ...(refreshTokenNext !== undefined ? { refreshToken: refreshTokenNext } : {}),
          preserveExistingRefresh: true,
          record: {
            ...record,
            scopes: scope === undefined ? record.scopes : scope.split(/\s+/),
            obtainedAtMs: now,
            ...(typeof expiresIn === "number" ? { expiresAtMs: now + expiresIn * 1000 } : {}),
          },
        });
      } catch (error) {
        const transient =
          (error instanceof OAuthNetworkError && error.transient) ||
          (error instanceof McpCredentialError && error.transient);
        // Inside the skew window, a temporary outage must not cause early logout.
        if (!transient || actuallyExpired) throw error;
      }
    } else if (actuallyExpired) {
      return undefined;
    }
  }

  if (record.expiresAtMs !== undefined && record.expiresAtMs <= now) return undefined;
  const accessToken = await leaseSecret(options.runtime, record.keychainRef);
  return accessToken === undefined ? undefined : `Bearer ${accessToken}`;
}

/** Return a resource-bound bearer header, refreshing at most once per server. */
export async function resolveMcpAuthorization(options: ResolveAuthorizationOptions): Promise<string | undefined> {
  const key = `${options.server}\0${options.resource}`;
  const existing = refreshLocks.get(key);
  if (existing !== undefined) return await existing;
  const pending = resolveAuthorizationUnlocked(options).finally(() => {
    if (refreshLocks.get(key) === pending) refreshLocks.delete(key);
  });
  refreshLocks.set(key, pending);
  return await pending;
}

export async function removeMcpTokenSet(options: {
  readonly host: Pick<Host, "fs">;
  readonly paths: CbcPaths;
  readonly runtime: McpCredentialRuntime;
  readonly record: McpCredentialRecord;
}): Promise<void> {
  const access = await leaseSecret(options.runtime, options.record.keychainRef);
  const refresh = await leaseSecret(options.runtime, `${options.record.keychainRef}.refresh`);
  try {
    await options.runtime.deleteCredential(options.record.keychainRef);
    await options.runtime.deleteCredential(`${options.record.keychainRef}.refresh`);
    await options.host.fs.remove(mcpCredentialRecordPath(options.paths, options.record.server));
  } catch (error) {
    if (access !== undefined) await options.runtime.storeCredential(options.record.keychainRef, access);
    if (refresh !== undefined) await options.runtime.storeCredential(`${options.record.keychainRef}.refresh`, refresh);
    throw error;
  }
}

