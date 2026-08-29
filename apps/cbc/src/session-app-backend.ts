/**
 * In-process App Protocol backend that wraps AgentSession.
 *
 * Embedded TUI/headless and the local daemon share this dispatch core so the
 * client never talks to AgentSession except through App methods.
 */

import {
  APP_COMMAND_SCHEMA_VERSION,
  CommandDeduplicator,
  type AppClientRole,
  type AppInitializeParams,
  type AppMethod,
  type CommandEnvelope,
  type EventReplayResult,
  type OperationReceipt,
} from "@cbc/app-protocol";
import type { AppServerBackend, AppServerSubscription } from "@cbc/app-server";
import type { TurnResult } from "@cbc/agent-kernel";

import type { AgentSession } from "./agent.ts";

export interface SessionAppJournalEvent {
  readonly sequence: number;
  readonly id?: string;
  readonly kind: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
}

export interface SessionAppBackendOptions {
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly now?: () => string;
  /** Durable events used for cursor replay. Timeline is the fallback. */
  readonly journal?: () => readonly SessionAppJournalEvent[];
  readonly memory?: {
    list(): Promise<unknown>;
    forget?(id: string): Promise<unknown>;
    resolve?(id: string, winner?: string): Promise<unknown>;
  };
  readonly worktrees?: { list(): Promise<unknown> };
  readonly graph?: { snapshot(): unknown };
  readonly plugins?: { list(): unknown };
}

export class SessionAppBackend implements AppServerBackend {
  readonly supportedMethods: readonly AppMethod[];
  readonly #session: AgentSession;
  readonly #sessionId: string;
  readonly #now: () => string;
  readonly #journal?: () => readonly SessionAppJournalEvent[];
  readonly #memory?: SessionAppBackendOptions["memory"];
  readonly #worktrees?: SessionAppBackendOptions["worktrees"];
  readonly #graph?: SessionAppBackendOptions["graph"];
  readonly #plugins?: SessionAppBackendOptions["plugins"];
  readonly #dedupe = new CommandDeduplicator<{ prompt?: string }, TurnResult["report"]>();
  readonly #taskDedupe = new CommandDeduplicator<unknown, unknown>();
  readonly #subscriptions = new Map<string, AppServerSubscription>();
  readonly #clients = new Set<string>();
  #lastTurn: TurnResult | undefined;
  #turnAbort: AbortController | undefined;

  constructor(options: SessionAppBackendOptions) {
    this.#session = options.session;
    this.#sessionId = options.sessionId;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.journal !== undefined) this.#journal = options.journal;
    if (options.memory !== undefined) this.#memory = options.memory;
    if (options.worktrees !== undefined) this.#worktrees = options.worktrees;
    if (options.graph !== undefined) this.#graph = options.graph;
    if (options.plugins !== undefined) this.#plugins = options.plugins;
    this.supportedMethods = Object.freeze([
      "session.create",
      "session.get",
      "session.pause",
      "session.resume",
      "turn.submit",
      "turn.wait",
      "turn.cancel",
      "memory.list",
      "memory.search",
      ...(options.memory?.forget === undefined ? [] : ["memory.forget" as const]),
      ...(options.memory?.resolve === undefined ? [] : ["memory.resolveContest" as const]),
      "worktree.list",
      "graph.get",
      "graph.listNodes",
      "task.get",
      "task.wait",
      "task.message",
      "task.cancel",
      "plugin.list",
    ] satisfies AppMethod[]);
  }

  get lastTurn(): TurnResult | undefined {
    return this.#lastTurn;
  }

  async registerClient(input: Parameters<AppServerBackend["registerClient"]>[0]): Promise<void> {
    this.#clients.add(input.client.id);
  }

  async createSubscription(
    input: Parameters<AppServerBackend["createSubscription"]>[0],
  ): Promise<AppServerSubscription> {
    const record: AppServerSubscription = {
      id: input.id,
      clientId: input.clientId,
      sessionId: input.sessionId,
      state: "active",
      lastAckedSequence: input.initialAckedSequence,
    };
    this.#subscriptions.set(input.id, record);
    return record;
  }

  async acknowledgeSubscription(
    input: Parameters<AppServerBackend["acknowledgeSubscription"]>[0],
  ): Promise<AppServerSubscription> {
    const existing = this.requireSubscription(input.subscriptionId, input.clientId);
    const record: AppServerSubscription = {
      ...existing,
      lastAckedSequence: Math.max(existing.lastAckedSequence, input.sequence),
    };
    this.#subscriptions.set(record.id, record);
    return record;
  }

  async setSubscriptionState(
    input: Parameters<AppServerBackend["setSubscriptionState"]>[0],
  ): Promise<AppServerSubscription> {
    const existing = this.requireSubscription(input.subscriptionId, input.clientId);
    const record: AppServerSubscription = { ...existing, state: input.state };
    this.#subscriptions.set(record.id, record);
    return record;
  }

  async replaySubscription(
    input: Parameters<AppServerBackend["replaySubscription"]>[0],
  ): Promise<EventReplayResult> {
    const existing = this.requireSubscription(input.subscriptionId, input.clientId);
    const after = input.afterSequence ?? existing.lastAckedSequence;
    const maxEvents = Math.max(1, input.maxEvents ?? 256);
    const source = this.#journalEvents();
    const selected = source.filter((event) => event.sequence > after).slice(0, maxEvents + 1);
    const hasMore = selected.length > maxEvents;
    const page = hasMore ? selected.slice(0, maxEvents) : selected;
    const last = page.at(-1)?.sequence ?? after;
    return {
      subscription: existing,
      cursor: { sessionId: existing.sessionId, journalSequence: last },
      events: page.map((event) => ({
        schemaVersion: "1.0",
        sequence: event.sequence,
        id: event.id ?? `evt_${this.#sessionId}_${String(event.sequence)}`,
        timestamp: event.timestamp ?? this.#now(),
        sessionId: existing.sessionId,
        kind: event.kind,
        level: "info",
        visibility: "session",
        durability: "journaled",
        payload: event.payload ?? {},
      })),
      hasMore,
    };
  }

  async health(): Promise<Readonly<Record<string, unknown>>> {
    return { status: "ready", sessionId: this.#sessionId, clients: this.#clients.size };
  }

  async dispatch(input: {
    readonly method: AppMethod;
    readonly params: unknown;
    readonly clientId: string;
    readonly roles: readonly AppClientRole[];
  }): Promise<unknown> {
    if (input.method === "session.create" || input.method === "session.get") {
      return { sessionId: this.#sessionId, status: "active" };
    }
    if (input.method === "turn.wait") {
      const last = this.#lastTurn;
      if (last === undefined) return { status: "idle" };
      return {
        status: last.report.status,
        answer: last.answer,
        report: last.report,
        presentation: last.presentation,
      };
    }
    if (input.method === "turn.cancel") {
      this.#turnAbort?.abort();
      return { cancelled: true };
    }
    if (input.method === "session.pause") {
      return { sessionId: this.#sessionId, status: "paused" };
    }
    if (input.method === "session.resume") {
      return { sessionId: this.#sessionId, status: "active" };
    }
    if (input.method === "memory.list" || input.method === "memory.search") {
      return this.#memory?.list() ?? { memories: [] };
    }
    if (input.method === "memory.forget") {
      const id = payloadString(input.params, "id");
      if (id === undefined || this.#memory?.forget === undefined) {
        throw new Error("memory.forget requires a memory adapter and id");
      }
      return await this.#memory.forget(id);
    }
    if (input.method === "memory.resolveContest") {
      const id = payloadString(input.params, "id");
      if (id === undefined || this.#memory?.resolve === undefined) {
        throw new Error("memory.resolveContest requires a memory adapter and id");
      }
      return await this.#memory.resolve(id, payloadString(input.params, "winnerId"));
    }
    if (input.method === "worktree.list") {
      return this.#worktrees?.list() ?? { worktrees: [] };
    }
    if (input.method === "graph.get") {
      return {
        graph: this.#graph?.snapshot() ?? this.#session.taskGraphSnapshot(),
        budget: this.#session.taskBudgetSnapshot(),
        recovery: this.#session.taskRecoveryReport(),
      };
    }
    if (input.method === "graph.listNodes") {
      return { nodes: this.#session.taskInstances() };
    }
    if (input.method === "task.get") {
      const taskId = payloadString(input.params, "taskId");
      if (taskId === undefined) throw new Error("task.get requires taskId");
      const instance = this.#session.taskInstance(taskId);
      if (instance === undefined) throw new Error("unknown task");
      return { instance };
    }
    if (input.method === "task.wait") {
      const taskId = payloadString(input.params, "taskId");
      if (taskId === undefined) throw new Error("task.wait requires taskId");
      const timeoutMs = payloadNumber(input.params, "timeoutMs");
      const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
      return {
        taskId,
        result: await this.#session.waitTask(taskId, signal),
        instance: this.#session.taskInstance(taskId),
      };
    }
    if (input.method === "task.message") {
      const envelope = commandEnvelope<Record<string, unknown>>(input.params);
      return (await this.#taskDedupe.execute(envelope, async () => {
        const taskId = requiredPayloadString(envelope.payload, "taskId");
        const kind = requiredPayloadString(envelope.payload, "kind");
        this.#session.messageTask(taskId, kind, envelope.payload.body);
        return operationReceipt(envelope, this.#now(), { taskId, kind, queued: true });
      })).receipt;
    }
    if (input.method === "task.cancel") {
      const envelope = commandEnvelope<Record<string, unknown>>(input.params);
      return (await this.#taskDedupe.execute(envelope, async () => {
        const taskId = requiredPayloadString(envelope.payload, "taskId");
        const reason = typeof envelope.payload.reason === "string"
          ? envelope.payload.reason
          : "cancelled through App Protocol";
        const result = await this.#session.cancelTaskResult(taskId, reason);
        return operationReceipt(envelope, this.#now(), { taskId, result }, "cancelled");
      })).receipt;
    }
    if (input.method === "plugin.list") {
      return this.#plugins?.list() ?? { plugins: [] };
    }
    if (input.method !== "turn.submit") {
      throw new Error(input.method + " is not available in the embedded session backend");
    }
    const envelope = commandEnvelope(input.params);
    const executed = await this.#dedupe.execute(envelope, async () => {
      const prompt = typeof envelope.payload.prompt === "string" ? envelope.payload.prompt : "";
      this.#turnAbort = new AbortController();
      const result = await this.#session.submit(prompt, this.#turnAbort.signal);
      this.#lastTurn = result;
      return {
        schemaVersion: APP_COMMAND_SCHEMA_VERSION,
        receiptId: "rcp_" + envelope.commandId,
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        status: mapStatus(result.report.status),
        startedAt: envelope.issuedAt,
        finishedAt: this.#now(),
        evidenceIds: [],
        result: result.report,
      } satisfies OperationReceipt<TurnResult["report"]>;
    });
    const receipt = executed.receipt;
    return {
      ...receipt,
      result: {
        turnId: this.#session.viewModel.currentTurnId ?? envelope.commandId,
        status: this.#lastTurn?.report.status ?? receipt.status,
        answer: this.#lastTurn?.answer ?? "",
        report: this.#lastTurn?.report,
        presentation: this.#lastTurn?.presentation,
      },
    };
  }

  #journalEvents(): readonly SessionAppJournalEvent[] {
    if (this.#journal !== undefined) return this.#journal();
    return this.#session.viewModel.timeline.map((item) => ({
      sequence: item.sequence,
      id: `evt_timeline_${String(item.sequence)}`,
      kind: `timeline.${item.type}`,
      payload: { type: item.type },
    }));
  }

  private requireSubscription(id: string, clientId: string): AppServerSubscription {
    const existing = this.#subscriptions.get(id);
    if (existing === undefined || existing.clientId !== clientId) {
      throw new Error("unknown App Protocol subscription");
    }
    return existing;
  }
}

function commandEnvelope<T = { prompt?: string }>(params: unknown): CommandEnvelope<T> {
  if (typeof params !== "object" || params === null || !("command" in params)) {
    throw new Error("turn.submit requires a command envelope");
  }
  return (params as { command: CommandEnvelope<T> }).command;
}

function payloadString(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null || !(key in params)) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function payloadNumber(params: unknown, key: string): number | undefined {
  if (typeof params !== "object" || params === null || !(key in params)) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requiredPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(key + " must be a non-empty string");
  }
  return value;
}

function operationReceipt<T>(
  envelope: CommandEnvelope<unknown>,
  finishedAt: string,
  result: T,
  status: OperationReceipt["status"] = "completed",
): OperationReceipt<T> {
  return {
    schemaVersion: APP_COMMAND_SCHEMA_VERSION,
    receiptId: "rcp_" + envelope.commandId,
    commandId: envelope.commandId,
    idempotencyKey: envelope.idempotencyKey,
    status,
    startedAt: envelope.issuedAt,
    finishedAt,
    evidenceIds: [],
    result,
  };
}

function mapStatus(status: string): OperationReceipt["status"] {
  if (status === "completed") return "completed";
  if (status === "partial") return "partial";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "accepted";
}
