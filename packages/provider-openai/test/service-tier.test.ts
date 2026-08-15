import { describe, expect, test } from "bun:test";

import {
  OpenAiResponsesProvider,
  fakeLease,
  sseStream,
  type FetchLike,
  type ModelEvent,
  type ModelRequest,
} from "../src/index.ts";
import type { WebSocketLike, WebSocketMessageEventLike } from "../src/turn-session.ts";

type ServiceTier = NonNullable<ModelRequest["serviceTier"]>;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "req_service_tier",
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
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

async function captureHttpBody(serviceTier: ServiceTier): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const provider = new OpenAiResponsesProvider({
    credential: fakeLease(),
    serviceTier,
    fetchImpl: (async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return new Response(
        sseStream([{ type: "response.completed", response: { id: "resp_http" } }]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as FetchLike,
  });
  await collect(provider.stream(request(), new AbortController().signal));
  if (captured === undefined) throw new Error("HTTP request body was not captured");
  return captured;
}

class CapturingWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(private readonly capture: (body: Record<string, unknown>) => void) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    const body = JSON.parse(data) as Record<string, unknown>;
    if (body.type !== "response.create") return;
    this.capture(body);
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({
          type: "response.completed",
          response: { id: "resp_websocket" },
          sequence_number: 1,
        }),
      });
    });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function captureWebSocketBody(serviceTier: ServiceTier): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const provider = new OpenAiResponsesProvider({
    credential: fakeLease(),
    transport: "websocket",
    serviceTier,
    webSocketFactory: () => {
      const socket = new CapturingWebSocket((body) => {
        captured = body;
      });
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const session = provider.createTurnSession();
  await collect(session.stream(request(), new AbortController().signal));
  await session.close();
  if (captured === undefined) throw new Error("WebSocket request body was not captured");
  return captured;
}

describe("OpenAI service tier wire serialization", () => {
  const cases = [
    { alias: "standard" as const, wireValue: "default" },
    { alias: "fast" as const, wireValue: "priority" },
  ];

  for (const { alias, wireValue } of cases) {
    test(`maps ${alias} to ${wireValue} in the HTTP request body`, async () => {
      expect((await captureHttpBody(alias)).service_tier).toBe(wireValue);
    });

    test(`maps ${alias} to ${wireValue} in the WebSocket request body`, async () => {
      expect((await captureWebSocketBody(alias)).service_tier).toBe(wireValue);
    });
  }
});
