import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";
import { parseSlash } from "../src/slash.ts";

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

function makeSession(
  provider: MockProvider,
  events: CbcEvent[],
  configure?: (config: ReturnType<typeof loadConfig>["config"]) => void,
): AgentSession {
  let now = 0;
  const config = loadConfig({ projectTrusted: true, env: {} }).config;
  configure?.(config);
  return new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime() as never,
    config,
    workspacePath: "/work",
    workspaceIdentityDigest: "b".repeat(64),
    trust: "trusted-always",
    sessionId: "openai-modes-integration",
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => {
      events.push(event);
    },
  });
}

describe("programmatic tool calling runtime wiring", () => {
  test("the default read-only policy selects PTC only with eligible API tools", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      capabilities: { parallelToolCalls: true },
    });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    await session.submit("implement after inspecting the repository", new AbortController().signal);

    expect(provider.requests[0]?.hostedTools).toEqual([
      { type: "programmatic_tool_calling" },
    ]);
    expect(provider.requests[0]?.tools.find((tool) => tool.name === "fs.read")?.allowedCallers)
      .toEqual(["direct", "programmatic"]);
    expect(events.find((event) => event.kind === "model.route_decided")?.payload)
      .toMatchObject({ lane: "program" });
  });

  test("the disabled config keeps the same task on the direct lane", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      capabilities: { parallelToolCalls: true },
    });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events, (config) => {
      config.provider.openai.native.programmaticToolCalling = "disabled";
    });
    await session.open({ emitEvent: false });

    await session.submit("implement after inspecting the repository", new AbortController().signal);

    expect(provider.requests[0]?.hostedTools).toBeUndefined();
    expect(events.find((event) => event.kind === "model.route_decided")?.payload)
      .toMatchObject({ lane: "direct" });
  });
});

describe("/setting fast-mode and long-context routing", () => {
  test("parses direct commands for both new settings", () => {
    expect(parseSlash("/setting fast-mode fast")).toEqual({
      kind: "setting",
      setting: "fast-mode",
      value: "fast",
    });
    expect(parseSlash("/setting fast-mode standard")).toEqual({
      kind: "setting",
      setting: "fast-mode",
      value: "standard",
    });
    expect(parseSlash("/setting long-context allow")).toEqual({
      kind: "setting",
      setting: "long-context",
      value: "allow",
    });
  });
});

describe("fast mode runtime wiring", () => {
  test("defaults to the standard tier and switches live on a fast-tier backend", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      repeatLast: true,
      capabilities: { fastTier: true },
    });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    expect(session.liveServiceTier).toBe("standard");
    expect(session.fastModeSupported).toBe(true);

    await session.submit("first request", new AbortController().signal);
    expect(provider.requests[0]?.serviceTier).toBe("standard");

    expect(session.setServiceTier("fast")).toBe(true);
    expect(session.liveServiceTier).toBe("fast");
    expect(session.kernel.serviceTier).toBe("fast");

    await session.submit("second request", new AbortController().signal);
    expect(provider.requests[1]?.serviceTier).toBe("fast");
  });

  test("refuses the switch on a backend without the fast tier", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      capabilities: { fastTier: false },
    });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    expect(session.fastModeSupported).toBe(false);
    expect(session.setServiceTier("fast")).toBe(false);
    expect(session.liveServiceTier).toBe("standard");

    await session.submit("account-style request", new AbortController().signal);
    expect(provider.requests[0]?.serviceTier).toBeUndefined();
  });
});

describe("premium context policy runtime wiring", () => {
  test("defaults to utility gating and switches live", async () => {
    const provider = new MockProvider({ steps: [{ text: "Done." }] });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    expect(session.livePremiumContextPolicy).toBe("utility-gated");

    session.setPremiumContextPolicy("allow");
    expect(session.livePremiumContextPolicy).toBe("allow");
    expect(session.kernel.premiumContextPolicy).toBe("allow");

    session.setPremiumContextPolicy("utility-gated");
    expect(session.livePremiumContextPolicy).toBe("utility-gated");
    expect(session.kernel.premiumContextPolicy).toBe("utility-gated");
  });

  test("the compiled context plan announces the live policy", async () => {
    const provider = new MockProvider({
      steps: [{ text: "Done." }],
      repeatLast: true,
    });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    await session.submit("first request", new AbortController().signal);
    const gated = events.filter((event) => event.kind === "context.plan_created");
    expect(gated.length).toBeGreaterThan(0);
    for (const event of gated) {
      expect((event.payload as Record<string, unknown>).utilityGated).toBe(true);
    }

    session.setPremiumContextPolicy("allow");
    await session.submit("second request", new AbortController().signal);
    const plans = events.filter((event) => event.kind === "context.plan_created");
    const last = plans[plans.length - 1];
    expect((last?.payload as Record<string, unknown>).utilityGated).toBe(false);
  });
});
