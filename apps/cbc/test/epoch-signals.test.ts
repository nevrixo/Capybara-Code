import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { bundledCapability, MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function sessionRuntime(read?: () => Promise<never>) {
  return {
    workspace: "/work",
    read: read ?? (async () => ({
      path: "ignored",
      binary: false,
      checksum: "a".repeat(64),
      rendered: "",
    })),
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

function harness(sessionId: string, provider: MockProvider, read?: () => Promise<never>): Harness {
  const events: CbcEvent[] = [];
  let now = 500;
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime(read) as never,
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

  test("narrowing the active catalog to plan-safe tools resets the epoch", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-toolset-changed", provider);
    await session.submit("Fix the parser", new AbortController().signal);
    const before = session.taskEpoch.requireCurrent();

    const result = await session.requestInteractionMode("plan", "slash");
    expect(result.kind).toBe("applied");

    const after = session.taskEpoch.requireCurrent();
    expect(after.id).not.toBe(before.id);
    expect(after.toolsetDigest).not.toBe(before.toolsetDigest);
    expect(resetReasons(events)).toContain("toolset_changed");
  });

  test("a permission preset switch resets the epoch", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-policy-changed", provider);
    await session.submit("Fix the parser", new AbortController().signal);
    const before = session.taskEpoch.requireCurrent();

    session.setPermissionPreset("read");

    const after = session.taskEpoch.requireCurrent();
    expect(after.id).not.toBe(before.id);
    expect(after.policyDigest).not.toBe(before.policyDigest);
    expect(resetReasons(events)).toContain("policy_changed");
  });

  test("a plain tool failure does not reset the epoch", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "read-missing",
            name: "fs.read",
            arguments: { path: "does/not/exist.ts" },
          }],
        },
        { text: "recovered without abandoning the approach" },
      ],
    });
    const { session, events } = harness("epoch-tool-failure", provider, async () => {
      throw new Error("ENOENT: no such file");
    });

    await session.submit("Read the missing file", new AbortController().signal);

    expect(events.some((event) => event.kind === "tool.failed")).toBe(true);
    // The turn's opening goal is journaled as epoch_started. A tool that simply
    // failed is an ordinary correction, not an abandoned approach, so nothing
    // may add a hypothesis_invalidated reset on top of it.
    expect(events.filter((event) => event.kind === "reasoning.epoch_started")).toHaveLength(1);
    expect(resetReasons(events)).toEqual([]);
    expect(session.taskEpoch.requireCurrent().resetReason).toBe("goal_changed");
  });
});
