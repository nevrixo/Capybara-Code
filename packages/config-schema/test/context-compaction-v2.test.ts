import { describe, expect, test } from "bun:test";

import { configKeyInfo, defaultConfig, mergeConfig } from "../src/index.ts";

describe("context compaction v2 configuration", () => {
  test("ships model-summary safety defaults against model input capacity", () => {
    const context = defaultConfig().model.context;
    expect(context).toMatchObject({
      compactionPrepareRatio: 0.8,
      compactionTriggerRatio: 0.9,
      compactionEmergencyRatio: 0.97,
      compactionTargetRatio: 0.6,
      compactionStrategy: "model-summary",
      compactionModel: "same",
      compactionReasoningEffort: "low",
      compactionRecentTurns: 2,
      compactionMaxAttemptsPerGeneration: 1,
      compactionMinNewTokens: 4_096,
      compactionFallback: "evidence-ledger",
      contextGaugeBasis: "model-input-capacity",
      optimizationTargetTokens: 192_000,
      maxInputTokens: "auto",
    });
  });

  test("accepts explicit strategy, model, hard cap, and ratios", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "model.context.compactionStrategy": "hybrid",
        "model.context.compactionModel": "gpt-5.6-terra",
        "model.context.compactionReasoningEffort": "medium",
        "model.context.compactionPrepareRatio": 0.75,
        "model.context.compactionTriggerRatio": 0.88,
        "model.context.compactionEmergencyRatio": 0.96,
        "model.context.compactionTargetRatio": 0.55,
        "model.context.maxInputTokens": 800_000,
      },
    }]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.model.context).toMatchObject({
      compactionStrategy: "hybrid",
      compactionModel: "gpt-5.6-terra",
      compactionReasoningEffort: "medium",
      maxInputTokens: 800_000,
    });
  });

  test("rejects invalid ratio ordering", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "model.context.compactionPrepareRatio": 0.92,
        "model.context.compactionTriggerRatio": 0.9,
      },
    }]);
    expect(merged.issues).toContainEqual(expect.objectContaining({
      severity: "error",
      path: "model.context.compactionTriggerRatio",
    }));
  });

  test("dual-reads legacy keys and emits actionable migration warnings", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "model.softContextTokens": 144_000,
        "model.context.emergencyRatio": 0.95,
        "model.context.providerCompactionMode": "auto",
      },
    }]);
    expect(merged.config.model.context.optimizationTargetTokens).toBe(144_000);
    expect(merged.config.model.context.compactionEmergencyRatio).toBe(0.95);
    expect(merged.config.model.context.compactionStrategy).toBe("hybrid");
    expect(merged.issues.filter((issue) => issue.message.includes("capy config migrate"))).toHaveLength(3);
  });

  test("explicit v2 keys win over legacy aliases", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "model.context.compactionStrategy": "model-summary",
        "model.context.providerCompactionMode": "on",
        "model.context.compactionEmergencyRatio": 0.98,
        "model.context.emergencyRatio": 0.94,
      },
    }]);
    expect(merged.config.model.context.compactionStrategy).toBe("model-summary");
    expect(merged.config.model.context.compactionEmergencyRatio).toBe(0.98);
  });

  test("classifies the v2 surface as wired and the old surface as deprecated", () => {
    expect(configKeyInfo("model.context.compactionStrategy")?.status).toBe("wired");
    expect(configKeyInfo("model.context.optimizationTargetTokens")?.status).toBe("wired");
    expect(configKeyInfo("experimental.contextCompactionV2")?.status).toBe("wired");
    expect(configKeyInfo("model.context.compactionPolicy")?.status).toBe("deprecated");
    expect(configKeyInfo("model.softContextTokens")?.status).toBe("deprecated");
  });
});
