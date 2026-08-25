import { describe, expect, test } from "bun:test";

import { emptyChildResult } from "../src/instance.ts";
import { GraphAuthority } from "../src/graph-authority.ts";
import { SubagentScheduler } from "../src/scheduler.ts";
import { buildTask } from "../src/task.ts";

describe("durable graph authority", () => {
  test("records spawn and completion through the reducer", async () => {
    const graph = new GraphAuthority({
      sessionId: "ses_graph",
      workspaceIdentityDigest: "ws",
      now: () => 1,
    });
    const events: string[] = [];
    const scheduler = new SubagentScheduler({
      graph,
      emitter: { emit: (kind) => { events.push(kind); } },
      runner: async () => emptyChildResult("completed", "done"),
      parentContextTokens: 8_000,
    });
    const handle = scheduler.spawn({
      role: "explore",
      task: buildTask({
        title: "scan",
        goal: "scan the repository for the auth entry points",
        expectedOutput: ["a map"],
      }, "explore"),
    });
    await scheduler.await(handle.id);
    const snapshot = graph.snapshot();
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot!.nodes).length).toBeGreaterThan(1);
    expect(events).toContain("task.created");
    expect(events).toContain("task.completed");
  });

  test("allows two writers in different partitions", () => {
    const scheduler = new SubagentScheduler({
      writerPartition: (task) => task.allowedPaths[0] ?? "base",
      emitter: { emit: () => undefined },
      runner: async () => emptyChildResult("completed", "done"),
      parentContextTokens: 8_000,
    });
    scheduler.spawn({
      role: "executor",
      task: buildTask({
        title: "auth",
        goal: "edit the authentication module in isolation",
        constraints: ["do not change public API"],
        expectedOutput: ["patch"],
        allowedPaths: ["src/auth/**"],
      }, "executor"),
    });
    expect(() =>
      scheduler.spawn({
        role: "executor",
        task: buildTask({
          title: "tests",
          goal: "edit the matching tests in a second tree",
          constraints: ["keep existing test names"],
          expectedOutput: ["patch"],
          allowedPaths: ["tests/**"],
        }, "executor"),
      }),
    ).not.toThrow();
  });
});
