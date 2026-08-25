import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LspDiagnosticDomainError,
  normalizeLspDiagnostics,
  normalizeLspPullDiagnostics,
} from "../src/index.ts";

const workspaceRoot = process.platform === "win32" ? "C:\\lsp-diagnostics-workspace" : "/lsp-diagnostics-workspace";
const publishedAt = "2026-08-25T00:00:00.000Z";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function options(overrides: Partial<Parameters<typeof normalizeLspDiagnostics>[1]> = {}) {
  return {
    workspaceRoot,
    workspaceIdentityDigest: "sha256:workspace",
    server: "typescript",
    document: {
      path: "src/example.ts",
      text: "const value = 1;\n",
      revision: "sha256:document-revision",
    },
    documentVersion: 7,
    publishedAt,
    ...overrides,
  };
}

function pullOptions(
  overrides: Partial<Parameters<typeof normalizeLspPullDiagnostics>[1]> = {},
) {
  return {
    ...options(),
    uri: workspaceUri("src/example.ts"),
    ...overrides,
  };
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    uri: workspaceUri("src/example.ts"),
    version: 7,
    diagnostics: [{
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 },
      },
      severity: 1,
      code: 2322,
      source: "tsserver",
      message: "unexpected\u001b[31m token",
      data: { ignored: true },
      relatedInformation: [{ ignored: true }],
    }],
    ...overrides,
  };
}

function expectDiagnosticError(
  callback: () => unknown,
  code: LspDiagnosticDomainError["code"],
): void {
  try {
    callback();
    throw new Error("expected diagnostic normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LspDiagnosticDomainError);
    expect((error as LspDiagnosticDomainError).code).toBe(code);
  }
}

describe("normalizeLspDiagnostics", () => {
  test("returns immutable, revision-bound and display-safe diagnostic evidence", () => {
    const snapshot = normalizeLspDiagnostics(params(), options());

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      server: "typescript",
      workspaceIdentityDigest: "sha256:workspace",
      path: "src/example.ts",
      documentRevision: "sha256:document-revision",
      documentVersion: 7,
      publishedAt,
      diagnostics: [{
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        severity: 1,
        code: "2322",
        source: "tsserver",
        message: "unexpected [31m token",
      }],
      totalDiagnostics: 1,
      truncated: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
    expect(Object.isFrozen(snapshot.diagnostics[0])).toBe(true);
  });

  test("requires the exact URI and LSP document version that produced the opened snapshot", () => {
    expectDiagnosticError(
      () => normalizeLspDiagnostics(params({ version: 8 }), options()),
      "LSP_DIAGNOSTICS_STALE",
    );
    expectDiagnosticError(
      () => normalizeLspDiagnostics(params({ uri: workspaceUri("src/other.ts") }), options()),
      "LSP_DIAGNOSTICS_STALE",
    );
    expectDiagnosticError(
      () => normalizeLspDiagnostics(params({ version: undefined }), options()),
      "LSP_DIAGNOSTICS_STALE",
    );
    expectDiagnosticError(
      () => normalizeLspDiagnostics(params({ uri: pathToFileURL(join(workspaceRoot, "..", "outside.ts")).href }), options()),
      "LSP_DIAGNOSTICS_SCOPE_VIOLATION",
    );
  });

  test("rejects ranges that do not land on valid UTF-16 document boundaries", () => {
    expectDiagnosticError(
      () => normalizeLspDiagnostics(
        params({
          diagnostics: [{
            range: {
              start: { line: 0, character: 7 },
              end: { line: 0, character: 100 },
            },
            message: "outside",
          }],
        }),
        options(),
      ),
      "LSP_DIAGNOSTICS_INVALID",
    );

    expectDiagnosticError(
      () => normalizeLspDiagnostics(
        params({
          diagnostics: [{
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 2 },
            },
            message: "inside surrogate",
          }],
        }),
        options({
          document: {
            path: "src/example.ts",
            text: "😀\n",
            revision: "sha256:emoji",
          },
        }),
      ),
      "LSP_DIAGNOSTICS_INVALID",
    );
  });

  test("truncates bounded output but rejects oversized or unsafe diagnostic payloads", () => {
    const snapshot = normalizeLspDiagnostics(
      params({
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            message: "first",
          },
          {
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
            message: "second",
          },
        ],
      }),
      options({ maxDiagnostics: 1 }),
    );

    expect(snapshot.totalDiagnostics).toBe(2);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.diagnostics).toHaveLength(1);

    expectDiagnosticError(
      () => normalizeLspDiagnostics(
        params({
          diagnostics: [{
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            message: "x".repeat(4_097),
          }],
        }),
        options(),
      ),
      "LSP_DIAGNOSTICS_LIMIT",
    );
  });
});

describe("normalizeLspPullDiagnostics", () => {
  test("normalizes a full report into revision-bound diagnostic evidence", () => {
    const snapshot = normalizeLspPullDiagnostics(
      {
        kind: "full",
        items: params().diagnostics,
        resultId: "server-private-result-id",
        relatedDocuments: { ignored: true },
      },
      pullOptions(),
    );

    expect(snapshot).toEqual(normalizeLspDiagnostics(params(), options()));
    expect(JSON.stringify(snapshot)).not.toContain("server-private-result-id");
    expect(JSON.stringify(snapshot)).not.toContain("relatedDocuments");
  });

  test("does not invent evidence for unchanged reports and rejects malformed reports", () => {
    expect(normalizeLspPullDiagnostics(
      { kind: "unchanged", resultId: "prior" },
      pullOptions(),
    )).toBeUndefined();

    expectDiagnosticError(
      () => normalizeLspPullDiagnostics({ kind: "full", items: {} }, pullOptions()),
      "LSP_DIAGNOSTICS_INVALID",
    );
    expectDiagnosticError(
      () => normalizeLspPullDiagnostics({ kind: "future" }, pullOptions()),
      "LSP_DIAGNOSTICS_INVALID",
    );
    expectDiagnosticError(
      () => normalizeLspPullDiagnostics(
        { kind: "full", items: [] },
        pullOptions({ uri: workspaceUri("../outside.ts") }),
      ),
      "LSP_DIAGNOSTICS_SCOPE_VIOLATION",
    );
  });
});
