/**
 * DAG cycle detector for depends_on / review_of / verifies edges.
 * Uses DFS with recursion stack; O(N+E) and bounded by MAX_GRAPH_NODES.
 */

import type { EdgeKind, GraphEdge, NodeId } from "./types.ts";

/** Edge kinds that participate in the dependency DAG. */
const DAG_KINDS: ReadonlySet<EdgeKind> = new Set(["depends_on", "review_of", "verifies"]);

export function wouldCreateCycle(
  edges: readonly GraphEdge[],
  from: NodeId,
  to: NodeId,
  kind: EdgeKind = "depends_on",
): boolean {
  if (!DAG_KINDS.has(kind)) return false;
  if (from === to) return true;
  // Edge meaning: `to` depends on `from` completing first (from → to).
  const adjacency = buildAdjacency(edges);
  addEdge(adjacency, from, to);
  return hasCycle(adjacency);
}

export function graphHasCycle(edges: readonly GraphEdge[]): boolean {
  return hasCycle(buildAdjacency(edges));
}

function buildAdjacency(edges: readonly GraphEdge[]): Map<NodeId, Set<NodeId>> {
  const adjacency = new Map<NodeId, Set<NodeId>>();
  for (const edge of edges) {
    if (!DAG_KINDS.has(edge.kind)) continue;
    addEdge(adjacency, edge.from, edge.to);
  }
  return adjacency;
}

function addEdge(adjacency: Map<NodeId, Set<NodeId>>, from: NodeId, to: NodeId): void {
  let bucket = adjacency.get(from);
  if (bucket === undefined) {
    bucket = new Set();
    adjacency.set(from, bucket);
  }
  bucket.add(to);
  if (!adjacency.has(to)) adjacency.set(to, new Set());
}

function hasCycle(adjacency: Map<NodeId, Set<NodeId>>): boolean {
  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();

  const visit = (node: NodeId): boolean => {
    if (visited.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of adjacency.keys()) {
    if (visit(node)) return true;
  }
  return false;
}
