import { describe, expect, test } from "bun:test";

import type {
  LspCodeActionPreview,
  LspCodeActionPreviewRequest,
} from "../src/lsp-host.ts";
import { createLspCodeActionPreviewBridge } from "../src/lsp-tool-bridge.ts";

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "code-action-preview-1",
    toolId: "lsp.code_action_preview",
    arguments: argumentsValue,
    display: "lsp.code_action_preview",
  } as const;
}

function preview(): LspCodeActionPreview {
  return {
    server: "typescript",
    workspaceEdit: {
      changes: {
        "file:///private-raw-code-action.ts": [],
      },
    },
    edit: {
      paths: ["src/widget.ts"],
      plan: {
        schemaVersion: "1.0",
        id: "edp_code_action_preview",
        source: "lsp",
        workspaceIdentityDigest: "ws_runtime_binding",
        sessionId: "ses_runtime_binding",
        operations: [{
          kind: "replace_range",
          operationId: "edo_code_action",
          path: "src/widget.ts",
          baseRevision: "sha256:widget",
          range: {
            start: { line: 1, column: 14 },
            end: { line: 1, column: 20 },
            encoding: "utf16",
          },
          expectedTextDigest: "sha256:old-widget",
          replacement: "AppliedFix",
          serverPrivate: "must-not-escape",
        }],
        conflictPolicy: "fail",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    },
  } as unknown as LspCodeActionPreview;
}

describe("LSP code action preview bridge", () => {
  test("returns only a revision-bound edit plan, never the raw CodeAction or WorkspaceEdit", async () => {
    let received: LspCodeActionPreviewRequest | undefined;
    const bridge = createLspCodeActionPreviewBridge({
      codeActionPreview: async (input) => {
        received = input;
        return preview();
      },
    });

    const execution = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 13, actionIndex: 1 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 1,
    });
    const data = execution.result.data as {
      readonly kind: string;
      readonly paths: readonly string[];
      readonly plan: {
        readonly source: string;
        readonly operations: readonly Record<string, unknown>[];
      };
    };
    expect(data.kind).toBe("code_action_preview");
    expect(data.paths).toEqual(["src/widget.ts"]);
    expect(data.plan.source).toBe("lsp");
    expect(data.plan.operations[0]).toMatchObject({
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: "AppliedFix",
    });
    expect(JSON.stringify(data)).not.toContain("file:///private-raw-code-action.ts");
    expect(JSON.stringify(data)).not.toContain("must-not-escape");
    expect(execution.text).toContain("not run a language-server command");
    expect(execution.text).not.toContain("AppliedFix");
  });

  test("rejects unsafe input and honors cancellation before calling the reader", async () => {
    let calls = 0;
    const bridge = createLspCodeActionPreviewBridge({
      codeActionPreview: async () => {
        calls += 1;
        return preview();
      },
    });

    const traversal = await bridge(
      action({ path: "../private.ts", line: 0, character: 0, actionIndex: 0 }),
      new AbortController().signal,
    );
    const oversizedIndex = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 0, actionIndex: 256 }),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 0, actionIndex: 0 }),
      controller.signal,
    );

    expect(traversal.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(oversizedIndex.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });
});
