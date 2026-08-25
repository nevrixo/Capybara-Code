/**
 * CapybaraClient — App Protocol JSON-RPC client (stdio / unix / pipe).
 *
 * Speaks only App Protocol methods. Never calls Rust runtime RPC methods.
 */

import {
  APP_PROTOCOL_VERSION,
  AppProtocolError,
  negotiateAppProtocol,
  structuredError,
  type AppClientKind,
  type AppInitializeParams,
  type AppInitializeResult,
  type StructuredErrorCategory,
} from "@cbc/app-protocol";

import { Session } from "./session.ts";

export type TransportKind = "stdio" | "unix" | "pipe";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: string | number; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: string | number; readonly error: JsonRpcErrorBody };

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface JsonRpcTransport {
  send(message: JsonRpcMessage): Promise<void> | void;
  subscribe(handler: (message: JsonRpcMessage) => void): () => void;
  close(): Promise<void> | void;
}

export interface ConnectOptions {
  readonly transport: TransportKind;
  readonly path?: string;
  readonly command?: string | readonly string[];
  readonly client?: {
    readonly id?: string;
    readonly name?: string;
    readonly version?: string;
    readonly kind?: AppClientKind;
  };
  readonly now?: () => string;
  /**
   * Test / embedder seam. When provided, transport/path/command are ignored
   * for I/O and this implementation is used instead.
   */
  readonly createTransport?: (options: ConnectOptions) => JsonRpcTransport;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

export class CapybaraClient {
  #transport: JsonRpcTransport;
  #unsubscribeTransport: () => void;
  readonly #clientId: string;
  readonly #now: () => string;
  readonly #pending = new Map<string | number, Pending>();
  readonly #notificationHandlers = new Set<(method: string, params: unknown) => void>();
  #nextId = 1;
  #initialize: AppInitializeResult | undefined;
  #closed = false;
  #connectOptions: ConnectOptions;

  private constructor(
    transport: JsonRpcTransport,
    clientId: string,
    connectOptions: ConnectOptions,
  ) {
    this.#transport = transport;
    this.#clientId = clientId;
    this.#connectOptions = connectOptions;
    this.#now = connectOptions.now ?? (() => new Date().toISOString());
    this.#unsubscribeTransport = transport.subscribe((message) => this.#onMessage(message));
  }

  get clientId(): string {
    return this.#clientId;
  }

  get connectionId(): string | undefined {
    return this.#initialize?.connectionId;
  }

  get initializeResult(): AppInitializeResult | undefined {
    return this.#initialize;
  }

  static async connect(options: ConnectOptions): Promise<CapybaraClient> {
    const clientId = options.client?.id ?? `client_${crypto.randomUUID().replaceAll("-", "")}`;
    const transport = options.createTransport?.(options) ?? openTransport(options);
    const client = new CapybaraClient(transport, clientId, options);
    await client.#handshake();
    return client;
  }

  session(sessionId: string): Session {
    return new Session({
      sessionId,
      now: this.#now,
      rpc: {
        clientId: this.#clientId,
        request: (method, params) => this.request(method, params),
        onNotification: (handler) => this.onNotification(handler),
      },
    });
  }

  async createSession(params: Record<string, unknown> = {}): Promise<Session> {
    const result = await this.request<{ sessionId: string }>("session.create", {
      command: {
        schemaVersion: "1.0",
        commandId: `cmd_${crypto.randomUUID().replaceAll("-", "")}`,
        idempotencyKey: `idem_session_${crypto.randomUUID().replaceAll("-", "")}`,
        correlationId: `cor_${crypto.randomUUID().replaceAll("-", "")}`,
        clientId: this.#clientId,
        issuedAt: this.#now(),
        payload: params,
      },
    });
    return this.session(result.sessionId);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) throw new Error("client is closed");
    const id = this.#nextId++;
    const request: JsonRpcRequest = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    const result = await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      Promise.resolve(this.#transport.send(request)).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return result as T;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.#notificationHandlers.add(handler);
    return () => {
      this.#notificationHandlers.delete(handler);
    };
  }

  /**
   * Close the current transport, attach a replacement, and re-handshake.
   * In-flight requests are rejected; callers should resubmit with the same
   * idempotencyKey (see Session.resubmitLast).
   */
  async reconnect(transport?: JsonRpcTransport): Promise<AppInitializeResult> {
    for (const [, pending] of this.#pending) {
      pending.reject(new Error("connection lost"));
    }
    this.#pending.clear();
    this.#unsubscribeTransport();
    await this.#transport.close();

    const next = transport
      ?? this.#connectOptions.createTransport?.(this.#connectOptions)
      ?? openTransport(this.#connectOptions);
    this.#transport = next;
    this.#unsubscribeTransport = next.subscribe((message) => this.#onMessage(message));
    this.#closed = false;
    this.#initialize = undefined;
    return this.#handshake();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      pending.reject(new Error("client closed"));
    }
    this.#pending.clear();
    this.#unsubscribeTransport();
    await this.#transport.close();
  }

  async #handshake(): Promise<AppInitializeResult> {
    const params: AppInitializeParams = {
      protocolVersion: APP_PROTOCOL_VERSION,
      client: {
        id: this.#clientId,
        name: this.#connectOptions.client?.name ?? "cbc-sdk",
        version: this.#connectOptions.client?.version ?? "0.1.0",
        kind: this.#connectOptions.client?.kind ?? "sdk",
      },
      capabilities: {
        eventStreaming: true,
        eventAck: true,
        approvals: true,
        interactivePrompts: true,
        artifactStreaming: true,
        richDiff: true,
      },
    };
    const result = await this.request<AppInitializeResult>("server.initialize", params);
    negotiateAppProtocol(result.protocolVersion, APP_PROTOCOL_VERSION);
    this.#initialize = result;
    return result;
  }

  #onMessage(message: JsonRpcMessage): void {
    if (isNotification(message)) {
      for (const handler of this.#notificationHandlers) {
        handler(message.method, message.params);
      }
      return;
    }
    if (!isResponse(message)) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if ("error" in message) {
      pending.reject(toAppError(message.error));
      return;
    }
    pending.resolve(message.result);
  }
}

function openTransport(options: ConnectOptions): JsonRpcTransport {
  throw new AppProtocolError(structuredError(
    "APP_TRANSPORT_UNSUPPORTED",
    "unavailable",
    `transport '${options.transport}' requires an embedded host or createTransport hook` +
      (options.path !== undefined ? ` (path=${options.path})` : "") +
      (options.command !== undefined ? ` (command=${String(options.command)})` : ""),
  ));
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message);
}

function toAppError(error: JsonRpcErrorBody): AppProtocolError {
  const data = error.data;
  if (isRecord(data) && typeof data.code === "string") {
    const category = typeof data.category === "string"
      ? data.category as StructuredErrorCategory
      : "protocol";
    return new AppProtocolError(structuredError(
      data.code,
      category,
      error.message,
      {
        retryable: data.retryable === true,
        ...(isRecord(data.details) ? { details: data.details } : {}),
      },
    ));
  }
  return new AppProtocolError(structuredError("APP_RPC_ERROR", "protocol", error.message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
