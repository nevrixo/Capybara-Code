import { describe, expect, test } from "bun:test";

import {
  APP_CAPABILITY_SCHEMA_REVISION,
  APP_METHODS,
  APP_PROTOCOL_VERSION,
  finalizeCapabilitySnapshot,
  type AppMethodCapability,
  type OperationReceipt,
} from "@cbc/app-protocol";

import {
  AcpAdapter,
  AcpNdjsonPeer,
  AcpNdjsonServer,
  type AcpAppClient,
  type AcpPeer,
} from "../src/index.ts";

const ABSOLUTE_WORKSPACE = process.platform === "win32" ? "C:\\workspace" : "/workspace";

class MockApp implements AcpAppClient {
  readonly clientId = "client_acp";
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly #handlers = new Set<(method: string, params: unknown) => void>();
  readonly initializeResult = {
    capabilitySnapshot: finalizeCapabilitySnapshot({
      protocolVersion: APP_PROTOCOL_VERSION,
      schemaRevision: APP_CAPABILITY_SCHEMA_REVISION,
      serverVersion: "0.1.0",
      transport: "stdio",
      methods: Object.fromEntries(APP_METHODS.map((method) => [
        method,
        { state: "available" } satisfies AppMethodCapability,
      ])) as Record<(typeof APP_METHODS)[number], AppMethodCapability>,
      events: {
        replay: true,
        ack: true,
        snapshots: false,
        maxBatchEvents: 64,
        maxBatchBytes: 65_536,
      },
      presentation: {
        richDiff: true,
        inlineApprovals: true,
        taskTree: true,
        planReview: true,
        artifacts: true,
      },
    }),
  };

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "session.create") return { sessionId: "ses_acp" } as T;
    if (method === "session.get") return { sessionId: "ses_acp" } as T;
    if (method === "turn.submit") {
      return {
        schemaVersion: "1.0",
        receiptId: "receipt_acp",
        commandId: "command_acp",
        idempotencyKey: "idempotency_acp",
        status: "completed",
        startedAt: "2026-08-30T00:00:00.000Z",
        finishedAt: "2026-08-30T00:00:01.000Z",
        evidenceIds: ["evidence_1"],
        result: { turnId: "turn_acp", answer: "done" },
      } satisfies OperationReceipt as T;
    }
    return { ok: true } as T;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.#handlers) handler(method, params);
  }
}

class MockPeer implements AcpPeer {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly requests: Array<{ method: string; params: unknown }> = [];

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return { outcome: { outcome: "selected", optionId: "allow_once" } } as T;
  }
}

function request(id: number, method: string, params: unknown) {
  return { jsonrpc: "2.0" as const, id, method, params };
}

describe("ACP adapter", () => {
  test("negotiates ACP v1 without advertising client filesystem or terminal authority", async () => {
    const app = new MockApp();
    const peer = new MockPeer();
    const adapter = new AcpAdapter({ app, peer });
    const response = await adapter.handle(request(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }));
    expect(response).toMatchObject({
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
        },
      },
    });
    const result = response !== undefined && "result" in response
      ? response.result as Record<string, unknown>
      : {};
    expect(JSON.stringify(result)).not.toContain("writeTextFile");
    expect(JSON.stringify(result)).not.toContain('"terminal":true');
    adapter.dispose();
  });

  test("maps session/new, session/prompt, updates, and cancellation to App Protocol", async () => {
    const app = new MockApp();
    const peer = new MockPeer();
    const adapter = new AcpAdapter({
      app,
      peer,
      now: () => "2026-08-30T00:00:00.000Z",
      newId: (prefix) => prefix + "fixed",
    });
    await adapter.handle(request(1, "initialize", { protocolVersion: 1 }));
    const created = await adapter.handle(request(2, "session/new", {
      cwd: ABSOLUTE_WORKSPACE,
      mcpServers: [],
    }));
    expect(created).toMatchObject({ result: { sessionId: "ses_acp" } });

    const prompted = await adapter.handle(request(3, "session/prompt", {
      sessionId: "ses_acp",
      prompt: [{ type: "text", text: "fix the parser" }],
    }));
    expect(prompted).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(peer.notifications).toContainEqual({
      method: "session/update",
      params: {
        sessionId: "ses_acp",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      },
    });

    const cancelled = await adapter.handle({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "ses_acp" },
    });
    expect(cancelled).toBeUndefined();
    expect(app.requests.map((entry) => entry.method)).toEqual([
      "session.create",
      "turn.submit",
      "turn.cancel",
    ]);
    const serialized = JSON.stringify(app.requests);
    expect(serialized).toContain('"clientId":"client_acp"');
    expect(serialized).toContain('"turnId":"turn_acp"');
    adapter.dispose();
  });

  test("routes permission decisions back through approval.resolve with the exact action hash", async () => {
    const app = new MockApp();
    const peer = new MockPeer();
    const adapter = new AcpAdapter({
      app,
      peer,
      newId: (prefix) => prefix + "fixed",
    });
    await adapter.handle(request(1, "initialize", { protocolVersion: 1 }));
    app.emit("approval.pending", {
      sessionId: "ses_acp",
      approvalId: "approval_1",
      actionHash: "sha256:" + "a".repeat(64),
      tool: "process.run",
      command: "bun test",
      risk: "R2",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peer.requests[0]?.method).toBe("session/request_permission");
    expect(app.requests.at(-1)?.method).toBe("approval.resolve");
    expect(JSON.stringify(app.requests.at(-1)?.params)).toContain("sha256:" + "a".repeat(64));
    adapter.dispose();
  });

  test("frames requests and responses as newline-delimited JSON", async () => {
    const app = new MockApp();
    const peer = new MockPeer();
    const adapter = new AcpAdapter({ app, peer });
    const lines: string[] = [];
    const server = new AcpNdjsonServer({
      adapter,
      write: (line) => { lines.push(line); },
    });
    await server.push(
      JSON.stringify(request(1, "initialize", { protocolVersion: 1 })) + "\n"
      + JSON.stringify(request(2, "session/new", { cwd: ABSOLUTE_WORKSPACE, mcpServers: [] })) + "\n",
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).result.protocolVersion).toBe(1);
    expect(JSON.parse(lines[1]!).result.sessionId).toBe("ses_acp");
    adapter.dispose();
  });

  test("routes outbound client requests back to the waiting permission flow", async () => {
    const writes: string[] = [];
    const peer = new AcpNdjsonPeer((line) => { writes.push(line); });
    const pending = peer.request<{ accepted: boolean }>("session/request_permission", {
      sessionId: "ses_acp",
    });
    const requestMessage = JSON.parse(writes[0]!);
    expect(requestMessage.method).toBe("session/request_permission");
    expect(peer.accept({
      jsonrpc: "2.0",
      id: requestMessage.id,
      result: { accepted: true },
    })).toBe(true);
    await expect(pending).resolves.toEqual({ accepted: true });
    peer.close();
  });
});
