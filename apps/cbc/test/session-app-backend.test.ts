import { describe, expect, test } from "bun:test";

import { AppServer } from "@cbc/app-server";
import { CapybaraClient } from "@cbc/sdk";

import { SessionAppBackend } from "../src/session-app-backend.ts";
import { createInProcessAppTransport } from "../src/session-app-client.ts";

describe("embedded App Protocol client", () => {
  test("turn.submit goes through AppServer and replays the same idempotency key", async () => {
    const prompts: string[] = [];
    const session = {
      viewModel: { currentTurnId: "turn_app" },
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
});
