import { describe, expect, test } from "bun:test";

import type {
  LspFormattingPreview,
  LspRangeFormattingPreviewRequest,
} from "../src/lsp-host.ts";
import { createLspRangeFormattingPreviewBridge } from "../src/lsp-tool-bridge.ts";

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "range-format-preview-1",
    toolId: "lsp.range_format_preview",
    arguments: argumentsValue,
    display: "lsp.range_format_preview",
  } as const;
}

function rangeArguments() {
  return {
    path: "src/widget.ts",
    startLine: 0,
    startCharacter: 19,
    endLine: 0,
    endCharacter: 21,
  };
}

function changedPreview(): LspFormattingPreview {
  return {
    server: "typescript",
    edit: {
      paths: ["src/widget.ts"],
      plan: {
        schemaVersion: "1.0",
        id: "edp_range_format_preview",
        source: "lsp",
        workspaceIdentityDigest: "ws_runtime_binding",
        sessionId: "ses_runtime_binding",
        operations: [{
          kind: "replace_range",
          operationId: "edo_range_format",
          path: "src/widget.ts",
          baseRevision: "sha256:widget",
          range: {
            start: { line: 1, column: 20 },
            end: { line: 1, column: 22 },
            encoding: "utf16",
          },
          expectedTextDigest: "sha256:old-widget",
          replacement: " = 1",
          serverPrivate: "must-not-escape",
        }],
        conflictPolicy: "fail",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    },
    workspaceEdit: { changes: { "file:///private-raw-range-format.ts": [] } },
  } as unknown as LspFormattingPreview;
}

function noChangePreview(): LspFormattingPreview {
  return {
    server: "typescript",
    serverPrivate: "must-not-escape",
  } as unknown as LspFormattingPreview;
}

describe("LSP range formatting preview bridge", () => {
  test("returns only a revision-bound range formatting plan, never raw formatter output", async () => {
    let received: LspRangeFormattingPreviewRequest | undefined;
    const bridge = createLspRangeFormattingPreviewBridge({
      rangeFormatPreview: async (input) => {
        received = input;
        return changedPreview();
      },
    });

    const execution = await bridge(
      action(rangeArguments()),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual(rangeArguments());
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
      kind: "range_format_preview",
      path: "src/widget.ts",
      changed: true,
      paths: ["src/widget.ts"],
    });
    expect(data.plan?.source).toBe("lsp");
    expect(data.plan?.operations[0]).toMatchObject({
      kind: "replace_range",
      path: "src/widget.ts",
      replacement: " = 1",
    });
    expect(JSON.stringify(data)).not.toContain("file:///private-raw-range-format.ts");
    expect(JSON.stringify(data)).not.toContain("must-not-escape");
    expect(execution.text).toContain("range formatting preview");
    expect(execution.text).toContain("not written files");
    expect(execution.text).not.toContain(" = 1");
  });

  test("reports a range formatter no-op without manufacturing an empty plan", async () => {
    const bridge = createLspRangeFormattingPreviewBridge({
      rangeFormatPreview: async () => noChangePreview(),
    });

    const execution = await bridge(
      action(rangeArguments()),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(execution.result.data).toMatchObject({
      kind: "range_format_preview",
      path: "src/widget.ts",
      changed: false,
      paths: [],
    });
    expect(JSON.stringify(execution.result.data)).not.toContain("plan");
    expect(execution.text).toContain("no edits");
    expect(execution.text).toContain("No files were written");
  });

  test("rejects traversal, reversed ranges, and cancellation before calling the reader", async () => {
    let calls = 0;
    const bridge = createLspRangeFormattingPreviewBridge({
      rangeFormatPreview: async () => {
        calls += 1;
        return changedPreview();
      },
    });

    const traversal = await bridge(
      action({ ...rangeArguments(), path: "../private.ts" }),
      new AbortController().signal,
    );
    const reversed = await bridge(
      action({
        ...rangeArguments(),
        startCharacter: 22,
        endCharacter: 19,
      }),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(
      action(rangeArguments()),
      controller.signal,
    );

    expect(traversal.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(reversed.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(calls).toBe(0);
  });
});

