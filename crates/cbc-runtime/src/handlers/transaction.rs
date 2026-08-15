//! `fs.transaction.*`, `fs.patch`, `fs.write`, `fs.move`, `fs.delete` handlers —
//! PRD §12.5, §12.6, §15.8, §20.3, AC-11, AC-13, AC-14, AC-24.
//!
//! The write lease recorded at `fs.transaction.begin` is re-checked by the path
//! guard on every staged mutation, so an executor subagent cannot widen its own
//! scope (AC-24) even if the control plane asked it to.

use std::path::PathBuf;

use cbc_fs::WriteIntent;
use cbc_patch::{parse_unified_diff, FileTransaction, TransactionState, UndoStatus};
use cbc_protocol::{error_codes, RpcError};
use cbc_workspace::{PathIntent, ResolveOptions, Workspace};
use serde_json::{json, Value};

use crate::server::{
    guard_error, optional_bool, optional_str, required_str, string_array, transaction_error,
    RuntimeState,
};

fn lease_for(state: &RuntimeState, transaction_id: &str) -> Option<Vec<String>> {
    state
        .leases
        .lock()
        .expect("lease lock")
        .get(transaction_id)
        .cloned()
}

fn write_options(lease: Option<Vec<String>>, params: &Value) -> ResolveOptions {
    ResolveOptions {
        allow_absolute: optional_bool(params, "allowAbsolute", false),
        allow_missing: true,
        lease_globs: lease,
        allow_sensitive: false,
        allowed_roots: Vec::new(),
    }
}

fn resolve_write(
    ws: &Workspace,
    path: &str,
    lease: Option<Vec<String>>,
    params: &Value,
) -> Result<cbc_workspace::ResolvedPath, RpcError> {
    ws.resolve(path, PathIntent::Write, &write_options(lease, params))
        .map_err(guard_error)
}

/// Capability resources historically arrived in both workspace-relative and
/// absolute spellings (the host normalizes model paths, while direct RPC clients
/// are allowed to bind an absolute path).  Sensitive-content writes must accept
/// either spelling only when both resolve to the exact same canonical workspace
/// path.  Comparing the raw strings made an otherwise valid `fs.write` appear to
/// succeed through staging and then fail before persistence at the redaction gate.
fn receipt_covers_path(
    ws: &Workspace,
    resources: &[String],
    resolved: &cbc_workspace::ResolvedPath,
) -> bool {
    resources.iter().any(|resource| {
        if resource == &resolved.relative {
            return true;
        }
        // Environment bindings are capability resources for process execution,
        // not filesystem paths; attempting to resolve them would be misleading.
        if resource.starts_with("env:sha256:") {
            return false;
        }
        ws.resolve(
            resource,
            PathIntent::Write,
            &ResolveOptions {
                allow_absolute: true,
                allow_missing: true,
                // This is only canonicalization for an already-resolved target;
                // the actual write path was resolved with the normal sensitive
                // path guard above.
                allow_sensitive: true,
                ..ResolveOptions::default()
            },
        )
        .is_ok_and(|candidate| candidate.absolute == resolved.absolute)
    })
}

fn missing_transaction(id: &str) -> RpcError {
    RpcError::taxonomy(
        error_codes::INVALID_ARGUMENT,
        "INVALID_ARGUMENT",
        format!("no open transaction '{id}'"),
    )
}

pub fn begin(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    // §19.5: the runtime is the final boundary — an untrusted or read-only
    // workspace can never open a mutation, no matter what the control plane says.
    state.require_mutation_allowed()?;
    let id = optional_str(&params, "transactionId").unwrap_or_else(|| state.next_transaction_id());
    state.bind_transaction_capability(&id, &params)?;
    let turn_id = optional_str(&params, "turnId");
    let agent_id = optional_str(&params, "agentId");
    let lease = string_array(&params, "leasePathGlobs");
    // §11.2: the approach this transaction belongs to. Recorded at `begin` because
    // that is the only moment the caller reliably knows it — by the time reflection
    // decides to abandon an approach, the transactions are already closed.
    let checkpoint_id = optional_str(&params, "checkpointId");

    let transaction = FileTransaction::begin(id.clone(), turn_id.clone(), agent_id.clone())
        .with_checkpoint(checkpoint_id.clone())
        .with_workspace_root(ws.root().to_path_buf());
    let started_at = transaction.started_at().to_string();

    state
        .transactions
        .lock()
        .expect("tx lock")
        .insert(id.clone(), transaction);
    if !lease.is_empty() {
        state
            .leases
            .lock()
            .expect("lease lock")
            .insert(id.clone(), lease.clone());
    }

    // P0-07 durable intent: the transaction exists in the store before any file
    // is touched, so a crash can never leave a mutation nobody knows about. An
    // `open` row means "staged at most, nothing applied".
    {
        let mut store_guard = state.store.lock().expect("store lock");
        if let Some(store) = store_guard.as_mut() {
            store
                .record_transaction(
                    &id,
                    turn_id.as_deref(),
                    agent_id.as_deref(),
                    "open",
                    &started_at,
                    None,
                    &[],
                )
                .map_err(|e| {
                    RpcError::internal(format!("cannot record transaction intent: {e}"))
                })?;
        }
    }

    Ok(json!({
        "transactionId": id,
        "capabilityReceipt": params.get("capabilityReceipt").cloned().unwrap_or(Value::Null),
        "turnId": turn_id,
        "agentId": agent_id,
        "checkpointId": checkpoint_id,
        "state": "open",
        "leasePathGlobs": lease,
        "startedAt": started_at,
    }))
}

pub fn patch(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;
    let diff = required_str(&params, "diff")?;
    let lease = lease_for(state, &transaction_id);

    let parsed = parse_unified_diff(&diff).map_err(|e| {
        RpcError::taxonomy(
            error_codes::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            format!("patch could not be parsed: {e}. Use fs.write with intent=create for a new file, or provide a unified diff with --- a/path and +++ b/path headers plus a valid hunk header like '@@ -0,0 +1,3 @@' (bare '@@' is not valid)."),
        )
    })?;

    // Attach expected hashes supplied by the caller so optimistic concurrency
    // applies per file (§12.5).
    let mut parsed = parsed;
    if let Some(map) = params.get("expectedHashes").and_then(Value::as_object) {
        for file in parsed.files.iter_mut() {
            if let Some(hash) = map.get(&file.path).and_then(Value::as_str) {
                file.expected_hash = Some(hash.to_string());
            }
        }
    }

    let ws_for_resolve = ws.clone();
    let lease_for_resolve = lease.clone();
    let params_for_resolve = params.clone();
    let resolver =
        move |relative: &str| -> Result<std::path::PathBuf, cbc_patch::TransactionError> {
            ws_for_resolve
                .resolve(
                    relative,
                    PathIntent::Write,
                    &write_options(lease_for_resolve.clone(), &params_for_resolve),
                )
                .map(|r| r.absolute)
                .map_err(|e| cbc_patch::TransactionError::InvalidState {
                    state: e.taxonomy().to_string(),
                    action: e.to_string(),
                })
        };

    let mut guard = state.transactions.lock().expect("tx lock");
    let transaction = guard
        .get_mut(&transaction_id)
        .ok_or_else(|| missing_transaction(&transaction_id))?;
    transaction
        .stage_patch(&parsed, &resolver)
        .map_err(transaction_error)?;

    Ok(json!({
        "transactionId": transaction_id,
        "stagedPaths": transaction.staged_paths(),
        "files": parsed.files.iter().map(|f| json!({
            "path": f.path,
            "kind": f.kind,
            "hunks": f.hunks.len(),
        })).collect::<Vec<_>>(),
    }))
}

pub fn write(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;
    let path = required_str(&params, "path")?;
    let content = required_str(&params, "content")?;
    let intent = match optional_str(&params, "intent").as_deref() {
        Some("create") => WriteIntent::Create,
        Some("replace") => WriteIntent::Replace,
        Some("upsert") | None => WriteIntent::Upsert,
        Some(other) => {
            return Err(RpcError::invalid_params(format!(
                "unknown write intent '{other}'"
            )))
        }
    };
    // Strict tool schemas may encode an omitted optional string as "". For a
    // create/upsert that is the absence sentinel, not a hash to compare with
    // `<absent>`; replace intentionally keeps an empty expectation strict.
    let expected_hash = optional_str(&params, "expectedHash").filter(|hash| {
        !(matches!(intent, WriteIntent::Create | WriteIntent::Upsert) && hash.is_empty())
    });
    let lease = lease_for(state, &transaction_id);
    let resolved = resolve_write(&ws, &path, lease, &params)?;

    // §12.6: scan model-generated content for credentials before writing.
    let scan = cbc_redaction::redact_patterns_only(&content);
    if scan.report.redacted() {
        let receipt_id = required_str(&params, "capabilityReceipt")?;
        let receipt = state
            .capabilities
            .lock()
            .expect("capability lock")
            .get(&receipt_id)
            .cloned()
            .ok_or_else(|| {
                RpcError::taxonomy(
                    error_codes::PERMISSION_DENIED,
                    "PERMISSION_DENIED",
                    "secret write requires a capability receipt",
                )
            })?;
        if !receipt_covers_path(&ws, &receipt.resources, &resolved) {
            return Err(RpcError::with_data(
                error_codes::PERMISSION_DENIED,
                format!("refusing to write {} because the capability receipt does not cover this sensitive path", resolved.relative),
                json!({ "taxonomy": "PERMISSION_DENIED", "detectedKinds": scan.report.kinds.iter().copied().collect::<Vec<_>>() }),
            ));
        }
    }

    let mut guard = state.transactions.lock().expect("tx lock");
    let transaction = guard
        .get_mut(&transaction_id)
        .ok_or_else(|| missing_transaction(&transaction_id))?;
    transaction
        .stage_write(
            &resolved.relative,
            &resolved.absolute,
            &content,
            intent,
            expected_hash.as_deref(),
        )
        .map_err(transaction_error)?;

    Ok(json!({
        "transactionId": transaction_id,
        "path": resolved.relative,
        "stagedPaths": transaction.staged_paths(),
    }))
}

pub fn move_path(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;
    let from = required_str(&params, "from")?;
    let to = required_str(&params, "to")?;
    let lease = lease_for(state, &transaction_id);

    let from_resolved = resolve_write(&ws, &from, lease.clone(), &params)?;
    let to_resolved = resolve_write(&ws, &to, lease, &params)?;
    let expected_hash = optional_str(&params, "expectedHash");

    let mut guard = state.transactions.lock().expect("tx lock");
    let transaction = guard
        .get_mut(&transaction_id)
        .ok_or_else(|| missing_transaction(&transaction_id))?;
    transaction
        .stage_move(
            &from_resolved.relative,
            &from_resolved.absolute,
            &to_resolved.relative,
            &to_resolved.absolute,
            expected_hash.as_deref(),
        )
        .map_err(transaction_error)?;

    Ok(json!({
        "transactionId": transaction_id,
        "from": from_resolved.relative,
        "to": to_resolved.relative,
    }))
}

pub fn delete(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;
    let path = required_str(&params, "path")?;
    let expected_hash = optional_str(&params, "expectedHash");
    let recursive = optional_bool(&params, "recursive", false);
    let lease = lease_for(state, &transaction_id);
    let resolved = ws
        .resolve(&path, PathIntent::Delete, &write_options(lease, &params))
        .map_err(guard_error)?;

    let mut guard = state.transactions.lock().expect("tx lock");
    let transaction = guard
        .get_mut(&transaction_id)
        .ok_or_else(|| missing_transaction(&transaction_id))?;
    transaction
        .stage_delete(
            &resolved.relative,
            &resolved.absolute,
            expected_hash.as_deref(),
            recursive,
        )
        .map_err(transaction_error)?;

    Ok(json!({
        "transactionId": transaction_id,
        "path": resolved.relative,
        "stagedPaths": transaction.staged_paths(),
    }))
}

pub fn commit(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;

    // P0-07 durable intent, phase 1: snapshot what is about to happen, spill every
    // pre-image, and mark the transaction `applying` — all before the first file
    // changes. A crash after this point is recoverable from the store alone.
    let (pre_images, started_at, turn_id, agent_id) = {
        let guard = state.transactions.lock().expect("tx lock");
        let transaction = guard
            .get(&transaction_id)
            .ok_or_else(|| missing_transaction(&transaction_id))?;
        (
            transaction.staged_pre_images(),
            transaction.started_at().to_string(),
            transaction.turn_id.clone(),
            transaction.agent_id.clone(),
        )
    };

    let mut pre_image_digests: Vec<Option<String>> = Vec::with_capacity(pre_images.len());
    {
        let artifacts_guard = state.artifacts.lock().expect("artifacts lock");
        if let Some(artifacts) = artifacts_guard.as_ref() {
            for pre in &pre_images {
                let digest = match &pre.pre_image {
                    Some(content) => {
                        // Raw on purpose: a recovery write must restore the exact
                        // bytes. The store is user-local and permission-restricted.
                        let reference = artifacts
                            .create(
                                content.as_bytes(),
                                "text/plain",
                                Some(&format!("pre-image: {}", pre.relative)),
                                cbc_artifacts::RetentionClass::Pinned,
                                None,
                            )
                            .map_err(|e| {
                                RpcError::internal(format!("cannot spill pre-image: {e}"))
                            })?;
                        Some(reference.digest)
                    }
                    None => None,
                };
                pre_image_digests.push(digest);
            }
        } else {
            pre_image_digests.resize(pre_images.len(), None);
        }
    }

    let applying_ops: Vec<cbc_session_store::TransactionOperation> = pre_images
        .iter()
        .zip(pre_image_digests.iter())
        .map(|(pre, digest)| cbc_session_store::TransactionOperation {
            path: pre.relative.clone(),
            kind: format!("{:?}", pre.kind).to_lowercase(),
            pre_hash: pre.pre_hash.clone(),
            post_hash: pre.post_hash.clone(),
            pre_image_artifact: digest.clone(),
            additions: 0,
            deletions: 0,
            new_path: pre.new_path.clone(),
        })
        .collect();
    {
        let mut store_guard = state.store.lock().expect("store lock");
        if let Some(store) = store_guard.as_mut() {
            store
                .record_transaction(
                    &transaction_id,
                    turn_id.as_deref(),
                    agent_id.as_deref(),
                    "applying",
                    &started_at,
                    None,
                    &applying_ops,
                )
                .map_err(|e| {
                    RpcError::internal(format!("cannot persist transaction intent: {e}"))
                })?;
        }
    }

    // Phase 2: apply the files.
    let (records, committed_at) = {
        let mut guard = state.transactions.lock().expect("tx lock");
        let transaction = guard
            .get_mut(&transaction_id)
            .ok_or_else(|| missing_transaction(&transaction_id))?;
        match transaction.commit() {
            Ok(records) => (records, transaction.committed_at().map(str::to_string)),
            Err(e) => {
                // commit() has already undone whatever it applied; reflect that in
                // the durable row so recovery does not retry it.
                let mut store_guard = state.store.lock().expect("store lock");
                let failure_status = transaction.state().label().to_string();
                if let Some(store) = store_guard.as_mut() {
                    let _ = store.record_transaction(
                        &transaction_id,
                        turn_id.as_deref(),
                        agent_id.as_deref(),
                        &failure_status,
                        &started_at,
                        None,
                        &applying_ops,
                    );
                }
                return Err(transaction_error(e));
            }
        }
    };

    // Phase 3: persist the undo journal (§18.15 `transactions` /
    // `file_operations`), keeping the pre-image artifact digests recorded above.
    let operations: Vec<cbc_session_store::TransactionOperation> = records
        .iter()
        .enumerate()
        .map(|(index, r)| cbc_session_store::TransactionOperation {
            path: r.path.clone(),
            kind: format!("{:?}", r.kind).to_lowercase(),
            pre_hash: r.pre_hash.clone(),
            post_hash: r.post_hash.clone(),
            pre_image_artifact: pre_image_digests.get(index).cloned().flatten(),
            additions: r.additions,
            deletions: r.deletions,
            new_path: r.new_path.clone(),
        })
        .collect();

    let mut store_guard = state.store.lock().expect("store lock");
    if let Some(store) = store_guard.as_mut() {
        store
            .record_transaction(
                &transaction_id,
                turn_id.as_deref(),
                agent_id.as_deref(),
                "committed",
                &started_at,
                committed_at.as_deref(),
                &operations,
            )
            .map_err(|e| RpcError::internal(format!("cannot persist transaction: {e}")))?;
    }
    drop(store_guard);

    // Pre-images are retained in memory for undo within this process; the DB row
    // records hashes so a later session can still detect user modification.
    let response = json!({
        "transactionId": transaction_id,
        "state": "committed",
        "committedAt": committed_at,
        "operations": records.iter().map(|r| json!({
            "path": r.path,
            "kind": r.kind,
            "preHash": r.pre_hash,
            "postHash": r.post_hash,
            "additions": r.additions,
            "deletions": r.deletions,
            "newPath": r.new_path,
        })).collect::<Vec<_>>(),
        "totalAdditions": records.iter().map(|r| r.additions).sum::<usize>(),
        "totalDeletions": records.iter().map(|r| r.deletions).sum::<usize>(),
    });

    state
        .leases
        .lock()
        .expect("lease lock")
        .remove(&transaction_id);
    // Recorded after the commit succeeded, so a failed commit never appears in the
    // order a checkpoint rollback would try to unwind.
    state
        .commit_order
        .lock()
        .expect("commit order lock")
        .push(transaction_id.clone());
    Ok(response)
}

/// `fs.transaction.rollback_to_checkpoint` — PRD §11.2, §12.5, §14.3.
///
/// Undoes every transaction tagged with one checkpoint id, newest first. This is
/// the runtime half of the agent's self-correction loop: when reflection concludes
/// that an entire approach was wrong, the changes that approach produced have to go
/// back, and only the runtime can decide per path whether that is safe.
///
/// A path the user edited after the agent wrote it is reported as `skipped`, never
/// overwritten (§24.1 invariant 9). A rollback is a correction of the agent's work,
/// not a licence to discard the user's.
pub fn rollback_to_checkpoint(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let ws = state.require_workspace()?;
    state.require_mutation_allowed()?;
    let checkpoint_id = required_str(&params, "checkpointId")?;

    let ws_for_resolve = ws.clone();
    let resolver = move |relative: &str| -> Result<PathBuf, cbc_patch::TransactionError> {
        ws_for_resolve
            .resolve(
                relative,
                PathIntent::Write,
                &ResolveOptions {
                    allow_absolute: false,
                    allow_missing: true,
                    // The rollback is the runtime's own compensating action, so it is
                    // not confined to the agent's lease — the lease may already have
                    // been released with the transaction it belonged to.
                    lease_globs: None,
                    allow_sensitive: false,
                    allowed_roots: Vec::new(),
                },
            )
            .map(|r| r.absolute)
            .map_err(|e| cbc_patch::TransactionError::InvalidState {
                state: e.taxonomy().to_string(),
                action: e.to_string(),
            })
    };

    let committed_order = state
        .commit_order
        .lock()
        .expect("commit order lock")
        .clone();

    let mut guard = state.transactions.lock().expect("tx lock");

    let belongs = |transaction: Option<&FileTransaction>| -> bool {
        transaction
            .and_then(|tx| tx.checkpoint_id.as_deref())
            .is_some_and(|id| id == checkpoint_id.as_str())
    };

    // Committed transactions unwind newest-first: a later one may have renamed or
    // replaced what an earlier one created, so undoing in commit order would try to
    // restore a pre-image that the next undo then deletes.
    let mut targets: Vec<String> = committed_order
        .iter()
        .rev()
        .filter(|id| belongs(guard.get(id.as_str())))
        .cloned()
        .collect();

    // Still-open transactions hold only staged work, so their order does not matter;
    // they are included so an abandoned approach leaves nothing half-prepared.
    let mut open_targets: Vec<String> = guard
        .iter()
        .filter(|(id, tx)| {
            !targets.contains(*id)
                && matches!(
                    tx.state(),
                    TransactionState::Open
                        | TransactionState::Conflicted
                        | TransactionState::RecoveryRequired
                )
                && tx.checkpoint_id.as_deref() == Some(checkpoint_id.as_str())
        })
        .map(|(id, _)| id.clone())
        .collect();
    open_targets.sort();
    targets.extend(open_targets);

    if targets.is_empty() {
        return Err(RpcError::taxonomy(
            error_codes::NOT_FOUND,
            "NOT_FOUND",
            format!("no transaction is tagged with checkpoint '{checkpoint_id}'"),
        ));
    }

    let mut reverted: Vec<String> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut rolled_back: Vec<String> = Vec::new();
    let mut discarded_staged = 0usize;

    for id in &targets {
        let Some(transaction) = guard.get_mut(id) else {
            continue;
        };
        match transaction.state() {
            TransactionState::Open | TransactionState::Conflicted => {
                discarded_staged += transaction.staged_count();
                // Discarding staged work cannot fail in a way that matters here: the
                // filesystem was never touched.
                let _ = transaction.rollback();
            }
            TransactionState::Committed | TransactionState::RecoveryRequired => {
                for outcome in transaction.undo_all(&resolver) {
                    if outcome.status == UndoStatus::Reverted {
                        reverted.push(outcome.path);
                    } else {
                        skipped.push(json!({
                            "path": outcome.path,
                            "status": format!("{:?}", outcome.status),
                            "detail": outcome.detail,
                        }));
                    }
                }
            }
            TransactionState::RolledBack => {}
        }
        rolled_back.push(id.clone());
    }
    drop(guard);

    // These transactions no longer describe anything on disk, so they must not be
    // unwound a second time by a later rollback to the same checkpoint.
    {
        let mut order = state.commit_order.lock().expect("commit order lock");
        order.retain(|id| !rolled_back.contains(id));
    }
    {
        let mut leases = state.leases.lock().expect("lease lock");
        for id in &rolled_back {
            leases.remove(id);
        }
    }

    // §18.15: the reversal is journaled like any other mutation, so `/undo` and
    // replay both see that the workspace moved.
    let mut store_guard = state.store.lock().expect("store lock");
    if let Some(store) = store_guard.as_mut() {
        let operations: Vec<cbc_session_store::TransactionOperation> = reverted
            .iter()
            .map(|path| cbc_session_store::TransactionOperation {
                path: path.clone(),
                kind: "modify".into(),
                pre_hash: None,
                post_hash: None,
                pre_image_artifact: None,
                additions: 0,
                deletions: 0,
                new_path: None,
            })
            .collect();
        let now = cbc_patch::now_iso8601();
        store
            .record_transaction(
                &format!("ckpt_rollback_{checkpoint_id}"),
                None,
                None,
                "rolled_back",
                &now,
                Some(&now),
                &operations,
            )
            .map_err(|e| RpcError::internal(format!("cannot persist rollback: {e}")))?;
    }
    drop(store_guard);

    Ok(json!({
        "checkpointId": checkpoint_id,
        "state": "rolled_back",
        "transactionsRolledBack": rolled_back,
        "revertedPaths": reverted,
        "skippedPaths": skipped,
        "discardedStagedOperations": discarded_staged,
    }))
}

pub fn rollback(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    state.require_workspace()?;
    state.require_mutation_allowed()?;
    let transaction_id = required_str(&params, "transactionId")?;
    state.require_transaction_capability(&transaction_id, &params)?;
    let (started_at, turn_id, agent_id) = {
        let mut guard = state.transactions.lock().expect("tx lock");
        let transaction = guard
            .get_mut(&transaction_id)
            .ok_or_else(|| missing_transaction(&transaction_id))?;
        let identity = (
            transaction.started_at().to_string(),
            transaction.turn_id.clone(),
            transaction.agent_id.clone(),
        );
        transaction.rollback().map_err(transaction_error)?;
        identity
    };

    // Keep the durable intent row in sync: a rolled-back transaction must not be
    // mistaken for interrupted work by startup recovery (P0-07).
    {
        let mut store_guard = state.store.lock().expect("store lock");
        if let Some(store) = store_guard.as_mut() {
            let _ = store.record_transaction(
                &transaction_id,
                turn_id.as_deref(),
                agent_id.as_deref(),
                "rolled_back",
                &started_at,
                None,
                &[],
            );
        }
    }

    state
        .leases
        .lock()
        .expect("lease lock")
        .remove(&transaction_id);
    state
        .commit_order
        .lock()
        .expect("commit order lock")
        .retain(|id| id != &transaction_id);
    Ok(json!({ "transactionId": transaction_id, "state": "rolled_back" }))
}

/// P0-07 crash recovery.
///
/// A transaction that crashed while `applying` may have written some of its files
/// and none of the rest. The durable intent row carries every operation's
/// pre-image artifact and its expected post-hash, so the runtime can finish the
/// rollback the dead process never got to: for each path, restore the pre-image
/// exactly when disk still shows the post-state, and leave everything else alone.
/// The §24.1 invariant 9 guard applies — a path the user already touched after the
/// crash is reported as skipped, never overwritten.
pub fn recover_interrupted_transactions(state: &RuntimeState) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;

    let applying_ids: Vec<String> = {
        let mut store_guard = state.store.lock().expect("store lock");
        match store_guard.as_mut() {
            Some(store) => store
                .transaction_ids_with_status("applying")
                .map_err(|e| RpcError::internal(format!("cannot read interrupted work: {e}")))?,
            None => return Ok(json!({ "recovered": [], "restored": [], "skipped": [] })),
        }
    };
    if applying_ids.is_empty() {
        return Ok(json!({ "recovered": [], "restored": [], "skipped": [] }));
    }

    let mut restored: Vec<String> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut recovery_required: Vec<String> = Vec::new();

    for id in &applying_ids {
        let skipped_before = skipped.len();
        let operations = {
            let mut store_guard = state.store.lock().expect("store lock");
            let store = store_guard.as_mut().expect("store present");
            store
                .operations_for_transaction(id)
                .map_err(|e| RpcError::internal(format!("cannot read transaction '{id}': {e}")))?
        };

        // Newest operation first, mirroring the in-memory rollback order.
        for op in operations.iter().rev() {
            recover_one_operation(state, &ws, op, &mut restored, &mut skipped);
        }
        let recovery_needed = skipped.len() > skipped_before;
        if recovery_needed {
            recovery_required.push(id.clone());
        }
        let recovery_status = if recovery_needed {
            "recovery_required"
        } else {
            "rolled_back"
        };

        let mut store_guard = state.store.lock().expect("store lock");
        if let Some(store) = store_guard.as_mut() {
            let now = cbc_patch::now_iso8601();
            let _ = store.record_transaction(
                id,
                None,
                None,
                recovery_status,
                &now,
                Some(&now),
                &operations,
            );
        }
    }

    Ok(json!({
        "recovered": applying_ids,
        "restored": restored,
        "skipped": skipped,
        "recoveryRequired": recovery_required,
    }))
}

fn recover_one_operation(
    state: &RuntimeState,
    ws: &cbc_workspace::Workspace,
    op: &cbc_session_store::TransactionOperation,
    restored: &mut Vec<String>,
    skipped: &mut Vec<Value>,
) {
    let resolve = |relative: &str| {
        ws.resolve(
            relative,
            cbc_workspace::PathIntent::Write,
            &cbc_workspace::ResolveOptions {
                allow_absolute: false,
                allow_missing: true,
                lease_globs: None,
                allow_sensitive: false,
                allowed_roots: Vec::new(),
            },
        )
        .ok()
    };

    let mut skip = |path: &str, reason: &str| {
        skipped.push(json!({ "path": path, "reason": reason }));
    };

    let Some(resolved) = resolve(&op.path) else {
        skip(&op.path, "path no longer resolves inside the workspace");
        return;
    };
    let relative = std::path::Path::new(&resolved.relative);

    let current_hash = match cbc_fs::hash_file_beneath(ws.root(), relative) {
        Ok(hash) => Some(hash),
        Err(cbc_fs::FsError::NotFound { .. }) => None,
        Err(error) => {
            skip(&op.path, &format!("cannot inspect recovery path: {error}"));
            return;
        }
    };
    let read_pre_image = || -> Option<Vec<u8>> {
        let digest = op.pre_image_artifact.as_deref()?;
        let guard = state.artifacts.lock().expect("artifacts lock");
        let artifacts = guard.as_ref()?;
        artifacts.read_by_digest(digest).ok()
    };

    match op.kind.as_str() {
        "modify" => {
            match (op.post_hash.as_deref(), current_hash.as_deref()) {
                (Some(post), Some(current)) if post == current => {
                    // The crashed process applied this write and nothing touched it
                    // since, so the pre-image restores cleanly.
                    match read_pre_image() {
                        Some(bytes) => {
                            if cbc_fs::atomic_write_beneath(
                                ws.root(),
                                relative,
                                &bytes,
                                cbc_fs::WriteIntent::Upsert,
                                None,
                            )
                            .is_ok()
                            {
                                restored.push(op.path.clone());
                            } else {
                                skip(&op.path, "pre-image restore failed");
                            }
                        }
                        None => skip(&op.path, "no pre-image artifact recorded"),
                    }
                }
                (Some(_), Some(_)) => skip(&op.path, "content changed after the crash"),
                // Never applied (or the file is gone for another reason).
                _ => {}
            }
        }
        "create" => {
            if let (Some(post), Some(current)) = (op.post_hash.as_deref(), current_hash.as_deref())
            {
                if post == current {
                    if cbc_fs::delete_path_beneath(ws.root(), relative, false).is_ok() {
                        restored.push(op.path.clone());
                    } else {
                        skip(&op.path, "could not remove created file");
                    }
                } else {
                    skip(&op.path, "content changed after the crash");
                }
            }
        }
        "delete" => {
            if current_hash.is_some() {
                // The file is present: either the delete never applied, or the user
                // recreated it. Either way the pre-image must not overwrite it.
                return;
            }
            match read_pre_image() {
                Some(bytes) => {
                    if cbc_fs::atomic_write_beneath(
                        ws.root(),
                        relative,
                        &bytes,
                        cbc_fs::WriteIntent::Upsert,
                        None,
                    )
                    .is_ok()
                    {
                        restored.push(op.path.clone());
                    } else {
                        skip(&op.path, "pre-image restore failed");
                    }
                }
                None => skip(&op.path, "no pre-image artifact recorded"),
            }
        }
        "rename" => {
            let Some(new_relative) = op.new_path.as_ref() else {
                return;
            };
            let Some(target) = resolve(new_relative) else {
                skip(
                    new_relative,
                    "rename target no longer resolves inside the workspace",
                );
                return;
            };
            let source_exists = match cbc_fs::path_exists_beneath(ws.root(), relative) {
                Ok(exists) => exists,
                Err(error) => {
                    skip(&op.path, &format!("cannot inspect rename source: {error}"));
                    return;
                }
            };
            if source_exists {
                // The rename never applied, or someone already put it back.
                return;
            }
            let target_relative = std::path::Path::new(&target.relative);
            let target_hash = match cbc_fs::hash_file_beneath(ws.root(), target_relative) {
                Ok(hash) => Some(hash),
                Err(cbc_fs::FsError::NotFound { .. }) => None,
                Err(error) => {
                    skip(
                        new_relative,
                        &format!("cannot inspect rename target: {error}"),
                    );
                    return;
                }
            };
            let applied = match (op.pre_hash.as_deref(), target_hash.as_deref()) {
                (Some(pre), Some(current)) => pre == current,
                (None, Some(_)) => true,
                _ => false,
            };
            if applied {
                if cbc_fs::move_path_beneath(ws.root(), target_relative, relative).is_ok() {
                    restored.push(op.path.clone());
                } else {
                    skip(&op.path, "could not move the file back");
                }
            } else if target_hash.is_some() {
                skip(&op.path, "rename target changed after the crash");
            }
        }
        _ => {}
    }
}
