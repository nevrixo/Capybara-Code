//! Transaction integration tests — PRD §25.10, AC-13, AC-14, AC-15, TOOL-001.

use std::fs;
use std::path::PathBuf;

use cbc_patch::{
    parse_unified_diff, undo_records, FileOperationKind, FileTransaction, TransactionError,
    TransactionState, UndoStatus,
};
use cbc_workspace::Workspace;
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    ws: Workspace,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        Self { _dir: dir, ws }
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.ws.root().join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.ws.root().join(relative)).unwrap()
    }

    fn exists(&self, relative: &str) -> bool {
        self.ws.root().join(relative).exists()
    }

    /// The base hash a `replace` must present for the file's current bytes.
    fn hash_of(&self, relative: &str) -> String {
        cbc_fs::hash_bytes(&fs::read(self.ws.root().join(relative)).unwrap())
    }

    fn resolver(&self) -> impl Fn(&str) -> Result<PathBuf, TransactionError> + '_ {
        move |relative: &str| {
            self.ws
                .resolve_write(relative)
                .map(|r| r.absolute)
                .map_err(|e| TransactionError::InvalidState {
                    state: "guard".into(),
                    action: format!("resolve {relative}: {e}"),
                })
        }
    }
}

#[test]
fn applies_single_file_patch() {
    let fx = Fixture::new();
    fx.write("src/main.rs", "fn main() {\n    old();\n}\n");

    let diff = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    old();\n+    new();\n }\n";
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_1", Some("turn_1".into()), Some("root".into()));
    tx.stage_patch(&patch, &fx.resolver()).expect("stage");
    let records = tx.commit().expect("commit");

    assert_eq!(tx.state(), TransactionState::Committed);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].additions, 1);
    assert_eq!(records[0].deletions, 1);
    assert_eq!(fx.read("src/main.rs"), "fn main() {\n    new();\n}\n");
}

#[test]
fn ac14_multi_hunk_failure_applies_nothing() {
    // AC-14: when one hunk fails, the whole operation fails with no partial
    // application.
    let fx = Fixture::new();
    fx.write("a.txt", "one\ntwo\nthree\nfour\nfive\n");

    // Second hunk's context does not match the file.
    let diff = concat!(
        "--- a/a.txt\n+++ b/a.txt\n",
        "@@ -1,1 +1,1 @@\n-one\n+ONE\n",
        "@@ -4,1 +4,1 @@\n-WRONG\n+FOUR\n"
    );
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_2", None, None);
    let err = tx.stage_patch(&patch, &fx.resolver()).unwrap_err();
    assert!(
        matches!(err, TransactionError::HunkMismatch { .. }),
        "expected HunkMismatch, got {err}"
    );
    assert_eq!(err.taxonomy(), "PATH_CHANGED");
    // Nothing staged, nothing written.
    assert_eq!(tx.staged_count(), 0);
    assert_eq!(fx.read("a.txt"), "one\ntwo\nthree\nfour\nfive\n");
}

#[test]
fn tool001_multi_file_patch_failure_leaves_no_file_changed() {
    // TOOL-001: multi-file patch 실패 시 어떤 파일도 반영되지 않는다.
    let fx = Fixture::new();
    fx.write("first.txt", "alpha\n");
    fx.write("second.txt", "beta\n");

    let diff = concat!(
        "--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-alpha\n+ALPHA\n",
        "--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-NOT-BETA\n+BETA\n"
    );
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_3", None, None);
    let err = tx.stage_patch(&patch, &fx.resolver()).unwrap_err();
    assert!(
        matches!(err, TransactionError::HunkMismatch { .. }),
        "{err}"
    );

    // Both files unchanged — validation happens for the whole set first.
    assert_eq!(fx.read("first.txt"), "alpha\n");
    assert_eq!(fx.read("second.txt"), "beta\n");
}

#[test]
fn tool001_rollback_when_second_write_fails_at_commit_time() {
    // Same invariant, exercised at commit time: staging succeeds for both
    // files, then the second write fails because a user changed it in between.
    let fx = Fixture::new();
    fx.write("first.txt", "alpha\n");
    fx.write("second.txt", "beta\n");

    let diff = concat!(
        "--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-alpha\n+ALPHA\n",
        "--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-beta\n+BETA\n"
    );
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_4", None, None);
    tx.stage_patch(&patch, &fx.resolver()).expect("stage");

    // A concurrent user edit invalidates the second file's expected hash.
    fx.write("second.txt", "user typed this\n");

    let err = tx.commit().unwrap_err();
    assert_eq!(err.taxonomy(), "HASH_MISMATCH", "{err}");
    assert_eq!(tx.state(), TransactionState::RolledBack);

    // first.txt was rolled back to its pre-image; user's second.txt preserved.
    assert_eq!(fx.read("first.txt"), "alpha\n");
    assert_eq!(fx.read("second.txt"), "user typed this\n");
}

#[test]
fn ac13_user_edit_conflict_does_not_overwrite() {
    // AC-13: agent read a file, user modified it, then the patch arrives.
    let fx = Fixture::new();
    fx.write("src/parser.ts", "export function parse() {}\n");
    let read_hash = cbc_fs::hash_bytes(b"export function parse() {}\n");

    fx.write(
        "src/parser.ts",
        "export function parse() { /* user edit */ }\n",
    );

    let mut tx = FileTransaction::begin("tx_5", None, None);
    let err = tx
        .stage_write(
            "src/parser.ts",
            &fx.ws.root().join("src/parser.ts"),
            "export function parse() { /* agent */ }\n",
            cbc_fs::WriteIntent::Replace,
            Some(&read_hash),
        )
        .unwrap_err();

    match &err {
        TransactionError::Conflict {
            path,
            expected,
            actual,
        } => {
            assert_eq!(path, "src/parser.ts");
            assert_eq!(expected, &read_hash);
            assert_ne!(actual, &read_hash);
        }
        other => panic!("expected Conflict, got {other}"),
    }
    // The displayed message matches the Appendix A.3 shape.
    let message = err.to_string();
    assert!(message.contains("Patch conflict"), "{message}");
    assert!(message.contains("src/parser.ts"), "{message}");
    assert_eq!(tx.state(), TransactionState::Conflicted);
    assert_eq!(
        fx.read("src/parser.ts"),
        "export function parse() { /* user edit */ }\n"
    );
}

#[test]
fn empty_expected_hash_is_ignored_when_creating_a_file() {
    // Strict provider schemas include optional string fields in every call. The
    // empty placeholder must not turn a valid create into HASH_MISMATCH.
    let fx = Fixture::new();
    let path = fx.ws.root().join("index.html");

    let mut tx = FileTransaction::begin("tx_empty_hash", None, None);
    tx.stage_write(
        "index.html",
        &path,
        "<!doctype html>\n",
        cbc_fs::WriteIntent::Create,
        Some(""),
    )
    .expect("empty expected hash should mean no expectation for a create");

    let records = tx.commit().expect("commit create");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].pre_hash, None);
    assert_eq!(fx.read("index.html"), "<!doctype html>\n");
}

#[test]
fn replace_without_a_base_hash_is_refused() {
    // P0-07: replacing an existing file must present the file's current hash.
    // A blind replace is exactly the stale-read optimistic concurrency guards
    // against, so it is refused rather than silently applied.
    let fx = Fixture::new();
    fx.write("existing.txt", "user content\n");

    let mut tx = FileTransaction::begin("tx_replace_no_hash", None, None);
    let err = tx
        .stage_write(
            "existing.txt",
            &fx.ws.root().join("existing.txt"),
            "agent content\n",
            cbc_fs::WriteIntent::Replace,
            None,
        )
        .unwrap_err();

    assert!(matches!(err, TransactionError::Conflict { .. }), "{err}");
    assert_eq!(tx.state(), TransactionState::Conflicted);
    assert_eq!(fx.read("existing.txt"), "user content\n");
}

#[test]
fn empty_expected_hash_is_not_ignored_for_replace() {
    let fx = Fixture::new();
    fx.write("existing.txt", "user content\n");

    let mut tx = FileTransaction::begin("tx_empty_replace_hash", None, None);
    let err = tx
        .stage_write(
            "existing.txt",
            &fx.ws.root().join("existing.txt"),
            "agent content\n",
            cbc_fs::WriteIntent::Replace,
            Some(""),
        )
        .unwrap_err();

    assert!(matches!(err, TransactionError::Conflict { .. }));
    assert_eq!(tx.state(), TransactionState::Conflicted);
    assert_eq!(fx.read("existing.txt"), "user content\n");
}

#[test]
fn ac15_turn_undo_reverts_agent_changes_only() {
    // AC-15: agent created one file and modified another; /undo must revert
    // exactly the agent changes whose post-image is unchanged.
    let fx = Fixture::new();
    fx.write("existing.txt", "original content\n");

    let mut tx = FileTransaction::begin("tx_6", Some("turn_1".into()), Some("root".into()));
    tx.stage_write(
        "existing.txt",
        &fx.ws.root().join("existing.txt"),
        "agent modified content\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("existing.txt")),
    )
    .expect("stage modify");
    tx.stage_write(
        "created.txt",
        &fx.ws.root().join("created.txt"),
        "agent created this\n",
        cbc_fs::WriteIntent::Create,
        None,
    )
    .expect("stage create");
    let records = tx.commit().expect("commit");
    assert_eq!(records.len(), 2);
    assert_eq!(fx.read("existing.txt"), "agent modified content\n");
    assert!(fx.exists("created.txt"));

    let outcomes = undo_records(&records, &fx.resolver());
    assert_eq!(outcomes.len(), 2);
    assert!(
        outcomes.iter().all(|o| o.status == UndoStatus::Reverted),
        "{outcomes:?}"
    );
    assert_eq!(fx.read("existing.txt"), "original content\n");
    assert!(!fx.exists("created.txt"), "created file should be removed");
}

#[test]
fn ac15_undo_skips_paths_the_user_touched_afterwards() {
    // §24.1 invariant 9: undo must not delete user changes made after the agent.
    let fx = Fixture::new();
    fx.write("shared.txt", "original\n");

    let mut tx = FileTransaction::begin("tx_7", None, None);
    tx.stage_write(
        "shared.txt",
        &fx.ws.root().join("shared.txt"),
        "agent version\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("shared.txt")),
    )
    .unwrap();
    let records = tx.commit().expect("commit");

    // The user edits the file after the agent's turn.
    fx.write("shared.txt", "user edited after agent\n");

    let outcomes = undo_records(&records, &fx.resolver());
    assert_eq!(outcomes[0].status, UndoStatus::SkippedUserModified);
    assert_eq!(fx.read("shared.txt"), "user edited after agent\n");
}

#[test]
fn ac15_undo_restores_deleted_file() {
    let fx = Fixture::new();
    fx.write("doomed.txt", "please keep me\n");

    let mut tx = FileTransaction::begin("tx_8", None, None);
    tx.stage_delete(
        "doomed.txt",
        &fx.ws.root().join("doomed.txt"),
        Some(&fx.hash_of("doomed.txt")),
        false,
    )
    .expect("stage delete");
    let records = tx.commit().expect("commit");
    assert!(!fx.exists("doomed.txt"));

    let outcomes = undo_records(&records, &fx.resolver());
    assert_eq!(outcomes[0].status, UndoStatus::Reverted);
    assert_eq!(fx.read("doomed.txt"), "please keep me\n");
}

#[test]
fn undo_of_delete_is_skipped_when_path_was_recreated() {
    let fx = Fixture::new();
    fx.write("gone.txt", "v1\n");
    let mut tx = FileTransaction::begin("tx_9", None, None);
    tx.stage_delete(
        "gone.txt",
        &fx.ws.root().join("gone.txt"),
        Some(&fx.hash_of("gone.txt")),
        false,
    )
    .unwrap();
    let records = tx.commit().unwrap();

    fx.write("gone.txt", "user recreated\n");
    let outcomes = undo_records(&records, &fx.resolver());
    assert_eq!(outcomes[0].status, UndoStatus::SkippedUserModified);
    assert_eq!(fx.read("gone.txt"), "user recreated\n");
}

#[test]
fn creates_file_from_dev_null_patch() {
    let fx = Fixture::new();
    let diff =
        "--- /dev/null\n+++ b/scripts/demo.py\n@@ -0,0 +1,2 @@\n+import sys\n+print('capybara')\n";
    let patch = parse_unified_diff(diff).expect("parse");
    assert_eq!(patch.files[0].kind, FileOperationKind::Create);

    let mut tx = FileTransaction::begin("tx_10", None, None);
    tx.stage_patch(&patch, &fx.resolver()).expect("stage");
    let records = tx.commit().expect("commit");
    assert_eq!(records[0].kind, FileOperationKind::Create);
    assert_eq!(
        fx.read("scripts/demo.py"),
        "import sys\nprint('capybara')\n"
    );
}

#[test]
fn deletes_file_via_dev_null_patch() {
    let fx = Fixture::new();
    fx.write("old.txt", "a\nb\n");
    let diff = "--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_11", None, None);
    tx.stage_patch(&patch, &fx.resolver()).expect("stage");
    tx.commit().expect("commit");
    assert!(!fx.exists("old.txt"));
}

#[test]
fn preserves_crlf_line_endings() {
    // §12.5: newline style preserved.
    let fx = Fixture::new();
    fx.write("win.txt", "one\r\ntwo\r\n");
    let diff = "--- a/win.txt\n+++ b/win.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_12", None, None);
    tx.stage_patch(&patch, &fx.resolver()).expect("stage");
    tx.commit().expect("commit");
    assert_eq!(fx.read("win.txt"), "one\r\nTWO\r\n");
}

#[test]
fn rollback_before_commit_writes_nothing() {
    let fx = Fixture::new();
    fx.write("x.txt", "keep\n");
    let mut tx = FileTransaction::begin("tx_13", None, None);
    tx.stage_write(
        "x.txt",
        &fx.ws.root().join("x.txt"),
        "changed\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("x.txt")),
    )
    .unwrap();
    tx.rollback().expect("rollback");
    assert_eq!(tx.state(), TransactionState::RolledBack);
    assert_eq!(fx.read("x.txt"), "keep\n");
    // Committing a rolled-back transaction is rejected.
    assert!(tx.commit().is_err());
}

#[test]
fn cannot_stage_after_commit() {
    let fx = Fixture::new();
    let mut tx = FileTransaction::begin("tx_14", None, None);
    tx.stage_write(
        "a.txt",
        &fx.ws.root().join("a.txt"),
        "one\n",
        cbc_fs::WriteIntent::Create,
        None,
    )
    .unwrap();
    tx.commit().unwrap();
    let err = tx
        .stage_write(
            "b.txt",
            &fx.ws.root().join("b.txt"),
            "two\n",
            cbc_fs::WriteIntent::Create,
            None,
        )
        .unwrap_err();
    assert!(matches!(err, TransactionError::InvalidState { .. }));
}

#[test]
fn rename_with_content_change_is_rejected_as_non_restorable() {
    let fx = Fixture::new();
    fx.write("old/name.txt", "content\n");
    let diff = "--- a/old/name.txt\n+++ b/new/name.txt\n@@ -1 +1 @@\n-content\n+updated\n";
    let patch = parse_unified_diff(diff).expect("parse");

    let mut tx = FileTransaction::begin("tx_15", None, None);
    let error = tx.stage_patch(&patch, &fx.resolver()).unwrap_err();
    assert!(matches!(error, TransactionError::NonRestorable { .. }));
    assert_eq!(fx.read("old/name.txt"), "content\n");
    assert!(!fx.exists("new/name.txt"));
}

#[test]
fn stage_move_records_and_applies() {
    let fx = Fixture::new();
    fx.write("from.txt", "payload\n");
    let mut tx = FileTransaction::begin("tx_16", None, None);
    tx.stage_move(
        "from.txt",
        &fx.ws.root().join("from.txt"),
        "to/dest.txt",
        &fx.ws.root().join("to/dest.txt"),
        Some(&fx.hash_of("from.txt")),
    )
    .expect("stage move");
    tx.commit().expect("commit");
    assert!(!fx.exists("from.txt"));
    assert_eq!(fx.read("to/dest.txt"), "payload\n");
}

// P0-07: delete and move require a base hash, the same optimistic-concurrency
// guarantee replace already has.

#[test]
fn delete_without_base_hash_is_refused() {
    let fx = Fixture::new();
    fx.write("target.txt", "content\n");
    let mut tx = FileTransaction::begin("tx_d1", None, None);
    let err = tx
        .stage_delete("target.txt", &fx.ws.root().join("target.txt"), None, false)
        .unwrap_err();
    assert!(matches!(err, TransactionError::Conflict { .. }), "{err}");
    assert_eq!(err.taxonomy(), "HASH_MISMATCH");
    assert!(fx.exists("target.txt"), "file must remain after refusal");
}

#[test]
fn delete_with_stale_hash_is_refused() {
    let fx = Fixture::new();
    fx.write("target.txt", "content\n");
    let mut tx = FileTransaction::begin("tx_d2", None, None);
    let err = tx
        .stage_delete(
            "target.txt",
            &fx.ws.root().join("target.txt"),
            Some("deadbeef"),
            false,
        )
        .unwrap_err();
    assert!(matches!(err, TransactionError::Conflict { .. }), "{err}");
    assert!(fx.exists("target.txt"));
}

#[test]
fn move_without_base_hash_is_refused() {
    let fx = Fixture::new();
    fx.write("from.txt", "payload\n");
    let mut tx = FileTransaction::begin("tx_m1", None, None);
    let err = tx
        .stage_move(
            "from.txt",
            &fx.ws.root().join("from.txt"),
            "to/dest.txt",
            &fx.ws.root().join("to/dest.txt"),
            None,
        )
        .unwrap_err();
    assert!(matches!(err, TransactionError::Conflict { .. }), "{err}");
    assert_eq!(err.taxonomy(), "HASH_MISMATCH");
    assert!(fx.exists("from.txt"), "source must remain after refusal");
}

#[test]
fn recursive_directory_delete_is_rejected_as_non_restorable() {
    let fx = Fixture::new();
    fx.write("bundle/inner.txt", "x\n");
    let mut tx = FileTransaction::begin("tx_d3", None, None);
    let error = tx
        .stage_delete("bundle", &fx.ws.root().join("bundle"), None, true)
        .unwrap_err();
    assert!(matches!(error, TransactionError::NonRestorable { .. }));
    assert!(fx.exists("bundle/inner.txt"));
}

#[test]
fn binary_delete_is_rejected_before_any_filesystem_change() {
    let fx = Fixture::new();
    let path = fx.ws.root().join("blob.bin");
    fs::write(&path, [0_u8, 1, 2, 0, 3]).unwrap();
    let mut tx = FileTransaction::begin("tx_binary_delete", None, None);
    let error = tx.stage_delete("blob.bin", &path, None, false).unwrap_err();
    assert!(matches!(error, TransactionError::NonRestorable { .. }));
    assert_eq!(fs::read(path).unwrap(), vec![0_u8, 1, 2, 0, 3]);
}

#[test]
fn rejects_overlapping_hunks() {
    let fx = Fixture::new();
    fx.write("o.txt", "a\nb\nc\nd\n");
    let diff = concat!(
        "--- a/o.txt\n+++ b/o.txt\n",
        "@@ -1,2 +1,2 @@\n a\n-b\n+B\n",
        "@@ -1,2 +1,2 @@\n a\n-B\n+BB\n"
    );
    let patch = parse_unified_diff(diff).expect("parse");
    let mut tx = FileTransaction::begin("tx_17", None, None);
    let err = tx.stage_patch(&patch, &fx.resolver()).unwrap_err();
    assert!(
        matches!(err, TransactionError::HunkMismatch { .. }),
        "{err}"
    );
}

#[test]
fn multi_hunk_patch_applies_in_order() {
    let fx = Fixture::new();
    fx.write("m.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    let diff = concat!(
        "--- a/m.txt\n+++ b/m.txt\n",
        "@@ -1,2 +1,2 @@\n 1\n-2\n+TWO\n",
        "@@ -6,2 +6,3 @@\n 6\n-7\n+SEVEN\n+SEVEN-B\n"
    );
    let patch = parse_unified_diff(diff).expect("parse");
    let mut tx = FileTransaction::begin("tx_18", None, None);
    tx.stage_patch(&patch, &fx.resolver()).expect("stage");
    tx.commit().expect("commit");
    assert_eq!(fx.read("m.txt"), "1\nTWO\n3\n4\n5\n6\nSEVEN\nSEVEN-B\n8\n");
}

#[test]
fn creating_existing_file_via_patch_is_rejected() {
    let fx = Fixture::new();
    fx.write("exists.txt", "already here\n");
    let diff = "--- /dev/null\n+++ b/exists.txt\n@@ -0,0 +1 @@\n+new\n";
    let patch = parse_unified_diff(diff).expect("parse");
    let mut tx = FileTransaction::begin("tx_19", None, None);
    let err = tx.stage_patch(&patch, &fx.resolver()).unwrap_err();
    assert_eq!(err.taxonomy(), "ALREADY_EXISTS");
    assert_eq!(fx.read("exists.txt"), "already here\n");
}

#[test]
fn patching_missing_file_is_rejected() {
    let fx = Fixture::new();
    let diff = "--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-a\n+b\n";
    let patch = parse_unified_diff(diff).expect("parse");
    let mut tx = FileTransaction::begin("tx_20", None, None);
    let err = tx.stage_patch(&patch, &fx.resolver()).unwrap_err();
    assert_eq!(err.taxonomy(), "NOT_FOUND");
}

#[test]
fn property_apply_then_undo_restores_exact_pre_image() {
    // §25.4: "apply + undo returns exact pre-image when no conflict".
    let fx = Fixture::new();
    for i in 0..60usize {
        let relative = format!("gen/f{i}.txt");
        let original = format!("line-a-{i}\nline-b-{i}\n한국어 {i}\n");
        fx.write(&relative, &original);

        let mut tx = FileTransaction::begin(format!("tx_p{i}"), None, None);
        tx.stage_write(
            &relative,
            &fx.ws.root().join(&relative),
            &format!("changed-{i}\n"),
            cbc_fs::WriteIntent::Replace,
            Some(&fx.hash_of(&relative)),
        )
        .unwrap();
        let records = tx.commit().unwrap();
        assert_ne!(fx.read(&relative), original);

        let outcomes = undo_records(&records, &fx.resolver());
        assert_eq!(outcomes[0].status, UndoStatus::Reverted);
        assert_eq!(fx.read(&relative), original, "mismatch for {relative}");
    }
}

// ---------------------------------------------------------------------------
// Checkpoints — PRD §11.2, §12.5, §14.3
// ---------------------------------------------------------------------------

#[test]
fn checkpoint_rollback_restores_only_work_done_after_it() {
    // §11.2: reflection can conclude an *approach* was wrong while the work that
    // preceded it was sound. Undoing the whole transaction would throw away both.
    let fx = Fixture::new();
    fx.write("kept.txt", "original kept\n");
    fx.write("undone.txt", "original undone\n");

    let mut tx = FileTransaction::begin("tx_ckpt_1", Some("turn_1".into()), Some("root".into()));
    tx.stage_write(
        "kept.txt",
        &fx.ws.root().join("kept.txt"),
        "sound work\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("kept.txt")),
    )
    .unwrap();
    tx.commit().expect("first commit");
    assert_eq!(fx.read("kept.txt"), "sound work\n");

    // Everything after this point belongs to the approach that gets abandoned.
    let checkpoint = tx.checkpoint("ckpt_a", Some("before the risky approach".into()));
    assert_eq!(checkpoint.applied_len, 1);
    assert_eq!(tx.checkpoints().len(), 1);

    // A committed transaction cannot stage more work, so the approach continues in
    // a second transaction sharing the same checkpoint id.
    let mut tx2 =
        FileTransaction::begin("tx_ckpt_2", None, None).with_checkpoint(Some("ckpt_a".into()));
    assert_eq!(tx2.checkpoint_id.as_deref(), Some("ckpt_a"));
    tx2.stage_write(
        "undone.txt",
        &fx.ws.root().join("undone.txt"),
        "abandoned work\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("undone.txt")),
    )
    .unwrap();
    tx2.commit().expect("second commit");
    assert_eq!(fx.read("undone.txt"), "abandoned work\n");

    // Abandoning the approach undoes the second transaction in full.
    let outcomes = tx2.undo_all(&fx.resolver());
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, UndoStatus::Reverted);
    assert_eq!(tx2.state(), TransactionState::RolledBack);
    assert_eq!(fx.read("undone.txt"), "original undone\n");
    // The work before the checkpoint is untouched.
    assert_eq!(fx.read("kept.txt"), "sound work\n");
}

#[test]
fn checkpoint_rollback_within_one_transaction_reverts_the_tail() {
    let fx = Fixture::new();
    fx.write("first.txt", "one\n");
    fx.write("second.txt", "two\n");

    let mut tx = FileTransaction::begin("tx_ckpt_3", None, None);
    tx.stage_write(
        "first.txt",
        &fx.ws.root().join("first.txt"),
        "ONE\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("first.txt")),
    )
    .unwrap();
    tx.commit().expect("commit first");
    tx.checkpoint("ckpt_b", None);

    // A fresh transaction id would normally carry the next batch; here the same
    // object is reopened by rolling back, which is what makes the checkpoint the
    // meaningful boundary rather than the transaction.
    assert_eq!(tx.records().len(), 1);
    let rollback = tx
        .rollback_to_checkpoint("ckpt_b", &fx.resolver())
        .expect("rollback to checkpoint");
    assert_eq!(rollback.checkpoint_id, "ckpt_b");
    // Nothing was applied after the checkpoint, so nothing was reverted.
    assert_eq!(rollback.discarded_operations, 0);
    assert_eq!(fx.read("first.txt"), "ONE\n");
    assert_eq!(fx.read("second.txt"), "two\n");
}

#[test]
fn checkpoint_rollback_reverts_operations_applied_after_the_marker() {
    let fx = Fixture::new();
    fx.write("a.txt", "a0\n");
    fx.write("b.txt", "b0\n");

    let mut tx = FileTransaction::begin("tx_ckpt_4", None, None);
    // The checkpoint is taken before anything is applied, so rolling back to it
    // must undo the whole commit.
    tx.checkpoint("ckpt_start", None);
    tx.stage_write(
        "a.txt",
        &fx.ws.root().join("a.txt"),
        "a1\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("a.txt")),
    )
    .unwrap();
    tx.stage_write(
        "b.txt",
        &fx.ws.root().join("b.txt"),
        "b1\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("b.txt")),
    )
    .unwrap();
    tx.commit().expect("commit");
    assert_eq!(fx.read("a.txt"), "a1\n");
    assert_eq!(fx.read("b.txt"), "b1\n");

    let rollback = tx
        .rollback_to_checkpoint("ckpt_start", &fx.resolver())
        .expect("rollback");
    assert_eq!(rollback.discarded_operations, 2);
    assert!(
        rollback
            .reverted
            .iter()
            .all(|o| o.status == UndoStatus::Reverted),
        "{:?}",
        rollback.reverted
    );
    assert_eq!(fx.read("a.txt"), "a0\n");
    assert_eq!(fx.read("b.txt"), "b0\n");
    // Every applied operation is gone, so reporting the transaction as committed
    // would claim changes that are not on disk.
    assert_eq!(tx.state(), TransactionState::RolledBack);
    // The history still records what happened and was then undone.
    assert_eq!(tx.history().len(), 2);
    assert!(tx.records().is_empty());
}

#[test]
fn checkpoint_rollback_never_destroys_a_user_edit() {
    // §24.1 invariant 9 applies to a self-correction rollback exactly as it does
    // to `/undo`: correcting the agent's work is not a licence to discard the
    // user's.
    let fx = Fixture::new();
    fx.write("shared.txt", "original\n");

    let mut tx = FileTransaction::begin("tx_ckpt_5", None, None);
    tx.checkpoint("ckpt_c", None);
    tx.stage_write(
        "shared.txt",
        &fx.ws.root().join("shared.txt"),
        "agent version\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("shared.txt")),
    )
    .unwrap();
    tx.commit().expect("commit");

    fx.write("shared.txt", "user edited after the agent\n");

    let rollback = tx
        .rollback_to_checkpoint("ckpt_c", &fx.resolver())
        .expect("rollback");
    assert_eq!(rollback.reverted[0].status, UndoStatus::SkippedUserModified);
    assert_eq!(fx.read("shared.txt"), "user edited after the agent\n");
}

#[test]
fn undo_all_reports_conflicted_when_a_path_could_not_be_restored() {
    let fx = Fixture::new();
    fx.write("keep.txt", "v0\n");
    let mut tx = FileTransaction::begin("tx_ckpt_6", None, None);
    tx.stage_write(
        "keep.txt",
        &fx.ws.root().join("keep.txt"),
        "v1\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("keep.txt")),
    )
    .unwrap();
    tx.commit().unwrap();

    fx.write("keep.txt", "user typed this\n");
    let outcomes = tx.undo_all(&fx.resolver());
    assert_eq!(outcomes[0].status, UndoStatus::SkippedUserModified);
    // The undo genuinely did not complete, so claiming `rolled_back` would hide it.
    assert_eq!(tx.state(), TransactionState::Conflicted);
}

#[test]
fn checkpoint_rollback_discards_staged_work_added_after_the_marker() {
    let fx = Fixture::new();
    fx.write("x.txt", "x0\n");

    let mut tx = FileTransaction::begin("tx_ckpt_7", None, None);
    tx.checkpoint("ckpt_d", None);
    tx.stage_write(
        "x.txt",
        &fx.ws.root().join("x.txt"),
        "x1\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("x.txt")),
    )
    .unwrap();
    assert_eq!(tx.staged_count(), 1);

    let rollback = tx
        .rollback_to_checkpoint("ckpt_d", &fx.resolver())
        .expect("rollback");
    assert_eq!(rollback.discarded_staged, 1);
    assert_eq!(tx.staged_count(), 0);
    // Nothing was ever written, so the file is untouched.
    assert_eq!(fx.read("x.txt"), "x0\n");
}

#[test]
fn an_unknown_checkpoint_is_rejected_rather_than_reverting_something_else() {
    let fx = Fixture::new();
    let mut tx = FileTransaction::begin("tx_ckpt_8", None, None);
    let err = tx
        .rollback_to_checkpoint("nope", &fx.resolver())
        .unwrap_err();
    assert_eq!(err.taxonomy(), "NOT_FOUND");
    assert!(err.to_string().contains("nope"), "{err}");
}

#[test]
fn a_checkpoint_can_be_returned_to_more_than_once() {
    let fx = Fixture::new();
    fx.write("r.txt", "r0\n");

    let mut tx = FileTransaction::begin("tx_ckpt_9", None, None);
    tx.checkpoint("ckpt_e", None);
    tx.stage_write(
        "r.txt",
        &fx.ws.root().join("r.txt"),
        "r1\n",
        cbc_fs::WriteIntent::Replace,
        Some(&fx.hash_of("r.txt")),
    )
    .unwrap();
    tx.commit().unwrap();

    tx.rollback_to_checkpoint("ckpt_e", &fx.resolver())
        .expect("first rollback");
    assert_eq!(fx.read("r.txt"), "r0\n");
    // The checkpoint itself survives, so a second attempt at the same approach can
    // return to the same point.
    assert!(tx.find_checkpoint("ckpt_e").is_some());
    let again = tx
        .rollback_to_checkpoint("ckpt_e", &fx.resolver())
        .expect("second rollback");
    assert_eq!(again.discarded_operations, 0);
}

#[test]
fn stage_write_and_patch_accept_short_hash_expectations() {
    let fx = Fixture::new();
    fx.write("package.json", "{\n  \"name\": \"test\"\n}\n");

    let full_hash = fx.hash_of("package.json");
    let short_hash = cbc_fs::short_hash(&full_hash);
    assert_eq!(short_hash.len(), 7);

    let mut tx = FileTransaction::begin("tx_short_hash", None, None);

    // stage_write with short hash expected_hash should succeed
    tx.stage_write(
        "package.json",
        &fx.ws.root().join("package.json"),
        "{\n  \"name\": \"test-updated\"\n}\n",
        cbc_fs::WriteIntent::Replace,
        Some(&short_hash),
    )
    .expect("stage_write with short hash expected_hash should succeed");

    tx.commit().expect("commit");
    assert_eq!(
        fx.read("package.json"),
        "{\n  \"name\": \"test-updated\"\n}\n"
    );
}
