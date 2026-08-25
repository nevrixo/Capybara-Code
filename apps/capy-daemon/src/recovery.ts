/**
 * Startup recovery: interrupt open work, restore session actors, bump owner epoch.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ApprovalManager } from "./approval-manager.ts";
import type { EventHub } from "./event-hub.ts";
import type { SessionActor } from "./session-actor.ts";
import type { WorkspaceSupervisorRegistry } from "./workspace-supervisor.ts";

export type RecoveryClassification =
  | "safe_idle"
  | "interrupted_recoverable"
  | "waiting_approval"
  | "blocked_reconciliation"
  | "failed_integrity";

export interface RecoveredSession {
  readonly sessionId: string;
  readonly workspaceIdentityDigest: string;
  readonly classification: RecoveryClassification;
  readonly ownerEpoch: number;
  readonly pendingApprovalIds: readonly string[];
}

export interface SessionRecoverySeed {
  readonly sessionId: string;
  readonly workspaceIdentityDigest: string;
  readonly lastJournalSequence?: number;
  readonly hadOpenTurn?: boolean;
  readonly pendingApprovalIds?: readonly string[];
  readonly integrityOk?: boolean;
}

export interface RecoveryOptions {
  readonly workspaces: WorkspaceSupervisorRegistry;
  readonly approvals: ApprovalManager;
  readonly eventHub: EventHub;
  readonly sessions?: readonly SessionRecoverySeed[];
  readonly persistedPath?: string;
  readonly now?: () => string;
}

export interface PersistedDaemonRecovery {
  readonly schemaVersion: "1";
  readonly sessions: readonly SessionRecoverySeed[];
  readonly eventHub?: {
    readonly sequences?: Readonly<Record<string, number>>;
    readonly journals?: Readonly<Record<string, readonly import("./event-hub.ts").HubEvent[]>>;
  };
}

export interface RecoveryReport {
  readonly recovered: readonly RecoveredSession[];
  readonly interruptedTurns: number;
  readonly ownerEpochBump: number;
}

/**
 * Runs the daemon-local half of startup reconciliation. Durable store work stays
 * behind the injected backend; this layer only rebuilds in-memory actors.
 */
export function loadPersistedRecovery(path: string): PersistedDaemonRecovery | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PersistedDaemonRecovery;
    if (raw.schemaVersion !== "1" || !Array.isArray(raw.sessions)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function persistRecoveryState(path: string, state: PersistedDaemonRecovery): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
}

export async function recoverDaemonState(options: RecoveryOptions): Promise<RecoveryReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const recovered: RecoveredSession[] = [];
  let interruptedTurns = 0;
  let ownerEpochBump = 0;
  const persisted = options.persistedPath === undefined
    ? undefined
    : loadPersistedRecovery(options.persistedPath);
  if (persisted?.eventHub !== undefined) {
    options.eventHub.restoreSnapshot(persisted.eventHub);
  }
  const seeds = options.sessions ?? persisted?.sessions ?? [];

  for (const seed of seeds) {
    const workspace = options.workspaces.getOrCreate(seed.workspaceIdentityDigest);
    const actor = workspace.getOrCreateSession(seed.sessionId);
    const epoch = actor.bumpOwnerEpoch();
    ownerEpochBump += 1;

    if (seed.lastJournalSequence !== undefined) {
      await actor.dispatch({ kind: "set_journal_sequence", sequence: seed.lastJournalSequence });
    }

    let classification: RecoveryClassification = "safe_idle";
    if (seed.integrityOk === false) {
      classification = "failed_integrity";
    } else if ((seed.pendingApprovalIds?.length ?? 0) > 0) {
      classification = "waiting_approval";
      for (const approvalId of seed.pendingApprovalIds ?? []) {
        await actor.dispatch({ kind: "mark_waiting_approval", approvalId });
      }
    } else if (seed.hadOpenTurn === true) {
      classification = "interrupted_recoverable";
      interruptedTurns += 1;
      options.eventHub.publish(seed.sessionId, {
        schemaVersion: "1.0",
        id: `evt_recovery_${seed.sessionId}_${String(epoch)}`,
        kind: "session.recovery_completed",
        payload: { classification, ownerEpoch: epoch, interrupted: true },
        timestamp: now(),
      });
    }

    recovered.push({
      sessionId: seed.sessionId,
      workspaceIdentityDigest: seed.workspaceIdentityDigest,
      classification,
      ownerEpoch: epoch,
      pendingApprovalIds: seed.pendingApprovalIds ?? [],
    });
  }

  return { recovered, interruptedTurns, ownerEpochBump };
}

export async function interruptOpenWork(actor: SessionActor): Promise<void> {
  const state = actor.state;
  if (state.activeTurnId === undefined) return;
  if (state.controlLease !== undefined) {
    await actor.dispatch({
      kind: "cancel_turn",
      clientId: state.controlLease.clientId,
      turnId: state.activeTurnId,
    });
  }
}
