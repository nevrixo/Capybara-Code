//! `cbc-patch` — structured patch parsing and crash-safe file mutation
//! transactions.
//!
//! PRD references: §12.5 (patch semantics), §12.6 (write semantics), §14.3
//! (atomic operations), §18.15 (`transactions` / `file_operations` tables),
//! AC-13, AC-14, AC-15, TOOL-001.

pub mod diff;
pub mod edit;
pub mod transaction;

pub use diff::{
    parse_unified_diff, FileOperationKind, FilePatch, Hunk, HunkLine, Patch, PatchParseError,
};
pub use edit::{
    preflight_edit_plan, preflight_edit_plan_with_options, ByteRange, ConflictPolicy,
    ContextAnchor, DiffPreviewKind, DiffPreviewLine, EditAnchor, EditError, EditOperation,
    EditPlan, EditPreflightStatus, EditSource, EditableDocument, ExactTextAnchor, PositionEncoding,
    PreflightOptions, PreparedEditPlan, PreparedFileChange, PreparedFileKind, ResolutionEvidence,
    ResolutionMethod, ResolvedTextEdit, SymbolAnchor, TextPosition, TextRange, WhitespacePolicy,
};
pub use transaction::{
    format_epoch_millis, now_iso8601, undo_records, Checkpoint, CheckpointRollback,
    FileOperationRecord, FileTransaction, StagedPreImage, TransactionError, TransactionState,
    UndoOutcome, UndoStatus,
};
