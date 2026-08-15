/**
 * P2 session persistence primitives: validated snapshot envelopes, stable
 * byte-aware journal paging, tail-only replay, and bounded resident windows.
 *
 * Durable journal rows remain owned by the Rust store and are never deleted by
 * any helper in this module. Resident eviction only drops in-memory copies; the
 * returned earlier-page cursor can always retrieve an omitted prefix again.
 */

export const SNAPSHOT_ENVELOPE_VERSION = 1 as const;
export const JOURNAL_GENESIS_HASH = "0".repeat(64);
export const DEFAULT_SESSION_PAGE_ITEMS = 1_000;
export const DEFAULT_SESSION_PAGE_BYTES = 4 * 1024 * 1024;

const UTF8 = new TextEncoder();

export class PersistenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PersistenceValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new PersistenceValidationError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PersistenceValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nonEmptyString(value, label);
}

function wireBytes(value: unknown): number {
  return UTF8.encode(JSON.stringify(value) ?? "null").byteLength;
}

export interface SnapshotEnvelope<State extends Record<string, unknown> = Record<string, unknown>> {
  readonly snapshotVersion: typeof SNAPSHOT_ENVELOPE_VERSION;
  readonly sessionId: string;
  /** Dense, durable SQLite journal position. */
  readonly journalSequence: number;
  /** Highest protocol sequence, including gaps consumed by ephemeral events. */
  readonly streamSequence?: number;
  /** Hash of the durable event at journalSequence (genesis at zero). */
  readonly journalHash?: string;
  readonly reducerState: State;
}

export interface StoredSnapshotEnvelope<
  State extends Record<string, unknown> = Record<string, unknown>,
> extends SnapshotEnvelope<State> {
  readonly checksum?: string;
  readonly createdAt?: string;
  readonly legacy: boolean;
}

export interface SnapshotEnvelopeInput<State extends Record<string, unknown>> {
  readonly sessionId: string;
  readonly journalSequence: number;
  readonly streamSequence?: number;
  readonly journalHash?: string;
  readonly reducerState: State;
}

export function createSnapshotEnvelope<State extends Record<string, unknown>>(
  input: SnapshotEnvelopeInput<State>,
): SnapshotEnvelope<State> {
  return validateSnapshotEnvelope({
    snapshotVersion: SNAPSHOT_ENVELOPE_VERSION,
    ...input,
  }) as SnapshotEnvelope<State>;
}

/**
 * Validate the envelope shape synchronously. Legacy runtime responses with only
 * `sequence` are upgraded in memory when `allowLegacy` is true.
 */
export function validateSnapshotEnvelope(
  raw: unknown,
  options: { readonly expectedSessionId?: string; readonly allowLegacy?: boolean } = {},
): StoredSnapshotEnvelope {
  const value = record(raw, "snapshot envelope");
  const allowLegacy = options.allowLegacy ?? true;
  const rawVersion = value.snapshotVersion;
  const legacy = rawVersion === undefined;
  if (legacy && !allowLegacy) {
    throw new PersistenceValidationError("snapshotVersion is required");
  }
  const snapshotVersion = legacy
    ? SNAPSHOT_ENVELOPE_VERSION
    : safeInteger(rawVersion, "snapshotVersion", 1);
  if (snapshotVersion !== SNAPSHOT_ENVELOPE_VERSION) {
    throw new PersistenceValidationError(
      `unsupported snapshotVersion ${snapshotVersion}; expected ${SNAPSHOT_ENVELOPE_VERSION}`,
    );
  }

  const sessionId = nonEmptyString(
    value.sessionId ?? options.expectedSessionId,
    "snapshot.sessionId",
  );
  if (options.expectedSessionId !== undefined && sessionId !== options.expectedSessionId) {
    throw new PersistenceValidationError(
      `snapshot session ${sessionId} does not match ${options.expectedSessionId}`,
    );
  }
  const explicitJournalSequence = value.journalSequence;
  const legacySequence = value.sequence;
  if (
    explicitJournalSequence !== undefined &&
    legacySequence !== undefined &&
    explicitJournalSequence !== legacySequence
  ) {
    throw new PersistenceValidationError("snapshot sequence aliases do not match");
  }
  const journalSequence = safeInteger(
    explicitJournalSequence ?? legacySequence,
    "snapshot.journalSequence",
  );
  const streamSequence =
    value.streamSequence === undefined || value.streamSequence === null
      ? undefined
      : safeInteger(value.streamSequence, "snapshot.streamSequence");
  if (streamSequence !== undefined && streamSequence < journalSequence) {
    throw new PersistenceValidationError(
      "snapshot.streamSequence cannot precede snapshot.journalSequence",
    );
  }
  const journalHash = optionalString(value.journalHash, "snapshot.journalHash");
  if (journalHash !== undefined && !/^[0-9a-f]{64}$/i.test(journalHash)) {
    throw new PersistenceValidationError("snapshot.journalHash must be a SHA-256 hex digest");
  }
  const reducerState = record(value.reducerState, "snapshot.reducerState");
  if (
    typeof reducerState.sessionId === "string" &&
    reducerState.sessionId !== sessionId
  ) {
    throw new PersistenceValidationError(
      "snapshot.reducerState.sessionId does not match snapshot.sessionId",
    );
  }
  if (
    reducerState.lastSequence !== undefined &&
    (typeof reducerState.lastSequence !== "number" ||
      !Number.isSafeInteger(reducerState.lastSequence) ||
      reducerState.lastSequence < 0)
  ) {
    throw new PersistenceValidationError("snapshot.reducerState.lastSequence is invalid");
  }

  const checksum = optionalString(value.checksum, "snapshot.checksum");
  if (checksum !== undefined && !/^[0-9a-f]{64}$/i.test(checksum)) {
    throw new PersistenceValidationError("snapshot.checksum must be a SHA-256 hex digest");
  }
  const createdAt = optionalString(value.createdAt, "snapshot.createdAt");
  return {
    snapshotVersion: SNAPSHOT_ENVELOPE_VERSION,
    sessionId,
    journalSequence,
    ...(streamSequence !== undefined ? { streamSequence } : {}),
    ...(journalHash !== undefined ? { journalHash } : {}),
    reducerState,
    ...(checksum !== undefined ? { checksum } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    legacy: value.legacy === true || legacy,
  };
}

/** Non-throwing counterpart for optional resume data. */
export function parseSnapshotEnvelope(
  raw: unknown,
  options: { readonly expectedSessionId?: string; readonly allowLegacy?: boolean } = {},
): StoredSnapshotEnvelope | undefined {
  try {
    return validateSnapshotEnvelope(raw, options);
  } catch {
    return undefined;
  }
}

function canonicalSnapshotValue(snapshot: SnapshotEnvelope): Record<string, unknown> {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    sessionId: snapshot.sessionId,
    journalSequence: snapshot.journalSequence,
    ...(snapshot.streamSequence !== undefined
      ? { streamSequence: snapshot.streamSequence }
      : {}),
    ...(snapshot.journalHash !== undefined ? { journalHash: snapshot.journalHash } : {}),
    reducerState: snapshot.reducerState,
  };
}

export async function snapshotEnvelopeChecksum(snapshot: SnapshotEnvelope): Promise<string> {
  const data = UTF8.encode(JSON.stringify(canonicalSnapshotValue(snapshot)));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate shape/version and, when present, the checksum before hydration. */
export async function validateStoredSnapshot(
  raw: unknown,
  options: {
    readonly expectedSessionId?: string;
    readonly allowLegacy?: boolean;
    readonly requireChecksum?: boolean;
  } = {},
): Promise<StoredSnapshotEnvelope> {
  const snapshot = validateSnapshotEnvelope(raw, options);
  if (snapshot.checksum === undefined) {
    if (options.requireChecksum === true) {
      throw new PersistenceValidationError("snapshot checksum is required");
    }
    return snapshot;
  }
  // Legacy (version-zero DB) checksums covered reducerState alone. The Rust
  // runtime validates those before returning an upgraded envelope; a JS client
  // cannot reproduce the original raw key ordering safely, so do not re-hash it.
  if (snapshot.legacy) return snapshot;
  const actual = await snapshotEnvelopeChecksum(snapshot);
  if (actual !== snapshot.checksum.toLowerCase()) {
    throw new PersistenceValidationError("snapshot checksum does not match its envelope");
  }
  return snapshot;
}

export interface JournalBoundary {
  readonly sequence: number;
  readonly eventHash: string;
}

export interface StoredJournalEvent {
  readonly sessionId: string;
  readonly sequence: number;
  readonly id: string;
  readonly kind: string;
  readonly timestamp: string;
  readonly schemaVersion: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly eventHash: string;
  readonly streamSequence?: number;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly callerId?: string;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly parentEventId?: string;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export interface JournalPageCursor {
  readonly afterSequence?: number;
  readonly afterHash?: string;
  readonly beforeSequence?: number;
  readonly beforeHash?: string;
  readonly throughSequence: number;
  readonly throughHash: string;
}

export interface JournalPageInfo {
  readonly direction: "forward" | "backward";
  readonly anchorSequence: number;
  readonly anchorHash?: string;
  readonly firstSequence?: number;
  readonly firstPrevHash?: string;
  readonly lastSequence?: number;
  readonly lastEventHash?: string;
  readonly through: JournalBoundary;
  readonly journalHead: JournalBoundary;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly encodedBytes: number;
  readonly maxBytes: number;
  readonly itemLimit: number;
  readonly truncatedByBytes: boolean;
  readonly oversizedSingleEvent: boolean;
}

export interface SessionJournalPage {
  readonly events: readonly StoredJournalEvent[];
  readonly page: JournalPageInfo;
  readonly earlierPage?: JournalPageCursor;
  readonly laterPage?: JournalPageCursor;
  readonly snapshot?: StoredSnapshotEnvelope;
  readonly tailOnly: boolean;
  readonly manifest?: unknown;
  readonly integrity?: unknown;
  readonly eventCount?: number;
}

function boundary(raw: unknown, label: string): JournalBoundary {
  const value = record(raw, label);
  return {
    sequence: safeInteger(value.sequence, `${label}.sequence`),
    eventHash: nonEmptyString(value.eventHash, `${label}.eventHash`),
  };
}

function storedEvent(raw: unknown, expectedSessionId?: string): StoredJournalEvent {
  const value = record(raw, "journal event");
  const sessionId = nonEmptyString(value.sessionId ?? expectedSessionId, "event.sessionId");
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw new PersistenceValidationError(`event belongs to unexpected session ${sessionId}`);
  }
  const streamSequence =
    value.streamSequence === undefined || value.streamSequence === null
      ? undefined
      : safeInteger(value.streamSequence, "event.streamSequence");
  const base: StoredJournalEvent = {
    ...value,
    sessionId,
    sequence: safeInteger(value.sequence, "event.sequence", 1),
    id: nonEmptyString(value.id, "event.id"),
    kind: nonEmptyString(value.kind, "event.kind"),
    timestamp: nonEmptyString(value.timestamp, "event.timestamp"),
    schemaVersion: nonEmptyString(value.schemaVersion, "event.schemaVersion"),
    payload: value.payload,
    prevHash: nonEmptyString(value.prevHash, "event.prevHash"),
    eventHash: nonEmptyString(value.eventHash, "event.eventHash"),
    ...(streamSequence !== undefined ? { streamSequence } : {}),
  };
  return base;
}

function cursor(raw: unknown, direction: "earlier" | "later"): JournalPageCursor | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = record(raw, `${direction} page cursor`);
  const throughSequence = safeInteger(value.throughSequence, "cursor.throughSequence");
  const throughHash = nonEmptyString(value.throughHash, "cursor.throughHash");
  if (direction === "earlier") {
    return {
      beforeSequence: safeInteger(value.beforeSequence, "cursor.beforeSequence", 1),
      beforeHash: nonEmptyString(value.beforeHash, "cursor.beforeHash"),
      throughSequence,
      throughHash,
    };
  }
  return {
    afterSequence: safeInteger(value.afterSequence, "cursor.afterSequence"),
    afterHash: nonEmptyString(value.afterHash, "cursor.afterHash"),
    throughSequence,
    throughHash,
  };
}

export function validateSessionJournalPage(
  raw: unknown,
  options: { readonly expectedSessionId?: string } = {},
): SessionJournalPage {
  const value = record(raw, "session.load response");
  if (!Array.isArray(value.events)) {
    throw new PersistenceValidationError("session.load events must be an array");
  }
  const events = value.events.map((event) => storedEvent(event, options.expectedSessionId));
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const current = events[index]!;
    if (current.sequence !== previous.sequence + 1) {
      throw new PersistenceValidationError("journal page contains a sequence gap");
    }
    if (current.prevHash !== previous.eventHash) {
      throw new PersistenceValidationError("journal page hash chain is discontinuous");
    }
  }

  const pageValue = record(value.page, "session.load page metadata");
  const direction = pageValue.direction;
  if (direction !== "forward" && direction !== "backward") {
    throw new PersistenceValidationError("page.direction must be forward or backward");
  }
  const through = boundary(pageValue.through, "page.through");
  const journalHead = boundary(pageValue.journalHead, "page.journalHead");
  if (through.sequence > journalHead.sequence) {
    throw new PersistenceValidationError("page through boundary exceeds its journal head");
  }
  const firstSequence =
    pageValue.firstSequence === undefined
      ? undefined
      : safeInteger(pageValue.firstSequence, "page.firstSequence", 1);
  const lastSequence =
    pageValue.lastSequence === undefined
      ? undefined
      : safeInteger(pageValue.lastSequence, "page.lastSequence", 1);
  const firstPrevHash = optionalString(pageValue.firstPrevHash, "page.firstPrevHash");
  const lastEventHash = optionalString(pageValue.lastEventHash, "page.lastEventHash");
  if (events.length === 0) {
    if (firstSequence !== undefined || lastSequence !== undefined) {
      throw new PersistenceValidationError("empty page cannot report first/last sequences");
    }
  } else {
    const first = events[0]!;
    const last = events[events.length - 1]!;
    if (
      firstSequence !== first.sequence ||
      lastSequence !== last.sequence ||
      firstPrevHash !== first.prevHash ||
      lastEventHash !== last.eventHash
    ) {
      throw new PersistenceValidationError("page boundary metadata does not match its events");
    }
    if (last.sequence > through.sequence) {
      throw new PersistenceValidationError("page contains an event beyond throughSequence");
    }
  }

  const encodedBytes = safeInteger(pageValue.encodedBytes, "page.encodedBytes", 2);
  const computedBytes = wireBytes(events);
  if (encodedBytes !== computedBytes) {
    throw new PersistenceValidationError(
      `page encodedBytes ${encodedBytes} does not match ${computedBytes}`,
    );
  }
  const page: JournalPageInfo = {
    direction,
    anchorSequence: safeInteger(pageValue.anchorSequence, "page.anchorSequence"),
    ...(optionalString(pageValue.anchorHash, "page.anchorHash") !== undefined
      ? { anchorHash: optionalString(pageValue.anchorHash, "page.anchorHash")! }
      : {}),
    ...(firstSequence !== undefined ? { firstSequence } : {}),
    ...(firstPrevHash !== undefined ? { firstPrevHash } : {}),
    ...(lastSequence !== undefined ? { lastSequence } : {}),
    ...(lastEventHash !== undefined ? { lastEventHash } : {}),
    through,
    journalHead,
    hasMoreBefore: pageValue.hasMoreBefore === true,
    hasMoreAfter: pageValue.hasMoreAfter === true,
    encodedBytes,
    maxBytes: safeInteger(pageValue.maxBytes, "page.maxBytes", 1),
    itemLimit: safeInteger(pageValue.itemLimit, "page.itemLimit", 1),
    truncatedByBytes: pageValue.truncatedByBytes === true,
    oversizedSingleEvent: pageValue.oversizedSingleEvent === true,
  };
  if (!page.oversizedSingleEvent && page.encodedBytes > page.maxBytes) {
    throw new PersistenceValidationError("journal page exceeds maxBytes without overflow marker");
  }

  const snapshot =
    value.snapshot === undefined || value.snapshot === null
      ? undefined
      : validateSnapshotEnvelope(value.snapshot, {
          ...(options.expectedSessionId !== undefined
            ? { expectedSessionId: options.expectedSessionId }
            : {}),
        });
  return {
    events,
    page,
    ...(cursor(value.earlierPage, "earlier") !== undefined
      ? { earlierPage: cursor(value.earlierPage, "earlier")! }
      : {}),
    ...(cursor(value.laterPage, "later") !== undefined
      ? { laterPage: cursor(value.laterPage, "later")! }
      : {}),
    ...(snapshot !== undefined ? { snapshot } : {}),
    tailOnly: value.tailOnly === true,
    ...(value.manifest !== undefined ? { manifest: value.manifest } : {}),
    ...(value.integrity !== undefined ? { integrity: value.integrity } : {}),
    ...(typeof value.eventCount === "number" ? { eventCount: value.eventCount } : {}),
  };
}

export function parseSessionJournalPage(
  raw: unknown,
  options: { readonly expectedSessionId?: string } = {},
): SessionJournalPage | undefined {
  try {
    return validateSessionJournalPage(raw, options);
  } catch {
    return undefined;
  }
}

export interface SessionLoadTransport {
  load(params: Record<string, unknown>): Promise<unknown>;
}

export interface ReplayTailOptions {
  readonly sessionId: string;
  readonly pageItems?: number;
  readonly pageBytes?: number;
  readonly afterJournalSequence?: number;
  readonly afterStreamSequence?: number;
  readonly afterHash?: string;
  /** Reject incomplete/legacy app payloads and restart from genesis automatically. */
  readonly acceptSnapshot?: (
    snapshot: StoredSnapshotEnvelope,
  ) => boolean | Promise<boolean>;
}

/**
 * Stream only the replay tail after the newest valid snapshot (or an explicit
 * durable boundary). Every subsequent page is frozen to the first response's
 * through hash, so concurrent appends cannot change this replay pass.
 */
export async function* iterateReplayTailPages(
  transport: SessionLoadTransport,
  options: ReplayTailOptions,
): AsyncGenerator<SessionJournalPage, void, undefined> {
  if (
    options.afterJournalSequence !== undefined &&
    (!Number.isSafeInteger(options.afterJournalSequence) || options.afterJournalSequence < 0)
  ) {
    throw new RangeError("afterJournalSequence must be a non-negative safe integer");
  }
  if (
    options.afterStreamSequence !== undefined &&
    (!Number.isSafeInteger(options.afterStreamSequence) ||
      options.afterStreamSequence < (options.afterJournalSequence ?? 0))
  ) {
    throw new RangeError("afterStreamSequence must not precede afterJournalSequence");
  }
  const firstParams: Record<string, unknown> = {
    sessionId: options.sessionId,
    tailOnly: true,
    limit: options.pageItems ?? DEFAULT_SESSION_PAGE_ITEMS,
    maxBytes: options.pageBytes ?? DEFAULT_SESSION_PAGE_BYTES,
    ...(options.afterJournalSequence !== undefined
      ? { afterSequence: options.afterJournalSequence }
      : {}),
    ...(options.afterHash !== undefined ? { afterHash: options.afterHash } : {}),
  };
  let page = validateSessionJournalPage(await transport.load(firstParams), {
    expectedSessionId: options.sessionId,
  });
  if (page.snapshot !== undefined) {
    const checked = await validateStoredSnapshot(page.snapshot, {
      expectedSessionId: options.sessionId,
    });
    const cursorOwnsDifferentSeed =
      options.afterJournalSequence !== undefined &&
      checked.journalSequence !== options.afterJournalSequence;
    const accepted =
      !cursorOwnsDifferentSeed &&
      (options.acceptSnapshot === undefined || await options.acceptSnapshot(checked));
    if (!accepted && options.afterJournalSequence === undefined) {
      // The runtime snapshot may be integrity-valid yet lack app-level prompt
      // history. Freeze to the already observed through boundary, then restart
      // from genesis rather than building on an incomplete provider context.
      const frozen = page.page.through;
      page = validateSessionJournalPage(
        await transport.load({
          sessionId: options.sessionId,
          afterSequence: 0,
          afterHash: JOURNAL_GENESIS_HASH,
          throughSequence: frozen.sequence,
          throughHash: frozen.eventHash,
          limit: options.pageItems ?? DEFAULT_SESSION_PAGE_ITEMS,
          maxBytes: options.pageBytes ?? DEFAULT_SESSION_PAGE_BYTES,
        }),
        { expectedSessionId: options.sessionId },
      );
      if (
        page.page.through.sequence !== frozen.sequence ||
        page.page.through.eventHash !== frozen.eventHash
      ) {
        throw new PersistenceValidationError(
          "full-replay fallback changed the frozen through boundary",
        );
      }
      if (page.snapshot !== undefined) {
        const { snapshot: _ignoredSnapshot, ...withoutSnapshot } = page;
        page = withoutSnapshot;
      }
    } else if (!accepted) {
      // An explicit cursor means the caller owns the seed at that boundary. Do
      // not accidentally apply events on top of a newer unrelated snapshot.
      const { snapshot: _ignoredSnapshot, ...withoutSnapshot } = page;
      page = withoutSnapshot;
    }
  }

  let expectedSequence = page.page.anchorSequence;
  let expectedHash = page.page.anchorHash;
  const through = page.page.through;

  for (;;) {
    if (page.events.length > 0) {
      const first = page.events[0]!;
      if (first.sequence !== expectedSequence + 1) {
        throw new PersistenceValidationError("replay tail does not begin after its cursor");
      }
      if (expectedHash !== undefined && first.prevHash !== expectedHash) {
        throw new PersistenceValidationError("replay tail does not match its cursor hash");
      }
      const last = page.events[page.events.length - 1]!;
      expectedSequence = last.sequence;
      expectedHash = last.eventHash;
    }
    yield page;
    if (!page.page.hasMoreAfter) return;
    if (page.events.length === 0 || expectedHash === undefined) {
      throw new PersistenceValidationError("replay cursor made no progress");
    }
    page = validateSessionJournalPage(
      await transport.load({
        sessionId: options.sessionId,
        afterSequence: expectedSequence,
        afterHash: expectedHash,
        throughSequence: through.sequence,
        throughHash: through.eventHash,
        limit: options.pageItems ?? DEFAULT_SESSION_PAGE_ITEMS,
        maxBytes: options.pageBytes ?? DEFAULT_SESSION_PAGE_BYTES,
      }),
      { expectedSessionId: options.sessionId },
    );
    if (
      page.page.through.sequence !== through.sequence ||
      page.page.through.eventHash !== through.eventHash
    ) {
      throw new PersistenceValidationError("replay through boundary changed between pages");
    }
  }
}

export interface ReplayJournalTailOptions<State, Event = StoredJournalEvent>
  extends ReplayTailOptions {
  readonly seed: (snapshot: StoredSnapshotEnvelope | undefined) => State | Promise<State>;
  readonly decode?: (event: StoredJournalEvent) => Event | undefined;
  readonly apply: (state: State, event: Event) => State;
}

export interface ReplayJournalTailResult<State> {
  readonly state: State;
  readonly snapshot?: StoredSnapshotEnvelope;
  readonly eventsApplied: number;
  readonly pagesLoaded: number;
  readonly journalSequence: number;
  readonly streamSequence: number;
  readonly through: JournalBoundary;
}

/** Apply tail pages incrementally without ever materializing the full journal. */
export async function replayJournalTail<State, Event = StoredJournalEvent>(
  transport: SessionLoadTransport,
  options: ReplayJournalTailOptions<State, Event>,
): Promise<ReplayJournalTailResult<State>> {
  let state: State | undefined;
  let snapshot: StoredSnapshotEnvelope | undefined;
  let eventsApplied = 0;
  let pagesLoaded = 0;
  let journalSequence = options.afterJournalSequence ?? 0;
  let streamSequence = options.afterStreamSequence ?? 0;
  let through: JournalBoundary | undefined;

  for await (const page of iterateReplayTailPages(transport, options)) {
    pagesLoaded += 1;
    through = page.page.through;
    if (state === undefined) {
      snapshot = page.snapshot;
      state = await options.seed(snapshot);
      journalSequence = snapshot?.journalSequence ?? journalSequence;
      streamSequence = snapshot?.streamSequence ?? streamSequence;
    }
    for (const stored of page.events) {
      journalSequence = stored.sequence;
      streamSequence = Math.max(streamSequence, stored.streamSequence ?? stored.sequence);
      const decoded = options.decode === undefined
        ? (stored as unknown as Event)
        : options.decode(stored);
      if (decoded === undefined) continue;
      state = options.apply(state, decoded);
      eventsApplied += 1;
    }
  }
  if (state === undefined || through === undefined) {
    throw new PersistenceValidationError("session.load returned no replay page");
  }
  return {
    state,
    ...(snapshot !== undefined ? { snapshot } : {}),
    eventsApplied,
    pagesLoaded,
    journalSequence,
    streamSequence,
    through,
  };
}

export function earlierPageCursor(page: SessionJournalPage): JournalPageCursor | undefined {
  return page.earlierPage;
}

export async function loadEarlierJournalPage(
  transport: SessionLoadTransport,
  sessionId: string,
  page: SessionJournalPage,
  options: { readonly pageItems?: number; readonly pageBytes?: number } = {},
): Promise<SessionJournalPage | undefined> {
  const earlier = earlierPageCursor(page);
  if (earlier?.beforeSequence === undefined || earlier.beforeHash === undefined) return undefined;
  return validateSessionJournalPage(
    await transport.load({
      sessionId,
      beforeSequence: earlier.beforeSequence,
      beforeHash: earlier.beforeHash,
      throughSequence: earlier.throughSequence,
      throughHash: earlier.throughHash,
      limit: options.pageItems ?? DEFAULT_SESSION_PAGE_ITEMS,
      maxBytes: options.pageBytes ?? DEFAULT_SESSION_PAGE_BYTES,
    }),
    { expectedSessionId: sessionId },
  );
}

export interface ResidentJournalItem {
  readonly sequence: number;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly id?: string;
  readonly eventHash?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly correlationId?: string;
}

export interface ResidentJournalWindowOptions<T extends ResidentJournalItem> {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly sizeOf?: (item: T) => number;
  readonly trackLifecyclePins?: boolean;
}

export interface OmittedSequenceRange {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly count: number;
}

export interface ResidentWindowStats {
  readonly itemCount: number;
  readonly byteLength: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly pinnedItems: number;
  readonly omittedBefore: number;
  readonly omittedAfter: number;
  readonly omittedRanges: readonly OmittedSequenceRange[];
  readonly earliestSequence?: number;
  readonly latestSequence?: number;
  readonly overBudget: boolean;
}

interface ResidentEntry<T> {
  readonly item: T;
  readonly bytes: number;
}

function sequenceRanges(sequences: Iterable<number>): OmittedSequenceRange[] {
  const sorted = [...sequences].sort((left, right) => left - right);
  const ranges: OmittedSequenceRange[] = [];
  for (const sequence of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && sequence === last.lastSequence + 1) {
      ranges[ranges.length - 1] = {
        firstSequence: last.firstSequence,
        lastSequence: sequence,
        count: last.count + 1,
      };
    } else {
      ranges.push({ firstSequence: sequence, lastSequence: sequence, count: 1 });
    }
  }
  return ranges;
}

type RetainSide = "newest" | "oldest";

/**
 * In-memory journal window with boundary-only eviction. Manual and unresolved
 * lifecycle pins are never evicted; if pins exceed a budget, `overBudget` is
 * reported rather than silently discarding active state.
 */
export class ResidentJournalWindow<T extends ResidentJournalItem> {
  readonly #options: ResidentJournalWindowOptions<T>;
  readonly #entries = new Map<number, ResidentEntry<T>>();
  readonly #manualPins = new Map<number, number>();
  readonly #lifecyclePins = new Set<number>();
  readonly #lifecycleStarts = new Map<string, Set<number>>();
  readonly #resolvedLifecycles = new Set<string>();
  #bytes = 0;
  #omittedBefore = 0;
  #omittedAfter = 0;
  readonly #omittedRanges: OmittedSequenceRange[] = [];

  constructor(options: ResidentJournalWindowOptions<T>) {
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
      throw new RangeError("maxItems must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2) {
      throw new RangeError("maxBytes must be a safe integer >= 2");
    }
    this.#options = options;
  }

  get items(): readonly T[] {
    return this.#sequences().map((sequence) => this.#entries.get(sequence)!.item);
  }

  get stats(): ResidentWindowStats {
    const sequences = this.#sequences();
    const base = {
      itemCount: sequences.length,
      byteLength: this.#arrayBytes(),
      maxItems: this.#options.maxItems,
      maxBytes: this.#options.maxBytes,
      pinnedItems: sequences.filter((sequence) => this.isPinned(sequence)).length,
      omittedBefore: this.#omittedBefore,
      omittedAfter: this.#omittedAfter,
      omittedRanges: this.#omittedRanges.map((range) => ({ ...range })),
      overBudget: this.#isOverBudget(),
    };
    return {
      ...base,
      ...(sequences[0] !== undefined ? { earliestSequence: sequences[0] } : {}),
      ...(sequences.at(-1) !== undefined ? { latestSequence: sequences.at(-1)! } : {}),
    };
  }

  merge(
    items: readonly T[],
    options: { readonly retain?: RetainSide } = {},
  ): ResidentWindowStats {
    let previous = 0;
    for (const item of items) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) {
        throw new PersistenceValidationError("resident item sequence must be positive");
      }
      if (item.sequence <= previous) {
        throw new PersistenceValidationError("resident merge input must be strictly chronological");
      }
      previous = item.sequence;
      const bytes = this.#options.sizeOf?.(item) ?? wireBytes(item);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new PersistenceValidationError("resident item byte size is invalid");
      }
      const existing = this.#entries.get(item.sequence);
      if (existing !== undefined) {
        const sameHash =
          existing.item.eventHash !== undefined && item.eventHash !== undefined
            ? existing.item.eventHash === item.eventHash
            : JSON.stringify(existing.item) === JSON.stringify(item);
        if (!sameHash) {
          throw new PersistenceValidationError(
            `conflicting resident journal event at sequence ${item.sequence}`,
          );
        }
        continue;
      }
      this.#entries.set(item.sequence, { item, bytes });
      this.#bytes += bytes;
      if (this.#options.trackLifecyclePins !== false) this.#observeLifecycle(item);
    }
    this.#evict(options.retain ?? "newest");
    return this.stats;
  }

  mergePage(page: SessionJournalPage): ResidentWindowStats {
    return this.merge(page.events as unknown as readonly T[], {
      retain: page.page.direction === "backward" ? "oldest" : "newest",
    });
  }

  pin(sequence: number): () => void {
    if (!this.#entries.has(sequence)) {
      throw new RangeError(`cannot pin non-resident sequence ${sequence}`);
    }
    this.#manualPins.set(sequence, (this.#manualPins.get(sequence) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.#manualPins.get(sequence) ?? 0;
      if (count <= 1) this.#manualPins.delete(sequence);
      else this.#manualPins.set(sequence, count - 1);
    };
  }

  pinRange(firstSequence: number, lastSequence: number): () => void {
    const releases = this.#sequences()
      .filter((sequence) => sequence >= firstSequence && sequence <= lastSequence)
      .map((sequence) => this.pin(sequence));
    return () => {
      for (const release of releases) release();
    };
  }

  isPinned(sequence: number): boolean {
    return (this.#manualPins.get(sequence) ?? 0) > 0 || this.#lifecyclePins.has(sequence);
  }

  clear(): void {
    this.#entries.clear();
    this.#manualPins.clear();
    this.#lifecyclePins.clear();
    this.#lifecycleStarts.clear();
    this.#resolvedLifecycles.clear();
    this.#bytes = 0;
    this.#omittedBefore = 0;
    this.#omittedAfter = 0;
    this.#omittedRanges.splice(0);
  }

  #sequences(): number[] {
    return [...this.#entries.keys()].sort((left, right) => left - right);
  }

  #arrayBytes(): number {
    return 2 + this.#bytes + Math.max(0, this.#entries.size - 1);
  }

  #isOverBudget(): boolean {
    return (
      this.#entries.size > this.#options.maxItems ||
      this.#arrayBytes() > this.#options.maxBytes
    );
  }

  #evict(retain: RetainSide): void {
    while (this.#isOverBudget()) {
      const sequences = this.#sequences();
      // Keep one oversize event so a tiny caller budget cannot deadlock paging.
      if (sequences.length <= 1) return;
      const scan = retain === "newest" ? sequences : [...sequences].reverse();
      // Scan inward rather than considering only boundaries: an old unresolved
      // card may be pinned while large volumes of terminal detail remain safely
      // evictable around it.
      const candidate = scan.find((sequence) => !this.isPinned(sequence));
      if (candidate === undefined) return;
      const entry = this.#entries.get(candidate)!;
      this.#entries.delete(candidate);
      this.#bytes -= entry.bytes;
      this.#manualPins.delete(candidate);
      this.#recordOmitted(candidate);
      if (retain === "newest") this.#omittedBefore += 1;
      else this.#omittedAfter += 1;
    }
  }

  #recordOmitted(sequence: number): void {
    let index = 0;
    while (
      index < this.#omittedRanges.length &&
      this.#omittedRanges[index]!.firstSequence <= sequence
    ) index += 1;
    const previous = this.#omittedRanges[index - 1];
    const next = this.#omittedRanges[index];
    if (
      previous !== undefined &&
      sequence >= previous.firstSequence &&
      sequence <= previous.lastSequence
    ) return;
    const joinsPrevious = previous !== undefined && previous.lastSequence + 1 === sequence;
    const joinsNext = next !== undefined && sequence + 1 === next.firstSequence;
    if (joinsPrevious && joinsNext) {
      this.#omittedRanges[index - 1] = {
        firstSequence: previous.firstSequence,
        lastSequence: next.lastSequence,
        count: previous.count + next.count + 1,
      };
      this.#omittedRanges.splice(index, 1);
    } else if (joinsPrevious) {
      this.#omittedRanges[index - 1] = {
        ...previous,
        lastSequence: sequence,
        count: previous.count + 1,
      };
    } else if (joinsNext) {
      this.#omittedRanges[index] = {
        ...next,
        firstSequence: sequence,
        count: next.count + 1,
      };
    } else {
      this.#omittedRanges.splice(index, 0, {
        firstSequence: sequence,
        lastSequence: sequence,
        count: 1,
      });
    }
  }

  #observeLifecycle(item: T): void {
    const transition = lifecycleTransition(item);
    if (transition === undefined) return;
    if (transition.state === "closed") {
      const starts = this.#lifecycleStarts.get(transition.key);
      if (starts === undefined) {
        // Backward paging can observe a terminal record before its start. Keep
        // only that unmatched key; the older start consumes it below.
        this.#resolvedLifecycles.add(transition.key);
      } else {
        for (const sequence of starts) this.#lifecyclePins.delete(sequence);
        this.#lifecycleStarts.delete(transition.key);
      }
      return;
    }
    if (this.#resolvedLifecycles.delete(transition.key)) return;
    let starts = this.#lifecycleStarts.get(transition.key);
    if (starts === undefined) {
      starts = new Set();
      this.#lifecycleStarts.set(transition.key, starts);
    }
    starts.add(item.sequence);
    this.#lifecyclePins.add(item.sequence);
  }
}

interface LifecycleTransition {
  readonly key: string;
  readonly state: "open" | "closed";
}

function lifecycleTransition(item: ResidentJournalItem): LifecycleTransition | undefined {
  const kind = item.kind;
  if (kind === undefined) return undefined;
  const specs: ReadonlyArray<{
    readonly prefix: string;
    readonly opens: readonly string[];
    readonly closes: readonly string[];
    readonly ids: readonly string[];
  }> = [
    { prefix: "turn", opens: ["turn.started"], closes: ["turn.completed", "turn.cancelled", "turn.interrupted"], ids: ["turnId", "id"] },
    { prefix: "tool", opens: ["tool.started"], closes: ["tool.completed", "tool.failed"], ids: ["callId", "toolCallId", "id"] },
    { prefix: "approval", opens: ["approval.requested"], closes: ["approval.resolved"], ids: ["approvalId", "id"] },
    { prefix: "transaction", opens: ["transaction.started"], closes: ["transaction.committed", "transaction.rolled_back", "transaction.conflicted"], ids: ["transactionId", "id"] },
    { prefix: "task", opens: ["task.created", "task.started"], closes: ["task.completed", "task.failed", "task.cancelled"], ids: ["taskId", "id"] },
    { prefix: "job", opens: ["job.started"], closes: ["job.completed", "job.failed"], ids: ["jobId", "id"] },
    { prefix: "program", opens: ["program.started"], closes: ["program.completed", "program.failed"], ids: ["programId", "runId", "id"] },
    { prefix: "hosted-agent", opens: ["hosted_agent.spawned"], closes: ["hosted_agent.completed", "hosted_agent.cancelled"], ids: ["hostedAgentId", "agentId", "taskId", "id"] },
    { prefix: "tool-batch", opens: ["tool.batch_started"], closes: ["tool.batch_completed"], ids: ["batchId", "id"] },
  ];
  const spec = specs.find((candidate) => candidate.opens.includes(kind) || candidate.closes.includes(kind));
  if (spec === undefined) return undefined;
  const payload =
    typeof item.payload === "object" && item.payload !== null && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  let id: string | undefined;
  for (const field of spec.ids) {
    const candidate = payload[field];
    if (typeof candidate === "string" && candidate.length > 0) {
      id = candidate;
      break;
    }
    const topLevel = (item as unknown as Record<string, unknown>)[field];
    if (typeof topLevel === "string" && topLevel.length > 0) {
      id = topLevel;
      break;
    }
  }
  id ??= item.correlationId ?? item.turnId ?? item.agentId;
  if (id === undefined) return undefined;
  return {
    key: `${spec.prefix}:${id}`,
    state: spec.opens.includes(kind) ? "open" : "closed",
  };
}

export interface ResidentTimelineItem {
  readonly sequence: number;
  readonly type?: string;
  readonly status?: unknown;
  readonly state?: unknown;
  readonly decision?: unknown;
  readonly subagentEvents?: readonly unknown[];
}

export interface BoundResidentViewModelOptions<
  Model,
  Item extends ResidentTimelineItem,
> {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly priorOmittedCount?: number;
  readonly sizeOf?: (item: Item) => number;
  readonly isPinned?: (item: Item, model: Model) => boolean;
}

export interface BoundResidentViewModelResult<Model> {
  readonly model: Model;
  readonly omittedCount: number;
  readonly omittedNow: number;
  readonly residentBytes: number;
  readonly overBudget: boolean;
  readonly earliestSequence?: number;
  readonly omittedRanges: readonly OmittedSequenceRange[];
  readonly omittedPageAnchors: readonly { readonly beforeSequence: number }[];
  readonly earlierPageAnchor?: { readonly beforeSequence: number };
}

/** Default safety pin for active timeline lifecycle cards. */
export function isUnresolvedTimelineItem(item: ResidentTimelineItem): boolean {
  if (item.type === "tool") return item.status === "running";
  if (item.type === "task") {
    if (["queued", "running", "waiting", "blocked"].includes(String(item.state))) return true;
    if (Array.isArray(item.subagentEvents)) {
      return item.subagentEvents.some((child) => {
        if (typeof child !== "object" || child === null) return false;
        return (child as { status?: unknown }).status === "running";
      });
    }
    return false;
  }
  if (item.type === "job") return item.state === "running";
  if (item.type === "approval") {
    return (
      item.decision === undefined ||
      item.decision === null ||
      item.decision === "" ||
      item.decision === "pending"
    );
  }
  return false;
}

/**
 * Shallow-copy a view model with a bounded timeline. Aggregate state and active
 * tool/task/job arrays are preserved untouched. Oldest terminal items are
 * evicted even when an earlier unresolved card is pinned; omission ranges make
 * those in-memory gaps explicit and independently pageable.
 */
export function boundResidentViewModel<
  Item extends ResidentTimelineItem,
  Model extends { readonly timeline: readonly Item[] },
>(
  model: Model,
  options: BoundResidentViewModelOptions<Model, Item>,
): BoundResidentViewModelResult<Model> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 0) {
    throw new RangeError("maxItems must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2) {
    throw new RangeError("maxBytes must be a safe integer >= 2");
  }
  const timeline = [...model.timeline];
  const sizes = timeline.map((item) => options.sizeOf?.(item) ?? wireBytes(item));
  if (sizes.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new RangeError("timeline item byte sizes must be non-negative safe integers");
  }
  let residentBytes = 2 + sizes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, timeline.length - 1);
  const omittedSequences = new Set<number>();
  const pinned = options.isPinned ?? ((item: Item) => isUnresolvedTimelineItem(item));

  while (timeline.length > options.maxItems || residentBytes > options.maxBytes) {
    // Keep one newest oversize item so a giant final/Markdown block is still
    // rendered exactly; the next item can displace it without unbounded growth.
    if (timeline.length <= 1 && options.maxItems > 0) break;
    const index = timeline.findIndex((item) => !pinned(item, model));
    // Only unresolved/pinned cards remain. Exceeding the configured budget is
    // safer than making an active operation disappear from the UI.
    if (index < 0) break;
    const [removed] = timeline.splice(index, 1);
    const [removedBytes] = sizes.splice(index, 1);
    if (removed === undefined || removedBytes === undefined) break;
    residentBytes -= removedBytes + (timeline.length > 0 ? 1 : 0);
    omittedSequences.add(removed.sequence);
  }

  const omittedRanges = sequenceRanges(omittedSequences);
  const omittedPageAnchors = omittedRanges.map((range) => ({
    beforeSequence: range.lastSequence + 1,
  }));
  const omittedNow = omittedSequences.size;
  const earliestSequence = timeline[0]?.sequence;
  const bounded = { ...model, timeline } as Model;
  return {
    model: bounded,
    omittedCount: (options.priorOmittedCount ?? 0) + omittedNow,
    omittedNow,
    residentBytes,
    overBudget: timeline.length > options.maxItems || residentBytes > options.maxBytes,
    omittedRanges,
    omittedPageAnchors,
    ...(earliestSequence !== undefined ? { earliestSequence } : {}),
    ...(omittedPageAnchors[0] !== undefined
      ? { earlierPageAnchor: omittedPageAnchors[0] }
      : {}),
  };
}
