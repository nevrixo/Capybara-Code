/**
 * Subagent scheduler — PRD §15.1, §15.7, §15.8, §15.12, Appendix B.5.
 *
 * Acceptance criteria this file is responsible for:
 *
 * - SUB-002: no goal/constraints/contract, no spawn.
 * - SUB-003: two writers can never hold overlapping paths.
 * - SUB-004: a child's raw transcript is never merged into the parent context.
 * - SUB-005: a root interrupt shows child cancellation within 250 ms.
 * - SUB-007: a nested spawn past depth 1 is refused.
 * - AC-21: `Esc` stops the *wait*; the child continues.
 * - AC-22: an explicit cancel tears down the model request, processes, and the
 *   transaction.
 *
 * §6.11 draws the line this module encodes: "stop waiting" and "cancel task" are
 * different operations, and conflating them is how work gets silently lost.
 */

import type { CbcEventKind } from "@cbc/protocol";
import {
  createLease,
  leaseExpired,
  overlappingGlobs,
  reconcileLease,
  type WriterLease,
} from "@cbc/tool-registry";

import {
  emptyChildResult,
  isTerminalAgentState,
  stateForResult,
  type AgentBudget,
  type AgentInstance,
  type AgentPermissionScope,
  type ChildAgentResult,
} from "./instance.ts";
import {
  SUBAGENT_HARD_LIMITS,
  contextReservationForRole,
  roleDefinition,
  type SubagentRole,
} from "./roles.ts";
import {
  renderTaskContract,
  validateTask,
  type AgentTask,
  type UpstreamResult,
} from "./task.ts";
import type { GraphSpawnRecord } from "./graph-authority.ts";

export interface SchedulerEmitter {
  emit<T>(kind: CbcEventKind, payload: T, options?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string }): void;
}

/** What the host must provide to actually run a child (§15.1: the same kernel). */
export interface ChildRunContext {
  readonly instance: AgentInstance;
  readonly task: AgentTask;
  /** Role prompt addendum plus the rendered contract (§15.9). */
  readonly roleInstructions: string;
  readonly taskDescription: string;
  /**
   * Structured results of the tasks this one depended on, already folded into
   * `taskDescription`. Passed separately as well so a host can feed them to the
   * context engine without re-parsing prose.
   */
  readonly upstream: readonly UpstreamResult[];
  /** Aborted by `cancel`, by the parent's own cancellation, or by the deadline. */
  readonly signal: AbortSignal;
}

export type ChildRunner = (context: ChildRunContext) => Promise<ChildAgentResult>;

/** Hash snapshot used to seed and reconcile a writer lease (§15.8). */
export interface PathBaseline {
  readonly path: string;
  readonly hash?: string;
}

export interface SpawnOptions {
  readonly role: SubagentRole;
  readonly task: AgentTask;
  /** Overrides the role's default profile, e.g. §15.2 "Sol/Terra based on task". */
  readonly modelProfile?: string;
  /** Display name shown on the §6.10 card. */
  readonly name?: string;
  /** Baseline hashes for the lease scope. Required for a writer. */
  readonly baseline?: readonly PathBaseline[];
  readonly turnId?: string;
}

export type SpawnRejectionCode =
  | "INVALID_TASK"
  | "DEPTH_EXCEEDED"
  | "WRITER_BUSY"
  | "LEASE_OVERLAP"
  | "UNKNOWN_DEPENDENCY";

export class SpawnRejected extends Error {
  readonly code: SpawnRejectionCode;
  readonly issues: string[];

  constructor(code: SpawnRejectionCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "SpawnRejected";
    this.code = code;
    this.issues = issues;
  }
}

export interface AgentHandle {
  readonly id: string;
  readonly instance: AgentInstance;
}

export interface SchedulerOptions {
  readonly emitter: SchedulerEmitter;
  readonly runner: ChildRunner;
  /** When set, spawn/start/complete go through the durable graph reducer. */
  readonly graph?: { recordSpawn(input: GraphSpawnRecord): void; recordStart(id: string): void; recordComplete(id: string, outcome: "completed" | "partial" | "failed" | "cancelled", summary?: string): void };
  /** Writer isolation key. Default `base` preserves one writer per scheduler. */
  readonly writerPartition?: (task: AgentTask) => string;
  /** Parent's soft context budget; children share `aggregateContextFraction` of it. */
  readonly parentContextTokens: number;
  /** Depth of the *parent*. A root is 0, so its children are depth 1. */
  readonly parentDepth?: number;
  readonly parentAgentId?: string;
  /** @deprecated Child registration is no longer capped per turn. */
  readonly maxChildrenPerTurn?: number;
  /** Maximum provider-running children. Overflow waits in a FIFO queue. */
  readonly maxConcurrent?: number;
  /** Disable predictive p75 estimates while retaining actual usage accounting. */
  readonly enableContextReservations?: boolean;
  readonly leaseTtlMs?: number;
  readonly now?: () => number;
}

interface RunSlotWaiter {
  readonly agentId: string;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (acquired: boolean) => void;
}

/**
 * Owns the child agent lifecycle for one parent.
 *
 * The scheduler never talks to a provider. It decides *whether* a child may run,
 * with what authority, and what happens when it ends — which is why every
 * acceptance criterion above can be tested without a network (AC-47).
 */
export class SubagentScheduler {
  readonly #options: SchedulerOptions;
  readonly #now: () => number;
  readonly #instances = new Map<string, AgentInstance>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #running = new Map<string, Promise<ChildAgentResult>>();
  readonly #slotWaiters: RunSlotWaiter[] = [];

  #activeRunners = 0;
  #counter = 0;
  #writerLease: WriterLease | undefined;
  readonly #writerLeases = new Map<string, WriterLease>();
  #consumedContextTokens = 0;
  #reservedContextTokens = 0;
  readonly #reservations = new Map<string, number>();

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Every instance this scheduler created, in creation order. */
  list(): AgentInstance[] {
    return [...this.#instances.values()];
  }

  get(agentId: string): AgentInstance | undefined {
    return this.#instances.get(agentId);
  }

  activeCount(): number {
    return this.list().filter((instance) => !isTerminalAgentState(instance.state)).length;
  }

  /** Children currently inside the provider runner; queued work is excluded. */
  runningCount(): number {
    return this.#activeRunners;
  }

  get writerLease(): WriterLease | undefined {
    return this.#writerLease;
  }

  /** @deprecated Child registration is no longer capped per turn. */
  beginTurn(): void {
    // Retained as a no-op so older embedders do not need a lockstep upgrade.
  }

  /** Historical aggregate context target retained for telemetry (§15.7). */
  aggregateContextBudget(): number {
    return Math.floor(
      Math.max(0, this.#options.parentContextTokens) *
        SUBAGENT_HARD_LIMITS.aggregateContextFraction,
    );
  }

  /** Context tokens children have actually consumed so far. */
  get consumedContextTokens(): number {
    return this.#consumedContextTokens;
  }

  /** Context tokens reserved by admitted children whose usage is not settled. */
  get reservedContextTokens(): number {
    return this.#reservedContextTokens;
  }

  /** Remaining historical aggregate target; this is telemetry, not admission. */
  get availableContextTokens(): number {
    return Math.max(
      0,
      this.aggregateContextBudget() -
        this.#consumedContextTokens -
        this.#reservedContextTokens,
    );
  }

  /**
   * Record a child's actual input-token usage for aggregate telemetry.
   *
   * Per-child context ceilings remain enforced by each child kernel. Aggregate
   * estimates are reconciled here so operators can observe delegation cost, but
   * they no longer reject otherwise valid child registrations.
   */
  recordChildUsage(agentId: string, inputTokens: number): void {
    const instance = this.#instances.get(agentId);
    if (instance === undefined) return;
    const actual = Math.max(0, Math.floor(inputTokens));
    const reserved = this.#reservations.get(agentId);
    if (reserved !== undefined) {
      this.#reservations.delete(agentId);
      this.#reservedContextTokens = Math.max(0, this.#reservedContextTokens - reserved);
      this.#consumedContextTokens += actual;
      if (instance.contextReservation !== undefined) {
        instance.contextReservation.actualTokens = actual;
        instance.contextReservation.state = "settled";
      }
      return;
    }
    if (instance.contextReservation?.actualTokens !== undefined) return;
    this.#consumedContextTokens += actual;
    if (instance.contextReservation !== undefined) {
      instance.contextReservation.actualTokens = actual;
      instance.contextReservation.state = "settled";
    }
  }

  /**
   * Register a child and start it when a provider slot is available.
   *
   * Registration itself is intentionally unbounded: excess work queues instead
   * of failing a tool call. Permission, delegation-depth, and writer-lease rules
   * remain hard admission boundaries.
   */
  spawn(options: SpawnOptions): AgentHandle {
    const definition = roleDefinition(options.role);
    const parentDepth = this.#options.parentDepth ?? 0;
    const depth = parentDepth + 1;

    // ---- SUB-007: depth 1 means a child may not spawn a child ----
    if (depth > SUBAGENT_HARD_LIMITS.maxDepth) {
      throw new SpawnRejected(
        "DEPTH_EXCEEDED",
        `delegation depth ${depth} exceeds the limit of ${SUBAGENT_HARD_LIMITS.maxDepth} (§15.7); a subagent may not spawn another subagent`,
      );
    }

    // ---- SUB-002: the contract is a precondition ----
    const validation = validateTask(options.task, options.role);
    if (!validation.ok) {
      const issues = validation.issues.map((issue) => `${String(issue.field)}: ${issue.message}`);
      throw new SpawnRejected(
        "INVALID_TASK",
        `the task does not satisfy the §15.4 contract for a ${options.role} child: ${issues[0]}`,
        issues,
      );
    }

    // ---- Plan-and-Execute: every dependency must already exist ----
    // Checked before anything is allocated. A task waiting on an id that was
    // never created would wait forever, which is the failure mode §15.12 exists
    // to prevent.
    for (const dependency of options.task.dependencies) {
      if (!this.#instances.has(dependency)) {
        throw new SpawnRejected(
          "UNKNOWN_DEPENDENCY",
          `task depends on '${dependency}', which this scheduler never created`,
          [`known agents: ${[...this.#instances.keys()].join(", ") || "(none)"}`],
        );
      }
    }

    // Predictive context estimates remain useful for telemetry, but they do not
    // reject additional children. Every child still has its own soft context
    // ceiling; an aggregate quota should not turn successful delegation into a
    // later, surprising spawn failure.
    const reservationTokens = this.#options.enableContextReservations === false
      ? 0
      : contextReservationForRole(
          options.role,
          this.#options.parentContextTokens,
        );

    // ---- §15.8 / SUB-003 / P6: one writer, non-overlapping scope ----
    // Checked before the id is allocated so a rejected spawn leaves no gap in the
      // agent numbering the user sees in the agents drawer.
    if (definition.canWrite) {
      this.#releaseExpiredLease();
      const partition = this.#writerPartition(options.task);
      const held = this.#writerLeases.get(partition) ?? (partition === "base" ? this.#writerLease : undefined);
      if (held !== undefined) {
        // Overlap is reported before the generic busy signal because the two call
        // for different responses: an overlapping scope must be narrowed, while a
        // merely-busy lease only has to be waited for.
        const overlapping = overlappingGlobs(held.pathGlobs, options.task.allowedPaths);
        if (overlapping.length > 0) {
          throw new SpawnRejected(
            "LEASE_OVERLAP",
            `the requested write scope overlaps the lease held by '${held.ownerAgentId}' (§15.8, SUB-003); wait for it or narrow the scope`,
            overlapping.map(
              ([mine, theirs]) => `'${mine}' overlaps the held glob '${theirs}'`,
            ),
          );
        }
        throw new SpawnRejected(
          "WRITER_BUSY",
          `the write lease is held by '${held.ownerAgentId}'; only one writer may be active (§15.8, P6)`,
        );
      }

      // A writer that is still waiting on a dependency holds no lease yet, so its
      // scope has to be checked against the pending writers too — otherwise two
      // queued executors could be admitted with the same paths and the conflict
      // would only surface once both were running.
      for (const pending of this.#instances.values()) {
        if (isTerminalAgentState(pending.state)) continue;
        if (pending.task.allowedPaths.length === 0) continue;
        if (this.#writerPartition(pending.task) !== partition) continue;
        const overlapping = overlappingGlobs(pending.task.allowedPaths, options.task.allowedPaths);
        if (overlapping.length > 0) {
          throw new SpawnRejected(
            "LEASE_OVERLAP",
            `the requested write scope overlaps the pending scope of '${pending.id}' (§15.8, SUB-003)`,
            overlapping.map(([mine, theirs]) => `'${mine}' overlaps '${theirs}'`),
          );
        }
      }
    }

    this.#counter += 1;
    const id = `agent_${this.#counter}`;

    const lease: WriterLease | undefined = definition.canWrite
      ? createLease({
          leaseId: `lease_${this.#counter}`,
          ownerAgentId: id,
          pathGlobs: options.task.allowedPaths,
          baseline: (options.baseline ?? []).map((entry) => ({
            path: entry.path,
            ...(entry.hash !== undefined ? { hash: entry.hash } : {}),
          })),
          ttlMs: this.#options.leaseTtlMs ?? options.task.deadlineMs,
          now: this.#now(),
        })
      : undefined;

    const permissions: AgentPermissionScope = {
      canWrite: definition.canWrite,
      canRunProcess: definition.canRunProcess,
      allowedPaths: [...options.task.allowedPaths],
      forbiddenPaths: [...options.task.forbiddenPaths],
      // §15.2 Explore: no approval requests except restricted reads.
      mayRequestApproval: definition.permissionClass !== "read",
    };

    const budget: AgentBudget = {
      maxToolCalls: definition.maxToolCalls,
      maxModelCalls: definition.maxModelCalls,
      maxDurationMs: Math.min(options.task.deadlineMs, definition.maxDurationMs),
      softContextTokens: definition.softContextTokens,
    };

    const instance: AgentInstance = {
      id,
      ...(this.#options.parentAgentId !== undefined
        ? { parentId: this.#options.parentAgentId }
        : {}),
      role: options.role,
      name: options.name ?? options.task.title,
      // A task with unmet dependencies is `waiting`, not `queued`: §15.10 keeps
      // the two apart so the card can say what it is waiting *on*.
      state: options.task.dependencies.length > 0 ? "waiting" : "queued",
      task: options.task,
      modelProfile: options.modelProfile ?? definition.modelProfile,
      permissions,
      budget,
      contextReservation: {
        agentId: id,
        estimatedTokens: reservationTokens,
        reservedAt: new Date(this.#now()).toISOString(),
        role: options.role,
        state: "reserved",
      },
      ...(lease !== undefined ? { writerLease: lease } : {}),
      createdAt: new Date(this.#now()).toISOString(),
      depth,
      awaitInterrupted: false,
    };

    this.#instances.set(id, instance);
    this.#reservations.set(id, reservationTokens);
    this.#reservedContextTokens += reservationTokens;
    if (lease !== undefined) {
      this.#writerLease = lease;
      this.#writerLeases.set(this.#writerPartition(options.task), lease);
    }
    this.#options.graph?.recordSpawn({
      id,
      ...(this.#options.parentAgentId !== undefined ? { parentId: this.#options.parentAgentId } : {}),
      title: instance.name,
      role: instance.role,
      dependencies: [...instance.task.dependencies],
      canWrite: definition.canWrite,
    });

    this.#emit("task.created", {
      taskId: id,
      role: instance.role,
      title: instance.task.title,
      goal: instance.task.goal,
      constraints: [...instance.task.constraints],
      contract: [...instance.task.expectedOutput],
      ...(lease !== undefined ? { writeLease: [...lease.pathGlobs] } : {}),
      dependencies: [...instance.task.dependencies],
      state: instance.state,
      // §6.10: the card names the model behind the child, because "the executor
      // did it" and "the executor on the fast profile did it" are different facts
      // when a delegated result looks wrong.
      modelProfile: instance.modelProfile,
      reservedContextTokens: reservationTokens,
      childCount: 0,
    }, id);

    // The controller is created here rather than inside `#run` so that a child
    // still waiting on a dependency is cancellable (AC-22). A child that cannot
    // be cancelled until it starts is a child that ignores `Esc` for as long as
    // its upstream takes.
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    this.#running.set(id, this.#runWhenReady(instance, controller));
    return { id, instance };
  }

  /**
   * Hold a child until its dependencies finish, then run it with their results.
   *
   * The promise stored in `#running` is this one, so `await`, `cancel` and
   * `settleAll` behave identically for a dependent child and an immediate one.
   */
  async #runWhenReady(
    instance: AgentInstance,
    controller: AbortController,
  ): Promise<ChildAgentResult> {
    const dependencies = instance.task.dependencies;
    let upstream: readonly UpstreamResult[] = [];
    if (dependencies.length > 0) {
      this.#emit(
        "task.progress",
        {
          taskId: instance.id,
          role: instance.role,
          state: "waiting",
          message: `waiting for ${dependencies.join(", ")} before starting`,
        },
        instance.id,
      );

      const gate = await this.#awaitDependencies(dependencies, controller.signal);

      if (gate.cancelled) {
        this.#controllers.delete(instance.id);
        return this.#settle(
          instance,
          emptyChildResult("cancelled", "the subagent was cancelled before it started"),
          this.#now(),
        );
      }

      if (gate.blockedBy.length > 0) {
        // §15.12: a dependency that did not complete produces a structured
        // `blocked` result. Running an executor whose input never arrived is worse
        // than not running it: it would invent the input.
        this.#controllers.delete(instance.id);
        return this.#settle(
          instance,
          emptyChildResult(
            "blocked",
            `did not start because ${gate.blockedBy.join(", ")} did not complete successfully`,
          ),
          this.#now(),
        );
      }
      upstream = gate.upstream;
    }

    const slot = this.#acquireRunSlot(instance, controller.signal);
    const acquired = typeof slot === "boolean" ? slot : await slot;
    if (!acquired) {
      this.#controllers.delete(instance.id);
      return this.#settle(
        instance,
        emptyChildResult("cancelled", "the subagent was cancelled before it started"),
        this.#now(),
      );
    }

    try {
      return await this.#run(instance, controller, upstream);
    } finally {
      this.#releaseRunSlot();
    }
  }

  /** Wait for provider capacity without rejecting the registered child. */
  #acquireRunSlot(instance: AgentInstance, signal: AbortSignal): boolean | Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#activeRunners < this.#maxConcurrent()) {
      this.#activeRunners += 1;
      return true;
    }

    instance.state = "queued";
    this.#emit(
      "task.progress",
      {
        taskId: instance.id,
        role: instance.role,
        state: "queued",
        message: `queued until one of ${this.#maxConcurrent()} provider slot(s) is available`,
      },
      instance.id,
    );

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        const index = this.#slotWaiters.findIndex((waiter) => waiter.agentId === instance.id);
        if (index >= 0) this.#slotWaiters.splice(index, 1);
        resolve(false);
      };
      this.#slotWaiters.push({ agentId: instance.id, signal, onAbort, resolve });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Hand the released provider slot to the oldest live waiter. */
  #releaseRunSlot(): void {
    this.#activeRunners = Math.max(0, this.#activeRunners - 1);
    while (this.#slotWaiters.length > 0) {
      const waiter = this.#slotWaiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.resolve(false);
        continue;
      }
      this.#activeRunners += 1;
      waiter.resolve(true);
      return;
    }
  }

  /** Clamp direct embedders to the same safe provider-parallelism ceiling as config. */
  #maxConcurrent(): number {
    const configured = this.#options.maxConcurrent ?? SUBAGENT_HARD_LIMITS.maxConcurrent;
    return Number.isFinite(configured) && configured >= 1
      ? Math.min(Math.floor(configured), SUBAGENT_HARD_LIMITS.maxConcurrent)
      : SUBAGENT_HARD_LIMITS.maxConcurrent;
  }

  /**
   * Wait for each dependency and collect its structured result.
   *
   * A dependency that ends in any state other than `completed` is reported rather
   * than silently treated as empty input.
   */
  async #awaitDependencies(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{
    cancelled: boolean;
    blockedBy: string[];
    upstream: UpstreamResult[];
  }> {
    const upstream: UpstreamResult[] = [];
    const blockedBy: string[] = [];

    for (const id of ids) {
      const dependency = this.#instances.get(id);
      if (dependency === undefined) {
        blockedBy.push(id);
        continue;
      }

      let result = dependency.result;
      if (result === undefined) {
        const pending = this.#running.get(id);
        if (pending === undefined) {
          blockedBy.push(id);
          continue;
        }
        const interrupted = Symbol("cancelled-while-waiting");
        const race = await Promise.race([
          pending,
          new Promise<typeof interrupted>((resolve) => {
            if (signal.aborted) {
              resolve(interrupted);
              return;
            }
            signal.addEventListener("abort", () => resolve(interrupted), { once: true });
          }),
        ]);
        if (race === interrupted) return { cancelled: true, blockedBy: [], upstream: [] };
        result = race;
      }

      if (result.status !== "completed") {
        blockedBy.push(`${id} (${result.status})`);
        continue;
      }
      upstream.push(toUpstreamResult(dependency, result));
    }

    return { cancelled: false, blockedBy, upstream };
  }

  async #run(
    instance: AgentInstance,
    controller: AbortController,
    upstream: readonly UpstreamResult[],
  ): Promise<ChildAgentResult> {
    this.#controllers.set(instance.id, controller);
    if (controller.signal.aborted) {
      this.#controllers.delete(instance.id);
      return this.#settle(
        instance,
        emptyChildResult("cancelled", "the subagent was cancelled before it started"),
        this.#now(),
      );
    }

    // A writer that waited on a dependency acquired its lease before the wait,
    // so the TTL is restarted here. Otherwise a long upstream task could leave
    // the lease expiring partway through the write it was granted for.
    this.#refreshLease(instance);

    // §15.12: a child timeout produces a structured `blocked` result, not a hang.
    // The timer is deliberately *not* unref'd. A pending promise does not hold the
    // event loop open, so an unref'd deadline would never fire when awaiting a
    // stuck child is the only outstanding work — turning the one mechanism that
    // guarantees termination into the cause of the hang. It is always cleared in
    // the `finally` below, so it cannot outlive the child.
    const timer = setTimeout(() => {
      controller.abort(new Error("deadline exceeded"));
    }, instance.budget.maxDurationMs);

    const startedMs = this.#now();
    instance.state = "running";
    instance.startedAt = new Date(startedMs).toISOString();
    this.#options.graph?.recordStart(instance.id);
    this.#emit(
      "task.started",
      { taskId: instance.id, role: instance.role, startTimeMs: startedMs },
      instance.id,
    );
    let result: ChildAgentResult;
    try {
      result = await this.#options.runner({
        instance,
        task: instance.task,
        // §15.9: the child gets its role brief and its contract — never the
        // parent's raw conversation (SUB-004).
        roleInstructions: roleDefinition(instance.role).instructions,
        // The dependency feedback loop: upstream *results* are folded into the
        // contract. Structured claims, not transcripts, so SUB-004 still holds.
        taskDescription: renderTaskContract(instance.task, { upstream }),
        upstream: [...upstream],
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      result = aborted
        ? emptyChildResult(
            message.includes("deadline")
              ? "blocked"
              : "cancelled",
            message.includes("deadline")
              ? `the subagent ran past its ${Math.round(instance.budget.maxDurationMs / 1000)}s deadline`
              : "the subagent was cancelled",
          )
        : emptyChildResult("failed", `the subagent failed: ${message}`);
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(instance.id);
    }

    return this.#settle(instance, result, startedMs);
  }

  /**
   * Record a child's terminal result and announce it.
   *
   * Shared by the normal run path and by the early exits in `#runWhenReady`, so a
   * child blocked by its dependency produces the same timeline shape as one that
   * ran and failed. An early exit that emitted nothing would leave a task card
   * spinning forever.
   */
  #settle(
    instance: AgentInstance,
    result: ChildAgentResult,
    startedMs: number,
  ): ChildAgentResult {
    this.#settleReservation(instance);
    instance.result = result;
    instance.state = stateForResult(result);
    instance.finishedAt = new Date(this.#now()).toISOString();
    const graphOutcome =
      result.status === "completed" || result.status === "failed" || result.status === "cancelled"
        ? result.status
        : "failed";
    this.#options.graph?.recordComplete(instance.id, graphOutcome, result.summary);

    const durationMs = this.#now() - startedMs;
    const kind: CbcEventKind =
      result.status === "completed"
        ? "task.completed"
        : result.status === "cancelled"
          ? "task.cancelled"
          : "task.failed";

    this.#emit(
      kind,
      {
        taskId: instance.id,
        role: instance.role,
        state: instance.state,
        status: result.status,
        summary: result.summary,
        durationMs,
        filesChanged: result.filesChanged.map((f) => f.path),
        openRisks: [...result.openRisks],
      },
      instance.id,
    );

    return result;
  }

  /** Release an unused reservation or reconcile usage that arrived at settle time. */
  #settleReservation(instance: AgentInstance): void {
    const reserved = this.#reservations.get(instance.id);
    if (reserved === undefined) return;
    this.#reservations.delete(instance.id);
    this.#reservedContextTokens = Math.max(0, this.#reservedContextTokens - reserved);
    if (instance.contextReservation === undefined) return;
    if (instance.contextReservation.actualTokens === undefined) {
      instance.contextReservation.state = "released";
    } else {
      instance.contextReservation.state = "settled";
      this.#consumedContextTokens += instance.contextReservation.actualTokens;
    }
  }

  /** Restart a writer lease's TTL at the moment the child actually begins. */
  #refreshLease(instance: AgentInstance): void {
    const lease = instance.writerLease;
    if (lease === undefined) return;
    const refreshed = createLease({
      leaseId: lease.leaseId,
      ownerAgentId: lease.ownerAgentId,
      pathGlobs: lease.pathGlobs,
      baseline: lease.baseline,
      ttlMs: this.#options.leaseTtlMs ?? instance.task.deadlineMs,
      now: this.#now(),
    });
    instance.writerLease = refreshed;
    if (this.#writerLease?.leaseId === lease.leaseId) this.#writerLease = refreshed;
  }

  /**
   * Await a child's result.
   *
   * When `signal` aborts, the await returns `undefined` and the child keeps
   * running — AC-21 and §6.11's "stop waiting". Cancelling the child is a separate
   * call, because a user pressing `Esc` to get their prompt back has not asked to
   * throw away 20 seconds of work.
   */
  async await(agentId: string, signal?: AbortSignal): Promise<ChildAgentResult | undefined> {
    const pending = this.#running.get(agentId);
    const instance = this.#instances.get(agentId);
    if (!pending || !instance) return undefined;

    if (signal === undefined) return await pending;

    const interrupted = Symbol("await-interrupted");
    const race = await Promise.race([
      pending,
      new Promise<typeof interrupted>((resolve) => {
        if (signal.aborted) {
          resolve(interrupted);
          return;
        }
        signal.addEventListener("abort", () => resolve(interrupted), { once: true });
      }),
    ]);

    if (race === interrupted) {
      instance.awaitInterrupted = true;
      // §6.11's exact wording, so the timeline says what actually happened.
      this.#emit(
        "task.await_interrupted",
        {
          taskId: agentId,
          role: instance.role,
          message:
            "Await interrupted; this subagent continues. Inspect its current state in the context sidebar.",
        },
        agentId,
      );
      return undefined;
    }
    return race;
  }

  /**
   * Cancel a child: abort its model request and tool calls, and release its
   * lease so a replacement writer can start (AC-22, §15.12).
   *
   * The state flips before the runner's promise settles so the UI can show
   * cancellation inside SUB-005's 250 ms window rather than waiting on teardown.
   */
  async cancel(agentId: string, reason: string): Promise<ChildAgentResult | undefined> {
    const instance = this.#instances.get(agentId);
    if (!instance) return undefined;

    const controller = this.#controllers.get(agentId);
    if (controller !== undefined && !isTerminalAgentState(instance.state)) {
      instance.state = "cancelled";
      this.#emit("task.cancelled", { taskId: agentId, role: instance.role, reason }, agentId);
      controller.abort(new Error(reason));
    }

    const pending = this.#running.get(agentId);
    const result = pending === undefined ? undefined : await pending;
    this.releaseLease(agentId);
    return result;
  }

  /** §15.12: a root cancellation propagates to every live child. */
  async cancelAll(reason: string): Promise<void> {
    await Promise.all(
      this.list()
        .filter((instance) => !isTerminalAgentState(instance.state))
        .map((instance) => this.cancel(instance.id, reason)),
    );
  }

  /** Wait for every child, ignoring interruption. Used at turn end. */
  async settleAll(): Promise<Map<string, ChildAgentResult>> {
    const out = new Map<string, ChildAgentResult>();
    for (const [id, pending] of this.#running) {
      out.set(id, await pending);
    }
    return out;
  }

  /**
   * Release the writer lease held by `agentId` and reconcile it (§15.8).
   *
   * `conflicted` paths are the ones that changed without the child writing them —
   * an external edit during the lease, which §15.8 says must end the child as
   * blocked rather than being papered over.
   */
  releaseLease(
    agentId: string,
    current: readonly PathBaseline[] = [],
  ): { released: boolean; conflicted: string[]; changed: string[] } {
    const instance = this.#instances.get(agentId);
    const lease = instance?.writerLease;
    if (!instance || lease === undefined) {
      return { released: false, conflicted: [], changed: [] };
    }

    const wrote = instance.result?.filesChanged.map((file) => file.path) ?? [];
    const reconciliation = reconcileLease(lease, current, wrote);

    delete instance.writerLease;
    if (this.#writerLease?.leaseId === lease.leaseId) this.#writerLease = undefined;
    for (const [key, held] of this.#writerLeases) {
      if (held.leaseId === lease.leaseId) this.#writerLeases.delete(key);
    }

    if (reconciliation.conflicted.length > 0) {
      this.#emit(
        "transaction.conflicted",
        {
          taskId: agentId,
          paths: reconciliation.conflicted,
          message: "these paths changed outside the write lease during the subagent's run",
        },
        agentId,
      );
      // §15.8: an external edit during the lease ends the child as blocked.
      // Reconciliation runs *after* the child finishes, so a claimed success is
      // exactly the case that must be downgraded — leaving it `completed` would
      // report work as sound when its baseline moved underneath it. A child that
      // already failed or was cancelled keeps its own, more specific outcome.
      if (instance.state === "completed" || !isTerminalAgentState(instance.state)) {
        instance.state = "blocked";
      }
    }

    return {
      released: true,
      conflicted: reconciliation.conflicted,
      changed: reconciliation.changed,
    };
  }

  #releaseExpiredLease(): void {
    const lease = this.#writerLease;
    if (lease !== undefined && leaseExpired(lease, this.#now())) {
      this.#writerLease = undefined;
      const owner = this.#instances.get(lease.ownerAgentId);
      if (owner !== undefined) delete owner.writerLease;
    }
    for (const [key, held] of this.#writerLeases) {
      if (leaseExpired(held, this.#now())) {
        this.#writerLeases.delete(key);
        const owner = this.#instances.get(held.ownerAgentId);
        if (owner !== undefined) delete owner.writerLease;
      }
    }
  }

  #writerPartition(task: AgentTask): string {
    return this.#options.writerPartition?.(task) ?? "base";
  }

  #emit<T>(kind: CbcEventKind, payload: T, agentId: string): void {
    this.#options.emitter.emit(kind, payload, { agentId });
  }
}

/** Project a finished child's result into the shape the next child receives. */
function toUpstreamResult(instance: AgentInstance, result: ChildAgentResult): UpstreamResult {
  return {
    agentId: instance.id,
    role: instance.role,
    title: instance.task.title,
    status: result.status,
    summary: result.summary,
    filesChanged: result.filesChanged.map((file) => file.path),
    openRisks: [...result.openRisks],
    evidence: result.evidence.map(
      (ref) => `${ref.kind}:${ref.locator}${ref.detail !== undefined ? ` (${ref.detail})` : ""}`,
    ),
    ...(result.recommendedNextStep !== undefined
      ? { recommendedNextStep: result.recommendedNextStep }
      : {}),
  };
}

// Preserve the package's historical public export while the shared path-scope
// implementation now lives with the writer-lease glob matcher.
export { overlappingGlobs };
