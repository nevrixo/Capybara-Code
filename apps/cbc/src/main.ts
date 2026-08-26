#!/usr/bin/env bun
/** Thin process entry point for the capy CLI. */

import { parseArgs } from "./args.ts";
import { createBunHost } from "./bun-host.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import { route } from "./router.ts";

export const CBC_VERSION = "0.1.1-alpha.7";

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const host = createBunHost(CBC_VERSION);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      host.io.stderr("error: " + error.message + "\n");
      for (const line of error.detail) host.io.stderr(line + "\n");
      return error.code;
    }
    host.io.stderr("error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return EXIT.usage;
  }

  return await route({
    host,
    version: CBC_VERSION,
    command: parsed.command,
  });
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
