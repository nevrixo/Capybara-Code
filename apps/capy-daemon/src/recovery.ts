/**
 * Startup recovery: interrupt open work, restore session actors, bump owner epoch.
 */

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
  readonly now?: () => string;
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
export async function recoverDaemonState(options: RecoveryOptions): Promise<RecoveryReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const recovered: RecoveredSession[] = [];
  let interruptedTurns = 0;
  let ownerEpochBump = 0;

  for (const seed of options.sessions ?? []) {
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
