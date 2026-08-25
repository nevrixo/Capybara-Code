import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { LspQueryResult } from "../src/lsp-host.ts";
import {
  createLspWorkspaceSymbolsBridge,
  type LspWorkspaceSymbolsReader,
} from "../src/lsp-tool-bridge.ts";

const workspaceRoot = process.platform === "win32"
  ? "C:\\lsp-workspace-symbol-bridge"
  : "/lsp-workspace-symbol-bridge";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "workspace-symbols-1",
    toolId: "lsp.workspace_symbols",
    arguments: argumentsValue,
    display: "lsp.workspace_symbols",
  } as const;
}

function queryResult(server: string, result: unknown): LspQueryResult {
  return { server, result };
}

function range(line: number) {
  return {
    start: { line, character: 0 },
    end: { line, character: 8 },
  };
}

function symbols(prefix: string, path: string, length: number) {
  return Array.from({ length }, (_, index) => ({
    name: prefix + String(index) + "\u001b[31m",
    kind: 12,
    location: {
      uri: workspaceUri(path),
      range: range(index),
    },
    containerName: "Workspace",
    data: { mustNotEscape: true },
  }));
}

function reader(
  workspaceSymbols: (query: string) => Promise<readonly LspQueryResult[]>,
): LspWorkspaceSymbolsReader {
  return { workspaceSymbols };
}

describe("LSP workspace symbols bridge", () => {
  test("normalizes per-server results and applies a global model-context cap", async () => {
    let received: string | undefined;
    const bridge = createLspWorkspaceSymbolsBridge(
      reader(async (query) => {
        received = query;
        return [
          queryResult("typescript", symbols("Type", "src/widget.ts", 20)),
          queryResult("rust", symbols("Rust", "crates/widget.rs", 20)),
        ];
      }),
      { workspaceRoot },
    );

    const execution = await bridge(
      action({ query: " Widget " }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toBe("Widget");
    const data = execution.result.data as {
      readonly kind: string;
      readonly query: string;
      readonly totalServers: number;
      readonly returnedServers: number;
      readonly totalSymbols: number;
      readonly returnedSymbols: number;
      readonly symbols: readonly {
        readonly server: string;
        readonly name: string;
        readonly path: string;
      }[];
      readonly truncated: boolean;
    };
    expect(data.kind).toBe("workspace_symbols");
    expect(data.query).toBe("Widget");
    expect(data.totalServers).toBe(2);
    expect(data.returnedServers).toBe(2);
    expect(data.totalSymbols).toBe(40);
    expect(data.returnedSymbols).toBe(32);
    expect(data.symbols).toHaveLength(32);
    expect(data.symbols[0]).toMatchObject({
      server: "typescript",
      name: "Type0 [31m",
      path: "src/widget.ts",
    });
    expect(data.truncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("mustNotEscape");
    expect(JSON.stringify(data)).not.toContain(workspaceRoot);
    expect(execution.text).toContain("untrusted server output");
    expect(execution.text).toContain("possibly stale language-server claims");
  });

  test("keeps valid server evidence when another server claims an external location", async () => {
    const externalUri = pathToFileURL(join(workspaceRoot, "..", "secret.ts")).href;
    const bridge = createLspWorkspaceSymbolsBridge(
      reader(async () => [
        queryResult("typescript", symbols("Type", "src/widget.ts", 1)),
        queryResult("untrusted", [{
          name: "Secret",
          kind: 12,
          location: { uri: externalUri, range: range(0) },
        }]),
      ]),
      { workspaceRoot },
    );

    const execution = await bridge(action({ query: "Widget" }), new AbortController().signal);

    expect(execution.result.ok).toBe(true);
    const data = execution.result.data as {
      readonly totalServers: number;
      readonly returnedServers: number;
      readonly truncatedServers: boolean;
      readonly returnedSymbols: number;
      readonly symbols: readonly { readonly path: string }[];
      readonly truncated: boolean;
    };
    expect(data.totalServers).toBe(2);
    expect(data.returnedServers).toBe(1);
    expect(data.truncatedServers).toBe(true);
    expect(data.returnedSymbols).toBe(1);
    expect(data.symbols).toEqual([
      expect.objectContaining({ path: "src/widget.ts" }),
    ]);
    expect(data.truncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("secret.ts");
  });

  test("rejects unsafe query input and honors cancellation before a reader call", async () => {
    let calls = 0;
    const bridge = createLspWorkspaceSymbolsBridge(
      reader(async () => {
        calls += 1;
        return [queryResult("typescript", [])];
      }),
      { workspaceRoot },
    );

    const invalid = await bridge(
      action({ query: "Widget\u202e" }),
      new AbortController().signal,
    );
    expect(invalid.result.ok).toBe(false);
    expect(invalid.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(calls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(action({ query: "Widget" }), controller.signal);
    expect(cancelled.result.ok).toBe(false);
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });
});
