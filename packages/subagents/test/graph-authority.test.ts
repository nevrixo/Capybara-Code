import { describe, expect, test } from "bun:test";

import { MAX_GRAPH_NODES } from "@cbc/agent-graph-domain";

import { emptyChildResult } from "../src/instance.ts";
import { GraphAuthority } from "../src/graph-authority.ts";
import { MemoryGraphStore, type GraphSnapshotStore } from "../src/graph-store.ts";
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

  test("restores graph and mailbox from a snapshot store after a crash", async () => {
    const store = new MemoryGraphStore();
    const first = new GraphAuthority({
      sessionId: "ses_persist",
      workspaceIdentityDigest: "ws_persist",
      now: () => 1,
      store,
    });
    first.recordSpawn({
      id: "reader",
      title: "scan",
      role: "explore",
      dependencies: [],
      canWrite: false,
    });
    first.postMessage({ from: "root", to: "reader", kind: "hint", body: { text: "auth" } });
    const snapshot = first.persistSnapshot();
    expect(snapshot.state?.revision).toBeGreaterThan(0);

    const restored = new GraphAuthority({
      sessionId: "ses_persist",
      workspaceIdentityDigest: "ws_persist",
      now: () => 2,
      store,
    });
    expect(restored.snapshot()?.revision).toBe(snapshot.state?.revision);
    expect(restored.mailbox()).toHaveLength(1);
    const delivered = restored.takeUndelivered("reader");
    expect(delivered[0]?.body).toEqual({ text: "auth" });
    expect(restored.takeUndelivered("reader")).toHaveLength(0);
  });

  test("hard-caps the domain node budget at 10k", () => {
    expect(MAX_GRAPH_NODES).toBe(10_000);
  });

  test("optional durable persist hook is invoked when a snapshot is saved", () => {
    const durable: string[] = [];
    const store: GraphSnapshotStore = {
      load() {
        return undefined;
      },
      save() {
        return;
      },
      persistDurable(graphId, snapshotJson, at) {
        durable.push(`${graphId}:${at}:${snapshotJson.length}`);
      },
    };
    const graph = new GraphAuthority({
      sessionId: "ses_hook",
      workspaceIdentityDigest: "ws",
      now: () => Date.parse("2026-08-25T00:00:00.000Z"),
      store,
    });
    graph.recordSpawn({
      id: "reader",
      title: "scan",
      role: "explore",
      dependencies: [],
      canWrite: false,
    });
    expect(durable.length).toBeGreaterThan(0);
    expect(durable[0]).toContain("grf_ses_hook");
  });
});
