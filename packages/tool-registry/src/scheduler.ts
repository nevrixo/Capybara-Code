/**
 * Tool scheduler — PRD §12.9, §15.8, AC-23, SUB-003.
 *
 * §12.9 batches parallel reads, inserts a barrier, allows exactly one writer,
 * then batches verification. The scheduler enforces: one writer lease, path
 * overlap detection, per-tool concurrency, MCP server concurrency, a global
 * process count, and the turn budget.
 */

import type { ToolDefinition } from "./catalog.ts";

export interface ProposedCall {
  readonly callId: string;
  readonly toolId: string;
  readonly arguments: Record<string, unknown>;
  /** Workspace-relative paths this call reads. */
  readonly reads?: readonly string[];
  /** Workspace-relative paths this call writes. */
  readonly writes?: readonly string[];
  /** MCP server name, when the call is `mcp.call`. */
  readonly mcpServer?: string;
}

export type BatchKind = "read" | "write" | "process" | "interactive" | "external";

export interface ScheduledBatch {
  readonly kind: BatchKind;
  readonly calls: ProposedCall[];
  /** Reason this batch is separated from the previous one. */
  readonly barrier: string;
}

export interface SchedulerLimits {
  /** §14.7: four concurrent processes by default. */
  readonly maxConcurrentProcesses: number;
  /** Reads may fan out further than processes. */
  readonly maxConcurrentReads: number;
  /** §17.3: bounded per-server concurrency. */
  readonly maxConcurrentPerMcpServer: number;
  /** §11.3: 64 tool calls per root turn. */
  readonly maxToolCallsPerTurn: number;
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  maxConcurrentProcesses: 4,
  maxConcurrentReads: 8,
  maxConcurrentPerMcpServer: 2,
  maxToolCallsPerTurn: 64,
};

export interface WriterLease {
  readonly leaseId: string;
  readonly ownerAgentId: string;
  readonly pathGlobs: readonly string[];
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly baseline: ReadonlyArray<{ path: string; hash?: string }>;
}

export interface SchedulerRejection {
  readonly callId: string;
  readonly code: "LEASE_VIOLATION" | "PATH_OVERLAP" | "BUDGET_EXHAUSTED" | "UNKNOWN_TOOL";
  readonly message: string;
}

export interface SchedulePlan {
  readonly batches: ScheduledBatch[];
  readonly rejected: SchedulerRejection[];
}

export interface ScheduleContext {
  readonly catalog: readonly ToolDefinition[];
  readonly limits?: SchedulerLimits;
  /** The active writer lease, when one is held (§15.8). */
  readonly writerLease?: WriterLease;
  /** Agent requesting the calls, checked against the lease owner. */
  readonly agentId: string;
  /** Tool calls already spent this turn. */
  readonly callsUsed: number;
}

/**
 * Plan a set of proposed calls into ordered batches.
 *
 * Ordering is `read → barrier → write → barrier → process/external`, matching
 * §12.9. Two writes to overlapping paths in one turn are rejected rather than
 * serialized, because the model should re-read between them (§T2).
 */
export function schedule(calls: readonly ProposedCall[], context: ScheduleContext): SchedulePlan {
  const limits = context.limits ?? DEFAULT_SCHEDULER_LIMITS;
  const rejected: SchedulerRejection[] = [];
  const accepted: ProposedCall[] = [];

  let budget = limits.maxToolCallsPerTurn - context.callsUsed;

  const writtenPaths = new Set<string>();
  for (const call of calls) {
    const tool = context.catalog.find((t) => t.id === call.toolId);
    if (!tool) {
      rejected.push({
        callId: call.callId,
        code: "UNKNOWN_TOOL",
        message: `'${call.toolId}' is not in the tool catalog`,
      });
      continue;
    }

    if (budget <= 0) {
      rejected.push({
        callId: call.callId,
        code: "BUDGET_EXHAUSTED",
        message: `the turn's ${limits.maxToolCallsPerTurn} tool-call budget is exhausted`,
      });
      continue;
    }

    if (tool.mutates) {
      const lease = context.writerLease;
      // AC-23 / SUB-003: at most one writer, and only the lease owner may write.
      if (lease && lease.ownerAgentId !== context.agentId) {
        rejected.push({
          callId: call.callId,
          code: "LEASE_VIOLATION",
          message: `the write lease is held by '${lease.ownerAgentId}', not '${context.agentId}'`,
        });
        continue;
      }
      if (lease) {
        const outside = (call.writes ?? []).filter(
          (path) => !lease.pathGlobs.some((glob) => globMatch(glob, path)),
        );
        if (outside.length > 0) {
          rejected.push({
            callId: call.callId,
            code: "LEASE_VIOLATION",
            message: `path(s) ${outside.join(", ")} are outside the lease scope ${lease.pathGlobs.join(", ")}`,
          });
          continue;
        }
      }
      const overlap = (call.writes ?? []).filter((path) => writtenPaths.has(path));
      if (overlap.length > 0) {
        rejected.push({
          callId: call.callId,
          code: "PATH_OVERLAP",
          message: `path(s) ${overlap.join(", ")} are already written by an earlier call in this batch; re-read before writing again`,
        });
        continue;
      }
      for (const path of call.writes ?? []) writtenPaths.add(path);
    }

    accepted.push(call);
    budget -= 1;
  }

  const batches: ScheduledBatch[] = [];
  const push = (kind: BatchKind, calls: ProposedCall[], barrier: string, chunk: number) => {
    for (let i = 0; i < calls.length; i += chunk) {
      batches.push({ kind, calls: calls.slice(i, i + chunk), barrier });
    }
  };

  const reads = accepted.filter((c) => classify(c, context.catalog) === "read");
  const writes = accepted.filter((c) => classify(c, context.catalog) === "write");
  const processes = accepted.filter((c) => classify(c, context.catalog) === "process");
  const externals = accepted.filter((c) => classify(c, context.catalog) === "external");
  const interactive = accepted.filter((c) => classify(c, context.catalog) === "interactive");

  if (reads.length > 0) push("read", reads, "parallel reads", limits.maxConcurrentReads);
  // §12.9: one writer, so writes are serialized one per batch.
  if (writes.length > 0) push("write", writes, "single writer", 1);
  if (processes.length > 0) {
    push("process", processes, "verification", limits.maxConcurrentProcesses);
  }
  if (externals.length > 0) {
    // §17.3: bounded per-server concurrency.
    const byServer = new Map<string, ProposedCall[]>();
    for (const call of externals) {
      const key = call.mcpServer ?? "unknown";
      byServer.set(key, [...(byServer.get(key) ?? []), call]);
    }
    for (const [server, serverCalls] of byServer) {
      push(
        "external",
        serverCalls,
        `mcp server ${server}`,
        limits.maxConcurrentPerMcpServer,
      );
    }
  }
  if (interactive.length > 0) push("interactive", interactive, "user input", 1);

  return { batches, rejected };
}

function classify(call: ProposedCall, catalog: readonly ToolDefinition[]): BatchKind {
  const tool = catalog.find((t) => t.id === call.toolId);
  if (!tool) return "read";
  if (tool.id === "user.ask") return "interactive";
  if (tool.mutates) return "write";
  if (tool.id.startsWith("process.") || tool.id === "shell.run") return "process";
  if (tool.id.startsWith("mcp.")) return "external";
  return "read";
}

/**
 * Glob matcher shared with the Rust path guard's semantics: `*` does not cross
 * `/`, `**` does.
 */
export function globMatch(pattern: string, text: string): boolean {
  return matchFrom(pattern, 0, text, 0);
}

function matchFrom(pattern: string, pi: number, text: string, ti: number): boolean {
  if (pi >= pattern.length) return ti >= text.length;

  if (pattern.startsWith("**", pi)) {
    let rest = pi + 2;
    if (pattern[rest] === "/") rest += 1;
    if (rest >= pattern.length) return true;
    for (let i = ti; i <= text.length; i += 1) {
      if (matchFrom(pattern, rest, text, i)) return true;
    }
    return false;
  }

  const ch = pattern[pi];
  if (ch === "*") {
    for (let i = ti; i <= text.length; i += 1) {
      if (matchFrom(pattern, pi + 1, text, i)) return true;
      if (text[i] === "/") return false;
    }
    return false;
  }
  if (ch === "?") {
    if (ti >= text.length || text[ti] === "/") return false;
    return matchFrom(pattern, pi + 1, text, ti + 1);
  }
  if (ti >= text.length || text[ti] !== ch) return false;
  return matchFrom(pattern, pi + 1, text, ti + 1);
}

/** §15.8 lease creation with an expiry. */
export function createLease(options: {
  leaseId: string;
  ownerAgentId: string;
  pathGlobs: readonly string[];
  baseline: ReadonlyArray<{ path: string; hash?: string }>;
  ttlMs: number;
  now?: number;
}): WriterLease {
  const now = options.now ?? Date.now();
  return {
    leaseId: options.leaseId,
    ownerAgentId: options.ownerAgentId,
    pathGlobs: [...options.pathGlobs],
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + options.ttlMs).toISOString(),
    baseline: [...options.baseline],
  };
}

export function leaseExpired(lease: WriterLease, now = Date.now()): boolean {
  return Date.parse(lease.expiresAt) <= now;
}

/** §15.8 reconciliation: which lease paths changed, and did anything drift? */
export interface LeaseReconciliation {
  readonly changed: string[];
  readonly unchanged: string[];
  /** Paths modified outside the lease baseline, i.e. an external edit. */
  readonly conflicted: string[];
}

export function reconcileLease(
  lease: WriterLease,
  current: ReadonlyArray<{ path: string; hash?: string }>,
  agentWrote: readonly string[],
): LeaseReconciliation {
  const baseline = new Map(lease.baseline.map((entry) => [entry.path, entry.hash]));
  const wrote = new Set(agentWrote);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const conflicted: string[] = [];

  for (const entry of current) {
    const before = baseline.get(entry.path);
    if (before === entry.hash) {
      unchanged.push(entry.path);
      continue;
    }
    if (wrote.has(entry.path)) {
      changed.push(entry.path);
    } else {
      // Changed but not by this agent: an external edit during the lease.
      conflicted.push(entry.path);
    }
  }
  return { changed, unchanged, conflicted };
}
