/**
 * Performance-program kill switches and automatic rollback evaluation.
 *
 * These values are ordinary user/session config overrides. They do not bypass policy;
 * they select the conservative execution paths that predate each optimization.
 */

import type { ConfigLayer } from "./schema.ts";

export type PerformanceFeature =
  | "telemetry"
  | "prompt_compiler"
  | "continuation_transport"
  | "progressive_orientation"
  | "parallel_tools"
  | "compound_tools"
  | "risk_review"
  | "phase_policy"
  | "provider_compaction"
  | "tool_search"
  | "fast_service_tier"
  | "long_session_fast_path"
  | "context_pack_projection"
  | "subagent_profile_resolution_v2"
  | "subagent_context_reservations"
  | "phase_routing"
  | "budget_enforcement"
  | "retrieval_controller_v2"
  | "verification_planner_v2"
  | "commentary_policy_v2";

export interface PerformanceKillSwitch {
  readonly feature: PerformanceFeature;
  readonly configPath: string;
  readonly safeValue: string | boolean;
  readonly reason: string;
}

export const PERFORMANCE_KILL_SWITCHES: readonly PerformanceKillSwitch[] = [
  {
    feature: "telemetry",
    configPath: "perf.telemetry",
    safeValue: false,
    reason: "remove optional performance event recording",
  },
  {
    feature: "prompt_compiler",
    configPath: "agent.promptCompiler",
    safeValue: "v1",
    reason: "restore the legacy prompt materialization path",
  },
  {
    feature: "continuation_transport",
    configPath: "provider.openai.transport",
    safeValue: "http_full",
    reason: "disable response anchors and persistent sockets",
  },
  {
    feature: "progressive_orientation",
    configPath: "model.context.orientationMode",
    safeValue: "strict",
    reason: "wait for the full live repository scan before sampling",
  },
  {
    feature: "parallel_tools",
    configPath: "agent.toolGraph.commandClassification",
    safeValue: false,
    reason: "restore conservative command-lane classification",
  },
  {
    feature: "parallel_tools",
    configPath: "agent.toolGraph.providerParallelTools",
    safeValue: false,
    reason: "stop requesting provider parallel tool calls",
  },
  {
    feature: "compound_tools",
    configPath: "agent.compoundTools",
    safeValue: false,
    reason: "expose only primitive tools",
  },
  {
    feature: "risk_review",
    configPath: "agent.verification.reviewPolicy",
    safeValue: "always",
    reason: "run independent review after every mutation",
  },
  {
    feature: "phase_policy",
    configPath: "model.router.phasePolicy",
    safeValue: false,
    reason: "restore one inference policy for the whole turn",
  },
  {
    feature: "provider_compaction",
    configPath: "model.context.providerCompaction",
    safeValue: false,
    reason: "use the local evidence-ledger compaction path only",
  },
  {
    feature: "tool_search",
    configPath: "provider.openai.toolSearch",
    safeValue: false,
    reason: "disable provider-native deferred tool loading",
  },
  {
    feature: "fast_service_tier",
    configPath: "provider.openai.serviceTier",
    safeValue: "standard",
    reason: "return to the standard serving and cost profile",
  },
  {
    feature: "long_session_fast_path",
    configPath: "perf.longSessionFastPath",
    safeValue: false,
    reason: "restore v2 resume/snapshot and full-history UI behavior",
  },
  {
    feature: "context_pack_projection",
    configPath: "perf.contextPackProjection",
    safeValue: false,
    reason: "restore the legacy repository-context prompt path",
  },
  {
    feature: "subagent_profile_resolution_v2",
    configPath: "perf.subagentProfileResolutionV2",
    safeValue: false,
    reason: "restore static child profile selection",
  },
  {
    feature: "subagent_context_reservations",
    configPath: "perf.subagentContextReservations",
    safeValue: false,
    reason: "disable predictive child context reservations",
  },
  {
    feature: "phase_routing",
    configPath: "perf.phaseRouting",
    safeValue: false,
    reason: "restore one inference route for the whole turn",
  },
  {
    feature: "budget_enforcement",
    configPath: "perf.budgetEnforcement",
    safeValue: "shadow",
    reason: "observe turn budget decisions without blocking requests",
  },
  {
    feature: "retrieval_controller_v2",
    configPath: "perf.retrievalControllerV2",
    safeValue: false,
    reason: "restore sequential retrieval preview behavior",
  },
  {
    feature: "verification_planner_v2",
    configPath: "perf.verificationPlannerV2",
    safeValue: false,
    reason: "restore the legacy fixed verification command",
  },
  {
    feature: "commentary_policy_v2",
    configPath: "perf.commentaryPolicyV2",
    safeValue: false,
    reason: "restore the legacy commentary disclosure policy",
  },
] as const;

export const SAFE_PERFORMANCE_ROLLBACK_OVERRIDES: Readonly<ConfigLayer> = Object.freeze(
  Object.fromEntries(
    PERFORMANCE_KILL_SWITCHES.map((entry) => [entry.configPath, entry.safeValue]),
  ),
);

export interface PerformanceHealthWindow {
  readonly unapprovedSideEffects: number;
  readonly staleContextMutations: number;
  readonly falseCompletions: number;
  /** Fraction in [0, 1]. */
  readonly continuationFallbackRatio: number;
  /** Fraction in [0, 1]. */
  readonly websocketProtocolErrorRatio: number;
  /** Candidate p95 divided by baseline p95. */
  readonly p95LatencyRatio: number;
  /** Candidate-minus-baseline quality CI lower bound, percentage points. */
  readonly qualityCiLowerPoints: number;
  readonly promptDigestMismatches: number;
  /** Optional long-session rollout signals. */
  readonly v3SnapshotFallbackRatio?: number;
  readonly heapLimitExceeded?: boolean;
  readonly rssLimitExceeded?: boolean;
}

export type PerformanceRollbackTrigger =
  | "unapproved_side_effect"
  | "stale_context_mutation"
  | "false_completion"
  | "continuation_fallback"
  | "websocket_protocol_error"
  | "p95_regression"
  | "quality_noninferiority"
  | "prompt_digest_mismatch"
  | "snapshot_fallback"
  | "heap_pressure"
  | "rss_pressure";

export interface PerformanceRollbackDecision {
  readonly rollback: boolean;
  readonly triggers: readonly PerformanceRollbackTrigger[];
  readonly overrides: Readonly<ConfigLayer>;
}

/**
 * Evaluate one rollout health window against hard rollback thresholds.
 *
 * Safety, freshness, truthfulness, and request-digest failures roll back every
 * optimization. Transport-only failures use the narrower HTTP-full kill switch; a
 * latency-only failure disables the critical-path optimizations while keeping telemetry
 * so the regression remains observable.
 */
export function evaluatePerformanceRollback(
  health: PerformanceHealthWindow,
): PerformanceRollbackDecision {
  validateHealthWindow(health);
  const triggers: PerformanceRollbackTrigger[] = [];
  if (health.unapprovedSideEffects > 0) triggers.push("unapproved_side_effect");
  if (health.staleContextMutations > 0) triggers.push("stale_context_mutation");
  if (health.falseCompletions > 0) triggers.push("false_completion");
  if (health.continuationFallbackRatio > 0.02) triggers.push("continuation_fallback");
  if (health.websocketProtocolErrorRatio > 0.005) triggers.push("websocket_protocol_error");
  if (health.p95LatencyRatio >= 1.1) triggers.push("p95_regression");
  if (health.qualityCiLowerPoints < -1) triggers.push("quality_noninferiority");
  if (health.promptDigestMismatches > 0) triggers.push("prompt_digest_mismatch");
  if (health.v3SnapshotFallbackRatio !== undefined && health.v3SnapshotFallbackRatio > 0.005) {
    triggers.push("snapshot_fallback");
  }
  if (health.heapLimitExceeded === true) triggers.push("heap_pressure");
  if (health.rssLimitExceeded === true) triggers.push("rss_pressure");

  if (triggers.length === 0) return { rollback: false, triggers: [], overrides: {} };

  const broad = triggers.some((trigger) =>
    trigger === "unapproved_side_effect" ||
    trigger === "stale_context_mutation" ||
    trigger === "false_completion" ||
    trigger === "quality_noninferiority" ||
    trigger === "prompt_digest_mismatch" ||
    trigger === "snapshot_fallback" ||
    trigger === "heap_pressure" ||
    trigger === "rss_pressure"
  );
  if (broad) {
    return {
      rollback: true,
      triggers,
      overrides: { ...SAFE_PERFORMANCE_ROLLBACK_OVERRIDES },
    };
  }

  const overrides: ConfigLayer = {};
  if (
    triggers.includes("continuation_fallback") ||
    triggers.includes("websocket_protocol_error")
  ) {
    overrides["provider.openai.transport"] = "http_full";
  }
  if (triggers.includes("p95_regression")) {
    Object.assign(overrides, performanceFeatureOverrides([
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
    ]));
  }
  return { rollback: true, triggers, overrides };
}

export function performanceFeatureOverrides(
  features: readonly PerformanceFeature[],
): ConfigLayer {
  const selected = new Set(features);
  return Object.fromEntries(
    PERFORMANCE_KILL_SWITCHES
      .filter((entry) => selected.has(entry.feature))
      .map((entry) => [entry.configPath, entry.safeValue]),
  );
}

function validateHealthWindow(health: PerformanceHealthWindow): void {
  for (const [key, value] of Object.entries(health)) {
    if (key === "heapLimitExceeded" || key === "rssLimitExceeded") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`performance health '${key}' must be a finite number`);
    }
  }
  for (const key of [
    "unapprovedSideEffects",
    "staleContextMutations",
    "falseCompletions",
    "promptDigestMismatches",
  ] as const) {
    if (!Number.isInteger(health[key]) || health[key] < 0) {
      throw new RangeError(`performance health '${key}' must be a non-negative integer`);
    }
  }
  for (const key of ["continuationFallbackRatio", "websocketProtocolErrorRatio"] as const) {
    if (health[key] < 0 || health[key] > 1) {
      throw new RangeError(`performance health '${key}' must be between 0 and 1`);
    }
  }
  if (health.p95LatencyRatio < 0) {
    throw new RangeError("performance health 'p95LatencyRatio' must be non-negative");
  }
  if (
    health.v3SnapshotFallbackRatio !== undefined &&
    (health.v3SnapshotFallbackRatio < 0 || health.v3SnapshotFallbackRatio > 1)
  ) {
    throw new RangeError("performance health 'v3SnapshotFallbackRatio' must be between 0 and 1");
  }
  for (const [key, value] of [["heapLimitExceeded", health.heapLimitExceeded], ["rssLimitExceeded", health.rssLimitExceeded]] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`performance health '${key}' must be a boolean`);
    }
  }
}
