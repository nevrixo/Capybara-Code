export const EDIT_SCHEMA_VERSION = "1.0" as const;

export type EditPlanId = `edp_${string}`;
export type EditOperationId = `edo_${string}`;
export type EditReceiptId = `edr_${string}`;

export type EditSource = "model" | "lsp" | "plugin" | "merge" | "user";
export type ConflictPolicy = "fail" | "safe_rebase";
export type PositionEncoding = "utf8" | "utf16" | "unicode_scalar";

/** One-based, logical-line position. `column` is counted in `encoding` units. */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

/** End positions are exclusive. Rust converts this representation to UTF-8 bytes. */
export interface TextRange {
  readonly start: TextPosition;
  readonly end: TextPosition;
  readonly encoding: PositionEncoding;
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface ExactTextAnchor {
  readonly kind: "exact_text";
  readonly baseRevision: string;
  readonly originalText: string;
  readonly originalTextDigest: string;
  /** Zero-based hint only; it cannot resolve an otherwise ambiguous target. */
  readonly occurrence?: number;
  readonly expectedRange?: TextRange;
}

export interface ContextAnchor {
  readonly kind: "context";
  readonly baseRevision: string;
  readonly targetDigest: string;
  /** The bounded full target used to calculate targetDigest in the initial rollout. */
  readonly targetPreview?: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly approximateLine?: number;
  readonly symbolPath?: readonly string[];
  readonly whitespacePolicy: "exact" | "normalize_eol" | "normalize_indent";
}

export interface SymbolAnchor {
  readonly kind: "symbol";
  readonly baseRevision: string;
  readonly languageId: string;
  readonly symbolPath: readonly string[];
  readonly symbolKind?: string;
  readonly relativeRange?: TextRange;
  readonly symbolBodyDigest?: string;
  readonly fallbackContext?: ContextAnchor;
}

export type EditAnchor = ExactTextAnchor | ContextAnchor | SymbolAnchor;

interface TextOperationBase {
  readonly operationId: EditOperationId;
  readonly path: string;
}

export interface ReplaceAnchorOperation extends TextOperationBase {
  readonly kind: "replace_anchor";
  readonly anchor: EditAnchor;
  readonly replacement: string;
}

export interface ReplaceRangeOperation extends TextOperationBase {
  readonly kind: "replace_range";
  readonly baseRevision: string;
  readonly range: TextRange;
  readonly expectedTextDigest?: string;
  readonly replacement: string;
}

export interface InsertBeforeOperation extends TextOperationBase {
  readonly kind: "insert_before";
  readonly anchor: EditAnchor;
  readonly text: string;
}

export interface InsertAfterOperation extends TextOperationBase {
  readonly kind: "insert_after";
  readonly anchor: EditAnchor;
  readonly text: string;
}

export interface DeleteAnchorOperation extends TextOperationBase {
  readonly kind: "delete_anchor";
  readonly anchor: EditAnchor;
}

export interface CreateFileOperation extends TextOperationBase {
  readonly kind: "create_file";
  readonly content: string;
}

export interface MoveFileOperation extends TextOperationBase {
  readonly kind: "move_file";
  readonly toPath: string;
  readonly expectedRevision?: string;
}

export interface DeleteFileOperation extends TextOperationBase {
  readonly kind: "delete_file";
  readonly expectedRevision?: string;
}

export type EditOperation =
  | ReplaceAnchorOperation
  | ReplaceRangeOperation
  | InsertBeforeOperation
  | InsertAfterOperation
  | DeleteAnchorOperation
  | CreateFileOperation
  | MoveFileOperation
  | DeleteFileOperation;

export interface EditPlan {
  readonly schemaVersion: typeof EDIT_SCHEMA_VERSION;
  readonly id: EditPlanId;
  readonly source: EditSource;
  readonly workspaceIdentityDigest: string;
  readonly worktreeId?: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly baseWorkspaceRevision?: string;
  readonly operations: readonly EditOperation[];
  readonly conflictPolicy: ConflictPolicy;
  readonly verificationHints?: readonly string[];
  readonly createdAt: string;
}

export interface EditDocument {
  readonly path: string;
  readonly text: string;
  readonly revision: string;
  readonly isBinary?: boolean;
}

export interface EditWorkspaceSnapshot {
  readonly workspaceIdentityDigest: string;
  readonly documents: readonly EditDocument[];
}

export type EditResolutionMethod =
  | "range"
  | "expected_range"
  | "exact_text"
  | "context"
  | "symbol_fallback";

export interface ResolutionEvidence {
  readonly method: EditResolutionMethod;
  readonly score: number;
  readonly candidateCount: number;
  readonly baseRevision: string;
  readonly currentRevision: string;
}

export interface ResolvedTextEdit {
  readonly operationId: EditOperationId;
  readonly path: string;
  readonly byteRange: ByteRange;
  readonly replacement: string;
  readonly resolution: ResolutionEvidence;
}

export type PreparedFileKind = "modify" | "create" | "delete" | "move";

export interface PreparedFileChange {
  readonly kind: PreparedFileKind;
  readonly path: string;
  readonly previousPath?: string;
  readonly revisionBefore?: string;
  readonly revisionAfter?: string;
  /** The complete staged text for create/modify/move, never present for delete. */
  readonly text?: string;
  readonly operationIds: readonly EditOperationId[];
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffPreviewLine {
  readonly path: string;
  readonly kind: "addition" | "deletion" | "context";
  readonly text: string;
}

export interface EditPreflightResult {
  readonly status: "previewed" | "no_change";
  readonly planId: EditPlanId;
  readonly planDigest: string;
  readonly resolvedOperations: readonly ResolvedTextEdit[];
  readonly files: readonly PreparedFileChange[];
  readonly diffPreview: readonly DiffPreviewLine[];
}

export type EditErrorCode =
  | "EDIT_REVISION_MISMATCH"
  | "EDIT_ANCHOR_NOT_FOUND"
  | "EDIT_ANCHOR_AMBIGUOUS"
  | "EDIT_RANGE_INVALID"
  | "EDIT_ENCODING_MISMATCH"
  | "EDIT_OVERLAP"
  | "EDIT_PATH_CONFLICT"
  | "EDIT_BINARY_UNSUPPORTED"
  | "EDIT_FILE_TOO_LARGE"
  | "EDIT_NO_CHANGE"
  | "EDIT_PLAN_DIGEST_MISMATCH"
  | "EDIT_SCOPE_VIOLATION"
  | "EDIT_TOKEN_INVALID";

export class EditDomainError extends Error {
  readonly code: EditErrorCode;
  readonly path: string | undefined;
  readonly operationId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: EditErrorCode,
    message: string,
    options: {
      readonly path?: string;
      readonly operationId?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = "EditDomainError";
    this.code = code;
    this.path = options.path;
    this.operationId = options.operationId;
    this.details = options.details;
  }
}

export interface EditEngineOptions {
  readonly maxOperations?: number;
  readonly maxFileBytes?: number;
  readonly maxAnchorCandidates?: number;
  readonly anchorAmbiguityMargin?: number;
  readonly maxDiffPreviewLines?: number;
}
