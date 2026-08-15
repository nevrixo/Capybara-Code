/**
 * Composer completion — PRD §6.14, §8.10.
 *
 * §6.14 asks the composer to complete three things: a `@path`, a `$skill`, and a
 * `/command`. This module adds the fourth stage that makes a command usable without
 * memorising it — its *arguments* — and holds the selection state so `Tab` and the
 * arrow keys act on the same list the popup is drawing.
 *
 * The design follows a game console rather than a shell. As soon as `/` is typed the
 * whole command set is on screen with descriptions; typing narrows it; accepting a
 * command that takes arguments advances the popup to those arguments instead of
 * closing. That matters because §8.10's commands are the only way to reach several
 * host actions, and a user who cannot remember `/effort`'s legal values cannot
 * use it from a blank prompt.
 *
 * Nothing here reads the world. Argument values that depend on session state — the
 * model registry, the session list — arrive through `CompletionSources`, so this
 * file stays a pure function of the composer text and is testable as one.
 */

import { sanitizeInline } from "./sanitize.ts";
import {
  fitLine,
  line,
  segment,
  type BlockContext,
  type Segment,
  type StyledLine,
} from "./segments.ts";
import { SLASH_COMMANDS, type CommandArgument, type SlashCommand } from "./overlays.ts";
import { padToWidth, stringWidth, truncateToWidth } from "./width.ts";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** §6.14 completion kinds, plus the argument stage. */
export type CompletionKind = "path" | "skill" | "command" | "argument" | "none";

/** Which completion the composer should offer for `text` at `cursor`. */
export function completionKindAt(text: string, cursor: number): CompletionKind {
  if (pathTokenAt(text, cursor) !== undefined) return "path";

  const before = text.slice(0, cursor);
  const token = /(\S+)$/.exec(before)?.[1] ?? "";

  if (token.startsWith("$")) return "skill";
  // §8.10: a slash command is only a command at the start of the input.
  if (token.startsWith("/") && before.trimStart() === token) return "command";

  // A command already accepted, now taking arguments. Checked after the token
  // tests so a `@path` typed as an argument still completes as a path.
  if (before.trimStart().startsWith("/")) return "argument";
  return "none";
}

/** The partial token a completion should match against. */
export function completionPrefix(text: string, cursor: number): string {
  const mention = pathTokenAt(text, cursor);
  if (mention !== undefined) return mention.query;

  const before = text.slice(0, cursor);
  const token = /(\S+)$/.exec(before)?.[1] ?? "";
  return token.replace(/^[$/]/, "");
}

export interface CompletionCandidate {
  readonly value: string;
  readonly detail?: string;
  /**
   * Text inserted in place of `value`, when the two differ. A command that takes
   * arguments inserts a trailing space so the popup can advance straight to them.
   */
  readonly insert?: string;
}

/** The signature hint, with the argument being typed marked as active. */
export interface CompletionSignature {
  readonly command: string;
  readonly args: ReadonlyArray<{ readonly text: string; readonly active: boolean }>;
}

export interface CompletionState {
  readonly kind: CompletionKind;
  readonly open: boolean;
  readonly candidates: readonly CompletionCandidate[];
  readonly selected: number;
  /** Character range in the composer text this completion replaces. */
  readonly from: number;
  readonly to: number;
  /** The partial token being matched. */
  readonly query: string;
  /** The command this stage belongs to, once one is recognized. */
  readonly command?: string;
  readonly signature?: CompletionSignature;
}

export const CLOSED_COMPLETION: CompletionState = {
  kind: "none",
  open: false,
  candidates: [],
  selected: 0,
  from: 0,
  to: 0,
  query: "",
};

export interface CompletionSources {
  /** Command set. Defaults to §8.10's table. */
  readonly commands?: readonly SlashCommand[];
  /**
   * Values for an argument the spec cannot enumerate ahead of time — the model
   * list, the session list. Returning `undefined` falls back to the spec's own
   * `values`.
   */
  readonly argumentValues?: (input: {
    readonly command: string;
    readonly index: number;
    readonly argument: CommandArgument | undefined;
    readonly query: string;
    /** Argument tokens already typed before the active one, in order. */
    readonly preceding: readonly string[];
  }) => readonly CompletionCandidate[] | undefined;
  /**
   * Workspace-relative paths matching the text after `@`. Because completion
   * replaces the whole token (including `@`), semantic mention sources should set
   * `insert` to an `@`-prefixed token while keeping `value` suitable for display.
   */
  readonly paths?: (query: string) => readonly CompletionCandidate[];
  readonly skills?: (query: string) => readonly CompletionCandidate[];
}

interface Token {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

interface ActiveMentionToken {
  readonly from: number;
  readonly to: number;
  /** Path text typed between the sigil/opening quote and the caret. */
  readonly query: string;
}

/**
 * Locate an `@path` token around the caret, including a suffix to its right.
 * Quoted tokens may contain whitespace and escaped quotes; unquoted tokens end at
 * whitespace. Returning the full range prevents accepting a completion mid-token
 * from leaving the old suffix behind.
 */
function pathTokenAt(text: string, cursor: number): ActiveMentionToken | undefined {
  const clamped = Math.max(0, Math.min(cursor, text.length));

  for (let from = clamped - 1; from >= 0; from -= 1) {
    if (text[from] !== "@") continue;
    if (from > 0 && !/\s/u.test(text[from - 1] ?? "")) continue;

    if (text[from + 1] === '"') {
      let closing = text.length;
      for (let index = from + 2; index < text.length; index += 1) {
        if (text[index] === "\\" && text[index + 1] === '"') {
          index += 1;
          continue;
        }
        if (text[index] === '"') {
          closing = index;
          break;
        }
      }
      const to = closing < text.length ? closing + 1 : text.length;
      if (clamped < from + 2 || clamped > to) continue;
      const queryEnd = Math.min(clamped, closing);
      return {
        from,
        to,
        query: text.slice(from + 2, queryEnd).replace(/\\"/g, '"'),
      };
    }

    let to = from + 1;
    while (to < text.length && !/\s/u.test(text[to] ?? "")) to += 1;
    if (clamped < from + 1 || clamped > to) continue;
    return { from, to, query: text.slice(from + 1, clamped) };
  }
  return undefined;
}

/** Split on whitespace, keeping each token's offsets in the original string. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  for (const match of text.matchAll(pattern)) {
    tokens.push({ text: match[0], from: match.index, to: match.index + match[0].length });
  }
  return tokens;
}

/**
 * Build the popup state for a composer position.
 *
 * Returns a closed state rather than an empty open one when there is nothing to
 * offer, so a caller can treat `open` as "the popup owns Tab and the arrows right now"
 * without also checking the candidate count.
 */
export function computeCompletions(
  text: string,
  cursor: number,
  sources: CompletionSources = {},
): CompletionState {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const mention = pathTokenAt(text, clamped);
  if (mention !== undefined) {
    return openOrClosed({
      kind: "path",
      candidates: sources.paths?.(mention.query) ?? [],
      from: mention.from,
      to: mention.to,
      query: mention.query,
    });
  }

  const before = text.slice(0, clamped);
  const activeToken = /(\S*)$/.exec(before)?.[1] ?? "";
  const tokenFrom = clamped - activeToken.length;
  let tokenTo = clamped;
  if (activeToken.length > 0) {
    while (tokenTo < text.length && !/\s/u.test(text[tokenTo] ?? "")) tokenTo += 1;
  }

  if (activeToken.startsWith("$")) {
    const query = activeToken.slice(1);
    return openOrClosed({
      kind: "skill",
      candidates: sources.skills?.(query) ?? [],
      from: tokenFrom,
      to: tokenTo,
      query,
    });
  }

  const trimmed = before.trimStart();
  if (!trimmed.startsWith("/")) return CLOSED_COMPLETION;

  const commands = sources.commands ?? SLASH_COMMANDS;
  const tokens = tokenize(before);
  const head = tokens[0];
  if (head === undefined) return CLOSED_COMPLETION;

  // Still typing the command name: the cursor has not left the first token.
  const typingCommand = tokens.length === 1 && clamped <= head.to;
  if (typingCommand) {
    const query = head.text.slice(1);
    return openOrClosed({
      kind: "command",
      candidates: commandCandidates(commands, query),
      from: head.from,
      to: tokenTo,
      query,
    });
  }

  const command = commands.find((c) => c.name.toLowerCase() === head.text.toLowerCase());
  if (command === undefined) return CLOSED_COMPLETION;

  // Which argument the cursor sits in. Tokens after the command name are
  // arguments, and an empty active token means a fresh one is being started.
  const index = Math.max(0, tokens.length - 1 - (activeToken.length > 0 ? 1 : 0));
  const argument = command.args?.[index];
  const query = activeToken;
  const preceding = tokens.slice(1, 1 + index).map((token) => token.text);

  const supplied = sources.argumentValues?.({
    command: command.name,
    index,
    argument,
    query,
    preceding,
  });
  const fromSpec = argument?.values?.map((value) => ({ value }));
  const pool = supplied ?? fromSpec ?? [];
  const candidates = filterCandidates(pool, query);

  return openOrClosed({
    kind: "argument",
    candidates,
    from: tokenFrom,
    to: tokenTo,
    query,
    command: command.name,
    signature: commandSignature(command, index),
  });
}

function openOrClosed(input: {
  kind: CompletionKind;
  candidates: readonly CompletionCandidate[];
  from: number;
  to: number;
  query: string;
  command?: string;
  signature?: CompletionSignature;
}): CompletionState {
  if (input.candidates.length === 0) {
    // The signature is still worth showing for a known command with no values
    // left to offer — it is the only hint that an argument is expected.
    if (input.signature === undefined) return CLOSED_COMPLETION;
    return {
      kind: input.kind,
      open: false,
      candidates: [],
      selected: 0,
      from: input.from,
      to: input.to,
      query: input.query,
      ...(input.command !== undefined ? { command: input.command } : {}),
      signature: input.signature,
    };
  }
  return {
    kind: input.kind,
    open: true,
    candidates: input.candidates,
    selected: 0,
    from: input.from,
    to: input.to,
    query: input.query,
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.signature !== undefined ? { signature: input.signature } : {}),
  };
}

/**
 * Rank command matches: a name prefix first, then a name substring, then a
 * description match.
 *
 * Prefix-first is the property that makes `Tab` predictable — typing `/mo` and
 * pressing `Tab` has to land on `/model`, not on whichever command happens to
 * mention "model" in its description.
 */
export function commandCandidates(
  commands: readonly SlashCommand[],
  query: string,
): CompletionCandidate[] {
  const needle = query.replace(/^\//, "").toLowerCase();
  const ranked: Array<{ rank: number; order: number; candidate: CompletionCandidate }> = [];

  for (const [order, command] of commands.entries()) {
    const name = command.name.slice(1).toLowerCase();
    const rank = needle.length === 0
      ? 0
      : name.startsWith(needle)
        ? 0
        : name.includes(needle)
          ? 1
          : command.description.toLowerCase().includes(needle)
            ? 2
            : -1;
    if (rank < 0) continue;

    ranked.push({
      rank,
      order,
      candidate: {
        value: command.name,
        detail: command.description,
        // A command with arguments inserts a trailing space, which advances the
        // popup to those arguments instead of leaving the user to guess.
        ...((command.args?.length ?? 0) > 0 ? { insert: `${command.name} ` } : {}),
      },
    });
  }

  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.map((entry) => entry.candidate);
}

function filterCandidates(
  pool: readonly CompletionCandidate[],
  query: string,
): CompletionCandidate[] {
  if (query.length === 0) return [...pool];
  const needle = query.toLowerCase();
  const valuePrefix = pool.filter((c) => c.value.toLowerCase().startsWith(needle));
  if (valuePrefix.length > 0) return valuePrefix;
  const haystack = (c: CompletionCandidate): string =>
    `${c.value} ${c.detail ?? ""} ${c.insert ?? ""}`.toLowerCase();
  const detailMatch = pool.filter((c) => haystack(c).includes(needle));
  if (detailMatch.length > 0) return detailMatch;
  return pool.filter((c) => c.value.toLowerCase().includes(needle));
}

/** `/effort <effort>`, with `index` marked active. */
export function commandSignature(command: SlashCommand, index = -1): CompletionSignature {
  return {
    command: command.name,
    args: (command.args ?? []).map((argument, position) => ({
      text: argument.required === true ? `<${argument.name}>` : `[${argument.name}]`,
      active: position === index,
    })),
  };
}

/** Flatten a signature for a plain-text context. */
export function signatureText(signature: CompletionSignature): string {
  return [signature.command, ...signature.args.map((a) => a.text)].join(" ");
}

// ---------------------------------------------------------------------------
// Navigation and acceptance
// ---------------------------------------------------------------------------

/**
 * Move the selection by `delta`, wrapping at both ends.
 *
 * Wrapping is what makes `Tab` a cycle rather than a dead end: a user pressing it
 * repeatedly to survey the list should come back around, not stick on the last row.
 */
export function moveCompletion(state: CompletionState, delta: number): CompletionState {
  if (!state.open || state.candidates.length === 0) return state;
  const count = state.candidates.length;
  const selected = (((state.selected + delta) % count) + count) % count;
  return { ...state, selected };
}

export function selectedCandidate(state: CompletionState): CompletionCandidate | undefined {
  return state.open ? state.candidates[state.selected] : undefined;
}

/**
 * Accept the selected candidate.
 *
 * Returns the new composer text and cursor, plus the *recomputed* popup state, so
 * accepting a command that takes arguments opens the argument list in the same
 * keystroke. When `sources` is omitted the popup closes instead, which is the right
 * behaviour for a caller that only wanted the text.
 */
export function acceptCompletion(
  state: CompletionState,
  text: string,
  cursor: number,
  sources?: CompletionSources,
): { text: string; cursor: number; state: CompletionState } {
  const candidate = selectedCandidate(state);
  if (candidate === undefined) return { text, cursor, state: CLOSED_COMPLETION };

  const insertion = candidate.insert ?? candidate.value;
  // Completion insertions commonly commit a token with one trailing space. If the
  // replaced token already has a space to its right (for example when editing it in
  // the middle of a sentence), consume that one separator rather than doubling it.
  const suffixFrom = insertion.endsWith(" ") && text[state.to] === " "
    ? state.to + 1
    : state.to;
  const next = `${text.slice(0, state.from)}${insertion}${text.slice(suffixFrom)}`;
  const nextCursor = state.from + insertion.length;

  if (sources === undefined) return { text: next, cursor: nextCursor, state: CLOSED_COMPLETION };

  const recomputed = computeCompletions(next, nextCursor, sources);

  // A list whose only remaining entry is the thing just accepted has nothing left
  // to offer, so the popup closes and the next Tab submits the command. Leaving it
  // open would mean accepting `/status` left a one-item popup on screen and the
  // next Tab re-accepted the same value instead of sending the command.
  if (recomputed.open && recomputed.candidates.length === 1) {
    const only = recomputed.candidates[0];
    if (only !== undefined && only.value === insertion.trimEnd()) {
      return {
        text: next,
        cursor: nextCursor,
        state: recomputed.signature !== undefined
          ? { ...recomputed, open: false, candidates: [], selected: 0 }
          : CLOSED_COMPLETION,
      };
    }
  }

  return { text: next, cursor: nextCursor, state: recomputed };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** §6.14: the popup shows at most this many rows before it scrolls. */
export const COMPLETION_MAX_ROWS = 8;

/** The hint row's text, when the width can afford it. */
export const COMPLETION_HINT = "tab/enter select \u00b7 up/down move \u00b7 esc close";
export const COMPLETION_HINT_ASCII = "tab/enter select, up/down move, esc close";

/**
 * Which slice of the candidate list to draw for a viewport.
 *
 * The selection is kept inside the window rather than the window being centred on
 * it, so paging down the list scrolls only when it has to — a list that re-centres
 * on every keypress makes it hard to see where you are.
 */
export function completionWindow(
  count: number,
  selected: number,
  maxRows: number,
): { start: number; end: number } {
  const rows = Math.max(1, Math.min(maxRows, count));
  const start = Math.max(0, Math.min(selected - rows + 1, count - rows));
  const clamped = selected < start ? selected : start;
  return { start: Math.max(0, clamped), end: Math.max(0, clamped) + rows };
}

export interface CompletionPopupOptions {
  readonly maxRows?: number;
  readonly showHint?: boolean;
  /** Optional picker heading, used by the model and reasoning selectors. */
  readonly title?: string;
  /** Optional search text shown under the picker heading. */
  readonly search?: string;
}

/**
 * Render the popup: a signature line, the candidate rows, and a hint.
 *
 * AC-45 governs the selection marker: `▸` (or `>` without Unicode) identifies the
 * active row, so the popup is usable with no colour at all. The `N/M` counter is
 * there for the same reason — with eight rows of a twenty-item list on screen,
 * position cannot be inferred from a scrollbar that a terminal does not have.
 */
export function renderCompletionPopup(
  state: CompletionState,
  context: BlockContext,
  options: CompletionPopupOptions = {},
): StyledLine[] {
  const lines: StyledLine[] = [];

  if (options.title !== undefined && options.title.length > 0) {
    lines.push(
      popupLine(
        [
          segment(options.title, { fg: "fg.primary", bold: true }),
          segment("  esc", { fg: "fg.muted" }),
        ],
        context,
      ),
    );
    if (options.search !== undefined) {
      const search = options.search.length > 0 ? options.search : "Search";
      lines.push(
        popupLine(
          [
            segment(search, {
              fg: options.search.length > 0 ? "fg.primary" : "fg.muted",
              italic: options.search.length === 0,
            }),
          ],
          context,
        ),
      );
    }
  }

  // A titled picker already has its own heading/search chrome; the compact
  // slash signature is kept for the inline command completion surface only.
  if (state.signature !== undefined && options.title === undefined) {
    lines.push(popupLine(signatureSegments(state.signature), context));
  }
  if (!state.open || state.candidates.length === 0) {
    if (lines.length === 0) return lines;
    return borderedPopup(lines, context);
  }

  const maxRows = Math.max(1, options.maxRows ?? COMPLETION_MAX_ROWS);
  const { start, end } = completionWindow(state.candidates.length, state.selected, maxRows);
  // Candidate values may be workspace filenames. Treat them as untrusted display
  // text while leaving the original candidate untouched for acceptance.
  const visible = state.candidates.slice(start, end).map((candidate) => ({
    candidate,
    value: sanitizeInline(candidate.value, 500),
  }));

  const valueWidth = visible.reduce((max, entry) => Math.max(max, stringWidth(entry.value)), 0);
  const marker = context.capabilities.unicode ? "▸ " : "> ";

  visible.forEach(({ candidate, value }, offset) => {
    const index = start + offset;
    const active = index === state.selected;
    const detailRoom = context.columns - stringWidth(marker) - valueWidth - 2;
    const background = active ? "bg.task" : "bg.panel";

    lines.push(
      popupLine(
        [
          segment(active ? marker : "  ", {
            fg: active ? "accent.cyan" : "accent.coral",
            bg: background,
          }),
          segment(
            padToWidth(value, valueWidth),
            active
              ? { fg: "fg.primary", bg: background, bold: true }
              : { fg: "fg.primary", bg: background },
          ),
          ...(candidate.detail !== undefined && detailRoom > 8
            ? [
                segment(
                  `  ${truncateToWidth(sanitizeInline(candidate.detail, 200), detailRoom)}`,
                  { fg: active ? "fg.muted" : "fg.muted", bg: background },
                ),
              ]
            : []),
        ],
        context,
        background,
      ),
    );
  });

  if (state.signature !== undefined && options.title === undefined && lines.length > 1) {
    const sigIndex = lines.findIndex((l) => l.segments.some((s) => s.text.includes("/")));
    if (sigIndex >= 0) {
      const divider = popupLine(
        [segment("─".repeat(Math.max(1, context.columns)), { fg: "border.warm", dim: true })],
        context,
      );
      lines.splice(sigIndex + 1, 0, divider);
    }
  }

  const footer: Segment[] = [
    segment("  ", {}),
    segment(`${state.selected + 1}/${state.candidates.length}`, { fg: "fg.muted" }),
  ];
  if (options.showHint !== false) {
    const hint = context.capabilities.unicode ? COMPLETION_HINT : COMPLETION_HINT_ASCII;
    const used = 2 + stringWidth(`${state.selected + 1}/${state.candidates.length}`);
    if (context.columns - used - 3 >= stringWidth(hint)) {
      footer.push(segment(` \u00b7 ${hint}`, { fg: "fg.muted", italic: true }));
    }
  }
  const hintLine = popupLine(footer, context);
  const separator = popupLine(
    [segment("─".repeat(Math.max(1, context.columns)), { fg: "border.warm", dim: true })],
    context,
  );
  lines.push(separator, hintLine);

  return borderedPopup(lines, context);
}

function borderedPopup(lines: readonly StyledLine[], context: BlockContext): StyledLine[] {
  const glyphs = context.capabilities.unicode
    ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const innerW = Math.max(1, context.columns - 2);
  if (context.columns <= 2) return [...lines];
  const top = line("overlay", [
    segment(glyphs.tl + glyphs.h.repeat(innerW) + glyphs.tr, { fg: "border.warm", bg: "bg.panel" }),
  ]);
  const bottom = line("overlay", [
    segment(glyphs.bl + glyphs.h.repeat(innerW) + glyphs.br, { fg: "border.warm", bg: "bg.panel" }),
  ]);
  const bordered: StyledLine[] = [top];
  for (const l of lines) {
    const innerCtx: BlockContext = { columns: innerW, capabilities: context.capabilities };
    const fitted = fitLine("overlay", l.segments, innerCtx);
    const used = fitted.segments.reduce((sum, s) => sum + stringWidth(s.text), 0);
    const padW = Math.max(0, innerW - used);
    const bg = "bg.panel" as const;
    const tagged = fitted.segments.map((s) => ({ ...s, bg: s.bg ?? bg }));
    bordered.push(
      line("overlay", [
        segment(glyphs.v, { fg: "border.warm", bg }),
        ...tagged,
        segment(" ".repeat(padW), { bg }),
        segment(glyphs.v, { fg: "border.warm", bg }),
      ]),
    );
  }
  bordered.push(bottom);
  return bordered;
}

function signatureSegments(signature: CompletionSignature): Segment[] {
  const segments: Segment[] = [
    segment(signature.command, { fg: "accent.cyan", bold: true }),
  ];
  for (const argument of signature.args) {
    segments.push(segment(" ", {}));
    // The active argument is bold *and* bracketed, so which one is being typed
    // survives with no colour.
    segments.push(
      segment(
        argument.text,
        argument.active ? { fg: "accent.coral", bold: true } : { fg: "fg.muted" },
      ),
    );
  }
  return segments;
}

/**
 * Render bare candidate rows.
 *
 * Kept alongside the popup for callers that supply their own framing — the model
 * and reasoning pickers draw a list without a signature line or a counter.
 */
export function renderCompletions(
  candidates: readonly CompletionCandidate[],
  selected: number,
  context: BlockContext,
): StyledLine[] {
  if (candidates.length === 0) return [];
  const visible = candidates.map((candidate) => ({
    candidate,
    value: sanitizeInline(candidate.value, 500),
  }));
  const width = visible.reduce((max, entry) => Math.max(max, stringWidth(entry.value)), 0);

  return visible.map(({ candidate, value }, index) => {
    const active = index === selected;
    const background = active ? "bg.task" : "bg.panel";
    return popupLine(
      [
        segment(active ? (context.capabilities.unicode ? "▸ " : "> ") : "  ", {
          fg: active ? "accent.cyan" : "accent.coral",
          bg: background,
        }),
        segment(
          padToWidth(value, width),
          active
            ? { fg: "fg.primary", bg: background, bold: true }
            : { fg: "fg.primary", bg: background },
        ),
        ...(candidate.detail !== undefined
          ? [
              segment(`  ${sanitizeInline(candidate.detail, 80)}`, {
                fg: active ? "fg.muted" : "fg.muted",
                bg: background,
              }),
            ]
          : []),
      ],
      context,
      background,
    );
  });
}

/** Paint one popup row without leaking its panel background into the margin. */
function popupLine(
  segments: readonly Segment[],
  context: BlockContext,
  background: "bg.panel" | "bg.task" | "accent.coral" = "bg.panel",
): StyledLine {
  const painted = segments.map((part) => ({ ...part, bg: part.bg ?? background }));
  const fitted = fitLine("overlay", painted, context);
  const used = fitted.segments.reduce((total, part) => total + stringWidth(part.text), 0);
  if (used >= context.columns) return fitted;
  return line("overlay", [
    ...fitted.segments,
    segment(" ".repeat(context.columns - used), { bg: background }),
  ]);
}
