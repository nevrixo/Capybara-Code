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

  test("uses chat-first presentation and folds audit evidence", () => {
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
    expect(output).toContain("랜딩 페이지를 통합했습니다.");
    expect(output).toContain("변경 1 · 검증 1/1");
    expect(output).not.toContain("Final answer");
    expect(output).not.toContain("internal audit summary");
    expect(output).not.toContain("Verification");
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
