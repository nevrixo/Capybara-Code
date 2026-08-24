//! Durable worktree isolation and writer-lease coordination.
//!
//! This module owns metadata only. Creating/removing a real Git worktree still
//! goes through a capability-bound runtime backend. The stored lease prevents
//! two writer agents from receiving authority over the same mutable tree.

use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{SessionStore, StoreError};

pub const MAX_WORKTREE_ALLOWED_PATHS: usize = 512;
pub const MAX_WORKTREE_BASELINE_REVISIONS: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeState {
    Creating,
    Ready,
    Leased,
    Dirty,
    ProposalReady,
    Merging,
    Merged,
    Conflicted,
    Abandoned,
    Deleting,
    Deleted,
    RecoveryRequired,
}

impl WorktreeState {
    fn label(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Ready => "ready",
            Self::Leased => "leased",
            Self::Dirty => "dirty",
            Self::ProposalReady => "proposal_ready",
            Self::Merging => "merging",
            Self::Merged => "merged",
            Self::Conflicted => "conflicted",
            Self::Abandoned => "abandoned",
            Self::Deleting => "deleting",
            Self::Deleted => "deleted",
            Self::RecoveryRequired => "recovery_required",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "creating" => Ok(Self::Creating),
            "ready" => Ok(Self::Ready),
            "leased" => Ok(Self::Leased),
            "dirty" => Ok(Self::Dirty),
            "proposal_ready" => Ok(Self::ProposalReady),
            "merging" => Ok(Self::Merging),
            "merged" => Ok(Self::Merged),
            "conflicted" => Ok(Self::Conflicted),
            "abandoned" => Ok(Self::Abandoned),
            "deleting" => Ok(Self::Deleting),
            "deleted" => Ok(Self::Deleted),
            "recovery_required" => Ok(Self::RecoveryRequired),
            _ => Err(invalid(format!("unsupported worktree state: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeWriterLeaseState {
    Active,
    Released,
    Expired,
    Revoked,
}

impl WorktreeWriterLeaseState {
    fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Released => "released",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "active" => Ok(Self::Active),
            "released" => Ok(Self::Released),
            "expired" => Ok(Self::Expired),
            "revoked" => Ok(Self::Revoked),
            _ => Err(invalid(format!(
                "unsupported worktree writer lease state: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreate {
    pub id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// Managed relative path only: worktrees/<workspace>/<worktree>/repo.
    pub path: String,
    pub base_commit: String,
    pub base_workspace_revision: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub path: String,
    pub state: WorktreeState,
    pub base_commit: String,
    pub base_workspace_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writer_lease_id: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeTransition {
    pub expected_revision: i64,
    pub state: WorktreeState,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeWriterLeaseInput {
    pub id: String,
    pub node_id: String,
    pub owner_epoch: i64,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    pub baseline_revisions: serde_json::Value,
    pub acquired_at: String,
    pub heartbeat_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeWriterLeaseRecord {
    pub id: String,
    pub worktree_id: String,
    pub node_id: String,
    pub owner_epoch: i64,
    pub allowed_paths: Vec<String>,
    pub baseline_revisions: serde_json::Value,
    pub state: WorktreeWriterLeaseState,
    pub acquired_at: String,
    pub heartbeat_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMutation<T> {
    pub worktree: WorktreeRecord,
    pub value: T,
}

pub const MAX_WORKTREE_PROPOSAL_FILES: usize = 512;
pub const MAX_WORKTREE_PROPOSAL_EVIDENCE: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeChangeKind {
    Create,
    Modify,
    Delete,
    Rename,
}

impl WorktreeChangeKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Modify => "modify",
            Self::Delete => "delete",
            Self::Rename => "rename",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChangedFile {
    pub path: String,
    pub kind: WorktreeChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_revision: Option<String>,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProposalPayload {
    pub changed_files: Vec<WorktreeChangedFile>,
    pub diff_artifact_id: String,
    pub file_manifest_artifact_id: String,
    #[serde(default)]
    pub verification_evidence_ids: Vec<String>,
    #[serde(default)]
    pub diagnostics_evidence_ids: Vec<String>,
    #[serde(default)]
    pub open_risks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProposalCreate {
    pub id: String,
    pub expected_worktree_revision: i64,
    pub writer_lease_id: String,
    pub expected_owner_epoch: i64,
    pub graph_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub payload: WorktreeProposalPayload,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeProposalState {
    Ready,
    Selected,
    Merging,
    Merged,
    Conflicted,
    Rejected,
    Superseded,
}

impl WorktreeProposalState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Selected => "selected",
            Self::Merging => "merging",
            Self::Merged => "merged",
            Self::Conflicted => "conflicted",
            Self::Rejected => "rejected",
            Self::Superseded => "superseded",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "ready" => Ok(Self::Ready),
            "selected" => Ok(Self::Selected),
            "merging" => Ok(Self::Merging),
            "merged" => Ok(Self::Merged),
            "conflicted" => Ok(Self::Conflicted),
            "rejected" => Ok(Self::Rejected),
            "superseded" => Ok(Self::Superseded),
            _ => Err(invalid(format!(
                "unsupported worktree proposal state: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProposalRecord {
    pub id: String,
    pub worktree_id: String,
    pub graph_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub base_commit: String,
    pub base_workspace_revision: String,
    pub worktree_revision: i64,
    pub proposal_digest: String,
    pub payload: WorktreeProposalPayload,
    pub state: WorktreeProposalState,
    pub created_at: String,
}

pub const MAX_MERGE_PROPOSALS: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeConflictPolicy {
    Fail,
    Manual,
}

impl MergeConflictPolicy {
    pub fn label(self) -> &'static str {
        match self {
            Self::Fail => "fail",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeAttemptState {
    Prepared,
    Applying,
    Merged,
    Conflicted,
    Failed,
    Cancelled,
}

impl MergeAttemptState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Applying => "applying",
            Self::Merged => "merged",
            Self::Conflicted => "conflicted",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "prepared" => Ok(Self::Prepared),
            "applying" => Ok(Self::Applying),
            "merged" => Ok(Self::Merged),
            "conflicted" => Ok(Self::Conflicted),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(invalid(format!("unsupported merge attempt state: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeAttemptCreate {
    pub id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_id: Option<String>,
    pub proposal_ids: Vec<String>,
    pub base_workspace_revision: String,
    pub conflict_policy: MergeConflictPolicy,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeAttemptRecord {
    pub id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_id: Option<String>,
    pub proposal_ids: Vec<String>,
    pub base_workspace_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_workspace_revision_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    pub state: MergeAttemptState,
    pub conflict_policy: MergeConflictPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}
impl SessionStore {
    /// Register a generated worktree record. Filesystem creation is deliberately
    /// separate, so a crash between registration and Git worktree add can be
    /// recovered as a visible "creating" record rather than hidden state.
    pub fn create_worktree(
        &mut self,
        input: &WorktreeCreate,
    ) -> Result<WorktreeRecord, StoreError> {
        validate_worktree_create(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_graph_node_binding(
            &tx,
            &input.workspace_identity_digest,
            input.graph_id.as_deref(),
            input.node_id.as_deref(),
        )?;
        tx.execute(
            "INSERT INTO worktrees (
                id, workspace_identity_digest, graph_id, node_id, path, state, base_commit,
                base_workspace_revision, head_commit, dirty_digest, owner_node_id,
                writer_lease_id, revision, created_at, updated_at, expires_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, 'creating', ?6, ?7, NULL, NULL, NULL, NULL, 1, ?8, ?8, ?9
             )",
            params![
                input.id,
                input.workspace_identity_digest,
                input.graph_id,
                input.node_id,
                input.path,
                input.base_commit,
                input.base_workspace_revision,
                input.created_at,
                input.expires_at,
            ],
        )?;
        let record = WorktreeRecord {
            id: input.id.clone(),
            workspace_identity_digest: input.workspace_identity_digest.clone(),
            graph_id: input.graph_id.clone(),
            node_id: input.node_id.clone(),
            path: input.path.clone(),
            state: WorktreeState::Creating,
            base_commit: input.base_commit.clone(),
            base_workspace_revision: input.base_workspace_revision.clone(),
            head_commit: None,
            dirty_digest: None,
            owner_node_id: None,
            writer_lease_id: None,
            revision: 1,
            created_at: input.created_at.clone(),
            updated_at: input.created_at.clone(),
            expires_at: input.expires_at.clone(),
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn worktree(&self, worktree_id: &str) -> Result<Option<WorktreeRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        self.conn
            .query_row(
                "SELECT id, workspace_identity_digest, graph_id, node_id, path, state,
                        base_commit, base_workspace_revision, head_commit, dirty_digest,
                        owner_node_id, writer_lease_id, revision, created_at, updated_at, expires_at
                 FROM worktrees WHERE id = ?1",
                params![worktree_id],
                read_worktree,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn worktrees_for_workspace(
        &self,
        workspace_identity_digest: &str,
    ) -> Result<Vec<WorktreeRecord>, StoreError> {
        validate_bounded_text(
            "workspaceIdentityDigest",
            workspace_identity_digest,
            MAX_WORKTREE_IDENTIFIER_BYTES,
        )?;
        let mut statement = self.conn.prepare(
            "SELECT id, workspace_identity_digest, graph_id, node_id, path, state,
                    base_commit, base_workspace_revision, head_commit, dirty_digest,
                    owner_node_id, writer_lease_id, revision, created_at, updated_at, expires_at
             FROM worktrees WHERE workspace_identity_digest = ?1
             ORDER BY updated_at DESC, id ASC",
        )?;
        let rows = statement.query_map(params![workspace_identity_digest], read_worktree)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Advance lifecycle metadata with a revision CAS. Acquiring/releasing a
    /// writer lease uses dedicated methods; generic transitions cannot synthesize
    /// a leased state or bypass an active writer.
    pub fn transition_worktree(
        &mut self,
        worktree_id: &str,
        transition: &WorktreeTransition,
    ) -> Result<WorktreeRecord, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        validate_worktree_transition(transition)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worktree = require_worktree(&tx, worktree_id)?;
        ensure_worktree_revision(&worktree, transition.expected_revision)?;
        if transition.state == WorktreeState::Leased {
            return Err(invalid(
                "only a writer lease acquisition can enter leased state",
            ));
        }
        if worktree.writer_lease_id.is_some() {
            return Err(invalid(
                "cannot transition a worktree while an active writer lease is attached",
            ));
        }
        if !worktree_transition_allowed(worktree.state, transition.state) {
            return Err(invalid(format!(
                "invalid worktree transition {} -> {}",
                worktree.state.label(),
                transition.state.label()
            )));
        }
        let revision = next_worktree_revision(&worktree)?;
        let changed = tx.execute(
            "UPDATE worktrees
             SET state = ?2, head_commit = ?3, dirty_digest = ?4, expires_at = ?5,
                 revision = ?6, updated_at = ?7
             WHERE id = ?1 AND revision = ?8",
            params![
                worktree_id,
                transition.state.label(),
                transition.head_commit,
                transition.dirty_digest,
                transition.expires_at,
                revision,
                transition.at,
                worktree.revision,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::WorktreeRevisionConflict {
                worktree_id: worktree_id.into(),
                expected: transition.expected_revision,
                actual: worktree_revision(&tx, worktree_id)?,
            });
        }
        let record = WorktreeRecord {
            state: transition.state,
            head_commit: transition.head_commit.clone(),
            dirty_digest: transition.dirty_digest.clone(),
            expires_at: transition.expires_at.clone(),
            revision,
            updated_at: transition.at.clone(),
            ..worktree
        };
        tx.commit()?;
        Ok(record)
    }
}

impl SessionStore {
    /// Grant the sole writer lease. Expiry alone never releases an active lease:
    /// a recovery coordinator must explicitly reconcile it before another node can
    /// write, preventing silent two-writer admission after a stalled process.
    pub fn acquire_worktree_writer_lease(
        &mut self,
        worktree_id: &str,
        expected_worktree_revision: i64,
        input: &WorktreeWriterLeaseInput,
    ) -> Result<WorktreeMutation<WorktreeWriterLeaseRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        validate_writer_lease_input(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worktree = require_worktree(&tx, worktree_id)?;
        ensure_worktree_revision(&worktree, expected_worktree_revision)?;
        if let Some(active) = active_writer_lease_in_tx(&tx, worktree_id)? {
            return Err(StoreError::WorktreeWriterLeaseConflict {
                worktree_id: worktree_id.into(),
                active_lease_id: active.id,
                state: active.state.label().into(),
            });
        }
        if worktree.writer_lease_id.is_some() {
            return Err(invalid(
                "worktree has a dangling writer lease attachment and requires recovery",
            ));
        }
        if !matches!(worktree.state, WorktreeState::Ready | WorktreeState::Dirty) {
            return Err(invalid("writer lease requires a ready or dirty worktree"));
        }
        ensure_writer_lease_within_worktree_lifetime(
            &worktree,
            &input.acquired_at,
            &input.expires_at,
        )?;
        ensure_writer_node_binding(&tx, &worktree, &input.node_id)?;
        let previous_epoch: Option<i64> = tx.query_row(
            "SELECT MAX(owner_epoch) FROM worktree_leases WHERE worktree_id = ?1",
            params![worktree_id],
            |row| row.get(0),
        )?;
        let expected_epoch = previous_epoch
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| invalid(format!("writer epoch overflow for worktree {worktree_id}")))?;
        if input.owner_epoch != expected_epoch {
            return Err(StoreError::WorktreeWriterEpochConflict {
                worktree_id: worktree_id.into(),
                expected: expected_epoch,
                actual: previous_epoch,
            });
        }
        tx.execute(
            "INSERT INTO worktree_leases (
                id, worktree_id, node_id, owner_epoch, allowed_paths_json,
                baseline_revisions_json, state, acquired_at, heartbeat_at, expires_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9)",
            params![
                input.id,
                worktree_id,
                input.node_id,
                input.owner_epoch,
                serde_json::to_string(&sorted_allowed_paths(&input.allowed_paths))?,
                serde_json::to_string(&input.baseline_revisions)?,
                input.acquired_at,
                input.heartbeat_at,
                input.expires_at,
            ],
        )?;
        let revision = next_worktree_revision(&worktree)?;
        let changed = tx.execute(
            "UPDATE worktrees
             SET state = 'leased', owner_node_id = ?2, writer_lease_id = ?3,
                 revision = ?4, updated_at = ?5
             WHERE id = ?1 AND revision = ?6",
            params![
                worktree_id,
                input.node_id,
                input.id,
                revision,
                input.acquired_at,
                worktree.revision,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::WorktreeRevisionConflict {
                worktree_id: worktree_id.into(),
                expected: expected_worktree_revision,
                actual: worktree_revision(&tx, worktree_id)?,
            });
        }
        let worktree = WorktreeRecord {
            state: WorktreeState::Leased,
            owner_node_id: Some(input.node_id.clone()),
            writer_lease_id: Some(input.id.clone()),
            revision,
            updated_at: input.acquired_at.clone(),
            ..worktree
        };
        let lease = WorktreeWriterLeaseRecord {
            id: input.id.clone(),
            worktree_id: worktree_id.into(),
            node_id: input.node_id.clone(),
            owner_epoch: input.owner_epoch,
            allowed_paths: sorted_allowed_paths(&input.allowed_paths),
            baseline_revisions: input.baseline_revisions.clone(),
            state: WorktreeWriterLeaseState::Active,
            acquired_at: input.acquired_at.clone(),
            heartbeat_at: input.heartbeat_at.clone(),
            expires_at: input.expires_at.clone(),
        };
        tx.commit()?;
        Ok(WorktreeMutation {
            worktree,
            value: lease,
        })
    }

    pub fn active_worktree_writer_lease(
        &self,
        worktree_id: &str,
    ) -> Result<Option<WorktreeWriterLeaseRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        self.conn
            .query_row(
                "SELECT id, worktree_id, node_id, owner_epoch, allowed_paths_json,
                        baseline_revisions_json, state, acquired_at, heartbeat_at, expires_at
                 FROM worktree_leases WHERE worktree_id = ?1 AND state = 'active'",
                params![worktree_id],
                read_writer_lease,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn worktree_writer_leases(
        &self,
        worktree_id: &str,
    ) -> Result<Vec<WorktreeWriterLeaseRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        let mut statement = self.conn.prepare(
            "SELECT id, worktree_id, node_id, owner_epoch, allowed_paths_json,
                    baseline_revisions_json, state, acquired_at, heartbeat_at, expires_at
             FROM worktree_leases WHERE worktree_id = ?1
             ORDER BY owner_epoch ASC, id ASC",
        )?;
        let rows = statement.query_map(params![worktree_id], read_writer_lease)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

impl SessionStore {
    pub fn release_worktree_writer_lease(
        &mut self,
        worktree_id: &str,
        expected_worktree_revision: i64,
        lease_id: &str,
        expected_owner_epoch: i64,
        next_state: WorktreeState,
        at: &str,
    ) -> Result<WorktreeMutation<WorktreeWriterLeaseRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        validate_identifier("leaseId", lease_id, "wls_")?;
        validate_timestamp("at", at)?;
        validate_release_state(next_state)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worktree = require_worktree(&tx, worktree_id)?;
        ensure_worktree_revision(&worktree, expected_worktree_revision)?;
        let lease = require_active_writer_lease(&tx, worktree_id)?;
        ensure_writer_lease_identity(&lease, lease_id, expected_owner_epoch)?;
        ensure_worktree_writer_attachment(&worktree, &lease)?;
        if at < lease.heartbeat_at.as_str() {
            return Err(invalid("writer lease release time must not move backward"));
        }
        if lease.expires_at.as_str() <= at {
            return Err(invalid(
                "expired writer lease must be reconciled, not released",
            ));
        }
        let revision = next_worktree_revision(&worktree)?;
        tx.execute(
            "UPDATE worktree_leases
             SET state = 'released', heartbeat_at = ?2, expires_at = ?2
             WHERE id = ?1 AND state = 'active'",
            params![lease_id, at],
        )?;
        let changed = tx.execute(
            "UPDATE worktrees
             SET state = ?2, owner_node_id = NULL, writer_lease_id = NULL,
                 revision = ?3, updated_at = ?4
             WHERE id = ?1 AND revision = ?5",
            params![
                worktree_id,
                next_state.label(),
                revision,
                at,
                worktree.revision
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::WorktreeRevisionConflict {
                worktree_id: worktree_id.into(),
                expected: expected_worktree_revision,
                actual: worktree_revision(&tx, worktree_id)?,
            });
        }
        let worktree = WorktreeRecord {
            state: next_state,
            owner_node_id: None,
            writer_lease_id: None,
            revision,
            updated_at: at.into(),
            ..worktree
        };
        let lease = WorktreeWriterLeaseRecord {
            state: WorktreeWriterLeaseState::Released,
            heartbeat_at: at.into(),
            expires_at: at.into(),
            ..lease
        };
        tx.commit()?;
        Ok(WorktreeMutation {
            worktree,
            value: lease,
        })
    }

    /// Mark an actually expired writer lease for recovery. This deliberately does
    /// not grant a replacement; callers must inspect/reconcile the old attempt
    /// and then acquire a new increasing epoch in a separate command.
    pub fn reconcile_expired_worktree_writer_lease(
        &mut self,
        worktree_id: &str,
        expected_worktree_revision: i64,
        lease_id: &str,
        expected_owner_epoch: i64,
        now: &str,
    ) -> Result<WorktreeMutation<WorktreeWriterLeaseRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        validate_identifier("leaseId", lease_id, "wls_")?;
        validate_timestamp("now", now)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worktree = require_worktree(&tx, worktree_id)?;
        ensure_worktree_revision(&worktree, expected_worktree_revision)?;
        let lease = require_active_writer_lease(&tx, worktree_id)?;
        ensure_writer_lease_identity(&lease, lease_id, expected_owner_epoch)?;
        ensure_worktree_writer_attachment(&worktree, &lease)?;
        if lease.expires_at.as_str() > now {
            return Err(invalid(
                "writer lease has not expired and cannot be reconciled yet",
            ));
        }
        let revision = next_worktree_revision(&worktree)?;
        tx.execute(
            "UPDATE worktree_leases SET state = 'expired', heartbeat_at = ?2
             WHERE id = ?1 AND state = 'active'",
            params![lease_id, now],
        )?;
        let changed = tx.execute(
            "UPDATE worktrees
             SET state = 'recovery_required', owner_node_id = NULL, writer_lease_id = NULL,
                 revision = ?2, updated_at = ?3
             WHERE id = ?1 AND revision = ?4",
            params![worktree_id, revision, now, worktree.revision],
        )?;
        if changed != 1 {
            return Err(StoreError::WorktreeRevisionConflict {
                worktree_id: worktree_id.into(),
                expected: expected_worktree_revision,
                actual: worktree_revision(&tx, worktree_id)?,
            });
        }
        let worktree = WorktreeRecord {
            state: WorktreeState::RecoveryRequired,
            owner_node_id: None,
            writer_lease_id: None,
            revision,
            updated_at: now.into(),
            ..worktree
        };
        let lease = WorktreeWriterLeaseRecord {
            state: WorktreeWriterLeaseState::Expired,
            heartbeat_at: now.into(),
            ..lease
        };
        tx.commit()?;
        Ok(WorktreeMutation {
            worktree,
            value: lease,
        })
    }
}

impl SessionStore {
    pub fn renew_worktree_writer_lease(
        &mut self,
        worktree_id: &str,
        expected_worktree_revision: i64,
        lease_id: &str,
        expected_owner_epoch: i64,
        at: &str,
        expires_at: &str,
    ) -> Result<WorktreeMutation<WorktreeWriterLeaseRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        validate_identifier("leaseId", lease_id, "wls_")?;
        validate_timestamp("at", at)?;
        validate_timestamp("expiresAt", expires_at)?;
        if expires_at <= at {
            return Err(invalid("writer lease expiresAt must be later than at"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worktree = require_worktree(&tx, worktree_id)?;
        ensure_worktree_revision(&worktree, expected_worktree_revision)?;
        let lease = require_active_writer_lease(&tx, worktree_id)?;
        ensure_writer_lease_identity(&lease, lease_id, expected_owner_epoch)?;
        ensure_worktree_writer_attachment(&worktree, &lease)?;
        if lease.expires_at.as_str() <= at {
            return Err(invalid(
                "expired writer lease must be reconciled, not renewed",
            ));
        }
        if at < lease.heartbeat_at.as_str() {
            return Err(invalid("writer lease heartbeat must not move backward"));
        }
        ensure_writer_lease_within_worktree_lifetime(&worktree, at, expires_at)?;
        let revision = next_worktree_revision(&worktree)?;
        tx.execute(
            "UPDATE worktree_leases SET heartbeat_at = ?2, expires_at = ?3
             WHERE id = ?1 AND state = 'active'",
            params![lease_id, at, expires_at],
        )?;
        let changed = tx.execute(
            "UPDATE worktrees SET revision = ?2, updated_at = ?3
             WHERE id = ?1 AND revision = ?4",
            params![worktree_id, revision, at, worktree.revision],
        )?;
        if changed != 1 {
            return Err(StoreError::WorktreeRevisionConflict {
                worktree_id: worktree_id.into(),
                expected: expected_worktree_revision,
                actual: worktree_revision(&tx, worktree_id)?,
            });
        }
        let worktree = WorktreeRecord {
            revision,
            updated_at: at.into(),
            ..worktree
        };
        let lease = WorktreeWriterLeaseRecord {
            heartbeat_at: at.into(),
            expires_at: expires_at.into(),
            ..lease
        };
        tx.commit()?;
        Ok(WorktreeMutation {
            worktree,
            value: lease,
        })
    }
}

const MAX_WORKTREE_IDENTIFIER_BYTES: usize = 256;

fn invalid(detail: impl Into<String>) -> StoreError {
    StoreError::InvalidWorktree {
        detail: detail.into(),
    }
}

fn validate_worktree_create(input: &WorktreeCreate) -> Result<(), StoreError> {
    validate_identifier("worktreeId", &input.id, "wt_")?;
    validate_workspace_identity(&input.workspace_identity_digest)?;
    if let Some(graph_id) = &input.graph_id {
        validate_identifier("graphId", graph_id, "grf_")?;
    }
    match (&input.graph_id, &input.node_id) {
        (None, Some(_)) => return Err(invalid("nodeId requires graphId")),
        (_, Some(node_id)) => validate_identifier("nodeId", node_id, "agt_")?,
        _ => {}
    }
    validate_managed_path(&input.path, &input.workspace_identity_digest, &input.id)?;
    validate_git_commit("baseCommit", &input.base_commit)?;
    validate_bounded_text(
        "baseWorkspaceRevision",
        &input.base_workspace_revision,
        MAX_WORKTREE_IDENTIFIER_BYTES,
    )?;
    validate_timestamp("createdAt", &input.created_at)?;
    if let Some(expires_at) = &input.expires_at {
        validate_timestamp("expiresAt", expires_at)?;
        if expires_at <= &input.created_at {
            return Err(invalid("expiresAt must be later than createdAt"));
        }
    }
    Ok(())
}

fn validate_worktree_transition(transition: &WorktreeTransition) -> Result<(), StoreError> {
    if transition.expected_revision < 1 {
        return Err(invalid("expectedRevision must be positive"));
    }
    validate_timestamp("at", &transition.at)?;
    if let Some(head_commit) = &transition.head_commit {
        validate_git_commit("headCommit", head_commit)?;
    }
    if let Some(dirty_digest) = &transition.dirty_digest {
        validate_bounded_text("dirtyDigest", dirty_digest, MAX_WORKTREE_IDENTIFIER_BYTES)?;
    }
    if let Some(expires_at) = &transition.expires_at {
        validate_timestamp("expiresAt", expires_at)?;
        if expires_at <= &transition.at {
            return Err(invalid("expiresAt must be later than transition at"));
        }
    }
    Ok(())
}

fn validate_writer_lease_input(input: &WorktreeWriterLeaseInput) -> Result<(), StoreError> {
    validate_identifier("leaseId", &input.id, "wls_")?;
    validate_identifier("nodeId", &input.node_id, "agt_")?;
    if input.owner_epoch < 1 {
        return Err(invalid("ownerEpoch must be positive"));
    }
    validate_timestamp("acquiredAt", &input.acquired_at)?;
    validate_timestamp("heartbeatAt", &input.heartbeat_at)?;
    validate_timestamp("expiresAt", &input.expires_at)?;
    if input.heartbeat_at < input.acquired_at {
        return Err(invalid("heartbeatAt must not precede acquiredAt"));
    }
    if input.expires_at <= input.heartbeat_at {
        return Err(invalid("expiresAt must be later than heartbeatAt"));
    }
    if input.allowed_paths.is_empty() || input.allowed_paths.len() > MAX_WORKTREE_ALLOWED_PATHS {
        return Err(invalid(format!(
            "allowedPaths must contain 1..={MAX_WORKTREE_ALLOWED_PATHS} canonical paths"
        )));
    }
    let unique = sorted_allowed_paths(&input.allowed_paths);
    if unique.len() != input.allowed_paths.len() {
        return Err(invalid("allowedPaths must not contain duplicates"));
    }
    for path in &unique {
        validate_repository_path(path)?;
    }
    validate_baseline_revisions(&input.baseline_revisions, &unique)
}

fn validate_baseline_revisions(
    value: &serde_json::Value,
    allowed_paths: &[String],
) -> Result<(), StoreError> {
    let Some(map) = value.as_object() else {
        return Err(invalid("baselineRevisions must be a JSON object"));
    };
    if map.len() > MAX_WORKTREE_BASELINE_REVISIONS {
        return Err(invalid(format!(
            "baselineRevisions exceeds {MAX_WORKTREE_BASELINE_REVISIONS} entries"
        )));
    }
    for (path, revision) in map {
        validate_repository_path(path)?;
        let Some(revision) = revision.as_str() else {
            return Err(invalid("baseline revision values must be strings"));
        };
        validate_bounded_text("baselineRevision", revision, MAX_WORKTREE_IDENTIFIER_BYTES)?;
        let covered = allowed_paths.iter().any(|allowed| {
            allowed == "." || path == allowed || path.starts_with(&format!("{allowed}/"))
        });
        if !covered {
            return Err(invalid(
                "baselineRevisions path must be covered by allowedPaths",
            ));
        }
    }
    Ok(())
}

fn validate_release_state(state: WorktreeState) -> Result<(), StoreError> {
    if matches!(
        state,
        WorktreeState::Ready
            | WorktreeState::Dirty
            | WorktreeState::ProposalReady
            | WorktreeState::RecoveryRequired
            | WorktreeState::Abandoned
    ) {
        Ok(())
    } else {
        Err(invalid(
            "writer lease release must select ready, dirty, proposal_ready, recovery_required, or abandoned",
        ))
    }
}

fn validate_identifier(field: &str, value: &str, prefix: &str) -> Result<(), StoreError> {
    if !value.starts_with(prefix)
        || value.len() <= prefix.len()
        || value.len() > MAX_WORKTREE_IDENTIFIER_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!(
            "{field} must be a bounded identifier beginning with {prefix}"
        )));
    }
    Ok(())
}

fn validate_workspace_identity(value: &str) -> Result<(), StoreError> {
    validate_bounded_text(
        "workspaceIdentityDigest",
        value,
        MAX_WORKTREE_IDENTIFIER_BYTES,
    )?;
    if value.contains('/') || value.contains('\\') || value.contains(':') {
        return Err(invalid(
            "workspaceIdentityDigest cannot contain path separator characters",
        ));
    }
    Ok(())
}

fn validate_bounded_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{field} must be bounded non-empty text")));
    }
    if cbc_redaction::redact_patterns_only(value).report.redacted() {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds"
        )));
    }
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ];
    if separators
        .iter()
        .any(|(index, expected)| bytes[*index] != *expected)
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds"
        )));
    }
    let year = decimal_component(bytes, 0, 4);
    let month = decimal_component(bytes, 5, 7);
    let day = decimal_component(bytes, 8, 10);
    let hour = decimal_component(bytes, 11, 13);
    let minute = decimal_component(bytes, 14, 16);
    let second = decimal_component(bytes, 17, 19);
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(invalid(format!(
            "{field} must be a valid canonical RFC 3339 UTC timestamp"
        )));
    }
    Ok(())
}

fn validate_managed_path(
    path: &str,
    workspace_identity_digest: &str,
    worktree_id: &str,
) -> Result<(), StoreError> {
    let expected = format!("worktrees/{workspace_identity_digest}/{worktree_id}/repo");
    if path != expected {
        return Err(invalid(
            "worktree path must be the generated managed relative repository path",
        ));
    }
    Ok(())
}

fn validate_git_commit(field: &str, value: &str) -> Result<(), StoreError> {
    if !(40..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(format!(
            "{field} must be a 40..64 character Git hex commit"
        )));
    }
    Ok(())
}

fn validate_repository_path(path: &str) -> Result<(), StoreError> {
    if path.is_empty()
        || path.trim() != path
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.as_bytes().get(1) == Some(&b':')
    {
        return Err(invalid(format!(
            "path must be canonical workspace-relative: {path}"
        )));
    }
    if path == "." {
        return Ok(());
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid(format!(
            "path must be canonical workspace-relative: {path}"
        )));
    }
    Ok(())
}

fn sorted_allowed_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn decimal_component(bytes: &[u8], start: usize, end: usize) -> u32 {
    bytes[start..end]
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}
fn ensure_graph_node_binding(
    tx: &rusqlite::Transaction<'_>,
    workspace_identity_digest: &str,
    graph_id: Option<&str>,
    node_id: Option<&str>,
) -> Result<(), StoreError> {
    ensure_workspace_identity_known(tx, workspace_identity_digest)?;
    let Some(graph_id) = graph_id else {
        return Ok(());
    };
    let graph_workspace = tx
        .query_row(
            "SELECT workspace_identity_digest FROM agent_graphs WHERE id = ?1",
            params![graph_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("agent graph {graph_id}"),
        })?;
    if graph_workspace != workspace_identity_digest {
        return Err(invalid(
            "worktree workspaceIdentityDigest does not match its agent graph",
        ));
    }
    if let Some(node_id) = node_id {
        let node_graph = agent_node_graph(tx, node_id)?;
        if node_graph != graph_id {
            return Err(invalid("worktree nodeId does not belong to graphId"));
        }
    }
    Ok(())
}

fn ensure_workspace_identity_known(
    tx: &rusqlite::Transaction<'_>,
    workspace_identity_digest: &str,
) -> Result<(), StoreError> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM workspaces WHERE canonical_path_hash = ?1
        )",
        params![workspace_identity_digest],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StoreError::NotFound {
            what: format!("workspace {workspace_identity_digest}"),
        });
    }
    Ok(())
}

fn agent_node_graph(tx: &rusqlite::Transaction<'_>, node_id: &str) -> Result<String, StoreError> {
    tx.query_row(
        "SELECT graph_id FROM agent_nodes WHERE id = ?1",
        params![node_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| StoreError::NotFound {
        what: format!("agent node {node_id}"),
    })
}

fn ensure_writer_node_binding(
    tx: &rusqlite::Transaction<'_>,
    worktree: &WorktreeRecord,
    node_id: &str,
) -> Result<(), StoreError> {
    let node_graph = agent_node_graph(tx, node_id)?;
    let node_workspace = tx
        .query_row(
            "SELECT workspace_identity_digest FROM agent_graphs WHERE id = ?1",
            params![&node_graph],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("agent graph {node_graph}"),
        })?;
    if node_workspace != worktree.workspace_identity_digest {
        return Err(invalid(
            "writer node belongs to a graph for a different workspace",
        ));
    }
    if let Some(graph_id) = &worktree.graph_id {
        if node_graph != *graph_id {
            return Err(invalid("writer node does not belong to the worktree graph"));
        }
    }
    if let Some(owner_node_id) = &worktree.node_id {
        if owner_node_id != node_id {
            return Err(invalid(
                "writer node does not match the worktree's assigned node",
            ));
        }
    }
    Ok(())
}
fn require_worktree(
    tx: &rusqlite::Transaction<'_>,
    worktree_id: &str,
) -> Result<WorktreeRecord, StoreError> {
    tx.query_row(
        "SELECT id, workspace_identity_digest, graph_id, node_id, path, state,
                base_commit, base_workspace_revision, head_commit, dirty_digest,
                owner_node_id, writer_lease_id, revision, created_at, updated_at, expires_at
         FROM worktrees WHERE id = ?1",
        params![worktree_id],
        read_worktree,
    )
    .optional()?
    .ok_or_else(|| StoreError::NotFound {
        what: format!("worktree {worktree_id}"),
    })
}

fn ensure_worktree_revision(
    worktree: &WorktreeRecord,
    expected_revision: i64,
) -> Result<(), StoreError> {
    if expected_revision < 1 || worktree.revision != expected_revision {
        return Err(StoreError::WorktreeRevisionConflict {
            worktree_id: worktree.id.clone(),
            expected: expected_revision,
            actual: Some(worktree.revision),
        });
    }
    Ok(())
}

fn next_worktree_revision(worktree: &WorktreeRecord) -> Result<i64, StoreError> {
    worktree
        .revision
        .checked_add(1)
        .ok_or_else(|| invalid(format!("worktree {} revision overflow", worktree.id)))
}

fn worktree_revision(
    tx: &rusqlite::Transaction<'_>,
    worktree_id: &str,
) -> Result<Option<i64>, StoreError> {
    tx.query_row(
        "SELECT revision FROM worktrees WHERE id = ?1",
        params![worktree_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(StoreError::from)
}

fn active_writer_lease_in_tx(
    tx: &rusqlite::Transaction<'_>,
    worktree_id: &str,
) -> Result<Option<WorktreeWriterLeaseRecord>, StoreError> {
    tx.query_row(
        "SELECT id, worktree_id, node_id, owner_epoch, allowed_paths_json,
                baseline_revisions_json, state, acquired_at, heartbeat_at, expires_at
         FROM worktree_leases WHERE worktree_id = ?1 AND state = 'active'",
        params![worktree_id],
        read_writer_lease,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_active_writer_lease(
    tx: &rusqlite::Transaction<'_>,
    worktree_id: &str,
) -> Result<WorktreeWriterLeaseRecord, StoreError> {
    active_writer_lease_in_tx(tx, worktree_id)?.ok_or_else(|| StoreError::NotFound {
        what: format!("active writer lease for worktree {worktree_id}"),
    })
}

fn ensure_writer_lease_identity(
    lease: &WorktreeWriterLeaseRecord,
    lease_id: &str,
    expected_owner_epoch: i64,
) -> Result<(), StoreError> {
    if lease.id != lease_id {
        return Err(StoreError::WorktreeWriterLeaseConflict {
            worktree_id: lease.worktree_id.clone(),
            active_lease_id: lease.id.clone(),
            state: lease.state.label().into(),
        });
    }
    if expected_owner_epoch < 1 || lease.owner_epoch != expected_owner_epoch {
        return Err(StoreError::WorktreeWriterEpochConflict {
            worktree_id: lease.worktree_id.clone(),
            expected: expected_owner_epoch,
            actual: Some(lease.owner_epoch),
        });
    }
    Ok(())
}

fn ensure_worktree_writer_attachment(
    worktree: &WorktreeRecord,
    lease: &WorktreeWriterLeaseRecord,
) -> Result<(), StoreError> {
    if worktree.state != WorktreeState::Leased
        || worktree.writer_lease_id.as_deref() != Some(lease.id.as_str())
        || worktree.owner_node_id.as_deref() != Some(lease.node_id.as_str())
    {
        return Err(invalid(
            "worktree writer lease metadata is inconsistent and requires recovery",
        ));
    }
    Ok(())
}
fn worktree_transition_allowed(from: WorktreeState, to: WorktreeState) -> bool {
    use WorktreeState as State;
    match from {
        State::Creating => matches!(to, State::Ready | State::RecoveryRequired | State::Deleting),
        State::Ready => matches!(
            to,
            State::Dirty
                | State::ProposalReady
                | State::RecoveryRequired
                | State::Abandoned
                | State::Deleting
        ),
        State::Leased => false,
        State::Dirty => matches!(
            to,
            State::Ready
                | State::ProposalReady
                | State::RecoveryRequired
                | State::Abandoned
                | State::Deleting
        ),
        State::ProposalReady => matches!(
            to,
            State::Merging
                | State::Ready
                | State::Abandoned
                | State::RecoveryRequired
                | State::Deleting
        ),
        State::Merging => matches!(
            to,
            State::Merged | State::Conflicted | State::RecoveryRequired
        ),
        State::Conflicted => matches!(
            to,
            State::Merging | State::Abandoned | State::RecoveryRequired
        ),
        State::Abandoned => matches!(to, State::Deleting | State::RecoveryRequired),
        State::Deleting => matches!(to, State::Deleted | State::RecoveryRequired),
        State::RecoveryRequired => {
            matches!(to, State::Ready | State::Abandoned | State::Deleting)
        }
        State::Merged | State::Deleted => false,
    }
}

fn read_worktree(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorktreeRecord> {
    let raw_state: String = row.get(5)?;
    let state = WorktreeState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(WorktreeRecord {
        id: row.get(0)?,
        workspace_identity_digest: row.get(1)?,
        graph_id: row.get(2)?,
        node_id: row.get(3)?,
        path: row.get(4)?,
        state,
        base_commit: row.get(6)?,
        base_workspace_revision: row.get(7)?,
        head_commit: row.get(8)?,
        dirty_digest: row.get(9)?,
        owner_node_id: row.get(10)?,
        writer_lease_id: row.get(11)?,
        revision: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        expires_at: row.get(15)?,
    })
}

fn read_writer_lease(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorktreeWriterLeaseRecord> {
    let raw_state: String = row.get(6)?;
    let state = WorktreeWriterLeaseState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let allowed_paths = string_array_column(row.get(4)?, 4)?;
    let baseline_revisions = json_column(row.get(5)?, 5)?;
    Ok(WorktreeWriterLeaseRecord {
        id: row.get(0)?,
        worktree_id: row.get(1)?,
        node_id: row.get(2)?,
        owner_epoch: row.get(3)?,
        allowed_paths,
        baseline_revisions,
        state,
        acquired_at: row.get(7)?,
        heartbeat_at: row.get(8)?,
        expires_at: row.get(9)?,
    })
}

fn json_column(raw: String, index: usize) -> rusqlite::Result<serde_json::Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn string_array_column(raw: String, index: usize) -> rusqlite::Result<Vec<String>> {
    let value = json_column(raw, index)?;
    let Some(values) = value.as_array() else {
        return Err(invalid_sql_column(
            index,
            "worktree allowed paths JSON must be an array",
        ));
    };
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let Some(path) = value.as_str() else {
            return Err(invalid_sql_column(
                index,
                "worktree allowed paths JSON must contain strings",
            ));
        };
        result.push(path.into());
    }
    Ok(result)
}

fn invalid_sql_column(index: usize, detail: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(invalid(detail)),
    )
}
fn ensure_writer_lease_within_worktree_lifetime(
    worktree: &WorktreeRecord,
    acquired_at: &str,
    lease_expires_at: &str,
) -> Result<(), StoreError> {
    let Some(worktree_expires_at) = worktree.expires_at.as_deref() else {
        return Ok(());
    };
    if acquired_at >= worktree_expires_at {
        return Err(invalid(
            "writer lease cannot begin at or after the managed worktree expiry",
        ));
    }
    if lease_expires_at > worktree_expires_at {
        return Err(invalid(
            "writer lease cannot outlive the managed worktree expiry",
        ));
    }
    Ok(())
}
impl SessionStore {
    /// Publish a worktree result as a durable proposal. This atomically consumes
    /// the writer lease, records the proposal facts, and moves the worktree to
    /// proposal_ready; a stale writer cannot publish after its lease expires.
    pub fn create_worktree_proposal(
        &mut self,
        worktree_id: &str,
        input: &WorktreeProposalCreate,
    ) -> Result<WorktreeMutation<WorktreeProposalRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        validate_worktree_proposal_create(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) = worktree_proposal_in_tx(&tx, &input.id)? {
            ensure_proposal_replay(&existing, worktree_id, input)?;
            let worktree = require_worktree(&tx, worktree_id)?;
            tx.commit()?;
            return Ok(WorktreeMutation {
                worktree,
                value: existing,
            });
        }

        let worktree = require_worktree(&tx, worktree_id)?;
        ensure_worktree_revision(&worktree, input.expected_worktree_revision)?;
        if worktree.graph_id.as_deref() != Some(input.graph_id.as_str())
            || worktree.node_id.as_deref() != Some(input.node_id.as_str())
        {
            return Err(invalid(
                "proposal graphId and nodeId must match the assigned worktree owner",
            ));
        }
        let lease = require_active_writer_lease(&tx, worktree_id)?;
        ensure_writer_lease_identity(&lease, &input.writer_lease_id, input.expected_owner_epoch)?;
        ensure_worktree_writer_attachment(&worktree, &lease)?;
        if lease.node_id != input.node_id {
            return Err(invalid(
                "proposal nodeId must match the active writer lease",
            ));
        }
        if input.created_at < lease.heartbeat_at
            || input.created_at.as_str() >= lease.expires_at.as_str()
        {
            return Err(invalid(
                "proposal must be published by a live writer at or after its last heartbeat",
            ));
        }
        ensure_worktree_proposal_attempt(&tx, &worktree, input)?;
        validate_worktree_proposal_payload(&input.payload, &lease.allowed_paths)?;
        ensure_proposal_evidence(
            &tx,
            &worktree,
            &input.payload.verification_evidence_ids,
            &input.payload.diagnostics_evidence_ids,
            &input.created_at,
        )?;

        let proposal_digest = worktree_proposal_digest(&worktree, input)?;
        tx.execute(
            "INSERT INTO worktree_proposals (
                id, worktree_id, graph_id, node_id, attempt_id, base_commit,
                base_workspace_revision, worktree_revision, proposal_digest, proposal_json,
                status, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'ready', ?11)",
            params![
                input.id,
                worktree_id,
                input.graph_id,
                input.node_id,
                input.attempt_id,
                worktree.base_commit,
                worktree.base_workspace_revision,
                worktree.revision.to_string(),
                proposal_digest,
                serde_json::to_string(&input.payload)?,
                input.created_at,
            ],
        )?;
        let revision = next_worktree_revision(&worktree)?;
        let released = tx.execute(
            "UPDATE worktree_leases
             SET state = 'released', heartbeat_at = ?2, expires_at = ?2
             WHERE id = ?1 AND state = 'active'",
            params![input.writer_lease_id, input.created_at],
        )?;
        if released != 1 {
            return Err(invalid(
                "active writer lease changed while publishing proposal",
            ));
        }
        let changed = tx.execute(
            "UPDATE worktrees
             SET state = 'proposal_ready', owner_node_id = NULL, writer_lease_id = NULL,
                 revision = ?2, updated_at = ?3
             WHERE id = ?1 AND revision = ?4",
            params![worktree_id, revision, input.created_at, worktree.revision],
        )?;
        if changed != 1 {
            return Err(StoreError::WorktreeRevisionConflict {
                worktree_id: worktree_id.into(),
                expected: input.expected_worktree_revision,
                actual: worktree_revision(&tx, worktree_id)?,
            });
        }
        let proposal = WorktreeProposalRecord {
            id: input.id.clone(),
            worktree_id: worktree_id.into(),
            graph_id: input.graph_id.clone(),
            node_id: input.node_id.clone(),
            attempt_id: input.attempt_id.clone(),
            base_commit: worktree.base_commit.clone(),
            base_workspace_revision: worktree.base_workspace_revision.clone(),
            worktree_revision: worktree.revision,
            proposal_digest,
            payload: input.payload.clone(),
            state: WorktreeProposalState::Ready,
            created_at: input.created_at.clone(),
        };
        let worktree = WorktreeRecord {
            state: WorktreeState::ProposalReady,
            owner_node_id: None,
            writer_lease_id: None,
            revision,
            updated_at: input.created_at.clone(),
            ..worktree
        };
        tx.commit()?;
        Ok(WorktreeMutation {
            worktree,
            value: proposal,
        })
    }

    pub fn worktree_proposal(
        &self,
        proposal_id: &str,
    ) -> Result<Option<WorktreeProposalRecord>, StoreError> {
        validate_identifier("proposalId", proposal_id, "prp_")?;
        self.conn
            .query_row(
                "SELECT id, worktree_id, graph_id, node_id, attempt_id, base_commit,
                        base_workspace_revision, worktree_revision, proposal_digest,
                        proposal_json, status, created_at
                 FROM worktree_proposals WHERE id = ?1",
                params![proposal_id],
                read_worktree_proposal,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn worktree_proposals(
        &self,
        worktree_id: &str,
    ) -> Result<Vec<WorktreeProposalRecord>, StoreError> {
        validate_identifier("worktreeId", worktree_id, "wt_")?;
        let mut statement = self.conn.prepare(
            "SELECT id, worktree_id, graph_id, node_id, attempt_id, base_commit,
                    base_workspace_revision, worktree_revision, proposal_digest,
                    proposal_json, status, created_at
             FROM worktree_proposals WHERE worktree_id = ?1
             ORDER BY created_at DESC, id ASC",
        )?;
        let rows = statement.query_map(params![worktree_id], read_worktree_proposal)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}
fn validate_worktree_proposal_create(input: &WorktreeProposalCreate) -> Result<(), StoreError> {
    validate_identifier("proposalId", &input.id, "prp_")?;
    if input.expected_worktree_revision < 1 {
        return Err(invalid("expectedWorktreeRevision must be positive"));
    }
    validate_identifier("writerLeaseId", &input.writer_lease_id, "wls_")?;
    if input.expected_owner_epoch < 1 {
        return Err(invalid("expectedOwnerEpoch must be positive"));
    }
    validate_identifier("graphId", &input.graph_id, "grf_")?;
    validate_identifier("nodeId", &input.node_id, "agt_")?;
    validate_identifier("attemptId", &input.attempt_id, "att_")?;
    validate_timestamp("createdAt", &input.created_at)?;
    Ok(())
}

fn validate_worktree_proposal_payload(
    payload: &WorktreeProposalPayload,
    allowed_paths: &[String],
) -> Result<(), StoreError> {
    if payload.changed_files.is_empty() || payload.changed_files.len() > MAX_WORKTREE_PROPOSAL_FILES
    {
        return Err(invalid(format!(
            "changedFiles must contain 1..={MAX_WORKTREE_PROPOSAL_FILES} entries"
        )));
    }
    validate_identifier("diffArtifactId", &payload.diff_artifact_id, "art_")?;
    validate_identifier(
        "fileManifestArtifactId",
        &payload.file_manifest_artifact_id,
        "art_",
    )?;
    let mut changed_paths = BTreeSet::new();
    for changed in &payload.changed_files {
        validate_repository_path(&changed.path)?;
        if !changed_paths.insert(changed.path.as_str()) {
            return Err(invalid(
                "changedFiles must not contain duplicate destination paths",
            ));
        }
        ensure_path_covered_by_lease(&changed.path, allowed_paths)?;
        match changed.kind {
            WorktreeChangeKind::Rename => {
                let old_path = changed
                    .old_path
                    .as_deref()
                    .ok_or_else(|| invalid("rename changed file requires oldPath"))?;
                validate_repository_path(old_path)?;
                if old_path == changed.path {
                    return Err(invalid("rename oldPath and path must differ"));
                }
                ensure_path_covered_by_lease(old_path, allowed_paths)?;
            }
            WorktreeChangeKind::Create
            | WorktreeChangeKind::Modify
            | WorktreeChangeKind::Delete => {
                if changed.old_path.is_some() {
                    return Err(invalid("only rename changed files may include an oldPath"));
                }
            }
        }
        for (field, revision) in [
            ("baseRevision", changed.base_revision.as_deref()),
            ("postRevision", changed.post_revision.as_deref()),
        ] {
            if let Some(revision) = revision {
                validate_bounded_text(field, revision, MAX_WORKTREE_IDENTIFIER_BYTES)?;
            }
        }
        if changed.additions < 0
            || changed.deletions < 0
            || changed.additions > 10_000_000
            || changed.deletions > 10_000_000
        {
            return Err(invalid(
                "changed file line counts must be bounded non-negative values",
            ));
        }
    }
    if payload.verification_evidence_ids.is_empty()
        || payload.verification_evidence_ids.len() > MAX_WORKTREE_PROPOSAL_EVIDENCE
        || payload.diagnostics_evidence_ids.len() > MAX_WORKTREE_PROPOSAL_EVIDENCE
    {
        return Err(invalid(format!(
            "proposal evidence lists must be bounded and include verification evidence"
        )));
    }
    let mut evidence_ids = BTreeSet::new();
    for evidence_id in payload
        .verification_evidence_ids
        .iter()
        .chain(&payload.diagnostics_evidence_ids)
    {
        validate_identifier("evidenceId", evidence_id, "evidence-")?;
        if !evidence_ids.insert(evidence_id.as_str()) {
            return Err(invalid("proposal evidence IDs must be unique"));
        }
    }
    if payload.open_risks.len() > 128 {
        return Err(invalid("openRisks exceeds 128 entries"));
    }
    for risk in &payload.open_risks {
        validate_bounded_text("openRisk", risk, 1024)?;
    }
    Ok(())
}

fn ensure_path_covered_by_lease(path: &str, allowed_paths: &[String]) -> Result<(), StoreError> {
    if allowed_paths.iter().any(|allowed| {
        allowed == "." || path == allowed || path.starts_with(&format!("{allowed}/"))
    }) {
        Ok(())
    } else {
        Err(invalid(
            "worktree proposal changed path is outside the active writer lease scope",
        ))
    }
}

fn ensure_worktree_proposal_attempt(
    tx: &rusqlite::Transaction<'_>,
    worktree: &WorktreeRecord,
    input: &WorktreeProposalCreate,
) -> Result<(), StoreError> {
    let (node_id, attempt_worktree_id, state): (String, Option<String>, String) = tx
        .query_row(
            "SELECT node_id, worktree_id, state FROM agent_attempts WHERE id = ?1",
            params![&input.attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("agent attempt {}", input.attempt_id),
        })?;
    if node_id != input.node_id || attempt_worktree_id.as_deref() != Some(worktree.id.as_str()) {
        return Err(invalid(
            "proposal attempt must belong to the worktree's assigned node and worktree",
        ));
    }
    if state != "completed" {
        return Err(invalid(
            "only a completed agent attempt can publish a worktree proposal",
        ));
    }
    Ok(())
}

fn ensure_proposal_evidence(
    tx: &rusqlite::Transaction<'_>,
    worktree: &WorktreeRecord,
    verification_evidence_ids: &[String],
    diagnostics_evidence_ids: &[String],
    at: &str,
) -> Result<(), StoreError> {
    for evidence_id in verification_evidence_ids
        .iter()
        .chain(diagnostics_evidence_ids)
    {
        let (
            workspace_identity_digest,
            evidence_worktree_id,
            exact,
            freshness,
            invalidated_at,
            expires_at,
        ): (
            String,
            Option<String>,
            i64,
            String,
            Option<String>,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT workspace_identity_digest, worktree_id, exact, freshness,
                        invalidated_at, expires_at
                 FROM evidence_records WHERE id = ?1",
                params![evidence_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("evidence {evidence_id}"),
            })?;
        if workspace_identity_digest != worktree.workspace_identity_digest
            || evidence_worktree_id.as_deref() != Some(worktree.id.as_str())
            || exact == 0
            || freshness != "fresh"
            || invalidated_at.is_some()
            || expires_at
                .as_deref()
                .is_some_and(|expires_at| expires_at <= at)
        {
            return Err(invalid(
                "proposal evidence must be fresh, exact, valid, and bound to this worktree",
            ));
        }
    }
    Ok(())
}

fn worktree_proposal_digest(
    worktree: &WorktreeRecord,
    input: &WorktreeProposalCreate,
) -> Result<String, StoreError> {
    let envelope = serde_json::json!({
        "schemaVersion": 1,
        "worktreeId": worktree.id,
        "graphId": input.graph_id,
        "nodeId": input.node_id,
        "attemptId": input.attempt_id,
        "baseCommit": worktree.base_commit,
        "baseWorkspaceRevision": worktree.base_workspace_revision,
        "worktreeRevision": worktree.revision,
        "payload": input.payload,
    });
    let canonical = serde_json::to_string(&envelope)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

fn worktree_proposal_in_tx(
    tx: &rusqlite::Transaction<'_>,
    proposal_id: &str,
) -> Result<Option<WorktreeProposalRecord>, StoreError> {
    tx.query_row(
        "SELECT id, worktree_id, graph_id, node_id, attempt_id, base_commit,
                base_workspace_revision, worktree_revision, proposal_digest,
                proposal_json, status, created_at
         FROM worktree_proposals WHERE id = ?1",
        params![proposal_id],
        read_worktree_proposal,
    )
    .optional()
    .map_err(StoreError::from)
}

fn ensure_proposal_replay(
    existing: &WorktreeProposalRecord,
    worktree_id: &str,
    input: &WorktreeProposalCreate,
) -> Result<(), StoreError> {
    if existing.worktree_id != worktree_id
        || existing.graph_id != input.graph_id
        || existing.node_id != input.node_id
        || existing.attempt_id != input.attempt_id
        || existing.payload != input.payload
        || existing.created_at != input.created_at
    {
        return Err(invalid(
            "worktree proposal ID is already bound to different immutable facts",
        ));
    }
    Ok(())
}

fn read_worktree_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorktreeProposalRecord> {
    let raw_revision: String = row.get(7)?;
    let worktree_revision = raw_revision.parse::<i64>().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let raw_state: String = row.get(10)?;
    let state = WorktreeProposalState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let raw_payload: String = row.get(9)?;
    let payload = serde_json::from_str(&raw_payload).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(WorktreeProposalRecord {
        id: row.get(0)?,
        worktree_id: row.get(1)?,
        graph_id: row.get(2)?,
        node_id: row.get(3)?,
        attempt_id: row.get(4)?,
        base_commit: row.get(5)?,
        base_workspace_revision: row.get(6)?,
        worktree_revision,
        proposal_digest: row.get(8)?,
        payload,
        state,
        created_at: row.get(11)?,
    })
}

impl SessionStore {
    /// Select compatible ready proposals into a durable merge attempt. This does
    /// not mutate the base workspace; the runtime merge adapter must later move
    /// the attempt through applying and a receipt-backed terminal state.
    pub fn begin_merge_attempt(
        &mut self,
        input: &MergeAttemptCreate,
    ) -> Result<MergeAttemptRecord, StoreError> {
        validate_merge_attempt_create(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = merge_attempt_in_tx(&tx, &input.id)? {
            ensure_merge_attempt_replay(&existing, input)?;
            tx.commit()?;
            return Ok(existing);
        }

        let proposal_ids = input.proposal_ids.clone();
        let mut worktrees = Vec::with_capacity(proposal_ids.len());
        for proposal_id in &proposal_ids {
            let proposal =
                worktree_proposal_in_tx(&tx, proposal_id)?.ok_or_else(|| StoreError::NotFound {
                    what: format!("worktree proposal {proposal_id}"),
                })?;
            if proposal.state != WorktreeProposalState::Ready {
                return Err(invalid(
                    "only ready worktree proposals can enter a merge attempt",
                ));
            }
            if proposal.base_workspace_revision != input.base_workspace_revision {
                return Err(invalid(
                    "proposal baseWorkspaceRevision does not match the merge base fence",
                ));
            }
            if input.graph_id.as_deref() != Some(proposal.graph_id.as_str()) {
                return Err(invalid(
                    "merge graphId must match every selected worktree proposal",
                ));
            }
            let worktree = require_worktree(&tx, &proposal.worktree_id)?;
            if worktree.workspace_identity_digest != input.workspace_identity_digest
                || worktree.state != WorktreeState::ProposalReady
                || worktree.writer_lease_id.is_some()
            {
                return Err(invalid(
                    "selected proposal worktree is not a merge-ready tree in this workspace",
                ));
            }
            worktrees.push((proposal, worktree));
        }

        for (proposal, worktree) in &worktrees {
            let selected = tx.execute(
                "UPDATE worktree_proposals SET status = 'selected'
                 WHERE id = ?1 AND status = 'ready'",
                params![&proposal.id],
            )?;
            if selected != 1 {
                return Err(invalid("worktree proposal changed while preparing merge"));
            }
            let revision = next_worktree_revision(worktree)?;
            let changed = tx.execute(
                "UPDATE worktrees SET state = 'merging', revision = ?2, updated_at = ?3
                 WHERE id = ?1 AND revision = ?4 AND state = 'proposal_ready'
                   AND writer_lease_id IS NULL",
                params![&worktree.id, revision, &input.created_at, worktree.revision],
            )?;
            if changed != 1 {
                return Err(StoreError::WorktreeRevisionConflict {
                    worktree_id: worktree.id.clone(),
                    expected: worktree.revision,
                    actual: worktree_revision(&tx, &worktree.id)?,
                });
            }
        }
        tx.execute(
            "INSERT INTO merge_attempts (
                id, workspace_identity_digest, graph_id, proposal_ids_json,
                base_revision_before, base_revision_after, transaction_id, state,
                conflict_policy, error_json, created_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 'prepared', ?6, NULL, ?7, NULL)",
            params![
                &input.id,
                &input.workspace_identity_digest,
                &input.graph_id,
                serde_json::to_string(&proposal_ids)?,
                &input.base_workspace_revision,
                input.conflict_policy.label(),
                &input.created_at,
            ],
        )?;
        let record = MergeAttemptRecord {
            id: input.id.clone(),
            workspace_identity_digest: input.workspace_identity_digest.clone(),
            graph_id: input.graph_id.clone(),
            proposal_ids,
            base_workspace_revision: input.base_workspace_revision.clone(),
            base_workspace_revision_after: None,
            transaction_id: None,
            state: MergeAttemptState::Prepared,
            conflict_policy: input.conflict_policy,
            error: None,
            created_at: input.created_at.clone(),
            completed_at: None,
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn merge_attempt(
        &self,
        merge_attempt_id: &str,
    ) -> Result<Option<MergeAttemptRecord>, StoreError> {
        validate_identifier("mergeAttemptId", merge_attempt_id, "mrg_")?;
        self.conn
            .query_row(
                "SELECT id, workspace_identity_digest, graph_id, proposal_ids_json,
                        base_revision_before, base_revision_after, transaction_id, state,
                        conflict_policy, error_json, created_at, completed_at
                 FROM merge_attempts WHERE id = ?1",
                params![merge_attempt_id],
                read_merge_attempt,
            )
            .optional()
            .map_err(StoreError::from)
    }
}

fn validate_merge_attempt_create(input: &MergeAttemptCreate) -> Result<(), StoreError> {
    validate_identifier("mergeAttemptId", &input.id, "mrg_")?;
    validate_workspace_identity(&input.workspace_identity_digest)?;
    let graph_id = input
        .graph_id
        .as_deref()
        .ok_or_else(|| invalid("merge graphId is required for worktree proposals"))?;
    validate_identifier("graphId", graph_id, "grf_")?;
    if input.proposal_ids.is_empty() || input.proposal_ids.len() > MAX_MERGE_PROPOSALS {
        return Err(invalid(format!(
            "proposalIds must contain 1..={MAX_MERGE_PROPOSALS} entries"
        )));
    }
    let mut unique = BTreeSet::new();
    for proposal_id in &input.proposal_ids {
        validate_identifier("proposalId", proposal_id, "prp_")?;
        if !unique.insert(proposal_id.as_str()) {
            return Err(invalid("proposalIds must not contain duplicates"));
        }
    }
    validate_bounded_text(
        "baseWorkspaceRevision",
        &input.base_workspace_revision,
        MAX_WORKTREE_IDENTIFIER_BYTES,
    )?;
    validate_timestamp("createdAt", &input.created_at)
}

fn merge_attempt_in_tx(
    tx: &rusqlite::Transaction<'_>,
    merge_attempt_id: &str,
) -> Result<Option<MergeAttemptRecord>, StoreError> {
    tx.query_row(
        "SELECT id, workspace_identity_digest, graph_id, proposal_ids_json,
                base_revision_before, base_revision_after, transaction_id, state,
                conflict_policy, error_json, created_at, completed_at
         FROM merge_attempts WHERE id = ?1",
        params![merge_attempt_id],
        read_merge_attempt,
    )
    .optional()
    .map_err(StoreError::from)
}

fn ensure_merge_attempt_replay(
    existing: &MergeAttemptRecord,
    input: &MergeAttemptCreate,
) -> Result<(), StoreError> {
    if existing.workspace_identity_digest != input.workspace_identity_digest
        || existing.graph_id != input.graph_id
        || existing.proposal_ids != input.proposal_ids
        || existing.base_workspace_revision != input.base_workspace_revision
        || existing.conflict_policy != input.conflict_policy
        || existing.created_at != input.created_at
    {
        return Err(invalid(
            "merge attempt ID is already bound to different immutable input",
        ));
    }
    Ok(())
}

fn read_merge_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<MergeAttemptRecord> {
    let raw_proposal_ids: String = row.get(3)?;
    let proposal_ids: Vec<String> = serde_json::from_str(&raw_proposal_ids).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let raw_state: String = row.get(7)?;
    let state = MergeAttemptState::parse(&raw_state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let raw_policy: String = row.get(8)?;
    let conflict_policy = match raw_policy.as_str() {
        "fail" => MergeConflictPolicy::Fail,
        "manual" => MergeConflictPolicy::Manual,
        _ => {
            return Err(invalid_sql_column(
                8,
                "stored merge attempt has unsupported conflict policy",
            ))
        }
    };
    let raw_error: Option<String> = row.get(9)?;
    let error = raw_error.map(|value| json_column(value, 9)).transpose()?;
    Ok(MergeAttemptRecord {
        id: row.get(0)?,
        workspace_identity_digest: row.get(1)?,
        graph_id: row.get(2)?,
        proposal_ids,
        base_workspace_revision: row.get(4)?,
        base_workspace_revision_after: row.get(5)?,
        transaction_id: row.get(6)?,
        state,
        conflict_policy,
        error,
        created_at: row.get(10)?,
        completed_at: row.get(11)?,
    })
}
