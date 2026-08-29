import { describe, expect, test } from "bun:test";

import {
  APP_CAPABILITY_SCHEMA_REVISION,
  APP_METHODS,
  APP_PROTOCOL_VERSION,
  finalizeCapabilitySnapshot,
  type AppMethodCapability,
  type EventCursor,
  type EventReplayResult,
  type OperationReceipt,
} from "@cbc/app-protocol";
import { digestText } from "@cbc/integration-core";

import {
  VscodeIntegrationController,
  type VscodeAppClient,
  type VscodeIntegrationStateStore,
} from "../src/controller.ts";

function snapshot() {
  return finalizeCapabilitySnapshot({
    protocolVersion: APP_PROTOCOL_VERSION,
    schemaRevision: APP_CAPABILITY_SCHEMA_REVISION,
    serverVersion: "0.1.0",
    transport: "named-pipe",
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
  });
}

class MemoryState implements VscodeIntegrationStateStore {
  readonly cursors = new Map<string, EventCursor>();

  async loadCursor(sessionId: string): Promise<EventCursor | undefined> {
    return this.cursors.get(sessionId);
  }

  async saveCursor(sessionId: string, cursor: EventCursor): Promise<void> {
    this.cursors.set(sessionId, cursor);
  }
}

class MockClient implements VscodeAppClient {
  readonly clientId = "client_vscode";
  readonly initializeResult = {
    connectionId: "connection_1",
    capabilitySnapshot: snapshot(),
  };
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly #handlers = new Set<(method: string, params: unknown) => void>();
  closed = false;

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "events.subscribe") {
      return {
        subscription: { id: "subscription_1" },
        cursor: { sessionId: "session_1", journalSequence: 0 },
      } as T;
    }
    if (method === "events.replay") return replayResult() as T;
    if (method === "turn.submit") {
      return {
        schemaVersion: "1.0",
        receiptId: "receipt_1",
        commandId: "command_1",
        idempotencyKey: "idempotency_1",
        status: "completed",
        startedAt: "2026-08-30T00:00:00.000Z",
        finishedAt: "2026-08-30T00:00:01.000Z",
        evidenceIds: [],
        result: { turnId: "turn_1" },
      } satisfies OperationReceipt as T;
    }
    return { ok: true } as T;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async reconnect() {
    return { connectionId: "connection_2", capabilitySnapshot: snapshot() };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.#handlers) handler(method, params);
  }
}

function replayResult(): EventReplayResult {
  return {
    subscription: {
      id: "subscription_1",
      clientId: "client_vscode",
      sessionId: "session_1",
      state: "active",
      lastAckedSequence: 0,
    },
    cursor: { sessionId: "session_1", journalSequence: 2 },
    events: [
      event(1, "event_1", "assistant.commentary"),
      event(2, "event_2", "assistant.final"),
    ],
    hasMore: false,
  };
}

function event(sequence: number, id: string, kind: string) {
  return {
    schemaVersion: "1.0",
    sequence,
    id,
    timestamp: "2026-08-30T00:00:00.000Z",
    sessionId: "session_1",
    kind,
    level: "info",
    visibility: "session",
    durability: "journaled" as const,
    payload: { text: kind },
  };
}

describe("VS Code integration controller", () => {
  test("attaches, replays exactly once, ACKs, and preserves daemon work on dispose", async () => {
    const client = new MockClient();
    const state = new MemoryState();
    const controller = new VscodeIntegrationController({
      connect: async () => client,
      state,
      workspaceIdentityDigest: "sha256:" + "a".repeat(64),
      now: () => "2026-08-30T00:00:00.000Z",
      newId: (prefix) => prefix + "fixed",
    });
    await controller.connect();
    await controller.attachSession("session_1");
    expect(controller.timeline.map((entry) => entry.id)).toEqual(["event_1", "event_2"]);
    expect(state.cursors.get("session_1")?.journalSequence).toBe(2);
    expect(client.calls.map((entry) => entry.method)).toContain("events.ack");

    client.emit("events.push", {
      cursor: { sessionId: "session_1", journalSequence: 3 },
      events: [
        event(2, "event_2", "assistant.final"),
        event(3, "event_3", "task.started"),
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.timeline.map((entry) => entry.id)).toEqual(["event_1", "event_2", "event_3"]);
    expect(state.cursors.get("session_1")?.journalSequence).toBe(3);

    await controller.dispose();
    expect(client.calls.map((entry) => entry.method)).toContain("session.detach");
    expect(client.calls.map((entry) => entry.method)).not.toContain("turn.cancel");
    expect(client.closed).toBe(true);
  });

  test("sends bounded editor selection context through turn.submit and then clears it", async () => {
    const client = new MockClient();
    const controller = new VscodeIntegrationController({
      connect: async () => client,
      state: new MemoryState(),
      workspaceIdentityDigest: "sha256:" + "b".repeat(64),
      newId: (prefix) => prefix + "fixed",
    });
    await controller.connect();
    await controller.attachSession("session_1");
    const text = "const value = 1;";
    controller.attachEditorContext({
      uri: "file:///workspace/src/main.ts",
      documentRevision: "7",
      languageId: "typescript",
      source: "unsaved",
      selection: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: text.length,
      },
      selectedText: text,
      textDigest: digestText(text),
    });
    await controller.submit("explain this");
    const submit = client.calls.find((entry) => entry.method === "turn.submit");
    expect(JSON.stringify(submit?.params)).toContain('"editorContext"');
    expect(JSON.stringify(submit?.params)).toContain('"clientId":"client_vscode"');
    await controller.submit("continue");
    const submits = client.calls.filter((entry) => entry.method === "turn.submit");
    expect(JSON.stringify(submits[1]?.params)).not.toContain('"editorContext"');
  });

  test("marks stale rich diffs non-applicable before VS Code opens a review", () => {
    const controller = new VscodeIntegrationController({
      connect: async () => new MockClient(),
      state: new MemoryState(),
      workspaceIdentityDigest: "ws_1",
    });
    const review = controller.projectDiff({
      receiptId: "receipt_1",
      status: "completed",
      workspaceRevisionBefore: 2,
      operations: [{
        operationId: "operation_1",
        kind: "modify",
        path: "src/main.ts",
        patch: "@@ -1 +1 @@",
      }],
    }, 1);
    expect(review.stale).toBe(true);
    expect(review.applyAllowed).toBe(false);
  });
});
