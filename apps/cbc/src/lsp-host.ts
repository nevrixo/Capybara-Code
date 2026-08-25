/**
 * Managed, globally configured LSP indexing.
 *
 * The host deliberately limits language servers to a trusted Build workspace,
 * read-only document-symbol requests, and bounded protocol frames. LSP output
 * enriches RepositoryIntelligence; it never becomes unbounded model context.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { LspServerConfig } from "@cbc/config-schema";
import {
  buildLspEditPlan,
  collectLspWorkspaceEditPaths,
  normalizeLspDiagnostics,
  normalizeLspPullDiagnostics,
  normalizeLspWorkspaceDiagnostics,
  type LspDiagnosticSnapshot,
  type LspEditDocument,
  type LspEditPlanResult,
  type LspWorkspaceEdit,
} from "@cbc/lsp-domain";
import type {
  RepoFile,
  RepositoryIntelligence,
  RepositorySymbolKind,
  SymbolInput,
  SymbolRange,
} from "@cbc/context-engine";
import { actionHash, type ProposedAction } from "@cbc/permissions";
import type { SidebarService } from "@cbc/tui-components";

import type { Runtime } from "./runtime.ts";

export type LspServiceStatus = SidebarService;

type LspRuntime = Pick<
  Runtime,
  "issueCapability" | "startJob" | "sendInput" | "stopJob" | "subscribeNotifications"
>;

export interface LspServerDescriptor {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: readonly string[];
  readonly languageId: string;
  readonly enabled: boolean;
  readonly installHint: string;
  readonly timeoutMs: number;
}

/** Convert global config into deterministic runtime descriptors without adding defaults. */
export function configuredLspServers(
  servers: Readonly<Record<string, LspServerConfig>>,
): readonly LspServerDescriptor[] {
  return Object.entries(servers)
    .map(([name, server]) => ({
      name,
      command: server.command,
      args: [...(server.args ?? [])],
      extensions: [...server.extensions],
      languageId: server.languageId,
      enabled: server.enabled !== false,
      installHint:
        server.installHint ?? `install '${server.command}' and make it available on PATH`,
      timeoutMs: server.timeoutMs ?? 15_000,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const MAX_LSP_DOCUMENTS_PER_LANGUAGE = 64;
const MAX_LSP_DIAGNOSTIC_DOCUMENTS = MAX_LSP_DOCUMENTS_PER_LANGUAGE * 2;
const MAX_LSP_DIAGNOSTIC_SERVERS = 8;
const MAX_LSP_WORKSPACE_DIAGNOSTIC_SNAPSHOTS = 32;
const MAX_LSP_WORKSPACE_DIAGNOSTICS_PER_SNAPSHOT = 64;
const MAX_LSP_WORKSPACE_SYMBOL_SERVERS = 8;
const MAX_LSP_WORKSPACE_SYMBOL_QUERY_BYTES = 512;
const UNSAFE_LSP_QUERY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const MAX_LSP_DOCUMENT_BYTES = 1_000_000;
const MAX_LSP_SYMBOLS_PER_DOCUMENT = 512;
const MAX_LSP_PARALLEL_REQUESTS = 4;
const DEFAULT_MAX_LSP_PENDING_REQUESTS = 64;
const MAX_LSP_HEADER_BYTES = 16 * 1024;
const MAX_LSP_FRAME_BYTES = 1_024 * 1_024;
const MAX_LSP_TOTAL_OUTPUT_BYTES = 32 * 1_024 * 1_024;

const CRLF_HEADER_END = Buffer.from("\r\n\r\n", "ascii");
const LF_HEADER_END = Buffer.from("\n\n", "ascii");

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface TrackedDiagnosticDocument {
  readonly uri: string;
  readonly path: string;
  readonly document: LspEditDocument;
  readonly version: number;
}


interface LspProcess {
  readonly descriptor: LspServerDescriptor;
  readonly protocolChannel: string;
  readonly pending: Map<number, PendingRequest>;
  readonly diagnosticDocuments: Map<string, TrackedDiagnosticDocument>;
  jobId?: string | undefined;
  unsubscribe?: (() => void) | undefined;
  buffer: Buffer;
  totalOutputBytes: number;
  stopped: boolean;
  nextRequestId: number;
  nextDocumentVersion: number;
  supportsPullDiagnostics: boolean;
  supportsWorkspaceDiagnostics: boolean;
  supportsPrepareRename: boolean;
}

interface ServiceState {
  readonly descriptor: LspServerDescriptor;
  status: SidebarService;
}

interface IndexedDocument {
  readonly file: RepoFile;
  readonly symbols: readonly SymbolInput[];
  readonly failed: boolean;
}

/** A zero-based UTF-16 text location, matching the LSP wire protocol. */
export interface LspTextDocumentPosition {
  readonly path: string;
  readonly line: number;
  readonly character: number;
}

export interface LspReferencesRequest extends LspTextDocumentPosition {
  readonly includeDeclaration?: boolean;
}

export interface LspRenameRequest extends LspTextDocumentPosition {
  readonly newName: string;
}

export interface LspQueryResult {
  readonly server: string;
  readonly result: unknown;
}

/** Bounded, current diagnostic evidence for one workspace-relative document. */
export interface LspDiagnosticLookup {
  readonly snapshots: readonly LspDiagnosticSnapshot[];
  /** Number of current server snapshots before the return cap is applied. */
  readonly totalServers: number;
  readonly truncatedServers: boolean;
}

const EMPTY_LSP_DIAGNOSTIC_LOOKUP: LspDiagnosticLookup = Object.freeze({
  snapshots: Object.freeze([]) as readonly LspDiagnosticSnapshot[],
  totalServers: 0,
  truncatedServers: false,
});

/** A semantic rename proposal. Applying it still requires the fs.edit authority path. */
export interface LspRenamePreview {
  readonly server: string;
  readonly workspaceEdit: LspWorkspaceEdit;
  readonly edit: LspEditPlanResult;
}

export interface LspHostOptions {
  readonly runtime: LspRuntime;
  /** The complete server catalog from the one global configuration file. */
  readonly servers: Readonly<Record<string, LspServerConfig>>;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  /** Starting an external language server is never allowed for untrusted code. */
  readonly workspaceTrusted: boolean;
  /** Explicit rollout gate; omitted for backwards-compatible direct host use. */
  readonly enabled?: boolean;
  /** Exact runtime workspace identity required for semantic edit proposals. */
  readonly workspaceIdentityDigest?: () => string | undefined;
  /** Reads the current interaction mode. A thrown observer fails closed to Plan. */
  readonly isBuildMode?: () => boolean;
  /** Testable executable lookup. The default uses Bun's PATH-aware resolver. */
  readonly resolveExecutable?: (command: string) => string | undefined;
  /** Trusted workspace reader used to open a bounded document for an LSP request. */
  readonly readFile?: (path: string) => Promise<string | undefined>;
  /**
   * Obtains a complete, runtime-authoritative document snapshot for an edit
   * proposal. It must never use the host filesystem directly.
   */
  readonly readEditDocument?: (path: string) => Promise<LspEditDocument | undefined>;
  /** Semantic rename remains unavailable until both LSP and edit rollouts allow it. */
  readonly allowRenamePreview?: boolean;
  /** Mirrors the configured structured-edit operation ceiling. */
  readonly maxEditOperations?: number;
  /** Upper bound on runtime document snapshots acquired for one LSP proposal. */
  readonly maxEditPaths?: number;
  /** Upper bound on UTF-8 bytes introduced by one LSP-generated edit proposal. */
  readonly maxEditChangedBytes?: number;
  /** Upper bound on unresolved JSON-RPC requests for one server process. */
  readonly maxPendingRequests?: number;
  /** Called whenever a sidebar-visible service state changes. */
  readonly onStatus?: (servers: readonly SidebarService[]) => void;
}

/** Resolve without spawning or downloading an executable. */
export function resolveLspExecutable(command: string): string | undefined {
  const bun = globalThis as unknown as {
    Bun?: { which?: (name: string) => string | null | undefined };
  };
  const resolved = bun.Bun?.which?.(command);
  return typeof resolved === "string" && resolved.length > 0 ? resolved : undefined;
}

/**
 * Launches local LSP processes only on demand after a repository scan. The
 * process protocol is supervised by the Rust runtime rather than Bun directly.
 */
export class LspHost {
  readonly #options: LspHostOptions;
  readonly #servers: readonly LspServerDescriptor[];
  readonly #services = new Map<string, ServiceState>();
  readonly #processes = new Map<string, LspProcess>();
  readonly #diagnosticSnapshots = new Map<string, LspDiagnosticSnapshot>();
  #lastFiles: readonly RepoFile[] = [];
  #lastIntelligence: RepositoryIntelligence | undefined;
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;
  #paused = false;
  #closed = false;

  constructor(options: LspHostOptions) {
    this.#options = options;
    this.#servers = configuredLspServers(options.servers);
    for (const descriptor of this.#servers) {
      this.#services.set(descriptor.name, {
        descriptor,
        status: options.enabled === false
          ? {
              name: descriptor.name,
              state: "disabled",
              detail: "disabled by experimental.fullLsp",
            }
          : !descriptor.enabled
          ? {
              name: descriptor.name,
              state: "disabled",
              detail: "disabled by global config",
            }
          : options.workspaceTrusted
            ? {
                name: descriptor.name,
                state: "starting",
                detail: "waiting for repository scan",
              }
            : {
                name: descriptor.name,
                state: "disabled",
                detail: "workspace is not trusted",
              },
      });
    }
    this.#emitStatuses();
  }

  statuses(): readonly SidebarService[] {
    return [...this.#services.values()]
      .map((service) => service.status)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Request workspace-scoped semantic locations without filesystem authority. */
  async definition(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/definition", input);
  }

  async declaration(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/declaration", input);
  }

  async typeDefinition(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/typeDefinition", input);
  }

  async implementation(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/implementation", input);
  }

  async references(input: LspReferencesRequest): Promise<LspQueryResult> {
    return await this.#positionQuery(
      "textDocument/references",
      input,
      { context: { includeDeclaration: input.includeDeclaration ?? true } },
    );
  }

  async hover(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/hover", input);
  }

  async signatureHelp(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/signatureHelp", input);
  }

  /** Request bounded symbol highlights scoped to the supplied workspace document. */
  async documentHighlights(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/documentHighlight", input);
  }

  async documentSymbols(path: string): Promise<LspQueryResult> {
    workspaceFileUri(this.#options.workspaceRoot, path);
    const descriptor = this.#descriptorForPath(path);
    const process = await this.#startForQuery(descriptor);
    const result = await this.#documentSymbols(process, descriptor, path);
    this.#setStatus(descriptor.name, "ready", "document symbols ready");
    return { server: descriptor.name, result };
  }

  /**
   * Query each enabled, configured server for resolved workspace symbols.
   * Individual server failures are isolated so one unavailable language cannot
   * suppress safe results from another enabled server.
   */
  async workspaceSymbols(query: string): Promise<readonly LspQueryResult[]> {
    assertLspWorkspaceSymbolQuery(query);
    if (!this.#mayStart()) throw new Error(this.#unavailableDetail());

    const descriptors = this.#servers
      .filter((descriptor) => descriptor.enabled)
      .slice(0, MAX_LSP_WORKSPACE_SYMBOL_SERVERS);
    if (descriptors.length === 0) {
      throw new Error("no enabled language server is configured for workspace symbol queries");
    }

    const outcomes = await mapBounded(
      descriptors,
      MAX_LSP_PARALLEL_REQUESTS,
      async (descriptor): Promise<LspQueryResult | undefined> => {
        try {
          const process = await this.#startForQuery(descriptor);
          const result = await this.#request(
            process,
            "workspace/symbol",
            { query },
            descriptor.timeoutMs,
          );
          if (!this.#mayStart()) throw new Error("LSP workspace symbol query was cancelled");
          this.#setStatus(descriptor.name, "ready", "workspace symbols ready");
          return Object.freeze({ server: descriptor.name, result });
        } catch {
          if (this.#mayStart()) {
            this.#setStatus(descriptor.name, "degraded", "workspace symbol request unavailable");
          }
          return undefined;
        }
      },
    );
    const available = outcomes.filter(
      (outcome): outcome is LspQueryResult => outcome !== undefined,
    );
    if (available.length === 0) {
      throw new Error("LSP workspace symbol query is unavailable");
    }
    return Object.freeze(available);
  }

  /**
   * Return only diagnostics whose captured revision still matches a fresh,
   * runtime-authoritative document read. Capability-advertised pull diagnostics
   * may start the matching configured server; unsupported or invalid replies
   * stay unavailable rather than becoming evidence.
   */
  async diagnostics(path: string): Promise<LspDiagnosticLookup> {
    workspaceFileUri(this.#options.workspaceRoot, path);
    if (!this.#mayStart()) return EMPTY_LSP_DIAGNOSTIC_LOOKUP;
    if (await this.#readDiagnosticDocument(path) === undefined) {
      return EMPTY_LSP_DIAGNOSTIC_LOOKUP;
    }

    await this.#refreshDiagnostics(path);

    const document = await this.#readDiagnosticDocument(path);
    const workspaceIdentityDigest = this.#workspaceIdentityDigest();
    if (document === undefined || workspaceIdentityDigest === undefined) {
      return EMPTY_LSP_DIAGNOSTIC_LOOKUP;
    }

    const snapshots: LspDiagnosticSnapshot[] = [];
    let totalServers = 0;
    for (const descriptor of this.#servers) {
      const snapshot = this.#diagnosticSnapshots.get(this.#diagnosticCacheKey(descriptor.name, path));
      if (
        snapshot !== undefined &&
        snapshot.workspaceIdentityDigest === workspaceIdentityDigest &&
        snapshot.documentRevision === document.revision
      ) {
        totalServers += 1;
        if (snapshots.length < MAX_LSP_DIAGNOSTIC_SERVERS) snapshots.push(snapshot);
      }
    }
    return Object.freeze({
      snapshots: Object.freeze(snapshots),
      totalServers,
      truncatedServers: totalServers > snapshots.length,
    });
  }

  /**
   * Turn a server-produced WorkspaceEdit into a revision-bound proposal. This
   * never applies the result; callers must route the returned plan to fs.edit.
   */
  async renamePreview(input: LspRenameRequest): Promise<LspRenamePreview> {
    if (this.#options.allowRenamePreview === false) {
      throw new Error("LSP rename preview is disabled by configuration");
    }
    if (
      typeof input.newName !== "string" ||
      input.newName.trim().length === 0 ||
      Buffer.byteLength(input.newName, "utf8") > 1_024
    ) {
      throw new Error("LSP rename requires a non-empty name up to 1024 UTF-8 bytes");
    }
    assertLspPosition(input);
    const uri = workspaceFileUri(this.#options.workspaceRoot, input.path);
    const descriptor = this.#descriptorForPath(input.path);
    const process = await this.#startForQuery(descriptor);
    const result = await this.#withOpenedDocument(
      process,
      descriptor,
      input.path,
      uri,
      async (openedUri) => {
        const position = { line: input.line, character: input.character };
        if (process.supportsPrepareRename) {
          const prepared = await this.#request(
            process,
            "textDocument/prepareRename",
            { textDocument: { uri: openedUri }, position },
            descriptor.timeoutMs,
          );
          if (!renamePreparationAllowsPosition(prepared, input)) {
            throw new Error("LSP server does not allow rename at this position");
          }
        }
        return await this.#request(
          process,
          "textDocument/rename",
          { textDocument: { uri: openedUri }, position, newName: input.newName },
          descriptor.timeoutMs,
        );
      },
    );
    this.#setStatus(descriptor.name, "ready", "rename preview ready");
    const workspaceEdit = lspWorkspaceEdit(result);
    const edit = await this.#toEditPlan(workspaceEdit);
    return {
      server: descriptor.name,
      workspaceEdit,
      edit,
    };
  }

  /**
   * Save the live scan and asynchronously populate bounded document symbols.
   * Calls serialize so a filesystem refresh cannot race an earlier response.
   */
  indexRepository(
    files: readonly RepoFile[],
    intelligence: RepositoryIntelligence,
  ): Promise<void> {
    this.#lastFiles = [...files];
    this.#lastIntelligence = intelligence;
    const scheduled = this.#queue
      .catch(() => undefined)
      .then(async () => {
        const generation = this.#generation;
        await Promise.all(
          this.#servers.map((descriptor) =>
            this.#indexLanguage(descriptor, this.#lastFiles, intelligence, generation)),
        );
      });
    this.#queue = scheduled.catch(() => undefined);
    return scheduled;
  }

  /** Restart indexing from the latest authoritative scan after entering Build. */
  resume(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#paused = false;
    if (this.#lastIntelligence === undefined) {
      this.#emitStatuses();
      return Promise.resolve();
    }
    return this.indexRepository(this.#lastFiles, this.#lastIntelligence);
  }

  /** Stop all language servers before the runtime enters Plan mode. */
  async quiesce(): Promise<void> {
    if (this.#closed) return;
    this.#paused = true;
    this.#generation += 1;
    await Promise.all([...this.#processes.values()].map((process) => this.#stop(process)));
    for (const service of this.#services.values()) {
      this.#setStatus(
        service.descriptor.name,
        "disabled",
        this.#options.enabled === false ? "disabled by experimental.fullLsp" : "paused in Plan mode",
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    await Promise.all([...this.#processes.values()].map((process) => this.#stop(process)));
    for (const service of this.#services.values()) {
      this.#setStatus(service.descriptor.name, "disabled", "session closed");
    }
  }

  async #positionQuery(
    method:
      | "textDocument/definition"
      | "textDocument/declaration"
      | "textDocument/typeDefinition"
      | "textDocument/implementation"
      | "textDocument/references"
      | "textDocument/hover"
      | "textDocument/signatureHelp"
      | "textDocument/documentHighlight"
      | "textDocument/rename",
    input: LspTextDocumentPosition,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<LspQueryResult> {
    assertLspPosition(input);
    const uri = workspaceFileUri(this.#options.workspaceRoot, input.path);
    const descriptor = this.#descriptorForPath(input.path);
    const process = await this.#startForQuery(descriptor);
    const result = await this.#withOpenedDocument(
      process,
      descriptor,
      input.path,
      uri,
      async (openedUri) =>
        await this.#request(
          process,
          method,
          {
            ...extra,
            textDocument: { uri: openedUri },
            position: { line: input.line, character: input.character },
          },
          descriptor.timeoutMs,
        ),
    );
    this.#setStatus(descriptor.name, "ready", "semantic query ready");
    return { server: descriptor.name, result };
  }

  #descriptorForPath(path: string): LspServerDescriptor {
    if (!this.#mayStart()) {
      throw new Error(this.#unavailableDetail());
    }
    const normalized = path.toLowerCase();
    const descriptor = this.#servers.find(
      (candidate) =>
        candidate.extensions.some((extension) => normalized.endsWith(extension.toLowerCase())),
    );
    if (descriptor === undefined) {
      throw new Error("no configured language server supports " + path);
    }
    if (!descriptor.enabled) {
      throw new Error("language server is disabled by global config");
    }
    return descriptor;
  }

  #unavailableDetail(): string {
    if (this.#options.enabled === false) return "LSP is disabled by experimental.fullLsp";
    if (!this.#options.workspaceTrusted) return "LSP is unavailable in an untrusted workspace";
    if (this.#closed) return "LSP session is closed";
    return "LSP queries require trusted Build mode";
  }

  async #startForQuery(descriptor: LspServerDescriptor): Promise<LspProcess> {
    const executable = (this.#options.resolveExecutable ?? resolveLspExecutable)(descriptor.command);
    if (executable === undefined) {
      this.#setStatus(descriptor.name, "down", "not installed; " + descriptor.installHint);
      throw new Error("language server executable is unavailable");
    }
    this.#setStatus(descriptor.name, "starting", "starting " + descriptor.command);
    try {
      return await this.#ensureProcess(descriptor);
    } catch (error) {
      if (!this.#closed) {
        this.#setStatus(descriptor.name, "down", "language server unavailable");
      }
      throw error;
    }
  }

  async #toEditPlan(workspaceEdit: LspWorkspaceEdit): Promise<LspEditPlanResult> {
    let workspaceIdentityDigest: string | undefined = undefined;
    try {
      workspaceIdentityDigest = this.#options.workspaceIdentityDigest?.();
    } catch {
      throw new Error("runtime workspace identity is unavailable");
    }
    if (typeof workspaceIdentityDigest !== "string" || workspaceIdentityDigest.trim().length === 0) {
      throw new Error("LSP edit preview requires a runtime workspace identity");
    }
    const readEditDocument = this.#options.readEditDocument;
    if (readEditDocument === undefined) {
      throw new Error("LSP edit preview requires runtime exact document snapshots");
    }

    const paths = collectLspWorkspaceEditPaths(workspaceEdit, this.#options.workspaceRoot);
    const maxPaths = this.#options.maxEditPaths ?? this.#options.maxEditOperations ?? 100;
    if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || paths.length > maxPaths) {
      throw new Error("LSP edit preview exceeds the configured document limit");
    }
    const documents: LspEditDocument[] = [];
    for (const path of paths) {
      const document = await readEditDocument(path);
      if (document === undefined) continue;
      if (document.path !== path) {
        throw new Error("runtime edit snapshot path did not match " + path);
      }
      documents.push(document);
    }
    const edit = buildLspEditPlan(workspaceEdit, {
      workspaceRoot: this.#options.workspaceRoot,
      workspaceIdentityDigest,
      sessionId: this.#options.sessionId,
      documents,
      ...(this.#options.maxEditOperations === undefined
        ? {}
        : { maxOperations: this.#options.maxEditOperations }),
    });
    const maxChangedBytes = this.#options.maxEditChangedBytes ?? 16_777_216;
    if (
      !Number.isSafeInteger(maxChangedBytes) ||
      maxChangedBytes < 1 ||
      lspEditPlanChangedBytes(edit) > maxChangedBytes
    ) {
      throw new Error("LSP edit preview exceeds the configured changed-byte limit");
    }
    return edit;
  }

  async #indexLanguage(
    descriptor: LspServerDescriptor,
    files: readonly RepoFile[],
    intelligence: RepositoryIntelligence,
    generation: number,
  ): Promise<void> {
    if (this.#options.enabled === false) {
      this.#setStatus(descriptor.name, "disabled", "disabled by experimental.fullLsp");
      return;
    }
    if (!descriptor.enabled) {
      this.#setStatus(descriptor.name, "disabled", "disabled by global config");
      return;
    }
    if (!this.#options.workspaceTrusted) {
      this.#setStatus(descriptor.name, "disabled", "workspace is not trusted");
      return;
    }
    if (!this.#mayStart()) {
      this.#setStatus(
        descriptor.name,
        "disabled",
        this.#closed ? "session closed" : "paused in Plan mode",
      );
      return;
    }

    const candidates = files
      .filter((file) => isLspCandidate(file, descriptor))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, MAX_LSP_DOCUMENTS_PER_LANGUAGE);
    if (candidates.length === 0) {
      this.#setStatus(descriptor.name, "disabled", "no " + descriptor.name + " source files");
      return;
    }

    const executable = (this.#options.resolveExecutable ?? resolveLspExecutable)(descriptor.command);
    if (executable === undefined) {
      this.#setStatus(
        descriptor.name,
        "down",
        "not installed; " + descriptor.installHint,
      );
      return;
    }

    this.#setStatus(descriptor.name, "starting", "starting " + descriptor.command);
    try {
      const process = await this.#ensureProcess(descriptor);
      if (!this.#isCurrent(generation)) return;
      const outcomes = await mapBounded(
        candidates,
        MAX_LSP_PARALLEL_REQUESTS,
        async (file): Promise<IndexedDocument> => {
          try {
            const result = await this.#documentSymbols(process, descriptor, file.path);
            return {
              file,
              symbols: normalizeLspDocumentSymbols(
                file.path,
                result,
                MAX_LSP_SYMBOLS_PER_DOCUMENT,
              ),
              failed: false,
            };
          } catch {
            return { file, symbols: [], failed: true };
          }
        },
      );
      if (!this.#isCurrent(generation)) return;

      let symbolCount = 0;
      let indexedFiles = 0;
      let failures = 0;
      for (const outcome of outcomes) {
        if (outcome.failed) {
          failures += 1;
          continue;
        }
        intelligence.replaceSymbols(outcome.file.path, outcome.symbols);
        indexedFiles += 1;
        symbolCount += outcome.symbols.length;
      }

      this.#setStatus(
        descriptor.name,
        failures === 0 ? "ready" : "degraded",
        symbolCount + " symbol(s) in " + indexedFiles + " file(s)" +
          (failures === 0 ? "" : "; " + failures + " request(s) unavailable"),
      );
    } catch {
      if (!this.#isCurrent(generation)) return;
      this.#setStatus(descriptor.name, "down", "language server unavailable");
    }
  }

  #mayStart(): boolean {
    if (this.#options.enabled === false || !this.#options.workspaceTrusted || this.#closed || this.#paused) return false;
    try {
      return this.#options.isBuildMode?.() !== false;
    } catch {
      return false;
    }
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#generation && !this.#closed && !this.#paused && this.#mayStart();
  }

  async #ensureProcess(descriptor: LspServerDescriptor): Promise<LspProcess> {
    const existing = this.#processes.get(descriptor.name);
    if (existing !== undefined && !existing.stopped && existing.jobId !== undefined) {
      return existing;
    }
    if (existing !== undefined) await this.#stop(existing);

    const protocolChannel =
      "lsp_" +
      createHash("sha256")
        .update(this.#options.sessionId + ":" + descriptor.name)
        .digest("hex")
        .slice(0, 24);
    const process: LspProcess = {
      descriptor,
      protocolChannel,
      pending: new Map(),
      diagnosticDocuments: new Map(),
      buffer: Buffer.alloc(0),
      totalOutputBytes: 0,
      stopped: false,
      nextRequestId: 1,
      nextDocumentVersion: 1,
      supportsPullDiagnostics: false,
      supportsWorkspaceDiagnostics: false,
      supportsPrepareRename: false,
    };
    this.#processes.set(descriptor.name, process);
    process.unsubscribe = this.#options.runtime.subscribeNotifications((method, params) => {
      this.#onRuntimeNotification(process, method, params);
    });

    const args = [...descriptor.args];
    const env: Record<string, string> = {};
    const action: ProposedAction = {
      callId: "lsp-stdio-start:" + protocolChannel,
      toolId: "process.start",
      arguments: {
        language: descriptor.name,
        program: descriptor.command,
        args,
        cwd: ".",
        env,
        network: "deny",
      },
      command: {
        program: descriptor.command,
        args,
        cwd: ".",
        env,
        networkIntent: { required: false },
      },
      display: [descriptor.command, ...args].join(" "),
    };
    const hash = actionHash(action);

    try {
      const capability = await this.#options.runtime.issueCapability({
        sessionId: this.#options.sessionId,
        callId: action.callId,
        actionHash: hash,
        operation: "lsp.stdio.start",
        resources: [environmentBinding(env)],
        program: descriptor.command,
        args,
        cwd: ".",
        network: "deny",
        ttlMs: 30_000,
      });
      if (!this.#mayStart() || this.#processes.get(descriptor.name) !== process) {
        throw new Error("LSP startup was cancelled");
      }
      const job = await this.#options.runtime.startJob({
        program: descriptor.command,
        args,
        cwd: ".",
        env,
        envPolicy: "inherit-safe",
        stdin: "pipe",
        network: "deny",
        maxOutputBytes: MAX_LSP_FRAME_BYTES,
        maxMemoryBytes: 512 * 1024 * 1024,
        capabilityOperation: "lsp.stdio.start",
        protocolChannel,
        capabilityReceipt: capability.id,
        capabilitySessionId: capability.sessionId,
        capabilityActionHash: capability.actionHash,
      });
      if (!this.#mayStart() || this.#processes.get(descriptor.name) !== process) {
        await this.#options.runtime.stopJob(job.jobId, 250, this.#options.sessionId).catch(() => undefined);
        throw new Error("LSP startup was cancelled");
      }
      process.jobId = job.jobId;

      const rootUri = pathToFileURL(this.#options.workspaceRoot).href;
      const initializeResult = await this.#request(process, "initialize", {
        processId: null,
        clientInfo: { name: "capy", version: "0.1.0" },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: {
          workspace: {
            diagnostic: {
              refreshSupport: false,
            },
          },
          textDocument: {
            declaration: { linkSupport: true },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            hover: { contentFormat: ["plaintext", "markdown"] },
            signatureHelp: {
              signatureInformation: {
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            documentHighlight: {},
            diagnostic: {
              dynamicRegistration: false,
              relatedDocumentSupport: false,
            },
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            publishDiagnostics: {
              versionSupport: true,
              relatedInformation: false,
              codeDescriptionSupport: false,
              dataSupport: false,
            },
          },
        },
      }, descriptor.timeoutMs);
      const diagnosticSupport = diagnosticCapabilitySupport(initializeResult);
      process.supportsPullDiagnostics = diagnosticSupport.document;
      process.supportsWorkspaceDiagnostics = diagnosticSupport.workspace;
      process.supportsPrepareRename = supportsPrepareRename(initializeResult);
      await this.#notify(process, "initialized", {});
      return process;
    } catch (error) {
      await this.#stop(process);
      throw error;
    }
  }

  async #documentSymbols(
    process: LspProcess,
    descriptor: LspServerDescriptor,
    path: string,
  ): Promise<unknown> {
    const uri = workspaceFileUri(this.#options.workspaceRoot, path);
    return await this.#withOpenedDocument(
      process,
      descriptor,
      path,
      uri,
      async (openedUri) =>
        await this.#request(
          process,
          "textDocument/documentSymbol",
          { textDocument: { uri: openedUri } },
          descriptor.timeoutMs,
        ),
    );
  }

  async #refreshDiagnostics(path: string): Promise<void> {
    let descriptor: LspServerDescriptor | undefined;
    let process: LspProcess | undefined;
    try {
      descriptor = this.#descriptorForPath(path);
      process = await this.#startForQuery(descriptor);
      let requested = false;
      let captured = 0;
      if (process.supportsPullDiagnostics) {
        requested = true;
        captured += (await this.#pullDiagnostics(process, descriptor, path)) ? 1 : 0;
      }
      if (process.supportsWorkspaceDiagnostics) {
        requested = true;
        captured += await this.#pullWorkspaceDiagnostics(process, descriptor, path);
      }
      if (!requested) {
        this.#setStatus(descriptor.name, "ready", "pull diagnostics not supported");
        return;
      }
      this.#setStatus(
        descriptor.name,
        "ready",
        captured > 0 ? "pull diagnostics ready" : "pull diagnostics yielded no fresh evidence",
      );
    } catch {
      if (descriptor !== undefined && process !== undefined && this.#mayStart()) {
        this.#setStatus(descriptor.name, "degraded", "pull diagnostics unavailable");
      }
    }
  }

  async #pullDiagnostics(
    process: LspProcess,
    descriptor: LspServerDescriptor,
    path: string,
  ): Promise<boolean> {
    const uri = workspaceFileUri(this.#options.workspaceRoot, path);
    return await this.#withOpenedDocument(
      process,
      descriptor,
      path,
      uri,
      async (openedUri, tracked) => {
        if (tracked === undefined) return false;
        const result = await this.#request(
          process,
          "textDocument/diagnostic",
          { textDocument: { uri: openedUri } },
          descriptor.timeoutMs,
        );
        if (!this.#mayStart()) {
          throw new Error("LSP pull diagnostics request was cancelled");
        }
        const workspaceIdentityDigest = this.#workspaceIdentityDigest();
        if (workspaceIdentityDigest === undefined) return false;
        const snapshot = normalizeLspPullDiagnostics(result, {
          workspaceRoot: this.#options.workspaceRoot,
          workspaceIdentityDigest,
          server: descriptor.name,
          uri: openedUri,
          document: tracked.document,
          documentVersion: tracked.version,
          publishedAt: new Date().toISOString(),
        });
        if (snapshot === undefined || process.diagnosticDocuments.get(openedUri) !== tracked) {
          return false;
        }
        this.#diagnosticSnapshots.set(
          this.#diagnosticCacheKey(descriptor.name, snapshot.path),
          snapshot,
        );
        return true;
      },
    );
  }

  async #pullWorkspaceDiagnostics(
    process: LspProcess,
    descriptor: LspServerDescriptor,
    path: string,
  ): Promise<number> {
    const uri = workspaceFileUri(this.#options.workspaceRoot, path);
    const document = await this.#readDiagnosticDocument(path);
    const tracked = process.diagnosticDocuments.get(uri);
    if (
      document !== undefined &&
      tracked !== undefined &&
      tracked.path === path &&
      tracked.document.revision === document.revision
    ) {
      return await this.#requestWorkspaceDiagnostics(process, descriptor, uri);
    }
    if (document === undefined) return 0;
    return await this.#withOpenedDocument(
      process,
      descriptor,
      path,
      uri,
      async (_openedUri, openedTracked) =>
        openedTracked === undefined
          ? 0
          : await this.#requestWorkspaceDiagnostics(process, descriptor, uri),
    );
  }

  async #requestWorkspaceDiagnostics(
    process: LspProcess,
    descriptor: LspServerDescriptor,
    preferredUri: string,
  ): Promise<number> {
    const trackedDocuments = [...process.diagnosticDocuments.values()];
    if (trackedDocuments.length === 0) return 0;
    const result = await this.#request(
      process,
      "workspace/diagnostic",
      { previousResultIds: [] },
      descriptor.timeoutMs,
    );
    if (!this.#mayStart()) {
      throw new Error("LSP workspace diagnostics request was cancelled");
    }
    const workspaceIdentityDigest = this.#workspaceIdentityDigest();
    if (workspaceIdentityDigest === undefined) return 0;
    const normalized = normalizeLspWorkspaceDiagnostics(result, {
      workspaceRoot: this.#options.workspaceRoot,
      workspaceIdentityDigest,
      server: descriptor.name,
      documents: trackedDocuments.map((tracked) => ({
        uri: tracked.uri,
        document: tracked.document,
        documentVersion: tracked.version,
      })),
      publishedAt: new Date().toISOString(),
      preferredUri,
      maxSnapshots: MAX_LSP_WORKSPACE_DIAGNOSTIC_SNAPSHOTS,
      maxDiagnostics: MAX_LSP_WORKSPACE_DIAGNOSTICS_PER_SNAPSHOT,
    });
    const trackedByPath = new Map(trackedDocuments.map((tracked) => [tracked.path, tracked]));
    let captured = 0;
    for (const snapshot of normalized.snapshots) {
      const tracked = trackedByPath.get(snapshot.path);
      if (
        tracked === undefined ||
        process.diagnosticDocuments.get(tracked.uri) !== tracked
      ) {
        continue;
      }
      this.#diagnosticSnapshots.set(
        this.#diagnosticCacheKey(descriptor.name, snapshot.path),
        snapshot,
      );
      captured += 1;
    }
    return captured;
  }

  async #withOpenedDocument<T>(
    process: LspProcess,
    descriptor: LspServerDescriptor,
    path: string,
    uri: string,
    request: (uri: string, tracked: TrackedDiagnosticDocument | undefined) => Promise<T>,
  ): Promise<T> {
    const diagnosticDocument = await this.#readDiagnosticDocument(path);
    let text: string | undefined = diagnosticDocument?.text;
    if (text === undefined) {
      try {
        text = await this.#options.readFile?.(path);
      } catch {
        // A read failure should not prevent a workspace-aware server from loading
        // the same file directly from its sandboxed root.
        text = undefined;
      }
    }

    const opened =
      typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_LSP_DOCUMENT_BYTES;
    let tracked: TrackedDiagnosticDocument | undefined;
    if (opened) {
      const version =
        diagnosticDocument === undefined ? 1 : this.#nextDocumentVersion(process);
      if (diagnosticDocument !== undefined) {
        tracked = { uri, path, document: diagnosticDocument, version };
        this.#rememberDiagnosticDocument(process, tracked);
      }
      try {
        await this.#notify(process, "textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: descriptor.languageId,
            version,
            text,
          },
        });
      } catch (error) {
        if (tracked !== undefined) this.#forgetDiagnosticDocument(process, tracked);
        throw error;
      }
    }
    try {
      return await request(uri, tracked);
    } finally {
      if (opened) {
        await this.#notify(process, "textDocument/didClose", {
          textDocument: { uri },
        }).catch(() => undefined);
      }
    }
  }

  async #readDiagnosticDocument(path: string): Promise<LspEditDocument | undefined> {
    const readEditDocument = this.#options.readEditDocument;
    if (readEditDocument === undefined) return undefined;
    try {
      const document = await readEditDocument(path);
      if (
        document === undefined ||
        document.path !== path ||
        typeof document.text !== "string" ||
        typeof document.revision !== "string" ||
        document.revision.trim().length === 0 ||
        Buffer.byteLength(document.text, "utf8") > MAX_LSP_DOCUMENT_BYTES
      ) {
        return undefined;
      }
      return { path: document.path, text: document.text, revision: document.revision };
    } catch {
      return undefined;
    }
  }

  #nextDocumentVersion(process: LspProcess): number {
    const version = process.nextDocumentVersion;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("LSP document version counter is exhausted");
    }
    process.nextDocumentVersion = version + 1;
    return version;
  }

  #rememberDiagnosticDocument(
    process: LspProcess,
    tracked: TrackedDiagnosticDocument,
  ): void {
    process.diagnosticDocuments.delete(tracked.uri);
    process.diagnosticDocuments.set(tracked.uri, tracked);
    this.#diagnosticSnapshots.delete(this.#diagnosticCacheKey(process.descriptor.name, tracked.path));

    while (process.diagnosticDocuments.size > MAX_LSP_DIAGNOSTIC_DOCUMENTS) {
      const oldest = process.diagnosticDocuments.values().next().value;
      if (oldest === undefined) return;
      process.diagnosticDocuments.delete(oldest.uri);
      this.#diagnosticSnapshots.delete(
        this.#diagnosticCacheKey(process.descriptor.name, oldest.path),
      );
    }
  }

  #forgetDiagnosticDocument(process: LspProcess, tracked: TrackedDiagnosticDocument): void {
    if (process.diagnosticDocuments.get(tracked.uri) !== tracked) return;
    process.diagnosticDocuments.delete(tracked.uri);
    this.#diagnosticSnapshots.delete(this.#diagnosticCacheKey(process.descriptor.name, tracked.path));
  }

  #captureDiagnostics(process: LspProcess, params: unknown): void {
    const notification = asRecord(params);
    const uri = notification?.uri;
    if (typeof uri !== "string") return;
    const tracked = process.diagnosticDocuments.get(uri);
    if (tracked === undefined) return;
    const workspaceIdentityDigest = this.#workspaceIdentityDigest();
    if (workspaceIdentityDigest === undefined) return;

    try {
      const snapshot = normalizeLspDiagnostics(params, {
        workspaceRoot: this.#options.workspaceRoot,
        workspaceIdentityDigest,
        server: process.descriptor.name,
        document: tracked.document,
        documentVersion: tracked.version,
        publishedAt: new Date().toISOString(),
      });
      this.#diagnosticSnapshots.set(
        this.#diagnosticCacheKey(process.descriptor.name, snapshot.path),
        snapshot,
      );
    } catch {
      // Invalid, oversized, or stale server output remains unavailable evidence.
    }
  }

  #workspaceIdentityDigest(): string | undefined {
    try {
      const digest = this.#options.workspaceIdentityDigest?.();
      return typeof digest === "string" && digest.trim().length > 0 ? digest : undefined;
    } catch {
      return undefined;
    }
  }

  #diagnosticCacheKey(server: string, path: string): string {
    return server + "\u0000" + path;
  }

  #clearDiagnosticsForServer(server: string): void {
    for (const [key, snapshot] of this.#diagnosticSnapshots) {
      if (snapshot.server === server) this.#diagnosticSnapshots.delete(key);
    }
  }


  async #request(
    process: LspProcess,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (process.jobId === undefined || process.stopped) {
      throw new Error("LSP server is not running");
    }
    const maxPending = this.#options.maxPendingRequests ?? DEFAULT_MAX_LSP_PENDING_REQUESTS;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || process.pending.size >= maxPending) {
      throw new Error("language server has too many pending requests");
    }
    const id = process.nextRequestId;
    process.nextRequestId += 1;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        process.pending.delete(id);
        reject(new Error("LSP request timed out"));
      }, timeoutMs);
      process.pending.set(id, { resolve, reject, timer });
      void this.#send(process, {
        jsonrpc: "2.0",
        id,
        method,
        params,
      }).catch((error: unknown) => {
        const pending = process.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        process.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async #notify(
    process: LspProcess,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.#send(process, { jsonrpc: "2.0", method, params });
  }

  async #send(process: LspProcess, message: Record<string, unknown>): Promise<void> {
    const jobId = process.jobId;
    if (jobId === undefined || process.stopped) throw new Error("LSP server is not running");
    const body = JSON.stringify(message);
    const framed = "Content-Length: " + Buffer.byteLength(body, "utf8") + "\r\n\r\n" + body;
    await this.#options.runtime.sendInput({ jobId, data: framed }, this.#options.sessionId);
  }

  #onRuntimeNotification(process: LspProcess, method: string, params: unknown): void {
    const event = asRecord(params);
    if (event === undefined) return;
    if (
      method === "lsp.stdio.output" &&
      event.protocolChannel === process.protocolChannel &&
      typeof event.text === "string"
    ) {
      this.#acceptOutput(process, event.text);
      return;
    }
    if (method === "process.limit_warning" && event.jobId === process.jobId) {
      this.#protocolFailure(process, "language server exceeded a resource limit");
      return;
    }
    if (method === "process.exited" && event.jobId === process.jobId) {
      process.jobId = undefined;
      process.diagnosticDocuments.clear();
      this.#clearDiagnosticsForServer(process.descriptor.name);
      this.#rejectPending(process, new Error("LSP server exited"));
      process.unsubscribe?.();
      process.unsubscribe = undefined;
      if (!process.stopped && !this.#closed) {
        this.#setStatus(process.descriptor.name, "down", "language server exited");
      }
      if (this.#processes.get(process.descriptor.name) === process) {
        this.#processes.delete(process.descriptor.name);
      }
    }
  }

  #acceptOutput(process: LspProcess, text: string): void {
    if (process.stopped) return;
    process.totalOutputBytes += Buffer.byteLength(text, "utf8");
    if (process.totalOutputBytes > MAX_LSP_TOTAL_OUTPUT_BYTES) {
      this.#protocolFailure(process, "language server exceeded the output limit");
      return;
    }
    process.buffer = Buffer.concat([process.buffer, Buffer.from(text, "utf8")]);

    while (true) {
      const crlf = process.buffer.indexOf(CRLF_HEADER_END);
      const lf = process.buffer.indexOf(LF_HEADER_END);
      const headerEnd = crlf >= 0 ? crlf : lf;
      const delimiterLength = crlf >= 0 ? CRLF_HEADER_END.length : LF_HEADER_END.length;
      if (headerEnd < 0) {
        if (process.buffer.length > MAX_LSP_HEADER_BYTES) {
          this.#protocolFailure(process, "LSP header exceeds its limit");
        }
        return;
      }
      if (headerEnd > MAX_LSP_HEADER_BYTES) {
        this.#protocolFailure(process, "LSP header exceeds its limit");
        return;
      }
      const length = contentLength(process.buffer.subarray(0, headerEnd).toString("ascii"));
      if (length === undefined || length > MAX_LSP_FRAME_BYTES) {
        this.#protocolFailure(process, "invalid or oversized LSP frame");
        return;
      }
      const bodyStart = headerEnd + delimiterLength;
      const bodyEnd = bodyStart + length;
      if (process.buffer.length < bodyEnd) return;
      const body = process.buffer.subarray(bodyStart, bodyEnd);
      process.buffer = process.buffer.subarray(bodyEnd);
      try {
        this.#handleMessage(process, JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        this.#protocolFailure(process, "invalid JSON-RPC response from language server");
        return;
      }
    }
  }

  #handleMessage(process: LspProcess, raw: unknown): void {
    const message = asRecord(raw);
    if (
      message !== undefined &&
      message.id === undefined &&
      message.method === "textDocument/publishDiagnostics"
    ) {
      this.#captureDiagnostics(process, message.params);
      return;
    }
    if (message === undefined || typeof message.id !== "number") return;
    const pending = process.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    process.pending.delete(message.id);
    if (message.error !== undefined && message.error !== null) {
      pending.reject(new Error("LSP request failed"));
      return;
    }
    pending.resolve(message.result);
  }

  #protocolFailure(process: LspProcess, detail: string): void {
    if (process.stopped) return;
    this.#rejectPending(process, new Error(detail));
    if (!this.#closed) {
      this.#setStatus(process.descriptor.name, "down", "language server protocol error");
    }
    void this.#stop(process);
  }

  async #stop(process: LspProcess): Promise<void> {
    if (process.stopped) return;
    process.stopped = true;
    process.diagnosticDocuments.clear();
    this.#clearDiagnosticsForServer(process.descriptor.name);
    process.unsubscribe?.();
    process.unsubscribe = undefined;
    this.#rejectPending(process, new Error("LSP server stopped"));
    const jobId = process.jobId;
    process.jobId = undefined;
    if (this.#processes.get(process.descriptor.name) === process) {
      this.#processes.delete(process.descriptor.name);
    }
    if (jobId !== undefined) {
      await this.#options.runtime.stopJob(jobId, 500, this.#options.sessionId).catch(() => undefined);
    }
  }

  #rejectPending(process: LspProcess, error: Error): void {
    for (const [id, pending] of process.pending) {
      clearTimeout(pending.timer);
      process.pending.delete(id);
      pending.reject(error);
    }
  }

  #setStatus(
    name: string,
    state: SidebarService["state"],
    detail: string | undefined,
  ): void {
    const service = this.#services.get(name);
    if (service === undefined) return;
    service.status = {
      name,
      state,
      ...(detail === undefined ? {} : { detail }),
    };
    this.#emitStatuses();
  }

  #emitStatuses(): void {
    try {
      this.#options.onStatus?.(this.statuses());
    } catch {
      // A display callback must not affect the repository scan or process guard.
    }
  }
}

/** Convert LSP DocumentSymbol or SymbolInformation output into stable repo input. */
export function normalizeLspDocumentSymbols(
  path: string,
  raw: unknown,
  limit = MAX_LSP_SYMBOLS_PER_DOCUMENT,
): readonly SymbolInput[] {
  if (!Array.isArray(raw) || limit <= 0) return [];
  const out: SymbolInput[] = [];

  const visit = (value: unknown, parentName: string | undefined): void => {
    if (out.length >= limit) return;
    const symbol = asRecord(value);
    if (symbol === undefined) return;
    const name = typeof symbol.name === "string" ? symbol.name.trim() : "";
    const range = toSymbolRange(symbol.range) ?? toSymbolRange(asRecord(symbol.location)?.range);
    if (name.length === 0 || range === undefined) return;
    const containerName =
      typeof symbol.containerName === "string" && symbol.containerName.length > 0
        ? symbol.containerName
        : parentName;
    const selectionRange = toSymbolRange(symbol.selectionRange);
    out.push({
      name,
      kind: lspSymbolKind(symbol.kind),
      path,
      range,
      ...(selectionRange === undefined ? {} : { selectionRange }),
      ...(containerName === undefined ? {} : { containerName }),
      source: "lsp",
      confidence: 1,
    });

    if (Array.isArray(symbol.children)) {
      for (const child of symbol.children) visit(child, name);
    }
  };

  for (const symbol of raw) visit(symbol, undefined);
  return out;
}

function isLspCandidate(file: RepoFile, descriptor: LspServerDescriptor): boolean {
  if (file.binary || file.bytes > MAX_LSP_DOCUMENT_BYTES) return false;
  const path = file.path.toLowerCase();
  return descriptor.extensions.some((extension) => path.endsWith(extension));
}

function assertLspPosition(input: LspTextDocumentPosition): void {
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new Error("LSP query requires a workspace-relative path");
  }
  if (
    !Number.isSafeInteger(input.line) ||
    !Number.isSafeInteger(input.character) ||
    input.line < 0 ||
    input.character < 0
  ) {
    throw new Error("LSP positions must be zero-based non-negative integers");
  }
}

function assertLspWorkspaceSymbolQuery(query: string): void {
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    Buffer.byteLength(query, "utf8") > MAX_LSP_WORKSPACE_SYMBOL_QUERY_BYTES ||
    UNSAFE_LSP_QUERY_CHARACTERS.test(query)
  ) {
    throw new Error(
      "LSP workspace symbol query must be non-empty, control-free text up to " +
        String(MAX_LSP_WORKSPACE_SYMBOL_QUERY_BYTES) + " UTF-8 bytes",
    );
  }
}

function lspWorkspaceEdit(value: unknown): LspWorkspaceEdit {
  const record = asRecord(value);
  if (record === undefined || (record.changes === undefined && record.documentChanges === undefined)) {
    throw new Error("language server did not return a WorkspaceEdit");
  }
  return record as LspWorkspaceEdit;
}

/** Count only text emitted by the server; runtime preflight still checks every deletion. */
function lspEditPlanChangedBytes(edit: LspEditPlanResult): number {
  let total = 0;
  for (const operation of edit.plan.operations) {
    const text =
      operation.kind === "replace_range"
        ? operation.replacement
        : operation.kind === "create_file"
        ? operation.content
        : "";
    const bytes = Buffer.byteLength(text, "utf8");
    if (!Number.isSafeInteger(bytes) || bytes > Number.MAX_SAFE_INTEGER - total) {
      return Number.MAX_SAFE_INTEGER;
    }
    total += bytes;
  }
  return total;
}

function workspaceFileUri(workspaceRoot: string, path: string): string {
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error("LSP path must remain workspace-relative");
  }
  return pathToFileURL(join(workspaceRoot, ...parts)).href;
}

function environmentBinding(env: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  const entries = Object.entries(env).sort(([left], [right]) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  for (const [name, value] of entries) {
    hash.update(String(Buffer.byteLength(name, "utf8")));
    hash.update(":");
    hash.update(name);
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
  }
  return "env:sha256:" + hash.digest("hex");
}

function contentLength(header: string): number | undefined {
  let result: number | undefined;
  for (const line of header.split(/\r?\n/)) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
    if (match === null) continue;
    if (result !== undefined) return undefined;
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
    result = parsed;
  }
  return result;
}

function diagnosticCapabilitySupport(value: unknown): {
  readonly document: boolean;
  readonly workspace: boolean;
} {
  const initialize = asRecord(value);
  const capabilities = asRecord(initialize?.capabilities);
  const diagnosticProvider = capabilities?.diagnosticProvider;
  const provider = asRecord(diagnosticProvider);
  if (provider === undefined || Array.isArray(diagnosticProvider)) {
    return { document: false, workspace: false };
  }
  return {
    document: true,
    workspace: provider.workspaceDiagnostics === true,
  };
}

function supportsPrepareRename(value: unknown): boolean {
  const initialize = asRecord(value);
  const capabilities = asRecord(initialize?.capabilities);
  const renameProvider = capabilities?.renameProvider;
  const provider = asRecord(renameProvider);
  return provider !== undefined &&
    !Array.isArray(renameProvider) &&
    provider.prepareProvider === true;
}

function renamePreparationAllowsPosition(
  value: unknown,
  input: LspTextDocumentPosition,
): boolean {
  const result = asRecord(value);
  if (result === undefined || Array.isArray(value)) return false;
  if (result.defaultBehavior === true) return true;

  const rawRange = result.range ?? result;
  const range = asRecord(rawRange);
  if (range === undefined || Array.isArray(rawRange)) return false;
  const start = asRecord(range.start);
  const end = asRecord(range.end);
  const startLine = integer(start?.line);
  const startCharacter = integer(start?.character);
  const endLine = integer(end?.line);
  const endCharacter = integer(end?.character);
  if (
    startLine === undefined ||
    startCharacter === undefined ||
    endLine === undefined ||
    endCharacter === undefined ||
    startLine < 0 ||
    startCharacter < 0 ||
    endLine < 0 ||
    endCharacter < 0
  ) {
    return false;
  }
  const startBeforeOrAt =
    startLine < input.line ||
    (startLine === input.line && startCharacter <= input.character);
  const endAfterOrAt =
    endLine > input.line ||
    (endLine === input.line && endCharacter >= input.character);
  const rangeIsOrdered =
    endLine > startLine ||
    (endLine === startLine && endCharacter >= startCharacter);
  return startBeforeOrAt && endAfterOrAt && rangeIsOrdered;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function toSymbolRange(value: unknown): SymbolRange | undefined {
  const range = asRecord(value);
  const start = asRecord(range?.start);
  const end = asRecord(range?.end);
  const startLineRaw = integer(start?.line);
  const startColumn = integer(start?.character);
  const endLineRaw = integer(end?.line);
  const endColumn = integer(end?.character);
  if (
    startLineRaw === undefined ||
    startColumn === undefined ||
    endLineRaw === undefined ||
    endColumn === undefined ||
    startLineRaw < 0 ||
    startColumn < 0 ||
    endLineRaw < startLineRaw ||
    endColumn < 0
  ) {
    return undefined;
  }
  const startLine = startLineRaw + 1;
  const endLine =
    endLineRaw === startLineRaw || endColumn > 0
      ? endLineRaw + 1
      : Math.max(startLine, endLineRaw);
  return {
    startLine,
    endLine,
    startColumn,
    endColumn,
  };
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function lspSymbolKind(value: unknown): RepositorySymbolKind {
  switch (value) {
    case 1:
      return "file";
    case 2:
      return "module";
    case 3:
      return "namespace";
    case 4:
      return "package";
    case 5:
      return "class";
    case 6:
      return "method";
    case 7:
      return "property";
    case 8:
      return "field";
    case 9:
      return "constructor";
    case 10:
      return "enum";
    case 11:
      return "interface";
    case 12:
      return "function";
    case 13:
      return "variable";
    case 14:
      return "constant";
    case 15:
    case 16:
    case 17:
    case 18:
    case 19:
      return "constant";
    case 20:
      return "key";
    case 22:
      return "enum_member";
    case 23:
      return "class";
    case 24:
      return "event";
    case 25:
      return "operator";
    case 26:
      return "type_parameter";
    default:
      return "unknown";
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = [];
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => run(),
    ),
  );
  return results;
}
