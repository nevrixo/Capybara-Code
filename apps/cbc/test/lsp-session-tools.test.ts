import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function makeSession(fullLsp: boolean, includeBridge: boolean, trust: "trusted-always" | "untrusted" = "trusted-always"): AgentSession {
  const config = structuredClone(loadConfig({ projectTrusted: true, env: {} }).config);
  config.experimental.fullLsp = fullLsp;
  config.lsp.enabled = true;
  const runtime = {
    workspace: "/work",
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
  return new AgentSession({
    host: { now: () => 1 } as never,
    runtime: runtime as never,
    config,
    workspacePath: "/work",
    workspaceIdentityDigest: "a".repeat(64),
    trust,
    sessionId: "session-lsp-tools",
    provider: new MockProvider({ steps: [] }),
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    ...(includeBridge
      ? {
          bridges: {
            lsp: async () => ({ result: { ok: true, summary: "current diagnostics" } }),
          },
        }
      : {}),
  });
}

describe("AgentSession LSP diagnostics tool gate", () => {
  test("requires both the fullLsp feature flag and a supplied root bridge", () => {
    const disabled = makeSession(false, true);
    const missingBridge = makeSession(true, false);
    const enabled = makeSession(true, true);
    const untrusted = makeSession(true, true, "untrusted");

    expect(disabled.registry.has("lsp.diagnostics")).toBe(false);
    expect(missingBridge.registry.has("lsp.diagnostics")).toBe(false);
    expect(enabled.registry.has("lsp.diagnostics")).toBe(true);
    expect(untrusted.registry.has("lsp.diagnostics")).toBe(false);
    expect(enabled.registry.activeIds()).not.toContain("lsp.diagnostics");
  });
});
