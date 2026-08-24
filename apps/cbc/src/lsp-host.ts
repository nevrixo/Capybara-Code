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

interface LspProcess {
  readonly descriptor: LspServerDescriptor;
  readonly protocolChannel: string;
  readonly pending: Map<number, PendingRequest>;
  jobId?: string | undefined;
  unsubscribe?: (() => void) | undefined;
  buffer: Buffer;
  totalOutputBytes: number;
  stopped: boolean;
  nextRequestId: number;
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

  /** Request semantic definitions without granting filesystem authority. */
  async definition(input: LspTextDocumentPosition): Promise<LspQueryResult> {
    return await this.#positionQuery("textDocument/definition", input);
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

  /**
   * Turn a server-produced WorkspaceEdit into a revision-bound proposal. This
   * never applies the result; callers must route the returned plan to fs.edit.
   */
  async renamePreview(input: LspRenameRequest): Promise<LspRenamePreview> {
    if (this.#options.allowRenamePreview === false) {
      throw new Error("LSP rename preview is disabled by configuration");
    }
    if (input.newName.trim().length === 0 || Buffer.byteLength(input.newName, "utf8") > 1_024) {
      throw new Error("LSP rename requires a non-empty name up to 1024 UTF-8 bytes");
    }
    const query = await this.#positionQuery(
      "textDocument/rename",
      input,
      { newName: input.newName },
    );
    const workspaceEdit = lspWorkspaceEdit(query.result);
    const edit = await this.#toEditPlan(workspaceEdit);
    return {
      server: query.server,
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
      | "textDocument/references"
      | "textDocument/hover"
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
    return buildLspEditPlan(workspaceEdit, {
      workspaceRoot: this.#options.workspaceRoot,
      workspaceIdentityDigest,
      sessionId: this.#options.sessionId,
      documents,
      ...(this.#options.maxEditOperations === undefined
        ? {}
        : { maxOperations: this.#options.maxEditOperations }),
    });
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
            const result = await this.#documentSymbols(process, descriptor, file);
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
      buffer: Buffer.alloc(0),
      totalOutputBytes: 0,
      stopped: false,
      nextRequestId: 1,
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
      await this.#request(process, "initialize", {
        processId: null,
        clientInfo: { name: "capy", version: "0.1.0" },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: {
          textDocument: {
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
          },
        },
      }, descriptor.timeoutMs);
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
    file: RepoFile,
  ): Promise<unknown> {
    const uri = workspaceFileUri(this.#options.workspaceRoot, file.path);
    return await this.#withOpenedDocument(
      process,
      descriptor,
      file.path,
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

  async #withOpenedDocument<T>(
    process: LspProcess,
    descriptor: LspServerDescriptor,
    path: string,
    uri: string,
    request: (uri: string) => Promise<T>,
  ): Promise<T> {
    let text: string | undefined;
    try {
      text = await this.#options.readFile?.(path);
    } catch {
      // A read failure should not prevent a workspace-aware server from loading
      // the same file directly from its sandboxed root.
      text = undefined;
    }
    const opened =
      typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_LSP_DOCUMENT_BYTES;
    if (opened) {
      await this.#notify(process, "textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: descriptor.languageId,
          version: 1,
          text,
        },
      });
    }
    try {
      return await request(uri);
    } finally {
      if (opened) {
        await this.#notify(process, "textDocument/didClose", {
          textDocument: { uri },
        }).catch(() => undefined);
      }
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

function lspWorkspaceEdit(value: unknown): LspWorkspaceEdit {
  const record = asRecord(value);
  if (record === undefined || (record.changes === undefined && record.documentChanges === undefined)) {
    throw new Error("language server did not return a WorkspaceEdit");
  }
  return record as LspWorkspaceEdit;
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
