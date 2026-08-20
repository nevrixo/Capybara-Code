/** Low-level global configuration setter. */

import { configError } from "../exit.ts";
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
