import { describe, expect, test } from "bun:test";

import {
  lineText,
  lineWidth,
  renderQuestionnaire,
  type BlockContext,
  type QuestionnaireRenderState,
} from "../src/index.ts";

function context(columns: number): BlockContext {
  return {
    columns,
    capabilities: {
      unicode: true,
      italic: true,
      reducedMotion: true,
      stableEmojiWidth: true,
    },
  };
}

function state(): QuestionnaireRenderState {
  return {
    questionnaireId: "cache-1",
    reason: "캐싱 전략을 확정하기 위한 결정입니다.",
    questions: [
      {
        id: "data",
        decisionKey: "cache.data_type",
        tab: "데이터 타입",
        question: "어떤 종류의 데이터를 캐싱하려고 하나요?",
        kind: "multi_select",
        required: true,
        options: [
          {
            id: "api",
            label: "API 응답 데이터",
            description: "외부 API 결과를 재사용해 네트워크 요청을 줄입니다.",
            recommended: true,
          },
          {
            id: "query",
            label: "데이터베이스 쿼리 결과",
            description: "반복 조회 결과를 저장해 DB 부하를 줄입니다.",
          },
        ],
        allowCustom: true,
      },
      {
        id: "failure",
        decisionKey: "cache.failure_policy",
        tab: "실패 정책",
        question: "캐시가 실패하면 어떻게 처리할까요?",
        kind: "text",
        required: false,
      },
    ],
    allowDraftNow: true,
    activeQuestionIndex: 0,
    answers: [{
      questionId: "data",
      decisionKey: "cache.data_type",
      selectedOptionIds: ["api"],
    }],
    optionCursor: 1,
    textCursor: 0,
  };
}

describe("questionnaire renderer", () => {
  test("fits CJK content at 40/60/80/120 columns", () => {
    for (const columns of [40, 60, 80, 120]) {
      const lines = renderQuestionnaire(state(), context(columns));
      expect(lines.map(lineText).join("\n")).toContain("Deep Plan");
      expect(lines.map(lineText).join("\n")).toContain("API 응답 데이터");
      for (const rendered of lines) expect(lineWidth(rendered)).toBeLessThanOrEqual(columns);
    }
  });

  test("shows active/completed tabs, multi-selection, descriptions, and recommendations", () => {
    const text = renderQuestionnaire(state(), context(120)).map(lineText).join("\n");
    expect(text).toContain("● 데이터 타입");
    expect(text).toContain("[x]");
    expect(text).toContain("[Recommended]");
    expect(text).toContain("네트워크 요청을 줄입니다.");
    expect(text).toContain("Other — type a custom answer");
  });

  test("renders inline text editing and the pause/draft/cancel menu", () => {
    const editing = renderQuestionnaire({
      ...state(),
      activeQuestionIndex: 1,
      answers: [{
        questionId: "failure",
        decisionKey: "cache.failure_policy",
        customText: "원본으로 폴백",
      }],
      textCursor: 3,
    }, context(80)).map(lineText).join("\n");
    expect(editing).toContain("원본으로 폴백");

    const paused = renderQuestionnaire({
      ...state(),
      pauseMenuSelected: 1,
    }, context(80)).map(lineText).join("\n");
    expect(paused).toContain("Pause Deep Plan");
    expect(paused).toContain("Write the plan now with current answers");
    expect(paused).toContain("Cancel this Deep Plan");
  });
});
