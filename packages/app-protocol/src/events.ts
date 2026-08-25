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

/**
 * Durable subscription identity exposed by App Protocol replay operations.
 * A subscription is scoped to exactly one client and one session.
 */
export interface EventSubscription {
  readonly id: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly state: "active" | "paused" | "closed";
  readonly lastAckedSequence: number;
}

/**
 * A replayed journal row. Its kind stays open so a newer daemon can replay an
 * event that an older App Protocol client chooses to ignore safely.
 */
export interface EventReplayEvent {
  readonly schemaVersion: string;
  readonly sequence: number;
  readonly id: string;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly parentEventId?: string;
  readonly correlationId?: string;
  readonly callerId?: string;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly kind: string;
  readonly level: string;
  readonly visibility: string;
  readonly durability: "journaled";
  readonly payload: unknown;
}

export interface EventReplayRequest {
  readonly subscriptionId: string;
  /** Continue after this raw journal cursor; omit to use the durable ACK. */
  readonly after?: EventCursor;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

export interface EventReplayResult {
  readonly subscription: EventSubscription;
  /** The raw scan position, including rows excluded by the subscription filter. */
  readonly cursor: EventCursor;
  readonly events: readonly EventReplayEvent[];
  readonly hasMore: boolean;
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

/** Transport-level App Server notifications. Separate from the session journal catalog. */
export const APP_NOTIFICATION_KINDS = [
  "server.notice",
  "server.restarting",
  "server.capability_changed",
  "events.push",
  "events.gap",
  "subscription.slow",
  "command.progress",
  "approval.pending",
  "artifact.chunk",
] as const;

export type AppNotificationKind = (typeof APP_NOTIFICATION_KINDS)[number];
