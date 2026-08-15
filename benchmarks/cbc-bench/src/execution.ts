import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  type AcceptanceOutcome,
  type BenchTask,
  type EvalProfile,
  type RunnerOptions,
  type TaskExecution,
} from "@cbc/evals";
import { fromJsonl, type CbcEvent, type RuntimeCapabilities } from "@cbc/protocol";

import { createBunHost } from "../../../apps/cbc/src/bun-host.ts";
import { Runtime } from "../../../apps/cbc/src/runtime.ts";
import {
  benchmarkConfigToml,
  type ResolvedExecutionProfile,
} from "./profile.ts";
import {
  materializeGeneratedSnapshot,
  runGeneratedAcceptance,
} from "./generated-fixtures.ts";

export interface BenchmarkEnvironment {
  readonly root: string;
  readonly data: string;
  readonly cache: string;
  readonly logs: string;
}

const NETWORK_DENY_BACKENDS = new Set(["network-namespace", "seccomp"]);

/**
 * A release benchmark must not turn a missing OS sandbox into agent failures. When a
 * selected task requires `network = deny`, the runtime must report a backend that can
 * actually enforce it; otherwise the cohort is ineligible on this host.
 */
export function benchmarkRuntimeCompatibilityIssues(
  tasks: readonly BenchTask[],
  capabilities: Pick<RuntimeCapabilities, "platform" | "sandboxBackends">,
): string[] {
  const issues: string[] = [];
  const requiresNetworkDeny = tasks.some((task) => task.network === "deny");
  const canDenyNetwork = capabilities.sandboxBackends.some((backend) =>
    NETWORK_DENY_BACKENDS.has(backend)
  );
  if (requiresNetworkDeny && !canDenyNetwork) {
    issues.push(
      `selected cohort requires network=deny, but ${capabilities.platform} reports no ` +
        "network-namespace or seccomp enforcement backend; this run cannot be scored",
    );
  }
  return issues;
}

/** Probe the same runtime binary and handshake used by the benchmarked CLI. */
export async function probeBenchmarkRuntimeCapabilities(
  environment: BenchmarkEnvironment,
): Promise<RuntimeCapabilities> {
  const workspace = join(environment.root, "runtime-capability-probe");
  await mkdir(workspace, { recursive: true });
  const runtime = await Runtime.start({
    host: createBunHost("cbc-bench-capability-probe"),
    workspace,
    dataDir: environment.data,
    clientVersion: "cbc-bench-capability-probe",
    pty: false,
    sandboxLevel: "workspace",
    networkForShell: "deny",
    interactionMode: "build",
  });
  try {
    const capabilities = runtime.capabilities;
    if (capabilities === undefined) {
      throw new Error("runtime capability probe completed without a capability report");
    }
    return structuredClone(capabilities);
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

export interface BenchmarkRunnerInput {
  readonly repositoryRoot: string;
  readonly benchmarkRoot: string;
  readonly executionProfile: ResolvedExecutionProfile;
  readonly environment: BenchmarkEnvironment;
  readonly concurrency: number;
  readonly keepWorkspaces: boolean;
  readonly onProgress?: RunnerOptions["onProgress"];
}

/**
 * Neutral shell-free adapter contract for a competitor or historical implementation.
 * The adapter lives outside this repository and translates its trace into CBC events;
 * Capybara never imports or depends on another agent runtime.
 */
export interface ExternalBenchmarkAdapter {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly version: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly appliedProfile: EvalProfile;
  readonly capabilityDigest: string;
  /** Operator-attested digest of the adapter implementation/package. */
  readonly implementationDigest: string;
  /** Environment variables explicitly allowed to cross the adapter boundary. */
  readonly passEnvironment: readonly string[];
  /** Canonical digest of this fully bound adapter manifest. */
  readonly manifestDigest: string;
}

export interface ExternalBenchmarkRunnerInput extends BenchmarkRunnerInput {
  readonly adapter: ExternalBenchmarkAdapter;
}

export interface ExternalTaskExecutionEnvelope {
  readonly schemaVersion: "1.0";
  readonly executionId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterManifestDigest: string;
  readonly capabilityDigest: string;
  readonly taskId: string;
  readonly profileId: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly exitCode: number;
  readonly events: readonly unknown[];
}

/** Parse and bind an operator-supplied adapter to the exact comparison contract. */
export function parseExternalBenchmarkAdapter(
  value: unknown,
  expectedProfile: EvalProfile,
  expectedCapabilityDigest: string,
): ExternalBenchmarkAdapter {
  if (!isRecord(value)) throw new Error("external baseline adapter must be a JSON object");
  if (value.schemaVersion !== "1.0") throw new Error("external baseline adapter schemaVersion must be 1.0");
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("external baseline adapter needs a non-empty id");
  }
  if (
    typeof value.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value.version)
  ) {
    throw new Error("external baseline adapter needs a stable version label");
  }
  if (typeof value.program !== "string" || !isAbsolute(value.program)) {
    throw new Error("external baseline adapter program must be an absolute path");
  }
  if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string")) {
    throw new Error("external baseline adapter args must be a string array");
  }
  if (!value.args.some((entry) => entry.includes("{input}"))) {
    throw new Error("external baseline adapter args must include {input}");
  }
  if (!value.args.some((entry) => entry.includes("{output}"))) {
    throw new Error("external baseline adapter args must include {output}");
  }
  if (
    !isRecord(value.appliedProfile) ||
    canonicalValue(value.appliedProfile) !== canonicalValue(expectedProfile)
  ) {
    throw new Error("external baseline adapter profile does not match the requested comparison profile");
  }
  if (value.capabilityDigest !== expectedCapabilityDigest) {
    throw new Error("external baseline adapter capability digest does not match the comparison snapshot");
  }
  if (
    typeof value.implementationDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.implementationDigest)
  ) {
    throw new Error("external baseline adapter implementationDigest must be sha256:<64 lowercase hex>");
  }
  const passEnvironment = value.passEnvironment ?? [];
  if (
    !Array.isArray(passEnvironment) ||
    !passEnvironment.every((entry) => typeof entry === "string")
  ) {
    throw new Error("external baseline adapter passEnvironment must be a string array");
  }
  const environmentNames = [...new Set(passEnvironment as string[])].sort();
  if (environmentNames.length !== passEnvironment.length) {
    throw new Error("external baseline adapter passEnvironment must not contain duplicates");
  }
  for (const name of environmentNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`external baseline adapter environment name '${name}' is invalid`);
    }
    if (isForbiddenAdapterEnvironmentName(name)) {
      throw new Error(`external baseline adapter may not inherit executable-control variable '${name}'`);
    }
  }

  const manifest = {
    schemaVersion: "1.0" as const,
    id: value.id,
    version: value.version,
    program: value.program,
    args: [...value.args] as string[],
    appliedProfile: { ...expectedProfile },
    capabilityDigest: expectedCapabilityDigest,
    implementationDigest: value.implementationDigest,
    passEnvironment: environmentNames,
  };
  const manifestDigest = sha256(canonicalValue(manifest));
  if (value.manifestDigest !== undefined && value.manifestDigest !== manifestDigest) {
    throw new Error("external baseline adapter manifestDigest does not match its canonical body");
  }
  return {
    ...manifest,
    manifestDigest,
  };
}

/**
 * Create an isolated benchmark state root. Product configuration, trust/session data,
 * caches, and logs never leak into or out of the user's normal Capybara directories.
 */
export async function createBenchmarkEnvironment(label: string): Promise<BenchmarkEnvironment> {
  const safeLabel = label.replace(/[^a-z0-9-]+/giu, "-").replace(/^-+|-+$/gu, "") || "run";
  const root = await mkdtemp(join(tmpdir(), `cbc-bench-${safeLabel}-`));
  const environment = {
    root,
    data: join(root, "data"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
  } satisfies BenchmarkEnvironment;
  await resetBenchmarkEnvironment(environment, true);
  return environment;
}

/**
 * Reset per-run durable state. A cold run also clears local caches; a warm run retains
 * the variant's cache while still starting with fresh sessions, approvals, and logs.
 */
export async function resetBenchmarkEnvironment(
  environment: BenchmarkEnvironment,
  cold: boolean,
): Promise<void> {
  await Promise.all([
    rm(environment.data, { recursive: true, force: true }),
    rm(environment.logs, { recursive: true, force: true }),
    ...(cold ? [rm(environment.cache, { recursive: true, force: true })] : []),
  ]);
  await Promise.all([
    mkdir(environment.data, { recursive: true }),
    mkdir(environment.cache, { recursive: true }),
    mkdir(environment.logs, { recursive: true }),
  ]);
}

export async function disposeBenchmarkEnvironment(
  environment: BenchmarkEnvironment,
): Promise<void> {
  await rm(environment.root, { recursive: true, force: true });
}

/** Build a real `runSuite` adapter whose declared profile axes are actually applied. */
export function createBenchmarkRunner(input: BenchmarkRunnerInput): RunnerOptions {
  const configByWorkspace = new Map<string, string>();

  return {
    concurrency: input.concurrency,
    appliedProfile: input.executionProfile.applied,
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),

    prepare: async (task: BenchTask) => {
      const source = `${input.benchmarkRoot}/${task.snapshot}`;
      const info = await stat(source).catch(() => undefined);
      const physicalSnapshot = info?.isDirectory() === true;
      if (!physicalSnapshot && task.generatedSnapshot === undefined) {
        throw new Error(`snapshot ${task.snapshot} does not exist and has no generator recipe`);
      }

      const workspace = await mkdtemp(join(tmpdir(), `cbc-bench-${task.id}-`));
      const normalizedWorkspace = workspace.replace(/\\/gu, "/");
      const configRoot = join(input.environment.root, "configs", `${task.id}-${randomUUID()}`);
      try {
        if (physicalSnapshot) await cp(source, workspace, { recursive: true });
        else await materializeGeneratedSnapshot(task, workspace);
        await mkdir(configRoot, { recursive: true });
        await writeFile(
          join(configRoot, "config.toml"),
          benchmarkConfigToml(input.executionProfile, {
            network: task.network,
            approvalCommands: benchmarkApprovalCommands(task),
          }),
          "utf8",
        );
        configByWorkspace.set(normalizedWorkspace, configRoot);
        await trustWorkspace(
          input.repositoryRoot,
          normalizedWorkspace,
          benchmarkEnvironmentVariables(input.environment, configRoot),
        );
        return normalizedWorkspace;
      } catch (error) {
        configByWorkspace.delete(normalizedWorkspace);
        await Promise.all([
          rm(configRoot, { recursive: true, force: true }),
          rm(workspace, { recursive: true, force: true }),
        ]);
        throw error;
      }
    },

    ...(input.keepWorkspaces
      ? {}
      : {
          teardown: async (workspace: string) => {
            const configRoot = configByWorkspace.get(workspace);
            configByWorkspace.delete(workspace);
            await Promise.all([
              rm(workspace, { recursive: true, force: true }),
              ...(configRoot === undefined
                ? []
                : [rm(configRoot, { recursive: true, force: true })]),
            ]);
          },
        }),

    execute: async ({ task, profile, workspace, signal }) => {
      const configRoot = configByWorkspace.get(workspace);
      if (configRoot === undefined) {
        throw new Error(`benchmark configuration is missing for workspace ${workspace}`);
      }
      return await executeTask({
        task,
        profile,
        executionProfile: input.executionProfile,
        workspace,
        signal,
        repositoryRoot: input.repositoryRoot,
        environment: benchmarkEnvironmentVariables(input.environment, configRoot),
      });
    },

    acceptance: async ({ task, workspace, tests }) => {
      const outcomes: AcceptanceOutcome[] = [];
      for (const test of tests) {
        if (test.program === "cbc-bench-check") {
          const generated = await runGeneratedAcceptance(task, workspace);
          outcomes.push({
            label: "cbc-bench-check",
            passed: generated.passed,
            wasPassingBefore: false,
            ...(generated.detail !== undefined ? { detail: generated.detail } : {}),
          });
          continue;
        }
        const child = Bun.spawn({
          cmd: [resolveProgram(test.program), ...test.args],
          cwd: test.cwd !== undefined ? `${workspace}/${test.cwd}` : workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
        let timedOut = false;
        const timeout = test.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, test.timeoutMs);
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (timeout !== undefined) clearTimeout(timeout);
        const output = `${out}${err}`;
        const exitOk = !timedOut && exit === (test.expectExit ?? 0);
        const outputOk = test.expectOutput === undefined || output.includes(test.expectOutput);
        outcomes.push({
          label: `${test.program} ${test.args.join(" ")}`.trim(),
          passed: exitOk && outputOk,
          wasPassingBefore: false,
          ...(exitOk && outputOk
            ? {}
            : {
                detail: timedOut
                  ? `timed out after ${test.timeoutMs} ms`
                  : `exit ${exit}: ${output.slice(0, 300)}`,
              }),
        });
      }
      return outcomes;
    },
  };
}

/**
 * Reuse the exact snapshot, hidden acceptance, and teardown path while delegating only
 * agent execution to an operator-supplied neutral adapter.
 */
export function createExternalBenchmarkRunner(
  input: ExternalBenchmarkRunnerInput,
): RunnerOptions {
  const base = createBenchmarkRunner(input);
  return {
    ...base,
    appliedProfile: input.adapter.appliedProfile,
    execute: async ({ task, profile, workspace, signal }) => await executeExternalTask({
      task,
      profile,
      workspace,
      signal,
      environment: input.environment,
      adapter: input.adapter,
    }),
  };
}

interface ExternalExecuteInput {
  readonly task: BenchTask;
  readonly profile: EvalProfile;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly environment: BenchmarkEnvironment;
  readonly adapter: ExternalBenchmarkAdapter;
}

async function executeExternalTask(input: ExternalExecuteInput): Promise<TaskExecution> {
  const exchangeDirectory = join(input.environment.root, "external-adapter");
  await mkdir(exchangeDirectory, { recursive: true });
  const executionId = randomUUID();
  const exchangeId = `${input.task.id}-${executionId}`;
  const inputPath = join(exchangeDirectory, `${exchangeId}.input.json`);
  const outputPath = join(exchangeDirectory, `${exchangeId}.output.json`);
  const request = {
    schemaVersion: "1.0",
    executionId,
    adapter: {
      id: input.adapter.id,
      version: input.adapter.version,
      manifestDigest: input.adapter.manifestDigest,
      implementationDigest: input.adapter.implementationDigest,
    },
    task: {
      id: input.task.id,
      category: input.task.category,
      language: input.task.language,
      prompt: input.task.prompt,
      network: input.task.network,
      permissionMode: input.task.permissionMode,
      budget: input.task.budget,
      expectedScope: input.task.expectedScope,
      expectedStatus: input.task.expectedStatus,
      risks: input.task.risks,
    },
    workspace: input.workspace,
    profile: input.profile,
    capabilityDigest: input.adapter.capabilityDigest,
  };
  await writeFile(inputPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const args = input.adapter.args.map((argument) =>
    argument
      .replaceAll("{input}", inputPath)
      .replaceAll("{output}", outputPath)
      .replaceAll("{workspace}", input.workspace)
  );
  const child = Bun.spawn({
    cmd: [input.adapter.program, ...args],
    cwd: input.workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: externalAdapterEnvironment(input.adapter.passEnvironment),
  });
  const abort = (): void => child.kill();
  input.signal.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, processExit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  input.signal.removeEventListener("abort", abort);

  try {
    if (processExit !== 0) {
      throw new Error(
        `external adapter '${input.adapter.id}' exited ${processExit}: ` +
          `${stderr}${stdout}`.trim().slice(0, 1_000),
      );
    }
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    const envelope = parseExternalTaskEnvelope(
      parsed,
      executionId,
      input.adapter,
      input.task.id,
      input.profile.id,
    );
    return {
      events: envelope.events,
      startedAtMs: envelope.startedAtMs,
      finishedAtMs: envelope.finishedAtMs,
      exitCode: envelope.exitCode,
    };
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(outputPath, { force: true }),
    ]);
  }
}

function parseExternalTaskEnvelope(
  value: unknown,
  expectedExecutionId: string,
  adapter: ExternalBenchmarkAdapter,
  expectedTaskId: string,
  expectedProfileId: string,
): Omit<ExternalTaskExecutionEnvelope, "events"> & { readonly events: readonly CbcEvent[] } {
  if (!isRecord(value) || value.schemaVersion !== "1.0") {
    throw new Error("external adapter output must be a schemaVersion 1.0 object");
  }
  const provenanceMatches =
    value.executionId === expectedExecutionId &&
    value.adapterId === adapter.id &&
    value.adapterVersion === adapter.version &&
    value.adapterManifestDigest === adapter.manifestDigest &&
    value.capabilityDigest === adapter.capabilityDigest;
  if (!provenanceMatches) {
    throw new Error("external adapter output provenance does not match the bound request");
  }
  if (value.taskId !== expectedTaskId) {
    throw new Error(`external adapter output taskId '${String(value.taskId)}' does not match '${expectedTaskId}'`);
  }
  if (value.profileId !== expectedProfileId) {
    throw new Error(
      `external adapter output profileId '${String(value.profileId)}' does not match '${expectedProfileId}'`,
    );
  }
  if (
    typeof value.startedAtMs !== "number" ||
    typeof value.finishedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    !Number.isFinite(value.finishedAtMs) ||
    value.finishedAtMs < value.startedAtMs ||
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    !Array.isArray(value.events) ||
    value.events.length === 0
  ) {
    throw new Error("external adapter output has invalid timing, exit code, or event data");
  }

  const events: CbcEvent[] = [];
  const eventIds = new Set<string>();
  let previousSequence = 0;
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let terminalTurns = 0;
  for (const rawEvent of value.events) {
    const event = fromJsonl(JSON.stringify(rawEvent));
    if (event === undefined) throw new Error("external adapter output contains an invalid CBC event");
    if (event.sequence <= previousSequence) {
      throw new Error("external adapter CBC event sequence must be strictly increasing");
    }
    if (eventIds.has(event.id)) throw new Error("external adapter CBC event ids must be unique");
    if (sessionId !== undefined && event.sessionId !== sessionId) {
      throw new Error("external adapter CBC events must belong to one session");
    }
    if (event.turnId !== undefined) {
      if (turnId !== undefined && event.turnId !== turnId) {
        throw new Error("external adapter CBC events must belong to one turn");
      }
      turnId = event.turnId;
    }
    if (event.kind === "turn.completed" || event.kind === "turn.cancelled") {
      if (event.turnId === undefined) {
        throw new Error("external adapter terminal turn event must carry turnId");
      }
      terminalTurns += 1;
    }
    previousSequence = event.sequence;
    eventIds.add(event.id);
    sessionId = event.sessionId;
    events.push(event);
  }
  if (terminalTurns !== 1) {
    throw new Error("external adapter CBC events must contain exactly one terminal turn event");
  }

  return {
    schemaVersion: "1.0",
    executionId: expectedExecutionId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    adapterManifestDigest: adapter.manifestDigest,
    capabilityDigest: adapter.capabilityDigest,
    taskId: expectedTaskId,
    profileId: expectedProfileId,
    startedAtMs: value.startedAtMs,
    finishedAtMs: value.finishedAtMs,
    exitCode: value.exitCode,
    events,
  };
}

interface ExecuteTaskInput {
  readonly task: BenchTask;
  readonly profile: EvalProfile;
  readonly executionProfile: ResolvedExecutionProfile;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly repositoryRoot: string;
  readonly environment: Record<string, string>;
}

async function executeTask(input: ExecuteTaskInput): Promise<TaskExecution> {
  const args = [
    "run",
    "--jsonl",
    "--workspace",
    input.workspace,
    "--model",
    input.profile.model,
    "--reasoning",
    input.profile.reasoningEffort,
    "--reasoning-mode",
    input.profile.reasoningMode,
    ...taskModeArguments(input.task, input.executionProfile),
    // The headless policy is independent of the product permission preset. A denied
    // approval is returned to the model so denial adaptation remains measurable.
    "--on-approval",
    "deny",
    input.task.prompt,
  ];

  const startedAtMs = Date.now();
  const child = Bun.spawn({
    cmd: [process.execPath, "run", `${input.repositoryRoot}/apps/cbc/src/main.ts`, ...args],
    cwd: input.workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...input.environment,
      CBC_BENCH_PROFILE: input.profile.id,
    },
  });

  const abort = (): void => child.kill();
  input.signal.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  input.signal.removeEventListener("abort", abort);
  const finishedAtMs = Date.now();

  const events: CbcEvent[] = [];
  let unparseable = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const event = fromJsonl(line);
    if (event === undefined) {
      unparseable += 1;
      continue;
    }
    events.push(event);
  }

  if (unparseable > 0) {
    console.error(
      `  warning: ${unparseable} non-event line(s) on stdout for ${input.task.id} (violates §20.10)`,
    );
  }
  if (events.length === 0) {
    console.error(`  ${input.task.id}: no events; stderr was:\n${indent(stderr.slice(0, 1200))}`);
  }

  return { events, startedAtMs, finishedAtMs, exitCode };
}

export function benchmarkApprovalCommands(task: BenchTask): string[] {
  if (task.permissionMode === "plan" || task.expectedStatus === "partial") return [];
  const declared = task.expectedEvidence.verificationCommands;
  if (declared !== undefined && declared.length > 0) return [...declared];
  switch (task.language) {
    case "typescript":
    case "javascript":
      return ["bun test"];
    case "rust":
      return ["cargo test"];
    case "python":
      return ["python -m pytest"];
    case "go":
      return ["go test ./..."];
    case "mixed_monorepo":
      return ["bun test", "cargo test", "python -m pytest", "go test ./..."];
  }
}

export function taskModeArguments(
  task: BenchTask,
  executionProfile: ResolvedExecutionProfile,
): string[] {
  // `BenchTask.permissionMode` predates the split between permission preset and review
  // policy. Preserve its permission semantics, but always take the review axis from the
  // selected eval profile so `no-auto-review` is measured truthfully on every task.
  const review = ["--review", executionProfile.cli.review];
  switch (task.permissionMode) {
    case "plan":
      return ["--mode", "plan", ...review];
    case "ask":
      return ["--mode", "ask", ...review];
    case "auto":
    case "auto-review":
      return ["--mode", "auto", ...review];
    default:
      return ["--mode", "build", ...review];
  }
}

function benchmarkEnvironmentVariables(
  environment: BenchmarkEnvironment,
  configRoot: string,
): Record<string, string> {
  return {
    CAPYBARA_CONFIG: configRoot,
    CAPYBARA_DATA_DIR: environment.data,
    CAPYBARA_CACHE_DIR: environment.cache,
    CAPYBARA_LOG_DIR: environment.logs,
  };
}

function externalAdapterEnvironment(passEnvironment: readonly string[]): Record<string, string> {
  const inherited = new Set([
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TERM",
    "NO_COLOR",
    ...passEnvironment,
  ]);
  const result: Record<string, string> = { CBC_BENCH_EXTERNAL_ADAPTER: "1" };
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function isForbiddenAdapterEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("LD_") ||
    upper.startsWith("DYLD_") ||
    upper.startsWith("CBC_") ||
    upper.startsWith("CAPYBARA_") ||
    [
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "PYTHONPATH",
      "PYTHONHOME",
      "RUSTC_WRAPPER",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
    ].includes(upper)
  );
}

function resolveProgram(program: string): string {
  return program === "bun" ? process.execPath : program;
}

async function trustWorkspace(
  repositoryRoot: string,
  workspace: string,
  environment: Record<string, string>,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", `${repositoryRoot}/apps/cbc/src/main.ts`, "trust", "add", workspace],
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    throw new Error(`could not trust the benchmark workspace: ${err.trim() || `exit ${code}`}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(record[key])}`
  ).join(",")}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
