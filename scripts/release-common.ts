#!/usr/bin/env bun
/** Shared release metadata, validation, and artifact-safety helpers. */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/+$/, "");

export const PRODUCT_PACKAGE = "capybara-code";
export const NATIVE_PACKAGE_SCOPE = "@nevrixo";
export const REPOSITORY_URL = "git+https://github.com/nevrixo/Capybara-Code.git";
export const HOMEPAGE_URL = "https://github.com/nevrixo/Capybara-Code";

export interface ReleaseTarget {
  readonly npmPackage: string;
  readonly npmDirectory: string;
  readonly platform: string;
  readonly arch: string;
  readonly executableExtension: "" | ".exe";
  readonly libc?: "glibc";
}

export const RELEASE_TARGETS = {
  "windows-x64": {
    npmPackage: `${NATIVE_PACKAGE_SCOPE}/capybara-code-win32-x64`,
    npmDirectory: "capybara-code-win32-x64",
    platform: "win32",
    arch: "x64",
    executableExtension: ".exe",
  },
  "darwin-x64": {
    npmPackage: `${NATIVE_PACKAGE_SCOPE}/capybara-code-darwin-x64`,
    npmDirectory: "capybara-code-darwin-x64",
    platform: "darwin",
    arch: "x64",
    executableExtension: "",
  },
  "darwin-arm64": {
    npmPackage: `${NATIVE_PACKAGE_SCOPE}/capybara-code-darwin-arm64`,
    npmDirectory: "capybara-code-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    executableExtension: "",
  },
  "linux-x64": {
    npmPackage: `${NATIVE_PACKAGE_SCOPE}/capybara-code-linux-x64`,
    npmDirectory: "capybara-code-linux-x64",
    platform: "linux",
    arch: "x64",
    executableExtension: "",
    libc: "glibc",
  },
} as const satisfies Record<string, ReleaseTarget>;

export type ReleaseTargetName = keyof typeof RELEASE_TARGETS;

const ALPHA_VERSION = /^\d+\.\d+\.\d+-alpha\.\d+$/u;

export interface ReleaseVersions {
  readonly root: string;
  readonly app: string;
  readonly cargo: string;
  readonly cli: string;
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function releaseTargetNames(): ReleaseTargetName[] {
  return Object.keys(RELEASE_TARGETS) as ReleaseTargetName[];
}

export function releaseTarget(name: string): ReleaseTarget {
  const target = RELEASE_TARGETS[name as ReleaseTargetName];
  if (target === undefined) {
    throw new Error(`unknown release target '${name}'; expected one of ${releaseTargetNames().join(", ")}`);
  }
  return target;
}

export function assertAlphaVersion(version: string): string {
  if (!ALPHA_VERSION.test(version)) {
    throw new Error(`expected an alpha version like 0.1.0-alpha.1, received '${version}'`);
  }
  return version;
}

export function versionFromTag(tag: string): string {
  const name = tag.replace(/^refs\/tags\//u, "");
  if (!name.startsWith("v")) {
    throw new Error(`release tag must start with 'v', received '${tag}'`);
  }
  return assertAlphaVersion(name.slice(1));
}

export async function readReleaseVersions(root = ROOT): Promise<ReleaseVersions> {
  const [rootPackage, appPackage, cargo, main] = await Promise.all([
    readJson<{ version?: unknown }>(join(root, "package.json")),
    readJson<{ version?: unknown }>(join(root, "apps", "cbc", "package.json")),
    readFile(join(root, "Cargo.toml"), "utf8"),
    readFile(join(root, "apps", "cbc", "src", "main.ts"), "utf8"),
  ]);

  const cargoMatch = /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"$/mu.exec(cargo);
  const cliMatch = /export const CBC_VERSION\s*=\s*"([^"]+)";/u.exec(main);
  if (typeof rootPackage.version !== "string") throw new Error("package.json has no string version");
  if (typeof appPackage.version !== "string") throw new Error("apps/cbc/package.json has no string version");
  if (cargoMatch?.[1] === undefined) throw new Error("Cargo.toml has no workspace package version");
  if (cliMatch?.[1] === undefined) throw new Error("apps/cbc/src/main.ts has no CBC_VERSION literal");

  return {
    root: rootPackage.version,
    app: appPackage.version,
    cargo: cargoMatch[1],
    cli: cliMatch[1],
  };
}

export function assertReleaseVersions(versions: ReleaseVersions, expected?: string): string {
  const values = Object.values(versions);
  const version = values[0];
  if (version === undefined || values.some((value) => value !== version)) {
    throw new Error(`release versions disagree: ${JSON.stringify(versions)}`);
  }
  assertAlphaVersion(version);
  if (expected !== undefined && version !== expected) {
    throw new Error(`release version '${version}' does not match expected '${expected}'`);
  }
  return version;
}

export async function verifyReleaseVersion(expected?: string, root = ROOT): Promise<string> {
  return assertReleaseVersions(await readReleaseVersions(root), expected);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function walkFiles(directory: string, base = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(full, base));
    } else if (entry.isFile()) {
      files.push(normalizePath(relative(base, full)));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function requireFile(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info?.isFile() !== true) throw new Error(`required file is missing: ${path}`);
}

export async function requireDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory() !== true) throw new Error(`required directory is missing: ${path}`);
}

function localPathVariants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/u, "");
  if (trimmed.length === 0) return [];
  return [...new Set([trimmed, trimmed.replaceAll("\\", "/"), trimmed.replaceAll("/", "\\")])];
}

export async function assertArtifactSafety(
  directory: string,
  // Bun embeds some of its own compiler paths in standalone executables. Those
  // can be rooted at the CI user's home directory, so checking a broad home
  // prefix produces false positives. Check the checkout path instead.
  localPaths: readonly string[] = [ROOT],
): Promise<void> {
  const needles = [...new Set(localPaths.flatMap(localPathVariants))];
  for (const file of await walkFiles(directory)) {
    if (file.endsWith(".map")) throw new Error(`release artifact includes source map: ${file}`);
    if (file === "share/share" || file.startsWith("share/share/")) {
      throw new Error(`release artifact contains duplicated share directory: ${file}`);
    }
    const bytes = await readFile(join(directory, file));
    const text = new TextDecoder().decode(bytes);
    const leaked = needles.find((needle) => text.includes(needle));
    if (leaked !== undefined) {
      throw new Error(`release artifact contains a local build path in ${file}`);
    }
  }
}

export async function assertStandaloneArtifact(
  directory: string,
  targetName: ReleaseTargetName,
  version: string,
): Promise<void> {
  const target = releaseTarget(targetName);
  await requireFile(join(directory, "bin", `capy${target.executableExtension}`));
  await requireFile(join(directory, "libexec", `cbc-runtime${target.executableExtension}`));
  await requireDirectory(join(directory, "share", "capybara"));
  await requireFile(join(directory, "manifest.json"));

  const manifest = await readJson<{ productVersion?: unknown; target?: unknown; compiled?: unknown }>(
    join(directory, "manifest.json"),
  );
  if (manifest.productVersion !== version || manifest.target !== targetName || manifest.compiled !== true) {
    throw new Error(`standalone manifest does not describe ${targetName} ${version}`);
  }
  await assertArtifactSafety(directory);
}

export async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await readFile(path));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function releaseStageDirectory(outDirectory: string, version: string, targetName: ReleaseTargetName): string {
  return resolve(outDirectory, `${PRODUCT_PACKAGE}-${version}-${targetName}`);
}
