/**
 * Built-in subagent roles — PRD §15.2, §15.7, §10.3, §10.10.
 *
 * §15.1 is the load-bearing idea: a subagent is not a provider feature but the
 * same `AgentKernel` running with a different role, context, permission scope, and
 * budget. Everything that distinguishes one role from another therefore lives in
 * data, not in a separate code path.
 */

import { SOFT_CONTEXT_BUDGETS, type AgentRole } from "@cbc/inference-domain";

/** Roles a child may take. `root` is the parent and is never spawned. */
export type SubagentRole = Exclude<AgentRole, "root">;

export const SUBAGENT_ROLES: readonly SubagentRole[] = [
  "explore",
  "planner",
  "architect",
  "executor",
  "refactorer",
  "reviewer",
  "test",
];

/** §15.6 permission class, shown next to a candidate in the picker. */
export type PermissionClass = "read" | "write" | "process";

export interface RoleDefinition {
  readonly role: SubagentRole;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly permissionClass: PermissionClass;
  /** §10.3 profile name resolved against `model.profiles` in config. */
  readonly modelProfile: string;
  /** §15.7 per-child ceilings. */
  readonly maxToolCalls: number;
  readonly maxModelCalls: number;
  readonly maxDurationMs: number;
  /** §10.10 input soft budget. */
  readonly softContextTokens: number;
  /** Whether the role may hold a writer lease at all (§15.8). */
  readonly canWrite: boolean;
  /** Whether the role may run processes (§15.2 Test). */
  readonly canRunProcess: boolean;
  /**
   * §15.4/SUB-002: a writer role must be handed an explicit contract. A read-only
   * explorer can be given a looser brief because it cannot damage anything.
   */
  readonly requiresExplicitContract: boolean;
  /** Prompt addendum, passed as `PromptInputs.roleInstructions`. */
  readonly instructions: string;
  /** Keywords for §15.6 candidate ranking. */
  readonly keywords: readonly string[];
}

/** §15.7: five minutes per child. */
export const DEFAULT_CHILD_DURATION_MS = 5 * 60 * 1000;

/** §15.7: eight model calls per child. */
export const DEFAULT_CHILD_MODEL_CALLS = 8;

export const ROLE_DEFINITIONS: Readonly<Record<SubagentRole, RoleDefinition>> = {
  explore: {
    role: "explore",
    description: "Search the repository and return evidence without changing anything.",
    capabilities: ["repository search", "file reading", "documentation lookup", "evidence summary"],
    permissionClass: "read",
    // §15.2: Terra low/medium — exploration is breadth, not depth.
    modelProfile: "fast",
    // §15.2 caps exploration at 12 tool calls.
    maxToolCalls: 12,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.explore,
    canWrite: false,
    canRunProcess: false,
    requiresExplicitContract: false,
    instructions: `You are an exploration subagent. You may read and search; you may not modify anything.

Return evidence, not conclusions you cannot support. For every claim, cite the file and line range you read it from. If you could not find something, say so plainly rather than guessing — the parent agent will act on what you report, so a confident wrong answer is worse than an honest gap.

Prefer a few well-chosen reads over exhaustive traversal. You have a small tool budget on purpose.`,
    keywords: [
      "explore",
      "search",
      "find",
      "investigate",
      "understand",
      "read",
      "locate",
      "survey",
      "map",
      "discover",
    ],
  },

  planner: {
    role: "planner",
    description: "Turn a broad request into an ordered, verifiable plan.",
    capabilities: ["decomposition", "sequencing", "risk identification", "scope definition"],
    permissionClass: "read",
    modelProfile: "balanced",
    maxToolCalls: 10,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.planner,
    canWrite: false,
    canRunProcess: false,
    requiresExplicitContract: false,
    instructions: `You are a planning subagent. You may read; you may not modify anything or run commands.

Produce between three and seven steps. Each step must name the files it touches and the check that proves it worked. Call out anything you could not determine, and say what evidence would settle it.

Do not pad the plan. A two-step change should come back as two steps.`,
    keywords: ["plan", "decompose", "design", "sequence", "scope", "strategy", "approach", "outline"],
  },

  architect: {
    role: "architect",
    description: "Assess the blast radius of a proposed change across the whole repository.",
    capabilities: [
      "impact analysis",
      "dependency tracing",
      "boundary and layering review",
      "migration sequencing",
    ],
    permissionClass: "read",
    // §15.2: depth pays here for the same reason it pays for review — the cost of
    // missing a caller is paid later, by everyone.
    modelProfile: "review",
    maxToolCalls: 20,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.architect,
    canWrite: false,
    canRunProcess: false,
    requiresExplicitContract: false,
    instructions: `You are an architecture subagent. You may read and search; you may not modify anything or run commands.

Your job is the blast radius, not the edit. For the change you are given, report: which modules and public boundaries it crosses, which callers depend on the behaviour being changed, which invariants the change would have to preserve, and what would have to migrate in what order.

Name the specific files and symbols that would need to change, with line evidence. "This touches the auth layer" is not a finding; "these four call sites in src/auth/session.ts:88-140 assume the old signature" is.

Say plainly when a change is contained. Manufacturing architectural concern to look thorough wastes the executor's budget on work that was never needed.`,
    keywords: [
      "architecture",
      "impact",
      "blast",
      "radius",
      "dependency",
      "boundary",
      "coupling",
      "migration",
      "design",
      "layering",
      "ripple",
    ],
  },

  executor: {
    role: "executor",
    description: "Implement a narrowly scoped change inside a granted path scope.",
    capabilities: ["file editing", "patch application", "focused verification"],
    permissionClass: "write",
    modelProfile: "balanced",
    maxToolCalls: 24,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.executor,
    canWrite: true,
    canRunProcess: true,
    // §15.4: an executor without a contract has no defined scope, so it cannot
    // be granted a lease. SUB-002 makes this a hard spawn precondition.
    requiresExplicitContract: true,
    instructions: `You are an executor subagent with a write lease over a specific set of paths.

Your lease is the whole of your authority. Writing outside it will be rejected by the runtime, so do not attempt it — narrow your approach instead, or report that the task needs a wider scope.

Read a file and carry its checksum before you modify it, so a concurrent edit is detected rather than overwritten. Make the smallest change that satisfies the contract, then run the verification the contract names. Report exactly what you changed and what the verification showed, including failures.`,
    keywords: [
      "implement",
      "write",
      "edit",
      "create",
      "patch",
      "fix",
      "change",
      "modify",
      "execute",
      "build",
      "add",
    ],
  },

  refactorer: {
    role: "refactorer",
    description: "Remove a named code smell without changing observable behaviour.",
    capabilities: [
      "behaviour-preserving restructuring",
      "duplication removal",
      "naming and boundary cleanup",
      "regression verification",
    ],
    permissionClass: "write",
    modelProfile: "balanced",
    maxToolCalls: 24,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.refactorer,
    canWrite: true,
    canRunProcess: true,
    // §15.4: a refactor without a named smell and a named check is exactly the
    // "clean up the code" brief SUB-002 exists to refuse.
    requiresExplicitContract: true,
    instructions: `You are a refactoring subagent with a write lease over a specific set of paths.

Behaviour must not change. That is the whole contract: same inputs, same outputs, same errors, same side effects. If you find a bug while restructuring, report it — do not fix it in the same pass, because a behavioural fix hidden inside a refactor is invisible to review.

Work in the smallest behaviour-preserving steps you can, and run the verification the contract names after each one. Read a file and carry its checksum before you modify it.

Only remove the smell you were asked to remove. Opportunistic cleanup of surrounding code makes the diff unreviewable and is how a refactor becomes a regression.`,
    keywords: [
      "refactor",
      "cleanup",
      "smell",
      "duplication",
      "extract",
      "rename",
      "simplify",
      "restructure",
      "deduplicate",
      "tidy",
    ],
  },

  reviewer: {
    role: "reviewer",
    description: "Review a diff independently for defects, regressions, and gaps.",
    capabilities: ["diff review", "regression analysis", "security review", "test-gap analysis"],
    permissionClass: "read",
    // §15.2: Sol high/xhigh — review is where depth pays.
    modelProfile: "review",
    maxToolCalls: 16,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.reviewer,
    canWrite: false,
    canRunProcess: false,
    requiresExplicitContract: false,
    instructions: `You are an independent reviewer. You may read; you may not modify anything.

You are deliberately not told how the change was reasoned about, only what it does (§11.9). Judge the diff on its own terms.

Report actionable defects with file and line evidence: incorrect behaviour, regressions, security problems, and missing tests. Rank by severity. Do not report formatting preferences or restate what the code does. If the change looks correct, say so — a review that manufactures findings to look thorough is worse than none.`,
    keywords: ["review", "audit", "critique", "verify", "inspect", "check", "assess", "regression"],
  },

  test: {
    role: "test",
    description: "Select and run the relevant tests, then triage what failed.",
    capabilities: ["test selection", "test execution", "failure triage", "evidence extraction"],
    permissionClass: "process",
    modelProfile: "fast",
    maxToolCalls: 16,
    maxModelCalls: DEFAULT_CHILD_MODEL_CALLS,
    maxDurationMs: DEFAULT_CHILD_DURATION_MS,
    softContextTokens: SOFT_CONTEXT_BUDGETS.test,
    canWrite: false,
    canRunProcess: true,
    requiresExplicitContract: false,
    instructions: `You are a test subagent. Source files are read-only to you; you may run test commands.

Choose the narrowest command that covers the change. Report the exact command, its exit code, and the specific assertions that failed — not the whole log.

Distinguish a genuine failure from a broken environment (a missing dependency, an absent binary). Saying "the suite could not run because X" is a useful result; reporting a pass you did not observe is not.`,
    keywords: ["test", "run", "verify", "suite", "spec", "triage", "failure", "regression", "check"],
  },
};

export function roleDefinition(role: SubagentRole): RoleDefinition {
  return ROLE_DEFINITIONS[role];
}

/**
 * §15.7 aggregate limits — raised to effectively remove the cap (§15.7 previously 3/3/1).
 */
export const SUBAGENT_LIMITS = {
  maxChildrenPerTurn: 32,
  maxConcurrent: 32,
  maxDepth: 4,
  /** §15.7 / P6: exactly one writer. */
  maxWriterAgents: 1,
  /** §15.7: children together may use half the parent's context budget. */
  aggregateContextFraction: 0.5,
} as const;
