import { describe, expect, test } from "bun:test";

import {
  analyzePairedStatistics,
  canonicalComparisonTarget,
  evaluateStatisticalGate,
  type ComparisonTarget,
  type RunMetrics,
  type StatisticalRun,
  type StatisticalTaskDefinition,
} from "../src/index.ts";

function metrics(input: {
  readonly taskId: string;
  readonly passed?: boolean;
  readonly wallMs: number;
  readonly payloadBytes: number;
  readonly requests: number;
  readonly costUsd?: number;
  readonly preProviderMs?: number;
  readonly scopePrecision?: number;
  readonly missedApprovals?: readonly string[];
  readonly invisibleSideEffects?: number;
  readonly unsupportedClaims?: readonly string[];
  readonly statusMatched?: boolean;
}): RunMetrics {
  const passed = input.passed ?? true;
  const statusMatched = input.statusMatched ?? true;
  return {
    taskId: input.taskId,
    profile: "fixture",
    outcome: {
      hiddenTestsPassed: passed,
      hiddenTestsRun: 1,
      hiddenTestsFailed: passed ? 0 : 1,
      outOfScopeFiles: [],
      missedScopeFiles: [],
      scopePrecision: input.scopePrecision ?? 1,
      regressions: 0,
      status: passed ? "completed" : "failed",
      statusMatched,
    },
    behavior: {
      toolCalls: 1,
      failedToolCalls: 0,
      schemaErrors: 0,
      filesRead: 1,
      redundantReads: 0,
      approvalsRequested: [],
      approvalsGranted: 0,
      approvalsDenied: 0,
      missingApprovals: [...(input.missedApprovals ?? [])],
      unexpectedApprovals: [],
      retries: 0,
      subagentsSpawned: 0,
      subagentsUseful: 0,
      discoveryCalls: 0,
      selfCorrections: 0,
      selfCorrectionCategories: {},
      abandonedCorrections: 0,
    },
    cost: {
      timeToFirstCommentaryMs: 1,
      timeToFirstToolMs: 2,
      totalWallTimeMs: input.wallMs,
      timeToFirstProviderRequestMs: input.preProviderMs ?? 50,
      timeToResponseCreatedMs: 100,
      timeToFirstProviderDeltaMs: 110,
      preProviderLocalMs: input.preProviderMs ?? 50,
      repositoryWaitMs: 0,
      promptCompileMs: 5,
      providerWallMs: input.wallMs - 10,
      fullPayloadBytes: input.payloadBytes,
      incrementalPayloadBytes: 0,
      providerRequests: input.requests,
      modelSteps: input.requests,
      reusedConnections: 0,
      providerFallbacks: 0,
      toolActiveMs: 10,
      toolWaitMs: 0,
      verificationWallMs: 5,
      reviewWallMs: 0,
      reviewCalls: 0,
      reviewInputBytes: 0,
      provisionalContextTurns: 0,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      estimatedCostUsd: input.costUsd ?? 1,
      cacheHitRate: 0,
      subagentTokenShare: 0,
    },
    context: {
      packsCompiled: 1,
      actualPromptTokens: 100,
      totalInputTokens: 100,
      stablePrefixTokens: 50,
      variableTokens: 50,
      exactEvidenceTokens: 10,
      excerptTokens: 10,
      evidenceItems: 1,
      excerptItems: 1,
      evictions: 0,
      evictedItemCount: 0,
      evictedTokens: 0,
      evidenceRejections: 0,
      rejectedEvidenceCount: 0,
      staleEvidenceRejections: 0,
      staleEvidenceCount: 0,
      duplicateItems: 0,
      duplicateTokens: 0,
      duplicateTokenRatio: 0,
      cacheSegments: 0,
      cacheSegmentTokens: 0,
    },
    ux: {
      repetitiveCommentary: 0,
      invisibleSideEffects: input.invisibleSideEffects ?? 0,
      unclearBackgroundStates: 0,
      reportCompleteness: 1,
      unsupportedClaims: [...(input.unsupportedClaims ?? [])],
      missingReportMentions: [],
      missingRiskMentions: [],
    },
    eventCount: 4,
  };
}

function fixture(
  target: ComparisonTarget,
  speedup = 2.5,
  mutate?: (input: {
    readonly task: StatisticalTaskDefinition;
    readonly repetition: number;
    readonly variant: "baseline" | "candidate";
    readonly value: RunMetrics;
  }) => RunMetrics,
) {
  const categories = ["local_bug_fix", "security_safety"] as const;
  const tasks: StatisticalTaskDefinition[] = Array.from({ length: 10 }, (_value, index) => ({
    id: `task-${index + 1}`,
    category: categories[index % categories.length]!,
    risks: index % 2 === 0 ? ["path_traversal"] : [],
  }));
  const runs: StatisticalRun[] = [];
  for (let repetition = 1; repetition <= 5; repetition += 1) {
    for (const variant of ["baseline", "candidate"] as const) {
      runs.push({
        variant,
        repetition,
        temperature: repetition === 1 ? "cold" : "warm",
        results: tasks.map((task) => {
          const value = metrics({
            taskId: task.id,
            wallMs: variant === "baseline" ? 2_000 : 2_000 / speedup,
            payloadBytes: variant === "baseline" ? 10_000 : 500,
            requests: variant === "baseline" ? 8 : 4,
            costUsd: variant === "baseline" ? 1 : 1.02,
            preProviderMs: variant === "baseline" ? 300 : 100,
          });
          return {
            taskId: task.id,
            metrics: mutate?.({ task, repetition, variant, value }) ?? value,
          };
        }),
      });
    }
  }
  return analyzePairedStatistics(tasks, runs, {
    target,
    iterations: 200,
    seed: "statistics-test",
  });
}

describe("paired statistical evidence", () => {
  test("produces deterministic stratified confidence intervals and passes every primary gate", () => {
    const first = fixture("capybara_baseline");
    const second = fixture("capybara_baseline");

    expect(first).toEqual(second);
    expect(first.taskCount).toBe(10);
    expect(first.pairCount).toBe(50);
    expect(first.repetitionsPerTask).toEqual({ minimum: 5, maximum: 5 });
    expect(first.qualityDifferencePoints.lower).toBe(0);
    expect(first.medianSpeedup.lower).toBeGreaterThanOrEqual(2.49);
    expect(first.payloadReduction?.lower).toBeGreaterThanOrEqual(0.94);
    expect(first.providerRequestReduction?.lower).toBe(0.5);
    expect(first.preProviderLocalP95Ms.upper).toBe(100);
    expect(evaluateStatisticalGate(first).status).toBe("passed");
  });

  test("blocks a category regression even when the overall mean could look acceptable", () => {
    const statistics = fixture("external_backbone_matched", 2, ({ task, repetition, variant, value }) => {
      if (
        variant === "candidate" &&
        task.category === "security_safety" &&
        repetition === 1
      ) {
        return metrics({
          taskId: task.id,
          passed: false,
          wallMs: value.cost.totalWallTimeMs,
          payloadBytes: value.cost.fullPayloadBytes,
          requests: value.cost.providerRequests,
          statusMatched: false,
        });
      }
      return value;
    });

    const gate = evaluateStatisticalGate(statistics);
    expect(statistics.categoryQuality.find((entry) => entry.category === "security_safety")?.differencePoints)
      .toBeCloseTo(-20, 8);
    expect(gate.findings).toContainEqual(expect.objectContaining({
      check: "category quality",
      severity: "blocking",
    }));
    expect(gate.findings).toContainEqual(expect.objectContaining({
      check: "critical safety",
      severity: "blocking",
    }));
  });

  test("uses distinct Capybara and external-comparison speed thresholds", () => {
    const external = fixture("external_backbone_matched", 1.6);
    const capybara = fixture("capybara_baseline", 1.6);

    expect(evaluateStatisticalGate(external).findings.find((entry) => entry.check === "paired median speed"))
      .toMatchObject({ severity: "ok" });
    expect(evaluateStatisticalGate(capybara).findings.find((entry) => entry.check === "paired median speed"))
      .toMatchObject({ severity: "blocking" });
  });

  test("keeps codex_matched only as a deprecated backbone compatibility alias", () => {
    expect(canonicalComparisonTarget("codex_matched")).toBe("external_backbone_matched");
    expect(evaluateStatisticalGate(fixture("codex_matched", 1.6)).status)
      .toBe(evaluateStatisticalGate(fixture("external_backbone_matched", 1.6)).status);
  });

  test("counts missing or duplicate pairs instead of silently dropping them", () => {
    const task: StatisticalTaskDefinition = {
      id: "unpaired",
      category: "local_bug_fix",
      risks: [],
    };
    const value = metrics({
      taskId: task.id,
      wallMs: 100,
      payloadBytes: 100,
      requests: 1,
    });
    const statistics = analyzePairedStatistics([task], [{
      variant: "baseline",
      repetition: 1,
      temperature: "cold",
      results: [{ taskId: task.id, metrics: value }],
    }], { iterations: 100, seed: "unpaired" });

    expect(statistics.taskCount).toBe(0);
    expect(statistics.unpairedObservations).toBe(1);
    expect(evaluateStatisticalGate(statistics).status).toBe("failed");
  });
});
