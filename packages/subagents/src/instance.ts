/**
 * Agent instances and their results — PRD §15.3, §15.9, §15.10.
 */

import type { WriterLease } from "@cbc/tool-registry";

import type { SubagentRole } from "./roles.ts";
import type { AgentTask } from "./task.ts";

/**
 * §6.10 task states, plus `blocked` from §15.10.
 *
 * `waiting` and `blocked` are distinct on purpose. `waiting` means the child is
 * alive and depends on something; `blocked` is a terminal result meaning it could
 * not proceed — §15.12 uses it for a timeout or a lease conflict, so the parent
 * gets a structured answer instead of a silent hang.
 */
export type AgentState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export const TERMINAL_AGENT_STATES: readonly AgentState[] = [
  "completed",
  "failed",
  "cancelled",
  "blocked",
];

export function isTerminalAgentState(state: AgentState): boolean {
  return TERMINAL_AGENT_STATES.includes(state);
}

/** §15.3 permission scope handed to a child. */
export interface AgentPermissionScope {
  readonly canWrite: boolean;
  readonly canRunProcess: boolean;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  /**
   * §15.2 Explore: "no user approval requests except restricted reads". A child
   * that cannot ask cannot stall waiting on a human who is watching the parent.
   */
  readonly mayRequestApproval: boolean;
}

/** §15.3 budget. */
export interface AgentBudget {
  readonly maxToolCalls: number;
  readonly maxModelCalls: number
  readonly maxDurationMs: number;
  readonly softContextTokens: number;
}

export interface ChildContextReservation {
  readonly agentId: string;
  readonly estimatedTokens: number;
  readonly reservedAt: string;
  readonly role: SubagentRole;
  actualTokens?: number;
  state: "reserved" | "settled" | "released";
}

/** §15.3 agent instance. */
export interface AgentInstance {
  readonly id: string;
  readonly parentId?: string;
  readonly role: SubagentRole;
  readonly name: string;
  state: AgentState;
  readonly task: AgentTask;
  readonly modelProfile: string;
  readonly permissions: AgentPermissionScope;
  readonly budget: AgentBudget;
  /** Aggregate parent-context admission record, reconciled on terminal state. */
  contextReservation?: ChildContextReservation;
  writerLease?: WriterLease;
  readonly createdAt: string;
  readonly depth: number;
  startedAt?: string;
  finishedAt?: string;
  /** Whether the parent stopped awaiting while the child continued (§6.11). */
  awaitInterrupted: boolean;
  result?: ChildAgentResult;
}

/** A reference the parent can independently verify (§15.11). */
export interface EvidenceRef {
  readonly kind: "file" | "command" | "artifact" | "search";
  readonly label: string;
  /** Workspace-relative path, artifact id, or command display. */
  readonly locator: string;
  readonly detail?: string;
}

export interface ChildFileChange {
  readonly path: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly summary: string;
}

export interface ChildCommandRun {
  readonly display: string;
  readonly exitCode?: number;
  readonly artifactId?: string;
}

export interface ReviewFinding {
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly title: string;
  readonly evidence: string;
  readonly recommendation: string;
}

/** §15.10 child result schema. */
export interface ChildAgentResult {
  readonly status: "completed" | "blocked" | "failed" | "cancelled";
  readonly summary: string;
  readonly evidence: EvidenceRef[];
  readonly filesChanged: ChildFileChange[];
  readonly commandsRun: ChildCommandRun[];
  readonly findings?: ReviewFinding[];
  readonly openRisks: string[];
  readonly recommendedNextStep?: string;
}

export function emptyChildResult(
  status: ChildAgentResult["status"],
  summary: string,
): ChildAgentResult {
  return {
    status,
    summary,
    evidence: [],
    filesChanged: [],
    commandsRun: [],
    openRisks: [],
  };
}

/**
 * Map a child's terminal result onto its instance state.
 *
 * §15.12: "child failure가 root failure를 자동 의미하지 않는다" — the parent decides
 * what a failed child means, so this only records the child's own outcome.
 */
export function stateForResult(result: ChildAgentResult): AgentState {
  switch (result.status) {
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

/**
 * Render the §6.10 task card.
 *
 * Requirements from §6.10: role, goal, constraints, contract, and child count are
 * shown; a writer task shows its lease scope; status is one of the documented
 * states. The card is plain text so the same renderer serves the TUI, automatic line mode,
 * and a golden test (§25.8).
 */
export function renderTaskCard(
  instance: AgentInstance,
  options: { compact?: boolean; childCount?: number } = {},
): string[] {
  const icon = stateIcon(instance.state);
  const header = `${icon} Task: ${instance.role}`;

  if (options.compact === true) {
    const summary = instance.result?.summary ?? instance.task.title;
    return [`${header} · ${instance.state} · ${summary}`];
  }

  const lines: string[] = [header, "├─ Context"];
  const contract: string[] = ["# Goal", instance.task.goal];
  if (instance.task.constraints.length > 0) {
    contract.push("", "# Constraints", ...instance.task.constraints);
  }
  if (instance.task.expectedOutput.length > 0) {
    contract.push("", "# Contract", ...instance.task.expectedOutput);
  }
  for (const line of contract) {
    lines.push(line.length === 0 ? "│" : `│  ${line}`);
  }

  if (instance.writerLease !== undefined) {
    // §6.10: a writer task shows the scope it may write.
    lines.push(`├─ Write lease: ${instance.writerLease.pathGlobs.join(", ")}`);
  }

  const childCount = options.childCount ?? 0;
  lines.push(`├─ Tasks: ${childCount} agent${childCount === 1 ? "" : "s"}`);
  lines.push(`└─ ${icon} ${instance.name}: ${instance.task.title}`);
  return lines;
}

function stateIcon(state: AgentState): string {
  switch (state) {
    case "completed":
      return "✓";
    case "failed":
      return "×";
    case "cancelled":
      return "×";
    case "blocked":
      return "!";
    case "queued":
    case "running":
    case "waiting":
      return "⧖";
  }
}
