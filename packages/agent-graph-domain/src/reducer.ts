/**
 * Deterministic agent-graph command reducer. Pure: no I/O, no handles.
 */

import { graphHasCycle, wouldCreateCycle } from "./cycle.ts";
import {
  GRAPH_SCHEMA_VERSION,
  GraphDomainError,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  type AddEdgeCommand,
  type AddNodeCommand,
  type CompleteAttemptCommand,
  type CreateGraphCommand,
  type DispatchNodeCommand,
  type GraphAttempt,
  type GraphCommand,
  type GraphCommandResult,
  type GraphEvent,
  type GraphNode,
  type GraphState,
  type NodeId,
  type NodeState,
  type PauseNodeCommand,
  type ResumeNodeCommand,
  type ReviveNodeCommand,
} from "./types.ts";

export function emptyGraphPlaceholder(): GraphState | null {
  return null;
}

export function applyGraphCommand(
  state: GraphState | null,
  command: GraphCommand,
): GraphCommandResult {
  if (command.type === "create_graph") {
    return createGraph(command);
  }
  if (state === null) {
    throw new GraphDomainError("GRAPH_NOT_FOUND", "graph has not been created");
  }
  if (command.expectedRevision !== state.revision) {
    return {
      state,
      events: Object.freeze([{
        kind: "revision_conflict",
        at: command.at,
        revision: state.revision,
        message: `expected revision ${command.expectedRevision}, actual ${state.revision}`,
      }]),
    };
  }
  if (state.lifecycle !== "active" && state.lifecycle !== "paused" && command.type !== "close_graph") {
    throw new GraphDomainError("GRAPH_TERMINAL", `graph is ${state.lifecycle}`);
  }

  switch (command.type) {
    case "add_node":
      return addNode(state, command);
    case "add_edge":
      return addEdge(state, command);
    case "mark_ready":
      return transitionNode(state, command.nodeId, "ready", command.at, ["queued", "waiting"]);
    case "dispatch_node":
      return dispatchNode(state, command);
    case "pause_node":
      return pauseNode(state, command);
    case "resume_node":
      return resumeNode(state, command);
    case "revive_node":
      return reviveNode(state, command);
    case "complete_attempt":
      return completeAttempt(state, command);
    case "cancel_node":
      return transitionNode(state, command.nodeId, "cancelled", command.at, [
        "queued", "ready", "running", "waiting", "paused", "blocked",
      ]);
    case "close_graph":
      return {
        state: freezeState({
          ...state,
          lifecycle: command.lifecycle,
          revision: state.revision + 1,
          updatedAt: command.at,
        }),
        events: Object.freeze([{
          kind: "graph_closed",
          at: command.at,
          revision: state.revision + 1,
          fromState: state.lifecycle,
          toState: command.lifecycle,
        }]),
      };
    default: {
      const _exhaustive: never = command;
      throw new GraphDomainError("GRAPH_COMMAND_UNKNOWN", `unknown command ${( _exhaustive as GraphCommand).type}`);
    }
  }
}

function createGraph(command: CreateGraphCommand): GraphCommandResult {
  if (command.expectedRevision !== 0) {
    throw new GraphDomainError("GRAPH_REVISION", "create_graph requires expectedRevision 0");
  }
  const maxDepth = Math.min(MAX_GRAPH_DEPTH, Math.max(1, command.maxDepth ?? MAX_GRAPH_DEPTH));
  const root: GraphNode = freezeNode({
    id: command.rootNodeId,
    depth: 0,
    title: command.rootTitle,
    role: command.rootRole ?? "root",
    state: "ready",
    attemptCount: 0,
    maxAttempts: command.maxAttempts ?? 3,
    priority: 0,
    createdAt: command.at,
    updatedAt: command.at,
  });
  const state = freezeState({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: command.graphId,
    sessionId: command.sessionId,
    workspaceIdentityDigest: command.workspaceIdentityDigest,
    rootNodeId: command.rootNodeId,
    lifecycle: "active",
    revision: 1,
    maxDepth,
    nodes: Object.freeze({ [command.rootNodeId]: root }),
    edges: Object.freeze([]),
    attempts: Object.freeze({}),
    createdAt: command.at,
    updatedAt: command.at,
  });
  return {
    state,
    events: Object.freeze([
      {
        kind: "graph_created",
        at: command.at,
        revision: 1,
        nodeId: command.rootNodeId,
        toState: "active",
      },
      {
        kind: "node_added",
        at: command.at,
        revision: 1,
        nodeId: command.rootNodeId,
        toState: "ready",
      },
    ]),
  };
}

function addNode(state: GraphState, command: AddNodeCommand): GraphCommandResult {
  if (state.nodes[command.nodeId] !== undefined) {
    throw new GraphDomainError("GRAPH_NODE_EXISTS", `node already exists: ${command.nodeId}`);
  }
  const parent = requireNode(state, command.parentId);
  const depth = parent.depth + 1;
  if (depth > state.maxDepth || depth > MAX_GRAPH_DEPTH) {
    throw new GraphDomainError("GRAPH_DEPTH", `node depth ${depth} exceeds max ${state.maxDepth}`);
  }
  if (Object.keys(state.nodes).length >= MAX_GRAPH_NODES) {
    throw new GraphDomainError("GRAPH_NODE_BUDGET", `graph is capped at ${MAX_GRAPH_NODES} nodes`);
  }
  const node = freezeNode({
    id: command.nodeId,
    parentId: command.parentId,
    depth,
    title: command.title,
    role: command.role ?? "worker",
    state: "queued",
    attemptCount: 0,
    maxAttempts: command.maxAttempts ?? 3,
    priority: command.priority ?? 0,
    createdAt: command.at,
    updatedAt: command.at,
  });
  const next = withNode(state, node, command.at);
  return {
    state: next,
    events: Object.freeze([{
      kind: "node_added",
      at: command.at,
      revision: next.revision,
      nodeId: node.id,
      toState: node.state,
    }]),
  };
}

function addEdge(state: GraphState, command: AddEdgeCommand): GraphCommandResult {
  requireNode(state, command.from);
  requireNode(state, command.to);
  if (state.edges.some((edge) => edge.id === command.edgeId)) {
    throw new GraphDomainError("GRAPH_EDGE_EXISTS", `edge already exists: ${command.edgeId}`);
  }
  if (wouldCreateCycle(state.edges, command.from, command.to, command.kind)) {
    throw new GraphDomainError("GRAPH_CYCLE", `edge ${command.from} → ${command.to} would create a cycle`);
  }
  const edge = Object.freeze({
    id: command.edgeId,
    from: command.from,
    to: command.to,
    kind: command.kind,
    required: command.required !== false,
  });
  const edges = Object.freeze([...state.edges, edge]);
  if (graphHasCycle(edges)) {
    throw new GraphDomainError("GRAPH_CYCLE", "edge set contains a cycle");
  }
  const next = freezeState({
    ...state,
    edges,
    revision: state.revision + 1,
    updatedAt: command.at,
  });
  return {
    state: next,
    events: Object.freeze([{
      kind: "edge_added",
      at: command.at,
      revision: next.revision,
      edgeId: edge.id,
      message: `${edge.from}->${edge.to}:${edge.kind}`,
    }]),
  };
}

function dispatchNode(state: GraphState, command: DispatchNodeCommand): GraphCommandResult {
  const node = requireNode(state, command.nodeId);
  if (node.state !== "ready" && node.state !== "queued") {
    throw new GraphDomainError("GRAPH_TRANSITION", `cannot dispatch node in state ${node.state}`);
  }
  if (state.attempts[command.attemptId] !== undefined) {
    throw new GraphDomainError("GRAPH_ATTEMPT_EXISTS", `attempt already exists: ${command.attemptId}`);
  }
  const attempt: GraphAttempt = Object.freeze({
    id: command.attemptId,
    nodeId: command.nodeId,
    ordinal: node.attemptCount + 1,
    state: "running",
    createdAt: command.at,
  });
  const updated = freezeNode({
    ...node,
    state: "running",
    attemptCount: node.attemptCount + 1,
    activeAttemptId: attempt.id,
    updatedAt: command.at,
  });
  const next = withAttempt(withNode(state, updated, command.at), attempt);
  return {
    state: next,
    events: Object.freeze([
      {
        kind: "attempt_created",
        at: command.at,
        revision: next.revision,
        nodeId: node.id,
        attemptId: attempt.id,
      },
      {
        kind: "node_state_changed",
        at: command.at,
        revision: next.revision,
        nodeId: node.id,
        fromState: node.state,
        toState: "running",
      },
    ]),
  };
}

function pauseNode(state: GraphState, command: PauseNodeCommand): GraphCommandResult {
  const node = requireNode(state, command.nodeId);
  if (node.state !== "running" && node.state !== "ready" && node.state !== "queued" && node.state !== "waiting") {
    throw new GraphDomainError("GRAPH_TRANSITION", `cannot pause node in state ${node.state}`);
  }
  const updated = freezeNode({
    ...node,
    state: "paused",
    pausedFrom: node.state,
    updatedAt: command.at,
  });
  const next = withNode(state, updated, command.at);
  return {
    state: next,
    events: Object.freeze([{
      kind: "node_state_changed",
      at: command.at,
      revision: next.revision,
      nodeId: node.id,
      fromState: node.state,
      toState: "paused",
    }]),
  };
}

function resumeNode(state: GraphState, command: ResumeNodeCommand): GraphCommandResult {
  const node = requireNode(state, command.nodeId);
  if (node.state !== "paused") {
    throw new GraphDomainError("GRAPH_TRANSITION", `cannot resume node in state ${node.state}`);
  }
  const restored: NodeState = node.pausedFrom === "running" ? "ready" : (node.pausedFrom ?? "queued");
  const { pausedFrom: _pausedFrom, ...rest } = node;
  const updated = freezeNode({
    ...rest,
    state: restored,
    updatedAt: command.at,
  });
  const next = withNode(state, updated, command.at);
  return {
    state: next,
    events: Object.freeze([{
      kind: "node_state_changed",
      at: command.at,
      revision: next.revision,
      nodeId: node.id,
      fromState: "paused",
      toState: restored,
    }]),
  };
}

function reviveNode(state: GraphState, command: ReviveNodeCommand): GraphCommandResult {
  const node = requireNode(state, command.nodeId);
  if (node.state !== "failed" && node.state !== "cancelled" && node.state !== "partial" && node.state !== "blocked") {
    throw new GraphDomainError("GRAPH_TRANSITION", `cannot revive node in state ${node.state}`);
  }
  if (node.attemptCount >= node.maxAttempts) {
    throw new GraphDomainError("GRAPH_ATTEMPT_BUDGET", `node ${node.id} exhausted maxAttempts`);
  }
  if (state.attempts[command.attemptId] !== undefined) {
    throw new GraphDomainError("GRAPH_ATTEMPT_EXISTS", `attempt already exists: ${command.attemptId}`);
  }
  const attempt: GraphAttempt = Object.freeze({
    id: command.attemptId,
    nodeId: command.nodeId,
    ordinal: node.attemptCount + 1,
    state: "created",
    createdAt: command.at,
  });
  const { pausedFrom: _pausedFrom, ...rest } = node;
  const updated = freezeNode({
    ...rest,
    state: "queued",
    attemptCount: node.attemptCount + 1,
    activeAttemptId: attempt.id,
    updatedAt: command.at,
  });
  const next = withAttempt(withNode(state, updated, command.at), attempt);
  return {
    state: next,
    events: Object.freeze([
      {
        kind: "attempt_created",
        at: command.at,
        revision: next.revision,
        nodeId: node.id,
        attemptId: attempt.id,
        message: "revive",
      },
      {
        kind: "node_state_changed",
        at: command.at,
        revision: next.revision,
        nodeId: node.id,
        fromState: node.state,
        toState: "queued",
      },
    ]),
  };
}

function completeAttempt(state: GraphState, command: CompleteAttemptCommand): GraphCommandResult {
  const node = requireNode(state, command.nodeId);
  const attempt = state.attempts[command.attemptId];
  if (attempt === undefined) {
    throw new GraphDomainError("GRAPH_ATTEMPT_MISSING", `unknown attempt: ${command.attemptId}`);
  }
  if (attempt.nodeId !== command.nodeId) {
    throw new GraphDomainError("GRAPH_ATTEMPT_MISMATCH", "attempt does not belong to node");
  }
  const finished: GraphAttempt = Object.freeze({
    ...attempt,
    state: command.outcome === "cancelled" ? "cancelled" : command.outcome === "failed" ? "failed" : "completed",
    finishedAt: command.at,
    ...(command.resultSummary !== undefined ? { resultSummary: command.resultSummary } : {}),
    ...(command.errorMessage !== undefined ? { errorMessage: command.errorMessage } : {}),
  });
  const { activeAttemptId: _activeAttemptId, ...rest } = node;
  const updated = freezeNode({
    ...rest,
    state: command.outcome,
    updatedAt: command.at,
  });
  const next = withAttempt(withNode(state, updated, command.at), finished);
  return {
    state: next,
    events: Object.freeze([
      {
        kind: "attempt_finished",
        at: command.at,
        revision: next.revision,
        nodeId: node.id,
        attemptId: attempt.id,
        toState: command.outcome,
      },
      {
        kind: "node_state_changed",
        at: command.at,
        revision: next.revision,
        nodeId: node.id,
        fromState: node.state,
        toState: command.outcome,
      },
    ]),
  };
}

function transitionNode(
  state: GraphState,
  nodeId: NodeId,
  toState: NodeState,
  at: string,
  allowedFrom: readonly NodeState[],
): GraphCommandResult {
  const node = requireNode(state, nodeId);
  if (!allowedFrom.includes(node.state)) {
    throw new GraphDomainError("GRAPH_TRANSITION", `cannot move ${node.state} → ${toState}`);
  }
  const updated = freezeNode({ ...node, state: toState, updatedAt: at });
  const next = withNode(state, updated, at);
  return {
    state: next,
    events: Object.freeze([{
      kind: "node_state_changed",
      at,
      revision: next.revision,
      nodeId,
      fromState: node.state,
      toState,
    }]),
  };
}

function requireNode(state: GraphState, id: NodeId): GraphNode {
  const node = state.nodes[id];
  if (node === undefined) throw new GraphDomainError("GRAPH_NODE_MISSING", `unknown node: ${id}`);
  return node;
}

function withNode(state: GraphState, node: GraphNode, at: string): GraphState {
  return freezeState({
    ...state,
    nodes: Object.freeze({ ...state.nodes, [node.id]: node }),
    revision: state.revision + 1,
    updatedAt: at,
  });
}

function withAttempt(state: GraphState, attempt: GraphAttempt): GraphState {
  return freezeState({
    ...state,
    attempts: Object.freeze({ ...state.attempts, [attempt.id]: attempt }),
  });
}

function freezeNode(node: GraphNode): GraphNode {
  return Object.freeze(node);
}

function freezeState(state: GraphState): GraphState {
  return Object.freeze({
    ...state,
    nodes: Object.freeze({ ...state.nodes }),
    edges: Object.freeze([...state.edges]),
    attempts: Object.freeze({ ...state.attempts }),
  });
}

/** Bound projection of node ids sorted by priority then id. */
export function projectReadyNodes(state: GraphState, limit = 100): readonly NodeId[] {
  const capped = Math.min(100, Math.max(0, Math.floor(limit)));
  return Object.values(state.nodes)
    .filter((node) => node.state === "ready" || node.state === "queued")
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .slice(0, capped)
    .map((node) => node.id);
}
