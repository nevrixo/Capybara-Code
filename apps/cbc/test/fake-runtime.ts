/**
 * An in-process fake of the `cbc-runtime` sidecar.
 *
 * Speaks the real length-prefixed JSON-RPC protocol, so `RuntimeClient` and the
 * `Runtime` facade are exercised exactly as in production — the only thing faked is
 * the handler table. That makes it cheap to characterize new RPC surface without a
 * compiled binary, and it keeps the spawner seam (`RuntimeOptions.spawner`) honest.
 */

import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type RuntimeProcess,
  type RuntimeSpawner,
} from "@cbc/protocol";

export interface FakeRuntimeRequest {
  readonly method: string;
  readonly params: unknown;
}

export interface FakeRuntimeOptions {
  /** Answer one request. Return the result, or throw to produce an RPC error. */
  readonly handler?: (request: FakeRuntimeRequest) => unknown;
}

export interface FakeRuntime {
  readonly spawner: RuntimeSpawner;
  /** Every request the fake has received, in order. */
  readonly requests: FakeRuntimeRequest[];
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const requests: FakeRuntimeRequest[] = [];
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const decoder = new FrameDecoder();

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });

  const respond = (id: number, result: unknown, error?: { code: number; message: string }) => {
    const body =
      error !== undefined
        ? { jsonrpc: "2.0", id, error }
        : { jsonrpc: "2.0", id, result };
    stdoutController?.enqueue(encodeFrame(JSON.stringify(body)));
  };

  let alive = true;
  const exit = () => {
    if (!alive) return;
    alive = false;
    // A real sidecar exits on shutdown/kill and its stdout closes, which is what
    // the client's read loop waits on.
    try {
      stdoutController?.close();
    } catch {
      /* already closed */
    }
  };

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      decoder.push(chunk);
      for (const payload of decoder.drain()) {
        const message = JSON.parse(payload) as {
          id?: number;
          method?: string;
          params?: unknown;
        };
        if (message.method === undefined || message.id === undefined) continue;
        const request: FakeRuntimeRequest = {
          method: message.method,
          params: message.params ?? null,
        };
        requests.push(request);
        try {
          const result =
            message.method === "runtime.initialize"
              ? initializeResult()
              : message.method === "runtime.shutdown"
                ? { ok: true }
                : (options.handler?.(request) ?? null);
          respond(message.id, result);
        } catch (error) {
          const code = (error as { code?: number }).code ?? -32603;
          const text = error instanceof Error ? error.message : String(error);
          respond(message.id, undefined, { code, message: text });
        }
        if (message.method === "runtime.shutdown") exit();
      }
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  const spawner: RuntimeSpawner = () =>
    ({
      stdin,
      stdout,
      stderr,
      exited: new Promise<number>(() => undefined),
      kill: () => exit(),
    }) satisfies RuntimeProcess as RuntimeProcess;

  return { spawner, requests };
}

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: "0.0.0-fake",
    workspaceId: "ws_fake",
    capabilities: {
      enhancedSandbox: false,
      keychain: "memory",
      pty: true,
      git: false,
      sandboxLevel: "standard",
      sandboxBackends: [],
      networkDeny: true,
      platform: "linux",
      arch: "x86_64",
      maxFrameBytes: 8 * 1024 * 1024,
      artifactStore: true,
      eventJournal: true,
    },
  };
}
