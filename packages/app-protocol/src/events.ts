import type { CbcEvent } from "@cbc/protocol";

export interface EventCursor {
  readonly sessionId: string;
  readonly journalSequence: number;
  readonly eventId?: string;
  readonly snapshotSequence?: number;
}

export interface EventSubscriptionRequest {
  readonly sessionIds: readonly string[];
  readonly from?: Readonly<Record<string, EventCursor>>;
  readonly kinds?: readonly string[];
  readonly visibility?: readonly string[];
  readonly includeEphemeral?: boolean;
  readonly maxBatchEvents?: number;
  readonly maxBatchBytes?: number;
}

export interface EventPush {
  readonly subscriptionId: string;
  readonly cursor: EventCursor;
  readonly events: readonly CbcEvent[];
}

export interface EventGap {
  readonly sessionId: string;
  readonly requested: EventCursor;
  readonly earliestAvailable: EventCursor;
  readonly snapshotRequired: true;
}
