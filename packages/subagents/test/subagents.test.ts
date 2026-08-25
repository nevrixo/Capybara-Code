/**
 * Subagent tests — PRD §15, §25.11, AC-21, AC-22, AC-23, AC-24, AC-25,
 * SUB-001..SUB-007.
 */

import { describe, expect, test } from "bun:test";

import type { CbcEventKind } from "@cbc/protocol";

import {
  ROLE_DEFINITIONS,
  SUBAGENT_LIMITS,
  SUBAGENT_ROLES,
  SubagentScheduler,
  SpawnRejected,
  blockingFindings,
  overlappingGlobs,
  buildTask,
  decideDelegation,
  defaultDelegationSignals,
  emptyChildResult,
  isTooBroad,
  mergeExplorations,
  parseCustomAgent,
  renderAgentCandidates,
  renderTaskCard,
  renderTaskContract,
  resolveCustomAgents,
  searchAgents,
  splitFrontmatter,
  validateTask,
  verifyChildResult,
  type ChildAgentResult,
  type ChildRunner,
  type CustomAgentDefinition,
  type RuntimeEvidence,
  type SubagentRole,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Recorded {
  kind: CbcEventKind;
  payload: unknown;
  agentId?: string;
}

function scheduler(
  runner: ChildRunner,
  overrides: Partial<Parameters<typeof makeOptions>[1]> = {},
) {
  const events: Recorded[] = [];
  const options = makeOptions(runner, { events, ...overrides });
  return { scheduler: new SubagentScheduler(options), events };
}

function makeOptions(
  runner: ChildRunner,
  extras: {
    events: Recorded[];
    parentContextTokens?: number;
    parentDepth?: number;
    maxConcurrent?: number;
    maxChildrenPerTurn?: number;
    now?: () => number;
  },
) {
  return {
    runner,
    emitter: {
      emit: <T>(kind: CbcEventKind, payload: T, opts?: { agentId?: string }) => {
        extras.events.push({
          kind,
          payload,
          ...(opts?.agentId !== undefined ? { agentId: opts.agentId } : {}),
        });
      },
    },
    parentContextTokens: extras.parentContextTokens ?? 96_000,
    parentDepth: extras.parentDepth ?? 0,
    parentAgentId: "root",
    ...(extras.maxConcurrent !== undefined ? { maxConcurrent: extras.maxConcurrent } : {}),
    ...(extras.maxChildrenPerTurn !== undefined
      ? { maxChildrenPerTurn: extras.maxChildrenPerTurn }
      : {}),
    ...(extras.now !== undefined ? { now: extras.now } : {}),
  };
}

function exploreTask(overrides: Record<string, unknown> = {}) {
  return buildTask(
    {
      title: "Survey",
      goal: "Locate every call site of parseConfig and summarize what each one expects.",
      ...overrides,
    },
    "explore",
  );
}

function executorTask(overrides: Record<string, unknown> = {}) {
  return buildTask(
    {
      title: "PythonDemo",
      goal: "Create one standalone Python script that prints a greeting and a timestamp.",
      constraints: ["MUST create only scripts/demo.py.", "MUST NOT install dependencies."],
      expectedOutput: ["Return the created path.", "Return the syntax-check result."],
      allowedPaths: ["scripts/demo.py"],
      verification: ["python3 -m py_compile scripts/demo.py"],
      ...overrides,
    },
    "executor",
  );
}

const okRunner: ChildRunner = async () => ({
  ...emptyChildResult("completed", "did the thing"),
});

function kinds(events: Recorded[]): CbcEventKind[] {
  return events.map((e) => e.kind);
}

// ---------------------------------------------------------------------------
// §15.4 task contract / SUB-002
// ---------------------------------------------------------------------------

describe("task contract (§15.4, SUB-002)", () => {
  test("the §15.4 invalid example is refused", () => {
    expect(isTooBroad("Fix the repo.")).toBe(true);
    expect(isTooBroad("fix the repository")).toBe(true);
    expect(isTooBroad("Make it work")).toBe(true);
    expect(isTooBroad("Add a --json flag to the export command.")).toBe(false);
  });

  test("a too-broad goal fails validation", () => {
    const task = buildTask({ title: "T", goal: "Fix the repo................." }, "explore");
    const result = validateTask(task, "explore");
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("too broad"))).toBe(true);
  });

  test("a short goal is rejected as unactionable", () => {
    const result = validateTask(buildTask({ title: "T", goal: "do it" }, "explore"), "explore");
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "goal")).toBe(true);
  });

  test("an executor without constraints or contract is completed from the scoped goal (SUB-002)", () => {
    const task = buildTask(
      {
        title: "T",
        goal: "Add a retry to the upload path so transient failures recover.",
        allowedPaths: ["src/upload.ts"],
      },
      "executor",
    );
    const result = validateTask(task, "executor");
    expect(result.ok).toBe(true);
    expect(task.constraints.length).toBeGreaterThan(0);
    expect(task.expectedOutput.length).toBeGreaterThan(0);
    expect(task.allowedPaths).toEqual(["src/upload.ts"]);
  });

  test("an executor spawn infers write scope from mentioned files", () => {
    const task = buildTask(
      {
        title: "Landing",
        goal: "Build the landing page UI in index.html and landing.css with a clear CTA.",
      },
      "executor",
    );
    expect(validateTask(task, "executor").ok).toBe(true);
    expect(task.allowedPaths).toEqual(["index.html", "landing.css"]);
  });

  test("an executor spawn uses the matching Plan item files as its lease", () => {
    const task = buildTask(
      {
        title: "렌딩 페이지 UI를 제작한다",
        goal: "브랜드 히어로, 게임 소개, CTA, 반응형 스타일을 구현합니다.",
      },
      "executor",
      [
        {
          id: "inspect",
          text: "기존 HTML 구조와 실행 방법을 확인한다",
          files: ["index.html"],
          status: "done",
        },
        {
          id: "landing",
          text: "렌딩 페이지 UI를 제작한다",
          details: "브랜드 히어로, 게임 소개, CTA, 반응형 스타일을 구현합니다.",
          files: ["index.html", "landing.css"],
          acceptanceCriteria: ["첫 화면에서 게임 가치 제안과 CTA가 명확함"],
          status: "active",
        },
      ],
    );
    expect(validateTask(task, "executor").ok).toBe(true);
    expect(task.allowedPaths).toEqual(["index.html", "landing.css"]);
    expect(task.expectedOutput).toContain("첫 화면에서 게임 가치 제안과 CTA가 명확함");
  });

  test("a read-only role does not need an explicit contract", () => {
    expect(validateTask(exploreTask(), "explore").ok).toBe(true);
  });

  test("a writer needs at least one allowed path", () => {
    const task = buildTask(
      {
        title: "T",
        goal: "Add a retry to the upload path so transient failures recover.",
        constraints: ["only touch upload"],
        expectedOutput: ["report the path"],
      },
      "executor",
    );
    expect(validateTask(task, "executor").issues.some((i) => i.field === "allowedPaths")).toBe(true);
  });

  test("a read-only role cannot be granted write paths", () => {
    const task = buildTask({ ...exploreTask(), allowedPaths: ["src/a.ts"] }, "explore");
    const result = validateTask(task, "explore");
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("read-only role"))).toBe(true);
  });

  test("a workspace-wide lease glob is not a scope", () => {
    for (const glob of ["**", "**/*", "*"]) {
      const result = validateTask(executorTask({ allowedPaths: [glob] }), "executor");
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.message.includes("whole workspace"))).toBe(true);
    }
  });

  test("a lease glob may not escape the workspace", () => {
    const result = validateTask(executorTask({ allowedPaths: ["../outside.ts"] }), "executor");
    expect(result.issues.some((i) => i.message.includes("'..'"))).toBe(true);
  });

  test("the deadline is clamped to the role ceiling", () => {
    const task = buildTask({ ...exploreTask(), deadlineMs: 60 * 60 * 1000 }, "explore");
    expect(task.deadlineMs).toBe(ROLE_DEFINITIONS.explore.maxDurationMs);
    expect(validateTask(task, "explore").ok).toBe(true);
  });

  test("the rendered contract uses the §6.10 headings", () => {
    const text = renderTaskContract(executorTask());
    expect(text).toContain("# Goal");
    expect(text).toContain("# Constraints");
    expect(text).toContain("# Contract");
    expect(text).toContain("# Write scope");
    expect(text).toContain("# Verification");
  });
});

// ---------------------------------------------------------------------------
// §15.7 limits, §15.8 leases
// ---------------------------------------------------------------------------

describe("scheduler limits (§15.7)", () => {
  test("a spawn emits a task card with goal, constraints, and contract (SUB-001)", async () => {
    const { scheduler: s, events } = scheduler(okRunner);
    s.spawn({ role: "executor", task: executorTask() });
    await s.settleAll();

    const created = events.find((e) => e.kind === "task.created")?.payload as {
      goal: string;
      constraints: string[];
      contract: string[];
      writeLease?: string[];
    };
    expect(created.goal).toContain("standalone Python script");
    expect(created.constraints.length).toBeGreaterThan(0);
    expect(created.contract.length).toBeGreaterThan(0);
    expect(created.writeLease).toEqual(["scripts/demo.py"]);
  });

  test("task.started carries its timestamp for live elapsed time", async () => {
    const { scheduler: s, events } = scheduler(okRunner, { now: () => 12_345 });
    s.spawn({ role: "explore", task: exploreTask() });
    await s.settleAll();

    const started = events.find((event) => event.kind === "task.started");
    expect(started).toBeDefined();
    expect((started?.payload as { startTimeMs?: number }).startTimeMs).toBe(12_345);
  });

  test("an invalid task never spawns (SUB-002)", () => {
    const { scheduler: s, events } = scheduler(okRunner);
    expect(() => s.spawn({ role: "executor", task: buildTask({ title: "T", goal: "Fix the repo." }, "executor") }))
      .toThrow(SpawnRejected);
    expect(s.list()).toHaveLength(0);
    expect(kinds(events)).not.toContain("task.created");
  });

  test("a nested spawn beyond depth 1 is refused (SUB-007)", () => {
    // A child scheduler has parentDepth 1, so its children would be depth 2.
    const { scheduler: s } = scheduler(okRunner, { parentDepth: SUBAGENT_LIMITS.maxDepth });
    try {
      s.spawn({ role: "explore", task: exploreTask() });
      throw new Error("expected the spawn to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnRejected);
      expect((error as SpawnRejected).code).toBe("DEPTH_EXCEEDED");
    }
  });

  test("child registration is not capped per turn, including for legacy options", async () => {
    const { scheduler: s } = scheduler(okRunner, { maxChildrenPerTurn: 2 });
    s.beginTurn();
    for (let index = 0; index < 6; index += 1) {
      expect(() => s.spawn({ role: "explore", task: exploreTask() })).not.toThrow();
    }

    await s.settleAll();
    expect(s.list()).toHaveLength(6);
    s.beginTurn();
    expect(() => s.spawn({ role: "reviewer", task: exploreTask() })).not.toThrow();
    await s.settleAll();
  });

  test("concurrency overflow waits in FIFO order instead of rejecting spawns", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const slowRunner: ChildRunner = async ({ instance }) => {
      started.push(instance.id);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.set(instance.id, resolve));
      active -= 1;
      return emptyChildResult("completed", "done");
    };

    const { scheduler: s, events } = scheduler(slowRunner, { maxConcurrent: 1 });
    const first = s.spawn({ role: "explore", task: exploreTask() });
    const second = s.spawn({ role: "reviewer", task: exploreTask() });
    const third = s.spawn({ role: "test", task: exploreTask() });
    await Promise.resolve();

    expect(started).toEqual([first.id]);
    expect(s.runningCount()).toBe(1);
    expect(second.instance.state).toBe("queued");
    expect(third.instance.state).toBe("queued");
    expect(events.some((event) => JSON.stringify(event.payload).includes("provider slot"))).toBe(true);

    releases.get(first.id)?.();
    await s.await(first.id);
    await Promise.resolve();
    expect(started).toEqual([first.id, second.id]);

    releases.get(second.id)?.();
    await s.await(second.id);
    await Promise.resolve();
    expect(started).toEqual([first.id, second.id, third.id]);

    releases.get(third.id)?.();
    await s.settleAll();
    expect(peak).toBe(1);
    expect(s.runningCount()).toBe(0);
  });

  test("cancelling a queued child removes it without leaking a provider slot", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const runner: ChildRunner = async ({ instance }) => {
      started.push(instance.id);
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return emptyChildResult("completed", "done");
    };

    const { scheduler: s } = scheduler(runner, { maxConcurrent: 1 });
    const first = s.spawn({ role: "explore", task: exploreTask() });
    const queued = s.spawn({ role: "reviewer", task: exploreTask() });
    expect(queued.instance.state).toBe("queued");

    expect((await s.cancel(queued.id, "no longer needed"))?.status).toBe("cancelled");
    expect(started).toEqual([first.id]);
    expect(s.runningCount()).toBe(1);

    releaseFirst?.();
    await s.await(first.id);
    const replacement = s.spawn({ role: "test", task: exploreTask() });
    expect((await s.await(replacement.id))?.status).toBe("completed");
    expect(started).toEqual([first.id, replacement.id]);
    expect(s.runningCount()).toBe(0);
  });

  test("direct embedders cannot exceed the eight-runner safety ceiling", async () => {
    const releases = new Map<string, () => void>();
    const runner: ChildRunner = async ({ instance }) => {
      await new Promise<void>((resolve) => releases.set(instance.id, resolve));
      return emptyChildResult("completed", "done");
    };
    const { scheduler: s } = scheduler(runner, { maxConcurrent: 99 });
    const handles = Array.from({ length: 9 }, () =>
      s.spawn({ role: "explore", task: exploreTask() })
    );

    expect(s.runningCount()).toBe(SUBAGENT_LIMITS.maxConcurrent);
    expect(handles[8]?.instance.state).toBe("queued");
    for (const handle of handles.slice(0, 8)) releases.get(handle.id)?.();
    await Promise.all(handles.slice(0, 8).map((handle) => s.await(handle.id)));
    await Promise.resolve();

    const ninth = handles[8];
    expect(ninth).toBeDefined();
    if (ninth !== undefined) {
      releases.get(ninth.id)?.();
      expect((await s.await(ninth.id))?.status).toBe("completed");
    }
    expect(s.runningCount()).toBe(0);
  });

  test("aggregate context is telemetry and does not reject additional children", async () => {
    const { scheduler: s } = scheduler(okRunner, { parentContextTokens: 96_000 });
    expect(s.aggregateContextBudget()).toBe(48_000);

    const first = s.spawn({ role: "explore", task: exploreTask() });
    await s.settleAll();
    s.recordChildUsage(first.id, 48_000);
    expect(s.consumedContextTokens).toBe(48_000);
    expect(s.availableContextTokens).toBe(0);

    for (let index = 0; index < 6; index += 1) {
      expect(() => s.spawn({ role: "reviewer", task: exploreTask() })).not.toThrow();
    }
    await s.settleAll();
  });

  test("usage from an unknown agent is ignored", () => {
    const { scheduler: s } = scheduler(okRunner);
    s.recordChildUsage("agent_does_not_exist", 10_000);
    expect(s.consumedContextTokens).toBe(0);
  });

  test("only one writer may hold a lease (AC-23, SUB-003, P6)", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowRunner: ChildRunner = async () => {
      await blocked;
      return emptyChildResult("completed", "done");
    };

    const { scheduler: s } = scheduler(slowRunner);
    s.spawn({ role: "executor", task: executorTask() });
    expect(s.writerLease?.pathGlobs).toEqual(["scripts/demo.py"]);

    try {
      s.spawn({ role: "executor", task: executorTask({ allowedPaths: ["src/other.ts"] }) });
      throw new Error("expected a writer-busy rejection");
    } catch (error) {
      expect((error as SpawnRejected).code).toBe("WRITER_BUSY");
    }

    release?.();
    await s.settleAll();
  });

  test("releasing a lease frees the slot for the next writer", async () => {
    const { scheduler: s } = scheduler(okRunner);
    const handle = s.spawn({ role: "executor", task: executorTask() });
    await s.settleAll();
    s.releaseLease(handle.id);
    expect(s.writerLease).toBeUndefined();
    expect(() => s.spawn({ role: "executor", task: executorTask() })).not.toThrow();
  });

  test("a path changed outside the lease is a conflict, not a silent overwrite (§15.8)", async () => {
    const runner: ChildRunner = async () => ({
      ...emptyChildResult("completed", "wrote the script"),
      filesChanged: [{ path: "scripts/demo.py", afterHash: "new", summary: "created" }],
    });
    const { scheduler: s, events } = scheduler(runner);
    const handle = s.spawn({
      role: "executor",
      task: executorTask({ allowedPaths: ["scripts/demo.py", "scripts/helper.py"] }),
      baseline: [
        { path: "scripts/demo.py", hash: "old" },
        { path: "scripts/helper.py", hash: "keep" },
      ],
    });
    await s.settleAll();

    const reconciliation = s.releaseLease(handle.id, [
      { path: "scripts/demo.py", hash: "new" },
      // Changed by someone else while the lease was held.
      { path: "scripts/helper.py", hash: "external-edit" },
    ]);
    expect(reconciliation.changed).toContain("scripts/demo.py");
    expect(reconciliation.conflicted).toContain("scripts/helper.py");
    expect(kinds(events)).toContain("transaction.conflicted");
    expect(s.get(handle.id)?.state).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// §6.11 await vs cancel — AC-21, AC-22, SUB-005
// ---------------------------------------------------------------------------

describe("await interruption and cancellation (§6.11, AC-21, AC-22)", () => {
  test("interrupting the await leaves the child running (AC-21)", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ChildRunner = async () => {
      await blocked;
      return emptyChildResult("completed", "finished after the await was dropped");
    };

    const { scheduler: s, events } = scheduler(runner);
    const handle = s.spawn({ role: "explore", task: exploreTask() });

    const controller = new AbortController();
    controller.abort();
    const interrupted = await s.await(handle.id, controller.signal);

    expect(interrupted).toBeUndefined();
    expect(s.get(handle.id)?.awaitInterrupted).toBe(true);
    // The child is still alive, not cancelled.
    expect(s.get(handle.id)?.state).toBe("running");
    expect(kinds(events)).toContain("task.await_interrupted");
    const payload = events.find((e) => e.kind === "task.await_interrupted")?.payload as {
      message: string;
    };
    expect(payload.message).toContain("this subagent continues");

    // It still completes on its own (AC-25 background completion).
    release?.();
    const settled = await s.settleAll();
    expect(settled.get(handle.id)?.status).toBe("completed");
    expect(kinds(events)).toContain("task.completed");
  });

  test("an explicit cancel aborts the child's signal (AC-22)", async () => {
    let observed: AbortSignal | undefined;
    const runner: ChildRunner = async ({ signal }) => {
      observed = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cancelled mid-flight");
    };

    const { scheduler: s, events } = scheduler(runner);
    const handle = s.spawn({ role: "explore", task: exploreTask() });
    const result = await s.cancel(handle.id, "user cancelled the task");

    expect(observed?.aborted).toBe(true);
    expect(result?.status).toBe("cancelled");
    expect(s.get(handle.id)?.state).toBe("cancelled");
    expect(kinds(events)).toContain("task.cancelled");
  });

  test("cancellation state is visible before teardown finishes (SUB-005)", async () => {
    const runner: ChildRunner = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => setTimeout(resolve, 50), { once: true });
      });
      return emptyChildResult("cancelled", "torn down");
    };
    const { scheduler: s } = scheduler(runner);
    const handle = s.spawn({ role: "explore", task: exploreTask() });

    const pending = s.cancel(handle.id, "interrupt");
    // The state flips synchronously; the caller does not wait for teardown.
    expect(s.get(handle.id)?.state).toBe("cancelled");
    await pending;
  });

  test("a root cancellation propagates to every live child (§15.12)", async () => {
    const runner: ChildRunner = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return emptyChildResult("cancelled", "stopped");
    };
    const { scheduler: s } = scheduler(runner, { maxConcurrent: 3 });
    s.spawn({ role: "explore", task: exploreTask() });
    s.spawn({ role: "planner", task: buildTask({ title: "P", goal: "Plan the migration in ordered steps." }, "planner") });

    await s.cancelAll("root cancelled");
    expect(s.activeCount()).toBe(0);
    for (const instance of s.list()) expect(instance.state).toBe("cancelled");
  });

  test("a runner that throws yields a failed result, not an unhandled rejection", async () => {
    const runner: ChildRunner = async () => {
      throw new Error("provider exploded");
    };
    const { scheduler: s } = scheduler(runner);
    const handle = s.spawn({ role: "explore", task: exploreTask() });
    const result = await s.await(handle.id);
    expect(result?.status).toBe("failed");
    expect(result?.summary).toContain("provider exploded");
    expect(s.get(handle.id)?.state).toBe("failed");
  });

  test("a child that overruns its deadline is blocked, not hung (§15.12)", async () => {
    const runner: ChildRunner = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("deadline exceeded");
    };
    const { scheduler: s } = scheduler(runner);
    const task = buildTask({ ...exploreTask(), deadlineMs: 10 }, "explore");
    const handle = s.spawn({ role: "explore", task });
    const result = await s.await(handle.id);
    expect(result?.status).toBe("blocked");
    expect(result?.summary).toContain("deadline");
  });
});

// ---------------------------------------------------------------------------
// §15.9 context isolation — SUB-004
// ---------------------------------------------------------------------------

describe("context isolation (§15.9, SUB-004)", () => {
  test("the child receives its role brief and contract, never a parent transcript", async () => {
    let seen: { roleInstructions: string; taskDescription: string } | undefined;
    const runner: ChildRunner = async ({ roleInstructions, taskDescription }) => {
      seen = { roleInstructions, taskDescription };
      return emptyChildResult("completed", "ok");
    };
    const { scheduler: s } = scheduler(runner);
    s.spawn({ role: "reviewer", task: exploreTask() });
    await s.settleAll();

    expect(seen?.roleInstructions).toContain("independent reviewer");
    expect(seen?.taskDescription).toContain("# Goal");
    // The run context exposes no channel for the parent's conversation.
    expect(Object.keys(seen ?? {})).toEqual(["roleInstructions", "taskDescription"]);
  });

  test("a reviewer is not told how the change was reasoned about (§11.9)", () => {
    expect(ROLE_DEFINITIONS.reviewer.instructions).toContain("not told how the change was reasoned");
  });
});

// ---------------------------------------------------------------------------
// §15.11 parent synthesis — SUB-006
// ---------------------------------------------------------------------------

describe("parent synthesis (§15.11, SUB-006)", () => {
  function evidence(overrides: Partial<RuntimeEvidence> = {}): RuntimeEvidence {
    return {
      fileHashes: new Map(),
      commandExits: new Map(),
      ...overrides,
    };
  }

  test("a matching file claim is verified against the runtime hash", () => {
    const result: ChildAgentResult = {
      ...emptyChildResult("completed", "patched"),
      filesChanged: [{ path: "src/a.ts", afterHash: "hash-1", summary: "fix" }],
    };
    const synthesis = verifyChildResult(
      result,
      evidence({ fileHashes: new Map([["src/a.ts", "hash-1"]]) }),
    );
    expect(synthesis.files[0]?.status).toBe("verified");
    expect(synthesis.trustworthy).toBe(true);
    expect(synthesis.result.status).toBe("completed");
  });

  test("a file the runtime never touched contradicts the claim (SUB-006)", () => {
    const result: ChildAgentResult = {
      ...emptyChildResult("completed", "patched"),
      filesChanged: [{ path: "src/ghost.ts", afterHash: "x", summary: "fix" }],
    };
    const synthesis = verifyChildResult(result, evidence());
    expect(synthesis.files[0]?.status).toBe("contradicted");
    expect(synthesis.trustworthy).toBe(false);
    // A claimed success on unverifiable evidence is downgraded (AC-50).
    expect(synthesis.result.status).toBe("blocked");
    expect(synthesis.result.openRisks.some((r) => r.includes("could not be confirmed"))).toBe(true);
  });

  test("a hash mismatch is reported with both values", () => {
    const result: ChildAgentResult = {
      ...emptyChildResult("completed", "patched"),
      filesChanged: [{ path: "src/a.ts", afterHash: "claimed", summary: "fix" }],
    };
    const synthesis = verifyChildResult(
      result,
      evidence({ fileHashes: new Map([["src/a.ts", "actual"]]) }),
    );
    expect(synthesis.files[0]?.status).toBe("contradicted");
    expect(synthesis.discrepancies[0]).toContain("actual");
  });

  test("a command exit is checked against the process event", () => {
    const result: ChildAgentResult = {
      ...emptyChildResult("completed", "tested"),
      commandsRun: [{ display: "bun test", exitCode: 0 }],
    };
    const good = verifyChildResult(result, evidence({ commandExits: new Map([["bun test", 0]]) }));
    expect(good.commands[0]?.status).toBe("verified");

    const lying = verifyChildResult(result, evidence({ commandExits: new Map([["bun test", 1]]) }));
    expect(lying.commands[0]?.status).toBe("contradicted");
    expect(lying.result.status).toBe("blocked");
  });

  test("a command with no process event at all is contradicted", () => {
    const result: ChildAgentResult = {
      ...emptyChildResult("completed", "claims it ran the suite"),
      commandsRun: [{ display: "bun test", exitCode: 0 }],
    };
    const synthesis = verifyChildResult(result, evidence());
    expect(synthesis.commands[0]?.status).toBe("contradicted");
    expect(synthesis.discrepancies[0]).toContain("no process event");
  });

  test("a dangling artifact reference is dropped", () => {
    const result: ChildAgentResult = {
      ...emptyChildResult("completed", "ok"),
      evidence: [
        { kind: "artifact", label: "log", locator: "art_missing" },
        { kind: "file", label: "source", locator: "src/a.ts" },
      ],
    };
    const synthesis = verifyChildResult(
      result,
      evidence({ artifactIds: new Set(["art_real"]) }),
    );
    expect(synthesis.result.evidence.map((e) => e.locator)).toEqual(["src/a.ts"]);
    expect(synthesis.discrepancies.some((d) => d.includes("art_missing"))).toBe(true);
  });

  test("a non-completed status is preserved rather than promoted", () => {
    const synthesis = verifyChildResult(emptyChildResult("failed", "nope"), evidence());
    expect(synthesis.result.status).toBe("failed");
  });

  test("duplicate exploration is merged and conflicts are surfaced", () => {
    const merged = mergeExplorations([
      {
        agentId: "agent_1",
        result: {
          ...emptyChildResult("completed", "found it in parser.ts"),
          evidence: [{ kind: "file", label: "site", locator: "src/parser.ts", detail: "line 12" }],
          openRisks: ["shared risk"],
        },
      },
      {
        agentId: "agent_2",
        result: {
          ...emptyChildResult("completed", "found it in parser.ts too"),
          evidence: [{ kind: "file", label: "site", locator: "src/parser.ts", detail: "line 40" }],
          openRisks: ["shared risk"],
        },
      },
    ]);

    // One deduplicated evidence entry...
    expect(merged.evidence).toHaveLength(1);
    // ...but the disagreement about *where* is reported, not resolved.
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.agents).toEqual(["agent_1", "agent_2"]);
    expect(merged.conflicts[0]?.details).toEqual(["line 12", "line 40"]);
    expect(merged.openRisks).toEqual(["shared risk"]);
    expect(merged.summaries).toHaveLength(2);
  });

  test("agreeing children produce no conflict", () => {
    const merged = mergeExplorations([
      {
        agentId: "a",
        result: {
          ...emptyChildResult("completed", "x"),
          evidence: [{ kind: "file", label: "s", locator: "src/a.ts", detail: "line 1" }],
        },
      },
      {
        agentId: "b",
        result: {
          ...emptyChildResult("completed", "y"),
          evidence: [{ kind: "file", label: "s", locator: "src/a.ts", detail: "line 1" }],
        },
      },
    ]);
    expect(merged.conflicts).toHaveLength(0);
  });

  test("only severe findings with evidence can block", () => {
    const summary = blockingFindings({
      ...emptyChildResult("completed", "reviewed"),
      findings: [
        { severity: "critical", title: "null deref", evidence: "a.ts:12", recommendation: "guard" },
        { severity: "high", title: "no evidence", evidence: "  ", recommendation: "x" },
        { severity: "low", title: "style", evidence: "b.ts:1", recommendation: "rename" },
      ],
    });
    expect(summary.blocking.map((f) => f.title)).toEqual(["null deref"]);
    expect(summary.rejected).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §15.5 delegation, §15.6 discovery
// ---------------------------------------------------------------------------

describe("delegation decision (§15.5)", () => {
  test("an explicit user request delegates (SUB-001)", () => {
    const decision = decideDelegation({
      ...defaultDelegationSignals(),
      userRequestedSubagent: true,
      // Even though the work itself looks small.
      singleFileEdit: true,
      setupCostExceedsWork: true,
    });
    expect(decision.delegate).toBe(true);
    expect(decision.suggestedRoles).toContain("executor");
  });

  test("needing clarification refuses even an explicit request", () => {
    const decision = decideDelegation({
      ...defaultDelegationSignals(),
      userRequestedSubagent: true,
      needsUserClarificationFirst: true,
    });
    expect(decision.delegate).toBe(false);
  });

  test("two writers on one file refuses even an explicit request (P6)", () => {
    const decision = decideDelegation({
      ...defaultDelegationSignals(),
      userRequestedSubagent: true,
      needsConcurrentWriteToSameFile: true,
    });
    expect(decision.delegate).toBe(false);
    expect(decision.reasons[0]).toContain("single-writer");
  });

  test("a single-file edit is done directly", () => {
    const decision = decideDelegation({ ...defaultDelegationSignals(), singleFileEdit: true });
    expect(decision.delegate).toBe(false);
  });

  test("independent areas and review-worthiness suggest roles", () => {
    const decision = decideDelegation({
      ...defaultDelegationSignals(),
      independentAreas: 3,
      reviewWorthy: true,
      separableTests: true,
    });
    expect(decision.delegate).toBe(true);
    expect(decision.suggestedRoles).toEqual(["explore", "test", "reviewer"]);
  });

  test("an exhausted budget refuses delegation", () => {
    const decision = decideDelegation({
      ...defaultDelegationSignals(),
      independentAreas: 3,
      budgetNearlyExhausted: true,
    });
    expect(decision.delegate).toBe(false);
  });
});

describe("agent discovery (§15.6)", () => {
  test("a delegation query ranks the executor and task roles first", () => {
    const candidates = searchAgents("implement a small python script");
    expect(candidates[0]?.role).toBe("executor");
    expect(candidates[0]?.suitability).toBeGreaterThan(0);
  });

  test("a review query ranks the reviewer first", () => {
    expect(searchAgents("review the current diff for regressions")[0]?.role).toBe("reviewer");
  });

  test("a search query ranks explore first", () => {
    expect(searchAgents("search the repository to locate the call sites")[0]?.role).toBe("explore");
  });

  test("the result count honours the limit", () => {
    expect(searchAgents("test", { limit: 2 })).toHaveLength(2);
  });

  test("custom agents join the candidate list", () => {
    const candidates = searchAgents("review database migrations", {
      customAgents: [
        {
          name: "database-reviewer",
          description: "Reviews schema and migration changes for data loss.",
          permissionClass: "read",
        },
      ],
      limit: 5,
    });
    expect(candidates.map((c) => c.role)).toContain("database-reviewer");
  });

  test("suitability is presented as a ranking score, not confidence", () => {
    const rendered = renderAgentCandidates("delegate work", searchAgents("delegate work"), {
      total: 5,
      active: 2,
    });
    expect(rendered[0]).toContain("Agent Discovery");
    expect(rendered.join("\n")).toContain("score");
    expect(rendered.join("\n")).not.toContain("confidence");
  });
});

// ---------------------------------------------------------------------------
// §15.13 custom agents
// ---------------------------------------------------------------------------

describe("custom agents (§15.13)", () => {
  const valid = `---
name: database-reviewer
description: Reviews schema and migration changes.
mode: subagent
base_role: reviewer
model_profile: review
permissions: read
max_tools: 12
---

Focus on data loss, lock duration, rollback, and compatibility.
Return only actionable findings with file/line evidence.
`;

  test("frontmatter splits into fields and body", () => {
    const parsed = splitFrontmatter(valid);
    expect(parsed?.fields.name).toBe("database-reviewer");
    expect(parsed?.fields.permissions).toBe("read");
    expect(parsed?.body).toContain("Focus on data loss");
  });

  test("a file with no frontmatter is rejected", () => {
    const result = parseCustomAgent("no frontmatter here", {
      path: "a.md",
      source: "user",
      trusted: true,
    });
    expect(result.definition).toBeUndefined();
    expect(result.issues[0]?.field).toBe("frontmatter");
  });

  test("the §15.13 example parses", () => {
    const result = parseCustomAgent(valid, {
      path: ".capybara/agents/db.md",
      source: "project",
      trusted: true,
    });
    expect(result.definition?.name).toBe("database-reviewer");
    expect(result.definition?.baseRole).toBe("reviewer");
    expect(result.definition?.permissionClass).toBe("read");
    expect(result.definition?.maxTools).toBe(12);
    expect(result.definition?.instructions).toContain("actionable findings");
  });

  test("an untrusted project definition is not activated (§15.13)", () => {
    const result = parseCustomAgent(valid, {
      path: ".capybara/agents/db.md",
      source: "project",
      trusted: false,
    });
    expect(result.definition).toBeUndefined();
    expect(result.issues[0]?.field).toBe("trust");
  });

  test("a user-level definition works without workspace trust", () => {
    const result = parseCustomAgent(valid, { path: "~/a.md", source: "user", trusted: false });
    expect(result.definition).toBeDefined();
  });

  test("a definition cannot widen its base role's authority", () => {
    const escalating = valid.replace("permissions: read", "permissions: write");
    const result = parseCustomAgent(escalating, {
      path: "a.md",
      source: "project",
      trusted: true,
    });
    // reviewer is read-only, so `write` is narrowed back down.
    expect(result.definition?.permissionClass).toBe("read");
    expect(result.issues.some((i) => i.message.includes("exceeds"))).toBe(true);
  });

  test("max_tools is clamped to the role ceiling", () => {
    const greedy = valid.replace("max_tools: 12", "max_tools: 500");
    const result = parseCustomAgent(greedy, { path: "a.md", source: "user", trusted: true });
    expect(result.definition?.maxTools).toBe(ROLE_DEFINITIONS.reviewer.maxToolCalls);
    expect(result.issues.some((i) => i.message.includes("clamped"))).toBe(true);
  });

  test("a name colliding with a built-in role is rejected", () => {
    const colliding = valid.replace("name: database-reviewer", "name: reviewer");
    const result = parseCustomAgent(colliding, { path: "a.md", source: "user", trusted: true });
    expect(result.definition).toBeUndefined();
    expect(result.issues.some((i) => i.message.includes("built-in role"))).toBe(true);
  });

  test("a missing description is rejected", () => {
    const noDescription = valid.replace("description: Reviews schema and migration changes.\n", "");
    const result = parseCustomAgent(noDescription, {
      path: "a.md",
      source: "user",
      trusted: true,
    });
    expect(result.definition).toBeUndefined();
    expect(result.issues.some((i) => i.field === "description")).toBe(true);
  });

  test("an unknown frontmatter field is reported but not fatal", () => {
    const extra = valid.replace("max_tools: 12", "max_tools: 12\nnonsense: yes");
    const result = parseCustomAgent(extra, { path: "a.md", source: "user", trusted: true });
    expect(result.definition).toBeDefined();
    expect(result.issues.some((i) => i.field === "nonsense")).toBe(true);
  });

  test("a nearer scope shadows a broader one, and the loser stays visible", () => {
    const make = (source: CustomAgentDefinition["source"]): CustomAgentDefinition => ({
      name: "db",
      description: "d",
      mode: "subagent",
      baseRole: "reviewer",
      modelProfile: "review",
      permissionClass: "read",
      maxTools: 4,
      instructions: "i",
      source,
      path: `${source}.md`,
    });
    const resolved = resolveCustomAgents([make("user"), make("project")]);
    expect(resolved.agents).toHaveLength(1);
    expect(resolved.agents[0]?.source).toBe("project");
    expect(resolved.shadowed[0]?.source).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// §6.10 card rendering
// ---------------------------------------------------------------------------

describe("task card (§6.10)", () => {
  test("the full card shows role, goal, constraints, contract, lease, and child count", async () => {
    const { scheduler: s } = scheduler(okRunner);
    const handle = s.spawn({ role: "executor", task: executorTask() });
    const lines = renderTaskCard(handle.instance, { childCount: 1 }).join("\n");

    expect(lines).toContain("Task: executor");
    expect(lines).toContain("# Goal");
    expect(lines).toContain("# Constraints");
    expect(lines).toContain("# Contract");
    expect(lines).toContain("Write lease: scripts/demo.py");
    expect(lines).toContain("Tasks: 1 agent");
    expect(lines).toContain("PythonDemo");
    await s.settleAll();
  });

  test("the compact form collapses to a single line (§6.10)", async () => {
    const { scheduler: s } = scheduler(okRunner);
    const handle = s.spawn({ role: "explore", task: exploreTask() });
    await s.settleAll();
    const lines = renderTaskCard(handle.instance, { compact: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("completed");
  });

  test("each documented state renders an icon", async () => {
    const states: Array<[SubagentRole, string]> = [["explore", "⧖"]];
    for (const [role] of states) {
      const { scheduler: s } = scheduler(okRunner);
      const handle = s.spawn({ role, task: exploreTask() });
      expect(renderTaskCard(handle.instance)[0]).toContain("⧖");
      await s.settleAll();
      expect(renderTaskCard(handle.instance)[0]).toContain("✓");
    }
  });
});

// ---------------------------------------------------------------------------
// Plan-and-Execute: dependencies, feedback, and lease overlap
// ---------------------------------------------------------------------------

describe("new specialist roles (§15.2)", () => {
  test("architect assesses without being able to change what it assesses", () => {
    const architect = ROLE_DEFINITIONS.architect;
    expect(architect.canWrite).toBe(false);
    expect(architect.canRunProcess).toBe(false);
    expect(architect.permissionClass).toBe("read");
    expect(architect.instructions).toContain("blast radius");
  });

  test("refactorer writes, and is held to the writer contract (SUB-002)", () => {
    const refactorer = ROLE_DEFINITIONS.refactorer;
    expect(refactorer.canWrite).toBe(true);
    expect(refactorer.requiresExplicitContract).toBe(true);

    const loose = buildTask(
      { title: "Tidy", goal: "Remove the duplicated config parsing in the loader." },
      "refactorer",
    );
    const validation = validateTask(loose, "refactorer");
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.field === "allowedPaths")).toBe(true);
  });

  test("both new roles are discoverable in the picker (§15.6)", () => {
    expect(SUBAGENT_ROLES).toContain("architect");
    expect(SUBAGENT_ROLES).toContain("refactorer");
    expect(searchAgents("assess the architectural impact of this change")[0]?.role).toBe(
      "architect",
    );
    expect(searchAgents("remove the duplicated code smell")[0]?.role).toBe("refactorer");
  });
});

describe("task dependencies (Plan-and-Execute)", () => {
  test("a task with no dependencies still validates and runs immediately", async () => {
    const { scheduler: s } = scheduler(okRunner);
    const handle = s.spawn({ role: "explore", task: exploreTask() });
    expect(handle.instance.task.dependencies).toEqual([]);
    // A child with nothing to wait for starts synchronously, so it is already
    // past `queued` by the time `spawn` returns — and never `waiting`.
    expect(handle.instance.state).not.toBe("waiting");
    expect((await s.await(handle.id))?.status).toBe("completed");
  });

  test("duplicate dependencies are refused but fan-in is not capped", () => {
    const duplicated = exploreTask({ dependencies: ["agent_1", "agent_1"] });
    expect(
      validateTask(duplicated, "explore").issues.some((i) => i.field === "dependencies"),
    ).toBe(true);

    const fanIn = exploreTask({ dependencies: ["agent_1", "agent_2", "agent_3", "agent_4"] });
    expect(validateTask(fanIn, "explore").issues.some((i) => i.field === "dependencies")).toBe(false);
  });

  test("a dependency the scheduler never created is refused, not awaited forever", () => {
    const { scheduler: s } = scheduler(okRunner);
    try {
      s.spawn({ role: "explore", task: exploreTask({ dependencies: ["agent_99"] }) });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnRejected);
      expect((error as SpawnRejected).code).toBe("UNKNOWN_DEPENDENCY");
    }
  });

  test("dependent subtasks run in order, and the upstream result becomes input", async () => {
    const order: string[] = [];
    const contracts = new Map<string, string>();
    const upstreamSeen = new Map<string, readonly unknown[]>();

    const runner: ChildRunner = async (context) => {
      order.push(`start:${context.instance.id}`);
      contracts.set(context.instance.id, context.taskDescription);
      upstreamSeen.set(context.instance.id, context.upstream);
      // Yield so a scheduler that ignored the dependency would interleave here.
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${context.instance.id}`);
      return {
        ...emptyChildResult("completed", `${context.instance.role} finished`),
        evidence: [
          { kind: "file" as const, label: "loader", locator: "src/loader.ts", detail: "line 42" },
        ],
        openRisks: [`${context.instance.role} left something open`],
        recommendedNextStep: "patch the loader",
      };
    };

    const { scheduler: s, events } = scheduler(runner);
    const explore = s.spawn({ role: "explore", task: exploreTask() });
    const execute = s.spawn({
      role: "executor",
      task: executorTask({ dependencies: [explore.id] }),
    });

    // The dependent child is `waiting`, not `queued`: §15.10 keeps them distinct.
    expect(execute.instance.state).toBe("waiting");

    const executed = await s.await(execute.id);
    expect(executed?.status).toBe("completed");

    // Strictly sequential: the executor cannot start before the explorer ends.
    expect(order).toEqual([
      `start:${explore.id}`,
      `end:${explore.id}`,
      `start:${execute.id}`,
      `end:${execute.id}`,
    ]);

    // The feedback loop: the upstream result is in the downstream contract.
    const contract = contracts.get(execute.id) ?? "";
    expect(contract).toContain("# Upstream results");
    expect(contract).toContain("explore finished");
    expect(contract).toContain("src/loader.ts");
    expect(contract).toContain("open risk: explore left something open");
    // SUB-004: claims are labelled as claims, not merged as facts.
    expect(contract).toContain("claims, not verified facts");
    // And never the parent's transcript.
    expect(contract).not.toContain("start:");

    expect(upstreamSeen.get(execute.id)).toHaveLength(1);
    expect(upstreamSeen.get(explore.id)).toHaveLength(0);

    // The wait is visible on the timeline rather than looking like a stall.
    const progress = events.filter((e) => e.kind === "task.progress");
    expect(progress.some((e) => JSON.stringify(e.payload).includes("waiting for"))).toBe(true);
  });

  test("a dependency that fails blocks its dependent instead of running it blind", async () => {
    const started: string[] = [];
    const runner: ChildRunner = async (context) => {
      started.push(context.instance.id);
      if (context.instance.role === "explore") {
        return emptyChildResult("failed", "could not find the call sites");
      }
      return emptyChildResult("completed", "wrote the file");
    };

    const { scheduler: s, events } = scheduler(runner);
    const explore = s.spawn({ role: "explore", task: exploreTask() });
    const execute = s.spawn({
      role: "executor",
      task: executorTask({ dependencies: [explore.id] }),
    });

    const result = await s.await(execute.id);
    expect(result?.status).toBe("blocked");
    expect(result?.summary).toContain(explore.id);
    // The executor never ran: with no input it would have invented one.
    expect(started).toEqual([explore.id]);
    // §15.12: a blocked child still closes its card.
    expect(kinds(events)).toContain("task.failed");
    expect(s.get(execute.id)?.state).toBe("blocked");
  });

  test("cancelling a child that is still waiting works (AC-22)", async () => {
    let executorStarted = false;
    const runner: ChildRunner = async (context) => {
      if (context.instance.role === "executor") executorStarted = true;
      if (context.instance.role === "explore") {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return emptyChildResult("completed", "done");
    };

    const { scheduler: s } = scheduler(runner);
    const explore = s.spawn({ role: "explore", task: exploreTask() });
    const execute = s.spawn({
      role: "executor",
      task: executorTask({ dependencies: [explore.id] }),
    });

    const cancelled = await s.cancel(execute.id, "user cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(executorStarted).toBe(false);
    // The upstream is untouched: cancelling a dependent is not cancelling its input.
    expect((await s.await(explore.id))?.status).toBe("completed");
  });
});

describe("writer lease overlap (§15.8, SUB-003)", () => {
  test("an overlapping write scope is reported as LEASE_OVERLAP, not just busy", async () => {
    const { scheduler: s } = scheduler(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return emptyChildResult("completed", "done");
      },
      { maxConcurrent: 3 },
    );

    s.spawn({ role: "executor", task: executorTask({ allowedPaths: ["scripts/**"] }) });

    try {
      s.spawn({
        role: "refactorer",
        task: buildTask(
          {
            title: "Tidy",
            goal: "Remove the duplicated argument parsing inside the demo script.",
            constraints: ["MUST NOT change behaviour."],
            expectedOutput: ["Report the removed duplication."],
            allowedPaths: ["scripts/demo.py"],
            verification: ["python3 -m py_compile scripts/demo.py"],
          },
          "refactorer",
        ),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnRejected);
      expect((error as SpawnRejected).code).toBe("LEASE_OVERLAP");
      expect((error as SpawnRejected).issues.join(" ")).toContain("scripts/**");
    }
  });

  test("a non-overlapping scope is still refused while a writer holds the lease (P6)", async () => {
    const { scheduler: s } = scheduler(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return emptyChildResult("completed", "done");
      },
      { maxConcurrent: 3 },
    );

    s.spawn({ role: "executor", task: executorTask({ allowedPaths: ["scripts/demo.py"] }) });

    try {
      s.spawn({
        role: "refactorer",
        task: buildTask(
          {
            title: "Tidy",
            goal: "Remove the duplicated config parsing inside the loader module.",
            constraints: ["MUST NOT change behaviour."],
            expectedOutput: ["Report the removed duplication."],
            allowedPaths: ["src/loader.ts"],
            verification: ["bun test loader"],
          },
          "refactorer",
        ),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as SpawnRejected).code).toBe("WRITER_BUSY");
    }
  });

  test("a queued writer's scope is checked too, before it ever holds a lease", async () => {
    const { scheduler: s } = scheduler(okRunner, { maxConcurrent: 3 });
    const explore = s.spawn({ role: "explore", task: exploreTask() });

    // This writer is waiting on the explorer, so it has no live lease yet.
    s.spawn({
      role: "executor",
      task: executorTask({ dependencies: [explore.id], allowedPaths: ["scripts/demo.py"] }),
    });
    // Free the lease so the overlap check cannot pass on WRITER_BUSY alone.
    s.releaseLease(s.list()[1]!.id);

    try {
      s.spawn({
        role: "refactorer",
        task: buildTask(
          {
            title: "Tidy",
            goal: "Remove the duplicated argument parsing inside the demo script.",
            constraints: ["MUST NOT change behaviour."],
            expectedOutput: ["Report the removed duplication."],
            allowedPaths: ["scripts/demo.py"],
            verification: ["python3 -m py_compile scripts/demo.py"],
          },
          "refactorer",
        ),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as SpawnRejected).code).toBe("LEASE_OVERLAP");
    }
  });

  test("overlap detection covers globs, containment, and equality", () => {
    expect(overlappingGlobs(["src/**"], ["src/a/b.ts"])).toHaveLength(1);
    expect(overlappingGlobs(["src/a/b.ts"], ["src/**"])).toHaveLength(1);
    expect(overlappingGlobs(["src/a/**"], ["src/a/**"])).toHaveLength(1);
    expect(overlappingGlobs(["src/a/**"], ["src/b/**"])).toHaveLength(0);
    expect(overlappingGlobs(["docs/*.md"], ["src/index.ts"])).toHaveLength(0);
  });
});
