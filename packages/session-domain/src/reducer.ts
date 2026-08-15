/**
 * Session reducer — PRD §20.8, §18.6–§18.11.
 *
 * The TUI renders a view model computed from events, never ad-hoc mutable
 * widgets. That single rule is what gives §20.8's benefits: deterministic replay,
 * crash recovery, golden TUI tests, headless JSONL reuse, and exact
 * event-to-UI traceability.
 */

import type { CbcEvent, CbcEventKind } from "@cbc/protocol";
import type { SessionModeState } from "./mode.ts";
import { createModeState } from "./mode.ts";
import type { ContextUsageSnapshot } from "./context-usage.ts";
import { reconcileContextUsageSnapshot } from "./context-usage.ts";
import { normalizePlanDocument, normalizeTodoItems, planDigest, sanitizeTodoText, todoTransitionAllowed, type PlanApproval, type PlanDocument, type PlanItem, type TodoListState } from "./todo.ts";

export type { PlanItem, TodoListState } from "./todo.ts";

export type TurnStatus =
  | "idle"
  | "preparing"
  | "sampling"
  | "tool_selection"
  | "awaiting_approval"
  | "executing"
  | "observing"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"
  | "partial";

type TerminalCompletionStatus = Extract<
  TurnStatus,
  "completed" | "partial" | "failed" | "cancelled"
>;

export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface TimelineUserMessage {
  readonly type: "user";
  readonly id: string;
  readonly sequence: number;
  readonly turnId?: string;
  readonly text: string;
  readonly timestamp: string;
}

export interface TimelineCommentary {
  readonly type: "commentary";
  readonly id: string;
  readonly sequence: number;
  /** Progress, reasoning disclosure, and candidate finals share a visual layer
   *  but stay distinct so stream semantics survive replay. `commentary` remains
   *  accepted for legacy journals. */
  readonly variant: "progress" | "reasoning" | "reasoning_summary" | "candidate_final" | "commentary";
  readonly text: string;
  /** Stable provider output identity, when supplied by the stream bridge. */
  readonly itemId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly correlationId?: string;
}

export interface TimelineFinal {
  readonly type: "final";
  readonly id: string;
  readonly sequence: number;
  /** The provider's user-facing answer; report remains structured evidence. */
  readonly answer?: string;
  readonly text: string;
  /** Stable provider output identity, when supplied by the stream bridge. */
  readonly itemId?: string;
  readonly report?: CompletionReportView;
  readonly agentId?: string;
  readonly turnId?: string;
  readonly correlationId?: string;
}

export interface TimelineToolDiscovery {
  readonly type: "tool_discovery";
  readonly id: string;
  readonly sequence: number;
  readonly query: string;
  readonly matches: Array<{ toolId: string; title: string; description: string; score: number }>;
  readonly activated: string[];
  readonly activeCount: number;
  readonly totalCount: number;
  readonly limit: number;
}

/**
 * One line of the inline mini-diff shown beside a write (§6.4, §6.10).
 *
 * A *preview*, not the diff: two to four lines so the reader can see what changed
 * without the timeline turning into a diff viewer. A full diff view remains
 * available when the complete change is needed.
 */
export interface TimelineDiffPreviewLine {
  readonly kind: "added" | "removed" | "context";
  readonly lineNumber?: number;
  readonly text: string;
}

export interface TimelineToolCall {
  readonly type: "tool";
  readonly id: string;
  readonly sequence: number;
  readonly callId: string;
  readonly toolId: string;
  readonly argumentsSummary: string;
  /**
   * The agent that issued the call. Absent or `root` for the parent; a subagent id
   * means the call is rendered inside that subagent's tree instead of at the top
   * level (§6.10), so the timeline shows delegated work as one grouped unit.
   */
  readonly agentId?: string;
  status: "running" | "succeeded" | "failed";
  summary?: string;
  durationMs?: number;
  errorCode?: string;
  artifacts?: string[];
  progress?: string;
  exitCode?: number;
  additions?: number;
  deletions?: number;
  diffPreview?: TimelineDiffPreviewLine[];
}

/**
 * A tool call attributed to a subagent, collected under its task card.
 *
 * Deliberately not a `TimelineToolCall`: these are not timeline items, they are
 * children of one. Keeping them off the top-level timeline is what lets a task
 * render as a single collapsible unit rather than interleaving its calls with the
 * parent's (§6.10).
 */
export interface TimelineSubagentEvent {
  readonly id: string;
  readonly sequence: number;
  readonly callId: string;
  readonly toolId: string;
  readonly argumentsSummary: string;
  status: "running" | "succeeded" | "failed";
  summary?: string;
  durationMs?: number;
  errorCode?: string;
  progress?: string;
  exitCode?: number;
  additions?: number;
  deletions?: number;
  artifacts?: string[];
  diffPreview?: TimelineDiffPreviewLine[];
}

export interface TimelineTask {
  readonly type: "task";
  readonly id: string;
  readonly sequence: number;
  readonly taskId: string;
  readonly role: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: string[];
  readonly contract: string[];
  readonly writeLease?: string[];
  /** §15.4: ids of the tasks whose output this one was given. */
  readonly dependencies?: string[];
  /** The model profile resolved for this child (§15.2), shown on the card. */
  readonly modelId?: string;
  state: TaskState;
  summary?: string;
  childCount: number;
  awaitInterrupted: boolean;
  durationMs?: number;
  /** Timestamp when the subagent task was created/started for elapsed duration. */
  startTimeMs?: number;
  /** Accumulated tokens consumed by this subagent. */
  tokens?: number;
  /** Latest progress line, shown in the §6.21 sidebar while the child runs. */
  progress?: string;
  /** Tool calls this subagent made, in order, for the §6.10 tree. */
  subagentEvents: TimelineSubagentEvent[];
  /** Total child calls observed, including calls evicted from the resident detail list. */
  subagentEventCount?: number;
  /** Completed child calls omitted to keep long-running task cards memory-bounded. */
  subagentEventsOmitted?: number;
}

export interface TimelineApproval {
  readonly type: "approval";
  readonly id: string;
  readonly sequence: number;
  readonly approvalId: string;
  readonly action: string;
  readonly display: string;
  readonly cwd?: string;
  readonly riskClass: string;
  readonly reason: string;
  readonly network: boolean;
  readonly sideEffects: string[];
  decision?: string;
  decisionReason?: string;
}

export interface TimelineDiff {
  readonly type: "diff";
  readonly id: string;
  readonly sequence: number;
  readonly files: Array<{ path: string; additions: number; deletions: number; purpose?: string }>;
  readonly additions: number;
  readonly deletions: number;
}

export interface TimelineNotice {
  readonly type: "notice";
  readonly id: string;
  readonly sequence: number;
  readonly level: "info" | "success" | "warning" | "error";
  readonly text: string;
  readonly icon?: string;
}

export interface TimelinePlan {
  readonly type: "plan";
  readonly id: string;
  readonly sequence: number;
  items: PlanItem[];
  document?: PlanDocument;
  approval?: PlanApproval;
  digest?: string;
}

export interface TimelineJob {
  readonly type: "job";
  readonly id: string;
  readonly sequence: number;
  readonly jobId: string;
  readonly display: string;
  state: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  durationMs?: number;
  artifactId?: string;
  summary?: string;
}

/** Recent completed child calls retained per task; running calls stay pinned. */
export const MAX_RESIDENT_SUBAGENT_EVENTS = 32;
/** Global banners are advisory; retain a bounded recent window in long sessions. */
export const MAX_RESIDENT_NOTICES = 128;

export type TimelineItem =
  | TimelineUserMessage
  | TimelineCommentary
  | TimelineFinal
  | TimelineToolDiscovery
  | TimelineToolCall
  | TimelineTask
  | TimelineApproval
  | TimelineDiff
  | TimelineNotice
  | TimelinePlan
  | TimelineJob;

export interface CompletionReportView {
  status: "completed" | "partial" | "failed" | "cancelled";
  summary: string;
  changedFiles: Array<{ path: string; additions?: number; deletions?: number; purpose: string }>;
  verification: Array<{ command?: string; status: "passed" | "failed" | "not_run"; evidence: string }>;
  delegatedTasks: Array<{ id: string; role: string; status: string; summary: string }>;
  risks: string[];
  nextStep?: string;
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
}

/** The live state line described in §6.12. */
export interface LiveState {
  readonly kind:
    | "idle"
    | "working"
    | "awaiting_approval"
    | "waiting_for_task"
    | "running_tests"
    | "complete"
    | "partial"
    | "cancelled"
    | "failed";
  readonly label: string;
  readonly interruptHint?: string;
}

/** Ephemeral child text for the task drawer; never projected into the root lane. */
export interface TaskLiveState {
  readonly taskId: string;
  readonly turnId?: string;
  readonly phase: "progress" | "reasoning" | "reasoning_summary" | "candidate_final" | "final" | "commentary";
  readonly itemId: string;
  readonly text: string;
  readonly provisional: boolean;
}

/**
 * Projected token-saving state: which level the user asked for, which level is
 * actually in force after risk/repair relaxation, and why they differ.
 */
export interface TokenSavingViewState {
  readonly requestedLevel: string;
  readonly effectiveLevel: string;
  readonly ponytail: string;
  readonly responseStyle: string;
  readonly targetInputTokens?: number;
  readonly explorationCeiling?: number;
  readonly localCompactionRatio?: number;
  readonly reasons: readonly string[];
}

export interface SessionViewModel {
  readonly sessionId: string;
  readonly timeline: TimelineItem[];
  readonly turnStatus: TurnStatus;
  readonly currentTurnId?: string;
  readonly plan: PlanItem[];
  readonly todo: TodoListState;
  readonly modeState: SessionModeState;
  readonly contextUsage?: ContextUsageSnapshot;
  readonly usage: UsageTotals;
  readonly live: LiveState;
  /** The exact child wait currently owned by root, independent of running tasks. */
  readonly awaitingTaskId?: string;
  /** Live child output belongs to the task drawer, not the root timeline. */
  readonly taskLive: ReadonlyMap<string, TaskLiveState>;
  readonly activeTasks: TimelineTask[];
  readonly activeTools: TimelineToolCall[];
  readonly activeJobs: TimelineJob[];
  readonly pendingApproval?: TimelineApproval;
  readonly changedFiles: Map<string, { additions: number; deletions: number }>;
  readonly lastSequence: number;
  readonly compactedAt?: number;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly permissionMode: string;
  readonly permissionPreset?: string;
  readonly contextUsedTokens: number;
  readonly contextBudgetTokens: number;
  readonly notices: TimelineNotice[];
  readonly turnCount: number;
  readonly cancelledTurns: number;
  /** Latest token-saving projection; absent until the feature reports once. */
  readonly tokenSaving?: TokenSavingViewState;
}

export function emptyViewModel(sessionId: string, budgetTokens = 96_000): SessionViewModel {
  return {
    sessionId,
    timeline: [],
    turnStatus: "idle",
    plan: [],
    todo: { revision: 0, items: [], updatedAt: "" },
    modeState: createModeState(),
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    },
    live: { kind: "idle", label: "" },
    taskLive: new Map(),
    activeTasks: [],
    activeTools: [],
    activeJobs: [],
    changedFiles: new Map(),
    lastSequence: 0,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "medium",
    permissionMode: "auto-review",
    contextUsedTokens: 0,
    contextBudgetTokens: budgetTokens,
    notices: [],
    turnCount: 0,
    cancelledTurns: 0,
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface CallLocation {
  readonly timelineIndex: number;
  readonly childIndex?: number;
}

/**
 * Advisory append-only indexes kept outside the public immutable model.
 *
 * Maps are shared across a model lineage and only ever gain locations. Every
 * lookup validates the item at that location and falls back to a reverse scan,
 * so reducing an older/branched model remains correct even after a descendant
 * populated the cache.
 */
interface TimelineIndexes {
  readonly tasks: Map<string, number>;
  readonly calls: Map<string, CallLocation>;
  readonly jobs: Map<string, number>;
  readonly approvals: Map<string, number>;
}

const MODEL_TIMELINE_INDEXES = new WeakMap<SessionViewModel, TimelineIndexes>();

function timelineIndexesFor(model: SessionViewModel): TimelineIndexes {
  const cached = MODEL_TIMELINE_INDEXES.get(model);
  if (cached !== undefined) return cached;
  const indexes: TimelineIndexes = {
    tasks: new Map(),
    calls: new Map(),
    jobs: new Map(),
    approvals: new Map(),
  };
  for (let timelineIndex = 0; timelineIndex < model.timeline.length; timelineIndex += 1) {
    const item = model.timeline[timelineIndex];
    if (item === undefined) continue;
    if (item.type === "task") {
      indexes.tasks.set(item.taskId, timelineIndex);
      for (let childIndex = 0; childIndex < item.subagentEvents.length; childIndex += 1) {
        const child = item.subagentEvents[childIndex];
        if (child !== undefined) indexes.calls.set(child.callId, { timelineIndex, childIndex });
      }
    } else if (item.type === "tool") {
      indexes.calls.set(item.callId, { timelineIndex });
    } else if (item.type === "job") {
      indexes.jobs.set(item.jobId, timelineIndex);
    } else if (item.type === "approval") {
      indexes.approvals.set(item.approvalId, timelineIndex);
    }
  }
  MODEL_TIMELINE_INDEXES.set(model, indexes);
  return indexes;
}

function appendResidentNotice(
  notices: readonly TimelineNotice[],
  entry: TimelineNotice,
): TimelineNotice[] {
  const retained = Math.max(0, MAX_RESIDENT_NOTICES - 1);
  return [...notices.slice(Math.max(0, notices.length - retained)), entry];
}

function payloadOf<T = Record<string, unknown>>(event: CbcEvent): T {
  return (event.payload ?? {}) as T;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Only terminal report states may be projected from a `turn.completed` event. */
function terminalCompletionStatus(value: unknown): TerminalCompletionStatus {
  switch (value) {
    case "partial":
    case "failed":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isInteractionModeValue(value: unknown): value is "build" | "plan" {
  return value === "build" || value === "plan";
}

function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.packId !== "string" ||
    typeof record.modelId !== "string" ||
    !["estimated", "provider_reconciled", "resumed"].includes(String(record.source)) ||
    typeof record.categories !== "object" ||
    record.categories === null
  ) return false;
  const categories = record.categories as Record<string, unknown>;
  return ["system_prompt", "system_tools", "tool_io", "messages"].every(
    (key) => typeof categories[key] === "number" && Number.isFinite(categories[key]),
  ) &&
    ["budgetTokens", "modelWindowTokens", "outputReserveTokens", "usedTokens", "freeTokens", "overageTokens", "cachedInputTokens"]
      .every((key) => typeof record[key] === "number" && Number.isFinite(record[key])) &&
    typeof record.capturedAt === "string";
}

const TASK_STATES: readonly TaskState[] = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "blocked",
];

function asTaskState(value: unknown): TaskState | undefined {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value)
    ? (value as TaskState)
    : undefined;
}

/**
 * Apply one event. Pure with respect to the input model: a new object is
 * returned so replaying the same events always yields the same state (§25.4
 * "journal replay yields same state as incremental reducer").
 */
export function reduce(model: SessionViewModel, event: CbcEvent): SessionViewModel {
  // assistant.delta is ephemeral and only updates the live indicator below. A
  // full deep clone of a long timeline for every streamed token makes the UI
  // visibly lag behind the provider, so keep this hot path shallow and leave
  // durable timeline events on the defensive clone path.
  const indexes = timelineIndexesFor(model);
  const next = event.kind === "assistant.delta" ? cloneEphemeralModel(model) : cloneModel(model);
  next.lastSequence = Math.max(next.lastSequence, event.sequence);

  switch (event.kind) {
    case "session.started":
    case "session.resumed": {
      const p = payloadOf(event);
      if (typeof p.modelId === "string") next.modelId = p.modelId;
      if (typeof p.reasoningEffort === "string") next.reasoningEffort = p.reasoningEffort;
      if (typeof p.permissionMode === "string") next.permissionMode = p.permissionMode;
      if (typeof p.contextBudgetTokens === "number") {
        next.contextBudgetTokens = p.contextBudgetTokens;
      }
      if (isInteractionModeValue(p.interactionMode)) {
        next.modeState = {
          ...next.modeState,
          selected: p.interactionMode,
          revision: num(p.modeRevision, next.modeState.revision),
        };
      } else if (p.permissionMode === "plan") {
        next.modeState = { ...next.modeState, selected: "plan" };
      }
      if (isContextUsageSnapshot(p.contextUsage)) next.contextUsage = p.contextUsage;
      if (event.kind === "session.resumed") {
        next.notices = appendResidentNotice(
          next.notices,
          notice(event, "info", str(p.detail, "Session resumed."), "●"),
        );
        next.timeline.push(notice(event, "info", str(p.detail, "Session resumed."), "●"));
      }
      break;
    }

    case "session.forked": {
      const text = `Session forked from ${str(payloadOf(event).parentSessionId, "unknown")}.`;
      next.timeline.push(notice(event, "info", text, "●"));
      break;
    }

    case "session.compacted": {
      const p = payloadOf(event);
      next.compactedAt = event.sequence;
      next.contextUsedTokens = num(p.tokensAfter, next.contextUsedTokens);
      next.timeline.push(
        notice(
          event,
          "info",
          `Context compacted: ${num(p.tokensBefore)} → ${num(p.tokensAfter)} tokens`,
          "●",
        ),
      );
      break;
    }

    case "turn.started": {
      const p = payloadOf(event);
      // `exactOptionalPropertyTypes` forbids writing `undefined` into an
      // optional field; a turn without an id clears the pointer instead of
      // leaving the previous turn's id behind as stale state.
      if (event.turnId !== undefined) {
        next.currentTurnId = event.turnId;
      } else {
        delete next.currentTurnId;
      }
      next.turnStatus = "preparing";
      next.turnCount += 1;
      if (typeof p.model === "string") next.modelId = p.model;
      if (typeof p.permissionMode === "string") next.permissionMode = p.permissionMode;
      const turnMode = isInteractionModeValue(p.interactionMode)
        ? p.interactionMode
        : next.modeState.selected;
      next.modeState = { ...next.modeState, activeTurn: turnMode };
      const reasoning = p.reasoning as { effort?: string } | undefined;
      if (reasoning?.effort) next.reasoningEffort = reasoning.effort;
      // Show the model phase immediately, even before the first provider delta
      // arrives. This keeps the UI responsive while the request is preparing or
      // waiting behind a busy provider.
      next.live = { kind: "working", label: "Thinking...", interruptHint: "esc" };
      delete next.awaitingTaskId;
      break;
    }

    case "turn.completed": {
      const p = payloadOf(event);
      const status = terminalCompletionStatus(p.status);
      next.turnStatus = status;
      const changed = next.changedFiles.size;
      const tests = p.tests as { passed?: number; failed?: number } | undefined;
      const label =
        status === "completed"
          ? "Turn complete"
          : status === "partial"
            ? "Turn paused"
            : status === "failed"
              ? "Turn failed"
              : "Turn cancelled";
      const parts = [label];
      if (changed > 0) parts.push(`${changed} file${changed === 1 ? "" : "s"} changed`);
      if (tests && typeof tests.passed === "number") {
        parts.push(`${tests.passed} tests passed`);
      }
      if (status === "completed") {
        next.live = { kind: "complete", label: parts.join(" · ") };
      } else {
        const liveKind: LiveState["kind"] =
          status === "partial"
            ? "partial"
            : status === "failed"
              ? "failed"
              : "cancelled";
        next.live = { kind: liveKind, label: parts.join(" \u00b7 ") };
      }
      delete next.awaitingTaskId;
      const { activeTurn: _activeTurn, ...idleModeState } = next.modeState;
      next.modeState = idleModeState;
      break;
    }

    case "turn.cancelled": {
      next.turnStatus = "cancelled";
      next.cancelledTurns += 1;
      next.live = { kind: "cancelled", label: "Cancelled" };
      delete next.awaitingTaskId;
      const { activeTurn: _activeTurn, ...idleModeState } = next.modeState;
      next.modeState = idleModeState;
      break;
    }

    case "turn.interrupted": {
      next.turnStatus = "observing";
      next.timeline.push(
        notice(event, "warning", str(payloadOf(event).reason, "Turn interrupted"), "!"),
      );
      break;
    }

    case "user.message": {
      const p = payloadOf(event);
      if (typeof p.reasoningEffort === "string") next.reasoningEffort = p.reasoningEffort;
      next.timeline.push({
        type: "user",
        id: event.id,
        sequence: event.sequence,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        text: str(p.text),
        timestamp: event.timestamp,
      });
      break;
    }

    case "assistant.delta": {
      const payload = payloadOf(event);
      const phase =
        payload.phase === "progress" ||
        payload.phase === "reasoning" ||
        payload.phase === "reasoning_summary" ||
        payload.phase === "candidate_final" ||
        payload.phase === "final" ||
        payload.phase === "commentary"
          ? payload.phase
          : "candidate_final";
      const agentId = event.agentId ?? "root";
      if (agentId !== "root" && agentId.length > 0) {
        const previous = next.taskLive.get(agentId);
        const itemId = str(payload.itemId, event.correlationId ?? phase);
        const sameSpan =
          previous !== undefined &&
          previous.turnId === event.turnId &&
          previous.phase === phase &&
          previous.itemId === itemId;
        const taskLive = new Map(next.taskLive);
        taskLive.set(agentId, {
          taskId: agentId,
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          phase,
          itemId,
          text: (sameSpan ? previous.text : "") + str(payload.text),
          provisional: (sameSpan && previous.provisional) || payload.provisional === true,
        });
        next.taskLive = taskLive;
        break;
      }
      // An explicit root scope is an ownership marker from the provider. It
      // updates the root sampling state without replacing the turn-level label.
      // Unscoped legacy deltas below still expose their phase-specific label.
      if (event.agentId === "root") {
        next.turnStatus = "sampling";
        // The explicit root final envelope owns the answer-writing phase. Keep
        // reasoning/commentary revisions on the turn banner established by the
        // turn start so child/root ownership cannot overwrite it spuriously.
        if (phase === "final") {
          next.live = { kind: "working", label: "Writing...", interruptHint: "esc" };
        }
        break;
      }
      // Candidate-final text is visible in the timeline itself. Keeping this
      // live label empty avoids a second provisional "Writing final answer"
      // banner in the frame chrome.
      const label =
        phase === "candidate_final" || phase === "final"
          ? ""
          : phase === "reasoning"
            ? "Thinking..."
            : phase === "reasoning_summary"
              ? "Reasoning summary..."
              : "Working...";
      next.turnStatus = "sampling";
      next.live = { kind: "working", label, interruptHint: "esc" };
      break;
    }

    case "assistant.commentary":
    case "assistant.reasoning":
    case "assistant.reasoning_summary": {
      const payload = payloadOf(event);
      if (typeof payload.reasoningEffort === "string") next.reasoningEffort = payload.reasoningEffort;
      if (event.agentId !== undefined && event.agentId !== "root" && event.agentId.length > 0) {
        clearTaskLive(next, event.agentId);
        break;
      }
      const text = str(payload.text);
      const itemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
      // Repeated wording is legitimate. Only a repeated provider item can be
      // coalesced, and only when it is adjacent in the durable journal.
      const variant =
        event.kind === "assistant.commentary"
          ? "commentary"
          : event.kind === "assistant.reasoning" ? "reasoning" : "reasoning_summary";
      const lastItem = next.timeline.at(-1);
      if (
        itemId !== undefined &&
        lastItem?.type === "commentary" &&
        lastItem.itemId === itemId &&
        lastItem.variant === variant &&
        lastItem.turnId === event.turnId &&
        lastItem.agentId === event.agentId
      ) {
        break;
      }
      next.timeline.push({
        type: "commentary",
        id: event.id,
        sequence: event.sequence,
        // Durable journals retain the legacy commentary name; the live stream uses
        // `progress` while rendering gives both the same semantic presentation.
        variant,
        text,
        ...(itemId !== undefined ? { itemId } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
      });
      next.turnStatus = "sampling";
      break;
    }

    case "assistant.final": {
      const finalAgentId = event.agentId;
      if (finalAgentId !== undefined && finalAgentId !== "root" && finalAgentId.length > 0) {
        clearTaskLive(next, finalAgentId);
        break;
      }
      const p = payloadOf(event);
      const finalText = str(p.text);
      const answer = str(p.answer);
      // Do not remove a preceding commentary item by matching its text. Repeated
      // phrases are valid separate events; live/durable replacement is handled by
      // the UI's provider item identity bridge instead.
      const item: Mutable<TimelineFinal> = {
        type: "final",
        id: event.id,
        sequence: event.sequence,
        text: finalText,
        ...(typeof p.itemId === "string" ? { itemId: p.itemId } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
      };
      if (answer.length > 0) item.answer = answer;
      if (p.report) item.report = p.report as CompletionReportView;
      next.timeline.push(item as TimelineFinal);
      next.turnStatus = "verifying";
      break;
    }

    case "plan.created":
    case "plan.updated": {
      const payload = payloadOf(event);
      const rawSource = payload.source;
      const source = rawSource === undefined
        ? "migration"
        : rawSource === "model" || rawSource === "user" || rawSource === "migration"
          ? rawSource
          : undefined;
      const previousRevision = next.todo.revision;
      let revision = previousRevision + 1;
      let items: PlanItem[] = [];
      let document: PlanDocument | undefined;
      let hydrationFailed = false;
      try {
        if (source === undefined) throw new Error("Plan source is invalid");
        if (payload.revision !== undefined) {
          if (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 0) {
            throw new Error("Plan revision is invalid");
          }
          revision = Number(payload.revision);
        }
        if (revision < previousRevision) throw new Error("Plan revision cannot move backwards");
        if (!Array.isArray(payload.items)) throw new Error("Plan items must be an array");
        items = normalizeTodoItems(payload.items as PlanItem[], event.timestamp);
        const previousById = new Map(next.todo.items.map((item) => [item.id, item]));
        if (items.filter((item) => item.status === "active").length > 1) {
          throw new Error("only one root TODO may be active");
        }
        if (items.some((item) => !todoTransitionAllowed(previousById.get(item.id), item))) {
          throw new Error("TODO transition requires an explicit reopen or completion step");
        }
        // Only an explicit user repair may remove unfinished work. Missing or
        // legacy source metadata is treated as migration, never as permission
        // to clear the completion obligation.
        if (source !== "user") {
          const nextIds = new Set(items.map((item) => item.id));
          const removedUnfinished = next.todo.items.filter((item) => item.status !== "done" && !nextIds.has(item.id));
          if (removedUnfinished.length > 0) {
            throw new Error(`plan update cannot remove unfinished item(s): ${removedUnfinished.map((item) => item.id).join(", ")}`);
          }
        }
        document = normalizePlanDocument(payload.document as PlanDocument | undefined);
      } catch (error) {
        hydrationFailed = true;
        // Journal replay must never turn malformed plan bytes into executable state.
        // Preserve an explicit blocked obligation instead of resetting to an empty
        // list: an empty list would fail open in the root completion gate.
        const detail = String(error instanceof Error ? error.message : error).replace(/\s+/gu, " ").slice(0, 240);
        items = [{
          id: "todo-hydration-error",
          text: "Repair the persisted TODO state before reporting completion",
          status: "blocked",
          kind: "analysis",
          blockedReason: `TODO state could not be restored safely: ${detail || "invalid persisted plan"}`,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }];
        document = undefined;
        // A malformed or stale event must not roll the durable revision back.
        revision = previousRevision;
      }
      next.plan = items.map((i) => ({ ...i }));
      const rawApproval = payload.approval as PlanApproval | undefined;
      // Progress updates may omit approval metadata in older journals. Preserve
      // the prior approval only when its digest still covers the new scope.
      const candidateApproval = hydrationFailed
        ? undefined
        : rawApproval === undefined ? next.todo.approval : rawApproval;
      const approval = candidateApproval !== undefined && typeof candidateApproval.digest === "string" && candidateApproval.digest === planDigest(document, items) && Number.isSafeInteger(candidateApproval.revision) && candidateApproval.revision >= 0 && candidateApproval.revision <= revision && typeof candidateApproval.approvedAt === "string" && ["shift_tab", "slash", "ui"].includes(candidateApproval.via) && ["keep", "compact"].includes(candidateApproval.contextStrategy)
        ? candidateApproval
        : undefined;
      const payloadApprovedRevision = !hydrationFailed && Number.isSafeInteger(payload.approvedRevision) && Number(payload.approvedRevision) >= 0 && Number(payload.approvedRevision) <= Math.max(0, revision)
        ? Number(payload.approvedRevision)
        : undefined;
      const approvedRevision = payloadApprovedRevision
        ?? approval?.revision
        ?? (!hydrationFailed && next.todo.approvedRevision === revision ? next.todo.approvedRevision : undefined);
      next.todo = {
        revision: Math.max(0, revision),
        ...(approvedRevision === undefined ? {} : { approvedRevision }),
        items: next.plan.map((item) => ({ ...item })),
        updatedAt: event.timestamp,
        ...(document === undefined ? {} : { document }),
        ...(approval === undefined ? {} : { approval }),
      };
      // Keep every plan snapshot at the sequence where it was produced. Updating
      // the first plan item in place made a later response jump back to the top of
      // the conversation, which broke the same chronological reading used by tool
      // results and assistant commentary.
      next.timeline.push({
        type: "plan",
        id: event.id,
        sequence: event.sequence,
        items: next.plan.map((i) => ({ ...i })),
        ...(document === undefined ? {} : { document }),
        ...(approval === undefined ? {} : { approval }),
        ...(typeof payload.digest === "string" ? { digest: payload.digest } : {}),
      });
      break;
    }

    case "plan.approved": {
      const revision = num(payloadOf(event).revision, next.todo.revision);
      const p = payloadOf(event);
      const rawApproval = (p.approval ?? p) as PlanApproval | undefined;
      const approval = rawApproval !== undefined && typeof rawApproval.digest === "string" && rawApproval.digest === planDigest(next.todo.document, next.todo.items) && revision >= 0 && revision <= next.todo.revision && rawApproval.revision === revision && Number.isSafeInteger(rawApproval.revision) && rawApproval.revision >= 0 && typeof rawApproval.approvedAt === "string" && ["shift_tab", "slash", "ui"].includes(rawApproval.via) && ["keep", "compact"].includes(rawApproval.contextStrategy)
        ? rawApproval
        : undefined;
      const { approval: _previousApproval, approvedRevision: _previousApprovedRevision, ...todoWithoutApproval } = next.todo;
      next.todo = {
        ...todoWithoutApproval,
        ...(approval === undefined ? {} : { approvedRevision: revision, approval }),
        updatedAt: event.timestamp,
      };
      if (approval !== undefined) {
        // Approval is a state transition, not a new plan snapshot. Annotate the
        // rendered snapshots so the timeline can switch from the verbose contract
        // lens to the compact TODO projection without rewriting journal history.
        const latestPlanIndex = next.timeline.reduce(
          (latest, item, index) => item.type === "plan" ? index : latest,
          -1,
        );
        if (latestPlanIndex >= 0) {
          next.timeline = next.timeline.map((item, index) => index === latestPlanIndex
            ? { ...item, approval, digest: approval.digest }
            : item);
        }
      }
      break;
    }

    case "mode.changed": {
      const p = payloadOf(event);
      const target = isInteractionModeValue(p.to) ? p.to : undefined;
      if (target === undefined) break;
      const effectiveAt = p.effectiveAt;
      const revision = num(p.revision, next.modeState.revision + 1);
      if (effectiveAt === "next_turn" || effectiveAt === "after_quiescence") {
        next.modeState = {
          ...next.modeState,
          pending: target,
          ...(Array.isArray(p.blockers)
            ? { blockers: p.blockers as NonNullable<SessionModeState["blockers"]> }
            : {}),
          revision,
        };
      } else {
        next.modeState = {
          selected: target,
          ...(next.modeState.activeTurn !== undefined ? { activeTurn: next.modeState.activeTurn } : {}),
          revision,
        };
      }
      break;
    }

    case "permission.changed": {
      const to = payloadOf(event).to;
      if (typeof to === "string") next.permissionPreset = to;
      break;
    }

    case "token_saving.changed": {
      const p = payloadOf(event);
      const to = str(p.to);
      if (to.length === 0) break;
      const prior = next.tokenSaving;
      next.tokenSaving = {
        requestedLevel: to,
        effectiveLevel: prior !== undefined && prior.requestedLevel === to
          ? prior.effectiveLevel
          : to,
        ponytail: prior?.ponytail ?? "off",
        responseStyle: prior?.responseStyle ?? "normal",
        reasons: prior !== undefined && prior.requestedLevel === to ? prior.reasons : [],
      };
      break;
    }

    case "token_saving.policy_applied":
    case "token_saving.relaxed": {
      const p = payloadOf(event);
      const requested = str(p.requestedLevel);
      const effective = str(p.effectiveLevel, requested);
      if (effective.length === 0) break;
      next.tokenSaving = {
        requestedLevel: requested.length > 0 ? requested : effective,
        effectiveLevel: effective,
        ponytail: str(p.ponytail, "off"),
        responseStyle: str(p.responseStyle, "normal"),
        ...(typeof p.targetInputTokens === "number"
          ? { targetInputTokens: p.targetInputTokens }
          : {}),
        ...(typeof p.explorationCeiling === "number"
          ? { explorationCeiling: p.explorationCeiling }
          : {}),
        ...(typeof p.localCompactionRatio === "number"
          ? { localCompactionRatio: p.localCompactionRatio }
          : {}),
        reasons: strArray(p.reasons),
      };
      break;
    }

    case "context.pack_compiled": {
      const snapshot = payloadOf(event).contextUsage;
      if (isContextUsageSnapshot(snapshot)) next.contextUsage = snapshot;
      const tokens = num(payloadOf(event).totalInputTokens, next.contextUsedTokens);
      if (tokens > 0) next.contextUsedTokens = tokens;
      break;
    }

    case "tool.discovery": {
      const p = payloadOf(event);
      next.timeline.push({
        type: "tool_discovery",
        id: event.id,
        sequence: event.sequence,
        query: str(p.query),
        matches: Array.isArray(p.matches)
          ? (p.matches as TimelineToolDiscovery["matches"])
          : [],
        activated: strArray(p.activated),
        activeCount: num(p.activeCount),
        totalCount: num(p.totalCount),
        limit: num(p.limit, 10),
      });
      next.turnStatus = "tool_selection";
      break;
    }

    case "tool.started": {
      const p = payloadOf(event);
      const owner = subagentOwner(next.timeline, event, indexes);

      // §6.10: a delegated call belongs to its task's tree, not to the parent's
      // timeline. Routing it here rather than filtering at render time keeps the
      // view model the single description of what the screen shows.
      if (owner !== undefined) {
        const callId = str(p.callId);
        owner.subagentEvents.push({
          id: event.id,
          sequence: event.sequence,
          callId,
          toolId: str(p.toolId),
          argumentsSummary: str(p.display, summarizeArgs(p.arguments)),
          status: "running",
        });
        owner.subagentEventCount = (owner.subagentEventCount ?? owner.subagentEvents.length - 1) + 1;
        owner.state = "running";
        const timelineIndex = indexes.tasks.get(owner.taskId);
        if (timelineIndex !== undefined) {
          indexes.calls.set(callId, {
            timelineIndex,
            childIndex: owner.subagentEvents.length - 1,
          });
          trimResidentSubagentEvents(owner, timelineIndex, indexes);
        }
      } else {
        const timelineIndex = next.timeline.length;
        const callId = str(p.callId);
        next.timeline.push({
          type: "tool",
          id: event.id,
          sequence: event.sequence,
          callId,
          toolId: str(p.toolId),
          argumentsSummary: str(p.display, summarizeArgs(p.arguments)),
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
          status: "running",
        });
        indexes.calls.set(callId, { timelineIndex });
      }

      next.turnStatus = "executing";
      next.live = { kind: "working", label: `Running ${str(p.toolId)}...`, interruptHint: "esc" };
      break;
    }

    case "tool.progress": {
      const p = payloadOf(event);
      const call = findCall(next.timeline, str(p.callId), indexes);
      if (call) call.progress = str(p.text);
      break;
    }

    case "tool.completed": {
      const p = payloadOf(event);
      const call = findCall(next.timeline, str(p.callId), indexes);
      if (call) {
        call.status = "succeeded";
        call.summary = str(p.summary);
        call.durationMs = num(p.durationMs);
        const artifacts = strArray(p.artifacts);
        if (artifacts.length > 0) call.artifacts = artifacts;
        applyCallDetail(call, p);
        delete call.progress;
        trimTaskContainingCall(next.timeline, str(p.callId), indexes);
      }
      // A valid TODO write (including an explicit no-op repair) resolves the
      // durable marker created by the corresponding rejected tool.failed event.
      if ((event.agentId === undefined || event.agentId === "root") && p.toolId === "todo.write" && next.todo.modelMutationError !== undefined) {
        const { modelMutationError: _modelMutationError, ...withoutMutationError } = next.todo;
        next.todo = withoutMutationError;
      }
      next.turnStatus = "observing";
      break;
    }

    case "tool.failed": {
      const p = payloadOf(event);
      const call = findCall(next.timeline, str(p.callId), indexes);
      if (call) {
        call.status = "failed";
        call.summary = str(p.message, str(p.summary));
        call.errorCode = str(p.code);
        call.durationMs = num(p.durationMs);
        applyCallDetail(call, p);
        delete call.progress;
        trimTaskContainingCall(next.timeline, str(p.callId), indexes);
      }
      // A rejected TODO mutation is itself durable completion state. Without a
      // host-owned marker, a restart that replays only the journal would forget
      // the rejected first update and the root gate could pass an empty list.
      if ((event.agentId === undefined || event.agentId === "root") && p.toolId === "todo.write") {
        const detail = sanitizeTodoText(str(p.message, str(p.summary, "TODO update was rejected")), 300);
        next.todo = {
          ...next.todo,
          modelMutationError: `TODO update rejected: ${detail || "TODO update was rejected"}`,
          updatedAt: event.timestamp,
        };
      }
      next.turnStatus = "observing";
      break;
    }

    case "approval.requested": {
      const p = payloadOf(event);
      const item: TimelineApproval = {
        type: "approval",
        id: event.id,
        sequence: event.sequence,
        approvalId: str(p.approvalId),
        action: str(p.action),
        display: str(p.display),
        ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
        riskClass: str(p.riskClass, "R1"),
        reason: str(p.reason),
        network: p.network === true,
        sideEffects: strArray(p.sideEffects),
      };
      const timelineIndex = next.timeline.length;
      next.timeline.push(item);
      indexes.approvals.set(item.approvalId, timelineIndex);
      next.pendingApproval = item;
      next.turnStatus = "awaiting_approval";
      next.live = {
        kind: "awaiting_approval",
        label: `Approval required: ${item.action}`,
        interruptHint: "esc",
      };
      break;
    }

    case "approval.resolved": {
      const p = payloadOf(event);
      const approvalId = str(p.approvalId);
      const item = findMutableApproval(next.timeline, approvalId, indexes);
      if (item) {
        item.decision = str(p.decision);
        if (typeof p.reason === "string") item.decisionReason = p.reason;
      }
      delete next.pendingApproval;
      next.turnStatus = str(p.decision) === "deny" ? "observing" : "executing";
      next.live = { kind: "working", label: "Working...", interruptHint: "esc" };
      break;
    }

    case "transaction.committed": {
      const p = payloadOf(event);
      const operations = Array.isArray(p.operations) ? p.operations : [];
      const changedFiles = new Map(next.changedFiles);
      for (const op of operations as Array<Record<string, unknown>>) {
        const path = str(op.path);
        if (path.length === 0) continue;
        const prior = changedFiles.get(path) ?? { additions: 0, deletions: 0 };
        changedFiles.set(path, {
          additions: prior.additions + num(op.additions),
          deletions: prior.deletions + num(op.deletions),
        });
      }
      next.changedFiles = changedFiles;
      break;
    }

    case "transaction.conflicted": {
      const p = payloadOf(event);
      // Appendix A.3 conflict card.
      next.timeline.push(
        notice(
          event,
          "error",
          `Patch conflict: ${str(p.path)} changed after Capybara read it. Expected ${str(
            p.expected,
          ).slice(0, 7)}, actual ${str(p.actual).slice(0, 7)}. The file was not modified.`,
          "×",
        ),
      );
      break;
    }

    case "transaction.rolled_back": {
      next.timeline.push(
        notice(
          event,
          "warning",
          `Transaction rolled back: ${str(payloadOf(event).reason, "no files changed")}`,
          "!",
        ),
      );
      break;
    }

    case "diff.updated": {
      const p = payloadOf(event);
      const files = Array.isArray(p.files)
        ? (p.files as TimelineDiff["files"])
        : [];
      next.timeline.push({
        type: "diff",
        id: event.id,
        sequence: event.sequence,
        files,
        additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
        deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
      });
      break;
    }

    case "task.created": {
      const p = payloadOf(event);
      const lease = strArray(p.writeLease);
      const dependencies = strArray(p.dependencies);
      const modelId = str(p.modelId, str(p.model, str(p.modelProfile)));
      const item: TimelineTask = {
        type: "task",
        id: event.id,
        sequence: event.sequence,
        taskId: str(p.taskId),
        role: str(p.role),
        title: str(p.title),
        goal: str(p.goal),
        constraints: strArray(p.constraints),
        contract: strArray(p.contract ?? p.expectedOutput),
        ...(lease.length > 0 ? { writeLease: lease } : {}),
        ...(dependencies.length > 0 ? { dependencies } : {}),
        ...(modelId.length > 0 ? { modelId } : {}),
        // §15.10: a child held on a dependency is `waiting`, not `queued`, and the
        // card has to be able to say which.
        state: asTaskState(p.state) ?? (dependencies.length > 0 ? "waiting" : "queued"),
        childCount: num(p.childCount, 1),
        awaitInterrupted: false,
        ...(typeof p.startTimeMs === "number" ? { startTimeMs: num(p.startTimeMs) } : {}),
        tokens: 0,
        subagentEvents: [],
        subagentEventCount: 0,
        subagentEventsOmitted: 0,
      };
      const timelineIndex = next.timeline.length;
      next.timeline.push(item);
      indexes.tasks.set(item.taskId, timelineIndex);
      break;
    }

    case "task.started": {
      const p = payloadOf(event);
      const task = findTask(next.timeline, str(p.taskId), indexes);
      if (task) {
        task.state = "running";
        if (typeof p.startTimeMs === "number") task.startTimeMs = num(p.startTimeMs);
      }
      // Running does not imply that root is awaiting this child.
      next.live = {
        kind: "working",
        label: `${task?.role ?? "Subagent"} running...`,
        interruptHint: "esc",
      };
      break;
    }

    case "task.progress": {
      const p = payloadOf(event);
      const task = findTask(next.timeline, str(p.taskId), indexes);
      if (task) {
        task.state = "running";
        const text = str(p.text, str(p.summary));
        if (text.length > 0) task.progress = text;
      }
      if (p.awaiting === true) {
        const taskId = str(p.taskId);
        if (taskId.length > 0) {
          next.awaitingTaskId = taskId;
          next.live = {
            kind: "waiting_for_task",
            label: `Waiting for ${task?.role ?? "subagent"}...`,
            interruptHint: "esc",
          };
        }
      } else if (p.awaiting === false && next.awaitingTaskId === str(p.taskId)) {
        delete next.awaitingTaskId;
        next.live = { kind: "working", label: "Working...", interruptHint: "esc" };
      }
      break;
    }

    case "task.await_interrupted": {
      const task = findTask(next.timeline, str(payloadOf(event).taskId), indexes);
      if (task) task.awaitInterrupted = true;
      if (next.awaitingTaskId === str(payloadOf(event).taskId)) delete next.awaitingTaskId;
      // §6.11: stopping the wait is not cancelling the task.
      next.timeline.push(
        notice(
          event,
          "warning",
          "Await interrupted; this subagent continues. Inspect its current state in the context sidebar.",
          "!",
        ),
      );
      next.live = { kind: "working", label: "Working...", interruptHint: "esc" };
      break;
    }

    case "task.completed": {
      const p = payloadOf(event);
      const task = findTask(next.timeline, str(p.taskId), indexes);
      clearTaskLive(next, str(p.taskId));
      if (next.awaitingTaskId === str(p.taskId)) delete next.awaitingTaskId;
      if (task) {
        task.state = "completed";
        task.summary = str(p.summary);
        task.durationMs = num(p.durationMs);
      }
      // §6.4 background completion notification.
      const seconds = (num(p.durationMs) / 1000).toFixed(1);
      next.timeline.push(
        notice(
          event,
          "success",
          `Background job completed [task] ${task?.title ?? str(p.taskId)} (${seconds}s)`,
          "✓",
        ),
      );
      break;
    }

    case "task.failed":
    case "task.cancelled": {
      const p = payloadOf(event);
      const task = findTask(next.timeline, str(p.taskId), indexes);
      clearTaskLive(next, str(p.taskId));
      if (next.awaitingTaskId === str(p.taskId)) delete next.awaitingTaskId;
      if (task) {
        task.state = event.kind === "task.failed" ? "failed" : "cancelled";
        task.summary = str(p.summary, str(p.reason));
      }
      next.timeline.push(
        notice(
          event,
          event.kind === "task.failed" ? "error" : "warning",
          `Task ${task?.title ?? str(p.taskId)} ${
            event.kind === "task.failed" ? "failed" : "cancelled"
          }: ${str(p.reason, str(p.summary))}`,
          event.kind === "task.failed" ? "×" : "!",
        ),
      );
      break;
    }

    case "job.started": {
      const p = payloadOf(event);
      const timelineIndex = next.timeline.length;
      const jobId = str(p.jobId);
      next.timeline.push({
        type: "job",
        id: event.id,
        sequence: event.sequence,
        jobId,
        display: str(p.display),
        state: "running",
      });
      indexes.jobs.set(jobId, timelineIndex);
      break;
    }

    case "job.output": {
      // §22.5: job output is throttled and never journaled at full fidelity.
      break;
    }

    case "job.completed":
    case "job.failed": {
      const p = payloadOf(event);
      const job = findMutableJob(next.timeline, str(p.jobId), indexes);
      if (job) {
        job.state = event.kind === "job.completed" ? "completed" : "failed";
        job.exitCode = num(p.exitCode);
        job.durationMs = num(p.durationMs);
        if (typeof p.artifactId === "string") job.artifactId = p.artifactId;
        if (typeof p.summary === "string") job.summary = p.summary;
      }
      const seconds = (num(p.durationMs) / 1000).toFixed(1);
      next.timeline.push(
        notice(
          event,
          event.kind === "job.completed" ? "success" : "error",
          `Background job ${event.kind === "job.completed" ? "completed" : "failed"} [shell] ${str(
            p.jobId,
          )} (${seconds}s)`,
          event.kind === "job.completed" ? "✓" : "×",
        ),
      );
      break;
    }

    case "usage.updated": {
      const p = payloadOf(event);
      const addedTokens = num(p.inputTokens) + num(p.outputTokens);
      const owner = subagentOwner(next.timeline, event, indexes);
      if (owner !== undefined && addedTokens > 0) {
        owner.tokens = (owner.tokens ?? 0) + addedTokens;
      }
      next.usage = {
        inputTokens: next.usage.inputTokens + num(p.inputTokens),
        cachedInputTokens: next.usage.cachedInputTokens + num(p.cachedInputTokens),
        cacheWriteTokens: next.usage.cacheWriteTokens + num(p.cacheWriteTokens),
        outputTokens: next.usage.outputTokens + num(p.outputTokens),
        reasoningTokens: next.usage.reasoningTokens + num(p.reasoningTokens),
        estimatedCostUsd: next.usage.estimatedCostUsd + num(p.estimatedCostUsd),
      };
      if (typeof p.contextUsedTokens === "number") {
        next.contextUsedTokens = p.contextUsedTokens;
      }
      if (isContextUsageSnapshot(p.contextUsage)) {
        const usage = p.contextUsage;
        const currentRequest = next.contextUsage?.requestId;
        const incomingRequest = usage.requestId;
        if (currentRequest === undefined || incomingRequest === undefined || currentRequest === incomingRequest) {
          next.contextUsage = usage;
        }
      } else if (next.contextUsage !== undefined && typeof p.inputTokens === "number") {
        const incomingRequest = typeof p.requestId === "string" ? p.requestId : undefined;
        if (incomingRequest === undefined || next.contextUsage.requestId === undefined || incomingRequest === next.contextUsage.requestId) {
          next.contextUsage = reconcileContextUsageSnapshot(next.contextUsage, p.inputTokens, event.timestamp);
        }
      }
      break;
    }

    case "notification.update_available": {
      const p = payloadOf(event);
      next.notices = appendResidentNotice(
        next.notices,
        notice(
          event,
          "info",
          `New version ${str(p.version)} is available. Run: capy update`,
          "●",
        ),
      );
      break;
    }

    case "notification.retry": {
      const p = payloadOf(event);
      const attempt = num(p.attempt, 1);
      const reason = str(p.reason, "a transient provider error");
      next.timeline.push(
        notice(
          event,
          "info",
          `Reconnecting after ${reason} (attempt ${attempt})`,
          "\u21BB",
        ),
      );
      // Keep a live phase visible during the backoff window instead of leaving
      // only a one-line notice at the top of the timeline.
      next.live = { kind: "working", label: "Reconnecting...", interruptHint: "esc" };
      break;
    }

    case "model.route_escalated": {
      const p = payloadOf(event);
      const text = str(p.text, "Reasoning effort adjusted");
      next.notices = appendResidentNotice(
        next.notices,
        notice(event, "warning", text, "!"),
      );
      break;
    }

    case "error.provider":
    case "error.protocol":
    case "error.internal": {
      const p = payloadOf(event);
      next.timeline.push(notice(event, "error", str(p.message, "Unknown error"), "×"));
      next.turnStatus = "failed";
      next.live = { kind: "failed", label: str(p.message, "Failed") };
      break;
    }

    default:
      break;
  }

  if (event.kind === "assistant.delta") {
    MODEL_TIMELINE_INDEXES.set(next, indexes);
    return next;
  }

  refreshActiveLifecycle(next, event, indexes);
  MODEL_TIMELINE_INDEXES.set(next, indexes);
  return next;
}

function activeTaskState(state: TaskState): boolean {
  return state === "running" || state === "queued" || state === "waiting";
}

function peekTask(
  timeline: readonly TimelineItem[],
  taskId: string,
  indexes: TimelineIndexes,
): TimelineTask | undefined {
  const cachedIndex = indexes.tasks.get(taskId);
  if (cachedIndex !== undefined) {
    const cached = timeline[cachedIndex];
    if (cached?.type === "task" && cached.taskId === taskId) return cached;
  }
  for (let timelineIndex = timeline.length - 1; timelineIndex >= 0; timelineIndex -= 1) {
    const item = timeline[timelineIndex];
    if (item?.type === "task" && item.taskId === taskId) {
      indexes.tasks.set(taskId, timelineIndex);
      return item;
    }
  }
  return undefined;
}

function peekJob(
  timeline: readonly TimelineItem[],
  jobId: string,
  indexes: TimelineIndexes,
): TimelineJob | undefined {
  const cachedIndex = indexes.jobs.get(jobId);
  if (cachedIndex !== undefined) {
    const cached = timeline[cachedIndex];
    if (cached?.type === "job" && cached.jobId === jobId) return cached;
  }
  for (let timelineIndex = timeline.length - 1; timelineIndex >= 0; timelineIndex -= 1) {
    const item = timeline[timelineIndex];
    if (item?.type === "job" && item.jobId === jobId) {
      indexes.jobs.set(jobId, timelineIndex);
      return item;
    }
  }
  return undefined;
}

/** Refresh only small active sets for events that can affect them. */
function refreshActiveLifecycle(
  model: Mutable<SessionViewModel>,
  event: CbcEvent,
  indexes: TimelineIndexes,
): void {
  const taskRelated =
    event.kind.startsWith("task.") ||
    event.kind.startsWith("tool.") ||
    event.kind === "usage.updated";
  if (taskRelated) {
    const taskIds = new Set(model.activeTasks.map((task) => task.taskId));
    const payload = payloadOf(event);
    if (typeof payload.taskId === "string" && payload.taskId.length > 0) taskIds.add(payload.taskId);
    if (event.agentId !== undefined && event.agentId !== "root" && event.agentId.length > 0) {
      taskIds.add(event.agentId);
    }
    if (typeof payload.callId === "string") {
      const location = indexes.calls.get(payload.callId);
      if (location?.childIndex !== undefined) {
        const owner = model.timeline[location.timelineIndex];
        if (owner?.type === "task") taskIds.add(owner.taskId);
      }
    }
    const active: TimelineTask[] = [];
    for (const taskId of taskIds) {
      const task = peekTask(model.timeline, taskId, indexes);
      if (task !== undefined && activeTaskState(task.state)) active.push(task);
    }
    active.sort((left, right) => left.sequence - right.sequence);
    model.activeTasks = active;
  }

  if (event.kind.startsWith("tool.")) {
    const callIds = new Set(model.activeTools.map((tool) => tool.callId));
    const callId = str(payloadOf(event).callId);
    if (callId.length > 0) callIds.add(callId);
    const active: TimelineToolCall[] = [];
    for (const id of callIds) {
      const location = indexes.calls.get(id);
      if (location?.childIndex !== undefined) continue;
      const tool = location === undefined ? undefined : model.timeline[location.timelineIndex];
      if (tool?.type === "tool" && tool.callId === id && tool.status === "running") {
        active.push(tool);
      }
    }
    active.sort((left, right) => left.sequence - right.sequence);
    model.activeTools = active;
  }

  if (event.kind.startsWith("job.")) {
    const jobIds = new Set(model.activeJobs.map((job) => job.jobId));
    const jobId = str(payloadOf(event).jobId);
    if (jobId.length > 0) jobIds.add(jobId);
    const active: TimelineJob[] = [];
    for (const id of jobIds) {
      const job = peekJob(model.timeline, id, indexes);
      if (job?.state === "running") active.push(job);
    }
    active.sort((left, right) => left.sequence - right.sequence);
    model.activeJobs = active;
  }
}

/** Replay a whole event list. §25.4: must equal the incremental result. */
export function replay(sessionId: string, events: readonly CbcEvent[], budget?: number): SessionViewModel {
  let model = emptyViewModel(sessionId, budget);
  for (const event of events) model = reduce(model, event);
  return model;
}

function cloneModel(model: SessionViewModel): Mutable<SessionViewModel> {
  return {
    ...model,
    timeline: [...model.timeline],
    // Durable cases replace these values before writing. Sharing them by default
    // avoids copying unrelated collections for every journal event.
    plan: model.plan,
    todo: model.todo,
    modeState: model.modeState,
    ...(model.contextUsage === undefined ? {} : { contextUsage: model.contextUsage }),
    usage: model.usage,
    notices: model.notices,
    taskLive: model.taskLive,
    // Lifecycle indexes refresh these small arrays only for task/job-related events.
    // Unrelated durable events share them instead of filtering the full timeline.
    activeTasks: model.activeTasks,
    activeTools: model.activeTools,
    activeJobs: model.activeJobs,
    changedFiles: model.changedFiles,
  };
}

/**
 * Clone only the object shell for an ephemeral delta. The reducer does not
 * mutate any shared collection in that case, while returning a fresh object
 * still keeps callers' top-level state immutable.
 */
function cloneEphemeralModel(model: SessionViewModel): Mutable<SessionViewModel> {
  return {
    ...model,
    // Root deltas only replace scalar live-state fields. Keep every collection by
    // reference on that hot path; child deltas clone `taskLive` lazily below before
    // writing to it. This preserves reducer immutability without copying unrelated
    // maps for every provider chunk.
    timeline: model.timeline,
    plan: model.plan,
    todo: model.todo,
    modeState: model.modeState,
    ...(model.contextUsage === undefined ? {} : { contextUsage: model.contextUsage }),
    usage: model.usage,
    notices: model.notices,
    taskLive: model.taskLive,
    activeTasks: model.activeTasks,
    activeTools: model.activeTools,
    activeJobs: model.activeJobs,
    changedFiles: model.changedFiles,
  };
}

/**
 * Copy one timeline item deeply enough that mutating the copy cannot reach the
 * original.
 *
 * A shallow spread was sufficient while every mutable field was a scalar. A task
 * now owns an array of subagent events that later events push into, and sharing
 * that array would let `reduce` mutate the model it was handed — which is exactly
 * what §25.4's "replay equals incremental" property forbids.
 */
function cloneItem(item: TimelineItem): TimelineItem {
  if (item.type === "task") {
    return {
      ...item,
      subagentEvents: item.subagentEvents.map((child) => ({
        ...child,
        ...(child.artifacts !== undefined ? { artifacts: [...child.artifacts] } : {}),
        ...(child.diffPreview !== undefined ? { diffPreview: [...child.diffPreview] } : {}),
      })),
    };
  }
  if (item.type === "tool" && item.diffPreview !== undefined) {
    return { ...item, diffPreview: [...item.diffPreview] };
  }
  return { ...item } as TimelineItem;
}

function clearTaskLive(model: Mutable<SessionViewModel>, taskId: string): void {
  if (!model.taskLive.has(taskId)) return;
  const taskLive = new Map(model.taskLive);
  taskLive.delete(taskId);
  model.taskLive = taskLive;
}

function notice(
  event: CbcEvent,
  level: TimelineNotice["level"],
  text: string,
  icon?: string,
): TimelineNotice {
  return {
    type: "notice",
    id: event.id,
    sequence: event.sequence,
    level,
    text,
    ...(icon !== undefined ? { icon } : {}),
  };
}

/**
 * The mutable shape shared by a top-level tool call and a subagent's tool event.
 *
 * The two carry the same lifecycle fields, so the four `tool.*` cases update them
 * through one type rather than branching on where the call happens to live.
 */
type MutableCall = Mutable<TimelineSubagentEvent> | Mutable<TimelineToolCall>;

/** Find and clone a call by id, using the advisory index before a safe fallback. */
function findCall(
  timeline: TimelineItem[],
  callId: string,
  indexes: TimelineIndexes,
): MutableCall | undefined {
  const cached = indexes.calls.get(callId);
  if (cached !== undefined) {
    const item = timeline[cached.timelineIndex];
    if (cached.childIndex === undefined) {
      if (item?.type === "tool" && item.callId === callId) {
        const cloned = cloneItem(item);
        timeline[cached.timelineIndex] = cloned;
        return cloned as Mutable<TimelineToolCall>;
      }
    } else if (item?.type === "task") {
      const child = item.subagentEvents[cached.childIndex];
      if (child?.callId === callId) {
        const clonedTask = cloneItem(item) as TimelineTask;
        timeline[cached.timelineIndex] = clonedTask;
        return clonedTask.subagentEvents[cached.childIndex] as Mutable<TimelineSubagentEvent>;
      }
    }
  }

  for (let timelineIndex = timeline.length - 1; timelineIndex >= 0; timelineIndex -= 1) {
    const item = timeline[timelineIndex];
    if (item === undefined) continue;
    if (item.type === "tool" && item.callId === callId) {
      indexes.calls.set(callId, { timelineIndex });
      const cloned = cloneItem(item);
      timeline[timelineIndex] = cloned;
      return cloned as Mutable<TimelineToolCall>;
    }
    if (item.type === "task") {
      for (let childIndex = item.subagentEvents.length - 1; childIndex >= 0; childIndex -= 1) {
        const child = item.subagentEvents[childIndex];
        if (child?.callId !== callId) continue;
        indexes.calls.set(callId, { timelineIndex, childIndex });
        const clonedTask = cloneItem(item) as TimelineTask;
        timeline[timelineIndex] = clonedTask;
        return clonedTask.subagentEvents[childIndex] as Mutable<TimelineSubagentEvent>;
      }
    }
  }
  return undefined;
}

/**
 * The task a tool event belongs to, or `undefined` when the parent issued it.
 *
 * §15.3 gives a child instance and its task the same id, so the envelope's
 * `agentId` is the task id. `root` is spelled out rather than inferred from the
 * absence of a match, so a genuinely unknown agent id still falls back to the
 * top-level timeline instead of being silently dropped.
 */
function subagentOwner(
  timeline: TimelineItem[],
  event: CbcEvent,
  indexes: TimelineIndexes,
): Mutable<TimelineTask> | undefined {
  const agentId = event.agentId;
  if (agentId === undefined || agentId === "root" || agentId.length === 0) return undefined;
  return findTask(timeline, agentId, indexes);
}

/** Apply the fields shared by `tool.completed` and `tool.failed`. */
function applyCallDetail(call: MutableCall, payload: Record<string, unknown>): void {
  if (typeof payload.exitCode === "number") call.exitCode = payload.exitCode;
  if (typeof payload.additions === "number") call.additions = payload.additions;
  if (typeof payload.deletions === "number") call.deletions = payload.deletions;

  const preview = diffPreviewFrom(payload.diffPreview);
  if (preview.length > 0) call.diffPreview = preview;
}

/** §6.4: at most four preview lines, so a write never buries the timeline. */
export const MAX_DIFF_PREVIEW_LINES = 4;

function diffPreviewFrom(value: unknown): TimelineDiffPreviewLine[] {
  if (!Array.isArray(value)) return [];
  const out: TimelineDiffPreviewLine[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== "added" && kind !== "removed" && kind !== "context") continue;
    out.push({
      kind,
      ...(typeof record.lineNumber === "number" ? { lineNumber: record.lineNumber } : {}),
      text: str(record.text),
    });
    if (out.length >= MAX_DIFF_PREVIEW_LINES) break;
  }
  return out;
}

function findTask(
  timeline: TimelineItem[],
  taskId: string,
  indexes: TimelineIndexes,
): Mutable<TimelineTask> | undefined {
  const cachedIndex = indexes.tasks.get(taskId);
  if (cachedIndex !== undefined) {
    const cached = timeline[cachedIndex];
    if (cached?.type === "task" && cached.taskId === taskId) {
      const cloned = cloneItem(cached);
      timeline[cachedIndex] = cloned;
      return cloned as Mutable<TimelineTask>;
    }
  }
  for (let timelineIndex = timeline.length - 1; timelineIndex >= 0; timelineIndex -= 1) {
    const item = timeline[timelineIndex];
    if (item?.type === "task" && item.taskId === taskId) {
      indexes.tasks.set(taskId, timelineIndex);
      const cloned = cloneItem(item);
      timeline[timelineIndex] = cloned;
      return cloned as Mutable<TimelineTask>;
    }
  }
  return undefined;
}

function findMutableApproval(
  timeline: TimelineItem[],
  approvalId: string,
  indexes: TimelineIndexes,
): Mutable<TimelineApproval> | undefined {
  const cachedIndex = indexes.approvals.get(approvalId);
  if (cachedIndex !== undefined) {
    const cached = timeline[cachedIndex];
    if (cached?.type === "approval" && cached.approvalId === approvalId) {
      const cloned = cloneItem(cached);
      timeline[cachedIndex] = cloned;
      return cloned as Mutable<TimelineApproval>;
    }
  }
  for (let timelineIndex = timeline.length - 1; timelineIndex >= 0; timelineIndex -= 1) {
    const item = timeline[timelineIndex];
    if (item?.type === "approval" && item.approvalId === approvalId) {
      indexes.approvals.set(approvalId, timelineIndex);
      const cloned = cloneItem(item);
      timeline[timelineIndex] = cloned;
      return cloned as Mutable<TimelineApproval>;
    }
  }
  return undefined;
}

function findMutableJob(
  timeline: TimelineItem[],
  jobId: string,
  indexes: TimelineIndexes,
): Mutable<TimelineJob> | undefined {
  const cachedIndex = indexes.jobs.get(jobId);
  if (cachedIndex !== undefined) {
    const cached = timeline[cachedIndex];
    if (cached?.type === "job" && cached.jobId === jobId) {
      const cloned = cloneItem(cached);
      timeline[cachedIndex] = cloned;
      return cloned as Mutable<TimelineJob>;
    }
  }
  for (let timelineIndex = timeline.length - 1; timelineIndex >= 0; timelineIndex -= 1) {
    const item = timeline[timelineIndex];
    if (item?.type === "job" && item.jobId === jobId) {
      indexes.jobs.set(jobId, timelineIndex);
      const cloned = cloneItem(item);
      timeline[timelineIndex] = cloned;
      return cloned as Mutable<TimelineJob>;
    }
  }
  return undefined;
}

function trimResidentSubagentEvents(
  task: Mutable<TimelineTask>,
  timelineIndex: number,
  indexes: TimelineIndexes,
): void {
  while (task.subagentEvents.length > MAX_RESIDENT_SUBAGENT_EVENTS) {
    const removableIndex = task.subagentEvents.findIndex((event) => event.status !== "running");
    if (removableIndex < 0) break;
    const [removed] = task.subagentEvents.splice(removableIndex, 1);
    if (removed !== undefined) indexes.calls.delete(removed.callId);
    task.subagentEventsOmitted = (task.subagentEventsOmitted ?? 0) + 1;
  }
  for (let childIndex = 0; childIndex < task.subagentEvents.length; childIndex += 1) {
    const child = task.subagentEvents[childIndex];
    if (child !== undefined) indexes.calls.set(child.callId, { timelineIndex, childIndex });
  }
}

function trimTaskContainingCall(
  timeline: TimelineItem[],
  callId: string,
  indexes: TimelineIndexes,
): void {
  const location = indexes.calls.get(callId);
  if (location?.childIndex === undefined) return;
  const task = timeline[location.timelineIndex];
  if (task?.type !== "task") return;
  trimResidentSubagentEvents(task, location.timelineIndex, indexes);
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === "string"
          ? value.length > 48
            ? `${value.slice(0, 48)}…`
            : value
          : JSON.stringify(value);
      return `${key}=${rendered}`;
    })
    .join(" ");
}

/** §6.13 context percentage against the *soft* budget, not the model window. */
export function contextPercent(model: SessionViewModel): number {
  if (model.contextBudgetTokens <= 0) return 0;
  return Math.min(100, (model.contextUsedTokens / model.contextBudgetTokens) * 100);
}

/** Journal-worthy event kinds for a given view model, used by the persistence
 *  boundary in §20.9. */
export function shouldPersist(kind: CbcEventKind): boolean {
  return kind !== "tool.progress" && kind !== "job.output" && kind !== "task.progress";
}
