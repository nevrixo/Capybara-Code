/**
 * Package-manager update handoff.
 *
 * The native binary cannot safely replace itself while it is running on Windows.
 * The npm/Bun launcher therefore creates a private request file, starts the native
 * binary, and performs the exact-version install only after that binary exits with
 * EXIT.updateHandoff. Direct archive launches have no handoff and retain the
 * verified manual-install fallback.
 */

import type { CommandContext, CommandResult } from "./commands/context.ts";
import { EXIT } from "./exit.ts";
import type { Host } from "./host.ts";
import type { ReleaseCandidate } from "./update-check.ts";

export const UPDATE_REQUEST_SCHEMA_VERSION = 1;
export const UPDATE_REQUEST_FILE_ENV = "CAPYBARA_UPDATE_REQUEST_FILE";
export const UPDATE_MANAGER_ENV = "CAPYBARA_UPDATE_MANAGER";

export type UpdatePackageManager = "bun" | "npm";

export interface PackageManagerUpdateRequest {
  readonly schemaVersion: typeof UPDATE_REQUEST_SCHEMA_VERSION;
  readonly packageName: "capybara-code";
  readonly version: string;
  readonly tag: string;
}

/** The launcher alone supplies this marker; archive and development runs do not. */
export function automaticUpdateManager(host: Pick<Host, "env">): UpdatePackageManager | undefined {
  const manager = host.env[UPDATE_MANAGER_ENV];
  return manager === "bun" || manager === "npm" ? manager : undefined;
}

/**
 * Write the exact, already-validated GitHub release into the launcher's private
 * request file. Returning EXIT.updateHandoff lets route() stop the runtime before
 * the launcher invokes the package manager.
 */
export async function requestAutomaticUpdate(
  context: CommandContext,
  candidate: ReleaseCandidate,
): Promise<CommandResult | undefined> {
  const manager = automaticUpdateManager(context.host);
  const requestFile = context.host.env[UPDATE_REQUEST_FILE_ENV];
  if (manager === undefined || requestFile === undefined || requestFile.length === 0) return undefined;

  const request: PackageManagerUpdateRequest = {
    schemaVersion: UPDATE_REQUEST_SCHEMA_VERSION,
    packageName: "capybara-code",
    version: candidate.version,
    tag: candidate.tag,
  };

  try {
    await context.host.fs.atomicWrite(requestFile, `${JSON.stringify(request)}\n`);
  } catch (error) {
    context.warn(
      `automatic update could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  context.out("");
  context.out(`Installing Capybara Code ${candidate.version} with ${manager} after this process exits...`);
  return { code: EXIT.updateHandoff };
}
