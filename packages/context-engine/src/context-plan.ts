/** Evidence-aware context-band planning, independent of provider SDK types. */

export const CONTEXT_PLAN_BANDS = [64_000, 192_000, 272_000, 512_000, 1_000_000] as const;
export type ContextPlanBand = (typeof CONTEXT_PLAN_BANDS)[number];

export interface ContextPlanInput {
  readonly requestedTokens: number;
  readonly modelContextLimit: number;
  readonly reserveOutputTokens: number;
  readonly evidenceCount?: number;
  readonly premiumThreshold?: number;
  readonly premiumAllowed?: boolean;
}

export interface ContextPlan {
  readonly band: ContextPlanBand;
  readonly requestedTokens: number;
  readonly reserveOutputTokens: number;
  readonly usableTokens: number;
  readonly premium: boolean;
  readonly allowed: boolean;
  readonly evidenceCount: number;
  readonly reason: string;
}

export function createContextPlan(input: ContextPlanInput): ContextPlan {
  const limit = Math.max(1, Math.floor(input.modelContextLimit));
  const requested = Math.max(1, Math.floor(input.requestedTokens));
  const reserve = Math.max(0, Math.floor(input.reserveOutputTokens));
  const usable = Math.max(1, limit - reserve);
  const eligibleBands = CONTEXT_PLAN_BANDS.filter((candidate) => candidate <= usable);
  const highestBand = eligibleBands.at(-1);
  const selectedBand = CONTEXT_PLAN_BANDS.find((candidate) => candidate >= requested && candidate <= usable) ?? highestBand ?? 64_000;
  const band = selectedBand as ContextPlanBand;
  const premiumThreshold = input.premiumThreshold ?? 272_000;
  const premium = band > premiumThreshold;
  const bandTooSmall = band < requested || band > usable;
  const allowed = requested <= usable && !bandTooSmall && (!premium || input.premiumAllowed === true);
  return {
    band,
    requestedTokens: requested,
    reserveOutputTokens: reserve,
    usableTokens: usable,
    premium,
    allowed,
    evidenceCount: Math.max(0, Math.floor(input.evidenceCount ?? 0)),
    reason: !allowed ? requested > usable ? "requested context plus reserve exceeds the model ceiling" : bandTooSmall ? "requested context does not fit an available band below the model ceiling" : "premium context requires an explicit utility decision" : premium ? "premium context admitted by policy" : "standard context band",
  };
}
