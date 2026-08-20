import { describe, expect, test } from "bun:test";

import { EventSequencer, createEvent, type CbcEvent, type CbcEventKind } from "@cbc/protocol";
import { planDigest, replay } from "../src/index.ts";

function scoped(
  events: Array<[CbcEventKind, unknown, string?]>,
): CbcEvent[] {
  const sequencer = new EventSequencer();
  return events.map(([kind, payload, agentId]) => createEvent(sequencer, kind, payload, {
    sessionId: "session",
    turnId: "turn-1",
    ...(agentId !== undefined ? { agentId } : {}),
  }));
}

function task(taskId: string): Array<[CbcEventKind, unknown, string?]> {
  return [
    ["task.created", {
      taskId,
      role: "executor",
      title: taskId,
      goal: "work",
      constraints: [],
      contract: [],
    }],
    ["task.started", { taskId }],
  ];
}

describe("revision reducer ownership", () => {
  test("malformed plan replay preserves a blocked root obligation", () => {
    const model = replay("session", scoped([
      ["plan.created", {
        revision: 1,
        items: [{
          id: "broken",
          text: "restore the plan",
          status: "not-a-status",
          kind: "implementation",
        }],
      }],
    ]));
    expect(model.todo.items).toMatchObject([{ status: "blocked" }]);
    expect(model.plan).toMatchObject([{ status: "blocked" }]);
  });



  test("replay cannot grant completion to a brand-new done TODO", () => {
    const model = replay("session", scoped([
      ["plan.created", {
        revision: 1,
        source: "model",
        items: [{ id: "impl", text: "implement parser", status: "done", kind: "implementation", evidence: ["claimed"] }],
      }],
    ]));
    expect(model.todo.items).toMatchObject([{ status: "blocked" }]);
  });

  test("replay rejects revision rollback and legacy clears as blocked", () => {
    const model = replay("session", scoped([
      ["plan.created", { revision: 1, source: "model", items: [{ id: "impl", text: "implement", status: "pending", kind: "implementation" }] }],
      ["plan.updated", { revision: 0, source: "user", items: [] }],
    ]));
    expect(model.todo.revision).toBe(1);
    expect(model.todo.items).toMatchObject([{ status: "blocked" }]);
  });

  test("an unrecognized plan source cannot clear unfinished work", () => {
    const model = replay("session", scoped([
      ["plan.created", { revision: 1, source: "model", items: [{ id: "impl", text: "implement", status: "pending", kind: "implementation" }] }],
      ["plan.updated", { revision: 2, source: "forged", items: [] }],
    ]));
    expect(model.todo.items).toMatchObject([{ status: "blocked" }]);
  });

  test("a rejected todo.write remains a durable completion blocker", () => {
    const model = replay("session", scoped([
      ["tool.failed", { callId: "todo-1", toolId: "todo.write", code: "TODO_INVALID_TRANSITION", message: "completion requires progress" }],
    ]));
    expect(model.todo.modelMutationError).toContain("completion requires progress");
  });

  test("replay permits an observable active-to-done transition", () => {
    const model = replay("session", scoped([
      ["plan.created", { revision: 1, source: "model", items: [{ id: "impl", text: "implement", status: "pending", kind: "implementation" }] }],
      ["plan.updated", { revision: 2, source: "model", items: [{ id: "impl", text: "implement", status: "active", kind: "implementation" }] }],
      ["plan.updated", { revision: 3, source: "model", items: [{ id: "impl", text: "implement", status: "done", kind: "implementation", evidence: ["verified"] }] }],
    ]));
    expect(model.todo.items).toMatchObject([{ status: "done" }]);
  });

  test("replay cannot retarget a completed TODO while keeping it done", () => {
    const model = replay("session", scoped([
      ["plan.created", { revision: 1, source: "model", items: [{ id: "impl", text: "implement parser", status: "pending", kind: "implementation" }] }],
      ["plan.updated", { revision: 2, source: "model", items: [{ id: "impl", text: "implement parser", status: "active", kind: "implementation" }] }],
      ["plan.updated", { revision: 3, source: "model", items: [{ id: "impl", text: "implement parser", status: "done", kind: "implementation", evidence: ["verified"] }] }],
      ["plan.updated", { revision: 4, source: "model", items: [{ id: "impl", text: "new unfinished scope", status: "done", kind: "implementation", evidence: ["claimed"] }] }],
    ]));
    expect(model.todo.items).toMatchObject([{ status: "blocked" }]);
  });

  test("replay cannot detour through skipped or blocked while retargeting done work", () => {
    for (const detour of ["skipped", "blocked"] as const) {
      const model = replay("session", scoped([
        ["plan.created", { revision: 1, source: "model", items: [{ id: "impl", text: "old scope", status: "pending", kind: "implementation" }] }],
        ["plan.updated", { revision: 2, source: "model", items: [{ id: "impl", text: "old scope", status: "active", kind: "implementation" }] }],
        ["plan.updated", { revision: 3, source: "model", items: [{ id: "impl", text: "old scope", status: "done", kind: "implementation", evidence: ["verified"] }] }],
        ["plan.updated", { revision: 4, source: "model", items: [{ id: "impl", text: "new scope", status: detour, kind: "implementation", ...(detour === "blocked" ? { blockedReason: "claimed blocker" } : {}) }] }],
      ]));
      expect(model.todo.items).toMatchObject([{ status: "blocked" }]);
    }
  });

  test("approval metadata survives a progress-only plan revision", () => {
    const document = {
      goal: "Fix the parser",
      context: ["Parser source"],
      criticalFiles: [{ path: "src/parser.ts" }],
      verification: [{ command: "bun test" }],
      risks: [],
      rollback: [],
    } as const;
    const pending = [
      { id: "impl", text: "Implement parser", status: "pending" as const, kind: "implementation" as const, files: ["src/parser.ts"], acceptanceCriteria: ["tests pass"] },
      { id: "verify", text: "Verify parser", status: "pending" as const, kind: "verification" as const },
    ];
    const digest = planDigest(document, pending)!;
    const model = replay("session", scoped([
      ["plan.created", { revision: 1, items: pending, document }],
      ["plan.approved", { revision: 1, approval: { revision: 1, digest, approvedAt: "2026-01-01T00:00:00.000Z", via: "slash", contextStrategy: "keep" } }],
      ["plan.updated", { revision: 2, items: pending.map((item, index) => ({ ...item, status: index === 0 ? "active" : item.status })), document, approval: { revision: 1, digest, approvedAt: "2026-01-01T00:00:00.000Z", via: "slash", contextStrategy: "keep" } }],
    ]));
    expect(model.todo.approvedRevision).toBe(1);
    expect(model.todo.approval?.digest).toBe(digest);
  });

  test("child deltas stay in task live state and never change the root lane", () => {
    const model = replay("session", scoped([
      ["turn.started", { model: "gpt-5.6-sol" }, "root"],
      ["assistant.delta", { text: "root reasoning", phase: "reasoning_summary", itemId: "root-r" }, "root"],
      ["assistant.delta", { text: "child answer", phase: "final", itemId: "child-f" }, "agent-2"],
    ]));

    expect(model.live.label).toBe("Thinking...");
    expect(model.taskLive.get("agent-2")).toMatchObject({
      taskId: "agent-2",
      phase: "final",
      itemId: "child-f",
      text: "child answer",
    });
    expect(model.timeline).toHaveLength(0);
  });

  test("child durable prose clears only its task lane and is not journal presentation", () => {
    const model = replay("session", scoped([
      ["assistant.delta", { text: "child text", phase: "commentary" }, "agent-2"],
      ["assistant.commentary", { text: "child text" }, "agent-2"],
      ["assistant.reasoning_summary", { text: "root text" }, "root"],
    ]));

    expect(model.taskLive.has("agent-2")).toBe(false);
    const thinking = model.timeline.filter((item) => item.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      summaryText: "root text",
      turnId: "turn-1",
      agentId: "root",
    });
  });

  test("tracks the exact awaited task and ignores unrelated progress/completion", () => {
    const model = replay("session", scoped([
      ...task("agent-1"),
      ...task("agent-2"),
      ["task.progress", { taskId: "agent-2", awaiting: true }, "root"],
      ["task.progress", { taskId: "agent-1", awaiting: false }, "root"],
      ["task.completed", { taskId: "agent-1", summary: "done", durationMs: 10 }, "agent-1"],
    ]));

    expect(model.awaitingTaskId).toBe("agent-2");
    expect(model.activeTasks.map((item) => item.taskId)).toEqual(["agent-2"]);
  });

  test("interrupting a wait clears awaiting state but keeps the child running", () => {
    const model = replay("session", scoped([
      ...task("agent-2"),
      ["task.progress", { taskId: "agent-2", awaiting: true }, "root"],
      ["task.await_interrupted", { taskId: "agent-2" }, "root"],
    ]));

    expect(model.awaitingTaskId).toBeUndefined();
    expect(model.activeTasks).toHaveLength(1);
    expect(model.activeTasks[0]).toMatchObject({
      taskId: "agent-2",
      state: "running",
      awaitInterrupted: true,
    });
  });

  test("terminal task and turn events clear awaiting and child live state", () => {
    const taskEnded = replay("session", scoped([
      ...task("agent-2"),
      ["task.progress", { taskId: "agent-2", awaiting: true }, "root"],
      ["assistant.delta", { text: "partial", phase: "commentary" }, "agent-2"],
      ["task.failed", { taskId: "agent-2", reason: "boom" }, "agent-2"],
    ]));
    expect(taskEnded.awaitingTaskId).toBeUndefined();
    expect(taskEnded.taskLive.has("agent-2")).toBe(false);

    const turnEnded = replay("session", scoped([
      ...task("agent-2"),
      ["task.progress", { taskId: "agent-2", awaiting: true }, "root"],
      ["turn.cancelled", {}, "root"],
    ]));
    expect(turnEnded.awaitingTaskId).toBeUndefined();
  });
});
