//! Durable evidence and memory records.
//!
//! The context engine owns claim reconciliation, while this module owns the
//! restart-safe persistence boundary: evidence is workspace-bound, memory writes
//! require currently fresh evidence, and every change records an append-only
//! transition. Raw transcripts are deliberately not part of this schema.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{reject_credential_payload, SessionStore, StoreError};

/// Evidence summaries are deliberately compact references, never transcript
/// storage. The caller may keep larger content in a redacted artifact instead.
pub const MAX_DURABLE_EVIDENCE_SUMMARY_BYTES: usize = 8 * 1024;
pub const MAX_DURABLE_MEMORY_VALUE_BYTES: usize = 16 * 1024;
pub const MAX_DURABLE_MEMORY_VALIDITY_BYTES: usize = 8 * 1024;
pub const MAX_DURABLE_MEMORY_REFERENCES: usize = 128;
pub const DEFAULT_MEMORY_RECALL_LIMIT: usize = 32;
pub const MAX_MEMORY_RECALL_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceFreshness {
    Fresh,
    Stale,
    Invalid,
    Unknown,
}

impl EvidenceFreshness {
    pub fn label(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Invalid => "invalid",
            Self::Unknown => "unknown",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "fresh" => Ok(Self::Fresh),
            "stale" => Ok(Self::Stale),
            "invalid" => Ok(Self::Invalid),
            "unknown" => Ok(Self::Unknown),
            _ => Err(StoreError::InvalidDurableMemory {
                detail: format!("stored evidence has unsupported freshness '{raw}'"),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Workspace,
    Session,
    Task,
}

impl MemoryScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Session => "session",
            Self::Task => "task",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "workspace" => Ok(Self::Workspace),
            "session" => Ok(Self::Session),
            "task" => Ok(Self::Task),
            _ => Err(StoreError::InvalidDurableMemory {
                detail: format!("stored memory has unsupported scope '{raw}'"),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MemoryStatus {
    Active,
    Superseded,
    Contested,
}

impl MemoryStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Contested => "contested",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "active" => Ok(Self::Active),
            "superseded" => Ok(Self::Superseded),
            "contested" => Ok(Self::Contested),
            _ => Err(StoreError::InvalidDurableMemory {
                detail: format!("stored memory has unsupported status '{raw}'"),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePathBinding {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DurableEvidenceInput {
    pub id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub kind: String,
    pub source: String,
    /// Canonical SHA-256 hex digest of the observed content/reference.
    pub digest: String,
    /// False only for an inferred or summarized observation.
    pub exact: bool,
    pub freshness: EvidenceFreshness,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Bounded, redacted fact summary. Never a raw transcript.
    pub summary: String,
    #[serde(default)]
    pub path_bindings: Vec<EvidencePathBinding>,
    #[serde(default)]
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DurableEvidenceRecord {
    #[serde(flatten)]
    pub input: DurableEvidenceInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalidated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalidation_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DurableMemoryWrite {
    pub id: String,
    pub workspace_identity_digest: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub key: String,
    pub value: String,
    pub status: MemoryStatus,
    pub confidence: f64,
    /// Scope/branch/path validity metadata; must be a bounded JSON object.
    pub valid_for: serde_json::Value,
    pub created_at: String,
    pub last_validated_at: String,
    pub evidence_observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_evidence_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub created_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_agent_id: Option<String>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(default)]
    pub contested_with: Vec<String>,
    /// Required when replacing an existing record; creates use `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    /// Append-only transition explanation, not raw model reasoning.
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredMemoryRecord {
    pub id: String,
    pub workspace_identity_digest: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub key: String,
    pub value: String,
    pub status: MemoryStatus,
    pub confidence: f64,
    pub valid_for: serde_json::Value,
    pub created_at: String,
    pub last_validated_at: String,
    pub evidence_observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_evidence_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub revision: i64,
    pub created_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_accessed_at: Option<String>,
    pub access_count: i64,
    pub evidence_ids: Vec<String>,
    pub supersedes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub contested_with: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTransition {
    pub sequence: i64,
    pub memory_id: String,
    pub from_status: Option<MemoryStatus>,
    pub to_status: MemoryStatus,
    pub reason: String,
    pub evidence_ids: Vec<String>,
    pub at: String,
}

#[derive(Debug, Clone)]
pub struct MemoryRecallQuery {
    pub workspace_identity_digest: String,
    pub key: Option<String>,
    pub text: Option<String>,
    /// An empty vector means the safe default: active records only.
    pub statuses: Vec<MemoryStatus>,
    /// An empty vector means all scopes.
    pub scopes: Vec<MemoryScope>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub worktree_id: Option<String>,
    pub path: Option<String>,
    pub now: String,
    pub limit: usize,
    /// Defaults should be true. Set false only for diagnostics/repair tooling.
    pub require_fresh_evidence: bool,
}

impl MemoryRecallQuery {
    pub fn active_workspace(
        workspace_identity_digest: impl Into<String>,
        now: impl Into<String>,
    ) -> Self {
        Self {
            workspace_identity_digest: workspace_identity_digest.into(),
            key: None,
            text: None,
            statuses: vec![MemoryStatus::Active],
            scopes: Vec::new(),
            session_id: None,
            task_id: None,
            worktree_id: None,
            path: None,
            now: now.into(),
            limit: DEFAULT_MEMORY_RECALL_LIMIT,
            require_fresh_evidence: true,
        }
    }
}

impl SessionStore {
    /// Persist or refresh one evidence fact and replace its bounded path/artifact
    /// bindings atomically. A changed workspace identity gets a distinct record;
    /// it never silently relocates an old fact.
    pub fn upsert_evidence(
        &mut self,
        input: &DurableEvidenceInput,
    ) -> Result<DurableEvidenceRecord, StoreError> {
        validate_evidence_input(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing_workspace) = tx
            .query_row(
                "SELECT workspace_identity_digest FROM evidence_records WHERE id = ?1",
                params![input.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if existing_workspace != input.workspace_identity_digest {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!(
                        "evidence {} is already bound to another workspace identity",
                        input.id
                    ),
                });
            }
        }

        for artifact_id in sorted_unique(&input.artifact_ids) {
            let exists = tx
                .query_row(
                    "SELECT 1 FROM artifacts WHERE id = ?1",
                    params![artifact_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Err(StoreError::NotFound {
                    what: format!("artifact {artifact_id}"),
                });
            }
        }

        tx.execute(
            "INSERT INTO evidence_records (
                id, workspace_identity_digest, session_id, turn_id, agent_id,
                task_id, worktree_id, kind, source, digest, exact, freshness,
                observed_at, expires_at, summary, invalidated_at, invalidation_reason
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                NULL, NULL
             )
             ON CONFLICT(id) DO UPDATE SET
                session_id = excluded.session_id,
                turn_id = excluded.turn_id,
                agent_id = excluded.agent_id,
                task_id = excluded.task_id,
                worktree_id = excluded.worktree_id,
                kind = excluded.kind,
                source = excluded.source,
                digest = excluded.digest,
                exact = excluded.exact,
                freshness = excluded.freshness,
                observed_at = excluded.observed_at,
                expires_at = excluded.expires_at,
                summary = excluded.summary,
                invalidated_at = NULL,
                invalidation_reason = NULL",
            params![
                input.id,
                input.workspace_identity_digest,
                input.session_id,
                input.turn_id,
                input.agent_id,
                input.task_id,
                input.worktree_id,
                input.kind,
                input.source,
                input.digest,
                i64::from(input.exact),
                input.freshness.label(),
                input.observed_at,
                input.expires_at,
                input.summary,
            ],
        )?;
        tx.execute(
            "DELETE FROM evidence_path_bindings WHERE evidence_id = ?1",
            params![input.id],
        )?;
        for binding in sorted_path_bindings(&input.path_bindings) {
            tx.execute(
                "INSERT INTO evidence_path_bindings (evidence_id, path, revision_token)
                 VALUES (?1, ?2, ?3)",
                params![input.id, binding.path, binding.revision_token],
            )?;
        }
        tx.execute(
            "DELETE FROM evidence_artifacts WHERE evidence_id = ?1",
            params![input.id],
        )?;
        for artifact_id in sorted_unique(&input.artifact_ids) {
            tx.execute(
                "INSERT INTO evidence_artifacts (evidence_id, artifact_id) VALUES (?1, ?2)",
                params![input.id, artifact_id],
            )?;
        }
        tx.commit()?;

        self.evidence(&input.id)?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("evidence {} after upsert", input.id),
            })
    }

    pub fn evidence(&self, id: &str) -> Result<Option<DurableEvidenceRecord>, StoreError> {
        self.conn
            .query_row(
                "SELECT id, workspace_identity_digest, session_id, turn_id, agent_id,
                        task_id, worktree_id, kind, source, digest, exact, freshness,
                        observed_at, expires_at, summary, invalidated_at, invalidation_reason
                 FROM evidence_records WHERE id = ?1",
                params![id],
                read_evidence_row,
            )
            .optional()?
            .map(|row| durable_evidence_from_row(&self.conn, row))
            .transpose()
    }

    /// Invalidates evidence bound to a changed path or one of its directory
    /// ancestors/descendants. Fresh memory that references it is hidden by recall
    /// immediately, without deleting its audit trail.
    pub fn invalidate_evidence_for_path(
        &mut self,
        workspace_identity_digest: &str,
        path: &str,
        reason: &str,
        at: &str,
    ) -> Result<Vec<String>, StoreError> {
        validate_workspace_identity(workspace_identity_digest)?;
        validate_repository_path(path)?;
        validate_transition_text("invalidationReason", reason)?;
        validate_timestamp("at", at)?;
        let descendant_pattern = if path == "." {
            "%".to_string()
        } else {
            format!("{path}/%")
        };
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = tx.prepare(
            "SELECT DISTINCT evidence_records.id
             FROM evidence_records
             JOIN evidence_path_bindings
               ON evidence_path_bindings.evidence_id = evidence_records.id
             WHERE evidence_records.workspace_identity_digest = ?1
               AND evidence_records.freshness != 'invalid'
               AND (
                    evidence_path_bindings.path = ?2
                    OR evidence_path_bindings.path LIKE ?3
                    OR ?2 LIKE evidence_path_bindings.path || '/%'
               )
             ORDER BY evidence_records.id ASC",
        )?;
        let ids = statement
            .query_map(
                params![workspace_identity_digest, path, descendant_pattern],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for id in &ids {
            tx.execute(
                "UPDATE evidence_records
                 SET freshness = 'invalid', invalidated_at = ?2, invalidation_reason = ?3
                 WHERE id = ?1",
                params![id, at, reason],
            )?;
        }
        tx.commit()?;
        Ok(ids)
    }

    /// Store one evidence-backed memory claim with a compare-and-swap revision.
    /// Any stale, missing, expired, or cross-workspace evidence rejects the whole
    /// transaction before the record, links, or transition can become visible.
    pub fn upsert_memory(
        &mut self,
        input: &DurableMemoryWrite,
    ) -> Result<StoredMemoryRecord, StoreError> {
        validate_memory_write(input)?;
        let evidence_ids = sorted_unique(&input.evidence_ids);
        let supersedes = sorted_unique(&input.supersedes);
        let contested_with = sorted_unique(&input.contested_with);
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        for evidence_id in &evidence_ids {
            ensure_memory_evidence(
                &tx,
                evidence_id,
                &input.workspace_identity_digest,
                &input.at,
            )?;
        }
        for related_id in supersedes
            .iter()
            .chain(input.superseded_by.iter())
            .chain(contested_with.iter())
        {
            ensure_related_memory(&tx, related_id, input)?;
        }

        let existing = tx
            .query_row(
                "SELECT workspace_identity_digest, revision, status, created_at, created_by,
                        created_by_agent_id
                 FROM memory_records WHERE id = ?1",
                params![input.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        let (revision, from_status, created_at, created_by, created_by_agent_id) = match existing {
            Some((
                workspace,
                current_revision,
                status,
                original_created_at,
                original_created_by,
                original_agent,
            )) => {
                if workspace != input.workspace_identity_digest {
                    return Err(StoreError::InvalidDurableMemory {
                        detail: format!(
                            "memory {} is already bound to another workspace identity",
                            input.id
                        ),
                    });
                }
                if input.expected_revision != Some(current_revision) {
                    return Err(StoreError::MemoryRevisionConflict {
                        id: input.id.clone(),
                        expected: input.expected_revision,
                        actual: Some(current_revision),
                    });
                }
                (
                    current_revision + 1,
                    Some(MemoryStatus::parse(&status)?),
                    original_created_at,
                    original_created_by,
                    original_agent,
                )
            }
            None => {
                if input.expected_revision.is_some() {
                    return Err(StoreError::MemoryRevisionConflict {
                        id: input.id.clone(),
                        expected: input.expected_revision,
                        actual: None,
                    });
                }
                (
                    1,
                    None,
                    input.created_at.clone(),
                    input.created_by.clone(),
                    input.created_by_agent_id.clone(),
                )
            }
        };
        let valid_for_json = serde_json::to_string(&input.valid_for)?;
        tx.execute(
            "INSERT INTO memory_records (
                id, workspace_identity_digest, scope, session_id, task_id, worktree_id,
                key, value, status, confidence, valid_for_json, created_at,
                last_validated_at, evidence_observed_at, exact_evidence_observed_at,
                expires_at, revision, created_by, created_by_agent_id, last_accessed_at,
                access_count
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, NULL, 0
             )
             ON CONFLICT(id) DO UPDATE SET
                scope = excluded.scope,
                session_id = excluded.session_id,
                task_id = excluded.task_id,
                worktree_id = excluded.worktree_id,
                key = excluded.key,
                value = excluded.value,
                status = excluded.status,
                confidence = excluded.confidence,
                valid_for_json = excluded.valid_for_json,
                last_validated_at = excluded.last_validated_at,
                evidence_observed_at = excluded.evidence_observed_at,
                exact_evidence_observed_at = excluded.exact_evidence_observed_at,
                expires_at = excluded.expires_at,
                revision = excluded.revision",
            params![
                input.id,
                input.workspace_identity_digest,
                input.scope.label(),
                input.session_id,
                input.task_id,
                input.worktree_id,
                input.key,
                input.value,
                input.status.label(),
                input.confidence,
                valid_for_json,
                created_at,
                input.last_validated_at,
                input.evidence_observed_at,
                input.exact_evidence_observed_at,
                input.expires_at,
                revision,
                created_by,
                created_by_agent_id,
            ],
        )?;
        tx.execute(
            "DELETE FROM memory_evidence_links WHERE memory_id = ?1",
            params![input.id],
        )?;
        for evidence_id in &evidence_ids {
            tx.execute(
                "INSERT INTO memory_evidence_links (memory_id, evidence_id) VALUES (?1, ?2)",
                params![input.id, evidence_id],
            )?;
        }
        tx.execute(
            "DELETE FROM memory_relations WHERE memory_id = ?1",
            params![input.id],
        )?;
        for related_id in &supersedes {
            insert_memory_relation(&tx, &input.id, related_id, "supersedes")?;
        }
        if let Some(related_id) = &input.superseded_by {
            insert_memory_relation(&tx, &input.id, related_id, "superseded_by")?;
        }
        for related_id in &contested_with {
            insert_memory_relation(&tx, &input.id, related_id, "contested_with")?;
        }
        tx.execute(
            "INSERT INTO memory_transitions (
                memory_id, from_status, to_status, reason, evidence_ids_json, at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.id,
                from_status.map(MemoryStatus::label).unwrap_or("absent"),
                input.status.label(),
                input.reason,
                serde_json::to_string(&evidence_ids)?,
                input.at,
            ],
        )?;
        tx.commit()?;

        self.memory(&input.id)?.ok_or_else(|| StoreError::NotFound {
            what: format!("memory {} after upsert", input.id),
        })
    }

    pub fn memory(&self, id: &str) -> Result<Option<StoredMemoryRecord>, StoreError> {
        self.conn
            .query_row(
                "SELECT id, workspace_identity_digest, scope, session_id, task_id, worktree_id,
                        key, value, status, confidence, valid_for_json, created_at,
                        last_validated_at, evidence_observed_at, exact_evidence_observed_at,
                        expires_at, revision, created_by, created_by_agent_id, last_accessed_at,
                        access_count
                 FROM memory_records WHERE id = ?1",
                params![id],
                read_memory_row,
            )
            .optional()?
            .map(|row| stored_memory_from_row(&self.conn, row))
            .transpose()
    }

    /// Recall only visible, unexpired claims. By default every linked evidence
    /// record must still be fresh; maintenance tools can opt out to diagnose why
    /// a record is hidden.
    pub fn recall_memory(
        &self,
        query: &MemoryRecallQuery,
    ) -> Result<Vec<StoredMemoryRecord>, StoreError> {
        validate_workspace_identity(&query.workspace_identity_digest)?;
        validate_timestamp("now", &query.now)?;
        if query.limit == 0 {
            return Err(StoreError::InvalidDurableMemory {
                detail: "memory recall limit must be greater than zero".into(),
            });
        }
        if let Some(path) = &query.path {
            validate_repository_path(path)?;
        }
        let ids = self
            .conn
            .prepare(
                "SELECT id FROM memory_records
                 WHERE workspace_identity_digest = ?1
                 ORDER BY key ASC, last_validated_at DESC, id ASC",
            )?
            .query_map(params![query.workspace_identity_digest], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let statuses = if query.statuses.is_empty() {
            vec![MemoryStatus::Active]
        } else {
            query.statuses.clone()
        };
        let mut records = Vec::new();
        for id in ids {
            let Some(record) = self.memory(&id)? else {
                continue;
            };
            if !statuses.contains(&record.status)
                || (!query.scopes.is_empty() && !query.scopes.contains(&record.scope))
                || !matches_memory_context(&record, query)
                || memory_is_expired(&record, &query.now)
                || !memory_matches_path(&record, query.path.as_deref())?
                || (query.require_fresh_evidence
                    && !memory_has_fresh_evidence(&self.conn, &record.id, &query.now)?)
            {
                continue;
            }
            if let Some(key) = &query.key {
                if record.key != key.trim() {
                    continue;
                }
            }
            if let Some(text) = &query.text {
                let needle = text.trim().to_ascii_lowercase();
                if !needle.is_empty()
                    && !record.key.to_ascii_lowercase().contains(&needle)
                    && !record.value.to_ascii_lowercase().contains(&needle)
                {
                    continue;
                }
            }
            records.push(record);
        }
        records.sort_by(compare_recalled_memory);
        records.truncate(query.limit.min(MAX_MEMORY_RECALL_LIMIT));
        Ok(records)
    }

    /// Update access metadata only after a caller has actually selected records
    /// for context. It is intentionally separate from recall so diagnostic reads
    /// do not change eviction/accounting signals.
    pub fn mark_memory_accessed(
        &mut self,
        memory_ids: &[String],
        at: &str,
    ) -> Result<(), StoreError> {
        validate_timestamp("at", at)?;
        let ids = sorted_unique(memory_ids);
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for id in ids {
            let changed = tx.execute(
                "UPDATE memory_records
                 SET last_accessed_at = ?2, access_count = access_count + 1
                 WHERE id = ?1",
                params![id, at],
            )?;
            if changed != 1 {
                return Err(StoreError::NotFound {
                    what: format!("memory {id}"),
                });
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn memory_transitions(&self, memory_id: &str) -> Result<Vec<MemoryTransition>, StoreError> {
        let rows = self
            .conn
            .prepare(
                "SELECT sequence, memory_id, from_status, to_status, reason, evidence_ids_json, at
                 FROM memory_transitions WHERE memory_id = ?1 ORDER BY sequence ASC",
            )?
            .query_map(params![memory_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(sequence, memory_id, from, to, reason, evidence_ids_json, at)| {
                    Ok(MemoryTransition {
                        sequence,
                        memory_id,
                        from_status: (from != "absent")
                            .then(|| MemoryStatus::parse(&from))
                            .transpose()?,
                        to_status: MemoryStatus::parse(&to)?,
                        reason,
                        evidence_ids: serde_json::from_str(&evidence_ids_json)?,
                        at,
                    })
                },
            )
            .collect()
    }
}

#[derive(Debug)]
struct EvidenceRow {
    id: String,
    workspace_identity_digest: String,
    session_id: Option<String>,
    turn_id: Option<String>,
    agent_id: Option<String>,
    task_id: Option<String>,
    worktree_id: Option<String>,
    kind: String,
    source: String,
    digest: String,
    exact: i64,
    freshness: String,
    observed_at: String,
    expires_at: Option<String>,
    summary: String,
    invalidated_at: Option<String>,
    invalidation_reason: Option<String>,
}

fn read_evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EvidenceRow> {
    Ok(EvidenceRow {
        id: row.get(0)?,
        workspace_identity_digest: row.get(1)?,
        session_id: row.get(2)?,
        turn_id: row.get(3)?,
        agent_id: row.get(4)?,
        task_id: row.get(5)?,
        worktree_id: row.get(6)?,
        kind: row.get(7)?,
        source: row.get(8)?,
        digest: row.get(9)?,
        exact: row.get(10)?,
        freshness: row.get(11)?,
        observed_at: row.get(12)?,
        expires_at: row.get(13)?,
        summary: row.get(14)?,
        invalidated_at: row.get(15)?,
        invalidation_reason: row.get(16)?,
    })
}

fn durable_evidence_from_row(
    conn: &rusqlite::Connection,
    row: EvidenceRow,
) -> Result<DurableEvidenceRecord, StoreError> {
    let path_bindings = conn
        .prepare(
            "SELECT path, revision_token FROM evidence_path_bindings
             WHERE evidence_id = ?1 ORDER BY path ASC",
        )?
        .query_map(params![row.id], |binding| {
            Ok(EvidencePathBinding {
                path: binding.get(0)?,
                revision_token: binding.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let artifact_ids = conn
        .prepare(
            "SELECT artifact_id FROM evidence_artifacts
             WHERE evidence_id = ?1 ORDER BY artifact_id ASC",
        )?
        .query_map(params![row.id], |artifact| artifact.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let freshness = EvidenceFreshness::parse(&row.freshness)?;
    let input = DurableEvidenceInput {
        id: row.id,
        workspace_identity_digest: row.workspace_identity_digest,
        session_id: row.session_id,
        turn_id: row.turn_id,
        agent_id: row.agent_id,
        task_id: row.task_id,
        worktree_id: row.worktree_id,
        kind: row.kind,
        source: row.source,
        digest: row.digest,
        exact: row.exact != 0,
        freshness,
        observed_at: row.observed_at,
        expires_at: row.expires_at,
        summary: row.summary,
        path_bindings,
        artifact_ids,
    };
    validate_evidence_input(&input)?;
    Ok(DurableEvidenceRecord {
        input,
        invalidated_at: row.invalidated_at,
        invalidation_reason: row.invalidation_reason,
    })
}

#[derive(Debug)]
struct MemoryRow {
    id: String,
    workspace_identity_digest: String,
    scope: String,
    session_id: Option<String>,
    task_id: Option<String>,
    worktree_id: Option<String>,
    key: String,
    value: String,
    status: String,
    confidence: f64,
    valid_for_json: String,
    created_at: String,
    last_validated_at: String,
    evidence_observed_at: String,
    exact_evidence_observed_at: Option<String>,
    expires_at: Option<String>,
    revision: i64,
    created_by: String,
    created_by_agent_id: Option<String>,
    last_accessed_at: Option<String>,
    access_count: i64,
}

fn read_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    Ok(MemoryRow {
        id: row.get(0)?,
        workspace_identity_digest: row.get(1)?,
        scope: row.get(2)?,
        session_id: row.get(3)?,
        task_id: row.get(4)?,
        worktree_id: row.get(5)?,
        key: row.get(6)?,
        value: row.get(7)?,
        status: row.get(8)?,
        confidence: row.get(9)?,
        valid_for_json: row.get(10)?,
        created_at: row.get(11)?,
        last_validated_at: row.get(12)?,
        evidence_observed_at: row.get(13)?,
        exact_evidence_observed_at: row.get(14)?,
        expires_at: row.get(15)?,
        revision: row.get(16)?,
        created_by: row.get(17)?,
        created_by_agent_id: row.get(18)?,
        last_accessed_at: row.get(19)?,
        access_count: row.get(20)?,
    })
}

fn stored_memory_from_row(
    conn: &rusqlite::Connection,
    row: MemoryRow,
) -> Result<StoredMemoryRecord, StoreError> {
    let valid_for = serde_json::from_str::<serde_json::Value>(&row.valid_for_json)?;
    let evidence_ids = conn
        .prepare(
            "SELECT evidence_id FROM memory_evidence_links
             WHERE memory_id = ?1 ORDER BY evidence_id ASC",
        )?
        .query_map(params![row.id], |evidence| evidence.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let relations = conn
        .prepare(
            "SELECT related_memory_id, relation FROM memory_relations
             WHERE memory_id = ?1 ORDER BY relation ASC, related_memory_id ASC",
        )?
        .query_map(params![row.id], |relation| {
            Ok((relation.get::<_, String>(0)?, relation.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut supersedes = Vec::new();
    let mut superseded_by = None;
    let mut contested_with = Vec::new();
    for (related_id, relation) in relations {
        match relation.as_str() {
            "supersedes" => supersedes.push(related_id),
            "superseded_by" if superseded_by.is_none() => superseded_by = Some(related_id),
            "superseded_by" => {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("memory {} has multiple supersededBy relations", row.id),
                });
            }
            "contested_with" => contested_with.push(related_id),
            _ => {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("memory {} has unsupported relation '{relation}'", row.id),
                });
            }
        }
    }
    let record = StoredMemoryRecord {
        id: row.id,
        workspace_identity_digest: row.workspace_identity_digest,
        scope: MemoryScope::parse(&row.scope)?,
        session_id: row.session_id,
        task_id: row.task_id,
        worktree_id: row.worktree_id,
        key: row.key,
        value: row.value,
        status: MemoryStatus::parse(&row.status)?,
        confidence: row.confidence,
        valid_for,
        created_at: row.created_at,
        last_validated_at: row.last_validated_at,
        evidence_observed_at: row.evidence_observed_at,
        exact_evidence_observed_at: row.exact_evidence_observed_at,
        expires_at: row.expires_at,
        revision: row.revision,
        created_by: row.created_by,
        created_by_agent_id: row.created_by_agent_id,
        last_accessed_at: row.last_accessed_at,
        access_count: row.access_count,
        evidence_ids,
        supersedes,
        superseded_by,
        contested_with,
    };
    validate_stored_memory(&record)?;
    Ok(record)
}

fn validate_evidence_input(input: &DurableEvidenceInput) -> Result<(), StoreError> {
    validate_prefixed_identifier("evidenceId", &input.id, "evidence-")?;
    validate_workspace_identity(&input.workspace_identity_digest)?;
    validate_short_text("kind", &input.kind, 128)?;
    validate_short_text("source", &input.source, 256)?;
    if input.source.to_ascii_lowercase().contains("transcript") {
        return Err(StoreError::InvalidDurableMemory {
            detail: "evidence source must reference a fact or artifact, not a raw transcript"
                .into(),
        });
    }
    validate_digest(&input.digest)?;
    validate_timestamp("observedAt", &input.observed_at)?;
    if let Some(expires_at) = &input.expires_at {
        validate_timestamp("expiresAt", expires_at)?;
    }
    validate_bounded_text(
        "summary",
        &input.summary,
        MAX_DURABLE_EVIDENCE_SUMMARY_BYTES,
    )?;
    reject_secret_text("summary", &input.summary)?;
    validate_optional_identifiers([
        ("sessionId", input.session_id.as_deref()),
        ("turnId", input.turn_id.as_deref()),
        ("agentId", input.agent_id.as_deref()),
        ("taskId", input.task_id.as_deref()),
        ("worktreeId", input.worktree_id.as_deref()),
    ])?;
    if input.path_bindings.len() > MAX_DURABLE_MEMORY_REFERENCES
        || input.artifact_ids.len() > MAX_DURABLE_MEMORY_REFERENCES
    {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("evidence references exceed {MAX_DURABLE_MEMORY_REFERENCES}"),
        });
    }
    let mut paths = BTreeSet::new();
    for binding in &input.path_bindings {
        validate_repository_path(&binding.path)?;
        if !paths.insert(binding.path.as_str()) {
            return Err(StoreError::InvalidDurableMemory {
                detail: format!("duplicate evidence path binding {}", binding.path),
            });
        }
        if let Some(revision_token) = &binding.revision_token {
            validate_short_text("revisionToken", revision_token, 512)?;
        }
    }
    let mut artifacts = BTreeSet::new();
    for artifact_id in &input.artifact_ids {
        validate_identifier("artifactId", artifact_id)?;
        if !artifacts.insert(artifact_id.as_str()) {
            return Err(StoreError::InvalidDurableMemory {
                detail: format!("duplicate evidence artifact {artifact_id}"),
            });
        }
    }
    Ok(())
}

fn validate_memory_write(input: &DurableMemoryWrite) -> Result<(), StoreError> {
    validate_prefixed_identifier("memoryId", &input.id, "memory-")?;
    validate_workspace_identity(&input.workspace_identity_digest)?;
    validate_short_text("key", &input.key, 512)?;
    validate_bounded_text("value", &input.value, MAX_DURABLE_MEMORY_VALUE_BYTES)?;
    reject_secret_text("value", &input.value)?;
    if !input.confidence.is_finite() || !(0.0..=1.0).contains(&input.confidence) {
        return Err(StoreError::InvalidDurableMemory {
            detail: "memory confidence must be between 0 and 1".into(),
        });
    }
    validate_memory_scope_fields(input)?;
    validate_memory_validity(input)?;
    for (field, timestamp) in [
        ("createdAt", &input.created_at),
        ("lastValidatedAt", &input.last_validated_at),
        ("evidenceObservedAt", &input.evidence_observed_at),
        ("at", &input.at),
    ] {
        validate_timestamp(field, timestamp)?;
    }
    if let Some(timestamp) = &input.exact_evidence_observed_at {
        validate_timestamp("exactEvidenceObservedAt", timestamp)?;
    }
    if let Some(timestamp) = &input.expires_at {
        validate_timestamp("expiresAt", timestamp)?;
    }
    validate_short_text("createdBy", &input.created_by, 128)?;
    if let Some(agent_id) = &input.created_by_agent_id {
        validate_identifier("createdByAgentId", agent_id)?;
    }
    validate_transition_text("reason", &input.reason)?;
    if input.evidence_ids.is_empty() {
        return Err(StoreError::InvalidDurableMemory {
            detail: "memory requires at least one evidence reference".into(),
        });
    }
    if input.evidence_ids.len() > MAX_DURABLE_MEMORY_REFERENCES {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("memory evidence references exceed {MAX_DURABLE_MEMORY_REFERENCES}"),
        });
    }
    validate_memory_reference_ids(&input.id, "evidence", &input.evidence_ids, "evidence-")?;
    validate_memory_reference_ids(&input.id, "supersedes", &input.supersedes, "memory-")?;
    validate_memory_reference_ids(&input.id, "contestedWith", &input.contested_with, "memory-")?;
    if let Some(superseded_by) = &input.superseded_by {
        validate_prefixed_identifier("supersededBy", superseded_by, "memory-")?;
        if superseded_by == &input.id {
            return Err(StoreError::InvalidDurableMemory {
                detail: "memory cannot supersede itself".into(),
            });
        }
    }
    if input.expected_revision.is_some_and(|revision| revision < 1) {
        return Err(StoreError::InvalidDurableMemory {
            detail: "expectedRevision must be positive when supplied".into(),
        });
    }
    Ok(())
}

fn validate_memory_scope_fields(input: &DurableMemoryWrite) -> Result<(), StoreError> {
    validate_optional_identifiers([
        ("sessionId", input.session_id.as_deref()),
        ("taskId", input.task_id.as_deref()),
        ("worktreeId", input.worktree_id.as_deref()),
    ])?;
    match input.scope {
        MemoryScope::Workspace => Ok(()),
        MemoryScope::Session if input.session_id.is_some() => Ok(()),
        MemoryScope::Task if input.task_id.is_some() => Ok(()),
        MemoryScope::Session => Err(StoreError::InvalidDurableMemory {
            detail: "session memory requires sessionId".into(),
        }),
        MemoryScope::Task => Err(StoreError::InvalidDurableMemory {
            detail: "task memory requires taskId".into(),
        }),
    }
}

fn validate_memory_validity(input: &DurableMemoryWrite) -> Result<(), StoreError> {
    if !input.valid_for.is_object() {
        return Err(StoreError::InvalidDurableMemory {
            detail: "validFor must be a JSON object".into(),
        });
    }
    reject_credential_payload(&input.valid_for)?;
    let encoded = serde_json::to_string(&input.valid_for)?;
    if encoded.len() > MAX_DURABLE_MEMORY_VALIDITY_BYTES {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("validFor exceeds {MAX_DURABLE_MEMORY_VALIDITY_BYTES} bytes"),
        });
    }
    let object = input.valid_for.as_object().expect("object checked above");
    for workspace_key in ["workspaceIdentity", "workspaceIdentityDigest"] {
        if let Some(value) = object.get(workspace_key) {
            let Some(identity) = value.as_str() else {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("validFor.{workspace_key} must be a string"),
                });
            };
            if identity != input.workspace_identity_digest {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("validFor.{workspace_key} must match workspaceIdentityDigest"),
                });
            }
        }
    }
    for (key, expected) in [
        ("sessionId", input.session_id.as_deref()),
        ("taskId", input.task_id.as_deref()),
        ("worktreeId", input.worktree_id.as_deref()),
    ] {
        if let Some(value) = object.get(key) {
            let Some(value) = value.as_str() else {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("validFor.{key} must be a string"),
                });
            };
            if expected != Some(value) {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("validFor.{key} must match the memory scope fields"),
                });
            }
        }
    }
    if let Some(paths) = object.get("paths") {
        let Some(paths) = paths.as_array() else {
            return Err(StoreError::InvalidDurableMemory {
                detail: "validFor.paths must be an array of workspace-relative paths".into(),
            });
        };
        let mut seen = BTreeSet::new();
        for path in paths {
            let Some(path) = path.as_str() else {
                return Err(StoreError::InvalidDurableMemory {
                    detail: "validFor.paths must contain strings".into(),
                });
            };
            validate_repository_path(path)?;
            if !seen.insert(path) {
                return Err(StoreError::InvalidDurableMemory {
                    detail: format!("validFor.paths contains duplicate path {path}"),
                });
            }
        }
    }
    Ok(())
}

fn validate_stored_memory(record: &StoredMemoryRecord) -> Result<(), StoreError> {
    let input = DurableMemoryWrite {
        id: record.id.clone(),
        workspace_identity_digest: record.workspace_identity_digest.clone(),
        scope: record.scope,
        session_id: record.session_id.clone(),
        task_id: record.task_id.clone(),
        worktree_id: record.worktree_id.clone(),
        key: record.key.clone(),
        value: record.value.clone(),
        status: record.status,
        confidence: record.confidence,
        valid_for: record.valid_for.clone(),
        created_at: record.created_at.clone(),
        last_validated_at: record.last_validated_at.clone(),
        evidence_observed_at: record.evidence_observed_at.clone(),
        exact_evidence_observed_at: record.exact_evidence_observed_at.clone(),
        expires_at: record.expires_at.clone(),
        created_by: record.created_by.clone(),
        created_by_agent_id: record.created_by_agent_id.clone(),
        evidence_ids: record.evidence_ids.clone(),
        supersedes: record.supersedes.clone(),
        superseded_by: record.superseded_by.clone(),
        contested_with: record.contested_with.clone(),
        expected_revision: Some(record.revision),
        reason: "stored validation".into(),
        at: record.last_validated_at.clone(),
    };
    validate_memory_write(&input)?;
    if record.revision < 1 || record.access_count < 0 {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("memory {} has invalid revision or access count", record.id),
        });
    }
    Ok(())
}

fn ensure_memory_evidence(
    tx: &rusqlite::Transaction<'_>,
    evidence_id: &str,
    workspace_identity_digest: &str,
    now: &str,
) -> Result<(), StoreError> {
    let row = tx
        .query_row(
            "SELECT workspace_identity_digest, freshness, expires_at
             FROM evidence_records WHERE id = ?1",
            params![evidence_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("evidence {evidence_id}"),
        })?;
    if row.0 != workspace_identity_digest {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("evidence workspace identity mismatch: {evidence_id}"),
        });
    }
    if row.1 != EvidenceFreshness::Fresh.label() {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("evidence is {}: {evidence_id}", row.1),
        });
    }
    if row.2.as_deref().is_some_and(|expires_at| expires_at <= now) {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("evidence is expired: {evidence_id}"),
        });
    }
    Ok(())
}

fn ensure_related_memory(
    tx: &rusqlite::Transaction<'_>,
    related_id: &str,
    input: &DurableMemoryWrite,
) -> Result<(), StoreError> {
    let workspace = tx
        .query_row(
            "SELECT workspace_identity_digest FROM memory_records WHERE id = ?1",
            params![related_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("related memory {related_id}"),
        })?;
    if workspace != input.workspace_identity_digest {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("related memory workspace mismatch: {related_id}"),
        });
    }
    Ok(())
}

fn insert_memory_relation(
    tx: &rusqlite::Transaction<'_>,
    memory_id: &str,
    related_id: &str,
    relation: &str,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO memory_relations (memory_id, related_memory_id, relation)
         VALUES (?1, ?2, ?3)",
        params![memory_id, related_id, relation],
    )?;
    Ok(())
}

fn memory_has_fresh_evidence(
    conn: &rusqlite::Connection,
    memory_id: &str,
    now: &str,
) -> Result<bool, StoreError> {
    let counts = conn.query_row(
        "SELECT
             COUNT(memory_evidence_links.evidence_id),
             SUM(CASE
                 WHEN evidence_records.freshness = 'fresh'
                      AND (evidence_records.expires_at IS NULL OR evidence_records.expires_at > ?2)
                 THEN 1 ELSE 0 END)
         FROM memory_evidence_links
         JOIN evidence_records ON evidence_records.id = memory_evidence_links.evidence_id
         WHERE memory_evidence_links.memory_id = ?1",
        params![memory_id, now],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            ))
        },
    )?;
    Ok(counts.0 > 0 && counts.0 == counts.1)
}

fn matches_memory_context(record: &StoredMemoryRecord, query: &MemoryRecallQuery) -> bool {
    let matching = |required: &Option<String>, actual: &Option<String>| {
        required.is_none() || required == actual
    };
    (match record.scope {
        MemoryScope::Workspace => true,
        MemoryScope::Session => matching(&record.session_id, &query.session_id),
        MemoryScope::Task => {
            matching(&record.session_id, &query.session_id)
                && matching(&record.task_id, &query.task_id)
        }
    }) && matching(&record.worktree_id, &query.worktree_id)
}

fn memory_is_expired(record: &StoredMemoryRecord, now: &str) -> bool {
    record
        .expires_at
        .as_deref()
        .is_some_and(|expires_at| expires_at <= now)
}

fn memory_matches_path(
    record: &StoredMemoryRecord,
    path: Option<&str>,
) -> Result<bool, StoreError> {
    let Some(path) = path else {
        return Ok(true);
    };
    let Some(paths) = record.valid_for.get("paths") else {
        return Ok(true);
    };
    let Some(paths) = paths.as_array() else {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("memory {} has invalid validFor.paths", record.id),
        });
    };
    for boundary in paths {
        let Some(boundary) = boundary.as_str() else {
            return Err(StoreError::InvalidDurableMemory {
                detail: format!("memory {} has a non-string validFor path", record.id),
            });
        };
        validate_repository_path(boundary)?;
        if boundary == "." || path == boundary || path.starts_with(&format!("{boundary}/")) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn compare_recalled_memory(left: &StoredMemoryRecord, right: &StoredMemoryRecord) -> Ordering {
    scope_rank(right.scope)
        .cmp(&scope_rank(left.scope))
        .then_with(|| left.key.cmp(&right.key))
        .then_with(|| right.last_validated_at.cmp(&left.last_validated_at))
        .then_with(|| left.id.cmp(&right.id))
}

fn scope_rank(scope: MemoryScope) -> u8 {
    match scope {
        MemoryScope::Workspace => 1,
        MemoryScope::Session => 2,
        MemoryScope::Task => 3,
    }
}

fn sorted_unique(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn sorted_path_bindings(values: &[EvidencePathBinding]) -> Vec<EvidencePathBinding> {
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    sorted
}

fn validate_memory_reference_ids(
    own_id: &str,
    field: &str,
    values: &[String],
    prefix: &str,
) -> Result<(), StoreError> {
    if values.len() > MAX_DURABLE_MEMORY_REFERENCES {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} references exceed {MAX_DURABLE_MEMORY_REFERENCES}"),
        });
    }
    let mut seen = BTreeSet::new();
    for value in values {
        validate_prefixed_identifier(field, value, prefix)?;
        if value == own_id {
            return Err(StoreError::InvalidDurableMemory {
                detail: "memory cannot relate to itself".into(),
            });
        }
        if !seen.insert(value.as_str()) {
            return Err(StoreError::InvalidDurableMemory {
                detail: format!("duplicate {field} reference {value}"),
            });
        }
    }
    Ok(())
}

fn validate_workspace_identity(value: &str) -> Result<(), StoreError> {
    validate_short_text("workspaceIdentityDigest", value, 512)
}

fn validate_prefixed_identifier(field: &str, value: &str, prefix: &str) -> Result<(), StoreError> {
    validate_identifier(field, value)?;
    if !value.starts_with(prefix) {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} must start with '{prefix}'"),
        });
    }
    Ok(())
}

fn validate_identifier(field: &str, value: &str) -> Result<(), StoreError> {
    validate_short_text(field, value, 512)?;
    if value.chars().any(char::is_control) {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} must not contain control characters"),
        });
    }
    Ok(())
}

fn validate_optional_identifiers<'a>(
    fields: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Result<(), StoreError> {
    for (field, value) in fields {
        if let Some(value) = value {
            validate_identifier(field, value)?;
        }
    }
    Ok(())
}

fn validate_short_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty() {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} must not be empty"),
        });
    }
    if value.len() > max_bytes {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} exceeds {max_bytes} bytes"),
        });
    }
    Ok(())
}

fn validate_bounded_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    validate_short_text(field, value, max_bytes)?;
    if value.contains('\0') {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} must not contain NUL"),
        });
    }
    Ok(())
}

fn validate_transition_text(field: &str, value: &str) -> Result<(), StoreError> {
    validate_bounded_text(field, value, 1_024)?;
    reject_secret_text(field, value)
}

fn validate_digest(value: &str) -> Result<(), StoreError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StoreError::InvalidDurableMemory {
            detail: "evidence digest must be a 64-character SHA-256 hex string".into(),
        });
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty() || !value.contains('T') {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("{field} must be a non-empty ISO-8601 timestamp"),
        });
    }
    Ok(())
}

fn validate_repository_path(path: &str) -> Result<(), StoreError> {
    if path != path.trim()
        || path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.as_bytes().get(1) == Some(&b':')
    {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("path must be canonical workspace-relative: {path}"),
        });
    }
    if path == "." {
        return Ok(());
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(StoreError::InvalidDurableMemory {
            detail: format!("path must be canonical workspace-relative: {path}"),
        });
    }
    Ok(())
}

fn reject_secret_text(field: &str, value: &str) -> Result<(), StoreError> {
    if cbc_redaction::redact_patterns_only(value).report.redacted() {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE: &str = "workspace-abc";
    const NOW: &str = "2026-08-25T00:00:00Z";

    fn evidence(id: &str) -> DurableEvidenceInput {
        DurableEvidenceInput {
            id: id.into(),
            workspace_identity_digest: WORKSPACE.into(),
            session_id: Some("ses_1".into()),
            turn_id: None,
            agent_id: Some("agent_root".into()),
            task_id: None,
            worktree_id: None,
            kind: "file_excerpt".into(),
            source: "runtime.fs.read".into(),
            digest: "a".repeat(64),
            exact: true,
            freshness: EvidenceFreshness::Fresh,
            observed_at: NOW.into(),
            expires_at: None,
            summary: "src/lib.rs exports the runtime API".into(),
            path_bindings: vec![EvidencePathBinding {
                path: "src/lib.rs".into(),
                revision_token: Some("sha256:revision".into()),
            }],
            artifact_ids: Vec::new(),
        }
    }

    fn memory(id: &str, evidence_id: &str) -> DurableMemoryWrite {
        DurableMemoryWrite {
            id: id.into(),
            workspace_identity_digest: WORKSPACE.into(),
            scope: MemoryScope::Workspace,
            session_id: None,
            task_id: None,
            worktree_id: None,
            key: "runtime.api".into(),
            value: "The runtime API is exported from src/lib.rs.".into(),
            status: MemoryStatus::Active,
            confidence: 0.9,
            valid_for: serde_json::json!({
                "workspaceIdentity": WORKSPACE,
                "paths": ["src/lib.rs"],
            }),
            created_at: NOW.into(),
            last_validated_at: NOW.into(),
            evidence_observed_at: NOW.into(),
            exact_evidence_observed_at: Some(NOW.into()),
            expires_at: None,
            created_by: "test".into(),
            created_by_agent_id: Some("agent_root".into()),
            evidence_ids: vec![evidence_id.into()],
            supersedes: Vec::new(),
            superseded_by: None,
            contested_with: Vec::new(),
            expected_revision: None,
            reason: "fresh file observation".into(),
            at: NOW.into(),
        }
    }

    #[test]
    fn evidence_backed_memory_round_trips_with_transition() {
        let mut store = SessionStore::open_in_memory().unwrap();
        store.upsert_evidence(&evidence("evidence-a")).unwrap();
        let stored = store
            .upsert_memory(&memory("memory-a", "evidence-a"))
            .unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.evidence_ids, vec!["evidence-a"]);
        let recalled = store
            .recall_memory(&MemoryRecallQuery::active_workspace(WORKSPACE, NOW))
            .unwrap();
        assert_eq!(recalled, vec![stored.clone()]);
        let transitions = store.memory_transitions("memory-a").unwrap();
        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0].from_status, None);
        assert_eq!(transitions[0].to_status, MemoryStatus::Active);
    }

    #[test]
    fn stale_or_cross_workspace_evidence_cannot_create_memory() {
        let mut store = SessionStore::open_in_memory().unwrap();
        let mut stale = evidence("evidence-stale");
        stale.freshness = EvidenceFreshness::Stale;
        store.upsert_evidence(&stale).unwrap();
        let error = store
            .upsert_memory(&memory("memory-stale", "evidence-stale"))
            .unwrap_err();
        assert!(
            matches!(error, StoreError::InvalidDurableMemory { .. }),
            "{error}"
        );

        let mut foreign = evidence("evidence-foreign");
        foreign.workspace_identity_digest = "workspace-other".into();
        store.upsert_evidence(&foreign).unwrap();
        let error = store
            .upsert_memory(&memory("memory-foreign", "evidence-foreign"))
            .unwrap_err();
        assert!(
            matches!(error, StoreError::InvalidDurableMemory { .. }),
            "{error}"
        );
        assert!(store.memory("memory-foreign").unwrap().is_none());
    }

    #[test]
    fn path_invalidation_hides_linked_memory_without_erasing_audit() {
        let mut store = SessionStore::open_in_memory().unwrap();
        store.upsert_evidence(&evidence("evidence-path")).unwrap();
        store
            .upsert_memory(&memory("memory-path", "evidence-path"))
            .unwrap();
        let invalidated = store
            .invalidate_evidence_for_path(
                WORKSPACE,
                "src",
                "workspace mutation",
                "2026-08-25T00:01:00Z",
            )
            .unwrap();
        assert_eq!(invalidated, vec!["evidence-path"]);
        assert_eq!(
            store
                .recall_memory(&MemoryRecallQuery::active_workspace(WORKSPACE, NOW))
                .unwrap(),
            Vec::<StoredMemoryRecord>::new()
        );
        let evidence = store.evidence("evidence-path").unwrap().unwrap();
        assert_eq!(evidence.input.freshness, EvidenceFreshness::Invalid);
        assert_eq!(
            evidence.invalidation_reason.as_deref(),
            Some("workspace mutation")
        );
        assert!(store.memory("memory-path").unwrap().is_some());
    }

    #[test]
    fn memory_updates_require_the_current_revision_and_remain_atomic() {
        let mut store = SessionStore::open_in_memory().unwrap();
        store
            .upsert_evidence(&evidence("evidence-revision"))
            .unwrap();
        let initial = store
            .upsert_memory(&memory("memory-revision", "evidence-revision"))
            .unwrap();
        let mut stale_update = memory("memory-revision", "evidence-revision");
        stale_update.value = "Changed value".into();
        stale_update.expected_revision = Some(99);
        stale_update.status = MemoryStatus::Contested;
        let error = store.upsert_memory(&stale_update).unwrap_err();
        assert!(
            matches!(error, StoreError::MemoryRevisionConflict { .. }),
            "{error}"
        );
        assert_eq!(store.memory("memory-revision").unwrap().unwrap(), initial);

        let mut update = memory("memory-revision", "evidence-revision");
        update.expected_revision = Some(1);
        update.last_validated_at = "2026-08-25T00:02:00Z".into();
        update.at = update.last_validated_at.clone();
        let updated = store.upsert_memory(&update).unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(
            store.memory_transitions("memory-revision").unwrap().len(),
            2
        );
    }

    #[test]
    fn durable_memory_survives_reopen_and_rejects_secret_summary() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut store = SessionStore::open(dir.path()).unwrap();
            store.upsert_evidence(&evidence("evidence-reopen")).unwrap();
            store
                .upsert_memory(&memory("memory-reopen", "evidence-reopen"))
                .unwrap();
        }
        let reopened = SessionStore::open(dir.path()).unwrap();
        assert_eq!(
            reopened
                .recall_memory(&MemoryRecallQuery::active_workspace(WORKSPACE, NOW))
                .unwrap()
                .len(),
            1
        );

        let mut store = SessionStore::open_in_memory().unwrap();
        let mut secret = evidence("evidence-secret");
        secret.summary = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345".into();
        let error = store.upsert_evidence(&secret).unwrap_err();
        assert!(
            matches!(error, StoreError::CredentialRejected { .. }),
            "{error}"
        );
    }
}
