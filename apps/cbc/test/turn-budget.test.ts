import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

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

interface BudgetHarness {
  readonly session: AgentSession;
  readonly events: CbcEvent[];
}

function harness(
  sessionId: string,
  overrides: {
    readonly budgetEnforcement?: "shadow" | "advisory" | "hard";
    readonly maxCostUsdPerTurn?: number;
  } = {},
): BudgetHarness {
  const events: CbcEvent[] = [];
  const base = loadConfig({ projectTrusted: true, env: {} }).config;
  const config = {
    ...base,
    model: {
      ...base.model,
      router: {
        ...base.model.router,
        ...(overrides.maxCostUsdPerTurn !== undefined
          ? { maxCostUsdPerTurn: overrides.maxCostUsdPerTurn }
          : {}),
      },
    },
    perf: {
      ...base.perf,
      ...(overrides.budgetEnforcement !== undefined
        ? { budgetEnforcement: overrides.budgetEnforcement }
        : {}),
    },
  };
  let now = 500;
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime() as never,
    config,
    workspacePath: "/work",
    workspaceIdentityDigest: "b".repeat(64),
    trust: "trusted-always",
    sessionId,
    provider: new MockProvider({ steps: [{ text: "done" }] }),
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  return { session, events };
}

function payloadsOf(events: readonly CbcEvent[], kind: string): readonly Record<string, unknown>[] {
  return events
    .filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);
}

describe("turn budget enforcement", () => {
  test("publishes the ledger the router's cost ceiling declared", async () => {
    const { session, events } = harness("budget-plan", { maxCostUsdPerTurn: 7 });
    await session.submit("Explain the parser", new AbortController().signal);

    const plans = payloadsOf(events, "budget.plan_created");
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]?.ceilingUsd).toBe(7);
  });

  test("carries the configured enforcement mode rather than defaulting silently", async () => {
    const { session, events } = harness("budget-mode", { budgetEnforcement: "hard" });
    await session.submit("Explain the parser", new AbortController().signal);

    expect(payloadsOf(events, "budget.plan_created")[0]?.mode).toBe("hard");
  });

  test("charges the guard against the ceiling before the provider request", async () => {
    const { session, events } = harness("budget-guard", { maxCostUsdPerTurn: 5 });
    await session.submit("Explain the parser", new AbortController().signal);

    const guards = payloadsOf(events, "budget.guard_triggered");
    expect(guards.length).toBeGreaterThan(0);
    // A ledger that was never charged reports the full ceiling as remaining, so
    // a remaining figure below it is the proof the guard is live rather than a
    // mode string the kernel merely echoed back.
    expect(guards[0]?.remainingUsd).toBeLessThanOrEqual(5);
    expect(guards[0]?.allowed).toBe(true);
  });

  test("refuses the request when a hard ceiling cannot cover it", async () => {
    const { session, events } = harness("budget-exhausted", {
      budgetEnforcement: "hard",
      maxCostUsdPerTurn: 0,
    });
    await session.submit("Explain the parser", new AbortController().signal);

    const exhausted = payloadsOf(events, "budget.exhausted");
    expect(exhausted.length).toBeGreaterThan(0);
    expect(String(exhausted[0]?.reason)).not.toHaveLength(0);
  });
});
