/**
 * Session handle: submit / wait / cancel / events over App Protocol JSON-RPC.
 */

import {
  APP_COMMAND_SCHEMA_VERSION,
  type CommandEnvelope,
  type EventCursor,
  type OperationReceipt,
} from "@cbc/app-protocol";

import { resolveApproval, type ApprovalHandler, type ApprovalHooks, type ApprovalRequest } from "./approvals.ts";
import { EventStream, type EventStreamOptions, type StreamEvent } from "./stream.ts";

export interface RpcCaller {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  readonly clientId: string;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

export interface TurnHandle {
  readonly turnId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly receipt: OperationReceipt;
}

export interface SubmitOptions extends ApprovalHooks {
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

export interface WaitOptions {
  readonly turnId?: string;
  readonly timeoutMs?: number;
}

export interface SessionOptions {
  readonly sessionId: string;
  readonly rpc: RpcCaller;
  readonly now?: () => string;
}

export class Session {
  readonly id: string;
  readonly #rpc: RpcCaller;
  readonly #now: () => string;
  #lastTurn: TurnHandle | undefined;
  #lastSubmitEnvelope: CommandEnvelope<{ prompt: string }> | undefined;
  #approvalHandler: ApprovalHandler | undefined;
  #eventUnsub: (() => void) | undefined;

  constructor(options: SessionOptions) {
    this.id = options.sessionId;
    this.#rpc = options.rpc;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get lastTurn(): TurnHandle | undefined {
    return this.#lastTurn;
  }

  /** Last submit envelope, reused after reconnect for the same idempotencyKey. */
  get lastSubmitEnvelope(): CommandEnvelope<{ prompt: string }> | undefined {
    return this.#lastSubmitEnvelope;
  }

  onApproval(handler: ApprovalHandler): void {
    this.#approvalHandler = handler;
  }

  async submit(prompt: string, options: SubmitOptions = {}): Promise<TurnHandle> {
    if (options.onApproval !== undefined) this.#approvalHandler = options.onApproval;
    const idempotencyKey = options.idempotencyKey ?? `idem_${crypto.randomUUID().replaceAll("-", "")}`;
    const envelope: CommandEnvelope<{ prompt: string }> = {
      schemaVersion: APP_COMMAND_SCHEMA_VERSION,
      commandId: `cmd_${crypto.randomUUID().replaceAll("-", "")}`,
      idempotencyKey,
      correlationId: options.correlationId ?? `cor_${crypto.randomUUID().replaceAll("-", "")}`,
      clientId: this.#rpc.clientId,
      sessionId: options.sessionId ?? this.id,
      issuedAt: this.#now(),
      payload: { prompt },
    };
    this.#lastSubmitEnvelope = envelope;
    const receipt = await this.#rpc.request<OperationReceipt>("turn.submit", { command: envelope });
    const turnId = readTurnId(receipt);
    const handle: TurnHandle = {
      turnId,
      commandId: envelope.commandId,
      idempotencyKey: envelope.idempotencyKey,
      receipt,
    };
    this.#lastTurn = handle;
    return handle;
  }

  /**
   * Re-issue the last submit after a reconnect. Uses the same idempotencyKey so
   * the daemon CommandDeduplicator can replay the receipt.
   */
  async resubmitLast(): Promise<TurnHandle> {
    const previous = this.#lastSubmitEnvelope;
    if (previous === undefined) throw new Error("no prior submit to resubmit");
    const receipt = await this.#rpc.request<OperationReceipt>("turn.submit", { command: previous });
    const handle: TurnHandle = {
      turnId: readTurnId(receipt),
      commandId: previous.commandId,
      idempotencyKey: previous.idempotencyKey,
      receipt,
    };
    this.#lastTurn = handle;
    return handle;
  }

  async wait(options: WaitOptions = {}): Promise<OperationReceipt> {
    const turnId = options.turnId ?? this.#lastTurn?.turnId;
    if (turnId === undefined) throw new Error("wait requires a turnId");
    return this.#rpc.request<OperationReceipt>("turn.wait", {
      sessionId: this.id,
      turnId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  async cancel(turnId?: string): Promise<OperationReceipt> {
    const target = turnId ?? this.#lastTurn?.turnId;
    if (target === undefined) throw new Error("cancel requires a turnId");
    const envelope: CommandEnvelope<{ turnId: string }> = {
      schemaVersion: APP_COMMAND_SCHEMA_VERSION,
      commandId: `cmd_${crypto.randomUUID().replaceAll("-", "")}`,
      idempotencyKey: `idem_cancel_${target}`,
      correlationId: `cor_${crypto.randomUUID().replaceAll("-", "")}`,
      clientId: this.#rpc.clientId,
      sessionId: this.id,
      issuedAt: this.#now(),
      payload: { turnId: target },
    };
    return this.#rpc.request<OperationReceipt>("turn.cancel", { command: envelope });
  }

  events(options: EventStreamOptions = {}): AsyncIterable<StreamEvent> {
    const stream = new EventStream(options);
    void this.#wireEvents(stream, options);
    return stream;
  }

  async handleApprovalNotification(params: unknown): Promise<void> {
    if (!isRecord(params)) return;
    const request = params as unknown as ApprovalRequest;
    if (typeof request.approvalId !== "string") return;
    const decision = await resolveApproval(
      this.#approvalHandler === undefined ? undefined : { onApproval: this.#approvalHandler },
      request,
    );
    const envelope: CommandEnvelope<ApprovalRequest & { decision: string; reason?: string }> = {
      schemaVersion: APP_COMMAND_SCHEMA_VERSION,
      commandId: `cmd_${crypto.randomUUID().replaceAll("-", "")}`,
      idempotencyKey: `idem_approval_${request.approvalId}`,
      correlationId: `cor_${crypto.randomUUID().replaceAll("-", "")}`,
      clientId: this.#rpc.clientId,
      sessionId: this.id,
      issuedAt: this.#now(),
      payload: {
        ...request,
        decision: decision.decision,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
    };
    await this.#rpc.request("approval.resolve", { command: envelope });
  }

  dispose(): void {
    this.#eventUnsub?.();
    this.#eventUnsub = undefined;
  }

  async #wireEvents(stream: EventStream, options: EventStreamOptions): Promise<void> {
    try {
      const from = options.from === undefined
        ? undefined
        : { [this.id]: options.from };
      const subscribed = await this.#rpc.request<{
        subscription: { id: string };
        cursor: EventCursor;
      }>("events.subscribe", {
        request: {
          sessionIds: [this.id],
          ...(from !== undefined ? { from } : {}),
        },
      });
      this.#eventUnsub?.();
      this.#eventUnsub = this.#rpc.onNotification((method, params) => {
        if (method === "events.push" || method === "event" || method === "session.event") {
          for (const event of normalizePush(params)) {
            stream.push(event);
          }
        }
        if (method === "approval.requested") {
          void this.handleApprovalNotification(params);
        }
      });
      if (subscribed.cursor !== undefined) {
        stream.push(
          {
            kind: "subscription.ready",
            payload: subscribed,
            sessionId: this.id,
            sequence: subscribed.cursor.journalSequence,
          },
          subscribed.cursor,
        );
      }
    } catch (error) {
      stream.fail(error);
    }
  }
}

function readTurnId(receipt: OperationReceipt): string {
  const result = receipt.result;
  if (isRecord(result) && typeof result.turnId === "string") return result.turnId;
  return receipt.commandId;
}

function normalizePush(params: unknown): StreamEvent[] {
  if (!isRecord(params)) return [];
  if (Array.isArray(params.events)) {
    return params.events.map((event) => {
      const row = isRecord(event) ? event : {};
      return {
        kind: typeof row.kind === "string" ? row.kind : "unknown",
        payload: row.payload ?? row,
        ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
        ...(typeof row.id === "string" ? { id: row.id } : {}),
        ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}),
        ...(typeof row.timestamp === "string" ? { timestamp: row.timestamp } : {}),
      };
    });
  }
  return [{
    kind: typeof params.kind === "string" ? params.kind : "unknown",
    payload: params.payload ?? params,
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
