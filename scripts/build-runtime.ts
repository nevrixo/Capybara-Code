#!/usr/bin/env bun
/**
 * Build the Rust sidecar for distribution without leaking build-host paths.
 *
 * Rust embeds source paths in some optimized Windows artifacts even when debug
 * information is stripped. Apply remapping to every crate through Cargo's Rust
 * flag environment so the packaged runtime is reproducible and contains only
 * stable virtual prefixes.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/+$/, "");

/** Generate path variants with forward and backward slashes for remapping. */
function pathVariants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return [];
  return [...new Set([
    trimmed,
    trimmed.replaceAll("\\", "/"),
    trimmed.replaceAll("/", "\\"),
  ])];
}

/** Quote a Rust compiler flag if it contains whitespace. */
function quoteRustFlag(flag: string): string {
  return /\s/.test(flag) ? JSON.stringify(flag) : flag;
}

/** Parse a dotted version string into numeric components. */
function versionParts(version: string): number[] {
  if (!/^\d+(?:\.\d+)+$/.test(version)) {
    throw new Error(`invalid dotted version '${version}'`);
  }
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

/** Compare numeric dotted versions without treating 2.9 as newer than 2.31. */
export function compareDottedVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Parse `getconf GNU_LIBC_VERSION` or common `ldd --version` output. */
export function parseGlibcVersion(output: string): string | undefined {
  return /\b(?:glibc|GLIBC)\s+(\d+(?:\.\d+)+)\b/.exec(output)?.[1]
    ?? /\bGNU C Library[^\d]*(\d+(?:\.\d+)+)\b/i.exec(output)?.[1];
}

/** Find the newest GLIBC symbol required by an ELF binary's readelf output. */
export function newestGlibcSymbolVersion(output: string): string | undefined {
  const versions = [...output.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g)].map((match) => match[1] as string);
  return versions.reduce<string | undefined>((newest, version) => {
    if (newest === undefined || compareDottedVersions(version, newest) > 0) return version;
    return newest;
  }, undefined);
}

/** Reject a release host whose libc is newer than the declared compatibility floor. */
export function assertGlibcBuildHost(baseline: string, output: string): string {
  versionParts(baseline);
  const detected = parseGlibcVersion(output);
  if (detected === undefined) {
    throw new Error(`could not detect glibc while enforcing release baseline ${baseline}`);
  }
  if (compareDottedVersions(detected, baseline) > 0) {
    throw new Error(
      `release host glibc ${detected} is newer than supported baseline ${baseline}; `
      + "build the Linux artifact in the pinned baseline container",
    );
  }
  return detected;
}

/**
 * MSVC's link.exe can fail while processing large generated unwind tables on
 * some Windows toolchain revisions. The Rust toolchain ships a compatible
 * linker, so prefer it when the caller has not explicitly selected one.
 * @returns Path to rust-lld.exe if available, undefined otherwise.
 */
async function bundledRustLld(): Promise<string | undefined> {
  if (process.platform !== "win32" || process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER !== undefined) {
    return undefined;
  }

  const result = Bun.spawnSync({
    cmd: ["rustc", "--print", "target-libdir"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;

  const targetLibDir = new TextDecoder().decode(result.stdout).trim();
  if (targetLibDir.length === 0) return undefined;

  const linker = join(dirname(targetLibDir), "bin", "rust-lld.exe");
  return (await Bun.file(linker).exists()) ? linker : undefined;
}

/** Exported for focused release-build tests. */
export function releaseRuntimeRustFlags(
  root = ROOT,
  homePaths: readonly string[] = [homedir(), process.env.USERPROFILE ?? "", process.env.HOME ?? ""],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const flags = new Set<string>();
  for (const homePath of homePaths) {
    for (const variant of pathVariants(homePath)) {
      flags.add(`--remap-path-prefix=${variant}=/builder-home`);
    }
  }
  for (const variant of pathVariants(root)) {
    flags.add(`--remap-path-prefix=${variant}=/capybara-code`);
  }
  // Avoid requiring a separately installed Visual C++ redistributable. Windows
  // system DLLs remain dynamic; only the compiler runtime is linked statically.
  if (platform === "win32") flags.add("-Ctarget-feature=+crt-static");
  return [...flags];
}

/** Resolve the Cargo target directory from environment or default. */
function cargoTargetDirectory(): string {
  const configured = process.env.CARGO_TARGET_DIR;
  if (configured === undefined || configured.trim().length === 0) return join(ROOT, "target");
  return isAbsolute(configured) ? configured : resolve(ROOT, configured);
}

/** Execute a command and return its stdout, throwing on failure. */
function commandText(command: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited ${result.exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

/** Verify the Linux build host meets the glibc baseline requirement. */
function verifyLinuxBuildHost(baseline: string): void {
  if (process.platform !== "linux") {
    throw new Error("CBC_RELEASE_GLIBC_BASELINE can only be enforced on a Linux build host");
  }
  const detected = assertGlibcBuildHost(baseline, commandText(["getconf", "GNU_LIBC_VERSION"]));
  console.log(`Linux release host glibc ${detected} (maximum ${baseline})`);
}

/** Verify the built runtime does not exceed the glibc baseline requirement. */
function verifyLinuxRuntimeSymbols(baseline: string): void {
  const binary = join(cargoTargetDirectory(), "release", "cbc-runtime");
  const newest = newestGlibcSymbolVersion(commandText(["readelf", "--version-info", binary]));
  if (newest === undefined) {
    throw new Error(`could not find GLIBC requirements in ${binary}`);
  }
  if (compareDottedVersions(newest, baseline) > 0) {
    throw new Error(`cbc-runtime requires GLIBC_${newest}, newer than supported baseline ${baseline}`);
  }
  console.log(`verified cbc-runtime GLIBC requirement ${newest} <= ${baseline}`);
}

export async function buildRuntime(): Promise<number> {
  const glibcBaseline = process.env.CBC_RELEASE_GLIBC_BASELINE?.trim();
  if (glibcBaseline !== undefined && glibcBaseline.length > 0) {
    verifyLinuxBuildHost(glibcBaseline);
  }

  const remapFlags = releaseRuntimeRustFlags();
  const env: Record<string, string | undefined> = { ...process.env };
  const encoded = process.env.CARGO_ENCODED_RUSTFLAGS;
  if (encoded !== undefined) {
    env.CARGO_ENCODED_RUSTFLAGS = [...encoded.split("\x1f").filter(Boolean), ...remapFlags].join("\x1f");
  } else {
    env.RUSTFLAGS = [process.env.RUSTFLAGS, ...remapFlags.map(quoteRustFlag)]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(" ");
  }

  const rustLld = await bundledRustLld();
  if (rustLld !== undefined) {
    env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = rustLld;
    console.log("using Rust's bundled linker for Windows runtime build");
  }

  console.log("building cbc-runtime with local source-path remapping");
  const child = Bun.spawn({
    cmd: ["cargo", "build", "--release", "-p", "cbc-runtime"],
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode === 0 && glibcBaseline !== undefined && glibcBaseline.length > 0) {
    verifyLinuxRuntimeSymbols(glibcBaseline);
  }
  return exitCode;
}

if (import.meta.main) {
  try {
    process.exit(await buildRuntime());
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
