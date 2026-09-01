import { describe, expect, test } from "bun:test";

import { EventSequencer, createEvent } from "@cbc/protocol";
import {
  emptyContextUsageCategories,
  emptyViewModel,
  makeContextUsageSnapshot,
  reduce,
} from "../src/index.ts";

function receipt(strategy: "model_summary" | "provider_native" | "deterministic_fallback") {
  return {
    schemaVersion: "2.0",
    strategy,
    trigger: "ratio",
    inputBudgetTokens: 1_018_000,
    modelContextWindowTokens: 1_050_000,
    outputReserveTokens: 32_000,
    compiledTokensBefore: 916_000,
    compressiblePrefixTokens: 400_000,
    summaryTokens: 7_800,
    compiledTokensAfter: 604_000,
    ratioBefore: 916_000 / 1_018_000,
    ratioAfter: 604_000 / 1_018_000,
    targetRatio: 0.6,
    sourceDigest: "a".repeat(64),
    summaryDigest: "b".repeat(64),
    generation: 1,
    fallbackUsed: strategy === "deterministic_fallback",
    targetMet: true,
    reasonCodes: ["current_trigger_ratio"],
  } as const;
}

describe("compaction receipt v2 reducer", () => {
  test("uses exact compiled-after tokens and keeps summary size separate", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("receipt", 1_018_000, 192_000);
    const committed = receipt("model_summary");
    const usage = makeContextUsageSnapshot({
      packId: "pack-after",
      modelId: "gpt-5.6-sol",
      budgetTokens: committed.inputBudgetTokens,
      modelWindowTokens: committed.modelContextWindowTokens,
      outputReserveTokens: committed.outputReserveTokens,
      optimizationTargetTokens: 192_000,
      usedTokens: committed.compiledTokensAfter,
      categories: {
        ...emptyContextUsageCategories(),
        messages: committed.compiledTokensAfter,
      },
    });
    model = reduce(model, createEvent(
      sequencer,
      "context.compaction_committed",
      { receipt: committed, contextUsage: usage },
      { sessionId: model.sessionId },
    ));
    model = reduce(model, createEvent(
      sequencer,
      "session.compacted",
      {
        schemaVersion: "2.0",
        generation: 1,
        receipt: committed,
        tokensAfter: committed.compiledTokensAfter,
        capsuleTokens: committed.summaryTokens,
      },
      { sessionId: model.sessionId },
    ));

    expect(model.contextUsedTokens).toBe(604_000);
    expect(model.contextUsage?.usedTokens).toBe(604_000);
    expect(model.contextGeneration).toBe(1);
    expect(model.contextBudgetTokens).toBe(1_018_000);
    expect(model.contextOptimizationTargetTokens).toBe(192_000);
    const notices = model.timeline.filter((item) => item.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("model summary");
    expect(notices[0]?.text).toContain("916.0K → 604.0K");
    expect(notices[0]?.text).toContain("summary 7.8K");
  });

  test("labels deterministic fallback explicitly", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("fallback", 1_018_000, 192_000);
    model = reduce(model, createEvent(
      sequencer,
      "context.compaction_committed",
      { receipt: receipt("deterministic_fallback") },
      { sessionId: model.sessionId },
    ));
    const notice = model.timeline.findLast((item) => item.type === "notice");
    expect(notice?.type === "notice" ? notice.text : "").toContain("emergency fallback");
    expect(notice?.type === "notice" ? notice.level : "").toBe("warning");
  });

  test("reports validation failure and abort without optimistic context changes", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("invalid", 100_000, 20_000);
    model = { ...model, contextUsedTokens: 91_000 };
    model = reduce(model, createEvent(
      sequencer,
      "context.compaction_validation_failed",
      { issues: [{ code: "unknown_path" }] },
      { sessionId: model.sessionId },
    ));
    model = reduce(model, createEvent(
      sequencer,
      "context.compaction_aborted",
      { reasonCodes: ["model_summary_validation_failed"] },
      { sessionId: model.sessionId },
    ));
    expect(model.contextUsedTokens).toBe(91_000);
    expect(model.contextGeneration).toBe(0);
    expect(model.timeline.filter((item) => item.type === "notice").map((item) => item.text))
      .toEqual(expect.arrayContaining([
        expect.stringContaining("previous history was retained"),
        expect.stringContaining("previous history retained"),
      ]));
  });
});
