import { assertValidText, rangeToByteRange } from "@cbc/edit-domain";
import type { LspEditDocument, LspPosition, LspRange } from "./types.ts";
import { workspacePathFromLspUri } from "./workspace-edit.ts";

const UTF8 = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE = /\s+/g;

const MAX_INPUT_DIAGNOSTICS = 4_096;
const MAX_DIAGNOSTICS_PER_SNAPSHOT = 256;
const DEFAULT_MAX_DIAGNOSTICS = 128;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4_096;
const MAX_DIAGNOSTIC_METADATA_BYTES = 256;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_WORKSPACE_ROOT_BYTES = 32 * 1_024;

export type LspDiagnosticSeverity = 1 | 2 | 3 | 4;

/**
 * Bounded diagnostic data suitable for display or model context. Deliberately
 * excludes LSP data, code descriptions, and related information because they
 * are unbounded server-controlled payloads.
 */
export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: LspDiagnosticSeverity;
  readonly code?: string;
  readonly source?: string;
  readonly message: string;
}

/**
 * Revision-bound evidence emitted only after an exact LSP document-version
 * match. Consumers must still compare documentRevision with a fresh
 * runtime-owned read before treating the snapshot as current.
 */
export interface LspDiagnosticSnapshot {
  readonly schemaVersion: "1.0";
  readonly server: string;
  readonly workspaceIdentityDigest: string;
  readonly path: string;
  readonly documentRevision: string;
  readonly documentVersion: number;
  readonly publishedAt: string;
  readonly diagnostics: readonly LspDiagnostic[];
  readonly totalDiagnostics: number;
  readonly truncated: boolean;
}

/**
 * The supplied document must be the exact runtime snapshot whose text was sent
 * to the language server under documentVersion; do not substitute a later read.
 */
export interface NormalizeLspDiagnosticsOptions {
  readonly workspaceRoot: string;
  readonly workspaceIdentityDigest: string;
  readonly server: string;
  readonly document: LspEditDocument;
  readonly documentVersion: number;
  readonly publishedAt: string;
  /** Lower a snapshot's output cap; it can never exceed the hard safety bound. */
  readonly maxDiagnostics?: number;
}

/** Options for a capability-gated textDocument/diagnostic response. */
export interface NormalizeLspPullDiagnosticsOptions extends NormalizeLspDiagnosticsOptions {
  /** Runtime-generated URI for the exact document sent to the server. */
  readonly uri: string;
}

export type LspDiagnosticErrorCode =
  | "LSP_DIAGNOSTICS_INVALID"
  | "LSP_DIAGNOSTICS_SCOPE_VIOLATION"
  | "LSP_DIAGNOSTICS_STALE"
  | "LSP_DIAGNOSTICS_LIMIT";

export class LspDiagnosticDomainError extends Error {
  readonly code: LspDiagnosticErrorCode;
  readonly path: string | undefined;

  constructor(code: LspDiagnosticErrorCode, message: string, options: { readonly path?: string } = {}) {
    super(message);
    this.name = "LspDiagnosticDomainError";
    this.code = code;
    this.path = options.path;
  }
}

/**
 * Validate a raw textDocument/publishDiagnostics notification into bounded,
 * immutable, workspace- and revision-bound evidence. This performs no I/O.
 */
export function normalizeLspDiagnostics(
  params: unknown,
  options: NormalizeLspDiagnosticsOptions,
): LspDiagnosticSnapshot {
  const workspaceRoot = requiredWorkspaceRoot(options.workspaceRoot);
  const workspaceIdentityDigest = requiredStableText(
    options.workspaceIdentityDigest,
    "workspaceIdentityDigest",
  );
  const server = requiredStableText(options.server, "server");
  const document = normalizeDocument(options.document);
  const documentVersion = requireDocumentVersion(options.documentVersion);
  const publishedAt = normalizePublishedAt(options.publishedAt);
  const maxDiagnostics = normalizeMaxDiagnostics(options.maxDiagnostics);

  const notification = requiredRecord(params, "publishDiagnostics params");
  const path = pathFromUri(requiredString(notification, "uri"), workspaceRoot);
  if (path !== document.path) {
    throw failure(
      "LSP_DIAGNOSTICS_STALE",
      "diagnostic URI does not match the exact document snapshot",
      path,
    );
  }

  const version = notification.version;
  if (!isDocumentVersion(version) || version !== documentVersion) {
    throw failure(
      "LSP_DIAGNOSTICS_STALE",
      "diagnostics must carry the exact version of the opened document",
      path,
    );
  }

  const rawDiagnostics = notification.diagnostics;
  if (!Array.isArray(rawDiagnostics)) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostics must be an array", path);
  }
  if (rawDiagnostics.length > MAX_INPUT_DIAGNOSTICS) {
    throw failure(
      "LSP_DIAGNOSTICS_LIMIT",
      "diagnostics exceed the " + MAX_INPUT_DIAGNOSTICS + " input safety limit",
      path,
    );
  }

  const diagnostics: LspDiagnostic[] = [];
  for (const rawDiagnostic of rawDiagnostics.slice(0, maxDiagnostics)) {
    diagnostics.push(normalizeDiagnostic(rawDiagnostic, document));
  }

  return Object.freeze({
    schemaVersion: "1.0" as const,
    server,
    workspaceIdentityDigest,
    path,
    documentRevision: document.revision,
    documentVersion,
    publishedAt,
    diagnostics: Object.freeze(diagnostics),
    totalDiagnostics: rawDiagnostics.length,
    truncated: rawDiagnostics.length > maxDiagnostics,
  });
}

/**
 * Normalize a capability-gated textDocument/diagnostic response into the same
 * revision-bound evidence contract as push diagnostics. Unchanged reports carry
 * no fresh diagnostic items and therefore yield no new snapshot.
 */
export function normalizeLspPullDiagnostics(
  result: unknown,
  options: NormalizeLspPullDiagnosticsOptions,
): LspDiagnosticSnapshot | undefined {
  const report = requiredRecord(result, "pull diagnostic report");
  if (report.kind === "unchanged") return undefined;
  if (report.kind !== "full") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "pull diagnostic report kind must be full or unchanged");
  }
  if (!Array.isArray(report.items)) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "full pull diagnostic report requires items");
  }
  return normalizeLspDiagnostics(
    {
      uri: options.uri,
      version: options.documentVersion,
      diagnostics: report.items,
    },
    options,
  );
}

function normalizeDocument(value: LspEditDocument): LspEditDocument {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.text !== "string" || typeof value.revision !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "document must be an exact LSP document snapshot");
  }
  const path = requiredStableText(value.path, "document path");
  const revision = requiredStableText(value.revision, "document revision");
  try {
    assertValidText(value.text, path);
  } catch {
    throw failure("LSP_DIAGNOSTICS_INVALID", "document text must be valid UTF-8 text", path);
  }
  return { path, text: value.text, revision };
}

function normalizeDiagnostic(value: unknown, document: LspEditDocument): LspDiagnostic {
  const raw = requiredRecord(value, "diagnostic", document.path);
  const range = normalizeRange(raw.range, document);
  const severity = normalizeSeverity(raw.severity, document.path);
  const code = normalizeCode(raw.code, document.path);
  const source = normalizeOptionalMetadata(raw.source, "source", document.path);
  const message = normalizeMessage(raw.message, document.path);

  return Object.freeze({
    range,
    ...(severity === undefined ? {} : { severity }),
    ...(code === undefined ? {} : { code }),
    ...(source === undefined ? {} : { source }),
    message,
  });
}

function normalizeRange(value: unknown, document: LspEditDocument): LspRange {
  const raw = requiredRecord(value, "diagnostic range", document.path);
  const start = normalizePosition(raw.start, document.path);
  const end = normalizePosition(raw.end, document.path);
  try {
    rangeToByteRange(document.text, {
      start: { line: start.line + 1, column: start.character + 1 },
      end: { line: end.line + 1, column: end.character + 1 },
      encoding: "utf16",
    });
  } catch {
    throw failure(
      "LSP_DIAGNOSTICS_INVALID",
      "diagnostic range must be within the exact document's UTF-16 boundaries",
      document.path,
    );
  }
  return Object.freeze({ start: Object.freeze(start), end: Object.freeze(end) });
}

function normalizePosition(value: unknown, path: string): LspPosition {
  const raw = requiredRecord(value, "diagnostic position", path);
  if (!isPositionComponent(raw.line) || !isPositionComponent(raw.character)) {
    throw failure(
      "LSP_DIAGNOSTICS_INVALID",
      "diagnostic positions must be zero-based non-negative safe integers",
      path,
    );
  }
  return { line: raw.line, character: raw.character };
}

function normalizeSeverity(value: unknown, path: string): LspDiagnosticSeverity | undefined {
  if (value === undefined) return undefined;
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic severity must be between 1 and 4", path);
}

function normalizeCode(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic code number must be a safe integer", path);
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic code must be a string or integer", path);
  }
  return normalizedMetadata(value, "code", path);
}

function normalizeOptionalMetadata(value: unknown, label: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic " + label + " must be a string", path);
  }
  return normalizedMetadata(value, label, path);
}

function normalizedMetadata(value: string, label: string, path: string): string {
  assertBoundedText(value, label, MAX_DIAGNOSTIC_METADATA_BYTES, path);
  const normalized = safeDisplayText(value);
  if (normalized.length === 0) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic " + label + " must not be blank", path);
  }
  return normalized;
}

function normalizeMessage(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic message must be a string", path);
  }
  assertBoundedText(value, "message", MAX_DIAGNOSTIC_MESSAGE_BYTES, path);
  const normalized = safeDisplayText(value);
  if (normalized.length === 0) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostic message must not be blank", path);
  }
  return normalized;
}

function normalizeMaxDiagnostics(value: number | undefined): number {
  const maxDiagnostics = value ?? DEFAULT_MAX_DIAGNOSTICS;
  if (
    !Number.isSafeInteger(maxDiagnostics) ||
    maxDiagnostics < 1 ||
    maxDiagnostics > MAX_DIAGNOSTICS_PER_SNAPSHOT
  ) {
    throw failure(
      "LSP_DIAGNOSTICS_LIMIT",
      "maxDiagnostics must be a positive safe integer up to " + MAX_DIAGNOSTICS_PER_SNAPSHOT,
    );
  }
  return maxDiagnostics;
}

function normalizePublishedAt(value: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "publishedAt must be an ISO-8601 timestamp");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "publishedAt must be a canonical ISO-8601 timestamp");
  }
  return value;
}

function requiredWorkspaceRoot(value: unknown): string {
  if (typeof value !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", "workspaceRoot must be a string");
  }
  assertBoundedText(value, "workspaceRoot", MAX_WORKSPACE_ROOT_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "workspaceRoot must be non-empty non-control text");
  }
  return value;
}

function requiredStableText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_DIAGNOSTICS_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_IDENTIFIER_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_DIAGNOSTICS_INVALID", label + " must be stable non-control text");
  }
  return value;
}

function assertBoundedText(value: string, label: string, maxBytes: number, path?: string): void {
  try {
    assertValidText(value, path);
  } catch {
    throw failure("LSP_DIAGNOSTICS_INVALID", label + " must be valid UTF-8 text", path);
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw failure("LSP_DIAGNOSTICS_LIMIT", label + " exceeds " + maxBytes + " UTF-8 bytes", path);
  }
}

function safeDisplayText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
}

function requiredRecord(value: unknown, label: string, path?: string): Record<string, unknown> {
  if (!isRecord(value)) throw failure("LSP_DIAGNOSTICS_INVALID", label + " must be an object", path);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "diagnostics require " + key);
  }
  return value;
}

function pathFromUri(uri: string, workspaceRoot: string): string {
  try {
    return workspacePathFromLspUri(uri, workspaceRoot);
  } catch {
    throw failure("LSP_DIAGNOSTICS_SCOPE_VIOLATION", "diagnostic URI must be a file inside the workspace");
  }
}

function requireDocumentVersion(value: number): number {
  if (!isDocumentVersion(value)) {
    throw failure("LSP_DIAGNOSTICS_INVALID", "documentVersion must be a non-negative safe integer");
  }
  return value;
}

function isDocumentVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositionComponent(value: unknown): value is number {
  return isDocumentVersion(value) && value < Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: LspDiagnosticErrorCode, message: string, path?: string): LspDiagnosticDomainError {
  return new LspDiagnosticDomainError(code, message, path === undefined ? {} : { path });
}
