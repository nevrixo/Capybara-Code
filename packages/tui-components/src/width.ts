/**
 * Terminal width measurement — PRD §6.6, AC-05, §25.8.
 *
 * §6.6: Unicode width follows grapheme clusters and East Asian Width.
 *
 * Both halves matter for a real reason. AC-05 requires Korean input to survive
 * cursor movement, wrapping, deletion, and resize; Hangul syllables occupy two
 * columns, so measuring by `String.length` would misplace the cursor on every
 * line. And a grapheme cluster — a base character plus its combining marks, or an
 * emoji ZWJ sequence — is one *editable unit*: splitting it would corrupt the text
 * a user is typing.
 */

/**
 * East Asian Wide and Fullwidth ranges.
 *
 * Derived from Unicode's `EastAsianWidth` property, restricted to `W` and `F`.
 * Kept as an explicit table rather than a regex so it can be audited against the
 * standard and extended without changing the algorithm.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1b000, 0x1b001], // Kana supplement
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // playing card black joker
  [0x1f18e, 0x1f18e], // negative squared AB
  [0x1f191, 0x1f19a], // squared CL..VS
  [0x1f200, 0x1f320], // enclosed ideographic supplement, misc symbols
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK extension B and beyond
  [0x30000, 0x3fffd],
];

/** Zero-width: combining marks, variation selectors, and format controls. */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0900, 0x0903],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xfeff, 0xfeff], // BOM
  [0x1f3fb, 0x1f3ff], // emoji skin-tone modifiers
  [0xe0100, 0xe01ef], // variation selectors supplement
];

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid] as readonly [number, number];
    if (code < range[0]) high = mid - 1;
    else if (code > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ readonly segment: string }>;
}

type GraphemeSegmenterConstructor = new (
  locale?: string,
  options?: { readonly granularity: "grapheme" },
) => GraphemeSegmenter;

/**
 * Segmenter construction is surprisingly expensive for short labels. Keep one
 * process-wide instance and retain the small fallback for runtimes without Intl.
 */
const GRAPHEME_SEGMENTER: GraphemeSegmenter | undefined = (() => {
  const constructor = (
    globalThis as typeof globalThis & {
      Intl?: { Segmenter?: GraphemeSegmenterConstructor };
    }
  ).Intl?.Segmenter;
  return constructor === undefined
    ? undefined
    : new constructor(undefined, { granularity: "grapheme" });
})();

let graphemeArrayAllocations = 0;

export interface WidthDiagnostics {
  readonly graphemeArrayAllocations: number;
  readonly segmenterAvailable: boolean;
}

/** Counters are intentionally opt-in diagnostics, not part of the render path. */
export function widthDiagnostics(): WidthDiagnostics {
  return {
    graphemeArrayAllocations,
    segmenterAvailable: GRAPHEME_SEGMENTER !== undefined,
  };
}

export function resetWidthDiagnostics(): void {
  graphemeArrayAllocations = 0;
}

function isPrintableAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** Visit grapheme clusters without materializing an array. */
export function forEachGrapheme(
  text: string,
  visit: (cluster: string) => void,
): void {
  if (GRAPHEME_SEGMENTER !== undefined) {
    for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) visit(segment);
    return;
  }

  let current = "";
  let regionalIndicators = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isMark = inRanges(code, ZERO_WIDTH_RANGES);
    const isSkinTone = code >= 0x1f3fb && code <= 0x1f3ff;
    const isRegionalIndicator = code >= 0x1f1e6 && code <= 0x1f1ff;
    const joinsPrevious =
      current.length > 0 &&
      (isMark || isSkinTone || endsWithZwj(current) ||
        (isRegionalIndicator && regionalIndicators % 2 === 1));
    if (joinsPrevious) {
      current += char;
      if (isRegionalIndicator) regionalIndicators += 1;
      continue;
    }
    if (current.length > 0) visit(current);
    current = char;
    regionalIndicators = isRegionalIndicator ? 1 : 0;
  }
  if (current.length > 0) visit(current);
}

/** Column width of one code point: 0, 1, or 2. */
export function codePointWidth(code: number): number {
  // C0 and DEL occupy no columns; they should have been stripped already.
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Split a string into grapheme clusters.
 *
 * Uses `Intl.Segmenter` when the runtime has it — it implements UAX #29 properly,
 * including emoji ZWJ sequences and regional indicator pairs. The fallback handles
 * the cases that actually matter for a terminal: surrogate pairs, combining marks,
 * variation selectors, and ZWJ joins.
 */
export function graphemes(text: string): string[] {
  graphemeArrayAllocations += 1;
  const out: string[] = [];
  forEachGrapheme(text, (cluster) => out.push(cluster));
  return out;
}

function endsWithZwj(text: string): boolean {
  return text.endsWith("\u200D");
}

/** Display width of one grapheme cluster. */
export function graphemeWidth(cluster: string): number {
  let width = 0;
  for (const char of cluster) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  // A cluster with only combining marks still occupies the base cell.
  if (width === 0 && cluster.length > 0) return 0;
  // An emoji ZWJ sequence renders as one wide glyph, not the sum of its parts.
  if (cluster.includes("\u200D")) return 2;
  return width;
}

/** Display width of a string in terminal columns. */
export function stringWidth(text: string): number {
  if (isPrintableAscii(text)) return text.length;
  return scanTextWidth(text);
}

/** Display width without allocating the grapheme array used by editor APIs. */
export function scanTextWidth(text: string): number {
  if (isPrintableAscii(text)) return text.length;
  let width = 0;
  forEachGrapheme(text, (cluster) => {
    width += graphemeWidth(cluster);
  });
  return width;
}

export interface MeasureAndTruncateResult {
  /** Display width of the returned text, not the discarded source suffix. */
  readonly width: number;
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Measure and truncate in one source scan. The retained prefix is collected only
 * after the source is known to overflow, so ordinary labels allocate no cluster
 * array and streaming text is never cached by this helper.
 */
export function measureAndTruncate(
  text: string,
  columns: number,
  ellipsis = "…",
): MeasureAndTruncateResult {
  const limit = Math.max(0, Math.floor(columns));
  if (limit === 0) {
    return { width: 0, text: "", truncated: text.length > 0 };
  }

  const ellipsisWidth = scanTextWidth(ellipsis);
  const prefixBudget = Math.max(0, limit - ellipsisWidth);
  const prefix: string[] = [];
  let sourceWidth = 0;
  let prefixWidth = 0;
  let truncated = false;

  forEachGrapheme(text, (cluster) => {
    const clusterWidth = graphemeWidth(cluster);
    sourceWidth += clusterWidth;
    if (truncated) return;
    if (prefixWidth + clusterWidth <= prefixBudget) {
      prefix.push(cluster);
      prefixWidth += clusterWidth;
      return;
    }
    truncated = true;
  });

  if (!truncated) return { width: sourceWidth, text, truncated: false };

  // A caller may provide an ellipsis wider than the available terminal. Keep the
  // result inside the requested width rather than reintroducing an overflow bug.
  const fittedEllipsis = takeWithinWidth(ellipsis, limit);
  const fittedEllipsisWidth = scanTextWidth(fittedEllipsis);
  const result = `${prefix.join("")}${fittedEllipsis}`;
  return {
    width: Math.min(limit, prefixWidth + fittedEllipsisWidth),
    text: result,
    truncated: true,
  };
}

function takeWithinWidth(text: string, columns: number): string {
  if (columns <= 0) return "";
  let width = 0;
  let result = "";
  forEachGrapheme(text, (cluster) => {
    if (width + graphemeWidth(cluster) > columns) return;
    result += cluster;
    width += graphemeWidth(cluster);
  });
  return result;
}

/**
 * Truncate to `columns`, appending `ellipsis` when anything was dropped.
 *
 * Never splits a grapheme cluster, and never leaves a half-drawn wide character —
 * either would show as a replacement glyph and shift every following column.
 */
export function truncateToWidth(text: string, columns: number, ellipsis = "…"): string {
  return measureAndTruncate(text, columns, ellipsis).text;
}

/**
 * Truncate long identifiers with a middle ellipsis: `ses_20260806…8bb3`.
 *
 * Keeps the leading prefix (recognizable) and trailing suffix (unique)
 * rather than dropping only the tail, so a long session id remains identifiable
 * without breaking the sidebar border.
 */
export function truncateMiddle(text: string, columns: number, ellipsis = "…"): string {
  if (columns <= 0) return "";
  if (stringWidth(text) <= columns) return text;
  const ellipsisWidth = stringWidth(ellipsis);
  const budget = Math.max(0, columns - ellipsisWidth);
  if (budget <= 1) return truncateToWidth(text, columns, ellipsis);
  const clusters = graphemes(text);
  const keepEnd = Math.max(1, Math.floor(budget * 0.28));
  const start: string[] = [];
  const end: string[] = [];
  let startWidth = 0;
  let endWidth = 0;
  const endClusters = clusters.slice(-keepEnd);
  for (const c of endClusters) endWidth += graphemeWidth(c);
  const startBudget = budget - endWidth;
  for (const c of clusters) {
    const w = graphemeWidth(c);
    if (startWidth + w > startBudget) break;
    if (start.length + endClusters.length >= clusters.length) break;
    start.push(c);
    startWidth += w;
  }
  if (start.length === 0) return truncateToWidth(text, columns, ellipsis);
  return `${start.join("")}${ellipsis}${endClusters.join("")}`;
}

/** Pad on the right to `columns`, measured in display width. */
export function padToWidth(text: string, columns: number, filler = " "): string {
  const width = stringWidth(text);
  if (width >= columns) return text;
  return text + filler.repeat(columns - width);
}

/** Pad on the left to `columns`. */
export function padStartToWidth(text: string, columns: number, filler = " "): string {
  const width = stringWidth(text);
  if (width >= columns) return text;
  return filler.repeat(columns - width) + text;
}

/**
 * Wrap to `columns`, preferring word boundaries.
 *
 * A word longer than the line is broken by grapheme cluster rather than dropped,
 * because a long path or hash is usually the most important thing on the line.
 */
export function wrapToWidth(text: string, columns: number): string[] {
  if (columns <= 0) return [text];

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;

    for (const word of paragraph.split(/(\s+)/)) {
      if (word.length === 0) continue;
      const wordWidth = stringWidth(word);

      if (lineWidth + wordWidth <= columns) {
        line += word;
        lineWidth += wordWidth;
        continue;
      }

      // Trailing whitespace at a wrap point is dropped rather than carried over.
      if (/^\s+$/.test(word)) {
        lines.push(line);
        line = "";
        lineWidth = 0;
        continue;
      }

      if (line.length > 0) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }

      if (wordWidth <= columns) {
        line = word;
        lineWidth = wordWidth;
        continue;
      }

      // Hard-break an oversized word, cluster by cluster.
      for (const cluster of graphemes(word)) {
        const clusterWidth = graphemeWidth(cluster);
        if (lineWidth + clusterWidth > columns) {
          lines.push(line);
          line = "";
          lineWidth = 0;
        }
        line += cluster;
        lineWidth += clusterWidth;
      }
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Cursor column for a grapheme offset — what AC-05 needs to place the caret
 * correctly in a line of mixed-width text.
 */
export function columnForOffset(text: string, graphemeOffset: number): number {
  let column = 0;
  let index = 0;
  forEachGrapheme(text, (cluster) => {
    if (index >= graphemeOffset) return;
    column += graphemeWidth(cluster);
    index += 1;
  });
  return column;
}

/** Inverse of `columnForOffset`: the grapheme offset nearest a column. */
export function offsetForColumn(text: string, column: number): number {
  let width = 0;
  let index = 0;
  let result: number | undefined;
  forEachGrapheme(text, (cluster) => {
    if (result !== undefined) return;
    const next = width + graphemeWidth(cluster);
    if (next > column) {
      result = index;
      return;
    }
    width = next;
    index += 1;
  });
  return result ?? index;
}

/** Delete one grapheme cluster before `offset`, as backspace should (AC-05). */
export function deleteGraphemeBefore(
  text: string,
  offset: number,
): { text: string; offset: number } {
  if (offset <= 0) return { text, offset: 0 };
  const clusters = graphemes(text);
  const index = Math.min(offset, clusters.length);
  const kept = [...clusters.slice(0, index - 1), ...clusters.slice(index)];
  return { text: kept.join(""), offset: index - 1 };
}

/**
 * Slice a string by display-column range [startCol, endCol).
 *
 * Single source of truth for pi-tui `sliceByColumn` guarantee: never splits a
 * grapheme cluster and never leaves a half-drawn wide character. A wide glyph
 * that straddles the boundary is excluded rather than cut, so
 * `stringWidth(slice) <= endCol - startCol` always holds.
 */
export function sliceByColumn(text: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return "";
  const start = Math.max(0, startCol);
  const end = Math.max(start, endCol);
  let column = 0;
  let out = "";
  forEachGrapheme(text, (cluster) => {
    const w = graphemeWidth(cluster);
    const next = column + w;
    if (next <= start) {
      column = next;
      return;
    }
    if (column >= end) return;
    if (column >= start && next <= end) out += cluster;
    column = next;
  });
  return out;
}
