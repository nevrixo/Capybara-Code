//! `update.verify` handler — PRD §6.19, §19.9, AC-41.
//!
//! The runtime verifies; it never downloads. §19.9 forbids arbitrary postinstall
//! network download as the default distribution path, and §19.6 puts update
//! verification in the Rust column.

use cbc_protocol::{error_codes, RpcError};
use cbc_update::ReleaseManifest;
use serde_json::{json, Value};

use crate::server::{optional_bool, optional_str, required_str, RuntimeState};

pub fn verify(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    // Version comparison mode: no filesystem access needed.
    if let (Some(current), Some(candidate)) = (
        optional_str(&params, "currentVersion"),
        optional_str(&params, "candidateVersion"),
    ) {
        if params.get("stagedDir").is_none() {
            return Ok(json!({
                "mode": "version-compare",
                "currentVersion": current,
                "candidateVersion": candidate,
                "updateAvailable": cbc_update::is_newer(&current, &candidate),
            }));
        }
    }

    let staged_dir = required_str(&params, "stagedDir")?;
    let manifest_value = params
        .get("manifest")
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("manifest is required"))?;
    let manifest: ReleaseManifest = serde_json::from_value(manifest_value)
        .map_err(|e| RpcError::invalid_params(format!("invalid release manifest: {e}")))?;
    let channel = optional_str(&params, "channel").unwrap_or_else(|| "stable".to_string());
    // Signature verification is required unless the caller is explicitly running
    // a local development build; release builds always require it (§19.9).
    let require_signature =
        cfg!(not(debug_assertions)) || optional_bool(&params, "requireSignature", true);

    let path = std::path::Path::new(&staged_dir);
    if !path.is_dir() {
        return Err(RpcError::taxonomy(
            error_codes::NOT_FOUND,
            "NOT_FOUND",
            format!("staged directory '{staged_dir}' does not exist"),
        ));
    }

    let verifying_key = cbc_update::pinned_release_verifying_key();
    let report = cbc_update::verify_release(
        path,
        &manifest,
        &channel,
        require_signature,
        verifying_key.as_ref(),
    );
    let problems: Vec<String> = report.problems.iter().map(|p| state.redact(p)).collect();

    Ok(json!({
        "mode": "verify-release",
        "status": report.status,
        "version": report.version,
        "filesChecked": report.files_checked,
        "problems": problems,
        "safeToInstall": report.safe_to_install,
    }))
}
