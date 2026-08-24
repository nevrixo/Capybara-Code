//! Authoritative, side-effect-free edit-plan validation and staging.
//!
//! The TypeScript edit domain offers client-side previews. This module repeats
//! every safety-critical decision in Rust before a runtime transaction can
//! mutate a workspace. It has no filesystem access; callers provide a snapshot
//! and pass the resulting complete file changes to FileTransaction.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Wire schema shared with the TypeScript edit domain.
pub const EDIT_SCHEMA_VERSION: &str = "1.0";
pub const DEFAULT_MAX_OPERATIONS: usize = 100;
pub const DEFAULT_MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_ANCHOR_CANDIDATES: usize = 32;
pub const DEFAULT_ANCHOR_AMBIGUITY_MARGIN: i32 = 5;
pub const DEFAULT_MAX_DIFF_PREVIEW_LINES: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditSource {
    Model,
    Lsp,
    Plugin,
    Merge,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Fail,
    SafeRebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionEncoding {
    Utf8,
    Utf16,
    UnicodeScalar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPosition {
    /// One-based logical line.
    pub line: usize,
    /// One-based unit offset in the selected encoding.
    pub column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start: TextPosition,
    pub end: TextPosition,
    pub encoding: PositionEncoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactTextAnchor {
    pub base_revision: String,
    pub original_text: String,
    pub original_text_digest: String,
    #[serde(default)]
    pub occurrence: Option<usize>,
    #[serde(default)]
    pub expected_range: Option<TextRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhitespacePolicy {
    Exact,
    NormalizeEol,
    NormalizeIndent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAnchor {
    pub base_revision: String,
    pub target_digest: String,
    #[serde(default)]
    pub target_preview: Option<String>,
    #[serde(default)]
    pub before: Vec<String>,
    #[serde(default)]
    pub after: Vec<String>,
    #[serde(default)]
    pub approximate_line: Option<usize>,
    #[serde(default)]
    pub symbol_path: Vec<String>,
    pub whitespace_policy: WhitespacePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolAnchor {
    pub base_revision: String,
    pub language_id: String,
    #[serde(default)]
    pub symbol_path: Vec<String>,
    #[serde(default)]
    pub symbol_kind: Option<String>,
    #[serde(default)]
    pub relative_range: Option<TextRange>,
    #[serde(default)]
    pub symbol_body_digest: Option<String>,
    #[serde(default)]
    pub fallback_context: Option<ContextAnchor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EditAnchor {
    ExactText(ExactTextAnchor),
    Context(ContextAnchor),
    Symbol(SymbolAnchor),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EditOperation {
    ReplaceAnchor {
        operation_id: String,
        path: String,
        anchor: EditAnchor,
        replacement: String,
    },
    ReplaceRange {
        operation_id: String,
        path: String,
        base_revision: String,
        range: TextRange,
        #[serde(default)]
        expected_text_digest: Option<String>,
        replacement: String,
    },
    InsertBefore {
        operation_id: String,
        path: String,
        anchor: EditAnchor,
        text: String,
    },
    InsertAfter {
        operation_id: String,
        path: String,
        anchor: EditAnchor,
        text: String,
    },
    DeleteAnchor {
        operation_id: String,
        path: String,
        anchor: EditAnchor,
    },
    CreateFile {
        operation_id: String,
        path: String,
        content: String,
    },
    MoveFile {
        operation_id: String,
        path: String,
        to_path: String,
        #[serde(default)]
        expected_revision: Option<String>,
    },
    DeleteFile {
        operation_id: String,
        path: String,
        #[serde(default)]
        expected_revision: Option<String>,
    },
}

impl EditOperation {
    pub fn operation_id(&self) -> &str {
        match self {
            Self::ReplaceAnchor { operation_id, .. }
            | Self::ReplaceRange { operation_id, .. }
            | Self::InsertBefore { operation_id, .. }
            | Self::InsertAfter { operation_id, .. }
            | Self::DeleteAnchor { operation_id, .. }
            | Self::CreateFile { operation_id, .. }
            | Self::MoveFile { operation_id, .. }
            | Self::DeleteFile { operation_id, .. } => operation_id,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Self::ReplaceAnchor { path, .. }
            | Self::ReplaceRange { path, .. }
            | Self::InsertBefore { path, .. }
            | Self::InsertAfter { path, .. }
            | Self::DeleteAnchor { path, .. }
            | Self::CreateFile { path, .. }
            | Self::MoveFile { path, .. }
            | Self::DeleteFile { path, .. } => path,
        }
    }

    pub fn is_text_operation(&self) -> bool {
        matches!(
            self,
            Self::ReplaceAnchor { .. }
                | Self::ReplaceRange { .. }
                | Self::InsertBefore { .. }
                | Self::InsertAfter { .. }
                | Self::DeleteAnchor { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPlan {
    pub schema_version: String,
    pub id: String,
    pub source: EditSource,
    pub workspace_identity_digest: String,
    #[serde(default)]
    pub worktree_id: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub base_workspace_revision: Option<String>,
    pub operations: Vec<EditOperation>,
    pub conflict_policy: ConflictPolicy,
    #[serde(default)]
    pub verification_hints: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditableDocument {
    pub path: String,
    pub text: String,
    pub revision: String,
    pub is_binary: bool,
}

impl EditableDocument {
    pub fn text(
        path: impl Into<String>,
        text: impl Into<String>,
        revision: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            text: text.into(),
            revision: revision.into(),
            is_binary: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionMethod {
    Range,
    ExpectedRange,
    ExactText,
    Context,
    SymbolFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionEvidence {
    pub method: ResolutionMethod,
    pub score: i32,
    pub candidate_count: usize,
    pub base_revision: String,
    pub current_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTextEdit {
    pub operation_id: String,
    pub path: String,
    pub byte_range: ByteRange,
    pub replacement: String,
    pub resolution: ResolutionEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedFileKind {
    Modify,
    Create,
    Delete,
    Move,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFileChange {
    pub kind: PreparedFileKind,
    /// Destination path for move operations, otherwise the affected path.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_after: Option<String>,
    /// Full staged UTF-8 text for create, modify, and move operations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub operation_ids: Vec<String>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffPreviewKind {
    Addition,
    Deletion,
    Context,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPreviewLine {
    pub path: String,
    pub kind: DiffPreviewKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditPreflightStatus {
    Previewed,
    NoChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedEditPlan {
    pub status: EditPreflightStatus,
    pub plan_id: String,
    pub plan_digest: String,
    pub resolved_operations: Vec<ResolvedTextEdit>,
    pub files: Vec<PreparedFileChange>,
    pub diff_preview: Vec<DiffPreviewLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightOptions {
    pub max_operations: usize,
    pub max_file_bytes: usize,
    pub max_anchor_candidates: usize,
    pub anchor_ambiguity_margin: i32,
    pub max_diff_preview_lines: usize,
}

impl Default for PreflightOptions {
    fn default() -> Self {
        Self {
            max_operations: DEFAULT_MAX_OPERATIONS,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_anchor_candidates: DEFAULT_MAX_ANCHOR_CANDIDATES,
            anchor_ambiguity_margin: DEFAULT_ANCHOR_AMBIGUITY_MARGIN,
            max_diff_preview_lines: DEFAULT_MAX_DIFF_PREVIEW_LINES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
    RevisionMismatch {
        path: String,
        operation_id: Option<String>,
        message: String,
    },
    AnchorNotFound {
        path: String,
        operation_id: String,
        message: String,
    },
    AnchorAmbiguous {
        path: String,
        operation_id: String,
        message: String,
    },
    RangeInvalid {
        path: Option<String>,
        operation_id: Option<String>,
        message: String,
    },
    EncodingMismatch {
        path: String,
        operation_id: Option<String>,
        message: String,
    },
    Overlap {
        path: String,
        operation_id: String,
        message: String,
    },
    PathConflict {
        path: Option<String>,
        operation_id: Option<String>,
        message: String,
    },
    BinaryUnsupported {
        path: String,
        operation_id: String,
    },
    FileTooLarge {
        path: String,
        bytes: usize,
        maximum: usize,
    },
    TokenInvalid {
        message: String,
    },
    ScopeViolation {
        path: Option<String>,
        operation_id: Option<String>,
        message: String,
    },
}

impl EditError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::RevisionMismatch { .. } => "EDIT_REVISION_MISMATCH",
            Self::AnchorNotFound { .. } => "EDIT_ANCHOR_NOT_FOUND",
            Self::AnchorAmbiguous { .. } => "EDIT_ANCHOR_AMBIGUOUS",
            Self::RangeInvalid { .. } => "EDIT_RANGE_INVALID",
            Self::EncodingMismatch { .. } => "EDIT_ENCODING_MISMATCH",
            Self::Overlap { .. } => "EDIT_OVERLAP",
            Self::PathConflict { .. } => "EDIT_PATH_CONFLICT",
            Self::BinaryUnsupported { .. } => "EDIT_BINARY_UNSUPPORTED",
            Self::FileTooLarge { .. } => "EDIT_FILE_TOO_LARGE",
            Self::TokenInvalid { .. } => "EDIT_TOKEN_INVALID",
            Self::ScopeViolation { .. } => "EDIT_SCOPE_VIOLATION",
        }
    }
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RevisionMismatch { message, .. }
            | Self::AnchorNotFound { message, .. }
            | Self::AnchorAmbiguous { message, .. }
            | Self::RangeInvalid { message, .. }
            | Self::EncodingMismatch { message, .. }
            | Self::Overlap { message, .. }
            | Self::PathConflict { message, .. }
            | Self::TokenInvalid { message }
            | Self::ScopeViolation { message, .. } => write!(f, "{message}"),
            Self::BinaryUnsupported { path, .. } => {
                write!(f, "cannot apply a text edit to binary file '{path}'")
            }
            Self::FileTooLarge {
                path,
                bytes,
                maximum,
            } => write!(
                f,
                "text for '{path}' is {bytes} bytes, above the {maximum} byte limit"
            ),
        }
    }
}

impl std::error::Error for EditError {}

#[derive(Debug, Clone)]
struct WorkingDocument {
    original: Option<EditableDocument>,
    text: String,
}

#[derive(Debug, Clone)]
struct PreparedEntry {
    change: PreparedFileChange,
    before: String,
    after: String,
}

/// Validate an edit plan against an immutable workspace snapshot.
///
/// The result is complete staged content only. Calling this function never
/// reads or writes a filesystem, which lets runtime handlers re-run it directly
/// before staging into a transaction.
pub fn preflight_edit_plan(
    plan: &EditPlan,
    snapshot_workspace_identity_digest: &str,
    documents: &[EditableDocument],
) -> Result<PreparedEditPlan, EditError> {
    preflight_edit_plan_with_options(
        plan,
        snapshot_workspace_identity_digest,
        documents,
        &PreflightOptions::default(),
    )
}

pub fn preflight_edit_plan_with_options(
    plan: &EditPlan,
    snapshot_workspace_identity_digest: &str,
    documents: &[EditableDocument],
    options: &PreflightOptions,
) -> Result<PreparedEditPlan, EditError> {
    validate_plan(plan, snapshot_workspace_identity_digest, options)?;
    let documents = documents_by_path(documents)?;
    validate_operation_paths(&plan.operations)?;
    validate_file_operation_conflicts(&plan.operations)?;

    let resolved_operations = resolve_text_operations(plan, &documents, options)?;
    detect_overlaps(&resolved_operations)?;

    let mut working = documents
        .iter()
        .map(|(path, document)| {
            (
                path.clone(),
                WorkingDocument {
                    original: Some(document.clone()),
                    text: document.text.clone(),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();

    let mut prepared = Vec::new();
    let mut grouped = BTreeMap::<String, Vec<ResolvedTextEdit>>::new();
    for edit in &resolved_operations {
        grouped
            .entry(edit.path.clone())
            .or_default()
            .push(edit.clone());
    }

    for (path, edits) in grouped {
        let current = working.get(&path).ok_or_else(|| EditError::PathConflict {
            path: Some(path.clone()),
            operation_id: None,
            message: format!("text operation targets missing file '{path}'"),
        })?;
        let next_text = apply_resolved_operations(&current.text, &edits)?;
        validate_edit_text(&next_text, &path, options.max_file_bytes)?;
        if next_text != current.text {
            let original = current
                .original
                .as_ref()
                .ok_or_else(|| EditError::PathConflict {
                    path: Some(path.clone()),
                    operation_id: None,
                    message: format!(
                        "text operation targets a file without an original snapshot '{path}'"
                    ),
                })?;
            let operation_ids = edits
                .iter()
                .map(|edit| edit.operation_id.clone())
                .collect::<Vec<_>>();
            prepared.push(PreparedEntry {
                change: PreparedFileChange {
                    kind: PreparedFileKind::Modify,
                    path: path.clone(),
                    previous_path: None,
                    revision_before: Some(original.revision.clone()),
                    revision_after: Some(text_digest(&next_text)),
                    text: Some(next_text.clone()),
                    operation_ids,
                    additions: count_lines(&next_text),
                    deletions: count_lines(&current.text),
                },
                before: current.text.clone(),
                after: next_text.clone(),
            });
            if let Some(document) = working.get_mut(&path) {
                document.text = next_text;
            }
        }
    }

    for operation in &plan.operations {
        match operation {
            EditOperation::CreateFile {
                operation_id,
                path,
                content,
            } => apply_create(
                operation_id,
                path,
                content,
                &mut working,
                &mut prepared,
                options.max_file_bytes,
            )?,
            EditOperation::DeleteFile {
                operation_id,
                path,
                expected_revision,
            } => apply_delete(
                operation_id,
                path,
                expected_revision.as_deref(),
                &mut working,
                &mut prepared,
            )?,
            EditOperation::MoveFile {
                operation_id,
                path,
                to_path,
                expected_revision,
            } => apply_move(
                operation_id,
                path,
                to_path,
                expected_revision.as_deref(),
                &mut working,
                &mut prepared,
            )?,
            _ => {}
        }
    }

    prepared.sort_by(|left, right| left.change.path.cmp(&right.change.path));
    let files = prepared
        .iter()
        .map(|entry| entry.change.clone())
        .collect::<Vec<_>>();
    let status = if files.is_empty() {
        EditPreflightStatus::NoChange
    } else {
        EditPreflightStatus::Previewed
    };

    Ok(PreparedEditPlan {
        status,
        plan_id: plan.id.clone(),
        plan_digest: canonical_plan_digest(plan)?,
        resolved_operations,
        files,
        diff_preview: build_diff_preview(&prepared, options.max_diff_preview_lines),
    })
}

fn validate_plan(
    plan: &EditPlan,
    snapshot_workspace_identity_digest: &str,
    options: &PreflightOptions,
) -> Result<(), EditError> {
    if plan.schema_version != EDIT_SCHEMA_VERSION {
        return Err(EditError::TokenInvalid {
            message: format!("unsupported edit plan schema '{}'", plan.schema_version),
        });
    }
    if !has_prefix(&plan.id, "edp_") {
        return Err(EditError::TokenInvalid {
            message: "edit plan id must use the edp_ prefix".to_owned(),
        });
    }
    require_non_empty(&plan.session_id, "sessionId")?;
    require_non_empty(&plan.workspace_identity_digest, "workspaceIdentityDigest")?;
    require_non_empty(
        snapshot_workspace_identity_digest,
        "snapshot workspaceIdentityDigest",
    )?;
    if plan.workspace_identity_digest != snapshot_workspace_identity_digest {
        return Err(EditError::ScopeViolation {
            path: None,
            operation_id: None,
            message: "edit plan workspace identity does not match the snapshot".to_owned(),
        });
    }
    if !looks_like_iso8601(&plan.created_at) {
        return Err(EditError::TokenInvalid {
            message: "createdAt must be an ISO-8601 timestamp".to_owned(),
        });
    }
    if plan.operations.is_empty() || plan.operations.len() > options.max_operations {
        return Err(EditError::TokenInvalid {
            message: format!(
                "plan must contain between 1 and {} operations",
                options.max_operations
            ),
        });
    }

    let mut operation_ids = BTreeSet::new();
    for operation in &plan.operations {
        if !has_prefix(operation.operation_id(), "edo_") {
            return Err(EditError::TokenInvalid {
                message: "operation ids must use the edo_ prefix".to_owned(),
            });
        }
        if !operation_ids.insert(operation.operation_id().to_owned()) {
            return Err(EditError::PathConflict {
                path: Some(operation.path().to_owned()),
                operation_id: Some(operation.operation_id().to_owned()),
                message: format!("duplicate operation id '{}'", operation.operation_id()),
            });
        }
    }
    Ok(())
}

fn documents_by_path(
    documents: &[EditableDocument],
) -> Result<BTreeMap<String, EditableDocument>, EditError> {
    let mut result = BTreeMap::new();
    for document in documents {
        validate_workspace_path(&document.path, None)?;
        require_non_empty(
            &document.revision,
            &format!("revision for {}", document.path),
        )?;
        if result
            .insert(document.path.clone(), document.clone())
            .is_some()
        {
            return Err(EditError::PathConflict {
                path: Some(document.path.clone()),
                operation_id: None,
                message: format!("snapshot contains duplicate path '{}'", document.path),
            });
        }
    }
    Ok(result)
}

fn validate_operation_paths(operations: &[EditOperation]) -> Result<(), EditError> {
    for operation in operations {
        validate_workspace_path(operation.path(), Some(operation.operation_id()))?;
        if let EditOperation::MoveFile { to_path, .. } = operation {
            validate_workspace_path(to_path, Some(operation.operation_id()))?;
        }
    }
    Ok(())
}

fn validate_workspace_path(path: &str, operation_id: Option<&str>) -> Result<(), EditError> {
    let invalid = path.is_empty()
        || path.contains('\\')
        || path.starts_with('/')
        || path.contains('\0')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || looks_like_windows_absolute(path);
    if invalid {
        return Err(EditError::ScopeViolation {
            path: Some(path.to_owned()),
            operation_id: operation_id.map(str::to_owned),
            message: format!("path '{path}' is not a normalized workspace-relative path"),
        });
    }
    Ok(())
}

fn looks_like_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn validate_file_operation_conflicts(operations: &[EditOperation]) -> Result<(), EditError> {
    let mut text_paths = BTreeSet::new();
    let mut creates = BTreeSet::new();
    let mut deletes = BTreeSet::new();
    let mut move_sources = BTreeSet::new();
    let mut move_destinations = BTreeSet::new();

    for operation in operations {
        match operation {
            EditOperation::ReplaceAnchor { path, .. }
            | EditOperation::ReplaceRange { path, .. }
            | EditOperation::InsertBefore { path, .. }
            | EditOperation::InsertAfter { path, .. }
            | EditOperation::DeleteAnchor { path, .. } => {
                text_paths.insert(path.as_str());
            }
            EditOperation::CreateFile { path, .. } => {
                if !creates.insert(path.as_str()) {
                    return duplicate_path_operation(operation);
                }
            }
            EditOperation::DeleteFile { path, .. } => {
                if !deletes.insert(path.as_str()) {
                    return duplicate_path_operation(operation);
                }
            }
            EditOperation::MoveFile { path, to_path, .. } => {
                if path == to_path
                    || !move_sources.insert(path.as_str())
                    || !move_destinations.insert(to_path.as_str())
                    || move_destinations.contains(path.as_str())
                    || move_sources.contains(to_path.as_str())
                {
                    return duplicate_path_operation(operation);
                }
            }
        }
    }

    for path in &text_paths {
        if creates.contains(path)
            || deletes.contains(path)
            || move_sources.contains(path)
            || move_destinations.contains(path)
        {
            return Err(EditError::PathConflict {
                path: Some((*path).to_owned()),
                operation_id: None,
                message: format!("text and file operations conflict on '{path}'"),
            });
        }
    }
    for path in &creates {
        if deletes.contains(path) || move_sources.contains(path) || move_destinations.contains(path)
        {
            return Err(EditError::PathConflict {
                path: Some((*path).to_owned()),
                operation_id: None,
                message: format!("create conflicts with another file operation on '{path}'"),
            });
        }
    }
    for path in &deletes {
        if move_sources.contains(path) || move_destinations.contains(path) {
            return Err(EditError::PathConflict {
                path: Some((*path).to_owned()),
                operation_id: None,
                message: format!("delete conflicts with move on '{path}'"),
            });
        }
    }
    Ok(())
}

fn duplicate_path_operation(operation: &EditOperation) -> Result<(), EditError> {
    Err(EditError::PathConflict {
        path: Some(operation.path().to_owned()),
        operation_id: Some(operation.operation_id().to_owned()),
        message: format!(
            "duplicate or chained file operation for '{}'",
            operation.path()
        ),
    })
}

#[derive(Debug, Clone, Copy)]
struct AnchorOptions<'a> {
    conflict_policy: ConflictPolicy,
    current_revision: &'a str,
    max_candidates: usize,
    ambiguity_margin: i32,
    path: &'a str,
    operation_id: &'a str,
}

#[derive(Debug, Clone, Copy)]
struct AnchorCandidate {
    range: ByteRange,
    score: i32,
}

fn resolve_text_operations(
    plan: &EditPlan,
    documents: &BTreeMap<String, EditableDocument>,
    options: &PreflightOptions,
) -> Result<Vec<ResolvedTextEdit>, EditError> {
    let mut resolved = Vec::new();
    for operation in &plan.operations {
        if !operation.is_text_operation() {
            continue;
        }
        let path = operation.path();
        let document = documents.get(path).ok_or_else(|| EditError::PathConflict {
            path: Some(path.to_owned()),
            operation_id: Some(operation.operation_id().to_owned()),
            message: format!("text operation targets missing file '{path}'"),
        })?;
        if document.is_binary {
            return Err(EditError::BinaryUnsupported {
                path: path.to_owned(),
                operation_id: operation.operation_id().to_owned(),
            });
        }
        validate_edit_text(&document.text, path, options.max_file_bytes)?;
        let edit = resolve_text_operation(plan, operation, document, options)?;
        validate_edit_text(&edit.replacement, path, options.max_file_bytes)?;
        resolved.push(edit);
    }
    Ok(resolved)
}

fn resolve_text_operation(
    plan: &EditPlan,
    operation: &EditOperation,
    document: &EditableDocument,
    options: &PreflightOptions,
) -> Result<ResolvedTextEdit, EditError> {
    let operation_id = operation.operation_id().to_owned();
    let path = operation.path().to_owned();
    match operation {
        EditOperation::ReplaceRange {
            base_revision,
            range,
            expected_text_digest,
            replacement,
            ..
        } => {
            if !digest_matches(base_revision, &document.revision) {
                return Err(EditError::RevisionMismatch {
                    path,
                    operation_id: Some(operation_id),
                    message: "range edit base revision does not match the current document"
                        .to_owned(),
                });
            }
            let byte_range = range_to_byte_range(
                &document.text,
                range,
                Some(operation.path()),
                Some(operation.operation_id()),
            )?;
            let observed = &document.text[byte_range.start..byte_range.end];
            if let Some(expected) = expected_text_digest {
                if !digest_matches(&text_digest(observed), expected) {
                    return Err(EditError::RevisionMismatch {
                        path,
                        operation_id: Some(operation_id),
                        message: "range text digest does not match the current document".to_owned(),
                    });
                }
            }
            Ok(ResolvedTextEdit {
                operation_id,
                path,
                byte_range,
                replacement: replacement.clone(),
                resolution: ResolutionEvidence {
                    method: ResolutionMethod::Range,
                    score: 160,
                    candidate_count: 1,
                    base_revision: base_revision.clone(),
                    current_revision: document.revision.clone(),
                },
            })
        }
        EditOperation::ReplaceAnchor {
            anchor,
            replacement,
            ..
        } => {
            let resolution = resolve_anchor(
                &document.text,
                anchor,
                AnchorOptions {
                    conflict_policy: plan.conflict_policy,
                    current_revision: &document.revision,
                    max_candidates: options.max_anchor_candidates,
                    ambiguity_margin: options.anchor_ambiguity_margin,
                    path: operation.path(),
                    operation_id: operation.operation_id(),
                },
            )?;
            Ok(ResolvedTextEdit {
                operation_id,
                path,
                byte_range: resolution.range,
                replacement: replacement.clone(),
                resolution: resolution.evidence,
            })
        }
        EditOperation::InsertBefore { anchor, text, .. } => {
            let resolution = resolve_anchor(
                &document.text,
                anchor,
                AnchorOptions {
                    conflict_policy: plan.conflict_policy,
                    current_revision: &document.revision,
                    max_candidates: options.max_anchor_candidates,
                    ambiguity_margin: options.anchor_ambiguity_margin,
                    path: operation.path(),
                    operation_id: operation.operation_id(),
                },
            )?;
            let start = resolution.range.start;
            Ok(ResolvedTextEdit {
                operation_id,
                path,
                byte_range: ByteRange { start, end: start },
                replacement: text.clone(),
                resolution: resolution.evidence,
            })
        }
        EditOperation::InsertAfter { anchor, text, .. } => {
            let resolution = resolve_anchor(
                &document.text,
                anchor,
                AnchorOptions {
                    conflict_policy: plan.conflict_policy,
                    current_revision: &document.revision,
                    max_candidates: options.max_anchor_candidates,
                    ambiguity_margin: options.anchor_ambiguity_margin,
                    path: operation.path(),
                    operation_id: operation.operation_id(),
                },
            )?;
            let end = resolution.range.end;
            Ok(ResolvedTextEdit {
                operation_id,
                path,
                byte_range: ByteRange { start: end, end },
                replacement: text.clone(),
                resolution: resolution.evidence,
            })
        }
        EditOperation::DeleteAnchor { anchor, .. } => {
            let resolution = resolve_anchor(
                &document.text,
                anchor,
                AnchorOptions {
                    conflict_policy: plan.conflict_policy,
                    current_revision: &document.revision,
                    max_candidates: options.max_anchor_candidates,
                    ambiguity_margin: options.anchor_ambiguity_margin,
                    path: operation.path(),
                    operation_id: operation.operation_id(),
                },
            )?;
            Ok(ResolvedTextEdit {
                operation_id,
                path,
                byte_range: resolution.range,
                replacement: String::new(),
                resolution: resolution.evidence,
            })
        }
        _ => unreachable!("non-text operation passed to resolver"),
    }
}

struct AnchorResolution {
    range: ByteRange,
    evidence: ResolutionEvidence,
}

fn resolve_anchor(
    text: &str,
    anchor: &EditAnchor,
    options: AnchorOptions<'_>,
) -> Result<AnchorResolution, EditError> {
    match anchor {
        EditAnchor::ExactText(anchor) => resolve_exact_text_anchor(text, anchor, options),
        EditAnchor::Context(anchor) => resolve_context_anchor(text, anchor, options),
        EditAnchor::Symbol(anchor) => resolve_symbol_anchor(text, anchor, options),
    }
}

fn resolve_exact_text_anchor(
    text: &str,
    anchor: &ExactTextAnchor,
    options: AnchorOptions<'_>,
) -> Result<AnchorResolution, EditError> {
    if anchor.original_text.is_empty() {
        return Err(anchor_not_found(
            options,
            "exact text anchors must not be empty",
        ));
    }
    if !digest_matches(
        &text_digest(&anchor.original_text),
        &anchor.original_text_digest,
    ) {
        return Err(EditError::TokenInvalid {
            message: "exact anchor text does not match its digest".to_owned(),
        });
    }

    let expected = anchor
        .expected_range
        .as_ref()
        .map(|range| {
            range_to_byte_range(text, range, Some(options.path), Some(options.operation_id))
        })
        .transpose()?;
    let revision_matches = digest_matches(&anchor.base_revision, options.current_revision);

    if revision_matches {
        if let Some(expected) = expected {
            if &text[expected.start..expected.end] == anchor.original_text.as_str() {
                return Ok(resolved_anchor(
                    expected,
                    ResolutionMethod::ExpectedRange,
                    160,
                    1,
                    &anchor.base_revision,
                    options.current_revision,
                ));
            }
        }
    } else if options.conflict_policy == ConflictPolicy::Fail {
        return Err(revision_mismatch(
            options,
            "anchor base revision does not match the current document",
        ));
    }

    let candidates = exact_candidates(text, &anchor.original_text, options)?;
    if candidates.is_empty() {
        return Err(anchor_not_found(options, "exact anchor text was not found"));
    }
    if let Some(expected) = expected {
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.range == expected)
        {
            return Ok(resolved_anchor(
                candidate.range,
                ResolutionMethod::ExpectedRange,
                150,
                candidates.len(),
                &anchor.base_revision,
                options.current_revision,
            ));
        }
    }
    if candidates.len() == 1 {
        let candidate = candidates[0];
        return Ok(resolved_anchor(
            candidate.range,
            ResolutionMethod::ExactText,
            candidate.score,
            1,
            &anchor.base_revision,
            options.current_revision,
        ));
    }

    let occurrence_hint = anchor
        .occurrence
        .map(|value| format!(" (occurrence hint {value})"))
        .unwrap_or_default();
    Err(anchor_ambiguous(
        options,
        format!(
            "exact anchor has {} candidates{occurrence_hint}",
            candidates.len()
        ),
    ))
}

fn resolve_context_anchor(
    text: &str,
    anchor: &ContextAnchor,
    options: AnchorOptions<'_>,
) -> Result<AnchorResolution, EditError> {
    let target = anchor
        .target_preview
        .as_deref()
        .filter(|target| !target.is_empty())
        .ok_or_else(|| {
            anchor_not_found(
                options,
                "context anchor requires a bounded full targetPreview in the initial rollout",
            )
        })?;
    if !digest_matches(&text_digest(target), &anchor.target_digest) {
        return Err(EditError::TokenInvalid {
            message: "context targetPreview does not match targetDigest".to_owned(),
        });
    }
    if !digest_matches(&anchor.base_revision, options.current_revision)
        && options.conflict_policy == ConflictPolicy::Fail
    {
        return Err(revision_mismatch(
            options,
            "anchor base revision does not match the current document",
        ));
    }

    let lines = logical_lines(text);
    let mut candidates = exact_candidates(text, target, options)?;
    if candidates.is_empty() {
        return Err(anchor_not_found(
            options,
            "context anchor target was not found",
        ));
    }
    for candidate in &mut candidates {
        candidate.score = score_context_candidate(text, &lines, candidate.range, anchor);
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.range.start.cmp(&right.range.start))
    });

    let best = candidates[0];
    if let Some(second) = candidates.get(1) {
        if best.score - second.score < options.ambiguity_margin {
            return Err(anchor_ambiguous(
                options,
                format!(
                    "context anchor candidates are too close ({} vs {})",
                    best.score, second.score
                ),
            ));
        }
    }
    Ok(resolved_anchor(
        best.range,
        ResolutionMethod::Context,
        best.score,
        candidates.len(),
        &anchor.base_revision,
        options.current_revision,
    ))
}

fn resolve_symbol_anchor(
    text: &str,
    anchor: &SymbolAnchor,
    options: AnchorOptions<'_>,
) -> Result<AnchorResolution, EditError> {
    let fallback = anchor
        .fallback_context
        .as_ref()
        .ok_or_else(|| EditError::TokenInvalid {
            message: "symbol anchors require a trusted local range receipt or a context fallback"
                .to_owned(),
        })?;
    let mut resolution = resolve_context_anchor(text, fallback, options)?;
    resolution.evidence.method = ResolutionMethod::SymbolFallback;
    Ok(resolution)
}

fn exact_candidates(
    text: &str,
    target: &str,
    options: AnchorOptions<'_>,
) -> Result<Vec<AnchorCandidate>, EditError> {
    let maximum = options.max_candidates.max(1);
    let positions = find_occurrences(text, target, maximum.saturating_add(1));
    if positions.len() > maximum {
        return Err(anchor_ambiguous(
            options,
            format!("anchor exceeds {maximum} candidate search bound"),
        ));
    }
    Ok(positions
        .into_iter()
        .map(|start| AnchorCandidate {
            range: ByteRange {
                start,
                end: start + target.len(),
            },
            score: 100,
        })
        .collect())
}

fn find_occurrences(text: &str, target: &str, maximum: usize) -> Vec<usize> {
    if target.is_empty() || maximum == 0 {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut from = 0;
    while from <= text.len() {
        let Some(relative) = text[from..].find(target) else {
            break;
        };
        let start = from + relative;
        result.push(start);
        if result.len() >= maximum {
            break;
        }
        let width = text[start..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
        from = start.saturating_add(width);
    }
    result
}

#[derive(Debug, Clone, Copy)]
struct LogicalLine {
    start: usize,
    end: usize,
}

fn logical_lines(text: &str) -> Vec<LogicalLine> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' || bytes[index] == b'\n' {
            lines.push(LogicalLine { start, end: index });
            index += if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                2
            } else {
                1
            };
            start = index;
        } else {
            index += 1;
        }
    }
    lines.push(LogicalLine {
        start,
        end: text.len(),
    });
    lines
}

fn range_to_byte_range(
    text: &str,
    range: &TextRange,
    path: Option<&str>,
    operation_id: Option<&str>,
) -> Result<ByteRange, EditError> {
    let start = position_to_byte_offset(text, range.start, range.encoding, path, operation_id)?;
    let end = position_to_byte_offset(text, range.end, range.encoding, path, operation_id)?;
    if end < start {
        return Err(EditError::RangeInvalid {
            path: path.map(str::to_owned),
            operation_id: operation_id.map(str::to_owned),
            message: "range end precedes its start".to_owned(),
        });
    }
    Ok(ByteRange { start, end })
}

fn position_to_byte_offset(
    text: &str,
    position: TextPosition,
    encoding: PositionEncoding,
    path: Option<&str>,
    operation_id: Option<&str>,
) -> Result<usize, EditError> {
    if position.line == 0 {
        return Err(EditError::RangeInvalid {
            path: path.map(str::to_owned),
            operation_id: operation_id.map(str::to_owned),
            message: "line must be a positive integer".to_owned(),
        });
    }
    if position.column == 0 {
        return Err(EditError::RangeInvalid {
            path: path.map(str::to_owned),
            operation_id: operation_id.map(str::to_owned),
            message: "column must be a positive integer".to_owned(),
        });
    }
    let line = logical_lines(text)
        .get(position.line - 1)
        .copied()
        .ok_or_else(|| EditError::RangeInvalid {
            path: path.map(str::to_owned),
            operation_id: operation_id.map(str::to_owned),
            message: "line is outside the document".to_owned(),
        })?;
    let target_units = position.column - 1;
    let mut units = 0;
    for (relative, scalar) in text[line.start..line.end].char_indices() {
        if units == target_units {
            return Ok(line.start + relative);
        }
        let width = match encoding {
            PositionEncoding::Utf8 => scalar.len_utf8(),
            PositionEncoding::Utf16 => scalar.len_utf16(),
            PositionEncoding::UnicodeScalar => 1,
        };
        if units + width > target_units {
            return Err(EditError::EncodingMismatch {
                path: path.unwrap_or("<unknown>").to_owned(),
                operation_id: operation_id.map(str::to_owned),
                message: format!(
                    "column lands inside a {} encoded Unicode scalar",
                    position_encoding_name(encoding)
                ),
            });
        }
        units += width;
    }
    if units == target_units {
        Ok(line.end)
    } else {
        Err(EditError::RangeInvalid {
            path: path.map(str::to_owned),
            operation_id: operation_id.map(str::to_owned),
            message: "column is outside the logical line".to_owned(),
        })
    }
}

fn position_encoding_name(encoding: PositionEncoding) -> &'static str {
    match encoding {
        PositionEncoding::Utf8 => "utf8",
        PositionEncoding::Utf16 => "utf16",
        PositionEncoding::UnicodeScalar => "unicode_scalar",
    }
}

fn score_context_candidate(
    text: &str,
    lines: &[LogicalLine],
    range: ByteRange,
    anchor: &ContextAnchor,
) -> i32 {
    let mut score = 100;
    let start_line = line_index_at_byte_offset(text, lines, range.start);
    let end_line = line_index_at_byte_offset(text, lines, range.end);
    if context_matches(
        text,
        lines,
        start_line.checked_sub(anchor.before.len()),
        &anchor.before,
        anchor.whitespace_policy,
    ) {
        score += 30;
    }
    if context_matches(
        text,
        lines,
        end_line.checked_add(1),
        &anchor.after,
        anchor.whitespace_policy,
    ) {
        score += 30;
    }
    if let Some(approximate_line) = anchor.approximate_line {
        let distance = (start_line + 1).abs_diff(approximate_line);
        if distance <= 5 {
            score += 15;
        } else if distance <= 20 {
            score += 8;
        }
    }
    if anchor.whitespace_policy == WhitespacePolicy::NormalizeIndent {
        score += 5;
    }
    score
}

fn line_index_at_byte_offset(text: &str, lines: &[LogicalLine], offset: usize) -> usize {
    debug_assert!(offset <= text.len());
    lines
        .iter()
        .rposition(|line| offset >= line.start)
        .unwrap_or(0)
}

fn context_matches(
    text: &str,
    lines: &[LogicalLine],
    start: Option<usize>,
    expected: &[String],
    policy: WhitespacePolicy,
) -> bool {
    if expected.is_empty() {
        return false;
    }
    let Some(start) = start else {
        return false;
    };
    let Some(end) = start.checked_add(expected.len()) else {
        return false;
    };
    if end > lines.len() {
        return false;
    }
    expected.iter().enumerate().all(|(index, value)| {
        let line = lines[start + index];
        normalize_context(&text[line.start..line.end], policy) == normalize_context(value, policy)
    })
}

fn normalize_context(value: &str, policy: WhitespacePolicy) -> String {
    match policy {
        WhitespacePolicy::Exact => value.to_owned(),
        WhitespacePolicy::NormalizeEol => value.replace("\r\n", "\n").replace('\r', "\n"),
        WhitespacePolicy::NormalizeIndent => value
            .trim_start_matches(char::is_whitespace)
            .replace("\r\n", "\n")
            .replace('\r', "\n"),
    }
}

fn resolved_anchor(
    range: ByteRange,
    method: ResolutionMethod,
    score: i32,
    candidate_count: usize,
    base_revision: &str,
    current_revision: &str,
) -> AnchorResolution {
    AnchorResolution {
        range,
        evidence: ResolutionEvidence {
            method,
            score,
            candidate_count,
            base_revision: base_revision.to_owned(),
            current_revision: current_revision.to_owned(),
        },
    }
}

fn anchor_not_found(options: AnchorOptions<'_>, message: impl Into<String>) -> EditError {
    EditError::AnchorNotFound {
        path: options.path.to_owned(),
        operation_id: options.operation_id.to_owned(),
        message: message.into(),
    }
}

fn anchor_ambiguous(options: AnchorOptions<'_>, message: impl Into<String>) -> EditError {
    EditError::AnchorAmbiguous {
        path: options.path.to_owned(),
        operation_id: options.operation_id.to_owned(),
        message: message.into(),
    }
}

fn revision_mismatch(options: AnchorOptions<'_>, message: impl Into<String>) -> EditError {
    EditError::RevisionMismatch {
        path: options.path.to_owned(),
        operation_id: Some(options.operation_id.to_owned()),
        message: message.into(),
    }
}

fn detect_overlaps(edits: &[ResolvedTextEdit]) -> Result<(), EditError> {
    let mut grouped = BTreeMap::<&str, Vec<&ResolvedTextEdit>>::new();
    for edit in edits {
        grouped.entry(&edit.path).or_default().push(edit);
    }
    for (path, mut group) in grouped {
        group.sort_by(|left, right| {
            left.byte_range
                .start
                .cmp(&right.byte_range.start)
                .then_with(|| left.byte_range.end.cmp(&right.byte_range.end))
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });
        for pair in group.windows(2) {
            let left = pair[0];
            let right = pair[1];
            if ranges_conflict(left.byte_range, right.byte_range) {
                return Err(EditError::Overlap {
                    path: path.to_owned(),
                    operation_id: right.operation_id.clone(),
                    message: format!(
                        "operations '{}' and '{}' overlap",
                        left.operation_id, right.operation_id
                    ),
                });
            }
        }
    }
    Ok(())
}

fn ranges_conflict(left: ByteRange, right: ByteRange) -> bool {
    let left_point = left.start == left.end;
    let right_point = right.start == right.end;
    if left_point && right_point {
        return false;
    }
    if left_point {
        return right.start < left.start && left.start < right.end;
    }
    if right_point {
        return left.start < right.start && right.start < left.end;
    }
    left.start.max(right.start) < left.end.min(right.end)
}

fn apply_resolved_operations(text: &str, edits: &[ResolvedTextEdit]) -> Result<String, EditError> {
    let mut sorted = edits.to_vec();
    sorted.sort_by(|left, right| {
        right
            .byte_range
            .start
            .cmp(&left.byte_range.start)
            .then_with(|| right.byte_range.end.cmp(&left.byte_range.end))
            .then_with(|| right.operation_id.cmp(&left.operation_id))
    });
    let mut next = text.to_owned();
    for edit in sorted {
        let range = edit.byte_range;
        if range.start > range.end
            || range.end > next.len()
            || !next.is_char_boundary(range.start)
            || !next.is_char_boundary(range.end)
        {
            return Err(EditError::RangeInvalid {
                path: Some(edit.path),
                operation_id: Some(edit.operation_id),
                message: "resolved byte range is outside a Unicode boundary".to_owned(),
            });
        }
        next.replace_range(range.start..range.end, &edit.replacement);
    }
    Ok(next)
}

fn apply_create(
    operation_id: &str,
    path: &str,
    content: &str,
    working: &mut BTreeMap<String, WorkingDocument>,
    prepared: &mut Vec<PreparedEntry>,
    max_file_bytes: usize,
) -> Result<(), EditError> {
    if working.contains_key(path) {
        return Err(EditError::PathConflict {
            path: Some(path.to_owned()),
            operation_id: Some(operation_id.to_owned()),
            message: format!("create destination '{path}' already exists"),
        });
    }
    validate_edit_text(content, path, max_file_bytes)?;
    let revision_after = text_digest(content);
    prepared.push(PreparedEntry {
        change: PreparedFileChange {
            kind: PreparedFileKind::Create,
            path: path.to_owned(),
            previous_path: None,
            revision_before: None,
            revision_after: Some(revision_after.clone()),
            text: Some(content.to_owned()),
            operation_ids: vec![operation_id.to_owned()],
            additions: count_lines(content),
            deletions: 0,
        },
        before: String::new(),
        after: content.to_owned(),
    });
    working.insert(
        path.to_owned(),
        WorkingDocument {
            original: None,
            text: content.to_owned(),
        },
    );
    Ok(())
}

fn apply_delete(
    operation_id: &str,
    path: &str,
    expected_revision: Option<&str>,
    working: &mut BTreeMap<String, WorkingDocument>,
    prepared: &mut Vec<PreparedEntry>,
) -> Result<(), EditError> {
    let current = working
        .get(path)
        .cloned()
        .ok_or_else(|| EditError::PathConflict {
            path: Some(path.to_owned()),
            operation_id: Some(operation_id.to_owned()),
            message: format!("delete target '{path}' does not exist"),
        })?;
    let revision_before = current
        .original
        .as_ref()
        .map(|document| document.revision.clone())
        .unwrap_or_else(|| text_digest(&current.text));
    if let Some(expected) = expected_revision {
        if !digest_matches(&revision_before, expected) {
            return Err(EditError::RevisionMismatch {
                path: path.to_owned(),
                operation_id: Some(operation_id.to_owned()),
                message: "delete base revision does not match the current document".to_owned(),
            });
        }
    }
    prepared.push(PreparedEntry {
        change: PreparedFileChange {
            kind: PreparedFileKind::Delete,
            path: path.to_owned(),
            previous_path: None,
            revision_before: Some(revision_before),
            revision_after: None,
            text: None,
            operation_ids: vec![operation_id.to_owned()],
            additions: 0,
            deletions: count_lines(&current.text),
        },
        before: current.text,
        after: String::new(),
    });
    working.remove(path);
    Ok(())
}

fn apply_move(
    operation_id: &str,
    path: &str,
    to_path: &str,
    expected_revision: Option<&str>,
    working: &mut BTreeMap<String, WorkingDocument>,
    prepared: &mut Vec<PreparedEntry>,
) -> Result<(), EditError> {
    if working.contains_key(to_path) {
        return Err(EditError::PathConflict {
            path: Some(path.to_owned()),
            operation_id: Some(operation_id.to_owned()),
            message: "move source must exist and destination must not exist".to_owned(),
        });
    }
    let current = working
        .remove(path)
        .ok_or_else(|| EditError::PathConflict {
            path: Some(path.to_owned()),
            operation_id: Some(operation_id.to_owned()),
            message: "move source must exist and destination must not exist".to_owned(),
        })?;
    let revision_before = current
        .original
        .as_ref()
        .map(|document| document.revision.clone())
        .unwrap_or_else(|| text_digest(&current.text));
    if let Some(expected) = expected_revision {
        if !digest_matches(&revision_before, expected) {
            working.insert(path.to_owned(), current);
            return Err(EditError::RevisionMismatch {
                path: path.to_owned(),
                operation_id: Some(operation_id.to_owned()),
                message: "move base revision does not match the current document".to_owned(),
            });
        }
    }
    let text = current.text.clone();
    prepared.push(PreparedEntry {
        change: PreparedFileChange {
            kind: PreparedFileKind::Move,
            path: to_path.to_owned(),
            previous_path: Some(path.to_owned()),
            revision_before: Some(revision_before.clone()),
            revision_after: Some(revision_before),
            text: Some(text.clone()),
            operation_ids: vec![operation_id.to_owned()],
            additions: 0,
            deletions: 0,
        },
        before: text.clone(),
        after: text,
    });
    working.insert(
        to_path.to_owned(),
        WorkingDocument {
            original: current.original,
            text: current.text,
        },
    );
    Ok(())
}

fn validate_edit_text(text: &str, path: &str, maximum: usize) -> Result<(), EditError> {
    let bytes = text.len();
    if bytes > maximum {
        return Err(EditError::FileTooLarge {
            path: path.to_owned(),
            bytes,
            maximum,
        });
    }
    Ok(())
}

/// SHA-256 over exact UTF-8 text. Prefixing makes this distinguishable from
/// the legacy bare content hashes returned by cbc-fs.
pub fn text_digest(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}

fn digest_matches(actual: &str, expected: &str) -> bool {
    let actual = strip_sha256_prefix(actual);
    let expected = strip_sha256_prefix(expected);
    cbc_fs::hashes_match(actual, expected)
}

fn strip_sha256_prefix(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 7 && value[..7].eq_ignore_ascii_case("sha256:") {
        &value[7..]
    } else {
        value
    }
}

fn has_prefix(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix) && value.len() > prefix.len()
}

fn require_non_empty(value: &str, field: &str) -> Result<(), EditError> {
    if value.trim().is_empty() {
        return Err(EditError::TokenInvalid {
            message: format!("{field} must not be empty"),
        });
    }
    Ok(())
}

fn looks_like_iso8601(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.contains('T')
        && (value.ends_with('Z')
            || value
                .as_bytes()
                .iter()
                .enumerate()
                .skip(value.find('T').unwrap_or(0))
                .any(|(_, byte)| *byte == b'+'))
}

fn canonical_plan_digest(plan: &EditPlan) -> Result<String, EditError> {
    let value = serde_json::to_value(plan).map_err(|error| EditError::TokenInvalid {
        message: format!("edit plan cannot be serialized: {error}"),
    })?;
    let canonical = canonicalize_json(value);
    let json = serde_json::to_string(&canonical).map_err(|error| EditError::TokenInvalid {
        message: format!("edit plan cannot be canonicalized: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(json.as_bytes())))
}

fn canonicalize_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(canonicalize_json)
                .collect::<Vec<_>>(),
        ),
        serde_json::Value::Object(values) => {
            let mut sorted = BTreeMap::new();
            for (key, value) in values {
                sorted.insert(key, canonicalize_json(value));
            }
            let mut object = serde_json::Map::new();
            for (key, value) in sorted {
                object.insert(key, value);
            }
            serde_json::Value::Object(object)
        }
        scalar => scalar,
    }
}

fn build_diff_preview(entries: &[PreparedEntry], maximum: usize) -> Vec<DiffPreviewLine> {
    let mut preview = Vec::new();
    for entry in entries {
        if entry.before == entry.after {
            continue;
        }
        let before = split_for_diff(&entry.before);
        let after = split_for_diff(&entry.after);
        let mut prefix = 0;
        while prefix < before.len() && prefix < after.len() && before[prefix] == after[prefix] {
            prefix += 1;
        }
        let mut suffix = 0;
        while suffix < before.len().saturating_sub(prefix)
            && suffix < after.len().saturating_sub(prefix)
            && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
        {
            suffix += 1;
        }
        for line in &before[prefix..before.len() - suffix] {
            if preview.len() >= maximum {
                return preview;
            }
            preview.push(DiffPreviewLine {
                path: entry.change.path.clone(),
                kind: DiffPreviewKind::Deletion,
                text: line.clone(),
            });
        }
        for line in &after[prefix..after.len() - suffix] {
            if preview.len() >= maximum {
                return preview;
            }
            preview.push(DiffPreviewLine {
                path: entry.change.path.clone(),
                kind: DiffPreviewKind::Addition,
                text: line.clone(),
            });
        }
    }
    preview
}

fn split_for_diff(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(str::to_owned)
        .collect()
}

fn count_lines(text: &str) -> usize {
    split_for_diff(text).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(operations: Vec<EditOperation>) -> EditPlan {
        EditPlan {
            schema_version: EDIT_SCHEMA_VERSION.to_owned(),
            id: "edp_test".to_owned(),
            source: EditSource::User,
            workspace_identity_digest: "workspace-identity".to_owned(),
            worktree_id: None,
            session_id: "ses_test".to_owned(),
            turn_id: None,
            agent_id: None,
            base_workspace_revision: None,
            operations,
            conflict_policy: ConflictPolicy::SafeRebase,
            verification_hints: Vec::new(),
            created_at: "2026-08-24T00:00:00Z".to_owned(),
        }
    }

    fn document(text: &str, revision: &str) -> EditableDocument {
        EditableDocument::text("src/example.ts", text, revision)
    }

    fn range(
        start_line: usize,
        start_column: usize,
        end_line: usize,
        end_column: usize,
    ) -> TextRange {
        TextRange {
            start: TextPosition {
                line: start_line,
                column: start_column,
            },
            end: TextPosition {
                line: end_line,
                column: end_column,
            },
            encoding: PositionEncoding::Utf16,
        }
    }

    #[test]
    fn converts_crlf_utf16_ranges_without_splitting_surrogates() {
        let text = "a😀\r\nbeta";
        let first = range_to_byte_range(
            text,
            &range(1, 2, 1, 4),
            Some("src/example.ts"),
            Some("edo_test"),
        )
        .expect("emoji range should resolve");
        assert_eq!(&text[first.start..first.end], "😀");

        let error = range_to_byte_range(
            text,
            &range(1, 3, 1, 4),
            Some("src/example.ts"),
            Some("edo_test"),
        )
        .expect_err("a UTF-16 midpoint must fail");
        assert_eq!(error.code(), "EDIT_ENCODING_MISMATCH");
    }

    #[test]
    fn safely_rebases_a_unique_exact_anchor() {
        let original = "const target = 1;";
        let plan = plan(vec![EditOperation::ReplaceAnchor {
            operation_id: "edo_replace".to_owned(),
            path: "src/example.ts".to_owned(),
            anchor: EditAnchor::ExactText(ExactTextAnchor {
                base_revision: "old".to_owned(),
                original_text: "target".to_owned(),
                original_text_digest: text_digest("target"),
                occurrence: None,
                expected_range: None,
            }),
            replacement: "value".to_owned(),
        }]);
        let prepared =
            preflight_edit_plan(&plan, "workspace-identity", &[document(original, "new")])
                .expect("unique content can safely rebase");
        assert_eq!(prepared.files.len(), 1);
        assert_eq!(prepared.files[0].text.as_deref(), Some("const value = 1;"));
        assert_eq!(
            prepared.resolved_operations[0].resolution.method,
            ResolutionMethod::ExactText
        );
    }

    #[test]
    fn rejects_duplicate_exact_anchor_without_independent_evidence() {
        let plan = plan(vec![EditOperation::DeleteAnchor {
            operation_id: "edo_delete".to_owned(),
            path: "src/example.ts".to_owned(),
            anchor: EditAnchor::ExactText(ExactTextAnchor {
                base_revision: "old".to_owned(),
                original_text: "same".to_owned(),
                original_text_digest: text_digest("same"),
                occurrence: Some(1),
                expected_range: None,
            }),
        }]);
        let error = preflight_edit_plan(
            &plan,
            "workspace-identity",
            &[document("same\nsame", "new")],
        )
        .expect_err("an occurrence hint is not authorization");
        assert_eq!(error.code(), "EDIT_ANCHOR_AMBIGUOUS");
    }

    #[test]
    fn rejects_overlapping_resolved_edits() {
        let plan = plan(vec![
            EditOperation::ReplaceRange {
                operation_id: "edo_first".to_owned(),
                path: "src/example.ts".to_owned(),
                base_revision: "rev".to_owned(),
                range: range(1, 1, 1, 4),
                expected_text_digest: None,
                replacement: "one".to_owned(),
            },
            EditOperation::ReplaceRange {
                operation_id: "edo_second".to_owned(),
                path: "src/example.ts".to_owned(),
                base_revision: "rev".to_owned(),
                range: range(1, 3, 1, 5),
                expected_text_digest: None,
                replacement: "two".to_owned(),
            },
        ]);
        let error = preflight_edit_plan(&plan, "workspace-identity", &[document("abcdef", "rev")])
            .expect_err("overlapping edits must not stage");
        assert_eq!(error.code(), "EDIT_OVERLAP");
    }

    #[test]
    fn preserves_deterministic_same_offset_insert_order() {
        let anchor = EditAnchor::ExactText(ExactTextAnchor {
            base_revision: "rev".to_owned(),
            original_text: "x".to_owned(),
            original_text_digest: text_digest("x"),
            occurrence: None,
            expected_range: None,
        });
        let plan = plan(vec![
            EditOperation::InsertBefore {
                operation_id: "edo_a".to_owned(),
                path: "src/example.ts".to_owned(),
                anchor: anchor.clone(),
                text: "A".to_owned(),
            },
            EditOperation::InsertBefore {
                operation_id: "edo_b".to_owned(),
                path: "src/example.ts".to_owned(),
                anchor,
                text: "B".to_owned(),
            },
        ]);
        let prepared = preflight_edit_plan(&plan, "workspace-identity", &[document("x", "rev")])
            .expect("point inserts are safe");
        assert_eq!(prepared.files[0].text.as_deref(), Some("ABx"));
    }

    #[test]
    fn rejects_chained_moves_before_staging() {
        let plan = plan(vec![
            EditOperation::MoveFile {
                operation_id: "edo_first".to_owned(),
                path: "src/example.ts".to_owned(),
                to_path: "src/first.ts".to_owned(),
                expected_revision: None,
            },
            EditOperation::MoveFile {
                operation_id: "edo_second".to_owned(),
                path: "src/first.ts".to_owned(),
                to_path: "src/second.ts".to_owned(),
                expected_revision: None,
            },
        ]);
        let error = preflight_edit_plan(&plan, "workspace-identity", &[document("x", "rev")])
            .expect_err("chained moves are ambiguous in one plan");
        assert_eq!(error.code(), "EDIT_PATH_CONFLICT");
    }

    #[test]
    fn requires_an_exact_workspace_identity_match() {
        let mut plan = plan(vec![EditOperation::CreateFile {
            operation_id: "edo_create".to_owned(),
            path: "new.txt".to_owned(),
            content: "new".to_owned(),
        }]);
        // Content revisions may accept an intentional short hash, but workspace
        // identities are authority boundaries and must never use that rule.
        plan.workspace_identity_digest = "ws_1234".to_owned();
        let error = preflight_edit_plan(&plan, "ws_1234_actual", &[])
            .expect_err("a workspace-id prefix must not authorize a different workspace");
        assert_eq!(error.code(), "EDIT_SCOPE_VIOLATION");
    }

    #[test]
    fn deserializes_the_typescript_wire_shape() {
        let source = serde_json::json!({
            "schemaVersion": "1.0",
            "id": "edp_wire",
            "source": "lsp",
            "workspaceIdentityDigest": "workspace-identity",
            "sessionId": "ses_wire",
            "operations": [{
                "kind": "replace_range",
                "operationId": "edo_wire",
                "path": "src/example.ts",
                "baseRevision": "rev",
                "range": {
                    "start": {"line": 1, "column": 1},
                    "end": {"line": 1, "column": 2},
                    "encoding": "utf16"
                },
                "replacement": "y"
            }],
            "conflictPolicy": "fail",
            "createdAt": "2026-08-24T00:00:00Z"
        });
        let parsed: EditPlan =
            serde_json::from_value(source).expect("wire shape should deserialize");
        let prepared = preflight_edit_plan(&parsed, "workspace-identity", &[document("x", "rev")])
            .expect("wire plan should preflight");
        assert_eq!(prepared.files[0].text.as_deref(), Some("y"));
    }
}
