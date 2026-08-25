/**
 * MCP host bootstrap — PRD §17.1, §17.5, P0-15.
 *
 * P0-15 asks for the host logic that actually *launches and connects* the
 * `McpClientManager`, rather than leaving every bridge to report
 * `MCP_UNAVAILABLE`. That logic lives here:
 *
 *   - a stdio server is spawned through Bun (`Bun.spawn`), the one process
 *     spawner this runtime exposes, and wrapped in the `StdioChannel` shape
 *     `@cbc/mcp-client` already expects;
 *   - a streamable_http server uses the shared `StreamableHttpTransport`;
 *   - every enabled server is added to one `McpClientManager` and connected
 *     with `connectAll()`, which records failures per server instead of
 *     throwing (§22.6 — one failing server never takes the others down);
 *   - a live `mcp.*` bridge is built on top of the manager, so calls reach a
 *     real server and nothing is faked (§24.5).
 *
 * Trust is enforced at exactly the line the rest of the design draws: a
 * project-configured server is only *launched* in a trusted workspace
 * (§17.5, PERM-001). An untrusted project server is added **disabled**, so it
 * still appears in listings but can never run or spawn a command.
 */

import { createHash } from "node:crypto";

import type { McpServerConfig } from "@cbc/config-schema";
import {
  McpCatalog,
  McpClient,
  McpClientManager,
  StdioTransport,
  StreamableHttpTransport,
  type McpSearchMatch,
  type McpServerStatus,
  type StdioChannel,
} from "@cbc/mcp-client";
import type { ToolResult } from "@cbc/tool-registry";
import { actionHash, type ProposedAction } from "@cbc/permissions";
import type { SidebarService } from "@cbc/tui-components";

import type { Runtime } from "./runtime.ts";
import type { Execution, ToolBridges } from "./tools.ts";

type McpRuntime = Pick<
  Runtime,
  "issueCapability" | "startJob" | "sendInput" | "stopJob" | "jobStatus" | "subscribeNotifications"
>;

/** Maximum MCP handshake time allowed on the session startup critical path. */
export const DEFAULT_MCP_STARTUP_BUDGET_MS = 25;
export type McpActivationPolicy = "eager" | "target" | "deny";

export interface McpHostOptions {
  /** `config.mcpServers` — server name to config. */
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /** Optional process-local catalog to inspect before any server is connected. */
  readonly catalog?: McpCatalog;
  /** §17.4: the only root exposed to any server. */
  readonly workspaceRoot: string;
  readonly clientVersion: string;
  /** All local MCP processes must be owned by the Rust supervisor. */
  readonly runtime: McpRuntime;
  readonly sessionId: string;
  /** Reads host environment variables (§14.5: config only names variables). */
  readonly resolveEnv: (name: string) => string | undefined;
  readonly spill?: (label: string, content: string, mediaType: string) => unknown;
  readonly now?: () => number;
  /** Fast servers may finish inside this budget; slow ones continue in background. */
  readonly startupBudgetMs?: number;
  /** Receives live manager snapshots for interactive service status surfaces. */
  readonly onStatus?: (servers: readonly McpServerStatus[]) => void;
  /** Host-side Plan gate for starting external transports. */
  readonly canActivate?: () => boolean;
  /** Optional digest-aware activation policy; target mode connects one server only. */
  readonly activationPolicy?: (action: ProposedAction) => McpActivationPolicy;
}

export interface McpHost {
  /** The live manager; closed with `close()` when the session ends. */
  readonly manager: McpClientManager;
  /** A working `mcp.*` bridge over the live manager. */
  readonly bridge: NonNullable<ToolBridges["mcp"]>;
  /** Servers that failed to launch or connect, reported honestly. */
  readonly failures: Array<{ server: string; error: string }>;
  /** Settles after all background handshakes have either connected or failed. */
  readonly ready: Promise<void>;
  /** Wait for in-flight startup before the runtime enters Plan mode. */
  quiesce?(): Promise<void>;
  close(): Promise<void>;
}

/** Truthful pre-bootstrap rows, before a manager has started any transport I/O. */
export function configuredMcpSidebarServices(
  servers: Readonly<Record<string, McpServerConfig>>,
): SidebarService[] {
  return Object.entries(servers)
    .map(([name, config]): SidebarService => {
      if (config.enabled === false) {
        return { name, state: "disabled", detail: "disabled by global config" };
      }
      if (config.connectOnStartup === false) {
        return { name, state: "idle", detail: "connects on first use" };
      }
      return {
        name,
        state: "starting",
        detail: "starting " + config.transport,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Project MCP protocol states onto the smaller sidebar service vocabulary. */
export function mcpSidebarServices(
  statuses: readonly McpServerStatus[],
  servers: Readonly<Record<string, McpServerConfig>>,
): SidebarService[] {
  return statuses
    .map((status): SidebarService => {
      const configured = servers[status.server];
      if (status.state === "configured") {
        return {
          name: status.server,
          state: "idle",
          detail: configured?.connectOnStartup === false
            ? "connects on first use"
            : "waiting to connect",
        };
      }
      if (status.state === "starting" || status.state === "connecting") {
        return {
          name: status.server,
          state: "starting",
          detail: status.state === "connecting"
            ? "negotiating " + status.transport
            : "starting " + status.transport,
        };
      }
      if (status.state === "ready") {
        const capabilities = [
          status.toolCount > 0
            ? `${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`
            : undefined,
          status.resourceCount > 0
            ? `${status.resourceCount} resource${status.resourceCount === 1 ? "" : "s"}`
            : undefined,
          status.promptCount > 0
            ? `${status.promptCount} prompt${status.promptCount === 1 ? "" : "s"}`
            : undefined,
        ].filter((value): value is string => value !== undefined);
        return {
          name: status.server,
          state: "ready",
          detail: capabilities.join(", ") || status.serverInfo?.name || status.transport,
        };
      }
      if (status.state === "degraded") {
        return {
          name: status.server,
          state: "degraded",
          detail: status.lastError ?? "connection degraded",
        };
      }
      if (status.state === "failed") {
        return {
          name: status.server,
          state: "down",
          detail: status.lastError ?? "connection failed",
        };
      }
      if (status.state === "disabled") {
        return {
          name: status.server,
          state: "disabled",
          detail: "disabled by global config",
        };
      }
      return { name: status.server, state: "down", detail: "stopped" };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

// ---------------------------------------------------------------------------
// Bridge over a live manager
// ---------------------------------------------------------------------------

function okResult(summary: string, data?: Record<string, unknown>): ToolResult {
  return { ok: true, summary, ...(data !== undefined ? { data } : {}) };
}

function failResult(code: string, message: string, text: string): Execution {
  return {
    result: { ok: false, summary: message, error: { code, message, retryable: false } },
    text,
  };
}

function searchExecution(matches: McpSearchMatch[], query: string): Execution {
  const entries = matches.map((match) => ({
    server: match.descriptor.server,
    tool: match.descriptor.name,
    description: match.descriptor.description,
  }));
  const lines = entries.map(
    (entry) => `- ${entry.server}/${entry.tool}: ${entry.description ?? ""}`,
  );
  const label =
    query.length === 0
      ? `${entries.length} MCP capabilit${entries.length === 1 ? "y" : "ies"}`
      : `${entries.length} MCP capabilit${entries.length === 1 ? "y" : "ies"} for '${query}'`;
  return {
    result: okResult(label, { matches: entries }),
    text: lines.length > 0 ? lines.join("\n") : "No MCP capabilities matched.",
  };
}

export interface McpBridgeOptions {
  /**
   * Whether `mcp.search` may wait for scheduled handshakes. A deferred Plan host
   * sets this to false so inspecting an already-populated local catalog cannot
   * accidentally start a stdio process or make an HTTP request.
   */
  readonly waitForConnections?: boolean;
}

/** Wire a live manager to the `mcp.*` bridge. */
export function buildMcpBridgeForManager(
  manager: McpClientManager,
  options: McpBridgeOptions = {},
): NonNullable<ToolBridges["mcp"]> {
  return async (action: ProposedAction, signal: AbortSignal): Promise<Execution> => {
    const args = action.arguments as Record<string, unknown>;

    if (action.toolId === "mcp.search") {
      const query = typeof args.query === "string" ? args.query : "";
      // Discovery is lazy in the normal Build host: give scheduled handshakes a
      // bounded chance to publish their catalogs, then return every capability
      // available so far. Deferred Plan hosts explicitly skip this wait and only
      // inspect the local catalog already present in the manager.
      if (options.waitForConnections !== false) {
        await manager.waitForConnections(5_000, { signal });
      }
      return searchExecution(manager.search(query, 5), query);
    }

    if (action.toolId === "mcp.read_resource") {
      const server = typeof args.server === "string" ? args.server : "";
      const uri = typeof args.uri === "string" ? args.uri : "";
      const managed = manager.get(server);
      if (managed === undefined || !managed.enabled) {
        return failResult(
          "MCP_UNAVAILABLE",
          `MCP server '${server}' is not available or enabled`,
          `No live connection to '${server}', so the resource was not read.`,
        );
      }
      try {
        const connected = await manager.connect(server);
        if (connected.error !== undefined) {
          return failResult("MCP_UNAVAILABLE", connected.error, connected.error);
        }
        const normalized = await managed.client.readResource(uri, { signal });
        return { result: normalized.result, text: normalized.modelText };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failResult("MCP_UNAVAILABLE", message, message);
      }
    }

    // mcp.call
    const server = typeof args.server === "string" ? args.server : "";
    const tool = typeof args.tool === "string" ? args.tool : "";
    const callArgs =
      typeof args.arguments === "object" && args.arguments !== null
        ? (args.arguments as Record<string, unknown>)
        : {};
    const out = await manager.call(`mcp.${server}.${tool}`, callArgs, { signal });
    if (out.result.ok === false) {
      return { result: out.result, text: out.text };
    }
    return { result: okResult(out.result.summary ?? `called ${server}/${tool}`), text: out.text };
  };
}

// ---------------------------------------------------------------------------
// Stdio channel over Bun
// ---------------------------------------------------------------------------

const MAX_MCP_STDIO_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MCP_STDIO_TOTAL_BYTES = 64 * 1024 * 1024;

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

function runtimeStdioChannel(options: {
  server: string;
  command: string;
  args?: readonly string[];
  runtime: McpRuntime;
  sessionId: string;
  /** Resolve environment only when the transport is actually started. */
  env: Record<string, string> | (() => Record<string, string>);
}): StdioChannel {
  const protocolChannel = "mcp_" + createHash("sha256").update(options.server).digest("hex").slice(0, 24);
  const onLine = new Set<(line: string) => void>();
  const onDiag = new Set<(line: string) => void>();
  const onExit = new Set<(code: number | undefined) => void>();
  let jobId: string | undefined;
  let stopped = false;
  let exitReported = false;
  let stdoutBuffer = "";
  let totalStdoutBytes = 0;
  let unsubscribe: (() => void) | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let statusPending = false;
  let lifecycle = 0;

  const reportExit = (code: number | undefined): void => {
    if (exitReported || stopped) return;
    exitReported = true;
    if (statusTimer !== undefined) clearInterval(statusTimer);
    statusTimer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const handler of onExit) handler(code);
  };

  const terminateForViolation = (message: string): void => {
    if (exitReported || stopped) return;
    for (const handler of onDiag) handler(message);
    const running = jobId;
    if (running === undefined) {
      reportExit(undefined);
      return;
    }
    void options.runtime.stopJob(running, 250, options.sessionId).finally(() => reportExit(undefined));
  };

  const acceptStdout = (text: string): void => {
    const bytes = Buffer.byteLength(text, "utf8");
    totalStdoutBytes += bytes;
    if (totalStdoutBytes > MAX_MCP_STDIO_TOTAL_BYTES) {
      terminateForViolation(
        "MCP server '" + options.server + "' exceeded the cumulative stdout limit",
      );
      return;
    }
    stdoutBuffer += text;
    let newline: number;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_STDIO_LINE_BYTES) {
        terminateForViolation(
          "MCP server '" + options.server + "' exceeded the maximum JSON-RPC line length",
        );
        return;
      }
      if (line.length > 0) for (const handler of onLine) handler(line);
    }
    if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_MCP_STDIO_LINE_BYTES) {
      terminateForViolation(
        "MCP server '" + options.server + "' emitted stdout without a bounded newline frame",
      );
    }
  };

  const acceptDiagnostic = (text: string): void => {
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
      if (line.length > 0) for (const handler of onDiag) handler(line);
    }
  };

  const onRuntimeNotification = (method: string, params: unknown): void => {
    if (typeof params !== "object" || params === null) return;
    const event = params as Record<string, unknown>;
    if (
      method === "mcp.stdio.output" &&
      event.protocolChannel === protocolChannel &&
      typeof event.text === "string"
    ) {
      acceptStdout(event.text);
      return;
    }
    if (
      method === "process.output" &&
      event.jobId === jobId &&
      event.stream === "stderr" &&
      typeof event.text === "string"
    ) {
      acceptDiagnostic(event.text);
      return;
    }
    if (method === "process.limit_warning" && event.jobId === jobId) {
      acceptDiagnostic(String(event.detail ?? "MCP process resource limit warning"));
      return;
    }
    if (method === "process.exited" && event.jobId === jobId) {
      const code = typeof event.exitCode === "number" ? event.exitCode : undefined;
      jobId = undefined;
      reportExit(code);
    }
  };

  return {
    async start(): Promise<void> {
      // `McpClient.suspend()` cancels a handshake on Plan entry. The runtime
      // channel is reusable for a later explicit Build activation.
      lifecycle += 1;
      const generation = lifecycle;
      stopped = false;
      exitReported = false;
      stdoutBuffer = "";
      totalStdoutBytes = 0;
      jobId = undefined;
      statusPending = false;
      if (statusTimer !== undefined) clearInterval(statusTimer);
      statusTimer = undefined;
      unsubscribe?.();
      unsubscribe = options.runtime.subscribeNotifications(onRuntimeNotification);
      const env = typeof options.env === "function" ? options.env() : options.env;
      const args = [...(options.args ?? [])];
      const action: ProposedAction = {
        callId: "mcp-stdio-start:" + protocolChannel,
        toolId: "process.start",
        arguments: {
          server: options.server,
          program: options.command,
          args,
          cwd: ".",
          env,
          network: "deny",
        },
        command: {
          program: options.command,
          args,
          cwd: ".",
          env,
          networkIntent: { required: false },
        },
        display: [options.command, ...args].join(" "),
      };
      const hash = actionHash(action);
      const capability = await options.runtime.issueCapability({
        sessionId: options.sessionId,
        callId: action.callId,
        actionHash: hash,
        operation: "mcp.stdio.start",
        resources: [environmentBinding(env)],
        program: options.command,
        args,
        cwd: ".",
        network: "deny",
        ttlMs: 30_000,
      });
      if (stopped) {
        unsubscribe?.();
        unsubscribe = undefined;
        throw new Error("server '" + options.server + "' was stopped before launch");
      }

      try {
        const job = await options.runtime.startJob({
          program: options.command,
          args,
          cwd: ".",
          env,
          envPolicy: "inherit-safe",
          stdin: "pipe",
          network: "deny",
          maxOutputBytes: MAX_MCP_STDIO_LINE_BYTES,
          maxMemoryBytes: 512 * 1024 * 1024,
          capabilityOperation: "mcp.stdio.start",
          protocolChannel,
          capabilityReceipt: capability.id,
          capabilitySessionId: capability.sessionId,
          capabilityActionHash: capability.actionHash,
        });
        if (stopped) {
          await options.runtime.stopJob(job.jobId, 250, options.sessionId).catch(() => undefined);
          throw new Error("server '" + options.server + "' was stopped during launch");
        }
        jobId = job.jobId;
      } catch (error) {
        unsubscribe?.();
        unsubscribe = undefined;
        throw error;
      }

      statusTimer = setInterval(() => {
        if (generation !== lifecycle || statusPending || jobId === undefined || stopped) return;
        statusPending = true;
        const currentJob = jobId;
        void options.runtime
          .jobStatus(currentJob, options.sessionId)
          .then((raw) => {
            if (generation !== lifecycle || currentJob !== jobId || typeof raw !== "object" || raw === null) return;
            const state = (raw as Record<string, unknown>).state;
            if (state !== "running" && state !== "starting") {
              jobId = undefined;
              reportExit(undefined);
            }
          })
          .catch(() => reportExit(undefined))
          .finally(() => {
            statusPending = false;
          });
      }, 250);
      (statusTimer as unknown as { unref?: () => void }).unref?.();
    },

    async write(line: string): Promise<void> {
      if (jobId === undefined || stopped) {
        throw new Error("server '" + options.server + "' is not running");
      }
      const frame = line.replace(/[\r\n]+$/, "") + "\n";
      await options.runtime.sendInput({ jobId, data: frame }, options.sessionId);
    },

    onLine(handler: (line: string) => void): void {
      onLine.add(handler);
    },

    onDiagnostic(handler: (line: string) => void): void {
      onDiag.add(handler);
    },

    onExit(handler: (code: number | undefined) => void): void {
      onExit.add(handler);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      lifecycle += 1;
      stopped = true;
      if (statusTimer !== undefined) clearInterval(statusTimer);
      statusTimer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      const running = jobId;
      jobId = undefined;
      if (running !== undefined) await options.runtime.stopJob(running, 500, options.sessionId);
    },
  };
}

function configEnv(
  resolveEnv: (name: string) => string | undefined,
  config: McpServerConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of config.env ?? []) {
    const value = resolveEnv(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------


async function settleWithin(promise: Promise<unknown>, budgetMs: number): Promise<void> {
  const budget = Math.max(0, Math.floor(budgetMs));
  if (budget === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

interface AssembledMcpHost {
  readonly manager: McpClientManager;
  readonly failures: Array<{ server: string; error: string }>;
}

/**
 * Build the manager and its transports without connecting anything.
 *
 * Keeping assembly separate from connection is the important Plan-mode boundary:
 * constructing a stdio channel does not spawn it, and constructing an HTTP
 * transport does not make a request. The only operation below that can perform
 * I/O is `connectManager`, which is called by the eager Build host or by
 * `DeferredMcpHost.activate()`.
 */
function assembleMcpHost(options: McpHostOptions): AssembledMcpHost {
  const manager = new McpClientManager({
    catalog: options.catalog ?? new McpCatalog(),
    ...(options.onStatus !== undefined ? { onStatus: options.onStatus } : {}),
  });
  const failures: Array<{ server: string; error: string }> = [];

  for (const [name, config] of Object.entries(options.servers)) {
    if (config.transport === "stdio") {
      const command = config.command ?? "";
      if (command.length === 0) {
        failures.push({ server: name, error: "a stdio server needs a 'command'" });
        continue;
      }
      manager.add({
        name,
        client: new McpClient(
          {
            serverName: name,
            transport: new StdioTransport({
              serverName: name,
              channel: runtimeStdioChannel({
                server: name,
                command,
                args: config.args ?? [],
                runtime: options.runtime,
                sessionId: options.sessionId,
                env: () => configEnv(options.resolveEnv, config),
              }),
              ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            }),
            clientVersion: options.clientVersion,
            workspaceRoot: options.workspaceRoot,
            ...(options.now !== undefined ? { now: options.now } : {}),
          },
          manager.catalog,
        ),
        fromProjectConfig: false,
        enabled: config.enabled !== false,
      });
      continue;
    }

    if (config.transport === "streamable_http") {
      const url = config.url;
      if (url === undefined) {
        failures.push({ server: name, error: "an HTTP server needs a 'url'" });
        continue;
      }
      const enabled = config.enabled !== false;
      manager.add({
        name,
        client: new McpClient(
          {
            serverName: name,
            transport: new StreamableHttpTransport({
              serverName: name,
              url,
              ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            }),
            clientVersion: options.clientVersion,
            workspaceRoot: options.workspaceRoot,
            ...(options.now !== undefined ? { now: options.now } : {}),
          },
          manager.catalog,
        ),
        fromProjectConfig: false,
        enabled,
      });
      continue;
    }

    failures.push({ server: name, error: `unknown transport '${String(config.transport)}'` });
  }

  return { manager, failures };
}

/**
 * Connect selected enabled clients, recording each failure without throwing.
 *
 * Omitting serverNames preserves the explicit full activation path. Startup
 * callers pass only servers whose config opted into eager connection.
 */
function connectManager(
  manager: McpClientManager,
  failures: Array<{ server: string; error: string }>,
  serverNames?: readonly string[],
): Promise<void> {
  const connections = serverNames === undefined
    ? manager.connectAll()
    : Promise.all(
        [...new Set(serverNames)]
          .sort((left, right) => left.localeCompare(right))
          .map((server) => manager.connect(server)),
      );
  return connections.then((results) => {
    for (const result of results) {
      if (result.error !== undefined) {
        failures.push({ server: result.server, error: result.error });
      }
    }
  });
}

/**
 * A manager whose transports are assembled immediately but connected on demand.
 *
 * A Plan session gets a real manager and catalog, which means `mcp.search` can
 * inspect capabilities already cached by this process without making a network
 * request. It never calls `waitForConnections` in that mode. The first Build-mode
 * MCP operation activates the same manager and transport instances; there is no
 * second host and no opportunity for a Plan search to race a duplicate spawn.
 */
export interface DeferredMcpHostOptions extends McpHostOptions {
  /** Mode at construction time. Defaults to Build for backwards compatibility. */
  readonly initialMode?: "build" | "plan";
  /** Reads the live session mode when a bridge operation is dispatched. */
  readonly interactionMode?: "build" | "plan" | (() => "build" | "plan");
}

export class DeferredMcpHost implements McpHost {
  readonly manager: McpClientManager;
  readonly bridge: NonNullable<ToolBridges["mcp"]>;
  readonly failures: Array<{ server: string; error: string }>;
  /** Settles after the eager startup budget, if the initial mode is Build. */
  readonly initialReady: Promise<void>;

  readonly #options: DeferredMcpHostOptions;
  readonly #initialMode: "build" | "plan";
  readonly #buildBridge: NonNullable<ToolBridges["mcp"]>;
  readonly #catalogBridge: NonNullable<ToolBridges["mcp"]>;
  /** Servers explicitly configured to connect while a Build session starts. */
  readonly #eagerServerNames: readonly string[];
  #eagerActivation: Promise<void> | undefined;
  #activation: Promise<void> | undefined;
  #closed = false;

  constructor(options: DeferredMcpHostOptions) {
    const assembled = assembleMcpHost(options);
    this.#options = options;
    let observedInitial: "build" | "plan" | undefined;
    if (typeof options.interactionMode === "function") {
      try {
        // This read is intentionally performed before scheduling startup so a
        // callback-only caller can construct a Plan host without an extra mode
        // flag. A callback failure fails closed to Plan.
        observedInitial = options.interactionMode() === "build" ? "build" : "plan";
      } catch {
        observedInitial = "plan";
      }
    }
    this.#initialMode = options.initialMode ??
      (typeof options.interactionMode === "string"
        ? options.interactionMode
        : observedInitial ?? "build");
    this.manager = assembled.manager;
    this.failures = assembled.failures;
    this.#eagerServerNames = this.manager
      .list()
      .filter((managed) =>
        managed.enabled && options.servers[managed.name]?.connectOnStartup !== false)
      .map((managed) => managed.name);
    this.#buildBridge = buildMcpBridgeForManager(this.manager);
    this.#catalogBridge = buildMcpBridgeForManager(this.manager, {
      waitForConnections: false,
    });
    this.bridge = (action, signal) => this.#execute(action, signal);

    // Keep the normal Build bootstrap eager for configured local servers, while
    // a server such as the built-in Context7 remote endpoint can opt out and
    // connect only when an actual MCP discovery/call needs it.
    this.initialReady = this.#initialMode === "build"
      ? settleWithin(this.#activateEager(), options.startupBudgetMs ?? DEFAULT_MCP_STARTUP_BUDGET_MS)
      : Promise.resolve();
  }

  /**
   * Construct a host and wait only for its configured startup budget.
   * Background handshakes remain represented by `ready`.
   */
  static async create(options: DeferredMcpHostOptions): Promise<DeferredMcpHost> {
    const host = new DeferredMcpHost(options);
    await host.initialReady;
    return host;
  }

  /** Start startup-opt-in servers once; concurrent callers share one promise. */
  #activateEager(): Promise<void> {
    if (this.#eagerActivation !== undefined) return this.#eagerActivation;
    if (this.#closed || this.#eagerServerNames.length === 0) return Promise.resolve();
    this.#eagerActivation = connectManager(this.manager, this.failures, this.#eagerServerNames);
    return this.#eagerActivation;
  }

  /** Start all configured servers once; concurrent callers share one promise. */
  activate(): Promise<void> {
    if (this.#activation !== undefined) return this.#activation;
    if (this.#closed) return Promise.resolve();
    this.#activation = connectManager(this.manager, this.failures);
    return this.#activation;
  }

  /**
   * `ready` is the background connection promise when activated and an already
   * settled promise for an unactivated Plan host (there is no handshake to wait
   * for in that state).
   */
  get ready(): Promise<void> {
    return this.#activation ?? this.#eagerActivation ?? Promise.resolve();
  }

  async quiesce(): Promise<void> {
    // Close transports first so a slow stdio/HTTP handshake cannot finish after
    // the mode boundary. `suspendConnections` preserves configured clients for
    // a later explicit Build activation and clears manager connection promises.
    const activation = this.#activation;
    const eagerActivation = this.#eagerActivation;
    await this.manager.suspendConnections();
    await activation?.catch(() => undefined);
    await eagerActivation?.catch(() => undefined);
    this.#activation = undefined;
    this.#eagerActivation = undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.manager.closeAll();
  }

  #mode(): "build" | "plan" {
    const configured = this.#options.interactionMode;
    if (typeof configured === "function") {
      try {
        // Fail closed if a mode observer cannot answer. An observer is only used
        // to decide whether to start external transports, so uncertainty must not
        // become an implicit Build grant.
        return configured() === "build" ? "build" : "plan";
      } catch {
        return "plan";
      }
    }
    if (configured !== undefined) return configured;
    return this.#initialMode;
  }

  #activationPolicy(action: ProposedAction): McpActivationPolicy {
    try {
      if (this.#options.activationPolicy !== undefined) return this.#options.activationPolicy(action);
      return (this.#options.canActivate?.() ?? true) ? "eager" : "deny";
    } catch {
      return "deny";
    }
  }

  async #execute(action: ProposedAction, signal: AbortSignal): Promise<Execution> {
    const mode = this.#mode();
    const activationPolicy = this.#activationPolicy(action);

    if (action.toolId === "mcp.search") {
      if (mode === "build" && activationPolicy === "eager") {
        // The bridge itself waits a bounded amount for the catalog. Activation is
        // intentionally kicked off separately so a search cannot turn the host's
        // startup budget into an unbounded wait.
        void this.activate();
        return await this.#buildBridge(action, signal);
      }
      // Plan mode, or a drafted Plan that has not installed its one-shot Build
      // directive, gets only the already-cached catalog. Never turn discovery into
      // an implicit MCP transport start.
      return await this.#catalogBridge(action, signal);
    }

    if (mode !== "build") {
      return failResult(
        "MCP_PLAN_DISABLED",
        "Plan mode does not execute MCP operations",
        "The MCP operation was not sent because Plan mode only inspects the local catalog.",
      );
    }

    // mcp.call and mcp.read_resource are policy-gated external operations. The
    // policy layer normally prevents Plan calls before this point; retaining this
    // mode check and the host Plan gate here makes the bridge safe for direct
    // callers as well.
    if (activationPolicy === "deny" || mode !== "build") {
      return failResult(
        "MCP_PLAN_DISABLED",
        "MCP execution requires an explicitly approved Build Plan turn",
        "The MCP operation was not sent because no digest-bound execution directive is active.",
      );
    }
    if (activationPolicy === "eager") void this.activate();
    else {
      const server = typeof action.arguments.server === "string" ? action.arguments.server : "";
      const connected = await this.manager.connect(server);
      if (connected.error !== undefined) return failResult("MCP_UNAVAILABLE", connected.error, connected.error);
    }
    return await this.#buildBridge(action, signal);
  }
}

/**
 * Assemble the manager, launch/connect it, and expose a live Build bridge.
 * Never throws on a bad server: failures are collected and returned (§22.6).
 *
 * This remains the eager public bootstrap used by callers that do not need a
 * mode-aware wrapper. Its implementation goes through DeferredMcpHost so the
 * launch path has exactly one assembly implementation.
 */
export async function bootstrapMcpHost(options: McpHostOptions): Promise<McpHost> {
  return await DeferredMcpHost.create({
    ...options,
    initialMode: "build",
    interactionMode: "build",
  });
}
