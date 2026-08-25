import {
  normalizeLspHoverQuery,
  normalizeLspLocationQuery,
  normalizeLspDocumentSymbolQuery,
  normalizeLspSignatureHelpQuery,
  type LspDiagnostic,
  type LspDiagnosticSnapshot,
  type LspDocumentSymbol,
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
  LspDiagnosticLookup,
  LspQueryResult,
  LspReferencesRequest,
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
const MAX_SEMANTIC_LOCATIONS = 32;
const MAX_SEMANTIC_POSITION_COMPONENT = 1_000_000;
const MAX_SEMANTIC_HOVER_BYTES = 8 * 1_024;
const MAX_SEMANTIC_SIGNATURES = 16;
const MAX_SEMANTIC_SIGNATURE_PARAMETERS = 16;
const MAX_SEMANTIC_SIGNATURE_LABEL_BYTES = 2 * 1_024;
const MAX_SEMANTIC_PARAMETER_LABEL_BYTES = 512;
const MAX_DOCUMENT_SYMBOLS = 32;
const MAX_DOCUMENT_SYMBOL_NAME_BYTES = 256;
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE = /\s+/g;

export interface LspDiagnosticsReader {
  diagnostics(path: string): Promise<LspDiagnosticLookup>;
}
export interface LspDocumentSymbolsReader {
  documentSymbols(path: string): Promise<LspQueryResult>;
}


export interface LspSemanticReader {
  definition(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  declaration(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  typeDefinition(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  implementation(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  references(input: LspReferencesRequest): Promise<LspQueryResult>;
  hover(input: LspTextDocumentPosition): Promise<LspQueryResult>;
  signatureHelp(input: LspTextDocumentPosition): Promise<LspQueryResult>;
}

export interface LspToolReader extends
  LspDiagnosticsReader,
  LspDocumentSymbolsReader,
  LspSemanticReader {}

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

type LspToolSemanticResult =
  | LspToolLocationQueryResult
  | LspToolHoverResult
  | LspToolSignatureHelpResult;

export type LspDiagnosticsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspDocumentSymbolsBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
export type LspSemanticBridge = (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
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
 * Semantic LSP queries are process-supervised and read-only. This boundary still
 * treats every server response as untrusted and exposes only normalized output.
 */
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

/** Combine diagnostics, document symbols, and semantic queries behind one LSP bridge. */
export function createLspToolBridge(
  reader: LspToolReader,
  options: LspSemanticBridgeOptions,
): LspToolBridge {
  const diagnostics = createLspDiagnosticsBridge(reader);
  const documentSymbols = createLspDocumentSymbolsBridge(reader, options);
  const semantic = createLspSemanticBridge(reader, options);
  return async (action, signal) =>
    action.toolId === "lsp.diagnostics"
      ? await diagnostics(action, signal)
      : action.toolId === "lsp.symbols"
      ? await documentSymbols(action, signal)
      : await semantic(action, signal);
}

function cancelledSemantic(): Execution {
  return {
    result: errorResult("CANCELLED", "LSP semantic query was cancelled", { retryable: true }),
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

function lspPath(action: ProposedAction): string | undefined {
  const raw = lspArguments(action);
  return raw === undefined ? undefined : lspPathFromArguments(raw, 4_096);
}

function lspArguments(action: ProposedAction): Record<string, unknown> | undefined {
  return isRecord(action.arguments) ? action.arguments : undefined;
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

type SemanticRequest = {
  readonly kind: LspLocationQueryKind | "hover" | "signature_help";
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
  return String(result.returnedLocations) + " bounded LSP " + result.kind +
    " location(s) returned for " + result.source.path;
}

function renderSemanticResult(result: LspToolSemanticResult): string {
  if (result.kind === "hover") return renderHover(result);
  if (result.kind === "signature_help") return renderSignatureHelp(result);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
