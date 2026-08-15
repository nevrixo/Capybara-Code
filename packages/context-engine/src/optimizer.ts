/**
 * P4 learned-optimization boundary.
 *
 * Learned components are deliberately optional and untrusted.  They may propose
 * a compact state or context operations, but deterministic validation is the
 * only path into the working view.  A rejected/throwing adapter always falls
 * back to the extractive P3 state (compression) or a conservative keep/no-op
 * policy (context operations).  Journal/evidence ownership remains outside this
 * module.
 */

import { createHash } from "node:crypto";

import {
  structuredCompactStateIssues,
  validateContextOp,
  type ContextOp,
  type StructuredCompactStateV2,
} from "./context-ops.ts";

export const OPTIMIZER_SCHEMA_VERSION = "1" as const;
export const DEFAULT_MAX_SUMMARY_CHARACTERS = 256 * 1024;
export const DEFAULT_MAX_CONTEXT_OPERATIONS = 32;
export const MAX_VALIDATION_ISSUES = 64;

export type ContextOperationKind = ContextOp["kind"];

// ---------------------------------------------------------------------------
// Failure trajectories -> compression guidelines
// ---------------------------------------------------------------------------

export type OptimizationFailureKind =
  | "critical_text_dropped"
  | "decision_dropped"
  | "unresolved_work_dropped"
  | "evidence_reference_dropped"
  | "unsupported_summary_claim"
  | "stale_evidence_retained"
  | "summary_budget_exceeded"
  | "redundant_summary_content"
  | "invalid_context_operation"
  | "unsafe_context_operation";

/** One validator/eval failure observed in an offline trajectory. */
export interface OptimizationFailure {
  readonly kind: OptimizationFailureKind;
  /** Exact source strings implicated by the failure; never generated rationale. */
  readonly texts?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly operationKinds?: readonly ContextOperationKind[];
}

/**
 * A trajectory contains only externally observable failures.  It intentionally
 * does not contain hidden model reasoning or prompts.
 */
export interface FailureTrajectory {
  readonly id: string;
  readonly failures: readonly OptimizationFailure[];
}

export type CompressionGuidelineKind =
  | "preserve_content"
  | "require_extractive_summary"
  | "exclude_stale_evidence"
  | "enforce_summary_budget"
  | "deduplicate_summary"
  | "forbid_operations"
  | "conservative_operations";

/** A deterministic, evidence-addressable rule distilled from failed evals. */
export interface CompressionGuideline {
  readonly id: `guideline-${string}`;
  readonly schemaVersion: typeof OPTIMIZER_SCHEMA_VERSION;
  readonly kind: CompressionGuidelineKind;
  readonly priority: number;
  readonly support: number;
  readonly texts: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly operationKinds: readonly ContextOperationKind[];
  readonly sourceTrajectoryIds: readonly string[];
  readonly rationale: string;
}

interface GuidelineSeed {
  readonly kind: CompressionGuidelineKind;
  readonly texts: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly operationKinds: readonly ContextOperationKind[];
}

const OPERATION_KINDS: readonly ContextOperationKind[] = [
  "compress",
  "delete",
  "keep",
  "offload",
  "recall",
  "rollback",
  "snippet",
];

const DESTRUCTIVE_OPERATION_KINDS: readonly ContextOperationKind[] = [
  "compress",
  "delete",
  "offload",
  "rollback",
  "snippet",
];

const GUIDELINE_PRIORITY: Readonly<Record<CompressionGuidelineKind, number>> = {
  preserve_content: 100,
  require_extractive_summary: 100,
  exclude_stale_evidence: 100,
  enforce_summary_budget: 80,
  deduplicate_summary: 60,
  forbid_operations: 100,
  conservative_operations: 100,
};

const GUIDELINE_RATIONALE: Readonly<Record<CompressionGuidelineKind, string>> = {
  preserve_content: "failed trajectories lost required source content or provenance",
  require_extractive_summary: "failed trajectories introduced a claim not present in the source",
  exclude_stale_evidence: "failed trajectories retained evidence that was no longer fresh",
  enforce_summary_budget: "failed trajectories exceeded the declared summary objective",
  deduplicate_summary: "failed trajectories spent budget on repeated content",
  forbid_operations: "failed trajectories proposed a specifically unsafe operation kind",
  conservative_operations: "failed trajectories proposed an invalid or unsafe operation batch",
};

/**
 * Group equivalent failures and emit stable guidelines.  Input order, duplicate
 * failure rows, and duplicate selector IDs cannot change the output.
 */
export function extractCompressionGuidelines(
  trajectories: readonly FailureTrajectory[],
): readonly CompressionGuideline[] {
  const grouped = new Map<string, { seed: GuidelineSeed; trajectories: Set<string> }>();
  const orderedTrajectories = [...trajectories]
    .filter((trajectory) => isUsableIdentifier(trajectory.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const trajectory of orderedTrajectories) {
    const seenInTrajectory = new Set<string>();
    for (const failure of trajectory.failures) {
      const seed = guidelineSeed(failure);
      if (seed === undefined) continue;
      const key = stableJson(seed);
      if (seenInTrajectory.has(key)) continue;
      seenInTrajectory.add(key);
      const current = grouped.get(key) ?? { seed, trajectories: new Set<string>() };
      current.trajectories.add(trajectory.id);
      grouped.set(key, current);
    }
  }

  return [...grouped.values()]
    .map(({ seed, trajectories }) => {
      const sourceTrajectoryIds = [...trajectories].sort();
      const identity = stableJson(seed);
      return deepFreeze({
        id: `guideline-${createHash("sha256").update(identity).digest("hex")}` as const,
        schemaVersion: OPTIMIZER_SCHEMA_VERSION,
        kind: seed.kind,
        priority: GUIDELINE_PRIORITY[seed.kind],
        support: sourceTrajectoryIds.length,
        texts: seed.texts,
        evidenceIds: seed.evidenceIds,
        operationKinds: seed.operationKinds,
        sourceTrajectoryIds,
        rationale: GUIDELINE_RATIONALE[seed.kind],
      });
    })
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.support - left.support ||
        left.id.localeCompare(right.id),
    );
}

function guidelineSeed(failure: OptimizationFailure): GuidelineSeed | undefined {
  const texts = canonicalStrings(failure.texts ?? []);
  const evidenceIds = canonicalStrings(failure.evidenceIds ?? []).filter(isUsableIdentifier);
  const operationKinds = canonicalOperationKinds(failure.operationKinds ?? []);
  switch (failure.kind) {
    case "critical_text_dropped":
    case "decision_dropped":
    case "unresolved_work_dropped":
    case "evidence_reference_dropped":
      return {
        kind: "preserve_content",
        texts,
        evidenceIds,
        operationKinds: [],
      };
    case "unsupported_summary_claim":
      return {
        kind: "require_extractive_summary",
        texts: [],
        evidenceIds: [],
        operationKinds: [],
      };
    case "stale_evidence_retained":
      return {
        kind: "exclude_stale_evidence",
        texts: [],
        evidenceIds,
        operationKinds: [],
      };
    case "summary_budget_exceeded":
      return {
        kind: "enforce_summary_budget",
        texts: [],
        evidenceIds: [],
        operationKinds: [],
      };
    case "redundant_summary_content":
      return {
        kind: "deduplicate_summary",
        texts,
        evidenceIds: [],
        operationKinds: [],
      };
    case "invalid_context_operation":
    case "unsafe_context_operation":
      return operationKinds.length > 0
        ? {
            kind: "forbid_operations",
            texts: [],
            evidenceIds: [],
            operationKinds,
          }
        : {
            kind: "conservative_operations",
            texts: [],
            evidenceIds: [],
            operationKinds: [...DESTRUCTIVE_OPERATION_KINDS],
          };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Compression boundary
// ---------------------------------------------------------------------------

export interface CompressionRequest {
  /** Trusted deterministic state produced by the extractive P3 compactor. */
  readonly extractiveBaseline: StructuredCompactStateV2;
  /** Fresh evidence IDs that a learned summary is allowed to reference. */
  readonly allowedEvidenceIds?: readonly string[];
  readonly requiredEvidenceIds?: readonly string[];
  /** Exact baseline strings that must survive compression. */
  readonly requiredTexts?: readonly string[];
  /** A hard limit for learned candidates. The fallback is allowed to miss it. */
  readonly maxSummaryCharacters?: number;
  readonly guidelines?: readonly CompressionGuideline[];
}

export interface OptimizerValidationIssue {
  readonly code:
    | "invalid_input"
    | "invalid_shape"
    | "unknown_reference"
    | "not_extractive"
    | "missing_required_content"
    | "budget_exceeded"
    | "unsafe_operation"
    | "conflicting_operations"
    | "adapter_unavailable"
    | "adapter_failed";
  readonly path: string;
  readonly message: string;
}

export type OptimizerValidationResult<T> =
  | { readonly valid: true; readonly value: T; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly OptimizerValidationIssue[] };

interface PreparedCompressionRequest {
  readonly baseline: StructuredCompactStateV2;
  readonly allowedEvidenceIds: ReadonlySet<string>;
  readonly requiredEvidenceIds: ReadonlySet<string>;
  readonly forbiddenEvidenceIds: ReadonlySet<string>;
  readonly requiredTexts: ReadonlySet<string>;
  readonly maxSummaryCharacters: number;
}

/**
 * Validate a model-produced StructuredCompactStateV2.  Shape validation is
 * delegated to P3, then this boundary enforces fresh references, extractivity,
 * critical-field survival, and the learned-output size limit.
 */
export function validateCompressionSummary(
  candidate: unknown,
  request: CompressionRequest,
): OptimizerValidationResult<StructuredCompactStateV2> {
  try {
    const prepared = prepareCompressionRequest(request);
    const issues: OptimizerValidationIssue[] = [];
    for (const issue of strictStructuredStateShapeIssues(candidate)) {
      pushIssue(issues, {
        code: "invalid_shape",
        path: "$",
        message: issue,
      });
    }
    if (issues.length > 0) return invalid(issues);
    for (const issue of structuredCompactStateIssues(candidate, prepared.allowedEvidenceIds)) {
      pushIssue(issues, {
        code: "invalid_shape",
        path: "$",
        message: issue,
      });
    }
    if (issues.length > 0) return invalid(issues);

    const summary = cloneJson(candidate) as StructuredCompactStateV2;
    validateExtractivity(summary, prepared, issues);
    const characters = stableJson(summary).length;
    if (characters > prepared.maxSummaryCharacters) {
      pushIssue(issues, {
        code: "budget_exceeded",
        path: "$",
        message: `candidate has ${characters} characters; maximum is ${prepared.maxSummaryCharacters}`,
      });
    }
    return issues.length === 0 ? valid(deepFreeze(summary)) : invalid(issues);
  } catch {
    return invalid([{
      code: "invalid_input",
      path: "$",
      message: "compression request or candidate is not valid deterministic data",
    }]);
  }
}

/**
 * Guaranteed fail-safe for every valid request.  It returns a defensive frozen
 * clone of the caller's deterministic extractive baseline and never invokes an
 * adapter.  The learned target is intentionally soft for this path: preserving
 * critical facts wins over a smaller summary.
 */
export function createExtractiveFallback(
  request: CompressionRequest,
): StructuredCompactStateV2 {
  return prepareCompressionRequest(request).baseline;
}

/** Stable size used by offline evaluation; unlike object insertion order it is reproducible. */
export function compressionSummaryCharacters(summary: StructuredCompactStateV2): number {
  return stableJson(summary).length;
}

function prepareCompressionRequest(request: CompressionRequest): PreparedCompressionRequest {
  if (!isPlainObject(request)) throw new TypeError("invalid compression request");
  const rawBaselineIssues = [
    ...strictStructuredStateShapeIssues(request.extractiveBaseline),
    ...structuredCompactStateIssues(request.extractiveBaseline),
  ];
  if (rawBaselineIssues.length > 0) throw new TypeError("invalid extractive baseline");
  const baseline = deepFreeze(cloneJson(request.extractiveBaseline) as StructuredCompactStateV2);
  const inferredEvidence = collectEvidenceIds(baseline);
  const allowedEvidence = request.allowedEvidenceIds === undefined
    ? inferredEvidence
    : strictIdentifierSet(request.allowedEvidenceIds);
  const requiredEvidence = strictIdentifierSet(request.requiredEvidenceIds ?? []);
  const requiredTexts = strictTextSet(request.requiredTexts ?? []);
  const forbiddenEvidence = new Set<string>();

  for (const guideline of request.guidelines ?? []) {
    if (guideline.kind === "preserve_content") {
      for (const text of guideline.texts) requiredTexts.add(text);
      for (const evidenceId of guideline.evidenceIds) requiredEvidence.add(evidenceId);
    } else if (guideline.kind === "exclude_stale_evidence") {
      for (const evidenceId of guideline.evidenceIds) forbiddenEvidence.add(evidenceId);
    }
  }

  for (const evidenceId of collectEvidenceIds(baseline)) {
    if (!allowedEvidence.has(evidenceId) || forbiddenEvidence.has(evidenceId)) {
      throw new TypeError("extractive fallback contains unavailable evidence");
    }
  }
  for (const evidenceId of requiredEvidence) {
    if (!allowedEvidence.has(evidenceId) || forbiddenEvidence.has(evidenceId)) {
      throw new TypeError("required evidence is unavailable");
    }
  }
  const baselineTexts = collectSummaryTexts(baseline);
  for (const text of requiredTexts) {
    if (!baselineTexts.has(text)) throw new TypeError("required text is absent from baseline");
  }

  const maximum = request.maxSummaryCharacters ?? DEFAULT_MAX_SUMMARY_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("invalid maximum summary characters");
  }
  return {
    baseline,
    allowedEvidenceIds: allowedEvidence,
    requiredEvidenceIds: requiredEvidence,
    forbiddenEvidenceIds: forbiddenEvidence,
    requiredTexts,
    maxSummaryCharacters: maximum,
  };
}

function validateExtractivity(
  candidate: StructuredCompactStateV2,
  prepared: PreparedCompressionRequest,
  issues: OptimizerValidationIssue[],
): void {
  const source = prepared.baseline;
  if (candidate.task.goal !== source.task.goal) {
    pushIssue(issues, {
      code: "missing_required_content",
      path: "$.task.goal",
      message: "the original task goal must be preserved exactly",
    });
  }

  validateStringSubset(candidate.task.constraints, source.task.constraints, "$.task.constraints", issues);
  validateStringSubset(
    candidate.task.acceptanceCriteria,
    source.task.acceptanceCriteria,
    "$.task.acceptanceCriteria",
    issues,
  );
  requireAllStrings(candidate.task.constraints, source.task.constraints, "$.task.constraints", issues);
  requireAllStrings(
    candidate.task.acceptanceCriteria,
    source.task.acceptanceCriteria,
    "$.task.acceptanceCriteria",
    issues,
  );

  validateRecordSubset(candidate.decisions, source.decisions, "$.decisions", issues);
  validateRecordSubset(candidate.assumptions, source.assumptions, "$.assumptions", issues);
  validateRecordSubset(candidate.changedSymbols, source.changedSymbols, "$.changedSymbols", issues);
  validateRecordSubset(candidate.verification, source.verification, "$.verification", issues);
  validateRecordSubset(candidate.unresolved, source.unresolved, "$.unresolved", issues);
  validateStringSubset(candidate.memoryHandles, source.memoryHandles, "$.memoryHandles", issues);

  requireRecordSubset(
    candidate.decisions,
    source.decisions.filter((decision) => decision.status === "active"),
    "$.decisions",
    "active decisions",
    issues,
  );
  requireRecordSubset(
    candidate.changedSymbols,
    source.changedSymbols,
    "$.changedSymbols",
    "changed symbols",
    issues,
  );
  requireRecordSubset(
    candidate.verification,
    source.verification.filter((entry) => entry.status !== "passed"),
    "$.verification",
    "failed or pending verification",
    issues,
  );
  requireRecordSubset(
    candidate.unresolved,
    source.unresolved,
    "$.unresolved",
    "unresolved work",
    issues,
  );
  requireAllStrings(candidate.memoryHandles, source.memoryHandles, "$.memoryHandles", issues);

  const candidateEvidence = collectEvidenceIds(candidate);
  for (const evidenceId of candidateEvidence) {
    if (!prepared.allowedEvidenceIds.has(evidenceId)) {
      pushIssue(issues, {
        code: "unknown_reference",
        path: "$",
        message: `summary references unavailable evidence ${evidenceId}`,
      });
    }
    if (prepared.forbiddenEvidenceIds.has(evidenceId)) {
      pushIssue(issues, {
        code: "unknown_reference",
        path: "$",
        message: `summary references excluded evidence ${evidenceId}`,
      });
    }
  }
  for (const evidenceId of prepared.requiredEvidenceIds) {
    if (!candidateEvidence.has(evidenceId)) {
      pushIssue(issues, {
        code: "missing_required_content",
        path: "$",
        message: `required evidence ${evidenceId} was dropped`,
      });
    }
  }

  const candidateTexts = collectSummaryTexts(candidate);
  for (const text of prepared.requiredTexts) {
    if (!candidateTexts.has(text)) {
      pushIssue(issues, {
        code: "missing_required_content",
        path: "$",
        message: "a required exact source string was dropped",
      });
    }
  }
}

function validateStringSubset(
  candidate: readonly string[],
  source: readonly string[],
  path: string,
  issues: OptimizerValidationIssue[],
): void {
  const allowed = new Set(source);
  for (const value of candidate) {
    if (!allowed.has(value)) {
      pushIssue(issues, {
        code: "not_extractive",
        path,
        message: "candidate contains text that is not an exact source entry",
      });
    }
  }
}

function requireAllStrings(
  candidate: readonly string[],
  required: readonly string[],
  path: string,
  issues: OptimizerValidationIssue[],
): void {
  const present = new Set(candidate);
  if (required.some((value) => !present.has(value))) {
    pushIssue(issues, {
      code: "missing_required_content",
      path,
      message: "candidate dropped mandatory extractive entries",
    });
  }
}

function recordKey(value: unknown): string {
  if (!isPlainObject(value)) return stableJson(value);
  const record = value as Readonly<Record<string, unknown>>;
  const normalized = "evidenceIds" in record && Array.isArray(record.evidenceIds)
    ? { ...record, evidenceIds: canonicalStrings(record.evidenceIds.filter(isString)) }
    : record;
  return stableJson(normalized);
}

function validateRecordSubset<T>(
  candidate: readonly T[],
  source: readonly T[],
  path: string,
  issues: OptimizerValidationIssue[],
): void {
  const allowed = new Set(source.map(recordKey));
  for (const value of candidate) {
    if (!allowed.has(recordKey(value))) {
      pushIssue(issues, {
        code: "not_extractive",
        path,
        message: "candidate contains a structured entry not present in the source",
      });
    }
  }
}

function requireRecordSubset<T>(
  candidate: readonly T[],
  required: readonly T[],
  path: string,
  label: string,
  issues: OptimizerValidationIssue[],
): void {
  const present = new Set(candidate.map(recordKey));
  if (required.some((value) => !present.has(recordKey(value)))) {
    pushIssue(issues, {
      code: "missing_required_content",
      path,
      message: `candidate dropped mandatory ${label}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Context-operation learned boundary
// ---------------------------------------------------------------------------

export interface ContextLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface ContextOperationValidationContext {
  readonly availableItemIds: readonly string[];
  readonly protectedItemIds?: readonly string[];
  readonly availableEvidenceIds?: readonly string[];
  readonly requiredEvidenceIds?: readonly string[];
  readonly staleEvidenceIds?: readonly string[];
  readonly checkpointIds?: readonly string[];
  readonly artifactIds?: readonly string[];
  readonly lineRanges?: Readonly<Record<string, ContextLineRange>>;
  readonly compression?: CompressionRequest;
  readonly guidelines?: readonly CompressionGuideline[];
  readonly maxOperations?: number;
}

interface PreparedOperationContext {
  readonly availableItemIds: ReadonlySet<string>;
  readonly protectedItemIds: ReadonlySet<string>;
  readonly availableEvidenceIds: ReadonlySet<string>;
  readonly requiredEvidenceIds: ReadonlySet<string>;
  readonly staleEvidenceIds: ReadonlySet<string>;
  readonly checkpointIds: ReadonlySet<string>;
  readonly artifactIds: ReadonlySet<string>;
  readonly lineRanges: ReadonlyMap<string, ContextLineRange>;
  readonly forbiddenKinds: ReadonlySet<ContextOperationKind>;
  readonly compression?: CompressionRequest;
  readonly maxOperations: number;
}

/** Validate a complete learned batch atomically; one bad operation rejects all. */
export function validateContextOperations(
  candidate: unknown,
  context: ContextOperationValidationContext,
): OptimizerValidationResult<readonly ContextOp[]> {
  try {
    const boundary = prepareOperationContext(context);
    const issues: OptimizerValidationIssue[] = [];
    if (!isPlainDataArray(candidate)) {
      return invalid([{
        code: "invalid_shape",
        path: "$",
        message: "context policy output must be a plain data array",
      }]);
    }
    if (candidate.length > boundary.maxOperations) {
      pushIssue(issues, {
        code: "budget_exceeded",
        path: "$",
        message: `operation batch exceeds maximum of ${boundary.maxOperations}`,
      });
    }

    const operations: ContextOp[] = [];
    const keepTargets = new Set<string>();
    const transformedTargets = new Set<string>();
    const recalledEvidence = new Set<string>();
    let rollbackCount = 0;

    const inspectedOperations = Math.min(candidate.length, boundary.maxOperations);
    for (let index = 0; index < inspectedOperations && issues.length < MAX_VALIDATION_ISSUES; index += 1) {
      const raw = candidate[index];
      const path = `$[${index}]`;
      if (!isPlainObject(raw) || typeof raw.kind !== "string") {
        pushIssue(issues, { code: "invalid_shape", path, message: "operation must be a plain tagged object" });
        continue;
      }
      const kind = raw.kind as ContextOperationKind;
      if (!OPERATION_KINDS.includes(kind)) {
        pushIssue(issues, { code: "invalid_shape", path, message: "operation kind is not supported" });
        continue;
      }
      if (boundary.forbiddenKinds.has(kind)) {
        pushIssue(issues, { code: "unsafe_operation", path, message: `operation kind ${kind} is forbidden by guideline` });
      }

      const structuralIssues = validateContextOp(raw, {
        allowedItemIds: boundary.availableItemIds,
        allowedEvidenceIds: boundary.availableEvidenceIds,
        allowedCheckpointIds: boundary.checkpointIds,
      });
      for (const issue of structuralIssues) {
        pushIssue(issues, { code: "invalid_shape", path, message: issue });
      }
      validateExactOperationShape(raw, kind, path, issues);
      if (structuralIssues.length > 0) continue;

      switch (kind) {
        case "keep": {
          const ids = strictCandidateIdentifiers(raw.ids, `${path}.ids`, issues);
          noteTargets(ids, keepTargets, `${path}.ids`, "keep", issues);
          break;
        }
        case "snippet": {
          const id = typeof raw.id === "string" ? raw.id : "";
          rejectProtected(id, boundary, path, issues);
          noteTargets([id], transformedTargets, path, "transform", issues);
          validateSnippetRange(raw.range, id, boundary, `${path}.range`, issues);
          break;
        }
        case "compress": {
          const ids = strictCandidateIdentifiers(raw.ids, `${path}.ids`, issues);
          for (const id of ids) rejectProtected(id, boundary, path, issues);
          noteTargets(ids, transformedTargets, `${path}.ids`, "transform", issues);
          if (boundary.compression === undefined) {
            pushIssue(issues, {
              code: "unsafe_operation",
              path: `${path}.into`,
              message: "compress operations require a compression validation request",
            });
          } else {
            const summary = validateCompressionSummary(raw.into, boundary.compression);
            for (const issue of summary.issues) pushIssue(issues, { ...issue, path: `${path}.into${issue.path.slice(1)}` });
          }
          break;
        }
        case "delete": {
          const ids = strictCandidateIdentifiers(raw.ids, `${path}.ids`, issues);
          for (const id of ids) rejectProtected(id, boundary, path, issues);
          noteTargets(ids, transformedTargets, `${path}.ids`, "transform", issues);
          if (typeof raw.reason !== "string" || raw.reason.trim().length === 0 || raw.reason.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw.reason)) {
            pushIssue(issues, { code: "invalid_shape", path: `${path}.reason`, message: "delete reason must be bounded printable text" });
          }
          break;
        }
        case "rollback": {
          rollbackCount += 1;
          const preserved = strictCandidateIdentifiers(raw.preserveEvidence, `${path}.preserveEvidence`, issues, true);
          const present = new Set(preserved);
          for (const evidenceId of boundary.requiredEvidenceIds) {
            if (!present.has(evidenceId)) {
              pushIssue(issues, {
                code: "unsafe_operation",
                path: `${path}.preserveEvidence`,
                message: `rollback must preserve required evidence ${evidenceId}`,
              });
            }
          }
          break;
        }
        case "offload": {
          const ids = strictCandidateIdentifiers(raw.ids, `${path}.ids`, issues);
          for (const id of ids) rejectProtected(id, boundary, path, issues);
          noteTargets(ids, transformedTargets, `${path}.ids`, "transform", issues);
          if (typeof raw.artifactId !== "string" || !boundary.artifactIds.has(raw.artifactId)) {
            pushIssue(issues, { code: "unknown_reference", path: `${path}.artifactId`, message: "offload artifact is not allowlisted" });
          }
          break;
        }
        case "recall": {
          const evidenceIds = strictCandidateIdentifiers(raw.evidenceIds, `${path}.evidenceIds`, issues);
          for (const evidenceId of evidenceIds) {
            if (boundary.staleEvidenceIds.has(evidenceId)) {
              pushIssue(issues, { code: "unsafe_operation", path: `${path}.evidenceIds`, message: `cannot recall stale evidence ${evidenceId}` });
            }
            if (recalledEvidence.has(evidenceId)) {
              pushIssue(issues, { code: "conflicting_operations", path: `${path}.evidenceIds`, message: `evidence ${evidenceId} is recalled more than once` });
            }
            recalledEvidence.add(evidenceId);
          }
          break;
        }
        default:
          break;
      }
      operations.push(cloneJson(raw) as ContextOp);
    }

    for (const id of keepTargets) {
      if (transformedTargets.has(id)) {
        pushIssue(issues, { code: "conflicting_operations", path: "$", message: `item ${id} is both kept and transformed` });
      }
    }
    if (rollbackCount > 1 || (rollbackCount === 1 && candidate.length !== 1)) {
      pushIssue(issues, {
        code: "conflicting_operations",
        path: "$",
        message: "rollback must be the sole operation in an atomic learned batch",
      });
    }
    return issues.length === 0 ? valid(deepFreeze(operations)) : invalid(issues);
  } catch {
    return invalid([{
      code: "invalid_input",
      path: "$",
      message: "operation context or candidate is not valid deterministic data",
    }]);
  }
}

/** Conservative deterministic policy: only pin protected items; never removes data. */
export function createConservativeContextFallback(
  context: ContextOperationValidationContext,
): readonly ContextOp[] {
  const prepared = prepareOperationContext(context);
  if (prepared.maxOperations === 0 || prepared.protectedItemIds.size === 0) return deepFreeze([] as ContextOp[]);
  return deepFreeze([{
    kind: "keep",
    ids: [...prepared.protectedItemIds].sort(),
  }] as ContextOp[]);
}

function prepareOperationContext(context: ContextOperationValidationContext): PreparedOperationContext {
  if (!isPlainObject(context)) throw new TypeError("invalid operation context");
  const availableItemIds = strictIdentifierSet(context.availableItemIds);
  const protectedItemIds = strictIdentifierSet(context.protectedItemIds ?? []);
  for (const id of protectedItemIds) if (!availableItemIds.has(id)) throw new TypeError("protected item is unavailable");
  const availableEvidenceIds = strictIdentifierSet(context.availableEvidenceIds ?? []);
  const requiredEvidenceIds = strictIdentifierSet(context.requiredEvidenceIds ?? []);
  const staleEvidenceIds = strictIdentifierSet(context.staleEvidenceIds ?? []);
  for (const id of requiredEvidenceIds) {
    if (!availableEvidenceIds.has(id) || staleEvidenceIds.has(id)) throw new TypeError("required evidence is unavailable");
  }
  const checkpointIds = strictIdentifierSet(context.checkpointIds ?? []);
  const artifactIds = strictIdentifierSet(context.artifactIds ?? []);
  const lineRanges = new Map<string, ContextLineRange>();
  for (const [id, range] of Object.entries(context.lineRanges ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (!availableItemIds.has(id) || !isLineRange(range)) throw new TypeError("invalid line range boundary");
    lineRanges.set(id, { startLine: range.startLine, endLine: range.endLine });
  }
  const forbiddenKinds = new Set<ContextOperationKind>();
  for (const guideline of context.guidelines ?? []) {
    if (guideline.kind === "forbid_operations" || guideline.kind === "conservative_operations") {
      for (const kind of guideline.operationKinds) forbiddenKinds.add(kind);
    }
  }
  const maximum = context.maxOperations ?? DEFAULT_MAX_CONTEXT_OPERATIONS;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1_024) throw new TypeError("invalid maximum operations");
  return {
    availableItemIds,
    protectedItemIds,
    availableEvidenceIds,
    requiredEvidenceIds,
    staleEvidenceIds,
    checkpointIds,
    artifactIds,
    lineRanges,
    forbiddenKinds,
    ...(context.compression !== undefined ? { compression: context.compression } : {}),
    maxOperations: maximum,
  };
}

function validateExactOperationShape(
  operation: Readonly<Record<string, unknown>>,
  kind: ContextOperationKind,
  path: string,
  issues: OptimizerValidationIssue[],
): void {
  const expected: Readonly<Record<ContextOperationKind, readonly string[]>> = {
    keep: ["ids", "kind"],
    snippet: ["id", "kind", "range"],
    compress: ["ids", "into", "kind"],
    delete: ["ids", "kind", "reason"],
    rollback: ["checkpointId", "kind", "preserveEvidence"],
    offload: ["artifactId", "ids", "kind"],
    recall: ["evidenceIds", "kind"],
  };
  const actual = Reflect.ownKeys(operation);
  if (actual.some((key) => typeof key !== "string") || canonicalStrings(actual.filter(isString)).join("\u0000") !== expected[kind].join("\u0000")) {
    pushIssue(issues, { code: "invalid_shape", path, message: "operation has missing or unknown fields" });
  }
}

function strictCandidateIdentifiers(
  value: unknown,
  path: string,
  issues: OptimizerValidationIssue[],
  allowEmpty = false,
): readonly string[] {
  if (!isPlainDataArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => !isUsableIdentifier(entry))) {
    pushIssue(issues, { code: "invalid_shape", path, message: `identifier list must be a${allowEmpty ? "" : " non-empty"} string array` });
    return [];
  }
  const strings = value as string[];
  if (canonicalStrings(strings).join("\u0000") !== strings.join("\u0000")) {
    pushIssue(issues, { code: "invalid_shape", path, message: "identifier list must be sorted and duplicate-free" });
  }
  return strings;
}

function noteTargets(
  ids: readonly string[],
  targets: Set<string>,
  path: string,
  label: string,
  issues: OptimizerValidationIssue[],
): void {
  for (const id of ids) {
    if (targets.has(id)) {
      pushIssue(issues, { code: "conflicting_operations", path, message: `item ${id} has more than one ${label} operation` });
    }
    targets.add(id);
  }
}

function rejectProtected(
  id: string,
  boundary: PreparedOperationContext,
  path: string,
  issues: OptimizerValidationIssue[],
): void {
  if (boundary.protectedItemIds.has(id)) {
    pushIssue(issues, { code: "unsafe_operation", path, message: `protected item ${id} cannot be reduced or removed` });
  }
}

function validateSnippetRange(
  value: unknown,
  id: string,
  boundary: PreparedOperationContext,
  path: string,
  issues: OptimizerValidationIssue[],
): void {
  if (!isLineRange(value) || !hasExactKeys(value as unknown as Record<string, unknown>, ["endLine", "startLine"])) {
    pushIssue(issues, { code: "invalid_shape", path, message: "snippet range must contain exact positive line bounds" });
    return;
  }
  const allowed = boundary.lineRanges.get(id);
  if (allowed !== undefined && (value.startLine < allowed.startLine || value.endLine > allowed.endLine)) {
    pushIssue(issues, { code: "unsafe_operation", path, message: "snippet range is outside the observed item range" });
  }
}

// ---------------------------------------------------------------------------
// Injectable learned adapters with fail-closed orchestration
// ---------------------------------------------------------------------------

export type MaybePromise<T> = T | Promise<T>;

/** Untrusted small/distilled compressor boundary. Output remains unknown by design. */
export interface DistilledCompressor {
  readonly id?: string;
  compress(request: Readonly<CompressionRequest>): MaybePromise<unknown>;
}

/** Untrusted context-operation policy boundary. Output remains unknown by design. */
export interface DistilledContextPolicy {
  readonly id?: string;
  propose(context: Readonly<ContextOperationValidationContext>): MaybePromise<unknown>;
}

export interface LearnedOptimizerAdapters {
  readonly compressor?: DistilledCompressor;
  readonly policy?: DistilledContextPolicy;
}

export interface CompressionOptimizationResult {
  readonly summary: StructuredCompactStateV2;
  readonly source: "distilled" | "extractive_fallback";
  readonly adapterId?: string;
  readonly issues: readonly OptimizerValidationIssue[];
}

export interface ContextOperationOptimizationResult {
  readonly operations: readonly ContextOp[];
  readonly source: "distilled" | "conservative_fallback";
  readonly adapterId?: string;
  readonly issues: readonly OptimizerValidationIssue[];
}

/**
 * Production-safe P4 scaffold.  Adapters can improve a candidate but cannot
 * relax a validator or replace either deterministic fallback.
 */
export class DeterministicLearnedOptimizer {
  readonly #compressor: DistilledCompressor | undefined;
  readonly #policy: DistilledContextPolicy | undefined;

  constructor(adapters: LearnedOptimizerAdapters = {}) {
    this.#compressor = adapters.compressor;
    this.#policy = adapters.policy;
  }

  async compress(request: CompressionRequest): Promise<CompressionOptimizationResult> {
    const fallback = createExtractiveFallback(request);
    if (this.#compressor === undefined) {
      return {
        summary: fallback,
        source: "extractive_fallback",
        issues: [adapterIssue("adapter_unavailable", "no distilled compressor is installed")],
      };
    }
    try {
      const safeRequest = freezeCompressionRequest(request);
      const candidate = await this.#compressor.compress(safeRequest);
      const validation = validateCompressionSummary(candidate, safeRequest);
      if (!validation.valid) {
        return withOptionalAdapterId({
          summary: fallback,
          source: "extractive_fallback" as const,
          issues: validation.issues,
        }, this.#compressor.id);
      }
      return withOptionalAdapterId({
        summary: validation.value,
        source: "distilled" as const,
        issues: [],
      }, this.#compressor.id);
    } catch {
      return withOptionalAdapterId({
        summary: fallback,
        source: "extractive_fallback" as const,
        issues: [adapterIssue("adapter_failed", "distilled compressor failed closed")],
      }, this.#compressor.id);
    }
  }

  async proposeContextOperations(
    context: ContextOperationValidationContext,
  ): Promise<ContextOperationOptimizationResult> {
    const fallback = createConservativeContextFallback(context);
    if (this.#policy === undefined) {
      return {
        operations: fallback,
        source: "conservative_fallback",
        issues: [adapterIssue("adapter_unavailable", "no distilled context policy is installed")],
      };
    }
    try {
      const safeContext = freezeOperationContext(context);
      const candidate = await this.#policy.propose(safeContext);
      const validation = validateContextOperations(candidate, safeContext);
      if (!validation.valid) {
        return withOptionalAdapterId({
          operations: fallback,
          source: "conservative_fallback" as const,
          issues: validation.issues,
        }, this.#policy.id);
      }
      return withOptionalAdapterId({
        operations: validation.value,
        source: "distilled" as const,
        issues: [],
      }, this.#policy.id);
    } catch {
      return withOptionalAdapterId({
        operations: fallback,
        source: "conservative_fallback" as const,
        issues: [adapterIssue("adapter_failed", "distilled context policy failed closed")],
      }, this.#policy.id);
    }
  }
}

/** No-ML compressor useful as the offline/control candidate. */
export class DeterministicExtractiveCompressor implements DistilledCompressor {
  readonly id = "deterministic-extractive-v1";

  compress(request: Readonly<CompressionRequest>): StructuredCompactStateV2 {
    return createExtractiveFallback(request);
  }
}

/** No-ML policy useful as the offline/control candidate. */
export class DeterministicConservativePolicy implements DistilledContextPolicy {
  readonly id = "deterministic-conservative-v1";

  propose(context: Readonly<ContextOperationValidationContext>): readonly ContextOp[] {
    return createConservativeContextFallback(context);
  }
}

// ---------------------------------------------------------------------------
// Offline candidate optimization interfaces + deterministic selector
// ---------------------------------------------------------------------------

export interface OfflineOptimizerCandidate {
  readonly id: string;
  readonly compressor?: DistilledCompressor;
  readonly policy?: DistilledContextPolicy;
}

export interface OfflineOptimizationCase {
  readonly id: string;
  readonly compression?: CompressionRequest;
  readonly contextOperations?: ContextOperationValidationContext;
}

/** Lower is better for every metric. Safety failures make a candidate ineligible. */
export interface OfflineCandidateMetrics {
  readonly safetyFailures: number;
  readonly taskFailures: number;
  readonly fallbackCount: number;
  readonly summaryCharacters: number;
  readonly operationCount: number;
}

export interface OfflineCandidateEvaluation {
  readonly candidateId: string;
  readonly metrics: OfflineCandidateMetrics;
}

export interface OfflineCandidateGenerator {
  generate(guidelines: readonly CompressionGuideline[]): MaybePromise<readonly OfflineOptimizerCandidate[]>;
}

export interface OfflineCandidateEvaluator {
  /** `unknown` is intentional: even an offline evaluator is parsed fail-closed. */
  evaluate(
    candidate: OfflineOptimizerCandidate,
    cases: readonly OfflineOptimizationCase[],
  ): MaybePromise<unknown>;
}

export interface OfflineOptimizationRequest {
  readonly candidates: readonly OfflineOptimizerCandidate[];
  readonly cases: readonly OfflineOptimizationCase[];
  readonly evaluator: OfflineCandidateEvaluator;
}

export interface OfflineOptimizationResult {
  readonly selected?: OfflineOptimizerCandidate;
  readonly ranked: readonly OfflineCandidateEvaluation[];
  readonly rejected: readonly { readonly candidateId: string; readonly reason: string }[];
}

export interface OfflineCandidateOptimizer {
  optimize(request: OfflineOptimizationRequest): Promise<OfflineOptimizationResult>;
}

/**
 * Deterministic lexicographic selector.  It does not train or execute a model;
 * an offline system injects candidates and eval metrics.  Evaluator exceptions,
 * malformed metrics, duplicate IDs, and any safety failure are closed out.
 */
export class DeterministicOfflineCandidateOptimizer implements OfflineCandidateOptimizer {
  async optimize(request: OfflineOptimizationRequest): Promise<OfflineOptimizationResult> {
    const rejected: Array<{ candidateId: string; reason: string }> = [];
    const evaluations: OfflineCandidateEvaluation[] = [];
    const byId = new Map<string, OfflineOptimizerCandidate>();
    const duplicates = duplicateStrings(request.candidates.map((candidate) => candidate.id));

    for (const candidate of [...request.candidates].sort((left, right) => left.id.localeCompare(right.id))) {
      if (!isUsableIdentifier(candidate.id)) {
        rejected.push({ candidateId: candidate.id, reason: "candidate ID is invalid" });
        continue;
      }
      if (duplicates.has(candidate.id)) {
        rejected.push({ candidateId: candidate.id, reason: "candidate ID is duplicated" });
        continue;
      }
      byId.set(candidate.id, candidate);
      try {
        const cases = [...request.cases].sort((left, right) => left.id.localeCompare(right.id));
        const safeCases = deepFreeze(cloneJson(cases) as OfflineOptimizationCase[]);
        const raw = await request.evaluator.evaluate(candidate, safeCases);
        const evaluation = parseOfflineEvaluation(raw, candidate.id);
        if (evaluation === undefined) {
          rejected.push({ candidateId: candidate.id, reason: "evaluator returned invalid metrics" });
          continue;
        }
        evaluations.push(evaluation);
        if (evaluation.metrics.safetyFailures > 0) {
          rejected.push({ candidateId: candidate.id, reason: "candidate failed deterministic safety validation" });
        }
      } catch {
        rejected.push({ candidateId: candidate.id, reason: "evaluator failed closed" });
      }
    }

    const ranked = evaluations.sort(compareOfflineEvaluations);
    const selectedEvaluation = ranked.find((evaluation) => evaluation.metrics.safetyFailures === 0);
    const selected = selectedEvaluation === undefined ? undefined : byId.get(selectedEvaluation.candidateId);
    const result: OfflineOptimizationResult = {
      ...(selected !== undefined ? { selected } : {}),
      ranked: deepFreeze([...ranked]),
      rejected: deepFreeze(rejected.sort(
        (left, right) => left.candidateId.localeCompare(right.candidateId) || left.reason.localeCompare(right.reason),
      )),
    };
    // Do not recursively freeze injected adapters owned by the caller.
    return Object.freeze(result);
  }
}

export const DETERMINISTIC_BASELINE_CANDIDATE: OfflineOptimizerCandidate = deepFreeze({
  id: "deterministic-baseline-v1",
  compressor: new DeterministicExtractiveCompressor(),
  policy: new DeterministicConservativePolicy(),
});

function parseOfflineEvaluation(value: unknown, candidateId: string): OfflineCandidateEvaluation | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["candidateId", "metrics"]) || value.candidateId !== candidateId) return undefined;
  if (!isPlainObject(value.metrics) || !hasExactKeys(value.metrics, [
    "fallbackCount",
    "operationCount",
    "safetyFailures",
    "summaryCharacters",
    "taskFailures",
  ])) return undefined;
  const metrics = value.metrics;
  const names = ["safetyFailures", "taskFailures", "fallbackCount", "summaryCharacters", "operationCount"] as const;
  if (names.some((name) => !Number.isSafeInteger(metrics[name]) || (metrics[name] as number) < 0)) return undefined;
  return deepFreeze({
    candidateId,
    metrics: {
      safetyFailures: metrics.safetyFailures as number,
      taskFailures: metrics.taskFailures as number,
      fallbackCount: metrics.fallbackCount as number,
      summaryCharacters: metrics.summaryCharacters as number,
      operationCount: metrics.operationCount as number,
    },
  });
}

function compareOfflineEvaluations(
  left: OfflineCandidateEvaluation,
  right: OfflineCandidateEvaluation,
): number {
  return left.metrics.safetyFailures - right.metrics.safetyFailures ||
    left.metrics.taskFailures - right.metrics.taskFailures ||
    left.metrics.fallbackCount - right.metrics.fallbackCount ||
    left.metrics.summaryCharacters - right.metrics.summaryCharacters ||
    left.metrics.operationCount - right.metrics.operationCount ||
    left.candidateId.localeCompare(right.candidateId);
}

// ---------------------------------------------------------------------------
// Deterministic data helpers
// ---------------------------------------------------------------------------

/** P3 validates semantics; this adds the strict JSON/exact-key learned boundary. */
function strictStructuredStateShapeIssues(value: unknown): readonly string[] {
  const issues: string[] = [];
  const issue = (message: string): void => {
    if (issues.length < MAX_VALIDATION_ISSUES) issues.push(message);
  };
  const record = (candidate: unknown, keys: readonly string[], path: string): candidate is Record<string, unknown> => {
    if (!isPlainObject(candidate)) {
      issue(`${path} must be a plain data object`);
      return false;
    }
    if (!hasExactKeys(candidate, keys)) issue(`${path} has missing or unknown fields`);
    return true;
  };
  const array = (candidate: unknown, path: string): candidate is unknown[] => {
    if (!isPlainDataArray(candidate)) {
      issue(`${path} must be a plain data array`);
      return false;
    }
    if (candidate.length > 4_096) issue(`${path} exceeds the deterministic item limit`);
    return true;
  };
  const uniqueStrings = (candidate: unknown, path: string, canonical = false): void => {
    if (!array(candidate, path)) return;
    const strings = candidate.filter(isString);
    if (strings.length !== candidate.length) return;
    if (new Set(strings).size !== strings.length) issue(`${path} contains duplicate entries`);
    if (canonical && canonicalStrings(strings).join("\u0000") !== strings.join("\u0000")) {
      issue(`${path} must be sorted and duplicate-free`);
    }
  };
  const uniqueRecords = (candidate: unknown, path: string): void => {
    if (!Array.isArray(candidate)) return;
    const keys = candidate.filter(isPlainObject).map(recordKey);
    if (new Set(keys).size !== keys.length) issue(`${path} contains duplicate entries`);
  };

  if (!record(value, [
    "assumptions",
    "changedSymbols",
    "decisions",
    "memoryHandles",
    "schemaVersion",
    "task",
    "unresolved",
    "verification",
  ], "$")) return issues;

  if (record(value.task, ["acceptanceCriteria", "constraints", "goal"], "$.task")) {
    uniqueStrings(value.task.constraints, "$.task.constraints");
    uniqueStrings(value.task.acceptanceCriteria, "$.task.acceptanceCriteria");
  }

  if (array(value.decisions, "$.decisions")) {
    value.decisions.forEach((entry, index) => {
      if (record(entry, ["evidenceIds", "status", "text"], `$.decisions[${index}]`)) {
        uniqueStrings(entry.evidenceIds, `$.decisions[${index}].evidenceIds`, true);
      }
    });
    uniqueRecords(value.decisions, "$.decisions");
  }
  if (array(value.assumptions, "$.assumptions")) {
    value.assumptions.forEach((entry, index) => {
      if (record(entry, ["confidence", "evidenceIds", "text"], `$.assumptions[${index}]`)) {
        uniqueStrings(entry.evidenceIds, `$.assumptions[${index}].evidenceIds`, true);
      }
    });
    uniqueRecords(value.assumptions, "$.assumptions");
  }
  if (array(value.changedSymbols, "$.changedSymbols")) {
    value.changedSymbols.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        issue(`$.changedSymbols[${index}] must be a plain data object`);
        return;
      }
      const keys = ["path", "purpose"];
      if (Object.hasOwn(entry, "symbol")) keys.push("symbol");
      if (Object.hasOwn(entry, "checksum")) keys.push("checksum");
      if (!hasExactKeys(entry, keys)) issue(`$.changedSymbols[${index}] has missing or unknown fields`);
    });
    uniqueRecords(value.changedSymbols, "$.changedSymbols");
  }
  if (array(value.verification, "$.verification")) {
    value.verification.forEach((entry, index) => {
      if (record(entry, ["command", "evidenceIds", "status"], `$.verification[${index}]`)) {
        uniqueStrings(entry.evidenceIds, `$.verification[${index}].evidenceIds`, true);
      }
    });
    uniqueRecords(value.verification, "$.verification");
  }
  if (array(value.unresolved, "$.unresolved")) {
    value.unresolved.forEach((entry, index) => {
      if (record(entry, ["attempted", "evidenceIds", "issue", "nextAction"], `$.unresolved[${index}]`)) {
        uniqueStrings(entry.attempted, `$.unresolved[${index}].attempted`);
        uniqueStrings(entry.evidenceIds, `$.unresolved[${index}].evidenceIds`, true);
      }
    });
    uniqueRecords(value.unresolved, "$.unresolved");
  }
  uniqueStrings(value.memoryHandles, "$.memoryHandles", true);
  return issues;
}

function collectEvidenceIds(state: StructuredCompactStateV2): Set<string> {
  const ids = new Set<string>();
  for (const record of state.decisions) for (const id of record.evidenceIds) ids.add(id);
  for (const record of state.assumptions) for (const id of record.evidenceIds) ids.add(id);
  for (const record of state.verification) for (const id of record.evidenceIds) ids.add(id);
  for (const record of state.unresolved) for (const id of record.evidenceIds) ids.add(id);
  return ids;
}

function collectSummaryTexts(state: StructuredCompactStateV2): Set<string> {
  const texts = new Set<string>([
    state.task.goal,
    ...state.task.constraints,
    ...state.task.acceptanceCriteria,
    ...state.decisions.map((record) => record.text),
    ...state.assumptions.map((record) => record.text),
    ...state.changedSymbols.flatMap((record) => [record.path, record.symbol, record.purpose, record.checksum].filter(isString)),
    ...state.verification.map((record) => record.command),
    ...state.unresolved.flatMap((record) => [record.issue, ...record.attempted, record.nextAction]),
    ...state.memoryHandles,
  ]);
  return texts;
}

function freezeCompressionRequest(request: CompressionRequest): Readonly<CompressionRequest> {
  return deepFreeze({
    extractiveBaseline: createExtractiveFallback(request),
    ...(request.allowedEvidenceIds !== undefined ? { allowedEvidenceIds: [...request.allowedEvidenceIds] } : {}),
    ...(request.requiredEvidenceIds !== undefined ? { requiredEvidenceIds: [...request.requiredEvidenceIds] } : {}),
    ...(request.requiredTexts !== undefined ? { requiredTexts: [...request.requiredTexts] } : {}),
    ...(request.maxSummaryCharacters !== undefined ? { maxSummaryCharacters: request.maxSummaryCharacters } : {}),
    ...(request.guidelines !== undefined ? { guidelines: cloneJson(request.guidelines) as CompressionGuideline[] } : {}),
  });
}

function freezeOperationContext(
  context: ContextOperationValidationContext,
): Readonly<ContextOperationValidationContext> {
  prepareOperationContext(context);
  return deepFreeze(cloneJson(context) as ContextOperationValidationContext);
}

function adapterIssue(
  code: "adapter_unavailable" | "adapter_failed",
  message: string,
): OptimizerValidationIssue {
  return { code, path: "$", message };
}

function withOptionalAdapterId<T extends object>(value: T, adapterId: string | undefined): T & { readonly adapterId?: string } {
  return adapterId === undefined ? value : { ...value, adapterId };
}

function valid<T>(value: T): OptimizerValidationResult<T> {
  return { valid: true, value, issues: [] };
}

function invalid<T>(issues: readonly OptimizerValidationIssue[]): OptimizerValidationResult<T> {
  return { valid: false, issues: deepFreeze([...issues].slice(0, MAX_VALIDATION_ISSUES)) };
}

function pushIssue(issues: OptimizerValidationIssue[], issue: OptimizerValidationIssue): void {
  if (issues.length >= MAX_VALIDATION_ISSUES) return;
  issues.push({
    ...issue,
    path: issue.path.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512),
    message: issue.message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1_024),
  });
}

function strictIdentifierSet(values: readonly string[]): Set<string> {
  if (!Array.isArray(values)) throw new TypeError("identifier set is not an array");
  const set = new Set<string>();
  for (const value of values) {
    if (!isUsableIdentifier(value) || set.has(value)) throw new TypeError("invalid or duplicate identifier");
    set.add(value);
  }
  return set;
}

function strictTextSet(values: readonly string[]): Set<string> {
  if (!Array.isArray(values)) throw new TypeError("text set is not an array");
  const set = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || set.has(value)) throw new TypeError("invalid or duplicate text");
    set.add(value);
  }
  return set;
}

function canonicalOperationKinds(values: readonly ContextOperationKind[]): readonly ContextOperationKind[] {
  return [...new Set(values.filter((value) => OPERATION_KINDS.includes(value)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function duplicateStrings(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isUsableIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isLineRange(value: unknown): value is ContextLineRange {
  return isPlainObject(value) &&
    Number.isSafeInteger(value.startLine) &&
    Number.isSafeInteger(value.endLine) &&
    (value.startLine as number) >= 1 &&
    (value.endLine as number) >= (value.startLine as number);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => "value" in descriptor);
}

function isPlainDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  let entries = 0;
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    entries += 1;
  }
  // JSON arrays cannot carry holes: JSON.stringify would otherwise synthesize nulls.
  return entries === value.length;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string") &&
    canonicalStrings(keys.filter(isString)).join("\u0000") === [...expected].sort().join("\u0000");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return current;
  });
}
