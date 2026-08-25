/**
 * Durable AgentGraph authority over the in-process scheduler.
 *
 * The reducer is the source of truth for node identity, depth, and terminal
 * state. The scheduler still runs children; it may not invent a node the graph
 * has not admitted.
 */

import {
  applyGraphCommand,
  type GraphId,
  type GraphState,
  type NodeId,
} from "@cbc/agent-graph-domain";

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
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #workspaceIdentityDigest: string;
  readonly #graphId: GraphId;
  readonly #rootNodeId: NodeId;

  constructor(options: {
    readonly sessionId: string;
    readonly workspaceIdentityDigest: string;
    readonly now?: () => number;
  }) {
    this.#sessionId = options.sessionId;
    this.#workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#now = options.now ?? (() => Date.now());
    this.#graphId = `grf_${options.sessionId}` as GraphId;
    this.#rootNodeId = "agt_root";
  }

  snapshot(): GraphState | null {
    return this.#state;
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
  }

  #revision(): number {
    return this.#state?.revision ?? 0;
  }

  #apply(command: Parameters<typeof applyGraphCommand>[1]): void {
    const result = applyGraphCommand(this.#state, command);
    this.#state = result.state;
  }
}
