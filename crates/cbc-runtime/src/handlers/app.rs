//! Internal app.* handlers backing the client-facing App Server.
//!
//! These are deliberately not SDK methods. They are a narrow host-to-runtime
//! bridge for durable client identity and event cursor state; the public App
//! Server remains responsible for transport authentication and role checks.

use cbc_protocol::{error_codes, RpcError};
use cbc_session_store::{
    AppClientUpsert, AppEventFilter, AppSubscriptionAck, AppSubscriptionCreate,
    AppSubscriptionRecord, AppSubscriptionState, EventPageRequest, SessionStore, StoreError,
    StoredEvent, DEFAULT_EVENT_PAGE_BYTES, DEFAULT_EVENT_PAGE_ITEMS, MAX_EVENT_PAGE_BYTES,
    MAX_EVENT_PAGE_ITEMS,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::server::RuntimeState;

fn store_error(error: StoreError) -> RpcError {
    let (code, taxonomy) = match &error {
        StoreError::NotFound { .. } => (error_codes::NOT_FOUND, "NOT_FOUND"),
        StoreError::CredentialRejected { .. } => {
            (error_codes::PERMISSION_DENIED, "PERMISSION_DENIED")
        }
        StoreError::AppSubscriptionCursorAhead { .. } => {
            (error_codes::TRANSACTION_CONFLICT, "CURSOR_AHEAD")
        }
        StoreError::InvalidAppServer { .. } | StoreError::InvalidPageRequest { .. } => {
            (error_codes::INVALID_ARGUMENT, "INVALID_ARGUMENT")
        }
        _ => (error_codes::INTERNAL_ERROR, "INTERNAL"),
    };
    RpcError::taxonomy(code, taxonomy, error.to_string())
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

fn current_workspace_identity(state: &RuntimeState) -> Result<String, RpcError> {
    Ok(state.require_workspace()?.fingerprint())
}

fn ensure_current_workspace_session(
    store: &SessionStore,
    workspace_identity: &str,
    session_id: &str,
) -> Result<(), RpcError> {
    let manifest = store.load_manifest(session_id).map_err(store_error)?;
    if manifest.workspace_fingerprint != workspace_identity {
        // Do not disclose another workspace's session by returning a mismatched
        // identity or a permission hint.
        return Err(RpcError::taxonomy(
            error_codes::NOT_FOUND,
            "NOT_FOUND",
            format!("session {session_id} is not available in this workspace"),
        ));
    }
    Ok(())
}

fn owned_subscription(
    store: &SessionStore,
    subscription_id: &str,
    client_id: &str,
) -> Result<AppSubscriptionRecord, RpcError> {
    let subscription = store
        .app_subscription(subscription_id)
        .map_err(store_error)?
        .ok_or_else(|| {
            RpcError::taxonomy(
                error_codes::NOT_FOUND,
                "NOT_FOUND",
                format!("app subscription {subscription_id} was not found"),
            )
        })?;
    if subscription.client_id != client_id {
        // Keep ownership failures indistinguishable from an unknown ID.
        return Err(RpcError::taxonomy(
            error_codes::NOT_FOUND,
            "NOT_FOUND",
            format!("app subscription {subscription_id} was not found"),
        ));
    }
    Ok(subscription)
}

pub fn client_upsert(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let input: AppClientUpsert = serde_json::from_value(params)
        .map_err(|error| RpcError::invalid_params(format!("invalid app client: {error}")))?;
    let client = with_store(state, |store| {
        store.upsert_app_client(&input).map_err(store_error)
    })?;
    Ok(json!({ "client": client }))
}

pub fn subscription_create(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let input: AppSubscriptionCreate = serde_json::from_value(params)
        .map_err(|error| RpcError::invalid_params(format!("invalid app subscription: {error}")))?;
    let workspace_identity = current_workspace_identity(state)?;
    let subscription = with_store(state, |store| {
        ensure_current_workspace_session(store, &workspace_identity, &input.session_id)?;
        store.create_app_subscription(&input).map_err(store_error)
    })?;
    Ok(json!({ "subscription": subscription }))
}

pub fn subscription_ack(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let input: AppSubscriptionAck = serde_json::from_value(params).map_err(|error| {
        RpcError::invalid_params(format!("invalid app subscription ack: {error}"))
    })?;
    let workspace_identity = current_workspace_identity(state)?;
    let subscription = with_store(state, |store| {
        let existing = owned_subscription(store, &input.subscription_id, &input.client_id)?;
        ensure_current_workspace_session(store, &workspace_identity, &existing.session_id)?;
        store
            .acknowledge_app_subscription(&input)
            .map_err(store_error)
    })?;
    Ok(json!({ "subscription": subscription }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscriptionStateRequest {
    subscription_id: String,
    client_id: String,
    state: AppSubscriptionState,
    at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscriptionReplayRequest {
    subscription_id: String,
    client_id: String,
    #[serde(default)]
    after_sequence: Option<i64>,
    #[serde(default)]
    max_events: Option<usize>,
    #[serde(default)]
    max_bytes: Option<usize>,
}

pub fn subscription_state(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let input: SubscriptionStateRequest = serde_json::from_value(params).map_err(|error| {
        RpcError::invalid_params(format!("invalid app subscription state: {error}"))
    })?;
    let workspace_identity = current_workspace_identity(state)?;
    let subscription = with_store(state, |store| {
        let existing = owned_subscription(store, &input.subscription_id, &input.client_id)?;
        ensure_current_workspace_session(store, &workspace_identity, &existing.session_id)?;
        store
            .set_app_subscription_state(
                &input.subscription_id,
                &input.client_id,
                input.state,
                &input.at,
            )
            .map_err(store_error)
    })?;
    Ok(json!({ "subscription": subscription }))
}

/// Replay a bounded, durable journal segment for one owner-bound subscription.
///
/// The returned cursor is the last raw journal item scanned, rather than the
/// last item visible after filtering. That distinction is essential: callers
/// can advance past filtered rows without looping forever, while durable ACKs
/// remain explicit and monotonic in a separate request.
pub fn subscription_replay(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let input: SubscriptionReplayRequest = serde_json::from_value(params).map_err(|error| {
        RpcError::invalid_params(format!("invalid app subscription replay: {error}"))
    })?;
    let max_events = input.max_events.unwrap_or(DEFAULT_EVENT_PAGE_ITEMS);
    if max_events == 0 || max_events > MAX_EVENT_PAGE_ITEMS {
        return Err(RpcError::invalid_params(format!(
            "maxEvents must be between 1 and {MAX_EVENT_PAGE_ITEMS}"
        )));
    }
    let max_bytes = input.max_bytes.unwrap_or(DEFAULT_EVENT_PAGE_BYTES);
    if !(1024..=MAX_EVENT_PAGE_BYTES).contains(&max_bytes) {
        return Err(RpcError::invalid_params(format!(
            "maxBytes must be between 1024 and {MAX_EVENT_PAGE_BYTES}"
        )));
    }

    let workspace_identity = current_workspace_identity(state)?;
    let (subscription, after_sequence, page) = with_store(state, |store| {
        let subscription = owned_subscription(store, &input.subscription_id, &input.client_id)?;
        ensure_current_workspace_session(store, &workspace_identity, &subscription.session_id)?;
        if subscription.state == AppSubscriptionState::Closed {
            return Err(RpcError::invalid_params(
                "a closed app subscription cannot replay events",
            ));
        }
        let after_sequence = input
            .after_sequence
            .unwrap_or(subscription.last_acked_sequence);
        if after_sequence < subscription.last_acked_sequence {
            return Err(RpcError::invalid_params(
                "afterSequence cannot precede the durable acknowledgement cursor",
            ));
        }
        let page = store
            .read_event_page(
                &subscription.session_id,
                &EventPageRequest {
                    after_sequence: Some(after_sequence),
                    before_sequence: None,
                    anchor_hash: None,
                    through_sequence: None,
                    through_hash: None,
                    limit: max_events,
                    max_bytes,
                },
            )
            .map_err(store_error)?;
        Ok((subscription, after_sequence, page))
    })?;

    let cursor_sequence = page.page.last_sequence.unwrap_or(after_sequence);
    let events: Vec<Value> = page
        .events
        .iter()
        .filter(|event| event_matches_filter(event, &subscription.filter))
        .map(app_event_envelope)
        .collect();
    Ok(json!({
        "subscription": subscription,
        "events": events,
        "cursor": {
            "sessionId": subscription.session_id,
            "journalSequence": cursor_sequence,
        },
        "hasMore": page.page.has_more_after,
    }))
}

fn event_matches_filter(event: &StoredEvent, filter: &AppEventFilter) -> bool {
    // read_event_page only exposes durable rows. Ephemeral events are never
    // reconstructed from the journal, so includeEphemeral has no replay effect.
    (filter.kinds.is_empty() || filter.kinds.iter().any(|kind| kind == &event.kind))
        && (filter.visibility.is_empty()
            || filter
                .visibility
                .iter()
                .any(|visibility| visibility == &event.visibility))
}

fn app_event_envelope(event: &StoredEvent) -> Value {
    let mut envelope = Map::new();
    envelope.insert("schemaVersion".into(), json!(event.schema_version));
    envelope.insert("sequence".into(), json!(event.sequence));
    envelope.insert("id".into(), json!(event.id));
    envelope.insert("timestamp".into(), json!(event.timestamp));
    envelope.insert("sessionId".into(), json!(event.session_id));
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
    Value::Object(envelope)
}
