import { describe, expect, test } from "bun:test";

import {
  ContextPressureController,
  evaluateContextPressure,
  percentile,
} from "../src/context-pressure.ts";

const base = {
  currentCompiledTokens: 60,
  inputBudgetTokens: 100,
  pendingHistoryDeltaTokens: 0,
  pendingContextPackTokens: 0,
  recentRequestGrowthP95: 2,
  reservedToolExpansionTokens: 4,
  tokenSavingLevel: "off" as const,
};

describe("adaptive context pressure", () => {
  test("uses the projected next request rather than only current usage", () => {
    const decision = evaluateContextPressure({
      ...base,
      pendingContextPackTokens: 44,
    });
    expect(decision.state).toBe("compact");
    expect(decision.projectedTokens).toBe(108);
    expect(decision.reasonCodes).toContain("pending_context_pack");
  });

  test("keeps a low-growth 70 percent request stable", () => {
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 70,
      recentRequestGrowthP95: 1,
      reservedToolExpansionTokens: 2,
    });
    expect(decision.state).toBe("stable");
  });

  test("treats the emergency ratio as a safety line", () => {
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 91,
    });
    expect(decision.state).toBe("emergency");
    expect(decision.reasonCodes).toContain("current_emergency_ratio");
  });

  test("strong saving changes the target, not the safety line", () => {
    const off = evaluateContextPressure({ ...base, currentCompiledTokens: 91, tokenSavingLevel: "off" });
    const strong = evaluateContextPressure({ ...base, currentCompiledTokens: 91, tokenSavingLevel: "strong" });
    expect(strong.state).toBe("emergency");
    expect(strong.requiredFreeTokens).toBe(off.requiredFreeTokens);
    expect(strong.targetTokens).toBeLessThanOrEqual(off.targetTokens ?? 0);
  });

  test("guards against repeated compaction decisions in one generation", () => {
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 89,
      recentRequestGrowthP95: 8,
      lastCompaction: { generation: 2, tokensAfter: 95, newTokensSince: 1 },
    });
    expect(decision.reasonCodes).toContain("compaction_generation_guard");
  });

  test("a budget derived from the request cannot bound the request", () => {
    // Why the route's measured context band is unusable as a budget: it is the
    // smallest band that already covers the request, so request/budget is pinned
    // in the top of the band and the upper tenth of every band is `emergency`.
    for (const band of [64_000, 192_000, 272_000, 512_000, 1_000_000]) {
      const decision = evaluateContextPressure({
        ...base,
        currentCompiledTokens: band - 1,
        inputBudgetTokens: band,
        recentRequestGrowthP95: 0,
        reservedToolExpansionTokens: 0,
      });
      expect(decision.state).toBe("emergency");
    }
  });

  test("the compaction target is strictly below the emergency line", () => {
    // DEFAULT_TARGET_RATIO.off and DEFAULT_EMERGENCY_RATIO were both 0.9 and the
    // state test is `>=`, so a perfectly hit target immediately re-entered
    // emergency and compaction could never settle. Uses a production-scale
    // budget so the absolute 1_024 target floor is not the binding term.
    const wide = {
      inputBudgetTokens: 96_000,
      pendingHistoryDeltaTokens: 0,
      pendingContextPackTokens: 0,
      recentRequestGrowthP95: 500,
      reservedToolExpansionTokens: 800,
    };
    for (const level of ["off", "light", "balanced", "strong"] as const) {
      const decision = evaluateContextPressure({
        ...wide,
        currentCompiledTokens: 92_000,
        tokenSavingLevel: level,
      });
      expect(decision.targetTokens).toBeDefined();
      expect(decision.targetTokens! / 96_000).toBeLessThan(0.9);
      const afterTarget = evaluateContextPressure({
        ...wide,
        currentCompiledTokens: decision.targetTokens!,
        tokenSavingLevel: level,
      });
      expect(afterTarget.state).not.toBe("emergency");
    }
  });

  test("the generation guard does not demote when the session really grew", () => {
    // The guard's threshold is max(256, requiredFreeTokens / 2), so growth has to
    // clear the 256-token absolute floor before the guard stops demoting.
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 89,
      recentRequestGrowthP95: 8,
      lastCompaction: { generation: 2, tokensAfter: 40, newTokensSince: 512 },
    });
    expect(decision.reasonCodes).not.toContain("compaction_generation_guard");
  });

  test("tracks request growth with a bounded p95 window", () => {
    const controller = new ContextPressureController({ growthWindow: 3 });
    controller.observeCompiledTokens(10);
    controller.observeCompiledTokens(20);
    controller.observeCompiledTokens(50);
    controller.observeCompiledTokens(55);
    expect(controller.snapshot().recentGrowth).toEqual([10, 30, 5]);
    expect(controller.recentRequestGrowthP95).toBeGreaterThan(20);
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85);
  });
});
