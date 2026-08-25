/**
 * 3-way merge conflict model.
 *
 * Conflict markers are never written to working files. Conflicts produce an
 * edit plan proposal the host can preview/apply instead.
 */

export type MergeConflictKind =
  | "content"
  | "delete_modify"
  | "rename"
  | "create"
  | "revision";

export interface TextRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface MergeConflict {
  readonly id: string;
  readonly path: string;
  readonly kind: MergeConflictKind;
  readonly baseText?: string;
  readonly oursText?: string;
  readonly theirsText?: string;
  readonly ranges?: readonly TextRange[];
  readonly proposals: readonly string[];
  readonly resolutionOptions: readonly ("ours" | "theirs" | "manual" | "replan")[];
}

export interface MergeFileInput {
  readonly path: string;
  readonly baseText?: string;
  readonly oursText?: string;
  readonly theirsText?: string;
}

export interface MergePreviewResult {
  readonly clean: readonly MergeCleanFile[];
  readonly conflicts: readonly MergeConflict[];
  /** Proposed edit plan; never includes conflict-marker file writes. */
  readonly editPlan: MergeEditPlan;
  readonly writesConflictMarkers: false;
}

export interface MergeCleanFile {
  readonly path: string;
  readonly resultText: string;
  readonly resolution: "ours" | "theirs" | "base" | "merged";
}

export interface MergeEditPlan {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly source: "merge";
  readonly operations: readonly MergeEditOperation[];
  readonly conflictPolicy: "fail";
  readonly createdAt: string;
}

export interface MergeEditOperation {
  readonly operationId: string;
  readonly kind: "replace_file";
  readonly path: string;
  readonly content: string;
}

export interface MergeCoordinatorOptions {
  readonly now?: () => string;
  readonly newId?: () => string;
}

export class MergeCoordinatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MergeCoordinatorError";
    this.code = code;
  }
}

export class MergeCoordinator {
  readonly #now: () => string;
  readonly #newId: () => string;

  constructor(options: MergeCoordinatorOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? (() => "mrg_" + crypto.randomUUID().replaceAll("-", ""));
  }

  preview(files: readonly MergeFileInput[]): MergePreviewResult {
    const clean: MergeCleanFile[] = [];
    const conflicts: MergeConflict[] = [];

    for (const file of files) {
      const outcome = mergeFile(file, this.#newId);
      if (outcome.kind === "clean") clean.push(outcome.file);
      else conflicts.push(outcome.conflict);
    }

    const operations: MergeEditOperation[] = clean.map((file, index) => ({
      operationId: `edo_merge_${String(index + 1)}`,
      kind: "replace_file",
      path: file.path,
      content: file.resultText,
    }));

    // Conflicts contribute an edit-plan stub describing unresolved paths only
    // as metadata operations that replace nothing on disk.
    for (const conflict of conflicts) {
      operations.push({
        operationId: `edo_conflict_${conflict.id}`,
        kind: "replace_file",
        path: conflict.path,
        // Deliberately not a conflict-marker blob; apply is blocked while conflicts remain.
        content: conflict.oursText ?? conflict.baseText ?? "",
      });
    }

    return {
      clean,
      conflicts,
      editPlan: {
        schemaVersion: "1.0",
        id: this.#newId(),
        source: "merge",
        operations: conflicts.length === 0 ? operations.filter((op) => !op.operationId.startsWith("edo_conflict_")) : [],
        conflictPolicy: "fail",
        createdAt: this.#now(),
      },
      writesConflictMarkers: false,
    };
  }

  /**
   * Build a resolution edit plan for a single conflict. Still never emits
   * `<<<<<<<` markers into file content.
   */
  resolutionPlan(conflict: MergeConflict, choice: "ours" | "theirs" | "manual", manualText?: string): MergeEditPlan {
    let content: string;
    if (choice === "ours") content = conflict.oursText ?? "";
    else if (choice === "theirs") content = conflict.theirsText ?? "";
    else {
      if (manualText === undefined) {
        throw new MergeCoordinatorError("MERGE_MANUAL_REQUIRED", "manual resolution requires text");
      }
      if (containsConflictMarkers(manualText)) {
        throw new MergeCoordinatorError(
          "MERGE_CONFLICT_MARKERS_FORBIDDEN",
          "resolution text must not contain conflict markers",
        );
      }
      content = manualText;
    }
    if (containsConflictMarkers(content)) {
      throw new MergeCoordinatorError(
        "MERGE_CONFLICT_MARKERS_FORBIDDEN",
        "resolved content must not contain conflict markers",
      );
    }
    return {
      schemaVersion: "1.0",
      id: this.#newId(),
      source: "merge",
      operations: [{
        operationId: "edo_resolve_1",
        kind: "replace_file",
        path: conflict.path,
        content,
      }],
      conflictPolicy: "fail",
      createdAt: this.#now(),
    };
  }
}

type FileMergeOutcome =
  | { readonly kind: "clean"; readonly file: MergeCleanFile }
  | { readonly kind: "conflict"; readonly conflict: MergeConflict };

function mergeFile(file: MergeFileInput, newId: () => string): FileMergeOutcome {
  const base = file.baseText;
  const ours = file.oursText;
  const theirs = file.theirsText;

  if (ours === undefined && theirs === undefined) {
    return {
      kind: "clean",
      file: {
        path: file.path,
        resultText: base ?? "",
        resolution: "base",
      },
    };
  }
  if (ours !== undefined && theirs === undefined) {
    return { kind: "clean", file: { path: file.path, resultText: ours, resolution: "ours" } };
  }
  if (theirs !== undefined && ours === undefined) {
    return { kind: "clean", file: { path: file.path, resultText: theirs, resolution: "theirs" } };
  }
  if (ours === theirs) {
    return { kind: "clean", file: { path: file.path, resultText: ours!, resolution: "merged" } };
  }
  if (base !== undefined && ours === base && theirs !== undefined) {
    return { kind: "clean", file: { path: file.path, resultText: theirs, resolution: "theirs" } };
  }
  if (base !== undefined && theirs === base && ours !== undefined) {
    return { kind: "clean", file: { path: file.path, resultText: ours, resolution: "ours" } };
  }

  if (ours === undefined || theirs === undefined) {
    return {
      kind: "conflict",
      conflict: {
        id: newId(),
        path: file.path,
        kind: "delete_modify",
        ...(base !== undefined ? { baseText: base } : {}),
        ...(ours !== undefined ? { oursText: ours } : {}),
        ...(theirs !== undefined ? { theirsText: theirs } : {}),
        proposals: [],
        resolutionOptions: ["ours", "theirs", "manual", "replan"],
      },
    };
  }

  return {
    kind: "conflict",
    conflict: {
      id: newId(),
      path: file.path,
      kind: "content",
      ...(base !== undefined ? { baseText: base } : {}),
      oursText: ours,
      theirsText: theirs,
      ranges: overlappingRanges(ours, theirs),
      proposals: [],
      resolutionOptions: ["ours", "theirs", "manual", "replan"],
    },
  };
}

function overlappingRanges(ours: string, theirs: string): TextRange[] {
  const left = ours.split("\n");
  const right = theirs.split("\n");
  const max = Math.max(left.length, right.length);
  const ranges: TextRange[] = [];
  let start: number | undefined;
  for (let line = 1; line <= max; line += 1) {
    const a = left[line - 1] ?? "";
    const b = right[line - 1] ?? "";
    if (a !== b) {
      if (start === undefined) start = line;
    } else if (start !== undefined) {
      ranges.push({ startLine: start, endLine: line });
      start = undefined;
    }
  }
  if (start !== undefined) ranges.push({ startLine: start, endLine: max + 1 });
  return ranges;
}

export function containsConflictMarkers(text: string): boolean {
  return text.includes("<<<<<<<") || text.includes(">>>>>>>") || text.includes("=======");
}
