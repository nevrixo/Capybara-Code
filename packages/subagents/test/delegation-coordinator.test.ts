import { describe, expect, test } from "bun:test";

import {
  DelegationCoordinator,
  GraphAuthority,
  MemoryGraphStore,
  SpawnRejected,
  buildTask,
  emptyChildResult,
  type ChildAgentResult,
  type ChildRunContext,
  type SubagentRole,
} from "../src/index.ts";

function task(role: SubagentRole, name: string, allowedPaths: readonly string[] = []) {
  return buildTask({
    title: name,
    goal: "Complete the scoped " + name + " task with exact evidence.",
    context: [],
    constraints: ["Stay inside the delegated authority."],
    expectedOutput: ["Return a structured result with evidence."],
    allowedPaths,
    forbiddenPaths: ["node_modules/**"],
    verification: role === "executor" || role === "refactorer" ? ["bun test"] : [],
    dependencies: [],
  }, role);
}

function controlledHarness(options: {
  readonly maxDepth?: number;
  readonly maxToolCalls?: number;
  readonly graph?: GraphAuthority;
} = {}) {
  const resolvers = new Map<string, (result: ChildAgentResult) => void>();
  const runner = (context: ChildRunContext): Promise<ChildAgentResult> => new Promise((resolve) => {
    resolvers.set(context.instance.id, resolve);
    const cancel = () => resolve(emptyChildResult("cancelled", "cancelled"));
    if (context.signal.aborted) cancel();
    else context.signal.addEventListener("abort", cancel, { once: true });
  });
  const coordinator = new DelegationCoordinator({
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    scheduler: {
      emitter: { emit() {} },
      runner,
      parentContextTokens: 200_000,
      maxConcurrent: 6,
    },
    limits: {
      maxDepth: options.maxDepth ?? 2,
      maxChildrenPerNode: 4,
      maxNodesPerTurn: 16,
      maxWriterNodes: 1,
      messageBytes: 65_536,
    },
    budget: {
      maxToolCalls: options.maxToolCalls ?? 240,
      maxModelCalls: 128,
      maxWallClockMs: 30 * 60_000,
      maxContextTokens: 1_000_000,
      maxCostUsd: 4,
    },
  });
  return {
    coordinator,
    finish(id: string, status: ChildAgentResult["status"] = "completed") {
      const resolve = resolvers.get(id);
      if (resolve === undefined) throw new Error("runner not started for " + id);
      resolve(emptyChildResult(status, id + " " + status));
    },
  };
}

describe("DelegationCoordinator recursive graph", () => {
  test("runs root to child to grandchild and rejects depth three at a depth-two ceiling", async () => {
    const harness = controlledHarness({ maxDepth: 2 });
    const child = harness.coordinator.facade("root").spawn({
      role: "architect",
      task: task("architect", "architecture"),
    });
    const grandchild = harness.coordinator.facade(child.id).spawn({
      role: "explore",
      task: task("explore", "storage exploration"),
    });
    expect(child.instance.depth).toBe(1);
    expect(grandchild.instance.depth).toBe(2);
    expect(grandchild.instance.parentId).toBe(child.id);
    expect(() => harness.coordinator.facade(grandchild.id).spawn({
      role: "explore",
      task: task("explore", "too deep exploration"),
    })).toThrow(SpawnRejected);

    harness.finish(grandchild.id);
    harness.finish(child.id);
    await harness.coordinator.facade(child.id).wait(grandchild.id);
    await harness.coordinator.facade("root").wait(child.id);
  });

  test("narrows path/process authority and refuses writer escalation from a read-only parent", async () => {
    const harness = controlledHarness();
    const architect = harness.coordinator.facade("root").spawn({
      role: "architect",
      task: task("architect", "read-only parent"),
    });
    expect(() => harness.coordinator.facade(architect.id).spawn({
      role: "executor",
      task: task("executor", "writer escalation", ["src/**"]),
    })).toThrow(/read-only parent/);

    const executor = harness.coordinator.facade("root").spawn({
      role: "executor",
      task: task("executor", "scoped writer", ["src/**"]),
    });
    const testChild = harness.coordinator.facade(executor.id).spawn({
      role: "test",
      task: task("test", "nested verification"),
    });
    expect(testChild.instance.permissions.allowedPaths).toEqual(["src/**"]);
    expect(testChild.instance.permissions.canWrite).toBe(false);
    expect(testChild.instance.permissions.canRunProcess).toBe(true);
    expect(testChild.instance.permissions.mayRequestApproval).toBe(false);

    harness.finish(testChild.id);
    harness.finish(executor.id);
    harness.finish(architect.id);
    await harness.coordinator.cancelAll("test cleanup");
  });

  test("cancels an entire subtree and releases its budget reservations", async () => {
    const harness = controlledHarness();
    const child = harness.coordinator.facade("root").spawn({
      role: "architect",
      task: task("architect", "parent cancellation"),
    });
    const grandchild = harness.coordinator.facade(child.id).spawn({
      role: "explore",
      task: task("explore", "child cancellation"),
    });
    await harness.coordinator.facade("root").cancel(child.id, {
      recursive: true,
      reason: "root cancelled",
    });
    expect(harness.coordinator.get(child.id)?.state).toBe("cancelled");
    expect(harness.coordinator.get(grandchild.id)?.state).toBe("cancelled");
    const states = harness.coordinator.budgetSnapshot.reservations.map((item) => item.state);
    expect(states.every((state) => state === "released")).toBe(true);
  });

  test("enforces the session tool-call budget across sequential root children", async () => {
    const harness = controlledHarness({ maxToolCalls: 15 });
    const first = harness.coordinator.facade("root").spawn({
      role: "explore",
      task: task("explore", "first budget consumer"),
    });
    harness.finish(first.id);
    await harness.coordinator.facade("root").wait(first.id);
    expect(() => harness.coordinator.facade("root").spawn({
      role: "explore",
      task: task("explore", "second budget consumer"),
    })).toThrow(/budget is exhausted/);
  });

  test("persists bounded mailbox and budget state while preventing sibling messaging", async () => {
    const store = new MemoryGraphStore();
    const graph = new GraphAuthority({
      sessionId: "session_graph",
      workspaceIdentityDigest: "workspace_graph",
      store,
    });
    const harness = controlledHarness({ graph });
    const parent = harness.coordinator.facade("root").spawn({
      role: "architect",
      task: task("architect", "message parent"),
    });
    const child = harness.coordinator.facade(parent.id).spawn({
      role: "explore",
      task: task("explore", "message child"),
    });
    const sibling = harness.coordinator.facade("root").spawn({
      role: "planner",
      task: task("planner", "message sibling"),
    });
    harness.coordinator.facade(parent.id).send(child.id, {
      kind: "scope_narrow",
      body: { paths: ["src/**"] },
    });
    expect(harness.coordinator.takeMessages(child.id)).toHaveLength(1);
    expect(() => harness.coordinator.facade(parent.id).send(sibling.id, {
      kind: "instruction",
      body: { text: "cross branch" },
    })).toThrow(/ancestors or descendants|sibling/);
    expect(store.load()?.budget?.reservations.length).toBe(3);
    const restoredGraph = new GraphAuthority({
      sessionId: "session_graph",
      workspaceIdentityDigest: "workspace_graph",
      store,
    });
    const restored = controlledHarness({ graph: restoredGraph });
    expect(restored.coordinator.budgetSnapshot.reservations).toHaveLength(3);
    expect(restored.coordinator.recoveryReport().every((item) => item.disposition === "safe-retry"))
      .toBe(true);

    harness.finish(child.id);
    harness.finish(parent.id);
    harness.finish(sibling.id);
    await harness.coordinator.cancelAll("test cleanup");
  });
});
