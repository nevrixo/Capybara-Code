/**
 * Durable App Server cursor backend backed by the authoritative Rust runtime.
 *
 * The public server owns transport authentication and roles. This adapter owns
 * only fixed-shape translation for the five internal cursor RPCs, and never
 * exposes a raw sidecar error or response to an App Protocol caller.
 */

import {
  AppProtocolError,
  structuredError,
  type AppInitializeParams,
  type StructuredErrorCategory,
  type EventReplayEvent,
  type EventReplayResult,
} from "@cbc/app-protocol";
import { RuntimeRpcError, type RequestMethod } from "@cbc/protocol";

import type { AppServerBackend, AppServerSubscription } from "./index.ts";

export type RuntimeAppCursorMethod =
  | "app.client.upsert"
  | "app.subscription.create"
  | "app.subscription.ack"
  | "app.subscription.state"
  | "app.subscription.replay";

/** Structural subset implemented by RuntimeClient without coupling to process I/O. */
export interface RuntimeAppServerClient {
  request(method: RequestMethod, params?: unknown): Promise<unknown>;
}

/**
 * Routes App Server durable client/cursor operations through the internal RPC
 * boundary. All response fields that influence public cursor state are checked
 * before they cross the adapter.
 */
export class RuntimeAppServerBackend implements AppServerBackend {
  readonly #runtime: RuntimeAppServerClient;

  constructor(runtime: RuntimeAppServerClient) {
    this.#runtime = runtime;
  }

  async registerClient(
    input: Parameters<AppServerBackend["registerClient"]>[0],
  ): Promise<void> {
    const response = await this.#request("app.client.upsert", {
      clientId: input.client.id,
      name: input.client.name,
      kind: input.client.kind,
      version: input.client.version,
      seenAt: input.seenAt,
    });
    const client = clientResponse(response);
    if (client.clientId !== input.client.id || client.kind !== input.client.kind) {
      throw invalidRuntimeResponse();
    }
  }

  async createSubscription(
    input: Parameters<AppServerBackend["createSubscription"]>[0],
  ): Promise<AppServerSubscription> {
    const subscription = subscriptionResponse(
      await this.#request("app.subscription.create", {
        id: input.id,
        clientId: input.clientId,
        sessionId: input.sessionId,
        filter: {
          kinds: [...input.filter.kinds],
          visibility: [...input.filter.visibility],
          includeEphemeral: input.filter.includeEphemeral,
        },
        initialAckedSequence: input.initialAckedSequence,
        createdAt: input.createdAt,
      }),
    );
    if (
      subscription.id !== input.id
      || subscription.clientId !== input.clientId
      || subscription.sessionId !== input.sessionId
      || subscription.lastAckedSequence < input.initialAckedSequence
    ) {
      throw invalidRuntimeResponse();
    }
    return subscription;
  }

  async acknowledgeSubscription(
    input: Parameters<AppServerBackend["acknowledgeSubscription"]>[0],
  ): Promise<AppServerSubscription> {
    const subscription = subscriptionResponse(
      await this.#request("app.subscription.ack", {
        subscriptionId: input.subscriptionId,
        clientId: input.clientId,
        sequence: input.sequence,
        at: input.at,
      }),
    );
    if (
      subscription.id !== input.subscriptionId
      || subscription.clientId !== input.clientId
      || subscription.sessionId !== input.sessionId
      || subscription.lastAckedSequence < input.sequence
    ) {
      throw invalidRuntimeResponse();
    }
    return subscription;
  }

  async setSubscriptionState(
    input: Parameters<AppServerBackend["setSubscriptionState"]>[0],
  ): Promise<AppServerSubscription> {
    const subscription = subscriptionResponse(
      await this.#request("app.subscription.state", {
        subscriptionId: input.subscriptionId,
        clientId: input.clientId,
        state: input.state,
        at: input.at,
      }),
    );
    if (
      subscription.id !== input.subscriptionId
      || subscription.clientId !== input.clientId
      || subscription.state !== input.state
    ) {
      throw invalidRuntimeResponse();
    }
    return subscription;
  }

  async replaySubscription(
    input: Parameters<AppServerBackend["replaySubscription"]>[0],
  ): Promise<EventReplayResult> {
    const replay = replayResponse(
      await this.#request("app.subscription.replay", {
        subscriptionId: input.subscriptionId,
        clientId: input.clientId,
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        maxEvents: input.maxEvents,
        maxBytes: input.maxBytes,
      }),
      input.maxEvents,
      input.maxBytes,
    );
    const floor = input.afterSequence ?? replay.subscription.lastAckedSequence;
    if (
      replay.subscription.id !== input.subscriptionId
      || replay.subscription.clientId !== input.clientId
      || replay.cursor.sessionId !== replay.subscription.sessionId
      || replay.cursor.journalSequence < floor
      || replay.events.length > input.maxEvents
    ) {
      throw invalidRuntimeResponse();
    }
    let previousSequence = floor;
    for (const event of replay.events) {
      if (
        event.sessionId !== replay.subscription.sessionId
        || event.sequence <= previousSequence
        || event.sequence > replay.cursor.journalSequence
      ) {
        throw invalidRuntimeResponse();
      }
      previousSequence = event.sequence;
    }
    return replay;
  }


  async #request(method: RuntimeAppCursorMethod, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.#runtime.request(method, params);
    } catch (error) {
      throw runtimeFailure(error);
    }
  }
}

function clientResponse(value: unknown): {
  readonly clientId: string;
  readonly kind: AppInitializeParams["client"]["kind"];
} {
  const client = nestedRecord(value, "client");
  return {
    clientId: opaqueId(client.clientId),
    kind: clientKind(client.kind),
  };
}

function subscriptionResponse(value: unknown): AppServerSubscription {
  const subscription = nestedRecord(value, "subscription");
  return {
    id: opaqueId(subscription.id),
    clientId: opaqueId(subscription.clientId),
    sessionId: opaqueId(subscription.sessionId),
    state: subscriptionState(subscription.state),
    lastAckedSequence: nonNegativeSequence(subscription.lastAckedSequence),
  };
}

function replayResponse(
  value: unknown,
  maxEvents: number,
  maxBytes: number,
): EventReplayResult {
  if (
    !isRecord(value)
    || !Array.isArray(value.events)
    || typeof value.hasMore !== "boolean"
    || !Number.isSafeInteger(maxEvents)
    || maxEvents < 1
    || !Number.isSafeInteger(maxBytes)
    || maxBytes < 1
  ) {
    throw invalidRuntimeResponse();
  }
  if (value.events.length > maxEvents) throw invalidRuntimeResponse();

  const events = value.events.map(replayEvent);
  if (eventBatchByteLength(events) > maxBytes) throw invalidRuntimeResponse();

  const cursor = nestedRecord(value, "cursor");
  return {
    subscription: subscriptionResponse(value),
    cursor: {
      sessionId: opaqueId(cursor.sessionId),
      journalSequence: nonNegativeSequence(cursor.journalSequence),
    },
    events,
    hasMore: value.hasMore,
  };
}

// Runtime replay limits are caller-visible; enforce them on the normalized
// public event representation before this adapter returns it to App Server.
function eventBatchByteLength(events: readonly EventReplayEvent[]): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(events);
  } catch {
    throw invalidRuntimeResponse();
  }
  if (encoded === undefined) throw invalidRuntimeResponse();
  return UTF8.encode(encoded).byteLength;
}
function replayEvent(value: unknown): EventReplayEvent {
  if (!isRecord(value) || !Object.hasOwn(value, "payload") || value.payload === undefined) {
    throw invalidRuntimeResponse();
  }
  if (value.durability !== "journaled") throw invalidRuntimeResponse();
  const turnId = optionalEventText(value.turnId);
  const agentId = optionalEventText(value.agentId);
  const parentEventId = optionalEventText(value.parentEventId);
  const correlationId = optionalEventText(value.correlationId);
  const callerId = optionalEventText(value.callerId);
  const taskEpochId = optionalEventText(value.taskEpochId);
  const workspaceIdentityDigest = optionalEventText(value.workspaceIdentityDigest);
  return {
    schemaVersion: boundedText(value.schemaVersion, 64),
    sequence: nonNegativeSequence(value.sequence),
    id: eventText(value.id),
    timestamp: boundedText(value.timestamp, 128),
    sessionId: opaqueId(value.sessionId),
    ...(turnId === undefined ? {} : { turnId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(parentEventId === undefined ? {} : { parentEventId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(callerId === undefined ? {} : { callerId }),
    ...(taskEpochId === undefined ? {} : { taskEpochId }),
    ...(workspaceIdentityDigest === undefined ? {} : { workspaceIdentityDigest }),
    kind: boundedText(value.kind, 256),
    level: boundedText(value.level, 64),
    visibility: boundedText(value.visibility, 64),
    durability: "journaled",
    payload: value.payload,
  };
}

function optionalEventText(value: unknown): string | undefined {
  return value === undefined ? undefined : eventText(value);
}

function eventText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw invalidRuntimeResponse();
  }
  return value;
}

function boundedText(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
  ) {
    throw invalidRuntimeResponse();
  }
  return value;
}


function nestedRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value[field])) throw invalidRuntimeResponse();
  return value[field];
}

function opaqueId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    throw invalidRuntimeResponse();
  }
  return value;
}

function clientKind(value: unknown): AppInitializeParams["client"]["kind"] {
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
  throw invalidRuntimeResponse();
}

function subscriptionState(value: unknown): AppServerSubscription["state"] {
  if (value === "active" || value === "paused" || value === "closed") return value;
  throw invalidRuntimeResponse();
}

function nonNegativeSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRuntimeResponse();
  }
  return value;
}

function runtimeFailure(error: unknown): AppProtocolError {
  if (error instanceof RuntimeRpcError) {
    return new AppProtocolError(structuredError(
      "APP_RUNTIME_REJECTED",
      runtimeErrorCategory(error.taxonomy),
      "runtime rejected the app cursor request",
      { retryable: error.retryable },
    ));
  }
  return new AppProtocolError(structuredError(
    "APP_RUNTIME_UNAVAILABLE",
    "unavailable",
    "runtime cursor backend is unavailable",
    { retryable: true },
  ));
}

function runtimeErrorCategory(taxonomy: string): StructuredErrorCategory {
  switch (taxonomy) {
    case "INVALID_ARGUMENT":
      return "validation";
    case "NOT_FOUND":
      return "not_found";
    case "PERMISSION_DENIED":
    case "PATH_OUTSIDE_WORKSPACE":
    case "NETWORK_DENIED":
      return "permission";
    case "ALREADY_EXISTS":
    case "LEASE_VIOLATION":
    case "HASH_MISMATCH":
    case "PATH_CHANGED":
    case "TRANSACTION_CONFLICT":
      return "conflict";
    case "TIMEOUT":
    case "CANCELLED":
      return "timeout";
    case "OUTPUT_LIMIT":
    case "RESOURCE_LIMIT":
    case "TOO_MANY_REQUESTS":
      return "resource_limit";
    case "PROTOCOL_INCOMPATIBLE":
      return "protocol";
    case "NOT_INITIALIZED":
    case "SANDBOX_UNAVAILABLE":
      return "unavailable";
    default:
      return "internal";
  }
}

function invalidRuntimeResponse(): AppProtocolError {
  return new AppProtocolError(structuredError(
    "APP_RUNTIME_RESPONSE_INVALID",
    "internal",
    "runtime returned an invalid app cursor response",
  ));
}

const UTF8 = new TextEncoder();
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
