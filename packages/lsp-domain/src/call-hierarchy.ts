import { assertValidText } from "@cbc/edit-domain";

import type { LspPosition, LspRange } from "./types.ts";
import { workspacePathFromLspUri } from "./workspace-edit.ts";

const UTF8 = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const WHITESPACE = /\s+/g;

const MAX_WORKSPACE_ROOT_BYTES = 32 * 1_024;
const MAX_SERVER_BYTES = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_ITEM_NAME_BYTES = 1_024;
const MAX_ITEM_DETAIL_BYTES = 2 * 1_024;
const MAX_POSITION_COMPONENT = 1_000_000;
const MAX_INPUT_CALLS = 256;
const MAX_PAGE_OFFSET = MAX_INPUT_CALLS;
const MAX_PAGE_LIMIT = 32;
const DEFAULT_PAGE_LIMIT = 16;
const MAX_RANGES_PER_CALL = 32;
const MAX_SYMBOL_KIND = 26;

export type LspCallHierarchyDirection = "incoming" | "outgoing";

/** Raw workspace coordinates used for one call-hierarchy lookup. */
export interface LspCallHierarchyQueryInput {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly direction: LspCallHierarchyDirection;
}

/** Safe source coordinates that may be returned to model context. */
export interface LspCallHierarchyQuerySource {
  readonly path: string;
  readonly position: LspPosition;
  readonly direction: LspCallHierarchyDirection;
}

/** A workspace-only CallHierarchyItem with opaque server data removed. */
export interface LspCallHierarchyItem {
  readonly name: string;
  readonly kind: number;
  readonly path: string;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly detail?: string;
}

/** One incoming or outgoing call edge, with its source-side ranges. */
export interface LspCallHierarchyCall {
  readonly item: LspCallHierarchyItem;
  readonly fromRanges: readonly LspRange[];
}

/** A bounded, paged, display-safe call-hierarchy result. */
export interface LspCallHierarchySnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "call_hierarchy";
  readonly server: string;
  readonly source: LspCallHierarchyQuerySource;
  readonly root?: LspCallHierarchyItem;
  readonly offset: number;
  readonly limit: number;
  readonly totalCalls: number;
  readonly returnedCalls: number;
  readonly calls: readonly LspCallHierarchyCall[];
  readonly truncated: boolean;
}

export interface NormalizeLspCallHierarchyQueryOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspCallHierarchyQueryInput;
  /** Zero-based page offset. It is deliberately bounded before server output is projected. */
  readonly offset?: number;
  /** Maximum number of call edges to expose in this page. */
  readonly limit?: number;
}

export type LspCallHierarchyDomainErrorCode =
  | "LSP_CALL_HIERARCHY_INVALID"
  | "LSP_CALL_HIERARCHY_SCOPE_VIOLATION"
  | "LSP_CALL_HIERARCHY_LIMIT";

export class LspCallHierarchyDomainError extends Error {
  readonly code: LspCallHierarchyDomainErrorCode;

  constructor(code: LspCallHierarchyDomainErrorCode, message: string) {
    super(message);
    this.name = "LspCallHierarchyDomainError";
    this.code = code;
  }
}

/**
 * Normalize the results of prepareCallHierarchy followed by one direction
 * request. Opaque server data, arbitrary URIs, tags, and documentation never
 * cross this boundary.
 */
export function normalizeLspCallHierarchyQuery(
  root: unknown | undefined,
  result: unknown,
  options: NormalizeLspCallHierarchyQueryOptions,
): LspCallHierarchySnapshot {
  const context = normalizeContext(options);
  const page = normalizePage(options);
  const rawCalls = rawCallList(result);
  if (rawCalls.length > MAX_INPUT_CALLS) {
    throw failure(
      "LSP_CALL_HIERARCHY_LIMIT",
      "call hierarchy response exceeds the " + String(MAX_INPUT_CALLS) + " call input limit",
    );
  }

  const normalizedRoot =
    root === undefined
      ? undefined
      : normalizeCallHierarchyItem(root, "prepared call hierarchy item", context.workspaceRoot);
  if (normalizedRoot === undefined && rawCalls.length > 0) {
    throw failure(
      "LSP_CALL_HIERARCHY_INVALID",
      "call hierarchy response cannot contain calls without a prepared item",
    );
  }

  const pageItems = rawCalls.slice(page.offset, page.offset + page.limit);
  const calls = pageItems.map((call, index) =>
    normalizeCall(call, context.source.direction, context.workspaceRoot, page.offset + index),
  );
  const returnedCalls = calls.length;
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "call_hierarchy" as const,
    server: context.server,
    source: context.source,
    ...(normalizedRoot === undefined ? {} : { root: normalizedRoot }),
    offset: page.offset,
    limit: page.limit,
    totalCalls: rawCalls.length,
    returnedCalls,
    calls: Object.freeze(calls),
    truncated: page.offset + returnedCalls < rawCalls.length,
  });
}

interface NormalizedContext {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspCallHierarchyQuerySource;
}

interface Page {
  readonly offset: number;
  readonly limit: number;
}

function normalizeContext(options: unknown): NormalizedContext {
  const raw = requiredRecord(options, "call hierarchy options");
  const workspaceRoot = requiredWorkspaceRoot(raw.workspaceRoot);
  const server = requiredStableText(raw.server, "server", MAX_SERVER_BYTES);
  const source = normalizeSource(raw.source);
  return Object.freeze({ workspaceRoot, server, source });
}

function normalizeSource(value: unknown): LspCallHierarchyQuerySource {
  const raw = requiredRecord(value, "call hierarchy source");
  const path = normalizeWorkspacePath(raw.path, "call hierarchy source path");
  const position = normalizePosition(
    { line: raw.line, character: raw.character },
    "call hierarchy source position",
  );
  if (raw.direction !== "incoming" && raw.direction !== "outgoing") {
    throw failure("LSP_CALL_HIERARCHY_INVALID", "call hierarchy direction must be incoming or outgoing");
  }
  return Object.freeze({ path, position, direction: raw.direction });
}

function normalizePage(options: unknown): Page {
  const raw = requiredRecord(options, "call hierarchy options");
  const offset = raw.offset === undefined ? 0 : raw.offset;
  const limit = raw.limit === undefined ? DEFAULT_PAGE_LIMIT : raw.limit;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_PAGE_OFFSET
  ) {
    throw failure(
      "LSP_CALL_HIERARCHY_LIMIT",
      "call hierarchy offset must be a non-negative safe integer up to " + String(MAX_PAGE_OFFSET),
    );
  }
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_LIMIT
  ) {
    throw failure(
      "LSP_CALL_HIERARCHY_LIMIT",
      "call hierarchy limit must be a positive safe integer up to " + String(MAX_PAGE_LIMIT),
    );
  }
  return Object.freeze({ offset, limit });
}

function rawCallList(value: unknown): readonly unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", "call hierarchy response must be an array or null");
  }
  return value;
}

function normalizeCall(
  value: unknown,
  direction: LspCallHierarchyDirection,
  workspaceRoot: string,
  index: number,
): LspCallHierarchyCall {
  const raw = requiredRecord(value, "call hierarchy call " + String(index));
  const itemKey = direction === "incoming" ? "from" : "to";
  const item = normalizeCallHierarchyItem(
    raw[itemKey],
    "call hierarchy call " + String(index) + " " + itemKey,
    workspaceRoot,
  );
  const rawRanges = requiredArray(
    raw.fromRanges,
    "call hierarchy call " + String(index) + " fromRanges",
  );
  if (rawRanges.length > MAX_RANGES_PER_CALL) {
    throw failure(
      "LSP_CALL_HIERARCHY_LIMIT",
      "call hierarchy call " + String(index) + " exceeds the " +
        String(MAX_RANGES_PER_CALL) + " range input limit",
    );
  }
  const fromRanges = rawRanges.map((range, rangeIndex) =>
    normalizeRange(
      range,
      "call hierarchy call " + String(index) + " fromRanges " + String(rangeIndex),
    ),
  );
  return Object.freeze({
    item,
    fromRanges: Object.freeze(fromRanges),
  });
}

function normalizeCallHierarchyItem(
  value: unknown,
  label: string,
  workspaceRoot: string,
): LspCallHierarchyItem {
  const raw = requiredRecord(value, label);
  const name = displayText(requiredString(raw, "name", label), label + " name", MAX_ITEM_NAME_BYTES);
  const kind = raw.kind;
  if (
    typeof kind !== "number" ||
    !Number.isSafeInteger(kind) ||
    kind < 1 ||
    kind > MAX_SYMBOL_KIND
  ) {
    throw failure(
      "LSP_CALL_HIERARCHY_INVALID",
      label + " kind must be an LSP SymbolKind number",
    );
  }
  const path = pathFromUri(requiredString(raw, "uri", label), workspaceRoot);
  const range = normalizeRange(raw.range, label + " range");
  const selectionRange = normalizeRange(raw.selectionRange, label + " selectionRange");
  const detail =
    raw.detail === undefined
      ? undefined
      : optionalDisplayText(raw.detail, label + " detail", MAX_ITEM_DETAIL_BYTES);
  return Object.freeze({
    name,
    kind,
    path,
    range,
    selectionRange,
    ...(detail === undefined ? {} : { detail }),
  });
}

function normalizeRange(value: unknown, label: string): LspRange {
  const raw = requiredRecord(value, label);
  const start = normalizePosition(raw.start, label + " start");
  const end = normalizePosition(raw.end, label + " end");
  if (comparePositions(start, end) > 0) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " end must not precede its start");
  }
  return Object.freeze({ start, end });
}

function normalizePosition(value: unknown, label: string): LspPosition {
  const raw = requiredRecord(value, label);
  if (!isPositionComponent(raw.line) || !isPositionComponent(raw.character)) {
    throw failure(
      "LSP_CALL_HIERARCHY_INVALID",
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

function requiredWorkspaceRoot(value: unknown): string {
  if (typeof value !== "string") {
    throw failure("LSP_CALL_HIERARCHY_INVALID", "workspaceRoot must be a string");
  }
  assertBoundedText(value, "workspaceRoot", MAX_WORKSPACE_ROOT_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", "workspaceRoot must be non-empty non-control text");
  }
  return value;
}

function requiredStableText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, maxBytes);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be stable non-control text");
  }
  return value;
}

function normalizeWorkspacePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be a string");
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
    throw failure("LSP_CALL_HIERARCHY_SCOPE_VIOLATION", label + " must remain workspace-relative");
  }
  return value;
}

function pathFromUri(uri: string, workspaceRoot: string): string {
  try {
    return workspacePathFromLspUri(uri, workspaceRoot);
  } catch {
    throw failure("LSP_CALL_HIERARCHY_SCOPE_VIOLATION", "call hierarchy URI must be a file inside the workspace");
  }
}

function displayText(value: string, label: string, maxBytes: number): string {
  assertBoundedText(value, label, maxBytes);
  const display = value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
  if (display.length === 0) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must contain visible text");
  }
  return display;
}

function optionalDisplayText(value: unknown, label: string, maxBytes: number): string | undefined {
  if (typeof value !== "string") {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, maxBytes);
  const display = value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
  return display.length === 0 ? undefined : display;
}

function assertBoundedText(value: string, label: string, maxBytes: number): void {
  try {
    assertValidText(value);
  } catch {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be valid UTF-8 text");
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw failure(
      "LSP_CALL_HIERARCHY_LIMIT",
      label + " exceeds " + String(maxBytes) + " UTF-8 bytes",
    );
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be an object");
  }
  return value;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " must be an array");
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw failure("LSP_CALL_HIERARCHY_INVALID", label + " requires " + key);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: LspCallHierarchyDomainErrorCode,
  message: string,
): LspCallHierarchyDomainError {
  return new LspCallHierarchyDomainError(code, message);
}
