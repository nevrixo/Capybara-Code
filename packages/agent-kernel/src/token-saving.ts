/**
 * Token saving — integrated adaptive saving profile.
 *
 * One user-facing setting (`agent.tokenSaving`) drives context targets,
 * exploration ceilings, local history compaction timing, the internal
 * implementation-minimization ("Ponytail") policy, and response style as a
 * single intensity. Ponytail is deliberately *not* a separate setting: each
 * saving level maps to an internal policy.
 *
 * The resolver is pure and deterministic: identical input always yields the
 * identical plan, so replayed turns reproduce the exact same budgets. It also
 * fails safe: any internal error resolves to `off`, because a broken saving
 * policy must never silently degrade quality.
 */

import { fingerprint } from "./prompt.ts";

export type TokenSavingLevel = "off" | "light" | "balanced" | "strong";

/** Internal implementation-minimization policy; never exposed as a setting. */
export type PonytailPolicy = "off" | "lite" | "full" | "ultra";

export type TokenSavingPhase =
  | "investigate"
  | "edit"
  | "verify"
  | "review"
  | "final";

export type TokenSavingRisk = "low" | "medium" | "high" | "critical";

export type TokenSavingResponseStyle = "normal" | "concise" | "minimal";

export interface TokenSavingProfile {
  readonly targetInputRatio: number;
  readonly explorationRatio: number;
  readonly localCompactionRatio: number;
  readonly ponytail: PonytailPolicy;
  readonly responseStyle: TokenSavingResponseStyle;
}

/** Candidate values for the first paired A/B experiment, not final constants. */
export const TOKEN_SAVING_PROFILES: Readonly<
  Record<TokenSavingLevel, TokenSavingProfile>
> = {
  off: {
    targetInputRatio: 1,
    explorationRatio: 0.3,
    localCompactionRatio: 0.7,
    ponytail: "off",
    responseStyle: "normal",
  },
  light: {
    targetInputRatio: 1,
    explorationRatio: 0.3,
    localCompactionRatio: 0.65,
    ponytail: "lite",
    responseStyle: "concise",
  },
  balanced: {
    targetInputRatio: 0.85,
    explorationRatio: 0.22,
    localCompactionRatio: 0.55,
    ponytail: "full",
    responseStyle: "concise",
  },
  strong: {
    targetInputRatio: 0.7,
    explorationRatio: 0.15,
    localCompactionRatio: 0.45,
    ponytail: "ultra",
    responseStyle: "minimal",
  },
};

export const TOKEN_SAVING_LEVELS: readonly TokenSavingLevel[] = [
  "off",
  "light",
  "balanced",
  "strong",
];

const LEVEL_RANK: Readonly<Record<TokenSavingLevel, number>> = {
  off: 0,
  light: 1,
  balanced: 2,
  strong: 3,
};

/** The strongest effective level a work-risk band allows. */
const RISK_LEVEL_CAP: Readonly<Record<TokenSavingRisk, TokenSavingLevel>> = {
  low: "strong",
  medium: "balanced",
  high: "light",
  critical: "light",
};

export function isTokenSavingLevel(value: unknown): value is TokenSavingLevel {
  return (
    typeof value === "string" &&
    (TOKEN_SAVING_LEVELS as readonly string[]).includes(value)
  );
}

export function tokenSavingLevelRank(level: TokenSavingLevel): number {
  return LEVEL_RANK[level];
}

function minLevel(a: TokenSavingLevel, b: TokenSavingLevel): TokenSavingLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

function stepDown(level: TokenSavingLevel): TokenSavingLevel {
  return TOKEN_SAVING_LEVELS[Math.max(0, LEVEL_RANK[level] - 1)] as TokenSavingLevel;
}

export interface TokenSavingResolveInput {
  readonly requestedLevel: TokenSavingLevel;
  readonly phase: TokenSavingPhase;
  readonly risk: TokenSavingRisk;
  /** Deterministic risk reasons (e.g. from change-risk assessment) to surface. */
  readonly riskReasons?: readonly string[];
  readonly repairCycles: number;
  readonly continuationRecovery: boolean;
  readonly explicitDetailedResponse: boolean;
}

export interface ResolvedTokenSavingPlan {
  readonly requestedLevel: TokenSavingLevel;
  readonly effectiveLevel: TokenSavingLevel;

  readonly targetInputRatio: number;
  readonly explorationRatio: number;
  readonly localCompactionRatio: number;

  readonly ponytail: PonytailPolicy;
  readonly responseStyle: TokenSavingResponseStyle;

  readonly reasons: readonly string[];
}

function offPlan(requestedLevel: TokenSavingLevel): ResolvedTokenSavingPlan {
  const profile = TOKEN_SAVING_PROFILES.off;
  return {
    requestedLevel,
    effectiveLevel: "off",
    targetInputRatio: profile.targetInputRatio,
    explorationRatio: profile.explorationRatio,
    localCompactionRatio: profile.localCompactionRatio,
    ponytail: profile.ponytail,
    responseStyle: profile.responseStyle,
    reasons: [],
  };
}

/**
 * Resolve the effective saving plan for one sample.
 *
 * Relaxation only ever moves the level toward `off`: token saving must never
 * spend quality or safety. Verification and review phases keep exact evidence
 * regardless, and never apply the implementation-minimization directive, since
 * their purpose is not to produce less code.
 */
export function resolveTokenSavingPlan(
  input: TokenSavingResolveInput,
): ResolvedTokenSavingPlan {
  try {
    if (input.requestedLevel === "off") return offPlan("off");

    const reasons: string[] = [];
    // Widen back to the full union: relaxation below can reach `off`.
    let level: TokenSavingLevel = input.requestedLevel;

    const cap = RISK_LEVEL_CAP[input.risk] ?? "strong";
    if (LEVEL_RANK[level] > LEVEL_RANK[cap]) {
      level = cap;
      reasons.push(
        input.riskReasons !== undefined && input.riskReasons.length > 0
          ? input.riskReasons[0]!
          : `work risk '${input.risk}' caps token saving at ${cap}`,
      );
    }

    if (input.continuationRecovery) {
      if (level !== "off") reasons.push("provider continuation recovery");
      level = "off";
    } else if (input.repairCycles >= 3) {
      if (level !== "off") reasons.push("same failure repeated three times");
      level = "off";
    } else if (input.repairCycles === 2) {
      if (LEVEL_RANK[level] > LEVEL_RANK["light"]) {
        reasons.push("repeated failure; recovery sample relaxed to light");
      }
      level = minLevel(level, "light");
    } else if (input.repairCycles === 1) {
      if (level !== "off") reasons.push("first repair cycle; relaxed one step");
      level = stepDown(level);
    }

    if (input.phase === "review" && LEVEL_RANK[level] > LEVEL_RANK["light"]) {
      level = "light";
      reasons.push("review phase applies at most light context saving");
    }

    const profile = TOKEN_SAVING_PROFILES[level];
    let ponytail = profile.ponytail;
    if (input.phase === "verify" || input.phase === "review") {
      ponytail = "off";
    }

    let responseStyle = profile.responseStyle;
    if (input.explicitDetailedResponse && responseStyle !== "normal") {
      responseStyle = "normal";
      reasons.push("explicit detailed response requested");
    }

    return {
      requestedLevel: input.requestedLevel,
      effectiveLevel: level,
      targetInputRatio: profile.targetInputRatio,
      explorationRatio: profile.explorationRatio,
      localCompactionRatio: profile.localCompactionRatio,
      ponytail,
      responseStyle,
      reasons,
    };
  } catch {
    // Fail-safe: a broken policy resolver must behave exactly like the
    // unchanged product, never like an uncontrolled optimizer.
    return offPlan(input.requestedLevel === "off" ? "off" : input.requestedLevel);
  }
}

const PONYTAIL_DIRECTIVE_LINES: Readonly<Record<Exclude<PonytailPolicy, "off">, string>> = {
  lite:
    "Prefer reusing existing code and installed dependencies; do not add unnecessary dependencies or single-use abstractions.",
  full:
    "Prefer reuse, standard/native capabilities, and the smallest complete change.",
  ultra:
    "Before writing new code, prefer deletion, reuse, configuration, or standard capabilities; make the minimal change that satisfies all requirements.",
};

const SAFETY_INVARIANT_LINE =
  "Do not weaken validation, security, error handling, verification, or requested behavior.";

/**
 * The short host directive carrying the saving policy to the model.
 *
 * Deliberately short and dynamic: it travels in the variable suffix so the
 * stable prefix cache is not broken by a level change. Returns `undefined`
 * for an effective `off` plan, keeping default sessions byte-identical.
 */
export function tokenSavingDirectiveText(
  plan: ResolvedTokenSavingPlan,
): string | undefined {
  if (plan.effectiveLevel === "off") return undefined;
  const lines = [
    "Host token-saving directive; supersedes earlier token-saving directives.",
    `Effective level: ${plan.effectiveLevel.toUpperCase()}.`,
  ];
  if (plan.ponytail !== "off") {
    lines.push(PONYTAIL_DIRECTIVE_LINES[plan.ponytail]);
  }
  lines.push(SAFETY_INVARIANT_LINE);
  if (plan.responseStyle === "concise") {
    lines.push("Keep progress and final reporting concise without omitting evidence.");
  } else if (plan.responseStyle === "minimal") {
    lines.push(
      "Keep progress and final reporting minimal: changed files, verification results, and remaining risks; provide details only on request.",
    );
  }
  return lines.join("\n");
}

/** The one-time directive that releases an earlier saving directive. */
export const TOKEN_SAVING_RELEASE_DIRECTIVE = [
  "Host token-saving directive: OFF.",
  "Ignore earlier token-saving directives and use normal response detail.",
].join("\n");

export function tokenSavingDirectiveDigest(text: string): string {
  return fingerprint(text);
}

export type TokenSavingDirectiveMode = "full_replay" | "continuation";

/**
 * Stateful controller owned by the running session.
 *
 * It keeps the requested level and decides which directive text the next
 * provider request needs, deduplicating directives in continuation
 * transports: with `previous_response` linkage the provider already holds
 * earlier directives, so an unchanged digest is not sent again. Full replay
 * transports resend the current directive with every request and need no
 * release directive, because no provider state outlives a request.
 *
 * Peeking never mutates: delivery is confirmed explicitly once a compiled
 * prompt actually carries the directive, so a child prompt that drops the
 * field cannot consume the root's pending directive.
 */
export class TokenSavingController {
  #requestedLevel: TokenSavingLevel;
  #lastDirectiveDigest: string | undefined;

  constructor(initial: TokenSavingLevel = "off") {
    this.#requestedLevel = initial;
  }

  get requestedLevel(): TokenSavingLevel {
    return this.#requestedLevel;
  }

  /** Change the requested level; returns the transition when it changed. */
  setRequestedLevel(
    level: TokenSavingLevel,
  ): { from: TokenSavingLevel; to: TokenSavingLevel } | undefined {
    if (!isTokenSavingLevel(level)) return undefined;
    if (level === this.#requestedLevel) return undefined;
    const from = this.#requestedLevel;
    this.#requestedLevel = level;
    return { from, to: level };
  }

  /** Whether an earlier directive is still live in provider state. */
  get hasActiveDirective(): boolean {
    return this.#lastDirectiveDigest !== undefined;
  }

  /** The directive the next provider request should carry, if any. */
  peekDirective(
    plan: ResolvedTokenSavingPlan,
    mode: TokenSavingDirectiveMode,
  ): string | undefined {
    const text = tokenSavingDirectiveText(plan);
    if (mode === "full_replay") return text;
    if (text === undefined) {
      return this.#lastDirectiveDigest !== undefined
        ? TOKEN_SAVING_RELEASE_DIRECTIVE
        : undefined;
    }
    return tokenSavingDirectiveDigest(text) === this.#lastDirectiveDigest
      ? undefined
      : text;
  }

  /**
   * Record that a directive text was actually included in a compiled prompt.
   * The release directive leaves no active policy behind.
   */
  noteDirectiveIncluded(text: string): void {
    this.#lastDirectiveDigest = text === TOKEN_SAVING_RELEASE_DIRECTIVE
      ? undefined
      : tokenSavingDirectiveDigest(text);
  }

  /** Provider linkage was dropped; the next request must restate the policy. */
  resetDirectiveTracking(): void {
    this.#lastDirectiveDigest = undefined;
  }
}
