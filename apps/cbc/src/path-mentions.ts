/**
 * Workspace path mentions for the interactive composer.
 *
 * The completion reducer is intentionally synchronous, while the repository walk is
 * asynchronous. This index keeps the walk result in memory so typing `@` never does
 * filesystem IO on the key-processing path. Directory entries are derived from file
 * parents because the runtime's bounded glob currently returns files and symlinks.
 */

import { isSensitivePath } from "@cbc/context-engine";
import type { CompletionCandidate } from "@cbc/tui-components";

export interface MentionableWorkspaceFile {
  /** Workspace-relative, forward-slash separated. */
  readonly path: string;
}

type MentionKind = "file" | "folder";

interface IndexedMention {
  readonly path: string;
  readonly kind: MentionKind;
  readonly depth: number;
  readonly basename: string;
  readonly fileCount: number;
  readonly lowerPath: string;
  readonly lowerBasename: string;
  readonly lowerParent: string;
  readonly lowerSegments: readonly string[];
}

export interface PathMentionIndexStats {
  readonly inspectedEntries: number;
  readonly prefixEntriesInspected: number;
  readonly fallbackEntriesInspected: number;
  readonly rankedEntriesRetained: number;
  readonly fullSortCalls: number;
}

type MutablePathMentionIndexStats = {
  -readonly [Key in keyof PathMentionIndexStats]: PathMentionIndexStats[Key];
};

export interface PathMentionOptions {
  /** Bound work performed by popup rendering/navigation in very large repositories. */
  readonly limit?: number;
}

const DEFAULT_RESULT_LIMIT = 100;
/** `warmContext()` is bounded to 5k files; leave equal room for derived folders. */
const MAX_INDEXED_FILES = 5_000;
const MAX_INDEXED_FOLDERS = 5_000;

/**
 * A mutable, synchronous completion source backed by the latest repository scan.
 */
export class WorkspacePathMentionIndex {
  #entries: readonly IndexedMention[] = [];
  #childrenByParent = new Map<string, readonly IndexedMention[]>();
  #pathSorted: readonly IndexedMention[] = [];
  #basenameSorted: readonly IndexedMention[] = [];
  #stats: MutablePathMentionIndexStats = {
    inspectedEntries: 0,
    prefixEntriesInspected: 0,
    fallbackEntriesInspected: 0,
    rankedEntriesRetained: 0,
    fullSortCalls: 0,
  };

  get size(): number {
    return this.#entries.length;
  }

  get stats(): PathMentionIndexStats {
    return { ...this.#stats };
  }

  resetStats(): void {
    this.#stats = {
      inspectedEntries: 0,
      prefixEntriesInspected: 0,
      fallbackEntriesInspected: 0,
      rankedEntriesRetained: 0,
      fullSortCalls: 0,
    };
  }

  /** Replace the index atomically so a completion callback never sees a partial scan. */
  replaceFiles(files: readonly MentionableWorkspaceFile[]): void {
    const uniqueFiles = new Set<string>();
    const folderCounts = new Map<string, number>();

    for (const file of files) {
      const path = normalizeWorkspacePath(file.path);
      if (path === undefined || path.endsWith("/") || isSensitivePath(path)) continue;
      if (uniqueFiles.has(path)) continue;
      if (uniqueFiles.size >= MAX_INDEXED_FILES) break;
      uniqueFiles.add(path);

      const segments = path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const folder = `${segments.slice(0, index).join("/")}/`;
        const previous = folderCounts.get(folder);
        if (previous !== undefined) folderCounts.set(folder, previous + 1);
        else if (folderCounts.size < MAX_INDEXED_FOLDERS) folderCounts.set(folder, 1);
      }
    }

    const entries: IndexedMention[] = [];
    for (const [path, fileCount] of folderCounts) {
      entries.push(indexed(path, "folder", fileCount));
    }
    for (const path of uniqueFiles) entries.push(indexed(path, "file", 1));

    this.#entries = entries;
    const children = new Map<string, IndexedMention[]>();
    for (const entry of entries) {
      const bucket = children.get(entry.lowerParent);
      if (bucket === undefined) children.set(entry.lowerParent, [entry]);
      else bucket.push(entry);
    }
    this.#childrenByParent = children;
    this.#pathSorted = [...entries].sort((left, right) =>
      left.lowerPath.localeCompare(right.lowerPath) || left.path.localeCompare(right.path),
    );
    this.#basenameSorted = [...entries].sort((left, right) =>
      left.lowerBasename.localeCompare(right.lowerBasename) || left.path.localeCompare(right.path),
    );
  }

  /** Apply known transaction paths without waiting for a full repository walk. */
  applyDelta(
    upserts: readonly (MentionableWorkspaceFile | string)[],
    removedPaths: readonly string[] = [],
  ): void {
    const files = new Map<string, MentionableWorkspaceFile>();
    for (const entry of this.#entries) {
      if (entry.kind === "file") files.set(entry.path, { path: entry.path });
    }
    for (const entry of upserts) {
      const path = typeof entry === "string" ? entry : entry.path;
      if (path.length > 0) files.set(path, { path });
    }
    // A transaction may list a changed path and also mark its operation as
    // delete; deletion wins so stale completions cannot resurrect it.
    for (const path of removedPaths) files.delete(path);
    this.replaceFiles([...files.values()]);
  }
  /**
   * Complete a query without touching disk.
   *
   * A bare `@` and a query ending in `/` show one directory level. Other queries
   * search the whole bounded index, with path prefixes ahead of basename/fuzzy hits.
   */
  candidates(query: string, options: PathMentionOptions = {}): CompletionCandidate[] {
    this.resetStats();
    const limit = Math.max(1, options.limit ?? DEFAULT_RESULT_LIMIT);
    const needle = normalizeQuery(query);
    const immediateParent = needle.length === 0 || needle.endsWith("/") ? needle : undefined;
    const ranked: Array<{ readonly entry: IndexedMention; readonly rank: number }> = [];
    const seen = new Set<string>();
    const consider = (entry: IndexedMention, fallback: boolean): void => {
      if (seen.has(entry.path)) return;
      seen.add(entry.path);
      this.#stats.inspectedEntries += 1;
      if (fallback) this.#stats.fallbackEntriesInspected += 1;
      else this.#stats.prefixEntriesInspected += 1;
      const rank = immediateParent === undefined
        ? matchRank(entry, needle)
        : entry.kind === "folder" ? 0 : 1;
      if (rank === undefined) return;
      insertRanked(ranked, { entry, rank }, limit);
    };

    if (immediateParent !== undefined) {
      for (const entry of this.#childrenByParent.get(immediateParent) ?? []) {
        consider(entry, false);
      }
    } else {
      const prefixEntries = [
        ...prefixRange(this.#pathSorted, needle, (entry) => entry.lowerPath),
        ...prefixRange(this.#basenameSorted, needle, (entry) => entry.lowerBasename),
      ];
      for (const entry of prefixEntries) consider(entry, false);

      // Prefix hits dominate contains/fuzzy matches. Only inspect the full bounded
      // index when the exact/prefix buckets cannot fill the popup.
      if (ranked.length < limit) {
        for (const entry of this.#entries) consider(entry, true);
      }
    }

    this.#stats = {
      ...this.#stats,
      rankedEntriesRetained: ranked.length,
    };

    return ranked.slice(0, limit).map(({ entry }) => {
      const token = pathMentionToken(entry.path);
      return {
        value: entry.path,
        detail: entry.kind === "folder"
          ? `folder · ${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"}`
          : "file",
        // Completion replaces the entire `@query` token, including its sigil.
        // Keep `@` in the insertion and commit both files and folders by adding a
        // space; users can still drill down simply by typing `@folder/` themselves.
        insert: `${token} `,
      };
    });
  }
}

function indexed(path: string, kind: MentionKind, fileCount: number): IndexedMention {
  const withoutSlash = path.replace(/\/$/, "");
  const slash = withoutSlash.lastIndexOf("/");
  const basename = slash === -1 ? withoutSlash : withoutSlash.slice(slash + 1);
  const lowerPath = path.toLowerCase();
  const lowerBasename = basename.toLowerCase();
  const lowerParent = parentDirectory(path).toLowerCase();
  return {
    path,
    kind,
    depth: withoutSlash.split("/").length,
    basename,
    fileCount,
    lowerPath,
    lowerBasename,
    lowerParent,
    lowerSegments: lowerPath.replace(/\/$/u, "").split("/"),
  };
}

/** Reject anything that is not a safe workspace-relative path before it reaches UI. */
export function normalizeWorkspacePath(raw: string): string | undefined {
  const folder = /[/\\]$/.test(raw);
  let path = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u.test(path)) return undefined;

  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return undefined;
  path = segments.join("/");
  return path.length > 0 ? `${path}${folder ? "/" : ""}` : undefined;
}

/**
 * Extract semantic `@path` tokens from submitted text.
 *
 * The boundary rule matches the composer: `@` starts a token only at the beginning
 * of input or after whitespace, so an email address is never mistaken for a file.
 * Quoting is used only for paths containing whitespace.
 */
export function extractPathMentions(text: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") continue;
    if (index > 0 && !/\s/u.test(text[index - 1] ?? "")) continue;

    let cursor = index + 1;
    let raw = "";
    if (text[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < text.length) {
        const character = text[cursor] ?? "";
        if (character === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        if (character === "\\" && text[cursor + 1] === '"') {
          raw += '"';
          cursor += 2;
          continue;
        }
        raw += character;
        cursor += 1;
      }
      if (!closed) continue;
    } else {
      const start = cursor;
      while (cursor < text.length && !/\s/u.test(text[cursor] ?? "")) cursor += 1;
      raw = text.slice(start, cursor).replace(/[,;!?\)\]\}]+$/u, "");
    }

    const normalized = normalizeWorkspacePath(raw);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    mentions.push(normalized);
    index = Math.max(index, cursor - 1);
  }

  return mentions;
}


/**
 * Extract bounded symbol references from a task description.
 *
 * Qualified names and explicitly backticked identifiers are useful retrieval
 * signals; ordinary prose words are intentionally ignored.
 */
export function extractSymbolMentions(text: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const normalized = value.trim().replace(/\s*\.\s*/gu, ".");
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(normalized) &&
      !/^[A-Z][A-Za-z0-9_$]{2,}$/u.test(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    mentions.push(normalized);
  };
  for (const match of text.matchAll(/`([^`]+)`/gu)) add(match[1] ?? "");
  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+\b/gu)) add(match[0] ?? "");
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_$]{2,}\b/gu)) add(match[0] ?? "");
  return mentions.slice(0, 32);
}/** Render a semantic mention token, quoting the uncommon whitespace-containing path. */
export function pathMentionToken(path: string): string {
  if (!/[\s,;!?\)\]\}]/u.test(path)) return `@${path}`;
  return `@"${path.replace(/"/g, '\\"')}"`;
}

function normalizeQuery(query: string): string {
  return query
    .replace(/^@/, "")
    .replace(/^"/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function parentDirectory(path: string): string {
  const withoutSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = withoutSlash.lastIndexOf("/");
  return slash === -1 ? "" : `${withoutSlash.slice(0, slash + 1)}`;
}

function matchRank(entry: IndexedMention, needle: string): number | undefined {
  if (entry.lowerPath === needle || entry.lowerPath === `${needle}/`) return 0;
  if (entry.lowerPath.startsWith(needle)) return 1;
  if (entry.lowerBasename.startsWith(needle)) return 2;
  if (entry.lowerSegments.some((segment) => segment.startsWith(needle))) return 3;
  if (entry.lowerPath.includes(needle)) return 4;
  return isSubsequence(needle, entry.lowerPath) ? 5 : undefined;
}

function compareRanked(
  left: { readonly entry: IndexedMention; readonly rank: number },
  right: { readonly entry: IndexedMention; readonly rank: number },
): number {
  return left.rank - right.rank ||
    Number(left.entry.kind === "file") - Number(right.entry.kind === "file") ||
    left.entry.depth - right.entry.depth ||
    left.entry.path.localeCompare(right.entry.path);
}

function insertRanked(
  ranked: Array<{ readonly entry: IndexedMention; readonly rank: number }>,
  candidate: { readonly entry: IndexedMention; readonly rank: number },
  limit: number,
): void {
  let low = 0;
  let high = ranked.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const current = ranked[middle];
    if (current !== undefined && compareRanked(current, candidate) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low >= limit && ranked.length >= limit) return;
  ranked.splice(low, 0, candidate);
  if (ranked.length > limit) ranked.pop();
}

function prefixRange(
  entries: readonly IndexedMention[],
  needle: string,
  key: (entry: IndexedMention) => string,
): IndexedMention[] {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((key(entries[middle] as IndexedMention) ?? "") < needle) low = middle + 1;
    else high = middle;
  }
  const start = low;
  while (low < entries.length && key(entries[low] as IndexedMention).startsWith(needle)) low += 1;
  return entries.slice(start, low);
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let matched = 0;
  for (const character of haystack) {
    if (character === needle[matched]) matched += 1;
    if (matched === needle.length) return true;
  }
  return false;
}
