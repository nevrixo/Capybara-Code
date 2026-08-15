/**
 * Typed intermediate representation for the Context Compiler v2.
 *
 * The IR deliberately contains no provider rendering policy.  It is the shared
 * source of truth for selection, prompt assembly, routing, cache planning and
 * inspection.  Exact observations remain distinguishable from summaries and
 * every item carries enough provenance to explain or invalidate it later.
 */

import type { ModelInputItem } from "@cbc/provider-openai";

export const CONTEXT_IR_VERSION = "context-ir-v1" as const;

export type ContextKind =
  | "policy"
  | "tool_schema"
  | "instruction"
  | "task"
  | "plan"
  | "symbol"
  | "file_excerpt"
  | "diff"
  | "test_result"
  | "tool_observation"
  | "decision"
  | "assumption"
  | "memory"
  | "artifact_ref"
  | "dialogue";

export type ContextAuthority =
  | "system"
  | "user"
  | "workspace_maintainer"
  | "tool"
  | "external";

export type ContextTrust = "trusted" | "untrusted";
export type ContextFreshnessState = "fresh" | "stale" | "invalid" | "unknown";
export type ContextResolution =
  | "map"
  | "signature"
  | "snippet"
  | "full"
  | "summary"
  | "handle";

export interface ContextScope {
  readonly workspaceIdentity: string;
  readonly taskEpochId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
}

export interface ContextProvenance {
  readonly source: string;
  readonly locator: string;
  readonly digest: string;
  readonly observedAt: string;
  readonly parentEvidenceIds?: readonly string[];
}

export interface ContextFreshness {
  readonly state: ContextFreshnessState;
  readonly expiresAt?: string;
  readonly invalidatedBy?: readonly string[];
}

export interface ContextRepresentation {
  readonly resolution: ContextResolution;
  readonly exact: boolean;
  readonly text?: string;
  readonly artifactId?: string;
  readonly range?: { readonly startLine: number; readonly endLine: number };
}

export interface ContextUtility {
  readonly relevance: number;
  readonly coverage: number;
  readonly novelty: number;
  readonly recency: number;
  readonly confidence: number;
  readonly verificationValue: number;
  readonly riskPenalty: number;
}

/** A single independently attributable unit considered by the compiler. */
export interface ContextItem {
  readonly id: string;
  readonly kind: ContextKind;
  readonly authority: ContextAuthority;
  readonly trust: ContextTrust;
  readonly scope: ContextScope;
  readonly provenance: ContextProvenance;
  readonly freshness: ContextFreshness;
  readonly representation: ContextRepresentation;
  readonly estimatedTokens: number;
  readonly dependencies: readonly string[];
  readonly utility: ContextUtility;
}

export type ContextPhase = "orient" | "investigate" | "edit" | "verify" | "report";

export interface ContextBudget {
  /** Provider-advertised context window, input plus reserved output. */
  readonly modelContextLimit: number;
  /** Tokens that may never be consumed by compiler input. */
  readonly outputReserve: number;
  /** Absolute input ceiling, additionally clamped by the provider limit. */
  readonly hardInputLimit: number;
  /** Soft input target. Explicit/mandatory evidence may borrow up to the hard ceiling. */
  readonly targetInputTokens: number;
  /** Desired minimum number of selected exact-evidence tokens. */
  readonly exactEvidenceFloor: number;
  /** Maximum non-exact exploratory working-code tokens. */
  readonly explorationCeiling: number;
}

export interface ContextRequest {
  /** Optional caller identity. If absent the compiler derives a stable request digest. */
  readonly id?: string;
  readonly goal: string;
  readonly subgoal?: string;
  readonly phase: ContextPhase;
  readonly mentionedPaths: readonly string[];
  readonly mentionedSymbols: readonly string[];
  readonly changedPaths: readonly string[];
  readonly recentFailureRefs: readonly string[];
  readonly activePlanStep?: string;
  readonly budget: ContextBudget;

  /** Optional scoping fields used to reject cross-workspace candidates. */
  readonly workspaceIdentity?: string;
  readonly taskEpochId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  /** Observation time for the synthetic current-task item. It is never used in pack identity. */
  readonly observedAt?: string;
}

/** Prompt-facing allocation buckets. Names intentionally mirror ContextPack fields. */
export type ContextBucket =
  | "stable_prefix"
  | "task_state"
  | "working_code"
  | "exact_evidence"
  | "recent_dialogue"
  | "memory_handles";

/**
 * A materialized item. One item maps to one segment so provenance, taint and
 * explainability cannot be lost by string concatenation.
 */
export interface ContextSegment {
  readonly id: string;
  readonly bucket: Exclude<ContextBucket, "recent_dialogue">;
  readonly item: ContextItem;
  readonly text: string;
  readonly estimatedTokens: number;
  readonly stable: boolean;
  readonly exact: boolean;
  readonly cacheBreakpoint: boolean;
}

export type ContextInclusionReasonCode =
  | "current_task"
  | "mandatory"
  | "explicit_mention"
  | "changed_path"
  | "recent_failure"
  | "exact_evidence_floor"
  | "dependency"
  | "bucket_allocation"
  | "mmr_utility"
  | "fallback";

export type ContextExclusionReasonCode =
  | "invalid_freshness"
  | "stale_freshness"
  | "expired"
  | "workspace_mismatch"
  | "unmaterializable"
  | "duplicate_id"
  | "exact_duplicate"
  | "semantic_duplicate"
  | "missing_dependency"
  | "unavailable_dependency"
  | "hard_budget"
  | "target_budget"
  | "bucket_budget"
  | "exploration_ceiling"
  | "module_cap"
  | "lower_marginal_utility"
  | "candidate_limit"
  | "preparation_failed";

export interface ContextManifestInclusion {
  readonly id: string;
  readonly segmentId: string;
  readonly bucket: ContextBucket;
  readonly estimatedTokens: number;
  readonly score: number;
  /** Short primary explanation for event/CLI compatibility. */
  readonly reason: string;
  /** Machine-readable reasons, ordered by importance. */
  readonly reasons: readonly ContextInclusionReasonCode[];
  /** Dependency IDs after exact/semantic duplicate aliases are resolved. */
  readonly dependencies: readonly string[];
}

export interface ContextManifestExclusion {
  readonly id: string;
  readonly code: ContextExclusionReasonCode;
  readonly reason: string;
  readonly estimatedTokens: number;
  readonly bucket?: ContextBucket;
  readonly duplicateOf?: string;
  readonly missingDependencyIds?: readonly string[];
}

export interface ContextBudgetManifest {
  readonly modelContextLimit: number;
  readonly outputReserve: number;
  readonly providerInputLimit: number;
  readonly requestedHardInputLimit: number;
  readonly hardInputLimit: number;
  readonly requestedTargetInputTokens: number;
  readonly targetInputTokens: number;
  readonly exactEvidenceFloor: number;
  readonly explorationCeiling: number;
  readonly bucketTargets: Readonly<Record<ContextBucket, number>>;
  readonly bucketTokens: Readonly<Record<ContextBucket, number>>;
}

export interface ContextFallbackManifest {
  readonly used: boolean;
  readonly reason?: string;
  readonly droppedMandatoryItemIds: readonly string[];
}

export interface ContextManifest {
  readonly version: typeof CONTEXT_IR_VERSION;
  readonly requestId: string;
  readonly phase: ContextPhase;
  readonly workspaceIdentity?: string;
  readonly included: readonly ContextManifestInclusion[];
  readonly excluded: readonly ContextManifestExclusion[];
  readonly itemIds: readonly string[];
  readonly budget: ContextBudgetManifest;
  readonly estimatedTokens: number;
  readonly stablePrefixTokens: number;
  readonly exactEvidenceTokens: number;
  readonly relevantTokenDensity: number;
  readonly fallback: ContextFallbackManifest;
  /** SHA-256 over deterministic request, decision and segment identities. */
  readonly digest: string;
}

export interface ContextPack {
  readonly id: string;
  readonly stablePrefix: readonly ContextSegment[];
  readonly taskState: readonly ContextSegment[];
  readonly workingCode: readonly ContextSegment[];
  readonly exactEvidence: readonly ContextSegment[];
  readonly recentDialogue: readonly ModelInputItem[];
  readonly memoryHandles: readonly ContextSegment[];
  readonly manifest: ContextManifest;
  readonly estimatedTokens: number;
  readonly stablePrefixTokens: number;
  /** Flattened segment indices after which an assembler may place a cache breakpoint. */
  readonly cacheBreakpoints: readonly number[];
}
