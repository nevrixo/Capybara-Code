import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeToolExecutor } from "../src/tools.ts";
import { runtimeSidecarEnvironment } from "../src/runtime.ts";

describe("runtime sidecar environment", () => {

  test("trusted Build-mode sensitive fs.write commits and persists through the host executor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cbc-sensitive-write-"));
    let mode: "build" | "plan" = "build";
    const staged: { path?: string; content?: string } = {};
    const transactions: string[] = [];
    const runtime = {
      workspace,
      issueCapability: async (params: Record<string, unknown>) => {
        expect(mode).toBe("build");
        expect(params.operation).toBe("fs.transaction");
        expect(params.resources).toEqual(["secret.env"]);
        return { id: "cap-sensitive" };
      },
      beginTransaction: async () => ({ transactionId: "tx-sensitive" }),
      write: async (params: Record<string, unknown>) => {
        if (mode !== "build") throw new Error("PERMISSION_DENIED: Plan mode forbids workspace mutation");
        staged.path = String(params.path);
        staged.content = String(params.content);
        return { stagedPaths: [String(params.path)] };
      },
      commitTransaction: async () => {
        if (mode !== "build") throw new Error("PERMISSION_DENIED: Plan mode forbids workspace mutation");
        const path = join(workspace, staged.path ?? "secret.env");
        writeFileSync(path, staged.content ?? "", "utf8");
        transactions.push("committed");
        return { operations: [{ path: staged.path ?? "secret.env", additions: 1, deletions: 0 }], totalAdditions: 1, totalDeletions: 0 };
      },
      rollbackTransaction: async () => undefined,
    } as never;
    try {
      const executor = new RuntimeToolExecutor({
        runtime,
        host: { now: () => 1_000 } as never,
        sessionId: "sensitive-write-session",
      });
      const result = await executor.execute({
        callId: "write-sensitive",
        toolId: "fs.write",
        arguments: {
          path: "secret.env",
          content: "OPENAI_API_KEY=sk-proj-test-value",
          intent: "create",
        },
        writes: ["secret.env"],
        display: "Write secret.env",
      }, new AbortController().signal);
      expect(result.result.ok).toBe(true);
      expect(transactions).toEqual(["committed"]);
      expect(readFileSync(join(workspace, "secret.env"), "utf8")).toBe("OPENAI_API_KEY=sk-proj-test-value");
    } finally {
      mode = "plan";
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("feature-gated fs.edit re-normalizes every capability resource before staging", async () => {
    const issued: Record<string, unknown>[] = [];
    const applied: Record<string, unknown>[] = [];
    const runtime = {
      workspace: "/work/project",
      async issueCapability(params: Record<string, unknown>) {
        issued.push(params);
        return {
          id: "cap-edit",
          sessionId: "session-edit",
          callId: "edit-1",
          actionHash: "hash-edit",
          workspaceId: "workspace-edit",
          operation: "fs.transaction",
          resources: ["src/a.ts", "src/b.ts"],
          network: "deny" as const,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          singleUse: true,
        };
      },
      beginTransaction: async () => ({ transactionId: "tx-edit" }),
      async applyEdit(params: Record<string, unknown>) {
        applied.push(params);
        return {
          status: "previewed" as const,
          planId: "edp_1",
          planDigest: "sha256:plan",
          resolvedOperations: [],
          files: [{
            kind: "move" as const,
            path: "src/b.ts",
            previousPath: "src/a.ts",
            operationIds: ["edo_1"],
            additions: 0,
            deletions: 0,
          }],
          diffPreview: [],
          stagedPaths: ["src/a.ts", "src/b.ts"],
        };
      },
      commitTransaction: async () => ({
        operations: [{ path: "src/b.ts", additions: 0, deletions: 0 }],
        totalAdditions: 0,
        totalDeletions: 0,
      }),
      rollbackTransaction: async () => undefined,
    };
    const action = {
      callId: "edit-1",
      toolId: "fs.edit",
      arguments: {
        plan: {
          schemaVersion: "1.0",
          id: "edp_1",
          source: "model",
          workspaceIdentityDigest: "workspace-edit",
          sessionId: "session-edit",
          operations: [{
            operationId: "edo_1",
            kind: "move_file",
            path: "/work/project/src/a.ts",
            toPath: "/work/project/src/b.ts",
          }],
          conflictPolicy: "fail",
          createdAt: "2026-08-25T00:00:00.000Z",
        },
      },
      display: "edit src/a.ts",
    };
    const disabled = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      sessionId: "session-edit",
    });
    const denied = await disabled.execute(action, new AbortController().signal);
    expect(denied.result.error?.code).toBe("NOT_FOUND");
    expect(issued).toHaveLength(0);

    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      sessionId: "session-edit",
      editEngineV2: true,
    });
    const result = await executor.execute(action, new AbortController().signal);
    expect(result.result.ok).toBe(true);
    expect(issued[0]?.resources).toEqual(["src/a.ts", "src/b.ts"]);
    const plan = applied[0]?.plan as { operations: Array<{ operationId: string; kind: string; path: string; toPath?: string }> };
    expect(plan.operations[0]).toEqual({
      operationId: "edo_1",
      kind: "move_file",
      path: "src/a.ts",
      toPath: "src/b.ts",
    });
  });

  test("does not inherit provider secrets or executable-control variables", () => {
    const filtered = runtimeSidecarEnvironment({
      PATH: "C:\\bin",
      TEMP: "C:\\tmp",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      NODE_OPTIONS: "--require ./payload.js",
      LD_PRELOAD: "./payload.so",
      CBC_UNRELATED: "value",
    });

    expect(filtered).toEqual({
      PATH: "C:\\bin",
      TEMP: "C:\\tmp",
    });
    expect(Object.getPrototypeOf(filtered)).toBeNull();
  });
});
