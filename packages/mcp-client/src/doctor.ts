/**
 * `capy mcp doctor` — PRD §17.11, AC-31.
 *
 * §17.11's checklist: config schema, executable or URL, trust state, transport
 * connection, protocol negotiation, auth status and scopes, capability listing, a
 * safe sample ping or read, latency, and version.
 *
 * The checks run in dependency order and stop at the first hard failure, because
 * "auth failed" is noise when the transport never connected.
 */

import type { McpServerConfig } from "@cbc/config-schema";

import type { McpClient, McpServerStatus } from "./client.ts";
import type { McpCredentialRecord } from "./oauth.ts";
import { needsRefresh } from "./oauth.ts";
import { validateServerUrl } from "./transport.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly durationMs?: number;
}

export interface DoctorReport {
  readonly server: string;
  readonly checks: DoctorCheck[];
  readonly healthy: boolean;
  /** Actual negotiated protocol, which §17.11 requires doctor to show. */
  readonly protocol?: string;
  readonly latencyMs?: number;
}

export interface DoctorInput {
  readonly server: string;
  readonly config: McpServerConfig;
  readonly workspaceTrusted: boolean;
  /** Whether the server is defined by project config (§17.5). */
  readonly fromProjectConfig: boolean;
  /** Present once the client exists; absent when config validation already failed. */
  readonly client?: McpClient;
  readonly credential?: McpCredentialRecord;
  /** Resolves whether a stdio command exists and is executable. */
  readonly commandExists?: (command: string) => Promise<boolean>;
  readonly now?: () => number;
}

/** Validate one server's configuration without touching the network. */
export function checkConfig(server: string, config: McpServerConfig): DoctorCheck {
  if (config.transport === "stdio") {
    if (config.command === undefined || config.command.trim().length === 0) {
      return {
        name: "config",
        status: "fail",
        detail: "a stdio server needs a 'command'",
      };
    }
    if (config.url !== undefined) {
      return {
        name: "config",
        status: "warn",
        detail: "'url' is ignored for a stdio server",
      };
    }
    // §8.8: command and args are stored as an array so shell parsing is never
    // needed. A command containing shell metacharacters means someone tried.
    if (/[|&;<>$`]/.test(config.command)) {
      return {
        name: "config",
        status: "fail",
        detail: `'${config.command}' contains shell metacharacters; command and args must be separate values (§8.8)`,
      };
    }
    return {
      name: "config",
      status: "pass",
      detail: `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim(),
    };
  }

  if (config.transport === "streamable_http") {
    if (config.url === undefined) {
      return { name: "config", status: "fail", detail: "an HTTP server needs a 'url'" };
    }
    const validated = validateServerUrl(config.url);
    if (!validated.ok) {
      return { name: "config", status: "fail", detail: validated.reason };
    }
    return { name: "config", status: "pass", detail: `streamable_http: ${config.url}` };
  }

  return {
    name: "config",
    status: "fail",
    detail: `unknown transport '${String(config.transport)}'`,
  };
}

/** §17.11 trust check. A project stdio server needs a trusted workspace. */
export function checkTrust(input: {
  fromProjectConfig: boolean;
  workspaceTrusted: boolean;
  transport: McpServerConfig["transport"];
}): DoctorCheck {
  if (!input.fromProjectConfig) {
    return {
      name: "trust",
      status: "pass",
      detail: "user-level configuration; workspace trust is not required",
    };
  }
  if (input.workspaceTrusted) {
    return { name: "trust", status: "pass", detail: "project configuration in a trusted workspace" };
  }
  return {
    name: "trust",
    status: "fail",
    detail:
      input.transport === "stdio"
        ? "the project is not trusted, so this stdio command will not be launched (PERM-001)"
        : "the project is not trusted, so this project-configured server is disabled (§13.6)",
  };
}

export function checkAuth(
  config: McpServerConfig,
  credential: McpCredentialRecord | undefined,
  now: number,
): DoctorCheck {
  if (config.transport === "stdio") {
    return { name: "auth", status: "skip", detail: "a stdio server uses no bearer credential" };
  }
  if (config.auth === undefined || config.auth === "none") {
    return { name: "auth", status: "pass", detail: "no authorization configured" };
  }
  if (credential === undefined) {
    return {
      name: "auth",
      status: "fail",
      detail: `auth is '${config.auth}' but no credential is stored; run 'capy mcp login ${""}'`.trim(),
    };
  }

  const scopes = credential.scopes.length > 0 ? credential.scopes.join(", ") : "(none)";
  if (needsRefresh(credential, now)) {
    return {
      name: "auth",
      status: credential.hasRefreshToken ? "warn" : "fail",
      detail: credential.hasRefreshToken
        ? `the access token is expiring and will be refreshed; scopes: ${scopes}`
        : `the access token has expired and there is no refresh token; scopes: ${scopes}`,
    };
  }

  return {
    name: "auth",
    status: "pass",
    // §17.9 requires scopes to be visible; the token itself never appears.
    detail: `authorized at ${credential.issuer} for ${credential.resource}; scopes: ${scopes}`,
  };
}

/** Run the full §17.11 sequence. */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const now = input.now ?? (() => Date.now());
  const checks: DoctorCheck[] = [];

  const config = checkConfig(input.server, input.config);
  checks.push(config);
  if (config.status === "fail") return finish(input.server, checks);

  const trust = checkTrust({
    fromProjectConfig: input.fromProjectConfig,
    workspaceTrusted: input.workspaceTrusted,
    transport: input.config.transport,
  });
  checks.push(trust);
  if (trust.status === "fail") return finish(input.server, checks);

  // ---- executable or URL reachability ----
  if (input.config.transport === "stdio") {
    const command = input.config.command ?? "";
    if (input.commandExists === undefined) {
      checks.push({
        name: "executable",
        status: "skip",
        detail: `cannot verify '${command}' without a resolver`,
      });
    } else {
      const exists = await input.commandExists(command);
      checks.push({
        name: "executable",
        status: exists ? "pass" : "fail",
        detail: exists ? `'${command}' resolves` : `'${command}' was not found on PATH`,
      });
      if (!exists) return finish(input.server, checks);
    }
  } else {
    checks.push({
      name: "endpoint",
      status: "pass",
      detail: `${input.config.url ?? ""} is a valid HTTPS endpoint`,
    });
  }

  checks.push(checkAuth(input.config, input.credential, now()));

  if (input.client === undefined) {
    checks.push({
      name: "connection",
      status: "skip",
      detail: "no client was supplied, so the connection was not attempted",
    });
    return finish(input.server, checks);
  }

  // ---- connection and negotiation ----
  const startedAt = now();
  let status: McpServerStatus;
  try {
    status = await input.client.connect();
    checks.push({
      name: "connection",
      status: "pass",
      detail: `connected over ${status.transport}`,
      durationMs: now() - startedAt,
    });
  } catch (error) {
    checks.push({
      name: "connection",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: now() - startedAt,
    });
    return finish(input.server, checks);
  }

  checks.push({
    name: "protocol",
    status: status.revision === undefined ? "fail" : "pass",
    // §17.11: show the *actual* protocol, not the one CBC prefers.
    detail:
      status.revision === undefined
        ? "no protocol revision was negotiated"
        : `negotiated ${status.revision} (${status.era ?? "unknown"} era)`,
  });

  checks.push({
    name: "version",
    status: "pass",
    detail:
      status.serverInfo === undefined
        ? "the server reported no version"
        : `${status.serverInfo.name ?? "unnamed"} ${status.serverInfo.version ?? "(no version)"}`,
  });

  const total = status.toolCount + status.resourceCount + status.promptCount;
  checks.push({
    name: "capabilities",
    status: total > 0 ? "pass" : "warn",
    detail: `${status.toolCount} tool(s), ${status.resourceCount} resource(s), ${status.promptCount} prompt(s)`,
  });

  // ---- safe probe ----
  const pingStart = now();
  const alive = await input.client.ping();
  const latencyMs = now() - pingStart;
  checks.push({
    name: "probe",
    status: alive ? "pass" : "warn",
    detail: alive ? `round trip in ${latencyMs} ms` : "the server did not answer a ping",
    durationMs: latencyMs,
  });

  if (status.diagnostics.length > 0) {
    checks.push({
      name: "diagnostics",
      status: "warn",
      detail: `${status.diagnostics.length} diagnostic line(s); see 'capy mcp list --verbose'`,
    });
  }

  return finish(input.server, checks, status.revision, latencyMs);
}

function finish(
  server: string,
  checks: DoctorCheck[],
  protocol?: string,
  latencyMs?: number,
): DoctorReport {
  return {
    server,
    checks,
    healthy: !checks.some((check) => check.status === "fail"),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

export function renderDoctorReport(report: DoctorReport): string[] {
  const header = report.healthy
    ? `✓ ${report.server} is healthy`
    : `× ${report.server} has a problem`;
  const lines = [header];

  const width = report.checks.reduce((max, check) => Math.max(max, check.name.length), 0);
  for (const check of report.checks) {
    const icon = { pass: "✓", warn: "!", fail: "×", skip: "-" }[check.status];
    const duration = check.durationMs !== undefined ? ` (${check.durationMs} ms)` : "";
    lines.push(`  ${icon} ${check.name.padEnd(width)}  ${check.detail}${duration}`);
  }
  return lines;
}
