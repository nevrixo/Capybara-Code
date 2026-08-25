import { describe, expect, test } from "bun:test";

import type {
  LspQueryResult,
  LspTextDocumentPosition,
} from "../src/lsp-host.ts";
import {
  createLspCodeActionsBridge,
  type LspCodeActionsReader,
} from "../src/lsp-tool-bridge.ts";

const workspaceRoot = process.platform === "win32" ? "C:\\lsp-code-actions-bridge" : "/lsp-code-actions-bridge";

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "code-actions-1",
    toolId: "lsp.code_actions",
    arguments: argumentsValue,
    display: "lsp.code_actions",
  } as const;
}

function queryResult(result: unknown): LspQueryResult {
  return { server: "typescript", result };
}

describe("LSP code actions bridge", () => {
  test("returns a bounded non-executable catalog without raw server payloads", async () => {
    let received: LspTextDocumentPosition | undefined;
    const bridge = createLspCodeActionsBridge(
      {
        codeActions: async (input) => {
          received = input;
          return queryResult(
            Array.from({ length: 20 }, (_, index) => ({
              title: "Fix " + String(index),
              kind: "quickfix",
              isPreferred: index === 0,
              edit: { changes: { "file:///private-edit.ts": [] } },
              command: {
                title: "run private command",
                command: "private.command",
                arguments: [{ mustNotEscape: true }],
              },
              diagnostics: [{ message: "mustNotEscape" }],
              data: { mustNotEscape: true },
            })),
          );
        },
      },
      { workspaceRoot },
    );

    const execution = await bridge(
      action({ path: "src/widget.ts", line: 2, character: 4 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual({ path: "src/widget.ts", line: 2, character: 4 });
    const data = execution.result.data as {
      readonly kind: string;
      readonly totalActions: number;
      readonly actions: readonly {
        readonly index: number;
        readonly title: string;
        readonly hasEdit: boolean;
        readonly hasCommand: boolean;
      }[];
      readonly truncated: boolean;
    };
    expect(data.kind).toBe("code_actions");
    expect(data.totalActions).toBe(20);
    expect(data.actions).toHaveLength(16);
    expect(data.actions[0]).toMatchObject({
      index: 0,
      title: "Fix 0",
      hasEdit: true,
      hasCommand: true,
    });
    expect(data.truncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("private-edit");
    expect(JSON.stringify(data)).not.toContain("private.command");
    expect(JSON.stringify(data)).not.toContain("mustNotEscape");
    expect(execution.text).toContain("untrusted metadata");
    expect(execution.text).toContain("no command was run");
  });

  test("rejects unsafe input and honors cancellation before calling the reader", async () => {
    let calls = 0;
    const reader: LspCodeActionsReader = {
      codeActions: async () => {
        calls += 1;
        return queryResult([]);
      },
    };
    const bridge = createLspCodeActionsBridge(reader, { workspaceRoot });

    const traversal = await bridge(
      action({ path: "../private.ts", line: 0, character: 0 }),
      new AbortController().signal,
    );
    const oversizedPosition = await bridge(
      action({ path: "src/widget.ts", line: 1_000_001, character: 0 }),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 0 }),
      controller.signal,
    );

    expect(traversal.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(oversizedPosition.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });

  test("fails closed without returning malformed server command details", async () => {
    const bridge = createLspCodeActionsBridge(
      {
        codeActions: async () => queryResult([{ title: "valid", command: "private.command" }]),
      },
      { workspaceRoot },
    );

    const execution = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 0 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(false);
    expect(execution.result.error?.code).toBe("NOT_INITIALIZED");
    expect(execution.result.error?.message).not.toContain("private.command");
  });
});
