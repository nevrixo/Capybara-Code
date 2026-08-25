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
  let child: ChildProcess | undefined;
  return {
    async submit(request) {
      if (child === undefined) {
        child = spawn(command, [...args], {
          stdio: ["pipe", "pipe", "inherit"],
          env,
        });
      }
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: request.turnId,
        method: "turn.submit",
        params: { prompt: request.prompt, sessionId: request.sessionId, turnId: request.turnId },
      }) + "\n";
      child.stdin?.write(payload);
      return await readWorkerResult(child, request.turnId);
    },
    async close() {
      child?.kill("SIGTERM");
      child = undefined;
    },
  };
}

function readWorkerResult(child: ChildProcess, turnId: string): Promise<SessionTurnResult> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line) as { id?: string; result?: SessionTurnResult };
          if (message.id === turnId && message.result !== undefined) {
            child.stdout?.off("data", onData);
            resolve(message.result);
            return;
          }
        } catch {
          // ignore partial frames
        }
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`session worker exited (${String(code)})`));
    });
  });
}
