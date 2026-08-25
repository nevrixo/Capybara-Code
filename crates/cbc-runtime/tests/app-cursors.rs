//! End-to-end coverage for the internal App Server cursor bridge.
//!
//! The client-facing server has its own role checks. These tests prove the
//! host-to-runtime boundary persists only a current-workspace session cursor and
//! preserves the store's monotonic and owner-bound invariants.

use std::path::PathBuf;

use cbc_protocol::error_codes;
use cbc_runtime::{call, RuntimeState};
use cbc_session_store::new_manifest;
use serde_json::{json, Value};

const TEST_ISSUER: &str = "tttttttttttttttttttttttttttttttt";

fn initialized() -> (tempfile::TempDir, PathBuf, RuntimeState) {
    let dir = tempfile::TempDir::new().expect("temporary directory");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let data = dir.path().join("data");
    let state = RuntimeState::new();
    call(
        &state,
        "runtime.initialize",
        json!({
            "protocolVersion": "1.0",
            "clientVersion": "app-cursor-test",
            "workspace": workspace.to_string_lossy(),
            "dataDir": data.to_string_lossy(),
            "capabilityIssuerToken": TEST_ISSUER,
        }),
    )
    .expect("initialize");
    (dir, workspace, state)
}

fn register_client(state: &RuntimeState, client_id: &str, kind: &str) -> Value {
    call(
        state,
        "app.client.upsert",
        json!({
            "clientId": client_id,
            "name": "App cursor integration test",
            "kind": kind,
            "version": "1.0.0",
            "seenAt": "2026-08-25T00:00:00.000Z",
        }),
    )
    .expect("register app client")
}

fn open_session_with_event(state: &RuntimeState, session_id: &str) {
    call(
        state,
        "session.open",
        json!({ "sessionId": session_id, "title": "App cursor test" }),
    )
    .expect("open session");
    call(
        state,
        "session.append",
        json!({
            "sessionId": session_id,
            "event": {
                "id": "evt_app_cursor",
                "kind": "user.message",
                "timestamp": "2026-08-25T00:00:01Z",
                "payload": { "text": "cursor checkpoint" },
            },
        }),
    )
    .expect("append journal event");
}

fn append_event(
    state: &RuntimeState,
    session_id: &str,
    id: &str,
    visibility: &str,
    timestamp: &str,
) {
    call(
        state,
        "session.append",
        json!({
            "sessionId": session_id,
            "event": {
                "id": id,
                "kind": "user.message",
                "timestamp": timestamp,
                "visibility": visibility,
                "payload": { "text": id },
            },
        }),
    )
    .expect("append replay journal event");
}

#[test]
fn app_cursor_bridge_enforces_session_owner_and_monotonic_cursor_rules() {
    let (_dir, _workspace, state) = initialized();
    open_session_with_event(&state, "ses_app_cursor");

    let client = register_client(&state, "client_tui", "tui");
    assert_eq!(client["client"]["clientId"], "client_tui");
    assert_eq!(client["client"]["kind"], "tui");

    let created = call(
        &state,
        "app.subscription.create",
        json!({
            "id": "sub_timeline",
            "clientId": "client_tui",
            "sessionId": "ses_app_cursor",
            "filter": {
                "kinds": ["user.message"],
                "visibility": ["timeline"],
                "includeEphemeral": false,
            },
            "initialAckedSequence": 0,
            "createdAt": "2026-08-25T00:00:02.000Z",
        }),
    )
    .expect("create cursor");
    assert_eq!(created["subscription"]["state"], "active");
    assert_eq!(created["subscription"]["lastAckedSequence"], 0);

    let acknowledged = call(
        &state,
        "app.subscription.ack",
        json!({
            "subscriptionId": "sub_timeline",
            "clientId": "client_tui",
            "sequence": 1,
            "at": "2026-08-25T00:00:03.000Z",
        }),
    )
    .expect("ack journal head");
    assert_eq!(acknowledged["subscription"]["lastAckedSequence"], 1);

    let ahead = call(
        &state,
        "app.subscription.ack",
        json!({
            "subscriptionId": "sub_timeline",
            "clientId": "client_tui",
            "sequence": 2,
            "at": "2026-08-25T00:00:04.000Z",
        }),
    )
    .expect_err("ack beyond a session head is rejected");
    assert_eq!(ahead.code, error_codes::TRANSACTION_CONFLICT);

    register_client(&state, "client_other", "sdk");
    let foreign = call(
        &state,
        "app.subscription.ack",
        json!({
            "subscriptionId": "sub_timeline",
            "clientId": "client_other",
            "sequence": 1,
            "at": "2026-08-25T00:00:04.000Z",
        }),
    )
    .expect_err("a different client cannot advance the cursor");
    assert_eq!(foreign.code, error_codes::NOT_FOUND);

    let closed = call(
        &state,
        "app.subscription.state",
        json!({
            "subscriptionId": "sub_timeline",
            "clientId": "client_tui",
            "state": "closed",
            "at": "2026-08-25T00:00:05.000Z",
        }),
    )
    .expect("close cursor");
    assert_eq!(closed["subscription"]["state"], "closed");

    let after_close = call(
        &state,
        "app.subscription.ack",
        json!({
            "subscriptionId": "sub_timeline",
            "clientId": "client_tui",
            "sequence": 1,
            "at": "2026-08-25T00:00:06.000Z",
        }),
    )
    .expect_err("closed cursor cannot be acknowledged");
    assert_eq!(after_close.code, error_codes::INVALID_ARGUMENT);
}

#[test]
fn app_cursor_bridge_rejects_unknown_client_fields() {
    let (_dir, _workspace, state) = initialized();
    let error = call(
        &state,
        "app.client.upsert",
        json!({
            "clientId": "client_strict",
            "name": "Strict client",
            "kind": "plugin-host",
            "version": "1.0.0",
            "seenAt": "2026-08-25T00:00:00.000Z",
            "untrustedAuthority": "controller",
        }),
    )
    .expect_err("unrecognized client authority must not be ignored");
    assert_eq!(error.code, error_codes::INVALID_PARAMS);
}

#[test]
fn app_cursor_bridge_hides_sessions_from_another_workspace() {
    let (_dir, _workspace, state) = initialized();
    let foreign = new_manifest(
        "ses_foreign",
        "C:/outside-workspace",
        "foreign-workspace-fingerprint",
        "Foreign session",
        "auto",
        "auto-review",
    );
    state
        .store
        .lock()
        .expect("store lock")
        .as_mut()
        .expect("initialized store")
        .create_session(&foreign)
        .expect("seed a foreign session");
    register_client(&state, "client_workspace", "ide");

    let error = call(
        &state,
        "app.subscription.create",
        json!({
            "id": "sub_foreign",
            "clientId": "client_workspace",
            "sessionId": "ses_foreign",
            "filter": {},
            "initialAckedSequence": 0,
            "createdAt": "2026-08-25T00:00:02.000Z",
        }),
    )
    .expect_err("a client cannot subscribe to a foreign workspace session");
    assert_eq!(error.code, error_codes::NOT_FOUND);
}

#[test]
fn app_cursor_replay_filters_rows_and_advances_the_raw_cursor() {
    let (_dir, _workspace, state) = initialized();
    open_session_with_event(&state, "ses_replay");
    append_event(
        &state,
        "ses_replay",
        "evt_hidden",
        "hidden",
        "2026-08-25T00:00:02Z",
    );
    append_event(
        &state,
        "ses_replay",
        "evt_visible",
        "timeline",
        "2026-08-25T00:00:03Z",
    );
    register_client(&state, "client_replay", "sdk");
    call(
        &state,
        "app.subscription.create",
        json!({
            "id": "sub_replay",
            "clientId": "client_replay",
            "sessionId": "ses_replay",
            "filter": {
                "kinds": ["user.message"],
                "visibility": ["timeline"],
                "includeEphemeral": false,
            },
            "initialAckedSequence": 0,
            "createdAt": "2026-08-25T00:00:04.000Z",
        }),
    )
    .expect("create replay subscription");

    let first = call(
        &state,
        "app.subscription.replay",
        json!({
            "subscriptionId": "sub_replay",
            "clientId": "client_replay",
            "maxEvents": 2,
            "maxBytes": 2048,
        }),
    )
    .expect("replay first raw page");
    assert_eq!(first["events"].as_array().expect("events array").len(), 1);
    assert_eq!(first["events"][0]["id"], "evt_app_cursor");
    assert_eq!(first["events"][0]["durability"], "journaled");
    assert!(first["events"][0].get("eventHash").is_none());
    assert_eq!(first["cursor"]["sessionId"], "ses_replay");
    assert_eq!(first["cursor"]["journalSequence"], 2);
    assert_eq!(first["hasMore"], true);

    let acknowledged = call(
        &state,
        "app.subscription.ack",
        json!({
            "subscriptionId": "sub_replay",
            "clientId": "client_replay",
            "sequence": 2,
            "at": "2026-08-25T00:00:05.000Z",
        }),
    )
    .expect("ack raw replay cursor");
    assert_eq!(acknowledged["subscription"]["lastAckedSequence"], 2);

    let stale = call(
        &state,
        "app.subscription.replay",
        json!({
            "subscriptionId": "sub_replay",
            "clientId": "client_replay",
            "afterSequence": 1,
        }),
    )
    .expect_err("replay cannot move before the durable cursor");
    assert_eq!(stale.code, error_codes::INVALID_PARAMS);

    let second = call(
        &state,
        "app.subscription.replay",
        json!({
            "subscriptionId": "sub_replay",
            "clientId": "client_replay",
            "maxEvents": 2,
            "maxBytes": 2048,
        }),
    )
    .expect("replay after durable cursor");
    assert_eq!(second["events"].as_array().expect("events array").len(), 1);
    assert_eq!(second["events"][0]["id"], "evt_visible");
    assert_eq!(second["cursor"]["journalSequence"], 3);
    assert_eq!(second["hasMore"], false);

    register_client(&state, "client_replay_other", "ide");
    let foreign = call(
        &state,
        "app.subscription.replay",
        json!({
            "subscriptionId": "sub_replay",
            "clientId": "client_replay_other",
        }),
    )
    .expect_err("another client cannot replay an owner-bound cursor");
    assert_eq!(foreign.code, error_codes::NOT_FOUND);
}
