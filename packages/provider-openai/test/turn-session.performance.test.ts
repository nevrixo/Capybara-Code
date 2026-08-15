import { describe, expect, test } from "bun:test";

import {
  fakeLease,
  OpenAiResponsesProvider,
  parseResponseStream,
  type ModelEvent,
  type ModelRequest,
} from "../src/index.ts";
import {
  OpenAiTurnSession,
  type WebSocketLike,
  type WebSocketMessageEventLike,
} from "../src/turn-session.ts";

type WireFrame = Readonly<Record<string, unknown>>;
type SendHandler = (socket: FakeWebSocket, body: Record<string, unknown>) => void;

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];

  constructor(private readonly handleSend: SendHandler) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  failConnection(): void {
    this.readyState = 3;
    this.onerror?.(new Error("connection refused"));
  }

  emit(frame: WireFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "transport lost" });
  }

  send(data: string): void {
    const body = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(body);
    this.handleSend(this, body);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "req_1",
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
    ],
    tools: [],
    reasoning: { mode: "standard", effort: "medium", summary: "auto", context: "all_turns" },
    maxOutputTokens: 4_000,
    store: false,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function complete(socket: FakeWebSocket, responseId: string, sequenceNumber = 1): void {
  queueMicrotask(() => {
    socket.emit({
      type: "response.completed",
      response: { id: responseId },
      sequence_number: sequenceNumber,
    });
  });
}

function sessionHarness(handleSend: SendHandler, connect: "open" | "error" = "open") {
  const sockets: FakeWebSocket[] = [];
  const httpRequests: ModelRequest[] = [];
  const session = new OpenAiTurnSession({
    capabilities: {
      websocket: true,
      previousResponse: true,
      parallelToolCalls: true,
      nativeCompaction: true,
      fastTier: true,
      toolSearch: true,
    },
    transport: "websocket",
    webSocketUrl: "wss://example.invalid/v1/responses",
    webSocketHeaders: { Authorization: "Bearer test" },
    webSocketFactory: () => {
      const socket = new FakeWebSocket(handleSend);
      sockets.push(socket);
      queueMicrotask(() => connect === "open" ? socket.open() : socket.failConnection());
      return socket;
    },
    prepareWebSocketRequest: (modelRequest) => ({
      body: {
        model: modelRequest.model,
        input: modelRequest.input,
        ...(modelRequest.previousResponseId !== undefined
          ? { previous_response_id: modelRequest.previousResponseId }
          : {}),
      },
      fromProviderToolName: (name) => name,
    }),
    parseStream: parseResponseStream,
    httpStream: async function* (modelRequest) {
      httpRequests.push(modelRequest);
      yield { type: "response.started", requestId: modelRequest.requestId };
      yield { type: "response.completed", responseId: "http_fallback" };
    },
  });
  return { session, sockets, httpRequests };
}

describe("OpenAI WebSocket turn-session performance contract", () => {
  test("reuses one open socket across sequential model responses", async () => {
    let responseNumber = 0;
    const harness = sessionHarness((socket) => {
      responseNumber += 1;
      complete(socket, `resp_${responseNumber}`);
    });

    const first = await collect(harness.session.stream(request(), new AbortController().signal));
    const second = await collect(
      harness.session.stream(
        request({ requestId: "req_2", previousResponseId: "resp_1" }),
        new AbortController().signal,
      ),
    );

    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]?.sent.map((body) => body.generate)).toEqual([true, true]);
    expect(first.find((event) => event.type === "response.started")).toMatchObject({
      connectionReused: false,
    });
    expect(second.find((event) => event.type === "response.started")).toMatchObject({
      connectionReused: true,
    });
    await harness.session.close();
  });

  test("prewarms with generate:false and reuses that connection for the first response", async () => {
    let responseNumber = 0;
    const harness = sessionHarness((socket) => {
      responseNumber += 1;
      complete(socket, `resp_${responseNumber}`);
    });

    await harness.session.prewarm(request(), new AbortController().signal);
    const events = await collect(
      harness.session.stream(request({ requestId: "req_after_prewarm" }), new AbortController().signal),
    );

    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]?.sent.map((body) => body.generate)).toEqual([false, true]);
    expect(events.find((event) => event.type === "response.started")).toMatchObject({
      connectionReused: true,
    });
    await harness.session.close();
  });

  test("falls back to continuation-aware HTTP when the socket cannot connect", async () => {
    const harness = sessionHarness(() => {}, "error");
    const events = await collect(
      harness.session.stream(
        request({ previousResponseId: "resp_previous" }),
        new AbortController().signal,
      ),
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: "transport.fallback",
      from: "websocket",
      to: "http_previous",
    }));
    expect(events).toContainEqual({ type: "response.completed", responseId: "http_fallback" });
    expect(harness.httpRequests).toHaveLength(1);
    expect(harness.httpRequests[0]?.previousResponseId).toBe("resp_previous");
    await harness.session.close();
  });

  test("falls back when an idle socket closes before a terminal frame", async () => {
    const harness = sessionHarness((socket) => queueMicrotask(() => socket.disconnect()));
    const events = await collect(
      harness.session.stream(
        request({ previousResponseId: "resp_previous" }),
        new AbortController().signal,
      ),
    );

    expect(events.some((event) => event.type === "response.incomplete")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "transport.fallback",
      from: "websocket",
      to: "http_previous",
    }));
    expect(harness.httpRequests).toHaveLength(1);
    await harness.session.close();
  });

  test("suppresses duplicate WebSocket frames before normalized deltas escape", async () => {
    const harness = sessionHarness((socket) => {
      queueMicrotask(() => {
        const duplicate = {
          type: "response.output_text.delta",
          delta: "once",
          item_id: "message_1",
          event_id: "evt_1",
          sequence_number: 1,
        };
        socket.emit(duplicate);
        socket.emit(duplicate);
        socket.emit({
          type: "response.completed",
          response: { id: "resp_done" },
          event_id: "evt_2",
          sequence_number: 2,
        });
      });
    });

    const events = await collect(harness.session.stream(request(), new AbortController().signal));
    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", text: "once" },
    ]);
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    await harness.session.close();
  });
});
