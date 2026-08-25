/**
 * Keymap — PRD §6.15, §7.7, P5, AC-20, AC-21.
 *
 * P5 ("safe interruption") is what makes this more than a lookup table: `Esc` and
 * `Ctrl+C` must do something the user can predict from the screen, and §7.7 gives
 * them *different* meanings depending on what is running.
 *
 * §6.11 draws the sharpest line. `Esc` stops waiting; the child keeps going. Only a
 * second `Esc` within a second offers to cancel it. Conflating the two is how work
 * gets thrown away by reflex.
 *
 * Destructive actions are behind a deliberate second `Esc` press:
 *
 * - `Esc Esc` stops the running turn. One `Esc` frees you from a wait, which is
 *   cheap and reversible; the second ends the work, which is not.
 * - `Ctrl+C Ctrl+C` exits the program. It never cancels a turn or clears a draft.
 *
 * Both arm-then-confirm pairs expire, so a press made minutes ago cannot make the
 * next one lethal.
 */

/** Named actions the host binds. */
export type KeyAction =
  | "submit"
  | "newline"
  | "interrupt_wait"
  | "close_overlay"
  | "close_completions"
  | "cancel_turn"
  | "clear_composer"
  | "confirm_exit"
  | "command_palette"
  | "model_picker"
  | "reasoning_picker"
  | "thinking_visibility"
  | "history_search"
  | "line_start"
  | "line_end"
  | "delete_forward"
  | "kill_to_end"
  | "kill_to_start"
  | "kill_word"
  | "yank"
  | "agents_drawer"
  | "diff_viewer"
  | "tasks_drawer"
  | "sessions_drawer"
  | "context_drawer"
  | "todo_drawer"
  | "memory_drawer"
  | "graph_drawer"
  | "worktree_drawer"
  | "plugins_drawer"
  | "cycle_interaction_mode"
  | "details_overlay"
  | "toggle_sidebar"
  | "toggle_accordion"
  | "redraw"
  | "clear_line"
  | "complete"
  | "completion_next"
  | "completion_prev"
  | "completion_accept"
  | "scroll_page_up"
  | "scroll_page_down"
  | "scroll_up"
  | "scroll_down"
  | "timeline_top"
  | "timeline_bottom"
  | "help";

export interface KeyBinding {
  readonly action: KeyAction;
  /** Canonical key name, e.g. `ctrl+p`. */
  readonly key: string;
  readonly description: string;
  /** When this binding applies. */
  readonly when: "always" | "running" | "idle" | "overlay" | "composer" | "completion";
}

/** §6.15's table, in its documented order. */
const LEGACY_KEYMAP: readonly KeyBinding[] = [
  { action: "submit", key: "enter", description: "send the prompt", when: "composer" },
  { action: "newline", key: "shift+enter", description: "insert a newline", when: "composer" },
  { action: "newline", key: "ctrl+j", description: "insert a newline", when: "composer" },
  {
    action: "interrupt_wait",
    key: "escape",
    // §6.11: this stops the *wait*, not the work.
    description: "stop waiting; a running subagent continues",
    when: "running",
  },
  { action: "close_overlay", key: "escape", description: "close the overlay", when: "overlay" },
  { action: "command_palette", key: "ctrl+p", description: "command palette", when: "always" },
  { action: "model_picker", key: "ctrl+m", description: "model completion", when: "always" },
  { action: "reasoning_picker", key: "ctrl+r", description: "effort picker", when: "always" },
  { action: "agents_drawer", key: "ctrl+a", description: "agents drawer", when: "always" },
  { action: "diff_viewer", key: "ctrl+d", description: "diff viewer", when: "always" },
  { action: "tasks_drawer", key: "ctrl+t", description: "tasks and jobs drawer", when: "always" },
  {
    action: "toggle_sidebar",
    key: "ctrl+b",
    // §6.21: the sidebar auto-hides below 90 columns; this is how it comes back.
    description: "show or hide the context sidebar",
    when: "always",
  },
  { action: "toggle_accordion", key: "ctrl+o", description: "expand/collapse details (Thinking / Tool calls)", when: "always" },
  { action: "redraw", key: "ctrl+l", description: "redraw the viewport", when: "always" },
  { action: "clear_line", key: "ctrl+u", description: "clear the composer line", when: "composer" },
  { action: "complete", key: "tab", description: "completion", when: "composer" },
  // The popup is operated with arrows and Tab only. Tab accepts the highlighted
  // row; the arrows move it, so Enter is never needed to choose a model or effort.
  {
    action: "completion_accept",
    key: "tab",
    description: "select the highlighted completion",
    when: "completion",
  },
  {
    action: "completion_accept",
    key: "enter",
    description: "select the highlighted completion",
    when: "completion",
  },
  { action: "completion_next", key: "down", description: "next completion", when: "completion" },
  { action: "completion_prev", key: "shift+tab", description: "previous completion", when: "completion" },
  { action: "completion_prev", key: "up", description: "previous completion", when: "completion" },
  {
    action: "close_completions",
    key: "escape",
    description: "close the completion popup",
    when: "completion",
  },
  { action: "scroll_page_up", key: "pageup", description: "scroll up", when: "always" },
  { action: "scroll_page_down", key: "pagedown", description: "scroll down", when: "always" },
  { action: "timeline_top", key: "g g", description: "jump to the top", when: "always" },
  { action: "timeline_bottom", key: "G", description: "jump to the bottom", when: "always" },
  { action: "help", key: "?", description: "contextual help", when: "always" },
];

/** Effective defaults: readline editing plus explicit overlay/leader shortcuts. */
export const DEFAULT_KEYMAP: readonly KeyBinding[] = [
  { action: "submit", key: "enter", description: "send the prompt", when: "composer" },
  { action: "newline", key: "shift+enter", description: "insert a newline", when: "composer" },
  { action: "newline", key: "ctrl+j", description: "insert a newline", when: "composer" },
  { action: "interrupt_wait", key: "escape", description: "stop waiting; subagent continues", when: "running" },
  { action: "close_overlay", key: "escape", description: "close the overlay", when: "overlay" },
  { action: "close_completions", key: "escape", description: "close completions", when: "completion" },
  { action: "delete_forward", key: "ctrl+d", description: "delete forward", when: "composer" },
  { action: "confirm_exit", key: "ctrl+c", description: "clear draft; exit when empty (press twice)", when: "always" },
  { action: "line_start", key: "ctrl+a", description: "move to logical line start", when: "composer" },
  { action: "line_end", key: "ctrl+e", description: "move to logical line end", when: "composer" },
  { action: "history_search", key: "ctrl+r", description: "reverse history search", when: "composer" },
  { action: "kill_to_end", key: "ctrl+k", description: "kill to line end", when: "composer" },
  { action: "kill_to_start", key: "ctrl+u", description: "kill to line start", when: "composer" },
  { action: "kill_word", key: "ctrl+w", description: "kill previous word", when: "composer" },
  { action: "yank", key: "ctrl+y", description: "yank killed text", when: "composer" },
  { action: "details_overlay", key: "ctrl+o", description: "transcript details", when: "always" },
  { action: "tasks_drawer", key: "ctrl+t", description: "tasks and jobs", when: "always" },
  { action: "toggle_sidebar", key: "ctrl+b", description: "active-work background rail", when: "always" },
  { action: "model_picker", key: "alt+p", description: "model picker", when: "always" },
  { action: "thinking_visibility", key: "alt+t", description: "cycle Thinking mode", when: "always" },
  { action: "command_palette", key: "ctrl+p", description: "command palette", when: "always" },
  { action: "agents_drawer", key: "ctrl+x a", description: "agents drawer", when: "always" },
  { action: "tasks_drawer", key: "ctrl+x t", description: "tasks and jobs", when: "always" },
  { action: "diff_viewer", key: "ctrl+x d", description: "diff viewer", when: "always" },
  { action: "sessions_drawer", key: "ctrl+x l", description: "sessions", when: "always" },
  { action: "context_drawer", key: "ctrl+x c", description: "context", when: "always" },
  { action: "todo_drawer", key: "ctrl+x p", description: "TODO list", when: "always" },
  { action: "memory_drawer", key: "ctrl+x y", description: "durable memory", when: "always" },
  { action: "graph_drawer", key: "ctrl+x g", description: "agent graph", when: "always" },
  { action: "worktree_drawer", key: "ctrl+x w", description: "worktrees", when: "always" },
  { action: "plugins_drawer", key: "ctrl+x u", description: "plugins", when: "always" },
  { action: "model_picker", key: "ctrl+x m", description: "model picker", when: "always" },
  { action: "help", key: "ctrl+x h", description: "help", when: "always" },
  { action: "redraw", key: "ctrl+l", description: "redraw the viewport", when: "always" },
  { action: "complete", key: "tab", description: "completion", when: "composer" },
  { action: "completion_accept", key: "tab", description: "accept completion", when: "completion" },
  { action: "completion_accept", key: "enter", description: "accept completion", when: "completion" },
  { action: "cycle_interaction_mode", key: "shift+tab", description: "switch Build / Plan mode", when: "composer" },
  { action: "completion_next", key: "down", description: "next completion", when: "completion" },
  { action: "completion_prev", key: "shift+tab", description: "previous completion", when: "completion" },
  { action: "completion_prev", key: "up", description: "previous completion", when: "completion" },
  { action: "scroll_page_up", key: "pageup", description: "scroll up", when: "always" },
  { action: "scroll_page_down", key: "pagedown", description: "scroll down", when: "always" },
  { action: "scroll_up", key: "shift+up", description: "scroll timeline up", when: "always" },
  { action: "scroll_down", key: "shift+down", description: "scroll timeline down", when: "always" },
  { action: "scroll_up", key: "ctrl+up", description: "scroll timeline up", when: "always" },
  { action: "scroll_down", key: "ctrl+down", description: "scroll timeline down", when: "always" },
  { action: "scroll_up", key: "alt+up", description: "scroll timeline up", when: "always" },
  { action: "scroll_down", key: "alt+down", description: "scroll timeline down", when: "always" },
  { action: "help", key: "?", description: "contextual help when composer is empty", when: "idle" },
];

/** Interaction context, deciding which binding wins for a shared key. */
export interface KeyContext {
  readonly running: boolean;
  readonly overlayOpen: boolean;
  readonly composerHasText: boolean;
  /** True when a subagent is being awaited, so `Esc` means "stop waiting". */
  readonly awaitingTask: boolean;
  /** True while the §6.14 completion popup is showing candidates. */
  readonly completionOpen?: boolean;
}

/**
 * Resolve a key press.
 *
 * Precedence: the completion popup first, then an open overlay, then a running
 * turn, then the composer, then idle. That order is what makes the mapping
 * predictable — the most recently opened thing is what a key acts on, and the popup
 * is the innermost of them.
 */
export function resolveKey(
  key: string,
  context: KeyContext,
  keymap: readonly KeyBinding[] = DEFAULT_KEYMAP,
): KeyBinding | undefined {
  const normalized = normalizeKey(key);
  const candidates = keymap.filter((binding) => normalizeKey(binding.key) === normalized);
  if (candidates.length === 0) return undefined;

  const pick = (when: KeyBinding["when"]): KeyBinding | undefined =>
    candidates.find((binding) => binding.when === when);

  if (context.completionOpen === true) {
    const completion = pick("completion");
    if (completion !== undefined) return completion;
  }
  const eligible = candidates.filter((binding) => binding.when !== "completion");
  return resolveAmong(eligible, context);
}

function resolveAmong(
  candidates: readonly KeyBinding[],
  context: KeyContext,
): KeyBinding | undefined {
  const pick = (when: KeyBinding["when"]): KeyBinding | undefined =>
    candidates.find((binding) => binding.when === when);

  if (context.overlayOpen) {
    const overlay = pick("overlay");
    if (overlay !== undefined) return overlay;
    return undefined;
  }
  if (context.running) {
    const running = pick("running");
    if (running !== undefined) return running;
  }
  if (context.composerHasText) {
    const composer = pick("composer");
    if (composer !== undefined) return composer;
  }
  const idle = pick("idle");
  if (idle !== undefined) return idle;
  const composer = pick("composer");
  if (composer !== undefined) return composer;
  return pick("always");
}

export function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^ctrl\+/, "ctrl+")
    .replace(/^esc$/, "escape");
}

/** §6.11's double-`Esc` window before a subagent cancel is offered. */
export const DOUBLE_ESCAPE_WINDOW_MS = 1_000;

/**
 * How long a first `Esc` keeps the turn armed for cancellation.
 *
 * Longer than §6.11's task window because the two presses mean different things.
 * §6.11's second press *offers* a cancel — a prompt, so a tight window costs the
 * user only a re-press. This one *ends the turn*, so the user is given time to
 * read the hint and decide rather than being raced.
 */
export const TURN_CANCEL_WINDOW_MS = 2_000;

/** The scope a turn-level `Esc` is recorded under. */
export const ESCAPE_SCOPE_TURN = "turn";

/** Shown after the first `Esc` while a turn is running. */
export const ESCAPE_CANCEL_HINT = "Press Esc again to stop this turn.";

export interface EscapePress {
  /**
   * What the previous press acted on: an awaited task's id, or
   * `ESCAPE_SCOPE_TURN`. Scoping the press is what stops an `Esc` aimed at one
   * thing from escalating an unrelated one.
   */
  readonly scope: string;
  readonly atMs: number;
}

export type EscapeOutcome =
  | { readonly kind: "close_completions" }
  | { readonly kind: "close_overlay" }
  | { readonly kind: "interrupt_wait" }
  | { readonly kind: "offer_cancel"; readonly taskId: string }
  | { readonly kind: "arm_cancel_task"; readonly taskId: string }
  | { readonly kind: "cancel_task"; readonly taskId: string }
  /** First press with a turn running: warn, and remember it. */
  | { readonly kind: "arm_cancel_turn" }
  /** Second press inside the window: end the turn. */
  | { readonly kind: "cancel_turn" }
  | { readonly kind: "ignored" };

/**
 * Decide what `Esc` does.
 *
 * The ladder, innermost first: close the completion popup, close an overlay, stop
 * waiting on a subagent, then stop the turn. Each rung is cheaper to undo than the
 * one below it, so a reflexive `Esc` never reaches for the expensive option.
 *
 * §6.11: the first press stops the wait; a second press on the same task inside the
 * window offers cancellation. `scope` is part of the decision so pressing `Esc`
 * while awaiting one task and then another does not escalate the second to a cancel.
 *
 * Once the wait has been stopped the host clears `awaitingTaskId`, so a second
 * `Esc` naturally falls through to the turn — `Esc Esc` frees you from the wait and
 * then ends the work, which is what the keystroke pair is for.
 *
 * At an idle composer, `Esc` does not exit the session. Program exit is reserved
 * for the separate `Ctrl+C Ctrl+C` gesture.
 */
export function resolveEscape(input: {
  overlayOpen: boolean;
  completionOpen?: boolean;
  /** True while a turn is in flight, so `Esc Esc` can end it. */
  turnRunning?: boolean;
  awaitingTaskId?: string;
  /** A live background task at an otherwise idle prompt. */
  activeTaskId?: string;
  lastEscape?: EscapePress;
  nowMs: number;
}): EscapeOutcome {
  if (input.completionOpen === true) return { kind: "close_completions" };
  if (input.overlayOpen) return { kind: "close_overlay" };

  const previous = input.lastEscape;
  const repeatWithin = (scope: string, windowMs: number): boolean =>
    previous !== undefined &&
    previous.scope === scope &&
    input.nowMs - previous.atMs <= windowMs;

  const taskId = input.awaitingTaskId;
  if (taskId !== undefined) {
    if (repeatWithin(taskId, DOUBLE_ESCAPE_WINDOW_MS)) {
      if (input.turnRunning === true) return { kind: "cancel_turn" };
      return { kind: "offer_cancel", taskId };
    }
    return { kind: "interrupt_wait" };
  }

  const activeTaskId = input.activeTaskId;
  if (activeTaskId !== undefined) {
    if (repeatWithin(activeTaskId, DOUBLE_ESCAPE_WINDOW_MS)) {
      return { kind: "cancel_task", taskId: activeTaskId };
    }
    return { kind: "arm_cancel_task", taskId: activeTaskId };
  }

  if (input.turnRunning === true) {
    const followsInterruptedWait =
      previous !== undefined &&
      previous.scope !== ESCAPE_SCOPE_TURN &&
      input.nowMs - previous.atMs <= DOUBLE_ESCAPE_WINDOW_MS;
    if (repeatWithin(ESCAPE_SCOPE_TURN, TURN_CANCEL_WINDOW_MS) || followsInterruptedWait) {
      return { kind: "cancel_turn" };
    }
    return { kind: "arm_cancel_turn" };
  }

  return { kind: "ignored" };
}

/**
 * The scope an outcome should be recorded under, for the next press.
 *
 * Returned rather than left to the host so the two halves of the escalation cannot
 * disagree about what was armed.
 */
export function escapeScopeFor(outcome: EscapeOutcome, awaitingTaskId?: string): string | undefined {
  switch (outcome.kind) {
    case "interrupt_wait":
    case "arm_cancel_task":
      return awaitingTaskId;
    case "arm_cancel_turn":
      return ESCAPE_SCOPE_TURN;
    default:
      // A completed escalation, or an action with nothing to escalate to, clears
      // the armed state instead of leaving it primed.
      return undefined;
  }
}

/** How long a first `Ctrl+C` keeps the session armed to exit. */
export const CTRL_C_EXIT_WINDOW_MS = 3_000;

/** Shown after the first `Ctrl+C`, before the program exits. */
export const CTRL_C_EXIT_HINT = "Press Ctrl+C again to exit.";

export type CtrlCOutcome =
  /** A draft is present, so one press clears it without arming exit. */
  | { readonly kind: "clear_composer" }
  /** First empty-composer press: warn, and remember it. */
  | { readonly kind: "confirm_exit" }
  /** Second press inside the window: exit the program. */
  | { readonly kind: "exit" };

/**
 * `Ctrl+C` clears a draft first. Once the composer is empty, a first press arms
 * exit and a second press confirms it. This keeps an accidental Ctrl+C from
 * discarding the whole session while the user is editing a prompt.
 */
export function resolveCtrlC(input: {
  running: boolean;
  composerHasText: boolean;
  lastCtrlC?: number;
  nowMs?: number;
}): CtrlCOutcome {
  if (input.composerHasText) return { kind: "clear_composer" };
  const previous = input.lastCtrlC;
  const now = input.nowMs ?? 0;
  if (previous !== undefined && now - previous <= CTRL_C_EXIT_WINDOW_MS) {
    return { kind: "exit" };
  }
  return { kind: "confirm_exit" };
}

/**
 * Apply user remappings from `[keymap]` in config (§6.15, §21.4).
 *
 * An unknown action is reported rather than dropped: a typo in a config file should
 * say so, not silently do nothing.
 */
export function applyRemapping(
  base: readonly KeyBinding[],
  overrides: Readonly<Record<string, string>>,
): { keymap: KeyBinding[]; issues: string[] } {
  const issues: string[] = [];
  const known = new Set(base.map((binding) => binding.action));
  let keymap = [...base];

  for (const [action, key] of Object.entries(overrides)) {
    if (!known.has(action as KeyAction)) {
      issues.push(`'${action}' is not a known key action`);
      continue;
    }
    const existing = keymap.find((binding) => binding.action === action);
    if (existing === undefined) continue;
    keymap = keymap.filter((binding) => binding.action !== action);
    keymap.push({ ...existing, key: normalizeKey(key) });
  }

  return { keymap, issues };
}

/** Render §6.15 as the help overlay body. */
export function renderKeymapHelp(keymap: readonly KeyBinding[] = DEFAULT_KEYMAP): string[] {
  const width = keymap.reduce((max, binding) => Math.max(max, binding.key.length), 0);
  return keymap.map(
    (binding) =>
      `  ${binding.key.padEnd(width)}  ${binding.description}${
        binding.when === "always" ? "" : ` (${binding.when})`
      }`,
  );
}
