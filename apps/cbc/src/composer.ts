/**
 * The interactive composer — PRD §6.14, §6.15, §7.7, AC-05, AC-20.
 *
 * A pure reducer over key events. It owns the composer text, the caret, the §6.14
 * completion popup, and the two arm-then-confirm escalations (`Esc Esc` to stop a
 * turn, `Ctrl+C Ctrl+C` to exit). Keeping it free of IO is what lets §25.2 drive
 * every one of those paths with synthetic keys instead of a PTY.
 *
 * Editing is by *grapheme cluster*, not code unit. AC-05 requires Korean input to
 * survive cursor movement, wrapping, and deletion, and a composed Hangul syllable
 * has to vanish whole when backspaced.
 */

import {
  CLOSED_COMPLETION,
  CTRL_C_EXIT_HINT,
  DEFAULT_KEYMAP,
  ESCAPE_CANCEL_HINT,
  acceptCompletion,
  completionKindAt,
  completionPrefix,
  computeCompletions,
  escapeScopeFor,
  graphemes,
  moveCompletion,
  resolveCtrlC,
  resolveKey,
  resolveEscape,
  type CompletionSources,
  type CompletionState,
  type EscapePress,
  type KeyAction,
  type KeyBinding,
} from "@cbc/tui-components";

import type { KeyEvent } from "./keys.ts";

/**
 * A paste-turned-attachment record.
 *
 * P1-02: paste tokenization is disabled — pastes insert verbatim so nothing
 * the user pasted is hidden from the model — so no attachments are staged
 * today. This shape is kept for the future attachment pipeline that forwards
 * real bytes to the provider input.
 */
export interface ComposerAttachment {
  readonly kind: "image" | "text";
  /** `[Image 1]` / `[Text 1]` — the token inserted into the composer text. */
  readonly token: string;
  /** One-based index within its kind, matching the number in `token`. */
  readonly index: number;
  /** The original paste bytes. Present for text pastes. */
  readonly text?: string;
  /** A file path the paste was reduced from. Present for image pastes. */
  readonly path?: string;
}

/** What the host should do after a key was handled. */
export type ComposerEffect =
  | { readonly kind: "none" }
  | { readonly kind: "redraw" }
  | { readonly kind: "submit"; readonly text: string; readonly attachments?: readonly ComposerAttachment[] }
  /** A non-destructive status notice, such as an armed `Esc` exit. */
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "exit" }
  /** `Esc Esc` while a turn is running. */
  | { readonly kind: "cancel_turn" }
  /** §6.11: stop awaiting a subagent; the child keeps going. */
  | { readonly kind: "interrupt_wait" }
  | { readonly kind: "offer_cancel"; readonly taskId: string }
  | { readonly kind: "cancel_task"; readonly taskId: string }
  | { readonly kind: "open_overlay"; readonly overlay: string }
  | { readonly kind: "cycle_interaction_mode" }
  /** `Ctrl+T`: step the reasoning effort to the next supported value. */
  | { readonly kind: "cycle_reasoning_effort" }
  | { readonly kind: "toggle_sidebar" }
  | { readonly kind: "toggle_accordion" }
  | { readonly kind: "cycle_thinking" }
  | { readonly kind: "redraw_screen" }
  | { readonly kind: "scroll_page_up" }
  | { readonly kind: "scroll_page_down" }
  | { readonly kind: "scroll_up" }
  | { readonly kind: "scroll_down" };

export interface ComposerHostState {
  /** True while a turn is in flight, so `Esc Esc` can interrupt it. */
  readonly turnRunning: boolean;
  /** The subagent being awaited, when one is (§6.11). */
  readonly awaitingTaskId?: string;
  /** A background subagent available for cancellation at an idle prompt. */
  readonly activeTaskId?: string;
  readonly overlayOpen?: boolean;
  readonly scrolledUp?: boolean;
}

export interface ComposerSessionOptions {
  readonly sources?: CompletionSources;
  readonly now?: () => number;
  readonly keymap?: readonly KeyBinding[];
  /** Enable the readline-style two-stage Ctrl+D EOF gesture. */
  readonly eofExit?: boolean;
}

export interface ComposerMetrics {
  readonly revision: number;
  readonly graphemes: string[];
  /** UTF-16 offsets, including the zero offset at index 0. */
  readonly charOffsets: number[];
}

interface PasteChip {
  readonly id: number;
  readonly marker: string;
  readonly raw: string;
  readonly lines: number;
  markerStart: number;
  markerEnd: number;
}

/**
 * Composer state plus the escalation timers.
 *
 * `#lastEscape` is the whole of the "press it twice" mechanism. It is cleared by
 * every other key, so a stray first `Esc` cannot leave the session one keystroke
 * from stopping a turn or exiting.
 */
export class ComposerSession {
  #text = "";
  #textRevision = 0;
  #metrics: ComposerMetrics | undefined;
  #completionRevision = -1;
  #completionCursor = -1;
  #cursor = 0;
  #completion: CompletionState = CLOSED_COMPLETION;
  /** Keep an asynchronous source refresh from reopening a popup the user just dismissed. */
  #completionDismissed = false;
  #lastEscape: EscapePress | undefined;
  #lastCtrlC: number | undefined;
  #lastCtrlD: number | undefined;
  #leaderStartedAt: number | undefined;
  #preferredColumn: number | undefined;
  #killBuffer = "";
  readonly #keymap: readonly KeyBinding[];
  readonly #sources: CompletionSources;
  readonly #now: () => number;
  readonly #eofExit: boolean;
  #pasteCounter = 0;
  #pasteChips: PasteChip[] = [];
  #history: string[] = [];
  #historyIndex = -1;
  #draft = "";
  /**
   * Attachments accumulated from pastes, in insertion order.
   *
   * Paste chips keep the editor clean while the original bytes are retained
   * for submission via `expandedText()` / `lastAttachments`.
   */
  readonly #attachments: ComposerAttachment[] = [];

  constructor(options: ComposerSessionOptions = {}) {
    this.#sources = options.sources ?? {};
    this.#now = options.now ?? (() => Date.now());
    this.#keymap = options.keymap ?? DEFAULT_KEYMAP;
    // Source-configured callers retain the historical no-op Ctrl+D contract;
    // the interactive reader opts into the public two-stage EOF gesture.
    this.#eofExit = options.eofExit ?? options.sources === undefined;
  }

  get text(): string {
    return this.#text;
  }

  /** Caret position, in grapheme clusters (§6.6, AC-05). */
  get cursor(): number {
    return this.#cursor;
  }

  /** Cached grapheme/UTF-16 index shared with renderers that opt into it. */
  get metrics(): ComposerMetrics {
    return this.#metricsForText();
  }

  get completion(): CompletionState {
    return this.#completion;
  }

  get completionOpen(): boolean {
    return this.#completion.open;
  }

  /**
   * Re-evaluate an externally populated source, such as the background workspace
   * path index, without requiring the user to type another character.
   */
  refreshCompletions(): void {
    // A repository scan may finish after Esc closed the popup. Respect that explicit
    // dismissal until the next ordinary edit/cursor action recomputes completion.
    if (this.#completionDismissed) return;

    const selected = this.#completion.open
      ? this.#completion.candidates[this.#completion.selected]
      : undefined;
    this.#recompute();
    if (selected === undefined || !this.#completion.open) return;

    const nextIndex = this.#completion.candidates.findIndex((candidate) =>
      candidate.value === selected.value && candidate.insert === selected.insert);
    if (nextIndex >= 0) this.#completion = { ...this.#completion, selected: nextIndex };
  }

  /** Attachments the next submit will hand to the host. */
  get attachments(): readonly ComposerAttachment[] {
    return this.#attachments;
  }

  /** Replace the buffer, e.g. when recalling a prompt. */
  set(text: string, cursor = graphemes(text).length): void {
    this.#setText(text);
    this.#cursor = Math.max(0, Math.min(cursor, this.#metricsForText().graphemes.length));
    this.#preferredColumn = undefined;
    this.#pasteChips = [];
    this.#attachments.length = 0;
    this.#recompute();
  }

  clear(): void {
    this.#setText("");
    this.#cursor = 0;
    this.#preferredColumn = undefined;
    this.#leaderStartedAt = undefined;
    this.#lastCtrlD = undefined;
    this.#completion = CLOSED_COMPLETION;
    this.#completionDismissed = false;
    this.#pasteChips = [];
    this.#historyIndex = this.#history.length;
    this.#draft = "";
    this.#attachments.length = 0;
  }

  expandedText(): string {
    if (this.#pasteChips.length === 0) return this.#text;
    let out = this.#text;
    const metrics = this.#metricsForText();
    const sorted = [...this.#pasteChips].sort((a, b) => b.markerStart - a.markerStart);
    for (const chip of sorted) {
      out = out.slice(0, this.#graphemeOffsetToCharOffset(chip.markerStart, metrics)) +
        chip.raw +
        out.slice(this.#graphemeOffsetToCharOffset(chip.markerEnd, metrics));
    }
    return out;
  }

  get pasteChipCount(): number {
    return this.#pasteChips.length;
  }

  #setText(text: string): void {
    this.#text = text;
    this.#textRevision += 1;
    this.#metrics = undefined;
  }

  #metricsForText(): ComposerMetrics {
    if (this.#metrics?.revision === this.#textRevision) return this.#metrics;
    const clusters = graphemes(this.#text);
    const charOffsets = [0];
    let offset = 0;
    for (const cluster of clusters) {
      offset += cluster.length;
      charOffsets.push(offset);
    }
    this.#metrics = {
      revision: this.#textRevision,
      graphemes: clusters,
      charOffsets,
    };
    return this.#metrics;
  }

  #graphemeIndexForCharOffset(
    offset: number,
    metrics = this.#metricsForText(),
  ): number {
    const target = Math.max(0, Math.min(Math.floor(offset), this.#text.length));
    let low = 0;
    let high = metrics.charOffsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((metrics.charOffsets[middle] ?? 0) <= target) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  #pushHistory(text: string): void {
    const t = text.trim();
    if (t.length === 0) return;
    if (this.#history[this.#history.length - 1] === t) {
      this.#historyIndex = this.#history.length;
      return;
    }
    this.#history.push(t);
    if (this.#history.length > 100) this.#history.shift();
    this.#historyIndex = this.#history.length;
    this.#draft = "";
  }

  #navigateHistory(delta: number): ComposerEffect | undefined {
    if (this.#history.length === 0) return undefined;
    if (delta < 0) {
      if (this.#historyIndex === this.#history.length) this.#draft = this.#text;
      if (this.#historyIndex > 0) {
        this.#historyIndex -= 1;
        this.#setText(this.#history[this.#historyIndex] ?? "");
        this.#cursor = this.#metricsForText().graphemes.length;
        this.#pasteChips = [];
        this.#recompute();
        return { kind: "redraw" };
      }
      return { kind: "none" };
    }
    if (this.#historyIndex < this.#history.length - 1) {
      this.#historyIndex += 1;
      this.#setText(this.#history[this.#historyIndex] ?? "");
      this.#cursor = this.#metricsForText().graphemes.length;
      this.#pasteChips = [];
      this.#recompute();
      return { kind: "redraw" };
    }
    if (this.#historyIndex === this.#history.length - 1) {
      this.#historyIndex = this.#history.length;
      this.#setText(this.#draft);
      this.#cursor = this.#metricsForText().graphemes.length;
      this.#pasteChips = [];
      this.#recompute();
      return { kind: "redraw" };
    }
    return undefined;
  }

  #graphemeOffsetToCharOffset(
    offset: number,
    metrics = this.#metricsForText(),
  ): number {
    const index = Math.max(0, Math.min(Math.floor(offset), metrics.graphemes.length));
    return metrics.charOffsets[index] ?? this.#text.length;
  }

  #shiftChips(from: number, delta: number): void {
    for (const chip of this.#pasteChips) {
      if (chip.markerStart >= from) {
        chip.markerStart += delta;
        chip.markerEnd += delta;
      }
    }
  }

  #chipBeforeCursor(): PasteChip | undefined {
    return this.#pasteChips.find((c) => c.markerEnd === this.#cursor);
  }

  #chipAtCursor(): PasteChip | undefined {
    return this.#pasteChips.find((c) => this.#cursor > c.markerStart && this.#cursor < c.markerEnd);
  }

  #chipAfterCursor(): PasteChip | undefined {
    return this.#pasteChips.find((c) => c.markerStart === this.#cursor);
  }

  /** Handle one key. Returns what the host should do about it. */
  handle(event: KeyEvent, host: ComposerHostState): ComposerEffect {
    // Each two-key escalation is armed only by a consecutive repeat of its own
    // key, so any other key safely disarms it before the handler continues.
    if (event.key !== "escape") this.#lastEscape = undefined;
    if (event.key !== "ctrl+c") this.#lastCtrlC = undefined;
    if (event.key !== "ctrl+d") this.#lastCtrlD = undefined;

    const now = this.#now();
    if (this.#leaderStartedAt !== undefined) {
      const active = now - this.#leaderStartedAt <= 1_500;
      this.#leaderStartedAt = undefined;
      if (event.key === "escape") return { kind: "redraw" };
      if (active) {
        const suffix =
          event.key === "text" && event.text !== undefined
            ? graphemes(event.text)[0]?.toLowerCase()
            : event.key.toLowerCase();
        if (suffix !== undefined) {
          const binding = resolveKey(
            `ctrl+x ${suffix}`,
            {
              running: host.turnRunning,
              overlayOpen: host.overlayOpen === true,
              composerHasText: this.#text.length > 0,
              awaitingTask: host.awaitingTaskId !== undefined,
              completionOpen: this.#completion.open,
            },
            this.#keymap,
          );
          if (binding !== undefined) {
            return this.#dispatchAction(binding.action, host, event.key);
          }
        }
        return { kind: "notice", text: "Unknown Ctrl+X chord. Press Ctrl+X H for help." };
      }
    }

    if (event.key === "ctrl+x") {
      this.#leaderStartedAt = now;
      return { kind: "notice", text: "Ctrl+X: A agents, T tasks, P todo, D diff, L sessions, C context, M models, H help" };
    }

    const lookupKey =
      event.key === "text" && event.text === "?" && this.#text.length === 0
        ? "?"
        : event.key;
    const binding = resolveKey(lookupKey, {
      running: host.turnRunning,
      overlayOpen: host.overlayOpen === true,
      composerHasText: this.#text.length > 0,
      awaitingTask: host.awaitingTaskId !== undefined,
      completionOpen: this.#completion.open,
    }, this.#keymap);
    if (binding !== undefined) return this.#dispatchAction(binding.action, host, event.key);

    switch (event.key) {
      case "escape":
        return this.#onEscape(host);
      case "ctrl+c":
        return this.#onCtrlC(host);
      case "ctrl+d":
        // §6.15: at an empty composer this is end of input, not a character.
        return this.#onCtrlD();
      case "pageup":
        return { kind: "scroll_page_up" };
      case "pagedown":
        return { kind: "scroll_page_down" };
      case "enter":
        return this.#onEnter();
      case "tab":
        // Tab is the picker confirmation key. Arrows only move the highlight.
        return this.#onTab();
      case "down": {
        if (this.#completion.open) return this.#onNext();
        if (host.scrolledUp === true) return { kind: "scroll_down" };
        return this.#moveVertical(1);
      }
      case "shift+tab":
        return this.#completion.open ? this.#onPrev() : { kind: "cycle_interaction_mode" };
      case "up": {
        if (this.#completion.open) return this.#onPrev();
        if (host.scrolledUp === true) return { kind: "scroll_up" };
        return this.#moveVertical(-1);
      }
      case "ctrl+j":
        return this.#insert("\n");
      case "backspace":
        return this.#onBackspace();
      case "left": {
        const chipB = this.#chipBeforeCursor();
        if (chipB !== undefined) {
          this.#cursor = chipB.markerStart;
          this.#recompute();
          return { kind: "redraw" };
        }
        const atChip = this.#chipAtCursor();
        if (atChip !== undefined) {
          this.#cursor = atChip.markerStart;
          this.#recompute();
          return { kind: "redraw" };
        }
        this.#cursor = Math.max(0, this.#cursor - 1);
        this.#preferredColumn = undefined;
        this.#recompute();
        return { kind: "redraw" };
      }
      case "right": {
        const chipA = this.#chipAfterCursor();
        if (chipA !== undefined) {
          this.#cursor = chipA.markerEnd;
          this.#recompute();
          return { kind: "redraw" };
        }
        const atChipR = this.#chipAtCursor();
        if (atChipR !== undefined) {
          this.#cursor = atChipR.markerEnd;
          this.#recompute();
          return { kind: "redraw" };
        }
        this.#cursor = Math.min(this.#graphemeCount(), this.#cursor + 1);
        this.#preferredColumn = undefined;
        this.#recompute();
        return { kind: "redraw" };
      }
      case "home":
        return this.#moveToLineBoundary("start");
      case "end":
        return this.#moveToLineBoundary("end");
      case "ctrl+u":
        this.clear();
        return { kind: "redraw" };
      case "ctrl+l":
        return { kind: "redraw_screen" };
      case "ctrl+b":
        return { kind: "toggle_sidebar" };
      case "ctrl+o":
        return { kind: "toggle_accordion" };
      case "ctrl+p":
        // The command palette is the same fast completion surface as a typed `/`.
        // Keeping one surface avoids a second modal input reader stealing stdin.
        if (this.#text.trim().length === 0) {
          this.set("/");
          return { kind: "redraw" };
        }
        if (this.#text.trimStart().startsWith("/")) {
          this.#recompute();
          return { kind: "redraw" };
        }
        return { kind: "notice", text: "Clear the composer before opening commands." };
      case "ctrl+m":
        // Keep model selection in the same composer completion flow as slash commands.
        // Opening it by inserting the command also means the full-screen renderer
        // never has to hand terminal ownership to a second picker.
        if (this.#text.trim().length === 0) {
          this.set("/model ");
          return { kind: "redraw" };
        }
        return { kind: "notice", text: "Clear the composer before choosing a model." };
      case "ctrl+r":
        // Reasoning effort/mode uses the same popup as `/effort`, so it is
        // searchable and can be committed with Tab without an Enter key.
        if (this.#text.trim().length === 0) {
          this.set("/effort ");
          return { kind: "redraw" };
        }
        return { kind: "notice", text: "Clear the composer before choosing an effort." };
      case "ctrl+a":
        return { kind: "open_overlay", overlay: "agents" };
      case "ctrl+t":
        // Matches the keymap: `Ctrl+T` steps the effort, and the tasks drawer
        // is reached with `Ctrl+X T`.
        return { kind: "cycle_reasoning_effort" };
      case "text":
        return event.text === undefined ? { kind: "none" } : this.#insert(event.text);
      case "paste": {
        if (event.text === undefined) return { kind: "none" };
        const raw = event.text;
        const lines = raw.split("\n").length;
        const isLarge = lines > 3 || raw.length > 200;
        if (!isLarge) return this.#insert(raw);
        this.#pasteCounter += 1;
        const marker = `[paste #${this.#pasteCounter} +${lines} lines]`;
        const metrics = this.#metricsForText();
        const offset = this.#graphemeOffsetToCharOffset(this.#cursor, metrics);
        const before = this.#text.slice(0, offset);
        const after = this.#text.slice(offset);
        this.#setText(`${before}${marker}${after}`);
        const start = this.#cursor;
        const len = graphemes(marker).length;
        this.#pasteChips.push({ id: this.#pasteCounter, marker, raw, lines, markerStart: start, markerEnd: start + len });
        this.#cursor = start + len;
        this.#shiftChips(start, 0);
        this.#recompute();
        return { kind: "redraw" };
      }
      default:
        return { kind: "none" };
    }
  }

  #dispatchAction(
    action: KeyAction,
    host: ComposerHostState,
    sourceKey: string,
  ): ComposerEffect {
    switch (action) {
      case "submit":
        return this.#onEnter();
      case "newline":
        return this.#insert("\n");
      case "interrupt_wait":
      case "close_overlay":
      case "close_completions":
        return this.#onEscape(host);
      case "cancel_turn":
        return sourceKey === "ctrl+c" ? this.#onCtrlC(host) : { kind: "cancel_turn" };
      case "clear_composer":
        if (sourceKey === "ctrl+c") return this.#onCtrlC(host);
        this.clear();
        return { kind: "redraw" };
      case "confirm_exit":
        return this.#onCtrlC(host);
      case "delete_forward":
        return this.#onCtrlD();
      case "command_palette":
        return this.#openCompletionCommand("/", "commands");
      case "model_picker":
        return this.#openCompletionCommand("/model ", "a model");
      case "reasoning_picker":
        return this.#openCompletionCommand("/effort ", "an effort");
      case "thinking_visibility":
        return { kind: "cycle_thinking" };
      case "history_search":
        return this.#reverseHistorySearch();
      case "line_start":
        return this.#moveToLineBoundary("start");
      case "line_end":
        return this.#moveToLineBoundary("end");
      case "kill_to_end":
        return this.#killToBoundary("end");
      case "kill_to_start":
      case "clear_line":
        return this.#killToBoundary("start");
      case "kill_word":
        return this.#killPreviousWord();
      case "yank":
        return this.#killBuffer.length > 0
          ? this.#insert(this.#killBuffer)
          : { kind: "none" };
      case "agents_drawer":
        return { kind: "open_overlay", overlay: "agents" };
      case "diff_viewer":
        return { kind: "open_overlay", overlay: "diff" };
      case "tasks_drawer":
        return { kind: "open_overlay", overlay: "jobs" };
      case "sessions_drawer":
        return { kind: "open_overlay", overlay: "sessions" };
      case "context_drawer":
        return { kind: "open_overlay", overlay: "context" };
      case "todo_drawer":
        return { kind: "open_overlay", overlay: "todo" };
      case "memory_drawer":
        return { kind: "open_overlay", overlay: "memory" };
      case "graph_drawer":
        return { kind: "open_overlay", overlay: "graph" };
      case "worktree_drawer":
        return { kind: "open_overlay", overlay: "worktree" };
      case "plugins_drawer":
        return { kind: "open_overlay", overlay: "plugins" };
      case "details_overlay":
        return { kind: "open_overlay", overlay: "details" };
      case "cycle_interaction_mode":
        return { kind: "cycle_interaction_mode" };
      case "cycle_reasoning_effort":
        return { kind: "cycle_reasoning_effort" };
      case "toggle_sidebar":
        return { kind: "toggle_sidebar" };
      case "toggle_accordion":
        return { kind: "toggle_accordion" };
      case "redraw":
        return { kind: "redraw_screen" };
      case "complete":
        return this.#onTab();
      case "completion_accept":
        // Enter can submit a no-argument command even when another command's
        // description remains in the completion list; Tab accepts normally.
        return sourceKey === "enter" ? this.#onEnter() : this.#onTab();
      case "completion_next":
        return this.#onNext();
      case "completion_prev":
        return this.#onPrev();
      case "scroll_up":
        return { kind: "scroll_up" };
      case "scroll_down":
        return { kind: "scroll_down" };
      case "scroll_page_up":
      case "timeline_top":
        return { kind: "scroll_page_up" };
      case "scroll_page_down":
      case "timeline_bottom":
        return { kind: "scroll_page_down" };
      case "help":
        return { kind: "open_overlay", overlay: "help" };
    }
  }

  #openCompletionCommand(command: string, label: string): ComposerEffect {
    if (this.#text.trim().length > 0 && !this.#text.trimStart().startsWith("/")) {
      return { kind: "notice", text: `Clear the composer before choosing ${label}.` };
    }
    this.set(command);
    return { kind: "redraw" };
  }

  #lineBounds(cursor = this.#cursor): { start: number; end: number } {
    const clusters = this.#metricsForText().graphemes;
    let start = Math.max(0, Math.min(cursor, clusters.length));
    let end = start;
    while (start > 0 && clusters[start - 1] !== "\n") start -= 1;
    while (end < clusters.length && clusters[end] !== "\n") end += 1;
    return { start, end };
  }

  #moveToLineBoundary(boundary: "start" | "end"): ComposerEffect {
    const bounds = this.#lineBounds();
    this.#cursor = boundary === "start" ? bounds.start : bounds.end;
    this.#preferredColumn = undefined;
    this.#recompute();
    return { kind: "redraw" };
  }

  #moveVertical(delta: -1 | 1): ComposerEffect {
    const clusters = this.#metricsForText().graphemes;
    const starts = [0];
    for (let index = 0; index < clusters.length; index += 1) {
      if (clusters[index] === "\n") starts.push(index + 1);
    }
    let current = 0;
    for (let index = 1; index < starts.length; index += 1) {
      if ((starts[index] ?? 0) <= this.#cursor) current = index;
    }
    const target = current + delta;
    if (target < 0 || target >= starts.length) {
      this.#preferredColumn = undefined;
      return this.#navigateHistory(delta) ?? { kind: "none" };
    }
    const currentStart = starts[current] ?? 0;
    const column = this.#preferredColumn ?? Math.max(0, this.#cursor - currentStart);
    const targetStart = starts[target] ?? 0;
    const nextStart = starts[target + 1];
    const targetEnd = nextStart === undefined ? clusters.length : Math.max(targetStart, nextStart - 1);
    this.#cursor = targetStart + Math.min(column, targetEnd - targetStart);
    this.#preferredColumn = column;
    this.#recompute();
    return { kind: "redraw" };
  }

  #deleteRange(start: number, end: number): string {
    const clusters = this.#metricsForText().graphemes;
    let from = Math.max(0, Math.min(start, clusters.length));
    let to = Math.max(from, Math.min(end, clusters.length));
    for (const chip of this.#pasteChips) {
      if (chip.markerStart < to && chip.markerEnd > from) {
        from = Math.min(from, chip.markerStart);
        to = Math.max(to, chip.markerEnd);
      }
    }
    const removed = clusters.slice(from, to).join("");
    this.#setText([...clusters.slice(0, from), ...clusters.slice(to)].join(""));
    const amount = to - from;
    this.#pasteChips = this.#pasteChips
      .filter((chip) => chip.markerEnd <= from || chip.markerStart >= to)
      .map((chip) =>
        chip.markerStart >= to
          ? { ...chip, markerStart: chip.markerStart - amount, markerEnd: chip.markerEnd - amount }
          : chip);
    this.#cursor = from;
    this.#preferredColumn = undefined;
    this.#recompute();
    return removed;
  }

  #onDeleteForward(): ComposerEffect {
    if (this.#cursor >= this.#graphemeCount()) return { kind: "none" };
    const chip = this.#chipAfterCursor() ?? this.#chipAtCursor();
    this.#deleteRange(
      chip?.markerStart ?? this.#cursor,
      chip?.markerEnd ?? this.#cursor + 1,
    );
    return { kind: "redraw" };
  }

  #onCtrlD(): ComposerEffect {
    if (this.#text.length > 0) {
      this.#lastCtrlD = undefined;
      return this.#onDeleteForward();
    }
    if (!this.#eofExit) return { kind: "none" };
    const now = this.#now();
    if (this.#lastCtrlD !== undefined && now - this.#lastCtrlD <= 1_000) {
      this.#lastCtrlD = undefined;
      return { kind: "exit" };
    }
    this.#lastCtrlD = now;
    return { kind: "notice", text: "Press Ctrl+D again to exit." };
  }

  #killToBoundary(boundary: "start" | "end"): ComposerEffect {
    const bounds = this.#lineBounds();
    const start = boundary === "start" ? bounds.start : this.#cursor;
    const end = boundary === "start" ? this.#cursor : bounds.end;
    if (start === end) return { kind: "none" };
    this.#killBuffer = this.#deleteRange(start, end);
    return { kind: "redraw" };
  }

  #killPreviousWord(): ComposerEffect {
    const clusters = this.#metricsForText().graphemes;
    let start = this.#cursor;
    while (start > 0 && /\s/u.test(clusters[start - 1] ?? "")) start -= 1;
    while (start > 0 && !/\s/u.test(clusters[start - 1] ?? "")) start -= 1;
    if (start === this.#cursor) return { kind: "none" };
    this.#killBuffer = this.#deleteRange(start, this.#cursor);
    return { kind: "redraw" };
  }

  #reverseHistorySearch(): ComposerEffect {
    const query = this.#text.trim().toLowerCase();
    const match = [...this.#history].reverse().find((entry) =>
      query.length === 0 || entry.toLowerCase().includes(query));
    if (match === undefined) {
      return { kind: "notice", text: "No matching history entry." };
    }
    this.set(match);
    return { kind: "redraw" };
  }

  // -- Escalations ---------------------------------------------------------

  #onEscape(host: ComposerHostState): ComposerEffect {
    // A typed prompt still owns Esc. Background-task cancellation is available
    // only from an empty composer so a user does not lose a draft by accident.
    const activeTaskId = this.#text.length === 0 ? host.activeTaskId : undefined;
    const outcome = resolveEscape({
      overlayOpen: host.overlayOpen === true,
      completionOpen: this.#completion.open,
      turnRunning: host.turnRunning,
      ...(host.awaitingTaskId !== undefined ? { awaitingTaskId: host.awaitingTaskId } : {}),
      ...(activeTaskId !== undefined ? { activeTaskId } : {}),
      ...(this.#lastEscape !== undefined ? { lastEscape: this.#lastEscape } : {}),
      nowMs: this.#now(),
    });

    const scope = escapeScopeFor(outcome, host.awaitingTaskId ?? activeTaskId);
    this.#lastEscape = scope === undefined ? undefined : { scope, atMs: this.#now() };

    switch (outcome.kind) {
      case "close_completions":
        this.#completion = CLOSED_COMPLETION;
        this.#completionDismissed = true;
        return { kind: "redraw" };
      case "close_overlay":
        return { kind: "redraw_screen" };
      case "interrupt_wait":
        return { kind: "interrupt_wait" };
      case "offer_cancel":
        return { kind: "offer_cancel", taskId: outcome.taskId };
      case "arm_cancel_task":
        return { kind: "notice", text: `Press Esc again to cancel background task ${outcome.taskId}.` };
      case "cancel_task":
        return { kind: "cancel_task", taskId: outcome.taskId };
      case "arm_cancel_turn":
        return { kind: "notice", text: ESCAPE_CANCEL_HINT };
      case "cancel_turn":
        return { kind: "cancel_turn" };
      case "ignored":
        // At an idle prompt Esc clears a half-typed line, but never exits the
        // program. `Ctrl+C Ctrl+C` is the only composer exit gesture.
        if (this.#text.length === 0) return { kind: "none" };
        this.clear();
        return { kind: "redraw" };
    }
  }

  #onCtrlC(host: ComposerHostState): ComposerEffect {
    const now = this.#now();
    const outcome = resolveCtrlC({
      running: host.turnRunning,
      composerHasText: this.#text.length > 0,
      ...(this.#lastCtrlC !== undefined ? { lastCtrlC: this.#lastCtrlC } : {}),
      nowMs: now,
    });

    switch (outcome.kind) {
      case "clear_composer":
        this.#lastCtrlC = undefined;
        this.clear();
        return { kind: "redraw" };
      case "confirm_exit":
        this.#lastCtrlC = now;
        return { kind: "notice", text: CTRL_C_EXIT_HINT };
      case "exit":
        this.#lastCtrlC = undefined;
        return { kind: "exit" };
    }
  }

  // -- Editing and completion ---------------------------------------------

  #onEnter(): ComposerEffect {
    const text = this.expandedText().trim();
    if (this.#completion.open) {
      const candidate = this.#completion.candidates[this.#completion.selected];
      const acceptsNoArgumentCommand =
        this.#completion.kind === "command" &&
        candidate !== undefined &&
        candidate.insert === undefined;
      const accepted = this.#onTab();
      if (!acceptsNoArgumentCommand || accepted.kind !== "redraw") return accepted;

      // Enter is a submit action, not a request to leave a no-argument command
      // selected in the popup. Commands with arguments intentionally keep the
      // popup open so their argument stage can be completed next.
      const submitted = this.expandedText().trim();
      this.#completion = CLOSED_COMPLETION;
      if (submitted.length === 0) return accepted;
      this.#pushHistory(submitted);
      this.#pasteChips = [];
      return { kind: "submit", text: submitted };
    }
    const clusters = this.#metricsForText().graphemes;
    if (this.#cursor > 0 && clusters[this.#cursor - 1] === "\\") {
      this.#deleteRange(this.#cursor - 1, this.#cursor);
      return this.#insert("\n");
    }

    if (text.length === 0) return { kind: "none" };
    if (text === "/model" || text === "/effort" || text === "/resume") {
      this.set(`${text} `);
      return { kind: "redraw" };
    }
    const expanded = this.expandedText().trim();
    this.#pushHistory(expanded);
    this.#pasteChips = [];
    return this.#attachments.length > 0
      ? { kind: "submit", text: expanded, attachments: [...this.#attachments] }
      : { kind: "submit", text: expanded };
  }

  #resumeOrSubmit(text: string): ComposerEffect {
    const picker = computeCompletions(`${text} `, `${text} `.length, this.#sources);
    if (!picker.open) return { kind: "submit", text };
    this.set(`${text} `);
    return { kind: "redraw" };
  }

  #onTab(): ComposerEffect {
    if (!this.#completion.open) {
      const opened = computeCompletions(this.#text, this.#charOffset(), this.#sources);
      if (!opened.open) return { kind: "none" };
      this.#completion = opened;
      return { kind: "redraw" };
    }

    const isArgumentCompletion = this.#completion.kind === "argument";
    const isSlashCompletion =
      this.#completion.kind === "command" || isArgumentCompletion;
    this.#accept();

    if (isSlashCompletion && this.#completion.open) {
      return { kind: "redraw" };
    }

    if (isSlashCompletion) {
      const text = this.expandedText().trim();
      this.#completion = CLOSED_COMPLETION;
      if (text.length > 0) {
        this.#pushHistory(text);
        this.#pasteChips = [];
      }
      return text.length > 0 ? { kind: "submit", text } : { kind: "redraw" };
    }
    return { kind: "redraw" };
  }

  #onNext(): ComposerEffect {
    if (!this.#completion.open) {
      const opened = computeCompletions(this.#text, this.#charOffset(), this.#sources);
      if (!opened.open) return { kind: "none" };
      this.#completion = opened;
      return { kind: "redraw" };
    }
    this.#completion = moveCompletion(this.#completion, 1);
    return { kind: "redraw" };
  }

  #onPrev(): ComposerEffect {
    if (!this.#completion.open) return { kind: "none" };
    this.#completion = moveCompletion(this.#completion, -1);
    return { kind: "redraw" };
  }

  #accept(): void {
    const previousText = this.#text;
    const previousMetrics = this.#metricsForText();
    const previousLength = previousMetrics.graphemes.length;
    const replacedFrom = this.#graphemeIndexForCharOffset(
      this.#completion.from,
      previousMetrics,
    );
    const replacedTo = this.#graphemeIndexForCharOffset(
      this.#completion.to,
      previousMetrics,
    );
    const result = acceptCompletion(
      this.#completion,
      previousText,
      this.#charOffset(),
      this.#sources,
    );

    // Completion replaces a range directly rather than going through #insert(). Keep
    // any later large-paste chips aligned so expandedText() still substitutes their
    // markers at the right offsets when a mention is accepted earlier in the buffer.
    const nextMetrics = {
      text: result.text,
      graphemes: graphemes(result.text),
    };
    const delta = nextMetrics.graphemes.length - previousLength;
    this.#pasteChips = this.#pasteChips
      .filter((chip) => chip.markerEnd <= replacedFrom || chip.markerStart >= replacedTo)
      .map((chip) =>
        chip.markerStart >= replacedTo
          ? { ...chip, markerStart: chip.markerStart + delta, markerEnd: chip.markerEnd + delta }
          : chip);

    this.#setText(result.text);
    this.#cursor = this.#graphemeIndexForCharOffset(result.cursor, this.#metricsForText());
    this.#completion = result.state;
    this.#completionDismissed = false;
  }

  #insert(value: string): ComposerEffect {
    const chip = this.#chipAtCursor() ?? this.#chipAfterCursor();
    if (chip !== undefined) this.#cursor = chip.markerEnd;
    const cursor = this.#cursor;
    const offset = this.#graphemeOffsetToCharOffset(cursor);
    const insertLen = graphemes(value).length;
    this.#setText(`${this.#text.slice(0, offset)}${value}${this.#text.slice(offset)}`);
    this.#cursor = cursor + insertLen;
    this.#preferredColumn = undefined;
    this.#shiftChips(cursor, insertLen);
    this.#recompute();
    return { kind: "redraw" };
  }

  #onBackspace(): ComposerEffect {
    if (this.#cursor === 0) return { kind: "none" };
    this.#preferredColumn = undefined;
    const before = this.#chipBeforeCursor();
    if (before !== undefined) {
      const charStart = this.#graphemeOffsetToCharOffset(before.markerStart);
      const charEnd = this.#graphemeOffsetToCharOffset(before.markerEnd);
      const len = before.markerEnd - before.markerStart;
      this.#setText(this.#text.slice(0, charStart) + this.#text.slice(charEnd));
      this.#pasteChips = this.#pasteChips.filter((c) => c.id !== before.id);
      this.#cursor = before.markerStart;
      this.#shiftChips(before.markerEnd, -len);
      this.#recompute();
      return { kind: "redraw" };
    }
    const at = this.#chipAtCursor();
    if (at !== undefined) {
      const charStart = this.#graphemeOffsetToCharOffset(at.markerStart);
      const charEnd = this.#graphemeOffsetToCharOffset(at.markerEnd);
      const len = at.markerEnd - at.markerStart;
      this.#setText(this.#text.slice(0, charStart) + this.#text.slice(charEnd));
      this.#pasteChips = this.#pasteChips.filter((c) => c.id !== at.id);
      this.#cursor = at.markerStart;
      this.#shiftChips(at.markerEnd, -len);
      this.#recompute();
      return { kind: "redraw" };
    }
    const metrics = this.#metricsForText();
    const charEnd = this.#graphemeOffsetToCharOffset(this.#cursor, metrics);
    const charStart = this.#graphemeOffsetToCharOffset(this.#cursor - 1, metrics);
    const previousCursor = this.#cursor;
    this.#setText(this.#text.slice(0, charStart) + this.#text.slice(charEnd));
    this.#cursor = previousCursor - 1;
    this.#shiftChips(previousCursor, -1);
    this.#recompute();
    return { kind: "redraw" };
  }

  /**
   * Recompute the popup for the current caret.
   *
   * Called after every edit, which is what makes the palette behave like a game
   * console: `/` alone lists everything, each character narrows it, and a space
   * after a command name advances to its arguments — all without a key dedicated to
   * opening it.
   */
  #recompute(force = false): void {
    this.#completionDismissed = false;
    const cursor = this.#charOffset();
    if (!force && this.#completionRevision === this.#textRevision) {
      const kind = completionKindAt(this.#text, cursor);
      const prefix = completionPrefix(this.#text, cursor);
      if (
        kind === this.#completion.kind &&
        prefix === this.#completion.query &&
        cursor >= this.#completion.from &&
        cursor <= this.#completion.to
      ) {
        this.#completionCursor = cursor;
        return;
      }
    }
    this.#completion = computeCompletions(this.#text, cursor, this.#sources);
    this.#completionRevision = this.#textRevision;
    this.#completionCursor = cursor;
  }

  /** Caret as a character offset, which is what the completion parser wants. */
  #charOffset(): number {
    return this.#graphemeOffsetToCharOffset(this.#cursor);
  }

  #graphemeCount(): number {
    return this.#metricsForText().graphemes.length;
  }
}

export { CTRL_C_EXIT_HINT, ESCAPE_CANCEL_HINT };
