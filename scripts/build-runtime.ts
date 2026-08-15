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
import { dirname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/+$/, "");

function pathVariants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return [];
  return [...new Set([
    trimmed,
    trimmed.replaceAll("\\", "/"),
    trimmed.replaceAll("/", "\\"),
  ])];
}

function quoteRustFlag(flag: string): string {
  return /\s/.test(flag) ? JSON.stringify(flag) : flag;
}

/**
 * MSVC's link.exe can fail while processing large generated unwind tables on
 * some Windows toolchain revisions. The Rust toolchain ships a compatible
 * linker, so prefer it when the caller has not explicitly selected one.
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
  return [...flags];
}

export async function buildRuntime(): Promise<number> {
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
  return await child.exited;
}

if (import.meta.main) {
  process.exit(await buildRuntime());
}