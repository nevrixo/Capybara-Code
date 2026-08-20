/**
 * Keyboard ownership across a session — PRD §6.14, §6.15, §7.7, AC-20, AC-21.
 *
 * The composer and a running turn both want the keyboard, for different reasons: one
 * is editing text, the other is watching for an interruption. This class hands the
 * single key stream between them so there is never more than one reader on stdin —
 * two readers each see half the bytes, which turns an arrow key into a stray `Esc`
 * and cancels the turn the user was watching.
 *
 * When no key stream is available (a pipe, a CI log) the reader falls back to a
 * line-oriented `prompt` and leaves interruption to `SIGINT`. That degradation is
 * deliberate and visible: §19.3 requires the non-TTY path to work, and a completion
 * popup that cannot be navigated is worse than one that is absent.
 */

import type { SessionViewModel } from "@cbc/session-domain";
import type { CompletionSources, KeyBinding } from "@cbc/tui-components";

import { ComposerSession, type ComposerAttachment, type ComposerHostState } from "./composer.ts";
import { isMouseEvent, type InputEvent, type KeyStream } from "./keys.ts";
import type { InteractiveUi } from "./tui.ts";

/** The parts of the session the reader needs while a turn is running. */
export interface TurnHandle {
  readonly viewModel: SessionViewModel;
  /** §6.11: stop awaiting a subagent without cancelling it. */
  readonly interruptTaskWait?: (taskId: string) => boolean;
  readonly cancelTask?: (taskId: string, reason?: string) => Promise<void>;
  readonly cancelAllTasks?: (reason?: string) => Promise<void>;
}

export interface InputReaderOptions {
  readonly keys: KeyStream;
  readonly ui: InteractiveUi;
  readonly sources?: CompletionSources;
  readonly keymap?: readonly KeyBinding[];
  readonly now?: () => number;
  /**
   * P1-02: every composer effect gets a real side effect. `open_overlay` used
   * to be emitted into a `default:` that dropped it; the host now supplies the
   * handler that paints the overlay.
   */
  readonly onOpenOverlay?: (overlay: string) => void;
  readonly onCycleInteractionMode?: () => void | string | Promise<string | undefined>;
  readonly onPromptReady?: () => void | string | Promise<string | undefined>;
  /** The first live background task, if the prompt is otherwise idle. */
  readonly activeTaskId?: () => string | undefined;
  /** Cancel a background task selected by the Esc escalation. */
  readonly onCancelTask?: (taskId: string, reason?: string) => Promise<void>;
  readonly onRunningSlashCommand?: (text: string) => boolean;
}

export class InputReader {
  readonly #keys: KeyStream;
  readonly #ui: InteractiveUi;
  readonly #composer: ComposerSession;
  readonly #onOpenOverlay?: (overlay: string) => void;
  readonly #onCycleInteractionMode?: () => void | string | Promise<string | undefined>;
  readonly #onPromptReady?: () => void | string | Promise<string | undefined>;
  readonly #activeTaskId?: () => string | undefined;
  readonly #onCancelTask?: (taskId: string, reason?: string) => Promise<void>;
  readonly #onRunningSlashCommand?: (text: string) => boolean;
  #started = false;
  /**
   * Attachments staged by the most recent submit. Held here so the caller that
   * receives only the prompt text from `readPrompt()` can still pick them up
   * afterwards via {@link lastAttachments}.
   */
  #lastAttachments: readonly ComposerAttachment[] = [];
  /**
   * A prompt typed while a turn was running. Submitted as the next prompt when
   * the turn completes; restored to the editor when the turn is cancelled, so
   * the user does not lose what they wrote (P1-02).
   */
  #queuedMessage: string | undefined;
  /** Set when `Ctrl+C Ctrl+C` confirms a full interactive-program exit. */
  #exitRequested = false;
  /** Keep the composer from racing an async mode/Plan action after its picker closes. */
  #modeActionPending = false;

  constructor(options: InputReaderOptions) {
    this.#keys = options.keys;
    this.#ui = options.ui;
    if (options.onOpenOverlay !== undefined) this.#onOpenOverlay = options.onOpenOverlay;
    if (options.onCycleInteractionMode !== undefined) this.#onCycleInteractionMode = options.onCycleInteractionMode;
    if (options.onPromptReady !== undefined) this.#onPromptReady = options.onPromptReady;
    if (options.activeTaskId !== undefined) this.#activeTaskId = options.activeTaskId;
    if (options.onCancelTask !== undefined) this.#onCancelTask = options.onCancelTask;
    if (options.onRunningSlashCommand !== undefined) this.#onRunningSlashCommand = options.onRunningSlashCommand;
    this.#composer = new ComposerSession({
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
      ...(options.keymap !== undefined ? { keymap: options.keymap } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      eofExit: true,
    });
  }

  get interactive(): boolean {
    return this.#keys.active;
  }

  /**
   * Attachments staged by the most recent paste events.
   *
   * Returned by reference so a caller can read them between a submit and the
   * next `readPrompt()`. The list is cleared when the composer is cleared,
   * which happens as part of every submit.
   */
  get attachments(): readonly ComposerAttachment[] {
    return this.#composer.attachments;
  }

  /**
   * Attachments captured from the last submit, in insertion order.
   *
   * `readPrompt()` returns only the prompt text, so this is the channel for
   * the host to learn what was staged alongside it. P1-02 disabled paste
   * tokenization (pastes insert verbatim), so this list is empty today; it
   * stays wired for the future attachment pipeline. Reset to an empty list by
   * every submit and every exit.
   */
  get lastAttachments(): readonly ComposerAttachment[] {
    return this.#lastAttachments;
  }

  /** The prompt queued during the last turn, if any (P1-02). */
  takeQueuedMessage(): string | undefined {
    const queued = this.#queuedMessage;
    this.#queuedMessage = undefined;
    return queued;
  }

  #requestProgramExit(controller?: AbortController): void {
    this.#exitRequested = true;
    this.#lastAttachments = [];
    this.#queuedMessage = undefined;
    controller?.abort();
  }

  /** Consume a full-program exit requested while a turn was running. */
  takeExitRequested(): boolean {
    const requested = this.#exitRequested;
    this.#exitRequested = false;
    return requested;
  }

  /** Put a queued prompt back into the editor, e.g. after a cancelled turn. */
  restoreQueuedMessage(): boolean {
    if (this.#queuedMessage === undefined) return false;
    this.#composer.set(this.#queuedMessage);
    this.#queuedMessage = undefined;
    this.#draw();
    return true;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#exitRequested = false;
    this.#keys.start();
  }

  /** Refresh a completion source that finished loading in the background. */
  refreshCompletions(): void {
    this.#composer.refreshCompletions();
    if (
      this.#started &&
      (!this.#ui.overlayOpen || !this.#overlayCapturesInput()) &&
      !this.#ui.promptActive &&
      !this.#ui.approvalActive &&
      !this.#ui.userAskActive &&
      !this.#ui.planApprovalActive
    ) {
      this.#draw();
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#modeActionPending = false;
    this.#keys.setSink(undefined);
    this.#keys.stop();
  }

  /**
   * Temporarily release the terminal input stream to a line-oriented/native
   * prompt, then restore this reader even when that prompt fails.
   *
   * Interactive slash commands call this only between `readPrompt()` calls,
   * when no composer sink is pending. Keeping the handoff here makes raw-mode
   * ownership explicit and prevents the key decoder and a native picker from
   * observing the same bytes at once.
   */
  async withExternalInput<T>(action: () => Promise<T>): Promise<T> {
    const restart = this.#started;
    if (restart) this.stop();
    try {
      return await action();
    } finally {
      if (restart) this.start();
    }
  }

  #overlayCapturesInput(): boolean {
    return (this.#ui as unknown as { overlayCapturesInput?: boolean }).overlayCapturesInput === true;
  }

  /** Route overlay navigation while letting read-only documents keep the composer usable. */
  #routeOverlayKey(
    event: InputEvent,
    onPlanOverlayClosed?: () => void,
  ): boolean {
    // Completion is the innermost popup. When it is open, its Tab/Enter/arrow/Esc
    // bindings must win even if a document overlay remains visible underneath it.
    if (!this.#ui.overlayOpen || isMouseEvent(event) || this.#composer.completionOpen) return false;
    if (event.key === "ctrl+c" || (event.key === "text" && event.text === "\x03")) return false;
    const handled = (this.#ui as unknown as {
      handleOverlayKey?: (key: InputEvent) => boolean;
    }).handleOverlayKey?.(event);
    if (handled === true) return true;
    const quitKey =
      event.key === "q" ||
      (event.key === "text" && event.text?.toLowerCase() === "q");
    if (event.key === "escape" || quitKey) {
      const closed = this.#ui.closeOverlay();
      if (closed === "plan") onPlanOverlayClosed?.();
      return true;
    }
    if (
      event.key === "pageup" ||
      event.key === "pagedown" ||
      event.key === "up" ||
      event.key === "down"
    ) {
      this.#ui.scrollOverlay(
        event.key === "pageup" || event.key === "up" ? -3 : 3,
      );
      return true;
    }
    // Read-only document overlays are a lens over the session, not a second input
    // reader. Printable keys and composer actions continue below this router.
    return this.#overlayCapturesInput();
  }

  /**
   * Read one prompt.
   *
   * Resolves with the submitted text, or `undefined` when the user asked to leave —
   * which now takes two `Ctrl+C` presses (§6.15).
   */
  async readPrompt(): Promise<string | undefined> {
    if (!this.#keys.active) {
      // No key stream: one line, no popup, `Ctrl+C` surfaces as a rejected read.
      return await this.#ui.readPrompt();
    }

    return await new Promise<string | undefined>((resolve) => {
      const finish = (value: string | undefined): void => {
        this.#keys.setSink(undefined);
        this.#ui.eraseComposer();
        resolve(value);
      };

      const runPromptReadyAction = (): void => {
        if (
          this.#modeActionPending ||
          this.#ui.promptActive ||
          this.#ui.planApprovalActive ||
          this.#ui.approvalActive
        ) {
          return;
        }

        const automaticAction = this.#onPromptReady;
        if (automaticAction === undefined) return;
        let execution: void | string | Promise<string | undefined>;
        try {
          execution = automaticAction();
        } catch (error) {
          this.#ui.notice(
            `Prompt action failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.#draw();
          return;
        }
        if (execution === undefined) return;

        const finishExecution = (directive: string | undefined): void => {
          this.#modeActionPending = false;
          if (directive === undefined || directive.length === 0) {
            this.#draw();
            return;
          }
          this.#lastAttachments = [];
          this.#composer.clear();
          if (this.#ui.overlayOpen) this.#ui.closeOverlay();
          finish(directive);
        };
        const failExecution = (error: unknown): void => {
          this.#modeActionPending = false;
          this.#ui.notice(
            `Prompt action failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.#draw();
        };
        if (typeof (execution as Promise<string | undefined>).then === "function") {
          this.#modeActionPending = true;
          void (execution as Promise<string | undefined>).then(finishExecution, failExecution);
        } else {
          finishExecution(typeof execution === "string" ? execution : undefined);
        }
      };

      this.#keys.setSink((event: InputEvent) => {
        if (this.#ui.promptActive) {
          if (!isMouseEvent(event)) this.#ui.handlePromptKey(event);
          return;
        }
        if (this.#ui.userAskActive) {
          if (!isMouseEvent(event)) this.#ui.handleUserAskKey(event);
          return;
        }
        // P0-08: while a permission or Plan decision card is open it is the
        // single input owner. Never let the composer observe these keys.
        if (this.#ui.planApprovalActive) {
          if (!isMouseEvent(event)) this.#ui.handlePlanApprovalKey(event);
          return;
        }
        // The picker resolves before the async mode/runtime action completes.
        // Keep the same key stream owned by that action so a fast Enter cannot
        // submit a second prompt and later get its composer erased by finish().
        if (this.#modeActionPending) return;
        if (this.#ui.approvalActive) {
          if (!isMouseEvent(event)) this.#ui.handleApprovalKey(event);
          return;
        }
        if (isMouseEvent(event)) {
          if (this.#ui.overlayOpen && (event.button === 64 || event.button === 65)) {
            (this.#ui as unknown as { scrollOverlay?: (delta: number) => void }).scrollOverlay?.(event.button === 64 ? -3 : 3);
          } else {
            this.#ui.handleMouseEvent(event);
          }
          return;
        }
        if (this.#routeOverlayKey(event, runPromptReadyAction)) return;
        const scrolledUp = (this.#ui as unknown as { timelineScrollOffset?: number }).timelineScrollOffset !== undefined && ((this.#ui as unknown as { timelineScrollOffset: number }).timelineScrollOffset > 0);
        const activeTaskId = this.#activeTaskId?.();
        const host: ComposerHostState = {
          turnRunning: false,
          // A read-only document is a lens over the composer. Only capturing
          // overlays should change the composer's key resolution precedence.
          overlayOpen:
            this.#ui.overlayOpen &&
            this.#overlayCapturesInput(),
          ...(activeTaskId !== undefined ? { activeTaskId } : {}),
          ...(scrolledUp ? { scrolledUp: true } : {}),
        };
        const effect = this.#composer.handle(event, host);
        switch (effect.kind) {
          case "submit": {
            // The composer effect is already paste-expanded and trimmed. Reading
            // the live buffer again would reintroduce the separator space added by
            // an accepted @ mention.
            const text = effect.text;
            this.#lastAttachments = effect.attachments ?? [];
            this.#composer.clear();
            if (this.#ui.overlayOpen) this.#ui.closeOverlay();
            (this.#ui as unknown as { clearSelection?: () => void }).clearSelection?.();
            finish(text);
            return;
          }
          case "exit":
            this.#requestProgramExit();
            this.#composer.clear();
            (this.#ui as unknown as { clearSelection?: () => void }).clearSelection?.();
            finish(undefined);
            return;
          case "cancel_task":
            this.#cancelBackgroundTask(effect.taskId);
            return;
          case "notice":
            this.#ui.notice(effect.text);
            this.#draw();
            return;
          case "open_overlay":
            // P1-02: the effect maps to a real overlay instead of being dropped.
            this.#onOpenOverlay?.(effect.overlay);
            return;
          case "cycle_interaction_mode": {
            let execution: void | string | Promise<string | undefined>;
            try {
              execution = this.#onCycleInteractionMode?.();
            } catch (error) {
              this.#ui.notice(
                `Mode action failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              this.#draw();
              return;
            }
            const finishExecution = (directive: string | undefined): void => {
              this.#modeActionPending = false;
              if (directive === undefined || directive.length === 0) {
                this.#draw();
                return;
              }
              this.#lastAttachments = [];
              this.#composer.clear();
              if (this.#ui.overlayOpen) this.#ui.closeOverlay();
              finish(directive);
            };
            const failExecution = (error: unknown): void => {
              this.#modeActionPending = false;
              this.#ui.notice(
                `Mode action failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              this.#draw();
            };
            if (execution !== undefined && typeof (execution as Promise<string | undefined>).then === "function") {
              this.#modeActionPending = true;
              // A Plan execute action performs async runtime/mode work. Keep the
              // composer alive if that work rejects; without a rejection handler
              // the readPrompt promise stays pending while the sink silently
              // accepts ordinary keys after the picker has closed.
              void (execution as Promise<string | undefined>).then(finishExecution, failExecution);
            } else {
              finishExecution(typeof execution === "string" ? execution : undefined);
            }
            return;
          }
          case "toggle_sidebar": {
            const showing = this.#ui.toggleSidebar();
            this.#ui.notice(
              showing ? "Context sidebar shown." : "Context sidebar hidden.",
            );
            this.#draw();
            return;
          }
          case "toggle_accordion": {
            this.#ui.notice(this.#ui.toggleAccordion());
            return;
          }
          case "cycle_thinking":
            this.#ui.notice(this.#ui.cycleThinkingVisibility());
            this.#draw();
            return;
          case "redraw_screen":
            // Esc with an overlay open closes the overlay, not the composer.
            if (this.#ui.overlayOpen) {
              const closed = this.#ui.closeOverlay();
              if (closed === "plan") runPromptReadyAction();
              return;
            }
            this.#draw();
            return;
          case "redraw":
            this.#draw();
            return;
          case "scroll_page_up":
            this.#ui.scrollPageUp();
            return;
          case "scroll_page_down":
            this.#ui.scrollPageDown();
            return;
          case "scroll_up":
            this.#ui.scrollUp(3);
            return;
          case "scroll_down":
            this.#ui.scrollDown(3);
            return;
          default:
            return;
        }
      });

      this.#draw();

      runPromptReadyAction();
    });
  }

  /**
   * Run a turn with the keyboard watching for an interruption.
   *
   * `Esc Esc` aborts the controller; a single `Esc` arms the pair
   * and says so. §6.11's await interruption is reported to the session so the child
   * keeps running while the wait ends.
   */
  async duringTurn<T>(
    controller: AbortController,
    session: TurnHandle,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!this.#keys.active) return await run();

    this.#keys.setSink((event: InputEvent) => {
      if (this.#ui.promptActive) {
        if (!isMouseEvent(event)) this.#ui.handlePromptKey(event);
        return;
      }
      if (this.#ui.userAskActive) {
        if (!isMouseEvent(event)) this.#ui.handleUserAskKey(event);
        return;
      }
      // P0-08: while a permission or Plan decision card is open it is the
      // single input owner. Never let the composer observe these keys.
      if (this.#ui.planApprovalActive) {
        if (!isMouseEvent(event)) this.#ui.handlePlanApprovalKey(event);
        return;
      }
      if (this.#ui.approvalActive) {
        if (!isMouseEvent(event)) this.#ui.handleApprovalKey(event);
        return;
      }
      if (isMouseEvent(event)) {
        if (this.#ui.overlayOpen && (event.button === 64 || event.button === 65)) {
          (this.#ui as unknown as { scrollOverlay?: (delta: number) => void }).scrollOverlay?.(event.button === 64 ? -3 : 3);
        } else {
          this.#ui.handleMouseEvent(event);
        }
        return;
      }
      if (this.#routeOverlayKey(event)) return;
      const awaitingTaskId = session.viewModel.awaitingTaskId;
      const scrolledUp = (this.#ui as unknown as { timelineScrollOffset?: number }).timelineScrollOffset !== undefined && ((this.#ui as unknown as { timelineScrollOffset: number }).timelineScrollOffset > 0);
      const host: ComposerHostState = {
        turnRunning: true,
        overlayOpen:
          this.#ui.overlayOpen &&
          this.#overlayCapturesInput(),
        ...(awaitingTaskId !== undefined ? { awaitingTaskId } : {}),
        ...(scrolledUp ? { scrolledUp: true } : {}),
      };

      const effect = this.#composer.handle(event, host);
      switch (effect.kind) {
        case "submit": {
          const text = effect.text.trim();
          if (text.startsWith("/")) {
            this.#composer.clear();
            if (this.#ui.overlayOpen) this.#ui.closeOverlay();
            if (this.#onRunningSlashCommand?.(text) === true) {
              this.#draw();
              return;
            }
            this.#ui.notice("Commands cannot be used while running. Press Esc Esc to stop the turn first.");
            this.#draw();
            return;
          }
          this.#queuedMessage = effect.text;
          this.#composer.clear();
          if (this.#ui.overlayOpen) this.#ui.closeOverlay();
          this.#ui.notice("Queued — it will be sent when this turn ends.");
          this.#draw();
          return;
        }
        case "cancel_turn":
          this.#ui.notice("Stopping the current turn and its subagents...");
          this.#draw();
          const cancellation = session.cancelAllTasks?.("cancelled with Esc");
          if (cancellation !== undefined) {
            void cancellation.catch((error) => {
              this.#ui.notice(
                `Could not cancel subagents: ${error instanceof Error ? error.message : String(error)}`,
              );
              this.#draw();
            });
          }
          controller.abort();
          return;
        case "cancel_task":
          this.#cancelBackgroundTask(effect.taskId);
          return;
        case "exit":
          this.#requestProgramExit(controller);
          return;
        case "notice":
          this.#ui.notice(effect.text);
          this.#draw();
          return;
        case "interrupt_wait": {
          if (
            awaitingTaskId !== undefined &&
            session.interruptTaskWait?.(awaitingTaskId) === true
          ) {
            this.#ui.notice(
              "Await interrupted; this subagent continues. Open the task drawer to inspect it.",
            );
          } else {
            this.#ui.notice("That subagent wait has already ended.");
          }
          this.#draw();
          return;
        }
        case "open_overlay":
          this.#ui.notice("Overlays cannot be opened while running. Press Esc Esc to stop the turn first.");
          this.#draw();
          return;
        case "cycle_interaction_mode":
          this.#onCycleInteractionMode?.();
          this.#draw();
          return;
        case "offer_cancel":
          this.#ui.notice(
            `Press Esc again to stop the turn, or open the task drawer to inspect ${effect.taskId}.`,
          );
          this.#draw();
          return;
        case "toggle_sidebar": {
          const showing = this.#ui.toggleSidebar();
          this.#ui.notice(
            showing ? "Context sidebar shown." : "Context sidebar hidden.",
          );
          this.#draw();
          return;
        }
        case "toggle_accordion": {
          this.#ui.notice(this.#ui.toggleAccordion());
          return;
        }
        case "cycle_thinking":
          this.#ui.notice(this.#ui.cycleThinkingVisibility());
          this.#draw();
          return;
        case "redraw_screen":
          if (this.#ui.overlayOpen) {
            this.#ui.closeOverlay();
            return;
          }
          // Drafting while a turn is running is supported. Without this redraw
          // the state changes, but the terminal keeps showing the old frame.
          this.#draw();
          return;
        case "redraw":
          this.#draw();
          return;
        case "scroll_page_up":
          this.#ui.scrollPageUp();
          this.#draw();
          return;
        case "scroll_page_down":
          this.#ui.scrollPageDown();
          this.#draw();
          return;
        case "scroll_up":
          this.#ui.scrollUp(3);
          this.#draw();
          return;
        case "scroll_down":
          this.#ui.scrollDown(3);
          this.#draw();
          return;
        default:
          // Text typed during a turn is kept: drafting the next prompt is
          // allowed, and the buffer survives into the next read.
          return;
      }
    });

    // readPrompt() erases the submitted prompt before the turn starts. Paint
    // the fresh composer immediately so a long-running tool never leaves the
    // user staring at a blank bottom edge of the terminal.
    this.#draw();

    try {
      return await run();
    } finally {
      this.#keys.setSink(undefined);
      this.#draw();
    }
  }

  #cancelBackgroundTask(taskId: string): void {
    const cancel = this.#onCancelTask;
    if (cancel === undefined) {
      this.#ui.notice(`No cancellation handler is available for background task ${taskId}.`);
      this.#draw();
      return;
    }

    this.#ui.notice(`Cancelling background task ${taskId}...`);
    this.#draw();
    let pending: Promise<void>;
    try {
      pending = cancel(taskId, "cancelled with Esc");
    } catch (error) {
      this.#ui.notice(
        `Could not cancel background task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.#draw();
      return;
    }
    void pending.then(
      () => {
        this.#ui.notice(`Cancelled background task ${taskId}.`);
        this.#draw();
      },
      (error) => {
        this.#ui.notice(
          `Could not cancel background task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.#draw();
      },
    );
  }

  #draw(): void {
    this.#ui.drawComposer(
      {
        text: this.#composer.text,
        cursor: this.#composer.cursor,
        metrics: this.#composer.metrics,
      },
      this.#composer.completion,
    );
  }
}
