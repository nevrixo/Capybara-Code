/**
 * Small, terminal-safe Markdown renderer used for model-authored text.
 *
 * The TUI deliberately does not depend on a browser Markdown implementation:
 * rendering happens in the semantic layer and must work in the ANSI, plain, and
 * native OpenTUI serializers alike. This is not intended to be a full CommonMark
 * implementation. It covers the constructs that model responses use most often
 * (headings, lists, quotes, rules, fenced code, and inline emphasis) while
 * preserving unknown syntax as readable text.
 */

import {
  MAX_DISPLAY_LINES,
  MAX_LINE_LENGTH,
  sanitizeText,
} from "./sanitize.ts";
import {
  line,
  segment,
  type BlockContext,
  type LineKind,
  type Segment,
  type SegmentStyle,
  type StyledLine,
} from "./segments.ts";
import { treeGlyphs } from "./theme.ts";
import { graphemes, stringWidth, truncateToWidth } from "./width.ts";

export interface MarkdownRenderOptions {
  /** Semantic line kind used by the surrounding block. */
  readonly kind?: LineKind;
  /** Prefix (for example the commentary gutter) repeated on every output row. */
  readonly prefix?: string;
  /** Base style for ordinary Markdown text. */
  readonly style?: SegmentStyle;
  /** Custom theme token color for prefix gutter. */
  readonly prefixColor?: import("./theme.ts").ThemeToken;
  /**
   * Renderer/theme discriminator for hosts whose semantic Markdown extension
   * changes without changing the options above. The built-in renderer emits
   * theme tokens, so callers normally leave this unset.
   */
  readonly cacheVariant?: string;
}

export interface MarkdownRenderCacheOptions {
  /** Bound both entry metadata and retained source strings. */
  readonly maxEntries?: number;
  readonly maxSourceCharacters?: number;
}

export interface MarkdownRenderCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly entries: number;
  readonly sourceCharacters: number;
}

interface MarkdownCacheEntry {
  readonly variant: string;
  readonly raw: string;
  readonly lines: StyledLine[];
  readonly sourceCharacters: number;
}

/**
 * Bounded Markdown cache.
 *
 * The first map is keyed only by semantic render inputs (width, capabilities and
 * every Markdown option); the nested map keys the source string. Keeping the raw
 * string out of one giant concatenated key avoids allocating a second copy of a
 * large answer merely to look it up. Entries are LRU-evicted by both count and
 * retained source size.
 */
export class MarkdownRenderCache {
  readonly #maxEntries: number;
  readonly #maxSourceCharacters: number;
  readonly #variants = new Map<string, Map<string, MarkdownCacheEntry>>();
  readonly #lru = new Map<MarkdownCacheEntry, true>();
  #sourceCharacters = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(options: MarkdownRenderCacheOptions = {}) {
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 512));
    this.#maxSourceCharacters = Math.max(
      1,
      Math.floor(options.maxSourceCharacters ?? 4_000_000),
    );
  }

  render(
    raw: string,
    context: BlockContext,
    options: MarkdownRenderOptions,
    render: () => StyledLine[],
  ): StyledLine[] {
    const variant = markdownRenderCacheKey(context, options);
    const bucket = this.#variants.get(variant);
    const cached = bucket?.get(raw);
    if (cached !== undefined) {
      this.#hits += 1;
      this.#lru.delete(cached);
      this.#lru.set(cached, true);
      return cached.lines;
    }

    this.#misses += 1;
    const lines = render();
    const entry: MarkdownCacheEntry = {
      variant,
      raw,
      lines,
      sourceCharacters: raw.length,
    };
    const target = bucket ?? new Map<string, MarkdownCacheEntry>();
    if (bucket === undefined) this.#variants.set(variant, target);
    target.set(raw, entry);
    this.#lru.set(entry, true);
    this.#sourceCharacters += entry.sourceCharacters;
    this.#evict();
    return lines;
  }

  clear(): void {
    this.#variants.clear();
    this.#lru.clear();
    this.#sourceCharacters = 0;
  }

  resetStats(): void {
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }

  get stats(): MarkdownRenderCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      entries: this.#lru.size,
      sourceCharacters: this.#sourceCharacters,
    };
  }

  #evict(): void {
    while (
      this.#lru.size > this.#maxEntries ||
      this.#sourceCharacters > this.#maxSourceCharacters
    ) {
      const oldest = this.#lru.keys().next().value as MarkdownCacheEntry | undefined;
      if (oldest === undefined) break;
      this.#lru.delete(oldest);
      const bucket = this.#variants.get(oldest.variant);
      if (bucket?.get(oldest.raw) === oldest) {
        bucket.delete(oldest.raw);
        if (bucket.size === 0) this.#variants.delete(oldest.variant);
      }
      this.#sourceCharacters -= oldest.sourceCharacters;
      this.#evictions += 1;
    }
  }
}

/** All semantic inputs used by the built-in Markdown renderer. */
export function markdownRenderCacheKey(
  context: BlockContext,
  options: MarkdownRenderOptions = {},
): string {
  const style = options.style;
  return JSON.stringify([
    context.columns,
    context.capabilities.unicode,
    context.capabilities.italic,
    context.capabilities.reducedMotion,
    context.capabilities.stableEmojiWidth ?? null,
    options.kind ?? "body",
    options.prefix ?? "",
    style?.fg ?? null,
    style?.bg ?? null,
    style?.bold ?? false,
    style?.italic ?? false,
    style?.dim ?? false,
    style?.underline ?? false,
    style?.inverse ?? false,
    options.prefixColor ?? "border.warm",
    options.cacheVariant ?? "",
  ]);
}

/** Shared bounded cache used by the normal block renderers. */
export const defaultMarkdownRenderCache = new MarkdownRenderCache();

export interface MarkdownFenceState {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly language: string;
}

type FenceState = MarkdownFenceState;

export interface MarkdownSourceView {
  readonly chunkable: boolean;
  readonly lineCount: number;
  lines(from: number, to: number): string[];
  fenceBefore(index: number): MarkdownFenceState | undefined;
  fullText(): string;
}

interface InlineMatch {
  readonly index: number;
  readonly length: number;
  readonly style: SegmentStyle;
  readonly text: string;
  readonly suffix?: string;
}

const DEFAULT_STYLE: SegmentStyle = { fg: "fg.primary" };

/**
 * Render model-authored Markdown as semantic terminal lines.
 *
 * `sanitizeText` runs before parsing so Markdown cannot smuggle terminal control
 * sequences into a styled segment. Structural markers are replaced, rather than
 * merely coloured, so a response containing ``` never leaves the raw fence on
 * screen.
 */
export function renderMarkdown(
  raw: string,
  context: BlockContext,
  options: MarkdownRenderOptions = {},
  cache: MarkdownRenderCache = defaultMarkdownRenderCache,
): StyledLine[] {
  return cache.render(raw, context, options, () =>
    renderMarkdownUncached(raw, context, options),
  );
}

/** Lightweight source-line/fence index used by row-bounded viewport renders. */
export class MarkdownSourceIndex implements MarkdownSourceView {
  readonly raw: string;
  readonly chunkable: boolean;
  readonly #lineStarts: number[] = [0];
  readonly #rawLineCount: number;
  readonly #logicalLineCount: number;
  readonly #fenceBefore: Array<FenceState | undefined> = [];

  constructor(raw: string) {
    this.raw = raw;
    // Chunk sanitization is equivalent to whole-source sanitization only when no
    // terminal/control sequence can cross the selected boundary. Unsafe sources
    // take the exact full-render fallback below.
    this.chunkable = chunkSafe(raw);

    let rawLines = 1;
    let cursor = 0;
    while (true) {
      const newline = raw.indexOf("\n", cursor);
      if (newline < 0) break;
      rawLines += 1;
      if (this.#lineStarts.length <= MAX_DISPLAY_LINES) {
        this.#lineStarts.push(newline + 1);
      }
      cursor = newline + 1;
    }
    this.#rawLineCount = rawLines;
    this.#logicalLineCount =
      Math.min(rawLines, MAX_DISPLAY_LINES) +
      (rawLines > MAX_DISPLAY_LINES ? 1 : 0);

    let fence: FenceState | undefined;
    for (let lineIndex = 0; lineIndex < this.#logicalLineCount; lineIndex += 1) {
      this.#fenceBefore.push(fence === undefined ? undefined : { ...fence });
      const source = this.lineAt(lineIndex);
      if (fence !== undefined) {
        if (isFenceClose(source, fence)) fence = undefined;
      } else {
        fence = parseFence(source);
      }
    }
  }

  get lineCount(): number {
    return this.#logicalLineCount;
  }

  fullText(): string {
    return this.raw;
  }

  lineAt(index: number): string {
    if (index < 0 || index >= this.#logicalLineCount) return "";
    if (index >= Math.min(this.#rawLineCount, MAX_DISPLAY_LINES)) {
      return `…[${this.#rawLineCount - MAX_DISPLAY_LINES} more line(s) omitted]`;
    }
    const start = this.#lineStarts[index] ?? this.raw.length;
    const next = this.#lineStarts[index + 1];
    const end = next === undefined ? this.raw.length : Math.max(start, next - 1);
    const source = this.raw.slice(start, end);
    return source.length > MAX_LINE_LENGTH
      ? `${source.slice(0, MAX_LINE_LENGTH)} …[line truncated: ${source.length} characters]`
      : source;
  }

  lines(from: number, to: number): string[] {
    const start = Math.max(0, Math.min(Math.floor(from), this.#logicalLineCount));
    const end = Math.max(start, Math.min(Math.floor(to), this.#logicalLineCount));
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) lines.push(this.lineAt(index));
    return lines;
  }

  fenceBefore(index: number): FenceState | undefined {
    const fence = this.#fenceBefore[index];
    return fence === undefined ? undefined : { ...fence };
  }
}

export interface AppendableMarkdownSourceIndexStats {
  readonly appendCalls: number;
  readonly appendedCharacters: number;
  readonly sourceCharactersInspected: number;
  readonly fullTextCalls: number;
}

/**
 * Markdown source index for a single document receiving arbitrary provider chunks.
 *
 * Unlike CompositeMarkdownSourceIndex, append() does not insert a delimiter: a
 * chunk may continue the previous source line or split a fence marker. The index
 * therefore retains only the unfinished line and the fence state at its boundary.
 */
export class AppendableMarkdownSourceIndex implements MarkdownSourceView {
  readonly #chunks: string[] = [];
  readonly #retainedLines: string[] = [""];
  readonly #fenceBefore: Array<FenceState | undefined> = [undefined];
  #pendingParts: string[] = [];
  #pendingLength = 0;
  #pendingDisplay = "";
  #lineCount = 1;
  #fenceAfter: FenceState | undefined;
  #chunkable = true;
  #appendCalls = 0;
  #appendedCharacters = 0;
  #sourceCharactersInspected = 0;
  #fullTextCalls = 0;

  constructor(chunks: readonly string[] = []) {
    for (const chunk of chunks) this.append(chunk);
  }

  get chunkable(): boolean {
    return this.#chunkable;
  }

  get lineCount(): number {
    return (
      Math.min(this.#lineCount, MAX_DISPLAY_LINES) +
      (this.#lineCount > MAX_DISPLAY_LINES ? 1 : 0)
    );
  }

  get stats(): AppendableMarkdownSourceIndexStats {
    return {
      appendCalls: this.#appendCalls,
      appendedCharacters: this.#appendedCharacters,
      sourceCharactersInspected: this.#sourceCharactersInspected,
      fullTextCalls: this.#fullTextCalls,
    };
  }

  append(raw: string): void {
    this.#appendCalls += 1;
    this.#appendedCharacters += raw.length;
    this.#sourceCharactersInspected += raw.length;
    this.#chunks.push(raw);
    this.#chunkable = this.#chunkable && chunkSafe(raw);
    if (raw.length === 0) return;

    let cursor = 0;
    while (true) {
      const newline = raw.indexOf("\n", cursor);
      if (newline < 0) break;
      this.#appendPending(raw.slice(cursor, newline));
      this.#finishPendingLine();
      cursor = newline + 1;
    }
    if (cursor < raw.length) this.#appendPending(raw.slice(cursor));
    this.#refreshPendingLine();
  }

  lineAt(index: number): string {
    if (index < 0 || index >= this.lineCount) return "";
    if (index >= Math.min(this.#lineCount, MAX_DISPLAY_LINES)) {
      return `…[${this.#lineCount - MAX_DISPLAY_LINES} more line(s) omitted]`;
    }
    return this.#retainedLines[index] ?? "";
  }

  lines(from: number, to: number): string[] {
    const start = Math.max(0, Math.min(Math.floor(from), this.lineCount));
    const end = Math.max(start, Math.min(Math.floor(to), this.lineCount));
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) lines.push(this.lineAt(index));
    return lines;
  }

  fenceBefore(index: number): FenceState | undefined {
    const fence = this.#fenceBefore[index] ?? this.#fenceAfter;
    return fence === undefined ? undefined : { ...fence };
  }

  fullText(): string {
    this.#fullTextCalls += 1;
    return this.#chunks.join("");
  }

  #appendPending(value: string): void {
    if (value.length === 0) return;
    this.#pendingParts.push(value);
    this.#pendingLength += value.length;
    if (this.#pendingDisplay.length < MAX_LINE_LENGTH) {
      this.#pendingDisplay += value.slice(0, MAX_LINE_LENGTH - this.#pendingDisplay.length);
    }
  }

  #refreshPendingLine(): void {
    const index = this.#lineCount - 1;
    if (index >= MAX_DISPLAY_LINES) return;
    this.#retainedLines[index] = formatIndexedLine(this.#pendingDisplay, this.#pendingLength);
  }

  #finishPendingLine(): void {
    const raw = this.#pendingParts.join("");
    const index = this.#lineCount - 1;
    if (index < MAX_DISPLAY_LINES) {
      this.#retainedLines[index] = formatIndexedLine(raw);
    }

    if (this.#fenceAfter !== undefined) {
      if (isFenceClose(raw, this.#fenceAfter)) this.#fenceAfter = undefined;
    } else {
      this.#fenceAfter = parseFence(raw);
    }

    this.#lineCount += 1;
    this.#pendingParts = [];
    this.#pendingLength = 0;
    this.#pendingDisplay = "";
    const nextIndex = this.#lineCount - 1;
    if (nextIndex < MAX_DISPLAY_LINES) {
      this.#fenceBefore[nextIndex] =
        this.#fenceAfter === undefined ? undefined : { ...this.#fenceAfter };
      this.#retainedLines[nextIndex] = "";
    }
  }
}

function formatIndexedLine(raw: string, sourceLength = raw.length): string {
  return sourceLength > MAX_LINE_LENGTH
    ? `${raw.slice(0, MAX_LINE_LENGTH)} …[line truncated: ${sourceLength} characters]`
    : raw;
}

/** Incrementally indexed `part + "\n\n" + part` Markdown source. */
export class CompositeMarkdownSourceIndex implements MarkdownSourceView {
  readonly #parts: string[] = [];
  readonly #retainedLines: string[] = [];
  readonly #fenceBefore: Array<FenceState | undefined> = [];
  #rawLineCount = 0;
  #fenceAfterRetained: FenceState | undefined;
  #chunkable = true;

  constructor(parts: readonly string[] = []) {
    if (parts.length === 0) {
      this.#appendFirst("");
      return;
    }
    this.#appendFirst(parts[0] ?? "");
    for (let index = 1; index < parts.length; index += 1) {
      this.append(parts[index] ?? "");
    }
  }

  get chunkable(): boolean {
    return this.#chunkable;
  }

  get lineCount(): number {
    return (
      Math.min(this.#rawLineCount, MAX_DISPLAY_LINES) +
      (this.#rawLineCount > MAX_DISPLAY_LINES ? 1 : 0)
    );
  }

  append(raw: string): void {
    this.#parts.push(raw);
    this.#chunkable = this.#chunkable && chunkSafe(raw);
    const appended = `\n\n${raw}`;
    const firstNewline = appended.indexOf("\n");
    // The delimiter begins with a newline, so the prefix merely terminates the
    // existing last line. Every segment after it is a new logical line.
    let cursor = firstNewline + 1;
    while (true) {
      const newline = appended.indexOf("\n", cursor);
      if (newline < 0) break;
      this.#addLogicalLine(appended.slice(cursor, newline));
      cursor = newline + 1;
    }
    this.#addLogicalLine(appended.slice(cursor));
  }

  lineAt(index: number): string {
    if (index < 0 || index >= this.lineCount) return "";
    if (index >= this.#retainedLines.length) {
      return `…[${this.#rawLineCount - MAX_DISPLAY_LINES} more line(s) omitted]`;
    }
    return this.#retainedLines[index] ?? "";
  }

  lines(from: number, to: number): string[] {
    const start = Math.max(0, Math.min(Math.floor(from), this.lineCount));
    const end = Math.max(start, Math.min(Math.floor(to), this.lineCount));
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) lines.push(this.lineAt(index));
    return lines;
  }

  fenceBefore(index: number): FenceState | undefined {
    const fence =
      index < this.#fenceBefore.length
        ? this.#fenceBefore[index]
        : this.#fenceAfterRetained;
    return fence === undefined ? undefined : { ...fence };
  }

  fullText(): string {
    return this.#parts.join("\n\n");
  }

  #appendFirst(raw: string): void {
    this.#parts.push(raw);
    this.#chunkable = chunkSafe(raw);
    let cursor = 0;
    while (true) {
      const newline = raw.indexOf("\n", cursor);
      if (newline < 0) break;
      this.#addLogicalLine(raw.slice(cursor, newline));
      cursor = newline + 1;
    }
    this.#addLogicalLine(raw.slice(cursor));
  }

  #addLogicalLine(rawLine: string): void {
    this.#rawLineCount += 1;
    if (this.#retainedLines.length >= MAX_DISPLAY_LINES) return;
    const source = rawLine.length > MAX_LINE_LENGTH
      ? `${rawLine.slice(0, MAX_LINE_LENGTH)} …[line truncated: ${rawLine.length} characters]`
      : rawLine;
    const before = this.#fenceAfterRetained;
    this.#fenceBefore.push(before === undefined ? undefined : { ...before });
    this.#retainedLines.push(source);
    if (before !== undefined) {
      if (isFenceClose(source, before)) this.#fenceAfterRetained = undefined;
    } else {
      this.#fenceAfterRetained = parseFence(source);
    }
  }
}

export function createCompositeMarkdownSourceIndex(
  parts: readonly string[],
): CompositeMarkdownSourceIndex {
  return new CompositeMarkdownSourceIndex(parts);
}

function chunkSafe(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\r\u001B\u0080-\u009F\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/u.test(raw);
}

export interface MarkdownTailRender {
  readonly lines: StyledLine[];
  /** Present when the requested source range reached the first Markdown line. */
  readonly totalLines?: number;
  /** Deterministic work metric; never grows with older source for chunkable text. */
  readonly sourceLinesRendered: number;
  readonly bounded: boolean;
}

export function createMarkdownSourceIndex(raw: string): MarkdownSourceIndex {
  return new MarkdownSourceIndex(raw);
}

export function createAppendableMarkdownSourceIndex(
  chunks: readonly string[] = [],
): AppendableMarkdownSourceIndex {
  return new AppendableMarkdownSourceIndex(chunks);
}

/**
 * Render only the semantic row suffix needed by a viewport.
 *
 * Every retained Markdown source line emits at least one StyledLine. Selecting at
 * most `maxRows` source lines from the sanitized/capped tail is therefore enough
 * to produce the exact final `maxRows` rows, even when one source line wraps to
 * many terminal rows. Fence state at the source boundary comes from the lightweight
 * index, so a viewport beginning in the middle of a code block remains exact.
 */
export function renderMarkdownTail(
  raw: string,
  index: MarkdownSourceIndex,
  context: BlockContext,
  options: MarkdownRenderOptions = {},
  maxRows = 1,
): MarkdownTailRender {
  if (index.raw !== raw) {
    const rows = Math.max(1, Math.floor(maxRows));
    const full = renderMarkdown(raw, context, options);
    return {
      lines: full.slice(Math.max(0, full.length - rows)),
      totalLines: full.length,
      sourceLinesRendered: index.lineCount,
      bounded: false,
    };
  }
  return renderMarkdownSourceTail(index, context, options, maxRows);
}

export function renderMarkdownSourceTail(
  index: MarkdownSourceView,
  context: BlockContext,
  options: MarkdownRenderOptions = {},
  maxRows = 1,
): MarkdownTailRender {
  const rows = Math.max(1, Math.floor(maxRows));
  if (!index.chunkable) {
    const full = renderMarkdown(index.fullText(), context, options);
    return {
      lines: full.slice(Math.max(0, full.length - rows)),
      totalLines: full.length,
      sourceLinesRendered: index.lineCount,
      bounded: false,
    };
  }

  const end = index.lineCount;
  const start = Math.max(0, end - rows);
  const rendered = renderMarkdownLines(
    index.lines(start, end),
    context,
    options,
    index.fenceBefore(start),
  );
  return {
    lines: rendered.slice(Math.max(0, rendered.length - rows)),
    ...(start === 0 ? { totalLines: rendered.length } : {}),
    sourceLinesRendered: end - start,
    bounded: true,
  };
}

function renderMarkdownUncached(
  raw: string,
  context: BlockContext,
  options: MarkdownRenderOptions,
): StyledLine[] {
  return renderMarkdownLines(sanitizeText(raw).split("\n"), context, options);
}

function renderMarkdownLines(
  sourceLines: readonly string[],
  context: BlockContext,
  options: MarkdownRenderOptions,
  initialFence?: FenceState,
): StyledLine[] {
  const kind = options.kind ?? "body";
  const prefix = options.prefix ?? "";
  const prefixColor = options.prefixColor ?? "border.warm";
  const style = { ...DEFAULT_STYLE, ...(options.style ?? {}) };
  const glyphs = treeGlyphs(context.capabilities);
  const rendered: StyledLine[] = [];
  let fence = initialFence === undefined ? undefined : { ...initialFence };

  for (const source of sourceLines) {
    const fenceMarker = parseFence(source);

    if (fence !== undefined) {
      if (isFenceClose(source, fence)) {
        rendered.push(
          fitMarkdownLine(
            kind,
            [
              segment(prefix, { fg: "border.warm" }),
              segment(codeBottom(glyphs), { fg: "border.warm", dim: true }),
            ],
            context,
          ),
        );
        fence = undefined;
        continue;
      }

      rendered.push(
        fitMarkdownLine(
          kind,
          [
            segment(prefix, { fg: "border.warm" }),
            segment(`${glyphs.vertical} `, { fg: "border.warm" }),
            segment(truncateToWidth(source, codeRoom(context, prefix, glyphs.vertical)), {
              fg: "fg.primary",
              bg: "bg.panel",
            }),
          ],
          context,
        ),
      );
      continue;
    }

    if (fenceMarker !== undefined) {
      fence = fenceMarker;
      const language = fenceMarker.language.length > 0 ? ` ${fenceMarker.language}` : " code";
      rendered.push(
        fitMarkdownLine(
          kind,
          [
            segment(prefix, { fg: "border.warm" }),
            segment(codeTop(glyphs), { fg: "border.warm", dim: true }),
            segment(language, { fg: "accent.cyan", bold: true }),
          ],
          context,
        ),
      );
      continue;
    }

    const heading = parseHeading(source);
    if (heading !== undefined) {
      const headingStyle: SegmentStyle = { ...style, fg: "accent.coral", bold: true };
      pushWrapped(
        rendered,
        kind,
        [segment(prefix, { fg: "border.warm" })],
        parseInline(heading.text, headingStyle),
        context,
        headingStyle,
      );
      continue;
    }

    if (isHorizontalRule(source)) {
      const room = Math.max(1, context.columns - stringWidth(prefix));
      rendered.push(
        line(kind, [
          segment(prefix, { fg: "border.warm" }),
          segment(glyphs.horizontal.repeat(room), { fg: "border.warm", dim: true }),
        ]),
      );
      continue;
    }

    const unordered = parseUnorderedList(source);
    if (unordered !== undefined) {
      const marker = context.capabilities.unicode ? "• " : "- ";
      const indent = " ".repeat(unordered.indent);
      const firstPrefix = `${prefix}${indent}${marker}`;
      const continuationPrefix = `${prefix}${indent}${" ".repeat(marker.length)}`;
      pushWrapped(
        rendered,
        kind,
        [segment(firstPrefix, { fg: "accent.cyan", bold: true })],
        parseInline(unordered.text, style),
        context,
        style,
        continuationPrefix,
      );
      continue;
    }

    const ordered = parseOrderedList(source);
    if (ordered !== undefined) {
      const marker = `${ordered.number}. `;
      const indent = " ".repeat(ordered.indent);
      const firstPrefix = `${prefix}${indent}${marker}`;
      const continuationPrefix = `${prefix}${indent}${" ".repeat(marker.length)}`;
      pushWrapped(
        rendered,
        kind,
        [segment(firstPrefix, { fg: "accent.cyan", bold: true })],
        parseInline(ordered.text, style),
        context,
        style,
        continuationPrefix,
      );
      continue;
    }

    const quote = parseQuote(source);
    if (quote !== undefined) {
      const quotePrefix = `${prefix}${" ".repeat(quote.indent)}${glyphs.vertical} `;
      pushWrapped(
        rendered,
        kind,
        [segment(quotePrefix, { fg: "border.warm" })],
        parseInline(quote.text, { ...style, italic: true, fg: "fg.muted" }),
        context,
        { ...style, italic: true, fg: "fg.muted" },
        `${prefix}${" ".repeat(quote.indent)}${glyphs.vertical} `,
      );
      continue;
    }

    if (source.trim().length === 0) {
      rendered.push(line(kind, prefix.length > 0 ? [segment(prefix, { fg: prefixColor })] : []));
      continue;
    }

    pushWrapped(
      rendered,
      kind,
      prefix.length > 0 ? [segment(prefix, { fg: prefixColor })] : [],
      parseInline(source, style),
      context,
      style,
      prefix,
    );
  }

  return rendered;
}

function parseFence(source: string): FenceState | undefined {
  const match = /^\s*(`{3,}|~{3,})(?:\s*([^\s]+))?\s*$/.exec(source);
  if (match === null) return undefined;
  const marker = match[1] as string;
  return {
    marker: marker[0] === "~" ? "~" : "`",
    length: marker.length,
    language: (match[2] ?? "").slice(0, 32),
  };
}

function isFenceClose(source: string, fence: FenceState): boolean {
  const escaped = fence.marker === "`" ? "`" : "~";
  const expression = new RegExp(`^\\s*${escaped}{${fence.length},}\\s*$`);
  return expression.test(source);
}

function parseHeading(source: string): { level: number; text: string } | undefined {
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(source);
  if (match === null) return undefined;
  return { level: match[1]?.length ?? 1, text: match[2] ?? "" };
}

function parseUnorderedList(source: string): { indent: number; text: string } | undefined {
  const match = /^(\s{0,12})[-+*]\s+(.+)$/.exec(source);
  if (match === null) return undefined;
  return { indent: Math.min(12, match[1]?.length ?? 0), text: match[2] ?? "" };
}

function parseOrderedList(source: string): { indent: number; number: string; text: string } | undefined {
  const match = /^(\s{0,12})(\d{1,3})[.)]\s+(.+)$/.exec(source);
  if (match === null) return undefined;
  return {
    indent: Math.min(12, match[1]?.length ?? 0),
    number: match[2] ?? "1",
    text: match[3] ?? "",
  };
}

function parseQuote(source: string): { indent: number; text: string } | undefined {
  const match = /^(\s{0,12})>\s?(.*)$/.exec(source);
  if (match === null) return undefined;
  return { indent: Math.min(12, match[1]?.length ?? 0), text: match[2] ?? "" };
}

function isHorizontalRule(source: string): boolean {
  const trimmed = source.trim();
  return /^(?:\*\s*){3,}$/.test(trimmed) || /^(?:-\s*){3,}$/.test(trimmed) || /^(?:_\s*){3,}$/.test(trimmed);
}

function codeTop(glyphs: ReturnType<typeof treeGlyphs>): string {
  return glyphs.vertical === "|" ? "+--" : "┌──";
}

function codeBottom(glyphs: ReturnType<typeof treeGlyphs>): string {
  return glyphs.vertical === "|" ? "`--" : "└──";
}

function codeRoom(context: BlockContext, prefix: string, vertical: string): number {
  return Math.max(1, context.columns - stringWidth(prefix) - stringWidth(vertical) - 1);
}

function fitMarkdownLine(kind: LineKind, segments: readonly Segment[], context: BlockContext): StyledLine {
  const total = segments.reduce((sum, current) => sum + stringWidth(current.text), 0);
  if (total <= context.columns) return line(kind, segments);

  const out: Segment[] = [];
  let remaining = context.columns;
  for (const current of segments) {
    if (remaining <= 0) break;
    const width = stringWidth(current.text);
    if (width <= remaining) {
      out.push(current);
      remaining -= width;
    } else {
      out.push({ ...current, text: truncateToWidth(current.text, remaining) });
      break;
    }
  }
  return line(kind, out);
}

function pushWrapped(
  target: StyledLine[],
  kind: LineKind,
  firstPrefix: readonly Segment[],
  content: readonly Segment[],
  context: BlockContext,
  _contentStyle: SegmentStyle,
  continuationPrefix?: string,
): void {
  const firstWidth = firstPrefix.reduce((sum, current) => sum + stringWidth(current.text), 0);
  const continuation = continuationPrefix ?? firstPrefix.map((current) => current.text).join("");
  const continuationWidth = stringWidth(continuation);
  const available = Math.max(1, context.columns - firstWidth);
  const wrapped = wrapSegments(content, available);

  if (wrapped.length === 0) {
    target.push(line(kind, firstPrefix));
    return;
  }

  for (const [index, row] of wrapped.entries()) {
    const continuationStyle = firstPrefix[0] === undefined ? {} : { ...styleOf(firstPrefix[0]), bold: false };
    const prefix = index === 0 ? firstPrefix : [segment(continuation, continuationStyle)];
    const room = Math.max(1, context.columns - (index === 0 ? firstWidth : continuationWidth));
    target.push(fitMarkdownLine(kind, [...prefix, ...trimSegmentsToWidth(row, room)], context));
  }
}

function wrapSegments(segments: readonly Segment[], width: number): Segment[][] {
  const lines: Segment[][] = [[]];
  let used = 0;

  const append = (text: string, style: SegmentStyle): void => {
    if (text.length === 0) return;
    const previous = lines[lines.length - 1]?.[lines[lines.length - 1]!.length - 1];
    if (previous !== undefined && sameStyle(previous, style)) {
      const currentLine = lines[lines.length - 1] as Segment[];
      currentLine[currentLine.length - 1] = { ...previous, text: previous.text + text };
    } else {
      (lines[lines.length - 1] as Segment[]).push(segment(text, style));
    }
  };

  const finish = (): void => {
    const current = lines[lines.length - 1] as Segment[];
    while (current.length > 0 && /^\s+$/.test(current[current.length - 1]?.text ?? "")) current.pop();
    used = 0;
    if (current.length > 0) lines.push([]);
  };

  for (const current of segments) {
    for (const cluster of graphemes(current.text)) {
      if (cluster === "\n") {
        finish();
        lines.push([]);
        continue;
      }
      const clusterWidth = stringWidth(cluster);
      const whitespace = /^\s+$/.test(cluster);
      if (used > 0 && used + clusterWidth > width) {
        finish();
        if (whitespace) continue;
      }
      append(cluster, styleOf(current));
      used += clusterWidth;
    }
  }

  const last = lines[lines.length - 1] as Segment[];
  while (last.length > 0 && /^\s+$/.test(last[last.length - 1]?.text ?? "")) last.pop();
  while (lines.length > 1 && (lines[lines.length - 1] as Segment[]).length === 0) lines.pop();
  return lines;
}

function trimSegmentsToWidth(segments: readonly Segment[], width: number): Segment[] {
  let remaining = width;
  const out: Segment[] = [];
  for (const current of segments) {
    if (remaining <= 0) break;
    const currentWidth = stringWidth(current.text);
    if (currentWidth <= remaining) {
      out.push(current);
      remaining -= currentWidth;
    } else {
      out.push({ ...current, text: truncateToWidth(current.text, remaining) });
      break;
    }
  }
  return out;
}

function styleOf(value: Segment): SegmentStyle {
  return {
    ...(value.fg !== undefined ? { fg: value.fg } : {}),
    ...(value.bg !== undefined ? { bg: value.bg } : {}),
    ...(value.bold !== undefined ? { bold: value.bold } : {}),
    ...(value.italic !== undefined ? { italic: value.italic } : {}),
    ...(value.dim !== undefined ? { dim: value.dim } : {}),
    ...(value.underline !== undefined ? { underline: value.underline } : {}),
  };
}
function sameStyle(segmentValue: Segment, style: SegmentStyle): boolean {
  return (
    segmentValue.fg === style.fg &&
    segmentValue.bg === style.bg &&
    segmentValue.bold === style.bold &&
    segmentValue.italic === style.italic &&
    segmentValue.dim === style.dim &&
    segmentValue.underline === style.underline
  );
}

/** Parse the inline subset without allowing control sequences or raw fence text. */
export function parseInline(text: string, baseStyle: SegmentStyle = DEFAULT_STYLE): Segment[] {
  const out: Segment[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = nextInlineMatch(rest, baseStyle);
    if (match === undefined) {
      const plain = unescapeMarkdown(rest);
      if (plain.length > 0) out.push(segment(plain, baseStyle));
      break;
    }
    const before = unescapeMarkdown(rest.slice(0, match.index));
    if (before.length > 0) out.push(segment(before, baseStyle));
    out.push(segment(unescapeMarkdown(match.text), match.style));
    if (match.suffix !== undefined) out.push(segment(match.suffix, { fg: "fg.muted" }));
    rest = rest.slice(match.index + match.length);
  }

  return mergeAdjacentSegments(out);
}

function nextInlineMatch(rest: string, baseStyle: SegmentStyle): InlineMatch | undefined {
  const candidates: InlineMatch[] = [];

  const code = /(`{1,})(.+?)\1/.exec(rest);
  if (code !== null && code[1] !== undefined && code[2] !== undefined) {
    candidates.push({
      index: code.index,
      length: code[0].length,
      text: code[2].trim(),
      style: { ...baseStyle, fg: "accent.cyan", bg: "bg.panel", italic: false },
    });
  }

  const link = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
  if (link !== null && link[1] !== undefined && link[2] !== undefined) {
    candidates.push({
      index: link.index,
      length: link[0].length,
      text: link[1],
      style: { ...baseStyle, fg: "accent.cyan", underline: true },
      suffix: ` (${link[2]})`,
    });
  }

  const strong = /(?:\*\*|__)(\S(?:.*?\S)?)(?:\*\*|__)/.exec(rest);
  if (strong !== null && strong[1] !== undefined) {
    candidates.push({
      index: strong.index,
      length: strong[0].length,
      text: strong[1],
      style: { ...baseStyle, bold: true },
    });
  }

  const strike = /~~(\S(?:.*?\S)?)~~/.exec(rest);
  if (strike !== null && strike[1] !== undefined) {
    candidates.push({
      index: strike.index,
      length: strike[0].length,
      text: strike[1],
      style: { ...baseStyle, dim: true },
    });
  }

  const emphasis = /(?:\*|_)(\S(?:.*?\S)?)(?:\*|_)/.exec(rest);
  if (emphasis !== null && emphasis[1] !== undefined) {
    candidates.push({
      index: emphasis.index,
      length: emphasis[0].length,
      text: emphasis[1],
      style: { ...baseStyle, italic: true },
    });
  }

  candidates.sort((left, right) => left.index - right.index || right.length - left.length);
  return candidates[0];
}

function mergeAdjacentSegments(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const current of segments) {
    const previous = out[out.length - 1];
    if (previous !== undefined && sameStyle(previous, current)) {
      out[out.length - 1] = { ...previous, text: previous.text + current.text };
    } else {
      out.push(current);
    }
  }
  return out;
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_[\]~#+.!>\-])/g, "$1");
}
