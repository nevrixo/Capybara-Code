//! `git.*` handlers — PRD §12.2, §14.9, §20.3.

use cbc_protocol::{error_codes, RpcError};
use cbc_workspace::{PathIntent, ResolveOptions};
use serde_json::{json, Value};

use crate::server::{optional_str, optional_usize, required_str, string_array, RuntimeState};

fn service(state: &RuntimeState) -> Result<cbc_git::GitService, RpcError> {
    state
        .git
        .lock()
        .expect("git lock")
        .clone()
        .ok_or_else(|| RpcError::new(error_codes::NOT_INITIALIZED, "git service not initialized"))
}

fn git_error(state: &RuntimeState, error: cbc_git::GitError) -> RpcError {
    match error {
        cbc_git::GitError::NotARepository { path } => RpcError::with_data(
            error_codes::NOT_FOUND,
            format!("{path} is not a Git repository"),
            json!({
                "taxonomy": "NOT_FOUND",
                "path": path,
                "action": "initialize the workspace in a Git repository or use fs tools",
            }),
        ),
        cbc_git::GitError::GitUnavailable { message } => {
            let message = state.safe_text(&message);
            RpcError::with_data(
                error_codes::INTERNAL_ERROR,
                format!("git is unavailable: {message}"),
                json!({
                    "taxonomy": "INTERNAL",
                    "retryable": true,
                    "action": "check that Git is installed and retry once the runtime is healthy",
                }),
            )
        }
        cbc_git::GitError::CommandFailed { argv, stderr } => {
            let safe_stderr = state.safe_text(&stderr);
            let missing = git_target_not_found(&safe_stderr);
            let taxonomy = if missing { "NOT_FOUND" } else { "INTERNAL" };
            let code = if missing {
                error_codes::NOT_FOUND
            } else {
                error_codes::INTERNAL_ERROR
            };
            RpcError::with_data(
                code,
                format!("git command failed: {safe_stderr}"),
                json!({
                    "taxonomy": taxonomy,
                    "argv": state.safe_text(&argv.join(" ")),
                    "stderr": safe_stderr,
                    "retryable": !missing,
                    "action": if missing {
                        "check the revision or path with git.status/git.log and retry"
                    } else {
                        "retry after checking the repository and runtime health"
                    },
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
                "field": "revision",
                "action": "use a non-empty revision such as HEAD, a branch, or a commit hash",
            }),
        ));
    }
    Ok(trimmed.to_string())
}

/// Optional string fields are sometimes materialized as an empty string by a
/// provider even when the caller omitted them. An empty revision is not a
/// meaningful Git range and would be passed to git diff as an empty string,
/// which Git rejects as a bad revision. Treat blank values as the omitted form
/// at the runtime boundary.
fn optional_revision(params: &Value) -> Result<Option<String>, RpcError> {
    optional_str(params, "range")
        .filter(|value| !value.trim().is_empty())
        .map(validate_revision)
        .transpose()
}

fn workspace_path(state: &RuntimeState, value: String) -> Result<String, RpcError> {
    if value.contains(char::from(0)) {
        return Err(RpcError::with_data(
            error_codes::INVALID_ARGUMENT,
            "invalid Git path",
            json!({
                "taxonomy": "INVALID_ARGUMENT",
                "field": "path",
                "action": "use a workspace-relative Git path",
            }),
        ));
    }
    let ws = state.require_workspace()?;
    let resolved = ws
        .resolve(
            &value,
            PathIntent::Read,
            &ResolveOptions {
                allow_absolute: false,
                allow_missing: true,
                lease_globs: None,
                // Git output is sanitized/redacted below; allow metadata paths
                // such as deleted or ignored files to be queried consistently.
                allow_sensitive: true,
                allowed_roots: Vec::new(),
            },
        )
        .map_err(crate::server::guard_error)?;
    Ok(resolved.relative)
}
fn git_target_not_found(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown revision")
        || lower.contains("bad object")
        || lower.contains("ambiguous argument")
        || lower.contains("invalid object name")
        || lower.contains("needed a single revision")
        || (lower.contains("pathspec") && lower.contains("did not match"))
        || (lower.contains("exists on disk") && lower.contains("not in"))
}

pub fn status(state: &RuntimeState) -> Result<Value, RpcError> {
    let git = service(state)?;
    let status = git.status().map_err(|error| git_error(state, error))?;
    Ok(json!({
        "status": status,
        "statusBar": status.status_bar_fragment(),
    }))
}

pub fn diff(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let git = service(state)?;
    let range = optional_revision(&params)?;
    let paths = string_array(&params, "paths")
        .into_iter()
        .map(|path| workspace_path(state, path))
        .collect::<Result<Vec<_>, _>>()?;
    let summary = git
        .diff(range.as_deref(), &paths)
        .map_err(|error| git_error(state, error))?;

    // Diff text is workspace content; sanitize and redact before it can reach
    // the timeline or the model.
    let files: Vec<Value> = summary
        .files
        .iter()
        .map(|f| {
            json!({
                "path": f.path,
                "oldPath": f.old_path,
                "additions": f.additions,
                "deletions": f.deletions,
                "binary": f.binary,
                "patch": if f.binary { String::new() } else { state.safe_text(&f.patch) },
            })
        })
        .collect();

    Ok(json!({
        "files": files,
        "totalAdditions": summary.total_additions,
        "totalDeletions": summary.total_deletions,
        "truncated": summary.truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::optional_revision;
    use serde_json::json;

    #[test]
    fn blank_diff_range_is_treated_as_omitted() {
        assert_eq!(optional_revision(&json!({})).unwrap(), None);
        assert_eq!(optional_revision(&json!({ "range": "" })).unwrap(), None);
        assert_eq!(optional_revision(&json!({ "range": "  " })).unwrap(), None);
    }

    #[test]
    fn non_blank_diff_range_is_validated_and_preserved() {
        assert_eq!(
            optional_revision(&json!({ "range": " HEAD " })).unwrap(),
            Some("HEAD".to_string())
        );
    }
}

pub fn log(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let git = service(state)?;
    let limit = optional_usize(&params, "limit", 20).clamp(1, 500);
    let path = optional_str(&params, "path")
        .map(|path| workspace_path(state, path))
        .transpose()?;
    let entries = git
        .log(limit, path.as_deref())
        .map_err(|error| git_error(state, error))?;
    Ok(json!({ "entries": entries }))
}

pub fn show(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let git = service(state)?;
    let revision = validate_revision(required_str(&params, "revision")?)?;
    let path = optional_str(&params, "path")
        .map(|path| workspace_path(state, path))
        .transpose()?;
    let content = git
        .show(&revision, path.as_deref())
        .map_err(|error| git_error(state, error))?;
    Ok(json!({
        "revision": revision,
        "path": path,
        "content": state.safe_text(&content),
    }))
}

pub fn checkpoint(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let _admission = state.acquire_write_admission()?;
    let git = service(state)?;
    // A checkpoint records (and may later restore) workspace state, so it is a
    // mutation-shaped operation and inherits the same trust gate (§19.5).
    state.require_mutation_allowed()?;
    let label = optional_str(&params, "label")
        .unwrap_or_else(|| format!("capybara checkpoint {}", cbc_patch::now_iso8601()));
    let checkpoint = git
        .checkpoint(&label)
        .map_err(|error| git_error(state, error))?;
    Ok(serde_json::to_value(checkpoint).unwrap_or(Value::Null))
}
