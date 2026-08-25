#!/usr/bin/env bun
/**
 * Register the checkout only as `capy-dev`.
 *
 * Bun's `link --global` links the global project itself on current Windows Bun
 * releases, rather than reliably creating a CLI bin for the source package. We still
 * register/unregister the package through Bun's link registry, then create one
 * verified shim in the native Bun bin directory. Public `capy` is never touched.
 */

import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ROOT, normalizePath, readJson } from "./release-common.ts";

type LinkAction = "link" | "unlink";

const APP_DIRECTORY = join(ROOT, "apps", "cbc");
const SOURCE_ENTRY = join(APP_DIRECTORY, "src", "main.ts");

export function parseAction(argv: readonly string[]): LinkAction {
  const action = argv[0];
  if (action !== "link" && action !== "unlink") {
    throw new Error("usage: bun run dev:link | bun run dev:unlink");
  }
  return action;
}

export function developmentShimPath(
  bunExecutable = process.execPath,
  platform = process.platform,
): string {
  return join(dirname(bunExecutable), platform === "win32" ? "capy-dev.cmd" : "capy-dev");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function developmentShimContents(
  bunExecutable = process.execPath,
  sourceEntry = SOURCE_ENTRY,
  platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "@echo off",
      `"${bunExecutable}" run "${sourceEntry}" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/usr/bin/env sh",
    `exec ${shellQuote(bunExecutable)} run ${shellQuote(sourceEntry)} "$@"`,
    "",
  ].join("\n");
}

async function verifyDevelopmentBin(): Promise<void> {
  const manifest = await readJson<{ bin?: unknown }>(join(APP_DIRECTORY, "package.json"));
  if (typeof manifest.bin !== "object" || manifest.bin === null || (manifest.bin as Record<string, unknown>)["capy-dev"] !== "./src/main.ts") {
    throw new Error("apps/cbc/package.json must expose only capy-dev -> ./src/main.ts for development linking");
  }
}

function hasSourceMarker(contents: string): boolean {
  return [SOURCE_ENTRY, normalizePath(SOURCE_ENTRY)].some((path) => contents.includes(path));
}

async function removeBrokenWindowsBunLink(binDirectory: string): Promise<void> {
  if (process.platform !== "win32") return;
  const metadata = join(binDirectory, "capy-dev.bunx");
  const bytes = await readFile(metadata).catch(() => undefined);
  if (bytes === undefined) return;
  const contents = Buffer.from(bytes).toString("utf16le");
  if (!contents.includes("capybara-code-dev") || !contents.includes("install\\global\\node_modules")) {
    return;
  }
  await Promise.all([
    rm(metadata, { force: true }),
    rm(join(binDirectory, "capy-dev.exe"), { force: true }),
  ]);
}

async function isSourceLinkedShim(shim: string): Promise<boolean> {
  const info = await lstat(shim).catch(() => undefined);
  if (info?.isSymbolicLink() !== true) return false;
  const target = await realpath(shim).catch(() => undefined);
  if (target === undefined || normalizePath(target) !== normalizePath(SOURCE_ENTRY)) {
    throw new Error(`refusing to replace unexpected capy-dev symbolic link: ${shim}`);
  }
  return true;
}

async function writeDevelopmentShim(): Promise<string> {
  const shim = developmentShimPath();
  await mkdir(dirname(shim), { recursive: true });
  await removeBrokenWindowsBunLink(dirname(shim));
  // Native Bun on Linux creates this source symlink itself. Never follow it with
  // writeFile: doing so would overwrite the checkout's main.ts.
  if (await isSourceLinkedShim(shim)) await rm(shim, { force: true });

  const existing = await readFile(shim, "utf8").catch(() => undefined);
  if (existing !== undefined && !hasSourceMarker(existing)) {
    throw new Error(`refusing to replace unexpected capy-dev shim: ${shim}`);
  }
  await writeFile(shim, developmentShimContents(), "utf8");
  await chmod(shim, 0o755).catch(() => undefined);
  return shim;
}

async function removeDevelopmentShim(): Promise<void> {
  const shim = developmentShimPath();
  if (await isSourceLinkedShim(shim)) {
    await rm(shim, { force: true });
  } else {
    const contents = await readFile(shim, "utf8").catch(() => undefined);
    if (contents !== undefined) {
      if (!hasSourceMarker(contents)) {
        throw new Error(`refusing to remove unexpected capy-dev shim: ${shim}`);
      }
      await rm(shim, { force: true });
    }
  }
  await removeBrokenWindowsBunLink(dirname(shim));
}

function runBunRegistryCommand(action: LinkAction): number {
  const result = Bun.spawnSync({
    cmd: [process.execPath, action],
    cwd: APP_DIRECTORY,
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode;
}

export async function runLink(action: LinkAction): Promise<number> {
  await verifyDevelopmentBin();
  if (action === "unlink") {
    await removeDevelopmentShim();
    const exitCode = runBunRegistryCommand("unlink");
    if (exitCode === 0) console.log("removed capy-dev development registration");
    return exitCode;
  }

  const exitCode = runBunRegistryCommand("link");
  if (exitCode !== 0) return exitCode;
  const shim = await writeDevelopmentShim();
  console.log(`registered checkout as capy-dev: ${shim}`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runLink(parseAction(argv));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));