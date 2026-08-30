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

/**
 * §6.3's application policy, mirroring agent.learning.strategyCapsules. `off`
 * declines proposals; `suggest` — the §8.4 default — keeps every capsule a
 * suggestion until the user accepts it; `on` drops the prompt for session scope
 * only, because workspace and user scope always need approval.
 */
export type CapsuleLearningPolicy = "off" | "suggest" | "on";

/** §6.3: activation at these scopes is a user decision, never a model one. */
export const APPROVAL_REQUIRED_SCOPES: readonly CapsuleScope[] = Object.freeze(["workspace", "user"]);

export function capsuleScopeRequiresApproval(scope: CapsuleScope, policy: CapsuleLearningPolicy): boolean {
  if (APPROVAL_REQUIRED_SCOPES.includes(scope)) return true;
  // Session scope is the only one `on` may activate unattended.
  return policy !== "on";
}

export interface CapsuleStoreOptions {
  readonly now?: () => string;
  /** Defaults to `suggest`, matching agent.learning.strategyCapsules. */
  readonly policy?: CapsuleLearningPolicy;
  /**
   * §6.3's "최소 2~3개의 독립된 검증 궤적" floor, read from
   * agent.learning.minVerifiedObservations. Three is the §8.4 default; the
   * store's own floor is two, because a single trajectory is not a pattern.
   */
  readonly minVerifiedObservations?: number;
}

export interface CapsuleActivationRefused {
  readonly activated: false;
  readonly reasons: readonly string[];
  readonly capsule: StrategyCapsule;
}

export interface CapsuleActivated {
  readonly activated: true;
  readonly capsule: StrategyCapsule;
}

export type CapsuleActivationResult = CapsuleActivated | CapsuleActivationRefused;

export interface CapsuleActivationOptions {
  readonly reason?: string;
  /** The caller's assertion that a user approved this activation. */
  readonly approved?: boolean;
}

/**
 * §6.3's "코드·policy·toolset 변경 시 invalidator 평가". The trigger names what
 * moved; `subjects` are the concrete things that moved (changed paths, the new
 * policy digest, the tool ids now active) that an invalidator can name.
 */
export interface CapsuleInvalidationTrigger {
  readonly kind: "code" | "policy" | "toolset" | "workspace";
  readonly subjects?: readonly string[];
  readonly reason?: string;
}

export interface CapsuleInvalidationResult {
  readonly trigger: CapsuleInvalidationTrigger;
  readonly contested: readonly StrategyCapsule[];
}

export interface CapsuleRecallOptions {
  readonly scopes?: readonly CapsuleScope[];
  readonly kinds?: readonly CapsuleKind[];
  readonly now?: string;
}

/** The store's own floor, independent of what config asks for. */
export const MIN_VERIFIED_OBSERVATIONS_FLOOR = 2;
export const DEFAULT_MIN_VERIFIED_OBSERVATIONS = 3;

/**
 * Deterministic in-memory capsule store. The snapshot is the persistence
 * boundary, mirroring MemoryBank so the two can be journalled together.
 */
export class CapsuleStore {
  readonly #capsules = new Map<`capsule-${string}`, StrategyCapsule>();
  readonly #transitions: CapsuleTransition[] = [];
  readonly #now: () => string;
  readonly #minVerifiedObservations: number;
  readonly #policy: CapsuleLearningPolicy;
  #sequence = 0;

  constructor(options: CapsuleStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#minVerifiedObservations = Math.max(
      MIN_VERIFIED_OBSERVATIONS_FLOOR,
      Math.floor(options.minVerifiedObservations ?? DEFAULT_MIN_VERIFIED_OBSERVATIONS),
    );
    this.#policy = options.policy ?? "suggest";
  }

  get minVerifiedObservations(): number {
    return this.#minVerifiedObservations;
  }

  get policy(): CapsuleLearningPolicy {
    return this.#policy;
  }

  /** Whether activating this scope needs a user decision under the live policy. */
  requiresApproval(scope: CapsuleScope): boolean {
    return capsuleScopeRequiresApproval(scope, this.#policy);
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
    if (this.#policy === "off") reasons.push("strategy capsule learning is disabled (agent.learning.strategyCapsules)");
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

  /**
   * §6.3 activation. Refused unless the capsule has accumulated
   * `minVerifiedObservations` independent verified trajectories — a strategy
   * seen once is a coincidence, and the PRD asks for two to three before the
   * harness is allowed to act on it. `approved` is the caller's assertion that
   * a user said yes; the scope gate that requires it lands with the approval
   * hop, and is enforced here so no path can activate workspace or user scope
   * without one.
   */
  activate(id: `capsule-${string}`, options: CapsuleActivationOptions = {}): CapsuleActivationResult {
    const capsule = this.#capsules.get(id);
    if (capsule === undefined) throw new Error(`unknown strategy capsule: ${id}`);
    const reasons: string[] = [];
    if (capsule.status === "forgotten") reasons.push("a forgotten capsule cannot be reactivated");
    if (capsule.status === "contested") reasons.push("a contested capsule must be resolved before activation");
    if (this.requiresApproval(capsule.scope) && options.approved !== true) {
      reasons.push(`${capsule.scope} scope activation requires explicit user approval`);
    }
    if (capsule.observedCount < this.#minVerifiedObservations) {
      reasons.push(
        `capsule needs ${this.#minVerifiedObservations} independent verified observations, has ${capsule.observedCount}`,
      );
    }
    if (reasons.length > 0) {
      return Object.freeze({ activated: false, reasons: sortedUnique(reasons), capsule });
    }
    if (capsule.status === "active") return Object.freeze({ activated: true, capsule });

    const activated = freezeCapsule({
      ...capsule,
      status: "active",
      updatedAt: this.#now(),
      revision: capsule.revision + 1,
    });
    this.#capsules.set(id, activated);
    this.#record(capsule.status, activated, options.reason ?? "capsule activated");
    return Object.freeze({ activated: true, capsule: activated });
  }

  /** §6.3 `/learn reject`: the user declines a proposal outright. */
  reject(id: `capsule-${string}`, reason = "capsule rejected by the user"): StrategyCapsule {
    const capsule = this.#capsules.get(id);
    if (capsule === undefined) throw new Error(`unknown strategy capsule: ${id}`);
    const rejected = freezeCapsule({
      ...capsule,
      status: "forgotten",
      updatedAt: this.#now(),
      revision: capsule.revision + 1,
    });
    this.#capsules.set(id, rejected);
    this.#record(capsule.status, rejected, reason);
    return rejected;
  }

  /**
   * The recall surface. Only `active` capsules are ever returned: a proposal is
   * a suggestion awaiting a decision, and a contested or forgotten capsule is
   * excluded per §6.3. Expiry is honoured on read, as MemoryBank does.
   */
  recall(options: CapsuleRecallOptions = {}): readonly StrategyCapsule[] {
    const now = options.now ?? this.#now();
    return Object.freeze(this.all().filter((capsule) => {
      if (capsule.status !== "active") return false;
      if (capsule.expiresAt !== undefined && capsule.expiresAt <= now) return false;
      if (options.scopes !== undefined && !options.scopes.includes(capsule.scope)) return false;
      if (options.kinds !== undefined && !options.kinds.includes(capsule.kind)) return false;
      return true;
    }));
  }

  /**
   * Move every active capsule whose invalidator matches this trigger to
   * `contested`, which takes it out of recall. A stale strategy is worse than
   * no strategy — it keeps steering the model after the reason it was true has
   * gone — so this is deliberately blunt: a match demotes rather than rescores,
   * and the user resolves from `/learn review`.
   */
  evaluateInvalidators(trigger: CapsuleInvalidationTrigger): CapsuleInvalidationResult {
    const now = this.#now();
    const contested: StrategyCapsule[] = [];
    for (const capsule of this.all()) {
      if (capsule.status !== "active") continue;
      const matched = capsule.invalidators.filter((invalidator) =>
        invalidatorMatches(invalidator, trigger)
      );
      if (matched.length === 0) continue;
      const demoted = freezeCapsule({
        ...capsule,
        status: "contested",
        updatedAt: now,
        revision: capsule.revision + 1,
      });
      this.#capsules.set(capsule.id, demoted);
      this.#record(
        capsule.status,
        demoted,
        trigger.reason ?? `invalidated by ${trigger.kind} change: ${matched.join(", ")}`,
      );
      contested.push(demoted);
    }
    return Object.freeze({ trigger, contested: Object.freeze(contested) });
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

/**
 * An invalidator is free text the proposer wrote ("packages/foo changed",
 * "toolset changed"), so matching is textual. The trigger kind matches an
 * invalidator that names it; otherwise each significant word of the invalidator
 * is tried against each subject in both directions, so `packages/foo` matches
 * the changed path `packages/foo/src/bar.ts` and vice versa. Words that carry no
 * subject of their own are skipped, or every invalidator ending in "changed"
 * would match any path containing that word.
 */
function invalidatorMatches(invalidator: string, trigger: CapsuleInvalidationTrigger): boolean {
  const needle = invalidator.trim().toLowerCase();
  if (needle.length === 0) return false;
  if (needle.includes(trigger.kind)) return true;
  const words = needle.split(/\s+/).filter((word) => word.length >= 3 && !INVALIDATOR_STOP_WORDS.has(word));
  for (const subject of trigger.subjects ?? []) {
    const candidate = subject.trim().toLowerCase();
    if (candidate.length === 0) continue;
    if (candidate.includes(needle)) return true;
    for (const word of words) {
      if (candidate.includes(word) || word.includes(candidate)) return true;
    }
  }
  return false;
}

const INVALIDATOR_STOP_WORDS: ReadonlySet<string> = new Set([
  "and", "any", "are", "changed", "changes", "digest", "for", "modified", "new",
  "the", "updated", "was", "were", "when", "with",
]);

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function isConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
