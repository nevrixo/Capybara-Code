/**
 * Transport-independent App Protocol dispatch core.
 *
 * HTTP, loopback WebSocket, and stdio transports may all call dispatch; they
 * never gain direct access to daemon/domain objects. The backend is deliberately
 * narrow so production can route to Rust authority while tests use a fake.
 */

import {
  APP_CAPABILITY_SCHEMA_REVISION,
  APP_METHODS,
  APP_PROTOCOL_VERSION,
  AppProtocolError,
  finalizeCapabilitySnapshot,
  negotiateAppProtocol,
  structuredError,
  validateCommandEnvelope,
  type AppCapabilitySnapshot,
  type AppClientRole,
  type AppInitializeParams,
  type AppInitializeResult,
  type AppMethodCapability,
  type AppMethod,
  type AppServerLimits,
  type AppTransportKind,
  type CommandEnvelope,
  type EventCursor,
  type EventReplayResult,
  type EventSubscription,
} from "@cbc/app-protocol";

export type AppJsonRpcId = string | number;

export interface AppJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: AppJsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface AppJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data: {
    readonly code: string;
    readonly category: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
  };
}

export type AppJsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: AppJsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: AppJsonRpcId; readonly error: AppJsonRpcError };

export interface AppServerSubscription extends EventSubscription {}

export interface AppServerBackend {
  /** App methods this backend actually implements; absent names are unsupported. */
  readonly supportedMethods?: readonly AppMethod[];
  registerClient(input: {
    readonly client: AppInitializeParams["client"];
    readonly seenAt: string;
  }): Promise<void>;
  createSubscription(input: {
    readonly id: string;
    readonly clientId: string;
    readonly sessionId: string;
    readonly initialAckedSequence: number;
    readonly filter: {
      readonly kinds: readonly string[];
      readonly visibility: readonly string[];
      readonly includeEphemeral: boolean;
    };
    readonly createdAt: string;
  }): Promise<AppServerSubscription>;
  acknowledgeSubscription(input: {
    readonly subscriptionId: string;
    readonly clientId: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly at: string;
  }): Promise<AppServerSubscription>;
  setSubscriptionState(input: {
    readonly subscriptionId: string;
    readonly clientId: string;
    readonly state: "active" | "paused" | "closed";
    readonly at: string;
  }): Promise<AppServerSubscription>;
  replaySubscription(input: {
    readonly subscriptionId: string;
    readonly clientId: string;
    readonly afterSequence?: number;
    readonly maxEvents: number;
    readonly maxBytes: number;
  }): Promise<EventReplayResult>;
  health?(): Promise<Readonly<Record<string, unknown>>>;
  dispatch?(input: {
    readonly method: AppMethod;
    readonly params: unknown;
    readonly clientId: string;
    readonly roles: readonly AppClientRole[];
  }): Promise<unknown>;
}

export interface AppServerAuthorizer {
  authorize(params: AppInitializeParams): Promise<readonly AppClientRole[]>;
}

export interface AppServerOptions {
  readonly backend: AppServerBackend;
  readonly authorizer: AppServerAuthorizer;
  readonly daemonId: string;
  readonly serverVersion?: string;
  readonly capabilities?: Readonly<Record<string, boolean | string | number>>;
  readonly transport?: AppTransportKind;
  readonly disabledMethods?: Readonly<Partial<Record<AppMethod, string>>>;
  readonly presentation?: Partial<{
    readonly richDiff: boolean;
    readonly inlineApprovals: boolean;
    readonly taskTree: boolean;
    readonly planReview: boolean;
    readonly artifacts: boolean;
  }>;
  readonly limits?: Partial<AppServerLimits>;
  readonly now?: () => string;
  readonly newConnectionId?: () => string;
}

interface ConnectionContext {
  readonly client: AppInitializeParams["client"];
  readonly roles: readonly AppClientRole[];
  readonly capabilitySnapshot: AppCapabilitySnapshot;
}

const DEFAULT_LIMITS: AppServerLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 6 * 1024 * 1024,
  maxSubscriptionsPerClient: 64,
  // One durable event_subscriptions row owns one session cursor.
  maxSessionsPerSubscription: 1,
};

const BUILTIN_METHODS = new Set<AppMethod>([
  "server.initialize",
  "server.capabilities",
  "server.ping",
  "server.health",
  "server.version",
  "events.subscribe",
  "events.unsubscribe",
  "events.replay",
  "events.ack",
]);

const OBSERVER_METHODS = new Set<AppMethod>([
  "server.capabilities", "server.ping", "server.health", "server.version", "server.logs.tail",
  "workspace.inspect", "workspace.list", "workspace.trust.get", "workspace.services",
  "session.list", "session.get", "session.attach", "session.detach", "session.ensure", "session.export",
  "turn.get", "turn.list", "turn.wait", "turn.input.get",
  "events.subscribe", "events.unsubscribe", "events.replay", "events.ack", "events.getSnapshot",
  "approval.list", "approval.get",
  "graph.get", "graph.listNodes",
  "task.get", "task.wait",
  "memory.list", "memory.get", "memory.search",
  "lsp.status", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover",
  "lsp.rename.preview", "lsp.codeActions",
  "edit.preview", "edit.getReceipt", "diff.get", "diff.getFile",
  "worktree.list", "worktree.get", "worktree.getProposal", "merge.preview",
  "plugin.list", "plugin.inspect", "plugin.grants",
  "package.search", "package.inspect",
  "artifact.getMetadata", "artifact.read", "artifact.stream",
]);

const APPROVAL_METHODS = new Set<AppMethod>(["approval.resolve", "approval.cancel"]);
const ADMIN_METHODS = new Set<AppMethod>([
  "workspace.trust.set",
  "plugin.install", "plugin.update", "plugin.enable", "plugin.disable", "plugin.resolveGrant",
  "package.install", "package.remove", "package.update", "package.verify", "package.bootstrap",
]);

/**
 * Stateful only in its short-lived connection registry. Durable facts are kept
 * in the injected backend, which production maps to the Rust session store.
 */
export class AppServer {
  readonly #backend: AppServerBackend;
  readonly #authorizer: AppServerAuthorizer;
  readonly #daemonId: string;
  readonly #serverVersion: string;
  readonly #capabilities: Readonly<Record<string, boolean | string | number>>;
  readonly #transport: AppTransportKind;
  readonly #supportedMethods: ReadonlySet<AppMethod>;
  readonly #disabledMethods: Readonly<Partial<Record<AppMethod, string>>>;
  readonly #presentation: NonNullable<AppServerOptions["presentation"]>;
  readonly #limits: AppServerLimits;
  readonly #now: () => string;
  readonly #newConnectionId: () => string;
  readonly #connections = new Map<string, ConnectionContext>();

  constructor(options: AppServerOptions) {
    this.#backend = options.backend;
    this.#authorizer = options.authorizer;
    this.#daemonId = requireOpaqueId("daemonId", options.daemonId);
    this.#serverVersion = options.serverVersion ?? "0.1.0";
    this.#capabilities = options.capabilities ?? {};
    this.#transport = options.transport ?? "stdio";
    this.#supportedMethods = supportedMethodSet(options.backend);
    this.#disabledMethods = Object.freeze({ ...(options.disabledMethods ?? {}) });
    this.#presentation = Object.freeze({ ...(options.presentation ?? {}) });
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newConnectionId = options.newConnectionId
      ?? (() => "conn_" + crypto.randomUUID().replaceAll("-", ""));
  }

  get limits(): AppServerLimits {
    return this.#limits;
  }

  closeConnection(connectionId: string): void {
    this.#connections.delete(connectionId);
  }

  async dispatch(connectionId: string | undefined, request: unknown): Promise<AppJsonRpcResponse> {
    const id = requestId(request);
    try {
      const parsed = this.#validateRequest(request);
      if (parsed.method === "server.initialize") {
        return this.#result(parsed.id, await this.#initialize(parsed.params));
      }
      if (!APP_METHODS.includes(parsed.method as AppMethod)) {
        throw appError(
          "APP_METHOD_NOT_FOUND",
          "protocol",
          "unknown App Protocol method '" + parsed.method + "'",
        );
      }
      if (connectionId === undefined) {
        throw appError("APP_CONNECTION_REQUIRED", "protocol", "server.initialize must complete first");
      }
      const connection = this.#connections.get(connectionId);
      if (connection === undefined) {
        throw appError(
          "APP_CONNECTION_UNKNOWN",
          "protocol",
          "connection is not initialized",
          { retryable: true },
        );
      }
      const result = await this.#dispatchInitialized(parsed.method as AppMethod, parsed.params, connection);
      return this.#result(parsed.id, result);
    } catch (error) {
      return this.#error(id, error);
    }
  }

  #validateRequest(request: unknown): AppJsonRpcRequest {
    const encoded = safeJson(request);
    if (encoded === undefined || byteLength(encoded) > this.#limits.maxRequestBytes) {
      throw appError("APP_REQUEST_TOO_LARGE", "resource_limit", "request exceeds App Server size limit");
    }
    if (
      !isRecord(request)
      || request.jsonrpc !== "2.0"
      || (typeof request.id !== "string" && typeof request.id !== "number")
      || typeof request.method !== "string"
      || request.method.trim().length === 0
    ) {
      throw appError(
        "APP_REQUEST_INVALID",
        "protocol",
        "request must be a JSON-RPC 2.0 request with an id",
      );
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      method: request.method,
      ...(request.params === undefined ? {} : { params: request.params }),
    };
  }

  async #initialize(params: unknown): Promise<AppInitializeResult> {
    const input = validateInitialize(params);
    const protocolVersion = negotiateAppProtocol(input.protocolVersion, APP_PROTOCOL_VERSION);
    const roles = normalizeRoles(await this.#authorizer.authorize(input));
    await this.#backend.registerClient({ client: input.client, seenAt: this.#now() });
    const connectionId = this.#newConnectionId();
    if (this.#connections.has(connectionId)) {
      throw appError("APP_CONNECTION_COLLISION", "internal", "connection id generator returned a duplicate");
    }
    const capabilitySnapshot = this.#buildCapabilitySnapshot(roles, input.capabilities);
    this.#connections.set(connectionId, { client: input.client, roles, capabilitySnapshot });
    return {
      protocolVersion,
      serverVersion: this.#serverVersion,
      daemonId: this.#daemonId,
      connectionId,
      capabilities: this.#capabilities,
      capabilitySnapshot,
      limits: this.#limits,
    };
  }

  async #dispatchInitialized(
    method: AppMethod,
    params: unknown,
    connection: ConnectionContext,
  ): Promise<unknown> {
    const support = connection.capabilitySnapshot.methods[method];
    if (support.state === "unsupported") {
      throw appError(
        "APP_METHOD_UNSUPPORTED",
        "unavailable",
        support.reason ?? method + " is not implemented by this host",
      );
    }
    if (support.state === "disabled") {
      throw appError(
        "APP_METHOD_DISABLED",
        "permission",
        support.reason ?? method + " is disabled by host policy",
      );
    }
    if (method === "server.capabilities") {
      return {
        capabilities: this.#capabilities,
        capabilitySnapshot: connection.capabilitySnapshot,
        limits: this.#limits,
        roles: connection.roles,
      };
    }
    if (method === "server.ping") return { now: this.#now(), daemonId: this.#daemonId };
    if (method === "server.version") {
      return { protocolVersion: APP_PROTOCOL_VERSION, serverVersion: this.#serverVersion };
    }
    if (method === "server.health") return this.#backend.health?.() ?? { status: "ready" };
    if (method === "events.subscribe") return this.#subscribe(params, connection);
    if (method === "events.replay") return this.#replay(params, connection);
    if (method === "events.ack") return this.#acknowledge(params, connection);
    if (method === "events.unsubscribe") return this.#unsubscribe(params, connection);

    requireRole(connection.roles, roleFor(method), method);
    if (requiresCommandEnvelope(method)) validateBoundCommandEnvelope(params, connection.client.id);
    if (this.#backend.dispatch === undefined) {
      throw appError(
        "APP_METHOD_UNAVAILABLE",
        "unavailable",
        method + " is not available in this host",
        { retryable: true },
      );
    }
    return this.#backend.dispatch({
      method,
      params,
      clientId: connection.client.id,
      roles: connection.roles,
    });
  }

  #buildCapabilitySnapshot(
    roles: readonly AppClientRole[],
    client: AppInitializeParams["capabilities"],
  ): AppCapabilitySnapshot {
    const methods = {} as Record<AppMethod, AppMethodCapability>;
    for (const method of APP_METHODS) {
      const requiresRole = capabilityRoleFor(method);
      const disabledReason = this.#disabledMethods[method];
      if (!this.#supportedMethods.has(method)) {
        methods[method] = {
          state: "unsupported",
          reason: method + " is declared by the protocol but is not implemented by this host",
          ...(requiresRole === undefined ? {} : { requiresRole }),
        };
      } else if (disabledReason !== undefined) {
        methods[method] = {
          state: "disabled",
          reason: disabledReason,
          ...(requiresRole === undefined ? {} : { requiresRole }),
        };
      } else if (requiresRole !== undefined && !roles.includes(requiresRole)) {
        methods[method] = {
          state: "read-only",
          reason: "this connection does not have the " + requiresRole + " role",
          requiresRole,
        };
      } else {
        methods[method] = {
          state: "available",
          ...(requiresRole === undefined ? {} : { requiresRole }),
        };
      }
    }

    const enabled = (method: AppMethod): boolean => methods[method].state === "available";
    const visible = (method: AppMethod): boolean => {
      const state = methods[method].state;
      return state === "available" || state === "read-only";
    };
    const hostRichDiff = this.#presentation.richDiff ?? visible("diff.get");
    const hostInlineApprovals = this.#presentation.inlineApprovals ?? visible("approval.list");
    const hostTaskTree = this.#presentation.taskTree
      ?? (visible("graph.get") || visible("graph.listNodes"));
    const hostPlanReview = this.#presentation.planReview ?? visible("edit.preview");
    const hostArtifacts = this.#presentation.artifacts ?? visible("artifact.getMetadata");
    return finalizeCapabilitySnapshot({
      protocolVersion: APP_PROTOCOL_VERSION,
      schemaRevision: APP_CAPABILITY_SCHEMA_REVISION,
      serverVersion: this.#serverVersion,
      transport: this.#transport,
      methods,
      events: {
        replay: enabled("events.replay"),
        ack: enabled("events.ack"),
        snapshots: enabled("events.getSnapshot"),
        maxBatchEvents: 10_000,
        maxBatchBytes: this.#limits.maxResponseBytes,
      },
      presentation: {
        richDiff: hostRichDiff && client.richDiff,
        inlineApprovals: hostInlineApprovals && client.approvals,
        taskTree: hostTaskTree && client.taskTree === true,
        planReview: hostPlanReview && client.planReview === true,
        artifacts: hostArtifacts && client.artifactStreaming,
      },
    });
  }

  async #subscribe(params: unknown, connection: ConnectionContext): Promise<unknown> {
    requireRole(connection.roles, "observer", "events.subscribe");
    const input = requireRecord("events.subscribe params", params);
    const subscriptionId = optionalOpaqueId(input.subscriptionId, "subscriptionId")
      ?? "sub_" + crypto.randomUUID().replaceAll("-", "");
    const request = requireRecord("subscription request", input.request);
    const sessionIds = requireStringArray(
      "sessionIds",
      request.sessionIds,
      this.#limits.maxSessionsPerSubscription,
    );
    if (sessionIds.length !== 1) {
      throw appError(
        "APP_SUBSCRIPTION_SESSION_COUNT",
        "validation",
        "exactly one session is required for this server",
      );
    }
    const sessionId = requireOpaqueId("sessionId", sessionIds[0]);
    const from = request.from === undefined ? undefined : requireRecord("subscription from", request.from);
    const cursor = from?.[sessionId] === undefined
      ? undefined
      : validateCursor(from[sessionId], sessionId);
    const kinds = optionalStringArray("kinds", request.kinds, 128);
    const visibility = optionalStringArray("visibility", request.visibility, 128);
    const includeEphemeral = request.includeEphemeral === undefined
      ? false
      : requireBoolean("includeEphemeral", request.includeEphemeral);
    validateBatchLimit("maxBatchEvents", request.maxBatchEvents, 1, 10_000);
    validateBatchLimit("maxBatchBytes", request.maxBatchBytes, 1024, this.#limits.maxResponseBytes);
    const subscription = await this.#backend.createSubscription({
      id: subscriptionId,
      clientId: connection.client.id,
      sessionId,
      initialAckedSequence: cursor?.journalSequence ?? 0,
      filter: { kinds, visibility, includeEphemeral },
      createdAt: this.#now(),
    });
    return {
      subscription,
      cursor: { sessionId, journalSequence: subscription.lastAckedSequence },
    };
  }

  async #replay(params: unknown, connection: ConnectionContext): Promise<EventReplayResult> {
    requireRole(connection.roles, "observer", "events.replay");
    const input = requireRecord("events.replay params", params);
    const subscriptionId = requireOpaqueId("subscriptionId", input.subscriptionId);
    const after = input.after === undefined ? undefined : validateCursor(input.after, undefined);
    const maxEvents = boundedBatchLimit("maxEvents", input.maxEvents, 1, 10_000, 64);
    const maxBytes = boundedBatchLimit(
      "maxBytes",
      input.maxBytes,
      1024,
      this.#limits.maxResponseBytes,
      Math.min(1024 * 1024, this.#limits.maxResponseBytes),
    );
    const replay = await this.#backend.replaySubscription({
      subscriptionId,
      clientId: connection.client.id,
      ...(after === undefined ? {} : { afterSequence: after.journalSequence }),
      maxEvents,
      maxBytes,
    });
    validateReplayResult(replay, {
      subscriptionId,
      clientId: connection.client.id,
      ...(after === undefined ? {} : { after }),
      maxEvents,
    });
    return replay;
  }


  async #acknowledge(params: unknown, connection: ConnectionContext): Promise<unknown> {
    requireRole(connection.roles, "observer", "events.ack");
    const input = requireRecord("events.ack params", params);
    const subscriptionId = requireOpaqueId("subscriptionId", input.subscriptionId);
    const cursor = validateCursor(input.cursor, undefined);
    const subscription = await this.#backend.acknowledgeSubscription({
      subscriptionId,
      clientId: connection.client.id,
      sessionId: cursor.sessionId,
      sequence: cursor.journalSequence,
      at: this.#now(),
    });
    if (subscription.sessionId !== cursor.sessionId) {
      throw appError(
        "APP_CURSOR_SESSION_MISMATCH",
        "conflict",
        "cursor session does not match subscription",
      );
    }
    return {
      subscription,
      cursor: {
        sessionId: subscription.sessionId,
        journalSequence: subscription.lastAckedSequence,
      },
    };
  }

  async #unsubscribe(params: unknown, connection: ConnectionContext): Promise<unknown> {
    requireRole(connection.roles, "observer", "events.unsubscribe");
    const input = requireRecord("events.unsubscribe params", params);
    const subscriptionId = requireOpaqueId("subscriptionId", input.subscriptionId);
    const subscription = await this.#backend.setSubscriptionState({
      subscriptionId,
      clientId: connection.client.id,
      state: "closed",
      at: this.#now(),
    });
    return { subscription };
  }

  #result(id: AppJsonRpcId, result: unknown): AppJsonRpcResponse {
    const response: AppJsonRpcResponse = { jsonrpc: "2.0", id, result };
    const encoded = safeJson(response);
    if (encoded === undefined || byteLength(encoded) > this.#limits.maxResponseBytes) {
      return this.#error(
        id,
        appError("APP_RESPONSE_TOO_LARGE", "resource_limit", "response exceeds App Server size limit"),
      );
    }
    return response;
  }

  #error(id: AppJsonRpcId, error: unknown): AppJsonRpcResponse {
    const structured = error instanceof AppProtocolError
      ? error.structured
      : structuredError(
        "APP_INTERNAL",
        "internal",
        "App Server failed to process the request",
        { retryable: true },
      );
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: jsonRpcErrorCode(structured.code, structured.category),
        message: structured.message,
        data: {
          code: structured.code,
          category: structured.category,
          retryable: structured.retryable,
          ...(structured.details === undefined ? {} : { details: structured.details }),
        },
      },
    };
  }
}

function validateInitialize(params: unknown): AppInitializeParams {
  const input = requireRecord("initialize params", params);
  const client = requireRecord("initialize client", input.client);
  const capabilities = requireRecord("initialize capabilities", input.capabilities);
  const parsed: AppInitializeParams = {
    protocolVersion: requireVersion("protocolVersion", input.protocolVersion),
    client: {
      id: requireOpaqueId("client.id", client.id),
      name: requireText("client.name", client.name, 256),
      version: requireVersion("client.version", client.version),
      kind: requireClientKind(client.kind),
    },
    capabilities: {
      eventStreaming: requireBoolean("capabilities.eventStreaming", capabilities.eventStreaming),
      eventAck: requireBoolean("capabilities.eventAck", capabilities.eventAck),
      approvals: requireBoolean("capabilities.approvals", capabilities.approvals),
      interactivePrompts: requireBoolean("capabilities.interactivePrompts", capabilities.interactivePrompts),
      artifactStreaming: requireBoolean("capabilities.artifactStreaming", capabilities.artifactStreaming),
      richDiff: requireBoolean("capabilities.richDiff", capabilities.richDiff),
      ...(capabilities.taskTree === undefined
        ? {}
        : { taskTree: requireBoolean("capabilities.taskTree", capabilities.taskTree) }),
      ...(capabilities.planReview === undefined
        ? {}
        : { planReview: requireBoolean("capabilities.planReview", capabilities.planReview) }),
    },
    ...(input.authentication === undefined
      ? {}
      : { authentication: validateAuthentication(input.authentication) }),
  };
  return parsed;
}

function validateAuthentication(value: unknown): { readonly challengeResponse?: string } {
  const authentication = requireRecord("authentication", value);
  if (authentication.challengeResponse === undefined) return {};
  return {
    challengeResponse: requireText(
      "authentication.challengeResponse",
      authentication.challengeResponse,
      4096,
    ),
  };
}

function validateCursor(value: unknown, expectedSessionId: string | undefined): EventCursor {
  const cursor = requireRecord("event cursor", value);
  const sessionId = requireOpaqueId("cursor.sessionId", cursor.sessionId);
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw appError(
      "APP_CURSOR_SESSION_MISMATCH",
      "validation",
      "cursor session must match the subscription session",
    );
  }
  const journalSequence = requireNonNegativeInteger("cursor.journalSequence", cursor.journalSequence);
  const eventId = cursor.eventId === undefined ? undefined : requireOpaqueId("cursor.eventId", cursor.eventId);
  const snapshotSequence = cursor.snapshotSequence === undefined
    ? undefined
    : requireNonNegativeInteger("cursor.snapshotSequence", cursor.snapshotSequence);
  return {
    sessionId,
    journalSequence,
    ...(eventId === undefined ? {} : { eventId }),
    ...(snapshotSequence === undefined ? {} : { snapshotSequence }),
  };
}

function validateReplayResult(
  replay: EventReplayResult,
  expected: {
    readonly subscriptionId: string;
    readonly clientId: string;
    readonly after?: EventCursor;
    readonly maxEvents: number;
  },
): void {
  if (
    !isRecord(replay)
    || !isRecord(replay.subscription)
    || !isRecord(replay.cursor)
    || !Array.isArray(replay.events)
    || typeof replay.hasMore !== "boolean"
  ) {
    invalidReplayBackendResponse();
  }
  const subscription = replay.subscription;
  const cursor = replay.cursor;
  if (
    subscription.id !== expected.subscriptionId
    || subscription.clientId !== expected.clientId
    || typeof subscription.sessionId !== "string"
    || !Number.isSafeInteger(subscription.lastAckedSequence)
    || subscription.lastAckedSequence < 0
    || cursor.sessionId !== subscription.sessionId
    || !Number.isSafeInteger(cursor.journalSequence)
    || cursor.journalSequence < 0
    || replay.events.length > expected.maxEvents
  ) {
    invalidReplayBackendResponse();
  }
  if (expected.after !== undefined && expected.after.sessionId !== subscription.sessionId) {
    throw appError(
      "APP_CURSOR_SESSION_MISMATCH",
      "validation",
      "cursor session must match the subscription session",
    );
  }
  const initialSequence = expected.after?.journalSequence ?? subscription.lastAckedSequence;
  if (cursor.journalSequence < initialSequence) invalidReplayBackendResponse();

  let previousSequence = initialSequence;
  for (const event of replay.events) {
    const sequence = isRecord(event) ? event.sequence : undefined;
    if (
      !isRecord(event)
      || event.sessionId !== subscription.sessionId
      || typeof sequence !== "number"
      || !Number.isSafeInteger(sequence)
      || sequence <= previousSequence
      || sequence > cursor.journalSequence
    ) {
      invalidReplayBackendResponse();
    }
    previousSequence = sequence;
  }
}

function invalidReplayBackendResponse(): never {
  throw appError(
    "APP_REPLAY_BACKEND_INVALID",
    "internal",
    "backend returned an invalid event replay response",
  );
}


function validateBoundCommandEnvelope(params: unknown, clientId: string): void {
  const input = requireRecord("command params", params);
  const command = input.command as CommandEnvelope<unknown> | undefined;
  if (command === undefined || typeof command !== "object") {
    throw appError(
      "APP_COMMAND_ENVELOPE_REQUIRED",
      "validation",
      "mutating App methods require a command envelope",
    );
  }
  try {
    validateCommandEnvelope(command);
  } catch (error) {
    if (error instanceof AppProtocolError) throw error;
    throw appError("APP_COMMAND_INVALID", "validation", "invalid command envelope");
  }
  if (command.clientId !== clientId) {
    throw appError(
      "APP_COMMAND_CLIENT_MISMATCH",
      "permission",
      "command clientId does not match the connection",
    );
  }
}

function roleFor(method: AppMethod): AppClientRole {
  if (OBSERVER_METHODS.has(method)) return "observer";
  if (APPROVAL_METHODS.has(method)) return "approval_resolver";
  if (ADMIN_METHODS.has(method)) return "administrator-local";
  return "controller";
}

function capabilityRoleFor(method: AppMethod): AppClientRole | undefined {
  if (
    method === "server.initialize"
    || method === "server.capabilities"
    || method === "server.ping"
    || method === "server.health"
    || method === "server.version"
  ) {
    return undefined;
  }
  return roleFor(method);
}

function supportedMethodSet(backend: AppServerBackend): ReadonlySet<AppMethod> {
  const supported = new Set<AppMethod>(BUILTIN_METHODS);
  if (backend.dispatch !== undefined) {
    for (const method of backend.supportedMethods ?? []) supported.add(method);
  }
  return supported;
}

function requiresCommandEnvelope(method: AppMethod): boolean {
  // Subscription and session-attach lifecycle (ensure/attach/detach) are
  // idempotent connection ownership, not command-envelope mutations. Every
  // other mutation, including approval and administrator actions, must use
  // the common command envelope.
  return !OBSERVER_METHODS.has(method);
}

function requireRole(roles: readonly AppClientRole[], required: AppClientRole, method: string): void {
  if (!roles.includes(required)) {
    throw appError(
      "APP_ROLE_DENIED",
      "permission",
      method + " requires the " + required + " role",
    );
  }
}

function normalizeRoles(roles: readonly AppClientRole[]): readonly AppClientRole[] {
  const allowed = new Set<AppClientRole>([
    "observer",
    "controller",
    "approval_resolver",
    "administrator-local",
  ]);
  const unique: AppClientRole[] = [];
  for (const role of roles) {
    if (!allowed.has(role)) {
      throw appError("APP_ROLE_INVALID", "permission", "authorizer returned an unknown role");
    }
    if (!unique.includes(role)) unique.push(role);
  }
  return unique;
}

function requestId(value: unknown): AppJsonRpcId {
  if (isRecord(value) && (typeof value.id === "string" || typeof value.id === "number")) {
    return value.id;
  }
  return 0;
}

function requireRecord(name: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw appError("APP_PARAMS_INVALID", "validation", name + " must be an object");
  }
  return value;
}

function requireStringArray(name: string, value: unknown, limit: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) {
    throw appError(
      "APP_PARAMS_INVALID",
      "validation",
      name + " must contain 1 to " + String(limit) + " strings",
    );
  }
  const items = value.map((item) => requireOpaqueId(name, item));
  if (new Set(items).size !== items.length) {
    throw appError("APP_PARAMS_INVALID", "validation", name + " must not contain duplicates");
  }
  return items;
}

function optionalStringArray(name: string, value: unknown, limit: number): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) {
    throw appError("APP_PARAMS_INVALID", "validation", name + " exceeds its item limit");
  }
  const items = value.map((item) => requireText(name, item, 128));
  if (new Set(items).size !== items.length) {
    throw appError("APP_PARAMS_INVALID", "validation", name + " must not contain duplicates");
  }
  return items;
}

function validateBatchLimit(name: string, value: unknown, minimum: number, maximum: number): void {
  if (value === undefined) return;
  const parsed = requireNonNegativeInteger(name, value);
  if (parsed < minimum || parsed > maximum) {
    throw appError(
      "APP_PARAMS_INVALID",
      "validation",
      name + " must be between " + String(minimum) + " and " + String(maximum),
    );
  }
}

function boundedBatchLimit(
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = requireNonNegativeInteger(name, value);
  if (parsed < minimum || parsed > maximum) {
    throw appError(
      "APP_PARAMS_INVALID",
      "validation",
      name + " must be between " + String(minimum) + " and " + String(maximum),
    );
  }
  return parsed;
}


function optionalOpaqueId(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireOpaqueId(name, value);
}

function requireOpaqueId(name: string, value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    throw appError("APP_PARAMS_INVALID", "validation", name + " must be an opaque identifier");
  }
  return value;
}

function requireText(name: string, value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.trim() !== value
    || byteLength(value) > maxBytes
  ) {
    throw appError(
      "APP_PARAMS_INVALID",
      "validation",
      name + " must be bounded non-empty text",
    );
  }
  return value;
}

function requireVersion(name: string, value: unknown): string {
  const version = requireText(name, value, 64);
  if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw appError("APP_PARAMS_INVALID", "protocol", name + " must be a semantic protocol version");
  }
  return version;
}

function requireClientKind(value: unknown): AppInitializeParams["client"]["kind"] {
  if (
    value === "tui"
    || value === "cli"
    || value === "ide"
    || value === "sdk"
    || value === "ci"
    || value === "plugin-host"
  ) {
    return value;
  }
  throw appError("APP_PARAMS_INVALID", "validation", "client.kind is unsupported");
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw appError("APP_PARAMS_INVALID", "validation", name + " must be boolean");
  }
  return value;
}

function requireNonNegativeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw appError(
      "APP_PARAMS_INVALID",
      "validation",
      name + " must be a non-negative integer",
    );
  }
  return value;
}

function validateLimits(limits: AppServerLimits): AppServerLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw appError("APP_LIMIT_INVALID", "validation", name + " must be a positive integer");
    }
  }

  if (limits.maxResponseBytes < 1024) {
    throw appError(
      "APP_LIMIT_INVALID",
      "validation",
      "maxResponseBytes must allow the minimum 1024-byte event batch",
    );
  }

  if (limits.maxSessionsPerSubscription !== 1) {
    throw appError(
      "APP_LIMIT_INVALID",
      "validation",
      "maxSessionsPerSubscription is currently fixed at one durable cursor",
    );
  }
  return limits;
}

function jsonRpcErrorCode(code: string, category: string): number {
  if (code === "APP_METHOD_NOT_FOUND") return -32601;
  if (category === "protocol") return -32600;
  if (category === "validation") return -32602;
  return -32000;
}

function appError(
  code: string,
  category: Parameters<typeof structuredError>[1],
  message: string,
  options: { readonly retryable?: boolean } = {},
): AppProtocolError {
  return new AppProtocolError(structuredError(code, category, message, options));
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./runtime-backend.ts";
