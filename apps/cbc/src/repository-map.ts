/** Shared repository-map warmup primitives used at startup and after mutations. */

import { createHash } from "node:crypto";

import {
  parseRepositoryMapCache,
  serializeRepositoryMapCache,
  type RepoFile,
  type RepositoryMapCacheIdentity,
  type RepositoryMapGitIdentity,
  type RepositoryDelta,
  type RepositoryScan,
} from "@cbc/context-engine";

import { join, type Host } from "./host.ts";
import type { GitStatusResult, Runtime } from "./runtime.ts";

export const REPOSITORY_SCAN_LIMIT = 5_000;

export type RepositoryRuntime = Pick<Runtime, "glob" | "gitDiff" | "gitStatus"> &
  Partial<Pick<Runtime, "list">>;

export interface RepositoryScanResult extends RepositoryScan {
  readonly files: readonly RepoFile[];
}

/**
 * The walk and diff are independent runtime reads. Starting both before awaiting
 * either prevents Git latency from being serialized behind a large directory walk.
 */
export async function scanRepository(runtime: RepositoryRuntime): Promise<RepositoryScanResult> {
  const listingPromise = runtime.glob("**/*", {
    maxEntries: REPOSITORY_SCAN_LIMIT,
    limit: REPOSITORY_SCAN_LIMIT,
  });
  const diffPromise = runtime.gitDiff({});
  const [listingResult, diffResult] = await Promise.allSettled([listingPromise, diffPromise]);
  if (listingResult.status === "rejected") throw listingResult.reason;

  const listing = asRecord(listingResult.value);
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  const files: RepoFile[] = entries
    .flatMap((entry): RepoFile[] => {
      if (typeof entry === "string") {
        return entry.length === 0
          ? []
          : [{ path: entry, bytes: 0, binary: false, tracked: true }];
      }
      const row = asRecord(entry);
      if (row === undefined || row.kind === "directory") return [];
      const path = typeof row.path === "string" ? row.path : "";
      if (path.length === 0) return [];
      const bytes = finiteNonNegative(row.bytes) ? Math.floor(row.bytes) : 0;
      const modifiedMs = finiteNonNegative(row.modifiedMs) ? Math.floor(row.modifiedMs) : undefined;
      return [{
        path,
        bytes,
        binary: row.binary === true,
        // The runtime walk may not distinguish tracked files. This is a ranking
        // hint only; defaulting true avoids penalising every non-Git workspace.
        tracked: row.tracked !== false,
        ...(modifiedMs !== undefined ? { modifiedMs } : {}),
      }];
    });

  const diff = diffResult.status === "fulfilled" ? asRecord(diffResult.value) : undefined;
  const diffFiles = Array.isArray(diff?.files) ? diff.files : [];
  const dirtyPaths = diffFiles.flatMap((entry): string[] => {
    const row = asRecord(entry);
    return typeof row?.path === "string" && row.path.length > 0 ? [row.path] : [];
  });

  const truncated = typeof listing?.truncated === "boolean" ? listing.truncated : undefined;
  return {
    files,
    ...(dirtyPaths.length > 0 ? { dirtyPaths } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

/**
 * Refresh only concrete paths known to have changed. Each path starts its exact
 * glob and metadata list together, and all paths are probed concurrently. A
 * missing result is usable as deletion evidence only when the bounded probe was
 * complete; an incomplete probe fails closed and leaves the old map entry intact.
 */
export async function scanRepositoryDelta(
  runtime: RepositoryRuntime,
  paths: readonly string[],
): Promise<RepositoryDelta> {
  const requestedPaths = [...new Set(paths.map(normalizeRepositoryPath).filter((path) => path.length > 0))]
    .sort((left, right) => left.localeCompare(right));
  const probes = await Promise.all(requestedPaths.map(async (path) => {
    const globPromise = runtime.glob(path, { maxEntries: 2, limit: 2 });
    const listPromise = runtime.list === undefined
      ? undefined
      : runtime.list(path, { maxEntries: 2 });
    const [globResult, listResult] = await Promise.all([
      Promise.resolve(globPromise).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
      listPromise === undefined
        ? Promise.resolve(undefined)
        : Promise.resolve(listPromise).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason) => ({ status: "rejected" as const, reason }),
          ),
    ]);
    return { path, globResult, listResult };
  }));

  const filesByPath = new Map<string, RepoFile>();
  const removedPaths: string[] = [];
  let incomplete = false;
  for (const probe of probes) {
    const globRecord = probe.globResult.status === "fulfilled" ? asRecord(probe.globResult.value) : undefined;
    const listRecord = probe.listResult?.status === "fulfilled" ? asRecord(probe.listResult.value) : undefined;
    const globEntries = Array.isArray(globRecord?.entries) ? globRecord.entries : [];
    const listEntries = Array.isArray(listRecord?.entries) ? listRecord.entries : [];
    const candidates = [
      ...parseRepositoryEntries(globEntries),
      ...parseRepositoryEntries(listEntries),
    ];
    const exactFiles = candidates.filter((file) =>
      file.path === probe.path || file.path.startsWith(`${probe.path}/`));
    for (const file of exactFiles) filesByPath.set(file.path, file);

    const truncated = globRecord?.truncated === true || listRecord?.truncated === true;
    const globReturned = probe.globResult.status === "fulfilled";
    // A successful exact glob is authoritative for a concrete known path. The
    // optional list probe only enriches metadata; listing a file commonly fails
    // with "not a directory", which must not turn a proven deletion into an
    // incomplete delta.
    const complete = !truncated && globReturned;
    if (truncated || !complete) {
      incomplete = true;
      continue;
    }
    if (exactFiles.length === 0) removedPaths.push(probe.path);
  }

  return {
    files: [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    removedPaths: [...new Set(removedPaths)].sort((left, right) => left.localeCompare(right)),
    ...(requestedPaths.length > 0 ? { dirtyPaths: requestedPaths } : {}),
    ...(incomplete ? { truncated: true } : {}),
  };
}

/** Compatibility alias for callers that describe the operation as a known-path scan. */
export const scanKnownRepositoryPaths = scanRepositoryDelta;

function parseRepositoryEntries(entries: readonly unknown[]): RepoFile[] {
  return entries.flatMap((entry): RepoFile[] => {
    if (typeof entry === "string") {
      const path = normalizeRepositoryPath(entry);
      return path.length === 0 ? [] : [{ path, bytes: 0, binary: false, tracked: true }];
    }
    const row = asRecord(entry);
    if (row === undefined || row.kind === "directory") return [];
    const path = typeof row.path === "string" ? normalizeRepositoryPath(row.path) : "";
    if (path.length === 0) return [];
    const bytes = finiteNonNegative(row.bytes) ? Math.floor(row.bytes) : 0;
    const modifiedMs = finiteNonNegative(row.modifiedMs) ? Math.floor(row.modifiedMs) : undefined;
    return [{
      path,
      bytes,
      binary: row.binary === true,
      tracked: row.tracked !== false,
      ...(modifiedMs !== undefined ? { modifiedMs } : {}),
    }];
  });
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/u, "");
}

/**
 * Derive the Git portion of the disk-cache identity from the trusted runtime's
 * status result. The runtime does not expose the raw Git index tree id, so the
 * opaque `index` token covers the complete normalized status snapshot instead:
 * HEAD, every path/rename, both index and worktree markers, and aggregate dirty
 * counters. Entry ordering and platform separators cannot perturb the digest.
 *
 * A status snapshot still cannot prove file contents unchanged (for example two
 * edits that both remain `modified`). Cached scans therefore remain provisional
 * UI/orientation data until the background walk is ingested as fresh evidence.
 */
export function repositoryGitIdentityFromStatus(status: GitStatusResult | undefined): RepositoryMapGitIdentity {
  if (status === undefined) return { head: "unknown", index: "unknown" };
  const raw = status.status;
  if (raw.isRepository === false) return { head: "non-git", index: "non-git" };
  const head = typeof raw.head === "string" && raw.head.length > 0 ? raw.head : "unborn";
  const entries = (raw.entries ?? [])
    .map((entry) => ({
      path: normalizeStatusPath(entry.path),
      originalPath: entry.originalPath === undefined ? null : normalizeStatusPath(entry.originalPath),
      indexStatus: normalizeStatusMarker(entry.indexStatus),
      worktreeStatus: normalizeStatusMarker(entry.worktreeStatus),
    }))
    .sort((left, right) => {
      const leftKey = statusEntryKey(left);
      const rightKey = statusEntryKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const statusSnapshot = {
    head,
    entries,
    staged: normalizedCount(raw.staged),
    unstaged: normalizedCount(raw.unstaged),
    untracked: normalizedCount(raw.untracked),
    additions: normalizedCount(raw.additions),
    deletions: normalizedCount(raw.deletions),
    dirty: raw.dirty === true,
  };
  const index = createHash("sha256")
    .update(JSON.stringify(statusSnapshot), "utf8")
    .digest("hex");
  return { head, index };
}

function normalizeStatusPath(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC");
}

function normalizeStatusMarker(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function normalizedCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function statusEntryKey(entry: {
  readonly path: string;
  readonly originalPath: string | null;
  readonly indexStatus: string | number | boolean | null;
  readonly worktreeStatus: string | number | boolean | null;
}): string {
  return JSON.stringify(entry);
}

export function repositoryMapCachePath(cacheRoot: string, workspaceIdentityDigest: string): string {
  // Workspace identity is already a SHA-256 digest. Hash again if a custom host
  // supplied a non-standard value so no caller-controlled separator reaches disk.
  const safe = /^[0-9a-f]{64}$/i.test(workspaceIdentityDigest)
    ? workspaceIdentityDigest.toLowerCase()
    : createHash("sha256").update(workspaceIdentityDigest, "utf8").digest("hex");
  return join(cacheRoot, "repository-maps", `${safe}.json`);
}

export async function readRepositoryScanCache(
  host: Pick<Host, "fs">,
  path: string,
  identity: RepositoryMapCacheIdentity,
): Promise<RepositoryScanResult | undefined> {
  const record = parseRepositoryMapCache(await host.fs.read(path), identity);
  if (record === undefined) return undefined;
  return {
    files: record.files,
    ...(record.dirtyPaths.length > 0 ? { dirtyPaths: record.dirtyPaths } : {}),
  };
}

export async function writeRepositoryScanCache(
  host: Pick<Host, "fs">,
  path: string,
  identity: RepositoryMapCacheIdentity,
  scan: RepositoryScanResult,
  createdAtMs: number,
): Promise<void> {
  // A bounded/truncated walk is not a complete repository snapshot. Do not let
  // it become an apparently complete cache record on the next startup.
  if (scan.truncated === true) return;
  await host.fs.mkdirp(parentOf(path));
  await host.fs.atomicWrite(path, serializeRepositoryMapCache({
    ...identity,
    createdAtMs,
    files: scan.files,
    ...(scan.dirtyPaths !== undefined ? { dirtyPaths: scan.dirtyPaths } : {}),
  }));
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? normalized : normalized.slice(0, slash);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
