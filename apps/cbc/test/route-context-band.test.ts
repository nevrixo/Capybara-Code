/**
 * Context routing bands are telemetry/cost choices, never safety denominators.
 *
 * An earlier attempt wired the route's **measured** `contextBand` into the
 * pressure budget. That could not work, and these tests previously pinned the
 * bug: `selectContextBand` returns the smallest band that already covers
 * `prompt.inputTokens`, so consuming it as a budget compares a request against a
 * number derived from that same request. Every prompt therefore sat in the top
 * of its own band and the upper tenth of every band crossed the 0.9 emergency
 * line — a trivial turn emergency-compacted at ~58k on a 1M-window model and
 * then died with CONTEXT_BUDGET_EXCEEDED. It is also non-monotonic: shrinking a
 * request across a band boundary drops the budget by a whole band, so compaction
 * could raise the ratio it was lowering.
 *
 * A deliberately lower safety ceiling is expressed only by maxInputTokens. The
 * optimization target and routing bands remain independent.
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

async function runTurn(options: {
  optimizationTargetTokens?: number;
  maxInputTokens?: number;
} = {}) {
  const provider = new MockProvider({ steps: [{ text: "Done." }] });
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
        ...(options.maxInputTokens === undefined
          ? {}
          : { maxInputTokens: options.maxInputTokens }),
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
    sessionId: "session-route-context-band",
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });

  await session.submit("Answer briefly", new AbortController().signal);

  const route = events.find((event) => event.kind === "model.route_decided");
  const pressure = events.find((event) => event.kind === "context.pressure_evaluated");
  const pack = events.find((event) => event.kind === "context.pack_compiled");
  return {
    band: (route?.payload as { contextBand?: number } | undefined)?.contextBand,
    inputBudgetTokens: (pressure?.payload as { inputBudgetTokens?: number } | undefined)
      ?.inputBudgetTokens,
    gaugeBudgetTokens: (pack?.payload as {
      contextUsage?: { budgetTokens?: number };
    } | undefined)?.contextUsage?.budgetTokens,
  };
}

describe("routing bands and context safety are independent", () => {
  test("the enforced budget is model input capacity, not a measured or soft band", async () => {
    const { band, inputBudgetTokens } = await runTurn({
      optimizationTargetTokens: 96_000,
    });

    expect(band).toBe(64_000);
    expect(inputBudgetTokens).toBe(1_018_000);
    expect(inputBudgetTokens).not.toBe(96_000);
  });

  test("an explicit maxInputTokens hard cap still wins", async () => {
    const { band, gaugeBudgetTokens, inputBudgetTokens } = await runTurn({
      maxInputTokens: 12_000,
    });

    expect(band).toBeGreaterThan(12_000);
    expect(inputBudgetTokens).toBe(12_000);
    expect(gaugeBudgetTokens).toBe(12_000);
  });
});
