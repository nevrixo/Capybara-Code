/**
 * Screen composition — PRD §6.2, §6.3, §6.16, §6.20, AC-04, AC-40.
 *
 * §6.2's structure, from the top: an optional notice banner, the scrollable
 * timeline, the live-state line, the status bar, then the composer. §6.3 caps the
 * always-visible layers at three, which is why the live line disappears when idle
 * rather than showing "Idle".
 */

import type { SessionViewModel } from "@cbc/session-domain";

import {
  renderTimeline,
  renderTimelineWindowDetails,
  renderUpdateBanner,
  type TimelineRenderOptions,
} from "./blocks.ts";
import {
  renderComposer,
  renderLiveLine,
  renderRightSidebar,
  renderStatusBar,
  visibleLiveState,
  sidebarFromViewModel,
  statusFromViewModel,
  type ComposerState,
  type GitStatusView,
  type LiveLineOptions,
  type SidebarInput,
  type SidebarService,
} from "./chrome.ts";
import { planLayout, type LayoutPlan } from "./layout.ts";
import { blank, line, lineWidth, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import { icon, treeGlyphs, type TerminalCapabilities, type Theme, type ThemeToken } from "./theme.ts";
import { stringWidth, truncateToWidth } from "./width.ts";
import {
  type ProjectedTimeline,
  type TimelineStreamingView,
} from "./timeline.ts";

export interface ScreenInput {
  readonly model: SessionViewModel;
  readonly composer: ComposerState;
  readonly capabilities: TerminalCapabilities;
  readonly git?: GitStatusView;
  readonly workspacePath?: string;
  readonly provider?: string;
  /** §6.19 update banner, when one is pending. */
  readonly updateVersion?: string;
  /** Overlay body, when one is open (§6.17). */
  readonly overlay?: readonly StyledLine[];
  /** Overlay viewport state. The body is sliced after the fixed header/rule. */
  readonly overlayScrollOffset?: number;
  readonly overlayRows?: number;
  /** Effective permission axes for the status bar (write/shell/network/…). */
  readonly permissionDetail?: string;
  readonly liveOptions?: LiveLineOptions;
  readonly nowMs?: number;
  readonly timelineOptions?: TimelineRenderOptions;
  /** §6.16: shown once when the terminal is very narrow. */
  readonly showCompactWarning?: boolean;
  /** Rows available for the timeline. Omit to render the whole thing. */
  readonly timelineRows?: number;
  /**
   * Rows to move backwards from the newest timeline tail. Zero follows the live
   * bottom, while a positive value is used by PageUp/PageDown in the full-screen
   * renderer.
   */
  readonly timelineScrollOffsetFromBottom?: number;
  /** Last known maximum offset, used to keep the scrollbar position stable while the virtualized walk is incomplete. */
  readonly timelineMaxScrollOffsetHint?: number;
  /**
   * Session-scoped incremental projection. When supplied, composeScreen syncs only
   * the appended suffix/active mutable items and uses its row index instead of
   * sorting/filtering the complete history for this frame.
   */
  readonly timelineProjection?: ProjectedTimeline;
  /** Ephemeral provider text kept outside the durable timeline array. */
  readonly streamingViews?: readonly TimelineStreamingView[];

  // §6.21 sidebar.
  /** `Ctrl+B` override. Omit to follow the width. */
  readonly sidebarVisible?: boolean;
  /** §21.4 `ui.showCost` override. Omit to follow the breakpoint. */
  readonly showCost?: boolean;
  /** §21.4 `ui.statusDensity` override. Omit to follow the breakpoint. */
  readonly statusDensity?: "auto" | "compact" | "full";
  /** Prebuilt sidebar content. Omit to derive it from the view model. */
  readonly sidebar?: SidebarInput;
  /** Title shown at the top of the sidebar, usually the turn's goal. */
  readonly sidebarTitle?: string;
  readonly mcpServers?: readonly SidebarService[];
  readonly lspServers?: readonly SidebarService[];
  readonly notices?: readonly string[];
  readonly sessionId?: string;
  readonly credentialSource?: string;
  readonly helpHint?: string;
  /** Pending decision card rendered right above live line and composer. */
  readonly approvalCard?: readonly StyledLine[];
}

export interface Screen {
  readonly plan: LayoutPlan;
  readonly banner: StyledLine[];
  /** Timeline lines at the *main column* width, before any column join. */
  readonly timeline: StyledLine[];
  /**
   * The maximum scroll offset known when a bounded window reached the oldest item.
   * It is omitted while the virtualized walk is still inside the timeline.
   */
  readonly timelineMaxScrollOffset?: number;
  /** Sidebar lines at the sidebar width. Empty when the sidebar is hidden. */
  readonly sidebar: StyledLine[];
  /** The timeline and sidebar joined into full-width rows. */
  readonly body: StyledLine[];
  readonly live: StyledLine[];
  readonly status: StyledLine[];
  readonly composer: StyledLine[];
  readonly overlay: StyledLine[];
  /** Everything in §6.2 order, ready to serialize. */
  readonly lines: StyledLine[];
}

export function blockContext(
  capabilities: TerminalCapabilities,
  columns?: number,
): BlockContext {
  return {
    columns: columns ?? capabilities.columns,
    capabilities: {
      unicode: capabilities.unicode,
      italic: capabilities.italic,
      reducedMotion: capabilities.reducedMotion,
      stableEmojiWidth: capabilities.stableEmojiWidth,
    },
  };
}

/**
 * Compose a full screen.
 *
 * §6.2's vertical order still holds: banner, body, live line, status bar,
 * composer. §6.21 splits only the *body* into two columns, and deliberately not
 * the rest — the status bar and composer describe the session rather than the
 * timeline, so cutting them at 72% would push the model name and the caret into a
 * narrower box for no reason.
 *
 * §6.17: an open overlay replaces the body region only. The live line and status
 * bar stay, because §6.17 requires the active job to remain visible while an
 * overlay is open. An overlay also suspends the sidebar: two panels competing for
 * the same region is how a lens becomes a maze.
 */
export interface PrepareScreenOptions {
  /**
   * Hosts with a custom composer panel can omit the package composer while still
   * preparing layout/live/status/sidebar exactly once.
   */
  readonly renderComposer?: boolean;
}

/** Chrome/layout prepared once, then combined with a row-bounded viewport. */
export interface PreparedScreen {
  readonly input: ScreenInput;
  readonly plan: LayoutPlan;
  readonly context: BlockContext;
  readonly timelineContext: BlockContext;
  readonly timelineTargetWidth: number;
  readonly overlayOpen: boolean;
  readonly twoColumn: boolean;
  readonly banner: StyledLine[];
  readonly sidebar: StyledLine[];
  readonly live: StyledLine[];
  readonly status: StyledLine[];
  readonly composer: StyledLine[];
}

export interface ScreenViewportOptions {
  readonly timelineRows?: number;
  readonly timelineScrollOffsetFromBottom?: number;
  readonly timelineMaxScrollOffsetHint?: number;
  readonly overlayRows?: number;
  readonly overlayScrollOffset?: number;
}

export interface ScreenViewport {
  /** Timeline rows at the main-column width, including its scrollbar rail. */
  readonly timeline: StyledLine[];
  readonly overlay: StyledLine[];
  readonly timelineMaxScrollOffset?: number;
}

/**
 * Single-pass chrome/layout phase for a session frame.
 *
 * renderSessionFrame used to call composeScreen(0), calculate the body budget,
 * and call composeScreen(rows) again. prepareScreen + composePreparedScreen let a
 * host calculate that budget from these already-rendered arrays and build only the
 * timeline/sidebar join in the second phase.
 */
export function prepareScreen(
  input: ScreenInput,
  options: PrepareScreenOptions = {},
): PreparedScreen {
  const configuredPlan = planLayout(input.capabilities.columns, {
    ...(input.capabilities.rows !== undefined ? { rows: input.capabilities.rows } : {}),
    ...(input.sidebarVisible !== undefined ? { sidebarVisible: input.sidebarVisible } : {}),
    ...(input.showCost !== undefined ? { showCost: input.showCost } : {}),
    ...(input.statusDensity !== undefined ? { statusDensity: input.statusDensity } : {}),
  });
  const overlayOpen = input.overlay !== undefined;
  const plan: LayoutPlan =
    overlayOpen && configuredPlan.showSidebar
      ? {
          ...configuredPlan,
          sidebarMode: "hidden",
          showSidebar: false,
          mainWidth: configuredPlan.columns,
          sidebarWidth: 0,
          dividerWidth: 0,
        }
      : configuredPlan;
  const context = blockContext(input.capabilities, plan.columns);
  const twoColumn = plan.showSidebar;
  const timelineTargetWidth = twoColumn ? plan.mainWidth : plan.columns;
  const timelineContext = blockContext(
    input.capabilities,
    Math.max(1, timelineTargetWidth),
  );

  const banner: StyledLine[] = [];
  if (input.updateVersion !== undefined) {
    banner.push(...renderUpdateBanner({ version: input.updateVersion }, context));
  }
  if (input.showCompactWarning === true && plan.warning !== undefined) {
    banner.push(
      line("banner", [
        segment(`${icon("warning", context.capabilities)} `, { fg: "accent.amber" }),
        segment(plan.warning, { fg: "accent.amber" }),
      ]),
    );
  }

  const sidebar = twoColumn
    ? renderRightSidebar(
        input.sidebar ??
          sidebarFromViewModel(input.model, {
            ...(input.sidebarTitle !== undefined ? { title: input.sidebarTitle } : {}),
            ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
            ...(input.lspServers !== undefined ? { lspServers: input.lspServers } : {}),
            ...(input.notices !== undefined ? { notices: input.notices } : {}),
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            ...(input.credentialSource !== undefined ? { credentialSource: input.credentialSource } : {}),
            ...(input.helpHint !== undefined ? { helpHint: input.helpHint } : {}),
            ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
            showCost: plan.showCost,
          }),
        blockContext(input.capabilities, plan.sidebarWidth),
        { compact: plan.sidebarMode === "compact" },
      )
    : [];

  const live = renderLiveLine(visibleLiveState(input.model), context, input.liveOptions ?? {});
  const status = renderStatusBar(
    statusFromViewModel(input.model, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.git !== undefined ? { git: input.git } : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.permissionDetail !== undefined
        ? { permissionDetail: input.permissionDetail }
        : {}),
      showCost: plan.showCost,
    }),
    context,
    plan,
  );
  const composer =
    options.renderComposer === false
      ? []
      : renderComposer(input.composer, context, plan);

  return {
    input,
    plan,
    context,
    timelineContext,
    timelineTargetWidth,
    overlayOpen,
    twoColumn,
    banner,
    sidebar,
    live,
    status,
    composer,
  };
}

/**
 * Calculate only the row-bounded body viewport. Hosts with a custom composer use
 * this helper to avoid materializing the compatibility `body` and `lines` arrays
 * before they add their own bottom chrome.
 */
export function computePreparedViewport(
  prepared: PreparedScreen,
  viewport: ScreenViewportOptions = {},
): ScreenViewport {
  const { input, timelineContext, timelineTargetWidth } = prepared;
  const timelineRows = viewport.timelineRows ?? input.timelineRows;
  const timelineScrollOffset = Math.max(
    0,
    viewport.timelineScrollOffsetFromBottom ??
      input.timelineScrollOffsetFromBottom ??
      0,
  );
  const maxOffsetHint =
    viewport.timelineMaxScrollOffsetHint ?? input.timelineMaxScrollOffsetHint;
  const timelineOptions = input.timelineOptions ?? {};
  const timelineIsBounded = timelineRows !== undefined && timelineRows > 0;

  let timelineWindow:
    | { readonly lines: StyledLine[]; readonly totalLines?: number }
    | undefined;
  if (timelineRows !== undefined && timelineRows > 0) {
    if (input.timelineProjection !== undefined) {
      input.timelineProjection.sync(input.model.timeline, timelineOptions);
      if (input.streamingViews !== undefined) {
        input.timelineProjection.syncStreamingViews(input.streamingViews);
      }
      timelineWindow = input.timelineProjection.renderWindowDetails(
        timelineContext,
        timelineOptions,
        timelineRows,
        timelineScrollOffset,
      );
    } else {
      timelineWindow = renderTimelineWindowDetails(
        input.model.timeline,
        timelineContext,
        timelineOptions,
        timelineRows,
        timelineScrollOffset,
      );
    }
  }

  let timeline: StyledLine[];
  if (timelineRows === undefined) {
    if (input.timelineProjection !== undefined) {
      input.timelineProjection.sync(input.model.timeline, timelineOptions);
      if (input.streamingViews !== undefined) {
        input.timelineProjection.syncStreamingViews(input.streamingViews);
      }
      timeline = input.timelineProjection.renderAll(timelineContext, timelineOptions);
    } else {
      timeline = renderTimeline(input.model.timeline, timelineContext, timelineOptions);
    }
  } else if (timelineRows <= 0) {
    timeline = [];
  } else {
    timeline = timelineWindow?.lines ?? [];
  }

  const timelineMaxScrollOffset =
    timelineRows !== undefined &&
    timelineRows > 0 &&
    timelineWindow?.totalLines !== undefined
      ? Math.max(0, timelineWindow.totalLines - timelineRows)
      : undefined;

  const visibleTimeline =
    timelineRows === undefined
      ? timeline
      : timelineRows <= 0
        ? []
        : (() => {
            const { start, end } = visibleSlice(
              timeline.length,
              timelineRows,
              timelineScrollOffset,
            );
            return timeline.slice(start, end);
          })();

  const knownTimelineMax = timelineMaxScrollOffset ?? maxOffsetHint;
  const timelineHasOverflow =
    timelineIsBounded &&
    (knownTimelineMax !== undefined
      ? knownTimelineMax > 0
      : timelineScrollOffset > 0 ||
        timeline.length >= Math.max(1, timelineRows ?? 1));
  const timelineWithScrollbar = timelineIsBounded
    ? withTimelineScrollbar(
        visibleTimeline,
        timelineRows ?? 0,
        timelineTargetWidth,
        timelineScrollOffset,
        knownTimelineMax,
        timelineHasOverflow,
        timelineContext.capabilities,
      )
    : visibleTimeline;

  const overlay = prepared.overlayOpen
    ? sliceOverlay(
        input.overlay ?? [],
        viewport.overlayScrollOffset ?? input.overlayScrollOffset ?? 0,
        viewport.overlayRows ?? input.overlayRows ?? input.overlay?.length ?? 0,
      )
    : [];

  return {
    timeline: prepared.overlayOpen ? [] : timelineWithScrollbar,
    overlay,
    ...(timelineMaxScrollOffset !== undefined ? { timelineMaxScrollOffset } : {}),
  };
}

/** Combine prepared chrome with exactly one timeline/overlay viewport pass. */
export function composePreparedScreen(
  prepared: PreparedScreen,
  viewport: ScreenViewportOptions = {},
): Screen {
  const { input, plan, context } = prepared;
  const timelineRows = viewport.timelineRows ?? input.timelineRows;
  const preparedViewport = computePreparedViewport(prepared, viewport);
  const timeline = preparedViewport.timeline;
  const timelineMaxScrollOffset = preparedViewport.timelineMaxScrollOffset;
  const overlay = preparedViewport.overlay;
  const approvalCardLines = input.approvalCard ?? [];
  const visibleBody = prepared.overlayOpen
    ? overlay
    : [
        ...timeline,
        ...(approvalCardLines.length > 0 ? approvalCardLines : []),
        ...(prepared.live.length > 0 ? prepared.live : []),
      ];
  const mainRegion = visibleBody;
  const bodyRows = timelineRows !== undefined ? Math.max(timelineRows, mainRegion.length) : undefined;
  const body = prepared.twoColumn
    ? joinColumns(mainRegion, prepared.sidebar, plan, context, bodyRows)
    : mainRegion;

  const lines: StyledLine[] = [];
  if (prepared.banner.length > 0) lines.push(...prepared.banner, blank());
  lines.push(...body);
  if (!prepared.twoColumn) {
    if (input.approvalCard !== undefined && input.approvalCard.length > 0) {
      lines.push(...input.approvalCard);
    }
    if (prepared.live.length > 0) lines.push(...prepared.live);
  }
  lines.push(...prepared.composer);
  lines.push(...prepared.status);
  lines.push(blank());

  return {
    plan,
    banner: prepared.banner,
    timeline,
    ...(timelineMaxScrollOffset !== undefined ? { timelineMaxScrollOffset } : {}),
    sidebar: prepared.sidebar,
    body,
    live: prepared.live,
    status: prepared.status,
    composer: prepared.composer,
    overlay,
    lines,
  };
}

export function composeScreen(input: ScreenInput): Screen {
  return composePreparedScreen(prepareScreen(input));
}

/**
 * Add a one-cell scrollbar rail to the bounded timeline viewport.
 *
 * The renderer reserves the rail before wrapping timeline content, so the thumb
 * stays flush with the right edge without stealing a column from the sidebar or
 * causing terminal wrapping. When the virtualized renderer has not reached the
 * oldest item yet, the rail uses the current offset as a conservative estimate and
 * settles to the exact size as soon as the maximum offset is known.
 */
function sliceOverlay(
  lines: readonly StyledLine[],
  scrollOffset: number,
  visibleRows: number,
): StyledLine[] {
  const fixedRows = Math.min(2, lines.length);
  const header = lines.slice(0, fixedRows);
  const body = lines.slice(fixedRows);
  const rows = Math.max(0, visibleRows - fixedRows);
  const maxOffset = Math.max(0, body.length - rows);
  const offset = Math.min(Math.max(0, Math.floor(scrollOffset)), maxOffset);
  return [...header, ...body.slice(offset, offset + rows)];
}

function withTimelineScrollbar(
  lines: readonly StyledLine[],
  viewportRows: number,
  targetWidth: number,
  scrollOffsetFromBottom: number,
  knownMaxScrollOffset: number | undefined,
  hasOverflow: boolean,
  capabilities: BlockContext["capabilities"],
): StyledLine[] {
  const rows = Math.max(0, viewportRows);
  if (rows === 0) return [];

  if (!hasOverflow) {
    const visible = lines.slice(0, rows);
    while (visible.length < rows) visible.push(blank());
    return visible;
  }

  const contentWidth = Math.max(1, targetWidth - 1);
  const visible = lines.slice(0, rows);
  while (visible.length < rows) visible.push(blank());

  const maxOffset = Math.max(
    knownMaxScrollOffset ?? 0,
    scrollOffsetFromBottom,
    knownMaxScrollOffset === undefined ? rows : 0,
  );
  const clampedOffset = Math.min(Math.max(0, scrollOffsetFromBottom), maxOffset);
  const totalRows = Math.max(rows, maxOffset + rows);
  const thumbRows = Math.max(1, Math.min(rows, Math.round((rows * rows) / totalRows)));
  const travel = Math.max(0, rows - thumbRows);
  const thumbStart =
    maxOffset <= 0
      ? travel
      : Math.round(((maxOffset - clampedOffset) / maxOffset) * travel);
  const trackGlyph = capabilities.unicode ? "│" : "|";
  const thumbGlyph = capabilities.unicode ? "█" : "#";

  return visible.map((styled, rowIndex) => {
    const fitted = fitTimelineLine(styled, contentWidth);
    const used = lineWidth(fitted);
    const padding = Math.max(0, contentWidth - used);
    const padded =
      padding > 0
        ? [
            ...fitted.segments,
            segment(
              " ".repeat(padding),
              fitted.rowBackground !== undefined ? { bg: fitted.rowBackground } : {},
            ),
          ]
        : [...fitted.segments];
    const thumb = rowIndex >= thumbStart && rowIndex < thumbStart + thumbRows;
    padded.push(
      segment(thumb ? thumbGlyph : trackGlyph, thumb
        ? { fg: "accent.cyan", bold: true }
        : { fg: "fg.muted", dim: true }),
    );
    return line(fitted.kind, padded, fitted.rowBackground);
  });
}

/** Keep a timeline row inside the content columns reserved for it. */
function fitTimelineLine(styled: StyledLine, maxColumns: number): StyledLine {
  let remaining = Math.max(0, maxColumns);
  const fitted: Segment[] = [];
  for (const part of styled.segments) {
    if (remaining <= 0) break;
    const width = stringWidth(part.text);
    if (width <= remaining) {
      fitted.push(part);
      remaining -= width;
      continue;
    }
    fitted.push({ ...part, text: truncateToWidth(part.text, remaining) });
    break;
  }
  return line(styled.kind, fitted, styled.rowBackground);
}

/**
 * Join two columns of styled lines into full-width rows.
 *
 * Both columns are padded to their own width and separated by ` │ `, so every
 * emitted row is exactly `plan.columns` wide. That exactness matters: a row one
 * cell over wraps and shifts the divider on the next redraw, which looks like the
 * whole panel drifting.
 *
 * A row background on a main-column line is applied to that line's own segments
 * plus its padding rather than to the joined row. Left as a row background it would
 * bleed across the divider and tint the sidebar, which is how a subagent card ends
 * up appearing to own the whole screen.
 */
export function joinColumns(
  main: readonly StyledLine[],
  sidebar: readonly StyledLine[],
  plan: Pick<LayoutPlan, "mainWidth" | "sidebarWidth">,
  context: BlockContext,
  minRows?: number,
): StyledLine[] {
  const terminalWidth = Math.max(0, context.columns);
  const glyphs = treeGlyphs(context.capabilities);
  const maxRows = minRows !== undefined ? Math.max(main.length, minRows) : undefined;
  const effectiveSidebar = maxRows !== undefined && sidebar.length > maxRows ? sidebar.slice(0, maxRows) : sidebar;
  const rows = Math.max(main.length, effectiveSidebar.length, minRows ?? 0);
  const out: StyledLine[] = [];

  // A hidden sidebar has zero width. Treat it as a true single-column layout;
  // emitting the divider here used to make every row three cells too wide.
  if (plan.sidebarWidth <= 0) {
    for (let index = 0; index < rows; index += 1) {
      const source = main[index] ?? line("blank", []);
      const fitted = fitTimelineLine(source, terminalWidth);
      const used = lineWidth(fitted);
      const background = fitted.rowBackground;
      const segments = fitted.segments.map((part) =>
        background !== undefined && part.bg === undefined ? { ...part, bg: background } : part,
      );
      if (used < terminalWidth) {
        segments.push(
          segment(
            " ".repeat(terminalWidth - used),
            background !== undefined ? { bg: background } : {},
          ),
        );
      }
      out.push(line(fitted.kind, segments));
    }
    return out;
  }

  for (let index = 0; index < rows; index += 1) {
    const mainLine = main[index];
    const sidebarLine = effectiveSidebar[index];
    const left = mainLine === undefined ? undefined : fitTimelineLine(mainLine, plan.mainWidth);
    const right = sidebarLine === undefined ? undefined : fitTimelineLine(sidebarLine, plan.sidebarWidth);

    const segments: Segment[] = [];
    const leftBackground = left?.rowBackground;

    if (left !== undefined) {
      for (const seg of left.segments) {
        segments.push(leftBackground !== undefined && seg.bg === undefined ? { ...seg, bg: leftBackground } : seg);
      }
    }

    const used = left === undefined ? 0 : lineWidth(left);
    const padding = Math.max(0, plan.mainWidth - used);
    if (padding > 0) {
      segments.push(
        segment(
          " ".repeat(padding),
          leftBackground !== undefined ? { bg: leftBackground } : {},
        ),
      );
    }

    segments.push(segment(` ${glyphs.vertical} `, { fg: "border.warm" }));

    if (right !== undefined) {
      const panel: ThemeToken = "bg.panel";
      for (const seg of right.segments) {
        segments.push(seg.bg === undefined ? { ...seg, bg: panel } : seg);
      }
      const rightUsed = lineWidth(right);
      const rightPad = Math.max(0, plan.sidebarWidth - rightUsed);
      if (rightPad > 0) segments.push(segment(" ".repeat(rightPad), { bg: panel }));
    } else {
      segments.push(segment(" ".repeat(plan.sidebarWidth), { bg: "bg.panel" }));
    }

    // A row with no main-column content is the sidebar overhanging the timeline, so
    // it is labelled as such rather than inheriting a kind it does not carry.
    out.push(fitTimelineLine(line(left?.kind ?? "sidebar", segments), terminalWidth));
  }

  return out;
}

// ---------------------------------------------------------------------------
// §6.20 terminal lifecycle
// ---------------------------------------------------------------------------

/**
 * Escape sequences for entering and leaving the alternate screen.
 *
 * AC-40 requires cursor, echo, and alternate-screen state to be restored on a
 * normal exit, `Ctrl+C`, a worker crash, *and* a host error. The teardown sequence
 * is therefore a plain constant rather than something assembled at exit time: a
 * crash path must not have to compute anything to clean up after itself.
 */
export const TERMINAL_SETUP = {
  enterAlternateScreen: "\u001B[?1049h",
  leaveAlternateScreen: "\u001B[?1049l",
  hideCursor: "\u001B[?25l",
  showCursor: "\u001B[?25h",
  clearScreen: "\u001B[2J\u001B[H",
  resetAttributes: "\u001B[0m",
  /** Bracketed paste, which §6.14 requires. */
  enableBracketedPaste: "\u001B[?2004h",
  disableBracketedPaste: "\u001B[?2004l",
  /** Enable button-drag mouse tracking + SGR encoding. */
  enableMouse: "\u001B[?1003l\u001B[?1002h\u001B[?1006h",
  disableMouse: "\u001B[?1002l\u001B[?1003l\u001B[?1006l",
} as const;

/** The full enter sequence. Mouse tracking is opt-out per config (§21.4
 * `ui.mouse`): when disabled the host terminal keeps its native selection. */
export function enterSequence(options: { mouse?: boolean } = {}): string {
  return [
    TERMINAL_SETUP.enterAlternateScreen,
    TERMINAL_SETUP.enableBracketedPaste,
    ...(options.mouse === false ? [] : [TERMINAL_SETUP.enableMouse]),
    TERMINAL_SETUP.hideCursor,
    TERMINAL_SETUP.clearScreen,
  ].join("");
}

/**
 * The full restore sequence (AC-40).
 *
 * Ordered so each step is safe even if an earlier one never took effect — a crash
 * during startup can emit this whole string without knowing how far it got.
 */
export function restoreSequence(): string {
  return [
    TERMINAL_SETUP.resetAttributes,
    TERMINAL_SETUP.showCursor,
    TERMINAL_SETUP.disableMouse,
    TERMINAL_SETUP.disableBracketedPaste,
    TERMINAL_SETUP.leaveAlternateScreen,
  ].join("");
}

/** §6.20: the terminal title is never changed by default. */
export const ALLOW_TITLE_CHANGE = false;

/**
 * §22.3: render batching between 16 and 33 ms.
 *
 * Returned as a value rather than hard-coded at the call site so the reduced-motion
 * path can slow it down without touching the renderer.
 */
export function renderIntervalMs(capabilities: { reducedMotion: boolean }): number {
  return capabilities.reducedMotion ? 33 : 16;
}

/**
 * §22.3 timeline virtualization: which slice to render for a viewport.
 *
 * §22.3 requires a 10,000-event session to stay scrollable, which means the cost of
 * a frame must depend on the viewport rather than the history length.
 */
export function visibleSlice(
  total: number,
  viewportRows: number,
  scrollOffsetFromBottom: number,
): { start: number; end: number } {
  const rows = Math.max(1, viewportRows);
  const clampedOffset = Math.max(0, Math.min(scrollOffsetFromBottom, Math.max(0, total - rows)));
  const end = total - clampedOffset;
  return { start: Math.max(0, end - rows), end };
}
