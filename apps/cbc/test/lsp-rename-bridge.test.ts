import { describe, expect, test } from "bun:test";

import type {
  LspRenamePreview,
  LspRenameRequest,
} from "../src/lsp-host.ts";
import { createLspRenamePreviewBridge } from "../src/lsp-tool-bridge.ts";

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "rename-preview-1",
    toolId: "lsp.rename_preview",
    arguments: argumentsValue,
    display: "lsp.rename_preview",
  } as const;
}

function preview(): LspRenamePreview {
  return {
    server: "typescript",
    workspaceEdit: {
      changes: {
        "file:///private-raw-workspace-edit.ts": [],
      },
    },
    edit: {
      paths: ["src/widget.ts"],
      plan: {
        schemaVersion: "1.0",
        id: "edp_rename_preview",
        source: "lsp",
        workspaceIdentityDigest: "ws_runtime_binding",
        sessionId: "ses_runtime_binding",
        operations: [{
          kind: "replace_range",
          operationId: "edo_lsp_rename",
          path: "src/widget.ts",
          baseRevision: "sha256:widget",
          range: {
            start: { line: 1, column: 14 },
            end: { line: 1, column: 20 },
            encoding: "utf16",
          },
          expectedTextDigest: "sha256:old-widget",
          replacement: "Renamed",
          serverPrivate: "must-not-escape",
        }],
        conflictPolicy: "fail",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    },
  } as unknown as LspRenamePreview;
}

describe("LSP rename preview bridge", () => {
  test("returns only a revision-bound edit plan, never the raw WorkspaceEdit", async () => {
    let received: LspRenameRequest | undefined;
    const bridge = createLspRenamePreviewBridge({
      renamePreview: async (input) => {
        received = input;
        return preview();
      },
    });

    const execution = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 13, newName: "Renamed" }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "Renamed",
    });
    const data = execution.result.data as {
      readonly kind: string;
      readonly paths: readonly string[];
      readonly plan: {
        readonly source: string;
        readonly operations: readonly Record<string, unknown>[];
      };
    };
    expect(data.kind).toBe("rename_preview");
    expect(data.paths).toEqual(["src/widget.ts"]);
    expect(data.plan.source).toBe("lsp");
    expect(data.plan.operations[0]).toMatchObject({
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: "Renamed",
    });
    expect(JSON.stringify(data)).not.toContain("file:///private-raw-workspace-edit.ts");
    expect(JSON.stringify(data)).not.toContain("must-not-escape");
    expect(execution.text).toContain("not written files");
    expect(execution.text).not.toContain("Renamed");
  });

  test("rejects unsafe input and honors cancellation before calling the reader", async () => {
    let calls = 0;
    const bridge = createLspRenamePreviewBridge({
      renamePreview: async () => {
        calls += 1;
        return preview();
      },
    });

    const traversal = await bridge(
      action({ path: "../private.ts", line: 0, character: 0, newName: "Renamed" }),
      new AbortController().signal,
    );
    const unsafeName = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 0, newName: "Renamed\nInjected" }),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(
      action({ path: "src/widget.ts", line: 0, character: 0, newName: "Renamed" }),
      controller.signal,
    );

    expect(traversal.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(unsafeName.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });
});

