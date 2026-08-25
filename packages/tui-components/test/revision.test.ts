import { describe, expect, test } from "bun:test";

import type { TimelineItem } from "@cbc/session-domain";
import {
  DEFAULT_PRESENTATION_POLICY,
  blockContext,
  joinColumns,
  line,
  lineText,
  lineWidth,
  planLayout,
  projectTimeline,
  renderBox,
  renderTaskCard,
  renderTimeline,
  renderTimelineItem,
  renderTimelineWindow,
  renderToolDiscovery,
  segment,
  type TaskCardView,
  type TerminalCapabilities,
} from "../src/index.ts";

function capabilities(columns: number, rows = 40): TerminalCapabilities {
  return {
    colorDepth: "truecolor",
    italic: true,
    unicode: true,
    stableEmojiWidth: true,
    reducedMotion: false,
    mouse: false,
    columns,
    rows,
    hyperlinks: false,
  };
}

function context(columns: number) {
  return blockContext(capabilities(columns), columns);
}

function read(id: string, sequence: number, path: string): TimelineItem {
  return {
    type: "tool",
    id,
    sequence,
    callId: id,
    toolId: "fs.read",
    argumentsSummary: path,
    status: "succeeded",
    summary: `Read ${path}`,
  };
}

function reasoning(id: string, sequence: number, text: string, agentId = "root"): TimelineItem {
  return {
    type: "thinking",
    id,
    sequence,
    turnId: "turn-1",
    agentId,
    requestId: `request:${id}`,
    segmentIndex: 0,
    providerItemIds: [id],
    state: "completed",
    sources: ["provider_reasoning"],
    summaryText: text.split("\n", 1)[0] ?? text,
    summaryOrigin: "derived_from_visible_detail",
    detailText: text,
  };
}

describe("shared presentation projection", () => {
  test("uses the revision defaults", () => {
    expect(DEFAULT_PRESENTATION_POLICY).toEqual({
      thinkingVisibility: "summary",
      thinkingMode: "collapsed",
      toolDetail: "compact",
      subagentDetail: "drawer",
    });
  });

  test("groups successful reads and hides approvals and child prose/tools", () => {
    const items: TimelineItem[] = [
      reasoning("think-1", 1, "first"),
      reasoning("think-2", 2, "second"),
      read("read-1", 3, "a.ts"),
      read("read-2", 4, "b.ts"),
      read("read-3", 5, "c.ts"),
      {
        type: "tool",
        id: "child-tool",
        sequence: 6,
        callId: "child-tool",
        toolId: "fs.write",
        argumentsSummary: "child.ts",
        agentId: "agent-2",
        status: "succeeded",
      },
      reasoning("child-thinking", 7, "private child reasoning", "agent-2"),
      {
        type: "approval",
        id: "approval-1",
        sequence: 8,
        approvalId: "approval-1",
        action: "shell",
        display: "run command",
        riskClass: "R2",
        reason: "test",
        network: false,
        sideEffects: [],
      },
    ];

    const projected = projectTimeline(items);
    expect(projected.map((item) => item.id)).toEqual(["think-1", "think-2", "group-read-read-1"]);
    expect(projected[0]?.type).toBe("thinking");
    expect(projected[1]?.type).toBe("thinking");
    if (projected[0]?.type === "thinking" && projected[1]?.type === "thinking") {
      expect(projected[0].summaryText).toBe("first");
      expect(projected[1].summaryText).toBe("second");
    }
    expect(projected.some((item) => item.id === "child-thinking")).toBe(false);

    const inline = projectTimeline(items, { subagentDetail: "inline" });
    expect(inline.some((item) => item.id === "child-tool")).toBe(false);
    expect(inline.some((item) => item.id === "child-thinking")).toBe(false);

    const diagnostic = projectTimeline(items, {
      subagentDetail: "inline",
      inlineSubagentEvents: true,
    });
    expect(diagnostic.some((item) => item.id === "child-tool")).toBe(true);
    expect(diagnostic.some((item) => item.id === "child-thinking")).toBe(false);
  });

  test("applies expanded, collapsed, and off Thinking disclosure consistently", () => {
    const items: TimelineItem[] = [
      reasoning("think-1", 1, "line one\nline two\nline three"),
      {
        type: "final",
        id: "final-1",
        sequence: 2,
        text: "done",
        turnId: "turn-1",
        agentId: "root",
      },
    ];

    const full = renderTimeline(items, context(80), {
      thinkingMode: "expanded",
      turnActive: false,
    }).map(lineText).join("\n");
    expect(full).toContain("line three");
    expect(full).toContain("Thought");
    expect(full).not.toContain("Reasoning summary");

    const summary = renderTimeline(items, context(80), {
      thinkingMode: "collapsed",
      turnActive: false,
    }).map(lineText).join("\n");
    expect(summary).toContain("line one");
    expect(summary).not.toContain("line two");
    expect(summary).not.toContain("line three");

    const current = renderTimeline(items, context(80), {
      thinkingMode: "collapsed",
      currentTurnId: "turn-1",
      turnActive: true,
    }).map(lineText).join("\n");
    expect(current).toContain("line one");
    expect(current).not.toContain("line three");

    const hidden = renderTimeline(items, context(80), {
      thinkingMode: "off",
      turnActive: false,
    }).map(lineText).join("\n");
    expect(hidden).not.toContain("Reasoning summary");
    expect(hidden).not.toContain("line one");
  });

  test("keeps discovery and tool failures within compact budgets", () => {
    const discovery = {
      query: "database migrations",
      matches: [
        { toolId: "a", title: "Alpha", description: "first", score: 0.9 },
        { toolId: "b", title: "Beta", description: "second", score: 0.8 },
      ],
      activated: ["a", "b"],
      activeCount: 2,
      totalCount: 20,
      limit: 5,
    };
    expect(renderToolDiscovery(discovery, context(80))).toHaveLength(1);
    expect(renderToolDiscovery(discovery, context(80), { expanded: true }).length).toBeGreaterThan(1);

    const failure: TimelineItem = {
      type: "tool",
      id: "failed-tool",
      sequence: 1,
      callId: "failed-tool",
      toolId: "shell.exec",
      argumentsSummary: "npm test",
      status: "failed",
      summary: "many details that must remain bounded",
      errorCode: "EXIT_1",
      exitCode: 1,
    };
    expect(renderTimelineItem(failure, context(80), { toolDetail: "compact" }).length).toBeLessThanOrEqual(3);
  });

  test("renders deterministic compact subagent milestones", () => {
    const task: TaskCardView = {
      role: "executor",
      title: "Build UI",
      goal: "Implement the screen",
      constraints: [],
      contract: [],
      state: "completed",
      childCount: 0,
      summary: "Implemented and verified",
      awaitInterrupted: false,
      durationMs: 1_200,
      subagentEvents: [],
    };
    const completed = renderTaskCard(task, context(80), { compact: true, nowMs: 99_999 });
    expect(completed).toHaveLength(2);
    expect(lineText(completed[0]!)).toContain("executor");
    expect(lineText(completed[1]!)).toContain("Done");
    expect(lineText(completed[1]!)).toContain("1.2s");
    expect(lineText(completed[1]!)).toContain("Implemented and verified");

    const runningTask: TaskCardView = {
      role: "executor",
      title: "Build UI",
      goal: "Implement the screen",
      constraints: [],
      contract: [],
      state: "running",
      childCount: 0,
      awaitInterrupted: false,
      startTimeMs: 1_000,
      subagentEventCount: 2,
      tokens: 1_250,
      subagentEvents: [],
    };
    const running = renderTaskCard(
      runningTask,
      context(80),
      { compact: true, nowMs: 3_400 },
    );
    expect(running).toHaveLength(2);
    expect(lineText(running[0]!)).toContain("executor");
    expect(lineText(running[1]!)).toContain("Running");
    expect(lineText(running[1]!)).toContain("2 tool uses");
    expect(lineText(running[1]!)).toContain("1.3k tokens");
    expect(lineText(running[1]!)).toContain("2.4s");
  });
});

describe("responsive width invariants", () => {
  const widths = [1, 20, 39, 60, 79, 80, 89, 90, 119, 120];

  test("keeps sidebar hidden by default and every joined row within columns", () => {
    for (const columns of widths) {
      const defaultPlan = planLayout(columns, { rows: 40 });
      expect(defaultPlan.showSidebar).toBe(false);
      const explicitPlan = planLayout(columns, { rows: 40, sidebarVisible: true });
      const long = line("body", [segment("x".repeat(columns * 3 + 3))]);
      const joined = joinColumns([long], [long], explicitPlan, context(columns));
      expect(joined.length).toBe(1);
      expect(lineWidth(joined[0]!)).toBeLessThanOrEqual(columns);
    }
  });

  test("drops box chrome below 40 columns and clamps body content", () => {
    for (const columns of [1, 20, 39]) {
      const rendered = renderBox(
        [segment("Header")],
        [line("body", [segment("content ".repeat(20))])],
        context(columns),
      );
      expect(rendered.some((row) => row.kind === "border")).toBe(false);
      for (const row of rendered) expect(lineWidth(row)).toBeLessThanOrEqual(columns);
    }
    expect(renderBox([segment("Header")], [line("body", [segment("content")])], context(40))
      .some((row) => row.kind === "border")).toBe(true);
  });

  test("bounds a 10k-event window without rendering the whole transcript", () => {
    const items: TimelineItem[] = Array.from({ length: 10_000 }, (_, index) => ({
      type: "notice",
      id: `notice-${index}`,
      sequence: index + 1,
      level: "info",
      text: `event ${index}`,
    }));
    const rendered = renderTimelineWindow(items, context(80), {}, 20);
    expect(rendered.length).toBeLessThanOrEqual(21);
    expect(rendered.map(lineText).join("\n")).toContain("event 9999");
  });
});
