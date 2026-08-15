/**
 * Reasoning policy and prompt caching — PRD §10.4, §10.5, §10.9, §10.11, AC-48.
 *
 * P1-05: the routing decision shapes (`EffortDecision`, `TurnPhase`) are
 * provider-neutral and live in `@cbc/inference-domain`; they are re-exported
 * here for existing call sites.
 */

import type { ModelDescriptor, ReasoningEffort, ReasoningMode } from "./types.ts";
import { supportsEffort, supportsField } from "./types.ts";
import type { EffortDecision, TurnPhase } from "@cbc/inference-domain";

export type { EffortDecision, TurnPhase };

/** §10.4 complexity features. */
export interface ComplexityFeatures {
  /** Distinct concerns the user asked about. */
  requestedConcerns: number;
  expectedFilesTouched: number;
  /** Tracked files in the repository. */
  repositorySize: number;
  failingTestAmbiguity: 0 | 1 | 2;
  crossLanguageImpact: boolean;
  concurrencyInvolved: boolean;
  /** Security, auth, or data-migration risk. */
  highRiskDomain: boolean;
  /** `low` | `normal` | `deep`, from explicit user phrasing. */
  userSpecifiedDepth: "low" | "normal" | "deep";
  previousFailedAttempts: number;
}

export function defaultFeatures(): ComplexityFeatures {
  return {
    requestedConcerns: 1,
    expectedFilesTouched: 1,
    repositorySize: 0,
    failingTestAmbiguity: 0,
    crossLanguageImpact: false,
    concurrencyInvolved: false,
    highRiskDomain: false,
    userSpecifiedDepth: "normal",
    previousFailedAttempts: 0,
  };
}

/** Score in 0..10, per the §10.4 feature list. */
export function complexityScore(features: ComplexityFeatures): number {
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
}

/** §10.4 score-to-effort mapping. */
export function effortForScore(score: number): ReasoningEffort {
  if (score <= 2) return "low";
  if (score <= 5) return "medium";
  if (score <= 7) return "high";
  if (score <= 9) return "xhigh";
  return "max";
}

/**
 * Select an effort for the `auto` profile, clamping to what the model supports.
 * §10.4: `max` only with explicit user confirmation; §AC-48: never downgrade
 * silently.
 */
export function selectEffort(
  features: ComplexityFeatures,
  model: ModelDescriptor,
  options: { maxConfirmed?: boolean } = {},
): EffortDecision {
  const score = complexityScore(features);
  const desired = effortForScore(score);
  const reason = describeReason(features, score);

  if (desired === "max" && options.maxConfirmed !== true) {
    const bounded = clampEffortToModel(model, "xhigh");
    return {
      effort: bounded.effort,
      score,
      clamped: {
        from: "max",
        reason:
          bounded.clamped === undefined
            ? "max effort requires explicit user confirmation"
            : `max effort requires explicit user confirmation; ${bounded.clamped.reason}`,
      },
      reason,
      requiresConfirmation: true,
    };
  }

  if (!supportsEffort(model, desired)) {
    const fallback = clampEffortToModel(model, desired);
    return {
      effort: fallback.effort,
      score,
      ...(fallback.clamped !== undefined ? { clamped: fallback.clamped } : {}),
      reason,
      requiresConfirmation: false,
    };
  }

  return { effort: desired, score, reason, requiresConfirmation: false };
}

function describeReason(features: ComplexityFeatures, score: number): string {
  const parts: string[] = [];
  if (features.failingTestAmbiguity > 0) parts.push("ambiguous failing test");
  if (features.crossLanguageImpact) parts.push("cross-language impact");
  if (features.concurrencyInvolved) parts.push("concurrency involved");
  if (features.highRiskDomain) parts.push("security or data-migration risk");
  if (features.previousFailedAttempts > 0) {
    parts.push(`${features.previousFailedAttempts} previous failed attempt(s)`);
  }
  if (features.expectedFilesTouched >= 3) parts.push(`${features.expectedFilesTouched} files in scope`);
  if (features.userSpecifiedDepth === "deep") parts.push("user asked for depth");
  if (features.userSpecifiedDepth === "low") parts.push("user asked for speed");
  if (parts.length === 0) parts.push(`complexity score ${score}`);
  return parts.join(", ");
}

/** §10.4: the timeline line shown when the effort changes. */
export function effortChangeLine(
  from: ReasoningEffort,
  to: ReasoningEffort,
  reason: string,
): string {
  return `Reasoning adjusted: ${from} → ${to} · ${reason}`;
}

/** §10.5 pro-mode gate. */
export interface ProModeRequest {
  readonly userRequested: boolean;
  readonly autoReviewHighSeverity: boolean;
  readonly configAllows: boolean;
  readonly evalJustified: boolean;
}

export interface ProModeDecision {
  readonly mode: ReasoningMode;
  readonly reason: string;
  /** §10.5: pro mode must display its expected latency and cost impact. */
  readonly showCostWarning: boolean;
}

export function selectReasoningMode(
  request: ProModeRequest,
  model: ModelDescriptor,
): ProModeDecision {
  if (!supportsField(model, "proMode")) {
    return {
      mode: "standard",
      reason: `${model.id} does not offer pro reasoning`,
      showCostWarning: false,
    };
  }
  if (request.userRequested) {
    return { mode: "pro", reason: "explicitly requested by the user", showCostWarning: true };
  }
  if (request.autoReviewHighSeverity && request.configAllows) {
    return {
      mode: "pro",
      reason: "Auto Review selected a high-severity review profile",
      showCostWarning: true,
    };
  }
  if (request.evalJustified && request.configAllows) {
    return { mode: "pro", reason: "task class where evaluation showed a benefit", showCostWarning: true };
  }
  // §10.5: never auto-enable pro mode for long stretches.
  return { mode: "standard", reason: "standard reasoning is sufficient", showCostWarning: false };
}

/**
 * @deprecated Presentation code must use `presentationBudget()` (characters),
 * never a token cap. This compatibility helper now returns only the configured
 * model ceiling so no caller can accidentally reintroduce a phase-based 512 or
 * 12K provider limit.
 */
export function outputBudget(
  _phase: TurnPhase,
  model: ModelDescriptor,
  configuredMax: number,
): number {
  return Math.min(configuredMax, model.maxOutputTokens ?? configuredMax);
}

/** Provider-side generation budget; independent from any TUI disclosure rule. */
export interface ProviderGenerationBudget {
  /** The exact value safe to send as `max_output_tokens`. */
  readonly maxOutputTokens: number;
  /** The model/configuration ceiling before the current context is considered. */
  readonly configuredCeiling: number;
  /** Remaining response capacity after prompt tokens and the safety reserve. */
  readonly remainingContextTokens?: number;
}

export interface ProviderGenerationBudgetInput {
  readonly model: ModelDescriptor;
  readonly configuredMaxOutputTokens: number;
  /** Exact prompt size for this request, when it is known. */
  readonly inputTokens?: number;
  /** Capacity intentionally kept outside the prompt/output pair. */
  readonly safetyReserveTokens?: number;
}

/**
 * Resolve the provider's generation budget once per concrete request.
 *
 * The caller may use a tiny presentation preview, but that must never lower the
 * model generation allowance. Configuration values above 12K are retained up to
 * the model and remaining-context ceilings.
 */
export function resolveProviderGenerationBudget(
  input: ProviderGenerationBudgetInput,
): ProviderGenerationBudget {
  const configured = finitePositiveInteger(
    input.configuredMaxOutputTokens,
    input.model.maxOutputTokens ?? 32_000,
  );
  const modelCeiling = finitePositiveInteger(input.model.maxOutputTokens, configured);
  const configuredCeiling = Math.min(configured, modelCeiling);
  const contextWindow = finitePositiveInteger(input.model.contextWindow, 0);
  if (contextWindow === 0) {
    return { maxOutputTokens: configuredCeiling, configuredCeiling };
  }

  const inputTokens = Math.max(0, Math.floor(input.inputTokens ?? 0));
  const safetyReserveTokens = Math.max(0, Math.floor(input.safetyReserveTokens ?? 0));
  const remainingContextTokens = Math.max(0, contextWindow - inputTokens - safetyReserveTokens);
  return {
    // A request with no remaining output capacity is invalid upstream, but keep
    // this function total so callers surface the explicit provider error rather
    // than accidentally reintroducing a hidden 512-token fallback.
    maxOutputTokens: Math.max(1, Math.min(configuredCeiling, remainingContextTokens)),
    configuredCeiling,
    remainingContextTokens,
  };
}

/** UI-only limits; none of these values are eligible for a provider request. */
export interface PresentationBudget {
  readonly maxProgressChars: number;
  readonly previewChars: number;
}

export function presentationBudget(): PresentationBudget {
  return { maxProgressChars: 512, previewChars: 140 };
}

function finitePositiveInteger(value: number | undefined, fallback: number): number {
  const normalized =
    value !== undefined && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : Math.max(1, Math.floor(fallback));
  return Math.max(1, normalized);
}

/** §10.9 cache key components. Never contains user text, secrets, or timestamps. */
export interface CacheKeyParts {
  readonly workspaceHash: string;
  readonly policyHash: string;
  readonly toolsetHash: string;
  readonly skillMetaHash: string;
  /** Stable shard so traffic for one key does not concentrate. */
  readonly stableShard: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  return [
    "capy",
    "v1",
    parts.workspaceHash,
    parts.policyHash,
    parts.toolsetHash,
    parts.skillMetaHash,
    parts.stableShard,
  ].join(":");
}

/** §10.9: no explicit cache write when the stable prefix is under 1,024 tokens. */
export const CACHE_MIN_PREFIX_TOKENS = 1_024;
export const CACHE_MAX_WRITES_PER_REQUEST = 4;
export const CACHE_DEFAULT_TTL = "30m";

export interface CacheDecision {
  readonly enabled: boolean;
  readonly reason: string;
  readonly breakpointCount: number;
  /** True when the model lacks explicit breakpoints and we fall back safely. */
  readonly downgradedToImplicit: boolean;
}

export function decideCaching(
  stablePrefixTokens: number,
  candidateBreakpoints: number,
  model: ModelDescriptor,
  options: { prefixLikelyReused: boolean },
): CacheDecision {
  if (!supportsField(model, "cacheBreakpoints")) {
    return {
      enabled: false,
      reason: `${model.id} does not support explicit cache breakpoints; using implicit caching`,
      breakpointCount: 0,
      downgradedToImplicit: true,
    };
  }
  if (stablePrefixTokens < CACHE_MIN_PREFIX_TOKENS) {
    return {
      enabled: false,
      reason: `stable prefix of ${stablePrefixTokens} tokens is below the ${CACHE_MIN_PREFIX_TOKENS} token threshold`,
      breakpointCount: 0,
      downgradedToImplicit: false,
    };
  }
  if (!options.prefixLikelyReused) {
    return {
      enabled: false,
      reason: "stable prefix is unlikely to be reused",
      breakpointCount: 0,
      downgradedToImplicit: false,
    };
  }
  return {
    enabled: true,
    reason: "stable prefix is large enough and likely to be reused",
    breakpointCount: Math.min(candidateBreakpoints, CACHE_MAX_WRITES_PER_REQUEST),
    downgradedToImplicit: false,
  };
}

/**
 * §10.8 reasoning continuity: the root keeps reasoning across turns while goals
 * are stable; a pivot, a reviewer, or an invalidated hypothesis resets to the
 * current turn.
 */
export function reasoningContextScope(options: {
  isRoot: boolean;
  goalStable: boolean;
  isReviewer: boolean;
  hypothesisInvalidated: boolean;
}): "current_turn" | "all_turns" {
  if (!options.isRoot) return "current_turn";
  if (options.isReviewer) return "current_turn";
  if (!options.goalStable) return "current_turn";
  if (options.hypothesisInvalidated) return "current_turn";
  return "all_turns";
}

/** §10.13 retry classification. */
export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly attempt: number;
  readonly reason: string;
}

/** Maximum number of retries after the initial provider request. */
export const MAX_RETRY_ATTEMPTS = 10;

/** The fallback delay starts small and grows gently for each retry. */
const RETRY_INITIAL_DELAY_MS = 500;
const RETRY_DELAY_INCREMENT_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

export function decideRetry(
  error: { kind: string; retryable: boolean; retryAfterMs?: number },
  attempt: number,
  options: {
    sideEffectsAlreadyApplied: boolean;
    externalSideEffectsAlreadyApplied?: boolean;
  },
): RetryDecision {
  // §10.13 / AC-43: never blind-replay after a non-idempotent tool succeeded.
  // External actions may not be idempotent. Local workspace mutations are
  // guarded by checksums/transactions and their observation is already present
  // in the retry prompt.
  if (options.externalSideEffectsAlreadyApplied === true) {
    return {
      retry: false,
      delayMs: 0,
      attempt,
      reason: "a non-idempotent external action already ran; replaying it is unsafe",
    };
  }
  if (!error.retryable) {
    return { retry: false, delayMs: 0, attempt, reason: `${error.kind} is not retryable` };
  }
  // A rate-limit or server-overload response is an explicit provider rejection,
  // not an ambiguous dropped connection. No tool call from that rejected
  // response ran, so resampling after a local workspace mutation is safe.
  const providerRejectedRequest = error.kind === "rate_limit" || error.kind === "server";
  if (options.sideEffectsAlreadyApplied && !providerRejectedRequest) {
    return {
      retry: false,
      delayMs: 0,
      attempt,
      reason: "a non-idempotent tool already ran and the provider outcome is ambiguous",
    };
  }

  if (attempt >= MAX_RETRY_ATTEMPTS) {
    return {
      retry: false,
      delayMs: 0,
      attempt,
      reason: `retry budget of ${MAX_RETRY_ATTEMPTS} attempts exhausted`,
    };
  }
  if (typeof error.retryAfterMs === "number" && error.retryAfterMs > 0) {
    return {
      retry: true,
      delayMs: Math.min(error.retryAfterMs, 60_000),
      attempt: attempt + 1,
      reason: "provider supplied a retry-after hint",
    };
  }
  // Gentle linear backoff keeps an overloaded provider from being hammered
  // while still making the ten-attempt retry window practical for interactive
  // use. Provider-supplied retry-after values take precedence above.
  const delayMs = Math.min(
    RETRY_INITIAL_DELAY_MS + attempt * RETRY_DELAY_INCREMENT_MS,
    RETRY_MAX_DELAY_MS,
  );
  return {
    retry: true,
    delayMs,
    attempt: attempt + 1,
    reason: `${error.kind} is retryable`,
  };
}

const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "none",
];

/**
 * Keep an explicitly requested effort inside the model's advertised capability
 * range. This is separate from the complexity policy below: a user-selected
 * value must not be replaced with an adaptive value just because the task looks
 * simple, but an unsupported value still needs a visible, deterministic fallback.
 */
export function clampEffortToModel(
  model: ModelDescriptor,
  requested: ReasoningEffort,
): { effort: ReasoningEffort; clamped?: { from: ReasoningEffort; reason: string } } {
  if (supportsEffort(model, requested)) return { effort: requested };

  const start = EFFORT_ORDER.indexOf(requested);
  const fallback =
    EFFORT_ORDER.slice(start < 0 ? EFFORT_ORDER.length - 1 : start).find((effort) =>
      supportsEffort(model, effort),
    ) ?? "none";
  return {
    effort: fallback,
    clamped: {
      from: requested,
      reason: `${model.id} does not support '${requested}' effort`,
    },
  };
}
