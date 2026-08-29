import type { EventCursor, EventReplayEvent, EventReplayResult } from "@cbc/app-protocol";

import { IntegrationContractError } from "./errors.ts";
import type { ReplayCompleteness } from "./reconnect.ts";

export interface ReplayProjection {
  readonly events: readonly EventReplayEvent[];
  readonly cursor: EventCursor;
  readonly completeness: ReplayCompleteness;
  readonly duplicateCount: number;
}

export interface ReplayProjectionCheckpoint {
  readonly sessionId: string;
  readonly lastScannedSequence: number;
  readonly lastAckedSequence: number;
  readonly projectedEventCount: number;
}

/**
 * Applies replay pages exactly once. Filtered journals may have sequence gaps,
 * so order is monotonic rather than artificially contiguous.
 */
export class EventReplayProjector {
  readonly #sessionId: string;
  readonly #eventSequences = new Map<string, number>();
  readonly #sequenceEvents = new Map<number, string>();
  #lastScannedSequence: number;
  #lastAckedSequence: number;
  #projectedEventCount = 0;

  constructor(sessionId: string, initialSequence = 0) {
    if (sessionId.trim().length === 0 || sessionId.trim() !== sessionId) {
      throw new IntegrationContractError("INTEGRATION_CURSOR_INVALID", "sessionId must be non-empty");
    }
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new IntegrationContractError(
        "INTEGRATION_CURSOR_INVALID",
        "initial replay sequence must be a non-negative integer",
      );
    }
    this.#sessionId = sessionId;
    this.#lastScannedSequence = initialSequence;
    this.#lastAckedSequence = initialSequence;
  }

  get checkpoint(): ReplayProjectionCheckpoint {
    return Object.freeze({
      sessionId: this.#sessionId,
      lastScannedSequence: this.#lastScannedSequence,
      lastAckedSequence: this.#lastAckedSequence,
      projectedEventCount: this.#projectedEventCount,
    });
  }

  apply(result: EventReplayResult): ReplayProjection {
    if (
      result.subscription.sessionId !== this.#sessionId
      || result.cursor.sessionId !== this.#sessionId
    ) {
      throw new IntegrationContractError(
        "INTEGRATION_CURSOR_INVALID",
        "replay page belongs to a different session",
      );
    }
    if (
      !Number.isSafeInteger(result.cursor.journalSequence)
      || result.cursor.journalSequence < this.#lastAckedSequence
    ) {
      throw new IntegrationContractError(
        "INTEGRATION_CURSOR_INVALID",
        "replay cursor predates the durable ACK",
      );
    }

    const added: EventReplayEvent[] = [];
    let duplicateCount = 0;
    let pageSequence = this.#lastAckedSequence;
    for (const event of result.events) {
      if (
        event.sessionId !== this.#sessionId
        || !Number.isSafeInteger(event.sequence)
        || event.sequence <= pageSequence
        || event.sequence > result.cursor.journalSequence
      ) {
        throw new IntegrationContractError(
          "INTEGRATION_REPLAY_CONFLICT",
          "replay events must be strictly ordered within the page and bounded by its cursor",
        );
      }
      pageSequence = event.sequence;
      const knownSequence = this.#eventSequences.get(event.id);
      const knownEvent = this.#sequenceEvents.get(event.sequence);
      if (knownSequence !== undefined || knownEvent !== undefined) {
        if (knownSequence !== event.sequence || knownEvent !== event.id) {
          throw new IntegrationContractError(
            "INTEGRATION_REPLAY_CONFLICT",
            "an event id or journal sequence was replayed with different content identity",
          );
        }
        duplicateCount += 1;
        continue;
      }
      if (event.sequence <= this.#lastScannedSequence) {
        throw new IntegrationContractError(
          "INTEGRATION_REPLAY_CONFLICT",
          "an unseen event appeared behind the projected replay cursor",
        );
      }
      this.#eventSequences.set(event.id, event.sequence);
      this.#sequenceEvents.set(event.sequence, event.id);
      added.push(event);
    }

    this.#projectedEventCount += added.length;
    this.#lastScannedSequence = Math.max(this.#lastScannedSequence, result.cursor.journalSequence);
    return Object.freeze({
      events: Object.freeze(added),
      cursor: Object.freeze({ ...result.cursor }),
      completeness: result.hasMore ? "partial" : "complete",
      duplicateCount,
    });
  }

  acknowledge(cursor: EventCursor): void {
    if (
      cursor.sessionId !== this.#sessionId
      || !Number.isSafeInteger(cursor.journalSequence)
      || cursor.journalSequence < this.#lastAckedSequence
      || cursor.journalSequence > this.#lastScannedSequence
    ) {
      throw new IntegrationContractError(
        "INTEGRATION_CURSOR_INVALID",
        "ACK must advance within the range already scanned by replay",
      );
    }
    this.#lastAckedSequence = cursor.journalSequence;
  }

  resetFromSnapshot(cursor: EventCursor): void {
    if (
      cursor.sessionId !== this.#sessionId
      || !Number.isSafeInteger(cursor.journalSequence)
      || cursor.journalSequence < 0
    ) {
      throw new IntegrationContractError(
        "INTEGRATION_CURSOR_INVALID",
        "snapshot cursor must belong to this session",
      );
    }
    this.#eventSequences.clear();
    this.#sequenceEvents.clear();
    this.#lastScannedSequence = cursor.journalSequence;
    this.#lastAckedSequence = cursor.journalSequence;
    this.#projectedEventCount = 0;
  }
}
