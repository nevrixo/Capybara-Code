import { describe, expect, test } from "bun:test";

import { decideRecovery, findTool } from "../src/index.ts";

describe("tool recovery decision matrix", () => {
  test("retries pure transient failures", () => {
    const tool = findTool("fs.read");
    expect(tool).toBeDefined();
    expect(decideRecovery({ tool: tool!, failure: { code: "TIMEOUT", retryable: true }, attempt: 1 })).toMatchObject({
      recoveryClass: "transient_safe_replay",
      retry: true,
      terminal: false,
    });
  });

  test("never replays permission denial or command failure", () => {
    const tool = findTool("fs.read");
    expect(decideRecovery({ tool: tool!, failure: { code: "PERMISSION_DENIED", retryable: true }, attempt: 1 }).recoveryClass).toBe("terminal");
    expect(decideRecovery({ tool: findTool("process.run")!, failure: { code: "PROCESS_EXIT_NONZERO", retryable: false }, attempt: 1 }).retry).toBe(false);
  });

  test("routes mutation timeout to reconciliation instead of replay", () => {
    const decision = decideRecovery({
      tool: findTool("process.run")!,
      failure: { code: "TIMEOUT", retryable: true, details: { jobId: "job-1" } },
      attempt: 1,
    });
    expect(decision).toMatchObject({ recoveryClass: "unknown_outcome_reconcile", reconcile: true, retry: false });
  });

  test("marks TODO revision conflicts as state rebase", () => {
    const decision = decideRecovery({
      tool: findTool("todo.write")!,
      failure: { code: "TODO_REVISION_CONFLICT", retryable: true },
      attempt: 1,
    });
    expect(decision).toMatchObject({ recoveryClass: "state_rebase", retry: true });
  });

  test("fences PATH_CHANGED before replaying a pure read", () => {
    const decision = decideRecovery({
      tool: findTool("fs.read")!,
      failure: {
        code: "PATH_CHANGED",
        retryable: true,
        details: { path: "src/a.ts", generationBefore: 10, generationAfter: 11 },
      },
      attempt: 1,
    });
    expect(decision).toMatchObject({ recoveryClass: "state_fence_wait", retry: true, terminal: false });
  });
});