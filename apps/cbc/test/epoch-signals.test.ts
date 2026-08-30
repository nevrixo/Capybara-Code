import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { bundledCapability, MockProvider } from "@cbc/provider-openai";
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

interface Harness {
  readonly session: AgentSession;
  readonly events: CbcEvent[];
  readonly provider: MockProvider;
}

function harness(sessionId: string, provider: MockProvider): Harness {
  const events: CbcEvent[] = [];
  let now = 500;
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime() as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "e".repeat(64),
    trust: "trusted-always",
    sessionId,
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  return { session, events, provider };
}

function resetReasons(events: readonly CbcEvent[]): readonly string[] {
  return events
    .filter((event) => event.kind === "reasoning.epoch_reset")
    .map((event) => (event.payload as { reason: string }).reason);
}

describe("epoch invalidation signals", () => {
  test("an interactive model switch resets the epoch immediately", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-model-changed", provider);
    await session.submit("Fix the parser", new AbortController().signal);
    const before = session.taskEpoch.requireCurrent().id;

    session.setModel("gpt-5.1-codex-mini");

    expect(session.taskEpoch.requireCurrent().id).not.toBe(before);
    expect(resetReasons(events)).toContain("model_changed");
    expect(session.taskEpoch.scope().continuity).toBe("current_turn");
  });

  test("the first route adopts the live capability digest without resetting the epoch", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-capability-adopt", provider);
    await session.submit("Fix the parser", new AbortController().signal);

    const epoch = session.taskEpoch.requireCurrent();
    const route = provider.requests[0]?.model ?? "gpt-5.6-terra";
    const liveDigest = bundledCapability(route)?.digest;
    expect(liveDigest).toBeDefined();
    expect(epoch.modelCapabilityDigest).toBe(liveDigest as string);
    expect(resetReasons(events)).not.toContain("capability_changed");
  });
});
