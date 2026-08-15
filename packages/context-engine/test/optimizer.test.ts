import { describe, expect, test } from "bun:test";

import type { ContextOp, StructuredCompactStateV2 } from "../src/context-ops.ts";
import {
  DETERMINISTIC_BASELINE_CANDIDATE,
  DeterministicConservativePolicy,
  DeterministicExtractiveCompressor,
  DeterministicLearnedOptimizer,
  DeterministicOfflineCandidateOptimizer,
  compressionSummaryCharacters,
  createConservativeContextFallback,
  createExtractiveFallback,
  extractCompressionGuidelines,
  validateCompressionSummary,
  validateContextOperations,
  type CompressionRequest,
  type ContextOperationValidationContext,
  type OfflineOptimizerCandidate,
} from "../src/optimizer.ts";

function baseline(): StructuredCompactStateV2 {
  return {
    schemaVersion: "2",
    task: {
      goal: "Repair the deterministic context optimizer",
      constraints: ["Never replace exact evidence with a generated claim"],
      acceptanceCriteria: ["The focused test suite passes"],
    },
    decisions: [
      { text: "Keep validator decisions", status: "active", evidenceIds: ["ev-active"] },
      { text: "Use the older heuristic", status: "superseded", evidenceIds: ["ev-old"] },
    ],
    assumptions: [
      { text: "The fixture is representative", confidence: 0.5, evidenceIds: ["ev-assumption"] },
    ],
    changedSymbols: [
      { path: "src/optimizer.ts", symbol: "validate", purpose: "fail closed", checksum: "abc" },
    ],
    verification: [
      { command: "bun test old", status: "passed", evidenceIds: ["ev-old-test"] },
      { command: "bun test focused", status: "failed", evidenceIds: ["ev-failed"] },
    ],
    unresolved: [
      {
        issue: "focused validation is unfinished",
        attempted: ["shape validation"],
        nextAction: "add provenance checks",
        evidenceIds: ["ev-unresolved"],
      },
    ],
    memoryHandles: ["artifact-session-core"],
  };
}

const ALL_EVIDENCE = [
  "ev-active",
  "ev-assumption",
  "ev-failed",
  "ev-old",
  "ev-old-test",
  "ev-unresolved",
] as const;

function request(overrides: Partial<CompressionRequest> = {}): CompressionRequest {
  return {
    extractiveBaseline: baseline(),
    allowedEvidenceIds: ALL_EVIDENCE,
    maxSummaryCharacters: 50_000,
    ...overrides,
  };
}

function safeCandidate(): StructuredCompactStateV2 {
  const source = baseline();
  return {
    ...source,
    // Only non-critical, source-exact rows are removed.
    decisions: [source.decisions[0]!],
    assumptions: [],
    verification: [source.verification[1]!],
  };
}

function operationContext(
  overrides: Partial<ContextOperationValidationContext> = {},
): ContextOperationValidationContext {
  return {
    availableItemIds: ["item-a", "item-b"],
    protectedItemIds: ["item-a"],
    availableEvidenceIds: [...ALL_EVIDENCE, "ev-stale"],
    requiredEvidenceIds: ["ev-active"],
    staleEvidenceIds: ["ev-stale"],
    checkpointIds: ["checkpoint-1"],
    artifactIds: ["artifact-1"],
    lineRanges: { "item-a": { startLine: 1, endLine: 5 }, "item-b": { startLine: 1, endLine: 10 } },
    compression: request(),
    ...overrides,
  };
}

describe("P4 failure-driven guidelines", () => {
  test("extraction is stable, grouped by distinct trajectory, and contains no free-form reasoning", () => {
    const trajectories = [
      {
        id: "trajectory-b",
        failures: [
          { kind: "critical_text_dropped" as const, texts: ["critical fact"], evidenceIds: ["ev-1"] },
          // A duplicate observation in one run is support once, not twice.
          { kind: "critical_text_dropped" as const, texts: ["critical fact"], evidenceIds: ["ev-1"] },
          { kind: "invalid_context_operation" as const, operationKinds: ["delete" as const] },
        ],
      },
      {
        id: "trajectory-a",
        failures: [
          { kind: "critical_text_dropped" as const, texts: ["critical fact"], evidenceIds: ["ev-1"] },
          { kind: "unsupported_summary_claim" as const },
        ],
      },
    ];

    const first = extractCompressionGuidelines(trajectories);
    const second = extractCompressionGuidelines([...trajectories].reverse());
    expect(second).toEqual(first);
    expect(Object.isFrozen(first[0])).toBe(true);

    const preserve = first.find((guideline) => guideline.kind === "preserve_content");
    expect(preserve?.support).toBe(2);
    expect(preserve?.sourceTrajectoryIds).toEqual(["trajectory-a", "trajectory-b"]);
    expect(preserve?.texts).toEqual(["critical fact"]);
    expect(first.map((guideline) => guideline.kind)).toContain("require_extractive_summary");
    expect(first.find((guideline) => guideline.kind === "forbid_operations")?.operationKinds).toEqual(["delete"]);
  });

  test("guideline identity remains stable when additional support is observed", () => {
    const one = extractCompressionGuidelines([{
      id: "one",
      failures: [{ kind: "summary_budget_exceeded" }],
    }]);
    const two = extractCompressionGuidelines([
      { id: "one", failures: [{ kind: "summary_budget_exceeded" }] },
      { id: "two", failures: [{ kind: "summary_budget_exceeded" }] },
    ]);
    expect(two[0]?.id).toBe(one[0]?.id);
    expect(two[0]?.support).toBe(2);
  });
});

describe("strict learned-summary validation and extractive fallback", () => {
  test("accepts a source-exact candidate that preserves critical state", () => {
    const result = validateCompressionSummary(safeCandidate(), request());
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid summary");
    expect(result.value.assumptions).toEqual([]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.task)).toBe(true);
  });

  test("rejects generated claims, dropped critical rows, unknown fields, and unknown evidence", () => {
    const generated = safeCandidate();
    const generatedResult = validateCompressionSummary({
      ...generated,
      decisions: [{ ...generated.decisions[0]!, text: "A model invented this decision" }],
    }, request());
    expect(generatedResult.valid).toBe(false);
    expect(generatedResult.issues.map((issue) => issue.code)).toContain("not_extractive");
    expect(generatedResult.issues.map((issue) => issue.code)).toContain("missing_required_content");

    const extraField = validateCompressionSummary({ ...safeCandidate(), learnedConfidence: 1 }, request());
    expect(extraField.valid).toBe(false);
    expect(extraField.issues.some((issue) => issue.message.includes("unknown fields"))).toBe(true);

    const unknownEvidence = safeCandidate();
    const evidenceResult = validateCompressionSummary({
      ...unknownEvidence,
      decisions: [{ ...unknownEvidence.decisions[0]!, evidenceIds: ["ev-never-observed"] }],
    }, request());
    expect(evidenceResult.valid).toBe(false);
    expect(evidenceResult.issues.some((issue) => issue.message.includes("outside the operation boundary"))).toBe(true);
  });

  test("required failure-derived content cannot be dropped", () => {
    const guidelines = extractCompressionGuidelines([{
      id: "failed-run",
      failures: [{
        kind: "evidence_reference_dropped",
        texts: ["The fixture is representative"],
        evidenceIds: ["ev-assumption"],
      }],
    }]);
    const result = validateCompressionSummary(safeCandidate(), request({ guidelines }));
    expect(result.valid).toBe(false);
    expect(result.issues.filter((issue) => issue.code === "missing_required_content").length).toBeGreaterThan(0);
  });

  test("learned size is hard-validated while fallback always retains the extractive source", () => {
    const tiny = request({ maxSummaryCharacters: 1 });
    const validation = validateCompressionSummary(safeCandidate(), tiny);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "budget_exceeded")).toBe(true);

    const fallback = createExtractiveFallback(tiny);
    expect(fallback).toEqual(baseline());
    expect(fallback).not.toBe(tiny.extractiveBaseline);
    expect(Object.isFrozen(fallback)).toBe(true);
    expect(compressionSummaryCharacters(fallback)).toBeGreaterThan(1);
  });

  test("a fallback cannot be constructed from stale or structurally loose source data", () => {
    expect(() => createExtractiveFallback(request({ allowedEvidenceIds: ["ev-active"] }))).toThrow();
    expect(() => createExtractiveFallback({
      ...request(),
      extractiveBaseline: { ...baseline(), unknown: true } as unknown as StructuredCompactStateV2,
    })).toThrow();
  });
});

describe("strict context-operation validation", () => {
  test("accepts bounded exact operations and an extractive compress state", () => {
    const operations: readonly ContextOp[] = [
      { kind: "keep", ids: ["item-a"] },
      { kind: "recall", evidenceIds: ["ev-failed"] },
    ];
    const result = validateContextOperations(operations, operationContext());
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid operations");
    expect(Object.isFrozen(result.value)).toBe(true);

    const compressed = validateContextOperations([
      { kind: "compress", ids: ["item-b"], into: safeCandidate() },
    ], operationContext());
    expect(compressed.valid).toBe(true);
  });

  test("rejects protected removal, stale recall, out-of-range snippets, and extra fields", () => {
    const deleted = validateContextOperations([
      { kind: "delete", ids: ["item-a"], reason: "budget" },
    ], operationContext());
    expect(deleted.valid).toBe(false);
    expect(deleted.issues.some((issue) => issue.code === "unsafe_operation")).toBe(true);

    const stale = validateContextOperations([
      { kind: "recall", evidenceIds: ["ev-stale"] },
    ], operationContext());
    expect(stale.valid).toBe(false);
    expect(stale.issues.some((issue) => issue.message.includes("stale"))).toBe(true);

    const range = validateContextOperations([
      { kind: "snippet", id: "item-b", range: { startLine: 1, endLine: 11 } },
    ], operationContext());
    expect(range.valid).toBe(false);
    expect(range.issues.some((issue) => issue.message.includes("observed item range"))).toBe(true);

    const loose = validateContextOperations([
      { kind: "keep", ids: ["item-a"], score: 1 },
    ], operationContext());
    expect(loose.valid).toBe(false);
    expect(loose.issues.some((issue) => issue.message.includes("unknown fields"))).toBe(true);
  });

  test("rejects ambiguous batches atomically", () => {
    const conflict = validateContextOperations([
      { kind: "keep", ids: ["item-b"] },
      { kind: "delete", ids: ["item-b"], reason: "duplicate" },
    ], operationContext());
    expect(conflict.valid).toBe(false);
    expect(conflict.issues.some((issue) => issue.code === "conflicting_operations")).toBe(true);

    const mixedRollback = validateContextOperations([
      { kind: "rollback", checkpointId: "checkpoint-1", preserveEvidence: ["ev-active"] },
      { kind: "keep", ids: ["item-a"] },
    ], operationContext());
    expect(mixedRollback.valid).toBe(false);
    expect(mixedRollback.issues.some((issue) => issue.message.includes("sole operation"))).toBe(true);
  });

  test("failure guidelines can forbid an otherwise structurally valid operation", () => {
    const guidelines = extractCompressionGuidelines([{
      id: "unsafe-delete",
      failures: [{ kind: "unsafe_context_operation", operationKinds: ["delete"] }],
    }]);
    const result = validateContextOperations([
      { kind: "delete", ids: ["item-b"], reason: "resolved" },
    ], operationContext({ guidelines }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("forbidden by guideline"))).toBe(true);
  });

  test("deterministic policy fallback only keeps protected items", () => {
    const first = createConservativeContextFallback(operationContext());
    const second = createConservativeContextFallback(operationContext());
    expect(first).toEqual([{ kind: "keep", ids: ["item-a"] }]);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("injectable distilled adapters fail closed", () => {
  test("accepts validated learned output", async () => {
    let requestWasFrozen = false;
    const optimizer = new DeterministicLearnedOptimizer({
      compressor: {
        id: "small-compressor",
        compress: (input) => {
          requestWasFrozen = Object.isFrozen(input) && Object.isFrozen(input.extractiveBaseline.task);
          return safeCandidate();
        },
      },
      policy: {
        id: "small-policy",
        propose: () => [{ kind: "snippet", id: "item-b", range: { startLine: 2, endLine: 4 } }],
      },
    });

    const compressed = await optimizer.compress(request());
    expect(compressed.source).toBe("distilled");
    expect(compressed.adapterId).toBe("small-compressor");
    expect(requestWasFrozen).toBe(true);

    const operations = await optimizer.proposeContextOperations(operationContext());
    expect(operations.source).toBe("distilled");
    expect(operations.operations).toEqual([
      { kind: "snippet", id: "item-b", range: { startLine: 2, endLine: 4 } },
    ]);
  });

  test("invalid and throwing adapters return deterministic safe fallbacks", async () => {
    const invalid = new DeterministicLearnedOptimizer({
      compressor: { compress: () => ({ schemaVersion: "learned-and-unchecked" }) },
      policy: { propose: () => [{ kind: "delete", ids: ["item-a"], reason: "learned" }] },
    });
    const compression = await invalid.compress(request());
    expect(compression.source).toBe("extractive_fallback");
    expect(compression.summary).toEqual(baseline());
    expect(compression.issues.length).toBeGreaterThan(0);

    const policy = await invalid.proposeContextOperations(operationContext());
    expect(policy.source).toBe("conservative_fallback");
    expect(policy.operations).toEqual([{ kind: "keep", ids: ["item-a"] }]);

    const throwing = new DeterministicLearnedOptimizer({
      compressor: { compress: () => { throw new Error("model unavailable: secret detail"); } },
      policy: { propose: async () => { throw new Error("model unavailable: secret detail"); } },
    });
    const failedCompression = await throwing.compress(request());
    const failedPolicy = await throwing.proposeContextOperations(operationContext());
    expect(failedCompression.source).toBe("extractive_fallback");
    expect(failedCompression.issues).toEqual([{
      code: "adapter_failed",
      path: "$",
      message: "distilled compressor failed closed",
    }]);
    expect(failedPolicy.source).toBe("conservative_fallback");
    expect(failedPolicy.issues[0]?.message).not.toContain("secret detail");
  });

  test("no-ML baseline adapters are reproducible", () => {
    const compressor = new DeterministicExtractiveCompressor();
    const policy = new DeterministicConservativePolicy();
    expect(compressor.compress(request())).toEqual(compressor.compress(request()));
    expect(policy.propose(operationContext())).toEqual(policy.propose(operationContext()));
    expect(DETERMINISTIC_BASELINE_CANDIDATE.id).toBe("deterministic-baseline-v1");
  });
});

describe("deterministic offline candidate selection", () => {
  test("uses safety-first lexicographic ranking and stable ID tie breaking", async () => {
    const candidates: OfflineOptimizerCandidate[] = [
      { id: "candidate-z" },
      { id: "candidate-a" },
      { id: "candidate-unsafe" },
      { id: "candidate-malformed" },
    ];
    const optimizer = new DeterministicOfflineCandidateOptimizer();
    const result = await optimizer.optimize({
      candidates,
      cases: [],
      evaluator: {
        evaluate: (candidate) => {
          if (candidate.id === "candidate-malformed") return { candidateId: candidate.id, score: Number.NaN };
          const safetyFailures = candidate.id === "candidate-unsafe" ? 1 : 0;
          return {
            candidateId: candidate.id,
            metrics: {
              safetyFailures,
              taskFailures: 0,
              fallbackCount: 0,
              summaryCharacters: 10,
              operationCount: 1,
            },
          };
        },
      },
    });

    expect(result.selected?.id).toBe("candidate-a");
    expect(result.ranked.map((evaluation) => evaluation.candidateId)).toEqual([
      "candidate-a",
      "candidate-z",
      "candidate-unsafe",
    ]);
    expect(result.rejected.map((entry) => entry.candidateId)).toEqual([
      "candidate-malformed",
      "candidate-unsafe",
    ]);
  });

  test("duplicate IDs and evaluator exceptions cannot produce a deployable candidate", async () => {
    const optimizer = new DeterministicOfflineCandidateOptimizer();
    const result = await optimizer.optimize({
      candidates: [{ id: "duplicate" }, { id: "duplicate" }, { id: "throws" }],
      cases: [],
      evaluator: { evaluate: () => { throw new Error("offline process failed"); } },
    });
    expect(result.selected).toBeUndefined();
    expect(result.ranked).toEqual([]);
    expect(result.rejected).toHaveLength(3);
  });
});
