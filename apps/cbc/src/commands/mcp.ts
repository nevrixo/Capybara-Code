/**
 * `capy mcp` — PRD §8.8, §17.3, §17.5, §17.9, §17.11, §17.12.
 *
 * Two details from §8.8 shape the `add` implementation. First, command and args are
 * stored as an *array*, because a shell string is ambiguous and re-splitting it later
 * is how argument-injection bugs happen. Second, a server added from the CLI is
 * written to the *user* config: §17.5 lets a project define servers, but a project
 * may never be the thing that grants them, and writing there from a command would
 * blur that line.
 *
 * `login` implements §17.9 with no weaker fallbacks: PKCE S256 only, a loopback
 * redirect only, an explicit scope consent step, and a token bound to one resource
 * (§17.12 T7).
 */

import type { McpServerConfig } from "@cbc/config-schema";
import {
  AUTHORIZATION_SERVER_PATH,
  PROTECTED_RESOURCE_PATH,
  buildAuthorizationRequest,
  keychainRefFor,
  parseAuthorizationServerMetadata,
  parseProtectedResourceMetadata,
  renderDoctorReport,
  renderScopeConsent,
  runDoctor,
  tokenExchangeBody,
  validateCallback,
  validateServerUrl,
  type McpCredentialRecord,
} from "@cbc/mcp-client";

import { CliError, EXIT, usageError } from "../exit.ts";
import {
  MCP_PUBLIC_CLIENT_ID,
  readMcpCredentialRecord,
  removeMcpTokenSet,
  replaceMcpTokenSet,
} from "../mcp-credentials.ts";
import {
  OAuthNetworkError,
  safeOAuthRequest,
  validateOAuthEndpoint,
} from "../oauth-network.ts";
import { startLoopback } from "../loopback.ts";
import { toSnakeCase, upsertTomlValue } from "../state.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

// ---------------------------------------------------------------------------
// Config editing
// ---------------------------------------------------------------------------

/**
 * Write `[mcp.servers.<name>]` fields into the user config.
 *
 * This bypasses `setUserConfigValue` deliberately: that helper validates against the
 * camelCase schema (`mcpServers.*`), while the on-disk form §17.3 documents is
 * `[mcp.servers.<name>]`. Round-tripping through the schema path would reject a
 * perfectly valid server block.
 */
async function writeServerFields(
  context: CommandContext,
  server: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const file = context.paths.configFile;
  const existing = await context.host.fs.read(file);
  let lines = existing === undefined ? [] : existing.split("\n");

  for (const [key, value] of Object.entries(fields)) {
    lines = upsertTomlValue(lines, `mcp.servers.${server}.${toSnakeCase(key)}`, value);
  }

  await context.host.fs.mkdirp(context.paths.config);
  await context.host.fs.write(file, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return file;
}

/** Remove an entire `[mcp.servers.<name>]` table from the user config. */
async function removeServerTable(context: CommandContext, server: string): Promise<boolean> {
  const file = context.paths.configFile;
  const existing = await context.host.fs.read(file);
  if (existing === undefined) return false;

  const header = `[mcp.servers.${server}]`;
  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return false;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  await context.host.fs.write(file, `${next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`);
  return true;
}

/**
 * Split a stdio command string into program and arguments.
 *
 * Quoted segments are respected so `npx -y "@scope/pkg with space"` survives. §8.8
 * asks for the split to happen once, at add time, precisely so nothing re-parses it
 * later.
 */
export function splitCommand(input: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (const char of input.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);

  const [command = "", ...args] = parts;
  return { command, args };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface McpListArgs {
  readonly verbose: boolean;
}

export async function mcpList(
  context: CommandContext,
  args: McpListArgs,
): Promise<CommandResult> {
  const loaded = await context.config();
  const servers = Object.entries(loaded.config.mcpServers);

  if (servers.length === 0) {
    context.outLines([
      "No MCP servers are configured.",
      "",
      "Add one with:",
      '  capy mcp add local-files --stdio "npx -y @example/server"',
      "  capy mcp add issues --url https://example.com/mcp",
    ]);
    return ok();
  }

  const width = servers.reduce((max, [name]) => Math.max(max, name.length), 0);
  for (const [name, config] of servers) {
    const enabled = config.enabled === false ? "disabled" : "enabled";
    const target =
      config.transport === "stdio"
        ? `${config.command ?? "?"} ${(config.args ?? []).join(" ")}`.trim()
        : (config.url ?? "?");
    const source = loaded.provenance[`mcpServers.${name}.transport`] ?? "user";
    context.out(`${name.padEnd(width)}  ${config.transport.padEnd(15)}  ${enabled.padEnd(8)}  [${source}]  ${target}`);

    if (args.verbose) {
      if (config.auth !== undefined) context.out(`${" ".repeat(width)}  auth: ${config.auth}`);
      if (config.env !== undefined && config.env.length > 0) {
        // §14.5: only variable *names* are configurable, never values.
        context.out(`${" ".repeat(width)}  env: ${config.env.join(", ")}`);
      }
      if (config.timeoutMs !== undefined) {
        context.out(`${" ".repeat(width)}  timeout: ${config.timeoutMs} ms`);
      }
    }
  }

  if (!loaded.projectLayerApplied) {
    const projectFile = loaded.projectConfigPath;
    if (await context.host.fs.exists(projectFile)) {
      // §17.5 + §13.6: a project may define servers, but not from an untrusted
      // workspace. Saying so is better than silently showing a shorter list.
      context.out("");
      context.out(`Project servers in ${projectFile} are not applied (trust: ${loaded.trust}).`);
    }
  }
  return ok();
}

export interface McpAddArgs {
  readonly name: string;
  readonly stdio?: string;
  readonly url?: string;
}

export async function mcpAdd(
  context: CommandContext,
  args: McpAddArgs,
): Promise<CommandResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.name)) {
    throw usageError(`'${args.name}' is not a valid server name`, [
      "Use letters, digits, hyphens, and underscores.",
    ]);
  }

  const loaded = await context.config();
  if (loaded.config.mcpServers[args.name] !== undefined) {
    throw usageError(`an MCP server named '${args.name}' already exists`, [
      `Remove it first with \`capy mcp remove ${args.name}\`.`,
    ]);
  }

  let fields: Record<string, unknown>;
  if (args.stdio !== undefined) {
    const { command, args: commandArgs } = splitCommand(args.stdio);
    if (command.length === 0) {
      throw usageError("--stdio needs a command to run");
    }
    fields = {
      transport: "stdio",
      command,
      args: commandArgs,
      enabled: true,
    };
  } else if (args.url !== undefined) {
    // §17.12: refuse a URL the transport would reject anyway, and say why now
    // rather than at first connect.
    const verdict = validateServerUrl(args.url);
    if (!verdict.ok) {
      throw usageError(`--url was rejected: ${verdict.reason}`);
    }
    fields = {
      transport: "streamable_http",
      url: args.url,
      auth: "oauth",
      enabled: true,
    };
  } else {
    throw usageError("capy mcp add needs either --stdio or --url");
  }

  const file = await writeServerFields(context, args.name, fields);
  context.out(`Added MCP server '${args.name}' (${String(fields.transport)})`);
  context.out(`Wrote ${file}`);
  if (fields.transport === "streamable_http") {
    context.out(`Authorize it with: capy mcp login ${args.name}`);
  }
  context.out(`Check it with:     capy mcp doctor ${args.name}`);
  return ok();
}

export interface McpNameArgs {
  readonly name: string;
}

export async function mcpRemove(
  context: CommandContext,
  args: McpNameArgs,
): Promise<CommandResult> {
  const removed = await removeServerTable(context, args.name);
  if (!removed) {
    const loaded = await context.config();
    if (loaded.config.mcpServers[args.name] !== undefined) {
      // The definition exists but not in the user file, so this command cannot
      // remove it. Saying where it came from is more useful than "not found".
      throw new CliError(
        EXIT.config,
        `'${args.name}' is not defined in your user config`,
        [`It comes from ${loaded.provenance[`mcpServers.${args.name}.transport`] ?? "another layer"}.`],
      );
    }
    throw usageError(`no MCP server named '${args.name}'`);
  }
  context.out(`Removed MCP server '${args.name}'`);
  context.out(`Wrote ${context.paths.configFile}`);
  context.out("Any stored token for it was kept; use `capy mcp logout` to remove it.");
  return ok();
}

export async function mcpSetEnabled(
  context: CommandContext,
  args: McpNameArgs,
  enabled: boolean,
): Promise<CommandResult> {
  const loaded = await context.config();
  if (loaded.config.mcpServers[args.name] === undefined) {
    throw usageError(`no MCP server named '${args.name}'`);
  }
  const file = await writeServerFields(context, args.name, { enabled });
  context.out(`${enabled ? "Enabled" : "Disabled"} MCP server '${args.name}'`);
  context.out(`Wrote ${file}`);
  return ok();
}

// ---------------------------------------------------------------------------
// §17.9 OAuth
// ---------------------------------------------------------------------------

function canonicalUrl(url: URL): string {
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function canonicalIssuer(url: URL): string {
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function authorizationMetadataUrl(issuer: URL): string {
  const suffix = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/+$/, "");
  return new URL(AUTHORIZATION_SERVER_PATH + suffix, issuer.origin).toString();
}

function parseJsonObject(body: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CliError(EXIT.auth, description + " returned malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(EXIT.auth, description + " returned a non-object JSON value");
  }
  return parsed as Record<string, unknown>;
}

interface DiscoveredMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly codeChallengeMethodsSupported?: readonly string[];
  readonly scopes: string[];
  readonly resource: string;
}

async function discoverMetadata(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<DiscoveredMetadata> {
  const verdict = validateServerUrl(serverUrl);
  if (!verdict.ok) throw new CliError(EXIT.auth, "MCP server URL was rejected: " + verdict.reason);
  const base = validateOAuthEndpoint(verdict.url.toString());
  const resource = canonicalUrl(base);

  const protectedUrl = new URL(PROTECTED_RESOURCE_PATH, base).toString();
  const protectedResponse = await safeOAuthRequest(protectedUrl, {
    headers: { accept: "application/json" },
    ...(signal !== undefined ? { signal } : {}),
  });

  let issuerBase = new URL(base.origin);
  let scopes: string[] = [];
  if (protectedResponse.ok) {
    const parsed = parseProtectedResourceMetadata(
      parseJsonObject(protectedResponse.body, "protected-resource metadata"),
    );
    if (parsed === undefined) {
      throw new CliError(EXIT.auth, "the protected-resource metadata was malformed");
    }
    const advertisedResource = validateOAuthEndpoint(parsed.resource);
    if (canonicalUrl(advertisedResource) !== resource) {
      throw new CliError(
        EXIT.auth,
        "protected-resource metadata was for " + canonicalUrl(advertisedResource) + ", not " + resource,
      );
    }
    issuerBase = validateOAuthEndpoint(parsed.authorizationServers[0] as string);
    scopes = [...(parsed.scopesSupported ?? [])];
  } else if (protectedResponse.status !== 404) {
    throw new CliError(
      EXIT.auth,
      "protected-resource metadata returned " + protectedResponse.status,
    );
  }

  const metadataUrl = authorizationMetadataUrl(issuerBase);
  const asResponse = await safeOAuthRequest(metadataUrl, {
    headers: { accept: "application/json" },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!asResponse.ok) {
    throw new CliError(
      EXIT.auth,
      "could not discover an authorization server for " + serverUrl,
      ["Tried " + metadataUrl, "Capybara Code will not guess undocumented endpoints."],
    );
  }

  const metadata = parseAuthorizationServerMetadata(
    parseJsonObject(asResponse.body, "authorization-server metadata"),
  );
  if (metadata === undefined) {
    throw new CliError(EXIT.auth, "the authorization-server metadata was malformed");
  }

  const issuer = validateOAuthEndpoint(metadata.issuer);
  if (canonicalIssuer(issuer) !== canonicalIssuer(issuerBase)) {
    throw new CliError(
      EXIT.auth,
      "authorization-server issuer mismatch: expected " +
        canonicalIssuer(issuerBase) +
        ", got " +
        canonicalIssuer(issuer),
    );
  }
  const authorizationEndpoint = validateOAuthEndpoint(metadata.authorizationEndpoint);
  const tokenEndpoint = validateOAuthEndpoint(metadata.tokenEndpoint);
  const endpoints = [authorizationEndpoint, tokenEndpoint];
  const revocationEndpoint =
    metadata.revocationEndpoint === undefined
      ? undefined
      : validateOAuthEndpoint(metadata.revocationEndpoint);
  if (revocationEndpoint !== undefined) endpoints.push(revocationEndpoint);
  for (const endpoint of endpoints) {
    if (endpoint.origin !== issuer.origin) {
      throw new CliError(
        EXIT.auth,
        "OAuth endpoint " + endpoint.origin + " does not match issuer origin " + issuer.origin,
      );
    }
  }

  return {
    issuer: canonicalIssuer(issuer),
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    ...(revocationEndpoint !== undefined ? { revocationEndpoint: revocationEndpoint.toString() } : {}),
    ...(metadata.codeChallengeMethodsSupported !== undefined
      ? { codeChallengeMethodsSupported: [...metadata.codeChallengeMethodsSupported] }
      : {}),
    scopes: scopes.length > 0 ? scopes : [...(metadata.scopesSupported ?? [])],
    resource,
  };
}

export async function mcpLogin(
  context: CommandContext,
  args: McpNameArgs,
): Promise<CommandResult> {
  const loaded = await context.config();
  const config = loaded.config.mcpServers[args.name];
  if (config === undefined) throw usageError("no MCP server named '" + args.name + "'");
  if (config.transport !== "streamable_http" || config.url === undefined) {
    throw usageError("'" + args.name + "' is a stdio server and does not use OAuth", [
      "OAuth applies to Streamable HTTP servers only.",
    ]);
  }
  if (context.nonInteractive) {
    throw new CliError(EXIT.auth, "capy mcp login needs an interactive terminal", [
      "Authorization requires a browser and an explicit consent step.",
    ]);
  }

  const cancellation = new AbortController();
  const onInterrupt = (): void => cancellation.abort();
  process.once("SIGINT", onInterrupt);
  let loopback: ReturnType<typeof startLoopback> | undefined;

  try {
    const metadata = await discoverMetadata(config.url, cancellation.signal);
    loopback = startLoopback();
    const request = await buildAuthorizationRequest({
      server: args.name,
      metadata: {
        issuer: metadata.issuer,
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        ...(metadata.revocationEndpoint !== undefined
          ? { revocationEndpoint: metadata.revocationEndpoint }
          : {}),
        ...(metadata.codeChallengeMethodsSupported !== undefined
          ? { codeChallengeMethodsSupported: metadata.codeChallengeMethodsSupported }
          : {}),
      },
      clientId: MCP_PUBLIC_CLIENT_ID,
      redirectUri: loopback.redirectUri,
      scopes: metadata.scopes,
      resource: metadata.resource,
      now: () => context.host.now(),
    });

    context.outLines(
      renderScopeConsent({
        server: args.name,
        issuer: metadata.issuer,
        resource: metadata.resource,
        scopes: metadata.scopes,
      }),
    );
    const choice = await context.host.io.select("Continue?", ["Authorize in browser", "Cancel"]);
    if (choice !== 0) {
      context.out("Cancelled. No token was requested.");
      return ok();
    }

    context.out("");
    context.out("Open this URL to authorize:");
    context.out("  " + request.url);
    context.out("");
    context.warn("Waiting for the authorization response... [Ctrl+C to cancel]");

    const outcome = await loopback.wait({ signal: cancellation.signal });
    if (outcome.kind === "timeout") {
      throw new CliError(EXIT.auth, "the authorization request timed out", [
        "No token was requested. Run the command again to retry.",
      ]);
    }
    if (outcome.kind === "cancelled") {
      context.out("Cancelled. No token was requested.");
      return ok();
    }
    const params = outcome.params;
    const validation = validateCallback(
      request.pending,
      {
        ...(params.code !== undefined ? { code: params.code } : {}),
        ...(params.state !== undefined ? { state: params.state } : {}),
        ...(params.error !== undefined ? { error: params.error } : {}),
        ...(params.error_description !== undefined
          ? { errorDescription: params.error_description }
          : {}),
      },
      context.host.now(),
    );
    if (!validation.ok) {
      throw new CliError(EXIT.auth, "authorization failed: " + validation.reason);
    }

    const tokenResponse = await safeOAuthRequest(metadata.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: tokenExchangeBody(
        request.pending,
        validation.code,
        MCP_PUBLIC_CLIENT_ID,
      ).toString(),
      signal: cancellation.signal,
    });
    if (!tokenResponse.ok) {
      throw new CliError(
        EXIT.auth,
        "the token endpoint returned " + tokenResponse.status,
        [tokenResponse.body.slice(0, 400)],
      );
    }

    const token = parseJsonObject(tokenResponse.body, "the token endpoint");
    const accessToken =
      typeof token.access_token === "string" && token.access_token.length > 0
        ? token.access_token
        : undefined;
    const refreshToken =
      typeof token.refresh_token === "string" && token.refresh_token.length > 0
        ? token.refresh_token
        : undefined;
    if (accessToken === undefined) {
      throw new CliError(EXIT.auth, "the token response carried no access token");
    }
    if (
      token.token_type !== undefined &&
      (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer")
    ) {
      throw new CliError(EXIT.auth, "the token endpoint returned an unsupported token type");
    }
    if (
      token.expires_in !== undefined &&
      (typeof token.expires_in !== "number" ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0)
    ) {
      throw new CliError(EXIT.auth, "the token endpoint returned an invalid expires_in");
    }
    if (token.scope !== undefined && typeof token.scope !== "string") {
      throw new CliError(EXIT.auth, "the token endpoint returned an invalid scope");
    }

    const keychainRef = keychainRefFor(args.name, metadata.issuer);
    const runtime = await context.runtime();
    const provisional: McpCredentialRecord = {
      server: args.name,
      issuer: metadata.issuer,
      resource: metadata.resource,
      scopes: typeof token.scope === "string" ? token.scope.split(/\s+/) : metadata.scopes,
      ...(typeof token.expires_in === "number"
        ? { expiresAtMs: context.host.now() + token.expires_in * 1000 }
        : {}),
      hasRefreshToken: false,
      obtainedAtMs: context.host.now(),
      keychainRef,
      tokenEndpoint: metadata.tokenEndpoint,
      ...(metadata.revocationEndpoint !== undefined
        ? { revocationEndpoint: metadata.revocationEndpoint }
        : {}),
    };
    const record = await replaceMcpTokenSet({
      host: context.host,
      paths: context.paths,
      runtime,
      record: provisional,
      accessToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    });

    context.out("");
    context.out("\u2713 Authorized '" + args.name + "'");
    context.out("  Resource " + record.resource);
    context.out("  Scopes   " + (record.scopes.length > 0 ? record.scopes.join(" ") : "(none)"));
    context.out("  Stored   " + keychainRef);
    return ok();
  } catch (error) {
    if (cancellation.signal.aborted) {
      context.out("Cancelled. No token was stored.");
      return ok();
    }
    if (error instanceof OAuthNetworkError) {
      throw new CliError(EXIT.auth, error.message);
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    loopback?.close();
  }
}

export async function mcpLogout(
  context: CommandContext,
  args: McpNameArgs,
): Promise<CommandResult> {
  const record = await readMcpCredentialRecord(context.host, context.paths, args.name);
  if (record === undefined) {
    context.out("No stored authorization for '" + args.name + "'.");
    return ok();
  }

  const runtime = await context.runtime();
  await removeMcpTokenSet({
    host: context.host,
    paths: context.paths,
    runtime,
    record,
  });

  context.out("Removed authorization for '" + args.name + "'");
  return ok();
}

export interface McpDoctorArgs {
  readonly name?: string;
}

/** §17.11's per-server diagnosis. */
export async function mcpDoctor(
  context: CommandContext,
  args: McpDoctorArgs,
): Promise<CommandResult> {
  const loaded = await context.config();
  const entries = Object.entries(loaded.config.mcpServers).filter(
    ([name]) => args.name === undefined || name === args.name,
  );

  if (entries.length === 0) {
    if (args.name !== undefined) throw usageError(`no MCP server named '${args.name}'`);
    context.out("No MCP servers are configured.");
    return ok();
  }

  const trust = await context.trust();
  const workspaceTrusted = trust === "trusted-always" || trust === "trusted-once";
  let healthy = true;

  for (const [name, config] of entries) {
    const source = loaded.provenance[`mcpServers.${name}.transport`];
    const record = await readMcpCredentialRecord(context.host, context.paths, name);
    const report = await runDoctor({
      server: name,
      config: config as McpServerConfig,
      workspaceTrusted,
      fromProjectConfig: source === "project",
      ...(record !== undefined ? { credential: record } : {}),
      commandExists: async (command: string) => await commandExists(context, command),
      now: () => context.host.now(),
    });
    if (!report.healthy) healthy = false;
    context.outLines(renderDoctorReport(report));
    context.out("");
  }

  return healthy ? ok() : { code: EXIT.failure };
}

// ---------------------------------------------------------------------------
// Credential records (metadata only — §17.9)
// ---------------------------------------------------------------------------


/**
 * Whether a stdio server's command exists.
 *
 * Resolved through the runtime rather than by searching `PATH` here: §19.5 gives the
 * runtime ownership of process invocation, and asking it keeps one answer for
 * "can this actually run".
 */
async function commandExists(context: CommandContext, command: string): Promise<boolean> {
  try {
    const runtime = await context.runtime();
    const probe = await runtime.run({
      program: command,
      args: ["--version"],
      cwd: ".",
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    return probe.state === "exited";
  } catch {
    return false;
  }
}
