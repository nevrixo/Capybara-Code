use std::path::PathBuf;

use cbc_protocol::error_codes;
use cbc_runtime::{call, RuntimeState};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

const TEST_ISSUER: &str = "tttttttttttttttttttttttttttttttt";

fn initialized() -> (tempfile::TempDir, PathBuf, RuntimeState) {
    let dir = tempfile::TempDir::new().unwrap();
    let workspace = dir.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let data = dir.path().join("data");
    let state = RuntimeState::new();
    call(
        &state,
        "runtime.initialize",
        json!({
            "protocolVersion": "1.0",
            "clientVersion": "test",
            "workspace": workspace.to_string_lossy(),
            "dataDir": data.to_string_lossy(),
            "capabilityIssuerToken": TEST_ISSUER,
        }),
    )
    .expect("initialize");
    (dir, data, state)
}

fn open(state: &RuntimeState, session_id: &str) -> Value {
    call(
        state,
        "session.open",
        json!({ "sessionId": session_id, "title": "paging test" }),
    )
    .expect("open session")
}

fn append(state: &RuntimeState, session_id: &str, count: usize) {
    let events = (1..=count)
        .map(|index| {
            json!({
                "id": format!("evt_{index}"),
                "kind": "user.message",
                "timestamp": format!("2026-08-09T00:00:{index:02}Z"),
                "streamSequence": index * 2 - 1,
                "payload": { "text": format!("message-{index}-{}", "x".repeat(128)) },
            })
        })
        .collect::<Vec<_>>();
    call(
        state,
        "session.append",
        json!({ "sessionId": session_id, "events": events }),
    )
    .expect("append events");
}

fn event_sequences(response: &Value) -> Vec<i64> {
    response["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|event| event["sequence"].as_i64().expect("sequence"))
        .collect()
}

#[test]
fn session_load_pages_both_directions_with_stable_cursor_hashes() {
    let (_dir, _data, state) = initialized();
    open(&state, "ses_page");
    append(&state, "ses_page", 7);

    let first = call(
        &state,
        "session.load",
        json!({
            "sessionId": "ses_page",
            "afterSequence": 0,
            "limit": 2,
            "maxBytes": 4096,
        }),
    )
    .expect("first page");
    assert_eq!(event_sequences(&first), vec![1, 2]);
    assert_eq!(first["page"]["direction"], "forward");
    assert_eq!(first["page"]["through"]["sequence"], 7);
    assert_eq!(first["page"]["journalHead"]["sequence"], 7);
    assert!(first["earlierPage"].is_null());
    assert_eq!(first["laterPage"]["afterSequence"], 2);
    assert!(first["page"]["encodedBytes"].as_u64().unwrap() <= 4096);

    let cursor = first["laterPage"].clone();
    let second = call(
        &state,
        "session.load",
        json!({
            "sessionId": "ses_page",
            "afterSequence": cursor["afterSequence"],
            "afterHash": cursor["afterHash"],
            "throughSequence": cursor["throughSequence"],
            "throughHash": cursor["throughHash"],
            "limit": 2,
        }),
    )
    .expect("second page");
    assert_eq!(event_sequences(&second), vec![3, 4]);

    let backward = call(
        &state,
        "session.load",
        json!({
            "sessionId": "ses_page",
            "beforeSequence": 7,
            "limit": 3,
        }),
    )
    .expect("backward page");
    assert_eq!(event_sequences(&backward), vec![4, 5, 6]);
    assert_eq!(backward["page"]["direction"], "backward");
    assert_eq!(backward["earlierPage"]["beforeSequence"], 4);

    let stale = call(
        &state,
        "session.load",
        json!({
            "sessionId": "ses_page",
            "afterSequence": 2,
            "afterHash": "not-the-boundary-hash",
        }),
    )
    .expect_err("stale boundary must fail");
    assert_eq!(stale.code, error_codes::HASH_MISMATCH);

    let mismatched_aliases = call(
        &state,
        "session.load",
        json!({
            "sessionId": "ses_page",
            "throughSequence": 6,
            "throughJournalSequence": 7,
        }),
    )
    .expect_err("cursor aliases must agree");
    assert_eq!(mismatched_aliases.code, error_codes::INVALID_PARAMS);
}

#[test]
fn snapshot_resume_returns_distinct_sequences_and_tail_only_replay() {
    let (_dir, _data, state) = initialized();
    open(&state, "ses_resume");
    append(&state, "ses_resume", 3);

    let written = call(
        &state,
        "session.snapshot",
        json!({
            "sessionId": "ses_resume",
            "snapshotVersion": 1,
            // Both names are accepted during the compatibility window.
            "sequence": 2,
            "journalSequence": 2,
            "streamSequence": 5,
            "reducerState": {
                "sessionId": "ses_resume",
                "lastSequence": 5,
                "timeline": [],
            },
        }),
    )
    .expect("snapshot");
    assert_eq!(written["sequence"], 2);
    assert_eq!(written["journalSequence"], 2);
    assert_eq!(written["streamSequence"], 5);
    assert_eq!(written["snapshotVersion"], 1);
    assert!(written["journalHash"].as_str().is_some());

    let resumed = call(
        &state,
        "session.open",
        json!({ "sessionId": "ses_resume", "resume": true }),
    )
    .expect("resume");
    assert_eq!(resumed["snapshot"]["journalSequence"], 2);
    assert_eq!(resumed["snapshot"]["streamSequence"], 5);
    assert_eq!(resumed["snapshot"]["sequence"], 2);
    assert_eq!(resumed["snapshot"]["snapshotVersion"], 1);
    assert_eq!(resumed["snapshot"]["legacy"], false);
    assert_eq!(resumed["replay"]["afterJournalSequence"], 2);
    assert_eq!(resumed["replay"]["throughJournalSequence"], 3);

    let tail = call(
        &state,
        "session.load",
        json!({ "sessionId": "ses_resume", "tailOnly": true }),
    )
    .expect("tail replay");
    assert_eq!(event_sequences(&tail), vec![3]);
    assert_eq!(tail["snapshot"]["journalSequence"], 2);
    assert_eq!(tail["snapshot"]["streamSequence"], 5);

    call(
        &state,
        "session.snapshot",
        json!({
            "sessionId": "ses_resume",
            "journalSequence": 3,
            "streamSequence": 5,
            "reducerState": { "sessionId": "ses_resume", "timeline": [] },
        }),
    )
    .expect("head snapshot");
    let empty_tail = call(
        &state,
        "session.load",
        json!({ "sessionId": "ses_resume", "tailOnly": true }),
    )
    .expect("empty tail still exposes history cursor");
    assert!(empty_tail["events"].as_array().unwrap().is_empty());
    assert_eq!(empty_tail["earlierPage"]["beforeSequence"], 3);
    assert_eq!(
        empty_tail["earlierPage"]["beforeHash"],
        empty_tail["snapshot"]["journalHash"]
    );

    let future_version = call(
        &state,
        "session.snapshot",
        json!({
            "sessionId": "ses_resume",
            "snapshotVersion": 99,
            "journalSequence": 3,
            "streamSequence": 5,
            "reducerState": { "sessionId": "ses_resume" },
        }),
    )
    .expect_err("future envelope");
    assert_eq!(future_version.code, error_codes::PROTOCOL_INCOMPATIBLE);

    let invalid_shape = call(
        &state,
        "session.snapshot",
        json!({
            "sessionId": "ses_resume",
            "journalSequence": 3,
            "streamSequence": 5,
            "reducerState": [],
        }),
    )
    .expect_err("invalid reducer state shape");
    assert_eq!(invalid_shape.code, error_codes::INVALID_ARGUMENT);
}

#[test]
fn corrupt_snapshot_is_not_returned_or_used_as_a_replay_boundary() {
    let (_dir, data, state) = initialized();
    open(&state, "ses_corrupt");
    append(&state, "ses_corrupt", 2);
    call(
        &state,
        "session.snapshot",
        json!({
            "sessionId": "ses_corrupt",
            "journalSequence": 1,
            "streamSequence": 1,
            "reducerState": { "sessionId": "ses_corrupt", "timeline": [] },
        }),
    )
    .unwrap();

    let conn = Connection::open(data.join("state.sqlite3")).unwrap();
    conn.execute(
        "UPDATE snapshots SET checksum = 'tampered' WHERE session_id = ?1",
        params!["ses_corrupt"],
    )
    .unwrap();
    drop(conn);

    let resumed = call(
        &state,
        "session.open",
        json!({ "sessionId": "ses_corrupt", "resume": true }),
    )
    .expect("resume falls back to full journal");
    assert!(resumed["snapshot"].is_null());
    assert_eq!(resumed["replay"]["afterJournalSequence"], 0);
    let tail = call(
        &state,
        "session.load",
        json!({ "sessionId": "ses_corrupt", "tailOnly": true }),
    )
    .unwrap();
    assert_eq!(event_sequences(&tail), vec![1, 2]);
}

#[test]
fn session_delete_is_logical_and_preserves_the_immutable_journal() {
    let (_dir, _data, state) = initialized();
    open(&state, "ses_archive");
    append(&state, "ses_archive", 2);

    let deleted = call(
        &state,
        "session.delete",
        json!({ "sessionId": "ses_archive" }),
    )
    .expect("logical delete");
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["archived"], true);
    assert_eq!(deleted["eventsRemoved"], 0);
    assert_eq!(deleted["eventsPreserved"], 2);

    let default_list = call(&state, "session.list", json!({})).unwrap();
    assert!(default_list["sessions"].as_array().unwrap().is_empty());
    let diagnostic_list = call(&state, "session.list", json!({ "includeArchived": true })).unwrap();
    assert_eq!(diagnostic_list["sessions"][0]["state"], "archived");

    let loaded = call(
        &state,
        "session.load",
        json!({ "sessionId": "ses_archive", "afterSequence": 0 }),
    )
    .expect("archived journal remains loadable");
    assert_eq!(event_sequences(&loaded), vec![1, 2]);
    assert_eq!(loaded["manifest"]["state"], "archived");
    assert_eq!(loaded["integrity"]["ok"], true);
}
