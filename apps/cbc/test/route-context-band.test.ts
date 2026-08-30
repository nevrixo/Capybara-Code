/**
 * §5.15: `contextBand` → ContextCompiler hard/target budget.
 *
 * The band was computed, announced as `model.route_decided`, and stored on the
 * session — and then nothing read it. These tests pin the consumption, because a
 * band that does not move the compaction boundary is exactly the telemetry-only
 * router field P0-03 exists to remove.
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

describe("the route's context band is the compiler budget (§5.15)", () => {
  test("the pressure budget is the band minus the route's own output reserve", async () => {
    const reserve = loadConfig({ projectTrusted: true, env: {} })
      .config.model.context.reserveOutputTokens;
    // A configured budget wider than the band, so the band is the binding limit
    // and the assertion cannot pass by accident.
    const { band, inputBudgetTokens } = await runTurn(96_000);

    expect(band).toBe(64_000);
    // Before this was wired the budget was the configured 96k, derived from the
    // model's whole window: a 64k band on a 1M-window model compacted at 1M.
    expect(inputBudgetTokens).toBe(64_000 - reserve);
    expect(inputBudgetTokens!).toBeLessThan(96_000);
  });

  test("the band is a ceiling, so a tighter configured budget still wins", async () => {
    const { band, inputBudgetTokens } = await runTurn(12_000);

    expect(band).toBeGreaterThan(12_000);
    expect(inputBudgetTokens).toBe(12_000);
  });
});
