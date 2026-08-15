/**
 * Model-neutral domain types — P1-05.
 *
 * These describe inference itself (roles, reasoning vocabulary, model
 * metadata, and the neutral contracts shared across packages), independent of
 * any provider's wire format. `@cbc/provider-openai` and `@cbc/agent-kernel`
 * re-export them so existing call sites keep working, while `context-engine`,
 * `skills`, and `subagents` depend on this package directly instead of on the
 * kernel or a provider adapter.
 */

/** The agent a turn or a delegated task runs as (§10.10, §15.7). */
export type AgentRole =
  | "root"
  | "explore"
  | "planner"
  | "architect"
  | "executor"
  | "refactorer"
  | "reviewer"
  | "test";

/**
 * §10.10 default soft context budgets per agent role. The status bar percentage
 * is against these, not the model window.
 */
export const SOFT_CONTEXT_BUDGETS = {
  root: 96_000,
  planner: 48_000,
  /**
   * Architecture review reads widely — it is the role whose job is to see the
   * blast radius — so it gets the largest child budget of the read-only roles.
   */
  architect: 64_000,
  explore: 32_000,
  executor: 48_000,
  /** A refactorer must hold the call sites it is about to move, not just one file. */
  refactorer: 56_000,
  reviewer: 64_000,
  test: 24_000,
} as const;

/** Reasoning effort ladder, provider-neutral (§10.4). */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** Reasoning mode, provider-neutral (§10.4). */
export type ReasoningMode = "standard" | "pro";

/** How much reasoning context a request carries (§10.6). */
export type ReasoningContextScope = "current_turn" | "all_turns";

/**
 * Provider-neutral model metadata. The OpenAI adapter derives its registry from
 * the bundled capability manifest, but the shape itself is not OpenAI-specific.
 */
export interface ModelDescriptor {
  id: string;
  family: string;
  aliases: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts: string[];
  reasoningModes: string[];
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsReasoningSummary: boolean;
  supportsPromptCacheBreakpoints: boolean;
  sourceVersion: string;
}

/**
 * Bundled knowledge and live availability are different facts. A network
 * failure must not turn the bundled list into "available" — §24.5 forbids
 * overclaiming, so the state that could not be checked says so.
 */
export type ModelAvailability = "known" | "reachable" | "unavailable" | "unverified";

export interface ModelAvailabilityReport {
  readonly model: ModelDescriptor;
  readonly availability: ModelAvailability;
}

// ---------------------------------------------------------------------------
// Neutral contracts shared across packages
// ---------------------------------------------------------------------------

/** §18.2 a trust-gated project instruction file, as the context engine sees it. */
export interface ProjectInstructions {
  /** Source path, shown in the context inspector. */
  readonly path: string;
  readonly content: string;
}

/** §16.4 stage 1: Skill metadata, never the full body. */
export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly source: string;
  readonly risk?: string;
}
