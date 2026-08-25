import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LspSemanticQueryDomainError,
  normalizeLspHoverQuery,
  normalizeLspLocationQuery,
  normalizeLspSignatureHelpQuery,
} from "../src/index.ts";

const workspaceRoot = process.platform === "win32" ? "C:\\lsp-query-workspace" : "/lsp-query-workspace";

function workspaceUri(path: string): string {
  return pathToFileURL(join(workspaceRoot, ...path.split("/"))).href;
}

function locationOptions(
  overrides: Partial<Parameters<typeof normalizeLspLocationQuery>[2]> = {},
) {
  return {
    workspaceRoot,
    server: "typescript",
    source: { path: "src/query.ts", line: 1, character: 4 },
    ...overrides,
  };
}

function hoverOptions(overrides: Partial<Parameters<typeof normalizeLspHoverQuery>[1]> = {}) {
  return {
    workspaceRoot,
    server: "typescript",
    source: { path: "src/query.ts", line: 1, character: 4 },
    ...overrides,
  };
}

function signatureOptions(
  overrides: Partial<Parameters<typeof normalizeLspSignatureHelpQuery>[1]> = {},
) {
  return {
    workspaceRoot,
    server: "typescript",
    source: { path: "src/query.ts", line: 1, character: 4 },
    ...overrides,
  };
}

function location(path = "src/definition.ts") {
  return {
    uri: workspaceUri(path),
    range: {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 8 },
    },
  };
}

function expectQueryError(
  callback: () => unknown,
  code: LspSemanticQueryDomainError["code"],
): void {
  try {
    callback();
    throw new Error("expected semantic query normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LspSemanticQueryDomainError);
    expect((error as LspSemanticQueryDomainError).code).toBe(code);
  }
}

describe("normalizeLspLocationQuery", () => {
  test("returns immutable workspace-only locations and strips raw server fields", () => {
    const snapshot = normalizeLspLocationQuery(
      "definition",
      [
        { ...location(), data: { mustNotEscape: true } },
        {
          targetUri: workspaceUri("src/linked.ts"),
          targetRange: {
            start: { line: 3, character: 0 },
            end: { line: 5, character: 1 },
          },
          targetSelectionRange: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 8 },
          },
          originSelectionRange: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 9 },
          },
          data: { mustNotEscape: true },
        },
      ],
      locationOptions(),
    );

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "definition",
      server: "typescript",
      source: {
        path: "src/query.ts",
        position: { line: 1, character: 4 },
      },
      locations: [
        {
          path: "src/definition.ts",
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 8 },
          },
        },
        {
          path: "src/linked.ts",
          range: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 8 },
          },
        },
      ],
      totalLocations: 2,
      truncated: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.source)).toBe(true);
    expect(Object.isFrozen(snapshot.source.position)).toBe(true);
    expect(Object.isFrozen(snapshot.locations)).toBe(true);
    expect(Object.isFrozen(snapshot.locations[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("mustNotEscape");
  });

  test("accepts every supported location query kind under the same bounds", () => {
    for (const kind of ["declaration", "type_definition", "implementation"] as const) {
      const snapshot = normalizeLspLocationQuery(kind, null, locationOptions());
      expect(snapshot).toMatchObject({
        schemaVersion: "1.0",
        kind,
        locations: [],
        totalLocations: 0,
        truncated: false,
      });
    }
  });

  test("rejects external paths and malformed location ranges", () => {
    expectQueryError(
      () =>
        normalizeLspLocationQuery(
          "references",
          location("../outside.ts"),
          locationOptions(),
        ),
      "LSP_QUERY_SCOPE_VIOLATION",
    );
    expectQueryError(
      () =>
        normalizeLspLocationQuery(
          "references",
          {
            uri: workspaceUri("src/definition.ts"),
            range: {
              start: { line: 4, character: 1 },
              end: { line: 3, character: 1 },
            },
          },
          locationOptions(),
        ),
      "LSP_QUERY_INVALID",
    );
    expectQueryError(
      () =>
        normalizeLspLocationQuery(
          "references",
          location(),
          locationOptions({ source: { path: "../private.ts", line: 0, character: 0 } }),
        ),
      "LSP_QUERY_SCOPE_VIOLATION",
    );
  });

  test("bounds location input and output deterministically", () => {
    const snapshot = normalizeLspLocationQuery(
      "references",
      [location("src/one.ts"), location("src/two.ts")],
      locationOptions({ maxLocations: 1 }),
    );
    expect(snapshot.locations).toHaveLength(1);
    expect(snapshot.totalLocations).toBe(2);
    expect(snapshot.truncated).toBe(true);

    expectQueryError(
      () =>
        normalizeLspLocationQuery(
          "references",
          Array.from({ length: 4_097 }, () => location()),
          locationOptions(),
        ),
      "LSP_QUERY_LIMIT",
    );
  });
});

describe("normalizeLspHoverQuery", () => {
  test("flattens marked strings into bounded display text without server metadata", () => {
    const snapshot = normalizeLspHoverQuery(
      {
        contents: [
          { language: "typescript", value: "const answer: number;" },
          { kind: "markdown", value: "docs\u001b[31m with \u202e control" },
        ],
        range: {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 10 },
        },
        data: { mustNotEscape: true },
      },
      hoverOptions(),
    );

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "hover",
      server: "typescript",
      source: {
        path: "src/query.ts",
        position: { line: 1, character: 4 },
      },
      found: true,
      contents: "const answer: number;\ndocs [31m with control",
      range: {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 10 },
      },
      truncated: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.range)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("mustNotEscape");
  });

  test("represents no hover text without claiming a lookup failure", () => {
    const snapshot = normalizeLspHoverQuery(null, hoverOptions());
    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "hover",
      server: "typescript",
      source: {
        path: "src/query.ts",
        position: { line: 1, character: 4 },
      },
      found: false,
      truncated: false,
    });
  });

  test("truncates safe hover display output and rejects oversized input", () => {
    const snapshot = normalizeLspHoverQuery(
      { contents: "x".repeat(9 * 1_024) },
      hoverOptions(),
    );
    expect(snapshot.found).toBe(true);
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(snapshot.contents ?? "", "utf8")).toBeLessThanOrEqual(8 * 1_024);

    expectQueryError(
      () => normalizeLspHoverQuery({ contents: "x".repeat(64 * 1_024 + 1) }, hoverOptions()),
      "LSP_QUERY_LIMIT",
    );
  });
});
describe("normalizeLspSignatureHelpQuery", () => {
  test("keeps only bounded display labels and valid active indexes", () => {
    const snapshot = normalizeLspSignatureHelpQuery(
      {
        signatures: [
          {
            label: "fn add(a: number, b: number)",
            parameters: [
              { label: [7, 16], documentation: "not exposed" },
              { label: "b: number", data: { mustNotEscape: true } },
            ],
            documentation: "not exposed",
            data: { mustNotEscape: true },
          },
        ],
        activeSignature: 0,
        activeParameter: 1,
        data: { mustNotEscape: true },
      },
      signatureOptions(),
    );

    expect(snapshot).toEqual({
      schemaVersion: "1.0",
      kind: "signature_help",
      server: "typescript",
      source: {
        path: "src/query.ts",
        position: { line: 1, character: 4 },
      },
      signatures: [{
        label: "fn add(a: number, b: number)",
        parameters: ["a: number", "b: number"],
      }],
      totalSignatures: 1,
      activeSignature: 0,
      activeParameter: 1,
      truncated: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.signatures)).toBe(true);
    expect(Object.isFrozen(snapshot.signatures[0])).toBe(true);
    expect(Object.isFrozen(snapshot.signatures[0]?.parameters)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("mustNotEscape");
    expect(JSON.stringify(snapshot)).not.toContain("not exposed");
  });

  test("represents a null result and bounds visible signatures and parameters", () => {
    expect(normalizeLspSignatureHelpQuery(null, signatureOptions())).toEqual({
      schemaVersion: "1.0",
      kind: "signature_help",
      server: "typescript",
      source: {
        path: "src/query.ts",
        position: { line: 1, character: 4 },
      },
      signatures: [],
      totalSignatures: 0,
      truncated: false,
    });

    const snapshot = normalizeLspSignatureHelpQuery(
      {
        signatures: Array.from({ length: 33 }, (_, index) => ({
          label: "call" + String(index),
          parameters: Array.from({ length: 33 }, (_parameter, parameterIndex) => ({
            label: "p" + String(parameterIndex),
          })),
        })),
        activeSignature: 32,
        activeParameter: 32,
      },
      signatureOptions(),
    );
    expect(snapshot.signatures).toHaveLength(32);
    expect(snapshot.signatures[0]?.parameters).toHaveLength(32);
    expect(snapshot.totalSignatures).toBe(33);
    expect(snapshot.activeSignature).toBeUndefined();
    expect(snapshot.activeParameter).toBeUndefined();
    expect(snapshot.truncated).toBe(true);
  });

  test("rejects invalid signature response shapes and indexes", () => {
    expectQueryError(
      () => normalizeLspSignatureHelpQuery({ signatures: [{ label: "call" }], activeSignature: 1 }, signatureOptions()),
      "LSP_QUERY_INVALID",
    );
    expectQueryError(
      () => normalizeLspSignatureHelpQuery({ signatures: [{ label: "call", parameters: [{ label: [3, 2] }] }] }, signatureOptions()),
      "LSP_QUERY_INVALID",
    );
    expectQueryError(
      () => normalizeLspSignatureHelpQuery({ signatures: Array.from({ length: 257 }, () => ({ label: "call" })) }, signatureOptions()),
      "LSP_QUERY_LIMIT",
    );
  });
});
