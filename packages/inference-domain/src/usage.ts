/**
 * Provider-neutral usage and pricing types — P1-05.
 *
 * Token accounting and the price table shape are the same for any provider;
 * only the concrete price values are OpenAI's, so those stay in the adapter.
 */

/** Token accounting for one response (§10.9). */
export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

/** §23.7 pricing registry shape. Values live in the provider adapter. */
export interface PriceEntry {
  readonly inputPerMillion: number;
  readonly cachedInputPerMillion: number;
  readonly cacheWritePerMillion: number;
  readonly outputPerMillion: number;
}

export const PRICING_REGISTRY_VERSION = "2026-07-31" as const;
