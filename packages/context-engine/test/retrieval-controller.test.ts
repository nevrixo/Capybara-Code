import { describe, expect, test } from "bun:test";

import {
  RetrievalController,
  type RetrievalAdapter,
  type RetrievalCandidate,
  type RetrievalObservation,
} from "../src/index.ts";

function observation(
  candidate: RetrievalCandidate,
  mode: "preview" | "exact",
  overrides: Partial<RetrievalObservation> = {},
): RetrievalObservation {
  return {
    path: candidate.path,
    mode,
    startLine: candidate.startLine ?? 1,
    endLine: (candidate.startLine ?? 1) + 1,
    text: "line one\nline two",
    revisionToken: `${mode}-revision`,
    ...(mode === "exact" ? { checksum: "sha256" } : {}),
    authoritativeForWrite: mode === "exact",
    endOfFile: false,
    truncatedByBytes: false,
    bytesScanned: mode === "preview" ? 10 : 30,
    ...overrides,
  };
}

function adapter(options: {
  readonly sufficient?: boolean;
  readonly exact?: (candidate: RetrievalCandidate) => RetrievalObservation;
} = {}): RetrievalAdapter {
  return {
    async search() {
      return [
        { path: "src/second.ts", score: 1 },
        { path: "src/first.ts", score: 2 },
        { path: "src/first.ts", score: 2 },
      ];
    },
    async preview(candidate) {
      return observation(candidate, "preview", { sufficient: options.sufficient ?? false });
    },
    async exact(candidate) {
      return options.exact?.(candidate) ?? observation(candidate, "exact");
    },
  };
}

describe("RetrievalController", () => {
  test("previews before exact and stops after authoritative evidence", async () => {
    const result = await new RetrievalController(adapter(), {
      budget: {
        maxSearchCalls: 1,
        maxPreviewCalls: 4,
        maxExactCalls: 1,
        maxBytesScanned: 100,
        maxEvidenceTokens: 100,
      },
    }).run("find parser");

    expect(result.stopReason).toBe("exact_evidence");
    expect(result.phase).toBe("exact");
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    expect(result.previews.map((entry) => entry.path)).toEqual(["src/first.ts"]);
    expect(result.exact.map((entry) => entry.path)).toEqual(["src/first.ts"]);
    expect(result.stats).toMatchObject({ searchCalls: 1, previewCalls: 1, exactCalls: 1 });
  });

  test("accepts a sufficient preview without granting write authority", async () => {
    const result = await new RetrievalController(adapter({ sufficient: true }), {
      budget: {
        maxSearchCalls: 1,
        maxPreviewCalls: 1,
        maxExactCalls: 1,
        maxBytesScanned: 100,
        maxEvidenceTokens: 100,
      },
    }).run("find parser");

    expect(result.stopReason).toBe("sufficient_preview");
    expect(result.exact).toHaveLength(0);
    expect(result.previews[0]?.authoritativeForWrite).toBe(false);
  });

  test("rejects an exact response that is not write-authoritative", async () => {
    const result = await new RetrievalController(adapter({
      exact: (candidate) => observation(candidate, "exact", { authoritativeForWrite: false }),
    }), {
      budget: {
        maxSearchCalls: 1,
        maxPreviewCalls: 1,
        maxExactCalls: 1,
        maxBytesScanned: 100,
        maxEvidenceTokens: 100,
      },
    }).run("find parser");

    expect(result.stopReason).toBe("non_authoritative_exact");
    expect(result.exact).toHaveLength(0);
    expect(result.errors[0]?.phase).toBe("exact");
  });

  test("stops before another read when the byte budget is exhausted", async () => {
    const result = await new RetrievalController(adapter(), {
      budget: {
        maxSearchCalls: 1,
        maxPreviewCalls: 4,
        maxExactCalls: 4,
        maxBytesScanned: 9,
        maxEvidenceTokens: 100,
      },
    }).run("find parser");

    expect(result.stopReason).toBe("byte_budget");
    expect(result.previews).toHaveLength(1);
    expect(result.exact).toHaveLength(0);
  });
});
