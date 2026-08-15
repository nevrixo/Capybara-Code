/**
 * `capy config` — PRD §8.1, §21.1, §21.2, §21.3, §21.7.
 *
 * `config get` prints the *effective* value with its provenance, because §21.2's
 * six-layer precedence is otherwise invisible: seeing `permission_mode = "ask"` in a
 * file tells you nothing if an environment variable is overriding it.
 *
 * `config set` always writes the user file. §21.3 forbids project config from
 * carrying credentials and §17.5 forbids it from weakening policy, so a `set` that
 * targeted the project file would be a way to smuggle either into a repository.
 */

import {
  configKeyInfo,
  normalizeConfigPath,
  readPath,
  type ConfigIssue,
  type ConfigSource,
} from "@cbc/config-schema";

import { configError, EXIT } from "../exit.ts";
import { setUserConfigValue } from "../state.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export interface ConfigGetArgs {
  readonly path?: string;
}

export async function configGet(
  context: CommandContext,
  args: ConfigGetArgs,
): Promise<CommandResult> {
  const loaded = await context.config();

  if (args.path === undefined) {
    context.out(JSON.stringify(loaded.config, jsonReplacer, 2));
    return ok();
  }

  const canonicalPath = normalizeConfigPath(args.path);
  const value = readPath(loaded.config, canonicalPath);
  if (value === undefined) {
    throw configError(`no such config path '${args.path}'`, [
      "Run `capy config get` with no argument to see the whole effective config.",
    ]);
  }

  const source = loaded.provenance[canonicalPath];
  context.out(typeof value === "string" ? value : JSON.stringify(value, jsonReplacer, 2));
  if (source !== undefined) context.warn(`(from ${source})`);
  return ok();
}

export interface ConfigSetArgs {
  readonly path: string;
  readonly value: string;
}

export async function configSet(
  context: CommandContext,
  args: ConfigSetArgs,
): Promise<CommandResult> {
  const result = await setUserConfigValue(context.host, args.path, args.value);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw configError(
      `${args.path} was not written`,
      errors.map((issue) => `  ${issue.message}`),
    );
  }
  context.out(`Set ${args.path} = ${args.value}`);
  context.out(`Wrote ${result.written}`);
  for (const issue of result.issues) {
    context.warn(`warning: ${issue.path}: ${issue.message}`);
  }
  return ok();
}

export async function configPath(context: CommandContext): Promise<CommandResult> {
  context.out(context.paths.configFile);
  return ok();
}

/** §21.1's resolved locations, all of them. */
export async function configPaths(context: CommandContext): Promise<CommandResult> {
  const paths = context.paths;
  const rows: Array<[string, string]> = [
    ["config", paths.config],
    ["config file", paths.configFile],
    ["data", paths.data],
    ["cache", paths.cache],
    ["logs", paths.logs],
    ["sessions", paths.sessions],
    ["artifacts", paths.artifacts],
    ["agents", paths.agents],
    ["skills", paths.skills],
    ["trust store", paths.trustStore],
    ["bundled share", paths.share],
    ["runtime binary", paths.runtimeBinary],
    ["project config", `${context.workspacePath}/.capybara/config.toml`],
    ["project local config", `${context.workspacePath}/.capybara/config.local.toml`],
    ["global instructions", `${paths.config}/AGENTS.md`],
    ["global override", `${paths.config}/AGENTS.override.md`],
  ];
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  context.outLines(rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`));
  return ok();
}

export interface ConfigValidateArgs {
  readonly explain?: boolean;
}

/** §21.7 validation, including the project-layer trust gate. */
export async function configValidate(
  context: CommandContext,
  args: ConfigValidateArgs = {},
): Promise<CommandResult> {
  const loaded = await context.config();
  const lines: string[] = [];

  lines.push(`User config          ${loaded.userConfigPath}`);
  lines.push(`Project config       ${loaded.projectConfigPath}`);
  lines.push(`Project local config ${loaded.projectLocalConfigPath}`);
  lines.push(
    `Project layer        ${
      loaded.projectLayerApplied
        ? "applied"
        : `not applied (trust: ${loaded.trust})`
    }`,
  );
  lines.push(
    `Project-local layer  ${
      loaded.projectLocalLayerApplied
        ? "applied"
        : `not applied (trust: ${loaded.trust})`
    }`,
  );
  lines.push("");

  for (const issue of loaded.tomlIssues) {
    lines.push(`${issue.source}:${issue.line}  syntax: ${issue.message}`);
  }

  const errors = loaded.issues.filter((issue) => issue.severity === "error");
  const warnings = loaded.issues.filter((issue) => issue.severity === "warning");

  for (const issue of [...errors, ...warnings]) {
    lines.push(`${issue.severity === "error" ? "error" : "warn "}  ${issue.path}: ${issue.message} (${issue.source})`);
  }

  if (errors.length === 0 && warnings.length === 0 && loaded.tomlIssues.length === 0) {
    lines.push("No problems found.");
  } else {
    lines.push("");
    lines.push(`${errors.length} error(s), ${warnings.length} warning(s), ${loaded.tomlIssues.length} syntax issue(s)`);
  }

  if (args.explain === true) {
    lines.push(...explainKeyStatus(loaded.provenance));
  }

  context.outLines(lines);
  // A syntax issue means part of the file was skipped, which is a config error even
  // when the surviving values happen to validate.
  return errors.length > 0 || loaded.tomlIssues.length > 0 ? { code: EXIT.config } : ok();
}

/**
 * P1-04: for every key an explicit layer set, state its status and who consumes
 * it. `wired` means a named consumer applies the value; `experimental` means the
 * schema accepts it but nothing reads it yet, so setting it changed nothing.
 */
function explainKeyStatus(provenance: Record<string, ConfigSource>): string[] {
  const lines: string[] = ["", "Key status (explicitly set keys)", ""];
  const entries = Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    lines.push("No keys were set explicitly; everything is at its default.");
    return lines;
  }

  const statusWidth = "experimental".length;
  let notApplied = 0;
  for (const [path, source] of entries) {
    const info = configKeyInfo(path);
    const status = info?.status ?? "unknown";
    if (status === "experimental" || status === "unknown") notApplied += 1;
    const detail = info?.consumer ?? info?.note ?? (status === "unknown" ? "not in the schema's status registry" : "");
    lines.push(
      `${status.padEnd(statusWidth)}  ${path}  (from ${source})${detail.length > 0 ? `  — ${detail}` : ""}`,
    );
  }
  if (notApplied > 0) {
    lines.push("");
    lines.push(
      `${notApplied} of these key(s) are accepted but not applied yet; setting them changed no behaviour.`,
    );
  }
  return lines;
}

/** `Map` is used in the view model but not in config; kept for JSON safety. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

export async function configSources(context: CommandContext): Promise<CommandResult> {
  const loaded = await context.config();
  const lines: string[] = [];
  lines.push("Effective config sources (highest wins)");
  lines.push(`  default`);
  lines.push(`  user            ${loaded.userConfigPath}`);
  lines.push(`  project         ${loaded.projectConfigPath} ${loaded.projectLayerApplied ? "(applied)" : `(not applied: ${loaded.trust})`}`);
  lines.push(`  project-local   ${loaded.projectLocalConfigPath} ${loaded.projectLocalLayerApplied ? "(applied)" : `(not applied: ${loaded.trust})`}`);
  lines.push(`  environment     (CBC_* / NO_COLOR)`);
  lines.push(`  cli             (--model / --mode flags)`);
  lines.push(`  session         (/model / /mode overrides)`);
  lines.push("");
  lines.push("Instruction sources (first is broadest, last is most specific)");
  lines.push(`  global          ${context.paths.config}/AGENTS.md`);
  lines.push(`  global override ${context.paths.config}/AGENTS.override.md`);
  lines.push(`  project root    ${context.workspacePath}/AGENTS.md`);
  lines.push(`  project root    ${context.workspacePath}/.capybara/AGENT.md (legacy fallback)`);
  lines.push(`  per-directory   <workspace>/**/AGENTS.md (nearest wins via override)`);
  context.outLines(lines);
  return ok();
}

export type { ConfigIssue, ConfigSource };
