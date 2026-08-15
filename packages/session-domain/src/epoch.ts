/**
 * Task epochs are the durable boundary for provider reasoning continuity.
 *
 * An epoch is deliberately small: it identifies the assumptions under which a
 * sample was produced, but never stores a chain-of-thought transcript. Any
 * change to those assumptions starts a new epoch so stale hidden reasoning
 * cannot silently leak into a later turn.
 */

import { createHash } from "node:crypto";

export type TaskEpochId = `epoch-${string}`;

export type EpochResetReason =
  | "initial"
  | "goal_changed"
  | "policy_changed"
  | "workspace_changed"
  | "toolset_changed"
  | "model_changed"
  | "hypothesis_invalidated"
  | "review_requested"
  | "priority_changed"
  | "reflection_requested"
  | "assumption_invalidated"
  | "constraint_changed"
  | "workspace_stale"
  | "capability_changed";

export interface ReasoningScope {
  readonly taskEpochId: TaskEpochId;
  readonly continuity: "current_turn" | "all_turns";
  readonly goalStable: boolean;
  readonly hypothesisInvalidated: boolean;
  readonly allTurnsContinuity: boolean;
  readonly reviewerRequested: boolean;
}

export interface TaskEpoch {
  readonly id: TaskEpochId;
  readonly epochId: TaskEpochId;
  readonly generation: number;
  readonly goalDigest: string;
  readonly constraintDigest: string;
  readonly assumptionDigest: string;
  readonly policyDigest: string;
  readonly workspaceIdentityDigest: string;
  readonly toolsetDigest: string;
  readonly modelId: string;
  readonly modelCapabilityDigest: string;
  readonly createdAt: string;
  readonly startedAtSequence: number;
  readonly resetReason: EpochResetReason;
  readonly reasoningScope: ReasoningScope;
}

export interface EpochStartInput {
  readonly goalDigest: string;
  readonly policyDigest: string;
  readonly workspaceIdentityDigest: string;
  readonly toolsetDigest: string;
  readonly modelId: string;
  readonly constraintDigest?: string;
  readonly assumptionDigest?: string;
  readonly modelCapabilityDigest?: string;
  readonly startedAtSequence?: number;
  readonly now?: string;
}

export interface EpochChangeSet {
  readonly goalDigest?: string;
  readonly policyDigest?: string;
  readonly workspaceIdentityDigest?: string;
  readonly toolsetDigest?: string;
  readonly modelId?: string;
  readonly goalChanged?: boolean;
  readonly policyChanged?: boolean;
  readonly workspaceChanged?: boolean;
  readonly toolsetChanged?: boolean;
  readonly modelChanged?: boolean;
  readonly hypothesisInvalidated?: boolean;
  readonly reviewRequested?: boolean;
  readonly priorityChanged?: boolean;
  readonly reflectionRequested?: boolean;
  readonly constraintDigest?: string;
  readonly assumptionDigest?: string;
  readonly modelCapabilityDigest?: string;
  readonly constraintChanged?: boolean;
  readonly assumptionInvalidated?: boolean;
  readonly workspaceStale?: boolean;
  readonly modelCapabilityChanged?: boolean;
  readonly now?: string;
}

export interface EpochTransition {
  readonly previous?: TaskEpoch;
  readonly current: TaskEpoch;
  readonly reset: boolean;
  readonly reason: EpochResetReason;
}

export interface TaskEpochManagerOptions {
  readonly now?: () => string;
  readonly initial?: EpochStartInput;
}

/** Owns epoch lifecycle and maps invalidation signals to a fresh scope. */
export class TaskEpochManager {
  readonly #now: () => string;
  #current?: TaskEpoch;
  #generation = 0;

  constructor(options: TaskEpochManagerOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.initial !== undefined) this.start(options.initial);
  }

  current(): TaskEpoch | undefined {
    return this.#current;
  }

  requireCurrent(): TaskEpoch {
    if (this.#current === undefined) throw new Error("task epoch has not started");
    return this.#current;
  }

  start(input: EpochStartInput, reason: EpochResetReason = "initial"): TaskEpoch {
    this.#generation += 1;
    const now = input.now ?? this.#now();
    const constraintDigest = input.constraintDigest ?? "unspecified-constraints";
    const assumptionDigest = input.assumptionDigest ?? "unspecified-assumptions";
    const modelCapabilityDigest = input.modelCapabilityDigest ?? shortDigest({ modelId: input.modelId });
    const id = `epoch-${this.#generation.toString(36)}-${shortDigest({
      generation: this.#generation,
      goalDigest: input.goalDigest,
      constraintDigest,
      assumptionDigest,
      workspaceIdentityDigest: input.workspaceIdentityDigest,
      modelId: input.modelId,
      modelCapabilityDigest,
    })}` as TaskEpochId;
    const reviewerRequested = reason === "review_requested";
    const hypothesisInvalidated = reason === "hypothesis_invalidated" || reason === "assumption_invalidated" || reason === "reflection_requested";
    const continuity: ReasoningScope["continuity"] = reviewerRequested || hypothesisInvalidated ? "current_turn" : "all_turns";
    const scope: ReasoningScope = {
      taskEpochId: id,
      continuity,
      goalStable: reason !== "goal_changed",
      hypothesisInvalidated,
      allTurnsContinuity: continuity === "all_turns",
      reviewerRequested,
    };
    this.#current = {
      id,
      epochId: id,
      generation: this.#generation,
      goalDigest: input.goalDigest,
      constraintDigest,
      assumptionDigest,
      policyDigest: input.policyDigest,
      workspaceIdentityDigest: input.workspaceIdentityDigest,
      toolsetDigest: input.toolsetDigest,
      modelId: input.modelId,
      modelCapabilityDigest,
      createdAt: now,
      startedAtSequence: Math.max(0, Math.floor(input.startedAtSequence ?? this.#generation)),
      resetReason: reason,
      reasoningScope: scope,
    };
    return this.#current;
  }

  transition(change: EpochChangeSet): EpochTransition {
    const previous = this.#current;
    if (previous === undefined) {
      const current = this.start(
        {
          goalDigest: change.goalDigest ?? "unknown-goal",
          policyDigest: change.policyDigest ?? "unknown-policy",
          workspaceIdentityDigest: change.workspaceIdentityDigest ?? "unknown-workspace",
          toolsetDigest: change.toolsetDigest ?? "unknown-toolset",
          modelId: change.modelId ?? "unknown-model",
          ...(change.constraintDigest !== undefined ? { constraintDigest: change.constraintDigest } : {}),
          ...(change.assumptionDigest !== undefined ? { assumptionDigest: change.assumptionDigest } : {}),
          ...(change.modelCapabilityDigest !== undefined ? { modelCapabilityDigest: change.modelCapabilityDigest } : {}),
          ...(change.now !== undefined ? { now: change.now } : {}),
        },
        "initial",
      );
      return { current, reset: true, reason: "initial" };
    }

    const reason = resetReason(previous, change);
    if (reason !== undefined) {
      const current = this.start(
        {
          goalDigest: change.goalDigest ?? previous.goalDigest,
          policyDigest: change.policyDigest ?? previous.policyDigest,
          workspaceIdentityDigest: change.workspaceIdentityDigest ?? previous.workspaceIdentityDigest,
          toolsetDigest: change.toolsetDigest ?? previous.toolsetDigest,
          modelId: change.modelId ?? previous.modelId,
          ...(change.constraintDigest !== undefined ? { constraintDigest: change.constraintDigest } : {}),
          ...(change.assumptionDigest !== undefined ? { assumptionDigest: change.assumptionDigest } : {}),
          ...(change.modelCapabilityDigest !== undefined ? { modelCapabilityDigest: change.modelCapabilityDigest } : {}),
          ...(change.now !== undefined ? { now: change.now } : {}),
        },
        reason,
      );
      return { previous, current, reset: true, reason };
    }

    const current: TaskEpoch = {
      ...previous,
      goalDigest: change.goalDigest ?? previous.goalDigest,
      policyDigest: change.policyDigest ?? previous.policyDigest,
      workspaceIdentityDigest: change.workspaceIdentityDigest ?? previous.workspaceIdentityDigest,
      toolsetDigest: change.toolsetDigest ?? previous.toolsetDigest,
      modelId: change.modelId ?? previous.modelId,
    };
    this.#current = current;
    return { previous, current, reset: false, reason: "initial" };
  }

  invalidateHypothesis(now?: string): EpochTransition {
    return this.transition({ hypothesisInvalidated: true, ...(now !== undefined ? { now } : {}) });
  }

  requestReviewer(now?: string): EpochTransition {
    return this.transition({ reviewRequested: true, ...(now !== undefined ? { now } : {}) });
  }

  scope(): ReasoningScope {
    return this.requireCurrent().reasoningScope;
  }
}

export type ReasoningEvent =
  | { readonly type: "start"; readonly input: EpochStartInput }
  | { readonly type: "change"; readonly change: EpochChangeSet }
  | { readonly type: "hypothesis_invalidated"; readonly now?: string }
  | { readonly type: "review_requested"; readonly now?: string };

/** Small adapter used by kernels that consume event-shaped reasoning signals. */
export class ReasoningStateMachine {
  readonly manager: TaskEpochManager;

  constructor(manager = new TaskEpochManager()) {
    this.manager = manager;
  }

  apply(event: ReasoningEvent): EpochTransition {
    switch (event.type) {
      case "start": {
        const previous = this.manager.current();
        const current = this.manager.start(event.input);
        return { ...(previous !== undefined ? { previous } : {}), current, reset: true, reason: "initial" };
      }
      case "change":
        return this.manager.transition(event.change);
      case "hypothesis_invalidated":
        return this.manager.invalidateHypothesis(event.now);
      case "review_requested":
        return this.manager.requestReviewer(event.now);
    }
  }

  scope(): ReasoningScope {
    return this.manager.scope();
  }
}

function resetReason(previous: TaskEpoch, change: EpochChangeSet): EpochResetReason | undefined {
  if (change.workspaceStale === true) return "workspace_stale";
  if (change.workspaceChanged === true || (change.workspaceIdentityDigest !== undefined && change.workspaceIdentityDigest !== previous.workspaceIdentityDigest)) return "workspace_changed";
  if (change.constraintChanged === true || (change.constraintDigest !== undefined && change.constraintDigest !== previous.constraintDigest)) return "constraint_changed";
  if (change.goalChanged === true || (change.goalDigest !== undefined && change.goalDigest !== previous.goalDigest)) return "goal_changed";
  if (change.policyChanged === true || (change.policyDigest !== undefined && change.policyDigest !== previous.policyDigest)) return "policy_changed";
  if (change.toolsetChanged === true || (change.toolsetDigest !== undefined && change.toolsetDigest !== previous.toolsetDigest)) return "toolset_changed";
  if (change.modelCapabilityChanged === true || (change.modelCapabilityDigest !== undefined && change.modelCapabilityDigest !== previous.modelCapabilityDigest)) return "capability_changed";
  if (change.modelChanged === true || (change.modelId !== undefined && change.modelId !== previous.modelId)) return "model_changed";
  if (change.assumptionInvalidated === true) return "assumption_invalidated";
  if (change.hypothesisInvalidated === true) return "hypothesis_invalidated";
  if (change.reviewRequested === true) return "review_requested";
  if (change.priorityChanged === true) return "priority_changed";
  if (change.reflectionRequested === true) return "reflection_requested";
  return undefined;
}

function shortDigest(value: unknown): string {
  const text = JSON.stringify(value, (_key, current) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return current;
  });
  return createHash("sha256").update(text).digest("hex");
}

