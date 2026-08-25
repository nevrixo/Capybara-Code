import { describe, expect, test } from "bun:test";

import { EventSequencer, createEvent } from "@cbc/protocol";
import { replay } from "../src/reducer.ts";
import { TodoController, type PlanItem } from "../src/todo.ts";

function controller(options: { readonly safeRebase?: boolean } = {}) {
  return new TodoController({
    mode: () => "build",
    now: () => "2026-01-01T00:00:00.000Z",
    ...(options.safeRebase === undefined ? {} : { safeRebase: options.safeRebase }),
    emit: () => undefined,
  });
}

const implementation: PlanItem = {
  id: "impl",
  text: "implement the parser",
  status: "pending",
  kind: "implementation",
  files: ["src/parser.ts"],
};

describe("TODO recovery contract", () => {
  test("compiles pending-to-done only with host evidence", () => {
    const todos = controller();
    expect(todos.replace({ expectedRevision: 0, reason: "track work", source: "model", items: [implementation] }).ok).toBe(true);
    const rejected = todos.replace({
      expectedRevision: 1,
      reason: "claim work",
      source: "model",
      items: [{ ...implementation, status: "done", evidence: ["claimed"] }],
    });
    expect(rejected.ok).toBe(false);

    const completed = todos.replace({
      expectedRevision: 1,
      reason: "finish observed work",
      source: "model",
      hostEvidence: { workStarted: true, changedPaths: ["src/parser.ts"], evidenceRefs: ["mutation-1"] },
      items: [{ ...implementation, status: "done", evidence: ["focused test passed"] }],
    });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.state.revision).toBe(3);
      expect(completed.transitionTrace).toMatchObject([
        { revision: 2, from: "pending", to: "active", source: "host_recovery" },
        { revision: 3, from: "active", to: "done", source: "model", evidenceRefs: ["mutation-1"] },
      ]);
    }
  });

  test("safe-rebases a stale progress-only update without changing scope", () => {
    const todos = controller();
    expect(todos.replace({ expectedRevision: 0, reason: "track work", source: "model", items: [implementation] }).ok).toBe(true);
    expect(todos.replace({ expectedRevision: 1, reason: "start work", source: "model", items: [{ ...implementation, status: "active" }] }).ok).toBe(true);
    const rebased = todos.replace({
      expectedRevision: 1,
      reason: "record completion from a stale sample",
      source: "model",
      items: [{ ...implementation, status: "done", evidence: ["verified"] }],
    });
    expect(rebased.ok).toBe(true);
    expect(todos.current().revision).toBe(3);
  });

  test("can disable stale progress rebasing", () => {
    const todos = controller({ safeRebase: false });
    expect(todos.replace({ expectedRevision: 0, reason: "track work", source: "model", items: [implementation] }).ok).toBe(true);
    const stale = todos.replace({
      expectedRevision: 0,
      reason: "stale progress",
      source: "model",
      items: [{ ...implementation, status: "active" }],
    });
    expect(stale).toMatchObject({ ok: false, code: "TODO_REVISION_CONFLICT" });
  });
  test("auto-activates the unique actionable item before a write", () => {
    const todos = controller();
    expect(todos.replace({ expectedRevision: 0, reason: "track work", source: "model", items: [implementation] }).ok).toBe(true);
    const activated = todos.autoActivateForAction({ toolId: "fs.write", writes: ["src/parser.ts"] });
    expect(activated.ok).toBe(true);
    expect(todos.current().items[0]).toMatchObject({ status: "active" });
  });

  test("replays a compiled transition trace to the same final state", () => {
    const sequencer = new EventSequencer();
    const first = createEvent(sequencer, "plan.created", {
      revision: 1,
      source: "model",
      items: [implementation],
    }, { sessionId: "trace" });
    const second = createEvent(sequencer, "plan.updated", {
      revision: 3,
      previousRevision: 1,
      source: "model",
      items: [{ ...implementation, status: "done", evidence: ["verified"] }],
      transitionTrace: [
        { revision: 2, id: "impl", from: "pending", to: "active", source: "host_recovery" },
        { revision: 3, id: "impl", from: "active", to: "done", source: "model" },
      ],
    }, { sessionId: "trace" });
    const model = replay("trace", [first, second]);
    expect(model.todo.revision).toBe(3);
    expect(model.todo.items).toMatchObject([{ id: "impl", status: "done" }]);
  });

  test("does not use unrelated delegated paths for completion", () => {
    const todos = controller();
    expect(todos.replace({ expectedRevision: 0, reason: "track work", source: "model", items: [implementation] }).ok).toBe(true);
    const rejected = todos.replace({
      expectedRevision: 1,
      reason: "finish unrelated work",
      source: "model",
      hostEvidence: { workStarted: true, delegatedChanges: ["src/other.ts"] },
      items: [{ ...implementation, status: "done", evidence: ["delegated"] }],
    });
    expect(rejected).toMatchObject({ ok: false, code: "TODO_INVALID_TRANSITION" });
  });
});