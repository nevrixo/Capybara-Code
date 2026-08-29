import { isAbsolute } from "node:path";

import {
  APP_COMMAND_SCHEMA_VERSION,
  type AppCapabilitySnapshot,
  type AppMethod,
  type CommandEnvelope,
  type OperationReceipt,
} from "@cbc/app-protocol";

export type AcpJsonRpcId = string | number | null;

export interface AcpJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: AcpJsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpJsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type AcpIncomingMessage = AcpJsonRpcRequest | AcpJsonRpcNotification;

export type AcpJsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: AcpJsonRpcId; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: AcpJsonRpcId;
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
    };

export interface AcpAppClient {
  readonly clientId: string;
  readonly initializeResult: {
    readonly capabilitySnapshot?: AppCapabilitySnapshot;
  } | undefined;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

export interface AcpPeer {
  notify(method: string, params: unknown): Promise<void> | void;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export interface AcpAdapterOptions {
  readonly app: AcpAppClient;
  readonly peer: AcpPeer;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
}

interface AcpSessionState {
  readonly sessionId: string;
  readonly cwd: string;
  lastTurnId?: string;
}

/** Official ACP v1 method names supported by the adapter. */
export const ACP_AGENT_METHODS = [
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/cancel",
] as const;

/**
 * Thin ACP v1 -> App Protocol bridge. It owns no agent loop and performs no
 * filesystem, terminal, credential, or process operation on the client's behalf.
 */
export class AcpAdapter {
  readonly #app: AcpAppClient;
  readonly #peer: AcpPeer;
  readonly #agentName: string;
  readonly #agentVersion: string;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;
  readonly #sessions = new Map<string, AcpSessionState>();
  readonly #unsubscribe: () => void;
  #initialized = false;

  constructor(options: AcpAdapterOptions) {
    this.#app = options.app;
    this.#peer = options.peer;
    this.#agentName = options.agentName ?? "Capybara Code";
    this.#agentVersion = options.agentVersion ?? "0.1.0";
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? ((prefix) => prefix + crypto.randomUUID().replaceAll("-", ""));
    this.#unsubscribe = this.#app.onNotification((method, params) => {
      void this.#onAppNotification(method, params);
    });
  }

  async handle(message: unknown): Promise<AcpJsonRpcResponse | undefined> {
    if (!isIncomingMessage(message)) {
      return errorResponse(null, -32600, "invalid ACP JSON-RPC request");
    }
    const notification = !("id" in message);
    try {
      const result = await this.#dispatch(message.method, message.params, notification);
      if (notification) return undefined;
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (error) {
      if (notification) return undefined;
      const normalized = normalizeError(error);
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: normalized,
      };
    }
  }

  dispose(): void {
    this.#unsubscribe();
  }

  async #dispatch(method: string, params: unknown, notification: boolean): Promise<unknown> {
    if (method === "initialize") return this.#initialize(params);
    if (!this.#initialized) throw acpError(-32000, "initialize must complete first");
    if (method === "session/new") return this.#newSession(params);
    if (method === "session/load") return this.#loadSession(params);
    if (method === "session/prompt") return this.#prompt(params);
    if (method === "session/cancel") {
      if (!notification) throw acpError(-32600, "session/cancel must be a notification");
      await this.#cancel(params);
      return {};
    }
    if (method.startsWith("_")) {
      throw acpError(-32601, "ACP extension method is not supported by this adapter");
    }
    throw acpError(-32601, "unknown ACP method '" + method + "'");
  }

  #initialize(params: unknown): unknown {
    const input = requireRecord(params, "initialize params");
    const protocolVersion = input.protocolVersion;
    if (protocolVersion !== 1) {
      throw acpError(-32602, "Capybara supports ACP protocolVersion 1");
    }
    this.#initialized = true;
    const snapshot = this.#app.initializeResult?.capabilitySnapshot;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: methodVisible(snapshot, "session.get") || methodVisible(snapshot, "session.attach"),
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: methodVisible(snapshot, "session.list"),
          resume: methodVisible(snapshot, "session.resume"),
          close: methodVisible(snapshot, "session.close"),
        },
      },
      authMethods: [],
      agentInfo: {
        name: this.#agentName,
        version: this.#agentVersion,
      },
      _meta: {
        capybara: {
          appCapabilityDigest: snapshot?.snapshotDigest ?? null,
          unsupportedByClient: ["graph", "worktree", "memory_contest", "plugin_grants"],
          runtimeOwnedTools: true,
        },
      },
    };
  }

  async #newSession(params: unknown): Promise<unknown> {
    const input = requireRecord(params, "session/new params");
    const cwd = requireText(input.cwd, "cwd");
    if (!isAbsolute(cwd)) throw acpError(-32602, "session/new cwd must be absolute");
    const result = await this.#app.request<unknown>("session.create", {
      command: this.#command("session.create", {
        cwd,
        additionalDirectories: requireStringArray(input.additionalDirectories),
        mcpServers: Array.isArray(input.mcpServers) ? input.mcpServers : [],
      }),
    });
    const sessionId = findString(result, ["sessionId", "result.sessionId"]);
    if (sessionId === undefined) throw acpError(-32603, "App Protocol did not return a sessionId");
    this.#sessions.set(sessionId, { sessionId, cwd });
    return {
      sessionId,
      modes: {
        currentModeId: "build",
        availableModes: [
          { id: "plan", name: "Plan", description: "Review before mutation" },
          { id: "build", name: "Build", description: "Execute approved work" },
        ],
      },
      _meta: { capybara: { daemonOwned: true } },
    };
  }

  async #loadSession(params: unknown): Promise<unknown> {
    const input = requireRecord(params, "session/load params");
    const sessionId = requireText(input.sessionId, "sessionId");
    const cwd = requireText(input.cwd, "cwd");
    if (!isAbsolute(cwd)) throw acpError(-32602, "session/load cwd must be absolute");
    await this.#app.request("session.get", { sessionId });
    this.#sessions.set(sessionId, { sessionId, cwd });
    return {
      sessionId,
      modes: {
        currentModeId: "build",
        availableModes: [
          { id: "plan", name: "Plan" },
          { id: "build", name: "Build" },
        ],
      },
      _meta: { capybara: { replayRequired: true } },
    };
  }

  async #prompt(params: unknown): Promise<unknown> {
    const input = requireRecord(params, "session/prompt params");
    const sessionId = requireText(input.sessionId, "sessionId");
    const state = this.#sessions.get(sessionId);
    if (state === undefined) throw acpError(-32002, "unknown ACP session");
    const prompt = promptText(input.prompt);
    const receipt = await this.#app.request<OperationReceipt>("turn.submit", {
      command: this.#command("turn.submit", { prompt }, sessionId),
    });
    state.lastTurnId = findString(receipt, ["result.turnId"]) ?? receipt.commandId;
    const finalText = findString(receipt, ["result.answer"]);
    if (finalText !== undefined) {
      await this.#peer.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: finalText },
        },
      });
    }
    return {
      stopReason: receipt.status === "cancelled"
        ? "cancelled"
        : receipt.status === "failed"
          ? "refusal"
          : "end_turn",
      _meta: {
        capybara: {
          receiptId: receipt.receiptId,
          status: receipt.status,
          evidenceIds: receipt.evidenceIds,
        },
      },
    };
  }

  async #cancel(params: unknown): Promise<void> {
    const input = requireRecord(params, "session/cancel params");
    const sessionId = requireText(input.sessionId, "sessionId");
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return;
    await this.#app.request("turn.cancel", {
      command: this.#command(
        "turn.cancel",
        { ...(state.lastTurnId === undefined ? {} : { turnId: state.lastTurnId }) },
        sessionId,
      ),
    });
  }

  async #onAppNotification(method: string, params: unknown): Promise<void> {
    if (method === "approval.pending" || method === "approval.requested") {
      await this.#requestPermission(params);
      return;
    }
    if (method !== "events.push" && method !== "event" && method !== "session.event") return;
    const source = requireOptionalRecord(params);
    const events = Array.isArray(source?.events) ? source.events : [source];
    for (const event of events) {
      const row = requireOptionalRecord(event);
      if (row === undefined) continue;
      const sessionId = typeof row.sessionId === "string"
        ? row.sessionId
        : typeof source?.sessionId === "string"
          ? source.sessionId
          : undefined;
      if (sessionId === undefined) continue;
      const update = projectAppEvent(row);
      if (update === undefined) continue;
      await this.#peer.notify("session/update", {
        sessionId,
        update,
        _meta: {
          capybara: {
            eventId: typeof row.id === "string" ? row.id : null,
            sequence: typeof row.sequence === "number" ? row.sequence : null,
          },
        },
      });
    }
  }

  async #requestPermission(params: unknown): Promise<void> {
    const input = requireOptionalRecord(params);
    if (input === undefined) return;
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
    const approvalId = typeof input.approvalId === "string" ? input.approvalId : undefined;
    const actionHash = typeof input.actionHash === "string" ? input.actionHash : undefined;
    if (sessionId === undefined || approvalId === undefined || actionHash === undefined) return;
    const response = await this.#peer.request<unknown>("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: approvalId,
        kind: toolKind(input),
        status: "pending",
        title: typeof input.title === "string" ? input.title : "Capybara approval",
        rawInput: sanitizeApprovalInput(input),
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
      _meta: {
        capybara: {
          actionHash,
          risk: input.risk ?? null,
        },
      },
    });
    const selected = findString(response, ["outcome.optionId", "optionId"]);
    const decision = selected === "allow_once" ? "allow_once" : "deny";
    await this.#app.request("approval.resolve", {
      command: this.#command("approval.resolve", {
        approvalId,
        actionHash,
        decision,
      }, sessionId),
    });
  }

  #command<T>(method: string, payload: T, sessionId?: string): CommandEnvelope<T> {
    const commandId = this.#newId("cmd_acp_");
    return {
      schemaVersion: APP_COMMAND_SCHEMA_VERSION,
      commandId,
      idempotencyKey: this.#newId("idem_acp_"),
      correlationId: this.#newId("cor_acp_"),
      clientId: this.#app.clientId,
      ...(sessionId === undefined ? {} : { sessionId }),
      issuedAt: this.#now(),
      payload,
    };
  }
}

function methodVisible(snapshot: AppCapabilitySnapshot | undefined, method: AppMethod): boolean {
  const state = snapshot?.methods[method]?.state;
  return state === "available" || state === "read-only";
}

function promptText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw acpError(-32602, "session/prompt requires at least one content block");
  }
  const parts: string[] = [];
  for (const block of value) {
    const item = requireRecord(block, "prompt content block");
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (item.type === "resource_link" && typeof item.uri === "string") {
      parts.push("@" + item.uri);
      continue;
    }
    throw acpError(-32602, "this ACP client content block is not supported");
  }
  const prompt = parts.join("\n\n").trim();
  if (prompt.length === 0 || prompt.length > 1024 * 1024) {
    throw acpError(-32602, "ACP prompt text must be non-empty and bounded");
  }
  return prompt;
}

function projectAppEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const kind = typeof event.kind === "string" ? event.kind : "";
  const payload = requireOptionalRecord(event.payload) ?? {};
  const text = typeof payload.text === "string"
    ? payload.text
    : typeof payload.delta === "string"
      ? payload.delta
      : undefined;
  if (kind === "assistant.delta" || kind === "assistant.commentary" || kind === "assistant.final") {
    if (text === undefined) return undefined;
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    };
  }
  if (kind === "assistant.reasoning" || kind === "assistant.thinking") {
    if (text === undefined) return undefined;
    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    };
  }
  if (kind.startsWith("plan.")) {
    return {
      sessionUpdate: "plan",
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      _meta: { capybara: payload },
    };
  }
  if (kind === "tool.started") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "tool_unknown",
      title: typeof payload.tool === "string" ? payload.tool : "Capybara tool",
      kind: toolKind(payload),
      status: "in_progress",
      rawInput: payload,
    };
  }
  if (kind === "tool.completed" || kind === "tool.failed") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "tool_unknown",
      status: kind === "tool.completed" ? "completed" : "failed",
      rawOutput: payload,
    };
  }
  if (kind.startsWith("task.") || kind.startsWith("graph.") || kind.startsWith("worktree.")) {
    return {
      sessionUpdate: "available_commands_update",
      availableCommands: [],
      _meta: { capybara: { kind, payload } },
    };
  }
  return undefined;
}

function toolKind(value: Record<string, unknown>): string {
  const tool = typeof value.tool === "string" ? value.tool : "";
  if (tool.startsWith("fs.read") || tool.includes("search")) return "read";
  if (tool.startsWith("fs.") || tool.includes("edit")) return "edit";
  if (tool.startsWith("process.")) return "execute";
  if (tool.includes("network") || tool.includes("fetch")) return "fetch";
  return "other";
}

function sanitizeApprovalInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["tool", "action", "command", "cwd", "readPaths", "writePaths", "networkDestinations", "risk", "reason"]) {
    const value = input[key];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || Array.isArray(value)
    ) {
      out[key] = value;
    }
  }
  return out;
}

function requireStringArray(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !isAbsolute(item))) {
    throw acpError(-32602, "additionalDirectories must contain absolute paths");
  }
  return value as string[];
}

function findString(value: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path.split(".")) {
      current = requireOptionalRecord(current)?.[segment];
    }
    if (typeof current === "string" && current.length > 0) return current;
  }
  return undefined;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw acpError(-32602, name + " must be a non-empty string");
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  const record = requireOptionalRecord(value);
  if (record === undefined) throw acpError(-32602, name + " must be an object");
  return record;
}

function requireOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isIncomingMessage(value: unknown): value is AcpIncomingMessage {
  const input = requireOptionalRecord(value);
  return input?.jsonrpc === "2.0"
    && typeof input.method === "string"
    && (
      !Object.hasOwn(input, "id")
      || input.id === null
      || typeof input.id === "string"
      || typeof input.id === "number"
    );
}

function acpError(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

function normalizeError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof Error && "code" in error && typeof error.code === "number") {
    const data = "data" in error ? error.data : undefined;
    return { code: error.code, message: error.message, ...(data === undefined ? {} : { data }) };
  }
  return { code: -32603, message: "ACP adapter internal error" };
}

function errorResponse(id: AcpJsonRpcId, code: number, message: string): AcpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
