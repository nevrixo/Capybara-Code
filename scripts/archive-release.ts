#!/usr/bin/env bun
/** Create a native-platform archive from a verified standalone stage. */

import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  PRODUCT_PACKAGE,
  ROOT,
  assertStandaloneArtifact,
  releaseStageDirectory,
  releaseTarget,
  type ReleaseTargetName,
  verifyReleaseVersion,
} from "./release-common.ts";

interface ArchiveOptions {
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

export function parseOptions(argv: readonly string[]): ArchiveOptions {
  const targetValue = valueFor(argv, "--target");
  if (targetValue === undefined || targetValue.startsWith("--")) {
    throw new Error("--target <target> is required");
  }
  const targetName = targetValue as ReleaseTargetName;
  releaseTarget(targetName);
  const outValue = valueFor(argv, "--out");
  const versionValue = valueFor(argv, "--version");
  if (versionValue === "") throw new Error("--version requires a value");
  return {
    targetName,
    outDirectory: resolve(outValue ?? join(ROOT, "dist")),
    ...(versionValue === undefined ? {} : { expectedVersion: versionValue }),
  };
}

export function archiveNameFor(version: string, targetName: ReleaseTargetName, platform = process.platform): string {
  const extension = platform === "win32" ? "zip" : "tar.gz";
  return `${PRODUCT_PACKAGE}-${version}-${targetName}.${extension}`;
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function assertFile(path: string): Promise<void> {
  if ((await stat(path).catch(() => undefined))?.isFile() !== true) {
    throw new Error(`archive was not created: ${path}`);
  }
}

export async function archiveRelease(
  outDirectory: string,
  targetName: ReleaseTargetName,
  version: string,
  platform = process.platform,
): Promise<string> {
  const stage = releaseStageDirectory(outDirectory, version, targetName);
  await assertStandaloneArtifact(stage, targetName, version);

  const releaseDirectory = join(outDirectory, "release");
  const archive = join(releaseDirectory, archiveNameFor(version, targetName, platform));
  await mkdir(releaseDirectory, { recursive: true });
  await rm(archive, { force: true });

  const command = platform === "win32"
    ? [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -LiteralPath ${powerShellLiteral(stage)} -DestinationPath ${powerShellLiteral(archive)} -Force`,
    ]
    : ["tar", "-czf", archive, "-C", dirname(stage), basename(stage)];
  const processResult = Bun.spawn({ cmd: command, cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const exitCode = await processResult.exited;
  if (exitCode !== 0) throw new Error(`archive command failed with exit ${exitCode}`);
  await assertFile(archive);
  return archive;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseOptions(argv);
    const version = await verifyReleaseVersion(options.expectedVersion);
    const archive = await archiveRelease(options.outDirectory, options.targetName, version);
    console.log(`created release archive: ${archive}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
