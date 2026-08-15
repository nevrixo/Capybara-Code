import { describe, expect, test } from "bun:test";

import { createEvent, EventSequencer } from "@cbc/protocol";

import { replay } from "../src/index.ts";

describe("final answer event boundary", () => {
  test("replay keeps the provider answer separate from the report", () => {
    const event = createEvent(
      new EventSequencer(),
      "assistant.final",
      {
        text: "structured fallback",
        answer: "요청한 작업을 완료했습니다.",
        report: {
          status: "completed",
          summary: "Git prerequisite 확인 결과: 내부 검증 로그",
          changedFiles: [],
          verification: [],
          delegatedTasks: [],
          risks: [],
        },
      },
      { sessionId: "ses_1" },
    );

    const final = replay("ses_1", [event]).timeline[0];
    expect(final?.type).toBe("final");
    if (final?.type !== "final") throw new Error("expected a final timeline item");
    expect(final.answer).toBe("요청한 작업을 완료했습니다.");
    expect(final.report?.summary).toContain("Git prerequisite");
  });
});
