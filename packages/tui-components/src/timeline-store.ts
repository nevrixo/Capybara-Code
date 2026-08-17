/**
 * Page-bounded historical timeline residency for long sessions.
 *
 * Pages are immutable UI projections; the durable journal remains the source of
 * truth and can be requested again after eviction. The store deliberately keeps
 * only a small number of pages so a 700+ turn session never grows a full UI array.
 */
export interface PagedTimelinePage<T> {
  readonly id: string;
  readonly items: readonly T[];
  readonly firstSequence?: number;
  readonly lastSequence?: number;
  readonly encodedBytes?: number;
}

export interface PagedTimelineStoreOptions {
  readonly maxResidentPages?: number;
}

export class PagedTimelineStore<T extends { readonly id?: string; readonly sequence?: number }> {
  readonly #maxResidentPages: number;
  readonly #pages = new Map<string, PagedTimelinePage<T>>();
  #liveTail: readonly T[] = [];

  constructor(options: PagedTimelineStoreOptions = {}) {
    this.#maxResidentPages = Math.max(1, Math.floor(options.maxResidentPages ?? 3));
  }

  get pageCount(): number {
    return this.#pages.size;
  }

  get pages(): readonly PagedTimelinePage<T>[] {
    return [...this.#pages.values()].sort(comparePages);
  }

  get historicalItems(): readonly T[] {
    return this.pages.flatMap((page) => page.items);
  }

  get items(): readonly T[] {
    return [...this.historicalItems, ...this.#liveTail];
  }

  setLiveTail(items: readonly T[]): void {
    this.#liveTail = items;
  }

  prependPage(page: PagedTimelinePage<T>): readonly string[] {
    if (page.id.length === 0) throw new RangeError("page id must not be empty");
    this.#pages.delete(page.id);
    const existing = new Set(
      [...this.#pages.values()].flatMap((resident) => resident.items.map(itemKey)),
    );
    const deduped = dedupeItems(page.items).filter((item) => !existing.has(itemKey(item)));
    this.#pages.set(page.id, {
      ...page,
      items: deduped,
      ...(page.firstSequence === undefined && deduped[0]?.sequence !== undefined
        ? { firstSequence: deduped[0].sequence }
        : {}),
      ...(page.lastSequence === undefined && deduped.at(-1)?.sequence !== undefined
        ? { lastSequence: deduped.at(-1)!.sequence }
        : {}),
    });
    return this.evictFarPages();
  }

  dropPage(pageId: string): boolean {
    return this.#pages.delete(pageId);
  }

  clear(): void {
    this.#pages.clear();
    this.#liveTail = [];
  }

  /** Keep the newest historical pages, returning evicted page ids for refetch bookkeeping. */
  evictFarPages(maxPages = this.#maxResidentPages): readonly string[] {
    const evicted: string[] = [];
    const ordered = [...this.pages];
    while (ordered.length > Math.max(1, Math.floor(maxPages))) {
      const oldest = ordered.shift();
      if (oldest === undefined) break;
      if (this.#pages.delete(oldest.id)) evicted.push(oldest.id);
    }
    return evicted;
  }
}

function itemKey(item: { readonly id?: string; readonly sequence?: number }): string {
  return item.id ?? `sequence:${item.sequence ?? "unknown"}`;
}
function dedupeItems<T extends { readonly id?: string; readonly sequence?: number }>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function comparePages<T>(left: PagedTimelinePage<T>, right: PagedTimelinePage<T>): number {
  return (left.firstSequence ?? Number.MIN_SAFE_INTEGER) -
    (right.firstSequence ?? Number.MIN_SAFE_INTEGER);
}