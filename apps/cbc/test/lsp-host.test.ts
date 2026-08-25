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
            : message.method === "workspace/symbol"
            ? []
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

    const workspaceSymbols = await host.workspaceSymbols("Widget");
    expect(workspaceSymbols).toEqual([{ server: "typescript", result: [] }]);
    expect(starts).toBe(1);
    expect(methods).toContain("workspace/symbol");
    expect(statuses.at(-1)).toContainEqual({
      name: "typescript",
      state: "ready",
      detail: "workspace symbols ready",
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

  test("preflights capability-advertised rename requests before producing a proposal", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    const methods: string[] = [];
    const documentText = "export const Widget = 1;\n";
    let preparation: unknown = {
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 19 },
      },
      placeholder: "Widget",
    };
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
        if (typeof message.method === "string") methods.push(message.method);
        if (typeof message.id !== "number") return undefined;

        const request = message.params as {
          readonly newName?: unknown;
          readonly textDocument?: { readonly uri?: unknown };
        };
        const uri = typeof request.textDocument?.uri === "string" ? request.textDocument.uri : "";
        const result =
          message.method === "initialize"
            ? { capabilities: { renameProvider: { prepareProvider: true } } }
            : message.method === "textDocument/prepareRename"
              ? preparation
              : message.method === "textDocument/rename"
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
      allowRenamePreview: true,
      maxEditChangedBytes: 7,
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

    expect(preview.edit.paths).toEqual(["src/widget.ts"]);
    expect(methods.indexOf("textDocument/prepareRename"))
      .toBeLessThan(methods.indexOf("textDocument/rename"));

    const renameRequests = methods.filter((method) => method === "textDocument/rename").length;
    preparation = null;
    await expect(host.renamePreview({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "Blocked",
    })).rejects.toThrow("LSP server does not allow rename at this position");
    expect(methods.filter((method) => method === "textDocument/rename")).toHaveLength(renameRequests);

    preparation = {
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 19 },
      },
      placeholder: "Widget",
    };
    await expect(host.renamePreview({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "TooLarge",
    })).rejects.toThrow("LSP edit preview exceeds the configured changed-byte limit");

    await host.close();
  });

  test("keeps only diagnostics bound to the latest runtime document revision", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let openedUri = "";
    let revision = "sha256:widget-1";
    const documentText = "const value = 1;\n";
    const methods: string[] = [];
    let initializeCapabilities: unknown;
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
        if (typeof message.method === "string") methods.push(message.method);
        if (message.method === "initialize") {
          const params = message.params;
          if (typeof params === "object" && params !== null && !Array.isArray(params)) {
            initializeCapabilities = (params as Record<string, unknown>).capabilities;
          }
        }
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
    await host.declaration({ path: "src/widget.ts", line: 0, character: 0 });
    await host.typeDefinition({ path: "src/widget.ts", line: 0, character: 0 });
    await host.implementation({ path: "src/widget.ts", line: 0, character: 0 });
    await host.signatureHelp({ path: "src/widget.ts", line: 0, character: 0 });
    await host.documentHighlights({ path: "src/widget.ts", line: 0, character: 0 });
    await host.documentSymbols("src/widget.ts");
    expect(methods).toEqual(expect.arrayContaining([
      "textDocument/definition",
      "textDocument/declaration",
      "textDocument/typeDefinition",
      "textDocument/implementation",
      "textDocument/signatureHelp",
      "textDocument/documentHighlight",
      "textDocument/documentSymbol",
    ]));
    expect(initializeCapabilities).toMatchObject({
      workspace: {
        diagnostic: {
          refreshSupport: false,
        },
      },
      textDocument: {
        signatureHelp: {
          signatureInformation: {
            parameterInformation: { labelOffsetSupport: true },
          },
        },
        documentHighlight: {},
        diagnostic: {
          dynamicRegistration: false,
          relatedDocumentSupport: false,
        },
      },
    });
    const current = await host.diagnostics("src/widget.ts");
    expect(methods).not.toContain("textDocument/diagnostic");
    expect(methods).not.toContain("workspace/diagnostic");

    expect(current).toEqual(expect.objectContaining({
      totalServers: 1,
      truncatedServers: false,
      snapshots: [expect.objectContaining({
      server: "typescript",
      workspaceIdentityDigest: "ws_1",
      path: "src/widget.ts",
      documentRevision: "sha256:widget-1",
      documentVersion: expect.any(Number),
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

  test("pulls capability-advertised diagnostics bound to the opened revision", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let openedUri = "";
    let requestedUri = "";
    let openedVersion = 0;
    let reportKind: "full" | "unchanged" = "full";
    let initializeCapabilities: unknown;
    const methods: string[] = [];
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
        if (typeof message.method === "string") methods.push(message.method);
        if (message.method === "initialize") {
          const params = message.params;
          if (typeof params === "object" && params !== null && !Array.isArray(params)) {
            initializeCapabilities = (params as Record<string, unknown>).capabilities;
          }
        }
        if (message.method === "textDocument/didOpen") {
          const opened = message.params as {
            readonly textDocument?: { readonly uri?: unknown; readonly version?: unknown };
          };
          const uri = opened.textDocument?.uri;
          const version = opened.textDocument?.version;
          if (typeof uri === "string") openedUri = uri;
          if (typeof version === "number") openedVersion = version;
          return undefined;
        }
        if (typeof message.id !== "number") return undefined;
        let result: unknown = [];
        if (message.method === "initialize") {
          result = { capabilities: { diagnosticProvider: {} } };
        } else if (message.method === "textDocument/diagnostic") {
          const params = message.params as {
            readonly textDocument?: { readonly uri?: unknown };
          };
          const uri = params.textDocument?.uri;
          if (typeof uri === "string") requestedUri = uri;
          result = reportKind === "full"
            ? {
                kind: "full",
                resultId: "must-not-escape",
                items: [{
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 11 },
                  },
                  severity: 2,
                  source: "pull",
                  message: "pull\u001b[31m value",
                  data: { mustNotEscape: true },
                }],
              }
            : { kind: "unchanged", resultId: "must-not-escape" };
        }
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
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
      workspaceIdentityDigest: () => "ws_pull",
      readEditDocument: async (path) =>
        path === "src/widget.ts"
          ? { path, text: "const value = 1;\n", revision: "sha256:pull-1" }
          : undefined,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    const full = await host.diagnostics("src/widget.ts");

    expect(methods).toEqual(expect.arrayContaining([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/diagnostic",
      "textDocument/didClose",
    ]));
    expect(openedUri).not.toBe("");
    expect(requestedUri).toBe(openedUri);
    expect(openedVersion).toBeGreaterThan(0);
    expect(initializeCapabilities).toMatchObject({
      textDocument: {
        diagnostic: {
          dynamicRegistration: false,
          relatedDocumentSupport: false,
        },
      },
    });
    expect(full).toEqual(expect.objectContaining({
      totalServers: 1,
      truncatedServers: false,
      snapshots: [expect.objectContaining({
        server: "typescript",
        workspaceIdentityDigest: "ws_pull",
        path: "src/widget.ts",
        documentRevision: "sha256:pull-1",
        documentVersion: openedVersion,
        diagnostics: [{
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
          severity: 2,
          source: "pull",
          message: "pull [31m value",
        }],
        totalDiagnostics: 1,
        truncated: false,
      })],
    }));

    reportKind = "unchanged";
    expect(await host.diagnostics("src/widget.ts")).toEqual({
      snapshots: [],
      totalServers: 0,
      truncatedServers: false,
    });
    expect(methods.filter((method) => method === "textDocument/diagnostic")).toHaveLength(2);

    await host.close();
  });

  test("pulls bounded workspace diagnostics only when the server advertises support", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let openedUri = "";
    let openedVersion = 0;
    let initializeCapabilities: unknown;
    let workspaceParams: unknown;
    const methods: string[] = [];
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
        if (typeof message.method === "string") methods.push(message.method);
        if (message.method === "initialize") {
          const params = message.params;
          if (typeof params === "object" && params !== null && !Array.isArray(params)) {
            initializeCapabilities = (params as Record<string, unknown>).capabilities;
          }
        }
        if (message.method === "textDocument/didOpen") {
          const opened = message.params as {
            readonly textDocument?: { readonly uri?: unknown; readonly version?: unknown };
          };
          const uri = opened.textDocument?.uri;
          const version = opened.textDocument?.version;
          if (typeof uri === "string") openedUri = uri;
          if (typeof version === "number") openedVersion = version;
          return undefined;
        }
        if (typeof message.id !== "number") return undefined;
        let result: unknown = [];
        if (message.method === "initialize") {
          result = { capabilities: { diagnosticProvider: { workspaceDiagnostics: true } } };
        } else if (message.method === "textDocument/diagnostic") {
          result = { kind: "full", items: [] };
        } else if (message.method === "workspace/diagnostic") {
          workspaceParams = message.params;
          result = {
            items: [{
              uri: openedUri,
              version: openedVersion,
              kind: "full",
              resultId: "server-private-result-id",
              relatedDocuments: { mustNotEscape: true },
              items: [{
                range: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 11 },
                },
                severity: 1,
                source: "workspace",
                message: "workspace diagnostic",
                data: { mustNotEscape: true },
              }],
            }],
          };
        }
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
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
      workspaceIdentityDigest: () => "ws_workspace",
      readEditDocument: async (path) =>
        path === "src/widget.ts"
          ? { path, text: "const value = 1;\n", revision: "sha256:workspace-1" }
          : undefined,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    const lookup = await host.diagnostics("src/widget.ts");

    expect(methods).toEqual(expect.arrayContaining([
      "initialize",
      "textDocument/diagnostic",
      "workspace/diagnostic",
    ]));
    expect(methods.filter((method) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(methods.filter((method) => method === "workspace/diagnostic")).toHaveLength(1);
    expect(workspaceParams).toEqual({ previousResultIds: [] });
    expect(initializeCapabilities).toMatchObject({
      workspace: {
        diagnostic: {
          refreshSupport: false,
        },
      },
      textDocument: {
        diagnostic: {
          dynamicRegistration: false,
          relatedDocumentSupport: false,
        },
      },
    });
    expect(lookup).toEqual(expect.objectContaining({
      totalServers: 1,
      truncatedServers: false,
      snapshots: [expect.objectContaining({
        server: "typescript",
        workspaceIdentityDigest: "ws_workspace",
        path: "src/widget.ts",
        documentRevision: "sha256:workspace-1",
        documentVersion: openedVersion,
        diagnostics: [expect.objectContaining({
          severity: 1,
          source: "workspace",
          message: "workspace diagnostic",
        })],
      })],
    }));
    expect(JSON.stringify(lookup)).not.toContain("server-private-result-id");

    await host.close();
  });

  test("requests code action metadata at a zero-width cursor only after capability negotiation", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let codeActionParams: Record<string, unknown> | undefined;
    const methods: string[] = [];
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
        if (typeof message.method === "string") methods.push(message.method);
        if (typeof message.id !== "number") return undefined;
        if (
          message.method === "textDocument/codeAction" &&
          typeof message.params === "object" &&
          message.params !== null &&
          !Array.isArray(message.params)
        ) {
          codeActionParams = message.params as Record<string, unknown>;
        }
        const result =
          message.method === "initialize"
            ? { capabilities: { codeActionProvider: { resolveProvider: true } } }
            : message.method === "textDocument/codeAction"
              ? [
                  {
                    title: "Fix Widget",
                    kind: "quickfix",
                    edit: { changes: { "file:///private-edit.ts": [] } },
                    command: { title: "private command", command: "private.command" },
                    data: { mustNotEscape: true },
                  },
                ]
              : null;
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
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
      readFile: async () => "export const Widget = 1;\n",
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    const query = await host.codeActions({ path: "src/widget.ts", line: 0, character: 13 });

    expect(query).toEqual({
      server: "typescript",
      result: [
        expect.objectContaining({
          title: "Fix Widget",
          kind: "quickfix",
        }),
      ],
    });
    expect(methods.filter((method) => method === "textDocument/codeAction")).toHaveLength(1);
    expect(codeActionParams).toMatchObject({
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 13 },
      },
      context: { diagnostics: [] },
    });
    const textDocument = codeActionParams?.textDocument as Record<string, unknown> | undefined;
    expect(String(textDocument?.uri)).toMatch(/src\/widget\.ts$/);

    await host.close();
  });

  test("converts only command-free code actions into runtime-bound edit proposals", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let openedUri: string | undefined;
    const methods: string[] = [];
    const documentText = "export const Widget = 1;\n";
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
        if (typeof message.method === "string") methods.push(message.method);
        if (message.method === "textDocument/didOpen") {
          const rawParams = message.params as { textDocument?: { uri?: unknown } } | undefined;
          if (typeof rawParams?.textDocument?.uri === "string") openedUri = rawParams.textDocument.uri;
        }
        if (typeof message.id !== "number") return undefined;
        let result: unknown =
          message.method === "initialize"
            ? { capabilities: { codeActionProvider: true } }
            : null;
        if (message.method === "textDocument/codeAction") {
          if (openedUri === undefined) throw new Error("missing opened document URI");
          result = [
            {
              title: "Run command",
              command: { title: "private", command: "private.command" },
              data: { mustNotEscape: true },
            },
            {
              title: "Fix Widget",
              edit: {
                changes: {
                  [openedUri]: [{
                    range: {
                      start: { line: 0, character: 13 },
                      end: { line: 0, character: 19 },
                    },
                    newText: "Renamed",
                  }],
                },
              },
              data: { mustNotEscape: true },
            },
          ];
        }
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
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
      allowCodeActionPreview: true,
      workspaceIdentityDigest: () => "ws_code_action",
      readEditDocument: async (path) =>
        path === "src/widget.ts"
          ? { path, text: documentText, revision: "sha256:code-action-1" }
          : undefined,
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    const preview = await host.codeActionPreview({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 1,
    });

    expect(preview.edit.paths).toEqual(["src/widget.ts"]);
    expect(preview.edit.plan.operations).toMatchObject([{
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: "Renamed",
    }]);
    expect(methods).toContain("textDocument/codeAction");
    expect(methods).not.toContain("codeAction/resolve");
    expect(methods).not.toContain("workspace/executeCommand");

    await expect(host.codeActionPreview({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 0,
    })).rejects.toThrow("commands are not eligible");

    await host.close();
  });

  test("converts formatter edits into current revision-bound proposals without writing files", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let openedUri: string | undefined;
    let formattingParams: Record<string, unknown> | undefined;
    let rangeFormattingParams: Record<string, unknown> | undefined;
    let formatCalls = 0;
    let rangeFormatCalls = 0;
    let makeStale = false;
    let armedReads = 0;
    const methods: string[] = [];
    const documentText = "export const Widget=1;\n";
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
        if (typeof message.method === "string") methods.push(message.method);
        if (message.method === "textDocument/didOpen") {
          const rawParams = message.params as { textDocument?: { uri?: unknown } } | undefined;
          if (typeof rawParams?.textDocument?.uri === "string") openedUri = rawParams.textDocument.uri;
        }
        if (typeof message.id !== "number") return undefined;
        let result: unknown =
          message.method === "initialize"
            ? {
                capabilities: {
                  documentFormattingProvider: true,
                  documentRangeFormattingProvider: true,
                },
              }
            : null;
        if (message.method === "textDocument/formatting") {
          if (openedUri === undefined) throw new Error("missing opened document URI");
          formattingParams = message.params as Record<string, unknown>;
          formatCalls += 1;
          result = formatCalls === 2
            ? []
            : [{
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 22 },
                },
                newText: "export const Widget = 1;",
              }];
        }
        if (message.method === "textDocument/rangeFormatting") {
          if (openedUri === undefined) throw new Error("missing opened document URI");
          rangeFormattingParams = message.params as Record<string, unknown>;
          rangeFormatCalls += 1;
          result = rangeFormatCalls === 2
            ? [{
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 22 },
                },
                newText: "export const Widget = 1;",
              }]
            : [{
                range: {
                  start: { line: 0, character: 19 },
                  end: { line: 0, character: 21 },
                },
                newText: " = 1",
              }];
        }
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
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
      allowFormattingPreview: true,
      workspaceIdentityDigest: () => "ws_format",
      readEditDocument: async (path) => {
        const revision = makeStale && ++armedReads > 1
          ? "sha256:format-2"
          : "sha256:format-1";
        return path === "src/widget.ts"
          ? { path, text: documentText, revision }
          : undefined;
      },
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
    });

    const preview = await host.formatPreview({ path: "src/widget.ts" });

    expect(preview.edit?.paths).toEqual(["src/widget.ts"]);
    expect(preview.edit?.plan.operations).toMatchObject([{
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: "export const Widget = 1;",
    }]);
    expect(formattingParams).toMatchObject({
      options: { tabSize: 2, insertSpaces: true },
    });
    const textDocument = formattingParams?.textDocument as Record<string, unknown> | undefined;
    expect(String(textDocument?.uri)).toMatch(/src\/widget\.ts$/);
    expect(methods).toContain("textDocument/formatting");
    expect(methods).not.toContain("workspace/executeCommand");

    const noChange = await host.formatPreview({ path: "src/widget.ts" });
    expect(noChange.edit).toBeUndefined();

    const rangePreview = await host.rangeFormatPreview({
      path: "src/widget.ts",
      startLine: 0,
      startCharacter: 19,
      endLine: 0,
      endCharacter: 21,
    });
    expect(rangePreview.edit?.paths).toEqual(["src/widget.ts"]);
    expect(rangePreview.edit?.plan.operations).toMatchObject([{
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: " = 1",
    }]);
    expect(rangeFormattingParams).toMatchObject({
      range: {
        start: { line: 0, character: 19 },
        end: { line: 0, character: 21 },
      },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(methods).toContain("textDocument/rangeFormatting");

    await expect(host.rangeFormatPreview({
      path: "src/widget.ts",
      startLine: 0,
      startCharacter: 19,
      endLine: 0,
      endCharacter: 21,
    })).rejects.toThrow("outside the requested range");

    makeStale = true;
    await expect(host.formatPreview({ path: "src/widget.ts" })).rejects.toThrow(
      "document changed before plan construction",
    );

    await host.close();
  });

  test("prepares capability-advertised call hierarchy requests before returning one bounded direction", async () => {
    let notification:
      | ((method: string, params: unknown) => void)
      | undefined;
    let protocolChannel = "";
    let initializeCapabilities: unknown;
    let prepareParams: Record<string, unknown> | undefined;
    let incomingParams: Record<string, unknown> | undefined;
    let outgoingParams: Record<string, unknown> | undefined;
    let returnEmptyPreparation = false;
    let overflowIncoming = false;
    const methods: string[] = [];
    const preparedItem = {
      name: "target",
      kind: 12,
      detail: "void target()",
      uri: "file:///work/src/target.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 1 },
      },
      selectionRange: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 11 },
      },
      data: { opaque: "server-owned" },
    };
    const incomingCall = {
      from: {
        ...preparedItem,
        name: "caller",
        uri: "file:///work/src/caller.ts",
      },
      fromRanges: [{
        start: { line: 4, character: 2 },
        end: { line: 4, character: 8 },
      }],
    };
    const outgoingCall = {
      to: {
        ...preparedItem,
        name: "callee",
        uri: "file:///work/src/callee.ts",
      },
      fromRanges: [{
        start: { line: 1, character: 2 },
        end: { line: 1, character: 8 },
      }],
    };
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
        if (typeof message.method === "string") methods.push(message.method);
        if (message.method === "initialize") {
          const rawParams = message.params;
          if (typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)) {
            initializeCapabilities = (rawParams as Record<string, unknown>).capabilities;
          }
        }
        if (typeof message.id !== "number") return undefined;

        let result: unknown = null;
        if (message.method === "initialize") {
          result = { capabilities: { callHierarchyProvider: true } };
        } else if (message.method === "textDocument/prepareCallHierarchy") {
          prepareParams = message.params as Record<string, unknown>;
          result = returnEmptyPreparation ? [] : [preparedItem];
        } else if (message.method === "callHierarchy/incomingCalls") {
          incomingParams = message.params as Record<string, unknown>;
          result = overflowIncoming
            ? Array.from({ length: 257 }, () => incomingCall)
            : [incomingCall];
        } else if (message.method === "callHierarchy/outgoingCalls") {
          outgoingParams = message.params as Record<string, unknown>;
          result = [outgoingCall];
        }
        notification?.("lsp.stdio.output", {
          protocolChannel,
          text: lspFrame({ jsonrpc: "2.0", id: message.id, result }),
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
      isBuildMode: () => true,
      resolveExecutable: () => "fake-lsp",
      readFile: async () => "export function target() {}\n",
    });

    const incoming = await host.callHierarchy({
      path: "src/target.ts",
      line: 0,
      character: 7,
      direction: "incoming",
    });
    expect(incoming).toMatchObject({
      server: "typescript",
      direction: "incoming",
      root: preparedItem,
      result: [incomingCall],
    });
    expect(prepareParams).toMatchObject({
      position: { line: 0, character: 7 },
    });
    const preparedTextDocument = prepareParams?.textDocument as Record<string, unknown> | undefined;
    expect(String(preparedTextDocument?.uri)).toMatch(/src\/target\.ts$/);
    expect(incomingParams).toEqual({ item: preparedItem });
    expect(methods).toEqual(expect.arrayContaining([
      "textDocument/didOpen",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "textDocument/didClose",
    ]));
    expect(initializeCapabilities).toMatchObject({
      textDocument: { callHierarchy: { dynamicRegistration: false } },
    });

    const outgoing = await host.callHierarchy({
      path: "src/target.ts",
      line: 0,
      character: 7,
      direction: "outgoing",
    });
    expect(outgoing).toMatchObject({
      direction: "outgoing",
      root: preparedItem,
      result: [outgoingCall],
    });
    expect(outgoingParams).toEqual({ item: preparedItem });

    const incomingRequests = methods.filter((method) => method === "callHierarchy/incomingCalls").length;
    returnEmptyPreparation = true;
    const empty = await host.callHierarchy({
      path: "src/target.ts",
      line: 0,
      character: 7,
      direction: "incoming",
    });
    expect(empty.root).toBeUndefined();
    expect(empty.result).toEqual([]);
    expect(methods.filter((method) => method === "callHierarchy/incomingCalls")).toHaveLength(
      incomingRequests,
    );

    returnEmptyPreparation = false;
    overflowIncoming = true;
    await expect(host.callHierarchy({
      path: "src/target.ts",
      line: 0,
      character: 7,
      direction: "incoming",
    })).rejects.toThrow("too many call hierarchy calls");

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
