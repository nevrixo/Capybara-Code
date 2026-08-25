import { describe, expect, test } from "bun:test";

import { renderReflectionPrompt } from "../src/kernel.ts";

describe("patch recovery guidance", () => {
  test("retries with exact context instead of hand-counted hunks", () => {
    const prompt = renderReflectionPrompt({
      errorCategory: "schema_mismatch",
      rootCause: "the hunk header was malformed",
      correctiveAction: "re-read main.js and express the same edit with exact context",
      approachInvalid: false,
      attempts: 1,
      signature: "sig",
      toolId: "fs.apply_patch",
      implicatedPaths: ["main.js"],
    });

    expect(prompt).toContain("Prefer bare '@@'");
    expect(prompt).toContain("Hunk counts are derived from the body");
    expect(prompt).toContain("do not hand-count them");
    expect(prompt).not.toContain("bare '@@' is not valid");
  });
});
