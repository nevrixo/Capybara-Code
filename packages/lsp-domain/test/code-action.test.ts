import { describe, expect, test } from "bun:test";

import {
  LspCodeActionQueryDomainError,
  normalizeLspCodeActionQuery,
} from "../src/index.ts";

function options(
  overrides: Partial<Parameters<typeof normalizeLspCodeActionQuery>[1]> = {},
) {
  return {
    workspaceRoot: process.platform === "win32" ? "C:\\code-actions" : "/code-actions",
    server: "typescript",
    source: { path: "src/widget.ts", line: 2, character: 4 },
    ...overrides,
  };
}

function expectCodeActionError(
  callback: () => unknown,
  code: LspCodeActionQueryDomainError["code"],
): void {
  try {
    callback();
    throw new Error("expected code action normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LspCodeActionQueryDomainError);
    expect((error as LspCodeActionQueryDomainError).code).toBe(code);
  }
}

describe("normalizeLspCodeActionQuery", () => {
  test("returns immutable display metadata and strips edit, command, and data payloads", () => {
    const snapshot = normalizeLspCodeActionQuery(
      [
        {
          title: "Fix \u202e issue",
          kind: "quickfix",
          isPreferred: true,
          edit: { changes: { "file:///private-edit.ts": [] } },
          command: {
            title: "run private command",
            command: "dangerous.command",
            arguments: [{ mustNotEscape: true }],
          },
          diagnostics: [{ message: "mustNotEscape" }],
          data: { mustNotEscape: true },
        },
        {
          title: "Extract helper",
          kind: "refactor.extract",
          disabled: { reason: "not available \u202e hidden" },
          data: { mustNotEscape: true },
        },
      ],
      options(),
    );

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "code_actions",
      server: "typescript",
      source: {
        path: "src/widget.ts",
        position: { line: 2, character: 4 },
      },
      actions: [
        {
          index: 0,
          title: "Fix issue",
          kind: "quickfix",
          preferred: true,
          disabled: false,
          hasEdit: true,
          hasCommand: true,
        },
        {
          index: 1,
          title: "Extract helper",
          kind: "refactor.extract",
          preferred: false,
          disabled: true,
          hasEdit: false,
          hasCommand: false,
        },
      ],
      totalActions: 2,
      truncated: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.source)).toBe(true);
    expect(Object.isFrozen(snapshot.source.position)).toBe(true);
    expect(Object.isFrozen(snapshot.actions)).toBe(true);
    expect(Object.isFrozen(snapshot.actions[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("mustNotEscape");
    expect(JSON.stringify(snapshot)).not.toContain("private-edit");
    expect(JSON.stringify(snapshot)).not.toContain("dangerous.command");
  });

  test("represents no actions and bounds catalog output deterministically", () => {
    expect(normalizeLspCodeActionQuery(null, options())).toEqual({
      schemaVersion: "1.0",
      kind: "code_actions",
      server: "typescript",
      source: {
        path: "src/widget.ts",
        position: { line: 2, character: 4 },
      },
      actions: [],
      totalActions: 0,
      truncated: false,
    });

    const snapshot = normalizeLspCodeActionQuery(
      [{ title: "One" }, { title: "Two", command: { title: "two", command: "two" } }],
      options({ maxActions: 1 }),
    );
    expect(snapshot.actions).toEqual([
      {
        index: 0,
        title: "One",
        preferred: false,
        disabled: false,
        hasEdit: false,
        hasCommand: false,
      },
    ]);
    expect(snapshot.totalActions).toBe(2);
    expect(snapshot.truncated).toBe(true);

    expectCodeActionError(
      () => normalizeLspCodeActionQuery(Array.from({ length: 257 }, () => ({ title: "too many" })), options()),
      "LSP_CODE_ACTION_LIMIT",
    );
  });

  test("rejects malformed action shapes and unsafe source paths", () => {
    expectCodeActionError(
      () => normalizeLspCodeActionQuery([{ title: "valid", command: "not-a-command" }], options()),
      "LSP_CODE_ACTION_INVALID",
    );
    expectCodeActionError(
      () => normalizeLspCodeActionQuery([{ title: "\u202e" }], options()),
      "LSP_CODE_ACTION_INVALID",
    );
    expectCodeActionError(
      () => normalizeLspCodeActionQuery([], options({ source: { path: "../private.ts", line: 0, character: 0 } })),
      "LSP_CODE_ACTION_SCOPE_VIOLATION",
    );
    expectCodeActionError(
      () => normalizeLspCodeActionQuery({}, options()),
      "LSP_CODE_ACTION_INVALID",
    );
  });
});
