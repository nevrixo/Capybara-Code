import type { ConflictPolicy, EditPlan, EditPlanId, EditSource, EditOperationId } from "@cbc/edit-domain";

/** Zero-based UTF-16 position used by the Language Server Protocol. */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

export interface LspVersionedTextDocumentIdentifier {
  readonly uri: string;
  readonly version?: number | null;
}

export interface LspTextDocumentEdit {
  readonly textDocument: LspVersionedTextDocumentIdentifier;
  readonly edits: readonly LspTextEdit[];
}

export interface LspCreateFile {
  readonly kind: "create";
  readonly uri: string;
}

export interface LspRenameFile {
  readonly kind: "rename";
  readonly oldUri: string;
  readonly newUri: string;
}

export interface LspDeleteFile {
  readonly kind: "delete";
  readonly uri: string;
}

export type LspDocumentChange =
  | LspTextDocumentEdit
  | LspCreateFile
  | LspRenameFile
  | LspDeleteFile;

/** The standard LSP WorkspaceEdit shape, deliberately limited to safe resource operations. */
export interface LspWorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly LspTextEdit[]>>;
  readonly documentChanges?: readonly LspDocumentChange[];
}

/** An exact, runtime-derived snapshot used to bind an LSP edit to one revision. */
export interface LspEditDocument {
  readonly path: string;
  readonly text: string;
  readonly revision: string;
}

export interface BuildLspEditPlanOptions {
  readonly workspaceRoot: string;
  readonly workspaceIdentityDigest: string;
  readonly sessionId: string;
  readonly documents: readonly LspEditDocument[];
  readonly planId?: EditPlanId;
  readonly source?: Extract<EditSource, "lsp">;
  readonly worktreeId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly createdAt?: string;
  readonly conflictPolicy?: ConflictPolicy;
  readonly maxOperations?: number;
}

export interface LspEditPlanResult {
  readonly plan: EditPlan;
  /** Every source/destination path the resulting plan requires a capability for. */
  readonly paths: readonly string[];
}

export type LspEditErrorCode =
  | "LSP_EDIT_INVALID"
  | "LSP_EDIT_SCOPE_VIOLATION"
  | "LSP_EDIT_DOCUMENT_MISSING"
  | "LSP_EDIT_LIMIT";

export class LspEditDomainError extends Error {
  readonly code: LspEditErrorCode;
  readonly path: string | undefined;

  constructor(code: LspEditErrorCode, message: string, options: { readonly path?: string } = {}) {
    super(message);
    this.name = "LspEditDomainError";
    this.code = code;
    this.path = options.path;
  }
}

export type { EditOperationId };
