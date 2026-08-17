import { describe, expect, test } from "bun:test";

import {
  PERFORMANCE_KILL_SWITCHES,
  SAFE_PERFORMANCE_ROLLBACK_OVERRIDES,
  configKeyInfo,
  evaluatePerformanceRollback,
  mergeConfig,
  performanceFeatureOverrides,
  type PerformanceHealthWindow,
  type PerformanceRollbackTrigger,
} from "../src/index.ts";

const HEALTHY: PerformanceHealthWindow = {
  unapprovedSideEffects: 0,
  staleContextMutations: 0,
  falseCompletions: 0,
  continuationFallbackRatio: 0.02,
  websocketProtocolErrorRatio: 0.005,
  p95LatencyRatio: 1.09,
  qualityCiLowerPoints: -1,
  promptDigestMismatches: 0,
};

describe("performance rollback contract", () => {
  test("every performance kill switch is a wired, valid config override", () => {
    expect(new Set(PERFORMANCE_KILL_SWITCHES.map((entry) => entry.feature))).toEqual(new Set([
      "telemetry",
      "prompt_compiler",
      "continuation_transport",
      "progressive_orientation",
      "parallel_tools",
      "compound_tools",
      "risk_review",
      "phase_policy",
      "provider_compaction",
      "tool_search",
      "fast_service_tier",
      "context_pack_projection",
      "subagent_profile_resolution_v2",
      "subagent_context_reservations",
      "phase_routing",
      "budget_enforcement",
      "retrieval_controller_v2",
      "verification_planner_v2",
      "commentary_policy_v2",
      "long_session_fast_path",
      "context_pack_projection",
      "subagent_profile_resolution_v2",
      "subagent_context_reservations",
      "phase_routing",
      "budget_enforcement",
      "retrieval_controller_v2",
      "verification_planner_v2",
      "commentary_policy_v2",
    ]));
    for (const entry of PERFORMANCE_KILL_SWITCHES) {
      expect(configKeyInfo(entry.configPath), entry.configPath).toMatchObject({ status: "wired" });
    }

    const merged = mergeConfig([{ source: "session", values: {
      ...SAFE_PERFORMANCE_ROLLBACK_OVERRIDES,
    } }]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.perf.telemetry).toBe(false);
    expect(merged.config.agent.promptCompiler).toBe("v1");
    expect(merged.config.provider.openai.transport).toBe("http_full");
    expect(merged.config.model.context.orientationMode).toBe("strict");
    expect(merged.config.agent.toolGraph.commandClassification).toBe(false);
    expect(merged.config.agent.toolGraph.providerParallelTools).toBe(false);
    expect(merged.config.agent.compoundTools).toBe(false);
    expect(merged.config.agent.verification.reviewPolicy).toBe("always");
    expect(merged.config.model.router.phasePolicy).toBe(false);
    expect(merged.config.model.context.providerCompaction).toBe(false);
    expect(merged.config.provider.openai.toolSearch).toBe(false);
    expect(merged.config.provider.openai.serviceTier).toBe("standard");
  });

  test("threshold boundaries do not roll back, but each documented excess does", () => {
    expect(evaluatePerformanceRollback(HEALTHY)).toEqual({
      rollback: false,
      triggers: [],
      overrides: {},
    });

    const cases: Array<{
      patch: Partial<PerformanceHealthWindow>;
      trigger: PerformanceRollbackTrigger;
    }> = [
      { patch: { unapprovedSideEffects: 1 }, trigger: "unapproved_side_effect" },
      { patch: { staleContextMutations: 1 }, trigger: "stale_context_mutation" },
      { patch: { falseCompletions: 1 }, trigger: "false_completion" },
      { patch: { continuationFallbackRatio: 0.020_001 }, trigger: "continuation_fallback" },
      { patch: { websocketProtocolErrorRatio: 0.005_001 }, trigger: "websocket_protocol_error" },
      { patch: { p95LatencyRatio: 1.1 }, trigger: "p95_regression" },
      { patch: { qualityCiLowerPoints: -1.000_1 }, trigger: "quality_noninferiority" },
      { patch: { promptDigestMismatches: 1 }, trigger: "prompt_digest_mismatch" },
      { patch: { v3SnapshotFallbackRatio: 0.005_001 }, trigger: "snapshot_fallback" },
      { patch: { heapLimitExceeded: true }, trigger: "heap_pressure" },
      { patch: { rssLimitExceeded: true }, trigger: "rss_pressure" },
    ];

    for (const { patch, trigger } of cases) {
      const decision = evaluatePerformanceRollback({ ...HEALTHY, ...patch });
      expect(decision.rollback, trigger).toBe(true);
      expect(decision.triggers, trigger).toContain(trigger);
      expect(Object.keys(decision.overrides).length, trigger).toBeGreaterThan(0);
    }
  });

  test("transport faults use the narrow HTTP-full fallback", () => {
    const decision = evaluatePerformanceRollback({
      ...HEALTHY,
      continuationFallbackRatio: 0.03,
      websocketProtocolErrorRatio: 0.006,
    });

    expect(decision.triggers).toEqual([
      "continuation_fallback",
      "websocket_protocol_error",
    ]);
    expect(decision.overrides).toEqual({
      "provider.openai.transport": "http_full",
    });
  });

  test("latency regression disables critical-path optimizations but leaves telemetry enabled", () => {
    const decision = evaluatePerformanceRollback({ ...HEALTHY, p95LatencyRatio: 1.2 });

    expect(decision.overrides).toEqual(performanceFeatureOverrides([
      "prompt_compiler",
      "progressive_orientation",
      "parallel_tools",
      "compound_tools",
      "phase_policy",
      "provider_compaction",
      "tool_search",
      "fast_service_tier",
      "context_pack_projection",
      "subagent_profile_resolution_v2",
      "subagent_context_reservations",
      "phase_routing",
      "budget_enforcement",
      "retrieval_controller_v2",
      "verification_planner_v2",
      "commentary_policy_v2",
      "long_session_fast_path",
      "context_pack_projection",
      "subagent_profile_resolution_v2",
      "subagent_context_reservations",
      "phase_routing",
      "budget_enforcement",
      "retrieval_controller_v2",
      "verification_planner_v2",
      "commentary_policy_v2",
    ]));
    expect(decision.overrides).not.toHaveProperty("perf.telemetry");
    expect(decision.overrides).not.toHaveProperty("agent.verification.reviewPolicy");
  });

  test("any safety, freshness, truthfulness, quality, or digest failure selects the full safe profile", () => {
    for (const patch of [
      { unapprovedSideEffects: 1 },
      { staleContextMutations: 1 },
      { falseCompletions: 1 },
      { qualityCiLowerPoints: -2 },
      { promptDigestMismatches: 1 },
    ] satisfies Array<Partial<PerformanceHealthWindow>>) {
      expect(evaluatePerformanceRollback({ ...HEALTHY, ...patch }).overrides)
        .toEqual(SAFE_PERFORMANCE_ROLLBACK_OVERRIDES);
    }
  });

  test("invalid health windows fail closed", () => {
    expect(() => evaluatePerformanceRollback({
      ...HEALTHY,
      continuationFallbackRatio: 1.1,
    })).toThrow("between 0 and 1");
    expect(() => evaluatePerformanceRollback({
      ...HEALTHY,
      promptDigestMismatches: -1,
    })).toThrow("non-negative integer");
    expect(() => evaluatePerformanceRollback({
      ...HEALTHY,
      p95LatencyRatio: Number.NaN,
    })).toThrow("finite number");
  });
});
