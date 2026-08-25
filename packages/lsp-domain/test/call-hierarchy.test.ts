import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LspCallHierarchyDomainError,
  normalizeLspCallHierarchyQuery,
} from "../src/index.ts";

const workspaceRoot = process.platform === "win32"
  ? "C:\\lsp-call-hierarchy-workspace"
  : "/lsp-call-hierarchy-workspace";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function range(startLine = 1, startCharacter = 0, endLine = 1, endCharacter = 6) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function item(path: string, name = "symbol") {
  return {
    name,
    kind: 12,
    detail: "void " + name + "()",
    uri: workspaceUri(path),
    range: range(),
    selectionRange: range(1, 1, 1, 5),
    tags: [1],
    data: { mustNotEscape: true },
  };
}

function options(
  overrides: Partial<Parameters<typeof normalizeLspCallHierarchyQuery>[2]> = {},
) {
  return {
    workspaceRoot,
    server: "typescript",
    source: {
      path: "src/entry.ts",
      line: 3,
      character: 7,
      direction: "incoming" as const,
    },
    ...overrides,
  };
}

function expectCallHierarchyError(
  callback: () => unknown,
  code: LspCallHierarchyDomainError["code"],
): void {
  try {
    callback();
    throw new Error("expected call hierarchy normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LspCallHierarchyDomainError);
    expect((error as LspCallHierarchyDomainError).code).toBe(code);
  }
}

describe("normalizeLspCallHierarchyQuery", () => {
  test("returns an immutable workspace-only page and strips opaque server fields", () => {
    const snapshot = normalizeLspCallHierarchyQuery(
      item("src/target.ts", "target\u001b[31m"),
      [
        {
          from: item("src/caller-a.ts", "callerA"),
          fromRanges: [range(4, 2, 4, 8)],
          data: { mustNotEscape: true },
        },
        {
          from: item("src/caller-b.ts", "callerB"),
          fromRanges: [range(8, 2, 8, 8)],
          data: { mustNotEscape: true },
        },
      ],
      options({ offset: 1, limit: 1 }),
    );

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "call_hierarchy",
      server: "typescript",
      source: {
        path: "src/entry.ts",
        position: { line: 3, character: 7 },
        direction: "incoming",
      },
      root: {
        name: "target [31m",
        kind: 12,
        detail: "void target [31m()",
        path: "src/target.ts",
        range: range(),
        selectionRange: range(1, 1, 1, 5),
      },
      offset: 1,
      limit: 1,
      totalCalls: 2,
      returnedCalls: 1,
      calls: [{
        item: {
          name: "callerB",
          kind: 12,
          detail: "void callerB()",
          path: "src/caller-b.ts",
          range: range(),
          selectionRange: range(1, 1, 1, 5),
        },
        fromRanges: [range(8, 2, 8, 8)],
      }],
      truncated: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("mustNotEscape");
    expect(JSON.stringify(snapshot)).not.toContain("\u001b");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.calls)).toBe(true);
    expect(Object.isFrozen(snapshot.calls[0]?.item)).toBe(true);
    expect(Object.isFrozen(snapshot.calls[0]?.fromRanges)).toBe(true);
  });

  test("uses outgoing targets and represents an empty prepare result without raw data", () => {
    const outgoing = normalizeLspCallHierarchyQuery(
      item("src/source.ts", "source"),
      [{
        to: item("src/target.ts", "target"),
        fromRanges: [range(2, 0, 2, 6)],
      }],
      options({
        source: {
          path: "src/source.ts",
          line: 2,
          character: 2,
          direction: "outgoing",
        },
      }),
    );
    expect(outgoing.calls[0]).toMatchObject({
      item: { name: "target", path: "src/target.ts" },
      fromRanges: [range(2, 0, 2, 6)],
    });

    const empty = normalizeLspCallHierarchyQuery(undefined, [], options());
    expect(empty).toMatchObject({
      totalCalls: 0,
      returnedCalls: 0,
      calls: [],
      truncated: false,
    });
    expect(empty.root).toBeUndefined();
  });

  test("rejects malformed, out-of-workspace, and oversized server responses", () => {
    expectCallHierarchyError(
      () =>
        normalizeLspCallHierarchyQuery(
          item("src/target.ts"),
          [{
            from: { ...item("src/caller.ts"), uri: "file:///outside-workspace.ts" },
            fromRanges: [range()],
          }],
          options(),
        ),
      "LSP_CALL_HIERARCHY_SCOPE_VIOLATION",
    );
    expectCallHierarchyError(
      () =>
        normalizeLspCallHierarchyQuery(
          item("src/target.ts"),
          [{
            from: item("src/caller.ts"),
            fromRanges: Array.from({ length: 33 }, () => range()),
          }],
          options(),
        ),
      "LSP_CALL_HIERARCHY_LIMIT",
    );
    expectCallHierarchyError(
      () =>
        normalizeLspCallHierarchyQuery(
          item("src/target.ts"),
          [{
            from: item("src/caller.ts"),
            fromRanges: [range()],
          }],
          options({ offset: 257 }),
        ),
      "LSP_CALL_HIERARCHY_LIMIT",
    );
    expectCallHierarchyError(
      () =>
        normalizeLspCallHierarchyQuery(
          undefined,
          [{
            from: item("src/caller.ts"),
            fromRanges: [range()],
          }],
          options(),
        ),
      "LSP_CALL_HIERARCHY_INVALID",
    );
  });
});
