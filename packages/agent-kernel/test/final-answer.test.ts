import { describe, expect, test } from "bun:test";

import { deriveCompletionPresentation, renderChatResponse, renderReport, type CompletionReport } from "../src/index.ts";

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

  test("classifies partial verification as attention instead of failure", () => {
    const partial: CompletionReport = {
      ...report(),
      status: "partial",
      verification: [{ command: "browser smoke", status: "not_run", evidence: "Windows environment unavailable" }],
      risks: ["browser smoke could not run in this environment"],
    };
    const presentation = deriveCompletionPresentation(partial, "랜딩 페이지는 반영됐습니다.");
    expect(presentation.disposition).toBe("attention");
    expect(presentation.evidenceMode).toBe("summary");
    expect(presentation.issues.some((issue) => issue.code === "verification_not_run")).toBe(true);
    expect(presentation.issues.some((issue) => issue.severity === "error")).toBe(false);
    expect(renderChatResponse(partial, "랜딩 페이지는 반영됐습니다.", { presentation })).toContain("확인이 남았습니다");
  });

  test("classifies a permission block as blocked and expands evidence", () => {
    const blocked: CompletionReport = {
      ...report(),
      status: "partial",
      changedFiles: [],
      risks: ["PERMISSION_DENIED: workspace write permission was denied"],
    };
    const presentation = deriveCompletionPresentation(blocked);
    expect(presentation.disposition).toBe("blocked");
    expect(presentation.evidenceMode).toBe("expanded");
    expect(presentation.issues[0]?.code).toBe("permission_blocked");
  });
});
