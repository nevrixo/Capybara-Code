/**
 * Session journal bridge — PRD §18.6, §18.11, §20.9, AC-35, AC-36, AC-46.
 *
 * §20.9 sets the persistence boundary: the TypeScript reducer produces semantic
 * events, and a journaled event is durable only after the Rust `session.append`
 * acknowledgement returns.
 */

import {
  createEvent,
  EventSequencer,
  LIMITS,
  type CbcEvent,
  type CbcEventKind,
  type EventFactoryOptions,
} from "@cbc/protocol";

import { reduce, emptyViewModel, shouldPersist, type GoalContractView, type SessionViewModel } from "./reducer.ts";
import { parseDeepPlanState } from "./deep-plan.ts";
import { boundResidentViewModel, createSnapshotEnvelope } from "./persistence.ts";
import { normalizePlanDocument, normalizeTodoItems, planDigest, sanitizeTodoText, type PlanApproval, type PlanDocument, type PlanItem, type TodoListState } from "./todo.ts";

/** Keep journal RPCs well below the runtime's 8 MiB frame ceiling. */
export const JOURNAL_BATCH_MAX_EVENTS = 32;
export const JOURNAL_BATCH_DELAY_MS = 20;
export const JOURNAL_BATCH_MAX_BYTES = Math.min(4 * 1024 * 1024, LIMITS.maxFrameBytes / 2);
export const DEFAULT_RESIDENT_TIMELINE_ITEMS = 4_096;
export const DEFAULT_RESIDENT_TIMELINE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_EVERY_EVENTS = 32;
export const DEFAULT_SNAPSHOT_EVERY_BYTES = 512 * 1024;
const RESIDENT_TIMELINE_CHECK_INTERVAL = 256;

interface PendingJournalEvent {
  readonly event: CbcEvent;
  readonly wire: Record<string, unknown>;
  readonly bytes: number;
}

const JOURNAL_ENCODER = new TextEncoder();

function journalWireEvent(event: CbcEvent): Record<string, unknown> {
  return {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    turnId: event.turnId,
    agentId: event.agentId,
    level: event.level,
    visibility: event.visibility,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
    // P0-06 journal v2: preserve the client stream sequence and lineage fields.
    streamSequence: event.sequence,
    ...(event.callerId !== undefined ? { callerId: event.callerId } : {}),
    ...(event.taskEpochId !== undefined ? { taskEpochId: event.taskEpochId } : {}),
    ...(event.workspaceIdentityDigest !== undefined
      ? { workspaceIdentityDigest: event.workspaceIdentityDigest }
      : {}),
    ...(event.parentEventId !== undefined ? { parentEventId: event.parentEventId } : {}),
    ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
  };
}

function journalAckSequence(
  ack: unknown,
  batch: readonly PendingJournalEvent[],
): number {
  if (typeof ack !== "object" || ack === null) {
    throw new Error("session.append returned a non-object acknowledgement");
  }
  const value = ack as { appended?: unknown; lastSequence?: unknown; events?: unknown };
  if (value.appended !== batch.length) {
    throw new Error(`session.append acknowledged ${String(value.appended)} of ${batch.length} events`);
  }
  if (!Array.isArray(value.events) || value.events.length !== batch.length) {
    throw new Error("session.append acknowledgement event count does not match the batch");
  }

  let maxSequence = 0;
  for (let index = 0; index < batch.length; index += 1) {
    const raw = value.events[index];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`session.append acknowledgement event ${index} is invalid`);
    }
    const returned = raw as { id?: unknown; sequence?: unknown };
    const expected = batch[index]!;
    if (returned.id !== expected.event.id) {
      throw new Error(`session.append acknowledgement reordered event ${expected.event.id}`);
    }
    if (
      typeof returned.sequence !== "number" ||
      !Number.isSafeInteger(returned.sequence) ||
      returned.sequence <= 0
    ) {
      throw new Error(`session.append acknowledgement has an invalid sequence for ${expected.event.id}`);
    }
    maxSequence = Math.max(maxSequence, returned.sequence);
  }
  if (value.lastSequence !== maxSequence) {
    throw new Error("session.append acknowledgement lastSequence does not match its events");
  }
  return maxSequence;
}

export interface JournalTransport {
  /** `session.open` */
  open(params: Record<string, unknown>): Promise<unknown>;
  /** `session.append` */
  append(params: Record<string, unknown>): Promise<unknown>;
  /** `session.snapshot` */
  snapshot(params: Record<string, unknown>): Promise<unknown>;
  /** `session.load` */
  load(params: Record<string, unknown>): Promise<unknown>;
}

export interface SessionManifest {
  schemaVersion: string;
  id: string;
  workspacePath: string;
  workspaceFingerprint: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  modelProfile: string;
  permissionMode: string;
  interactionMode?: "build" | "plan";
  permissionPreset?: string;
  planRevision?: number;
  parentSessionId?: string;
  lastEventSequence: number;
  state: "active" | "completed" | "interrupted" | "archived";
}

/** Replace local workspace paths when a manifest crosses an export boundary. */
export function redactWorkspacePath(_path: string): string {
  return "<workspace>";
}

export interface IntegrityReport {
  sessionId: string;
  eventsVerified: number;
  lastValidSequence: number;
  ok: boolean;
  breakDetail?: string;
}

/** §18.11 resume consistency checks. */
export interface ResumeWarning {
  readonly kind:
    | "workspace_missing"
    | "git_head_changed"
    | "file_changed"
    | "config_fingerprint_changed"
    | "skill_fingerprint_changed"
    | "mcp_fingerprint_changed"
    | "model_unavailable"
    | "unfinished_transaction"
    | "stale_job"
    | "journal_truncated";
  readonly detail: string;
}

export interface ResumeState {
  readonly manifest: SessionManifest;
  readonly model: SessionViewModel;
  readonly integrity: IntegrityReport;
  readonly warnings: ResumeWarning[];
}

export interface SessionHydrationPosition {
  readonly journalSequence: number;
  readonly streamSequence: number;
}

export interface SessionRecorderOptions {
  readonly sessionId: string;
  readonly transport: JournalTransport;
  readonly startAfterSequence?: number;
  readonly snapshotEveryEvents?: number;
  readonly snapshotEveryBytes?: number;
  readonly contextBudgetTokens?: number;
  /** In-memory timeline bounds; durable journal history is never deleted. */
  readonly residentTimelineMaxItems?: number;
  readonly residentTimelineMaxBytes?: number;
  /**
   * Extend the reducer snapshot with prompt-critical state (for example kernel
   * history and compaction state). The default remains the legacy model shape.
   */
  readonly serializeSnapshot?: (
    model: SessionViewModel,
    position: SessionHydrationPosition,
  ) => Record<string, unknown>;
  /** Called for every event so presentation and internal observers see the same sequence. */
  readonly onEvent?: (event: CbcEvent) => void;
  readonly onDurable?: (event: CbcEvent) => void;
  readonly onJournalError?: (event: CbcEvent, error: unknown) => void;
}

/**
 * Owns the sequencer, the reducer state, and the durability handshake.
 * One instance per open session.
 */
export class SessionRecorder {
  readonly #sequencer: EventSequencer;
  readonly #options: SessionRecorderOptions;
  #model: SessionViewModel;
  #sinceSnapshot = 0;
  #sinceSnapshotBytes = 0;
  #pendingCompletedTurnId: string | undefined;
  #lastSnapshotTurnId: string | undefined;
  #journalBatch: PendingJournalEvent[] = [];
  #journalBatchBytes = 0;
  #journalBatchTimer: ReturnType<typeof setTimeout> | undefined;
  #appendTail: Promise<void> = Promise.resolve();
  #journalDegraded = false;
  /**
   * P0-06: the store's own journal sequence, as acknowledged by the last append.
   * Ephemeral events consume stream sequences without ever reaching the journal,
   * so the two sequences diverge; snapshots record both, and resume reconciles on
   * the journal one.
   */
  #lastJournalSequence = 0;
  #residentEventsSinceCheck = 0;
  #residentWireBytesSinceCheck = 0;
  #residentTimelineOmitted = 0;

  constructor(options: SessionRecorderOptions) {
    this.#options = options;
    this.#sequencer = new EventSequencer(options.startAfterSequence ?? 0);
    this.#model = emptyViewModel(options.sessionId, options.contextBudgetTokens);
  }

  get model(): SessionViewModel {
    return this.#model;
  }

  get lastSequence(): number {
    return this.#sequencer.lastSequence;
  }

  get lastJournalSequence(): number {
    return this.#lastJournalSequence;
  }

  get residentTimelineOmitted(): number {
    return this.#residentTimelineOmitted;
  }

  /**
   * Seed a fully deserialized model (possibly extracted from an extensible
   * snapshot payload) and the two explicit resume positions before tail replay.
   * AgentSession remains responsible for restoring prompt/kernel state that is
   * intentionally outside SessionViewModel.
   */
  hydrateSeededModel(
    model: SessionViewModel,
    position: SessionHydrationPosition,
    options: { readonly residentTimelineOmitted?: number } = {},
  ): void {
    validateHydrationPosition(position);
    if (
      options.residentTimelineOmitted !== undefined &&
      (!Number.isSafeInteger(options.residentTimelineOmitted) ||
        options.residentTimelineOmitted < 0)
    ) throw new RangeError("residentTimelineOmitted must be a non-negative safe integer");
    if (model.sessionId !== this.#options.sessionId) {
      throw new Error(
        `snapshot model session ${model.sessionId} does not match ${this.#options.sessionId}`,
      );
    }
    if (model.lastSequence > position.streamSequence) {
      throw new RangeError(
        "seeded model lastSequence cannot exceed the explicit streamSequence",
      );
    }
    this.#model = model;
    this.#residentTimelineOmitted = options.residentTimelineOmitted ?? 0;
    this.#boundResidentTimeline(true);
    this.#lastJournalSequence = Math.max(
      this.#lastJournalSequence,
      position.journalSequence,
    );
    this.#sequencer.advanceTo(position.streamSequence);
  }

  /** Seed the reducer from resumed tail events without re-journaling them. */
  hydrate(
    events: readonly CbcEvent[],
    position?: SessionHydrationPosition,
  ): void {
    if (position !== undefined) validateHydrationPosition(position);
    let replayedJournalSequence = this.#lastJournalSequence;
    for (const event of events) {
      this.#model = reduce(this.#model, event);
      // Legacy callers restore the dense journal sequence into event.sequence.
      // New callers should pass an explicit final position when the protocol
      // stream sequence differs.
      replayedJournalSequence = Math.max(replayedJournalSequence, event.sequence);
      this.#sequencer.advanceTo(event.sequence);
      // Ephemeral deltas consume local sequences but are not stored. Their local
      // sequence is still encoded in the event id of the following durable event,
      // so preserve that high-water mark across resume as well.
      const localSequence = sequenceFromEventId(event.id);
      if (localSequence !== undefined) this.#sequencer.advanceTo(localSequence);
    }
    this.#lastJournalSequence = Math.max(
      this.#lastJournalSequence,
      position?.journalSequence ?? replayedJournalSequence,
    );
    if (position !== undefined) this.#sequencer.advanceTo(position.streamSequence);
    this.#boundResidentTimeline(true);
  }

  /**
   * Emit an event: update the reducer immediately for latency, then journal it.
   * §22.2 targets `< 75 ms` provider-event-to-render, so the UI never waits on
   * the disk round trip; §20.9 still requires the acknowledgement before an
   * event counts as durable.
   */
  emit<T>(
    kind: CbcEventKind,
    payload: T,
    options: Omit<EventFactoryOptions, "sessionId"> = {},
  ): CbcEvent<T> {
    const event = createEvent(this.#sequencer, kind, payload, {
      ...options,
      sessionId: this.#options.sessionId,
    });
    this.#model = reduce(this.#model, event);
    if (event.durability === "journaled") {
      this.#boundResidentTimeline(false, true, approximateJsonBytes(payload));
    }
    try {
      this.#options.onEvent?.(event);
    } catch {
      // Render/telemetry sinks are downstream observers. A broken UI callback
      // cannot abort tool observation, freshness refresh, or durable journaling.
    }

    if (event.durability === "journaled" && shouldPersist(kind)) {
      this.#enqueueJournalEvent(event);
      this.#sinceSnapshot += 1;
      this.#sinceSnapshotBytes += approximateJsonBytes(payload);
      if (
        (kind === "turn.completed" || kind === "turn.cancelled" || kind === "turn.interrupted") &&
        event.turnId !== undefined
      ) {
        this.#pendingCompletedTurnId = event.turnId;
      }
    }
    return event;
  }

  #enqueueJournalEvent(event: CbcEvent): void {
    const wire = journalWireEvent(event);
    let queuedWire = wire;
    let bytes = JOURNAL_BATCH_MAX_BYTES;
    try {
      const serialized = JSON.stringify(wire);
      bytes = JOURNAL_ENCODER.encode(serialized).byteLength + 1;
      // The debounce widens the interval in which a caller could mutate its payload.
      // Queue the exact JSON snapshot measured above so reducer/UI observation and
      // persistence cannot diverge before the timer fires.
      queuedWire = JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      // Let the transport report serialization failures through the normal journal
      // error path rather than turning a latency-first `emit()` into a throw.
    }

    if (
      this.#journalBatch.length > 0 &&
      (this.#journalBatch.length >= JOURNAL_BATCH_MAX_EVENTS ||
        this.#journalBatchBytes + bytes > JOURNAL_BATCH_MAX_BYTES)
    ) {
      this.#flushJournalBatch();
    }

    this.#journalBatch.push({ event, wire: queuedWire, bytes });
    this.#journalBatchBytes += bytes;
    if (
      this.#journalBatch.length >= JOURNAL_BATCH_MAX_EVENTS ||
      this.#journalBatchBytes >= JOURNAL_BATCH_MAX_BYTES
    ) {
      this.#flushJournalBatch();
      return;
    }

    if (this.#journalBatchTimer !== undefined) return;
    this.#journalBatchTimer = setTimeout(() => {
      this.#journalBatchTimer = undefined;
      this.#flushJournalBatch();
    }, JOURNAL_BATCH_DELAY_MS);
    (this.#journalBatchTimer as unknown as { unref?: () => void }).unref?.();
  }

  #flushJournalBatch(): void {
    if (this.#journalBatchTimer !== undefined) {
      clearTimeout(this.#journalBatchTimer);
      this.#journalBatchTimer = undefined;
    }
    if (this.#journalBatch.length === 0) return;

    const batch = this.#journalBatch;
    this.#journalBatch = [];
    this.#journalBatchBytes = 0;
    const prior = this.#appendTail;
    this.#appendTail = prior.catch(() => undefined).then(async () => {
      let lastSequence: number;
      try {
        const ack = await this.#options.transport.append({
          sessionId: this.#options.sessionId,
          events: batch.map((pending) => pending.wire),
        });
        lastSequence = journalAckSequence(ack, batch);
      } catch (error) {
        this.#journalDegraded = true;
        for (const pending of batch) {
          try {
            this.#options.onJournalError?.(pending.event, error);
          } catch {
            // Observer failures must not break the ordered append tail or prevent
            // later batch members from receiving the durability notification.
          }
        }
        return;
      }

      // P0-06: snapshots are keyed by the validated store-assigned durable
      // sequence, not the local stream sequence ephemeral deltas also consume.
      if (lastSequence > this.#lastJournalSequence) this.#lastJournalSequence = lastSequence;
      for (const pending of batch) {
        try {
          this.#options.onDurable?.(pending.event);
        } catch {
          // Persistence already succeeded; an observer cannot retroactively turn
          // the batch into a journal failure or strand the tail.
        }
      }
    });
  }

  /** Drain the timer/buffer and wait for the single ordered append tail. */
  async flush(): Promise<void> {
    // Events may arrive while an earlier RPC is in flight. Repeat until the tail we
    // awaited is still current and no timer-owned batch remains.
    for (;;) {
      this.#flushJournalBatch();
      const tail = this.#appendTail;
      await tail;
      if (tail === this.#appendTail && this.#journalBatch.length === 0) return;
    }
  }

  #boundResidentTimeline(
    force: boolean,
    countEvent = false,
    approximateEventBytes = 0,
  ): void {
    if (countEvent) {
      this.#residentEventsSinceCheck += 1;
      this.#residentWireBytesSinceCheck += approximateEventBytes;
    }
    const maxItems = this.#options.residentTimelineMaxItems ?? DEFAULT_RESIDENT_TIMELINE_ITEMS;
    const maxBytes = this.#options.residentTimelineMaxBytes ?? DEFAULT_RESIDENT_TIMELINE_BYTES;
    // v3 snapshots already carry a validated <=48-item tail. Avoid cloning it
    // merely to prove it fits the default resident budget.
    if (
      force &&
      this.#model.timeline.length <= 64 &&
      this.#model.timeline.length <= maxItems &&
      approximateJsonBytes(this.#model.timeline) <= maxBytes
    ) return;
    const byteCheckThreshold = Math.max(
      1,
      Math.floor(maxBytes / RESIDENT_TIMELINE_CHECK_INTERVAL),
    );
    if (
      !force &&
      this.#residentEventsSinceCheck < RESIDENT_TIMELINE_CHECK_INTERVAL &&
      this.#residentWireBytesSinceCheck < byteCheckThreshold &&
      this.#model.timeline.length <= maxItems + RESIDENT_TIMELINE_CHECK_INTERVAL
    ) return;
    this.#residentEventsSinceCheck = 0;
    this.#residentWireBytesSinceCheck = 0;
    const bounded = boundResidentViewModel(this.#model, { maxItems, maxBytes });
    this.#model = bounded.model;
    this.#residentTimelineOmitted += bounded.omittedNow;
  }

  /** §18.16 snapshot cadence: event/byte thresholds plus one snapshot per completed turn. */
  async maybeSnapshot(force = false): Promise<boolean> {
    const cadence = this.#options.snapshotEveryEvents ?? DEFAULT_SNAPSHOT_EVERY_EVENTS;
    const byteCadence = this.#options.snapshotEveryBytes ?? DEFAULT_SNAPSHOT_EVERY_BYTES;
    const completedTurnDue =
      this.#pendingCompletedTurnId !== undefined &&
      this.#pendingCompletedTurnId !== this.#lastSnapshotTurnId;
    if (
      !force &&
      this.#sinceSnapshot < cadence &&
      this.#sinceSnapshotBytes < byteCadence &&
      !completedTurnDue
    ) return false;
    await this.flush();
    // A reducer can be ahead of the durable prefix after an append failure. Never
    // serialize that phantom state under an older journal sequence.
    if (this.#journalDegraded) return false;
    this.#boundResidentTimeline(true);
    const position: SessionHydrationPosition = {
      journalSequence: this.#lastJournalSequence,
      streamSequence: this.#sequencer.lastSequence,
    };
    let reducerState: Record<string, unknown>;
    try {
      reducerState = this.#options.serializeSnapshot?.(this.#model, position) ??
        serializeModel(this.#model);
    } catch {
      // An oversized/unsafe prompt capsule must never replace the last known-good
      // snapshot. The durable journal remains the fallback source of truth.
      return false;
    }
    const envelope = createSnapshotEnvelope({
      sessionId: this.#options.sessionId,
      ...position,
      reducerState,
    });
    await this.#options.transport.snapshot({
      ...envelope,
      // Compatibility alias for runtimes predating the explicit name.
      sequence: envelope.journalSequence,
    });
    this.#sinceSnapshot = 0;
    this.#sinceSnapshotBytes = 0;
    if (this.#pendingCompletedTurnId !== undefined) {
      this.#lastSnapshotTurnId = this.#pendingCompletedTurnId;
    }
    return true;
  }
}

function approximateJsonBytes(value: unknown): number {
  try {
    return JOURNAL_ENCODER.encode(JSON.stringify(value)).byteLength;
  } catch {
    return DEFAULT_RESIDENT_TIMELINE_BYTES;
  }
}

function validateHydrationPosition(position: SessionHydrationPosition): void {
  if (
    !Number.isSafeInteger(position.journalSequence) ||
    position.journalSequence < 0 ||
    !Number.isSafeInteger(position.streamSequence) ||
    position.streamSequence < position.journalSequence
  ) {
    throw new RangeError(
      "hydrate positions require streamSequence >= journalSequence >= 0",
    );
  }
}

function sequenceFromEventId(id: string): number | undefined {
  const match = /^evt_(\d+)(?:_|$)/.exec(id);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Serialize the view model for a snapshot row (§18.8). */
export function serializeModel(model: SessionViewModel): Record<string, unknown> {
  return {
    sessionId: model.sessionId,
    timeline: model.timeline,
    turnStatus: model.turnStatus,
    currentTurnId: model.currentTurnId,
    plan: model.plan,
    todo: model.todo,
    modeState: model.modeState,
    ...(model.deepPlan === undefined ? {} : { deepPlan: model.deepPlan }),
    ...(model.goalContract === undefined ? {} : { goalContract: model.goalContract }),
    ...(model.contextUsage === undefined ? {} : { contextUsage: model.contextUsage }),
    ...(model.contextPressure === undefined ? {} : { contextPressure: model.contextPressure }),
    contextGeneration: model.contextGeneration,
    usage: model.usage,
    live: model.live,
    awaitingTaskId: model.awaitingTaskId,
    taskLive: [...model.taskLive.entries()],
    pendingApproval: model.pendingApproval,
    notices: model.notices,
    lastSequence: model.lastSequence,
    modelId: model.modelId,
    reasoningEffort: model.reasoningEffort,
    permissionMode: model.permissionMode,
    permissionPreset: model.permissionPreset,
    contextUsedTokens: model.contextUsedTokens,
    contextBudgetTokens: model.contextBudgetTokens,
    changedFiles: [...model.changedFiles.entries()],
    turnCount: model.turnCount,
    cancelledTurns: model.cancelledTurns,
    compactedAt: model.compactedAt,
  };
}

export function deserializeModel(raw: unknown): SessionViewModel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.sessionId !== "string") return undefined;
  if (
    !Array.isArray(value.timeline) ||
    !value.timeline.every((item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).type === "string" &&
      typeof (item as Record<string, unknown>).id === "string" &&
      Number.isSafeInteger((item as Record<string, unknown>).sequence) &&
      ((item as Record<string, unknown>).sequence as number) >= 0
    )
  ) return undefined;
  if (value.plan !== undefined && !Array.isArray(value.plan)) return undefined;
  if (value.notices !== undefined && !Array.isArray(value.notices)) return undefined;
  if (value.live !== undefined && (typeof value.live !== "object" || value.live === null)) {
    return undefined;
  }
  if (value.usage !== undefined && (typeof value.usage !== "object" || value.usage === null)) {
    return undefined;
  }
  for (const field of [
    "lastSequence",
    "contextUsedTokens",
    "contextBudgetTokens",
    "turnCount",
    "cancelledTurns",
  ] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (!Number.isSafeInteger(candidate) || (candidate as number) < 0)
    ) return undefined;
  }
  for (const field of ["modelId", "reasoningEffort", "permissionMode"] as const) {
    const candidate = value[field];
    if (candidate !== undefined && typeof candidate !== "string") return undefined;
  }
  const modeState = parseModeState(value.modeState, value.permissionMode);
  const todo = parseTodoState(value.todo, value.plan);
  const contextUsage = parseContextUsage(value.contextUsage);
  const deepPlan = parseDeepPlanState(value.deepPlan);
  const goalContract = parseGoalContractView(value.goalContract);
  const base = emptyViewModel(value.sessionId);
  const changed = new Map<string, { additions: number; deletions: number }>();
  if (Array.isArray(value.changedFiles)) {
    for (const entry of value.changedFiles) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        changed.set(entry[0], entry[1] as { additions: number; deletions: number });
      }
    }
  }
  const taskLive = new Map<string, import("./reducer.ts").TaskLiveState>();
  if (Array.isArray(value.taskLive)) {
    for (const entry of value.taskLive) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        taskLive.set(entry[0], entry[1] as import("./reducer.ts").TaskLiveState);
      }
    }
  }
  const timeline = Array.isArray(value.timeline)
    ? value.timeline as SessionViewModel["timeline"]
    : [];
  const activeTasks = timeline.filter(
    (item): item is SessionViewModel["activeTasks"][number] =>
      item.type === "task" && ["queued", "running", "waiting"].includes(item.state),
  );
  const activeTools = timeline.filter(
    (item): item is SessionViewModel["activeTools"][number] =>
      item.type === "tool" && item.status === "running",
  );
  const activeJobs = timeline.filter(
    (item): item is SessionViewModel["activeJobs"][number] =>
      item.type === "job" && item.state === "running",
  );
  const pendingApproval = [...timeline].reverse().find(
    (item): item is NonNullable<SessionViewModel["pendingApproval"]> =>
      item.type === "approval" && item.decision === undefined,
  );
  return {
    ...base,
    ...(value as Partial<SessionViewModel>),
    timeline,
    changedFiles: changed,
    taskLive,
    activeTasks,
    activeTools,
    activeJobs,
    modeState,
    todo,
    plan: todo.items.map((item) => ({ ...item })),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(deepPlan === undefined ? { deepPlan: undefined } : { deepPlan }),
    ...(goalContract === undefined ? { goalContract: undefined } : { goalContract }),
    ...(pendingApproval !== undefined ? { pendingApproval } : { pendingApproval: undefined }),
  } as SessionViewModel;
}

function parseModeState(
  raw: unknown,
  legacyPermissionMode: unknown,
): import("./reducer.ts").SessionViewModel["modeState"] {
  if (typeof raw === "object" && raw !== null) {
    const value = raw as Record<string, unknown>;
    const selected = value.selected === "plan" || value.selected === "build" ? value.selected : undefined;
    const activeTurn = value.activeTurn === "plan" || value.activeTurn === "build" ? value.activeTurn : undefined;
    const pending = value.pending === "plan" || value.pending === "build" ? value.pending : undefined;
    const revision = typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
      ? value.revision
      : 0;
    if (selected !== undefined) {
      return {
        selected,
        ...(activeTurn === undefined ? {} : { activeTurn }),
        ...(pending === undefined ? {} : { pending }),
        revision,
      };
    }
  }
  return { selected: legacyPermissionMode === "plan" ? "plan" : "build", revision: 0 };
}

function parseTodoState(raw: unknown, legacyPlan: unknown): TodoListState {
  try {
    const value = raw === undefined
      ? undefined
      : typeof raw === "object" && raw !== null
        ? raw as Record<string, unknown>
        : (() => { throw new Error("persisted TODO state must be an object"); })();
    const rawItems = value === undefined
      ? Array.isArray(legacyPlan)
        ? legacyPlan as PlanItem[]
        : []
      : Array.isArray(value.items)
        ? value.items as PlanItem[]
        : (() => { throw new Error("persisted TODO items must be an array"); })();
    const items = normalizeTodoItems(rawItems, "");
    const document = value === undefined ? undefined : normalizePlanDocument(value.document as PlanDocument | undefined);
    const revision = value === undefined
      ? items.length > 0 ? 1 : 0
      : typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
        ? value.revision
        : (() => { throw new Error("persisted TODO revision is invalid"); })();
    const digest = planDigest(document, items);
    const rawApproval = value?.approval as Partial<PlanApproval> | undefined;
    const approvalRevision = rawApproval?.revision;
    const approval = rawApproval !== undefined && rawApproval.digest === digest &&
      typeof approvalRevision === "number" && Number.isSafeInteger(approvalRevision) &&
      approvalRevision >= 0 && approvalRevision <= revision &&
      typeof rawApproval.approvedAt === "string" &&
      (rawApproval.via === "shift_tab" || rawApproval.via === "slash" || rawApproval.via === "ui") &&
      (rawApproval.contextStrategy === "keep" || rawApproval.contextStrategy === "compact")
      ? rawApproval as PlanApproval
      : undefined;
    const approvedRevision = value?.approvedRevision;
    if (approvedRevision !== undefined &&
      (typeof approvedRevision !== "number" || !Number.isSafeInteger(approvedRevision) || approvedRevision < 0 || approvedRevision > revision)) {
      throw new Error("persisted TODO approval revision is invalid");
    }
    const modelMutationError = typeof value?.modelMutationError === "string"
      ? sanitizeTodoText(value.modelMutationError, 300)
      : value?.modelMutationError === undefined
        ? undefined
        : (() => { throw new Error("persisted TODO mutation error is invalid"); })();
    return {
      revision,
      ...(approval === undefined ? {} : { approval }),
      ...(approval === undefined || approvedRevision === undefined ? {} : { approvedRevision: approvedRevision as number }),
      ...(modelMutationError ? { modelMutationError } : {}),
      items,
      updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : "",
      ...(document === undefined ? {} : { document }),
    };
  } catch (error) {
    // Snapshot corruption must remain an explicit blocked obligation. Returning
    // an empty TODO list would let a restarted session pass the root completion gate.
    const detail = sanitizeTodoText(error instanceof Error ? error.message : String(error), 240);
    const now = "";
    return {
      revision: 0,
      items: [{
        id: "todo-hydration-error",
        text: "Repair the persisted TODO state before reporting completion",
        status: "blocked",
        kind: "analysis",
        blockedReason: `TODO state could not be restored safely: ${detail || "invalid persisted plan"}`,
        createdAt: now,
        updatedAt: now,
      }],
      updatedAt: now,
    };
  }
}

function parseContextUsage(raw: unknown): import("./context-usage.ts").ContextUsageSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.packId !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.capturedAt !== "string" ||
    !["estimated", "provider_reconciled", "resumed"].includes(String(value.source)) ||
    typeof value.categories !== "object" || value.categories === null
  ) return undefined;
  const categories = value.categories as Record<string, unknown>;
  if (!["system_prompt", "system_tools", "tool_io", "messages"].every((key) => typeof categories[key] === "number")) return undefined;
  const numeric = ["budgetTokens", "modelWindowTokens", "outputReserveTokens", "usedTokens", "freeTokens", "overageTokens", "cachedInputTokens"];
  if (!numeric.every((key) => typeof value[key] === "number")) return undefined;
  return value as unknown as import("./context-usage.ts").ContextUsageSnapshot;
}

export interface ResumeChecks {
  readonly workspaceExists: boolean;
  readonly gitHead?: string;
  readonly recordedGitHead?: string;
  readonly changedFiles?: string[];
  readonly configFingerprint?: string;
  readonly recordedConfigFingerprint?: string;
  readonly skillFingerprint?: string;
  readonly recordedSkillFingerprint?: string;
  readonly mcpFingerprint?: string;
  readonly recordedMcpFingerprint?: string;
  readonly modelAvailable: boolean;
  readonly unfinishedTransactions?: string[];
  readonly staleJobs?: string[];
  readonly integrity: IntegrityReport;
}

/** Produce the §18.11 resume warning list, used by AC-36 and AC-46. */
export function resumeWarnings(checks: ResumeChecks): ResumeWarning[] {
  const warnings: ResumeWarning[] = [];

  if (!checks.workspaceExists) {
    warnings.push({ kind: "workspace_missing", detail: "the recorded workspace path no longer exists" });
  }
  if (
    checks.gitHead !== undefined &&
    checks.recordedGitHead !== undefined &&
    checks.gitHead !== checks.recordedGitHead
  ) {
    warnings.push({
      kind: "git_head_changed",
      detail: `Git HEAD moved from ${checks.recordedGitHead.slice(0, 7)} to ${checks.gitHead.slice(0, 7)}`,
    });
  }
  if (checks.changedFiles && checks.changedFiles.length > 0) {
    warnings.push({
      kind: "file_changed",
      detail: `${checks.changedFiles.length} previously-read file${
        checks.changedFiles.length === 1 ? "" : "s"
      } changed on disk: ${checks.changedFiles.slice(0, 5).join(", ")}`,
    });
  }
  for (const [kind, current, recorded, label] of [
    ["config_fingerprint_changed", checks.configFingerprint, checks.recordedConfigFingerprint, "configuration"],
    ["skill_fingerprint_changed", checks.skillFingerprint, checks.recordedSkillFingerprint, "Skills"],
    ["mcp_fingerprint_changed", checks.mcpFingerprint, checks.recordedMcpFingerprint, "MCP servers"],
  ] as const) {
    if (current !== undefined && recorded !== undefined && current !== recorded) {
      warnings.push({ kind, detail: `${label} changed since this session was saved` });
    }
  }
  if (!checks.modelAvailable) {
    warnings.push({
      kind: "model_unavailable",
      detail: "the recorded model is not available with the current credential",
    });
  }
  if (checks.unfinishedTransactions && checks.unfinishedTransactions.length > 0) {
    warnings.push({
      kind: "unfinished_transaction",
      detail: `${checks.unfinishedTransactions.length} file transaction(s) were interrupted by a previous shutdown`,
    });
  }
  if (checks.staleJobs && checks.staleJobs.length > 0) {
    warnings.push({
      kind: "stale_job",
      detail: `${checks.staleJobs.length} background job(s) were interrupted by a previous shutdown`,
    });
  }
  if (!checks.integrity.ok) {
    warnings.push({
      kind: "journal_truncated",
      detail: `journal recovered up to sequence ${checks.integrity.lastValidSequence}: ${
        checks.integrity.breakDetail ?? "corruption detected"
      }`,
    });
  }
  return warnings;
}

function sanitizeThinkingExportText(value: string): string {
  // Keep provider-visible text, but remove terminal control sequences before it
  // crosses into a Markdown/export surface. Opaque reasoning never reaches this
  // function because it is intentionally absent from TimelineThinking.
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/g, "")
    .trim();
}

function escapeThinkingExportHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (character) =>
    character === "&" ? "&amp;" :
    character === "<" ? "&lt;" :
    character === ">" ? "&gt;" : "&quot;",
  );
}

/** Export a session as a markdown transcript (§8.6). */
export function exportMarkdown(model: SessionViewModel, manifest: SessionManifest): string {
  const lines: string[] = [
    `# ${manifest.title}`,
    "",
    `- Session: \`${manifest.id}\``,
    `- Workspace: \`${redactWorkspacePath(manifest.workspacePath)}\``,
    `- Model profile: ${manifest.modelProfile}`,
    `- Permission mode: ${manifest.permissionMode}`,
    ...(manifest.interactionMode === undefined ? [] : [`- Interaction mode: ${manifest.interactionMode}`]),
    ...(manifest.permissionPreset === undefined ? [] : [`- Permission preset: ${manifest.permissionPreset}`]),
    ...(manifest.planRevision === undefined ? [] : [`- TODO revision: ${manifest.planRevision}`]),
    `- Created: ${manifest.createdAt}`,
    `- Updated: ${manifest.updatedAt}`,
    "",
  ];

  if (model.todo.document !== undefined) {
    const document = model.todo.document;
    lines.push("## Plan Contract", "", `### Goal`, "", document.goal, "", "### Context", "", ...document.context.map((entry) => `- ${entry}`), "");
    if ((document.assumptions?.length ?? 0) > 0) lines.push("### Assumptions", "", ...(document.assumptions ?? []).map((entry) => `- ${entry}`), "");
    lines.push("### Critical files & anchors", "", ...document.criticalFiles.map((file) => `- \`${file.path}\`${[...(file.anchors ?? []), ...(file.anchor === undefined ? [] : [file.anchor]), ...(file.symbols ?? [])].length ? ` — ${[...(file.anchors ?? []), ...(file.anchor === undefined ? [] : [file.anchor]), ...(file.symbols ?? [])].join(", ")}` : ""}${file.reason ?? file.purpose ? ` — ${file.reason ?? file.purpose}` : ""}`), "");
    lines.push("### Verification", "", ...document.verification.map((check) => `- ${check.command ?? check.description ?? check.id ?? "check"}${check.expected ?? check.expectedResult ? ` → ${check.expected ?? check.expectedResult}` : ""}${check.evidence ? ` — ${check.evidence}` : ""}`), "");
    if ((document.externalActions?.length ?? 0) > 0) lines.push("### External actions", "", ...(document.externalActions ?? []).map((action) => `- ${action.server}/${action.tool}${action.description ?? action.reason ?? action.detail ? ` — ${action.description ?? action.reason ?? action.detail}` : ""}`), "");
    lines.push("### Risks", "", ...(document.risks.length > 0 ? document.risks.map((entry) => `- ${entry}`) : ["- None recorded"]), "", "### Rollback", "", ...(document.rollback.length > 0 ? document.rollback.map((entry) => `- ${entry}`) : ["- None recorded"]), "");
    if (model.todo.approval !== undefined) lines.push(`- Approval: **${model.todo.approval.digest}** (revision ${model.todo.approval.revision}, via ${model.todo.approval.via}, ${model.todo.approval.contextStrategy})`, "");
    lines.push("### Approach", "", ...model.todo.items.map((item) => `- [${item.status}] **${item.kind ?? "step"}** ${item.text}${item.files?.length ? ` — files: ${item.files.join(", ")}` : ""}${item.acceptanceCriteria?.length ? ` — acceptance: ${item.acceptanceCriteria.join("; ")}` : ""}`), "");
  }

  for (const item of model.timeline) {
    switch (item.type) {
      case "user":
        lines.push(`## User`, "", item.text, "");
        break;
      case "commentary":
        lines.push(`_${item.text}_`, "");
        break;
      case "thinking": {
        const title = item.title?.trim();
        const duration = item.durationMs !== undefined ? " · " + item.durationMs + "ms" : "";
        const summary = escapeThinkingExportHtml("Thought" + (title ? ": " + title : "") + duration);
        const body = escapeThinkingExportHtml(sanitizeThinkingExportText(item.detailText ?? item.summaryText ?? ""));
        lines.push(
          "<details>",
          "<summary>" + summary + "</summary>",
          ...(body.length > 0 ? ["", body] : []),
          "",
          "</details>",
          "",
        );
        break;
      }
      case "final":
        lines.push(`## Capybara`, "", item.text, "");
        if (item.report) {
          if (item.report.changedFiles.length > 0) {
            lines.push("### Changed", "");
            for (const f of item.report.changedFiles) {
              lines.push(`- \`${f.path}\` — ${f.purpose}`);
            }
            lines.push("");
          }
          if (item.report.verification.length > 0) {
            lines.push("### Verification", "");
            for (const v of item.report.verification) {
              lines.push(`- ${v.command ?? "check"}: **${v.status}** — ${v.evidence}`);
            }
            lines.push("");
          }
          if (item.report.risks.length > 0) {
            lines.push("### Risks", "");
            for (const r of item.report.risks) lines.push(`- ${r}`);
            lines.push("");
          }
        }
        break;
      case "tool":
        lines.push(
          `- \`${item.toolId}\` ${item.argumentsSummary} → **${item.status}**${
            item.summary ? ` — ${item.summary}` : ""
          }`,
        );
        break;
      case "task":
        lines.push(
          `- task \`${item.role}/${item.title}\` → **${item.state}**${
            item.summary ? ` — ${item.summary}` : ""
          }`,
        );
        break;
      case "approval":
        lines.push(
          `- approval \`${item.action}\` (${item.riskClass}) → **${item.decision ?? "pending"}**`,
        );
        break;
      default:
        break;
    }
  }

  lines.push(
    "",
    "## Usage",
    "",
    `- Input tokens: ${model.usage.inputTokens}`,
    `- Cached input tokens: ${model.usage.cachedInputTokens}`,
    `- Output tokens: ${model.usage.outputTokens}`,
    `- Reasoning tokens: ${model.usage.reasoningTokens}`,
    `- Estimated cost: $${model.usage.estimatedCostUsd.toFixed(4)} (estimate, not a billing source of truth)`,
  );
  if (model.todo.items.length > 0) {
    const done = model.todo.items.filter((item) => item.status === "done").length;
    lines.push("", "## TODO", "", `- Revision ${model.todo.revision}: ${done}/${model.todo.items.length} done`);
    for (const item of model.todo.items) lines.push(`- [${item.status}] ${item.text}`);
  }
  return lines.join("\n");
}

/**
 * A snapshot's goal verdict, or undefined when it is absent or malformed. Like
 * every other parser here this is fail-soft: a bad goal projection must not
 * discard an otherwise sound snapshot.
 */
function parseGoalContractView(raw: unknown): GoalContractView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.status !== "string" || typeof value.statement !== "string") return undefined;
  return {
    ...(typeof value.goalId === "string" ? { goalId: value.goalId } : {}),
    status: value.status,
    ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
    outstandingCriteria: Array.isArray(value.outstandingCriteria)
      ? value.outstandingCriteria.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(typeof value.nextTodoId === "string" ? { nextTodoId: value.nextTodoId } : {}),
    statement: value.statement,
  };
}
