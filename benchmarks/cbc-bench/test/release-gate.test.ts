import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CATEGORY_TARGETS,
  TASK_CATEGORIES,
  analyzePairedStatistics,
  buildPairedSchedule,
  capabilitySnapshotDigest,
  summarize,
  type CapabilitySnapshot,
  type EvalProfile,
  type RunMetrics,
  type StatisticalRun,
  type StatisticalTaskDefinition,
} from "@cbc/evals";

import type { BenchmarkRepositoryEvidence } from "../src/evidence.ts";
import { parseExternalBenchmarkAdapter } from "../src/execution.ts";
import { resolveExecutionProfile } from "../src/profile.ts";
import {
  inspectReleaseEvidence,
  RELEASE_MIN_REPETITIONS,
  RELEASE_MIN_TASKS,
} from "../src/release-gate.ts";

const baselineProfile = makeProfile("baseline");
const candidateProfile = makeProfile("candidate");

function makeProfile(id: string): EvalProfile {
  return {
    id,
    description: id,
    model: "gpt-test",
    reasoningMode: "standard",
    reasoningEffort: "medium",
    autoReview: true,
    toolDiscovery: true,
    subagents: true,
    promptCache: "prefix",
  };
}

function makeMetrics(taskId: string, variant: "baseline" | "candidate"): RunMetrics {
  const baseline = variant === "baseline";
  const wallMs = baseline ? 2_000 : 800;
  return {
    taskId,
    profile: variant,
    outcome: {
      hiddenTestsPassed: true,
      hiddenTestsRun: 1,
      hiddenTestsFailed: 0,
      outOfScopeFiles: [],
      missedScopeFiles: [],
      scopePrecision: 1,
      regressions: 0,
      status: "completed",
      statusMatched: true,
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
      missingApprovals: [],
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
      totalWallTimeMs: wallMs,
      timeToFirstProviderRequestMs: 100,
      timeToResponseCreatedMs: 120,
      timeToFirstProviderDeltaMs: 130,
      preProviderLocalMs: 100,
      repositoryWaitMs: 0,
      promptCompileMs: 5,
      providerWallMs: wallMs - 10,
      fullPayloadBytes: baseline ? 10_000 : 500,
      incrementalPayloadBytes: 0,
      providerRequests: baseline ? 8 : 4,
      modelSteps: baseline ? 8 : 4,
      reusedConnections: baseline ? 0 : 3,
      providerFallbacks: 0,
      toolActiveMs: 10,
      toolWaitMs: 0,
      verificationWallMs: 5,
      reviewWallMs: 0,
      reviewCalls: 0,
      reviewInputBytes: 0,
      provisionalContextTurns: baseline ? 0 : 1,
      inputTokens: 100,
      cachedInputTokens: 50,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      estimatedCostUsd: baseline ? 1 : 1.02,
      cacheHitRate: 0.5,
      subagentTokenShare: 0,
    },
    route: {
      lanePlanHonored: true,
      plannedMaxAgents: 0,
      plannedMaxParallelTools: 0,
      agentsSpawned: 0,
      parallelPeak: 0,
      idleWaitMs: 0,
      laneSelections: 0,
      laneFallbacks: 0,
      programLaneFallbacks: 0,
      fallbackReasons: [],
      programsStarted: 0,
      programsCompleted: 0,
      programsFailed: 0,
      programCalls: 0,
      programCallsAdmitted: 0,
      programCallsDenied: 0,
      ptcFallbackRate: 0,
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
      invisibleSideEffects: 0,
      unclearBackgroundStates: 0,
      reportCompleteness: 1,
      unsupportedClaims: [],
      missingReportMentions: [],
      missingRiskMentions: [],
    },
    eventCount: 4,
  };
}

function fullCohort(): StatisticalTaskDefinition[] {
  return TASK_CATEGORIES.flatMap((category) =>
    Array.from({ length: CATEGORY_TARGETS[category] }, (_value, index) => ({
      id: `${category.replace(/_/gu, "-")}-${index + 1}`,
      category,
      risks: category === "security_safety" ? ["path_traversal" as const] : [],
    })),
  );
}

function makeRepositoryEvidence(
  tasks: readonly StatisticalTaskDefinition[],
  options: { readonly commit?: string; readonly dirty?: boolean } = {},
): BenchmarkRepositoryEvidence {
  const cohortTasks = tasks.map((task) => ({
    id: task.id,
    category: task.category,
    language: "typescript",
    snapshot: `generated/${task.id}`,
    snapshotKind: "generated" as const,
    snapshotDigest: hash(task.id),
    taskDigest: hash(`${task.id}:task`),
  }));
  const cohortBody = {
    schemaVersion: "1.0" as const,
    taskCount: cohortTasks.length,
    categoryTargets: { ...CATEGORY_TARGETS },
    tasks: cohortTasks,
  };
  const openAiNativeBody = {
    taskCount: 1,
    tasks: [{
      id: "on-ptc-aggregation",
      category: "repository_understanding" as const,
      language: "typescript",
      snapshot: "generated/on-ptc-aggregation",
      snapshotKind: "generated" as const,
      snapshotDigest: hash("on-ptc-aggregation"),
      taskDigest: hash("on-ptc-aggregation:task"),
    }],
  };
  const cohort = {
    ...cohortBody,
    generatedAt: "2026-08-12T00:00:00.000Z",
    digest: hash(canonicalValue(cohortBody)),
    openAiNativeCohort: {
      ...openAiNativeBody,
      digest: hash(canonicalValue(openAiNativeBody)),
    },
  };
  const sourceTruth = {
    schemaVersion: "1.0" as const,
    digest: hash("source-truth"),
    fileCount: 100,
    git: {
      commit: options.commit ?? "fixture-commit",
      dirty: options.dirty ?? false,
      dirtyHash: hash(options.dirty ? "dirty" : "clean"),
    },
  };
  const body = { schemaVersion: "1.0" as const, cohort, sourceTruth };
  return {
    ...body,
    digest: `sha256:${hash(canonicalValue(body))}`,
  };
}

function makeArtifact(
  taskCount = RELEASE_MIN_TASKS,
  repetitions = RELEASE_MIN_REPETITIONS,
): Record<string, unknown> {
  const tasks = fullCohort().slice(0, taskCount);
  const repositoryEvidence = makeRepositoryEvidence(tasks);
  const capabilitySnapshot: CapabilitySnapshot = {
    backend: "api",
    provider: "openai",
    model: "gpt-test",
    capturedAt: "2026-08-12T00:00:00.000Z",
    capabilities: {
      websocket: true,
      previousResponse: true,
      parallelToolCalls: true,
    },
    metadata: {
      serviceTier: "standard",
      repositoryEvidenceDigest: repositoryEvidence.digest,
    },
  };
  const capabilityDigest = capabilitySnapshotDigest(capabilitySnapshot);
  const schedule = buildPairedSchedule(
    { baseline: baselineProfile, candidate: candidateProfile },
    { repetitions, order: "abba" },
  );
  const runs = schedule.map((descriptor) => ({
    descriptor,
    profileApplied: true,
    capabilityDigest,
    result: {
      profile: descriptor.profile,
      skipped: [],
      results: tasks.map((task) => ({
        task,
        metrics: makeMetrics(task.id, descriptor.variant),
      })),
    },
  }));
  const statisticalRuns: StatisticalRun[] = runs.map((run) => ({
    variant: run.descriptor.variant,
    repetition: run.descriptor.repetition,
    temperature: run.descriptor.temperature,
    results: run.result.results.map((entry) => ({
      taskId: entry.task.id,
      metrics: entry.metrics,
    })),
  }));
  const statistics = analyzePairedStatistics(tasks, statisticalRuns, {
    target: "capybara_baseline",
    iterations: 100,
    seed: "release-gate-test",
  });
  const baselineMetrics = statisticalRuns
    .filter((run) => run.variant === "baseline")
    .flatMap((run) => run.results.map((result) => result.metrics));
  const candidateMetrics = statisticalRuns
    .filter((run) => run.variant === "candidate")
    .flatMap((run) => run.results.map((result) => result.metrics));
  return {
    comparisonTarget: "capybara_baseline",
    profiles: { baseline: baselineProfile, candidate: candidateProfile },
    repositoryEvidence,
    executionEvidence: {
      baseline: {
        kind: "cbc",
        profile: resolveExecutionProfile(baselineProfile, {
          performanceVariant: "legacy",
          serviceTier: "standard",
        }),
      },
      candidate: {
        kind: "cbc",
        profile: resolveExecutionProfile(candidateProfile, {
          performanceVariant: "optimized",
          serviceTier: "standard",
        }),
      },
    },
    repetitions,
    order: "abba",
    capabilitySnapshot,
    capabilityDigest,
    schedule,
    runs,
    aggregate: {
      baseline: summarize(baselineProfile.id, baselineMetrics),
      candidate: summarize(candidateProfile.id, candidateMetrics),
      statistics,
    },
  };
}

function makeExternalArtifact(
  mode: "backbone_matched" | "product_native",
): Record<string, unknown> {
  const artifact = makeArtifact();
  const primaryCapabilityDigest = artifact.capabilityDigest as string;
  const externalProfile = mode === "product_native"
    ? { ...baselineProfile, id: "claude-native", description: "Claude Code native", model: "claude-native" }
    : baselineProfile;
  const externalCapabilityDigest = mode === "product_native"
    ? `sha256:${hash("claude-native-capability")}`
    : primaryCapabilityDigest;
  const adapter = parseExternalBenchmarkAdapter(
    {
      schemaVersion: "1.1",
      id: `${mode}-adapter`,
      identity: {
        product: mode === "product_native" ? "claude_code" : "codex_cli",
        version: "1.0.0",
        model: externalProfile.model,
        authSurface: mode === "product_native" ? "anthropic-oauth" : "openai-api-key",
        mode,
      },
      program: process.execPath,
      args: ["run", "adapter.ts", "{input}", "{output}"],
      appliedProfile: externalProfile,
      capabilityDigest: externalCapabilityDigest,
      implementationDigest: `sha256:${hash(`${mode}-implementation`)}`,
      passEnvironment: [],
    },
    baselineProfile,
    primaryCapabilityDigest,
    { mode },
  );
  const target = mode === "product_native"
    ? "external_product_native"
    : "external_backbone_matched";
  artifact.comparisonTarget = target;
  artifact.profiles = { baseline: externalProfile, candidate: candidateProfile };
  artifact.executionEvidence = {
    baseline: { kind: "external", adapter },
    candidate: {
      kind: "cbc",
      profile: resolveExecutionProfile(candidateProfile, {
        performanceVariant: "optimized",
        serviceTier: "standard",
      }),
    },
  };
  const runs = (artifact.runs as Array<Record<string, unknown>>).map((run) => {
    const descriptor = run.descriptor as Record<string, unknown>;
    const result = run.result as Record<string, unknown>;
    if (descriptor.variant !== "baseline") return run;
    return {
      ...run,
      capabilityDigest: externalCapabilityDigest,
      descriptor: { ...descriptor, profile: externalProfile },
      result: { ...result, profile: externalProfile },
    };
  });
  artifact.runs = runs;
  const statisticalRuns: StatisticalRun[] = runs.map((run) => {
    const descriptor = run.descriptor as Record<string, unknown>;
    const result = run.result as Record<string, unknown>;
    return {
      variant: descriptor.variant as "baseline" | "candidate",
      repetition: descriptor.repetition as number,
      temperature: descriptor.temperature as "cold" | "warm",
      results: (result.results as Array<Record<string, unknown>>).map((entry) => ({
        taskId: (entry.task as StatisticalTaskDefinition).id,
        metrics: entry.metrics as RunMetrics,
      })),
    };
  });
  const aggregate = artifact.aggregate as Record<string, unknown>;
  aggregate.statistics = analyzePairedStatistics(fullCohort(), statisticalRuns, {
    target,
    iterations: 100,
    seed: "release-gate-test",
  });
  aggregate.baseline = summarize(
    externalProfile.id,
    statisticalRuns
      .filter((run) => run.variant === "baseline")
      .flatMap((run) => run.results.map((result) => result.metrics)),
  );
  return artifact;
}

describe("release evidence inspection", () => {
  test("accepts complete raw evidence and recomputes its statistical gate", () => {
    const artifact = makeArtifact();
    const inspection = inspectReleaseEvidence(artifact, undefined, {
      expectedRepositoryEvidence: artifact.repositoryEvidence as BenchmarkRepositoryEvidence,
    });

    expect(inspection.kind).toBe("paired");
    expect(inspection.errors).toEqual([]);
    expect(inspection.baseline?.profile).toBe("baseline");
    expect(inspection.candidate?.profile).toBe("candidate");
    expect(inspection.statistics?.taskCount).toBe(RELEASE_MIN_TASKS);
    expect(inspection.statisticalGate?.status).toBe("passed");
  });

  test("accepts identity-bound backbone and product-native external evidence", () => {
    const matched = inspectReleaseEvidence(makeExternalArtifact("backbone_matched"));
    expect(matched.errors).toEqual([]);

    const productArtifact = makeExternalArtifact("product_native");
    const product = inspectReleaseEvidence(productArtifact);
    expect(product.errors).toEqual([]);
    const baselineRun = (productArtifact.runs as Array<Record<string, unknown>>)
      .find((run) => (run.descriptor as Record<string, unknown>).variant === "baseline");
    expect(baselineRun?.capabilityDigest).not.toBe(productArtifact.capabilityDigest);
  });

  test("rejects an external adapter identity edited after its manifest digest was bound", () => {
    const artifact = makeExternalArtifact("backbone_matched");
    const execution = artifact.executionEvidence as Record<string, unknown>;
    const baseline = execution.baseline as Record<string, unknown>;
    const adapter = baseline.adapter as Record<string, unknown>;
    adapter.identity = {
      ...(adapter.identity as Record<string, unknown>),
      product: "tampered_product",
    };
    expect(inspectReleaseEvidence(artifact).errors.some((error) =>
      error.includes("manifestDigest")
    )).toBe(true);
  });

  test("rejects the 80-task development floor as release evidence", () => {
    const inspection = inspectReleaseEvidence(makeArtifact(80));
    expect(inspection.errors.some((error) => error.includes("requires 150"))).toBe(true);
  });

  test("rejects fewer than five paired repetitions", () => {
    const inspection = inspectReleaseEvidence(makeArtifact(RELEASE_MIN_TASKS, 4));
    expect(inspection.errors.some((error) => error.includes("requires at least 5"))).toBe(true);
  });

  test("rejects capability snapshots whose content no longer matches the digest", () => {
    const artifact = makeArtifact();
    const snapshot = artifact.capabilitySnapshot as CapabilitySnapshot;
    artifact.capabilitySnapshot = {
      ...snapshot,
      capabilities: { ...snapshot.capabilities, websocket: false },
    };
    const inspection = inspectReleaseEvidence(artifact);
    expect(inspection.errors).toContain(
      "capability digest does not match the attached backend capability snapshot",
    );
  });

  test("rejects skipped tasks and harness errors in any repetition", () => {
    const artifact = makeArtifact();
    const runs = artifact.runs as Array<Record<string, unknown>>;
    const first = runs[0] as Record<string, unknown>;
    const result = first.result as Record<string, unknown>;
    result.skipped = [{ task: "task-1", reason: "invalid" }];
    const results = result.results as Array<Record<string, unknown>>;
    results[results.length - 1] = {
      ...results[results.length - 1],
      harnessError: "boom",
    };

    const inspection = inspectReleaseEvidence(artifact);
    expect(inspection.errors.some((error) => error.includes("skipped task"))).toBe(true);
    expect(inspection.errors.some((error) => error.includes("harness error"))).toBe(true);
  });

  test("rejects a favourable CI edited after the raw runs completed", () => {
    const artifact = makeArtifact();
    const aggregate = artifact.aggregate as Record<string, unknown>;
    const statistics = aggregate.statistics as Record<string, unknown>;
    statistics.medianSpeedup = {
      ...(statistics.medianSpeedup as Record<string, unknown>),
      lower: 99,
    };

    const inspection = inspectReleaseEvidence(artifact);
    expect(inspection.errors).toContain(
      "aggregate.statistics does not match statistics recomputed from raw paired runs",
    );
  });

  test("rejects repository evidence that is missing, dirty, tampered, or not current", () => {
    const missing = makeArtifact();
    delete missing.repositoryEvidence;
    expect(inspectReleaseEvidence(missing).errors)
      .toContain("repositoryEvidence must be a schemaVersion 1.0 object");

    const dirty = makeArtifact();
    const dirtyTasks = fullCohort();
    dirty.repositoryEvidence = makeRepositoryEvidence(dirtyTasks, { dirty: true });
    expect(inspectReleaseEvidence(dirty).errors)
      .toContain("release evidence must be produced from a clean source-truth workspace");

    const tampered = makeArtifact();
    const evidence = tampered.repositoryEvidence as BenchmarkRepositoryEvidence;
    tampered.repositoryEvidence = { ...evidence, digest: `sha256:${"0".repeat(64)}` };
    expect(inspectReleaseEvidence(tampered).errors)
      .toContain("repositoryEvidence.digest does not match its canonical body");

    const mismatch = makeArtifact();
    const actual = mismatch.repositoryEvidence as BenchmarkRepositoryEvidence;
    const expected = makeRepositoryEvidence(fullCohort(), { commit: "different-commit" });
    expect(inspectReleaseEvidence(mismatch, undefined, {
      expectedRepositoryEvidence: expected,
    }).errors).toContain(
      "artifact repository evidence does not match the current canonical cohort and source truth",
    );
    expect(actual.digest).not.toBe(expected.digest);
  });

  test("rejects comparison-target and execution-variant drift", () => {
    const target = makeArtifact();
    target.comparisonTarget = "codex_matched";
    expect(inspectReleaseEvidence(target).errors).toContain(
      "paired artifact comparisonTarget does not match aggregate.statistics.target",
    );

    const execution = makeArtifact();
    const evidence = execution.executionEvidence as Record<string, unknown>;
    const baseline = evidence.baseline as Record<string, unknown>;
    const bound = baseline.profile as Record<string, unknown>;
    baseline.profile = { ...bound, performanceVariant: "optimized" };
    expect(inspectReleaseEvidence(execution).errors).toContain(
      "baseline executionEvidence does not match the legacy Standard product configuration",
    );
  });

  test("rejects incomplete raw metrics instead of throwing during recomputation", () => {
    const artifact = makeArtifact();
    const runs = artifact.runs as Array<Record<string, unknown>>;
    const result = runs[0]!.result as Record<string, unknown>;
    const entries = result.results as Array<Record<string, unknown>>;
    const metrics = entries[0]!.metrics as Record<string, unknown>;
    const ux = metrics.ux as Record<string, unknown>;
    delete ux.missingReportMentions;

    expect(() => inspectReleaseEvidence(artifact)).not.toThrow();
    expect(inspectReleaseEvidence(artifact).errors.some((error) =>
      error.includes("lacks valid task metadata or metrics")
    )).toBe(true);
  });
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(record[key])}`
  ).join(",")}}`;
}
