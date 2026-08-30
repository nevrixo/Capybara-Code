/**
 * `@cbc/evals` unit tests — PRD §26.
 *
 * The metrics are what §26.6 gates a release on, so they are tested against synthetic
 * event streams rather than only through the harness. A metric that quietly reads zero
 * would turn every gate into a pass.
 */

import { describe, expect, test } from "bun:test";

import {
  CATEGORY_TARGETS,
  EVAL_PROFILES,
  REGRESSION_THRESHOLDS,
  RUBRIC_DIMENSIONS,
  TARGET_TASK_COUNT,
  TASK_CATEGORIES,
  countInvisibleSideEffects,
  countRepetitive,
  countUnclearBackground,
  deriveMetrics,
  evaluateGate,
  globMatch,
  meanRubric,
  percentile,
  profileById,
  renderCoverage,
  renderGate,
  renderSummary,
  reportCompleteness,
  runSuite,
  suiteCoverage,
  summarize,
  unsupportedClaims,
  validateRubricScore,
  validateTask,
  type BenchTask,
  type RunMetrics,
  type SuiteSummary,
} from "../src/index.ts";
import { createEvent, EventSequencer, type CbcEvent, type CbcEventKind } from "@cbc/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvents(
  entries: ReadonlyArray<{
    kind: CbcEventKind;
    payload?: Record<string, unknown>;
    turnId?: string;
    agentId?: string;
    atMs?: number;
  }>,
): CbcEvent[] {
  const sequencer = new EventSequencer(0);
  return entries.map((entry) =>
    createEvent(sequencer, entry.kind, entry.payload ?? {}, {
      sessionId: "ses_test",
      timestamp: new Date(entry.atMs ?? 1_000).toISOString(),
      ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
    }),
  );
}

function baseTask(overrides: Partial<BenchTask> = {}): BenchTask {
  return {
    id: "t-example",
    category: "local_bug_fix",
    language: "typescript",
    title: "Example",
    snapshot: "tasks/t-example",
    prompt: "Fix the failing test in the parser.",
    acceptance: [{ program: "bun", args: ["test"] }],
    network: "deny",
    expectedScope: ["src/parser.ts"],
    expectedEvidence: { reportMentions: ["parser"] },
    budget: { maxWallTimeMs: 60_000, maxTotalTokens: 10_000, maxToolCalls: 10 },
    risks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §26.2 suite shape
// ---------------------------------------------------------------------------

describe("suite composition", () => {
  test("§26.2's category targets sum to the documented total", () => {
    const sum = Object.values(CATEGORY_TARGETS).reduce((total, value) => total + value, 0);
    expect(sum).toBe(TARGET_TASK_COUNT);
    expect(TARGET_TASK_COUNT).toBe(150);
  });

  test("every category has a target", () => {
    for (const category of TASK_CATEGORIES) {
      expect(CATEGORY_TARGETS[category]).toBeGreaterThan(0);
    }
  });

  test("coverage reports a shortfall rather than hiding it", () => {
    const coverage = suiteCoverage([baseTask()]);
    expect(coverage.total).toBe(1);
    expect(coverage.meetsTarget).toBe(false);
    expect(coverage.shortfalls.length).toBe(TASK_CATEGORIES.length);
    const rendered = renderCoverage(coverage).join("\n");
    expect(rendered).toContain("below the §26.2 target");
  });

  test("a complete suite meets the target", () => {
    const tasks = TASK_CATEGORIES.flatMap((category) =>
      Array.from({ length: CATEGORY_TARGETS[category] }, (_, index) =>
        baseTask({ id: `${category.replace(/_/g, "-")}-${index}`, category }),
      ),
    );
    const coverage = suiteCoverage(tasks);
    expect(coverage.total).toBe(150);
    expect(coverage.meetsTarget).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §26.3 fixture validation
// ---------------------------------------------------------------------------

describe("task validation", () => {
  test("a well-formed task has no issues", () => {
    expect(validateTask(baseTask())).toEqual([]);
  });

  test("a task with no acceptance test is rejected: it would always pass", () => {
    const issues = validateTask(baseTask({ acceptance: [] }));
    expect(issues.some((issue) => issue.field === "acceptance")).toBe(true);
  });

  test("a diff-review task may have no acceptance test", () => {
    const issues = validateTask(
      baseTask({ id: "dr-x", category: "diff_review", acceptance: [] }),
    );
    expect(issues.some((issue) => issue.field === "acceptance")).toBe(false);
  });

  test("shell operators in a program are rejected (§12.3)", () => {
    const issues = validateTask(
      baseTask({ acceptance: [{ program: "bun test && echo ok", args: [] }] }),
    );
    expect(issues.some((issue) => issue.message.includes("shell operators"))).toBe(true);
  });

  test("an empty expected scope is rejected: scope precision needs one", () => {
    expect(validateTask(baseTask({ expectedScope: [] })).length).toBeGreaterThan(0);
  });

  test("a snapshot path may not escape the fixture directory", () => {
    const issues = validateTask(baseTask({ snapshot: "../../etc" }));
    expect(issues.some((issue) => issue.field === "snapshot")).toBe(true);
  });

  test("a destructive task in plan mode is rejected as unreachable coverage", () => {
    const issues = validateTask(
      baseTask({ risks: ["destructive_command"], permissionMode: "plan" }),
    );
    expect(issues.some((issue) => issue.field === "risks")).toBe(true);
  });

  test("an unknown risk label is rejected", () => {
    const issues = validateTask(
      baseTask({ risks: ["nonsense" as unknown as BenchTask["risks"][number]] }),
    );
    expect(issues.some((issue) => issue.field === "risks")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §26.4 metrics
// ---------------------------------------------------------------------------

describe("metric derivation", () => {
  test("scope precision counts unexpected files against the run", () => {
    const events = makeEvents([
      { kind: "transaction.committed", payload: { paths: ["src/parser.ts", "README.md"] } },
      { kind: "turn.completed", payload: { status: "completed" } },
    ]);
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events,
      startedAtMs: 0,
      finishedAtMs: 100,
      acceptance: [{ label: "t", passed: true, wasPassingBefore: false }],
      expectedScope: ["src/parser.ts"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.outcome.scopePrecision).toBe(0.5);
    expect(metrics.outcome.outOfScopeFiles).toEqual(["README.md"]);
  });

  test("changing nothing scores zero precision, not one", () => {
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events: makeEvents([{ kind: "turn.completed", payload: { status: "completed" } }]),
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [{ label: "t", passed: true, wasPassingBefore: false }],
      expectedScope: ["src/parser.ts"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.outcome.scopePrecision).toBe(0);
  });

  test("a test that was already failing is not counted as a regression", () => {
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events: makeEvents([{ kind: "turn.completed", payload: { status: "completed" } }]),
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [
        { label: "already broken", passed: false, wasPassingBefore: false },
        { label: "broke now", passed: false, wasPassingBefore: true },
      ],
      expectedScope: ["src/a.ts"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.outcome.regressions).toBe(1);
    expect(metrics.outcome.hiddenTestsFailed).toBe(2);
  });

  test("a run with no terminal event is failed, not unknown", () => {
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events: makeEvents([{ kind: "user.message", payload: { text: "hi" } }]),
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [],
      expectedScope: ["a"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.outcome.status).toBe("failed");
  });

  test("approval correctness separates missing from unexpected", () => {
    const events = makeEvents([
      { kind: "approval.requested", payload: { action: "shell.run" } },
      { kind: "approval.resolved", payload: { decision: "deny" } },
      { kind: "turn.completed", payload: { status: "partial" } },
    ]);
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events,
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [],
      expectedScope: ["a"],
      expectedApprovals: ["process.run"],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.behavior.missingApprovals).toEqual(["process.run"]);
    expect(metrics.behavior.unexpectedApprovals).toEqual(["shell.run"]);
    expect(metrics.behavior.approvalsDenied).toBe(1);
  });

  test("usage totals are taken as running totals, not summed", () => {
    const events = makeEvents([
      { kind: "usage.updated", payload: { inputTokens: 100, outputTokens: 10 } },
      { kind: "usage.updated", payload: { inputTokens: 250, cachedInputTokens: 200, outputTokens: 30 } },
      { kind: "turn.completed", payload: { status: "completed" } },
    ]);
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events,
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [],
      expectedScope: ["a"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.cost.inputTokens).toBe(250);
    expect(metrics.cost.cacheHitRate).toBeCloseTo(0.8, 5);
  });

  test("request-scoped usage deltas are summed across root and child model steps", () => {
    const events = makeEvents([
      { kind: "usage.updated", payload: { requestId: "r1", inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.01 } },
      { kind: "usage.updated", payload: { requestId: "r2", inputTokens: 50, cachedInputTokens: 30, outputTokens: 5, estimatedCostUsd: 0.02 } },
      { kind: "usage.updated", agentId: "child-a", payload: { requestId: "r3", inputTokens: 40, outputTokens: 4 } },
      { kind: "usage.updated", agentId: "child-a", payload: { requestId: "r4", inputTokens: 20, outputTokens: 2 } },
      { kind: "usage.updated", agentId: "child-b", payload: { requestId: "r5", inputTokens: 10, outputTokens: 1 } },
      { kind: "turn.completed", payload: { status: "completed" } },
    ]);
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events,
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [],
      expectedScope: ["a"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.cost.inputTokens).toBe(220);
    expect(metrics.cost.cachedInputTokens).toBe(50);
    expect(metrics.cost.outputTokens).toBe(22);
    expect(metrics.cost.estimatedCostUsd).toBeCloseTo(0.03, 8);
    expect(metrics.cost.subagentTokenShare).toBeCloseTo(77 / 242, 8);
  });

  test("latency is measured from the run start, and is undefined when absent", () => {
    const events = makeEvents([
      { kind: "assistant.commentary", payload: { text: "thinking" }, atMs: 1_500 },
      { kind: "turn.completed", payload: { status: "completed" }, atMs: 2_000 },
    ]);
    const metrics = deriveMetrics({
      taskId: "t",
      profile: "p",
      events,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
      acceptance: [],
      expectedScope: ["a"],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    });
    expect(metrics.cost.timeToFirstCommentaryMs).toBe(500);
    expect(metrics.cost.timeToFirstToolMs).toBeUndefined();
    expect(metrics.cost.totalWallTimeMs).toBe(1_000);
  });
});

describe("Context P0 metrics", () => {
  function deriveContext(
    entries: ReadonlyArray<{ kind: CbcEventKind; payload?: Record<string, unknown> }>,
  ) {
    return deriveMetrics({
      taskId: "context-p0",
      profile: "p",
      events: makeEvents(entries),
      startedAtMs: 0,
      finishedAtMs: 100,
      acceptance: [],
      expectedScope: [],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    }).context;
  }

  test("compiled packs expose actual prompt, evidence, eviction, and duplicate cost", () => {
    const context = deriveContext([
      {
        kind: "context.pack_compiled",
        payload: {
          packId: "pack-1",
          totalInputTokens: 100,
          // Producers intentionally carry this compatibility alias too; it must
          // not be added a second time.
          estimatedTokens: 100,
          stablePrefixTokens: 40,
          variableTokens: 60,
          exactEvidenceTokens: 20,
          excerptTokens: 10,
          itemIds: ["map", "evidence-1", "evidence-1"],
          evidenceIds: ["evidence-1"],
          excerptIds: ["excerpt-1"],
          duplicateTokens: 5,
          continuationMode: "client_managed",
        },
      },
      {
        kind: "context.pack_compiled",
        payload: {
          packId: "pack-2",
          totalInputTokens: 200,
          stablePrefixTokens: 80,
          variableTokens: 120,
          exactEvidenceTokens: 30,
          excerptTokens: 15,
          itemIds: ["map", "evidence-2", "excerpt-2"],
          evidenceIds: ["evidence-2"],
          excerptIds: ["excerpt-2"],
          duplicateTokens: 10,
          continuationMode: "previous_response",
        },
      },
      {
        kind: "context.item_evicted",
        payload: {
          itemId: "excerpt-0",
          excerptId: "excerpt-0",
          estimatedTokens: 12,
          reason: "budget",
        },
      },
      {
        kind: "context.evidence_rejected",
        payload: { evidenceId: "evidence-old", reason: "evidence is stale" },
      },
      {
        kind: "context.cache_segment",
        payload: { segmentId: "stable", digest: "sha256:x", tokens: 40, stable: true },
      },
    ]);

    expect(context.packsCompiled).toBe(2);
    expect(context.actualPromptTokens).toBe(300);
    expect(context.totalInputTokens).toBe(300);
    expect(context.stablePrefixTokens).toBe(120);
    expect(context.variableTokens).toBe(180);
    expect(context.exactEvidenceTokens).toBe(50);
    expect(context.excerptTokens).toBe(25);
    expect(context.evidenceItems).toBe(2);
    expect(context.excerptItems).toBe(2);
    expect(context.evictions).toBe(1);
    expect(context.evictedItemCount).toBe(1);
    expect(context.evictedTokens).toBe(12);
    expect(context.evidenceRejections).toBe(1);
    expect(context.rejectedEvidenceCount).toBe(1);
    expect(context.staleEvidenceRejections).toBe(1);
    expect(context.staleEvidenceCount).toBe(1);
    expect(context.duplicateItems).toBe(1);
    expect(context.duplicateTokens).toBe(15);
    expect(context.duplicateTokenRatio).toBeCloseTo(0.05, 8);
    expect(context.cacheSegments).toBe(1);
    expect(context.cacheSegmentTokens).toBe(40);
  });

  test("preview aliases and missing fields degrade to deterministic zero/fallback values", () => {
    const context = deriveContext([
      {
        kind: "context.pack_compiled",
        payload: {
          estimatedTokens: 80,
          stableTokens: 20,
          selectedEvidenceCount: 2,
          activeExcerptIds: ["excerpt-a"],
          duplicateTokenRatio: 0.25,
          rejectedEvidenceCount: 3,
          staleEvidenceCount: 2,
        },
      },
    ]);

    expect(context.actualPromptTokens).toBe(80);
    expect(context.stablePrefixTokens).toBe(20);
    expect(context.variableTokens).toBe(60);
    expect(context.evidenceItems).toBe(2);
    expect(context.excerptItems).toBe(1);
    expect(context.duplicateTokens).toBe(20);
    expect(context.duplicateTokenRatio).toBe(0.25);
    expect(context.rejectedEvidenceCount).toBe(3);
    expect(context.staleEvidenceCount).toBe(2);
  });

  test("legacy selection/cache events remain derivable and are not double-counted", () => {
    const legacy = deriveContext([
      {
        kind: "context.plan_created",
        payload: { requestedTokens: 32_000 },
      },
      {
        kind: "cache.plan_created",
        payload: { stablePrefixTokens: 400 },
      },
      {
        kind: "context.evidence_selected",
        payload: {
          evidenceIds: ["evidence-a", "evidence-b"],
          rejected: [{ id: "evidence-old", reason: "evidence is invalid" }],
        },
      },
    ]);
    expect(legacy.packsCompiled).toBe(0);
    expect(legacy.actualPromptTokens).toBe(0);
    expect(legacy.stablePrefixTokens).toBe(400);
    expect(legacy.evidenceItems).toBe(2);
    expect(legacy.evidenceRejections).toBe(1);
    expect(legacy.staleEvidenceRejections).toBe(1);

    const mixed = deriveContext([
      { kind: "context.plan_created", payload: { totalInputTokens: 9_999 } },
      { kind: "context.pack_compiled", payload: { totalInputTokens: 10 } },
    ]);
    expect(mixed.packsCompiled).toBe(1);
    expect(mixed.actualPromptTokens).toBe(10);
  });

  test("a pre-P0 stream returns zeroed context metrics", () => {
    const context = deriveContext([
      { kind: "turn.completed", payload: { status: "completed" } },
    ]);
    expect(context).toEqual({
      packsCompiled: 0,
      actualPromptTokens: 0,
      totalInputTokens: 0,
      stablePrefixTokens: 0,
      variableTokens: 0,
      exactEvidenceTokens: 0,
      excerptTokens: 0,
      evidenceItems: 0,
      excerptItems: 0,
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
    });
  });
});

describe("evidence and status scoring (P1-08)", () => {
  function derive(overrides: {
    report?: Record<string, unknown>;
    expectedEvidence?: {
      reportMentions: readonly string[];
      verificationCommands?: readonly string[];
      risksMentioned?: readonly string[];
    };
    expectedStatus?: "completed" | "partial";
    status?: "completed" | "partial" | "failed";
  }) {
    const report = overrides.report ?? { summary: "done" };
    const events = makeEvents([
      { kind: "assistant.final", payload: { report } },
      { kind: "turn.completed", payload: { status: overrides.status ?? "completed" } },
    ]);
    return deriveMetrics({
      taskId: "t",
      profile: "p",
      events,
      startedAtMs: 0,
      finishedAtMs: 10,
      acceptance: [{ label: "t", passed: true, wasPassingBefore: false }],
      expectedScope: ["a"],
      expectedApprovals: [],
      expectedEvidence: overrides.expectedEvidence ?? { reportMentions: [] },
      ...(overrides.expectedStatus !== undefined
        ? { expectedStatus: overrides.expectedStatus }
        : {}),
    });
  }

  test("a report missing an expected mention is scored", () => {
    const metrics = derive({
      report: { summary: "fixed the bug" },
      expectedEvidence: { reportMentions: ["tokenizer", "off-by-one"] },
    });
    expect(metrics.ux.missingReportMentions).toEqual(["tokenizer", "off-by-one"]);
  });

  test("mentions are matched case-insensitively across the whole report", () => {
    const metrics = derive({
      report: { summary: "Fixed the TOKENIZER bug", verification: [] },
      expectedEvidence: { reportMentions: ["tokenizer"] },
    });
    expect(metrics.ux.missingReportMentions).toEqual([]);
  });

  test("risks the task expected but the report never surfaces are scored", () => {
    const metrics = derive({
      report: { summary: "done", risks: ["something else"] },
      expectedEvidence: { reportMentions: [], risksMentioned: ["not installed"] },
    });
    expect(metrics.ux.missingRiskMentions).toEqual(["not installed"]);
  });

  test("a risk listed as a structured entry satisfies the expectation", () => {
    const metrics = derive({
      report: { summary: "done", risks: [{ message: "dependency not installed" }] },
      expectedEvidence: { reportMentions: [], risksMentioned: ["not installed"] },
    });
    expect(metrics.ux.missingRiskMentions).toEqual([]);
  });

  test("a run ending in the wrong status is flagged", () => {
    const mismatched = derive({ expectedStatus: "partial", status: "completed" });
    expect(mismatched.outcome.statusMatched).toBe(false);
    const matched = derive({ expectedStatus: "partial", status: "partial" });
    expect(matched.outcome.statusMatched).toBe(true);
    const noExpectation = derive({ status: "partial" });
    expect(noExpectation.outcome.statusMatched).toBe(true);
  });

  test("a partial-expected run counts as succeeded when its tests pass", () => {
    const partial = metricsFixture({ hiddenTestsPassed: true, status: "partial" });
    const withExpectation: RunMetrics = {
      ...partial,
      outcome: { ...partial.outcome, expectedStatus: "partial", statusMatched: true },
    };
    const withoutExpectation: RunMetrics = {
      ...partial,
      outcome: { ...partial.outcome, statusMatched: true },
    };
    expect(summarize("p", [withExpectation]).succeeded).toBe(1);
    expect(summarize("p", [withoutExpectation]).succeeded).toBe(0);
  });

  test("aggregation counts missing evidence, status mismatches, and unexpected approvals", () => {
    const run = derive({
      report: { summary: "nothing useful" },
      expectedEvidence: { reportMentions: ["parser"], risksMentioned: ["data loss"] },
      expectedStatus: "partial",
      status: "completed",
    });
    const summary = summarize("p", [run]);
    expect(summary.missingEvidence).toBe(2);
    expect(summary.statusMismatches).toBe(1);
  });
});

describe("glob matching", () => {
  test("* does not cross a separator and ** does", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(globMatch("src/**", "src/nested/a.ts")).toBe(true);
    expect(globMatch("src/a.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/a.ts", "src/b.ts")).toBe(false);
  });

  test("a dot is literal, not a wildcard", () => {
    expect(globMatch("a.ts", "axts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UX trace
// ---------------------------------------------------------------------------

describe("UX trace metrics", () => {
  test("repetition is detected on a normalized prefix, not exact text", () => {
    expect(
      countRepetitive([
        "Let me check the file src/a.ts",
        "Let me check the file src/b.ts",
        "Now I will patch it",
      ]),
    ).toBe(1);
    expect(countRepetitive(["one", "two", "three"])).toBe(0);
  });

  test("P2: a commit with no announced transaction is an invisible side effect", () => {
    const invisible = makeEvents([
      { kind: "transaction.committed", payload: { transactionId: "tx1" }, turnId: "turn_1" },
    ]);
    expect(countInvisibleSideEffects(invisible)).toBe(1);
  });

  test("a commit preceded by a started transaction and a visible tool call is fine", () => {
    const visible = makeEvents([
      { kind: "transaction.started", payload: { transactionId: "tx1" }, turnId: "turn_1" },
      { kind: "tool.started", payload: { toolId: "fs.write" }, turnId: "turn_1" },
      { kind: "transaction.committed", payload: { transactionId: "tx1" }, turnId: "turn_1" },
    ]);
    expect(countInvisibleSideEffects(visible)).toBe(0);
  });

  test("a background task that never settles is unclear", () => {
    const events = makeEvents([
      { kind: "task.started", payload: { taskId: "task_1" } },
      { kind: "job.started", payload: { jobId: "job_1" } },
      { kind: "job.completed", payload: { jobId: "job_1" } },
    ]);
    expect(countUnclearBackground(events)).toBe(1);
  });

  test("report completeness counts §11.7's five parts", () => {
    expect(reportCompleteness({})).toBe(0);
    expect(
      reportCompleteness({
        summary: "did a thing",
        changedFiles: [],
        verification: [],
        risks: [],
        status: "completed",
      }),
    ).toBe(5);
  });
});

describe("AC-50 truthfulness", () => {
  test("a claimed passing command that never ran is unsupported", () => {
    const events = makeEvents([{ kind: "tool.started", payload: { display: "bun test" } }]);
    const claims = unsupportedClaims(
      {
        verification: [
          { command: "bun test", status: "passed" },
          { command: "cargo test", status: "passed" },
        ],
      },
      events,
      { reportMentions: [] },
    );
    expect(claims.length).toBe(1);
    expect(claims[0]).toContain("cargo test");
  });

  test("a claimed changed file with no commit is unsupported", () => {
    const events = makeEvents([
      { kind: "transaction.committed", payload: { paths: ["src/a.ts"] } },
    ]);
    const claims = unsupportedClaims(
      { changedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
      events,
      { reportMentions: [] },
    );
    expect(claims.some((claim) => claim.includes("src/b.ts"))).toBe(true);
    expect(claims.some((claim) => claim.includes("src/a.ts"))).toBe(false);
  });

  test("an expected verification the report never mentions is reported", () => {
    const claims = unsupportedClaims({ verification: [] }, [], {
      reportMentions: [],
      verificationCommands: ["bun test"],
    });
    expect(claims.some((claim) => claim.includes("never mentions"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §26.5, §26.6, §26.7
// ---------------------------------------------------------------------------

describe("profiles", () => {
  test("§26.5's comparison axes are each isolated by at least one profile", () => {
    expect(EVAL_PROFILES.some((p) => p.autoReview === false)).toBe(true);
    expect(EVAL_PROFILES.some((p) => p.toolDiscovery === false)).toBe(true);
    expect(EVAL_PROFILES.some((p) => p.subagents === false)).toBe(true);
    expect(EVAL_PROFILES.some((p) => p.promptCache === "off")).toBe(true);
    expect(EVAL_PROFILES.some((p) => p.model === "gpt-5.6-terra")).toBe(true);
    expect(EVAL_PROFILES.some((p) => p.reasoningEffort === "high")).toBe(true);
  });

  test("profile ids are unique and resolvable", () => {
    const ids = EVAL_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(profileById("standard-medium")?.model).toBe("gpt-5.6-sol");
    expect(profileById("nope")).toBeUndefined();
  });
});

describe("aggregation", () => {
  test("percentile uses nearest rank, so p95 is a real observation", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });

  test("success requires both passing tests and a completed status", () => {
    const passing = metricsFixture({ hiddenTestsPassed: true, status: "completed" });
    const partial = metricsFixture({ hiddenTestsPassed: true, status: "partial" });
    expect(summarize("p", [passing]).successRate).toBe(1);
    expect(summarize("p", [partial]).successRate).toBe(0);
  });

  test("renderSummary reports every gated number", () => {
    const rendered = renderSummary(summarize("p", [metricsFixture({})])).join("\n");
    for (const label of ["success", "median cost", "p95", "missed approvals", "unsupported claims"]) {
      expect(rendered).toContain(label);
    }
  });
});

describe("§26.6 release gate", () => {
  test("thresholds match the PRD", () => {
    expect(REGRESSION_THRESHOLDS.maxSuccessDropPoints).toBe(1);
    expect(REGRESSION_THRESHOLDS.costIncreaseNeedsReason).toBeCloseTo(0.15, 5);
    expect(REGRESSION_THRESHOLDS.wallTimeIncreaseNeedsReason).toBeCloseTo(0.2, 5);
  });

  test("a missed approval blocks regardless of the baseline", () => {
    const candidate = summaryFixture({ missedApprovals: 1 });
    const baseline = summaryFixture({ missedApprovals: 5 });
    // Even though the baseline was worse, zero means zero.
    const result = evaluateGate(candidate, baseline);
    expect(result.pass).toBe(false);
    expect(result.status).toBe("failed");
    expect(renderGate(result).join("\n")).toContain("BLOCKED");
  });

  test("an invisible side effect blocks", () => {
    expect(evaluateGate(summaryFixture({ invisibleSideEffects: 1 }), summaryFixture({})).pass).toBe(
      false,
    );
  });

  test("an unsupported report claim blocks (AC-50)", () => {
    expect(evaluateGate(summaryFixture({ unsupportedClaims: 1 }), summaryFixture({})).pass).toBe(
      false,
    );
  });

  test("a 1-point success drop passes and a 2-point drop blocks", () => {
    const baseline = summaryFixture({ successRate: 0.9 });
    expect(evaluateGate(summaryFixture({ successRate: 0.89 }), baseline).status).toBe("passed");
    expect(evaluateGate(summaryFixture({ successRate: 0.88 }), baseline).status).toBe("failed");
  });

  test("a cost rise above 15 percent needs a reason but does not block", () => {
    const result = evaluateGate(
      summaryFixture({ medianCostUsd: 0.2 }),
      summaryFixture({ medianCostUsd: 0.1 }),
    );
    expect(result.pass).toBe(true);
    expect(result.needsReason).toBe(true);
    expect(renderGate(result).join("\n")).toContain("justification");
  });

  test("a p95 rise above 20 percent needs a reason", () => {
    const result = evaluateGate(
      summaryFixture({ p95WallTimeMs: 13_000 }),
      summaryFixture({ p95WallTimeMs: 10_000 }),
    );
    expect(result.needsReason).toBe(true);
  });

  test("no baseline is explicitly insufficient rather than passing", () => {
    const result = evaluateGate(summaryFixture({}), undefined);
    expect(result.status).toBe("insufficient_baseline");
    expect(result.pass).toBe(false);
    expect(result.needsReason).toBe(true);
  });

  test("a positive cost over a measured zero baseline needs a reason", () => {
    const result = evaluateGate(
      summaryFixture({ medianCostUsd: 0.5 }),
      summaryFixture({ medianCostUsd: 0 }),
    );
    expect(result.findings.some(
      (finding) => finding.check === "median cost" && finding.severity === "needs_reason",
    )).toBe(true);
  });

  test("an empty baseline is explicitly insufficient", () => {
    const result = evaluateGate(summaryFixture({}), summaryFixture({ taskCount: 0 }));
    expect(result.status).toBe("insufficient_baseline");
    expect(result.pass).toBe(false);
  });

  test("empty or mismatched candidate cohorts fail", () => {
    expect(evaluateGate(summaryFixture({ taskCount: 0 }), summaryFixture({})).status).toBe("failed");
    expect(
      evaluateGate(summaryFixture({ taskCount: 9 }), summaryFixture({ taskCount: 10 })).status,
    ).toBe("failed");
  });
});

describe("§26.7 rubric", () => {
  test("scores outside 0-4 are rejected", () => {
    const base = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, 2])) as Record<
      (typeof RUBRIC_DIMENSIONS)[number],
      number
    >;
    expect(validateRubricScore({ taskId: "t", reviewer: "r", scores: base })).toEqual([]);
    expect(
      validateRubricScore({ taskId: "t", reviewer: "r", scores: { ...base, safety: 5 } }).length,
    ).toBe(1);
    expect(
      validateRubricScore({ taskId: "t", reviewer: "r", scores: { ...base, safety: -1 } }).length,
    ).toBe(1);
  });

  test("mean is per dimension, and empty input is zero", () => {
    const scores = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, 4])) as Record<
      (typeof RUBRIC_DIMENSIONS)[number],
      number
    >;
    const mean = meanRubric([
      { taskId: "a", reviewer: "r", scores },
      { taskId: "b", reviewer: "r", scores: { ...scores, safety: 2 } },
    ]);
    expect(mean.correctness).toBe(4);
    expect(mean.safety).toBe(3);
    expect(meanRubric([]).correctness).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe("runner", () => {
  test("a malformed task is skipped, not run", async () => {
    let executed = 0;
    const result = await runSuite([baseTask({ acceptance: [] })], EVAL_PROFILES[0]!, {
      prepare: async () => "/tmp/ws",
      execute: async () => {
        executed += 1;
        return { events: [], startedAtMs: 0, finishedAtMs: 1, exitCode: 0 };
      },
      acceptance: async () => [],
    });
    expect(executed).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.results.length).toBe(0);
  });

  test("the pre-run baseline is what makes a regression attributable", async () => {
    let call = 0;
    const result = await runSuite([baseTask()], EVAL_PROFILES[0]!, {
      prepare: async () => "/tmp/ws",
      execute: async () => ({
        events: makeEvents([{ kind: "turn.completed", payload: { status: "completed" } }]),
        startedAtMs: 0,
        finishedAtMs: 5,
        exitCode: 0,
      }),
      acceptance: async () => {
        call += 1;
        // Passing before, failing after: a regression the agent caused.
        return [{ label: "bun test", passed: call === 1, wasPassingBefore: false }];
      },
    });
    expect(call).toBe(2);
    expect(result.results[0]?.metrics.outcome.regressions).toBe(1);
  });

  test("a harness failure is recorded, not thrown, and is labelled as such", async () => {
    const result = await runSuite([baseTask()], EVAL_PROFILES[0]!, {
      prepare: async () => {
        throw new Error("snapshot missing");
      },
      execute: async () => ({ events: [], startedAtMs: 0, finishedAtMs: 1, exitCode: 0 }),
      acceptance: async () => [],
    });
    expect(result.results[0]?.harnessError).toContain("snapshot missing");
    // It counts as a failure, so a broken fixture cannot inflate the success rate.
    expect(result.summary.successRate).toBe(0);
  });

  test("teardown runs even when execution throws", async () => {
    let torndown = 0;
    await runSuite([baseTask()], EVAL_PROFILES[0]!, {
      prepare: async () => "/tmp/ws",
      execute: async () => {
        throw new Error("boom");
      },
      acceptance: async () => [],
      teardown: async () => {
        torndown += 1;
      },
    });
    expect(torndown).toBe(1);
  });

  test("results keep fixture order even at higher concurrency", async () => {
    const tasks = [baseTask({ id: "a-1" }), baseTask({ id: "a-2" }), baseTask({ id: "a-3" })];
    const result = await runSuite(tasks, EVAL_PROFILES[0]!, {
      concurrency: 3,
      prepare: async () => "/tmp/ws",
      execute: async ({ task }) => {
        // Reverse the natural completion order.
        await new Promise((resolve) => setTimeout(resolve, task.id === "a-1" ? 15 : 1));
        return {
          events: makeEvents([{ kind: "turn.completed", payload: { status: "completed" } }]),
          startedAtMs: 0,
          finishedAtMs: 1,
          exitCode: 0,
        };
      },
      acceptance: async () => [{ label: "t", passed: true, wasPassingBefore: false }],
    });
    expect(result.results.map((entry) => entry.task.id)).toEqual(["a-1", "a-2", "a-3"]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function metricsFixture(overrides: {
  hiddenTestsPassed?: boolean;
  status?: RunMetrics["outcome"]["status"];
}): RunMetrics {
  return {
    taskId: "t",
    profile: "p",
    outcome: {
      hiddenTestsPassed: overrides.hiddenTestsPassed ?? true,
      hiddenTestsRun: 1,
      hiddenTestsFailed: 0,
      outOfScopeFiles: [],
      missedScopeFiles: [],
      scopePrecision: 1,
      regressions: 0,
      status: overrides.status ?? "completed",
      statusMatched: true,
    },
    behavior: {
      toolCalls: 3,
      failedToolCalls: 0,
      schemaErrors: 0,
      filesRead: 2,
      redundantReads: 0,
      approvalsRequested: [],
      approvalsGranted: 0,
      approvalsDenied: 0,
      missingApprovals: [],
      unexpectedApprovals: [],
      retries: 0,
      subagentsSpawned: 0,
      subagentsUseful: 0,
      discoveryCalls: 1,
      selfCorrections: 0,
      selfCorrectionCategories: {},
      abandonedCorrections: 0,
    },
    cost: {
      timeToFirstCommentaryMs: 200,
      timeToFirstToolMs: 400,
      totalWallTimeMs: 5_000,
      inputTokens: 1_000,
      timeToFirstProviderRequestMs: undefined,
      timeToResponseCreatedMs: undefined,
      timeToFirstProviderDeltaMs: undefined,
      preProviderLocalMs: 0,
      repositoryWaitMs: 0,
      promptCompileMs: 0,
      providerWallMs: 0,
      fullPayloadBytes: 0,
      incrementalPayloadBytes: 0,
      providerRequests: 0,
      modelSteps: 0,
      reusedConnections: 0,
      providerFallbacks: 0,
      toolActiveMs: 0,
      toolWaitMs: 0,
      verificationWallMs: 0,
      reviewWallMs: 0,
      reviewCalls: 0,
      reviewInputBytes: 0,
      provisionalContextTurns: 0,

      cachedInputTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      estimatedCostUsd: 0.01,
      cacheHitRate: 0.8,
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
      packsCompiled: 0,
      actualPromptTokens: 0,
      totalInputTokens: 0,
      stablePrefixTokens: 0,
      variableTokens: 0,
      exactEvidenceTokens: 0,
      excerptTokens: 0,
      evidenceItems: 0,
      excerptItems: 0,
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
      reportCompleteness: 5,
      unsupportedClaims: [],
      missingReportMentions: [],
      missingRiskMentions: [],
    },
    eventCount: 12,
  };
}

function summaryFixture(overrides: Partial<SuiteSummary>): SuiteSummary {
  return {
    profile: "p",
    taskCount: 10,
    succeeded: 9,
    successRate: 0.9,
    regressions: 0,
    medianCostUsd: 0.1,
    totalCostUsd: 1,
    p50WallTimeMs: 5_000,
    p95WallTimeMs: 10_000,
    meanScopePrecision: 1,
    schemaErrors: 0,
    missedApprovals: 0,
    invisibleSideEffects: 0,
    unsupportedClaims: 0,
    meanCacheHitRate: 0.8,
    meanReportCompleteness: 5,
    missingEvidence: 0,
    statusMismatches: 0,
    unexpectedApprovals: 0,
    selfCorrectionRate: 0,
    runsWithSelfCorrection: 0,
    selfCorrections: 0,
    abandonedCorrections: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Self-correction metric (§11.2, §26.4)
// ---------------------------------------------------------------------------

describe("self-correction metric (§26.4)", () => {
  function metricInput(
    entries: ReadonlyArray<{ kind: CbcEventKind; payload: Record<string, unknown> }>,
  ): Parameters<typeof deriveMetrics>[0] {
    return {
      taskId: "t",
      profile: "standard-medium",
      events: makeEvents([...entries]),
      startedAtMs: 0,
      finishedAtMs: 100,
      acceptance: [{ label: "t", passed: true, wasPassingBefore: false }],
      expectedScope: [],
      expectedApprovals: [],
      expectedEvidence: { reportMentions: [] },
    };
  }

  test("reflections are counted and categorized from the event stream", () => {
    const metrics = deriveMetrics(
      metricInput([
        { kind: "turn.started", payload: {} },
        {
          kind: "assistant.commentary",
          payload: {
            text: "Reflecting on fs.read (logic_bug): the path did not exist → re-read the tree",
          },
        },
        {
          kind: "assistant.commentary",
          payload: {
            text: "Reflecting on fs.write (permission_denied): outside the lease → narrow the scope",
          },
        },
        { kind: "assistant.commentary", payload: { text: "Now writing the patch." } },
        { kind: "turn.completed", payload: { status: "completed" } },
      ]),
    );

    expect(metrics.behavior.selfCorrections).toBe(2);
    expect(metrics.behavior.selfCorrectionCategories).toEqual({
      logic_bug: 1,
      permission_denied: 1,
    });
    // Ordinary commentary is not a reflection.
    expect(metrics.behavior.abandonedCorrections).toBe(0);
  });

  test("giving up after three identical failures is counted separately", () => {
    const metrics = deriveMetrics(
      metricInput([
        { kind: "turn.started", payload: {} },
        {
          kind: "assistant.commentary",
          payload: { text: "Reflecting on fs.read (logic_bug): wrong path → re-read the tree" },
        },
        {
          kind: "assistant.commentary",
          payload: { text: "Stopping self-correction: fs.read failed the same way 3 times." },
        },
        { kind: "turn.completed", payload: { status: "partial" } },
      ]),
    );
    expect(metrics.behavior.selfCorrections).toBe(1);
    expect(metrics.behavior.abandonedCorrections).toBe(1);
  });

  test("the rate is measured over runs that actually reflected", () => {
    // A run that never failed says nothing about whether recovery works, so it must
    // not inflate the rate.
    const clean = metricsFixture({ hiddenTestsPassed: true });
    const recovered: RunMetrics = {
      ...clean,
      behavior: { ...clean.behavior, selfCorrections: 2 },
    };
    const failedAfterCorrecting: RunMetrics = {
      ...metricsFixture({ hiddenTestsPassed: false, status: "partial" }),
      behavior: { ...clean.behavior, selfCorrections: 3, abandonedCorrections: 1 },
    };

    const summary = summarize("standard-medium", [clean, recovered, failedAfterCorrecting]);
    expect(summary.runsWithSelfCorrection).toBe(2);
    expect(summary.selfCorrectionRate).toBe(0.5);
    expect(summary.selfCorrections).toBe(5);
    expect(summary.abandonedCorrections).toBe(1);

    const rendered = renderSummary(summary).join("\n");
    expect(rendered).toContain("self-correction      50.0% of 2 run(s) that reflected");
  });

  test("a suite where nothing reflected reports zero, not a division by zero", () => {
    const summary = summarize("standard-medium", [metricsFixture({})]);
    expect(summary.runsWithSelfCorrection).toBe(0);
    expect(summary.selfCorrectionRate).toBe(0);
  });
});
