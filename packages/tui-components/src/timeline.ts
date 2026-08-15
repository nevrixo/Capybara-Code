/**
 * Incremental, row-indexed timeline projection.
 *
 * The durable reducer owns event truth; this module owns the visual index used by
 * fullscreen rendering. A ProjectedTimeline is session-scoped and is deliberately
 * reusable across frames: append-only durable history touches only the tail, stable
 * visual groups retain their ids, and row heights are learned lazily per semantic
 * render variant.
 */

import type {
  TimelineCommentary,
  TimelineItem,
  TimelineTask,
  TimelineToolCall,
} from "@cbc/session-domain";

import {
  SUBAGENT_INLINE_VISIBLE,
  finalAnswerText,
  renderTimelineItem,
  renderTimelineItemTail,
  resolvePresentationPolicy,
  type TimelineItemTailRender,
  type TimelineRenderOptions,
} from "./blocks.ts";
import { blank, type BlockContext, type StyledLine } from "./segments.ts";
import {
  AppendableMarkdownSourceIndex,
  CompositeMarkdownSourceIndex,
  createCompositeMarkdownSourceIndex,
  createMarkdownSourceIndex,
  type MarkdownSourceView,
} from "./markdown.ts";

export type TimelineVisualGroupKind = "item" | "commentary" | "succeeded_reads";

export interface TimelineVisualGroup {
  /** Stable for the lifetime of the first durable item in the group. */
  readonly id: string;
  readonly kind: TimelineVisualGroupKind;
  /** Durable references; commentary text is not copied into the projection. */
  readonly items: readonly TimelineItem[];
  readonly firstSequence: number;
  readonly lastSequence: number;
  /** Changes only when membership or a member's semantic contents change. */
  readonly revision: number;
}

export interface TimelineWindowDetails {
  readonly lines: StyledLine[];
  /** Known only after this render variant has learned every older group height. */
  readonly totalLines?: number;
}

export interface TimelineProjectionSyncResult {
  readonly rebuilt: boolean;
  readonly appended: number;
  readonly updated: number;
}

/** Ephemeral provider text supplied separately from the durable timeline array. */
export interface TimelineStreamingView {
  readonly id: string;
  readonly item: TimelineItem;
  readonly revision: number;
  readonly sourceView: MarkdownSourceView;
}

export interface TimelineProjectionStats {
  readonly fullRebuilds: number;
  readonly structuralRebuilds: number;
  /** Source items inspected after construction, useful for scaling assertions. */
  readonly sourceItemsInspected: number;
  readonly appended: number;
  readonly updated: number;
  readonly removed: number;
  /** Visual groups whose line arrays were actually built (cache misses). */
  readonly renderedGroups: number;
  readonly viewportQueries: number;
  readonly boundedMarkdownRenders: number;
  readonly fullMarkdownFallbacks: number;
  readonly markdownSourceLinesRendered: number;
  /** Streaming updates must use revision equality instead of canonicalizing text. */
  readonly streamingRevisionUpdates: number;
  readonly itemFingerprintsComputed: number;
}

export interface TimelineRenderCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly variants: number;
}

interface ItemCacheEntry {
  readonly revision: number;
  readonly lines: StyledLine[];
}

/**
 * Weak item cache keyed by every semantic timeline option and terminal capability.
 *
 * Mutable tool/task objects are safe when callers increment the supplied revision;
 * ProjectedTimeline does that on update, including same-object mutations discovered
 * by sync(). Weak keys ensure evicted/resident-window items are not retained here.
 */
export class TimelineRenderCache {
  #items = new WeakMap<object, Map<string, ItemCacheEntry>>();
  readonly #maxVariantsPerItem: number;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #variants = 0;

  constructor(options: { readonly maxVariantsPerItem?: number } = {}) {
    this.#maxVariantsPerItem = Math.max(
      1,
      Math.floor(options.maxVariantsPerItem ?? 8),
    );
  }

  renderItem(
    item: TimelineItem,
    revision: number,
    context: BlockContext,
    options: TimelineRenderOptions,
  ): StyledLine[] {
    const key = timelineRenderCacheKey(context, options);
    const variants = this.#items.get(item as object);
    const cached = variants?.get(key);
    if (cached !== undefined && cached.revision === revision) {
      this.#hits += 1;
      // Map insertion order is our tiny per-item LRU.
      variants?.delete(key);
      variants?.set(key, cached);
      return cached.lines;
    }

    this.#misses += 1;
    const lines = renderTimelineItem(item, context, options);
    const target = variants ?? new Map<string, ItemCacheEntry>();
    if (variants === undefined) this.#items.set(item as object, target);
    if (!target.has(key)) this.#variants += 1;
    target.set(key, { revision, lines });
    while (target.size > this.#maxVariantsPerItem) {
      const oldest = target.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      target.delete(oldest);
      this.#variants -= 1;
      this.#evictions += 1;
    }
    return lines;
  }

  clear(): void {
    this.#items = new WeakMap<object, Map<string, ItemCacheEntry>>();
    this.#variants = 0;
  }

  resetStats(): void {
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }

  get stats(): TimelineRenderCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      variants: this.#variants,
    };
  }
}

/** Canonical key including all current and future enumerable semantic options. */
export function timelineRenderCacheKey(
  context: BlockContext,
  options: TimelineRenderOptions = {},
): string {
  return canonicalValue({ context, options });
}

interface SourceRecord {
  item: TimelineItem;
  readonly order: number;
  revision: number;
  fingerprint?: string;
  mutable: boolean;
  markdownIndex?: MarkdownSourceView;
  streaming?: boolean;
  streamingTextLength?: number;
}

interface ProjectionEntry {
  readonly stableId: string;
  readonly originId: string;
  item: TimelineItem;
  sequence: number;
  readonly sourceOrder: number;
  readonly subOrder: number;
  sourceRevision: number;
  markdownIndex?: MarkdownSourceView;
  group?: InternalVisualGroup;
}

interface InternalVisualGroup {
  readonly id: string;
  readonly kind: TimelineVisualGroupKind;
  readonly compatibilityKey: string;
  entries: ProjectionEntry[];
  revision: number;
  positionHint: number;
  synthetic?: TimelineItem;
  syntheticRevision?: number;
  markdownIndex?: MarkdownSourceView;
  markdownIndexRevision?: number;
}

interface GroupSpec {
  readonly id: string;
  readonly kind: TimelineVisualGroupKind;
  readonly compatibilityKey: string;
  readonly entries: ProjectionEntry[];
}

interface ProjectionCounters {
  fullRebuilds: number;
  structuralRebuilds: number;
  sourceItemsInspected: number;
  appended: number;
  updated: number;
  removed: number;
  renderedGroups: number;
  viewportQueries: number;
  boundedMarkdownRenders: number;
  fullMarkdownFallbacks: number;
  markdownSourceLinesRendered: number;
  streamingRevisionUpdates: number;
  itemFingerprintsComputed: number;
}

const EMPTY_STATS: ProjectionCounters = {
  fullRebuilds: 0,
  structuralRebuilds: 0,
  sourceItemsInspected: 0,
  appended: 0,
  updated: 0,
  removed: 0,
  renderedGroups: 0,
  viewportQueries: 0,
  boundedMarkdownRenders: 0,
  fullMarkdownFallbacks: 0,
  markdownSourceLinesRendered: 0,
  streamingRevisionUpdates: 0,
  itemFingerprintsComputed: 0,
};

/**
 * Session-scoped incremental projection and row index.
 *
 * sync() has an append fast path. It validates every currently mutable item (the
 * active tool/task/job/approval plus plans) but never scans completed history.
 * Hosts with an event-level change hint may call append/update/remove directly;
 * composeScreen also calls sync defensively when this instance is supplied.
 */
export class ProjectedTimeline {
  readonly #sources: SourceRecord[] = [];
  readonly #sourceById = new Map<string, SourceRecord>();
  readonly #streamingSources = new Map<string, SourceRecord>();
  readonly #mutableSourceIds = new Set<string>();
  #entries: ProjectionEntry[] = [];
  readonly #entryByStableId = new Map<string, ProjectionEntry>();
  #groups: InternalVisualGroup[] = [];
  #projectionOptions: TimelineRenderOptions = {};
  #projectionKey = projectionOptionsKey({});
  #nextSourceOrder = 0;
  #newestSequence = 0;
  #newestCommentaryGroupId: string | undefined;
  readonly #runningTaskGroupIds = new Set<string>();
  readonly #viewStates = new Map<string, TimelineViewState>();
  readonly #renderCache: TimelineRenderCache;
  readonly #stats: ProjectionCounters = { ...EMPTY_STATS };
  readonly #maxRenderVariants: number;

  constructor(
    options: TimelineRenderOptions = {},
    config: {
      readonly renderCache?: TimelineRenderCache;
      readonly maxRenderVariants?: number;
    } = {},
  ) {
    this.#projectionOptions = options;
    this.#projectionKey = projectionOptionsKey(options);
    this.#renderCache = config.renderCache ?? new TimelineRenderCache();
    this.#maxRenderVariants = Math.max(1, Math.floor(config.maxRenderVariants ?? 8));
  }

  get length(): number {
    return this.#sources.length;
  }

  get groupCount(): number {
    return this.#groups.length;
  }

  get renderCache(): TimelineRenderCache {
    return this.#renderCache;
  }

  get stats(): TimelineProjectionStats {
    return { ...this.#stats };
  }

  /** Snapshot for diagnostics/tests; frame rendering uses the internal groups. */
  get visualGroups(): readonly TimelineVisualGroup[] {
    return this.#groups.map((group) => ({
      id: group.id,
      kind: group.kind,
      items: group.entries.map((entry) => entry.item),
      firstSequence: group.entries[0]?.sequence ?? 0,
      lastSequence: group.entries[group.entries.length - 1]?.sequence ?? 0,
      revision: group.revision,
    }));
  }

  /** Materialized legacy projection, intended for exports/tests rather than frames. */
  projectedItems(): TimelineItem[] {
    const out: TimelineItem[] = [];
    for (const group of this.#groups) {
      if (group.kind === "succeeded_reads" && group.entries.length <= 2) {
        out.push(...group.entries.map((entry) => entry.item));
      } else {
        out.push(this.#materializeGroup(group));
      }
    }
    return out;
  }

  reset(
    items: readonly TimelineItem[],
    options: TimelineRenderOptions = this.#projectionOptions,
  ): void {
    this.#projectionOptions = options;
    this.#projectionKey = projectionOptionsKey(options);
    this.#sources.length = 0;
    this.#sourceById.clear();
    this.#streamingSources.clear();
    this.#mutableSourceIds.clear();
    this.#nextSourceOrder = 0;
    this.#newestSequence = 0;

    for (const item of items) {
      const record = this.#makeSourceRecord(item);
      this.#sources.push(record);
      this.#sourceById.set(item.id, record);
      if (record.mutable) this.#mutableSourceIds.add(item.id);
      this.#newestSequence = Math.max(this.#newestSequence, item.sequence);
      this.#stats.sourceItemsInspected += 1;
    }
    this.#rebuildEntriesAndGroups(false);
    this.#stats.fullRebuilds += 1;
  }

  sync(
    items: readonly TimelineItem[],
    options: TimelineRenderOptions = this.#projectionOptions,
  ): TimelineProjectionSyncResult {
    const nextProjectionKey = projectionOptionsKey(options);
    if (
      nextProjectionKey !== this.#projectionKey ||
      !this.#canUseAppendFastPath(items)
    ) {
      this.reset(items, options);
      return { rebuilt: true, appended: 0, updated: 0 };
    }

    this.#projectionOptions = options;
    let updated = 0;
    // Active mutable state is normally tiny and is the only durable prefix that
    // can change without a new timeline id.
    for (const id of [...this.#mutableSourceIds]) {
      const record = this.#sourceById.get(id);
      if (record === undefined) continue;
      const sourceIndex = record.order;
      const next = items[sourceIndex];
      if (next === undefined || next.id !== id) {
        this.reset(items, options);
        return { rebuilt: true, appended: 0, updated: 0 };
      }
      this.#stats.sourceItemsInspected += 1;
      if (record.streaming === true) {
        const changed = this.#updateStreamingRecordFromItem(record, next);
        if (changed) updated += 1;
        else if (record.item !== next) record.item = next;
        continue;
      }
      this.#stats.itemFingerprintsComputed += 1;
      const fingerprint = itemFingerprint(next);
      if (fingerprint !== record.fingerprint) {
        this.#updateRecord(record, next, fingerprint);
        updated += 1;
      } else if (record.item !== next) {
        // Equal immutable replacement: retain the freshest reference without
        // invalidating its render output.
        record.item = next;
      }
    }

    let appended = 0;
    for (let index = this.#sources.length; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      this.#stats.sourceItemsInspected += 1;
      this.append(item);
      appended += 1;
    }
    return { rebuilt: false, appended, updated };
  }

  /**
   * Replace the ephemeral stream view set without touching durable history. The
   * source view and numeric revision are the equality contract; no canonical
   * serialization of the accumulated text is performed here.
   */
  syncStreamingViews(views: readonly TimelineStreamingView[]): void {
    const active = new Set<string>();
    for (const view of views) {
      active.add(view.id);
      this.updateStreamingRevision(
        view.id,
        view.revision,
        view.sourceView,
        view.item,
      );
    }

    let removed = false;
    for (const id of this.#streamingSources.keys()) {
      if (active.has(id)) continue;
      this.#streamingSources.delete(id);
      const entry = this.#entryByStableId.get(`source:${id}`);
      if (entry !== undefined) this.#entryByStableId.delete(entry.stableId);
      removed = true;
    }
    if (removed) this.#rebuildEntriesAndGroups(true);
  }

  /** Update one live source using an event-level revision instead of a fingerprint. */
  updateStreamingRevision(
    id: string,
    revision: number,
    sourceView: MarkdownSourceView,
    item?: TimelineItem,
  ): void {
    const prior = this.#streamingSources.get(id);
    if (prior === undefined) {
      if (item === undefined) return;
      const record: SourceRecord = {
        item,
        order: this.#nextSourceOrder++,
        revision,
        mutable: true,
        markdownIndex: sourceView,
        streaming: true,
      };
      this.#streamingSources.set(id, record);
      this.#newestSequence = Math.max(this.#newestSequence, item.sequence);
      this.#stats.streamingRevisionUpdates += 1;
      for (const entry of this.#entriesFor(record)) this.#insertEntry(entry);
      return;
    }

    if (prior.revision === revision) {
      if (item !== undefined && prior.item !== item) prior.item = item;
      prior.markdownIndex = sourceView;
      return;
    }

    this.#stats.streamingRevisionUpdates += 1;
    this.#updateRecord(
      prior,
      item ?? prior.item,
      undefined,
      sourceView,
      revision,
    );
  }

  removeStreamingRevision(id: string): boolean {
    if (!this.#streamingSources.delete(id)) return false;
    this.#rebuildEntriesAndGroups(true);
    return true;
  }

  append(item: TimelineItem): void {
    const existing = this.#sourceById.get(item.id);
    if (existing !== undefined) {
      if (existing.streaming === true) {
        this.#updateStreamingRecordFromItem(existing, item);
        return;
      }
      this.#stats.itemFingerprintsComputed += 1;
      this.#updateRecord(existing, item, itemFingerprint(item));
      return;
    }

    const record = this.#makeSourceRecord(item);
    this.#sources.push(record);
    this.#sourceById.set(item.id, record);
    if (record.mutable) this.#mutableSourceIds.add(item.id);
    this.#newestSequence = Math.max(this.#newestSequence, item.sequence);
    this.#stats.appended += 1;

    const generated = this.#entriesFor(record);
    for (const entry of generated) this.#insertEntry(entry);
  }

  update(item: TimelineItem): void {
    const record = this.#sourceById.get(item.id);
    if (record === undefined) {
      this.append(item);
      return;
    }
    if (record.streaming === true) {
      this.#updateStreamingRecordFromItem(record, item);
      return;
    }
    this.#stats.itemFingerprintsComputed += 1;
    this.#updateRecord(record, item, itemFingerprint(item));
  }

  remove(id: string): boolean {
    const record = this.#sourceById.get(id);
    if (record === undefined) return false;
    this.#sourceById.delete(id);
    this.#mutableSourceIds.delete(id);
    const index = this.#sources.indexOf(record);
    if (index >= 0) this.#sources.splice(index, 1);
    // Removal and resident-window prefix eviction are uncommon and may change
    // source tie order, so compact the order and rebuild once rather than leaving
    // stale ordering metadata behind.
    this.#renumberSources();
    this.#rebuildEntriesAndGroups(true);
    this.#stats.removed += 1;
    return true;
  }

  renderWindow(
    context: BlockContext,
    options: TimelineRenderOptions,
    maxLines: number,
    scrollOffsetFromBottom = 0,
  ): StyledLine[] {
    return this.renderWindowDetails(
      context,
      options,
      maxLines,
      scrollOffsetFromBottom,
    ).lines;
  }

  renderWindowDetails(
    context: BlockContext,
    options: TimelineRenderOptions,
    maxLines: number,
    scrollOffsetFromBottom = 0,
  ): TimelineWindowDetails {
    this.#stats.viewportQueries += 1;
    if (this.#groups.length === 0) return { lines: [], totalLines: 0 };
    const state = this.#viewState(context, options);
    state.prepareDynamic(options, this);
    return state.renderWindow(
      this,
      context,
      options,
      Math.max(1, Math.floor(maxLines)),
      Math.max(0, Math.floor(scrollOffsetFromBottom)),
    );
  }

  renderAll(
    context: BlockContext,
    options: TimelineRenderOptions = {},
  ): StyledLine[] {
    if (this.#groups.length === 0) return [];
    const state = this.#viewState(context, options);
    state.prepareDynamic(options, this);
    return state.renderAll(this, context, options);
  }

  clearRenderCache(): void {
    this.#viewStates.clear();
    this.#renderCache.clear();
  }

  resetStats(): void {
    Object.assign(this.#stats, EMPTY_STATS);
    this.#renderCache.resetStats();
  }

  // Used by TimelineViewState without exposing mutable internals publicly.
  _groups(): readonly InternalVisualGroup[] {
    return this.#groups;
  }

  _newestCommentaryGroupId(): string | undefined {
    return this.#newestCommentaryGroupId;
  }

  _runningTaskGroupIds(): ReadonlySet<string> {
    return this.#runningTaskGroupIds;
  }

  _renderGroup(
    group: InternalVisualGroup,
    index: number,
    context: BlockContext,
    options: TimelineRenderOptions,
  ): StyledLine[] {
    this.#stats.renderedGroups += 1;

    // Commentary entries share one stable visual group for indexing, but each
    // durable provider item remains its own rendered block. Joining distinct
    // items here would diverge from the authoritative renderer and would make
    // row heights change as history grows.
    if (group.kind === "commentary") {
      const lines: StyledLine[] = [];
      for (const [entryIndex, entry] of group.entries.entries()) {
        const rendered = this.#renderCache.renderItem(
          entry.item,
          entry.sourceRevision,
          context,
          this.#optionsForItem(
            entry.item,
            this.#entryOptions(group, index, entryIndex, options),
          ),
        );
        if (rendered.length === 0) continue;
        if (lines.length > 0) lines.push(blank());
        lines.push(...rendered);
      }
      return lines;
    }

    const perItem = this.#groupOptions(group, index, options);
    if (group.kind === "succeeded_reads" && group.entries.length <= 2) {
      const lines: StyledLine[] = [];
      for (const entry of group.entries) {
        const itemOptions = this.#optionsForItem(entry.item, perItem);
        const rendered = this.#renderCache.renderItem(
          entry.item,
          entry.sourceRevision,
          context,
          itemOptions,
        );
        if (rendered.length === 0) continue;
        if (lines.length > 0) lines.push(blank());
        lines.push(...rendered);
      }
      return lines;
    }

    const item = this.#materializeGroup(group);
    return this.#renderCache.renderItem(
      item,
      group.revision,
      context,
      this.#optionsForItem(item, perItem),
    );
  }

  _renderGroupTail(
    group: InternalVisualGroup,
    index: number,
    context: BlockContext,
    options: TimelineRenderOptions,
    maxLines: number,
  ): TimelineItemTailRender | undefined {
    if (group.kind === "succeeded_reads") return undefined;
    if (group.kind === "commentary" && group.entries.length > 1) {
      return this.#renderCommentaryGroupTail(group, index, context, options, maxLines);
    }

    const item = this.#materializeGroup(group);
    if (item.type !== "commentary" && item.type !== "final") return undefined;
    const markdownIndex = this.#markdownIndexForGroup(group, item);
    if (markdownIndex === undefined) return undefined;
    const result = renderTimelineItemTail(
      item,
      context,
      this.#optionsForItem(item, this.#groupOptions(group, index, options)),
      maxLines,
      markdownIndex,
    );
    if (result === undefined) return undefined;
    this.#stats.renderedGroups += 1;
    this.#stats.markdownSourceLinesRendered += result.sourceLinesRendered;
    if (result.bounded) this.#stats.boundedMarkdownRenders += 1;
    else this.#stats.fullMarkdownFallbacks += 1;
    return result;
  }

  #renderCommentaryGroupTail(
    group: InternalVisualGroup,
    groupIndex: number,
    context: BlockContext,
    options: TimelineRenderOptions,
    maxLines: number,
  ): TimelineItemTailRender | undefined {
    const rows = Math.max(1, Math.floor(maxLines));
    const chunks: StyledLine[][] = [];
    let usedRows = 0;
    let sourceLinesRendered = 0;
    let bounded = true;
    let complete = true;
    let entriesVisited = 0;

    for (let entryIndex = group.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = group.entries[entryIndex];
      if (entry === undefined) continue;
      const markdownIndex =
        entry.markdownIndex ??
        (entry.item.type === "commentary"
          ? createMarkdownSourceIndex(entry.item.text)
          : undefined);
      if (markdownIndex === undefined) return undefined;
      const remaining = Math.max(1, rows - usedRows);
      const result = renderTimelineItemTail(
        entry.item,
        context,
        this.#optionsForItem(
          entry.item,
          this.#entryOptions(group, groupIndex, entryIndex, options),
        ),
        remaining,
        markdownIndex,
      );
      if (result === undefined) return undefined;
      entriesVisited += 1;
      sourceLinesRendered += result.sourceLinesRendered;
      bounded = bounded && result.bounded;
      chunks.unshift(result.lines);
      if (result.lines.length > 0) {
        usedRows += result.totalLines ?? result.lines.length;
        if (chunks.length > 1) usedRows += 1;
      }
      if (result.totalLines === undefined) {
        complete = false;
        break;
      }
      if (usedRows >= rows) break;
    }

    const lines: StyledLine[] = [];
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      if (lines.length > 0) lines.push(blank());
      lines.push(...chunk);
    }
    const allEntriesVisited = complete && entriesVisited === group.entries.length;
    const totalLines = allEntriesVisited ? lines.length : undefined;
    // `lines` contains the chronological suffix; row clipping belongs to the
    // caller so the separator immediately before a visible item is retained.
    const clipped = lines.slice(Math.max(0, lines.length - rows));
    this.#stats.renderedGroups += 1;
    this.#stats.markdownSourceLinesRendered += sourceLinesRendered;
    if (bounded) this.#stats.boundedMarkdownRenders += 1;
    else this.#stats.fullMarkdownFallbacks += 1;
    return {
      lines: clipped,
      ...(totalLines !== undefined ? { totalLines } : {}),
      sourceLinesRendered,
      bounded,
    };
  }

  #groupOptions(
    group: InternalVisualGroup,
    index: number,
    options: TimelineRenderOptions,
  ): TimelineRenderOptions {
    const assistant = group.kind === "commentary";
    const newest = assistant && group.id === this.#newestCommentaryGroupId;
    const previousAssistant = this.#groups[index - 1]?.kind === "commentary";
    const perItem: TimelineRenderOptions = {
      ...options,
      isNewestCommentary: newest,
      groupAssistant:
        options.groupAssistant === true && assistant && previousAssistant,
    };
    if (assistant && !newest) {
      delete (perItem as { reasoningElapsedMs?: number }).reasoningElapsedMs;
    }
    return perItem;
  }

  #entryOptions(
    group: InternalVisualGroup,
    groupIndex: number,
    entryIndex: number,
    options: TimelineRenderOptions,
  ): TimelineRenderOptions {
    const assistant = group.kind === "commentary";
    const newest =
      assistant &&
      group.id === this.#newestCommentaryGroupId &&
      entryIndex === group.entries.length - 1;
    const previousAssistant =
      entryIndex > 0 || this.#groups[groupIndex - 1]?.kind === "commentary";
    const perItem: TimelineRenderOptions = {
      ...options,
      isNewestCommentary: newest,
      groupAssistant:
        options.groupAssistant === true && assistant && previousAssistant,
    };
    if (assistant && !newest) {
      delete (perItem as { reasoningElapsedMs?: number }).reasoningElapsedMs;
    }
    return perItem;
  }
  #markdownIndexForGroup(
    group: InternalVisualGroup,
    item: TimelineItem,
  ): MarkdownSourceView | undefined {
    if (item.type === "commentary") {
      if (group.entries.length === 1) return group.entries[0]?.markdownIndex;
      if (
        group.markdownIndex !== undefined &&
        group.markdownIndexRevision === group.revision
      ) {
        return group.markdownIndex;
      }
      const sources = group.entries.map((entry) =>
        entry.item.type === "commentary" ? entry.item.text : "",
      );
      const composite = createCompositeMarkdownSourceIndex(sources);
      group.markdownIndex = composite;
      group.markdownIndexRevision = group.revision;
      return composite;
    }

    const source = markdownSourceForItem(item);
    if (source === undefined) return undefined;
    const direct = group.entries[0]?.markdownIndex;
    if (group.entries.length === 1 && direct !== undefined) return direct;
    if (
      group.markdownIndex !== undefined &&
      group.markdownIndexRevision === group.revision
    ) {
      return group.markdownIndex;
    }
    const index = createMarkdownSourceIndex(source);
    group.markdownIndex = index;
    group.markdownIndexRevision = group.revision;
    return index;
  }

  #optionsForItem(
    item: TimelineItem,
    options: TimelineRenderOptions,
  ): TimelineRenderOptions {
    return options.inlineSubagentEvents === true || item.type !== "task"
      ? options
      : { ...options, hideSubagentEvents: true };
  }

  #viewState(
    context: BlockContext,
    options: TimelineRenderOptions,
  ): TimelineViewState {
    const key = timelineLayoutCacheKey(context, options);
    const cached = this.#viewStates.get(key);
    if (cached !== undefined) {
      this.#viewStates.delete(key);
      this.#viewStates.set(key, cached);
      return cached;
    }
    const state = new TimelineViewState(this.#groups);
    this.#viewStates.set(key, state);
    while (this.#viewStates.size > this.#maxRenderVariants) {
      const oldest = this.#viewStates.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#viewStates.delete(oldest);
    }
    return state;
  }

  #canUseAppendFastPath(items: readonly TimelineItem[]): boolean {
    if (this.#sources.length === 0) return items.length === 0;
    if (items.length < this.#sources.length) return false;
    const first = items[0];
    const priorFirst = this.#sources[0]?.item;
    const boundary = items[this.#sources.length - 1];
    const priorBoundary = this.#sources[this.#sources.length - 1]?.item;
    return (
      first?.id === priorFirst?.id &&
      first?.sequence === priorFirst?.sequence &&
      boundary?.id === priorBoundary?.id &&
      boundary?.sequence === priorBoundary?.sequence
    );
  }

  #makeSourceRecord(item: TimelineItem): SourceRecord {
    const streaming = item.id.startsWith("streaming-");
    const mutable = streaming || isPotentiallyMutable(item);
    if (mutable && !streaming) this.#stats.itemFingerprintsComputed += 1;
    const markdownSource = markdownSourceForItem(item);
    return {
      item,
      order: this.#nextSourceOrder++,
      revision: 0,
      // Completed prose/finals never change in place and can contain megabytes;
      // do not duplicate that text merely to fingerprint an immutable record.
      ...(mutable && !streaming ? { fingerprint: itemFingerprint(item) } : {}),
      mutable,
      ...(markdownSource !== undefined
        ? {
            markdownIndex: streaming
              ? new AppendableMarkdownSourceIndex([markdownSource])
              : createMarkdownSourceIndex(markdownSource),
          }
        : {}),
      ...(streaming
        ? { streaming: true, streamingTextLength: markdownSource?.length ?? 0 }
        : {}),
    };
  }

  #updateStreamingRecordFromItem(
    record: SourceRecord,
    item: TimelineItem,
  ): boolean {
    const previousSource = markdownSourceForItem(record.item) ?? "";
    const nextSource = markdownSourceForItem(item) ?? "";
    if (previousSource === nextSource) return false;
    let index: MarkdownSourceView;
    if (
      nextSource.startsWith(previousSource) &&
      record.markdownIndex instanceof AppendableMarkdownSourceIndex
    ) {
      record.markdownIndex.append(nextSource.slice(previousSource.length));
      index = record.markdownIndex;
    } else {
      // A legacy caller replaced the stream with a non-prefix value. Keep the
      // safe fallback; the explicit revision/source API never takes this branch.
      index = new AppendableMarkdownSourceIndex([nextSource]);
    }
    record.streamingTextLength = nextSource.length;
    this.#updateRecord(record, item, undefined, index);
    return true;
  }

  #updateRecord(
    record: SourceRecord,
    item: TimelineItem,
    fingerprint?: string,
    markdownIndex?: MarkdownSourceView,
    revisionOverride?: number,
  ): void {
    const oldItem = record.item;
    record.item = item;
    if (fingerprint !== undefined) record.fingerprint = fingerprint;
    record.revision = revisionOverride ?? record.revision + 1;
    record.mutable = record.streaming === true || isPotentiallyMutable(item);
    const markdownSource = markdownSourceForItem(item);
    if (markdownIndex !== undefined) record.markdownIndex = markdownIndex;
    else if (record.streaming === true) {
      // Streaming sources own their appendable index. Never rebuild it from the
      // accumulated item text when a revision arrives.
      if (markdownSource === undefined) delete record.markdownIndex;
    } else if (markdownSource === undefined) delete record.markdownIndex;
    else record.markdownIndex = createMarkdownSourceIndex(markdownSource);
    if (record.streaming !== true) {
      if (record.mutable) this.#mutableSourceIds.add(item.id);
      else this.#mutableSourceIds.delete(item.id);
    }
    this.#stats.updated += 1;

    const directEntry = this.#entryByStableId.get(`source:${oldItem.id}`);
    const generated = this.#entriesFor(record);
    if (
      directEntry !== undefined &&
      generated.length === 1 &&
      directEntry.stableId === generated[0]?.stableId &&
      directEntry.sequence === generated[0]?.sequence
    ) {
      const entry = directEntry;
      const group = entry.group;
      const priorKind = group === undefined
        ? entryGroupDescriptor(entry, this.#projectionOptions)
        : {
            kind: group.kind,
            compatibilityKey: group.compatibilityKey,
          };
      const nextEntry = generated[0] as ProjectionEntry;
      entry.item = nextEntry.item;
      entry.sequence = nextEntry.sequence;
      entry.sourceRevision = nextEntry.sourceRevision;
      if (nextEntry.markdownIndex === undefined) delete entry.markdownIndex;
      else entry.markdownIndex = nextEntry.markdownIndex;
      const nextKind = entryGroupDescriptor(entry, this.#projectionOptions);
      if (
        group !== undefined &&
        priorKind.kind === nextKind.kind &&
        priorKind.compatibilityKey === nextKind.compatibilityKey
      ) {
        group.revision += 1;
        delete group.synthetic;
        delete group.syntheticRevision;
        delete group.markdownIndex;
        delete group.markdownIndexRevision;
        this.#invalidateGroup(group.id);
        this.#refreshRunningGroup(group);
        return;
      }
      if (group !== undefined) {
        this.#regroupAround(group);
        return;
      }
    }

    if (directEntry === undefined && generated.length === 0) {
      // The origin is filtered from the visual projection (for example an
      // approval decision); its semantic update cannot change any row.
      return;
    }

    // Inline task expansion changes a small origin fan-out. It is uncommon and
    // capped, but can interleave by sequence; rebuild structure without rescanning
    // or refingerprinting source history.
    this.#rebuildEntriesAndGroups(true);
  }

  #renumberSources(): void {
    // SourceRecord.order is readonly by design; rebuild lightweight records so tie
    // order remains deterministic after arbitrary removal.
    const items = this.#sources.map((record) => record.item);
    this.#sources.length = 0;
    this.#sourceById.clear();
    this.#mutableSourceIds.clear();
    this.#nextSourceOrder = 0;
    for (const item of items) {
      const record = this.#makeSourceRecord(item);
      this.#sources.push(record);
      this.#sourceById.set(item.id, record);
      if (record.mutable) this.#mutableSourceIds.add(item.id);
    }
  }

  #entriesFor(record: SourceRecord): ProjectionEntry[] {
    const item = record.item;
    const raw: ProjectionEntry[] = [
      {
        stableId: `source:${item.id}`,
        originId: item.id,
        item,
        sequence: item.sequence,
        sourceOrder: record.order,
        subOrder: 0,
        sourceRevision: record.revision,
        ...(record.markdownIndex !== undefined
          ? { markdownIndex: record.markdownIndex }
          : {}),
      },
    ];

    const policy = resolvePresentationPolicy(this.#projectionOptions);
    const inlineChildren =
      policy.subagentDetail === "inline" ||
      this.#projectionOptions.inlineSubagentEvents === true;
    if (
      inlineChildren &&
      item.type === "task" &&
      item.role !== "subagent" &&
      item.subagentEvents.length > 0
    ) {
      const hidden = Math.max(
        0,
        item.subagentEvents.length - SUBAGENT_INLINE_VISIBLE,
      );
      let subOrder = 1;
      if (hidden > 0 && SUBAGENT_INLINE_VISIBLE > 0) {
        raw.push({
          stableId: `subagent-hidden:${item.id}`,
          originId: item.id,
          item: {
            type: "notice",
            id: `${item.id}::subagent-hidden`,
            sequence: this.#newestSequence || item.sequence,
            level: "info",
            text: `↳ subagent ${item.role || item.title} — … ${hidden} earlier tool call(s) hidden · showing last ${SUBAGENT_INLINE_VISIBLE}`,
            icon: "…",
          },
          sequence: this.#newestSequence || item.sequence,
          sourceOrder: record.order,
          subOrder: subOrder++,
          sourceRevision: record.revision,
        });
      }
      const visible =
        hidden > 0
          ? item.subagentEvents.slice(-SUBAGENT_INLINE_VISIBLE)
          : item.subagentEvents;
      for (const event of visible) {
        const child: TimelineToolCall = {
          type: "tool",
          id: event.id,
          sequence: event.sequence,
          callId: event.callId,
          toolId: event.toolId,
          argumentsSummary: event.argumentsSummary,
          agentId: item.taskId,
          status: event.status,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
          ...(event.progress !== undefined ? { progress: event.progress } : {}),
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(event.additions !== undefined ? { additions: event.additions } : {}),
          ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
          ...(event.artifacts !== undefined ? { artifacts: [...event.artifacts] } : {}),
          ...(event.diffPreview !== undefined
            ? { diffPreview: [...event.diffPreview] }
            : {}),
        };
        raw.push({
          stableId: `subagent:${item.id}:${event.id}`,
          originId: item.id,
          item: child,
          sequence: event.sequence,
          sourceOrder: record.order,
          subOrder: subOrder++,
          sourceRevision: record.revision,
        });
      }
    }

    return raw.filter((entry) => this.#isVisible(entry.item));
  }

  #isVisible(item: TimelineItem): boolean {
    const policy = resolvePresentationPolicy(this.#projectionOptions);
    if (item.type === "approval") return false;
    if (
      (item.type === "commentary" || item.type === "final") &&
      item.agentId !== undefined &&
      item.agentId !== "root"
    ) {
      return false;
    }
    if (
      item.type === "tool" &&
      item.agentId !== undefined &&
      item.agentId !== "root" &&
      policy.subagentDetail === "drawer"
    ) {
      return false;
    }
    return true;
  }

  #insertEntry(entry: ProjectionEntry): void {
    this.#entryByStableId.set(entry.stableId, entry);
    const tail = this.#entries[this.#entries.length - 1];
    if (tail === undefined || compareEntries(tail, entry) <= 0) {
      this.#entries.push(entry);
      this.#appendEntryToGroups(entry);
      return;
    }

    const index = lowerBoundEntry(this.#entries, entry);
    this.#entries.splice(index, 0, entry);
    // Out-of-order durable events are supported, but the reducer's normal path is
    // monotonic. Repartitioning here preserves stable output without imposing a
    // sort/filter pass on every normal frame.
    this.#rebuildGroups(true);
  }

  #appendEntryToGroups(entry: ProjectionEntry): void {
    const descriptor = entryGroupDescriptor(entry, this.#projectionOptions);
    const last = this.#groups[this.#groups.length - 1];
    if (
      last !== undefined &&
      last.kind !== "item" &&
      last.kind === descriptor.kind &&
      last.compatibilityKey === descriptor.compatibilityKey
    ) {
      const previousRevision = last.revision;
      last.entries.push(entry);
      entry.group = last;
      last.revision += 1;
      delete last.synthetic;
      delete last.syntheticRevision;
      if (
        last.kind === "commentary" &&
        last.markdownIndex instanceof CompositeMarkdownSourceIndex &&
        last.markdownIndexRevision === previousRevision &&
        entry.item.type === "commentary"
      ) {
        last.markdownIndex.append(entry.item.text);
        last.markdownIndexRevision = last.revision;
      } else {
        delete last.markdownIndex;
        delete last.markdownIndexRevision;
      }
      this.#invalidateGroup(last.id);
      if (last.kind === "commentary") this.#setNewestCommentary(last.id);
      this.#refreshRunningGroup(last);
      return;
    }

    const group = makeGroup(
      {
        id: groupIdFor(entry, descriptor.kind),
        kind: descriptor.kind,
        compatibilityKey: descriptor.compatibilityKey,
        entries: [entry],
      },
      undefined,
      this.#groups.length,
    );
    entry.group = group;
    this.#groups.push(group);
    for (const state of this.#viewStates.values()) state.append(group);
    if (group.kind === "commentary") this.#setNewestCommentary(group.id);
    this.#refreshRunningGroup(group);
  }

  #regroupAround(group: InternalVisualGroup): void {
    let index = group.positionHint;
    if (this.#groups[index] !== group) {
      index =
        this.#groups[this.#groups.length - 1] === group
          ? this.#groups.length - 1
          : this.#groups.indexOf(group);
    }
    if (index < 0) {
      this.#rebuildGroups(true);
      return;
    }
    const from = Math.max(0, index - 1);
    const to = Math.min(this.#groups.length, index + 2);
    const old = this.#groups.slice(from, to);
    const entries = old.flatMap((candidate) => candidate.entries);
    const specs = partitionEntries(entries, this.#projectionOptions);
    const replacements = reuseGroups(specs, old, from);
    this.#groups.splice(from, to - from, ...replacements);
    this.#repairGroupHints(from);
    for (const state of this.#viewStates.values()) {
      state.splice(from, to - from, replacements);
    }
    this.#refreshDerivedAfterStructuralChange(old, replacements);
  }

  #rebuildEntriesAndGroups(structural: boolean): void {
    this.#entries = [];
    this.#entryByStableId.clear();
    for (const record of [
      ...this.#sources,
      ...this.#streamingSources.values(),
    ]) {
      for (const entry of this.#entriesFor(record)) {
        this.#entries.push(entry);
        this.#entryByStableId.set(entry.stableId, entry);
      }
    }
    this.#entries.sort(compareEntries);
    this.#rebuildGroups(structural);
  }

  #rebuildGroups(structural: boolean): void {
    const old = this.#groups;
    const specs = partitionEntries(this.#entries, this.#projectionOptions);
    this.#groups = reuseGroups(specs, old, 0);
    this.#repairGroupHints(0);
    this.#runningTaskGroupIds.clear();
    this.#newestCommentaryGroupId = undefined;
    for (const group of this.#groups) {
      this.#refreshRunningGroup(group);
      if (group.kind === "commentary") this.#newestCommentaryGroupId = group.id;
    }
    for (const state of this.#viewStates.values()) state.reset(this.#groups);
    if (structural) this.#stats.structuralRebuilds += 1;
  }

  #repairGroupHints(from: number): void {
    // A middle splice is rare. Hints after it are repaired once so the hot tail
    // update path remains O(1).
    for (let index = from; index < this.#groups.length; index += 1) {
      const group = this.#groups[index];
      if (group === undefined) continue;
      group.positionHint = index;
      for (const entry of group.entries) entry.group = group;
    }
  }

  #refreshDerivedAfterStructuralChange(
    removed: readonly InternalVisualGroup[],
    inserted: readonly InternalVisualGroup[],
  ): void {
    for (const group of removed) this.#runningTaskGroupIds.delete(group.id);
    for (const group of inserted) this.#refreshRunningGroup(group);
    const previousNewest = this.#newestCommentaryGroupId;
    this.#newestCommentaryGroupId = undefined;
    for (let index = this.#groups.length - 1; index >= 0; index -= 1) {
      const group = this.#groups[index];
      if (group?.kind === "commentary") {
        this.#newestCommentaryGroupId = group.id;
        break;
      }
    }
    if (previousNewest !== this.#newestCommentaryGroupId) {
      if (previousNewest !== undefined) this.#invalidateGroup(previousNewest);
      if (this.#newestCommentaryGroupId !== undefined) {
        this.#invalidateGroup(this.#newestCommentaryGroupId);
      }
    }
  }

  #setNewestCommentary(id: string): void {
    const previous = this.#newestCommentaryGroupId;
    this.#newestCommentaryGroupId = id;
    if (previous !== undefined && previous !== id) this.#invalidateGroup(previous);
  }

  #refreshRunningGroup(group: InternalVisualGroup): void {
    const running = group.entries.some(
      (entry) => entry.item.type === "task" && entry.item.state === "running",
    );
    if (running) this.#runningTaskGroupIds.add(group.id);
    else this.#runningTaskGroupIds.delete(group.id);
  }

  #invalidateGroup(id: string): void {
    for (const state of this.#viewStates.values()) state.invalidate(id);
  }

  #materializeGroup(group: InternalVisualGroup): TimelineItem {
    if (
      group.synthetic !== undefined &&
      group.syntheticRevision === group.revision
    ) {
      return group.synthetic;
    }
    const first = group.entries[0]?.item;
    if (first === undefined) {
      throw new Error(`visual group ${group.id} has no entries`);
    }

    let materialized: TimelineItem = first;
    if (group.kind === "commentary") {
      const commentary = first as TimelineCommentary;
      materialized = {
        ...commentary,
        text: group.entries
          .map((entry) =>
            entry.item.type === "commentary" ? entry.item.text : "",
          )
          .join("\n\n"),
      };
    } else if (group.kind === "succeeded_reads" && group.entries.length > 2) {
      const reads = group.entries.map((entry) => entry.item as TimelineToolCall);
      const names = reads
        .map(
          (item) =>
            item.argumentsSummary.split(" ")[0] ?? item.toolId,
        )
        .filter(Boolean)
        .slice(0, 3);
      const summary =
        names.join(", ") +
        (reads.length > 3 ? ` +${reads.length - 3} more` : "");
      materialized = {
        type: "tool",
        id: `group-read-${reads[0]?.id ?? group.id}`,
        sequence: reads[0]?.sequence ?? 0,
        callId: reads[0]?.callId ?? "",
        toolId: "fs.read",
        argumentsSummary: `${reads.length} files (${summary})`,
        status: "succeeded",
        summary: `Read ${reads.length} files`,
      };
    }
    group.synthetic = materialized;
    group.syntheticRevision = group.revision;
    return materialized;
  }
}

interface ViewGroupEntry {
  readonly groupId: string;
  lines?: StyledLine[];
  /** Exact suffix of a Markdown group whose full height is intentionally unknown. */
  partialLines?: StyledLine[];
}

/** Lazy row-height index for one static semantic render variant. */
class TimelineViewState {
  #entries: ViewGroupEntry[] = [];
  readonly #indexByGroupId = new Map<string, number>();
  readonly #heights = new DynamicFenwick();
  readonly #unknown = new DynamicFenwick();
  #lastNowMs: number | undefined;
  #lastReasoningElapsedMs: number | undefined;
  #lastSpinnerFrame: number | undefined;

  constructor(groups: readonly InternalVisualGroup[]) {
    this.reset(groups);
  }

  reset(groups: readonly InternalVisualGroup[]): void {
    this.#entries = groups.map((group) => ({ groupId: group.id }));
    this.#indexByGroupId.clear();
    this.#entries.forEach((entry, index) =>
      this.#indexByGroupId.set(entry.groupId, index),
    );
    this.#heights.rebuild(Array.from({ length: groups.length }, () => 0));
    this.#unknown.rebuild(Array.from({ length: groups.length }, () => 1));
  }

  append(group: InternalVisualGroup): void {
    const index = this.#entries.length;
    this.#entries.push({ groupId: group.id });
    this.#indexByGroupId.set(group.id, index);
    this.#heights.append(0);
    this.#unknown.append(1);
  }

  splice(
    index: number,
    deleteCount: number,
    groups: readonly InternalVisualGroup[],
  ): void {
    const tail = index + deleteCount === this.#entries.length;
    if (tail) {
      for (let count = 0; count < deleteCount; count += 1) {
        const removed = this.#entries.pop();
        if (removed !== undefined) this.#indexByGroupId.delete(removed.groupId);
        this.#heights.pop();
        this.#unknown.pop();
      }
      for (const group of groups) this.append(group);
      return;
    }

    this.#entries.splice(
      index,
      deleteCount,
      ...groups.map((group) => ({ groupId: group.id })),
    );
    this.#indexByGroupId.clear();
    this.#entries.forEach((entry, entryIndex) =>
      this.#indexByGroupId.set(entry.groupId, entryIndex),
    );
    this.#heights.rebuild(
      Array.from({ length: this.#entries.length }, () => 0),
    );
    this.#unknown.rebuild(
      Array.from({ length: this.#entries.length }, () => 1),
    );
  }

  invalidate(groupId: string): void {
    const index = this.#indexByGroupId.get(groupId);
    if (index === undefined) return;
    const entry = this.#entries[index];
    if (entry === undefined) return;
    delete entry.lines;
    delete entry.partialLines;
    this.#heights.set(index, 0);
    this.#unknown.set(index, 1);
  }

  prepareDynamic(options: TimelineRenderOptions, projection: ProjectedTimeline): void {
    if (this.#lastNowMs !== options.nowMs) {
      for (const id of projection._runningTaskGroupIds()) this.invalidate(id);
      this.#lastNowMs = options.nowMs;
    }
    if (
      this.#lastReasoningElapsedMs !== options.reasoningElapsedMs ||
      this.#lastSpinnerFrame !== options.thinkingSpinnerFrame
    ) {
      const newest = projection._newestCommentaryGroupId();
      if (newest !== undefined) this.invalidate(newest);
      this.#lastReasoningElapsedMs = options.reasoningElapsedMs;
      this.#lastSpinnerFrame = options.thinkingSpinnerFrame;
    }
  }

  renderWindow(
    projection: ProjectedTimeline,
    context: BlockContext,
    options: TimelineRenderOptions,
    viewport: number,
    offset: number,
  ): TimelineWindowDetails {
    const budget = viewport + offset;
    const partialIndex = this.#prepareSuffix(
      projection,
      context,
      options,
      budget,
    );
    const groupCount = this.#entries.length;

    if (partialIndex !== undefined) {
      const partial = this.#entries[partialIndex]?.partialLines ?? [];
      const lines: StyledLine[] = [...partial];
      if (partialIndex + 1 < groupCount) {
        lines.push(blank(), ...this.#completeLinesFrom(partialIndex + 1));
      }
      return { lines: lines.slice(Math.max(0, lines.length - budget)) };
    }

    const remainingUnknown = this.#unknown.total();
    const lastUnknown =
      remainingUnknown > 0
        ? this.#unknown.findByOrder(remainingUnknown)
        : -1;
    const knownStart = lastUnknown + 1;
    const knownRows = this.#actualSuffixRows(knownStart);
    if (knownRows <= 0) {
      return remainingUnknown === 0
        ? { lines: [], totalLines: 0 }
        : { lines: [] };
    }

    const wanted = Math.min(budget, knownRows);
    let low = knownStart;
    let high = groupCount - 1;
    let start = knownStart;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#actualSuffixRows(middle) >= wanted) {
        start = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const available = this.#actualSuffixRows(start);
    let skip = Math.max(0, available - wanted);
    const lines: StyledLine[] = [];
    for (let index = start; index < groupCount; index += 1) {
      const entry = this.#entries[index];
      const groupLines = entry?.lines ?? [];
      const contribution =
        index === start ? groupLines : [blank(), ...groupLines];
      if (skip >= contribution.length) {
        skip -= contribution.length;
        continue;
      }
      if (skip > 0) {
        lines.push(...contribution.slice(skip));
        skip = 0;
      } else {
        lines.push(...contribution);
      }
    }

    return remainingUnknown === 0
      ? { lines, totalLines: this.#heights.total() }
      : { lines };
  }

  renderAll(
    projection: ProjectedTimeline,
    context: BlockContext,
    options: TimelineRenderOptions,
  ): StyledLine[] {
    while (this.#unknown.total() > 0) {
      const index = this.#unknown.findByOrder(this.#unknown.total());
      this.#ensureFull(index, projection, context, options);
    }
    return this.#completeLinesFrom(0);
  }

  /**
   * Learn enough of the suffix for this query. Returns the one partially-rendered
   * giant Markdown group when its exact tail satisfied the budget without learning
   * its full height.
   */
  #prepareSuffix(
    projection: ProjectedTimeline,
    context: BlockContext,
    options: TimelineRenderOptions,
    rows: number,
  ): number | undefined {
    while (true) {
      const unknownCount = this.#unknown.total();
      const lastUnknown =
        unknownCount > 0 ? this.#unknown.findByOrder(unknownCount) : -1;
      const knownStart = lastUnknown + 1;
      const knownRows = this.#actualSuffixRows(knownStart);
      if (knownRows >= rows || lastUnknown < 0) return undefined;

      const hasLaterGroup = knownStart < this.#entries.length;
      const partialRows = Math.max(
        0,
        rows - knownRows - (hasLaterGroup ? 1 : 0),
      );
      const entry = this.#entries[lastUnknown];
      if (entry === undefined) return undefined;
      if (
        entry.partialLines !== undefined &&
        entry.partialLines.length >= partialRows
      ) {
        return lastUnknown;
      }
      if (partialRows === 0) {
        entry.partialLines = [];
        return lastUnknown;
      }

      const group = projection._groups()[lastUnknown];
      const partial =
        group === undefined
          ? undefined
          : projection._renderGroupTail(
              group,
              lastUnknown,
              context,
              options,
              partialRows,
            );
      if (partial === undefined || !partial.bounded) {
        this.#ensureFull(lastUnknown, projection, context, options);
        continue;
      }

      if (
        partial.totalLines !== undefined &&
        partial.lines.length === partial.totalLines
      ) {
        this.#markComplete(lastUnknown, partial.lines);
        continue;
      }
      entry.partialLines = partial.lines;
      return lastUnknown;
    }
  }

  #ensureFull(
    index: number,
    projection: ProjectedTimeline,
    context: BlockContext,
    options: TimelineRenderOptions,
  ): void {
    if (index < 0 || this.#unknown.valueAt(index) === 0) return;
    const group = projection._groups()[index];
    if (group === undefined) return;
    this.#markComplete(
      index,
      projection._renderGroup(group, index, context, options),
    );
  }

  #markComplete(index: number, lines: StyledLine[]): void {
    const entry = this.#entries[index];
    if (entry === undefined) return;
    entry.lines = lines;
    delete entry.partialLines;
    this.#heights.set(index, lines.length + (index > 0 ? 1 : 0));
    this.#unknown.set(index, 0);
  }

  #completeLinesFrom(start: number): StyledLine[] {
    const lines: StyledLine[] = [];
    for (let index = start; index < this.#entries.length; index += 1) {
      const entry = this.#entries[index];
      if (entry?.lines === undefined || entry.lines.length === 0) continue;
      if (lines.length > 0) lines.push(blank());
      lines.push(...entry.lines);
    }
    return lines;
  }

  #actualSuffixRows(start: number): number {
    if (start >= this.#entries.length) return 0;
    return Math.max(
      0,
      this.#heights.range(start, this.#entries.length) - (start > 0 ? 1 : 0),
    );
  }
}

/** Fenwick tree supporting the hot append/update/pop paths. */
class DynamicFenwick {
  #values: number[] = [];
  #tree: number[] = [0];

  rebuild(values: readonly number[]): void {
    this.#values = [...values];
    this.#tree = Array.from({ length: values.length + 1 }, () => 0);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] ?? 0;
      let treeIndex = index + 1;
      while (treeIndex < this.#tree.length) {
        this.#tree[treeIndex] = (this.#tree[treeIndex] ?? 0) + value;
        treeIndex += treeIndex & -treeIndex;
      }
    }
  }

  append(value: number): void {
    const oldLength = this.#values.length;
    this.#values.push(value);
    const treeIndex = oldLength + 1;
    const start = treeIndex - (treeIndex & -treeIndex);
    const inherited = this.prefix(oldLength) - this.prefix(start);
    this.#tree.push(inherited + value);
  }

  pop(): number | undefined {
    if (this.#values.length === 0) return undefined;
    const index = this.#values.length - 1;
    const value = this.#values[index];
    this.set(index, 0);
    this.#values.pop();
    this.#tree.pop();
    return value;
  }

  set(index: number, value: number): void {
    const prior = this.#values[index];
    if (prior === undefined || prior === value) return;
    this.#values[index] = value;
    const delta = value - prior;
    let treeIndex = index + 1;
    while (treeIndex < this.#tree.length) {
      this.#tree[treeIndex] = (this.#tree[treeIndex] ?? 0) + delta;
      treeIndex += treeIndex & -treeIndex;
    }
  }

  valueAt(index: number): number {
    return this.#values[index] ?? 0;
  }

  prefix(count: number): number {
    let index = Math.max(0, Math.min(Math.floor(count), this.#values.length));
    let sum = 0;
    while (index > 0) {
      sum += this.#tree[index] ?? 0;
      index -= index & -index;
    }
    return sum;
  }

  range(start: number, end: number): number {
    return this.prefix(end) - this.prefix(start);
  }

  total(): number {
    return this.prefix(this.#values.length);
  }

  /** Zero-based index containing the one-based cumulative order. */
  findByOrder(order: number): number {
    if (order <= 0 || order > this.total()) return -1;
    let index = 0;
    let bit = 1;
    while (bit * 2 <= this.#values.length) bit *= 2;
    let remaining = order;
    while (bit > 0) {
      const next = index + bit;
      const value = this.#tree[next] ?? 0;
      if (next <= this.#values.length && value < remaining) {
        index = next;
        remaining -= value;
      }
      bit = Math.floor(bit / 2);
    }
    return Math.min(index, this.#values.length - 1);
  }
}

function projectionOptionsKey(options: TimelineRenderOptions): string {
  const policy = resolvePresentationPolicy(options);
  return JSON.stringify([
    policy.subagentDetail,
    options.inlineSubagentEvents === true,
    options.groupSucceededReads ??
      (options.progressiveDisclosure === true || policy.toolDetail === "compact"),
  ]);
}

function timelineLayoutCacheKey(
  context: BlockContext,
  options: TimelineRenderOptions,
): string {
  const staticOptions: Record<string, unknown> = { ...options };
  delete staticOptions.nowMs;
  delete staticOptions.reasoningElapsedMs;
  delete staticOptions.thinkingSpinnerFrame;
  delete staticOptions.isNewestCommentary;
  delete staticOptions.groupAssistant;
  delete staticOptions.hideSubagentEvents;
  return canonicalValue({ context, options: staticOptions });
}

function itemFingerprint(item: TimelineItem): string {
  return canonicalValue(item);
}

function canonicalValue(value: unknown, seen = new Set<object>()): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "dNaN";
    if (Object.is(value, -0)) return "d-0";
    return `d${String(value)}`;
  }
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "bigint") return `i${String(value)}`;
  if (typeof value === "symbol") return `y${String(value.description ?? "")}`;
  if (typeof value === "function") return `f${value.name}`;
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
  }
  if (value instanceof Set) {
    return `t[${[...value]
      .map((entry) => canonicalValue(entry, seen))
      .sort()
      .join(",")}]`;
  }
  if (value instanceof Map) {
    return `m{${[...value.entries()]
      .map(
        ([key, entry]) =>
          `${canonicalValue(key, seen)}:${canonicalValue(entry, seen)}`,
      )
      .sort()
      .join(",")}}`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) return "<cycle>";
    seen.add(object);
    const result = `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key], seen)}`)
      .join(",")}}`;
    seen.delete(object);
    return result;
  }
  return String(value);
}

function markdownSourceForItem(item: TimelineItem): string | undefined {
  if (item.type === "commentary") return item.text;
  if (item.type === "final") return finalAnswerText(item);
  return undefined;
}

function isPotentiallyMutable(item: TimelineItem): boolean {
  // Full-screen streaming rows are synthetic timeline items. Their stable ids let
  // the projection append later phases without rebuilding history, but their text
  // changes on every coalesced delta until the durable assistant event lands.
  if (item.id.startsWith("streaming-")) return true;
  switch (item.type) {
    case "tool":
      return item.status === "running";
    case "task":
      return ["queued", "running", "waiting"].includes(item.state);
    case "approval":
      return item.decision === undefined;
    case "job":
      return item.state === "running";
    case "plan":
      return true;
    default:
      return false;
  }
}

function isSucceededRead(item: TimelineItem): boolean {
  return (
    item.type === "tool" &&
    item.status === "succeeded" &&
    ["fs.read", "fs.read_many", "fs.list", "fs.search", "fs.grep"].includes(
      item.toolId,
    )
  );
}

function entryGroupDescriptor(
  entry: ProjectionEntry,
  options: TimelineRenderOptions = {},
): { kind: TimelineVisualGroupKind; compatibilityKey: string } {
  if (entry.item.type === "commentary") {
    return {
      kind: "commentary",
      compatibilityKey: canonicalValue([
        entry.item.variant,
        entry.item.turnId,
        entry.item.agentId,
      ]),
    };
  }
  const policy = resolvePresentationPolicy(options);
  const shouldGroupReads =
    options.groupSucceededReads ??
    (options.progressiveDisclosure === true || policy.toolDetail === "compact");
  if (shouldGroupReads && isSucceededRead(entry.item)) {
    return { kind: "succeeded_reads", compatibilityKey: "read" };
  }
  return { kind: "item", compatibilityKey: entry.stableId };
}

function groupIdFor(
  entry: ProjectionEntry,
  kind: TimelineVisualGroupKind,
): string {
  if (kind === "commentary") return `commentary:${entry.stableId}`;
  if (kind === "succeeded_reads") return `reads:${entry.stableId}`;
  return `item:${entry.stableId}`;
}

function partitionEntries(
  entries: readonly ProjectionEntry[],
  options: TimelineRenderOptions,
): GroupSpec[] {
  const groups: GroupSpec[] = [];
  for (const entry of entries) {
    const descriptor = entryGroupDescriptor(entry, options);
    const last = groups[groups.length - 1];
    if (
      descriptor.kind !== "item" &&
      last?.kind === descriptor.kind &&
      last.compatibilityKey === descriptor.compatibilityKey
    ) {
      (last.entries as ProjectionEntry[]).push(entry);
      continue;
    }
    groups.push({
      id: groupIdFor(entry, descriptor.kind),
      kind: descriptor.kind,
      compatibilityKey: descriptor.compatibilityKey,
      entries: [entry],
    });
  }
  return groups;
}

function reuseGroups(
  specs: readonly GroupSpec[],
  oldGroups: readonly InternalVisualGroup[],
  offset: number,
): InternalVisualGroup[] {
  const oldById = new Map(oldGroups.map((group) => [group.id, group]));
  return specs.map((spec, index) =>
    makeGroup(spec, oldById.get(spec.id), offset + index),
  );
}

function makeGroup(
  spec: GroupSpec,
  prior: InternalVisualGroup | undefined,
  position: number,
): InternalVisualGroup {
  const unchanged =
    prior !== undefined &&
    prior.kind === spec.kind &&
    prior.compatibilityKey === spec.compatibilityKey &&
    prior.entries.length === spec.entries.length &&
    prior.entries.every(
      (entry, index) =>
        entry.stableId === spec.entries[index]?.stableId &&
        entry.sourceRevision === spec.entries[index]?.sourceRevision,
    );
  const group: InternalVisualGroup = {
    id: spec.id,
    kind: spec.kind,
    compatibilityKey: spec.compatibilityKey,
    entries: [...spec.entries],
    revision: unchanged ? prior.revision : (prior?.revision ?? -1) + 1,
    positionHint: position,
    ...(unchanged && prior.synthetic !== undefined
      ? {
          synthetic: prior.synthetic,
          ...(prior.syntheticRevision !== undefined
            ? { syntheticRevision: prior.syntheticRevision }
            : {}),
        }
      : {}),
    ...(unchanged && prior.markdownIndex !== undefined
      ? {
          markdownIndex: prior.markdownIndex,
          ...(prior.markdownIndexRevision !== undefined
            ? { markdownIndexRevision: prior.markdownIndexRevision }
            : {}),
        }
      : {}),
  };
  for (const entry of group.entries) entry.group = group;
  return group;
}

function compareEntries(left: ProjectionEntry, right: ProjectionEntry): number {
  return (
    left.sequence - right.sequence ||
    left.sourceOrder - right.sourceOrder ||
    left.subOrder - right.subOrder
  );
}

function lowerBoundEntry(
  entries: readonly ProjectionEntry[],
  target: ProjectionEntry,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = entries[middle];
    if (value !== undefined && compareEntries(value, target) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
