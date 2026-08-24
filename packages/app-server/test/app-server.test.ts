import { describe, expect, test } from "bun:test";

import {
  AppServer,
  type AppServerBackend,
  type AppServerSubscription,
} from "../src/index.ts";

const T0 = "2026-08-25T00:00:00.000Z";

class FakeBackend implements AppServerBackend {
  readonly clients: string[] = [];
  readonly subscriptions = new Map<string, AppServerSubscription>();
  readonly calls: Array<{ method: string; clientId: string }> = [];

  async registerClient(
    input: Parameters<AppServerBackend["registerClient"]>[0],
  ): Promise<void> {
    this.clients.push(input.client.id + ":" + input.seenAt);
  }

  async createSubscription(
    input: Parameters<AppServerBackend["createSubscription"]>[0],
  ): Promise<AppServerSubscription> {
    const record: AppServerSubscription = {
      id: input.id,
      clientId: input.clientId,
      sessionId: input.sessionId,
      state: "active",
      lastAckedSequence: input.initialAckedSequence,
    };
    this.subscriptions.set(input.id, record);
    return record;
  }

  async acknowledgeSubscription(
    input: Parameters<AppServerBackend["acknowledgeSubscription"]>[0],
  ): Promise<AppServerSubscription> {
    const existing = this.subscriptions.get(input.subscriptionId);
    if (
      existing === undefined
      || existing.clientId !== input.clientId
      || existing.sessionId !== input.sessionId
    ) {
      throw new Error("unexpected subscription owner");
    }
    const record: AppServerSubscription = {
      ...existing,
      lastAckedSequence: Math.max(existing.lastAckedSequence, input.sequence),
    };
    this.subscriptions.set(record.id, record);
    return record;
  }

  async setSubscriptionState(
    input: Parameters<AppServerBackend["setSubscriptionState"]>[0],
  ): Promise<AppServerSubscription> {
    const existing = this.subscriptions.get(input.subscriptionId);
    if (existing === undefined || existing.clientId !== input.clientId) {
      throw new Error("unexpected subscription owner");
    }
    const record: AppServerSubscription = { ...existing, state: input.state };
    this.subscriptions.set(record.id, record);
    return record;
  }

  async dispatch(
    input: NonNullable<AppServerBackend["dispatch"]> extends (value: infer T) => unknown ? T : never,
  ): Promise<unknown> {
    this.calls.push({ method: input.method, clientId: input.clientId });
    return { ok: true };
  }
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "server.initialize",
    params: {
      protocolVersion: "1.0",
      client: {
        id: "client_tui",
        name: "Capybara TUI",
        version: "1.0.0",
        kind: "tui",
      },
      capabilities: {
        eventStreaming: true,
        eventAck: true,
        approvals: true,
        interactivePrompts: true,
        artifactStreaming: true,
        richDiff: true,
      },
    },
  };
}

function server(
  roles: readonly ("observer" | "controller" | "approval_resolver" | "administrator-local")[],
) {
  const backend = new FakeBackend();
  const app = new AppServer({
    backend,
    daemonId: "daemon_local",
    now: () => T0,
    newConnectionId: () => "conn_test",
    authorizer: { authorize: async () => roles },
  });
  return { app, backend };
}

async function initialize(app: AppServer): Promise<string> {
  const response = await app.dispatch(undefined, initializeRequest());
  if (!("result" in response)) {
    throw new Error("initialize failed: " + response.error.message);
  }
  return (response.result as { connectionId: string }).connectionId;
}

describe("AppServer dispatch", () => {
  test("requires initialize before any client method", async () => {
    const { app } = server(["observer"]);
    const response = await app.dispatch(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "events.subscribe",
      params: {},
    });
    expect("error" in response && response.error.data.code).toBe("APP_CONNECTION_REQUIRED");
  });

  test("registers a client and persists a single-session cursor subscription", async () => {
    const { app, backend } = server(["observer"]);
    const connectionId = await initialize(app);
    expect(backend.clients).toEqual(["client_tui:2026-08-25T00:00:00.000Z"]);

    const response = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "events.subscribe",
      params: {
        subscriptionId: "sub_timeline",
        request: {
          sessionIds: ["session_one"],
          from: {
            session_one: { sessionId: "session_one", journalSequence: 4 },
          },
          kinds: ["user.message"],
          visibility: ["timeline"],
          maxBatchEvents: 100,
          maxBatchBytes: 4096,
        },
      },
    });
    expect("result" in response).toBe(true);
    expect(backend.subscriptions.get("sub_timeline")).toMatchObject({
      clientId: "client_tui",
      sessionId: "session_one",
      lastAckedSequence: 4,
    });
  });

  test("routes ACK and unsubscribe through the bound connection identity", async () => {
    const { app, backend } = server(["observer"]);
    const connectionId = await initialize(app);
    await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "events.subscribe",
      params: {
        subscriptionId: "sub_ack",
        request: { sessionIds: ["session_one"] },
      },
    });
    const ack = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "events.ack",
      params: {
        subscriptionId: "sub_ack",
        cursor: { sessionId: "session_one", journalSequence: 7 },
      },
    });
    expect("result" in ack).toBe(true);
    expect(backend.subscriptions.get("sub_ack")?.lastAckedSequence).toBe(7);
    await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "events.unsubscribe",
      params: { subscriptionId: "sub_ack" },
    });
    expect(backend.subscriptions.get("sub_ack")?.state).toBe("closed");
  });

  test("does not grant controller authority merely because a client connected", async () => {
    const { app, backend } = server(["observer"]);
    const connectionId = await initialize(app);
    const response = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "turn.submit",
      params: {
        command: {
          schemaVersion: "1.0",
          commandId: "cmd_1",
          idempotencyKey: "key_1",
          correlationId: "cor_1",
          clientId: "client_tui",
          issuedAt: T0,
          payload: { prompt: "hi" },
        },
      },
    });
    expect("error" in response && response.error.data.code).toBe("APP_ROLE_DENIED");
    expect(backend.calls).toEqual([]);
  });

  test("requires a client-bound command envelope for delegated mutations", async () => {
    const { app, backend } = server(["observer", "controller"]);
    const connectionId = await initialize(app);
    const missing = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "turn.submit",
      params: {},
    });
    expect("error" in missing && missing.error.data.code).toBe("APP_COMMAND_ENVELOPE_REQUIRED");

    const accepted = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "turn.submit",
      params: {
        command: {
          schemaVersion: "1.0",
          commandId: "cmd_1",
          idempotencyKey: "key_1",
          correlationId: "cor_1",
          clientId: "client_tui",
          issuedAt: T0,
          payload: { prompt: "hi" },
        },
      },
    });
    expect("result" in accepted).toBe(true);
    expect(backend.calls).toEqual([{ method: "turn.submit", clientId: "client_tui" }]);
  });

  test("requires a client-bound command envelope for administrator mutations", async () => {
    const { app, backend } = server(["observer", "administrator-local"]);
    const connectionId = await initialize(app);
    const missing = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "plugin.enable",
      params: {},
    });
    expect("error" in missing && missing.error.data.code).toBe("APP_COMMAND_ENVELOPE_REQUIRED");

    const accepted = await app.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "plugin.enable",
      params: {
        command: {
          schemaVersion: "1.0",
          commandId: "cmd_2",
          idempotencyKey: "key_2",
          correlationId: "cor_2",
          clientId: "client_tui",
          issuedAt: T0,
          payload: { installationId: "plg_example" },
        },
      },
    });
    expect("result" in accepted).toBe(true);
    expect(backend.calls).toEqual([{ method: "plugin.enable", clientId: "client_tui" }]);
  });

  test("uses standard JSON-RPC codes for unknown methods and invalid params", async () => {
    const { app } = server(["observer"]);
    const connectionId = await initialize(app);
    const unknown = await app.dispatch(connectionId, {
      jsonrpc: "2.0", id: 2, method: "unknown.method",
    });
    expect("error" in unknown && unknown.error.code).toBe(-32601);

    const invalid = await app.dispatch(connectionId, {
      jsonrpc: "2.0", id: 3, method: "events.subscribe",
      params: { request: { sessionIds: [] } },
    });
    expect("error" in invalid && invalid.error.code).toBe(-32602);
  });
});
