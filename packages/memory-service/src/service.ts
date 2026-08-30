/**
 * Production facade over MemoryBank. Adds secret rejection, mandatory
 * workspace isolation, contested exclusion from recall, logical forget, and
 * ContextItem-like projection for the compiler.
 */

import {
  MemoryBank,
  MemoryWriteError,
  type ContestResolutionInput,
  type ContestResolutionResult,
  type MemoryBankOptions,
  type MemoryBankSnapshot,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryWriteInput,
  type MemoryWriteResult,
} from "@cbc/context-engine";

import {
  CapsuleStore,
  type CapsuleActivationOptions,
  type CapsuleActivationResult,
  type CapsuleAmendment,
  type CapsuleAuditView,
  type CapsuleInvalidationResult,
  type CapsuleInvalidationTrigger,
  type CapsuleLearningPolicy,
  type CapsuleProposalInput,
  type CapsuleProposalResult,
  type CapsuleRecallOptions,
  type CapsuleStoreSnapshot,
  type StrategyCapsule,
} from "./capsule.ts";

/** Patterns that must never enter durable memory (key or value). */
const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "password", pattern: /\bpassword\b/i },
  { name: "api_key", pattern: /\bapi[-_]?key\b/i },
  { name: "token", pattern: /\b(access[-_]?token|refresh[-_]?token|bearer[-_]?token|auth[-_]?token)\b/i },
  { name: "secret", pattern: /\b(secret|client[-_]?secret)\b/i },
  { name: "credential", pattern: /\bcredential(s)?\b/i },
  { name: "private_key", pattern: /\bprivate[-_]?key\b/i },
  { name: "cookie", pattern: /\b(set-)?cookie\b/i },
];

export interface MemoryServiceOptions extends MemoryBankOptions {
  /** Required. Cross-workspace contamination is rejected at construction. */
  readonly workspaceIdentity: string;
  /** §8.4 agent.learning.strategyCapsules; defaults to `suggest`. */
  readonly capsulePolicy?: CapsuleLearningPolicy;
  /** §8.4 agent.learning.minVerifiedObservations. */
  readonly minVerifiedObservations?: number;
}

export interface MemoryRecallQuery extends MemoryQuery {
  readonly query?: string;
  readonly limit?: number;
}

export interface MemoryContextItem {
  readonly kind: "memory";
  readonly id: string;
  readonly layer: "L5_compact_state";
  readonly tokens: number;
  readonly text: string;
  readonly provenance: {
    readonly memoryId: `memory-${string}`;
    readonly evidenceIds: readonly string[];
    readonly scope: MemoryRecord["scope"];
    readonly confidence: number;
  };
}

export interface MemoryInspectView {
  readonly workspaceIdentity: string;
  readonly records: readonly MemoryRecord[];
  readonly forgottenIds: readonly `memory-${string}`[];
  readonly contestedIds: readonly `memory-${string}`[];
  readonly size: number;
  /** §6.4: the audit surface covers capsules, not only key/value records. */
  readonly capsules: CapsuleAuditView;
}

export interface MemoryServiceSnapshot {
  /** "2" adds the capsule store; "1" snapshots restore with no capsules. */
  readonly schemaVersion: "1" | "2";
  readonly workspaceIdentity: string;
  readonly bank: MemoryBankSnapshot;
  readonly forgottenIds: readonly `memory-${string}`[];
  readonly capsules?: CapsuleStoreSnapshot;
}

export class MemoryService {
  #bank: MemoryBank;
  readonly #workspaceIdentity: string;
  readonly #forgotten = new Set<`memory-${string}`>();
  readonly #options: MemoryServiceOptions;
  readonly #capsules: CapsuleStore;

  constructor(
    options: MemoryServiceOptions,
    bank?: MemoryBank,
    forgotten?: readonly `memory-${string}`[],
    capsules?: CapsuleStore,
  ) {
    const workspaceIdentity = options.workspaceIdentity.trim();
    if (workspaceIdentity.length === 0) {
      throw new RangeError("MemoryService requires a non-empty workspaceIdentity");
    }
    this.#workspaceIdentity = workspaceIdentity;
    this.#options = { ...options, workspaceIdentity };
    this.#bank = bank ?? new MemoryBank(this.#options);
    for (const id of forgotten ?? []) this.#forgotten.add(id);
    this.#capsules = capsules ?? new CapsuleStore({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.capsulePolicy !== undefined ? { policy: options.capsulePolicy } : {}),
      ...(options.minVerifiedObservations !== undefined
        ? { minVerifiedObservations: options.minVerifiedObservations }
        : {}),
    });
  }

  get workspaceIdentity(): string {
    return this.#workspaceIdentity;
  }

  get size(): number {
    return this.#bank.size;
  }

  /**
   * Active, non-forgotten memory only. Contested records are never returned.
   * Workspace identity is always enforced; a mismatched query identity yields [].
   */
  recall(query: MemoryRecallQuery = {}): readonly MemoryRecord[] {
    const requested = query.workspaceIdentity?.trim();
    if (requested !== undefined && requested.length > 0 && requested !== this.#workspaceIdentity) {
      return Object.freeze([]);
    }
    const selected = this.#bank.recall({
      ...query,
      workspaceIdentity: this.#workspaceIdentity,
      statuses: ["active"],
    });
    const filtered = selected.filter((record) => {
      if (this.#forgotten.has(record.id)) return false;
      if (record.status === "contested") return false;
      if (query.query !== undefined && query.query.trim().length > 0) {
        const q = query.query.trim().toLowerCase();
        if (!record.key.toLowerCase().includes(q) && !record.value.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
    const limit = query.limit;
    if (limit === undefined || limit >= filtered.length) return filtered;
    return filtered.slice(0, Math.max(0, Math.floor(limit)));
  }

  remember(input: MemoryWriteInput): MemoryWriteResult {
    const secretReasons = detectSecretShaped(input.key, input.value);
    if (secretReasons.length > 0) {
      return Object.freeze({
        accepted: false,
        action: "rejected",
        reasons: Object.freeze([...secretReasons]),
      });
    }
    const validFor = {
      ...input.validFor,
      workspaceIdentity: input.validFor?.workspaceIdentity ?? this.#workspaceIdentity,
    };
    if (
      validFor.workspaceIdentity !== undefined &&
      validFor.workspaceIdentity !== this.#workspaceIdentity
    ) {
      return Object.freeze({
        accepted: false,
        action: "rejected",
        reasons: Object.freeze(["cross-workspace memory write is forbidden"]),
      });
    }
    return this.#bank.write({ ...input, validFor });
  }

  /**
   * Restart hydration: insert a store-backed record without re-running the write
   * gate. Secret and cross-workspace checks still apply.
   */
  ingestRestored(record: MemoryRecord): void {
    const secretReasons = detectSecretShaped(record.key, record.value);
    if (secretReasons.length > 0) return;
    if (
      record.validFor.workspaceIdentity !== undefined &&
      record.validFor.workspaceIdentity !== this.#workspaceIdentity
    ) {
      return;
    }
    const snapshot = this.#bank.snapshot();
    const records = snapshot.records.filter((existing) => existing.id !== record.id);
    records.push(record);
    this.#bank = MemoryBank.fromSnapshot(
      { schemaVersion: "1", records, transitions: snapshot.transitions },
      this.#options,
    );
    if (record.status === "contested") {
      // Contested records stay in the bank and are excluded by recall().
    }
  }

  /** Logical forget: excluded from recall; audit history retained in the bank. */
  forget(id: `memory-${string}`): MemoryRecord {
    const record = this.#bank.get(id);
    if (record === undefined) throw new Error(`unknown memory record: ${id}`);
    if (
      record.validFor.workspaceIdentity !== undefined &&
      record.validFor.workspaceIdentity !== this.#workspaceIdentity
    ) {
      throw new Error("cross-workspace forget is forbidden");
    }
    this.#forgotten.add(id);
    return record;
  }

  resolveContest(input: ContestResolutionInput): ContestResolutionResult {
    return this.#bank.resolveContest(input);
  }

  // ---- §6.1-6.4 Strategy Capsules (P1-01) ----
  //
  // The capsule lifecycle lives in CapsuleStore; the service is the facade the
  // session and the /learn command talk to, so a caller cannot reach the store
  // directly and skip the workspace binding these methods apply.

  /** §6.3 propose. Always lands `proposed`; evidence and secret gates apply. */
  proposeCapsule(input: CapsuleProposalInput): CapsuleProposalResult {
    return this.#capsules.propose(input);
  }

  /** §6.3 activate. Refused below the observation threshold or without approval. */
  activateCapsule(
    id: `capsule-${string}`,
    options: CapsuleActivationOptions = {},
  ): CapsuleActivationResult {
    return this.#capsules.activate(id, options);
  }

  rejectCapsule(id: `capsule-${string}`, reason?: string): StrategyCapsule {
    return reason === undefined ? this.#capsules.reject(id) : this.#capsules.reject(id, reason);
  }

  forgetCapsule(id: `capsule-${string}`, reason?: string): StrategyCapsule {
    return reason === undefined ? this.#capsules.forget(id) : this.#capsules.forget(id, reason);
  }

  /** §6.4 modify. An amendment re-enters the approval gate. */
  amendCapsule(id: `capsule-${string}`, patch: CapsuleAmendment): StrategyCapsule {
    return this.#capsules.amend(id, patch);
  }

  /** §6.3 rollback to an earlier revision from the append-only transition log. */
  rollbackCapsule(id: `capsule-${string}`, toRevision?: number): StrategyCapsule {
    return this.#capsules.rollback(id, toRevision);
  }

  /** Active, unexpired capsules only — a proposal is never recalled. */
  recallCapsules(options: CapsuleRecallOptions = {}): readonly StrategyCapsule[] {
    return this.#capsules.recall(options);
  }

  /** §6.3 invalidator sweep on code, policy, or toolset change. */
  evaluateCapsuleInvalidators(trigger: CapsuleInvalidationTrigger): CapsuleInvalidationResult {
    return this.#capsules.evaluateInvalidators(trigger);
  }

  /** §6.4 audit view: status, provenance, and what would retire each capsule. */
  auditCapsules(): CapsuleAuditView {
    return this.#capsules.audit();
  }

  capsule(id: `capsule-${string}`): StrategyCapsule | undefined {
    return this.#capsules.get(id);
  }

  /** Restart hydration for capsules; secret-shaped rows are dropped. */
  ingestRestoredCapsules(capsules: readonly StrategyCapsule[]): void {
    this.#capsules.ingest(capsules);
  }

  /** Inspector view includes contested and forgotten ids; bodies stay workspace-bound. */
  inspect(): MemoryInspectView {
    const records = this.#bank.all().filter((record) =>
      record.validFor.workspaceIdentity === undefined ||
      record.validFor.workspaceIdentity === this.#workspaceIdentity
    );
    return Object.freeze({
      workspaceIdentity: this.#workspaceIdentity,
      records: Object.freeze([...records]),
      forgottenIds: Object.freeze([...this.#forgotten].sort()),
      contestedIds: Object.freeze(
        records.filter((record) => record.status === "contested").map((record) => record.id).sort(),
      ),
      size: records.length,
      capsules: this.#capsules.audit(),
    });
  }

  snapshot(): MemoryServiceSnapshot {
    return Object.freeze({
      schemaVersion: "2",
      workspaceIdentity: this.#workspaceIdentity,
      bank: this.#bank.snapshot(),
      forgottenIds: Object.freeze([...this.#forgotten].sort()),
      capsules: this.#capsules.snapshot(),
    });
  }

  static fromSnapshot(
    snapshot: MemoryServiceSnapshot,
    options: Omit<MemoryServiceOptions, "workspaceIdentity"> & { readonly workspaceIdentity?: string },
  ): MemoryService {
    if (snapshot.schemaVersion !== "1" && snapshot.schemaVersion !== "2") {
      throw new Error("unsupported memory service snapshot schema");
    }
    const workspaceIdentity = options.workspaceIdentity ?? snapshot.workspaceIdentity;
    if (workspaceIdentity !== snapshot.workspaceIdentity) {
      throw new Error("snapshot workspace identity does not match service options");
    }
    const bank = MemoryBank.fromSnapshot(snapshot.bank, { ...options, workspaceIdentity });
    // A schema "1" snapshot predates capsules and restores with an empty store.
    const capsules = snapshot.capsules === undefined
      ? undefined
      : CapsuleStore.fromSnapshot(snapshot.capsules, {
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.capsulePolicy !== undefined ? { policy: options.capsulePolicy } : {}),
        ...(options.minVerifiedObservations !== undefined
          ? { minVerifiedObservations: options.minVerifiedObservations }
          : {}),
      });
    return new MemoryService(
      { ...options, workspaceIdentity },
      bank,
      snapshot.forgottenIds,
      capsules,
    );
  }

  /** Project active recalled records into compiler-facing context items. */
  toContextItems(records?: readonly MemoryRecord[]): readonly MemoryContextItem[] {
    const source = records ?? this.recall();
    return Object.freeze(source.map(memoryToContextItem));
  }
}

export function memoryToContextItem(record: MemoryRecord): MemoryContextItem {
  const text = `${record.key}: ${record.value}`;
  return Object.freeze({
    kind: "memory",
    id: record.id,
    layer: "L5_compact_state",
    tokens: estimateTokens(text),
    text,
    provenance: Object.freeze({
      memoryId: record.id,
      evidenceIds: Object.freeze([...record.evidenceIds]),
      scope: record.scope,
      confidence: record.confidence,
    }),
  });
}

export function detectSecretShaped(key: string, value: string): readonly string[] {
  const reasons: string[] = [];
  const haystacks: Array<readonly [string, string]> = [
    ["key", key],
    ["value", value],
  ];
  for (const [field, text] of haystacks) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        reasons.push(`secret-shaped ${field} rejected (${name})`);
      }
    }
  }
  return Object.freeze([...new Set(reasons)].sort());
}

export { MemoryWriteError };

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
