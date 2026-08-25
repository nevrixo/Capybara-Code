import { describe, expect, test } from "bun:test";

import {
  emptyViewModel,
  type SessionViewModel,
  type TimelineItem,
  type TimelineTask,
} from "@cbc/session-domain";
import {
  MarkdownRenderCache,
  PagedTimelineStore,
  ProjectedTimeline,
  TimelineRenderCache,
  blockContext,
  composePreparedScreen,
  composeScreen,
  lineText,
  markdownRenderCacheKey,
  prepareScreen,
  renderMarkdown,
  renderTaskCard,
  renderTimeline,
  timelineRenderCacheKey,
  visibleSlice,
  type BlockContext,
  type ScreenInput,
  type TerminalCapabilities,
  type TimelineRenderOptions,
} from "../src/index.ts";

function capabilities(columns = 80, rows = 24): TerminalCapabilities {
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

function context(columns = 80): BlockContext {
  return blockContext(capabilities(columns), columns);
}

function notice(index: number): TimelineItem {
  return {
    type: "notice",
    id: `notice-${index}`,
    sequence: index + 1,
    level: "info",
    text: `event ${index}`,
  };
}

function commentary(id: string, sequence: number, text: string): TimelineItem {
  return {
    type: "commentary",
    id,
    sequence,
    variant: "reasoning_summary",
    text,
    turnId: "turn-1",
    agentId: "root",
  };
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

function text(lines: readonly ReturnType<typeof renderTimeline>[number][]): string[] {
  return lines.map(lineText);
}

function visibleWindow(
  lines: readonly ReturnType<typeof renderTimeline>[number][],
  rows: number,
  offset: number,
): string[] {
  const range = visibleSlice(lines.length, rows, offset);
  return lines.slice(range.start, range.end).map(lineText);
}

describe("incremental timeline projection", () => {
  test("keeps commentary and successful-read visual group ids stable as they grow", () => {
    const first = commentary("thinking-1", 1, "one");
    const second = commentary("thinking-2", 2, "two");
    const a = read("read-a", 3, "a.ts");
    const b = read("read-b", 4, "b.ts");
    const c = read("read-c", 5, "c.ts");
    const projection = new ProjectedTimeline();

    projection.sync([first], {});
    const commentaryId = projection.visualGroups[0]?.id;
    projection.sync([first, second], {});
    expect(projection.visualGroups[0]?.id).toBe(commentaryId);
    expect(projection.visualGroups[0]?.items).toEqual([first, second]);

    projection.sync([first, second, a], {});
    const readsId = projection.visualGroups[1]?.id;
    projection.sync([first, second, a, b, c], {});
    expect(projection.visualGroups[1]?.id).toBe(readsId);
    expect(projection.visualGroups[1]?.items).toEqual([a, b, c]);

    expect(text(projection.renderAll(context(), {}))).toEqual(
      text(renderTimeline([first, second, a, b, c], context(), {})),
    );
  });

  test("keeps recent child calls hidden unless diagnostics opt in", () => {
    const task: TimelineTask = {
      type: "task",
      id: "task-recent",
      sequence: 1,
      taskId: "agent-recent",
      role: "executor",
      title: "Recent work",
      goal: "Inspect files",
      constraints: [],
      contract: [],
      state: "running",
      childCount: 1,
      awaitInterrupted: false,
      subagentEvents: Array.from({ length: 4 }, (_, index) => ({
        id: `child-${index}`,
        sequence: index + 2,
        callId: `call-${index}`,
        toolId: "fs.write",
        argumentsSummary: `file-${index}.ts`,
        status: "succeeded" as const,
      })),
    };
    const inlineOptions: TimelineRenderOptions = { subagentDetail: "inline" };
    const primary = new ProjectedTimeline(inlineOptions);
    primary.sync([task], inlineOptions);

    expect(primary.projectedItems().map((item) => item.id)).toEqual(["task-recent"]);

    const diagnosticOptions: TimelineRenderOptions = {
      ...inlineOptions,
      inlineSubagentEvents: true,
    };
    const diagnostic = new ProjectedTimeline(diagnosticOptions);
    diagnostic.sync([task], diagnosticOptions);
    const diagnosticIds = diagnostic.projectedItems().map((item) => item.id);

    expect(diagnosticIds).toContain("task-recent::subagent-hidden");
    expect(diagnosticIds).not.toContain("child-0");
    expect(diagnosticIds.filter((id) => id.startsWith("child-"))).toEqual([
      "child-1",
      "child-2",
      "child-3",
    ]);
  });

  test("an unchanged or one-item-appended 10k history inspects no completed prefix", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => notice(index));
    const projection = new ProjectedTimeline();
    projection.sync(items, {});
    projection.resetStats();

    expect(projection.sync([...items], {})).toEqual({
      rebuilt: false,
      appended: 0,
      updated: 0,
    });
    expect(projection.stats.sourceItemsInspected).toBe(0);

    const appended = [...items, notice(10_000)];
    expect(projection.sync(appended, {})).toEqual({
      rebuilt: false,
      appended: 1,
      updated: 0,
    });
    expect(projection.stats.sourceItemsInspected).toBe(1);
    expect(projection.stats.fullRebuilds).toBe(0);

    projection.renderWindowDetails(context(), {}, 20, 0);
    const firstRenderCount = projection.stats.renderedGroups;
    expect(firstRenderCount).toBeLessThanOrEqual(11);
    projection.renderWindowDetails(context(), {}, 20, 0);
    expect(projection.stats.renderedGroups).toBe(firstRenderCount);
  });

  test("refreshes synthetic streaming rows while preserving their stable ids", () => {
    const projection = new ProjectedTimeline();
    const first: TimelineItem = {
      type: "commentary",
      id: "streaming-commentary",
      sequence: 1,
      variant: "commentary",
      text: "first delta",
    };
    projection.sync([first], {});
    const groupId = projection.visualGroups[0]?.id;

    const updated = { ...first, text: "first delta plus the coalesced suffix" };
    expect(projection.sync([updated], {})).toEqual({
      rebuilt: false,
      appended: 0,
      updated: 1,
    });
    expect(projection.visualGroups[0]?.id).toBe(groupId);
    expect(projection.projectedItems()[0]).toEqual(updated);
  });

  test("validates and invalidates only active mutable items during sync", () => {
    const completed = Array.from({ length: 10_000 }, (_, index) => notice(index));
    const task: TimelineTask = {
      type: "task",
      id: "task-event",
      sequence: 10_001,
      taskId: "task-1",
      role: "explore",
      title: "Explore",
      goal: "inspect",
      constraints: [],
      contract: [],
      state: "running",
      childCount: 0,
      awaitInterrupted: false,
      startTimeMs: 0,
      progress: "starting",
      subagentEvents: [],
    };
    const items: TimelineItem[] = [...completed, task];
    const projection = new ProjectedTimeline();
    projection.sync(items, {});
    projection.renderWindowDetails(context(), { nowMs: 1_000 }, 10, 0);
    projection.resetStats();

    task.progress = "halfway";
    task.state = "waiting";
    const result = projection.sync([...items], {});
    expect(result).toEqual({ rebuilt: false, appended: 0, updated: 1 });
    expect(projection.stats.sourceItemsInspected).toBe(1);
    expect(projection.stats.structuralRebuilds).toBe(0);
    expect(
      projection
        .renderWindowDetails(context(), { nowMs: 2_000 }, 10, 0)
        .lines.map(lineText)
        .join("\n"),
    ).toContain("Waiting");
  });

  test("row-aware windows exactly preserve line scrolling and learn only requested rows", () => {
    const items: TimelineItem[] = [
      commentary("thinking-1", 1, "# Plan\n\n- inspect\n- edit"),
      commentary("thinking-2", 2, "Then verify."),
      read("read-a", 3, "a.ts"),
      read("read-b", 4, "b.ts"),
      read("read-c", 5, "c.ts"),
      ...Array.from({ length: 80 }, (_, index) => ({
        ...notice(index + 5),
        sequence: index + 6,
      })),
    ];
    const options: TimelineRenderOptions = { modelId: "gpt-test" };
    const full = renderTimeline(items, context(64), options);
    const projection = new ProjectedTimeline(options);
    projection.sync(items, options);

    for (const offset of [0, 1, 7, 29, 10_000]) {
      const details = projection.renderWindowDetails(
        context(64),
        options,
        12,
        offset,
      );
      expect(visibleWindow(details.lines, 12, offset)).toEqual(
        visibleWindow(full, 12, offset),
      );
    }
    expect(projection.renderWindowDetails(context(64), options, 12, 10_000).totalLines)
      .toBe(full.length);
  });

  test("a giant cached Markdown item returns only the requested row suffix", () => {
    const answer = Array.from(
      { length: 2_000 },
      (_, index) => `paragraph ${index} with **emphasis**`,
    ).join("\n\n");
    const item: TimelineItem = {
      type: "final",
      id: "final-large",
      sequence: 1,
      text: answer,
      answer,
      agentId: "root",
    };
    const projection = new ProjectedTimeline();
    projection.sync([item], {});
    projection.resetStats();

    const first = projection.renderWindowDetails(context(72), {}, 8, 0);
    expect(first.lines).toHaveLength(8);
    expect(projection.stats).toMatchObject({
      renderedGroups: 1,
      boundedMarkdownRenders: 1,
      fullMarkdownFallbacks: 0,
      markdownSourceLinesRendered: 8,
    });
    // The row-aware path is the exact suffix of the authoritative full renderer.
    const authoritative = renderTimeline([item], context(72), {});
    expect(first.lines).toEqual(authoritative.slice(-8));

    const second = projection.renderWindowDetails(context(72), {}, 8, 0);
    expect(second.lines).toEqual(first.lines);
    expect(projection.stats.renderedGroups).toBe(1);
    expect(projection.stats.markdownSourceLinesRendered).toBe(8);

    const scrolled = projection.renderWindowDetails(context(72), {}, 8, 37);
    expect(visibleWindow(scrolled.lines, 8, 37)).toEqual(
      visibleWindow(authoritative, 8, 37),
    );
    expect(projection.stats.markdownSourceLinesRendered).toBeLessThanOrEqual(53);
    // Plain/unbounded output remains byte-for-byte semantically exact.
    expect(projection.renderAll(context(72), {})).toEqual(authoritative);
  });

  test("a growing commentary group indexes new item references without rejoining its history", () => {
    const items = Array.from({ length: 900 }, (_, index) =>
      commentary(`chunk-${index}`, index + 1, `chunk ${index}`),
    );
    const options: TimelineRenderOptions = { groupAssistant: true };
    const projection = new ProjectedTimeline(options);
    projection.sync(items, options);
    const first = projection.renderWindowDetails(context(60), options, 10, 0);
    const authoritative = renderTimeline(items, context(60), options);
    expect(first.lines).toEqual(authoritative.slice(-10));
    expect(projection.visualGroups).toHaveLength(1);
    expect(projection.visualGroups[0]?.items).toHaveLength(900);

    const appended = commentary("chunk-900", 901, "chunk 900");
    projection.resetStats();
    projection.sync([...items, appended], options);
    const next = projection.renderWindowDetails(context(60), options, 10, 0);
    const nextAuthoritative = renderTimeline(
      [...items, appended],
      context(60),
      options,
    );
    expect(next.lines).toEqual(nextAuthoritative.slice(-10));
    expect(projection.stats).toMatchObject({
      sourceItemsInspected: 1,
      boundedMarkdownRenders: 1,
      fullMarkdownFallbacks: 0,
    });
    expect(projection.stats.markdownSourceLinesRendered).toBeLessThanOrEqual(10);
  });

  test("row-bounded commentary preserves fence state when its source begins offscreen", () => {
    const body = [
      "Before",
      "```ts",
      ...Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};`),
      "```",
      "After",
    ].join("\n");
    const item = commentary("giant-fence", 1, body);
    const projection = new ProjectedTimeline();
    projection.sync([item], {});
    projection.resetStats();

    const details = projection.renderWindowDetails(context(54), {}, 12, 25);
    const authoritative = renderTimeline([item], context(54), {});
    expect(visibleWindow(details.lines, 12, 25)).toEqual(
      visibleWindow(authoritative, 12, 25),
    );
    expect(projection.stats.fullMarkdownFallbacks).toBe(0);
    expect(projection.stats.markdownSourceLinesRendered).toBeLessThanOrEqual(37);
  });

  test("initial out-of-order input and policy changes preserve legacy semantics", () => {
    const items = [
      notice(3),
      read("read-a", 1, "a.ts"),
      read("read-b", 2, "b.ts"),
      read("read-c", 3, "c.ts"),
    ];
    const projection = new ProjectedTimeline();
    projection.sync(items, {});
    expect(text(projection.renderAll(context(), {}))).toEqual(
      text(renderTimeline(items, context(), {})),
    );

    const fullOptions: TimelineRenderOptions = {
      toolDetail: "full",
      groupSucceededReads: false,
      themeId: "alternate",
    };
    const result = projection.sync(items, fullOptions);
    expect(result.rebuilt).toBe(true);
    expect(text(projection.renderAll(context(), fullOptions))).toEqual(
      text(renderTimeline(items, context(), fullOptions)),
    );
  });
});

describe("bounded historical page residency", () => {
  test("keeps only the newest three pages and deduplicates overlaps", () => {
    const store = new PagedTimelineStore<{ id: string; sequence: number }>({ maxResidentPages: 3 });
    const evicted: string[] = [];
    for (let page = 0; page < 4; page += 1) {
      evicted.push(...store.prependPage({
        id: `page-${page}`,
        firstSequence: page * 64 + 1,
        lastSequence: page * 64 + 64,
        items: Array.from({ length: 64 }, (_, index) => ({
          id: `item-${page * 64 + index + 1}`,
          sequence: page * 64 + index + 1,
        })),
      }));
    }
    expect(evicted).toEqual(["page-0"]);
    expect(store.pageCount).toBe(3);
    expect(store.historicalItems).toHaveLength(192);
    expect(store.historicalItems[0]?.sequence).toBe(65);
    store.prependPage({
      id: "overlap",
      firstSequence: 64,
      lastSequence: 65,
      items: [{ id: "item-64", sequence: 64 }, { id: "item-65", sequence: 65 }],
    });
    expect(store.historicalItems.filter((item) => item.id === "item-65")).toHaveLength(1);
  });

  test("prepends and drops a projected historical page", () => {
    const projection = new ProjectedTimeline();
    projection.sync([notice(100)], {});
    expect(projection.prependPage("history-1", [notice(0), notice(1)])).toBe(2);
    expect(projection.projectedItems().map((item) => item.id)).toEqual(["notice-0", "notice-1", "notice-100"]);
    expect(projection.dropPage("history-1")).toBe(true);
    expect(projection.projectedItems().map((item) => item.id)).toEqual(["notice-100"]);
  });
});

describe("semantic render caches", () => {
  test("timeline item keys include width, capabilities, theme and disclosure policy", () => {
    const base = timelineRenderCacheKey(context(80), {
      thinkingVisibility: "full",
      toolDetail: "compact",
      subagentDetail: "drawer",
      themeId: "dark",
    });
    expect(timelineRenderCacheKey(context(79), {
      thinkingVisibility: "full",
      toolDetail: "compact",
      subagentDetail: "drawer",
      themeId: "dark",
    })).not.toBe(base);
    expect(timelineRenderCacheKey(context(80), {
      thinkingVisibility: "summary",
      toolDetail: "compact",
      subagentDetail: "drawer",
      themeId: "dark",
    })).not.toBe(base);
    expect(timelineRenderCacheKey(context(80), {
      thinkingVisibility: "full",
      toolDetail: "full",
      subagentDetail: "inline",
      themeId: "light",
    })).not.toBe(base);
  });

  test("item cache reuses immutable output and revision/options invalidate it", () => {
    const cache = new TimelineRenderCache();
    const item = notice(1);
    const first = cache.renderItem(item, 0, context(), {});
    const second = cache.renderItem(item, 0, context(), {});
    expect(second).toBe(first);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1 });

    cache.renderItem(item, 1, context(), {});
    cache.renderItem(item, 1, context(), { themeId: "other" });
    cache.renderItem(item, 1, context(60), { themeId: "other" });
    expect(cache.stats.misses).toBe(4);
  });

  test("Markdown cache keys every semantic option and remains bounded", () => {
    const cache = new MarkdownRenderCache({
      maxEntries: 2,
      maxSourceCharacters: 1_000,
    });
    const raw = "# Heading\n\n**bold** body";
    const first = renderMarkdown(raw, context(40), { kind: "final" }, cache);
    const second = renderMarkdown(raw, context(40), { kind: "final" }, cache);
    expect(second).toBe(first);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1, entries: 1 });

    renderMarkdown(raw, context(30), { kind: "final" }, cache);
    renderMarkdown(raw, context(30), {
      kind: "final",
      style: { fg: "fg.muted", italic: true },
      cacheVariant: "theme-b",
    }, cache);
    expect(cache.stats.misses).toBe(3);
    expect(cache.stats.entries).toBeLessThanOrEqual(2);
    expect(cache.stats.evictions).toBeGreaterThan(0);

    expect(markdownRenderCacheKey(context(40), { kind: "final" })).not.toBe(
      markdownRenderCacheKey(context(40), {
        kind: "final",
        prefix: "  ",
      }),
    );
  });
});

describe("single-pass screen preparation", () => {
  function screenInput(projection?: ProjectedTimeline): ScreenInput {
    const model = emptyViewModel("screen-performance") as SessionViewModel;
    model.timeline.push(...Array.from({ length: 100 }, (_, index) => notice(index)));
    return {
      model,
      composer: { text: "hello", cursor: 5, busy: false },
      capabilities: capabilities(100, 30),
      timelineRows: 14,
      timelineScrollOffsetFromBottom: 3,
      notices: ["notice"],
      sidebarVisible: true,
      ...(projection !== undefined ? { timelineProjection: projection } : {}),
    };
  }

  test("prepare + compose is identical to the compatibility composeScreen API", () => {
    const input = screenInput();
    const direct = composeScreen(input);
    const prepared = prepareScreen(input);
    const staged = composePreparedScreen(prepared);
    expect(staged.plan).toEqual(direct.plan);
    expect(staged.timelineMaxScrollOffset).toBe(direct.timelineMaxScrollOffset);
    expect(staged.lines).toEqual(direct.lines);
  });

  test("composeScreen uses a supplied session projection incrementally", () => {
    const projection = new ProjectedTimeline();
    const input = screenInput(projection);
    composeScreen(input);
    projection.resetStats();
    composeScreen(input);
    expect(projection.stats.sourceItemsInspected).toBe(0);
    expect(projection.stats.renderedGroups).toBe(0);

    input.model.timeline.push(notice(100));
    composeScreen(input);
    expect(projection.stats.sourceItemsInspected).toBe(1);
    expect(projection.stats.fullRebuilds).toBe(0);
  });

  test("a custom-composer host can prepare chrome without rendering a duplicate composer", () => {
    const prepared = prepareScreen(screenInput(), { renderComposer: false });
    expect(prepared.composer).toEqual([]);
    const screen = composePreparedScreen(prepared, { timelineRows: 8 });
    expect(screen.composer).toEqual([]);
    expect(screen.live).toBe(prepared.live);
    expect(screen.status).toBe(prepared.status);
    expect(screen.sidebar).toBe(prepared.sidebar);
  });
});

describe("resident subagent detail summary", () => {
  test("task cards retain child-call details only in an explicit detail view", () => {
    const task: Parameters<typeof renderTaskCard>[0] = {
      role: "explore",
      title: "Long task",
      goal: "inspect",
      constraints: [],
      contract: [],
      state: "running",
      childCount: 0,
      awaitInterrupted: false,
      subagentEventCount: 35,
      subagentEventsOmitted: 33,
      subagentEvents: [
        {
          id: "child-34",
          sequence: 34,
          callId: "call-34",
          toolId: "fs.read",
          argumentsSummary: "recent-a.ts",
          status: "succeeded",
        },
        {
          id: "child-35",
          sequence: 35,
          callId: "call-35",
          toolId: "fs.read",
          argumentsSummary: "recent-b.ts",
          status: "running",
        },
      ],
    };
    const full = renderTaskCard(task, context(120), { maxToolNodes: 3 })
      .map(lineText)
      .join("\n");
    expect(full).toContain("35 tool uses");
    expect(full).toContain("33 earlier calls omitted");
    expect(full).toContain("recent-a.ts");

    const compact = renderTaskCard(task, context(120), { compact: true })
      .map(lineText)
      .join("\n");
    expect(compact).toContain("35 tool uses");
    expect(compact).toContain("Running");
    expect(compact).not.toContain("33 earlier calls omitted");
    expect(compact).not.toContain("recent-a.ts");
  });
});
