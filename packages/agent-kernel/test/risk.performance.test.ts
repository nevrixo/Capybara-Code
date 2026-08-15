import { describe, expect, test } from "bun:test";

import {
  assessChangeRisk,
  riskLevelForPermissionThreshold,
} from "../src/risk.ts";

describe("deterministic completion risk", () => {
  test("keeps a small localized edit below the default review threshold", () => {
    const assessment = assessChangeRisk({
      files: [{ path: "src/format.ts", additions: 8, deletions: 2 }],
      workspaceMutated: true,
    });

    expect(assessment).toEqual({
      level: "low",
      score: 0,
      reasons: ["small, localized change with resolved paths"],
      reviewRequired: false,
    });
  });

  test("forces security-sensitive paths into high-risk review", () => {
    const assessment = assessChangeRisk({
      files: [{ path: "packages/permissions/src/policy.ts", additions: 4, deletions: 1 }],
      workspaceMutated: true,
    });

    expect(assessment.level).toBe("high");
    expect(assessment.score).toBeGreaterThanOrEqual(5);
    expect(assessment.reviewRequired).toBe(true);
    expect(assessment.reasons).toContain("security-sensitive path changed");
  });

  test("combines churn, compatibility, repair, and external effects deterministically", () => {
    const input = {
      files: [
        { path: "schemas/protocol/api.schema.json", additions: 420, deletions: 120 },
        { path: "src/transaction-lock.ts", additions: 20, deletions: 4 },
        { path: "package-lock.json", additions: 10, deletions: 10 },
      ],
      workspaceMutated: true,
      priorRepairCycles: 2,
      externalSideEffect: true,
    } as const;

    const first = assessChangeRisk(input);
    const second = assessChangeRisk(input);

    expect(first).toEqual(second);
    expect(first.level).toBe("critical");
    expect(first.reviewRequired).toBe(true);
    expect(first.reasons).toEqual(expect.arrayContaining([
      "change spans multiple files",
      "change exceeds 500 modified lines",
      "compatibility, persistence, or concurrency surface changed",
      "lockfile or generated dependency surface changed",
      "the turn already required a repair cycle",
      "the turn applied an external side effect",
    ]));
  });

  test("honors an explicitly stricter minimum review threshold", () => {
    const assessment = assessChangeRisk({
      files: [{ path: "auth/token.ts", additions: 1, deletions: 1 }],
      workspaceMutated: true,
      minimumReviewRisk: "critical",
    });

    expect(assessment.level).toBe("high");
    expect(assessment.reviewRequired).toBe(false);
  });

  test("maps permission thresholds onto completion-risk levels", () => {
    expect(riskLevelForPermissionThreshold("R0")).toBe("low");
    expect(riskLevelForPermissionThreshold("R2")).toBe("medium");
    expect(riskLevelForPermissionThreshold("R4")).toBe("high");
    expect(riskLevelForPermissionThreshold("R6")).toBe("critical");
  });
});
