/**
 * Async iterable App Protocol event stream with cursor resume.
 */

import type { EventCursor } from "@cbc/app-protocol";

export interface StreamEvent {
  readonly kind: string;
  readonly payload: unknown;
  readonly sequence?: number;
  readonly id?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
}

export interface EventStreamOptions {
  readonly from?: EventCursor;
  readonly signal?: AbortSignal;
}

/**
 * Push-based async iterable. Producers call push/end; consumers for-await.
 * Resuming from a cursor is the caller's responsibility (pass `from` when
 * creating the subscription); this buffer only retains the live tail.
 */
export class EventStream implements AsyncIterable<StreamEvent> {
  readonly #queue: StreamEvent[] = [];
  readonly #waiters: Array<{
    resolve: (value: IteratorResult<StreamEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;
  #cursor: EventCursor | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: (() => void) | undefined;

  constructor(options: EventStreamOptions = {}) {
    this.#cursor = options.from;
    this.#signal = options.signal;
    if (this.#signal !== undefined) {
      this.#onAbort = () => this.fail(this.#signal!.reason ?? new Error("aborted"));
      if (this.#signal.aborted) this.#onAbort();
      else this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  get cursor(): EventCursor | undefined {
    return this.#cursor;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(event: StreamEvent, cursor?: EventCursor): void {
    if (this.#closed) return;
    if (cursor !== undefined) this.#cursor = cursor;
    else if (
      event.sessionId !== undefined &&
      typeof event.sequence === "number"
    ) {
      this.#cursor = {
        sessionId: event.sessionId,
        journalSequence: event.sequence,
        ...(event.id !== undefined ? { eventId: event.id } : {}),
      };
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAbort();
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#detachAbort();
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!.reject(error);
    }
  }

  /** Resume helper: clone options with the latest cursor. */
  resumeOptions(): EventStreamOptions {
    return this.#cursor === undefined ? {} : { from: this.#cursor };
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: (): Promise<IteratorResult<StreamEvent>> => {
        if (this.#queue.length > 0) {
          return Promise.resolve({ value: this.#queue.shift()!, done: false });
        }
        if (this.#error !== undefined) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<StreamEvent>> => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }

  #detachAbort(): void {
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener("abort", this.#onAbort);
    }
  }
}
