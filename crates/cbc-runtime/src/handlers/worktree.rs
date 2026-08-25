//! `worktree.*` and `merge.preview` handlers — managed Git worktree primitives.

use std::path::{Path, PathBuf};

use cbc_git::{GitError, WorktreeCreateOptions};
use cbc_protocol::{error_codes, RpcError};
use cbc_workspace::{PathIntent, ResolveOptions};
use serde_json::{json, Value};

use crate::server::{
    guard_error, optional_bool, optional_str, required_str, string_array, RuntimeState,
};

fn service(state: &RuntimeState) -> Result<cbc_git::GitService, RpcError> {
    state
        .git
        .lock()
        .expect("git lock")
        .clone()
        .ok_or_else(|| RpcError::new(error_codes::NOT_INITIALIZED, "git service not initialized"))
}

fn data_root(state: &RuntimeState) -> PathBuf {
    state.data_dir.lock().expect("data dir lock").clone()
}

fn git_error(state: &RuntimeState, error: GitError) -> RpcError {
    match error {
        GitError::NotARepository { path } => RpcError::with_data(
            error_codes::NOT_FOUND,
            format!("{path} is not a Git repository"),
            json!({
                "taxonomy": "NOT_FOUND",
                "path": path,
                "action": "initialize the workspace in a Git repository",
            }),
        ),
        GitError::DirtyBase => RpcError::with_data(
            error_codes::INVALID_ARGUMENT,
            "refusing to create a worktree on a dirty base",
            json!({
                "taxonomy": "INVALID_ARGUMENT",
                "action": "commit, stash, or checkpoint the base workspace first",
            }),
        ),
        GitError::PathEscapesDataRoot { path } => RpcError::with_data(
            error_codes::PATH_OUTSIDE_WORKSPACE,
            format!("worktree path escapes data root: {path}"),
            json!({
                "taxonomy": "PATH_OUTSIDE_WORKSPACE",
                "path": path,
            }),
        ),
        GitError::PathTooLong { path, bytes } => RpcError::with_data(
            error_codes::INVALID_ARGUMENT,
            format!("worktree path is too long ({bytes} bytes)"),
            json!({
                "taxonomy": "INVALID_ARGUMENT",
                "path": path,
                "bytes": bytes,
                "action": "pass allowLongPath with a long-path prefix",
            }),
        ),
        GitError::SymlinkParent { path } => RpcError::with_data(
            error_codes::PATH_OUTSIDE_WORKSPACE,
            format!("worktree path has a symlink parent: {path}"),
            json!({
                "taxonomy": "PATH_OUTSIDE_WORKSPACE",
                "path": path,
            }),
        ),
        GitError::IdentityMismatch { expected, actual } => RpcError::with_data(
            error_codes::HASH_MISMATCH,
            "worktree does not belong to this repository",
            json!({
                "taxonomy": "HASH_MISMATCH",
                "expected": expected,
                "actual": actual,
            }),
        ),
        GitError::ActiveWriter { path } => RpcError::with_data(
            error_codes::TRANSACTION_CONFLICT,
            format!("refusing to remove worktree with an active writer: {path}"),
            json!({
                "taxonomy": "TRANSACTION_CONFLICT",
                "path": path,
            }),
        ),
        GitError::HeadMismatch { expected, actual } => RpcError::with_data(
            error_codes::HASH_MISMATCH,
            "worktree HEAD did not match the requested commit",
            json!({
                "taxonomy": "HASH_MISMATCH",
                "expected": expected,
                "actual": actual,
            }),
        ),
        GitError::InvalidArgument { message } => {
            RpcError::taxonomy(error_codes::INVALID_ARGUMENT, "INVALID_ARGUMENT", message)
        }
        GitError::Io { path, message } => RpcError::with_data(
            error_codes::INTERNAL_ERROR,
            format!("io error at {path}: {message}"),
            json!({
                "taxonomy": "INTERNAL",
                "path": path,
                "retryable": true,
            }),
        ),
        GitError::GitUnavailable { message } => {
            let message = state.safe_text(&message);
            RpcError::with_data(
                error_codes::INTERNAL_ERROR,
                format!("git is unavailable: {message}"),
                json!({
                    "taxonomy": "INTERNAL",
                    "retryable": true,
                }),
            )
        }
        GitError::CommandFailed { argv, stderr } => {
            let safe_stderr = state.safe_text(&stderr);
            RpcError::with_data(
                error_codes::INTERNAL_ERROR,
                format!("git command failed: {safe_stderr}"),
                json!({
                    "taxonomy": "INTERNAL",
                    "argv": state.safe_text(&argv.join(" ")),
                    "stderr": safe_stderr,
                    "retryable": true,
                }),
            )
        }
    }
}

fn validate_revision(value: String) -> Result<String, RpcError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.contains(char::from(0))
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return Err(RpcError::with_data(
            error_codes::INVALID_ARGUMENT,
            "invalid Git revision",
            json!({
                "taxonomy": "INVALID_ARGUMENT",
                "field": "commit",
            }),
        ));
    }
    Ok(trimmed.to_string())
}

/// Resolve a managed worktree path through the workspace path guard with the
/// runtime data directory as an allowed root.
fn resolve_worktree_path(
    state: &RuntimeState,
    requested: &str,
    intent: PathIntent,
    allow_missing: bool,
) -> Result<PathBuf, RpcError> {
    if requested.contains(char::from(0)) || requested.trim().is_empty() {
        return Err(RpcError::invalid_params("invalid worktree path"));
    }
    let data_dir = data_root(state);
    let ws = state.require_workspace()?;
    let absolute = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        data_dir.join(requested)
    };
    let resolved = ws
        .resolve(
            &absolute.to_string_lossy(),
            intent,
            &ResolveOptions {
                allow_absolute: true,
                allow_missing,
                lease_globs: None,
                allow_sensitive: true,
                allowed_roots: vec![data_dir],
            },
        )
        .map_err(guard_error)?;
    Ok(resolved.absolute)
}

fn require_mutation_capability(
    state: &RuntimeState,
    params: &Value,
    operation: &str,
    resources: &[String],
) -> Result<(), RpcError> {
    let _ = required_str(params, "capabilitySessionId")?;
    let _ = required_str(params, "capabilityActionHash")?;
    state.consume_capability(params, operation, None, &[], None, resources, None)?;
    Ok(())
}

fn worktree_value(info: &cbc_git::WorktreeInfo) -> Value {
    json!({
        "path": info.path.to_string_lossy(),
        "head": info.head,
        "branch": info.branch,
        "locked": info.locked,
        "prunable": info.prunable,
    })
}

pub fn create(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    state.require_mutation_allowed()?;
    let path = required_str(&params, "path")?;
    let commit = validate_revision(required_str(&params, "commit")?)?;
    let require_clean = optional_bool(&params, "requireClean", true);
    let allow_long_path = optional_bool(&params, "allowLongPath", false);
    let absolute = resolve_worktree_path(state, &path, PathIntent::Write, true)?;
    require_mutation_capability(
        state,
        &params,
        "worktree.create",
        &[absolute.to_string_lossy().to_string()],
    )?;

    let git = service(state)?;
    let data_dir = data_root(state);
    let info = git
        .worktree_create(WorktreeCreateOptions {
            data_root: &data_dir,
            path: &absolute,
            commit: &commit,
            require_clean,
            allow_long_path,
        })
        .map_err(|error| git_error(state, error))?;
    Ok(json!({ "worktree": worktree_value(&info) }))
}

pub fn list(state: &RuntimeState) -> Result<Value, RpcError> {
    let git = service(state)?;
    let entries = git
        .worktree_list()
        .map_err(|error| git_error(state, error))?;
    Ok(json!({
        "worktrees": entries.iter().map(worktree_value).collect::<Vec<_>>(),
    }))
}

pub fn inspect(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let path = required_str(&params, "path")?;
    let absolute = resolve_worktree_path(state, &path, PathIntent::Read, false)?;
    let git = service(state)?;
    let data_dir = data_root(state);
    let info = git
        .worktree_inspect(&data_dir, &absolute)
        .map_err(|error| git_error(state, error))?;
    Ok(json!({ "worktree": worktree_value(&info) }))
}

pub fn status(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let path = required_str(&params, "path")?;
    let absolute = resolve_worktree_path(state, &path, PathIntent::Read, false)?;
    let main = service(state)?;
    let data_dir = data_root(state);
    main.worktree_inspect(&data_dir, &absolute)
        .map_err(|error| git_error(state, error))?;
    let git = cbc_git::GitService::open(&absolute);
    let status = git.status().map_err(|error| git_error(state, error))?;
    Ok(json!({
        "path": absolute.to_string_lossy(),
        "status": status,
        "statusBar": status.status_bar_fragment(),
    }))
}

pub fn diff(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let path = required_str(&params, "path")?;
    let absolute = resolve_worktree_path(state, &path, PathIntent::Read, false)?;
    let main = service(state)?;
    let data_dir = data_root(state);
    main.worktree_inspect(&data_dir, &absolute)
        .map_err(|error| git_error(state, error))?;
    let range = optional_str(&params, "range").filter(|value| !value.trim().is_empty());
    if let Some(range) = range.as_ref() {
        let _ = validate_revision(range.clone())?;
    }
    let paths = string_array(&params, "paths");
    let git = cbc_git::GitService::open(&absolute);
    let summary = git
        .diff(range.as_deref(), &paths)
        .map_err(|error| git_error(state, error))?;
    let files: Vec<Value> = summary
        .files
        .iter()
        .map(|file| {
            json!({
                "path": file.path,
                "oldPath": file.old_path,
                "additions": file.additions,
                "deletions": file.deletions,
                "binary": file.binary,
                "patch": if file.binary { String::new() } else { state.safe_text(&file.patch) },
            })
        })
        .collect();
    Ok(json!({
        "path": absolute.to_string_lossy(),
        "files": files,
        "totalAdditions": summary.total_additions,
        "totalDeletions": summary.total_deletions,
        "truncated": summary.truncated,
    }))
}

pub fn remove(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    state.require_mutation_allowed()?;
    let path = required_str(&params, "path")?;
    let has_active_writer = optional_bool(&params, "hasActiveWriter", false);
    let absolute = resolve_worktree_path(state, &path, PathIntent::Write, true)?;
    require_mutation_capability(
        state,
        &params,
        "worktree.remove",
        &[absolute.to_string_lossy().to_string()],
    )?;
    let git = service(state)?;
    let data_dir = data_root(state);
    git.worktree_remove(&data_dir, &absolute, has_active_writer)
        .map_err(|error| git_error(state, error))?;
    Ok(json!({
        "ok": true,
        "path": absolute.to_string_lossy(),
    }))
}

pub fn reconcile(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    state.require_mutation_allowed()?;
    require_mutation_capability(state, &params, "worktree.reconcile", &[])?;
    let git = service(state)?;
    git.worktree_prune()
        .map_err(|error| git_error(state, error))?;
    let entries = git
        .worktree_list()
        .map_err(|error| git_error(state, error))?;
    let prunable = entries
        .iter()
        .filter(|entry| entry.prunable || !entry.path.exists())
        .map(worktree_value)
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "worktrees": entries.iter().map(worktree_value).collect::<Vec<_>>(),
        "prunable": prunable,
    }))
}

pub fn merge_preview(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let base = validate_revision(required_str(&params, "base")?)?;
    let ours = validate_revision(required_str(&params, "ours")?)?;
    let theirs = validate_revision(required_str(&params, "theirs")?)?;
    let git = service(state)?;
    let analysis = git
        .merge_preview(&base, &ours, &theirs)
        .map_err(|error| git_error(state, error))?;
    Ok(json!({
        "autoFiles": analysis.auto_files.iter().map(|file| json!({
            "path": file.path,
            "content": state.safe_text(&file.content),
        })).collect::<Vec<_>>(),
        "conflicts": analysis.conflicts.iter().map(|conflict| json!({
            "path": conflict.path,
            "ours": conflict.ours.as_ref().map(|text| state.safe_text(text)),
            "theirs": conflict.theirs.as_ref().map(|text| state.safe_text(text)),
            "base": conflict.base.as_ref().map(|text| state.safe_text(text)),
        })).collect::<Vec<_>>(),
        "renameConflicts": analysis.rename_conflicts,
        "deleteModify": analysis.delete_modify,
    }))
}
