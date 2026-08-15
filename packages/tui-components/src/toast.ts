/**
 * Toast notifications - brief, transient popup messages.
 *
 * A toast is a small bordered box that appears in the upper-right corner of the
 * screen for a short time and then disappears. The TUI uses it to acknowledge a
 * copy, surface a failed clipboard write, or report a completed mouse selection.
 *
 * Rendered as a popup box (top + body + bottom border) so it reads as a discrete
 * floating acknowledgement rather than another timeline row that shifts the
 * surrounding layout.
 */

import { getBoxGlyphs } from "./blocks.ts";
import { line, segment, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import { icon, type IconCapabilities } from "./theme.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastState {
  readonly kind: ToastKind;
  readonly text: string;
  /** Epoch milliseconds at which the toast should be removed. */
  readonly expiresAt: number;
}

/** Default visibility window. */
export const TOAST_DURATION_MS = 2_500;

/** One-cell breathing room between the toast and the terminal edge. */
export const TOAST_RIGHT_INSET = 1;

const TOAST_MIN_INNER_WIDTH = 16;
const TOAST_HORIZONTAL_PADDING = 1;

function toastIcon(kind: ToastKind, capabilities: IconCapabilities): string {
  switch (kind) {
    case "success":
      return icon("success", capabilities);
    case "warning":
      return icon("warning", capabilities);
    case "error":
      return icon("error", capabilities);
    case "info":
    default:
      return icon("active", capabilities);
  }
}

function toastToken(kind: ToastKind) {
  switch (kind) {
    case "success":
      return "accent.green" as const;
    case "warning":
      return "accent.amber" as const;
    case "error":
      return "accent.red" as const;
    case "info":
    default:
      return "accent.cyan" as const;
  }
}

/**
 * Render a toast as an upper-right popup box (top border, body, bottom border).
 *
 * The box is sized to the message plus padding and right-aligned with a small
 * inset. Every emitted row is exactly `context.columns` cells wide. Keeping the
 * margins in the semantic line is important for both renderers: OpenTUI can
 * paint the card without a second widget, while the ANSI fallback cannot leave
 * the cursor at a different column on the next redraw.
 */
export function renderToast(toast: ToastState, context: BlockContext): StyledLine[] {
  const glyphs = getBoxGlyphs(context.capabilities.unicode);
  const token = toastToken(toast.kind);
  const glyph = toastIcon(toast.kind, context.capabilities);

  // A toast is an inline acknowledgement, so a newline in an unexpected error
  // message must never turn it into a multi-row layout block.
  const message = toast.text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const iconWidth = stringWidth(glyph);
  const desiredContentWidth = iconWidth + 1 + stringWidth(message);
  const desiredInnerWidth = Math.max(
    TOAST_MIN_INNER_WIDTH,
    desiredContentWidth + TOAST_HORIZONTAL_PADDING * 2,
  );
  const columns = Math.max(1, context.columns);
  // The outer box includes one border cell on either side. Never emit a row
  // wider than the terminal; long messages are truncated inside the box below.
  const boxWidth = Math.min(columns, desiredInnerWidth + 2);
  const innerWidth = Math.max(0, boxWidth - 2);
  const maxMessageWidth = Math.max(
    0,
    innerWidth - TOAST_HORIZONTAL_PADDING * 2 - iconWidth - 1,
  );
  const visibleMessage = truncateToWidth(message, maxMessageWidth);
  const contentWidth = iconWidth + 1 + stringWidth(visibleMessage);
  const contentPadding = Math.max(
    0,
    innerWidth - TOAST_HORIZONTAL_PADDING * 2 - contentWidth,
  );

  const rightInset = columns > boxWidth ? Math.min(TOAST_RIGHT_INSET, columns - boxWidth) : 0;
  const leftPad = Math.max(0, columns - boxWidth - rightInset);
  const rightPad = Math.max(0, columns - leftPad - boxWidth);
  const leftMargin = segment(" ".repeat(leftPad), {});
  const rightMargin = segment(" ".repeat(rightPad), {});
  const panel = { bg: "bg.panel" as const };
  const inner = Math.max(0, boxWidth - 2);

  const topBorder = line("overlay", [
    leftMargin,
    segment(`${glyphs.topLeft}${glyphs.horizontal.repeat(inner)}${glyphs.topRight}`, {
      fg: token,
      ...panel,
    }),
    rightMargin,
  ]);
  const bottomBorder = line("overlay", [
    leftMargin,
    segment(`${glyphs.bottomLeft}${glyphs.horizontal.repeat(inner)}${glyphs.bottomRight}`, {
      fg: token,
      ...panel,
    }),
    rightMargin,
  ]);

  // Body: left border, content padded to inner, right border.
  const bodySegments: Segment[] = [
    leftMargin,
    segment(glyphs.vertical, { fg: token, ...panel }),
    segment(" ".repeat(TOAST_HORIZONTAL_PADDING), panel),
    segment(glyph, { fg: token, bold: true, ...panel }),
    segment(" ", panel),
    segment(visibleMessage, { fg: "fg.primary", ...panel }),
  ];
  if (TOAST_HORIZONTAL_PADDING + contentPadding > 0) {
    bodySegments.push(segment(" ".repeat(TOAST_HORIZONTAL_PADDING + contentPadding), panel));
  }
  bodySegments.push(segment(glyphs.vertical, { fg: token, ...panel }), rightMargin);
  const body = line("overlay", bodySegments);

  return [topBorder, body, bottomBorder];
}

export interface FlashBanner {
  readonly kind: ToastKind;
  readonly text: string;
  readonly expiresAt: number;
  readonly progress?: number;
}

export const FLASH_DURATION_MS = 3_000;

export function makeFlash(kind: ToastKind, text: string, nowMs: number, progress?: number): FlashBanner {
  return { kind, text, expiresAt: nowMs + FLASH_DURATION_MS, ...(progress !== undefined ? { progress } : {}) };
}

export function flashExpired(banner: FlashBanner, nowMs: number): boolean {
  return nowMs >= banner.expiresAt;
}

export function renderFlash(banner: FlashBanner, context: BlockContext): StyledLine[] {
  const glyphs = getBoxGlyphs(context.capabilities.unicode);
  const token = toastToken(banner.kind);
  const glyph = toastIcon(banner.kind, context.capabilities);
  const message = banner.text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const inner = Math.max(1, context.columns - 2);
  const bar = banner.progress !== undefined
    ? ` ${"█".repeat(Math.round(Math.max(0, Math.min(1, banner.progress)) * 8))}${"░".repeat(8 - Math.round(Math.max(0, Math.min(1, banner.progress)) * 8))}`
    : "";
  const text = truncateToWidth(`${glyph} ${message}${bar}`, inner - 2);
  return [
    line("banner", [segment(`${glyphs.topLeft}${glyphs.horizontal.repeat(inner)}${glyphs.topRight}`, { fg: token, bg: "bg.panel" })]),
    line("banner", [segment(glyphs.vertical, { fg: token, bg: "bg.panel" }), segment(` ${text} `.padEnd(inner), { fg: "fg.primary", bg: "bg.panel" }), segment(glyphs.vertical, { fg: token, bg: "bg.panel" })]),
    line("banner", [segment(`${glyphs.bottomLeft}${glyphs.horizontal.repeat(inner)}${glyphs.bottomRight}`, { fg: token, bg: "bg.panel" })]),
  ];
}

/** Whether `nowMs` is past the toast's expiry. */
export function toastExpired(toast: ToastState, nowMs: number): boolean {
  return nowMs >= toast.expiresAt;
}

/** Build a toast that lasts `TOAST_DURATION_MS` from `nowMs`. */
export function makeToast(
  kind: ToastKind,
  text: string,
  nowMs: number,
  durationMs: number = TOAST_DURATION_MS,
): ToastState {
  return { kind, text, expiresAt: nowMs + durationMs };
}

/** Convenience: measure a toast's visible content width for layout budgeting. */
export function toastWidth(toast: ToastState, capabilities: IconCapabilities): number {
  return stringWidth(`${toastIcon(toast.kind, capabilities)} `) + stringWidth(toast.text);
}