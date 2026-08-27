#!/usr/bin/env bun
/** Execute the packaged binary and verify its sidecar is resolved relative to bin/. */

import { RuntimeClient } from "@cbc/protocol";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolvePaths } from "../apps/cbc/src/host.ts";
import { createRuntimeSpawner } from "../apps/cbc/src/runtime.ts";
import {
  ROOT,
  assertStandaloneArtifact,
  normalizePath,
  releaseStageDirectory,
  releaseTarget,
  type ReleaseTargetName,
  verifyReleaseVersion,
} from "./release-common.ts";

interface SmokeOptions {
  readonly targetName: ReleaseTargetName;
  readonly outDirectory: string;
  readonly expectedVersion?: string;
}

/** Extract a flag value from argv, supporting both --flag=value and --flag value syntax. */
function valueFor(argv: readonly string[], flag: string): string | undefined {
  const inline = argv.find((value) => value.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function parseOptions(argv: readonly string[]): SmokeOptions {
  const targetValue = valueFor(argv, "--target");
  if (targetValue === undefined || targetValue.startsWith("--")) throw new Error("--target <target> is required");
  const targetName = targetValue as ReleaseTargetName;
  releaseTarget(targetName);
  const outValue = valueFor(argv, "--out");
  const versionValue = valueFor(argv, "--version");
  return {
    targetName,
    outDirectory: resolve(outValue ?? join(ROOT, "dist")),
    ...(versionValue === undefined ? {} : { expectedVersion: versionValue }),
  };
}

export function runtimePathFor(stage: string, targetName: ReleaseTargetName): string {
  const target = releaseTarget(targetName);
  return resolvePaths({
    env: {},
    homeDir: "/tmp/capy-smoke-home",
    platform: target.platform,
    executableDir: join(stage, "bin"),
  }).runtimeBinary;
}

/** Map release target to runtime platform and architecture identifiers. */
function runtimeIdentity(targetName: ReleaseTargetName): { platform: string; arch: string } {
  const target = releaseTarget(targetName);
  return {
    platform: target.platform === "win32" ? "windows" : target.platform === "darwin" ? "macos" : "linux",
    arch: target.arch === "x64" ? "x86_64" : "aarch64",
  };
}

/** Verify runtime identity matches expected target platform and architecture. */
function assertRuntimeIdentity(
  value: unknown,
  targetName: ReleaseTargetName,
  source: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} did not return an object`);
  }
  const report = value as Record<string, unknown>;
  const expected = runtimeIdentity(targetName);
  if (report.platform !== expected.platform || report.arch !== expected.arch) {
    throw new Error(
      `${source} reported ${String(report.platform)}/${String(report.arch)}; `
      + `expected ${expected.platform}/${expected.arch}`,
    );
  }
}

/** Execute a binary with arguments and return combined stdout/stderr, throwing on failure. */
async function execute(binary: string, args: readonly string[]): Promise<string> {
  const processResult = Bun.spawn({
    cmd: [binary, ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CBC_NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${binary} ${args.join(" ")} exited ${exitCode}: ${stderr}`);
  return `${stdout}${stderr}`;
}

/** Test runtime handshake by starting the runtime client and verifying initialization. */
async function smokeRuntimeHandshake(
  binary: string,
  targetName: ReleaseTargetName,
  version: string,
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "capy-runtime-smoke-"));
  const workspace = join(temporaryRoot, "workspace");
  const dataDir = join(temporaryRoot, "data");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);

  const stderrLines: string[] = [];
  const spawnRuntime = createRuntimeSpawner({ workspace, dataDir });
  let killSpawned: (() => void) | undefined;
  let started = false;
  const client = new RuntimeClient(
    {
      runtimeBinary: binary,
      workspace,
      dataDir,
      clientVersion: version,
      pty: false,
      sandboxLevel: "none",
      requestTimeoutMs: 15_000,
      onStderr: (line) => stderrLines.push(line),
    },
    (runtimeBinary) => {
      const child = spawnRuntime(runtimeBinary);
      killSpawned = () => child.kill();
      return child;
    },
  );

  try {
    const initialized = await client.start();
    started = true;
    if (initialized.runtimeVersion !== version) {
      throw new Error(`runtime.initialize reported ${initialized.runtimeVersion}; expected ${version}`);
    }
    assertRuntimeIdentity(initialized.capabilities, targetName, "runtime.initialize");
  } catch (error) {
    const stderr = stderrLines.join("\n").trim();
    throw new Error(
      `packaged runtime did not complete runtime.initialize: `
      + `${error instanceof Error ? error.message : String(error)}`
      + (stderr.length === 0 ? "" : `\nsidecar stderr:\n${stderr}`),
    );
  } finally {
    if (started) {
      await client.stop();
    } else {
      try {
        killSpawned?.();
      } catch {
        // The process may already have exited before the handshake.
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function smokeStage(outDirectory: string, targetName: ReleaseTargetName, version: string): Promise<void> {
  const stage = releaseStageDirectory(outDirectory, version, targetName);
  await assertStandaloneArtifact(stage, targetName, version);
  const target = releaseTarget(targetName);
  const expectedRuntime = join(stage, "libexec", `cbc-runtime${target.executableExtension}`);
  if (normalizePath(runtimePathFor(stage, targetName)) !== normalizePath(expectedRuntime)) {
    throw new Error("packaged runtime is not resolved relative to bin/");
  }

  const runtimeVersionOutput = await execute(expectedRuntime, ["--version"]);
  if (!runtimeVersionOutput.includes(version)) {
    throw new Error(`cbc-runtime --version did not report ${version}`);
  }
  const capabilitiesOutput = await execute(expectedRuntime, ["--capabilities"]);
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(capabilitiesOutput);
  } catch {
    throw new Error("cbc-runtime --capabilities did not return valid JSON");
  }
  assertRuntimeIdentity(capabilities, targetName, "cbc-runtime --capabilities");
  await smokeRuntimeHandshake(expectedRuntime, targetName, version);

  const binary = join(stage, "bin", `capy${target.executableExtension}`);
  const versionOutput = await execute(binary, ["version"]);
  if (!versionOutput.includes(version)) throw new Error(`version did not report ${version}`);
  const helpOutput = await execute(binary, ["help"]);
  if (!helpOutput.toLowerCase().includes("capy")) throw new Error("help did not identify capy");
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseOptions(argv);
    const version = await verifyReleaseVersion(options.expectedVersion);
    await smokeStage(options.outDirectory, options.targetName, version);
    console.log(`smoke test passed: ${options.targetName}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
