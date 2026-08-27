/**
 * `capy update` — the explicit check (§9.3).
 *
 * Interactive terminals get the same box the startup path shows; `--check`
 * reports through the exit code for scripts: 0 up to date, 2 update available,
 * 1 error. An interactive Update now choice hands the exact version to the
 * npm/Bun launcher, while non-TTY checks remain read-only.
 */

import { EXIT, type ExitCode } from "../exit.ts";
import {
  isDevelopmentCheckout,
  looksLikeSemver,
  resolveUpdate,
  runtimeVersionComparator,
  type UpdateFetcher,
} from "../update-check.ts";
import { requestAutomaticUpdate } from "../update-install.ts";
import { ensureUpdatePrompt, printUpdateGuidance } from "../update-prompt.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

/** §9.3's script contract, deliberately distinct from EXIT.usage. */
const UPDATE_AVAILABLE: ExitCode = 2;
/** Explicit checks get a longer leash than the 1500ms startup cap. */
const EXPLICIT_UPDATE_TIMEOUT_MS = 10_000;

export interface UpdateCommandArgs {
  readonly check?: boolean;
}

export async function updateCommand(
  context: CommandContext,
  args: UpdateCommandArgs,
  options: { readonly fetcher?: UpdateFetcher } = {},
): Promise<CommandResult> {
  const config = await context.requireConfig();
  const updates = config.updates;

  if (!updates.check) {
    context.out("update checks are disabled (updates.check = false or CBC_NO_UPDATE_CHECK)");
    return ok();
  }
  if (isDevelopmentCheckout(context.host)) {
    context.out("running from a development checkout; there is nothing to update");
    return ok();
  }
  if (!looksLikeSemver(context.version)) {
    context.out(`the current version '${context.version}' is not a release version`);
    return ok();
  }

  const result = await resolveUpdate({
    host: context.host,
    paths: context.paths,
    currentVersion: context.version,
    channel: updates.channel,
    intervalHours: updates.intervalHours,
    isNewer: runtimeVersionComparator(context),
    timeoutMs: EXPLICIT_UPDATE_TIMEOUT_MS,
    force: true,
    ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
  });

  const candidate = result.candidate;

  if (candidate === undefined && result.error !== undefined) {
    context.warn(`update check failed: ${result.error}`);
    return { code: EXIT.failure };
  }

  if (args.check === true || context.nonInteractive) {
    if (candidate !== undefined) {
      context.out(`update available: ${candidate.version}`);
      if (args.check !== true) printUpdateGuidance(context, candidate);
      return { code: UPDATE_AVAILABLE };
    }
    context.out(`capy ${context.version} is up to date`);
    return ok();
  }

  if (candidate === undefined) {
    context.out(`capy ${context.version} is up to date`);
    return ok();
  }

  const decision = await ensureUpdatePrompt(context, candidate);
  if (decision === "update") {
    const handoff = await requestAutomaticUpdate(context, candidate);
    if (handoff !== undefined) return handoff;
    printUpdateGuidance(context, candidate);
    return ok();
  }
  context.out(`will remind you about ${candidate.version} the next time capy starts`);
  return ok();
}
