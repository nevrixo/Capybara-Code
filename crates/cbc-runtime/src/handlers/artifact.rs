//! `artifact.*` handlers — PRD §18.17, AC-44.

use cbc_artifacts::{ArtifactRef, ArtifactStore};
use cbc_protocol::{error_codes, RpcError};
use serde_json::{json, Value};

use crate::server::{
    optional_bool, optional_str, optional_usize, parse_retention, required_str, RuntimeState,
};

fn artifact_error(e: cbc_artifacts::ArtifactError) -> RpcError {
    let (code, taxonomy) = match &e {
        cbc_artifacts::ArtifactError::NotFound { .. } => (error_codes::NOT_FOUND, "NOT_FOUND"),
        cbc_artifacts::ArtifactError::DigestMismatch { .. } => {
            (error_codes::HASH_MISMATCH, "HASH_MISMATCH")
        }
        cbc_artifacts::ArtifactError::TooLarge { .. } => {
            (error_codes::OUTPUT_LIMIT, "OUTPUT_LIMIT")
        }
        cbc_artifacts::ArtifactError::Io { .. } => (error_codes::INTERNAL_ERROR, "INTERNAL"),
    };
    RpcError::taxonomy(code, taxonomy, e.to_string())
}

fn with_artifacts<T>(
    state: &RuntimeState,
    f: impl FnOnce(&ArtifactStore) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    let guard = state.artifacts.lock().expect("artifacts lock");
    let store = guard.as_ref().ok_or_else(|| {
        RpcError::new(
            error_codes::NOT_INITIALIZED,
            "artifact store not initialized",
        )
    })?;
    f(store)
}

pub fn create(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let media_type = optional_str(&params, "mediaType").unwrap_or_else(|| "text/plain".to_string());
    let display_name = optional_str(&params, "displayName");
    let retention = parse_retention(optional_str(&params, "retention").as_deref());
    // §18.17: raw, secret-bearing artifacts are not created by default.
    let raw = optional_bool(&params, "raw", false);

    // P0-08: binary media (images, archives) arrives base64-encoded; decode it
    // before storing so the digest covers the real bytes. Exactly one of
    // `content` / `contentBase64` must be present.
    let text_content = optional_str(&params, "content");
    let base64_content = optional_str(&params, "contentBase64");
    let (bytes, excerpt_source): (Vec<u8>, String) = match (&text_content, &base64_content) {
        (Some(_), Some(_)) => {
            return Err(RpcError::invalid_params(
                "artifact.create takes either content or contentBase64, not both",
            ))
        }
        (Some(text), None) => (text.as_bytes().to_vec(), text.clone()),
        (None, Some(encoded)) => {
            let decoded = cbc_artifacts::decode_base64(encoded).map_err(|e| {
                RpcError::taxonomy(
                    error_codes::INVALID_ARGUMENT,
                    "INVALID_ARGUMENT",
                    e.to_string(),
                )
            })?;
            let lossy = String::from_utf8_lossy(&decoded).to_string();
            (decoded, lossy)
        }
        (None, None) => {
            return Err(RpcError::invalid_params(
                "artifact.create needs content or contentBase64",
            ))
        }
    };

    let reference = {
        let redactor = state.redactor.lock().expect("redactor lock");
        with_artifacts(state, |store| {
            store
                .create(
                    &bytes,
                    &media_type,
                    display_name.as_deref(),
                    retention,
                    if raw { None } else { Some(&redactor) },
                )
                .map_err(artifact_error)
        })?
    };

    if let Some(store) = state.store.lock().expect("store lock").as_ref() {
        // P0-08: record the owning session/turn when the caller supplies them,
        // so retention and GC can attribute the blob. Both are optional.
        let session_id = optional_str(&params, "sessionId");
        let turn_id = optional_str(&params, "turnId");
        let _ = store.record_artifact(
            &reference.id,
            &reference.digest,
            &reference.media_type,
            reference.bytes as i64,
            match reference.redaction {
                cbc_artifacts::Redaction::Raw => "raw",
                cbc_artifacts::Redaction::Redacted => "redacted",
                cbc_artifacts::Redaction::Derived => "derived",
            },
            match reference.retention_class {
                cbc_artifacts::RetentionClass::Session => "session",
                cbc_artifacts::RetentionClass::Temporary => "temporary",
                cbc_artifacts::RetentionClass::Pinned => "pinned",
            },
            &cbc_patch::now_iso8601(),
            session_id.as_deref(),
            turn_id.as_deref(),
        );
    }

    // The model-bound half: a bounded excerpt plus the opaque ID.
    let head_lines = optional_usize(
        &params,
        "excerptHeadLines",
        cbc_artifacts::DEFAULT_EXCERPT_HEAD_LINES,
    );
    let tail_lines = optional_usize(
        &params,
        "excerptTailLines",
        cbc_artifacts::DEFAULT_EXCERPT_TAIL_LINES,
    );
    let max_bytes = optional_usize(&params, "excerptMaxBytes", 65_536);
    let excerpt = cbc_artifacts::excerpt(&excerpt_source, head_lines, tail_lines, max_bytes);

    Ok(json!({
        "artifact": reference,
        "excerpt": excerpt,
        "rendered": state.safe_text(&excerpt.render()),
    }))
}

pub fn read(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let locator = required_str(&params, "digest")?;
    // `raw` is only honoured for a local user action (`cbc artifact show`), never
    // for model-bound reads (§18.17).
    let user_initiated = optional_bool(&params, "userInitiated", false);
    let (digest, bytes) = with_artifacts(state, |store| {
        store.read_by_locator(&locator).map_err(artifact_error)
    })?;
    let text = String::from_utf8_lossy(&bytes).to_string();

    if user_initiated {
        return Ok(json!({
            "digest": digest,
            "bytes": bytes.len(),
            "content": text,
        }));
    }

    let head_lines = optional_usize(
        &params,
        "excerptHeadLines",
        cbc_artifacts::DEFAULT_EXCERPT_HEAD_LINES,
    );
    let tail_lines = optional_usize(
        &params,
        "excerptTailLines",
        cbc_artifacts::DEFAULT_EXCERPT_TAIL_LINES,
    );
    let max_bytes = optional_usize(&params, "excerptMaxBytes", 65_536);
    let excerpt = cbc_artifacts::excerpt(&text, head_lines, tail_lines, max_bytes);
    Ok(json!({
        "digest": digest,
        "bytes": bytes.len(),
        "excerpt": excerpt,
        "rendered": state.safe_text(&excerpt.render()),
    }))
}

pub fn delete(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let digest = required_str(&params, "digest")?;
    let removed = with_artifacts(state, |store| store.delete(&digest).map_err(artifact_error))?;
    Ok(json!({ "digest": digest, "removed": removed }))
}

/// Helper used by the process handlers to spill oversized output.
pub fn spill_output(
    state: &RuntimeState,
    label: &str,
    content: &str,
) -> Result<ArtifactRef, RpcError> {
    let redactor = state.redactor.lock().expect("redactor lock");
    with_artifacts(state, |store| {
        store
            .create(
                content.as_bytes(),
                "text/plain",
                Some(label),
                cbc_artifacts::RetentionClass::Session,
                Some(&redactor),
            )
            .map_err(artifact_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_errors_keep_their_stable_taxonomy() {
        let missing = artifact_error(cbc_artifacts::ArtifactError::NotFound {
            id: "art_missing".to_string(),
        });
        assert_eq!(missing.code, error_codes::NOT_FOUND);
        assert_eq!(
            missing
                .data
                .as_ref()
                .and_then(|data| data["taxonomy"].as_str()),
            Some("NOT_FOUND")
        );

        let mismatch = artifact_error(cbc_artifacts::ArtifactError::DigestMismatch {
            id: "art_bad".to_string(),
            expected: "a".repeat(64),
            actual: "b".repeat(64),
        });
        assert_eq!(mismatch.code, error_codes::HASH_MISMATCH);
        assert_eq!(
            mismatch
                .data
                .as_ref()
                .and_then(|data| data["taxonomy"].as_str()),
            Some("HASH_MISMATCH")
        );
    }
}
