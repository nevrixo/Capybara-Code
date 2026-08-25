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

export interface SessionAppBackendOptions {
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly now?: () => string;
}

export class SessionAppBackend implements AppServerBackend {
  readonly #session: AgentSession;
  readonly #sessionId: string;
  readonly #now: () => string;
  readonly #dedupe = new CommandDeduplicator<{ prompt?: string }, TurnResult["report"]>();
  readonly #subscriptions = new Map<string, AppServerSubscription>();
  readonly #clients = new Set<string>();
  #lastTurn: TurnResult | undefined;
  #turnAbort: AbortController | undefined;

  constructor(options: SessionAppBackendOptions) {
    this.#session = options.session;
    this.#sessionId = options.sessionId;
    this.#now = options.now ?? (() => new Date().toISOString());
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
    const sequence = input.afterSequence ?? existing.lastAckedSequence;
    return {
      subscription: existing,
      cursor: { sessionId: existing.sessionId, journalSequence: sequence },
      events: [],
      hasMore: false,
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
      };
    }
    if (input.method === "turn.cancel") {
      this.#turnAbort?.abort();
      return { cancelled: true };
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
      },
    };
  }

  private requireSubscription(id: string, clientId: string): AppServerSubscription {
    const existing = this.#subscriptions.get(id);
    if (existing === undefined || existing.clientId !== clientId) {
      throw new Error("unknown App Protocol subscription");
    }
    return existing;
  }
}

function commandEnvelope(params: unknown): CommandEnvelope<{ prompt?: string }> {
  if (typeof params !== "object" || params === null || !("command" in params)) {
    throw new Error("turn.submit requires a command envelope");
  }
  return (params as { command: CommandEnvelope<{ prompt?: string }> }).command;
}

function mapStatus(status: string): OperationReceipt["status"] {
  if (status === "completed") return "completed";
  if (status === "partial") return "partial";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "accepted";
}
