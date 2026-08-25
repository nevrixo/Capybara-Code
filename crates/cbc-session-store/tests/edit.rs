use cbc_session_store::{
    new_manifest, EditOperationRecord, EditPlanRecord, EditReceiptRecord, SessionStore,
};
use serde_json::json;

const T0: &str = "2026-08-25T00:00:00.000Z";
const T1: &str = "2026-08-25T00:00:01.000Z";

fn seeded_store() -> SessionStore {
    let store = SessionStore::open_in_memory().expect("open store");
    store
        .create_session(&new_manifest(
            "ses_edit",
            "/work",
            "workspace-fingerprint",
            "edit test",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    store
}

fn plan_record(session_id: &str, status: &str) -> EditPlanRecord {
    EditPlanRecord {
        id: "edp_roundtrip".into(),
        session_id: session_id.into(),
        turn_id: Some("trn_1".into()),
        agent_id: Some("agt_1".into()),
        source: "model".into(),
        workspace_identity_digest: "workspace-fingerprint".into(),
        worktree_id: Some("wt_isolated".into()),
        base_workspace_revision: Some("rev_base".into()),
        plan_digest: "sha256:plan".into(),
        conflict_policy: "fail".into(),
        status: status.into(),
        created_at: T0.into(),
        completed_at: None,
    }
}

fn operation_record() -> EditOperationRecord {
    EditOperationRecord {
        id: "edo_replace".into(),
        plan_id: "edp_roundtrip".into(),
        ordinal: 0,
        kind: "replace_range".into(),
        path: "src/a.ts".into(),
        base_revision: Some("rev_base".into()),
        operation_json: json!({
            "kind": "replace_range",
            "operationId": "edo_replace",
            "path": "src/a.ts",
            "baseRevision": "rev_base",
            "replacement": "new",
        }),
        resolved_range_json: Some(json!({ "start": 0, "end": 3 })),
        resolution_evidence_json: Some(json!({
            "method": "range",
            "score": 100,
            "candidateCount": 1,
            "baseRevision": "rev_base",
            "currentRevision": "rev_base",
        })),
        status: "previewed".into(),
        error_code: None,
    }
}

fn receipt_record() -> EditReceiptRecord {
    EditReceiptRecord {
        id: "edr_roundtrip".into(),
        plan_id: "edp_roundtrip".into(),
        transaction_id: Some("tx_1".into()),
        receipt_json: json!({
            "schemaVersion": "1.0",
            "id": "edr_roundtrip",
            "planId": "edp_roundtrip",
            "planDigest": "sha256:plan",
            "status": "staged",
            "createdAt": T1,
            "transactionId": "tx_1",
            "files": [{
                "kind": "modify",
                "path": "src/a.ts",
                "operationIds": ["edo_replace"],
                "additions": 1,
                "deletions": 1,
            }],
            "resolvedOperations": [{
                "operationId": "edo_replace",
                "path": "src/a.ts",
                "byteRange": { "start": 0, "end": 3 },
                "resolution": {
                    "method": "range",
                    "score": 100,
                    "candidateCount": 1,
                    "baseRevision": "rev_base",
                    "currentRevision": "rev_base",
                },
            }],
        }),
        created_at: T1.into(),
    }
}

#[test]
fn records_plan_operations_and_receipt_round_trip() {
    let mut store = seeded_store();
    let plan = plan_record("ses_edit", "previewed");
    let operation = operation_record();
    store
        .record_edit_plan(&plan, &[operation.clone()])
        .expect("record plan");

    let loaded = store
        .edit_plan("edp_roundtrip")
        .expect("load plan")
        .expect("plan exists");
    assert_eq!(loaded, plan);

    let operations = store
        .edit_operations("edp_roundtrip")
        .expect("load operations");
    assert_eq!(operations, vec![operation]);

    store
        .record_edit_receipt(&receipt_record())
        .expect("record receipt");
    store
        .complete_edit_plan("edp_roundtrip", "staged", T1)
        .expect("complete plan");

    let completed = store
        .edit_plan("edp_roundtrip")
        .expect("reload plan")
        .expect("plan still exists");
    assert_eq!(completed.status, "staged");
    assert_eq!(completed.completed_at.as_deref(), Some(T1));

    let receipts = store.edit_receipts("edp_roundtrip").expect("load receipts");
    assert_eq!(receipts, vec![receipt_record()]);
}

#[test]
fn missing_session_is_skipped_without_error() {
    // Persistence is best-effort relative to session identity: an edit RPC
    // whose plan.sessionId is empty or does not match a sessions row must
    // succeed as a no-op rather than return NotFound. SQL failures against a
    // real session still propagate.
    let mut store = seeded_store();
    let mut missing = plan_record("ses_missing", "previewed");
    missing.id = "edp_missing".into();
    store
        .record_edit_plan(&missing, &[operation_record()])
        .expect("missing session is skipped");
    assert!(store
        .edit_plan("edp_missing")
        .expect("lookup skipped plan")
        .is_none());

    let mut empty = plan_record("", "previewed");
    empty.id = "edp_empty".into();
    empty.session_id = String::new();
    store
        .record_edit_plan(&empty, &[])
        .expect("empty session id is skipped");
    assert!(store
        .edit_plan("edp_empty")
        .expect("lookup empty-session plan")
        .is_none());

    store
        .record_edit_receipt(&EditReceiptRecord {
            id: "edr_orphan".into(),
            plan_id: "edp_missing".into(),
            transaction_id: None,
            receipt_json: json!({
                "schemaVersion": "1.0",
                "id": "edr_orphan",
                "planId": "edp_missing",
                "planDigest": "sha256:plan",
                "status": "staged",
                "createdAt": T1,
            }),
            created_at: T1.into(),
        })
        .expect("receipt for a missing plan is skipped");
    assert!(store
        .edit_receipts("edp_missing")
        .expect("lookup skipped receipts")
        .is_empty());
}
