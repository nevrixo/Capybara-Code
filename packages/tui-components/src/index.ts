/**
 * `@cbc/tui-components` — the TUI's semantic layer (PRD §6).
 *
 * This package is renderer-independent on purpose. §19.3 puts OpenTUI and Solid in
 * `apps/cbc`, and §19.3 also requires a plain fallback when the renderer cannot
 * start. Keeping theme resolution, width measurement, sanitization, and every block
 * renderer here means the OpenTUI view and automatic line mode are the same layout
 * decisions with two serializers — and §25.8's golden tests can assert semantic
 * cells and ANSI bytes from one source.
 */

export * from "./theme.ts";
export * from "./width.ts";
export * from "./sanitize.ts";
export * from "./markdown.ts";
export * from "./segments.ts";
export * from "./layout.ts";
export * from "./blocks.ts";
export * from "./chrome.ts";
export * from "./keymap.ts";
export * from "./overlays.ts";
export * from "./completion.ts";
export * from "./timeline.ts";
export * from "./screen.ts";
export * from "./selection.ts";
export * from "./toast.ts";
export * from "./clipboard.ts";
export * from "./context-usage.ts";
export * from "./todo.ts";

export * from "./timeline-store.ts";
