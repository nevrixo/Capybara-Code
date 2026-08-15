export type ChangeRiskLevel = "low" | "medium" | "high" | "critical";
export type ReviewPolicy = "always" | "risk";

export interface ChangedFileRiskInput {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly purpose?: string;
}

export interface ChangeRiskInput {
  readonly files: readonly ChangedFileRiskInput[];
  readonly workspaceMutated: boolean;
  readonly priorRepairCycles?: number;
  readonly externalSideEffect?: boolean;
  readonly minimumReviewRisk?: ChangeRiskLevel;
}

export interface ChangeRiskAssessment {
  readonly level: ChangeRiskLevel;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly reviewRequired: boolean;
}

const RISK_RANK: Readonly<Record<ChangeRiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Deterministic, provider-neutral change risk. It deliberately uses only facts
 * available at the completion boundary so the same patch receives the same
 * review decision regardless of model prose.
 */
export function assessChangeRisk(input: ChangeRiskInput): ChangeRiskAssessment {
  let score = 0;
  const reasons: string[] = [];
  const churn = input.files.reduce(
    (total, file) => total + Math.max(0, file.additions) + Math.max(0, file.deletions),
    0,
  );
  const paths = input.files.map((file) => file.path.toLowerCase());

  if (input.workspaceMutated && input.files.length === 0) {
    score += 4;
    reasons.push("workspace mutation has unresolved changed paths");
  }
  if (input.files.length >= 8) {
    score += 2;
    reasons.push("change spans at least eight files");
  } else if (input.files.length >= 3) {
    score += 1;
    reasons.push("change spans multiple files");
  }
  if (churn >= 500) {
    score += 3;
    reasons.push("change exceeds 500 modified lines");
  } else if (churn >= 120) {
    score += 1;
    reasons.push("change exceeds 120 modified lines");
  }

  const sensitive = paths.some((path) =>
    /(?:^|[\\/._-])(?:auth|credential|secret|permission|policy|sandbox|security|crypto)(?:[\\/._-]|$)/u.test(path)
  );
  if (sensitive) {
    score = Math.max(score, 5);
    reasons.push("security-sensitive path changed");
  }
  if (paths.some((path) => /(?:migration|schema|protocol|api|transaction|concurren|lock)/u.test(path))) {
    score += 2;
    reasons.push("compatibility, persistence, or concurrency surface changed");
  }
  if (paths.some((path) => /(?:package-lock|pnpm-lock|yarn\.lock|cargo\.lock|generated|vendor)/u.test(path))) {
    score += 1;
    reasons.push("lockfile or generated dependency surface changed");
  }
  if ((input.priorRepairCycles ?? 0) > 0) {
    score += Math.min(2, input.priorRepairCycles ?? 0);
    reasons.push("the turn already required a repair cycle");
  }
  if (input.externalSideEffect === true) {
    score += 2;
    reasons.push("the turn applied an external side effect");
  }
  if (reasons.length === 0) reasons.push("small, localized change with resolved paths");

  const level: ChangeRiskLevel =
    score >= 8 ? "critical" : score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  const minimum = input.minimumReviewRisk ?? "medium";
  return {
    level,
    score,
    reasons,
    reviewRequired: RISK_RANK[level] >= RISK_RANK[minimum],
  };
}

export function riskLevelForPermissionThreshold(
  threshold: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6",
): ChangeRiskLevel {
  if (threshold === "R6") return "critical";
  if (threshold === "R4" || threshold === "R5") return "high";
  if (threshold === "R2" || threshold === "R3") return "medium";
  return "low";
}
