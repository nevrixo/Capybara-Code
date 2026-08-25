import { describe, expect, test } from "bun:test";

import { emptyViewModel, planDigest, type SessionViewModel, type TimelineItem } from "@cbc/session-domain";
import { Theme, lineText, lineWidth, stringWidth, type TerminalCapabilities } from "@cbc/tui-components";
import { CAPYBARA_BANNER, renderHomeFrame, renderSessionFrame, resolveComposerCursor } from "../src/tui-frame.ts";

function capabilities(columns: number, rows: number): TerminalCapabilities {
  return {
    colorDepth: "none",
    italic: false,
    unicode: true,
    stableEmojiWidth: true,
    reducedMotion: true,
    mouse: false,
    columns,
    rows,
    hyperlinks: false,
  };
}

function activeModel(text = "hello"): SessionViewModel {
  const timeline: TimelineItem[] = [{
    type: "user",
    id: "user-1",
    sequence: 1,
    turnId: "turn-1",
    text,
    timestamp: "2026-08-09T00:00:00.000Z",
  }];
  return {
    ...emptyViewModel("session"),
    timeline,
    lastSequence: 1,
    currentTurnId: "turn-1",
    turnStatus: "sampling",
    live: { kind: "working", label: "Thinking...", interruptHint: "esc" },
  };
}

function frame(
  columns: number,
  rows: number,
  model: SessionViewModel,
  options: { sidebarVisible?: boolean; notices?: readonly string[]; thinkingVisibility?: "full" | "summary" | "hidden" } = {},
) {
  return renderSessionFrame({
    columns,
    rows,
    theme: new Theme({ depth: "none" }),
    capabilities: capabilities(columns, rows),
    model,
    composer: { text: "", cursor: 0 },
    ...(options.sidebarVisible !== undefined ? { sidebarVisible: options.sidebarVisible } : {}),
    ...(options.thinkingVisibility !== undefined ? { thinkingVisibility: options.thinkingVisibility } : {}),
    mcpServers: [],
    lspServers: [],
    workspacePath: "C:/workspace",
    notices: options.notices ?? [],
    timelineScrollOffsetFromBottom: 0,
    nowMs: 5_000,
  });
}

describe("revision session frame", () => {
  test("shows the active model and reasoning effort in the composer chrome", () => {
    const model = {
      ...activeModel(),
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    };
    const text = frame(120, 28, model).lines.map(lineText).join("\n");
    expect(text).toContain("gpt-5.6-luna");
    expect(text).toContain("high effort");
    expect(text).toContain("Capybara Code");
  });

  test("uses the Plan accent for the composer controls", () => {
    const build = frame(120, 28, activeModel());
    const planModel = {
      ...activeModel(),
      modeState: { ...activeModel().modeState, selected: "plan" as const },
    };
    const plan = frame(120, 28, planModel);
    const prompt = plan.lines
      .filter((row) => row.kind === "composer")
      .flatMap((row) => row.segments)
      .find((part) => part.text === "> ");
    const planBorder = plan.lines.find((row) =>
      row.segments.some((part) => part.fg === "accent.cyan" && part.text.includes("─")),
    );
    const buildBorder = build.lines.find((row) =>
      row.segments.some((part) => part.fg === "accent.coral" && part.text.includes("─")),
    );

    expect(prompt?.fg).toBe("accent.cyan");
    expect(planBorder).toBeDefined();
    expect(buildBorder).toBeDefined();
    const planText = plan.lines.map(lineText).join("\n");
    expect(planText).toContain("Plan ready");
    expect(planText).toContain("Choose an option below");
    expect(planText).not.toContain("/plan");
    expect(planText).toContain("Plan · READ");
    expect(planText).not.toContain("Mode: Plan");
  });

  test("labels a digest-approved Plan with blocked work as execution-blocked", () => {
    const document = {
      goal: "Repair parser input",
      context: ["The parser is used by the CLI"],
      criticalFiles: [{ path: "src/parser.ts" }],
      verification: [{ command: "bun test" }],
      risks: [],
      rollback: [],
    } as const;
    const items = [
      {
        id: "inspect",
        text: "Inspect the parser",
        status: "done" as const,
        kind: "analysis" as const,
        evidence: ["Reviewed parser source"],
      },
      {
        id: "implement",
        text: "Repair parser input",
        status: "blocked" as const,
        kind: "implementation" as const,
        files: ["src/parser.ts"],
        acceptanceCriteria: ["The parser accepts valid input"],
        blockedReason: "The execution environment denied the write",
      },
      { id: "verify", text: "Run tests", status: "pending" as const, kind: "verification" as const },
    ];
    const digest = planDigest(document, items)!;
    const model: SessionViewModel = {
      ...activeModel(),
      modeState: { ...activeModel().modeState, selected: "plan" },
      todo: {
        revision: 4,
        updatedAt: "2026-08-11T00:00:00.000Z",
        document,
        items,
        approval: {
          revision: 3,
          digest,
          approvedAt: "2026-08-11T00:00:00.000Z",
          via: "slash",
          contextStrategy: "keep",
        },
        approvedRevision: 3,
      },
    };

    const text = frame(120, 28, model).lines.map(lineText).join("\n");
    expect(text).toContain("Plan execution blocked");
    expect(text).not.toContain("Plan approved");
  });

  test("keeps global notices visible with a sidebar and pins status last", () => {
    const rendered = frame(120, 28, activeModel(), {
      sidebarVisible: true,
      notices: ["SECURITY WARNING: permission denied"],
    });
    expect(rendered.lines).toHaveLength(28);
    expect(rendered.lines.at(-1)?.kind).toBe("status");
    expect(rendered.lines.map(lineText).join("\n")).toContain("SECURITY WARNING");
    for (const row of rendered.lines) expect(lineWidth(row)).toBeLessThanOrEqual(120);
  });

  test("fits Korean, emoji, and combining input at every critical breakpoint", () => {
    const text = "\ud55c\uae00 \ud83e\uddab e\u0301 ".repeat(80);
    for (const columns of [20, 39, 60, 79, 80, 89, 90, 119, 120]) {
      const rendered = frame(columns, 24, activeModel(text), { sidebarVisible: true });
      expect(rendered.lines).toHaveLength(24);
      expect(rendered.lines.at(-1)?.kind).toBe("status");
      for (const row of rendered.lines) {
        expect(lineWidth(row), `width ${columns}: ${lineText(row)}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("applies completed-turn Thinking summary in fullscreen", () => {
    const model: SessionViewModel = {
      ...activeModel(),
      turnStatus: "completed",
      live: { kind: "complete", label: "Turn complete" },
      timeline: [
        ...activeModel().timeline,
        {
          type: "commentary",
          id: "thinking-1",
          sequence: 2,
          variant: "reasoning_summary",
          text: "first line\nsecond line\nthird line",
          turnId: "turn-1",
          agentId: "root",
        },
        {
          type: "final",
          id: "final-1",
          sequence: 3,
          text: "done",
          turnId: "turn-1",
          agentId: "root",
        },
      ],
      lastSequence: 3,
    };
    const text = frame(100, 30, model, { thinkingVisibility: "summary" })
      .lines.map(lineText).join("\n");
    expect(text).toContain("first line");
    expect(text).toContain("second line");
    expect(text).not.toContain("third line");
  });

  test("keeps RUN visible while a detached background job continues", () => {
    const job = {
      type: "job" as const,
      id: "job-1",
      sequence: 2,
      jobId: "job-1",
      display: "bun test",
      state: "running" as const,
    };
    const model: SessionViewModel = {
      ...activeModel(),
      turnStatus: "completed",
      live: { kind: "complete", label: "Turn complete" },
      timeline: [...activeModel().timeline, job],
      lastSequence: 2,
      activeJobs: [job],
    };

    const text = frame(100, 30, model).lines.map(lineText).join("\n");
    expect(text).toContain("[RUN]");
    expect(text).toContain("Background job running: bun test");
  });

});

function homeFrame(columns: number, rows: number, text: string) {
  return renderHomeFrame({
    columns,
    rows,
    theme: new Theme({ depth: "none" }),
    capabilities: capabilities(columns, rows),
    version: "0.1.0",
    workspacePath: "C:/workspace/a-very-long-project-name",
    model: "gpt-5.6-codex-extra-long-model-name",
    reasoningEffort: "high",
    mcpCount: 12,
    composer: { text, cursor: 3 },
    notices: ["SECURITY WARNING: permission denied"],
  });
}

describe("revision home frame", () => {
  test("preserves row, cursor, status, and width invariants across the support matrix", () => {
    const widths = [20, 39, 40, 59, 60, 79, 80, 89, 90, 119, 120, 160, 240];
    const heights = [8, 12, 15, 16, 24, 40, 80];
    const composerText = "\ud55c\uae00 \ud83e\uddab e\u0301 ".repeat(20);
    for (const columns of widths) {
      for (const rows of heights) {
        const rendered = homeFrame(columns, rows, composerText);
        expect(rendered).toHaveLength(rows);
        expect(rendered.at(-1)?.kind).toBe("status");
        for (const styled of rendered) expect(lineWidth(styled)).toBeLessThanOrEqual(columns);
        const cursor = resolveComposerCursor(rendered, { text: composerText, cursor: 3 }, columns, rows);
        expect(cursor.row).toBeGreaterThanOrEqual(0);
        expect(cursor.row).toBeLessThan(rows);
        expect(cursor.column).toBeGreaterThanOrEqual(0);
        expect(cursor.column).toBeLessThan(columns);
      }
    }
  });

  test("uses borderless emergency chrome and gates the banner by measured width", () => {
    const emergencyText = homeFrame(39, 16, "").map(lineText).join("\n");
    expect(emergencyText).not.toMatch(/[\u250c\u2510\u2514\u2518\u2502]/u);

    const bannerWidth = Math.max(...CAPYBARA_BANNER.map((value) => stringWidth(value)));
    const below = homeFrame(bannerWidth - 1, 30, "").map(lineText).join("\n");
    const exact = homeFrame(bannerWidth, 30, "").map(lineText).join("\n");
    expect(below).not.toContain(CAPYBARA_BANNER[0]!);
    expect(exact).toContain(CAPYBARA_BANNER[0]!);
    expect(exact).toContain("tab completion");
    expect(exact).not.toContain("switch agent");
  });

  test("gives the landing composer enough width on spacious terminals", () => {
    const border = homeFrame(240, 40, "")
      .map(lineText)
      .find((value) => value.includes("┌"));
    expect(border).toBeDefined();
    expect(stringWidth(border!.trim())).toBe(132);
  });
});
