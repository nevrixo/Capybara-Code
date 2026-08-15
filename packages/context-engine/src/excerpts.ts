/**
 * File excerpts — PRD §18.5.
 *
 * §18.5 requirements, each enforced below:
 *
 * - line numbers included
 * - source path and checksum included
 * - omitted ranges marked when it is not the whole file
 * - a stale checksum is refreshed before the model observes it
 * - the same excerpt is not repeated
 *
 * The checksum matters beyond bookkeeping: §12.5/§12.6 require a mutation to
 * carry the hash the agent read, which is how AC-13 detects a concurrent user
 * edit instead of overwriting it. The excerpt is where the model learns that
 * value, so it is rendered inline rather than tracked out of band.
 */

import { createHash } from "node:crypto";

/** Content of a file range as returned by the runtime's `fs.read`. */
export interface FileContent {
  readonly path: string;
  readonly text: string;
  /** SHA-256 of the **whole** file, from the runtime. */
  readonly checksum: string;
  readonly totalLines: number;
  /** 1-based line number of the first line in `text`. */
  readonly startLine: number;
}

export interface FileExcerpt {
  readonly path: string;
  readonly checksum: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly text: string;
  readonly linesOmittedBefore: number;
  readonly linesOmittedAfter: number;
}

/** Default excerpt window. Large enough to be useful, small enough to be cheap. */
export const DEFAULT_EXCERPT_LINES = 400;

export function buildExcerpt(
  content: FileContent,
  options: { maxLines?: number } = {},
): FileExcerpt {
  const maxLines = options.maxLines ?? DEFAULT_EXCERPT_LINES;
  const allLines = content.text.length === 0 && content.totalLines === 0
    ? []
    : content.text.split("\n");
  // A trailing newline produces a final empty element that is not a real line.
  if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();

  const kept = allLines.slice(0, maxLines);
  const startLine = Math.max(1, content.startLine);
  const endLine = startLine + kept.length - 1;

  return {
    path: content.path,
    checksum: content.checksum,
    startLine,
    endLine,
    totalLines: content.totalLines,
    text: kept.join("\n"),
    linesOmittedBefore: startLine - 1,
    linesOmittedAfter: Math.max(0, content.totalLines - endLine),
  };
}

/**
 * Render an excerpt for the L6 context layer.
 *
 * The header is deliberately machine-parseable: the model is told the exact
 * checksum to echo back on a mutation, and gutter line numbers let it reference
 * a location without guessing.
 */
export function renderExcerpt(excerpt: FileExcerpt): string {
  const header = [
    `<file path="${excerpt.path}" sha256="${excerpt.checksum}"`,
    ` lines="${excerpt.startLine}-${excerpt.endLine} of ${excerpt.totalLines}">`,
  ].join("");

  const body: string[] = [header];
  if (excerpt.linesOmittedBefore > 0) {
    body.push(`… ${excerpt.linesOmittedBefore} earlier line(s) omitted …`);
  }

  const gutterWidth = String(excerpt.endLine).length;
  const lines = excerpt.text.length === 0 ? [] : excerpt.text.split("\n");
  lines.forEach((line, index) => {
    const number = String(excerpt.startLine + index).padStart(gutterWidth, " ");
    body.push(`${number} | ${line}`);
  });

  if (excerpt.linesOmittedAfter > 0) {
    body.push(`… ${excerpt.linesOmittedAfter} later line(s) omitted …`);
  }
  body.push("</file>");
  return body.join("\n");
}

/** Canonical identity of one exact observation, for deduplication/provenance. */
function excerptKey(excerpt: FileExcerpt): string {
  return `${excerpt.path}@${excerpt.checksum}#${excerpt.startLine}-${excerpt.endLine}`;
}

/** Stable, collision-resistant ID shared by the evidence and active stores. */
export function excerptId(excerpt: FileExcerpt): `excerpt-${string}` {
  return `excerpt-${createHash("sha256").update(excerptKey(excerpt)).digest("hex")}`;
}

export interface StaleExcerpt {
  readonly path: string;
  readonly knownChecksum: string;
  readonly currentChecksum: string;
}

/**
 * Tracks which excerpts are already in context.
 *
 * Two §18.5 rules live here. Duplicates are dropped so re-reading a file does not
 * pay for it twice, and a checksum change invalidates every excerpt of that path
 * so the model never reasons about a stale copy — the same evidence AC-13 relies
 * on.
 */
export class ExcerptStore {
  readonly #byKey = new Map<string, FileExcerpt>();
  readonly #byId = new Map<`excerpt-${string}`, FileExcerpt>();
  readonly #keysByPath = new Map<string, Set<string>>();
  /** Monotonic insertion order preserves stable ties in the legacy sort. */
  readonly #orderByKey = new Map<string, number>();
  /** Latest checksum observed per path. */
  readonly #checksums = new Map<string, string>();
  #nextOrder = 0;
  #bytes = 0;

  get size(): number {
    return this.#byKey.size;
  }

  /** Checksum this store believes is current for `path`. */
  checksumFor(path: string): string | undefined {
    return this.#checksums.get(path);
  }

  /**
   * True when `path` is held at a different checksum than `current`, meaning the
   * file changed underneath us.
   */
  isStale(path: string, current: string): boolean {
    const known = this.#checksums.get(path);
    return known !== undefined && known !== current;
  }

  /**
   * Add an excerpt. Returns whether it was new.
   *
   * A checksum change drops the previous excerpts for that path rather than
   * keeping both versions, because two conflicting copies of one file in context
   * is worse than one fresh copy.
   */
  add(excerpt: FileExcerpt, options: { readonly preserveIds?: ReadonlySet<string> } = {}): boolean {
    const known = this.#checksums.get(excerpt.path);
    if (known !== undefined && known !== excerpt.checksum) {
      this.invalidate(excerpt.path);
    }
    this.#checksums.set(excerpt.path, excerpt.checksum);

    const key = excerptKey(excerpt);
    if (this.#byKey.has(key)) return false;

    // A wider excerpt of the same file supersedes one it fully contains.
    for (const [existingKey, existing] of [...this.#byKey]) {
      if (existing.path !== excerpt.path) continue;
      if (excerpt.startLine <= existing.startLine && excerpt.endLine >= existing.endLine) {
        if (!options.preserveIds?.has(excerptId(existing))) this.#remove(existingKey);
      } else if (existing.startLine <= excerpt.startLine && existing.endLine >= excerpt.endLine) {
        // Already covered by a wider excerpt.
        return false;
      }
    }

    this.#addIndexed(key, excerpt);
    return true;
  }

  /** Forget every excerpt of `path`, e.g. after a patch changed it. */
  invalidate(path: string): number {
    let removed = 0;
    for (const candidatePath of [...this.#keysByPath.keys()]) {
      if (!pathIsWithin(candidatePath, path)) continue;
      for (const key of [...this.#keysByPath.get(candidatePath) ?? []]) {
        if (this.#remove(key)) removed += 1;
      }
    }
    for (const checksumPath of [...this.#checksums.keys()]) {
      if (pathIsWithin(checksumPath, path)) this.#checksums.delete(checksumPath);
    }
    return removed;
  }

  clear(): void {
    this.#byKey.clear();
    this.#byId.clear();
    this.#keysByPath.clear();
    this.#orderByKey.clear();
    this.#checksums.clear();
    this.#nextOrder = 0;
    this.#bytes = 0;
  }

  excerpts(): FileExcerpt[] {
    return this.#sort([...this.#byKey.values()]);
  }

  /** Stable IDs for all exact observations held by this store. */
  ids(): `excerpt-${string}`[] {
    return this.excerpts().map(excerptId);
  }

  /** Resolve an exact ID without exposing the internal canonical key. */
  getById(id: string): FileExcerpt | undefined {
    return this.#byId.get(id as `excerpt-${string}`);
  }

  hasId(id: string): boolean {
    return this.#byId.has(id as `excerpt-${string}`);
  }

  idsForPath(path: string): `excerpt-${string}`[] {
    const matches: FileExcerpt[] = [];
    for (const candidatePath of this.#keysByPath.keys()) {
      if (!pathIsWithin(candidatePath, path)) continue;
      for (const key of this.#keysByPath.get(candidatePath) ?? []) {
        const excerpt = this.#byKey.get(key);
        if (excerpt !== undefined) matches.push(excerpt);
      }
    }
    return this.#sort(matches)
      .map(excerptId);
  }

  /**
   * Return the exact or wider stored range that covers `excerpt`. This lets a
   * contained cache hit reactivate the existing observation instead of creating
   * a second prompt item.
   */
  coveringId(excerpt: FileExcerpt): `excerpt-${string}` | undefined {
    const covering = this.#sort(this.#valuesForPath(excerpt.path)).find(
      (candidate) =>
        candidate.checksum === excerpt.checksum &&
        candidate.startLine <= excerpt.startLine &&
        candidate.endLine >= excerpt.endLine,
    );
    return covering === undefined ? undefined : excerptId(covering);
  }

  /** Rendered excerpts, optionally restricted to active IDs. */
  rendered(ids?: readonly string[]): string[] {
    if (ids === undefined) return this.excerpts().map(renderExcerpt);
    const selected = new Set(ids);
    return this.#sort([...this.#byId.values()])
      .filter((excerpt) => selected.has(excerptId(excerpt)))
      .map(renderExcerpt);
  }

  totalBytes(): number {
    return this.#bytes;
  }

  /**
   * Compare held checksums against a fresh listing and report the drift. The
   * caller re-reads these before the next sampling step (§18.5).
   */
  detectStale(current: ReadonlyMap<string, string>): StaleExcerpt[] {
    const stale: StaleExcerpt[] = [];
    for (const [path, known] of this.#checksums) {
      const now = current.get(path);
      if (now !== undefined && now !== known) {
        stale.push({ path, knownChecksum: known, currentChecksum: now });
      }
    }
    return stale;
  }

  #addIndexed(key: string, excerpt: FileExcerpt): void {
    const id = excerptId(excerpt);
    this.#byKey.set(key, excerpt);
    this.#byId.set(id, excerpt);
    const pathKeys = this.#keysByPath.get(excerpt.path) ?? new Set<string>();
    pathKeys.add(key);
    this.#keysByPath.set(excerpt.path, pathKeys);
    this.#orderByKey.set(key, this.#nextOrder++);
    this.#bytes += excerpt.text.length;
  }

  #remove(key: string): boolean {
    const excerpt = this.#byKey.get(key);
    if (excerpt === undefined) return false;
    this.#byKey.delete(key);
    this.#byId.delete(excerptId(excerpt));
    const pathKeys = this.#keysByPath.get(excerpt.path);
    pathKeys?.delete(key);
    if (pathKeys !== undefined && pathKeys.size === 0) this.#keysByPath.delete(excerpt.path);
    this.#orderByKey.delete(key);
    this.#bytes -= excerpt.text.length;
    return true;
  }

  #valuesForPath(path: string): FileExcerpt[] {
    const values: FileExcerpt[] = [];
    for (const key of this.#keysByPath.get(path) ?? []) {
      const excerpt = this.#byKey.get(key);
      if (excerpt !== undefined) values.push(excerpt);
    }
    return values;
  }

  #sort(values: FileExcerpt[]): FileExcerpt[] {
    return values.sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine ||
      (this.#orderByKey.get(excerptKey(left)) ?? 0) -
        (this.#orderByKey.get(excerptKey(right)) ?? 0),
    );
  }
}

/**
 * Durable-in-session exact observations. Prompt eviction never deletes this
 * store; a checksum change or mutation is the only path-level invalidation.
 */
function pathIsWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

export class EvidenceExcerptStore extends ExcerptStore {}

export interface ActiveExcerptEntry {
  readonly id: `excerpt-${string}`;
  readonly lastUsedAt: number;
  readonly pinnedByUser: boolean;
  readonly relevanceScore: number;
  readonly estimatedTokens: number;
}

export interface ActiveExcerptActivationOptions {
  readonly pinnedByUser?: boolean;
  readonly relevanceScore?: number;
  readonly relevanceById?: ReadonlyMap<string, number>;
  /** Entries leased until their first compiled pack; never evict these to activate a sibling read. */
  readonly protectedIds?: ReadonlySet<string>;
}

/**
 * The bounded working view rendered into L6. It references, rather than owns,
 * exact observations so an eviction saves prompt tokens without destroying
 * provenance or preventing a later task from reactivating the range.
 */
export class ActiveExcerptSet {
  readonly #store: ExcerptStore;
  readonly #now: () => number;
  readonly #active = new Map<`excerpt-${string}`, ActiveExcerptEntry>();

  constructor(store: ExcerptStore, options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#active.size;
  }

  get totalEstimatedTokens(): number {
    let total = 0;
    for (const entry of this.#active.values()) total += entry.estimatedTokens;
    return total;
  }

  entries(): ActiveExcerptEntry[] {
    return [...this.#active.values()].sort((left, right) => {
      const a = this.#store.getById(left.id);
      const b = this.#store.getById(right.id);
      return (a?.path ?? left.id).localeCompare(b?.path ?? right.id) ||
        (a?.startLine ?? 0) - (b?.startLine ?? 0);
    });
  }

  excerptIds(): `excerpt-${string}`[] {
    return this.entries().map((entry) => entry.id);
  }

  has(id: string): boolean {
    return this.#active.has(id as `excerpt-${string}`);
  }

  isPathActive(path: string): boolean {
    return this.excerptIds().some((id) => this.#store.getById(id)?.path === path);
  }

  /** Activate exact IDs and immediately enforce the hard prompt budget. */
  activate(
    ids: readonly string[],
    budget: number,
    options: ActiveExcerptActivationOptions = {},
  ): ActiveExcerptEntry[] {
    const now = this.#now();
    for (const rawId of ids) {
      const id = rawId as `excerpt-${string}`;
      const excerpt = this.#store.getById(id);
      if (excerpt === undefined) continue;
      const current = this.#active.get(id);
      this.#active.set(id, {
        id,
        lastUsedAt: now,
        pinnedByUser: options.pinnedByUser ?? current?.pinnedByUser ?? false,
        relevanceScore:
          options.relevanceById?.get(id) ??
          options.relevanceScore ??
          current?.relevanceScore ??
          0,
        estimatedTokens: estimateRenderedTokens(renderExcerpt(excerpt)),
      });
    }
    return this.evictUntilWithin(budget, options.protectedIds);
  }

  /** Remove references whose exact observation was superseded or invalidated. */
  pruneMissing(): ActiveExcerptEntry[] {
    const removed: ActiveExcerptEntry[] = [];
    for (const [id, entry] of this.#active) {
      if (this.#store.hasId(id)) continue;
      this.#active.delete(id);
      removed.push(entry);
    }
    return removed;
  }

  deactivate(ids: readonly string[]): ActiveExcerptEntry[] {
    const removed: ActiveExcerptEntry[] = [];
    for (const rawId of ids) {
      const id = rawId as `excerpt-${string}`;
      const entry = this.#active.get(id);
      if (entry === undefined) continue;
      this.#active.delete(id);
      removed.push(entry);
    }
    return removed;
  }

  deactivatePath(path: string): ActiveExcerptEntry[] {
    const removed: ActiveExcerptEntry[] = [];
    for (const [id, entry] of this.#active) {
      const excerptPath = this.#store.getById(id)?.path;
      if (excerptPath === undefined || !pathIsWithin(excerptPath, path)) continue;
      this.#active.delete(id);
      removed.push(entry);
    }
    return removed;
  }

  clear(): void {
    this.#active.clear();
  }

  /**
   * Utility/LRU eviction. User pins survive ordinary entries, then the oldest,
   * least relevant ranges leave first. A hard budget remains hard even when all
   * remaining entries are pinned.
   */
  evictUntilWithin(budget: number, protectedIds: ReadonlySet<string> = new Set()): ActiveExcerptEntry[] {
    const limit = Math.max(0, Math.floor(budget));
    const removed: ActiveExcerptEntry[] = [];
    this.pruneMissing();
    if (this.totalEstimatedTokens <= limit) return removed;

    const candidates = [...this.#active.values()].sort(
      (left, right) =>
        Number(left.pinnedByUser) - Number(right.pinnedByUser) ||
        left.relevanceScore - right.relevanceScore ||
        left.lastUsedAt - right.lastUsedAt ||
        right.estimatedTokens - left.estimatedTokens ||
        left.id.localeCompare(right.id),
    );
    for (const entry of candidates) {
      if (this.totalEstimatedTokens <= limit) break;
      if (protectedIds.has(entry.id)) continue;
      if (this.#active.delete(entry.id)) removed.push(entry);
    }
    return removed;
  }

  rendered(): string[] {
    return this.#store.rendered(this.excerptIds());
  }
}

export function estimateRenderedTokens(text: string): number {
  if (text.length === 0) return 0;
  let tokens = 0;
  for (const char of text) tokens += (char.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.25;
  return Math.max(1, Math.ceil(tokens));
}
