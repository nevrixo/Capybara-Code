/**
 * Responsive layout — PRD §6.16, §6.13, §6.21, AC-07.
 *
 * §6.16's four breakpoints, and what each gives up:
 *
 * | Width   | Behaviour                                                        |
 * |---------|------------------------------------------------------------------|
 * | ≥ 120   | full status bar, full task metadata, side-by-side diff metadata   |
 * | 80–119  | the target layout; descriptions truncate, cost and path drop      |
 * | 60–79   | single column; status keeps model, mode, git; keyboard hints hide |
 * | < 60    | runs with a one-time warning; approval and composer take priority |
 *
 * §6.21 adds the right context sidebar on top of that, with its own three-step
 * ladder. The two ladders are separate because they answer different questions:
 * the breakpoints decide *what detail a row can carry*, the sidebar modes decide
 * *whether there is a second column at all*.
 *
 * | Width    | Sidebar                                                        |
 * |----------|----------------------------------------------------------------|
 * | ≥ 120    | full — every widget, one per section                            |
 * | 90–119   | compact — context, cost, and active subagents only              |
 * | < 90     | hidden — `Ctrl+B` brings it back if the width can afford it     |
 */

export type Breakpoint = "compact" | "narrow" | "target" | "wide";

export function breakpointFor(columns: number): Breakpoint {
  if (columns >= 120) return "wide";
  if (columns >= 80) return "target";
  if (columns >= 60) return "narrow";
  return "compact";
}

/** §6.16's warning, shown once when the terminal is below 60 columns. */
export const COMPACT_TERMINAL_WARNING =
  "compact terminal: some detail is hidden below 60 columns";

// ---------------------------------------------------------------------------
// §6.21 two-column grid
// ---------------------------------------------------------------------------

export type SidebarMode = "full" | "compact" | "hidden";

/** §6.21: the sidebar takes 25% of the content width, the timeline 75%. */
export const SIDEBAR_FRACTION = 0.25;
export const MAIN_FRACTION = 1 - SIDEBAR_FRACTION;

/**
 * Cells the divider occupies: one space, one rule, one space.
 *
 * Counted out of the content width before the 75:25 split rather than taken from
 * one side afterwards, so neither column silently pays for the separator.
 */
export const COLUMN_DIVIDER_WIDTH = 3;

/** Below this a sidebar cannot hold a legible label and a value. */
export const MIN_SIDEBAR_WIDTH = 20;

/** Past this the sidebar is only absorbing space the timeline could use. */
export const MAX_SIDEBAR_WIDTH = 40;

/** The timeline stops being readable below this, so the sidebar yields first. */
export const MIN_MAIN_WIDTH = 48;

/** §6.21: the sidebar auto-hides below this width. */
export const SIDEBAR_AUTO_HIDE_COLUMNS = 90;

/** §6.21: every widget is shown from this width up. */
export const SIDEBAR_FULL_COLUMNS = 120;

/** Sidebar hidden when terminal height is too small to show timeline + sidebar. */
export const SIDEBAR_MIN_ROWS = 16;

export interface LayoutPlan {
  readonly breakpoint: Breakpoint;
  readonly columns: number;
  /** §6.16: keyboard hints are hidden below 80 columns. */
  readonly showKeyboardHints: boolean;
  readonly showCost: boolean;
  readonly showWorkspacePath: boolean;
  readonly showReasoning: boolean;
  readonly showContextPercent: boolean;
  readonly showGit: boolean;
  /** §6.10: task descriptions truncate to one line below the wide breakpoint. */
  readonly truncateTaskDescriptions: boolean;
  /** §6.18: hunk metadata side by side only at the wide breakpoint. */
  readonly sideBySideDiffMetadata: boolean;
  readonly warning?: string;
  /** Maximum composer height (§6.14: one line growing to eight). */
  readonly maxComposerLines: number;

  // §6.21 two-column grid.
  readonly sidebarMode: SidebarMode;
  readonly showSidebar: boolean;
  /** Width available to the timeline column. Equals `columns` when hidden. */
  readonly mainWidth: number;
  /** Width available to the sidebar column. Zero when hidden. */
  readonly sidebarWidth: number;
  readonly dividerWidth: number;
}

export interface LayoutOptions {
  /**
   * `Ctrl+B` override. `undefined` follows the width; `true` forces the sidebar on
   * where it fits; `false` forces it off at any width.
   */
  readonly sidebarVisible?: boolean;
  /**
   * §21.4 `ui.showCost` override. `false` hides cost at every width; `true`
   * keeps it wherever the status bar can still fit it. `undefined` follows the
   * breakpoint ladder.
   */
  readonly showCost?: boolean;
  /**
   * §21.4 `ui.statusDensity`. `compact` trims the status surface below what the
   * width would allow; `full` keeps every field the width can carry; `auto`
   * (the default) follows the breakpoint ladder.
   */
  readonly statusDensity?: "auto" | "compact" | "full";
  /** Terminal rows; when below SIDEBAR_MIN_ROWS the sidebar auto-hides. */
  readonly rows?: number;
}

/**
 * Decide the sidebar mode for a width, before the user's own toggle is applied.
 */
export function sidebarModeFor(columns: number): SidebarMode {
  if (columns >= SIDEBAR_FULL_COLUMNS) return "full";
  if (columns >= SIDEBAR_AUTO_HIDE_COLUMNS) return "compact";
  return "hidden";
}

/**
 * Split a width into the two columns.
 *
 * Returns `undefined` when the width cannot hold both — the caller then renders a
 * single column rather than a cramped pair. That is a real case: forcing the
 * sidebar on with `Ctrl+B` in a 70-column terminal has to degrade, and degrading
 * to one column is more useful than two unreadable ones.
 */
export function splitColumns(
  columns: number,
): { mainWidth: number; sidebarWidth: number; dividerWidth: number } | undefined {
  const content = columns - COLUMN_DIVIDER_WIDTH;
  if (content < MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH) return undefined;

  const raw = Math.round(content * SIDEBAR_FRACTION);
  const bounded = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, raw));
  // The timeline is the primary surface, so it wins the last cell of a tie.
  const sidebarWidth = Math.min(bounded, content - MIN_MAIN_WIDTH);
  if (sidebarWidth < MIN_SIDEBAR_WIDTH) return undefined;

  return {
    mainWidth: content - sidebarWidth,
    sidebarWidth,
    dividerWidth: COLUMN_DIVIDER_WIDTH,
  };
}

export function planLayout(columns: number, options: LayoutOptions = {}): LayoutPlan {
  const breakpoint = breakpointFor(columns);
  let base = basePlan(breakpoint, columns);

  if (options.statusDensity === "compact") {
    base = {
      ...base,
      showKeyboardHints: false,
      showReasoning: false,
      showContextPercent: false,
      showWorkspacePath: false,
    };
  } else if (options.statusDensity === "full") {
    base = {
      ...base,
      showKeyboardHints: true,
      showReasoning: true,
      showContextPercent: true,
      showWorkspacePath: true,
      showGit: true,
    };
  }

  if (options.showCost !== undefined) {
    base = { ...base, showCost: options.showCost };
  }

  const tooShort = options.rows !== undefined && options.rows < SIDEBAR_MIN_ROWS;
  if (tooShort) {
    return {
      ...base,
      sidebarMode: "hidden",
      showSidebar: false,
      mainWidth: columns,
      sidebarWidth: 0,
      dividerWidth: 0,
    };
  }

  const auto = sidebarModeFor(columns);
  const requested = options.sidebarVisible;
  const wanted: SidebarMode =
    requested === true
      ? auto === "hidden"
        ? "compact"
        : auto
      : "hidden";

  const split = wanted === "hidden" ? undefined : splitColumns(columns);
  if (split === undefined) {
    return {
      ...base,
      sidebarMode: "hidden",
      showSidebar: false,
      mainWidth: columns,
      sidebarWidth: 0,
      dividerWidth: 0,
    };
  }

  return {
    ...base,
    sidebarMode: wanted,
    showSidebar: true,
    mainWidth: split.mainWidth,
    sidebarWidth: split.sidebarWidth,
    dividerWidth: split.dividerWidth,
  };
}

type BasePlan = Omit<
  LayoutPlan,
  "sidebarMode" | "showSidebar" | "mainWidth" | "sidebarWidth" | "dividerWidth"
>;

function basePlan(breakpoint: Breakpoint, columns: number): BasePlan {
  switch (breakpoint) {
    case "wide":
      return {
        breakpoint,
        columns,
        showKeyboardHints: true,
        showCost: true,
        showWorkspacePath: true,
        showReasoning: true,
        showContextPercent: true,
        showGit: true,
        truncateTaskDescriptions: false,
        sideBySideDiffMetadata: true,
        maxComposerLines: 8,
      };

    case "target":
      return {
        breakpoint,
        columns,
        showKeyboardHints: true,
        // §6.16: cost and path are the first things to go at this width.
        showCost: false,
        showWorkspacePath: false,
        showReasoning: true,
        showContextPercent: true,
        showGit: true,
        truncateTaskDescriptions: true,
        sideBySideDiffMetadata: false,
        maxComposerLines: 8,
      };

    case "narrow":
      return {
        breakpoint,
        columns,
        // §6.16: hints are hidden to reclaim the row.
        showKeyboardHints: false,
        showCost: false,
        showWorkspacePath: false,
        showReasoning: false,
        showContextPercent: false,
        showGit: true,
        truncateTaskDescriptions: true,
        sideBySideDiffMetadata: false,
        maxComposerLines: 6,
      };

    case "compact":
      return {
        breakpoint,
        columns,
        showKeyboardHints: false,
        showCost: false,
        showWorkspacePath: false,
        showReasoning: false,
        showContextPercent: false,
        showGit: false,
        truncateTaskDescriptions: true,
        sideBySideDiffMetadata: false,
        warning: COMPACT_TERMINAL_WARNING,
        // Approval and the composer take priority, so the composer stays small.
        maxComposerLines: 4,
      };
  }
}

/**
 * §6.13's responsive priority, highest first.
 *
 * The order is the PRD's, and it is not arbitrary: the model and mode determine
 * what will happen to your workspace, so they outrank cost and path, which are
 * merely informative.
 */
export const STATUS_FIELD_PRIORITY = [
  "model",
  "mode",
  "activeState",
  "gitBranch",
  "contextPercent",
  "reasoning",
  "usage",
  "workspacePath",
] as const;

export type StatusField = (typeof STATUS_FIELD_PRIORITY)[number];

/**
 * Choose which status fields fit.
 *
 * Fields are dropped from the lowest priority upward until the row fits, which is
 * what AC-07 checks: at any width the bar shows the highest-priority fields it can.
 */
export function fitStatusFields(
  widths: Readonly<Partial<Record<StatusField, number>>>,
  columns: number,
  separatorWidth: number,
): StatusField[] {
  const present = STATUS_FIELD_PRIORITY.filter((field) => (widths[field] ?? 0) > 0);

  for (let dropped = 0; dropped <= present.length; dropped += 1) {
    const kept = present.slice(0, present.length - dropped);
    if (kept.length === 0) return [];
    const total =
      kept.reduce((sum, field) => sum + (widths[field] ?? 0), 0) +
      separatorWidth * Math.max(0, kept.length - 1);
    if (total <= columns) {
      // Restore the PRD's declaration order for display.
      return STATUS_FIELD_PRIORITY.filter((field) => kept.includes(field));
    }
  }
  return [];
}
