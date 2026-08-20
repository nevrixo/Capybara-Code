/**
 * Persistent chrome — PRD §6.12, §6.13, §6.14, §6.15, AC-07, AC-45.
 *
 * §6.3 fixes three layers on screen: the timeline, one live-state line, and the
 * status bar plus composer. Everything else is a temporary overlay. This module owns
 * the two fixed ones.
 */

import type {
  LiveState,
  PlanItem,
  SessionViewModel,
  TimelineJob,
  TimelineTask,
  UsageTotals,
} from "@cbc/session-domain";

import { fitStatusFields, type LayoutPlan, type StatusField } from "./layout.ts";
import { sanitizeInline } from "./sanitize.ts";
import { blank, fitLine, line, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import { icon, treeGlyphs, type ThemeToken } from "./theme.ts";
import { graphemeWidth, graphemes, stringWidth, truncateMiddle, truncateToWidth } from "./width.ts";

// ---------------------------------------------------------------------------
// §6.12 live state line
// ---------------------------------------------------------------------------

/**
 * §6.12 spinner frames. Only used when motion is allowed.
 *
 * Keep the animation in one visual family. The previous sequence switched from
 * geometric dots to braille halfway through a cycle, which made the live rail
 * appear to jump even though the frame index advanced normally.
 */
export const SPINNER_FRAMES: readonly string[] = [
  "\u280b", // ⠋
  "\u2819", // ⠙
  "\u2839", // ⠹
  "\u2838", // ⠸
  "\u283c", // ⠼
  "\u2834", // ⠴
  "\u2826", // ⠦
  "\u2827", // ⠧
  "\u2807", // ⠇
  "\u280f", // ⠏
];
/** §6.12: 25 FPS keeps the activity rail fluid without saturating ANSI redraws. */
export const SPINNER_INTERVAL_MS = 40;

export interface LiveLineOptions {
  /** Animation frame counter. Ignored under reduced motion. */
  readonly frame?: number;
  readonly interruptHint?: string;
}

/**
 * Derive the state users should see in the live rail. A detached process or
 * subagent can still be running after its parent turn reaches a terminal state;
 * that work must not make the session look idle.
 */
export function visibleLiveState(
  model: Pick<SessionViewModel, "live" | "activeTasks" | "activeJobs">,
): LiveState {
  const { live } = model;
  if (
    live.kind === "working" ||
    live.kind === "waiting_for_task" ||
    live.kind === "running_tests" ||
    live.kind === "awaiting_approval"
  ) {
    return live;
  }

  if (model.activeTasks.length === 0 && model.activeJobs.length === 0) return live;
  return {
    kind: "working",
    label: backgroundActivityLabel(model.activeTasks, model.activeJobs),
  };
}

/** A live state is active even when a provider intentionally omits its label. */
export function liveStateLabel(live: LiveState): string {
  const label = live.label.trim();
  // Legacy reducers and restored snapshots may still carry a provider-channel
  // label. Channel names are provenance, not user-facing lifecycle states.
  if (/^Reasoning(?: summary)?(?:\.\.\.|…)?$/u.test(label)) return "Thinking...";
  if (label.length > 0) return label;
  switch (live.kind) {
    case "working":
      return "Working...";
    case "waiting_for_task":
      return "Waiting for task...";
    case "running_tests":
      return "Running tests...";
    case "awaiting_approval":
      return "Approval required";
    case "complete":
      return "Turn complete";
    case "partial":
      return "Turn paused";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "idle":
      return "";
  }
}

function backgroundActivityLabel(
  tasks: readonly TimelineTask[],
  jobs: readonly TimelineJob[],
): string {
  if (tasks.length === 0 && jobs.length === 1) {
    const display = sanitizeInline(jobs[0]?.display ?? "", 200).trim();
    return display.length > 0 ? `Background job running: ${display}` : "Background job running...";
  }
  if (tasks.length === 1 && jobs.length === 0) {
    const task = tasks[0];
    const title =
      sanitizeInline(task?.title ?? "", 200).trim() ||
      sanitizeInline(task?.role ?? "", 80).trim() ||
      "Background task";
    return `${title} running...`;
  }

  const parts: string[] = [];
  if (tasks.length > 0) {
    parts.push(`${tasks.length} background task${tasks.length === 1 ? "" : "s"}`);
  }
  if (jobs.length > 0) {
    parts.push(`${jobs.length} background job${jobs.length === 1 ? "" : "s"}`);
  }
  return `${parts.join(" and ")} running...`;
}

/**
 * §6.12: one line for the current state, removed entirely when idle so the
 * composer gets the row back.
 *
 * Under reduced motion or for a screen reader the spinner is a static icon — §6.12
 * requires it, and an animating character is noise to a reader that re-announces
 * the line on every change.
 */
export function renderLiveLine(
  live: LiveState,
  context: BlockContext,
  options: LiveLineOptions = {},
): StyledLine[] {
  if (live.kind === "idle") return [];

  const spinning = live.kind === "working" || live.kind === "waiting_for_task" || live.kind === "running_tests";
  const label = liveStateLabel(live);
  const frame = Math.trunc(options.frame ?? 0);
  const frameIndex = ((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  const glyph =
    spinning && !context.capabilities.reducedMotion && context.capabilities.unicode
      ? (SPINNER_FRAMES[frameIndex] as string)
      : liveIcon(live, context);

  const token = liveToken(live);
  const phase = livePhase(live);
  const segments: Segment[] = [
    segment(`${glyph} `, { fg: token, bold: spinning }),
    segment(`[${phase}] `, { fg: token, bold: true }),
    segment("> ", { fg: "border.warm" }),
    segment(label, { fg: token, bold: live.kind === "awaiting_approval" }),
  ];

  const hint = options.interruptHint ?? live.interruptHint;
  if (hint !== undefined && hint.length > 0) {
    segments.push(segment(` [${hint}]`, { fg: "accent.cyan" }));
  }

  return [fitLine("live", segments, context)];
}

function livePhase(live: LiveState): string {
  switch (live.kind) {
    case "working":
      return "RUN";
    case "waiting_for_task":
      return "WAIT";
    case "running_tests":
      return "TEST";
    case "awaiting_approval":
      return "AUTH";
    case "complete":
      return "DONE";
    case "partial":
      return "PARTIAL";
    case "cancelled":
      return "STOP";
    case "failed":
      return "FAIL";
    default:
      return "LIVE";
  }
}

function liveIcon(live: LiveState, context: BlockContext): string {
  switch (live.kind) {
    case "awaiting_approval":
      return icon("warning", context.capabilities);
    case "complete":
      return icon("success", context.capabilities);
    case "partial":
      return icon("warning", context.capabilities);
    case "failed":
    case "cancelled":
      return icon("error", context.capabilities);
    case "waiting_for_task":
      return icon("task", context.capabilities);
    default:
      return icon("working", context.capabilities);
  }
}

function liveToken(live: LiveState): ThemeToken {
  switch (live.kind) {
    case "awaiting_approval":
      return "accent.amber";
    case "complete":
      return "accent.green";
    case "partial":
      return "accent.amber";
    case "failed":
    case "cancelled":
      return "accent.red";
    default:
      return "accent.coral";
  }
}

/** §6.12's completion line: "Turn complete · 3 files changed · 12 tests passed". */
export function turnCompleteLabel(input: {
  filesChanged: number;
  testsPassed?: number;
  testsFailed?: number;
}): string {
  const parts = [`${input.filesChanged} file${input.filesChanged === 1 ? "" : "s"} changed`];
  if (input.testsFailed !== undefined && input.testsFailed > 0) {
    parts.push(`${input.testsFailed} test${input.testsFailed === 1 ? "" : "s"} failed`);
  } else if (input.testsPassed !== undefined && input.testsPassed > 0) {
    parts.push(`${input.testsPassed} test${input.testsPassed === 1 ? "" : "s"} passed`);
  }
  return `Turn complete · ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// §6.13 status bar
// ---------------------------------------------------------------------------

export interface GitStatusView {
  readonly branch: string;
  readonly added: number;
  readonly deleted: number;
  readonly untracked?: number;
  readonly dirty?: boolean;
}

export interface StatusBarInput {
  readonly provider: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly interactionMode?: "build" | "plan";
  readonly pendingInteractionMode?: "build" | "plan";
  readonly permissionDetail?: string;
  readonly permissionPreset?: string;
  readonly reasoning: string;
  readonly contextUsedTokens: number;
  readonly contextBudgetTokens: number;
  readonly git?: GitStatusView;
  readonly usage?: UsageTotals;
  readonly workspacePath?: string;
  /** Current live state, folded into the bar when it is short (§6.13). */
  readonly activeState?: string;
  readonly showCost?: boolean;
}

/**
 * §6.13's status bar.
 *
 * Fields are built, measured, then dropped from the lowest §6.13 priority upward
 * until the row fits. AC-07 asks that the bar "shows the core fields that fit the
 * width", which is only meaningful if the drop order is the documented one.
 */
export function renderStatusBar(
  input: StatusBarInput,
  context: BlockContext,
  plan: LayoutPlan,
): StyledLine[] {
  const fields = buildStatusFields(input, context, plan);
  const separator = " │ ";
  const separatorWidth = stringWidth(separator);

  const widths: Partial<Record<StatusField, number>> = {};
  for (const [field, segments] of Object.entries(fields) as Array<[StatusField, Segment[]]>) {
    widths[field] = segments.reduce((sum, s) => sum + stringWidth(s.text), 0);
  }

  const kept = fitStatusFields(widths, plan.columns, separatorWidth);
  if (kept.length === 0) {
    return [
      fitLine("status", [segment(truncateToWidth(input.model, Math.max(1, plan.columns)), { fg: "accent.coral" })], context),
    ];
  }

  const segments: Segment[] = [];
  kept.forEach((field, index) => {
    if (index > 0) segments.push(segment(separator, { fg: "border.warm" }));
    segments.push(...(fields[field] ?? []));
  });

  return [fitLine("status", segments, context)];
}

function buildStatusFields(
  input: StatusBarInput,
  context: BlockContext,
  plan: LayoutPlan,
): Partial<Record<StatusField, Segment[]>> {
  const fields: Partial<Record<StatusField, Segment[]>> = {};

  fields.model = [
    segment(`${icon("active", context.capabilities)} `, { fg: "accent.green" }),
    segment(`${input.provider} · `, { fg: "fg.muted" }),
    segment(input.model, { fg: "fg.primary", bold: true }),
  ];

  const mode = input.interactionMode === undefined
    ? input.permissionMode
    : input.interactionMode === "plan" ? "Plan" : "Build";
  const configuredPermission = input.permissionPreset ?? input.permissionMode;
  // CBC supplies the live effective policy as a compact detail label. When it
  // is canonical, let it drive the mode badge so session overrides or
  // restricted presets cannot leave the bar showing stale config.
  const detailLabel = input.permissionDetail?.trim();
  const hasCanonicalDetailLabel = detailLabel !== undefined &&
    /^(?:RO · )?(?:READ|EDIT|AUTO|YOLO|CUSTOM)$/i.test(detailLabel);
  const effectivePermission = hasCanonicalDetailLabel ? detailLabel : configuredPermission;
  // Plan is a hard read-only ceiling regardless of the configured preset. Show
  // the effective authority rather than implying that legacy `ask` or `auto`
  // can enable writes while Plan is active.
  const permission = input.interactionMode === "plan" ? "READ" : effectivePermission;
  const modeLabel = `${mode} · ${permission}`;
  fields.mode = [
    segment(modeLabel, { fg: "accent.cyan" }),
    ...(input.pendingInteractionMode !== undefined
      ? [segment(` -> ${input.pendingInteractionMode === "plan" ? "Plan" : "Build"} next`, { fg: "accent.amber" })]
      : []),
    ...(input.permissionDetail !== undefined && input.permissionDetail.length > 0 &&
      !hasCanonicalDetailLabel && input.interactionMode !== "plan"
      ? renderPermissionDetail(input.permissionDetail)
      : []),
  ];

  if (input.activeState !== undefined && input.activeState.length > 0) {
    fields.activeState = [segment(sanitizeInline(input.activeState, 40), { fg: "accent.cyan" })];
  }

  if (plan.showGit && input.git !== undefined) {
    const git = input.git;
    const parts: Segment[] = [
      segment(`${icon("git", context.capabilities)} `, { fg: "fg.muted" }),
      segment(truncateToWidth(git.branch, 24), { fg: "fg.primary" }),
      segment(` +${git.added}`, { fg: "accent.green" }),
      segment(` -${git.deleted}`, { fg: "accent.red" }),
    ];
    if (git.untracked !== undefined && git.untracked > 0) {
      parts.push(segment(` ?${git.untracked}`, { fg: "accent.amber" }));
    } else if (git.dirty === true) {
      // §6.13 lists dirty state; the marker keeps it visible with no colour.
      parts.push(segment(" *", { fg: "accent.amber" }));
    }
    fields.gitBranch = parts;
  }

  if (plan.showContextPercent && input.contextBudgetTokens > 0) {
    // §6.13: the percentage is against the configured soft budget (§10.10), not the
    // model's window.
    const percent = (input.contextUsedTokens / input.contextBudgetTokens) * 100;
    const token: ThemeToken =
      percent >= 90 ? "accent.red" : percent >= 70 ? "accent.amber" : "accent.cyan";
    fields.contextPercent = [segment(`${percent.toFixed(1)}%`, { fg: token })];
  }

  if (plan.showReasoning) {
    fields.reasoning = [segment(input.reasoning, { fg: "fg.muted" })];
  }

  const usage = input.usage;
  if (usage !== undefined) {
    const tokens = usage.inputTokens + usage.outputTokens;
    const parts: Segment[] = [segment(`${tokens.toLocaleString("en-US")}t`, { fg: "fg.muted" })];
    if (plan.showCost && input.showCost !== false) {
      // §23.7: an estimate, never presented as a bill.
      parts.push(segment(` · $${usage.estimatedCostUsd.toFixed(2)}`, { fg: "fg.muted" }));
    }
    fields.usage = parts;
  }

  if (plan.showWorkspacePath && input.workspacePath !== undefined) {
    fields.workspacePath = [
      segment(compactPath(input.workspacePath, 30), { fg: "fg.muted" }),
    ];
  }

  return fields;
}

/** Build status bar input from a view model. */
export function statusFromViewModel(
  model: SessionViewModel,
  extras: {
    provider?: string;
    git?: GitStatusView;
    workspacePath?: string;
    showCost?: boolean;
    permissionDetail?: string;
  } = {},
): StatusBarInput {
  const live = visibleLiveState(model);
  const showActiveState = live.kind !== "idle" && live.kind !== "complete";
  return {
    provider: extras.provider ?? "OpenAI",
    model: model.modelId,
    permissionMode: model.permissionMode,
    interactionMode: model.modeState.selected,
    ...(model.modeState.pending === undefined ? {} : { pendingInteractionMode: model.modeState.pending }),
    ...(model.permissionPreset !== undefined ? { permissionPreset: model.permissionPreset } : {}),
    ...(extras.permissionDetail !== undefined
      ? { permissionDetail: extras.permissionDetail }
      : {}),
    reasoning: model.reasoningEffort,
    contextUsedTokens: model.contextUsedTokens,
    contextBudgetTokens: model.contextBudgetTokens,
    ...(extras.git !== undefined ? { git: extras.git } : {}),
    usage: model.usage,
    ...(extras.workspacePath !== undefined ? { workspacePath: extras.workspacePath } : {}),
    ...(showActiveState ? { activeState: liveStateLabel(live) } : {}),
    ...(extras.showCost !== undefined ? { showCost: extras.showCost } : {}),
  };
}

function renderPermissionDetail(detail: string): Segment[] {
  const v = detail.trim().toLowerCase();
  let token: import("./theme.ts").ThemeToken = "fg.muted";
  if (v === "read" || v === "ro · read") token = "accent.cyan";
  else if (v === "edit" || v === "ro · edit") token = "accent.amber";
  else if (v === "auto" || v === "ro · auto") token = "accent.green";
  else if (v === "yolo" || v === "ro · yolo") token = "accent.red";
  else if (v.startsWith("ro · ")) token = "fg.muted";
  return [segment(" ", {}), segment(detail, { fg: token })];
}

/** Shorten a path for the status bar, keeping the tail that identifies it. */
export function compactPath(path: string, maxWidth: number): string {
  const normalized = path.replace(/\\/g, "/");
  if (stringWidth(normalized) <= maxWidth) return normalized;

  const parts = normalized.split("/").filter((p) => p.length > 0);
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
    const candidate = `…/${parts.slice(parts.length - keep).join("/")}`;
    if (stringWidth(candidate) <= maxWidth) return candidate;
  }
  return truncateToWidth(parts.at(-1) ?? normalized, maxWidth);
}

// ---------------------------------------------------------------------------
// §6.14 composer
// ---------------------------------------------------------------------------

export interface ComposerState {
  readonly text: string;
  /** Caret position, in grapheme clusters (§6.6, AC-05). */
  readonly cursor: number;
  readonly placeholder?: string;
  /** True while a turn is running; §6.14 allows drafting the next prompt. */
  readonly busy?: boolean;
  /** §6.14: a masked component for a secret, so a key never reaches the screen. */
  readonly masked?: boolean;
  readonly metrics?: ComposerMetricsView;
}

export interface ComposerMetricsView {
  readonly revision: number;
  readonly graphemes: readonly string[];
}

export interface ComposerLayout {
  readonly revision: number;
  readonly columns: number;
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly visibleStart: number;
}

/** §6.14's hint row. */
export const COMPOSER_HINT = "@: Files/folders · Ctrl+P: Commands · Shift+Enter: New line";

export function renderComposer(
  state: ComposerState,
  context: BlockContext,
  plan: LayoutPlan,
): StyledLine[] {
  const prompt = "> ";
  const available = Math.max(8, context.columns - stringWidth(prompt) - 2);

  if (state.text.length === 0) {
    const hint = state.placeholder ?? "Ask anything...";
    const segments: Segment[] = [
      segment(prompt, { fg: "accent.cyan", bold: true }),
      segment(hint, { fg: "fg.muted", italic: true }),
    ];
    if (plan.showKeyboardHints) {
      const room = available - stringWidth(hint) - 2;
      if (room >= stringWidth(COMPOSER_HINT)) {
        segments.push(segment("  ", {}), segment(COMPOSER_HINT, { fg: "fg.muted" }));
      }
    }
    return [line("composer", segments)];
  }

  // §6.14: a masked field never renders its content, not even truncated.
  const body = state.masked === true ? "•".repeat(Math.min(48, state.text.length)) : state.text;

  const wrapped = wrapComposer(
    body,
    available,
    plan.maxComposerLines,
    state.masked === true ? undefined : state.metrics,
  );
  const isBusy = state.busy === true;
  return wrapped.map((text, index) => {
    const promptStyle: import("./segments.ts").SegmentStyle = isBusy
      ? { fg: "fg.muted", bold: index === 0, dim: true }
      : { fg: "accent.cyan", bold: index === 0 };
    return line(
      "composer",
      [
        segment(index === 0 ? prompt : "  ", promptStyle),
        ...composerBodySegments(text, isBusy),
      ],
      isBusy ? "bg.panel" : undefined,
    );
  });
}

/**
 * Split a composer row into segments so paste-token placeholders stand out.
 *
 * `[Image N]` and `[Text N]` are rendered with the accent colour so the user
 * can see at a glance where a paste was collapsed into a token. Everything
 * around them keeps the default composer foreground.
 */
function composerBodySegments(text: string, busy = false): Segment[] {
  const baseStyle: import("./segments.ts").SegmentStyle = busy ? { fg: "fg.muted", dim: true } : { fg: "fg.primary" };
  const chipStyle: import("./segments.ts").SegmentStyle = busy ? { fg: "fg.muted", dim: true } : { fg: "accent.coral", bold: true };
  if (text.length === 0) return [segment("", baseStyle)];
  const pattern = /\[(?:paste #\d+ \+\d+ lines|Image\s+\d+|Text\s+\d+)\]/g;
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push(segment(text.slice(lastIndex, start), baseStyle));
    }
    segments.push(segment(match[0], chipStyle));
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push(segment(text.slice(lastIndex), baseStyle));
  }
  return segments;
}

/**
 * Wrap composer text, growing to `maxLines` then showing the tail.
 *
 * §6.14 grows from one line to eight. Past that the *end* is shown, because that is
 * where the caret is and where the user is typing.
 */
export function wrapComposer(
  text: string,
  columns: number,
  maxLines: number,
  metrics?: ComposerMetricsView,
): string[] {
  const lines: string[] = [];
  const widthLimit = Math.max(1, columns);

  // Walk grapheme clusters once. Measuring every prefix and cutting by UTF-16
  // code units made long input quadratic and could split an IME composition
  // cluster between two rows.
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    let currentWidth = 0;
    const clusters = metrics !== undefined && text.indexOf("\n") < 0
      ? metrics.graphemes
      : graphemes(paragraph);
    for (const cluster of clusters) {
      const clusterWidth = graphemeWidth(cluster);
      if (current.length > 0 && currentWidth + clusterWidth > widthLimit) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      current += cluster;
      currentWidth += clusterWidth;
    }
    lines.push(current);
  }
  return lines.length <= maxLines ? lines : lines.slice(lines.length - maxLines);
}

/** Shared wrapping/cursor result for the renderer and hardware-cursor resolver. */
export function layoutComposer(
  text: string,
  cursor: number,
  columns: number,
  maxLines: number,
  metrics?: ComposerMetricsView,
): ComposerLayout {
  const rows = wrapComposer(text, columns, maxLines, metrics);
  const clusters = metrics?.graphemes ?? graphemes(text);
  const target = Math.max(0, Math.min(cursor, clusters.length));
  const width = Math.max(1, columns);
  let row = 0;
  let column = 0;
  let cursorRow = 0;
  let cursorColumn = 0;
  for (let index = 0; index < clusters.length; index += 1) {
    if (index === target) {
      cursorRow = row;
      cursorColumn = column;
    }
    const cluster = clusters[index] as string;
    if (cluster === "\n") {
      row += 1;
      column = 0;
      continue;
    }
    const clusterWidth = graphemeWidth(cluster);
    if (column > 0 && column + clusterWidth > width) {
      row += 1;
      column = 0;
    }
    column += clusterWidth;
  }
  if (target === clusters.length) {
    cursorRow = row;
    cursorColumn = column;
  }
  const visibleStart = Math.max(0, row + 1 - Math.max(1, maxLines));
  return {
    revision: metrics?.revision ?? 0,
    columns: width,
    rows,
    cursorRow: Math.max(0, cursorRow - visibleStart),
    cursorColumn,
    visibleStart,
  };
}

// ---------------------------------------------------------------------------
// §6.21 right context sidebar
// ---------------------------------------------------------------------------

/** An external service whose reachability the sidebar reports. */
export interface SidebarService {
  readonly name: string;
  readonly state: "ready" | "starting" | "degraded" | "down" | "disabled";
  readonly detail?: string;
}

/** One running child, as the sidebar summarizes it. */
export interface SidebarSubagent {
  readonly role: string;
  readonly title?: string;
  readonly state: TimelineTask["state"];
  readonly elapsedMs?: number;
  /** Total tool calls observed, including calls omitted from the resident tree. */
  readonly toolUses?: number;
  /** Accumulated input and output tokens attributed to this subagent. */
  readonly tokens?: number;
  /** Whether the token total includes the current request's input estimate. */
  readonly tokensEstimated?: boolean;
  /** What it is doing right now, e.g. `writing demo.py`. */
  readonly activity?: string;
}

export interface SidebarInput {
  /** The goal of the current turn, shown as the panel's title. */
  readonly title?: string;
  readonly contextUsedTokens: number;
  readonly contextBudgetTokens: number;
  readonly usage?: UsageTotals;
  readonly subagents: readonly SidebarSubagent[];
  readonly todo: readonly PlanItem[];
  readonly mcpServers?: readonly SidebarService[];
  readonly lspServers?: readonly SidebarService[];
  /** §23.7: an estimate, so it can be suppressed on a plan-billed session. */
  readonly showCost?: boolean;
  readonly notices?: readonly string[];
  readonly sessionId?: string;
  readonly credentialSource?: string;
  readonly helpHint?: string;
}

/** How many todo rows the panel will show before summarizing the rest. */
export const SIDEBAR_MAX_TODO_ROWS = 6;

/** How many subagent rows the panel will show before summarizing the rest. */
export const SIDEBAR_MAX_SUBAGENT_ROWS = 3;

/** Width of the context gauge, in cells. */
export const SIDEBAR_GAUGE_WIDTH = 10;

/**
 * §6.21's right context sidebar.
 *
 * The panel answers the four questions a long turn keeps raising and the timeline
 * cannot answer without being scrolled: how much budget is left, what it has cost,
 * which children are running, and what is still outstanding. Every widget is a
 * projection of the view model — nothing here holds state of its own, so the panel
 * stays correct across replay and resume (§20.8).
 *
 * `compact` drops the plan and the service rows rather than shrinking every widget.
 * Halving each section produces four unreadable sections; dropping two keeps the
 * remaining ones honest.
 */
export function renderRightSidebar(
  input: SidebarInput,
  context: BlockContext,
  options: { compact?: boolean } = {},
): StyledLine[] {
  const compact = options.compact === true;
  const width = Math.max(1, context.columns);
  const glyphs = treeGlyphs(context.capabilities);
  const lines: StyledLine[] = [];

  const fit = (text: string, style: Segment): StyledLine =>
    line("sidebar", [{ ...style, text: truncateToWidth(text, width) }]);

  const heading = (text: string): void => {
    if (lines.length > 0) lines.push(blank());
    lines.push(fit(text, segment("", { fg: "fg.primary", bold: true })));
  };

  if (input.title !== undefined && input.title.length > 0) {
    const rawTitle = sanitizeInline(input.title, 200);
    const displayTitle = stringWidth(rawTitle) > width ? truncateMiddle(rawTitle, width) : rawTitle;
    lines.push(fit(displayTitle, segment("", { fg: "accent.coral", bold: true })));
    lines.push(
      line("sidebar", [segment(glyphs.horizontal.repeat(width), { fg: "border.warm" })]),
    );
  }

  // --- Context and cost ---------------------------------------------------
  // This is the usable *input* budget: the model's maximum output is reserved
  // before the request is built, so it is intentionally lower than the full
  // model context window shown in /context.
  heading("Context (input budget)");
  const percent =
    input.contextBudgetTokens > 0
      ? Math.min(100, (input.contextUsedTokens / input.contextBudgetTokens) * 100)
      : 0;
  const budgetToken: ThemeToken =
    percent >= 90 ? "accent.red" : percent >= 70 ? "accent.amber" : "accent.cyan";

  lines.push(
    fitLine(
      "sidebar",
      [
        segment("  ", {}),
        segment(
          `${formatTokens(input.contextUsedTokens)} / ${formatTokens(input.contextBudgetTokens)}`,
          { fg: "fg.primary" },
        ),
        // AC-45: the number carries the state; the gauge below is reinforcement.
        segment(` (${percent.toFixed(0)}%)`, { fg: budgetToken }),
      ],
      context,
    ),
  );
  lines.push(
    line("sidebar", [
      segment("  ", {}),
      segment(renderGauge(percent, Math.min(SIDEBAR_GAUGE_WIDTH, Math.max(4, width - 4)), context), {
        fg: budgetToken,
      }),
    ]),
  );

  const usage = input.usage;
  if (usage !== undefined) {
    if (input.showCost !== false) {
      // §23.7: an estimate, and it says so.
      lines.push(
        fit(`  $${usage.estimatedCostUsd.toFixed(4)} est.`, segment("", { fg: "fg.muted" })),
      );
    }
  }

  // --- Active subagents ---------------------------------------------------
  heading(`Active Subagents (${input.subagents.length})`);
  if (input.subagents.length === 0) {
    lines.push(fit("  none", segment("", { fg: "fg.muted" })));
  } else {
    const shown = input.subagents.slice(0, SIDEBAR_MAX_SUBAGENT_ROWS);
    for (const agent of shown) {
      const token: ThemeToken =
        agent.state === "failed" || agent.state === "cancelled"
          ? "accent.red"
          : agent.state === "waiting" || agent.state === "blocked"
            ? "accent.amber"
            : agent.state === "completed"
              ? "accent.green"
              : "accent.coral";
      const glyph =
        agent.state === "completed"
          ? "success"
          : agent.state === "failed" || agent.state === "cancelled"
            ? "error"
            : "task";

      const head: Segment[] = [
        segment("  ", {}),
        segment(`${icon(glyph, context.capabilities)} `, { fg: token }),
        segment("Subagent", { fg: "fg.muted", bold: true }),
        segment(` \u00b7 ${agent.role}`, { fg: "fg.primary" }),
      ];
      if (agent.elapsedMs !== undefined) {
        head.push(segment(` (${formatCompactDuration(agent.elapsedMs)})`, { fg: "fg.muted" }));
      }
      lines.push(fitLine("sidebar", head, context));

      const metrics: string[] = [sidebarTaskStateLabel(agent.state)];
      if (agent.toolUses !== undefined) {
        metrics.push(`${agent.toolUses} tools`);
      }
      lines.push(
        fitLine(
          "sidebar",
          [
            segment(`    ${agent.activity !== undefined ? glyphs.branch : glyphs.last} `, {
              fg: "border.warm",
            }),
            segment(metrics.join(" \u00b7 "), { fg: token, bold: true }),
          ],
          context,
        ),
      );
      if (agent.tokens !== undefined) {
        lines.push(
          fitLine(
            "sidebar",
            [
              segment(`    ${agent.activity !== undefined ? glyphs.gutter : glyphs.last} `, {
                fg: "border.warm",
              }),
              segment(
                `${agent.tokensEstimated === true ? "~" : ""}${formatTokens(agent.tokens)} tokens`,
                { fg: "fg.muted" },
              ),
            ],
            context,
          ),
        );
      }
      if (agent.activity !== undefined && agent.activity.length > 0) {
        lines.push(
          fitLine(
            "sidebar",
            [
              segment(`    ${glyphs.last} `, { fg: "border.warm" }),
              segment(sanitizeInline(agent.activity, 120), { fg: "fg.muted" }),
            ],
            context,
          ),
        );
      }
    }
    const hidden = input.subagents.length - shown.length;
    if (hidden > 0) {
      lines.push(fit(`  +${hidden} more`, segment("", { fg: "fg.muted" })));
    }
  }

  if (compact) return lines;

  // --- Todo ---------------------------------------------------------------
  if (input.todo.length > 0) {
    const done = input.todo.filter((t) => t.status === "done").length;
    const total = input.todo.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    heading(`Todo  ${done}/${total} · ${pct}%`);
    lines.push(line("sidebar", [segment("  ", {}), segment(renderGauge(pct, Math.min(10, Math.max(4, width - 6)), context), { fg: done === total ? "accent.green" : "accent.cyan" })]));
    const shown = input.todo.slice(0, SIDEBAR_MAX_TODO_ROWS);
    for (const entry of shown) {
      const box = todoBox(entry.status);
      const token: ThemeToken =
        entry.status === "done"
          ? "accent.green"
          : entry.status === "active"
            ? "accent.coral"
            : entry.status === "blocked"
              ? "accent.amber"
              : "fg.muted";
      lines.push(
        fitLine(
          "sidebar",
          [
            segment("  ", {}),
            segment(`${box} `, { fg: token }),
            segment(sanitizeInline(entry.text, 120), {
              fg: entry.status === "done" ? "fg.muted" : "fg.primary",
            }),
          ],
          context,
        ),
      );
    }
    const hidden = input.todo.length - shown.length;
    if (hidden > 0) {
      lines.push(fit(`  +${hidden} more`, segment("", { fg: "fg.muted" })));
    }
  }

  // --- MCP and LSP --------------------------------------------------------
  for (const [label, services] of [
    ["MCP", input.mcpServers ?? []],
    ["LSP", input.lspServers ?? []],
  ] as const) {
    heading(label);
    if (services.length === 0) {
      lines.push(fit("  none", segment("", { fg: "fg.muted" })));
    } else {
      for (const service of services) {
        lines.push(fitLine("sidebar", serviceSegments(service, context), context));
      }
    }
  }

  // --- Session & Commands -------------------------------------------------
  if (input.sessionId !== undefined || input.credentialSource !== undefined) {
    if (lines.length > 0) lines.push(blank());
    const sessionStr = input.sessionId ? `Session ${input.sessionId}` : "";
    const credStr = input.credentialSource ? `credential ${input.credentialSource}` : "";
    const fullLine = sessionStr && credStr ? `${sessionStr} · ${credStr}` : `${sessionStr}${credStr}`;
    if (stringWidth(fullLine) <= width - 2) {
      lines.push(
        fitLine(
          "sidebar",
          [
            segment("  ", {}),
            segment(fullLine, { fg: "fg.muted" }),
          ],
          context,
        ),
      );
    } else {
      if (sessionStr) {
        lines.push(
          fitLine(
            "sidebar",
            [
              segment("  ", {}),
              segment(truncateToWidth(sessionStr, Math.max(8, width - 2)), { fg: "fg.muted" }),
            ],
            context,
          ),
        );
      }
      if (credStr) {
        lines.push(
          fitLine(
            "sidebar",
            [
              segment("  ", {}),
              segment(truncateToWidth(credStr, Math.max(8, width - 2)), { fg: "fg.muted" }),
            ],
            context,
          ),
        );
      }
    }

    const helpCmd = "Type /help for commands, /quit to exit.";
    if (stringWidth(helpCmd) <= width - 2) {
      lines.push(
        fitLine(
          "sidebar",
          [
            segment("  Type ", { fg: "fg.muted" }),
            segment("/help", { fg: "accent.cyan", bold: true }),
            segment(" for commands, ", { fg: "fg.muted" }),
            segment("/quit", { fg: "accent.cyan", bold: true }),
            segment(" to exit.", { fg: "fg.muted" }),
          ],
          context,
        ),
      );
    } else {
      lines.push(
        fitLine(
          "sidebar",
          [
            segment("  Type ", { fg: "fg.muted" }),
            segment("/help", { fg: "accent.cyan", bold: true }),
            segment(" for commands,", { fg: "fg.muted" }),
          ],
          context,
        ),
      );
      lines.push(
        fitLine(
          "sidebar",
          [
            segment("  ", {}),
            segment("/quit", { fg: "accent.cyan", bold: true }),
            segment(" to exit.", { fg: "fg.muted" }),
          ],
          context,
        ),
      );
    }
  } else if (input.helpHint !== undefined) {
    heading("Help");
    lines.push(
      fitLine(
        "sidebar",
        [
          segment("  ", {}),
          segment(truncateToWidth(input.helpHint, Math.max(8, width - 2)), { fg: "fg.muted" }),
        ],
        context,
      ),
    );
  }

  return lines;
}

function serviceSegments(service: SidebarService, context: BlockContext): Segment[] {
  const token: ThemeToken =
    service.state === "ready"
      ? "accent.green"
      : service.state === "starting"
        ? "accent.cyan"
        : service.state === "degraded"
          ? "accent.amber"
          : service.state === "down"
            ? "accent.red"
            : "fg.muted";

  const stateText = service.state;

  return [
    segment("  \u2022 ", { fg: token }),
    segment(sanitizeInline(service.name, 32), { fg: "fg.primary" }),
    segment(" " + stateText, { fg: token }),
  ];
}

/** §11.5 todo markers, as the plan's `[x]` / `[/]` / `[ ]` boxes. */
export function todoBox(status: PlanItem["status"]): string {
  switch (status) {
    case "done":
      return "[x]";
    case "active":
      return "[/]";
    case "blocked":
      return "[!]";
    case "skipped":
      return "[-]";
    case "pending":
      return "[ ]";
  }
}

/**
 * A filled-proportion bar.
 *
 * Uses block characters where Unicode is available and `#`/`.` where it is not, so
 * the gauge conveys the same proportion in an ASCII terminal instead of vanishing.
 */
export function renderGauge(percent: number, width: number, context: BlockContext): string {
  const cells = Math.max(1, width);
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  const [on, off] = context.capabilities.unicode ? ["█", "░"] : ["#", "."];
  return `${on.repeat(filled)}${off.repeat(cells - filled)}`;
}

/** `21.7k` rather than `21,712`: the sidebar is 28 columns wide. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  const millions = tokens / 1_000_000;
  return `${millions.toFixed(Number.isInteger(millions * 10) ? 1 : 2)}M`;
}

/** `12.4s` / `3m 5s`, matching the timeline's own duration format. */
export function formatCompactDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * Build sidebar input from a view model.
 *
 * The activity line for a running child is derived from its newest tool call
 * rather than from a separate progress field, so it cannot disagree with the tree
 * on the same screen.
 */
export function sidebarFromViewModel(
  model: SessionViewModel,
  extras: {
    title?: string;
    mcpServers?: readonly SidebarService[];
    lspServers?: readonly SidebarService[];
    showCost?: boolean;
    nowMs?: number;
    notices?: readonly string[];
    sessionId?: string;
    credentialSource?: string;
    helpHint?: string;
  } = {},
): SidebarInput {
  const subagents: SidebarSubagent[] = model.activeTasks.map((task) => {
    const activity = subagentActivity(task);
    const toolUses = Math.max(
      task.subagentEvents.length + (task.subagentEventsOmitted ?? 0),
      task.subagentEventCount ?? 0,
    );
    const elapsedMs =
      task.durationMs ??
      (task.state === "running" &&
        task.startTimeMs !== undefined &&
        extras.nowMs !== undefined
        ? Math.max(0, extras.nowMs - task.startTimeMs)
        : undefined);
    const pendingTokens = Math.max(0, task.pendingInputTokens ?? 0);
    const tokensKnown =
      task.tokens !== undefined || task.pendingInputTokens !== undefined;
    return {
      role: task.role,
      title: task.title,
      state: task.state,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      toolUses,
      ...(tokensKnown ? { tokens: (task.tokens ?? 0) + pendingTokens } : {}),
      ...(pendingTokens > 0 ? { tokensEstimated: true } : {}),
      ...(activity !== undefined ? { activity } : {}),
    };
  });

  return {
    ...(extras.title !== undefined ? { title: extras.title } : {}),
    contextUsedTokens: model.contextUsedTokens,
    contextBudgetTokens: model.contextBudgetTokens,
    usage: model.usage,
    subagents,
    todo: model.plan,
    ...(extras.mcpServers !== undefined ? { mcpServers: extras.mcpServers } : {}),
    ...(extras.lspServers !== undefined ? { lspServers: extras.lspServers } : {}),
    ...(extras.showCost !== undefined ? { showCost: extras.showCost } : {}),
    ...(extras.notices !== undefined ? { notices: extras.notices } : {}),
    sessionId: extras.sessionId ?? model.sessionId,
    ...(extras.credentialSource !== undefined ? { credentialSource: extras.credentialSource } : {}),
    ...(extras.helpHint !== undefined ? { helpHint: extras.helpHint } : {}),
  };
}

function sidebarTaskStateLabel(state: TimelineTask["state"]): string {
  switch (state) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "blocked":
      return "Blocked";
    case "waiting":
      return "Waiting";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
  }
}

function subagentActivity(task: TimelineTask): string | undefined {
  for (let index = task.subagentEvents.length - 1; index >= 0; index -= 1) {
    const event = task.subagentEvents[index];
    if (event === undefined) continue;
    if (event.status !== "running") continue;
    const target = event.argumentsSummary.length > 0 ? event.argumentsSummary : event.toolId;
    return `${activityVerb(event.toolId)} ${target}`;
  }
  if (task.progress !== undefined && task.progress.length > 0) return task.progress;
  const last = task.subagentEvents.at(-1);
  if (last === undefined) return undefined;
  const target = last.argumentsSummary.length > 0 ? last.argumentsSummary : last.toolId;
  return `${activityVerb(last.toolId)} ${target}`;
}

function activityVerb(toolId: string): string {
  const id = toolId.toLowerCase();
  if (id.startsWith("fs.read") || id.startsWith("fs.list") || id === "fs.stat") return "reading";
  if (id.startsWith("fs.search") || id.includes("grep")) return "searching";
  if (id.startsWith("fs.") || id.startsWith("patch.") || id.startsWith("edit.")) return "writing";
  if (id.startsWith("process.") || id.startsWith("shell.")) return "running";
  if (id.startsWith("git.")) return "inspecting";
  return "calling";
}

// §6.14's completion popup lives in `./completion.ts`, which owns the parsing,
// the selection state, and the popup renderer as one unit.
