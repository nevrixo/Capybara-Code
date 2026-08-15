import { describe, expect, test } from "bun:test";

import { renderReport, type CompletionReport } from "../src/index.ts";

function report(): CompletionReport {
  return {
    status: "completed",
    summary: "Git prerequisite 확인 결과: 내부 검증 로그",
    changedFiles: [{ path: "index.html", purpose: "write index.html" }],
    verification: [{ command: "bun test", status: "passed", evidence: "process.run ok" }],
    delegatedTasks: [],
    risks: [],
  };
}

describe("final answer boundary", () => {
  test("renders the provider answer before structured evidence", () => {
    const rendered = renderReport(report(), "요청한 랜딩 페이지를 만들었습니다.");

    expect(rendered).toContain("요청한 랜딩 페이지를 만들었습니다.");
    expect(rendered).not.toContain("Git prerequisite 확인 결과");
    expect(rendered).toContain("Verification");
  });

  test("keeps report-only callers compatible", () => {
    expect(renderReport(report())).toContain("Git prerequisite 확인 결과");
  });
});
