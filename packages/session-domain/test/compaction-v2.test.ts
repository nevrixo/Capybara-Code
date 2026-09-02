import { describe, expect, test } from "bun:test";

import { EventSequencer, createEvent, type CbcEventKind } from "@cbc/protocol";
import {
  buildCompactionSourceBundle,
  compactDeterministicFallback,
  createGoalContract,
  emptyViewModel,
  estimateTokens,
  reduce,
  validateModelCompactionSummary,
  type CompactionSourceBundle,
  type ModelCompactionSummaryV2,
  type SessionViewModel,
} from "../src/index.ts";

function fixture(): SessionViewModel {
  const sequencer = new EventSequencer();
  let model = emptyViewModel("compact-v2");
  const emit = (kind: CbcEventKind, payload: unknown): void => {
    model = reduce(model, createEvent(sequencer, kind, payload, { sessionId: model.sessionId }));
  };
  emit("user.message", { text: "Build the first parser" });
  emit("user.message", { text: "Change the goal: preserve quoted commas and do not add dependencies" });
  emit("plan.created", {
    revision: 1,
    source: "model",
    items: [
      { id: "impl", text: "Implement quoted comma parsing", status: "active" },
      { id: "verify", text: "Run parser tests", status: "blocked", blockedReason: "implementation pending" },
    ],
  });
  emit("tool.started", {
    callId: "install",
    toolId: "process.run",
    display: "npm install",
  });
  emit("tool.completed", {
    callId: "install",
    toolId: "process.run",
    summary: "dependencies installed",
  });
  emit("tool.started", {
    callId: "test",
    toolId: "process.run",
    display: "bun test parser.test.ts",
  });
  emit("tool.completed", {
    callId: "test",
    toolId: "process.run",
    summary: "12 tests passed",
  });
  emit("tool.started", {
    callId: "failed",
    toolId: "fs.patch",
    display: "src/parser.ts",
  });
  emit("tool.failed", {
    callId: "failed",
    toolId: "fs.patch",
    message: "anchor was stale",
    code: "STALE_ANCHOR",
  });
  emit("transaction.committed", {
    operations: [{ path: "src/parser.ts", additions: 8, deletions: 2 }],
  });
  emit("diff.updated", {
    files: [{
      path: "src/parser.ts",
      additions: 8,
      deletions: 2,
      purpose: "parse quoted commas without changing dependencies",
    }],
  });
  emit("approval.requested", {
    approvalId: "approval-1",
    action: "process.run",
    display: "publish package",
    reason: "external side effect",
    riskClass: "R4",
    sideEffects: ["publish"],
  });
  return {
    ...model,
    deepPlan: {
      mode: "on",
      phase: "questioning",
      revision: 3,
      turnRevision: 1,
      round: 1,
      pendingQuestionnaire: {
        questionnaireId: "q-1",
        reason: "Choose compatibility",
        questions: [{
          id: "compat",
          decisionKey: "compat",
          tab: "Compatibility",
          question: "Keep legacy CSV behavior?",
          kind: "single_select",
          required: true,
          options: [{ id: "yes", label: "Yes" }],
          allowCustom: true,
        }],
        allowDraftNow: false,
        activeQuestionIndex: 0,
        draftAnswers: [],
        openedAt: "2026-01-01T00:00:00.000Z",
      },
      answers: [],
      decisions: [],
      contradictions: [],
      questionnaireResults: [],
      answerRevision: 0,
      planAnswerRevision: 0,
      draftNow: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function validSummary(bundle: CompactionSourceBundle): ModelCompactionSummaryV2 {
  return {
    schemaVersion: "2.0",
    sourceDigest: bundle.sourceDigest,
    goal: bundle.currentGoal?.goal ?? "",
    currentState: "Parser implementation is active.",
    constraints: bundle.userConstraints.map((entry) => ({ ...entry })),
    decisions: bundle.decisions.map((entry) => ({ ...entry })),
    completedWork: bundle.completedWork.map((entry) => ({ ...entry })),
    workspaceChanges: bundle.changedFiles.map((file) => ({
      path: file.path,
      summary: file.diffSummary,
      evidenceRefs: file.evidenceRefs,
    })),
    verification: bundle.verification.map((check) => ({
      command: check.command,
      status: check.status,
      text: check.summary,
      evidenceRefs: check.evidenceRefs,
    })),
    failedApproaches: bundle.failures.map((failure) => ({
      text: failure.summary,
      reason: failure.correctiveAction ?? "inspect and retry safely",
      evidenceRefs: failure.evidenceRefs,
    })),
    unresolved: [],
    todos: bundle.todos.map((item) => ({
      ...item,
      blockedReason: item.blockedReason ?? null,
    })),
    approvals: bundle.approvals.map((item) => ({ ...item })),
    pendingQuestionnaire: bundle.pendingQuestionnaire === null
      ? null
      : structuredClone(bundle.pendingQuestionnaire),
    nextAction: bundle.todos.find((item) => item.status === "active")?.text ?? "await user direction",
  };
}

describe("context compaction source bundle v2", () => {
  test("uses the latest goal and keeps all user instructions evidence-bound", () => {
    const bundle = buildCompactionSourceBundle(fixture());
    expect(bundle.currentGoal?.goal).toBe(
      "Change the goal: preserve quoted commas and do not add dependencies",
    );
    expect(bundle.userConstraints).toHaveLength(2);
    expect(bundle.userConstraints.every((entry) => entry.evidenceRefs.length === 1)).toBe(true);
    expect(bundle.sourceDigest).toHaveLength(64);
  });

  test("prefers the authoritative goal contract over conversation guesses", () => {
    const goal = createGoalContract({
      goal: "Ship a backwards-compatible CSV parser",
      successCriteria: [{ id: "tests", statement: "Parser tests pass", kind: "verification" }],
      allowedScope: ["src/parser.ts"],
    });
    const bundle = buildCompactionSourceBundle(fixture(), {
      currentGoal: goal,
      goalEvaluation: {
        status: "active",
        outstandingCriteria: ["tests"],
        statement: "Parser tests remain outstanding.",
        budgetRemaining: { turns: 3, wallTimeMs: 60_000 },
      },
    });
    expect(bundle.currentGoal).toMatchObject({
      id: goal.id,
      goal: "Ship a backwards-compatible CSV parser",
      outstandingCriteria: ["tests"],
    });
  });

  test("distinguishes verification from ordinary shell commands", () => {
    const bundle = buildCompactionSourceBundle(fixture());
    expect(bundle.verification).toHaveLength(1);
    expect(bundle.verification[0]).toMatchObject({
      command: "bun test parser.test.ts",
      status: "passed",
    });
    expect(bundle.verification.some((check) => check.command === "npm install")).toBe(false);
  });

  test("preserves TODO, pending approval, questionnaire, semantic diff, and failures", () => {
    const bundle = buildCompactionSourceBundle(fixture(), {
      reflections: [{
        toolId: "fs.patch",
        category: "stale_anchor",
        rootCause: "the file changed after inspection",
        correctiveAction: "reread and regenerate the patch",
        paths: ["src/parser.ts"],
      }],
    });
    expect(bundle.todos).toMatchObject([
      { id: "impl", status: "active" },
      { id: "verify", status: "blocked", blockedReason: "implementation pending" },
    ]);
    expect(bundle.approvals).toMatchObject([{ id: "approval-1", status: "pending" }]);
    expect(bundle.pendingQuestionnaire?.id).toBe("q-1");
    expect(bundle.changedFiles).toMatchObject([{
      path: "src/parser.ts",
      diffSummary: "parse quoted commas without changing dependencies",
    }]);
    expect(bundle.failures.some((failure) =>
      failure.correctiveAction === "reread and regenerate the patch")).toBe(true);
  });
});

describe("model compaction summary validation", () => {
  test("accepts a fully evidence-bound summary", () => {
    const bundle = buildCompactionSourceBundle(fixture());
    const result = validateModelCompactionSummary(validSummary(bundle), bundle, {
      estimateTokens,
      summaryBudgetTokens: 100_000,
      expectedGeneration: bundle.generation,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects invented evidence, paths, TODO status, and verification status", () => {
    const bundle = buildCompactionSourceBundle(fixture());
    const candidate = validSummary(bundle);
    const invalid: ModelCompactionSummaryV2 = {
      ...candidate,
      constraints: [{
        text: "invented constraint",
        evidenceRefs: ["evidence-does-not-exist"],
      }],
      workspaceChanges: [{
        path: "src/invented.ts",
        summary: "invented",
        evidenceRefs: bundle.changedFiles[0]!.evidenceRefs,
      }],
      todos: candidate.todos.map((item) =>
        item.id === "impl" ? { ...item, status: "done" as const } : item),
      verification: candidate.verification.map((check) => ({
        ...check,
        status: "failed" as const,
      })),
      nextAction: "invented next action",
    };
    const result = validateModelCompactionSummary(invalid, bundle, {
      estimateTokens,
      summaryBudgetTokens: 100_000,
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("unknown_evidence");
    expect(codes).toContain("unknown_path");
    expect(codes).toContain("todo_mismatch");
    expect(codes).toContain("verification_mismatch");
    expect(codes).toContain("constraint_dropped");
    expect(codes).toContain("next_action_mismatch");
  });

  test("rejects omitted pending state and summaries over budget", () => {
    const bundle = buildCompactionSourceBundle(fixture());
    const candidate = {
      ...validSummary(bundle),
      approvals: [],
      pendingQuestionnaire: null,
    };
    const result = validateModelCompactionSummary(candidate, bundle, {
      estimateTokens,
      summaryBudgetTokens: 1,
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["approval_mismatch", "questionnaire_mismatch", "budget_exceeded"]),
    );
  });

  test("deterministic fallback uses the latest goal and explicit constraints", () => {
    const model = fixture();
    const result = compactDeterministicFallback(
      model,
      "emergency_pressure",
      estimateTokens,
      {
        currentGoal: "Ship the corrected parser",
        userConstraints: ["No new dependencies"],
      },
    );
    expect(result.state.userGoal).toBe("Ship the corrected parser");
    expect(result.state.constraints).toContain("No new dependencies");
  });
});
