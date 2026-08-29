import type { AppCapabilitySnapshot, EventCursor } from "@cbc/app-protocol";

import { IntegrationContractError } from "./errors.ts";

export type IntegrationConnectionPhase =
  | "disconnected"
  | "connecting"
  | "ready"
  | "replaying"
  | "degraded"
  | "closed";

export type ReplayCompleteness = "complete" | "partial" | "unavailable";

export interface IntegrationConnectionSnapshot {
  readonly phase: IntegrationConnectionPhase;
  readonly connectionId?: string;
  readonly capabilityDigest?: string;
  readonly sessionId?: string;
  readonly lastAckedCursor?: EventCursor;
  readonly replayCompleteness?: ReplayCompleteness;
  readonly disconnectReason?: string;
}

/**
 * Small deterministic state machine shared by IDE, ACP, and daemon clients.
 * It never reconnects on its own; transports perform I/O and feed transitions.
 */
export class ReconnectStateMachine {
  #phase: IntegrationConnectionPhase = "disconnected";
  #connectionId: string | undefined;
  #capabilityDigest: string | undefined;
  #sessionId: string | undefined;
  #lastAckedCursor: EventCursor | undefined;
  #replayCompleteness: ReplayCompleteness | undefined;
  #disconnectReason: string | undefined;

  get snapshot(): IntegrationConnectionSnapshot {
    return Object.freeze({
      phase: this.#phase,
      ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
      ...(this.#capabilityDigest === undefined ? {} : { capabilityDigest: this.#capabilityDigest }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#lastAckedCursor === undefined
        ? {}
        : { lastAckedCursor: Object.freeze({ ...this.#lastAckedCursor }) }),
      ...(this.#replayCompleteness === undefined ? {} : { replayCompleteness: this.#replayCompleteness }),
      ...(this.#disconnectReason === undefined ? {} : { disconnectReason: this.#disconnectReason }),
    });
  }

  beginConnect(): void {
    this.#requirePhase(["disconnected", "degraded"], "begin connect");
    this.#phase = "connecting";
    this.#connectionId = undefined;
    this.#disconnectReason = undefined;
  }

  initialize(input: {
    readonly connectionId: string;
    readonly capabilitySnapshot: AppCapabilitySnapshot;
  }): void {
    this.#requirePhase(["connecting"], "initialize connection");
    requireText("connectionId", input.connectionId);
    requireText("capability snapshot digest", input.capabilitySnapshot.snapshotDigest);
    this.#connectionId = input.connectionId;
    this.#capabilityDigest = input.capabilitySnapshot.snapshotDigest;
    this.#phase = "ready";
    this.#replayCompleteness = undefined;
  }

  attach(sessionId: string, cursor?: EventCursor): void {
    this.#requirePhase(["ready"], "attach session");
    requireText("sessionId", sessionId);
    if (cursor !== undefined) validateCursor(cursor, sessionId);
    this.#sessionId = sessionId;
    this.#lastAckedCursor = cursor === undefined ? undefined : Object.freeze({ ...cursor });
  }

  acknowledge(cursor: EventCursor): void {
    this.#requirePhase(["ready", "replaying"], "acknowledge replay cursor");
    if (this.#sessionId === undefined) {
      throw new IntegrationContractError("INTEGRATION_CURSOR_INVALID", "a session must be attached before ACK");
    }
    validateCursor(cursor, this.#sessionId);
    if (
      this.#lastAckedCursor !== undefined
      && cursor.journalSequence < this.#lastAckedCursor.journalSequence
    ) {
      throw new IntegrationContractError(
        "INTEGRATION_CURSOR_INVALID",
        "an ACK cannot move the durable cursor backwards",
      );
    }
    this.#lastAckedCursor = Object.freeze({ ...cursor });
  }

  disconnected(reason: string): void {
    this.#requirePhase(["connecting", "ready", "replaying", "degraded"], "disconnect");
    requireText("disconnect reason", reason);
    this.#phase = "disconnected";
    this.#connectionId = undefined;
    this.#disconnectReason = reason;
  }

  beginReplay(): EventCursor | undefined {
    this.#requirePhase(["ready"], "begin replay");
    if (this.#sessionId === undefined) {
      throw new IntegrationContractError(
        "INTEGRATION_STATE_INVALID",
        "a session must be attached before replay",
      );
    }
    this.#phase = "replaying";
    this.#replayCompleteness = "partial";
    return this.#lastAckedCursor;
  }

  completeReplay(completeness: ReplayCompleteness): void {
    this.#requirePhase(["replaying"], "complete replay");
    this.#replayCompleteness = completeness;
    this.#phase = completeness === "complete" ? "ready" : "degraded";
  }

  close(): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.#connectionId = undefined;
  }

  #requirePhase(allowed: readonly IntegrationConnectionPhase[], operation: string): void {
    if (!allowed.includes(this.#phase)) {
      throw new IntegrationContractError(
        "INTEGRATION_STATE_INVALID",
        operation + " is invalid while connection is " + this.#phase,
      );
    }
  }
}

function validateCursor(cursor: EventCursor, sessionId: string): void {
  if (
    cursor.sessionId !== sessionId
    || !Number.isSafeInteger(cursor.journalSequence)
    || cursor.journalSequence < 0
  ) {
    throw new IntegrationContractError(
      "INTEGRATION_CURSOR_INVALID",
      "cursor must belong to the attached session and have a non-negative sequence",
    );
  }
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0 || value.trim() !== value) {
    throw new IntegrationContractError("INTEGRATION_STATE_INVALID", name + " must be non-empty");
  }
}
