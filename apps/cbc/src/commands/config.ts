/** Low-level global configuration setter and the key-status explainer. */

import { configKeyStatusEntries } from "@cbc/config-schema";

import { configError, EXIT } from "../exit.ts";
import { setUserConfigValue } from "../state.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";
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

export interface ConfigValidateArgs {
  readonly explain: boolean;
}

/**
 * `capy config validate [--explain]`.
 *
 * `--explain` makes good on the promise in key-status.ts's own doc comment:
 * the registry was built to be rendered and had no non-test consumer, so a key
 * marked experimental warned once at load and was otherwise indistinguishable
 * from a wired one. §5.18 treats that as an overclaim — the point of recording
 * a key's status is that a user can ask.
 */
export async function configValidate(
  context: CommandContext,
  args: ConfigValidateArgs,
): Promise<CommandResult> {
  const loaded = await context.config();
  const errors = loaded.issues.filter((issue) => issue.severity === "error");
  const warnings = loaded.issues.filter((issue) => issue.severity === "warning");

  for (const issue of errors) context.out(`error   ${issue.path}: ${issue.message} (${issue.source})`);
  for (const issue of warnings) context.out(`warning ${issue.path}: ${issue.message} (${issue.source})`);
  if (loaded.issues.length === 0) context.out("Configuration is valid.");

  if (args.explain) {
    context.out("");
    context.outLines(renderKeyStatusExplanation(loaded.provenance));
  }
  return { code: errors.length > 0 ? EXIT.config : EXIT.ok };
}

/**
 * Every registered key with its status and either its consumer or the reason it
 * is inert, with the keys this config actually set marked.
 *
 * The whole table is rendered rather than only the set keys: the question this
 * answers is often "would setting X do anything?", which is unanswerable from a
 * list of what is already set. The `*` marker keeps the user's own keys findable
 * inside it.
 */
export function renderKeyStatusExplanation(
  provenance: Readonly<Record<string, string>>,
): readonly string[] {
  const lines = [
    "Configuration key status (* = set by this configuration)",
    "",
  ];
  const set = new Set(Object.keys(provenance));
  for (const [key, info] of configKeyStatusEntries()) {
    // A section prefix ends in `.` and covers every key beneath it, so it is
    // "set" when any key under it is.
    const isSet = key.endsWith(".")
      ? [...set].some((candidate) => candidate.startsWith(key))
      : set.has(key);
    const detail = info.consumer !== undefined
      ? `applied by ${info.consumer}`
      : info.note ?? "accepted but not applied";
    lines.push(`${isSet ? "*" : " "} ${key.padEnd(52)} ${info.status.padEnd(13)} ${detail}`);
  }
  return lines;
}
