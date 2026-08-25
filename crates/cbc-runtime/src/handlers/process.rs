//! `process.*` handlers — PRD §12.3, §12.7, §12.8, §14.5, §14.7, §20.3, AC-20.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use cbc_process::{
    is_executable_control_env, CancelToken, EnvPolicy, NetworkMode, ProcessError, ProcessSpec,
    StdinMode,
};
use cbc_protocol::{error_codes, RpcError};
use cbc_sandbox::SandboxLevel;
use cbc_workspace::{PathIntent, ResolveOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::server::{
    guard_error, optional_bool, optional_str, optional_u64, optional_usize, required_str,
    string_array, RuntimeState,
};

/// Map a supervisor error onto the protocol taxonomy (P0-04): a refused
/// isolation reports its dedicated code, never a generic internal error.
fn environment_binding(params: &Value) -> String {
    let mut entries: Vec<(&str, &str)> = params
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.as_str(), text)))
                .collect()
        })
        .unwrap_or_default();
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));

    let mut hasher = Sha256::new();
    for (name, value) in entries {
        hasher.update(name.len().to_string().as_bytes());
        hasher.update(b":");
        hasher.update(name.as_bytes());
        hasher.update(value.len().to_string().as_bytes());
        hasher.update(b":");
        hasher.update(value.as_bytes());
    }
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("env:sha256:{hex}")
}

const EXECUTABLE_CAPABILITY_PROGRAMS: &[&str] = &[
    "go", "cargo", "npm", "pnpm", "bun", "rg", "grep", "sed", "cat",
];

fn executable_file_on_path(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn executable_available(program: &str) -> bool {
    let Some(path_value) = std::env::var_os("PATH") else {
        return false;
    };
    for directory in std::env::split_paths(&path_value) {
        if executable_file_on_path(&directory.join(program)) {
            return true;
        }
        #[cfg(windows)]
        for extension in [".exe", ".cmd", ".bat"] {
            if executable_file_on_path(&directory.join(format!("{program}{extension}"))) {
                return true;
            }
        }
    }
    false
}

/// Return only runner-observed availability, never paths or environment values.
pub(crate) fn executable_capabilities() -> BTreeMap<String, bool> {
    EXECUTABLE_CAPABILITY_PROGRAMS
        .iter()
        .map(|program| ((*program).to_string(), executable_available(program)))
        .collect()
}

// A result token is deliberately bounded. A complete content hash is a safe
// proof of no workspace-content change for small/medium trees; a large,
// unreadable, or concurrently changing tree returns None, which keeps the
// TypeScript caller on its existing whole-workspace invalidation path.
const WORKSPACE_TOKEN_MAX_ENTRIES: usize = 4_096;
const WORKSPACE_TOKEN_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn hash_workspace_token_part(hasher: &mut Sha256, label: &[u8], value: &[u8]) {
    hasher.update((label.len() as u64).to_be_bytes());
    hasher.update(label);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Return a content-addressed workspace token only when a bounded scan can
/// prove what it observed. The .git directory is intentionally excluded: Git
/// bookkeeping can change during a read-only command but cannot make a cached
/// workspace file body stale.
fn workspace_change_token(root: &Path) -> Option<String> {
    let mut hasher = Sha256::new();
    let mut pending = vec![PathBuf::new()];
    let mut entry_count = 0usize;
    let mut total_file_bytes = 0u64;

    while let Some(relative_dir) = pending.pop() {
        let directory = root.join(&relative_dir);
        let before_directory = fs::metadata(&directory).ok()?;
        if !before_directory.is_dir() {
            return None;
        }
        let before_modified = before_directory.modified().ok()?;
        let mut children = fs::read_dir(&directory)
            .ok()?
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        children.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

        for child in children {
            let name = child.file_name();
            if relative_dir.as_os_str().is_empty() && name == OsStr::new(".git") {
                continue;
            }
            entry_count = entry_count.checked_add(1)?;
            if entry_count > WORKSPACE_TOKEN_MAX_ENTRIES {
                return None;
            }
            let relative = relative_dir.join(&name);
            let relative_text = relative.to_str()?;
            let path = child.path();
            let before = fs::symlink_metadata(&path).ok()?;
            let file_type = before.file_type();
            hash_workspace_token_part(&mut hasher, b"path", relative_text.as_bytes());

            if file_type.is_dir() {
                hash_workspace_token_part(&mut hasher, b"type", b"directory");
                pending.push(relative);
                continue;
            }
            if file_type.is_symlink() {
                hash_workspace_token_part(&mut hasher, b"type", b"symlink");
                let target = fs::read_link(&path).ok()?;
                hash_workspace_token_part(&mut hasher, b"target", target.to_str()?.as_bytes());
                continue;
            }
            if !file_type.is_file() {
                return None;
            }

            let len = before.len();
            total_file_bytes = total_file_bytes.checked_add(len)?;
            if total_file_bytes > WORKSPACE_TOKEN_MAX_FILE_BYTES {
                return None;
            }
            hash_workspace_token_part(&mut hasher, b"type", b"file");
            hash_workspace_token_part(&mut hasher, b"length", &len.to_be_bytes());
            let before_modified = before.modified().ok()?;
            let mut file = fs::File::open(&path).ok()?;
            let mut buffer = [0_u8; 8 * 1024];
            loop {
                let read = file.read(&mut buffer).ok()?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            let after = fs::metadata(&path).ok()?;
            if !after.is_file() || after.len() != len || after.modified().ok()? != before_modified {
                return None;
            }
        }

        let after_directory = fs::metadata(&directory).ok()?;
        if !after_directory.is_dir() || after_directory.modified().ok()? != before_modified {
            return None;
        }
    }

    let digest = hasher.finalize();
    Some(format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn process_error(e: ProcessError) -> RpcError {
    match &e {
        ProcessError::ExecutableNotFound { .. } => {
            RpcError::taxonomy(error_codes::NOT_FOUND, "NOT_FOUND", e.to_string())
        }
        ProcessError::NetworkDenied { .. } => {
            RpcError::taxonomy(error_codes::NETWORK_DENIED, "NETWORK_DENIED", e.to_string())
        }
        ProcessError::SandboxUnavailable { .. } => RpcError::taxonomy(
            error_codes::SANDBOX_UNAVAILABLE,
            "SANDBOX_UNAVAILABLE",
            e.to_string(),
        ),
        _ => RpcError::internal(e.to_string()),
    }
}

/// The Landlock allowlist applied to every spawn while the effective sandbox
/// level is `strict` (§14.4's "explicit filesystem allowlist").
///
/// Writable: the workspace itself plus the scratch areas ordinary tools need
/// (`/tmp`, the PTY device directory). Readable: the system roots required to
/// execute binaries at all. Everything else — the home directory, the data
/// directory with its credential store, other projects — is denied by the
/// allowlist semantics.
fn strict_sandbox_policy(ws_root: &std::path::Path) -> cbc_process::SandboxPolicy {
    let tmp = std::env::temp_dir().to_string_lossy().to_string();
    cbc_process::SandboxPolicy {
        writable_roots: vec![
            ws_root.to_string_lossy().to_string(),
            tmp,
            "/dev/pts".to_string(),
        ],
        readable_roots: vec![
            "/usr".to_string(),
            "/bin".to_string(),
            "/sbin".to_string(),
            "/lib".to_string(),
            "/lib64".to_string(),
            "/etc".to_string(),
            "/opt".to_string(),
            "/dev/null".to_string(),
            "/dev/urandom".to_string(),
            "/dev/random".to_string(),
            "/dev/tty".to_string(),
        ],
    }
}

fn build_spec(
    state: &RuntimeState,
    params: &Value,
    operation: &str,
) -> Result<ProcessSpec, RpcError> {
    let ws = state.require_workspace()?;
    // Every executable job is owned by the session that received the policy
    // receipt. This identity is also checked by consume_capability.
    let _capability_session_id = required_str(params, "capabilitySessionId")?;
    let program = required_str(params, "program")?;
    if program.trim().is_empty() {
        return Err(RpcError::invalid_params("program must not be empty"));
    }
    let args = string_array(params, "args");

    let requested_cwd = optional_str(params, "cwd").unwrap_or_else(|| ".".to_string());
    let cwd_for_receipt = requested_cwd.clone();
    let capability_operation =
        optional_str(params, "capabilityOperation").unwrap_or_else(|| operation.to_string());
    let protocol_channel = if matches!(
        capability_operation.as_str(),
        "mcp.stdio.start" | "lsp.stdio.start"
    ) {
        let channel = required_str(params, "protocolChannel")?;
        if channel.is_empty()
            || channel.len() > 128
            || !channel
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(RpcError::invalid_params(
                "protocolChannel must be a non-empty safe identifier",
            ));
        }
        Some(channel)
    } else {
        if params.get("protocolChannel").is_some() {
            return Err(RpcError::invalid_params(
                "protocolChannel is reserved for managed stdio protocol starts",
            ));
        }
        None
    };
    let capability_resources = vec![environment_binding(params)];
    // Process receipts bind the complete normalized action hash. Omitting it
    // would let a forged/direct RPC reuse a receipt while changing unlisted
    // process parameters (for example timeout or env policy).
    let _capability_action_hash = required_str(params, "capabilityActionHash")?;
    let receipt = state.consume_capability(
        params,
        &capability_operation,
        Some(&program),
        &args,
        Some(&cwd_for_receipt),
        &capability_resources,
        optional_str(params, "network").as_deref(),
    )?;
    let requested_network = receipt.network.as_str();

    // cwd must stay inside the workspace (§14.2 applies to execution too).
    let cwd_resolved = ws
        .resolve(
            &requested_cwd,
            PathIntent::List,
            &ResolveOptions {
                allow_absolute: optional_bool(params, "allowAbsolute", false),
                allow_missing: false,
                lease_globs: None,
                allow_sensitive: true,
                allowed_roots: Vec::new(),
            },
        )
        .map_err(guard_error)?;
    if !cwd_resolved.absolute.is_dir() {
        return Err(RpcError::taxonomy(
            error_codes::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            format!("cwd '{}' is not a directory", cwd_resolved.relative),
        ));
    }

    let env_policy = match optional_str(params, "envPolicy").as_deref() {
        Some("minimal") => EnvPolicy::Minimal,
        Some("explicit") => EnvPolicy::Explicit,
        Some("inherit_safe") | Some("inherit-safe") | None => EnvPolicy::InheritSafe,
        Some(other) => {
            return Err(RpcError::invalid_params(format!(
                "unknown envPolicy '{other}'"
            )))
        }
    };

    let mut env = HashMap::new();
    if let Some(map) = params.get("env").and_then(Value::as_object) {
        for (key, value) in map {
            if let Some(text) = value.as_str() {
                // §14.5: a project may request env *names*, but the runtime never
                // lets a caller inject a credential-shaped variable inline.
                if cbc_redaction::is_secret_env_name(key) && protocol_channel.is_none() {
                    return Err(RpcError::with_data(
                        error_codes::PERMISSION_DENIED,
                        format!("refusing to set credential-shaped environment variable '{key}'"),
                        json!({ "taxonomy": "PERMISSION_DENIED" }),
                    ));
                }
                if is_executable_control_env(key) {
                    return Err(RpcError::with_data(
                        error_codes::PERMISSION_DENIED,
                        format!(
                            "refusing executable-loader or interpreter-control environment variable '{key}'"
                        ),
                        json!({ "taxonomy": "PERMISSION_DENIED" }),
                    ));
                }
                env.insert(key.clone(), text.to_string());
            }
        }
    }

    let limits = cbc_process::DEFAULT_LIMITS;
    let mut spec = ProcessSpec::new(
        program,
        args,
        cwd_resolved.absolute.to_string_lossy().to_string(),
    );
    spec.env = env;
    spec.env_policy = env_policy;
    spec.stdin = match optional_str(params, "stdin").as_deref() {
        Some("pipe") => StdinMode::Pipe,
        Some("pty") => StdinMode::Pty,
        _ => StdinMode::Null,
    };
    spec.network = match requested_network {
        "deny" => NetworkMode::Deny,
        "allow" => NetworkMode::Allow,
        _ => NetworkMode::Inherit,
    };
    spec.timeout_ms = limits.clamp_timeout(optional_u64(params, "timeoutMs").unwrap_or(0));
    spec.max_output_bytes = limits.clamp_output(optional_usize(params, "maxOutputBytes", 0));
    spec.max_memory_bytes = optional_u64(params, "maxMemoryBytes");
    spec.max_cpu_seconds = optional_u64(params, "maxCpuSeconds");
    spec.raw_shell = optional_bool(params, "rawShell", false);
    if let Some(channel) = protocol_channel {
        spec.protocol_channel = Some(channel);
        spec.stdin = StdinMode::Pipe;
        spec.network = NetworkMode::Deny;
        spec.raw_shell = false;
        spec.max_memory_bytes = Some(spec.max_memory_bytes.unwrap_or(512 * 1024 * 1024));
    }

    // P0-04: enforcement decisions made here, in the runtime.
    //
    // Strict level → every spawn carries the Landlock allowlist. The spawn
    // itself fails closed with SANDBOX_UNAVAILABLE when the host cannot apply
    // it; a silent unenforced run would be the exact §24.5 violation.
    let effective_level = *state.sandbox_level.lock().expect("sandbox lock");
    if effective_level >= SandboxLevel::Strict || spec.protocol_channel.is_some() {
        spec.sandbox = Some(strict_sandbox_policy(ws.root()));
    }

    // `sandbox.networkForShell = "deny"` forces network isolation on raw
    // shells regardless of what the caller requested.
    if spec.raw_shell {
        let forced = state
            .network_for_shell
            .lock()
            .expect("network lock")
            .as_deref()
            == Some("deny");
        if forced {
            spec.network = NetworkMode::Deny;
        }
    }
    Ok(spec)
}

fn requester_session(params: &Value) -> Option<String> {
    optional_str(params, "sessionId").or_else(|| optional_str(params, "capabilitySessionId"))
}

fn require_owned_job(state: &RuntimeState, params: &Value, job_id: &str) -> Result<(), RpcError> {
    // Preserve the stable NOT_FOUND contract for stale job ids; ownership is
    // meaningful only while the supervisor still knows the job.
    if state.supervisor.status(job_id).is_none() {
        return Ok(());
    }
    if optional_bool(params, "operatorCancellation", false) {
        return Ok(());
    }
    let requester = requester_session(params).ok_or_else(|| {
        RpcError::taxonomy(
            error_codes::PERMISSION_DENIED,
            "PERMISSION_DENIED",
            "a session id is required to control a process",
        )
    })?;
    let owners = state.job_owners.lock().expect("job owner lock");
    match owners.get(job_id) {
        Some(owner) if owner == &requester => Ok(()),
        Some(_) => Err(RpcError::taxonomy(
            error_codes::PERMISSION_DENIED,
            "PERMISSION_DENIED",
            "the process belongs to another session",
        )),
        None => Err(RpcError::taxonomy(
            error_codes::PERMISSION_DENIED,
            "PERMISSION_DENIED",
            "process ownership is unknown",
        )),
    }
}

fn outcome_value(
    state: &RuntimeState,
    outcome: &cbc_process::ProcessOutcome,
    workspace_revision_before: Option<&str>,
    workspace_revision_after: Option<&str>,
) -> Value {
    let workspace_change_observed = match (workspace_revision_before, workspace_revision_after) {
        (Some(before), Some(after)) => Some(before != after),
        _ => None,
    };
    json!({
        "jobId": outcome.job_id,
        "state": outcome.state,
        "exitCode": outcome.exit_code,
        "signal": outcome.signal,
        "durationMs": outcome.duration_ms,
        "display": outcome.display,
        // Sanitize and redact before this text can reach the timeline or the
        // model (§6.20, §9.8, RT-004, RT-005).
        "stdout": state.safe_text(&outcome.stdout),
        "stderr": state.safe_text(&outcome.stderr),
        "stdoutBytes": outcome.stdout_bytes,
        "stderrBytes": outcome.stderr_bytes,
        "truncated": outcome.truncated,
        "warnings": outcome.warnings,
        "taxonomy": outcome.taxonomy(),
        "workspaceRevisionBefore": workspace_revision_before,
        "workspaceRevisionAfter": workspace_revision_after,
        "workspaceChangeObserved": workspace_change_observed,
    })
}

pub fn run(
    state: &RuntimeState,
    params: Value,
    request_token: Option<CancelToken>,
) -> Result<Value, RpcError> {
    // Acquire before the policy check so a concurrent Plan transition cannot
    // land between validation and spawning. The guard covers the entire
    // foreground process lifetime.
    let _admission = state.acquire_write_admission()?;
    let workspace_root = state.require_workspace()?.root().to_path_buf();
    let workspace_revision_before = workspace_change_token(&workspace_root);
    state.require_process_allowed()?;
    let spec = build_spec(state, &params, "process.run")?;
    // P0-04: the dispatcher hands every request a cancel token keyed by its
    // request id, so `runtime.cancel` can abort a foreground run. A caller may
    // also name its own cancelKey for process.stop.
    let cancel = request_token.unwrap_or_else(CancelToken::new);
    let cancel_key = optional_str(&params, "cancelKey");
    if let Some(key) = &cancel_key {
        state
            .cancel_tokens
            .lock()
            .expect("cancel lock")
            .insert(key.clone(), cancel.clone());
    }

    let owner = required_str(&params, "capabilitySessionId")?;
    let mut owners = state.job_owners.lock().expect("job owner lock");
    let job_id = state
        .supervisor
        .start(spec, cancel.clone())
        .map_err(process_error)?;
    owners.insert(job_id.clone(), owner);
    drop(owners);
    let outcome = state.supervisor.wait(&job_id).map_err(process_error);
    state
        .job_owners
        .lock()
        .expect("job owner lock")
        .remove(&job_id);
    if let Some(key) = &cancel_key {
        state.cancel_tokens.lock().expect("cancel lock").remove(key);
    }
    let outcome = outcome?;
    let workspace_revision_after = workspace_change_token(&workspace_root);
    Ok(outcome_value(
        state,
        &outcome,
        workspace_revision_before.as_deref(),
        workspace_revision_after.as_deref(),
    ))
}

pub fn start(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    // The admission closes the check→spawn race. Once the child is registered,
    // `active_count()` is the steady-state quiescence barrier.
    let _admission = state.acquire_write_admission()?;
    state.require_process_allowed()?;
    let spec = build_spec(state, &params, "process.start")?;
    let owner = required_str(&params, "capabilitySessionId")?;
    let display = spec.display();
    let cancel = CancelToken::new();
    let mut owners = state.job_owners.lock().expect("job owner lock");
    let job_id = state
        .supervisor
        .start(spec, cancel.clone())
        .map_err(process_error)?;
    owners.insert(job_id.clone(), owner);
    drop(owners);
    state
        .cancel_tokens
        .lock()
        .expect("cancel lock")
        .insert(job_id.clone(), cancel);
    if let Some(store) = state.store.lock().expect("store lock").as_ref() {
        let _ = store.record_job(
            &job_id,
            optional_str(&params, "taskId").as_deref(),
            &display,
            "running",
            None,
            &cbc_patch::now_iso8601(),
            None,
        );
    }

    Ok(json!({ "jobId": job_id, "display": display, "state": "running" }))
}

pub fn input(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    // stdin writes are mutations too: serialize the mode check with Plan entry so
    // Build→Plan cannot land between admission and write_stdin.
    let _admission = state.acquire_write_admission()?;
    state.require_process_allowed()?;
    let job_id = required_str(&params, "jobId")?;
    require_owned_job(state, &params, &job_id)?;
    if optional_bool(&params, "close", false) {
        state
            .supervisor
            .close_stdin(&job_id)
            .map_err(|e| RpcError::internal(e.to_string()))?;
        return Ok(json!({ "jobId": job_id, "closed": true }));
    }
    let data = required_str(&params, "data")?;
    state
        .supervisor
        .write_stdin(&job_id, &data)
        .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(json!({ "jobId": job_id, "bytes": data.len() }))
}

pub fn stop(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    // Stopping an owned process is a safe quiescence operation, not a new side
    // effect. It must remain available in Plan mode so a user can drain a
    // running Build process before entering Plan.
    let job_id = required_str(&params, "jobId")?;
    require_owned_job(state, &params, &job_id)?;
    let grace_ms = optional_u64(&params, "graceMs").unwrap_or(cbc_process::DEFAULT_KILL_GRACE_MS);

    // Signal the token first so a waiting `process.run` observes cancellation,
    // then terminate the tree (§7.7, AC-20).
    if let Some(token) = state
        .cancel_tokens
        .lock()
        .expect("cancel lock")
        .get(&job_id)
    {
        token.cancel();
    }
    state
        .supervisor
        .terminate_tree(&job_id, grace_ms)
        .map_err(|e| match e {
            cbc_process::ProcessError::NotFound { job_id } => RpcError::taxonomy(
                error_codes::NOT_FOUND,
                "NOT_FOUND",
                format!("no such job '{job_id}'"),
            ),
            other => RpcError::internal(other.to_string()),
        })?;

    if let Some(store) = state.store.lock().expect("store lock").as_ref() {
        let _ = store.record_job(
            &job_id,
            None,
            "",
            "cancelled",
            None,
            &cbc_patch::now_iso8601(),
            Some(&cbc_patch::now_iso8601()),
        );
    }

    Ok(json!({ "jobId": job_id, "state": "cancelled" }))
}

pub fn status(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    match optional_str(&params, "jobId") {
        Some(job_id) => {
            require_owned_job(state, &params, &job_id)?;
            match state.supervisor.status(&job_id) {
                Some((job_state, elapsed_ms)) => Ok(json!({
                    "jobId": job_id,
                    "state": job_state,
                    "elapsedMs": elapsed_ms,
                })),
                None => Err(RpcError::taxonomy(
                    error_codes::NOT_FOUND,
                    "NOT_FOUND",
                    format!("no such job '{job_id}'"),
                )),
            }
        }
        None => {
            let requester = requester_session(&params).ok_or_else(|| {
                RpcError::taxonomy(
                    error_codes::PERMISSION_DENIED,
                    "PERMISSION_DENIED",
                    "a session id is required to inspect processes",
                )
            })?;
            let owners = state.job_owners.lock().expect("job owner lock");
            let jobs = state
                .supervisor
                .job_ids()
                .into_iter()
                .filter(|job_id| owners.get(job_id).is_some_and(|owner| owner == &requester))
                .collect::<Vec<_>>();
            Ok(json!({
                "jobs": jobs,
                "activeCount": state.supervisor.active_count(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_missing_executable_to_not_found() {
        let error = process_error(ProcessError::ExecutableNotFound {
            program: "python".to_string(),
            message: "No such file or directory".to_string(),
        });
        assert_eq!(error.code, error_codes::NOT_FOUND);
        assert!(error.message.contains("executable file not found"));
    }

    #[test]
    fn workspace_change_token_tracks_content_but_not_git_bookkeeping() {
        let temp = tempfile::tempdir().expect("temp workspace");
        let root = temp.path();
        fs::write(root.join("tracked.txt"), "before").expect("write fixture");
        let first = workspace_change_token(root).expect("initial token");
        assert_eq!(first, workspace_change_token(root).expect("stable token"));

        fs::create_dir(root.join(".git")).expect("git directory");
        fs::write(root.join(".git").join("index"), "bookkeeping").expect("git index");
        assert_eq!(first, workspace_change_token(root).expect("git ignored"));

        fs::write(root.join("tracked.txt"), "after").expect("mutate fixture");
        assert_ne!(first, workspace_change_token(root).expect("changed token"));
    }

    #[test]
    fn executable_capabilities_have_a_fixed_non_secret_surface() {
        let capabilities = executable_capabilities();
        let mut expected = EXECUTABLE_CAPABILITY_PROGRAMS.to_vec();
        expected.sort_unstable();
        assert_eq!(
            capabilities.keys().map(String::as_str).collect::<Vec<_>>(),
            expected
        );
    }
}
