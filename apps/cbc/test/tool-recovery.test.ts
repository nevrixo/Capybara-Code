import { describe, expect, test } from "bun:test";

import type { ProposedAction } from "@cbc/permissions";
import { errorResult, findTool, okResult } from "@cbc/tool-registry";

import { executeWithRecovery } from "../src/tool-recovery.ts";

const signal = new AbortController().signal;

function action(toolId: string, callId = "call-1"): ProposedAction {
  return { callId, toolId, arguments: {}, display: toolId };
}

describe("logical tool recovery runner", () => {
  test("replays a pure transient failure without duplicating visible lifecycle", async () => {
    const tool = findTool("fs.read");
    expect(tool).toBeDefined();
    let attempts = 0;
    const events: string[] = [];
    const executor = {
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? { result: errorResult("TIMEOUT", "temporary read timeout", { retryable: true }) }
          : { result: okResult("read succeeded") };
      },
    };

    const execution = await executeWithRecovery(executor, tool!, action("fs.read"), signal, {
      sessionId: "session-1",
      sleep: async () => {},
      emit: (kind) => events.push(kind),
    });

    expect(attempts).toBe(2);
    expect(execution.result.ok).toBe(true);
    expect(events).toEqual(["tool.attempt_failed", "tool.recovery_applied"]);
  });

  test("does not retry permission denial", async () => {
    const tool = findTool("fs.read");
    expect(tool).toBeDefined();
    let attempts = 0;
    const events: string[] = [];
    const executor = {
      execute: async () => {
        attempts += 1;
        return { result: errorResult("PERMISSION_DENIED", "denied", { retryable: true }) };
      },
    };

    const execution = await executeWithRecovery(executor, tool!, action("fs.read"), signal, {
      sleep: async () => {},
      emit: (kind) => events.push(kind),
    });

    expect(attempts).toBe(1);
    expect(execution.result.error?.code).toBe("PERMISSION_DENIED");
    expect(events).toEqual(["tool.attempt_failed"]);
  });

  test("reconciles a process timeout instead of replaying it", async () => {
    const tool = findTool("process.run");
    expect(tool).toBeDefined();
    let attempts = 0;
    const events: string[] = [];
    const executor = {
      execute: async () => {
        attempts += 1;
        return { result: errorResult("TIMEOUT", "process timed out", { retryable: true, details: { jobId: "job-1" } }) };
      },
    };

    const execution = await executeWithRecovery(executor, tool!, action("process.run"), signal, {
      emit: (kind) => events.push(kind),
      reconcile: async () => ({ result: okResult("job completed", { jobId: "job-1" }) }),
    });

    expect(attempts).toBe(1);
    expect(execution.result.ok).toBe(true);
    expect(events).toEqual(["tool.attempt_failed", "tool.reconciled"]);
  });

  test("rebases a TODO revision conflict once", async () => {
    const tool = findTool("todo.write");
    expect(tool).toBeDefined();
    const expectedRevisions: unknown[] = [];
    const events: string[] = [];
    const executor = {
      execute: async (next: ProposedAction) => {
        expectedRevisions.push(next.arguments.expectedRevision);
        return expectedRevisions.length === 1
          ? { result: errorResult("TODO_REVISION_CONFLICT", "stale", { retryable: true, details: { currentRevision: 4 } }) }
          : { result: okResult("todo updated") };
      },
    };

    const execution = await executeWithRecovery(executor, tool!, action("todo.write"), signal, {
      sleep: async () => {},
      emit: (kind) => events.push(kind),
      rebase: ({ action: stale }) => ({ ...stale, arguments: { ...stale.arguments, expectedRevision: 4 } }),
    });

    expect(expectedRevisions).toEqual([undefined, 4]);
    expect(execution.result.ok).toBe(true);
    expect(events).toEqual(["tool.attempt_failed", "tool.recovery_applied"]);
  });
});
