/**
 * Versioned disk-cache codec for the repository map warmup.
 *
 * The cache stores only workspace metadata already returned by the bounded walk;
 * it never stores file contents.  Callers supply the workspace identity and Git
 * HEAD plus normalized index/worktree status identity they observed, and a
 * record is accepted only when all three match.  Parsing is deliberately defensive because cache files are mutable local
 * input and must never be trusted merely because CBC wrote them previously.
 */

import { createHash } from "node:crypto";

import { REPOSITORY_MAP_RENDER_VERSION, type RepoFile } from "./repomap.ts";

export const REPOSITORY_MAP_CACHE_VERSION = 2 as const;
export const REPOSITORY_MAP_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const REPOSITORY_MAP_CACHE_MAX_FILES = 5_000;
export const REPOSITORY_MAP_CACHE_MAX_DIRTY_PATHS = 5_000;
export const REPOSITORY_MAP_CACHE_MAX_PATH_BYTES = 16 * 1024;

export interface RepositoryMapGitIdentity {
  /** Full commit id, `unborn`, or `non-git`. */
  readonly head: string;
  /** Opaque digest of the normalized Git index/worktree status snapshot. */
  readonly index: string;
}

export interface RepositoryMapCacheIdentity {
  readonly workspaceIdentityDigest: string;
  readonly git: RepositoryMapGitIdentity;
}

export interface RepositoryMapCacheRecord extends RepositoryMapCacheIdentity {
  readonly version: typeof REPOSITORY_MAP_CACHE_VERSION;
  readonly renderingVersion: typeof REPOSITORY_MAP_RENDER_VERSION;
  readonly key: string;
  readonly createdAtMs: number;
  readonly files: readonly RepoFile[];
  readonly dirtyPaths: readonly string[];
}

export interface RepositoryMapCacheWrite extends RepositoryMapCacheIdentity {
  readonly createdAtMs: number;
  readonly files: readonly RepoFile[];
  readonly dirtyPaths?: readonly string[];
}

/** Stable key namespace. Bumping either version makes old data unreachable. */
export function repositoryMapCacheKey(identity: RepositoryMapCacheIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cacheVersion: REPOSITORY_MAP_CACHE_VERSION,
        renderingVersion: REPOSITORY_MAP_RENDER_VERSION,
        workspaceIdentityDigest: identity.workspaceIdentityDigest,
        gitHead: identity.git.head,
        gitStatus: identity.git.index,
      }),
      "utf8",
    )
    .digest("hex");
}

export function serializeRepositoryMapCache(input: RepositoryMapCacheWrite): string {
  const record: RepositoryMapCacheRecord = {
    version: REPOSITORY_MAP_CACHE_VERSION,
    renderingVersion: REPOSITORY_MAP_RENDER_VERSION,
    key: repositoryMapCacheKey(input),
    workspaceIdentityDigest: input.workspaceIdentityDigest,
    git: input.git,
    createdAtMs: input.createdAtMs,
    files: input.files,
    dirtyPaths: input.dirtyPaths ?? [],
  };
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > REPOSITORY_MAP_CACHE_MAX_BYTES) {
    throw new Error("repository map cache exceeds the bounded disk record size");
  }
  return encoded;
}

/**
 * Parse and validate a cache record. Invalid, oversized, stale, or differently
 * keyed records are cache misses rather than startup failures.
 */
export function parseRepositoryMapCache(
  raw: string | undefined,
  expected: RepositoryMapCacheIdentity,
): RepositoryMapCacheRecord | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  if (Buffer.byteLength(raw, "utf8") > REPOSITORY_MAP_CACHE_MAX_BYTES) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.version !== REPOSITORY_MAP_CACHE_VERSION) return undefined;
  if (value.renderingVersion !== REPOSITORY_MAP_RENDER_VERSION) return undefined;
  if (value.workspaceIdentityDigest !== expected.workspaceIdentityDigest) return undefined;
  if (!isRecord(value.git) || value.git.head !== expected.git.head || value.git.index !== expected.git.index) {
    return undefined;
  }
  const expectedKey = repositoryMapCacheKey(expected);
  if (value.key !== expectedKey) return undefined;
  if (!isFiniteNonNegative(value.createdAtMs)) return undefined;
  if (!Array.isArray(value.files) || value.files.length > REPOSITORY_MAP_CACHE_MAX_FILES) return undefined;
  if (!Array.isArray(value.dirtyPaths) || value.dirtyPaths.length > REPOSITORY_MAP_CACHE_MAX_DIRTY_PATHS) {
    return undefined;
  }

  const files: RepoFile[] = [];
  const seen = new Set<string>();
  for (const candidate of value.files) {
    const file = parseRepoFile(candidate);
    if (file === undefined || seen.has(file.path)) return undefined;
    seen.add(file.path);
    files.push(file);
  }

  const dirtyPaths: string[] = [];
  for (const candidate of value.dirtyPaths) {
    if (!validRelativePath(candidate)) return undefined;
    dirtyPaths.push(candidate);
  }

  return {
    version: REPOSITORY_MAP_CACHE_VERSION,
    renderingVersion: REPOSITORY_MAP_RENDER_VERSION,
    key: expectedKey,
    workspaceIdentityDigest: expected.workspaceIdentityDigest,
    git: { head: expected.git.head, index: expected.git.index },
    createdAtMs: value.createdAtMs,
    files,
    dirtyPaths,
  };
}

function parseRepoFile(value: unknown): RepoFile | undefined {
  if (!isRecord(value) || !validRelativePath(value.path)) return undefined;
  if (!isFiniteNonNegative(value.bytes) || !Number.isInteger(value.bytes)) return undefined;
  if (typeof value.binary !== "boolean" || typeof value.tracked !== "boolean") return undefined;
  if (
    value.modifiedMs !== undefined &&
    (!isFiniteNonNegative(value.modifiedMs) || !Number.isInteger(value.modifiedMs))
  ) {
    return undefined;
  }
  return {
    path: value.path,
    bytes: value.bytes,
    binary: value.binary,
    tracked: value.tracked,
    ...(typeof value.modifiedMs === "number" ? { modifiedMs: value.modifiedMs } : {}),
  };
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > REPOSITORY_MAP_CACHE_MAX_PATH_BYTES) return false;
  if (value.includes("\0") || /^[/\\]/.test(value) || /^[A-Za-z]:[/\\]/.test(value)) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.split("/").some((segment) => segment === "..");
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
