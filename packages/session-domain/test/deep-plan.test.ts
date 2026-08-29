import { describe, expect, test } from "bun:test";

import {
  DeepPlanController,
  DeepPlanError,
  assessDeepPlanReadiness,
  compactDeepPlanProjection,
  type UserAskBatchInput,
} from "../src/index.ts";

function clock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++)).toISOString();
}

function questionnaire(
  overrides: Partial<UserAskBatchInput> = {},
): UserAskBatchInput {
  return {
    questionnaireId: "cache-round-1",
    reason: "Resolve decisions that materially change the cache plan.",
    allowDraftNow: true,
    questions: [
      {
        id: "layer",
        decisionKey: "cache.layer",
        tab: "Cache layer",
        question: "Where should cached values live?",
        kind: "single_select",
        required: true,
        options: [
          {
            id: "memory",
            label: "Process memory",
            description: "Fast and local to one process.",
            recommended: true,
          },
          { id: "redis", label: "Redis", description: "Shared across processes." },
        ],
        allowCustom: true,
      },
      {
        id: "failure",
        decisionKey: "cache.failure_policy",
        tab: "Failure",
        question: "What should happen when the cache is unavailable?",
        kind: "text",
        required: false,
      },
    ],
    ...overrides,
  };
}

function activeController(): DeepPlanController {
  const controller = new DeepPlanController({ mode: "on", now: clock() });
  controller.beginTurn({
    turnKey: "turn-1",
    taskEpochId: "epoch-1",
    goalDigest: "goal-1",
    workspaceIdentityDigest: "workspace-1",
  });
  return controller;
}

function expectCode(run: () => unknown, code: DeepPlanError["code"]): void {
  try {
    run();
    throw new Error("expected DeepPlanError");
  } catch (error) {
    expect(error).toBeInstanceOf(DeepPlanError);
    expect((error as DeepPlanError).code).toBe(code);
  }
}

describe("DeepPlanController questionnaire contract", () => {
  test("opens one strict batch and sanitizes ANSI/control characters", () => {
    const controller = activeController();
    const opened = controller.openQuestionnaire(questionnaire({
      reason: "\u001b[31mNeed a decision\u001b[0m\u0000",
    }));
    expect(opened.kind).toBe("opened");
    if (opened.kind === "opened" || opened.kind === "pending") {
      expect(opened.questionnaire.reason).toBe("Need a decision");
      expect(opened.questionnaire.questions).toHaveLength(2);
      expect(opened.questionnaire.activeQuestionIndex).toBe(0);
    }
    expect(controller.current().phase).toBe("questioning");
    expect(controller.current().decisions.map((decision) => decision.key)).toEqual([
      "cache.layer",
      "cache.failure_policy",
    ]);
  });

  test("rejects empty/oversized batches, duplicate identities, and invalid options", () => {
    const controller = activeController();
    expectCode(
      () => controller.openQuestionnaire(questionnaire({ questions: [] })),
      "QUESTIONNAIRE_INVALID",
    );
    expectCode(
      () => controller.openQuestionnaire(questionnaire({
        questions: [
          questionnaire().questions[0]!,
          { ...questionnaire().questions[0]!, id: "other" },
        ],
      })),
      "QUESTIONNAIRE_INVALID",
    );
    expectCode(
      () => controller.openQuestionnaire(questionnaire({
        questions: [{
          ...questionnaire().questions[0]!,
          options: [
            { id: "a", label: "A", recommended: true },
            { id: "b", label: "B", recommended: true },
          ],
        }],
      })),
      "QUESTIONNAIRE_INVALID",
    );
    expectCode(
      () => controller.openQuestionnaire(questionnaire({
        questions: [{
          ...questionnaire().questions[0]!,
          options: [{ id: "only", label: "Only" }],
        }],
      })),
      "QUESTIONNAIRE_INVALID",
    );
  });

  test("validates required answers and selected option ids", () => {
    const controller = activeController();
    controller.openQuestionnaire(questionnaire());
    expectCode(
      () => controller.completeQuestionnaire({
        questionnaireId: "cache-round-1",
        status: "submitted",
        answers: [],
      }),
      "ANSWER_INVALID",
    );
    expectCode(
      () => controller.completeQuestionnaire({
        questionnaireId: "cache-round-1",
        status: "submitted",
        answers: [{
          questionId: "layer",
          decisionKey: "cache.layer",
          selectedOptionIds: ["unknown"],
        }],
      }),
      "ANSWER_INVALID",
    );
  });
});

describe("DeepPlanController ledger and readiness", () => {
  test("records structured answers, prevents duplicate questions, and replays retries", () => {
    const controller = activeController();
    controller.openQuestionnaire(questionnaire());
    const submitted = controller.completeQuestionnaire({
      questionnaireId: "cache-round-1",
      status: "submitted",
      answers: [
        {
          questionId: "layer",
          decisionKey: "cache.layer",
          selectedOptionIds: ["memory"],
        },
        {
          questionId: "failure",
          decisionKey: "cache.failure_policy",
          customText: "Fall back to the source.",
        },
      ],
    });
    expect(submitted.status).toBe("submitted");
    const state = controller.current();
    expect(state.answerRevision).toBe(1);
    expect(state.answers).toHaveLength(2);
    expect(state.decisions.find((decision) => decision.key === "cache.layer")).toMatchObject({
      status: "resolved",
      source: "user",
      value: {
        selectedOptionIds: ["memory"],
        selectedLabels: ["Process memory"],
      },
    });

    const retry = controller.openQuestionnaire(questionnaire());
    expect(retry).toEqual({ kind: "replay", result: submitted });
    expectCode(
      () => controller.openQuestionnaire(questionnaire({ questionnaireId: "cache-round-2" })),
      "QUESTION_ALREADY_RESOLVED",
    );
  });

  test("allows a documented revisit only after contradictory evidence", () => {
    const controller = activeController();
    controller.recordDecision({
      key: "cache.layer",
      status: "resolved",
      value: "memory",
      source: "conversation",
      blocking: true,
    });
    controller.recordContradiction({
      decisionKey: "cache.layer",
      detail: "The application already requires cross-process consistency.",
      evidenceRefs: ["src/cache.ts:42"],
    });
    expectCode(
      () => controller.openQuestionnaire(questionnaire({
        questions: [questionnaire().questions[0]!],
      })),
      "QUESTION_ALREADY_RESOLVED",
    );
    const opened = controller.openQuestionnaire(questionnaire({
      questions: [{
        ...questionnaire().questions[0]!,
        revisitReason: "Repository evidence conflicts with the earlier local-only choice.",
      }],
    }));
    expect(opened.kind).toBe("opened");
  });

  test("requires a post-answer Plan that reflects blocking user choices", () => {
    const controller = activeController();
    controller.openQuestionnaire(questionnaire({
      questions: [questionnaire().questions[0]!],
    }));
    controller.completeQuestionnaire({
      questionnaireId: "cache-round-1",
      status: "submitted",
      answers: [{
        questionId: "layer",
        decisionKey: "cache.layer",
        selectedOptionIds: ["memory"],
      }],
    });

    expect(assessDeepPlanReadiness(controller.current()).blockers).toContain(
      "the Plan Contract has not been written during this Deep Plan turn",
    );
    controller.notePlanWritten(3);
    const missing = assessDeepPlanReadiness(controller.current(), {
      revision: 3,
      document: { context: ["Use the existing cache abstraction."], assumptions: [] },
    });
    expect(missing.ready).toBe(false);
    expect(missing.blockers).toContain("Plan context or assumptions do not reflect 'cache.layer'");

    const ready = assessDeepPlanReadiness(controller.current(), {
      revision: 3,
      document: {
        context: ["cache.layer = Process memory, selected by the user."],
        assumptions: [],
      },
    });
    expect(ready).toEqual({ ready: true, blockers: [] });
    expect(compactDeepPlanProjection(controller.current())).toContain(
      "cache.layer",
    );
  });

  test("draft-now converts unanswered decisions to explicit assumptions", () => {
    const controller = activeController();
    controller.openQuestionnaire(questionnaire());
    controller.completeQuestionnaire({
      questionnaireId: "cache-round-1",
      status: "draft_now",
      answers: [{
        questionId: "failure",
        decisionKey: "cache.failure_policy",
        customText: "Fall back to source.",
      }],
    });
    const state = controller.current();
    expect(state.phase).toBe("drafting");
    expect(state.draftNow).toBe(true);
    expect(state.decisions.find((decision) => decision.key === "cache.layer")).toMatchObject({
      status: "assumed",
      source: "assumption",
    });
    controller.notePlanWritten(4);
    expect(assessDeepPlanReadiness(controller.current(), {
      revision: 4,
      document: {
        context: ["cache.failure_policy = Fall back to source."],
        assumptions: ["cache.layer remains an open decision."],
      },
    }).ready).toBe(true);
  });

  test("pause preserves drafts, bypasses continuation, and resumes the pending form", () => {
    const controller = activeController();
    controller.openQuestionnaire(questionnaire());
    controller.updateQuestionnaireDraft("cache-round-1", [{
      questionId: "layer",
      decisionKey: "cache.layer",
      selectedOptionIds: ["redis"],
    }], 1);
    controller.completeQuestionnaire({
      questionnaireId: "cache-round-1",
      status: "paused",
      answers: [{
        questionId: "layer",
        decisionKey: "cache.layer",
        selectedOptionIds: ["redis"],
      }],
    });
    expect(assessDeepPlanReadiness(controller.current())).toMatchObject({
      ready: true,
      bypassed: "paused",
    });
    controller.resume();
    const pending = controller.openQuestionnaire(questionnaire());
    expect(pending.kind).toBe("pending");
    if (pending.kind === "pending") {
      expect(pending.questionnaire.activeQuestionIndex).toBe(1);
      expect(pending.questionnaire.draftAnswers[0]?.selectedOptionIds).toEqual(["redis"]);
    }
  });

  test("a new goal resets the ledger and a workspace change invalidates repository decisions", () => {
    const controller = activeController();
    controller.recordDecision({
      key: "repo.cache",
      status: "resolved",
      value: "memory",
      source: "repository",
      blocking: false,
    });
    controller.recordDecision({
      key: "user.scope",
      status: "resolved",
      value: "api",
      source: "user",
      blocking: true,
    });
    controller.beginTurn({
      turnKey: "turn-2",
      taskEpochId: "epoch-1",
      goalDigest: "goal-1",
      workspaceIdentityDigest: "workspace-2",
    });
    expect(controller.current().decisions.map((decision) => decision.key)).toEqual(["user.scope"]);

    controller.beginTurn({
      turnKey: "turn-3",
      taskEpochId: "epoch-2",
      goalDigest: "goal-2",
      workspaceIdentityDigest: "workspace-2",
    });
    expect(controller.current().decisions).toEqual([]);
    expect(controller.current().round).toBe(0);
  });
});
