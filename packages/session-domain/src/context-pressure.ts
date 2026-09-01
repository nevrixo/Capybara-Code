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
  /** Effective model input capacity after the output reserve and explicit hard cap. */
  readonly inputBudgetTokens: number;
  /** Full provider/model context window, retained for receipts and diagnostics. */
  readonly modelContextWindowTokens?: number;
  readonly outputReserveTokens?: number;

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
  readonly prepareRatio?: number;
  readonly triggerRatio?: number;
  readonly emergencyRatio?: number;
  /** A lower target is allowed for stronger saving, but never changes safety. */
  readonly targetRatio?: number;
  /** Minimum post-compaction growth before another attempt may run. */
  readonly minNewTokens?: number;
}

export type ContextPressureState = "stable" | "prepare" | "compact" | "emergency" | "hard_emergency";

export interface ContextPressureDecision {
  readonly state: ContextPressureState;
  readonly projectedTokens: number;
  readonly requiredFreeTokens: number;
  readonly targetTokens?: number;
  readonly reasonCodes: readonly string[];
  readonly currentRatio: number;
  readonly inputBudgetTokens: number;
  readonly basis: "model_input_capacity";
  readonly modelContextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly prepareRatio: number;
  readonly triggerRatio: number;
  readonly emergencyRatio: number;
  readonly targetRatio: number;
  readonly triggerTokens: number;
}

export interface ContextPressureSnapshot {
  readonly recentGrowth: readonly number[];
  readonly recentRequestGrowthP95: number;
  readonly generation: number;
}

const DEFAULT_PREPARE_RATIO = 0.8;
const DEFAULT_TRIGGER_RATIO = 0.9;
const DEFAULT_EMERGENCY_RATIO = 0.97;
const DEFAULT_TARGET_COMPILED_RATIO = 0.6;
const DEFAULT_MIN_NEW_TOKENS = 4_096;
const DEFAULT_GROWTH_WINDOW = 6;
const DEFAULT_SAFETY_MULTIPLIER: Readonly<Record<TokenSavingLevel, number>> = {
  off: 1.25,
  light: 1.3,
  balanced: 1.4,
  strong: 1.5,
};
const DEFAULT_TARGET_RATIO: Readonly<Record<TokenSavingLevel, number>> = {
  // Token saving may ask for a smaller post-compaction request, but the default
  // product contract remains 60% of actual model input capacity.
  off: DEFAULT_TARGET_COMPILED_RATIO,
  light: 0.58,
  balanced: 0.55,
  strong: 0.5,
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

function ratio(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : fallback;
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
      basis: "model_input_capacity",
      modelContextWindowTokens: 0,
      outputReserveTokens: 0,
      prepareRatio: DEFAULT_PREPARE_RATIO,
      triggerRatio: DEFAULT_TRIGGER_RATIO,
      emergencyRatio: DEFAULT_EMERGENCY_RATIO,
      targetRatio: DEFAULT_TARGET_COMPILED_RATIO,
      triggerTokens: 0,
    };
  }

  const current = Math.floor(finiteNonNegative(input.currentCompiledTokens));
  const pendingHistory = Math.floor(finiteNonNegative(input.pendingHistoryDeltaTokens));
  const pendingPack = Math.floor(finiteNonNegative(input.pendingContextPackTokens));
  const growthP95 = Math.floor(finiteNonNegative(input.recentRequestGrowthP95));
  const reservedTool = Math.floor(finiteNonNegative(input.reservedToolExpansionTokens));
  const projectedTokens = current + pendingHistory + pendingPack + Math.max(growthP95, reservedTool);
  const prepareRatio = ratio(input.prepareRatio, DEFAULT_PREPARE_RATIO);
  const triggerRatio = Math.max(prepareRatio, ratio(input.triggerRatio, DEFAULT_TRIGGER_RATIO));
  const emergencyRatio = Math.max(triggerRatio, ratio(input.emergencyRatio, DEFAULT_EMERGENCY_RATIO));
  const configuredTargetRatio = Math.min(
    triggerRatio,
    ratio(targetRatioFor(input), DEFAULT_TARGET_COMPILED_RATIO),
  );
  const outputReserveTokens = Math.floor(finiteNonNegative(input.outputReserveTokens));
  const modelContextWindowTokens = Math.max(
    budget + outputReserveTokens,
    Math.floor(finitePositive(input.modelContextWindowTokens, budget + outputReserveTokens)),
  );
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

  const projectedRatio = projectedTokens / budget;
  const hardByCurrent = current > budget;
  const emergencyByCurrent = currentRatio >= emergencyRatio;
  const compactByCurrent = currentRatio >= triggerRatio;
  const compactByProjection = projectedRatio >= triggerRatio;
  const prepareByCurrent = currentRatio >= prepareRatio;
  const prepareByProjection = projectedRatio >= prepareRatio;
  let state: ContextPressureState;
  if (hardByCurrent) {
    state = "hard_emergency";
    reasons.push("current_request_over_budget");
  } else if (emergencyByCurrent) {
    state = "emergency";
    reasons.push("current_emergency_ratio");
  } else if (compactByCurrent || compactByProjection) {
    state = "compact";
    if (compactByCurrent) reasons.push("current_trigger_ratio");
    if (compactByProjection) reasons.push("projected_trigger_ratio");
    if (projectedTokens > budget) reasons.push("projected_request_over_budget");
  } else if (prepareByCurrent || prepareByProjection) {
    state = "prepare";
    if (prepareByCurrent) reasons.push("current_prepare_ratio");
    if (prepareByProjection) reasons.push("projected_prepare_ratio");
  } else {
    state = "stable";
    reasons.push("within_model_input_capacity");
  }

  const minNewTokens = Math.floor(finiteNonNegative(input.minNewTokens, DEFAULT_MIN_NEW_TOKENS));
  if (
    input.lastCompaction !== undefined &&
    input.lastCompaction.newTokensSince < minNewTokens &&
    (state === "compact" || state === "emergency") &&
    projectedTokens <= budget
  ) {
    // A generation guard prevents a successful compaction whose staged result
    // remains above 90% from immediately invoking the model again.
    state = "prepare";
    reasons.push("compaction_generation_guard");
  }

  const target = Math.max(1_024, Math.floor(budget * configuredTargetRatio));
  return {
    state,
    projectedTokens,
    requiredFreeTokens,
    ...(state === "compact" || state === "emergency" || state === "hard_emergency"
      // Clamped to what is actually there: a target above `current` would ask
      // compaction to grow the prompt. The emergency-line floor is applied when
      // `target` is computed, so the clamp cannot re-raise it past the line.
      ? { targetTokens: Math.min(current, target) }
      : {}),
    reasonCodes: [...new Set(reasons)],
    currentRatio,
    inputBudgetTokens: budget,
    basis: "model_input_capacity",
    modelContextWindowTokens,
    outputReserveTokens,
    prepareRatio,
    triggerRatio,
    emergencyRatio,
    targetRatio: configuredTargetRatio,
    triggerTokens: Math.floor(budget * triggerRatio),
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
  prepareRatio: DEFAULT_PREPARE_RATIO,
  triggerRatio: DEFAULT_TRIGGER_RATIO,
  emergencyRatio: DEFAULT_EMERGENCY_RATIO,
  targetRatio: DEFAULT_TARGET_COMPILED_RATIO,
  minNewTokens: DEFAULT_MIN_NEW_TOKENS,
  growthWindow: DEFAULT_GROWTH_WINDOW,
} as const;
