import {
  isTerminalAgentState,
  type AgentBudget,
  type AgentInstance,
  type AgentPermissionScope,
  type ChildAgentResult,
} from "./instance.ts";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  SUBAGENT_HARD_LIMITS,
  roleDefinition,
} from "./roles.ts";
import {
  GraphBudgetExceeded,
  GraphBudgetLedger,
  type GraphBudgetAmount,
  type GraphBudgetLimits,
  type GraphBudgetSnapshot,
} from "./budget-ledger.ts";
import { GraphAuthority } from "./graph-authority.ts";
import {
  SpawnRejected,
  SubagentScheduler,
  type AgentHandle,
  type SchedulerOptions,
  type SpawnOptions,
} from "./scheduler.ts";
import type { AgentTask } from "./task.ts";

export interface DelegationCoordinatorLimits {
  readonly maxDepth: number;
  readonly maxChildrenPerNode: number;
  readonly maxNodesPerTurn: number;
  readonly maxWriterNodes: number;
  readonly messageBytes: number;
}

type SchedulerBaseOptions = Omit<
  SchedulerOptions,
  "graph" | "parentDepth" | "parentAgentId" | "maxDepth" | "newAgentId" | "permissionCeiling"
>;

export interface DelegationCoordinatorOptions {
  readonly scheduler: SchedulerBaseOptions;
  readonly graph?: GraphAuthority;
  readonly limits?: Partial<DelegationCoordinatorLimits>;
  readonly budget?: Partial<GraphBudgetLimits>;
  readonly now?: () => number;
}

export interface DelegationFacade {
  spawn(options: SpawnOptions): AgentHandle;
  wait(taskId: string, signal?: AbortSignal): Promise<ChildAgentResult | undefined>;
  send(taskId: string, message: { readonly kind: string; readonly body?: unknown }): void;
  collect(taskId: string): ChildAgentResult | undefined;
  cancel(taskId: string, options?: { readonly recursive?: boolean; readonly reason?: string }): Promise<ChildAgentResult | undefined>;
}

export interface DelegationRecoveryItem {
  readonly nodeId: string;
  readonly state: string;
  readonly disposition: "safe-retry" | "manual-review" | "orphan-paused";
}

/**
 * Session-scoped source of truth for nested schedulers. Each model receives a
 * facade rooted at its own node and cannot address sibling subtrees.
 */
export class DelegationCoordinator {
  readonly graph: GraphAuthority | undefined;
  readonly rootScheduler: SubagentScheduler;
  readonly #base: SchedulerBaseOptions;
  readonly #limits: DelegationCoordinatorLimits;
  readonly #ledger: GraphBudgetLedger;
  readonly #now: () => number;
  readonly #schedulers = new Map<string, SubagentScheduler>();
  readonly #instances = new Map<string, AgentInstance>();
  readonly #owners = new Map<string, string>();
  readonly #children = new Map<string, string[]>();
  #counter = 0;

  constructor(options: DelegationCoordinatorOptions) {
    this.graph = options.graph;
    this.#base = options.scheduler;
    this.#now = options.now ?? (() => Date.now());
    this.#limits = Object.freeze({
      maxDepth: clamp(options.limits?.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH, 0, SUBAGENT_HARD_LIMITS.maxDepth),
      maxChildrenPerNode: clamp(options.limits?.maxChildrenPerNode ?? 4, 1, 64),
      maxNodesPerTurn: clamp(options.limits?.maxNodesPerTurn ?? 16, 1, 10_000),
      maxWriterNodes: clamp(options.limits?.maxWriterNodes ?? 1, 1, 64),
      messageBytes: clamp(options.limits?.messageBytes ?? 65_536, 1_024, 1024 * 1024),
    });
    const budgetLimits: GraphBudgetLimits = {
      maxToolCalls: positive(options.budget?.maxToolCalls ?? 240),
      maxModelCalls: positive(options.budget?.maxModelCalls ?? 128),
      maxWallClockMs: positive(options.budget?.maxWallClockMs ?? 30 * 60_000),
      maxContextTokens: positive(options.budget?.maxContextTokens ?? 1_000_000),
      maxCostUsd: positive(options.budget?.maxCostUsd ?? 4),
    };
    this.#ledger = new GraphBudgetLedger(budgetLimits, this.graph?.budgetSnapshot());
    this.rootScheduler = this.#createScheduler("root", 0, undefined);
  }

  get budgetSnapshot(): GraphBudgetSnapshot {
    return this.#ledger.snapshot;
  }

  get(taskId: string): AgentInstance | undefined {
    return this.#instances.get(taskId);
  }

  list(parentId = "root"): readonly AgentInstance[] {
    if (parentId === "root") return Object.freeze([...this.#instances.values()]);
    return Object.freeze(
      [...this.#instances.values()].filter((instance) => this.#isDescendant(instance.id, parentId)),
    );
  }

  activeCount(): number {
    return [...this.#instances.values()].filter((instance) => !isTerminalAgentState(instance.state)).length;
  }

  recordUsage(taskId: string, inputTokens: number): void {
    const instance = this.#instances.get(taskId);
    if (instance === undefined) return;
    this.#ownerScheduler(taskId).recordChildUsage(taskId, inputTokens);
    this.#ledger.settle(taskId, {
      contextTokens: Math.max(0, Math.floor(inputTokens)),
    });
    this.#persistBudget();
  }

  facade(parentId: string): DelegationFacade {
    this.#requireParent(parentId);
    const facade: DelegationFacade = {
      spawn: (options) => this.spawn(parentId, options),
      wait: (taskId, signal) => this.wait(parentId, taskId, signal),
      send: (taskId, message) => this.send(parentId, taskId, message),
      collect: (taskId) => this.collect(parentId, taskId),
      cancel: (taskId, options) => this.cancel(
        parentId,
        taskId,
        options?.reason ?? "cancelled by parent",
        options?.recursive !== false,
      ),
    };
    return Object.freeze(facade);
  }

  spawn(parentId: string, options: SpawnOptions): AgentHandle {
    const parent = this.#requireParent(parentId);
    if (parent !== undefined && isTerminalAgentState(parent.state)) {
      throw new SpawnRejected(
        "AUTHORITY_WIDENING",
        "a terminal parent cannot create new descendants",
      );
    }
    const parentChildren = this.#children.get(parentId) ?? [];
    if (parentChildren.length >= this.#limits.maxChildrenPerNode) {
      throw new SpawnRejected(
        "FANOUT_LIMIT",
        "node " + parentId + " reached its child fan-out limit of " + this.#limits.maxChildrenPerNode,
      );
    }
    if (this.#instances.size >= this.#limits.maxNodesPerTurn) {
      throw new SpawnRejected(
        "NODE_LIMIT",
        "agent graph reached its per-turn node limit of " + this.#limits.maxNodesPerTurn,
      );
    }
    const definition = roleDefinition(options.role);
    if (
      definition.canWrite
      && [...this.#instances.values()].filter((instance) =>
        roleDefinition(instance.role).canWrite && !isTerminalAgentState(instance.state)
      ).length >= this.#limits.maxWriterNodes
    ) {
      throw new SpawnRejected(
        "WRITER_BUSY",
        "agent graph writer limit is already in use",
      );
    }
    if (parent !== undefined) {
      if (definition.canWrite && !parent.permissions.canWrite) {
        throw new SpawnRejected(
          "AUTHORITY_WIDENING",
          "a read-only parent cannot delegate writer authority",
        );
      }
      if (definition.canRunProcess && !parent.permissions.canRunProcess) {
        throw new SpawnRejected(
          "AUTHORITY_WIDENING",
          "the child process authority would exceed its parent",
        );
      }
    }
    const task = narrowTask(options.task, parent?.permissions);
    const budget = childBudget(options.role, parent?.budget, options.budget);
    const nodeId = "agent_" + String(++this.#counter);
    const amount = budgetAmount(budget);
    try {
      this.#ledger.reserve({
        nodeId,
        parentId,
        amount,
        ...(parent === undefined ? {} : { parentCeiling: budgetAmount(parent.budget) }),
        reservedAt: new Date(this.#now()).toISOString(),
      });
    } catch (error) {
      if (error instanceof GraphBudgetExceeded) {
        throw new SpawnRejected("BUDGET_EXCEEDED", error.message, [error.resource]);
      }
      throw error;
    }
    this.#persistBudget();
    const scheduler = this.#schedulerFor(parentId, parent);
    try {
      const handle = scheduler.spawn({
        ...options,
        agentId: nodeId,
        task,
        budget,
      });
      this.#instances.set(handle.id, handle.instance);
      this.#owners.set(handle.id, parentId);
      this.#children.set(parentId, [...parentChildren, handle.id]);
      this.#children.set(handle.id, []);
      void scheduler.await(handle.id).then((result) => {
        if (result?.status === "cancelled") this.#ledger.release(handle.id);
        else this.#ledger.settle(handle.id);
        this.#persistBudget();
      });
      return handle;
    } catch (error) {
      this.#ledger.release(nodeId);
      this.#persistBudget();
      throw error;
    }
  }

  async wait(
    callerId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<ChildAgentResult | undefined> {
    this.#assertAddressable(callerId, taskId);
    return this.#ownerScheduler(taskId).await(taskId, signal);
  }

  collect(callerId: string, taskId: string): ChildAgentResult | undefined {
    this.#assertAddressable(callerId, taskId);
    return this.#instances.get(taskId)?.result;
  }

  send(
    callerId: string,
    taskId: string,
    message: { readonly kind: string; readonly body?: unknown },
  ): void {
    this.#assertRelated(callerId, taskId);
    if (this.graph === undefined) throw new Error("agent graph mailbox is unavailable");
    const encoded = JSON.stringify(message.body ?? {});
    if (Buffer.byteLength(encoded, "utf8") > this.#limits.messageBytes) {
      throw new Error("agent graph message exceeds its byte limit");
    }
    this.graph.postMessage({
      from: callerId,
      to: taskId,
      kind: message.kind,
      body: message.body ?? {},
    });
  }

  takeMessages(taskId: string) {
    return this.graph?.takeUndelivered(taskId) ?? [];
  }

  async cancel(
    callerId: string,
    taskId: string,
    reason: string,
    recursive = true,
  ): Promise<ChildAgentResult | undefined> {
    this.#assertAddressable(callerId, taskId);
    if (recursive) {
      for (const childId of [...(this.#children.get(taskId) ?? [])]) {
        await this.cancel(taskId, childId, reason, true);
      }
    }
    const result = await this.#ownerScheduler(taskId).cancel(taskId, reason);
    this.#ledger.release(taskId);
    this.#persistBudget();
    return result;
  }

  async cancelAll(reason: string): Promise<void> {
    for (const taskId of [...(this.#children.get("root") ?? [])]) {
      await this.cancel("root", taskId, reason, true);
    }
  }

  recoveryReport(): readonly DelegationRecoveryItem[] {
    const state = this.graph?.snapshot();
    if (state === null || state === undefined) return [];
    return Object.freeze(
      Object.values(state.nodes)
        .filter((node) => node.id !== state.rootNodeId)
        .filter((node) => !["completed", "partial", "failed", "cancelled", "blocked"].includes(node.state))
        .map((node) => ({
          nodeId: node.id,
          state: node.state,
          disposition: node.parentId === undefined
            ? "orphan-paused" as const
            : node.role === "explore" || node.role === "planner" || node.role === "architect" || node.role === "reviewer"
              ? "safe-retry" as const
              : "manual-review" as const,
        })),
    );
  }

  #schedulerFor(parentId: string, parent: AgentInstance | undefined): SubagentScheduler {
    return this.#schedulers.get(parentId) ?? this.#createScheduler(
      parentId,
      parent?.depth ?? 0,
      parent?.permissions,
    );
  }

  #createScheduler(
    parentId: string,
    parentDepth: number,
    permissions: AgentPermissionScope | undefined,
  ): SubagentScheduler {
    const scheduler = new SubagentScheduler({
      ...this.#base,
      ...(this.graph === undefined ? {} : { graph: this.graph }),
      parentDepth,
      parentAgentId: parentId,
      maxDepth: this.#limits.maxDepth,
      ...(permissions === undefined
        ? {}
        : { permissionCeiling: {
            ...permissions,
            mayRequestApproval: false,
          } }),
    });
    this.#schedulers.set(parentId, scheduler);
    return scheduler;
  }

  #requireParent(parentId: string): AgentInstance | undefined {
    if (parentId === "root") return undefined;
    const parent = this.#instances.get(parentId);
    if (parent === undefined) throw new Error("unknown delegation parent " + parentId);
    return parent;
  }

  #ownerScheduler(taskId: string): SubagentScheduler {
    const owner = this.#owners.get(taskId);
    const scheduler = owner === undefined ? undefined : this.#schedulers.get(owner);
    if (scheduler === undefined) throw new Error("unknown subagent " + taskId);
    return scheduler;
  }

  #assertAddressable(callerId: string, taskId: string): void {
    if (!this.#instances.has(taskId)) throw new Error("unknown subagent " + taskId);
    if (callerId !== "root" && !this.#isDescendant(taskId, callerId)) {
      throw new Error("a delegation facade cannot address a sibling subtree");
    }
  }

  #assertRelated(callerId: string, taskId: string): void {
    if (!this.#instances.has(taskId)) throw new Error("unknown subagent " + taskId);
    if (
      callerId !== "root"
      && !this.#isDescendant(taskId, callerId)
      && !this.#isDescendant(callerId, taskId)
    ) {
      throw new Error("agents may message only ancestors or descendants");
    }
  }

  #isDescendant(taskId: string, ancestorId: string): boolean {
    let current = this.#owners.get(taskId);
    while (current !== undefined) {
      if (current === ancestorId) return true;
      if (current === "root") return false;
      current = this.#owners.get(current);
    }
    return false;
  }

  #persistBudget(): void {
    this.graph?.setBudgetSnapshot(this.#ledger.snapshot);
  }
}

function narrowTask(
  task: AgentTask,
  parent: AgentPermissionScope | undefined,
): AgentTask {
  if (parent === undefined) return task;
  const allowedPaths = task.allowedPaths.length === 0
    ? []
    : [...task.allowedPaths];
  if (
    parent.allowedPaths.length > 0
    && allowedPaths.some((path) => !parent.allowedPaths.some((ceiling) => pathWithin(path, ceiling)))
  ) {
    throw new SpawnRejected(
      "AUTHORITY_WIDENING",
      "child allowedPaths exceed the parent path scope",
    );
  }
  return {
    ...task,
    allowedPaths,
    forbiddenPaths: [...new Set([...parent.forbiddenPaths, ...task.forbiddenPaths])],
  };
}

function pathWithin(child: string, parent: string): boolean {
  const childPath = normalizedBase(child);
  const parentPath = normalizedBase(parent);
  return parentPath === "."
    || childPath === parentPath
    || childPath.startsWith(parentPath + "/");
}

function normalizedBase(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/(?:\*\*)?\*?$/u, "")
    .replace(/\/+$/u, "") || ".";
}

function childBudget(
  role: SpawnOptions["role"],
  parent: AgentBudget | undefined,
  requested: Partial<AgentBudget> | undefined,
): AgentBudget {
  const definition = roleDefinition(role);
  const ceiling = parent === undefined
    ? {
        maxToolCalls: definition.maxToolCalls,
        maxModelCalls: definition.maxModelCalls,
        maxDurationMs: definition.maxDurationMs,
        softContextTokens: definition.softContextTokens,
      }
    : {
        maxToolCalls: Math.max(1, Math.floor(parent.maxToolCalls / 2)),
        maxModelCalls: Math.max(1, Math.floor(parent.maxModelCalls / 2)),
        maxDurationMs: Math.max(1, Math.floor(parent.maxDurationMs / 2)),
        softContextTokens: Math.max(1, Math.floor(parent.softContextTokens / 2)),
      };
  return {
    maxToolCalls: Math.min(ceiling.maxToolCalls, requested?.maxToolCalls ?? ceiling.maxToolCalls),
    maxModelCalls: Math.min(ceiling.maxModelCalls, requested?.maxModelCalls ?? ceiling.maxModelCalls),
    maxDurationMs: Math.min(ceiling.maxDurationMs, requested?.maxDurationMs ?? ceiling.maxDurationMs),
    softContextTokens: Math.min(
      ceiling.softContextTokens,
      requested?.softContextTokens ?? ceiling.softContextTokens,
    ),
  };
}

function budgetAmount(budget: AgentBudget): GraphBudgetAmount {
  return {
    toolCalls: budget.maxToolCalls,
    modelCalls: budget.maxModelCalls,
    wallClockMs: budget.maxDurationMs,
    contextTokens: budget.softContextTokens,
    costUsd: 0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("delegation limit must be positive");
  return value;
}
