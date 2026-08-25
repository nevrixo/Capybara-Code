import {
  normalizeLspCallHierarchyQuery,
  normalizeLspCodeActionQuery,
  normalizeLspHoverQuery,
  normalizeLspLocationQuery,
  normalizeLspDocumentHighlightQuery,
  normalizeLspDocumentSymbolQuery,
  normalizeLspWorkspaceSymbolQuery,
  normalizeLspSignatureHelpQuery,
  type LspCallHierarchySnapshot,
  type LspDiagnostic,
  type LspDiagnosticSnapshot,
  type LspCodeActionCatalogSnapshot,
  type LspCodeActionQueryInput,
  type LspDocumentSymbol,
  type LspDocumentHighlight,
  type LspDocumentHighlightSnapshot,
  type LspWorkspaceSymbol,
  type LspWorkspaceSymbolsSnapshot,
  type LspDocumentSymbolsSnapshot,
  type LspHoverQuerySnapshot,
  type LspLocationQueryKind,
  type LspLocationQuerySnapshot,
  type LspRange,
  type LspSemanticLocation,
  type LspSemanticQueryInput,
  type LspSemanticQuerySource,
  type LspSignatureHelpSnapshot,
} from "@cbc/lsp-domain";
import type { ProposedAction } from "@cbc/permissions";
import { errorResult, okResult } from "@cbc/tool-registry";

import type {
  LspCallHierarchyRequest,
  LspCallHierarchyResult,
  LspCodeActionPreview,
  LspCodeActionPreviewRequest,
  LspFormattingPreview,
  LspFormattingPreviewRequest,
  LspRangeFormattingPreviewRequest,
  LspDiagnosticLookup,
  LspQueryResult,
  LspReferencesRequest,
  LspRenamePreview,
  LspRenameRequest,
  LspTextDocumentPosition,
} from "./lsp-host.ts";
import type { Execution } from "./tools.ts";

const MAX_SERVERS = 8;
const MAX_DIAGNOSTICS = 64;
const MAX_MESSAGE_BYTES = 512;
const MAX_METADATA_BYTES = 128;
const MAX_REVISION_BYTES = 256;
const MAX_TEXT_BYTES = 48 * 1_024;
const MAX_SEMANTIC_PATH_BYTES = 512;
const MAX_CODE_ACTIONS = 16;
const MAX_CODE_ACTION_PREVIEW_INDEX = 255;
const MAX_CALL_HIERARCHY_OFFSET = 256;
const MAX_CALL_HIERARCHY_LIMIT = 32;
const DEFAULT_CALL_HIERARCHY_LIMIT = 16;
const MAX_SEMANTIC_LOCATIONS = 32;
const MAX_SEMANTIC_DOCUMENT_HIGHLIGHTS = 32;
const MAX_SEMANTIC_POSITION_COMPONENT = 1_000_000;
const MAX_SEMANTIC_HOVER_BYTES = 8 * 1_024;
const MAX_SEMANTIC_SIGNATURES = 16;
const MAX_SEMANTIC_SIGNATURE_PARAMETERS = 16;
const MAX_SEMANTIC_SIGNATURE_LABEL_BYTES = 2 * 1_024;
const MAX_SEMANTIC_PARAMETER_LABEL_BYTES = 512;
const MAX_DOCUMENT_SYMBOLS = 32;
const MAX_DOCUMENT_SYMBOL_NAME_BYTES = 256;
const MAX_WORKSPACE_SYMBOL_QUERY_BYTES = 512;
const MAX_WORKSPACE_SYMBOLS_PER_SERVER = 16;
const MAX_WORKSPACE_SYMBOLS = 32;
const MAX_WORKSPACE_SYMBOL_NAME_BYTES = 256;
const MAX_REPORTED_WORKSPACE_SYMBOLS = 32 * 1_024;
const MAX_RENAME_NAME_BYTES = 1_024;
const MAX_RENAME_PREVIEW_PATHS = 100;
const MAX_RENAME_PREVIEW_OPERATIONS = 100;
const MAX_RENAME_PREVIEW_CHANGED_BYTES = 16 * 1_024 * 1_024;
const MAX_RENAME_PLAN_BINDING_BYTES = 256;
const UNSAFE_WORKSPACE_SYMBOL_QUERY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE = /\s+/g;

export interface LspDiagnosticsReader {
  diagnostics(path: string): Promise<LspDiagnosticLookup>;
}
export interface LspDocumentSymbolsReader {
  documentSymbols(path: string): Promise<LspQueryResult>;
}
export interface LspWorkspaceSymbolsReader {
  workspaceSymbols(query: string): Promise<readonly LspQueryResult[]>;
}

export interface LspSemanticReader {
  definition(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  declaration(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  typeDefinition(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  implementation(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  references(input: LspReferencesRequest): Promise<LspQueryResult>;
  hover(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  signatureHelp(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  documentHighlights(input: LspTextDocumentPosition): Promise<LspQueryResult>;
}

export interface LspCallHierarchyReader {
  callHierarchy(input: LspCallHierarchyRequest): Promise<LspCallHierarchyResult>;
}

export interface LspCodeActionsReader {
  codeActions(input: LspTextDocumentPosition): Promise<LspQueryResult>;
}

export interface LspCodeActionPreviewReader {
  codeActionPreview(input: LspCodeActionPreviewRequest): Promise<LspCodeActionPreview>;
}

export interface LspFormattingPreviewReader {
  formatPreview(input: LspFormattingPreviewRequest): Promise<LspFormattingPreview>;
}

export interface LspRangeFormattingPreviewReader {
  rangeFormatPreview(input: LspRangeFormattingPreviewRequest): Promise<LspFormattingPreview>;
}

export interface LspRenamePreviewReader {
  renamePreview(input: LspRenameRequest): Promise<LspRenamePreview>;
}

export interface LspToolReader extends
  LspDiagnosticsReader,
  LspDocumentSymbolsReader,
  LspWorkspaceSymbolsReader,
  LspSemanticReader,
  LspCallHierarchyReader,
  LspCodeActionsReader,
  LspCodeActionPreviewReader,
  LspFormattingPreviewReader,
  LspRangeFormattingPreviewReader,
  LspRenamePreviewReader {}

export interface LspSemanticBridgeOptions {
  readonly workspaceRoot: string;
}

interface ProjectedDiagnostic {
  readonly range: LspDiagnostic["range"];
  readonly severity?: LspDiagnostic["severity"];
  readonly code?: string;
  readonly source?: string;
  readonly message: string;
}

interface ProjectedServer {
  readonly server: string;
  readonly documentRevision: string;
  readonly documentVersion: number;
  readonly publishedAt: string;
  readonly totalDiagnostics: number;
  readonly diagnostics: readonly ProjectedDiagnostic[];
  readonly truncated: boolean;
}

/** A bounded projection suitable for a model tool result, never raw LSP data. */
export interface LspToolDiagnosticsResult {
  readonly schemaVersion: "1.0";
  readonly path: string;
  readonly totalServers: number;
  readonly returnedServers: number;
  readonly truncatedServers: boolean;
  /** Count reported only by the server snapshots returned in this result. */
  readonly diagnosticsInReturnedServers: number;
  readonly returnedDiagnostics: number;
  readonly truncatedDiagnostics: boolean;
  readonly servers: readonly ProjectedServer[];
}

/** A bounded semantic location projection suitable for model context. */
export interface LspToolLocationQueryResult {
  readonly schemaVersion: "1.0";
  readonly kind: LspLocationQueryKind;
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly totalLocations: number;
  readonly returnedLocations: number;
  readonly locations: readonly LspSemanticLocation[];
  readonly truncated: boolean;
}

/** A bounded, display-safe hover projection suitable for model context. */
export interface LspToolHoverResult {
  readonly schemaVersion: "1.0";
  readonly kind: "hover";
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly found: boolean;
  readonly contents?: string;
  readonly range?: LspRange;
  readonly truncated: boolean;
}

/** A further-bounded signature projection for model context. */
export interface LspToolSignatureHelpSignature {
  readonly label: string;
  readonly parameters: readonly string[];
}

/** A bounded, display-safe signature-help projection for model context. */
export interface LspToolSignatureHelpResult {
  readonly schemaVersion: "1.0";
  readonly kind: "signature_help";
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly totalSignatures: number;
  readonly returnedSignatures: number;
  readonly signatures: readonly LspToolSignatureHelpSignature[];
  readonly activeSignature?: number;
  readonly activeParameter?: number;
  readonly truncated: boolean;
}

/** A bounded projection of document-local symbol highlights for model context. */
export interface LspToolDocumentHighlightsResult {
  readonly schemaVersion: "1.0";
  readonly kind: "document_highlights";
  readonly server: string;
  readonly source: LspSemanticQuerySource;
  readonly totalHighlights: number;
  readonly returnedHighlights: number;
  readonly highlights: readonly LspDocumentHighlight[];
  readonly truncated: boolean;
}

/** A further-bounded document-symbol projection for model context. */
export interface LspToolDocumentSymbolsResult {
  readonly schemaVersion: "1.0";
  readonly kind: "symbols";
  readonly server: string;
  readonly path: string;
  readonly totalSymbols: number;
  readonly returnedSymbols: number;
  readonly symbols: readonly LspDocumentSymbol[];
  readonly truncated: boolean;
}

/** A workspace symbol projected with its safe language-server origin. */
export interface LspToolWorkspaceSymbol {
  readonly server: string;
  readonly name: string;
  readonly kind: LspWorkspaceSymbol["kind"];
  readonly path: string;
  readonly range: LspRange;
  readonly containerName?: string;
}

/** A globally bounded aggregation of workspace symbol responses. */
export interface LspToolWorkspaceSymbolsResult {
  readonly schemaVersion: "1.0";
  readonly kind: "workspace_symbols";
  readonly query: string;
  readonly totalServers: number;
  readonly returnedServers: number;
  readonly truncatedServers: boolean;
  /** Count reported by usable server responses before the global return cap. */
  readonly totalSymbols: number;
  readonly returnedSymbols: number;
  readonly symbols: readonly LspToolWorkspaceSymbol[];
  readonly truncated: boolean;
}

/**
 * A revision-bound proposal only. It omits the raw WorkspaceEdit and must still
 * be passed through fs.edit.preview or approval-gated fs.edit before writing.
 */
export interface LspToolRenamePreviewResult {
  readonly schemaVersion: "1.0";
  readonly kind: "rename_preview";
  readonly server: string;
  readonly paths: readonly string[];
  readonly plan: Readonly<Record<string, unknown>>;
}

/** A revision-bound code-action proposal with no raw CodeAction or command. */
export interface LspToolCodeActionPreviewResult {
  readonly schemaVersion: "1.0";
  readonly kind: "code_action_preview";
  readonly server: string;
  readonly paths: readonly string[];
  readonly plan: Readonly<Record<string, unknown>>;
}

/** A formatting outcome is either an exact-bound plan or an explicit no-op. */
export interface LspToolFormattingPreviewResult {
  readonly schemaVersion: "1.0";
  readonly kind: "format_preview" | "range_format_preview";
  readonly server: string;
  readonly path: string;
  readonly changed: boolean;
  readonly paths: readonly string[];
  readonly plan?: Readonly<Record<string, unknown>>;
}

/** A bounded, workspace-only call hierarchy page with opaque server data removed. */
export type LspToolCallHierarchyResult = LspCallHierarchySnapshot;

type LspToolSemanticResult =
  | LspToolLocationQueryResult
  | LspToolHoverResult
  | LspToolSignatureHelpResult
  | LspToolDocumentHighlightsResult;

export type LspDiagnosticsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspDocumentSymbolsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspWorkspaceSymbolsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspSemanticBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspCallHierarchyBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspCodeActionsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspCodeActionPreviewBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspFormattingPreviewBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspRangeFormattingPreviewBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspRenamePreviewBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspToolBridge = LspSemanticBridge;

/**
 * The host owns freshness. This bridge strips workspace identity and projects
 * only a small, independently bounded diagnostic view into model context.
 */
export function createLspDiagnosticsBridge(reader: LspDiagnosticsReader): LspDiagnosticsBridge {
  return async (action, signal) => {
    if (action.toolId !== "lsp.diagnostics") {
      return { result: errorResult("INVALID_ARGUMENT", "LSP diagnostics bridge received an unsupported tool") };
    }
    const path = lspPath(action);
    if (path === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.diagnostics requires a workspace-relative path without traversal",
        ),
      };
    }
    if (signal.aborted) return cancelledDiagnostics();

    try {
      const lookup = await reader.diagnostics(path);
      if (signal.aborted) return cancelledDiagnostics();
      const diagnostics = projectDiagnostics(path, lookup);
      const summary = diagnostics.returnedServers === 0
        ? "no current LSP diagnostic snapshot is available for " + path
        : String(diagnostics.returnedDiagnostics) + " diagnostic(s) from " +
          String(diagnostics.returnedServers) + " current LSP server snapshot(s)";
      return {
        result: okResult(summary, diagnostics),
        text: renderDiagnostics(diagnostics),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP diagnostics are currently unavailable; retry after the language server has indexed the file",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Document-symbol lookups are process-supervised and read-only. Their output
 * is normalized twice before reaching model context.
 */
export function createLspDocumentSymbolsBridge(
  reader: LspDocumentSymbolsReader,
  options: LspSemanticBridgeOptions,
): LspDocumentSymbolsBridge {
  return async (action, signal) => {
    if (action.toolId !== "lsp.symbols") {
      return {
        result: errorResult("INVALID_ARGUMENT", "LSP document symbols bridge received an unsupported tool"),
      };
    }
    const raw = lspArguments(action);
    const path = raw === undefined ? undefined : lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
    if (path === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.symbols requires a bounded workspace-relative path without traversal",
        ),
      };
    }
    if (signal.aborted) return cancelledSymbols();

    try {
      const query = await reader.documentSymbols(path);
      if (signal.aborted) return cancelledSymbols();
      const snapshot = normalizeLspDocumentSymbolQuery(query.result, {
        workspaceRoot: options.workspaceRoot,
        server: query.server,
        path,
        maxSymbols: MAX_DOCUMENT_SYMBOLS,
      });
      const symbols = projectDocumentSymbols(snapshot);
      if (symbols === undefined) throw new Error("document symbols could not be projected safely");
      return {
        result: okResult(
          String(symbols.returnedSymbols) + " bounded LSP document symbol(s) returned for " + path,
          symbols,
        ),
        text: renderDocumentSymbols(symbols),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP document symbols are currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Workspace-symbol lookups aggregate only bounded, resolved locations from
 * independently supervised servers. Every response is normalized again here.
 */
export function createLspWorkspaceSymbolsBridge(
  reader: LspWorkspaceSymbolsReader,
  options: LspSemanticBridgeOptions,
): LspWorkspaceSymbolsBridge {
  return async (action, signal) => {
    if (action.toolId !== "lsp.workspace_symbols") {
      return {
        result: errorResult("INVALID_ARGUMENT", "LSP workspace symbols bridge received an unsupported tool"),
      };
    }
    const query = workspaceSymbolQuery(action);
    if (query === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.workspace_symbols requires non-empty, control-free query text up to 512 UTF-8 bytes",
        ),
      };
    }
    if (signal.aborted) return cancelledWorkspaceSymbols();

    try {
      const rawResults = await reader.workspaceSymbols(query);
      if (signal.aborted) return cancelledWorkspaceSymbols();
      const symbols = projectWorkspaceSymbols(rawResults, query, options.workspaceRoot);
      if (symbols === undefined) throw new Error("workspace symbols could not be projected safely");
      return {
        result: okResult(
          String(symbols.returnedSymbols) + " bounded LSP workspace symbol(s) returned for " + symbols.query,
          symbols,
        ),
        text: renderWorkspaceSymbols(symbols),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP workspace symbols are currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Semantic LSP queries are process-supervised and read-only. This boundary
 * treats every server response as untrusted and exposes only normalized output.
 */
export function createLspSemanticBridge(
  reader: LspSemanticReader,
  options: LspSemanticBridgeOptions,
): LspSemanticBridge {
  return async (action, signal) => {
    const request = semanticRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "LSP semantic queries require a supported tool, a bounded workspace-relative path, and zero-based position",
        ),
      };
    }
    if (signal.aborted) return cancelledSemantic();

    try {
      const query = await readSemanticQuery(reader, request);
      if (signal.aborted) return cancelledSemantic();
      const semantic = projectSemanticQuery(query, request, options.workspaceRoot);
      if (semantic === undefined) throw new Error("semantic LSP result could not be projected safely");
      return {
        result: okResult(semanticSummary(semantic), semantic),
        text: renderSemanticResult(semantic),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP semantic lookup is currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Call hierarchy is a read-only, single-direction lookup. It first prepares an
 * opaque server item, then normalizes only workspace-local call edges.
 */
export function createLspCallHierarchyBridge(
  reader: LspCallHierarchyReader,
  options: LspSemanticBridgeOptions,
): LspCallHierarchyBridge {
  return async (action, signal) => {
    const request = callHierarchyRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.call_hierarchy requires a bounded workspace-relative path, zero-based position, direction, and bounded page",
        ),
      };
    }
    if (signal.aborted) return cancelledCallHierarchy();

    try {
      const query = await reader.callHierarchy(request.input);
      if (signal.aborted) return cancelledCallHierarchy();
      if (query.direction !== request.input.direction) {
        throw new Error("call hierarchy host returned a direction different from the request");
      }
      const result = normalizeLspCallHierarchyQuery(query.root, query.result, {
        workspaceRoot: options.workspaceRoot,
        server: query.server,
        source: request.input,
        offset: request.offset,
        limit: request.limit,
      });
      return {
        result: okResult(callHierarchySummary(result), result),
        text: renderCallHierarchy(result),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP call hierarchy is currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Code actions are a catalog only at this boundary. The raw edit, command,
 * diagnostics, and data fields never reach model context or execute anything.
 */
export function createLspCodeActionsBridge(
  reader: LspCodeActionsReader,
  options: LspSemanticBridgeOptions,
): LspCodeActionsBridge {
  return async (action, signal) => {
    const request = codeActionRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.code_actions requires a bounded workspace-relative path and zero-based position",
        ),
      };
    }
    if (signal.aborted) return cancelledCodeActions();

    try {
      const query = await reader.codeActions(request);
      if (signal.aborted) return cancelledCodeActions();
      const catalog = normalizeLspCodeActionQuery(query.result, {
        workspaceRoot: options.workspaceRoot,
        server: query.server,
        source: request,
        maxActions: MAX_CODE_ACTIONS,
      });
      return {
        result: okResult(codeActionSummary(catalog), catalog),
        text: renderCodeActions(catalog),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP code actions are currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * A code-action preview may contain only a revision-bound edit plan. The
 * selected action's raw command, edit, diagnostics, and data never escape.
 */
export function createLspCodeActionPreviewBridge(
  reader: LspCodeActionPreviewReader,
): LspCodeActionPreviewBridge {
  return async (action, signal) => {
    const request = codeActionPreviewRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.code_action_preview requires a bounded workspace-relative path, zero-based position, and action index",
        ),
      };
    }
    if (signal.aborted) return cancelledCodeActionPreview();

    try {
      const preview = await reader.codeActionPreview(request);
      if (signal.aborted) return cancelledCodeActionPreview();
      const result = projectCodeActionPreview(preview);
      if (result === undefined) throw new Error("code action preview could not be projected safely");
      return {
        result: okResult(codeActionPreviewSummary(result), result),
        text: renderCodeActionPreview(result),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP code action preview is currently unavailable; choose an enabled edit-only action and retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Formatting stays proposal-only. It returns an explicit no-op when the
 * language server has no edits, or a safe revision-bound plan otherwise.
 */
export function createLspFormattingPreviewBridge(
  reader: LspFormattingPreviewReader,
): LspFormattingPreviewBridge {
  return async (action, signal) => {
    const request = formattingPreviewRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.format_preview requires a bounded workspace-relative path",
        ),
      };
    }
    if (signal.aborted) return cancelledFormattingPreview();

    try {
      const preview = await reader.formatPreview(request);
      if (signal.aborted) return cancelledFormattingPreview();
      const result = projectFormattingPreview(preview, request.path);
      if (result === undefined) throw new Error("formatting preview could not be projected safely");
      return {
        result: okResult(formattingPreviewSummary(result), result),
        text: renderFormattingPreview(result),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP formatting preview is currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Range formatting remains proposal-only. Its host enforces the requested range
 * before this bridge strips raw server payloads down to a revision-bound plan.
 */
export function createLspRangeFormattingPreviewBridge(
  reader: LspRangeFormattingPreviewReader,
): LspRangeFormattingPreviewBridge {
  return async (action, signal) => {
    const request = rangeFormattingPreviewRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.range_format_preview requires a bounded workspace-relative path and ordered zero-based range",
        ),
      };
    }
    if (signal.aborted) return cancelledRangeFormattingPreview();

    try {
      const preview = await reader.rangeFormatPreview(request);
      if (signal.aborted) return cancelledRangeFormattingPreview();
      const result = projectFormattingPreview(preview, request.path, "range_format_preview");
      if (result === undefined) throw new Error("range formatting preview could not be projected safely");
      return {
        result: okResult(rangeFormattingPreviewSummary(result), result),
        text: renderRangeFormattingPreview(result),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP range formatting preview is currently unavailable; retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/**
 * Rename stays proposal-only: this bridge returns a reconstructed, bounded
 * edit plan but never exposes the raw server WorkspaceEdit or writes files.
 */
export function createLspRenamePreviewBridge(
  reader: LspRenamePreviewReader,
): LspRenamePreviewBridge {
  return async (action, signal) => {
    const request = renamePreviewRequest(action);
    if (request === undefined) {
      return {
        result: errorResult(
          "INVALID_ARGUMENT",
          "lsp.rename_preview requires a bounded workspace-relative path, zero-based position, and control-free new name",
        ),
      };
    }
    if (signal.aborted) return cancelledRenamePreview();

    try {
      const preview = await reader.renamePreview(request);
      if (signal.aborted) return cancelledRenamePreview();
      const result = projectRenamePreview(preview);
      if (result === undefined) throw new Error("rename preview could not be projected safely");
      return {
        result: okResult(
          "revision-bound LSP rename proposal returned for " + String(result.paths.length) + " file(s)",
          result,
        ),
        text: renderRenamePreview(result),
      };
    } catch {
      return {
        result: errorResult(
          "NOT_INITIALIZED",
          "LSP rename preview is currently unavailable; confirm that the symbol is renameable and retry after the language server is ready",
          { retryable: true },
        ),
      };
    }
  };
}

/** Combine diagnostics, symbols, semantic queries, safe edit proposals, and rename. */
export function createLspToolBridge(
  reader: LspToolReader,
  options: LspSemanticBridgeOptions,
): LspToolBridge {
  const diagnostics = createLspDiagnosticsBridge(reader);
  const documentSymbols = createLspDocumentSymbolsBridge(reader, options);
  const workspaceSymbols = createLspWorkspaceSymbolsBridge(reader, options);
  const semantic = createLspSemanticBridge(reader, options);
  const callHierarchy = createLspCallHierarchyBridge(reader, options);
  const codeActions = createLspCodeActionsBridge(reader, options);
  const codeActionPreview = createLspCodeActionPreviewBridge(reader);
  const formattingPreview = createLspFormattingPreviewBridge(reader);
  const rangeFormattingPreview = createLspRangeFormattingPreviewBridge(reader);
  const renamePreview = createLspRenamePreviewBridge(reader);
  return async (action, signal) =>
    action.toolId === "lsp.diagnostics"
      ? await diagnostics(action, signal)
      : action.toolId === "lsp.symbols"
      ? await documentSymbols(action, signal)
      : action.toolId === "lsp.workspace_symbols"
      ? await workspaceSymbols(action, signal)
      : action.toolId === "lsp.call_hierarchy"
      ? await callHierarchy(action, signal)
      : action.toolId === "lsp.code_actions"
      ? await codeActions(action, signal)
      : action.toolId === "lsp.code_action_preview"
      ? await codeActionPreview(action, signal)
      : action.toolId === "lsp.format_preview"
      ? await formattingPreview(action, signal)
      : action.toolId === "lsp.range_format_preview"
      ? await rangeFormattingPreview(action, signal)
      : action.toolId === "lsp.rename_preview"
      ? await renamePreview(action, signal)
      : await semantic(action, signal);
}

function cancelledSemantic(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP semantic query was cancelled", { retryable: true }),
  };
}

function cancelledCallHierarchy(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP call hierarchy request was cancelled", { retryable: true }),
  };
}

function cancelledDiagnostics(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP diagnostics request was cancelled", { retryable: true }),
  };
}

function cancelledSymbols(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP document symbols request was cancelled", { retryable: true }),
  };
}

function cancelledWorkspaceSymbols(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP workspace symbols request was cancelled", { retryable: true }),
  };
}

function cancelledCodeActions(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP code actions request was cancelled", { retryable: true }),
  };
}

function cancelledCodeActionPreview(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP code action preview was cancelled", { retryable: true }),
  };
}

function cancelledFormattingPreview(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP formatting preview was cancelled", { retryable: true }),
  };
}

function cancelledRangeFormattingPreview(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP range formatting preview was cancelled", { retryable: true }),
  };
}

function cancelledRenamePreview(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP rename preview was cancelled", { retryable: true }),
  };
}

function lspPath(action: ProposedAction): string | undefined {
  const raw = lspArguments(action);
  return raw === undefined ? undefined : lspPathFromArguments(raw, 4_096);
}

function lspArguments(action: ProposedAction): Record<string, unknown> | undefined {
  return isRecord(action.arguments) ? action.arguments : undefined;
}

interface CallHierarchyPageRequest {
  readonly input: LspCallHierarchyRequest;
  readonly offset: number;
  readonly limit: number;
}

function callHierarchyRequest(action: ProposedAction): CallHierarchyPageRequest | undefined {
  if (action.toolId !== "lsp.call_hierarchy") return undefined;
  const raw = lspArguments(action);
  if (raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  const direction = raw.direction;
  const offset = raw.offset === undefined ? 0 : raw.offset;
  const limit = raw.limit === undefined ? DEFAULT_CALL_HIERARCHY_LIMIT : raw.limit;
  if (
    path === undefined ||
    !isSemanticPositionComponent(raw.line) ||
    !isSemanticPositionComponent(raw.character) ||
    (direction !== "incoming" && direction !== "outgoing") ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_CALL_HIERARCHY_OFFSET ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CALL_HIERARCHY_LIMIT
  ) {
    return undefined;
  }
  return Object.freeze({
    input: Object.freeze({ path, line: raw.line, character: raw.character, direction }),
    offset,
    limit,
  });
}

function codeActionRequest(action: ProposedAction): LspCodeActionQueryInput | undefined {
  if (action.toolId !== "lsp.code_actions") return undefined;
  const raw = lspArguments(action);
  if (raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  if (
    path === undefined ||
    !isSemanticPositionComponent(raw.line) ||
    !isSemanticPositionComponent(raw.character)
  ) {
    return undefined;
  }
  return Object.freeze({ path, line: raw.line, character: raw.character });
}

function codeActionPreviewRequest(
  action: ProposedAction,
): LspCodeActionPreviewRequest | undefined {
  if (action.toolId !== "lsp.code_action_preview") return undefined;
  const raw = lspArguments(action);
  if (raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  const actionIndex = raw.actionIndex;
  if (
    path === undefined ||
    !isSemanticPositionComponent(raw.line) ||
    !isSemanticPositionComponent(raw.character) ||
    typeof actionIndex !== "number" ||
    !Number.isSafeInteger(actionIndex) ||
    actionIndex < 0 ||
    actionIndex > MAX_CODE_ACTION_PREVIEW_INDEX
  ) {
    return undefined;
  }
  return Object.freeze({
    path,
    line: raw.line,
    character: raw.character,
    actionIndex,
  });
}

function formattingPreviewRequest(action: ProposedAction): LspFormattingPreviewRequest | undefined {
  if (action.toolId !== "lsp.format_preview") return undefined;
  const raw = lspArguments(action);
  if (raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  return path === undefined ? undefined : Object.freeze({ path });
}

function rangeFormattingPreviewRequest(
  action: ProposedAction,
): LspRangeFormattingPreviewRequest | undefined {
  if (action.toolId !== "lsp.range_format_preview") return undefined;
  const raw = lspArguments(action);
  if (raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  if (
    path === undefined ||
    !isSemanticPositionComponent(raw.startLine) ||
    !isSemanticPositionComponent(raw.startCharacter) ||
    !isSemanticPositionComponent(raw.endLine) ||
    !isSemanticPositionComponent(raw.endCharacter) ||
    raw.startLine > raw.endLine ||
    (raw.startLine === raw.endLine && raw.startCharacter > raw.endCharacter)
  ) {
    return undefined;
  }
  return Object.freeze({
    path,
    startLine: raw.startLine,
    startCharacter: raw.startCharacter,
    endLine: raw.endLine,
    endCharacter: raw.endCharacter,
  });
}

function renamePreviewRequest(action: ProposedAction): LspRenameRequest | undefined {
  if (action.toolId !== "lsp.rename_preview") return undefined;
  const raw = lspArguments(action);
  if (raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  const newName = raw.newName;
  if (
    path === undefined ||
    !isSemanticPositionComponent(raw.line) ||
    !isSemanticPositionComponent(raw.character) ||
    typeof newName !== "string" ||
    newName.trim().length === 0 ||
    newName.trim() !== newName ||
    Buffer.byteLength(newName, "utf8") > MAX_RENAME_NAME_BYTES ||
    UNSAFE_WORKSPACE_SYMBOL_QUERY_CHARACTERS.test(newName)
  ) {
    return undefined;
  }
  return Object.freeze({ path, line: raw.line, character: raw.character, newName });
}

function workspaceSymbolQuery(action: ProposedAction): string | undefined {
  const raw = lspArguments(action);
  return raw === undefined ? undefined : workspaceSymbolQueryFromArguments(raw);
}

function workspaceSymbolQueryFromArguments(raw: Record<string, unknown>): string | undefined {
  const value = raw.query;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_SYMBOL_QUERY_BYTES ||
    UNSAFE_WORKSPACE_SYMBOL_QUERY_CHARACTERS.test(value)
  ) return undefined;
  const query = value.trim().replace(WHITESPACE, " ");
  return query.length === 0 ? undefined : query;
}

function lspPathFromArguments(raw: Record<string, unknown>, maxBytes: number): string | undefined {
  return workspaceRelativePath(raw.path, maxBytes);
}

function workspaceRelativePath(value: unknown, maxBytes: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    UNSAFE_PATH_CHARACTERS.test(value)
  ) return undefined;
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) return undefined;
  return value;
}

function projectRenamePreview(value: unknown): LspToolRenamePreviewResult | undefined {
  const preview = isRecord(value) ? value : undefined;
  const edit = isRecord(preview?.edit) ? preview.edit : undefined;
  const server = opaquePlanText(preview?.server, MAX_METADATA_BYTES);
  const rawPaths = edit?.paths;
  if (server === undefined || !Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_RENAME_PREVIEW_PATHS) {
    return undefined;
  }
  const paths: string[] = [];
  for (const rawPath of rawPaths) {
    const path = workspaceRelativePath(rawPath, MAX_SEMANTIC_PATH_BYTES);
    if (path === undefined || paths.includes(path)) return undefined;
    paths.push(path);
  }
  paths.sort();
  const plan = projectRenamePlan(edit?.plan, new Set(paths));
  if (plan === undefined) return undefined;
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "rename_preview" as const,
    server,
    paths: Object.freeze(paths),
    plan,
  });
}

function projectCodeActionPreview(value: unknown): LspToolCodeActionPreviewResult | undefined {
  const renameProjection = projectRenamePreview(value);
  if (renameProjection === undefined) return undefined;
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "code_action_preview" as const,
    server: renameProjection.server,
    paths: renameProjection.paths,
    plan: renameProjection.plan,
  });
}

function projectFormattingPreview(
  value: unknown,
  path: string,
  kind: LspToolFormattingPreviewResult["kind"] = "format_preview",
): LspToolFormattingPreviewResult | undefined {
  const preview = isRecord(value) ? value : undefined;
  const server = opaquePlanText(preview?.server, MAX_METADATA_BYTES);
  if (preview === undefined || server === undefined) return undefined;
  if (preview.edit === undefined) {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      kind,
      server,
      path,
      changed: false,
      paths: Object.freeze([]) as readonly string[],
    });
  }
  const editProjection = projectRenamePreview(value);
  if (
    editProjection === undefined ||
    editProjection.paths.length !== 1 ||
    editProjection.paths[0] !== path
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind,
    server: editProjection.server,
    path,
    changed: true,
    paths: editProjection.paths,
    plan: editProjection.plan,
  });
}

function projectRenamePlan(
  value: unknown,
  paths: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  const raw = isRecord(value) ? value : undefined;
  if (raw === undefined) return undefined;
  const id = opaquePlanText(raw.id, MAX_METADATA_BYTES);
  const workspaceIdentityDigest = opaquePlanText(raw.workspaceIdentityDigest, MAX_RENAME_PLAN_BINDING_BYTES);
  const sessionId = opaquePlanText(raw.sessionId, MAX_RENAME_PLAN_BINDING_BYTES);
  const createdAt = opaquePlanText(raw.createdAt, MAX_METADATA_BYTES);
  if (
    raw.schemaVersion !== "1.0" ||
    raw.source !== "lsp" ||
    id === undefined ||
    workspaceIdentityDigest === undefined ||
    sessionId === undefined ||
    createdAt === undefined ||
    (raw.conflictPolicy !== "fail" && raw.conflictPolicy !== "safe_rebase") ||
    !Array.isArray(raw.operations) ||
    raw.operations.length === 0 ||
    raw.operations.length > MAX_RENAME_PREVIEW_OPERATIONS
  ) {
    return undefined;
  }

  const operations: Readonly<Record<string, unknown>>[] = [];
  let changedBytes = 0;
  for (const value of raw.operations) {
    const projected = projectRenameOperation(value, paths);
    if (projected === undefined || projected.changedBytes > MAX_RENAME_PREVIEW_CHANGED_BYTES - changedBytes) {
      return undefined;
    }
    changedBytes += projected.changedBytes;
    operations.push(projected.operation);
  }
  return Object.freeze({
    schemaVersion: "1.0",
    id,
    source: "lsp",
    workspaceIdentityDigest,
    sessionId,
    operations: Object.freeze(operations),
    conflictPolicy: raw.conflictPolicy,
    createdAt,
  });
}

function projectRenameOperation(
  value: unknown,
  paths: ReadonlySet<string>,
): { readonly operation: Readonly<Record<string, unknown>>; readonly changedBytes: number } | undefined {
  const raw = isRecord(value) ? value : undefined;
  if (raw === undefined) return undefined;
  const operationId = opaquePlanText(raw.operationId, MAX_METADATA_BYTES);
  const path = workspaceRelativePath(raw.path, MAX_SEMANTIC_PATH_BYTES);
  if (operationId === undefined || path === undefined || !paths.has(path)) return undefined;

  if (raw.kind === "replace_range") {
    const baseRevision = opaquePlanText(raw.baseRevision, MAX_RENAME_PLAN_BINDING_BYTES);
    const range = projectRenameRange(raw.range);
    const expectedTextDigest = raw.expectedTextDigest === undefined
      ? undefined
      : opaquePlanText(raw.expectedTextDigest, MAX_RENAME_PLAN_BINDING_BYTES);
    if (
      baseRevision === undefined ||
      range === undefined ||
      (raw.expectedTextDigest !== undefined && expectedTextDigest === undefined) ||
      typeof raw.replacement !== "string"
    ) {
      return undefined;
    }
    return {
      operation: Object.freeze({
        kind: "replace_range",
        operationId,
        path,
        baseRevision,
        range,
        ...(expectedTextDigest === undefined ? {} : { expectedTextDigest }),
        replacement: raw.replacement,
      }),
      changedBytes: Buffer.byteLength(raw.replacement, "utf8"),
    };
  }

  if (raw.kind === "create_file") {
    if (typeof raw.content !== "string") return undefined;
    return {
      operation: Object.freeze({ kind: "create_file", operationId, path, content: raw.content }),
      changedBytes: Buffer.byteLength(raw.content, "utf8"),
    };
  }

  if (raw.kind === "move_file") {
    const toPath = workspaceRelativePath(raw.toPath, MAX_SEMANTIC_PATH_BYTES);
    const expectedRevision = raw.expectedRevision === undefined
      ? undefined
      : opaquePlanText(raw.expectedRevision, MAX_RENAME_PLAN_BINDING_BYTES);
    if (
      toPath === undefined ||
      !paths.has(toPath) ||
      (raw.expectedRevision !== undefined && expectedRevision === undefined)
    ) {
      return undefined;
    }
    return {
      operation: Object.freeze({
        kind: "move_file",
        operationId,
        path,
        toPath,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
      changedBytes: 0,
    };
  }

  if (raw.kind === "delete_file") {
    const expectedRevision = raw.expectedRevision === undefined
      ? undefined
      : opaquePlanText(raw.expectedRevision, MAX_RENAME_PLAN_BINDING_BYTES);
    if (raw.expectedRevision !== undefined && expectedRevision === undefined) return undefined;
    return {
      operation: Object.freeze({
        kind: "delete_file",
        operationId,
        path,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
      changedBytes: 0,
    };
  }
  return undefined;
}

interface ProjectedRenamePosition {
  readonly line: number;
  readonly column: number;
}

function projectRenameRange(value: unknown): Readonly<{
  readonly start: ProjectedRenamePosition;
  readonly end: ProjectedRenamePosition;
  readonly encoding: "utf16";
}> | undefined {
  const raw = isRecord(value) ? value : undefined;
  const start = projectRenamePosition(raw?.start);
  const end = projectRenamePosition(raw?.end);
  if (
    raw?.encoding !== "utf16" ||
    start === undefined ||
    end === undefined ||
    compareRenamePositions(start, end) > 0
  ) {
    return undefined;
  }
  return Object.freeze({ start, end, encoding: "utf16" as const });
}

function projectRenamePosition(value: unknown): Readonly<ProjectedRenamePosition> | undefined {
  const raw = isRecord(value) ? value : undefined;
  const line = raw?.line;
  const column = raw?.column;
  if (
    typeof line !== "number" ||
    typeof column !== "number" ||
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(column) ||
    line < 1 ||
    column < 0 ||
    line > MAX_SEMANTIC_POSITION_COMPONENT + 1 ||
    column > MAX_SEMANTIC_POSITION_COMPONENT
  ) {
    return undefined;
  }
  return Object.freeze({ line, column });
}

function compareRenamePositions(
  left: ProjectedRenamePosition,
  right: ProjectedRenamePosition,
): number {
  return left.line === right.line ? left.column - right.column : left.line - right.line;
}

function opaquePlanText(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" &&
      value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= maxBytes &&
      !UNSAFE_WORKSPACE_SYMBOL_QUERY_CHARACTERS.test(value)
    ? value
    : undefined;
}

function renderRenamePreview(result: LspToolRenamePreviewResult): string {
  return truncateUtf8([
    "Language-server rename preview created a revision-bound plan for " +
      String(result.paths.length) + " file(s): " + result.paths.join(", "),
    "[This proposal has not written files. Run fs.edit.preview to re-preflight it; fs.edit requires its own approval and re-preflights immediately before staging.]",
  ].join("\n"), MAX_TEXT_BYTES);
}

function codeActionPreviewSummary(result: LspToolCodeActionPreviewResult): string {
  return "revision-bound LSP code action proposal returned for " + String(result.paths.length) + " file(s)";
}

function renderCodeActionPreview(result: LspToolCodeActionPreviewResult): string {
  return truncateUtf8([
    "Language-server code action preview created a revision-bound plan for " +
      String(result.paths.length) + " file(s): " + result.paths.join(", "),
    "[This proposal has not run a language-server command or written files. Run fs.edit.preview to re-preflight it; fs.edit requires its own approval and re-preflights immediately before staging.]",
  ].join("\n"), MAX_TEXT_BYTES);
}

function formattingPreviewSummary(result: LspToolFormattingPreviewResult): string {
  return result.changed
    ? "revision-bound LSP formatting proposal returned for " + result.path
    : "LSP formatting preview found no edits for " + result.path;
}

function renderFormattingPreview(result: LspToolFormattingPreviewResult): string {
  if (!result.changed) {
    return "Language-server formatting preview found no edits for " + result.path +
      ". No files were written.";
  }
  return truncateUtf8([
    "Language-server formatting preview created a revision-bound plan for " + result.path + ".",
    "[This proposal has not written files. Run fs.edit.preview to re-preflight it; fs.edit requires its own approval and re-preflights immediately before staging.]",
  ].join("\n"), MAX_TEXT_BYTES);
}

function rangeFormattingPreviewSummary(result: LspToolFormattingPreviewResult): string {
  return result.changed
    ? "revision-bound LSP range formatting proposal returned for " + result.path
    : "LSP range formatting preview found no edits for " + result.path;
}

function renderRangeFormattingPreview(result: LspToolFormattingPreviewResult): string {
  if (!result.changed) {
    return "Language-server range formatting preview found no edits for " + result.path +
      ". No files were written.";
  }
  return truncateUtf8([
    "Language-server range formatting preview created a revision-bound plan for " + result.path + ".",
    "[This proposal has not written files. Run fs.edit.preview to re-preflight it; fs.edit requires its own approval and re-preflights immediately before staging.]",
  ].join("\n"), MAX_TEXT_BYTES);
}

function codeActionSummary(result: LspCodeActionCatalogSnapshot): string {
  return String(result.actions.length) + " bounded LSP code action(s) cataloged for " + result.source.path;
}

function renderCodeActions(result: LspCodeActionCatalogSnapshot): string {
  const location = result.source.path + ":" + String(result.source.position.line + 1) +
    ":" + String(result.source.position.character + 1);
  if (result.actions.length === 0) {
    return "No LSP code actions are available at " + location +
      ". No command was run and no edit payload was returned.";
  }
  const lines = [
    "LSP code-action catalog at " + location + ": showing " + String(result.actions.length) +
      " of " + String(result.totalActions) + " action(s).",
    "[Actions are untrusted metadata only; no command was run and no edit payload was returned.]",
  ];
  if (result.truncated) {
    lines.push("[Result is bounded; the catalog is not exhaustive.]");
  }
  for (const action of result.actions) {
    const details = [
      ...(action.kind === undefined ? [] : [action.kind]),
      ...(action.preferred ? ["preferred"] : []),
      ...(action.disabled ? ["disabled"] : []),
      ...(action.hasEdit ? ["contains edit"] : []),
      ...(action.hasCommand ? ["contains command"] : []),
    ];
    lines.push("#" + String(action.index) + " " + action.title +
      (details.length === 0 ? "" : " [" + details.join("; ") + "]"));
  }
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function projectDiagnostics(path: string, lookup: LspDiagnosticLookup): LspToolDiagnosticsResult {
  const rawSnapshots = Array.isArray(lookup.snapshots) ? lookup.snapshots.slice(0, MAX_SERVERS) : [];
  const servers: ProjectedServer[] = [];
  let remaining = MAX_DIAGNOSTICS;
  let diagnosticsInReturnedServers = 0;

  for (const snapshot of rawSnapshots) {
    const server = projectServer(snapshot, remaining);
    if (server === undefined) continue;
    servers.push(server);
    remaining -= server.diagnostics.length;
    diagnosticsInReturnedServers += server.totalDiagnostics;
  }

  const returnedDiagnostics = MAX_DIAGNOSTICS - remaining;
  const reportedServers = boundedCount(lookup.totalServers, servers.length, 4_096);
  const totalServers = Math.max(servers.length, reportedServers);
  return Object.freeze({
    schemaVersion: "1.0" as const,
    path,
    totalServers,
    returnedServers: servers.length,
    truncatedServers: lookup.truncatedServers === true || totalServers > servers.length,
    diagnosticsInReturnedServers,
    returnedDiagnostics,
    truncatedDiagnostics: servers.some((server) => server.truncated) || returnedDiagnostics < diagnosticsInReturnedServers,
    servers: Object.freeze(servers),
  });
}

function projectServer(snapshot: LspDiagnosticSnapshot, remaining: number): ProjectedServer | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const documentRevision = boundedText(snapshot.documentRevision, MAX_REVISION_BYTES);
  const publishedAt = boundedText(snapshot.publishedAt, MAX_METADATA_BYTES);
  const documentVersion = boundedCount(snapshot.documentVersion, 0, Number.MAX_SAFE_INTEGER);
  if (server === undefined || documentRevision === undefined || publishedAt === undefined || documentVersion < 1) return undefined;

  const rawDiagnostics = Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];
  const reported = boundedCount(snapshot.totalDiagnostics, rawDiagnostics.length, 4_096);
  const totalDiagnostics = Math.max(Math.min(rawDiagnostics.length, 4_096), reported);
  const diagnostics: ProjectedDiagnostic[] = [];
  for (const diagnostic of rawDiagnostics) {
    if (diagnostics.length >= remaining) break;
    const projected = projectDiagnostic(diagnostic);
    if (projected !== undefined) diagnostics.push(projected);
  }
  return Object.freeze({
    server,
    documentRevision,
    documentVersion,
    publishedAt,
    totalDiagnostics,
    diagnostics: Object.freeze(diagnostics),
    truncated: snapshot.truncated === true || diagnostics.length < totalDiagnostics,
  });
}

function projectDiagnostic(diagnostic: LspDiagnostic): ProjectedDiagnostic | undefined {
  const start = projectPosition(diagnostic.range?.start);
  const end = projectPosition(diagnostic.range?.end);
  const message = boundedText(diagnostic.message, MAX_MESSAGE_BYTES);
  if (start === undefined || end === undefined || message === undefined) return undefined;
  const code = boundedText(diagnostic.code, MAX_METADATA_BYTES);
  const source = boundedText(diagnostic.source, MAX_METADATA_BYTES);
  const severity = diagnostic.severity;
  return Object.freeze({
    range: Object.freeze({ start: Object.freeze(start), end: Object.freeze(end) }),
    ...(severity === undefined ? {} : { severity }),
    ...(code === undefined ? {} : { code }),
    ...(source === undefined ? {} : { source }),
    message,
  });
}

function projectPosition(value: unknown): { readonly line: number; readonly character: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isPositionComponent(record.line) || !isPositionComponent(record.character)) return undefined;
  return { line: record.line, character: record.character };
}

function isPositionComponent(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedCount(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
  if (normalized.length === 0) return undefined;
  return truncateUtf8(normalized, maxBytes);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "...";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return output + suffix;
}

function renderDiagnostics(diagnostics: LspToolDiagnosticsResult): string {
  if (diagnostics.returnedServers === 0) {
    return "No current LSP diagnostic snapshot is available for " + diagnostics.path +
      "; this does not prove that the file is clean.";
  }
  const lines = [
    "LSP diagnostics for " + diagnostics.path + ": " + String(diagnostics.returnedDiagnostics) +
      " shown from " + String(diagnostics.returnedServers) + " current server snapshot(s).",
  ];
  if (diagnostics.truncatedServers || diagnostics.truncatedDiagnostics) {
    lines.push("[Result is bounded; inspect the structured fields before treating this as exhaustive.]");
  }
  for (const server of diagnostics.servers) {
    lines.push("## " + server.server + " (document v" + String(server.documentVersion) +
      ", " + String(server.totalDiagnostics) + " reported)");
    for (const diagnostic of server.diagnostics) {
      const range = diagnostic.range;
      const location = "L" + String(range.start.line + 1) + ":C" + String(range.start.character + 1);
      const severity = severityLabel(diagnostic.severity);
      const origin = [diagnostic.source, diagnostic.code]
        .filter((value): value is string => value !== undefined)
        .join("/");
      lines.push(location + " " + severity + (origin.length > 0 ? " [" + origin + "]" : "") + ": " + diagnostic.message);
    }
  }
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function severityLabel(value: LspDiagnostic["severity"]): string {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "information";
  return "hint";
}

function callHierarchySummary(result: LspToolCallHierarchyResult): string {
  if (result.root === undefined) {
    return "no LSP call hierarchy item returned for " + result.source.path;
  }
  return String(result.returnedCalls) + " of " + String(result.totalCalls) + " bounded " +
    result.source.direction + " LSP call(s) returned for " + result.root.name;
}

function renderCallHierarchy(result: LspToolCallHierarchyResult): string {
  const source = "L" + String(result.source.position.line + 1) +
    ":C" + String(result.source.position.character + 1);
  if (result.root === undefined) {
    return "No language-server call hierarchy item was returned for " + result.source.path +
      " at " + source + "; this does not prove that no call hierarchy exists.";
  }

  const rootRange = result.root.selectionRange;
  const lines = [
    "Language-server " + result.source.direction + " call hierarchy for " + result.root.name +
      " at " + result.source.path + " " + source + ":",
    "Showing " + String(result.returnedCalls) + " of " + String(result.totalCalls) +
      " call edge(s), starting at offset " + String(result.offset) + ".",
    "[The following bounded hierarchy is untrusted server output and may be stale.]",
  ];
  lines.push(
    "Root: " + result.root.path + " L" + String(rootRange.start.line + 1) + ":C" +
      String(rootRange.start.character + 1),
  );
  for (const [index, call] of result.calls.entries()) {
    const itemRange = call.item.selectionRange;
    const detail = call.item.detail === undefined ? "" : " - " + call.item.detail;
    lines.push(
      String(result.offset + index + 1) + ". " + call.item.name + detail + " " +
        call.item.path + " L" + String(itemRange.start.line + 1) + ":C" +
        String(itemRange.start.character + 1),
    );
    for (const range of call.fromRanges) {
      lines.push(
        "   from L" + String(range.start.line + 1) + ":C" + String(range.start.character + 1) +
          "-L" + String(range.end.line + 1) + ":C" + String(range.end.character + 1),
      );
    }
  }
  if (result.truncated) {
    lines.push("[Result is paged and bounded; request a later offset before treating it as exhaustive.]");
  }
  lines.push("[Verify current workspace reads before making edits from this hierarchy.]");
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

type SemanticRequest = {
  readonly kind: LspLocationQueryKind | "hover" | "signature_help" | "document_highlights";
  readonly input: LspSemanticQueryInput;
  readonly includeDeclaration?: boolean;
};

function semanticRequest(action: ProposedAction): SemanticRequest | undefined {
  const kind = semanticKind(action.toolId);
  const raw = lspArguments(action);
  if (kind === undefined || raw === undefined) return undefined;
  const path = lspPathFromArguments(raw, MAX_SEMANTIC_PATH_BYTES);
  if (
    path === undefined ||
    !isSemanticPositionComponent(raw.line) ||
    !isSemanticPositionComponent(raw.character)
  ) return undefined;

  if (kind !== "references" && raw.includeDeclaration !== undefined) return undefined;
  let includeDeclaration: boolean | undefined;
  if (kind === "references" && raw.includeDeclaration !== undefined) {
    if (typeof raw.includeDeclaration !== "boolean") return undefined;
    includeDeclaration = raw.includeDeclaration;
  }
  return Object.freeze({
    kind,
    input: Object.freeze({ path, line: raw.line, character: raw.character }),
    ...(includeDeclaration === undefined ? {} : { includeDeclaration }),
  });
}

function semanticKind(value: string): SemanticRequest["kind"] | undefined {
  if (value === "lsp.definition") return "definition";
  if (value === "lsp.declaration") return "declaration";
  if (value === "lsp.type_definition") return "type_definition";
  if (value === "lsp.implementation") return "implementation";
  if (value === "lsp.references") return "references";
  if (value === "lsp.hover") return "hover";
  if (value === "lsp.signature_help") return "signature_help";
  if (value === "lsp.document_highlights") return "document_highlights";
  return undefined;
}

function isSemanticPositionComponent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SEMANTIC_POSITION_COMPONENT
  );
}

async function readSemanticQuery(
  reader: LspSemanticReader,
  request: SemanticRequest,
): Promise<LspQueryResult> {
  switch (request.kind) {
    case "definition":
      return await reader.definition(request.input);
    case "declaration":
      return await reader.declaration(request.input);
    case "type_definition":
      return await reader.typeDefinition(request.input);
    case "implementation":
      return await reader.implementation(request.input);
    case "references": {
      const input: LspReferencesRequest = {
        ...request.input,
        ...(request.includeDeclaration === undefined
          ? {}
          : { includeDeclaration: request.includeDeclaration }),
      };
      return await reader.references(input);
    }
    case "hover":
      return await reader.hover(request.input);
    case "signature_help":
      return await reader.signatureHelp(request.input);
    case "document_highlights":
      return await reader.documentHighlights(request.input);
  }
  throw new Error("unsupported semantic LSP query");
}

function projectSemanticQuery(
  query: LspQueryResult,
  request: SemanticRequest,
  workspaceRoot: string,
): LspToolSemanticResult | undefined {
  const options = {
    workspaceRoot,
    server: query.server,
    source: request.input,
  };
  if (request.kind === "document_highlights") {
    return projectDocumentHighlightsQuery(
      normalizeLspDocumentHighlightQuery(query.result, {
        ...options,
        maxHighlights: MAX_SEMANTIC_DOCUMENT_HIGHLIGHTS,
      }),
    );
  }
  if (request.kind === "hover") {
    return projectHoverQuery(normalizeLspHoverQuery(query.result, options));
  }
  if (request.kind === "signature_help") {
    return projectSignatureHelpQuery(normalizeLspSignatureHelpQuery(query.result, options));
  }
  return projectLocationQuery(
    normalizeLspLocationQuery(request.kind, query.result, {
      ...options,
      maxLocations: MAX_SEMANTIC_LOCATIONS,
    }),
  );
}

function projectLocationQuery(
  snapshot: LspLocationQuerySnapshot,
): LspToolLocationQueryResult | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const source = projectSemanticSource(snapshot.source);
  if (server === undefined || source === undefined) return undefined;

  const rawLocations = Array.isArray(snapshot.locations) ? snapshot.locations : [];
  const locations: LspSemanticLocation[] = [];
  for (const location of rawLocations) {
    const projected = projectSemanticLocation(location);
    if (projected !== undefined) locations.push(projected);
  }
  const totalLocations = Math.max(
    locations.length,
    boundedCount(snapshot.totalLocations, rawLocations.length, 4_096),
  );
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: snapshot.kind,
    server,
    source,
    totalLocations,
    returnedLocations: locations.length,
    locations: Object.freeze(locations),
    truncated:
      snapshot.truncated === true ||
      locations.length < rawLocations.length ||
      totalLocations > locations.length,
  });
}

function projectDocumentHighlightsQuery(
  snapshot: LspDocumentHighlightSnapshot,
): LspToolDocumentHighlightsResult | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const source = projectSemanticSource(snapshot.source);
  if (server === undefined || source === undefined) return undefined;

  const rawHighlights = Array.isArray(snapshot.highlights) ? snapshot.highlights : [];
  const highlights: LspDocumentHighlight[] = [];
  for (const rawHighlight of rawHighlights.slice(0, MAX_SEMANTIC_DOCUMENT_HIGHLIGHTS)) {
    const range = projectSemanticRange(rawHighlight.range);
    if (range === undefined) return undefined;
    if (
      rawHighlight.kind !== "text" &&
      rawHighlight.kind !== "read" &&
      rawHighlight.kind !== "write"
    ) return undefined;
    highlights.push(Object.freeze({ range, kind: rawHighlight.kind }));
  }
  const totalHighlights = Math.max(
    highlights.length,
    boundedCount(snapshot.totalHighlights, rawHighlights.length, 4_096),
  );
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "document_highlights" as const,
    server,
    source,
    totalHighlights,
    returnedHighlights: highlights.length,
    highlights: Object.freeze(highlights),
    truncated:
      snapshot.truncated === true ||
      rawHighlights.length > highlights.length ||
      totalHighlights > highlights.length,
  });
}

function projectHoverQuery(snapshot: LspHoverQuerySnapshot): LspToolHoverResult | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const source = projectSemanticSource(snapshot.source);
  if (server === undefined || source === undefined) return undefined;
  if (snapshot.found !== true) {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      kind: "hover" as const,
      server,
      source,
      found: false,
      truncated: snapshot.truncated === true,
    });
  }

  const rawContents = snapshot.contents;
  const contents = boundedText(rawContents, MAX_SEMANTIC_HOVER_BYTES);
  const range = snapshot.range === undefined ? undefined : projectSemanticRange(snapshot.range);
  if (contents === undefined || (snapshot.range !== undefined && range === undefined)) return undefined;
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "hover" as const,
    server,
    source,
    found: true,
    contents,
    ...(range === undefined ? {} : { range }),
    truncated:
      snapshot.truncated === true ||
      (typeof rawContents === "string" &&
        Buffer.byteLength(rawContents, "utf8") > MAX_SEMANTIC_HOVER_BYTES),
  });
}

function projectSignatureHelpQuery(
  snapshot: LspSignatureHelpSnapshot,
): LspToolSignatureHelpResult | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const source = projectSemanticSource(snapshot.source);
  if (server === undefined || source === undefined) return undefined;

  const rawSignatures = Array.isArray(snapshot.signatures) ? snapshot.signatures : [];
  const signatures: LspToolSignatureHelpSignature[] = [];
  let parameterTruncated = false;
  for (const signature of rawSignatures.slice(0, MAX_SEMANTIC_SIGNATURES)) {
    const label = boundedText(signature.label, MAX_SEMANTIC_SIGNATURE_LABEL_BYTES);
    if (label === undefined) return undefined;
    const rawParameters = Array.isArray(signature.parameters) ? signature.parameters : [];
    const parameters: string[] = [];
    for (const parameter of rawParameters.slice(0, MAX_SEMANTIC_SIGNATURE_PARAMETERS)) {
      const projected = boundedText(parameter, MAX_SEMANTIC_PARAMETER_LABEL_BYTES);
      if (projected === undefined) return undefined;
      parameters.push(projected);
    }
    if (rawParameters.length > parameters.length) parameterTruncated = true;
    signatures.push(Object.freeze({
      label,
      parameters: Object.freeze(parameters),
    }));
  }

  const totalSignatures = Math.max(
    signatures.length,
    boundedCount(snapshot.totalSignatures, rawSignatures.length, 256),
  );
  const activeSignature = visibleIndex(snapshot.activeSignature, signatures.length);
  const activeSignatureIsHidden =
    snapshot.activeSignature !== undefined && activeSignature === undefined;
  const activeParameter = activeSignatureIsHidden
    ? undefined
    : visibleIndex(
      snapshot.activeParameter,
      signatures[activeSignature ?? 0]?.parameters.length ?? 0,
    );
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "signature_help" as const,
    server,
    source,
    totalSignatures,
    returnedSignatures: signatures.length,
    signatures: Object.freeze(signatures),
    ...(activeSignature === undefined ? {} : { activeSignature }),
    ...(activeParameter === undefined ? {} : { activeParameter }),
    truncated:
      snapshot.truncated === true ||
      rawSignatures.length > signatures.length ||
      totalSignatures > signatures.length ||
      parameterTruncated,
  });
}

function visibleIndex(value: unknown, upperExclusive: number): number | undefined {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value < upperExclusive
    ? value
    : undefined;
}

function projectDocumentSymbols(
  snapshot: LspDocumentSymbolsSnapshot,
): LspToolDocumentSymbolsResult | undefined {
  const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
  const path = workspaceRelativePath(snapshot.path, MAX_SEMANTIC_PATH_BYTES);
  if (server === undefined || path === undefined) return undefined;

  const rawSymbols = Array.isArray(snapshot.symbols) ? snapshot.symbols : [];
  const symbols: LspDocumentSymbol[] = [];
  for (const symbol of rawSymbols.slice(0, MAX_DOCUMENT_SYMBOLS)) {
    const projected = projectDocumentSymbol(symbol);
    if (projected === undefined) return undefined;
    symbols.push(projected);
  }
  const totalSymbols = Math.max(
    symbols.length,
    boundedCount(snapshot.totalSymbols, rawSymbols.length, 4_096),
  );
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "symbols" as const,
    server,
    path,
    totalSymbols,
    returnedSymbols: symbols.length,
    symbols: Object.freeze(symbols),
    truncated:
      snapshot.truncated === true ||
      rawSymbols.length > symbols.length ||
      totalSymbols > symbols.length,
  });
}

function projectDocumentSymbol(value: LspDocumentSymbol): LspDocumentSymbol | undefined {
  const name = boundedText(value.name, MAX_DOCUMENT_SYMBOL_NAME_BYTES);
  const range = projectSemanticRange(value.range);
  const selectionRange = value.selectionRange === undefined
    ? undefined
    : projectSemanticRange(value.selectionRange);
  const containerName = value.containerName === undefined
    ? undefined
    : boundedText(value.containerName, MAX_DOCUMENT_SYMBOL_NAME_BYTES);
  if (
    name === undefined ||
    range === undefined ||
    (value.selectionRange !== undefined && selectionRange === undefined) ||
    (value.containerName !== undefined && containerName === undefined)
  ) return undefined;

  const symbol: {
    name: string;
    kind: LspDocumentSymbol["kind"];
    range: LspRange;
    selectionRange?: LspRange;
    containerName?: string;
  } = { name, kind: value.kind, range };
  if (selectionRange !== undefined) symbol.selectionRange = selectionRange;
  if (containerName !== undefined) symbol.containerName = containerName;
  return Object.freeze(symbol);
}

function projectWorkspaceSymbols(
  value: unknown,
  query: string,
  workspaceRoot: string,
): LspToolWorkspaceSymbolsResult | undefined {
  if (!Array.isArray(value)) return undefined;
  const safeQuery = boundedText(query, MAX_WORKSPACE_SYMBOL_QUERY_BYTES);
  if (safeQuery === undefined) return undefined;

  const rawResults = value;
  const candidates = rawResults.slice(0, MAX_SERVERS);
  const symbols: LspToolWorkspaceSymbol[] = [];
  let returnedServers = 0;
  let totalSymbols = 0;
  let incompleteServers = rawResults.length > candidates.length;
  let symbolOutputTruncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.server !== "string") {
      incompleteServers = true;
      continue;
    }
    try {
      const snapshot: LspWorkspaceSymbolsSnapshot = normalizeLspWorkspaceSymbolQuery(candidate.result, {
        workspaceRoot,
        server: candidate.server,
        query: safeQuery,
        maxSymbols: MAX_WORKSPACE_SYMBOLS_PER_SERVER,
      });
      const server = boundedText(snapshot.server, MAX_METADATA_BYTES);
      if (server === undefined) {
        incompleteServers = true;
        continue;
      }
      returnedServers += 1;

      const rawSymbols = Array.isArray(snapshot.symbols) ? snapshot.symbols : [];
      const reportedSymbols = Math.max(
        rawSymbols.length,
        boundedCount(snapshot.totalSymbols, rawSymbols.length, 4_096),
      );
      totalSymbols = Math.min(
        MAX_REPORTED_WORKSPACE_SYMBOLS,
        totalSymbols + reportedSymbols,
      );
      if (snapshot.truncated === true || rawSymbols.length > MAX_WORKSPACE_SYMBOLS_PER_SERVER) {
        symbolOutputTruncated = true;
      }

      for (const symbol of rawSymbols) {
        if (symbols.length >= MAX_WORKSPACE_SYMBOLS) {
          symbolOutputTruncated = true;
          continue;
        }
        const projected = projectWorkspaceSymbol(server, symbol);
        if (projected === undefined) {
          incompleteServers = true;
          continue;
        }
        symbols.push(projected);
      }
    } catch {
      incompleteServers = true;
    }
  }

  if (returnedServers === 0) return undefined;
  const totalServers = Math.min(rawResults.length, 4_096);
  const truncatedServers = incompleteServers || totalServers > returnedServers;
  return Object.freeze({
    schemaVersion: "1.0" as const,
    kind: "workspace_symbols" as const,
    query: safeQuery,
    totalServers,
    returnedServers,
    truncatedServers,
    totalSymbols,
    returnedSymbols: symbols.length,
    symbols: Object.freeze(symbols),
    truncated:
      truncatedServers ||
      symbolOutputTruncated ||
      totalSymbols > symbols.length,
  });
}

function projectWorkspaceSymbol(
  server: string,
  value: LspWorkspaceSymbol,
): LspToolWorkspaceSymbol | undefined {
  const name = boundedText(value.name, MAX_WORKSPACE_SYMBOL_NAME_BYTES);
  const path = workspaceRelativePath(value.path, MAX_SEMANTIC_PATH_BYTES);
  const range = projectSemanticRange(value.range);
  const containerName = value.containerName === undefined
    ? undefined
    : boundedText(value.containerName, MAX_WORKSPACE_SYMBOL_NAME_BYTES);
  if (
    name === undefined ||
    path === undefined ||
    range === undefined ||
    (value.containerName !== undefined && containerName === undefined)
  ) return undefined;

  const symbol: {
    server: string;
    name: string;
    kind: LspWorkspaceSymbol["kind"];
    path: string;
    range: LspRange;
    containerName?: string;
  } = {
    server,
    name,
    kind: value.kind,
    path,
    range,
  };
  if (containerName !== undefined) symbol.containerName = containerName;
  return Object.freeze(symbol);
}

function projectSemanticSource(value: LspSemanticQuerySource): LspSemanticQuerySource | undefined {
  const path = workspaceRelativePath(value.path, MAX_SEMANTIC_PATH_BYTES);
  const position = projectSemanticPosition(value.position);
  if (path === undefined || position === undefined) return undefined;
  return Object.freeze({ path, position });
}

function projectSemanticLocation(value: LspSemanticLocation): LspSemanticLocation | undefined {
  const path = workspaceRelativePath(value.path, MAX_SEMANTIC_PATH_BYTES);
  const range = projectSemanticRange(value.range);
  if (path === undefined || range === undefined) return undefined;
  return Object.freeze({ path, range });
}

function projectSemanticRange(value: unknown): LspRange | undefined {
  if (!isRecord(value)) return undefined;
  const start = projectSemanticPosition(value.start);
  const end = projectSemanticPosition(value.end);
  if (start === undefined || end === undefined || comparePositions(start, end) > 0) return undefined;
  return Object.freeze({ start, end });
}

function projectSemanticPosition(value: unknown): { readonly line: number; readonly character: number } | undefined {
  if (!isRecord(value) || !isSemanticPositionComponent(value.line) || !isSemanticPositionComponent(value.character)) {
    return undefined;
  }
  return Object.freeze({ line: value.line, character: value.character });
}

function comparePositions(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
}

function semanticSummary(result: LspToolSemanticResult): string {
  if (result.kind === "hover") {
    return result.found
      ? "bounded LSP hover text returned for " + result.source.path
      : "no usable LSP hover text returned for " + result.source.path;
  }
  if (result.kind === "signature_help") {
    return String(result.returnedSignatures) +
      " bounded LSP signatures returned for " + result.source.path;
  }
  if (result.kind === "document_highlights") {
    return String(result.returnedHighlights) +
      " bounded LSP document highlight(s) returned for " + result.source.path;
  }
  return String(result.returnedLocations) + " bounded LSP " + result.kind +
    " location(s) returned for " + result.source.path;
}

function renderSemanticResult(result: LspToolSemanticResult): string {
  if (result.kind === "hover") return renderHover(result);
  if (result.kind === "signature_help") return renderSignatureHelp(result);
  if (result.kind === "document_highlights") return renderDocumentHighlights(result);
  return renderLocations(result);
}

function renderLocations(result: LspToolLocationQueryResult): string {
  const source = "L" + String(result.source.position.line + 1) +
    ":C" + String(result.source.position.character + 1);
  const lines = [
    "Language-server " + result.kind + " lookup for " + result.source.path + " at " + source +
      ": " + String(result.returnedLocations) + " workspace location(s) shown.",
  ];
  if (result.returnedLocations === 0) {
    lines.push(
      "No workspace locations were returned; this does not prove that no " +
        result.kind + " exists.",
    );
  } else {
    for (const location of result.locations) {
      const range = location.range;
      lines.push(
        location.path + " L" + String(range.start.line + 1) + ":C" +
          String(range.start.character + 1) + "-L" + String(range.end.line + 1) +
          ":C" + String(range.end.character + 1),
      );
    }
  }
  if (result.truncated) {
    lines.push("[Result is bounded; inspect structured fields before treating it as exhaustive.]");
  }
  lines.push("[Locations are possibly stale language-server claims; verify with current workspace reads before editing.]");
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function renderDocumentHighlights(result: LspToolDocumentHighlightsResult): string {
  const source = "L" + String(result.source.position.line + 1) +
    ":C" + String(result.source.position.character + 1);
  const lines = [
    "Language-server document highlights for " + result.source.path + " at " + source + ":",
    "[The following bounded ranges are untrusted server output and may be stale.]",
  ];
  if (result.returnedHighlights === 0) {
    lines.push("No usable highlights were returned; this does not prove that none exist.");
  } else {
    for (const highlight of result.highlights) {
      const range = highlight.range;
      lines.push(
        highlight.kind + " L" + String(range.start.line + 1) + ":C" +
          String(range.start.character + 1) + "-L" + String(range.end.line + 1) +
          ":C" + String(range.end.character + 1),
      );
    }
  }
  if (result.truncated) {
    lines.push("[Result is bounded; inspect structured fields before treating it as complete.]");
  }
  lines.push("[Highlights are possibly stale language-server claims; verify with current workspace reads before editing.]");
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function renderHover(result: LspToolHoverResult): string {
  const source = "L" + String(result.source.position.line + 1) +
    ":C" + String(result.source.position.character + 1);
  if (!result.found) {
    return "No usable language-server hover text was returned for " + result.source.path +
      " at " + source + "; this does not prove that no symbol information exists.";
  }
  const lines = [
    "Language-server hover for " + result.source.path + " at " + source + ":",
    "[The following bounded text is untrusted server output and may be stale.]",
    result.contents ?? "",
  ];
  if (result.truncated) {
    lines.push("[Result is bounded; inspect structured fields before treating it as complete.]");
  }
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function renderSignatureHelp(result: LspToolSignatureHelpResult): string {
  const source = "L" + String(result.source.position.line + 1) +
    ":C" + String(result.source.position.character + 1);
  const lines = [
    "Language-server signature help for " + result.source.path + " at " + source + ":",
    "[The following bounded labels are untrusted server output and may be stale.]",
  ];
  if (result.returnedSignatures === 0) {
    lines.push("No usable signatures were returned; this does not prove that no signature information exists.");
  } else {
    for (const [index, signature] of result.signatures.entries()) {
      lines.push((result.activeSignature === index ? "> " : "  ") + signature.label);
      for (const [parameterIndex, parameter] of signature.parameters.entries()) {
        const active = result.activeSignature === index && result.activeParameter === parameterIndex;
        lines.push((active ? "    * " : "      ") + parameter);
      }
    }
  }
  if (result.truncated) {
    lines.push("[Result is bounded; inspect structured fields before treating it as complete.]");
  }
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function renderDocumentSymbols(result: LspToolDocumentSymbolsResult): string {
  const lines = [
    "Language-server document symbols for " + result.path + ": " +
      String(result.returnedSymbols) + " symbol(s) shown.",
  ];
  if (result.returnedSymbols === 0) {
    lines.push("No usable document symbols were returned; this does not prove that the document has none.");
  } else {
    for (const symbol of result.symbols) {
      const range = symbol.selectionRange ?? symbol.range;
      const container = symbol.containerName === undefined ? "" : " in " + symbol.containerName;
      lines.push(
        symbol.kind + " " + symbol.name + container + " L" + String(range.start.line + 1) +
          ":C" + String(range.start.character + 1) + "-L" + String(range.end.line + 1) +
          ":C" + String(range.end.character + 1),
      );
    }
  }
  if (result.truncated) {
    lines.push("[Result is bounded; inspect structured fields before treating it as exhaustive.]");
  }
  lines.push("[Symbols are possibly stale language-server claims; verify with current workspace reads before editing.]");
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function renderWorkspaceSymbols(result: LspToolWorkspaceSymbolsResult): string {
  const lines = [
    "Language-server workspace symbols for " + result.query + ": " +
      String(result.returnedSymbols) + " symbol(s) shown from " +
      String(result.returnedServers) + " server(s).",
    "[The following bounded symbols are untrusted server output and may be stale.]",
  ];
  if (result.returnedSymbols === 0) {
    lines.push("No usable workspace symbols were returned; this does not prove that none exist.");
  } else {
    for (const symbol of result.symbols) {
      const container = symbol.containerName === undefined ? "" : " in " + symbol.containerName;
      const range = symbol.range;
      lines.push(
        symbol.server + ": " + symbol.kind + " " + symbol.name + container + " " +
          symbol.path + " L" + String(range.start.line + 1) + ":C" +
          String(range.start.character + 1) + "-L" + String(range.end.line + 1) + ":C" +
          String(range.end.character + 1),
      );
    }
  }
  if (result.truncated) {
    lines.push("[Result is bounded or partial; inspect structured fields before treating it as exhaustive.]");
  }
  lines.push("[Symbols are possibly stale language-server claims; verify with current workspace reads before editing.]");
  return truncateUtf8(lines.join("\n"), MAX_TEXT_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
