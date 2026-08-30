import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { spawnStdioWorker } from "../src/session-worker-host.ts";

describe("session worker multiplexing", () => {
  test("serves graph requests while a turn is still running and correlates out-of-order replies", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/session-worker-echo.mjs", import.meta.url));
    const worker = spawnStdioWorker(process.execPath, [fixture]);
    const turn = worker.submit({
      sessionId: "session_1",
      turnId: "turn_1",
      prompt: "slow turn",
      clientId: "client_1",
    });
    const graph = await worker.request?.("session_1", "graph.get", { includeBudget: true });
    expect(graph).toEqual({
      method: "graph.get",
      params: { sessionId: "session_1", includeBudget: true },
    });
    await expect(turn).resolves.toMatchObject({
      turnId: "turn_1",
      status: "completed",
      answer: "slow turn",
    });
    await worker.close?.();
  });
});
