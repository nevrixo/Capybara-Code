/** Pure agent-graph domain types. No I/O, no runtime handles. */

export const GRAPH_SCHEMA_VERSION = "1.0" as const;
export const MAX_GRAPH_NODES = 10_000;
export const MAX_GRAPH_DEPTH = 3;

export type GraphId = `grf_${string}`;
export type NodeId = `agt_${string}`;
export type AttemptId = `att_${string}`;
export type EdgeId = `edg_${string}`;

export type GraphLifecycle = "active" | "paused" | "completed" | "failed" | "cancelled" | "blocked";

export type NodeState =
  | "queued"
  | "ready"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "blocked";

export type EdgeKind = "depends_on" | "review_of" | "verifies";

export type AttemptState = "created" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface GraphEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly kind: EdgeKind;
  readonly required: boolean;
}

export interface GraphAttempt {
  readonly id: AttemptId;
  readonly nodeId: NodeId;
  readonly ordinal: number;
  readonly state: AttemptState;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly resultSummary?: string;
  readonly errorMessage?: string;
}

export interface GraphNode {
  readonly id: NodeId;
  readonly parentId?: NodeId;
  readonly depth: number;
  readonly title: string;
  readonly role: string;
  readonly state: NodeState;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly activeAttemptId?: AttemptId;
  readonly pausedFrom?: NodeState;
  readonly priority: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GraphState {
  readonly schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  readonly id: GraphId;
  readonly sessionId: string;
  readonly workspaceIdentityDigest: string;
  readonly rootNodeId: NodeId;
  readonly lifecycle: GraphLifecycle;
  readonly revision: number;
  readonly maxDepth: number;
  readonly nodes: Readonly<Record<NodeId, GraphNode>>;
  readonly edges: readonly GraphEdge[];
  readonly attempts: Readonly<Record<AttemptId, GraphAttempt>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CommandBase {
  readonly expectedRevision: number;
  readonly at: string;
  readonly correlationId?: string;
}

export interface CreateGraphCommand extends CommandBase {
  readonly type: "create_graph";
  readonly graphId: GraphId;
  readonly sessionId: string;
  readonly workspaceIdentityDigest: string;
  readonly rootNodeId: NodeId;
  readonly rootTitle: string;
  readonly rootRole?: string;
  readonly maxDepth?: number;
  readonly maxAttempts?: number;
}

export interface AddNodeCommand extends CommandBase {
  readonly type: "add_node";
  readonly nodeId: NodeId;
  readonly parentId: NodeId;
  readonly title: string;
  readonly role?: string;
  readonly maxAttempts?: number;
  readonly priority?: number;
}

export interface AddEdgeCommand extends CommandBase {
  readonly type: "add_edge";
  readonly edgeId: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly kind: EdgeKind;
  readonly required?: boolean;
}

export interface MarkReadyCommand extends CommandBase {
  readonly type: "mark_ready";
  readonly nodeId: NodeId;
}

export interface DispatchNodeCommand extends CommandBase {
  readonly type: "dispatch_node";
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
}

export interface PauseNodeCommand extends CommandBase {
  readonly type: "pause_node";
  readonly nodeId: NodeId;
}

export interface ResumeNodeCommand extends CommandBase {
  readonly type: "resume_node";
  readonly nodeId: NodeId;
}

export interface ReviveNodeCommand extends CommandBase {
  readonly type: "revive_node";
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
}

export interface CompleteAttemptCommand extends CommandBase {
  readonly type: "complete_attempt";
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly outcome: "completed" | "partial" | "failed" | "cancelled";
  readonly resultSummary?: string;
  readonly errorMessage?: string;
}

export interface CancelNodeCommand extends CommandBase {
  readonly type: "cancel_node";
  readonly nodeId: NodeId;
}

export interface CloseGraphCommand extends CommandBase {
  readonly type: "close_graph";
  readonly lifecycle: Exclude<GraphLifecycle, "active" | "paused">;
}

export type GraphCommand =
  | CreateGraphCommand
  | AddNodeCommand
  | AddEdgeCommand
  | MarkReadyCommand
  | DispatchNodeCommand
  | PauseNodeCommand
  | ResumeNodeCommand
  | ReviveNodeCommand
  | CompleteAttemptCommand
  | CancelNodeCommand
  | CloseGraphCommand;

export type GraphEventKind =
  | "graph_created"
  | "node_added"
  | "edge_added"
  | "node_state_changed"
  | "attempt_created"
  | "attempt_finished"
  | "graph_closed"
  | "revision_conflict"
  | "command_rejected";

export interface GraphEvent {
  readonly kind: GraphEventKind;
  readonly at: string;
  readonly revision: number;
  readonly nodeId?: NodeId;
  readonly edgeId?: EdgeId;
  readonly attemptId?: AttemptId;
  readonly message?: string;
  readonly fromState?: NodeState | GraphLifecycle;
  readonly toState?: NodeState | GraphLifecycle;
}

export interface GraphCommandResult {
  readonly state: GraphState;
  readonly events: readonly GraphEvent[];
}

export class GraphDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GraphDomainError";
    this.code = code;
  }
}
