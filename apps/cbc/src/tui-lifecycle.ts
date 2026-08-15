/**
 * Terminal lifecycle — P1-02 split of the former `InteractiveUi` god class.
 *
 * The TerminalLifecycle half: process-level guards that restore the terminal
 * on every exit path (AC-40). Kept separate so the renderer can be exercised
 * in tests without touching global process handlers.
 */

import type { InteractiveUi } from "./tui.ts";

/**
 * Install exit handlers that restore the terminal.
 *
 * AC-40 lists four paths: normal exit, `Ctrl+C`, a worker crash, and a host error.
 * All four end in `process` emitting one of these events, so restoring here covers
 * them without every call site remembering to.
 */
export function installTerminalGuards(
  ui: Pick<InteractiveUi, "restore">,
  handlers: {
    readonly onInterrupt?: () => void;
    readonly onFatal?: (error: unknown) => void;
  } = {},
): () => void {
  const restore = (): void => ui.restore();

  const onExit = (): void => restore();
  const onSigint = (): void => {
    restore();
    handlers.onInterrupt?.();
  };
  const onSigterm = (): void => {
    restore();
    handlers.onInterrupt?.();
  };
  const onUncaught = (error: unknown): void => {
    restore();
    handlers.onFatal?.(error);
  };

  process.on("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  return () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  };
}

export function installResizeHandler(
  ui: { replan?: () => void; renderFrame?: (clearScreen?: boolean) => void },
  options: { debounceMs?: number } = {},
): () => void {
  const debounceMs = options.debounceMs ?? 16;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      ui.replan?.();
      ui.renderFrame?.(true);
    }, debounceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  const stdout = process.stdout as NodeJS.WriteStream & { on?: (ev: string, fn: () => void) => void; off?: (ev: string, fn: () => void) => void };
  if (typeof stdout.on === "function") stdout.on("resize", onResize);
  process.on("SIGWINCH", onResize);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    if (typeof stdout.off === "function") stdout.off("resize", onResize);
    process.off("SIGWINCH", onResize);
  };
}
