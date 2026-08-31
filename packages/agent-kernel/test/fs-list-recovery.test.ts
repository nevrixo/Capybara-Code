import { describe, expect, test } from "bun:test";

import { NATIVE_TOOLS } from "@cbc/tool-registry";

import { classifyFailure, renderReflectionPrompt } from "../src/index.ts";

describe("missing directory recovery", () => {
  test("fs.list advertises the creation-safe parent-directory workflow", () => {
    const list = NATIVE_TOOLS.find((tool) => tool.id === "fs.list");

    expect(list?.description).toContain("nearest existing parent");
    expect(list?.description).toContain("NOT_FOUND");
    expect(list?.description).toContain("fs.write");
  });

  test("a missing listing is diagnosed as absent rather than empty", () => {
    const hint = classifyFailure({
      toolId: "fs.list",
      code: "NOT_FOUND",
      message: "src was not found",
      details: { path: "src" },
    });

    expect(hint.category).toBe("logic_bug");
    expect(hint.guidance).toContain("directory is absent, not empty");
    expect(hint.guidance).toContain("nearest existing parent");
    expect(hint.retryable).toBe(false);
  });

  test("reflection directs a creation task forward without repeating fs.list", () => {
    const prompt = renderReflectionPrompt({
      errorCategory: "logic_bug",
      rootCause: "fs.list reported that src is absent",
      correctiveAction: "inspect the nearest existing parent",
      approachInvalid: false,
      attempts: 1,
      signature: "sig",
      toolId: "fs.list",
      implicatedPaths: ["src"],
    });

    expect(prompt).toContain("directory is absent, not empty");
    expect(prompt).toContain("Do not list it again");
    expect(prompt).toContain("fs.write intent=create");
  });
});
