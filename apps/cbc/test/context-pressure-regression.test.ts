/**
 * The adaptive context guard must not fail a turn it could have sent.
 *
 * A trivial request on a ~1M-window model reached the emergency safety line at
 * ~58k tokens, compacted four times to byte-identical results, and died with
 * CONTEXT_BUDGET_EXCEEDED having never contacted the provider. Three defects
 * composed:
 *
 *  - the pressure budget was the route's *measured* context band, which
 *    `selectContextBand` derives from the very prompt it was meant to bound;
 *  - `retainHistoryForPrompt` read a cursor of 0 as "everything was sampled",
 *    so compaction reclaimed nothing and the recompile was identical;
 *  - the guard's verification pass compacted again and the kernel converted the
 *    futile recompile into a non-retryable local error.
 *
 * These tests pin the reported numbers so none of the three can return.
 */

import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
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
  overrides: { defaultBand?: number; softContextTokens?: number } = {},
) {
  const provider = new MockProvider({ steps: [{ text: "Done." }] });
  const events: CbcEvent[] = [];
  let now = 1_000;
  const base = loadConfig({ projectTrusted: true, env: {} }).config;
  const config = {
    ...base,
    model: {
      ...base.model,
      ...(overrides.softContextTokens === undefined
        ? {}
        : { softContextTokens: overrides.softContextTokens }),
      context: {
        ...base.model.context,
        ...(overrides.defaultBand === undefined ? {} : { defaultBand: overrides.defaultBand }),
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

  await session.submit(input, new AbortController().signal);

  const count = (kind: string) => events.filter((event) => event.kind === kind).length;
  const pressure = events
    .filter((event) => event.kind === "context.pressure_evaluated")
    .map((event) => event.payload as {
      state: string;
      requestTokens: number;
      inputBudgetTokens?: number;
      currentRatio?: number;
    });
  return {
    events,
    pressure,
    band: (events.find((event) => event.kind === "model.route_decided")?.payload as
      { contextBand?: number } | undefined)?.contextBand,
    compactions: count("session.compacted"),
    emergencies: count("context.compaction_emergency"),
    requestsSent: count("provider.request_sent"),
    providerErrors: events
      .filter((event) => event.kind === "error.provider")
      .map((event) => (event.payload as { message?: string }).message ?? ""),
  };
}

describe("a sendable request is never failed locally", () => {
  test("a mid-band prompt on a wide-window model stays stable and reaches the provider", async () => {
    // ~56k compiled tokens: the size that used to select the 64k band, halve it
    // to a 32k budget, and report ratio 1.76 on a 1,050,000-token window.
    const result = await runTurn("build a vite site with routing and tests. ".repeat(1_630));
    const first = result.pressure[0]!;

    expect(first.requestTokens).toBeGreaterThan(50_000);
    expect(first.requestTokens).toBeLessThan(70_000);
    // The budget is the configured allowance, not a function of the request.
    expect(first.inputBudgetTokens).toBe(96_000);
    expect(first.state).toBe("stable");
    expect(first.currentRatio!).toBeLessThan(0.9);

    expect(result.compactions).toBe(0);
    expect(result.emergencies).toBe(0);
    expect(result.requestsSent).toBe(1);
    expect(result.providerErrors).toEqual([]);
  });

  test("the measured band is still announced, but never bounds the budget", async () => {
    const result = await runTurn("Answer briefly");

    // Routing, cost, and premium gating still see the measured band...
    expect(result.band).toBe(64_000);
    // ...while the enforced budget comes from configuration alone. Consuming the
    // band here is what pinned every request into the top of its own band.
    expect(result.pressure[0]!.inputBudgetTokens).toBe(96_000);
  });

  test("an over-budget prompt compacts once, not once per guard pass", async () => {
    const result = await runTurn("build a vite site with routing and tests. ".repeat(5_170));

    // The kernel calls the guard twice: once to decide, once to verify. Only the
    // deciding pass may compact.
    expect(result.compactions).toBe(1);
    expect(result.emergencies).toBe(0);
  });

  test("an irreducible prompt is sent for provider arbitration instead of dying", async () => {
    // A band far below the incompressible prompt floor (L0-L4, L6, tool schemas)
    // cannot be satisfied by any amount of local compaction.
    const result = await runTurn("Answer briefly", { defaultBand: 4_000, softContextTokens: 4_000 });

    expect(result.requestsSent).toBe(1);
    expect(result.providerErrors).toEqual([]);
    const missed = result.events.find((event) => event.kind === "context.compaction_target_missed");
    expect(missed).toBeDefined();
    expect((missed!.payload as { reasonCodes?: string[] }).reasonCodes)
      .toContain("irreducible_prompt_floor");
  });

  test("a narrower configured band genuinely compacts earlier (§5.15's intent)", async () => {
    const wide = await runTurn("build a vite site with routing and tests. ".repeat(1_630));
    const narrow = await runTurn(
      "build a vite site with routing and tests. ".repeat(1_630),
      { defaultBand: 32_000 },
    );

    expect(wide.pressure[0]!.state).toBe("stable");
    // The same prompt under a deliberately narrow policy band does compact —
    // which is what §5.15 wanted, expressed by a number chosen before the prompt.
    expect(narrow.pressure[0]!.inputBudgetTokens).toBe(32_000);
    expect(narrow.pressure[0]!.state).not.toBe("stable");
  });
});
