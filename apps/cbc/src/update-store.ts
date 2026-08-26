/**
 * Persistent update state — the `updates.json` cache and skip list.
 *
 * Lives in the user data directory beside the trust store and never inside a
 * project tree: the update policy is global, and a workspace cannot rewrite it.
 * A corrupt or unknown store fails closed to an empty store, exactly like the
 * trust store — a damaged skip list must not become "skip everything".
 */

import { join, type CbcPaths, type Host } from "./host.ts";

export interface UpdateLastKnown {
  readonly version: string;
  readonly tag: string;
  readonly htmlUrl?: string;
  readonly publishedAt?: string;
}

export interface UpdateSkipRecord {
  readonly decidedAt: string;
}

export interface UpdateStore {
  readonly version: 1;
  /** ISO timestamp of the last successful GitHub metadata read. */
  readonly lastCheckAt?: string;
  /** The newest release seen so far, whether or not it was skipped. */
  readonly lastKnown?: UpdateLastKnown;
  /** Keys are normalized semver strings (no `v` prefix). */
  readonly skippedVersions: Readonly<Record<string, UpdateSkipRecord>>;
}

export function emptyUpdateStore(): UpdateStore {
  return { version: 1, skippedVersions: {} };
}

export function updateStorePath(paths: CbcPaths): string {
  return join(paths.data, "updates.json");
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** Read the store; anything malformed is dropped rather than trusted. */
export async function readUpdateStore(host: Host, paths: CbcPaths): Promise<UpdateStore> {
  const text = await host.fs.read(updateStorePath(paths));
  if (text === undefined) return emptyUpdateStore();
  try {
    return parseUpdateStore(JSON.parse(text));
  } catch {
    return emptyUpdateStore();
  }
}

export function parseUpdateStore(parsed: unknown): UpdateStore {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyUpdateStore();
  const record = parsed as Record<string, unknown>;
  // An unknown schema version fails closed, mirroring the trust store.
  if (record.version !== 1) return emptyUpdateStore();

  let lastCheckAt: string | undefined;
  if (typeof record.lastCheckAt === "string" && Number.isFinite(Date.parse(record.lastCheckAt))) {
    lastCheckAt = record.lastCheckAt;
  }

  let lastKnown: UpdateLastKnown | undefined;
  if (typeof record.lastKnown === "object" && record.lastKnown !== null && !Array.isArray(record.lastKnown)) {
    const known = record.lastKnown as Record<string, unknown>;
    if (
      typeof known.version === "string" &&
      VERSION_PATTERN.test(known.version) &&
      typeof known.tag === "string" &&
      known.tag.length > 0
    ) {
      lastKnown = {
        version: known.version,
        tag: known.tag,
        ...(typeof known.htmlUrl === "string" ? { htmlUrl: known.htmlUrl } : {}),
        ...(typeof known.publishedAt === "string" ? { publishedAt: known.publishedAt } : {}),
      };
    }
  }

  const skippedVersions: Record<string, UpdateSkipRecord> = {};
  if (
    typeof record.skippedVersions === "object" &&
    record.skippedVersions !== null &&
    !Array.isArray(record.skippedVersions)
  ) {
    for (const [version, value] of Object.entries(record.skippedVersions as Record<string, unknown>)) {
      if (!VERSION_PATTERN.test(version)) continue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const decidedAt = (value as Record<string, unknown>).decidedAt;
      skippedVersions[version] = { decidedAt: typeof decidedAt === "string" ? decidedAt : "" };
    }
  }

  return {
    version: 1,
    ...(lastCheckAt !== undefined ? { lastCheckAt } : {}),
    ...(lastKnown !== undefined ? { lastKnown } : {}),
    skippedVersions,
  };
}

export async function writeUpdateStore(host: Host, paths: CbcPaths, store: UpdateStore): Promise<void> {
  await host.fs.mkdirp(paths.data);
  await host.fs.atomicWrite(updateStorePath(paths), `${JSON.stringify(store, null, 2)}\n`);
}

/** Record the user's "Skip this version" decision. Esc is never persisted. */
export function withSkippedVersion(store: UpdateStore, version: string, decidedAt: string): UpdateStore {
  return {
    ...store,
    skippedVersions: { ...store.skippedVersions, [version]: { decidedAt } },
  };
}

/** Record a successful metadata read, optionally advancing the known release. */
export function withCheckResult(
  store: UpdateStore,
  checkedAt: string,
  lastKnown: UpdateLastKnown | undefined,
): UpdateStore {
  return {
    ...store,
    lastCheckAt: checkedAt,
    ...(lastKnown !== undefined ? { lastKnown } : {}),
  };
}

/**
 * Whether a skip decision covers the candidate.
 *
 * A skipped version silences itself and everything older; a strictly newer
 * release asks again. `isNewer(a, b)` is the runtime's comparison, so the host
 * never interprets semver on its own.
 */
export async function isVersionSkipped(
  store: UpdateStore,
  candidate: string,
  isNewer: (current: string, candidate: string) => Promise<boolean>,
): Promise<boolean> {
  for (const skipped of Object.keys(store.skippedVersions)) {
    if (skipped === candidate) return true;
    if (await isNewer(candidate, skipped)) return true;
  }
  return false;
}
