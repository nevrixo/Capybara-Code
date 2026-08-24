//! Internal app.* handlers backing the client-facing App Server.
//!
//! These are deliberately not SDK methods. They are a narrow host-to-runtime
//! bridge for durable client identity and event cursor state; the public App
//! Server remains responsible for transport authentication and role checks.

use cbc_protocol::{error_codes, RpcError};
use cbc_session_store::{
    AppClientUpsert, AppSubscriptionAck, AppSubscriptionCreate, AppSubscriptionState, SessionStore,
    StoreError,
};
use serde::Deserialize;
use serde_json::{json, Value};

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
        StoreError::InvalidAppServer { .. } => (error_codes::INVALID_ARGUMENT, "INVALID_ARGUMENT"),
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
        let existing = store
            .app_subscription(&input.subscription_id)
            .map_err(store_error)?
            .ok_or_else(|| {
                RpcError::taxonomy(
                    error_codes::NOT_FOUND,
                    "NOT_FOUND",
                    format!("app subscription {} was not found", input.subscription_id),
                )
            })?;
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

pub fn subscription_state(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let input: SubscriptionStateRequest = serde_json::from_value(params).map_err(|error| {
        RpcError::invalid_params(format!("invalid app subscription state: {error}"))
    })?;
    let workspace_identity = current_workspace_identity(state)?;
    let subscription = with_store(state, |store| {
        let existing = store
            .app_subscription(&input.subscription_id)
            .map_err(store_error)?
            .ok_or_else(|| {
                RpcError::taxonomy(
                    error_codes::NOT_FOUND,
                    "NOT_FOUND",
                    format!("app subscription {} was not found", input.subscription_id),
                )
            })?;
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
