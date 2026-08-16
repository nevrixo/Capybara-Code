/**
 * Timeline block renderers — PRD §6.4, §6.7–§6.12, §6.19, AC-06, AC-45.
 *
 * §6.4's table maps each event to a representation, and each renderer below
 * implements one row of it. Two rules run through all of them:
 *
 * - §6.5: colour never carries state alone, so every state line leads with an icon
 *   and a word. This is what makes AC-45 pass rather than being retrofitted.
 * - §6.20: external text is sanitized before it is measured or drawn.
 */

import { planDigest } from "@cbc/session-domain";
import type {
  CompletionReportView,
  PlanDocument,
  PlanItem,
  TimelineApproval,
  TimelineCommentary,
  TimelineDiff,
  TimelineDiffPreviewLine,
  TimelineFinal,
  TimelineItem,
  TimelineJob,
  TimelineNotice,
  TimelinePlan,
  TimelineSubagentEvent,
  TimelineTask,
  TimelineToolCall,
  TimelineToolDiscovery,
  TimelineUserMessage,
} from "@cbc/session-domain";

import { sanitizeInline, sanitizeText, sanitizeUserInput } from "./sanitize.ts";
import { renderNormalTodoList, renderPlanContract, type PlanContractRenderInput, type PlanDocumentView } from "./todo.ts";
import {
  blank,
  bodyLines,
  fitLine,
  line,
  segment,
  type BlockContext,
  type Segment,
  type StyledLine,
} from "./segments.ts";
import {
  renderMarkdown,
  renderMarkdownSourceTail,
  type MarkdownSourceView,
} from "./markdown.ts";
import {
  icon,
  toolActionIcon,
  toolActionLabel,
  treeGlyphs,
  type IconName,
  type ThemeToken,
} from "./theme.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

// ---------------------------------------------------------------------------
// §6.7 user message
// ---------------------------------------------------------------------------

/**
 * §6.7: a `user` header, no padding between header and body, multiline paste
 * preserved, and Markdown left un-rendered.
 *
 * The full-width tinted slab this block used to draw is gone. §6.5's rule is that
 * colour must not carry state, and a saturated background on every prompt was
 * doing worse than that — it read as an alert on a line that is never an alert.
 * Attribution moved to a vertical accent rule, which marks the same extent
 * without competing for attention, and survives `NO_COLOR` because the rule is a
 * character rather than a fill.
 *
 * User-authored Markdown is intentionally not rendered: §6.7 says so, and the reason is that a
 * user pasting a diff or a code block wants to see exactly what they pasted.
 */
export interface BoxGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

export function getBoxGlyphs(unicode: boolean): BoxGlyphs {
  if (unicode) {
    return {
      topLeft: "┌",
      topRight: "┐",
      bottomLeft: "└",
      bottomRight: "┘",
      horizontal: "─",
      vertical: "│",
    };
  }
  return {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
  };
}

function fitSegmentsToWidth(segments: readonly Segment[], maxCols: number): Segment[] {
  let remaining = Math.max(0, maxCols);
  const out: Segment[] = [];
  for (const seg of segments) {
    const sanitizedText = seg.text.includes("\n") ? seg.text.replace(/\r?\n+/g, " ") : seg.text;
    const w = stringWidth(sanitizedText);
    if (w <= remaining) {
      out.push(sanitizedText === seg.text ? seg : { ...seg, text: sanitizedText });
      remaining -= w;
    } else {
      if (remaining > 0) {
        out.push({ ...seg, text: truncateToWidth(sanitizedText, remaining) });
      }
      remaining = 0;
      break;
    }
  }
  return out;
}

export function renderBox(
  headerSegments: Segment[],
  bodyContentLines: StyledLine[],
  context: BlockContext,
  borderColor: ThemeToken = "border.warm",
): StyledLine[] {
  const glyphs = getBoxGlyphs(context.capabilities.unicode);
  const width = Math.max(1, context.columns);

  // Borders consume four columns and become visual noise before the content is
  // useful. The emergency layout keeps the semantic header and body, but drops
  // panel chrome and clamps every row to the actual terminal width.
  if (width < 40) {
    return [
      line("header", fitSegmentsToWidth(headerSegments, width)),
      ...bodyContentLines.map((bodyLine) =>
        line(bodyLine.kind, fitSegmentsToWidth(bodyLine.segments, width), bodyLine.rowBackground),
      ),
    ];
  }
  const innerWidth = width - 4; // 2 left (`│ `), 2 right (` │`)

  // 1. Top border with title header
  const maxHeaderWidth = Math.max(0, width - 5);
  const fittedHeader = fitSegmentsToWidth(headerSegments, maxHeaderWidth);
  const titleWidth = fittedHeader.reduce((sum, s) => sum + stringWidth(s.text), 0);
  const leftPrefix: Segment[] = [
    segment(`${glyphs.topLeft}${glyphs.horizontal} `, { fg: borderColor }),
  ];
  const prefixWidth = 3; // "┌─ " is 3 cols
  const remaining = Math.max(2, width - prefixWidth - titleWidth);
  const rightSuffix: Segment[] = [
    segment(` ${glyphs.horizontal.repeat(Math.max(0, remaining - 2))}${glyphs.topRight}`, {
      fg: borderColor,
    }),
  ];

  const lines: StyledLine[] = [
    line("header", [...leftPrefix, ...fittedHeader, ...rightSuffix]),
  ];

  // 2. Body lines
  const leftBorder = segment(`${glyphs.vertical} `, { fg: borderColor });

  for (const bLine of bodyContentLines) {
    const fittedSegments = fitSegmentsToWidth(bLine.segments, innerWidth);
    const textWidth = fittedSegments.reduce((sum, s) => sum + stringWidth(s.text), 0);
    const pad = Math.max(0, innerWidth - textWidth);
    const rightBorder = segment(`${" ".repeat(pad)} ${glyphs.vertical}`, { fg: borderColor });

    lines.push(
      line(bLine.kind, [leftBorder, ...fittedSegments, rightBorder]),
    );
  }

  // 3. Bottom border
  lines.push(
    line("border", [
      segment(
        `${glyphs.bottomLeft}${glyphs.horizontal.repeat(Math.max(0, width - 2))}${glyphs.bottomRight}`,
        { fg: borderColor },
      ),
    ]),
  );

  return lines;
}

export function renderUserMessage(
  item: Pick<TimelineUserMessage, "text"> & Partial<Pick<TimelineUserMessage, "timestamp">>,
  context: BlockContext,
  options: { author?: string; showTimestamp?: boolean } = {},
): StyledLine[] {
  const text = sanitizeUserInput(item.text);
  const borderColor: ThemeToken = "accent.coral";
  const gutter = context.capabilities.unicode ? "▎" : "|";

  const header: Segment[] = [
    segment(`${gutter} `, { fg: borderColor }),
    segment(`${icon("user", context.capabilities)} `, { fg: "accent.coral" }),
    segment("user", { fg: "accent.coral", bold: true }),
  ];
  if (options.author !== undefined && options.author.length > 0) {
    header.push(segment(`  ${sanitizeInline(options.author, 32)}`, { fg: "accent.coral", bold: true }));
  }
  if (options.showTimestamp === true && item.timestamp !== undefined) {
    const clock = formatClock(item.timestamp);
    if (clock !== undefined) header.push(segment(`  ${clock}`, { fg: "fg.muted" }));
  }

  const innerWidth = Math.max(12, context.columns - 4);
  const innerContext: BlockContext = {
    ...context,
    columns: innerWidth,
  };

  const bodyLines: StyledLine[] = [];
  for (const wrapped of wrapBody(text, innerContext, `${gutter} `)) {
    bodyLines.push(line("body", [segment(`${gutter} `, { fg: borderColor }), segment(wrapped, { fg: "fg.primary" })]));
  }

  return [fitLine("header", header, context), ...bodyLines];
}

/** `HH:MM` from an ISO timestamp, or `undefined` when it is not parseable. */
export function formatClock(timestamp: string): string | undefined {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return undefined;
  const date = new Date(parsed);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// §6.8 assistant commentary and reasoning summary
// ---------------------------------------------------------------------------

export interface CommentaryOptions {
  readonly showHeader?: boolean;
  /** The model doing the thinking, named on the header line. */
  readonly model?: string;
  /** Elapsed reasoning time. Rendered live while the phase is open. */
  readonly elapsedMs?: number;
  /** True once the phase is finished; the header stops saying "Thinking...". */
  readonly done?: boolean;
  /** Collapse to the header line alone (§6.8: a finished phase folds up). */
  readonly collapsed?: boolean;
  /** Accordion hint suffix, e.g. "  · Ctrl+O to expand". */
  readonly accordionHint?: string;
  /** One-line summary shown when collapsed. */
  readonly summary?: string;
}

/**
 * §6.8: muted text under a phase header, visually distinct from the final answer,
 * and capped at two sentences for a reasoning summary (§10.7).
 *
 * The header now names the *phase* rather than the product — "Thinking..." with
 * the model and elapsed time, instead of a bare `capybara`. The reason is §6.3's
 * three-layer budget: with only one live line, the timeline is where a long
 * reasoning phase has to show that it is still moving, and a static label cannot.
 *
 * `variant` is preserved through the reducer so §10.7's phase separation survives
 * replay — a commentary line must never be mistaken for the answer.
 */
export function thinkingSpinnerLine(text: string, context: BlockContext, frame = 0): StyledLine {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const glyph = context.capabilities.reducedMotion ? "◈" : frames[frame % frames.length]!;
  const full = sanitizeInline(text.replace(/\n/g, " ").trim(), Math.max(0, context.columns - 16));
  const preview = full || "Thinking...";
  return fitLine("commentary", [
    segment(`${glyph} `, { fg: "accent.coral" }),
    segment(preview, { fg: "fg.muted", italic: true }),
  ], context);
}

export function renderCommentary(
  item: Pick<TimelineCommentary, "text" | "variant">,
  context: BlockContext,
  options: CommentaryOptions = {},
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  if (item.variant !== "reasoning" && item.variant !== "reasoning_summary") {
    const lines: StyledLine[] = [];
    // Commentary is visible work-in-progress, just like a provider reasoning
    // summary. Give it the same phase cue so users do not have to infer that a
    // pre-tool explanation is still part of the active turn.
    if (options.showHeader !== false && item.variant !== "candidate_final") {
      lines.push(fitLine("header", commentaryHeader(item.variant, context, options), context));
    }
    if (options.collapsed === true) {
      const hint = options.accordionHint ?? "  · Ctrl+O to expand";
      if (options.summary !== undefined && options.summary.length > 0) {
        lines.push(
          fitLine("commentary", [segment(`${glyphs.gutter} `, { fg: "border.warm" }), segment(sanitizeInline(options.summary, 140), { fg: "fg.muted", italic: true }), segment(hint, { fg: "fg.muted" })], context),
        );
        return lines;
      }
      lines.push(...renderMarkdown(item.text, context, { kind: "commentary", prefix: "  ", style: { fg: "fg.muted", italic: true } }));
      return lines;
    }
    lines.push(...renderMarkdown(item.text, context, {
      kind: "commentary",
      prefix: "  ",
      style: { fg: "fg.muted", italic: true },
    }));
    return lines;
  }
  const kind = "reasoning";
  const lines: StyledLine[] = [];

  if (options.showHeader !== false) {
    lines.push(fitLine("header", commentaryHeader(item.variant, context, options), context));
  }

  if (options.collapsed === true) {
    if (options.summary !== undefined && options.summary.length > 0) {
      const hint = options.accordionHint ?? "  · Ctrl+O to expand";
      lines.push(
        fitLine(
          "commentary",
          [segment(`${glyphs.gutter} `, { fg: "border.warm" }), segment(sanitizeInline(options.summary, 140), { fg: "fg.muted", italic: true }), segment(hint, { fg: "fg.muted" })],
          context,
        ),
      );
    } else if (options.accordionHint !== undefined) {
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        lines[lines.length - 1] = fitLine("header", [...commentaryHeader(item.variant, context, options), segment(options.accordionHint, { fg: "fg.muted" })], context);
      }
    }
    if (lines.length === 0) {
      lines.push(fitLine("header", commentaryHeader(item.variant, context, options), context));
    }
    return lines;
  }

  lines.push(
    ...renderMarkdown(item.text, context, {
      kind,
      prefix: "  ",
      style: { fg: "fg.muted", italic: true },
    }),
  );
  return lines;
}

export function commentaryHeader(
  variant: TimelineCommentary["variant"],
  context: BlockContext,
  options: CommentaryOptions,
): Segment[] {
  // Candidate-final text has no provisional header. The caller normally omits
  // it before reaching here; returning no segments protects future call sites.
  if (variant === "candidate_final") return [];
  const baseLabel = variant === "reasoning"
    ? "Thinking" : variant === "reasoning_summary" ? "Reasoning summary" : "Working";
  const label = options.done === true ? baseLabel : `${baseLabel}...`;
  const headerIcon: import("./theme.ts").IconName = "thinking";

  const segments: Segment[] = [
    segment(`${icon(headerIcon, context.capabilities)} `, { fg: "accent.coral" }),
    segment(label, { fg: "fg.primary", bold: true }),
  ];

  if (options.model !== undefined && options.model.length > 0) {
    segments.push(segment(` (${sanitizeInline(options.model, 32)})`, { fg: "fg.muted" }));
  }
  if (options.elapsedMs !== undefined && options.elapsedMs > 0) {
    segments.push(
      segment(
        ` ${icon("clock", context.capabilities)} ${formatDuration(options.elapsedMs)}`,
        { fg: "fg.muted" },
      ),
    );
  }
  return segments;
}

/** Wrap `text` to the width left over after an indent prefix. */
function wrapBody(text: string, context: BlockContext, prefix: string): string[] {
  const rendered = bodyLines(text, context, { indent: prefix });
  // `bodyLines` emits the prefix as its own segment; only the wrapped text is
  // needed here because each caller styles the prefix differently.
  return rendered.map((styled) =>
    styled.segments.length > 1 ? (styled.segments[1]?.text ?? "") : (styled.segments[0]?.text ?? ""),
  );
}

export function capToSentences(text: string, _max = 8): string {
  return text.trim();
}

// ---------------------------------------------------------------------------
// §6.9 tool discovery
// ---------------------------------------------------------------------------

/**
 * §6.9: query, match count, active count, catalog count, and the activation limit,
 * with a ranked tree showing the top three by default.
 *
 * §6.9 also insists the score is a *search ranking value*, not model confidence.
 * The label says `score` and nothing in this renderer implies otherwise.
 */
export function renderToolDiscovery(
  item: Pick<
    TimelineToolDiscovery,
    "query" | "matches" | "activated" | "activeCount" | "totalCount" | "limit"
  >,
  context: BlockContext,
  options: { expanded?: boolean; visible?: number; detail?: ToolDetail } = {},
): StyledLine[] {
  // Full tool detail makes the discovery result useful, but it must not flood
  // the timeline with every fuzzy match. An explicit expansion remains the
  // only path to the complete ranked list.
  const detail = options.expanded === true ? "full" : (options.detail ?? "compact");
  if (detail === "compact") {
    const activated = item.activated.slice(0, 3);
    const hidden = Math.max(0, item.activated.length - activated.length);
    const activation =
      activated.length === 0
        ? ""
        : ` \u00b7 ${activated.join(", ")}${hidden > 0 ? ` +${hidden}` : ""} activated`;
    return [
      fitLine(
        "tool",
        [
          segment(`${icon("success", context.capabilities)} `, { fg: "accent.green" }),
          segment(`Tools \u00b7 ${item.matches.length} matched`, { fg: "fg.primary", bold: true }),
          segment(activation, { fg: "fg.muted" }),
        ],
        context,
      ),
    ];
  }
  const glyphs = treeGlyphs(context.capabilities);
  const visible = options.expanded === true ? item.matches.length : (options.visible ?? 3);
  const shown = item.matches.slice(0, Math.max(0, visible));

  const lines: StyledLine[] = [
    fitLine(
      "tool",
      [
        segment(`${icon("success", context.capabilities)} `, { fg: "accent.green" }),
        segment("Tool Discovery: ", { fg: "fg.primary", bold: true }),
        segment(sanitizeInline(item.query, 120), { fg: "fg.primary" }),
      ],
      context,
    ),
    fitLine(
      "tree",
      [
        segment(`${glyphs.vertical}  `, { fg: "border.warm" }),
        segment(
          `${item.matches.length} matches · ${item.activeCount} active · ${item.totalCount} total · limit:${item.limit}`,
          { fg: "fg.muted" },
        ),
      ],
      context,
    ),
  ];

  const titleWidth = shown.reduce((max, match) => Math.max(max, stringWidth(match.title)), 0);

  shown.forEach((match, index) => {
    const last = index === shown.length - 1 && shown.length === item.matches.length;
    const connector = last ? glyphs.last : glyphs.branch;
    const continuation = last ? "   " : `${glyphs.vertical}  `;

    lines.push(
      fitLine(
        "tree",
        [
          segment(`${connector} `, { fg: "border.warm" }),
          segment(match.title.padEnd(titleWidth), { fg: "accent.coral" }),
          segment(`  score ${match.score.toFixed(3)}`, { fg: "fg.muted" }),
        ],
        context,
      ),
    );
    lines.push(
      fitLine(
        "tree",
        [
          segment(continuation, { fg: "border.warm" }),
          segment(sanitizeInline(match.description, 160), { fg: "fg.muted" }),
        ],
        context,
      ),
    );
  });

  const hidden = item.matches.length - shown.length;
  if (hidden > 0) {
    lines.push(
      line("tree", [
        segment(`${glyphs.last} `, { fg: "border.warm" }),
        segment(`${hidden} more — press Enter to expand`, { fg: "fg.muted", italic: true }),
      ]),
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// §6.4 tool start / progress / result
// ---------------------------------------------------------------------------

/**
 * The lifecycle fields shared by a top-level tool call and a subagent's call.
 *
 * Both render identically; only their position differs. Typing the renderer
 * against the shared shape is what lets the §6.10 tree reuse it instead of
 * growing a parallel implementation that drifts.
 */
export type ToolCallView = Pick<
  TimelineToolCall,
  | "toolId"
  | "argumentsSummary"
  | "status"
  | "summary"
  | "durationMs"
  | "errorCode"
  | "artifacts"
  | "progress"
> &
  Partial<Pick<TimelineToolCall, "exitCode" | "additions" | "deletions" | "diffPreview" | "agentId">>;

export interface ToolCallOptions {
  /**
   * Render as a node in a tree: `indent` is the gutter drawn to the left, and
   * `last` selects the corner connector.
   */
  readonly tree?: { readonly indent?: string; readonly last?: boolean };
  /** Hide the mini-diff even when the call carries one. */
  readonly hideDiff?: boolean;
  /** Whether to render agent identity badge ([MAIN] vs [SUB]). */
  readonly showAgentBadge?: boolean;
  /** Accordion: collapse to header line only; Ctrl+O expands. */
  readonly collapsed?: boolean;
  /** Dim succeeded reads so completed work doesn't compete for attention. */
  readonly dimSucceeded?: boolean;
}

function friendlyToolSummary(item: ToolCallView): string | undefined {
  if (item.summary === undefined || item.summary.length === 0) return undefined;
  const raw = item.summary.trim();
  const lower = raw.toLowerCase();
  if (item.status === "failed" && lower.includes("patch could not be parsed")) {
    if (lower.includes("hunk declares") || lower.includes("hunk header")) return "Failed to patch (Invalid hunk header)";
    return "Patch format invalid. Retrying via standard file overwrite...";
  }
  if (raw.length > 180) return raw.slice(0, 177) + "…";
  return raw;
}

function isRetryHint(summary: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes("retry") || lower.includes("retrying") || lower.includes("fallback") || lower.includes("overwrite");
}

/**
 * §6.4: an accented action label with compact arguments on start; success or
 * failure with collapsed output on completion.
 *
 * The label is the *action* (`Read`, `Write`, `Run`) with the tool id kept beside
 * it. A reader scanning a turn wants to know what happened to their workspace, and
 * `fs.apply_patch` answers that less directly than `Write`. AC-45 is satisfied by
 * the same word: the action survives with no colour and no icons.
 */
function toolActionBadgeToken(toolId: string): ThemeToken {
  const lower = toolId.toLowerCase();
  if (lower.includes("read")) return "accent.cyan";
  if (lower.includes("list")) return "accent.purple";
  if (lower.includes("search") || lower.includes("find") || lower.includes("grep")) return "accent.blue";
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create")) return "accent.amber";
  if (lower.includes("git")) return "accent.blue";
  return "accent.cyan";
}

function isSubagentToolCall(item: ToolCallView): boolean {
  return item.agentId !== undefined && item.agentId !== "root";
}

export function renderToolCall(
  item: ToolCallView,
  context: BlockContext,
  options: ToolCallOptions = {},
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  const statusToken = toolStatusToken(item.status);
  const badgeToken = toolActionBadgeToken(item.toolId);
  const subagent = isSubagentToolCall(item);
  const treeIndent = subagent && options.tree === undefined
    ? "  "
    : (options.tree?.indent ?? "");
  const hasTree = subagent || options.tree !== undefined;
  const connector =
    !hasTree ? "" : (options.tree?.last === true ? glyphs.lastLong : glyphs.branchLong);
  const continuation =
    !hasTree
      ? subagent ? `${treeIndent}  ` : "  "
      : `${treeIndent}${options.tree?.last === true ? glyphs.gutterEnd : glyphs.gutter}`;

  const isSucceededRead = item.status === "succeeded" && (item.toolId === "fs.read" || item.toolId === "fs.read_many" || item.toolId === "fs.list");
  const dimOk = options.dimSucceeded === true && isSucceededRead;

  const head: Segment[] = [];
  // Subagent tree connectors use their role colour for visual distinction.
  const treeFg: ThemeToken = subagent && item.agentId !== undefined
    ? subagentRoleToken(item.agentId)
    : dimOk ? "fg.muted" : "border.warm";
  if (hasTree) {
    const gutter = subagent && options.tree === undefined ? `${treeIndent}${connector} ` : `${treeIndent}${connector} `;
    head.push(segment(gutter, { fg: treeFg, dim: dimOk }));
  } else if (subagent) {
    head.push(segment(`${treeIndent}`, { fg: treeFg }));
  }

  if (options.showAgentBadge !== false && item.agentId !== undefined) {
    if (item.agentId === "root") {
      head.push(segment("· ", { fg: "fg.muted", dim: true }));
    } else {
      const roleToken = subagentRoleToken(item.agentId);
      head.push(
        segment(` ${sanitizeInline(item.agentId, 24)} `, {
          fg: "bg.base",
          bg: roleToken,
          bold: true,
        }),
      );
      head.push(segment(" ", {}));
    }
  }

  const glyph: IconName =
    item.status === "succeeded"
      ? toolActionIcon(item.toolId)
      : item.status === "failed"
        ? "error"
        : toolActionIcon(item.toolId);

  const headFg: import("./theme.ts").ThemeToken = dimOk ? "fg.muted" : "fg.primary";
  head.push(segment(`${icon(glyph, context.capabilities)} `, { fg: badgeToken }));
  head.push(segment(`[${toolActionLabel(item.toolId)}] `, { fg: badgeToken, bold: true }));

  if (item.argumentsSummary.length > 0) {
    head.push(segment(sanitizeInline(item.argumentsSummary, 160), { fg: headFg, dim: dimOk }));
  } else {
    head.push(segment(item.toolId, { fg: headFg, dim: dimOk }));
  }

  const counts = changeCounts(item);
  if (counts !== undefined) {
    head.push(segment(" (", { fg: "fg.muted" }));
    head.push(segment(`+${counts.additions}`, { fg: "accent.green" }));
    head.push(segment(" "));
    head.push(segment(`-${counts.deletions}`, { fg: "accent.red" }));
    head.push(segment(")", { fg: "fg.muted" }));
  }

  if (item.exitCode !== undefined) {
    head.push(
      segment(` ${icon("arrow", context.capabilities)} exit ${item.exitCode}`, {
        fg: item.exitCode === 0 ? "accent.green" : "accent.red",
      }),
    );
  }
  if (item.status !== "running" && item.durationMs !== undefined) {
    head.push(segment(` · ${formatDuration(item.durationMs)}`, { fg: "fg.muted" }));
  }

  const statusFg: ThemeToken = item.status === "succeeded" ? "accent.green" : statusToken;
  const statusWord = item.status === "succeeded" ? "ok" : item.status === "failed" ? "failed" : "running";
  head.push(segment(` ${statusWord}`, { fg: statusFg, bold: item.status === "failed" }));
  if (item.errorCode !== undefined && item.errorCode.length > 0) {
    head.push(segment(` ${item.errorCode}`, { fg: "accent.red", bold: true }));
  }

  const lines: StyledLine[] = [fitLine("tool", head, context)];
  if (options.collapsed === true) {
    lines[0] = fitLine("tool", [...head, segment("  · Ctrl+O to expand", { fg: "fg.muted" })], context);
    return lines;
  }

  if (item.status === "running" && item.progress !== undefined) {
    lines.push(
      fitLine(
        "tool",
        [
          segment(continuation, { fg: treeFg }),
          segment(sanitizeInline(item.progress, 160), { fg: "fg.muted", italic: true }),
        ],
        context,
      ),
    );
  }

  if (options.hideDiff !== true && item.diffPreview !== undefined && item.diffPreview.length > 0) {
    lines.push(...renderDiffBox(item.diffPreview, context, continuation));
  }

  const friendly = friendlyToolSummary(item);
  if (friendly !== undefined && (!subagent || item.status === "failed")) {
    const isErrorSummary = item.status === "failed";
    lines.push(
      fitLine(
        "tool",
        [
          segment(continuation, { fg: treeFg }),
          segment(isErrorSummary ? "response: " : "", { fg: isErrorSummary ? "accent.amber" : "fg.muted", bold: isErrorSummary }),
          segment(sanitizeInline(friendly, 180), { fg: isErrorSummary ? "accent.amber" : "fg.muted", italic: !isErrorSummary }),
        ],
        context,
      ),
    );
  }

  for (const artifact of item.artifacts ?? []) {
    lines.push(
      fitLine(
        "tool",
        [
          segment(continuation, { fg: treeFg }),
          segment(`${icon("artifact", context.capabilities)} `, { fg: "accent.cyan" }),
          segment(artifact, { fg: "fg.muted" }),
        ],
        context,
      ),
    );
  }

  return lines;
}

function toolStatusToken(status: TimelineToolCall["status"]): ThemeToken {
  return status === "succeeded"
    ? "accent.green"
    : status === "failed"
      ? "accent.red"
      : "accent.cyan";
}

function changeCounts(
  item: Pick<ToolCallView, "additions" | "deletions">,
): { additions: number; deletions: number } | undefined {
  if (item.additions === undefined && item.deletions === undefined) return undefined;
  return { additions: item.additions ?? 0, deletions: item.deletions ?? 0 };
}

// ---------------------------------------------------------------------------
// §6.4 inline mini-diff
// ---------------------------------------------------------------------------

/** §6.4: the preview is a glance, not a diff viewer. */
export const MAX_MINI_DIFF_LINES = 4;

/**
 * Two to four changed lines beside a write.
 *
 * Rendered as `NN | + text` so the marker, not the colour, distinguishes an
 * addition from a removal (§6.5, AC-45). The line number is the *new* file's,
 * because that is what the reader will open the file to.
 *
 * Long lines are truncated rather than wrapped: a preview that reflows into six
 * rows stops being a preview; callers can request the complete change separately.
 */
export function renderMiniDiff(
  preview: readonly TimelineDiffPreviewLine[],
  context: BlockContext,
  options: { indent?: string; max?: number } = {},
): StyledLine[] {
  const indent = options.indent ?? "  ";
  const max = Math.max(1, options.max ?? MAX_MINI_DIFF_LINES);
  const shown = preview.slice(0, max);
  if (shown.length === 0) return [];

  const gutterWidth = shown.reduce(
    (widest, entry) => Math.max(widest, String(entry.lineNumber ?? "").length),
    1,
  );
  const overhead = stringWidth(indent) + gutterWidth + 5;
  const room = Math.max(8, context.columns - overhead);

  const lines: StyledLine[] = shown.map((entry) => {
    const token: ThemeToken =
      entry.kind === "added" ? "accent.green" : entry.kind === "removed" ? "accent.red" : "fg.muted";
    const marker = entry.kind === "added" ? "+" : entry.kind === "removed" ? "-" : " ";
    const gutter = String(entry.lineNumber ?? "").padStart(gutterWidth);

    return line("diff", [
      segment(indent, { fg: "border.warm" }),
      segment(`${gutter} | `, { fg: "fg.muted" }),
      segment(`${marker} `, { fg: token, bold: true }),
      segment(truncateToWidth(sanitizeInline(entry.text, 400), room), { fg: token }),
    ]);
  });

  const hidden = preview.length - shown.length;
  if (hidden > 0) {
    lines.push(
      fitLine(
        "diff",
        [
          segment(indent, { fg: "border.warm" }),
          segment(`… ${hidden} more changed line(s)`, {
            fg: "fg.muted",
            italic: true,
          }),
        ],
        context,
      ),
    );
  }
  return lines;
}

export function renderDiffBox(
  preview: readonly TimelineDiffPreviewLine[],
  context: BlockContext,
  indent = "  ",
): StyledLine[] {
  const gutter = context.capabilities.unicode ? "▎" : "|";
  const mini = renderMiniDiff(preview, context, { indent: `${indent}${gutter} ` });
  if (mini.length === 0) return [];
  const header = fitLine("diff", [
    segment(indent, { fg: "border.warm" }),
    segment(`${gutter} `, { fg: "accent.cyan" }),
    segment("Diff", { fg: "accent.cyan", bold: true }),
    segment(` · ${preview.length} line(s)`, { fg: "fg.muted" }),
  ], context);
  return [header, ...mini];
}

// ---------------------------------------------------------------------------
// §6.10 task card
// ---------------------------------------------------------------------------

import { formatTokens } from "./chrome.ts";

export type TaskCardView = Pick<
  TimelineTask,
  | "role"
  | "title"
  | "goal"
  | "constraints"
  | "contract"
  | "writeLease"
  | "state"
  | "childCount"
  | "summary"
  | "awaitInterrupted"
  | "durationMs"
> &
  Partial<
    Pick<
      TimelineTask,
      | "modelId"
      | "dependencies"
      | "progress"
      | "subagentEvents"
      | "subagentEventCount"
      | "subagentEventsOmitted"
      | "startTimeMs"
      | "tokens"
    >
  >;

export interface TaskCardOptions {
  readonly collapsed?: boolean;
  /**
   * Render the compact Claude Code-style progress summary for the primary timeline.
   * The expanded brief and tool transcript remain available to explicit detail views.
   */
  readonly compact?: boolean;
  /** Injected clock used for deterministic elapsed labels. */
  readonly nowMs?: number;
  /** Hide the brief (goal, constraints, contract) and show only the tool tree. */
  readonly hideContext?: boolean;
  /** Explicitly show full raw markdown context (# Goal, # Constraints, # Contract). Defaults to false (concise mode). */
  readonly showFullContext?: boolean;
  /**
   * Do not render delegated tool calls inside the card.
   *
   * The chronological timeline renders those calls as their own blocks at the
   * sequence in which they happened. Keeping this switch on the card renderer
   * preserves the compact tree for callers that explicitly want it while the
   * main conversation can keep every response beside its originating action.
   */
  readonly hideToolTree?: boolean;
  /**
   * Omit the live closing state when the card is an historical anchor.
   * Completion/failed notices are emitted at their own event position instead.
   */
  readonly hideLiveState?: boolean;
  /** Cap on tool tree nodes; older nodes are summarized as a count. */
  readonly maxToolNodes?: number;
}

/**
 * §6.10: role, goal, constraints, contract, and child count; write lease scope on a
 * writer task; one of the documented states; collapsible.
 *
 * The card also renders the child's tool calls as a live indent tree. §6.10 asks
 * for the brief; the tree answers the question the brief cannot, which is what the
 * child is *doing right now*. Without it a delegated turn is a card that sits there
 * for twelve seconds and then reports a result, and the reader has no way to tell a
 * working subagent from a stuck one.
 */
function subagentRoleToken(role: string): ThemeToken {
  const lower = role.toLowerCase();
  if (lower.includes("api") || lower.includes("backend") || lower.includes("minor")) return "accent.cyan";
  if (lower.includes("frontend") || lower.includes("ui") || lower.includes("view")) return "accent.purple";
  if (lower.includes("shared") || lower.includes("common") || lower.includes("util")) return "accent.green";
  if (lower.includes("root") || lower.includes("workspace") || lower.includes("medium")) return "accent.amber";
  if (lower.includes("critical") || lower.includes("detector") || lower.includes("error")) return "accent.red";
  if (lower.includes("explore") || lower.includes("search") || lower.includes("read")) return "accent.blue";
  const colors: ThemeToken[] = [
    "accent.cyan",
    "accent.purple",
    "accent.green",
    "accent.amber",
    "accent.coral",
    "accent.blue",
  ];
  let hash = 0;
  for (let i = 0; i < role.length; i++) hash = (hash << 5) - hash + role.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length]!;
}

export function renderTaskCard(
  item: TaskCardView,
  context: BlockContext,
  options: TaskCardOptions = {},
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  const stateIcon = taskStateIcon(item.state);
  const stateToken = taskStateToken(item.state);
  const events = item.subagentEvents ?? [];
  const omittedEvents = Math.max(0, item.subagentEventsOmitted ?? 0);
  const observedEvents = Math.max(
    events.length + omittedEvents,
    item.subagentEventCount ?? 0,
  );
  const roleName = item.role || item.title || "subagent";
  const roleToken = subagentRoleToken(roleName);
  const goalText = item.goal || item.title;
  const stateLabel = taskStateLabel(item.state);

  if (options.compact === true) {
    const finished = item.state !== "running";
    const metrics: string[] = [];
    const toolCountKnown =
      item.subagentEventCount !== undefined ||
      events.length > 0 ||
      omittedEvents > 0;
    if (toolCountKnown) {
      metrics.push(`${observedEvents} tool use${observedEvents === 1 ? "" : "s"}`);
    }
    if (item.tokens !== undefined) {
      metrics.push(`${formatTokens(item.tokens)} tokens`);
    }
    if (item.durationMs !== undefined) {
      metrics.push(formatDuration(item.durationMs));
    } else if (
      item.state === "running" &&
      item.startTimeMs !== undefined &&
      options.nowMs !== undefined
    ) {
      metrics.push(formatDuration(Math.max(0, options.nowMs - item.startTimeMs)));
    }
    const summary = item.summary ?? (finished ? item.progress : undefined);
    const compactState = item.state === "completed" ? "Done" : stateLabel;
    const statusText = item.childCount > 1
      ? `${compactState} with ${item.childCount} parallel agents`
      : compactState;
    return [
      fitLine(
        "task",
        [
          segment(`${icon(stateIcon, context.capabilities)} `, { fg: stateToken, bold: true }),
          segment(sanitizeInline(roleName, 48), { fg: roleToken, bold: true }),
          ...(goalText.length > 0
            ? [segment(` (${sanitizeInline(goalText, 120)})`, { fg: "fg.primary" })]
            : []),
        ],
        context,
      ),
      fitLine(
        "task",
        [
          segment("  ", { fg: "fg.muted" }),
          segment(statusText, { fg: stateToken, bold: true }),
          ...(metrics.length > 0
            ? [segment(` (${metrics.join(" · ")})`, { fg: "fg.muted" })]
            : []),
          ...(summary !== undefined && summary.length > 0
            ? [segment(` — ${sanitizeInline(summary, 120)}`, { fg: "fg.muted" })]
            : []),
        ],
        context,
      ),
    ];
  }
  const headSegments: Segment[] = [
    segment("[SUB]", { fg: roleToken, bold: true }),
    segment(` Subagent \u00b7 ${roleName} `, { fg: "bg.base", bg: roleToken, bold: true }),
  ];
  if (goalText && goalText.length > 0) {
    headSegments.push(segment(` (${sanitizeInline(goalText, 140)})`, { fg: "fg.primary" }));
  }
  if (item.modelId !== undefined && item.modelId.length > 0) {
    headSegments.push(
      segment(` · ${icon("model", context.capabilities)} ${sanitizeInline(item.modelId, 24)}`, {
        fg: "fg.muted",
      }),
    );
  }

  const header = fitLine("task", headSegments, context);

  if (options.collapsed === true) {
    const summary = item.summary ?? item.title;
    return [
      fitLine(
        "task",
        [...header.segments, segment(` — ${sanitizeInline(summary, 120)}`, { fg: "fg.muted" })],
        context,
      ),
    ];
  }

  const lines: StyledLine[] = [line("task", header.segments, "bg.task")];

  const pushTree = (connector: string, segments: readonly Segment[]): void => {
    lines.push(
      line("task", [segment(`${connector} `, { fg: "border.warm" }), ...segments], "bg.task"),
    );
  };

  if (options.hideContext !== true) {
    const pushFullSection = (heading: string, values: readonly string[]): void => {
      if (values.length === 0) return;
      pushTree(glyphs.branch, [segment("# " + heading, { fg: "fg.primary", bold: true })]);
      for (const value of values) {
        pushTree(glyphs.gutter, [segment(sanitizeInline(value, 160), { fg: "fg.muted" })]);
      }
    };
    const pushConcise = (label: string, values: readonly string[]): void => {
      if (values.length === 0) return;
      pushTree(glyphs.branch, [
        segment(label + ": ", { fg: "fg.muted", bold: true }),
        segment(sanitizeInline(values.join("; "), 160), { fg: "fg.primary" }),
      ]);
    };

    if (options.showFullContext === true) {
      pushFullSection("Goal", goalText.length > 0 ? [goalText] : []);
      pushFullSection("Constraints", item.constraints);
      pushFullSection("Contract", item.contract);
      pushFullSection("Write lease", item.writeLease ?? []);
      pushFullSection("Dependencies", item.dependencies ?? []);
    } else {
      pushConcise("Goal", goalText.length > 0 ? [goalText] : []);
      pushConcise("Constraints", item.constraints);
      pushConcise("Contract", item.contract);
      pushConcise("Write lease", item.writeLease ?? []);
      pushConcise("Depends on", item.dependencies ?? []);
    }
  }

  const metrics: string[] = [];

  const toolCountKnown =
    item.subagentEventCount !== undefined ||
    events.length > 0 ||
    omittedEvents > 0;
  if (toolCountKnown) {
    metrics.push(`${observedEvents} tool use${observedEvents === 1 ? "" : "s"}`);
  } else if (item.childCount > 0) {
    metrics.push(`${item.childCount} subagent${item.childCount === 1 ? "" : "s"}`);
  }

  if (item.durationMs !== undefined) {
    metrics.push(formatDuration(item.durationMs));
  } else if (
    item.state === "running" &&
    item.startTimeMs !== undefined &&
    options.nowMs !== undefined
  ) {
    metrics.push(
      formatDuration(Math.max(0, options.nowMs - item.startTimeMs)),
    );
  }

  if (item.tokens !== undefined) {
    metrics.push(`${formatTokens(item.tokens)} tokens`);
  }

  if (item.summary !== undefined && item.summary.length > 0) {
    metrics.push(sanitizeInline(item.summary, 120));
  } else if (item.progress !== undefined && item.progress.length > 0) {
    metrics.push(sanitizeInline(item.progress, 120));
  }

  const detailStr = metrics.length > 0 ? ` (${metrics.join(" · ")})` : "";
  const treeConnector = glyphs.last;

  pushTree(treeConnector, [
    segment(`${stateLabel}`, { fg: stateToken, bold: true }),
    segment(detailStr, { fg: "fg.muted" }),
  ]);

  if (options.hideToolTree !== true && omittedEvents > 0) {
    pushTree(glyphs.branch, [
      segment(
        `${omittedEvents} earlier call${omittedEvents === 1 ? "" : "s"} omitted`,
        { fg: "fg.muted", dim: true },
      ),
    ]);
  }

  if (options.hideToolTree !== true && events.length > 0) {
    lines.push(...renderTaskToolTree(events, context, { maxToolNodes: options.maxToolNodes ?? 3 }));
  }

  if (item.awaitInterrupted) {
    lines.push(
      ...bodyLines(AWAIT_INTERRUPTED_MESSAGE, context, {
        kind: "notice",
        style: { fg: "accent.amber", italic: true },
      }),
    );
  }

  return lines;
}

/**
 * The child's tool calls as an indent tree under its card.
 *
 * Every node is a `renderToolCall` in tree mode, so a delegated `fs.write` looks
 * exactly like a top-level one — same action label, same counts, same mini-diff.
 * That symmetry is the point: the reader should not have to learn two vocabularies
 * for the same operation depending on who ran it.
 */
export function renderTaskToolTree(
  events: readonly TimelineSubagentEvent[],
  context: BlockContext,
  options: { maxToolNodes?: number } = {},
): StyledLine[] {
  if (events.length === 0) return [];

  const max = Math.max(1, options.maxToolNodes ?? 12);
  const hidden = Math.max(0, events.length - max);
  const shown = hidden > 0 ? events.slice(events.length - max) : events;

  const lines: StyledLine[] = [];
  const glyphs = treeGlyphs(context.capabilities);
  // The subtree hangs under the card's `Tools` branch, so every node is inset by
  // one gutter. Without it the calls line up with the brief and read as peers.
  const indent = glyphs.gutter;

  if (hidden > 0) {
    lines.push(
      fitLine(
        "tree",
        [
          segment(`${indent}${glyphs.gutter}`, { fg: "border.warm" }),
          segment(`… ${hidden} earlier tool call(s) omitted`, { fg: "fg.muted", italic: true }),
        ],
        context,
      ),
    );
  }

  shown.forEach((event, index) => {
    lines.push(
      ...renderToolCall(event, context, {
        tree: { indent, last: index === shown.length - 1 },
      }),
    );
  });
  return lines;
}

function taskStateIcon(state: TimelineTask["state"]): IconName {
  switch (state) {
    case "completed":
      return "success";
    case "failed":
    case "cancelled":
      return "error";
    case "blocked":
      return "warning";
    default:
      return "task";
  }
}

function taskStateToken(state: TimelineTask["state"]): ThemeToken {
  switch (state) {
    case "completed":
      return "accent.green";
    case "failed":
    case "cancelled":
      return "accent.red";
    case "blocked":
    case "waiting":
      return "accent.amber";
    default:
      return "accent.coral";
  }
}

function taskStateLabel(state: TimelineTask["state"]): string {
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

/** §6.11's exact wording for an interrupted await. */
export const AWAIT_INTERRUPTED_MESSAGE =
  "Await interrupted; this subagent continues. Inspect its current state in the context sidebar.";

/** §6.11's abort line. */
export const OPERATION_ABORTED_MESSAGE = "Operation aborted";

// ---------------------------------------------------------------------------
// §6.11 background job completion
// ---------------------------------------------------------------------------

/** §6.11 / AC-25: a green inline notification when a background job finishes. */
export function renderJob(
  item: Pick<TimelineJob, "jobId" | "display" | "state" | "exitCode" | "durationMs" | "summary" | "artifactId">,
  context: BlockContext,
  options: { kind?: "task" | "shell" } = {},
): StyledLine[] {
  const done = item.state === "completed";
  const failed = item.state === "failed";
  const token: ThemeToken = done ? "accent.green" : failed ? "accent.red" : "accent.coral";
  const glyph = done ? "success" : failed ? "error" : "task";

  const label = item.state === "running" ? "Background job running" : `Background job ${item.state}`;
  const head: Segment[] = [
    segment(`${icon(glyph, context.capabilities)} `, { fg: token }),
    segment(label, { fg: token, bold: true }),
    segment(` [${options.kind ?? "shell"}] `, { fg: "fg.muted" }),
    segment(sanitizeInline(item.display, 100), { fg: "fg.primary" }),
  ];
  if (item.durationMs !== undefined) {
    head.push(segment(` (${formatDuration(item.durationMs)})`, { fg: "fg.muted" }));
  }

  const lines = [fitLine("notice", head, context)];

  const detail: Segment[] = [];
  if (item.exitCode !== undefined && item.exitCode !== 0) {
    detail.push(segment(`exit ${item.exitCode}`, { fg: "accent.red" }));
  }
  if (item.summary !== undefined) {
    if (detail.length > 0) detail.push(segment(" · ", { fg: "fg.muted" }));
    detail.push(segment(sanitizeInline(item.summary, 160), { fg: "fg.primary" }));
  }
  if (item.artifactId !== undefined) {
    if (detail.length > 0) detail.push(segment(" · ", { fg: "fg.muted" }));
    detail.push(
      segment(`${icon("artifact", context.capabilities)} ${item.artifactId}`, { fg: "accent.cyan" }),
    );
  }
  if (detail.length > 0) {
    const glyphs = treeGlyphs(context.capabilities);
    lines.push(
      fitLine("notice", [segment(`${glyphs.last} `, { fg: "border.warm" }), ...detail], context),
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// §7.6 approval card
// ---------------------------------------------------------------------------

/**
 * §7.6 / AC-18: the action, the exact command, cwd, risk including network and
 * side effects, the reason, and the offered choices.
 *
 * §6.4 calls this an amber inline decision card — inline, not a modal, per §6.3.
 */
function actionCategoryName(action: string): string {
  const lower = action.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec") || lower.includes("cmd")) {
    return "Bash command";
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create")) {
    return "File write";
  }
  if (lower.includes("read")) {
    return "File read";
  }
  if (lower.includes("net") || lower.includes("fetch") || lower.includes("http")) {
    return "Network request";
  }
  return `${action} request`;
}

function formatChoiceLabel(choice: string): string {
  if (choice === "Allow once") return "Yes";
  if (choice === "Allow for this turn") return "Yes, allow for this turn";
  if (choice === "Allow for this session") return "Yes, allow for this session";
  if (choice === "Always allow this command prefix in this project" || choice.startsWith("Always allow")) {
    return "Yes, and always allow in this project";
  }
  if (choice === "Deny") return "No (Deny)";
  if (choice === "Deny and explain") return "Type here to tell model what to do differently";
  return choice;
}

export function renderApprovalCompact(
  item: Pick<TimelineApproval, "action" | "display" | "riskClass">,
  context: BlockContext,
  options: { selected?: number; offeredScopes?: readonly string[] } = {},
): StyledLine[] {
  const choices = approvalChoices(options.offeredScopes ?? []);
  const selected = options.selected ?? 0;
  const hint = formatChoiceLabel(choices[selected] ?? choices[0] ?? "Allow once");
  const file = item.display.length > 48 ? `…${item.display.slice(-47)}` : item.display;
  return [
    fitLine("approval", [
      segment("🛡️ ", { fg: "accent.amber" }),
      segment(`Allow ${item.action} on `, { fg: "fg.primary" }),
      segment(sanitizeInline(file, 64), { fg: "accent.cyan", bold: true }),
      segment(` [${item.riskClass}] `, { fg: "accent.amber" }),
      segment(`› ${hint}`, { fg: "accent.cyan", bold: true }),
      segment("  (Tab/↑↓/Enter)", { fg: "fg.muted", dim: true }),
    ], context),
  ];
}

export function renderApproval(
  item: Pick<
    TimelineApproval,
    "action" | "display" | "cwd" | "riskClass" | "reason" | "network" | "sideEffects" | "decision" | "decisionReason"
  >,
  context: BlockContext,
  options: { offeredScopes?: readonly string[]; selected?: number; active?: boolean; compact?: boolean } = {},
): StyledLine[] {
  if (options.compact === true && item.decision === undefined) {
    return renderApprovalCompact(item, context, {
      ...(options.selected !== undefined ? { selected: options.selected } : {}),
      ...(options.offeredScopes !== undefined ? { offeredScopes: options.offeredScopes } : {}),
    });
  }

  const glyphs = treeGlyphs(context.capabilities);
  const borderChar = glyphs.horizontal;
  const dividerWidth = Math.max(12, context.columns);
  const lines: StyledLine[] = [];

  // Divider top line
  lines.push(
    fitLine(
      "approval",
      [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })],
      context,
    ),
  );

  // Category Header (e.g. Bash command)
  const category = actionCategoryName(item.action);
  const iconSymbol = category.startsWith("Bash") ? "⚡" : category.startsWith("File") ? "📝" : "🛡️";

  lines.push(
    fitLine(
      "approval",
      [
        segment(`  ${iconSymbol} `, { fg: "accent.cyan" }),
        segment(category, { fg: "accent.cyan", bold: true }),
        segment(`  [${item.riskClass}]`, { fg: "accent.amber" }),
      ],
      context,
    ),
  );

  lines.push(fitLine("approval", [], context));

  // Command / Target display
  lines.push(
    fitLine(
      "approval",
      [
        segment("    ", {}),
        segment(sanitizeInline(item.display, 300), { fg: "fg.primary", bold: true }),
      ],
      context,
    ),
  );

  // Reason / Explanation if distinct
  if (item.reason && item.reason !== item.display) {
    lines.push(
      fitLine(
        "approval",
        [
          segment("    ", {}),
          segment(sanitizeInline(item.reason, 300), { fg: "fg.muted" }),
        ],
        context,
      ),
    );
  }

  if (item.cwd !== undefined) {
    lines.push(
      fitLine(
        "approval",
        [
          segment("    CWD: ", { fg: "fg.muted", dim: true }),
          segment(sanitizeInline(item.cwd, 200), { fg: "fg.muted" }),
        ],
        context,
      ),
    );
  }

  lines.push(fitLine("approval", [], context));

  if (item.decision !== undefined) {
    lines.push(
      fitLine(
        "approval",
        [
          segment("  Decision: ", { fg: "fg.muted" }),
          segment(
            item.decisionReason !== undefined
              ? `${item.decision} — ${sanitizeInline(item.decisionReason, 200)}`
              : item.decision,
            { fg: item.decision.startsWith("allow") ? "accent.green" : "accent.red" },
          ),
        ],
        context,
      ),
    );
    lines.push(
      fitLine(
        "approval",
        [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })],
        context,
      ),
    );
    return lines;
  }

  // Question Prompt
  lines.push(
    fitLine(
      "approval",
      [segment("  Do you want to proceed?", { fg: "fg.primary", bold: true })],
      context,
    ),
  );

  const choices = approvalChoices(options.offeredScopes ?? []);
  const isActive = options.active !== false;
  const selected = isActive ? (options.selected ?? 0) : -1;

  choices.forEach((choice, index) => {
    const active = index === selected;
    const cursor = active ? (context.capabilities.unicode ? "❯ " : "> ") : "  ";
    const numPrefix = `${index + 1}. `;
    const label = formatChoiceLabel(choice);
    const bg: ThemeToken | undefined = active ? "bg.task" : undefined;

    lines.push(
      fitLine(
        "approval",
        [
          segment(`  ${cursor}`, { fg: "accent.cyan", bold: true, ...(bg !== undefined ? { bg } : {}) }),
          segment(numPrefix, active ? { fg: "accent.cyan", bold: true, ...(bg !== undefined ? { bg } : {}) } : { fg: "fg.muted" }),
          segment(label, active ? { fg: "fg.primary", bold: true, ...(bg !== undefined ? { bg } : {}) } : { fg: "fg.muted" }),
        ],
        context,
      ),
    );
  });

  lines.push(fitLine("approval", [], context));

  if (isActive) {
    lines.push(
      fitLine(
        "approval",
        [
          segment("  Esc to cancel", { fg: "fg.muted", dim: true }),
          segment("  •  ", { fg: "fg.muted", dim: true }),
          segment("Tab/↑↓: Move  Enter: Select", { fg: "fg.muted", italic: true }),
        ],
        context,
      ),
    );
  }

  lines.push(
    fitLine(
      "approval",
      [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })],
      context,
    ),
  );

  return lines;
}

/**
 * §7.6's choices, filtered by what the policy actually offers.
 *
 * §13.2 forbids a broad grant for R4–R6, so a card for a destructive action never
 * shows "allow for this project" — the option is absent rather than shown and
 * rejected.
 */
export function approvalChoices(offeredScopes: readonly string[]): string[] {
  const choices = ["Allow once"];
  if (offeredScopes.includes("turn")) choices.push("Allow for this turn");
  if (offeredScopes.includes("session")) choices.push("Allow for this session");
  if (offeredScopes.includes("project")) {
    choices.push("Always allow this command prefix in this project");
  }
  choices.push("Deny", "Deny and explain");
  return choices;
}

// ---------------------------------------------------------------------------
// §6.4 diff summary, notices, plan, final answer
// ---------------------------------------------------------------------------

/** §6.4: file counts plus additions and deletions. */
export function renderDiffSummary(
  item: Pick<TimelineDiff, "files" | "additions" | "deletions">,
  context: BlockContext,
): StyledLine[] {
  const lines: StyledLine[] = [
    fitLine(
      "diff",
      [
        segment(`${icon("tool", context.capabilities)} `, { fg: "accent.cyan" }),
        segment(
          `${item.files.length} file${item.files.length === 1 ? "" : "s"} changed`,
          { fg: "fg.primary", bold: true },
        ),
        segment("  +", { fg: "accent.green" }),
        segment(String(item.additions), { fg: "accent.green" }),
        segment(" -", { fg: "accent.red" }),
        segment(String(item.deletions), { fg: "accent.red" }),
      ],
      context,
    ),
  ];

  const glyphs = treeGlyphs(context.capabilities);
  item.files.forEach((file, index) => {
    const last = index === item.files.length - 1;
    lines.push(
      fitLine(
        "diff",
        [
          segment(`${last ? glyphs.last : glyphs.branch} `, { fg: "border.warm" }),
          segment(file.path, { fg: "fg.primary" }),
          segment(` (+${file.additions} -${file.deletions})`, { fg: "fg.muted" }),
          ...(file.purpose !== undefined
            ? [segment(` — ${sanitizeInline(file.purpose, 80)}`, { fg: "fg.muted" })]
            : []),
        ],
        context,
      ),
    );
  });

  return lines;
}

/** §6.4: standalone amber warning, red abort, green success. */
export function renderNotice(
  item: Pick<TimelineNotice, "level" | "text" | "icon">,
  context: BlockContext,
): StyledLine[] {
  const token: ThemeToken =
    item.level === "error"
      ? "accent.red"
      : item.level === "warning"
        ? "accent.amber"
        : item.level === "success"
          ? "accent.green"
          : "accent.cyan";
  const glyph =
    item.level === "error"
      ? "error"
      : item.level === "warning"
        ? "warning"
        : item.level === "success"
          ? "success"
          : "active";

  let displayText = item.text;
  let causeHint: string | undefined;
  let solutionHint: string | undefined;

  const cleanedDisplay = displayText;
  if (displayText.includes("§") || displayText.toLowerCase().includes("contract")) {
    displayText = displayText.replace(/§\d+(\.\d+)?\s*(contract|spec)?/gi, "").trim();
    if (!displayText) displayText = "An error occurred while processing the task.";
  }

  const lower = item.text.toLowerCase();
  const lowerDisplay = displayText.toLowerCase();
  if (lower.includes("permission denied") || lower.includes("untrusted") || lowerDisplay.includes("permission denied") || lowerDisplay.includes("untrusted")) {
    causeHint = "Cause: the workspace is untrusted or the requested permission was denied.";
    solutionHint = "Fix: trust the workspace and retry. Original: " + cleanedDisplay.slice(0, 200);
  } else if (lower.includes("limit exceeded") || lower.includes("max tool") || lower.includes("too many calls") || lowerDisplay.includes("limit exceeded")) {
    causeHint = "Cause: the agent exceeded its tool-call limit.";
    solutionHint = "Fix: narrow the task or increase the tool-call limit.";
  } else if (lower.includes("reasoning clamped") || lowerDisplay.includes("reasoning clamped")) {
    // Keep system warning as-is; hints would add noise on a non-error notice.
  } else if (item.level === "error" && displayText === cleanedDisplay) {
    // No extra hint
  }

  const lines: StyledLine[] = [
    fitLine(
      "notice",
      [
        segment(`${item.icon ?? icon(glyph, context.capabilities)} `, { fg: token }),
        segment(sanitizeInline(displayText, 400), { fg: token, bold: item.level === "error" }),
      ],
      context,
    ),
  ];

  const glyphs = treeGlyphs(context.capabilities);
  if (causeHint) {
    lines.push(
      fitLine(
        "notice",
        [
          segment(`   ${glyphs.branch} 💡 `, { fg: "accent.amber" }),
          segment(causeHint, { fg: "accent.amber" }),
        ],
        context,
      ),
    );
  }
  if (solutionHint) {
    lines.push(
      fitLine(
        "notice",
        [
          segment(`   ${glyphs.last} 💡 `, { fg: "accent.green" }),
          segment(solutionHint, { fg: "accent.green" }),
        ],
        context,
      ),
    );
  }

  return lines;
}

/**
 * §11.5 plan items with their status, plus the structured Plan Contract when a
 * newer timeline event carries one. The legacy shape remains intentionally small
 * so old journals and golden fixtures render exactly as before.
 */
export function renderPlan(
  item: Pick<TimelinePlan, "items"> & Partial<{
    document: PlanDocumentView;
    planDocument: PlanDocumentView;
    contract: PlanDocumentView;
    approval: PlanContractRenderInput["approval"];
    planApproval: PlanContractRenderInput["planApproval"];
    readiness: PlanContractRenderInput["readiness"];
    planReadiness: PlanContractRenderInput["planReadiness"];
    revision: number;
    digest: string;
  }>,
  context: BlockContext,
): StyledLine[] {
  const structured = item.document !== undefined || item.planDocument !== undefined || item.contract !== undefined;
  const approval = item.approval ?? item.planApproval;
  let currentDigest: string | undefined;
  if (structured) {
    try {
      const document = item.document ?? item.planDocument ?? item.contract;
      currentDigest = document === undefined
        ? undefined
        : planDigest(document as unknown as PlanDocument, item.items);
    } catch {
      currentDigest = undefined;
    }
  }
  const approvalValid = approval !== undefined && currentDigest !== undefined && approval.digest === currentDigest;
  if (approvalValid) {
    return renderNormalTodoList({
      items: item.items,
      ...(item.revision === undefined ? {} : { revision: item.revision }),
      approvedRevision: approval.revision,
    }, context);
  }
  if (structured) {
    return renderPlanContract(item as PlanContractRenderInput, context);
  }
  if (item.items.length === 0) return [];
  const lines: StyledLine[] = [
    // A bare `todo.write` update is a progress checklist, not a switch into
    // Plan mode. Keep its heading aligned with the tool/state name so users do
    // not confuse the two surfaces.
    line("header", [segment("TODO", { fg: "fg.primary", bold: true })]),
  ];
  for (const [index, entry] of item.items.entries()) {
    lines.push(fitLine("body", planItemSegments(entry, index, context), context));
    const detail = entry as typeof entry & {
      readonly details?: string;
      readonly files?: readonly string[];
      readonly symbols?: readonly string[];
      readonly acceptanceCriteria?: readonly string[];
      readonly dependsOn?: readonly string[];
      readonly commands?: readonly string[];
    };
    const addDetail = (label: string, values: readonly string[] | undefined, token: ThemeToken = "fg.muted"): void => {
      if (values === undefined || values.length === 0) return;
      lines.push(fitLine("body", [
        segment("    " + label + ": ", { fg: "fg.muted" }),
        segment(sanitizeInline(values.join(", "), 300), { fg: token }),
      ], context));
    };
    if (detail.details !== undefined) {
      lines.push(fitLine("body", [segment("    details: ", { fg: "fg.muted" }), segment(sanitizeInline(detail.details, 300), { fg: "fg.muted" })], context));
    }
    addDetail("files", detail.files);
    addDetail("symbols", detail.symbols);
    addDetail("acceptance", detail.acceptanceCriteria);
    addDetail("depends on", detail.dependsOn);
    addDetail("commands", detail.commands, "accent.cyan");
  }
  return lines;
}

function planItemSegments(entry: PlanItem, index: number, context: BlockContext): Segment[] {
  const marker: Record<PlanItem["status"], { glyph: string; token: ThemeToken }> = {
    pending: { glyph: context.capabilities.unicode ? "○" : "-", token: "fg.muted" },
    active: { glyph: icon("working", context.capabilities), token: "accent.coral" },
    done: { glyph: icon("success", context.capabilities), token: "accent.green" },
    blocked: { glyph: icon("warning", context.capabilities), token: "accent.amber" },
    skipped: { glyph: context.capabilities.unicode ? "⊘" : "~", token: "fg.muted" },
  };
  const { glyph, token } = marker[entry.status];
  return [
    segment(`${glyph} `, { fg: token }),
    segment(`${index + 1}. `, { fg: "fg.muted" }),
    // §6.5: the status word is present so no-colour output still distinguishes it.
    segment(`[${entry.status}] `, { fg: token }),
    segment(sanitizeInline(entry.text, 200), {
      fg: entry.status === "done" ? "fg.muted" : "fg.primary",
    }),
  ];
}

/**
 * §6.4 / §7.4: the final answer in normal high-contrast text with structured
 * evidence — changed files, verification, delegated tasks, risks, next step.
 *
 * §11.7's report is rendered rather than the model's prose being trusted, which is
 * how AC-50's truthfulness survives to the screen.
 *
 * When `agentId` is present the final belongs to a subagent. These are abbreviated
 * to a single completion line — the full detail already lives in the task card and
 * the `✓ Background job completed` notice, so repeating it clutters the timeline.
 */
export function finalAnswerText(
  item: Pick<TimelineFinal, "answer" | "text" | "report">,
): string {
  const answer = item.answer?.trim();
  return answer && answer.length > 0 ? answer : (item.report?.summary ?? item.text);
}

/** Labels terminal reports without presenting incomplete work as a final answer. */
function finalPresentation(report: CompletionReportView | undefined): {
  readonly title: string;
  readonly iconName: IconName;
  readonly token: ThemeToken;
} {
  switch (report?.status) {
    case "partial":
      return { title: "Partial result", iconName: "warning", token: "accent.amber" };
    case "failed":
      return { title: "Failed result", iconName: "error", token: "accent.red" };
    case "cancelled":
      return { title: "Cancelled result", iconName: "warning", token: "accent.amber" };
    default:
      return { title: "Final answer", iconName: "final", token: "accent.cyan" };
  }
}

export function renderFinal(
  item: Pick<TimelineFinal, "answer" | "text" | "report"> & { agentId?: string },
  context: BlockContext,
): StyledLine[] {
  // ── Subagent final: do not output any text block (notice line suffices) ─
  if (item.agentId !== undefined && item.agentId !== "root") {
    return [];
  }

  // ── Root agent final: full rendering ───────────────────────────────────
  const report = item.report;
  const presentation = finalPresentation(report);
  const borderColor = presentation.token;

  const header: Segment[] = [
    segment(`${icon(presentation.iconName, context.capabilities)} `, { fg: presentation.token }),
    segment(presentation.title, { fg: presentation.token, bold: true }),
  ];

  const innerWidth = Math.max(12, context.columns - 4);
  const innerContext: BlockContext = {
    ...context,
    columns: innerWidth,
  };

  const rawBody: StyledLine[] = [];
  const answerText = finalAnswerText(item);
  rawBody.push(
    ...renderMarkdown(answerText, innerContext, {
      kind: "final",
      style: { fg: "fg.primary" },
    }),
  );
  if (rawBody.length === 0 && report === undefined) {
    rawBody.push(blank());
  }
  if (report !== undefined) {
    if (report.status === "cancelled") {
      const changed = report.changedFiles.length;
      if (changed > 0) {
        rawBody.push(blank());
        rawBody.push(
          fitLine(
            "notice",
            [
              segment(`${icon("warning", innerContext.capabilities)} `, { fg: "accent.amber" }),
              segment(`${changed} file${changed === 1 ? "" : "s"} changed — review before continuing`, {
                fg: "accent.amber",
              }),
            ],
            innerContext,
          ),
        );
      }
    } else {
      rawBody.push(...renderReportEvidence(report, innerContext));
    }
  }

  const gutter = context.capabilities.unicode ? "▎" : "|";
  const dividerWidth = Math.max(12, context.columns);
  const divider = line("header", [
    segment((context.capabilities.unicode ? "━" : "-").repeat(dividerWidth), { fg: "border.warm", dim: true }),
  ]);
  const bodyWithGutter = rawBody.map((styled) =>
    styled.kind === "blank" || styled.segments.length === 0
      ? line("blank", [segment(`${gutter} `, { fg: borderColor })])
      : line(styled.kind, [segment(`${gutter} `, { fg: borderColor }), ...styled.segments])
  );
  const headerLine = fitLine("header", [
    segment(`${gutter} `, { fg: borderColor }),
    ...header,
  ], context);
  return [divider, headerLine, ...bodyWithGutter];
}

export function renderReportEvidence(
  report: CompletionReportView,
  context: BlockContext,
): StyledLine[] {
  const lines: StyledLine[] = [];
  const section = (title: string, token: ThemeToken = "fg.primary"): void => {
    lines.push(blank());
    lines.push(line("header", [segment(title, { fg: token, bold: true })]));
  };

  if (report.status !== "completed") {
    // §6.5 and AC-50: a partial or failed turn says so in words.
    lines.push(blank());
    lines.push(
      fitLine(
        "notice",
        [
          segment(`${icon("warning", context.capabilities)} `, { fg: "accent.amber" }),
          segment(`status: ${report.status}`, { fg: "accent.amber", bold: true }),
        ],
        context,
      ),
    );
  }

  if (report.changedFiles.length > 0) {
    section("Changed");
    for (const file of report.changedFiles) {
      const counts =
        file.additions !== undefined || file.deletions !== undefined
          ? ` (+${file.additions ?? 0} -${file.deletions ?? 0})`
          : "";
      lines.push(
        fitLine(
          "body",
          [
            segment("- ", { fg: "fg.muted" }),
            segment(sanitizeInline(file.path, 120), { fg: "fg.primary" }),
            segment(counts, { fg: "fg.muted" }),
            segment(` — ${sanitizeInline(file.purpose, 120)}`, { fg: "fg.muted" }),
          ],
          context,
        ),
      );
    }
  }

  if (report.verification.length > 0) {
    section("Verification");
    for (const step of report.verification) {
      const token: ThemeToken =
        step.status === "passed"
          ? "accent.green"
          : step.status === "failed"
            ? "accent.red"
            : "accent.amber";
      lines.push(
        fitLine(
          "body",
          [
            segment("- ", { fg: "fg.muted" }),
            segment(sanitizeInline(step.command ?? "check", 120), { fg: "fg.primary" }),
            segment(": ", { fg: "fg.muted" }),
            segment(sanitizeInline(step.status, 20), { fg: token, bold: true }),
            segment(` — ${sanitizeInline(step.evidence, 160)}`, { fg: "fg.muted" }),
          ],
          context,
        ),
      );
    }
  }

  if (report.delegatedTasks.length > 0) {
    section("Delegated");
    for (const task of report.delegatedTasks) {
      lines.push(
        fitLine(
          "body",
          [
            segment("- ", { fg: "fg.muted" }),
            segment(sanitizeInline(task.role, 40), { fg: "accent.coral" }),
            segment(` (${sanitizeInline(task.status, 20)}): `, { fg: "fg.muted" }),
            segment(sanitizeInline(task.summary, 160), { fg: "fg.primary" }),
          ],
          context,
        ),
      );
    }
  }

  if (report.risks.length > 0) {
    section("Risks", "accent.amber");
    for (const risk of report.risks) {
      lines.push(
        fitLine(
          "body",
          [segment("- ", { fg: "fg.muted" }), segment(sanitizeInline(risk, 200), { fg: "accent.amber" })],
          context,
        ),
      );
    }
  }

  if (report.nextStep !== undefined) {
    lines.push(blank());
    lines.push(
      fitLine(
        "body",
        [
          segment("Next step: ", { fg: "fg.muted", bold: true }),
          segment(sanitizeInline(report.nextStep, 200), { fg: "fg.primary" }),
        ],
        context,
      ),
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// §6.19 update banner
// ---------------------------------------------------------------------------

/** §6.19 / AC-41: a non-blocking banner naming the version and the command. */
export function renderUpdateBanner(
  input: { version: string; command?: string },
  context: BlockContext,
): StyledLine[] {
  return [
    line("banner", [segment("Update Available", { fg: "accent.amber", bold: true })]),
    fitLine(
      "banner",
      [
        segment(
          `New version ${input.version} is available. Run: ${input.command ?? "capy update"}`,
          { fg: "fg.primary" },
        ),
      ],
      context,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type ThinkingVisibility = "full" | "summary" | "hidden";
export type ToolDetail = "compact" | "full";
export type SubagentDetail = "drawer" | "inline";

export interface PresentationPolicy {
  readonly thinkingVisibility: ThinkingVisibility;
  readonly toolDetail: ToolDetail;
  readonly subagentDetail: SubagentDetail;
}

export const DEFAULT_PRESENTATION_POLICY: PresentationPolicy = {
  thinkingVisibility: "full",
  toolDetail: "compact",
  subagentDetail: "drawer",
};

export interface TimelineRenderOptions {
  /**
   * Theme/renderer revision used only as a render-cache discriminator. Semantic
   * lines carry theme tokens, so the built-in themes can normally omit it; hosts
   * with theme-specific semantic extensions should pass their theme id here.
   */
  readonly themeId?: string;
  /** Independent disclosure controls shared by fullscreen, plain, and exports. */
  readonly thinkingVisibility?: ThinkingVisibility;
  readonly toolDetail?: ToolDetail;
  readonly subagentDetail?: SubagentDetail;
  /** Deterministic render clock for elapsed task labels. */
  readonly nowMs?: number;
  /** Current root turn, used only to distinguish live from completed Thinking. */
  readonly currentTurnId?: string;
  /** False once the current turn has completed, failed, or been cancelled. */
  readonly turnActive?: boolean;
  /** Collapse task cards to one line each (§6.10). */
  readonly collapseTasks?: boolean;
  /** Internal presentation override used by append-only plain output. */
  readonly compactTasks?: boolean;
  readonly expandDiscovery?: boolean;
  /** Suppress the phase header when the previous item was also assistant text. */
  readonly groupAssistant?: boolean;
  /** Name shown beside the `user` header (§6.7). */
  readonly author?: string;
  /** Show a `HH:MM` badge on each user message. */
  readonly showTimestamps?: boolean;
  /** Model named on a `Thinking...` header (§6.8). */
  readonly modelId?: string;
  /**
   * Elapsed time for the *newest* reasoning phase. Only the last commentary block
   * gets a timer: an older phase's clock has stopped, and re-rendering a frozen
   * duration on every frame reads as though it were still counting.
   */
  readonly reasoningElapsedMs?: number;
  /** Collapse every commentary block except the newest (§6.8). */
  readonly collapseFinishedReasoning?: boolean;
  /** Hide inline mini-diffs, e.g. while the diff viewer is open. */
  readonly hideDiffPreviews?: boolean;
  /** Cap on tool tree nodes per task card. */
  readonly maxToolNodes?: number;
  /**
   * Render delegated calls as chronological siblings of the task anchor.
   * Enabled by default so the conversation reads in the order work happened.
   * Pass false for the compact nested tree view.
   */
  readonly inlineSubagentEvents?: boolean;
  /** Internal card option used by the chronological projection. */
  readonly hideSubagentEvents?: boolean;
  /** Accordion master switch: true = Thinking/Tool collapsed. */
  readonly accordionCollapsed?: boolean;
  /** Accordion collapsed summary per item id. */
  readonly accordionSummaries?: Readonly<Record<string, string>>;
  /** Offered scopes for pending approval card in timeline. */
  readonly offeredScopes?: readonly string[];
  /** Currently selected choice index for pending approval card in timeline. */
  readonly selectedApprovalChoice?: number;
  /** Active approvalId currently receiving user input. */
  readonly activeApprovalId?: string;
  /**
   * Items that stay expanded even while the accordion is collapsed — the live
   * streaming blocks. A collapsed-by-default timeline must still show the work
   * that is happening right now; folding the in-flight phase would hide the
   * only feedback that anything is moving (P1-03).
   */
  readonly accordionExpandedIds?: ReadonlySet<string>;
  /** Progressive disclosure: dim/group successful reads, collapse after threshold. */
  readonly progressiveDisclosure?: boolean;
  /** Group consecutive succeeded reads into one summary line. */
  readonly groupSucceededReads?: boolean;
  /** Current spinner frame for thinking preview. */
  readonly thinkingSpinnerFrame?: number;
  /** Internal flag set when rendering timeline items to distinguish live from finished commentary. */
  readonly isNewestCommentary?: boolean;
}
function firstNonEmptyLines(text: string, limit: number): string[] {
  const rows: string[] = [];
  let start = 0;
  while (start <= text.length && rows.length < limit) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const row = text.slice(start, end).replace(/\r$/u, "");
    if (row.trim().length > 0) rows.push(row);
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

export function resolvePresentationPolicy(
  options: TimelineRenderOptions = {},
): PresentationPolicy {
  return {
    thinkingVisibility:
      options.thinkingVisibility ?? DEFAULT_PRESENTATION_POLICY.thinkingVisibility,
    toolDetail: options.toolDetail ?? DEFAULT_PRESENTATION_POLICY.toolDetail,
    subagentDetail:
      options.subagentDetail ?? DEFAULT_PRESENTATION_POLICY.subagentDetail,
  };
}


/**
 * Render one timeline item.
 *
 * The `TimelineItem` union is discriminated, so this switch is exhaustive by
 * construction: a new event kind added to the reducer will fail to compile here
 * rather than silently rendering nothing.
 */
export function renderTimelineItem(
  item: TimelineItem,
  context: BlockContext,
  options: TimelineRenderOptions = {},
): StyledLine[] {
  switch (item.type) {
    case "user":
      return renderUserMessage(item, context, {
        ...(options.author !== undefined ? { author: options.author } : {}),
        ...(options.showTimestamps !== undefined ? { showTimestamp: options.showTimestamps } : {}),
      });
    case "commentary": {
      const isReasoning = item.variant === "reasoning" || item.variant === "reasoning_summary";
      const policy = resolvePresentationPolicy(options);
      // Reasoning visibility controls provider disclosures (raw text or summaries).
      // It never changes progress or candidate-final text, and it applies while streaming
      // as well as after a turn finishes.
      if (isReasoning && policy.thinkingVisibility === "hidden") return [];
      if (isReasoning && policy.thinkingVisibility === "summary") {
        return renderCommentary(item, context, {
          showHeader: options.groupAssistant !== true,
          ...(options.modelId !== undefined ? { model: options.modelId } : {}),
          ...(options.reasoningElapsedMs !== undefined
            ? { elapsedMs: options.reasoningElapsedMs }
            : {}),
          collapsed: true,
          summary: sanitizeInline(firstNonEmptyLines(item.text, 2).join(" "), 140),
          accordionHint: "  · /setting",
        });
      }      const shouldCollapse = false;
      return renderCommentary(item, context, {
        showHeader: options.groupAssistant !== true,
        ...(options.modelId !== undefined ? { model: options.modelId } : {}),
        ...(options.reasoningElapsedMs !== undefined
          ? { elapsedMs: options.reasoningElapsedMs }
          : {}),
        ...(shouldCollapse
          ? { collapsed: true as const, ...(options.accordionSummaries?.[item.id] !== undefined ? { summary: options.accordionSummaries[item.id] as string } : {}), accordionHint: "  · Ctrl+O to expand" }
          : {}),
      });
    }
    case "final":
      return renderFinal(item, context);
    case "tool_discovery":
      return renderToolDiscovery(item, context, {
        expanded: options.expandDiscovery === true,
        detail: resolvePresentationPolicy(options).toolDetail,
      });
    case "tool": {
      const rendered = renderToolCall(item, context, {
        ...(options.hideDiffPreviews === true ? { hideDiff: true } : {}),
        ...(options.progressiveDisclosure === true ? { dimSucceeded: true } : {}),
      });
      if (resolvePresentationPolicy(options).toolDetail === "full") return rendered;
      return rendered.slice(0, item.status === "failed" ? 3 : 1);
    }
    case "task":
      return renderTaskCard(item, context, {
        ...(options.collapseTasks !== undefined ? { collapsed: options.collapseTasks } : {}),
        compact: options.compactTasks ?? resolvePresentationPolicy(options).subagentDetail === "drawer",
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
        ...(options.hideSubagentEvents === true ? { hideToolTree: true } : {}),
        ...(options.hideSubagentEvents === true ? { hideLiveState: true } : {}),
        ...(options.maxToolNodes !== undefined ? { maxToolNodes: options.maxToolNodes } : {}),
      });
    case "approval": {
      return [];
    }
    case "diff":
      return renderDiffSummary(item, context);
    case "notice":
      return renderNotice(item, context);
    case "plan":
      return renderPlan(item, context);
    case "job":
      return renderJob(item, context);
  }
}

export interface TimelineItemTailRender {
  readonly lines: StyledLine[];
  readonly totalLines?: number;
  readonly sourceLinesRendered: number;
  readonly bounded: boolean;
}

/**
 * Row-bounded renderer for giant Markdown-bearing timeline items.
 *
 * Returns undefined for small/non-Markdown shapes so the normal item cache remains
 * authoritative. Full/plain rendering continues to use renderTimelineItem.
 */
export function renderTimelineItemTail(
  item: TimelineItem,
  context: BlockContext,
  options: TimelineRenderOptions,
  maxLines: number,
  markdownIndex: MarkdownSourceView,
): TimelineItemTailRender | undefined {
  const rows = Math.max(1, Math.floor(maxLines));
  if (item.type === "commentary") {
    const isReasoning = item.variant === "reasoning" || item.variant === "reasoning_summary";
    const policy = resolvePresentationPolicy(options);
    if (isReasoning && policy.thinkingVisibility === "hidden") return undefined;
    if (isReasoning && policy.thinkingVisibility === "summary") {
      const preview = renderCommentary(item, context, {
        showHeader: options.groupAssistant !== true,
        ...(options.modelId !== undefined ? { model: options.modelId } : {}),
        ...(options.reasoningElapsedMs !== undefined
          ? { elapsedMs: options.reasoningElapsedMs }
          : {}),
        collapsed: true,
        summary: sanitizeInline(firstNonEmptyLines(item.text, 2).join(" "), 140),
        accordionHint: "  · /setting",
      });
      return {
        lines: preview.slice(Math.max(0, preview.length - rows)),
        totalLines: preview.length,
        sourceLinesRendered: Math.min(2, firstNonEmptyLines(item.text, 2).length),
        bounded: true,
      };
    }
    const markdown = renderMarkdownSourceTail(
      markdownIndex,
      context,
      !isReasoning
        ? {
            kind: "commentary",
            prefix: "  ",
            style: { fg: "fg.muted", italic: true },
          }
        : {
            kind: "reasoning",
            prefix: "  ",
            style: { fg: "fg.muted", italic: true },
          },
      rows,
    );
    const header =
      options.groupAssistant !== true && item.variant !== "candidate_final"
        ? [
            fitLine(
              "header",
              commentaryHeader(item.variant, context, {
                ...(options.modelId !== undefined ? { model: options.modelId } : {}),
                ...(options.reasoningElapsedMs !== undefined
                  ? { elapsedMs: options.reasoningElapsedMs }
                  : {}),
              }),
              context,
            ),
          ]
        : [];
    const complete =
      markdown.totalLines !== undefined
        ? [...header, ...markdown.lines]
        : markdown.lines;
    const totalLines =
      markdown.totalLines !== undefined
        ? markdown.totalLines + header.length
        : undefined;
    return {
      lines: complete.slice(Math.max(0, complete.length - rows)),
      ...(totalLines !== undefined ? { totalLines } : {}),
      sourceLinesRendered: markdown.sourceLinesRendered,
      bounded: markdown.bounded,
    };
  }

  if (item.type !== "final" || (item.agentId !== undefined && item.agentId !== "root")) {
    return undefined;
  }

  const presentation = finalPresentation(item.report);
  const borderColor = presentation.token;
  const innerContext: BlockContext = {
    ...context,
    columns: Math.max(12, context.columns - 4),
  };
  const gutter = context.capabilities.unicode ? "▎" : "|";
  const dividerWidth = Math.max(12, context.columns);
  const fixed: StyledLine[] = [
    line("header", [
      segment((context.capabilities.unicode ? "━" : "-").repeat(dividerWidth), {
        fg: "border.warm",
        dim: true,
      }),
    ]),
    fitLine(
      "header",
      [
        segment(`${gutter} `, { fg: borderColor }),
        segment(`${icon(presentation.iconName, context.capabilities)} `, { fg: presentation.token }),
        segment(presentation.title, { fg: presentation.token, bold: true }),
      ],
      context,
    ),
  ];

  const reportBody: StyledLine[] = [];
  const report = item.report;
  if (report !== undefined) {
    if (report.status === "cancelled") {
      const changed = report.changedFiles.length;
      if (changed > 0) {
        reportBody.push(blank());
        reportBody.push(
          fitLine(
            "notice",
            [
              segment(`${icon("warning", innerContext.capabilities)} `, {
                fg: "accent.amber",
              }),
              segment(
                `${changed} file${changed === 1 ? "" : "s"} changed — review before continuing`,
                { fg: "accent.amber" },
              ),
            ],
            innerContext,
          ),
        );
      }
    } else {
      reportBody.push(...renderReportEvidence(report, innerContext));
    }
  }

  const withGutter = (styled: StyledLine): StyledLine =>
    styled.kind === "blank" || styled.segments.length === 0
      ? line("blank", [segment(`${gutter} `, { fg: borderColor })])
      : line(styled.kind, [
          segment(`${gutter} `, { fg: borderColor }),
          ...styled.segments,
        ]);
  const reportLines = reportBody.map(withGutter);
  if (reportLines.length >= rows) {
    return {
      lines: reportLines.slice(-rows),
      sourceLinesRendered: 0,
      bounded: true,
    };
  }

  const markdown = renderMarkdownSourceTail(
    markdownIndex,
    innerContext,
    { kind: "final", style: { fg: "fg.primary" } },
    Math.max(1, rows - reportLines.length),
  );
  const body = [...markdown.lines.map(withGutter), ...reportLines];
  const complete = markdown.totalLines !== undefined ? [...fixed, ...body] : body;
  const totalLines =
    markdown.totalLines !== undefined
      ? fixed.length + markdown.totalLines + reportLines.length
      : undefined;
  return {
    lines: complete.slice(Math.max(0, complete.length - rows)),
    ...(totalLines !== undefined ? { totalLines } : {}),
    sourceLinesRendered: markdown.sourceLinesRendered,
    bounded: markdown.bounded,
  };
}

function isSucceededRead(item: TimelineItem): boolean {
  return (
    item.type === "tool" &&
    item.status === "succeeded" &&
    ["fs.read", "fs.read_many", "fs.list", "fs.search", "fs.grep"].includes(
      item.toolId,
    )
  );
}

function groupSucceededReads(items: readonly TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let buffer: TimelineItem[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) { out.push(buffer[0]!); buffer = []; return; }
    if (buffer.length <= 2) { out.push(...buffer); buffer = []; return; }
    const names = buffer.map((i) => (i.type === "tool" ? i.argumentsSummary.split(" ")[0] ?? i.toolId : "")).filter(Boolean).slice(0, 3);
    const summary = names.join(", ") + (buffer.length > 3 ? ` +${buffer.length - 3} more` : "");
    out.push({
      type: "tool",
      id: `group-read-${buffer[0]!.id}`,
      sequence: buffer[0]!.sequence,
      callId: buffer[0]!.type === "tool" ? buffer[0]!.callId : "",
      toolId: "fs.read",
      argumentsSummary: `${buffer.length} files (${summary})`,
      status: "succeeded",
      summary: `Read ${buffer.length} files`,
    } as TimelineItem);
    buffer = [];
  };
  for (const item of items) {
    if (isSucceededRead(item)) buffer.push(item);
    else { flush(); out.push(item); }
  }
  flush();
  return out;
}

function mergeConsecutiveCommentary(items: readonly TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.type === "commentary" &&
      item.type === "commentary" &&
      last.variant === item.variant &&
      last.turnId === item.turnId &&
      last.agentId === item.agentId &&
      // Only durable fragments explicitly tied to the same provider item can
      // share a rendered block. Missing IDs are not evidence of sameness.
      last.itemId !== undefined &&
      last.itemId === item.itemId
    ) {
      out[out.length - 1] = { ...last, text: `${last.text}\n\n${item.text}` } as TimelineItem;
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * Project durable events into the single semantic timeline consumed by every
 * renderer. Rendering may clip or style these blocks, but it must not invent a
 * different visibility or grouping policy.
 */
export function projectTimeline(
  items: readonly TimelineItem[],
  options: TimelineRenderOptions = {},
): TimelineItem[] {
  const policy = resolvePresentationPolicy(options);
  const inlineChildren =
    policy.subagentDetail === "inline" || options.inlineSubagentEvents === true;
  const expanded = inlineChildren
    ? expandChronologicalTimeline(items)
    : items
        .map((item, order) => ({ item, order }))
        .sort(
          (left, right) => left.item.sequence - right.item.sequence || left.order - right.order,
        )
        .map(({ item }) => item);
  const visible = expanded.filter(
    (item) =>
      item.type !== "approval" &&
      !(
        (item.type === "commentary" || item.type === "final") &&
        item.agentId !== undefined &&
        item.agentId !== "root"
      ) &&
      !(
        item.type === "tool" &&
        item.agentId !== undefined &&
        item.agentId !== "root" &&
        policy.subagentDetail === "drawer"
      ),
  );
  // `plan.created`/`plan.updated` are durable snapshots, not separate user-facing
  // plans. Keep them all in the view model for replay/export, but project only the
  // newest snapshot so every revision cannot repeat the contract or TODO list.
  const latestPlan = visible.reduce(
    (latest, item, index) => item.type === "plan" ? index : latest,
    -1,
  );
  const projected = latestPlan < 0
    ? visible
    : visible.filter((item, index) => item.type !== "plan" || index === latestPlan);
  const shouldGroupReads =
    options.groupSucceededReads ??
    (options.progressiveDisclosure === true || policy.toolDetail === "compact");
  return mergeConsecutiveCommentary(
    shouldGroupReads ? groupSucceededReads(projected) : projected,
  );
}

/** Render a whole timeline, blank-separating blocks. */
export function renderTimeline(
  items: readonly TimelineItem[],
  context: BlockContext,
  options: TimelineRenderOptions = {},
): StyledLine[] {
  const lines: StyledLine[] = [];
  let previousWasAssistant = false;

  // A task owns its child events in the reducer so the sidebar can derive one
  // coherent task state. That storage shape must not dictate the conversation
  // layout, though: delegated calls belong directly after the event that preceded
  // them. Expand the child events into render-only tool blocks and order the result
  // by the journal sequence. The original view model stays untouched for replay.
  const orderedItems = projectTimeline(items, options);

  // Only the newest reasoning phase is live; every earlier one has stopped.
  const newestCommentary = lastIndexOfType(orderedItems, "commentary");

  for (const [index, item] of orderedItems.entries()) {
    const isAssistant = item.type === "commentary";
    const isNewestCommentary = isAssistant && index === newestCommentary;

    const perItem: TimelineRenderOptions = {
      ...options,
      isNewestCommentary,
      groupAssistant: options.groupAssistant === true && isAssistant && previousWasAssistant,
      ...(options.inlineSubagentEvents === true || item.type !== "task"
        ? {}
        : { hideSubagentEvents: true }),
    };
    if (isAssistant && !isNewestCommentary) {
      // A finished phase shows no timer, and folds to its header when asked.
      delete (perItem as { reasoningElapsedMs?: number }).reasoningElapsedMs;
    }

    const rendered = renderTimelineItem(item, context, perItem);

    if (rendered.length === 0) continue;
    if (lines.length > 0) lines.push(blank());
    lines.push(...rendered);
    previousWasAssistant = isAssistant;
  }
  return lines;
}

/**
 * Render only the tail needed for a viewport.
 *
 * Full-screen frames ask for a bounded number of rows. Rendering the complete
 * history before slicing it defeats that bound and makes a redraw increasingly
 * expensive as a session grows, especially when a keypress requests a composer
 * repaint while a turn is active.
 */
export function renderTimelineWindow(
  items: readonly TimelineItem[],
  context: BlockContext,
  options: TimelineRenderOptions = {},
  maxLines: number,
  scrollOffsetFromBottom = 0,
): StyledLine[] {
  return renderTimelineWindowDetails(
    items,
    context,
    options,
    maxLines,
    scrollOffsetFromBottom,
  ).lines;
}

export function renderTimelineWindowDetails(
  items: readonly TimelineItem[],
  context: BlockContext,
  options: TimelineRenderOptions = {},
  maxLines: number,
  scrollOffsetFromBottom = 0,
): { readonly lines: StyledLine[]; readonly totalLines?: number } {
  const viewport = Math.max(1, maxLines);
  const offset = Math.max(0, scrollOffsetFromBottom);
  const budget = viewport + offset;
  if (items.length === 0) return { lines: [], totalLines: 0 };

  const orderedItems = projectTimeline(items, options);
  const newestCommentary = lastIndexOfType(orderedItems, "commentary");
  const chunks: StyledLine[][] = [];
  let total = 0;
  let reachedStart = false;

  for (let index = orderedItems.length - 1; index >= 0; index -= 1) {
    const item = orderedItems[index];
    if (item === undefined) continue;
    if (index === 0) reachedStart = true;

    const isAssistant = item.type === "commentary";
    const isNewestCommentary = isAssistant && index === newestCommentary;
    const previousIsAssistant = orderedItems[index - 1]?.type === "commentary";
    const perItem: TimelineRenderOptions = {
      ...options,
      isNewestCommentary,
      groupAssistant: options.groupAssistant === true && isAssistant && previousIsAssistant,
      ...(options.inlineSubagentEvents === true || item.type !== "task"
        ? {}
        : { hideSubagentEvents: true }),
    };
    if (isAssistant && !isNewestCommentary) {
      delete (perItem as { reasoningElapsedMs?: number }).reasoningElapsedMs;
    }

    const rendered = renderTimelineItem(item, context, perItem);

    if (rendered.length === 0) continue;
    chunks.push(rendered);
    total += rendered.length + (chunks.length > 1 ? 1 : 0);
    if (total >= budget) break;
  }

  if (chunks.length === 0) {
    return reachedStart ? { lines: [], totalLines: total } : { lines: [] };
  }
  const lines: StyledLine[] = [];
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (lines.length > 0) lines.push(blank());
    lines.push(...(chunks[index] as StyledLine[]));
  }
  return reachedStart ? { lines, totalLines: total } : { lines };
}

export const SUBAGENT_INLINE_VISIBLE = 3;

/**
 * Project nested delegated calls into the same ordered stream as parent work.
 *
 * This is deliberately a render-time projection rather than a reducer mutation:
 * the nested copy remains useful to the sidebar and to the compact task-card view,
 * while the primary conversation no longer gathers all child output in one place.
 *
 * UX: subagent work is indented and capped — only the newest 2–3 calls per task
 * are inlined, older ones are summarized. This keeps the main timeline readable
 * and makes subagent noise visibly distinct from the main agent's final answer.
 */
function expandChronologicalTimeline(items: readonly TimelineItem[]): TimelineItem[] {
  const expanded: Array<{ item: TimelineItem; order: number }> = [];
  let order = 0;

  for (const item of items) {
    expanded.push({ item, order: order++ });
    if (item.type !== "task") continue;
    if (item.role === "subagent") continue;
    const events = item.subagentEvents;
    if (events.length === 0) continue;
    const hidden = Math.max(0, events.length - SUBAGENT_INLINE_VISIBLE);
    if (hidden > 0 && SUBAGENT_INLINE_VISIBLE > 0) {
      expanded.push({
        item: {
          type: "notice",
          id: `${item.id}::subagent-hidden`,
          sequence: items[items.length - 1] !== undefined
          ? items[items.length - 1]!.sequence
          : item.sequence,
          level: "info",
          text: `↳ subagent ${item.role || item.title} — … ${hidden} earlier tool call(s) hidden · showing last ${SUBAGENT_INLINE_VISIBLE}`,
          icon: "…",
        } as TimelineItem,
        order: order++,
      });
    }
    const visible = hidden > 0 ? events.slice(-SUBAGENT_INLINE_VISIBLE) : events;
    for (const event of visible) {
      expanded.push({
        item: {
          type: "tool",
          id: event.id,
          sequence: event.sequence,
          callId: event.callId,
          toolId: event.toolId,
          argumentsSummary: event.argumentsSummary,
          agentId: item.taskId,
          status: event.status,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
          ...(event.progress !== undefined ? { progress: event.progress } : {}),
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(event.additions !== undefined ? { additions: event.additions } : {}),
          ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
          ...(event.artifacts !== undefined ? { artifacts: [...event.artifacts] } : {}),
          ...(event.diffPreview !== undefined ? { diffPreview: [...event.diffPreview] } : {}),
        },
        order: order++,
      });
    }
  }

  expanded.sort((left, right) => left.item.sequence - right.item.sequence || left.order - right.order);
  return expanded.map(({ item }) => item);
}

function lastIndexOfType(items: readonly TimelineItem[], type: TimelineItem["type"]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === type) return index;
  }
  return -1;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function renderInputPrompt(
  promptReq: { readonly label: string; text: string; cursor: number },
  context: BlockContext,
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  const borderChar = glyphs.horizontal;
  const dividerWidth = Math.max(12, context.columns);
  const lines: StyledLine[] = [];

  lines.push(
    fitLine("approval", [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })], context),
  );

  lines.push(
    fitLine("approval", [
      segment("  ✏️  ", { fg: "accent.cyan" }),
      segment(promptReq.label, { fg: "fg.primary", bold: true }),
    ], context),
  );

  lines.push(fitLine("approval", [], context));

  const beforeCursor = promptReq.text.slice(0, promptReq.cursor);
  const atCursor = promptReq.text.slice(promptReq.cursor, promptReq.cursor + 1) || " ";
  const afterCursor = promptReq.text.slice(promptReq.cursor + 1);

  lines.push(
    fitLine("approval", [
      segment("  ❯ ", { fg: "accent.cyan", bold: true }),
      segment(beforeCursor, { fg: "fg.primary" }),
      segment(atCursor, { fg: "bg.base", bg: "accent.cyan" }),
      segment(afterCursor, { fg: "fg.primary" }),
    ], context),
  );

  lines.push(fitLine("approval", [], context));

  lines.push(
    fitLine("approval", [
      segment("  Enter to submit", { fg: "fg.muted", dim: true }),
      segment("  •  ", { fg: "fg.muted", dim: true }),
      segment("Esc to cancel", { fg: "fg.muted", dim: true }),
    ], context),
  );

  lines.push(
    fitLine("approval", [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })], context),
  );

  return lines;
}

/**
 * Render a user choice request inside the full-screen TUI.
 *
 * The host selector writes directly to the terminal. That races OpenTUI's
 * alternate-screen renderer and lets terminal auto-wrap create stale rows.
 * Keeping the request as width-aware semantic lines prevents that collision.
 */
export function renderUserAsk(
  input: {
    readonly question: string;
    readonly choices: readonly string[];
    readonly selected?: number;
  },
  context: BlockContext,
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  const borderChar = glyphs.horizontal;
  const dividerWidth = Math.max(12, context.columns);
  const lines: StyledLine[] = [
    fitLine("approval", [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })], context),
    fitLine("approval", [
      segment("  ?  ", { fg: "accent.cyan" }),
      segment("Question", { fg: "accent.cyan", bold: true }),
    ], context),
    ...bodyLines(sanitizeInline(input.question, 2_000), context, {
      indent: "    ",
      kind: "approval",
      style: { fg: "fg.primary", bold: true },
    }),
    fitLine("approval", [], context),
  ];

  const selected = input.selected ?? 0;
  for (const [index, choice] of input.choices.entries()) {
    const active = index === selected;
    const prefix = active ? `  > ${index + 1}. ` : `    ${index + 1}. `;
    const continuation = " ".repeat(stringWidth(prefix));
    const style: import("./segments.ts").SegmentStyle = active
      ? { fg: "fg.primary", bold: true, bg: "bg.task" }
      : { fg: "fg.muted" };
    for (const [rowIndex, row] of wrapBody(sanitizeInline(choice, 200), context, prefix).entries()) {
      lines.push(
        fitLine("approval", [
          segment(
            rowIndex === 0 ? prefix : continuation,
            active ? { fg: "accent.cyan", bold: true, bg: "bg.task" } : { fg: "fg.muted" },
          ),
          segment(row, style),
        ], context),
      );
    }
  }

  lines.push(fitLine("approval", [], context));
  lines.push(
    fitLine("approval", [
      segment("  Esc to cancel", { fg: "fg.muted", dim: true }),
      segment("  /  ", { fg: "fg.muted", dim: true }),
      segment("Up/Down or Tab: Move  Enter: Select", { fg: "fg.muted", italic: true }),
    ], context),
  );
  lines.push(
    fitLine("approval", [segment(borderChar.repeat(dividerWidth), { fg: "border.warm", dim: true })], context),
  );

  return lines;
}

export { truncateToWidth };
