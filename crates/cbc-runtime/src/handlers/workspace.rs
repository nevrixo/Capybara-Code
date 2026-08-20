//! `workspace.*` handlers — PRD §13.6, §20.3.

use std::path::{Path, PathBuf};

use cbc_protocol::{error_codes, RpcError};
use cbc_workspace::{strip_verbatim, trust, TrustRecord, TrustState};
use serde_json::{json, Value};

use crate::server::{required_str, RuntimeState};

/// Install a live interaction mode. Plan entry is deliberately a runtime RPC
/// rather than a control-plane flag: the runtime owns the final quiescence and
/// write-admission checks.
pub fn mode_write(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let requested = params
        .get("mode")
        .or_else(|| params.get("interactionMode"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid_params("mode is required"))?;
    state.write_interaction_mode(requested)
}

pub fn inspect(state: &RuntimeState) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let git_guard = state.git.lock().expect("git lock");
    let git = git_guard.as_ref();
    let sandbox = state.sandbox.lock().expect("sandbox lock").clone();
    let canonical = ws.root().to_string_lossy().to_string();
    let fs_id = trust::filesystem_id(ws.root());
    let trust_state = state
        .trust_store
        .lock()
        .expect("trust lock")
        .state_for(&canonical, &fs_id);

    Ok(json!({
        "workspaceId": state.workspace_id.lock().expect("lock").clone(),
        "interactionMode": state.interaction_mode.lock().expect("mode lock").clone(),
        "canonicalPath": canonical,
        "fingerprint": ws.fingerprint(),
        "caseInsensitive": ws.is_case_insensitive(),
        "isGitRepository": git.map(|g| g.is_repository()).unwrap_or(false),
        "gitRoot": git
            .and_then(|g| g.git_root())
            .map(|p| p.to_string_lossy().to_string()),
        "trustState": trust_state,
        "trustLabel": trust_state.label(),
        "sandbox": sandbox,
        "dataDir": state.data_dir.lock().expect("lock").to_string_lossy().to_string(),
    }))
}

pub fn trust_read(state: &RuntimeState) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let canonical = ws.root().to_string_lossy().to_string();
    let fs_id = trust::filesystem_id(ws.root());
    let store = state.trust_store.lock().expect("trust lock");
    let trust_state = store.state_for(&canonical, &fs_id);

    Ok(json!({
        "canonicalPath": canonical,
        "filesystemId": fs_id,
        "state": trust_state,
        "label": trust_state.label(),
        "allowsProjectConfig": trust_state.allows_project_config(),
        "allowsProjectMcpStdio": trust_state.allows_project_mcp_stdio(),
        "allowsProjectAgents": trust_state.allows_project_agents(),
        "allowsProjectSkillBody": trust_state.allows_project_skill_body(),
        "allowsMutation": trust_state.allows_mutation(),
        "records": store.records.len(),
    }))
}

pub fn trust_write(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let requested = required_str(&params, "state")?;
    let new_state = match requested.as_str() {
        "untrusted" => TrustState::Untrusted,
        "trusted-once" => TrustState::TrustedOnce,
        "trusted-always" => TrustState::TrustedAlways,
        "read-only" => TrustState::ReadOnly,
        other => {
            return Err(RpcError::invalid_params(format!(
                "unknown trust state '{other}'"
            )))
        }
    };

    let canonical = ws.root().to_string_lossy().to_string();
    let fs_id = trust::filesystem_id(ws.root());
    let git_root = state
        .git
        .lock()
        .expect("git lock")
        .as_ref()
        .and_then(|g| g.git_root())
        .map(|p| p.to_string_lossy().to_string());

    {
        let mut store = state.trust_store.lock().expect("trust lock");
        if new_state == TrustState::Untrusted {
            store.remove(&canonical);
        } else {
            store.set(TrustRecord {
                canonical_path: canonical.clone(),
                filesystem_id: fs_id.clone(),
                state: new_state,
                decided_at: cbc_patch::now_iso8601(),
                git_root,
            });
        }
        // `trusted-once` is session scoped, so it is never persisted.
        if new_state != TrustState::TrustedOnce {
            let path = state.trust_path.lock().expect("path lock").clone();
            store
                .save(&path)
                .map_err(|e| RpcError::internal(format!("cannot persist trust store: {e}")))?;
        }
    }

    Ok(json!({
        "canonicalPath": canonical,
        "state": new_state,
        "label": new_state.label(),
        "persisted": new_state != TrustState::TrustedOnce,
    }))
}

fn parse_trust_state(requested: &str) -> Result<TrustState, RpcError> {
    match requested {
        "untrusted" => Ok(TrustState::Untrusted),
        "trusted-once" => Ok(TrustState::TrustedOnce),
        "trusted-always" => Ok(TrustState::TrustedAlways),
        "read-only" => Ok(TrustState::ReadOnly),
        other => Err(RpcError::invalid_params(format!(
            "unknown trust state '{other}'"
        ))),
    }
}

/// Resolve an explicit path to the trust identity the store keys on. The
/// runtime — not the host — decides canonical form and filesystem identity
/// (P0-01), so every CLI trust mutation funnels through here.
fn resolve_trust_target(params: &Value) -> Result<(PathBuf, String, String), RpcError> {
    let raw = required_str(params, "path")?;
    let requested = PathBuf::from(&raw);
    let canonical = strip_verbatim(std::fs::canonicalize(&requested).map_err(|e| {
        RpcError::with_data(
            error_codes::NOT_FOUND,
            format!("cannot resolve trust target '{raw}': {e}"),
            json!({ "path": raw, "taxonomy": "NOT_FOUND" }),
        )
    })?);
    if !canonical.is_dir() {
        return Err(RpcError::invalid_params(format!(
            "trust target '{raw}' is not a directory"
        )));
    }
    let canonical_str = canonical.to_string_lossy().to_string();
    let fs_id = trust::filesystem_id(&canonical);
    Ok((canonical, canonical_str, fs_id))
}

/// Every persisted decision for trust surfaces; the TypeScript host no longer reads
/// the store file itself (P0-01).
pub fn trust_list(state: &RuntimeState) -> Result<Value, RpcError> {
    let store = state.trust_store.lock().expect("trust lock");
    let records: Vec<Value> = store
        .records
        .values()
        .map(|record| {
            json!({
                "canonicalPath": record.canonical_path,
                "filesystemId": record.filesystem_id,
                "state": record.state,
                "decidedAt": record.decided_at,
                "gitRoot": record.git_root,
            })
        })
        .collect();
    Ok(json!({ "records": records }))
}

/// Set (or revoke, with `untrusted`) the decision for an explicit path.
pub fn trust_set(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let requested_state = parse_trust_state(&required_str(&params, "state")?)?;
    let (_canonical_path, canonical, fs_id) = resolve_trust_target(&params)?;

    let persisted = {
        let mut store = state.trust_store.lock().expect("trust lock");
        if requested_state == TrustState::Untrusted {
            store.remove(&canonical);
        } else {
            store.set(TrustRecord {
                canonical_path: canonical.clone(),
                filesystem_id: fs_id.clone(),
                state: requested_state,
                decided_at: cbc_patch::now_iso8601(),
                git_root: None,
            });
        }
        // `trusted-once` is session scoped and never reaches the store file.
        if requested_state != TrustState::TrustedOnce {
            let path = state.trust_path.lock().expect("path lock").clone();
            store
                .save(&path)
                .map_err(|e| RpcError::internal(format!("cannot persist trust store: {e}")))?;
            true
        } else {
            false
        }
    };

    Ok(json!({
        "canonicalPath": canonical,
        "filesystemId": fs_id,
        "state": requested_state,
        "label": requested_state.label(),
        "persisted": persisted,
    }))
}

/// Remove the decision for an explicit path. A directory that no longer exists
/// can still have a stale record, so removal falls back to the record's own
/// canonical path when the filesystem cannot resolve the argument.
pub fn trust_remove(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let raw = required_str(&params, "path")?;
    let resolved = std::fs::canonicalize(Path::new(&raw))
        .ok()
        .map(strip_verbatim)
        .map(|p| p.to_string_lossy().to_string());

    let (removed, canonical) = {
        let mut store = state.trust_store.lock().expect("trust lock");
        let key = match resolved.as_deref() {
            Some(canonical) if store.records.contains_key(canonical) => canonical.to_string(),
            _ => {
                // The path is gone or resolves elsewhere: match on the stored
                // canonical path so a deleted directory's decision can still be
                // cleaned up.
                let normalized = raw.replace('\\', "/");
                match store
                    .records
                    .values()
                    .find(|record| {
                        record.canonical_path == raw
                            || record.canonical_path.replace('\\', "/") == normalized
                    })
                    .map(|record| record.canonical_path.clone())
                {
                    Some(key) => key,
                    None => resolved.unwrap_or(raw.clone()),
                }
            }
        };
        let removed = store.remove(&key);
        if removed {
            let path = state.trust_path.lock().expect("path lock").clone();
            store
                .save(&path)
                .map_err(|e| RpcError::internal(format!("cannot persist trust store: {e}")))?;
        }
        (removed, key)
    };

    Ok(json!({ "canonicalPath": canonical, "removed": removed }))
}
