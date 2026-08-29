import {
  APP_COMMAND_SCHEMA_VERSION,
  type AppCapabilitySnapshot,
  type CommandEnvelope,
  type EventCursor,
  type EventReplayEvent,
  type EventReplayResult,
  type OperationReceipt,
} from "@cbc/app-protocol";
import {
  EventReplayProjector,
  ReconnectStateMachine,
  createEditorContextAttachment,
  projectApproval,
  projectEditReceipt,
  type ApprovalPresentation,
  type ApprovalPresentationInput,
  type EditorContextAttachment,
  type EditorContextInput,
  type EditReceiptProjectionInput,
  type RichDiffProjection,
} from "@cbc/integration-core";

export interface VscodeAppClient {
  readonly clientId: string;
  readonly initializeResult: {
    readonly connectionId: string;
    readonly capabilitySnapshot: AppCapabilitySnapshot;
  } | undefined;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  reconnect?(): Promise<{ readonly connectionId: string; readonly capabilitySnapshot: AppCapabilitySnapshot }>;
  close(): Promise<void> | void;
}

export interface VscodeIntegrationStateStore {
  loadCursor(sessionId: string): Promise<EventCursor | undefined>;
  saveCursor(sessionId: string, cursor: EventCursor): Promise<void>;
}

export interface VscodeControllerOptions {
  readonly connect: () => Promise<VscodeAppClient>;
  readonly state: VscodeIntegrationStateStore;
  readonly workspaceIdentityDigest: string;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
}

export interface VscodeTimelineEvent {
  readonly id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly payload: unknown;
}

export type VscodeControllerListener = (event: {
  readonly kind: "state" | "timeline" | "approval";
  readonly value: unknown;
}) => void;

/**
 * VS Code integration state without a VS Code dependency. The extension host is
 * only a presentation layer; all agent mutations still cross App Protocol.
 */
export class VscodeIntegrationController {
  readonly #connectClient: () => Promise<VscodeAppClient>;
  readonly #store: VscodeIntegrationStateStore;
  readonly #workspaceIdentityDigest: string;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;
  readonly #connection = new ReconnectStateMachine();
  readonly #timeline: VscodeTimelineEvent[] = [];
  readonly #timelineIds = new Set<string>();
  readonly #listeners = new Set<VscodeControllerListener>();
  #client: VscodeAppClient | undefined;
  #capabilities: AppCapabilitySnapshot | undefined;
  #unsubscribe: (() => void) | undefined;
  #sessionId: string | undefined;
  #subscriptionId: string | undefined;
  #projector: EventReplayProjector | undefined;
  #attachment: EditorContextAttachment | undefined;
  #lastTurnId: string | undefined;

  constructor(options: VscodeControllerOptions) {
    this.#connectClient = options.connect;
    this.#store = options.state;
    this.#workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? ((prefix) => prefix + crypto.randomUUID().replaceAll("-", ""));
  }

  get connection() {
    return this.#connection.snapshot;
  }

  get timeline(): readonly VscodeTimelineEvent[] {
    return Object.freeze([...this.#timeline]);
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  onEvent(listener: VscodeControllerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.#connection.beginConnect();
    const client = await this.#connectClient();
    const initialized = client.initializeResult;
    if (initialized === undefined) throw new Error("App Protocol client did not initialize");
    requireAvailable(initialized.capabilitySnapshot, "session.attach");
    requireAvailable(initialized.capabilitySnapshot, "turn.submit");
    this.#client = client;
    this.#capabilities = initialized.capabilitySnapshot;
    this.#connection.initialize({
      connectionId: initialized.connectionId,
      capabilitySnapshot: initialized.capabilitySnapshot,
    });
    this.#unsubscribe?.();
    this.#unsubscribe = client.onNotification((method, params) => {
      void this.#onNotification(method, params);
    });
    this.#emit("state", this.connection);
  }

  async attachSession(sessionId: string): Promise<void> {
    const client = this.#requireClient();
    const cursor = await this.#store.loadCursor(sessionId);
    this.#connection.attach(sessionId, cursor);
    this.#sessionId = sessionId;
    this.#projector = new EventReplayProjector(sessionId, cursor?.journalSequence ?? 0);
    await client.request("session.attach", {
      sessionId,
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
      mode: "controller",
    });
    const subscribed = await client.request<{
      readonly subscription: { readonly id: string };
      readonly cursor: EventCursor;
    }>("events.subscribe", {
      request: {
        sessionIds: [sessionId],
        ...(cursor === undefined ? {} : { from: { [sessionId]: cursor } }),
      },
    });
    this.#subscriptionId = subscribed.subscription.id;
    await this.#replay(cursor);
    this.#emit("state", this.connection);
  }

  async createSession(cwd: string): Promise<string> {
    const client = this.#requireClient();
    const capabilities = this.#capabilities;
    if (capabilities === undefined) throw new Error("daemon capabilities are unavailable");
    let sessionId: string;
    if (capabilities.methods["session.create"].state === "available") {
      const result = await client.request<unknown>("session.create", {
        command: this.#command("session.create", {
          workspaceIdentityDigest: this.#workspaceIdentityDigest,
          cwd,
        }),
      });
      sessionId = readString(result, "sessionId") ?? readNestedString(result, "result", "sessionId")
        ?? this.#newId("session_vscode_");
    } else if (capabilities.methods["session.ensure"].state === "available") {
      sessionId = this.#newId("session_vscode_");
      await client.request("session.ensure", {
        sessionId,
        workspaceIdentityDigest: this.#workspaceIdentityDigest,
      });
    } else {
      throw new Error("daemon supports neither session.create nor session.ensure");
    }
    await this.attachSession(sessionId);
    return sessionId;
  }

  async reconnect(): Promise<void> {
    const client = this.#requireClient();
    const sessionId = this.#sessionId;
    this.#connection.disconnected("transport reconnect");
    this.#connection.beginConnect();
    if (client.reconnect === undefined) throw new Error("App Protocol client cannot reconnect");
    const initialized = await client.reconnect();
    this.#capabilities = initialized.capabilitySnapshot;
    this.#connection.initialize({
      connectionId: initialized.connectionId,
      capabilitySnapshot: initialized.capabilitySnapshot,
    });
    if (sessionId !== undefined) await this.attachSession(sessionId);
  }

  attachEditorContext(input: Omit<EditorContextInput, "workspaceIdentityDigest">): EditorContextAttachment {
    this.#attachment = createEditorContextAttachment({
      ...input,
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
    });
    this.#emit("state", { attachment: this.#attachment });
    return this.#attachment;
  }

  async submit(prompt: string): Promise<OperationReceipt> {
    const client = this.#requireClient();
    const sessionId = this.#requireSession();
    const command = this.#command("turn.submit", {
      prompt,
      ...(this.#attachment === undefined ? {} : { editorContext: this.#attachment }),
    }, sessionId);
    const receipt = await client.request<OperationReceipt>("turn.submit", { command });
    this.#lastTurnId = readString(receipt.result, "turnId") ?? receipt.commandId;
    this.#attachment = undefined;
    return receipt;
  }

  async cancel(): Promise<OperationReceipt> {
    const client = this.#requireClient();
    const sessionId = this.#requireSession();
    if (this.#lastTurnId === undefined) throw new Error("there is no active turn to cancel");
    return client.request<OperationReceipt>("turn.cancel", {
      command: this.#command("turn.cancel", { turnId: this.#lastTurnId }, sessionId),
    });
  }

  projectDiff(
    receipt: EditReceiptProjectionInput,
    expectedWorkspaceRevision?: string | number,
  ): RichDiffProjection {
    return projectEditReceipt(receipt, expectedWorkspaceRevision);
  }

  async resolveApproval(
    input: ApprovalPresentationInput,
    decision: "allow_once" | "deny",
  ): Promise<OperationReceipt> {
    const card = projectApproval(input);
    this.#emit("approval", card);
    const client = this.#requireClient();
    const sessionId = this.#requireSession();
    return client.request<OperationReceipt>("approval.resolve", {
      command: this.#command("approval.resolve", {
        approvalId: input.approvalId,
        actionHash: input.actionHash,
        decision,
      }, sessionId),
    });
  }

  async listSessions(): Promise<unknown> {
    if (this.#capabilities?.methods["session.list"].state !== "available") {
      throw new Error("session.list is unsupported by this daemon");
    }
    return this.#requireClient().request("session.list", {
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
    });
  }

  async latestDiff(): Promise<unknown> {
    if (this.#capabilities?.methods["diff.get"].state !== "available") {
      throw new Error("diff.get is unsupported by this daemon");
    }
    return this.#requireClient().request("diff.get", {
      sessionId: this.#requireSession(),
    });
  }

  async dispose(): Promise<void> {
    const client = this.#client;
    const sessionId = this.#sessionId;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (client !== undefined && sessionId !== undefined) {
      await client.request("session.detach", {
        sessionId,
        workspaceIdentityDigest: this.#workspaceIdentityDigest,
      }).catch(() => undefined);
    }
    await client?.close();
    this.#client = undefined;
    this.#capabilities = undefined;
    this.#connection.close();
  }

  async #replay(cursor: EventCursor | undefined): Promise<void> {
    const client = this.#requireClient();
    const projector = this.#projector;
    const subscriptionId = this.#subscriptionId;
    if (projector === undefined || subscriptionId === undefined) return;
    this.#connection.beginReplay();
    let after = cursor;
    while (true) {
      const page = await client.request<EventReplayResult>("events.replay", {
        subscriptionId,
        ...(after === undefined ? {} : { after }),
      });
      const projection = projector.apply(page);
      this.#appendEvents(projection.events);
      after = projection.cursor;
      if (!page.hasMore) {
        projector.acknowledge(projection.cursor);
        this.#connection.acknowledge(projection.cursor);
        await client.request("events.ack", {
          subscriptionId,
          cursor: projection.cursor,
        });
        await this.#store.saveCursor(this.#requireSession(), projection.cursor);
        this.#connection.completeReplay("complete");
        break;
      }
    }
  }

  async #onNotification(method: string, params: unknown): Promise<void> {
    if (method === "approval.pending" || method === "approval.requested") {
      this.#emit("approval", params as ApprovalPresentation);
      return;
    }
    if (method !== "events.push") return;
    const input = optionalRecord(params);
    if (!Array.isArray(input?.events)) return;
    const cursor = optionalRecord(input.cursor);
    const events = input.events.flatMap((event) => normalizeEvent(event));
    this.#appendEvents(events);
    if (
      typeof cursor?.sessionId === "string"
      && typeof cursor.journalSequence === "number"
      && this.#sessionId === cursor.sessionId
    ) {
      const normalized: EventCursor = {
        sessionId: cursor.sessionId,
        journalSequence: cursor.journalSequence,
      };
      this.#connection.acknowledge(normalized);
      if (this.#subscriptionId !== undefined) {
        await this.#requireClient().request("events.ack", {
          subscriptionId: this.#subscriptionId,
          cursor: normalized,
        });
      }
      await this.#store.saveCursor(cursor.sessionId, normalized);
    }
  }

  #appendEvents(events: readonly EventReplayEvent[]): void {
    for (const event of events) {
      if (this.#timelineIds.has(event.id)) continue;
      this.#timelineIds.add(event.id);
      const projected = Object.freeze({
        id: event.id,
        kind: event.kind,
        sequence: event.sequence,
        payload: event.payload,
      });
      this.#timeline.push(projected);
      this.#emit("timeline", projected);
    }
  }

  #command<T>(method: string, payload: T, sessionId?: string): CommandEnvelope<T> {
    return {
      schemaVersion: APP_COMMAND_SCHEMA_VERSION,
      commandId: this.#newId("cmd_vscode_"),
      idempotencyKey: this.#newId("idem_vscode_" + method.replaceAll(".", "_") + "_"),
      correlationId: this.#newId("cor_vscode_"),
      clientId: this.#requireClient().clientId,
      ...(sessionId === undefined ? {} : { sessionId }),
      issuedAt: this.#now(),
      payload,
    };
  }

  #requireClient(): VscodeAppClient {
    if (this.#client === undefined) throw new Error("Capybara VS Code client is not connected");
    return this.#client;
  }

  #requireSession(): string {
    if (this.#sessionId === undefined) throw new Error("no Capybara session is attached");
    return this.#sessionId;
  }

  #emit(kind: "state" | "timeline" | "approval", value: unknown): void {
    for (const listener of this.#listeners) listener({ kind, value });
  }
}

function requireAvailable(snapshot: AppCapabilitySnapshot, method: keyof AppCapabilitySnapshot["methods"]): void {
  if (snapshot.methods[method].state !== "available") {
    throw new Error(method + " is " + snapshot.methods[method].state + " in this daemon");
  }
}

function normalizeEvent(value: unknown): EventReplayEvent[] {
  const row = optionalRecord(value);
  if (
    row === undefined
    || typeof row.id !== "string"
    || typeof row.sequence !== "number"
    || typeof row.sessionId !== "string"
    || typeof row.kind !== "string"
  ) {
    return [];
  }
  return [{
    schemaVersion: typeof row.schemaVersion === "string" ? row.schemaVersion : "1.0",
    sequence: row.sequence,
    id: row.id,
    timestamp: typeof row.timestamp === "string" ? row.timestamp : new Date(0).toISOString(),
    sessionId: row.sessionId,
    kind: row.kind,
    level: typeof row.level === "string" ? row.level : "info",
    visibility: typeof row.visibility === "string" ? row.visibility : "session",
    durability: "journaled",
    payload: row.payload ?? {},
  }];
}

function readString(value: unknown, key: string): string | undefined {
  const record = optionalRecord(value);
  return typeof record?.[key] === "string" ? record[key] : undefined;
}

function readNestedString(value: unknown, parent: string, key: string): string | undefined {
  return readString(optionalRecord(value)?.[parent], key);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
