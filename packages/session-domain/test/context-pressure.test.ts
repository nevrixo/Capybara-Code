import { describe, expect, test } from "bun:test";

import {
  ContextPressureController,
  evaluateContextPressure,
  percentile,
} from "../src/context-pressure.ts";

const base = {
  currentCompiledTokens: 6_000,
  inputBudgetTokens: 10_000,
  modelContextWindowTokens: 12_000,
  outputReserveTokens: 2_000,
  pendingHistoryDeltaTokens: 0,
  pendingContextPackTokens: 0,
  recentRequestGrowthP95: 200,
  reservedToolExpansionTokens: 400,
  tokenSavingLevel: "off" as const,
};

describe("model-input-capacity context pressure", () => {
  test("uses the projected next request rather than only current usage", () => {
    const decision = evaluateContextPressure({
      ...base,
      pendingContextPackTokens: 4_400,
    });
    expect(decision.state).toBe("compact");
    expect(decision.projectedTokens).toBe(10_800);
    expect(decision.reasonCodes).toContain("pending_context_pack");
  });

  test("keeps a low-growth 70 percent request stable", () => {
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 7_000,
      recentRequestGrowthP95: 100,
      reservedToolExpansionTokens: 200,
    });
    expect(decision.state).toBe("stable");
  });

  test("uses distinct 80/90/97 percent state boundaries", () => {
    const exact = (currentCompiledTokens: number) => evaluateContextPressure({
      ...base,
      currentCompiledTokens,
      recentRequestGrowthP95: 0,
      reservedToolExpansionTokens: 0,
    });
    expect(exact(7_999).state).toBe("stable");
    expect(exact(8_000).state).toBe("prepare");
    expect(exact(8_999).state).toBe("prepare");
    expect(exact(9_000).state).toBe("compact");
    expect(exact(9_699).state).toBe("compact");
    expect(exact(9_700).state).toBe("emergency");
    expect(exact(10_001).state).toBe("hard_emergency");
  });

  test("compacts at 89.9 percent only when projection reaches 90 percent", () => {
    const below = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 8_990,
      recentRequestGrowthP95: 0,
      reservedToolExpansionTokens: 0,
    });
    const crossing = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 8_990,
      recentRequestGrowthP95: 10,
      reservedToolExpansionTokens: 10,
    });
    expect(below.state).toBe("prepare");
    expect(crossing.state).toBe("compact");
    expect(crossing.reasonCodes).toContain("projected_trigger_ratio");
  });

  test("strong saving changes the target, not the safety line", () => {
    const stableProjection = { recentRequestGrowthP95: 0, reservedToolExpansionTokens: 0 };
    const off = evaluateContextPressure({ ...base, ...stableProjection, currentCompiledTokens: 9_700, tokenSavingLevel: "off" });
    const strong = evaluateContextPressure({ ...base, ...stableProjection, currentCompiledTokens: 9_700, tokenSavingLevel: "strong" });
    expect(off.state).toBe("emergency");
    expect(strong.state).toBe("emergency");
    expect(strong.requiredFreeTokens).toBe(off.requiredFreeTokens);
    expect(strong.targetTokens).toBeLessThanOrEqual(off.targetTokens ?? 0);
  });

  test("guards against repeated compaction decisions in one generation", () => {
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 9_100,
      recentRequestGrowthP95: 0,
      reservedToolExpansionTokens: 0,
      lastCompaction: { generation: 2, tokensAfter: 9_000, newTokensSince: 100 },
    });
    expect(decision.state).toBe("prepare");
    expect(decision.reasonCodes).toContain("compaction_generation_guard");
  });

  test("the generation guard stops demoting after the configured growth floor", () => {
    const decision = evaluateContextPressure({
      ...base,
      currentCompiledTokens: 9_100,
      recentRequestGrowthP95: 0,
      reservedToolExpansionTokens: 0,
      lastCompaction: { generation: 2, tokensAfter: 4_000, newTokensSince: 4_096 },
    });
    expect(decision.state).toBe("compact");
    expect(decision.reasonCodes).not.toContain("compaction_generation_guard");
  });

  test("reports the shared model input capacity basis", () => {
    for (const budget of [64_000, 192_000, 272_000, 512_000, 1_000_000]) {
      const decision = evaluateContextPressure({
        ...base,
        currentCompiledTokens: Math.floor(budget * 0.9),
        inputBudgetTokens: budget,
        modelContextWindowTokens: budget + 32_000,
        outputReserveTokens: 32_000,
        recentRequestGrowthP95: 0,
        reservedToolExpansionTokens: 0,
      });
      expect(decision.state).toBe("compact");
      expect(decision.basis).toBe("model_input_capacity");
      expect(decision.modelContextWindowTokens).toBe(budget + 32_000);
      expect(decision.triggerTokens).toBe(Math.floor(budget * 0.9));
    }
  });

  test("targets at most 60 percent by default", () => {
    const wide = {
      inputBudgetTokens: 96_000,
      modelContextWindowTokens: 128_000,
      outputReserveTokens: 32_000,
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
      expect(decision.targetTokens! / 96_000).toBeLessThanOrEqual(0.6);
      const afterTarget = evaluateContextPressure({
        ...wide,
        currentCompiledTokens: decision.targetTokens!,
        tokenSavingLevel: level,
      });
      expect(afterTarget.state).toBe("stable");
    }
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
