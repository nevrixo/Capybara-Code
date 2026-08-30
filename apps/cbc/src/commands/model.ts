/** Refresh the provider capability manifest and select a recommended profile. */

import { profileStrategy } from "@cbc/config-schema";
import { refreshCapabilityManifest } from "@cbc/provider-openai";

import { configError } from "../exit.ts";
import { setUserConfigValue } from "../state.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";
export async function modelRefresh(context: CommandContext): Promise<CommandResult> {
  const result = await refreshCapabilityManifest({
    host: context.host,
    cacheDir: context.paths.cache,
    env: context.host.env,
  });
  if (result.error) context.warn(result.error);
  context.out(`Capability manifest: ${result.source} · ${result.manifest.manifestVersion} · ${result.snapshots.length} model(s)`);
  if (result.refreshed) context.out("Refreshed from remote.");
  else if (result.source === "cache") context.out("Using cached manifest (remote unavailable).");
  else if (result.source === "bundled") context.out("Using bundled manifest.");
  return ok();
}

/**
 * `capy model use profile:<name>` (§6 P1-03).
 *
 * The recommended profiles were unreachable: `model.profiles` held them, but the
 * only way to change a model was `/model`, which pins `model.profile` to `manual`
 * — so the table's rows described settings no user could select. This is the
 * selector, and it writes the profile *name* rather than folding the row's values
 * into `model.default`, because a selected profile has to keep meaning the row
 * even after the row's own defaults change.
 */
export async function modelUseProfile(
  context: CommandContext,
  args: { readonly profile: string },
): Promise<CommandResult> {
  const config = await context.requireConfig();
  const available = Object.keys(config.model.profiles).sort();
  const profile = config.model.profiles[args.profile];
  if (profile === undefined) {
    throw configError(`unknown model profile '${args.profile}'`, [
      `  Available: ${available.join(", ")}`,
    ]);
  }

  const result = await setUserConfigValue(context.host, "model.profile", args.profile);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw configError("model.profile was not written", errors.map((issue) => `  ${issue.message}`));
  }

  // Report all three columns, not just the model: the point of the change is that
  // a profile now decides how the turn runs, and a line naming only the model
  // would describe the profile as it was before P1-03.
  const strategy = profileStrategy(profile);
  context.out(`Profile ${args.profile}: ${profile.model} · ${profile.reasoningMode}/${profile.reasoningEffort}`);
  context.out(`Execution ${strategy.execution} · verification floor ${strategy.verification}`);
  context.out(`Wrote ${result.written}`);
  for (const issue of result.issues) context.warn(`warning: ${issue.path}: ${issue.message}`);
  return ok();
}
