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
