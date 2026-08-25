/** Context-accounting types and deterministic reconciliation helpers. */

export type ContextUsageCategory =
  | "system_prompt"
  | "system_tools"
  | "tool_io"
  | "messages";

export type ContextUsageSource = "estimated" | "provider_reconciled" | "resumed";

export type ContextUsageCategories = Readonly<Record<ContextUsageCategory, number>>;

export interface ContextUsageSnapshot {
  readonly requestId?: string;
  readonly turnId?: string;
  readonly packId: string;
  readonly source: ContextUsageSource;
  readonly modelId: string;
  readonly budgetTokens: number;
  readonly modelWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly usedTokens: number;
  readonly freeTokens: number;
  readonly overageTokens: number;
  readonly cachedInputTokens: number;
  readonly categories: ContextUsageCategories;
  readonly capturedAt: string;
}

export const CONTEXT_USAGE_CATEGORY_ORDER: readonly ContextUsageCategory[] = [
  "system_prompt",
  "system_tools",
  "tool_io",
  "messages",
] as const;

const EMPTY_CATEGORIES: ContextUsageCategories = {
  system_prompt: 0,
  system_tools: 0,
  tool_io: 0,
  messages: 0,
};

export function emptyContextUsageCategories(): ContextUsageCategories {
  return { ...EMPTY_CATEGORIES };
}

export function sumContextUsageCategories(categories: ContextUsageCategories): number {
  return CONTEXT_USAGE_CATEGORY_ORDER.reduce(
    (sum, category) => sum + Math.max(0, Math.floor(categories[category] ?? 0)),
    0,
  );
}

/**
 * Reconcile a category estimate to the provider's exact input total. Remainders
 * are distributed in stable category order so replay and screenshots are stable.
 */
export function reconcileContextUsageCategories(
  categories: ContextUsageCategories,
  targetTokens: number,
): ContextUsageCategories {
  const target = Math.max(0, Math.floor(targetTokens));
  const values = CONTEXT_USAGE_CATEGORY_ORDER.map((id, order) => ({
    id,
    order,
    value: Math.max(0, Math.floor(categories[id] ?? 0)),
  }));
  const estimate = values.reduce((sum, entry) => sum + entry.value, 0);
  if (target === 0) return emptyContextUsageCategories();
  if (estimate === 0) {
    return { ...EMPTY_CATEGORIES, system_tools: target };
  }

  const exact = values.map((entry) => {
    const scaled = (entry.value / estimate) * target;
    const floor = Math.floor(scaled);
    return { ...entry, floor, remainder: scaled - floor };
  });
  let remaining = target - exact.reduce((sum, entry) => sum + entry.floor, 0);
  const ranked = [...exact].sort(
    (left, right) => right.remainder - left.remainder || left.order - right.order,
  );
  for (let index = 0; index < remaining; index += 1) {
    const entry = ranked[index % ranked.length];
    if (entry !== undefined) entry.floor += 1;
  }
  return Object.fromEntries(exact.map((entry) => [entry.id, entry.floor])) as ContextUsageCategories;
}

export function makeContextUsageSnapshot(input: {
  readonly packId: string;
  readonly source?: ContextUsageSource;
  readonly requestId?: string;
  readonly turnId?: string;
  readonly modelId: string;
  readonly budgetTokens: number;
  readonly modelWindowTokens?: number;
  readonly outputReserveTokens?: number;
  readonly usedTokens: number;
  readonly cachedInputTokens?: number;
  readonly categories: ContextUsageCategories;
  readonly capturedAt?: string;
}): ContextUsageSnapshot {
  const budgetTokens = Math.max(0, Math.floor(input.budgetTokens));
  const usedTokens = Math.max(0, Math.floor(input.usedTokens));
  const categories = reconcileContextUsageCategories(input.categories, usedTokens);
  const freeTokens = Math.max(0, budgetTokens - usedTokens);
  const overageTokens = Math.max(0, usedTokens - budgetTokens);
  return {
    packId: input.packId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    source: input.source ?? "estimated",
    modelId: input.modelId,
    budgetTokens,
    modelWindowTokens: Math.max(0, Math.floor(input.modelWindowTokens ?? budgetTokens)),
    outputReserveTokens: Math.max(0, Math.floor(input.outputReserveTokens ?? 0)),
    usedTokens,
    freeTokens,
    overageTokens,
    cachedInputTokens: Math.max(0, Math.floor(input.cachedInputTokens ?? 0)),
    categories,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

export function reconcileContextUsageSnapshot(
  snapshot: ContextUsageSnapshot,
  providerInputTokens: number,
  capturedAt = snapshot.capturedAt,
): ContextUsageSnapshot {
  return makeContextUsageSnapshot({
    ...snapshot,
    source: "provider_reconciled",
    usedTokens: providerInputTokens,
    categories: snapshot.categories,
    capturedAt,
  });
}

export function contextUsageInvariant(snapshot: ContextUsageSnapshot): boolean {
  return sumContextUsageCategories(snapshot.categories) === snapshot.usedTokens &&
    snapshot.usedTokens + snapshot.freeTokens - snapshot.overageTokens === snapshot.budgetTokens &&
    snapshot.freeTokens >= 0 &&
    snapshot.overageTokens >= 0;
}

/** Largest-remainder allocation for the 100-cell context visualization. */
export function allocateContextCells(
  categories: ContextUsageCategories,
  freeTokens: number,
  cellCount = 100,
): Array<{ readonly id: ContextUsageCategory | "free"; readonly cells: number }> {
  const entries = [
    ...CONTEXT_USAGE_CATEGORY_ORDER.map((id) => ({ id, tokens: Math.max(0, categories[id] ?? 0) })),
    { id: "free" as const, tokens: Math.max(0, freeTokens) },
  ];
  const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  if (total === 0) {
    return entries.map((entry) => ({ id: entry.id, cells: entry.id === "free" ? cellCount : 0 }));
  }
  const raw = entries.map((entry, order) => {
    const exact = (entry.tokens / total) * cellCount;
    const floor = Math.floor(exact);
    return { ...entry, order, floor, remainder: exact - floor };
  });
  let remaining = cellCount - raw.reduce((sum, entry) => sum + entry.floor, 0);
  const ranked = [...raw].sort(
    (left, right) => right.remainder - left.remainder || left.order - right.order,
  );
  for (let index = 0; index < remaining; index += 1) {
    const entry = ranked[index % ranked.length];
    if (entry !== undefined) entry.floor += 1;
  }
  return raw.map((entry) => ({ id: entry.id, cells: entry.floor }));
}

