/**
 * Adaptive context-pressure policy.
 *
 * The controller is deliberately provider-neutral and side-effect free at the
 * decision boundary. It predicts the next compiled request instead of reacting
 * to the previous request's usage, which lets the runtime compact before a
 * suddenly large context pack or tool schema pushes a request over the window.
 */

export type TokenSavingLevel = "off" | "light" | "balanced" | "strong";

export interface ContextPressureInput {
  readonly currentCompiledTokens: number;
  readonly inputBudgetTokens: number;

  readonly pendingHistoryDeltaTokens: number;
  readonly pendingContextPackTokens: number;
  readonly recentRequestGrowthP95: number;
  readonly reservedToolExpansionTokens: number;

  readonly lastCompaction?: {
    readonly generation: number;
    readonly tokensAfter: number;
    readonly newTokensSince: number;
  };

  readonly tokenSavingLevel: TokenSavingLevel;
  /** Model-specific minimum free space. Auto is derived from the input budget. */
  readonly modelMinFreeTokens?: number;
  readonly minFreeTokens?: number;
  readonly targetFreeTokens?: number;
  readonly safetyMultiplier?: number;
  readonly emergencyRatio?: number;
  /** A lower target is allowed for stronger saving, but never changes safety. */
  readonly targetRatio?: number;
}

export type ContextPressureState = "stable" | "prepare" | "compact" | "emergency";

export interface ContextPressureDecision {
  readonly state: ContextPressureState;
  readonly projectedTokens: number;
  readonly requiredFreeTokens: number;
  readonly targetTokens?: number;
  readonly reasonCodes: readonly string[];
  readonly currentRatio: number;
  readonly inputBudgetTokens: number;
}

export interface ContextPressureSnapshot {
  readonly recentGrowth: readonly number[];
  readonly recentRequestGrowthP95: number;
  readonly generation: number;
}

const DEFAULT_EMERGENCY_RATIO = 0.9;
const DEFAULT_GROWTH_WINDOW = 6;
const DEFAULT_SAFETY_MULTIPLIER: Readonly<Record<TokenSavingLevel, number>> = {
  off: 1.25,
  light: 1.3,
  balanced: 1.4,
  strong: 1.5,
};
const DEFAULT_TARGET_RATIO: Readonly<Record<TokenSavingLevel, number>> = {
  // These are compaction targets, not trigger thresholds. The safety line is
  // still controlled by requiredFreeTokens for every level, including off.
  off: 0.9,
  light: 0.84,
  balanced: 0.76,
  strong: 0.68,
};

function finiteNonNegative(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Nearest-rank percentile with deterministic interpolation. */
export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const p = Math.min(1, Math.max(0, percentileValue));
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const left = sorted[lower] ?? 0;
  const right = sorted[upper] ?? left;
  return left + (right - left) * (rank - lower);
}

function targetRatioFor(input: ContextPressureInput): number {
  const configured = input.targetRatio;
  if (configured !== undefined && Number.isFinite(configured) && configured > 0 && configured <= 1) return configured;
  return DEFAULT_TARGET_RATIO[input.tokenSavingLevel] ?? DEFAULT_TARGET_RATIO.off;
}

/** Evaluate one candidate prompt. This function never mutates input or state. */
export function evaluateContextPressure(input: ContextPressureInput): ContextPressureDecision {
  const budget = Math.floor(finitePositive(input.inputBudgetTokens, 0));
  if (budget <= 0) {
    return {
      state: "emergency",
      projectedTokens: Number.MAX_SAFE_INTEGER,
      requiredFreeTokens: Number.MAX_SAFE_INTEGER,
      reasonCodes: ["invalid_input_budget"],
      currentRatio: 1,
      inputBudgetTokens: 0,
    };
  }

  const current = Math.floor(finiteNonNegative(input.currentCompiledTokens));
  const pendingHistory = Math.floor(finiteNonNegative(input.pendingHistoryDeltaTokens));
  const pendingPack = Math.floor(finiteNonNegative(input.pendingContextPackTokens));
  const growthP95 = Math.floor(finiteNonNegative(input.recentRequestGrowthP95));
  const reservedTool = Math.floor(finiteNonNegative(input.reservedToolExpansionTokens));
  const projectedTokens = current + pendingHistory + pendingPack + Math.max(growthP95, reservedTool);
  const emergencyRatio = input.emergencyRatio !== undefined && Number.isFinite(input.emergencyRatio) && input.emergencyRatio > 0 && input.emergencyRatio <= 1
    ? input.emergencyRatio
    : DEFAULT_EMERGENCY_RATIO;
  const safetyMultiplier = finitePositive(input.safetyMultiplier, DEFAULT_SAFETY_MULTIPLIER[input.tokenSavingLevel] ?? DEFAULT_SAFETY_MULTIPLIER.off);
  const modelMinimum = Math.min(
    budget,
    Math.floor(finiteNonNegative(input.modelMinFreeTokens, Math.max(1, Math.min(1_024, Math.ceil(budget * 0.05))))),
  );
  const configuredMinimum = Math.floor(finiteNonNegative(input.minFreeTokens, 0));
  const configuredTargetFree = Math.floor(finiteNonNegative(input.targetFreeTokens, 0));
  const requiredFreeTokens = Math.min(
    budget,
    Math.max(modelMinimum, configuredMinimum, Math.ceil(growthP95 * safetyMultiplier), reservedTool),
  );
  const currentRatio = current / budget;
  const reasons: string[] = [];
  if (pendingHistory > 0) reasons.push("pending_history_delta");
  if (pendingPack > 0) reasons.push("pending_context_pack");
  if (growthP95 > 0) reasons.push("recent_growth_p95");
  if (reservedTool > 0) reasons.push("reserved_tool_expansion");

  const emergencyByCurrent = currentRatio >= emergencyRatio;
  const emergencyByProjection = projectedTokens > budget && currentRatio >= emergencyRatio;
  const budgetExceeded = projectedTokens > budget;
  let state: ContextPressureState;
  if (emergencyByCurrent || emergencyByProjection) {
    state = "emergency";
    if (emergencyByCurrent) reasons.push("current_emergency_ratio");
    if (emergencyByProjection) reasons.push("projected_request_over_budget");
  } else if (budgetExceeded || projectedTokens + requiredFreeTokens > budget) {
    state = "compact";
    if (budgetExceeded) reasons.push("projected_request_over_budget");
    else reasons.push("required_free_space_at_risk");
  } else if (projectedTokens + requiredFreeTokens > Math.floor(budget * 0.8) || currentRatio >= 0.8) {
    state = "prepare";
    reasons.push("prepare_free_space");
  } else {
    state = "stable";
    reasons.push("within_adaptive_budget");
  }

  if (input.lastCompaction !== undefined && input.lastCompaction.newTokensSince < Math.max(256, Math.floor(requiredFreeTokens / 2)) && state === "compact" && projectedTokens <= budget && currentRatio < emergencyRatio) {
    // A generation guard prevents a compile/compact callback from spinning when
    // a compaction did not materially change the next candidate.
    state = "prepare";
    reasons.push("compaction_generation_guard");
  }

  const targetFree = Math.max(requiredFreeTokens, configuredMinimum, configuredTargetFree);
  const target = Math.max(1_024, Math.floor(Math.min(
    budget - targetFree,
    budget * targetRatioFor(input),
    // A target at or above the emergency line is unsatisfiable: hitting it
    // exactly re-triggers `currentRatio >= emergencyRatio` on the next
    // evaluation. At the shipped default both ratios are 0.9, so a perfectly
    // executed compaction re-entered emergency immediately.
    budget * emergencyRatio - 1,
  )));
  return {
    state,
    projectedTokens,
    requiredFreeTokens,
    ...(state === "compact" || state === "emergency"
      // Clamped to what is actually there: a target above `current` would ask
      // compaction to grow the prompt. The emergency-line floor is applied when
      // `target` is computed, so the clamp cannot re-raise it past the line.
      ? { targetTokens: Math.min(current, target) }
      : {}),
    reasonCodes: [...new Set(reasons)],
    currentRatio,
    inputBudgetTokens: budget,
  };
}

/** Stateful growth sampler used by a session; evaluation itself remains pure. */
export class ContextPressureController {
  readonly #growthWindow: number;
  readonly #growth: number[] = [];
  #generation = 0;
  #lastTokens: number | undefined;

  constructor(options: { readonly growthWindow?: number } = {}) {
    this.#growthWindow = Math.max(1, Math.floor(options.growthWindow ?? DEFAULT_GROWTH_WINDOW));
  }

  observeCompiledTokens(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) return;
    const normalized = Math.floor(tokens);
    if (this.#lastTokens !== undefined) {
      this.#growth.push(Math.max(0, normalized - this.#lastTokens));
      while (this.#growth.length > this.#growthWindow) this.#growth.shift();
    }
    this.#lastTokens = normalized;
  }

  noteCompaction(generation = this.#generation + 1): void {
    this.#generation = Math.max(this.#generation + 1, Math.floor(generation));
    this.#lastTokens = undefined;
  }

  reset(): void {
    this.#growth.length = 0;
    this.#generation = 0;
    this.#lastTokens = undefined;
  }

  get recentRequestGrowthP95(): number {
    return percentile(this.#growth, 0.95);
  }

  get generation(): number {
    return this.#generation;
  }

  snapshot(): ContextPressureSnapshot {
    return {
      recentGrowth: [...this.#growth],
      recentRequestGrowthP95: this.recentRequestGrowthP95,
      generation: this.#generation,
    };
  }

  evaluate(input: Omit<ContextPressureInput, "recentRequestGrowthP95" | "lastCompaction"> & Partial<Pick<ContextPressureInput, "lastCompaction" | "recentRequestGrowthP95">>): ContextPressureDecision {
    return evaluateContextPressure({
      ...input,
      recentRequestGrowthP95: input.recentRequestGrowthP95 ?? this.recentRequestGrowthP95,
      ...(input.lastCompaction === undefined ? {} : { lastCompaction: input.lastCompaction }),
    });
  }
}

export const CONTEXT_PRESSURE_DEFAULTS = {
  emergencyRatio: DEFAULT_EMERGENCY_RATIO,
  growthWindow: DEFAULT_GROWTH_WINDOW,
} as const;
