import { describe, expect, test } from "bun:test";

import type { DeepPlanAnswer, UserAskBatchResult } from "@cbc/session-domain";
import {
  dispatchSessionWorkerMessage,
  type PendingWorkerQuestionnaire,
} from "../src/commands/session-worker.ts";

function pendingInput() {
  return {
    questionnaireId: "cache-round-1",
    reason: "Choose cache behavior",
    questions: [{
      id: "layer",
      decisionKey: "cache.layer",
      tab: "Layer",
      question: "Where?",
      kind: "single_select" as const,
      required: true,
      options: [{ id: "memory", label: "Memory" }, { id: "redis", label: "Redis" }],
    }],
  };
}

describe("session-worker questionnaire multiplexing", () => {
  test("gets, updates, and resolves the promise owned by the original turn", async () => {
    const drafts: Array<{ answers: readonly DeepPlanAnswer[]; index: number }> = [];
    let resolved: UserAskBatchResult | undefined;
    const input = pendingInput();
    const questionnaires = new Map<string, PendingWorkerQuestionnaire>([[
      input.questionnaireId,
      {
        input,
        onDraftChange: (answers, index) => drafts.push({ answers, index }),
        resolve: (result) => { resolved = result; },
      },
    ]]);
    const session = {
      deepPlanState: {
        pendingQuestionnaire: { ...input, activeQuestionIndex: 0, draftAnswers: [] },
      },
      updateDeepPlanQuestionnaireDraft: () => {
        throw new Error("live promise callback should own the draft");
      },
      resolveDeepPlanQuestionnaire: () => {
        throw new Error("live promise should own the result");
      },
    };
    const boot = { session } as never;
    const controllers = new Map<string, AbortController>();

    const inspected = await dispatchSessionWorkerMessage(
      boot,
      { method: "turn.input.get", params: {} },
      controllers,
      questionnaires,
    ) as { pending: { questionnaireId: string } };
    expect(inspected.pending.questionnaireId).toBe("cache-round-1");

    const answers: DeepPlanAnswer[] = [{
      questionId: "layer",
      decisionKey: "cache.layer",
      selectedOptionIds: ["memory"],
    }];
    await dispatchSessionWorkerMessage(
      boot,
      {
        method: "turn.input.update",
        params: {
          questionnaireId: "cache-round-1",
          activeQuestionIndex: 0,
          answers,
        },
      },
      controllers,
      questionnaires,
    );
    expect(drafts).toEqual([{ answers, index: 0 }]);

    const outcome = await dispatchSessionWorkerMessage(
      boot,
      {
        method: "turn.input.resolve",
        params: {
          questionnaireId: "cache-round-1",
          status: "submitted",
          answers,
        },
      },
      controllers,
      questionnaires,
    );
    expect(outcome).toEqual({
      questionnaireId: "cache-round-1",
      accepted: true,
      continuationRequired: false,
    });
    expect(resolved).toEqual({
      questionnaireId: "cache-round-1",
      status: "submitted",
      answers,
    });
  });

  test("resolves replayed post-crash state and requests a continuation turn", async () => {
    let restored: UserAskBatchResult | undefined;
    const session = {
      deepPlanState: { pendingQuestionnaire: pendingInput() },
      resolveDeepPlanQuestionnaire: (result: UserAskBatchResult) => {
        restored = result;
      },
    };
    const answers: DeepPlanAnswer[] = [{
      questionId: "layer",
      decisionKey: "cache.layer",
      selectedOptionIds: ["redis"],
    }];
    const outcome = await dispatchSessionWorkerMessage(
      { session } as never,
      {
        method: "turn.input.resolve",
        params: {
          questionnaireId: "cache-round-1",
          status: "submitted",
          answers,
        },
      },
      new Map(),
      new Map(),
    );
    expect(outcome).toEqual({
      questionnaireId: "cache-round-1",
      accepted: true,
      continuationRequired: true,
    });
    expect(restored?.answers[0]?.selectedOptionIds).toEqual(["redis"]);
  });
});
