import { createHash } from "node:crypto";

import { AppProtocolError, structuredError, type StructuredError } from "./errors.ts";

export const APP_COMMAND_SCHEMA_VERSION = "1.0" as const;

/** Every state-changing App Protocol request carries this envelope. */
export interface CommandEnvelope<T> {
  readonly schemaVersion: typeof APP_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly clientId: string;
  readonly workspaceIdentityDigest?: string;
  readonly sessionId?: string;
  readonly expectedRevision?: number | string;
  readonly issuedAt: string;
  readonly payload: T;
}

export type OperationReceiptStatus =
  | "accepted"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "blocked";

export interface OperationReceipt<T = unknown> {
  readonly schemaVersion: typeof APP_COMMAND_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly status: OperationReceiptStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly revisionBefore?: string | number;
  readonly revisionAfter?: string | number;
  readonly evidenceIds: readonly string[];
  readonly result?: T;
  readonly error?: StructuredError;
}

/** Stable JSON used for payload, plan, and proposal digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort((a, b) => a.localeCompare(b))) {
      const item = source[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

export function validateCommandEnvelope<T>(command: CommandEnvelope<T>): void {
  const required: Array<[string, string | undefined]> = [
    ["commandId", command.commandId],
    ["idempotencyKey", command.idempotencyKey],
    ["correlationId", command.correlationId],
    ["clientId", command.clientId],
    ["issuedAt", command.issuedAt],
  ];
  for (const [field, value] of required) {
    if (value === undefined || value.trim().length === 0) {
      throw new AppProtocolError(structuredError(
        "APP_COMMAND_INVALID",
        "validation",
        `${field} must be a non-empty string`,
      ));
    }
  }
  if (command.schemaVersion !== APP_COMMAND_SCHEMA_VERSION) {
    throw new AppProtocolError(structuredError(
      "APP_COMMAND_SCHEMA_VERSION_UNSUPPORTED",
      "protocol",
      `command schema version '${command.schemaVersion}' is not supported`,
    ));
  }
  if (!Number.isFinite(Date.parse(command.issuedAt))) {
    throw new AppProtocolError(structuredError(
      "APP_COMMAND_INVALID",
      "validation",
      "issuedAt must be an ISO-8601 timestamp",
    ));
  }
  // Materializing the payload detects values that would make a persisted retry
  // ambiguity impossible to reason about (undefined, bigint, functions, etc.).
  canonicalJson(command.payload);
}

export type DeduplicatedCommandResult<T> =
  | { readonly kind: "executed"; readonly receipt: OperationReceipt<T> }
  | { readonly kind: "replayed"; readonly receipt: OperationReceipt<T> };

interface StoredCommand<T> {
  readonly payloadHash: string;
  readonly pending: Promise<OperationReceipt<T>>;
}

/**
 * In-memory command idempotency gate. A daemon persists the same triples in
 * SQLite; this class gives embedded mode and unit tests identical semantics.
 */
export class CommandDeduplicator<TPayload, TResult> {
  readonly #entries = new Map<string, StoredCommand<TResult>>();

  async execute(
    command: CommandEnvelope<TPayload>,
    operation: () => Promise<OperationReceipt<TResult>>,
  ): Promise<DeduplicatedCommandResult<TResult>> {
    validateCommandEnvelope(command);
    const payloadHash = canonicalDigest(command.payload);
    const existing = this.#entries.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) {
        throw new AppProtocolError(structuredError(
          "IDEMPOTENCY_KEY_REUSED",
          "conflict",
          "the idempotency key was already used with a different payload",
          { details: { commandId: command.commandId } },
        ));
      }
      return { kind: "replayed", receipt: await existing.pending };
    }

    const pending = operation();
    this.#entries.set(command.idempotencyKey, { payloadHash, pending });
    try {
      return { kind: "executed", receipt: await pending };
    } catch (error) {
      // An operation that did not produce a durable receipt may safely be retried.
      // A caller that needs an error receipt should return one rather than throw.
      if (this.#entries.get(command.idempotencyKey)?.pending === pending) {
        this.#entries.delete(command.idempotencyKey);
      }
      throw error;
    }
  }

  get(idempotencyKey: string): Promise<OperationReceipt<TResult>> | undefined {
    return this.#entries.get(idempotencyKey)?.pending;
  }

  clear(): void {
    this.#entries.clear();
  }
}
