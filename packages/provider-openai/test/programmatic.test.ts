import { describe, expect, test } from "bun:test";

import {
  PROGRAM_TOOL_ALLOWLIST,
  ProgrammaticToolLane,
  validateProgramToolCall,
  type ProgramLaneRequest,
  type ProgramToolCall,
} from "../src/programmatic.ts";

function request(calls: readonly Partial<ProgramToolCall>[]): ProgramLaneRequest {
  return {
    programId: "prog_1",
    callerId: "call_prog_1",
    taskEpochId: "epoch-1",
    source: "const result = await tools.read(); text(result);",
    calls,
  };
}

function call(
  callId: string,
  toolId: "fs.read" | "fs.search",
): ProgramToolCall {
  return {
    callId,
    toolId,
    arguments: toolId === "fs.read" ? { path: "src/a.ts" } : { query: "needle" },
    callerId: "call_prog_1",
    taskEpochId: "epoch-1",
  };
}

describe("incremental programmatic tool coordinator", () => {
  test("denies mutation spoofing and caller or epoch drift before execution", () => {
    const lane = new ProgrammaticToolLane({
      allowedToolIds: ["fs.read", "fs.search"],
    });

    const mutation = lane.admit(request([{
      callId: "call_mutation",
      toolId: "fs.edit",
      arguments: { path: "src/a.ts", text: "changed" },
      callerId: "call_prog_1",
      taskEpochId: "epoch-1",
    }]));
    expect(mutation.accepted).toBe(false);
    expect(mutation.state).toBe("denied");
    expect(mutation.denied[0]?.code).toBe("unknown_tool");

    const drift = lane.admit(request([{
      ...call("call_read", "fs.read"),
      callerId: "call_other_program",
      taskEpochId: "epoch-old",
    }]));
    expect(drift.accepted).toBe(false);
    expect(drift.denied.map((entry) => entry.code)).toContain("lineage_mismatch");
  });

  test("executes only admitted reads with a hard parallel ceiling and stable outputs", async () => {
    const lane = new ProgrammaticToolLane({
      allowedToolIds: ["fs.read", "fs.search"],
      maxParallelCalls: 2,
      maxOutputBytes: 1_024,
      maxWallTimeMs: 1_000,
    });
    let active = 0;
    let peak = 0;
    const states: string[] = [];

    const result = await lane.run(
      request([call("call_1", "fs.read"), call("call_2", "fs.search"), call("call_3", "fs.read")]),
      {
        execute: async (entry) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return { callId: entry.callId, ok: true };
        },
      },
      { emit: (event) => states.push(event.state) },
    );

    expect(result.accepted).toBe(true);
    expect(result.state).toBe("program_resumed");
    expect(result.outputs.map((entry) => entry.callId)).toEqual(["call_1", "call_2", "call_3"]);
    expect(result.outputs.every((entry) => entry.callerId === "call_prog_1")).toBe(true);
    expect(result.stats.calls).toBe(3);
    expect(result.stats.parallelPeak).toBe(2);
    expect(peak).toBe(2);
    expect(states[0]).toBe("program_received");
    expect(states.at(-1)).toBe("program_resumed");
  });

  test("retries only explicitly retryable host failures and bounds returned output", async () => {
    const lane = new ProgrammaticToolLane({
      allowedToolIds: ["fs.read"],
      maxRetries: 1,
      maxOutputBytes: 4,
    });
    let attempts = 0;
    const result = await lane.run(request([call("call_1", "fs.read")]), {
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("temporary"), { retryable: true });
        return "abcdef";
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.stats.retries).toBe(1);
    expect(result.outputs[0]?.output).toMatchObject({
      text: "abcd",
      truncated: true,
      bytes: 4,
    });
  });

  test("accepts program evidence only for the active workspace and epoch", () => {
    const lane = new ProgrammaticToolLane();
    const evidence = {
      status: "complete",
      taskEpochId: "epoch-1",
      workspaceIdentityDigest: "workspace-1",
      claims: [{ text: "symbol is referenced", evidenceIds: ["ev-1"], paths: ["src/a.ts"] }],
      missing: [],
      diagnostics: [],
      stats: { calls: 1, parallelPeak: 1, inputBytes: 20, outputBytes: 10 },
    } as const;

    expect(lane.complete(evidence, {
      taskEpochId: "epoch-1",
      workspaceIdentityDigest: "workspace-1",
    }).accepted).toBe(true);
    expect(lane.complete(evidence, {
      taskEpochId: "epoch-2",
      workspaceIdentityDigest: "workspace-1",
    })).toMatchObject({
      accepted: false,
      errors: ["program evidence belongs to a different task epoch"],
    });
  });
  // PRD §5.2 fixes the initial read-only surface a program may reduce over.
  // Losing one of these silently narrows PTC back to plain file reads, which is
  // exactly the fan-out the lane exists to collapse; gaining a mutation entry
  // would breach the read-only guarantee the lane is built on.
  test("carries the whole PRD read-only allowlist and nothing that mutates", () => {
    expect([...PROGRAM_TOOL_ALLOWLIST]).toEqual([
      "fs.read",
      "fs.read_many",
      "fs.list",
      "fs.glob",
      "fs.search",
      "git.status",
      "git.diff",
      "git.log",
      "repo.investigate",
      "lsp.diagnostics",
      "lsp.symbols",
      "lsp.references",
      "lsp.definition",
      "lsp.implementation",
      "artifact.read",
    ]);

    for (const toolId of PROGRAM_TOOL_ALLOWLIST) {
      expect(validateProgramToolCall({
        callId: `call_${toolId}`,
        toolId,
        arguments: {},
        callerId: "call_prog_1",
        taskEpochId: "epoch-1",
      })).toMatchObject({ allowed: true, normalizedToolId: toolId });
    }

    for (const toolId of ["fs.write", "fs.edit", "fs.delete", "process.run", "shell.run", "user.ask", "lsp.rename_preview"]) {
      expect(validateProgramToolCall({
        callId: "call_denied",
        toolId,
        arguments: {},
        callerId: "call_prog_1",
        taskEpochId: "epoch-1",
      }).allowed).toBe(false);
    }
  });
});
