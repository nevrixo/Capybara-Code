import { describe, expect, test } from "bun:test";

import { AppProtocolError } from "@cbc/app-protocol";
import {
  JSONRPC_ERROR_CODES,
  RuntimeRpcError,
  type RequestMethod,
} from "@cbc/protocol";

import {
  RuntimeAppServerBackend,
  type RuntimeAppServerClient,
} from "../src/index.ts";

const T0 = "2026-08-25T00:00:00.000Z";

class FakeRuntime implements RuntimeAppServerClient {
  readonly calls: Array<{ readonly method: RequestMethod; readonly params: unknown }> = [];
  readonly replies: unknown[] = [];

  async request(method: RequestMethod, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

function subscription(
  overrides: Partial<{
    id: string;
    clientId: string;
    sessionId: string;
    state: "active" | "paused" | "closed";
    lastAckedSequence: number;
  }> = {},
) {
  return {
    id: "sub_timeline",
    clientId: "client_tui",
    sessionId: "ses_timeline",
    state: "active" as const,
    lastAckedSequence: 4,
    ...overrides,
  };
}

describe("RuntimeAppServerBackend", () => {
  test("maps a public client registration to the authoritative Rust RPC", async () => {
    const runtime = new FakeRuntime();
    runtime.replies.push({
      client: { clientId: "client_plugin", kind: "plugin-host" },
    });
    const backend = new RuntimeAppServerBackend(runtime);

    await backend.registerClient({
      client: {
        id: "client_plugin",
        name: "Plugin host",
        version: "1.0.0",
        kind: "plugin-host",
      },
      seenAt: T0,
    });

    expect(runtime.calls).toEqual([{
      method: "app.client.upsert",
      params: {
        clientId: "client_plugin",
        name: "Plugin host",
        version: "1.0.0",
        kind: "plugin-host",
        seenAt: T0,
      },
    }]);
  });

  test("maps create, ACK, and close without trusting response identity fields", async () => {
    const runtime = new FakeRuntime();
    runtime.replies.push(
      { subscription: subscription() },
      { subscription: subscription({ lastAckedSequence: 7 }) },
      { subscription: subscription({ state: "closed", lastAckedSequence: 7 }) },
    );
    const backend = new RuntimeAppServerBackend(runtime);

    const created = await backend.createSubscription({
      id: "sub_timeline",
      clientId: "client_tui",
      sessionId: "ses_timeline",
      initialAckedSequence: 4,
      filter: {
        kinds: ["user.message"],
        visibility: ["timeline"],
        includeEphemeral: false,
      },
      createdAt: T0,
    });
    const acknowledged = await backend.acknowledgeSubscription({
      subscriptionId: "sub_timeline",
      clientId: "client_tui",
      sessionId: "ses_timeline",
      sequence: 7,
      at: "2026-08-25T00:00:01.000Z",
    });
    const closed = await backend.setSubscriptionState({
      subscriptionId: "sub_timeline",
      clientId: "client_tui",
      state: "closed",
      at: "2026-08-25T00:00:02.000Z",
    });

    expect(created.lastAckedSequence).toBe(4);
    expect(acknowledged.lastAckedSequence).toBe(7);
    expect(closed.state).toBe("closed");
    expect(runtime.calls).toEqual([
      {
        method: "app.subscription.create",
        params: {
          id: "sub_timeline",
          clientId: "client_tui",
          sessionId: "ses_timeline",
          initialAckedSequence: 4,
          filter: {
            kinds: ["user.message"],
            visibility: ["timeline"],
            includeEphemeral: false,
          },
          createdAt: T0,
        },
      },
      {
        method: "app.subscription.ack",
        params: {
          subscriptionId: "sub_timeline",
          clientId: "client_tui",
          sequence: 7,
          at: "2026-08-25T00:00:01.000Z",
        },
      },
      {
        method: "app.subscription.state",
        params: {
          subscriptionId: "sub_timeline",
          clientId: "client_tui",
          state: "closed",
          at: "2026-08-25T00:00:02.000Z",
        },
      },
    ]);
  });

  test("maps bounded replay through the authoritative runtime without exposing store fields", async () => {
    const runtime = new FakeRuntime();
    runtime.replies.push({
      subscription: subscription(),
      events: [{
        schemaVersion: "1.0",
        sequence: 5,
        id: "evt:replay",
        timestamp: "2026-08-25T00:00:05Z",
        sessionId: "ses_timeline",
        kind: "user.message",
        level: "info",
        visibility: "timeline",
        durability: "journaled",
        payload: { text: "replayed" },
        correlationId: "corr/replay",
        eventHash: "must-not-cross-the-app-boundary",
      }],
      cursor: { sessionId: "ses_timeline", journalSequence: 5 },
      hasMore: true,
    });
    const backend = new RuntimeAppServerBackend(runtime);

    const replay = await backend.replaySubscription({
      subscriptionId: "sub_timeline",
      clientId: "client_tui",
      afterSequence: 4,
      maxEvents: 8,
      maxBytes: 2048,
    });

    expect(replay).toMatchObject({
      subscription: subscription(),
      cursor: { sessionId: "ses_timeline", journalSequence: 5 },
      hasMore: true,
    });
    expect(replay.events).toEqual([{
      schemaVersion: "1.0",
      sequence: 5,
      id: "evt:replay",
      timestamp: "2026-08-25T00:00:05Z",
      sessionId: "ses_timeline",
      kind: "user.message",
      level: "info",
      visibility: "timeline",
      durability: "journaled",
      payload: { text: "replayed" },
      correlationId: "corr/replay",
    }]);
    expect(runtime.calls).toEqual([{
      method: "app.subscription.replay",
      params: {
        subscriptionId: "sub_timeline",
        clientId: "client_tui",
        afterSequence: 4,
        maxEvents: 8,
        maxBytes: 2048,
      },
    }]);
  });

  test("rejects runtime replays that exceed caller event or byte budgets", async () => {
    const event = {
      schemaVersion: "1.0",
      sequence: 5,
      id: "evt:batch-1",
      timestamp: "2026-08-25T00:00:05Z",
      sessionId: "ses_timeline",
      kind: "user.message",
      level: "info",
      visibility: "timeline",
      durability: "journaled",
      payload: { text: "bounded" },
    };
    const countRuntime = new FakeRuntime();
    countRuntime.replies.push({
      subscription: subscription(),
      events: [event, { ...event, sequence: 6, id: "evt:batch-2" }],
      cursor: { sessionId: "ses_timeline", journalSequence: 6 },
      hasMore: true,
    });
    await expect(new RuntimeAppServerBackend(countRuntime).replaySubscription({
      subscriptionId: "sub_timeline",
      clientId: "client_tui",
      afterSequence: 4,
      maxEvents: 1,
      maxBytes: 2048,
    })).rejects.toMatchObject({
      structured: { code: "APP_RUNTIME_RESPONSE_INVALID", category: "internal" },
    });

    const byteRuntime = new FakeRuntime();
    byteRuntime.replies.push({
      subscription: subscription(),
      events: [{ ...event, payload: { text: "x".repeat(2048) } }],
      cursor: { sessionId: "ses_timeline", journalSequence: 5 },
      hasMore: false,
    });
    await expect(new RuntimeAppServerBackend(byteRuntime).replaySubscription({
      subscriptionId: "sub_timeline",
      clientId: "client_tui",
      afterSequence: 4,
      maxEvents: 8,
      maxBytes: 128,
    })).rejects.toMatchObject({
      structured: { code: "APP_RUNTIME_RESPONSE_INVALID", category: "internal" },
    });
  });
  test("rejects malformed replay envelopes from the runtime", async () => {
    const runtime = new FakeRuntime();
    runtime.replies.push({
      subscription: subscription(),
      events: [{
        schemaVersion: "1.0",
        sequence: 5,
        id: "evt_replay",
        timestamp: "2026-08-25T00:00:05Z",
        sessionId: "ses_timeline",
        kind: "user.message",
        level: "info",
        visibility: "timeline",
        durability: "ephemeral",
        payload: {},
      }],
      cursor: { sessionId: "ses_timeline", journalSequence: 5 },
      hasMore: false,
    });
    const backend = new RuntimeAppServerBackend(runtime);

    await expect(backend.replaySubscription({
      subscriptionId: "sub_timeline",
      clientId: "client_tui",
      afterSequence: 4,
      maxEvents: 8,
      maxBytes: 2048,
    })).rejects.toMatchObject({
      structured: {
        code: "APP_RUNTIME_RESPONSE_INVALID",
        category: "internal",
      },
    });
  });


  test("rejects a malformed or mismatched runtime subscription response", async () => {
    const runtime = new FakeRuntime();
    runtime.replies.push({
      subscription: subscription({ clientId: "client_other" }),
    });
    const backend = new RuntimeAppServerBackend(runtime);

    await expect(backend.createSubscription({
      id: "sub_timeline",
      clientId: "client_tui",
      sessionId: "ses_timeline",
      initialAckedSequence: 0,
      filter: { kinds: [], visibility: [], includeEphemeral: false },
      createdAt: T0,
    })).rejects.toMatchObject({
      structured: {
        code: "APP_RUNTIME_RESPONSE_INVALID",
        category: "internal",
        retryable: false,
      },
    });
  });

  test("normalizes runtime failures without leaking sidecar messages", async () => {
    const runtime = new FakeRuntime();
    runtime.replies.push(new RuntimeRpcError({
      code: JSONRPC_ERROR_CODES.notFound,
      message: "C:/sensitive/runtime/state.sqlite3",
      data: { taxonomy: "NOT_FOUND" },
    }));
    const backend = new RuntimeAppServerBackend(runtime);

    let caught: unknown;
    try {
      await backend.registerClient({
        client: {
          id: "client_tui",
          name: "Capybara TUI",
          version: "1.0.0",
          kind: "tui",
        },
        seenAt: T0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppProtocolError);
    expect(caught).toMatchObject({
      structured: {
        code: "APP_RUNTIME_REJECTED",
        category: "not_found",
        retryable: false,
      },
    });
    expect((caught as Error).message).not.toContain("sensitive");
  });
});
