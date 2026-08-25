/**
 * Bounded execution graph used by native tools and provider programmatic
 * tool-calling. It plans dependencies first, then executes only independent
 * read/test calls concurrently. Mutations and uncertain side effects remain
 * ordered barriers and are never retried by this layer.
 */

export type ToolGraphKind = "read" | "test" | "mutation" | "process" | "external" | "interactive";

export interface ToolGraphCall {
  readonly callId: string;
  readonly toolId: string;
  readonly kind?: ToolGraphKind;
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly mutates?: boolean;
  readonly externalSideEffect?: boolean;
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** Stable path/resource keys used for conflict detection and read coalescing. */
  readonly conflictKeys?: readonly string[];
}

export interface ToolGraphLimits {
  readonly maxParallelReads: number;
  readonly maxParallelTests: number;
  readonly serializeMutations: boolean;
  /** Return results in planned call order instead of parallel completion order. */
  readonly stableResultOrder: boolean;
  readonly maxNodes: number;
}

export const DEFAULT_TOOL_GRAPH_LIMITS: ToolGraphLimits = {
  maxParallelReads: 8,
  maxParallelTests: 2,
  serializeMutations: true,
  stableResultOrder: true,
  maxNodes: 64,
};

export interface ToolGraphRejection {
  readonly callId: string;
  readonly code: "duplicate_call_id" | "unknown_dependency" | "node_budget" | "cycle" | "unsafe_parallelism";
  readonly message: string;
}

export interface ToolGraphBatch {
  readonly batchId: string;
  readonly index: number;
  readonly kind: ToolGraphKind;
  readonly calls: readonly ToolGraphCall[];
  readonly dependsOn: readonly string[];
  readonly barrier: "parallel_read" | "parallel_test" | "mutation" | "side_effect" | "interactive";
}

export interface ToolGraphPlan {
  readonly batches: readonly ToolGraphBatch[];
  readonly rejected: readonly ToolGraphRejection[];
  readonly callOrder: readonly string[];
}

export interface ToolGraphExecutionResult<T> {
  readonly callId: string;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

export interface ToolGraphRunResult<T> {
  readonly plan: ToolGraphPlan;
  readonly results: readonly ToolGraphExecutionResult<T>[];
  readonly cancelled: boolean;
}

export class ToolExecutionGraph {
  readonly #limits: ToolGraphLimits;

  constructor(limits: Partial<ToolGraphLimits> = {}) {
    this.#limits = {
      ...DEFAULT_TOOL_GRAPH_LIMITS,
      ...limits,
      maxParallelReads: Math.max(1, Math.floor(limits.maxParallelReads ?? DEFAULT_TOOL_GRAPH_LIMITS.maxParallelReads)),
      maxParallelTests: Math.max(1, Math.floor(limits.maxParallelTests ?? DEFAULT_TOOL_GRAPH_LIMITS.maxParallelTests)),
      maxNodes: Math.max(1, Math.floor(limits.maxNodes ?? DEFAULT_TOOL_GRAPH_LIMITS.maxNodes)),
    };
  }

  get limits(): ToolGraphLimits {
    return this.#limits;
  }

  plan(calls: readonly ToolGraphCall[]): ToolGraphPlan {
    const rejected: ToolGraphRejection[] = [];
    const accepted: ToolGraphCall[] = [];
    const ids = new Set<string>();
    for (const call of calls) {
      if (ids.has(call.callId)) {
        rejected.push({ callId: call.callId, code: "duplicate_call_id", message: "call id must be unique" });
        continue;
      }
      ids.add(call.callId);
      if (accepted.length >= this.#limits.maxNodes) {
        rejected.push({ callId: call.callId, code: "node_budget", message: `graph is capped at ${this.#limits.maxNodes} nodes` });
        continue;
      }
      accepted.push(call);
    }

    const byId = new Map(accepted.map((call) => [call.callId, call]));
    const dependencies = new Map<string, Set<string>>();
    for (const call of accepted) {
      const deps = new Set<string>();
      for (const dependency of call.dependencies ?? []) {
        if (dependency === call.callId) {
          rejected.push({ callId: call.callId, code: "cycle", message: "a call cannot depend on itself" });
        } else if (byId.has(dependency)) {
          deps.add(dependency);
        } else {
          rejected.push({ callId: call.callId, code: "unknown_dependency", message: `unknown dependency '${dependency}'` });
        }
      }
      dependencies.set(call.callId, deps);
    }

    // Add deterministic happens-before edges for conflicts and all uncertain
    // side effects. This prevents a read from racing a write to the same path.
    for (let index = 0; index < accepted.length; index += 1) {
      const left = accepted[index]!;
      for (let later = index + 1; later < accepted.length; later += 1) {
        const right = accepted[later]!;
        if (mustOrder(left, right, this.#limits.serializeMutations)) dependencies.get(right.callId)!.add(left.callId);
      }
    }

    const batches: ToolGraphBatch[] = [];
    const assigned = new Set<string>();
    let guard = 0;
    while (assigned.size < accepted.length && guard < accepted.length + 1) {
      guard += 1;
      const ready = accepted.filter((call) => !assigned.has(call.callId) && [...(dependencies.get(call.callId) ?? [])].every((dep) => assigned.has(dep)));
      if (ready.length === 0) {
        for (const call of accepted) {
          if (!assigned.has(call.callId)) rejected.push({ callId: call.callId, code: "cycle", message: "dependency graph contains a cycle" });
        }
        break;
      }

      const kind = batchKind(ready[0]!);
      const eligible = ready.filter((call) => batchKind(call) === kind && isBatchCompatible(call, ready[0]!, kind));
      const chunkSize = kind === "read" ? this.#limits.maxParallelReads : kind === "test" ? this.#limits.maxParallelTests : 1;
      const selected = eligible.slice(0, chunkSize);
      const batchId = `tool-batch-${batches.length + 1}`;
      const dependsOn = [...new Set(selected.flatMap((call) => [...(dependencies.get(call.callId) ?? [])].filter((dep) => !selected.some((entry) => entry.callId === dep))))].sort();
      batches.push({
        batchId,
        index: batches.length,
        kind,
        calls: selected,
        dependsOn,
        barrier: kind === "read" ? "parallel_read" : kind === "test" ? "parallel_test" : kind === "mutation" ? "mutation" : kind === "interactive" ? "interactive" : "side_effect",
      });
      for (const call of selected) assigned.add(call.callId);
    }

    return {
      batches,
      rejected,
      callOrder: batches.flatMap((batch) => batch.calls.map((call) => call.callId)),
    };
  }

  async run<T>(
    calls: readonly ToolGraphCall[],
    execute: (call: ToolGraphCall, signal: AbortSignal) => Promise<T> | T,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ToolGraphRunResult<T>> {
    const plan = this.plan(calls);
    const results: ToolGraphExecutionResult<T>[] = [];
    const signal = options.signal ?? new AbortController().signal;
    let cancelled = false;
    for (const batch of plan.batches) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      const sharedReads = new Map<string, Promise<T>>();
      const completionResults: ToolGraphExecutionResult<T>[] = [];
      const pendingResults = batch.calls.map(async (call): Promise<ToolGraphExecutionResult<T>> => {
        if (signal.aborted) return { callId: call.callId, ok: false, error: new DOMException("aborted", "AbortError") };
        try {
          const sharedKey = batch.kind === "read" && (call.conflictKeys?.length ?? 0) > 0
            ? `${call.toolId}:${[...(call.conflictKeys ?? [])].sort().join("|")}`
            : undefined;
          let pending = sharedKey === undefined ? undefined : sharedReads.get(sharedKey);
          if (pending === undefined) {
            pending = Promise.resolve(execute(call, signal));
            if (sharedKey !== undefined) sharedReads.set(sharedKey, pending);
          }
          return { callId: call.callId, ok: true, value: await pending };
        } catch (error) {
          return { callId: call.callId, ok: false, error };
        }
      });
      const observedResults = pendingResults.map((pending) => pending.then((result) => {
        completionResults.push(result);
        return result;
      }));
      const inputOrderedResults = await Promise.all(observedResults);
      const batchResults = this.#limits.stableResultOrder ? inputOrderedResults : completionResults;
      results.push(...batchResults);
      if (batchResults.some((result) => !result.ok) && batch.kind !== "read" && batch.kind !== "test") break;
    }
    if (this.#limits.stableResultOrder) {
      const order = new Map(plan.callOrder.map((id, index) => [id, index]));
      results.sort((left, right) => (order.get(left.callId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.callId) ?? Number.MAX_SAFE_INTEGER));
    }
    return { plan, results, cancelled };
  }
}

function batchKind(call: ToolGraphCall): ToolGraphKind {
  if (call.kind !== undefined) return call.kind;
  if (call.externalSideEffect === true) return "external";
  if (call.mutates === true || (call.writes?.length ?? 0) > 0) return "mutation";
  if (call.toolId.startsWith("process.") || call.toolId === "shell.run") return "process";
  if (call.toolId.startsWith("test.") || call.toolId.includes("test")) return "test";
  return "read";
}

function isBatchCompatible(left: ToolGraphCall, right: ToolGraphCall, kind: ToolGraphKind): boolean {
  if (kind !== "read" && kind !== "test") return left.callId === right.callId;
  return !conflicts(left, right);
}

function mustOrder(left: ToolGraphCall, right: ToolGraphCall, serializeMutations: boolean): boolean {
  const leftKind = batchKind(left);
  const rightKind = batchKind(right);
  if (conflicts(left, right)) return true;
  if (leftKind === "interactive" || rightKind === "interactive") return true;
  if (leftKind === "external" || rightKind === "external" || leftKind === "process" || rightKind === "process") return true;
  if (serializeMutations && (leftKind === "mutation" || rightKind === "mutation")) return true;
  return false;
}

function conflicts(left: ToolGraphCall, right: ToolGraphCall): boolean {
  const leftKeys = new Set([...(left.conflictKeys ?? []), ...(left.reads ?? []), ...(left.writes ?? [])]);
  const rightKeys = new Set([...(right.conflictKeys ?? []), ...(right.reads ?? []), ...(right.writes ?? [])]);
  if ([...leftKeys].some((key) => rightKeys.has(key))) {
    // Shared read keys are safe to coalesce in `run`; keeping the edge here
    // preserves deterministic order for callers that execute the plan directly.
    if ((left.writes?.length ?? 0) > 0 || (right.writes?.length ?? 0) > 0) return true;
    if ((left.reads?.length ?? 0) > 0 && (right.reads?.length ?? 0) > 0) return false;
    return true;
  }
  const leftReads = new Set(left.reads ?? []);
  const leftWrites = new Set(left.writes ?? []);
  const rightReads = new Set(right.reads ?? []);
  const rightWrites = new Set(right.writes ?? []);
  return [...leftWrites].some((path) => rightWrites.has(path) || rightReads.has(path)) || [...rightWrites].some((path) => leftReads.has(path));
}

