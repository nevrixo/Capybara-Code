#!/usr/bin/env bun
/** Assemble publishable npm package directories from a verified standalone stage. */

import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  HOMEPAGE_URL,
  PRODUCT_PACKAGE,
  REPOSITORY_URL,
  ROOT,
  assertArtifactSafety,
  assertStandaloneArtifact,
  releaseStageDirectory,
  releaseTarget,
  releaseTargetNames,
  type ReleaseTargetName,
  verifyReleaseVersion,
  walkFiles,
  writeJson,
} from "./release-common.ts";

interface PackageOptions {
  readonly outDirectory: string;
  readonly targetName?: ReleaseTargetName;
  readonly launcher: boolean;
  readonly expectedVersion?: string;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: { readonly type: "git"; readonly url: string };
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly files: readonly string[];
  readonly publishConfig: { readonly access: "public"; readonly tag: "alpha" };
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly bin?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags.set(token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(token, next);
      index += 1;
    } else {
      flags.set(token, true);
    }
  }
  return flags;
}

export function parseOptions(argv: readonly string[]): PackageOptions {
  const flags = parseFlags(argv);
  const targetValue = flags.get("--target");
  const launcher = flags.get("--launcher") === true;
  const targetName = typeof targetValue === "string" ? targetValue as ReleaseTargetName : undefined;

  if ((targetName === undefined) === !launcher) {
    throw new Error("provide exactly one of --target <target> or --launcher");
  }
  if (targetName !== undefined) releaseTarget(targetName);

  const outValue = flags.get("--out");
  const versionValue = flags.get("--version");
  if (versionValue === true) throw new Error("--version requires a value");

  return {
    outDirectory: resolve(typeof outValue === "string" ? outValue : join(ROOT, "dist")),
    ...(targetName === undefined ? {} : { targetName }),
    launcher,
    ...(typeof versionValue === "string" ? { expectedVersion: versionValue } : {}),
  };
}

function packageMetadata(name: string, version: string, description: string): Omit<PackageManifest, "files"> {
  return {
    name,
    version,
    description,
    license: "Apache-2.0",
    repository: { type: "git", url: REPOSITORY_URL },
    homepage: HOMEPAGE_URL,
    bugs: { url: `${HOMEPAGE_URL}/issues` },
    publishConfig: { access: "public", tag: "alpha" },
  };
}

export function platformPackageManifest(targetName: ReleaseTargetName, version: string): PackageManifest {
  const target = releaseTarget(targetName);
  return {
    ...packageMetadata(
      target.npmPackage,
      version,
      `Capybara Code native executable for ${targetName}`,
    ),
    os: [target.platform],
    cpu: [target.arch],
    ...(target.libc === undefined ? {} : { libc: [target.libc] }),
    files: ["bin", "libexec", "share", "manifest.json", "LICENSE"],
  };
}

export function launcherPackageManifest(version: string): PackageManifest {
  return {
    ...packageMetadata(
      PRODUCT_PACKAGE,
      version,
      "Capybara Code Public Alpha launcher",
    ),
    bin: { capy: "bin/capy.cjs" },
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(
      releaseTargetNames().map((targetName) => [releaseTarget(targetName).npmPackage, version]),
    ),
    files: ["bin", "README.md", "LICENSE"],
  };
}

function assertPackageDirectory(directory: string, launcher: boolean): Promise<void> {
  return assertArtifactSafety(directory).then(async () => {
    const files = await walkFiles(directory);
    const allowedFiles = launcher
      ? new Set(["package.json", "README.md", "LICENSE", "bin/capy.cjs"])
      : new Set(["package.json", "LICENSE", "manifest.json"]);
    const allowedPrefixes = launcher ? ["bin/"] : ["bin/", "libexec/", "share/"];
    for (const file of files) {
      if (allowedFiles.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix))) continue;
      throw new Error(`npm package contains an unexpected file: ${file}`);
    }
  });
}

async function prepareDirectory(directory: string): Promise<void> {
  const resolved = resolve(directory);
  const checkout = resolve(ROOT);
  const fromCheckout = relative(checkout, resolved);
  if (fromCheckout.length === 0 || fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout)) {
    throw new Error(`refusing to write npm package outside this checkout: ${directory}`);
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

export async function assemblePlatformPackage(
  outDirectory: string,
  targetName: ReleaseTargetName,
  version: string,
): Promise<string> {
  const stage = releaseStageDirectory(outDirectory, version, targetName);
  await assertStandaloneArtifact(stage, targetName, version);

  const target = releaseTarget(targetName);
  // Keep artifact directories flat even though the published package is scoped.
  // This avoids a shared @ilbie directory when matrix artifacts are merged.
  const destination = join(outDirectory, "npm", target.npmDirectory);
  await prepareDirectory(destination);
  await Promise.all([
    cp(join(stage, "bin"), join(destination, "bin"), { recursive: true }),
    cp(join(stage, "libexec"), join(destination, "libexec"), { recursive: true }),
    cp(join(stage, "share"), join(destination, "share"), { recursive: true }),
    copyFile(join(stage, "manifest.json"), join(destination, "manifest.json")),
    copyFile(join(ROOT, "LICENSE"), join(destination, "LICENSE")),
  ]);
  await writeJson(join(destination, "package.json"), platformPackageManifest(targetName, version));
  await assertPackageDirectory(destination, false);
  return destination;
}

export async function assembleLauncherPackage(outDirectory: string, version: string): Promise<string> {
  const destination = join(outDirectory, "npm", PRODUCT_PACKAGE);
  await prepareDirectory(destination);
  await mkdir(join(destination, "bin"), { recursive: true });
  await Promise.all([
    copyFile(join(ROOT, "scripts", "release-launcher.cjs"), join(destination, "bin", "capy.cjs")),
    copyFile(join(ROOT, "README.md"), join(destination, "README.md")),
    copyFile(join(ROOT, "LICENSE"), join(destination, "LICENSE")),
  ]);
  await chmod(join(destination, "bin", "capy.cjs"), 0o755).catch(() => undefined);
  await writeJson(join(destination, "package.json"), launcherPackageManifest(version));
  await assertPackageDirectory(destination, true);
  return destination;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseOptions(argv);
    const version = await verifyReleaseVersion(options.expectedVersion);
    const directory = options.launcher
      ? await assembleLauncherPackage(options.outDirectory, version)
      : await assemblePlatformPackage(options.outDirectory, options.targetName as ReleaseTargetName, version);
    console.log(`prepared npm package: ${directory}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
