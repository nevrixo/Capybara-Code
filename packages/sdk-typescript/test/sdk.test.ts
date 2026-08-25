import { describe, expect, test } from "bun:test";

import {
  APP_COMMAND_SCHEMA_VERSION,
  APP_PROTOCOL_VERSION,
  CommandDeduplicator,
  type CommandEnvelope,
  type OperationReceipt,
} from "@cbc/app-protocol";

import {
  CapybaraClient,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcTransport,
} from "../src/index.ts";

const T0 = "2026-08-24T12:00:00.000Z";

class MockAppTransport implements JsonRpcTransport {
  readonly sent: JsonRpcRequest[] = [];
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #dedupe = new CommandDeduplicator<Record<string, unknown>, { turnId: string }>();
  #connectionId = "conn_1";
  #generation = 1;
  #closed = false;

  send(message: JsonRpcMessage): void {
    if (this.#closed) throw new Error("transport closed");
    if (!("method" in message) || !("id" in message)) return;
    const request = message as JsonRpcRequest;
    this.sent.push(request);
    void this.#handle(request);
  }

  subscribe(handler: (message: JsonRpcMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Simulate a fresh daemon connection while keeping the dedupe ledger. */
  reopen(): void {
    if (!this.#closed) return;
    this.#closed = false;
    this.#generation += 1;
    this.#connectionId = `conn_${this.#generation}`;
  }

  #respond(id: string | number, result: unknown): void {
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, result };
    for (const handler of this.#handlers) handler(message);
  }

  async #handle(request: JsonRpcRequest): Promise<void> {
    if (request.method === "server.initialize") {
      this.#respond(request.id, {
        protocolVersion: APP_PROTOCOL_VERSION,
        serverVersion: "0.1.0",
        daemonId: "daemon_test",
        connectionId: this.#connectionId,
        capabilities: {},
        limits: {
          maxRequestBytes: 1_048_576,
          maxResponseBytes: 1_048_576,
          maxSubscriptionsPerClient: 16,
          maxSessionsPerSubscription: 1,
        },
      });
      return;
    }

    if (request.method === "turn.submit") {
      const params = request.params as { command: CommandEnvelope<Record<string, unknown>> };
      const command = params.command;
      const outcome = await this.#dedupe.execute(command, async () => {
        const receipt: OperationReceipt<{ turnId: string }> = {
          schemaVersion: APP_COMMAND_SCHEMA_VERSION,
          receiptId: `rcp_${command.commandId}`,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          status: "accepted",
          startedAt: T0,
          evidenceIds: [],
          result: { turnId: `turn_${command.idempotencyKey}` },
        };
        return receipt;
      });
      this.#respond(request.id, outcome.receipt);
      return;
    }

    this.#respond(request.id, { ok: true });
  }
}

describe("sdk-typescript", () => {
  test("connect initializes over mock JSON-RPC and submits a turn", async () => {
    const transport = new MockAppTransport();
    const client = await CapybaraClient.connect({
      transport: "stdio",
      client: { id: "client_sdk", kind: "sdk" },
      now: () => T0,
      createTransport: () => transport,
    });

    expect(client.connectionId).toBe("conn_1");
    expect(transport.sent[0]?.method).toBe("server.initialize");

    const session = client.session("ses_1");
    const turn = await session.submit("fix the parser", { idempotencyKey: "key_stable" });
    expect(turn.idempotencyKey).toBe("key_stable");
    expect(turn.turnId).toBe("turn_key_stable");
    expect(turn.receipt.status).toBe("accepted");

    const submit = transport.sent.find((message) => message.method === "turn.submit");
    expect(submit).toBeDefined();
    const envelope = (submit!.params as { command: CommandEnvelope<{ prompt: string }> }).command;
    expect(envelope.schemaVersion).toBe("1.0");
    expect(envelope.clientId).toBe("client_sdk");
    expect(envelope.payload.prompt).toBe("fix the parser");

    await client.close();
  });

  test("reconnect resubmits with the same idempotencyKey and replays the receipt", async () => {
    const transport = new MockAppTransport();
    const client = await CapybaraClient.connect({
      transport: "unix",
      path: "/tmp/capy.sock",
      client: { id: "client_sdk", kind: "sdk" },
      now: () => T0,
      createTransport: () => {
        transport.reopen();
        return transport;
      },
    });

    const session = client.session("ses_1");
    const first = await session.submit("retry me", { idempotencyKey: "key_reconnect" });
    expect(first.receipt.receiptId).toBe(`rcp_${first.commandId}`);

    // Drop and re-handshake; daemon-side dedupe ledger is retained on the mock.
    const init = await client.reconnect();
    expect(init.connectionId).toBe("conn_2");

    const second = await session.resubmitLast();
    expect(second.idempotencyKey).toBe("key_reconnect");
    expect(second.commandId).toBe(first.commandId);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.turnId).toBe(first.turnId);

    const submits = transport.sent.filter((message) => message.method === "turn.submit");
    expect(submits.length).toBe(2);
    const keys = submits.map((message) =>
      (message.params as { command: CommandEnvelope<unknown> }).command.idempotencyKey
    );
    expect(keys).toEqual(["key_reconnect", "key_reconnect"]);

    await client.close();
  });
});
