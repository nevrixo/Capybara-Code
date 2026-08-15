import { describe, expect, test } from "bun:test";

import { TodoController, planDigest, type PlanItem } from "../src/index.ts";

function controller(mode: "build" | "plan" = "build"): TodoController {
  return new TodoController({
    mode: () => mode,
    now: () => "2026-01-01T00:00:00.000Z",
    emit: () => undefined,
  });
}

function pendingItem(): PlanItem {
  return {
    id: "parser",
    text: "implement the parser fix",
    status: "pending",
    kind: "implementation",
  };
}

describe("TodoController completion integrity", () => {

  test("Plan mode keeps future execution work pending instead of blocking the draft", () => {
    const todos = controller("plan");
    const document = {
      goal: "Create the Discord bot entry point",
      context: ["The workspace has no existing bot files"],
      criticalFiles: [{ path: "src/bot.ts" }],
      verification: [{ command: "bun test" }],
      risks: ["Discord credentials are required only when the user executes the plan"],
      rollback: ["Remove the new bot entry point"],
    } as const;
    const items: PlanItem[] = [
      {
        id: "inspect",
        text: "Inspect the workspace",
        status: "done",
        kind: "analysis",
        evidence: ["Reviewed the repository layout"],
      },
      {
        id: "implement",
        text: "Create the bot entry point",
        status: "pending",
        kind: "implementation",
        files: ["src/bot.ts"],
        acceptanceCriteria: ["The entry point registers the declared commands"],
      },
      {
        id: "verify",
        text: "Run the focused tests",
        status: "pending",
        kind: "verification",
      },
    ];
    expect(todos.replace({
      expectedRevision: 0,
      reason: "record the implementation plan",
      source: "model",
      document,
      items,
    }).ok).toBe(true);

    const blocked = todos.replace({
      expectedRevision: 1,
      reason: "mistake Plan mode for an execution failure",
      source: "model",
      items: items.map((item) => item.id === "implement"
        ? { ...item, status: "blocked" as const, blockedReason: "Plan mode cannot create files" }
        : item),
    });

    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("TODO_INVALID_TRANSITION");
      expect(blocked.message).toContain("Plan mode cannot move execution TODO 'implement'");
    }
    expect(todos.current().items.find((item) => item.id === "implement")?.status).toBe("pending");
    expect(todos.readiness()).toMatchObject({ ready: true, blockers: [] });
  });

  test("rejects a new structured Plan Contract from a Build-mode model", () => {
    const todos = controller();
    const result = todos.replace({
      expectedRevision: 0,
      reason: "draft a contract while building",
      source: "model",
      document: {
        goal: "Fix the parser",
        context: ["Parser source"],
        criticalFiles: [{ path: "src/parser.ts" }],
        verification: [{ command: "bun test" }],
        risks: [],
        rollback: [],
      },
      items: [pendingItem()],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Plan mode");
    expect(todos.current().document).toBeUndefined();
  });

  test("a brand-new implementation cannot be completed by attaching model evidence", () => {
    const todos = controller();
    const result = todos.replace({
      expectedRevision: 0,
      reason: "claim the work is complete",
      source: "model",
      items: [{
        ...pendingItem(),
        status: "done",
        evidence: ["claimed by the model"],
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TODO_INVALID_TRANSITION");
    expect(todos.current().items).toEqual([]);
    expect(todos.completionItems()).toMatchObject([
      { status: "blocked", text: "Repair the rejected TODO update before reporting completion" },
    ]);
    expect(todos.replace({
      expectedRevision: 0,
      reason: "user repairs the checklist",
      source: "user",
      items: [pendingItem()],
    }).ok).toBe(true);
    expect(todos.completionItems()).toMatchObject([{ id: "parser", status: "pending" }]);
  });


  test("a model no-op cannot self-clear a rejected mutation marker", () => {
    const todos = controller();
    expect(todos.replace({
      expectedRevision: 0,
      reason: "claim completion",
      source: "model",
      items: [{ ...pendingItem(), status: "done", evidence: ["claimed"] }],
    }).ok).toBe(false);
    const forgedRepair = todos.replace({
      expectedRevision: 0,
      reason: "pretend the rejected update is repaired",
      source: "model",
      items: [],
    });
    expect(forgedRepair.ok).toBe(false);
    expect(todos.completionItems()).toMatchObject([{ status: "blocked" }]);
  });

  test("a model can repair a rejected mutation only by recording real unfinished work", () => {
    const todos = controller();
    expect(todos.replace({
      expectedRevision: 0,
      reason: "claim completion",
      source: "model",
      items: [{ ...pendingItem(), status: "done", evidence: ["claimed"] }],
    }).ok).toBe(false);
    expect(todos.completionItems()).toMatchObject([{ id: "todo-controller-error", status: "blocked", hostGenerated: true }]);

    const repaired = todos.replace({
      expectedRevision: 0,
      reason: "record the actual unfinished parser work",
      source: "model",
      items: [pendingItem()],
    });

    expect(repaired.ok).toBe(true);
    if (repaired.ok) expect(repaired.changed).toBe(true);
    expect(todos.current().modelMutationError).toBeUndefined();
    expect(todos.completionItems()).toMatchObject([{ id: "parser", status: "pending" }]);
  });

  test("a no-op repair journals removal of a rejected mutation marker", () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const todos = new TodoController({
      mode: () => "build",
      now: () => "2026-01-01T00:00:00.000Z",
      emit: (kind, payload) => { events.push({ kind, payload }); },
    });
    const rejected = todos.replace({
      expectedRevision: 0,
      reason: "claim completion",
      source: "model",
      items: [{ ...pendingItem(), status: "done", evidence: ["claimed"] }],
    });
    expect(rejected.ok).toBe(false);
    const repaired = todos.replace({
      expectedRevision: 0,
      reason: "accept the unchanged empty scope",
      source: "user",
      items: [],
    });
    expect(repaired.ok).toBe(true);
    if (repaired.ok) expect(repaired.changed).toBe(true);
    expect(events.at(-1)?.kind).toBe("plan.created");
    expect(todos.current().modelMutationError).toBeUndefined();
  });

  test("hydrated approval must bind to an existing revision and digest", () => {
    const todos = controller();
    const document = {
      goal: "Fix the parser",
      context: ["Parser source"],
      criticalFiles: [{ path: "src/parser.ts" }],
      verification: [{ command: "bun test" }],
      risks: [],
      rollback: [],
    } as const;
    const items = [pendingItem()];
    const digest = planDigest(document, items)!;
    todos.hydrate({
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      document,
      items,
      approval: {
        revision: 999,
        digest,
        approvedAt: "2026-01-01T00:00:00.000Z",
        via: "slash",
        contextStrategy: "keep",
      },
    });
    expect(todos.current().approval).toBeUndefined();
    expect(todos.approvalValid()).toBe(false);
  });

  test("missing hydrated TODO fields fail closed instead of becoming an empty list", () => {
    const todos = controller();
    todos.hydrate({ revision: 1, updatedAt: "2026-01-01T00:00:00.000Z" } as unknown as ReturnType<TodoController["current"]>);
    expect(todos.current().items).toMatchObject([{ status: "blocked" }]);
    todos.hydrate({ items: [], updatedAt: "2026-01-01T00:00:00.000Z" } as unknown as ReturnType<TodoController["current"]>);
    expect(todos.current().items).toMatchObject([{ status: "blocked" }]);
  });

  test("malformed hydrated TODO state remains an explicit blocked obligation", () => {
    const todos = controller();
    todos.hydrate({
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      items: [{ ...pendingItem(), status: "corrupt" } as unknown as PlanItem],
    });
    expect(todos.current().items).toMatchObject([{ status: "blocked" }]);
    expect(todos.completionItems()).toHaveLength(1);
  });

  test("blocked or skipped work must reopen before completion", () => {
    for (const status of ["blocked", "skipped"] as const) {
      const todos = controller();
      const initial = {
        ...pendingItem(),
        status,
        ...(status === "blocked" ? { blockedReason: "waiting" } : {}),
      };
      expect(todos.replace({ expectedRevision: 0, reason: `mark ${status}`, source: "model", items: [initial] }).ok).toBe(true);
      const completed = todos.replace({ expectedRevision: 1, reason: "claim completion", source: "model", items: [{ ...pendingItem(), status: "done", evidence: ["claimed"] }] });
      expect(completed.ok).toBe(false);
    }
  });

  test("explains how to repair a pending-to-done update", () => {
    const todos = controller();
    expect(todos.replace({
      expectedRevision: 0,
      reason: "track parser work",
      source: "model",
      items: [pendingItem()],
    }).ok).toBe(true);

    const rejected = todos.replace({
      expectedRevision: 1,
      reason: "claim parser completion",
      source: "model",
      items: [{ ...pendingItem(), status: "done", evidence: ["claimed"] }],
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("TODO_INVALID_TRANSITION");
      expect(rejected.message).toContain("TODO 'parser'");
      expect(rejected.message).toContain("pending to done");
      expect(rejected.message).toContain("separate todo.write");
    }
  });

  test("allows an active completion and next-item activation in the same update", () => {
    const todos = controller();
    const verify: PlanItem = {
      id: "verify",
      text: "Run focused parser tests",
      status: "pending",
      kind: "verification",
    };
    expect(todos.replace({
      expectedRevision: 0,
      reason: "start parser implementation",
      source: "model",
      items: [{ ...pendingItem(), status: "active" }, verify],
    }).ok).toBe(true);

    const handoff = todos.replace({
      expectedRevision: 1,
      reason: "finish implementation and start verification",
      source: "model",
      items: [
        { ...pendingItem(), status: "done", evidence: ["implementation verified"] },
        { ...verify, status: "active" },
      ],
    });

    expect(handoff.ok).toBe(true);
    if (handoff.ok) {
      expect(handoff.state.items).toMatchObject([
        { id: "parser", status: "done" },
        { id: "verify", status: "active" },
      ]);
    }
  });
  test("progress updates preserve rich scope fields omitted after compaction", () => {
    const todos = controller();
    const richItem: PlanItem = {
      ...pendingItem(),
      details: "Keep the existing UI contract",
      files: ["index.html"],
      symbols: ["GameView"],
      acceptanceCriteria: ["UI renders"],
      dependsOn: ["assets"],
      commands: ["bun test"],
    };
    expect(todos.replace({
      expectedRevision: 0,
      reason: "track rich scope",
      source: "model",
      items: [richItem],
    }).ok).toBe(true);

    const active = todos.replace({
      expectedRevision: 1,
      reason: "continue after compaction",
      source: "model",
      items: [{ id: richItem.id, text: richItem.text, status: "active" }],
    });
    expect(active.ok).toBe(true);
    expect(todos.current().items[0]).toMatchObject({
      status: "active",
      kind: "implementation",
      details: richItem.details,
      files: richItem.files,
      symbols: richItem.symbols,
      acceptanceCriteria: richItem.acceptanceCriteria,
      dependsOn: richItem.dependsOn,
      commands: richItem.commands,
    });

    const done = todos.replace({
      expectedRevision: 2,
      reason: "finish after compaction",
      source: "model",
      items: [{ id: richItem.id, text: richItem.text, status: "done", evidence: ["focused test passed"] }],
    });
    expect(done.ok).toBe(true);
    expect(todos.current().items[0]).toMatchObject({
      status: "done",
      files: richItem.files,
      acceptanceCriteria: richItem.acceptanceCriteria,
      evidence: ["focused test passed"],
    });
  });


  test("a completed item cannot silently change scope while staying done", () => {
    const todos = controller();
    expect(todos.replace({ expectedRevision: 0, reason: "track work", source: "model", items: [pendingItem()] }).ok).toBe(true);
    expect(todos.replace({ expectedRevision: 1, reason: "start work", source: "model", items: [{ ...pendingItem(), status: "active" }] }).ok).toBe(true);
    expect(todos.replace({ expectedRevision: 2, reason: "finish work", source: "model", items: [{ ...pendingItem(), status: "done", evidence: ["verified"] }] }).ok).toBe(true);
    const rescope = todos.replace({
      expectedRevision: 3,
      reason: "claim a different finished task",
      source: "model",
      items: [{ ...pendingItem(), text: "a new unfinished parser scope", status: "done", evidence: ["claimed"] }],
    });
    expect(rescope.ok).toBe(false);
    expect(todos.current().items[0]?.text).toBe(pendingItem().text);

    const skippedRescope = todos.replace({
      expectedRevision: 3,
      reason: "try to skip a new scope",
      source: "model",
      items: [{ ...pendingItem(), text: "another new scope", status: "skipped" }],
    });
    expect(skippedRescope.ok).toBe(false);
  });

  test("a model cannot erase an unfinished item, while an explicit user clear can", () => {
    const todos = controller();
    const created = todos.replace({
      expectedRevision: 0,
      reason: "track parser work",
      source: "model",
      items: [pendingItem()],
    });
    expect(created.ok).toBe(true);

    const erasedByModel = todos.clear({
      expectedRevision: 1,
      reason: "hide unfinished work",
      source: "model",
    });
    expect(erasedByModel.ok).toBe(false);
    if (!erasedByModel.ok) {
      expect(erasedByModel.code).toBe("TODO_INVALID_TRANSITION");
      expect(erasedByModel.message).toContain("cannot remove unfinished");
    }
    expect(todos.current().items).toHaveLength(1);

    const clearedByUser = todos.clear({
      expectedRevision: 1,
      reason: "user intentionally re-scoped the task",
      source: "user",
    });
    expect(clearedByUser.ok).toBe(true);
    expect(todos.current().items).toEqual([]);
  });

  test("blocked or skipped work cannot be dropped by a later model replacement", () => {
    for (const status of ["blocked", "skipped"] as const) {
      const todos = controller();
      expect(todos.replace({
        expectedRevision: 0,
        reason: "track parser work",
        source: "model",
        items: [pendingItem()],
      }).ok).toBe(true);
      expect(todos.replace({
        expectedRevision: 1,
        reason: `mark ${status}`,
        source: "model",
        items: [{
          ...pendingItem(),
          status,
          ...(status === "blocked" ? { blockedReason: "waiting for approval" } : {}),
        }],
      }).ok).toBe(true);

      const removed = todos.replace({
        expectedRevision: 2,
        reason: "discard the unresolved item",
        source: "model",
        items: [],
      });
      expect(removed.ok).toBe(false);
      expect(todos.current().items[0]?.status).toBe(status);
    }
  });

  test("validates runtime status values even outside the tool schema", () => {
    const todos = controller();
    const invalid = todos.replace({
      expectedRevision: 0,
      reason: "bad imported value",
      source: "migration",
      items: [{ ...pendingItem(), status: "complete" } as unknown as PlanItem],
    });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe("TODO_INVALID_INPUT");
      expect(invalid.message).toContain("invalid status");
    }
  });

  test("records evidence-backed Plan analysis in its completion update", () => {
    const todos = controller();
    expect(todos.replace({
      expectedRevision: 0,
      reason: "begin repository inspection",
      source: "model",
      items: [{
        id: "inspect-workspace",
        text: "Inspect the workspace",
        status: "active",
        kind: "analysis",
      }],
    }).ok).toBe(true);

    const completed = todos.replace({
      expectedRevision: 1,
      reason: "record the inspection evidence",
      source: "model",
      items: [{
        id: "inspect-workspace",
        text: "Inspect the workspace",
        details: "Recorded the repository layout and package scripts",
        status: "done",
        kind: "analysis",
        evidence: ["Reviewed the repository root and package manifest"],
      }],
    });
    expect(completed.ok).toBe(true);
    expect(todos.current().items).toMatchObject([{ id: "inspect-workspace", status: "done" }]);
  });

  test("does not let blocked analysis bypass the reopen requirement", () => {
    const todos = controller();
    expect(todos.replace({
      expectedRevision: 0,
      reason: "wait for inspection access",
      source: "model",
      items: [{
        id: "inspect-workspace",
        text: "Inspect the workspace",
        status: "blocked",
        kind: "analysis",
        blockedReason: "workspace is unavailable",
      }],
    }).ok).toBe(true);
    const completed = todos.replace({
      expectedRevision: 1,
      reason: "claim the analysis is complete",
      source: "model",
      items: [{
        id: "inspect-workspace",
        text: "Inspect the workspace",
        status: "done",
        kind: "analysis",
        evidence: ["claimed"],
      }],
    });
    expect(completed.ok).toBe(false);
  });
});
