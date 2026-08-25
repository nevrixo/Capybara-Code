/**
 * `RuntimeClient` — the TypeScript half of the trust boundary (PRD §19.1,
 * §19.7, §20.1–§20.5).
 *
 * §19.2: the sidecar is launched from an absolute, verified path; `PATH` is never
 * searched for a binary named `cbc-runtime`.
 */

import {
  FrameDecoder,
  HEARTBEAT,
  LIMITS,
  PROTOCOL_VERSION,
  RuntimeRpcError,
  type FingerprintRequest,
  type FingerprintResponse,
  type MemoryForgetRequest,
  type MemoryListResponse,
  type MemoryRecordResponse,
  type MemoryRememberProposal,
  type MemoryRememberResponse,
  type MemoryResolveContestRequest,
  type MemorySearchRequest,
  type MemorySearchResponse,
  type MemoryVerifyResponse,
  type ReadManyRequest,
  type ReadManyResponse,
  type ReadRequest,
  type ReadResponse,
  encodeFrame,
  isKnownNotificationMethod,
  isProtocolCompatible,
  jsonDepth,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type NotificationMethod,
  type RequestMethod,
} from "./rpc.ts";

export interface CapabilityReceipt {
  readonly id: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly actionHash: string;
  readonly workspaceId: string;
  readonly operation: string;
  readonly resources: string[];
  readonly executableIdentity?: string;
  readonly program?: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly network: "deny" | "ask" | "allow";
  readonly expiresAtMs: number;
  readonly singleUse: true;
}

export interface RuntimeCapabilities {
  enhancedSandbox: boolean;
  keychain: string;
  pty: boolean;
  git: boolean;
  sandboxLevel: string;
  sandboxBackends: string[];
  networkDeny: boolean;
  platform: string;
  arch: string;
  maxFrameBytes: number;
  artifactStore: boolean;
  eventJournal: boolean;
}

export interface InitializeResult {
  protocolVersion: string;
  runtimeVersion: string;
  workspaceId: string;
  capabilities: RuntimeCapabilities;
}

export type NotificationHandler = (method: NotificationMethod | string, params: unknown) => void;

export type RuntimeHealth = "starting" | "ready" | "degraded" | "fatal" | "stopped";

export interface RuntimeClientOptions {
  /** Absolute path to the verified `cbc-runtime` binary. */
  readonly runtimeBinary: string;
  readonly workspace: string;
  readonly clientVersion: string;
  readonly dataDir?: string;
  readonly pty?: boolean;
  /**
   * Requested sandbox level (`sandbox.level`). The runtime clamps it to what
   * the host can enforce and reports the effective level back (P0-04, RT-006).
   */
  readonly sandboxLevel?: "none" | "workspace" | "standard" | "strict";
  /** `sandbox.networkForShell`: deny | ask | allow. */
  readonly networkForShell?: "deny" | "ask" | "allow";
  readonly interactionMode?: "build" | "plan";
  readonly capabilityIssuerToken?: string;
  readonly requestTimeoutMs?: number;
  readonly onNotification?: NotificationHandler;
  readonly onHealthChange?: (health: RuntimeHealth, detail?: string) => void;
  readonly onStderr?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: RequestMethod;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Minimal shape of the spawned child we depend on, so it can be faked in tests. */
export interface RuntimeProcess {
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export type RuntimeSpawner = (binary: string) => RuntimeProcess;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class RuntimeClient {
  #process: RuntimeProcess | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #decoder = new FrameDecoder();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #health: RuntimeHealth = "starting";
  #lastHeartbeat = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #initializeResult: InitializeResult | undefined;
  #readLoop: Promise<void> | undefined;
  readonly #capabilityIssuerToken: string;
  readonly #options: RuntimeClientOptions;
  readonly #spawn: RuntimeSpawner;

  constructor(options: RuntimeClientOptions, spawner?: RuntimeSpawner) {
    this.#options = options;
    this.#capabilityIssuerToken = options.capabilityIssuerToken ?? `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.#spawn = spawner ?? defaultSpawner;
  }

  get health(): RuntimeHealth {
    return this.#health;
  }

  get capabilities(): RuntimeCapabilities | undefined {
    return this.#initializeResult?.capabilities;
  }

  get workspaceId(): string | undefined {
    return this.#initializeResult?.workspaceId;
  }

  get runtimeVersion(): string | undefined {
    return this.#initializeResult?.runtimeVersion;
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  /** Spawn the sidecar and perform the §20.2 handshake. */
  async start(): Promise<InitializeResult> {
    const child = this.#spawn(this.#options.runtimeBinary);
    this.#process = child;
    if (!child.stdin || !child.stdout) {
      throw new Error("runtime process has no stdio pipes");
    }
    this.#writer = child.stdin.getWriter();
    this.#readLoop = this.#consumeStdout(child.stdout);
    if (child.stderr) void this.#consumeStderr(child.stderr);

    const params: Record<string, unknown> = {
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: this.#options.clientVersion,
      workspace: this.#options.workspace,
      capabilities: {
        pty: this.#options.pty ?? true,
        eventJournal: true,
        credentialLease: true,
        artifactHandles: true,
      },
    };
    if (this.#options.dataDir !== undefined) params.dataDir = this.#options.dataDir;
    if (this.#options.sandboxLevel !== undefined) {
      params.sandboxLevel = this.#options.sandboxLevel;
    }
    if (this.#options.networkForShell !== undefined) {
      params.networkForShell = this.#options.networkForShell;
    }
    if (this.#options.interactionMode !== undefined) {
      params.interactionMode = this.#options.interactionMode;
    }
    params.capabilityIssuerToken = this.#capabilityIssuerToken;

    const result = (await this.request("runtime.initialize", params)) as InitializeResult;

    // §19.12: refuse to run against an incompatible major protocol version.
    if (!isProtocolCompatible(PROTOCOL_VERSION, result.protocolVersion)) {
      await this.stop();
      throw new Error(
        `runtime protocol ${result.protocolVersion} is incompatible with client protocol ${PROTOCOL_VERSION}`,
      );
    }

    this.#initializeResult = result;
    this.#lastHeartbeat = Date.now();
    this.#setHealth("ready");
    this.#startHeartbeatWatch();
    return result;
  }

  /**
   * Send a request and await its response.
   *
   * P0-04: with an `AbortSignal`, aborting the caller sends `runtime.cancel` for
   * this request's id, so a foreground `process.run` is torn down on the runtime
   * side instead of running to completion while the client has moved on.
   */
  async issueCapability(params: {
    readonly sessionId: string;
    readonly callId: string;
    readonly actionHash: string;
    readonly operation: string;
    readonly resources?: readonly string[];
    readonly program?: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly network?: "deny" | "ask" | "allow";
    readonly ttlMs?: number;
  }): Promise<CapabilityReceipt> {
    return (await this.request("runtime.capability.issue", {
      issuerToken: this.#capabilityIssuerToken,
      ...params,
      ...(params.resources !== undefined ? { resources: [...params.resources] } : {}),
      ...(params.args !== undefined ? { args: [...params.args] } : {}),
    })) as CapabilityReceipt;
  }

  async request(
    method: RequestMethod,
    params?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (!this.#writer) throw new Error("runtime client is not started");
    if (this.#pending.size >= LIMITS.maxOutstandingRequests) {
      throw new Error(
        `outstanding request limit of ${LIMITS.maxOutstandingRequests} reached`,
      );
    }
    if (params !== undefined && jsonDepth(params) > LIMITS.maxJsonDepth) {
      throw new Error(`request params exceed the ${LIMITS.maxJsonDepth} depth limit`);
    }
    const signal = options.signal;
    if (signal?.aborted) throw new Error(`runtime request '${method}' was cancelled`);

    const id = this.#nextId++;
    const payload = JSON.stringify(
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params },
    );
    const frame = encodeFrame(payload);

    const timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return await new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`runtime request '${method}' timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : undefined;
      const onAbort = () => {
        // Ask the runtime to cancel the in-flight work; the response (cancelled or
        // already finished) still resolves through the normal path. The cancel RPC
        // itself must not be cancellable, or this could recurse.
        const cancelPayload = JSON.stringify({
          jsonrpc: "2.0",
          id: this.#nextId++,
          method: "runtime.cancel",
          params: { requestId: String(id) },
        });
        void this.#writer?.write(encodeFrame(cancelPayload)).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const wrappedResolve = (value: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      this.#pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, method, timer });
      void this.#writer!.write(frame).catch((error: unknown) => {
        this.#pending.delete(id);
        if (timer) clearTimeout(timer);
        wrappedReject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Read one range through the runtime's trusted filesystem boundary. */
  async read(params: ReadRequest & Record<string, unknown>): Promise<ReadResponse> {
    return (await this.request("fs.read", params)) as ReadResponse;
  }

  /** Read legacy paths or v2 per-item ranges with aggregate budgets. */
  async readMany(params: ReadManyRequest & Record<string, unknown>): Promise<ReadManyResponse> {
    const payload = params.items === undefined
      ? params
      : {
          ...params,
          items: params.items.map((item) => ({ ...item })),
          // Older sidecars ignore `items` and still need the legacy paths key.
          paths: params.paths ?? params.items.map((item) => item.path),
        };
    return (await this.request("fs.read_many", payload)) as ReadManyResponse;
  }

  /** Obtain a lightweight revision token, optionally with a full checksum. */
  async fingerprint(
    params: FingerprintRequest & Record<string, unknown>,
  ): Promise<FingerprintResponse> {
    return (await this.request("fs.fingerprint", params)) as FingerprintResponse;
  }

  async searchMemory(params: MemorySearchRequest = {}): Promise<MemorySearchResponse> {
    return (await this.request("memory.search", { ...params })) as MemorySearchResponse;
  }

  async rememberMemory(proposal: MemoryRememberProposal): Promise<MemoryRememberResponse> {
    return (await this.request("memory.remember", { ...proposal })) as MemoryRememberResponse;
  }

  async listMemory(params: MemorySearchRequest = {}): Promise<MemoryListResponse> {
    return (await this.request("memory.list", { ...params })) as MemoryListResponse;
  }

  async getMemory(id: string): Promise<MemoryRecordResponse> {
    return (await this.request("memory.get", { id })) as MemoryRecordResponse;
  }

  async forgetMemory(params: MemoryForgetRequest): Promise<MemoryRecordResponse> {
    return (await this.request("memory.forget", { ...params })) as MemoryRecordResponse;
  }

  async resolveMemoryContest(params: MemoryResolveContestRequest): Promise<MemoryRecordResponse> {
    return (await this.request("memory.resolve_contest", {
      ...params,
      loserIds: [...params.loserIds],
    })) as MemoryRecordResponse;
  }

  async verifyMemory(id: string): Promise<MemoryVerifyResponse> {
    return (await this.request("memory.verify", { id })) as MemoryVerifyResponse;
  }

  /** Graceful shutdown: ask the runtime to stop, then close the pipes. */
  async stop(): Promise<void> {
    this.#stopHeartbeatWatch();
    if (this.#writer) {
      try {
        await this.request("runtime.shutdown", {});
      } catch {
        // The runtime may already be gone; proceed to close regardless.
      }
      try {
        await this.#writer.close();
      } catch {
        /* already closed */
      }
      this.#writer = undefined;
    }
    for (const [id, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("runtime client stopped"));
      this.#pending.delete(id);
    }
    if (this.#process) {
      try {
        this.#process.kill();
      } catch {
        /* already exited */
      }
    }
    this.#setHealth("stopped");
    await this.#readLoop?.catch(() => undefined);
  }

  async #consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.#decoder.push(value);
        for (const payload of this.#decoder.drain()) {
          this.#handlePayload(payload);
        }
      }
    } catch (error) {
      this.#setHealth("fatal", error instanceof Error ? error.message : String(error));
    } finally {
      reader.releaseLock();
      if (this.#health !== "stopped") {
        this.#setHealth("fatal", "runtime stdout closed");
      }
      for (const [id, pending] of this.#pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error(`runtime exited before responding to '${pending.method}'`));
        this.#pending.delete(id);
      }
    }
  }

  async #consumeStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          // §19.7: runtime stderr is redacted diagnostics and must never be
          // spliced into the timeline directly.
          if (line.length > 0) this.#options.onStderr?.(line);
          index = buffer.indexOf("\n");
        }
      }
    } catch {
      /* stderr closing is not fatal */
    } finally {
      reader.releaseLock();
    }
  }

  #handlePayload(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.#setHealth("degraded", "runtime sent unparseable JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;

    const message = parsed as Partial<JsonRpcResponse> & Partial<JsonRpcNotification>;

    if (message.id !== undefined && typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RuntimeRpcError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      if (message.method === "runtime.heartbeat") {
        this.#lastHeartbeat = Date.now();
        if (this.#health === "degraded") this.#setHealth("ready");
      }
      if (message.method === "runtime.fatal") {
        this.#setHealth("fatal", JSON.stringify(message.params));
      }
      // §20.4: unknown notifications are tolerated for forward compatibility.
      if (!isKnownNotificationMethod(message.method)) {
        this.#options.onNotification?.(message.method, message.params);
        return;
      }
      this.#options.onNotification?.(message.method, message.params);
    }
  }

  #startHeartbeatWatch(): void {
    this.#stopHeartbeatWatch();
    this.#heartbeatTimer = setInterval(() => {
      const silence = Date.now() - this.#lastHeartbeat;
      if (silence >= HEARTBEAT.fatalMs) {
        this.#setHealth("fatal", `no heartbeat for ${silence} ms`);
      } else if (silence >= HEARTBEAT.degradedMs) {
        this.#setHealth("degraded", `no heartbeat for ${silence} ms`);
      }
    }, HEARTBEAT.intervalMs);
    // Do not hold the event loop open for the watchdog alone.
    (this.#heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  #stopHeartbeatWatch(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #setHealth(health: RuntimeHealth, detail?: string): void {
    if (this.#health === health) return;
    this.#health = health;
    this.#options.onHealthChange?.(health, detail);
  }
}

function defaultSpawner(binary: string): RuntimeProcess {
  // Bun.spawn is the production path; the import is deferred so this module can
  // be unit tested under any runtime.
  const bun = (globalThis as { Bun?: { spawn: (opts: unknown) => unknown } }).Bun;
  if (!bun) {
    throw new Error("no process spawner available; pass an explicit RuntimeSpawner");
  }
  return bun.spawn({
    cmd: [binary],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as RuntimeProcess;
}
