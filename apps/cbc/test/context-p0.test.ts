import { describe, expect, test } from "bun:test";

import type { ProposedAction } from "@cbc/permissions";
import { ReadCache, RuntimeToolExecutor, type ToolObservationEnvelope } from "../src/tools.ts";

function readAction(callId: string): ProposedAction {
  return {
    callId,
    toolId: "fs.read",
    arguments: { path: "src/a.ts" },
    reads: ["src/a.ts"],
    display: "fs.read src/a.ts",
  };
}

function readResult() {
  const checksum = "a".repeat(64);
  return {
    path: "src/a.ts",
    binary: false,
    checksum,
    excerpt: {
      path: "src/a.ts",
      checksum,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      text: "export const a = 1;",
      partial: false,
      omittedBefore: 0,
      omittedAfter: 0,
    },
    rendered: `<file path="src/a.ts">export const a = 1;</file>`,
  };
}

describe("Context P0 tool observation hook", () => {
  test("cache miss and hit both report current provenance and virtualize promoted reads", async () => {
    let now = 0;
    let agentId = "root";
    let turnId = "turn-root";
    const calls: string[] = [];
    const observations: ToolObservationEnvelope[] = [];
    const runtime = {
      workspace: "/work",
      read: async (path: string) => {
        calls.push(path);
        return readResult();
      },
    };
    const host = { now: () => ++now };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: host as never,
      readCache: new ReadCache({ now: () => now }),
      scope: () => ({ agentId, turnId }),
      onObservation: (event) => { observations.push(event); },
    });

    const first = await executor.execute(readAction("call-1"), new AbortController().signal);
    agentId = "child-1";
    turnId = "turn-child";
    const second = await executor.execute(readAction("call-2"), new AbortController().signal);

    expect(calls).toEqual(["src/a.ts"]);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.cacheHit).toBe(false);
    expect(observations[0]?.agentId).toBe("root");
    expect(observations[1]?.cacheHit).toBe(true);
    expect(observations[1]?.agentId).toBe("child-1");
    expect(observations[1]?.turnId).toBe("turn-child");
    // The callback receives exact runtime data; L7 receives only a locator after
    // successful promotion, preventing the same source from appearing twice.
    expect(observations[0]?.execution.text).toContain("export const a = 1");
    expect(first.text).not.toContain("export const a = 1");
    expect(first.text).toContain("promoted to the repository context");
    expect(second.text).toContain("promoted to the repository context");
  });

  test("a withheld disposition removes sensitive exact text from L7", async () => {
    const secret = "SECRET_CONTEXT_P0_SENTINEL";
    const runtime = {
      workspace: "/work",
      read: async () => ({
        ...readResult(),
        path: ".env",
        excerpt: { ...readResult().excerpt, path: ".env", text: secret },
        rendered: secret,
      }),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => "withheld",
    });
    const action = { ...readAction("call-secret"), arguments: { path: ".env" }, reads: [".env"] };
    const execution = await executor.execute(action, new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    expect(execution.text).not.toContain(secret);
    expect(execution.text).toContain("intentionally withheld");
  });

  test("an explicit non-promotion acknowledgement preserves exact L7 content", async () => {
    const runtime = {
      workspace: "/work",
      read: async () => readResult(),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => false,
    });
    const execution = await executor.execute(readAction("call-1"), new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    expect(execution.text).toContain("export const a = 1");
    expect(execution.text).not.toContain("promoted to the repository context");
  });

  test("a throwing observation callback cannot fail or rewrite the tool result", async () => {
    const runtime = {
      workspace: "/work",
      read: async () => readResult(),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => {
        throw new Error("context unavailable");
      },
    });
    const execution = await executor.execute(readAction("call-1"), new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    // Promotion failed, so preserving the exact raw output is the safe fallback.
    expect(execution.text).toContain("export const a = 1");
  });

  test("an in-flight read crossing a workspace mutation generation is rejected", async () => {
    let generation = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = {
      workspace: "/work",
      read: async () => {
        await gate;
        return readResult();
      },
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      readCache: new ReadCache(),
      scope: () => ({ workspaceGeneration: generation }),
      onObservation: () => true,
    });
    const pending = executor.execute(readAction("call-race"), new AbortController().signal);
    generation = 1;
    release();
    const execution = await pending;
    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("PATH_CHANGED");
    expect(execution.result.error?.message).toContain("read again");
    expect(execution.text).toBeUndefined();
  });

  test("large process output is artifactized before the observation callback", async () => {
    let observed: ToolObservationEnvelope | undefined;
    const created: Array<Record<string, unknown>> = [];
    const runtime = {
      workspace: "/work",
      run: async () => ({
        state: "exited",
        exitCode: 0,
        display: "bun test",
        durationMs: 5,
        stdout: `${"x".repeat(34_000)}MIDDLE_SPILL_SENTINEL${"x".repeat(36_000)}`,
        stderr: "",
        warnings: [],
        truncated: false,
        stdoutBytes: 70_000,
        stderrBytes: 0,
        jobId: "job-1",
      }),
      createArtifact: async (params: Record<string, unknown>) => {
        created.push(params);
        return {
          artifact: {
            id: "artifact-runtime",
            digest: "d".repeat(64),
            mediaType: "text/plain",
            bytes: 70_000,
            redaction: "redacted",
            retentionClass: "session",
          },
        };
      },
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 10 } as never,
      onObservation: (event) => { observed = event; },
    });
    const action: ProposedAction = {
      callId: "call-process",
      toolId: "process.run",
      arguments: { program: "bun", args: ["test"] },
      command: { program: "bun", args: ["test"], cwd: ".", rawShell: false },
      display: "bun test",
    };
    const execution = await executor.execute(action, new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(observed?.execution.result.artifacts?.[0]?.id).toBe("artifact-runtime");
    expect(observed?.execution.result.artifacts?.[0]?.digest).toBe("d".repeat(64));
    expect(execution.text).not.toContain("MIDDLE_SPILL_SENTINEL");
    expect(execution.text?.length ?? 0).toBeLessThan(10_000);
    expect(execution.text).toContain("use artifact.read");
  });

  test("a sensitive member is stripped while an unpromoted safe read_many member stays raw", async () => {
    const secret = "MIXED_SECRET_MUST_NOT_REACH_L7";
    const safeTail = "SAFE_RAW_LINE_401";
    const safeRendered = `${"safe\n".repeat(400)}${safeTail}`;
    const runtime = {
      workspace: "/work",
      readMany: async () => ({
        files: [
          { path: ".ssh\\id_rsa", rendered: secret },
          { path: "src/large.ts", rendered: safeRendered },
        ],
        errors: [{ path: ".ssh\\id_rsa", message: `${secret} failed` }],
      }),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => "raw",
    });
    const action: ProposedAction = {
      callId: "mixed-raw",
      toolId: "fs.read_many",
      arguments: { paths: [".ssh/id_rsa", "src/large.ts"] },
      reads: [".ssh/id_rsa", "src/large.ts"],
      display: "fs.read_many .ssh/id_rsa src/large.ts",
    };
    const execution = await executor.execute(action, new AbortController().signal);
    expect(execution.text).not.toContain(secret);
    expect(execution.text).toContain(safeTail);
    expect(execution.text).toContain("Sensitive content withheld");
  });

  test("a throwing observer still cannot restore a sensitive single-read body", async () => {
    const secret = "THROWING_OBSERVER_SECRET";
    const runtime = {
      workspace: "/work",
      read: async () => ({
        ...readResult(),
        path: "secrets.json",
        excerpt: { ...readResult().excerpt, path: "secrets.json", text: secret },
        rendered: secret,
      }),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => { throw new Error("telemetry failed"); },
    });
    const action = { ...readAction("throw-secret"), arguments: { path: "secrets.json" }, reads: ["secrets.json"] };
    const execution = await executor.execute(action, new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    expect(execution.text).not.toContain(secret);
    expect(execution.text).toContain("withheld");
  });


  test("a spilled artifact has a model-callable bounded retrieval path", async () => {
    const digest = "a".repeat(64);
    const runtime = {
      workspace: "/work",
      readArtifact: async (params: Record<string, unknown>) => ({
        digest: params.digest, bytes: 100_000, rendered: "ARTIFACT_RECOVERY_SENTINEL",
      }),
    };
    const executor = new RuntimeToolExecutor({ runtime: runtime as never, host: { now: () => 1 } as never });
    const execution = await executor.execute({
      callId: "artifact-read", toolId: "artifact.read", arguments: { digest }, display: `artifact.read ${digest}`,
    }, new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    expect(execution.text).toContain("ARTIFACT_RECOVERY_SENTINEL");
  });

  test("read_many strips only leased members and retains raw siblings", async () => {
    const checksum = "f".repeat(64);
    const runtime = {
      workspace: "/work",
      readMany: async () => ({
        files: [
          { path: "src/a.ts", checksum, rendered: "1 | PROMOTED_MEMBER_SENTINEL" },
          { path: "src/large.ts", checksum, rendered: "1 | RAW_MEMBER_SENTINEL" },
        ],
        errors: [],
      }),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => ({ disposition: "raw", virtualizedPaths: ["src/a.ts"] }),
    });
    const execution = await executor.execute({
      callId: "mixed", toolId: "fs.read_many",
      arguments: { paths: ["src/a.ts", "src/large.ts"] },
      reads: ["src/a.ts", "src/large.ts"], display: "read many",
    }, new AbortController().signal);
    expect(execution.text).not.toContain("PROMOTED_MEMBER_SENTINEL");
    expect(execution.text).toContain("exact content promoted");
    expect(execution.text).toContain("RAW_MEMBER_SENTINEL");
  });

  test("fully promoted read_many keeps bounded actionable partial errors", async () => {
    const checksum = "e".repeat(64);
    const runtime = {
      workspace: "/work",
      readMany: async () => ({
        files: [{ path: "src/a.ts", checksum, rendered: "1 | BODY_WITHHELD" }],
        errors: [{ path: "src/missing.ts", code: "NOT_FOUND", message: "NOT_FOUND_SENTINEL" }],
      }),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => ({ disposition: "promoted" }),
    });
    const execution = await executor.execute({
      callId: "partial-error", toolId: "fs.read_many",
      arguments: { paths: ["src/a.ts", "src/missing.ts"] },
      reads: ["src/a.ts", "src/missing.ts"], display: "read many",
    }, new AbortController().signal);
    expect(execution.text).not.toContain("BODY_WITHHELD");
    expect(execution.text).toContain("src/missing.ts: NOT_FOUND: NOT_FOUND_SENTINEL");
  });

  test("a generation race replaces stale successful read bytes with PATH_CHANGED", async () => {
    let generation = 4;
    let cleaned = false;
    const runtime = { workspace: "/work", read: async () => ({ ...readResult(), rendered: "RACE_STALE_SENTINEL" }) };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      scope: () => ({ workspaceGeneration: generation }),
      onObservation: () => {
        generation += 1;
        return { disposition: "promoted", workspaceGeneration: 4, onGenerationMismatch: () => { cleaned = true; } };
      },
    });
    const execution = await executor.execute(readAction("race"), new AbortController().signal);
    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("PATH_CHANGED");
    expect(execution.text ?? "").not.toContain("RACE_STALE_SENTINEL");
    expect(cleaned).toBe(true);
  });

  test("safe-looking unrequested single-read response paths fail closed", async () => {
    const runtime = {
      workspace: "/work",
      read: async () => ({ ...readResult(), path: "private/notes.txt", rendered: "UNBOUND_SECRET_SENTINEL" }),
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => ({ disposition: "raw" }),
    });
    const execution = await executor.execute(readAction("unbound"), new AbortController().signal);
    expect(execution.text).not.toContain("UNBOUND_SECRET_SENTINEL");
    expect(execution.text).toContain("withheld");
  });

  test("mixed read_many spills only the final sanitized safe output", async () => {
    const secret = "MIXED_ARTIFACT_SECRET_SENTINEL";
    const safe = `${"safe-line\n".repeat(5_000)}SAFE_ARTIFACT_TAIL`;
    const stored: string[] = [];
    const runtime = {
      workspace: "/work",
      readMany: async () => ({
        files: [
          { path: "src/large.ts", rendered: safe },
          { path: ".env", rendered: secret },
        ],
        errors: [],
      }),
      createArtifact: async (params: Record<string, unknown>) => {
        stored.push(String(params.content));
        return { artifact: {
          id: "artifact-sanitized", digest: "a".repeat(64), bytes: String(params.content).length,
          mediaType: "text/plain", redaction: "redacted", retentionClass: "session",
        } };
      },
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      onObservation: () => ({ disposition: "raw" }),
    });
    const execution = await executor.execute({
      callId: "mixed-spill", toolId: "fs.read_many",
      arguments: { paths: ["src/large.ts", ".env"] },
      reads: ["src/large.ts", ".env"], display: "read many",
    }, new AbortController().signal);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(secret);
    expect(stored[0]).toContain("SAFE_ARTIFACT_TAIL");
    expect(execution.text).not.toContain(secret);
    expect(execution.text).toContain("use artifact.read");
    expect((execution.text ?? "").length).toBeLessThan(10_000);
  });

});
