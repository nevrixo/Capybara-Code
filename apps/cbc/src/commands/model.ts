/** Refresh the provider capability manifest. */

import { refreshCapabilityManifest } from "@cbc/provider-openai";

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
