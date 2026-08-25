/**
 * Session event fan-out with bounded per-subscriber queues.
 *
 * Journaled events are never dropped. A slow client is switched to replay mode
 * (cursor retained, live queue cleared) instead of growing unbounded memory.
 */

export interface HubEvent {
  readonly schemaVersion: string;
  readonly sequence: number;
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly visibility?: string;
  readonly ephemeral?: boolean;
  readonly payload?: unknown;
}

export interface EventHubOptions {
  readonly maxQueueItems?: number;
  readonly maxQueueBytes?: number;
  readonly now?: () => string;
}

export type SubscriberMode = "live" | "replay";

export interface EventSubscriptionState {
  readonly id: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly mode: SubscriberMode;
  readonly lastAckedSequence: number;
  readonly queuedItems: number;
  readonly queuedBytes: number;
  readonly filter: {
    readonly kinds: readonly string[];
    readonly visibility: readonly string[];
    readonly includeEphemeral: boolean;
  };
}

export interface PublishResult {
  readonly sequence: number;
  readonly liveDeliveries: number;
  readonly replayForced: number;
}

export class EventHubError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EventHubError";
    this.code = code;
  }
}

interface Subscriber {
  readonly id: string;
  readonly sessionId: string;
  readonly clientId: string;
  filter: {
    kinds: readonly string[];
    visibility: readonly string[];
    includeEphemeral: boolean;
  };
  mode: SubscriberMode;
  lastAckedSequence: number;
  queue: HubEvent[];
  queuedBytes: number;
  readonly onEvent?: (event: HubEvent) => void;
  readonly onReplayMode?: (cursorSequence: number) => void;
}

export class EventHub {
  readonly #maxQueueItems: number;
  readonly #maxQueueBytes: number;
  readonly #now: () => string;
  readonly #journals = new Map<string, HubEvent[]>();
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #sequences = new Map<string, number>();

  constructor(options: EventHubOptions = {}) {
    this.#maxQueueItems = options.maxQueueItems ?? 1_000;
    this.#maxQueueBytes = options.maxQueueBytes ?? 8 * 1024 * 1024;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly clientId: string;
    readonly initialAckedSequence?: number;
    readonly filter?: {
      readonly kinds?: readonly string[];
      readonly visibility?: readonly string[];
      readonly includeEphemeral?: boolean;
    };
    readonly onEvent?: (event: HubEvent) => void;
    readonly onReplayMode?: (cursorSequence: number) => void;
  }): EventSubscriptionState {
    if (this.#subscribers.has(input.id)) {
      throw new EventHubError("EVENT_SUBSCRIPTION_EXISTS", "subscription id already exists");
    }
    const subscriber: Subscriber = {
      id: input.id,
      sessionId: input.sessionId,
      clientId: input.clientId,
      filter: {
        kinds: input.filter?.kinds ?? [],
        visibility: input.filter?.visibility ?? [],
        includeEphemeral: input.filter?.includeEphemeral ?? false,
      },
      mode: "live",
      lastAckedSequence: Math.max(0, input.initialAckedSequence ?? 0),
      queue: [],
      queuedBytes: 0,
      ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}),
      ...(input.onReplayMode !== undefined ? { onReplayMode: input.onReplayMode } : {}),
    };
    this.#subscribers.set(subscriber.id, subscriber);
    return snapshot(subscriber);
  }

  unsubscribe(subscriptionId: string): void {
    this.#subscribers.delete(subscriptionId);
  }

  acknowledge(subscriptionId: string, sequence: number): EventSubscriptionState {
    const subscriber = this.#require(subscriptionId);
    if (!Number.isSafeInteger(sequence) || sequence < subscriber.lastAckedSequence) {
      throw new EventHubError("EVENT_CURSOR_INVALID", "ack sequence must be monotonic");
    }
    subscriber.lastAckedSequence = sequence;
    while (subscriber.queue.length > 0 && subscriber.queue[0]!.sequence <= sequence) {
      const removed = subscriber.queue.shift()!;
      subscriber.queuedBytes -= estimateBytes(removed);
    }
    if (subscriber.mode === "replay" && subscriber.queue.length === 0) {
      subscriber.mode = "live";
    }
    return snapshot(subscriber);
  }

  publish(sessionId: string, event: Omit<HubEvent, "sequence" | "sessionId" | "timestamp"> & {
    readonly timestamp?: string;
    readonly sequence?: number;
  }): PublishResult {
    const sequence = event.sequence ?? ((this.#sequences.get(sessionId) ?? 0) + 1);
    if (sequence <= (this.#sequences.get(sessionId) ?? 0)) {
      throw new EventHubError("EVENT_SEQUENCE_INVALID", "event sequence must increase");
    }
    this.#sequences.set(sessionId, sequence);
    const full: HubEvent = {
      ...event,
      sessionId,
      sequence,
      timestamp: event.timestamp ?? this.#now(),
    };
    if (full.ephemeral !== true) {
      const journal = this.#journals.get(sessionId) ?? [];
      journal.push(full);
      this.#journals.set(sessionId, journal);
    }

    let liveDeliveries = 0;
    let replayForced = 0;
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.sessionId !== sessionId) continue;
      if (!matchesFilter(subscriber, full)) continue;
      if (subscriber.mode === "replay") continue;
      if (full.ephemeral === true) {
        // Ephemeral events may be dropped under pressure; never journal them.
        if (subscriber.queue.length >= this.#maxQueueItems) continue;
      }
      const bytes = estimateBytes(full);
      if (
        subscriber.queue.length + 1 > this.#maxQueueItems
        || subscriber.queuedBytes + bytes > this.#maxQueueBytes
      ) {
        if (full.ephemeral === true) continue;
        subscriber.queue.length = 0;
        subscriber.queuedBytes = 0;
        subscriber.mode = "replay";
        subscriber.onReplayMode?.(subscriber.lastAckedSequence);
        replayForced += 1;
        continue;
      }
      subscriber.queue.push(full);
      subscriber.queuedBytes += bytes;
      subscriber.onEvent?.(full);
      liveDeliveries += 1;
    }
    return { sequence, liveDeliveries, replayForced };
  }

  replay(input: {
    readonly subscriptionId: string;
    readonly afterSequence?: number;
    readonly maxEvents: number;
    readonly maxBytes: number;
  }): {
    readonly events: readonly HubEvent[];
    readonly cursorSequence: number;
    readonly hasMore: boolean;
    readonly subscription: EventSubscriptionState;
  } {
    const subscriber = this.#require(input.subscriptionId);
    const after = input.afterSequence ?? subscriber.lastAckedSequence;
    const journal = this.#journals.get(subscriber.sessionId) ?? [];
    const events: HubEvent[] = [];
    let bytes = 0;
    let cursor = after;
    let hasMore = false;
    for (const event of journal) {
      if (event.sequence <= after) continue;
      if (!matchesFilter(subscriber, event)) continue;
      const size = estimateBytes(event);
      if (events.length >= input.maxEvents || bytes + size > input.maxBytes) {
        hasMore = true;
        break;
      }
      events.push(event);
      bytes += size;
      cursor = event.sequence;
    }
    if (!hasMore && subscriber.mode === "replay") {
      subscriber.mode = "live";
    }
    return {
      events,
      cursorSequence: cursor,
      hasMore,
      subscription: snapshot(subscriber),
    };
  }

  cursor(sessionId: string): number {
    return this.#sequences.get(sessionId) ?? 0;
  }

  subscription(subscriptionId: string): EventSubscriptionState {
    return snapshot(this.#require(subscriptionId));
  }

  #require(subscriptionId: string): Subscriber {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber === undefined) {
      throw new EventHubError("EVENT_SUBSCRIPTION_NOT_FOUND", "unknown subscription");
    }
    return subscriber;
  }
}

function matchesFilter(subscriber: Subscriber, event: HubEvent): boolean {
  if (event.ephemeral === true && !subscriber.filter.includeEphemeral) return false;
  if (subscriber.filter.kinds.length > 0 && !subscriber.filter.kinds.includes(event.kind)) {
    return false;
  }
  if (
    subscriber.filter.visibility.length > 0
    && event.visibility !== undefined
    && !subscriber.filter.visibility.includes(event.visibility)
  ) {
    return false;
  }
  return true;
}

function estimateBytes(event: HubEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return 1_024;
  }
}

function snapshot(subscriber: Subscriber): EventSubscriptionState {
  return {
    id: subscriber.id,
    sessionId: subscriber.sessionId,
    clientId: subscriber.clientId,
    mode: subscriber.mode,
    lastAckedSequence: subscriber.lastAckedSequence,
    queuedItems: subscriber.queue.length,
    queuedBytes: subscriber.queuedBytes,
    filter: { ...subscriber.filter },
  };
}
