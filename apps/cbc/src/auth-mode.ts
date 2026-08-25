/**
 * The selected OpenAI authentication surface.
 *
 * Only this non-secret preference belongs to Capybara. API keys and account-login
 * tokens remain in CBC's credential store.
 *
 * Two surfaces, both running Capybara's own agent loop:
 *
 *   - `api`     — an API key, CBC's own loop, API billing.
 *   - `account` — an OAuth token from §9.5 account login, CBC's own loop. Reachable
 *                 only when a registration satisfies the §9.6 gate.
 */

import { join, type CbcPaths, type Host } from "./host.ts";

export type OpenAiAuthMode = "api" | "account";

const AUTH_MODES: readonly OpenAiAuthMode[] = ["api", "account"];

function isAuthMode(value: unknown): value is OpenAiAuthMode {
  return typeof value === "string" && AUTH_MODES.includes(value as OpenAiAuthMode);
}

const AUTH_MODE_FILE = "provider.json";

export function authModePath(paths: Pick<CbcPaths, "data">): string {
  return join(paths.data, "auth", AUTH_MODE_FILE);
}

export async function readAuthMode(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
): Promise<OpenAiAuthMode | undefined> {
  const raw = await host.fs.read(authModePath(paths));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown };
    // An unrecognized mode reads as absent rather than as an error: a file written
    // by a newer build should fall back to credential precedence, not fail the run.
    return isAuthMode(parsed.mode) ? parsed.mode : undefined;
  } catch {
    return undefined;
  }
}

export async function writeAuthMode(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
  mode: OpenAiAuthMode,
): Promise<void> {
  await host.fs.mkdirp(join(paths.data, "auth"));
  await host.fs.write(
    authModePath(paths),
    `${JSON.stringify({ version: 1, mode }, null, 2)}\n`,
  );
}

export async function clearAuthMode(
  host: Pick<Host, "fs">,
  paths: Pick<CbcPaths, "data">,
): Promise<void> {
  await host.fs.remove(authModePath(paths));
}
