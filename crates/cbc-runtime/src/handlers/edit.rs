//! Structured edit-plan handlers.
//!
//! A preview is side-effect free, but application repeats the same Rust
//! preflight against a fresh, guard-constrained snapshot and stages the complete
//! result through FileTransaction. The TypeScript preflight therefore never
//! becomes write authority.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use cbc_patch::{
    preflight_edit_plan, ConflictPolicy, EditAnchor, EditError, EditOperation, EditPlan,
    EditSource, EditableDocument, PreparedEditPlan, PreparedFileKind, TransactionError,
};
use cbc_protocol::{error_codes, RpcError};
use cbc_session_store::{
    EditOperationRecord, EditPlanRecord, EditReceiptRecord, SessionStore, StoreError,
};
use cbc_workspace::{PathIntent, ResolveOptions, Workspace};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::handlers::transaction;
use crate::server::{
    fs_error, guard_error, optional_bool, optional_str, required_str, transaction_error,
    RuntimeState,
};

/// Preflight a plan against a fresh workspace snapshot without opening a
/// transaction or consuming a capability receipt.
pub fn preview(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let plan = parse_plan(&params)?;
    let documents = snapshot_edit_documents(&plan, &ws, |path| {
        ws.resolve(path, PathIntent::Write, &preview_options(&params))
            .map_err(guard_error)
    })?;
    let prepared = preflight_for_workspace(state, &plan, &documents)?;
    persist_preview(state, &plan, &prepared)?;
    Ok(public_prepared(state, &prepared))
}

/// Re-run the entire preflight immediately before atomically staging the result
/// into an already capability-bound transaction.
pub fn apply(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;
    let plan = parse_plan(&params)?;
    let lease = transaction::lease_for(state, &transaction_id);

    let documents = snapshot_edit_documents(&plan, &ws, |path| {
        transaction::resolve_write(&ws, path, lease.clone(), &params)
    })?;
    let prepared = preflight_for_workspace(state, &plan, &documents)?;
    if let Some(expected) = optional_str(&params, "expectedPlanDigest") {
        if expected != prepared.plan_digest {
            return Err(RpcError::with_data(
                error_codes::INVALID_ARGUMENT,
                "edit plan digest does not match expectedPlanDigest",
                json!({
                    "taxonomy": "HASH_MISMATCH",
                    "editCode": "EDIT_PREVIEW_STALE",
                    "expectedPlanDigest": expected,
                    "planDigest": prepared.plan_digest,
                }),
            ));
        }
    }

    // The preflight result is the only content that reaches FileTransaction.
    // Check every text payload before the lock so a capability failure cannot
    // leave a partial stage behind.
    for change in &prepared.files {
        if !matches!(
            change.kind,
            PreparedFileKind::Modify | PreparedFileKind::Create
        ) {
            continue;
        }
        let content = change.text.as_deref().ok_or_else(|| {
            RpcError::internal(format!(
                "preflight returned a {:?} change without staged text",
                change.kind
            ))
        })?;
        let resolved = transaction::resolve_write(&ws, &change.path, lease.clone(), &params)?;
        transaction::authorize_secret_write(state, &ws, &params, &resolved, content)?;
    }

    let ws_for_resolve = ws.clone();
    let lease_for_resolve = lease.clone();
    let params_for_resolve = params.clone();
    let resolver = move |path: &str| -> Result<std::path::PathBuf, TransactionError> {
        transaction::resolve_write(
            &ws_for_resolve,
            path,
            lease_for_resolve.clone(),
            &params_for_resolve,
        )
        .map(|resolved| resolved.absolute)
        .map_err(|error| TransactionError::InvalidState {
            state: error
                .data
                .as_ref()
                .and_then(|data| data.get("taxonomy"))
                .and_then(Value::as_str)
                .unwrap_or("guard")
                .to_owned(),
            action: error.to_string(),
        })
    };

    let staged_paths = {
        let mut guard = state.transactions.lock().expect("tx lock");
        let transaction = guard
            .get_mut(&transaction_id)
            .ok_or_else(|| missing_transaction(&transaction_id))?;
        transaction
            .stage_prepared_edit_plan(&prepared.files, &resolver)
            .map_err(transaction_error)?;
        transaction.staged_paths()
    };

    persist_apply(state, &plan, &prepared, &transaction_id)?;

    let mut response = public_prepared(state, &prepared);
    response["transactionId"] = json!(transaction_id);
    response["stagedPaths"] = json!(staged_paths);
    Ok(response)
}

fn parse_plan(params: &Value) -> Result<EditPlan, RpcError> {
    let value = params
        .get("plan")
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("missing required object param 'plan'"))?;
    serde_json::from_value(value)
        .map_err(|error| RpcError::invalid_params(format!("invalid edit plan: {error}")))
}

fn preview_options(params: &Value) -> ResolveOptions {
    ResolveOptions {
        allow_absolute: optional_bool(params, "allowAbsolute", false),
        allow_missing: true,
        lease_globs: None,
        allow_sensitive: false,
        allowed_roots: Vec::new(),
    }
}

fn snapshot_edit_documents(
    plan: &EditPlan,
    ws: &Workspace,
    mut resolve: impl FnMut(&str) -> Result<cbc_workspace::ResolvedPath, RpcError>,
) -> Result<Vec<EditableDocument>, RpcError> {
    let mut paths = BTreeSet::new();
    for operation in &plan.operations {
        paths.insert(operation.path().to_owned());
        if let EditOperation::MoveFile { to_path, .. } = operation {
            paths.insert(to_path.clone());
        }
    }

    let mut documents = Vec::new();
    for path in paths {
        let resolved = resolve(&path)?;
        if !resolved.exists {
            continue;
        }
        if !resolved.absolute.is_file() {
            return Err(RpcError::invalid_params(format!(
                "structured edit target '{}' must be a regular file",
                resolved.relative
            )));
        }
        let relative = Path::new(&resolved.relative);
        if cbc_fs::is_probably_binary_beneath(ws.root(), relative).map_err(fs_error)? {
            return Err(RpcError::taxonomy(
                error_codes::UNSUPPORTED_ENCODING,
                "UNSUPPORTED_ENCODING",
                format!(
                    "structured edit does not support binary target '{}'",
                    resolved.relative
                ),
            ));
        }
        let (text, revision) =
            cbc_fs::read_text_beneath(ws.root(), relative, cbc_fs::DEFAULT_MAX_FILE_BYTES)
                .map_err(fs_error)?;
        documents.push(EditableDocument {
            path,
            text,
            revision,
            is_binary: false,
        });
    }
    Ok(documents)
}

fn preflight_for_workspace(
    state: &RuntimeState,
    plan: &EditPlan,
    documents: &[EditableDocument],
) -> Result<PreparedEditPlan, RpcError> {
    let workspace_identity = state
        .workspace_id
        .lock()
        .expect("workspace id lock")
        .clone();
    preflight_edit_plan(plan, &workspace_identity, documents).map_err(edit_error)
}

fn edit_error(error: EditError) -> RpcError {
    let (code, taxonomy) = match &error {
        EditError::RevisionMismatch { .. } => (error_codes::HASH_MISMATCH, "HASH_MISMATCH"),
        EditError::ScopeViolation { .. } => (
            error_codes::PATH_OUTSIDE_WORKSPACE,
            "PATH_OUTSIDE_WORKSPACE",
        ),
        EditError::BinaryUnsupported { .. } | EditError::EncodingMismatch { .. } => {
            (error_codes::UNSUPPORTED_ENCODING, "UNSUPPORTED_ENCODING")
        }
        EditError::FileTooLarge { .. } => (error_codes::OUTPUT_LIMIT, "OUTPUT_LIMIT"),
        _ => (error_codes::INVALID_ARGUMENT, "INVALID_ARGUMENT"),
    };
    let path = match &error {
        EditError::RevisionMismatch { path, .. }
        | EditError::AnchorNotFound { path, .. }
        | EditError::AnchorAmbiguous { path, .. }
        | EditError::Overlap { path, .. }
        | EditError::BinaryUnsupported { path, .. }
        | EditError::FileTooLarge { path, .. }
        | EditError::EncodingMismatch { path, .. } => Some(path.clone()),
        EditError::RangeInvalid { path, .. }
        | EditError::PathConflict { path, .. }
        | EditError::ScopeViolation { path, .. } => path.clone(),
        EditError::TokenInvalid { .. } => None,
    };
    let operation_id = match &error {
        EditError::RevisionMismatch { operation_id, .. }
        | EditError::RangeInvalid { operation_id, .. }
        | EditError::EncodingMismatch { operation_id, .. }
        | EditError::PathConflict { operation_id, .. }
        | EditError::ScopeViolation { operation_id, .. } => operation_id.clone(),
        EditError::AnchorNotFound { operation_id, .. }
        | EditError::AnchorAmbiguous { operation_id, .. }
        | EditError::Overlap { operation_id, .. }
        | EditError::BinaryUnsupported { operation_id, .. } => Some(operation_id.clone()),
        EditError::FileTooLarge { .. } | EditError::TokenInvalid { .. } => None,
    };

    let mut details = json!({
        "taxonomy": taxonomy,
        "editCode": error.code(),
    });
    let object = details.as_object_mut().expect("json object");
    if let Some(path) = path {
        object.insert("path".to_owned(), json!(path));
    }
    if let Some(operation_id) = operation_id {
        object.insert("operationId".to_owned(), json!(operation_id));
    }
    if let EditError::FileTooLarge { bytes, maximum, .. } = &error {
        object.insert("bytes".to_owned(), json!(bytes));
        object.insert("maximum".to_owned(), json!(maximum));
    }
    RpcError::with_data(code, error.to_string(), details)
}

fn public_prepared(state: &RuntimeState, prepared: &PreparedEditPlan) -> Value {
    let files = public_prepared_files(prepared);
    let resolved_operations = public_resolved_operations(prepared);
    let diff_preview = prepared
        .diff_preview
        .iter()
        .map(|line| {
            json!({
                "path": line.path,
                "kind": serde_json::to_value(line.kind).expect("diff kind serializes"),
                "text": state.safe_text(&line.text),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "status": serde_json::to_value(prepared.status).expect("preflight status serializes"),
        "planId": prepared.plan_id,
        "planDigest": prepared.plan_digest,
        "resolvedOperations": resolved_operations,
        "files": files,
        "diffPreview": diff_preview,
    })
}

fn public_prepared_files(prepared: &PreparedEditPlan) -> Vec<Value> {
    prepared
        .files
        .iter()
        .map(|change| {
            let mut value = json!({
                "kind": serde_json::to_value(change.kind).expect("prepared kind serializes"),
                "path": change.path,
                "operationIds": change.operation_ids,
                "additions": change.additions,
                "deletions": change.deletions,
            });
            if let Some(previous_path) = &change.previous_path {
                value["previousPath"] = json!(previous_path);
            }
            if let Some(revision_before) = &change.revision_before {
                value["revisionBefore"] = json!(revision_before);
            }
            if let Some(revision_after) = &change.revision_after {
                value["revisionAfter"] = json!(revision_after);
            }
            value
        })
        .collect()
}

fn public_resolved_operations(prepared: &PreparedEditPlan) -> Vec<Value> {
    prepared
        .resolved_operations
        .iter()
        .map(|edit| {
            json!({
                "operationId": edit.operation_id,
                "path": edit.path,
                "byteRange": {
                    "start": edit.byte_range.start,
                    "end": edit.byte_range.end,
                },
                "resolution": serde_json::to_value(&edit.resolution)
                    .expect("resolution evidence serializes"),
            })
        })
        .collect()
}

fn persist_preview(
    state: &RuntimeState,
    plan: &EditPlan,
    prepared: &PreparedEditPlan,
) -> Result<(), RpcError> {
    if plan.session_id.trim().is_empty() {
        return Ok(());
    }
    let record = plan_record(plan, prepared, "previewed", None);
    let operations = operation_records(plan, prepared, "previewed")?;
    with_store(state, |store| store.record_edit_plan(&record, &operations))
}

fn persist_apply(
    state: &RuntimeState,
    plan: &EditPlan,
    prepared: &PreparedEditPlan,
    transaction_id: &str,
) -> Result<(), RpcError> {
    if plan.session_id.trim().is_empty() {
        return Ok(());
    }
    let created_at = cbc_patch::now_iso8601();
    let receipt_id = edit_receipt_id(&plan.id, transaction_id, &created_at);
    let receipt = EditReceiptRecord {
        id: receipt_id.clone(),
        plan_id: plan.id.clone(),
        transaction_id: Some(transaction_id.to_owned()),
        receipt_json: json!({
            "schemaVersion": "1.0",
            "id": receipt_id,
            "planId": plan.id,
            "planDigest": prepared.plan_digest,
            "status": "staged",
            "createdAt": created_at,
            "transactionId": transaction_id,
            "files": public_prepared_files(prepared),
            "resolvedOperations": public_resolved_operations(prepared),
        }),
        created_at: created_at.clone(),
    };
    let record = plan_record(plan, prepared, "staged", Some(&created_at));
    let operations = operation_records(plan, prepared, "staged")?;
    with_store(state, |store| {
        if store.edit_plan(&plan.id)?.is_none() {
            store.record_edit_plan(&record, &operations)?;
        }
        store.record_edit_receipt(&receipt)?;
        store.complete_edit_plan(&plan.id, "staged", &created_at)?;
        Ok(())
    })
}

fn with_store(
    state: &RuntimeState,
    f: impl FnOnce(&mut SessionStore) -> Result<(), StoreError>,
) -> Result<(), RpcError> {
    let mut guard = state.store.lock().expect("store lock");
    let Some(store) = guard.as_mut() else {
        return Ok(());
    };
    f(store).map_err(|error| {
        RpcError::internal(format!("cannot persist edit plan or receipt: {error}"))
    })
}

fn plan_record(
    plan: &EditPlan,
    prepared: &PreparedEditPlan,
    status: &str,
    completed_at: Option<&str>,
) -> EditPlanRecord {
    EditPlanRecord {
        id: plan.id.clone(),
        session_id: plan.session_id.clone(),
        turn_id: plan.turn_id.clone(),
        agent_id: plan.agent_id.clone(),
        source: edit_source_label(plan.source).to_owned(),
        workspace_identity_digest: plan.workspace_identity_digest.clone(),
        worktree_id: plan.worktree_id.clone(),
        base_workspace_revision: plan.base_workspace_revision.clone(),
        plan_digest: prepared.plan_digest.clone(),
        conflict_policy: conflict_policy_label(plan.conflict_policy).to_owned(),
        status: status.to_owned(),
        created_at: plan.created_at.clone(),
        completed_at: completed_at.map(str::to_owned),
    }
}

fn operation_records(
    plan: &EditPlan,
    prepared: &PreparedEditPlan,
    status: &str,
) -> Result<Vec<EditOperationRecord>, RpcError> {
    let resolved = prepared
        .resolved_operations
        .iter()
        .map(|edit| (edit.operation_id.as_str(), edit))
        .collect::<BTreeMap<_, _>>();
    plan.operations
        .iter()
        .enumerate()
        .map(|(index, operation)| {
            let resolved = resolved.get(operation.operation_id());
            Ok(EditOperationRecord {
                id: operation.operation_id().to_owned(),
                plan_id: plan.id.clone(),
                ordinal: i64::try_from(index).unwrap_or(i64::MAX),
                kind: operation_kind(operation).to_owned(),
                path: operation.path().to_owned(),
                base_revision: operation_base_revision(operation),
                operation_json: serde_json::to_value(operation).map_err(|error| {
                    RpcError::internal(format!("cannot serialize edit operation: {error}"))
                })?,
                resolved_range_json: resolved.map(|edit| {
                    json!({
                        "start": edit.byte_range.start,
                        "end": edit.byte_range.end,
                    })
                }),
                resolution_evidence_json: resolved
                    .map(|edit| {
                        serde_json::to_value(&edit.resolution).map_err(|error| {
                            RpcError::internal(format!(
                                "cannot serialize resolution evidence: {error}"
                            ))
                        })
                    })
                    .transpose()?,
                status: status.to_owned(),
                error_code: None,
            })
        })
        .collect()
}

fn edit_receipt_id(plan_id: &str, transaction_id: &str, created_at: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plan_id.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(transaction_id.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(created_at.as_bytes());
    format!("edr_{:x}", hasher.finalize())
}

fn edit_source_label(source: EditSource) -> &'static str {
    match source {
        EditSource::Model => "model",
        EditSource::Lsp => "lsp",
        EditSource::Plugin => "plugin",
        EditSource::Merge => "merge",
        EditSource::User => "user",
    }
}

fn conflict_policy_label(policy: ConflictPolicy) -> &'static str {
    match policy {
        ConflictPolicy::Fail => "fail",
        ConflictPolicy::SafeRebase => "safe_rebase",
    }
}

fn operation_kind(operation: &EditOperation) -> &'static str {
    match operation {
        EditOperation::ReplaceAnchor { .. } => "replace_anchor",
        EditOperation::ReplaceRange { .. } => "replace_range",
        EditOperation::InsertBefore { .. } => "insert_before",
        EditOperation::InsertAfter { .. } => "insert_after",
        EditOperation::DeleteAnchor { .. } => "delete_anchor",
        EditOperation::CreateFile { .. } => "create_file",
        EditOperation::MoveFile { .. } => "move_file",
        EditOperation::DeleteFile { .. } => "delete_file",
    }
}

fn operation_base_revision(operation: &EditOperation) -> Option<String> {
    match operation {
        EditOperation::ReplaceAnchor { anchor, .. }
        | EditOperation::InsertBefore { anchor, .. }
        | EditOperation::InsertAfter { anchor, .. }
        | EditOperation::DeleteAnchor { anchor, .. } => Some(anchor_base_revision(anchor)),
        EditOperation::ReplaceRange { base_revision, .. } => Some(base_revision.clone()),
        EditOperation::MoveFile {
            expected_revision, ..
        }
        | EditOperation::DeleteFile {
            expected_revision, ..
        } => expected_revision.clone(),
        EditOperation::CreateFile { .. } => None,
    }
}

fn anchor_base_revision(anchor: &EditAnchor) -> String {
    match anchor {
        EditAnchor::ExactText(anchor) => anchor.base_revision.clone(),
        EditAnchor::Context(anchor) => anchor.base_revision.clone(),
        EditAnchor::Symbol(anchor) => anchor.base_revision.clone(),
    }
}

fn missing_transaction(id: &str) -> RpcError {
    RpcError::taxonomy(
        error_codes::INVALID_ARGUMENT,
        "INVALID_ARGUMENT",
        format!("no open transaction '{id}'"),
    )
}
