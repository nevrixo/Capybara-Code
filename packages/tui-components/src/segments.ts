/**
 * Styled segments — PRD §6.3, §6.6, §20.8, §25.8.
 *
 * §25.8 requires golden tests to verify "semantic cells and rendered ANSI output"
 * — *both*. That is why rendering is two stages: a block renderer produces
 * `StyledLine`s carrying semantic tokens, and a serializer turns those into ANSI or
 * plain text.
 *
 * The split pays for itself three ways. A golden test can assert meaning without
 * matching escape bytes; interactive and line-oriented output reuse the same renderers (§19.3);
 * and the colour-depth fallbacks in §6.5 apply at serialization, so no block
 * renderer needs to know what the terminal supports.
 */

import { icon, type IconName, type Theme, type ThemeToken } from "./theme.ts";
import { stringWidth, truncateToWidth, wrapToWidth } from "./width.ts";

/** §6.6 text attributes. */
export interface SegmentStyle {
  readonly fg?: ThemeToken;
  readonly bg?: ThemeToken;
  readonly bold?: boolean;
  /** §6.6: rendered dim when the terminal cannot do italic. */
  readonly italic?: boolean;
  readonly dim?: boolean;
  readonly underline?: boolean;
  /** Inverse video (SGR 7), used by the mouse-selection overlay. */
  readonly inverse?: boolean;
}

export interface Segment extends SegmentStyle {
  readonly text: string;
}

/**
 * One rendered line.
 *
 * `kind` is the semantic label §25.8's cell assertions match on, so a golden test
 * can say "this is a commentary line" without depending on colour.
 */
export interface StyledLine {
  readonly kind: LineKind;
  readonly segments: readonly Segment[];
  /** Background for the whole row, e.g. §6.5's `bg.user` block. */
  readonly rowBackground?: ThemeToken;
  /** Optional upstream revision; native adapters can skip signature serialization. */
  readonly revision?: number;
}

export type LineKind =
  | "blank"
  | "header"
  | "border"
  | "body"
  | "commentary"
  | "reasoning"
  | "tree"
  | "tool"
  | "task"
  | "approval"
  | "diff"
  | "notice"
  | "final"
  | "status"
  /**
   * §6.21's right context panel. Distinct from `status` because §6.2's ordering
   * assertions key on `kind`: a sidebar row labelled `status` would appear to place
   * the status bar above the live line.
   */
  | "sidebar"
  | "live"
  | "composer"
  | "banner"
  | "overlay";

export function segment(text: string, style: SegmentStyle = {}): Segment {
  return { text, ...style };
}

export function line(
  kind: LineKind,
  segments: readonly Segment[],
  rowBackground?: ThemeToken,
  revision?: number,
): StyledLine {
  return {
    kind,
    segments,
    ...(rowBackground !== undefined ? { rowBackground } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
}

export function blank(): StyledLine {
  return { kind: "blank", segments: [] };
}

/** Plain text of a line, ignoring style. */
export function lineText(styled: StyledLine): string {
  return styled.segments.map((s) => s.text).join("");
}

export function lineWidth(styled: StyledLine): number {
  return stringWidth(lineText(styled));
}

export interface RenderOptions {
  readonly theme: Theme;
  readonly capabilities: {
    readonly unicode: boolean;
    readonly italic: boolean;
  };
  /** Terminal width, for row-background padding. */
  readonly columns?: number;
}

const SGR_RESET = "\u001B[0m";

/**
 * Serialize a line to ANSI.
 *
 * A row background is padded to the full terminal width so §6.5's user and task
 * blocks read as blocks rather than as coloured text — §6.7's "full-width block".
 */
export function toAnsi(styled: StyledLine, options: RenderOptions): string {
  const { theme } = options;

  if (theme.depth === "none") {
    // AC-45: no colour at all, so the text must already carry its meaning.
    return toPlain(styled, options);
  }

  const rowBg = styled.rowBackground !== undefined ? theme.bgCode(styled.rowBackground) : undefined;
  const parts: string[] = [];
  if (rowBg !== undefined) parts.push(`\u001B[${rowBg}m`);

  for (const seg of styled.segments) {
    const codes: string[] = [];
    if (seg.bold === true) codes.push("1");
    // §6.6: fall back to dim where italic will not render.
    if (seg.italic === true) codes.push(options.capabilities.italic ? "3" : "2");
    if (seg.dim === true && seg.italic !== true) codes.push("2");
    if (seg.underline === true) codes.push("4");
    if (seg.inverse === true) codes.push("7");

    const fg = seg.fg !== undefined ? theme.fgCode(seg.fg) : undefined;
    if (fg !== undefined) codes.push(fg);
    const bg = seg.bg !== undefined ? theme.bgCode(seg.bg) : rowBg;
    if (bg !== undefined) codes.push(bg);

    parts.push(codes.length > 0 ? `\u001B[${codes.join(";")}m${seg.text}` : seg.text);
    if (codes.length > 0) {
      // Re-establish the row background so the padding at the end still fills.
      parts.push(rowBg !== undefined ? `${SGR_RESET}\u001B[${rowBg}m` : SGR_RESET);
    }
  }

  if (rowBg !== undefined) {
    const columns = options.columns ?? 0;
    const used = lineWidth(styled);
    if (columns > used) parts.push(" ".repeat(columns - used));
    parts.push(SGR_RESET);
  }

  return parts.join("");
}

/** Serialize to plain text (line mode, `NO_COLOR`, golden cell assertions). */
export function toPlain(styled: StyledLine, _options?: RenderOptions): string {
  return lineText(styled);
}

export function renderAnsi(lines: readonly StyledLine[], options: RenderOptions): string {
  return lines.map((styled) => toAnsi(styled, options)).join("\n");
}

export function renderPlain(lines: readonly StyledLine[]): string {
  return lines.map((styled) => toPlain(styled)).join("\n");
}

/**
 * The semantic cell view §25.8 asserts against.
 *
 * Deliberately excludes colour: a golden test that matched hex values would break
 * on every theme tweak while telling you nothing about whether the *state* is still
 * distinguishable.
 */
export interface SemanticCell {
  readonly kind: LineKind;
  readonly text: string;
  readonly width: number;
  readonly emphasis: Array<"bold" | "italic" | "dim" | "underline" | "inverse">;
  readonly tokens: ThemeToken[];
}

export function toSemanticCells(lines: readonly StyledLine[]): SemanticCell[] {
  return lines.map((styled) => {
    const emphasis = new Set<"bold" | "italic" | "dim" | "underline" | "inverse">();
    const tokens = new Set<ThemeToken>();
    for (const seg of styled.segments) {
      if (seg.bold === true) emphasis.add("bold");
      if (seg.italic === true) emphasis.add("italic");
      if (seg.dim === true) emphasis.add("dim");
      if (seg.underline === true) emphasis.add("underline");
      if (seg.inverse === true) emphasis.add("inverse");
      if (seg.fg !== undefined) tokens.add(seg.fg);
      if (seg.bg !== undefined) tokens.add(seg.bg);
    }
    if (styled.rowBackground !== undefined) tokens.add(styled.rowBackground);
    return {
      kind: styled.kind,
      text: lineText(styled),
      width: lineWidth(styled),
      emphasis: [...emphasis],
      tokens: [...tokens],
    };
  });
}

// ---------------------------------------------------------------------------
// Builders shared by the block renderers
// ---------------------------------------------------------------------------

export interface BlockContext {
  readonly columns: number;
  readonly capabilities: {
    readonly unicode: boolean;
    readonly italic: boolean;
    readonly reducedMotion: boolean;
    /** §6.6: emoji glyphs are only used where their width is two columns. */
    readonly stableEmojiWidth?: boolean;
  };
}

/** An icon segment plus a single space, the prefix every state line uses. */
export function iconPrefix(name: IconName, token: ThemeToken, context: BlockContext): Segment[] {
  return [segment(`${icon(name, context.capabilities)} `, { fg: token })];
}

/**
 * Wrap `text` into body lines at the available width.
 *
 * `indent` is applied to every line including the first, so a wrapped tree branch
 * stays aligned under its connector.
 */
export function bodyLines(
  text: string,
  context: BlockContext,
  options: { indent?: string; style?: SegmentStyle; kind?: LineKind } = {},
): StyledLine[] {
  const indent = options.indent ?? "";
  const width = Math.max(8, context.columns - stringWidth(indent));
  const kind = options.kind ?? "body";
  const style = options.style ?? { fg: "fg.primary" };

  return wrapToWidth(text, width).map((wrapped) =>
    line(kind, [
      ...(indent.length > 0 ? [segment(indent, { fg: "fg.muted" })] : []),
      segment(wrapped, style),
    ]),
  );
}

/** A single line truncated to the available width. */
export function fitLine(
  kind: LineKind,
  segments: readonly Segment[],
  context: BlockContext,
): StyledLine {
  const total = segments.reduce((sum, s) => sum + stringWidth(s.text), 0);
  if (total <= context.columns) return line(kind, segments);

  // Trim from the last segment, which is where the least important detail sits.
  const out: Segment[] = [];
  let remaining = context.columns;
  for (const seg of segments) {
    const width = stringWidth(seg.text);
    if (width <= remaining) {
      out.push(seg);
      remaining -= width;
      continue;
    }
    if (remaining > 0) {
      out.push({ ...seg, text: truncateToWidth(seg.text, remaining) });
      remaining = 0;
    }
    break;
  }
  return line(kind, out);
}
