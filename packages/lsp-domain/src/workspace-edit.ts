import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertValidText,
  rangeToByteRange,
  substringAtByteRange,
  textDigest,
  type EditOperation,
  type EditOperationId,
  type EditPlan,
  type EditPlanId,
  type TextRange,
} from "@cbc/edit-domain";

import { LspEditDomainError } from "./types.ts";
import type {
  BuildLspEditPlanOptions,
  LspDocumentChange,
  LspEditDocument,
  LspEditPlanResult,
  LspPosition,
  LspRange,
  LspTextDocumentEdit,
  LspTextEdit,
  LspWorkspaceEdit,
} from "./types.ts";

const DEFAULT_MAX_OPERATIONS = 100;

/**
 * Convert an LSP WorkspaceEdit into a versioned edit-domain plan.
 *
 * This is intentionally pure: callers must obtain each document snapshot and
 * later send the resulting plan to `fs.edit`, where Rust reads a fresh snapshot
 * and re-preflights it before any transaction can stage bytes.
 */
export function buildLspEditPlan(
  workspaceEdit: LspWorkspaceEdit,
  options: BuildLspEditPlanOptions,
): LspEditPlanResult {
  requireNonEmpty(options.workspaceIdentityDigest, "workspaceIdentityDigest");
  requireNonEmpty(options.sessionId, "sessionId");
  const maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  if (!Number.isInteger(maxOperations) || maxOperations < 1) {
    throw failure("LSP_EDIT_LIMIT", "maxOperations must be a positive integer");
  }

  const documents = documentsByPath(options.documents);
  const operations: EditOperation[] = [];
  const paths = new Set<string>();
  const planId = options.planId ?? generatedPlanId(workspaceEdit, options);
  const nextOperationId = (): EditOperationId =>
    (`edo_lsp_${planId.slice(4, 24)}_${operations.length.toString(36)}`) as EditOperationId;

  const addTextEdits = (uri: string, edits: readonly LspTextEdit[]): void => {
    const path = workspacePathFromLspUri(uri, options.workspaceRoot);
    const document = requiredDocument(documents, path);
    paths.add(path);
    if (!Array.isArray(edits) || edits.length === 0) {
      throw failure("LSP_EDIT_INVALID", "textDocument edit must contain one or more edits", path);
    }
    for (const edit of edits) {
      const range = toTextRange(edit.range, path);
      if (typeof edit.newText !== "string") {
        throw failure("LSP_EDIT_INVALID", "LSP text edit newText must be a string", path);
      }
      assertValidText(edit.newText, path);
      const byteRange = rangeToByteRange(document.text, range);
      const expectedText = substringAtByteRange(document.text, byteRange);
      operations.push({
        kind: "replace_range",
        operationId: nextOperationId(),
        path,
        baseRevision: document.revision,
        range,
        expectedTextDigest: textDigest(expectedText),
        replacement: edit.newText,
      });
    }
  };

  const changes = workspaceEdit.changes;
  if (changes !== undefined) {
    if (!isRecord(changes)) throw failure("LSP_EDIT_INVALID", "WorkspaceEdit changes must be an object");
    for (const [uri, edits] of Object.entries(changes).sort(([left], [right]) => left.localeCompare(right))) {
      if (!Array.isArray(edits)) {
        throw failure("LSP_EDIT_INVALID", "WorkspaceEdit changes entries must be arrays");
      }
      addTextEdits(uri, edits);
    }
  }

  if (workspaceEdit.documentChanges !== undefined) {
    if (!Array.isArray(workspaceEdit.documentChanges)) {
      throw failure("LSP_EDIT_INVALID", "WorkspaceEdit documentChanges must be an array");
    }
    for (const change of workspaceEdit.documentChanges) {
      addDocumentChange(change, {
        workspaceRoot: options.workspaceRoot,
        documents,
        operations,
        paths,
        nextOperationId,
        addTextEdits,
      });
    }
  }

  if (operations.length === 0) {
    throw failure("LSP_EDIT_INVALID", "WorkspaceEdit contains no supported changes");
  }
  if (operations.length > maxOperations) {
    throw failure("LSP_EDIT_LIMIT", `WorkspaceEdit exceeds ${maxOperations} operations`);
  }

  const plan: EditPlan = {
    schemaVersion: "1.0",
    id: planId,
    source: options.source ?? "lsp",
    workspaceIdentityDigest: options.workspaceIdentityDigest,
    ...(options.worktreeId === undefined ? {} : { worktreeId: options.worktreeId }),
    sessionId: options.sessionId,
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    operations,
    conflictPolicy: options.conflictPolicy ?? "fail",
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  return { plan, paths: [...paths].sort() };
}

interface ChangeContext {
  readonly workspaceRoot: string;
  readonly documents: ReadonlyMap<string, LspEditDocument>;
  readonly operations: EditOperation[];
  readonly paths: Set<string>;
  readonly nextOperationId: () => EditOperationId;
  readonly addTextEdits: (uri: string, edits: readonly LspTextEdit[]) => void;
}

function addDocumentChange(change: LspDocumentChange, context: ChangeContext): void {
  if (isTextDocumentEdit(change)) {
    context.addTextEdits(change.textDocument.uri, change.edits);
    return;
  }
  if (!isRecord(change) || typeof change.kind !== "string") {
    throw failure("LSP_EDIT_INVALID", "unsupported LSP document change");
  }
  switch (change.kind) {
    case "create": {
      const path = workspacePathFromLspUri(stringProperty(change, "uri"), context.workspaceRoot);
      context.operations.push({
        kind: "create_file",
        operationId: context.nextOperationId(),
        path,
        content: "",
      });
      context.paths.add(path);
      return;
    }
    case "rename": {
      const path = workspacePathFromLspUri(stringProperty(change, "oldUri"), context.workspaceRoot);
      const toPath = workspacePathFromLspUri(stringProperty(change, "newUri"), context.workspaceRoot);
      const document = requiredDocument(context.documents, path);
      context.operations.push({
        kind: "move_file",
        operationId: context.nextOperationId(),
        path,
        toPath,
        expectedRevision: document.revision,
      });
      context.paths.add(path);
      context.paths.add(toPath);
      return;
    }
    case "delete": {
      const path = workspacePathFromLspUri(stringProperty(change, "uri"), context.workspaceRoot);
      const document = requiredDocument(context.documents, path);
      context.operations.push({
        kind: "delete_file",
        operationId: context.nextOperationId(),
        path,
        expectedRevision: document.revision,
      });
      context.paths.add(path);
      return;
    }
    default:
      throw failure("LSP_EDIT_INVALID", "unsupported LSP resource operation");
  }
}

function isTextDocumentEdit(value: LspDocumentChange): value is LspTextDocumentEdit {
  if (!isRecord(value)) return false;
  const document = isRecord(value.textDocument) ? value.textDocument : undefined;
  return typeof document?.uri === "string" && Array.isArray(value.edits);
}

function documentsByPath(documents: readonly LspEditDocument[]): Map<string, LspEditDocument> {
  const result = new Map<string, LspEditDocument>();
  for (const document of documents) {
    assertWorkspacePath(document.path);
    requireNonEmpty(document.revision, "document revision", document.path);
    assertValidText(document.text, document.path);
    if (result.has(document.path)) {
      throw failure("LSP_EDIT_INVALID", `duplicate document snapshot ${document.path}`, document.path);
    }
    result.set(document.path, document);
  }
  return result;
}

function requiredDocument(documents: ReadonlyMap<string, LspEditDocument>, path: string): LspEditDocument {
  const document = documents.get(path);
  if (document === undefined) {
    throw failure("LSP_EDIT_DOCUMENT_MISSING", `missing exact snapshot for ${path}`, path);
  }
  return document;
}

function toTextRange(range: LspRange, path: string): TextRange {
  return {
    start: oneBasedUtf16Position(range?.start, path),
    end: oneBasedUtf16Position(range?.end, path),
    encoding: "utf16",
  };
}

function oneBasedUtf16Position(position: LspPosition | undefined, path: string): { line: number; column: number } {
  if (
    position === undefined ||
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  ) {
    throw failure("LSP_EDIT_INVALID", "LSP positions must be zero-based non-negative integers", path);
  }
  return { line: position.line + 1, column: position.character + 1 };
}

/** Convert a file URI into a validated, workspace-relative slash path. */
export function workspacePathFromLspUri(uri: string, workspaceRoot: string): string {
  let absolute: string;
  try {
    absolute = fileURLToPath(uri);
  } catch {
    throw failure("LSP_EDIT_INVALID", "LSP edit URI must be a file URI");
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(absolute);
  const path = relative(root, candidate);
  if (path.length === 0 || isAbsolute(path) || path === ".." || path.startsWith(".." + sep)) {
    throw failure("LSP_EDIT_SCOPE_VIOLATION", "LSP edit URI is outside the workspace");
  }
  const normalized = path.replace(/\\/g, "/");
  assertWorkspacePath(normalized);
  return normalized;
}

/**
 * Collect every workspace path an LSP edit references before acquiring exact
 * runtime snapshots. This performs no I/O and is intentionally conservative:
 * callers may omit a destination which does not exist yet, while the adapter
 * still fails closed if a source document snapshot is required but missing.
 */
export function collectLspWorkspaceEditPaths(
  workspaceEdit: LspWorkspaceEdit,
  workspaceRoot: string,
): readonly string[] {
  const paths = new Set<string>();
  const add = (uri: string): void => {
    paths.add(workspacePathFromLspUri(uri, workspaceRoot));
  };

  if (workspaceEdit.changes !== undefined) {
    if (!isRecord(workspaceEdit.changes)) {
      throw failure("LSP_EDIT_INVALID", "WorkspaceEdit changes must be an object");
    }
    for (const uri of Object.keys(workspaceEdit.changes)) add(uri);
  }

  if (workspaceEdit.documentChanges !== undefined) {
    if (!Array.isArray(workspaceEdit.documentChanges)) {
      throw failure("LSP_EDIT_INVALID", "WorkspaceEdit documentChanges must be an array");
    }
    for (const change of workspaceEdit.documentChanges) {
      if (isTextDocumentEdit(change)) {
        add(change.textDocument.uri);
        continue;
      }
      if (!isRecord(change) || typeof change.kind !== "string") {
        throw failure("LSP_EDIT_INVALID", "unsupported LSP document change");
      }
      switch (change.kind) {
        case "create":
        case "delete":
          add(stringProperty(change, "uri"));
          break;
        case "rename":
          add(stringProperty(change, "oldUri"));
          add(stringProperty(change, "newUri"));
          break;
        default:
          throw failure("LSP_EDIT_INVALID", "unsupported LSP resource operation");
      }
    }
  }
  return [...paths].sort();
}

function assertWorkspacePath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw failure("LSP_EDIT_SCOPE_VIOLATION", `invalid workspace-relative path ${path}`, path);
  }
}

function generatedPlanId(edit: LspWorkspaceEdit, options: BuildLspEditPlanOptions): EditPlanId {
  const digest = createHash("sha256")
    .update(options.workspaceIdentityDigest)
    .update("\u0000")
    .update(JSON.stringify(edit))
    .digest("hex")
    .slice(0, 32);
  return `edp_lsp_${digest}` as EditPlanId;
}

function stringProperty(value: Record<string, unknown>, key: string): string {
  const property = value[key];
  if (typeof property !== "string" || property.length === 0) {
    throw failure("LSP_EDIT_INVALID", `LSP resource operation requires ${key}`);
  }
  return property;
}

function requireNonEmpty(value: string, label: string, path?: string): void {
  if (value.trim().length === 0) throw failure("LSP_EDIT_INVALID", `${label} must not be empty`, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: ConstructorParameters<typeof LspEditDomainError>[0], message: string, path?: string): LspEditDomainError {
  return new LspEditDomainError(code, message, path === undefined ? {} : { path });
}
