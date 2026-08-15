import { describe, expect, test } from "bun:test";
import { renderTaskCard, lineText, type BlockContext } from "../src/index.ts";

const context: BlockContext = {
  columns: 100,
  capabilities: { unicode: true, italic: false, reducedMotion: true },
};

describe("subagent TaskCard metrics and tool tree", () => {
  test("renders a Claude Code-style summary without individual tool nodes", () => {
    const lines = renderTaskCard(
      {
        role: "explore",
        title: "ExploreRepo",
        goal: "Investigate repo files",
        constraints: [],
        contract: [],
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
        startTimeMs: 1_000,
        tokens: 1250, // 1.3k tokens
        subagentEvents: [
          {
            id: "e1",
            sequence: 1,
            callId: "c1",
            toolId: "fs.search",
            argumentsSummary: "react",
            status: "succeeded",
          },
          {
            id: "e2",
            sequence: 2,
            callId: "c2",
            toolId: "fs.search",
            argumentsSummary: "vite",
            status: "succeeded",
          },
          {
            id: "e3",
            sequence: 3,
            callId: "c3",
            toolId: "fs.glob",
            argumentsSummary: "docs/**/*.md",
            status: "succeeded",
          },
          {
            id: "e4",
            sequence: 4,
            callId: "c4",
            toolId: "fs.read",
            argumentsSummary: "package.json",
            status: "running",
          },
        ],
      },
      context,
      { compact: true, maxToolNodes: 3, nowMs: 116_400 },
    );

    const output = lines.map(lineText).join("\n");

    expect(lines).toHaveLength(2);
    expect(output).toContain("explore (Investigate repo files)");
    expect(output).toContain("Running");
    expect(output).toContain("4 tool uses");
    expect(output).toContain("1.3k tokens");
    expect(output).toContain("1m 55s");

    // The card reports aggregate progress only; individual child calls stay hidden.
    expect(output).not.toContain("vite");
    expect(output).not.toContain("docs/**/*.md");
    expect(output).not.toContain("package.json");
  });
});
