/**
 * MCP client and manager — PRD §17.1, §17.3, §17.4, §17.7, §17.10, AC-29..AC-33.
 *
 * §17.1 states the posture: CBC is the client, and it controls lifecycle, auth,
 * discovery, permission, and result normalization. The model never talks to a
 * server; it asks CBC to, and CBC decides.
 */

import type { CbcEventKind } from "@cbc/protocol";
import type { ArtifactRef, ToolResult } from "@cbc/tool-registry";

import {
  buildDescriptors,
  searchCapabilities,
  type McpCapabilityDescriptor,
  type McpCapabilityRisk,
  type McpSearchMatch,
} from "./catalog.ts";
import { McpCatalog } from "./catalog.ts";
import {
  clientCapabilities,
  eraFor,
  MCP_ERROR_CODES,
  MCP_REVISION_CURRENT,
  negotiateRevision,
  parseInitializeResponse,
  refusalFor,
  type InitializeResponse,
  type McpCallToolResult,
  type McpEra,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpToolDescriptor,
} from "./protocol.ts";
import { normalizeResourceResult, normalizeToolResult, type NormalizedMcpResult } from "./results.ts";
import { McpProtocolError, McpTransportError, restartDelayMs, type McpTransport } from "./transport.ts";

export interface McpEmitter {
  emit<T>(kind: CbcEventKind, payload: T): void;
}

export type McpServerState =
  | "configured"
  | "starting"
  | "connecting"
  | "ready"
  | "degraded"
  | "failed"
  | "disabled"
  | "stopped";

export interface McpClientOptions {
  readonly serverName: string;
  readonly transport: McpTransport;
  readonly clientName?: string;
  readonly clientVersion: string;
  /** Workspace root, the only root exposed to a server (§17.4). */
  readonly workspaceRoot: string;
  readonly emitter?: McpEmitter;
  /** §17.2 escape hatch for a revision not built in. */
  readonly compatibleRevisions?: readonly string[];
  /** §17.8 step 1. */
  readonly riskOverrides?: Readonly<Record<string, McpCapabilityRisk>>;
  readonly spill?: (label: string, content: string, mediaType: string) => ArtifactRef | undefined;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface McpServerStatus {
  readonly server: string;
  readonly state: McpServerState;
  readonly transport: string;
  readonly revision?: string;
  readonly era?: McpEra;
  readonly serverInfo?: { name?: string; version?: string };
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly lastError?: string;
  readonly diagnostics: string[];
  /** Server-provided instructions, kept as untrusted text (§17.7). */
  readonly instructions?: string;
}

/** How many diagnostic lines to retain per server (§17.3 stderr capture). */
const MAX_DIAGNOSTICS = 50;

/**
 * One connected MCP server.
 *
 * Refusals for §17.4's disabled features are installed before `initialize`, so a
 * server cannot slip a sampling request in during the handshake.
 */
export class McpClient {
  readonly serverName: string;
  readonly #options: McpClientOptions;
  readonly #transport: McpTransport;
  readonly #catalog: McpCatalog;
  readonly #diagnostics: string[] = [];
  readonly #now: () => number;

  #state: McpServerState = "configured";
  #revision: string | undefined;
  #era: McpEra | undefined;
  #initialize: InitializeResponse | undefined;
  #lastError: string | undefined;
  #toolSchemas = new Map<string, Record<string, unknown> | undefined>();

  constructor(options: McpClientOptions, catalog?: McpCatalog) {
    this.serverName = options.serverName;
    this.#options = options;
    this.#transport = options.transport;
    this.#catalog = catalog ?? new McpCatalog();
    this.#now = options.now ?? (() => Date.now());
  }

  get state(): McpServerState {
    return this.#state;
  }

  /** Mark a configured server as scheduled without doing transport I/O yet. */
  markStarting(): void {
    if (this.#state === "configured") this.#state = "starting";
  }

  get era(): McpEra | undefined {
    return this.#era;
  }

  get revision(): string | undefined {
    return this.#revision;
  }

  get catalog(): McpCatalog {
    return this.#catalog;
  }

  status(): McpServerStatus {
    const capabilities = this.#catalog.snapshot(this.serverName)?.capabilities ?? [];
    return {
      server: this.serverName,
      state: this.#state,
      transport: this.#transport.kind,
      ...(this.#revision !== undefined ? { revision: this.#revision } : {}),
      ...(this.#era !== undefined ? { era: this.#era } : {}),
      ...(this.#initialize?.serverInfo !== undefined
        ? { serverInfo: this.#initialize.serverInfo }
        : {}),
      toolCount: capabilities.filter((c) => c.kind === "tool").length,
      resourceCount: capabilities.filter((c) => c.kind === "resource").length,
      promptCount: capabilities.filter((c) => c.kind === "prompt").length,
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
      diagnostics: [...this.#diagnostics],
      ...(this.#initialize?.instructions !== undefined
        ? { instructions: this.#initialize.instructions }
        : {}),
    };
  }

  /** Connect, negotiate, and load the catalog. */
  async connect(): Promise<McpServerStatus> {
    if (this.#state === "stopped") {
      throw new McpTransportError(`server '${this.serverName}' has been stopped`);
    }
    if (this.#state === "ready") return this.status();
    this.#state = "starting";
    this.#lastError = undefined;

    this.#transport.setDiagnosticHandler((line) => this.#recordDiagnostic(line));
    this.#transport.setNotificationHandler((notification) =>
      this.#handleNotification(notification.method, notification.params),
    );
    // §17.4: install refusals before the handshake.
    this.#transport.setServerRequestHandler(async (method, params) =>
      this.#handleServerRequest(method, params),
    );

    try {
      await this.#transport.start();
      if (this.#isStopped()) {
        throw new McpTransportError(`server '${this.serverName}' was stopped while starting`);
      }
      this.#state = "connecting";

      const raw = await this.#transport.request(
        "initialize",
        {
          protocolVersion: MCP_REVISION_CURRENT,
          capabilities: clientCapabilities(),
          clientInfo: {
            name: this.#options.clientName ?? "capybara-code",
            version: this.#options.clientVersion,
          },
        },
        this.#requestOptions(),
      );

      const parsed = parseInitializeResponse(raw);
      if (parsed === undefined) {
        throw new McpTransportError(
          `server '${this.serverName}' returned an unusable initialize result`,
        );
      }

      const negotiated = negotiateRevision(parsed.protocolVersion, {
        ...(this.#options.compatibleRevisions !== undefined
          ? { compatibleRevisions: this.#options.compatibleRevisions }
          : {}),
      });
      if (!negotiated.ok) {
        // §17.2: fail closed on a revision we cannot reason about.
        throw new McpTransportError(negotiated.reason);
      }

      this.#revision = negotiated.revision;
      this.#era = negotiated.era;
      this.#initialize = parsed;
      if (negotiated.note !== undefined) this.#recordDiagnostic(negotiated.note);

      await this.#transport.notify("notifications/initialized");

      await this.refreshCatalog();
      if (this.#isStopped()) {
        throw new McpTransportError(`server '${this.serverName}' was stopped while connecting`);
      }
      this.#state = "ready";
      this.#emit("job.started", {
        server: this.serverName,
        display: `mcp ${this.serverName} (${this.#transport.kind}, ${negotiated.revision})`,
      });
      return this.status();
    } catch (error) {
      if (!this.#isStopped()) this.#state = "failed";
      this.#lastError = describe(error);
      this.#emit("error.protocol", { server: this.serverName, message: this.#lastError });
      throw error;
    }
  }

  /**
   * Reload the capability catalog.
   *
   * A server may implement any subset of the primitives, so each list is attempted
   * only when the server declared the capability, and a `methodNotFound` is treated
   * as "not offered" rather than an error.
   */
  async refreshCatalog(): Promise<McpCapabilityDescriptor[]> {
    const declared = this.#initialize?.capabilities ?? {};

    // The three MCP primitives are independent after initialize. Listing them in
    // parallel keeps a slow resources server from serializing tool discovery.
    const [tools, resources, prompts] = await Promise.all([
      declared.tools !== undefined ? this.#listTools() : Promise.resolve([]),
      declared.resources !== undefined ? this.#listResources() : Promise.resolve([]),
      declared.prompts !== undefined ? this.#listPrompts() : Promise.resolve([]),
    ]);

    this.#toolSchemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));

    const descriptors = buildDescriptors({
      server: this.serverName,
      tools,
      resources,
      prompts,
      ...(this.#options.riskOverrides !== undefined
        ? { riskOverrides: this.#options.riskOverrides }
        : {}),
    });
    this.#catalog.set(this.serverName, descriptors);
    return descriptors;
  }

  /** The exact schema for a tool, loaded after selection (§17.7). */
  schemaFor(toolName: string): Record<string, unknown> | undefined {
    return this.#toolSchemas.get(toolName);
  }

  /**
   * Call a tool.
   *
   * Permission is *not* evaluated here: §17.1 puts that in the host's policy engine,
   * and doing it in two places would create a path where one is skipped. By the time
   * this runs, the call is already authorized.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<NormalizedMcpResult> {
    const raw = await this.#transport.request(
      "tools/call",
      { name: toolName, arguments: args },
      this.#requestOptions(options),
    );

    const result = (typeof raw === "object" && raw !== null ? raw : {}) as McpCallToolResult;
    return normalizeToolResult(result, {
      server: this.serverName,
      tool: toolName,
      ...(this.#options.spill !== undefined ? { spill: this.#options.spill } : {}),
    });
  }

  async readResource(
    uri: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<NormalizedMcpResult> {
    const raw = await this.#transport.request(
      "resources/read",
      { uri },
      this.#requestOptions(options),
    );
    return normalizeResourceResult(raw, {
      server: this.serverName,
      tool: `resource:${uri}`,
      uri,
      ...(this.#options.spill !== undefined ? { spill: this.#options.spill } : {}),
    });
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return await this.#transport.request(
      "prompts/get",
      { name, arguments: args },
      this.#requestOptions(options),
    );
  }

  async close(): Promise<void> {
    this.#state = "stopped";
    this.#catalog.remove(this.serverName);
    await this.#transport.close();
  }

  /**
   * Stop an eager/lazy handshake without permanently closing the configured
   * client. Plan entry uses this to cancel in-flight external startup; a later
   * explicitly authorized Build turn may reconnect the same transport.
   */
  async suspend(): Promise<void> {
    if (this.#state === "configured" || this.#state === "disabled" || this.#state === "stopped") return;
    this.#state = "stopped";
    this.#catalog.remove(this.serverName);
    await this.#transport.close().catch(() => undefined);
    this.#initialize = undefined;
    this.#revision = undefined;
    this.#era = undefined;
    this.#toolSchemas.clear();
    this.#lastError = undefined;
    this.#state = "configured";
  }

  async #listTools(): Promise<McpToolDescriptor[]> {
    return await this.#listPaged<McpToolDescriptor>("tools/list", "tools");
  }

  async #listResources(): Promise<McpResourceDescriptor[]> {
    return await this.#listPaged<McpResourceDescriptor>("resources/list", "resources");
  }

  async #listPrompts(): Promise<McpPromptDescriptor[]> {
    return await this.#listPaged<McpPromptDescriptor>("prompts/list", "prompts");
  }

  /** Drain a paginated list, bounded so a hostile server cannot loop forever. */
  async #listPaged<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      let raw: unknown;
      try {
        raw = await this.#transport.request(
          method,
          cursor === undefined ? {} : { cursor },
          this.#requestOptions(),
        );
      } catch (error) {
        if (error instanceof McpProtocolError && error.code === MCP_ERROR_CODES.methodNotFound) {
          // Declared but not implemented: report and move on.
          this.#recordDiagnostic(`'${method}' is declared but not implemented`);
          return out;
        }
        throw error;
      }

      if (typeof raw !== "object" || raw === null) return out;
      const record = raw as Record<string, unknown>;
      const items = record[key];
      if (Array.isArray(items)) out.push(...(items as T[]));

      const next = record.nextCursor;
      pages += 1;
      if (typeof next !== "string" || next.length === 0) return out;
      if (pages >= 20 || out.length >= 2_000) {
        this.#recordDiagnostic(
          `'${method}' pagination stopped after ${pages} page(s) and ${out.length} item(s)`,
        );
        return out;
      }
      cursor = next;
    }
  }

  #requestOptions(extra: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    return {
      ...(this.#revision !== undefined ? { protocolVersion: this.#revision } : {}),
      ...(this.#options.requestTimeoutMs !== undefined
        ? { timeoutMs: this.#options.requestTimeoutMs }
        : {}),
      ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
    };
  }

  #handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "notifications/tools/list_changed":
      case "notifications/resources/list_changed":
      case "notifications/prompts/list_changed":
        // §17.6: refresh on change rather than waiting out the TTL.
        this.#catalog.invalidate(this.serverName);
        this.#emit("notification.retry", {
          server: this.serverName,
          reason: `${method} — capability catalog invalidated`,
          attempt: 0,
        });
        return;

      case "notifications/message": {
        // §17.4 logging. Server text is untrusted, so it lands in diagnostics
        // rather than the timeline (§19.7 applies the same rule to runtime stderr).
        const record = (typeof params === "object" && params !== null ? params : {}) as Record<
          string,
          unknown
        >;
        const level = typeof record.level === "string" ? record.level : "info";
        const data = typeof record.data === "string" ? record.data : safeJson(record.data);
        this.#recordDiagnostic(`[${level}] ${data}`);
        return;
      }

      case "notifications/progress":
        this.#emit("tool.progress", { server: this.serverName, progress: params });
        return;

      default:
        // §20.4's tolerance principle: an unknown notification is not fatal.
        this.#recordDiagnostic(`unhandled notification '${method}'`);
    }
  }

  async #handleServerRequest(
    method: string,
    _params: unknown,
  ): Promise<{ result: unknown } | { error: { code: number; message: string; data?: Record<string, unknown> } }> {
    // §17.4: an explicit protocol error, so the server author sees the reason.
    const refusal = refusalFor(method);
    if (refusal !== undefined) {
      this.#recordDiagnostic(`refused server request '${method}'`);
      this.#emit("notification.retry", {
        server: this.serverName,
        reason: `refused '${method}': ${refusal.message}`,
        attempt: 0,
      });
      return { error: refusal };
    }

    if (method === "roots/list") {
      // §17.4: the workspace root, and nothing beyond it.
      return {
        result: {
          roots: [{ uri: pathToFileUri(this.#options.workspaceRoot), name: "workspace" }],
        },
      };
    }

    if (method === "ping") return { result: {} };

    return {
      error: {
        code: MCP_ERROR_CODES.methodNotFound,
        message: `'${method}' is not supported by this client`,
        data: { method },
      },
    };
  }

  #isStopped(): boolean {
    return this.#state === "stopped";
  }

  #recordDiagnostic(line: string): void {
    this.#diagnostics.push(`${new Date(this.#now()).toISOString()} ${line}`);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) this.#diagnostics.shift();
  }

  #emit<T>(kind: CbcEventKind, payload: T): void {
    this.#options.emitter?.emit(kind, payload);
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface ManagedServer {
  readonly name: string;
  readonly client: McpClient;
  /** Whether this server came from project config (§17.5, PERM-001). */
  readonly fromProjectConfig: boolean;
  readonly enabled: boolean;
}

export interface McpConnectResult {
  readonly server: string;
  readonly status?: McpServerStatus;
  readonly error?: string;
}

export interface McpManagerOptions {
  readonly catalog?: McpCatalog;
  readonly emitter?: McpEmitter;
  /** §17.3 restart budget for a stdio server that exits. */
  readonly maxRestarts?: number;
}

/**
 * Holds every configured server.
 *
 * One failing server must not take the others down: §22.6 lists an MCP server
 * crash among the faults CBC survives, so `connectAll` records failures and keeps
 * going.
 */
export class McpClientManager {
  readonly #servers = new Map<string, ManagedServer>();
  readonly #catalog: McpCatalog;
  readonly #options: McpManagerOptions;
  readonly #restarts = new Map<string, number>();
  readonly #connections = new Map<string, Promise<McpConnectResult>>();

  constructor(options: McpManagerOptions = {}) {
    this.#options = options;
    this.#catalog = options.catalog ?? new McpCatalog();
  }

  get catalog(): McpCatalog {
    return this.#catalog;
  }

  add(server: ManagedServer): void {
    this.#servers.set(server.name, server);
    this.#connections.delete(server.name);
    if (server.enabled) server.client.markStarting();
  }

  get(name: string): ManagedServer | undefined {
    return this.#servers.get(name);
  }

  list(): ManagedServer[] {
    return [...this.#servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Connect one server, deduplicating background and lazy callers. */
  async connect(server: string): Promise<McpConnectResult> {
    const managed = this.#servers.get(server);
    if (managed === undefined) return { server, error: `MCP server '${server}' is not configured` };
    if (!managed.enabled) return { server };
    if (managed.client.state === "ready") return { server, status: managed.client.status() };

    const existing = this.#connections.get(server);
    if (existing !== undefined) return await existing;
    const pending = (async (): Promise<McpConnectResult> => {
      try {
        const status = await managed.client.connect();
        return { server, status };
      } catch (error) {
        return { server, error: describe(error) };
      }
    })();
    this.#connections.set(server, pending);
    void pending.then((result) => {
      // Keep successful readiness memoized; allow a later explicit tool call to
      // retry a transient startup failure through the client's normal safeguards.
      if (result.error !== undefined && this.#connections.get(server) === pending) {
        this.#connections.delete(server);
      }
    });
    return await pending;
  }

  /** Connect every enabled server, collecting failures rather than throwing. */
  async connectAll(): Promise<McpConnectResult[]> {
    const results = await Promise.all(this.list().map((managed) => this.connect(managed.name)));
    return results.sort((a, b) => a.server.localeCompare(b.server));
  }

  /**
   * Start/continue all connections but wait only for a bounded budget. Returns
   * false on timeout or abort; individual connection promises remain live.
   */
  async waitForConnections(
    timeoutMs: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const connecting = this.connectAll();
    const timeout = Math.max(0, Math.floor(timeoutMs));
    if (timeout === 0) {
      void connecting;
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), timeout);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) finish(false);
      void connecting.then(() => finish(true));
    });
  }

  statuses(): McpServerStatus[] {
    return this.list().map((managed) =>
      managed.enabled
        ? managed.client.status()
        : { ...managed.client.status(), state: "disabled" as const },
    );
  }

  /** §17.7 search across every enabled server's cached catalog. */
  search(query: string, limit = 5): McpSearchMatch[] {
    const enabled = new Set(this.list().filter((s) => s.enabled).map((s) => s.name));
    const capabilities = this.#catalog
      .all()
      .filter((capability) => enabled.has(capability.server));
    return searchCapabilities(capabilities, query, { limit });
  }

  /** Resolve a `mcp.<server>.<tool>` id back to its server and tool. */
  resolveToolId(toolId: string): { server: string; tool: string } | undefined {
    if (!toolId.startsWith("mcp.")) return undefined;
    const rest = toolId.slice(4);
    for (const managed of this.list()) {
      const prefix = `${managed.name}.`;
      if (rest.startsWith(prefix)) {
        return { server: managed.name, tool: rest.slice(prefix.length) };
      }
    }
    return undefined;
  }

  /**
   * Call a tool by its CBC tool id.
   *
   * A transport failure surfaces as an error `ToolResult` rather than a thrown
   * exception: §17.10 keeps the two error kinds distinct, and the agent loop needs
   * an observation it can reason about either way.
   */
  async call(
    toolId: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ result: ToolResult; text: string; artifacts: ArtifactRef[] }> {
    const resolved = this.resolveToolId(toolId);
    if (resolved === undefined) {
      return {
        result: transportFailure("MCP_UNAVAILABLE", `'${toolId}' does not name a configured MCP tool`),
        text: `'${toolId}' does not name a configured MCP tool`,
        artifacts: [],
      };
    }

    const managed = this.#servers.get(resolved.server);
    if (managed === undefined || !managed.enabled) {
      return {
        result: transportFailure(
          "MCP_UNAVAILABLE",
          `MCP server '${resolved.server}' is not enabled`,
        ),
        text: `MCP server '${resolved.server}' is not enabled`,
        artifacts: [],
      };
    }

    const connected = await this.connect(resolved.server);
    if (connected.error !== undefined) {
      return {
        result: transportFailure("MCP_UNAVAILABLE", connected.error, true),
        text: `The call to ${resolved.server}/${resolved.tool} could not be delivered: ${connected.error}`,
        artifacts: [],
      };
    }

    try {
      const normalized = await managed.client.callTool(resolved.tool, args, options);
      return {
        result: normalized.result,
        text: normalized.modelText,
        artifacts: normalized.artifacts,
      };
    } catch (error) {
      const message = describe(error);
      const retryable = error instanceof McpTransportError ? error.retryable : false;
      return {
        result: transportFailure("MCP_UNAVAILABLE", message, retryable),
        // The model is told this was a transport problem, not a tool refusal, so it
        // does not "fix" its arguments in response to a network fault.
        text: `The call to ${resolved.server}/${resolved.tool} could not be delivered: ${message}`,
        artifacts: [],
      };
    }
  }

  /** Restart budget for a stdio server that exited (§17.3 bounded backoff). */
  nextRestart(server: string): { allowed: boolean; attempt: number; delayMs: number } {
    const attempt = (this.#restarts.get(server) ?? 0) + 1;
    const max = this.#options.maxRestarts ?? 5;
    this.#restarts.set(server, attempt);
    return {
      allowed: attempt <= max,
      attempt,
      delayMs: restartDelayMs(attempt),
    };
  }

  resetRestarts(server: string): void {
    this.#restarts.delete(server);
  }

  /** Cancel active handshakes and suspend ready transports without removing configuration. */
  async suspendConnections(): Promise<void> {
    await Promise.all(this.list().map((managed) => managed.client.suspend()));
    this.#connections.clear();
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((managed) => managed.client.close().catch(() => undefined)));
    this.#servers.clear();
    this.#connections.clear();
  }
}

function transportFailure(code: string, message: string, retryable = false): ToolResult {
  return {
    ok: false,
    summary: message,
    error: { code, message, retryable },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

/** Convert a filesystem path to a `file://` URI for `roots/list`. */
export function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, "%23")}`;
}

export { eraFor };
