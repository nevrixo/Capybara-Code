import { evidenceDigest } from "./evidence.ts";

/**
 * Evidence-backed, scope-aware memory for the P3 context compiler.
 *
 * Memory records are durable indexes over immutable evidence. They are never a
 * replacement for that evidence: every accepted write is gated by resolvable,
 * fresh evidence and every state transition is recorded in an append-only log.
 */

export type MemoryScope = "workspace" | "session" | "task";
export type MemoryStatus = "active" | "superseded" | "contested";
export type MemoryEvidenceFreshness = "fresh" | "stale" | "invalid" | "unknown";

export interface MemoryValidity {
  readonly workspaceIdentity?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly paths?: readonly string[];
}

export interface MemoryRecord {
  readonly id: `memory-${string}`;
  readonly key: string;
  readonly value: string;
  readonly scope: MemoryScope;
  readonly status: MemoryStatus;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly validFor: MemoryValidity;
  readonly createdAt: string;
  readonly lastValidatedAt: string;
  readonly evidenceObservedAt: string;
  readonly exactEvidenceObservedAt?: string;
  readonly expiresAt?: string;
  readonly supersedes: readonly `memory-${string}`[];
  readonly supersededBy?: `memory-${string}` | undefined;
  readonly contestedWith: readonly `memory-${string}`[];
  readonly revision: number;
}

/** The structural subset of EvidenceRecord needed by the write gate. */
export interface MemoryEvidence {
  readonly id: string;
  readonly freshness: MemoryEvidenceFreshness;
  readonly observedAt: string;
  /** False for summaries or inferred claims. Omitted means an exact observation. */
  readonly exact?: boolean;
  readonly digest?: string;
  readonly kind?: string;
  readonly workspaceIdentity?: string;
  readonly workspaceIdentityDigest?: string;
  readonly expiresAt?: string;
}

export type MemoryEvidenceResolver = (id: string) => MemoryEvidence | undefined;

export interface MemoryWriteInput {
  readonly key: string;
  readonly value: string;
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly validFor?: MemoryValidity;
  readonly expiresAt?: string;
}

export interface MemoryQuery {
  readonly key?: string;
  readonly statuses?: readonly MemoryStatus[];
  readonly scopes?: readonly MemoryScope[];
  readonly workspaceIdentity?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly path?: string;
  readonly now?: string;
}

export interface MemoryConfidenceThresholds {
  readonly workspace: number;
  readonly session: number;
  readonly task: number;
}

export const DEFAULT_MEMORY_CONFIDENCE_THRESHOLDS: MemoryConfidenceThresholds = Object.freeze({
  workspace: 0.8,
  session: 0.5,
  task: 0.5,
});

export interface MemoryBankOptions {
  readonly resolveEvidence: MemoryEvidenceResolver;
  readonly workspaceIdentity?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly confidenceThresholds?: Partial<MemoryConfidenceThresholds>;
  /** Low-confidence workspace candidates can remain evidence-backed session memory. */
  readonly allowSessionFallback?: boolean;
  readonly now?: () => string;
}

export type MemoryWriteAction =
  | "created"
  | "revalidated"
  | "superseded_previous"
  | "superseded_by_existing"
  | "contested"
  | "session_only";

export interface AcceptedMemoryWrite {
  readonly accepted: true;
  readonly action: MemoryWriteAction;
  readonly record: MemoryRecord;
  readonly affectedRecords: readonly MemoryRecord[];
}

export interface RejectedMemoryWrite {
  readonly accepted: false;
  readonly action: "rejected";
  readonly reasons: readonly string[];
}

export type MemoryWriteResult = AcceptedMemoryWrite | RejectedMemoryWrite;

export interface MemoryTransition {
  readonly sequence: number;
  readonly recordId: `memory-${string}`;
  readonly fromStatus: MemoryStatus | "absent";
  readonly toStatus: MemoryStatus;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly at: string;
}

export interface MemoryBankSnapshot {
  readonly schemaVersion: "1";
  readonly records: readonly MemoryRecord[];
  readonly transitions: readonly MemoryTransition[];
}

export interface ContestResolutionInput {
  readonly winnerId: `memory-${string}`;
  readonly evidenceIds: readonly string[];
  readonly reason: string;
}

export interface ContestResolutionResult {
  readonly winner: MemoryRecord;
  readonly superseded: readonly MemoryRecord[];
}

interface ResolvedEvidence {
  readonly records: readonly MemoryEvidence[];
  readonly ids: readonly string[];
  readonly latestAt: string;
  readonly latestExactAt?: string;
}

interface NormalizedCandidate {
  readonly key: string;
  readonly value: string;
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly evidence: ResolvedEvidence;
  readonly validFor: MemoryValidity;
  readonly expiresAt?: string;
  readonly fallback: boolean;
}

/**
 * In-memory implementation with deterministic snapshots. The snapshot is the
 * persistence boundary: callers may journal it, store it on disk, and restore it
 * in a later session with a fresh evidence resolver.
 */
export class MemoryBank {
  readonly #records = new Map<`memory-${string}`, MemoryRecord>();
  readonly #transitions: MemoryTransition[] = [];
  readonly #resolveEvidence: MemoryEvidenceResolver;
  readonly #now: () => string;
  readonly #thresholds: MemoryConfidenceThresholds;
  readonly #allowSessionFallback: boolean;
  readonly #workspaceIdentity: string | undefined;
  readonly #sessionId: string | undefined;
  readonly #taskId: string | undefined;
  readonly #branch: string | undefined;
  #sequence = 0;

  constructor(options: MemoryBankOptions) {
    this.#resolveEvidence = options.resolveEvidence;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#workspaceIdentity = cleanOptional(options.workspaceIdentity);
    this.#sessionId = cleanOptional(options.sessionId);
    this.#taskId = cleanOptional(options.taskId);
    this.#branch = cleanOptional(options.branch);
    this.#allowSessionFallback = options.allowSessionFallback !== false;
    this.#thresholds = freezeObject({
      workspace: options.confidenceThresholds?.workspace ?? DEFAULT_MEMORY_CONFIDENCE_THRESHOLDS.workspace,
      session: options.confidenceThresholds?.session ?? DEFAULT_MEMORY_CONFIDENCE_THRESHOLDS.session,
      task: options.confidenceThresholds?.task ?? DEFAULT_MEMORY_CONFIDENCE_THRESHOLDS.task,
    });
    for (const [scope, threshold] of Object.entries(this.#thresholds)) {
      if (!isConfidence(threshold)) {
        throw new RangeError(`memory confidence threshold for ${scope} must be between 0 and 1`);
      }
    }
  }

  get size(): number {
    return this.#records.size;
  }

  get(id: `memory-${string}`): MemoryRecord | undefined {
    return this.#records.get(id);
  }

  all(): readonly MemoryRecord[] {
    return freezeArray([...this.#records.values()].sort(compareMemoryRecords));
  }

  /** Append-only state transition history. Returned entries are recursively frozen. */
  transitionLog(): readonly MemoryTransition[] {
    return freezeArray([...this.#transitions]);
  }

  /**
   * Run the complete write gate and deterministically reconcile contradictions.
   * A rejected write never mutates records or the transition log.
   */
  write(input: MemoryWriteInput): MemoryWriteResult {
    const now = this.#now();
    const normalized = this.#normalizeCandidate(input, now);
    if (isErrorList(normalized)) return rejected(normalized);
    const candidate = normalized;
    const id = memoryRecordId(candidate);
    const previousSameClaim = this.#records.get(id);

    let candidateRecord: MemoryRecord = freezeMemoryRecord({
      id,
      key: candidate.key,
      value: candidate.value,
      scope: candidate.scope,
      status: previousSameClaim?.status ?? "active",
      confidence: candidate.confidence,
      evidenceIds: sortedUnique([
        ...(previousSameClaim?.evidenceIds ?? []),
        ...candidate.evidence.ids,
      ]),
      validFor: candidate.validFor,
      createdAt: previousSameClaim?.createdAt ?? now,
      lastValidatedAt: now,
      evidenceObservedAt: laterTimestamp(
        previousSameClaim?.evidenceObservedAt,
        candidate.evidence.latestAt,
      ),
      ...optionalLaterExact(previousSameClaim?.exactEvidenceObservedAt, candidate.evidence.latestExactAt),
      ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {}),
      supersedes: previousSameClaim?.supersedes ?? [],
      ...(previousSameClaim?.supersededBy !== undefined
        ? { supersededBy: previousSameClaim.supersededBy }
        : {}),
      contestedWith: previousSameClaim?.contestedWith ?? [],
      revision: (previousSameClaim?.revision ?? 0) + 1,
    });

    const conflicting = [...this.#records.values()]
      .filter((record) =>
        record.id !== id &&
        record.key === candidateRecord.key &&
        record.value !== candidateRecord.value &&
        record.status !== "superseded" &&
        validityDomainsOverlap(record, candidateRecord)
      )
      .sort(compareMemoryRecords);

    let action: MemoryWriteAction = previousSameClaim === undefined ? "created" : "revalidated";
    const affected: MemoryRecord[] = [];

    if (conflicting.length === 0) {
      const from = previousSameClaim?.status ?? "absent";
      candidateRecord = freezeMemoryRecord({
        ...candidateRecord,
        status: "active",
        supersededBy: undefined,
        contestedWith: [],
      });
      this.#records.set(id, candidateRecord);
      this.#appendTransition(
        candidateRecord,
        from,
        "active",
        previousSameClaim === undefined ? "evidence-backed memory created" : "memory evidence revalidated",
        candidate.evidence.ids,
        now,
      );
    } else {
      const contenders = [candidateRecord, ...conflicting];
      const winner = uniqueNewestExact(contenders);
      if (winner?.id === candidateRecord.id) {
        const supersededIds = conflicting.map((record) => record.id).sort();
        candidateRecord = freezeMemoryRecord({
          ...candidateRecord,
          status: "active",
          supersedes: sortedUnique([...candidateRecord.supersedes, ...supersededIds]) as readonly `memory-${string}`[],
          supersededBy: undefined,
          contestedWith: [],
        });
        this.#records.set(id, candidateRecord);
        this.#appendTransition(
          candidateRecord,
          previousSameClaim?.status ?? "absent",
          "active",
          "newer exact evidence superseded contradictory memory",
          candidate.evidence.ids,
          now,
        );
        for (const record of conflicting) {
          const updated = freezeMemoryRecord({
            ...record,
            status: "superseded",
            supersededBy: candidateRecord.id,
            contestedWith: [],
            revision: record.revision + 1,
          });
          this.#records.set(updated.id, updated);
          affected.push(updated);
          this.#appendTransition(
            updated,
            record.status,
            "superseded",
            "newer exact evidence supports a contradictory value",
            candidate.evidence.ids,
            now,
          );
        }
        action = "superseded_previous";
      } else if (winner !== undefined) {
        candidateRecord = freezeMemoryRecord({
          ...candidateRecord,
          status: "superseded",
          supersededBy: winner.id,
          contestedWith: [],
        });
        this.#records.set(id, candidateRecord);
        this.#appendTransition(
          candidateRecord,
          previousSameClaim?.status ?? "absent",
          "superseded",
          "an existing contradictory memory has newer exact evidence",
          candidate.evidence.ids,
          now,
        );

        const winnerBefore = this.#records.get(winner.id) ?? winner;
        const loserIds = contenders
          .filter((record) => record.id !== winner.id)
          .map((record) => record.id)
          .sort();
        const updatedWinner = freezeMemoryRecord({
          ...winnerBefore,
          status: "active",
          supersedes: sortedUnique([...winnerBefore.supersedes, ...loserIds]) as readonly `memory-${string}`[],
          supersededBy: undefined,
          contestedWith: [],
          revision: winnerBefore.revision + 1,
        });
        this.#records.set(updatedWinner.id, updatedWinner);
        affected.push(updatedWinner);
        this.#appendTransition(
          updatedWinner,
          winnerBefore.status,
          "active",
          "newest exact evidence retained this contradictory value",
          candidate.evidence.ids,
          now,
        );
        for (const record of conflicting) {
          if (record.id === winner.id) continue;
          const updated = freezeMemoryRecord({
            ...record,
            status: "superseded",
            supersededBy: winner.id,
            contestedWith: [],
            revision: record.revision + 1,
          });
          this.#records.set(updated.id, updated);
          affected.push(updated);
          this.#appendTransition(
            updated,
            record.status,
            "superseded",
            "a contradictory value has newer exact evidence",
            candidate.evidence.ids,
            now,
          );
        }
        action = "superseded_by_existing";
      } else {
        const contenderIds = contenders.map((record) => record.id).sort();
        candidateRecord = freezeMemoryRecord({
          ...candidateRecord,
          status: "contested",
          supersededBy: undefined,
          contestedWith: contenderIds.filter((recordId) => recordId !== id),
        });
        this.#records.set(id, candidateRecord);
        this.#appendTransition(
          candidateRecord,
          previousSameClaim?.status ?? "absent",
          "contested",
          "contradictory evidence has no unique newest exact observation",
          candidate.evidence.ids,
          now,
        );
        for (const record of conflicting) {
          const updated = freezeMemoryRecord({
            ...record,
            status: "contested",
            supersededBy: undefined,
            contestedWith: contenderIds.filter((recordId) => recordId !== record.id),
            revision: record.revision + 1,
          });
          this.#records.set(updated.id, updated);
          affected.push(updated);
          this.#appendTransition(
            updated,
            record.status,
            "contested",
            "fresh evidence conflicts with this memory",
            candidate.evidence.ids,
            now,
          );
        }
        action = "contested";
      }
    }

    if (candidate.fallback) action = "session_only";
    return freezeObject({
      accepted: true,
      action,
      record: candidateRecord,
      affectedRecords: freezeArray(affected.sort(compareMemoryRecords)),
    });
  }

  writeOrThrow(input: MemoryWriteInput): MemoryRecord {
    const result = this.write(input);
    if (!result.accepted) throw new MemoryWriteError(result.reasons);
    return result.record;
  }

  /**
   * Resolve a contested set. Resolution is itself evidence-backed and requires
   * a unique newer exact observation; callers cannot select a winner by fiat.
   */
  resolveContest(input: ContestResolutionInput): ContestResolutionResult {
    const winner = this.#records.get(input.winnerId);
    if (winner === undefined) throw new Error(`unknown memory record: ${input.winnerId}`);
    if (input.reason.trim().length === 0) throw new Error("contest resolution requires a reason");
    const now = this.#now();
    const evidence = this.#resolveFreshEvidence(input.evidenceIds, winner.validFor, now);
    if (isErrorList(evidence)) throw new MemoryWriteError(evidence);
    if (evidence.latestExactAt === undefined) {
      throw new MemoryWriteError(["contest resolution requires exact evidence"]);
    }

    const peerIds = new Set(winner.contestedWith);
    for (const record of this.#records.values()) {
      if (
        record.id !== winner.id &&
        record.key === winner.key &&
        record.value !== winner.value &&
        record.status === "contested" &&
        validityDomainsOverlap(record, winner)
      ) peerIds.add(record.id);
    }
    const peers = [...peerIds]
      .map((id) => this.#records.get(id))
      .filter((record): record is MemoryRecord => record !== undefined)
      .sort(compareMemoryRecords);
    const maxPeerExact = latestDefined(peers.map((record) => record.exactEvidenceObservedAt));
    if (maxPeerExact !== undefined && compareTimestamps(evidence.latestExactAt, maxPeerExact) <= 0) {
      throw new MemoryWriteError(["contest resolution evidence must be newer than every contradictory exact observation"]);
    }

    const updatedWinner = freezeMemoryRecord({
      ...winner,
      status: "active",
      confidence: Math.max(winner.confidence, this.#thresholds[winner.scope]),
      evidenceIds: sortedUnique([...winner.evidenceIds, ...evidence.ids]),
      lastValidatedAt: now,
      evidenceObservedAt: laterTimestamp(winner.evidenceObservedAt, evidence.latestAt),
      exactEvidenceObservedAt: evidence.latestExactAt,
      supersedes: sortedUnique([...winner.supersedes, ...peers.map((record) => record.id)]) as readonly `memory-${string}`[],
      supersededBy: undefined,
      contestedWith: [],
      revision: winner.revision + 1,
    });
    this.#records.set(updatedWinner.id, updatedWinner);
    this.#appendTransition(
      updatedWinner,
      winner.status,
      "active",
      input.reason.trim(),
      evidence.ids,
      now,
    );

    const superseded: MemoryRecord[] = [];
    for (const peer of peers) {
      const updated = freezeMemoryRecord({
        ...peer,
        status: "superseded",
        supersededBy: updatedWinner.id,
        contestedWith: [],
        revision: peer.revision + 1,
      });
      this.#records.set(updated.id, updated);
      superseded.push(updated);
      this.#appendTransition(updated, peer.status, "superseded", input.reason.trim(), evidence.ids, now);
    }
    return freezeObject({
      winner: updatedWinner,
      superseded: freezeArray(superseded),
    });
  }

  /** Visible memory is filtered by scope, validity, status, and expiry. */
  select(query: MemoryQuery = {}): readonly MemoryRecord[] {
    const statuses = new Set(query.statuses ?? ["active"]);
    const scopes = new Set(query.scopes ?? ["workspace", "session", "task"]);
    const now = query.now ?? this.#now();
    const workspaceIdentity = cleanOptional(query.workspaceIdentity) ?? this.#workspaceIdentity;
    const sessionId = cleanOptional(query.sessionId) ?? this.#sessionId;
    const taskId = cleanOptional(query.taskId) ?? this.#taskId;
    const branch = cleanOptional(query.branch) ?? this.#branch;
    const path = query.path === undefined ? undefined : normalizeRepositoryPath(query.path);
    if (query.path !== undefined && path === undefined) return freezeArray([]);

    const selected = [...this.#records.values()].filter((record) => {
      if (!statuses.has(record.status) || !scopes.has(record.scope)) return false;
      if (query.key !== undefined && record.key !== query.key.trim()) return false;
      if (record.expiresAt !== undefined && compareTimestamps(record.expiresAt, now) <= 0) return false;
      if (!matchesIdentity(record.validFor.workspaceIdentity, workspaceIdentity)) return false;
      if (record.scope === "session" && !matchesRequired(record.validFor.sessionId, sessionId)) return false;
      if (record.scope === "task" && !matchesRequired(record.validFor.taskId, taskId)) return false;
      if (record.validFor.branch !== undefined && record.validFor.branch !== branch) return false;
      if (path !== undefined && record.validFor.paths !== undefined && !record.validFor.paths.some((boundary) => pathWithin(path, boundary))) return false;
      return true;
    });
    return freezeArray(selected.sort(compareVisibleMemory));
  }

  /** Alias used by resume/context compilation call sites. */
  recall(query: MemoryQuery = {}): readonly MemoryRecord[] {
    return this.select(query);
  }

  snapshot(): MemoryBankSnapshot {
    return deepFreeze({
      schemaVersion: "1",
      records: this.all().map(cloneMemoryRecord),
      transitions: this.#transitions.map(cloneTransition),
    });
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  static fromSnapshot(snapshot: MemoryBankSnapshot, options: MemoryBankOptions): MemoryBank {
    if (snapshot.schemaVersion !== "1") throw new Error("unsupported memory snapshot schema");
    const bank = new MemoryBank(options);
    const ids = new Set<string>();
    for (const raw of snapshot.records) {
      const record = validateSnapshotRecord(raw);
      if (ids.has(record.id)) throw new Error(`duplicate memory record in snapshot: ${record.id}`);
      ids.add(record.id);
      bank.#records.set(record.id, record);
    }
    let expectedSequence = 1;
    for (const raw of snapshot.transitions) {
      const transition = freezeTransition(raw);
      if (transition.sequence !== expectedSequence) {
        throw new Error("memory transition sequence is not contiguous");
      }
      bank.#transitions.push(transition);
      expectedSequence += 1;
    }
    bank.#sequence = expectedSequence - 1;
    return bank;
  }

  static deserialize(serialized: string, options: MemoryBankOptions): MemoryBank {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.schemaVersion !== "1" || !Array.isArray(parsed.records) || !Array.isArray(parsed.transitions)) {
      throw new Error("invalid memory snapshot");
    }
    return MemoryBank.fromSnapshot(parsed as unknown as MemoryBankSnapshot, options);
  }

  #normalizeCandidate(input: MemoryWriteInput, now: string): NormalizedCandidate | readonly string[] {
    const reasons: string[] = [];
    const key = input.key.trim();
    const value = input.value.trim();
    if (key.length === 0) reasons.push("memory key is required");
    if (value.length === 0) reasons.push("memory value is required");
    if (!isConfidence(input.confidence)) reasons.push("memory confidence must be between 0 and 1");
    if (!isIsoTimestamp(now)) reasons.push("memory clock must return an ISO timestamp");
    if (input.expiresAt !== undefined) {
      if (!isIsoTimestamp(input.expiresAt)) reasons.push("memory expiry must be an ISO timestamp");
      else if (compareTimestamps(input.expiresAt, now) <= 0) reasons.push("memory expiry must be in the future");
    }

    let scope = input.scope;
    let fallback = false;
    const requestedThreshold = this.#thresholds[scope];
    if (isConfidence(input.confidence) && input.confidence < requestedThreshold) {
      if (
        scope === "workspace" &&
        this.#allowSessionFallback &&
        this.#sessionId !== undefined &&
        input.confidence >= this.#thresholds.session
      ) {
        scope = "session";
        fallback = true;
      } else {
        reasons.push(`memory confidence is below the ${scope} threshold (${requestedThreshold})`);
      }
    }

    const validityResult = normalizeValidity(
      input.validFor,
      scope,
      {
        workspaceIdentity: this.#workspaceIdentity,
        sessionId: this.#sessionId,
        taskId: this.#taskId,
        branch: this.#branch,
      },
    );
    if (isErrorList(validityResult)) reasons.push(...validityResult);
    const validFor = isErrorList(validityResult) ? freezeObject({}) : validityResult;
    const evidence = this.#resolveFreshEvidence(input.evidenceIds, validFor, now);
    if (isErrorList(evidence)) reasons.push(...evidence);

    if (reasons.length > 0 || isErrorList(evidence)) return sortedUnique(reasons);
    return freezeObject({
      key,
      value,
      scope,
      confidence: input.confidence,
      evidence,
      validFor,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      fallback,
    });
  }

  #resolveFreshEvidence(
    rawIds: readonly string[],
    validFor: MemoryValidity,
    now: string,
  ): ResolvedEvidence | readonly string[] {
    const ids = sortedUnique(rawIds.map((id) => id.trim()).filter((id) => id.length > 0));
    if (ids.length === 0) return freezeArray(["at least one evidence reference is required"]);
    const reasons: string[] = [];
    const records: MemoryEvidence[] = [];
    for (const id of ids) {
      const evidence = this.#resolveEvidence(id);
      if (evidence === undefined) {
        reasons.push(`evidence is missing: ${id}`);
        continue;
      }
      if (evidence.id !== id) reasons.push(`evidence resolver returned a mismatched id for ${id}`);
      if (evidence.freshness !== "fresh") reasons.push(`evidence is ${evidence.freshness}: ${id}`);
      if (!isIsoTimestamp(evidence.observedAt)) reasons.push(`evidence has an invalid observation time: ${id}`);
      if (evidence.expiresAt !== undefined) {
        if (!isIsoTimestamp(evidence.expiresAt) || compareTimestamps(evidence.expiresAt, now) <= 0) {
          reasons.push(`evidence is expired: ${id}`);
        }
      }
      const evidenceWorkspace = evidence.workspaceIdentity ?? evidence.workspaceIdentityDigest;
      if (
        validFor.workspaceIdentity !== undefined &&
        evidenceWorkspace !== undefined &&
        evidenceWorkspace !== validFor.workspaceIdentity
      ) reasons.push(`evidence workspace identity mismatch: ${id}`);
      records.push(freezeObject({ ...evidence }));
    }
    if (reasons.length > 0) return sortedUnique(reasons);
    const latestAt = latestDefined(records.map((record) => record.observedAt));
    if (latestAt === undefined) return freezeArray(["evidence observation time is required"]);
    const latestExactAt = latestDefined(
      records.filter((record) => record.exact !== false).map((record) => record.observedAt),
    );
    return freezeObject({
      records: freezeArray(records),
      ids: freezeArray(ids),
      latestAt,
      ...(latestExactAt !== undefined ? { latestExactAt } : {}),
    });
  }

  #appendTransition(
    record: MemoryRecord,
    fromStatus: MemoryStatus | "absent",
    toStatus: MemoryStatus,
    reason: string,
    evidenceIds: readonly string[],
    at: string,
  ): void {
    this.#sequence += 1;
    this.#transitions.push(freezeTransition({
      sequence: this.#sequence,
      recordId: record.id,
      fromStatus,
      toStatus,
      reason,
      evidenceIds: sortedUnique(evidenceIds),
      at,
    }));
  }
}

export class MemoryWriteError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(reasons.join("; "));
    this.name = "MemoryWriteError";
    this.reasons = freezeArray([...reasons]);
  }
}

/** More explicit name for integration sites that persist snapshots. */
export { MemoryBank as DurableMemoryBank };

function rejected(reasons: readonly string[]): RejectedMemoryWrite {
  return freezeObject({ accepted: false, action: "rejected", reasons: freezeArray([...reasons]) });
}

function memoryRecordId(candidate: NormalizedCandidate): `memory-${string}` {
  return `memory-${evidenceDigest({
    key: candidate.key,
    value: candidate.value,
    scope: candidate.scope,
    validFor: candidate.validFor,
  })}`;
}

function uniqueNewestExact(records: readonly MemoryRecord[]): MemoryRecord | undefined {
  const withExact = records.filter((record) => record.exactEvidenceObservedAt !== undefined);
  if (withExact.length === 0) return undefined;
  const sorted = [...withExact].sort((left, right) => {
    const byTime = compareTimestamps(
      right.exactEvidenceObservedAt ?? "",
      left.exactEvidenceObservedAt ?? "",
    );
    return byTime || left.id.localeCompare(right.id);
  });
  const first = sorted[0];
  const second = sorted[1];
  if (first === undefined) return undefined;
  if (
    second !== undefined &&
    compareTimestamps(first.exactEvidenceObservedAt ?? "", second.exactEvidenceObservedAt ?? "") === 0
  ) return undefined;
  return first;
}

function validityDomainsOverlap(left: MemoryRecord, right: MemoryRecord): boolean {
  if (left.scope !== right.scope) return false;
  if (!optionalDomainsOverlap(left.validFor.workspaceIdentity, right.validFor.workspaceIdentity)) return false;
  if (left.scope === "session" && !optionalDomainsOverlap(left.validFor.sessionId, right.validFor.sessionId)) return false;
  if (left.scope === "task" && !optionalDomainsOverlap(left.validFor.taskId, right.validFor.taskId)) return false;
  if (!optionalDomainsOverlap(left.validFor.branch, right.validFor.branch)) return false;
  const leftPaths = left.validFor.paths;
  const rightPaths = right.validFor.paths;
  if (leftPaths === undefined || rightPaths === undefined) return true;
  return leftPaths.some((leftPath) => rightPaths.some((rightPath) =>
    pathWithin(leftPath, rightPath) || pathWithin(rightPath, leftPath)
  ));
}

function optionalDomainsOverlap(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function normalizeValidity(
  input: MemoryValidity | undefined,
  scope: MemoryScope,
  defaults: {
    readonly workspaceIdentity: string | undefined;
    readonly sessionId: string | undefined;
    readonly taskId: string | undefined;
    readonly branch: string | undefined;
  },
): MemoryValidity | readonly string[] {
  const reasons: string[] = [];
  const workspaceIdentity = cleanOptional(input?.workspaceIdentity) ?? defaults.workspaceIdentity;
  const sessionId = cleanOptional(input?.sessionId) ?? defaults.sessionId;
  const taskId = cleanOptional(input?.taskId) ?? defaults.taskId;
  const branch = cleanOptional(input?.branch) ?? defaults.branch;
  if (scope === "workspace" && workspaceIdentity === undefined) {
    reasons.push("workspace memory requires a workspace identity");
  }
  if (scope === "session" && sessionId === undefined) {
    reasons.push("session memory requires a session id");
  }
  if (scope === "task" && taskId === undefined) {
    reasons.push("task memory requires a task id");
  }
  const normalizedPaths: string[] = [];
  for (const rawPath of input?.paths ?? []) {
    const path = normalizeRepositoryPath(rawPath);
    if (path === undefined) reasons.push(`memory path is not workspace-relative: ${rawPath}`);
    else normalizedPaths.push(path);
  }
  if (reasons.length > 0) return sortedUnique(reasons);
  return freezeObject({
    ...(workspaceIdentity !== undefined ? { workspaceIdentity } : {}),
    ...(scope !== "workspace" && sessionId !== undefined ? { sessionId } : {}),
    ...(scope === "task" && taskId !== undefined ? { taskId } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(normalizedPaths.length > 0 ? { paths: freezeArray(sortedUnique(normalizedPaths)) } : {}),
  });
}

function normalizeRepositoryPath(path: string): string | undefined {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  if (normalized === ".") return ".";
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}

function pathWithin(path: string, boundary: string): boolean {
  return boundary === "." || path === boundary || path.startsWith(`${boundary}/`);
}

function matchesIdentity(required: string | undefined, actual: string | undefined): boolean {
  return required === undefined || (actual !== undefined && required === actual);
}

function matchesRequired(required: string | undefined, actual: string | undefined): boolean {
  return required !== undefined && actual !== undefined && required === actual;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function isConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isIsoTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function compareTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function laterTimestamp(left: string | undefined, right: string): string {
  return left === undefined || compareTimestamps(right, left) > 0 ? right : left;
}

function optionalLaterExact(
  left: string | undefined,
  right: string | undefined,
): { readonly exactEvidenceObservedAt?: string } {
  if (left === undefined) return right === undefined ? {} : { exactEvidenceObservedAt: right };
  if (right === undefined) return { exactEvidenceObservedAt: left };
  return { exactEvidenceObservedAt: compareTimestamps(right, left) > 0 ? right : left };
}

function latestDefined(values: readonly (string | undefined)[]): string | undefined {
  let latest: string | undefined;
  for (const value of values) {
    if (value !== undefined && (latest === undefined || compareTimestamps(value, latest) > 0)) latest = value;
  }
  return latest;
}

function compareMemoryRecords(left: MemoryRecord, right: MemoryRecord): number {
  return left.key.localeCompare(right.key) ||
    left.scope.localeCompare(right.scope) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}

function compareVisibleMemory(left: MemoryRecord, right: MemoryRecord): number {
  return scopeRank(right.scope) - scopeRank(left.scope) ||
    left.key.localeCompare(right.key) ||
    right.lastValidatedAt.localeCompare(left.lastValidatedAt) ||
    left.id.localeCompare(right.id);
}

function scopeRank(scope: MemoryScope): number {
  if (scope === "task") return 3;
  if (scope === "session") return 2;
  return 1;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freezeMemoryRecord(record: MemoryRecord): MemoryRecord {
  const validFor: MemoryValidity = freezeObject({
    ...record.validFor,
    ...(record.validFor.paths !== undefined ? { paths: freezeArray([...record.validFor.paths]) } : {}),
  });
  return freezeObject({
    ...record,
    validFor,
    evidenceIds: freezeArray([...record.evidenceIds]),
    supersedes: freezeArray([...record.supersedes]),
    contestedWith: freezeArray([...record.contestedWith]),
    ...(record.supersededBy === undefined ? { supersededBy: undefined } : {}),
  });
}

function cloneMemoryRecord(record: MemoryRecord): MemoryRecord {
  return freezeMemoryRecord({ ...record });
}

function freezeTransition(transition: MemoryTransition): MemoryTransition {
  return freezeObject({
    ...transition,
    evidenceIds: freezeArray([...transition.evidenceIds]),
  });
}

function cloneTransition(transition: MemoryTransition): MemoryTransition {
  return freezeTransition({ ...transition });
}

function validateSnapshotRecord(raw: MemoryRecord): MemoryRecord {
  if (
    typeof raw.id !== "string" || !raw.id.startsWith("memory-") ||
    typeof raw.key !== "string" || raw.key.length === 0 ||
    typeof raw.value !== "string" || raw.value.length === 0 ||
    !["workspace", "session", "task"].includes(raw.scope) ||
    !["active", "superseded", "contested"].includes(raw.status) ||
    !isConfidence(raw.confidence) ||
    !Array.isArray(raw.evidenceIds) || raw.evidenceIds.length === 0 ||
    !isIsoTimestamp(raw.createdAt) || !isIsoTimestamp(raw.lastValidatedAt) ||
    !isIsoTimestamp(raw.evidenceObservedAt) ||
    !Number.isInteger(raw.revision) || raw.revision < 1
  ) throw new Error("invalid memory record in snapshot");
  return freezeMemoryRecord(raw);
}

function isErrorList(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values);
}

function freezeObject<T extends object>(value: T): Readonly<T> & T {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
