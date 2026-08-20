/**
 * Turn state machine — PRD §11.2, §G2.
 *
 * The states and edges below are transcribed directly from §11.2. Encoding the
 * edge set explicitly (rather than letting the loop assign states ad hoc) is what
 * makes §25.2's "AgentKernel state transitions" testable and keeps the live state
 * line in §6.12 honest.
 */

export type TurnState =
  | "idle"
  | "preparing"
  | "sampling"
  | "tool_selection"
  | "awaiting_approval"
  | "executing"
  | "cancelling"
  | "observing"
  /**
   * Self-reflection: the loop has an observation it cannot simply act on — a
   * failed tool call or a failed verification — and analyses *why* before
   * sampling again. Without this state a failure and a success take the same
   * path, which is how an agent retries the same broken call three times.
   */
  | "reflecting"
  /**
   * Re-planning: reflection concluded the approach itself is wrong, not just the
   * last call, so the plan is rebuilt before the next sample. Kept distinct from
   * `reflecting` because only this state may roll a transaction checkpoint back.
   */
  | "re_planning"
  | "verifying"
  | "retrying"
  | "completed"
  | "cancelled"
  | "failed"
  | "partial";

export type TurnEvent =
  | "submit"
  | "invalid_input"
  | "context_built"
  | "commentary_delta"
  | "tool_calls"
  | "final_answer"
  | "cancel"
  | "provider_error"
  /** The provider stopped before a complete response; terminal partial, never final. */
  | "response_incomplete"
  | "retry_ready"
  | "invalid_schema"
  | "allowed"
  | "approval_needed"
  | "denied"
  | "observed"
  | "allow"
  | "deny"
  | "result"
  | "error"
  | "budget_remains"
  | "budget_exhausted"
  | "accepted"
  | "needs_repair"
  | "irrecoverable"
  | "cancel_complete"
  /** A tool failed or verification rejected the change: analyse it. */
  | "reflection_needed"
  /** Reflection produced a corrected hypothesis; the plan still holds. */
  | "hypothesis_updated"
  /** Reflection concluded the whole approach is wrong; rebuild the plan. */
  | "plan_invalidated"
  /** The re-planned corrective step is ready to sample. */
  | "correction_ready"
  /** A final answer was withheld because root TODO work is still actionable. */
  | "todo_incomplete"
  /** Root TODO work cannot be completed in this turn, so report partial truthfully. */
  | "todo_unresolved";

/** The §11.2 transition table. */
const TRANSITIONS: Readonly<Record<TurnState, Partial<Record<TurnEvent, TurnState>>>> = {
  idle: { submit: "preparing" },
  preparing: { invalid_input: "failed", context_built: "sampling", cancel: "cancelled" },
  sampling: {
    commentary_delta: "sampling",
    tool_calls: "tool_selection",
    final_answer: "verifying",
    cancel: "cancelled",
    provider_error: "retrying",
    response_incomplete: "partial",
    irrecoverable: "failed",
  },
  retrying: { retry_ready: "sampling", irrecoverable: "failed", cancel: "cancelled" },
  tool_selection: {
    invalid_schema: "observing",
    allowed: "executing",
    approval_needed: "awaiting_approval",
    denied: "observing",
    // A batch that produced only inline observations (or no runnable call at
    // all) still has to reach `observing`. Without this edge `tool_selection`
    // is a dead end and the turn loop spins on it forever.
    observed: "observing",
    cancel: "cancelled",
  },
  awaiting_approval: { allow: "executing", deny: "observing", cancel: "cancelled" },
  executing: { result: "observing", error: "observing", cancel: "cancelling" },
  cancelling: { cancel_complete: "cancelled" },
  observing: {
    budget_remains: "sampling",
    budget_exhausted: "verifying",
    // A failed observation is diagnosed before the next sample, so the model is
    // given a cause rather than being left to guess from the raw error.
    reflection_needed: "reflecting",
    cancel: "cancelled",
  },
  reflecting: {
    // The hypothesis was wrong but the plan is salvageable: sample a correction.
    hypothesis_updated: "sampling",
    // The approach itself was wrong: rebuild the plan first.
    plan_invalidated: "re_planning",
    // Reflection found nothing actionable; fall through to the honest report.
    accepted: "verifying",
    irrecoverable: "failed",
    // Reflection is not a place to park: an exhausted budget terminates here
    // rather than looping back into `verifying`, which reflection can re-enter.
    budget_exhausted: "partial",
    cancel: "cancelled",
  },
  re_planning: {
    correction_ready: "sampling",
    irrecoverable: "failed",
    budget_exhausted: "partial",
    cancel: "cancelled",
  },
  verifying: {
    accepted: "completed",
    needs_repair: "sampling",
    // A provider answer is not final while actionable root TODO work remains.
    todo_incomplete: "sampling",
    // Blocked, skipped, malformed, or budget-exhausted TODO work is partial,
    // never a completed turn.
    todo_unresolved: "partial",
    // A rejected verification is the second entry point to reflection (§11.8).
    reflection_needed: "reflecting",
    irrecoverable: "failed",
    budget_exhausted: "partial",
    cancel: "cancelled",
  },
  completed: {},
  cancelled: {},
  failed: {},
  partial: {},
};

export const TERMINAL_STATES: readonly TurnState[] = [
  "completed",
  "cancelled",
  "failed",
  "partial",
];

export function isTerminal(state: TurnState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: TurnState, event: TurnEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function nextState(from: TurnState, event: TurnEvent): TurnState | undefined {
  return TRANSITIONS[from][event];
}

/**
 * A guarded state holder. An illegal transition throws rather than being ignored,
 * because a silently-dropped transition would desynchronize the live state line
 * from what the kernel is actually doing (§6.12, P2).
 */
export class TurnStateMachine {
  #state: TurnState;
  readonly #history: Array<{ from: TurnState; event: TurnEvent; to: TurnState }> = [];

  constructor(initial: TurnState = "idle") {
    this.#state = initial;
  }

  get state(): TurnState {
    return this.#state;
  }

  get history(): ReadonlyArray<{ from: TurnState; event: TurnEvent; to: TurnState }> {
    return this.#history;
  }

  get terminal(): boolean {
    return isTerminal(this.#state);
  }

  /**
   * Predicate form of the state check. Comparing the `state` getter directly
   * lets TypeScript's control-flow analysis narrow it and then keep that
   * narrowing across an `apply`/`tryApply` call it cannot see through, which
   * turns a later comparison into dead code. Going through a method keeps every
   * check honest against the current state.
   */
  isIn(...states: readonly TurnState[]): boolean {
    return states.includes(this.#state);
  }

  /** Apply an event. Returns the new state. */
  apply(event: TurnEvent): TurnState {
    const to = nextState(this.#state, event);
    if (to === undefined) {
      throw new Error(`illegal turn transition: ${this.#state} --${event}-->`);
    }
    this.#history.push({ from: this.#state, event, to });
    this.#state = to;
    return to;
  }

  /** Apply only if legal; returns whether it happened. */
  tryApply(event: TurnEvent): boolean {
    if (!canTransition(this.#state, event)) return false;
    this.apply(event);
    return true;
  }

  /** How many times the loop returned to sampling, i.e. the step count. */
  samplingCount(): number {
    return this.#history.filter((h) => h.to === "sampling").length;
  }

  repairCount(): number {
    return this.#history.filter((h) => h.event === "needs_repair").length;
  }

  /** How many times the loop entered self-reflection. */
  reflectionCount(): number {
    return this.#history.filter((h) => h.to === "reflecting").length;
  }

  /** How many times reflection discarded the plan outright. */
  rePlanCount(): number {
    return this.#history.filter((h) => h.event === "plan_invalidated").length;
  }
}

/** §11.3 loop limits. */
export interface LoopLimits {
  readonly maxModelSteps: number;
  readonly maxToolCalls: number;
  readonly maxWallTimeMs: number;
  readonly maxConcurrentBackgroundJobs: number;
  readonly maxChildDepth: number;
  readonly maxRepairCycles: number;
  readonly maxReviewCycles: number;
  /**
   * How many times a turn may enter self-reflection. Reflection costs a model
   * call and produces no work of its own, so an unbounded reflection loop is a
   * way to burn a budget while looking busy.
   */
  readonly maxReflectionCycles: number;
}

/**
 * How many times the *same* failure may recur before the loop stops trying.
 *
 * Three identical failures is the point at which another attempt is no longer
 * self-correction but repetition: the model has already had two chances to act
 * on the same diagnosis. Past this the turn stops and hands the decision back.
 */
export const MAX_CONSECUTIVE_SAME_FAILURE = 3;

export const ROOT_LIMITS: LoopLimits = {
  // Root turns have no step, tool-call, or wall-time ceiling. The loop still
  // stops on completion, explicit cancellation, repeated failure, or a hard
  // provider/runtime error.
  maxModelSteps: Number.POSITIVE_INFINITY,
  maxToolCalls: Number.POSITIVE_INFINITY,
  maxWallTimeMs: Number.POSITIVE_INFINITY,
  maxConcurrentBackgroundJobs: 4,
  maxChildDepth: 1,
  maxRepairCycles: 2,
  maxReviewCycles: 2,
  maxReflectionCycles: 3,
};

export const SUBAGENT_LIMITS: LoopLimits = {
  maxModelSteps: 16,
  maxToolCalls: 32,
  maxWallTimeMs: 30 * 60 * 1000,
  maxConcurrentBackgroundJobs: 8,
  maxChildDepth: 0,
  maxRepairCycles: 2,
  maxReviewCycles: 0,
  maxReflectionCycles: 3,
};

export interface BudgetState {
  modelSteps: number;
  toolCalls: number;
  startedAtMs: number;
  repairCycles: number;
  reviewCycles: number;
  reflectionCycles: number;
}

export function newBudget(now = Date.now()): BudgetState {
  return {
    modelSteps: 0,
    toolCalls: 0,
    startedAtMs: now,
    repairCycles: 0,
    reviewCycles: 0,
    reflectionCycles: 0,
  };
}

export type BudgetExhaustion =
  | "model_steps"
  | "tool_calls"
  | "wall_time"
  | "repair_cycles"
  | "review_cycles"
  | "reflection_cycles";

/**
 * Which budget, if any, is exhausted. §11.3: reaching a limit must produce a
 * partial completion contract, never a silent stop.
 */
export function budgetExhausted(
  budget: BudgetState,
  limits: LoopLimits,
  now = Date.now(),
): BudgetExhaustion | undefined {
  if (budget.modelSteps >= limits.maxModelSteps) return "model_steps";
  if (budget.toolCalls >= limits.maxToolCalls) return "tool_calls";
  if (now - budget.startedAtMs >= limits.maxWallTimeMs) return "wall_time";
  if (budget.repairCycles > limits.maxRepairCycles) return "repair_cycles";
  if (budget.reviewCycles > limits.maxReviewCycles) return "review_cycles";
  if (budget.reflectionCycles > limits.maxReflectionCycles) return "reflection_cycles";
  return undefined;
}

export function describeExhaustion(kind: BudgetExhaustion, limits: LoopLimits): string {
  switch (kind) {
    case "model_steps":
      return `reached the ${limits.maxModelSteps}-step model budget`;
    case "tool_calls":
      return `reached the ${limits.maxToolCalls}-call tool budget`;
    case "wall_time":
      return `reached the ${Math.round(limits.maxWallTimeMs / 60_000)}-minute wall-time budget`;
    case "repair_cycles":
      return `reached the ${limits.maxRepairCycles}-cycle repair budget`;
    case "review_cycles":
      return `reached the ${limits.maxReviewCycles}-cycle review budget`;
    case "reflection_cycles":
      return `reached the ${limits.maxReflectionCycles}-cycle self-correction budget`;
  }
}
