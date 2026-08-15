/**
 * Paired A/B orchestration for performance experiments.
 *
 * Runs are intentionally sequential: parallel suites would contaminate latency and
 * make an A/B comparison measure host contention. A caller can still configure
 * concurrency inside each suite when latency is not part of the experiment.
 */

import { createHash } from "node:crypto";

import { runSuite, type RunnerOptions, type SuiteResult } from "./runner.ts";
import {
  evaluateGate,
  summarize,
  type EvalProfile,
  type GateResult,
  type GateFinding,
  type SuiteSummary,
} from "./scoring.ts";
import { TARGET_TASK_COUNT, suiteCoverage, type BenchTask } from "./task.ts";
import {
  analyzePairedStatistics,
  type ComparisonTarget,
  type PairedComparisonStatistics,
} from "./statistics.ts";

export type PairedVariant = "baseline" | "candidate";
export type PairedOrderStrategy = "abba" | "seeded_randomized";
export type CacheTemperature = "cold" | "warm";

export type CapabilityValue =
  | string
  | number
  | boolean
  | null
  | readonly CapabilityValue[]
  | { readonly [key: string]: CapabilityValue };

/** The exact backend feature set under which the comparison was measured. */
export interface CapabilitySnapshot {
  readonly backend: string;
  readonly capturedAt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly capabilities: Readonly<Record<string, CapabilityValue>>;
  readonly metadata?: Readonly<Record<string, CapabilityValue>>;
}

export interface PairedProfiles {
  readonly baseline: EvalProfile;
  readonly candidate: EvalProfile;
}

export interface ThermalContext {
  readonly variant: PairedVariant;
  /** One-based occurrence of this variant. */
  readonly repetition: number;
  /** One-based position in the complete execution schedule. */
  readonly sequence: number;
}

export type ThermalPolicy =
  | "first_cold_then_warm"
  | "all_cold"
  | "all_warm"
  | ((context: ThermalContext) => CacheTemperature);

export interface PairedScheduleOptions {
  /** Number of executions per variant. */
  readonly repetitions: number;
  readonly order?: PairedOrderStrategy;
  /** Required for `seeded_randomized`; numbers and strings are stable across runtimes. */
  readonly seed?: number | string;
  readonly thermalPolicy?: ThermalPolicy;
}

export interface PairedRunDescriptor {
  /** One-based position in the complete execution schedule. */
  readonly sequence: number;
  readonly variant: PairedVariant;
  readonly profile: EvalProfile;
  /** One-based occurrence of this variant. */
  readonly repetition: number;
  readonly temperature: CacheTemperature;
  readonly order: PairedOrderStrategy;
  readonly seed?: string;
}

export type RunnerOptionsFactory = (
  run: PairedRunDescriptor,
) => RunnerOptions | Promise<RunnerOptions>;

export interface PairedRunnerOptions extends PairedScheduleOptions {
  readonly capabilitySnapshot: CapabilitySnapshot;
  /** Competitive threshold profile recorded with the statistical evidence. */
  readonly comparisonTarget?: ComparisonTarget;
  /** Deterministic stratified-bootstrap controls. */
  readonly bootstrapIterations?: number;
  readonly bootstrapSeed?: number | string;
  /** Require the complete benchmark category distribution. Defaults to true. */
  readonly requireCompleteCoverage?: boolean;
  /** Minimum executions per variant accepted by the gate. Defaults to 2. */
  readonly minimumRepetitions?: number;
  /** Thermal strata that must each contain both variants. Defaults to cold and warm. */
  readonly requiredTemperatures?: readonly CacheTemperature[];
  /** Require `RunnerOptions.appliedProfile` to exactly match each descriptor. */
  readonly requireAppliedProfile?: boolean;
  /**
   * A factory can apply the descriptor's cold/warm state to each run. A constant
   * runner is convenient when setup is already handled by `beforeRun`.
   */
  readonly runner: RunnerOptions | RunnerOptionsFactory;
  readonly beforeRun?: (run: PairedRunDescriptor) => void | Promise<void>;
  readonly afterRun?: (
    run: PairedRunDescriptor,
    result: SuiteResult,
  ) => void | Promise<void>;
  readonly onRunStarted?: (run: PairedRunDescriptor) => void;
  readonly onRunFinished?: (run: PairedRunDescriptor, result: SuiteResult) => void;
  readonly now?: () => number;
}

export interface PairedSuiteRun {
  readonly descriptor: PairedRunDescriptor;
  readonly result: SuiteResult;
  readonly profileApplied: boolean;
  readonly capabilityDigest: string;
}


export interface PairedTemperatureAggregate {
  readonly temperature: CacheTemperature;
  readonly baseline: SuiteSummary;
  readonly candidate: SuiteSummary;
  readonly gate: GateResult;
}
export interface PairedAggregate {
  readonly baseline: SuiteSummary;
  readonly candidate: SuiteSummary;
  readonly gate: GateResult;
  readonly strata: Readonly<Partial<Record<CacheTemperature, PairedTemperatureAggregate>>>;
  readonly statistics: PairedComparisonStatistics;
}

export interface PairedSuiteResult {
  readonly profiles: PairedProfiles;
  readonly repetitions: number;
  readonly order: PairedOrderStrategy;
  readonly seed?: string;
  readonly capabilitySnapshot: CapabilitySnapshot;
  /** Digest of the exact backend capability snapshot attached to this experiment. */
  readonly capabilityDigest: string;
  readonly schedule: readonly PairedRunDescriptor[];
  readonly runs: readonly PairedSuiteRun[];
  readonly aggregate: PairedAggregate;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** Build a balanced, deterministic execution schedule without running a suite. */
export function buildPairedSchedule(
  profiles: PairedProfiles,
  options: PairedScheduleOptions,
): PairedRunDescriptor[] {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new RangeError("paired repetitions must be a positive integer");
  }

  const order = options.order ?? "abba";
  if (order === "seeded_randomized" && options.seed === undefined) {
    throw new Error("seeded_randomized order requires an explicit seed");
  }

  const variants = order === "abba"
    ? abbaOrder(options.repetitions)
    : randomizedOrder(options.repetitions, options.seed!);
  const occurrences: Record<PairedVariant, number> = { baseline: 0, candidate: 0 };

  return variants.map((variant, index) => {
    const repetition = occurrences[variant] + 1;
    occurrences[variant] = repetition;
    const context: ThermalContext = { variant, repetition, sequence: index + 1 };
    const temperature = thermalState(options.thermalPolicy, context);
    return {
      sequence: context.sequence,
      variant,
      profile: variant === "baseline" ? profiles.baseline : profiles.candidate,
      repetition,
      temperature,
      order,
      ...(options.seed !== undefined ? { seed: String(options.seed) } : {}),
    };
  });
}

/**
 * Run a balanced A/B experiment and aggregate every repetition into one gate.
 *
 * `beforeRun` is the right place to clear caches for a `cold` descriptor or retain
 * them for a `warm` descriptor. The descriptor is also passed to a runner factory,
 * allowing backend-specific setup without introducing benchmark-only behavior into
 * the product.
 */
export async function runPairedSuite(
  tasks: readonly BenchTask[],
  profiles: PairedProfiles,
  options: PairedRunnerOptions,
): Promise<PairedSuiteResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const schedule = buildPairedSchedule(profiles, options);
  const capabilitySnapshot = cloneCapabilitySnapshot(options.capabilitySnapshot);
  const capabilityDigest = capabilitySnapshotDigest(capabilitySnapshot);
  const runs: PairedSuiteRun[] = [];

  for (const descriptor of schedule) {
    options.onRunStarted?.(descriptor);
    await options.beforeRun?.(descriptor);
    const runnerOptions = typeof options.runner === "function"
      ? await options.runner(descriptor)
      : options.runner;
    const profileApplied = runnerOptions.appliedProfile !== undefined &&
      canonicalValue(runnerOptions.appliedProfile) === canonicalValue(descriptor.profile);
    const result = await runSuite(tasks, descriptor.profile, runnerOptions);
    runs.push({ descriptor, result, profileApplied, capabilityDigest });
    await options.afterRun?.(descriptor, result);
    options.onRunFinished?.(descriptor, result);
  }

  const baseline = summarizeRuns(runs, profiles.baseline.id, "baseline");
  const candidate = summarizeRuns(runs, profiles.candidate.id, "candidate");
  const temperatures = new Set(schedule.map((descriptor) => descriptor.temperature));
  const strata: Partial<Record<CacheTemperature, PairedTemperatureAggregate>> = {};
  for (const temperature of temperatures) {
    const stratumBaseline = summarizeRuns(runs, profiles.baseline.id, "baseline", temperature);
    const stratumCandidate = summarizeRuns(runs, profiles.candidate.id, "candidate", temperature);
    strata[temperature] = {
      temperature,
      baseline: stratumBaseline,
      candidate: stratumCandidate,
      gate: evaluateGate(stratumCandidate, stratumBaseline),
    };
  }

  const baseGate = evaluateGate(candidate, baseline);
  const gate = mergeGateResults(baseGate, pairedEligibilityFindings({
    tasks,
    runs,
    options,
    capabilitySnapshot,
    capabilityDigest,
    strata,
  }));
  const statistics = analyzePairedStatistics(
    tasks.map((task) => ({ id: task.id, category: task.category, risks: task.risks })),
    runs.map((run) => ({
      variant: run.descriptor.variant,
      repetition: run.descriptor.repetition,
      temperature: run.descriptor.temperature,
      results: run.result.results.map((entry) => ({
        taskId: entry.task.id,
        metrics: entry.metrics,
        ...(entry.harnessError !== undefined ? { harnessError: entry.harnessError } : {}),
      })),
    })),
    {
      target: options.comparisonTarget ?? "capybara_baseline",
      ...(options.bootstrapIterations !== undefined
        ? { iterations: options.bootstrapIterations }
        : {}),
      seed:
        options.bootstrapSeed ??
        `${capabilityDigest}:${profiles.baseline.id}:${profiles.candidate.id}`,
    },
  );

  return {
    profiles,
    repetitions: options.repetitions,
    order: options.order ?? "abba",
    ...(options.seed !== undefined ? { seed: String(options.seed) } : {}),
    capabilitySnapshot,
    capabilityDigest,
    schedule,
    runs,
    aggregate: { baseline, candidate, gate, strata, statistics },
    startedAt,
    finishedAt: new Date(now()).toISOString(),
  };
}

function abbaOrder(repetitions: number): PairedVariant[] {
  const result: PairedVariant[] = [];
  const counts: Record<PairedVariant, number> = { baseline: 0, candidate: 0 };
  const block: readonly PairedVariant[] = ["baseline", "candidate", "candidate", "baseline"];
  while (counts.baseline < repetitions || counts.candidate < repetitions) {
    for (const variant of block) {
      if (counts[variant] >= repetitions) continue;
      result.push(variant);
      counts[variant] += 1;
    }
  }
  return result;
}

interface EligibilityInput {
  readonly tasks: readonly BenchTask[];
  readonly runs: readonly PairedSuiteRun[];
  readonly options: PairedRunnerOptions;
  readonly capabilitySnapshot: CapabilitySnapshot;
  readonly capabilityDigest: string;
  readonly strata: Readonly<Partial<Record<CacheTemperature, PairedTemperatureAggregate>>>;
}

function summarizeRuns(
  runs: readonly PairedSuiteRun[],
  profileId: string,
  variant: PairedVariant,
  temperature?: CacheTemperature,
): SuiteSummary {
  return summarize(
    profileId,
    runs
      .filter((run) =>
        run.descriptor.variant === variant &&
        (temperature === undefined || run.descriptor.temperature === temperature)
      )
      .flatMap((run) => run.result.results.map((entry) => entry.metrics)),
  );
}

function pairedEligibilityFindings(input: EligibilityInput): GateFinding[] {
  const findings: GateFinding[] = [];
  const block = (check: string, detail: string): void => {
    findings.push({ check, detail, severity: "blocking" });
  };
  const ok = (check: string, detail: string): void => {
    findings.push({ check, detail, severity: "ok" });
  };

  const coverage = suiteCoverage(input.tasks);
  if ((input.options.requireCompleteCoverage ?? true) && !coverage.meetsTarget) {
    block(
      "benchmark coverage",
      `${coverage.total} task(s) do not meet the complete ${TARGET_TASK_COUNT}-task category distribution`,
    );
  } else {
    ok("benchmark coverage", `${coverage.total} declared task(s)`);
  }

  const expectedTaskIds = [...new Set(input.tasks.map((task) => task.id))].sort();
  const duplicateTaskIds = input.tasks.length - expectedTaskIds.length;
  if (duplicateTaskIds > 0) {
    block("task identity", `${duplicateTaskIds} duplicate task id(s) make pairing ambiguous`);
  }

  const skipped = input.runs.flatMap((run) => run.result.skipped.map((entry) =>
    `${run.descriptor.variant}#${run.descriptor.repetition}:${entry.task}`
  ));
  if (skipped.length > 0) block("skipped tasks", `${skipped.length} task execution(s) were skipped`);
  else ok("skipped tasks", "no task execution was skipped");

  const harnessErrors = input.runs.flatMap((run) => run.result.results.flatMap((entry) =>
    entry.harnessError === undefined
      ? []
      : [`${run.descriptor.variant}#${run.descriptor.repetition}:${entry.task.id}`]
  ));
  if (harnessErrors.length > 0) {
    block("harness errors", `${harnessErrors.length} task execution(s) failed in the harness`);
  } else {
    ok("harness errors", "no harness execution failed");
  }

  let cohortMismatch = 0;
  for (const run of input.runs) {
    const actualTaskIds = run.result.results.map((entry) => entry.task.id).sort();
    if (canonicalValue(actualTaskIds) !== canonicalValue(expectedTaskIds)) cohortMismatch += 1;
  }
  if (cohortMismatch > 0) {
    block("paired cohort", `${cohortMismatch} run(s) did not measure the exact declared task cohort`);
  } else {
    ok("paired cohort", "all runs measured the same task ids");
  }

  const minimumRepetitions = input.options.minimumRepetitions ?? 2;
  const byVariant: Record<PairedVariant, number> = { baseline: 0, candidate: 0 };
  for (const run of input.runs) byVariant[run.descriptor.variant] += 1;
  if (byVariant.baseline !== byVariant.candidate || byVariant.baseline < minimumRepetitions) {
    block(
      "paired repetitions",
      `baseline=${byVariant.baseline}, candidate=${byVariant.candidate}, minimum=${minimumRepetitions}`,
    );
  } else {
    ok("paired repetitions", `${byVariant.baseline} balanced repetition(s) per variant`);
  }

  const requiredTemperatures = input.options.requiredTemperatures ?? ["cold", "warm"];
  for (const temperature of requiredTemperatures) {
    const stratum = input.strata[temperature];
    if (stratum === undefined || stratum.baseline.taskCount === 0 || stratum.candidate.taskCount === 0) {
      block("thermal strata", `${temperature} is missing one or both paired variants`);
      continue;
    }
    if (stratum.baseline.taskCount !== stratum.candidate.taskCount) {
      block(
        "thermal strata",
        `${temperature} is unbalanced (${stratum.baseline.taskCount} vs ${stratum.candidate.taskCount})`,
      );
    }
  }
  if (!findings.some((finding) => finding.check === "thermal strata" && finding.severity === "blocking")) {
    ok("thermal strata", `${requiredTemperatures.join(", ")} are paired and balanced`);
  }

  if ((input.options.requireAppliedProfile ?? true) && input.runs.some((run) => !run.profileApplied)) {
    block(
      "profile application",
      "one or more runners did not attest the exact auto-review, discovery, subagent, and cache profile",
    );
  } else {
    ok("profile application", "every runner attested the exact requested profile");
  }

  if (!validCapabilitySnapshot(input.capabilitySnapshot)) {
    block("capability snapshot", "backend, capturedAt, and at least one capability are required");
  } else {
    ok("capability snapshot", `digest ${input.capabilityDigest}`);
  }

  return findings;
}

function mergeGateResults(base: GateResult, eligibility: readonly GateFinding[]): GateResult {
  const findings = [...base.findings, ...eligibility];
  const blocked = findings.some((finding) => finding.severity === "blocking");
  const insufficient = base.status === "insufficient_baseline";
  const status: GateResult["status"] = blocked
    ? "failed"
    : insufficient
      ? "insufficient_baseline"
      : "passed";
  return {
    findings,
    status,
    pass: status === "passed",
    needsReason: findings.some((finding) => finding.severity === "needs_reason"),
  };
}

function validCapabilitySnapshot(snapshot: CapabilitySnapshot): boolean {
  return snapshot.backend.trim().length > 0 &&
    !Number.isNaN(Date.parse(snapshot.capturedAt)) &&
    Object.keys(snapshot.capabilities).length > 0;
}

export function capabilitySnapshotDigest(snapshot: CapabilitySnapshot): string {
  return `sha256:${createHash("sha256").update(canonicalValue(snapshot)).digest("hex")}`;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(record[key])}`
  ).join(",")}}`;
}
function randomizedOrder(repetitions: number, seed: number | string): PairedVariant[] {
  const result: PairedVariant[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    result.push("baseline", "candidate");
  }
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function thermalState(
  policy: ThermalPolicy | undefined,
  context: ThermalContext,
): CacheTemperature {
  if (typeof policy === "function") {
    const state = policy(context);
    if (state !== "cold" && state !== "warm") {
      throw new Error(`thermal policy returned invalid state '${String(state)}'`);
    }
    return state;
  }
  if (policy === "all_cold") return "cold";
  if (policy === "all_warm") return "warm";
  return context.repetition === 1 ? "cold" : "warm";
}

function seededRandom(seed: number | string): () => number {
  let state = typeof seed === "number" && Number.isFinite(seed)
    ? Math.trunc(seed) >>> 0
    : hashSeed(String(seed));
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cloneCapabilitySnapshot(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  return {
    ...snapshot,
    capabilities: { ...snapshot.capabilities },
    ...(snapshot.metadata !== undefined ? { metadata: { ...snapshot.metadata } } : {}),
  };
}
