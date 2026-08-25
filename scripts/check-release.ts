#!/usr/bin/env bun
/** Enforce that every release-facing version source agrees with the release tag. */

import { assertAlphaVersion, verifyReleaseVersion, versionFromTag } from "./release-common.ts";

export function expectedVersionFromArgs(argv: readonly string[], environment = process.env): string | undefined {
  const index = argv.findIndex((value) => value === "--version");
  const inline = argv.find((value) => value.startsWith("--version="));
  const supplied = inline?.slice("--version=".length) ?? (index === -1 ? undefined : argv[index + 1]);
  const candidate = supplied ?? environment.GITHUB_REF_NAME;
  if (candidate === undefined || candidate.length === 0) return undefined;
  return candidate.startsWith("v") || candidate.startsWith("refs/tags/")
    ? versionFromTag(candidate)
    : assertAlphaVersion(candidate);
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const expected = expectedVersionFromArgs(argv);
    const version = await verifyReleaseVersion(expected);
    console.log(`release versions agree on ${version}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
