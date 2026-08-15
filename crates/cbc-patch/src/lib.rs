//! `cbc-patch` — structured patch parsing and crash-safe file mutation
//! transactions.
//!
//! PRD references: §12.5 (patch semantics), §12.6 (write semantics), §14.3
//! (atomic operations), §18.15 (`transactions` / `file_operations` tables),
//! AC-13, AC-14, AC-15, TOOL-001.

pub mod diff;
pub mod transaction;

pub use diff::{
    parse_unified_diff, FileOperationKind, FilePatch, Hunk, HunkLine, Patch, PatchParseError,
};
pub use transaction::{
    format_epoch_millis, now_iso8601, undo_records, Checkpoint, CheckpointRollback,
    FileOperationRecord, FileTransaction, StagedPreImage, TransactionError, TransactionState,
    UndoOutcome, UndoStatus,
};
