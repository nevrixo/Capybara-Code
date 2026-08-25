//! `memory.*` handlers — evidence-backed durable recall.
//!
//! The runtime, rather than the model or app process, binds memory to the live
//! workspace identity. `memory.remember` only accepts references to evidence that
//! was already captured by an authoritative runtime operation.

use std::collections::BTreeSet;

use cbc_protocol::{error_codes, RpcError};
use cbc_session_store::{
    DurableEvidenceInput, DurableMemoryWrite, EvidenceFreshness, EvidencePathBinding,
    MemoryRecallQuery, MemoryScope, MemoryStatus, SessionStore, StoreError, StoredMemoryRecord,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::server::{optional_str, optional_usize, required_str, RuntimeState};

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

fn reject_injected_workspace_identity(params: &Value) -> Result<(), RpcError> {
    if params
        .as_object()
        .is_some_and(|object| object.contains_key("workspaceIdentityDigest"))
    {
        return Err(RpcError::invalid_params(
            "workspaceIdentityDigest is bound by the runtime and cannot be supplied",
        ));
    }
    Ok(())
}

fn require_string_array(params: &Value, key: &str) -> Result<Vec<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Err(RpcError::invalid_params(format!(
            "missing required array param '{key}'"
        ))),
        Some(Value::Array(items)) => {
            let mut values = Vec::with_capacity(items.len());
            for item in items {
                let Some(value) = item.as_str() else {
                    return Err(RpcError::invalid_params(format!(
                        "{key} must be an array of strings"
                    )));
                };
                values.push(value.to_string());
            }
            Ok(values)
        }
        Some(_) => Err(RpcError::invalid_params(format!(
            "{key} must be an array of strings"
        ))),
    }
}

fn require_workspace_memory(
    store: &SessionStore,
    id: &str,
    workspace_identity_digest: &str,
) -> Result<StoredMemoryRecord, RpcError> {
    let memory = store.memory(id).map_err(store_error)?.ok_or_else(|| {
        RpcError::taxonomy(
            error_codes::NOT_FOUND,
            "NOT_FOUND",
            format!("memory not found: {id}"),
        )
    })?;
    if memory.workspace_identity_digest != workspace_identity_digest {
        return Err(RpcError::taxonomy(
            error_codes::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            format!("memory {id} belongs to another workspace"),
        ));
    }
    Ok(memory)
}

fn recall_query(
    workspace_identity_digest: String,
    params: &Value,
    now: String,
    default_statuses: Vec<MemoryStatus>,
    require_fresh_evidence: bool,
) -> Result<MemoryRecallQuery, RpcError> {
    let mut statuses = optional_enum_array::<MemoryStatus>(params, "statuses")?;
    if statuses.is_empty() {
        statuses = default_statuses;
    }
    Ok(MemoryRecallQuery {
        workspace_identity_digest,
        key: optional_str(params, "key"),
        text: optional_str(params, "query"),
        statuses,
        scopes: optional_enum_array::<MemoryScope>(params, "scopes")?,
        session_id: optional_str(params, "sessionId"),
        task_id: optional_str(params, "taskId"),
        worktree_id: optional_str(params, "worktreeId"),
        path: optional_str(params, "path"),
        now,
        limit: bounded_limit(params)?,
        require_fresh_evidence,
    })
}

fn evidence_is_fresh(
    store: &SessionStore,
    evidence_id: &str,
    workspace_identity_digest: &str,
    now: &str,
) -> Result<bool, RpcError> {
    let Some(evidence) = store.evidence(evidence_id).map_err(store_error)? else {
        return Ok(false);
    };
    if evidence.input.workspace_identity_digest != workspace_identity_digest {
        return Ok(false);
    }
    if evidence.invalidated_at.is_some() || evidence.input.freshness != EvidenceFreshness::Fresh {
        return Ok(false);
    }
    if evidence
        .input
        .expires_at
        .as_deref()
        .is_some_and(|expires_at| expires_at <= now)
    {
        return Ok(false);
    }
    Ok(true)
}
/// Model-facing input deliberately omits all authority-owned fields. The runtime
/// binds the claim to its initialized workspace and derives timestamps from the
/// evidence ledger, so a client cannot forge a durable fact by copying an old
/// memory payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryProposal {
    key: String,
    value: String,
    #[serde(default)]
    scope: Option<MemoryScope>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    worktree_id: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    evidence_ids: Vec<String>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
}

fn memory_proposal_id(
    workspace_identity_digest: &str,
    scope: MemoryScope,
    session_id: Option<&str>,
    task_id: Option<&str>,
    worktree_id: Option<&str>,
    key: &str,
    value: &str,
    evidence_ids: &[String],
    paths: &[String],
    confidence: f64,
) -> String {
    let mut hasher = Sha256::new();
    let mut add = |value: &str| {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    };
    for value in [
        workspace_identity_digest,
        scope.label(),
        session_id.unwrap_or(""),
        task_id.unwrap_or(""),
        worktree_id.unwrap_or(""),
        key,
        value,
        &format!("{confidence:.17}"),
    ] {
        add(value);
    }
    for evidence_id in evidence_ids {
        add(evidence_id);
    }
    for path in paths {
        add(path);
    }
    format!("memory-{:x}", hasher.finalize())
}

fn materialize_memory_proposal(
    store: &SessionStore,
    workspace_identity_digest: &str,
    proposal: &MemoryProposal,
    now: &str,
) -> Result<DurableMemoryWrite, RpcError> {
    let scope = proposal.scope.unwrap_or(MemoryScope::Workspace);
    let mut evidence_ids = proposal.evidence_ids.clone();
    evidence_ids.sort();
    evidence_ids.dedup();
    if evidence_ids.is_empty() {
        return Err(RpcError::taxonomy(
            error_codes::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            "memory.remember requires at least one evidenceId",
        ));
    }

    let mut observed_at = Vec::with_capacity(evidence_ids.len());
    let mut exact_observed_at = Vec::new();
    for evidence_id in &evidence_ids {
        let evidence = store
            .evidence(evidence_id)
            .map_err(store_error)?
            .ok_or_else(|| {
                RpcError::taxonomy(
                    error_codes::NOT_FOUND,
                    "NOT_FOUND",
                    format!("evidence not found: {evidence_id}"),
                )
            })?;
        if evidence.input.workspace_identity_digest != workspace_identity_digest {
            return Err(RpcError::taxonomy(
                error_codes::INVALID_ARGUMENT,
                "INVALID_ARGUMENT",
                format!("evidence {evidence_id} belongs to another workspace"),
            ));
        }
        if evidence.invalidated_at.is_some() || evidence.input.freshness != EvidenceFreshness::Fresh
        {
            return Err(RpcError::taxonomy(
                error_codes::INVALID_ARGUMENT,
                "INVALID_ARGUMENT",
                format!("evidence {evidence_id} is no longer fresh"),
            ));
        }
        observed_at.push(evidence.input.observed_at.clone());
        if evidence.input.exact {
            exact_observed_at.push(evidence.input.observed_at.clone());
        }
    }
    observed_at.sort();
    exact_observed_at.sort();
    let evidence_observed_at = observed_at
        .first()
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("memory.remember requires evidence"))?;

    let mut paths = proposal.paths.clone();
    paths.sort();
    paths.dedup();
    let mut valid_for = serde_json::Map::new();
    valid_for.insert(
        "workspaceIdentity".into(),
        Value::String(workspace_identity_digest.into()),
    );
    if !paths.is_empty() {
        valid_for.insert(
            "paths".into(),
            Value::Array(paths.iter().cloned().map(Value::String).collect()),
        );
    }
    for (key, value) in [
        ("sessionId", proposal.session_id.as_ref()),
        ("taskId", proposal.task_id.as_ref()),
        ("worktreeId", proposal.worktree_id.as_ref()),
    ] {
        if let Some(value) = value {
            valid_for.insert(key.into(), Value::String(value.clone()));
        }
    }
    let confidence = proposal.confidence.unwrap_or(match scope {
        MemoryScope::Workspace => 0.8,
        MemoryScope::Session | MemoryScope::Task => 0.6,
    });
    let id = memory_proposal_id(
        workspace_identity_digest,
        scope,
        proposal.session_id.as_deref(),
        proposal.task_id.as_deref(),
        proposal.worktree_id.as_deref(),
        &proposal.key,
        &proposal.value,
        &evidence_ids,
        &paths,
        confidence,
    );
    Ok(DurableMemoryWrite {
        id,
        workspace_identity_digest: workspace_identity_digest.into(),
        scope,
        session_id: proposal.session_id.clone(),
        task_id: proposal.task_id.clone(),
        worktree_id: proposal.worktree_id.clone(),
        key: proposal.key.clone(),
        value: proposal.value.clone(),
        status: MemoryStatus::Active,
        confidence,
        valid_for: Value::Object(valid_for),
        created_at: now.into(),
        last_validated_at: now.into(),
        evidence_observed_at,
        exact_evidence_observed_at: exact_observed_at.first().cloned(),
        expires_at: None,
        created_by: "runtime-model-tool".into(),
        created_by_agent_id: proposal.agent_id.clone(),
        evidence_ids,
        supersedes: Vec::new(),
        superseded_by: None,
        contested_with: Vec::new(),
        expected_revision: None,
        reason: proposal
            .reason
            .clone()
            .unwrap_or_else(|| "evidence-backed memory proposed by model".into()),
        at: now.into(),
    })
}

fn same_materialized_memory(left: &StoredMemoryRecord, right: &DurableMemoryWrite) -> bool {
    left.workspace_identity_digest == right.workspace_identity_digest
        && left.scope == right.scope
        && left.session_id == right.session_id
        && left.task_id == right.task_id
        && left.worktree_id == right.worktree_id
        && left.key == right.key
        && left.value == right.value
        && left.status == right.status
        && (left.confidence - right.confidence).abs() < f64::EPSILON
        && left.valid_for == right.valid_for
        && left.evidence_ids == right.evidence_ids
}

fn require_fresh_evidence(
    store: &SessionStore,
    memory: &DurableMemoryWrite,
) -> Result<(), RpcError> {
    let mut has_exact = false;
    for evidence_id in &memory.evidence_ids {
        let evidence = store
            .evidence(evidence_id)
            .map_err(store_error)?
            .ok_or_else(|| {
                RpcError::taxonomy(
                    error_codes::NOT_FOUND,
                    "NOT_FOUND",
                    format!("evidence not found: {evidence_id}"),
                )
            })?;
        if evidence.input.workspace_identity_digest != memory.workspace_identity_digest {
            return Err(RpcError::taxonomy(
                error_codes::INVALID_ARGUMENT,
                "INVALID_ARGUMENT",
                format!("evidence {evidence_id} belongs to another workspace"),
            ));
        }
        if evidence.invalidated_at.is_some() || evidence.input.freshness != EvidenceFreshness::Fresh
        {
            return Err(RpcError::taxonomy(
                error_codes::INVALID_ARGUMENT,
                "INVALID_ARGUMENT",
                format!("evidence {evidence_id} is no longer fresh"),
            ));
        }
        has_exact |= evidence.input.exact;
    }
    if memory.scope == MemoryScope::Workspace && !has_exact {
        return Err(RpcError::taxonomy(
            error_codes::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            "workspace memory requires at least one exact evidence record",
        ));
    }
    Ok(())
}

/// Find only fresh, visible memory in the current workspace. A client cannot
/// override the workspace digest or opt into stale evidence through this model
/// facing method.
pub fn search(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    reject_injected_workspace_identity(&params)?;
    let workspace_identity_digest = workspace_identity(state)?;
    let now = cbc_patch::now_iso8601();
    let query = recall_query(
        workspace_identity_digest.clone(),
        &params,
        now.clone(),
        Vec::new(),
        true,
    )?;
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

/// Inspect workspace memory without marking access. Defaults to active and
/// contested records; forgotten rows are returned only when requested.
pub fn list(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    reject_injected_workspace_identity(&params)?;
    let workspace_identity_digest = workspace_identity(state)?;
    let now = cbc_patch::now_iso8601();
    let query = recall_query(
        workspace_identity_digest.clone(),
        &params,
        now,
        vec![MemoryStatus::Active, MemoryStatus::Contested],
        false,
    )?;
    let records = with_store(state, |store| {
        store.recall_memory(&query).map_err(store_error)
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "memories": records,
    }))
}

/// Return one workspace-bound memory record by id, including forgotten rows.
pub fn get(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    reject_injected_workspace_identity(&params)?;
    let workspace_identity_digest = workspace_identity(state)?;
    let id = required_str(&params, "id")?;
    let memory = with_store(state, |store| {
        require_workspace_memory(store, &id, &workspace_identity_digest)
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "memory": memory,
    }))
}

/// Logical forget: keep the row and transition history, hide it from default recall.
pub fn forget(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    reject_injected_workspace_identity(&params)?;
    let workspace_identity_digest = workspace_identity(state)?;
    let id = required_str(&params, "id")?;
    let reason = optional_str(&params, "reason").unwrap_or_else(|| "logical forget".into());
    let at = cbc_patch::now_iso8601();
    let memory = with_store(state, |store| {
        store
            .forget_memory(&id, &workspace_identity_digest, &reason, &at)
            .map_err(store_error)
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "memory": memory,
    }))
}

/// Activate the winner and supersede each loser in the current workspace.
pub fn resolve_contest(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    reject_injected_workspace_identity(&params)?;
    let workspace_identity_digest = workspace_identity(state)?;
    let winner_id = required_str(&params, "winnerId")?;
    let loser_ids = require_string_array(&params, "loserIds")?;
    let reason = required_str(&params, "reason")?;
    let at = cbc_patch::now_iso8601();
    let memory = with_store(state, |store| {
        store
            .resolve_memory_contest(
                &winner_id,
                &loser_ids,
                &workspace_identity_digest,
                &reason,
                &at,
            )
            .map_err(store_error)
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "memory": memory,
    }))
}

/// Re-check whether every linked evidence record is still fresh.
pub fn verify(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    reject_injected_workspace_identity(&params)?;
    let workspace_identity_digest = workspace_identity(state)?;
    let id = required_str(&params, "id")?;
    let now = cbc_patch::now_iso8601();
    let (memory, fresh) = with_store(state, |store| {
        let memory = require_workspace_memory(store, &id, &workspace_identity_digest)?;
        let mut fresh = !memory.evidence_ids.is_empty();
        for evidence_id in &memory.evidence_ids {
            if !evidence_is_fresh(store, evidence_id, &workspace_identity_digest, &now)? {
                fresh = false;
                break;
            }
        }
        Ok((memory, fresh))
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "memory": memory,
        "fresh": fresh,
    }))
}

/// Persist an evidence-backed claim. Evidence is never accepted inline: a caller
/// must first obtain an opaque `evidenceId` from an authoritative observation such
/// as `fs.read` with `recordEvidence: true`.
pub fn remember(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let workspace_identity_digest = workspace_identity(state)?;
    let proposal: MemoryProposal = serde_json::from_value(params)
        .map_err(|error| RpcError::invalid_params(format!("invalid memory proposal: {error}")))?;
    let now = cbc_patch::now_iso8601();
    let (stored, idempotent) = with_store(state, |store| {
        let memory =
            materialize_memory_proposal(store, &workspace_identity_digest, &proposal, &now)?;
        require_fresh_evidence(store, &memory)?;
        if let Some(existing) = store.memory(&memory.id).map_err(store_error)? {
            if same_materialized_memory(&existing, &memory) {
                return Ok((existing, true));
            }
            return Err(RpcError::taxonomy(
                error_codes::TRANSACTION_CONFLICT,
                "CONFLICT",
                "memory proposal id collides with a different durable record",
            ));
        }
        Ok((store.upsert_memory(&memory).map_err(store_error)?, false))
    })?;
    Ok(json!({
        "workspaceIdentityDigest": workspace_identity_digest,
        "idempotent": idempotent,
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
