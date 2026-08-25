import { assertValidText } from "@cbc/edit-domain";

import type { LspPosition } from "./types.ts";

const UTF8 = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const WHITESPACE = /\s+/g;

const MAX_WORKSPACE_ROOT_BYTES = 32 * 1_024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_POSITION_COMPONENT = 1_000_000;
const MAX_INPUT_CODE_ACTIONS = 256;
const MAX_CODE_ACTIONS = 64;
const DEFAULT_MAX_CODE_ACTIONS = 32;
const MAX_TITLE_BYTES = 2 * 1_024;
const MAX_KIND_BYTES = 256;

/** Raw cursor coordinates supplied to textDocument/codeAction. */
export interface LspCodeActionQueryInput {
  readonly path: string;
  readonly line: number;
  readonly character: number;
}

/** Safe workspace-local source coordinates that can appear in model context. */
export interface LspCodeActionQuerySource {
  readonly path: string;
  readonly position: LspPosition;
}

/**
 * Display-only metadata about one server proposal. The raw WorkspaceEdit,
 * Command, diagnostics, and arbitrary action data are deliberately omitted.
 */
export interface LspCodeActionCatalogItem {
  /** Stable only within this returned catalog; it is not an apply capability. */
  readonly index: number;
  readonly title: string;
  readonly kind?: string;
  readonly preferred: boolean;
  readonly disabled: boolean;
  readonly hasEdit: boolean;
  readonly hasCommand: boolean;
}

/** Bounded code-action metadata from an untrusted local language server. */
export interface LspCodeActionCatalogSnapshot {
  readonly schemaVersion: "1.0";
  readonly kind: "code_actions";
  readonly server: string;
  readonly source: LspCodeActionQuerySource;
  readonly actions: readonly LspCodeActionCatalogItem[];
  readonly totalActions: number;
  readonly truncated: boolean;
}

export interface NormalizeLspCodeActionQueryOptions {
  readonly workspaceRoot: string;
  readonly server: string;
  readonly source: LspCodeActionQueryInput;
  /** Lower the visible action cap; it can never exceed the hard safety bound. */
  readonly maxActions?: number;
}

export type LspCodeActionQueryErrorCode =
  | "LSP_CODE_ACTION_INVALID"
  | "LSP_CODE_ACTION_SCOPE_VIOLATION"
  | "LSP_CODE_ACTION_LIMIT";

export class LspCodeActionQueryDomainError extends Error {
  readonly code: LspCodeActionQueryErrorCode;

  constructor(code: LspCodeActionQueryErrorCode, message: string) {
    super(message);
    this.name = "LspCodeActionQueryDomainError";
    this.code = code;
  }
}

/**
 * Normalize a textDocument/codeAction result into immutable display metadata.
 * It performs no I/O and never returns executable commands or edit payloads.
 */
export function normalizeLspCodeActionQuery(
  result: unknown,
  options: NormalizeLspCodeActionQueryOptions,
): LspCodeActionCatalogSnapshot {
  const context = normalizeContext(options);
  const maxActions = normalizeMaxActions(options.maxActions);
  const rawActions = rawActionList(result);
  if (rawActions.length > MAX_INPUT_CODE_ACTIONS) {
    throw failure(
      "LSP_CODE_ACTION_LIMIT",
      "code action response exceeds the " + String(MAX_INPUT_CODE_ACTIONS) + " item input limit",
    );
  }

  const actions: LspCodeActionCatalogItem[] = [];
  for (const [index, rawAction] of rawActions.slice(0, maxActions).entries()) {
    actions.push(normalizeAction(rawAction, index));
  }

  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "code_actions" as const,
    server: context.server,
    source: context.source,
    actions: Object.freeze(actions),
    totalActions: rawActions.length,
    truncated: rawActions.length > maxActions,
  });
}

interface NormalizedContext {
  readonly server: string;
  readonly source: LspCodeActionQuerySource;
}

function normalizeContext(options: unknown): NormalizedContext {
  const raw = requiredRecord(options, "code action options");
  requiredWorkspaceRoot(raw.workspaceRoot);
  const server = requiredStableText(raw.server, "server");
  const source = normalizeSource(raw.source);
  return Object.freeze({ server, source });
}

function rawActionList(value: unknown): readonly unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw failure("LSP_CODE_ACTION_INVALID", "code action response must be an array or null");
  }
  return value;
}

function normalizeAction(value: unknown, index: number): LspCodeActionCatalogItem {
  const label = "code action " + String(index);
  const raw = requiredRecord(value, label);
  const title = displayText(raw.title, label + " title", MAX_TITLE_BYTES);
  const kind = raw.kind === undefined
    ? undefined
    : displayText(raw.kind, label + " kind", MAX_KIND_BYTES);
  const preferred = optionalBoolean(raw.isPreferred, label + " isPreferred");
  const disabled = disabledAction(raw.disabled, label + " disabled");
  const hasEdit = optionalObject(raw.edit, label + " edit");
  const hasCommand = optionalObject(raw.command, label + " command");

  return Object.freeze({
    index,
    title,
    ...(kind === undefined ? {} : { kind }),
    preferred,
    disabled,
    hasEdit,
    hasCommand,
  });
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must be a boolean");
  }
  return value;
}

function disabledAction(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  const disabled = requiredRecord(value, label);
  assertBoundedText(disabled.reason, label + " reason", MAX_TITLE_BYTES);
  return true;
}

function optionalObject(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  requiredRecord(value, label);
  return true;
}

function normalizeSource(value: unknown): LspCodeActionQuerySource {
  const raw = requiredRecord(value, "code action source");
  const path = normalizeWorkspacePath(raw.path, "code action source path");
  const position = normalizePosition(
    { line: raw.line, character: raw.character },
    "code action source position",
  );
  return Object.freeze({ path, position: Object.freeze(position) });
}

function normalizeWorkspacePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_CODE_ACTION_SCOPE_VIOLATION", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_PATH_BYTES);
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    UNSAFE_CONTROL_CHARACTERS.test(value)
  ) {
    throw failure("LSP_CODE_ACTION_SCOPE_VIOLATION", label + " must be a workspace-relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw failure("LSP_CODE_ACTION_SCOPE_VIOLATION", label + " must not traverse the workspace");
  }
  return value;
}

function normalizePosition(value: unknown, label: string): LspPosition {
  const raw = requiredRecord(value, label);
  if (
    !isPositionComponent(raw.line) ||
    !isPositionComponent(raw.character)
  ) {
    throw failure(
      "LSP_CODE_ACTION_INVALID",
      label + " must use zero-based non-negative position components",
    );
  }
  return { line: raw.line, character: raw.character };
}

function normalizeMaxActions(value: number | undefined): number {
  const maxActions = value ?? DEFAULT_MAX_CODE_ACTIONS;
  if (
    !Number.isSafeInteger(maxActions) ||
    maxActions < 1 ||
    maxActions > MAX_CODE_ACTIONS
  ) {
    throw failure(
      "LSP_CODE_ACTION_LIMIT",
      "maxActions must be a positive safe integer up to " + String(MAX_CODE_ACTIONS),
    );
  }
  return maxActions;
}

function requiredWorkspaceRoot(value: unknown): void {
  if (typeof value !== "string") {
    throw failure("LSP_CODE_ACTION_INVALID", "workspaceRoot must be a string");
  }
  assertBoundedText(value, "workspaceRoot", MAX_WORKSPACE_ROOT_BYTES);
  if (value.trim().length === 0 || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw failure("LSP_CODE_ACTION_INVALID", "workspaceRoot must be non-empty non-control text");
  }
}

function requiredStableText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, MAX_IDENTIFIER_BYTES);
  const normalized = safeDisplayText(value);
  if (normalized.length === 0) {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must not be blank");
  }
  return normalized;
}

function displayText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must be a string");
  }
  assertBoundedText(value, label, maxBytes);
  const normalized = safeDisplayText(value);
  if (normalized.length === 0) {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must not be blank");
  }
  return normalized;
}

function assertBoundedText(value: unknown, label: string, maxBytes: number): asserts value is string {
  if (typeof value !== "string") {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must be a string");
  }
  try {
    assertValidText(value);
  } catch {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must be valid UTF-8 text");
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw failure("LSP_CODE_ACTION_LIMIT", label + " exceeds " + String(maxBytes) + " UTF-8 bytes");
  }
}

function safeDisplayText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
}

function isPositionComponent(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_POSITION_COMPONENT;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw failure("LSP_CODE_ACTION_INVALID", label + " must be an object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: LspCodeActionQueryErrorCode, message: string): LspCodeActionQueryDomainError {
  return new LspCodeActionQueryDomainError(code, message);
}
