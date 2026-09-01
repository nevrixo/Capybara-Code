import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function fakeRuntime() {
  const snapshots: unknown[] = [];
  let lastSequence = 0;
  return {
    snapshots,
    workspace: "/work",
    appendEvents: async (params: { events?: Array<{ id?: string }> }) => {
      const stored = (params.events ?? []).map((event) => ({
        id: event.id,
        sequence: ++lastSequence,
      }));
      return { appended: stored.length, lastSequence, events: stored };
    },
    openSession: async () => ({ ok: true }),
    snapshotSession: async (params: unknown) => {
      snapshots.push(params);
      return { ok: true };
    },
    loadSession: async () => ({ events: [] }),
  };
}

function makeSession(provider: MockProvider, events: CbcEvent[], sessionId = "provider-compact") {
  let now = 1_000;
  const runtime = fakeRuntime();
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: runtime as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "d".repeat(64),
    trust: "trusted-always",
    sessionId,
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  return { session, runtime };
}

describe("explicit provider context compaction", () => {
  test("does not call the API when the session has no compressible history", async () => {
    const provider = new MockProvider({ steps: [{ text: "unused" }] });
    const events: CbcEvent[] = [];
    const { session } = makeSession(provider, events);

    const result = await session.compactContextWithProvider();

    expect(result).toEqual({ kind: "nothing" });
    expect(provider.compactionRequests).toHaveLength(0);
    expect(events.filter((event) => event.kind === "session.compacted")).toHaveLength(0);
  });

  test("adopts the provider's opaque compacted history and forces a durable snapshot", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      compactionOpaque: "opaque-provider-state",
    });
    const events: CbcEvent[] = [];
    const { session, runtime } = makeSession(provider, events);
    await session.submit("Remember this request", new AbortController().signal);

    const result = await session.compactContextWithProvider();

    expect(result.kind).toBe("compacted");
    expect(provider.compactionRequests).toHaveLength(1);
    expect(provider.compactionRequests[0]?.input.some(
      (item) => item.type === "message" && item.role === "assistant",
    )).toBe(true);
    expect(session.kernel.history.some((item) => item.type === "message" && item.role === "assistant")).toBe(false);
    expect(session.kernel.history.at(-1)).toEqual({
      type: "compaction",
      opaque: "opaque-provider-state",
    });
    expect(session.compactState).toBeUndefined();
    expect(runtime.snapshots.length).toBeGreaterThan(0);

    const compacted = events.findLast((event) => event.kind === "session.compacted");
    expect(compacted?.payload).toMatchObject({
      method: "responses.compact",
      providerCompactionOpaque: "opaque-provider-state",
    });
    const usage = events.findLast((event) => event.kind === "usage.updated");
    expect(usage?.payload).toMatchObject({ operation: "responses.compact" });
    expect(session.viewModel.timeline.at(-1)).toMatchObject({
      type: "notice",
      text: expect.stringContaining("provider native"),
    });
  });

  test("journal replay restores the opaque continuation instead of local compact prose", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      compactionOpaque: "opaque-resume-state",
    });
    const events: CbcEvent[] = [];
    const { session } = makeSession(provider, events, "provider-resume");
    await session.submit("Persist this request", new AbortController().signal);
    await session.compactContextWithProvider();

    const replayEvents: CbcEvent[] = [];
    const replayProvider = new MockProvider({ steps: [{ text: "unused" }] });
    const { session: replayed } = makeSession(replayProvider, replayEvents, "provider-resume");
    replayed.hydrate(events);

    expect(replayed.kernel.history.filter((item) => item.type === "compaction")).toEqual([
      { type: "compaction", opaque: "opaque-resume-state" },
    ]);
    expect(replayed.kernel.history.some(
      (item) => item.type === "message" && item.role === "assistant",
    )).toBe(false);
    expect(replayed.compactState).toBeUndefined();
  });

  test("reports provider failure without emitting a fake local compaction", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      compactionError: {
        kind: "invalid_request",
        message: "compact endpoint unavailable",
        retryable: false,
      },
    });
    const events: CbcEvent[] = [];
    const { session } = makeSession(provider, events, "provider-failure");
    await session.submit("Do not fake compaction", new AbortController().signal);

    const result = await session.compactContextWithProvider();

    expect(result).toMatchObject({ kind: "failed" });
    expect(events.filter((event) => event.kind === "session.compacted")).toHaveLength(0);
    expect(session.kernel.history.some(
      (item) => item.type === "message" && item.role === "assistant",
    )).toBe(true);
  });
});

describe("model-summary compaction persistence", () => {
  test("restores the exact retained tail and summary once after journal replay", async () => {
    const provider = new MockProvider({
      steps: [
        { text: "First answer." },
        { text: "Second answer." },
        { text: "Third answer." },
      ],
    });
    const events: CbcEvent[] = [];
    const { session } = makeSession(provider, events, "model-summary-resume");
    await session.submit("First instruction", new AbortController().signal);
    await session.submit("Second instruction", new AbortController().signal);
    await session.submit("Third instruction", new AbortController().signal);

    const outcome = await session.compactContext({ userRequested: true });
    expect(outcome !== undefined && "kind" in outcome ? outcome.kind : "legacy").toBe("compacted");
    expect(provider.requests.filter((request) =>
      request.responseFormat?.name === "context_compaction_summary_v2")).toHaveLength(1);
    expect(session.compactState).toContain("Session state (model-compacted)");
    const liveHistory = structuredClone(session.kernel.history);
    expect(events.filter((event) => event.kind === "session.compacted")).toHaveLength(1);

    const replayEvents: CbcEvent[] = [];
    const replayProvider = new MockProvider({ steps: [] });
    const { session: replayed } = makeSession(
      replayProvider,
      replayEvents,
      "model-summary-resume",
    );
    replayed.hydrate(events);

    expect(replayed.kernel.history).toEqual(liveHistory);
    expect(replayed.compactState).toBe(session.compactState);
    expect(replayed.viewModel.contextGeneration).toBe(1);
  });
});
