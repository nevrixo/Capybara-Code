import { describe, expect, test } from "bun:test";

import { RepositoryIntelligence } from "@cbc/context-engine";

import {
  LspHost,
  configuredLspServers,
  normalizeLspDocumentSymbols,
} from "../src/lsp-host.ts";

function lspFrame(message: unknown): string {
  const body = JSON.stringify(message);
  return "Content-Length: " + Buffer.byteLength(body, "utf8") + "\r\n\r\n" + body;
}

function messageFromFrame(data: string): Record<string, unknown> {
  const boundary = data.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("missing LSP frame boundary");
  return JSON.parse(data.slice(boundary + 4)) as Record<string, unknown>;
}

describe("normalizeLspDocumentSymbols", () => {
  test("normalizes nested document symbols into repository ranges", () => {
    const symbols = normalizeLspDocumentSymbols("src/widget.ts", [
      {
        name: "Widget",
        kind: 5,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 8, character: 1 },
        },
        selectionRange: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 12 },
        },
        children: [
          {
            name: "render",
            kind: 6,
            range: {
              start: { line: 2, character: 2 },
              end: { line: 6, character: 3 },
            },
          },
        ],
      },
    ]);

    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({
      name: "Widget",
      kind: "class",
      path: "src/widget.ts",
      range: { startLine: 1, endLine: 9, startColumn: 0, endColumn: 1 },
      selectionRange: { startLine: 1, endLine: 1, startColumn: 6, endColumn: 12 },
    });
    expect(symbols[1]).toMatchObject({
      name: "render",
      kind: "method",
      containerName: "Widget",
      range: { startLine: 3, endLine: 7, startColumn: 2, endColumn: 3 },
    });
  });
});

describe("configuredLspServers", () => {
  test("uses only global definitions and preserves custom languages", () => {
    expect(configuredLspServers({})).toEqual([]);
    expect(
      configuredLspServers({
        rust: {
          command: "rust-analyzer",
          extensions: [".rs"],
          languageId: "rust",
          timeoutMs: 9_000,
        },
      }),
    ).toEqual([
      {
        name: "rust",
        command: "rust-analyzer",
        args: [],
        extensions: [".rs"],
        languageId: "rust",
        enabled: true,
        installHint: "install 'rust-analyzer' and make it available on PATH",
        timeoutMs: 9_000,
      },
    ]);
  });
});

describe("LspHost", () => {
  test("indexes TypeScript document symbols through the supervised LSP channel", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let starts = 0;
    let stops = 0;
    const methods: string[] = [];
    const runtime = {
      issueCapability: async (_params: Record<string, unknown>) => ({
        id: "cap",
        sessionId: "session-1",
        actionHash: "hash",
      }),
      startJob: async (params: Record<string, unknown>) => {
        starts += 1;
        protocolChannel = String(params.protocolChannel);
        return { jobId: "job-1", display: "fake LSP" };
      },
      sendInput: async (params: Record<string, unknown>) => {
        const data = params.data;
        if (typeof data !== "string") throw new Error("expected framed LSP input");
        const message = messageFromFrame(data);
        if (typeof message.method === "string") methods.push(message.method);
        if (typeof message.id !== "number") return undefined;

        const result =
          message.method === "textDocument/documentSymbol"
            ? [
                {
                  name: "Widget",
                  kind: 5,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 8, character: 1 },
                  },
                  children: [
                    {
                      name: "render",
                      kind: 6,
                      range: {
                        start: { line: 2, character: 2 },
                        end: { line: 6, character: 3 },
                      },
                    },
                  ],
                },
              ]
            : { capabilities: {} };
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
        });
        return undefined;
      },
      stopJob: async (_jobId: string) => {
        stops += 1;
        return undefined;
      },
      subscribeNotifications: (handler: (method: string, params: unknown) => void) => {
        notification = handler;
        return () => {
          if (notification === handler) notification = undefined;
        };
      },
    };
    const statuses: Array<readonly { name: string; state: string; detail?: string }[]> = [];
    const host = new LspHost({
      runtime: runtime as never,
      servers: {
        typescript: {
          command: "typescript-language-server",
          args: ["--stdio"],
          extensions: [".ts", ".tsx"],
          languageId: "typescript",
          timeoutMs: 1_000,
        },
      },
      sessionId: "session-1",
      workspaceRoot: "/work",
      workspaceTrusted: true,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
      readFile: async () => "export class Widget {}",
      onStatus: (servers) => statuses.push(servers),
    });
    const intelligence = new RepositoryIntelligence();

    await host.indexRepository(
      [{ path: "src/widget.ts", bytes: 120, binary: false, tracked: true }],
      intelligence,
    );

    expect(starts).toBe(1);
    expect(methods).toContain("initialize");
    expect(methods).toContain("initialized");
    expect(methods).toContain("textDocument/didOpen");
    expect(methods).toContain("textDocument/documentSymbol");
    expect(methods).toContain("textDocument/didClose");
    expect(intelligence.symbols("src/widget.ts").map((symbol) => symbol.name)).toEqual([
      "Widget",
      "render",
    ]);
    expect(statuses.at(-1)).toContainEqual({
      name: "typescript",
      state: "ready",
      detail: "2 symbol(s) in 1 file(s)",
    });

    await host.close();
    expect(stops).toBe(1);
  });

  test("turns a supervised rename response into a runtime-bound edit plan", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let starts = 0;
    let stops = 0;
    const methods: string[] = [];
    const documentText = "export const Widget = 1;\n";
    const runtime = {
      issueCapability: async () => ({ id: "cap", sessionId: "session-1", actionHash: "hash" }),
      startJob: async (params: Record<string, unknown>) => {
        starts += 1;
        protocolChannel = String(params.protocolChannel);
        return { jobId: "job-1", display: "fake LSP" };
      },
      sendInput: async (params: Record<string, unknown>) => {
        const data = params.data;
        if (typeof data !== "string") throw new Error("expected framed LSP input");
        const message = messageFromFrame(data);
        if (typeof message.method === "string") methods.push(message.method);
        if (typeof message.id !== "number") return undefined;

        const request = message.params as {
          readonly newName?: unknown;
          readonly textDocument?: { readonly uri?: unknown };
        };
        const uri = typeof request.textDocument?.uri === "string" ? request.textDocument.uri : "";
        const result =
          message.method === "textDocument/rename"
            ? {
                changes: {
                  [uri]: [{
                    range: {
                      start: { line: 0, character: 13 },
                      end: { line: 0, character: 19 },
                    },
                    newText: request.newName,
                  }],
                },
              }
            : { capabilities: {} };
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
        });
        return undefined;
      },
      stopJob: async () => {
        stops += 1;
        return undefined;
      },
      subscribeNotifications: (handler: (method: string, params: unknown) => void) => {
        notification = handler;
        return () => {
          if (notification === handler) notification = undefined;
        };
      },
    };
    const host = new LspHost({
      runtime: runtime as never,
      servers: {
        typescript: {
          command: "typescript-language-server",
          args: ["--stdio"],
          extensions: [".ts"],
          languageId: "typescript",
          timeoutMs: 1_000,
        },
      },
      sessionId: "session-1",
      workspaceRoot: "/work",
      workspaceTrusted: true,
      enabled: true,
      allowRenamePreview: true,
      workspaceIdentityDigest: () => "ws_1",
      readFile: async () => documentText,
      readEditDocument: async (path) =>
        path === "src/widget.ts"
          ? { path, text: documentText, revision: "sha256:widget" }
          : undefined,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    const preview = await host.renamePreview({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "Renamed",
    });

    expect(starts).toBe(1);
    expect(methods).toContain("initialize");
    expect(methods).toContain("textDocument/didOpen");
    expect(methods).toContain("textDocument/rename");
    expect(methods).toContain("textDocument/didClose");
    expect(preview.edit.plan.operations).toEqual([expect.objectContaining({
      kind: "replace_range",
      path: "src/widget.ts",
      baseRevision: "sha256:widget",
      replacement: "Renamed",
      range: {
        start: { line: 1, column: 14 },
        end: { line: 1, column: 20 },
        encoding: "utf16",
      },
    })]);

    await host.close();
    expect(stops).toBe(1);
  });

  test("keeps only diagnostics bound to the latest runtime document revision", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let openedUri = "";
    let revision = "sha256:widget-1";
    const documentText = "const value = 1;\n";
    const runtime = {
      issueCapability: async () => ({ id: "cap", sessionId: "session-1", actionHash: "hash" }),
      startJob: async (params: Record<string, unknown>) => {
        protocolChannel = String(params.protocolChannel);
        return { jobId: "job-1", display: "fake LSP" };
      },
      sendInput: async (params: Record<string, unknown>) => {
        const data = params.data;
        if (typeof data !== "string") throw new Error("expected framed LSP input");
        const message = messageFromFrame(data);
        if (message.method === "textDocument/didOpen") {
          const opened = message.params as {
            readonly textDocument?: { readonly uri?: unknown; readonly version?: unknown };
          };
          const uri = opened.textDocument?.uri;
          const version = opened.textDocument?.version;
          if (typeof uri === "string" && typeof version === "number") {
            openedUri = uri;
            notification?.("lsp.stdio.output", {
              protocolChannel,
              text: lspFrame({
                jsonrpc: "2.0",
                method: "textDocument/publishDiagnostics",
                params: {
                  uri,
                  version,
                  diagnostics: [{
                    range: {
                      start: { line: 0, character: 6 },
                      end: { line: 0, character: 11 },
                    },
                    severity: 1,
                    code: 2322,
                    source: "tsserver",
                    message: "bad\u001b[31m value",
                    data: { mustNotEscape: true },
                  }],
                },
              }),
            });
          }
          return undefined;
        }
        if (typeof message.id !== "number") return undefined;
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({
            jsonrpc: "2.0",
            id: message.id,
            result: message.method === "initialize" ? { capabilities: {} } : [],
          }),
        });
        return undefined;
      },
      stopJob: async () => undefined,
      subscribeNotifications: (handler: (method: string, params: unknown) => void) => {
        notification = handler;
        return () => {
          if (notification === handler) notification = undefined;
        };
      },
    };
    const host = new LspHost({
      runtime: runtime as never,
      servers: {
        typescript: {
          command: "typescript-language-server",
          args: ["--stdio"],
          extensions: [".ts"],
          languageId: "typescript",
          timeoutMs: 1_000,
        },
      },
      sessionId: "session-1",
      workspaceRoot: "/work",
      workspaceTrusted: true,
      enabled: true,
      workspaceIdentityDigest: () => "ws_1",
      readFile: async () => "non-authoritative fallback",
      readEditDocument: async (path) =>
        path === "src/widget.ts"
          ? { path, text: documentText, revision }
          : undefined,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    await host.definition({ path: "src/widget.ts", line: 0, character: 0 });
    const current = await host.diagnostics("src/widget.ts");

    expect(current).toEqual(expect.objectContaining({
      totalServers: 1,
      truncatedServers: false,
      snapshots: [expect.objectContaining({
      server: "typescript",
      workspaceIdentityDigest: "ws_1",
      path: "src/widget.ts",
      documentRevision: "sha256:widget-1",
      documentVersion: 1,
      diagnostics: [{
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        severity: 1,
        code: "2322",
        source: "tsserver",
        message: "bad [31m value",
      }],
      totalDiagnostics: 1,
      truncated: false,
      })],
    }));

    notification?.("lsp.stdio.output", {
      protocolChannel,
      text: lspFrame({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: openedUri,
          version: 999,
          diagnostics: [],
        },
      }),
    });
    expect(await host.diagnostics("src/widget.ts")).toEqual(current);

    revision = "sha256:widget-2";
    expect(await host.diagnostics("src/widget.ts")).toEqual({
      snapshots: [],
      totalServers: 0,
      truncatedServers: false,
    });

    await host.close();
  });

  test("does not start a server while the full LSP rollout gate is disabled", async () => {
    let starts = 0;
    const host = new LspHost({
      servers: {
        typescript: {
          command: "typescript-language-server",
          extensions: [".ts"],
          languageId: "typescript",
        },
      },
      runtime: {
        issueCapability: async () => ({ id: "cap", sessionId: "session-1", actionHash: "hash" }),
        startJob: async () => {
          starts += 1;
          return { jobId: "job-1", display: "fake LSP" };
        },
        sendInput: async () => undefined,
        stopJob: async () => undefined,
        subscribeNotifications: () => () => undefined,
      } as never,
      sessionId: "session-1",
      workspaceRoot: "/work",
      workspaceTrusted: true,
      enabled: false,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    await expect(host.definition({ path: "src/widget.ts", line: 0, character: 0 }))
      .rejects.toThrow("experimental.fullLsp");
    expect(starts).toBe(0);
    expect(host.statuses()).toContainEqual({
      name: "typescript",
      state: "disabled",
      detail: "disabled by experimental.fullLsp",
    });
    await host.close();
  });

  test("never starts a language server for an untrusted workspace", async () => {
    let starts = 0;
    const host = new LspHost({
      servers: {
        python: {
          command: "pyright-langserver",
          args: ["--stdio"],
          extensions: [".py", ".pyi"],
          languageId: "python",
        },
      },
      runtime: {
        issueCapability: async () => ({ id: "cap", sessionId: "session-1", actionHash: "hash" }),
        startJob: async () => {
          starts += 1;
          return { jobId: "job-1", display: "fake LSP" };
        },
        sendInput: async () => undefined,
        stopJob: async () => undefined,
        subscribeNotifications: () => () => undefined,
      } as never,
      sessionId: "session-1",
      workspaceRoot: "/work",
      workspaceTrusted: false,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    await host.indexRepository(
      [{ path: "src/main.py", bytes: 80, binary: false, tracked: true }],
      new RepositoryIntelligence(),
    );

    expect(starts).toBe(0);
    expect(host.statuses().every((server) => server.state === "disabled")).toBe(true);
    await host.close();
  });
});
