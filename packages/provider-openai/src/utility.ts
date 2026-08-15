/** GPT‑5.6-native routing, intent budgets, context bands, and cache economics. */

import {
  BUNDLED_CAPABILITY_MANIFEST,
  bundledCapability,
  capabilityAllowsReasoning,
  capabilitySupports,
  type ModelCapabilitySnapshot,
} from "./capabilities.ts";
import {
  buildCacheKey,
  clampEffortToModel,
  defaultFeatures,
  resolveProviderGenerationBudget,
  selectEffort,
  selectReasoningMode,
  type ComplexityFeatures,
  type CacheKeyParts,
  type ProModeRequest,
} from "./policy.ts";
import {
  findModel,
  PRICING,
  type ModelDescriptor,
  type PriceEntry,
  type ReasoningEffort,
  type ReasoningMode,
} from "./types.ts";

export type SampleIntent =
  | "route"
  | "inspect"
  | "tool_select"
  | "program"
  | "synthesize"
  | "final"
  | "review";

export type ContextBand = 64_000 | 192_000 | 272_000 | 512_000 | 1_000_000;
export const CONTEXT_BANDS: readonly ContextBand[] = [64_000, 192_000, 272_000, 512_000, 1_000_000];
export const PREMIUM_CONTEXT_THRESHOLD = 272_000;
/** Minimum shared reasoning + visible-output capacity recommended for deep work. */
export const MIN_REASONING_GENERATION_TOKENS = 25_000;

export interface ContextBandDecision {
  readonly requestedTokens: number;
  readonly band: ContextBand;
  readonly premium: boolean;
  readonly allowed: boolean;
  readonly reason: string;
}

export function selectContextBand(
  requestedTokens: number,
  options: {
    readonly capability?: ModelCapabilitySnapshot;
    readonly premiumPolicy?: "utility-gated" | "allow" | "deny";
    readonly estimatedQualityGain?: number;
    readonly estimatedCostUsd?: number;
    readonly maxCostUsd?: number;
    readonly reserveOutputTokens?: number;
  } = {},
): ContextBandDecision {
  const requested = Math.max(1, Math.floor(Number.isFinite(requestedTokens) ? requestedTokens : 1));
  const modelMax = Math.max(1, Math.floor(options.capability?.contextWindow ?? 1_000_000));
  const reserve = Math.max(0, Math.floor(options.reserveOutputTokens ?? 0));
  const usable = Math.max(1, modelMax - reserve);
  const eligibleBands = CONTEXT_BANDS.filter((candidate) => candidate <= usable);
  const highestBand = eligibleBands.at(-1);
  const selectedBand = CONTEXT_BANDS.find((candidate) => candidate >= requested && candidate <= usable) ?? highestBand ?? 64_000;
  const band = selectedBand as ContextBand;
  const premium = band > PREMIUM_CONTEXT_THRESHOLD;
  const overCeiling = requested > usable;
  const bandTooSmall = band < requested || band > usable;
  if (overCeiling || bandTooSmall) {
    return {
      requestedTokens: requested,
      band,
      premium,
      allowed: false,
      reason: overCeiling
        ? `requested context (${requested}) plus reserve (${reserve}) exceeds model ceiling (${modelMax})`
        : `requested context (${requested}) does not fit an available band below the model ceiling (${usable})`,
    };
  }
  if (!premium) {
    return { requestedTokens: requested, band, premium: false, allowed: true, reason: "within the standard context band" };
  }
  const policy = options.premiumPolicy ?? "utility-gated";
  if (policy === "deny") {
    return { requestedTokens: requested, band, premium: true, allowed: false, reason: "premium context is disabled by policy" };
  }
  if (policy === "allow") {
    return { requestedTokens: requested, band, premium: true, allowed: true, reason: "premium context explicitly allowed" };
  }
  const quality = options.estimatedQualityGain ?? 0;
  const cost = options.estimatedCostUsd ?? 0;
  const ceiling = options.maxCostUsd ?? Number.POSITIVE_INFINITY;
  const allowed = quality > 0 && cost <= ceiling;
  return {
    requestedTokens: requested,
    band,
    premium: true,
    allowed,
    reason: allowed
      ? `premium band justified by estimated quality gain ${quality.toFixed(3)} within cost ceiling`
      : "premium band requires measured utility and a cost ceiling",
  };
}

export type CachePlanMode = "write" | "read-only" | "implicit" | "off";

export interface CachePlannerInput {
  readonly keyParts?: CacheKeyParts;
  readonly stablePrefixTokens: number;
  readonly expectedReuseCount: number;
  readonly invalidationProbability: number;
  readonly candidateBreakpoints?: number;
  readonly maxWritesPerTurn?: number;
  readonly model: string | ModelCapabilitySnapshot;
  readonly price?: PriceEntry;
  readonly latencySavingMs?: number;
  readonly minReuseProbability?: number;
  readonly mode?: "roi" | "always" | "implicit" | "off";
}

export interface CachePlan {
  readonly mode: CachePlanMode;
  readonly key?: string;
  readonly ttl: "30m";
  readonly breakpoints: readonly number[];
  readonly stablePrefixTokens: number;
  readonly expectedReuseProbability: number;
  readonly expectedReadTokens: number;
  readonly expectedWriteTokens: number;
  readonly expectedNetSavingsUsd: number;
  readonly expectedLatencySavingMs: number;
  readonly reason: string;
}

/**
 * Cache economics are calculated before request assembly.  A cache hit alone is
 * not a saving: the explicit write charge and invalidation risk are included.
 */
export class CachePlanner {
  readonly #maxWrites: number;
  readonly #minimumReuse: number;

  constructor(options: { readonly maxWritesPerTurn?: number; readonly minimumReuseProbability?: number } = {}) {
    this.#maxWrites = Math.max(0, Math.floor(options.maxWritesPerTurn ?? 2));
    this.#minimumReuse = Math.min(1, Math.max(0, options.minimumReuseProbability ?? 0.55));
  }

  plan(input: CachePlannerInput): CachePlan {
    const prefix = Math.max(0, Math.floor(input.stablePrefixTokens));
    const reuse = Math.min(1, Math.max(0, input.expectedReuseCount * (1 - clamp01(input.invalidationProbability))));
    const capability = typeof input.model === "string" ? bundledCapability(input.model) : input.model;
    const price = input.price ?? (typeof input.model === "string" ? PRICING[findModel(input.model)?.id ?? input.model] : undefined);
    const key = input.keyParts === undefined ? undefined : buildCacheKey(input.keyParts);
    const base = {
      ttl: "30m" as const,
      breakpoints: [] as readonly number[],
      stablePrefixTokens: prefix,
      expectedReuseProbability: reuse,
      expectedReadTokens: Math.round(prefix * reuse),
      expectedWriteTokens: 0,
      expectedNetSavingsUsd: 0,
      expectedLatencySavingMs: 0,
    };

    const implicit = capability === undefined || !capability.supportsPromptCacheBreakpoints;
    if (input.mode === "off" || prefix < 1_024) {
      return { ...base, mode: "off", ...(key !== undefined ? { key } : {}), reason: prefix < 1_024 ? "stable prefix is below the explicit cache threshold" : "cache disabled by policy" };
    }
    if (input.mode === "implicit" || implicit) {
      return { ...base, mode: "implicit", ...(key !== undefined ? { key } : {}), reason: "provider capability does not permit explicit breakpoints; implicit caching is the safe fallback" };
    }
    const candidate = Math.max(0, Math.min(input.candidateBreakpoints ?? 1, this.#maxWrites, input.maxWritesPerTurn ?? this.#maxWrites));
    const inputPrice = price?.inputPerMillion ?? 0;
    const cachedPrice = price?.cachedInputPerMillion ?? inputPrice;
    const writePrice = price?.cacheWritePerMillion ?? inputPrice;
    const writeCost = (prefix * candidate * writePrice) / 1_000_000;
    const uncachedCost = (prefix * Math.max(0, reuse)) / 1_000_000 * inputPrice;
    const cachedCost = (prefix * Math.max(0, reuse)) / 1_000_000 * cachedPrice;
    const savings = uncachedCost - cachedCost - writeCost;
    const likely = reuse >= (input.minReuseProbability ?? this.#minimumReuse);
    const mode: CachePlanMode = input.mode === "always" || (likely && savings > 0) ? "write" : likely ? "read-only" : "off";
    const breakpoints = mode === "write" && candidate > 0 ? Array.from({ length: candidate }, (_, index) => index) : [];
    return {
      ...base,
      mode,
      ...(key !== undefined ? { key } : {}),
      breakpoints,
      expectedWriteTokens: mode === "write" ? prefix * candidate : 0,
      expectedNetSavingsUsd: mode === "write" ? savings : mode === "read-only" ? uncachedCost - cachedCost : 0,
      expectedLatencySavingMs: mode === "off" ? 0 : Math.max(0, input.latencySavingMs ?? 0) * reuse,
      reason: mode === "write"
        ? "cache write has positive expected net utility after read/write pricing"
        : mode === "read-only"
          ? "reuse is likely but a new write is not economically justified"
          : "reuse probability or expected savings is below the ROI gate",
    };
  }
}

export type InferenceLane = "direct" | "program" | "hosted_scout" | "local_agent";

/** Provider-neutral routing plan emitted before request assembly. */
export interface InferencePlan {
  readonly modelTier: "sol" | "terra" | "luna";
  readonly effort: ReasoningEffort;
  readonly mode: ReasoningMode;
  readonly reasoningContext: "current_turn" | "all_turns";
  readonly contextBand: ContextBand;
  readonly lane: InferenceLane;
  readonly maxAgents: number;
  readonly maxParallelTools: number;
  readonly maxCostUsd: number;
  readonly rationaleCodes: readonly string[];
}

export interface InferencePolicyInput {
  readonly intent: SampleIntent;
  readonly explicitModel?: string;
  readonly explicitEffort?: ReasoningEffort;
  readonly explicitMode?: ReasoningMode;
  readonly complexity?: ComplexityFeatures;
  readonly contextTokens: number;
  readonly premiumPolicy?: "utility-gated" | "allow" | "deny";
  readonly maxCostUsd?: number;
  readonly reserveOutputTokens?: number;
  readonly capability?: ModelCapabilitySnapshot;
  readonly lane?: InferenceLane;
  readonly reasoningContext?: "current_turn" | "all_turns";
  readonly autoReviewHighSeverity?: boolean;
  readonly evalJustified?: boolean;
  /** Configured provider generation ceiling, distinct from any display preview. */
  readonly configuredMaxOutputTokens?: number;
  /** True when the request asks the provider to emit a reasoning summary. */
  readonly needsReasoningSummary?: boolean;
  /** Preserve a user-selected maximum-quality effort during automatic routing. */
  readonly qualityFirst?: boolean;
}

export interface InferencePolicyDecision extends InferencePlan {
  readonly model: string;
  readonly capability: ModelCapabilitySnapshot;
  readonly intent: SampleIntent;
  readonly effort: ReasoningEffort;
  readonly mode: ReasoningMode;
  readonly context: ContextBandDecision;
  readonly outputTokens: number;
  readonly reasonCode: string;
  readonly estimatedCostCeilingUsd?: number;
  readonly warnings: readonly string[];
}

/** Single policy injection point for AgentSession/kernel assembly. */
export interface InferencePolicyPort {
  decide(input: InferencePolicyInput): InferencePolicyDecision;
}

export class InferenceUtilityController implements InferencePolicyPort {
  readonly #defaultModel: string;
  readonly #cheapModel: string;
  readonly #escalationModel: string;
  readonly #maxCost: number;
  readonly #strategy: "utility" | "latency" | "cost";
  readonly #targetLatencyMs: number;
  readonly #capabilityResolver: (modelId: string) => ModelCapabilitySnapshot | undefined;

  constructor(options: {
    readonly defaultModel?: string;
    readonly cheapModel?: string;
    readonly escalationModel?: string;
    readonly maxCostUsd?: number;
    readonly strategy?: "utility" | "latency" | "cost";
    readonly targetLatencyMs?: number;
    /** Account/backend-specific capability lookup, when one is active. */
    readonly capabilityResolver?: (modelId: string) => ModelCapabilitySnapshot | undefined;
  } = {}) {
    this.#defaultModel = options.defaultModel ?? "gpt-5.6-terra";
    this.#cheapModel = options.cheapModel ?? "gpt-5.6-luna";
    this.#escalationModel = options.escalationModel ?? "gpt-5.6-sol";
    this.#maxCost = options.maxCostUsd ?? 2;
    this.#strategy = options.strategy ?? "utility";
    this.#targetLatencyMs = Math.max(1_000, options.targetLatencyMs ?? 90_000);
    this.#capabilityResolver = options.capabilityResolver ?? bundledCapability;
  }

  decide(input: InferencePolicyInput): InferencePolicyDecision {
    const features = input.complexity ?? defaultFeatures();
    const score = (() => {
      const { complexityScore } = requirePolicy();
      return complexityScore(features);
    })();
    // A maximum-effort or genuinely complex request must take precedence over a
    // cheap first-turn intent. Otherwise an inspect phase can silently undo the
    // user's quality choice before the provider request is assembled.
    const qualityFirst = input.qualityFirst === true || input.explicitEffort === "max";
    const utilityModel = qualityFirst || score >= 7 || input.intent === "review"
      ? this.#escalationModel
      : input.intent === "inspect" || input.intent === "tool_select"
        ? this.#cheapModel
        : this.#defaultModel;
    let policyModel = qualityFirst
      ? this.#escalationModel
      : this.#strategy === "cost"
        ? (input.intent === "review" || score >= 9 ? this.#defaultModel : this.#cheapModel)
        : this.#strategy === "latency"
          ? (input.intent === "review" ? this.#escalationModel : this.#targetLatencyMs <= 60_000 ? this.#cheapModel : utilityModel)
          : utilityModel;

    // Summary capability is a request requirement, not a UI preference that can
    // be silently lost because the first phase happens to be cheap. Explicit
    // model choices remain authoritative; the warning below makes an unsupported
    // summary request visible instead of rewriting the user's choice.
    if (input.explicitModel === undefined && input.needsReasoningSummary === true) {
      const policyCapability = this.#capabilityResolver(policyModel);
      if (policyCapability?.supportsReasoningSummary !== true) {
        policyModel = qualityFirst ? this.#escalationModel : this.#defaultModel;
      }
    }

    const model = input.explicitModel ?? policyModel;
    const capability = input.capability ?? this.#capabilityResolver(model) ?? BUNDLED_CAPABILITY_MANIFEST.snapshots[0]!;
    const legacy = findModel(model) ?? descriptorFromCapability(capability);
    const desiredEffort = input.explicitEffort ?? selectEffort(features, legacy).effort;
    const boundedEffort = clampEffortToModel(legacy, desiredEffort).effort;
    const proRequest: ProModeRequest = {
      userRequested: input.explicitMode === "pro",
      autoReviewHighSeverity: input.autoReviewHighSeverity === true,
      configAllows: true,
      evalJustified: input.evalJustified === true,
    };
    const modeDecision = input.explicitMode === "standard" ? { mode: "standard" as const, reason: "explicit standard mode", showCostWarning: false } : selectReasoningMode(proRequest, legacy);
    const mode = capability.reasoningModes.includes(modeDecision.mode) ? modeDecision.mode : "standard";
    const context = selectContextBand(input.contextTokens, {
      capability,
      ...(input.premiumPolicy !== undefined ? { premiumPolicy: input.premiumPolicy } : {}),
      maxCostUsd: input.maxCostUsd ?? this.#maxCost,
      ...(input.reserveOutputTokens !== undefined ? { reserveOutputTokens: input.reserveOutputTokens } : {}),
      estimatedQualityGain: score >= 7 ? 0.1 : 0,
    });
    const warnings: string[] = [];
    if (!capabilityAllowsReasoning(capability, boundedEffort, mode)) warnings.push("provider capability snapshot does not confirm the requested reasoning combination");
    if (input.needsReasoningSummary === true && capability.supportsReasoningSummary !== true) {
      warnings.push(`${model} does not support reasoning summaries; the request will omit them`);
    }
    if (!context.allowed) warnings.push(context.reason);
    if (modeDecision.showCostWarning) warnings.push("pro reasoning may increase latency and cost");
    const output = resolveProviderGenerationBudget({
      model: legacy,
      configuredMaxOutputTokens: input.configuredMaxOutputTokens ?? capability.maxOutputTokens,
      inputTokens: input.contextTokens,
      ...(input.reserveOutputTokens !== undefined
        ? { safetyReserveTokens: input.reserveOutputTokens }
        : {}),
    }).maxOutputTokens;
    if (
      (boundedEffort === "high" || boundedEffort === "xhigh" || boundedEffort === "max") &&
      output < MIN_REASONING_GENERATION_TOKENS
    ) {
      warnings.push(
        `effective generation budget (${output}) is below the ${MIN_REASONING_GENERATION_TOKENS}-token deep-reasoning recommendation`,
      );
    }
    const lane: InferenceLane = input.lane ?? (input.intent === "program" ? "program" : input.intent === "review" && capability.native.hostedMultiAgent === "supported" ? "hosted_scout" : "direct");
    const modelTier = capability.tier === "sol" || capability.tier === "terra" || capability.tier === "luna" ? capability.tier : inferTier(model);
    const reasoningContext = input.reasoningContext ?? (input.intent === "review" ? "current_turn" : "all_turns");
    const maxCostUsd = input.maxCostUsd ?? this.#maxCost;
    const reasonCode = `${input.intent}:${score >= 7 ? "deep" : score <= 2 ? "cheap" : "balanced"}`;
    const rationaleCodes = [reasonCode, lane, context.premium ? "premium-context" : "standard-context", ...warnings.map(() => "capability-warning")];
    return {
      model,
      capability,
      intent: input.intent,
      effort: boundedEffort,
      mode,
      context,
      outputTokens: output,
      reasonCode,
      modelTier,
      reasoningContext,
      contextBand: context.band,
      lane,
      maxAgents: lane === "hosted_scout" ? 3 : 0,
      maxParallelTools: lane === "program" ? 6 : 1,
      maxCostUsd,
      rationaleCodes,
      ...(input.maxCostUsd !== undefined ? { estimatedCostCeilingUsd: input.maxCostUsd } : {}),
      warnings,
    };
  }
}

function inferTier(model: string): "sol" | "terra" | "luna" {
  const normalized = model.toLowerCase();
  if (normalized.includes("luna")) return "luna";
  if (normalized.includes("sol") || normalized === "gpt-5.6") return "sol";
  return "terra";
}


function descriptorFromCapability(snapshot: ModelCapabilitySnapshot): ModelDescriptor {
  return {
    id: snapshot.modelId,
    family: snapshot.family,
    aliases: [],
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens,
    reasoningEfforts: [...snapshot.reasoningEfforts],
    reasoningModes: [...snapshot.reasoningModes],
    supportsStreaming: snapshot.supportsStreaming,
    supportsFunctionCalling: snapshot.supportsFunctionCalling,
    supportsReasoningSummary: snapshot.supportsReasoningSummary,
    supportsPromptCacheBreakpoints: snapshot.supportsPromptCacheBreakpoints,
    sourceVersion: snapshot.snapshotVersion,
  };
}

// Avoid a second copy of the complexity scoring implementation while keeping the
// policy module's public API backwards-compatible.
function requirePolicy(): { complexityScore: (features: ComplexityFeatures) => number } {
  return { complexityScore: (features) => {
    let score = 0;
    score += Math.min(2, Math.max(0, features.requestedConcerns - 1));
    score += features.expectedFilesTouched >= 8 ? 2 : features.expectedFilesTouched >= 3 ? 1 : 0;
    score += features.repositorySize >= 20_000 ? 1 : 0;
    score += features.failingTestAmbiguity;
    score += features.crossLanguageImpact ? 1 : 0;
    score += features.concurrencyInvolved ? 1 : 0;
    score += features.highRiskDomain ? 2 : 0;
    score += features.userSpecifiedDepth === "deep" ? 2 : features.userSpecifiedDepth === "low" ? -2 : 0;
    score += Math.min(2, features.previousFailedAttempts);
    return Math.max(0, Math.min(10, score));
  } };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

