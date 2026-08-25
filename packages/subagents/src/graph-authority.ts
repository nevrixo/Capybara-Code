/**
 * Durable AgentGraph authority over the in-process scheduler.
 *
 * The reducer is the source of truth for node identity, depth, and terminal
 * state. The scheduler still runs children; it may not invent a node the graph
 * has not admitted. Snapshots and the mailbox are restored from the injected
 * store so a crash does not lose admitted work.
 */

import {
  applyGraphCommand,
  type GraphId,
  type GraphState,
  type NodeId,
} from "@cbc/agent-graph-domain";

import {
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
  MAX_GRAPH_MAILBOX,
  type GraphMailboxMessage,
  type GraphPersistSnapshot,
  type GraphSnapshotStore,
} from "./graph-store.ts";

export interface GraphSpawnRecord {
  readonly id: string;
  readonly parentId?: string;
  readonly title: string;
  readonly role: string;
  readonly dependencies: readonly string[];
  readonly canWrite: boolean;
}

function nodeId(id: string): NodeId {
  return (id.startsWith("agt_") ? id : `agt_${id}`) as NodeId;
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

export class GraphAuthority {
  #state: GraphState | null = null;
  #mailbox: GraphMailboxMessage[] = [];
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #workspaceIdentityDigest: string;
  readonly #graphId: GraphId;
  readonly #rootNodeId: NodeId;
  readonly #store: GraphSnapshotStore | undefined;

  constructor(options: {
    readonly sessionId: string;
    readonly workspaceIdentityDigest: string;
    readonly now?: () => number;
    readonly store?: GraphSnapshotStore;
    readonly snapshot?: GraphPersistSnapshot;
  }) {
    this.#sessionId = options.sessionId;
    this.#workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#now = options.now ?? (() => Date.now());
    this.#graphId = `grf_${options.sessionId}` as GraphId;
    this.#rootNodeId = "agt_root";
    this.#store = options.store;
    const loaded = options.snapshot ?? options.store?.load();
    if (loaded?.state !== undefined && loaded.state !== null) {
      if (loaded.state.workspaceIdentityDigest !== options.workspaceIdentityDigest) {
        throw new Error("graph snapshot workspace identity does not match this session");
      }
      this.#state = loaded.state;
    }
    if (loaded?.mailbox !== undefined) {
      this.#mailbox = [...loaded.mailbox];
    }
  }

  snapshot(): GraphState | null {
    return this.#state;
  }

  persistSnapshot(): GraphPersistSnapshot {
    const snapshot: GraphPersistSnapshot = {
      schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
      state: this.#state,
      mailbox: [...this.#mailbox],
    };
    this.#store?.save(snapshot);
    this.#store?.persistDurable?.(
      this.#graphId,
      JSON.stringify(snapshot),
      snapshot.state?.updatedAt ?? iso(this.#now),
    );
    return snapshot;
  }

  mailbox(): readonly GraphMailboxMessage[] {
    return this.#mailbox;
  }

  postMessage(input: {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
    readonly body?: unknown;
  }): GraphMailboxMessage {
    if (this.#mailbox.length >= MAX_GRAPH_MAILBOX) {
      throw new Error(`graph mailbox is capped at ${MAX_GRAPH_MAILBOX} messages`);
    }
    const message: GraphMailboxMessage = {
      id: `msg_${this.#mailbox.length + 1}`,
      from: nodeId(input.from),
      to: nodeId(input.to),
      kind: input.kind,
      body: input.body ?? {},
      createdAt: iso(this.#now),
    };
    this.#mailbox = [...this.#mailbox, message];
    this.persistSnapshot();
    return message;
  }

  takeUndelivered(to: string): GraphMailboxMessage[] {
    const target = nodeId(to);
    const pending: GraphMailboxMessage[] = [];
    const next: GraphMailboxMessage[] = [];
    const at = iso(this.#now);
    for (const message of this.#mailbox) {
      if (message.to === target && message.deliveredAt === undefined) {
        const delivered: GraphMailboxMessage = { ...message, deliveredAt: at };
        pending.push(delivered);
        next.push(delivered);
      } else {
        next.push(message);
      }
    }
    this.#mailbox = next;
    if (pending.length > 0) this.persistSnapshot();
    return pending;
  }

  recordSpawn(input: GraphSpawnRecord): void {
    this.#ensureGraph();
    const at = iso(this.#now);
    const parent = nodeId(input.parentId ?? "root");
    const child = nodeId(input.id);
    this.#apply({
      type: "add_node",
      expectedRevision: this.#revision(),
      at,
      nodeId: child,
      parentId: parent,
      title: input.title,
      role: input.role,
    });
    for (const dependency of input.dependencies) {
      this.#apply({
        type: "add_edge",
        expectedRevision: this.#revision(),
        at,
        edgeId: `edg_${dependency}_${input.id}` as `edg_${string}`,
        from: nodeId(dependency),
        to: child,
        kind: "depends_on",
        required: true,
      });
    }
    this.#apply({
      type: "mark_ready",
      expectedRevision: this.#revision(),
      at,
      nodeId: child,
    });
  }

  recordStart(id: string): void {
    if (this.#state === null) return;
    const node = this.#state.nodes[nodeId(id)];
    const attemptId = `att_${id}_${String((node?.attemptCount ?? 0) + 1)}` as `att_${string}`;
    this.#apply({
      type: "dispatch_node",
      expectedRevision: this.#revision(),
      at: iso(this.#now),
      nodeId: nodeId(id),
      attemptId,
    });
  }

  recordComplete(
    id: string,
    outcome: "completed" | "partial" | "failed" | "cancelled",
    summary?: string,
  ): void {
    if (this.#state === null) return;
    const node = this.#state.nodes[nodeId(id)];
    const attemptId = node?.activeAttemptId ?? `att_${id}_1`;
    this.#apply({
      type: "complete_attempt",
      expectedRevision: this.#revision(),
      at: iso(this.#now),
      nodeId: nodeId(id),
      attemptId,
      outcome,
      ...(summary === undefined ? {} : { resultSummary: summary }),
    });
  }

  #ensureGraph(): void {
    if (this.#state !== null) return;
    const created = applyGraphCommand(null, {
      type: "create_graph",
      expectedRevision: 0,
      at: iso(this.#now),
      graphId: this.#graphId,
      sessionId: this.#sessionId,
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
      rootNodeId: this.#rootNodeId,
      rootTitle: "root",
      rootRole: "root",
    });
    this.#state = created.state;
    this.persistSnapshot();
  }

  #revision(): number {
    return this.#state?.revision ?? 0;
  }

  #apply(command: Parameters<typeof applyGraphCommand>[1]): void {
    const result = applyGraphCommand(this.#state, command);
    this.#state = result.state;
    this.persistSnapshot();
  }
}
