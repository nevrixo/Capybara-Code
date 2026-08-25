/**
 * Benchmark task fixtures — PRD §26.2, §26.3.
 *
 * §26.3 lists eight things every task must carry. All eight are required fields here
 * rather than optional, because a task missing any one of them cannot be scored: without
 * an expected file scope there is no scope precision, and without expected evidence
 * there is no way to tell a correct answer from a lucky one.
 */

/** Performance-program release distribution: 150 tasks across ten strata. */
export const TASK_CATEGORIES = [
  "repository_understanding",
  "local_bug_fix",
  "feature_implementation",
  "refactor",
  "test_diagnosis",
  "diff_review",
  "multi_language_monorepo",
  "permission_denial_adaptation",
  "security_safety",
  "long_session_resume_compaction",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Recommended release-candidate distribution from the performance program. */
export const CATEGORY_TARGETS: Readonly<Record<TaskCategory, number>> = {
  repository_understanding: 15,
  local_bug_fix: 20,
  feature_implementation: 20,
  refactor: 15,
  test_diagnosis: 15,
  diff_review: 10,
  multi_language_monorepo: 15,
  permission_denial_adaptation: 10,
  security_safety: 15,
  long_session_resume_compaction: 15,
};

export const TARGET_TASK_COUNT = 150;

/** Additional modification-plan categories. They do not change the 150-task §26.2 mix. */
export const FEATURE_TASK_CATEGORIES = [
  "edit_precision",
  "full_lsp",
  "durable_memory",
  "session_daemon",
  "persistent_graph",
  "worktree_multi_agent",
  "plugin_hooks",
  "app_server_sdk",
] as const;

export type FeatureTaskCategory = (typeof FEATURE_TASK_CATEGORIES)[number];

export const FEATURE_TASK_PROMPTS: Readonly<Record<FeatureTaskCategory, string>> = {
  edit_precision: "Apply an anchor edit to a shifted function without rewriting the file.",
  full_lsp: "Rename a symbol through the language server and apply the resulting edit plan.",
  durable_memory: "Remember a verified fact, restart, and recall it without cross-workspace leakage.",
  session_daemon: "Detach during a turn, reattach, and confirm the turn continued.",
  persistent_graph: "Fan-in two reader agents then dispatch one writer after both complete.",
  worktree_multi_agent: "Run two writers in separate worktrees and merge disjoint proposals.",
  plugin_hooks: "Deny a networked process from a before-tool hook without widening authority.",
  app_server_sdk: "Submit a turn through the App Protocol client and resume from the cursor.",
};

/** §26.2's language coverage. */
export const TASK_LANGUAGES = [
  "typescript",
  "javascript",
  "rust",
  "python",
  "go",
  "mixed_monorepo",
] as const;

export type TaskLanguage = (typeof TASK_LANGUAGES)[number];

/** §26.3 risk labels, so a run can report which threats it actually exercised. */
export const RISK_LABELS = [
  "destructive_command",
  "network_access",
  "credential_access",
  "external_side_effect",
  "user_edit_conflict",
  "prompt_injection",
  "large_output",
  "path_traversal",
] as const;

export type RiskLabel = (typeof RISK_LABELS)[number];

/** How a task's hidden tests are run. */
export interface AcceptanceTest {
  /** Shell-free invocation: program plus args, per §12.3. */
  readonly program: string;
  readonly args: readonly string[];
  /** Working directory relative to the repository snapshot. */
  readonly cwd?: string;
  /** Exit code that counts as a pass. Defaults to 0. */
  readonly expectExit?: number;
  /** Substring that must appear in the output, for a test without a useful exit code. */
  readonly expectOutput?: string;
  readonly timeoutMs?: number;
}

/**
 * Evidence a correct answer should contain.
 *
 * §26.4's "requested behavior satisfied" cannot be measured by tests alone: a task can
 * pass its hidden tests while the final report claims something untrue. AC-50 makes the
 * report part of the contract, so it is scored.
 */
export interface ExpectedEvidence {
  /** Substrings the final report should contain, e.g. a command that was run. */
  readonly reportMentions: readonly string[];
  /** Verification the report must claim, and that must actually have happened. */
  readonly verificationCommands?: readonly string[];
  /** Risks the report should surface. */
  readonly risksMentioned?: readonly string[];
}

export interface TaskBudget {
  readonly maxWallTimeMs: number;
  readonly maxTotalTokens: number;
  readonly maxToolCalls: number;
}

export type GeneratedSnapshotParameter = string | number | boolean;

/**
 * A versioned deterministic snapshot recipe. The benchmark materializes it into a fresh
 * directory before every run, so generated fixtures remain immutable and digestible
 * without checking hundreds of near-duplicate source trees into the repository.
 */
export interface GeneratedSnapshotSpec {
  readonly generator: "cbc-bench";
  readonly version: "1.0";
  readonly template: string;
  readonly parameters: Readonly<Record<string, GeneratedSnapshotParameter>>;
}

export interface BenchTask {
  readonly id: string;
  readonly category: TaskCategory;
  readonly language: TaskLanguage;
  readonly title: string;
  /** §26.3 repository snapshot: a path under `benchmarks/cbc-bench/tasks/`. */
  readonly snapshot: string;
  /** Optional deterministic recipe used when the snapshot is generated on demand. */
  readonly generatedSnapshot?: GeneratedSnapshotSpec;
  /** §26.3 user prompt, verbatim. */
  readonly prompt: string;
  /** §26.3 hidden acceptance tests. Hidden from the agent, not from the repository. */
  readonly acceptance: readonly AcceptanceTest[];
  /** §26.3 allowed network policy. */
  readonly network: "deny" | "ask" | "allow";
  /**
   * §26.3 expected file scope, as globs. Files outside this are counted against scope
   * precision rather than treated as failures: a task may legitimately touch a lockfile.
   */
  readonly expectedScope: readonly string[];
  readonly expectedEvidence: ExpectedEvidence;
  readonly budget: TaskBudget;
  readonly risks: readonly RiskLabel[];
  /** Permission mode the task is run under. */
  readonly permissionMode?: "plan" | "ask" | "auto" | "auto-review";
  /**
   * Approvals the run should be asked for. §26.4's "approval correctness" is measured
   * against this: an unexpected approval and a missing one are different failures.
   */
  readonly expectedApprovals?: readonly string[];
  /** Set when the task is expected to end without completing, e.g. a plan-mode task. */
  readonly expectedStatus?: "completed" | "partial";
}

export interface TaskValidationIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Validate a task fixture.
 *
 * Run before a suite executes, because a malformed task produces a *plausible* score
 * rather than an error: a task with no acceptance tests trivially "passes", which would
 * quietly inflate the success rate that §26.6 gates releases on.
 */
export function validateTask(task: BenchTask): TaskValidationIssue[] {
  const issues: TaskValidationIssue[] = [];

  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id)) {
    issues.push({ field: "id", message: "must be lowercase, digits, and hyphens" });
  }
  if (!TASK_CATEGORIES.includes(task.category)) {
    issues.push({ field: "category", message: `unknown category '${task.category}'` });
  }
  if (!TASK_LANGUAGES.includes(task.language)) {
    issues.push({ field: "language", message: `unknown language '${task.language}'` });
  }
  if (task.prompt.trim().length < 10) {
    issues.push({ field: "prompt", message: "too short to be a real request" });
  }
  if (task.snapshot.length === 0 || task.snapshot.includes("..")) {
    issues.push({ field: "snapshot", message: "must be a relative path with no '..'" });
  }
  if (task.generatedSnapshot !== undefined) {
    if (!task.snapshot.startsWith("generated/")) {
      issues.push({
        field: "generatedSnapshot",
        message: "generated snapshots must use a generated/<task-id> logical path",
      });
    }
    if (
      task.generatedSnapshot.generator !== "cbc-bench" ||
      task.generatedSnapshot.version !== "1.0" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(task.generatedSnapshot.template)
    ) {
      issues.push({
        field: "generatedSnapshot",
        message: "generator, version, or template is not a supported immutable recipe",
      });
    }
    for (const [key, value] of Object.entries(task.generatedSnapshot.parameters)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        issues.push({ field: "generatedSnapshot.parameters", message: `invalid parameter '${key}'` });
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        issues.push({
          field: "generatedSnapshot.parameters",
          message: `parameter '${key}' must be a string, number, or boolean`,
        });
      }
    }
  }

  if (task.acceptance.length === 0 && task.category !== "diff_review") {
    // Diff review produces a judgement rather than a code change, so evidence is the
    // only thing to score. Everything else needs a test that can fail.
    issues.push({
      field: "acceptance",
      message: "a task with no acceptance test would always pass",
    });
  }
  for (const [index, test] of task.acceptance.entries()) {
    if (test.program.trim().length === 0) {
      issues.push({ field: `acceptance[${index}].program`, message: "must not be empty" });
    }
    if (/[|&;><]/.test(test.program)) {
      // §12.3: the harness runs programs directly, so a shell operator here would be
      // passed through as a literal argument and silently do nothing.
      issues.push({
        field: `acceptance[${index}].program`,
        message: "shell operators are not supported; use program plus args",
      });
    }
  }

  if (task.expectedScope.length === 0) {
    issues.push({
      field: "expectedScope",
      message: "§26.4 scope precision needs an expected scope",
    });
  }
  if (task.expectedEvidence.reportMentions.length === 0) {
    issues.push({
      field: "expectedEvidence.reportMentions",
      message: "§26.4 report completeness needs at least one expectation",
    });
  }

  if (task.budget.maxWallTimeMs <= 0 || task.budget.maxTotalTokens <= 0) {
    issues.push({ field: "budget", message: "§26.3 requires a positive time and token budget" });
  }
  for (const risk of task.risks) {
    if (!RISK_LABELS.includes(risk)) {
      issues.push({ field: "risks", message: `unknown risk label '${risk}'` });
    }
  }

  // A task labelled with a risk but run in a mode that can never trigger it would
  // report coverage it does not have.
  if (task.risks.includes("destructive_command") && task.permissionMode === "plan") {
    issues.push({
      field: "risks",
      message: "a destructive_command task in plan mode never reaches an approval",
    });
  }

  return issues;
}

export interface SuiteCoverage {
  readonly total: number;
  readonly byCategory: Record<TaskCategory, number>;
  readonly byLanguage: Record<string, number>;
  readonly byRisk: Record<string, number>;
  /** Categories short of their §26.2 target, with the shortfall. */
  readonly shortfalls: Array<{ category: TaskCategory; have: number; want: number }>;
  readonly meetsTarget: boolean;
}

/**
 * Report a suite's coverage against §26.2.
 *
 * Reported rather than enforced. A suite below target is still worth running — it is
 * just not the full benchmark, and §26.6's thresholds are only meaningful against the
 * complete set. Silently accepting a partial suite as "the benchmark" is the failure
 * this makes visible.
 */
export function suiteCoverage(tasks: readonly BenchTask[]): SuiteCoverage {
  const byCategory = Object.fromEntries(
    TASK_CATEGORIES.map((category) => [category, 0]),
  ) as Record<TaskCategory, number>;
  const byLanguage: Record<string, number> = {};
  const byRisk: Record<string, number> = {};

  for (const task of tasks) {
    byCategory[task.category] += 1;
    byLanguage[task.language] = (byLanguage[task.language] ?? 0) + 1;
    for (const risk of task.risks) {
      byRisk[risk] = (byRisk[risk] ?? 0) + 1;
    }
  }

  const shortfalls = TASK_CATEGORIES.filter(
    (category) => byCategory[category] < CATEGORY_TARGETS[category],
  ).map((category) => ({
    category,
    have: byCategory[category],
    want: CATEGORY_TARGETS[category],
  }));

  return {
    total: tasks.length,
    byCategory,
    byLanguage,
    byRisk,
    shortfalls,
    meetsTarget: shortfalls.length === 0 && tasks.length >= TARGET_TASK_COUNT,
  };
}

export function renderCoverage(coverage: SuiteCoverage): string[] {
  const lines = [`${coverage.total} task(s) of ${TARGET_TASK_COUNT} target (§26.2)`, ""];

  const width = TASK_CATEGORIES.reduce((max, category) => Math.max(max, category.length), 0);
  for (const category of TASK_CATEGORIES) {
    const have = coverage.byCategory[category];
    const want = CATEGORY_TARGETS[category];
    lines.push(
      `  ${category.padEnd(width)}  ${String(have).padStart(3)} / ${String(want).padStart(3)}${have < want ? "  short" : ""}`,
    );
  }

  lines.push("", "Languages");
  for (const [language, count] of Object.entries(coverage.byLanguage).sort()) {
    lines.push(`  ${language.padEnd(width)}  ${count}`);
  }

  if (Object.keys(coverage.byRisk).length > 0) {
    lines.push("", "Risk labels exercised");
    for (const [risk, count] of Object.entries(coverage.byRisk).sort()) {
      lines.push(`  ${risk.padEnd(width)}  ${count}`);
    }
  }

  if (!coverage.meetsTarget) {
    lines.push("", "This suite is below the §26.2 target, so §26.6's thresholds do not apply to it.");
  }
  return lines;
}
