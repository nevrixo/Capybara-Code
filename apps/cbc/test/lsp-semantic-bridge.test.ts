import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  LspQueryResult,
  LspReferencesRequest,
  LspTextDocumentPosition,
} from "../src/lsp-host.ts";
import {
  createLspSemanticBridge,
  type LspSemanticReader,
} from "../src/lsp-tool-bridge.ts";

const workspaceRoot = process.platform === "win32" ? "C:\\lsp-semantic-bridge" : "/lsp-semantic-bridge";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function action(
  toolId: "lsp.definition" | "lsp.references" | "lsp.hover",
  argumentsValue: Record<string, unknown>,
) {
  return {
    callId: "semantic-1",
    toolId,
    arguments: argumentsValue,
    display: toolId,
  } as const;
}

function queryResult(result: unknown): LspQueryResult {
  return { server: "typescript", result };
}

function reader(overrides: Partial<LspSemanticReader> = {}): LspSemanticReader {
  return {
    definition: async (_input: LspTextDocumentPosition) => queryResult(null),
    references: async (_input: LspReferencesRequest) => queryResult([]),
    hover: async (_input: LspTextDocumentPosition) => queryResult(null),
    ...overrides,
  };
}

function location(path: string, line: number) {
  return {
    uri: workspaceUri(path),
    range: {
      start: { line, character: 0 },
      end: { line, character: 8 },
    },
    data: { mustNotEscape: true },
  };
}

describe("LSP semantic bridge", () => {
  test("projects bounded definition locations without raw server data", async () => {
    let received: LspTextDocumentPosition | undefined;
    const bridge = createLspSemanticBridge(
      reader({
        definition: async (input) => {
          received = input;
          return queryResult(
            Array.from({ length: 40 }, (_, index) => location("src/definition-" + String(index) + ".ts", index)),
          );
        },
      }),
      { workspaceRoot },
    );

    const execution = await bridge(
      action("lsp.definition", { path: "src/query.ts", line: 1, character: 4 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual({ path: "src/query.ts", line: 1, character: 4 });
    const data = execution.result.data as {
      readonly kind: string;
      readonly totalLocations: number;
      readonly returnedLocations: number;
      readonly locations: readonly { readonly path: string }[];
      readonly truncated: boolean;
    };
    expect(data.kind).toBe("definition");
    expect(data.totalLocations).toBe(40);
    expect(data.returnedLocations).toBe(32);
    expect(data.locations).toHaveLength(32);
    expect(data.locations[0]?.path).toBe("src/definition-0.ts");
    expect(data.truncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("mustNotEscape");
    expect(JSON.stringify(data)).not.toContain(workspaceRoot);
    expect(execution.text).toContain("possibly stale language-server claims");
  });

  test("passes the references declaration policy but rejects invalid query input before a read", async () => {
    let references: LspReferencesRequest | undefined;
    let definitionCalls = 0;
    const bridge = createLspSemanticBridge(
      reader({
        definition: async () => {
          definitionCalls += 1;
          return queryResult([]);
        },
        references: async (input) => {
          references = input;
          return queryResult([]);
        },
      }),
      { workspaceRoot },
    );

    const referencesExecution = await bridge(
      action("lsp.references", {
        path: "src/query.ts",
        line: 0,
        character: 0,
        includeDeclaration: false,
      }),
      new AbortController().signal,
    );
    expect(referencesExecution.result.ok).toBe(true);
    expect(references).toEqual({
      path: "src/query.ts",
      line: 0,
      character: 0,
      includeDeclaration: false,
    });
    expect(referencesExecution.text).toContain("does not prove");

    const invalid = await bridge(
      action("lsp.definition", { path: "../private.ts", line: 0, character: 0 }),
      new AbortController().signal,
    );
    expect(invalid.result.ok).toBe(false);
    expect(invalid.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(definitionCalls).toBe(0);
  });

  test("does not start a semantic query after cancellation", async () => {
    let calls = 0;
    const bridge = createLspSemanticBridge(
      reader({
        hover: async () => {
          calls += 1;
          return queryResult(null);
        },
      }),
      { workspaceRoot },
    );
    const controller = new AbortController();
    controller.abort();

    const execution = await bridge(
      action("lsp.hover", { path: "src/query.ts", line: 0, character: 0 }),
      controller.signal,
    );

    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });

  test("flattens hover text and hides server metadata", async () => {
    const bridge = createLspSemanticBridge(
      reader({
        hover: async () =>
          queryResult({
            contents: {
              kind: "markdown",
              value: "Widget docs\u001b[31m text",
            },
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 6 },
            },
            data: { mustNotEscape: true },
          }),
      }),
      { workspaceRoot },
    );

    const execution = await bridge(
      action("lsp.hover", { path: "src/query.ts", line: 0, character: 0 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    const data = execution.result.data as {
      readonly kind: string;
      readonly found: boolean;
      readonly contents?: string;
    };
    expect(data).toMatchObject({
      kind: "hover",
      found: true,
      contents: "Widget docs [31m text",
    });
    expect(JSON.stringify(data)).not.toContain("mustNotEscape");
    expect(execution.text).toContain("untrusted server output");
  });

  test("does not leak an external URI or server error detail", async () => {
    const externalUri = pathToFileURL(join(workspaceRoot, "..", "private.ts")).href;
    const bridge = createLspSemanticBridge(
      reader({
        definition: async () =>
          queryResult({
            uri: externalUri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          }),
      }),
      { workspaceRoot },
    );

    const execution = await bridge(
      action("lsp.definition", { path: "src/query.ts", line: 0, character: 0 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("NOT_INITIALIZED");
    expect(execution.result.error?.message).not.toContain("private.ts");
  });
});
