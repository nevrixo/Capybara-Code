import { describe, expect, test } from "bun:test";

import {
  EDIT_SCHEMA_VERSION,
  EditDomainError,
  preflightEditPlan,
  rangeToByteRange,
  textDigest,
  type EditDocument,
  type EditOperation,
  type EditPlan,
  type EditWorkspaceSnapshot,
} from "../src/index.ts";

function document(path: string, text: string, revision = "rev_1"): EditDocument {
  return { path, text, revision };
}

function snapshot(...documents: readonly EditDocument[]): EditWorkspaceSnapshot {
  return { workspaceIdentityDigest: "ws_digest", documents };
}

function plan(
  operations: readonly EditOperation[],
  conflictPolicy: EditPlan["conflictPolicy"] = "fail",
): EditPlan {
  return {
    schemaVersion: EDIT_SCHEMA_VERSION,
    id: "edp_test",
    source: "model",
    workspaceIdentityDigest: "ws_digest",
    sessionId: "ses_test",
    operations,
    conflictPolicy,
    createdAt: "2026-08-24T00:00:00.000Z",
  };
}

function exact(text: string, revision: string) {
  return {
    kind: "exact_text" as const,
    baseRevision: revision,
    originalText: text,
    originalTextDigest: textDigest(text),
  };
}

describe("edit-domain positions", () => {
  test("converts UTF-8 and UTF-16 positions without splitting a surrogate pair", () => {
    const text = "α😀\r\nbeta";
    expect(rangeToByteRange(text, {
      start: { line: 1, column: 3 },
      end: { line: 1, column: 7 },
      encoding: "utf8",
    })).toEqual({ start: 2, end: 6 });
    expect(rangeToByteRange(text, {
      start: { line: 1, column: 2 },
      end: { line: 1, column: 4 },
      encoding: "utf16",
    })).toEqual({ start: 2, end: 6 });
    expect(() => rangeToByteRange(text, {
      start: { line: 1, column: 3 },
      end: { line: 1, column: 4 },
      encoding: "utf16",
    })).toThrow(EditDomainError);
  });
});

describe("edit-domain preflight", () => {
  test("safely rebases a unique exact-text anchor after an unrelated revision change", () => {
    const target = "const value = 1;";
    const result = preflightEditPlan(
      plan([{
        kind: "replace_anchor",
        operationId: "edo_replace",
        path: "src/a.ts",
        anchor: exact(target, "rev_before"),
        replacement: "const value = 2;",
      }], "safe_rebase"),
      snapshot(document("src/a.ts", `// unrelated\n${target}\n`, "rev_after")),
    );
    expect(result.status).toBe("previewed");
    expect(result.files[0]?.text).toBe("// unrelated\nconst value = 2;\n");
    expect(result.resolvedOperations[0]?.resolution.method).toBe("exact_text");
  });

  test("rejects duplicated exact anchors without independent range or context evidence", () => {
    const target = "target";
    try {
      preflightEditPlan(
        plan([{
          kind: "replace_anchor",
          operationId: "edo_ambiguous",
          path: "src/a.ts",
          anchor: exact(target, "rev_1"),
          replacement: "changed",
        }]),
        snapshot(document("src/a.ts", `${target}\n${target}\n`)),
      );
      throw new Error("expected ambiguous anchor failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "EDIT_ANCHOR_AMBIGUOUS" });
    }
  });

  test("rejects overlapping text edits against one original revision", () => {
    try {
      preflightEditPlan(
        plan([
          {
            kind: "replace_range",
            operationId: "edo_left",
            path: "src/a.ts",
            baseRevision: "rev_1",
            range: {
              start: { line: 1, column: 2 },
              end: { line: 1, column: 5 },
              encoding: "unicode_scalar",
            },
            replacement: "X",
          },
          {
            kind: "replace_range",
            operationId: "edo_right",
            path: "src/a.ts",
            baseRevision: "rev_1",
            range: {
              start: { line: 1, column: 4 },
              end: { line: 1, column: 7 },
              encoding: "unicode_scalar",
            },
            replacement: "Y",
          },
        ]),
        snapshot(document("src/a.ts", "abcdef")),
      );
      throw new Error("expected overlap failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "EDIT_OVERLAP" });
    }
  });

  test("orders same-offset inserts by operation id deterministically", () => {
    const target = "target";
    const result = preflightEditPlan(
      plan([
        {
          kind: "insert_before",
          operationId: "edo_b",
          path: "src/a.ts",
          anchor: exact(target, "rev_1"),
          text: "B",
        },
        {
          kind: "insert_before",
          operationId: "edo_a",
          path: "src/a.ts",
          anchor: exact(target, "rev_1"),
          text: "A",
        },
      ]),
      snapshot(document("src/a.ts", target)),
    );
    expect(result.files[0]?.text).toBe("ABtarget");
  });

  test("uses bounded context to distinguish repeated targets", () => {
    const target = "target";
    const result = preflightEditPlan(
      plan([{
        kind: "replace_anchor",
        operationId: "edo_context",
        path: "src/a.ts",
        anchor: {
          kind: "context",
          baseRevision: "rev_1",
          targetDigest: textDigest(target),
          targetPreview: target,
          before: ["second"],
          after: ["after-second"],
          whitespacePolicy: "exact",
        },
        replacement: "changed",
      }]),
      snapshot(document("src/a.ts", "first\ntarget\nafter-first\nsecond\ntarget\nafter-second")),
    );
    expect(result.files[0]?.text).toBe("first\ntarget\nafter-first\nsecond\nchanged\nafter-second");
  });

  test("rejects file operation conflicts before staging a mutation", () => {
    try {
      preflightEditPlan(
        plan([{


          kind: "create_file",
          operationId: "edo_create",
          path: "src/a.ts",
          content: "new",
        }]),
        snapshot(document("src/a.ts", "existing")),
      );
      throw new Error("expected create conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "EDIT_PATH_CONFLICT" });
    }
  });

  test("rejects chained move operations before staging either move", () => {
    try {
      preflightEditPlan(
        plan([
          {
            kind: "move_file",
            operationId: "edo_move_first",
            path: "src/a.ts",
            toPath: "src/b.ts",
          },
          {
            kind: "move_file",
            operationId: "edo_move_second",
            path: "src/b.ts",
            toPath: "src/c.ts",
          },
        ]),
        snapshot(document("src/a.ts", "existing")),
      );
      throw new Error("expected chained move conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "EDIT_PATH_CONFLICT" });
    }
  });

});
