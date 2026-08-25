import type { LspDiagnostic, LspDiagnosticSnapshot } from "@cbc/lsp-domain";
import type { ProposedAction } from "@cbc/permissions";
import { errorResult, okResult } from "@cbc/tool-registry";

import type { LspDiagnosticLookup } from "./lsp-host.ts";
import type { Execution } from "./tools.ts";

const MAX_SERVERS = 8;
const MAX_DIAGNOSTICS = 64;
const MAX_MESSAGE_BYTES = 512;
const MAX_METADATA_BYTES = 128;
const MAX_REVISION_BYTES = 256;
const MAX_TEXT_BYTES = 48 * 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE = /\s+/g;

export interface LspDiagnosticsReader {
  diagnostics(path: string): Promise<LspDiagnosticLookup>;
}

interface ProjectedDiagnostic {
  readonly range: LspDiagnostic["range"];
  readonly severity?: LspDiagnostic["severity"];
  readonly code?: string;
  readonly source?: string;
  readonly message: string;
}

interface ProjectedServer {
  readonly server: string;
  readonly documentRevision: string;
  readonly documentVersion: number;
  readonly publishedAt: string;
  readonly totalDiagnostics: number;
  readonly diagnostics: readonly ProjectedDiagnostic[];
  readonly truncated: boolean;
}

/** A bounded projection suitable for a model tool result, never raw LSP data. */
export interface LspToolDiagnosticsResult {
  readonly schemaVersion: "1.0";
  readonly path: string;
  readonly totalServers: number;
  readonly returnedServers: number;
  readonly truncatedServers: boolean;
  /** Count reported only by the server snapshots returned in this result. */
  readonly diagnosticsInReturnedServers: number;
  readonly returnedDiagnostics: number;
  readonly truncatedDiagnostics: boolean;
  readonly servers: readonly ProjectedServer[];
}

export type LspDiagnosticsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;

/**
 * The host owns freshness. This bridge strips workspace identity and projects
 * only a small, independently bounded diagnostic view into model context.
 */
export function createLspDiagnosticsBridge(reader: LspDiagnosticsReader): LspDiagnosticsBridge {
  return async (action, signal) => {
    if (action.toolId !== "lsp.diagnostics") {
      return { result: errorResult("INVALID_ARGUMENT", "LSP diagnostics bridge received an unsupported tool") };
    }
    const path = lspPath(action);
    if (path === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.diagnostics requires a workspace-relative path without traversal",
        ),
      };
    }
    if (signal.aborted) return cancelledDiagnostics();

    try {
      const lookup = await reader.diagnostics(path);
      if (signal.aborted) return cancelledDiagnostics();
      const diagnostics = projectDiagnostics(path, lookup);
      const summary = diagnostics.returnedServers === 0
        ? "no current LSP diagnostic snapshot is available for " + path
        : String(diagnostics.returnedDiagnostics) + " diagnostic(s) from " +
          String(diagnostics.returnedServers) + " current LSP server snapshot(s)";
      return {
        result: okResult(summary, diagnostics),
        text: renderDiagnostics(diagnostics),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP diagnostics are currently unavailable; retry after the language server has indexed the file",
          { retryable: true },
        ),
      };
    }
  };
}

function cancelledDiagnostics(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP diagnostics request was cancelled", { retryable: true }),
  };
}

function lspPath(action: ProposedAction): string | undefined {
  const raw = action.arguments as Record<string, unknown>;
  const path = raw.path;
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path, "utf8") > 4_096) return undefined;
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    /^[a-z]:/i.test(path) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) return undefined;
  return path;
}

function projectDiagnostics(path: string, lookup: LspDiagnosticLookup): LspToolDiagnosticsResult {
  const rawSnapshots = Array.isArray(lookup.snapshots) ? lookup.snapshots.slice(0, MAX_SERVERS) : [];
  const servers: ProjectedServer[] = [];
  let remaining = MAX_DIAGNOSTICS;
  let diagnosticsInReturnedServers = 0;

  for (const snapshot of rawSnapshots) {
    const server = projectServer(snapshot, remaining);
    if (server === undefined) continue;
    servers.push(server);
    remaining -= server.diagnostics.length;
    diagnosticsInReturnedServers += server.totalDiagnostics;
  }

  const returnedDiagnostics = MAX_DIAGNOSTICS - remaining;
  const reportedServers = boundedCount(lookup.totalServers, servers.length, 4_096);
  const totalServers = Math.max(servers.length, reportedServers);
  return Object.freeze({
    schemaVersion: "1.0" as const,
    path,
    totalServers,
    returnedServers: servers.length,
    truncatedServers: lookup.truncatedServers === true || totalServers > servers.length,
    diagnosticsInReturnedServers,
    returnedDiagnostics,
    truncatedDiagnostics: servers.some((server) => server.truncated) || returnedDiagnostics < diagnosticsInReturnedServers,
    servers: Object.freeze(servers),
  });
}

function projectServer(snapshot: LspDiagnosticSnapshot, remaining: number): ProjectedServer | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const documentRevision = boundedText(snapshot.documentRevision, MAX_REVISION_BYTES);
  const publishedAt = boundedText(snapshot.publishedAt, MAX_METADATA_BYTES);
  const documentVersion = boundedCount(snapshot.documentVersion, 0, Number.MAX_SAFE_INTEGER);
  if (server === undefined || documentRevision === undefined || publishedAt === undefined || documentVersion < 1) return undefined;

  const rawDiagnostics = Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];
  const reported = boundedCount(snapshot.totalDiagnostics, rawDiagnostics.length, 4_096);
  const totalDiagnostics = Math.max(Math.min(rawDiagnostics.length, 4_096), reported);
  const diagnostics: ProjectedDiagnostic[] = [];
  for (const diagnostic of rawDiagnostics) {
    if (diagnostics.length >= remaining) break;
    const projected = projectDiagnostic(diagnostic);
    if (projected !== undefined) diagnostics.push(projected);
  }
  return Object.freeze({
    server,
    documentRevision,
    documentVersion,
    publishedAt,
    totalDiagnostics,
    diagnostics: Object.freeze(diagnostics),
    truncated: snapshot.truncated === true || diagnostics.length < totalDiagnostics,
  });
}

function projectDiagnostic(diagnostic: LspDiagnostic): ProjectedDiagnostic | undefined {
  const start = projectPosition(diagnostic.range?.start);
  const end = projectPosition(diagnostic.range?.end);
  const message = boundedText(diagnostic.message, MAX_MESSAGE_BYTES);
  if (start === undefined || end === undefined || message === undefined) return undefined;
  const code = boundedText(diagnostic.code, MAX_METADATA_BYTES);
  const source = boundedText(diagnostic.source, MAX_METADATA_BYTES);
  const severity = diagnostic.severity;
  return Object.freeze({
    range: Object.freeze({ start: Object.freeze(start), end: Object.freeze(end) }),
    ...(severity === undefined ? {} : { severity }),
    ...(code === undefined ? {} : { code }),
    ...(source === undefined ? {} : { source }),
    message,
  });
}

function projectPosition(value: unknown): { readonly line: number; readonly character: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isPositionComponent(record.line) || !isPositionComponent(record.character)) return undefined;
  return { line: record.line, character: record.character };
}

function isPositionComponent(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedCount(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
  if (normalized.length === 0) return undefined;
  return truncateUtf8(normalized, maxBytes);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "...";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return output + suffix;
}

function renderDiagnostics(diagnostics: LspToolDiagnosticsResult): string {
  if (diagnostics.returnedServers === 0) {
    return "No current LSP diagnostic snapshot is available for " + diagnostics.path +
      "; this does not prove that the file is clean.";
  }
  const lines = [
    "LSP diagnostics for " + diagnostics.path + ": " + String(diagnostics.returnedDiagnostics) +
      " shown from " + String(diagnostics.returnedServers) + " current server snapshot(s).",
  ];
  if (diagnostics.truncatedServers || diagnostics.truncatedDiagnostics) {
    lines.push("[Result is bounded; inspect the structured fields before treating this as exhaustive.]");
  }
  for (const server of diagnostics.servers) {
    lines.push("## " + server.server + " (document v" + String(server.documentVersion) +
      ", " + String(server.totalDiagnostics) + " reported)");
    for (const diagnostic of server.diagnostics) {
      const range = diagnostic.range;
      const location = "L" + String(range.start.line + 1) + ":C" + String(range.start.character + 1);
      const severity = severityLabel(diagnostic.severity);
      const origin = [diagnostic.source, diagnostic.code]
        .filter((value): value is string => value !== undefined)
        .join("/");
      lines.push(location + " " + severity + (origin.length > 0 ? " [" + origin + "]" : "") + ": " + diagnostic.message);
    }
  }
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function severityLabel(value: LspDiagnostic["severity"]): string {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "information";
  return "hint";
}
