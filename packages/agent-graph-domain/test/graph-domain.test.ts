import { describe, expect, test } from "bun:test";

import {
  GraphDomainError,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  applyGraphCommand,
  projectReadyNodes,
  wouldCreateCycle,
  type GraphCommand,
  type GraphNode,
  type GraphState,
  type NodeId,
} from "../src/index.ts";

const AT = "2026-01-01T00:00:00.000Z";

function create(): GraphState {
  const result = applyGraphCommand(null, {
    type: "create_graph",
    expectedRevision: 0,
    at: AT,
    graphId: "grf_1",
    sessionId: "ses_1",
    workspaceIdentityDigest: "ws_1",
    rootNodeId: "agt_root",
    rootTitle: "root",
  });
  return result.state;
}

function apply(state: GraphState, command: GraphCommand): GraphState {
  const result = applyGraphCommand(state, {
    ...command,
    expectedRevision: command.expectedRevision ?? state.revision,
    at: command.at ?? AT,
  });
  if (result.events.some((event) => event.kind === "revision_conflict")) {
    throw new GraphDomainError("GRAPH_REVISION_CONFLICT", result.events[0]?.message ?? "revision conflict");
  }
  return result.state;
}

describe("agent-graph-domain", () => {
  test("rejects dependency cycles", () => {
    let state = create();
    state = apply(state, {
      type: "add_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_a",
      parentId: "agt_root",
      title: "A",
    });
    state = apply(state, {
      type: "add_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_b",
      parentId: "agt_root",
      title: "B",
    });
    state = apply(state, {
      type: "add_edge",
      expectedRevision: state.revision,
      at: AT,
      edgeId: "edg_1",
      from: "agt_a",
      to: "agt_b",
      kind: "depends_on",
    });
    expect(wouldCreateCycle(state.edges, "agt_b", "agt_a", "depends_on")).toBe(true);
    expect(() => apply(state, {
      type: "add_edge",
      expectedRevision: state.revision,
      at: AT,
      edgeId: "edg_2",
      from: "agt_b",
      to: "agt_a",
      kind: "depends_on",
    })).toThrow(GraphDomainError);
  });

  test("pause and resume restore a safe state", () => {
    let state = create();
    state = apply(state, {
      type: "dispatch_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_root",
      attemptId: "att_1",
    });
    expect(state.nodes.agt_root?.state).toBe("running");

    state = apply(state, {
      type: "pause_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_root",
    });
    expect(state.nodes.agt_root?.state).toBe("paused");
    expect(state.nodes.agt_root?.pausedFrom).toBe("running");

    state = apply(state, {
      type: "resume_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_root",
    });
    expect(state.nodes.agt_root?.state).toBe("ready");
    expect(state.nodes.agt_root?.pausedFrom).toBeUndefined();
  });

  test("revive creates a new attempt", () => {
    let state = create();
    state = apply(state, {
      type: "dispatch_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_root",
      attemptId: "att_1",
    });
    state = apply(state, {
      type: "complete_attempt",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_root",
      attemptId: "att_1",
      outcome: "failed",
      errorMessage: "boom",
    });
    expect(state.nodes.agt_root?.state).toBe("failed");

    state = apply(state, {
      type: "revive_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_root",
      attemptId: "att_2",
    });
    expect(state.nodes.agt_root?.state).toBe("queued");
    expect(state.nodes.agt_root?.activeAttemptId).toBe("att_2");
    expect(state.attempts.att_2?.ordinal).toBe(2);
    expect(state.nodes.agt_root?.attemptCount).toBe(2);
  });

  test("optimistic revision conflict leaves state unchanged", () => {
    const state = create();
    const conflicted = applyGraphCommand(state, {
      type: "add_node",
      expectedRevision: 0,
      at: AT,
      nodeId: "agt_x",
      parentId: "agt_root",
      title: "X",
    });
    expect(conflicted.state.revision).toBe(state.revision);
    expect(conflicted.state.nodes.agt_x).toBeUndefined();
    expect(conflicted.events[0]?.kind).toBe("revision_conflict");
  });

  test("100-node projection stays bounded and depth is capped", () => {
    let state = create();
    for (let i = 0; i < 120; i += 1) {
      const id = `agt_n${i}` as NodeId;
      state = apply(state, {
        type: "add_node",
        expectedRevision: state.revision,
        at: AT,
        nodeId: id,
        parentId: "agt_root",
        title: `N${i}`,
        priority: i % 7,
      });
    }
    const projected = projectReadyNodes(state, 100);
    expect(projected).toHaveLength(100);
    expect(projected[0]).toBeDefined();

    state = apply(state, {
      type: "add_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_d1",
      parentId: "agt_root",
      title: "D1",
    });
    state = apply(state, {
      type: "add_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_d2",
      parentId: "agt_d1",
      title: "D2",
    });
    state = apply(state, {
      type: "add_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_d3",
      parentId: "agt_d2",
      title: "D3",
    });
    expect(state.nodes.agt_d3?.depth).toBe(3);
    expect(MAX_GRAPH_DEPTH).toBe(3);
    expect(() => apply(state, {
      type: "add_node",
      expectedRevision: state.revision,
      at: AT,
      nodeId: "agt_d4",
      parentId: "agt_d3",
      title: "D4",
    })).toThrow(/depth/i);
  });

  test("the 10001st node is rejected at MAX_GRAPH_NODES", () => {
    const created = create();
    const template = created.nodes.agt_root;
    expect(template).toBeDefined();
    const nodes: Record<string, GraphNode> = { agt_root: template! };
    for (let i = 1; i < MAX_GRAPH_NODES; i += 1) {
      const id = `agt_n${i}` as NodeId;
      nodes[id] = {
        ...template!,
        id,
        parentId: "agt_root",
        depth: 1,
        title: "n",
        role: "worker",
        state: "queued",
      };
    }
    const packed: GraphState = {
      ...created,
      nodes: nodes as GraphState["nodes"],
    };
    expect(Object.keys(packed.nodes)).toHaveLength(MAX_GRAPH_NODES);

    try {
      applyGraphCommand(packed, {
        type: "add_node",
        expectedRevision: packed.revision,
        at: AT,
        nodeId: "agt_overflow",
        parentId: "agt_root",
        title: "overflow",
      });
      throw new Error("expected GRAPH_NODE_BUDGET");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphDomainError);
      expect((error as GraphDomainError).code).toBe("GRAPH_NODE_BUDGET");
    }
  });
});
