/**
 * Overlays and the diff viewer — PRD §6.17, §6.18, §8.10.
 *
 * §6.17: P0 has no permanent sidebar. Everything here appears on a key press and
 * closes on `Esc`, and while one is open the active job keeps running with the live
 * status still minimally visible — an overlay is a lens, not a modal that stops work.
 */

import { sanitizeInline } from "./sanitize.ts";
import { renderPlanContract, type PlanContractRenderInput } from "./todo.ts";
import { blank, fitLine, line, lineWidth, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import { icon, treeGlyphs, type ThemeToken } from "./theme.ts";
import { stringWidth, truncateToWidth, wrapToWidth } from "./width.ts";

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
  | "settings"
  | "details"
  | "help"
  | "memory"
  | "graph"
  | "worktree"
  | "plugins"
  | "doctor";

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
  "settings",
  "details",
  "help",
  "memory",
  "graph",
  "worktree",
  "plugins",
  "doctor",
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
  settings: "Settings",
  details: "Transcript details",
  help: "Help",
  memory: "Memory",
  graph: "Agent graph",
  worktree: "Worktrees",
  plugins: "Plugins",
  doctor: "OpenAI diagnostic",
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
    description: "choose the model, or profile:<name> for a recommended profile",
    // Values come from the registry at runtime (§10.12).
    args: [{ name: "model", hint: "model id, alias, or profile:<name>" }],
  },
  {
    name: "/effort",
    description: "choose the reasoning effort or mode",
    args: [{ name: "effort", hint: "effort or mode" }],
  },
  { name: "/setting", description: "open the settings popup" },
  { name: "/permissions", description: "choose permission preset (read|edit|auto|yolo)", args: [{ name: "preset", values: ["read", "edit", "auto", "yolo"] }] },
  { name: "/mode", description: "switch Build or Plan interaction mode", args: [{ name: "mode", values: ["build", "plan"] }] },
  { name: "/status", description: "show usage, cost, and session status" },
  { name: "/doctor", description: "diagnose the active OpenAI feature set and why a disabled one is off" },
  {
    name: "/skills",
    description: "list, inspect, reload, or diagnose Skills",
    args: [{ name: "action or skill" }, { name: "skill" }],
  },
  { name: "/mcp", description: "show MCP server health" },
  { name: "/context", description: "inspect the context budget" },
  { name: "/memory", description: "inspect, forget, or resolve durable memory", args: [{ name: "action", values: ["inspect", "forget", "resolve"] }] },
  {
    name: "/learn",
    description: "review, accept, reject, forget, or roll back strategy capsules",
    args: [
      { name: "action", values: ["review", "accept", "reject", "forget", "rollback"] },
      { name: "capsule", hint: "capsule id" },
    ],
  },
  { name: "/graph", description: "inspect the durable agent graph" },
  { name: "/worktree", description: "inspect isolated writer worktrees" },
  {
    name: "/plugins",
    description: "search, install, update, remove, inspect, enable, disable, or list plugins",
    args: [
      {
        name: "action",
        values: ["list", "search", "install", "update", "remove", "inspect", "enable", "disable", "grants"],
      },
      { name: "package or plugin", hint: "registry source, package id, or plugin id" },
    ],
  },
  { name: "/compact", description: "compact the session context" },
  { name: "/new", description: "start a new chat" },
  { name: "/resume", description: "resume a session", args: [{ name: "session" }] },
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
// Large Skill catalog browser
// ---------------------------------------------------------------------------

/** Stage-1 metadata needed by the interactive Skill catalog. Bodies stay lazy. */
export interface SkillBrowserEntry {
  readonly name: string;
  readonly description: string;
  readonly scope: "project" | "user" | "builtin";
  readonly origin: string;
  readonly path: string;
  readonly version?: string;
}

export interface SkillBrowserListOptions {
  readonly query: string;
  readonly selected: number;
  readonly top: number;
  /** Maximum number of catalog rows to materialize for this frame. */
  readonly pageRows: number;
  readonly notice?: string;
}

export interface SkillBrowserListRender {
  readonly lines: readonly StyledLine[];
  readonly matches: readonly SkillBrowserEntry[];
  readonly selected: number;
  readonly top: number;
  readonly pageRows: number;
}

export interface SkillBrowserDetailOptions {
  readonly offset: number;
  /** Maximum number of wrapped detail rows to materialize for this frame. */
  readonly pageRows: number;
}

export interface SkillBrowserDetailRender {
  readonly lines: readonly StyledLine[];
  readonly offset: number;
  readonly totalRows: number;
  readonly pageRows: number;
}

/**
 * Search the complete stage-1 catalog without ever loading a Skill body.
 *
 * Whitespace-delimited terms are ANDed, so `project deploy` narrows naturally.
 * Source and path participate because names alone are not enough when compatible
 * Skill directories contain similarly named entries.
 */
export function filterSkillBrowserEntries(
  entries: readonly SkillBrowserEntry[],
  query: string,
): readonly SkillBrowserEntry[] {
  const terms = normalizeSkillSearch(query).split(/\s+/u).filter((term) => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = normalizeSkillSearch([
      entry.name,
      entry.description,
      entry.scope,
      entry.origin,
      entry.path,
      entry.version ?? "",
    ].join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Render only the visible Skill rows. A 900-entry catalog costs the same number
 * of layout rows as a 9-entry catalog; filtering is the only complete-catalog
 * pass and uses stage-1 strings exclusively.
 */
export function renderSkillBrowserList(
  entries: readonly SkillBrowserEntry[],
  options: SkillBrowserListOptions,
  context: BlockContext,
): SkillBrowserListRender {
  const matches = filterSkillBrowserEntries(entries, options.query);
  const pageRows = Math.max(1, Math.floor(options.pageRows));
  const selected = matches.length === 0
    ? 0
    : Math.min(matches.length - 1, Math.max(0, Math.floor(options.selected)));
  const maxTop = Math.max(0, matches.length - pageRows);
  let top = Math.min(maxTop, Math.max(0, Math.floor(options.top)));
  if (selected < top) top = selected;
  if (selected >= top + pageRows) top = selected - pageRows + 1;

  const content = overlayContentContext(context);
  const lines: StyledLine[] = [
    fitLine("overlay", [
      segment("Filter  ", { fg: "fg.muted", bold: true }),
      options.query.length > 0
        ? segment(sanitizeInline(options.query, 160), { fg: "fg.primary", underline: true })
        : segment("type to search name, description, source, or path", { fg: "fg.muted", italic: true }),
    ], content),
  ];

  if (options.notice !== undefined && options.notice.length > 0) {
    lines.push(fitLine("overlay", [segment(sanitizeInline(options.notice), { fg: "accent.green" })], content));
  }

  const first = matches.length === 0 ? 0 : top + 1;
  const last = Math.min(matches.length, top + pageRows);
  const totalSuffix = matches.length === entries.length
    ? `${matches.length} total`
    : `${matches.length} matched · ${entries.length} total`;
  lines.push(
    fitLine("overlay", [
      segment("Skills  ", { fg: "accent.coral", bold: true }),
      segment(matches.length === 0 ? `0 of ${totalSuffix}` : `${first}–${last} of ${totalSuffix}`, { fg: "fg.muted" }),
    ], content),
    blank(),
  );

  const visible = matches.slice(top, top + pageRows);
  if (visible.length === 0) {
    lines.push(line("overlay", [
      segment("  No Skills match this filter.", { fg: "fg.muted", italic: true }),
    ]));
  } else {
    const labelWidth = Math.min(
      30,
      visible.reduce((maximum, entry) => Math.max(maximum, stringWidth(`$${entry.name}`)), 0),
    );
    const scrollbar = catalogScrollbar(visible.length, top, pageRows, matches.length, context);
    visible.forEach((entry, index) => {
      const active = top + index === selected;
      const marker = active ? (context.capabilities.unicode ? "▸ " : "> ") : "  ";
      const fullLabel = `$${sanitizeInline(entry.name, 160)}`;
      const rawLabel = stringWidth(fullLabel) <= labelWidth
        ? fullLabel
        : truncateToWidth(fullLabel, labelWidth);
      const label = rawLabel + " ".repeat(Math.max(0, labelWidth - stringWidth(rawLabel)));
      const version = entry.version === undefined ? "" : ` v${sanitizeInline(entry.version, 40)}`;
      const badge = `[${entry.scope}/${sanitizeInline(entry.origin, 40)}${version}]`;
      const row = fitLine("overlay", [
        segment(marker, active ? { fg: "accent.cyan", bold: true } : { fg: "fg.muted" }),
        segment(label, active ? { fg: "fg.primary", bold: true } : { fg: "fg.primary" }),
        segment(`  ${badge}  `, { fg: scopeToken(entry.scope), dim: !active }),
        segment(sanitizeInline(entry.description, 600), active ? { fg: "fg.primary" } : { fg: "fg.muted" }),
      ], { ...content, columns: Math.max(1, content.columns - 2) });
      lines.push(withCatalogRail(row, scrollbar[index] ?? " ", content));
    });
  }

  lines.push(
    blank(),
    fitLine("overlay", [
      segment("↑↓", { fg: "accent.cyan", bold: true }),
      segment(" move · ", { fg: "fg.muted" }),
      segment("PgUp/PgDn", { fg: "accent.cyan" }),
      segment(" page · ", { fg: "fg.muted" }),
      segment("Enter", { fg: "accent.cyan" }),
      segment(" details · ", { fg: "fg.muted" }),
      segment("Esc", { fg: "accent.cyan" }),
      segment(" close", { fg: "fg.muted" }),
    ], content),
  );

  return { lines, matches, selected, top, pageRows };
}

/** Render a wrapped, independently scrollable detail document for one Skill. */
export function renderSkillBrowserDetail(
  entry: SkillBrowserEntry,
  detail: readonly string[],
  options: SkillBrowserDetailOptions,
  context: BlockContext,
): SkillBrowserDetailRender {
  const content = overlayContentContext(context);
  const pageRows = Math.max(1, Math.floor(options.pageRows));
  const wrapped: string[] = [];
  for (const raw of detail) {
    const safe = sanitizeInline(raw, 8_000);
    wrapped.push(...wrapToWidth(safe.length > 0 ? safe : " ", content.columns));
  }
  const totalRows = wrapped.length;
  const maxOffset = Math.max(0, totalRows - pageRows);
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(options.offset)));
  const first = totalRows === 0 ? 0 : offset + 1;
  const last = Math.min(totalRows, offset + pageRows);
  const lines: StyledLine[] = [
    fitLine("overlay", [
      segment(`$${sanitizeInline(entry.name, 160)}`, { fg: "accent.coral", bold: true }),
      segment(`  [${entry.scope}/${sanitizeInline(entry.origin, 40)}]`, { fg: scopeToken(entry.scope) }),
      segment(`  ${first}–${last} of ${totalRows}`, { fg: "fg.muted" }),
    ], content),
    blank(),
    ...wrapped.slice(offset, offset + pageRows).map((value, index) =>
      line("overlay", [segment(value, index === 0 && offset === 0 ? { fg: "fg.primary", bold: true } : { fg: "fg.primary" })]),
    ),
    blank(),
    fitLine("overlay", [
      segment("↑↓", { fg: "accent.cyan", bold: true }),
      segment(" scroll · ", { fg: "fg.muted" }),
      segment("PgUp/PgDn", { fg: "accent.cyan" }),
      segment(" page · ", { fg: "fg.muted" }),
      segment("←/Esc", { fg: "accent.cyan" }),
      segment(" back", { fg: "fg.muted" }),
    ], content),
  ];
  return { lines, offset, totalRows, pageRows };
}

function normalizeSkillSearch(value: string): string {
  return sanitizeInline(value.normalize("NFKC"), 8_000).toLowerCase();
}

function overlayContentContext(context: BlockContext): BlockContext {
  return { ...context, columns: Math.max(20, context.columns - 10) };
}

function scopeToken(scope: SkillBrowserEntry["scope"]): ThemeToken {
  if (scope === "project") return "accent.green";
  if (scope === "user") return "accent.cyan";
  return "fg.muted";
}

function catalogScrollbar(
  visibleRows: number,
  top: number,
  pageRows: number,
  totalRows: number,
  context: BlockContext,
): string[] {
  if (visibleRows === 0 || totalRows <= pageRows) return Array.from({ length: visibleRows }, () => " ");
  const thumbRows = Math.max(1, Math.min(visibleRows, Math.round((pageRows * pageRows) / totalRows)));
  const travel = Math.max(0, visibleRows - thumbRows);
  const maxTop = Math.max(1, totalRows - pageRows);
  const thumbStart = Math.round((Math.min(top, maxTop) / maxTop) * travel);
  const track = context.capabilities.unicode ? "│" : "|";
  const thumb = context.capabilities.unicode ? "█" : "#";
  return Array.from({ length: visibleRows }, (_, index) =>
    index >= thumbStart && index < thumbStart + thumbRows ? thumb : track,
  );
}

function withCatalogRail(row: StyledLine, rail: string, context: BlockContext): StyledLine {
  const padding = Math.max(1, context.columns - lineWidth(row) - 1);
  return line("overlay", [
    ...row.segments,
    segment(" ".repeat(padding)),
    segment(rail, rail === "█" || rail === "#"
      ? { fg: "accent.cyan", bold: true }
      : { fg: "fg.muted", dim: true }),
  ]);
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
