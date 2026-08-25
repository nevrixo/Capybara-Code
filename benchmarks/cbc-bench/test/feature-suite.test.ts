import { describe, expect, test } from "bun:test";

import { FEATURE_TASK_CATEGORIES, FEATURE_TASK_PROMPTS, TARGET_TASK_COUNT } from "@cbc/evals";

import { FEATURE_SUITE, SUITE } from "../src/suite.ts";

describe("feature benchmark suite", () => {
  test("keeps the 150-task mix separate from the eight feature tasks", () => {
    expect(SUITE).toHaveLength(TARGET_TASK_COUNT);
    expect(FEATURE_SUITE).toHaveLength(FEATURE_TASK_CATEGORIES.length);
    expect(FEATURE_SUITE.map((task) => task.prompt)).toEqual(
      FEATURE_TASK_CATEGORIES.map((category) => FEATURE_TASK_PROMPTS[category]),
    );
  });
});
