use cbc_session_store::{
    new_manifest, AgentAttemptCreate, AgentAttemptState, AgentAttemptTransition, AgentEdgeCreate,
    AgentEdgeKind, AgentGraphCreate, AgentNodeCreate, AgentNodeState, AgentNodeTransition,
    SessionStore, StoreError,
};
use serde_json::json;

const T0: &str = "2026-08-25T00:00:00.000Z";
const T1: &str = "2026-08-25T00:00:01.000Z";
const T2: &str = "2026-08-25T00:00:02.000Z";
const T3: &str = "2026-08-25T00:00:03.000Z";
const T4: &str = "2026-08-25T00:00:04.000Z";

fn store() -> SessionStore {
    let store = SessionStore::open_in_memory().expect("open store");
    store
        .create_session(&new_manifest(
            "ses_graph",
            "/work",
            "workspace-fingerprint",
            "graph test",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    store
}

fn root() -> AgentNodeCreate {
    AgentNodeCreate {
        id: "agt_root".into(),
        parent_node_id: None,
        role: "root".into(),
        name: Some("Root".into()),
        title: "Coordinate durable graph".into(),
        task: json!({ "kind": "root", "goal": "coordinate" }),
        model_profile: "auto".into(),
        permission_scope: json!({ "mode": "read" }),
        worktree_id: None,
        max_attempts: 3,
        priority: 10,
    }
}

fn graph(max_depth: i64) -> AgentGraphCreate {
    AgentGraphCreate {
        id: "grf_test".into(),
        session_id: "ses_graph".into(),
        workspace_identity_digest: "workspace-fingerprint".into(),
        max_depth,
        budget: json!({ "maxTokens": 1000, "maxWallMs": 60_000 }),
        root: root(),
        created_at: T0.into(),
    }
}

fn child(id: &str, parent: &str) -> AgentNodeCreate {
    AgentNodeCreate {
        id: id.into(),
        parent_node_id: Some(parent.into()),
        role: "researcher".into(),
        name: None,
        title: format!("Task for {id}"),
        task: json!({ "kind": "research", "target": id }),
        model_profile: "fast".into(),
        permission_scope: json!({ "mode": "read" }),
        worktree_id: None,
        max_attempts: 2,
        priority: 1,
    }
}

#[test]
fn graph_creation_and_child_addition_are_revision_fenced() {
    let mut store = store();
    let created = store.create_agent_graph(&graph(2)).expect("create graph");
    assert_eq!(created.graph.revision, 1);
    assert_eq!(created.value.id, "agt_root");
    assert_eq!(created.value.depth, 0);
    assert_eq!(created.value.state, AgentNodeState::Created);

    let added = store
        .add_agent_node("grf_test", 1, &child("agt_child", "agt_root"), T1)
        .expect("add child");
    assert_eq!(added.graph.revision, 2);
    assert_eq!(added.value.depth, 1);
    assert_eq!(store.agent_nodes("grf_test").expect("nodes").len(), 2);

    let stale = store
        .add_agent_node("grf_test", 1, &child("agt_stale", "agt_root"), T2)
        .expect_err("old graph snapshot must not mutate");
    assert!(matches!(
        stale,
        StoreError::GraphRevisionConflict {
            expected: 1,
            actual: Some(2),
            ..
        }
    ));
}

#[test]
fn dependency_edges_reject_cycles_and_preserve_graph_revision() {
    let mut store = store();
    store.create_agent_graph(&graph(3)).expect("create graph");
    let child = store
        .add_agent_node("grf_test", 1, &child("agt_child", "agt_root"), T1)
        .expect("add child");

    let first = store
        .add_agent_edge(
            "grf_test",
            child.graph.revision,
            &AgentEdgeCreate {
                id: "edg_root_child".into(),
                from_node_id: "agt_root".into(),
                to_node_id: "agt_child".into(),
                kind: AgentEdgeKind::DependsOn,
                required: true,
                condition: None,
                created_at: T2.into(),
            },
        )
        .expect("first dependency");
    assert_eq!(first.graph.revision, 3);

    let cycle = store
        .add_agent_edge(
            "grf_test",
            first.graph.revision,
            &AgentEdgeCreate {
                id: "edg_child_root".into(),
                from_node_id: "agt_child".into(),
                to_node_id: "agt_root".into(),
                kind: AgentEdgeKind::DependsOn,
                required: true,
                condition: None,
                created_at: T3.into(),
            },
        )
        .expect_err("reverse edge closes a dependency cycle");
    assert!(matches!(cycle, StoreError::InvalidAgentGraph { .. }));
    assert_eq!(
        store
            .agent_graph("grf_test")
            .expect("graph")
            .expect("present")
            .revision,
        3
    );
}

#[test]
fn node_state_machine_requires_current_node_and_graph_revisions() {
    let mut store = store();
    let created = store.create_agent_graph(&graph(2)).expect("create graph");

    let queued = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: created.graph.revision,
                expected_node_revision: created.value.revision,
                state: AgentNodeState::Queued,
                at: T1.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("queue root");
    assert_eq!(queued.graph.revision, 2);
    assert_eq!(queued.value.revision, 2);

    let stale_node = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: 2,
                expected_node_revision: 1,
                state: AgentNodeState::Dispatching,
                at: T2.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect_err("stale node revision rejected");
    assert!(matches!(
        stale_node,
        StoreError::AgentNodeRevisionConflict {
            expected: 1,
            actual: Some(2),
            ..
        }
    ));

    let dispatching = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: queued.graph.revision,
                expected_node_revision: queued.value.revision,
                state: AgentNodeState::Dispatching,
                at: T2.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("dispatch");
    let running = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: dispatching.graph.revision,
                expected_node_revision: dispatching.value.revision,
                state: AgentNodeState::Running,
                at: T3.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("run");
    let completed = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: running.graph.revision,
                expected_node_revision: running.value.revision,
                state: AgentNodeState::Completed,
                at: T4.into(),
                result: Some(json!({ "status": "verified" })),
                blocked_reason: None,
            },
        )
        .expect("complete");
    assert_eq!(completed.value.state, AgentNodeState::Completed);
    assert_eq!(completed.value.terminal_at.as_deref(), Some(T4));
}

#[test]
fn graph_depth_is_enforced_before_child_projection_is_inserted() {
    let mut store = store();
    store.create_agent_graph(&graph(0)).expect("create graph");

    let too_deep = store
        .add_agent_node("grf_test", 1, &child("agt_child", "agt_root"), T1)
        .expect_err("depth zero graph has only the root");
    assert!(matches!(too_deep, StoreError::InvalidAgentGraph { .. }));
    assert_eq!(store.agent_nodes("grf_test").expect("nodes").len(), 1);
}
#[test]
fn graph_cannot_be_bound_to_another_workspace_than_its_session() {
    let mut store = store();
    let mut input = graph(2);
    input.workspace_identity_digest = "another-workspace".into();

    let err = store
        .create_agent_graph(&input)
        .expect_err("cross-workspace graph is unsafe");
    assert!(matches!(err, StoreError::InvalidAgentGraph { .. }));
    assert!(store.agent_graph("grf_test").expect("query").is_none());
}
#[test]
fn attempt_lifecycle_is_durable_and_fences_late_worker_transitions() {
    let mut store = store();
    let created = store.create_agent_graph(&graph(2)).expect("create graph");
    let queued = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: created.graph.revision,
                expected_node_revision: created.value.revision,
                state: AgentNodeState::Queued,
                at: T1.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("queue node");

    let leased = store
        .start_agent_attempt(
            "grf_test",
            "agt_root",
            queued.graph.revision,
            queued.value.revision,
            &AgentAttemptCreate {
                id: "att_root_1".into(),
                daemon_id: Some("daemon_a".into()),
                owner_epoch: Some(1),
                worker_lease_id: Some("lease_a".into()),
                model_profile: "auto".into(),
                provider_route: Some("primary".into()),
                worktree_id: None,
                turn_id: Some("turn_1".into()),
                context_pack_id: None,
                at: T1.into(),
            },
        )
        .expect("lease attempt");
    assert_eq!(leased.value.ordinal, 1);
    assert_eq!(leased.value.state, AgentAttemptState::Leased);
    assert_eq!(
        store.stale_agent_attempts(T2).expect("stale lookup").len(),
        1
    );

    let running = store
        .transition_agent_attempt(
            "grf_test",
            "agt_root",
            "att_root_1",
            &AgentAttemptTransition {
                expected_graph_revision: leased.graph.revision,
                expected_node_revision: 3,
                state: AgentAttemptState::Running,
                at: T2.into(),
                result_claim: None,
                verified_result: None,
                error: None,
                usage: None,
            },
        )
        .expect("start running");
    assert_eq!(running.value.state, AgentAttemptState::Running);

    let waiting = store
        .transition_agent_attempt(
            "grf_test",
            "agt_root",
            "att_root_1",
            &AgentAttemptTransition {
                expected_graph_revision: running.graph.revision,
                expected_node_revision: 4,
                state: AgentAttemptState::WaitingTool,
                at: T3.into(),
                result_claim: None,
                verified_result: None,
                error: None,
                usage: Some(json!({ "inputTokens": 10 })),
            },
        )
        .expect("wait tool");
    assert_eq!(waiting.value.state, AgentAttemptState::WaitingTool);

    let resumed = store
        .transition_agent_attempt(
            "grf_test",
            "agt_root",
            "att_root_1",
            &AgentAttemptTransition {
                expected_graph_revision: waiting.graph.revision,
                expected_node_revision: 5,
                state: AgentAttemptState::Running,
                at: T4.into(),
                result_claim: None,
                verified_result: None,
                error: None,
                usage: None,
            },
        )
        .expect("resume");

    let completed = store
        .transition_agent_attempt(
            "grf_test",
            "agt_root",
            "att_root_1",
            &AgentAttemptTransition {
                expected_graph_revision: resumed.graph.revision,
                expected_node_revision: 6,
                state: AgentAttemptState::Completed,
                at: "2026-08-25T00:00:05.000Z".into(),
                result_claim: Some(json!({ "summary": "done" })),
                verified_result: Some(json!({ "verified": true })),
                error: None,
                usage: Some(json!({ "outputTokens": 20 })),
            },
        )
        .expect("complete");
    assert_eq!(completed.value.state, AgentAttemptState::Completed);
    assert!(completed.value.finished_at.is_some());
    assert!(store
        .stale_agent_attempts("2026-08-25T00:00:06.000Z")
        .expect("stale")
        .is_empty());

    let node = store
        .agent_node("agt_root")
        .expect("node")
        .expect("present");
    assert_eq!(node.state, AgentNodeState::Completed);
    assert_eq!(node.active_attempt_id, None);
    assert_eq!(node.attempt_count, 1);
}
#[test]
fn retry_creates_a_new_attempt_ordinal_without_overwriting_failure_history() {
    let mut store = store();
    let created = store.create_agent_graph(&graph(2)).expect("create");
    let queued = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: 1,
                expected_node_revision: 1,
                state: AgentNodeState::Queued,
                at: T1.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("queue");
    let first = store
        .start_agent_attempt(
            "grf_test",
            "agt_root",
            queued.graph.revision,
            queued.value.revision,
            &AgentAttemptCreate {
                id: "att_root_1".into(),
                daemon_id: Some("daemon_a".into()),
                owner_epoch: Some(1),
                worker_lease_id: None,
                model_profile: "auto".into(),
                provider_route: None,
                worktree_id: None,
                turn_id: None,
                context_pack_id: None,
                at: T1.into(),
            },
        )
        .expect("first attempt");
    let failed = store
        .transition_agent_attempt(
            "grf_test",
            "agt_root",
            "att_root_1",
            &AgentAttemptTransition {
                expected_graph_revision: first.graph.revision,
                expected_node_revision: 3,
                state: AgentAttemptState::Failed,
                at: T2.into(),
                result_claim: None,
                verified_result: None,
                error: Some(json!({ "code": "provider_failed" })),
                usage: None,
            },
        )
        .expect("fail first attempt");
    let revived = store
        .transition_agent_node(
            "grf_test",
            "agt_root",
            &AgentNodeTransition {
                expected_graph_revision: failed.graph.revision,
                expected_node_revision: 4,
                state: AgentNodeState::Queued,
                at: T3.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("revive node");
    let second = store
        .start_agent_attempt(
            "grf_test",
            "agt_root",
            revived.graph.revision,
            revived.value.revision,
            &AgentAttemptCreate {
                id: "att_root_2".into(),
                daemon_id: Some("daemon_b".into()),
                owner_epoch: Some(2),
                worker_lease_id: None,
                model_profile: "fallback".into(),
                provider_route: None,
                worktree_id: None,
                turn_id: None,
                context_pack_id: None,
                at: T4.into(),
            },
        )
        .expect("second attempt");
    assert_eq!(second.value.ordinal, 2);

    let attempts = store.agent_attempts_for_node("agt_root").expect("history");
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].state, AgentAttemptState::Failed);
    assert_eq!(attempts[1].state, AgentAttemptState::Leased);
    assert_eq!(
        attempts[0].error,
        Some(json!({ "code": "provider_failed" }))
    );
    assert_eq!(created.graph.id, "grf_test");
}
