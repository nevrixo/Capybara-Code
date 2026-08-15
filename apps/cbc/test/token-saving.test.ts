import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";
import { parseSlash, slashArgumentValues } from "../src/slash.ts";

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

function makeSession(provider: MockProvider, events: CbcEvent[]): AgentSession {
  let now = 0;
  return new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime() as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "b".repeat(64),
    trust: "trusted-always",
    sessionId: "token-saving-integration",
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

describe("/setting token-saving routing", () => {
  test("parses the direct command", () => {
    expect(parseSlash("/setting token-saving balanced")).toEqual({
      kind: "setting",
      setting: "token-saving",
      value: "balanced",
    });
  });

  test("leaves choices to the settings popup instead of offering argument completion", () => {
    expect(slashArgumentValues({
      command: "/setting",
      index: 0,
      argument: undefined,
      query: "",
      preceding: [],
    })).toBeUndefined();

    expect(slashArgumentValues({
      command: "/setting",
      index: 1,
      argument: undefined,
      query: "",
      preceding: ["token-saving"],
    })).toBeUndefined();
  });
});

describe("token saving runtime wiring", () => {
  test("off keeps the provider request identical to the unchanged product", async () => {
    const provider = new MockProvider({ steps: [{ text: "Done." }] });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    await session.submit("Fix the parser", new AbortController().signal);

    const request = provider.requests[0];
    expect(JSON.stringify(request?.input)).not.toContain("token-saving directive");
    const policy = events.find((event) => event.kind === "token_saving.policy_applied");
    expect(policy).toBeDefined();
    const payload = policy?.payload as Record<string, unknown>;
    expect(payload.requestedLevel).toBe("off");
    expect(payload.effectiveLevel).toBe("off");
    expect(payload.targetInputTokens).toBe(96_000);
    expect(payload.explorationCeiling).toBe(28_800);
    expect(payload.localCompactionRatio).toBe(0.7);
  });

  test("balanced actually changes the next provider request", async () => {
    const provider = new MockProvider({ steps: [{ text: "Done." }] });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    await session.open({ emitEvent: false });

    const transition = session.setTokenSaving("balanced", "slash");
    expect(transition).toEqual({ from: "off", to: "balanced" });
    expect(session.tokenSaving.requestedLevel).toBe("balanced");
    const changed = events.find((event) => event.kind === "token_saving.changed");
    expect(changed?.payload).toMatchObject({ from: "off", to: "balanced", source: "slash" });

    await session.submit("Fix the parser", new AbortController().signal);

    // The directive reaches the provider in the very next request.
    const request = provider.requests[0];
    const serialized = JSON.stringify(request?.input);
    expect(serialized).toContain("Effective level: BALANCED.");
    expect(serialized).toContain(
      "Do not weaken validation, security, error handling, verification, or requested behavior.",
    );

    // The journaled policy announces the exact budgets the turn ran with.
    const policy = events.find((event) => event.kind === "token_saving.policy_applied");
    const payload = policy?.payload as Record<string, unknown>;
    expect(payload.requestedLevel).toBe("balanced");
    expect(payload.effectiveLevel).toBe("balanced");
    expect(payload.targetInputTokens).toBe(Math.floor(96_000 * 0.85));
    expect(payload.explorationCeiling).toBe(Math.floor(96_000 * 0.22));
    expect(payload.localCompactionRatio).toBe(0.55);
    expect(payload.ponytail).toBe("full");
    expect(payload.responseStyle).toBe("concise");
    expect(events.some((event) => event.kind === "token_saving.relaxed")).toBe(false);
  });

  test("a repeated request for the same level does not re-announce a change", () => {
    const provider = new MockProvider({ steps: [{ text: "Done." }] });
    const events: CbcEvent[] = [];
    const session = makeSession(provider, events);
    expect(session.setTokenSaving("strong", "slash")).toEqual({ from: "off", to: "strong" });
    expect(session.setTokenSaving("strong", "slash")).toBeUndefined();
    expect(events.filter((event) => event.kind === "token_saving.changed")).toHaveLength(1);
  });
});
