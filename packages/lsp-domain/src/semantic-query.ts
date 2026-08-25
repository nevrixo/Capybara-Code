import { assertValidText } from "@cbc/edit-domain";

import type { LspPosition, LspRange } from "./types.ts";
import { workspacePathFromLspUri } from "./workspace-edit.ts";

const UTF8 = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const WHITESPACE = /\s+/g;

const MAX_WORKSPACE_ROOT_BYTES = 32 * 1_024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_POSITION_COMPONENT = 1_000_000;
const MAX_INPUT_LOCATIONS = 4_096;
const MAX_LOCATIONS_PER_QUERY = 256;
const DEFAULT_MAX_LOCATIONS = 64;
const MAX_INPUT_DOCUMENT_HIGHLIGHTS = 4_096;
const MAX_DOCUMENT_HIGHLIGHTS_PER_QUERY = 256;
const DEFAULT_MAX_DOCUMENT_HIGHLIGHTS = 64;
const MAX_HOVER_CONTENT_ITEMS = 64;
const MAX_HOVER_INPUT_BYTES = 64 * 1_024;
const MAX_HOVER_TEXT_BYTES = 8 * 1_024;
const MAX_SIGNATURES = 32;
const MAX_INPUT_SIGNATURES = 256;
const MAX_SIGNATURE_PARAMETERS = 32;
const MAX_INPUT_SIGNATURE_PARAMETERS = 128;
const MAX_SIGNATURE_LABEL_BYTES = 8 * 1_024;
const MAX_PARAMETER_LABEL_BYTES = 2 * 1_024;

export type LspLocationQueryKind =
  | "definition"
  | "declaration"
  | "type_definition"
  | "implementation"
  | "references";

/** Raw query coordinates supplied to the local language server. */
export interface LspSemanticQueryInput {
  readonly path: string;
  readonly line: number;
  readonly character: number;
}

/** Safe, workspace-relative query coordinates that can appear in model context. */
export interface LspSemanticQuerySource {
  readonly path: string;
  readonly position: LspPosition;
}

/** A bounded workspace location reported by a local language server. */
export interface LspSemanticLocation {
  readonly path: string;
  readonly range: LspRange;
}

/**
 * Sanitized definition or reference evidence. Locations are language-server
 * claims, not filesystem-authoritative evidence and may become stale.
 */
export interface LspLocationQuerySnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: LspLocationQueryKind;
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly locations: readonly LspSemanticLocation[];
  readonly totalLocations: number;
  readonly truncated: boolean;
}

/** Sanitized hover text. Markup and marked strings are flattened to display text. */
export interface LspHoverQuerySnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "hover";
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly found: boolean;
  readonly contents?: string;
  readonly range?: LspRange;
  readonly truncated: boolean;
}

/** A display-safe signature and its bounded parameter labels. */
export interface LspSignatureHelpSignature {
  readonly label: string;
  readonly parameters: readonly string[];
}

/** Sanitized signature-help output. Documentation and server metadata are omitted. */
export interface LspSignatureHelpSnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "signature_help";
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly signatures: readonly LspSignatureHelpSignature[];
  readonly totalSignatures: number;
  readonly activeSignature?: number;
  readonly activeParameter?: number;
  readonly truncated: boolean;
}

/** A bounded highlight range in the document that supplied the query position. */
export interface LspDocumentHighlight {
  readonly range: LspRange;
  readonly kind: "text" | "read" | "write";
}

/** Sanitized document-local symbol highlights. Server metadata is omitted. */
export interface LspDocumentHighlightSnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "document_highlights";
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly highlights: readonly LspDocumentHighlight[];
  readonly totalHighlights: number;
  readonly truncated: boolean;
}

export interface NormalizeLspDocumentHighlightQueryOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspSemanticQueryInput;
  /** Lower an output cap; it can never exceed the hard safety bound. */
  readonly maxHighlights?: number;
}

export interface NormalizeLspLocationQueryOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspSemanticQueryInput;
  /** Lower an output cap; it can never exceed the hard safety bound. */
  readonly maxLocations?: number;
}

export interface NormalizeLspHoverQueryOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspSemanticQueryInput;
}

export interface NormalizeLspSignatureHelpQueryOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspSemanticQueryInput;
}

export type LspSemanticQueryErrorCode =
  | "LSP_QUERY_INVALID"
  | "LSP_QUERY_SCOPE_VIOLATION"
  | "LSP_QUERY_LIMIT";

export class LspSemanticQueryDomainError extends Error {
  readonly code: LspSemanticQueryErrorCode;

  constructor(code: LspSemanticQueryErrorCode, message: string) {
    super(message);
    this.name = "LspSemanticQueryDomainError";
    this.code = code;
  }
}

/**
 * Normalize an LSP location-query response into small, immutable
 * workspace-only evidence. This performs no I/O and never preserves server data.
 */
export function normalizeLspLocationQuery(
  kind: LspLocationQueryKind,
  result: unknown,
  options: NormalizeLspLocationQueryOptions,
): LspLocationQuerySnapshot {
  if (
    kind !== "definition" &&
    kind !== "declaration" &&
    kind !== "type_definition" &&
    kind !== "implementation" &&
    kind !== "references"
  ) {
    throw failure("LSP_QUERY_INVALID", "location query kind is unsupported");
  }
  const context = normalizeContext(options);
  const maxLocations = normalizeMaxLocations(options.maxLocations);
  const rawLocations = rawLocationList(result);
  if (rawLocations.length > MAX_INPUT_LOCATIONS) {
    throw failure(
      "LSP_QUERY_LIMIT",
      "location response exceeds the " + String(MAX_INPUT_LOCATIONS) + " item input limit",
    );
  }

  const locations: LspSemanticLocation[] = [];
  for (const rawLocation of rawLocations.slice(0, maxLocations)) {
    locations.push(normalizeLocation(rawLocation, context.workspaceRoot));
  }

  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind,
    server: context.server,
    source: context.source,
    locations: Object.freeze(locations),
    totalLocations: rawLocations.length,
    truncated: rawLocations.length > maxLocations,
  });
}

/**
 * Normalize an LSP hover response into a bounded display-only result. It drops
 * server metadata and treats an empty or null result as no usable hover text.
 */
export function normalizeLspHoverQuery(
  result: unknown,
  options: NormalizeLspHoverQueryOptions,
): LspHoverQuerySnapshot {
  const context = normalizeContext(options);
  if (result === null) {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      kind: "hover" as const,
      server: context.server,
      source: context.source,
      found: false,
      truncated: false,
    });
  }

  const hover = requiredRecord(result, "hover response");
  if (!Object.hasOwn(hover, "contents")) {
    throw failure("LSP_QUERY_INVALID", "hover response requires contents");
  }
  const contents = normalizeHoverContents(hover.contents);
  if (contents.text === undefined) {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      kind: "hover" as const,
      server: context.server,
      source: context.source,
      found: false,
      truncated: contents.truncated,
    });
  }
  const range = hover.range === undefined ? undefined : normalizeRange(hover.range, "hover range");
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "hover" as const,
    server: context.server,
    source: context.source,
    found: true,
    contents: contents.text,
    ...(range === undefined ? {} : { range }),
    truncated: contents.truncated,
  });
}

/**
 * Normalize LSP signature help into bounded display labels. Documentation,
 * commands, and arbitrary server metadata are never preserved.
 */
export function normalizeLspSignatureHelpQuery(
  result: unknown,
  options: NormalizeLspSignatureHelpQueryOptions,
): LspSignatureHelpSnapshot {
  const context = normalizeContext(options);
  if (result === null) {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      kind: "signature_help" as const,
      server: context.server,
      source: context.source,
      signatures: Object.freeze([]),
      totalSignatures: 0,
      truncated: false,
    });
  }

  const raw = requiredRecord(result, "signature help response");
  if (!Array.isArray(raw.signatures)) {
    throw failure("LSP_QUERY_INVALID", "signature help response requires signatures");
  }
  if (raw.signatures.length > MAX_INPUT_SIGNATURES) {
    throw failure(
      "LSP_QUERY_LIMIT",
      "signature help response exceeds the " + String(MAX_INPUT_SIGNATURES) + " signature input limit",
    );
  }

  const normalized = raw.signatures.map((signature, index) =>
    normalizeSignature(signature, "signature " + String(index)),
  );
  const activeSignature = optionalIndex(
    raw.activeSignature,
    "signature help activeSignature",
    normalized.length,
  );
  const activeSignatureIndex = activeSignature ?? 0;
  const activeParameter = raw.activeParameter === undefined
    ? undefined
    : optionalIndex(
      raw.activeParameter,
      "signature help activeParameter",
      normalized[activeSignatureIndex]?.totalParameters ?? 0,
    );

  const visible = normalized.slice(0, MAX_SIGNATURES);
  const visibleActiveSignature =
    activeSignature !== undefined && activeSignature < visible.length ? activeSignature : undefined;
  const visibleActiveParameter =
    activeParameter !== undefined &&
      activeSignatureIndex < visible.length &&
      activeParameter < (visible[activeSignatureIndex]?.signature.parameters.length ?? 0)
      ? activeParameter
      : undefined;
  const truncated =
    raw.signatures.length > MAX_SIGNATURES ||
    normalized.some((signature) => signature.truncated);

  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "signature_help" as const,
    server: context.server,
    source: context.source,
    signatures: Object.freeze(visible.map((signature) => signature.signature)),
    totalSignatures: raw.signatures.length,
    ...(visibleActiveSignature === undefined ? {} : { activeSignature: visibleActiveSignature }),
    ...(visibleActiveParameter === undefined ? {} : { activeParameter: visibleActiveParameter }),
    truncated,
  });
}

/**
 * Normalize document-local symbol highlights into bounded ranges. Highlight
 * ranges are claims from an untrusted server and are scoped to the safe source.
 */
export function normalizeLspDocumentHighlightQuery(
  result: unknown,
  options: NormalizeLspDocumentHighlightQueryOptions,
): LspDocumentHighlightSnapshot {
  const context = normalizeContext(options);
  const maxHighlights = normalizeMaxDocumentHighlights(options.maxHighlights);
  if (result === null) {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      kind: "document_highlights" as const,
      server: context.server,
      source: context.source,
      highlights: Object.freeze([]),
      totalHighlights: 0,
      truncated: false,
    });
  }
  if (!Array.isArray(result)) {
    throw failure("LSP_QUERY_INVALID", "document highlight response must be an array or null");
  }
  if (result.length > MAX_INPUT_DOCUMENT_HIGHLIGHTS) {
    throw failure(
      "LSP_QUERY_LIMIT",
      "document highlight response exceeds the " + String(MAX_INPUT_DOCUMENT_HIGHLIGHTS) + " item input limit",
    );
  }

  const highlights = result
    .slice(0, maxHighlights)
    .map((highlight, index) => normalizeDocumentHighlight(highlight, "document highlight " + String(index)));
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "document_highlights" as const,
    server: context.server,
    source: context.source,
    highlights: Object.freeze(highlights),
    totalHighlights: result.length,
    truncated: result.length > maxHighlights,
  });
}

interface NormalizedContext {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspSemanticQuerySource;
}

function normalizeContext(options: unknown): NormalizedContext {
  const raw = requiredRecord(options, "semantic query options");
  const workspaceRoot = requiredWorkspaceRoot(raw.workspaceRoot);
  const server = requiredStableText(raw.server, "server");
  const source = normalizeSource(raw.source);
  return Object.freeze({ workspaceRoot, server, source });
}

function normalizeSource(value: unknown): LspSemanticQuerySource {
  const raw = requiredRecord(value, "query source");
  const path = normalizeWorkspacePath(raw.path, "query source path");
  const position = normalizePosition(
    { line: raw.line, character: raw.character },
    "query source position",
  );
  return Object.freeze({ path, position });
}

function rawLocationList(value: unknown): readonly unknown[] {
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeLocation(value: unknown, workspaceRoot: string): LspSemanticLocation {
  const raw = requiredRecord(value, "location");
  if (Object.hasOwn(raw, "targetUri")) {
    if (typeof raw.targetUri !== "string") {
      throw failure("LSP_QUERY_INVALID", "location link targetUri must be a string");
    }
    const targetRange = normalizeRange(raw.targetRange, "location link target range");
    const selectionRange = raw.targetSelectionRange === undefined
      ? targetRange
      : normalizeRange(raw.targetSelectionRange, "location link target selection range");
    return Object.freeze({
      path: pathFromUri(raw.targetUri, workspaceRoot),
      range: selectionRange,
    });
  }

  const uri = requiredString(raw, "uri", "location");
  return Object.freeze({
    path: pathFromUri(uri, workspaceRoot),
    range: normalizeRange(raw.range, "location range"),
  });
}

function normalizeDocumentHighlight(value: unknown, label: string): LspDocumentHighlight {
  const raw = requiredRecord(value, label);
  return Object.freeze({
    range: normalizeRange(raw.range, label + " range"),
    kind: normalizeDocumentHighlightKind(raw.kind, label + " kind"),
  });
}

function normalizeDocumentHighlightKind(
  value: unknown,
  label: string,
): LspDocumentHighlight["kind"] {
  if (value === undefined || value === 1) return "text";
  if (value === 2) return "read";
  if (value === 3) return "write";
  throw failure(
    "LSP_QUERY_INVALID",
    label + " must be a supported DocumentHighlightKind number",
  );
}

function normalizeHoverContents(value: unknown): { readonly text: string | undefined; readonly truncated: boolean } {
  const rawItems = Array.isArray(value) ? value : [value];
  if (rawItems.length > MAX_HOVER_CONTENT_ITEMS) {
    throw failure(
      "LSP_QUERY_LIMIT",
      "hover response exceeds the " + String(MAX_HOVER_CONTENT_ITEMS) + " content item limit",
    );
  }

  let inputBytes = 0;
  const items: string[] = [];
  for (const rawItem of rawItems) {
    const item = hoverItemText(rawItem);
    assertBoundedText(item, "hover content", MAX_HOVER_INPUT_BYTES);
    inputBytes += UTF8.encode(item).byteLength;
    if (inputBytes > MAX_HOVER_INPUT_BYTES) {
      throw failure(
        "LSP_QUERY_LIMIT",
        "hover response exceeds the " + String(MAX_HOVER_INPUT_BYTES) + " byte input limit",
      );
    }
    const display = safeDisplayText(item);
    if (display.length > 0) items.push(display);
  }
  if (items.length === 0) return { text: undefined, truncated: false };
  return truncateUtf8(items.join("\n"), MAX_HOVER_TEXT_BYTES);
}

interface NormalizedSignature {
  readonly signature: LspSignatureHelpSignature;
  readonly totalParameters: number;
  readonly truncated: boolean;
}

function normalizeSignature(value: unknown, label: string): NormalizedSignature {
  const raw = requiredRecord(value, label);
  const rawLabel = requiredSignatureLabel(raw.label, label + " label");
  const rawParameters = raw.parameters === undefined
    ? []
    : requiredArray(raw.parameters, label + " parameters");
  if (rawParameters.length > MAX_INPUT_SIGNATURE_PARAMETERS) {
    throw failure(
      "LSP_QUERY_LIMIT",
      label + " exceeds the " + String(MAX_INPUT_SIGNATURE_PARAMETERS) + " parameter input limit",
    );
  }

  const parameters: string[] = [];
  for (const parameter of rawParameters.slice(0, MAX_SIGNATURE_PARAMETERS)) {
    parameters.push(normalizeParameterLabel(parameter, rawLabel, label + " parameter"));
  }
  return Object.freeze({
    signature: Object.freeze({
      label: displayText(rawLabel, label + " label", MAX_SIGNATURE_LABEL_BYTES),
      parameters: Object.freeze(parameters),
    }),
    totalParameters: rawParameters.length,
    truncated: rawParameters.length > MAX_SIGNATURE_PARAMETERS,
  });
}

function normalizeParameterLabel(value: unknown, signatureLabel: string, label: string): string {
  const raw = requiredRecord(value, label);
  if (typeof raw.label === "string") {
    return displayText(raw.label, label + " label", MAX_PARAMETER_LABEL_BYTES);
  }
  if (
    Array.isArray(raw.label) &&
    raw.label.length === 2 &&
    isStringIndex(raw.label[0]) &&
    isStringIndex(raw.label[1]) &&
    raw.label[0] <= raw.label[1] &&
    raw.label[1] <= signatureLabel.length
  ) {
    return displayText(
      signatureLabel.slice(raw.label[0], raw.label[1]),
      label + " label range",
      MAX_PARAMETER_LABEL_BYTES,
    );
  }
  throw failure("LSP_QUERY_INVALID", label + " label must be a string or a signature-label range");
}

function requiredSignatureLabel(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_QUERY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_SIGNATURE_LABEL_BYTES);
  if (safeDisplayText(value).length === 0) {
    throw failure("LSP_QUERY_INVALID", label + " must contain displayable text");
  }
  return value;
}

function displayText(value: string, label: string, maxBytes: number): string {
  assertBoundedText(value, label, maxBytes);
  const display = safeDisplayText(value);
  if (display.length === 0) {
    throw failure("LSP_QUERY_INVALID", label + " must contain displayable text");
  }
  return display;
}

function optionalIndex(value: unknown, label: string, upperExclusive: number): number | undefined {
  if (value === undefined) return undefined;
  if (!isStringIndex(value) || value >= upperExclusive) {
    throw failure("LSP_QUERY_INVALID", label + " must be a valid returned index");
  }
  return value;
}

function isStringIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw failure("LSP_QUERY_INVALID", label + " must be an array");
  return value;
}

function hoverItemText(value: unknown): string {
  if (typeof value === "string") return value;
  const raw = requiredRecord(value, "hover content");
  if (typeof raw.value !== "string") {
    throw failure("LSP_QUERY_INVALID", "hover content must be a string or marked string");
  }
  if (
    raw.kind !== undefined &&
    raw.kind !== "plaintext" &&
    raw.kind !== "markdown"
  ) {
    throw failure("LSP_QUERY_INVALID", "hover markup kind is unsupported");
  }
  if (raw.language !== undefined) {
    if (typeof raw.language !== "string") {
      throw failure("LSP_QUERY_INVALID", "hover marked-string language must be a string");
    }
    assertBoundedText(raw.language, "hover marked-string language", MAX_IDENTIFIER_BYTES);
  }
  return raw.value;
}

function normalizeRange(value: unknown, label: string): LspRange {
  const raw = requiredRecord(value, label);
  const start = normalizePosition(raw.start, label + " start");
  const end = normalizePosition(raw.end, label + " end");
  if (comparePositions(start, end) > 0) {
    throw failure("LSP_QUERY_INVALID", label + " end must not precede its start");
  }
  return Object.freeze({ start, end });
}

function normalizePosition(value: unknown, label: string): LspPosition {
  const raw = requiredRecord(value, label);
  if (!isPositionComponent(raw.line) || !isPositionComponent(raw.character)) {
    throw failure(
      "LSP_QUERY_INVALID",
      label + " must use zero-based non-negative integer line and character values",
    );
  }
  return Object.freeze({ line: raw.line, character: raw.character });
}

function comparePositions(left: LspPosition, right: LspPosition): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
}

function isPositionComponent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_POSITION_COMPONENT
  );
}

function normalizeMaxLocations(value: unknown): number {
  const maxLocations = value === undefined ? DEFAULT_MAX_LOCATIONS : value;
  if (
    typeof maxLocations !== "number" ||
    !Number.isSafeInteger(maxLocations) ||
    maxLocations < 1 ||
    maxLocations > MAX_LOCATIONS_PER_QUERY
  ) {
    throw failure(
      "LSP_QUERY_LIMIT",
      "maxLocations must be a positive safe integer up to " + String(MAX_LOCATIONS_PER_QUERY),
    );
  }
  return maxLocations;
}

function normalizeMaxDocumentHighlights(value: unknown): number {
  const maxHighlights = value === undefined ? DEFAULT_MAX_DOCUMENT_HIGHLIGHTS : value;
  if (
    typeof maxHighlights !== "number" ||
    !Number.isSafeInteger(maxHighlights) ||
    maxHighlights < 1 ||
    maxHighlights > MAX_DOCUMENT_HIGHLIGHTS_PER_QUERY
  ) {
    throw failure(
      "LSP_QUERY_LIMIT",
      "maxHighlights must be a positive safe integer up to " + String(MAX_DOCUMENT_HIGHLIGHTS_PER_QUERY),
    );
  }
  return maxHighlights;
}

function requiredWorkspaceRoot(value: unknown): string {
  if (typeof value !== "string") {
    throw failure("LSP_QUERY_INVALID", "workspaceRoot must be a string");
  }
  assertBoundedText(value, "workspaceRoot", MAX_WORKSPACE_ROOT_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_QUERY_INVALID", "workspaceRoot must be non-empty non-control text");
  }
  return value;
}

function requiredStableText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_QUERY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_IDENTIFIER_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_QUERY_INVALID", label + " must be stable non-control text");
  }
  return value;
}

function normalizeWorkspacePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_QUERY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_PATH_BYTES);
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    UNSAFE_CONTROL_CHARACTERS.test(value) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw failure("LSP_QUERY_SCOPE_VIOLATION", label + " must remain workspace-relative");
  }
  return value;
}

function pathFromUri(uri: string, workspaceRoot: string): string {
  try {
    return workspacePathFromLspUri(uri, workspaceRoot);
  } catch {
    throw failure("LSP_QUERY_SCOPE_VIOLATION", "location URI must be a file inside the workspace");
  }
}

function assertBoundedText(value: string, label: string, maxBytes: number): void {
  try {
    assertValidText(value);
  } catch {
    throw failure("LSP_QUERY_INVALID", label + " must be valid UTF-8 text");
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw failure("LSP_QUERY_LIMIT", label + " exceeds " + String(maxBytes) + " UTF-8 bytes");
  }
}

function safeDisplayText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (UTF8.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
  const suffix = "...";
  const budget = maxBytes - UTF8.encode(suffix).byteLength;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = UTF8.encode(character).byteLength;
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return { text: output + suffix, truncated: true };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw failure("LSP_QUERY_INVALID", label + " must be an object");
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw failure("LSP_QUERY_INVALID", label + " requires " + key);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: LspSemanticQueryErrorCode, message: string): LspSemanticQueryDomainError {
  return new LspSemanticQueryDomainError(code, message);
}
