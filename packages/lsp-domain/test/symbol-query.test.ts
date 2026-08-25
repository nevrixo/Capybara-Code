import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LspSymbolQueryDomainError,
  normalizeLspDocumentSymbolQuery,
} from "../src/index.ts";

const workspaceRoot = process.platform === "win32" ? "C:\\lsp-symbol-workspace" : "/lsp-symbol-workspace";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function options(overrides: Partial<Parameters<typeof normalizeLspDocumentSymbolQuery>[1]> = {}) {
  return {
    workspaceRoot,
    server: "typescript",
    path: "src/widget.ts",
    ...overrides,
  };
}

function range(line: number) {
  return {
    start: { line, character: 0 },
    end: { line, character: 8 },
  };
}

function expectQueryError(
  callback: () => unknown,
  code: LspSymbolQueryDomainError["code"],
): void {
  try {
    callback();
    throw new Error("expected document symbol normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LspSymbolQueryDomainError);
    expect((error as LspSymbolQueryDomainError).code).toBe(code);
  }
}

describe("normalizeLspDocumentSymbolQuery", () => {
  test("flattens nested document symbols into bounded display-safe evidence", () => {
    const snapshot = normalizeLspDocumentSymbolQuery(
      [{
        name: "Widget",
        kind: 5,
        range: range(0),
        selectionRange: range(0),
        data: { mustNotEscape: true },
        children: [{
          name: "render\u001b[31m",
          kind: 6,
          range: range(2),
          selectionRange: range(2),
          data: { mustNotEscape: true },
        }],
      }],
      options(),
    );

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "symbols",
      server: "typescript",
      path: "src/widget.ts",
      symbols: [
        {
          name: "Widget",
          kind: "class",
          range: range(0),
          selectionRange: range(0),
        },
        {
          name: "render [31m",
          kind: "method",
          range: range(2),
          selectionRange: range(2),
          containerName: "Widget",
        },
      ],
      totalSymbols: 2,
      truncated: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.symbols)).toBe(true);
    expect(Object.isFrozen(snapshot.symbols[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("mustNotEscape");
  });

  test("accepts same-document SymbolInformation output and bounds results", () => {
    const snapshot = normalizeLspDocumentSymbolQuery(
      Array.from({ length: 2 }, (_, index) => ({
        name: "item" + String(index),
        kind: 12,
        location: { uri: workspaceUri("src/widget.ts"), range: range(index) },
        containerName: "Widget",
      })),
      options({ maxSymbols: 1 }),
    );

    expect(snapshot).toMatchObject({
      symbols: [{
        name: "item0",
        kind: "function",
        range: range(0),
        containerName: "Widget",
      }],
      totalSymbols: 2,
      truncated: true,
    });
  });

  test("rejects external locations, malformed ranges, and unbounded input", () => {
    expectQueryError(
      () => normalizeLspDocumentSymbolQuery(
        [{ name: "Secret", kind: 12, location: { uri: workspaceUri("../secret.ts"), range: range(0) } }],
        options(),
      ),
      "LSP_SYMBOL_QUERY_SCOPE_VIOLATION",
    );
    expectQueryError(
      () => normalizeLspDocumentSymbolQuery(
        [{ name: "bad", kind: 12, range: { start: { line: 2, character: 1 }, end: { line: 1, character: 1 } } }],
        options(),
      ),
      "LSP_SYMBOL_QUERY_INVALID",
    );
    expectQueryError(
      () => normalizeLspDocumentSymbolQuery(
        Array.from({ length: 4_097 }, () => ({ name: "item", kind: 12, range: range(0) })),
        options(),
      ),
      "LSP_SYMBOL_QUERY_LIMIT",
    );
    expectQueryError(
      () => normalizeLspDocumentSymbolQuery([], options({ path: "src/\u202ewidget.ts" })),
      "LSP_SYMBOL_QUERY_SCOPE_VIOLATION",
    );
  });
});
