/**
 * Daemon-owned turn execution. Detach never cancels in-flight work.
 *
 * Tests inject an in-process executor. Production can spawn `capy session-worker`
 * as a child of the daemon so TUI exit does not kill the session.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface SessionTurnRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly clientId: string;
}

export interface SessionTurnResult {
  readonly turnId: string;
  readonly status: "completed" | "partial" | "failed" | "cancelled" | "running";
  readonly answer?: string;
  readonly report?: unknown;
}

export interface SessionExecutor {
  submit(request: SessionTurnRequest): Promise<SessionTurnResult>;
  cancel?(sessionId: string, turnId?: string): Promise<void>;
  request?(sessionId: string, method: string, params?: unknown): Promise<unknown>;
  close?(): Promise<void>;
}

export interface SessionWorkerHostOptions {
  readonly createExecutor?: (sessionId: string) => SessionExecutor;
  readonly spawnWorker?: (sessionId: string) => SessionExecutor;
  readonly now?: () => string;
}

export class SessionWorkerHost {
  readonly #options: SessionWorkerHostOptions;
  readonly #executors = new Map<string, SessionExecutor>();
  readonly #inflight = new Map<string, Promise<SessionTurnResult>>();

  constructor(options: SessionWorkerHostOptions = {}) {
    this.#options = options;
  }

  has(sessionId: string): boolean {
    return this.#executors.has(sessionId);
  }

  register(sessionId: string, executor: SessionExecutor): void {
    this.#executors.set(sessionId, executor);
  }

  ensure(sessionId: string): SessionExecutor {
    const existing = this.#executors.get(sessionId);
    if (existing !== undefined) return existing;
    const created = this.#options.createExecutor?.(sessionId)
      ?? this.#options.spawnWorker?.(sessionId)
      ?? new DeferredTurnExecutor();
    this.#executors.set(sessionId, created);
    return created;
  }

  async submit(request: SessionTurnRequest): Promise<SessionTurnResult> {
    const executor = this.ensure(request.sessionId);
    const pending = executor.submit(request);
    this.#inflight.set(request.turnId, pending);
    try {
      return await pending;
    } finally {
      this.#inflight.delete(request.turnId);
    }
  }

  inflight(turnId: string): Promise<SessionTurnResult> | undefined {
    return this.#inflight.get(turnId);
  }

  async cancel(sessionId: string, turnId?: string): Promise<void> {
    await this.#executors.get(sessionId)?.cancel?.(sessionId, turnId);
  }

  async request(sessionId: string, method: string, params?: unknown): Promise<unknown> {
    const executor = this.ensure(sessionId);
    if (executor.request === undefined) {
      throw new Error("session worker does not support " + method);
    }
    return await executor.request(sessionId, method, params);
  }

  async close(): Promise<void> {
    const closers = [...this.#executors.values()].map((executor) => executor.close?.());
    this.#executors.clear();
    this.#inflight.clear();
    await Promise.all(closers);
  }
}

/**
 * Completes after `delayMs` even if the client detaches. Used by tests and as
 * the default when no worker process is available.
 */
export class DeferredTurnExecutor implements SessionExecutor {
  readonly #delayMs: number;
  readonly #onSubmit?: (request: SessionTurnRequest) => void;

  constructor(options: { delayMs?: number; onSubmit?: (request: SessionTurnRequest) => void } = {}) {
    this.#delayMs = options.delayMs ?? 0;
    if (options.onSubmit !== undefined) this.#onSubmit = options.onSubmit;
  }

  async submit(request: SessionTurnRequest): Promise<SessionTurnResult> {
    this.#onSubmit?.(request);
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    return { turnId: request.turnId, status: "completed", answer: request.prompt };
  }
}

export function spawnStdioWorker(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): SessionExecutor {
  return createMultiplexedSessionWorker(command, args, env);
}

function createMultiplexedSessionWorker(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): SessionExecutor {
  let child: ChildProcess | undefined;
  let buffer = "";
  const pending = new Map<string, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }>();

  const rejectAll = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const ensureChild = (): ChildProcess => {
    if (child !== undefined) return child;
    child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line) as {
            id?: string;
            result?: unknown;
            error?: { message?: string };
          };
          if (typeof message.id !== "string") continue;
          const waiter = pending.get(message.id);
          if (waiter === undefined) continue;
          pending.delete(message.id);
          if (message.error !== undefined) {
            waiter.reject(new Error(message.error.message ?? "session worker request failed"));
          } else {
            waiter.resolve(message.result);
          }
        } catch {
          // A malformed worker line is isolated from other request ids.
        }
      }
    });
    child.once("error", rejectAll);
    child.once("exit", (code) => {
      rejectAll(new Error("session worker exited (" + String(code) + ")"));
      child = undefined;
    });
    return child;
  };
  const send = async (method: string, params: unknown, id: string): Promise<unknown> => {
    const process = ensureChild();
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    process.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return await response;
  };

  return {
    async submit(request) {
      return await send("turn.submit", {
        prompt: request.prompt,
        sessionId: request.sessionId,
        turnId: request.turnId,
      }, request.turnId) as SessionTurnResult;
    },
    async cancel(sessionId, turnId) {
      await send(
        "turn.cancel",
        { sessionId, ...(turnId === undefined ? {} : { turnId }) },
        "cancel_" + crypto.randomUUID().replaceAll("-", ""),
      );
    },
    async request(sessionId, method, params) {
      const body = typeof params === "object" && params !== null && !Array.isArray(params)
        ? { sessionId, ...(params as Record<string, unknown>) }
        : { sessionId, value: params };
      return await send(
        method,
        body,
        "request_" + crypto.randomUUID().replaceAll("-", ""),
      );
    },
    async close() {
      rejectAll(new Error("session worker closed"));
      child?.kill("SIGTERM");
      child = undefined;
    },
  };
}
