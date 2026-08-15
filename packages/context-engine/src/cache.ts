/** Version-keyed memoization for stable prompt fragments owned by context-engine. */

import { createHash } from "node:crypto";

import { estimateTokens } from "@cbc/session-domain";

/** Bump when the underlying estimator or normalization changes. */
export const TOKEN_ESTIMATE_CACHE_VERSION = "token-estimate-v1";
export const TOKEN_ESTIMATE_CACHE_MAX_ENTRIES = 512;

const TOKEN_ESTIMATES = new Map<string, number>();

/**
 * Estimate a string once per process and retain only its digest and result. Keeping
 * the source text itself would pin large repository excerpts in memory after their
 * evidence was evicted, so the bounded cache is digest-keyed instead.
 */
export function cachedEstimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const key = `${TOKEN_ESTIMATE_CACHE_VERSION}:${text.length}:${digest}`;
  const cached = TOKEN_ESTIMATES.get(key);
  if (cached !== undefined) {
    // Refresh insertion order for bounded LRU behaviour.
    TOKEN_ESTIMATES.delete(key);
    TOKEN_ESTIMATES.set(key, cached);
    return cached;
  }
  const estimate = estimateTokens(text);
  TOKEN_ESTIMATES.set(key, estimate);
  while (TOKEN_ESTIMATES.size > TOKEN_ESTIMATE_CACHE_MAX_ENTRIES) {
    const oldest = TOKEN_ESTIMATES.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    TOKEN_ESTIMATES.delete(oldest);
  }
  return estimate;
}

export function tokenEstimateCacheSize(): number {
  return TOKEN_ESTIMATES.size;
}
