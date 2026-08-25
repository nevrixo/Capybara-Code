import { assertValidText } from "@cbc/edit-domain";

import type { LspPosition, LspRange } from "./types.ts";
import { workspacePathFromLspUri } from "./workspace-edit.ts";

const UTF8 = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const WHITESPACE = /\s+/g;

const MAX_WORKSPACE_ROOT_BYTES = 32 * 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_SERVER_BYTES = 256;
const MAX_QUERY_BYTES = 512;
const MAX_SYMBOL_NAME_BYTES = 512;
const MAX_INPUT_SYMBOLS = 4_096;
const MAX_SYMBOLS = 256;
const DEFAULT_MAX_SYMBOLS = 64;
const MAX_SYMBOL_DEPTH = 32;
const MAX_POSITION_COMPONENT = 1_000_000;

export type LspDocumentSymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enum_member"
  | "struct"
  | "event"
  | "operator"
  | "type_parameter"
  | "unknown";

/** A bounded document symbol with no server-owned metadata. */
export interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: LspDocumentSymbolKind;
  readonly range: LspRange;
  readonly selectionRange?: LspRange;
  readonly containerName?: string;
}

/** Safe document-symbol evidence for a single workspace-relative document. */
export interface LspDocumentSymbolsSnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "symbols";
  readonly server: string;
  readonly path: string;
  readonly symbols: readonly LspDocumentSymbol[];
  readonly totalSymbols: number;
  readonly truncated: boolean;
}

export interface NormalizeLspDocumentSymbolsOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly path: string;
  /** Lower an output cap; it can never exceed the hard safety bound. */
  readonly maxSymbols?: number;
}

/** A bounded workspace symbol with an explicit workspace-relative location. */
export interface LspWorkspaceSymbol {
  readonly name: string;
  readonly kind: LspDocumentSymbolKind;
  readonly path: string;
  readonly range: LspRange;
  readonly containerName?: string;
}

/** Safe workspace-symbol evidence returned by a single language server. */
export interface LspWorkspaceSymbolsSnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "workspace_symbols";
  readonly server: string;
  readonly query: string;
  readonly symbols: readonly LspWorkspaceSymbol[];
  readonly totalSymbols: number;
  readonly truncated: boolean;
}

export interface NormalizeLspWorkspaceSymbolsOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly query: string;
  /** Lower an output cap; it can never exceed the hard safety bound. */
  readonly maxSymbols?: number;
}

export type LspSymbolQueryErrorCode =
  | "LSP_SYMBOL_QUERY_INVALID"
  | "LSP_SYMBOL_QUERY_SCOPE_VIOLATION"
  | "LSP_SYMBOL_QUERY_LIMIT";

export class LspSymbolQueryDomainError extends Error {
  readonly code: LspSymbolQueryErrorCode;

  constructor(code: LspSymbolQueryErrorCode, message: string) {
    super(message);
    this.name = "LspSymbolQueryDomainError";
    this.code = code;
  }
}

/**
 * Normalize DocumentSymbol or SymbolInformation responses into bounded,
 * document-local evidence. This performs no I/O and discards arbitrary data.
 */
export function normalizeLspDocumentSymbolQuery(
  result: unknown,
  options: NormalizeLspDocumentSymbolsOptions,
): LspDocumentSymbolsSnapshot {
  const context = normalizeContext(options);
  if (result === null) return emptySnapshot(context);
  const rawSymbols = requiredArray(result, "document symbol response");
  if (rawSymbols.length > MAX_INPUT_SYMBOLS) {
    throw failure(
      "LSP_SYMBOL_QUERY_LIMIT",
      "document symbol response exceeds the " + String(MAX_INPUT_SYMBOLS) + " item input limit",
    );
  }

  const maxSymbols = normalizeMaxSymbols(options.maxSymbols);
  const pending: Array<{ readonly value: unknown; readonly parentName?: string; readonly depth: number }> = [];
  for (let index = rawSymbols.length - 1; index >= 0; index -= 1) {
    pending.push({ value: rawSymbols[index], depth: 0 });
  }

  const symbols: LspDocumentSymbol[] = [];
  let totalSymbols = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_SYMBOL_DEPTH) {
      throw failure(
        "LSP_SYMBOL_QUERY_LIMIT",
        "document symbol response exceeds the " + String(MAX_SYMBOL_DEPTH) + " nesting limit",
      );
    }
    const raw = requiredRecord(current.value, "document symbol");
    totalSymbols += 1;
    if (totalSymbols > MAX_INPUT_SYMBOLS) {
      throw failure(
        "LSP_SYMBOL_QUERY_LIMIT",
        "document symbol response exceeds the " + String(MAX_INPUT_SYMBOLS) + " item input limit",
      );
    }

    const symbol = normalizeSymbol(raw, current.parentName, context);
    if (symbols.length < maxSymbols) symbols.push(symbol);

    if (raw.children !== undefined) {
      const children = requiredArray(raw.children, "document symbol children");
      if (pending.length + children.length > MAX_INPUT_SYMBOLS) {
        throw failure(
          "LSP_SYMBOL_QUERY_LIMIT",
          "document symbol response exceeds the " + String(MAX_INPUT_SYMBOLS) + " item input limit",
        );
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: children[index],
          parentName: symbol.name,
          depth: current.depth + 1,
        });
      }
    }
  }

  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "symbols" as const,
    server: context.server,
    path: context.path,
    symbols: Object.freeze(symbols),
    totalSymbols,
    truncated: totalSymbols > maxSymbols,
  });
}

/**
 * Normalize resolved SymbolInformation or WorkspaceSymbol responses into
 * bounded workspace evidence. Unresolved or external locations are rejected.
 */
export function normalizeLspWorkspaceSymbolQuery(
  result: unknown,
  options: NormalizeLspWorkspaceSymbolsOptions,
): LspWorkspaceSymbolsSnapshot {
  const context = normalizeWorkspaceSymbolContext(options);
  if (result === null) return emptyWorkspaceSymbolsSnapshot(context);
  const rawSymbols = requiredArray(result, "workspace symbol response");
  if (rawSymbols.length > MAX_INPUT_SYMBOLS) {
    throw failure(
      "LSP_SYMBOL_QUERY_LIMIT",
      "workspace symbol response exceeds the " + String(MAX_INPUT_SYMBOLS) + " item input limit",
    );
  }

  const maxSymbols = normalizeMaxSymbols(options.maxSymbols);
  const symbols: LspWorkspaceSymbol[] = [];
  for (const value of rawSymbols) {
    const raw = requiredRecord(value, "workspace symbol");
    const symbol = normalizeWorkspaceSymbol(raw, context);
    if (symbols.length < maxSymbols) symbols.push(symbol);
  }

  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "workspace_symbols" as const,
    server: context.server,
    query: context.query,
    symbols: Object.freeze(symbols),
    totalSymbols: rawSymbols.length,
    truncated: rawSymbols.length > maxSymbols,
  });
}

interface WorkspaceSymbolContext {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly query: string;
}

function emptyWorkspaceSymbolsSnapshot(
  context: WorkspaceSymbolContext,
): LspWorkspaceSymbolsSnapshot {
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "workspace_symbols" as const,
    server: context.server,
    query: context.query,
    symbols: Object.freeze([]),
    totalSymbols: 0,
    truncated: false,
  });
}

function normalizeWorkspaceSymbolContext(options: unknown): WorkspaceSymbolContext {
  const raw = requiredRecord(options, "workspace symbol options");
  const workspaceRoot = requiredWorkspaceRoot(raw.workspaceRoot);
  const server = requiredStableText(raw.server, "server", MAX_SERVER_BYTES);
  const query = requiredWorkspaceSymbolQuery(raw.query);
  return Object.freeze({ workspaceRoot, server, query });
}

function normalizeWorkspaceSymbol(
  raw: Record<string, unknown>,
  context: WorkspaceSymbolContext,
): LspWorkspaceSymbol {
  const name = requiredStableText(raw.name, "symbol name", MAX_SYMBOL_NAME_BYTES);
  const location = requiredRecord(raw.location, "workspace symbol location");
  const uri = requiredString(location, "uri", "workspace symbol location");
  const path = pathFromUri(uri, context.workspaceRoot);
  const range = normalizeRange(location.range, "workspace symbol location range");
  const containerName = optionalStableText(
    raw.containerName,
    "symbol container name",
    MAX_SYMBOL_NAME_BYTES,
  );
  const symbol: {
    name: string;
    kind: LspDocumentSymbolKind;
    path: string;
    range: LspRange;
    containerName?: string;
  } = {
    name,
    kind: symbolKind(raw.kind),
    path,
    range,
  };
  if (containerName !== undefined) symbol.containerName = containerName;
  return Object.freeze(symbol);
}

interface SymbolContext {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly path: string;
}

function emptySnapshot(context: SymbolContext): LspDocumentSymbolsSnapshot {
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "symbols" as const,
    server: context.server,
    path: context.path,
    symbols: Object.freeze([]),
    totalSymbols: 0,
    truncated: false,
  });
}

function normalizeContext(options: unknown): SymbolContext {
  const raw = requiredRecord(options, "document symbol options");
  const workspaceRoot = requiredWorkspaceRoot(raw.workspaceRoot);
  const server = requiredStableText(raw.server, "server", MAX_SERVER_BYTES);
  const path = requiredWorkspacePath(raw.path, "path");
  return Object.freeze({ workspaceRoot, server, path });
}

function normalizeSymbol(
  raw: Record<string, unknown>,
  parentName: string | undefined,
  context: SymbolContext,
): LspDocumentSymbol {
  const name = requiredStableText(raw.name, "symbol name", MAX_SYMBOL_NAME_BYTES);
  const range = symbolRange(raw, context);
  const selectionRange = raw.selectionRange === undefined
    ? undefined
    : normalizeRange(raw.selectionRange, "symbol selection range");
  const explicitContainer = optionalStableText(raw.containerName, "symbol container name", MAX_SYMBOL_NAME_BYTES);
  const containerName = explicitContainer ?? parentName;
  const symbol: {
    name: string;
    kind: LspDocumentSymbolKind;
    range: LspRange;
    selectionRange?: LspRange;
    containerName?: string;
  } = {
    name,
    kind: symbolKind(raw.kind),
    range,
  };
  if (selectionRange !== undefined) symbol.selectionRange = selectionRange;
  if (containerName !== undefined) symbol.containerName = containerName;
  return Object.freeze(symbol);
}

function symbolRange(raw: Record<string, unknown>, context: SymbolContext): LspRange {
  if (raw.range !== undefined) return normalizeRange(raw.range, "symbol range");

  const location = requiredRecord(raw.location, "symbol location");
  const uri = requiredString(location, "uri", "symbol location");
  const locationPath = pathFromUri(uri, context.workspaceRoot);
  if (locationPath !== context.path) {
    throw failure("LSP_SYMBOL_QUERY_SCOPE_VIOLATION", "symbol location must remain in the requested document");
  }
  return normalizeRange(location.range, "symbol location range");
}

function normalizeRange(value: unknown, label: string): LspRange {
  const raw = requiredRecord(value, label);
  const start = normalizePosition(raw.start, label + " start");
  const end = normalizePosition(raw.end, label + " end");
  if (comparePositions(start, end) > 0) {
    throw failure("LSP_SYMBOL_QUERY_INVALID", label + " end must not precede its start");
  }
  return Object.freeze({ start, end });
}

function normalizePosition(value: unknown, label: string): LspPosition {
  const raw = requiredRecord(value, label);
  if (!isPositionComponent(raw.line) || !isPositionComponent(raw.character)) {
    throw failure(
      "LSP_SYMBOL_QUERY_INVALID",
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

function normalizeMaxSymbols(value: unknown): number {
  const maxSymbols = value === undefined ? DEFAULT_MAX_SYMBOLS : value;
  if (
    typeof maxSymbols !== "number" ||
    !Number.isSafeInteger(maxSymbols) ||
    maxSymbols < 1 ||
    maxSymbols > MAX_SYMBOLS
  ) {
    throw failure(
      "LSP_SYMBOL_QUERY_LIMIT",
      "maxSymbols must be a positive safe integer up to " + String(MAX_SYMBOLS),
    );
  }
  return maxSymbols;
}

function symbolKind(value: unknown): LspDocumentSymbolKind {
  switch (value) {
    case 1: return "file";
    case 2: return "module";
    case 3: return "namespace";
    case 4: return "package";
    case 5: return "class";
    case 6: return "method";
    case 7: return "property";
    case 8: return "field";
    case 9: return "constructor";
    case 10: return "enum";
    case 11: return "interface";
    case 12: return "function";
    case 13: return "variable";
    case 14: return "constant";
    case 15: return "string";
    case 16: return "number";
    case 17: return "boolean";
    case 18: return "array";
    case 19: return "object";
    case 20: return "key";
    case 21: return "null";
    case 22: return "enum_member";
    case 23: return "struct";
    case 24: return "event";
    case 25: return "operator";
    case 26: return "type_parameter";
    default: return "unknown";
  }
}

function requiredWorkspaceRoot(value: unknown): string {
  if (typeof value !== "string") {
    throw failure("LSP_SYMBOL_QUERY_INVALID", "workspaceRoot must be a string");
  }
  assertBoundedText(value, "workspaceRoot", MAX_WORKSPACE_ROOT_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_SYMBOL_QUERY_INVALID", "workspaceRoot must be non-empty non-control text");
  }
  return value;
}
function requiredWorkspaceSymbolQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw failure("LSP_SYMBOL_QUERY_INVALID", "query must be a string");
  }
  assertBoundedText(value, "query", MAX_QUERY_BYTES);
  if (UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_SYMBOL_QUERY_INVALID", "query must not contain control characters");
  }
  const query = safeDisplayText(value);
  if (query.length === 0) {
    throw failure("LSP_SYMBOL_QUERY_INVALID", "query must contain displayable text");
  }
  return query;
}


function requiredWorkspacePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_SYMBOL_QUERY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_PATH_BYTES);
  const parts = value.split("/");
  if (
    value.trim().length === 0 ||
    UNSAFE_CONTROL_CHARACTERS.test(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw failure("LSP_SYMBOL_QUERY_SCOPE_VIOLATION", label + " must remain workspace-relative");
  }
  return value;
}

function requiredStableText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw failure("LSP_SYMBOL_QUERY_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, maxBytes);
  const display = safeDisplayText(value);
  if (display.length === 0) {
    throw failure("LSP_SYMBOL_QUERY_INVALID", label + " must contain displayable text");
  }
  return display;
}

function optionalStableText(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? requiredStableText(value, label, maxBytes) : undefined;
}

function pathFromUri(uri: string, workspaceRoot: string): string {
  try {
    return workspacePathFromLspUri(uri, workspaceRoot);
  } catch {
    throw failure("LSP_SYMBOL_QUERY_SCOPE_VIOLATION", "symbol location URI must be a file inside the workspace");
  }
}

function assertBoundedText(value: string, label: string, maxBytes: number): void {
  try {
    assertValidText(value);
  } catch {
    throw failure("LSP_SYMBOL_QUERY_INVALID", label + " must be valid UTF-8 text");
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw failure("LSP_SYMBOL_QUERY_LIMIT", label + " exceeds " + String(maxBytes) + " UTF-8 bytes");
  }
}

function safeDisplayText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw failure("LSP_SYMBOL_QUERY_INVALID", label + " must be an object");
  return value;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw failure("LSP_SYMBOL_QUERY_INVALID", label + " must be an array");
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw failure("LSP_SYMBOL_QUERY_INVALID", label + " requires " + key);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: LspSymbolQueryErrorCode, message: string): LspSymbolQueryDomainError {
  return new LspSymbolQueryDomainError(code, message);
}
