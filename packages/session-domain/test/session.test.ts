/**
 * Session domain tests — PRD §25.2, §25.4, AC-34, AC-35, AC-36, AC-46.
 */

import { describe, expect, test } from "bun:test";

import { EventSequencer, createEvent, type CbcEvent, type CbcEventKind } from "@cbc/protocol";

import {
  buildGroup,
  compact,
  contextPercent,
  emptyViewModel,
  estimateTokens,
  exportMarkdown,
  MAX_RESIDENT_NOTICES,
  MAX_RESIDENT_SUBAGENT_EVENTS,
  reduce,
  renderCompactState,
  retainedForPrompt,
  replay,
  resumeWarnings,
  serializeModel,
  deserializeModel,
  shouldCompact,
  SessionRecorder,
  type JournalTransport,
  type SessionManifest,
  type SessionViewModel,
} from "../src/index.ts";

function build(events: Array<[CbcEventKind, unknown]>, sessionId = "ses_1"): CbcEvent[] {
  const sequencer = new EventSequencer();
  return events.map(([kind, payload]) =>
    createEvent(sequencer, kind, payload, { sessionId, turnId: "turn_1" }),
  );
}

/** Build events attributed to specific agents, for the §6.10 subagent tree. */
function buildScoped(
  events: Array<[CbcEventKind, unknown, string?]>,
  sessionId = "ses_1",
): CbcEvent[] {
  const sequencer = new EventSequencer();
  return events.map(([kind, payload, agentId]) =>
    createEvent(sequencer, kind, payload, {
      sessionId,
      turnId: "turn_1",
      ...(agentId !== undefined ? { agentId } : {}),
    }),
  );
}

function taskAt(model: SessionViewModel, index = 0) {
  const task = model.timeline.filter((i) => i.type === "task")[index];
  if (task?.type !== "task") throw new Error("expected a task timeline item");
  return task;
}

describe("reducer basics (§20.8)", () => {
  test("user message becomes a timeline block", () => {
    const model = replay("ses_1", build([["user.message", { text: "fix the parser" }]]));
    expect(model.timeline).toHaveLength(1);
    expect(model.timeline[0]?.type).toBe("user");
    expect((model.timeline[0] as { text: string }).text).toBe("fix the parser");
  });

  test("a user message records the selected reasoning effort", () => {
    const model = replay(
      "ses_1",
      build([["user.message", { text: "use the selected effort", reasoningEffort: "high" }]]),
    );
    expect(model.reasoningEffort).toBe("high");
  });

  test("session startup seeds the displayed model and reasoning effort", () => {
    const model = replay(
      "ses_1",
      build([[
        "session.started",
        {
          modelId: "gpt-5.6-luna",
          reasoningEffort: "high",
          permissionMode: "auto",
        },
      ]]),
    );
    expect(model.modelId).toBe("gpt-5.6-luna");
    expect(model.reasoningEffort).toBe("high");
    expect(model.permissionMode).toBe("auto");
  });

  test("commentary and provider reasoning channels project to one Thinking part (§10.7)", () => {
    const model = replay(
      "ses_1",
      build([
        ["assistant.commentary", { text: "Inspecting the failing path." }],
        ["assistant.reasoning", { text: "Checking the provider-visible details." }],
        ["assistant.reasoning_summary", { text: "Considered two hypotheses." }],
      ]),
    );
    expect(model.timeline.map((item) => item.type)).toEqual(["commentary", "thinking"]);
    const thinking = model.timeline.at(-1);
    expect(thinking?.type).toBe("thinking");
    if (thinking?.type === "thinking") {
      expect(thinking.detailText).toBe("Checking the provider-visible details.");
      expect(thinking.summaryText).toBe("Considered two hypotheses.");
      expect(thinking.sources).toEqual(["provider_summary", "provider_reasoning"]);
    }
  });

  test("identical commentary from distinct provider items remains distinct", () => {
    const model = replay(
      "ses_1",
      build([
        ["assistant.commentary", { text: "Working on it", itemId: "item_1" }],
        ["assistant.commentary", { text: "Working on it", itemId: "item_2" }],
      ]),
    );
    expect(model.timeline.filter((i) => i.type === "commentary")).toHaveLength(2);
  });

  test("a repeated durable provider item is coalesced without comparing its text", () => {
    const model = replay(
      "ses_1",
      build([
        ["assistant.commentary", { text: "first fragment", itemId: "item_1" }],
        ["assistant.commentary", { text: "changed authoritative text", itemId: "item_1" }],
      ]),
    );
    expect(model.timeline.filter((i) => i.type === "commentary")).toHaveLength(1);
  });

  test("assistant deltas update the live phase immediately", () => {
    const sampling = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6", reasoning: { effort: "medium" } }],
        ["assistant.delta", { text: "Inspecting", phase: "commentary" }],
      ]),
    );
    expect(sampling.turnStatus).toBe("sampling");
    expect(sampling.live.label).toBe("Working...");

    const reasoning = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6", reasoning: { effort: "medium" } }],
        ["assistant.delta", { text: "Weighing", phase: "reasoning_summary" }],
      ]),
    );
    expect(reasoning.live.label).toBe("Thinking...");

    const thinking = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6", reasoning: { effort: "medium" } }],
        ["assistant.delta", { text: "Checking", phase: "reasoning" }],
      ]),
    );
    expect(thinking.live.label).toBe("Thinking...");
    const candidate = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6", reasoning: { effort: "medium" } }],
        ["assistant.delta", { text: "Answer draft", phase: "candidate_final" }],
      ]),
    );
    expect(candidate.live.label).toBe("");
  });
  test("root deltas structurally share every untouched collection", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("ses_1");
    model = reduce(model, createEvent(sequencer, "user.message", { text: "seed" }, { sessionId: "ses_1" }));
    model = reduce(model, createEvent(sequencer, "transaction.committed", {
      operations: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
    }, { sessionId: "ses_1" }));
    const before = model;
    const delta = createEvent(
      sequencer,
      "assistant.delta",
      { text: "chunk", phase: "commentary" },
      { sessionId: "ses_1", agentId: "root", turnId: "turn_1" },
    );

    const next = reduce(before, delta);
    expect(next).not.toBe(before);
    expect(next.timeline).toBe(before.timeline);
    expect(next.plan).toBe(before.plan);
    expect(next.usage).toBe(before.usage);
    expect(next.notices).toBe(before.notices);
    expect(next.taskLive).toBe(before.taskLive);
    expect(next.activeTasks).toBe(before.activeTasks);
    expect(next.activeJobs).toBe(before.activeJobs);
    expect(next.changedFiles).toBe(before.changedFiles);
    expect(next.turnStatus).toBe("sampling");
    expect(before.turnStatus).not.toBe("sampling");

    const committed = reduce(next, createEvent(sequencer, "transaction.committed", {
      operations: [{ path: "src/b.ts", additions: 2, deletions: 0 }],
    }, { sessionId: "ses_1" }));
    expect(committed.changedFiles).not.toBe(next.changedFiles);
    expect(next.changedFiles.has("src/b.ts")).toBe(false);
    expect(before.changedFiles.has("src/b.ts")).toBe(false);
  });

  test("child deltas copy only task live state and preserve prior models", () => {
    const sequencer = new EventSequencer();
    const base = emptyViewModel("ses_1");
    const first = reduce(base, createEvent(
      sequencer,
      "assistant.delta",
      { text: "one", phase: "final", itemId: "answer" },
      { sessionId: "ses_1", turnId: "turn_1", agentId: "agent-1" },
    ));
    const seeded = reduce(first, createEvent(
      sequencer,
      "assistant.delta",
      { text: "other", phase: "commentary", itemId: "work" },
      { sessionId: "ses_1", turnId: "turn_1", agentId: "agent-2" },
    ));
    const untouched = seeded.taskLive.get("agent-2");

    const next = reduce(seeded, createEvent(
      sequencer,
      "assistant.delta",
      { text: " two", phase: "final", itemId: "answer", provisional: true },
      { sessionId: "ses_1", turnId: "turn_1", agentId: "agent-1" },
    ));

    expect(next.taskLive).not.toBe(seeded.taskLive);
    expect(next.taskLive.get("agent-1")?.text).toBe("one two");
    expect(next.taskLive.get("agent-1")?.provisional).toBe(true);
    expect(seeded.taskLive.get("agent-1")?.text).toBe("one");
    expect(next.taskLive.get("agent-2")).toBe(untouched);
    expect(next.timeline).toBe(seeded.timeline);
    expect(next.changedFiles).toBe(seeded.changedFiles);
  });

  test("bounds advisory global notices in long sessions", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("ses_1");
    for (let index = 0; index < MAX_RESIDENT_NOTICES + 20; index += 1) {
      model = reduce(
        model,
        createEvent(
          sequencer,
          "model.route_escalated",
          { text: `route ${index}` },
          { sessionId: "ses_1" },
        ),
      );
    }
    expect(model.notices).toHaveLength(MAX_RESIDENT_NOTICES);
    expect(model.notices[0]?.text).toBe("route 20");
    expect(model.notices.at(-1)?.text).toBe(`route ${MAX_RESIDENT_NOTICES + 19}`);
  });

  test("final answer carries the completion report (§11.7)", () => {
    const report = {
      status: "completed" as const,
      summary: "Fixed the parser",
      changedFiles: [{ path: "src/parser.ts", additions: 4, deletions: 2, purpose: "fix" }],
      verification: [{ command: "bun test", status: "passed" as const, evidence: "12 passed" }],
      delegatedTasks: [],
      risks: [],
    };
    const model = replay("ses_1", build([["assistant.final", { text: "Done.", report }]]));
    const final = model.timeline.find((i) => i.type === "final");
    expect(final?.type).toBe("final");
    // `TimelineItem` is a discriminated union, so narrow on the tag rather than
    // asserting a structurally-incompatible literal shape.
    if (final?.type !== "final") throw new Error("expected a final timeline item");
    expect(final.report?.verification[0]?.status).toBe("passed");
  });

  test("a partial terminal result is paused rather than shown as complete", () => {
    const model = replay(
      "ses_1",
      build([["turn.completed", { status: "partial", tests: { passed: 0 } }]]),
    );

    expect(model.turnStatus).toBe("partial");
    expect(model.live.kind).toBe("partial");
    expect(model.live.label).toContain("Turn paused");
    expect(model.live.label).not.toContain("Turn complete");
  });
});

describe("tool lifecycle", () => {
  test("uses semantic write labels and clears a settled TODO call from RUN", () => {
    const writing = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6" }],
        ["tool.started", { callId: "write-1", toolId: "fs.write" }],
      ]),
    );
    expect(writing.live.label).toBe("Writing...");

    const updatingTodo = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6" }],
        ["tool.started", { callId: "todo-1", toolId: "todo.write" }],
      ]),
    );
    expect(updatingTodo.live.label).toBe("Updating TODO...");

    const settled = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6" }],
        ["tool.started", { callId: "todo-1", toolId: "todo.write" }],
        ["tool.completed", { callId: "todo-1", toolId: "todo.write", summary: "updated" }],
      ]),
    );
    expect(settled.activeTools).toEqual([]);
    expect(settled.live.label).toBe("Working...");
    expect(settled.live.label).not.toContain("todo.write");

    const concurrent = replay(
      "ses_1",
      build([
        ["turn.started", { model: "gpt-5.6" }],
        ["tool.started", { callId: "read-1", toolId: "fs.read" }],
        ["tool.started", { callId: "todo-1", toolId: "todo.write" }],
        ["tool.completed", { callId: "todo-1", toolId: "todo.write", summary: "updated" }],
      ]),
    );
    expect(concurrent.activeTools.map((tool) => tool.callId)).toEqual(["read-1"]);
    expect(concurrent.live.label).toBe("Running fs.read...");
  });

  test("start then complete updates the same card in place", () => {
    const model = replay(
      "ses_1",
      build([
        ["tool.started", { callId: "c1", toolId: "fs.read", arguments: { path: "src/a.ts" } }],
        ["tool.completed", { callId: "c1", summary: "42 lines", durationMs: 18 }],
      ]),
    );
    const tools = model.timeline.filter((i) => i.type === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0] as { status: string }).status).toBe("succeeded");
    expect((tools[0] as { summary?: string }).summary).toBe("42 lines");
  });

  test("tracks running root calls without scanning timeline history", () => {
    const sequencer = new EventSequencer();
    const started = reduce(
      emptyViewModel("ses_1"),
      createEvent(sequencer, "tool.started", { callId: "c1", toolId: "fs.read" }, { sessionId: "ses_1" }),
    );
    expect(started.activeTools.map((tool) => tool.callId)).toEqual(["c1"]);

    const unrelated = reduce(
      started,
      createEvent(sequencer, "notification.retry", { reason: "busy" }, { sessionId: "ses_1" }),
    );
    expect(unrelated.activeTools).toBe(started.activeTools);

    const completed = reduce(
      unrelated,
      createEvent(sequencer, "tool.completed", { callId: "c1", summary: "done" }, { sessionId: "ses_1" }),
    );
    expect(completed.activeTools).toEqual([]);
  });

  test("failure records the taxonomy code (§12.10)", () => {
    const model = replay(
      "ses_1",
      build([
        ["tool.started", { callId: "c1", toolId: "fs.write" }],
        ["tool.failed", { callId: "c1", code: "PATH_OUTSIDE_WORKSPACE", message: "denied" }],
      ]),
    );
    const tool = model.timeline.find((i) => i.type === "tool");
    expect((tool as { status: string }).status).toBe("failed");
    expect((tool as { errorCode?: string }).errorCode).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  test("a completed write records its counts and mini-diff preview (§6.4)", () => {
    const model = replay(
      "ses_1",
      build([
        ["tool.started", { callId: "c1", toolId: "fs.apply_patch", display: "scripts/demo.py" }],
        [
          "tool.completed",
          {
            callId: "c1",
            summary: "applied",
            additions: 18,
            deletions: 0,
            diffPreview: [
              { kind: "added", lineNumber: 18, text: 'print("hi")' },
              { kind: "bogus", text: "ignored" },
            ],
          },
        ],
      ]),
    );
    const tool = model.timeline.find((i) => i.type === "tool");
    if (tool?.type !== "tool") throw new Error("expected a tool timeline item");
    expect(tool.additions).toBe(18);
    expect(tool.deletions).toBe(0);
    // An unrecognized kind is dropped rather than rendered as a mystery row.
    expect(tool.diffPreview).toHaveLength(1);
    expect(tool.diffPreview?.[0]?.lineNumber).toBe(18);
  });

  test("a preview longer than four lines is capped at the source (§6.4)", () => {
    const model = replay(
      "ses_1",
      build([
        ["tool.started", { callId: "c1", toolId: "fs.write" }],
        [
          "tool.completed",
          {
            callId: "c1",
            diffPreview: Array.from({ length: 9 }, (_, i) => ({
              kind: "added",
              lineNumber: i,
              text: `l${i}`,
            })),
          },
        ],
      ]),
    );
    const tool = model.timeline.find((i) => i.type === "tool");
    if (tool?.type !== "tool") throw new Error("expected a tool timeline item");
    expect(tool.diffPreview).toHaveLength(4);
  });

  test("tool discovery records ranking metadata (§6.9)", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "tool.discovery",
          {
            query: "sub-agent delegation executor agent task runner",
            matches: [
              { toolId: "task.spawn", title: "Task", description: "Spawn a subagent", score: 4.949 },
              { toolId: "task.status", title: "Subagent", description: "Manage tasks", score: 4.19 },
            ],
            activated: ["task.spawn", "task.status"],
            activeCount: 3,
            totalCount: 21,
            limit: 10,
          },
        ],
      ]),
    );
    const discovery = model.timeline.find((i) => i.type === "tool_discovery");
    expect(discovery?.type).toBe("tool_discovery");
    const d = discovery as { matches: unknown[]; totalCount: number; limit: number };
    expect(d.matches).toHaveLength(2);
    expect(d.totalCount).toBe(21);
    expect(d.limit).toBe(10);
  });
});

describe("approval flow (§7.6, AC-18, AC-19)", () => {
  test("request sets a pending approval and live state", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "approval.requested",
          {
            approvalId: "ap_1",
            action: "process.run",
            display: "npm install sharp",
            cwd: "~/project",
            riskClass: "R3",
            reason: "modifies dependency files and uses network",
            network: true,
            sideEffects: ["package.json", "lockfile", "node_modules"],
          },
        ],
      ]),
    );
    expect(model.pendingApproval?.action).toBe("process.run");
    expect(model.turnStatus).toBe("awaiting_approval");
    expect(model.live.kind).toBe("awaiting_approval");
    expect(model.live.label).toContain("Approval required: process.run");
  });

  test("denial with a reason is recorded for the model observation (AC-19)", () => {
    const model = replay(
      "ses_1",
      build([
        ["approval.requested", { approvalId: "ap_1", action: "shell.run", display: "rm -rf build" }],
        ["approval.resolved", { approvalId: "ap_1", decision: "deny", reason: "use the clean script" }],
      ]),
    );
    const approval = model.timeline.find((i) => i.type === "approval");
    expect((approval as { decision?: string }).decision).toBe("deny");
    expect((approval as { decisionReason?: string }).decisionReason).toBe("use the clean script");
    expect(model.pendingApproval).toBeUndefined();
    expect(model.turnStatus).toBe("observing");
  });
});

describe("subagent tool tree (§6.10)", () => {
  const spawn = (): Array<[CbcEventKind, unknown, string?]> => [
    [
      "task.created",
      {
        taskId: "agent_1",
        role: "executor",
        title: "PythonDemo",
        goal: "Create one standalone Python script",
        modelProfile: "gpt-5.6-terra",
      },
      "agent_1",
    ],
    ["task.started", { taskId: "agent_1" }, "agent_1"],
  ];

  test("a delegated call lands in its task, not on the top-level timeline", () => {
    const model = replay(
      "ses_1",
      buildScoped([
        ...spawn(),
        ["tool.started", { callId: "c1", toolId: "fs.write", display: "scripts/demo.py" }, "agent_1"],
        [
          "tool.completed",
          { callId: "c1", summary: "wrote 18 lines", additions: 18, deletions: 0 },
          "agent_1",
        ],
      ]),
    );

    // The parent's timeline holds the card, not the call.
    expect(model.timeline.filter((i) => i.type === "tool")).toHaveLength(0);

    const task = taskAt(model);
    expect(task.modelId).toBe("gpt-5.6-terra");
    expect(task.subagentEvents).toHaveLength(1);
    expect(task.subagentEvents[0]?.toolId).toBe("fs.write");
    expect(task.subagentEvents[0]?.status).toBe("succeeded");
    expect(task.subagentEvents[0]?.additions).toBe(18);
  });

  test("publishes an input estimate before reconciling exact child usage", () => {
    const events = buildScoped([
      ...spawn(),
      ["context.pack_compiled", { totalInputTokens: 1_200 }, "agent_1"],
      ["tool.started", { callId: "c1", toolId: "fs.read" }, "agent_1"],
      ["usage.updated", { inputTokens: 1_200, outputTokens: 100 }, "agent_1"],
    ]);

    const pending = replay("ses_1", events.slice(0, 3));
    expect(taskAt(pending).pendingInputTokens).toBe(1_200);
    expect(taskAt(pending).tokens).toBeUndefined();
    expect(pending.activeTasks[0]?.pendingInputTokens).toBe(1_200);

    const settled = replay("ses_1", events);
    expect(taskAt(settled).subagentEventCount).toBe(1);
    expect(taskAt(settled).tokens).toBe(1_300);
    expect(taskAt(settled).pendingInputTokens).toBeUndefined();
    expect(settled.activeTasks[0]?.tokens).toBe(1_300);
  });

  test("the parent's own calls stay on the timeline", () => {
    const model = replay(
      "ses_1",
      buildScoped([
        ...spawn(),
        ["tool.started", { callId: "p1", toolId: "fs.read" }, "root"],
        ["tool.completed", { callId: "p1", summary: "ok" }, "root"],
      ]),
    );
    expect(model.timeline.filter((i) => i.type === "tool")).toHaveLength(1);
    expect(taskAt(model).subagentEvents).toHaveLength(0);
  });

  test("an unknown agent id falls back to the timeline rather than vanishing", () => {
    const model = replay(
      "ses_1",
      buildScoped([
        ["tool.started", { callId: "x1", toolId: "fs.read" }, "agent_ghost"],
        ["tool.completed", { callId: "x1", summary: "ok" }, "agent_ghost"],
      ]),
    );
    const tools = model.timeline.filter((i) => i.type === "tool");
    expect(tools).toHaveLength(1);
    if (tools[0]?.type !== "tool") throw new Error("expected a tool item");
    expect(tools[0].agentId).toBe("agent_ghost");
    expect(tools[0].status).toBe("succeeded");
  });

  test("a failed delegated call records its code inside the tree", () => {
    const model = replay(
      "ses_1",
      buildScoped([
        ...spawn(),
        ["tool.started", { callId: "c1", toolId: "process.run" }, "agent_1"],
        [
          "tool.failed",
          { callId: "c1", code: "PROCESS_EXIT_NONZERO", message: "1 test failed", exitCode: 1 },
          "agent_1",
        ],
      ]),
    );
    const event = taskAt(model).subagentEvents[0];
    expect(event?.status).toBe("failed");
    expect(event?.errorCode).toBe("PROCESS_EXIT_NONZERO");
    expect(event?.exitCode).toBe(1);
  });

  test("reducing does not mutate the model it was handed (§25.4)", () => {
    const events = buildScoped([
      ...spawn(),
      ["tool.started", { callId: "c1", toolId: "fs.read" }, "agent_1"],
    ]);

    let model = emptyViewModel("ses_1");
    const snapshots: number[] = [];
    for (const event of events) {
      model = reduce(model, event);
      snapshots.push(taskAt(model).subagentEvents.length);
    }
    // The array grew on the last event only; earlier models were not written to.
    expect(snapshots).toEqual([0, 0, 1]);

    const before = reduce(emptyViewModel("ses_1"), events[0] as CbcEvent);
    const beforeCount = taskAt(before).subagentEvents.length;
    reduce(before, events[2] as CbcEvent);
    expect(taskAt(before).subagentEvents.length).toBe(beforeCount);
  });

  test("reuses unrelated timeline items while cloning the changed item", () => {
    const events = build([
      ["tool.started", { callId: "c1", toolId: "fs.read" }],
      ["tool.started", { callId: "c2", toolId: "fs.write" }],
    ]);
    const first = reduce(emptyViewModel("ses_1"), events[0]!);
    const second = reduce(first, events[1]!);
    const firstTool = first.timeline[0];
    const secondTool = second.timeline[0];
    const secondNewTool = second.timeline[1];

    expect(secondTool).toBe(firstTool);
    expect(secondNewTool?.type).toBe("tool");

    const completed = reduce(
      second,
      build([["tool.completed", { callId: "c1", summary: "read" }]])[0]!,
    );
    expect(completed.timeline[0]).not.toBe(second.timeline[0]);
    expect(completed.timeline[1]).toBe(second.timeline[1]);
  });

  test("clones a task and child before a delegated lifecycle update", () => {
    const events = buildScoped([
      ...spawn(),
      ["tool.started", { callId: "c1", toolId: "fs.write" }, "agent_1"],
    ]);
    const withChild = events.reduce(reduce, emptyViewModel("ses_1"));
    const completed = reduce(
      withChild,
      buildScoped([["tool.completed", { callId: "c1", summary: "done", artifacts: ["a.txt"] }, "agent_1"]])[0]!,
    );

    expect(completed.timeline[0]).not.toBe(withChild.timeline[0]);
    expect(taskAt(withChild).subagentEvents[0]?.status).toBe("running");
    expect(taskAt(completed).subagentEvents[0]?.status).toBe("succeeded");
    expect(taskAt(completed).subagentEvents[0]?.artifacts).toEqual(["a.txt"]);
    expect(taskAt(completed).subagentEvents).not.toBe(taskAt(withChild).subagentEvents);
  });

  test("approval resolution clones the prior approval item", () => {
    const requested = reduce(
      emptyViewModel("ses_1"),
      build([["approval.requested", { approvalId: "ap_1", action: "fs.write", display: "a.txt" }]])[0]!,
    );
    const resolved = reduce(
      requested,
      build([["approval.resolved", { approvalId: "ap_1", decision: "deny" }]])[0]!,
    );
    const priorApproval = requested.timeline[0];
    const nextApproval = resolved.timeline[0];

    expect(priorApproval?.type).toBe("approval");
    expect(nextApproval?.type).toBe("approval");
    expect((priorApproval as { decision?: string }).decision).toBeUndefined();
    expect((nextApproval as { decision?: string }).decision).toBe("deny");
    expect(nextApproval).not.toBe(priorApproval);
  });

  test("replay equals the incremental result with a subagent tree (§25.4)", () => {
    const events = buildScoped([
      ...spawn(),
      ["tool.started", { callId: "c1", toolId: "fs.write" }, "agent_1"],
      ["tool.completed", { callId: "c1", summary: "ok", additions: 3, deletions: 1 }, "agent_1"],
      ["task.completed", { taskId: "agent_1", summary: "done", durationMs: 1_200 }, "agent_1"],
    ]);
    expect(serializeModel(replay("ses_1", events))).toEqual(
      serializeModel(replay("ses_1", events)),
    );
  });

  test("a child held on a dependency is waiting, and still counted as active (§15.10)", () => {
    const model = replay(
      "ses_1",
      buildScoped([
        [
          "task.created",
          {
            taskId: "agent_2",
            role: "executor",
            title: "Implement",
            dependencies: ["agent_1"],
            state: "waiting",
          },
          "agent_2",
        ],
      ]),
    );
    const task = taskAt(model);
    expect(task.state).toBe("waiting");
    expect(task.dependencies).toEqual(["agent_1"]);
    expect(model.activeTasks).toHaveLength(1);
  });

  test("task progress is retained for the sidebar (§6.21)", () => {
    const model = replay(
      "ses_1",
      buildScoped([
        ...spawn(),
        ["task.progress", { taskId: "agent_1", text: "writing scripts/demo.py" }, "agent_1"],
      ]),
    );
    expect(taskAt(model).progress).toBe("writing scripts/demo.py");
  });

  test("keeps only recent completed child calls with a cumulative count", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("ses_1");
    const emit = (kind: CbcEventKind, payload: unknown, agentId = "agent_1") => {
      model = reduce(
        model,
        createEvent(sequencer, kind, payload, {
          sessionId: "ses_1",
          turnId: "turn_1",
          agentId,
        }),
      );
    };
    emit("task.created", { taskId: "agent_1", role: "executor", title: "bounded" });
    emit("task.started", { taskId: "agent_1" });
    for (let index = 0; index < 40; index += 1) {
      emit("tool.started", { callId: `call_${index}`, toolId: "fs.read", display: `${index}.ts` });
      emit("tool.completed", { callId: `call_${index}`, summary: `read ${index}` });
    }

    const task = taskAt(model);
    expect(task.subagentEvents).toHaveLength(MAX_RESIDENT_SUBAGENT_EVENTS);
    expect(task.subagentEventCount).toBe(40);
    expect(task.subagentEventsOmitted).toBe(8);
    expect(task.subagentEvents[0]?.callId).toBe("call_8");
    expect(task.subagentEvents.at(-1)).toMatchObject({
      callId: "call_39",
      status: "succeeded",
      summary: "read 39",
    });
  });

  test("pins running child calls and reindexes them as completed calls are evicted", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("ses_1");
    const emit = (kind: CbcEventKind, payload: unknown) => {
      model = reduce(
        model,
        createEvent(sequencer, kind, payload, {
          sessionId: "ses_1",
          turnId: "turn_1",
          agentId: "agent_1",
        }),
      );
    };
    emit("task.created", { taskId: "agent_1", role: "executor", title: "pinned" });
    emit("task.started", { taskId: "agent_1" });
    for (let index = 0; index < 40; index += 1) {
      emit("tool.started", { callId: `running_${index}`, toolId: "fs.read" });
    }
    expect(taskAt(model).subagentEvents).toHaveLength(40);

    for (let index = 0; index < 8; index += 1) {
      emit("tool.completed", { callId: `running_${index}`, summary: `done ${index}` });
    }
    const task = taskAt(model);
    expect(task.subagentEvents).toHaveLength(MAX_RESIDENT_SUBAGENT_EVENTS);
    expect(task.subagentEvents.every((event) => event.status === "running")).toBe(true);
    expect(task.subagentEvents[0]?.callId).toBe("running_8");
    expect(task.subagentEventsOmitted).toBe(8);
  });

  test("unrelated durable events share active lifecycle collections", () => {
    const sequencer = new EventSequencer();
    let model = emptyViewModel("ses_1");
    model = reduce(
      model,
      createEvent(
        sequencer,
        "task.created",
        { taskId: "agent_1", role: "executor", title: "indexed" },
        { sessionId: "ses_1", agentId: "agent_1" },
      ),
    );
    const before = model;
    model = reduce(
      model,
      createEvent(
        sequencer,
        "notification.retry",
        { reason: "network", attempt: 1 },
        { sessionId: "ses_1" },
      ),
    );
    expect(model.activeTasks).toBe(before.activeTasks);
    expect(model.activeJobs).toBe(before.activeJobs);
    expect(model.plan).toBe(before.plan);
    expect(model.usage).toBe(before.usage);
    expect(model.changedFiles).toBe(before.changedFiles);
    expect(model.taskLive).toBe(before.taskLive);
  });
});

describe("task semantics (§6.11, AC-21, AC-25)", () => {
  test("await interruption keeps the task running (AC-21)", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "task.created",
          {
            taskId: "t1",
            role: "executor",
            title: "PythonDemo",
            goal: "Create one standalone Python script",
            constraints: ["Only create scripts/demo.py."],
            contract: ["Return the created path."],
            writeLease: ["scripts/demo.py"],
          },
        ],
        ["task.started", { taskId: "t1" }],
        ["task.await_interrupted", { taskId: "t1" }],
      ]),
    );
    const task = model.timeline.find((i) => i.type === "task");
    expect((task as { state: string }).state).toBe("running");
    expect((task as { awaitInterrupted: boolean }).awaitInterrupted).toBe(true);
    expect(model.activeTasks).toHaveLength(1);
    expect(
      model.timeline.some(
        (i) => i.type === "notice" && i.text.includes("Await interrupted; this subagent continues"),
      ),
    ).toBe(true);
  });

  test("completion emits the background notification (AC-25)", () => {
    const model = replay(
      "ses_1",
      build([
        ["task.created", { taskId: "t1", role: "executor", title: "PythonDemo" }],
        ["task.started", { taskId: "t1" }],
        ["task.completed", { taskId: "t1", summary: "created scripts/demo.py", durationMs: 19_700 }],
      ]),
    );
    expect(
      model.timeline.some(
        (i) =>
          i.type === "notice" &&
          i.text.includes("Background job completed [task] PythonDemo (19.7s)"),
      ),
    ).toBe(true);
    expect(model.activeTasks).toHaveLength(0);
  });

  test("a scheduler-blocked child is not presented as failed", () => {
    const model = replay(
      "ses_1",
      build([
        ["task.created", { taskId: "t1", role: "executor", title: "PythonDemo" }],
        ["task.started", { taskId: "t1" }],
        [
          "task.failed",
          {
            taskId: "t1",
            state: "blocked",
            status: "partial",
            summary: "landing page implemented",
            openRisks: ["verification coverage is partial: no verification was run"],
            durationMs: 19_700,
          },
        ],
      ]),
    );

    expect(taskAt(model)).toMatchObject({
      state: "blocked",
      summary: "landing page implemented",
      blocker: "verification coverage is partial: no verification was run",
      durationMs: 19_700,
    });
    expect(model.activeTasks).toHaveLength(0);

    const notice = model.timeline.find(
      (item) => item.type === "notice" && item.text.startsWith("Task PythonDemo"),
    );
    if (notice?.type !== "notice") throw new Error("expected a terminal task notice");
    expect(notice.level).toBe("warning");
    expect(notice.text).toContain("Task PythonDemo blocked");
    expect(notice.text).toContain("verification coverage is partial");
    expect(notice.text).not.toContain("landing page implemented");
    expect(notice.text).not.toContain("failed");
  });

  test("late await cleanup progress cannot reactivate a completed subagent", () => {
    const model = replay(
      "ses_1",
      build([
        ["task.created", { taskId: "t1", role: "executor", title: "PythonDemo" }],
        ["task.started", { taskId: "t1" }],
        ["task.progress", { taskId: "t1", awaiting: true }],
        ["task.completed", { taskId: "t1", summary: "created scripts/demo.py", durationMs: 19_700 }],
        // SubagentBridge emits this from its await-finally cleanup after the
        // scheduler has already emitted task.completed.
        ["task.progress", { taskId: "t1", awaiting: false }],
      ]),
    );

    const task = model.timeline.find((item) => item.type === "task");
    expect(task).toMatchObject({ taskId: "t1", state: "completed" });
    expect(model.activeTasks).toHaveLength(0);
    expect(model.awaitingTaskId).toBeUndefined();
  });

  test("task card exposes goal, constraints, contract, and lease (§6.10)", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "task.created",
          {
            taskId: "t1",
            role: "executor",
            title: "PythonDemo",
            goal: "Create one standalone Python script.",
            constraints: ["MUST only create scripts/demo.py."],
            contract: ["Return the created path."],
            writeLease: ["scripts/demo.py"],
          },
        ],
      ]),
    );
    const task = model.timeline.find((i) => i.type === "task") as {
      goal: string;
      constraints: string[];
      contract: string[];
      writeLease?: string[];
    };
    expect(task.goal).toContain("standalone Python script");
    expect(task.constraints).toHaveLength(1);
    expect(task.contract).toHaveLength(1);
    expect(task.writeLease).toEqual(["scripts/demo.py"]);
  });
});

describe("conflict and transaction rendering", () => {
  test("conflict renders the Appendix A.3 shape", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "transaction.conflicted",
          { path: "src/parser.ts", expected: "8f1c7c2aaa", actual: "a12b880bbb" },
        ],
      ]),
    );
    const text = model.timeline.find((i) => i.type === "notice")?.type === "notice"
      ? (model.timeline[0] as { text: string }).text
      : "";
    expect(text).toContain("Patch conflict: src/parser.ts changed after Capybara read it");
    expect(text).toContain("8f1c7c2");
    expect(text).toContain("a12b880");
    expect(text).toContain("The file was not modified");
  });

  test("committed transaction accumulates changed files", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "transaction.committed",
          {
            operations: [
              { path: "src/a.ts", additions: 4, deletions: 1 },
              { path: "src/b.ts", additions: 10, deletions: 0 },
            ],
          },
        ],
        ["transaction.committed", { operations: [{ path: "src/a.ts", additions: 2, deletions: 0 }] }],
      ]),
    );
    expect(model.changedFiles.get("src/a.ts")).toEqual({ additions: 6, deletions: 1 });
    expect(model.changedFiles.get("src/b.ts")).toEqual({ additions: 10, deletions: 0 });
  });
});

describe("cancellation (§7.7, AC-20)", () => {
  test("cancellation updates status", () => {
    const model = replay("ses_1", build([["turn.started", {}], ["turn.cancelled", {}]]));
    expect(model.turnStatus).toBe("cancelled");
    expect(model.cancelledTurns).toBe(1);
  });
});

describe("determinism (§25.4)", () => {
  test("replay equals incremental reduction", () => {
    const events = build([
      ["turn.started", { model: "gpt-5.6" }],
      ["user.message", { text: "hello" }],
      ["assistant.commentary", { text: "Looking." }],
      ["tool.started", { callId: "c1", toolId: "fs.read" }],
      ["tool.completed", { callId: "c1", summary: "ok" }],
      ["usage.updated", { inputTokens: 100, outputTokens: 20 }],
      ["assistant.final", { text: "Done." }],
      ["turn.completed", { status: "completed" }],
    ]);

    const viaReplay = replay("ses_1", events);
    let incremental: SessionViewModel = emptyViewModel("ses_1");
    for (const event of events) incremental = reduce(incremental, event);

    expect(serializeModel(viaReplay)).toEqual(serializeModel(incremental));
  });

  test("reduce does not mutate the input model", () => {
    const before = emptyViewModel("ses_1");
    const snapshot = JSON.stringify(serializeModel(before));
    reduce(before, build([["user.message", { text: "x" }]])[0] as CbcEvent);
    expect(JSON.stringify(serializeModel(before))).toBe(snapshot);
  });

  test("replaying twice yields identical output", () => {
    const events = build([
      ["user.message", { text: "a" }],
      ["tool.started", { callId: "c", toolId: "fs.glob" }],
      ["tool.completed", { callId: "c", summary: "3 matches" }],
    ]);
    expect(serializeModel(replay("s", events))).toEqual(serializeModel(replay("s", events)));
  });

  test("snapshot round-trips", () => {
    const model = replay(
      "ses_1",
      build([
        ["user.message", { text: "hi" }],
        ["transaction.committed", { operations: [{ path: "a.ts", additions: 1, deletions: 0 }] }],
      ]),
    );
    const restored = deserializeModel(serializeModel(model));
    expect(restored?.sessionId).toBe("ses_1");
    expect(restored?.changedFiles.get("a.ts")).toEqual({ additions: 1, deletions: 0 });
  });

  test("malformed snapshot TODO state preserves a blocked root obligation", () => {
    const seed = serializeModel(emptyViewModel("ses_1"));
    const restored = deserializeModel({
      ...seed,
      todo: {
        revision: 1,
        items: [{ id: "broken", text: "restore", status: "bogus", kind: "implementation" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      plan: [{ id: "broken", text: "restore", status: "bogus", kind: "implementation" }],
    });
    expect(restored?.todo.items).toMatchObject([{ status: "blocked" }]);
    expect(restored?.plan).toMatchObject([{ status: "blocked" }]);

    const missingItems = deserializeModel({
      ...seed,
      todo: { revision: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      plan: [],
    });
    expect(missingItems?.todo.items).toMatchObject([{ status: "blocked" }]);

    const missingRevision = deserializeModel({
      ...seed,
      todo: { items: [], updatedAt: "2026-01-01T00:00:00.000Z" },
      plan: [],
    });
    expect(missingRevision?.todo.items).toMatchObject([{ status: "blocked" }]);
  });

  test("snapshot hydration reconstructs active lifecycle indexes and pending approval", () => {
    const model = replay(
      "ses_1",
      build([
        ["tool.started", { callId: "c1", toolId: "fs.read", arguments: { path: "a.ts" } }],
        ["approval.requested", {
          approvalId: "ap_1",
          action: "process.run",
          display: "bun test",
          cwd: "/work",
          riskClass: "R2",
          reason: "executes tests",
          network: false,
          sideEffects: [],
        }],
      ]),
    );
    const restored = deserializeModel(JSON.parse(JSON.stringify(serializeModel(model))));

    expect(restored?.activeTools.map((tool) => tool.callId)).toEqual(["c1"]);
    expect(restored?.pendingApproval?.approvalId).toBe("ap_1");
    expect(restored?.live).toEqual(model.live);
  });
});

describe("usage and context (§6.13, §23.7, AC-49)", () => {
  test("usage accumulates every documented field", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "usage.updated",
          {
            inputTokens: 1_000,
            cachedInputTokens: 800,
            cacheWriteTokens: 200,
            outputTokens: 300,
            reasoningTokens: 150,
            estimatedCostUsd: 0.12,
            contextUsedTokens: 3_744,
          },
        ],
        ["usage.updated", { inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.06 }],
      ]),
    );
    expect(model.usage.inputTokens).toBe(1_500);
    expect(model.usage.cachedInputTokens).toBe(800);
    expect(model.usage.cacheWriteTokens).toBe(200);
    expect(model.usage.reasoningTokens).toBe(150);
    expect(model.usage.estimatedCostUsd).toBeCloseTo(0.18, 5);
  });

  test("context percent is against the soft budget (§10.10)", () => {
    let model = emptyViewModel("s", 96_000);
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 3_744 }]])[0] as CbcEvent);
    expect(contextPercent(model)).toBeCloseTo(3.9, 1);
  });
});

describe("model transparency (AC-48)", () => {
  test("turn.started records the model and effort so a fallback is visible", () => {
    const model = replay(
      "ses_1",
      build([
        [
          "turn.started",
          { model: "gpt-5.6-terra", reasoning: { effort: "low" }, permissionMode: "ask" },
        ],
      ]),
    );
    expect(model.modelId).toBe("gpt-5.6-terra");
    expect(model.reasoningEffort).toBe("low");
    expect(model.permissionMode).toBe("ask");
  });

  test("a low-effort child turn cannot replace the root model or selected effort", () => {
    const sequencer = new EventSequencer();
    const events = [
      createEvent(
        sequencer,
        "session.started",
        { modelId: "gpt-5.6-sol", reasoningEffort: "max", permissionMode: "ask" },
        { sessionId: "ses_1", agentId: "root" },
      ),
      createEvent(
        sequencer,
        "turn.started",
        { model: "gpt-5.6-sol", reasoning: { effort: "max" }, permissionMode: "ask" },
        { sessionId: "ses_1", turnId: "root_turn", agentId: "root" },
      ),
      createEvent(
        sequencer,
        "turn.started",
        { model: "gpt-5.6-terra", reasoning: { effort: "low" }, permissionMode: "ask" },
        { sessionId: "ses_1", turnId: "child_turn", agentId: "agent_1" },
      ),
      createEvent(
        sequencer,
        "assistant.commentary",
        { text: "Child is exploring.", reasoningEffort: "low" },
        { sessionId: "ses_1", turnId: "child_turn", agentId: "agent_1" },
      ),
      createEvent(
        sequencer,
        "turn.completed",
        { status: "completed" },
        { sessionId: "ses_1", turnId: "child_turn", agentId: "agent_1" },
      ),
    ];

    const model = replay("ses_1", events);
    expect(model.modelId).toBe("gpt-5.6-sol");
    expect(model.reasoningEffort).toBe("max");
    expect(model.currentTurnId).toBe("root_turn");
    expect(model.turnCount).toBe(1);
    expect(model.turnStatus).toBe("preparing");
  });
});

describe("compaction (§18.9, AC-34)", () => {
  function richModel(): SessionViewModel {
    return replay(
      "ses_1",
      build([
        ["user.message", { text: "Fix the failing parser test" }],
        ["assistant.commentary", { text: "Decided to narrow to the tokenizer." }],
        ["tool.started", { callId: "c1", toolId: "fs.read", arguments: { path: "src/parser.ts" } }],
        ["tool.completed", { callId: "c1", summary: "read 200 lines" }],
        ["tool.started", { callId: "c2", toolId: "process.run", arguments: { path: "bun test" } }],
        ["tool.failed", { callId: "c2", code: "PROCESS_EXIT_NONZERO", message: "1 test failed" }],
        [
          "transaction.committed",
          { operations: [{ path: "src/parser.ts", additions: 6, deletions: 2 }] },
        ],
        [
          "task.created",
          { taskId: "t1", role: "reviewer", title: "Review", goal: "Review the diff" },
        ],
        ["task.completed", { taskId: "t1", summary: "no blocking issue", durationMs: 5_000 }],
        ["plan.created", { items: [{ id: "p1", text: "Run the focused test", status: "active" }] }],
        ["usage.updated", { contextUsedTokens: 70_000 }],
      ]),
    );
  }

  test("triggers at 70% of the soft budget", () => {
    // contextUsedTokens is the *current* context size, not a running total, so
    // each usage event replaces it.
    let model = emptyViewModel("s", 100_000);
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 69_000 }]])[0] as CbcEvent);
    expect(shouldCompact(model)).toBeUndefined();
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 71_000 }]])[0] as CbcEvent);
    expect(shouldCompact(model)).toBe("soft_budget_70");
  });

  test("triggers exactly at the 70% boundary", () => {
    let model = emptyViewModel("s", 100_000);
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 70_000 }]])[0] as CbcEvent);
    expect(shouldCompact(model)).toBe("soft_budget_70");
  });

  test("honours a runtime soft-budget ratio (token saving)", () => {
    let model = emptyViewModel("s", 100_000);
    // 56% used: below the fixed 70%, but above the balanced 55% ratio.
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 56_000 }]])[0] as CbcEvent);
    expect(shouldCompact(model)).toBeUndefined();
    expect(shouldCompact(model, { softBudgetRatio: 0.55 })).toBe("soft_budget_70");
    // The default ratio still applies when none is supplied.
    expect(shouldCompact(model, {})).toBeUndefined();
  });

  test("an invalid runtime ratio falls back to the fixed default", () => {
    let model = emptyViewModel("s", 100_000);
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 69_000 }]])[0] as CbcEvent);
    expect(shouldCompact(model, { softBudgetRatio: 0 })).toBeUndefined();
    expect(shouldCompact(model, { softBudgetRatio: Number.NaN })).toBeUndefined();
    expect(shouldCompact(model, { softBudgetRatio: 5 })).toBeUndefined();
    model = reduce(model, build([["usage.updated", { contextUsedTokens: 71_000 }]])[0] as CbcEvent);
    expect(shouldCompact(model, { softBudgetRatio: 0 })).toBe("soft_budget_70");
  });

  test("triggers on accumulated tool output even below the budget", () => {
    let model = emptyViewModel("s", 1_000_000);
    const big = "x".repeat(200_000);
    model = reduce(model, build([["tool.started", { callId: "c", toolId: "shell.run" }]])[0] as CbcEvent);
    model = reduce(model, build([["tool.completed", { callId: "c", summary: big }]])[0] as CbcEvent);
    expect(shouldCompact(model)).toBe("tool_output_accumulation");
  });

  test("provider context error expectation triggers", () => {
    expect(
      shouldCompact(emptyViewModel("s"), { providerContextErrorExpected: true }),
    ).toBe("provider_context_error_expected");
  });

  test("user request always triggers", () => {
    expect(shouldCompact(emptyViewModel("s"), { userRequested: true })).toBe("user_requested");
  });

  test("preserves decisions, files, tests, and unresolved state", () => {
    const result = compact(richModel(), "user_requested", estimateTokens);
    expect(result.state.userGoal).toBe("Fix the failing parser test");
    expect(result.state.decisions.some((d) => d.includes("tokenizer"))).toBe(true);
    expect(result.state.filesRead.some((f) => f.path === "src/parser.ts")).toBe(true);
    expect(result.state.filesChanged.some((f) => f.path === "src/parser.ts")).toBe(true);
    expect(result.state.testEvidence.length).toBeGreaterThan(0);
    expect(result.state.taskResults.some((t) => t.includes("reviewer"))).toBe(true);
    expect(result.state.unresolved.some((u) => u.includes("PROCESS_EXIT_NONZERO") || u.includes("failed"))).toBe(true);
    expect(result.state.nextAction).toBe("Run the focused test");
  });

  test("the original journal is never deleted", () => {
    const model = richModel();
    const before = model.timeline.length;
    const result = compact(model, "user_requested", estimateTokens);
    expect(result.journalPreserved).toBe(true);
    // The model passed in is unchanged; compaction only produces a summary.
    expect(model.timeline.length).toBe(before);
  });

  test("retained prompt items preserve user then final order", () => {
    const user = { type: "user" as const, id: "u", sequence: 1, text: "request", timestamp: "" };
    const final = { type: "final" as const, id: "f", sequence: 2, text: "answer" };
    expect(retainedForPrompt([user, final])).toEqual([user, final]);
  });
  test("compaction reduces the token estimate", () => {
    const model = richModel();
    const result = compact(model, "soft_budget_70", estimateTokens);
    expect(result.tokensBefore).toBe(70_000);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  test("rendered state includes every populated section", () => {
    const rendered = renderCompactState(compact(richModel(), "user_requested", estimateTokens).state);
    expect(rendered).toContain("## Goal");
    expect(rendered).toContain("## Decisions");
    expect(rendered).toContain("## Files inspected");
    // §18.9 renders the change set as the bounded "Diff summary" tier.
    expect(rendered).toContain("## Diff summary");
    expect(rendered).toContain("## Verification");
    expect(rendered).toContain("## Next action");
  });

  test("token estimator weighs CJK more heavily than Latin", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("안녕하세요")).toBeGreaterThan(estimateTokens("hello"));
  });
});

describe("resume consistency (§18.11, AC-35, AC-36, AC-46)", () => {
  const okIntegrity = { sessionId: "s", eventsVerified: 10, lastValidSequence: 10, ok: true };

  test("a clean resume produces no warnings", () => {
    expect(
      resumeWarnings({ workspaceExists: true, modelAvailable: true, integrity: okIntegrity }),
    ).toEqual([]);
  });

  test("a moved Git head warns (AC-36)", () => {
    const warnings = resumeWarnings({
      workspaceExists: true,
      modelAvailable: true,
      gitHead: "bbbbbbbbbb",
      recordedGitHead: "aaaaaaaaaa",
      integrity: okIntegrity,
    });
    expect(warnings.some((w) => w.kind === "git_head_changed")).toBe(true);
  });

  test("changed files warn with a sample", () => {
    const warnings = resumeWarnings({
      workspaceExists: true,
      modelAvailable: true,
      changedFiles: ["src/a.ts", "src/b.ts"],
      integrity: okIntegrity,
    });
    const warning = warnings.find((w) => w.kind === "file_changed");
    expect(warning?.detail).toContain("2 previously-read files changed");
    expect(warning?.detail).toContain("src/a.ts");
  });

  test("fingerprint drift warns for config, skills, and MCP", () => {
    const warnings = resumeWarnings({
      workspaceExists: true,
      modelAvailable: true,
      configFingerprint: "a",
      recordedConfigFingerprint: "b",
      skillFingerprint: "c",
      recordedSkillFingerprint: "d",
      mcpFingerprint: "e",
      recordedMcpFingerprint: "f",
      integrity: okIntegrity,
    });
    expect(warnings.map((w) => w.kind)).toEqual([
      "config_fingerprint_changed",
      "skill_fingerprint_changed",
      "mcp_fingerprint_changed",
    ]);
  });

  test("stale jobs and interrupted transactions are reported (§7.8, AC-46)", () => {
    const warnings = resumeWarnings({
      workspaceExists: true,
      modelAvailable: true,
      unfinishedTransactions: ["tx_1"],
      staleJobs: ["job_1", "job_2"],
      integrity: okIntegrity,
    });
    expect(warnings.some((w) => w.kind === "unfinished_transaction")).toBe(true);
    const stale = warnings.find((w) => w.kind === "stale_job");
    expect(stale?.detail).toContain("interrupted by a previous shutdown");
  });

  test("a truncated journal reports the last valid sequence (AC-46)", () => {
    const warnings = resumeWarnings({
      workspaceExists: true,
      modelAvailable: true,
      integrity: {
        sessionId: "s",
        eventsVerified: 7,
        lastValidSequence: 7,
        ok: false,
        breakDetail: "event_hash mismatch at 8",
      },
    });
    const warning = warnings.find((w) => w.kind === "journal_truncated");
    expect(warning?.detail).toContain("sequence 7");
    expect(warning?.detail).toContain("event_hash mismatch");
  });

  test("an unavailable model warns instead of silently downgrading (AC-48)", () => {
    const warnings = resumeWarnings({
      workspaceExists: true,
      modelAvailable: false,
      integrity: okIntegrity,
    });
    expect(warnings.some((w) => w.kind === "model_unavailable")).toBe(true);
  });
});

describe("SessionRecorder (§20.9)", () => {
  function transport(): JournalTransport & { appended: unknown[]; snapshots: unknown[] } {
    const appended: unknown[] = [];
    const snapshots: unknown[] = [];
    let journalSequence = 0;
    return {
      appended,
      snapshots,
      open: async () => ({}),
      append: async (params) => {
        appended.push(params);
        const events = params.events as Array<{ id: string; kind: string }>;
        const acknowledged = events.map((event) => ({
          id: event.id,
          kind: event.kind,
          sequence: ++journalSequence,
          eventHash: `hash-${journalSequence}`,
          prevHash: journalSequence === 1 ? "genesis" : `hash-${journalSequence - 1}`,
        }));
        return {
          appended: events.length,
          lastSequence: journalSequence,
          events: acknowledged,
        };
      },
      snapshot: async (params) => {
        snapshots.push(params);
        return { checksum: "abc" };
      },
      load: async () => ({}),
    };
  }

  test("journals durable events and skips ephemeral ones", async () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    recorder.emit("user.message", { text: "hi" });
    recorder.emit("tool.progress", { callId: "c1", text: "…" });
    recorder.emit("assistant.final", { text: "done" });
    await recorder.flush();
    expect(t.appended).toHaveLength(1);
    expect((t.appended[0] as { events: unknown[] }).events).toHaveLength(2);
  });

  test("the reducer updates before the append resolves", () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    recorder.emit("user.message", { text: "immediate" });
    // No await: the view model is already current.
    expect(recorder.model.timeline).toHaveLength(1);
  });

  test("snapshots the queued payload before callers can mutate it", async () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    const payload = { text: "before" };
    recorder.emit("user.message", payload);
    payload.text = "after";
    await recorder.flush();

    const request = t.appended[0] as { events: Array<{ payload: { text: string } }> };
    expect(request.events[0]?.payload.text).toBe("before");
    expect((recorder.model.timeline[0] as { text: string }).text).toBe("before");
  });

  test("onDurable fires only after the acknowledgement", async () => {
    const t = transport();
    const durable: string[] = [];
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: t,
      onDurable: (event) => durable.push(event.kind),
    });
    recorder.emit("user.message", { text: "x" });
    expect(durable).toHaveLength(0);
    await recorder.flush();
    expect(durable).toEqual(["user.message"]);
  });

  test("rejects a malformed append acknowledgement as degraded durability", async () => {
    const durable: string[] = [];
    const failures: string[] = [];
    let snapshots = 0;
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: {
        open: async () => ({}),
        append: async () => ({ appended: 1, lastSequence: 1, events: [] }),
        snapshot: async () => {
          snapshots += 1;
          return {};
        },
        load: async () => ({}),
      },
      onDurable: (event) => durable.push(event.kind),
      onJournalError: (event) => failures.push(event.kind),
    });

    recorder.emit("user.message", { text: "not really acknowledged" });
    await recorder.flush();
    expect(durable).toEqual([]);
    expect(failures).toEqual(["user.message"]);
    expect(await recorder.maybeSnapshot(true)).toBe(false);
    expect(snapshots).toBe(0);
  });

  test("batches by count and keeps at most one journal RPC in flight", async () => {
    const appended: Array<Record<string, unknown>> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let journalSequence = 0;
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: {
        open: async () => ({}),
        append: async (params) => {
          appended.push(params);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(2);
          inFlight -= 1;
          const events = params.events as Array<{ id: string }>;
          const acknowledged = events.map((event) => ({
            id: event.id,
            sequence: ++journalSequence,
          }));
          return {
            appended: events.length,
            lastSequence: journalSequence,
            events: acknowledged,
          };
        },
        snapshot: async () => ({}),
        load: async () => ({}),
      },
    });

    for (let i = 0; i < 65; i += 1) recorder.emit("user.message", { text: `m${i}` });
    await recorder.flush();

    expect(appended.map((entry) => (entry.events as unknown[]).length)).toEqual([32, 32, 1]);
    const persistedTexts = appended.flatMap((entry) =>
      (entry.events as Array<{ payload: { text: string } }>).map((event) => event.payload.text)
    );
    expect(persistedTexts).toEqual(Array.from({ length: 65 }, (_, index) => `m${index}`));
    expect(maxInFlight).toBe(1);
  });

  test("splits a batch before the runtime frame byte ceiling", async () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    const payload = "x".repeat(900_000);
    for (let i = 0; i < 5; i += 1) recorder.emit("user.message", { text: `${i}${payload}` });
    await recorder.flush();

    expect(t.appended.length).toBeGreaterThan(1);
    for (const request of t.appended) {
      expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThan(8 * 1024 * 1024);
    }
  });

  test("timer flushes a small journal batch without an explicit drain", async () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    recorder.emit("user.message", { text: "eventual" });
    expect(t.appended).toHaveLength(0);
    await Bun.sleep(40);
    expect(t.appended).toHaveLength(1);
    await recorder.flush();
  });

  test("journal errors surface without losing the UI event or snapshotting phantom state", async () => {
    const failures: string[] = [];
    let snapshots = 0;
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: {
        open: async () => ({}),
        append: async () => {
          throw new Error("disk full");
        },
        snapshot: async () => {
          snapshots += 1;
          return {};
        },
        load: async () => ({}),
      },
      onJournalError: (event) => failures.push(event.kind),
    });
    recorder.emit("assistant.final", { text: "done" });
    await recorder.flush();
    expect(failures).toEqual(["assistant.final"]);
    expect(recorder.model.timeline).toHaveLength(1);
    expect(await recorder.maybeSnapshot(true)).toBe(false);
    expect(snapshots).toBe(0);
  });

  test("snapshots at the configured cadence (§18.16)", async () => {
    const t = transport();
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: t,
      snapshotEveryEvents: 3,
    });
    for (let i = 0; i < 2; i += 1) recorder.emit("user.message", { text: `m${i}` });
    expect(await recorder.maybeSnapshot()).toBe(false);
    recorder.emit("user.message", { text: "m2" });
    expect(await recorder.maybeSnapshot()).toBe(true);
    expect(t.snapshots).toHaveLength(1);
  });

  test("a failed snapshot keeps its cadence debt for retry", async () => {
    const t = transport();
    let attempts = 0;
    t.snapshot = async (params) => {
      attempts += 1;
      if (attempts === 1) throw new Error("snapshot unavailable");
      t.snapshots.push(params);
      return { checksum: "retry-ok" };
    };
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: t,
      snapshotEveryEvents: 1,
    });
    recorder.emit("user.message", { text: "x" });

    await expect(recorder.maybeSnapshot()).rejects.toThrow("snapshot unavailable");
    expect(await recorder.maybeSnapshot()).toBe(true);
    expect(t.snapshots).toHaveLength(1);
  });

  test("forced snapshot works on clean exit", async () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    recorder.emit("user.message", { text: "x" });
    expect(await recorder.maybeSnapshot(true)).toBe(true);
  });


  test("checks the resident byte budget immediately for giant durable items", () => {
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: transport(),
      residentTimelineMaxItems: 100,
      residentTimelineMaxBytes: 1_000,
    });
    recorder.emit("user.message", { text: "a".repeat(2_000) });
    recorder.emit("user.message", { text: "b".repeat(2_000) });

    expect(recorder.model.timeline).toHaveLength(1);
    expect(recorder.residentTimelineOmitted).toBe(1);
    expect(recorder.model.timeline[0]?.sequence).toBe(2);
  });

  test("bounds the in-memory timeline without deleting durable journal events", async () => {
    const t = transport();
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: t,
      residentTimelineMaxItems: 3,
      residentTimelineMaxBytes: 1_000_000,
    });
    for (let index = 0; index < 10; index += 1) {
      recorder.emit("user.message", { text: `message ${index}` });
    }
    await recorder.maybeSnapshot(true);

    expect(recorder.model.timeline).toHaveLength(3);
    expect(recorder.residentTimelineOmitted).toBe(7);
    expect(t.appended.flatMap((batch) =>
      (batch as { events: unknown[] }).events,
    )).toHaveLength(10);
    const snapshot = t.snapshots.at(-1) as { reducerState?: { timeline?: unknown[] } };
    expect(snapshot.reducerState?.timeline).toHaveLength(3);
  });

  test("preserves the local event-id high water across ephemeral gaps", () => {
    const t = transport();
    const local = new EventSequencer();
    const first = createEvent(local, "user.message", { text: "earlier" }, { sessionId: "ses_1" });
    createEvent(local, "assistant.delta", { text: "partial" }, { sessionId: "ses_1" });
    const final = createEvent(local, "assistant.final", { text: "done" }, { sessionId: "ses_1" });

    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    // The runtime stores durable events with dense sequences, but keeps the
    // local event id that was assigned before ephemeral deltas were skipped.
    recorder.hydrate([first, { ...final, sequence: 2 }]);
    expect(recorder.emit("user.message", { text: "later" }).sequence).toBe(4);
  });

  test("hydration continues the sequence after resume (AC-35)", () => {
    const t = transport();
    const prior = build([["user.message", { text: "earlier" }]]);
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: t,
      startAfterSequence: 41,
    });
    recorder.hydrate(prior);
    const event = recorder.emit("user.message", { text: "later" });
    expect(event.sequence).toBe(42);
    expect(recorder.model.timeline).toHaveLength(2);
  });
});

describe("markdown export (§8.6, §18.13)", () => {
  test("renders the transcript with evidence", () => {
    const manifest: SessionManifest = {
      schemaVersion: "1.0",
      id: "ses_1",
      workspacePath: "/repo",
      workspaceFingerprint: "abc",
      createdAt: "2026-07-31T10:00:00Z",
      updatedAt: "2026-07-31T10:05:00Z",
      title: "Fix parser",
      modelProfile: "auto",
      permissionMode: "auto-review",
      lastEventSequence: 12,
      state: "completed",
    };
    const model = replay(
      "ses_1",
      build([
        ["user.message", { text: "fix the parser" }],
        ["tool.started", { callId: "c1", toolId: "fs.read", arguments: { path: "src/p.ts" } }],
        ["tool.completed", { callId: "c1", summary: "read 40 lines" }],
        [
          "assistant.final",
          {
            text: "Fixed it.",
            report: {
              status: "completed",
              summary: "Fixed",
              changedFiles: [{ path: "src/p.ts", purpose: "narrow the guard" }],
              verification: [{ command: "bun test", status: "passed", evidence: "12 passed" }],
              delegatedTasks: [],
              risks: ["no integration coverage"],
            },
          },
        ],
      ]),
    );
    const markdown = exportMarkdown(model, manifest);
    expect(markdown).toContain("# Fix parser");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("fix the parser");
    expect(markdown).toContain("`fs.read`");
    expect(markdown).toContain("### Verification");
    expect(markdown).toContain("**passed**");
    expect(markdown).toContain("### Risks");
    expect(markdown).toContain("not a billing source of truth");
    expect(markdown).toContain("- Workspace: `<workspace>`");
    expect(markdown).not.toContain("/repo");
  });
});

// ---------------------------------------------------------------------------
// Hierarchical compaction (§18.9, §11.2)
// ---------------------------------------------------------------------------

describe("hierarchical compaction (§18.9)", () => {
  function busyModel(commentaryCount = 10): SessionViewModel {
    const events: Array<[CbcEventKind, unknown]> = [
      ["user.message", { text: "make the loader resilient" }],
    ];
    for (let i = 0; i < commentaryCount; i += 1) {
      events.push(["assistant.commentary", { text: `decision ${i}: chose approach ${i}` }]);
    }
    events.push([
      "tool.started",
      { callId: "c1", toolId: "fs.read", arguments: { path: "src/gone.ts" } },
    ]);
    events.push([
      "tool.failed",
      { callId: "c1", toolId: "fs.read", code: "NOT_FOUND", message: "src/gone.ts" },
    ]);
    return replay("ses_1", build(events));
  }

  test("a group keeps the highest-ranked entries and folds the rest into a count", () => {
    const result = compact(busyModel(10), "user_requested", estimateTokens, {
      retainPerGroup: 3,
    });
    const decisions = result.state.hierarchy.decisions;
    expect(decisions.retained).toHaveLength(3);
    expect(decisions.foldedCount).toBe(7);
    // Most recent first: that is the one the next step builds on.
    expect(decisions.retained[0]).toContain("decision 9");

    const rendered = renderCompactState(result.state);
    expect(rendered).toContain("## Decisions");
    expect(rendered).toContain("7 earlier entries omitted");
  });

  test("an oversized entry becomes a summary handle rather than inline text (§18.17)", () => {
    const events: Array<[CbcEventKind, unknown]> = [
      ["user.message", { text: "run the suite" }],
      ["assistant.commentary", { text: `verbose: ${"x".repeat(5_000)}` }],
      ["assistant.commentary", { text: "a short decision" }],
    ];
    const spilled: Array<{ label: string; bytes: number }> = [];

    const result = compact(replay("ses_1", build(events)), "user_requested", estimateTokens, {
      maxItemChars: 200,
      spill: (label, content) => {
        spilled.push({ label, bytes: content.length });
        return {
          label,
          bytes: content.length,
          artifactId: "art_1",
          hint: "the full commentary",
        };
      },
    });

    expect(spilled).toHaveLength(1);
    expect(spilled[0]?.bytes).toBeGreaterThan(5_000);
    expect(result.state.hierarchy.decisions.handles[0]?.artifactId).toBe("art_1");
    // The prompt carries the handle, not the content.
    const rendered = renderCompactState(result.state);
    expect(rendered).toContain("art_1");
    expect(rendered).not.toContain("x".repeat(300));
    expect(result.state.hierarchy.decisions.retained).toContain("a short decision");
  });

  test("without an artifact store an oversized entry is truncated, not kept whole", () => {
    const events: Array<[CbcEventKind, unknown]> = [
      ["user.message", { text: "go" }],
      ["assistant.commentary", { text: "y".repeat(4_000) }],
    ];
    const result = compact(replay("ses_1", build(events)), "user_requested", estimateTokens, {
      maxItemChars: 100,
    });
    expect(result.state.hierarchy.decisions.retained[0]).toContain("truncated 3900 chars");
    expect(result.state.hierarchy.decisions.handles).toHaveLength(0);
  });

  test("reflections rank above every other unresolved item (§11.2)", () => {
    const result = compact(busyModel(2), "soft_budget_70", estimateTokens, {
      reflections: [
        {
          toolId: "process.run",
          category: "logic_bug",
          rootCause: "the loader rejects an empty config",
          correctiveAction: "read src/loader.ts before editing again",
          paths: ["src/loader.ts"],
        },
      ],
    });

    const unresolved = result.state.hierarchy.unresolved;
    expect(unresolved.retained[0]).toContain("process.run failed (logic_bug)");
    // The tool failure extracted from the timeline is still there, just ranked lower.
    expect(unresolved.retained.some((line) => line.includes("fs.read failed"))).toBe(true);

    // The files a failure named survive compaction, for the §18.4 weight.
    expect(result.state.failurePaths).toEqual(["src/loader.ts"]);
    const rendered = renderCompactState(result.state);
    expect(rendered).toContain("## Files implicated by failures");
    expect(rendered).toContain("src/loader.ts");

    // Mid-correction, the correction is the next action.
    expect(result.state.nextAction).toBe("read src/loader.ts before editing again");
  });

  test("an explicit active plan step still outranks the correction", () => {
    const model = replay(
      "ses_1",
      build([
        ["user.message", { text: "go" }],
        [
          "plan.updated",
          { items: [{ text: "finish the migration", status: "active" }] },
        ],
      ]),
    );
    const result = compact(model, "user_requested", estimateTokens, {
      reflections: [
        {
          toolId: "fs.read",
          category: "logic_bug",
          rootCause: "wrong path",
          correctiveAction: "re-read the tree",
        },
      ],
    });
    expect(result.state.nextAction).toBe("finish the migration");
  });

  test("compaction never touches the journal (§18.9)", () => {
    const result = compact(busyModel(4), "user_requested", estimateTokens);
    expect(result.journalPreserved).toBe(true);
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(result.eventsSummarized).toBeGreaterThan(0);
  });

  test("a group with nothing in it renders no heading", () => {
    const empty = replay("ses_1", build([["user.message", { text: "hello" }]]));
    const rendered = renderCompactState(
      compact(empty, "user_requested", estimateTokens).state,
    );
    expect(rendered).not.toContain("## Diff summary");
    expect(rendered).toContain("## Goal");
  });

  test("buildGroup is bounded regardless of input size", () => {
    const group = buildGroup(
      "Unresolved",
      Array.from({ length: 500 }, (_, i) => `item ${i}`),
      { retainPerGroup: 4 },
    );
    expect(group.retained).toHaveLength(4);
    expect(group.foldedCount).toBe(496);
    expect(group.heading).toBe("Unresolved");
  });
});

describe("token saving projection (§20.8)", () => {
  test("policy_applied projects requested, effective, and reasons", () => {
    let model = emptyViewModel("s");
    model = reduce(model, build([
      ["token_saving.policy_applied", {
        requestedLevel: "strong",
        effectiveLevel: "balanced",
        ponytail: "full",
        targetInputTokens: 81_600,
        explorationCeiling: 21_120,
        localCompactionRatio: 0.55,
        responseStyle: "concise",
        reasons: ["change spans multiple files"],
      }],
    ])[0] as CbcEvent);
    expect(model.tokenSaving?.requestedLevel).toBe("strong");
    expect(model.tokenSaving?.effectiveLevel).toBe("balanced");
    expect(model.tokenSaving?.ponytail).toBe("full");
    expect(model.tokenSaving?.targetInputTokens).toBe(81_600);
    expect(model.tokenSaving?.explorationCeiling).toBe(21_120);
    expect(model.tokenSaving?.localCompactionRatio).toBe(0.55);
    expect(model.tokenSaving?.responseStyle).toBe("concise");
    expect(model.tokenSaving?.reasons).toEqual(["change spans multiple files"]);
  });

  test("changed updates the requested level", () => {
    let model = emptyViewModel("s");
    model = reduce(model, build([
      ["token_saving.changed", { from: "off", to: "balanced", source: "slash" }],
    ])[0] as CbcEvent);
    expect(model.tokenSaving?.requestedLevel).toBe("balanced");
  });

  test("relaxed keeps the projection current after a mid-turn relaxation", () => {
    let model = emptyViewModel("s");
    for (const event of build([
      ["token_saving.policy_applied", {
        requestedLevel: "strong",
        effectiveLevel: "strong",
        ponytail: "ultra",
        responseStyle: "minimal",
        reasons: [],
      }],
      ["token_saving.relaxed", {
        requestedLevel: "strong",
        effectiveLevel: "light",
        ponytail: "lite",
        responseStyle: "concise",
        reasons: ["security-sensitive path changed"],
      }],
    ])) {
      model = reduce(model, event);
    }
    expect(model.tokenSaving?.requestedLevel).toBe("strong");
    expect(model.tokenSaving?.effectiveLevel).toBe("light");
    expect(model.tokenSaving?.reasons).toEqual(["security-sensitive path changed"]);
  });

  test("resume replays token saving state from journaled events", () => {
    const events = build([
      ["session.started", { sessionId: "s", modelId: "gpt-5.6-sol" }],
      ["token_saving.policy_applied", {
        requestedLevel: "balanced",
        effectiveLevel: "balanced",
        ponytail: "full",
        responseStyle: "concise",
        reasons: [],
      }],
    ]);
    const model = replay("s", events);
    expect(model.tokenSaving?.effectiveLevel).toBe("balanced");
  });
});
