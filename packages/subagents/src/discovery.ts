/**
 * Role discovery and the delegation decision — PRD §15.5, §15.6, AC-09, SUB-001.
 */

import { ROLE_DEFINITIONS, SUBAGENT_ROLES, type PermissionClass, type SubagentRole } from "./roles.ts";

/** §15.6 candidate shape shown in the picker. */
export interface AgentCandidate {
  readonly role: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly permissionClass: PermissionClass;
  /**
   * A heuristic ranking value, not a probability. §6.9 makes the same point about
   * tool discovery scores: this must not be presented as model confidence.
   */
  readonly suitability: number;
}

export interface CandidateSearchOptions {
  readonly limit?: number;
  /** Extra roles contributed by §15.13 custom agent definitions. */
  readonly customAgents?: readonly CustomAgentSummary[];
}

export interface CustomAgentSummary {
  readonly name: string;
  readonly description: string;
  readonly permissionClass: PermissionClass;
  readonly capabilities?: readonly string[];
}

/**
 * Rank roles against a natural-language query.
 *
 * §15.6 keeps the final decision with the root: this only orders the options.
 */
export function searchAgents(query: string, options: CandidateSearchOptions = {}): AgentCandidate[] {
  const tokens = tokenize(query);
  const candidates: AgentCandidate[] = [];

  for (const role of SUBAGENT_ROLES) {
    const definition = ROLE_DEFINITIONS[role];
    candidates.push({
      role,
      description: definition.description,
      capabilities: definition.capabilities,
      permissionClass: definition.permissionClass,
      suitability: score(tokens, [
        { text: role, weight: 3 },
        { text: definition.keywords.join(" "), weight: 2 },
        { text: definition.description, weight: 1 },
        { text: definition.capabilities.join(" "), weight: 1 },
      ]),
    });
  }

  for (const custom of options.customAgents ?? []) {
    candidates.push({
      role: custom.name,
      description: custom.description,
      capabilities: custom.capabilities ?? [],
      permissionClass: custom.permissionClass,
      suitability: score(tokens, [
        { text: custom.name, weight: 3 },
        { text: custom.description, weight: 1 },
        { text: (custom.capabilities ?? []).join(" "), weight: 1 },
      ]),
    });
  }

  return candidates
    .sort((a, b) => b.suitability - a.suitability || a.role.localeCompare(b.role))
    .slice(0, options.limit ?? 3);
}

function score(tokens: readonly string[], fields: ReadonlyArray<{ text: string; weight: number }>): number {
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const field of fields) {
    const haystack = tokenize(field.text);
    for (const token of tokens) {
      if (haystack.includes(token)) {
        total += field.weight;
      } else if (token.length >= 5 && haystack.some((word) => word.startsWith(token.slice(0, 5)))) {
        // Partial credit for a stemmed match: "delegation" should find "delegate".
        total += field.weight * 0.5;
      }
    }
  }
  // Normalize by query length so a long query does not inflate every candidate.
  return Math.round((total / tokens.length) * 1000) / 1000;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/** Signals behind the §15.5 delegation decision. */
export interface DelegationSignals {
  /** §15.5: the user asked for a subagent outright. SUB-001 makes this decisive. */
  readonly userRequestedSubagent: boolean;
  /** Independently explorable areas. Two or more favours delegation. */
  readonly independentAreas: number;
  /** A long read-only investigation that would pollute the main context. */
  readonly longInvestigation: boolean;
  /** A change an independent reviewer would add value to. */
  readonly reviewWorthy: boolean;
  /** Implementation and tests can be split. */
  readonly separableTests: boolean;
  /** §15.5 counter-signals. */
  readonly singleFileEdit: boolean;
  readonly needsConcurrentWriteToSameFile: boolean;
  readonly needsUserClarificationFirst: boolean;
  readonly budgetNearlyExhausted: boolean;
  readonly setupCostExceedsWork: boolean;
}

export interface DelegationDecision {
  readonly delegate: boolean;
  readonly reasons: string[];
  /** Roles worth spawning, in priority order. */
  readonly suggestedRoles: SubagentRole[];
}

export function defaultDelegationSignals(): DelegationSignals {
  return {
    userRequestedSubagent: false,
    independentAreas: 0,
    longInvestigation: false,
    reviewWorthy: false,
    separableTests: false,
    singleFileEdit: false,
    needsConcurrentWriteToSameFile: false,
    needsUserClarificationFirst: false,
    budgetNearlyExhausted: false,
    setupCostExceedsWork: false,
  };
}

/**
 * Decide whether to delegate (§15.5).
 *
 * The counter-signals are checked first and are absolute, with one exception: an
 * explicit user request wins over the *cost* heuristics. SUB-001 requires a task
 * card when the user asks for a subagent, so declining because the job looks small
 * would visibly ignore the instruction. A genuine blocker — needing clarification,
 * or two writers on one file — still refuses, because honouring the request that
 * way would either stall or corrupt the workspace.
 */
export function decideDelegation(signals: DelegationSignals): DelegationDecision {
  const reasons: string[] = [];

  if (signals.needsUserClarificationFirst) {
    return {
      delegate: false,
      reasons: ["the request needs user clarification before any work is delegated (§15.5)"],
      suggestedRoles: [],
    };
  }
  if (signals.needsConcurrentWriteToSameFile) {
    return {
      delegate: false,
      reasons: ["the work needs concurrent writes to one file, which the single-writer rule forbids (P6)"],
      suggestedRoles: [],
    };
  }

  if (signals.userRequestedSubagent) {
    reasons.push("the user explicitly asked for a subagent (SUB-001)");
    const roles: SubagentRole[] = [];
    if (signals.longInvestigation || signals.independentAreas >= 2) roles.push("explore");
    if (signals.separableTests) roles.push("test");
    if (signals.reviewWorthy) roles.push("reviewer");
    if (roles.length === 0) roles.push("executor");
    return { delegate: true, reasons, suggestedRoles: roles };
  }

  if (signals.budgetNearlyExhausted) {
    return {
      delegate: false,
      reasons: ["the turn budget is nearly exhausted; a child would not finish (§15.5)"],
      suggestedRoles: [],
    };
  }
  if (signals.singleFileEdit) {
    return {
      delegate: false,
      reasons: ["a single-file edit is cheaper to do directly (§15.5)"],
      suggestedRoles: [],
    };
  }
  if (signals.setupCostExceedsWork) {
    return {
      delegate: false,
      reasons: ["child setup would cost more than the work itself (§15.5)"],
      suggestedRoles: [],
    };
  }

  const suggested: SubagentRole[] = [];
  if (signals.independentAreas >= 2) {
    reasons.push(`${signals.independentAreas} areas can be investigated independently (§15.5)`);
    suggested.push("explore");
  }
  if (signals.longInvestigation) {
    reasons.push("a long read-only investigation would pollute the main context (§15.5)");
    if (!suggested.includes("explore")) suggested.push("explore");
  }
  if (signals.separableTests) {
    reasons.push("test selection and execution can be separated from implementation (§15.5)");
    suggested.push("test");
  }
  if (signals.reviewWorthy) {
    reasons.push("an independent reviewer adds value to this change (§15.5, §11.9)");
    suggested.push("reviewer");
  }

  return { delegate: suggested.length > 0, reasons, suggestedRoles: suggested };
}

/**
 * Render the §15.6 candidate list, matching §6.9's discovery block shape so the
 * two searches look and read the same way.
 */
export function renderAgentCandidates(
  query: string,
  candidates: readonly AgentCandidate[],
  totals: { total: number; active: number },
): string[] {
  const lines = [
    `✓ Agent Discovery: ${query}`,
    `│  ${candidates.length} matches · ${totals.active} active · ${totals.total} total`,
  ];
  candidates.forEach((candidate, index) => {
    const last = index === candidates.length - 1;
    lines.push(
      `${last ? "└─" : "├─"} ${candidate.role.padEnd(10)} score ${candidate.suitability.toFixed(3)} · ${candidate.permissionClass}`,
    );
    lines.push(`${last ? "  " : "│ "} ${candidate.description}`);
  });
  return lines;
}
