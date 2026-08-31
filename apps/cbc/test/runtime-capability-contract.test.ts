import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { ProposedAction } from "@cbc/permissions";

import { RuntimeToolExecutor } from "../src/tools.ts";

function capabilityRuntime() {
  const issued: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const removed: Record<string, unknown>[] = [];
  const runtime = {
    workspace: "/workspace",
    dataDir: "/runtime-data",
    async issueCapability(params: Record<string, unknown>) {
      issued.push(params);
      return {
        id: "cap_1",
        sessionId: params.sessionId,
        callId: params.callId,
        actionHash: params.actionHash,
        workspaceId: "workspace_1",
        operation: params.operation,
        resources: params.resources,
        network: "deny" as const,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        singleUse: true as const,
      };
    },
    async createWorktree(params: Record<string, unknown>) {
      created.push(params);
      return { worktree: { path: resolve(String(this.dataDir), String(params.path)) } };
    },
    async removeWorktree(params: Record<string, unknown>) {
      removed.push(params);
      return { ok: true, path: resolve(String(this.dataDir), String(params.path)) };
    },
  };
  return { runtime, issued, created, removed };
}

function action(toolId: "worktree.create" | "worktree.remove"): ProposedAction {
  const path = "worktrees/agent-1";
  return {
    callId: toolId + "-1",
    toolId,
    arguments: toolId === "worktree.create"
      ? { path, commit: "HEAD", requireClean: false }
      : { path },
    display: toolId + " " + path,
    reads: [path],
  };
}

describe("runtime capability contracts", () => {
  test("worktree.create binds the receipt to the runtime-managed target", async () => {
    const { runtime, issued, created } = capabilityRuntime();
    let now = 1;
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => ++now } as never,
      sessionId: "session-1",
      worktreeMultiAgent: true,
    });

    const execution = await executor.execute(action("worktree.create"), new AbortController().signal);

    const target = resolve(runtime.dataDir, "worktrees/agent-1");
    expect(execution.result.ok).toBe(true);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ operation: "worktree.create", resources: [target] });
    expect(created[0]).toMatchObject({
      path: "worktrees/agent-1",
      capabilityReceipt: "cap_1",
      capabilitySessionId: "session-1",
      capabilityActionHash: issued[0]?.actionHash,
    });
  });

  test("worktree.remove binds the receipt to the same managed target", async () => {
    const { runtime, issued, removed } = capabilityRuntime();
    let now = 1;
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => ++now } as never,
      sessionId: "session-1",
      worktreeMultiAgent: true,
    });

    const execution = await executor.execute(action("worktree.remove"), new AbortController().signal);

    const target = resolve(runtime.dataDir, "worktrees/agent-1");
    expect(execution.result.ok).toBe(true);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ operation: "worktree.remove", resources: [target] });
    expect(removed[0]).toMatchObject({
      path: "worktrees/agent-1",
      capabilityReceipt: "cap_1",
      capabilitySessionId: "session-1",
      capabilityActionHash: issued[0]?.actionHash,
    });
  });
});
