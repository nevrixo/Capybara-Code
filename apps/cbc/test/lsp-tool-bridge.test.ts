import { describe, expect, test } from "bun:test";

import type { LspDiagnosticSnapshot } from "@cbc/lsp-domain";

import { createLspDiagnosticsBridge } from "../src/lsp-tool-bridge.ts";

function action(path: unknown) {
  return {
    callId: "lsp-1",
    toolId: "lsp.diagnostics",
    arguments: { path },
    display: "lsp.diagnostics",
  } as const;
}

function snapshot(diagnostics: LspDiagnosticSnapshot["diagnostics"]): LspDiagnosticSnapshot {
  return {
    schemaVersion: "1.0",
    server: "typescript",
    workspaceIdentityDigest: "workspace-identity-must-not-escape",
    path: "src/widget.ts",
    documentRevision: "sha256:revision",
    documentVersion: 4,
    publishedAt: "2026-08-25T00:00:00.000Z",
    diagnostics,
    totalDiagnostics: diagnostics.length,
    truncated: false,
  };
}

describe("LSP diagnostics bridge", () => {
  test("projects bounded evidence without workspace identity data", async () => {
    const diagnostics = Array.from({ length: 80 }, (_, index) => ({
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      severity: 1 as const,
      code: "TS" + String(index),
      source: "tsserver\u001b[31m",
      message: "value is invalid \u001b[31m " + "x".repeat(800),
    }));
    const bridge = createLspDiagnosticsBridge({
      diagnostics: async () => ({ snapshots: [snapshot(diagnostics)], totalServers: 10, truncatedServers: true }),
    });

    const execution = await bridge(action("src/widget.ts"), new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    const data = execution.result.data as {
      readonly totalServers: number;
      readonly returnedServers: number;
      readonly truncatedServers: boolean;
      readonly returnedDiagnostics: number;
      readonly truncatedDiagnostics: boolean;
      readonly servers: readonly { readonly diagnostics: readonly { readonly message: string; readonly source?: string }[] }[];
    };
    expect(data.totalServers).toBe(10);
    expect(data.returnedServers).toBe(1);
    expect(data.truncatedServers).toBe(true);
    expect(data.returnedDiagnostics).toBe(64);
    expect(data.truncatedDiagnostics).toBe(true);
    expect(data.servers[0]?.diagnostics).toHaveLength(64);
    expect(Buffer.byteLength(data.servers[0]?.diagnostics[0]?.message ?? "", "utf8")).toBeLessThanOrEqual(512);
    expect(data.servers[0]?.diagnostics[0]?.message).not.toContain("\u001b");
    expect(data.servers[0]?.diagnostics[0]?.source).not.toContain("\u001b");
    expect(JSON.stringify(data)).not.toContain("workspace-identity-must-not-escape");
    expect(execution.text).toContain("Result is bounded");
  });

  test("rejects traversal paths before the reader is called", async () => {
    let calls = 0;
    const bridge = createLspDiagnosticsBridge({
      diagnostics: async () => {
        calls += 1;
        return { snapshots: [], totalServers: 0, truncatedServers: false };
      },
    });

    const execution = await bridge(action("../private.txt"), new AbortController().signal);
    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(calls).toBe(0);
  });

  test("does not call the reader after cancellation", async () => {
    let calls = 0;
    const bridge = createLspDiagnosticsBridge({
      diagnostics: async () => {
        calls += 1;
        return { snapshots: [], totalServers: 0, truncatedServers: false };
      },
    });
    const controller = new AbortController();
    controller.abort();

    const execution = await bridge(action("src/widget.ts"), controller.signal);
    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });

  test("does not mistake an absent snapshot for a clean file", async () => {
    const bridge = createLspDiagnosticsBridge({
      diagnostics: async () => ({ snapshots: [], totalServers: 0, truncatedServers: false }),
    });

    const execution = await bridge(action("src/widget.ts"), new AbortController().signal);
    expect(execution.result.ok).toBe(true);
    expect(execution.text).toContain("does not prove that the file is clean");
  });
});
