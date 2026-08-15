import type {
  ModelEvent,
  ModelRequest,
  ProviderCapabilities,
  ProviderTransport,
  ProviderTurnSession,
} from "./types.ts";

export interface WebSocketMessageEventLike {
  readonly data: unknown;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocketLike;

export interface PreparedWebSocketRequest {
  readonly body: Record<string, unknown>;
  readonly fromProviderToolName: (name: string) => string;
}

export interface OpenAiTurnSessionOptions {
  readonly capabilities: ProviderCapabilities;
  readonly transport: ProviderTransport;
  readonly webSocketUrl: string;
  readonly webSocketHeaders: Readonly<Record<string, string>>;
  readonly webSocketFactory?: WebSocketFactory;
  readonly prepareWebSocketRequest: (request: ModelRequest) => PreparedWebSocketRequest;
  readonly parseStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    fromProviderToolName: (name: string) => string,
  ) => AsyncIterable<ModelEvent>;
  readonly httpStream: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ModelEvent>;
  readonly now?: () => number;
}

interface PrewarmedResponse {
  readonly request: ModelRequest;
  readonly responseId: string;
  readonly socket: WebSocketLike;
}

const OPEN_STATE = 1;
const MAX_SOCKET_AGE_MS = 55 * 60 * 1_000;
const SOCKET_FAILURE_THRESHOLD = 3;
const SOCKET_CIRCUIT_COOLDOWN_MS = 30_000;

export class OpenAiTurnSession implements ProviderTurnSession {
  readonly capabilities: ProviderCapabilities;
  readonly transport: ProviderTransport;
  readonly #options: OpenAiTurnSessionOptions;
  readonly #transport: ProviderTransport;
  readonly #now: () => number;
  #socket: WebSocketLike | undefined;
  #socketCreatedAt = 0;
  #connecting: Promise<WebSocketLike> | undefined;
  #active = false;
  #closed = false;
  readonly #lifetimeAbort = new AbortController();
  #prewarmInFlight: Promise<void> | undefined;
  #prewarmedResponse: PrewarmedResponse | undefined;
  #latestResponse: { readonly responseId: string; readonly socket: WebSocketLike } | undefined;
  #consecutiveSocketFailures = 0;
  #socketCircuitOpenUntil = 0;

  constructor(options: OpenAiTurnSessionOptions) {
    this.#options = options;
    this.capabilities = options.capabilities;
    this.transport = options.transport;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => Date.now());
  }

  async prewarm(request: ModelRequest, signal: AbortSignal): Promise<void> {
    if (this.#transport !== "websocket" || !this.capabilities.websocket) return;
    if (this.#closed) throw new Error("provider turn session is closed");

    const effectiveSignal = AbortSignal.any([signal, this.#lifetimeAbort.signal]);
    const current = this.#prewarmInFlight;
    if (current !== undefined) {
      await waitForPromise(current, effectiveSignal);
      return;
    }

    const flight = this.#runPrewarm(request, effectiveSignal);
    this.#prewarmInFlight = flight;
    try {
      await flight;
    } finally {
      if (this.#prewarmInFlight === flight) this.#prewarmInFlight = undefined;
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (this.#closed) {
      yield {
        type: "response.failed",
        error: {
          kind: "invalid_request",
          message: "provider turn session is closed",
          retryable: false,
        },
      };
      return;
    }

    const effectiveSignal = AbortSignal.any([signal, this.#lifetimeAbort.signal]);
    if (this.#transport === "http_full") {
      yield* this.#options.httpStream(withoutPreviousResponse(request), effectiveSignal);
      return;
    }
    if (this.#transport === "http_previous" || !this.capabilities.websocket) {
      yield* this.#options.httpStream(request, effectiveSignal);
      return;
    }

    const prewarm = this.#prewarmInFlight;
    if (prewarm !== undefined) {
      try {
        await waitForPromise(prewarm, effectiveSignal);
      } catch {
        if (effectiveSignal.aborted) {
          yield cancelledEvent("request cancelled while waiting for WebSocket prewarm");
          return;
        }
        // A failed speculative warmup must not fail the real request. The full
        // request below can establish a fresh socket and chain of its own.
      }
    }
    if (this.#closed || effectiveSignal.aborted) {
      yield cancelledEvent("provider turn session closed before the response started");
      return;
    }

    const websocketRequest = this.#consumePrewarmedResponse(request);
    let fallbackReason: string | undefined;
    if (this.#now() < this.#socketCircuitOpenUntil) {
      if (request.previousResponseId !== undefined && !this.capabilities.previousResponse) {
        yield continuationLostEvent(
          "No continuation-aware fallback is available while the WebSocket circuit is open",
        );
        return;
      }
      const fallbackTransport = request.previousResponseId === undefined
        ? "http_full"
        : "http_previous";
      yield {
        type: "transport.fallback",
        from: "websocket",
        to: fallbackTransport,
        reason: "WebSocket circuit breaker is cooling down after repeated transport failures",
      };
      yield* this.#options.httpStream(
        fallbackTransport === "http_previous" ? request : withoutPreviousResponse(request),
        effectiveSignal,
      );
      return;
    }

    let responseContentObserved = false;
    for await (const event of this.#streamWebSocket(websocketRequest, effectiveSignal, true)) {
      if (isResponseContent(event)) responseContentObserved = true;
      if (
        event.type === "response.failed" &&
        !responseContentObserved &&
        (event.error.kind === "network" ||
          event.error.kind === "server" ||
          (event.error.code === "previous_response_not_found" &&
            this.capabilities.previousResponse))
      ) {
        fallbackReason = event.error.message;
        break;
      }
      yield event;
    }

    if (fallbackReason === undefined) {
      this.#consecutiveSocketFailures = 0;
      return;
    }
    if (effectiveSignal.aborted) return;
    this.#consecutiveSocketFailures += 1;
    if (this.#consecutiveSocketFailures >= SOCKET_FAILURE_THRESHOLD) {
      this.#socketCircuitOpenUntil = this.#now() + SOCKET_CIRCUIT_COOLDOWN_MS;
    }
    this.resetContinuation("websocket fallback: " + fallbackReason);
    if (request.previousResponseId !== undefined && !this.capabilities.previousResponse) {
      yield continuationLostEvent(`WebSocket continuation state was lost: ${fallbackReason}`);
      return;
    }
    const fallbackTransport = request.previousResponseId === undefined
      ? "http_full"
      : "http_previous";
    yield {
      type: "transport.fallback",
      from: "websocket",
      to: fallbackTransport,
      reason: fallbackReason,
    };
    yield* this.#options.httpStream(
      fallbackTransport === "http_previous" ? request : withoutPreviousResponse(request),
      effectiveSignal,
    );
  }

  resetContinuation(_reason: string): void {
    this.#closeSocket(1000, "continuation reset");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#lifetimeAbort.abort();
    this.#closeSocket(1000, "turn session closed");
    const prewarm = this.#prewarmInFlight;
    if (prewarm !== undefined) {
      try {
        await prewarm;
      } catch {
        // Closing owns cancellation; a cancelled speculative warmup is expected.
      }
    }
  }

  async #runPrewarm(request: ModelRequest, signal: AbortSignal): Promise<void> {
    let responseId: string | undefined;
    let completed = false;
    for await (const event of this.#streamWebSocket(request, signal, false)) {
      if (event.type === "response.created" && event.responseId !== "unknown") {
        responseId = event.responseId;
      } else if (event.type === "response.completed") {
        completed = true;
        if (event.responseId !== "unknown") responseId = event.responseId;
      } else if (event.type === "response.incomplete") {
        throw new Error(`OpenAI WebSocket prewarm was incomplete: ${event.reason}`);
      } else if (event.type === "response.failed") {
        throw new Error(event.error.message);
      }
    }

    const latest = this.#latestResponse;
    if (
      !completed ||
      responseId === undefined ||
      latest === undefined ||
      latest.responseId !== responseId ||
      latest.socket.readyState !== OPEN_STATE
    ) {
      throw new Error("OpenAI WebSocket prewarm ended without a reusable response ID");
    }
    this.#prewarmedResponse = { request, responseId, socket: latest.socket };
  }

  #consumePrewarmedResponse(request: ModelRequest): ModelRequest {
    const prewarmed = this.#prewarmedResponse;
    this.#prewarmedResponse = undefined;
    if (
      prewarmed === undefined ||
      request.previousResponseId !== undefined ||
      prewarmed.socket !== this.#socket ||
      prewarmed.socket.readyState !== OPEN_STATE ||
      this.#now() - this.#socketCreatedAt >= MAX_SOCKET_AGE_MS ||
      prewarmed.request.model !== request.model ||
      !jsonEqual(prewarmed.request.tools, request.tools)
    ) {
      return request;
    }

    const suffix = inputSuffixAfterPrefix(request.input, prewarmed.request.input);
    if (suffix === undefined) return request;
    return {
      ...request,
      input: suffix,
      previousResponseId: prewarmed.responseId,
    };
  }

  async *#streamWebSocket(
    request: ModelRequest,
    signal: AbortSignal,
    generate: boolean,
  ): AsyncIterable<ModelEvent> {
    if (this.#active) {
      yield {
        type: "response.failed",
        error: {
          kind: "invalid_request",
          message: "a WebSocket turn session supports only one response in flight",
          retryable: false,
        },
      };
      return;
    }

    this.#active = true;
    try {
      if (
        request.previousResponseId !== undefined &&
        !this.#continuationAvailable(request.previousResponseId)
      ) {
        yield continuationLostEvent(
          `Previous response '${request.previousResponseId}' is not available on the active WebSocket`,
        );
        return;
      }

      let socket: WebSocketLike;
      const reusableBeforeConnect =
        this.#socket !== undefined &&
        this.#socket.readyState === OPEN_STATE &&
        this.#now() - this.#socketCreatedAt < MAX_SOCKET_AGE_MS;

      try {
        socket = await this.#ensureSocket(signal);
      } catch (error) {
        yield {
          type: "response.failed",
          error: {
            kind: signal.aborted ? "cancelled" : "network",
            message: error instanceof Error ? error.message : String(error),
            retryable: !signal.aborted,
          },
        };
        return;
      }

      const prepared = this.#options.prepareWebSocketRequest(request);
      const encoder = new TextEncoder();
      let streamClosed = false;
      let transportClosedUnexpectedly = false;
      let terminalWireFrameObserved = false;
      const seenFrameIds = new Set<string>();
      let removeAbort = () => {};
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const finish = () => {
            if (streamClosed) return;
            streamClosed = true;
            controller.close();
          };
          const fail = (error: unknown) => {
            if (streamClosed) return;
            streamClosed = true;
            controller.error(error);
          };
          socket.onmessage = (event) => {
            void messageText(event.data).then((message) => {
              if (streamClosed) return;
              const identity = frameIdentity(message);
              if (identity !== undefined && seenFrameIds.has(identity)) return;
              if (identity !== undefined) {
                seenFrameIds.add(identity);
                if (seenFrameIds.size > 2_048) {
                  const oldest = seenFrameIds.values().next().value;
                  if (oldest !== undefined) seenFrameIds.delete(oldest);
                }
              }
              controller.enqueue(encoder.encode("data: " + message + "\n\n"));
              if (isTerminalFrame(message)) {
                terminalWireFrameObserved = true;
                finish();
              }
            }, fail);
          };
          socket.onerror = () => fail(new Error("OpenAI WebSocket transport error"));
          socket.onclose = () => {
            if (!streamClosed && !signal.aborted) transportClosedUnexpectedly = true;
            if (this.#socket === socket) {
              this.#socket = undefined;
              this.#socketCreatedAt = 0;
              this.#latestResponse = undefined;
              this.#prewarmedResponse = undefined;
            }
            finish();
          };
          const onAbort = () => {
            try {
              if (socket.readyState === OPEN_STATE) {
                socket.send(JSON.stringify({ type: "response.cancel" }));
              }
            } catch {
              // Cancellation is best effort; the local stream still closes.
            }
            this.#closeSocket(1000, "response cancelled");
            finish();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        },
        cancel: () => {
          removeAbort();
        },
      });

      yield {
        type: "response.started",
        requestId: request.requestId,
        connectionReused: reusableBeforeConnect,
      };
      if (request.previousResponseId === undefined) this.#latestResponse = undefined;
      try {
        socket.send(JSON.stringify({
          type: "response.create",
          ...prepared.body,
          generate,
        }));
      } catch (error) {
        yield {
          type: "response.failed",
          error: {
            kind: "network",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        };
        return;
      }

      try {
        let terminalEventObserved = false;
        try {
          for await (
            const event of this.#options.parseStream(
              body,
              signal,
              prepared.fromProviderToolName,
            )
          ) {
            // The SSE parser emits a synthetic incomplete event at EOF. An
            // unexpected socket close is a transport failure instead, so let
            // stream() activate its HTTP fallback rather than accepting that
            // synthetic event as a provider terminal response.
            if (
              transportClosedUnexpectedly &&
              !terminalWireFrameObserved &&
              event.type === "response.incomplete"
            ) {
              continue;
            }
            if (event.type === "response.completed" && event.responseId !== "unknown") {
              this.#latestResponse = { responseId: event.responseId, socket };
            } else if (
              request.previousResponseId !== undefined &&
              (event.type === "response.failed" || event.type === "response.incomplete")
            ) {
              this.#latestResponse = undefined;
            }
            if (isTerminalEvent(event)) terminalEventObserved = true;
            yield hideProviderIdentityFromStructuralShape(event);
          }
        } catch (error) {
          if (request.previousResponseId !== undefined) this.#latestResponse = undefined;
          yield {
            type: "response.failed",
            error: {
              kind: signal.aborted ? "cancelled" : "network",
              message: error instanceof Error ? error.message : String(error),
              retryable: !signal.aborted,
            },
          };
          return;
        }
        if (!terminalEventObserved && !signal.aborted) {
          if (request.previousResponseId !== undefined) this.#latestResponse = undefined;
          yield {
            type: "response.failed",
            error: {
              kind: "network",
              message: transportClosedUnexpectedly
                ? "OpenAI WebSocket closed before a terminal response frame"
                : "OpenAI WebSocket stream ended before a terminal response frame",
              retryable: true,
            },
          };
        }
      } finally {
        removeAbort();
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
      }
    } finally {
      this.#active = false;
    }
  }

  #continuationAvailable(responseId: string): boolean {
    const latest = this.#latestResponse;
    return (
      latest !== undefined &&
      latest.responseId === responseId &&
      latest.socket === this.#socket &&
      latest.socket.readyState === OPEN_STATE &&
      this.#now() - this.#socketCreatedAt < MAX_SOCKET_AGE_MS
    );
  }
  async #ensureSocket(signal: AbortSignal): Promise<WebSocketLike> {
    if (
      this.#socket !== undefined &&
      this.#socket.readyState === OPEN_STATE &&
      this.#now() - this.#socketCreatedAt < MAX_SOCKET_AGE_MS
    ) {
      return this.#socket;
    }
    if (this.#connecting !== undefined) return await this.#connecting;

    this.#closeSocket(1000, "socket refresh");
    const factory = this.#options.webSocketFactory ?? defaultWebSocketFactory;
    this.#connecting = new Promise<WebSocketLike>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("request cancelled before WebSocket connection"));
        return;
      }
      let socket: WebSocketLike;
      try {
        socket = factory(this.#options.webSocketUrl, {
          headers: this.#options.webSocketHeaders,
        });
      } catch (error) {
        reject(error);
        return;
      }
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
      };
      const onAbort = () => {
        cleanup();
        socket.close(1000, "request cancelled");
        reject(new Error("request cancelled during WebSocket connection"));
      };
      socket.onopen = () => {
        cleanup();
        this.#socket = socket;
        this.#socketCreatedAt = this.#now();
        resolve(socket);
      };
      socket.onerror = () => {
        cleanup();
        reject(new Error("failed to connect to OpenAI WebSocket mode"));
      };
      socket.onclose = () => {
        cleanup();
        reject(new Error("OpenAI WebSocket closed before becoming ready"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }).finally(() => {
      this.#connecting = undefined;
    });
    return await this.#connecting;
  }

  #closeSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#socketCreatedAt = 0;
    this.#latestResponse = undefined;
    this.#prewarmedResponse = undefined;
    if (socket === undefined) return;
    try {
      socket.close(code, reason);
    } catch {
      // Closing an already-closed transport is harmless.
    }
  }
}

function cancelledEvent(message: string): ModelEvent {
  return {
    type: "response.failed",
    error: { kind: "cancelled", message, retryable: false },
  };
}

function continuationLostEvent(reason: string): ModelEvent {
  return {
    type: "response.failed",
    error: {
      kind: "invalid_request",
      code: "previous_response_not_found",
      message: `previous_response_not_found: ${reason}; retry once with full input`,
      retryable: false,
    },
  };
}

async function waitForPromise(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("request cancelled");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("request cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function inputSuffixAfterPrefix(
  input: ModelRequest["input"],
  prefix: ModelRequest["input"],
): ModelRequest["input"] | undefined {
  if (prefix.length > input.length) return undefined;
  for (let index = 0; index < prefix.length; index += 1) {
    if (!jsonEqual(prefix[index], input[index])) return undefined;
  }
  return input.slice(prefix.length);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutPreviousResponse(request: ModelRequest): ModelRequest {
  const { previousResponseId: _previousResponseId, ...fullRequest } = request;
  return fullRequest;
}

/**
 * WebSocket frame ids remain available to the kernel for reconciliation, while
 * the public structural event shape contains only semantic delta fields. This
 * keeps duplicate-frame tests and logs stable without throwing away identity.
 */
function hideProviderIdentityFromStructuralShape(event: ModelEvent): ModelEvent {
  if (!("itemId" in event) || typeof event.itemId !== "string") return event;
  const visible = { ...event } as Record<string, unknown>;
  Object.defineProperty(visible, "itemId", {
    value: event.itemId,
    enumerable: false,
    configurable: true,
  });
  return visible as ModelEvent;
}
function isResponseContent(event: ModelEvent): boolean {
  return (
    event.type === "commentary.delta" ||
    event.type === "reasoning.text.delta" ||
    event.type === "reasoning.text.done" ||
    event.type === "reasoning.summary.delta" ||
    event.type === "text.delta" ||
    event.type === "tool.call.started" ||
    event.type === "tool.call.arguments.delta" ||
    event.type === "tool.call.completed" ||
    event.type === "response.item"
  );
}

function isTerminalEvent(event: ModelEvent): boolean {
  return (
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed"
  );
}

function frameIdentity(message: string): string | undefined {
  try {
    const parsed = JSON.parse(message) as {
      readonly type?: unknown;
      readonly event_id?: unknown;
      readonly sequence_number?: unknown;
    };
    const identity = typeof parsed.event_id === "string"
      ? parsed.event_id
      : typeof parsed.sequence_number === "number" || typeof parsed.sequence_number === "string"
        ? String(parsed.sequence_number)
        : undefined;
    if (identity === undefined) return undefined;
    return `${typeof parsed.type === "string" ? parsed.type : "event"}:${identity}`;
  } catch {
    return undefined;
  }
}

function isTerminalFrame(message: string): boolean {
  try {
    const parsed = JSON.parse(message) as { readonly type?: unknown };
    return (
      parsed.type === "response.completed" ||
      parsed.type === "response.incomplete" ||
      parsed.type === "response.failed" ||
      parsed.type === "error"
    );
  } catch {
    return false;
  }
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "text" in data &&
    typeof (data as { readonly text?: unknown }).text === "function"
  ) {
    return await (data as { text(): Promise<string> }).text();
  }
  return String(data);
}

const defaultWebSocketFactory: WebSocketFactory = (url, options) => {
  const Constructor = globalThis.WebSocket as unknown as new (
    url: string,
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ) => WebSocketLike;
  if (Constructor === undefined) {
    throw new Error("this runtime does not provide a WebSocket client");
  }
  // Bun accepts request headers in the second constructor argument. The
  // injectable factory keeps contract tests and non-Bun hosts deterministic.
  return new Constructor(url, { headers: options.headers });
};
