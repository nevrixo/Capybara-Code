//! `memory.*` handlers — evidence-backed durable recall.
//!
//! The runtime, rather than the model or app process, binds memory to the live
//! workspace identity. `memory.remember` only accepts references to evidence that
//! was already captured by an authoritative runtime operation.

use std::collections::BTreeSet;

use cbc_protocol::{error_codes, RpcError};
use cbc_session_store::{
    DurableEvidenceInput, EvidenceFreshness, EvidencePathBinding, MemoryRecallQuery, MemoryScope,
    MemoryStatus, SessionStore, StoreError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::server::{optional_str, optional_usize, RuntimeState};

fn store_error(error: StoreError) -> RpcError {
    let (code, taxonomy) = match &error {
        StoreError::NotFound { .. } => (error_codes::NOT_FOUND, "NOT_FOUND"),
        StoreError::CredentialRejected { .. } => {
            (error_codes::PERMISSION_DENIED, "PERMISSION_DENIED")
        }
        StoreError::MemoryRevisionConflict { .. } => {
            (error_codes::TRANSACTION_CONFLICT, "CONFLICT")
        }
        StoreError::InvalidDurableMemory { .. }
        | StoreError::InvalidCommandReceipt { .. }
        | StoreError::PayloadTooLarge { .. } => (error_codes::INVALID_ARGUMENT, "INVALID_ARGUMENT"),
        _ => (error_codes::INTERNAL_ERROR, "INTERNAL"),
    };
    RpcError::taxonomy(code, taxonomy, error.to_string())
}

fn with_store<T>(
    state: &RuntimeState,
    f: impl FnOnce(&mut SessionStore) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    let mut guard = state.store.lock().expect("store lock");
    let store = guard.as_mut().ok_or_else(|| {
        RpcError::new(
            error_codes::NOT_INITIALIZED,
            "session store not initialized",
        )
    })?;
    f(store)
}

fn workspace_identity(state: &RuntimeState) -> Result<String, RpcError> {
    Ok(state.require_workspace()?.fingerprint())
}

fn optional_enum_array<T>(params: &Value, key: &str) -> Result<Vec<T>, RpcError>
where
    T: serde::de::DeserializeOwned,
{
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
            RpcError::invalid_params(format!(
                "{key} must be an array of supported values: {error}"
            ))
        }),
    }
}

fn bounded_limit(params: &Value) -> Result<usize, RpcError> {
    let limit = optional_usize(
        params,
        "limit",
        cbc_session_store::DEFAULT_MEMORY_RECALL_LIMIT,
    );
    if limit == 0 {
        return Err(RpcError::invalid_params("limit must be greater than zero"));
    }
    Ok(limit.min(cbc_session_store::MAX_MEMORY_RECALL_LIMIT))
}

/// Find only fresh, visible memory in the current workspace. A client cannot
/// override the workspace digest or opt into stale evidence through this model
/// facing method.
pub fn search(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let workspace_identity_digest = workspace_identity(state)?;
    let now = cbc_patch::now_iso8601();
    let query = MemoryRecallQuery {
        workspace_identity_digest: workspace_identity_digest.clone(),
        key: optional_str(&params, "key"),
        text: optional_str(&params, "query"),
        statuses: optional_enum_array::<MemoryStatus>(&params, "statuses")?,
        scopes: optional_enum_array::<MemoryScope>(&params, "scopes")?,
        session_id: optional_str(&params, "sessionId"),
        task_id: optional_str(&params, "taskId"),
        worktree_id: optional_str(&params, "worktreeId"),
        path: optional_str(&params, "path"),
        now: now.clone(),
        limit: bounded_limit(&params)?,
        require_fresh_evidence: true,
    };
    let (records, limit) = with_store(state, |store| {
        let records = store.recall_memory(&query).map_err(store_error)?;
        if !records.is_empty() {
            let ids = records
                .iter()
                .map(|record| record.id.clone())
                .collect::<Vec<_>>();
            store
                .mark_memory_accessed(&ids, &now)
                .map_err(store_error)?;
        }
        Ok((records, query.limit))
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "freshEvidenceRequired": true,
        "limit": limit,
        "memories": records,
    }))
}

/// Persist an evidence-backed claim. Evidence is never accepted inline: a caller
/// must first obtain an opaque `evidenceId` from an authoritative observation such
/// as `fs.read` with `recordEvidence: true`.
pub fn remember(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let workspace_identity_digest = workspace_identity(state)?;
    let raw = params
        .get("memory")
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("memory.remember requires a memory object"))?;
    let memory: cbc_session_store::DurableMemoryWrite = serde_json::from_value(raw)
        .map_err(|error| RpcError::invalid_params(format!("invalid memory: {error}")))?;
    if memory.workspace_identity_digest != workspace_identity_digest {
        return Err(RpcError::taxonomy(
            error_codes::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            "memory.workspaceIdentityDigest must match the initialized workspace",
        ));
    }
    let stored = with_store(state, |store| {
        // Workspace-scope claims are long-lived and therefore require at least
        // one exact observation. Session/task scopes may retain a lower-confidence
        // inferred claim, but the store still requires all evidence to be fresh.
        if memory.scope == MemoryScope::Workspace {
            let has_exact = memory
                .evidence_ids
                .iter()
                .try_fold(false, |found, evidence_id| {
                    let evidence = store.evidence(evidence_id).map_err(store_error)?;
                    let evidence = evidence.ok_or_else(|| {
                        RpcError::taxonomy(
                            error_codes::NOT_FOUND,
                            "NOT_FOUND",
                            format!("evidence not found: {evidence_id}"),
                        )
                    })?;
                    Ok::<_, RpcError>(found || evidence.input.exact)
                })?;
            if !has_exact {
                return Err(RpcError::taxonomy(
                    error_codes::INVALID_ARGUMENT,
                    "INVALID_ARGUMENT",
                    "workspace memory requires at least one exact evidence record",
                ));
            }
        }
        store.upsert_memory(&memory).map_err(store_error)
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "memory": stored,
    }))
}

/// Record the exact full-file observation that `fs.read` has already guarded and
/// hashed. The record contains only path/revision metadata and a bounded summary;
/// file content remains on the filesystem or in a separately redacted artifact.
pub(crate) fn record_exact_read_evidence(
    state: &RuntimeState,
    workspace_identity_digest: &str,
    path: &str,
    revision_token: &str,
    digest: &str,
    params: &Value,
) -> Result<String, RpcError> {
    let id = exact_read_evidence_id(workspace_identity_digest, path, digest);
    let evidence = DurableEvidenceInput {
        id: id.clone(),
        workspace_identity_digest: workspace_identity_digest.into(),
        session_id: optional_str(params, "sessionId"),
        turn_id: optional_str(params, "turnId"),
        agent_id: optional_str(params, "agentId"),
        task_id: optional_str(params, "taskId"),
        worktree_id: optional_str(params, "worktreeId"),
        kind: "file_excerpt".into(),
        source: "runtime.fs.read.exact".into(),
        digest: digest.into(),
        exact: true,
        freshness: EvidenceFreshness::Fresh,
        observed_at: cbc_patch::now_iso8601(),
        expires_at: None,
        summary: format!("Exact full-file observation for {path} at revision {digest}"),
        path_bindings: vec![EvidencePathBinding {
            path: path.into(),
            revision_token: Some(revision_token.into()),
        }],
        artifact_ids: Vec::new(),
    };
    with_store(state, |store| {
        store.upsert_evidence(&evidence).map_err(store_error)?;
        Ok(())
    })?;
    Ok(id)
}

fn exact_read_evidence_id(workspace_identity_digest: &str, path: &str, digest: &str) -> String {
    let mut hasher = Sha256::new();
    for component in [workspace_identity_digest, path, digest] {
        hasher.update(component.as_bytes());
        hasher.update(b"\x1f");
    }
    format!("evidence-{:x}", hasher.finalize())
}

/// Fail closed before a filesystem mutation: all evidence whose path boundary
/// overlaps a staged operation becomes invalid. If this fails, the transaction
/// never applies files, so stale memory cannot survive an unrecorded mutation.
pub(crate) fn invalidate_paths_before_mutation(
    state: &RuntimeState,
    workspace_identity_digest: &str,
    paths: impl IntoIterator<Item = String>,
    reason: &str,
    at: &str,
) -> Result<Vec<String>, RpcError> {
    let paths = paths
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    with_store(state, |store| {
        let mut invalidated = BTreeSet::new();
        for path in &paths {
            for evidence_id in store
                .invalidate_evidence_for_path(workspace_identity_digest, path, reason, at)
                .map_err(store_error)?
            {
                invalidated.insert(evidence_id);
            }
        }
        Ok(invalidated.into_iter().collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_read_evidence_ids_are_workspace_and_path_bound() {
        let first = exact_read_evidence_id("workspace-a", "src/lib.rs", &"a".repeat(64));
        assert_ne!(
            first,
            exact_read_evidence_id("workspace-a", "src/main.rs", &"a".repeat(64))
        );
        assert_ne!(
            first,
            exact_read_evidence_id("workspace-b", "src/lib.rs", &"a".repeat(64))
        );
        assert!(first.starts_with("evidence-"));
    }
}
