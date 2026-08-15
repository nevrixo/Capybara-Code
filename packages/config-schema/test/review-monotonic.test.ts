import { describe, expect, test } from "bun:test";

import { mergeConfig } from "../src/index.ts";

function expectWeakeningError(
  issues: ReturnType<typeof mergeConfig>["issues"],
  path: string,
  source: "project" | "project-local" = "project",
): void {
  expect(issues).toContainEqual(expect.objectContaining({
    severity: "error",
    path,
    source,
  }));
  expect(
    issues.find(
      (issue) =>
        issue.path === path &&
        issue.source === source &&
        issue.severity === "error",
    )?.message,
  ).toContain("may not weaken");
}

describe("monotonic project review policy", () => {
  test("a project cannot disable automatic review selected by the user", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.reviewMode": "auto" } },
      { source: "project", values: { "agent.reviewMode": "off" } },
    ]);

    expect(merged.config.agent.reviewMode).toBe("auto");
    expectWeakeningError(merged.issues, "agent.reviewMode");
  });

  test("a project cannot weaken an always-review policy to risk-based review", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.verification.reviewPolicy": "always" } },
      { source: "project", values: { "agent.verification.reviewPolicy": "risk" } },
    ]);

    expect(merged.config.agent.verification.reviewPolicy).toBe("always");
    expectWeakeningError(merged.issues, "agent.verification.reviewPolicy");
  });

  test("a project cannot raise the minimum independent-review risk threshold", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: { "agent.verification.independentReviewRiskThreshold": "R2" },
      },
      {
        source: "project",
        values: { "agent.verification.independentReviewRiskThreshold": "R5" },
      },
    ]);

    expect(merged.config.agent.verification.independentReviewRiskThreshold).toBe("R2");
    expectWeakeningError(
      merged.issues,
      "agent.verification.independentReviewRiskThreshold",
    );
  });

  test("a project may strengthen every review control", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "agent.reviewMode": "off",
          "agent.verification.reviewPolicy": "risk",
          "agent.verification.independentReviewRiskThreshold": "R5",
        },
      },
      {
        source: "project",
        values: {
          "agent.reviewMode": "auto",
          "agent.verification.reviewPolicy": "always",
          "agent.verification.independentReviewRiskThreshold": "R1",
        },
      },
    ]);

    expect(merged.config.agent.reviewMode).toBe("auto");
    expect(merged.config.agent.verification.reviewPolicy).toBe("always");
    expect(merged.config.agent.verification.independentReviewRiskThreshold).toBe("R1");
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("project-local config cannot weaken the effective project review floor", () => {
    const merged = mergeConfig([
      {
        source: "project",
        values: {
          "agent.reviewMode": "auto",
          "agent.verification.reviewPolicy": "always",
          "agent.verification.independentReviewRiskThreshold": "R1",
        },
      },
      {
        source: "project-local",
        values: {
          "agent.reviewMode": "off",
          "agent.verification.reviewPolicy": "risk",
          "agent.verification.independentReviewRiskThreshold": "R6",
        },
      },
    ]);

    expect(merged.config.agent.reviewMode).toBe("auto");
    expect(merged.config.agent.verification.reviewPolicy).toBe("always");
    expect(merged.config.agent.verification.independentReviewRiskThreshold).toBe("R1");
    expect(merged.issues.filter((issue) => issue.severity === "error")).toHaveLength(3);
    expectWeakeningError(merged.issues, "agent.reviewMode", "project-local");
    expectWeakeningError(
      merged.issues,
      "agent.verification.reviewPolicy",
      "project-local",
    );
    expectWeakeningError(
      merged.issues,
      "agent.verification.independentReviewRiskThreshold",
      "project-local",
    );
  });
});
