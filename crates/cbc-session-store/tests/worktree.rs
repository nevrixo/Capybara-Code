use cbc_session_store::{
    new_manifest, AgentAttemptCreate, AgentAttemptState, AgentAttemptTransition, AgentGraphCreate,
    AgentNodeCreate, AgentNodeState, AgentNodeTransition, DurableEvidenceInput, EvidenceFreshness,
    EvidencePathBinding, MergeAttemptCreate, MergeAttemptState, MergeConflictPolicy, SessionStore,
    StoreError, WorktreeChangeKind, WorktreeChangedFile, WorktreeCreate, WorktreeProposalCreate,
    WorktreeProposalPayload, WorktreeState, WorktreeTransition, WorktreeWriterLeaseInput,
    WorktreeWriterLeaseState,
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

#[test]
fn completed_writer_attempt_publishes_an_evidence_backed_proposal_atomically() {
    let mut store = seeded_store();
    let ready_revision = ready_worktree(&mut store);
    let writer = store
        .acquire_worktree_writer_lease(
            "wt_isolated",
            ready_revision,
            &writer_lease("wls_one", 1, T1, T7),
        )
        .expect("acquire writer");

    let queued = store
        .transition_agent_node(
            "grf_worktree",
            "agt_writer",
            &AgentNodeTransition {
                expected_graph_revision: 1,
                expected_node_revision: 1,
                state: AgentNodeState::Queued,
                at: T1.into(),
                result: None,
                blocked_reason: None,
            },
        )
        .expect("queue writer node");
    let attempt = store
        .start_agent_attempt(
            "grf_worktree",
            "agt_writer",
            queued.graph.revision,
            queued.value.revision,
            &AgentAttemptCreate {
                id: "att_proposal".into(),
                daemon_id: None,
                owner_epoch: None,
                worker_lease_id: None,
                model_profile: "auto".into(),
                provider_route: None,
                worktree_id: Some("wt_isolated".into()),
                turn_id: None,
                context_pack_id: None,
                at: T2.into(),
            },
        )
        .expect("start writer attempt");
    let running = store
        .transition_agent_attempt(
            "grf_worktree",
            "agt_writer",
            "att_proposal",
            &AgentAttemptTransition {
                expected_graph_revision: attempt.graph.revision,
                expected_node_revision: 3,
                state: AgentAttemptState::Running,
                at: T2.into(),
                result_claim: None,
                verified_result: None,
                error: None,
                usage: None,
            },
        )
        .expect("run writer attempt");
    let completed = store
        .transition_agent_attempt(
            "grf_worktree",
            "agt_writer",
            "att_proposal",
            &AgentAttemptTransition {
                expected_graph_revision: running.graph.revision,
                expected_node_revision: 4,
                state: AgentAttemptState::Completed,
                at: T3.into(),
                result_claim: Some(json!({ "summary": "changed one file" })),
                verified_result: Some(json!({ "verified": true })),
                error: None,
                usage: Some(json!({ "inputTokens": 1 })),
            },
        )
        .expect("complete writer attempt");
    assert_eq!(completed.value.state, AgentAttemptState::Completed);

    store
        .upsert_evidence(&DurableEvidenceInput {
            id: "evidence-proposal".into(),
            workspace_identity_digest: "workspace-fingerprint".into(),
            session_id: Some("ses_worktree".into()),
            turn_id: None,
            agent_id: Some("agt_writer".into()),
            task_id: None,
            worktree_id: Some("wt_isolated".into()),
            kind: "process_exit".into(),
            source: "runtime.process".into(),
            digest: "c".repeat(64),
            exact: true,
            freshness: EvidenceFreshness::Fresh,
            observed_at: T3.into(),
            expires_at: Some(T7.into()),
            summary: "worktree verification command exited successfully".into(),
            path_bindings: vec![EvidencePathBinding {
                path: "src/lib.rs".into(),
                revision_token: Some("rev-2".into()),
            }],
            artifact_ids: vec![],
        })
        .expect("record runtime evidence");

    let proposal_input = WorktreeProposalCreate {
        id: "prp_valid".into(),
        expected_worktree_revision: writer.worktree.revision,
        writer_lease_id: "wls_one".into(),
        expected_owner_epoch: 1,
        graph_id: "grf_worktree".into(),
        node_id: "agt_writer".into(),
        attempt_id: "att_proposal".into(),
        payload: WorktreeProposalPayload {
            changed_files: vec![WorktreeChangedFile {
                path: "src/lib.rs".into(),
                kind: WorktreeChangeKind::Modify,
                old_path: None,
                base_revision: Some("rev-1".into()),
                post_revision: Some("rev-2".into()),
                additions: 2,
                deletions: 1,
            }],
            diff_artifact_id: "art_diff".into(),
            file_manifest_artifact_id: "art_manifest".into(),
            verification_evidence_ids: vec!["evidence-proposal".into()],
            diagnostics_evidence_ids: vec![],
            open_risks: vec![],
        },
        created_at: T3.into(),
    };

    let mut out_of_scope = proposal_input.clone();
    out_of_scope.id = "prp_outside".into();
    out_of_scope.payload.changed_files[0].path = "README.md".into();
    let scope_error = store
        .create_worktree_proposal("wt_isolated", &out_of_scope)
        .expect_err("proposal cannot escape the writer's allowed paths");
    assert!(matches!(scope_error, StoreError::InvalidWorktree { .. }));

    let published = store
        .create_worktree_proposal("wt_isolated", &proposal_input)
        .expect("publish proposal");
    assert_eq!(published.worktree.state, WorktreeState::ProposalReady);
    assert_eq!(published.worktree.revision, 4);
    assert_eq!(published.value.state.label(), "ready");
    assert!(published.value.proposal_digest.starts_with("sha256:"));
    assert!(store
        .active_worktree_writer_lease("wt_isolated")
        .expect("lookup writer")
        .is_none());

    let replay = store
        .create_worktree_proposal("wt_isolated", &proposal_input)
        .expect("same proposal is idempotent");
    assert_eq!(replay.value, published.value);
    assert_eq!(
        store
            .worktree_proposals("wt_isolated")
            .expect("list proposals")
            .len(),
        1
    );
    let merge = store
        .begin_merge_attempt(&MergeAttemptCreate {
            id: "mrg_one".into(),
            workspace_identity_digest: "workspace-fingerprint".into(),
            graph_id: Some("grf_worktree".into()),
            proposal_ids: vec!["prp_valid".into()],
            base_workspace_revision: "base-r1".into(),
            conflict_policy: MergeConflictPolicy::Manual,
            created_at: T4.into(),
        })
        .expect("select proposal for a fenced merge");
    assert_eq!(merge.state, MergeAttemptState::Prepared);
    assert_eq!(merge.proposal_ids, vec!["prp_valid"]);
    assert_eq!(
        store
            .worktree("wt_isolated")
            .expect("read worktree")
            .expect("worktree")
            .state,
        WorktreeState::Merging
    );
    let merge_replay = store
        .begin_merge_attempt(&MergeAttemptCreate {
            id: "mrg_one".into(),
            workspace_identity_digest: "workspace-fingerprint".into(),
            graph_id: Some("grf_worktree".into()),
            proposal_ids: vec!["prp_valid".into()],
            base_workspace_revision: "base-r1".into(),
            conflict_policy: MergeConflictPolicy::Manual,
            created_at: T4.into(),
        })
        .expect("same merge request is idempotent");
    assert_eq!(merge_replay, merge);
}
