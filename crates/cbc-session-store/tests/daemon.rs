use cbc_session_store::{
    new_manifest, AttachmentMode, ClientAttachmentInput, DaemonInstanceInput, DaemonState,
    SessionOwnerClaim, SessionOwnerLease, SessionStore, StoreError,
};

const T0: &str = "2026-08-25T00:00:00.000Z";
const T10: &str = "2026-08-25T00:00:10.000Z";
const T20: &str = "2026-08-25T00:00:20.000Z";
const T30: &str = "2026-08-25T00:00:30.000Z";
const T40: &str = "2026-08-25T00:00:40.000Z";
const T50: &str = "2026-08-25T00:00:50.000Z";

fn seeded_store() -> SessionStore {
    let store = SessionStore::open_in_memory().expect("open store");
    store
        .create_session(&new_manifest(
            "ses_daemon",
            "/work",
            "workspace-fingerprint",
            "daemon test",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    store
}

fn daemon(id: &str, pid: i64) -> DaemonInstanceInput {
    DaemonInstanceInput {
        id: id.into(),
        pid,
        executable_digest: "a".repeat(64),
        protocol_version: "1.0".into(),
        started_at: T0.into(),
        heartbeat_at: T0.into(),
    }
}

fn owner_lease(daemon_id: &str, now: &str, lease_expires_at: &str) -> SessionOwnerLease {
    SessionOwnerLease {
        session_id: "ses_daemon".into(),
        daemon_id: daemon_id.into(),
        now: now.into(),
        lease_expires_at: lease_expires_at.into(),
    }
}

#[test]
fn session_owner_leases_fence_stale_daemons_and_increment_epoch_on_takeover() {
    let mut store = seeded_store();
    store.register_daemon(&daemon("daemon_a", 100)).expect("A");
    store.register_daemon(&daemon("daemon_b", 200)).expect("B");

    let first = store
        .claim_session_owner(&owner_lease("daemon_a", T0, T30))
        .expect("first claim");
    let first_owner = match first {
        SessionOwnerClaim::Acquired { owner } => owner,
        other => panic!("unexpected claim: {other:?}"),
    };
    assert_eq!(first_owner.owner_epoch, 1);

    let conflict = store
        .claim_session_owner(&owner_lease("daemon_b", T10, T30))
        .expect_err("live A lease blocks B");
    match conflict {
        StoreError::DaemonLeaseConflict {
            owner_daemon_id,
            lease_expires_at,
            ..
        } => {
            assert_eq!(owner_daemon_id, "daemon_a");
            assert_eq!(lease_expires_at, T30);
        }
        other => panic!("unexpected error: {other:?}"),
    }

    let renewed = store
        .renew_session_owner(&owner_lease("daemon_a", T10, T40), 1)
        .expect("renew exact epoch");
    assert_eq!(renewed.owner_epoch, 1);
    assert_eq!(renewed.lease_expires_at, T40);

    let takeover = store
        .claim_session_owner(&owner_lease("daemon_b", T40, T50))
        .expect("expired owner can be replaced");
    let replacement = match takeover {
        SessionOwnerClaim::TakenOver { owner } => owner,
        other => panic!("unexpected claim: {other:?}"),
    };
    assert_eq!(replacement.owner_epoch, 2);
    assert_eq!(replacement.daemon_id, "daemon_b");

    let stale_renewal = store
        .renew_session_owner(&owner_lease("daemon_a", T40, T50), 1)
        .expect_err("old epoch cannot revive itself");
    match stale_renewal {
        StoreError::OwnerEpochConflict {
            expected, actual, ..
        } => {
            assert_eq!(expected, 1);
            assert_eq!(actual, Some(2));
        }
        other => panic!("unexpected error: {other:?}"),
    }

    let expired = store.expired_session_owners(T50).expect("expired rows");
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].daemon_id, "daemon_b");
    assert_eq!(expired[0].owner_epoch, 2);
}

#[test]
fn client_detach_only_removes_observation_and_never_regresses_cursor() {
    let mut store = seeded_store();
    let attached = store
        .attach_client(&ClientAttachmentInput {
            connection_id: "conn_1".into(),
            client_id: "client_1".into(),
            session_id: Some("ses_daemon".into()),
            mode: AttachmentMode::Control,
            attached_at: T0.into(),
            last_event_sequence: 3,
        })
        .expect("attach");
    assert_eq!(attached.last_event_sequence, 3);

    let advanced = store
        .advance_attachment_cursor("conn_1", 8)
        .expect("advance cursor");
    assert_eq!(advanced.last_event_sequence, 8);

    let detached = store
        .detach_client("conn_1", T10, 4)
        .expect("detach without cancelling work");
    assert_eq!(detached.last_event_sequence, 8);
    assert_eq!(detached.detached_at.as_deref(), Some(T10));
    assert!(store
        .active_client_attachments("ses_daemon")
        .expect("active attachments")
        .is_empty());

    let reattached = store
        .attach_client(&ClientAttachmentInput {
            connection_id: "conn_1".into(),
            client_id: "client_1".into(),
            session_id: Some("ses_daemon".into()),
            mode: AttachmentMode::Observer,
            attached_at: T20.into(),
            last_event_sequence: 1,
        })
        .expect("reattach");
    assert_eq!(reattached.mode, AttachmentMode::Observer);
    assert_eq!(reattached.detached_at, None);
    assert_eq!(reattached.last_event_sequence, 8);
}

#[test]
fn terminal_daemon_id_cannot_be_recycled_or_claim_new_work() {
    let mut store = seeded_store();
    store
        .register_daemon(&daemon("daemon_terminal", 100))
        .expect("register");
    store
        .stop_daemon("daemon_terminal", DaemonState::Crashed, T10)
        .expect("mark crashed");

    let reused = store
        .register_daemon(&daemon("daemon_terminal", 100))
        .expect_err("terminal identity cannot be revived");
    assert!(matches!(reused, StoreError::InvalidDaemonRecord { .. }));

    let claim = store
        .claim_session_owner(&owner_lease("daemon_terminal", T10, T20))
        .expect_err("crashed daemon cannot own a session");
    assert!(matches!(claim, StoreError::InvalidDaemonRecord { .. }));
}

#[test]
fn daemon_registration_only_accepts_the_original_live_identity() {
    let mut store = seeded_store();
    let first = store
        .register_daemon(&daemon("daemon_identity", 100))
        .expect("register");
    assert_eq!(first.heartbeat_at, T0);

    let mut heartbeat = daemon("daemon_identity", 100);
    heartbeat.heartbeat_at = T10.into();
    let updated = store.register_daemon(&heartbeat).expect("heartbeat");
    assert_eq!(updated.heartbeat_at, T10);

    let conflicting = store
        .register_daemon(&daemon("daemon_identity", 101))
        .expect_err("PID changes cannot reuse active daemon identity");
    assert!(matches!(
        conflicting,
        StoreError::InvalidDaemonRecord { .. }
    ));
}
#[test]
fn release_preserves_epoch_history_for_the_next_owner() {
    let mut store = seeded_store();
    store.register_daemon(&daemon("daemon_a", 100)).expect("A");
    store.register_daemon(&daemon("daemon_b", 200)).expect("B");

    let first = store
        .claim_session_owner(&owner_lease("daemon_a", T0, T30))
        .expect("claim A");
    let first_epoch = match first {
        SessionOwnerClaim::Acquired { owner } => owner.owner_epoch,
        other => panic!("unexpected claim: {other:?}"),
    };

    let released = store
        .release_session_owner("ses_daemon", "daemon_a", first_epoch, T10)
        .expect("release exact owner");
    assert_eq!(released.owner_epoch, 1);
    assert_eq!(released.lease_expires_at, T10);

    let replacement = store
        .claim_session_owner(&owner_lease("daemon_b", T10, T20))
        .expect("B takes released lease");
    let replacement_epoch = match replacement {
        SessionOwnerClaim::TakenOver { owner } => owner.owner_epoch,
        other => panic!("unexpected claim: {other:?}"),
    };
    assert_eq!(replacement_epoch, 2);

    let stale_release = store
        .release_session_owner("ses_daemon", "daemon_a", first_epoch, T10)
        .expect_err("old epoch cannot delete new owner");
    assert!(matches!(
        stale_release,
        StoreError::OwnerEpochConflict {
            expected: 1,
            actual: Some(2),
            ..
        }
    ));
}
#[test]
fn daemon_rejects_noncanonical_and_backward_clock_values() {
    let mut store = seeded_store();

    let mut noncanonical = daemon("daemon_clock", 100);
    noncanonical.heartbeat_at = "2026-08-25T00:00:00Z".into();
    let malformed = store
        .register_daemon(&noncanonical)
        .expect_err("variable timestamp precision is unsafe for lexical leases");
    assert!(matches!(malformed, StoreError::InvalidDaemonRecord { .. }));

    store
        .register_daemon(&daemon("daemon_clock", 100))
        .expect("register canonical daemon");
    store
        .heartbeat_daemon("daemon_clock", T10)
        .expect("advance heartbeat");

    let backward = store
        .heartbeat_daemon("daemon_clock", T0)
        .expect_err("heartbeat must be monotonic");
    assert!(matches!(backward, StoreError::InvalidDaemonRecord { .. }));

    let stale_claim = store
        .claim_session_owner(&owner_lease("daemon_clock", T0, T20))
        .expect_err("lease clock cannot precede daemon heartbeat");
    assert!(matches!(
        stale_claim,
        StoreError::InvalidDaemonRecord { .. }
    ));
}
