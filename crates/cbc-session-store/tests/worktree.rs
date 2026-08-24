use cbc_session_store::{
    new_manifest, AgentGraphCreate, AgentNodeCreate, SessionStore, StoreError, WorktreeCreate,
    WorktreeState, WorktreeTransition, WorktreeWriterLeaseInput, WorktreeWriterLeaseState,
};
use serde_json::json;

const T0: &str = "2026-08-25T00:00:00.000Z";
const T1: &str = "2026-08-25T00:00:01.000Z";
const T2: &str = "2026-08-25T00:00:02.000Z";
const T3: &str = "2026-08-25T00:00:03.000Z";
const T4: &str = "2026-08-25T00:00:04.000Z";
const T5: &str = "2026-08-25T00:00:05.000Z";
const T7: &str = "2026-08-25T00:00:07.000Z";

fn seeded_store() -> SessionStore {
    let mut store = SessionStore::open_in_memory().expect("open store");
    store
        .create_session(&new_manifest(
            "ses_worktree",
            "/work",
            "workspace-fingerprint",
            "worktree test",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    store
        .create_agent_graph(&AgentGraphCreate {
            id: "grf_worktree".into(),
            session_id: "ses_worktree".into(),
            workspace_identity_digest: "workspace-fingerprint".into(),
            max_depth: 2,
            budget: json!({ "maxTokens": 1000, "maxWallMs": 60_000 }),
            root: AgentNodeCreate {
                id: "agt_writer".into(),
                parent_node_id: None,
                role: "writer".into(),
                name: Some("Writer".into()),
                title: "Own the isolated worktree".into(),
                task: json!({ "kind": "write", "goal": "isolate changes" }),
                model_profile: "auto".into(),
                permission_scope: json!({ "mode": "write" }),
                worktree_id: None,
                max_attempts: 2,
                priority: 1,
            },
            created_at: T0.into(),
        })
        .expect("create graph");
    store
}

fn worktree() -> WorktreeCreate {
    WorktreeCreate {
        id: "wt_isolated".into(),
        workspace_identity_digest: "workspace-fingerprint".into(),
        graph_id: Some("grf_worktree".into()),
        node_id: Some("agt_writer".into()),
        path: "worktrees/workspace-fingerprint/wt_isolated/repo".into(),
        base_commit: "a".repeat(40),
        base_workspace_revision: "base-r1".into(),
        created_at: T0.into(),
        expires_at: Some(T7.into()),
    }
}

fn writer_lease(
    id: &str,
    owner_epoch: i64,
    acquired_at: &str,
    expires_at: &str,
) -> WorktreeWriterLeaseInput {
    WorktreeWriterLeaseInput {
        id: id.into(),
        node_id: "agt_writer".into(),
        owner_epoch,
        allowed_paths: vec!["src".into()],
        baseline_revisions: json!({ "src/lib.rs": "rev-1" }),
        acquired_at: acquired_at.into(),
        heartbeat_at: acquired_at.into(),
        expires_at: expires_at.into(),
    }
}

fn ready_worktree(store: &mut SessionStore) -> i64 {
    let created = store.create_worktree(&worktree()).expect("create worktree");
    assert_eq!(created.state, WorktreeState::Creating);
    store
        .transition_worktree(
            "wt_isolated",
            &WorktreeTransition {
                expected_revision: created.revision,
                state: WorktreeState::Ready,
                at: T1.into(),
                head_commit: None,
                dirty_digest: None,
                expires_at: Some(T7.into()),
            },
        )
        .expect("mark generated worktree ready")
        .revision
}

#[test]
fn writer_lease_requires_explicit_reconciliation_before_replacement() {
    let mut store = seeded_store();
    let ready_revision = ready_worktree(&mut store);

    let first = store
        .acquire_worktree_writer_lease(
            "wt_isolated",
            ready_revision,
            &writer_lease("wls_one", 1, T1, T3),
        )
        .expect("acquire first writer");
    assert_eq!(first.worktree.state, WorktreeState::Leased);
    assert_eq!(first.worktree.revision, 3);
    assert_eq!(first.value.owner_epoch, 1);

    let conflict = store
        .acquire_worktree_writer_lease(
            "wt_isolated",
            first.worktree.revision,
            &writer_lease("wls_two", 2, T2, T4),
        )
        .expect_err("an active writer blocks a second writer");
    assert!(matches!(
        conflict,
        StoreError::WorktreeWriterLeaseConflict {
            active_lease_id,
            ..
        } if active_lease_id == "wls_one"
    ));

    let renewed = store
        .renew_worktree_writer_lease("wt_isolated", 3, "wls_one", 1, T2, T4)
        .expect("renew exact writer epoch");
    assert_eq!(renewed.worktree.revision, 4);
    assert_eq!(renewed.value.heartbeat_at, T2);
    let expired_release = store
        .release_worktree_writer_lease("wt_isolated", 4, "wls_one", 1, WorktreeState::Ready, T4)
        .expect_err("an expired writer must enter recovery, not release");
    assert!(matches!(
        expired_release,
        StoreError::InvalidWorktree { .. }
    ));

    let unexpired = store
        .reconcile_expired_worktree_writer_lease("wt_isolated", 4, "wls_one", 1, T3)
        .expect_err("a live writer must not be reconciled");
    assert!(matches!(unexpired, StoreError::InvalidWorktree { .. }));

    let expired = store
        .reconcile_expired_worktree_writer_lease("wt_isolated", 4, "wls_one", 1, T4)
        .expect("explicitly reconcile expired writer");
    assert_eq!(expired.worktree.state, WorktreeState::RecoveryRequired);
    assert_eq!(expired.worktree.revision, 5);
    assert_eq!(expired.value.state, WorktreeWriterLeaseState::Expired);

    let blocked = store
        .acquire_worktree_writer_lease("wt_isolated", 5, &writer_lease("wls_two", 2, T5, T7))
        .expect_err("recovery must be acknowledged before a replacement");
    assert!(matches!(blocked, StoreError::InvalidWorktree { .. }));

    let ready_again = store
        .transition_worktree(
            "wt_isolated",
            &WorktreeTransition {
                expected_revision: 5,
                state: WorktreeState::Ready,
                at: T5.into(),
                head_commit: None,
                dirty_digest: None,
                expires_at: Some(T7.into()),
            },
        )
        .expect("recovery coordinator returns the tree to ready");
    assert_eq!(ready_again.revision, 6);

    let replacement = store
        .acquire_worktree_writer_lease(
            "wt_isolated",
            ready_again.revision,
            &writer_lease("wls_two", 2, T5, T7),
        )
        .expect("acquire next monotonic writer epoch");
    assert_eq!(replacement.worktree.revision, 7);
    assert_eq!(replacement.value.owner_epoch, 2);
}

#[test]
fn writer_release_is_fenced_and_can_publish_a_merge_ready_tree() {
    let mut store = seeded_store();
    let ready_revision = ready_worktree(&mut store);
    let lease = store
        .acquire_worktree_writer_lease(
            "wt_isolated",
            ready_revision,
            &writer_lease("wls_one", 1, T1, T4),
        )
        .expect("acquire writer");

    let stale_release = store
        .release_worktree_writer_lease(
            "wt_isolated",
            lease.worktree.revision,
            "wls_one",
            2,
            WorktreeState::ProposalReady,
            T2,
        )
        .expect_err("wrong epoch cannot release another writer");
    assert!(matches!(
        stale_release,
        StoreError::WorktreeWriterEpochConflict { .. }
    ));

    let released = store
        .release_worktree_writer_lease(
            "wt_isolated",
            lease.worktree.revision,
            "wls_one",
            1,
            WorktreeState::ProposalReady,
            T2,
        )
        .expect("release writer with a durable proposal state");
    assert_eq!(released.worktree.state, WorktreeState::ProposalReady);
    assert_eq!(released.worktree.revision, 4);
    assert_eq!(released.value.state, WorktreeWriterLeaseState::Released);
    assert!(store
        .active_worktree_writer_lease("wt_isolated")
        .expect("read lease")
        .is_none());

    let merging = store
        .transition_worktree(
            "wt_isolated",
            &WorktreeTransition {
                expected_revision: released.worktree.revision,
                state: WorktreeState::Merging,
                at: T3.into(),
                head_commit: Some("b".repeat(40)),
                dirty_digest: None,
                expires_at: None,
            },
        )
        .expect("begin merge");
    let merged = store
        .transition_worktree(
            "wt_isolated",
            &WorktreeTransition {
                expected_revision: merging.revision,
                state: WorktreeState::Merged,
                at: T4.into(),
                head_commit: Some("b".repeat(40)),
                dirty_digest: None,
                expires_at: None,
            },
        )
        .expect("finish merge");
    assert_eq!(merged.state, WorktreeState::Merged);
}

#[test]
fn worktree_validation_rejects_unmanaged_paths_and_unscoped_writer_requests() {
    let mut store = seeded_store();
    let mut unsafe_path = worktree();
    unsafe_path.path = "../outside".into();
    let path_error = store
        .create_worktree(&unsafe_path)
        .expect_err("worktree paths must be generated and managed");
    assert!(matches!(path_error, StoreError::InvalidWorktree { .. }));

    let ready_revision = ready_worktree(&mut store);
    let mut unsafe_lease = writer_lease("wls_one", 1, T1, T4);
    unsafe_lease.allowed_paths = vec!["../outside".into()];
    let scope_error = store
        .acquire_worktree_writer_lease("wt_isolated", ready_revision, &unsafe_lease)
        .expect_err("writer authority cannot escape its scoped relative paths");
    assert!(matches!(scope_error, StoreError::InvalidWorktree { .. }));

    let mut invalid_time = writer_lease("wls_one", 1, T1, T4);
    invalid_time.expires_at = "2026-08-25T00:00:04Z".into();
    let time_error = store
        .acquire_worktree_writer_lease("wt_isolated", ready_revision, &invalid_time)
        .expect_err("variable-precision timestamps make lexical leases unsafe");
    assert!(matches!(time_error, StoreError::InvalidWorktree { .. }));
    let beyond_worktree_lifetime = writer_lease("wls_one", 1, T1, "2026-08-25T00:00:08.000Z");
    let lifetime_error = store
        .acquire_worktree_writer_lease("wt_isolated", ready_revision, &beyond_worktree_lifetime)
        .expect_err("writer lease must not outlive the managed worktree");
    assert!(matches!(lifetime_error, StoreError::InvalidWorktree { .. }));
}
