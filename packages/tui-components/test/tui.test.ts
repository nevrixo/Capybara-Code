/**
 * TUI tests — PRD §6, §25.8, AC-04, AC-05, AC-06, AC-07, AC-33, AC-40, AC-45.
 *
 * §25.8 asks for a terminal matrix of 60×20, 80×24, 120×40, and 180×50 crossed with
 * a content matrix that includes CJK, emoji fallback, long paths, nested task trees,
 * the update banner, approval cards, background completion, aborts, no-colour, and
 * 16-colour. The suite below walks that grid, and every golden assertion checks
 * semantic cells rather than colour bytes so a theme change cannot silently break
 * the meaning.
 */

import { describe, expect, test } from "bun:test";

import {
  createModeState,
  emptyViewModel,
  requestModeChange,
  type SessionViewModel,
  type TimelineItem,
  type TimelineTask,
} from "@cbc/session-domain";

import {
  AWAIT_INTERRUPTED_MESSAGE,
  CAPYBARA_2026_THEME,
  OPENCODE_THEME,
  CAPYBARA_DARK,
  CLOSED_COMPLETION,
  COLUMN_DIVIDER_WIDTH,
  COMPACT_TERMINAL_WARNING,
  COMPLETION_HINT_ASCII,
  COMPOSER_HINT,
  CTRL_C_EXIT_HINT,
  CTRL_C_EXIT_WINDOW_MS,
  DEFAULT_KEYMAP,
  DEFAULT_PALETTE_NAME,
  DIFF_SCOPE_LABELS,
  ESCAPE_CANCEL_HINT,
  ESCAPE_SCOPE_TURN,
  MAIN_FRACTION,
  MAX_MINI_DIFF_LINES,
  OPERATION_ABORTED_MESSAGE,
  SIDEBAR_FRACTION,
  SLASH_COMMANDS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  TRANSPARENT,
  TURN_CANCEL_WINDOW_MS,
  Theme,
  acceptCompletion,
  applyRemapping,
  blockContext,
  breakpointFor,
  capToSentences,
  columnForOffset,
  compactPath,
  completionKindAt,
  completionPrefix,
  completionWindow,
  composeScreen,
  computeCompletions,
  contrastRatio,
  deleteGraphemeBefore,
  detectCapabilities,
  enterSequence,
  escapeScopeFor,
  fitStatusFields,
  formatDuration,
  formatTokens,
  graphemeWidth,
  graphemes,
  hasForbiddenSequence,
  icon,
  isWhitespaceOnlyHunk,
  joinColumns,
  line,
  lineText,
  lineWidth,
  moveCompletion,
  offsetForColumn,
  padToWidth,
  palette,
  parseHex,
  parseUnifiedDiff,
  planLayout,
  renderAnsi,
  renderApproval,
  renderUserAsk,
  renderCommentary,
  renderCompletionPopup,
  renderComposer,
  renderDiffSummary,
  renderDiffViewer,
  renderGauge,
  renderJob,
  renderKeymapHelp,
  renderMarkdown,
  renderLiveLine,
  renderMiniDiff,
  renderNotice,
  renderOverlay,
  renderPlan,
  renderRightSidebar,
  sidebarFromViewModel,
  renderSelectableList,
  renderStatusBar,
  renderTaskCard,
  renderTimeline,
  renderToolCall,
  renderToolDiscovery,
  renderUpdateBanner,
  renderUserMessage,
  resolveCtrlC,
  resolveEscape,
  resolveKey,
  restoreSequence,
  sanitizeInline,
  sanitizeText,
  searchSlashCommands,
  selectedCandidate,
  segment,
  sidebarModeFor,
  signatureText,
  splitColumns,
  stringWidth,
  toAnsi16,
  toSemanticCells,
  toXterm256,
  todoBox,
  toolActionLabel,
  truncateToWidth,
  turnCompleteLabel,
  updateBannerText,
  visibleSlice,
  wrapComposer,
  wrapToWidth,
  applySelectionOverlay,
  base64Encode,
  cellInSelection,
  extractSelectionText,
  isMultiCell,
  makeToast,
  normalizedSpan,
  osc52Copy,
  renderToast,
  toastExpired,
  TOAST_DURATION_MS,
  type TerminalCapabilities,
  type SelectionState,
  type StyledLine,
  type ToastState,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capabilities(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    colorDepth: "truecolor",
    italic: true,
    unicode: true,
    stableEmojiWidth: true,
    reducedMotion: false,
    mouse: false,
    columns: 80,
    rows: 24,
    hyperlinks: false,
    ...overrides,
  };
}

function context(columns = 80, overrides: Partial<TerminalCapabilities> = {}) {
  return blockContext(capabilities({ columns, ...overrides }), columns);
}

/** §25.8's terminal matrix. */
const TERMINAL_MATRIX: ReadonlyArray<readonly [number, number]> = [
  [60, 20],
  [80, 24],
  [120, 40],
  [180, 50],
];

// ---------------------------------------------------------------------------
// §6.5 theme and colour fallbacks — AC-45
// ---------------------------------------------------------------------------

describe("theme and colour fallbacks (§6.5, AC-45)", () => {
  test("the default palette is the OpenCode theme", () => {
    const theme = new Theme({ depth: "truecolor" });
    expect(theme.name).toBe(DEFAULT_PALETTE_NAME);
    expect(theme.hex("bg.base")).toBe("#0d0e14");
    expect(theme.hex("bg.panel")).toBe("#1a1b26");
    expect(theme.hex("fg.primary")).toBe("#c0caf5");
    expect(theme.hex("fg.muted")).toBe("#565f89");
    expect(theme.hex("accent.coral")).toBe("#7aa2f7");
    expect(theme.hex("accent.green")).toBe("#9ece6a");
    expect(theme.hex("accent.cyan")).toBe("#7dcfff");
    expect(theme.hex("accent.red")).toBe("#f7768e");
    expect(theme.hex("border.warm")).toBe("#292e42");
    expect(theme.issues).toHaveLength(0);
  });

  test("bg.user paints nothing, so the terminal shows through (§6.7)", () => {
    const theme = new Theme({ depth: "truecolor" });
    expect(CAPYBARA_2026_THEME["bg.user"]).toBe(TRANSPARENT);
    expect(OPENCODE_THEME["bg.user"]).toBe(TRANSPARENT);
    expect(theme.isTransparent("bg.user")).toBe(true);
    expect(theme.bgCode("bg.user")).toBeUndefined();
    // A tinted token still paints.
    expect(theme.isTransparent("bg.task")).toBe(false);
    expect(theme.bgCode("bg.task")).toBe("48;2;41;46;66");
  });

  test("the legacy palette is still selectable by name (§21.4)", () => {
    const legacy = new Theme({ depth: "truecolor", palette: CAPYBARA_DARK });
    expect(legacy.hex("accent.coral")).toBe("#ff5b38");
    expect(legacy.isTransparent("bg.user")).toBe(false);
    expect(palette("capybara-dark")).toBe(CAPYBARA_DARK);
    expect(palette("capybara-2026")).toBe(CAPYBARA_2026_THEME);
    expect(palette("opencode")).toBe(OPENCODE_THEME);
    expect(palette("nope")).toBeUndefined();
  });

  test("each depth emits the right SGR family", () => {
    expect(new Theme({ depth: "truecolor" }).fgCode("accent.coral")).toBe("38;2;122;162;247");
    expect(new Theme({ depth: "256" }).fgCode("accent.coral")).toMatch(/^38;5;\d+$/);
    expect(new Theme({ depth: "16" }).fgCode("accent.coral")).toMatch(/^\d+$/);
    // AC-45: no colour at all.
    expect(new Theme({ depth: "none" }).fgCode("accent.coral")).toBeUndefined();
  });

  test("the 16-colour fallback keeps semantic hues distinguishable (§6.5)", () => {
    const red = toAnsi16({ r: 255, g: 60, b: 99 });
    const green = toAnsi16({ r: 68, g: 223, b: 160 });
    const amber = toAnsi16({ r: 240, g: 180, b: 60 });
    expect(new Set([red, green, amber]).size).toBe(3);
  });

  test("the 256-colour mapping uses the greyscale ramp for neutrals", () => {
    const grey = toXterm256({ r: 128, g: 128, b: 128 });
    expect(grey).toBeGreaterThanOrEqual(232);
    expect(grey).toBeLessThanOrEqual(255);
    const coral = toXterm256({ r: 255, g: 91, b: 56 });
    expect(coral).toBeGreaterThanOrEqual(16);
    expect(coral).toBeLessThan(232);
  });

  test("low-chroma slate surfaces stay neutral instead of becoming blue", () => {
    // #22252c is the default panel surface and should stay on the neutral ramp.
    // A blue cube cell would be much louder than the intended charcoal panel.
    expect(toXterm256({ r: 34, g: 37, b: 44 })).toBe(235);
  });

  test("a low-contrast user theme raises a warning, not a rejection (§6.5)", () => {
    const theme = new Theme({ depth: "truecolor", overrides: { "fg.primary": "#2A2D34" } });
    expect(theme.issues.some((i) => i.token === "fg.primary")).toBe(true);
    // Still usable — it is the user's terminal.
    expect(theme.hex("fg.primary")).toBe("#2a2d34");
  });

  test("an invalid override keeps the default and says so", () => {
    const theme = new Theme({ depth: "truecolor", overrides: { "accent.coral": "not-a-color" } });
    expect(theme.hex("accent.coral")).toBe("#7aa2f7");
    expect(theme.issues.some((i) => i.message.includes("not a #rrggbb"))).toBe(true);
  });

  test("'transparent' is refused for a foreground token", () => {
    const theme = new Theme({ depth: "truecolor", overrides: { "fg.primary": TRANSPARENT } });
    expect(theme.isTransparent("fg.primary")).toBe(false);
    expect(theme.hex("fg.primary")).toBe("#c0caf5");
    expect(theme.issues.some((i) => i.token === "fg.primary")).toBe(true);
  });

  test("contrast is computed as a WCAG ratio", () => {
    const white = parseHex("#ffffff")!;
    const black = parseHex("#000000")!;
    expect(contrastRatio(white, black)).toBeCloseTo(21, 0);
  });

  test("NO_COLOR wins over FORCE_COLOR", () => {
    expect(detectCapabilities({ NO_COLOR: "1", FORCE_COLOR: "3" }).colorDepth).toBe("none");
    expect(detectCapabilities({ COLORTERM: "truecolor" }).colorDepth).toBe("truecolor");
    expect(detectCapabilities({ TERM: "xterm-256color" }).colorDepth).toBe("256");
    expect(detectCapabilities({ TERM: "xterm" }).colorDepth).toBe("16");
    expect(detectCapabilities({ TERM: "dumb" }).colorDepth).toBe("none");
    expect(detectCapabilities({ TERM: "xterm" }, { isTty: false }).colorDepth).toBe("none");
  });

  test("recognizes Windows Terminal without POSIX locale variables", () => {
    const capabilities = detectCapabilities({ WT_SESSION: "session-id" });
    expect(capabilities.colorDepth).toBe("truecolor");
    expect(capabilities.unicode).toBe(true);
  });

  test("recognizes native Windows TTYs without terminal-specific environment variables", () => {
    const capabilities = detectCapabilities({}, { platform: "win32", isTty: true });
    expect(capabilities.colorDepth).toBe("truecolor");
    expect(capabilities.unicode).toBe(true);
    expect(detectCapabilities({ NO_COLOR: "1" }, { platform: "win32", isTty: true }).colorDepth).toBe("none");
    expect(detectCapabilities({}, { platform: "win32", isTty: false }).colorDepth).toBe("none");
    expect(detectCapabilities({}, { platform: "win32", isTty: false }).unicode).toBe(false);
  });

  test("italic is avoided under tmux and screen (§6.6)", () => {
    expect(detectCapabilities({ TERM: "screen-256color" }).italic).toBe(false);
    expect(detectCapabilities({ TERM: "xterm-256color" }).italic).toBe(true);
  });

  test("CI implies reduced motion (§6.12)", () => {
    expect(detectCapabilities({ TERM: "xterm", CI: "true" }).reducedMotion).toBe(true);
  });

  test("icons fall back to ASCII without Unicode (§6.6)", () => {
    expect(icon("success", { unicode: true })).toBe("✓");
    expect(icon("success", { unicode: false })).toBe("+");
    expect(icon("git", { unicode: false })).toBe("@");
  });
});

// ---------------------------------------------------------------------------
// §6.6 width — AC-05
// ---------------------------------------------------------------------------

describe("grapheme width (§6.6, AC-05)", () => {
  test("Hangul and CJK occupy two columns", () => {
    expect(stringWidth("한글")).toBe(4);
    expect(stringWidth("日本語")).toBe(6);
    expect(stringWidth("abc")).toBe(3);
    // §25.8's CJK content case, mixed with Latin.
    expect(stringWidth("서브 에이전트")).toBe(13);
  });

  test("combining marks add no width", () => {
    expect(stringWidth("e\u0301")).toBe(1);
    expect(graphemes("e\u0301")).toHaveLength(1);
  });

  test("an emoji ZWJ sequence is one cluster of width two", () => {
    const family = "👨\u200D👩\u200D👧";
    expect(graphemes(family)).toHaveLength(1);
    expect(graphemeWidth(family)).toBe(2);
  });

  test("truncation never splits a wide character", () => {
    // Cutting at 3 columns cannot include half of the second syllable.
    const truncated = truncateToWidth("한글입니다", 5);
    expect(stringWidth(truncated)).toBeLessThanOrEqual(5);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("short text is returned unchanged", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
    expect(truncateToWidth("abc", 0)).toBe("");
  });

  test("padding is measured in columns, not code units", () => {
    expect(stringWidth(padToWidth("한", 6))).toBe(6);
    expect(stringWidth(padToWidth("ab", 6))).toBe(6);
  });

  test("the cursor column accounts for wide characters (AC-05)", () => {
    expect(columnForOffset("한글ab", 0)).toBe(0);
    expect(columnForOffset("한글ab", 1)).toBe(2);
    expect(columnForOffset("한글ab", 2)).toBe(4);
    expect(columnForOffset("한글ab", 3)).toBe(5);
  });

  test("column-to-offset is the inverse", () => {
    expect(offsetForColumn("한글ab", 0)).toBe(0);
    expect(offsetForColumn("한글ab", 2)).toBe(1);
    expect(offsetForColumn("한글ab", 5)).toBe(3);
    expect(offsetForColumn("한글ab", 99)).toBe(4);
  });

  test("backspace deletes one cluster, not one code unit (AC-05)", () => {
    // A composed Hangul syllable must vanish whole.
    const composed = deleteGraphemeBefore("한글", 2);
    expect(composed.text).toBe("한");
    expect(composed.offset).toBe(1);

    // So must an emoji ZWJ sequence.
    const emoji = deleteGraphemeBefore("a👨\u200D👩\u200D👧", 2);
    expect(emoji.text).toBe("a");

    expect(deleteGraphemeBefore("", 0).text).toBe("");
  });

  test("wrapping respects width and breaks an oversized word", () => {
    const wrapped = wrapToWidth("aaa bbb ccc ddd", 7);
    expect(wrapped.every((l) => stringWidth(l) <= 7)).toBe(true);

    const long = wrapToWidth("averyveryverylongtoken", 8);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((l) => stringWidth(l) <= 8)).toBe(true);
  });

  test("wrapping preserves paragraph breaks", () => {
    expect(wrapToWidth("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

// ---------------------------------------------------------------------------
// §6.20 sanitization — AC-33, RT-004
// ---------------------------------------------------------------------------

describe("terminal sanitization (§6.20, §T6, RT-004, AC-33)", () => {
  test("a title-setting OSC is removed (§6.20)", () => {
    expect(sanitizeText("\u001B]0;pwned\u0007hello")).toBe("hello");
    expect(sanitizeText("\u001B]2;pwned\u001B\\hello")).toBe("hello");
  });

  test("an OSC 52 clipboard write is removed (AC-33)", () => {
    const clean = sanitizeText("a\u001B]52;c;c3RvbGVu\u0007b");
    expect(clean).toBe("ab");
    expect(hasForbiddenSequence(clean)).toBe(false);
  });

  test("an unterminated OSC cannot swallow the buffer", () => {
    expect(sanitizeText("\u001B]0;no terminator\nsafe")).toBe("\nsafe");
  });

  test("DCS, APC, and PM payloads are removed", () => {
    expect(sanitizeText("\u001BP1;2q payload \u001B\\x")).toBe("x");
    expect(sanitizeText("\u001B_apc\u001B\\y")).toBe("y");
    expect(sanitizeText("\u001B^pm\u001B\\z")).toBe("z");
  });

  test("CSI is dropped by default and colour survives only when allowed", () => {
    expect(sanitizeText("\u001B[31mred\u001B[0m")).toBe("red");
    expect(sanitizeText("\u001B[31mred\u001B[0m", { allowSgr: true })).toContain("\u001B[31m");
    // Cursor movement is never passed through, even with SGR allowed.
    expect(sanitizeText("\u001B[2J\u001B[Hwipe", { allowSgr: true })).toBe("wipe");
  });

  test("a bare CR cannot overwrite drawn text", () => {
    expect(sanitizeText("visible\rHIDDEN")).toBe("visible\nHIDDEN");
  });

  test("tab and newline survive; other C0 controls do not", () => {
    expect(sanitizeText("a\tb\nc")).toBe("a\tb\nc");
    expect(sanitizeText("a\u0000b\u0007c")).toBe("abc");
  });

  test("C1 introducers are removed", () => {
    expect(sanitizeText("a\u009Bb")).toBe("ab");
    expect(hasForbiddenSequence(sanitizeText("a\u009Bb"))).toBe(false);
  });

  test("an overlong line is capped", () => {
    const capped = sanitizeText("x".repeat(20_000), { maxLineLength: 100 });
    expect(capped).toContain("line truncated");
    expect(capped.length).toBeLessThan(300);
  });

  test("excess lines are dropped with a count", () => {
    const capped = sanitizeText("l\n".repeat(50), { maxLines: 5 });
    expect(capped).toContain("more line(s) omitted");
  });

  test("OSC 8 hyperlinks pass only for an allowlisted prefix (§6.20)", () => {
    const link = "\u001B]8;;https://good.example/x\u0007text\u001B]8;;\u0007";
    expect(sanitizeText(link)).toBe("text");
    expect(sanitizeText(link, { hyperlinkAllowlist: ["https://good.example/"] })).toContain(
      "https://good.example/x",
    );
    expect(sanitizeText(link, { hyperlinkAllowlist: ["https://other.example/"] })).toBe("text");
  });

  test("inline sanitization flattens newlines so a field cannot break layout", () => {
    expect(sanitizeInline("a\nb\n\nc")).toBe("a b c");
    expect(sanitizeInline("x".repeat(50), 10)).toHaveLength(10);
  });

  test("a hostile payload reaching a block renderer is neutralized", () => {
    const rendered = renderUserMessage({ text: "hi\u001B]52;c;bad\u0007" }, context());
    const text = rendered.map(lineText).join("\n");
    expect(hasForbiddenSequence(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.4 / §6.7–§6.12 blocks — AC-06, AC-45
// ---------------------------------------------------------------------------

describe("timeline blocks (§6.4, §6.7–§6.12, AC-06)", () => {
  test("a user message is a header plus a vertical accent rule, not a slab (§6.7)", () => {
    const lines = renderUserMessage({ text: "fix the parser" }, context());
    expect(lines[0]?.kind).toBe("header");
    expect(lineText(lines[0]!)).toContain("user");
    // The full-width tint is gone; attribution is the rule on each body line.
    expect(lines.every((l) => l.rowBackground === undefined)).toBe(true);
    expect(lineText(lines[1]!)).toContain("fix the parser");
    // AC-45: the rule is a character, so it survives with no colour at all.
    expect(toSemanticCells(lines)[1]?.tokens).toContain("accent.coral");
  });

  test("a user message can carry an author and a clock badge (§6.7)", () => {
    const lines = renderUserMessage(
      { text: "add signup validation", timestamp: "2026-07-04T09:07:00.000Z" },
      context(),
      { author: "davidhill", showTimestamp: true },
    );
    const header = lineText(lines[0]!);
    expect(header).toContain("user");
    expect(header).toContain("davidhill");
    expect(header).toMatch(/\d{2}:\d{2}/);
  });

  test("the accent rule uses ASCII where Unicode is unavailable (§6.6)", () => {
    const lines = renderUserMessage({ text: "hi" }, context(80, { unicode: false }));
    expect(lineText(lines[1]!)).toContain("hi");
  });

  test("a multiline paste is preserved (§6.7)", () => {
    const lines = renderUserMessage({ text: "line one\nline two" }, context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  test("commentary is muted italic and distinct from the final answer (§6.8)", () => {
    const commentary = renderCommentaryCells("Evaluating options", "commentary");
    expect(commentary.some((c) => c.kind === "commentary" && c.emphasis.includes("italic"))).toBe(
      true,
    );
    const thinking = renderCommentaryCells("Considering the failure", "reasoning_summary");
    // Thinking keeps its own phase header while sharing the muted body treatment.
    expect(thinking.some((c) => c.text.includes("Thinking"))).toBe(true);
  });

  test("a live Thinking phase shows its elapsed time without global model decoration (§6.8)", () => {
    const lines = renderCommentary(
      { text: "Exploring the registration flow.", variant: "reasoning" },
      context(120),
      { model: "gpt-5.6", elapsedMs: 3_200 },
    );
    const header = lineText(lines[0]!);
    expect(header).toContain("Thinking");
    expect(header).not.toContain("Reasoning");
    expect(header).not.toContain("gpt-5.6");
    expect(header).toContain("3.2s");
    expect(lineText(lines[1]!)).toContain("Exploring the registration flow.");
  });

  test("a transport-only failure does not masquerade as a five-minute Thought during reconnect", () => {
    const items: TimelineItem[] = [
      {
        type: "thinking",
        id: "thinking-retry",
        sequence: 1,
        turnId: "turn-1",
        agentId: "root",
        requestId: "request-1",
        segmentIndex: 0,
        providerItemIds: [],
        state: "failed",
        sources: ["status_only"],
        startedAtMs: 0,
        endedAtMs: 322_000,
        durationMs: 322_000,
      },
      {
        type: "notice",
        id: "retry-notice",
        sequence: 2,
        level: "info",
        text: "Reconnecting after network (attempt 1)",
        icon: "↻",
      },
    ];

    const rendered = renderTimeline(items, context(120), { nowMs: 400_000 })
      .map(lineText)
      .join("\n");
    expect(rendered).toContain("Reconnecting after network (attempt 1)");
    expect(rendered).not.toContain("Thought");
    expect(rendered).not.toContain("5m 22s");
  });

  test("a failed Thinking part with provider-visible reasoning remains visible", () => {
    const item: TimelineItem = {
      type: "thinking",
      id: "thinking-visible-failure",
      sequence: 1,
      turnId: "turn-1",
      agentId: "root",
      requestId: "request-1",
      segmentIndex: 0,
      providerItemIds: ["reasoning-1"],
      state: "failed",
      sources: ["provider_summary"],
      summaryText: "Checked the reconnect boundary.",
      startedAtMs: 0,
      endedAtMs: 2_500,
      durationMs: 2_500,
    };

    const rendered = renderTimeline([item], context(120)).map(lineText).join("\n");
    expect(rendered).toContain("Thought · failed");
    expect(rendered).toContain("Checked the reconnect boundary.");
    expect(rendered).toContain("2.5s");
  });

  test("provider-visible Thinking follows full, preview, and hidden policy", () => {
    const item: TimelineItem = { type: "commentary", id: "raw-thinking", sequence: 1, variant: "reasoning", text: "first line\nsecond line\nthird line" };
    const full = renderTimeline([item], context(120), { thinkingVisibility: "full" }).map(lineText).join("\n");
    expect(full).toContain("Thinking");
    expect(full).toContain("third line");
    const preview = renderTimeline([item], context(120), { thinkingVisibility: "summary" }).map(lineText).join("\n");
    expect(preview).toContain("Thinking");
    expect(preview).toContain("first line");
    expect(preview).not.toContain("third line");
    const hidden = renderTimeline([item], context(120), { thinkingVisibility: "hidden" }).map(lineText).join("\n");
    expect(hidden).toBe("");
  });

  test("commentary carries a Working phase header", () => {
    const lines = renderCommentary(
      { text: "Inspecting the workspace before choosing files.", variant: "commentary" },
      context(120),
    );

    expect(lineText(lines[0]!)).toContain("Working...");
    expect(lineText(lines[1]!)).toContain("Inspecting the workspace before choosing files.");
  });

  test("candidate final text omits a provisional phase header", () => {
    const lines = renderCommentary(
      { text: "The response is still streaming.", variant: "candidate_final" },
      context(120),
    );

    expect(lines.map(lineText).join("\n")).not.toContain("Writing final answer");
    expect(lineText(lines[0]!)).toContain("The response is still streaming.");
  });

  test("model Markdown renders structure instead of raw syntax", () => {
    const tick = String.fromCharCode(96);
    const lines = renderMarkdown(
      "# Summary\n\n- **done** with " + tick + "bun test" + tick + "\n1. next\n> note",
      context(),
      { kind: "final" },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Summary");
    expect(text).toContain("done");
    expect(text).toContain("bun test");
    expect(text).toContain("next");
    expect(text).toContain("│ note");
    expect(text).not.toContain("**");
    expect(text).not.toContain(tick + "bun test" + tick);
    expect(lines.some((line) => line.segments.some((segment) => segment.bold === true))).toBe(true);
    expect(lines.some((line) => line.segments.some((segment) => segment.bg === "bg.panel"))).toBe(true);
  });

  test("fenced code is shown as a bounded code panel and stays literal", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const lines = renderMarkdown(fence + "ts\nconst value = **not markdown**;\n" + fence, context(80), { kind: "final" });
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("ts");
    expect(text).toContain("const value = **not markdown**;");
    expect(text).not.toContain(fence);
    expect(lines.every((line) => lineWidth(line) <= 80)).toBe(true);
  });

  test("Markdown output remains safe after sanitization", () => {
    const lines = renderMarkdown("**safe**\u001B]52;c;bad\u0007", context(), { kind: "final" });
    expect(hasForbiddenSequence(lines.map(lineText).join("\n"))).toBe(false);
    expect(lines.map(lineText).join("\n")).toContain("safe");
  });
  test("a finished reasoning phase folds to its header (§6.8)", () => {
    const lines = renderCommentary(
      { text: "A long chain of reasoning that has already concluded.", variant: "reasoning_summary" },
      context(120),
      { done: true, collapsed: true, summary: "Finished reasoning" },
    );
    expect(lines).toHaveLength(2);
    expect(lineText(lines[0]!)).toContain("Thought");
    expect(lineText(lines[1]!)).toContain("Ctrl+O to expand");
    expect(lineText(lines[1]!)).not.toMatch(/[가-힣]/);
    expect(lineText(lines[1]!)).not.toContain("already concluded");
  });

  test("only the newest reasoning phase carries a timer (§6.8)", () => {
    const rendered = renderTimeline(
      [
        { type: "commentary", id: "c1", sequence: 1, variant: "reasoning_summary", text: "First." },
        { type: "commentary", id: "c2", sequence: 2, variant: "reasoning_summary", text: "Second." },
      ],
      context(120),
      { reasoningElapsedMs: 4_500 },
    );
    const timers = rendered.filter((l) => lineText(l).includes("4.5s"));
    expect(timers).toHaveLength(1);
  });

  test("a reasoning summary shows the full text without capping", () => {
    expect(capToSentences("One. Two. Three. Four.", 2)).toBe("One. Two. Three. Four.");
    expect(capToSentences("Only one", 2)).toBe("Only one");
    expect(capToSentences("One. Two. Three. Four. Five. Six. Seven. Eight. Nine.")).toBe(
      "One. Two. Three. Four. Five. Six. Seven. Eight. Nine.",
    );
  });

  test("the discovery block shows counts, limit, and a ranked tree (§6.9)", () => {
    const lines = renderToolDiscovery(
      {
        query: "sub-agent delegation executor agent task runner",
        matches: [
          { toolId: "task.spawn", title: "Task", description: "Spawn a subagent", score: 4.949 },
          { toolId: "task.status", title: "Subagent", description: "Manage subagents", score: 4.19 },
          { toolId: "process.start", title: "Monitor", description: "Background monitor", score: 3.868 },
        ],
        activated: ["task.spawn"],
        activeCount: 3,
        totalCount: 17,
        limit: 10,
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(lines).toHaveLength(1);
    expect(text).toContain("Tools");
    expect(text).toContain("3 matched");
    expect(text).toContain("task.spawn activated");
    expect(text).not.toContain("score 4.949");
    expect(text).not.toContain("confidence");
  });

  test("discovery shows the top three and offers to expand (§6.9)", () => {
    const matches = Array.from({ length: 6 }, (_, i) => ({
      toolId: `t${i}`,
      title: `Tool${i}`,
      description: "d",
      score: 1,
    }));
    const collapsed = renderToolDiscovery(
      { query: "q", matches, activated: [], activeCount: 1, totalCount: 6, limit: 10 },
      context(),
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed.map(lineText).join("\n")).toContain("6 matched");

    const expanded = renderToolDiscovery(
      { query: "q", matches, activated: [], activeCount: 1, totalCount: 6, limit: 10 },
      context(),
      { expanded: true },
    );
    expect(expanded.map(lineText).join("\n")).not.toContain("3 more");
  });

  test("full tool detail still limits discovery to the top three", () => {
    const matches = Array.from({ length: 6 }, (_, i) => ({
      toolId: `t${i}`,
      title: `Tool${i}`,
      description: "d",
      score: 1,
    }));

    const lines = renderToolDiscovery(
      { query: "q", matches, activated: [], activeCount: 1, totalCount: 6, limit: 10 },
      context(),
      { detail: "full" },
    );
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Tool0");
    expect(text).toContain("Tool1");
    expect(text).toContain("Tool2");
    expect(text).not.toContain("Tool3");
    expect(text).toContain("3 more");
  });

  test("a tool result names its state in words, not colour alone (AC-45)", () => {
    const ok = renderToolCall(
      { toolId: "fs.read", argumentsSummary: "{}", status: "succeeded", summary: "42 lines", durationMs: 18 },
      context(),
    );
    expect(ok.map(lineText).join("\n")).toContain("ok");

    const failed = renderToolCall(
      { toolId: "fs.read", argumentsSummary: "{}", status: "failed", errorCode: "NOT_FOUND" },
      context(),
    );
    const failedText = failed.map(lineText).join("\n");
    expect(failedText).toContain("failed");
    expect(failedText).toContain("NOT_FOUND");
  });

  test("a running tool shows progress on an indented line (§6.4)", () => {
    const lines = renderToolCall(
      { toolId: "process.run", argumentsSummary: "", status: "running", progress: "42 of 128" },
      context(),
    );
    expect(lines.map(lineText).join("\n")).toContain("42 of 128");
  });

  test("a tool call leads with its action label, not its tool id (§6.4, AC-45)", () => {
    const write = renderToolCall(
      {
        toolId: "fs.apply_patch",
        argumentsSummary: "scripts/demo.py",
        status: "succeeded",
        additions: 18,
        deletions: 0,
      },
      context(),
    );
    const text = write.map(lineText).join("\n");
    expect(text).toContain("[Patch]");
    expect(text).toContain("scripts/demo.py");
    expect(text).toContain("+18");
    expect(text).toContain("-0");
  });

  test("each native tool gets the verb it actually performs (§12.2)", () => {
    expect(toolActionLabel("fs.read")).toBe("Read");
    expect(toolActionLabel("fs.read_many")).toBe("Read");
    expect(toolActionLabel("fs.list")).toBe("List");
    expect(toolActionLabel("fs.search")).toBe("Search");
    expect(toolActionLabel("fs.apply_patch")).toBe("Patch");
    expect(toolActionLabel("fs.write")).toBe("Write");
    expect(toolActionLabel("process.run")).toBe("Run");
    expect(toolActionLabel("shell.run")).toBe("Shell");
    expect(toolActionLabel("mcp.call")).toBe("MCP");
    expect(toolActionLabel("lsp.diagnostics")).toBe("Read");
    expect(toolActionLabel("lsp.symbols")).toBe("Find");
    expect(toolActionLabel("lsp.workspace_symbols")).toBe("Search");
    expect(toolActionLabel("lsp.references")).toBe("Find");
    expect(toolActionLabel("lsp.call_hierarchy")).toBe("Find");
    expect(toolActionLabel("lsp.code_actions")).toBe("Read");
    expect(toolActionLabel("lsp.code_action_preview")).toBe("Preview");
    expect(toolActionLabel("lsp.format_preview")).toBe("Preview");
    expect(toolActionLabel("lsp.range_format_preview")).toBe("Preview");
    expect(toolActionLabel("lsp.rename_preview")).toBe("Preview");
    expect(toolActionLabel("memory.search")).toBe("Search");
    expect(toolActionLabel("memory.remember")).toBe("Remember");

    // The two the prefix heuristic used to get wrong. A search is not a write, and
    // a deletion is not an edit.
    expect(toolActionLabel("fs.glob")).toBe("Find");
    expect(toolActionLabel("fs.delete")).toBe("Delete");
    expect(toolActionLabel("fs.move")).toBe("Move");
  });

  test("an unknown fs tool is not assumed to write (§16.4)", () => {
    // An MCP server registers its tools at runtime, so the fallback has to be
    // conservative rather than confident.
    expect(toolActionLabel("fs.something_new")).toBe("File");
    expect(toolActionLabel("mcp.github.create_issue")).toBe("MCP");
    expect(toolActionLabel("wat")).toBe("Tool");
  });

  test("a destructive file operation is visually distinct from an edit (§6.4)", () => {
    const del = lineText(
      renderToolCall(
        { toolId: "fs.delete", argumentsSummary: "old.ts", status: "succeeded" },
        context(),
      )[0]!,
    );
    const write = lineText(
      renderToolCall(
        { toolId: "fs.write", argumentsSummary: "new.ts", status: "succeeded" },
        context(),
      )[0]!,
    );
    expect(del).toContain("[Delete]");
    expect(write).toContain("[Write]");
    // Different glyphs as well as different words, so neither cue stands alone.
    expect(del[0]).not.toBe(write[0]);
  });

  test("every emoji icon is exactly two columns wide (§6.6)", () => {
    // §6.6's whole reason for gating emoji: a glyph measured at one column but
    // drawn at two shifts every cell after it on the row.
    const names = [
      "success", "active", "working", "task", "tool", "warning", "error", "git",
      "artifact", "thinking", "subagent", "model", "clock", "read", "write",
      "move", "delete", "run", "search", "ask", "added", "removed", "arrow",
    ] as const;

    for (const name of names) {
      const geometric = icon(name, { unicode: true });
      const emoji = icon(name, { unicode: true, stableEmojiWidth: true });
      const ascii = icon(name, { unicode: false });

      expect(stringWidth(geometric), `${name} geometric`).toBe(1);
      expect(stringWidth(ascii), `${name} ascii`).toBeLessThanOrEqual(2);
      // An emoji variant is opt-in; when one exists it must measure two.
      if (emoji !== geometric) {
        expect(stringWidth(emoji), `${name} emoji`).toBe(2);
      }
    }
  });

  test("a process call reports its exit code inline (§6.4)", () => {
    const lines = renderToolCall(
      {
        toolId: "process.run",
        argumentsSummary: "python3 scripts/demo.py",
        status: "succeeded",
        exitCode: 0,
        durationMs: 200,
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("[Run]");
    expect(text).toContain("exit 0");
    expect(text).toContain("200ms");
  });

  test("a write carries a two-to-four line mini-diff (§6.4)", () => {
    const lines = renderMiniDiff(
      [
        { kind: "added", lineNumber: 18, text: 'print("Hello from Subagent!")' },
        { kind: "removed", text: "pass" },
      ],
      context(),
    );
    const text = lines.map(lineText).join("\n");
    // §6.5: the marker distinguishes the lines with no colour at all.
    expect(text).toContain("18 | + print(\"Hello from Subagent!\")");
    expect(text).toContain("+ ");
    expect(text).toContain("- pass");
  });

  test("a mini-diff is capped and says how much it withheld (§6.4)", () => {
    const preview = Array.from({ length: 9 }, (_, i) => ({
      kind: "added" as const,
      lineNumber: i + 1,
      text: `line ${i}`,
    }));
    const lines = renderMiniDiff(preview, context());
    expect(lines).toHaveLength(MAX_MINI_DIFF_LINES + 1);
    expect(lineText(lines.at(-1)!)).toContain("5 more changed line(s)");
  });

  test("a mini-diff line is truncated rather than wrapped", () => {
    const lines = renderMiniDiff(
      [{ kind: "added", lineNumber: 1, text: "x".repeat(400) }],
      context(60),
    );
    expect(lines).toHaveLength(1);
    expect(toSemanticCells(lines)[0]!.width).toBeLessThanOrEqual(60);
  });

  test("a task card shows goal, constraints, contract, lease, and count (§6.10)", () => {
    const lines = renderTaskCard(
      {
        role: "executor",
        title: "PythonDemo",
        goal: "Create a small standalone Python script",
        constraints: ["MUST create only scripts/demo.py."],
        contract: ["Return the created file."],
        writeLease: ["scripts/demo.py"],
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("executor");
    expect(text).toContain("Goal:");
    expect(text).toContain("Write lease: scripts/demo.py");
    expect(text).toContain("1 subagent");
    // §6.5: the subtle indigo task tint from the 2026.7 palette.
    expect(lines.some((l) => l.rowBackground === "bg.task")).toBe(true);
  });

  test("a task card renders full context when showFullContext is requested", () => {
    const lines = renderTaskCard(
      {
        role: "executor",
        title: "PythonDemo",
        goal: "Build a Python demo",
        constraints: ["Do not break tests"],
        contract: ["Return status"],
        writeLease: ["scripts/demo.py"],
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
      },
      context(),
      { showFullContext: true },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("# Goal");
    expect(text).toContain("# Constraints");
    expect(text).toContain("# Contract");
  });

  test("a task card renders its subagent tool calls as a tree (§6.10)", () => {
    const lines = renderTaskCard(
      {
        role: "executor",
        title: "PythonDemo",
        goal: "Create a small standalone Python script",
        constraints: [],
        contract: [],
        writeLease: ["scripts/demo.py"],
        modelId: "gpt-5.6-terra",
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
        durationMs: 12_400,
        subagentEvents: [
          {
            id: "e1",
            sequence: 1,
            callId: "c1",
            toolId: "fs.read",
            argumentsSummary: "scripts/demo.py",
            status: "succeeded",
          },
          {
            id: "e2",
            sequence: 2,
            callId: "c2",
            toolId: "fs.write",
            argumentsSummary: "scripts/demo.py",
            status: "succeeded",
            additions: 18,
            deletions: 0,
            diffPreview: [
              { kind: "added", lineNumber: 18, text: 'print("Hello from Subagent!")' },
            ],
          },
          {
            id: "e3",
            sequence: 3,
            callId: "c3",
            toolId: "process.run",
            argumentsSummary: "python3 scripts/demo.py",
            status: "succeeded",
            exitCode: 0,
          },
        ],
      },
      context(120),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("├──");
    expect(text).toContain("[Read]");
    expect(text).toContain("[Write]");
    expect(text).toContain("[Run]");
    expect(text).toContain('print("Hello from Subagent!")');
    // The header names the model and the elapsed time.
    expect(text).toContain("gpt-5.6-terra");
    expect(text).toContain("12.4s");
    // The card's own state row closes the tree.
    expect(text).toContain("Running (3 tool uses");
  });

  test("an old tool node is summarized rather than dropped (§6.10)", () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      sequence: i,
      callId: `c${i}`,
      toolId: "fs.read",
      argumentsSummary: `file-${i}.ts`,
      status: "succeeded" as const,
    }));
    const lines = renderTaskCard(
      {
        role: "explore",
        title: "Survey",
        goal: "g",
        constraints: [],
        contract: [],
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
        subagentEvents: events,
      },
      context(120),
      { maxToolNodes: 5 },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("15 earlier tool call(s) omitted");
    expect(text).toContain("file-19.ts");
    expect(text).not.toContain("file-0.ts");
  });

  test("a waiting child names what it depends on (§15.10)", () => {
    const lines = renderTaskCard(
      {
        role: "executor",
        title: "Implement",
        goal: "g",
        constraints: [],
        contract: [],
        dependencies: ["agent_1"],
        state: "waiting",
        childCount: 1,
        awaitInterrupted: false,
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Depends on: agent_1");
    expect(text).toContain("Waiting");
    expect(text).toContain("1 subagent");
  });

  test("a task card collapses to one line (§6.10)", () => {
    const lines = renderTaskCard(
      {
        role: "explore",
        title: "Survey",
        goal: "g",
        constraints: [],
        contract: [],
        state: "completed",
        childCount: 0,
        awaitInterrupted: false,
        summary: "found it",
      },
      context(),
      { collapsed: true },
    );
    expect(lines).toHaveLength(1);
    expect(lineText(lines[0]!)).toContain("found it");
  });

  test("an interrupted await uses the PRD's wording (§6.11)", () => {
    const lines = renderTaskCard(
      {
        role: "executor",
        title: "T",
        goal: "g",
        constraints: [],
        contract: [],
        state: "running",
        childCount: 0,
        awaitInterrupted: true,
      },
      context(),
    );
    expect(lines.map(lineText).join(" ")).toContain("this subagent continues");
    expect(AWAIT_INTERRUPTED_MESSAGE).toContain("Inspect its current state in the context sidebar");
  });

  test("background completion renders the §6.11 notification (AC-25)", () => {
    const lines = renderJob(
      { jobId: "j1", display: "PythonDemo", state: "completed", durationMs: 19_700, summary: "created the script" },
      context(),
      { kind: "task" },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Background job completed");
    expect(text).toContain("[task]");
    expect(text).toContain("19.7s");
  });

  test("a failed job shows its exit code", () => {
    const lines = renderJob(
      { jobId: "j", display: "pnpm test", state: "failed", exitCode: 1 },
      context(),
    );
    expect(lines.map(lineText).join("\n")).toContain("exit 1");
  });

  test("an approval card shows command, cwd, risk, reason, and choices (§7.6, AC-18)", () => {
    const lines = renderApproval(
      {
        action: "process.run",
        display: "npm install sharp",
        cwd: "~/project",
        riskClass: "R3",
        reason: "required by the requested feature",
        network: true,
        sideEffects: ["dependency mutation"],
      },
      context(),
      { offeredScopes: ["turn"] },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("process.run request");
    expect(text).toContain("npm install sharp");
    expect(text).toContain("~/project");
    expect(text).toContain("[R3]");
    expect(text).toContain("Yes");
    expect(text).toContain("Yes, allow for this turn");
    expect(text).toContain("Type here to tell model what to do differently");
    expect(text).toContain("Esc to cancel");
    expect(text).not.toMatch(/[가-힣]/);
  });

  test("a user ask card wraps CJK questions without terminal overflow", () => {
    const lines = renderUserAsk(
      {
        question: "\uD55C\uAE00 \uC9C8\uBB38 ".repeat(14),
        choices: ["\uC0DD\uC131 \uC2B9\uC778", "\uCDE8\uC18C"],
        selected: 1,
      },
      context(40),
    );
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Question");
    expect(text).toContain("\uC0DD\uC131 \uC2B9\uC778");
    expect(text).toContain("> 2. \uCDE8\uC18C");
    expect(hasForbiddenSequence(text)).toBe(false);
    for (const styled of lines) expect(lineWidth(styled)).toBeLessThanOrEqual(40);
  });

  test("a destructive action is never offered a project-wide allow (§13.2)", () => {
    const lines = renderApproval(
      {
        action: "process.run",
        display: "git reset --hard",
        riskClass: "R4",
        reason: "destructive",
        network: false,
        sideEffects: [],
      },
      context(),
      { offeredScopes: [] },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Yes");
    expect(text).not.toContain("always allow");
    expect(text).not.toContain("allow for this turn");
  });

  test("a resolved approval shows the decision instead of choices", () => {
    const lines = renderApproval(
      {
        action: "process.run",
        display: "x",
        riskClass: "R1",
        reason: "r",
        network: false,
        sideEffects: [],
        decision: "deny",
        decisionReason: "not needed",
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("deny — not needed");
    expect(text).not.toContain("Allow once");
  });

  test("a diff summary shows counts per file (§6.4)", () => {
    const lines = renderDiffSummary(
      {
        files: [{ path: "src/a.ts", additions: 10, deletions: 2, purpose: "fix" }],
        additions: 10,
        deletions: 2,
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("1 file changed");
    expect(text).toContain("+10");
    expect(text).toContain("-2");
    expect(text).toContain("src/a.ts");
  });

  test("notices render at each level with a distinguishing glyph (AC-45)", () => {
    for (const level of ["info", "success", "warning", "error"] as const) {
      const lines = renderNotice({ level, text: "message" }, context());
      expect(lines).toHaveLength(1);
      expect(lineText(lines[0]!)).toContain("message");
    }
    const aborted = renderNotice({ level: "error", text: OPERATION_ABORTED_MESSAGE }, context());
    expect(lineText(aborted[0]!)).toContain("Operation aborted");
  });

  test("TODO items carry their status as a word (AC-45)", () => {
    const lines = renderPlan(
      {
        items: [
          { id: "1", text: "read the parser", status: "done" },
          { id: "2", text: "patch it", status: "active" },
          { id: "3", text: "run tests", status: "pending" },
        ],
      },
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("TODO");
    expect(text).not.toContain("Plan");
    expect(text).toContain("[done]");
    expect(text).toContain("[active]");
    expect(text).toContain("[pending]");
  });

  test("plan item details wrap inside the main column instead of stretching to the sidebar", () => {
    const columns = 42;
    const lines = renderPlan(
      {
        items: [
          {
            id: "landing",
            text: "렌딩 페이지 UI를 제작한다",
            status: "active",
            details: "브랜드 히어로, 게임 소개, CTA, 반응형 스타일을 구현합니다.",
            files: ["index.html", "landing.css"],
            acceptanceCriteria: [
              "첫 화면에서 게임 가치 제안과 CTA가 명확함, 모바일/데스크톱 레이아웃이 자연스러움",
            ],
            dependsOn: ["inspect"],
          },
        ],
      },
      context(columns),
    );
    expect(lines.every((styled) => lineWidth(styled) <= columns)).toBe(true);
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("details:");
    expect(text).toContain("acceptance:");
    expect(text.split("\n").length).toBeGreaterThan(4);
  });

  test("the final answer renders the §11.7 report structure (§7.4)", () => {
    const lines = renderTimeline(
      [
        {
          type: "final",
          id: "f",
          sequence: 1,
          text: "Patched the parser.",
          report: {
            status: "completed",
            summary: "Patched the parser.",
            changedFiles: [{ path: "src/parser.ts", additions: 4, deletions: 2, purpose: "fix" }],
            verification: [{ command: "bun test", status: "passed", evidence: "12 passed" }],
            delegatedTasks: [{ id: "a1", role: "reviewer", status: "completed", summary: "no issues" }],
            risks: ["the fix is narrow"],
            nextStep: "run the broader suite",
          },
        },
      ],
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Changed");
    expect(text).toContain("src/parser.ts (+4 -2)");
    expect(text).toContain("Verification");
    expect(text).toContain("passed");
    expect(text).toContain("Delegated");
    expect(text).toContain("Risks");
    expect(text).toContain("Next step: run the broader suite");
  });

  test("a partial report says so in words (AC-50)", () => {
    const lines = renderTimeline(
      [
        {
          type: "final",
          id: "f",
          sequence: 1,
          text: "Stopped early.",
          report: {
            status: "partial",
            summary: "Stopped early.",
            changedFiles: [],
            verification: [],
            delegatedTasks: [],
            risks: [],
          },
        },
      ],
      context(),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Partial result");
    expect(text).toContain("status: partial");
    expect(text).not.toContain("Final answer");
  });

  test("the update banner names the version and upgrade path (§6.19, §10)", () => {
    const text = renderUpdateBanner({ version: "0.12.5" }, context()).map(lineText).join("\n");
    expect(text).toContain("Update Available");
    expect(text).toContain("0.12.5");
    // §10: the banner is the late-check fallback and must not contradict the
    // blocking prompt — it points at the same installer and says a restart asks again.
    const wide = renderUpdateBanner({ version: "0.12.5" }, context(160)).map(lineText).join("\n");
    expect(wide).toContain(updateBannerText("0.12.5"));
    expect(wide).toContain("Run capy update");
    expect(wide).toContain("restart capy to be asked again");
  });

  test("chronological timeline keeps delegated responses beside their action", () => {
    const task: TimelineTask = {
      type: "task",
      id: "task_1",
      sequence: 1,
      taskId: "agent_1",
      role: "executor",
      title: "List files",
      goal: "Inspect the workspace",
      constraints: [],
      contract: [],
      state: "completed",
      childCount: 1,
      awaitInterrupted: false,
      subagentEvents: [
        {
          id: "child_1",
          sequence: 2,
          callId: "call_1",
          toolId: "fs.list",
          argumentsSummary: "src",
          status: "succeeded",
          summary: "3 entries",
        },
      ],
    };
    const rendered = renderTimeline(
      [
        { type: "notice", id: "after", sequence: 3, level: "info", text: "parent response" },
        task,
      ],
      context(120),
      { subagentDetail: "inline" },
    );
    const text = rendered.map(lineText).join("\n");

    expect(text.indexOf("[SUB] Subagent · executor")).toBeLessThan(text.indexOf("parent response"));
    expect(text).not.toContain("[List]");
    expect(text).not.toContain("3 entries");
    expect(text).toContain("1 tool");

    const diagnosticText = renderTimeline([task], context(120), {
      subagentDetail: "inline",
      inlineSubagentEvents: true,
    })
      .map(lineText)
      .join("\n");
    expect(diagnosticText).toContain("[List]");
    expect(diagnosticText).toContain("3 entries");
  });
  test("formatDuration is readable across magnitudes", () => {
    expect(formatDuration(18)).toBe("18ms");
    expect(formatDuration(19_700)).toBe("19.7s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

function renderCommentaryCells(text: string, variant: "commentary" | "reasoning_summary") {
  return toSemanticCells(
    renderTimeline(
      [{ type: "commentary", id: "c", sequence: 1, variant, text }],
      context(),
    ),
  );
}

// ---------------------------------------------------------------------------
// §6.14 completion popup
// ---------------------------------------------------------------------------

describe("completion popup (§6.14, §8.10)", () => {
  const sources = {
    argumentValues: ({ command }: { command: string }) => {
      if (command === "/model") {
        return [
          { value: "gpt-5.6", detail: "default" },
          { value: "gpt-5.6-terra", detail: "fast" },
          { value: "gpt-5.6-luna" },
        ];
      }
      if (command === "/effort") {
        return ["none", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value }));
      }
      return undefined;
    },
    paths: (query: string) =>
      ["src/a.ts", "src/b.ts", "test/c.ts"]
        .filter((p) => p.startsWith(query))
        .map((value) => ({ value })),
    skills: () => [{ value: "release", detail: "cut a release" }],
  };

  test("a bare slash lists every command with its description", () => {
    const state = computeCompletions("/", 1, sources);
    expect(state.open).toBe(true);
    expect(state.kind).toBe("command");
    expect(state.candidates.length).toBe(SLASH_COMMANDS.length);
    expect(state.from).toBe(0);
    expect(state.to).toBe(1);
    expect(state.query).toBe("");
    // The description is what makes the list usable from a blank prompt.
    expect(state.candidates[0]?.detail).toBeDefined();
  });

  test("typing narrows the list, and a name prefix outranks a description match", () => {
    const state = computeCompletions("/mo", 3, sources);
    expect(state.open).toBe(true);
    // `/model` starts with `mo`; `/mode` does too. Both rank above anything that
    // only mentions a model in its description.
    expect(state.candidates[0]?.value).toBe("/model");
    expect(state.candidates.map((c) => c.value)).toContain("/model");
    const first = state.candidates.findIndex((c) => c.value.startsWith("/mo"));
    expect(first).toBe(0);
  });

  test("a command with arguments inserts a trailing space and advances the popup", () => {
    const state = computeCompletions("/mod", 4, sources);
    const chosen = state.candidates.findIndex((c) => c.value === "/model");
    const moved = moveCompletion(state, chosen);
    expect(selectedCandidate(moved)?.value).toBe("/model");

    const accepted = acceptCompletion(moved, "/mod", 4, sources);
    expect(accepted.text).toBe("/model ");
    expect(accepted.cursor).toBe(7);
    // The same keystroke lands on the argument list.
    expect(accepted.state.kind).toBe("argument");
    expect(accepted.state.open).toBe(true);
    expect(accepted.state.candidates.map((c) => c.value)).toContain("gpt-5.6-terra");
  });

  test("a command without arguments is accepted whole, with no trailing space", () => {
    const state = computeCompletions("/stat", 5, sources);
    const accepted = acceptCompletion(state, "/stat", 5, sources);
    expect(accepted.text).toBe("/status");
    expect(accepted.state.open).toBe(false);
  });

  test("an argument list filters on the partial value", () => {
    const state = computeCompletions("/effort me", 10, sources);
    expect(state.kind).toBe("argument");
    expect(state.command).toBe("/effort");
    expect(state.candidates.map((c) => c.value)).toEqual(["medium"]);
    // The replaced span is the partial value, not the whole line.
    expect(state.from).toBe(8);
    expect(state.to).toBe(10);

    const accepted = acceptCompletion(state, "/effort me", 10, sources);
    expect(accepted.text).toBe("/effort medium");
  });

  test("accepting a readable label closes when its hidden insertion is the only match", () => {
    const sessionSources = {
      argumentValues: ({ command }: { command: string }) =>
        command === "/resume"
          ? [{
              value: "2026-08-27 22:56 · Fix parser",
              detail: "active · 2 turns · id bc2a",
              insert: "ses_20260827135613_bc2a",
            }]
          : undefined,
    };
    const state = computeCompletions("/resume ", 8, sessionSources);
    const accepted = acceptCompletion(state, "/resume ", 8, sessionSources);

    expect(accepted.text).toBe("/resume ses_20260827135613_bc2a");
    expect(accepted.state.open).toBe(false);
  });

  test("a trailing space after a command shows every value for its argument", () => {
    const state = computeCompletions("/effort ", 8, sources);
    expect(state.open).toBe(true);
    expect(state.candidates).toHaveLength(6);
    expect(state.query).toBe("");
  });

  test("a known command with no values still shows its signature", () => {
    const noValues = computeCompletions("/skills ", 8, sources);
    expect(noValues.open).toBe(false);
    expect(noValues.signature?.command).toBe("/skills");
    expect(noValues.signature?.args[0]?.active).toBe(true);
  });

  test("an unknown command offers nothing rather than guessing", () => {
    expect(computeCompletions("/nonsense ", 10, sources).open).toBe(false);
    expect(computeCompletions("plain text", 10, sources).open).toBe(false);
  });

  test("@ completes a path and $ completes a skill (§6.14)", () => {
    const path = computeCompletions("look at @src/", 13, sources);
    expect(path.kind).toBe("path");
    expect(path.candidates.map((c) => c.value)).toEqual(["src/a.ts", "src/b.ts"]);

    const skill = computeCompletions("$rel", 4, sources);
    expect(skill.kind).toBe("skill");
    expect(skill.candidates[0]?.value).toBe("release");
  });

  test("accepting a path mid-token replaces its suffix, including quoted paths", () => {
    const pathSources = {
      paths: () => [{ value: "src/main.ts", insert: "@src/main.ts " }],
    };
    const plainText = "inspect @src/main.ts";
    const plainCursor = "inspect @src/ma".length;
    const plain = computeCompletions(plainText, plainCursor, pathSources);
    expect(plain.query).toBe("src/ma");
    expect(plain.to).toBe(plainText.length);
    expect(acceptCompletion(plain, plainText, plainCursor, pathSources).text).toBe(
      "inspect @src/main.ts ",
    );

    const quotedText = '@"docs/user guide.md"';
    const quotedCursor = '@"docs/us'.length;
    const quoted = computeCompletions(quotedText, quotedCursor, {
      paths: () => [{ value: "docs/user guide.md", insert: '@"docs/user guide.md" ' }],
    });
    expect(quoted.query).toBe("docs/us");
    expect(quoted.to).toBe(quotedText.length);
    expect(acceptCompletion(quoted, quotedText, quotedCursor).text).toBe(
      '@"docs/user guide.md" ',
    );
  });

  test("completion candidate values are sanitized before rendering", () => {
    const state = computeCompletions("@bad", 4, {
      paths: () => [{ value: "bad\u001b[2J\npath", insert: "@safe " }],
    });
    const text = renderCompletionPopup(state, context(80)).map(lineText).join("\n");

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("[2J");
    expect(text).toContain("bad path");
  });

  test("a slash mid-sentence is not a command (§8.10)", () => {
    expect(completionKindAt("see a/b", 7)).toBe("none");
    expect(completionKindAt("/model", 6)).toBe("command");
    expect(completionKindAt("/model g", 8)).toBe("argument");
    expect(completionKindAt("@src", 4)).toBe("path");
  });

  test("Tab cycles and wraps at both ends", () => {
    const state = computeCompletions("/effort ", 8, sources);
    const count = state.candidates.length;

    expect(moveCompletion(state, 1).selected).toBe(1);
    // Forward past the end comes back to the start rather than sticking.
    expect(moveCompletion(state, count).selected).toBe(0);
    // Backward from the first goes to the last.
    expect(moveCompletion(state, -1).selected).toBe(count - 1);
  });

  test("moving a closed popup is a no-op", () => {
    expect(moveCompletion(CLOSED_COMPLETION, 1)).toBe(CLOSED_COMPLETION);
    expect(selectedCandidate(CLOSED_COMPLETION)).toBeUndefined();
  });

  test("accepting with nothing selected closes instead of corrupting the text", () => {
    const result = acceptCompletion(CLOSED_COMPLETION, "hello", 5, sources);
    expect(result.text).toBe("hello");
    expect(result.cursor).toBe(5);
    expect(result.state.open).toBe(false);
  });

  test("the signature marks the argument being typed (§6.14)", () => {
    const state = computeCompletions("/effort ", 8, sources);
    expect(state.signature).toBeDefined();
    expect(signatureText(state.signature!)).toBe("/effort [effort]");
    expect(state.signature?.args[0]?.active).toBe(true);
  });

  test("the popup shows a signature, rows, and a position counter (AC-45)", () => {
    const state = computeCompletions("/effort ", 8, sources);
    const lines = renderCompletionPopup(moveCompletion(state, 2), context(100));
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("/effort [effort]");
    expect(text).toContain("medium");
    // The marker identifies the row without colour.
    expect(text).toContain("▸ medium");
    // The counter says where you are; a terminal has no scrollbar to infer it from.
    expect(text).toContain("3/6");
    expect(text).toContain("select");
  });

  test("the popup scrolls rather than growing past its row budget", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `value-${i}` }));
    const state: typeof CLOSED_COMPLETION = {
      kind: "argument",
      open: true,
      candidates: many,
      selected: 25,
      from: 0,
      to: 0,
      query: "",
    };
    const lines = renderCompletionPopup(state, context(100), { maxRows: 5 });
    const text = lines.map(lineText).join("\n");

    // Five candidate rows + separator + hint + border top/bottom = 9.
    expect(lines).toHaveLength(9);
    expect(text).toContain("value-25");
    expect(text).not.toContain("value-0\n");
    expect(text).toContain("26/30");
  });

  test("completionWindow keeps the selection inside the viewport", () => {
    expect(completionWindow(30, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(completionWindow(30, 4, 5)).toEqual({ start: 0, end: 5 });
    expect(completionWindow(30, 5, 5)).toEqual({ start: 1, end: 6 });
    expect(completionWindow(30, 29, 5)).toEqual({ start: 25, end: 30 });
    // A list shorter than the viewport is shown whole.
    expect(completionWindow(3, 1, 8)).toEqual({ start: 0, end: 3 });
  });

  test("every popup row fits the terminal width", () => {
    for (const columns of [40, 60, 80, 120]) {
      const state = computeCompletions("/", 1, sources);
      const lines = renderCompletionPopup(state, context(columns));
      for (const cell of toSemanticCells(lines)) {
        expect(cell.width, `width ${columns}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("with no colour the popup is still navigable (AC-45)", () => {
    const caps = capabilities({ columns: 80, colorDepth: "none", unicode: false });
    const state = moveCompletion(computeCompletions("/effort ", 8, sources), 1);
    const lines = renderCompletionPopup(state, blockContext(caps, 80));
    const ansi = renderAnsi(lines, {
      theme: new Theme({ depth: "none" }),
      capabilities: caps,
      columns: 80,
    });

    expect(ansi).not.toContain("\u001B");
    // The ASCII marker replaces the arrow, so the selection is still identifiable.
    expect(ansi).toContain("> low");
    expect(ansi).toContain("2/6");
    expect(ansi).toContain(COMPLETION_HINT_ASCII);
  });

  test("every command in §8.10's table has a description", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.name.startsWith("/"), command.name).toBe(true);
      expect(command.description.length, command.name).toBeGreaterThan(0);
    }
    // An argument spec, where present, names the argument.
    for (const command of SLASH_COMMANDS) {
      for (const argument of command.args ?? []) {
        expect(argument.name.length, command.name).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §6.21 two-column grid and the right context sidebar
// ---------------------------------------------------------------------------

describe("two-column grid (§6.21)", () => {
  test("the sidebar mode follows the width", () => {
    expect(sidebarModeFor(180)).toBe("full");
    expect(sidebarModeFor(120)).toBe("full");
    expect(sidebarModeFor(119)).toBe("compact");
    expect(sidebarModeFor(90)).toBe("compact");
    expect(sidebarModeFor(89)).toBe("hidden");
    expect(sidebarModeFor(60)).toBe("hidden");
  });

  test("120 columns splits 75:25 around a │ divider", () => {
    const plan = planLayout(120, { sidebarVisible: true });
    expect(plan.showSidebar).toBe(true);
    expect(plan.sidebarMode).toBe("full");
    expect(plan.dividerWidth).toBe(COLUMN_DIVIDER_WIDTH);
    // Every cell is accounted for: neither column silently pays for the rule.
    expect(plan.mainWidth + plan.sidebarWidth + plan.dividerWidth).toBe(120);

    const content = 120 - COLUMN_DIVIDER_WIDTH;
    expect(plan.mainWidth / content).toBeCloseTo(MAIN_FRACTION, 2);
    expect(plan.sidebarWidth / content).toBeCloseTo(SIDEBAR_FRACTION, 2);
    expect(plan.mainWidth).toBe(88);
    expect(plan.sidebarWidth).toBe(29);
  });

  test("the sidebar auto-hides below 90 columns and Ctrl+B brings it back", () => {
    expect(planLayout(80).showSidebar).toBe(false);
    expect(planLayout(80).mainWidth).toBe(80);
    expect(planLayout(80).sidebarWidth).toBe(0);

    const forced = planLayout(80, { sidebarVisible: true });
    expect(forced.showSidebar).toBe(true);
    expect(forced.mainWidth + forced.sidebarWidth + forced.dividerWidth).toBe(80);

    // And it can be forced off at a width that would otherwise show it.
    expect(planLayout(160, { sidebarVisible: false }).showSidebar).toBe(false);
  });

  test("a width that cannot hold both columns degrades to one", () => {
    expect(splitColumns(60)).toBeUndefined();
    expect(planLayout(60, { sidebarVisible: true }).showSidebar).toBe(false);
    // Degrading is not silent: the whole width goes back to the timeline.
    expect(planLayout(60, { sidebarVisible: true }).mainWidth).toBe(60);
  });

  test("joined rows are exactly the terminal width", () => {
    const plan = planLayout(120, { sidebarVisible: true });
    const ctx = context(120);
    const main = renderUserMessage({ text: "add signup validation" }, blockContext(capabilities({ columns: plan.mainWidth }), plan.mainWidth));
    const sidebar = renderRightSidebar(
      {
        title: "Implementing signup",
        contextUsedTokens: 21_700,
        contextBudgetTokens: 96_000,
        subagents: [],
        todo: [],
      },
      blockContext(capabilities({ columns: plan.sidebarWidth }), plan.sidebarWidth),
    );

    const joined = joinColumns(main, sidebar, plan, ctx);
    expect(joined.length).toBe(Math.max(main.length, sidebar.length));
    for (const cell of toSemanticCells(joined)) {
      expect(cell.width).toBe(120);
    }
    // The divider sits at the 72% boundary on every row.
    for (const row of joined) {
      expect(lineText(row).slice(plan.mainWidth, plan.mainWidth + 3)).toBe(" │ ");
    }
  });

  test("a task background never bleeds across the divider (§6.21)", () => {
    const plan = planLayout(120, { sidebarVisible: true });
    const ctx = context(120);
    const card = renderTaskCard(
      {
        role: "executor",
        title: "Demo",
        goal: "g",
        constraints: [],
        contract: [],
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
      },
      blockContext(capabilities({ columns: plan.mainWidth }), plan.mainWidth),
    );
    expect(card.some((l) => l.rowBackground === "bg.task")).toBe(true);

    const joined = joinColumns(card, [], plan, ctx);
    // No joined row carries a row-wide background, so the tint stops at the rule.
    expect(joined.every((l) => l.rowBackground === undefined)).toBe(true);
    for (const row of joined) {
      const tail = row.segments.at(-1);
      expect(tail?.bg).toBe("bg.panel");
    }
  });

  test("composeScreen keeps the status bar and composer full width (§6.2)", () => {
    const screen = composeScreen({
      model: {
        ...emptyViewModel("s"),
        timeline: [{ type: "user", id: "u", sequence: 1, text: "hi", timestamp: "" }],
      },
      composer: { text: "", cursor: 0 },
      capabilities: capabilities({ columns: 120, rows: 40 }),
      sidebarTitle: "Implementing signup",
      sidebarVisible: true,
    });

    expect(screen.plan.showSidebar).toBe(true);
    expect(screen.sidebar.length).toBeGreaterThan(0);
    // The body is joined; the chrome below it is not.
    for (const cell of toSemanticCells(screen.body)) {
      expect(cell.width).toBe(120);
    }
    expect(toSemanticCells(screen.status)[0]!.width).toBeLessThanOrEqual(120);
    // §6.2 order: composer is above status.
    const kinds = screen.lines.map((l) => l.kind);
    expect(kinds.indexOf("composer")).toBeLessThan(kinds.indexOf("status"));
  });

  test("an open overlay suspends the sidebar (§6.17)", () => {
    const screen = composeScreen({
      model: emptyViewModel("s"),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities({ columns: 160, rows: 40 }),
      overlay: renderOverlay("jobs", [], context(160)),
    });
    expect(screen.sidebar).toHaveLength(0);
    expect(screen.overlay.length).toBeGreaterThan(0);
    expect(screen.body).toEqual(screen.overlay);
  });
});

describe("right context sidebar (§6.21, AC-45)", () => {
  const sidebarContext = (columns = 33) => context(columns);

  test("the panel reports context, cost, subagents, todo, MCP, and LSP", () => {
    const lines = renderRightSidebar(
      {
        title: "Implementing signup",
        contextUsedTokens: 21_700,
        contextBudgetTokens: 96_000,
        usage: {
          inputTokens: 21_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 700,
          reasoningTokens: 0,
          estimatedCostUsd: 0.0321,
        },
        subagents: [
          {
            role: "executor",
            state: "running",
            elapsedMs: 12_400,
            toolUses: 3,
            tokens: 1_250,
            activity: "writing demo.py",
          },
        ],
        todo: [
          { id: "1", text: "Create migration", status: "done" },
          { id: "2", text: "Add validation", status: "active" },
          { id: "3", text: "Update form UI", status: "pending" },
        ],
        mcpServers: [{ name: "github", state: "ready" }],
        lspServers: [{ name: "typescript", state: "degraded" }],
      },
      sidebarContext(),
    );
    const text = lines.map(lineText).join("\n");

    expect(text).toContain("Implementing signup");
    expect(text).toContain("Context (input budget)");
    expect(text).toContain("21.7k / 96.0k");
    expect(text).toContain("(23%)");
    expect(text).toContain("$0.0321 est.");
    expect(text).toContain("Active Subagents (1)");
    expect(text).toContain("Subagent · executor (12.4s)");
    expect(text).toContain("Running · 3 tools");
    expect(text).toContain("1.3k tokens");
    expect(text).toContain("writing demo.py");
    // AC-45: the boxes are the state, not the colour.
    expect(text).toContain("[x] Create migration");
    expect(text).toContain("[/] Add validation");
    expect(text).toContain("[ ] Update form UI");
    expect(text).toContain("github ready");
    expect(text).toContain("typescript degraded");
  });

  test("service rows distinguish idle from starting and show actionable details", () => {
    const text = renderRightSidebar(
      {
        contextUsedTokens: 0,
        contextBudgetTokens: 96_000,
        subagents: [],
        todo: [],
        mcpServers: [
          { name: "context7", state: "idle", detail: "connects on first use" },
        ],
        lspServers: [
          { name: "python", state: "disabled", detail: "workspace is not trusted" },
        ],
      },
      sidebarContext(40),
    )
      .map(lineText)
      .join("\n");

    expect(text).toContain("context7 idle");
    expect(text).toContain("connects on first use");
    expect(text).toContain("python disabled");
    expect(text).toContain("workspace is not trusted");
  });

  test("every panel row fits the sidebar width", () => {
    for (const width of [20, 24, 28, 33, 40]) {
      const lines = renderRightSidebar(
        {
          title: "A very long turn title that will not fit in a narrow panel at all",
          contextUsedTokens: 1_234_567,
          contextBudgetTokens: 2_000_000,
          subagents: [
            { role: "refactorer", state: "running", elapsedMs: 305_000, activity: "writing a/very/deep/path/file.ts" },
          ],
          todo: [{ id: "1", text: "An outstanding item with a long description", status: "pending" }],
          mcpServers: [{
            name: "a-server-with-a-long-name",
            state: "starting",
            detail: "negotiating an external service with a long description",
          }],
        },
        sidebarContext(width),
      );
      for (const cell of toSemanticCells(lines)) {
        expect(cell.width, `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  test("compact mode drops the plan and service rows, not the budget", () => {
    const input = {
      contextUsedTokens: 10_000,
      contextBudgetTokens: 96_000,
      subagents: [{ role: "explore", state: "running" as const }],
      todo: [{ id: "1", text: "Read the parser", status: "pending" as const }],
      mcpServers: [{ name: "github", state: "ready" as const }],
    };
    const compact = renderRightSidebar(input, sidebarContext(24), { compact: true }).map(lineText).join("\n");
    expect(compact).toContain("Context");
    expect(compact).toContain("Active Subagents (1)");
    expect(compact).not.toContain("Todo");
    expect(compact).not.toContain("github");

    const full = renderRightSidebar(input, sidebarContext(33)).map(lineText).join("\n");
    expect(full).toContain("Todo");
    expect(full).toContain("github");
  });

  test("an idle session says so rather than rendering an empty section", () => {
    const text = renderRightSidebar(
      { contextUsedTokens: 0, contextBudgetTokens: 96_000, subagents: [], todo: [] },
      sidebarContext(),
    )
      .map(lineText)
      .join("\n");
    expect(text).toContain("Active Subagents (0)");
    expect(text).toContain("none");
  });


  test("the gauge conveys proportion in ASCII too (§6.6)", () => {
    expect(renderGauge(0, 10, context())).toBe("░".repeat(10));
    expect(renderGauge(100, 10, context())).toBe("█".repeat(10));
    expect(renderGauge(50, 10, context())).toBe(`${"█".repeat(5)}${"░".repeat(5)}`);
    expect(renderGauge(50, 10, context(80, { unicode: false }))).toBe("#####.....");
  });

  test("token counts are abbreviated for a 28-column panel", () => {
    expect(formatTokens(742)).toBe("742");
    expect(formatTokens(21_712)).toBe("21.7k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  test("todo boxes cover every plan status (AC-45)", () => {
    expect(todoBox("done")).toBe("[x]");
    expect(todoBox("active")).toBe("[/]");
    expect(todoBox("pending")).toBe("[ ]");
    expect(todoBox("blocked")).toBe("[!]");
    expect(todoBox("skipped")).toBe("[-]");
    expect(new Set(["done", "active", "pending", "blocked", "skipped"].map((s) => todoBox(s as never))).size).toBe(5);
  });

  test("the panel derives a subagent's activity from its newest running call", () => {
    const model: SessionViewModel = {
      ...emptyViewModel("s"),
      plan: [{ id: "1", text: "Add validation", status: "active" }],
      timeline: [
        {
          type: "task",
          id: "t",
          sequence: 1,
          taskId: "a1",
          role: "executor",
          title: "Demo",
          goal: "g",
          constraints: [],
          contract: [],
          state: "running",
          childCount: 1,
          awaitInterrupted: false,
          startTimeMs: 1_000,
          tokens: 1_250,
          pendingInputTokens: 750,
          subagentEvents: [
            {
              id: "e1",
              sequence: 1,
              callId: "c1",
              toolId: "fs.read",
              argumentsSummary: "a.py",
              status: "succeeded",
            },
            {
              id: "e2",
              sequence: 2,
              callId: "c2",
              toolId: "fs.write",
              argumentsSummary: "demo.py",
              status: "running",
            },
          ],
        },
      ],
    };
    // `activeTasks` is derived by the reducer; the sidebar reads it, so mirror it.
    const withActive: SessionViewModel = {
      ...model,
      activeTasks: model.timeline.filter((i): i is Extract<TimelineItem, { type: "task" }> => i.type === "task"),
    };

    const input = sidebarFromViewModel(withActive, { title: "Signup", nowMs: 3_400 });
    expect(input.subagents).toHaveLength(1);
    expect(input.subagents[0]?.activity).toBe("writing demo.py");
    expect(input.subagents[0]?.toolUses).toBe(2);
    expect(input.subagents[0]?.tokens).toBe(2_000);
    expect(input.subagents[0]?.tokensEstimated).toBe(true);
    expect(input.subagents[0]?.elapsedMs).toBe(2_400);
    expect(input.todo).toHaveLength(1);
    expect(input.title).toBe("Signup");
  });

  test("with no colour the whole panel is still readable (AC-45)", () => {
    const caps = capabilities({ columns: 33, colorDepth: "none" });
    const lines = renderRightSidebar(
      {
        title: "Implementing signup",
        contextUsedTokens: 21_700,
        contextBudgetTokens: 96_000,
        subagents: [{ role: "executor", state: "running", elapsedMs: 12_400, activity: "writing demo.py" }],
        todo: [
          { id: "1", text: "Create migration", status: "done" },
          { id: "2", text: "Add validation", status: "active" },
        ],
        mcpServers: [{ name: "github", state: "down" }],
      },
      blockContext(caps, 33),
    );
    const ansi = renderAnsi(lines, { theme: new Theme({ depth: "none" }), capabilities: caps, columns: 33 });
    expect(ansi).not.toContain("\u001B");
    expect(ansi).toContain("[x]");
    expect(ansi).toContain("[/]");
    expect(ansi).toContain("down");
    expect(ansi).toContain("23%");
  });
});

// ---------------------------------------------------------------------------
// §6.13 status bar and §6.16 layout — AC-07
// ---------------------------------------------------------------------------

describe("status bar and layout (§6.13, §6.16, AC-07)", () => {
  test("breakpoints match §6.16", () => {
    expect(breakpointFor(180)).toBe("wide");
    expect(breakpointFor(120)).toBe("wide");
    expect(breakpointFor(119)).toBe("target");
    expect(breakpointFor(80)).toBe("target");
    expect(breakpointFor(79)).toBe("narrow");
    expect(breakpointFor(60)).toBe("narrow");
    expect(breakpointFor(59)).toBe("compact");
  });

  test("each breakpoint drops what §6.16 says it drops", () => {
    expect(planLayout(180).showCost).toBe(true);
    expect(planLayout(180).showWorkspacePath).toBe(true);
    // §6.16: cost and path go first at the target width.
    expect(planLayout(90).showCost).toBe(false);
    expect(planLayout(90).showWorkspacePath).toBe(false);
    expect(planLayout(90).showKeyboardHints).toBe(true);
    // §6.16: hints hide below 80.
    expect(planLayout(70).showKeyboardHints).toBe(false);
    expect(planLayout(70).showReasoning).toBe(false);
    expect(planLayout(50).warning).toBe(COMPACT_TERMINAL_WARNING);
  });

  test("fields are dropped from the lowest priority upward (AC-07)", () => {
    const widths = {
      model: 20,
      mode: 12,
      activeState: 10,
      gitBranch: 14,
      contextPercent: 6,
      reasoning: 6,
      usage: 12,
      workspacePath: 20,
    };
    const wide = fitStatusFields(widths, 200, 3);
    expect(wide).toContain("workspacePath");

    const narrow = fitStatusFields(widths, 40, 3);
    // Model and mode survive; the informative tail does not.
    expect(narrow).toContain("model");
    expect(narrow).not.toContain("workspacePath");
    expect(narrow).not.toContain("usage");
  });

  test("a status bar with nothing fitting still shows the model", () => {
    const lines = renderStatusBar(
      {
        provider: "OpenAI",
        model: "gpt-5.6",
        permissionMode: "auto-review",
        reasoning: "high",
        contextUsedTokens: 100,
        contextBudgetTokens: 96_000,
      },
      context(10),
      planLayout(10),
    );
    expect(lineText(lines[0]!).length).toBeGreaterThan(0);
  });

  test("the full-width bar shows the §6.13 fields", () => {
    const lines = renderStatusBar(
      {
        provider: "OpenAI",
        model: "gpt-5.6",
        permissionMode: "Auto Review",
        reasoning: "high",
        contextUsedTokens: 3_744,
        contextBudgetTokens: 96_000,
        git: { branch: "main", added: 96, deleted: 5 },
        usage: {
          inputTokens: 2_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 165,
          reasoningTokens: 0,
          estimatedCostUsd: 0.18,
        },
        workspacePath: "/home/me/repo",
      },
      context(180),
      planLayout(180),
    );
    const text = lineText(lines[0]!);
    expect(text).toContain("gpt-5.6");
    expect(text).toContain("Auto Review");
    expect(text).toContain("main");
    expect(text).toContain("+96");
    expect(text).toContain("-5");
    expect(text).toContain("3.9%");
    expect(text).toContain("$0.18");
  });

  test("the context percentage is against the soft budget (§10.10)", () => {
    const lines = renderStatusBar(
      {
        provider: "OpenAI",
        model: "m",
        permissionMode: "auto",
        reasoning: "medium",
        contextUsedTokens: 48_000,
        contextBudgetTokens: 96_000,
      },
      context(120),
      planLayout(120),
    );
    expect(lineText(lines[0]!)).toContain("50.0%");
  });

  test("a dirty tree is marked without relying on colour (§6.13, AC-45)", () => {
    const lines = renderStatusBar(
      {
        provider: "OpenAI",
        model: "m",
        permissionMode: "auto",
        reasoning: "medium",
        contextUsedTokens: 0,
        contextBudgetTokens: 96_000,
        git: { branch: "main", added: 1, deleted: 0, untracked: 3 },
      },
      context(120),
      planLayout(120),
    );
    expect(lineText(lines[0]!)).toContain("?3");
  });

  test("a long workspace path is compacted from the front", () => {
    expect(compactPath("/a/b/c/d/e/f/g/project", 14)).toContain("…/");
    expect(compactPath("/short", 40)).toBe("/short");
  });
});

// ---------------------------------------------------------------------------
// §6.12 live line
// ---------------------------------------------------------------------------

describe("live state line (§6.12)", () => {
  test("an idle state renders nothing so the composer gets the row", () => {
    expect(renderLiveLine({ kind: "idle", label: "" }, context())).toHaveLength(0);
  });

  test("an active state without a provider label still keeps RUN visible", () => {
    const lines = renderLiveLine({ kind: "working", label: "" }, context());
    expect(lines).toHaveLength(1);
    expect(lineText(lines[0]!)).toContain("[RUN]");
    expect(lineText(lines[0]!)).toContain("Working...");
  });

  test("a working state shows the label and interrupt hint", () => {
    const lines = renderLiveLine(
      { kind: "working", label: "Working...", interruptHint: "esc" },
      context(),
    );
    expect(lineText(lines[0]!)).toContain("Working...");
    expect(lineText(lines[0]!)).toContain("[esc]");
  });

  test("the spinner animates only when motion is allowed (§6.12)", () => {
    const moving = renderLiveLine({ kind: "working", label: "W" }, context(80), { frame: 1 });
    expect(lineText(moving[0]!)).toContain(SPINNER_FRAMES[1]!);

    const still = renderLiveLine(
      { kind: "working", label: "W" },
      context(80, { reducedMotion: true }),
      { frame: 1 },
    );
    expect(lineText(still[0]!)).toContain(icon("working", { unicode: true }));
  });

  test("keeps the live rail responsive with dense frames", () => {
    expect(SPINNER_INTERVAL_MS).toBeLessThanOrEqual(50);
    const dense = renderLiveLine({ kind: "working", label: "W" }, context(80), { frame: 4 });
    expect(lineText(dense[0]!)).toContain(SPINNER_FRAMES[4]!);
  });

  test("keeps every animated frame in the same braille glyph family", () => {
    expect(SPINNER_FRAMES.every((frame) => {
      const codePoint = frame.codePointAt(0) ?? 0;
      return codePoint >= 0x2800 && codePoint <= 0x28ff;
    })).toBe(true);
  });

  test("an approval state is bold and amber-labelled", () => {
    const cells = toSemanticCells(
      renderLiveLine({ kind: "awaiting_approval", label: "Approval required: process.run" }, context()),
    );
    expect(cells[0]?.emphasis).toContain("bold");
    expect(cells[0]?.tokens).toContain("accent.amber");
  });

  test("the completion label reads like §6.12's example", () => {
    expect(turnCompleteLabel({ filesChanged: 3, testsPassed: 12 })).toBe(
      "Turn complete · 3 files changed · 12 tests passed",
    );
    expect(turnCompleteLabel({ filesChanged: 1, testsFailed: 2 })).toContain("2 tests failed");
  });
});

// ---------------------------------------------------------------------------
// §6.14 composer
// ---------------------------------------------------------------------------

describe("composer (§6.14)", () => {
  test("an empty composer shows the placeholder and hints", () => {
    const lines = renderComposer({ text: "", cursor: 0 }, context(120), planLayout(120));
    const text = lineText(lines[0]!);
    expect(text).toContain("Ask anything...");
    expect(text).toContain(COMPOSER_HINT);
  });

  test("hints are hidden when the width cannot afford them (§6.16)", () => {
    const lines = renderComposer({ text: "", cursor: 0 }, context(60), planLayout(60));
    expect(lineText(lines[0]!)).not.toContain(COMPOSER_HINT);
  });

  test("the composer grows to the plan's maximum then shows the tail (§6.14)", () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const lines = renderComposer({ text: many, cursor: 0 }, context(120), planLayout(120));
    expect(lines.length).toBeLessThanOrEqual(8);
    // The tail is what the caret is in.
    expect(lines.map(lineText).join("\n")).toContain("line 19");
  });

  test("a masked field never renders its content (§6.14, §9.2)", () => {
    const lines = renderComposer(
      { text: "sk-secret-value", cursor: 0, masked: true },
      context(80),
      planLayout(80),
    );
    const text = lineText(lines[0]!);
    expect(text).not.toContain("sk-secret");
    expect(text).toContain("•");
  });

  test("paste tokens are highlighted in the accent colour", () => {
    const lines = renderComposer(
      { text: "see [Image 1] and [Text 2] here", cursor: 0 },
      context(80),
      planLayout(80),
    );
    // The first composer row carries the prompt and body. Find the segments
    // matching the tokens and confirm they are rendered with the accent colour.
    const segments = lines[0]!.segments;
    const tokens = segments.filter((s) =>
      /^\[(?:Image|Text)\s+\d+\]$/.test(s.text),
    );
    expect(tokens.length).toBe(2);
    expect(tokens.every((s) => s.fg === "accent.coral")).toBe(true);
    expect(tokens.every((s) => s.bold === true)).toBe(true);
  });

  test("text around paste tokens keeps the default foreground", () => {
    const lines = renderComposer(
      { text: "see [Image 1] now", cursor: 0 },
      context(80),
      planLayout(80),
    );
    const surrounding = lines[0]!.segments.filter(
      (s) => !/^\[(?:Image|Text)\s+\d+\]$/.test(s.text),
    );
    expect(surrounding.some((s) => s.text.includes("see"))).toBe(true);
    expect(
      surrounding.filter((s) => s.text.includes("see")).every((s) => s.fg === "fg.primary"),
    ).toBe(true);
  });

  test("wrapping accounts for wide characters", () => {
    const wrapped = wrapComposer("한글한글한글", 6, 8);
    expect(wrapped.every((l) => stringWidth(l) <= 6)).toBe(true);
  });

  test("wrapping keeps an IME grapheme cluster together", () => {
    const text = "한\u0301글";
    const wrapped = wrapComposer(text, 2, 8);
    expect(wrapped).toEqual(["한\u0301", "글"]);
    expect(wrapped.join("")).toBe(text);
  });
  test("completion kind is detected from the token (§6.14)", () => {
    expect(completionKindAt("@src/a", 6)).toBe("path");
    expect(completionKindAt("$release", 8)).toBe("skill");
    expect(completionKindAt("/mod", 4)).toBe("command");
    expect(completionKindAt("plain text", 10)).toBe("none");
    // A slash mid-sentence is not a command.
    expect(completionKindAt("see a/b", 7)).toBe("none");
  });

  test("the completion prefix strips the sigil", () => {
    expect(completionPrefix("@src/a", 6)).toBe("src/a");
    expect(completionPrefix("$rel", 4)).toBe("rel");
  });
});

// ---------------------------------------------------------------------------
// §6.15 keymap — AC-20, AC-21
// ---------------------------------------------------------------------------

describe("keymap (§6.15, §7.7, AC-20, AC-21)", () => {
  test("every documented key is bound", () => {
    const keys = new Set(DEFAULT_KEYMAP.map((b) => b.key));
    for (const key of [
       "enter", "shift+enter", "ctrl+j", "escape", "ctrl+c", "ctrl+d",
      "ctrl+a", "ctrl+e", "ctrl+r", "ctrl+k", "ctrl+u", "ctrl+w", "ctrl+y",
      "ctrl+o", "ctrl+t", "ctrl+b", "alt+p", "alt+t", "ctrl+p",
      "ctrl+x a", "ctrl+x t", "ctrl+x d", "ctrl+x l", "ctrl+x c",
      "ctrl+x m", "ctrl+x h", "ctrl+l", "tab", "shift+tab",
      "pageup", "pagedown", "?",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  test("Ctrl+T cycles reasoning effort and the tasks drawer keeps Ctrl+X T", () => {
    const idle = {
      running: false,
      overlayOpen: false,
      composerHasText: false,
      awaitingTask: false,
    };
    expect(resolveKey("ctrl+t", idle)?.action).toBe("cycle_reasoning_effort");
    expect(resolveKey("ctrl+x t", idle)?.action).toBe("tasks_drawer");
    // Reassigning Ctrl+T must not leave the drawer with only that one route.
    expect(DEFAULT_KEYMAP.some((b) => b.action === "tasks_drawer")).toBe(true);
  });

  test("Esc closes an overlay before interrupting a wait", () => {
    const overlay = resolveKey("escape", {
      running: true,
      overlayOpen: true,
      composerHasText: false,
      awaitingTask: true,
    });
    expect(overlay?.action).toBe("close_overlay");

    const waiting = resolveKey("escape", {
      running: true,
      overlayOpen: false,
      composerHasText: false,
      awaitingTask: true,
    });
    expect(waiting?.action).toBe("interrupt_wait");
  });

  test("Ctrl+C clears a draft and exits only from an empty composer (§6.15)", () => {
    expect(resolveCtrlC({ running: true, composerHasText: true, nowMs: 1_000 }).kind).toBe("clear_composer");
    expect(resolveCtrlC({ running: false, composerHasText: true, nowMs: 1_000 }).kind).toBe("clear_composer");
    expect(resolveCtrlC({ running: false, composerHasText: false, nowMs: 1_000 }).kind).toBe("confirm_exit");
    expect(CTRL_C_EXIT_HINT).toContain("again");

    expect(resolveCtrlC({
      running: true,
      composerHasText: false,
      lastCtrlC: 1_000,
      nowMs: 1_500,
    }).kind).toBe("exit");
  });

  test("a late second Ctrl+C requires confirmation again", () => {
    expect(resolveCtrlC({ running: false, composerHasText: false, lastCtrlC: 1_000, nowMs: 1_000 + CTRL_C_EXIT_WINDOW_MS + 1 }).kind).toBe("confirm_exit");
  });

  test("the first Esc stops waiting and a second offers cancel (§6.11, AC-21)", () => {
    const first = resolveEscape({ overlayOpen: false, awaitingTaskId: "a1", nowMs: 1_000 });
    expect(first.kind).toBe("interrupt_wait");
    expect(escapeScopeFor(first, "a1")).toBe("a1");

    const second = resolveEscape({
      overlayOpen: false,
      awaitingTaskId: "a1",
      lastEscape: { scope: "a1", atMs: 1_000 },
      nowMs: 1_500,
    });
    expect(second.kind).toBe("offer_cancel");
    // A completed escalation disarms rather than staying primed.
    expect(escapeScopeFor(second, "a1")).toBeUndefined();
  });

  test("a late second Esc does not escalate", () => {
    const late = resolveEscape({
      overlayOpen: false,
      awaitingTaskId: "a1",
      lastEscape: { scope: "a1", atMs: 1_000 },
      nowMs: 5_000,
    });
    expect(late.kind).toBe("interrupt_wait");
  });

  test("Esc on a different task does not escalate the new one", () => {
    const other = resolveEscape({
      overlayOpen: false,
      awaitingTaskId: "a2",
      lastEscape: { scope: "a1", atMs: 1_000 },
      nowMs: 1_100,
    });
    expect(other.kind).toBe("interrupt_wait");
  });

  test("Esc Esc stops the running turn", () => {
    const first = resolveEscape({ overlayOpen: false, turnRunning: true, nowMs: 1_000 });
    expect(first.kind).toBe("arm_cancel_turn");
    expect(escapeScopeFor(first)).toBe(ESCAPE_SCOPE_TURN);
    expect(ESCAPE_CANCEL_HINT).toContain("again");

    const second = resolveEscape({
      overlayOpen: false,
      turnRunning: true,
      lastEscape: { scope: ESCAPE_SCOPE_TURN, atMs: 1_000 },
      nowMs: 1_800,
    });
    expect(second.kind).toBe("cancel_turn");
  });

  test("Esc Esc cancels an idle background task", () => {
    const first = resolveEscape({
      overlayOpen: false,
      activeTaskId: "a1",
      nowMs: 1_000,
    });
    expect(first).toEqual({ kind: "arm_cancel_task", taskId: "a1" });
    expect(escapeScopeFor(first, "a1")).toBe("a1");

    const second = resolveEscape({
      overlayOpen: false,
      activeTaskId: "a1",
      lastEscape: { scope: "a1", atMs: 1_000 },
      nowMs: 1_200,
    });
    expect(second).toEqual({ kind: "cancel_task", taskId: "a1" });
  });
  test("a late second Esc re-arms the turn instead of stopping it", () => {
    const late = resolveEscape({
      overlayOpen: false,
      turnRunning: true,
      lastEscape: { scope: ESCAPE_SCOPE_TURN, atMs: 1_000 },
      nowMs: 1_000 + TURN_CANCEL_WINDOW_MS + 1,
    });
    expect(late.kind).toBe("arm_cancel_turn");
  });

  test("an awaited subagent outranks the turn, then yields to it (§6.11)", () => {
    // While a wait is in flight, Esc means "stop waiting" — the cheaper rung.
    const waiting = resolveEscape({
      overlayOpen: false,
      turnRunning: true,
      awaitingTaskId: "a1",
      nowMs: 1_000,
    });
    expect(waiting.kind).toBe("interrupt_wait");

    // Once the host has stopped waiting it clears the id, so the next Esc arms the
    // turn: Esc Esc frees you from the wait, then ends the work.
    const afterwards = resolveEscape({
      overlayOpen: false,
      turnRunning: true,
      lastEscape: { scope: "a1", atMs: 1_000 },
      nowMs: 1_200,
    });
    expect(afterwards.kind).toBe("cancel_turn");
  });

  test("Esc closes the popup before anything else (§6.14)", () => {
    const outcome = resolveEscape({
      overlayOpen: true,
      completionOpen: true,
      turnRunning: true,
      awaitingTaskId: "a1",
      nowMs: 0,
    });
    expect(outcome.kind).toBe("close_completions");
    expect(escapeScopeFor(outcome, "a1")).toBeUndefined();
  });

  test("Esc does not exit from an idle composer", () => {
    expect(resolveEscape({ overlayOpen: false, nowMs: 1_000 }).kind).toBe("ignored");
    expect(resolveEscape({
      overlayOpen: false,
      lastEscape: { scope: ESCAPE_SCOPE_TURN, atMs: 1_000 },
      nowMs: 1_500,
    }).kind).toBe("ignored");
  });

  test("the popup owns Tab, the arrows, and Enter while it is open (§6.14)", () => {
    const open = {
      running: false,
      overlayOpen: false,
      composerHasText: true,
      awaitingTask: false,
      completionOpen: true,
    };
    expect(resolveKey("tab", open)?.action).toBe("completion_accept");
    expect(resolveKey("shift+tab", open)?.action).toBe("completion_prev");
    expect(resolveKey("down", open)?.action).toBe("completion_next");
    expect(resolveKey("up", open)?.action).toBe("completion_prev");
    expect(resolveKey("enter", open)?.action).toBe("completion_accept");
    expect(resolveKey("escape", open)?.action).toBe("close_completions");
  });

  test("with the popup closed those keys go back to the composer (§6.14)", () => {
    const closed = {
      running: false,
      overlayOpen: false,
      composerHasText: true,
      awaitingTask: false,
      completionOpen: false,
    };
    expect(resolveKey("tab", closed)?.action).toBe("complete");
    expect(resolveKey("enter", closed)?.action).toBe("submit");
    expect(resolveKey("shift+tab", closed)?.action).toBe("cycle_interaction_mode");
    expect(resolveKey("up", closed)).toBeUndefined();
  });

  test("remapping is applied and an unknown action is reported (§6.15)", () => {
    const { keymap, issues } = applyRemapping(DEFAULT_KEYMAP, {
      command_palette: "ctrl+k",
      nonsense: "ctrl+z",
    });
    expect(keymap.find((b) => b.action === "command_palette")?.key).toBe("ctrl+k");
    expect(issues.some((i) => i.includes("nonsense"))).toBe(true);
  });

  test("the help overlay lists every binding", () => {
    const help = renderKeymapHelp().join("\n");
    expect(help).toContain("ctrl+p");
    expect(help).toContain("stop waiting; subagent continues");
    expect(help).toContain("alt+p");
  });

  test("quiescence commits a deferred Plan to Build transition", () => {
    const running = { ...createModeState("plan"), activeTurn: "plan" as const };
    const pending = requestModeChange(
      running,
      { target: "build", source: "key" },
      { turnRunning: true },
    );
    expect(pending.kind).toBe("pending");
    if (pending.kind !== "pending") return;

    const committed = requestModeChange(
      pending.state,
      { target: "build", source: "quiescence" },
      { turnRunning: false },
    );
    expect(committed.kind).toBe("applied");
    expect(committed.state.selected).toBe("build");
    expect(committed.state.pending).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §6.17 overlays and §6.18 diff viewer
// ---------------------------------------------------------------------------

describe("overlays and the diff viewer (§6.17, §6.18)", () => {
  test("every §8.10 slash command is present and searchable", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    for (const expected of ["/help", "/model", "/new", "/compact", "/quit"]) {
      expect(names).toContain(expected);
    }
    for (const removed of ["/diff", "/fork", "/undo", "/clear", "/clealr"]) {
      expect(names).not.toContain(removed);
    }
    expect(searchSlashCommands("/mod").map((c) => c.name)).toContain("/model");
    expect(searchSlashCommands("").length).toBe(SLASH_COMMANDS.length);
  });

  test("an overlay is framed with a title and a close hint (§6.17)", () => {
    const lines = renderOverlay("agents", [], context());
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("Agents");
    expect(text).toContain("esc to close");
  });

  test("a selectable list marks the selection without colour (AC-45)", () => {
    const lines = renderSelectableList(
      [{ label: "gpt-5.6", detail: "default" }, { label: "gpt-5.6-terra" }],
      1,
      context(),
    );
    expect(lineText(lines[1]!)).toContain("▸");
    expect(lineText(lines[0]!).startsWith("  ")).toBe(true);
  });

  test("an empty list says so rather than rendering nothing", () => {
    expect(lineText(renderSelectableList([], 0, context())[0]!)).toContain("nothing to show");
  });

  test("a unified diff parses into files and hunks", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " keep",
        "-old",
        "+new",
        " tail",
      ].join("\n"),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/a.ts");
    expect(files[0]?.additions).toBe(1);
    expect(files[0]?.deletions).toBe(1);
    expect(files[0]?.hunks[0]?.lines).toHaveLength(4);
  });

  test("the viewer shows scope, counts, and hunks (§6.18)", () => {
    const files = parseUnifiedDiff(
      ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    );
    const lines = renderDiffViewer(
      { scope: "turn", files, selectedFile: 0, selectedHunk: 0 },
      context(120),
      { sideBySideMetadata: true },
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain(DIFF_SCOPE_LABELS.turn);
    expect(text).toContain("a.ts");
    expect(text).toContain("@@ -1 +1 @@");
    // §6.5: the +/- marker distinguishes the lines with no colour.
    expect(text).toContain("+b");
    expect(text).toContain("-a");
  });

  test("user changes are labelled distinctly from agent changes (§6.18)", () => {
    const lines = renderDiffViewer(
      {
        scope: "working_tree",
        files: [{ path: "a.ts", additions: 1, deletions: 0, hunks: [], origin: "user" }],
        selectedFile: 0,
      },
      context(120),
    );
    expect(lines.map(lineText).join("\n")).toContain("your change");
  });

  test("a binary file shows metadata only (§6.18)", () => {
    const lines = renderDiffViewer(
      {
        scope: "turn",
        files: [{ path: "logo.png", additions: 0, deletions: 0, hunks: [], origin: "agent", binary: true, bytes: 9_000 }],
        selectedFile: 0,
      },
      context(120),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("binary file");
    expect(text).toContain("9000 bytes");
  });

  test("whitespace-only hunks can be hidden (§6.18)", () => {
    const hunk = {
      header: "@@ -1 +1 @@",
      lines: [
        { kind: "removed" as const, text: "  a" },
        { kind: "added" as const, text: "\ta" },
      ],
    };
    expect(isWhitespaceOnlyHunk(hunk)).toBe(true);

    const lines = renderDiffViewer(
      {
        scope: "turn",
        files: [{ path: "a.ts", additions: 1, deletions: 1, hunks: [hunk], origin: "agent" }],
        selectedFile: 0,
        hideWhitespaceOnly: true,
      },
      context(120),
    );
    const text = lines.map(lineText).join("\n");
    expect(text).toContain("whitespace-only hidden");
    expect(text).toContain("no hunks to show");
  });

  test("a real change is not mistaken for whitespace-only", () => {
    expect(
      isWhitespaceOnlyHunk({
        header: "@@",
        lines: [
          { kind: "removed", text: "a" },
          { kind: "added", text: "b" },
        ],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.2 screen composition and §25.8 golden matrix
// ---------------------------------------------------------------------------

describe("screen composition (§6.2, §6.3, AC-40)", () => {
  function viewModel(items: TimelineItem[], overrides: Partial<SessionViewModel> = {}): SessionViewModel {
    return { ...emptyViewModel("ses_1"), timeline: items, ...overrides };
  }

  test("the screen is assembled in §6.2 order", () => {
    const screen = composeScreen({
      model: viewModel([{ type: "user", id: "u", sequence: 1, text: "hi", timestamp: "" }], {
        live: { kind: "working", label: "Working...", interruptHint: "esc" },
      }),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities({ columns: 120, rows: 40 }),
      updateVersion: "0.12.5",
      git: { branch: "main", added: 1, deleted: 0 },
      workspacePath: "/repo",
    });

    expect(screen.banner.length).toBeGreaterThan(0);
    expect(screen.timeline.length).toBeGreaterThan(0);
    expect(screen.live).toHaveLength(1);
    expect(screen.status).toHaveLength(1);
    expect(screen.composer.length).toBeGreaterThan(0);

    const kinds = screen.lines.map((l) => l.kind);
    expect(kinds.indexOf("banner")).toBeLessThan(kinds.indexOf("live"));
    expect(kinds.indexOf("live")).toBeLessThan(kinds.indexOf("composer"));
    expect(kinds.indexOf("composer")).toBeLessThan(kinds.indexOf("status"));
  });

  test("an overlay replaces the timeline but keeps live and status (§6.17)", () => {
    const screen = composeScreen({
      model: viewModel([{ type: "user", id: "u", sequence: 1, text: "hi", timestamp: "" }], {
        live: { kind: "working", label: "Working..." },
      }),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities(),
      overlay: renderOverlay("jobs", [], context()),
    });
    expect(screen.timeline).toHaveLength(0);
    expect(screen.overlay.length).toBeGreaterThan(0);
    // The running job stays visible.
    expect(screen.live).toHaveLength(1);
    expect(screen.status).toHaveLength(1);
  });

  test("the timeline is virtualized to the viewport (§22.3)", () => {
    const items: TimelineItem[] = Array.from({ length: 200 }, (_, i) => ({
      type: "notice",
      id: `n${i}`,
      sequence: i,
      level: "info",
      text: `notice ${i}`,
    }));
    const screen = composeScreen({
      model: viewModel(items),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities(),
      timelineRows: 10,
    });
    expect(screen.timeline).toHaveLength(10);
    // The tail is what is shown, since the timeline is scrollback-first.
    expect(lineText(screen.timeline.at(-1)!)).toContain("notice 199");

    const scrolled = composeScreen({
      model: viewModel(items),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities(),
      timelineRows: 10,
      timelineScrollOffsetFromBottom: 50,
    });
    expect(scrolled.timeline).toHaveLength(10);
    expect(lineText(scrolled.timeline.at(-1)!)).toContain("notice 174");
    expect(lineText(scrolled.timeline[0]!)).toContain("█");
    expect(scrolled.timeline.map(lineText).join("\n")).not.toContain("Scroll ");
  });

  test("visibleSlice clamps a scroll offset to the available range", () => {
    expect(visibleSlice(100, 10, 0)).toEqual({ start: 90, end: 100 });
    expect(visibleSlice(100, 10, 50)).toEqual({ start: 40, end: 50 });
    expect(visibleSlice(100, 10, 999)).toEqual({ start: 0, end: 10 });
    expect(visibleSlice(5, 10, 0)).toEqual({ start: 0, end: 5 });
  });

  test("the compact warning appears only below 60 columns (§6.16)", () => {
    const narrow = composeScreen({
      model: viewModel([]),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities({ columns: 50 }),
      showCompactWarning: true,
    });
    expect(narrow.banner.map(lineText).join("\n")).toContain(COMPACT_TERMINAL_WARNING);

    const wide = composeScreen({
      model: viewModel([]),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities({ columns: 120 }),
      showCompactWarning: true,
    });
    expect(wide.banner).toHaveLength(0);
  });

  test("the terminal restore sequence covers cursor, paste, and screen (AC-40)", () => {
    const restore = restoreSequence();
    expect(restore).toContain("\u001B[?25h"); // show cursor
    expect(restore).toContain("\u001B[?2004l"); // disable bracketed paste
    expect(restore).toContain("\u001B[?1002l"); // disable button-drag mouse tracking
    expect(restore).toContain("\u001B[?1049l"); // leave alternate screen
    expect(restore).toContain("\u001B[0m"); // reset attributes
    expect(enterSequence()).toContain("\u001B[?1049h");
    expect(enterSequence()).toContain("\u001B[?1002h");
    expect(enterSequence()).not.toContain("\u001B[?1003h");
  });
});

describe("golden matrix (§25.8)", () => {
  const items: TimelineItem[] = [
    { type: "user", id: "u", sequence: 1, text: "서브 에이전트로 파이썬 코드 작성해줘", timestamp: "" },
    { type: "commentary", id: "c", sequence: 2, variant: "commentary", text: "Evaluating sub-agent delegation options" },
    {
      type: "task",
      id: "t",
      sequence: 3,
      taskId: "a1",
      role: "executor",
      title: "PythonDemo",
      goal: "Create a small standalone Python script",
      constraints: ["MUST create only scripts/demo.py."],
      contract: ["Return the created path."],
      writeLease: ["scripts/demo.py"],
      modelId: "gpt-5.6-terra",
      state: "running",
      childCount: 1,
      awaitInterrupted: false,
      durationMs: 12_400,
      subagentEvents: [
        {
          id: "se1",
          sequence: 31,
          callId: "c1",
          toolId: "fs.read",
          argumentsSummary: "scripts/demo.py",
          status: "succeeded",
          durationMs: 12,
        },
        {
          id: "se2",
          sequence: 32,
          callId: "c2",
          toolId: "fs.write",
          argumentsSummary: "scripts/demo.py",
          status: "succeeded",
          additions: 18,
          deletions: 0,
          diffPreview: [
            { kind: "added", lineNumber: 18, text: 'print("Hello from Subagent!")' },
            { kind: "added", lineNumber: 19, text: 'print("Timestamp:", datetime.now())' },
          ],
        },
        {
          id: "se3",
          sequence: 33,
          callId: "c3",
          toolId: "process.run",
          argumentsSummary: "python3 scripts/demo.py",
          status: "succeeded",
          exitCode: 0,
          durationMs: 200,
        },
      ],
    },
    {
      type: "job",
      id: "j",
      sequence: 4,
      jobId: "job1",
      display: "PythonDemo",
      state: "completed",
      durationMs: 19_700,
    },
    { type: "notice", id: "n", sequence: 5, level: "error", text: OPERATION_ABORTED_MESSAGE },
  ];

  for (const [columns, rows] of TERMINAL_MATRIX) {
    test(`${columns}x${rows} renders within the width in every colour depth`, () => {
      for (const depth of ["truecolor", "256", "16", "none"] as const) {
        const caps = capabilities({ columns, rows, colorDepth: depth });
        const screen = composeScreen({
          model: { ...emptyViewModel("s"), timeline: items },
          composer: { text: "", cursor: 0 },
          capabilities: caps,
          git: { branch: "main", added: 96, deleted: 5 },
          workspacePath: "/home/me/a/very/deep/workspace/path/project",
        });

        // Every line fits: an overflowing status bar or task card would corrupt the
        // layout on the next redraw.
        for (const cell of toSemanticCells(screen.lines)) {
          expect(cell.width).toBeLessThanOrEqual(columns);
        }

        // The ANSI serialization must never leak a forbidden sequence from content.
        const theme = new Theme({ depth });
        const ansi = renderAnsi(screen.lines, {
          theme,
          capabilities: caps,
          columns,
        });
        if (depth === "none") {
          // AC-45: no escapes at all, and the state words are still present.
          expect(ansi).not.toContain("\u001B");
          expect(ansi).toContain("Operation aborted");
          expect(ansi).toContain("Background job completed");
        }
      }
    });
  }

  test("with no colour a mixed-state tool tree is still unambiguous (AC-45)", () => {
    const caps = capabilities({ columns: 120, colorDepth: "none" });
    const card = renderTaskCard(
      {
        role: "executor",
        title: "FixTokenizer",
        goal: "Repair the off-by-one in the tokenizer",
        constraints: [],
        contract: [],
        writeLease: ["src/tokenizer.ts"],
        state: "running",
        childCount: 1,
        awaitInterrupted: false,
        subagentEvents: [
          {
            id: "e1",
            sequence: 1,
            callId: "c1",
            toolId: "fs.read",
            argumentsSummary: "src/tokenizer.ts",
            status: "succeeded",
          },
          {
            id: "e2",
            sequence: 2,
            callId: "c2",
            toolId: "fs.apply_patch",
            argumentsSummary: "src/tokenizer.ts",
            status: "failed",
            errorCode: "HASH_MISMATCH",
          },
          {
            id: "e3",
            sequence: 3,
            callId: "c3",
            toolId: "process.run",
            argumentsSummary: "bun test",
            status: "running",
          },
        ],
      },
      blockContext(caps, 120),
    );

    const ansi = renderAnsi(card, { theme: new Theme({ depth: "none" }), capabilities: caps, columns: 120 });
    // AC-45: not one escape byte, so nothing below can be carried by colour.
    expect(ansi).not.toContain("\u001B");

    // Every one of the three states is named, so they cannot be confused.
    expect(ansi).toContain("[Read] src/tokenizer.ts ok");
    expect(ansi).toContain("[Patch] src/tokenizer.ts failed HASH_MISMATCH");
    expect(ansi).toContain("[Run] bun test running");
    // And the card's own state is a word too.
    expect(ansi).toContain("Running");
    expect(ansi).toContain("Running (3 tool uses");

    // The tree structure is drawn with characters, not indentation alone.
    expect(ansi).toContain("├──");
    expect(ansi).toContain("└──");

    // Each state word appears on its own row, so no row is ambiguous.
    const rows = ansi.split("\n");
    expect(rows.filter((r) => r.includes(" ok")).length).toBe(1);
    expect(rows.filter((r) => r.includes(" failed")).length).toBe(1);
  });

  test("with no colour a completed and a failed card cannot be confused (AC-45)", () => {
    const caps = capabilities({ columns: 100, colorDepth: "none" });
    const render = (state: "completed" | "failed") =>
      renderAnsi(
        renderTaskCard(
          {
            role: "executor",
            title: "Demo",
            goal: "g",
            constraints: [],
            contract: [],
            state,
            childCount: 1,
            awaitInterrupted: false,
            summary: state === "failed" ? "the patch did not apply" : "wrote scripts/demo.py",
          },
          blockContext(caps, 100),
        ),
        { theme: new Theme({ depth: "none" }), capabilities: caps, columns: 100 },
      );

    const done = render("completed");
    const failed = render("failed");
    expect(done).toContain("Completed (1 subagent");
    expect(failed).toContain("Failed (1 subagent");
    expect(done).not.toContain("Failed");
    expect(failed).not.toContain("Completed");
  });

  test("the ASCII fallback keeps every state distinguishable (§6.6)", () => {
    const caps = capabilities({ unicode: false, columns: 80 });
    const screen = composeScreen({
      model: { ...emptyViewModel("s"), timeline: items },
      composer: { text: "", cursor: 0 },
      capabilities: caps,
    });
    const text = screen.lines.map(lineText).join("\n");
    expect(text).not.toContain("✓");
    expect(text).not.toContain("⧖");
    expect(text).toContain("Background job completed");
    expect(text).toContain("executor (Create a small standalone Python script)");
    expect(text).toContain("Running");
  });

  test("CJK content still fits the narrowest terminal", () => {
    const caps = capabilities({ columns: 60, rows: 20 });
    const screen = composeScreen({
      model: {
        ...emptyViewModel("s"),
        timeline: [
          {
            type: "user",
            id: "u",
            sequence: 1,
            text: "그냥 서브 에이전트 사용해서 파이썬 아무 코드나 작성해줘",
            timestamp: "",
          },
        ],
      },
      composer: { text: "", cursor: 0 },
      capabilities: caps,
    });
    for (const cell of toSemanticCells(screen.lines)) {
      expect(cell.width).toBeLessThanOrEqual(60);
    }
  });

  test("a very long path never overflows the status bar", () => {
    const screen = composeScreen({
      model: emptyViewModel("s"),
      composer: { text: "", cursor: 0 },
      capabilities: capabilities({ columns: 120 }),
      workspacePath: "/".padEnd(400, "deep/"),
    });
    expect(toSemanticCells(screen.status)[0]?.width).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// Mouse selection, clipboard, and toast
// ---------------------------------------------------------------------------

describe("mouse selection model", () => {
  test("normalizedSpan orders start before end", () => {
    const selection: SelectionState = {
      start: { row: 5, column: 10 },
      end: { row: 2, column: 3 },
      active: true,
    };
    const { start, end } = normalizedSpan(selection);
    expect(start.row).toBe(2);
    expect(start.column).toBe(3);
    expect(end.row).toBe(5);
    expect(end.column).toBe(10);
  });

  test("cellInSelection respects row and column bounds", () => {
    const selection: SelectionState = {
      start: { row: 1, column: 2 },
      end: { row: 3, column: 5 },
      active: true,
    };
    expect(cellInSelection(selection, 0, 0)).toBe(false);
    expect(cellInSelection(selection, 1, 1)).toBe(false);
    expect(cellInSelection(selection, 1, 2)).toBe(true);
    expect(cellInSelection(selection, 2, 0)).toBe(true);
    expect(cellInSelection(selection, 3, 5)).toBe(true);
    expect(cellInSelection(selection, 3, 6)).toBe(false);
    expect(cellInSelection(selection, 4, 0)).toBe(false);
  });

  test("isMultiCell distinguishes a click from a drag", () => {
    expect(isMultiCell({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 }, active: true })).toBe(false);
    expect(isMultiCell({ start: { row: 0, column: 0 }, end: { row: 0, column: 1 }, active: true })).toBe(true);
    expect(isMultiCell({ start: { row: 0, column: 0 }, end: { row: 1, column: 0 }, active: true })).toBe(true);
  });

  test("extractSelectionText slices the covered text from a frame", () => {
    const lines = [
      { segments: [{ text: "hello world" }] },
      { segments: [{ text: "second line" }] },
      { segments: [{ text: "third" }] },
    ];
    // Same row slice.
    expect(
      extractSelectionText(lines, {
        start: { row: 0, column: 0 },
        end: { row: 0, column: 4 },
        active: false,
      }),
    ).toBe("hello");
    // Multi-row span.
    expect(
      extractSelectionText(lines, {
        start: { row: 0, column: 6 },
        end: { row: 2, column: 4 },
        active: false,
      }),
    ).toBe("world\nsecond line\nthird");
  });

  test("extractSelectionText is cell-aware across wide glyphs (P1-02)", () => {
    // Each Hangul syllable and the emoji span two terminal cells. Selecting by
    // cell columns must yield whole clusters, never half of one.
    const lines = [{ segments: [{ text: "a한b글c" }] }]; // cells: a=0, 한=1-2, b=3, 글=4-5, c=6
    expect(
      extractSelectionText(lines, {
        start: { row: 0, column: 1 },
        end: { row: 0, column: 5 },
        active: false,
      }),
    ).toBe("한b글");
    // Anchoring into the second cell of a wide glyph still selects the cluster.
    expect(
      extractSelectionText(lines, {
        start: { row: 0, column: 2 },
        end: { row: 0, column: 3 },
        active: false,
      }),
    ).toBe("한b");
    const emoji = [{ segments: [{ text: "x🙂y" }] }]; // x=0, 🙂=1-2, y=3
    expect(
      extractSelectionText(emoji, {
        start: { row: 0, column: 1 },
        end: { row: 0, column: 2 },
        active: false,
      }),
    ).toBe("🙂");
  });

  test("applySelectionOverlay paints covered cells with the selection highlight", () => {
    const caps = capabilities({ columns: 40 });
    const ctx = blockContext(caps, 40);
    const frame: StyledLine[] = [
      line("body", [segment("aaaa", { fg: "fg.primary" })]),
      line("body", [segment("bbbb", { fg: "fg.primary" })]),
      line("body", [segment("cccc", { fg: "fg.primary" })]),
    ];
    const selection: SelectionState = {
      start: { row: 0, column: 1 },
      end: { row: 1, column: 2 },
      active: true,
    };
    const overlayed = applySelectionOverlay(frame, selection);
    const cells = toSemanticCells(overlayed);
    // Row 0: the selected run carries the slate selection background so the
    // highlight is visible on every terminal, not only where SGR 7 is supported.
    expect(cells[0]?.tokens).toContain("bg.task");
    expect(cells[0]?.text).toBe("aaaa");
    // Row 2: untouched, no selection highlight.
    expect(cells[2]?.tokens).not.toContain("bg.task");
  });

  test("applySelectionOverlay is a no-op for a single-cell click", () => {
    const frame: StyledLine[] = [line("body", [segment("aaaa", { fg: "fg.primary" })])];
    const selection: SelectionState = {
      start: { row: 0, column: 1 },
      end: { row: 0, column: 1 },
      active: true,
    };
    const overlayed = applySelectionOverlay(frame, selection);
    expect(toSemanticCells(overlayed)[0]?.tokens).not.toContain("accent.coral");
  });
});

describe("toast notifications", () => {
  test("makeToast sets an expiry from now", () => {
    const toast = makeToast("success", "Copied 12 characters", 1_000);
    expect(toast.kind).toBe("success");
    expect(toast.text).toBe("Copied 12 characters");
    expect(toast.expiresAt).toBe(1_000 + TOAST_DURATION_MS);
  });

  test("toastExpired reports whether the toast is past its expiry", () => {
    const toast = makeToast("info", "hi", 1_000, 500);
    expect(toastExpired(toast, 1_400)).toBe(false);
    expect(toastExpired(toast, 1_500)).toBe(true);
    expect(toastExpired(toast, 2_000)).toBe(true);
  });

  test("renderToast produces an upper-right card with aligned rows", () => {
    const caps = capabilities({ columns: 40 });
    const ctx = blockContext(caps, 40);
    const toast = makeToast("success", "Copied", 0);
    const rendered = renderToast(toast, ctx);
    expect(rendered.length).toBe(3);
    // Every row reserves the same terminal width, including the right inset.
    expect(rendered.every((row) => lineWidth(row) === 40)).toBe(true);
    // Top and bottom borders are overlay-kind lines with box glyphs.
    expect(rendered[0]?.kind).toBe("overlay");
    expect(rendered[2]?.kind).toBe("overlay");
    // The card is right-aligned and the body row carries the message text.
    const topText = lineText(rendered[0]!);
    expect(topText.startsWith(" ")).toBe(true);
    expect(topText.endsWith(" ")).toBe(true);
    expect(lineText(rendered[1]!)).toContain("Copied");
  });
});

describe("clipboard OSC 52", () => {
  test("osc52Copy wraps base64 text in the OSC 52 sequence", () => {
    const sequence = osc52Copy("hello");
    expect(sequence.startsWith("\u001B]52;c;")).toBe(true);
    expect(sequence.endsWith("\u001B\\")).toBe(true);
    // base64 of "hello" is "aGVsbG8=".
    expect(sequence).toBe("\u001B]52;c;aGVsbG8=\u001B\\");
  });

  test("base64Encode handles ASCII and multibyte UTF-8", () => {
    expect(base64Encode("hello")).toBe("aGVsbG8=");
    // "한글" UTF-8 bytes: ed 95 9c ea b8 80 -> base64.
    expect(base64Encode("한글")).toBe("7ZWc6riA");
  });

  test("base64Encode of empty string is empty", () => {
    expect(base64Encode("")).toBe("");
  });
});

describe("commentary item rendering and variant separation", () => {
  test("renderTimeline keeps reasoning_summary and commentary as separate items", () => {
    const items = [
      {
        type: "commentary" as const,
        id: "c1",
        sequence: 1,
        variant: "reasoning_summary" as const,
        text: "Thinking process...",
      },
      {
        type: "commentary" as const,
        id: "c2",
        sequence: 2,
        variant: "commentary" as const,
        text: "Regular response text",
      },
    ];
    const rendered = renderTimeline(items, blockContext(capabilities({ columns: 80 }), 80));
    const fullText = rendered.map(lineText).join("\n");
    expect(fullText).toContain("Thinking");
    expect(fullText).toContain("Regular response text");
  });

  test("full Thinking remains authoritative when accordionCollapsed is false", () => {
    const items = [
      {
        type: "commentary" as const,
        id: "c1",
        sequence: 1,
        variant: "reasoning_summary" as const,
        text: "Detailed past thinking process text that should stay hidden",
      },
      {
        type: "commentary" as const,
        id: "c2",
        sequence: 2,
        variant: "commentary" as const,
        text: "Latest active commentary response text",
      },
    ];
    const rendered = renderTimeline(
      items,
      blockContext(capabilities({ columns: 80 }), 80),
      { accordionCollapsed: false },
    );
    const fullText = rendered.map(lineText).join("\n");
    expect(fullText).toContain("Detailed past thinking process text that should stay hidden");
    expect(fullText).toContain("Latest active commentary response text");
  });

  test("renderRightSidebar renders session ID, credential source, and command help hint at the bottom", () => {
    const model = emptyViewModel("ses_20260810042604_1fc7");
    const input = sidebarFromViewModel(model, {
      credentialSource: "account",
    });
    const rendered = renderRightSidebar(input, blockContext(capabilities({ columns: 40 }), 40));
    const fullText = rendered.map(lineText).join("\n");
    expect(fullText).toContain("Session ses_20260810042604_1fc7");
    expect(fullText).toContain("credential account");
    expect(fullText).toContain("/help");
    expect(fullText).toContain("/quit");
  });
});
