import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider, type MockProviderOptions } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function fakeRuntime() {
  return {
    workspace: "/work",
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
}

async function runTurn(
  input: string,
  options: {
    maxInputTokens?: number;
    optimizationTargetTokens?: number;
    warmupTurns?: number;
    warmupResponseChars?: number;
    contextSummary?: MockProviderOptions["contextSummary"];
    steps?: MockProviderOptions["steps"];
  } = {},
) {
  const warmupTurns = options.warmupTurns ?? 0;
  const provider = new MockProvider({
    steps: options.steps ?? Array.from({ length: warmupTurns + 1 }, (_, index) => ({
        text: index < warmupTurns
          ? `Warmup ${index + 1} complete. ${"w".repeat(options.warmupResponseChars ?? 0)}`
          : "Done.",
      })),
    ...(options.contextSummary === undefined
      ? {}
      : { contextSummary: options.contextSummary }),
  });
  const events: CbcEvent[] = [];
  let now = 1_000;
  const base = loadConfig({ projectTrusted: true, env: {} }).config;
  const config = {
    ...base,
    model: {
      ...base.model,
      context: {
        ...base.model.context,
        ...(options.optimizationTargetTokens === undefined
          ? {}
          : { optimizationTargetTokens: options.optimizationTargetTokens }),
      },
    },
  };
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: fakeRuntime() as never,
    config,
    workspacePath: "/work",
    workspaceIdentityDigest: "c".repeat(64),
    trust: "trusted-always",
    sessionId: "session-context-pressure-regression",
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  for (let turn = 0; turn < warmupTurns; turn += 1) {
    await session.submit(
      `Warmup request ${turn + 1}: remember constraint ${turn + 1}.`,
      new AbortController().signal,
    );
  }
  if (options.maxInputTokens !== undefined) {
    config.model.context.maxInputTokens = options.maxInputTokens;
  }
  const eventStart = events.length;
  await session.submit(input, new AbortController().signal);
  const turnEvents = events.slice(eventStart);
  const pressure = turnEvents
    .filter((event) => event.kind === "context.pressure_evaluated")
    .map((event) => event.payload as {
      state: string;
      requestTokens: number;
      inputBudgetTokens?: number;
      currentRatio?: number;
    });
  const summaryRequests = provider.requests.filter((request) =>
    request.responseFormat?.name === "context_compaction_summary_v2");
  const taskRequests = provider.requests.filter((request) =>
    request.responseFormat?.name !== "context_compaction_summary_v2");
  return {
    events,
    turnEvents,
    pressure,
    provider,
    summaryRequests,
    taskRequests,
    compactions: turnEvents.filter((event) => event.kind === "session.compacted"),
    committed: turnEvents.filter((event) => event.kind === "context.compaction_committed"),
    providerErrors: turnEvents
      .filter((event) => event.kind === "error.provider")
      .map((event) => (event.payload as { message?: string }).message ?? ""),
  };
}

describe("context compaction v2 pressure integration", () => {
  test("uses model input capacity rather than the optimization target", async () => {
    const result = await runTurn(
      "build a vite site with routing and tests. ".repeat(1_630),
      { optimizationTargetTokens: 32_000 },
    );
    const first = result.pressure[0]!;
    expect(first.requestTokens).toBeGreaterThan(50_000);
    expect(first.requestTokens).toBeLessThan(70_000);
    expect(first.inputBudgetTokens).toBe(1_018_000);
    expect(first.state).toBe("stable");
    expect(result.summaryRequests).toHaveLength(0);
    expect(result.taskRequests).toHaveLength(1);
    expect(result.providerErrors).toEqual([]);
  });

  test("runs one model summary before inference when an explicit hard cap reaches 90 percent", async () => {
    const result = await runTurn(
      "Finish the remembered work and report verification.",
      { maxInputTokens: 38_000, warmupTurns: 6, warmupResponseChars: 20_000 },
    );
    expect(result.pressure[0]?.currentRatio).toBeGreaterThanOrEqual(0.9);
    expect(result.summaryRequests).toHaveLength(1);
    expect(result.compactions).toHaveLength(1);
    expect(result.committed).toHaveLength(1);
    expect(result.taskRequests).toHaveLength(7);
    expect(JSON.stringify(result.taskRequests.at(-1)?.input))
      .toContain("Finish the remembered work and report verification.");
    expect(result.providerErrors).toEqual([]);
    const receipt = (result.committed[0]?.payload as {
      receipt?: {
        strategy?: string;
        compiledTokensAfter?: number;
        summaryTokens?: number;
        targetMet?: boolean;
        ratioAfter?: number;
      };
    }).receipt;
    expect(result.turnEvents
      .filter((event) => event.kind === "context.compaction_validation_failed")
      .map((event) => event.payload)).toEqual([]);
    expect(receipt?.strategy).toBe("model_summary");
    expect(receipt?.compiledTokensAfter).not.toBe(receipt?.summaryTokens);
    expect(receipt?.targetMet).toBe(true);
    expect(receipt?.ratioAfter).toBeLessThanOrEqual(0.6);
  });

  test("does not consume a second model attempt in the verification pass", async () => {
    const result = await runTurn(
      "Finish the remembered work and report verification.",
      { maxInputTokens: 38_000, warmupTurns: 6, warmupResponseChars: 20_000 },
    );
    expect(result.summaryRequests).toHaveLength(1);
    expect(result.turnEvents.filter((event) =>
      event.kind === "context.compaction_started")).toHaveLength(1);
  });

  test("keeps old history and still sends the task below emergency when validation fails", async () => {
    const result = await runTurn(
      "Finish the remembered work and report verification.",
      {
        maxInputTokens: 38_000,
        warmupTurns: 6,
        warmupResponseChars: 20_000,
        contextSummary: { output: { schemaVersion: "2.0" } },
      },
    );
    expect(result.summaryRequests).toHaveLength(1);
    expect(result.compactions).toHaveLength(0);
    expect(result.taskRequests).toHaveLength(7);
    expect(result.turnEvents.some((event) =>
      event.kind === "context.compaction_validation_failed")).toBe(true);
  });

  test("uses the explicit emergency fallback when the model summary is invalid", async () => {
    const result = await runTurn(
      "Finish the remembered work and report verification.",
      {
        maxInputTokens: 35_000,
        warmupTurns: 6,
        warmupResponseChars: 20_000,
        contextSummary: { output: { schemaVersion: "2.0" } },
      },
    );
    expect(result.summaryRequests).toHaveLength(1);
    expect(result.compactions).toHaveLength(1);
    const receipt = (result.committed[0]?.payload as {
      receipt?: { strategy?: string; fallbackUsed?: boolean };
    }).receipt;
    expect(receipt).toMatchObject({
      strategy: "deterministic_fallback",
      fallbackUsed: true,
    });
  });

  test("routes a provider context-length error through the same controller once", async () => {
    const result = await runTurn(
      "Retry safely after a provider context error.",
      {
        warmupTurns: 3,
        steps: [
          { text: "Warmup one." },
          { text: "Warmup two." },
          { text: "Warmup three." },
          {
            error: {
              kind: "context_length",
              message: "provider context limit exceeded",
              retryable: false,
            },
          },
          { text: "Recovered after compaction." },
        ],
      },
    );
    expect(result.summaryRequests).toHaveLength(1);
    expect(result.compactions).toHaveLength(1);
    expect(result.taskRequests).toHaveLength(5);
    expect(result.providerErrors).toEqual([]);
    const receipt = (result.committed[0]?.payload as {
      receipt?: { trigger?: string; strategy?: string };
    }).receipt;
    expect(receipt).toMatchObject({
      trigger: "provider_context_error",
      strategy: "model_summary",
    });
  });
});
