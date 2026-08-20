#!/usr/bin/env bun
/** Execute the packaged binary and verify its sidecar is resolved relative to bin/. */

import { join, resolve } from "node:path";

import { resolvePaths } from "../apps/cbc/src/host.ts";
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

export async function smokeStage(outDirectory: string, targetName: ReleaseTargetName, version: string): Promise<void> {
  const stage = releaseStageDirectory(outDirectory, version, targetName);
  await assertStandaloneArtifact(stage, targetName, version);
  const target = releaseTarget(targetName);
  const expectedRuntime = join(stage, "libexec", `cbc-runtime${target.executableExtension}`);
  if (normalizePath(runtimePathFor(stage, targetName)) !== normalizePath(expectedRuntime)) {
    throw new Error("packaged runtime is not resolved relative to bin/");
  }

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
