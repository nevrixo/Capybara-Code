import { evidenceDigest } from "./evidence.ts";
import { isSensitivePath } from "./selection.ts";
import { globMatch } from "@cbc/tool-registry";

/** Deterministic P3 working-view operations from RFC §9.3. */

export interface ContextRange {
  /** Inclusive, one-based line. */
  readonly startLine: number;
  /** Inclusive, one-based line. */
  readonly endLine: number;
}

/** RFC-compatible short name. */
export type Range = ContextRange;

export interface StructuredCompactStateV2 {
  readonly schemaVersion: "2";
  readonly task: {
    readonly goal: string;
    readonly constraints: readonly string[];
    readonly acceptanceCriteria: readonly string[];
  };
  readonly decisions: readonly {
    readonly text: string;
    readonly status: "active" | "superseded";
    readonly evidenceIds: readonly string[];
  }[];
  readonly assumptions: readonly {
    readonly text: string;
    readonly confidence: number;
    readonly evidenceIds: readonly string[];
  }[];
  readonly changedSymbols: readonly {
    readonly path: string;
    readonly symbol?: string;
    readonly purpose: string;
    readonly checksum?: string;
  }[];
  readonly verification: readonly {
    readonly command: string;
    readonly status: "passed" | "failed" | "not_run";
    readonly evidenceIds: readonly string[];
  }[];
  readonly unresolved: readonly {
    readonly issue: string;
    readonly attempted: readonly string[];
    readonly nextAction: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly memoryHandles: readonly string[];
}

export type ContextOp =
  | { readonly kind: "keep"; readonly ids: readonly string[] }
  | { readonly kind: "snippet"; readonly id: string; readonly range: ContextRange }
  | { readonly kind: "compress"; readonly ids: readonly string[]; readonly into: StructuredCompactStateV2 }
  | { readonly kind: "delete"; readonly ids: readonly string[]; readonly reason: string }
  | { readonly kind: "rollback"; readonly checkpointId: string; readonly preserveEvidence: readonly string[] }
  | { readonly kind: "offload"; readonly ids: readonly string[]; readonly artifactId: string }
  | { readonly kind: "recall"; readonly evidenceIds: readonly string[] };

export type ContextWorkingResolution = "full" | "snippet" | "summary" | "handle";

/** Immutable source observation registered with the operation engine. */
export interface ContextSourceItem {
  readonly id: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly estimatedTokens?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** Materialized item in the current, replaceable working view. */
export interface ContextWorkingItem extends ContextSourceItem {
  readonly sourceId: string;
  readonly resolution: ContextWorkingResolution;
  readonly range?: ContextRange;
  readonly artifactId?: string;
  readonly structuredState?: StructuredCompactStateV2;
}

export interface ContextOffloadRecord {
  readonly artifactId: string;
  readonly sourceItemIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly handleItemId: string;
  readonly digest: string;
}

export interface ContextOperationBoundary {
  readonly allowedItemIds?: ReadonlySet<string>;
  readonly allowedEvidenceIds?: ReadonlySet<string>;
  readonly allowedCheckpointIds?: ReadonlySet<string>;
}

export interface ContextOperationLogEntry {
  readonly sequence: number;
  readonly op: ContextOp;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly changedItemIds: readonly string[];
  readonly at: string;
}

export interface ContextRollbackLogEntry {
  readonly sequence: number;
  readonly checkpointId: string;
  readonly preserveEvidence: readonly string[];
  readonly restoredItemIds: readonly string[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly at: string;
}

export interface ContextCheckpoint {
  readonly id: string;
  readonly createdAt: string;
  readonly workingItems: readonly ContextWorkingItem[];
  readonly keptItemIds: readonly string[];
  readonly digest: string;
}

export interface ContextOperationResult {
  readonly op: ContextOp;
  readonly createdItemIds: readonly string[];
  readonly removedItemIds: readonly string[];
  readonly changedItemIds: readonly string[];
  readonly workingDigest: string;
  readonly logEntry: ContextOperationLogEntry;
}

export type TryContextOperationResult =
  | { readonly ok: true; readonly result: ContextOperationResult }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface ContextOperationsOptions {
  readonly items?: readonly ContextSourceItem[];
  /** Omitted means every registered source item starts active. */
  readonly activeIds?: readonly string[];
  readonly now?: () => string;
}

export interface ContextOperationsSnapshot {
  readonly schemaVersion: "1";
  readonly sourceItems: readonly ContextSourceItem[];
  readonly derivedItems: readonly ContextWorkingItem[];
  readonly workingItems: readonly ContextWorkingItem[];
  readonly keptItemIds: readonly string[];
  readonly checkpoints: readonly ContextCheckpoint[];
  readonly offloads: readonly ContextOffloadRecord[];
  readonly operationLog: readonly ContextOperationLogEntry[];
  readonly rollbackLog: readonly ContextRollbackLogEntry[];
}

export class ContextOperationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "ContextOperationError";
    this.issues = freezeArray([...issues]);
  }
}

/**
 * Evidence store and working view are deliberately separate. delete, compress,
 * offload, and rollback mutate only the view; registered exact source items are
 * immutable and remain recallable by evidence ID.
 */
export class ContextOperations {
  readonly #source = new Map<string, ContextSourceItem>();
  readonly #derived = new Map<string, ContextWorkingItem>();
  readonly #working = new Map<string, ContextWorkingItem>();
  readonly #kept = new Set<string>();
  readonly #checkpoints = new Map<string, ContextCheckpoint>();
  readonly #offloads = new Map<string, ContextOffloadRecord>();
  readonly #operationLog: ContextOperationLogEntry[] = [];
  readonly #rollbackLog: ContextRollbackLogEntry[] = [];
  readonly #now: () => string;
  #sequence = 0;

  constructor(options: ContextOperationsOptions | readonly ContextSourceItem[] = {}) {
    const normalized: ContextOperationsOptions = isSourceItemArray(options) ? { items: options } : options;
    this.#now = normalized.now ?? (() => new Date().toISOString());
    this.register(normalized.items ?? [], { activate: false });
    const activeIds = normalized.activeIds ?? [...this.#source.keys()];
    for (const id of sortedUnique(activeIds)) {
      const source = this.#source.get(id);
      if (source === undefined) throw new ContextOperationError([`unknown initial context item: ${id}`]);
      this.#working.set(id, sourceToWorking(source));
    }
  }

  get size(): number {
    return this.#working.size;
  }

  /** Add immutable evidence/source observations. Conflicting reuse of an ID is rejected. */
  register(
    items: readonly ContextSourceItem[],
    options: { readonly activate?: boolean } = {},
  ): readonly ContextSourceItem[] {
    const normalized = items.map(normalizeSourceItem);
    const seen = new Set<string>();
    for (const item of normalized) {
      if (seen.has(item.id)) throw new ContextOperationError([`duplicate context item: ${item.id}`]);
      seen.add(item.id);
      const existing = this.#source.get(item.id);
      if (existing !== undefined && evidenceDigest(existing) !== evidenceDigest(item)) {
        throw new ContextOperationError([`context source item is immutable: ${item.id}`]);
      }
    }
    for (const item of normalized) {
      this.#source.set(item.id, item);
      if (options.activate === true) this.#working.set(item.id, sourceToWorking(item));
    }
    return freezeArray(normalized);
  }

  sourceItems(): readonly ContextSourceItem[] {
    return freezeArray([...this.#source.values()].sort(compareById));
  }

  workingItems(): readonly ContextWorkingItem[] {
    return freezeArray([...this.#working.values()].sort(compareById));
  }

  keptItemIds(): readonly string[] {
    return freezeArray([...this.#kept].sort());
  }

  knownItemIds(): ReadonlySet<string> {
    return freezeSet(new Set([...this.#source.keys(), ...this.#derived.keys()]));
  }

  knownEvidenceIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const item of [...this.#source.values(), ...this.#derived.values()]) {
      for (const id of item.evidenceIds) ids.add(id);
    }
    return freezeSet(ids);
  }

  checkpointIds(): ReadonlySet<string> {
    return freezeSet(new Set(this.#checkpoints.keys()));
  }

  offloads(): readonly ContextOffloadRecord[] {
    return freezeArray([...this.#offloads.values()].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId)
    ));
  }

  /** The complete operation audit is append-only and recursively frozen. */
  operationLog(): readonly ContextOperationLogEntry[] {
    return freezeArray([...this.#operationLog]);
  }

  /** Rollbacks never truncate this log or the operation log they reverse. */
  rollbackLog(): readonly ContextRollbackLogEntry[] {
    return freezeArray([...this.#rollbackLog]);
  }

  workingDigest(): string {
    return digestWorking(this.#working, this.#kept);
  }

  createCheckpoint(id?: string): ContextCheckpoint {
    const checkpointId = id?.trim() || `checkpoint-${this.#sequence + 1}-${this.workingDigest().slice(0, 16)}`;
    if (this.#checkpoints.has(checkpointId)) {
      throw new ContextOperationError([`checkpoint already exists: ${checkpointId}`]);
    }
    const createdAt = this.#now();
    if (!isTimestamp(createdAt)) throw new ContextOperationError(["context operation clock must return an ISO timestamp"]);
    const workingItems = this.workingItems().map(cloneWorkingItem);
    const keptItemIds = this.keptItemIds();
    const digest = evidenceDigest({ workingItems, keptItemIds });
    const checkpoint = deepFreeze({
      id: checkpointId,
      createdAt,
      workingItems,
      keptItemIds,
      digest,
    });
    this.#checkpoints.set(checkpointId, checkpoint);
    return checkpoint;
  }

  apply(op: ContextOp, boundary: ContextOperationBoundary = {}): ContextOperationResult {
    const effectiveBoundary: ContextOperationBoundary = {
      allowedItemIds: boundary.allowedItemIds ?? this.knownItemIds(),
      allowedEvidenceIds: boundary.allowedEvidenceIds ?? this.knownEvidenceIds(),
      allowedCheckpointIds: boundary.allowedCheckpointIds ?? this.checkpointIds(),
    };
    const issues = validateContextOp(op, effectiveBoundary);
    if (issues.length > 0) throw new ContextOperationError(issues);

    const now = this.#now();
    if (!isTimestamp(now)) throw new ContextOperationError(["context operation clock must return an ISO timestamp"]);
    const normalizedOp = normalizeContextOp(op);
    const beforeDigest = this.workingDigest();
    const working = new Map(this.#working);
    const kept = new Set(this.#kept);
    const derived = new Map(this.#derived);
    const offloads = new Map(this.#offloads);
    const created = new Set<string>();
    const removed = new Set<string>();
    const changed = new Set<string>();
    let rollbackDetails: Omit<ContextRollbackLogEntry, "sequence" | "beforeDigest" | "afterDigest" | "at"> | undefined;

    switch (normalizedOp.kind) {
      case "keep": {
        for (const id of normalizedOp.ids) {
          const existing = working.get(id);
          const item = existing ?? this.#materializeKnown(id, derived);
          if (item === undefined) throw new ContextOperationError([`unknown context item: ${id}`]);
          if (existing === undefined) {
            working.set(id, item);
            created.add(id);
          }
          kept.add(id);
          changed.add(id);
        }
        break;
      }
      case "snippet": {
        const current = working.get(normalizedOp.id) ?? this.#materializeKnown(normalizedOp.id, derived);
        if (current === undefined) throw new ContextOperationError([`unknown context item: ${normalizedOp.id}`]);
        const source = this.#source.get(current.sourceId);
        const base = source === undefined ? current : sourceToWorking(source);
        const lines = splitLines(base.text);
        if (normalizedOp.range.endLine > lines.length) {
          throw new ContextOperationError([
            `snippet range ${normalizedOp.range.startLine}-${normalizedOp.range.endLine} exceeds ${lines.length} lines for ${normalizedOp.id}`,
          ]);
        }
        const snippet = freezeWorkingItem({
          ...base,
          text: lines.slice(normalizedOp.range.startLine - 1, normalizedOp.range.endLine).join("\n"),
          resolution: "snippet",
          range: normalizedOp.range,
          estimatedTokens: estimateTokens(lines.slice(normalizedOp.range.startLine - 1, normalizedOp.range.endLine).join("\n")),
        });
        working.set(normalizedOp.id, snippet);
        if (!this.#working.has(normalizedOp.id)) created.add(normalizedOp.id);
        changed.add(normalizedOp.id);
        break;
      }
      case "compress": {
        const inputs = normalizedOp.ids.map((id) => working.get(id));
        const missing = normalizedOp.ids.filter((_id, index) => inputs[index] === undefined);
        if (missing.length > 0) {
          throw new ContextOperationError(missing.map((id) => `cannot compress an inactive context item: ${id}`));
        }
        const evidenceIds = sortedUnique([
          ...inputs.flatMap((item) => item?.evidenceIds ?? []),
          ...structuredStateEvidenceIds(normalizedOp.into),
        ]);
        const compactId = `compact-${evidenceDigest({ ids: normalizedOp.ids, into: normalizedOp.into })}`;
        const compactText = renderStructuredCompactState(normalizedOp.into);
        const compact = freezeWorkingItem({
          id: compactId,
          sourceId: compactId,
          text: compactText,
          evidenceIds,
          estimatedTokens: estimateTokens(compactText),
          resolution: "summary",
          structuredState: normalizedOp.into,
        });
        for (const id of normalizedOp.ids) {
          if (working.delete(id)) removed.add(id);
          kept.delete(id);
          changed.add(id);
        }
        derived.set(compactId, compact);
        working.set(compactId, compact);
        created.add(compactId);
        changed.add(compactId);
        break;
      }
      case "delete": {
        // Deletion is only prompt eviction. #source and #derived remain intact.
        for (const id of normalizedOp.ids) {
          if (working.delete(id)) {
            removed.add(id);
            changed.add(id);
          }
          kept.delete(id);
        }
        break;
      }
      case "rollback": {
        const checkpoint = this.#checkpoints.get(normalizedOp.checkpointId);
        if (checkpoint === undefined) throw new ContextOperationError([`unknown checkpoint: ${normalizedOp.checkpointId}`]);
        if (checkpoint.digest !== evidenceDigest({
          workingItems: checkpoint.workingItems,
          keptItemIds: checkpoint.keptItemIds,
        })) throw new ContextOperationError([`checkpoint digest mismatch: ${checkpoint.id}`]);

        const preserved = new Map<string, ContextWorkingItem>();
        for (const evidenceId of normalizedOp.preserveEvidence) {
          const matches = this.#itemsForEvidence(evidenceId, working, derived);
          if (matches.length === 0) throw new ContextOperationError([`unknown preserved evidence: ${evidenceId}`]);
          for (const item of matches) preserved.set(item.id, item);
        }
        const beforeIds = new Set(working.keys());
        working.clear();
        for (const item of checkpoint.workingItems) working.set(item.id, cloneWorkingItem(item));
        for (const item of preserved.values()) working.set(item.id, cloneWorkingItem(item));
        kept.clear();
        for (const id of checkpoint.keptItemIds) kept.add(id);
        for (const id of beforeIds) {
          if (!working.has(id)) removed.add(id);
        }
        for (const id of working.keys()) {
          if (!this.#working.has(id)) created.add(id);
          changed.add(id);
        }
        rollbackDetails = {
          checkpointId: checkpoint.id,
          preserveEvidence: normalizedOp.preserveEvidence,
          restoredItemIds: [...working.keys()].sort(),
        };
        break;
      }
      case "offload": {
        const inputs = normalizedOp.ids.map((id) => working.get(id));
        const missing = normalizedOp.ids.filter((_id, index) => inputs[index] === undefined);
        if (missing.length > 0) {
          throw new ContextOperationError(missing.map((id) => `cannot offload an inactive context item: ${id}`));
        }
        const evidenceIds = sortedUnique(inputs.flatMap((item) => item?.evidenceIds ?? []));
        const digest = evidenceDigest({
          artifactId: normalizedOp.artifactId,
          sourceItemIds: normalizedOp.ids,
          evidenceIds,
        });
        const handleItemId = `offload-${digest}`;
        const handleText = `<artifact id="${normalizedOp.artifactId}" evidence="${evidenceIds.join(",")}" />`;
        const handle = freezeWorkingItem({
          id: handleItemId,
          sourceId: handleItemId,
          text: handleText,
          evidenceIds,
          estimatedTokens: estimateTokens(handleText),
          resolution: "handle",
          artifactId: normalizedOp.artifactId,
        });
        const record = deepFreeze({
          artifactId: normalizedOp.artifactId,
          sourceItemIds: normalizedOp.ids,
          evidenceIds,
          handleItemId,
          digest,
        });
        for (const id of normalizedOp.ids) {
          working.delete(id);
          kept.delete(id);
          removed.add(id);
          changed.add(id);
        }
        derived.set(handleItemId, handle);
        working.set(handleItemId, handle);
        offloads.set(normalizedOp.artifactId, record);
        created.add(handleItemId);
        changed.add(handleItemId);
        break;
      }
      case "recall": {
        for (const evidenceId of normalizedOp.evidenceIds) {
          const matches = this.#itemsForEvidence(evidenceId, working, derived);
          if (matches.length === 0) throw new ContextOperationError([`unknown evidence: ${evidenceId}`]);
          for (const match of matches) {
            const source = this.#source.get(match.sourceId);
            const recalled = source === undefined ? match : sourceToWorking(source);
            if (!working.has(recalled.id)) created.add(recalled.id);
            working.set(recalled.id, recalled);
            changed.add(recalled.id);
          }
        }
        break;
      }
      default:
        assertNever(normalizedOp);
    }

    const afterDigest = digestWorking(working, kept);
    this.#commitMaps(working, kept, derived, offloads);
    this.#sequence += 1;
    const logEntry = freezeOperationLogEntry({
      sequence: this.#sequence,
      op: normalizedOp,
      beforeDigest,
      afterDigest,
      changedItemIds: [...changed].sort(),
      at: now,
    });
    this.#operationLog.push(logEntry);
    if (rollbackDetails !== undefined) {
      this.#rollbackLog.push(deepFreeze({
        sequence: this.#sequence,
        ...rollbackDetails,
        beforeDigest,
        afterDigest,
        at: now,
      }));
    }
    return deepFreeze({
      op: normalizedOp,
      createdItemIds: [...created].sort(),
      removedItemIds: [...removed].sort(),
      changedItemIds: [...changed].sort(),
      workingDigest: afterDigest,
      logEntry,
    });
  }

  tryApply(op: ContextOp, boundary: ContextOperationBoundary = {}): TryContextOperationResult {
    try {
      return freezeObject({ ok: true, result: this.apply(op, boundary) });
    } catch (error) {
      if (error instanceof ContextOperationError) {
        return freezeObject({ ok: false, issues: error.issues });
      }
      throw error;
    }
  }

  applyAll(ops: readonly ContextOp[], boundary: ContextOperationBoundary = {}): readonly ContextOperationResult[] {
    return freezeArray(ops.map((op) => this.apply(op, boundary)));
  }

  snapshot(): ContextOperationsSnapshot {
    return deepFreeze({
      schemaVersion: "1",
      sourceItems: this.sourceItems().map(cloneSourceItem),
      derivedItems: [...this.#derived.values()].sort(compareById).map(cloneWorkingItem),
      workingItems: this.workingItems().map(cloneWorkingItem),
      keptItemIds: this.keptItemIds(),
      checkpoints: [...this.#checkpoints.values()].sort(compareById).map(cloneCheckpoint),
      offloads: this.offloads().map(cloneOffload),
      operationLog: this.#operationLog.map(cloneOperationLogEntry),
      rollbackLog: this.#rollbackLog.map(cloneRollbackLogEntry),
    });
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  static fromSnapshot(
    snapshot: ContextOperationsSnapshot,
    options: { readonly now?: () => string } = {},
  ): ContextOperations {
    if (snapshot.schemaVersion !== "1") throw new Error("unsupported context operations snapshot schema");
    const operations = new ContextOperations({ items: snapshot.sourceItems, activeIds: [], ...options });
    for (const item of snapshot.derivedItems) operations.#derived.set(item.id, freezeWorkingItem(item));
    for (const item of snapshot.workingItems) {
      if (!operations.#source.has(item.sourceId) && !operations.#derived.has(item.id)) {
        throw new Error(`working item has no immutable source: ${item.id}`);
      }
      operations.#working.set(item.id, freezeWorkingItem(item));
    }
    for (const id of snapshot.keptItemIds) {
      if (!operations.#working.has(id)) throw new Error(`kept item is not active: ${id}`);
      operations.#kept.add(id);
    }
    for (const checkpoint of snapshot.checkpoints) {
      const cloned = cloneCheckpoint(checkpoint);
      if (cloned.digest !== evidenceDigest({
        workingItems: cloned.workingItems,
        keptItemIds: cloned.keptItemIds,
      })) throw new Error(`checkpoint digest mismatch: ${cloned.id}`);
      operations.#checkpoints.set(cloned.id, cloned);
    }
    for (const offload of snapshot.offloads) operations.#offloads.set(offload.artifactId, cloneOffload(offload));
    let expected = 1;
    for (const entry of snapshot.operationLog) {
      if (entry.sequence !== expected) throw new Error("context operation log sequence is not contiguous");
      operations.#operationLog.push(cloneOperationLogEntry(entry));
      expected += 1;
    }
    for (const entry of snapshot.rollbackLog) {
      if (!snapshot.operationLog.some((operation) => operation.sequence === entry.sequence && operation.op.kind === "rollback")) {
        throw new Error("rollback log does not reference a rollback operation");
      }
      operations.#rollbackLog.push(cloneRollbackLogEntry(entry));
    }
    operations.#sequence = expected - 1;
    return operations;
  }

  static deserialize(serialized: string, options: { readonly now?: () => string } = {}): ContextOperations {
    const parsed: unknown = JSON.parse(serialized);
    if (!isObject(parsed) || parsed.schemaVersion !== "1") throw new Error("invalid context operations snapshot");
    return ContextOperations.fromSnapshot(parsed as unknown as ContextOperationsSnapshot, options);
  }

  #materializeKnown(id: string, derived: ReadonlyMap<string, ContextWorkingItem>): ContextWorkingItem | undefined {
    const source = this.#source.get(id);
    if (source !== undefined) return sourceToWorking(source);
    return derived.get(id);
  }

  #itemsForEvidence(
    evidenceId: string,
    working: ReadonlyMap<string, ContextWorkingItem>,
    derived: ReadonlyMap<string, ContextWorkingItem>,
  ): ContextWorkingItem[] {
    const matches = new Map<string, ContextWorkingItem>();
    for (const source of this.#source.values()) {
      if (source.evidenceIds.includes(evidenceId)) matches.set(source.id, sourceToWorking(source));
    }
    for (const item of derived.values()) {
      if (item.evidenceIds.includes(evidenceId) && !matches.has(item.id)) matches.set(item.id, item);
    }
    for (const item of working.values()) {
      if (item.evidenceIds.includes(evidenceId)) matches.set(item.id, item);
    }
    return [...matches.values()].sort(compareById);
  }

  #commitMaps(
    working: ReadonlyMap<string, ContextWorkingItem>,
    kept: ReadonlySet<string>,
    derived: ReadonlyMap<string, ContextWorkingItem>,
    offloads: ReadonlyMap<string, ContextOffloadRecord>,
  ): void {
    this.#working.clear();
    for (const [id, item] of working) this.#working.set(id, item);
    this.#kept.clear();
    for (const id of kept) this.#kept.add(id);
    this.#derived.clear();
    for (const [id, item] of derived) this.#derived.set(id, item);
    this.#offloads.clear();
    for (const [id, record] of offloads) this.#offloads.set(id, record);
  }
}

/** Shape and evidence-boundary validation for learned or model-proposed ops. */
export function validateContextOp(
  value: unknown,
  boundary: ContextOperationBoundary = {},
): readonly string[] {
  if (!isObject(value) || typeof value.kind !== "string") return freezeArray(["context operation must be an object with a kind"]);
  const issues: string[] = [];
  const itemIds = boundary.allowedItemIds;
  const evidenceIds = boundary.allowedEvidenceIds;
  const checkpointIds = boundary.allowedCheckpointIds;
  switch (value.kind) {
    case "keep":
    case "delete":
    case "offload":
    case "compress": {
      validateIds(value.ids, `${value.kind}.ids`, issues, itemIds);
      if (value.kind === "delete" && !nonEmptyString(value.reason)) issues.push("delete.reason is required");
      if (value.kind === "offload" && !nonEmptyString(value.artifactId)) issues.push("offload.artifactId is required");
      if (value.kind === "compress") issues.push(...structuredCompactStateIssues(value.into, evidenceIds));
      break;
    }
    case "snippet": {
      if (!nonEmptyString(value.id)) issues.push("snippet.id is required");
      else if (itemIds !== undefined && !itemIds.has(value.id)) issues.push(`item is outside the operation boundary: ${value.id}`);
      if (!isObject(value.range) || !positiveInteger(value.range.startLine) || !positiveInteger(value.range.endLine)) {
        issues.push("snippet.range must contain positive integer startLine/endLine");
      } else if (value.range.startLine > value.range.endLine) {
        issues.push("snippet.range startLine must not exceed endLine");
      }
      break;
    }
    case "rollback": {
      if (!nonEmptyString(value.checkpointId)) issues.push("rollback.checkpointId is required");
      else if (checkpointIds !== undefined && !checkpointIds.has(value.checkpointId)) {
        issues.push(`checkpoint is outside the operation boundary: ${value.checkpointId}`);
      }
      validateIds(value.preserveEvidence, "rollback.preserveEvidence", issues, evidenceIds, true);
      break;
    }
    case "recall":
      validateIds(value.evidenceIds, "recall.evidenceIds", issues, evidenceIds);
      break;
    default:
      issues.push(`unsupported context operation kind: ${value.kind}`);
  }
  return freezeArray(sortedUnique(issues));
}

export function structuredCompactStateIssues(
  value: unknown,
  knownEvidenceIds?: ReadonlySet<string>,
): readonly string[] {
  if (!isObject(value)) return freezeArray(["compact state must be an object"]);
  const issues: string[] = [];
  if (value.schemaVersion !== "2") issues.push('compact state schemaVersion must be "2"');
  if (!isObject(value.task)) issues.push("compact state task is required");
  else {
    if (!nonEmptyString(value.task.goal)) issues.push("compact state task.goal is required");
    validateStringArray(value.task.constraints, "compact state task.constraints", issues, true);
    validateStringArray(value.task.acceptanceCriteria, "compact state task.acceptanceCriteria", issues, true);
  }
  validateObjectArray(value.decisions, "compact state decisions", issues, (entry, index) => {
    if (!nonEmptyString(entry.text)) issues.push(`compact state decisions[${index}].text is required`);
    if (entry.status !== "active" && entry.status !== "superseded") issues.push(`compact state decisions[${index}].status is invalid`);
    validateIds(entry.evidenceIds, `compact state decisions[${index}].evidenceIds`, issues, knownEvidenceIds);
  });
  validateObjectArray(value.assumptions, "compact state assumptions", issues, (entry, index) => {
    if (!nonEmptyString(entry.text)) issues.push(`compact state assumptions[${index}].text is required`);
    if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      issues.push(`compact state assumptions[${index}].confidence must be between 0 and 1`);
    }
    validateIds(entry.evidenceIds, `compact state assumptions[${index}].evidenceIds`, issues, knownEvidenceIds);
  });
  validateObjectArray(value.changedSymbols, "compact state changedSymbols", issues, (entry, index) => {
    if (!validRelativePath(entry.path)) issues.push(`compact state changedSymbols[${index}].path is invalid`);
    if (!nonEmptyString(entry.purpose)) issues.push(`compact state changedSymbols[${index}].purpose is required`);
    if (entry.symbol !== undefined && !nonEmptyString(entry.symbol)) issues.push(`compact state changedSymbols[${index}].symbol is invalid`);
    if (entry.checksum !== undefined && !nonEmptyString(entry.checksum)) issues.push(`compact state changedSymbols[${index}].checksum is invalid`);
  });
  validateObjectArray(value.verification, "compact state verification", issues, (entry, index) => {
    if (!nonEmptyString(entry.command)) issues.push(`compact state verification[${index}].command is required`);
    if (!["passed", "failed", "not_run"].includes(String(entry.status))) issues.push(`compact state verification[${index}].status is invalid`);
    validateIds(
      entry.evidenceIds,
      `compact state verification[${index}].evidenceIds`,
      issues,
      knownEvidenceIds,
      entry.status === "not_run",
    );
  });
  validateObjectArray(value.unresolved, "compact state unresolved", issues, (entry, index) => {
    if (!nonEmptyString(entry.issue)) issues.push(`compact state unresolved[${index}].issue is required`);
    validateStringArray(entry.attempted, `compact state unresolved[${index}].attempted`, issues, true);
    if (!nonEmptyString(entry.nextAction)) issues.push(`compact state unresolved[${index}].nextAction is required`);
    validateIds(entry.evidenceIds, `compact state unresolved[${index}].evidenceIds`, issues, knownEvidenceIds, true);
  });
  validateStringArray(value.memoryHandles, "compact state memoryHandles", issues, true);
  return freezeArray(sortedUnique(issues));
}

export function isStructuredCompactStateV2(value: unknown): value is StructuredCompactStateV2 {
  return structuredCompactStateIssues(value).length === 0;
}

export function structuredStateEvidenceIds(state: StructuredCompactStateV2): readonly string[] {
  return freezeArray(sortedUnique([
    ...state.decisions.flatMap((entry) => entry.evidenceIds),
    ...state.assumptions.flatMap((entry) => entry.evidenceIds),
    ...state.verification.flatMap((entry) => entry.evidenceIds),
    ...state.unresolved.flatMap((entry) => entry.evidenceIds),
  ]));
}

export function renderStructuredCompactState(state: StructuredCompactStateV2): string {
  return JSON.stringify(normalizeStructuredState(state));
}

// ---------------------------------------------------------------------------
// Task-scoped sub-agent capsule (RFC §12)
// ---------------------------------------------------------------------------

export interface ContextSpan {
  readonly path: string;
  readonly checksum: string;
  readonly symbol?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly resolution: "signature" | "body" | "full";
  readonly reason: string;
}

export interface ContextCapsuleEvidenceRef {
  readonly id: string;
  readonly digest: string;
  readonly locator?: string;
  readonly observedAt?: string;
  readonly freshness?: "fresh" | "stale" | "invalid" | "unknown";
}

export interface ContextCapsuleBudget {
  readonly inputTokens: number;
  readonly toolCalls: number;
  readonly outputTokens?: number;
  readonly artifactBytes?: number;
}

export interface TaskContextCapsule {
  readonly schemaVersion: "1";
  readonly capsuleId: `context-capsule-${string}`;
  readonly taskId: string;
  readonly role: string;
  readonly workspaceIdentity?: string;
  readonly contract: {
    readonly goal: string;
    readonly deliverable: string;
    readonly allowedPaths: readonly string[];
    readonly forbiddenPaths?: readonly string[];
    readonly forbiddenActions: readonly string[];
  };
  readonly symbols: readonly ContextSpan[];
  readonly exactEvidenceIds: readonly string[];
  readonly evidenceRefs: readonly ContextCapsuleEvidenceRef[];
  /** Optional exact bodies scoped to the child contract. Legacy capsules omit it. */
  readonly scopedExactExcerpts?: readonly ScopedExactExcerpt[];
  readonly memoryHandles: readonly string[];
  readonly parentDecisions: readonly string[];
  readonly budget: ContextCapsuleBudget;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly digest: string;
}

/** Exact source body safe to hand to a child inside its path and input budget. */
export interface ScopedExactExcerpt {
  readonly evidenceId: string;
  readonly excerptId: `excerpt-${string}`;
  readonly path: string;
  readonly checksum: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly identityDigest: string;
  readonly bodyDigest: string;
}

/** Input form accepts omitted digests; the creator fills them deterministically. */
export type ScopedExactExcerptInput = Omit<ScopedExactExcerpt, "identityDigest" | "bodyDigest"> & {
  readonly identityDigest?: string;
  readonly bodyDigest?: string;
};

export type ContextCapsule = TaskContextCapsule;

export interface TaskContextCapsuleInput {
  readonly taskId: string;
  readonly role: string;
  readonly workspaceIdentity?: string;
  readonly contract: {
    readonly goal: string;
    readonly deliverable: string;
    readonly allowedPaths: readonly string[];
    readonly forbiddenPaths?: readonly string[];
    readonly forbiddenActions: readonly string[];
  };
  readonly symbols: readonly ContextSpan[];
  readonly evidenceRefs: readonly ContextCapsuleEvidenceRef[];
  readonly scopedExactExcerpts?: readonly ScopedExactExcerptInput[];
  readonly memoryHandles: readonly string[];
  readonly parentDecisions: readonly string[];
  readonly budget: ContextCapsuleBudget;
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

export interface ContextCapsuleValidationOptions {
  readonly now?: string;
  readonly resolveEvidence?: (id: string) => {
    readonly id: string;
    readonly digest: string;
    readonly freshness: "fresh" | "stale" | "invalid" | "unknown";
  } | undefined;
}

export interface ContextCapsuleValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface ChildEvidenceResult {
  readonly capsuleDigest?: string;
  readonly claims: readonly { readonly text: string; readonly evidenceIds: readonly string[] }[];
  readonly changedPaths: readonly string[];
  readonly tests: readonly string[];
  readonly unresolved: readonly string[];
}

export function createTaskContextCapsule(
  input: TaskContextCapsuleInput,
  options: { readonly now?: () => string } = {},
): TaskContextCapsule {
  const createdAt = input.createdAt ?? options.now?.() ?? new Date().toISOString();
  const normalizedInput = normalizeCapsuleInput(input, createdAt);
  const preDigest = {
    schemaVersion: "1" as const,
    taskId: normalizedInput.taskId,
    role: normalizedInput.role,
    ...(normalizedInput.workspaceIdentity !== undefined ? { workspaceIdentity: normalizedInput.workspaceIdentity } : {}),
    contract: normalizedInput.contract,
    symbols: normalizedInput.symbols,
    exactEvidenceIds: normalizedInput.evidenceRefs.map((reference) => reference.id),
    evidenceRefs: normalizedInput.evidenceRefs,
    ...(normalizedInput.scopedExactExcerpts === undefined
      ? {}
      : { scopedExactExcerpts: normalizedInput.scopedExactExcerpts }),
    memoryHandles: normalizedInput.memoryHandles,
    parentDecisions: normalizedInput.parentDecisions,
    budget: normalizedInput.budget,
    createdAt,
    ...(normalizedInput.expiresAt !== undefined ? { expiresAt: normalizedInput.expiresAt } : {}),
  };
  const digest = evidenceDigest(preDigest);
  const capsule = deepFreeze({
    ...preDigest,
    capsuleId: `context-capsule-${digest}` as `context-capsule-${string}`,
    digest,
  });
  const validation = validateTaskContextCapsule(capsule, { now: createdAt });
  if (!validation.valid) throw new ContextOperationError(validation.issues);
  return capsule;
}

/** Short alias for call sites that do not distinguish task capsule variants. */
export const createContextCapsule = createTaskContextCapsule;

export function validateTaskContextCapsule(
  capsule: TaskContextCapsule,
  options: ContextCapsuleValidationOptions = {},
): ContextCapsuleValidation {
  const issues = contextCapsuleIssues(capsule, options);
  return freezeObject({ valid: issues.length === 0, issues });
}

export const validateContextCapsule = validateTaskContextCapsule;

export function contextCapsuleIssues(
  capsule: TaskContextCapsule,
  options: ContextCapsuleValidationOptions = {},
): readonly string[] {
  const issues: string[] = [];
  if (capsule.schemaVersion !== "1") issues.push('context capsule schemaVersion must be "1"');
  if (!nonEmptyString(capsule.taskId)) issues.push("context capsule taskId is required");
  if (!nonEmptyString(capsule.role)) issues.push("context capsule role is required");
  if (!nonEmptyString(capsule.contract.goal)) issues.push("context capsule goal is required");
  if (!nonEmptyString(capsule.contract.deliverable)) issues.push("context capsule deliverable is required");
  if (capsule.contract.allowedPaths.length === 0) issues.push("context capsule must have an allowed path boundary");
  for (const path of capsule.contract.allowedPaths) {
    if (normalizeCapsulePath(path) !== path) issues.push(`context capsule allowed path is not canonical: ${path}`);
  }
  for (const path of capsule.contract.forbiddenPaths ?? []) {
    if (normalizeCapsulePath(path) !== path) issues.push(`context capsule forbidden path is not canonical: ${path}`);
  }
  if (!positiveInteger(capsule.budget.inputTokens)) issues.push("context capsule inputTokens must be a positive integer");
  if (!positiveInteger(capsule.budget.toolCalls)) issues.push("context capsule toolCalls must be a positive integer");
  if (capsule.budget.outputTokens !== undefined && !positiveInteger(capsule.budget.outputTokens)) issues.push("context capsule outputTokens must be a positive integer");
  if (capsule.budget.artifactBytes !== undefined && !positiveInteger(capsule.budget.artifactBytes)) issues.push("context capsule artifactBytes must be a positive integer");
  if (!isTimestamp(capsule.createdAt)) issues.push("context capsule createdAt is invalid");
  if (capsule.expiresAt !== undefined) {
    if (!isTimestamp(capsule.expiresAt)) issues.push("context capsule expiresAt is invalid");
    else if (options.now !== undefined && Date.parse(capsule.expiresAt) <= Date.parse(options.now)) issues.push("context capsule is expired");
  }
  const evidenceIds = capsule.evidenceRefs.map((reference) => reference.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) issues.push("context capsule evidence references must be unique");
  if (!sameStrings(evidenceIds, capsule.exactEvidenceIds)) issues.push("context capsule exactEvidenceIds do not match evidenceRefs");
  for (const reference of capsule.evidenceRefs) {
    if (!nonEmptyString(reference.id) || !nonEmptyString(reference.digest)) issues.push("context capsule evidence reference requires id and digest");
    if (reference.freshness !== undefined && reference.freshness !== "fresh") issues.push(`context capsule evidence is ${reference.freshness}: ${reference.id}`);
    const resolved = options.resolveEvidence?.(reference.id);
    if (options.resolveEvidence !== undefined && resolved === undefined) issues.push(`context capsule evidence is missing: ${reference.id}`);
    else if (resolved !== undefined) {
      if (resolved.id !== reference.id) issues.push(`context capsule evidence id mismatch: ${reference.id}`);
      if (resolved.digest !== reference.digest) issues.push(`context capsule evidence digest mismatch: ${reference.id}`);
      if (resolved.freshness !== "fresh") issues.push(`context capsule resolved evidence is ${resolved.freshness}: ${reference.id}`);
    }
  }
  const scoped = capsule.scopedExactExcerpts ?? [];
  const scopedIds = scoped.map((excerpt) => excerpt.excerptId);
  if (new Set(scopedIds).size !== scopedIds.length) {
    issues.push("context capsule scoped exact excerpt ids must be unique");
  }
  for (const excerpt of scoped) {
    if (!evidenceIds.includes(excerpt.evidenceId)) {
      issues.push(`context capsule scoped excerpt evidence is outside evidenceRefs: ${excerpt.evidenceId}`);
    }
    if (!nonEmptyString(excerpt.excerptId) || !nonEmptyString(excerpt.checksum)) {
      issues.push("context capsule scoped exact excerpt requires excerptId and checksum");
    }
    if (!pathAllowedByCapsule(capsule, excerpt.path)) {
      issues.push(`context capsule scoped excerpt is outside allowed paths: ${excerpt.path}`);
    }
    if (isSensitivePath(excerpt.path)) {
      issues.push(`context capsule scoped excerpt is sensitive: ${excerpt.path}`);
    }
    if (!validExactRange(excerpt.startLine, excerpt.endLine)) {
      issues.push(`context capsule scoped excerpt range is invalid: ${excerpt.path}`);
    }
    if (typeof excerpt.body !== "string") issues.push(`context capsule scoped excerpt body is invalid: ${excerpt.path}`);
    if (excerpt.bodyDigest !== scopedExactExcerptBodyDigest(excerpt.body)) {
      issues.push(`context capsule scoped excerpt body digest mismatch: ${excerpt.path}`);
    }
    if (excerpt.identityDigest !== scopedExactExcerptIdentityDigest(excerpt)) {
      issues.push(`context capsule scoped excerpt identity digest mismatch: ${excerpt.path}`);
    }
  }
  const scopedBodyTokens = scoped.reduce((sum, excerpt) => sum + estimateCapsuleTokens(excerpt.body), 0);
  if (scopedBodyTokens > capsule.budget.inputTokens) {
    issues.push("context capsule scoped exact excerpts exceed the input budget");
  }
  for (const symbol of capsule.symbols) {
    if (!pathAllowedByCapsule(capsule, symbol.path)) issues.push(`context capsule symbol is outside allowed paths: ${symbol.path}`);
    if (!positiveInteger(symbol.startLine) || !positiveInteger(symbol.endLine) || symbol.startLine > symbol.endLine) {
      issues.push(`context capsule symbol range is invalid: ${symbol.path}`);
    }
    if (!nonEmptyString(symbol.checksum) || !nonEmptyString(symbol.reason)) issues.push(`context capsule symbol lacks checksum/reason: ${symbol.path}`);
  }
  const payload = capsuleDigestPayload(capsule);
  const expected = evidenceDigest(payload);
  if (capsule.digest !== expected) issues.push("context capsule digest mismatch");
  if (capsule.capsuleId !== `context-capsule-${expected}`) issues.push("context capsule id mismatch");
  return freezeArray(sortedUnique(issues));
}

export function pathAllowedByCapsule(capsule: TaskContextCapsule, rawPath: string): boolean {
  const path = normalizeCapsulePath(rawPath);
  if (path === undefined) return false;
  const allowed = capsule.contract.allowedPaths.some((boundary) => pathWithinBoundary(path, boundary));
  const forbidden = (capsule.contract.forbiddenPaths ?? []).some((boundary) => pathWithinBoundary(path, boundary));
  return allowed && !forbidden;
}

export function validateChildEvidenceResult(
  capsule: TaskContextCapsule,
  result: ChildEvidenceResult,
): ContextCapsuleValidation {
  const issues: string[] = [];
  if (result.capsuleDigest !== undefined && result.capsuleDigest !== capsule.digest) issues.push("child result capsule digest mismatch");
  const allowedEvidence = new Set(capsule.exactEvidenceIds);
  for (const [index, claim] of result.claims.entries()) {
    if (!nonEmptyString(claim.text)) issues.push(`child claim ${index} has no text`);
    if (claim.evidenceIds.length === 0) issues.push(`child claim ${index} has no evidence`);
    for (const id of claim.evidenceIds) {
      if (!allowedEvidence.has(id)) issues.push(`child claim references evidence outside capsule: ${id}`);
    }
  }
  for (const path of result.changedPaths) {
    if (!pathAllowedByCapsule(capsule, path)) issues.push(`child changed path outside capsule: ${path}`);
  }
  return freezeObject({ valid: issues.length === 0, issues: freezeArray(sortedUnique(issues)) });
}

export function normalizeCapsulePath(rawPath: string): string | undefined {
  const path = rawPath.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  if (path === ".") return ".";
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}

export function scopedExactExcerptBodyDigest(body: string): string {
  return evidenceDigest(body);
}

export function scopedExactExcerptIdentityDigest(input: {
  readonly evidenceId: string;
  readonly excerptId: string;
  readonly path: string;
  readonly checksum: string;
  readonly startLine: number;
  readonly endLine: number;
}): string {
  return evidenceDigest({
    evidenceId: input.evidenceId,
    excerptId: input.excerptId,
    path: input.path,
    checksum: input.checksum,
    startLine: input.startLine,
    endLine: input.endLine,
  });
}

// ---------------------------------------------------------------------------
// Internal normalization / immutable helpers
// ---------------------------------------------------------------------------

function normalizeContextOp(op: ContextOp): ContextOp {
  switch (op.kind) {
    case "keep": return deepFreeze({ kind: "keep", ids: sortedUnique(op.ids) });
    case "snippet": return deepFreeze({ kind: "snippet", id: op.id.trim(), range: freezeObject({ ...op.range }) });
    case "compress": return deepFreeze({ kind: "compress", ids: sortedUnique(op.ids), into: normalizeStructuredState(op.into) });
    case "delete": return deepFreeze({ kind: "delete", ids: sortedUnique(op.ids), reason: op.reason.trim() });
    case "rollback": return deepFreeze({ kind: "rollback", checkpointId: op.checkpointId.trim(), preserveEvidence: sortedUnique(op.preserveEvidence) });
    case "offload": return deepFreeze({ kind: "offload", ids: sortedUnique(op.ids), artifactId: op.artifactId.trim() });
    case "recall": return deepFreeze({ kind: "recall", evidenceIds: sortedUnique(op.evidenceIds) });
    default: return assertNever(op);
  }
}

function normalizeStructuredState(state: StructuredCompactStateV2): StructuredCompactStateV2 {
  return deepFreeze({
    schemaVersion: "2",
    task: {
      goal: state.task.goal.trim(),
      constraints: state.task.constraints.map((value) => value.trim()),
      acceptanceCriteria: state.task.acceptanceCriteria.map((value) => value.trim()),
    },
    decisions: state.decisions.map((entry) => ({ ...entry, text: entry.text.trim(), evidenceIds: sortedUnique(entry.evidenceIds) })),
    assumptions: state.assumptions.map((entry) => ({ ...entry, text: entry.text.trim(), evidenceIds: sortedUnique(entry.evidenceIds) })),
    changedSymbols: state.changedSymbols.map((entry) => ({
      path: normalizeCapsulePath(entry.path) ?? entry.path,
      ...(entry.symbol !== undefined ? { symbol: entry.symbol.trim() } : {}),
      purpose: entry.purpose.trim(),
      ...(entry.checksum !== undefined ? { checksum: entry.checksum.trim() } : {}),
    })),
    verification: state.verification.map((entry) => ({ ...entry, command: entry.command.trim(), evidenceIds: sortedUnique(entry.evidenceIds) })),
    unresolved: state.unresolved.map((entry) => ({
      ...entry,
      issue: entry.issue.trim(),
      attempted: entry.attempted.map((value) => value.trim()),
      nextAction: entry.nextAction.trim(),
      evidenceIds: sortedUnique(entry.evidenceIds),
    })),
    memoryHandles: sortedUnique(state.memoryHandles.map((value) => value.trim())),
  });
}

function normalizeSourceItem(item: ContextSourceItem): ContextSourceItem {
  const issues: string[] = [];
  if (!nonEmptyString(item.id)) issues.push("context source id is required");
  if (typeof item.text !== "string") issues.push(`context source text is required: ${item.id}`);
  validateIds(item.evidenceIds, `context source evidenceIds (${item.id})`, issues);
  if (item.estimatedTokens !== undefined && (!Number.isInteger(item.estimatedTokens) || item.estimatedTokens < 0)) {
    issues.push(`context source estimatedTokens is invalid: ${item.id}`);
  }
  if (issues.length > 0) throw new ContextOperationError(issues);
  return deepFreeze({
    id: item.id.trim(),
    text: item.text,
    evidenceIds: sortedUnique(item.evidenceIds),
    estimatedTokens: item.estimatedTokens ?? estimateTokens(item.text),
    ...(item.metadata !== undefined ? { metadata: { ...item.metadata } } : {}),
  });
}

function sourceToWorking(source: ContextSourceItem): ContextWorkingItem {
  return freezeWorkingItem({
    ...source,
    sourceId: source.id,
    resolution: "full",
  });
}

function freezeWorkingItem(item: ContextWorkingItem): ContextWorkingItem {
  return deepFreeze({
    ...item,
    evidenceIds: [...item.evidenceIds],
    ...(item.metadata !== undefined ? { metadata: { ...item.metadata } } : {}),
    ...(item.range !== undefined ? { range: { ...item.range } } : {}),
    ...(item.structuredState !== undefined ? { structuredState: normalizeStructuredState(item.structuredState) } : {}),
  });
}

function cloneWorkingItem(item: ContextWorkingItem): ContextWorkingItem {
  return freezeWorkingItem({ ...item });
}

function cloneSourceItem(item: ContextSourceItem): ContextSourceItem {
  return normalizeSourceItem({ ...item });
}

function cloneCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
  return deepFreeze({
    ...checkpoint,
    workingItems: checkpoint.workingItems.map(cloneWorkingItem),
    keptItemIds: [...checkpoint.keptItemIds],
  });
}

function cloneOffload(offload: ContextOffloadRecord): ContextOffloadRecord {
  return deepFreeze({
    ...offload,
    sourceItemIds: [...offload.sourceItemIds],
    evidenceIds: [...offload.evidenceIds],
  });
}

function freezeOperationLogEntry(entry: ContextOperationLogEntry): ContextOperationLogEntry {
  return deepFreeze({ ...entry, op: normalizeContextOp(entry.op), changedItemIds: [...entry.changedItemIds] });
}

function cloneOperationLogEntry(entry: ContextOperationLogEntry): ContextOperationLogEntry {
  return freezeOperationLogEntry({ ...entry });
}

function cloneRollbackLogEntry(entry: ContextRollbackLogEntry): ContextRollbackLogEntry {
  return deepFreeze({
    ...entry,
    preserveEvidence: [...entry.preserveEvidence],
    restoredItemIds: [...entry.restoredItemIds],
  });
}

function digestWorking(
  working: ReadonlyMap<string, ContextWorkingItem>,
  kept: ReadonlySet<string>,
): string {
  return evidenceDigest({
    items: [...working.values()].sort(compareById),
    keptItemIds: [...kept].sort(),
  });
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function compareById<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function validateIds(
  value: unknown,
  label: string,
  issues: string[],
  allowed?: ReadonlySet<string>,
  allowEmpty = false,
): void {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return;
  }
  if (!allowEmpty && value.length === 0) issues.push(`${label} must not be empty`);
  for (const raw of value) {
    if (!nonEmptyString(raw)) issues.push(`${label} contains an invalid id`);
    else if (allowed !== undefined && !allowed.has(raw)) issues.push(`id is outside the operation boundary: ${raw}`);
  }
}

function validateStringArray(value: unknown, label: string, issues: string[], allowEmpty: boolean): void {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return;
  }
  if (!allowEmpty && value.length === 0) issues.push(`${label} must not be empty`);
  if (value.some((entry) => !nonEmptyString(entry))) issues.push(`${label} contains an empty value`);
}

function validateObjectArray(
  value: unknown,
  label: string,
  issues: string[],
  validate: (entry: Record<string, unknown>, index: number) => void,
): void {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return;
  }
  value.forEach((entry, index) => {
    if (!isObject(entry)) issues.push(`${label}[${index}] must be an object`);
    else validate(entry, index);
  });
}

type NormalizedTaskContextCapsuleInput = Omit<TaskContextCapsuleInput, "scopedExactExcerpts"> & {
  readonly scopedExactExcerpts?: readonly ScopedExactExcerpt[];
};

function normalizeCapsuleInput(
  input: TaskContextCapsuleInput,
  createdAt: string,
): NormalizedTaskContextCapsuleInput {
  const allowedPaths = input.contract.allowedPaths.map((path) => normalizeCapsulePath(path));
  const forbiddenPaths = input.contract.forbiddenPaths?.map((path) => normalizeCapsulePath(path));
  const issues: string[] = [];
  if (allowedPaths.some((path) => path === undefined)) issues.push("context capsule allowed paths must be workspace-relative");
  if (forbiddenPaths?.some((path) => path === undefined) === true) issues.push("context capsule forbidden paths must be workspace-relative");
  if (!isTimestamp(createdAt)) issues.push("context capsule createdAt is invalid");
  if (input.expiresAt !== undefined && (!isTimestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(createdAt))) {
    issues.push("context capsule expiresAt must be after createdAt");
  }
  if (issues.length > 0) throw new ContextOperationError(issues);
  const references = [...input.evidenceRefs]
    .map((reference) => deepFreeze({
      id: reference.id.trim(),
      digest: reference.digest.trim(),
      ...(reference.locator !== undefined ? { locator: reference.locator.trim() } : {}),
      ...(reference.observedAt !== undefined ? { observedAt: reference.observedAt } : {}),
      ...(reference.freshness !== undefined ? { freshness: reference.freshness } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const scopedExactExcerpts = input.scopedExactExcerpts === undefined
    ? undefined
    : input.scopedExactExcerpts
      .map((excerpt) => {
        const path = normalizeCapsulePath(excerpt.path) ?? excerpt.path;
        const base = {
          evidenceId: excerpt.evidenceId.trim(),
          excerptId: excerpt.excerptId,
          path,
          checksum: excerpt.checksum.trim(),
          startLine: excerpt.startLine,
          endLine: excerpt.endLine,
          body: excerpt.body,
        };
        return deepFreeze({
          ...base,
          identityDigest: excerpt.identityDigest ?? scopedExactExcerptIdentityDigest(base),
          bodyDigest: excerpt.bodyDigest ?? scopedExactExcerptBodyDigest(excerpt.body),
        });
      })
      .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.excerptId.localeCompare(right.excerptId));
  return deepFreeze({
    taskId: input.taskId.trim(),
    role: input.role.trim(),
    ...(input.workspaceIdentity !== undefined ? { workspaceIdentity: input.workspaceIdentity.trim() } : {}),
    contract: {
      goal: input.contract.goal.trim(),
      deliverable: input.contract.deliverable.trim(),
      allowedPaths: sortedUnique(allowedPaths.filter((path): path is string => path !== undefined)),
      ...(forbiddenPaths !== undefined
        ? { forbiddenPaths: sortedUnique(forbiddenPaths.filter((path): path is string => path !== undefined)) }
        : {}),
      forbiddenActions: sortedUnique(input.contract.forbiddenActions.map((action) => action.trim())),
    },
    symbols: [...input.symbols]
      .map((span) => ({
        ...span,
        path: normalizeCapsulePath(span.path) ?? span.path,
        ...(span.symbol !== undefined ? { symbol: span.symbol.trim() } : {}),
        reason: span.reason.trim(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine),
    evidenceRefs: references,
    ...(scopedExactExcerpts === undefined ? {} : { scopedExactExcerpts }),
    memoryHandles: sortedUnique(input.memoryHandles.map((value) => value.trim())),
    parentDecisions: input.parentDecisions.map((value) => value.trim()),
    budget: { ...input.budget },
    createdAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
}

function capsuleDigestPayload(capsule: TaskContextCapsule): object {
  return {
    schemaVersion: capsule.schemaVersion,
    taskId: capsule.taskId,
    role: capsule.role,
    ...(capsule.workspaceIdentity !== undefined ? { workspaceIdentity: capsule.workspaceIdentity } : {}),
    contract: capsule.contract,
    symbols: capsule.symbols,
    exactEvidenceIds: capsule.exactEvidenceIds,
    evidenceRefs: capsule.evidenceRefs,
    ...(capsule.scopedExactExcerpts === undefined
      ? {}
      : { scopedExactExcerpts: capsule.scopedExactExcerpts }),
    memoryHandles: capsule.memoryHandles,
    parentDecisions: capsule.parentDecisions,
    budget: capsule.budget,
    createdAt: capsule.createdAt,
    ...(capsule.expiresAt !== undefined ? { expiresAt: capsule.expiresAt } : {}),
  };
}

function pathWithinBoundary(path: string, boundary: string): boolean {
  if (boundary === ".") return true;
  if (/[*?[\]]/u.test(boundary)) return globMatch(boundary, path);
  return path === boundary || path.startsWith(`${boundary}/`);
}

function validExactRange(startLine: number, endLine: number): boolean {
  return positiveInteger(startLine) && Number.isInteger(endLine) && endLine >= startLine - 1;
}

function estimateCapsuleTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

function validRelativePath(value: unknown): value is string {
  return typeof value === "string" && normalizeCapsulePath(value) !== undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function isSourceItemArray(
  value: ContextOperationsOptions | readonly ContextSourceItem[],
): value is readonly ContextSourceItem[] {
  return Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values);
}

function freezeObject<T extends object>(value: T): Readonly<T> & T {
  return Object.freeze(value);
}

function freezeSet<T>(value: Set<T>): ReadonlySet<T> {
  // Expose a copy so callers cannot mutate engine state. ReadonlySet is the TS boundary.
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertNever(value: never): never {
  throw new Error(`unreachable context operation: ${JSON.stringify(value)}`);
}
