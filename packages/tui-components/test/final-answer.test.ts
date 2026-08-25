import { describe, expect, test } from "bun:test";

import { renderFinal, lineText, type BlockContext } from "../src/index.ts";

const context: BlockContext = {
  columns: 100,
  capabilities: { unicode: false, italic: false, reducedMotion: true },
};

describe("final answer rendering", () => {
  test("uses the provider answer instead of the report summary", () => {
    const lines = renderFinal(
      {
        answer: "요청한 랜딩 페이지를 만들었습니다.",
        text: "내부 report 텍스트",
        report: {
          status: "completed",
          summary: "Git prerequisite 확인 결과: 내부 검증 로그",
          changedFiles: [{ path: "index.html", purpose: "write index.html" }],
          verification: [{ command: "bun test", status: "passed", evidence: "process.run ok" }],
          delegatedTasks: [],
          risks: [],
        },
      },
      context,
    );
    const output = lines.map(lineText).join("\n");

    expect(output).toContain("요청한 랜딩 페이지를 만들었습니다.");
    expect(output).not.toContain("Git prerequisite 확인 결과");
    expect(output).toContain("Verification");
  });

  test("uses chat-first presentation to render only the provider answer by default", () => {
    const lines = renderFinal({
      answer: "랜딩 페이지를 통합했습니다.",
      text: "랜딩 페이지를 통합했습니다.",
      presentation: {
        disposition: "success",
        issues: [],
        evidenceMode: "summary",
        locale: "ko",
      },
      report: {
        status: "completed",
        summary: "internal audit summary",
        changedFiles: [{ path: "index.html", purpose: "통합" }],
        verification: [{ command: "bun test", status: "passed", evidence: "통과" }],
        delegatedTasks: [],
        risks: [],
      },
    }, context);
    const output = lines.map(lineText).join("\n");
    expect(output).toBe("랜딩 페이지를 통합했습니다.");
    expect(output).not.toContain("Final answer");
    expect(output).not.toContain("internal audit summary");
    expect(output).not.toContain("Verification");
  });

  test("keeps collapsed audit evidence available as an explicit opt-in", () => {
    const lines = renderFinal({
      answer: "랜딩 페이지를 통합했습니다.",
      text: "랜딩 페이지를 통합했습니다.",
      presentation: {
        disposition: "success",
        issues: [],
        evidenceMode: "summary",
        locale: "ko",
      },
      report: {
        status: "completed",
        summary: "internal audit summary",
        changedFiles: [{ path: "index.html", purpose: "통합" }],
        verification: [{ command: "bun test", status: "passed", evidence: "통과" }],
        delegatedTasks: [],
        risks: [],
      },
    }, context, { evidenceMode: "collapsed" });
    const output = lines.map(lineText).join("\n");
    expect(output).toContain("랜딩 페이지를 통합했습니다.");
    expect(output).toContain("변경 1 · 검증 1/1");
  });

  test("does not label a provider final as failed or append report diagnostics", () => {
    const lines = renderFinal({
      answer: "가능한 범위까지 반영했습니다.",
      text: "report fallback",
      presentation: {
        disposition: "failure",
        issues: [{ code: "tool_failure", severity: "error", message: "검증 실패" }],
        evidenceMode: "expanded",
        locale: "ko",
      },
      report: {
        status: "failed",
        summary: "internal failure summary",
        changedFiles: [{ path: "index.html", purpose: "통합" }],
        verification: [{ command: "bun test", status: "failed", evidence: "실패" }],
        delegatedTasks: [],
        risks: ["internal risk"],
      },
    }, context);
    const output = lines.map(lineText).join("\n");
    expect(output).toBe("가능한 범위까지 반영했습니다.");
    expect(output).not.toContain("작업을 완료하지 못했습니다");
    expect(output).not.toContain("확인이 남았습니다");
  });

  test("renders nothing for cancellation without a provider answer", () => {
    const lines = renderFinal({
      text: "The turn was cancelled.",
      presentation: {
        disposition: "cancelled",
        issues: [{ code: "permission_blocked", severity: "blocking", message: "Workspace permissions blocked the change." }],
        evidenceMode: "expanded",
        locale: "en",
      },
      report: {
        status: "cancelled",
        summary: "The turn was cancelled.",
        changedFiles: [{ path: "src/main.ts", purpose: "not found" }],
        verification: [{ command: "bun test", status: "failed", evidence: "not found" }],
        delegatedTasks: [],
        risks: ["internal diagnostics"],
      },
    }, context);

    expect(lines).toEqual([]);
  });

  test("renders one concise status for failure without a provider answer", () => {
    const lines = renderFinal({
      text: "internal failure summary",
      presentation: {
        disposition: "failure",
        issues: [{ code: "tool_failure", severity: "error", message: "Internal failure" }],
        evidenceMode: "expanded",
        locale: "en",
      },
      report: {
        status: "failed",
        summary: "internal failure summary",
        changedFiles: [],
        verification: [],
        delegatedTasks: [],
        risks: [],
      },
    }, context);
    const output = lines.map(lineText).join("\n");

    expect(lines).toHaveLength(1);
    expect(output).toContain("The task could not be completed");
    expect(output).not.toContain("internal failure summary");
  });

  test("handles multiline verification commands without breaking box layout or line widths", () => {
    const lines = renderFinal(
      {
        answer: "완료",
        text: "완료",
        report: {
          status: "completed",
          summary: "summary",
          changedFiles: [{ path: "index.html", purpose: "write index.html" }],
          verification: [
            {
              command: "python3 -c from html.parser import HTMLParser\nfrom pathlib import Path\np = Path('index.html')\nclass Checker(HTMLParser):\n pass\nChecker().feed(p.read_text())",
              status: "passed",
              evidence: "process.run ok: python3 -c 'fr...",
            },
          ],
          delegatedTasks: [],
          risks: [],
        },
      },
      context,
    );

    // Every line in the rendered box must have exact string width matching context.columns
    for (const l of lines) {
      const text = lineText(l);
      expect(text.includes("\n")).toBe(false);
    }

    const output = lines.map(lineText).join("\n");
    expect(output).toContain("python3 -c from html.parser import HTMLParser from pathlib import Path");
  });
});
