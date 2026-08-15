/**
 * Interaction-mode domain state.
 *
 * Build/Plan describes what kind of work the agent is doing. Permission presets
 * describe how otherwise-allowed work is approved. Keeping those axes separate
 * prevents a permissive preset from punching through Plan's read-only ceiling.
 */

export type InteractionMode = "build" | "plan";

export type ModeChangeSource =
  | "default"
  | "config"
  | "cli"
  | "slash"
  | "key"
  | "migration"
  | "resume_migration"
  | "quiescence";

export interface PlanEntryBlocker {
  readonly kind:
    | "writer_subagent"
    | "process_job"
    | "open_transaction"
    | "pending_approval";
  readonly id: string;
  readonly detail: string;
}

export interface SessionModeState {
  /** Mode selected for the next turn while the session is idle. */
  readonly selected: InteractionMode;
  /** Immutable mode captured when the current turn started. */
  readonly activeTurn?: InteractionMode;
  /** Requested mode to apply at the next safe boundary. */
  readonly pending?: InteractionMode;
  /** Blockers that must drain before a pending Plan transition is committed. */
  readonly blockers?: readonly PlanEntryBlocker[];
  readonly revision: number;
}

export interface ModeActivitySnapshot {
  readonly turnRunning: boolean;
  readonly activeWriteTools?: number;
  readonly activeTransactions?: readonly string[];
  readonly activeProcesses?: readonly string[];
  readonly activeWriterSubagents?: readonly string[];
  readonly pendingApprovals?: readonly string[];
}

export interface ModeChangeRequest {
  readonly target: InteractionMode;
  readonly source: ModeChangeSource;
}

export type ModeChangeResult =
  | { readonly kind: "applied"; readonly state: SessionModeState }
  | { readonly kind: "pending"; readonly state: SessionModeState }
  | { readonly kind: "cancelled"; readonly state: SessionModeState }
  | { readonly kind: "unchanged"; readonly state: SessionModeState };

export function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "build" || value === "plan";
}

export function createModeState(selected: InteractionMode = "build"): SessionModeState {
  return { selected, revision: 0 };
}

/** Capture the selected mode once. Live UI changes never alter an active turn. */
export function startModeTurn(state: SessionModeState): SessionModeState {
  if (state.activeTurn !== undefined) return state;
  return { ...state, activeTurn: state.selected };
}

/**
 * Request a Build/Plan transition.
 *
 * A running turn is always allowed to finish with the mode it captured. Entering
 * Plan additionally waits for every write-capable activity to become quiescent.
 */
export function requestModeChange(
  state: SessionModeState,
  request: ModeChangeRequest,
  activity: ModeActivitySnapshot,
): ModeChangeResult {
  const blockers = request.target === "plan" ? planEntryBlockers(activity) : [];
  const mustDefer = activity.turnRunning || blockers.length > 0;

  if (state.pending !== undefined && request.target === state.selected) {
    const next = withoutPending(state);
    return {
      kind: "cancelled",
      state: { ...next, revision: state.revision + 1 },
    };
  }

  if (state.pending === request.target) {
    // A quiescence check is the commit step for a request that was deferred
    // while a turn or writer activity was still running. A repeated user request
    // while it is still blocked remains a no-op.
    if (mustDefer) return { kind: "unchanged", state };
    return {
      kind: "applied",
      state: {
        selected: request.target,
        revision: state.revision + 1,
      },
    };
  }
  if (!mustDefer && state.selected === request.target) return { kind: "unchanged", state };

  if (mustDefer) {
    return {
      kind: "pending",
      state: {
        ...state,
        pending: request.target,
        ...(blockers.length > 0 ? { blockers } : {}),
        revision: state.revision + 1,
      },
    };
  }

  return {
    kind: "applied",
    state: {
      selected: request.target,
      revision: state.revision + 1,
    },
  };
}

/** Finish the active turn and commit a pending mode only after quiescence. */
export function finishModeTurn(
  state: SessionModeState,
  activity: Omit<ModeActivitySnapshot, "turnRunning"> & { readonly turnRunning?: false } = {},
): ModeChangeResult {
  const idleState: SessionModeState = state.activeTurn === undefined
    ? state
    : (() => {
        const { activeTurn: _activeTurn, ...rest } = state;
        return rest;
      })();
  if (idleState.pending === undefined) {
    return idleState === state
      ? { kind: "unchanged", state }
      : { kind: "applied", state: idleState };
  }

  const blockers = idleState.pending === "plan"
    ? planEntryBlockers({ ...activity, turnRunning: false })
    : [];
  if (blockers.length > 0) {
    return {
      kind: "pending",
      state: { ...idleState, blockers },
    };
  }

  return {
    kind: "applied",
    state: {
      selected: idleState.pending,
      revision: idleState.revision + 1,
    },
  };
}

export function planEntryBlockers(activity: ModeActivitySnapshot): PlanEntryBlocker[] {
  const blockers: PlanEntryBlocker[] = [];
  for (const id of activity.activeWriterSubagents ?? []) {
    blockers.push({ kind: "writer_subagent", id, detail: `writer subagent ${id} is still active` });
  }
  for (const id of activity.activeProcesses ?? []) {
    blockers.push({ kind: "process_job", id, detail: `process job ${id} is still active` });
  }
  for (const id of activity.activeTransactions ?? []) {
    blockers.push({ kind: "open_transaction", id, detail: `transaction ${id} is still open` });
  }
  for (const id of activity.pendingApprovals ?? []) {
    blockers.push({ kind: "pending_approval", id, detail: `approval ${id} is unresolved` });
  }
  if ((activity.activeWriteTools ?? 0) > 0) {
    blockers.push({
      kind: "open_transaction",
      id: "active-write-tools",
      detail: `${activity.activeWriteTools} write-capable tool call(s) are still active`,
    });
  }
  return blockers;
}

function withoutPending(state: SessionModeState): SessionModeState {
  const { pending: _pending, blockers: _blockers, ...rest } = state;
  return rest;
}
