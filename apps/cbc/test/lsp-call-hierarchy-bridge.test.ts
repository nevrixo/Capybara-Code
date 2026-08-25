import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  LspCallHierarchyRequest,
  LspCallHierarchyResult,
} from "../src/lsp-host.ts";
import { createLspCallHierarchyBridge } from "../src/lsp-tool-bridge.ts";

const workspaceRoot = process.platform === "win32"
  ? "C:\\lsp-call-hierarchy-bridge"
  : "/lsp-call-hierarchy-bridge";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function action(argumentsValue: Record<string, unknown>) {
  return {
    callId: "call-hierarchy-1",
    toolId: "lsp.call_hierarchy",
    arguments: argumentsValue,
    display: "lsp.call_hierarchy",
  } as const;
}

function argumentsFor(direction: "incoming" | "outgoing" = "incoming") {
  return {
    path: "src/target.ts",
    line: 0,
    character: 7,
    direction,
    offset: 1,
    limit: 1,
  };
}

function range(line: number, start: number, end: number) {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function item(path: string, name: string) {
  return {
    name,
    kind: 12,
    detail: "void " + name + "()",
    uri: workspaceUri(path),
    range: range(0, 0, 12),
    selectionRange: range(0, 5, 11),
    tags: [1],
    data: { mustNotEscape: true },
  };
}

function incomingResult(): LspCallHierarchyResult {
  return {
    server: "typescript",
    direction: "incoming",
    root: item("src/target.ts", "target"),
    result: [
      {
        from: item("src/caller-a.ts", "callerA"),
        fromRanges: [range(3, 2, 8)],
        data: { mustNotEscape: true },
      },
      {
        from: item("src/caller-b.ts", "callerB"),
        fromRanges: [range(7, 2, 8)],
        data: { mustNotEscape: true },
      },
    ],
  };
}

describe("LSP call hierarchy bridge", () => {
  test("returns a bounded workspace-only page and never exposes opaque server fields", async () => {
    let received: LspCallHierarchyRequest | undefined;
    const bridge = createLspCallHierarchyBridge(
      {
        callHierarchy: async (input) => {
          received = input;
          return incomingResult();
        },
      },
      { workspaceRoot },
    );

    const execution = await bridge(
      action(argumentsFor()),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(received).toEqual({
      path: "src/target.ts",
      line: 0,
      character: 7,
      direction: "incoming",
    });
    const data = execution.result.data as {
      readonly kind: string;
      readonly source: { readonly direction: string };
      readonly offset: number;
      readonly limit: number;
      readonly totalCalls: number;
      readonly returnedCalls: number;
      readonly root?: { readonly path: string };
      readonly calls: readonly { readonly item: { readonly name: string; readonly path: string } }[];
    };
    expect(data).toMatchObject({
      kind: "call_hierarchy",
      source: { direction: "incoming" },
      offset: 1,
      limit: 1,
      totalCalls: 2,
      returnedCalls: 1,
      root: { path: "src/target.ts" },
      calls: [{ item: { name: "callerB", path: "src/caller-b.ts" } }],
    });
    expect(JSON.stringify(data)).not.toContain("mustNotEscape");
    expect(JSON.stringify(data)).not.toContain("file:");
    expect(execution.text).toContain("incoming call hierarchy");
    expect(execution.text).toContain("callerB");
    expect(execution.text).toContain("Verify current workspace reads");
  });

  test("represents an empty prepare result without manufacturing a root or calls", async () => {
    const bridge = createLspCallHierarchyBridge(
      {
        callHierarchy: async () => ({
          server: "typescript",
          direction: "outgoing",
          result: [],
          serverPrivate: "must-not-escape",
        } as unknown as LspCallHierarchyResult),
      },
      { workspaceRoot },
    );

    const execution = await bridge(
      action({ ...argumentsFor("outgoing"), offset: 0 }),
      new AbortController().signal,
    );

    expect(execution.result.ok).toBe(true);
    expect(execution.result.data).toMatchObject({
      kind: "call_hierarchy",
      source: { direction: "outgoing" },
      totalCalls: 0,
      returnedCalls: 0,
      calls: [],
    });
    expect(JSON.stringify(execution.result.data)).not.toContain("serverPrivate");
    expect(execution.text).toContain("No language-server call hierarchy item");
  });

  test("rejects invalid pages, cancellation, host direction drift, and unsafe server URIs", async () => {
    let calls = 0;
    const bridge = createLspCallHierarchyBridge(
      {
        callHierarchy: async () => {
          calls += 1;
          return calls === 1
            ? { ...incomingResult(), direction: "outgoing" }
            : {
              ...incomingResult(),
              root: { ...item("src/target.ts", "target"), uri: "file:///outside-workspace.ts" },
            };
        },
      },
      { workspaceRoot },
    );

    const traversal = await bridge(
      action({ ...argumentsFor(), path: "../private.ts" }),
      new AbortController().signal,
    );
    const invalidPage = await bridge(
      action({ ...argumentsFor(), limit: 33 }),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge(action(argumentsFor()), controller.signal);
    const directionDrift = await bridge(action(argumentsFor()), new AbortController().signal);
    const unsafeUri = await bridge(action(argumentsFor()), new AbortController().signal);

    expect(traversal.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(invalidPage.result.error?.code).toBe("INVALID_ARGUMENT");
    expect(cancelled.result.error?.code).toBe("CANCELLED");
    expect(directionDrift.result.error?.code).toBe("NOT_INITIALIZED");
    expect(unsafeUri.result.error?.code).toBe("NOT_INITIALIZED");
    expect(calls).toBe(2);
  });
});
