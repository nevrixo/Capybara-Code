/**
 * §6.2 Strategy Capsules — the evidence-backed learning unit (P1-01).
 *
 * A capsule is not a fact the way a MemoryRecord is; it is a *strategy* the
 * harness believes about this repository — an invariant, a workflow that worked,
 * a failure pattern to avoid, a preference the user repeated. That difference is
 * why it needs its own type and its own lifecycle: §6.3 requires a capsule to
 * enter as `proposed` and to reach `active` only through the gates that follow,
 * whereas MemoryBank's write gate lands an accepted claim active immediately.
 *
 * This store is deliberately pure. It owns the capsule state machine and
 * nothing else — no evidence resolution, no persistence, no approval UI — so
 * the §6.4 audit criteria can be tested without a session.
 */

import { detectSecretShaped } from "./service.ts";

export type CapsuleKind = "invariant" | "workflow" | "failure_pattern" | "user_preference";
/** §6.2 adds `user` to the workspace/session pair MemoryScope already has. */
export type CapsuleScope = "session" | "workspace" | "user";
export type CapsuleStatus = "proposed" | "active" | "contested" | "forgotten";

export interface StrategyCapsule {
  readonly id: `capsule-${string}`;
  readonly kind: CapsuleKind;
  readonly statement: string;
  readonly scope: CapsuleScope;
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
  /** Independent verified trajectories seen so far; see §6.3's 2-3 minimum. */
  readonly observedCount: number;
  /** §6.3 conditions that retire the capsule when they change. */
  readonly invalidators: readonly string[];
  readonly expiresAt?: string;
  readonly createdFromRouteIds: readonly string[];
  readonly status: CapsuleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface CapsuleProposalInput {
  readonly kind: CapsuleKind;
  readonly statement: string;
  readonly scope: CapsuleScope;
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
  readonly invalidators?: readonly string[];
  readonly expiresAt?: string;
  /** The route this observation came from; distinct ids are distinct trajectories. */
  readonly routeIds?: readonly string[];
}

export interface CapsuleTransition {
  readonly sequence: number;
  readonly capsuleId: `capsule-${string}`;
  readonly fromStatus: CapsuleStatus | "absent";
  readonly toStatus: CapsuleStatus;
  readonly reason: string;
  readonly at: string;
  /** The capsule body as it stood after this transition, for §6.3 rollback. */
  readonly snapshot: StrategyCapsule;
}

export interface AcceptedCapsuleProposal {
  readonly accepted: true;
  readonly action: "proposed" | "observed";
  readonly capsule: StrategyCapsule;
}

export interface RejectedCapsuleProposal {
  readonly accepted: false;
  readonly action: "rejected";
  readonly reasons: readonly string[];
}

export type CapsuleProposalResult = AcceptedCapsuleProposal | RejectedCapsuleProposal;

export interface CapsuleStoreSnapshot {
  readonly schemaVersion: "1";
  readonly capsules: readonly StrategyCapsule[];
  readonly transitions: readonly CapsuleTransition[];
}

export interface CapsuleStoreOptions {
  readonly now?: () => string;
}

/**
 * Deterministic in-memory capsule store. The snapshot is the persistence
 * boundary, mirroring MemoryBank so the two can be journalled together.
 */
export class CapsuleStore {
  readonly #capsules = new Map<`capsule-${string}`, StrategyCapsule>();
  readonly #transitions: CapsuleTransition[] = [];
  readonly #now: () => string;
  #sequence = 0;

  constructor(options: CapsuleStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get size(): number {
    return this.#capsules.size;
  }

  get(id: `capsule-${string}`): StrategyCapsule | undefined {
    return this.#capsules.get(id);
  }

  all(): readonly StrategyCapsule[] {
    return Object.freeze([...this.#capsules.values()].sort(compareCapsules));
  }

  /** Append-only lifecycle history; the rollback source per §6.3. */
  transitionLog(): readonly CapsuleTransition[] {
    return Object.freeze([...this.#transitions]);
  }

  /**
   * §6.3 entry point. A capsule always enters as `proposed`: evidence is
   * required (no-evidence-no-autosave applies to session scope too), the
   * statement is screened for secrets before it is ever stored, and a repeat
   * observation of the same claim accrues a trajectory rather than a duplicate.
   */
  propose(input: CapsuleProposalInput): CapsuleProposalResult {
    const reasons: string[] = [];
    const statement = input.statement.trim();
    if (statement.length === 0) reasons.push("a capsule statement is required");
    const evidenceIds = sortedUnique(
      input.evidenceIds.map((id) => id.trim()).filter((id) => id.length > 0),
    );
    if (evidenceIds.length === 0) {
      // §6.3: session scope is not exempt from the no-evidence-no-autosave rule.
      reasons.push("at least one evidence reference is required");
    }
    if (!isConfidence(input.confidence)) reasons.push("capsule confidence must be between 0 and 1");
    reasons.push(...detectSecretShaped(input.kind, statement));
    if (reasons.length > 0) {
      return Object.freeze({
        accepted: false,
        action: "rejected",
        reasons: sortedUnique(reasons),
      });
    }

    const now = this.#now();
    const routeIds = sortedUnique(
      (input.routeIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    );
    const invalidators = sortedUnique(
      (input.invalidators ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    );
    const id = capsuleId(input.kind, statement, input.scope);
    const previous = this.#capsules.get(id);

    if (previous !== undefined) {
      const mergedRoutes = sortedUnique([...previous.createdFromRouteIds, ...routeIds]);
      const capsule = freezeCapsule({
        ...previous,
        evidenceIds: sortedUnique([...previous.evidenceIds, ...evidenceIds]),
        invalidators: sortedUnique([...previous.invalidators, ...invalidators]),
        createdFromRouteIds: mergedRoutes,
        // Only a route the store has not already counted is a new trajectory.
        observedCount: Math.max(previous.observedCount, mergedRoutes.length || 1),
        confidence: Math.max(previous.confidence, input.confidence),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        updatedAt: now,
        revision: previous.revision + 1,
      });
      this.#capsules.set(id, capsule);
      this.#record(previous.status, capsule, "additional verified observation");
      return Object.freeze({ accepted: true, action: "observed", capsule });
    }

    const capsule = freezeCapsule({
      id,
      kind: input.kind,
      statement,
      scope: input.scope,
      evidenceIds,
      confidence: input.confidence,
      observedCount: routeIds.length || 1,
      invalidators,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdFromRouteIds: routeIds,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });
    this.#capsules.set(id, capsule);
    this.#record("absent", capsule, "evidence-backed capsule proposed");
    return Object.freeze({ accepted: true, action: "proposed", capsule });
  }

  snapshot(): CapsuleStoreSnapshot {
    return Object.freeze({
      schemaVersion: "1",
      capsules: this.all(),
      transitions: this.transitionLog(),
    });
  }

  static fromSnapshot(snapshot: CapsuleStoreSnapshot, options: CapsuleStoreOptions = {}): CapsuleStore {
    if (snapshot.schemaVersion !== "1") throw new Error("unsupported capsule store snapshot schema");
    const store = new CapsuleStore(options);
    store.ingest(snapshot.capsules, snapshot.transitions);
    return store;
  }

  /** Restart hydration. Secret-shaped rows are dropped rather than restored. */
  ingest(capsules: readonly StrategyCapsule[], transitions: readonly CapsuleTransition[] = []): void {
    for (const capsule of capsules) {
      if (detectSecretShaped(capsule.kind, capsule.statement).length > 0) continue;
      this.#capsules.set(capsule.id, freezeCapsule({ ...capsule }));
    }
    for (const transition of transitions) {
      this.#transitions.push(Object.freeze({ ...transition }));
      this.#sequence = Math.max(this.#sequence, transition.sequence);
    }
  }

  #record(from: CapsuleStatus | "absent", capsule: StrategyCapsule, reason: string): void {
    this.#sequence += 1;
    this.#transitions.push(Object.freeze({
      sequence: this.#sequence,
      capsuleId: capsule.id,
      fromStatus: from,
      toStatus: capsule.status,
      reason,
      at: capsule.updatedAt,
      snapshot: capsule,
    }));
  }
}

/**
 * Identity is the claim itself, so the same strategy observed on two routes
 * accrues a trajectory instead of creating a second capsule.
 */
export function capsuleId(kind: CapsuleKind, statement: string, scope: CapsuleScope): `capsule-${string}` {
  return `capsule-${stableDigest(`${kind} ${statement.trim()} ${scope}`)}`;
}

/**
 * FNV-1a over UTF-16 code units, expanded to 32 hex characters. Deterministic
 * and dependency-free; identity only, never integrity.
 */
function stableDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let mixed = "";
  let carry = hash;
  for (let round = 0; round < 4; round += 1) {
    carry = Math.imul(carry ^ (carry >>> 15), 0x27d4eb2d) >>> 0;
    mixed += carry.toString(16).padStart(8, "0");
  }
  return mixed;
}

export function freezeCapsule(capsule: StrategyCapsule): StrategyCapsule {
  return Object.freeze({
    ...capsule,
    evidenceIds: Object.freeze([...capsule.evidenceIds]),
    invalidators: Object.freeze([...capsule.invalidators]),
    createdFromRouteIds: Object.freeze([...capsule.createdFromRouteIds]),
  });
}

export function compareCapsules(left: StrategyCapsule, right: StrategyCapsule): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function isConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
