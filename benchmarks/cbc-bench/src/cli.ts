#!/usr/bin/env bun
/**
 * `cbc-bench` — CBC Bench harness (PRD §26 and the harness-latency program).
 *
 * The CLI deliberately separates measurement from release evidence:
 *
 * - `run` executes one faithfully applied product profile.
 * - `paired` executes balanced, sequential A/B repetitions with cold/warm strata.
 * - `gate` accepts only complete release evidence and then evaluates quality thresholds.
 */

import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  EVAL_PROFILES,
  capabilitySnapshotDigest,
  evaluateStatisticalGate,
  profileById,
  renderCoverage,
  renderGate,
  renderPairedStatistics,
  renderSuiteResult,
  renderSummary,
  runPairedSuite,
  runSuite,
  suiteCoverage,
  validateTask,
  type CapabilitySnapshot,
  type ComparisonTarget,
  type EvalProfile,
  type PairedOrderStrategy,
  type PairedSuiteResult,
  type SuiteResult,
} from "@cbc/evals";

import {
  createBenchmarkEnvironment,
  createBenchmarkRunner,
  createExternalBenchmarkRunner,
  disposeBenchmarkEnvironment,
  parseExternalBenchmarkAdapter,
  probeBenchmarkRuntimeCapabilities,
  resetBenchmarkEnvironment,
  benchmarkRuntimeCompatibilityIssues,
  type ExternalBenchmarkAdapter,
} from "./execution.ts";
import {
  loadBenchmarkRepositoryEvidence,
  type BenchmarkRepositoryEvidence,
} from "./evidence.ts";
import {
  resolveExecutionProfile,
  UnsupportedProfileError,
  type BenchmarkServiceTier,
  type ExecutionProfileOptions,
  type PerformanceVariant,
  type ResolvedExecutionProfile,
} from "./profile.ts";
import {
  COHORT_MANIFEST_PATH,
  buildCohortManifest,
  checkCohortManifest,
  validateCohortManifestShape,
} from "./cohort-manifest.ts";
import { generatedSnapshotManifest } from "./generated-fixtures.ts";
import { inspectReleaseEvidence } from "./release-gate.ts";
import { evaluatePerformanceHealthArtifact } from "./rollback.ts";
import { SUITE, selectTasks } from "./suite.ts";

const ROOT = new URL("../../..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/u, "$1")
  .replace(/\/+$/u, "");
const BENCH = `${ROOT}/benchmarks/cbc-bench`;

interface Flags {
  readonly profile: string;
  readonly variant: string;
  readonly baselineProfile?: string;
  readonly candidateProfile?: string;
  readonly baselineVariant?: string;
  readonly candidateVariant?: string;
  readonly serviceTier: string;
  readonly filter: string;
  readonly out?: string;
  readonly candidate?: string;
  readonly baseline?: string;
  readonly baselineAdapter?: string;
  readonly capabilitySnapshot?: string;
  readonly health?: string;
  readonly repetitions: number;
  readonly comparison: string;
  readonly order: string;
  readonly seed?: string;
  readonly concurrency: number;
  readonly keepWorkspaces: boolean;
}

interface ResolvedProfile {
  readonly profile: EvalProfile;
  readonly execution: ResolvedExecutionProfile;
}

function parseFlags(argv: readonly string[]): Flags {
  const map = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals !== -1) {
      map.set(token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      map.set(token, next);
      index += 1;
    } else {
      map.set(token, true);
    }
  }

  const text = (key: string): string | undefined => {
    const value = map.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const numeric = (key: string, fallback: number): number => {
    const value = text(key);
    return value === undefined ? fallback : Number(value);
  };

  return {
    profile: text("--profile") ?? "standard-medium",
    variant: text("--variant") ?? "optimized",
    ...(text("--baseline-profile") !== undefined
      ? { baselineProfile: text("--baseline-profile") as string }
      : {}),
    ...(text("--candidate-profile") !== undefined
      ? { candidateProfile: text("--candidate-profile") as string }
      : {}),
    ...(text("--baseline-variant") !== undefined
      ? { baselineVariant: text("--baseline-variant") as string }
      : {}),
    ...(text("--candidate-variant") !== undefined
      ? { candidateVariant: text("--candidate-variant") as string }
      : {}),
    serviceTier: text("--service-tier") ?? "standard",
    filter: text("--filter") ?? "all",
    ...(text("--out") !== undefined ? { out: text("--out") as string } : {}),
    ...(text("--candidate") !== undefined ? { candidate: text("--candidate") as string } : {}),
    ...(text("--baseline") !== undefined ? { baseline: text("--baseline") as string } : {}),
    ...(text("--baseline-adapter") !== undefined
      ? { baselineAdapter: text("--baseline-adapter") as string }
      : {}),
    ...(text("--capability-snapshot") !== undefined
      ? { capabilitySnapshot: text("--capability-snapshot") as string }
      : {}),
    ...(text("--health") !== undefined ? { health: text("--health") as string } : {}),
    repetitions: numeric("--repetitions", 5),
    comparison: text("--comparison") ?? "capybara_baseline",
    order: text("--order") ?? "abba",
    ...(text("--seed") !== undefined ? { seed: text("--seed") as string } : {}),
    concurrency: numeric("--concurrency", 1),
    keepWorkspaces: map.has("--keep-workspaces"),
  };
}

const parsePerformanceVariant = (
  value: string,
  flag: string,
): PerformanceVariant | undefined => {
  if (value === "legacy" || value === "optimized") return value;
  console.error(`${flag} must be 'legacy' or 'optimized'`);
  return undefined;
};

const parseBenchmarkServiceTier = (
  value: string,
): BenchmarkServiceTier | undefined => {
  if (value === "standard" || value === "fast") return value;
  console.error("--service-tier must be 'standard' or 'fast'");
  return undefined;
};

const USAGE = `cbc-bench — CBC Bench harness

Commands
  coverage                     report category and language coverage
  validate                     validate every task fixture and checked-in cohort manifest
  manifest                     write the canonical 150-task cohort manifest
  profiles                     list comparison profiles and whether they are wired
  run                          execute one faithfully applied profile
  paired                       run balanced baseline/candidate repetitions
  gate                         validate release evidence, then evaluate thresholds

Common flags
  --profile <id>               model/reasoning/review profile (default: standard-medium)
  --variant <id>               legacy or optimized (run/candidate default: optimized)
  --service-tier <id>          standard or fast (default: standard)
  --filter <id|category|lang>  narrow the suite (default: all)
  --out <path>                 result artifact path
  --concurrency <n>            tasks per suite (default 1; >1 distorts latency)
  --keep-workspaces            leave copied task workspaces on disk

Paired flags
  --baseline-profile <id>      baseline model profile (default: --profile)
  --candidate-profile <id>     candidate model profile (default: --profile)
  --baseline-variant <id>      CBC baseline variant (default: legacy)
  --candidate-variant <id>     CBC candidate variant (default: --variant)
  --repetitions <n>            executions per variant (default: 5)
  --comparison <target>        capybara_baseline or codex_matched
  --baseline-adapter <path>    neutral external adapter manifest for codex_matched
  --order <strategy>           abba or seeded_randomized (default: abba)
  --seed <value>               required for seeded_randomized
  --capability-snapshot <path> exact backend capability snapshot JSON

Gate flags
  --candidate <path>           paired result artifact
  --baseline <path>            legacy development artifact only; release gate rejects it

Capability snapshot shape
  {"backend":"api","capturedAt":"2026-08-12T00:00:00.000Z",
   "provider":"openai","model":"...","capabilities":{"...":true}}

Environment
  CBC_MOCK_PROVIDER  scripted provider path. Required unless a real credential is configured.
  CBC_RUNTIME_BINARY absolute path to cbc-runtime, if not in the packaged location.`;

async function main(argv: readonly string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case "coverage":
      console.log(renderCoverage(suiteCoverage(SUITE)).join("\n"));
      return 0;

    case "validate":
      return await validateCommand();

    case "manifest":
      return await manifestCommand(flags);

    case "profiles":
      return profilesCommand();

    case "run":
      return await runCommand(flags);

    case "paired":
      return await pairedCommand(flags);

    case "gate":
      return await gateCommand(flags);

    case "help":
    case "--help":
      console.log(USAGE);
      return 0;

    default:
      console.error(`unknown command '${command}'\n`);
      console.error(USAGE);
      return 2;
  }
}

async function validateCommand(): Promise<number> {
  let bad = 0;
  for (const task of SUITE) {
    const issues = [...validateTask(task)];
    if (task.generatedSnapshot !== undefined) {
      try {
        const manifest = generatedSnapshotManifest(task);
        if (manifest.fileCount === 0) {
          issues.push({ field: "generatedSnapshot", message: "generated snapshot is empty" });
        }
      } catch (error) {
        issues.push({
          field: "generatedSnapshot",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      const source = `${BENCH}/${task.snapshot}`;
      const info = await stat(source).catch(() => undefined);
      if (info === undefined || !info.isDirectory()) {
        issues.push({
          field: "snapshot",
          message: `repository snapshot missing at ${task.snapshot}`,
        });
      }
    }
    if (issues.length === 0) {
      console.log(`ok    ${task.id}`);
      continue;
    }
    bad += 1;
    console.error(`FAIL  ${task.id}`);
    for (const issue of issues) console.error(`        ${issue.field}: ${issue.message}`);
  }
  const cohort = await checkCohortManifest(BENCH);
  const cohortErrors = validateCohortManifestShape(cohort.current);
  if (!cohort.ok || cohortErrors.length > 0) {
    bad += 1;
    console.error("FAIL  cohort manifest");
    if (!cohort.ok) console.error(`        stale or missing: ${COHORT_MANIFEST_PATH}`);
    for (const issue of cohortErrors) console.error(`        ${issue}`);
  } else {
    console.log(`ok    cohort manifest ${cohort.current.digest}`);
  }
  console.log("");
  console.log(`${SUITE.length - Math.min(bad, SUITE.length)} of ${SUITE.length} fixture(s) valid`);
  return bad === 0 ? 0 : 1;
}

async function manifestCommand(flags: Flags): Promise<number> {
  const manifest = await buildCohortManifest(BENCH);
  const issues = validateCohortManifestShape(manifest);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`cohort manifest: ${issue}`);
    return 1;
  }
  const outPath = flags.out ?? `${ROOT}/${COHORT_MANIFEST_PATH}`;
  await writeJsonArtifact(outPath, manifest);
  console.log(`wrote ${outPath} (${manifest.taskCount} tasks, ${manifest.digest})`);
  return 0;
}

function profilesCommand(): number {
  const width = EVAL_PROFILES.reduce((maximum, profile) => Math.max(maximum, profile.id.length), 0);
  for (const profile of EVAL_PROFILES) {
    let status = "wired";
    let reasons: readonly string[] = [];
    try {
      resolveExecutionProfile(profile);
    } catch (error) {
      if (error instanceof UnsupportedProfileError) {
        status = "unsupported";
        reasons = error.reasons;
      } else {
        throw error;
      }
    }
    console.log(
      `${profile.id.padEnd(width)}  ${profile.model} ${profile.reasoningMode}/${profile.reasoningEffort}` +
        `  review:${profile.autoReview ? "on " : "off"}` +
        `  discovery:${profile.toolDiscovery ? "on " : "off"}` +
        `  subagents:${profile.subagents ? "on " : "off"}` +
        `  cache:${profile.promptCache}  [${status}]`,
    );
    console.log(`${" ".repeat(width)}  ${profile.description}`);
    for (const reason of reasons) console.log(`${" ".repeat(width)}  - ${reason}`);
  }
  return 0;
}

async function runCommand(flags: Flags): Promise<number> {
  const variant = parsePerformanceVariant(flags.variant, "--variant");
  const serviceTier = parseBenchmarkServiceTier(flags.serviceTier);
  if (variant === undefined || serviceTier === undefined) return 2;
  const resolved = resolveProfile(flags.profile, { performanceVariant: variant, serviceTier });
  if (resolved === undefined) return 2;

  const tasks = selectTasks(flags.filter);
  if (tasks.length === 0) {
    console.error(`no task matches '${flags.filter}'`);
    return 2;
  }
  if (!validConcurrency(flags.concurrency)) return 2;
  const repositoryEvidence = await loadRepositoryEvidenceOrReport();
  if (repositoryEvidence === undefined) return 1;
  if (!providerConfigured()) return 9;

  const environment = await createBenchmarkEnvironment(`run-${resolved.profile.id}`);
  try {
    const runtimeCapabilities = await probeBenchmarkRuntimeCapabilities(environment);
    const runtimeIssues = benchmarkRuntimeCompatibilityIssues(tasks, runtimeCapabilities);
    if (runtimeIssues.length > 0) {
      console.error("benchmark runtime is not eligible for the selected cohort:");
      for (const issue of runtimeIssues) console.error(`  - ${issue}`);
      return 9;
    }
    const result = await runSuite(
      tasks,
      resolved.execution.applied,
      createBenchmarkRunner({
        benchmarkRoot: BENCH,
        executionProfile: resolved.execution,
        environment,
        concurrency: flags.concurrency,
        keepWorkspaces: flags.keepWorkspaces,
        onProgress: progressReporter(),
      }),
    );

    console.log("");
    console.log(renderSuiteResult(result).join("\n"));
    console.log("");
    console.log(renderSummary(result.summary).join("\n"));

    const outPath = flags.out ?? `${BENCH}/results/${resolved.profile.id}-${Date.now()}.json`;
    await writeJsonArtifact(
      outPath,
      serializeResult(result, resolved.execution, repositoryEvidence),
    );
    console.log("");
    console.log(`wrote ${outPath}`);

    const harnessErrors = result.results.filter((entry) => entry.harnessError !== undefined).length;
    if (harnessErrors > 0 || result.skipped.length > 0) {
      console.error(
        `\n${harnessErrors} harness error(s), ${result.skipped.length} malformed/skipped task(s)`,
      );
      return 1;
    }
    return 0;
  } finally {
    await disposeBenchmarkEnvironment(environment);
  }
}

async function pairedCommand(flags: Flags): Promise<number> {
  if (!Number.isInteger(flags.repetitions) || flags.repetitions < 1) {
    console.error("--repetitions must be a positive integer");
    return 2;
  }
  if (flags.comparison !== "capybara_baseline" && flags.comparison !== "codex_matched") {
    console.error("--comparison must be 'capybara_baseline' or 'codex_matched'");
    return 2;
  }
  const comparison = flags.comparison as ComparisonTarget;
  const baselineVariant = parsePerformanceVariant(
    flags.baselineVariant ?? "legacy",
    "--baseline-variant",
  );
  const candidateVariant = parsePerformanceVariant(
    flags.candidateVariant ?? flags.variant,
    "--candidate-variant",
  );
  const serviceTier = parseBenchmarkServiceTier(flags.serviceTier);
  if (baselineVariant === undefined || candidateVariant === undefined || serviceTier === undefined) {
    return 2;
  }
  if (flags.order !== "abba" && flags.order !== "seeded_randomized") {
    console.error("--order must be 'abba' or 'seeded_randomized'");
    return 2;
  }
  if (flags.order === "seeded_randomized" && flags.seed === undefined) {
    console.error("--order seeded_randomized requires --seed");
    return 2;
  }
  if (!validConcurrency(flags.concurrency)) return 2;
  if (flags.capabilitySnapshot === undefined) {
    console.error("paired requires --capability-snapshot <path>; release evidence cannot infer backend features");
    return 2;
  }

  const baseline = resolveProfile(flags.baselineProfile ?? flags.profile, {
    performanceVariant: baselineVariant,
    serviceTier,
  });
  const candidate = resolveProfile(flags.candidateProfile ?? flags.profile, {
    performanceVariant: candidateVariant,
    serviceTier,
  });
  if (baseline === undefined || candidate === undefined) return 2;

  const tasks = selectTasks(flags.filter);
  if (tasks.length === 0) {
    console.error(`no task matches '${flags.filter}'`);
    return 2;
  }
  const capabilitySnapshot = await readCapabilitySnapshot(flags.capabilitySnapshot);
  if (capabilitySnapshot === undefined) return 2;
  let baselineAdapter: ExternalBenchmarkAdapter | undefined;
  if (comparison === "codex_matched") {
    if (flags.baselineAdapter === undefined) {
      console.error("codex_matched comparison requires --baseline-adapter <path>");
      return 2;
    }
    const adapterArtifact = await readJsonArtifact(flags.baselineAdapter);
    if (adapterArtifact === undefined) return 2;
    try {
      baselineAdapter = parseExternalBenchmarkAdapter(
        adapterArtifact,
        baseline.execution.applied,
        capabilitySnapshotDigest(capabilitySnapshot),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  } else if (flags.baselineAdapter !== undefined) {
    console.error("--baseline-adapter is only valid with --comparison codex_matched");
    return 2;
  }
  const repositoryEvidence = await loadRepositoryEvidenceOrReport();
  if (repositoryEvidence === undefined) return 1;
  if (!providerConfigured()) return 9;

  const baselineEnvironment = await createBenchmarkEnvironment(`paired-baseline-${baseline.profile.id}`);
  try {
    const candidateEnvironment = await createBenchmarkEnvironment(`paired-candidate-${candidate.profile.id}`);
    try {
      const runtimeCapabilities = await probeBenchmarkRuntimeCapabilities(candidateEnvironment);
      const runtimeIssues = benchmarkRuntimeCompatibilityIssues(tasks, runtimeCapabilities);
      if (runtimeIssues.length > 0) {
        console.error("benchmark runtime is not eligible for the selected cohort:");
        for (const issue of runtimeIssues) console.error(`  - ${issue}`);
        return 9;
      }
      const result = await runPairedSuite(
        tasks,
        {
          baseline: baseline.execution.applied,
          candidate: candidate.execution.applied,
        },
        {
          repetitions: flags.repetitions,
          comparisonTarget: comparison,
          order: flags.order as PairedOrderStrategy,
          ...(flags.seed !== undefined ? { seed: flags.seed } : {}),
          capabilitySnapshot: {
            ...capabilitySnapshot,
            metadata: {
              ...capabilitySnapshot.metadata,
              benchmarkRunner: "cbc-bench",
              baselineProfile: baseline.execution.applied.id,
              candidateProfile: candidate.execution.applied.id,
              baselinePerformanceVariant: baseline.execution.performanceVariant,
              candidatePerformanceVariant: candidate.execution.performanceVariant,
              serviceTier,
              repositoryEvidenceDigest: repositoryEvidence.digest,
              runtimePlatform: runtimeCapabilities.platform,
              runtimeArch: runtimeCapabilities.arch,
              runtimeSandboxBackends: runtimeCapabilities.sandboxBackends,
            },
          },
          // Filtered runs are development evidence. The full cohort enforces the complete
          // category distribution immediately; `gate` independently enforces release size.
          requireCompleteCoverage: flags.filter === "all",
          minimumRepetitions: 2,
          requiredTemperatures: ["cold", "warm"],
          requireAppliedProfile: true,
          beforeRun: async (descriptor) => {
            const environment = descriptor.variant === "baseline"
              ? baselineEnvironment
              : candidateEnvironment;
            await resetBenchmarkEnvironment(environment, descriptor.temperature === "cold");
          },
          runner: (descriptor) => {
            const selected = descriptor.variant === "baseline" ? baseline : candidate;
            const environment = descriptor.variant === "baseline"
              ? baselineEnvironment
              : candidateEnvironment;
            const runnerInput = {
                    benchmarkRoot: BENCH,
              executionProfile: selected.execution,
              environment,
              concurrency: flags.concurrency,
              keepWorkspaces: flags.keepWorkspaces,
              onProgress: progressReporter(
                `${descriptor.variant}#${descriptor.repetition}/${descriptor.temperature}`,
              ),
            };
            return descriptor.variant === "baseline" && baselineAdapter !== undefined
              ? createExternalBenchmarkRunner({ ...runnerInput, adapter: baselineAdapter })
              : createBenchmarkRunner(runnerInput);
          },
          onRunStarted: (descriptor) => {
            console.error(
              `\n> ${descriptor.sequence}: ${descriptor.variant} repetition ${descriptor.repetition}` +
                ` (${descriptor.temperature}, ${descriptor.profile.id})`,
            );
          },
        },
      );

      console.log("");
      console.log("Paired aggregate — baseline");
      console.log(renderSummary(result.aggregate.baseline).join("\n"));
      console.log("");
      console.log("Paired aggregate — candidate");
      console.log(renderSummary(result.aggregate.candidate).join("\n"));
      const statisticalGate = evaluateStatisticalGate(result.aggregate.statistics);
      console.log("");
      console.log(renderPairedStatistics(result.aggregate.statistics).join("\n"));
      console.log("");
      console.log("Experiment eligibility");
      console.log(renderGate(result.aggregate.gate).join("\n"));
      console.log("");
      console.log("Statistical release thresholds");
      console.log(renderGate(statisticalGate).join("\n"));

      const outPath = flags.out ?? `${BENCH}/results/paired-${Date.now()}.json`;
      await writeJsonArtifact(
        outPath,
        serializePairedResult(
          result,
          baseline.execution,
          candidate.execution,
          repositoryEvidence,
          baselineAdapter,
        ),
      );
      console.log("");
      console.log(`wrote ${outPath}`);

      const harnessErrors = result.runs.reduce(
        (total, run) =>
          total +
          run.result.skipped.length +
          run.result.results.filter((entry) => entry.harnessError !== undefined).length,
        0,
      );
      return harnessErrors === 0 &&
        result.aggregate.gate.status !== "failed" &&
        statisticalGate.status !== "failed"
        ? 0
        : 1;
    } finally {
      await disposeBenchmarkEnvironment(candidateEnvironment);
    }
  } finally {
    await disposeBenchmarkEnvironment(baselineEnvironment);
  }
}

async function gateCommand(flags: Flags): Promise<number> {
  if (flags.candidate === undefined) {
    console.error("gate needs --candidate <path>");
    return 2;
  }

  const candidateArtifact = await readJsonArtifact(flags.candidate);
  if (candidateArtifact === undefined) return 2;
  const baselineArtifact = flags.baseline === undefined
    ? undefined
    : await readJsonArtifact(flags.baseline);
  if (flags.baseline !== undefined && baselineArtifact === undefined) return 2;
  const preliminary = inspectReleaseEvidence(candidateArtifact, baselineArtifact);
  let evidence = preliminary;
  if (preliminary.kind === "paired") {
    const expectedRepositoryEvidence = await loadRepositoryEvidenceOrReport();
    if (expectedRepositoryEvidence === undefined) return 1;
    evidence = inspectReleaseEvidence(candidateArtifact, baselineArtifact, {
      expectedRepositoryEvidence,
    });
  }
  console.log(`release evidence: ${evidence.kind}`);
  if (evidence.candidate !== undefined) {
    console.log("");
    console.log(renderSummary(evidence.candidate).join("\n"));
  }
  if (evidence.baseline !== undefined) {
    console.log("");
    console.log(`baseline: ${evidence.baseline.profile}, ${evidence.baseline.taskCount} task(s)`);
  }
  if (evidence.errors.length > 0) {
    console.error("\nrelease evidence is not eligible:");
    for (const error of evidence.errors) console.error(`  - ${error}`);
    return 1;
  }
  if (
    evidence.candidate === undefined ||
    evidence.baseline === undefined ||
    evidence.statistics === undefined ||
    evidence.statisticalGate === undefined
  ) {
    console.error("release evidence inspection did not produce summaries and recomputed statistics");
    return 1;
  }

  console.log("");
  console.log(renderPairedStatistics(evidence.statistics).join("\n"));
  console.log("");
  console.log(renderGate(evidence.statisticalGate).join("\n"));
  return evidence.statisticalGate.pass ? 0 : 1;
}

function resolveProfile(
  id: string,
  options: ExecutionProfileOptions = {},
): ResolvedProfile | undefined {
  const profile = profileById(id);
  if (profile === undefined) {
    console.error(`unknown profile '${id}'. Known: ${EVAL_PROFILES.map((entry) => entry.id).join(", ")}`);
    return undefined;
  }
  try {
    return { profile, execution: resolveExecutionProfile(profile, options) };
  } catch (error) {
    if (error instanceof UnsupportedProfileError) {
      console.error(error.message);
      return undefined;
    }
    throw error;
  }
}

async function loadRepositoryEvidenceOrReport(): Promise<BenchmarkRepositoryEvidence | undefined> {
  try {
    return await loadBenchmarkRepositoryEvidence(ROOT, BENCH);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function providerConfigured(): boolean {
  const mockScript = process.env.CBC_MOCK_PROVIDER;
  const hasCredential =
    (process.env.OPENAI_API_KEY ?? "").length > 0 || process.env.CBC_BENCH_LIVE === "1";
  if (mockScript !== undefined || hasCredential) return true;
  console.error(
    [
      "no provider is configured, so nothing would be measured.",
      "",
      "Set CBC_MOCK_PROVIDER to a scripted provider, or configure a credential and",
      "set CBC_BENCH_LIVE=1 to run against the real API.",
    ].join("\n"),
  );
  return false;
}

function validConcurrency(value: number): boolean {
  if (Number.isInteger(value) && value >= 1) return true;
  console.error("--concurrency must be a positive integer");
  return false;
}

function progressReporter(prefix?: string): NonNullable<Parameters<typeof runSuite>[2]["onProgress"]> {
  const label = prefix === undefined ? "" : `[${prefix}] `;
  return (event) => {
    if (event.kind === "task_started") console.error(`> ${label}${event.task}`);
    if (event.kind === "task_finished") {
      console.error(
        `  ${label}${event.passed ? "pass" : "fail"} ${event.task}` +
          ` in ${Math.round(event.wallTimeMs)} ms`,
      );
    }
    if (event.kind === "task_skipped") {
      console.error(`  ${label}skip ${event.task}: ${event.reason}`);
    }
  };
}

async function readCapabilitySnapshot(path: string): Promise<CapabilitySnapshot | undefined> {
  const artifact = await readJsonArtifact(path);
  if (!isRecord(artifact)) {
    console.error(`${path} must contain a JSON object`);
    return undefined;
  }
  const backend = artifact.backend;
  const capturedAt = artifact.capturedAt;
  const capabilities = artifact.capabilities;
  if (typeof backend !== "string" || backend.trim().length === 0) {
    console.error(`${path} capability snapshot needs a non-empty backend`);
    return undefined;
  }
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) {
    console.error(`${path} capability snapshot needs an ISO capturedAt timestamp`);
    return undefined;
  }
  if (!isRecord(capabilities) || Object.keys(capabilities).length === 0) {
    console.error(`${path} capability snapshot needs a non-empty capabilities object`);
    return undefined;
  }
  if (artifact.provider !== undefined && typeof artifact.provider !== "string") {
    console.error(`${path} capability snapshot provider must be a string`);
    return undefined;
  }
  if (artifact.model !== undefined && typeof artifact.model !== "string") {
    console.error(`${path} capability snapshot model must be a string`);
    return undefined;
  }
  if (artifact.metadata !== undefined && !isRecord(artifact.metadata)) {
    console.error(`${path} capability snapshot metadata must be an object`);
    return undefined;
  }
  return artifact as unknown as CapabilitySnapshot;
}

async function readJsonArtifact(path: string): Promise<unknown | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`no such result file: ${path}`);
    return undefined;
  }
  try {
    return await file.json();
  } catch (error) {
    console.error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function serializeResult(
  result: SuiteResult,
  executionProfile: ResolvedExecutionProfile,
  repositoryEvidence: BenchmarkRepositoryEvidence,
): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    profile: result.profile,
    executionProfile,
    repositoryEvidence,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    summary: result.summary,
    skipped: result.skipped,
    results: result.results.map((entry) => ({
      taskId: entry.task.id,
      category: entry.task.category,
      language: entry.task.language,
      metrics: entry.metrics,
      acceptance: entry.acceptance,
      ...(entry.harnessError !== undefined ? { harnessError: entry.harnessError } : {}),
    })),
  };
}

function serializePairedResult(
  result: PairedSuiteResult,
  baseline: ResolvedExecutionProfile,
  candidate: ResolvedExecutionProfile,
  repositoryEvidence: BenchmarkRepositoryEvidence,
  baselineAdapter?: ExternalBenchmarkAdapter,
): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    ...result,
    comparisonTarget: result.aggregate.statistics.target,
    repositoryEvidence,
    executionEvidence: {
      baseline: baselineAdapter === undefined
        ? { kind: "cbc", profile: baseline }
        : { kind: "external", adapter: baselineAdapter },
      candidate: { kind: "cbc", profile: candidate },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { main as cbcBench, USAGE };
