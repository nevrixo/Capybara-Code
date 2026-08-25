/**
 * Snapshot port for the live AgentGraph authority.
 *
 * The reducer stays pure. Persistence is a host-injected sidecar so tests can
 * round-trip through memory while production writes a JSON snapshot the
 * daemon can restore after crash.
 *
 * Durable mailbox, checkpoints, and budget reservations live in
 * `cbc-session-store` (`agent_messages`, `agent_checkpoints`,
 * `agent_budget_reservations`). This package must not talk to SQLite.
 */

import type { GraphState, NodeId } from "@cbc/agent-graph-domain";

export const GRAPH_SNAPSHOT_SCHEMA_VERSION = "1.0" as const;
export const MAX_GRAPH_MAILBOX = 10_000;

export interface GraphMailboxMessage {
  readonly id: string;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly kind: string;
  readonly body: unknown;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly acknowledgedAt?: string;
}

export interface GraphPersistSnapshot {
  readonly schemaVersion: typeof GRAPH_SNAPSHOT_SCHEMA_VERSION;
  readonly state: GraphState | null;
  readonly mailbox: readonly GraphMailboxMessage[];
}

export interface GraphSnapshotStore {
  load(): GraphPersistSnapshot | undefined;
  save(snapshot: GraphPersistSnapshot): void;
  /**
   * Optional durable sidecar. Hosts wrapping SessionStore can persist JSON
   * onto the graph root checkpoint without this package opening SQLite.
   */
  persistDurable?(graphId: string, snapshotJson: string, at: string): void;
  loadDurable?(graphId: string): string | undefined;
}

/**
 * In-memory store used by tests and as a write-through cache.
 * Durable mailbox/checkpoint/budget rows are owned by cbc-session-store.
 */
export class MemoryGraphStore implements GraphSnapshotStore {
  #snapshot: GraphPersistSnapshot | undefined;

  constructor(initial?: GraphPersistSnapshot) {
    this.#snapshot = initial;
  }

  load(): GraphPersistSnapshot | undefined {
    return this.#snapshot;
  }

  save(snapshot: GraphPersistSnapshot): void {
    this.#snapshot = {
      schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
      state: snapshot.state,
      mailbox: [...snapshot.mailbox],
    };
  }
}

export function emptyGraphSnapshot(): GraphPersistSnapshot {
  return {
    schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
    state: null,
    mailbox: [],
  };
}
