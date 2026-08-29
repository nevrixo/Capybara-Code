import { describe, expect, test } from "bun:test";

import { AppServer } from "@cbc/app-server";
import { CapybaraClient } from "@cbc/sdk";

import { SessionAppBackend } from "../src/session-app-backend.ts";
import { createInProcessAppTransport } from "../src/session-app-client.ts";

describe("embedded App Protocol client", () => {
  test("turn.submit goes through AppServer and replays the same idempotency key", async () => {
    const prompts: string[] = [];
    const session = {
      viewModel: { currentTurnId: "turn_app", timeline: [] },
      async submit(prompt: string) {
        prompts.push(prompt);
        return {
          answer: "ok",
          report: {
            status: "completed" as const,
            summary: "ok",
            changedFiles: [],
            verification: [],
            delegatedTasks: [],
            risks: [],
          },
        };
      },
    };
    const backend = new SessionAppBackend({
      session: session as never,
      sessionId: "ses_app",
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const app = new AppServer({
      backend,
      daemonId: "daemon_embedded",
      authorizer: {
        authorize: async () => ["observer", "controller", "approval_resolver"] as const,
      },
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const client = await CapybaraClient.connect({
      transport: "stdio",
      client: { id: "client_tui", name: "capy", version: "1.0.0", kind: "tui" },
      createTransport: () => createInProcessAppTransport(app),
    });
    const handle = await client.session("ses_app").submit("fix the parser", { idempotencyKey: "idem_1" });
    const replay = await client.session("ses_app").submit("fix the parser", { idempotencyKey: "idem_1" });
    expect(handle.idempotencyKey).toBe("idem_1");
    expect(replay.idempotencyKey).toBe("idem_1");
    expect(prompts).toEqual(["fix the parser"]);
    await client.close();
  });

  test("replays journaled events after a cursor", async () => {
    const backend = new SessionAppBackend({
      session: {
        viewModel: { currentTurnId: "turn_app", timeline: [] },
      } as never,
      sessionId: "ses_app",
      now: () => "2026-08-25T00:00:00.000Z",
      journal: () => [
        { sequence: 1, kind: "turn.started", payload: { prompt: "a" } },
        { sequence: 2, kind: "turn.completed", payload: { status: "completed" } },
      ],
    });
    await backend.createSubscription({
      id: "sub_1",
      clientId: "client_tui",
      sessionId: "ses_app",
      initialAckedSequence: 0,
      filter: { kinds: [], visibility: [], includeEphemeral: false },
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    const replay = await backend.replaySubscription({
      subscriptionId: "sub_1",
      clientId: "client_tui",
      afterSequence: 1,
      maxEvents: 16,
      maxBytes: 65_536,
    });
    expect(replay.events.map((event) => event.kind)).toEqual(["turn.completed"]);
    expect(replay.cursor.journalSequence).toBe(2);
    expect(replay.hasMore).toBe(false);
  });

  test("routes graph/task inspect, wait, message, and cancel through the session coordinator", async () => {
    const messages: unknown[] = [];
    const cancellations: string[] = [];
    const instance = {
      id: "agent_1",
      parentId: "root",
      role: "explore",
      state: "running",
      depth: 1,
    };
    const session = {
      viewModel: { currentTurnId: "turn_app", timeline: [] },
      taskGraphSnapshot: () => ({ revision: 2, nodes: { agent_1: instance } }),
      taskBudgetSnapshot: () => ({ schemaVersion: "1.0", reservations: [] }),
      taskRecoveryReport: () => [],
      taskInstances: () => [instance],
      taskInstance: (taskId: string) => taskId === "agent_1" ? instance : undefined,
      waitTask: async () => ({ status: "completed", summary: "done" }),
      messageTask: (_taskId: string, _kind: string, body: unknown) => { messages.push(body); },
      cancelTaskResult: async (taskId: string) => {
        cancellations.push(taskId);
        return { status: "cancelled", summary: "cancelled" };
      },
    };
    const app = new AppServer({
      backend: new SessionAppBackend({
        session: session as never,
        sessionId: "ses_app",
      }),
      daemonId: "daemon_embedded",
      authorizer: {
        authorize: async () => ["observer", "controller"] as const,
      },
    });
    const client = await CapybaraClient.connect({
      transport: "stdio",
      client: { id: "client_tui", name: "capy", version: "1.0.0", kind: "tui" },
      createTransport: () => createInProcessAppTransport(app),
    });
    expect(client.initializeResult?.capabilitySnapshot.methods["task.message"]?.state).toBe("available");
    const graph = await client.request<{ graph: unknown }>("graph.get");
    expect(JSON.stringify(graph.graph)).toContain("agent_1");
    const waited = await client.request<{ result: { status: string } }>("task.wait", {
      taskId: "agent_1",
    });
    expect(waited.result.status).toBe("completed");

    const command = (id: string, payload: unknown) => ({
      schemaVersion: "1.0",
      commandId: "cmd_" + id,
      idempotencyKey: "idem_" + id,
      correlationId: "cor_" + id,
      clientId: "client_tui",
      sessionId: "ses_app",
      issuedAt: "2026-08-30T00:00:00.000Z",
      payload,
    });
    const messaged = await client.request<{ status: string }>("task.message", {
      command: command("message", {
        taskId: "agent_1",
        kind: "instruction",
        body: { text: "narrow scope" },
      }),
    });
    expect(messaged.status).toBe("completed");
    expect(messages).toEqual([{ text: "narrow scope" }]);

    const cancelled = await client.request<{ status: string }>("task.cancel", {
      command: command("cancel", { taskId: "agent_1" }),
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancellations).toEqual(["agent_1"]);
    await client.close();
  });
});
