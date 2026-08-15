#!/usr/bin/env bun
/**
 * `capy` entry point — PRD §8.1, §8.9, §19.2, §22.1, AC-40.
 *
 * Deliberately thin. Everything that could fail interestingly lives in a module that
 * a test can drive with a fake `Host`, so this file only does the three things that
 * genuinely belong to a process entry point: read argv, route, and exit with the §8.9
 * code.
 *
 * The version is a literal rather than a read of `package.json`: §19.2 compiles this
 * into a standalone executable, and a runtime file read would resolve against the
 * user's cwd inside that binary.
 */

import { parseArgs } from "./args.ts";
import { createBunHost } from "./bun-host.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import { route } from "./router.ts";

export const CBC_VERSION = "0.1.0-alpha.1";

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const host = createBunHost(CBC_VERSION);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    // Usage errors happen before a `CommandContext` exists, so they are reported
    // directly. stderr, so a `--jsonl` consumer's stdout stays clean (§20.10).
    if (error instanceof CliError) {
      host.io.stderr(`error: ${error.message}\n`);
      for (const line of error.detail) host.io.stderr(`${line}\n`);
      return error.code;
    }
    host.io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.usage;
  }

  return await route({
    host,
    version: CBC_VERSION,
    command: parsed.command,
    warnings: parsed.warnings,
  });
}

// `import.meta.main` is true only when this file is the process entry, so importing
// it from a test does not start a CLI run.
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  // AC-40: the terminal has already been restored by the interactive command's own
  // guards; exiting here is the last step, not a place to do cleanup.
  process.exit(code);
}
