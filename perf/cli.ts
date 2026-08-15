#!/usr/bin/env bun

import {
  SCENARIO_NAMES,
  runPerformanceHarness,
  type HarnessMode,
  type ScenarioName,
} from "./harness.ts";

export interface CliOptions {
  readonly mode: HarnessMode;
  readonly pretty: boolean;
  readonly scenarios?: readonly ScenarioName[];
  readonly help: boolean;
  readonly list: boolean;
}

const usage = `Capybara Code performance regression harness

Usage:
  bun run perf/cli.ts [--quick] [--pretty] [--scenario NAME[,NAME...]]
  bun run perf/cli.ts --list

Options:
  --quick             Smaller smoke sizes (full mode uses 10k/100k histories).
  --pretty            Pretty-print the JSON report.
  --scenario NAME     Run one or more named scenarios; repeat or comma-separate.
  --list              Print scenario names as JSON and exit.
  --help, -h          Show this help.

The process exits 1 when any deterministic gate fails. Timings are diagnostics.
`;

export function parseCliArgs(args: readonly string[]): CliOptions {
  let mode: HarnessMode = "full";
  let pretty = false;
  let help = false;
  let list = false;
  const selected: ScenarioName[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--quick") {
      mode = "quick";
    } else if (arg === "--pretty") {
      pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--scenario" || arg.startsWith("--scenario=")) {
      const raw = arg === "--scenario" ? args[++index] : arg.slice("--scenario=".length);
      if (raw === undefined || raw.length === 0) {
        throw new Error("--scenario requires a name");
      }
      for (const name of raw.split(",")) {
        if (!(SCENARIO_NAMES as readonly string[]).includes(name)) {
          throw new Error(`unknown scenario ${name}; use --list`);
        }
        if (!selected.includes(name as ScenarioName)) selected.push(name as ScenarioName);
      }
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  return {
    mode,
    pretty,
    ...(selected.length > 0 ? { scenarios: selected } : {}),
    help,
    list,
  };
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.list) {
    console.log(JSON.stringify({ scenarios: SCENARIO_NAMES }, null, options.pretty ? 2 : undefined));
    return;
  }

  const report = await runPerformanceHarness({
    mode: options.mode,
    ...(options.scenarios !== undefined ? { scenarios: options.scenarios } : {}),
  });
  console.log(JSON.stringify(report, null, options.pretty ? 2 : undefined));
  if (!report.pass) process.exitCode = 1;
}

if (import.meta.main) await main();
