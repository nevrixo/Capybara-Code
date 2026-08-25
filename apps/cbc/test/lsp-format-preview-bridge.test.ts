import { describe, expect, test } from "bun:test";

import type {
  LspFormattingPreview,
  LspFormattingPreviewRequest,
} from "../src/lsp-host.ts";
import { createLspFormattingPreviewBridge } from "../src/lsp-tool-bridge.ts";

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "format-preview-1",
    toolId: "lsp.format_preview",
    arguments: argumentsValue,
    display: "lsp.format_preview",
  } as const;
}

function changedPreview(): LspFormattingPreview {
  return {
    server: "typescript",
    edit: {
      paths: ["src/widget.ts"],
      plan: {
        schemaVersion: "1.0",
        id: "edp_format_preview",
        source: "lsp",
        workspaceIdentityDigest: "ws_runtime_binding",
        sessionId: "ses_runtime_binding",
        operations: [{
          kind: "replace_range",
          operationId: "edo_format",
          path: "src/widget.ts",
          baseRevision: "sha256:widget",
          range: {
            start: { line: 1, column: 1 },
            end: { line: 1, column: 21 },
            encoding: "utf16",
          },
          expectedTextDigest: "sha256:old-widget",
          replacement: "export const Widget = 1;",
          serverPrivate: "must-not-escape",
        }],
        conflictPolicy: "fail",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    },
    workspaceEdit: { changes: { "file:///private-raw-format.ts": [] } },
  } as unknown as LspFormattingPreview;
}

function noChangePreview(): LspFormattingPreview {
  return {
    server: "typescript",
    serverPrivate: "must-not-escape",
  } as unknown as LspFormattingPreview;
}

describe("LSP formatting preview bridge", () => {
  test("returns only a revision-bound formatting plan, never raw formatter output", async () => {
    let received: LspFormattingPreviewRequest | undefined;
    const bridge = createLspFormattingPreviewBridge({
      formatPreview: async (input) => {
        received = input;
        return changedPreview();
      },
    });

    const execution = await bridge(
      action({ path: "src/widget.ts" }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual({ path: "src/widget.ts" });
    const data = execution.result.data as {
      readonly kind: string;
      readonly path: string;
      readonly changed: boolean;
      readonly paths: readonly string[];
      readonly plan?: {
        readonly source: string;
        readonly operations: readonly Record<string, unknown>[];
      };
    };
    expect(data).toMatchObject({
      kind: "format_preview",
      path: "src/widget.ts",
      changed: true,
      paths: ["src/widget.ts"],
    });
    expect(data.plan?.source).toBe("lsp");
    expect(data.plan?.operations[0]).toMatchObject({
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: "export const Widget = 1;",
    });
    expect(JSON.stringify(data)).not.toContain("file:///private-raw-format.ts");
    expect(JSON.stringify(data)).not.toContain("must-not-escape");
    expect(execution.text).toContain("not written files");
    expect(execution.text).not.toContain("export const Widget = 1;");
  });

  test("reports a formatter no-op without manufacturing an empty plan", async () => {
    const bridge = createLspFormattingPreviewBridge({
      formatPreview: async () => noChangePreview(),
    });

    const execution = await bridge(
      action({ path: "src/widget.ts" }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(execution.result.data).toMatchObject({
      kind: "format_preview",
      path: "src/widget.ts",
      changed: false,
      paths: [],
    });
    expect(JSON.stringify(execution.result.data)).not.toContain("plan");
    expect(execution.text).toContain("no edits");
    expect(execution.text).toContain("No files were written");
  });

  test("rejects unsafe paths and honors cancellation before calling the reader", async () => {
    let calls = 0;
    const bridge = createLspFormattingPreviewBridge({
      formatPreview: async () => {
        calls += 1;
        return changedPreview();
      },
    });

    const traversal = await bridge(
      action({ path: "../private.ts" }),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(
      action({ path: "src/widget.ts" }),
      controller.signal,
    );

    expect(traversal.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });
});

