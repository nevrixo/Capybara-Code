/**
 * Mouse selection model — drag-to-select inside the TUI.
 *
 * The TUI owns its own selection because enabling terminal mouse tracking turns
 * off the host terminal's native text selection. A drag across the timeline is
 * tracked as a 0-based `(row, column)` span and rendered as inverse video; on
 * release the plain text between the anchors is sent to the clipboard via OSC 52
 * (see `clipboard.ts`) and a toast is shown (see `toast.ts`).
 *
 * Coordinates are *frame* coordinates: row/column in the composed `StyledLine[]`
 * that the renderer paints. `SelectionState` therefore carries no terminal bytes
 * and stays testable without a PTY.
 */

import { graphemes, sliceByColumn, stringWidth } from "./width.ts";
import type { StyledLine, Segment } from "./segments.ts";

/**
 * An anchor in frame coordinates. `column` is a cell offset, not a grapheme
 * cluster index; a wide glyph's second cell is a valid anchor and selecting into
 * it extends the span by the cluster's full width.
 */
export interface SelectionAnchor {
  readonly row: number;
  readonly column: number;
}

export interface SelectionState {
  readonly start: SelectionAnchor;
  readonly end: SelectionAnchor;
  /** True while the button is held (drag in progress). */
  readonly active: boolean;
}

/** Normalize a span so `start` is the upper-left anchor and `end` the lower-right. */
export function normalizedSpan(
  selection: SelectionState,
): { start: SelectionAnchor; end: SelectionAnchor } {
  const { start, end } = selection;
  if (start.row < end.row || (start.row === end.row && start.column <= end.column)) {
    return { start, end };
  }
  return { start: end, end: start };
}

/** Whether a row/column cell falls inside the selection. */
export function cellInSelection(
  selection: SelectionState | undefined,
  row: number,
  column: number,
): boolean {
  if (selection === undefined) return false;
  const { start, end } = normalizedSpan(selection);
  if (row < start.row || row > end.row) return false;
  if (row === start.row && column < start.column) return false;
  if (row === end.row && column > end.column) return false;
  return true;
}

/** Whether any cell on `row` falls inside the selection (for whole-row ranges). */
export function rowInSelection(
  selection: SelectionState | undefined,
  row: number,
): boolean {
  if (selection === undefined) return false;
  const { start, end } = normalizedSpan(selection);
  return row >= start.row && row <= end.row;
}

/** Whether the selection spans more than a single cell. */
export function isMultiCell(selection: SelectionState | undefined): boolean {
  if (selection === undefined) return false;
  return (
    selection.start.row !== selection.end.row ||
    selection.start.column !== selection.end.column
  );
}

/**
 * Slice a string by *cell* offsets rather than JS string indices.
 *
 * Selection anchors are terminal columns: a Hangul syllable or an emoji spans
 * two cells, so `text.slice(column)` cuts the wrong thing the moment a wide
 * glyph precedes the anchor. A cluster is included when any of its cells is
 * covered, matching the overlay's painting — what you see selected is exactly
 * what gets copied.
 */
export function sliceByCells(text: string, fromCell: number, toCell: number): string {
  if (toCell === Number.POSITIVE_INFINITY) {
    return sliceByColumn(text, fromCell, Number.MAX_SAFE_INTEGER);
  }
  let out = "";
  let column = 0;
  for (const cluster of graphemes(text)) {
    const width = Math.max(1, stringWidth(cluster));
    const cellEnd = column + width - 1;
    if (cellEnd >= fromCell && column <= toCell) out += cluster;
    column += width;
    if (column > toCell) break;
  }
  return out;
}

/** Extract the plain text covered by the selection from a frame. */
export function extractSelectionText(
  lines: readonly { readonly segments: readonly { readonly text: string }[] }[],
  selection: SelectionState,
): string {
  const { start, end } = normalizedSpan(selection);
  const parts: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const styled = lines[row];
    if (styled === undefined) continue;
    const text = styled.segments.map((s) => s.text).join("");
    const fromCell = row === start.row ? start.column : 0;
    const toCell = row === end.row ? end.column : Number.POSITIVE_INFINITY;
    parts.push(sliceByCells(text, fromCell, toCell));
  }
  return parts.join("\n");
}

/**
 * Apply inverse video to the cells inside the selection.
 *
 * The frame is already painted with the base background; the selection overlay
 * walks each line and marks every covered cell with `inverse: true`, splitting
 * segments at cell boundaries where the selection starts or ends mid-segment.
 * Returns a new frame rather than mutating, so the renderer can compare and the
 * plain path can ignore the overlay entirely.
 */
export function applySelectionOverlay(
  lines: readonly StyledLine[],
  selection: SelectionState | undefined,
): StyledLine[] {
  if (selection === undefined || !isMultiCell(selection)) return [...lines];
  const { start, end } = normalizedSpan(selection);
  return lines.map((styled, row) => {
    if (!rowInSelection(selection, row)) return styled;
    let column = 0;
    const out: Segment[] = [];
    for (const seg of styled.segments) {
      const segStart = column;
      const segEnd = column + stringWidth(seg.text) - 1;
      const overlaps =
        row > start.row && row < end.row
          ? true
          : row === start.row && row === end.row
            ? segEnd >= start.column && segStart <= end.column
            : row === start.row
              ? segEnd >= start.column
              : row === end.row
                ? segStart <= end.column
                : false;
      if (!overlaps) {
        out.push(seg);
        column += stringWidth(seg.text);
        continue;
      }
      // Split the segment into runs of selected/unselected cells.
      const cells = graphemes(seg.text);
      let cellCol = segStart;
      let buffer = "";
      let inSelection = false;
      const flush = (markSelected: boolean): void => {
        if (buffer.length === 0) return;
        if (markSelected) {
          // Paint the selected run with explicit fg/bg swap so it is visible on
          // every terminal. Relying on SGR 7 (inverse) alone leaves a selection
          // invisible where the terminal does not support reverse video or where
          // the segment carries no foreground to swap. Here the selection reads
          // as bright brand-accent background with base-foreground text, which is
          // the same emphasis the completion popup uses for its active row.
          out.push({
            text: buffer,
            fg: "fg.primary",
            bg: "bg.task",
            bold: true,
          });
        } else {
          out.push({ ...seg, text: buffer });
        }
        buffer = "";
      };
      for (const cell of cells) {
        const cellEnd = cellCol + stringWidth(cell) - 1;
        const selected =
          row > start.row && row < end.row
            ? true
            : row === start.row && row === end.row
              ? cellEnd >= start.column && cellCol <= end.column
              : row === start.row
                ? cellEnd >= start.column
                : row === end.row
                  ? cellCol <= end.column
                  : false;
        if (selected !== inSelection) {
          flush(inSelection);
          inSelection = selected;
        }
        buffer += cell;
        cellCol = cellEnd + 1;
      }
      flush(inSelection);
      column += stringWidth(seg.text);
    }
    return {
      kind: styled.kind,
      segments: out,
      ...(styled.rowBackground !== undefined ? { rowBackground: styled.rowBackground } : {}),
    };
  });
}