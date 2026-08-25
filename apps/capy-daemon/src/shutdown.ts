/**
 * Graceful daemon shutdown: stop admission, flush events, snapshot, quiesce.
 */

import type { EventHub } from "./event-hub.ts";
import type { LocalTransport } from "./local-transport.ts";
import type { PluginSupervisor } from "./plugin-supervisor.ts";
import type { WorkspaceSupervisorRegistry } from "./workspace-supervisor.ts";
import type { InstanceLockHandle } from "./instance-lock.ts";

export interface ShutdownTargets {
  readonly workspaces: WorkspaceSupervisorRegistry;
  readonly eventHub: EventHub;
  readonly transport?: LocalTransport;
  readonly plugins?: PluginSupervisor;
  readonly lock?: InstanceLockHandle;
  readonly onNotice?: (message: string) => void;
}

export interface ShutdownReport {
  readonly flushedSessions: number;
  readonly stoppedPlugins: number;
  readonly releasedLock: boolean;
}

export async function gracefulShutdown(targets: ShutdownTargets): Promise<ShutdownReport> {
  targets.onNotice?.("daemon shutting down");
  const snapshots = targets.workspaces.list();
  let flushedSessions = 0;
  for (const workspace of snapshots) {
    for (const sessionId of workspace.sessionIds) {
      const supervisor = targets.workspaces.get(workspace.workspaceIdentityDigest);
      const actor = supervisor?.getSession(sessionId);
      if (actor === undefined) continue;
      await actor.dispatch({ kind: "snapshot_session" });
      flushedSessions += 1;
    }
  }

  let stoppedPlugins = 0;
  if (targets.plugins !== undefined) {
    stoppedPlugins = await targets.plugins.stopAll();
  }

  targets.workspaces.clear();

  if (targets.transport !== undefined) {
    await targets.transport.close();
  }

  let releasedLock = false;
  if (targets.lock !== undefined) {
    targets.lock.release();
    releasedLock = true;
  }

  targets.onNotice?.("daemon stopped");
  return { flushedSessions, stoppedPlugins, releasedLock };
}
