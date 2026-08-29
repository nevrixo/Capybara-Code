import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";
import type { DeepPlanAnswer, UserAskBatchInput } from "@cbc/session-domain";

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

function config() {
  return loadConfig({
    projectTrusted: true,
    env: {},
    userToml: [
      "[agent]",
      'interaction_mode = "plan"',
      'deep_plan = "on"',
      "",
    ].join("\n"),
  }).config;
}

function firstQuestion(): UserAskBatchInput {
  return {
    questionnaireId: "cache-scope",
    reason: "Choose the cache layer.",
    questions: [{
      id: "layer",
      decisionKey: "cache.layer",
      tab: "Layer",
      question: "Where should cached values live?",
      kind: "single_select",
      required: true,
      options: [{ id: "memory", label: "Memory" }, { id: "redis", label: "Redis" }],
    }],
  };
}

function secondQuestion(): UserAskBatchInput {
  return {
    questionnaireId: "cache-failure",
    reason: "Choose the failure behavior.",
    questions: [{
      id: "failure",
      decisionKey: "cache.failure_policy",
      tab: "Failure",
      question: "What happens if the cache is unavailable?",
      kind: "text",
      required: true,
    }],
  };
}

function planWrite(
  callId = "plan-write",
  expectedRevision = 0,
  extraContext: readonly string[] = [],
) {
  return {
    callId,
    name: "todo.write",
    arguments: {
      expectedRevision,
      reason: "write the evidence-backed cache plan",
      document: {
        goal: "Implement the selected cache behavior",
        context: [
          "cache.layer = Memory, selected by the user.",
          "cache.failure_policy = Fall back to the source, selected by the user.",
          ...extraContext,
        ],
        assumptions: [],
        criticalFiles: [{ path: "src/cache.ts" }],
        verification: [{ id: "cache-tests", command: "bun test" }],
        risks: [],
        rollback: [],
      },
      items: [
        {
          id: "analysis",
          text: "Inspect the cache implementation",
          status: "done",
          kind: "analysis",
          evidence: ["src/cache.ts inspected"],
        },
        {
          id: "implement",
          text: "Implement the selected cache behavior",
          status: "pending",
          kind: "implementation",
          files: ["src/cache.ts"],
          acceptanceCriteria: ["Memory caching falls back to the source on failure"],
        },
        {
          id: "verify",
          text: "Run cache tests",
          status: "pending",
          kind: "verification",
          commands: ["bun test"],
        },
      ],
    },
  };
}

async function makeSession(options: {
  readonly provider: MockProvider;
  readonly askBatch?: (
    input: UserAskBatchInput,
    signal: AbortSignal,
    onDraftChange?: (
      answers: readonly DeepPlanAnswer[],
      activeQuestionIndex: number,
    ) => void,
  ) => Promise<{
    questionnaireId: string;
    status: "submitted" | "draft_now" | "paused" | "cancelled" | "unavailable";
    answers: readonly DeepPlanAnswer[];
  }>;
  readonly nonInteractive?: boolean;
  readonly events?: CbcEvent[];
}): Promise<AgentSession> {
  let now = 1_000;
  const events = options.events ?? [];
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime() as never,
    config: config(),
    workspacePath: "/work",
    workspaceIdentityDigest: "b".repeat(64),
    trust: "trusted-always",
    sessionId: "deep-plan-integration",
    provider: options.provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: options.nonInteractive ?? false,
    ...(options.askBatch === undefined
      ? {}
      : { bridges: { askBatch: options.askBatch } }),
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  await session.open();
  return session;
}

describe("Deep Plan AgentSession integration", () => {
  test("runs ask → retry replay → ask → todo.write → final in one turn", async () => {
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "ask-layer", name: "user.ask_batch", arguments: firstQuestion() }] },
        { toolCalls: [{ callId: "ask-layer-retry", name: "user.ask_batch", arguments: firstQuestion() }] },
        { toolCalls: [{ callId: "ask-failure", name: "user.ask_batch", arguments: secondQuestion() }] },
        { toolCalls: [planWrite()] },
        { text: "The cache Plan Contract is ready." },
        { toolCalls: [planWrite("plan-revision", 1, ["Preserve stale-value metrics."])] },
        { text: "The revised cache Plan Contract is ready." },
      ],
    });
    const bridgeCalls: string[] = [];
    const events: CbcEvent[] = [];
    const session = await makeSession({
      provider,
      events,
      askBatch: async (input, _signal, onDraftChange) => {
        bridgeCalls.push(input.questionnaireId);
        const answers: DeepPlanAnswer[] = input.questionnaireId === "cache-scope"
          ? [{
              questionId: "layer",
              decisionKey: "cache.layer",
              selectedOptionIds: ["memory"],
            }]
          : [{
              questionId: "failure",
              decisionKey: "cache.failure_policy",
              customText: "Fall back to the source",
            }];
        onDraftChange?.(answers, 0);
        return {
          questionnaireId: input.questionnaireId,
          status: "submitted",
          answers,
        };
      },
    });

    const result = await session.submit("Plan the cache behavior", new AbortController().signal);

    expect(result.state).toBe("completed");
    expect(result.answer).toBe("The cache Plan Contract is ready.");
    expect(bridgeCalls).toEqual(["cache-scope", "cache-failure"]);
    expect(session.deepPlanState.answers).toHaveLength(2);
    expect(session.deepPlanState.questionnaireResults).toHaveLength(2);
    expect(session.deepPlanState.phase).toBe("review_ready");
    expect(session.deepPlanState.planRevision).toBe(1);
    expect(session.planReadiness.ready).toBe(true);
    expect(JSON.stringify(provider.requests[1]?.input)).toContain("cache.layer");
    expect(JSON.stringify(provider.requests[3]?.input)).toContain("cache.failure_policy");
    expect(events.filter((event) => event.kind === "assistant.final")).toHaveLength(1);

    const revised = await session.submit(
      "Revise the Plan to preserve stale-value metrics.",
      new AbortController().signal,
    );
    expect(revised.state).toBe("completed");
    expect(revised.answer).toBe("The revised cache Plan Contract is ready.");
    expect(bridgeCalls).toEqual(["cache-scope", "cache-failure"]);
    expect(session.deepPlanState.answers).toHaveLength(2);
    expect(session.deepPlanState.planRevision).toBe(2);
    expect(session.deepPlanState.phase).toBe("review_ready");
    expect(provider.requests).toHaveLength(7);
  });

  test("withholds a no-question early final until todo.write produces a ready Plan", async () => {
    const provider = new MockProvider({
      steps: [
        { text: "The plan is ready too early." },
        { toolCalls: [planWrite("plan-after-gate")] },
        { text: "The ready Plan Contract is final." },
      ],
    });
    const events: CbcEvent[] = [];
    const session = await makeSession({ provider, events });

    const result = await session.submit("Plan the cache behavior", new AbortController().signal);

    expect(result.state).toBe("completed");
    expect(result.answer).toBe("The ready Plan Contract is final.");
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1]?.input)).toContain("DEEP_PLAN_INCOMPLETE");
    const finals = events.filter((event) => event.kind === "assistant.final");
    expect(finals).toHaveLength(1);
    expect(JSON.stringify(finals)).not.toContain("ready too early");
  });

  test("paused and non-interactive questionnaires do not create continuation loops", async () => {
    for (const mode of ["paused", "headless"] as const) {
      const provider = new MockProvider({
        steps: [
          { toolCalls: [{ callId: `ask-${mode}`, name: "user.ask_batch", arguments: firstQuestion() }] },
          { text: `Deep Plan ${mode}.` },
        ],
      });
      const session = await makeSession({
        provider,
        nonInteractive: mode === "headless",
        ...(mode === "paused"
          ? {
              askBatch: async (input) => ({
                questionnaireId: input.questionnaireId,
                status: "paused" as const,
                answers: [],
              }),
            }
          : {}),
      });
      const result = await session.submit("Plan the cache behavior", new AbortController().signal);
      expect(result.state).toBe("completed");
      expect(provider.requests).toHaveLength(2);
      expect(session.deepPlanState.phase).toBe("paused");
    }
  });
});
