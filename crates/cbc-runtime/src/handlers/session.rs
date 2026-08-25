//! `session.*` handlers — PRD §18.6–§18.8, §18.16, §20.9, AC-35, AC-46.
//!
//! P0-05: the SQLite store is the single session authority. `list`, `export`,
//! `fork`, logical `delete` (archive), and `set_status` all live here so the CLI
//! never touches a host-side index or immutable journal file again.

use cbc_protocol::{error_codes, RpcError};
use cbc_session_store::{
    AppendEvent, EventPageRequest, SessionStatus, SessionStore, SnapshotEnvelope, StoredEvent,
    DEFAULT_EVENT_PAGE_BYTES, DEFAULT_EVENT_PAGE_ITEMS, MAX_EVENT_PAGE_BYTES, MAX_EVENT_PAGE_ITEMS,
    SNAPSHOT_ENVELOPE_VERSION,
};
use serde_json::{json, Value};

use crate::server::{optional_bool, optional_str, optional_usize, required_str, RuntimeState};

fn store_error(e: cbc_session_store::StoreError) -> RpcError {
    let code = match &e {
        cbc_session_store::StoreError::NotFound { .. } => error_codes::NOT_FOUND,
        cbc_session_store::StoreError::CredentialRejected { .. } => error_codes::PERMISSION_DENIED,
        cbc_session_store::StoreError::SchemaTooNew { .. }
        | cbc_session_store::StoreError::UnsupportedSnapshotVersion { .. } => {
            error_codes::PROTOCOL_INCOMPATIBLE
        }
        cbc_session_store::StoreError::InvalidPageRequest { .. }
        | cbc_session_store::StoreError::InvalidSnapshot { .. } => error_codes::INVALID_ARGUMENT,
        cbc_session_store::StoreError::BoundaryMismatch { .. } => error_codes::HASH_MISMATCH,
        _ => error_codes::INTERNAL_ERROR,
    };
    RpcError::taxonomy(code, "INTERNAL", e.to_string())
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

fn optional_i64_param(params: &Value, key: &str) -> Result<Option<i64>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| RpcError::invalid_params(format!("{key} must be an integer"))),
    }
}

fn optional_usize_param(params: &Value, key: &str, default: usize) -> Result<usize, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|number| usize::try_from(number).ok())
            .ok_or_else(|| {
                RpcError::invalid_params(format!("{key} must be a non-negative integer"))
            }),
    }
}

fn optional_string_param(params: &Value, key: &str) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(RpcError::invalid_params(format!("{key} must be a string"))),
    }
}

fn merge_optional_hashes(
    first: Option<String>,
    second: Option<String>,
    label: &str,
) -> Result<Option<String>, RpcError> {
    match (first, second) {
        (Some(left), Some(right)) if left != right => Err(RpcError::invalid_params(format!(
            "{label} must match when both are supplied"
        ))),
        (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn merge_optional_sequences(
    first: Option<i64>,
    second: Option<i64>,
    label: &str,
) -> Result<Option<i64>, RpcError> {
    match (first, second) {
        (Some(left), Some(right)) if left != right => Err(RpcError::invalid_params(format!(
            "{label} must match when both are supplied"
        ))),
        (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn render_snapshot(snapshot: &cbc_session_store::StoredSnapshot) -> Value {
    let envelope = &snapshot.envelope;
    json!({
        // Legacy aliases remain readable while new clients use the explicitly
        // named durable/stream positions.
        "sequence": envelope.journal_sequence,
        "snapshotVersion": envelope.snapshot_version,
        "sessionId": envelope.session_id,
        "journalSequence": envelope.journal_sequence,
        "streamSequence": envelope.stream_sequence,
        "journalHash": envelope.journal_hash,
        "reducerState": envelope.reducer_state,
        "checksum": snapshot.checksum,
        "createdAt": snapshot.created_at,
        "legacy": snapshot.legacy,
    })
}

pub fn open(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let session_id = required_str(&params, "sessionId")?;
    let resume = params
        .get("resume")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if resume {
        let (manifest, integrity, reconcile, snapshot, replay_from, replay_through) =
            with_store(state, |store| {
                let manifest = store.load_manifest(&session_id).map_err(store_error)?;
                let integrity = store.verify_integrity(&session_id).map_err(store_error)?;
                let reconcile = store
                    .reconcile_startup(&cbc_patch::now_iso8601())
                    .map_err(store_error)?;
                // Load only a checksum/version/shape-valid snapshot within the
                // verified journal prefix. The caller replays its tail, never the
                // immutable prefix already represented by reducerState.
                let snapshot = store
                    .latest_snapshot_envelope(&session_id, Some(integrity.last_valid_sequence))
                    .map_err(store_error)?;
                let replay_sequence = snapshot
                    .as_ref()
                    .map(|value| value.envelope.journal_sequence)
                    .unwrap_or(0);
                let replay_from = store
                    .journal_boundary(&session_id, replay_sequence)
                    .map_err(store_error)?;
                let replay_through = store
                    .journal_boundary(&session_id, integrity.last_valid_sequence)
                    .map_err(store_error)?;
                Ok((
                    manifest,
                    integrity,
                    reconcile,
                    snapshot,
                    replay_from,
                    replay_through,
                ))
            })?;

        return Ok(json!({
            "sessionId": session_id,
            "resumed": true,
            "manifest": manifest,
            "integrity": integrity,
            "reconcile": reconcile,
            "snapshot": snapshot.as_ref().map(render_snapshot),
            "replay": {
                "tailOnly": true,
                "afterJournalSequence": replay_from.sequence,
                "afterHash": replay_from.event_hash,
                "throughJournalSequence": replay_through.sequence,
                "throughHash": replay_through.event_hash,
            },
        }));
    }

    let manifest = cbc_session_store::new_manifest(
        &session_id,
        &ws.root().to_string_lossy(),
        &ws.fingerprint(),
        &optional_str(&params, "title").unwrap_or_else(|| "Untitled session".to_string()),
        &optional_str(&params, "modelProfile").unwrap_or_else(|| "auto".to_string()),
        &optional_str(&params, "permissionMode").unwrap_or_else(|| "auto-review".to_string()),
    );
    with_store(state, |store| {
        store.create_session(&manifest).map_err(store_error)
    })?;

    Ok(json!({
        "sessionId": session_id,
        "resumed": false,
        "manifest": manifest,
    }))
}

pub fn append(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let session_id = required_str(&params, "sessionId")?;
    let events_value = params
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            params
                .get("event")
                .cloned()
                .map(|e| vec![e])
                .unwrap_or_default()
        });
    if events_value.is_empty() {
        return Err(RpcError::invalid_params(
            "append requires 'event' or a non-empty 'events' array",
        ));
    }

    let mut parsed = Vec::new();
    for raw in events_value {
        let mut event: AppendEvent = serde_json::from_value(raw)
            .map_err(|e| RpcError::invalid_params(format!("invalid event: {e}")))?;
        // P0-06: the whole payload passes through the redactor *before* it reaches
        // the journal, so a secret-shaped string can never be made durable. The
        // store's own credential-field check remains the second line of defence.
        let payload_text = serde_json::to_string(&event.payload)
            .map_err(|e| RpcError::invalid_params(format!("unserializable payload: {e}")))?;
        let redacted = state.redact(&payload_text);
        event.payload =
            serde_json::from_str(&redacted).unwrap_or(serde_json::Value::String(redacted));
        parsed.push(event);
    }

    let stored = with_store(state, |store| {
        store
            .append_events(&session_id, &parsed)
            .map_err(store_error)
    })?;

    Ok(json!({
        "sessionId": session_id,
        "appended": stored.len(),
        "lastSequence": stored.iter().map(|e| e.sequence).max().unwrap_or(0),
        "events": stored.iter().map(|e| json!({
            "sequence": e.sequence,
            "id": e.id,
            "kind": e.kind,
            "eventHash": e.event_hash,
            "prevHash": e.prev_hash,
        })).collect::<Vec<_>>(),
    }))
}

pub fn snapshot(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let session_id = required_str(&params, "sessionId")?;
    let legacy_sequence = optional_i64_param(&params, "sequence")?;
    let journal_sequence = optional_i64_param(&params, "journalSequence")?;
    let journal_sequence = match (legacy_sequence, journal_sequence) {
        (Some(legacy), Some(explicit)) if legacy != explicit => {
            return Err(RpcError::invalid_params(
                "sequence and journalSequence must match when both are supplied",
            ));
        }
        (Some(sequence), _) | (_, Some(sequence)) => sequence,
        (None, None) => {
            return Err(RpcError::invalid_params(
                "journalSequence (or legacy sequence) is required",
            ));
        }
    };
    let reducer_state = params
        .get("reducerState")
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("reducerState is required"))?;
    let stream_sequence = optional_i64_param(&params, "streamSequence")?;
    let snapshot_version = match params.get("snapshotVersion") {
        None => SNAPSHOT_ENVELOPE_VERSION,
        Some(value) => value
            .as_u64()
            .and_then(|version| u32::try_from(version).ok())
            .ok_or_else(|| RpcError::invalid_params("snapshotVersion must be an integer"))?,
    };
    let journal_hash = match params.get("journalHash") {
        None => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => {
            return Err(RpcError::invalid_params("journalHash must be a string"));
        }
    };
    let envelope = SnapshotEnvelope {
        snapshot_version,
        session_id: session_id.clone(),
        journal_sequence,
        stream_sequence,
        journal_hash,
        reducer_state,
    };

    let (checksum, boundary) = with_store(state, |store| {
        let checksum = store
            .write_snapshot_envelope(&envelope)
            .map_err(store_error)?;
        let boundary = store
            .journal_boundary(&session_id, journal_sequence)
            .map_err(store_error)?;
        Ok((checksum, boundary))
    })?;

    Ok(json!({
        "sessionId": session_id,
        // Legacy alias retained for existing clients.
        "sequence": journal_sequence,
        "snapshotVersion": snapshot_version,
        "journalSequence": journal_sequence,
        "streamSequence": stream_sequence,
        "journalHash": boundary.event_hash,
        "checksum": checksum,
    }))
}

pub fn load(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    // Backward-compatible listing mode. Logical deletion archives a session, so
    // archived rows are hidden unless diagnostics explicitly request them.
    if params.get("sessionId").is_none() {
        let limit = optional_usize(&params, "limit", 25);
        let include_archived = optional_bool(&params, "includeArchived", false);
        let sessions = with_store(state, |store| {
            if include_archived {
                store.list_sessions(limit).map_err(store_error)
            } else {
                store.list_visible_sessions(limit).map_err(store_error)
            }
        })?;
        return Ok(json!({ "sessions": sessions }));
    }

    let session_id = required_str(&params, "sessionId")?;
    let after = optional_i64_param(&params, "afterSequence")?;
    let before = optional_i64_param(&params, "beforeSequence")?;
    if after.is_some() && before.is_some() {
        return Err(RpcError::invalid_params(
            "afterSequence and beforeSequence are mutually exclusive",
        ));
    }
    let tail_only = optional_bool(&params, "tailOnly", false);
    if tail_only && before.is_some() {
        return Err(RpcError::invalid_params(
            "tailOnly cannot be combined with beforeSequence",
        ));
    }
    let limit = optional_usize_param(&params, "limit", DEFAULT_EVENT_PAGE_ITEMS)?;
    let max_bytes = optional_usize_param(&params, "maxBytes", DEFAULT_EVENT_PAGE_BYTES)?;
    if limit == 0 || max_bytes == 0 {
        return Err(RpcError::invalid_params(
            "limit and maxBytes must both be greater than zero",
        ));
    }
    let requested_through = merge_optional_sequences(
        optional_i64_param(&params, "throughSequence")?,
        optional_i64_param(&params, "throughJournalSequence")?,
        "throughSequence and throughJournalSequence",
    )?;
    let through_hash = optional_string_param(&params, "throughHash")?;
    let generic_anchor_hash = optional_string_param(&params, "anchorHash")?;
    let directional_anchor_hash = if before.is_some() {
        optional_string_param(&params, "beforeHash")?
    } else {
        optional_string_param(&params, "afterHash")?
    };
    let anchor_hash = merge_optional_hashes(
        generic_anchor_hash,
        directional_anchor_hash,
        "anchorHash and directional hash",
    )?;

    let (manifest, page, integrity, count, snapshot) = with_store(state, |store| {
        let manifest = store.load_manifest(&session_id).map_err(store_error)?;
        let integrity = store.verify_integrity(&session_id).map_err(store_error)?;
        let snapshot = if tail_only {
            store
                .latest_snapshot_envelope(&session_id, Some(integrity.last_valid_sequence))
                .map_err(store_error)?
        } else {
            None
        };
        let after_sequence = if before.is_some() {
            None
        } else {
            Some(after.unwrap_or_else(|| {
                snapshot
                    .as_ref()
                    .map(|value| value.envelope.journal_sequence)
                    .unwrap_or(0)
            }))
        };
        let through_sequence = requested_through.unwrap_or(integrity.last_valid_sequence);
        if through_sequence > integrity.last_valid_sequence {
            return Err(RpcError::invalid_params(format!(
                "throughSequence {through_sequence} exceeds the last verified journal sequence {}",
                integrity.last_valid_sequence
            )));
        }
        let page = store
            .read_event_page(
                &session_id,
                &EventPageRequest {
                    after_sequence,
                    before_sequence: before,
                    anchor_hash: anchor_hash.clone(),
                    through_sequence: Some(through_sequence),
                    through_hash: through_hash.clone(),
                    limit: limit.min(MAX_EVENT_PAGE_ITEMS),
                    max_bytes: max_bytes.min(MAX_EVENT_PAGE_BYTES),
                },
            )
            .map_err(store_error)?;
        let count = store.event_count(&session_id).map_err(store_error)?;
        Ok((manifest, page, integrity, count, snapshot))
    })?;

    let earlier_page = if page.page.has_more_before {
        page.events
            .first()
            .map(|first| (first.sequence, first.event_hash.clone()))
            .or_else(|| {
                (page.page.anchor_sequence > 0)
                    .then(|| {
                        page.page
                            .anchor_hash
                            .clone()
                            .map(|hash| (page.page.anchor_sequence, hash))
                    })
                    .flatten()
            })
            .map(|(before_sequence, before_hash)| {
                json!({
                    "beforeSequence": before_sequence,
                    "beforeHash": before_hash,
                    "throughSequence": page.page.through.sequence,
                    "throughHash": page.page.through.event_hash,
                })
            })
    } else {
        None
    };
    let later_page = page.events.last().and_then(|last| {
        page.page.has_more_after.then(|| {
            json!({
                "afterSequence": last.sequence,
                "afterHash": last.event_hash,
                "throughSequence": page.page.through.sequence,
                "throughHash": page.page.through.event_hash,
            })
        })
    });

    Ok(json!({
        "manifest": manifest,
        "events": page.events,
        "page": page.page,
        "earlierPage": earlier_page,
        "laterPage": later_page,
        "integrity": integrity,
        "eventCount": count,
        "snapshot": snapshot.as_ref().map(render_snapshot),
        "tailOnly": tail_only,
    }))
}

/// Mark a session's final state (§18.6).
pub fn set_status(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let session_id = required_str(&params, "sessionId")?;
    let status = required_str(&params, "status")?;
    let parsed = SessionStatus::parse(&status);
    with_store(state, |store| {
        store
            .set_session_status(&session_id, parsed, &cbc_patch::now_iso8601())
            .map_err(store_error)
    })?;
    Ok(json!({ "sessionId": session_id, "status": parsed.label() }))
}

/// List sessions. Workspace-scoped by default (§8.6: a selector must never reach
/// another repository's sessions); `all: true` lists everything for diagnostics.
pub fn list(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let limit = optional_usize(&params, "limit", 100);
    let all = optional_bool(&params, "all", false);
    let include_archived = optional_bool(&params, "includeArchived", false);

    let sessions = with_store(state, |store| match (all, include_archived) {
        (true, true) => store.list_sessions(limit).map_err(store_error),
        (true, false) => store.list_visible_sessions(limit).map_err(store_error),
        (false, true) => store
            .list_sessions_for_workspace(&ws.fingerprint(), limit)
            .map_err(store_error),
        (false, false) => store
            .list_visible_sessions_for_workspace(&ws.fingerprint(), limit)
            .map_err(store_error),
    })?;

    Ok(json!({ "sessions": sessions }))
}

/// Resolve one resume selector without transferring the entire session index.
pub fn resolve(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let selector = required_str(&params, "selector")?;
    let (session, candidates) = with_store(state, |store| {
        if selector == "last" {
            let sessions = store
                .list_visible_sessions_for_workspace(&ws.fingerprint(), 1)
                .map_err(store_error)?;
            return Ok((sessions.first().cloned(), sessions));
        }

        if selector.starts_with("ses_") {
            if let Ok(manifest) = store.load_manifest(&selector) {
                if manifest.workspace_fingerprint == ws.fingerprint()
                    && manifest.state != SessionStatus::Archived
                {
                    return Ok((Some(manifest.clone()), vec![manifest]));
                }
            }
            // A short ses_ selector falls through to the bounded unique-prefix
            // lookup; an unknown id never leaks another workspace's manifest.
        }

        let sessions = store
            .list_visible_sessions_for_workspace(&ws.fingerprint(), 256)
            .map_err(store_error)?;
        if let Some(manifest) = sessions.iter().find(|entry| entry.title == selector) {
            return Ok((Some(manifest.clone()), vec![manifest.clone()]));
        }

        let matches: Vec<_> = sessions
            .into_iter()
            .filter(|entry| entry.id.starts_with(&selector) || entry.title.starts_with(&selector))
            .collect();
        let selected = if matches.len() == 1 {
            matches.first().cloned()
        } else {
            None
        };
        Ok((selected, matches.into_iter().take(8).collect()))
    })?;
    Ok(json!({
        "session": session,
        "candidates": candidates,
    }))
}
/// Export the durable journal as JSONL in the §20.10 event envelope, so a
/// consumer can replay it with the same parser it uses for live events.
pub fn export(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let session_id = required_str(&params, "sessionId")?;

    let (manifest, events) = with_store(state, |store| {
        let manifest = store.load_manifest(&session_id).map_err(store_error)?;
        let events = store
            .read_events(&session_id, 0, usize::MAX)
            .map_err(store_error)?;
        Ok((manifest, events))
    })?;

    let mut jsonl = String::new();
    for event in &events {
        jsonl.push_str(&render_event_jsonl(&session_id, event));
        jsonl.push('\n');
    }

    Ok(json!({
        "sessionId": session_id,
        "manifest": manifest,
        "eventCount": events.len(),
        "jsonl": jsonl,
    }))
}

fn render_event_jsonl(session_id: &str, event: &StoredEvent) -> String {
    let mut envelope = serde_json::Map::new();
    envelope.insert("schemaVersion".into(), json!(event.schema_version));
    envelope.insert("sequence".into(), json!(event.sequence));
    envelope.insert("id".into(), json!(event.id));
    envelope.insert("timestamp".into(), json!(event.timestamp));
    envelope.insert("sessionId".into(), json!(session_id));
    envelope.insert("kind".into(), json!(event.kind));
    envelope.insert("level".into(), json!(event.level));
    envelope.insert("visibility".into(), json!(event.visibility));
    envelope.insert("durability".into(), json!("journaled"));
    envelope.insert("payload".into(), event.payload.clone());
    if let Some(turn_id) = &event.turn_id {
        envelope.insert("turnId".into(), json!(turn_id));
    }
    if let Some(agent_id) = &event.agent_id {
        envelope.insert("agentId".into(), json!(agent_id));
    }
    Value::Object(envelope).to_string()
}

/// §18.12: fork copies the whole durable journal into a new session id and
/// records the parent, leaving the source untouched.
pub fn fork(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let session_id = required_str(&params, "sessionId")?;
    let new_session_id = required_str(&params, "newSessionId")?;
    let title = optional_str(&params, "title").unwrap_or_else(|| "Forked session".to_string());

    let manifest = with_store(state, |store| {
        store
            .fork_session(
                &session_id,
                &new_session_id,
                &title,
                &cbc_patch::now_iso8601(),
            )
            .map_err(store_error)
    })?;

    Ok(json!({
        "sessionId": new_session_id,
        "forkedFrom": session_id,
        "manifest": manifest,
    }))
}

/// §8.6 logical deletion. The durable journal is immutable: this endpoint keeps
/// its historical name for compatibility but only archives the manifest.
pub fn delete(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let session_id = required_str(&params, "sessionId")?;
    let preserved_events = with_store(state, |store| {
        store.archive_session(&session_id).map_err(store_error)
    })?;
    Ok(json!({
        "sessionId": session_id,
        // "deleted" means absent from default lists, not physically erased.
        "deleted": true,
        "archived": true,
        "eventsRemoved": 0,
        "eventsPreserved": preserved_events,
    }))
}
