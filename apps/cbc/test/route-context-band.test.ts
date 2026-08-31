/**
 * §5.15: the *configured* context band is the ContextCompiler budget.
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
 * The intent behind §5.15 — a deliberately narrow band should compact earlier —
 * is real, and is carried by `model.context.defaultBand`: a policy chosen before
 * the prompt is seen. The measured band stays a routing/telemetry field.
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

async function runTurn(softContextTokens: number) {
  const provider = new MockProvider({ steps: [{ text: "Done." }] });
  const events: CbcEvent[] = [];
  let now = 1_000;
  const base = loadConfig({ projectTrusted: true, env: {} }).config;
  const config = {
    ...base,
    model: { ...base.model, softContextTokens },
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
  return {
    band: (route?.payload as { contextBand?: number } | undefined)?.contextBand,
    inputBudgetTokens: (pressure?.payload as { inputBudgetTokens?: number } | undefined)
      ?.inputBudgetTokens,
  };
}

describe("the configured context band is the compiler budget (§5.15)", () => {
  test("the enforced budget is the configured band, not the measured one", async () => {
    const defaultBand = loadConfig({ projectTrusted: true, env: {} })
      .config.model.context.defaultBand;
    // A configured soft budget wider than nothing here; the point is that the
    // measured band (64k) does not appear in the enforced number at all.
    const { band, inputBudgetTokens } = await runTurn(96_000);

    expect(band).toBe(64_000);
    // This assertion previously read `64_000 - reserve` (= 32_000) and encoded
    // the defect: a 58k request was judged against a 32k budget.
    expect(inputBudgetTokens).toBe(Math.min(96_000, defaultBand));
    expect(inputBudgetTokens).not.toBe(64_000 - loadConfig({ projectTrusted: true, env: {} })
      .config.model.context.reserveOutputTokens);
  });

  test("the band is a ceiling, so a tighter configured budget still wins", async () => {
    const { band, inputBudgetTokens } = await runTurn(12_000);

    expect(band).toBeGreaterThan(12_000);
    expect(inputBudgetTokens).toBe(12_000);
  });
});
