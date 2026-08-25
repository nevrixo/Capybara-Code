import { describe, expect, test } from "bun:test";

import type { LspQueryResult } from "../src/lsp-host.ts";
import {
  createLspDocumentSymbolsBridge,
  type LspDocumentSymbolsReader,
} from "../src/lsp-tool-bridge.ts";

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "symbols-1",
    toolId: "lsp.symbols",
    arguments: argumentsValue,
    display: "lsp.symbols",
  } as const;
}

function queryResult(result: unknown): LspQueryResult {
  return { server: "typescript", result };
}

function range(line: number) {
  return {
    start: { line, character: 0 },
    end: { line, character: 8 },
  };
}

function reader(
  documentSymbols: (path: string) => Promise<LspQueryResult>,
): LspDocumentSymbolsReader {
  return { documentSymbols };
}

describe("LSP document symbols bridge", () => {
  test("projects bounded document-local symbols without server metadata", async () => {
    let received: string | undefined;
    const bridge = createLspDocumentSymbolsBridge(
      reader(async (path) => {
        received = path;
        return queryResult(
          Array.from({ length: 40 }, (_, index) => ({
            name: "Symbol" + String(index) + "\u001b[31m",
            kind: 12,
            range: range(index),
            selectionRange: range(index),
            data: { mustNotEscape: true },
          })),
        );
      }),
      { workspaceRoot: process.platform === "win32" ? "C:\\lsp-symbol-bridge" : "/lsp-symbol-bridge" },
    );

    const execution = await bridge(
      action({ path: "src/widget.ts" }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toBe("src/widget.ts");
    const data = execution.result.data as {
      readonly kind: string;
      readonly path: string;
      readonly totalSymbols: number;
      readonly returnedSymbols: number;
      readonly symbols: readonly { readonly name: string }[];
      readonly truncated: boolean;
    };
    expect(data.kind).toBe("symbols");
    expect(data.path).toBe("src/widget.ts");
    expect(data.totalSymbols).toBe(40);
    expect(data.returnedSymbols).toBe(32);
    expect(data.symbols[0]?.name).toBe("Symbol0 [31m");
    expect(data.truncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("mustNotEscape");
    expect(execution.text).toContain("possibly stale language-server claims");
  });

  test("rejects invalid paths before a reader call and honors cancellation", async () => {
    let calls = 0;
    const bridge = createLspDocumentSymbolsBridge(
      reader(async () => {
        calls += 1;
        return queryResult([]);
      }),
      { workspaceRoot: process.platform === "win32" ? "C:\\lsp-symbol-bridge" : "/lsp-symbol-bridge" },
    );

    const invalid = await bridge(
      action({ path: "../private.ts" }),
      new AbortController().signal,
    );
    expect(invalid.result.ok).toBe(false);
    expect(invalid.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(calls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(action({ path: "src/widget.ts" }), controller.signal);
    expect(cancelled.result.ok).toBe(false);
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });
});
