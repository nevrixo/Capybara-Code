//! Structured edit-plan handlers.
//!
//! A preview is side-effect free, but application repeats the same Rust
//! preflight against a fresh, guard-constrained snapshot and stages the complete
//! result through FileTransaction. The TypeScript preflight therefore never
//! becomes write authority.

use std::collections::BTreeSet;
use std::path::Path;

use cbc_patch::{
    preflight_edit_plan, EditError, EditOperation, EditPlan, EditableDocument, PreparedEditPlan,
    PreparedFileKind, TransactionError,
};
use cbc_protocol::{error_codes, RpcError};
use cbc_workspace::{PathIntent, ResolveOptions, Workspace};
use serde_json::{json, Value};

use crate::handlers::transaction;
use crate::server::{
    fs_error, guard_error, optional_bool, required_str, transaction_error, RuntimeState,
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
    let files = prepared
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
        .collect::<Vec<_>>();
    let resolved_operations = prepared
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
        .collect::<Vec<_>>();
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

fn missing_transaction(id: &str) -> RpcError {
    RpcError::taxonomy(
        error_codes::INVALID_ARGUMENT,
        "INVALID_ARGUMENT",
        format!("no open transaction '{id}'"),
    )
}
