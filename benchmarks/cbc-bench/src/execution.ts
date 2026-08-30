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
import { CommandContext } from "../../../apps/cbc/src/commands/context.ts";
import { run as runHeadlessly } from "../../../apps/cbc/src/commands/run.ts";
import type { Host, HostIo } from "../../../apps/cbc/src/host.ts";
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
export type ExternalAdapterComparisonMode = "backbone_matched" | "product_native";

/** Product identity bound into every new external adapter manifest digest. */
export interface ExternalAdapterIdentity {
  readonly product: string;
  readonly version: string;
  readonly model: string;
  readonly authSurface: string;
  readonly mode: ExternalAdapterComparisonMode;
}

export interface ExternalBenchmarkAdapter {
  readonly schemaVersion: "1.0" | "1.1";
  readonly id: string;
  readonly identity: ExternalAdapterIdentity;
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
  /** True only for a schemaVersion 1.0 `codex_matched` artifact. */
  readonly legacyIdentity?: true;
}

export interface ExternalAdapterParseOptions {
  readonly mode?: ExternalAdapterComparisonMode;
  /** Release inspection only: admit the old identity-less schemaVersion 1.0 body. */
  readonly allowLegacyIdentity?: boolean;
  /** CLI preflight only: validate shape/profile before the final experiment digest exists. */
  readonly deferCapabilityBinding?: boolean;
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
  options: ExternalAdapterParseOptions = {},
): ExternalBenchmarkAdapter {
  if (!isRecord(value)) throw new Error("external baseline adapter must be a JSON object");
  const mode = options.mode ?? "backbone_matched";
  const legacyIdentity = value.schemaVersion === "1.0" && value.identity === undefined;
  if (value.schemaVersion !== "1.1" && !(legacyIdentity && options.allowLegacyIdentity === true)) {
    throw new Error("external baseline adapter schemaVersion must be 1.1 with an identity");
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("external baseline adapter needs a non-empty id");
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
  const appliedProfile = parseEvalProfile(value.appliedProfile);
  if (mode === "backbone_matched" && canonicalValue(appliedProfile) !== canonicalValue(expectedProfile)) {
    throw new Error("external baseline adapter profile does not match the requested comparison profile");
  }
  const identity = legacyIdentity
    ? legacyAdapterIdentity(value, appliedProfile)
    : parseExternalAdapterIdentity(value.identity);
  if (identity.mode !== mode) {
    throw new Error(`external baseline adapter identity mode must be ${mode}`);
  }
  if (identity.model !== appliedProfile.model) {
    throw new Error("external baseline adapter identity model must match appliedProfile.model");
  }
  const declaredCapabilityDigest = value.capabilityDigest;
  const capabilityDigest = mode === "backbone_matched" && declaredCapabilityDigest === undefined
    ? expectedCapabilityDigest
    : declaredCapabilityDigest;
  if (
    typeof capabilityDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(capabilityDigest)
  ) {
    throw new Error("external baseline adapter capabilityDigest must be sha256:<64 lowercase hex>");
  }
  if (
    mode === "backbone_matched" &&
    options.deferCapabilityBinding !== true &&
    capabilityDigest !== expectedCapabilityDigest
  ) {
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
    schemaVersion: "1.1" as const,
    id: value.id,
    identity,
    program: value.program,
    args: [...value.args] as string[],
    appliedProfile,
    capabilityDigest,
    implementationDigest: value.implementationDigest,
    passEnvironment: environmentNames,
  };
  const legacyManifest = legacyIdentity
    ? {
        schemaVersion: "1.0" as const,
        id: value.id,
        version: identity.version,
        program: value.program,
        args: [...value.args] as string[],
        appliedProfile,
        capabilityDigest,
        implementationDigest: value.implementationDigest,
        passEnvironment: environmentNames,
      }
    : undefined;
  const manifestDigest = sha256(canonicalValue(legacyManifest ?? manifest));
  if (value.manifestDigest !== undefined && value.manifestDigest !== manifestDigest) {
    throw new Error("external baseline adapter manifestDigest does not match its canonical body");
  }
  return {
    ...(legacyIdentity
      ? {
          ...manifest,
          schemaVersion: "1.0" as const,
          legacyIdentity: true as const,
        }
      : manifest),
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
            ...(task.permissionMode !== undefined ? { permissionMode: task.permissionMode } : {}),
            approvalCommands: benchmarkApprovalCommands(task),
          }),
          "utf8",
        );
        configByWorkspace.set(normalizedWorkspace, configRoot);
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

    execute: async ({ task, workspace, signal }) => {
      const configRoot = configByWorkspace.get(workspace);
      if (configRoot === undefined) {
        throw new Error(`benchmark configuration is missing for workspace ${workspace}`);
      }
      return await executeTask({
        task,
        workspace,
        signal,
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
    capabilityDigest: input.adapter.capabilityDigest,
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
      version: input.adapter.identity.version,
      identity: input.adapter.identity,
      manifestDigest: input.adapter.manifestDigest,
      implementationDigest: input.adapter.implementationDigest,
    },
    task: {
      id: input.task.id,
      category: input.task.category,
      language: input.task.language,
      prompt: input.task.prompt,
      // §5.27: an adapter that cannot script a follow-up must fail rather than answer
      // the first prompt only, which is why the field is sent rather than dropped.
      ...(input.task.followUpPrompts !== undefined
        ? { followUpPrompts: input.task.followUpPrompts }
        : {}),
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
      1 + (input.task.followUpPrompts?.length ?? 0),
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
  expectedTurns: number,
): Omit<ExternalTaskExecutionEnvelope, "events"> & { readonly events: readonly CbcEvent[] } {
  if (!isRecord(value) || value.schemaVersion !== "1.0") {
    throw new Error("external adapter output must be a schemaVersion 1.0 object");
  }
  const provenanceMatches =
    value.executionId === expectedExecutionId &&
    value.adapterId === adapter.id &&
    value.adapterVersion === adapter.identity.version &&
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
  if (terminalTurns !== expectedTurns) {
    throw new Error(
      `external adapter CBC events must contain exactly ${expectedTurns} terminal turn event(s)`,
    );
  }

  return {
    schemaVersion: "1.0",
    executionId: expectedExecutionId,
    adapterId: adapter.id,
    adapterVersion: adapter.identity.version,
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
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly environment: Record<string, string>;
}

/**
  * Run one task, including any §5.27 scripted follow-up prompt.
 *
 * A redirect task is not expressible with a single prompt, so each follow-up is
 * submitted as a further request against the same workspace once the previous one
 * settles, and every turn's events are concatenated into one execution. The metrics
 * derivation reads the last terminal turn, so the redirected goal is the one scored.
 *
 * Boundary worth stating plainly: this is a between-turn goal change, not an interrupt
 * delivered while the model is mid-turn. §11.10's `interrupt_and_redirect` needs a
 * submit handle the headless entry point does not expose, so a task measured this way
 * proves the loop honors a superseding instruction, not that it can be interrupted.
 */
async function executeTask(input: ExecuteTaskInput): Promise<TaskExecution> {
  const events: CbcEvent[] = [];
  const transcript: string[] = [];
  const host = benchmarkHost(input.workspace, input.environment, transcript);
  const context = new CommandContext({
    host,
    version: "cbc-bench",
    nonInteractive: true,
  });
  // Benchmark fixtures are generated by this repository and live only for the run.
  // Grant invocation-scoped trust without restoring the removed public trust command.
  context.setTrust("trusted-once");

  const prompts = [input.task.prompt, ...(input.task.followUpPrompts ?? [])];
  const startedAtMs = Date.now();
  let exitCode = 1;
  try {
    for (const prompt of prompts) {
      const result = await runHeadlessly(context, {
        prompt,
        signal: input.signal,
        onEvent: (event) => events.push(event),
      });
      exitCode = result.code;
      // A failed or cancelled turn makes the follow-up meaningless: the redirect would
      // be measured against a run that never reached the state it redirects from.
      if (exitCode !== 0 || input.signal.aborted) break;
    }
  } catch (error) {
    transcript.push(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    await context.shutdown();
  }
  const finishedAtMs = Date.now();

  if (events.length === 0) {
    console.error(
      `  ${input.task.id}: no events; diagnostics were:\n${indent(transcript.join("").slice(0, 1200))}`,
    );
  }

  return { events, startedAtMs, finishedAtMs, exitCode };
}

function benchmarkHost(
  workspace: string,
  environment: Record<string, string>,
  transcript: string[],
): Host {
  const base = createBunHost("cbc-bench");
  const io: HostIo = {
    stdout: (text) => {
      transcript.push(text);
      return true;
    },
    stderr: (text) => transcript.push(text),
    readStdin: async () => "",
    prompt: async () => "",
    select: async () => -1,
    isTty: false,
    columns: 80,
    rows: 24,
  };
  return {
    ...base,
    io,
    cwd: workspace,
    env: { ...base.env, ...environment },
    exit: (code): never => {
      throw new Error(`cbc-bench host attempted to exit with ${code}`);
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExternalAdapterIdentity(value: unknown): ExternalAdapterIdentity {
  if (!isRecord(value)) {
    throw new Error("external baseline adapter identity must be an object");
  }
  const product = boundedIdentityText(value.product, "identity.product", 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(product)) {
    throw new Error("external baseline adapter identity.product must be a stable lowercase product id");
  }
  const version = stableVersion(value.version);
  const model = boundedIdentityText(value.model, "identity.model", 256);
  const authSurface = boundedIdentityText(value.authSurface, "identity.authSurface", 256);
  const mode = value.mode;
  if (mode !== "backbone_matched" && mode !== "product_native") {
    throw new Error("external baseline adapter identity.mode must be backbone_matched or product_native");
  }
  return { product, version, model, authSurface, mode };
}

function legacyAdapterIdentity(
  value: Record<string, unknown>,
  appliedProfile: EvalProfile,
): ExternalAdapterIdentity {
  return {
    product: "codex_cli",
    version: stableVersion(value.version),
    model: appliedProfile.model,
    authSurface: "legacy-unspecified",
    mode: "backbone_matched",
  };
}

function stableVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)
  ) {
    throw new Error("external baseline adapter needs a stable version label");
  }
  return value;
}

function boundedIdentityText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`external baseline adapter ${field} must be bounded non-empty text`);
  }
  return value;
}

function parseEvalProfile(value: unknown): EvalProfile {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.description !== "string" ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    (value.reasoningMode !== "standard" && value.reasoningMode !== "pro") ||
    !["none", "low", "medium", "high", "xhigh", "max"].includes(String(value.reasoningEffort)) ||
    typeof value.autoReview !== "boolean" ||
    typeof value.toolDiscovery !== "boolean" ||
    typeof value.subagents !== "boolean" ||
    !["off", "prefix", "aggressive"].includes(String(value.promptCache))
  ) {
    throw new Error("external baseline adapter appliedProfile is not a complete eval profile");
  }
  return {
    id: value.id,
    description: value.description,
    model: value.model,
    reasoningMode: value.reasoningMode,
    reasoningEffort: value.reasoningEffort as EvalProfile["reasoningEffort"],
    autoReview: value.autoReview,
    toolDiscovery: value.toolDiscovery,
    subagents: value.subagents,
    promptCache: value.promptCache as EvalProfile["promptCache"],
  };
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
