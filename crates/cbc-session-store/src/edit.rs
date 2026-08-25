//! Durable edit-plan and receipt persistence.
//!
//! Preview and apply remain runtime-authoritative. This module only records the
//! canonical plan, resolved operations, and a bounded receipt after those
//! handlers succeed. Missing sessions are skipped so an unattached edit RPC
//! still returns its in-memory result.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{reject_credential_payload, SessionStore, StoreError, MAX_EVENT_PAYLOAD_BYTES};

/// Plan identifiers are `edp_<id>`; receipts are `edr_<id>`.
pub const EDIT_PLAN_ID_PREFIX: &str = "edp_";
pub const EDIT_RECEIPT_ID_PREFIX: &str = "edr_";
pub const EDIT_OPERATION_ID_PREFIX: &str = "edo_";

pub const EDIT_PLAN_STATUSES: &[&str] =
    &["previewed", "staged", "committed", "conflicted", "failed"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditPlanRecord {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub source: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_workspace_revision: Option<String>,
    pub plan_digest: String,
    pub conflict_policy: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditOperationRecord {
    pub id: String,
    pub plan_id: String,
    pub ordinal: i64,
    pub kind: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    pub operation_json: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_range_json: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_evidence_json: Option<serde_json::Value>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditReceiptRecord {
    pub id: String,
    pub plan_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    pub receipt_json: serde_json::Value,
    pub created_at: String,
}

impl SessionStore {
    /// Persist a plan and its operations atomically.
    ///
    /// Empty `session_id` or a session row that does not exist is a no-op
    /// (`Ok(())`). Callers such as `fs.edit` therefore do not fail an otherwise
    /// successful preview when the runtime has no attached session. SQL errors
    /// against an existing session still propagate.
    pub fn record_edit_plan(
        &mut self,
        plan: &EditPlanRecord,
        operations: &[EditOperationRecord],
    ) -> Result<(), StoreError> {
        if plan.session_id.trim().is_empty() {
            return Ok(());
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !session_exists(&tx, &plan.session_id)? {
            return Ok(());
        }
        encode_json(&plan_metadata_json(plan))?;
        for operation in operations {
            encode_json(&operation.operation_json)?;
            if let Some(range) = &operation.resolved_range_json {
                encode_json(range)?;
            }
            if let Some(evidence) = &operation.resolution_evidence_json {
                encode_json(evidence)?;
            }
        }
        tx.execute(
            "INSERT INTO edit_plans (
                id, session_id, turn_id, agent_id, source, workspace_identity_digest,
                worktree_id, base_workspace_revision, plan_digest, conflict_policy,
                status, created_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                plan.id,
                plan.session_id,
                plan.turn_id,
                plan.agent_id,
                plan.source,
                plan.workspace_identity_digest,
                plan.worktree_id,
                plan.base_workspace_revision,
                plan.plan_digest,
                plan.conflict_policy,
                plan.status,
                plan.created_at,
                plan.completed_at,
            ],
        )?;
        for operation in operations {
            tx.execute(
                "INSERT INTO edit_operations (
                    id, plan_id, ordinal, kind, path, base_revision, operation_json,
                    resolved_range_json, resolution_evidence_json, status, error_code
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    operation.id,
                    operation.plan_id,
                    operation.ordinal,
                    operation.kind,
                    operation.path,
                    operation.base_revision,
                    encode_json(&operation.operation_json)?,
                    encode_optional_json(&operation.resolved_range_json)?,
                    encode_optional_json(&operation.resolution_evidence_json)?,
                    operation.status,
                    operation.error_code,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Persist one receipt for an already-recorded plan.
    ///
    /// Missing `plan_id` is a no-op so apply can follow a skipped preview
    /// without failing the RPC. Duplicate ids and other SQL errors still fail.
    pub fn record_edit_receipt(&mut self, receipt: &EditReceiptRecord) -> Result<(), StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !plan_exists(&tx, &receipt.plan_id)? {
            return Ok(());
        }
        let receipt_json = encode_json(&receipt.receipt_json)?;
        tx.execute(
            "INSERT INTO edit_receipts (id, plan_id, transaction_id, receipt_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                receipt.id,
                receipt.plan_id,
                receipt.transaction_id,
                receipt_json,
                receipt.created_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn edit_plan(&self, id: &str) -> Result<Option<EditPlanRecord>, StoreError> {
        self.conn
            .query_row(
                "SELECT id, session_id, turn_id, agent_id, source, workspace_identity_digest,
                        worktree_id, base_workspace_revision, plan_digest, conflict_policy,
                        status, created_at, completed_at
                 FROM edit_plans WHERE id = ?1",
                params![id],
                read_edit_plan,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn edit_operations(&self, plan_id: &str) -> Result<Vec<EditOperationRecord>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT id, plan_id, ordinal, kind, path, base_revision, operation_json,
                    resolved_range_json, resolution_evidence_json, status, error_code
             FROM edit_operations WHERE plan_id = ?1 ORDER BY ordinal ASC, id ASC",
        )?;
        let rows = statement.query_map(params![plan_id], read_edit_operation)?;
        let mut operations = Vec::new();
        for row in rows {
            operations.push(row?);
        }
        Ok(operations)
    }

    pub fn edit_receipts(&self, plan_id: &str) -> Result<Vec<EditReceiptRecord>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT id, plan_id, transaction_id, receipt_json, created_at
             FROM edit_receipts WHERE plan_id = ?1 ORDER BY created_at DESC, id ASC",
        )?;
        let rows = statement.query_map(params![plan_id], read_edit_receipt)?;
        let mut receipts = Vec::new();
        for row in rows {
            receipts.push(row?);
        }
        Ok(receipts)
    }

    /// Set plan status and `completed_at`. Missing plans are a no-op so apply
    /// can follow a skipped preview.
    pub fn complete_edit_plan(
        &mut self,
        id: &str,
        status: &str,
        completed_at: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE edit_plans SET status = ?2, completed_at = ?3 WHERE id = ?1",
            params![id, status, completed_at],
        )?;
        Ok(())
    }
}

fn session_exists(tx: &rusqlite::Transaction<'_>, session_id: &str) -> Result<bool, StoreError> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        params![session_id],
        |row| row.get(0),
    )?;
    Ok(exists)
}

fn plan_exists(tx: &rusqlite::Transaction<'_>, plan_id: &str) -> Result<bool, StoreError> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM edit_plans WHERE id = ?1)",
        params![plan_id],
        |row| row.get(0),
    )?;
    Ok(exists)
}

fn plan_metadata_json(plan: &EditPlanRecord) -> serde_json::Value {
    serde_json::json!({
        "id": plan.id,
        "sessionId": plan.session_id,
        "source": plan.source,
        "workspaceIdentityDigest": plan.workspace_identity_digest,
        "planDigest": plan.plan_digest,
        "conflictPolicy": plan.conflict_policy,
        "status": plan.status,
    })
}

fn encode_json(value: &serde_json::Value) -> Result<String, StoreError> {
    reject_credential_payload(value)?;
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(StoreError::PayloadTooLarge {
            bytes: encoded.len(),
            max: MAX_EVENT_PAYLOAD_BYTES,
        });
    }
    Ok(encoded)
}

fn encode_optional_json(value: &Option<serde_json::Value>) -> Result<Option<String>, StoreError> {
    match value {
        Some(json) => Ok(Some(encode_json(json)?)),
        None => Ok(None),
    }
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

fn optional_json_column(
    raw: Option<String>,
    index: usize,
) -> rusqlite::Result<Option<serde_json::Value>> {
    match raw {
        Some(value) => json_column(value, index).map(Some),
        None => Ok(None),
    }
}

fn read_edit_plan(row: &rusqlite::Row<'_>) -> rusqlite::Result<EditPlanRecord> {
    Ok(EditPlanRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        turn_id: row.get(2)?,
        agent_id: row.get(3)?,
        source: row.get(4)?,
        workspace_identity_digest: row.get(5)?,
        worktree_id: row.get(6)?,
        base_workspace_revision: row.get(7)?,
        plan_digest: row.get(8)?,
        conflict_policy: row.get(9)?,
        status: row.get(10)?,
        created_at: row.get(11)?,
        completed_at: row.get(12)?,
    })
}

fn read_edit_operation(row: &rusqlite::Row<'_>) -> rusqlite::Result<EditOperationRecord> {
    Ok(EditOperationRecord {
        id: row.get(0)?,
        plan_id: row.get(1)?,
        ordinal: row.get(2)?,
        kind: row.get(3)?,
        path: row.get(4)?,
        base_revision: row.get(5)?,
        operation_json: json_column(row.get(6)?, 6)?,
        resolved_range_json: optional_json_column(row.get(7)?, 7)?,
        resolution_evidence_json: optional_json_column(row.get(8)?, 8)?,
        status: row.get(9)?,
        error_code: row.get(10)?,
    })
}

fn read_edit_receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<EditReceiptRecord> {
    Ok(EditReceiptRecord {
        id: row.get(0)?,
        plan_id: row.get(1)?,
        transaction_id: row.get(2)?,
        receipt_json: json_column(row.get(3)?, 3)?,
        created_at: row.get(4)?,
    })
}
