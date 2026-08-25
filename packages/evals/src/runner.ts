/**
 * The eval runner — PRD §26.1, §26.3, AC-47.
 *
 * The runner does not know how to execute a task. It takes an `ExecuteTask` function and
 * orchestrates around it: snapshot, run, acceptance tests, metrics, teardown. That seam
 * is what lets the same harness drive a scripted mock provider (AC-47, and the only way
 * CI can run this) and a live model, without the scoring differing between them.
 */

import type { CbcEvent } from "@cbc/protocol";

import { deriveMetrics, type RunMetrics } from "./metrics.ts";
import { summarize, type EvalProfile, type SuiteSummary } from "./scoring.ts";
import { validateTask, type AcceptanceTest, type BenchTask } from "./task.ts";

export interface AcceptanceOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly wasPassingBefore: boolean;
  readonly detail?: string;
}

export interface TaskExecution {
  readonly events: readonly CbcEvent[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /** Non-zero when the run itself failed rather than the task. */
  readonly exitCode: number;
}

/** Runs one task against one profile in a prepared workspace. */
export type ExecuteTask = (input: {
  readonly task: BenchTask;
  readonly profile: EvalProfile;
  readonly workspace: string;
  readonly signal: AbortSignal;
}) => Promise<TaskExecution>;

/** Runs a task's acceptance tests in a workspace. */
export type RunAcceptance = (input: {
  readonly task: BenchTask;
  readonly workspace: string;
  readonly tests: readonly AcceptanceTest[];
}) => Promise<AcceptanceOutcome[]>;

/** Materializes a task's repository snapshot and returns the workspace path. */
export type PrepareWorkspace = (task: BenchTask) => Promise<string>;

export interface RunnerOptions {
  readonly prepare: PrepareWorkspace;
  readonly execute: ExecuteTask;
  readonly acceptance: RunAcceptance;
  /**
   * Evidence that the execution adapter applied every profile axis, not just the
   * model name. The paired release gate requires an exact match.
   */
  readonly appliedProfile?: EvalProfile;
  readonly teardown?: (workspace: string) => Promise<void>;
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Tasks to run at once. Defaults to 1: concurrent runs distort wall-time metrics. */
  readonly concurrency?: number;
  readonly now?: () => number;
}

export type ProgressEvent =
  | { readonly kind: "task_started"; readonly task: string; readonly profile: string }
  | {
      readonly kind: "task_finished";
      readonly task: string;
      readonly profile: string;
      readonly passed: boolean;
      readonly wallTimeMs: number;
    }
  | {
      readonly kind: "task_skipped";
      readonly task: string;
      readonly reason: string;
    };

export interface TaskResult {
  readonly task: BenchTask;
  readonly profile: string;
  readonly metrics: RunMetrics;
  readonly acceptance: AcceptanceOutcome[];
  /** Set when the harness itself failed, as distinct from the task failing. */
  readonly harnessError?: string;
}

export interface SuiteResult {
  readonly profile: EvalProfile;
  readonly results: TaskResult[];
  readonly summary: SuiteSummary;
  readonly skipped: Array<{ task: string; reason: string }>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * Run a suite.
 *
 * Concurrency defaults to 1. §26.4 measures wall time and time-to-first-token, and
 * running tasks in parallel on one machine makes both meaningless — a slower number
 * would reflect contention rather than the agent. A caller that only wants outcome
 * metrics can raise it deliberately.
 */
export async function runSuite(
  tasks: readonly BenchTask[],
  profile: EvalProfile,
  options: RunnerOptions,
): Promise<SuiteResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const results: TaskResult[] = [];
  const skipped: Array<{ task: string; reason: string }> = [];

  // Validate every task before running any of them: a malformed fixture discovered
  // halfway through wastes the runs already done, and a task with no acceptance test
  // would silently inflate the success rate.
  const runnable: BenchTask[] = [];
  for (const task of tasks) {
    const issues = validateTask(task);
    if (issues.length > 0) {
      const reason = issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
      skipped.push({ task: task.id, reason });
      options.onProgress?.({ kind: "task_skipped", task: task.id, reason });
      continue;
    }
    runnable.push(task);
  }

  const concurrency = Math.max(1, options.concurrency ?? 1);
  const queue = [...runnable];

  const worker = async (): Promise<void> => {
    for (;;) {
      const task = queue.shift();
      if (task === undefined) return;
      results.push(await runOne(task, profile, options, now));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Restore fixture order: workers finish out of order, and a stable report is easier
  // to diff between runs.
  const order = new Map(runnable.map((task, index) => [task.id, index]));
  results.sort((a, b) => (order.get(a.task.id) ?? 0) - (order.get(b.task.id) ?? 0));

  return {
    profile,
    results,
    summary: summarize(
      profile.id,
      results.map((result) => result.metrics),
    ),
    skipped,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
  };
}

async function runOne(
  task: BenchTask,
  profile: EvalProfile,
  options: RunnerOptions,
  now: () => number,
): Promise<TaskResult> {
  options.onProgress?.({ kind: "task_started", task: task.id, profile: profile.id });

  let workspace: string | undefined;
  const controller = new AbortController();
  // §26.3 gives every task a time budget. Enforced here rather than trusted to the
  // agent's own limits, because a harness that can hang has no useful p95.
  const deadline = setTimeout(() => controller.abort(), task.budget.maxWallTimeMs);

  try {
    workspace = await options.prepare(task);

    // Baseline: which acceptance tests already pass. Without this, a test that was
    // always failing would be counted as a regression the agent caused.
    const before = await options.acceptance({ task, workspace, tests: task.acceptance });

    const execution = await options.execute({ task, profile, workspace, signal: controller.signal });

    const after = await options.acceptance({ task, workspace, tests: task.acceptance });
    const acceptance = after.map((outcome, index) => ({
      ...outcome,
      wasPassingBefore: before[index]?.passed ?? false,
    }));

    const metrics = deriveMetrics({
      taskId: task.id,
      profile: profile.id,
      events: execution.events,
      startedAtMs: execution.startedAtMs,
      finishedAtMs: execution.finishedAtMs,
      acceptance,
      expectedScope: task.expectedScope,
      expectedApprovals: task.expectedApprovals ?? [],
      expectedEvidence: task.expectedEvidence,
      ...(task.expectedStatus !== undefined ? { expectedStatus: task.expectedStatus } : {}),
    });

    options.onProgress?.({
      kind: "task_finished",
      task: task.id,
      profile: profile.id,
      passed: metrics.outcome.hiddenTestsPassed,
      wallTimeMs: metrics.cost.totalWallTimeMs,
    });

    return { task, profile: profile.id, metrics, acceptance };
  } catch (error) {
    // A harness failure is recorded as a failed run rather than thrown, so one broken
    // fixture does not discard the whole suite. It is labelled so it is not mistaken
    // for the agent failing the task.
    const message = error instanceof Error ? error.message : String(error);
    const startedAtMs = now();
    return {
      task,
      profile: profile.id,
      harnessError: message,
      acceptance: [],
      metrics: deriveMetrics({
        taskId: task.id,
        profile: profile.id,
        events: [],
        startedAtMs,
        finishedAtMs: startedAtMs,
        acceptance: [],
        expectedScope: task.expectedScope,
        expectedApprovals: task.expectedApprovals ?? [],
        expectedEvidence: task.expectedEvidence,
        ...(task.expectedStatus !== undefined ? { expectedStatus: task.expectedStatus } : {}),
      }),
    };
  } finally {
    clearTimeout(deadline);
    if (workspace !== undefined && options.teardown !== undefined) {
      await options.teardown(workspace).catch(() => undefined);
    }
  }
}

/** Render a suite result as a report. */
export function renderSuiteResult(result: SuiteResult): string[] {
  const lines = [
    `CBC Bench — profile ${result.profile.id}`,
    `  ${result.profile.description}`,
    `  model ${result.profile.model} · ${result.profile.reasoningMode}/${result.profile.reasoningEffort}`,
    `  auto-review ${result.profile.autoReview ? "on" : "off"} · discovery ${result.profile.toolDiscovery ? "on" : "all-tools"} · subagents ${result.profile.subagents ? "on" : "off"} · cache ${result.profile.promptCache}`,
    "",
  ];

  const width = result.results.reduce((max, entry) => Math.max(max, entry.task.id.length), 0);
  for (const entry of result.results) {
    const mark = entry.harnessError !== undefined
      ? "E"
      : entry.metrics.outcome.hiddenTestsPassed
        ? "\u2713"
        : "\u2717";
    const detail = entry.harnessError !== undefined
      ? `harness error: ${entry.harnessError}`
      : `${entry.metrics.outcome.status}, ${entry.metrics.behavior.toolCalls} tool call(s), $${entry.metrics.cost.estimatedCostUsd.toFixed(4)}, ${Math.round(entry.metrics.cost.totalWallTimeMs)} ms`;
    lines.push(`${mark} ${entry.task.id.padEnd(width)}  ${detail}`);

    for (const claim of entry.metrics.ux.unsupportedClaims) {
      lines.push(`  ${" ".repeat(width)}  AC-50: ${claim}`);
    }
    for (const approval of entry.metrics.behavior.missingApprovals) {
      lines.push(`  ${" ".repeat(width)}  missing approval: ${approval}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push("", `${result.skipped.length} task(s) skipped as malformed:`);
    for (const entry of result.skipped) lines.push(`  ${entry.task}: ${entry.reason}`);
  }

  return lines;
}
