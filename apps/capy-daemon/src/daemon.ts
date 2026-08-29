/**
 * Capybara local session daemon.
 *
 * Hosts AppServer from @cbc/app-server and owns instance lock, transport,
 * workspace supervisors, session actors, event hub, and approvals.
 */

import {
  APP_COMMAND_SCHEMA_VERSION,
  APP_PROTOCOL_VERSION,
  CommandDeduplicator,
  type AppClientRole,
  type AppInitializeParams,
  type CommandEnvelope,
  type EventReplayResult,
  type OperationReceipt,
} from "@cbc/app-protocol";
import {
  AppServer,
  type AppServerAuthorizer,
  type AppServerBackend,
  type AppServerSubscription,
} from "@cbc/app-server";

import { createHash } from "node:crypto";
import { join } from "node:path";

import { ApprovalManager } from "./approval-manager.ts";
import { EventHub } from "./event-hub.ts";
import { HookDispatcher } from "./hook-dispatcher.ts";
import {
  acquireInstanceLock,
  readInstanceLock,
  removeStaleRuntimeArtifacts,
  resolveInstanceLockPaths,
  type InstanceLockHandle,
} from "./instance-lock.ts";
import { LocalTransport, type LocalConnection } from "./local-transport.ts";
import { MergeCoordinator } from "./merge-coordinator.ts";
import { PluginSupervisor } from "./plugin-supervisor.ts";
import { persistRecoveryState, recoverDaemonState, type SessionRecoverySeed } from "./recovery.ts";
import { SessionWorkerHost, type SessionExecutor } from "./session-worker-host.ts";
import { gracefulShutdown } from "./shutdown.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { WorkspaceSupervisorRegistry } from "./workspace-supervisor.ts";

export interface CapybaraDaemonOptions {
  readonly daemonId?: string;
  readonly serverVersion?: string;
  readonly runtimeDir?: string;
  readonly backend?: AppServerBackend;
  readonly authorizer?: AppServerAuthorizer;
  readonly listen?: boolean;
  readonly recoverySessions?: readonly SessionRecoverySeed[];
  readonly now?: () => string;
  readonly executableDigest?: string;
  readonly maxFrameBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly sessionExecutor?: SessionExecutor | ((sessionId: string) => SessionExecutor);
  readonly spawnSessionWorker?: (sessionId: string) => SessionExecutor;
}

export interface DaemonHealth {
  readonly status: "starting" | "ready" | "shutting_down" | "stopped";
  readonly daemonId: string;
  readonly protocolVersion: string;
  readonly pid: number;
  readonly workspaces: number;
  readonly startedAt?: string;
}

export class CapybaraDaemon {
  readonly approvals = new ApprovalManager();
  readonly eventHub = new EventHub();
  readonly worktrees = new WorktreeManager();
  readonly merges = new MergeCoordinator();
  readonly plugins = new PluginSupervisor();
  readonly hooks = new HookDispatcher();
  readonly workers: SessionWorkerHost;
  readonly workspaces: WorkspaceSupervisorRegistry;

  readonly #options: CapybaraDaemonOptions;
  readonly #daemonId: string;
  readonly #now: () => string;
  #status: DaemonHealth["status"] = "stopped";
  #startedAt: string | undefined;
  #lock: InstanceLockHandle | undefined;
  #transport: LocalTransport | undefined;
  #app: AppServer | undefined;
  readonly #connections = new Map<string, { readonly appConnectionId: string; readonly local: LocalConnection }>();
  #backend: AppServerBackend;

  constructor(options: CapybaraDaemonOptions = {}) {
    this.#options = options;
    this.#daemonId = options.daemonId ?? "dmn_" + crypto.randomUUID().replaceAll("-", "");
    this.#now = options.now ?? (() => new Date().toISOString());
    const factory = options.sessionExecutor;
    this.workers = new SessionWorkerHost({
      ...(factory === undefined
        ? {}
        : { createExecutor: typeof factory === "function" ? factory : () => factory }),
      ...(options.spawnSessionWorker === undefined
        ? {}
        : { spawnWorker: options.spawnSessionWorker }),
    });
    this.workspaces = new WorkspaceSupervisorRegistry(
      options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs },
    );
    this.#backend = options.backend ?? this.#createDefaultBackend();
  }

  get daemonId(): string {
    return this.#daemonId;
  }

  get appServer(): AppServer | undefined {
    return this.#app;
  }

  get lock(): InstanceLockHandle | undefined {
    return this.#lock;
  }

  health(): DaemonHealth {
    return {
      status: this.#status,
      daemonId: this.#daemonId,
      protocolVersion: APP_PROTOCOL_VERSION,
      pid: process.pid,
      workspaces: this.workspaces.list().length,
      ...(this.#startedAt !== undefined ? { startedAt: this.#startedAt } : {}),
    };
  }

  async start(): Promise<DaemonHealth> {
    if (this.#status === "ready" || this.#status === "starting") {
      return this.health();
    }
    this.#status = "starting";
    const paths = resolveInstanceLockPaths(this.#options.runtimeDir);
    removeStaleRuntimeArtifacts(paths);

    this.#lock = acquireInstanceLock({
      daemonId: this.#daemonId,
      protocolVersion: APP_PROTOCOL_VERSION,
      ...(this.#options.runtimeDir !== undefined ? { runtimeDir: this.#options.runtimeDir } : {}),
      ...(this.#options.executableDigest !== undefined
        ? { executableDigest: this.#options.executableDigest }
        : {}),
      now: this.#now,
    });

    await recoverDaemonState({
      workspaces: this.workspaces,
      approvals: this.approvals,
      eventHub: this.eventHub,
      persistedPath: join(paths.runtimeDir, "recovery.json"),
      ...(this.#options.recoverySessions !== undefined
        ? { sessions: this.#options.recoverySessions }
        : {}),
      now: this.#now,
    });

    const authorizer = this.#options.authorizer ?? {
      authorize: async (_params: AppInitializeParams): Promise<readonly AppClientRole[]> => [
        "observer",
        "controller",
        "approval_resolver",
        "administrator-local",
      ],
    };

    this.#app = new AppServer({
      backend: this.#backend,
      authorizer,
      daemonId: this.#daemonId,
      serverVersion: this.#options.serverVersion ?? "0.1.0",
      now: this.#now,
      capabilities: {
        eventStreaming: true,
        eventAck: true,
        approvals: true,
        localDaemon: true,
      },
      transport: process.platform === "win32" ? "named-pipe" : "local-socket",
    });

    if (this.#options.listen !== false) {
      this.#transport = new LocalTransport({
        path: this.#lock.paths.socketPath,
        ...(this.#options.maxFrameBytes !== undefined
          ? { maxFrameBytes: this.#options.maxFrameBytes }
          : {}),
        onConnection: (connection) => this.#bindConnection(connection),
      });
      await this.#transport.listen();
    }

    this.#startedAt = this.#now();
    this.#status = "ready";
    return this.health();
  }

  async stop(): Promise<void> {
    if (this.#status === "stopped") return;
    this.#status = "shutting_down";
    this.#persistRecovery();
    await this.workers.close();
    await gracefulShutdown({
      workspaces: this.workspaces,
      eventHub: this.eventHub,
      ...(this.#transport !== undefined ? { transport: this.#transport } : {}),
      plugins: this.plugins,
      ...(this.#lock !== undefined ? { lock: this.#lock } : {}),
    });
    this.#transport = undefined;
    this.#lock = undefined;
    this.#app = undefined;
    this.#connections.clear();
    this.#status = "stopped";
  }

  /** In-process AppServer dispatch for tests and embedded hosts. */
  async dispatch(connectionId: string | undefined, request: unknown) {
    if (this.#app === undefined) {
      throw new Error("daemon is not started");
    }
    return await this.#app.dispatch(connectionId, request);
  }

  async attachSession(input: {
    readonly sessionId: string;
    readonly workspaceIdentityDigest: string;
    readonly connectionId: string;
    readonly clientId: string;
    readonly mode: "observer" | "controller";
    readonly eventCursor?: number;
  }) {
    const workspace = this.workspaces.getOrCreate(input.workspaceIdentityDigest);
    const actor = workspace.getOrCreateSession(input.sessionId);
    return await actor.dispatch({
      kind: "attach_client",
      connectionId: input.connectionId,
      clientId: input.clientId,
      mode: input.mode,
      ...(input.eventCursor !== undefined ? { eventCursor: input.eventCursor } : {}),
    });
  }

  async detachSession(input: {
    readonly sessionId: string;
    readonly workspaceIdentityDigest: string;
    readonly connectionId: string;
  }) {
    const workspace = this.workspaces.get(input.workspaceIdentityDigest);
    const actor = workspace?.getSession(input.sessionId);
    if (actor === undefined) throw new Error("session not found");
    return await actor.dispatch({
      kind: "detach_client",
      connectionId: input.connectionId,
    });
  }

  #persistRecovery(): void {
    const runtimeDir = this.#lock?.paths.runtimeDir ?? this.#options.runtimeDir;
    if (runtimeDir === undefined) return;
    const sessions: SessionRecoverySeed[] = [];
    for (const workspace of this.workspaces.list()) {
      const supervisor = this.workspaces.get(workspace.workspaceIdentityDigest);
      for (const sessionId of workspace.sessionIds) {
        const actor = supervisor?.getSession(sessionId);
        if (actor === undefined) continue;
        const state = actor.state;
        sessions.push({
          sessionId: state.sessionId,
          workspaceIdentityDigest: state.workspaceIdentityDigest,
          lastJournalSequence: state.lastJournalSequence,
          hadOpenTurn: state.activeTurnId !== undefined,
          pendingApprovalIds: [...state.pendingApprovalIds],
        });
      }
    }
    persistRecoveryState(join(runtimeDir, "recovery.json"), {
      schemaVersion: "1",
      sessions,
      eventHub: this.eventHub.exportSnapshot(),
    });
  }

  #bindConnection(connection: LocalConnection): void {
    let appConnectionId: string | undefined;
    connection.onMessage((message) => {
      void (async () => {
        if (this.#app === undefined) return;
        const response = await this.#app.dispatch(appConnectionId, message);
        if (
          isRecord(message)
          && message.method === "server.initialize"
          && "result" in response
          && isRecord(response.result)
          && typeof response.result.connectionId === "string"
        ) {
          appConnectionId = response.result.connectionId;
          this.#connections.set(connection.id, {
            appConnectionId,
            local: connection,
          });
        }
        try {
          connection.send(response);
        } catch {
          connection.close();
        }
      })();
    });
    connection.onClose(() => {
      if (appConnectionId !== undefined) this.#app?.closeConnection(appConnectionId);
      this.#connections.delete(connection.id);
    });
  }

  #createDefaultBackend(): AppServerBackend {
    const subscriptions = new Map<string, AppServerSubscription & {
      filter: {
        kinds: readonly string[];
        visibility: readonly string[];
        includeEphemeral: boolean;
      };
    }>();
    const hub = this.eventHub;
    const daemon = this;
    const commands = new CommandDeduplicator<unknown, unknown>();

    return {
      supportedMethods: [
        "session.create",
        "session.list",
        "session.get",
        "session.ensure",
        "session.attach",
        "session.detach",
        "turn.submit",
        "turn.cancel",
        "graph.get",
        "graph.listNodes",
        "task.get",
        "task.wait",
        "task.message",
        "task.cancel",
        "worktree.list",
        "approval.list",
        "approval.resolve",
      ],
      async registerClient(): Promise<void> {},
      async createSubscription(input) {
        const record = {
          id: input.id,
          clientId: input.clientId,
          sessionId: input.sessionId,
          state: "active" as const,
          lastAckedSequence: input.initialAckedSequence,
          filter: input.filter,
        };
        subscriptions.set(record.id, record);
        hub.subscribe({
          id: record.id,
          sessionId: record.sessionId,
          clientId: record.clientId,
          initialAckedSequence: record.lastAckedSequence,
          filter: record.filter,
        });
        return record;
      },
      async acknowledgeSubscription(input) {
        const existing = subscriptions.get(input.subscriptionId);
        if (existing === undefined || existing.clientId !== input.clientId) {
          throw new Error("unknown subscription");
        }
        const hubState = hub.acknowledge(input.subscriptionId, input.sequence);
        const record = {
          ...existing,
          lastAckedSequence: hubState.lastAckedSequence,
        };
        subscriptions.set(record.id, record);
        return record;
      },
      async setSubscriptionState(input) {
        const existing = subscriptions.get(input.subscriptionId);
        if (existing === undefined || existing.clientId !== input.clientId) {
          throw new Error("unknown subscription");
        }
        const record = { ...existing, state: input.state };
        subscriptions.set(record.id, record);
        if (input.state === "closed") hub.unsubscribe(input.subscriptionId);
        return record;
      },
      async replaySubscription(input): Promise<EventReplayResult> {
        const existing = subscriptions.get(input.subscriptionId);
        if (existing === undefined || existing.clientId !== input.clientId) {
          throw new Error("unknown subscription");
        }
        const replay = hub.replay({
          subscriptionId: input.subscriptionId,
          ...(input.afterSequence !== undefined ? { afterSequence: input.afterSequence } : {}),
          maxEvents: input.maxEvents,
          maxBytes: input.maxBytes,
        });
        return {
          subscription: {
            id: existing.id,
            clientId: existing.clientId,
            sessionId: existing.sessionId,
            state: existing.state,
            lastAckedSequence: existing.lastAckedSequence,
          },
          cursor: {
            sessionId: existing.sessionId,
            journalSequence: replay.cursorSequence,
          },
          events: replay.events.map((event) => ({
            schemaVersion: event.schemaVersion,
            sequence: event.sequence,
            id: event.id,
            timestamp: event.timestamp,
            sessionId: event.sessionId,
            kind: event.kind,
            level: "info",
            visibility: event.visibility ?? "session",
            durability: "journaled" as const,
            payload: event.payload ?? {},
          })),
          hasMore: replay.hasMore,
        };
      },
      async health() {
        return { ...daemon.health() };
      },
      async dispatch(input) {
        if (
          input.method === "graph.get"
          || input.method === "graph.listNodes"
          || input.method === "task.get"
          || input.method === "task.wait"
        ) {
          const params = isRecord(input.params) ? input.params : {};
          const sessionId = requireString(params.sessionId);
          return await daemon.workers.request(sessionId, input.method, params);
        }
        if (input.method === "task.message" || input.method === "task.cancel") {
          const command = appCommand(input.params);
          return (await commands.execute(command, async () => {
            const payload = requireRecord(command.payload);
            const sessionId = requireString(command.sessionId ?? payload.sessionId);
            const result = await daemon.workers.request(sessionId, input.method, payload);
            return completedReceipt(
              command,
              daemon.#now(),
              result,
              input.method === "task.cancel" ? "cancelled" : "completed",
            );
          })).receipt;
        }
        if (input.method === "session.create") {
          const command = appCommand(input.params);
          return (await commands.execute(command, async () => {
            const payload = requireRecord(command.payload);
            const sessionId = typeof payload.sessionId === "string"
              ? requireString(payload.sessionId)
              : "ses_" + crypto.randomUUID().replaceAll("-", "");
            const workspaceIdentityDigest = typeof payload.workspaceIdentityDigest === "string"
              ? requireString(payload.workspaceIdentityDigest)
              : workspaceDigest(requireString(payload.cwd));
            daemon.workspaces.getOrCreate(workspaceIdentityDigest).getOrCreateSession(sessionId);
            daemon.workers.ensure(sessionId);
            return completedReceipt(command, daemon.#now(), {
              sessionId,
              workspaceIdentityDigest,
              status: "active",
            });
          })).receipt;
        }
        if (input.method === "session.list") {
          const params = isRecord(input.params) ? input.params : {};
          const requestedWorkspace = typeof params.workspaceIdentityDigest === "string"
            ? params.workspaceIdentityDigest
            : undefined;
          const sessions = daemon.workspaces.list().flatMap((workspace) => {
            if (
              requestedWorkspace !== undefined
              && workspace.workspaceIdentityDigest !== requestedWorkspace
            ) {
              return [];
            }
            return workspace.sessionIds.map((sessionId) => {
              const actor = daemon.workspaces.get(workspace.workspaceIdentityDigest)?.getSession(sessionId);
              return {
                sessionId,
                workspaceIdentityDigest: workspace.workspaceIdentityDigest,
                status: actor?.state.lifecycle ?? "idle",
                revision: actor?.state.revision ?? 0,
              };
            });
          });
          return { sessions };
        }
        if (input.method === "session.get") {
          const params = requireRecord(input.params);
          const sessionId = requireString(params.sessionId);
          const located = findDaemonSession(daemon, sessionId);
          if (located === undefined) throw new Error("unknown session");
          return { ...located.actor.state };
        }
        if (input.method === "turn.submit") {
          const command = appCommand(input.params);
          return (await commands.execute(command, async () => {
          const payload = requireRecord(command.payload);
          const sessionId = requireString(
            command.sessionId ?? payload.sessionId ?? "ses_daemon",
          );
          const existingSession = findDaemonSession(daemon, sessionId);
          const workspaceIdentityDigest = existingSession?.workspaceIdentityDigest
            ?? (typeof command.workspaceIdentityDigest === "string"
            ? command.workspaceIdentityDigest
            : typeof payload.workspaceIdentityDigest === "string"
              ? payload.workspaceIdentityDigest
              : sessionId);
          const actor = existingSession?.actor
            ?? daemon.workspaces.getOrCreate(workspaceIdentityDigest).getOrCreateSession(sessionId);
          const turnId = typeof payload.turnId === "string"
            ? payload.turnId
            : "turn_" + crypto.randomUUID().replaceAll("-", "");
          const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
          const actorState = await actor.dispatch({
            kind: "submit_turn",
            turnId,
            clientId: input.clientId,
            prompt,
          });
          const executed = await daemon.workers.submit({
            sessionId,
            turnId,
            prompt,
            clientId: input.clientId,
          });
          return {
            schemaVersion: APP_COMMAND_SCHEMA_VERSION,
            receiptId: "rcp_" + command.commandId,
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            status: operationStatus(executed.status),
            startedAt: command.issuedAt,
            finishedAt: daemon.#now(),
            revisionBefore: Math.max(0, actorState.revision - 1),
            revisionAfter: actorState.revision,
            evidenceIds: [],
            result: {
              turnId,
              status: executed.status,
              answer: executed.answer ?? "",
              report: executed.report,
              actor: actorState,
            },
          } satisfies OperationReceipt<unknown>;
          })).receipt;
        }
        if (input.method === "turn.cancel") {
          const command = appCommand(input.params);
          return (await commands.execute(command, async () => {
            const payload = requireRecord(command.payload);
            const sessionId = requireString(command.sessionId ?? payload.sessionId);
            const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
            const located = findDaemonSession(daemon, sessionId);
            if (located !== undefined) {
              await located.actor.dispatch({
                kind: "cancel_turn",
                clientId: input.clientId,
                ...(turnId === undefined ? {} : { turnId }),
              });
            }
            await daemon.workers.cancel(sessionId, turnId);
            return completedReceipt(command, daemon.#now(), {
              sessionId,
              ...(turnId === undefined ? {} : { turnId }),
              cancelled: true,
            }, "cancelled");
          })).receipt;
        }
        if (input.method === "session.ensure") {
          const params = requireRecord(input.params);
          const sessionId = requireString(params.sessionId);
          daemon.workers.ensure(sessionId);
          return { sessionId, owned: true };
        }
        if (input.method === "session.attach") {
          const params = requireRecord(input.params);
          const sessionId = requireString(params.sessionId);
          const workspaceIdentityDigest = requireString(params.workspaceIdentityDigest);
          const mode = params.mode === "observer" ? "observer" : "controller";
          return await daemon.attachSession({
            sessionId,
            workspaceIdentityDigest,
            connectionId: "app_" + input.clientId,
            clientId: input.clientId,
            mode,
          });
        }
        if (input.method === "session.detach") {
          const params = requireRecord(input.params);
          return await daemon.detachSession({
            sessionId: requireString(params.sessionId),
            workspaceIdentityDigest: requireString(params.workspaceIdentityDigest),
            connectionId: "app_" + input.clientId,
          });
        }
        if (input.method === "worktree.list") {
          const params = isRecord(input.params) ? input.params : {};
          const workspaceIdentityDigest = typeof params.workspaceIdentityDigest === "string"
            ? params.workspaceIdentityDigest
            : undefined;
          return { worktrees: daemon.worktrees.list(workspaceIdentityDigest) };
        }
        if (input.method === "approval.list") {
          const params = isRecord(input.params) ? input.params : {};
          const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
          return { approvals: daemon.approvals.list(sessionId) };
        }
        if (input.method === "approval.resolve") {
          const command = appCommand(input.params);
          return (await commands.execute(command, async () => {
          const payload = requireRecord(command.payload);
          const resolved = daemon.approvals.resolve({
            approvalId: requireString(payload.approvalId),
            clientId: input.clientId,
            actionHash: requireString(payload.actionHash),
            decision: payload.decision as never,
          });
          return completedReceipt(command, daemon.#now(), resolved);
          })).receipt;
        }
        throw new Error(input.method + " is not implemented by the daemon backend");
      },
    };
  }
}

export function daemonStatus(runtimeDir?: string): {
  readonly running: boolean;
  readonly record?: ReturnType<typeof readInstanceLock>;
} {
  const record = readInstanceLock(runtimeDir);
  if (record === undefined) return { running: false };
  try {
    process.kill(record.pid, 0);
    return { running: true, record };
  } catch {
    return { running: false, record };
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("expected string");
  return value;
}

function appCommand(params: unknown): CommandEnvelope<unknown> {
  const input = requireRecord(params);
  return requireRecord(input.command) as unknown as CommandEnvelope<unknown>;
}

function completedReceipt<T>(
  command: CommandEnvelope<unknown>,
  finishedAt: string,
  result: T,
  status: OperationReceipt["status"] = "completed",
): OperationReceipt<T> {
  return {
    schemaVersion: APP_COMMAND_SCHEMA_VERSION,
    receiptId: "rcp_" + command.commandId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    status,
    startedAt: command.issuedAt,
    finishedAt,
    evidenceIds: [],
    result,
  };
}

function operationStatus(status: string): OperationReceipt["status"] {
  if (
    status === "completed"
    || status === "partial"
    || status === "failed"
    || status === "cancelled"
  ) {
    return status;
  }
  return "accepted";
}

function workspaceDigest(cwd: string): string {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return "sha256:" + createHash("sha256").update(normalized, "utf8").digest("hex");
}

function findDaemonSession(
  daemon: CapybaraDaemon,
  sessionId: string,
): { readonly workspaceIdentityDigest: string; readonly actor: import("./session-actor.ts").SessionActor } | undefined {
  for (const workspace of daemon.workspaces.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue;
    const actor = daemon.workspaces.get(workspace.workspaceIdentityDigest)?.getSession(sessionId);
    if (actor !== undefined) {
      return { workspaceIdentityDigest: workspace.workspaceIdentityDigest, actor };
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
