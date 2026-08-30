/**
 * Persistent Goal Contract (PRD P1-04).
 *
 * Deep Plan, the TODO list, and the session daemon each already survive a
 * detach, but nothing ties them to a single statement of *what finishing means*.
 * Without that, a long-running goal has only the model's own judgement to stop
 * it, and the PRD's requirement — "무한 '계속 시도' 대신 명확한 stop condition과
 * 반복 실패 ceiling" — cannot be enforced by the host.
 *
 * A contract is therefore deliberately declarative and deterministic: it names
 * the success criteria, the scope the work may touch, the conditions that must
 * stop it, and a budget. Evaluation is a pure function of the contract plus the
 * observed TODO/verification state, so the same inputs always produce the same
 * verdict and a resumed session reaches the same conclusion the detached one
 * would have.
 *
 * The contract never grants authority. It cannot widen `allowedScope` into a
 * permission, and a stop condition can only end work early — never continue
 * past a budget the user set.
 */

import { createHash } from "node:crypto";

import type { PlanItem, TodoListState } from "./todo.ts";

export type GoalContractStatus =
  | "active"
  | "satisfied"
  | "stopped"
  | "blocked"
  | "abandoned";

/**
 * Why a contract stopped. `budget_exhausted` and `max_turns` are ceilings the
 * user set; `stop_condition` is one the contract itself declared; the rest are
 * states the host observed and cannot resolve on its own.
 */
export type GoalStopReason =
  | "success_criteria_met"
  | "budget_exhausted"
  | "max_turns"
  | "wall_time"
  | "stop_condition"
  | "approval_required"
  | "blocked"
  | "repeated_failure"
  | "user_abandoned";

export interface GoalBudget {
  readonly wallTimeMs: number;
  readonly costUsd?: number;
  readonly maxTurns: number;
}

/**
 * A success criterion is checkable rather than prose: `todo` means the named
 * TODO ids must all be done, `verification` means a verification record must
 * exist for the named check, and `manual` is a criterion only the user can
 * close — it never satisfies itself.
 */
export interface GoalSuccessCriterion {
  readonly id: string;
  readonly statement: string;
  readonly kind: "todo" | "verification" | "manual";
  /** TODO ids for `todo`, check ids for `verification`. */
  readonly refs?: readonly string[];
}

export interface GoalContract {
  readonly id: string;
  readonly goal: string;
  readonly goalDigest: string;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly allowedScope: readonly string[];
  readonly stopConditions: readonly string[];
  readonly heartbeatPolicy: GoalHeartbeatPolicy;
  readonly verificationPolicy: GoalVerificationPolicy;
  readonly budget: GoalBudget;
  readonly createdAt: string;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
}

/**
 * How often a detached contract must report liveness. A daemon that stops
 * emitting progress is indistinguishable from one that hung, so the interval is
 * part of the contract rather than a daemon implementation detail.
 */
export interface GoalHeartbeatPolicy {
  readonly intervalMs: number;
  /** Consecutive missed intervals after which the contract is stopped. */
  readonly maxMissed: number;
}

export interface GoalVerificationPolicy {
  readonly level: "focused" | "package" | "integration" | "independent_review";
  /** Every success criterion needs fresh evidence, not a stale pass. */
  readonly requireFreshEvidence: boolean;
}

export interface GoalProgress {
  readonly turnsUsed: number;
  readonly elapsedMs: number;
  readonly costUsd?: number;
  readonly missedHeartbeats?: number;
  /** Consecutive identical failures, from the kernel's repetition counter. */
  readonly repeatedFailures?: number;
  /** Verification check ids that hold a fresh passing record. */
  readonly satisfiedChecks?: readonly string[];
  /** Criterion ids the user closed by hand. */
  readonly manualCriteriaMet?: readonly string[];
  readonly awaitingApproval?: boolean;
  readonly blockedReason?: string;
  /** Paths the turn actually changed, checked against the declared scope. */
  readonly changedPaths?: readonly string[];
}

export interface GoalEvaluation {
  readonly status: GoalContractStatus;
  readonly stopReason?: GoalStopReason;
  /** Criterion ids still open, in contract order. */
  readonly outstandingCriteria: readonly string[];
  /** The TODO to work next, when the contract is still active. */
  readonly nextTodoId?: string;
  /** A user-facing sentence naming the exact state (§P1-04(c)). */
  readonly statement: string;
  /**
   * Changed paths outside `allowedScope`. Reported, never enforced: the contract
   * declares intent and the permission layer owns authority, so a scope drift
   * has to be visible without becoming a second, weaker gate that could
   * disagree with the real one.
   */
  readonly outOfScopePaths?: readonly string[];
  readonly budgetRemaining: {
    readonly turns: number;
    readonly wallTimeMs: number;
    readonly costUsd?: number;
  };
}

const MAX_TEXT = 2_000;
const MAX_LIST = 64;
const ANSI_OR_CONTROL = /[\u0000-\u001F\u007F]/gu;

export const DEFAULT_GOAL_HEARTBEAT: GoalHeartbeatPolicy = {
  intervalMs: 60_000,
  maxMissed: 5,
};

export const DEFAULT_GOAL_VERIFICATION: GoalVerificationPolicy = {
  level: "package",
  requireFreshEvidence: true,
};

export interface GoalContractInput {
  readonly goal: string;
  readonly successCriteria?: readonly Partial<GoalSuccessCriterion>[];
  readonly allowedScope?: readonly string[];
  readonly stopConditions?: readonly string[];
  readonly heartbeatPolicy?: Partial<GoalHeartbeatPolicy>;
  readonly verificationPolicy?: Partial<GoalVerificationPolicy>;
  readonly budget?: Partial<GoalBudget>;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly now?: string;
}

function sanitize(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string"
    ? value.replace(ANSI_OR_CONTROL, "").trim().slice(0, max)
    : "";
}

function sanitizeList(value: unknown, max = MAX_LIST): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const clean = sanitize(entry, 512);
    if (clean.length > 0 && !out.includes(clean)) out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build a contract from host input. Unspecified budgets get finite defaults on
 * purpose: an absent ceiling would otherwise read as "no ceiling", which is the
 * unbounded-retry behaviour the PRD forbids.
 */
export function createGoalContract(input: GoalContractInput): GoalContract {
  const goal = sanitize(input.goal);
  if (goal.length === 0) throw new Error("a goal contract requires a goal statement");
  const now = input.now ?? new Date().toISOString();
  const goalDigest = digest({ goal });
  const criteria = normalizeCriteria(input.successCriteria);
  const budget: GoalBudget = {
    wallTimeMs: positive(input.budget?.wallTimeMs, 30 * 60_000),
    maxTurns: Math.max(1, Math.floor(positive(input.budget?.maxTurns, 24))),
    ...(input.budget?.costUsd !== undefined
      ? { costUsd: positive(input.budget.costUsd, 0) }
      : {}),
  };
  return {
    id: `goal-${digest({ goal, now }).slice(0, 16)}`,
    goal,
    goalDigest,
    successCriteria: Object.freeze(criteria),
    allowedScope: Object.freeze(sanitizeList(input.allowedScope)),
    stopConditions: Object.freeze(sanitizeList(input.stopConditions)),
    heartbeatPolicy: {
      intervalMs: positive(input.heartbeatPolicy?.intervalMs, DEFAULT_GOAL_HEARTBEAT.intervalMs),
      maxMissed: Math.max(
        1,
        Math.floor(positive(input.heartbeatPolicy?.maxMissed, DEFAULT_GOAL_HEARTBEAT.maxMissed)),
      ),
    },
    verificationPolicy: {
      level: input.verificationPolicy?.level ?? DEFAULT_GOAL_VERIFICATION.level,
      requireFreshEvidence:
        input.verificationPolicy?.requireFreshEvidence ??
        DEFAULT_GOAL_VERIFICATION.requireFreshEvidence,
    },
    budget,
    createdAt: now,
    ...(input.taskEpochId !== undefined ? { taskEpochId: input.taskEpochId } : {}),
    ...(input.workspaceIdentityDigest !== undefined
      ? { workspaceIdentityDigest: input.workspaceIdentityDigest }
      : {}),
  };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeCriteria(
  input: readonly Partial<GoalSuccessCriterion>[] | undefined,
): GoalSuccessCriterion[] {
  if (input === undefined) return [];
  const out: GoalSuccessCriterion[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const statement = sanitize(raw.statement, 512);
    if (statement.length === 0) continue;
    const id = sanitize(raw.id, 64) || `criterion-${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = raw.kind === "todo" || raw.kind === "verification" ? raw.kind : "manual";
    const refs = sanitizeList(raw.refs, 32);
    out.push({
      id,
      statement,
      kind,
      ...(refs.length > 0 ? { refs } : {}),
    });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/**
 * Decide whether the contract is finished, and if not, what to do next.
 *
 * Order matters. Ceilings are checked before satisfaction so a contract cannot
 * claim success on the turn that also blew its budget, and `blocked`/approval
 * outrank both because neither is something the agent may work around.
 */
export function evaluateGoalContract(
  contract: GoalContract,
  todos: TodoListState,
  progress: GoalProgress,
): GoalEvaluation {
  const outstanding = outstandingCriteria(contract, todos, progress);
  const outOfScope = (progress.changedPaths ?? []).filter(
    (path) => !withinGoalScope(contract, path),
  );
  const scope = outOfScope.length > 0 ? { outOfScopePaths: outOfScope } : {};
  const remaining = {
    turns: Math.max(0, contract.budget.maxTurns - Math.max(0, progress.turnsUsed)),
    wallTimeMs: Math.max(0, contract.budget.wallTimeMs - Math.max(0, progress.elapsedMs)),
    ...(contract.budget.costUsd !== undefined
      ? { costUsd: Math.max(0, contract.budget.costUsd - Math.max(0, progress.costUsd ?? 0)) }
      : {}),
  };

  if (progress.blockedReason !== undefined && progress.blockedReason.length > 0) {
    return stopped("blocked", "blocked", outstanding, remaining, `blocked: ${progress.blockedReason}`);
  }
  if (progress.awaitingApproval === true) {
    return stopped(
      "blocked",
      "approval_required",
      outstanding,
      remaining,
      "waiting for approval before the next step can run",
      scope,
    );
  }
  if (remaining.wallTimeMs <= 0) {
    return stopped(
      "stopped",
      "wall_time",
      outstanding,
      remaining,
      `stopped after ${Math.round(contract.budget.wallTimeMs / 1000)}s of wall time`,
      scope,
    );
  }
  if (remaining.costUsd !== undefined && remaining.costUsd <= 0) {
    return stopped(
      "stopped",
      "budget_exhausted",
      outstanding,
      remaining,
      `stopped at the $${contract.budget.costUsd?.toFixed(2)} cost ceiling`,
      scope,
    );
  }
  if (
    progress.repeatedFailures !== undefined &&
    progress.repeatedFailures >= contract.heartbeatPolicy.maxMissed
  ) {
    return stopped(
      "stopped",
      "repeated_failure",
      outstanding,
      remaining,
      `stopped after ${progress.repeatedFailures} consecutive identical failures`,
      scope,
    );
  }
  if (
    progress.missedHeartbeats !== undefined &&
    progress.missedHeartbeats >= contract.heartbeatPolicy.maxMissed
  ) {
    return stopped(
      "stopped",
      "stop_condition",
      outstanding,
      remaining,
      `stopped after ${progress.missedHeartbeats} missed heartbeats`,
      scope,
    );
  }
  if (outstanding.length === 0 && contract.successCriteria.length > 0) {
    return {
      status: "satisfied",
      stopReason: "success_criteria_met",
      outstandingCriteria: [],
      statement: `every success criterion for "${contract.goal}" is met`,
      budgetRemaining: remaining,
      ...scope,
    };
  }
  if (remaining.turns <= 0) {
    return stopped(
      "stopped",
      "max_turns",
      outstanding,
      remaining,
      `stopped at the ${contract.budget.maxTurns}-turn ceiling with ${outstanding.length} criteria open`,
      scope,
    );
  }

  const next = nextTodo(todos.items);
  return {
    status: "active",
    outstandingCriteria: outstanding,
    ...(next !== undefined ? { nextTodoId: next.id } : {}),
    statement:
      next === undefined
        ? `${outstanding.length} criteria open and no TODO left to advance them`
        : `working ${next.id}: ${next.text}`,
    budgetRemaining: remaining,
    ...scope,
  };
}

function stopped(
  status: GoalContractStatus,
  stopReason: GoalStopReason,
  outstandingCriteria: readonly string[],
  budgetRemaining: GoalEvaluation["budgetRemaining"],
  statement: string,
  scope: { readonly outOfScopePaths?: readonly string[] } = {},
): GoalEvaluation {
  return { status, stopReason, outstandingCriteria, statement, budgetRemaining, ...scope };
}

function outstandingCriteria(
  contract: GoalContract,
  todos: TodoListState,
  progress: GoalProgress,
): string[] {
  const byId = new Map(todos.items.map((item) => [item.id, item]));
  const checks = new Set(progress.satisfiedChecks ?? []);
  const manual = new Set(progress.manualCriteriaMet ?? []);
  const open: string[] = [];
  for (const criterion of contract.successCriteria) {
    if (criterionMet(criterion, byId, checks, manual)) continue;
    open.push(criterion.id);
  }
  return open;
}

function criterionMet(
  criterion: GoalSuccessCriterion,
  todos: ReadonlyMap<string, PlanItem>,
  satisfiedChecks: ReadonlySet<string>,
  manualMet: ReadonlySet<string>,
): boolean {
  switch (criterion.kind) {
    case "todo": {
      const refs = criterion.refs ?? [];
      // A criterion naming no TODO cannot be closed by TODO state; treating an
      // empty ref list as "met" would let a contract satisfy itself.
      if (refs.length === 0) return false;
      return refs.every((id) => {
        const item = todos.get(id);
        return item !== undefined && (item.status === "done" || item.status === "skipped");
      });
    }
    case "verification": {
      const refs = criterion.refs ?? [];
      if (refs.length === 0) return false;
      return refs.every((id) => satisfiedChecks.has(id));
    }
    case "manual":
      return manualMet.has(criterion.id);
  }
}

/**
 * The next TODO to work: the active one if there is one, else the first pending
 * item whose dependencies are all closed. Dependency order is respected so the
 * contract never advances a step whose prerequisite is still open.
 */
export function nextTodo(items: readonly PlanItem[]): PlanItem | undefined {
  const active = items.find((item) => item.status === "active");
  if (active !== undefined) return active;
  const closed = new Set(
    items.filter((item) => item.status === "done" || item.status === "skipped").map((item) => item.id),
  );
  return items.find(
    (item) =>
      item.status === "pending" &&
      (item.dependsOn ?? []).every((dependency) => closed.has(dependency)),
  );
}

/** Whether a path is inside the contract's declared scope (§P1-04 allowedScope). */
export function withinGoalScope(contract: GoalContract, path: string): boolean {
  // An empty scope is "unscoped", not "nothing allowed": a contract that never
  // declared a scope must not silently block every write.
  if (contract.allowedScope.length === 0) return true;
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return contract.allowedScope.some((scope) => {
    const prefix = scope.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export interface GoalContractRecord {
  readonly contract: GoalContract;
  readonly progress: GoalProgress;
  readonly evaluation: GoalEvaluation;
  readonly updatedAt: string;
}

/** Parse a persisted record, returning undefined rather than throwing (§P1-04(d)). */
export function parseGoalContractRecord(raw: unknown): GoalContractRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const contract = record.contract;
  if (typeof contract !== "object" || contract === null) return undefined;
  const shape = contract as Record<string, unknown>;
  if (typeof shape.goal !== "string" || typeof shape.id !== "string") return undefined;
  try {
    const rebuilt = createGoalContract({
      goal: shape.goal,
      ...(Array.isArray(shape.successCriteria)
        ? { successCriteria: shape.successCriteria as Partial<GoalSuccessCriterion>[] }
        : {}),
      ...(Array.isArray(shape.allowedScope) ? { allowedScope: shape.allowedScope as string[] } : {}),
      ...(Array.isArray(shape.stopConditions)
        ? { stopConditions: shape.stopConditions as string[] }
        : {}),
      ...(typeof shape.heartbeatPolicy === "object" && shape.heartbeatPolicy !== null
        ? { heartbeatPolicy: shape.heartbeatPolicy as Partial<GoalHeartbeatPolicy> }
        : {}),
      ...(typeof shape.verificationPolicy === "object" && shape.verificationPolicy !== null
        ? { verificationPolicy: shape.verificationPolicy as Partial<GoalVerificationPolicy> }
        : {}),
      ...(typeof shape.budget === "object" && shape.budget !== null
        ? { budget: shape.budget as Partial<GoalBudget> }
        : {}),
      ...(typeof shape.taskEpochId === "string" ? { taskEpochId: shape.taskEpochId } : {}),
      ...(typeof shape.workspaceIdentityDigest === "string"
        ? { workspaceIdentityDigest: shape.workspaceIdentityDigest }
        : {}),
      ...(typeof shape.createdAt === "string" ? { now: shape.createdAt } : {}),
    });
    const progress = normalizeProgress(record.progress);
    return {
      // The persisted id is authoritative: rebuilding must not rename a
      // contract a resumed daemon is already reporting against.
      contract: { ...rebuilt, id: shape.id },
      progress,
      evaluation:
        typeof record.evaluation === "object" && record.evaluation !== null
          ? (record.evaluation as GoalEvaluation)
          : evaluateGoalContract({ ...rebuilt, id: shape.id }, { revision: 0, items: [], updatedAt: rebuilt.createdAt }, progress),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : rebuilt.createdAt,
    };
  } catch {
    return undefined;
  }
}

function normalizeProgress(raw: unknown): GoalProgress {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    turnsUsed: count(source.turnsUsed),
    elapsedMs: count(source.elapsedMs),
    ...(typeof source.costUsd === "number" ? { costUsd: count(source.costUsd) } : {}),
    ...(typeof source.missedHeartbeats === "number"
      ? { missedHeartbeats: count(source.missedHeartbeats) }
      : {}),
    ...(typeof source.repeatedFailures === "number"
      ? { repeatedFailures: count(source.repeatedFailures) }
      : {}),
    ...(Array.isArray(source.satisfiedChecks)
      ? { satisfiedChecks: sanitizeList(source.satisfiedChecks) }
      : {}),
    ...(Array.isArray(source.manualCriteriaMet)
      ? { manualCriteriaMet: sanitizeList(source.manualCriteriaMet) }
      : {}),
    ...(Array.isArray(source.changedPaths)
      ? { changedPaths: sanitizeList(source.changedPaths, 256) }
      : {}),
    ...(source.awaitingApproval === true ? { awaitingApproval: true } : {}),
    ...(typeof source.blockedReason === "string"
      ? { blockedReason: sanitize(source.blockedReason, 512) }
      : {}),
  };
}

/**
 * Owns one contract across the turns that pursue it.
 *
 * The controller exists so the goal outlives a single turn *and* a detach: it
 * accumulates progress, re-evaluates after every turn, and serializes to a
 * record a resumed session can hydrate. Deliberately kept free of I/O so the
 * daemon and the interactive session share one implementation of "is this goal
 * finished, and if not what next".
 */
export class GoalContractController {
  #contract: GoalContract | undefined;
  #progress: GoalProgress = { turnsUsed: 0, elapsedMs: 0 };
  #evaluation: GoalEvaluation | undefined;
  readonly #now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  current(): GoalContract | undefined {
    return this.#contract;
  }

  progress(): GoalProgress {
    return this.#progress;
  }

  evaluation(): GoalEvaluation | undefined {
    return this.#evaluation;
  }

  /** Adopt a contract, resetting progress: a new goal never inherits a spent budget. */
  start(input: GoalContractInput): GoalContract {
    const contract = createGoalContract({ now: this.#now(), ...input });
    this.#contract = contract;
    this.#progress = { turnsUsed: 0, elapsedMs: 0 };
    this.#evaluation = undefined;
    return contract;
  }

  clear(): void {
    this.#contract = undefined;
    this.#progress = { turnsUsed: 0, elapsedMs: 0 };
    this.#evaluation = undefined;
  }

  /**
   * Fold one turn's observations in and re-decide. `turnsUsed` is incremented
   * here rather than taken from the caller so a host cannot under-report turns
   * and talk its way past the ceiling.
   */
  recordTurn(observed: Omit<GoalProgress, "turnsUsed">, todos: TodoListState): GoalEvaluation | undefined {
    if (this.#contract === undefined) return undefined;
    this.#progress = {
      ...observed,
      turnsUsed: this.#progress.turnsUsed + 1,
      elapsedMs: Math.max(this.#progress.elapsedMs, observed.elapsedMs),
    };
    this.#evaluation = evaluateGoalContract(this.#contract, todos, this.#progress);
    return this.#evaluation;
  }

  /** Re-decide without consuming a turn — used when only TODO state moved. */
  reevaluate(todos: TodoListState): GoalEvaluation | undefined {
    if (this.#contract === undefined) return undefined;
    this.#evaluation = evaluateGoalContract(this.#contract, todos, this.#progress);
    return this.#evaluation;
  }

  toRecord(): GoalContractRecord | undefined {
    if (this.#contract === undefined || this.#evaluation === undefined) return undefined;
    return {
      contract: this.#contract,
      progress: this.#progress,
      evaluation: this.#evaluation,
      updatedAt: this.#now(),
    };
  }

  /** Restore from a persisted record; false leaves the controller untouched. */
  hydrate(raw: unknown): boolean {
    const record = parseGoalContractRecord(raw);
    if (record === undefined) return false;
    this.#contract = record.contract;
    this.#progress = record.progress;
    this.#evaluation = record.evaluation;
    return true;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
