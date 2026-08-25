/**
 * Maps workspaceIdentityDigest -> supervisor and evicts idle workspaces.
 */

import { SessionActor } from "./session-actor.ts";

export type WorkspaceSupervisorLifecycle =
  | "created"
  | "initializing_runtime"
  | "ready"
  | "degraded"
  | "quiescing"
  | "stopped";

export interface WorkspaceSupervisorOptions {
  readonly workspaceIdentityDigest: string;
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
}

export interface WorkspaceSupervisorSnapshot {
  readonly workspaceIdentityDigest: string;
  readonly lifecycle: WorkspaceSupervisorLifecycle;
  readonly sessionIds: readonly string[];
  readonly lastActivityAt: number;
  readonly hasPendingApproval: boolean;
  readonly hasBackgroundWork: boolean;
}

export class WorkspaceSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceSupervisorError";
    this.code = code;
  }
}

export class WorkspaceSupervisor {
  readonly workspaceIdentityDigest: string;
  readonly #idleTimeoutMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionActor>();
  #lifecycle: WorkspaceSupervisorLifecycle = "created";
  #lastActivityAt: number;
  #pendingApprovals = 0;
  #backgroundWork = 0;

  constructor(options: WorkspaceSupervisorOptions) {
    this.workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.#now = options.now ?? (() => Date.now());
    this.#lastActivityAt = this.#now();
  }

  get lifecycle(): WorkspaceSupervisorLifecycle {
    return this.#lifecycle;
  }

  markReady(): void {
    this.#lifecycle = "ready";
    this.touch();
  }

  touch(): void {
    this.#lastActivityAt = this.#now();
  }

  getOrCreateSession(sessionId: string, ownerEpoch = 1): SessionActor {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      this.touch();
      return existing;
    }
    const actor = new SessionActor({
      sessionId,
      workspaceIdentityDigest: this.workspaceIdentityDigest,
      ownerEpoch,
    });
    this.#sessions.set(sessionId, actor);
    this.touch();
    if (this.#lifecycle === "created") this.#lifecycle = "ready";
    return actor;
  }

  getSession(sessionId: string): SessionActor | undefined {
    return this.#sessions.get(sessionId);
  }

  removeSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.touch();
  }

  setPendingApprovals(count: number): void {
    this.#pendingApprovals = Math.max(0, count);
    this.touch();
  }

  setBackgroundWork(count: number): void {
    this.#backgroundWork = Math.max(0, count);
    this.touch();
  }

  isIdle(now = this.#now()): boolean {
    if (this.#lifecycle === "stopped" || this.#lifecycle === "quiescing") return false;
    for (const session of this.#sessions.values()) {
      const state = session.state;
      if (state.attachedClients.length > 0) return false;
      if (state.lifecycle === "running" || state.lifecycle === "waiting_approval") return false;
      if (state.pendingApprovalIds.length > 0) return false;
    }
    if (this.#pendingApprovals > 0 || this.#backgroundWork > 0) return false;
    return now - this.#lastActivityAt >= this.#idleTimeoutMs;
  }

  beginEviction(): void {
    if (!this.isIdle()) {
      throw new WorkspaceSupervisorError(
        "WORKSPACE_NOT_IDLE",
        "workspace still has attached clients or work",
      );
    }
    this.#lifecycle = "quiescing";
  }

  finishEviction(): void {
    this.#lifecycle = "stopped";
    this.#sessions.clear();
  }

  snapshot(): WorkspaceSupervisorSnapshot {
    return {
      workspaceIdentityDigest: this.workspaceIdentityDigest,
      lifecycle: this.#lifecycle,
      sessionIds: [...this.#sessions.keys()],
      lastActivityAt: this.#lastActivityAt,
      hasPendingApproval: this.#pendingApprovals > 0,
      hasBackgroundWork: this.#backgroundWork > 0,
    };
  }
}

export interface WorkspaceSupervisorRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
}

export class WorkspaceSupervisorRegistry {
  readonly #idleTimeoutMs: number;
  readonly #now: () => number;
  readonly #supervisors = new Map<string, WorkspaceSupervisor>();

  constructor(options: WorkspaceSupervisorRegistryOptions = {}) {
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  getOrCreate(workspaceIdentityDigest: string): WorkspaceSupervisor {
    const existing = this.#supervisors.get(workspaceIdentityDigest);
    if (existing !== undefined) return existing;
    const supervisor = new WorkspaceSupervisor({
      workspaceIdentityDigest,
      idleTimeoutMs: this.#idleTimeoutMs,
      now: this.#now,
    });
    supervisor.markReady();
    this.#supervisors.set(workspaceIdentityDigest, supervisor);
    return supervisor;
  }

  get(workspaceIdentityDigest: string): WorkspaceSupervisor | undefined {
    return this.#supervisors.get(workspaceIdentityDigest);
  }

  evictIdle(): readonly string[] {
    const evicted: string[] = [];
    for (const [digest, supervisor] of this.#supervisors) {
      if (!supervisor.isIdle()) continue;
      supervisor.beginEviction();
      supervisor.finishEviction();
      this.#supervisors.delete(digest);
      evicted.push(digest);
    }
    return evicted;
  }

  list(): readonly WorkspaceSupervisorSnapshot[] {
    return [...this.#supervisors.values()].map((supervisor) => supervisor.snapshot());
  }

  clear(): void {
    for (const supervisor of this.#supervisors.values()) {
      supervisor.finishEviction();
    }
    this.#supervisors.clear();
  }
}
