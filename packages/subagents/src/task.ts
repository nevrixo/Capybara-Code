/**
 * The child task contract — PRD §15.4, SUB-002.
 *
 * §15.4 requires every child task to carry a goal, constraints, and a contract.
 * The reason is stated in §15.4's own example: "Fix the repo." must be refused.
 * A child runs with real permissions and a real budget, and an underspecified
 * brief is how a delegated task quietly does the wrong thing at scale.
 *
 * So validation here is a spawn precondition, not advice.
 */

import { overlappingGlobs } from "@cbc/tool-registry";

import { roleDefinition, type SubagentRole } from "./roles.ts";

/** §15.4 task contract. */
export interface AgentTask {
  readonly title: string;
  readonly goal: string;
  /** Background the child needs but cannot discover itself. */
  readonly context: readonly string[];
  readonly constraints: readonly string[];
  /** What the child must return — the "contract" in §6.10's card. */
  readonly expectedOutput: readonly string[];
  /** Path globs the child may write. Empty for a read-only role. */
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  /** Checks the child must run before reporting success. */
  readonly verification: readonly string[];
  readonly deadlineMs: number;
  /**
   * Sibling agent ids that must finish before this task starts (Plan-and-Execute).
   *
   * Ids refer to agents the same scheduler already created, which is what makes a
   * dependency cycle structurally impossible: a task can only name work that
   * exists, and work that exists was created earlier.
   *
   * When a dependency completes, its *structured* result is folded into this
   * task's context. Its transcript is not — SUB-004 forbids that, and a summary
   * plus evidence is what the next child can actually act on anyway.
   */
  readonly dependencies: readonly string[];
}

export interface TaskValidationIssue {
  readonly field: keyof AgentTask | "task";
  readonly message: string;
}

export interface TaskValidation {
  readonly ok: boolean;
  readonly issues: TaskValidationIssue[];
}

/** Minimum goal length. Shorter than this cannot express a scoped objective. */
export const MIN_GOAL_LENGTH = 20;

/** Titles that carry no scope, taken from §15.4's "Invalid task" example. */
const VAGUE_GOAL_PATTERNS: readonly RegExp[] = [
  /^\s*fix\s+(the\s+)?(repo|repository|project|codebase|everything|it|bugs?)\s*\.?\s*$/i,
  /^\s*(make|get)\s+it\s+work\s*\.?\s*$/i,
  /^\s*clean\s*up\s*(the\s+)?(code|repo|everything)?\s*\.?\s*$/i,
  /^\s*improve\s+(the\s+)?(code|codebase|quality|everything)\s*\.?\s*$/i,
  /^\s*refactor\s+(the\s+)?(repo|codebase|everything)\s*\.?\s*$/i,
  /^\s*do\s+(it|the\s+work|whatever)\s*\.?\s*$/i,
];

/**
 * Whether a goal is too broad to delegate (§15.4).
 *
 * The goal is normalized first — trailing punctuation stripped and internal
 * whitespace collapsed — so padding cannot smuggle a vague brief past the check.
 * "Fix the repo........." is the same instruction as "Fix the repo".
 */
export function isTooBroad(goal: string): boolean {
  const normalized = goal
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?,;:…-]+$/u, "");
  return VAGUE_GOAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Validate a task against §15.4 for a given role.
 *
 * A read-only role is held to a lighter standard than a writer: it cannot damage
 * the workspace, so demanding a full verification contract from an explorer would
 * be ceremony. A writer must be fully specified.
 */
export function validateTask(task: AgentTask, role: SubagentRole): TaskValidation {
  const definition = roleDefinition(role);
  const issues: TaskValidationIssue[] = [];

  if (task.title.trim().length === 0) {
    issues.push({ field: "title", message: "a task needs a title for the timeline card" });
  }

  const goal = task.goal.trim();
  if (goal.length === 0) {
    issues.push({ field: "goal", message: "a task needs a goal" });
  } else if (goal.length < MIN_GOAL_LENGTH) {
    issues.push({
      field: "goal",
      message: `the goal is too short to be actionable (${goal.length} < ${MIN_GOAL_LENGTH} characters)`,
    });
  } else if (isTooBroad(goal)) {
    // §15.4: the scheduler refuses this and asks the root to decompose.
    issues.push({
      field: "goal",
      message: `'${goal}' is too broad to delegate; decompose it into a scoped objective`,
    });
  }

  if (task.deadlineMs <= 0) {
    issues.push({ field: "deadlineMs", message: "a task needs a positive deadline" });
  } else if (task.deadlineMs > definition.maxDurationMs) {
    issues.push({
      field: "deadlineMs",
      message: `the deadline exceeds the ${Math.round(
        definition.maxDurationMs / 1000,
      )}s ceiling for a ${role} child (§15.7)`,
    });
  }

  if (definition.requiresExplicitContract) {
    if (task.constraints.length === 0) {
      issues.push({
        field: "constraints",
        message: `a ${role} child must be given explicit constraints (§15.4, SUB-002)`,
      });
    }
    if (task.expectedOutput.length === 0) {
      issues.push({
        field: "expectedOutput",
        message: `a ${role} child must be given an explicit contract for what it returns (SUB-002)`,
      });
    }
  }

  if (definition.canWrite) {
    if (task.allowedPaths.length === 0) {
      issues.push({
        field: "allowedPaths",
        message: "a writer child needs at least one allowed path for its lease (§15.8)",
      });
    }
    // The Rust lease accepts positive globs only. A forbidden path already
    // outside that positive lease is redundant and safe (the common examples
    // are node_modules and dist beside a few explicitly allowed source files).
    // Keep refusing carve-outs inside the lease because a process could bypass
    // an exclusion that only the higher-level tool policy understands.
    const forbiddenOverlaps = overlappingGlobs(task.allowedPaths, task.forbiddenPaths);
    if (forbiddenOverlaps.length > 0) {
      issues.push({
        field: "forbiddenPaths",
        message:
          "writer leases cannot represent forbidden exclusions inside allowedPaths; " +
          forbiddenOverlaps.map(([forbidden, allowed]) => `'${forbidden}' overlaps '${allowed}'`).join(", ") +
          "; narrow allowedPaths instead",
      });
    }
  } else if (task.allowedPaths.length > 0) {
    issues.push({
      field: "allowedPaths",
      message: `${role} is a read-only role and cannot be granted write paths (§15.2)`,
    });
  }

  // ---- Dependencies (Plan-and-Execute) ----
  const seenDependencies = new Set<string>();
  for (const dependency of task.dependencies) {
    if (dependency.trim().length === 0) {
      issues.push({ field: "dependencies", message: "a dependency id must not be empty" });
      continue;
    }
    if (seenDependencies.has(dependency)) {
      // A duplicate is not harmful to execute, but it means the plan was
      // generated carelessly, and the same carelessness produces wrong orders.
      issues.push({
        field: "dependencies",
        message: `dependency '${dependency}' is listed more than once`,
      });
    }
    seenDependencies.add(dependency);
  }
  for (const glob of task.allowedPaths) {
    if (glob.includes("..")) {
      issues.push({
        field: "allowedPaths",
        message: `lease glob '${glob}' contains '..'; scopes must be workspace-relative`,
      });
    }
    if (glob === "**" || glob === "**/*" || glob === "*") {
      // A lease over everything is not a scope; it is the absence of one.
      issues.push({
        field: "allowedPaths",
        message: `lease glob '${glob}' covers the whole workspace, which is not a scope`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

export interface TaskDraft {
  readonly title: string;
  readonly goal: string;
  readonly context?: readonly string[];
  readonly constraints?: readonly string[];
  readonly expectedOutput?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly verification?: readonly string[];
  readonly deadlineMs?: number;
  readonly dependencies?: readonly string[];
}

/**
 * A Plan/TODO item the host can use to complete a partial spawn.
 *
 * Root models often restated a plan step without copying `files` into
 * `allowedPaths`. Matching that step lets an executor spawn instead of failing
 * §15.4 on a missing lease.
 */
export interface TaskContractHint {
  readonly id?: string;
  readonly text: string;
  readonly details?: string;
  readonly files?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly status?: string;
}

/** Fill a partial draft with role defaults, ready for validation. */
export function buildTask(
  draft: TaskDraft,
  role: SubagentRole,
  hints: readonly TaskContractHint[] = [],
): AgentTask {
  const definition = roleDefinition(role);
  const completed = completeTaskDraft(draft, role, hints);
  return {
    title: completed.title,
    goal: completed.goal,
    context: [...(completed.context ?? [])],
    constraints: [...(completed.constraints ?? [])],
    expectedOutput: [...(completed.expectedOutput ?? [])],
    allowedPaths: [...(completed.allowedPaths ?? [])],
    forbiddenPaths: [...(completed.forbiddenPaths ?? [])],
    verification: [...(completed.verification ?? [])],
    deadlineMs: Math.min(completed.deadlineMs ?? definition.maxDurationMs, definition.maxDurationMs),
    dependencies: [...(completed.dependencies ?? [])],
  };
}

/**
 * Complete a spawn draft so a writer child can be admitted without the parent
 * restating an already-scoped plan item.
 *
 * Vague goals still fail `validateTask`. This only fills missing contract
 * fields from the goal, mentioned paths, or a matching Plan/TODO hint.
 */
export function completeTaskDraft(
  draft: TaskDraft,
  role: SubagentRole,
  hints: readonly TaskContractHint[] = [],
): TaskDraft {
  const definition = roleDefinition(role);
  const hint = matchingContractHint(draft, hints);
  const constraints = nonempty(draft.constraints);
  const expectedOutput = nonempty(draft.expectedOutput);
  const explicitPaths = nonempty(draft.allowedPaths);
  const allowedPaths = definition.canWrite
    ? (explicitPaths.length > 0
        ? uniquePaths(explicitPaths)
        : uniquePaths([...inferAllowedPaths(draft), ...nonempty(hint?.files)], { dropUnscoped: true }))
    : nonempty(draft.allowedPaths);
  const hintConstraints = hint?.details !== undefined && hint.details.trim().length > 0
    ? [hint.details.trim()]
    : [];
  const hintOutput = nonempty(hint?.acceptanceCriteria);

  return {
    ...draft,
    constraints: constraints.length > 0
      ? constraints
      : (hintConstraints.length > 0 ? hintConstraints : defaultConstraints(draft, role)),
    expectedOutput: expectedOutput.length > 0
      ? expectedOutput
      : (hintOutput.length > 0 ? hintOutput : defaultExpectedOutput(role)),
    allowedPaths,
  };
}

function matchingContractHint(
  draft: TaskDraft,
  hints: readonly TaskContractHint[],
): TaskContractHint | undefined {
  if (hints.length === 0) return undefined;
  const haystack = normalizeMatchText(`${draft.title}\n${draft.goal}\n${(draft.context ?? []).join("\n")}`);
  const named = hints.find((hint) => {
    if (hint.text.trim().length > 0 && haystack.includes(normalizeMatchText(hint.text))) return true;
    return hint.id !== undefined && hint.id.trim().length > 0 && haystack.includes(normalizeMatchText(hint.id));
  });
  if (named !== undefined) return named;
  const withFiles = (hint: TaskContractHint): boolean => nonempty(hint.files).length > 0;
  const active = hints.filter((hint) => hint.status === "active" && withFiles(hint));
  if (active.length === 1) return active[0];
  const open = hints.filter((hint) =>
    (hint.status === "active" || hint.status === "pending") && withFiles(hint),
  );
  if (open.length === 1) return open[0];
  return undefined;
}

function inferAllowedPaths(draft: TaskDraft): string[] {
  const corpus = [
    draft.title,
    draft.goal,
    ...(draft.context ?? []),
    ...(draft.constraints ?? []),
    ...(draft.expectedOutput ?? []),
    ...(draft.verification ?? []),
  ].join("\n");
  return uniquePaths(extractPathTokens(corpus), { dropUnscoped: true });
}

const FILE_TOKEN = /(?:^|[^A-Za-z0-9_./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w-]{0,9})(?=$|[^A-Za-z0-9_./-])/g;

function extractPathTokens(text: string): string[] {
  const found: string[] = [];
  const normalized = text.replaceAll("\\", "/");
  for (const match of normalized.matchAll(FILE_TOKEN)) {
    const token = (match[1] ?? "").replace(/^\.\//, "");
    if (token.length > 0) found.push(token);
  }
  return found;
}

function uniquePaths(
  paths: readonly string[],
  options: { readonly dropUnscoped?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (path.length === 0 || seen.has(path)) continue;
    if (
      options.dropUnscoped === true &&
      (path.includes("..") || path === "**" || path === "**/*" || path === "*")
    ) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}

function nonempty(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function normalizeMatchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function defaultConstraints(draft: TaskDraft, role: SubagentRole): string[] {
  const goal = draft.goal.trim();
  if (roleDefinition(role).canWrite) {
    return [
      "Do not modify files outside the write scope.",
      ...(goal.length > 0 ? [`Stay inside this goal: ${goal}`] : []),
    ];
  }
  return goal.length > 0 ? [`Stay inside this goal: ${goal}`] : ["Stay inside the stated goal."];
}

function defaultExpectedOutput(role: SubagentRole): string[] {
  if (roleDefinition(role).canWrite) {
    return ["List the files changed.", "Report verification outcome or why it could not be run."];
  }
  return ["Return a scoped summary of findings with evidence paths."];
}

/**
 * A finished dependency's contribution to this task's context.
 *
 * Only the structured fields travel. `summary` is the child's own claim, so it is
 * labelled as one: the receiving child must be able to tell "the previous agent
 * reported X" from "X is true", and §15.11 says the parent has not verified it
 * yet at the point this is assembled.
 */
export interface UpstreamResult {
  readonly agentId: string;
  readonly role: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly openRisks: readonly string[];
  readonly evidence: readonly string[];
  readonly recommendedNextStep?: string;
}

/**
 * Render the task as the child's prompt task description.
 *
 * The section headings match §6.10's card so the user reads the same structure
 * the child was actually given — there is no second, prettier version.
 */
export function renderTaskContract(
  task: AgentTask,
  options: { readonly upstream?: readonly UpstreamResult[] } = {},
): string {
  const lines: string[] = ["# Goal", task.goal, ""];

  if (task.context.length > 0) {
    lines.push("# Context");
    for (const item of task.context) lines.push(`- ${item}`);
    lines.push("");
  }

  const upstream = options.upstream ?? [];
  if (upstream.length > 0) {
    lines.push("# Upstream results");
    lines.push(
      "These are reports from tasks that ran before yours. They are claims, not verified facts —",
      "confirm anything you depend on before you build on it.",
      "",
    );
    for (const result of upstream) {
      lines.push(`## ${result.role}: ${result.title} (${result.status})`);
      lines.push(result.summary.length > 0 ? result.summary : "(no summary reported)");
      if (result.filesChanged.length > 0) {
        lines.push(`- files it changed: ${result.filesChanged.join(", ")}`);
      }
      if (result.evidence.length > 0) {
        lines.push(`- evidence: ${result.evidence.join("; ")}`);
      }
      for (const risk of result.openRisks) lines.push(`- open risk: ${risk}`);
      if (result.recommendedNextStep !== undefined) {
        lines.push(`- it recommended: ${result.recommendedNextStep}`);
      }
      lines.push("");
    }
  }

  if (task.constraints.length > 0) {
    lines.push("# Constraints");
    for (const item of task.constraints) lines.push(item);
    lines.push("");
  }

  if (task.expectedOutput.length > 0) {
    lines.push("# Contract");
    for (const item of task.expectedOutput) lines.push(item);
    lines.push("");
  }

  if (task.allowedPaths.length > 0) {
    lines.push("# Write scope");
    for (const glob of task.allowedPaths) lines.push(`- ${glob}`);
    lines.push("");
  }

  if (task.forbiddenPaths.length > 0) {
    lines.push("# Forbidden");
    for (const glob of task.forbiddenPaths) lines.push(`- ${glob}`);
    lines.push("");
  }

  if (task.verification.length > 0) {
    lines.push("# Verification");
    for (const item of task.verification) lines.push(`- ${item}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
