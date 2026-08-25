import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function makeSession(
  fullLsp: boolean,
  includeBridge: boolean,
  trust: "trusted-always" | "untrusted" = "trusted-always",
  editEngineV2 = false,
  renameMutation = false,
): AgentSession {
  const config = structuredClone(loadConfig({ projectTrusted: true, env: {} }).config);
  config.experimental.fullLsp = fullLsp;
  config.experimental.editEngineV2 = editEngineV2;
  config.lsp.enabled = true;
  config.lsp.mutations.rename = renameMutation;
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

describe("AgentSession LSP tool gate", () => {
  test("requires fullLsp, trusted workspace, and a supplied root bridge for every LSP read tool", () => {
    const lspTools = [
      "lsp.diagnostics",
      "lsp.definition",
      "lsp.symbols",
      "lsp.workspace_symbols",
      "lsp.declaration",
      "lsp.type_definition",
      "lsp.implementation",
      "lsp.references",
      "lsp.hover",
      "lsp.signature_help",
      "lsp.document_highlights",
      "lsp.code_actions",
    ];
    const disabled = makeSession(false, true);
    const missingBridge = makeSession(true, false);
    const enabled = makeSession(true, true);
    const untrusted = makeSession(true, true, "untrusted");

    for (const toolId of lspTools) {
      expect(disabled.registry.has(toolId)).toBe(false);
      expect(missingBridge.registry.has(toolId)).toBe(false);
      expect(enabled.registry.has(toolId)).toBe(true);
      expect(untrusted.registry.has(toolId)).toBe(false);
      expect(enabled.registry.activeIds()).not.toContain(toolId);
    }
  });

  test("requires the edit engine and rename mutation gates for proposal-only rename", () => {
    const disabled = makeSession(false, true, "trusted-always", true, true);
    const missingBridge = makeSession(true, false, "trusted-always", true, true);
    const untrusted = makeSession(true, true, "untrusted", true, true);
    const missingEditEngine = makeSession(true, true, "trusted-always", false, true);
    const missingRenameMutation = makeSession(true, true, "trusted-always", true, false);
    const enabled = makeSession(true, true, "trusted-always", true, true);

    for (const session of [
      disabled,
      missingBridge,
      untrusted,
      missingEditEngine,
      missingRenameMutation,
    ]) {
      expect(session.registry.has("lsp.rename_preview")).toBe(false);
    }
    expect(enabled.registry.has("lsp.rename_preview")).toBe(true);
    expect(enabled.registry.activeIds()).not.toContain("lsp.rename_preview");
  });
});
