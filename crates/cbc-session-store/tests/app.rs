use cbc_session_store::{
    new_manifest, AppClientKind, AppClientUpsert, AppEventFilter, AppSubscriptionAck,
    AppSubscriptionCreate, AppSubscriptionState, AppendEvent, SessionStore, StoreError,
};
use serde_json::json;

const T0: &str = "2026-08-25T00:00:00.000Z";
const T1: &str = "2026-08-25T00:00:01.000Z";
const T2: &str = "2026-08-25T00:00:02.000Z";
const T3: &str = "2026-08-25T00:00:03.000Z";

fn seeded_store() -> SessionStore {
    let store = SessionStore::open_in_memory().expect("open store");
    store
        .create_session(&new_manifest(
            "ses_app",
            "/work",
            "workspace-fingerprint",
            "app cursor test",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    store
}

fn event(index: i64) -> AppendEvent {
    AppendEvent {
        id: format!("evt_{index}"),
        kind: "user.message".into(),
        timestamp: format!("2026-08-25T00:00:0{index}.000Z"),
        turn_id: None,
        agent_id: None,
        level: "info".into(),
        visibility: "timeline".into(),
        schema_version: "1.0".into(),
        payload: json!({ "index": index }),
        stream_sequence: Some(index),
        caller_id: None,
        task_epoch_id: None,
        workspace_identity_digest: None,
        parent_event_id: None,
        correlation_id: None,
    }
}

fn client(id: &str, kind: AppClientKind, seen_at: &str) -> AppClientUpsert {
    AppClientUpsert {
        client_id: id.into(),
        name: "Capybara test client".into(),
        kind,
        version: "1.0.0".into(),
        seen_at: seen_at.into(),
    }
}

fn subscription(id: &str, client_id: &str, initial_acked_sequence: i64) -> AppSubscriptionCreate {
    AppSubscriptionCreate {
        id: id.into(),
        client_id: client_id.into(),
        session_id: "ses_app".into(),
        filter: AppEventFilter {
            kinds: vec!["user.message".into()],
            visibility: vec!["timeline".into()],
            include_ephemeral: false,
        },
        initial_acked_sequence,
        created_at: T1.into(),
    }
}

#[test]
fn app_client_kind_is_immutable_and_stale_refresh_cannot_rollback_metadata() {
    let mut store = seeded_store();
    let first = store
        .upsert_app_client(&client("client_tui", AppClientKind::Tui, T0))
        .expect("register client");
    assert_eq!(first.first_seen_at, T0);

    let mut refreshed = client("client_tui", AppClientKind::Tui, T2);
    refreshed.name = "Capybara TUI".into();
    refreshed.version = "1.1.0".into();
    let current = store
        .upsert_app_client(&refreshed)
        .expect("refresh identity");
    assert_eq!(current.last_seen_at, T2);
    assert_eq!(current.version, "1.1.0");

    let stale = store
        .upsert_app_client(&client("client_tui", AppClientKind::Tui, T1))
        .expect("stale refresh is a no-op");
    assert_eq!(stale, current);

    let rejected = store
        .upsert_app_client(&client("client_tui", AppClientKind::Sdk, T3))
        .expect_err("client ID cannot change role class");
    assert!(matches!(rejected, StoreError::InvalidAppServer { .. }));
}

#[test]
fn subscription_cursor_is_session_bound_monotonic_and_replay_safe() {
    let mut store = seeded_store();
    store
        .append_events("ses_app", &[event(1), event(2)])
        .expect("append journal");
    store
        .upsert_app_client(&client("client_tui", AppClientKind::Tui, T0))
        .expect("register client");

    let input = subscription("sub_timeline", "client_tui", 1);
    let created = store
        .create_app_subscription(&input)
        .expect("create subscription");
    assert_eq!(created.state, AppSubscriptionState::Active);
    assert_eq!(created.last_acked_sequence, 1);

    let advanced = store
        .acknowledge_app_subscription(&AppSubscriptionAck {
            subscription_id: "sub_timeline".into(),
            client_id: "client_tui".into(),
            sequence: 2,
            at: T2.into(),
        })
        .expect("advance ack");
    assert_eq!(advanced.last_acked_sequence, 2);
    assert_eq!(advanced.updated_at, T2);

    let delayed = store
        .acknowledge_app_subscription(&AppSubscriptionAck {
            subscription_id: "sub_timeline".into(),
            client_id: "client_tui".into(),
            sequence: 1,
            at: T1.into(),
        })
        .expect("delayed ack is idempotent");
    assert_eq!(delayed.last_acked_sequence, 2);
    assert_eq!(delayed.updated_at, T2);

    let replayed = store
        .create_app_subscription(&input)
        .expect("creation replay returns the advanced durable cursor");
    assert_eq!(replayed.last_acked_sequence, 2);

    let ahead = store
        .acknowledge_app_subscription(&AppSubscriptionAck {
            subscription_id: "sub_timeline".into(),
            client_id: "client_tui".into(),
            sequence: 3,
            at: T3.into(),
        })
        .expect_err("client cannot acknowledge undiscoverable journal data");
    assert!(matches!(
        ahead,
        StoreError::AppSubscriptionCursorAhead {
            requested: 3,
            head: 2,
            ..
        }
    ));

    let records = store
        .list_app_subscriptions("client_tui")
        .expect("list durable subscriptions");
    assert_eq!(records, vec![replayed]);
}

#[test]
fn subscription_owner_and_closed_lifecycle_are_fenced() {
    let mut store = seeded_store();
    store
        .append_event("ses_app", &event(1))
        .expect("append journal");
    store
        .upsert_app_client(&client("client_one", AppClientKind::Tui, T0))
        .expect("register owner");
    store
        .upsert_app_client(&client("client_two", AppClientKind::Sdk, T0))
        .expect("register non-owner");
    store
        .create_app_subscription(&subscription("sub_owned", "client_one", 0))
        .expect("create owner subscription");

    let foreign = store
        .acknowledge_app_subscription(&AppSubscriptionAck {
            subscription_id: "sub_owned".into(),
            client_id: "client_two".into(),
            sequence: 1,
            at: T1.into(),
        })
        .expect_err("a different client cannot alter another cursor");
    assert!(matches!(foreign, StoreError::NotFound { .. }));

    let closed = store
        .set_app_subscription_state("sub_owned", "client_one", AppSubscriptionState::Closed, T2)
        .expect("close subscription");
    assert_eq!(closed.state, AppSubscriptionState::Closed);

    assert!(matches!(
        store.acknowledge_app_subscription(&AppSubscriptionAck {
            subscription_id: "sub_owned".into(),
            client_id: "client_one".into(),
            sequence: 1,
            at: T3.into(),
        }),
        Err(StoreError::InvalidAppServer { .. })
    ));
    assert!(matches!(
        store.set_app_subscription_state(
            "sub_owned",
            "client_one",
            AppSubscriptionState::Active,
            T3,
        ),
        Err(StoreError::InvalidAppServer { .. })
    ));
}

#[test]
fn subscription_creation_rejects_a_cursor_beyond_session_head() {
    let mut store = seeded_store();
    store
        .upsert_app_client(&client("client_cursor", AppClientKind::Cli, T0))
        .expect("register client");
    let rejected = store
        .create_app_subscription(&subscription("sub_ahead", "client_cursor", 1))
        .expect_err("empty journal only has genesis cursor zero");
    assert!(matches!(
        rejected,
        StoreError::AppSubscriptionCursorAhead {
            requested: 1,
            head: 0,
            ..
        }
    ));
}

#[test]
fn plugin_host_client_kind_uses_public_kebab_case_wire_name() {
    assert_eq!(
        serde_json::to_value(AppClientKind::PluginHost).expect("serialize plugin host"),
        json!("plugin-host")
    );
    assert_eq!(
        serde_json::from_value::<AppClientKind>(json!("plugin-host")).unwrap(),
        AppClientKind::PluginHost
    );
}
