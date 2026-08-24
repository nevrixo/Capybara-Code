import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { preflightEditPlan, textDigest } from "@cbc/edit-domain";

import { buildLspEditPlan, collectLspWorkspaceEditPaths, LspEditDomainError } from "../src/index.ts";

const workspaceRoot = process.platform === "win32" ? "C:\\lsp-workspace" : "/lsp-workspace";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

describe("buildLspEditPlan", () => {
  test("preserves LSP UTF-16 positions and exact revisions for a Unicode edit", () => {
    const document = { path: "src/a.ts", text: "a😀b\n", revision: "sha256:rev-a" };
    const result = buildLspEditPlan({
      changes: {
        [workspaceUri("src/a.ts")]: [{
          range: {
            start: { line: 0, character: 3 },
            end: { line: 0, character: 4 },
          },
          newText: "z",
        }],
      },
    }, {
      workspaceRoot,
      workspaceIdentityDigest: "ws_1",
      sessionId: "ses_1",
      documents: [document],
      planId: "edp_lsp_unicode",
      createdAt: "2026-08-25T00:00:00.000Z",
    });

    expect(result.paths).toEqual(["src/a.ts"]);
    expect(result.plan.operations).toEqual([expect.objectContaining({
      kind: "replace_range",
      operationId: "edo_lsp_lsp_unicode_0",
      path: "src/a.ts",
      baseRevision: "sha256:rev-a",
      range: {
        start: { line: 1, column: 4 },
        end: { line: 1, column: 5 },
        encoding: "utf16",
      },
      expectedTextDigest: textDigest("b"),
      replacement: "z",
    })]);
    const preflight = preflightEditPlan(result.plan, {
      workspaceIdentityDigest: "ws_1",
      documents: [document],
    });
    expect(preflight.files[0]?.text).toBe("a😀z\n");
  });

  test("converts LSP resource operations and binds their source revisions", () => {
    const result = buildLspEditPlan({
      documentChanges: [
        { kind: "rename", oldUri: workspaceUri("src/a.ts"), newUri: workspaceUri("src/b.ts") },
        { kind: "delete", uri: workspaceUri("src/c.ts") },
        { kind: "create", uri: workspaceUri("src/d.ts") },
      ],
    }, {
      workspaceRoot,
      workspaceIdentityDigest: "ws_1",
      sessionId: "ses_1",
      documents: [
        { path: "src/a.ts", text: "a\n", revision: "sha256:a" },
        { path: "src/c.ts", text: "c\n", revision: "sha256:c" },
      ],
      planId: "edp_lsp_resources",
      createdAt: "2026-08-25T00:00:00.000Z",
    });

    expect(result.paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(result.plan.operations).toEqual([
      expect.objectContaining({ kind: "move_file", path: "src/a.ts", toPath: "src/b.ts", expectedRevision: "sha256:a" }),
      expect.objectContaining({ kind: "delete_file", path: "src/c.ts", expectedRevision: "sha256:c" }),
      expect.objectContaining({ kind: "create_file", path: "src/d.ts", content: "" }),
    ]);
  });

  test("collects deterministic source and destination paths before snapshot reads", () => {
    const paths = collectLspWorkspaceEditPaths({
      changes: {
        [workspaceUri("src/z.ts")]: [],
      },
      documentChanges: [
        { kind: "rename", oldUri: workspaceUri("src/a.ts"), newUri: workspaceUri("src/b.ts") },
        { kind: "create", uri: workspaceUri("src/new.ts") },
        { kind: "delete", uri: workspaceUri("src/z.ts") },
      ],
    }, workspaceRoot);

    expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/new.ts", "src/z.ts"]);
  });

  test("rejects URIs outside the workspace and text edits without an exact snapshot", () => {
    const outside = pathToFileURL(join(workspaceRoot, "..", "outside.ts")).href;
    expect(() => buildLspEditPlan({
      changes: { [outside]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }] },
    }, {
      workspaceRoot,
      workspaceIdentityDigest: "ws_1",
      sessionId: "ses_1",
      documents: [],
    })).toThrow(LspEditDomainError);
    expect(() => buildLspEditPlan({
      changes: { [workspaceUri("src/missing.ts")]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }] },
    }, {
      workspaceRoot,
      workspaceIdentityDigest: "ws_1",
      sessionId: "ses_1",
      documents: [],
    })).toThrow(/missing exact snapshot/);
  });
});
