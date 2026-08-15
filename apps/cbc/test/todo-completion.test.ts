import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import { EventSequencer, createEvent, type CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function sessionRuntime() {
  return {
    workspace: "/work",
    read: async () => ({
      path: "ignored",
      binary: false,
      checksum: "a".repeat(64),
      rendered: "",
    }),
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
}

describe("root TODO completion integration", () => {
  test("a real todo.write plan prevents a premature final until every item is done", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "todo-create",
            name: "todo.write",
            arguments: {
              expectedRevision: 0,
              reason: "track parser fix",
              items: [{
                id: "parser-fix",
                text: "implement parser fix",
                status: "pending",
                kind: "implementation",
              }],
            },
          }],
        },
        { text: "Everything is already complete." },
        {
          toolCalls: [{
            callId: "todo-active",
            name: "todo.write",
            arguments: {
              expectedRevision: 1,
              reason: "start parser fix",
              items: [{
                id: "parser-fix",
                text: "implement parser fix",
                status: "active",
                kind: "implementation",
              }],
            },
          }],
        },
        {
          toolCalls: [{
            callId: "todo-done",
            name: "todo.write",
            arguments: {
              expectedRevision: 2,
              reason: "parser fix verified",
              items: [{
                id: "parser-fix",
                text: "implement parser fix",
                status: "done",
                kind: "implementation",
                evidence: ["focused parser test passed"],
              }],
            },
          }],
        },
        { text: "The parser fix is complete." },
      ],
    });
    const events: CbcEvent[] = [];
    let now = 1_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "b".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-completion-integration",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });

    const result = await session.submit("Fix the parser", new AbortController().signal);

    expect(result.state).toBe("completed");
    expect(result.report.status).toBe("completed");
    expect(result.answer).toBe("The parser fix is complete.");
    expect(session.todo.items).toMatchObject([{ id: "parser-fix", status: "done" }]);
    expect(session.permissionContext().planExecutionRequired).toBe(false);
    expect(session.promptInputs().planContract?.revision).toBe(3);
    expect(session.promptInputs().planContract?.items).toMatchObject([{ id: "parser-fix", kind: "implementation" }]);
    expect(provider.requests).toHaveLength(5);
    expect(JSON.stringify(provider.requests[2]?.input)).toContain("TODO completion gate");

    const finals = events.filter((event) => event.kind === "assistant.final");
    expect(finals).toHaveLength(1);
    expect(JSON.stringify(finals[0]?.payload)).toContain("The parser fix is complete.");
    expect(JSON.stringify(finals[0]?.payload)).not.toContain("Everything is already complete.");
  });


  test("malformed hydrated plan state cannot make a final complete", async () => {
    const provider = new MockProvider({ steps: [{ text: "Everything is complete." }] });
    const session = new AgentSession({
      host: { now: () => 2_000 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "d".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-malformed-hydration",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 2_000,
      onEvent: () => undefined,
    });
    const sequencer = new EventSequencer();
    session.hydrate([createEvent(sequencer, "plan.created", {
      revision: 1,
      items: [{ id: "broken", text: "restore plan", status: "corrupt" }],
    }, { sessionId: "todo-malformed-hydration" })]);
    expect(session.todo.items).toMatchObject([{ status: "blocked" }]);

    const result = await session.submit("Continue", new AbortController().signal);
    expect(result.state).not.toBe("completed");
    expect(result.report.status).not.toBe("completed");
  });

  test("a rejected first TODO update cannot make an optimistic final complete", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "todo-claim-done",
            name: "todo.write",
            arguments: {
              expectedRevision: 0,
              reason: "claim completion without doing the work",
              items: [{
                id: "parser-fix",
                text: "implement parser fix",
                status: "done",
                kind: "implementation",
                evidence: ["claimed by the model"],
              }],
            },
          }],
        },
        { text: "The parser fix is complete." },
      ],
    });
    const session = new AgentSession({
      host: { now: () => 1_000 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "c".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-rejected-first-update",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 1_000,
      onEvent: () => undefined,
    });

    const result = await session.submit("Fix the parser", new AbortController().signal);

    expect(result.state).not.toBe("completed");
    expect(result.report.status).not.toBe("completed");
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(provider.requests[1]?.input)).toContain("Current TODO state");
    expect(JSON.stringify(provider.requests[1]?.input)).toContain("expectedRevision");
    expect(result.answer).toContain("rejected TODO update");
  });

  test("a rejected TODO update can be repaired by a later valid model update", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "todo-invalid-completion",
            name: "todo.write",
            arguments: {
              expectedRevision: 0,
              reason: "claim completion without tracking the work",
              items: [{ id: "parser-fix", text: "implement parser fix", status: "done", kind: "implementation", evidence: ["claimed"] }],
            },
          }],
        },
        { text: "The parser fix is complete." },
        {
          toolCalls: [{
            callId: "todo-recover-pending",
            name: "todo.write",
            arguments: {
              expectedRevision: 0,
              reason: "repair the rejected checklist with the real work",
              items: [{ id: "parser-fix", text: "implement parser fix", status: "pending", kind: "implementation" }],
            },
          }],
        },
        {
          toolCalls: [{
            callId: "todo-recover-active",
            name: "todo.write",
            arguments: {
              expectedRevision: 1,
              reason: "start the repaired parser work",
              items: [{ id: "parser-fix", text: "implement parser fix", status: "active", kind: "implementation" }],
            },
          }],
        },
        {
          toolCalls: [{
            callId: "todo-recover-done",
            name: "todo.write",
            arguments: {
              expectedRevision: 2,
              reason: "finish and verify the repaired parser work",
              items: [{ id: "parser-fix", text: "implement parser fix", status: "done", kind: "implementation", evidence: ["verified"] }],
            },
          }],
        },
        { text: "The parser fix is complete." },
      ],
    });
    const session = new AgentSession({
      host: { now: () => 1_500 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "r".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-rejected-update-recovery",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 1_500,
      onEvent: () => undefined,
    });

    const result = await session.submit("Fix the parser", new AbortController().signal);

    expect(result.state).toBe("completed");
    expect(result.report.status).toBe("completed");
    expect(result.answer).toBe("The parser fix is complete.");
    expect(session.todo.modelMutationError).toBeUndefined();
    expect(session.todo.items).toMatchObject([{ id: "parser-fix", status: "done" }]);
    expect(provider.requests).toHaveLength(6);
    expect(JSON.stringify(provider.requests[2]?.input)).toContain("previous todo.write was rejected");
  });

  test("a rejected TODO mutation remains blocked after journal hydration", async () => {
    const events: CbcEvent[] = [];
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "todo-rejected-restart",
            name: "todo.write",
            arguments: {
              expectedRevision: 0,
              reason: "claim completion without progress",
              items: [{ id: "impl", text: "implement parser", status: "done", kind: "implementation", evidence: ["claimed"] }],
            },
          }],
        },
        { text: "The parser is complete." },
      ],
    });
    const first = new AgentSession({
      host: { now: () => 3_000 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "e".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-rejected-restart",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 3_000,
      onEvent: (event) => { events.push(event); },
    });
    const firstResult = await first.submit("Fix the parser", new AbortController().signal);
    expect(firstResult.report.status).not.toBe("completed");
    expect(events.some((event) => event.kind === "tool.failed" && JSON.stringify(event.payload).includes("todo.write"))).toBe(true);

    const resumed = new AgentSession({
      host: { now: () => 4_000 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "e".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-rejected-restart",
      provider: new MockProvider({ steps: [{ text: "The parser is complete." }] }),
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 4_000,
      onEvent: () => undefined,
    });
    resumed.hydrate(events);
    expect(resumed.todo.modelMutationError).toContain("TODO update rejected");
    const resumedResult = await resumed.submit("Continue", new AbortController().signal);
    expect(resumedResult.report.status).not.toBe("completed");
  });



  test("a Plan Contract introduced mid-turn cannot bypass explicit approval", async () => {
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "plan-pending", name: "todo.write", arguments: { expectedRevision: 0, reason: "track work", items: [{ id: "impl", text: "implement parser", status: "pending", kind: "implementation" }] } }] },
        { toolCalls: [{ callId: "plan-active", name: "todo.write", arguments: { expectedRevision: 1, reason: "start work", items: [{ id: "impl", text: "implement parser", status: "active", kind: "implementation" }] } }] },
        { toolCalls: [{ callId: "plan-done", name: "todo.write", arguments: { expectedRevision: 2, reason: "finish work", items: [{ id: "impl", text: "implement parser", status: "done", kind: "implementation", evidence: ["verified"] }] } }] },
        { toolCalls: [{ callId: "plan-late", name: "todo.write", arguments: {
          expectedRevision: 3,
          reason: "attach a contract after completion",
          document: { goal: "Fix parser", context: ["Parser source"], criticalFiles: [{ path: "src/parser.ts" }], verification: [{ command: "bun test" }], risks: [], rollback: [] },
          items: [{ id: "impl", text: "implement parser", status: "done", kind: "implementation", evidence: ["verified"] }],
        } }] },
        { text: "The parser is complete." },
      ],
    });
    const session = new AgentSession({
      host: { now: () => 5_000 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "f".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-midturn-plan-approval",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 5_000,
      onEvent: () => undefined,
    });
    const result = await session.submit("Fix the parser", new AbortController().signal);
    expect(result.state).not.toBe("completed");
    expect(result.report.status).not.toBe("completed");
  });

  test("keeps an approved Plan Contract executable after a cancelled turn", async () => {
    const provider = new MockProvider({
      steps: [{ error: { kind: "authentication", message: "continuation reached the provider", retryable: false } }],
    });
    const session = new AgentSession({
      host: { now: () => 6_000 } as never,
      runtime: sessionRuntime() as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "g".repeat(64),
      trust: "trusted-always",
      sessionId: "todo-resume-approved-plan",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => 6_000,
      onEvent: () => undefined,
    });
    const created = session.writeTodo({
      expectedRevision: 0,
      reason: "record parser repair plan",
      source: "user",
      document: {
        goal: "Repair the parser",
        context: ["Parser source and focused tests"],
        criticalFiles: [{ path: "src/parser.ts" }],
        verification: [{ command: "bun test" }],
        risks: [],
        rollback: [],
      },
      items: [
        {
          id: "implement",
          text: "Repair parser input handling",
          status: "pending",
          kind: "implementation",
          files: ["src/parser.ts"],
          acceptanceCriteria: ["The parser accepts valid input"],
        },
        { id: "verify", text: "Run focused parser tests", status: "pending", kind: "verification" },
      ],
    });
    expect(created.ok).toBe(true);

    const execution = await session.preparePlanExecution("keep", "ui");
    if (!execution.ok) throw new Error(execution.message);

    const cancellation = new AbortController();
    cancellation.abort();
    const cancelled = await session.submit(execution.directive, cancellation.signal);

    expect(cancelled.report.status).toBe("cancelled");
    expect(session.approvedPlanScope()?.digest).toBe(session.planApproval?.digest);

    const resumed = await session.submit("Continue the approved plan.", new AbortController().signal);
    expect(resumed.report.status).toBe("failed");
    expect(provider.requests).toHaveLength(1);
  });
});
