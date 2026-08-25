/**
 * Frame rendering — P1-02 split of the former `InteractiveUi` god class.
 *
 * The FrameRenderer half: composes home and session frames from the semantic
 * blocks in `@cbc/tui-components` (the same `composeScreen` the golden tests
 * exercise), paints backgrounds, overlays toasts, and resolves the caret.
 * Pure functions only — no terminal, no state.
 */

import {
  planDigest,
  type PlanDocument,
  type PlanItem,
  type SessionViewModel,
} from "@cbc/session-domain";
import {
  blockContext,
  computePreparedViewport,
  joinColumns,
  prepareScreen,
  fitLine,
  line,
  planLayout,
  renderComposer,
  renderCompletionPopup,
  renderToast,
  segment,
  sanitizeInline,
  stringWidth,
  graphemes,
  compactPath,
  computePlanReadiness,
  truncateToWidth,
  wrapComposer,
  type BlockContext,
  type CompletionPopupOptions,
  type CompletionState,
  type ComposerMetricsView,
  type GitStatusView,
  type ProjectedTimeline,
  type TimelineStreamingView,
  type Segment,
  type SidebarService,
  type PlanDocumentView,
  type SubagentDetail,
  type StyledLine,
  type TerminalCapabilities,
  type Theme,
  type ThinkingVisibility,
  type ThinkingMode,
  type ToastState,
  type ToolDetail,
} from "@cbc/tui-components";

import type { TerminalCursorPosition } from "./opentui-view.ts";

export interface FrameLineOptions {
  readonly columns: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly capabilities: TerminalCapabilities;
}

export interface HomeFrameOptions extends FrameLineOptions {
  readonly version: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly interactionMode?: "build" | "plan";
  readonly pendingInteractionMode?: "build" | "plan";
  readonly mcpCount: number;
  readonly composer: { text: string; cursor: number; metrics?: ComposerMetricsView };
  readonly notices: readonly string[];
  readonly completion?: CompletionState;
  readonly overlay?: readonly StyledLine[];
}

export interface SessionFrameOptions extends FrameLineOptions {
  readonly model: SessionViewModel;
  readonly composer: { text: string; cursor: number; metrics?: ComposerMetricsView };
  readonly completion?: CompletionState;
  readonly sidebarVisible?: boolean;
  readonly sidebarTitle?: string;
  readonly mcpServers: readonly SidebarService[];
  readonly lspServers: readonly SidebarService[];
  readonly provider?: string;
  readonly workspacePath: string;
  readonly git?: GitStatusView;
  readonly notices: readonly string[];
  readonly timelineScrollOffsetFromBottom: number;
  readonly timelineMaxScrollOffsetHint?: number;
  /** Session-scoped incremental projection reused across fullscreen frames. */
  readonly timelineProjection?: ProjectedTimeline;
  readonly streamingViews?: readonly TimelineStreamingView[];
  /**
   * P0-07 / P0-08: when an overlay or an approval card is open, its pre-rendered
   * lines replace the timeline body for this frame. The overlay is a lens over
   * live state — the composer, status bar, and sidebar stay where they are.
   */
  readonly overlay?: readonly StyledLine[];
  readonly overlayScrollOffset?: number;
  /** Spinner frame passed to the semantic live-state renderer. */
  readonly liveFrame?: number;
  /** §21.4 `ui.showCost` override, forwarded to the layout plan (P1-02). */
  readonly showCost?: boolean;
  /** §21.4 `ui.statusDensity` override, forwarded to the layout plan (P1-02). */
  readonly statusDensity?: "auto" | "compact" | "full";
  readonly accordionCollapsed?: boolean;
  readonly finalAnswerStyle?: "chat" | "report";
  readonly completionEvidenceMode?: "hidden" | "collapsed" | "expanded";
  readonly completionEvidenceExpanded?: boolean;
  readonly completionAttentionDetails?: boolean;
  readonly thinkingVisibility?: ThinkingVisibility;
  readonly thinkingMode?: ThinkingMode;
  readonly toolDetail?: ToolDetail;
  readonly subagentDetail?: SubagentDetail;
  readonly nowMs?: number;
  readonly offeredScopes?: readonly string[];
  readonly selectedApprovalChoice?: number;
  readonly activeApprovalId?: string;
  readonly approvalCard?: readonly StyledLine[];
  /** Effective permission axes shown on the status bar. */
  readonly permissionDetail?: string;
  readonly sessionId?: string;
  readonly credentialSource?: string;
  readonly helpHint?: string;
}

function interactionModeLabel(mode: "build" | "plan" | undefined): string {
  return mode === "plan" ? "Plan" : "Build";
}

type ModeAccent = "accent.coral" | "accent.cyan";

function modeAccent(mode: "build" | "plan" | undefined): ModeAccent {
  return mode === "plan" ? "accent.cyan" : "accent.coral";
}

function modeTransitionLabel(model: SessionViewModel): string {
  const current = interactionModeLabel(model.modeState.activeTurn ?? model.modeState.selected);
  return model.modeState.pending === undefined
    ? current
    : `${current} -> ${interactionModeLabel(model.modeState.pending)} next`;
}

/**
 * The view-model fields below are optional on purpose. Older snapshots only carry
 * `todo.approvedRevision`; that field is display-only and must not be advertised as
 * an execution approval. New snapshots carry a digest-bound `planApproval` and
 * readiness diagnostics. Keeping the adapter structural lets old sessions paint
 * while the durable model is upgraded.
 */
type PlanControlModel = Pick<SessionViewModel, "modeState"> & {
  readonly todo?: unknown;
  readonly plan?: unknown;
  readonly planContract?: unknown;
  readonly planDocument?: unknown;
  readonly planApproval?: unknown;
  readonly planReadiness?: unknown;
};

function planControlRecord(model: PlanControlModel): Record<string, unknown> {
  return model as unknown as Record<string, unknown>;
}

function planControlParts(model: PlanControlModel): Segment[] {
  if (model.modeState.selected !== "plan") return [];
  const root = planControlRecord(model);
  const todo = typeof root.todo === "object" && root.todo !== null
    ? root.todo as Record<string, unknown>
    : undefined;
  const contract = typeof root.planContract === "object" && root.planContract !== null
    ? root.planContract as Record<string, unknown>
    : typeof root.planDocument === "object" && root.planDocument !== null
      ? { document: root.planDocument }
      : todo?.document !== undefined
        ? {
            document: todo.document,
            revision: todo.revision,
            ...(todo.approval !== undefined ? { approval: todo.approval } : {}),
          }
        : undefined;
  const readinessRaw = (contract !== undefined && typeof contract.readiness === "object" && contract.readiness !== null
    ? contract.readiness
    : root.planReadiness) as Record<string, unknown> | undefined;
  const rawDocument = contract?.document ?? todo?.document;
  const rawItems = Array.isArray(todo?.items) ? todo.items : [];
  let derivedReadiness: { readonly ready: boolean; readonly blockers?: readonly string[] } | undefined;
  if (typeof rawDocument === "object" && rawDocument !== null && Array.isArray((rawDocument as Record<string, unknown>).context) && Array.isArray((rawDocument as Record<string, unknown>).criticalFiles) && Array.isArray((rawDocument as Record<string, unknown>).verification)) {
    try {
      derivedReadiness = computePlanReadiness(rawDocument as PlanDocumentView, rawItems as never);
    } catch {
      derivedReadiness = { ready: false, blockers: ["structured Plan Contract is malformed"] };
    }
  } else if (rawDocument === undefined && rawItems.length > 0) {
    derivedReadiness = { ready: false, blockers: ["structured Plan Contract is missing"] };
  }
  const blockers = Array.isArray(readinessRaw?.blockers)
    ? readinessRaw.blockers.filter((entry): entry is string => typeof entry === "string")
    : [...(derivedReadiness?.blockers ?? [])];
  const approval = (contract !== undefined && typeof contract.approval === "object" && contract.approval !== null
    ? contract.approval
    : typeof root.planApproval === "object" && root.planApproval !== null
      ? root.planApproval
      : todo?.approval) as Record<string, unknown> | undefined;
  const digest = typeof approval?.digest === "string" && approval.digest.length > 0
    ? approval.digest
    : undefined;
  let currentDigest: string | undefined;
  if (rawDocument !== undefined) {
    try {
      currentDigest = planDigest(
        rawDocument as unknown as PlanDocument,
        rawItems as unknown as readonly PlanItem[],
      );
    } catch {
      currentDigest = undefined;
    }
  }
  const ready = typeof readinessRaw?.ready === "boolean" ? readinessRaw.ready : (derivedReadiness?.ready ?? true);
  // The digest, rather than a flat TODO revision, is the execution contract. A
  // progress update may advance `currentRevision` while preserving approval;
  // a changed contract must never paint as approved.
  const approvedScope = digest !== undefined && currentDigest !== undefined && digest === currentDigest;
  const approved = ready && blockers.length === 0 && approvedScope;

  if (approved) {
    return [
      segment("Plan approved", { fg: "accent.green", bold: true }),
      segment("  ·  ", { fg: "fg.muted" }),
      segment("Shift+Tab to proceed", { fg: "accent.cyan" }),
    ];
  }
  if (approvedScope && (!ready || blockers.length > 0)) {
    const reason = blockers[0] !== undefined ? `  ·  ${sanitizeInline(blockers[0], 100)}` : "";
    return [
      segment("Plan execution blocked", { fg: "accent.amber", bold: true }),
      segment(reason, { fg: "accent.amber" }),
      segment("  ·  type feedback + Enter", { fg: "accent.cyan" }),
    ];
  }

  if (!ready || blockers.length > 0) {
    const reason = blockers[0] !== undefined ? `  ·  ${sanitizeInline(blockers[0], 100)}` : "";
    return [
      segment("Plan needs work", { fg: "accent.amber", bold: true }),
      segment(reason, { fg: "accent.amber" }),
      segment("  ·  type feedback + Enter", { fg: "accent.cyan" }),
    ];
  }
  return [
    segment("Plan ready", { fg: "accent.cyan", bold: true }),
    segment("  ·  ", { fg: "fg.muted" }),
    segment("Choose an option below", { fg: "accent.cyan" }),
  ];
}

/** Plan-mode actions stay visible in both fullscreen and append-only renderers. */
export function renderPlanControls(
  model: PlanControlModel,
  context: BlockContext,
): StyledLine[] {
  const parts = planControlParts(model);
  return parts.length > 0 ? [fitLine("notice", parts, context)] : [];
}

/** The home-screen banner spells the product name, not a predecessor's (P2). */
export const CAPYBARA_BANNER = [
  "██████   ██████    ██████   ██    ██  ██████   ██████    ██████    ██████  ",
  "██  ██   ██    ██  ██   ██   ██  ██   ██   ██  ██    ██  ██   ██   ██    ██",
  "██       ████████  ██████     ████    ██████   ████████  ██████    ████████",
  "██  ██   ██    ██  ██         ██      ██   ██  ██    ██  ██   ██   ██    ██",
  "██████   ██    ██  ██         ██      ██████   ██    ██  ██    ██  ██    ██",
];

export function renderHomeFrame(input: HomeFrameOptions): StyledLine[] {
  if (input.columns < 40) return renderEmergencyHomeFrame(input);
  if (input.rows < 16 && input.columns >= 56) return renderLegacyHomeFrame(input);
  const lines = Array.from({ length: input.rows }, () => line("blank", []));
  const maxPanelWidth = Math.max(1, input.columns - (input.columns < 40 ? 0 : 4));
  // Keep the primary interaction surface substantial on large desktop
  // terminals while retaining a two-column gutter on narrow viewports.
  const desiredPanelWidth = Math.min(132, Math.max(52, Math.floor(input.columns * 0.70)));
  const panelWidth = Math.min(maxPanelWidth, desiredPanelWidth);
  const hasText = input.composer.text.length > 0;
  const minimumComposerRows = 1;

  const composerRows = wrapComposer(
    hasText ? input.composer.text : "Ask anything",
    Math.max(1, panelWidth - 4),
    4,
    hasText ? input.composer.metrics : undefined,
  );
  while (composerRows.length < minimumComposerRows) composerRows.push("");
  const composerAccent = modeAccent(input.interactionMode);

  let logoLines: StyledLine[] = [];
  const bannerWidth = CAPYBARA_BANNER.reduce(
    (maximum, bannerLine) => Math.max(maximum, stringWidth(bannerLine)),
    0,
  );
  if (input.columns >= bannerWidth && input.capabilities.unicode) {
    logoLines = CAPYBARA_BANNER.map((bannerLine) =>
      centerLine(input.columns, "header", [
        segment(bannerLine, { fg: "accent.amber", bold: true }),
      ]),
    );
  } else {
    logoLines = [
      centerLine(input.columns, "header", [
        segment("Capybara Code", { fg: "accent.amber", bold: true }),
      ]),
    ];
  }

  const completionLines =
    input.completion?.open === true
      ? renderPanelCompletion(
          input.completion,
          input.capabilities,
          input.columns,
          panelWidth,
          Math.max(2, Math.min(6, input.rows - 12)),
        )
      : [];
  const noticeLines =
    input.notices.length > 0
      ? input.notices.slice(-2).map((notice) => {
          const isWarning = notice.startsWith("⚠") || notice.startsWith("!") || notice.toLowerCase().startsWith("warning");
          const cleanText = notice.replace(/^[⚠!]\s*/, "");
          const truncated = truncateToWidth(cleanText, Math.max(12, Math.min(panelWidth - 4, input.columns - 8)));
          return centerLine(
            input.columns,
            "notice",
            isWarning
              ? [segment("⚠ ", { fg: "accent.amber" }), segment(truncated, { fg: "fg.muted" })]
              : [segment(truncated, { fg: "fg.muted" })],
          );
        })
      : [];

  const hintText = "tab completion   ctrl+p commands";
  const hintMargin = Math.max(0, Math.floor((input.columns - panelWidth) / 2));
  const hintGap = Math.max(0, panelWidth - stringWidth(hintText) - 2);
  const guidanceLine: StyledLine = line("composer", [
    segment(" ".repeat(hintMargin + hintGap + 2), {}),
    segment("tab", { fg: "fg.primary" }),
    segment(" completion   ", { fg: "fg.muted" }),
    segment("ctrl+p", { fg: "fg.primary" }),
    segment(" commands", { fg: "fg.muted" }),
  ]);

  const composerContent: StyledLine[] = [
    panelBorder(input.columns, panelWidth, "", true, input.capabilities.unicode, true, composerAccent),
    ...composerRows.map((value, index) =>
      panelRow(input.columns, panelWidth, "composer", [
        segment(index === 0 ? "> " : "  ", { fg: composerAccent, bold: index === 0 }),
        segment(value, {
          fg: hasText ? "fg.primary" : "fg.muted",
          italic: !hasText && index === 0,
        }),
      ], true, composerAccent),
    ),
    panelRow(input.columns, panelWidth, "composer", [
       segment(interactionModeLabel(input.interactionMode), { fg: composerAccent, bold: true }),
      segment("  ", { bg: "bg.panel" }),
      segment(input.model, { fg: "fg.primary" }),
      segment("  ", { bg: "bg.panel" }),
      segment(input.reasoningEffort + " effort", { fg: "fg.muted" }),
      segment("  ", { bg: "bg.panel" }),
      segment("capybara code", { fg: "fg.muted" }),
    ], true, composerAccent),
    panelBorder(input.columns, panelWidth, "", false, input.capabilities.unicode, true, composerAccent),
  ];

  const content: StyledLine[] = [
    ...logoLines,
    line("blank", []),
    ...noticeLines,
    ...completionLines,
    ...composerContent,
    guidanceLine,
  ];

  const start = Math.max(0, Math.floor((input.rows - 1 - content.length) / 2));
  for (let index = 0; index < content.length && start + index < input.rows - 1; index += 1) {
    lines[start + index] = content[index] as StyledLine;
  }

  const path = compactPath(input.workspacePath, Math.max(12, Math.floor(input.columns * 0.38)));
  const leftText = ` ${path}  •  ${input.mcpCount} MCP  •  /status`;
  const rightText = `v${input.version}`;
  lines[input.rows - 1] = renderPinnedStatus(input.columns, leftText, rightText);
  const outputLines = lines.map((styled) => clipLine(styled, input.columns));
  if (input.overlay !== undefined && input.overlay.length > 0) {
    const overlayCard = input.overlay;
    const startRow = Math.max(0, Math.floor((outputLines.length - overlayCard.length) / 2));
    const endRow = startRow + overlayCard.length;
    for (let r = 0; r < outputLines.length; r++) {
      if (r < startRow || r >= endRow) {
        outputLines[r] = dimLine(outputLines[r]!, input.columns);
      }
    }
    for (let i = 0; i < overlayCard.length; i++) {
      const targetRow = startRow + i;
      if (targetRow < outputLines.length) {
        outputLines[targetRow] = compositeOverlayLine(outputLines[targetRow]!, overlayCard[i]!, input.columns);
      }
    }
  }
  return outputLines;
}

/** Borderless fallback for terminals too narrow to carry panel chrome safely. */
export function renderEmergencyHomeFrame(input: HomeFrameOptions): StyledLine[] {
  const lines = Array.from({ length: input.rows }, () => line("blank", []));
  const hasText = input.composer.text.length > 0;
  const bodyWidth = Math.max(1, input.columns - 2);
  const composerAccent = modeAccent(input.interactionMode);
  const composerRows = wrapComposer(
    hasText ? input.composer.text : "Ask anything",
    bodyWidth,
    Math.max(1, Math.min(4, input.rows - 2)),
    hasText ? input.composer.metrics : undefined,
  );
  const content: StyledLine[] = [
    line("header", [
      segment(truncateToWidth("Capybara Code", input.columns), {
        fg: "accent.amber",
        bold: true,
      }),
    ]),
    ...input.notices.slice(-1).map((notice) =>
      line("notice", [segment(truncateToWidth(notice, input.columns), { fg: "fg.muted" })]),
    ),
    ...composerRows.map((value, index) =>
      line("composer", [
        segment(index === 0 ? "> " : "  ", { fg: composerAccent, bold: index === 0 }),
        segment(truncateToWidth(value, bodyWidth), {
          fg: hasText ? "fg.primary" : "fg.muted",
          italic: !hasText && index === 0,
        }),
      ]),
    ),
  ];
  for (let index = 0; index < content.length && index < input.rows - 1; index += 1) {
    lines[index] = content[index] as StyledLine;
  }
  if (input.rows > 0) {
    const path = compactPath(input.workspacePath, Math.max(1, Math.floor(input.columns * 0.55)));
    lines[input.rows - 1] = renderPinnedStatus(input.columns, " " + path, "v" + input.version);
  }
  return lines.map((styled) => clipLine(styled, input.columns));
}

export function renderPinnedStatus(columns: number, leftText: string, rightText: string): StyledLine {
  const width = Math.max(1, columns);
  const safeRight = truncateToWidth(rightText, width);
  const rightWidth = stringWidth(safeRight);
  const leftBudget = Math.max(0, width - rightWidth - 1);
  const safeLeft = truncateToWidth(leftText, leftBudget);
  if (safeLeft.length === 0) {
    return line("status", [segment(safeRight, { fg: "fg.muted" })]);
  }
  const gap = Math.max(1, width - stringWidth(safeLeft) - rightWidth);
  return line("status", [
    segment(safeLeft, { fg: "fg.muted" }),
    segment(" ".repeat(gap), {}),
    segment(safeRight, { fg: "fg.muted" }),
  ]);
}

export function renderWelcomePanel(input: HomeFrameOptions, panelWidth: number): StyledLine[] {
  const innerWidth = Math.max(1, panelWidth - 2);
  const dividerWidth = 3;
  const leftWidth = Math.max(22, Math.floor((innerWidth - dividerWidth) * 0.4));
  const rightWidth = Math.max(1, innerWidth - dividerWidth - leftWidth);
  const workspace = compactPath(input.workspacePath, Math.max(8, leftWidth - 13));

  return [
    panelBorder(input.columns, panelWidth, ` capybara code  v${input.version} `, true, input.capabilities.unicode),
    splitPanelRow(input.columns, panelWidth, leftWidth, rightWidth, [], []),
    splitPanelRow(
      input.columns,
      panelWidth,
      leftWidth,
      rightWidth,
      [segment("  Welcome back.", { fg: "fg.primary", bold: true })],
      [segment(" Getting started", { fg: "accent.blue", bold: true })],
    ),
    splitPanelRow(
      input.columns,
      panelWidth,
      leftWidth,
      rightWidth,
      [
        segment("  model", { fg: "fg.muted" }),
        segment(`  ${input.model}`, { fg: "fg.primary" }),
        segment(`  ${input.reasoningEffort} effort`, { fg: "fg.muted" }),
      ],
      [segment(" Describe what you want to build, fix, or explore.", { fg: "fg.primary" })],
    ),
    splitPanelRow(
      input.columns,
      panelWidth,
      leftWidth,
      rightWidth,
      [
        segment("  workspace", { fg: "fg.muted" }),
        segment(`  ${workspace}`, { fg: "fg.primary" }),
      ],
      [
        segment(" /model", { fg: "accent.blue", bold: true }),
        segment("  choose a model", { fg: "fg.muted" }),
      ],
    ),
    splitPanelRow(
      input.columns,
      panelWidth,
      leftWidth,
      rightWidth,
      [
        segment("  services", { fg: "fg.muted" }),
        segment(`  ${input.mcpCount} MCP`, { fg: "fg.primary" }),
      ],
      [
        segment(" /help", { fg: "accent.blue", bold: true }),
        segment("   show every command", { fg: "fg.muted" }),
      ],
    ),
    splitPanelRow(input.columns, panelWidth, leftWidth, rightWidth, [], []),
    panelBorder(input.columns, panelWidth, "", false, input.capabilities.unicode),
  ];
}

export function splitPanelRow(
  columns: number,
  panelWidth: number,
  leftWidth: number,
  rightWidth: number,
  leftBody: readonly ReturnType<typeof segment>[],
  rightBody: readonly ReturnType<typeof segment>[],
): StyledLine {
  const margin = Math.max(0, Math.floor((columns - panelWidth) / 2));
  const leftUsed = leftBody.reduce((total, part) => total + stringWidth(part.text), 0);
  const rightUsed = rightBody.reduce((total, part) => total + stringWidth(part.text), 0);
  const paint = (parts: readonly ReturnType<typeof segment>[]) =>
    parts.map((part) => ({ ...part, bg: part.bg ?? ("bg.panel" as const) }));

  return line("header", [
    segment(" ".repeat(margin), {}),
    segment("\u2502", { fg: "border.warm", bg: "bg.panel" }),
    ...paint(leftBody),
    segment(" ".repeat(Math.max(0, leftWidth - leftUsed)), { bg: "bg.panel" }),
    segment(" \u2502 ", { fg: "border.warm", bg: "bg.panel" }),
    ...paint(rightBody),
    segment(" ".repeat(Math.max(0, rightWidth - rightUsed)), { bg: "bg.panel" }),
    segment("\u2502", { fg: "border.warm", bg: "bg.panel" }),
    segment(" ".repeat(Math.max(0, columns - margin - panelWidth)), {}),
  ]);
}

export function panelBorder(
  columns: number,
  panelWidth: number,
  title: string,
  top: boolean,
  unicode: boolean,
  accentLeft: boolean = true,
  accentToken?: ModeAccent,
): StyledLine {
  const margin = Math.max(0, Math.floor((columns - panelWidth) / 2));
  const horizontal = unicode ? "\u2500" : "-";
  const leftCorner = unicode ? (top ? "┌" : "└") : "+";
  const rightCorner = unicode ? (top ? "┐" : "┘") : "+";
  const innerWidth = Math.max(1, panelWidth - 2);
  const safeTitle = truncateToWidth(title, Math.max(0, innerWidth - 2));
  const rule = title.length > 0
    ? `${horizontal}${safeTitle}${horizontal.repeat(
        Math.max(0, innerWidth - stringWidth(safeTitle) - 1),
      )}`
    : horizontal.repeat(innerWidth);

  return line("header", [
    segment(" ".repeat(margin), {}),
    segment(leftCorner, { fg: accentLeft ? (accentToken ?? "accent.coral") : "border.warm", bg: "bg.panel" }),
    segment(rule, { fg: accentToken ?? (title.length > 0 ? "accent.coral" : "border.warm"), bg: "bg.panel", bold: title.length > 0 }),
    segment(rightCorner, { fg: accentToken ?? "border.warm", bg: "bg.panel" }),
    segment(" ".repeat(Math.max(0, columns - margin - panelWidth)), {}),
  ]);
}
export function renderLegacyHomeFrame(input: HomeFrameOptions): StyledLine[] {
  const lines = Array.from({ length: input.rows }, () => line("blank", []));
  // The landing composer is the primary interaction surface. It used to cap at
  // 76 columns, which left a tiny control in wide terminals. Let it use most of
  // the viewport while retaining comfortable margins on very large displays.
  const panelWidth = Math.min(132, Math.max(52, Math.floor(input.columns * 0.68)));
  const hasText = input.composer.text.length > 0;
  const composerAccent = modeAccent(input.interactionMode);
  const composerRows = wrapComposer(
    hasText ? input.composer.text : "Ask anything",
    Math.max(12, panelWidth - 4),
    3,
    hasText ? input.composer.metrics : undefined,
  );
  const completionLines =
    input.completion?.open === true
      ? renderPanelCompletion(
          input.completion,
          input.capabilities,
          input.columns,
          panelWidth,
          Math.max(1, Math.min(4, input.rows - 8)),
        )
      : [];
  const content: StyledLine[] = [
    centerLine(input.columns, "header", [
      segment("capy", { fg: "fg.primary", bold: true }),
      segment("bara", { fg: "accent.coral", bold: true }),
    ]),
    line("blank", []),
    ...composerRows.map((value, index) =>
      panelRow(input.columns, panelWidth, "composer", [
        segment(index === 0 ? "> " : "  ", { fg: composerAccent, bold: index === 0 }),
        segment(value, {
          fg: hasText ? "fg.primary" : "fg.muted",
          italic: !hasText,
        }),
      ], true, composerAccent),
    ),
    panelRow(input.columns, panelWidth, "composer", [
       segment(`${interactionModeLabel(input.interactionMode)}  `, { fg: composerAccent, bold: true }),
      segment(input.model, { fg: "fg.primary" }),
      segment("  ·  " + input.reasoningEffort + " effort", { fg: "fg.muted" }),
      segment("  Capybara Code", { fg: "fg.muted" }),
    ], true, composerAccent),
    ...completionLines,
    ...(completionLines.length === 0
      ? [
          line("blank", []),
          centerLine(input.columns, "composer", [
            segment("Tab", { fg: "fg.primary", bold: true }),
            segment(" select   ", { fg: "fg.muted" }),
            segment("Ctrl+P", { fg: "fg.primary", bold: true }),
            segment(" commands", { fg: "fg.muted" }),
          ]),
        ]
      : []),
  ];
  const start = Math.max(1, Math.floor((input.rows - 1 - content.length) / 2));
  for (let index = 0; index < content.length && start + index < input.rows - 1; index += 1) {
    lines[start + index] = content[index] as StyledLine;
  }

  const path = compactPath(input.workspacePath, Math.max(16, Math.floor(input.columns * 0.32)));
  const leftText = ` ${path}  •  ${input.mcpCount} MCP  /status`;
  const rightText = input.version;
  lines[input.rows - 1] = renderPinnedStatus(input.columns, leftText, rightText);
  return lines.map((styled) => clipLine(styled, input.columns));
}

export interface SessionFrameRender {
  readonly lines: StyledLine[];
  readonly timelineMaxScrollOffset?: number;
}

/**
 * P1-03: the accordion folds finished work to one line, but the work that is
 * happening *right now* stays open — the streaming blocks and any tool or task
 * still running. Folding those too would hide the only sign the session is alive.
 */
export function liveExpandedIds(model: SessionViewModel): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of model.activeTools) ids.add(item.id);
  for (const item of model.activeTasks) ids.add(item.id);
  for (const item of model.activeJobs) ids.add(item.id);
  // Synthetic streaming items are appended only at the tail and never enter the
  // durable lifecycle indexes. Inspect that bounded suffix rather than all history.
  for (let index = Math.max(0, model.timeline.length - 4); index < model.timeline.length; index += 1) {
    const item = model.timeline[index];
    if (item?.id.startsWith("streaming-")) ids.add(item.id);
  }
  if (model.turnStatus !== "idle" && model.timeline.length > 0) {
    const last = model.timeline[model.timeline.length - 1];
    if (last !== undefined && last.type === "commentary") ids.add(last.id);
  }
  return ids;
}

export function renderSessionFrame(input: SessionFrameOptions): SessionFrameRender {
  const prepared = prepareScreen({
    model: input.model,
    composer: {
      text: input.composer.text,
      cursor: input.composer.cursor,
      busy: input.model.turnStatus !== "idle",
    },
    capabilities: input.capabilities,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    liveOptions: { frame: input.liveFrame ?? 0 },
    ...(input.overlay !== undefined
      ? { overlay: input.overlay, overlayScrollOffset: input.overlayScrollOffset ?? 0 }
      : {}),
    ...(input.approvalCard !== undefined ? { approvalCard: input.approvalCard } : {}),
    ...(input.permissionDetail !== undefined ? { permissionDetail: input.permissionDetail } : {}),
    ...(input.sidebarVisible !== undefined ? { sidebarVisible: input.sidebarVisible } : {}),
    ...(input.showCost !== undefined ? { showCost: input.showCost } : {}),
    ...(input.statusDensity !== undefined ? { statusDensity: input.statusDensity } : {}),
    ...(input.sidebarTitle !== undefined ? { sidebarTitle: input.sidebarTitle } : {}),
    ...(input.mcpServers.length > 0 ? { mcpServers: input.mcpServers } : {}),
    ...(input.lspServers.length > 0 ? { lspServers: input.lspServers } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.credentialSource !== undefined ? { credentialSource: input.credentialSource } : {}),
    ...(input.helpHint !== undefined ? { helpHint: input.helpHint } : {}),
    notices: input.notices,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.git !== undefined ? { git: input.git } : {}),
    workspacePath: input.workspacePath,
    ...(input.timelineProjection !== undefined
      ? { timelineProjection: input.timelineProjection }
      : {}),
    ...(input.streamingViews !== undefined ? { streamingViews: input.streamingViews } : {}),
    timelineOptions: {
      ...(input.thinkingVisibility !== undefined ? { thinkingVisibility: input.thinkingVisibility } : {}),
      ...(input.thinkingMode !== undefined ? { thinkingMode: input.thinkingMode } : {}),
      ...(input.toolDetail !== undefined ? { toolDetail: input.toolDetail } : {}),
      ...(input.subagentDetail !== undefined ? { subagentDetail: input.subagentDetail } : {}),
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      ...(input.model.currentTurnId !== undefined ? { currentTurnId: input.model.currentTurnId } : {}),
      turnActive: !["idle", "completed", "cancelled", "failed", "partial"].includes(
        input.model.turnStatus,
      ),
      progressiveDisclosure: true,
      groupSucceededReads: true,
      thinkingSpinnerFrame: input.liveFrame ?? 0,
      ...(input.accordionCollapsed === true
        ? { accordionCollapsed: true, accordionExpandedIds: liveExpandedIds(input.model) }
        : {}),
      ...(input.finalAnswerStyle === undefined ? {} : { finalAnswerStyle: input.finalAnswerStyle }),
      ...(input.completionEvidenceMode === undefined ? {} : { completionEvidenceMode: input.completionEvidenceMode }),
      ...(input.completionEvidenceExpanded === true ? { completionEvidenceExpanded: true } : {}),
      ...(input.completionAttentionDetails === undefined ? {} : { completionAttentionDetails: input.completionAttentionDetails }),
      ...(input.offeredScopes !== undefined ? { offeredScopes: input.offeredScopes } : {}),
      ...(input.selectedApprovalChoice !== undefined
        ? { selectedApprovalChoice: input.selectedApprovalChoice }
        : {}),
      ...(input.activeApprovalId !== undefined ? { activeApprovalId: input.activeApprovalId } : {}),
    },
  }, { renderComposer: false });

  // Chrome and layout were prepared exactly once. Only the row-bounded timeline
  // and column join remain after the custom composer determines the body budget.
  const allNoticeLines = input.notices.map((notice) =>
    line("notice", [segment(`  ${notice}`, { fg: "fg.muted" })]),
  );
  const approvalCardLines = input.approvalCard ?? [];
  const liveLines = prepared.live;

  const fullBodyRows = Math.max(0, input.rows - prepared.banner.length - prepared.status.length);
  const composerWidth = prepared.twoColumn ? prepared.plan.mainWidth : input.columns;
  const composer = renderComposerPanel(input, composerWidth);

  const completionBudget = Math.max(
    0,
    fullBodyRows - composer.length - (input.completion?.open === true ? 3 : 0),
  );
  const renderedCompletion =
    input.completion?.open === true && completionBudget > 0
      ? renderPanelCompletion(
          input.completion,
          input.capabilities,
          composerWidth,
          composerWidth,
          Math.min(6, completionBudget),
        )
      : [];
  const completionLines =
    renderedCompletion.length <= completionBudget
      ? renderedCompletion
      : renderedCompletion.slice(-completionBudget);

  const leftFixedBottomRows = composer.length + completionLines.length;
  const leftBodyRows = Math.max(0, fullBodyRows - leftFixedBottomRows);

  const rawNoticeAndLiveCount = allNoticeLines.length + liveLines.length + approvalCardLines.length;
  const rawSepNoticeLive = (allNoticeLines.length > 0 && (liveLines.length > 0 || approvalCardLines.length > 0)) ? 1 : 0;
  const rawSepTimeline = rawNoticeAndLiveCount > 0 ? 1 : 0;

  const noticeBudget = Math.max(0, leftBodyRows - liveLines.length - approvalCardLines.length - rawSepNoticeLive - rawSepTimeline);
  const noticeLines = allNoticeLines.slice(-noticeBudget);

  const effectiveSepNoticeLive = (noticeLines.length > 0 && (liveLines.length > 0 || approvalCardLines.length > 0)) ? 1 : 0;
  const effectiveNoticeAndLiveCount = noticeLines.length + liveLines.length + approvalCardLines.length;
  const effectiveSepTimeline = effectiveNoticeAndLiveCount > 0 ? 1 : 0;

  const extraLeftRows = noticeLines.length + liveLines.length + approvalCardLines.length + effectiveSepNoticeLive + effectiveSepTimeline;
  const timelineRows = Math.max(0, leftBodyRows - extraLeftRows);

  const viewport = computePreparedViewport(prepared, {
    timelineRows,
    overlayRows: fullBodyRows,
    timelineScrollOffsetFromBottom: input.timelineScrollOffsetFromBottom,
    ...(input.overlayScrollOffset !== undefined
      ? { overlayScrollOffset: input.overlayScrollOffset }
      : {}),
    ...(input.timelineMaxScrollOffsetHint !== undefined
      ? { timelineMaxScrollOffsetHint: input.timelineMaxScrollOffsetHint }
      : {}),
  });

  const mainRegion: StyledLine[] = [...viewport.timeline];
  if (viewport.timeline.length > 0 && effectiveNoticeAndLiveCount > 0) {
    mainRegion.push(line("blank", []));
  }
  if (noticeLines.length > 0) {
    mainRegion.push(...noticeLines);
    if (liveLines.length > 0 || approvalCardLines.length > 0) {
      mainRegion.push(line("blank", []));
    }
  }
  if (liveLines.length > 0) {
    mainRegion.push(...liveLines);
  }
  if (approvalCardLines.length > 0) {
    mainRegion.push(...approvalCardLines);
  }

  let body: StyledLine[];
  if (prepared.twoColumn) {
    const leftTop = mainRegion;
    const leftBottom = [...completionLines, ...composer];
    const leftGap = Math.max(0, fullBodyRows - leftTop.length - leftBottom.length);
    const leftColumnLines = [
      ...leftTop,
      ...Array.from({ length: leftGap }, () => line("blank", [])),
      ...leftBottom,
    ];
    body = joinColumns(leftColumnLines, prepared.sidebar, prepared.plan, prepared.context, fullBodyRows);
  } else {
    const top = mainRegion;
    const bottom = [...completionLines, ...composer];
    const gap = Math.max(0, fullBodyRows - top.length - bottom.length);
    body = [
      ...top,
      ...Array.from({ length: gap }, () => line("blank", [])),
      ...bottom,
    ];
  }

  let outputLines = [
    ...prepared.banner,
    ...body,
    ...prepared.status,
  ];

  if (prepared.overlayOpen && viewport.overlay.length > 0) {
    outputLines = [...outputLines];
    const overlayCard = viewport.overlay;
    const startRow = Math.max(0, Math.floor((outputLines.length - overlayCard.length) / 2));
    const endRow = startRow + overlayCard.length;
    for (let r = 0; r < outputLines.length; r++) {
      if (r < startRow || r >= endRow) {
        outputLines[r] = dimLine(outputLines[r]!, input.columns);
      }
    }
    for (let i = 0; i < overlayCard.length; i++) {
      const targetRow = startRow + i;
      if (targetRow < outputLines.length) {
        outputLines[targetRow] = compositeOverlayLine(outputLines[targetRow]!, overlayCard[i]!, input.columns);
      }
    }
  }
  return {
    lines: fitFrame(outputLines, input.rows).map((styled) => clipLine(styled, input.columns)),
    ...(viewport.timelineMaxScrollOffset !== undefined
      ? { timelineMaxScrollOffset: viewport.timelineMaxScrollOffset }
      : {}),
  };
}

export function renderComposerPanel(input: SessionFrameOptions, overrideWidth?: number): StyledLine[] {
  const targetColumns = overrideWidth ?? input.columns;
  const panelWidth = Math.min(targetColumns, Math.max(1, targetColumns));
  const inner = Math.max(1, panelWidth - 2);
  const body = input.composer.text.length > 0 ? input.composer.text : "Ask anything";
  const composerAccent = modeAccent(input.model.modeState.activeTurn ?? input.model.modeState.selected);
  if (targetColumns < 40) {
    const bodyWidth = Math.max(1, targetColumns - 2);
    const rows = wrapComposer(body, bodyWidth, 4, input.composer.metrics);
    const compactLines: StyledLine[] = [
      ...rows.map((row, index) =>
        line("composer", [
          segment(index === 0 ? "> " : "  ", { fg: composerAccent, bold: index === 0 }),
          segment(truncateToWidth(row, bodyWidth), {
            fg: input.composer.text.length > 0 ? "fg.primary" : "fg.muted",
            italic: input.composer.text.length === 0,
          }),
        ]),
      ),
      line("composer", [
         segment(`${modeTransitionLabel(input.model)}  `, { fg: composerAccent, bold: true }),
        segment(
          truncateToWidth(input.model.modelId, Math.max(1, targetColumns - 7)),
          { fg: "fg.primary" },
        ),
      ]),
    ];
    if (input.model.modeState.selected === "plan") {
      const parts = planControlParts(input.model);
      if (parts.length > 0) {
        compactLines.push(
          line("notice", parts),
        );
      }
    }
    return compactLines.map((styled) => clipLine(styled, targetColumns));
  }
  const rows = wrapComposer(body, Math.max(1, inner - 2), 4, input.composer.metrics);
  const minimumRows = 1;
  while (rows.length < minimumRows) rows.push("");
  const lines: StyledLine[] = [];
  lines.push(panelBorder(targetColumns, panelWidth, "", true, input.capabilities.unicode, true, composerAccent));
  rows.forEach((row, index) => {
    lines.push(panelRow(targetColumns, panelWidth, "composer", [
      segment(index === 0 ? "> " : "  ", { fg: composerAccent, bold: index === 0 }),
      segment(row, { fg: input.composer.text.length > 0 ? "fg.primary" : "fg.muted", italic: input.composer.text.length === 0 }),
    ], true, composerAccent));
  });

  const rightText = "tab/enter select  ·  ctrl+p commands";
  const leftParts = [
     segment(`${modeTransitionLabel(input.model)}  `, { fg: composerAccent, bold: true }),
    segment(input.model.modelId, { fg: "fg.primary" }),
    segment("  ·  " + input.model.reasoningEffort + " effort", { fg: "fg.muted" }),
    segment("  ·  Capybara Code", { fg: "fg.muted" }),
  ];
  const leftWidth = leftParts.reduce((acc, p) => acc + stringWidth(p.text), 0);
  const rightWidth = stringWidth(rightText);
  const available = inner - leftWidth - rightWidth;

  if (available >= 2) {
    lines.push(panelRow(targetColumns, panelWidth, "composer", [
      ...leftParts,
      segment(" ".repeat(available), { bg: "bg.panel" }),
      segment(rightText, { fg: "fg.muted" }),
    ], true, composerAccent));
  } else {
    const compactLeft = [
     segment(`${modeTransitionLabel(input.model)}  `, { fg: composerAccent, bold: true }),
      segment(truncateToWidth(input.model.modelId, Math.max(1, inner - 7)), { fg: "fg.primary" }),
    ];
    lines.push(panelRow(targetColumns, panelWidth, "composer", compactLeft, true, composerAccent));
  }
  if (input.model.modeState.selected === "plan") {
    const parts = planControlParts(input.model);
    if (parts.length > 0) {
      lines.push(panelRow(targetColumns, panelWidth, "composer", parts, true, composerAccent));
    }
  }
  lines.push(panelBorder(targetColumns, panelWidth, "", false, input.capabilities.unicode, true, composerAccent));

  return lines;
}

/** Render a completion popup at the same horizontal origin and width as its composer. */
export function completionPopupOptions(
  state: CompletionState,
  maxRows?: number,
): CompletionPopupOptions {
  const title =
    state.command === "/model"
      ? "Select model"
      : state.command === "/effort"
        ? "Select reasoning"
        : undefined;
  return {
    ...(maxRows !== undefined ? { maxRows } : {}),
    ...(title !== undefined ? { title, search: state.query } : {}),
  };
}

export function renderPanelCompletion(
  state: CompletionState,
  capabilities: TerminalCapabilities,
  columns: number,
  panelWidth: number,
  maxRows: number,
): StyledLine[] {
  const width = Math.min(columns, Math.max(1, panelWidth));
  const margin = Math.max(0, Math.floor((columns - width) / 2));
  return renderCompletionPopup(state, blockContext(capabilities, width), completionPopupOptions(state, maxRows)).map(
    (styled) =>
      line(
        styled.kind,
        [segment(" ".repeat(margin), {}), ...styled.segments],
        styled.rowBackground,
      ),
  );
}

export function centerLine(columns: number, kind: StyledLine["kind"], parts: readonly ReturnType<typeof segment>[]): StyledLine {
  const clipped = sliceStyledSegments(line(kind, parts), 0, Math.max(0, columns));
  const used = clipped.reduce((total, part) => total + stringWidth(part.text), 0);
  return line(kind, [segment(" ".repeat(Math.max(0, Math.floor((columns - used) / 2))), {}), ...clipped]);
}

export function panelRow(
  columns: number,
  panelWidth: number,
  kind: StyledLine["kind"],
  body: readonly ReturnType<typeof segment>[],
  accentLeft: boolean = true,
  accentToken?: ModeAccent,
): StyledLine {
  const left = Math.max(0, Math.floor((columns - panelWidth) / 2));
  const inner = Math.max(1, panelWidth - 2);
  const clippedBody = sliceStyledSegments(line(kind, body), 0, inner);
  const used = clippedBody.reduce((total, part) => total + stringWidth(part.text), 0);
  const styledBody = clippedBody.map((part) => ({
    ...part, bg: part.bg ?? ("bg.panel" as const),
  }));
  return line(kind, [
    segment(" ".repeat(left), {}),
    segment("│", { fg: accentLeft ? (accentToken ?? "accent.coral") : "border.warm", bg: "bg.panel" }),
    ...styledBody,
    segment(" ".repeat(Math.max(0, inner - used)), { bg: "bg.panel" }),
    segment("│", { fg: accentToken ?? "border.warm", bg: "bg.panel" }),
    segment(" ".repeat(Math.max(0, columns - left - panelWidth)), {}),
  ]);
}

/**
 * Resolve the physical terminal caret from the semantic composer frame.
 *
 * The TUI draws its own caret-free prompt, while Windows IMEs anchor their
 * composition window to the terminal's hardware cursor. The first panel row
 * containing the `> ` prompt gives us the exact body origin; the wrapped prefix
 * determines the row/column within that body.
 */
export function resolveComposerCursor(
  lines: readonly StyledLine[],
  state: {
    readonly text: string;
    readonly cursor: number;
    readonly metrics?: { readonly graphemes: readonly string[] };
  },
  columns: number,
  rows: number,
): TerminalCursorPosition {
  const firstPrompt = lines.findIndex((candidate) => isComposerPanelRow(candidate, true));
  const firstRow = firstPrompt >= 0
    ? firstPrompt
    : lines.findIndex((candidate) => isComposerPanelRow(candidate, false));

  // A severely constrained frame can clip the first wrapped row. Keeping the
  // physical cursor in-bounds is still preferable to leaving it at the status
  // line, which is where an IME would otherwise anchor its preedit window.
  if (firstRow < 0) {
    return { column: 0, row: Math.max(0, rows - 1) };
  }

  const panelRows: StyledLine[] = [];
  for (let index = firstRow; index < lines.length; index += 1) {
    const candidate = lines[index];
    if (candidate === undefined || !isComposerPanelRow(candidate, false)) break;
    panelRows.push(candidate);
  }

  const first = panelRows[0] ?? lines[firstRow]!;
  const promptIndex = composerPromptIndex(first, false);
  const bodyIndex = promptIndex >= 0 ? promptIndex + 1 : first.segments.length;
  const bodyStart = first.segments
    .slice(0, bodyIndex)
    .reduce((total, part) => total + stringWidth(part.text), 0);

  // `panelRow` paints the body and its right-hand padding with `bg.panel`; the
  // unstyled trailing margin marks the end of the editable width.
  let bodyCapacity = 0;
  for (let index = bodyIndex; index < first.segments.length; index += 1) {
    const part = first.segments[index];
    if (part === undefined || part.bg === undefined) break;
    bodyCapacity += stringWidth(part.text);
  }
  if (bodyCapacity <= 0) bodyCapacity = Math.max(1, columns - bodyStart);
  const prompt = promptIndex >= 0 ? first.segments[promptIndex] : undefined;
  // Home/legacy frames wrap at panelWidth - 4; session frames reserve one
  // additional cell for their wider gutter. Derive that reserved space from
  // the prompt style rather than reimplementing either panel width formula.
  const framed = first.segments.some((part) =>
    part.text === "\u2502" ||
    part.text === "|" ||
    part.text === "\u258c" ||
    part.text === "\u258d"
  );
  const wrapWidth = Math.max(
    1,
    framed ? bodyCapacity - (prompt?.fg === "fg.primary" ? 2 : 1) : bodyCapacity,
  );
  const visual = wrappedCursorPosition(
    state.text,
    state.cursor,
    wrapWidth,
    Math.max(1, panelRows.length),
    state.metrics?.graphemes,
  );
  return {
    column: Math.max(0, Math.min(columns - 1, bodyStart + visual.column)),
    row: Math.max(0, Math.min(rows - 1, firstRow + visual.row)),
  };
}

export function isComposerPanelRow(line: StyledLine, firstOnly: boolean): boolean {
  return line.kind === "composer" && composerPromptIndex(line, firstOnly) >= 0;
}

export function composerPromptIndex(line: StyledLine, firstOnly: boolean): number {
  const borderIndex = line.segments.findIndex((part) =>
    part.text === "▌" || part.text === "│" || part.text === "|" || part.text === "▍"
  );
  const bodyStartIndex = borderIndex < 0 ? 0 : borderIndex + 1;
  return line.segments.findIndex((part, index) => {
    if (index < bodyStartIndex) return false;
    const isFirst =
      part.text === "> " ||
      part.text === "▍ " ||
      part.text === "▌ " ||
      part.text === ">" ||
      part.text === "▍";
    return firstOnly ? isFirst : isFirst || part.text === "  ";
  });
}
export interface WrappedCursorPosition {
  readonly row: number;
  readonly column: number;
}

export function wrappedCursorPosition(
  text: string,
  cursor: number,
  columns: number,
  maxRows: number,
  metrics?: readonly string[],
): WrappedCursorPosition {
  const clusters = metrics ?? graphemes(text);
  const target = Math.max(0, Math.min(cursor, clusters.length));
  const width = Math.max(1, columns);
  let row = 0;
  let column = 0;
  let totalRows = 1;
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
      totalRows = Math.max(totalRows, row + 1);
      continue;
    }

    const clusterWidth = stringWidth(cluster);
    if (column > 0 && column + clusterWidth > width) {
      row += 1;
      column = 0;
    }
    column += clusterWidth;
    totalRows = Math.max(totalRows, row + 1);
  }

  if (target === clusters.length) {
    cursorRow = row;
    cursorColumn = column;
  }

  const visibleRows = Math.max(1, maxRows);
  const firstVisibleRow = Math.max(0, totalRows - visibleRows);
  return {
    row: Math.max(0, Math.min(visibleRows - 1, cursorRow - firstVisibleRow)),
    column: Math.max(0, Math.min(width, cursorColumn)),
  };
}

export function ansiCursorSequence(cursor: TerminalCursorPosition): string {
  const row = Math.max(1, cursor.row + 1);
  const column = Math.max(1, cursor.column + 1);
  // Reset SGR before CUP so the cursor update cannot inherit a styled segment.
  // The visible hardware cursor is both user feedback and the Windows IME anchor.
  return `\u001B[0m\u001B[${row};${column}H\u001B[?25h`;
}
export function supportsNativeOpenTui(platform: NodeJS.Platform = process.platform): boolean {
  // OpenTUI's Windows backend can pass UTF-8 through the legacy console codec,
  // which turns Korean output into mojibake and leaves wide-character cells stale.
  // The ANSI frame writer is UTF-8-safe and already owns correct terminal widths.
  return platform !== "win32";
}

export function canUseNativeOpenTui(theme: Theme, hostIsTty: boolean): boolean {
  return supportsNativeOpenTui() &&
    hostIsTty &&
    theme.depth !== "none" &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true;
}

export function paintFrameBase(lines: readonly StyledLine[]): StyledLine[] {
  return lines.map((styled) =>
    styled.rowBackground === undefined ? { ...styled, rowBackground: "bg.base" as const } : styled,
  );
}

/** Attach a stable row revision before handing semantic rows to OpenTUI. */
export function withRowRevisions(lines: readonly StyledLine[]): StyledLine[] {
  return lines.map((styled) => ({
    ...styled,
    revision: styled.revision ?? stableStyledLineHash(styled),
  }));
}

function stableStyledLineHash(styled: StyledLine): number {
  let hash = 2_166_136_261;
  const feed = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
  };
  feed(styled.kind);
  feed(styled.rowBackground ?? "");
  for (const part of styled.segments) {
    feed(part.text);
    feed(part.fg ?? "");
    feed(part.bg ?? "");
    feed(`${part.bold ?? false}${part.italic ?? false}${part.dim ?? false}${part.underline ?? false}${part.inverse ?? false}`);
  }
  return hash;
}

/**
 * Overlay the toast card in the upper-right corner of the frame.
 *
 * The notification is a presentation layer: it must not push the timeline,
 * composer, or status bar down. The first rows are replaced only inside the
 * toast's box bounds, so the left side of an active timeline row remains intact
 * when the notification appears over a non-empty frame.
 */
export function injectToast(
  frame: readonly StyledLine[],
  toast: ToastState,
  context: BlockContext,
): StyledLine[] {
  if (frame.length === 0) return frame.slice();

  const toastLines = renderToast(toast, context);
  const rows = Math.min(frame.length, toastLines.length);
  const out = [...frame];

  for (let row = 0; row < rows; row += 1) {
    const base = out[row];
    const toastLine = toastLines[row];
    if (base === undefined || toastLine === undefined) continue;
    out[row] = overlayToastLine(base, toastLine, context.columns);
  }
  return out;
}

/** Merge the toast's card region with the existing row without changing height. */
export function overlayToastLine(base: StyledLine, toastLine: StyledLine, columns: number): StyledLine {
  const first = toastLine.segments[0];
  const last = toastLine.segments[toastLine.segments.length - 1];
  const leftPad = first === undefined ? 0 : stringWidth(first.text);
  const rightPad = last === undefined || last === first ? 0 : stringWidth(last.text);
  const boxEnd = Math.max(leftPad, columns - rightPad);

  const prefix = padSegmentsToWidth(
    sliceStyledSegments(base, 0, leftPad),
    leftPad,
  );
  const box = sliceStyledSegments(toastLine, leftPad, boxEnd);
  const suffix = padSegmentsToWidth(
    sliceStyledSegments(base, boxEnd, columns),
    Math.max(0, columns - boxEnd),
  );

  return line("overlay", [...prefix, ...box, ...suffix], base.rowBackground);
}

/** Keep a styled line's graphemes inside a display-column range. */
export function sliceStyledSegments(lineValue: StyledLine, start: number, end: number): Segment[] {
  if (end <= start) return [];
  const out: Segment[] = [];
  let column = 0;
  for (const part of lineValue.segments) {
    const width = stringWidth(part.text);
    const overlapStart = Math.max(start, column);
    const overlapEnd = Math.min(end, column + width);
    if (overlapStart < overlapEnd) {
      const text = sliceTextByWidth(part.text, overlapStart - column, overlapEnd - column);
      if (text.length > 0) out.push({ ...part, text });
    }
    column += width;
    if (column >= end) break;
  }
  return out;
}

export function sliceTextByWidth(text: string, start: number, end: number): string {
  if (end <= start) return "";
  let column = 0;
  let out = "";
  for (const cluster of graphemes(text)) {
    const width = stringWidth(cluster);
    const next = column + width;
    if (next <= start) {
      column = next;
      continue;
    }
    if (column >= end) break;
    // Selection boundaries and toast margins are cell-aligned. Do not split a
    // wide grapheme when a caller supplies a clipped range.
    if (column >= start && next <= end) out += cluster;
    column = next;
  }
  return out;
}

export function padSegmentsToWidth(segments: readonly Segment[], width: number): Segment[] {
  const used = segments.reduce((sum, part) => sum + stringWidth(part.text), 0);
  return used >= width ? [...segments] : [...segments, segment(" ".repeat(width - used), {})];
}

export function isPristineSession(model: SessionViewModel): boolean {
  return model.turnStatus === "idle" && model.turnCount === 0 && model.timeline.length === 0;
}

export function fitFrame(lines: readonly StyledLine[], rows: number): StyledLine[] {
  if (lines.length >= rows) return lines.slice(lines.length - rows);
  return [...lines, ...Array.from({ length: rows - lines.length }, () => line("blank", []))];
}

export function clipLine(styled: StyledLine, columns: number): StyledLine {
  return line(
    styled.kind,
    sliceStyledSegments(styled, 0, Math.max(0, columns)),
    styled.rowBackground,
  );
}

interface StyledCell {
  char: string;
  style: import("@cbc/tui-components").SegmentStyle;
}

function lineToCells(styledLine: StyledLine, width: number): StyledCell[] {
  const cells: StyledCell[] = [];
  for (const seg of styledLine.segments) {
    const text = seg.text;
    const { text: _t, ...style } = seg;
    for (const ch of text) {
      const w = stringWidth(ch);
      if (w === 0) continue;
      cells.push({ char: ch, style });
      if (w === 2) {
        cells.push({ char: "", style });
      }
    }
  }
  while (cells.length < width) {
    cells.push({ char: " ", style: {} });
  }
  return cells.slice(0, width);
}

function cellsToLine(kind: import("@cbc/tui-components").LineKind, cells: StyledCell[]): StyledLine {
  const segments: Segment[] = [];
  let currentText = "";
  let currentStyleKey = "";
  let currentStyle: import("@cbc/tui-components").SegmentStyle = {};

  for (const cell of cells) {
    if (cell.char === "") continue;
    const styleKey = JSON.stringify(cell.style ?? {});
    if (styleKey === currentStyleKey) {
      currentText += cell.char;
    } else {
      if (currentText.length > 0) {
        segments.push(segment(currentText, currentStyle));
      }
      currentText = cell.char;
      currentStyleKey = styleKey;
      currentStyle = cell.style ?? {};
    }
  }
  if (currentText.length > 0) {
    segments.push(segment(currentText, currentStyle));
  }
  return line(kind, segments);
}

export function compositeOverlayLine(bgLine: StyledLine, ovLine: StyledLine, columns: number): StyledLine {
  const bgCells = lineToCells(bgLine, columns);
  const ovCells = lineToCells(ovLine, columns);

  let firstIndex = -1;
  let lastIndex = -1;
  for (let i = 0; i < ovCells.length; i++) {
    const ch = ovCells[i]?.char;
    if (ch !== undefined && ch !== " " && ch !== "") {
      if (firstIndex === -1) firstIndex = i;
      lastIndex = i;
    }
  }

  if (firstIndex === -1) return bgLine;

  for (let i = 0; i < bgCells.length; i++) {
    if (i < firstIndex || i > lastIndex) {
      if (bgCells[i] !== undefined) {
        bgCells[i] = {
          char: bgCells[i]!.char,
          style: { ...bgCells[i]!.style, dim: true, fg: "fg.muted" },
        };
      }
    }
  }

  for (let i = firstIndex; i <= lastIndex && i < columns; i++) {
    if (ovCells[i] !== undefined) {
      bgCells[i] = ovCells[i]!;
    }
  }

  return cellsToLine(bgLine.kind, bgCells);
}

export function dimLine(bgLine: StyledLine, columns: number): StyledLine {
  const bgCells = lineToCells(bgLine, columns);
  for (let i = 0; i < bgCells.length; i++) {
    if (bgCells[i] !== undefined) {
      bgCells[i] = {
        char: bgCells[i]!.char,
        style: { ...bgCells[i]!.style, dim: true, fg: "fg.muted" },
      };
    }
  }
  return cellsToLine(bgLine.kind, bgCells);
}
