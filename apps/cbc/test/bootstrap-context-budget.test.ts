import { describe, expect, test } from "bun:test";

import { resolveAccountInputBudget } from "../src/bootstrap.ts";

describe("ChatGPT account context budget", () => {
  test("uses the 272K account input capacity when the hard cap is automatic", () => {
    expect(resolveAccountInputBudget("auto", 272_000)).toBe(272_000);
  });

  test("preserves a stricter explicit cap and clamps a wider one", () => {
    expect(resolveAccountInputBudget(192_000, 272_000)).toBe(192_000);
    expect(resolveAccountInputBudget(512_000, 272_000)).toBe(272_000);
  });
});
