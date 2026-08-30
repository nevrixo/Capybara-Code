import {
  CATEGORY_TARGETS,
  RISK_LABELS,
  TASK_CATEGORIES,
  analyzePairedStatistics,
  canonicalComparisonTarget,
  capabilitySnapshotDigest,
  evaluateStatisticalGate,
  summarize,
  type CapabilitySnapshot,
  type ComparisonTarget,
  type EvalProfile,
  type GateResult,
  type PairedComparisonStatistics,
  type RiskLabel,
  type RunMetrics,
  type StatisticalRun,
  type StatisticalTaskDefinition,
  type SuiteSummary,
  type TaskCategory,
} from "@cbc/evals";

import { parseExternalBenchmarkAdapter } from "./execution.ts";
import {
  repositoryEvidenceMatches,
  validateBenchmarkRepositoryEvidence,
  type BenchmarkRepositoryEvidence,
} from "./evidence.ts";
import {
  resolveExecutionProfile,
  type ResolvedExecutionProfile,
} from "./profile.ts";

/** Release-candidate evidence uses the plan's recommended full cohort, not the 80-task floor. */
export const RELEASE_MIN_TASKS = 150;
export const RELEASE_MIN_REPETITIONS = 5;

export interface ReleaseEvidenceInspection {
  readonly kind: "paired" | "legacy";
  readonly candidate?: SuiteSummary;
  readonly baseline?: SuiteSummary;
  readonly statistics?: PairedComparisonStatistics;
  readonly statisticalGate?: GateResult;
  readonly errors: readonly string[];
}

export interface ReleaseEvidenceOptions {
  readonly expectedRepositoryEvidence?: BenchmarkRepositoryEvidence;
}

/**
 * Validate the evidence around a score before applying numeric release thresholds.
 * A good-looking summary is not release evidence when tasks were skipped, the harness
 * failed, cohorts differ, or a single warm/cold run happened to be favourable.
 */
export function inspectReleaseEvidence(
  candidateArtifact: unknown,
  baselineArtifact?: unknown,
  options: ReleaseEvidenceOptions = {},
): ReleaseEvidenceInspection {
  if (isRecord(candidateArtifact) && Array.isArray(candidateArtifact.runs)) {
    return inspectPaired(candidateArtifact, baselineArtifact, options);
  }
  return inspectLegacy(candidateArtifact, baselineArtifact);
}

function inspectPaired(
  artifact: Record<string, unknown>,
  extraBaseline: unknown,
  options: ReleaseEvidenceOptions,
): ReleaseEvidenceInspection {
  const errors: string[] = [];
  if (extraBaseline !== undefined) {
    errors.push(
      "a paired artifact already contains baseline and candidate runs; do not supply --baseline",
    );
  }

  const comparisonTarget = comparisonTargetOf(artifact.comparisonTarget);
  if (comparisonTarget === undefined) {
    errors.push(
      "paired artifact comparisonTarget must be capybara_baseline, external_backbone_matched, or external_product_native",
    );
  }
  const repositoryValidation = validateBenchmarkRepositoryEvidence(artifact.repositoryEvidence);
  errors.push(...repositoryValidation.errors);
  const repositoryEvidence = repositoryValidation.evidence;
  if (repositoryEvidence !== undefined) {
    if (repositoryEvidence.sourceTruth.git.dirty) {
      errors.push("release evidence must be produced from a clean source-truth workspace");
    }
    if (repositoryEvidence.sourceTruth.git.commit === "unavailable") {
      errors.push("release evidence must record an exact Git commit");
    }
    if (
      options.expectedRepositoryEvidence !== undefined &&
      !repositoryEvidenceMatches(repositoryEvidence, options.expectedRepositoryEvidence)
    ) {
      errors.push("artifact repository evidence does not match the current canonical cohort and source truth");
    }
  }

  const aggregate = recordAt(artifact, "aggregate");
  const candidate = summaryAt(aggregate, "candidate");
  const baseline = summaryAt(aggregate, "baseline");
  if (candidate === undefined || baseline === undefined) {
    errors.push("paired artifact must contain aggregate.candidate and aggregate.baseline summaries");
  }

  const repetitions = integerAt(artifact, "repetitions");
  if (repetitions === undefined || repetitions < RELEASE_MIN_REPETITIONS) {
    errors.push(
      `paired experiment has ${repetitions ?? 0} repetition(s) per variant; release gate requires at least ${RELEASE_MIN_REPETITIONS}`,
    );
  }
  const order = artifact.order;
  if (order !== "abba" && order !== "seeded_randomized") {
    errors.push("paired experiment order must be 'abba' or 'seeded_randomized'");
  }

  const capabilityDigest = nonEmptyString(artifact.capabilityDigest);
  const capabilitySnapshot = capabilitySnapshotAt(artifact, "capabilitySnapshot");
  if (capabilityDigest === undefined || capabilitySnapshot === undefined) {
    errors.push("paired experiment is missing a valid capability snapshot or capability digest");
  } else {
    if (capabilitySnapshotDigest(capabilitySnapshot) !== capabilityDigest) {
      errors.push("capability digest does not match the attached backend capability snapshot");
    }
    if (capabilitySnapshot.backend !== "api") {
      errors.push("primary release evidence must use the API backend; account results are reported separately");
    }
    const metadata = capabilitySnapshot.metadata;
    if (metadata?.serviceTier !== "standard") {
      errors.push("primary release evidence must record serviceTier=standard");
    }
    if (
      repositoryEvidence !== undefined &&
      metadata?.repositoryEvidenceDigest !== repositoryEvidence.digest
    ) {
      errors.push("capability snapshot metadata is not bound to the artifact repository evidence");
    }
  }

  const executionEvidence = validateExecutionEvidence(
    artifact,
    comparisonTarget,
    capabilityDigest,
    errors,
  );

  const seenRuns = new Set<string>();
  const repetitionsByVariant = {
    baseline: new Set<number>(),
    candidate: new Set<number>(),
  };
  const temperatures = {
    cold: new Set<string>(),
    warm: new Set<string>(),
  };
  let cohort: readonly string[] | undefined;
  const runs = Array.isArray(artifact.runs) ? artifact.runs : [];

  for (const [index, value] of runs.entries()) {
    if (!isRecord(value)) {
      errors.push(`run ${index + 1} is not an object`);
      continue;
    }
    const descriptor = recordAt(value, "descriptor");
    const result = recordAt(value, "result");
    const variant = descriptor?.variant;
    const repetition = descriptor === undefined ? undefined : integerAt(descriptor, "repetition");
    const temperature = descriptor?.temperature;
    const label = `run ${index + 1}`;

    if ((variant !== "baseline" && variant !== "candidate") || repetition === undefined) {
      errors.push(`${label} has an invalid variant or repetition descriptor`);
      continue;
    }
    if (temperature !== "cold" && temperature !== "warm") {
      errors.push(`${label} has no valid cold/warm temperature label`);
    } else {
      temperatures[temperature].add(variant);
    }

    const key = `${variant}:${repetition}`;
    if (seenRuns.has(key)) errors.push(`paired experiment repeats descriptor ${key}`);
    seenRuns.add(key);
    repetitionsByVariant[variant].add(repetition);

    if (value.profileApplied !== true) {
      errors.push(`${label} does not prove that every requested profile axis was applied`);
    }
    const descriptorProfile = recordAt(descriptor, "profile");
    const resultProfile = result === undefined ? undefined : recordAt(result, "profile");
    if (
      nonEmptyString(descriptorProfile?.id) === undefined ||
      nonEmptyString(resultProfile?.id) !== nonEmptyString(descriptorProfile?.id)
    ) {
      errors.push(`${label} profile descriptor does not match the executed suite profile`);
    }
    const expectedProfile = variant === "baseline"
      ? executionEvidence?.baselineProfile
      : executionEvidence?.candidateProfile;
    if (
      expectedProfile !== undefined &&
      descriptorProfile !== undefined &&
      canonicalValue(descriptorProfile) !== canonicalValue(expectedProfile)
    ) {
      errors.push(`${label} profile descriptor differs from the bound execution evidence`);
    }

    if (result === undefined) {
      errors.push(`${label} has no suite result`);
      continue;
    }
    validateNoSkippedOrHarnessErrors(result, label, errors);
    const ids = cohortIds(result);
    if (ids.length < RELEASE_MIN_TASKS) {
      errors.push(
        `${label} contains ${ids.length} unique task(s); release gate requires ${RELEASE_MIN_TASKS}`,
      );
    }
    if (cohort === undefined) {
      cohort = ids;
    } else if (!sameStrings(cohort, ids)) {
      errors.push(`${label} uses a different task cohort from the other paired runs`);
    }

    const runCapability =
      nonEmptyString(value.capabilityDigest) ??
      nonEmptyString(recordAt(result, "capabilityEvidence")?.digest);
    if (runCapability === undefined) {
      errors.push(`${label} is missing its capability digest`);
    } else {
      const expectedRunCapability = variant === "baseline"
        ? executionEvidence?.baselineCapabilityDigest ?? capabilityDigest
        : capabilityDigest;
      if (expectedRunCapability !== undefined && runCapability !== expectedRunCapability) {
        errors.push(`${label} capability digest does not match its bound execution evidence`);
      }
    }
  }

  if (repositoryEvidence !== undefined && cohort !== undefined) {
    const manifestTaskIds = repositoryEvidence.cohort.tasks.map((task) => task.id).sort();
    if (!sameStrings(cohort, manifestTaskIds)) {
      errors.push("paired run cohort does not match the embedded canonical cohort manifest");
    }
  }

  for (const variant of ["baseline", "candidate"] as const) {
    const count = repetitionsByVariant[variant].size;
    if (count < RELEASE_MIN_REPETITIONS) {
      errors.push(
        `${variant} has ${count} distinct repetition(s); release gate requires at least ${RELEASE_MIN_REPETITIONS}`,
      );
    }
    if (repetitions !== undefined && count !== repetitions) {
      errors.push(`${variant} repetition evidence (${count}) does not match declared count (${repetitions})`);
    }
  }
  for (const temperature of ["cold", "warm"] as const) {
    if (!temperatures[temperature].has("baseline") || !temperatures[temperature].has("candidate")) {
      errors.push(`${temperature} stratum must contain both baseline and candidate runs`);
    }
  }

  const statisticalEvidence = recomputeStatisticalEvidence(
    artifact,
    comparisonTarget,
    errors,
  );

  return {
    kind: "paired",
    ...(statisticalEvidence?.candidate !== undefined
      ? { candidate: statisticalEvidence.candidate }
      : candidate !== undefined ? { candidate } : {}),
    ...(statisticalEvidence?.baseline !== undefined
      ? { baseline: statisticalEvidence.baseline }
      : baseline !== undefined ? { baseline } : {}),
    ...(statisticalEvidence !== undefined
      ? {
          statistics: statisticalEvidence.statistics,
          statisticalGate: evaluateStatisticalGate(statisticalEvidence.statistics),
        }
      : {}),
    errors,
  };
}

interface ValidatedExecutionEvidence {
  readonly baselineProfile: EvalProfile;
  readonly candidateProfile: EvalProfile;
  readonly baselineExecution?: ResolvedExecutionProfile;
  readonly candidateExecution: ResolvedExecutionProfile;
  readonly baselineCapabilityDigest?: string;
}

function validateExecutionEvidence(
  artifact: Record<string, unknown>,
  comparisonTarget: unknown,
  capabilityDigest: string | undefined,
  errors: string[],
): ValidatedExecutionEvidence | undefined {
  const profiles = recordAt(artifact, "profiles");
  const baselineProfile = evalProfileAt(profiles, "baseline");
  const candidateProfile = evalProfileAt(profiles, "candidate");
  if (baselineProfile === undefined || candidateProfile === undefined) {
    errors.push("paired artifact must contain complete baseline and candidate profiles");
    return undefined;
  }
  const target = comparisonTargetOf(comparisonTarget);
  const canonicalTarget = target === undefined ? undefined : canonicalComparisonTarget(target);
  if (
    canonicalTarget !== "external_product_native" &&
    !sameBaselineLockContract(baselineProfile, candidateProfile)
  ) {
    errors.push("baseline and candidate violate the same-model Baseline Lock Contract");
  }

  const execution = recordAt(artifact, "executionEvidence");
  const baselineEvidence = recordAt(execution, "baseline");
  const candidateEvidence = recordAt(execution, "candidate");
  if (execution === undefined || baselineEvidence === undefined || candidateEvidence === undefined) {
    errors.push("paired artifact is missing baseline/candidate executionEvidence");
    return undefined;
  }

  let candidateExecution: ResolvedExecutionProfile;
  try {
    candidateExecution = resolveExecutionProfile(candidateProfile, {
      performanceVariant: "optimized",
      serviceTier: "standard",
    });
  } catch (error) {
    errors.push(`candidate execution profile is unsupported: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (candidateEvidence.kind !== "cbc") {
    errors.push("candidate executionEvidence must be a CBC execution profile");
  } else if (canonicalValue(candidateEvidence.profile) !== canonicalValue(candidateExecution)) {
    errors.push("candidate executionEvidence does not match the optimized Standard product configuration");
  }

  let baselineExecution: ResolvedExecutionProfile | undefined;
  let baselineCapabilityDigest: string | undefined;
  if (canonicalTarget === "capybara_baseline") {
    try {
      baselineExecution = resolveExecutionProfile(baselineProfile, {
        performanceVariant: "legacy",
        serviceTier: "standard",
      });
    } catch (error) {
      errors.push(`baseline execution profile is unsupported: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if (baselineEvidence.kind !== "cbc") {
      errors.push("capybara_baseline executionEvidence must use a CBC baseline");
    } else if (canonicalValue(baselineEvidence.profile) !== canonicalValue(baselineExecution)) {
      errors.push("baseline executionEvidence does not match the legacy Standard product configuration");
    }
    baselineCapabilityDigest = capabilityDigest;
  } else if (
    canonicalTarget === "external_backbone_matched" ||
    canonicalTarget === "external_product_native"
  ) {
    if (baselineEvidence.kind !== "external" || !isRecord(baselineEvidence.adapter)) {
      errors.push(`${canonicalTarget} executionEvidence must contain an external adapter manifest`);
    } else if (capabilityDigest === undefined) {
      errors.push(`${canonicalTarget} adapter cannot be validated without a capability digest`);
    } else {
      try {
        const adapter = parseExternalBenchmarkAdapter(
          baselineEvidence.adapter,
          baselineProfile,
          capabilityDigest,
          {
            mode: canonicalTarget === "external_product_native"
              ? "product_native"
              : "backbone_matched",
            ...(target === "codex_matched" ? { allowLegacyIdentity: true } : {}),
          },
        );
        baselineCapabilityDigest = adapter.capabilityDigest;
      } catch (error) {
        errors.push(`external adapter evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    baselineProfile,
    candidateProfile,
    ...(baselineExecution !== undefined ? { baselineExecution } : {}),
    candidateExecution,
    ...(baselineCapabilityDigest !== undefined ? { baselineCapabilityDigest } : {}),
  };
}

function sameBaselineLockContract(left: EvalProfile, right: EvalProfile): boolean {
  return canonicalValue({
    model: left.model,
    reasoningMode: left.reasoningMode,
    reasoningEffort: left.reasoningEffort,
    autoReview: left.autoReview,
    toolDiscovery: left.toolDiscovery,
    subagents: left.subagents,
    promptCache: left.promptCache,
  }) === canonicalValue({
    model: right.model,
    reasoningMode: right.reasoningMode,
    reasoningEffort: right.reasoningEffort,
    autoReview: right.autoReview,
    toolDiscovery: right.toolDiscovery,
    subagents: right.subagents,
    promptCache: right.promptCache,
  });
}

function evalProfileAt(
  parent: Record<string, unknown> | undefined,
  key: string,
): EvalProfile | undefined {
  const value = recordAt(parent, key);
  if (
    value === undefined ||
    nonEmptyString(value.id) === undefined ||
    typeof value.description !== "string" ||
    nonEmptyString(value.model) === undefined ||
    (value.reasoningMode !== "standard" && value.reasoningMode !== "pro") ||
    !["none", "low", "medium", "high", "xhigh", "max"].includes(String(value.reasoningEffort)) ||
    typeof value.autoReview !== "boolean" ||
    typeof value.toolDiscovery !== "boolean" ||
    typeof value.subagents !== "boolean" ||
    !["off", "prefix", "aggressive"].includes(String(value.promptCache))
  ) {
    return undefined;
  }
  return value as unknown as EvalProfile;
}

interface RecomputedStatisticalEvidence {
  readonly statistics: PairedComparisonStatistics;
  readonly baseline: SuiteSummary;
  readonly candidate: SuiteSummary;
}

/**
 * Rebuild task-level paired statistics from raw run metrics and compare them with the
 * persisted aggregate. A caller cannot edit a favourable CI into the artifact and pass.
 */
function recomputeStatisticalEvidence(
  artifact: Record<string, unknown>,
  expectedTarget: unknown,
  errors: string[],
): RecomputedStatisticalEvidence | undefined {
  const aggregate = recordAt(artifact, "aggregate");
  const stored = recordAt(aggregate, "statistics");
  if (stored === undefined) {
    errors.push("paired artifact is missing aggregate.statistics");
    return undefined;
  }
  const target = comparisonTargetOf(stored.target);
  if (target === undefined) {
    errors.push(
      "aggregate.statistics.target must be capybara_baseline, external_backbone_matched, or external_product_native",
    );
    return undefined;
  }
  if (expectedTarget !== target) {
    errors.push("paired artifact comparisonTarget does not match aggregate.statistics.target");
  }
  const qualityInterval = recordAt(stored, "qualityDifferencePoints");
  const iterations = qualityInterval === undefined ? undefined : integerAt(qualityInterval, "iterations");
  const seed = qualityInterval === undefined ? undefined : nonEmptyString(qualityInterval.seed);
  if (
    iterations === undefined ||
    iterations < 100 ||
    iterations > 100_000 ||
    seed === undefined
  ) {
    errors.push("aggregate.statistics must record a valid bootstrap seed and iteration count");
    return undefined;
  }
  const profiles = recordAt(artifact, "profiles");
  const baselineProfile = evalProfileAt(profiles, "baseline");
  const candidateProfile = evalProfileAt(profiles, "candidate");
  if (baselineProfile === undefined || candidateProfile === undefined) {
    errors.push("paired artifact must contain complete baseline and candidate profiles");
    return undefined;
  }

  const taskDefinitions = new Map<string, StatisticalTaskDefinition>();
  const taskOrder: string[] = [];
  const runs: StatisticalRun[] = [];
  let malformed = false;
  const rawRuns = Array.isArray(artifact.runs) ? artifact.runs : [];
  for (const [runIndex, rawRun] of rawRuns.entries()) {
    if (!isRecord(rawRun)) {
      malformed = true;
      continue;
    }
    const descriptor = recordAt(rawRun, "descriptor");
    const result = recordAt(rawRun, "result");
    const variant = descriptor?.variant;
    const repetition = descriptor === undefined ? undefined : integerAt(descriptor, "repetition");
    const temperature = descriptor?.temperature;
    if (
      (variant !== "baseline" && variant !== "candidate") ||
      repetition === undefined ||
      (temperature !== "cold" && temperature !== "warm") ||
      result === undefined ||
      !Array.isArray(result.results)
    ) {
      errors.push(`run ${runIndex + 1} cannot be used to recompute paired statistics`);
      malformed = true;
      continue;
    }

    const parsedResults: StatisticalRun["results"][number][] = [];
    for (const [resultIndex, rawResult] of result.results.entries()) {
      if (!isRecord(rawResult)) {
        errors.push(`run ${runIndex + 1} result ${resultIndex + 1} is not an object`);
        malformed = true;
        continue;
      }
      const task = recordAt(rawResult, "task");
      const taskId = nonEmptyString(task?.id) ?? nonEmptyString(rawResult.taskId);
      const category = taskCategory(task?.category);
      const risks = riskLabels(task?.risks);
      const metrics = runMetricsAt(rawResult, "metrics");
      if (taskId === undefined || category === undefined || risks === undefined || metrics === undefined) {
        errors.push(`run ${runIndex + 1} result ${resultIndex + 1} lacks valid task metadata or metrics`);
        malformed = true;
        continue;
      }
      const definition = { id: taskId, category, risks } satisfies StatisticalTaskDefinition;
      const previous = taskDefinitions.get(taskId);
      if (previous === undefined) taskOrder.push(taskId);
      if (previous !== undefined && canonicalValue(previous) !== canonicalValue(definition)) {
        errors.push(`task ${taskId} changes category or risk metadata between repetitions`);
        malformed = true;
        continue;
      }
      taskDefinitions.set(taskId, definition);
      parsedResults.push({
        taskId,
        metrics,
        ...(nonEmptyString(rawResult.harnessError) !== undefined
          ? { harnessError: nonEmptyString(rawResult.harnessError) as string }
          : {}),
      });
    }
    runs.push({ variant, repetition, temperature, results: parsedResults });
  }

  if (malformed || taskDefinitions.size === 0) return undefined;
  const categoryCounts = Object.fromEntries(
    TASK_CATEGORIES.map((category) => [category, 0]),
  ) as Record<TaskCategory, number>;
  for (const task of taskDefinitions.values()) categoryCounts[task.category] += 1;
  for (const category of TASK_CATEGORIES) {
    if (categoryCounts[category] !== CATEGORY_TARGETS[category]) {
      errors.push(
        `release cohort category ${category} has ${categoryCounts[category]} task(s); ` +
          `requires ${CATEGORY_TARGETS[category]}`,
      );
    }
  }
  const statistics = analyzePairedStatistics(
    taskOrder.map((taskId) => taskDefinitions.get(taskId)!),
    runs,
    { target: target as ComparisonTarget, iterations, seed },
  );
  if (canonicalValue(stored) !== canonicalValue(statistics)) {
    errors.push("aggregate.statistics does not match statistics recomputed from raw paired runs");
  }
  const baseline = summarize(
    baselineProfile.id,
    runs
      .filter((run) => run.variant === "baseline")
      .flatMap((run) => run.results.map((result) => result.metrics)),
  );
  const candidate = summarize(
    candidateProfile.id,
    runs
      .filter((run) => run.variant === "candidate")
      .flatMap((run) => run.results.map((result) => result.metrics)),
  );
  const storedBaseline = summaryAt(aggregate, "baseline");
  const storedCandidate = summaryAt(aggregate, "candidate");
  if (storedBaseline === undefined || canonicalValue(storedBaseline) !== canonicalValue(baseline)) {
    errors.push("aggregate.baseline does not match the summary recomputed from raw paired runs");
  }
  if (storedCandidate === undefined || canonicalValue(storedCandidate) !== canonicalValue(candidate)) {
    errors.push("aggregate.candidate does not match the summary recomputed from raw paired runs");
  }
  return { statistics, baseline, candidate };
}

function runMetricsAt(parent: Record<string, unknown>, key: string): RunMetrics | undefined {
  const metrics = recordAt(parent, key);
  const outcome = recordAt(metrics, "outcome");
  const behavior = recordAt(metrics, "behavior");
  const cost = recordAt(metrics, "cost");
  const ux = recordAt(metrics, "ux");
  if (
    metrics === undefined ||
    outcome === undefined ||
    behavior === undefined ||
    cost === undefined ||
    ux === undefined ||
    typeof outcome.hiddenTestsPassed !== "boolean" ||
    typeof outcome.statusMatched !== "boolean" ||
    typeof outcome.scopePrecision !== "number" ||
    !Number.isFinite(outcome.scopePrecision) ||
    !finiteNonNegative(outcome.regressions) ||
    !["completed", "partial", "failed", "cancelled"].includes(String(outcome.status)) ||
    (outcome.expectedStatus !== undefined &&
      outcome.expectedStatus !== "completed" &&
      outcome.expectedStatus !== "partial") ||
    !finiteNonNegative(behavior.schemaErrors) ||
    !stringArray(behavior.missingApprovals) ||
    !stringArray(behavior.unexpectedApprovals) ||
    !finiteNonNegative(behavior.selfCorrections) ||
    !finiteNonNegative(behavior.abandonedCorrections) ||
    !finiteNonNegative(cost.totalWallTimeMs) ||
    !finiteNonNegative(cost.estimatedCostUsd) ||
    !finiteNonNegative(cost.fullPayloadBytes) ||
    !finiteNonNegative(cost.incrementalPayloadBytes) ||
    !finiteNonNegative(cost.providerRequests) ||
    !finiteNonNegative(cost.preProviderLocalMs) ||
    !finiteNonNegative(cost.cacheHitRate) ||
    !finiteNonNegative(ux.invisibleSideEffects) ||
    !finiteNonNegative(ux.reportCompleteness) ||
    !stringArray(ux.unsupportedClaims) ||
    !stringArray(ux.missingReportMentions) ||
    !stringArray(ux.missingRiskMentions)
  ) {
    return undefined;
  }
  return metrics as unknown as RunMetrics;
}

function taskCategory(value: unknown): TaskCategory | undefined {
  return typeof value === "string" && TASK_CATEGORIES.includes(value as TaskCategory)
    ? value as TaskCategory
    : undefined;
}

function comparisonTargetOf(value: unknown): ComparisonTarget | undefined {
  if (
    value === "capybara_baseline" ||
    value === "external_backbone_matched" ||
    value === "external_product_native" ||
    // Deprecated artifact compatibility only. New CLI runs canonicalize it.
    value === "codex_matched"
  ) {
    return value;
  }
  return undefined;
}

function riskLabels(value: unknown): readonly RiskLabel[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) =>
    typeof entry === "string" && RISK_LABELS.includes(entry as RiskLabel)
  )) {
    return undefined;
  }
  return value as RiskLabel[];
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(record[key])}`
  ).join(",")}}`;
}

function inspectLegacy(candidateArtifact: unknown, baselineArtifact: unknown): ReleaseEvidenceInspection {
  const errors: string[] = [
    "release gate requires a paired result artifact with balanced ABBA/seeded runs; a single-suite summary is development evidence only",
  ];
  const candidateRecord = isRecord(candidateArtifact) ? candidateArtifact : undefined;
  const baselineRecord = isRecord(baselineArtifact) ? baselineArtifact : undefined;
  const candidate = summaryAt(candidateRecord, "summary");
  const baseline = summaryAt(baselineRecord, "summary");

  if (candidateRecord === undefined || candidate === undefined) {
    errors.push("candidate artifact has no valid summary");
  } else {
    validateNoSkippedOrHarnessErrors(candidateRecord, "candidate", errors);
    validateCohort(candidateRecord, "candidate", errors);
  }
  if (baselineRecord === undefined || baseline === undefined) {
    errors.push("baseline artifact is required and must contain a valid summary");
  } else {
    validateNoSkippedOrHarnessErrors(baselineRecord, "baseline", errors);
    validateCohort(baselineRecord, "baseline", errors);
  }

  if (candidateRecord !== undefined && baselineRecord !== undefined) {
    const candidateIds = cohortIds(candidateRecord);
    const baselineIds = cohortIds(baselineRecord);
    if (!sameStrings(candidateIds, baselineIds)) {
      errors.push("candidate and baseline use different task cohorts");
    }
    const candidateCapability = capabilityDigestOf(candidateRecord);
    const baselineCapability = capabilityDigestOf(baselineRecord);
    if (candidateCapability === undefined || baselineCapability === undefined) {
      errors.push("candidate and baseline must both record capability evidence");
    } else if (candidateCapability !== baselineCapability) {
      errors.push("candidate and baseline capability digests do not match");
    }
  }

  return {
    kind: "legacy",
    ...(candidate !== undefined ? { candidate } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    errors,
  };
}

function validateCohort(
  artifact: Record<string, unknown>,
  label: string,
  errors: string[],
): void {
  const ids = cohortIds(artifact);
  if (ids.length < RELEASE_MIN_TASKS) {
    errors.push(`${label} contains ${ids.length} unique task(s); release gate requires ${RELEASE_MIN_TASKS}`);
  }
}

function validateNoSkippedOrHarnessErrors(
  artifact: Record<string, unknown>,
  label: string,
  errors: string[],
): void {
  const skipped = Array.isArray(artifact.skipped) ? artifact.skipped.length : 0;
  if (skipped > 0) errors.push(`${label} contains ${skipped} skipped task(s)`);
  const results = Array.isArray(artifact.results) ? artifact.results : [];
  const harnessErrors = results.filter(
    (entry) => isRecord(entry) && nonEmptyString(entry.harnessError) !== undefined,
  ).length;
  if (harnessErrors > 0) errors.push(`${label} contains ${harnessErrors} harness error(s)`);
}

function cohortIds(artifact: Record<string, unknown>): string[] {
  const results = Array.isArray(artifact.results) ? artifact.results : [];
  const ids = new Set<string>();
  for (const value of results) {
    if (!isRecord(value)) continue;
    const taskId = nonEmptyString(value.taskId) ?? nonEmptyString(recordAt(value, "task")?.id);
    if (taskId !== undefined) ids.add(taskId);
  }
  return [...ids].sort();
}

function capabilityDigestOf(artifact: Record<string, unknown>): string | undefined {
  return (
    nonEmptyString(recordAt(artifact, "capabilityEvidence")?.digest) ??
    nonEmptyString(artifact.capabilityDigest)
  );
}

const SUMMARY_NUMBER_FIELDS = [
  "taskCount",
  "succeeded",
  "successRate",
  "regressions",
  "medianCostUsd",
  "totalCostUsd",
  "p50WallTimeMs",
  "p95WallTimeMs",
  "meanScopePrecision",
  "schemaErrors",
  "missedApprovals",
  "invisibleSideEffects",
  "unsupportedClaims",
  "meanCacheHitRate",
  "meanReportCompleteness",
  "missingEvidence",
  "statusMismatches",
  "unexpectedApprovals",
  "selfCorrectionRate",
  "runsWithSelfCorrection",
  "selfCorrections",
  "abandonedCorrections",
] as const;

function summaryAt(
  parent: Record<string, unknown> | undefined,
  key: string,
): SuiteSummary | undefined {
  if (parent === undefined) return undefined;
  const value = parent[key];
  if (!isRecord(value) || nonEmptyString(value.profile) === undefined) return undefined;
  if (
    SUMMARY_NUMBER_FIELDS.some(
      (field) => typeof value[field] !== "number" || !Number.isFinite(value[field]),
    )
  ) {
    return undefined;
  }
  if (
    !Number.isInteger(value.taskCount) ||
    !Number.isInteger(value.succeeded) ||
    (value.taskCount as number) < 0 ||
    (value.succeeded as number) < 0 ||
    (value.succeeded as number) > (value.taskCount as number) ||
    (value.successRate as number) < 0 ||
    (value.successRate as number) > 1
  ) {
    return undefined;
  }
  return value as unknown as SuiteSummary;
}

function capabilitySnapshotAt(
  parent: Record<string, unknown>,
  key: string,
): CapabilitySnapshot | undefined {
  const value = recordAt(parent, key);
  if (value === undefined) return undefined;
  if (nonEmptyString(value.backend) === undefined) return undefined;
  if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) {
    return undefined;
  }
  if (value.provider !== undefined && typeof value.provider !== "string") return undefined;
  if (value.model !== undefined && typeof value.model !== "string") return undefined;
  const capabilities = recordAt(value, "capabilities");
  if (
    capabilities === undefined ||
    Object.keys(capabilities).length === 0 ||
    !Object.values(capabilities).every(isCapabilityValue)
  ) {
    return undefined;
  }
  const metadata = value.metadata;
  if (metadata !== undefined) {
    if (!isRecord(metadata) || !Object.values(metadata).every(isCapabilityValue)) return undefined;
  }
  return value as unknown as CapabilitySnapshot;
}

function isCapabilityValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCapabilityValue);
  return isRecord(value) && Object.values(value).every(isCapabilityValue);
}

function recordAt(
  parent: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (parent === undefined) return undefined;
  const value = parent[key];
  return isRecord(value) ? value : undefined;
}

function integerAt(parent: Record<string, unknown>, key: string): number | undefined {
  const value = parent[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
