/**
 * Worktree records with a single writer lease per worktree.
 */

export type WorktreeState =
  | "creating"
  | "ready"
  | "leased"
  | "dirty"
  | "proposed"
  | "merged"
  | "abandoned"
  | "recovery_required"
  | "deleted";

export interface WorktreeRecord {
  readonly id: string;
  readonly workspaceIdentityDigest: string;
  readonly path: string;
  readonly state: WorktreeState;
  readonly baseCommit: string;
  readonly baseWorkspaceRevision: string;
  readonly headCommit?: string;
  readonly writerLeaseId?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorktreeLease {
  readonly id: string;
  readonly worktreeId: string;
  readonly nodeId: string;
  readonly ownerEpoch: number;
  readonly allowedPaths: readonly string[];
  readonly state: "active" | "expired" | "revoked";
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface WorktreeManagerOptions {
  readonly now?: () => string;
}

export class WorktreeManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorktreeManagerError";
    this.code = code;
  }
}

export class WorktreeManager {
  readonly #now: () => string;
  readonly #worktrees = new Map<string, WorktreeRecord>();
  readonly #leases = new Map<string, WorktreeLease>();

  constructor(options: WorktreeManagerOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  create(input: {
    readonly id: string;
    readonly workspaceIdentityDigest: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly baseWorkspaceRevision: string;
  }): WorktreeRecord {
    if (this.#worktrees.has(input.id)) {
      throw new WorktreeManagerError("WORKTREE_EXISTS", "worktree id already exists");
    }
    for (const existing of this.#worktrees.values()) {
      if (existing.path === input.path && existing.state !== "deleted") {
        throw new WorktreeManagerError("WORKTREE_PATH_IN_USE", "worktree path already registered");
      }
    }
    const now = this.#now();
    const record: WorktreeRecord = {
      id: input.id,
      workspaceIdentityDigest: input.workspaceIdentityDigest,
      path: input.path,
      state: "ready",
      baseCommit: input.baseCommit,
      baseWorkspaceRevision: input.baseWorkspaceRevision,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#worktrees.set(record.id, record);
    return record;
  }

  get(worktreeId: string): WorktreeRecord | undefined {
    return this.#worktrees.get(worktreeId);
  }

  list(workspaceIdentityDigest?: string): readonly WorktreeRecord[] {
    const values = [...this.#worktrees.values()].filter((item) => item.state !== "deleted");
    return workspaceIdentityDigest === undefined
      ? values
      : values.filter((item) => item.workspaceIdentityDigest === workspaceIdentityDigest);
  }

  acquireWriterLease(input: {
    readonly leaseId: string;
    readonly worktreeId: string;
    readonly nodeId: string;
    readonly ownerEpoch: number;
    readonly allowedPaths: readonly string[];
    readonly ttlSeconds?: number;
  }): WorktreeLease {
    const worktree = this.#require(input.worktreeId);
    if (worktree.writerLeaseId !== undefined) {
      const current = this.#leases.get(worktree.writerLeaseId);
      if (current !== undefined && current.state === "active" && !isExpired(current, this.#now())) {
        throw new WorktreeManagerError(
          "WORKTREE_ALREADY_LEASED",
          "worktree already has an active writer lease",
        );
      }
    }
    const now = this.#now();
    const ttlSeconds = input.ttlSeconds ?? 300;
    const lease: WorktreeLease = {
      id: input.leaseId,
      worktreeId: input.worktreeId,
      nodeId: input.nodeId,
      ownerEpoch: input.ownerEpoch,
      allowedPaths: input.allowedPaths,
      state: "active",
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + ttlSeconds * 1_000).toISOString(),
    };
    this.#leases.set(lease.id, lease);
    this.#worktrees.set(worktree.id, {
      ...worktree,
      state: "leased",
      writerLeaseId: lease.id,
      revision: worktree.revision + 1,
      updatedAt: now,
    });
    return lease;
  }

  releaseWriterLease(leaseId: string): WorktreeRecord {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined) {
      throw new WorktreeManagerError("WORKTREE_LEASE_NOT_FOUND", "unknown writer lease");
    }
    const worktree = this.#require(lease.worktreeId);
    const now = this.#now();
    this.#leases.set(leaseId, { ...lease, state: "revoked" });
    // exactOptionalPropertyTypes: omit writerLeaseId rather than assign undefined.
    const cleaned: WorktreeRecord = {
      id: worktree.id,
      workspaceIdentityDigest: worktree.workspaceIdentityDigest,
      path: worktree.path,
      state: worktree.state === "leased" ? "ready" : worktree.state,
      baseCommit: worktree.baseCommit,
      baseWorkspaceRevision: worktree.baseWorkspaceRevision,
      revision: worktree.revision + 1,
      createdAt: worktree.createdAt,
      updatedAt: now,
      ...(worktree.headCommit !== undefined ? { headCommit: worktree.headCommit } : {}),
    };
    this.#worktrees.set(cleaned.id, cleaned);
    return cleaned;
  }

  markDirty(worktreeId: string, headCommit?: string): WorktreeRecord {
    const worktree = this.#require(worktreeId);
    const now = this.#now();
    const next: WorktreeRecord = {
      ...worktree,
      state: "dirty",
      revision: worktree.revision + 1,
      updatedAt: now,
      ...(headCommit !== undefined ? { headCommit } : {}),
    };
    this.#worktrees.set(worktreeId, next);
    return next;
  }

  #require(worktreeId: string): WorktreeRecord {
    const worktree = this.#worktrees.get(worktreeId);
    if (worktree === undefined || worktree.state === "deleted") {
      throw new WorktreeManagerError("WORKTREE_NOT_FOUND", "unknown worktree");
    }
    return worktree;
  }
}

function isExpired(lease: WorktreeLease, now: string): boolean {
  return Date.parse(lease.expiresAt) <= Date.parse(now);
}
