use cbc_session_store::{
    new_manifest, AppendEvent, EventPageDirection, EventPageRequest, SessionStatus, SessionStore,
    SnapshotEnvelope, StoreError, GENESIS_HASH, SNAPSHOT_ENVELOPE_VERSION,
};
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};

fn open_store() -> (tempfile::TempDir, SessionStore) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let store = SessionStore::open(dir.path()).expect("open store");
    store
        .create_session(&new_manifest(
            "ses_page",
            "/work",
            "workspace-fingerprint",
            "paging",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    (dir, store)
}

fn event(index: i64, payload_bytes: usize, stream_sequence: i64) -> AppendEvent {
    AppendEvent {
        id: format!("evt_{index}"),
        kind: "user.message".into(),
        timestamp: format!("2026-08-09T00:00:{index:02}Z"),
        turn_id: Some(format!("turn_{index}")),
        agent_id: None,
        level: "info".into(),
        visibility: "timeline".into(),
        schema_version: "1.0".into(),
        payload: json!({ "text": "x".repeat(payload_bytes), "index": index }),
        stream_sequence: Some(stream_sequence),
        caller_id: None,
        task_epoch_id: None,
        workspace_identity_digest: None,
        parent_event_id: None,
        correlation_id: None,
    }
}

fn sequences(page: &cbc_session_store::EventPage) -> Vec<i64> {
    page.events.iter().map(|event| event.sequence).collect()
}

#[test]
fn pages_forward_and_backward_chronologically_at_a_frozen_hash_boundary() {
    let (_dir, mut store) = open_store();
    let events = (1..=8)
        .map(|index| event(index, 32, index))
        .collect::<Vec<_>>();
    store
        .append_events("ses_page", &events)
        .expect("append seed");

    let first = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: Some(0),
                limit: 3,
                ..EventPageRequest::default()
            },
        )
        .expect("first page");
    assert_eq!(sequences(&first), vec![1, 2, 3]);
    assert_eq!(first.page.direction, EventPageDirection::Forward);
    assert_eq!(first.page.anchor_hash.as_deref(), Some(GENESIS_HASH));
    assert_eq!(first.page.first_prev_hash.as_deref(), Some(GENESIS_HASH));
    assert_eq!(first.page.through.sequence, 8);
    assert_eq!(first.page.journal_head.sequence, 8);
    assert!(first.page.has_more_after);
    let frozen = first.page.through.clone();

    // A concurrent append advances the live head but cannot enter a walk frozen
    // to the first page's throughSequence/throughHash.
    store
        .append_event("ses_page", &event(9, 32, 12))
        .expect("append after page");
    let second = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: Some(3),
                anchor_hash: first.page.last_event_hash.clone(),
                through_sequence: Some(frozen.sequence),
                through_hash: Some(frozen.event_hash.clone()),
                limit: 10,
                ..EventPageRequest::default()
            },
        )
        .expect("frozen second page");
    assert_eq!(sequences(&second), vec![4, 5, 6, 7, 8]);
    assert_eq!(second.page.journal_head.sequence, 9);
    assert_eq!(second.page.through, frozen);
    assert!(!second.page.has_more_after);

    let backward = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: None,
                before_sequence: Some(7),
                limit: 3,
                ..EventPageRequest::default()
            },
        )
        .expect("backward page");
    assert_eq!(sequences(&backward), vec![4, 5, 6]);
    assert_eq!(backward.page.direction, EventPageDirection::Backward);
    assert!(backward.page.has_more_before);
    assert!(backward.page.has_more_after);

    let err = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: Some(3),
                anchor_hash: Some("stale-hash".into()),
                ..EventPageRequest::default()
            },
        )
        .expect_err("stale cursor must fail closed");
    assert!(matches!(
        err,
        StoreError::BoundaryMismatch { sequence: 3, .. }
    ));
    assert_eq!(store.event_count("ses_page").unwrap(), 9);
}

#[test]
fn byte_budget_is_exact_and_an_oversized_first_event_still_makes_progress() {
    let (_dir, mut store) = open_store();
    store
        .append_events(
            "ses_page",
            &(1..=4)
                .map(|index| event(index, 300, index))
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let all = store.read_events("ses_page", 0, 10).unwrap();
    let exactly_two_bytes = serde_json::to_vec(&all[..2]).unwrap().len();

    let page = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: Some(0),
                limit: 4,
                max_bytes: exactly_two_bytes,
                ..EventPageRequest::default()
            },
        )
        .unwrap();
    assert_eq!(sequences(&page), vec![1, 2]);
    assert_eq!(page.page.encoded_bytes, exactly_two_bytes);
    assert!(page.page.truncated_by_bytes);
    assert!(!page.page.oversized_single_event);
    assert_eq!(
        serde_json::to_vec(&page.events).unwrap().len(),
        exactly_two_bytes
    );

    let tiny = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: Some(0),
                max_bytes: 1,
                ..EventPageRequest::default()
            },
        )
        .unwrap();
    assert_eq!(sequences(&tiny), vec![1]);
    assert!(tiny.page.oversized_single_event);
    assert!(tiny.page.encoded_bytes > tiny.page.max_bytes);
}

#[test]
fn versioned_snapshot_binds_distinct_sequences_state_and_journal_hash() {
    let (_dir, mut store) = open_store();
    store
        .append_events(
            "ses_page",
            &[event(1, 4, 1), event(2, 4, 4), event(3, 4, 7)],
        )
        .unwrap();
    let boundary = store.journal_boundary("ses_page", 3).unwrap();
    let envelope = SnapshotEnvelope {
        snapshot_version: SNAPSHOT_ENVELOPE_VERSION,
        session_id: "ses_page".into(),
        journal_sequence: 3,
        stream_sequence: Some(7),
        journal_hash: Some(boundary.event_hash.clone()),
        reducer_state: json!({ "sessionId": "ses_page", "lastSequence": 7, "timeline": [] }),
    };
    let checksum = store
        .write_snapshot_envelope(&envelope)
        .expect("write snapshot");
    let loaded = store
        .latest_snapshot_envelope("ses_page", None)
        .unwrap()
        .expect("snapshot");
    assert_eq!(loaded.envelope.journal_sequence, 3);
    assert_eq!(loaded.envelope.stream_sequence, Some(7));
    assert_eq!(
        loaded.envelope.journal_hash.as_deref(),
        Some(boundary.event_hash.as_str())
    );
    assert_eq!(loaded.checksum, checksum);
    assert!(!loaded.legacy);

    let invalid = SnapshotEnvelope {
        stream_sequence: Some(2),
        ..envelope.clone()
    };
    assert!(matches!(
        store.write_snapshot_envelope(&invalid),
        Err(StoreError::InvalidSnapshot { .. })
    ));

    // A boundary beyond the atomic journal head is rejected and no row lands.
    let future = SnapshotEnvelope {
        journal_sequence: 4,
        stream_sequence: Some(8),
        journal_hash: None,
        ..envelope
    };
    assert!(matches!(
        store.write_snapshot_envelope(&future),
        Err(StoreError::InvalidSnapshot { .. })
    ));
    assert!(store
        .latest_snapshot_envelope("ses_page", Some(2))
        .unwrap()
        .is_none());
}

#[test]
fn corrupt_newest_snapshot_falls_back_and_replay_reads_only_its_tail() {
    let (dir, mut store) = open_store();
    store
        .append_events(
            "ses_page",
            &[event(1, 4, 1), event(2, 4, 3), event(3, 4, 5)],
        )
        .unwrap();
    store
        .write_snapshot(
            "ses_page",
            1,
            &json!({ "sessionId": "ses_page", "lastSequence": 1 }),
            Some(1),
        )
        .unwrap();
    store
        .write_snapshot(
            "ses_page",
            3,
            &json!({ "sessionId": "ses_page", "lastSequence": 5 }),
            Some(5),
        )
        .unwrap();

    let conn = Connection::open(dir.path().join("state.sqlite3")).unwrap();
    conn.execute(
        "UPDATE snapshots SET checksum = 'corrupt' WHERE session_id = ?1 AND sequence = 3",
        params!["ses_page"],
    )
    .unwrap();
    drop(conn);

    let snapshot = store
        .latest_snapshot_envelope("ses_page", None)
        .unwrap()
        .expect("older valid snapshot");
    assert_eq!(snapshot.envelope.journal_sequence, 1);
    let tail = store
        .read_event_page(
            "ses_page",
            &EventPageRequest {
                after_sequence: Some(snapshot.envelope.journal_sequence),
                anchor_hash: snapshot.envelope.journal_hash.clone(),
                ..EventPageRequest::default()
            },
        )
        .unwrap();
    assert_eq!(sequences(&tail), vec![2, 3]);
}

#[test]
fn legacy_snapshot_checksum_is_validated_and_upgraded_in_memory() {
    let (dir, mut store) = open_store();
    store.append_event("ses_page", &event(1, 4, 1)).unwrap();
    let state_json = serde_json::to_string(&json!({
        "sessionId": "ses_page",
        "lastSequence": 1
    }))
    .unwrap();
    let checksum = format!("{:x}", Sha256::digest(state_json.as_bytes()));
    let conn = Connection::open(dir.path().join("state.sqlite3")).unwrap();
    conn.execute(
        "INSERT INTO snapshots (
            session_id, sequence, reducer_state, checksum, created_at, stream_sequence,
            envelope_version, journal_hash
         ) VALUES (?1, 1, ?2, ?3, ?4, 1, 0, NULL)",
        params!["ses_page", state_json, checksum, "2026-08-09T00:00:00Z"],
    )
    .unwrap();
    drop(conn);

    let loaded = store
        .latest_snapshot_envelope("ses_page", None)
        .unwrap()
        .expect("legacy snapshot");
    assert!(loaded.legacy);
    assert_eq!(loaded.envelope.snapshot_version, SNAPSHOT_ENVELOPE_VERSION);
    assert_eq!(loaded.envelope.journal_sequence, 1);
    assert!(loaded.envelope.journal_hash.is_some());
}

#[test]
fn logical_delete_archives_but_preserves_journal_and_snapshots() {
    let (_dir, mut store) = open_store();
    store
        .append_events("ses_page", &[event(1, 4, 1), event(2, 4, 2)])
        .unwrap();
    store
        .write_snapshot(
            "ses_page",
            2,
            &json!({ "sessionId": "ses_page", "lastSequence": 2 }),
            Some(2),
        )
        .unwrap();

    let removed = store.delete_session("ses_page").unwrap();
    assert_eq!(removed, 0);
    assert_eq!(
        store.load_manifest("ses_page").unwrap().state,
        SessionStatus::Archived
    );
    assert!(store.list_visible_sessions(10).unwrap().is_empty());
    assert_eq!(store.list_sessions(10).unwrap().len(), 1);
    assert_eq!(store.event_count("ses_page").unwrap(), 2);
    assert_eq!(store.read_events("ses_page", 0, 10).unwrap().len(), 2);
    assert!(store
        .latest_snapshot_envelope("ses_page", None)
        .unwrap()
        .is_some());
    assert!(store.verify_integrity("ses_page").unwrap().ok);
}
