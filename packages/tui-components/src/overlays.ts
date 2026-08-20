/**
 * Overlays and the diff viewer — PRD §6.17, §6.18, §8.10.
 *
 * §6.17: P0 has no permanent sidebar. Everything here appears on a key press and
 * closes on `Esc`, and while one is open the active job keeps running with the live
 * status still minimally visible — an overlay is a lens, not a modal that stops work.
 */

import { sanitizeInline } from "./sanitize.ts";
import { renderPlanContract, type PlanContractRenderInput } from "./todo.ts";
import { blank, fitLine, line, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import { icon, treeGlyphs, type ThemeToken } from "./theme.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

/** §6.17's overlay set. */
export type OverlayKind =
  | "command_palette"
  | "model_picker"
  | "reasoning_picker"
  | "agents"
  | "jobs"
  | "diff"
  | "context"
  | "todo"
  | "plan"
  | "skills"
  | "mcp"
  | "sessions"
  | "status"
  | "approvals"
  | "settings"
  | "details"
  | "help";

export const OVERLAY_KINDS: readonly OverlayKind[] = [
  "command_palette",
  "model_picker",
  "reasoning_picker",
  "agents",
  "jobs",
  "diff",
  "context",
  "todo",
  "plan",
  "skills",
  "mcp",
  "sessions",
  "status",
  "approvals",
  "settings",
  "details",
  "help",
];

export const OVERLAY_TITLES: Readonly<Record<OverlayKind, string>> = {
  command_palette: "Commands",
  model_picker: "Model",
  reasoning_picker: "Reasoning",
  agents: "Agents",
  jobs: "Jobs",
  diff: "Diff",
  context: "Context",
  todo: "TODO",
  plan: "Plan contract",
  skills: "Skills",
  mcp: "MCP servers",
  sessions: "Sessions",
  status: "Status",
  approvals: "Saved approvals",
  settings: "Settings",
  details: "Transcript details",
  help: "Help",
};

/**
 * One argument of a slash command.
 *
 * `values` is only for a set that is fixed by the schema. Anything that depends on
 * session state — the installed models, the recorded sessions — is supplied by the
 * host through `CompletionSources`, because restating it here would be a second
 * copy that drifts from the validator.
 */
export interface CommandArgument {
  readonly name: string;
  readonly required?: boolean;
  readonly values?: readonly string[];
  /** Shown when the value cannot be enumerated at all. */
  readonly hint?: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly args?: readonly CommandArgument[];
}

/** §8.10 slash commands, handled locally and never sent to the model. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "show contextual help", args: [{ name: "topic" }] },
  {
    name: "/model",
    description: "choose the model",
    // Values come from the registry at runtime (§10.12).
    args: [{ name: "model", hint: "model id or alias" }],
  },
  {
    name: "/effort",
    description: "choose the reasoning effort or mode",
    args: [{ name: "effort", hint: "effort or mode" }],
  },
  { name: "/setting", description: "open the settings popup" },
  { name: "/permissions", description: "choose permission preset (read|edit|auto|yolo)", args: [{ name: "preset", values: ["read", "edit", "auto", "yolo"] }] },
  { name: "/mode", description: "switch Build or Plan interaction mode", args: [{ name: "mode", values: ["build", "plan"] }] },
  {
    name: "/plan",
    description: "enter, review, approve, or execute the Plan Contract",
    args: [
      { name: "action", values: ["enter", "show", "refine", "approve", "execute"] },
      { name: "strategy", values: ["keep", "compact"], hint: "context strategy" },
    ],
  },
  { name: "/status", description: "show usage, cost, and session status" },
  { name: "/skills", description: "list or inspect Skills", args: [{ name: "skill" }] },
  { name: "/mcp", description: "show MCP server health" },
  { name: "/context", description: "inspect the context budget" },
  { name: "/compact", description: "compact the session context" },
  { name: "/new", description: "start a new chat" },
  { name: "/resume", description: "resume a session", args: [{ name: "session" }] },
  {
    name: "/export",
    description: "export the transcript",
    args: [{ name: "format", values: ["markdown", "jsonl", "bundle"] }],
  },
  { name: "/quit", description: "exit" },
];

export function searchSlashCommands(query: string): readonly SlashCommand[] {
  const needle = query.replace(/^\//, "").toLowerCase();
  if (needle.length === 0) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) =>
      command.name.slice(1).toLowerCase().startsWith(needle) ||
      command.description.toLowerCase().includes(needle),
  );
}

export interface OverlayStackEntry {
  readonly kind: OverlayKind;
  readonly body: readonly StyledLine[];
  readonly capturing: boolean;
}

export function isCapturingOverlay(kind: OverlayKind): boolean {
  return kind === "command_palette" || kind === "model_picker" || kind === "reasoning_picker" || kind === "sessions";
}

/** Frame an overlay as a centered modal popup with borders and title. */
export function renderOverlay(
  kind: OverlayKind,
  body: readonly StyledLine[],
  context: BlockContext,
): StyledLine[] {
  const title = OVERLAY_TITLES[kind] ?? kind;
  const capHint = isCapturingOverlay(kind) ? "esc to close" : "esc to close · typing stays in editor";
  const unicode = context.capabilities.unicode;

  let maxContentWidth = stringWidth(`${title}  ${capHint}`);
  for (const lineEntry of body) {
    let w = 0;
    for (const seg of lineEntry.segments) {
      w += stringWidth(seg.text);
    }
    if (w > maxContentWidth) maxContentWidth = w;
  }

  const minBoxWidth = 60;
  const maxBoxWidth = Math.max(minBoxWidth, context.columns - 4);
  const boxInnerWidth = Math.min(maxBoxWidth - 6, Math.max(minBoxWidth - 6, maxContentWidth));
  const boxWidth = boxInnerWidth + 6;

  const leftMarginSize = Math.max(0, Math.floor((context.columns - boxWidth) / 2));
  const leftMargin = " ".repeat(leftMarginSize);

  const topLeft = unicode ? "╭" : "+";
  const topRight = unicode ? "╮" : "+";
  const bottomLeft = unicode ? "╰" : "+";
  const bottomRight = unicode ? "╯" : "+";
  const horizontal = unicode ? "─" : "-";
  const vertical = unicode ? "│" : "|";

  const titleText = ` ${title} `;
  const hintText = ` ${capHint} `;
  const remDash = Math.max(1, boxWidth - 2 - stringWidth(titleText) - stringWidth(hintText));
  const dashLeft = horizontal.repeat(2);
  const dashRight = horizontal.repeat(Math.max(1, remDash - 2));

  const topHeaderLine = fitLine(
    "overlay",
    [
      segment(leftMargin, { fg: "fg.primary" }),
      segment(topLeft, { fg: "border.warm" }),
      segment(titleText, { fg: "accent.coral", bold: true }),
      segment(dashLeft, { fg: "border.warm" }),
      segment(hintText, { fg: "fg.muted", italic: true }),
      segment(dashRight, { fg: "border.warm" }),
      segment(topRight, { fg: "border.warm" }),
    ],
    context,
  );

  const emptyPaddingLine = fitLine(
    "overlay",
    [
      segment(leftMargin, { fg: "fg.primary" }),
      segment(vertical, { fg: "border.warm" }),
      segment(" ".repeat(boxWidth - 2), { fg: "fg.primary" }),
      segment(vertical, { fg: "border.warm" }),
    ],
    context,
  );

  const boxBodyLines: StyledLine[] = body.map((styled) => {
    let lineWidth = 0;
    for (const seg of styled.segments) {
      lineWidth += stringWidth(seg.text);
    }
    const rightPad = Math.max(0, boxInnerWidth - lineWidth);
    return fitLine(
      "overlay",
      [
        segment(leftMargin, { fg: "fg.primary" }),
        segment(`${vertical}  `, { fg: "border.warm" }),
        ...styled.segments,
        segment(`${" ".repeat(rightPad)}  ${vertical}`, { fg: "border.warm" }),
      ],
      context,
    );
  });

  const bottomBorderLine = fitLine(
    "overlay",
    [
      segment(leftMargin, { fg: "fg.primary" }),
      segment(bottomLeft + horizontal.repeat(boxWidth - 2) + bottomRight, { fg: "border.warm" }),
    ],
    context,
  );

  return [topHeaderLine, emptyPaddingLine, ...boxBodyLines, emptyPaddingLine, bottomBorderLine];
}

/**
 * Render the structured Plan Contract inside the common overlay chrome.
 *
 * Keeping this adapter in the overlay module lets hosts open a `plan` lens without
 * knowing how a contract is laid out, while `renderPlanContract` remains reusable
 * for append-only/plain clients.
 */
export function renderPlanOverlay(
  input: PlanContractRenderInput,
  context: BlockContext,
): StyledLine[] {
  return renderOverlay("plan", renderPlanContract(input, context), context);
}

/** Backwards/host-friendly alias for callers that name the lens explicitly. */
export const renderPlanContractOverlay = renderPlanOverlay;

export function renderOverlayStack(
  entries: readonly OverlayStackEntry[],
  context: BlockContext,
): StyledLine[] {
  if (entries.length === 0) return [];
  const top = entries[entries.length - 1]!;
  return renderOverlay(top.kind, top.body, context);
}

export interface SelectableRow {
  readonly label: string;
  readonly detail?: string;
  readonly badge?: string;
  readonly badgeToken?: ThemeToken;
  readonly disabled?: boolean;
}

/** A generic selectable list, used by the picker overlays. */
export function renderSelectableList(
  rows: readonly SelectableRow[],
  selected: number,
  context: BlockContext,
): StyledLine[] {
  if (rows.length === 0) {
    return [line("overlay", [segment("  (nothing to show)", { fg: "fg.muted", italic: true })])];
  }

  const labelWidth = rows.reduce((max, row) => Math.max(max, stringWidth(row.label)), 0);
  const detailWidth = rows.reduce((max, row) => Math.max(max, row.detail !== undefined ? stringWidth(row.detail) : 0), 0);
  const twoCol = detailWidth > 0 && context.columns >= labelWidth + detailWidth + 8;

  return rows.map((row, index) => {
    const active = index === selected;
    const marker = active ? (context.capabilities.unicode ? "▸ " : "> ") : "  ";
    const markerStyle: import("./segments.ts").SegmentStyle = active ? { fg: "accent.cyan", bold: true } : { fg: "accent.coral" };
    const labelStyle: import("./segments.ts").SegmentStyle = row.disabled === true
      ? { fg: "fg.muted", dim: true }
      : active
        ? { fg: "fg.primary", bold: true }
        : { fg: "fg.primary" };
    const segments: Segment[] = [
      segment(marker, markerStyle),
      segment(row.label.padEnd(twoCol ? labelWidth : labelWidth), labelStyle),
    ];
    if (row.badge !== undefined) {
      segments.push(segment(`  [${row.badge}]`, { fg: row.badgeToken ?? "accent.cyan" }));
    }
    if (row.detail !== undefined) {
      const detail = sanitizeInline(row.detail, twoCol ? 60 : 120);
      const pad = twoCol ? Math.max(2, 40 - stringWidth(row.label)) : 2;
      const detailStyle: import("./segments.ts").SegmentStyle = active ? { fg: "fg.primary" } : { fg: "fg.muted", dim: true };
      segments.push(segment(`${" ".repeat(pad)}${detail}`, detailStyle));
    }
    return fitLine("overlay", segments, context);
  });
}

// ---------------------------------------------------------------------------
// §6.18 diff viewer
// ---------------------------------------------------------------------------

/** §6.18's scope selector. */
export type DiffScope = "turn" | "session" | "working_tree";

export const DIFF_SCOPES: readonly DiffScope[] = ["turn", "session", "working_tree"];

export const DIFF_SCOPE_LABELS: Readonly<Record<DiffScope, string>> = {
  turn: "current turn",
  session: "entire session",
  working_tree: "working tree",
};

export type HunkLineKind = "context" | "added" | "removed" | "header";

export interface HunkLine {
  readonly kind: HunkLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly HunkLine[];
}

export interface DiffFileView {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** §6.18: a binary file shows metadata only. */
  readonly binary?: boolean;
  /** §6.18: user changes are visually distinct from agent changes. */
  readonly origin: "agent" | "user" | "mixed";
  readonly bytes?: number;
}

export interface DiffViewerState {
  readonly scope: DiffScope;
  readonly files: readonly DiffFileView[];
  readonly selectedFile: number;
  readonly selectedHunk?: number;
  /** §6.18: whitespace-only changes can be hidden. */
  readonly hideWhitespaceOnly?: boolean;
}

/** Whether a hunk changes only whitespace (§6.18's toggle). */
export function isWhitespaceOnlyHunk(hunk: DiffHunk): boolean {
  const added = hunk.lines.filter((l) => l.kind === "added").map((l) => l.text.trim());
  const removed = hunk.lines.filter((l) => l.kind === "removed").map((l) => l.text.trim());
  if (added.length === 0 && removed.length === 0) return false;
  if (added.length !== removed.length) return false;
  return added.every((text, index) => text === removed[index]);
}

/**
 * Render the §6.18 viewer.
 *
 * §6.18's requirements met here: a file list with counts, hunk navigation, the
 * whitespace toggle, scope selection, agent-versus-user origin, and metadata-only
 * for binaries. Hunk-level accept and reject is P1; P0 offers turn-level undo, so
 * this view is read-only by design.
 */
export function renderDiffViewer(
  state: DiffViewerState,
  context: BlockContext,
  options: { sideBySideMetadata?: boolean; maxHunkLines?: number } = {},
): StyledLine[] {
  const glyphs = treeGlyphs(context.capabilities);
  const totals = state.files.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  const lines: StyledLine[] = [
    fitLine(
      "diff",
      [
        segment("Scope: ", { fg: "fg.muted" }),
        segment(DIFF_SCOPE_LABELS[state.scope], { fg: "accent.cyan", bold: true }),
        segment(`  ${state.files.length} file(s)  `, { fg: "fg.muted" }),
        segment(`+${totals.additions}`, { fg: "accent.green" }),
        segment(` -${totals.deletions}`, { fg: "accent.red" }),
        ...(state.hideWhitespaceOnly === true
          ? [segment("  (whitespace-only hidden)", { fg: "fg.muted", italic: true })]
          : []),
      ],
      context,
    ),
    blank(),
  ];

  // ---- File list ----
  const pathWidth = state.files.reduce((max, file) => Math.max(max, stringWidth(file.path)), 0);
  state.files.forEach((file, index) => {
    const active = index === state.selectedFile;
    const segments: Segment[] = [
      segment(active ? (context.capabilities.unicode ? "▸ " : "> ") : "  ", { fg: "accent.coral" }),
      segment(file.path.padEnd(pathWidth), active ? { fg: "fg.primary", bold: true } : { fg: "fg.primary" }),
      segment(` +${file.additions}`, { fg: "accent.green" }),
      segment(` -${file.deletions}`, { fg: "accent.red" }),
    ];
    // §6.18: say whose change this is, in words.
    if (file.origin !== "agent") {
      segments.push(
        segment(`  [${file.origin === "user" ? "your change" : "mixed"}]`, {
          fg: "accent.amber",
        }),
      );
    }
    if (file.binary === true) {
      segments.push(segment("  [binary]", { fg: "fg.muted" }));
    }
    lines.push(fitLine("diff", segments, context));
  });

  const file = state.files[state.selectedFile];
  if (file === undefined) return lines;

  lines.push(blank());

  // §6.18: a binary file shows metadata and nothing else.
  if (file.binary === true) {
    lines.push(
      fitLine(
        "diff",
        [
          segment(`${icon("artifact", context.capabilities)} `, { fg: "fg.muted" }),
          segment(`binary file`, { fg: "fg.muted", bold: true }),
          ...(file.bytes !== undefined
            ? [segment(` · ${file.bytes} bytes`, { fg: "fg.muted" })]
            : []),
        ],
        context,
      ),
    );
    return lines;
  }

  const visibleHunks = file.hunks.filter(
    (hunk) => state.hideWhitespaceOnly !== true || !isWhitespaceOnlyHunk(hunk),
  );

  if (visibleHunks.length === 0) {
    lines.push(
      line("diff", [segment("  no hunks to show at this filter", { fg: "fg.muted", italic: true })]),
    );
    return lines;
  }

  const maxHunkLines = options.maxHunkLines ?? 60;
  visibleHunks.forEach((hunk, hunkIndex) => {
    const active = state.selectedHunk === hunkIndex;
    lines.push(
      fitLine(
        "diff",
        [
          segment(active ? glyphs.branch : "  ", { fg: "border.warm" }),
          segment(` ${sanitizeInline(hunk.header, 120)}`, {
            fg: "accent.cyan",
            bold: active,
          }),
          ...(options.sideBySideMetadata === true
            ? [segment(`   ${hunk.lines.length} line(s)`, { fg: "fg.muted" })]
            : []),
        ],
        context,
      ),
    );

    for (const hunkLine of hunk.lines.slice(0, maxHunkLines)) {
      lines.push(renderHunkLine(hunkLine, context));
    }
    if (hunk.lines.length > maxHunkLines) {
      lines.push(
        line("diff", [
          segment(`    …${hunk.lines.length - maxHunkLines} more line(s)`, {
            fg: "fg.muted",
            italic: true,
          }),
        ]),
      );
    }
  });

  return lines;
}

function renderHunkLine(hunkLine: HunkLine, context: BlockContext): StyledLine {
  // §6.5: the marker character distinguishes added from removed with no colour.
  const marker =
    hunkLine.kind === "added" ? "+" : hunkLine.kind === "removed" ? "-" : hunkLine.kind === "header" ? "@" : " ";
  const token: ThemeToken =
    hunkLine.kind === "added"
      ? "accent.green"
      : hunkLine.kind === "removed"
        ? "accent.red"
        : hunkLine.kind === "header"
          ? "accent.cyan"
          : "fg.muted";

  const gutter =
    hunkLine.newLine !== undefined
      ? String(hunkLine.newLine).padStart(5)
      : hunkLine.oldLine !== undefined
        ? String(hunkLine.oldLine).padStart(5)
        : "     ";

  return fitLine(
    "diff",
    [
      segment(`${gutter} `, { fg: "fg.muted" }),
      segment(marker, { fg: token, bold: true }),
      segment(truncateToWidth(hunkLine.text, Math.max(8, context.columns - 8)), {
        fg: hunkLine.kind === "context" ? "fg.primary" : token,
      }),
    ],
    context,
  );
}

/** Parse a unified diff into the viewer's model. */
export function parseUnifiedDiff(
  diff: string,
  options: { origin?: DiffFileView["origin"] } = {},
): DiffFileView[] {
  const files: DiffFileView[] = [];
  let current: {
    path: string;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
  } | undefined;
  let hunk: { header: string; lines: HunkLine[] } | undefined;
  let oldLine = 0;
  let newLine = 0;

  const flushHunk = (): void => {
    if (hunk !== undefined && current !== undefined) current.hunks.push(hunk);
    hunk = undefined;
  };
  const flushFile = (): void => {
    flushHunk();
    if (current !== undefined) {
      files.push({
        path: current.path,
        additions: current.additions,
        deletions: current.deletions,
        hunks: current.hunks,
        origin: options.origin ?? "agent",
      });
    }
    current = undefined;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushFile();
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "").trim();
      if (path !== "/dev/null") {
        current = { path, hunks: [], additions: 0, deletions: 0 };
      }
      continue;
    }
    if (raw.startsWith("--- ")) continue;

    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunkHeader !== null) {
      flushHunk();
      oldLine = Number(hunkHeader[1] ?? 1);
      newLine = Number(hunkHeader[2] ?? 1);
      hunk = { header: raw, lines: [] };
      continue;
    }

    if (hunk === undefined || current === undefined) continue;

    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "added", text: raw.slice(1), newLine });
      newLine += 1;
      current.additions += 1;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "removed", text: raw.slice(1), oldLine });
      oldLine += 1;
      current.deletions += 1;
    } else if (raw.startsWith(" ") || raw.length === 0) {
      hunk.lines.push({ kind: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  flushFile();
  return files;
}
