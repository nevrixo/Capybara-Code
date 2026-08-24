//! File mutation transactions — PRD §12.5, §14.3, §18.15, AC-14, AC-15,
//! TOOL-001, RT-003.
//!
//! Every mutation runs inside a transaction:
//!
//! ```text
//! begin  → stage operations (validate all)  → commit (apply atomically)
//!                                          ↘ rollback (restore pre-images)
//! ```
//!
//! §12.5: "all hunks validate before commit" and "partial multi-file patch
//! 금지: transaction 또는 full rollback". Validation therefore happens for the
//! whole patch set first; only then is anything written.
//!
//! AC-15 (turn undo): the transaction records a pre-image and post-image hash
//! for every path. Undo restores a path *only* when its current content still
//! matches the post-image, so a user edit made after the agent's change is never
//! destroyed (invariant 9 in §24.1).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use cbc_fs::{
    atomic_write, atomic_write_beneath, delete_path_beneath, hash_file, hash_file_beneath,
    is_probably_binary_beneath, move_path_beneath, path_exists_beneath, read_text_beneath, FsError,
    NewlineStyle, WriteIntent,
};
use serde::{Deserialize, Serialize};

use crate::diff::{FileOperationKind, FilePatch, Hunk, HunkLine, Patch};

use crate::edit::{PreparedFileChange, PreparedFileKind};
#[derive(Debug)]
pub enum TransactionError {
    /// A staged file's current hash differs from the expected hash (§T2).
    Conflict {
        path: String,
        expected: String,
        actual: String,
    },
    /// A hunk's context lines do not match the file (§12.5).
    HunkMismatch {
        path: String,
        hunk_index: usize,
        at_line: usize,
        expected: String,
        actual: String,
    },
    NotFound {
        path: String,
    },
    AlreadyExists {
        path: String,
    },
    /// The operation cannot participate in an atomic transaction because no
    /// complete pre-image can be retained.
    NonRestorable {
        path: String,
        reason: String,
    },
    /// Applying failed and one or more compensating restores also failed.
    RollbackFailed {
        original: String,
        failures: Vec<String>,
    },
    Fs(FsError),
    /// Attempted to commit or stage into a transaction that is not open.
    InvalidState {
        state: String,
        action: String,
    },
}

impl TransactionError {
    pub fn taxonomy(&self) -> &'static str {
        match self {
            TransactionError::Conflict { .. } => "HASH_MISMATCH",
            TransactionError::HunkMismatch { .. } => "PATH_CHANGED",
            TransactionError::NotFound { .. } => "NOT_FOUND",
            TransactionError::AlreadyExists { .. } => "ALREADY_EXISTS",
            TransactionError::NonRestorable { .. } => "INVALID_ARGUMENT",
            TransactionError::RollbackFailed { .. } => "RECOVERY_REQUIRED",
            TransactionError::Fs(e) => e.taxonomy(),
            TransactionError::InvalidState { .. } => "INVALID_ARGUMENT",
        }
    }
}

impl std::fmt::Display for TransactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransactionError::Conflict {
                path,
                expected,
                actual,
            } => write!(
                f,
                "Patch conflict: {path} changed after Capybara read it. Expected {}, actual {}",
                cbc_fs::short_hash(expected),
                cbc_fs::short_hash(actual)
            ),
            TransactionError::HunkMismatch {
                path,
                hunk_index,
                at_line,
                expected,
                actual,
            } => write!(
                f,
                "{path}: hunk {hunk_index} does not apply at line {at_line} (expected {expected:?}, found {actual:?})"
            ),
            TransactionError::NotFound { path } => write!(f, "not found: {path}"),
            TransactionError::AlreadyExists { path } => write!(f, "already exists: {path}"),
            TransactionError::NonRestorable { path, reason } => {
                write!(f, "non-restorable transaction operation for {path}: {reason}")
            }
            TransactionError::RollbackFailed { original, failures } => write!(
                f,
                "transaction apply failed ({original}); rollback requires recovery: {}",
                failures.join("; ")
            ),
            TransactionError::Fs(e) => write!(f, "{e}"),
            TransactionError::InvalidState { state, action } => {
                write!(f, "cannot {action} a transaction in state {state}")
            }
        }
    }
}

impl std::error::Error for TransactionError {}

impl From<FsError> for TransactionError {
    fn from(value: FsError) -> Self {
        TransactionError::Fs(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransactionState {
    Open,
    Committed,
    RolledBack,
    Conflicted,
    RecoveryRequired,
}

impl TransactionState {
    pub fn label(&self) -> &'static str {
        match self {
            TransactionState::Open => "open",
            TransactionState::Committed => "committed",
            TransactionState::RolledBack => "rolled_back",
            TransactionState::Conflicted => "conflicted",
            TransactionState::RecoveryRequired => "recovery_required",
        }
    }
}

/// A recorded operation on one path, forming the undo journal
/// (`file_operations` table in §18.15).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationRecord {
    pub path: String,
    pub kind: FileOperationKind,
    /// Content hash before the operation. `None` when the file was created.
    pub pre_hash: Option<String>,
    /// Content hash after the operation. `None` when the file was deleted.
    pub post_hash: Option<String>,
    /// Pre-image content, retained so undo needs no Git (§G3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_image: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
}

/// Staged, validated operation ready to apply.
#[derive(Debug, Clone)]
struct StagedOperation {
    relative: String,
    absolute: PathBuf,
    kind: FileOperationKind,
    pre_hash: Option<String>,
    pre_image: Option<String>,
    /// Final content to write. `None` for a delete.
    new_content: Option<String>,
    new_absolute: Option<PathBuf>,
    new_relative: Option<String>,
    additions: usize,
    deletions: usize,
}

/// The pre-image of one staged operation, exposed for durable spill before the
/// transaction applies anything (P0-07).
#[derive(Debug, Clone)]
pub struct StagedPreImage {
    pub relative: String,
    pub kind: FileOperationKind,
    /// Content hash before the operation; `None` for a create.
    pub pre_hash: Option<String>,
    /// Content hash after the operation; `None` for a delete (the file is gone).
    /// Recovery compares this against disk to decide whether the operation had
    /// applied before the crash.
    pub post_hash: Option<String>,
    /// Full pre-image text when it could be captured; `None` for binary or
    /// oversized files.
    pub pre_image: Option<String>,
    /// Rename target, when the operation is a move.
    pub new_path: Option<String>,
}

/// A named point in a transaction's applied history that can be returned to.
///
/// Checkpoints exist because the agent's self-reflection loop can conclude that an
/// entire *approach* was wrong, not just the last edit. Undoing the whole
/// transaction would also discard the earlier work the reflection judged sound,
/// and undoing "the last operation" is not meaningful when an approach spans
/// several. A checkpoint marks the boundary the agent wants to return to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    /// Number of operations already applied when the checkpoint was taken.
    pub applied_len: usize,
    /// Number of operations still staged when the checkpoint was taken.
    pub staged_len: usize,
    pub label: Option<String>,
    pub created_at: String,
}

/// Outcome of returning a transaction to a checkpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRollback {
    pub checkpoint_id: String,
    /// Paths restored to the content they held at the checkpoint.
    pub reverted: Vec<UndoOutcome>,
    /// Operations dropped from the transaction's applied history.
    pub discarded_operations: usize,
    /// Staged-but-unapplied operations discarded along with them.
    pub discarded_staged: usize,
}

/// A file mutation transaction.
#[derive(Debug)]
pub struct FileTransaction {
    pub id: String,
    pub turn_id: Option<String>,
    pub agent_id: Option<String>,
    /// The approach this transaction belongs to (§11.2).
    ///
    /// One approach usually spans several transactions — read, patch, verify, patch
    /// again — so abandoning it means undoing all of them. Tagging each transaction
    /// at `begin` is what lets the runtime find that set later without the agent
    /// having to remember which transaction ids it created.
    pub checkpoint_id: Option<String>,
    /// Canonical root used for directory-handle-relative filesystem access.
    workspace_root: Option<PathBuf>,
    state: TransactionState,
    staged: Vec<StagedOperation>,
    applied: Vec<FileOperationRecord>,
    /// Every operation ever applied, including those a checkpoint rollback removed
    /// from `applied`. Retained so the undo journal in §18.15 still records what the
    /// agent did and then undid, rather than presenting a rewritten history.
    history: Vec<FileOperationRecord>,
    checkpoints: Vec<Checkpoint>,
    started_at: String,
    committed_at: Option<String>,
}
fn path_exists_at(
    root: Option<&Path>,
    relative: &str,
    absolute: &Path,
) -> Result<bool, TransactionError> {
    match root {
        Some(root) => Ok(path_exists_beneath(root, Path::new(relative))?),
        None => Ok(absolute.symlink_metadata().is_ok()),
    }
}

fn read_text_at(
    root: Option<&Path>,
    relative: &str,
    absolute: &Path,
) -> Result<(String, String), TransactionError> {
    match root {
        Some(root) => Ok(read_text_beneath(
            root,
            Path::new(relative),
            cbc_fs::DEFAULT_MAX_FILE_BYTES,
        )?),
        None => Ok(cbc_fs::read_text(absolute, cbc_fs::DEFAULT_MAX_FILE_BYTES)?),
    }
}

fn is_binary_at(
    root: Option<&Path>,
    relative: &str,
    absolute: &Path,
) -> Result<bool, TransactionError> {
    match root {
        Some(root) => Ok(is_probably_binary_beneath(root, Path::new(relative))?),
        None => Ok(cbc_fs::is_probably_binary(absolute)),
    }
}

fn hash_at(root: Option<&Path>, relative: &str, absolute: &Path) -> Result<String, FsError> {
    match root {
        Some(root) => hash_file_beneath(root, Path::new(relative)),
        None => hash_file(absolute),
    }
}

fn write_at(
    root: Option<&Path>,
    relative: &str,
    absolute: &Path,
    content: &[u8],
    intent: WriteIntent,
    expected_hash: Option<&str>,
) -> Result<cbc_fs::WriteOutcome, FsError> {
    match root {
        Some(root) => {
            atomic_write_beneath(root, Path::new(relative), content, intent, expected_hash)
        }
        None => atomic_write(absolute, content, intent, expected_hash),
    }
}

fn delete_at(root: Option<&Path>, relative: &str, absolute: &Path) -> Result<u64, FsError> {
    match root {
        Some(root) => delete_path_beneath(root, Path::new(relative), false),
        None => cbc_fs::delete_path(absolute, false),
    }
}

fn move_at(
    root: Option<&Path>,
    from_relative: &str,
    from_absolute: &Path,
    to_relative: &str,
    to_absolute: &Path,
) -> Result<(), FsError> {
    match root {
        Some(root) => move_path_beneath(root, Path::new(from_relative), Path::new(to_relative)),
        None => cbc_fs::move_path(from_absolute, to_absolute),
    }
}

impl FileTransaction {
    pub fn begin(id: impl Into<String>, turn_id: Option<String>, agent_id: Option<String>) -> Self {
        Self {
            id: id.into(),
            turn_id,
            agent_id,
            checkpoint_id: None,
            state: TransactionState::Open,
            workspace_root: None,
            staged: Vec::new(),
            applied: Vec::new(),
            history: Vec::new(),
            checkpoints: Vec::new(),
            started_at: now_iso8601(),
            committed_at: None,
        }
    }

    /// Tag this transaction with the approach it belongs to.
    pub fn with_checkpoint(mut self, checkpoint_id: Option<String>) -> Self {
        self.checkpoint_id = checkpoint_id;
        self
    }

    /// Anchor every filesystem operation to this workspace directory.
    pub fn with_workspace_root(mut self, root: PathBuf) -> Self {
        self.workspace_root = Some(root);
        self
    }

    pub fn state(&self) -> TransactionState {
        self.state
    }

    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    pub fn committed_at(&self) -> Option<&str> {
        self.committed_at.as_deref()
    }

    pub fn staged_count(&self) -> usize {
        self.staged.len()
    }

    pub fn records(&self) -> &[FileOperationRecord] {
        &self.applied
    }

    /// Everything this transaction ever applied, including operations a checkpoint
    /// rollback later removed from `records()`.
    pub fn history(&self) -> &[FileOperationRecord] {
        &self.history
    }

    pub fn checkpoints(&self) -> &[Checkpoint] {
        &self.checkpoints
    }

    pub fn find_checkpoint(&self, id: &str) -> Option<&Checkpoint> {
        self.checkpoints.iter().find(|c| c.id == id)
    }

    /// Record a checkpoint at the current position in this transaction.
    ///
    /// Taking a checkpoint is free: it records two lengths and a timestamp. That is
    /// deliberate — a checkpoint the agent hesitates to take is a checkpoint that is
    /// not there when reflection needs it.
    pub fn checkpoint(&mut self, id: impl Into<String>, label: Option<String>) -> Checkpoint {
        let checkpoint = Checkpoint {
            id: id.into(),
            applied_len: self.applied.len(),
            staged_len: self.staged.len(),
            label,
            created_at: now_iso8601(),
        };
        self.checkpoints.push(checkpoint.clone());
        checkpoint
    }

    /// Return the workspace to a checkpoint taken earlier in this transaction.
    ///
    /// Unlike `rollback`, this is legal after a commit: the whole point is to undo
    /// work that was already applied because the agent's self-reflection loop
    /// concluded the approach behind it was wrong (§11.2).
    ///
    /// User edits made after the agent's write are never destroyed — the restore
    /// goes through `undo_records`, which reverts a path only while its content
    /// still matches what the agent left there (§24.1 invariant 9). A path it
    /// declines is reported as skipped rather than forced.
    pub fn rollback_to_checkpoint(
        &mut self,
        checkpoint_id: &str,
        resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
    ) -> Result<CheckpointRollback, TransactionError> {
        let position = self
            .checkpoints
            .iter()
            .position(|candidate| candidate.id == checkpoint_id)
            .ok_or_else(|| TransactionError::NotFound {
                path: format!("checkpoint '{checkpoint_id}'"),
            })?;
        let checkpoint = self.checkpoints[position].clone();

        if checkpoint.applied_len > self.applied.len() {
            // The applied history is shorter than when the checkpoint was taken,
            // which means something already rewound past it. Undoing a tail that
            // does not exist would silently revert the wrong operations.
            return Err(TransactionError::InvalidState {
                state: self.state.label().into(),
                action: format!(
                    "roll back to checkpoint '{checkpoint_id}': it expects {} applied operation(s), but only {} remain",
                    checkpoint.applied_len,
                    self.applied.len()
                ),
            });
        }

        let tail = self.applied.split_off(checkpoint.applied_len);
        let discarded_staged = self.staged.len().saturating_sub(checkpoint.staged_len);
        self.staged
            .truncate(checkpoint.staged_len.min(self.staged.len()));

        let reverted = undo_records_with_root(&tail, resolve, self.workspace_root.as_deref());

        // Checkpoints taken after this one no longer describe a reachable position.
        // This one stays, so the same point can be returned to more than once.
        self.checkpoints.truncate(position + 1);

        // A transaction whose every applied operation has been undone is no longer
        // committed in any meaningful sense, and reporting it as committed would
        // leave the journal claiming changes that are not on disk.
        if self.applied.is_empty() && self.state == TransactionState::Committed {
            self.state = TransactionState::RolledBack;
        }

        Ok(CheckpointRollback {
            checkpoint_id: checkpoint.id,
            reverted,
            discarded_operations: tail.len(),
            discarded_staged,
        })
    }

    /// Paths touched by staged operations, used for write-lease and overlap
    /// detection in the tool scheduler (§12.9).
    pub fn staged_paths(&self) -> Vec<String> {
        self.staged.iter().map(|s| s.relative.clone()).collect()
    }

    /// Pre-images of the staged operations, so the runtime can persist them
    /// durably *before* applying anything (P0-07 durable intent). A crash mid-commit
    /// can then be rolled forward or back from these, and `/undo` keeps working
    /// across process restarts.
    pub fn staged_pre_images(&self) -> Vec<StagedPreImage> {
        self.staged
            .iter()
            .map(|s| {
                let post_hash = match s.kind {
                    FileOperationKind::Delete => None,
                    FileOperationKind::Rename if s.new_content.is_none() => s.pre_hash.clone(),
                    _ => s
                        .new_content
                        .as_deref()
                        .map(|content| cbc_fs::hash_bytes(content.as_bytes())),
                };
                StagedPreImage {
                    relative: s.relative.clone(),
                    kind: s.kind,
                    pre_hash: s.pre_hash.clone(),
                    post_hash,
                    pre_image: s.pre_image.clone(),
                    new_path: s.new_relative.clone(),
                }
            })
            .collect()
    }

    fn ensure_open(&self, action: &str) -> Result<(), TransactionError> {
        if self.state != TransactionState::Open {
            return Err(TransactionError::InvalidState {
                state: self.state.label().into(),
                action: action.into(),
            });
        }
        Ok(())
    }

    /// Stage a complete-file write.
    pub fn stage_write(
        &mut self,
        relative: &str,
        absolute: &Path,
        content: &str,
        intent: WriteIntent,
        expected_hash: Option<&str>,
    ) -> Result<(), TransactionError> {
        self.ensure_open("stage")?;
        let exists = path_exists_at(self.workspace_root.as_deref(), relative, absolute)?;

        match intent {
            WriteIntent::Create if exists => {
                return Err(TransactionError::AlreadyExists {
                    path: relative.into(),
                })
            }
            WriteIntent::Replace if !exists => {
                return Err(TransactionError::NotFound {
                    path: relative.into(),
                })
            }
            _ => {}
        }

        let (pre_image, pre_hash) = if exists {
            let (text, hash) = read_text_at(self.workspace_root.as_deref(), relative, absolute)?;
            (Some(text), Some(hash))
        } else {
            (None, None)
        };

        let expected_hash = match intent {
            // OpenAI's strict function schemas require optional string
            // properties to be present. For create/upsert, the empty string is
            // therefore the provider's representation of "not supplied".
            WriteIntent::Create | WriteIntent::Upsert => {
                expected_hash.filter(|hash| !hash.is_empty())
            }
            // A replace must retain an empty expectation as a conflict. Silently
            // dropping it could overwrite a user edit that the agent did not
            // actually read.
            WriteIntent::Replace => expected_hash,
        };

        // P0-07: replacing an existing file without a base hash is a blind
        // overwrite — the exact stale-read the optimistic-concurrency check
        // exists to catch. Refuse it instead of treating "no expectation" as
        // "always fine"; the caller must read the file and pass its checksum.
        if matches!(intent, WriteIntent::Replace)
            && exists
            && expected_hash.map(str::is_empty).unwrap_or(true)
        {
            self.state = TransactionState::Conflicted;
            return Err(TransactionError::Conflict {
                path: relative.into(),
                expected: "<a base hash is required for replace>".into(),
                actual: pre_hash.clone().unwrap_or_else(|| "<absent>".into()),
            });
        }

        if let Some(expected) = expected_hash {
            let actual = pre_hash.clone().unwrap_or_else(|| "<absent>".into());
            if !cbc_fs::hashes_match(&actual, expected) {
                self.state = TransactionState::Conflicted;
                return Err(TransactionError::Conflict {
                    path: relative.into(),
                    expected: expected.into(),
                    actual,
                });
            }
        }

        // Preserve the original newline style (§12.5).
        let final_content = match &pre_image {
            Some(original) => NewlineStyle::detect(original).apply(content),
            None => content.to_string(),
        };

        let (additions, deletions) = line_delta(pre_image.as_deref().unwrap_or(""), &final_content);

        self.staged.push(StagedOperation {
            relative: relative.to_string(),
            absolute: absolute.to_path_buf(),
            kind: if exists {
                FileOperationKind::Modify
            } else {
                FileOperationKind::Create
            },
            pre_hash,
            pre_image,
            new_content: Some(final_content),
            new_absolute: None,
            new_relative: None,
            additions,
            deletions,
        });
        Ok(())
    }

    /// Stage a delete.
    pub fn stage_delete(
        &mut self,
        relative: &str,
        absolute: &Path,
        expected_hash: Option<&str>,
        recursive: bool,
    ) -> Result<(), TransactionError> {
        self.ensure_open("stage")?;
        if recursive {
            return Err(TransactionError::NonRestorable {
                path: relative.into(),
                reason: "recursive or directory delete has no complete transaction pre-image"
                    .into(),
            });
        }
        if is_binary_at(self.workspace_root.as_deref(), relative, absolute)? {
            return Err(TransactionError::NonRestorable {
                path: relative.into(),
                reason: "binary file content cannot be stored in the text rollback journal".into(),
            });
        }
        let (text, hash) = read_text_at(self.workspace_root.as_deref(), relative, absolute)
            .map_err(|error| TransactionError::NonRestorable {
                path: relative.into(),
                reason: error.to_string(),
            })?;
        let (pre_image, pre_hash) = (Some(text), Some(hash));

        // Providers using strict schemas sometimes encode an omitted optional
        // hash as the empty string; a real SHA-256 is always non-empty.
        let expected_hash = expected_hash.filter(|hash| !hash.is_empty());
        // P0-07: deleting an existing file without a base hash is a blind
        // removal — the same stale-read hazard replace has. The caller must
        // have read the file (and therefore know its checksum) before deleting
        // it; refuse otherwise. A directory has no content hash (`pre_hash` is
        // `None`), so recursive directory removal is exempt.
        let file_target = pre_hash.is_some();
        if file_target && expected_hash.is_none() {
            self.state = TransactionState::Conflicted;
            return Err(TransactionError::Conflict {
                path: relative.into(),
                expected: "<a base hash is required for delete>".into(),
                actual: pre_hash.clone().unwrap_or_else(|| "<unknown>".into()),
            });
        }
        if let Some(expected) = expected_hash {
            let actual = pre_hash.clone().unwrap_or_else(|| "<unknown>".into());
            if !cbc_fs::hashes_match(&actual, expected) {
                self.state = TransactionState::Conflicted;
                return Err(TransactionError::Conflict {
                    path: relative.into(),
                    expected: expected.into(),
                    actual,
                });
            }
        }

        let deletions = pre_image.as_deref().map(count_lines).unwrap_or(0);
        self.staged.push(StagedOperation {
            relative: relative.to_string(),
            absolute: absolute.to_path_buf(),
            kind: FileOperationKind::Delete,
            pre_hash,
            pre_image,
            new_content: None,
            new_absolute: None,
            new_relative: None,
            additions: 0,
            deletions,
        });
        Ok(())
    }

    /// Stage a move/rename.
    pub fn stage_move(
        &mut self,
        from_relative: &str,
        from_absolute: &Path,
        to_relative: &str,
        to_absolute: &Path,
        expected_hash: Option<&str>,
    ) -> Result<(), TransactionError> {
        self.ensure_open("stage")?;
        if is_binary_at(self.workspace_root.as_deref(), from_relative, from_absolute)? {
            return Err(TransactionError::NonRestorable {
                path: from_relative.into(),
                reason: "binary file content cannot be stored in the text rollback journal".into(),
            });
        }
        let (text, hash) =
            read_text_at(self.workspace_root.as_deref(), from_relative, from_absolute).map_err(
                |error| TransactionError::NonRestorable {
                    path: from_relative.into(),
                    reason: error.to_string(),
                },
            )?;
        let (pre_image, pre_hash) = (Some(text), Some(hash));
        if path_exists_at(self.workspace_root.as_deref(), to_relative, to_absolute)? {
            return Err(TransactionError::AlreadyExists {
                path: to_relative.into(),
            });
        }

        // P0-07: a move rewrites the directory entry of an existing file, so it
        // carries the same stale-read hazard as delete. Require the base hash the
        // caller observed when it read the file. Renaming a directory has no
        // content hash to check (`pre_hash` is `None`), so it is exempt.
        let expected_hash = expected_hash.filter(|hash| !hash.is_empty());
        let file_target = pre_hash.is_some();
        if file_target && expected_hash.is_none() {
            self.state = TransactionState::Conflicted;
            return Err(TransactionError::Conflict {
                path: from_relative.into(),
                expected: "<a base hash is required for move>".into(),
                actual: pre_hash.clone().unwrap_or_else(|| "<unknown>".into()),
            });
        }
        if let Some(expected) = expected_hash {
            let actual = pre_hash.clone().unwrap_or_else(|| "<unknown>".into());
            if !cbc_fs::hashes_match(&actual, expected) {
                self.state = TransactionState::Conflicted;
                return Err(TransactionError::Conflict {
                    path: from_relative.into(),
                    expected: expected.into(),
                    actual,
                });
            }
        }

        self.staged.push(StagedOperation {
            relative: from_relative.to_string(),
            absolute: from_absolute.to_path_buf(),
            kind: FileOperationKind::Rename,
            pre_hash,
            pre_image,
            new_content: None,
            new_absolute: Some(to_absolute.to_path_buf()),
            new_relative: Some(to_relative.to_string()),
            additions: 0,
            deletions: 0,
        });
        Ok(())
    }

    /// Stage a Rust-preflighted edit plan as one all-or-nothing staging unit.
    ///
    /// No filesystem write happens here, but staging itself must not be partial:
    /// a stale second file cannot leave an earlier edit accidentally queued for
    /// commit. The runtime supplies a guard-aware resolver for every path.
    pub fn stage_prepared_edit_plan(
        &mut self,
        changes: &[PreparedFileChange],
        resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
    ) -> Result<(), TransactionError> {
        self.ensure_open("stage edit plan")?;

        let mut already_staged = BTreeSet::new();
        for operation in &self.staged {
            already_staged.insert(operation.relative.as_str());
            if let Some(new_relative) = operation.new_relative.as_deref() {
                already_staged.insert(new_relative);
            }
        }
        let mut claimed = BTreeSet::new();
        for change in changes {
            let mut paths = vec![change.path.as_str()];
            if let Some(previous_path) = change.previous_path.as_deref() {
                paths.push(previous_path);
            }
            for path in paths {
                if !claimed.insert(path) || already_staged.contains(path) {
                    return Err(TransactionError::InvalidState {
                        state: self.state.label().to_owned(),
                        action: format!(
                            "stage edit plan: path '{path}' overlaps an existing or duplicate staged operation"
                        ),
                    });
                }
            }
        }

        enum PreparedStage {
            Write {
                relative: String,
                absolute: PathBuf,
                content: String,
                intent: WriteIntent,
                expected_hash: Option<String>,
            },
            Delete {
                relative: String,
                absolute: PathBuf,
                expected_hash: Option<String>,
            },
            Move {
                from_relative: String,
                from_absolute: PathBuf,
                to_relative: String,
                to_absolute: PathBuf,
                expected_hash: Option<String>,
            },
        }

        let mut prepared = Vec::with_capacity(changes.len());
        for change in changes {
            let missing_text = || TransactionError::InvalidState {
                state: self.state.label().to_owned(),
                action: format!(
                    "stage edit plan: {} change for '{}' has no complete staged text",
                    match change.kind {
                        PreparedFileKind::Modify => "modify",
                        PreparedFileKind::Create => "create",
                        _ => "text",
                    },
                    change.path
                ),
            };
            let stage = match change.kind {
                PreparedFileKind::Modify | PreparedFileKind::Create => PreparedStage::Write {
                    relative: change.path.clone(),
                    absolute: resolve(&change.path)?,
                    content: change.text.clone().ok_or_else(missing_text)?,
                    intent: if change.kind == PreparedFileKind::Modify {
                        WriteIntent::Replace
                    } else {
                        WriteIntent::Create
                    },
                    expected_hash: change.revision_before.clone(),
                },
                PreparedFileKind::Delete => PreparedStage::Delete {
                    relative: change.path.clone(),
                    absolute: resolve(&change.path)?,
                    expected_hash: change.revision_before.clone(),
                },
                PreparedFileKind::Move => {
                    let from_relative = change.previous_path.clone().ok_or_else(|| {
                        TransactionError::InvalidState {
                            state: self.state.label().to_owned(),
                            action: format!(
                                "stage edit plan: move destination '{}' has no source path",
                                change.path
                            ),
                        }
                    })?;
                    PreparedStage::Move {
                        from_absolute: resolve(&from_relative)?,
                        to_absolute: resolve(&change.path)?,
                        from_relative,
                        to_relative: change.path.clone(),
                        expected_hash: change.revision_before.clone(),
                    }
                }
            };
            prepared.push(stage);
        }

        let staged_before = self.staged.len();
        for stage in prepared {
            let result = match stage {
                PreparedStage::Write {
                    relative,
                    absolute,
                    content,
                    intent,
                    expected_hash,
                } => self.stage_write(
                    &relative,
                    &absolute,
                    &content,
                    intent,
                    expected_hash.as_deref(),
                ),
                PreparedStage::Delete {
                    relative,
                    absolute,
                    expected_hash,
                } => self.stage_delete(&relative, &absolute, expected_hash.as_deref(), false),
                PreparedStage::Move {
                    from_relative,
                    from_absolute,
                    to_relative,
                    to_absolute,
                    expected_hash,
                } => self.stage_move(
                    &from_relative,
                    &from_absolute,
                    &to_relative,
                    &to_absolute,
                    expected_hash.as_deref(),
                ),
            };
            if let Err(error) = result {
                self.staged.truncate(staged_before);
                return Err(error);
            }
        }
        Ok(())
    }

    /// Stage an entire parsed patch. Every hunk in every file is validated
    /// against current content before anything is staged — the whole patch is
    /// rejected on the first failure (TOOL-001, AC-14).
    pub fn stage_patch(
        &mut self,
        patch: &Patch,
        resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
    ) -> Result<(), TransactionError> {
        self.ensure_open("stage")?;
        let mut prepared: Vec<StagedOperation> = Vec::new();

        for file in &patch.files {
            let absolute = resolve(&file.path)?;
            let op = self.prepare_file_patch(file, &absolute, resolve)?;
            prepared.push(op);
        }

        // Only now, after every file validated, commit to staging.
        self.staged.extend(prepared);
        Ok(())
    }

    fn prepare_file_patch(
        &mut self,
        file: &FilePatch,
        absolute: &Path,
        resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
    ) -> Result<StagedOperation, TransactionError> {
        let exists = path_exists_at(self.workspace_root.as_deref(), &file.path, absolute)?;

        match file.kind {
            FileOperationKind::Create if exists => {
                return Err(TransactionError::AlreadyExists {
                    path: file.path.clone(),
                })
            }
            FileOperationKind::Delete | FileOperationKind::Modify | FileOperationKind::Rename
                if !exists =>
            {
                return Err(TransactionError::NotFound {
                    path: file.path.clone(),
                })
            }
            _ => {}
        }

        let (original, pre_hash) = if exists {
            let (text, hash) = read_text_at(self.workspace_root.as_deref(), &file.path, absolute)?;
            (text, Some(hash))
        } else {
            (String::new(), None)
        };

        // A create patch has the same empty-string omission sentinel as
        // fs.write. Keep an empty expectation strict for modifications/deletes.
        let expected_hash = file
            .expected_hash
            .as_ref()
            .filter(|hash| !(file.kind == FileOperationKind::Create && hash.is_empty()));
        if let Some(expected) = expected_hash {
            let actual = pre_hash.clone().unwrap_or_else(|| "<absent>".into());
            if !cbc_fs::hashes_match(&actual, expected) {
                return Err(TransactionError::Conflict {
                    path: file.path.clone(),
                    expected: expected.clone(),
                    actual,
                });
            }
        }

        if file.kind == FileOperationKind::Delete {
            return Ok(StagedOperation {
                relative: file.path.clone(),
                absolute: absolute.to_path_buf(),
                kind: FileOperationKind::Delete,
                pre_hash,
                pre_image: Some(original.clone()),
                new_content: None,
                new_absolute: None,
                new_relative: None,
                additions: 0,
                deletions: count_lines(&original),
            });
        }

        let style = NewlineStyle::detect(&original);
        // Hunk context lines from a unified diff never carry a CR, so compare
        // against LF-normalized content and restore the original style after.
        let normalized = original.replace("\r\n", "\n");
        let (new_text, additions, deletions) = apply_hunks(&file.path, &normalized, &file.hunks)?;
        // A file that did not exist has no style to preserve; using the empty
        // string's style would strip the patch's own trailing newline.
        let new_text = if exists {
            style.apply(&new_text)
        } else {
            new_text
        };

        if file.kind == FileOperationKind::Rename && new_text != original {
            return Err(TransactionError::NonRestorable {
                path: file.path.clone(),
                reason: "rename-with-content-change is not supported atomically".into(),
            });
        }

        let (target_absolute, target_relative) = match (&file.kind, &file.new_path) {
            (FileOperationKind::Rename, Some(new_path)) => {
                let abs = resolve(new_path)?;
                if path_exists_at(self.workspace_root.as_deref(), new_path, &abs)? {
                    return Err(TransactionError::AlreadyExists {
                        path: new_path.clone(),
                    });
                }
                (Some(abs), Some(new_path.clone()))
            }
            _ => (None, None),
        };

        Ok(StagedOperation {
            relative: file.path.clone(),
            absolute: absolute.to_path_buf(),
            kind: file.kind,
            pre_hash,
            pre_image: if exists { Some(original) } else { None },
            new_content: if file.kind == FileOperationKind::Rename {
                None
            } else {
                Some(new_text)
            },
            new_absolute: target_absolute,
            new_relative: target_relative,
            additions,
            deletions,
        })
    }

    /// Apply every staged operation. If any write fails, all already-applied
    /// operations in this transaction are rolled back before returning the
    /// error, so the workspace never observes a partial patch (TOOL-001).
    pub fn commit(&mut self) -> Result<Vec<FileOperationRecord>, TransactionError> {
        self.ensure_open("commit")?;

        let staged = std::mem::take(&mut self.staged);
        let workspace_root = self.workspace_root.clone();
        let mut applied: Vec<FileOperationRecord> = Vec::new();

        for op in &staged {
            let result = apply_operation(op, workspace_root.as_deref());
            match result {
                Ok(record) => applied.push(record),
                Err(error) => {
                    let mut failures = Vec::new();
                    for done in applied.iter().rev() {
                        if let Err(restore_error) =
                            restore_record(done, &staged, workspace_root.as_deref())
                        {
                            failures.push(format!("{}: {restore_error}", done.path));
                        }
                    }
                    self.staged = staged;
                    if failures.is_empty() {
                        self.state = TransactionState::RolledBack;
                        return Err(error);
                    }

                    let original = error.to_string();
                    self.applied = applied;
                    self.state = TransactionState::RecoveryRequired;
                    return Err(TransactionError::RollbackFailed { original, failures });
                }
            }
        }

        self.applied = applied.clone();
        self.history.extend(applied.iter().cloned());
        self.state = TransactionState::Committed;
        self.committed_at = Some(now_iso8601());
        Ok(applied)
    }

    /// Undo every operation this transaction applied.
    ///
    /// Used when an approach spanning several transactions is abandoned as a unit
    /// (§11.2). Reverting only part of it would leave the workspace in a state no
    /// plan ever described, which is harder to reason about than either endpoint.
    ///
    /// A path the user edited after the agent wrote it is reported as skipped, not
    /// forced, so the transaction ends `Conflicted` rather than `RolledBack` — the
    /// undo genuinely did not complete, and saying otherwise would hide it.
    pub fn undo_all(
        &mut self,
        resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
    ) -> Vec<UndoOutcome> {
        let records = std::mem::take(&mut self.applied);
        let outcomes = undo_records_with_root(&records, resolve, self.workspace_root.as_deref());
        self.staged.clear();
        self.checkpoints.clear();

        let clean = outcomes
            .iter()
            .all(|o| matches!(o.status, UndoStatus::Reverted | UndoStatus::SkippedMissing));
        self.state = if clean {
            TransactionState::RolledBack
        } else if outcomes
            .iter()
            .any(|outcome| outcome.status == UndoStatus::Failed)
        {
            TransactionState::RecoveryRequired
        } else {
            TransactionState::Conflicted
        };
        outcomes
    }

    /// Discard staged operations without touching the filesystem.
    pub fn rollback(&mut self) -> Result<(), TransactionError> {
        match self.state {
            TransactionState::Open | TransactionState::Conflicted => {
                self.staged.clear();
                self.state = TransactionState::RolledBack;
                Ok(())
            }
            other => Err(TransactionError::InvalidState {
                state: other.label().into(),
                action: "rollback".into(),
            }),
        }
    }
}

/// Re-check a staged path immediately before destructive operations. Writes
/// already perform this check inside `atomic_write`; delete and rename need the
/// same optimistic-concurrency guarantee or a user edit can be moved/deleted
/// after the agent read it.
fn verify_staged_hash(op: &StagedOperation, root: Option<&Path>) -> Result<(), TransactionError> {
    let Some(expected) = &op.pre_hash else {
        return Ok(());
    };
    let actual = match hash_at(root, &op.relative, &op.absolute) {
        Ok(hash) => hash,
        Err(FsError::NotFound { .. }) => {
            return Err(TransactionError::NotFound {
                path: op.relative.clone(),
            })
        }
        Err(error) => return Err(error.into()),
    };
    if &actual != expected {
        return Err(TransactionError::Conflict {
            path: op.relative.clone(),
            expected: expected.clone(),
            actual,
        });
    }
    Ok(())
}
fn apply_operation(
    op: &StagedOperation,
    root: Option<&Path>,
) -> Result<FileOperationRecord, TransactionError> {
    match op.kind {
        FileOperationKind::Delete => {
            verify_staged_hash(op, root)?;
            delete_at(root, &op.relative, &op.absolute)?;
            Ok(FileOperationRecord {
                path: op.relative.clone(),
                kind: FileOperationKind::Delete,
                pre_hash: op.pre_hash.clone(),
                post_hash: None,
                pre_image: op.pre_image.clone(),
                additions: 0,
                deletions: op.deletions,
                new_path: None,
            })
        }
        FileOperationKind::Rename => {
            verify_staged_hash(op, root)?;
            let target = op
                .new_absolute
                .as_ref()
                .ok_or(TransactionError::InvalidState {
                    state: "staged".into(),
                    action: "rename without target".into(),
                })?;
            let target_relative =
                op.new_relative
                    .as_deref()
                    .ok_or(TransactionError::InvalidState {
                        state: "staged".into(),
                        action: "rename without a relative target".into(),
                    })?;
            if let Some(content) = &op.new_content {
                // Rename with content change: write the new file, delete old.
                let outcome = write_at(
                    root,
                    target_relative,
                    target,
                    content.as_bytes(),
                    WriteIntent::Create,
                    None,
                )?;
                if let Err(error) = delete_at(root, &op.relative, &op.absolute) {
                    // A rename-with-content is implemented as write + delete.
                    // Do not leave the newly-created target behind when the
                    // second half fails; the transaction must remain atomic.
                    let _ = delete_at(root, target_relative, target);
                    return Err(error.into());
                }
                Ok(FileOperationRecord {
                    path: op.relative.clone(),
                    kind: FileOperationKind::Rename,
                    pre_hash: op.pre_hash.clone(),
                    post_hash: Some(outcome.post_hash),
                    pre_image: op.pre_image.clone(),
                    additions: op.additions,
                    deletions: op.deletions,
                    new_path: op.new_relative.clone(),
                })
            } else {
                move_at(root, &op.relative, &op.absolute, target_relative, target)?;
                Ok(FileOperationRecord {
                    path: op.relative.clone(),
                    kind: FileOperationKind::Rename,
                    pre_hash: op.pre_hash.clone(),
                    post_hash: op.pre_hash.clone(),
                    pre_image: op.pre_image.clone(),
                    additions: 0,
                    deletions: 0,
                    new_path: op.new_relative.clone(),
                })
            }
        }
        FileOperationKind::Create | FileOperationKind::Modify => {
            let content = op.new_content.as_deref().unwrap_or("");
            let intent = if op.pre_hash.is_some() {
                WriteIntent::Replace
            } else {
                WriteIntent::Create
            };
            // Re-check the hash at apply time: a user edit between stage and
            // commit must still be detected (§T2).
            let outcome = write_at(
                root,
                &op.relative,
                &op.absolute,
                content.as_bytes(),
                intent,
                op.pre_hash.as_deref(),
            )?;
            Ok(FileOperationRecord {
                path: op.relative.clone(),
                kind: op.kind,
                pre_hash: outcome.pre_hash,
                post_hash: Some(outcome.post_hash),
                pre_image: op.pre_image.clone(),
                additions: op.additions,
                deletions: op.deletions,
                new_path: None,
            })
        }
    }
}

fn restore_record(
    record: &FileOperationRecord,
    staged: &[StagedOperation],
    root: Option<&Path>,
) -> Result<(), TransactionError> {
    let op = staged.iter().find(|s| s.relative == record.path).ok_or(
        TransactionError::InvalidState {
            state: "committed".into(),
            action: "restore unknown path".into(),
        },
    )?;

    let missing_pre_image = || TransactionError::NonRestorable {
        path: record.path.clone(),
        reason: "rollback journal has no pre-image".into(),
    };
    let changed = |expected: &str, actual: String| TransactionError::Conflict {
        path: record.path.clone(),
        expected: expected.into(),
        actual,
    };

    match record.kind {
        FileOperationKind::Create => {
            let Some(expected) = record.post_hash.as_deref() else {
                return Err(missing_pre_image());
            };
            match hash_at(root, &op.relative, &op.absolute) {
                Ok(actual) if cbc_fs::hashes_match(&actual, expected) => {
                    delete_at(root, &op.relative, &op.absolute)?;
                }
                Ok(actual) => return Err(changed(expected, actual)),
                Err(FsError::NotFound { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        FileOperationKind::Delete => {
            if path_exists_at(root, &op.relative, &op.absolute)? {
                let actual = hash_at(root, &op.relative, &op.absolute)
                    .unwrap_or_else(|_| "<path was recreated>".into());
                return Err(changed("<absent>", actual));
            }
            let pre = record.pre_image.as_ref().ok_or_else(missing_pre_image)?;
            write_at(
                root,
                &op.relative,
                &op.absolute,
                pre.as_bytes(),
                WriteIntent::Create,
                None,
            )?;
        }
        FileOperationKind::Modify => {
            let pre = record.pre_image.as_ref().ok_or_else(missing_pre_image)?;
            let expected = record.post_hash.as_deref().ok_or_else(missing_pre_image)?;
            write_at(
                root,
                &op.relative,
                &op.absolute,
                pre.as_bytes(),
                WriteIntent::Replace,
                Some(expected),
            )?;
        }
        FileOperationKind::Rename => {
            let target = op
                .new_absolute
                .as_ref()
                .ok_or(TransactionError::InvalidState {
                    state: "committed".into(),
                    action: "restore rename without target".into(),
                })?;
            if path_exists_at(root, &op.relative, &op.absolute)? {
                return Err(changed("<absent>", "<source path was recreated>".into()));
            }
            let expected = record.post_hash.as_deref().ok_or_else(missing_pre_image)?;
            let target_relative = op.new_relative.as_deref().ok_or_else(missing_pre_image)?;
            let actual = hash_at(root, target_relative, target)?;
            if !cbc_fs::hashes_match(&actual, expected) {
                return Err(changed(expected, actual));
            }
            move_at(root, target_relative, target, &op.relative, &op.absolute)?;
        }
    }
    Ok(())
}

/// Undo outcome for a single path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub path: String,
    pub status: UndoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UndoStatus {
    Reverted,
    /// The file changed after the agent wrote it — skipped to protect user work.
    SkippedUserModified,
    SkippedMissing,
    SkippedNoPreImage,
    Failed,
}

/// Undo a committed transaction — AC-15.
///
/// A path is reverted only when its current content hash still equals the
/// recorded post-image. Anything else is reported as skipped, satisfying
/// invariant 9 in §24.1 ("undo는 agent transaction 밖 user change를 삭제하지
/// 않는다").
pub fn undo_records(
    records: &[FileOperationRecord],
    resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
) -> Vec<UndoOutcome> {
    undo_records_with_root(records, resolve, None)
}

fn undo_records_with_root(
    records: &[FileOperationRecord],
    resolve: &dyn Fn(&str) -> Result<PathBuf, TransactionError>,
    root: Option<&Path>,
) -> Vec<UndoOutcome> {
    let mut outcomes = Vec::new();
    // Reverse order so renames and dependent creates unwind correctly.
    for record in records.iter().rev() {
        let Ok(absolute) = resolve(&record.path) else {
            outcomes.push(UndoOutcome {
                path: record.path.clone(),
                status: UndoStatus::Failed,
                detail: Some("path could not be resolved".into()),
            });
            continue;
        };

        match record.kind {
            FileOperationKind::Create => {
                let current = hash_at(root, &record.path, &absolute).ok();
                match (current, &record.post_hash) {
                    (Some(cur), Some(post)) if &cur == post => {
                        match delete_at(root, &record.path, &absolute) {
                            Ok(_) => outcomes.push(UndoOutcome {
                                path: record.path.clone(),
                                status: UndoStatus::Reverted,
                                detail: None,
                            }),
                            Err(e) => outcomes.push(UndoOutcome {
                                path: record.path.clone(),
                                status: UndoStatus::Failed,
                                detail: Some(e.to_string()),
                            }),
                        }
                    }
                    (Some(_), _) => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedUserModified,
                        detail: Some("file changed after Capybara created it".into()),
                    }),
                    (None, _) => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedMissing,
                        detail: None,
                    }),
                }
            }
            FileOperationKind::Modify => {
                let Some(pre) = &record.pre_image else {
                    outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedNoPreImage,
                        detail: Some("pre-image not retained".into()),
                    });
                    continue;
                };
                let current = hash_at(root, &record.path, &absolute).ok();
                match (current, &record.post_hash) {
                    (Some(cur), Some(post)) if &cur == post => {
                        match write_at(
                            root,
                            &record.path,
                            &absolute,
                            pre.as_bytes(),
                            WriteIntent::Upsert,
                            None,
                        ) {
                            Ok(_) => outcomes.push(UndoOutcome {
                                path: record.path.clone(),
                                status: UndoStatus::Reverted,
                                detail: None,
                            }),
                            Err(e) => outcomes.push(UndoOutcome {
                                path: record.path.clone(),
                                status: UndoStatus::Failed,
                                detail: Some(e.to_string()),
                            }),
                        }
                    }
                    (Some(_), _) => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedUserModified,
                        detail: Some("file changed after Capybara modified it".into()),
                    }),
                    (None, _) => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedMissing,
                        detail: None,
                    }),
                }
            }
            FileOperationKind::Delete => {
                let recreated = match path_exists_at(root, &record.path, &absolute) {
                    Ok(exists) => exists,
                    Err(error) => {
                        outcomes.push(UndoOutcome {
                            path: record.path.clone(),
                            status: UndoStatus::Failed,
                            detail: Some(error.to_string()),
                        });
                        continue;
                    }
                };
                if recreated {
                    outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedUserModified,
                        detail: Some("path was recreated after deletion".into()),
                    });
                    continue;
                }
                let Some(pre) = &record.pre_image else {
                    outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedNoPreImage,
                        detail: Some("pre-image not retained".into()),
                    });
                    continue;
                };
                match write_at(
                    root,
                    &record.path,
                    &absolute,
                    pre.as_bytes(),
                    WriteIntent::Create,
                    None,
                ) {
                    Ok(_) => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::Reverted,
                        detail: None,
                    }),
                    Err(e) => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::Failed,
                        detail: Some(e.to_string()),
                    }),
                }
            }
            FileOperationKind::Rename => {
                let Some(new_path) = &record.new_path else {
                    outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::Failed,
                        detail: Some("rename record has no target".into()),
                    });
                    continue;
                };
                let Ok(new_absolute) = resolve(new_path) else {
                    outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::Failed,
                        detail: Some("target could not be resolved".into()),
                    });
                    continue;
                };
                let current = hash_at(root, new_path, &new_absolute).ok();
                match (current, &record.post_hash) {
                    (Some(cur), Some(post)) if &cur == post => {
                        match move_at(root, new_path, &new_absolute, &record.path, &absolute) {
                            Ok(()) => outcomes.push(UndoOutcome {
                                path: record.path.clone(),
                                status: UndoStatus::Reverted,
                                detail: None,
                            }),
                            Err(error) => outcomes.push(UndoOutcome {
                                path: record.path.clone(),
                                status: UndoStatus::Failed,
                                detail: Some(error.to_string()),
                            }),
                        }
                    }
                    _ => outcomes.push(UndoOutcome {
                        path: record.path.clone(),
                        status: UndoStatus::SkippedUserModified,
                        detail: Some("renamed target changed after the agent wrote it".into()),
                    }),
                }
            }
        }
    }
    outcomes
}

/// Apply hunks to original content, returning (new content, additions, deletions).
fn apply_hunks(
    path: &str,
    original: &str,
    hunks: &[Hunk],
) -> Result<(String, usize, usize), TransactionError> {
    let original_lines: Vec<&str> = if original.is_empty() {
        Vec::new()
    } else {
        original.split('\n').collect()
    };
    // A trailing newline yields a final empty element; drop it so line indices
    // line up with the diff's view of the file.
    let original_lines: Vec<&str> = if original.ends_with('\n') && !original_lines.is_empty() {
        original_lines[..original_lines.len() - 1].to_vec()
    } else {
        original_lines
    };

    let mut out: Vec<String> = Vec::new();
    let mut cursor = 0usize; // 0-based index into original_lines
    let mut additions = 0usize;
    let mut deletions = 0usize;

    for (hunk_index, hunk) in hunks.iter().enumerate() {
        let start = hunk.old_start.saturating_sub(1);
        if start < cursor {
            return Err(TransactionError::HunkMismatch {
                path: path.to_string(),
                hunk_index,
                at_line: hunk.old_start,
                expected: "non-overlapping hunks".into(),
                actual: "hunk overlaps a previous hunk".into(),
            });
        }
        if start > original_lines.len() {
            return Err(TransactionError::HunkMismatch {
                path: path.to_string(),
                hunk_index,
                at_line: hunk.old_start,
                expected: format!("file with at least {} lines", hunk.old_start),
                actual: format!("file has {} lines", original_lines.len()),
            });
        }
        // Copy untouched leading lines.
        for line in &original_lines[cursor..start] {
            out.push((*line).to_string());
        }
        cursor = start;

        for line in &hunk.lines {
            match line {
                HunkLine::Context { text } | HunkLine::Removed { text } => {
                    let actual = original_lines.get(cursor).copied().unwrap_or("");
                    if actual != text.as_str() {
                        return Err(TransactionError::HunkMismatch {
                            path: path.to_string(),
                            hunk_index,
                            at_line: cursor + 1,
                            expected: text.clone(),
                            actual: actual.to_string(),
                        });
                    }
                    if matches!(line, HunkLine::Context { .. }) {
                        out.push(text.clone());
                    } else {
                        deletions += 1;
                    }
                    cursor += 1;
                }
                HunkLine::Added { text } => {
                    out.push(text.clone());
                    additions += 1;
                }
            }
        }
    }

    for line in &original_lines[cursor.min(original_lines.len())..] {
        out.push((*line).to_string());
    }

    let mut result = out.join("\n");
    if original.ends_with('\n') || (original.is_empty() && !result.is_empty()) {
        result.push('\n');
    }
    Ok((result, additions, deletions))
}

fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        0
    } else {
        content.lines().count()
    }
}

fn line_delta(before: &str, after: &str) -> (usize, usize) {
    let before_lines: BTreeMap<&str, usize> = before.lines().fold(BTreeMap::new(), |mut acc, l| {
        *acc.entry(l).or_insert(0) += 1;
        acc
    });
    let after_lines: BTreeMap<&str, usize> = after.lines().fold(BTreeMap::new(), |mut acc, l| {
        *acc.entry(l).or_insert(0) += 1;
        acc
    });
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for (line, count) in &after_lines {
        let prev = before_lines.get(line).copied().unwrap_or(0);
        if *count > prev {
            additions += count - prev;
        }
    }
    for (line, count) in &before_lines {
        let next = after_lines.get(line).copied().unwrap_or(0);
        if *count > next {
            deletions += count - next;
        }
    }
    (additions, deletions)
}

/// UTC timestamp in the RFC 3339 form used by every event (§18.15 "timestamps
/// stored as UTC").
pub fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_epoch_millis(now.as_millis() as i64)
}

/// Convert epoch milliseconds to an RFC 3339 UTC timestamp without pulling in a
/// date-time dependency.
pub fn format_epoch_millis(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days` algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
