#!/usr/bin/env bun
/** Write a deterministic SHA-256 manifest for GitHub Release assets. */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ROOT, requireDirectory, sha256File, walkFiles } from "./release-common.ts";

export async function checksumLines(directory: string): Promise<string[]> {
  await requireDirectory(directory);
  const files = (await walkFiles(directory)).filter((file) => file !== "SHA256SUMS.txt");
  return Promise.all(files.map(async (file) => `${await sha256File(join(directory, file))}  ${file}`));
}

export async function writeChecksums(directory: string): Promise<string> {
  const lines = await checksumLines(directory);
  if (lines.length === 0) throw new Error(`no release assets found in ${directory}`);
  const destination = join(directory, "SHA256SUMS.txt");
  await writeFile(destination, `${lines.join("\n")}\n`, "utf8");
  return destination;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const index = argv.indexOf("--dir");
    const inline = argv.find((value) => value.startsWith("--dir="));
    const supplied = inline?.slice("--dir=".length) ?? (index === -1 ? undefined : argv[index + 1]);
    if (supplied === "") throw new Error("--dir requires a value");
    const directory = resolve(supplied ?? join(ROOT, "dist", "release"));
    const file = await writeChecksums(directory);
    console.log(`wrote SHA-256 checksums: ${file}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
