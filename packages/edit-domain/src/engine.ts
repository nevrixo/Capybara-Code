import { canonicalDigest } from "@cbc/app-protocol";

import { resolveAnchor, textDigest } from "./anchors.ts";
import {
  assertValidText,
  byteOffsetToUtf16Index,
  rangeToByteRange,
  substringAtByteRange,
  utf8ByteLength,
} from "./position.ts";
import { EditDomainError } from "./types.ts";
import type {
  ByteRange,
  CreateFileOperation,
  DeleteFileOperation,
  DiffPreviewLine,
  EditDocument,
  EditEngineOptions,
  EditOperation,
  EditOperationId,
  EditPlan,
  EditPreflightResult,
  EditWorkspaceSnapshot,
  MoveFileOperation,
  PreparedFileChange,
  ReplaceRangeOperation,
  ResolvedTextEdit,
} from "./types.ts";

const DEFAULT_MAX_OPERATIONS = 100;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DIFF_PREVIEW_LINES = 80;

type TextOperation = Exclude<
  EditOperation,
  CreateFileOperation | MoveFileOperation | DeleteFileOperation
>;

interface WorkingDocument {
  readonly original?: EditDocument;
  readonly text: string;
  readonly operationIds: readonly EditOperationId[];
}

interface PreparedChangeWithText {
  readonly change: PreparedFileChange;
  readonly before: string;
  readonly after: string;
}

/**
 * Pure, side-effect-free preflight. It deliberately never writes a filesystem:
 * callers pass the staged file outcomes to the Rust transaction authority.
 */
export function preflightEditPlan(
  plan: EditPlan,
  snapshot: EditWorkspaceSnapshot,
  options: EditEngineOptions = {},
): EditPreflightResult {
  const limits = normalizeOptions(options);
  validatePlan(plan, snapshot, limits.maxOperations);
  const documents = documentsByPath(snapshot.documents);
  validateOperationPaths(plan.operations);
  validateFileOperationConflicts(plan.operations);

  const resolvedOperations = resolveTextOperations(plan, documents, limits);
  detectOverlaps(resolvedOperations);

  const working = new Map<string, WorkingDocument>();
  for (const [path, document] of documents) {
    working.set(path, { original: document, text: document.text, operationIds: [] });
  }

  const prepared: PreparedChangeWithText[] = [];
  const byPath = groupResolvedOperations(resolvedOperations);
  for (const [path, edits] of byPath) {
    const current = working.get(path);
    if (current === undefined || current.original === undefined) {
      throw failure("EDIT_PATH_CONFLICT", `text operation targets missing file '${path}'`, { path });
    }
    const nextText = applyResolvedOperations(current.text, edits);
    assertEditText(nextText, path, limits.maxFileBytes);
    if (nextText !== current.text) {
      const change = modifiedChange(path, current.original, nextText, edits.map((edit) => edit.operationId));
      prepared.push({ change, before: current.text, after: nextText });
      working.set(path, { original: current.original, text: nextText, operationIds: change.operationIds });
    }
  }

  for (const operation of plan.operations) {
    switch (operation.kind) {
      case "create_file":
        applyCreate(operation, working, prepared, limits.maxFileBytes);
        break;
      case "delete_file":
        applyDelete(operation, working, prepared);
        break;
      case "move_file":
        applyMove(operation, working, prepared);
        break;
      default:
        break;
    }
  }

  const files = prepared.map((entry) => entry.change).sort(comparePreparedFiles);
  return {
    status: files.length === 0 ? "no_change" : "previewed",
    planId: plan.id,
    planDigest: canonicalDigest(plan),
    resolvedOperations,
    files,
    diffPreview: buildDiffPreview(prepared, limits.maxDiffPreviewLines),
  };
}

function normalizeOptions(options: EditEngineOptions): Required<EditEngineOptions> {
  return {
    maxOperations: options.maxOperations ?? DEFAULT_MAX_OPERATIONS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxAnchorCandidates: options.maxAnchorCandidates ?? 32,
    anchorAmbiguityMargin: options.anchorAmbiguityMargin ?? 5,
    maxDiffPreviewLines: options.maxDiffPreviewLines ?? DEFAULT_MAX_DIFF_PREVIEW_LINES,
  };
}

function validatePlan(
  plan: EditPlan,
  snapshot: EditWorkspaceSnapshot,
  maxOperations: number,
): void {
  if (plan.schemaVersion !== "1.0") {
    throw failure("EDIT_TOKEN_INVALID", `unsupported edit plan schema '${plan.schemaVersion}'`);
  }
  if (!plan.id.startsWith("edp_") || plan.id.length <= 4) {
    throw failure("EDIT_TOKEN_INVALID", "edit plan id must use the edp_ prefix");
  }
  requireNonEmpty(plan.sessionId, "sessionId");
  requireNonEmpty(plan.workspaceIdentityDigest, "workspaceIdentityDigest");
  requireNonEmpty(snapshot.workspaceIdentityDigest, "snapshot workspaceIdentityDigest");
  if (plan.workspaceIdentityDigest !== snapshot.workspaceIdentityDigest) {
    throw failure("EDIT_SCOPE_VIOLATION", "edit plan workspace identity does not match the snapshot");
  }
  if (!Number.isFinite(Date.parse(plan.createdAt))) {
    throw failure("EDIT_TOKEN_INVALID", "createdAt must be an ISO-8601 timestamp");
  }
  if (plan.operations.length === 0 || plan.operations.length > maxOperations) {
    throw failure("EDIT_TOKEN_INVALID", `plan must contain between 1 and ${maxOperations} operations`);
  }
  const operationIds = new Set<string>();
  for (const operation of plan.operations) {
    if (!operation.operationId.startsWith("edo_") || operation.operationId.length <= 4) {
      throw failure("EDIT_TOKEN_INVALID", "operation ids must use the edo_ prefix", { path: operation.path });
    }
    if (operationIds.has(operation.operationId)) {
      throw failure("EDIT_PATH_CONFLICT", `duplicate operation id '${operation.operationId}'`, {
        path: operation.path,
        operationId: operation.operationId,
      });
    }
    operationIds.add(operation.operationId);
  }
}

function documentsByPath(documents: readonly EditDocument[]): Map<string, EditDocument> {
  const result = new Map<string, EditDocument>();
  for (const document of documents) {
    assertWorkspacePath(document.path);
    if (result.has(document.path)) {
      throw failure("EDIT_PATH_CONFLICT", `snapshot contains duplicate path '${document.path}'`, {
        path: document.path,
      });
    }
    requireNonEmpty(document.revision, `revision for ${document.path}`);
    result.set(document.path, document);
  }
  return result;
}

function validateOperationPaths(operations: readonly EditOperation[]): void {
  for (const operation of operations) {
    assertWorkspacePath(operation.path, operation.operationId);
    if (operation.kind === "move_file") assertWorkspacePath(operation.toPath, operation.operationId);
  }
}

function assertWorkspacePath(path: string, operationId?: string): void {
  const normalized = path.replace(/\\/gu, "/");
  if (
    path.length === 0
    || path !== normalized
    || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path)
    || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw failure("EDIT_SCOPE_VIOLATION", `path '${path}' is not a normalized workspace-relative path`, {
      ...(operationId === undefined ? {} : { operationId }),
    });
  }
}

function validateFileOperationConflicts(operations: readonly EditOperation[]): void {
  const textPaths = new Set<string>();
  const creates = new Set<string>();
  const deletes = new Set<string>();
  const moveSources = new Set<string>();
  const moveDestinations = new Set<string>();

  for (const operation of operations) {
    switch (operation.kind) {
      case "replace_anchor":
      case "replace_range":
      case "insert_before":
      case "insert_after":
      case "delete_anchor":
        textPaths.add(operation.path);
        break;
      case "create_file":
        if (creates.has(operation.path)) duplicatePathOperation(operation);
        creates.add(operation.path);
        break;
      case "delete_file":
        if (deletes.has(operation.path)) duplicatePathOperation(operation);
        deletes.add(operation.path);
        break;
      case "move_file":
        if (moveSources.has(operation.path) || moveDestinations.has(operation.toPath)) {
          duplicatePathOperation(operation);
        }
        if (operation.path === operation.toPath) {
          throw failure("EDIT_PATH_CONFLICT", "move source and destination must differ", {
            path: operation.path,
            operationId: operation.operationId,
          });
        }
        moveSources.add(operation.path);
        moveDestinations.add(operation.toPath);
        break;
    }
  }

  for (const path of textPaths) {
    if (creates.has(path) || deletes.has(path) || moveSources.has(path) || moveDestinations.has(path)) {
      throw failure("EDIT_PATH_CONFLICT", `text and file operations conflict on '${path}'`, { path });
    }
  }
  for (const path of creates) {
    if (deletes.has(path) || moveSources.has(path) || moveDestinations.has(path)) {
      throw failure("EDIT_PATH_CONFLICT", `create conflicts with another file operation on '${path}'`, { path });
    }
  }
  for (const path of deletes) {
    if (moveSources.has(path) || moveDestinations.has(path)) {
      throw failure("EDIT_PATH_CONFLICT", `delete conflicts with move on '${path}'`, { path });
    }
  }
}

function duplicatePathOperation(operation: EditOperation): never {
  throw failure("EDIT_PATH_CONFLICT", `duplicate file operation for '${operation.path}'`, {
    path: operation.path,
    operationId: operation.operationId,
  });
}

function resolveTextOperations(
  plan: EditPlan,
  documents: ReadonlyMap<string, EditDocument>,
  limits: Required<EditEngineOptions>,
): readonly ResolvedTextEdit[] {
  const resolved: ResolvedTextEdit[] = [];
  for (const operation of plan.operations) {
    if (!isTextOperation(operation)) continue;
    const document = documents.get(operation.path);
    if (document === undefined) {
      throw failure("EDIT_PATH_CONFLICT", `text operation targets missing file '${operation.path}'`, {
        path: operation.path,
        operationId: operation.operationId,
      });
    }
    if (document.isBinary === true) {
      throw failure("EDIT_BINARY_UNSUPPORTED", `cannot apply a text edit to binary file '${operation.path}'`, {
        path: operation.path,
        operationId: operation.operationId,
      });
    }
    assertEditText(document.text, operation.path, limits.maxFileBytes);
    const edit = resolveTextOperation(plan, operation, document, limits);
    assertEditText(edit.replacement, operation.path, limits.maxFileBytes);
    resolved.push(edit);
  }
  return resolved;
}

function resolveTextOperation(
  plan: EditPlan,
  operation: TextOperation,
  document: EditDocument,
  limits: Required<EditEngineOptions>,
): ResolvedTextEdit {
  switch (operation.kind) {
    case "replace_range":
      return resolveRangeOperation(operation, document);
    case "replace_anchor": {
      const anchor = resolveAnchor(document.text, operation.anchor, {
        conflictPolicy: plan.conflictPolicy,
        currentRevision: document.revision,
        maxCandidates: limits.maxAnchorCandidates,
        ambiguityMargin: limits.anchorAmbiguityMargin,
        path: operation.path,
        operationId: operation.operationId,
      });
      return {
        operationId: operation.operationId,
        path: operation.path,
        byteRange: anchor.byteRange,
        replacement: operation.replacement,
        resolution: anchor.evidence,
      };
    }
    case "insert_before": {
      const anchor = resolveAnchor(document.text, operation.anchor, {
        conflictPolicy: plan.conflictPolicy,
        currentRevision: document.revision,
        maxCandidates: limits.maxAnchorCandidates,
        ambiguityMargin: limits.anchorAmbiguityMargin,
        path: operation.path,
        operationId: operation.operationId,
      });
      return {
        operationId: operation.operationId,
        path: operation.path,
        byteRange: { start: anchor.byteRange.start, end: anchor.byteRange.start },
        replacement: operation.text,
        resolution: anchor.evidence,
      };
    }
    case "insert_after": {
      const anchor = resolveAnchor(document.text, operation.anchor, {
        conflictPolicy: plan.conflictPolicy,
        currentRevision: document.revision,
        maxCandidates: limits.maxAnchorCandidates,
        ambiguityMargin: limits.anchorAmbiguityMargin,
        path: operation.path,
        operationId: operation.operationId,
      });
      return {
        operationId: operation.operationId,
        path: operation.path,
        byteRange: { start: anchor.byteRange.end, end: anchor.byteRange.end },
        replacement: operation.text,
        resolution: anchor.evidence,
      };
    }
    case "delete_anchor": {
      const anchor = resolveAnchor(document.text, operation.anchor, {
        conflictPolicy: plan.conflictPolicy,
        currentRevision: document.revision,
        maxCandidates: limits.maxAnchorCandidates,
        ambiguityMargin: limits.anchorAmbiguityMargin,
        path: operation.path,
        operationId: operation.operationId,
      });
      return {
        operationId: operation.operationId,
        path: operation.path,
        byteRange: anchor.byteRange,
        replacement: "",
        resolution: anchor.evidence,
      };
    }
  }
}

function resolveRangeOperation(operation: ReplaceRangeOperation, document: EditDocument): ResolvedTextEdit {
  if (operation.baseRevision !== document.revision) {
    throw failure("EDIT_REVISION_MISMATCH", "range edit base revision does not match the current document", {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  const byteRange = rangeToByteRange(document.text, operation.range);
  const observed = substringAtByteRange(document.text, byteRange);
  if (operation.expectedTextDigest !== undefined && textDigest(observed) !== operation.expectedTextDigest) {
    throw failure("EDIT_REVISION_MISMATCH", "range text digest does not match the current document", {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  return {
    operationId: operation.operationId,
    path: operation.path,
    byteRange,
    replacement: operation.replacement,
    resolution: {
      method: "range",
      score: 160,
      candidateCount: 1,
      baseRevision: operation.baseRevision,
      currentRevision: document.revision,
    },
  };
}

function isTextOperation(operation: EditOperation): operation is TextOperation {
  return operation.kind !== "create_file" && operation.kind !== "delete_file" && operation.kind !== "move_file";
}

function detectOverlaps(edits: readonly ResolvedTextEdit[]): void {
  const byPath = groupResolvedOperations(edits);
  for (const [path, group] of byPath) {
    const sorted = [...group].sort(compareRangesAscending);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous !== undefined && current !== undefined && rangesConflict(previous.byteRange, current.byteRange)) {
        throw failure("EDIT_OVERLAP", `operations '${previous.operationId}' and '${current.operationId}' overlap`, {
          path,
          operationId: current.operationId,
        });
      }
    }
  }
}

function groupResolvedOperations(edits: readonly ResolvedTextEdit[]): Map<string, ResolvedTextEdit[]> {
  const grouped = new Map<string, ResolvedTextEdit[]>();
  for (const edit of edits) {
    const existing = grouped.get(edit.path);
    if (existing === undefined) grouped.set(edit.path, [edit]);
    else existing.push(edit);
  }
  return grouped;
}

function rangesConflict(left: ByteRange, right: ByteRange): boolean {
  const leftPoint = left.start === left.end;
  const rightPoint = right.start === right.end;
  if (leftPoint && rightPoint) return false;
  if (leftPoint) return right.start < left.start && left.start < right.end;
  if (rightPoint) return left.start < right.start && right.start < left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function compareRangesAscending(left: ResolvedTextEdit, right: ResolvedTextEdit): number {
  return left.byteRange.start - right.byteRange.start
    || left.byteRange.end - right.byteRange.end
    || compareIds(left.operationId, right.operationId);
}

function applyResolvedOperations(text: string, edits: readonly ResolvedTextEdit[]): string {
  let next = text;
  const sorted = [...edits].sort((left, right) => {
    const start = right.byteRange.start - left.byteRange.start;
    if (start !== 0) return start;
    const end = right.byteRange.end - left.byteRange.end;
    if (end !== 0) return end;
    return compareIds(right.operationId, left.operationId);
  });
  for (const edit of sorted) {
    const start = byteOffsetToUtf16Index(next, edit.byteRange.start);
    const end = byteOffsetToUtf16Index(next, edit.byteRange.end);
    next = `${next.slice(0, start)}${edit.replacement}${next.slice(end)}`;
  }
  return next;
}

function applyCreate(
  operation: CreateFileOperation,
  working: Map<string, WorkingDocument>,
  prepared: PreparedChangeWithText[],
  maxFileBytes: number,
): void {
  if (working.has(operation.path)) {
    throw failure("EDIT_PATH_CONFLICT", `create destination '${operation.path}' already exists`, {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  assertEditText(operation.content, operation.path, maxFileBytes);
  const change: PreparedFileChange = {
    kind: "create",
    path: operation.path,
    revisionAfter: textDigest(operation.content),
    text: operation.content,
    operationIds: [operation.operationId],
    additions: countLines(operation.content),
    deletions: 0,
  };
  prepared.push({ change, before: "", after: operation.content });
  working.set(operation.path, { text: operation.content, operationIds: change.operationIds });
}

function applyDelete(
  operation: DeleteFileOperation,
  working: Map<string, WorkingDocument>,
  prepared: PreparedChangeWithText[],
): void {
  const current = working.get(operation.path);
  if (current === undefined) {
    throw failure("EDIT_PATH_CONFLICT", `delete target '${operation.path}' does not exist`, {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  const revisionBefore = current.original?.revision ?? textDigest(current.text);
  if (operation.expectedRevision !== undefined && operation.expectedRevision !== revisionBefore) {
    throw failure("EDIT_REVISION_MISMATCH", "delete base revision does not match the current document", {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  const change: PreparedFileChange = {
    kind: "delete",
    path: operation.path,
    revisionBefore,
    operationIds: [operation.operationId],
    additions: 0,
    deletions: countLines(current.text),
  };
  prepared.push({ change, before: current.text, after: "" });
  working.delete(operation.path);
}

function applyMove(
  operation: MoveFileOperation,
  working: Map<string, WorkingDocument>,
  prepared: PreparedChangeWithText[],
): void {
  const current = working.get(operation.path);
  if (current === undefined || working.has(operation.toPath)) {
    throw failure("EDIT_PATH_CONFLICT", "move source must exist and destination must not exist", {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  const revisionBefore = current.original?.revision ?? textDigest(current.text);
  if (operation.expectedRevision !== undefined && operation.expectedRevision !== revisionBefore) {
    throw failure("EDIT_REVISION_MISMATCH", "move base revision does not match the current document", {
      path: operation.path,
      operationId: operation.operationId,
    });
  }
  const change: PreparedFileChange = {
    kind: "move",
    path: operation.toPath,
    previousPath: operation.path,
    revisionBefore,
    revisionAfter: textDigest(current.text),
    text: current.text,
    operationIds: [operation.operationId],
    additions: 0,
    deletions: 0,
  };
  prepared.push({ change, before: current.text, after: current.text });
  working.delete(operation.path);
  working.set(operation.toPath, {
    ...(current.original === undefined ? {} : { original: current.original }),
    text: current.text,
    operationIds: change.operationIds,
  });
}

function modifiedChange(
  path: string,
  original: EditDocument,
  text: string,
  operationIds: readonly EditOperationId[],
): PreparedFileChange {
  const counts = changedLineCounts(original.text, text);
  return {
    kind: "modify",
    path,
    revisionBefore: original.revision,
    revisionAfter: textDigest(text),
    text,
    operationIds,
    additions: counts.additions,
    deletions: counts.deletions,
  };
}

function changedLineCounts(before: string, after: string): { readonly additions: number; readonly deletions: number } {
  const beforeLines = splitForDiff(before);
  const afterLines = splitForDiff(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: afterLines.length - prefix - suffix,
    deletions: beforeLines.length - prefix - suffix,
  };
}

function buildDiffPreview(
  prepared: readonly PreparedChangeWithText[],
  maximum: number,
): readonly DiffPreviewLine[] {
  const preview: DiffPreviewLine[] = [];
  for (const entry of prepared) {
    if (entry.before === entry.after) continue;
    const beforeLines = splitForDiff(entry.before);
    const afterLines = splitForDiff(entry.after);
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix
      && suffix < afterLines.length - prefix
      && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) {
      if (preview.length >= maximum) return preview;
      preview.push({ path: entry.change.path, kind: "deletion", text: line });
    }
    for (const line of afterLines.slice(prefix, afterLines.length - suffix)) {
      if (preview.length >= maximum) return preview;
      preview.push({ path: entry.change.path, kind: "addition", text: line });
    }
  }
  return preview;
}

function splitForDiff(text: string): readonly string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}

function countLines(text: string): number {
  return splitForDiff(text).length;
}

function comparePreparedFiles(left: PreparedFileChange, right: PreparedFileChange): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertEditText(text: string, path: string, maxFileBytes: number): void {
  assertValidText(text, path);
  if (utf8ByteLength(text) > maxFileBytes) {
    throw failure("EDIT_FILE_TOO_LARGE", `text for '${path}' exceeds ${maxFileBytes} bytes`, { path });
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw failure("EDIT_TOKEN_INVALID", `${field} must not be empty`);
  }
}

function failure(
  code: EditDomainError["code"],
  message: string,
  options: {
    readonly path?: string;
    readonly operationId?: string;
  } = {},
): EditDomainError {
  return new EditDomainError(code, message, options);
}
