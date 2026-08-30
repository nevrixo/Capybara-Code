/**
 * Domain event envelope — PRD §20.6 and §20.7.
 *
 * The agent kernel, the TUI, internal event taps, and the session journal all use
 * this one schema. §20.8 makes the reducer the only path from events to view
 * model, which is what makes deterministic replay, crash recovery, golden TUI
 * tests, and the headless contract share an implementation.
 */

export const EVENT_SCHEMA_VERSION = "1.0" as const;

/** §20.7 event kinds, in declaration order. */
export const EVENT_KINDS = [
  "session.started",
  "session.resumed",
  "session.forked",
  "session.compacted",
  "turn.started",
  "turn.interrupted",
  "turn.cancelled",
  "turn.completed",
  /**
   * §8.9 headless final status. Distinct from `turn.completed` so a `capy run`
   * carries exactly one completion event per turn: the kernel emits
   * `turn.completed`, and only the headless runner adds this process-level
   * status with the exit code.
   */
  "run.completed",
  "user.message",
  /** Ephemeral provider text deltas used for low-latency interactive rendering. */
  "assistant.delta",
  "assistant.commentary",
  "assistant.reasoning",
  "assistant.reasoning_summary",
  "assistant.final",
  "plan.created",
  "plan.updated",
  "plan.approved",
  "mode.changed",
  "tool.discovery",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "tool.preflight_repaired",
  "tool.attempt_failed",
  "tool.recovery_applied",
  "tool.reconciled",
  "tool.recovery_exhausted",
  "approval.requested",
  "approval.resolved",
  "transaction.started",
  "transaction.committed",
  "transaction.rolled_back",
  "transaction.conflicted",
  "diff.updated",
  "task.created",
  "task.profile_resolved",
  "task.started",
  "task.progress",
  "task.await_interrupted",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "job.started",
  "job.output",
  "job.completed",
  "job.failed",
  "notification.update_available",
  "notification.retry",
  "error.provider",
  "error.protocol",
  "error.internal",
  "usage.updated",
  "permission.changed",
  /** Active Agent Skills catalog snapshot changed. */
  "skills.changed",
  /** Token saving: the user-facing level changed (`/setting`). */
  "token_saving.changed",
  /** Token saving: the effective policy applied to a turn (journaled for replay). */
  "token_saving.policy_applied",
  /** Token saving: the effective level was relaxed below the requested one. */
  "token_saving.relaxed",
  /** Deep Plan durable state transitions and questionnaire resume checkpoints. */
  "deep_plan.started",
  "deep_plan.questionnaire_opened",
  "deep_plan.questionnaire_updated",
  "deep_plan.questionnaire_answered",
  "deep_plan.plan_written",
  "deep_plan.paused",
  "deep_plan.resumed",
  "deep_plan.draft_requested",
  "deep_plan.completed",
  "deep_plan.cancelled",
] as const;

/** v1.3 provider-native lifecycle kinds, kept separate for legacy consumers. */
export const V13_EVENT_KINDS = [
  "assistant.thinking",
  "model.capability_snapshot",
  "model.route_decided",
  "model.phase_changed",
  "model.route_changed",
  "model.route_escalated",
  "reasoning.epoch_started",
  "reasoning.epoch_reset",
  "reasoning.context_effective",
  "context.plan_created",
  "context.evidence_selected",
  "context.evidence_invalidated",
  "context.observation_ingested",
  "context.pack_compiled",
  "context.item_evicted",
  "context.evidence_rejected",
  "context.cache_segment",
  "context.scope_created",
  "context.scope_seeded",
  "context.handoff_created",
  "context.handoff_validation_failed",
  "context.handoff_accepted",
  "context.handoff_rejected",
  "context.handoff_consumed",
  "context.scope_disposed",
  "cache.plan_created",
  "cache.write_observed",
  "cache.read_observed",
  "native_lane.selected",
  "native_lane.fallback",
  "program.started",
  "program.tool_call_started",
  "program.tool_call_admitted",
  "program.tool_call_denied",
  "program.tool_call_completed",
  "program.completed",
  "program.failed",
  "hosted_agent.requested",
  "hosted_agent.spawned",
  "hosted_agent.progress",
  "hosted_agent.completed",
  "hosted_agent.cancelled",
  "hosted_agent.fallback_local",
  "hosted_agent.evidence_rejected",
  "tool.batch_started",
  "tool.batch_completed",
  "evidence.recorded",
  "evidence.invalidated",
  "verification.coverage_updated",
  "verification.plan_created",
  "verification.step_started",
  "verification.step_completed",
  "verification.escalated",
  "budget.plan_created",
  "budget.reservation_changed",
  "budget.guard_triggered",
  "budget.exhausted",
  "retrieval.plan_created",
  "retrieval.preview_completed",
  "retrieval.exact_selected",
  "retrieval.coverage_updated",
  "retrieval.completed",
  "verification.blocked_completion",
  "run.trace_started",
  "repository.orientation_started",
  "repository.orientation_completed",
  "repository.full_scan_started",
  "repository.full_scan_completed",
  "context.prepare_started",
  "context.prepare_completed",
  "context.pressure_evaluated",
  "context.compaction_planned",
  "context.compaction_target_missed",
  "context.compaction_emergency",
  "prompt.compile_started",
  "prompt.compile_completed",
  "provider.connection_started",
  "provider.connection_ready",
  "provider.request_sent",
  "provider.response_created",
  "provider.first_delta",
  "provider.response_completed",
  "provider.fallback",
  "verification.started",
  "verification.completed",
  "review.started",
  "review.completed",
  "run.trace_completed",
] as const;

/** Runtime-feature kinds from the modification plan §17. Adding one is a minor change. */
export const RUNTIME_FEATURE_EVENT_KINDS = [
  "edit.plan_created",
  "edit.preview_completed",
  "edit.operation_resolved",
  "edit.rebased",
  "edit.conflicted",
  "edit.staged",
  "edit.committed",
  "edit.no_change",
  "lsp.server_starting",
  "lsp.server_ready",
  "lsp.server_degraded",
  "lsp.server_stopped",
  "lsp.document_opened",
  "lsp.document_changed",
  "lsp.document_closed",
  "lsp.request_started",
  "lsp.request_completed",
  "lsp.request_failed",
  "lsp.diagnostics_updated",
  "lsp.workspace_edit_proposed",
  "lsp.workspace_edit_applied",
  "lsp.workspace_edit_rejected",
  "memory.proposed",
  "memory.rejected",
  "memory.created",
  "memory.revalidated",
  "memory.superseded",
  "memory.contested",
  "memory.contest_resolved",
  "memory.invalidated",
  "memory.recalled",
  "memory.forgotten",
  "memory.purged",
  "daemon.started",
  "daemon.ready",
  "daemon.degraded",
  "daemon.shutting_down",
  "daemon.stopped",
  "workspace.supervisor_started",
  "workspace.supervisor_stopped",
  "session.owner_acquired",
  "session.owner_lost",
  "session.client_attached",
  "session.client_detached",
  "session.control_acquired",
  "session.control_released",
  "session.recovery_started",
  "session.recovery_completed",
  "session.recovery_blocked",
  "command.accepted",
  "command.completed",
  "command.failed",
  "graph.created",
  "graph.updated",
  "graph.paused",
  "graph.resumed",
  "graph.completed",
  "graph.failed",
  "graph.cancelled",
  "graph.blocked",
  "agent.node_created",
  "agent.node_ready",
  "agent.node_queued",
  "agent.node_dispatched",
  "agent.node_started",
  "agent.node_waiting",
  "agent.node_paused",
  "agent.node_resumed",
  "agent.node_completed",
  "agent.node_partial",
  "agent.node_failed",
  "agent.node_cancelled",
  "agent.node_blocked",
  "agent.attempt_created",
  "agent.attempt_interrupted",
  "agent.attempt_reconciled",
  "agent.message_sent",
  "agent.message_delivered",
  "agent.handoff_created",
  "agent.handoff_accepted",
  "agent.handoff_rejected",
  "worktree.create_started",
  "worktree.created",
  "worktree.ready",
  "worktree.leased",
  "worktree.dirty",
  "worktree.proposal_created",
  "worktree.abandoned",
  "worktree.delete_started",
  "worktree.deleted",
  "worktree.recovery_required",
  "merge.started",
  "merge.preview_completed",
  "merge.conflicted",
  "merge.resolution_proposed",
  "merge.resolution_applied",
  "merge.committed",
  "merge.verification_started",
  "merge.verification_completed",
  "merge.failed",
  "plugin.discovered",
  "plugin.installed",
  "plugin.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.grant_requested",
  "plugin.grant_resolved",
  "plugin.started",
  "plugin.ready",
  "plugin.degraded",
  "plugin.stopped",
  "plugin.hook_started",
  "plugin.hook_completed",
  "plugin.hook_failed",
  "plugin.hook_denied",
  "plugin.tool_registered",
  "plugin.command_registered",
  "plugin.agent_registered",
  "plugin.context_proposed",
  "plugin.circuit_opened",
  "plugin.state_changed",
] as const;

export const ALL_EVENT_KINDS = [...EVENT_KINDS, ...V13_EVENT_KINDS, ...RUNTIME_FEATURE_EVENT_KINDS] as const;
export type CbcEventKind = (typeof ALL_EVENT_KINDS)[number];

/** v1.3 events whose durable envelope must retain full proposer ancestry. */
export const V13_ANCESTRY_EVENT_KINDS: readonly CbcEventKind[] = [
  "native_lane.selected", "native_lane.fallback",
  "program.started", "program.tool_call_started", "program.tool_call_admitted", "program.tool_call_denied",
  "program.tool_call_completed", "program.completed", "program.failed",
  "hosted_agent.requested", "hosted_agent.spawned", "hosted_agent.progress", "hosted_agent.completed", "hosted_agent.cancelled",
  "hosted_agent.fallback_local", "hosted_agent.evidence_rejected",
  "tool.batch_started", "tool.batch_completed",
] as const;

const EVENT_KIND_SET: ReadonlySet<string> = new Set(ALL_EVENT_KINDS);

export function isKnownEventKind(kind: string): kind is CbcEventKind {
  return EVENT_KIND_SET.has(kind);
}

export type EventLevel = "debug" | "info" | "success" | "warning" | "error";

/** Where an event is shown. `hidden` events are journaled but not rendered. */
export type EventVisibility = "timeline" | "live" | "drawer" | "hidden";

/**
 * §20.9: journaled events are durable once the runtime acknowledges the append.
 * Ephemeral events drive the UI immediately but may be coalesced before storage.
 */
export type EventDurability = "ephemeral" | "journaled";

export interface CbcEvent<T = unknown> {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly id: string;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly parentEventId?: string;
  readonly correlationId?: string;
  readonly callerId?: string;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly kind: CbcEventKind;
  readonly level: EventLevel;
  readonly visibility: EventVisibility;
  readonly durability: EventDurability;
  readonly payload: T;
}

/** Per-kind defaults so callers cannot accidentally drop a MUST-journal event. */
const KIND_DEFAULTS: Record<
  CbcEventKind,
  { level: EventLevel; visibility: EventVisibility; durability: EventDurability }
> = {
  "session.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.resumed": { level: "info", visibility: "timeline", durability: "journaled" },
  "session.forked": { level: "info", visibility: "timeline", durability: "journaled" },
  "session.compacted": { level: "info", visibility: "timeline", durability: "journaled" },
  "turn.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "turn.interrupted": { level: "warning", visibility: "timeline", durability: "journaled" },
  "turn.cancelled": { level: "warning", visibility: "timeline", durability: "journaled" },
  "turn.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "run.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "user.message": { level: "info", visibility: "timeline", durability: "journaled" },
  "assistant.delta": { level: "info", visibility: "live", durability: "ephemeral" },
  "assistant.commentary": { level: "info", visibility: "timeline", durability: "journaled" },
  "assistant.reasoning": { level: "info", visibility: "timeline", durability: "journaled" },
  "assistant.reasoning_summary": { level: "info", visibility: "timeline", durability: "journaled" },
  "assistant.thinking": { level: "info", visibility: "timeline", durability: "journaled" },
  "assistant.final": { level: "info", visibility: "timeline", durability: "journaled" },
  "plan.created": { level: "info", visibility: "timeline", durability: "journaled" },
  "plan.updated": { level: "info", visibility: "timeline", durability: "journaled" },
  "plan.approved": { level: "info", visibility: "hidden", durability: "journaled" },
  "mode.changed": { level: "info", visibility: "hidden", durability: "journaled" },
  "tool.discovery": { level: "success", visibility: "timeline", durability: "journaled" },
  "tool.started": { level: "info", visibility: "timeline", durability: "journaled" },
  "tool.progress": { level: "info", visibility: "live", durability: "ephemeral" },
  "tool.completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "tool.failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "tool.preflight_repaired": { level: "info", visibility: "hidden", durability: "journaled" },
  "tool.attempt_failed": { level: "warning", visibility: "hidden", durability: "journaled" },
  "tool.recovery_applied": { level: "info", visibility: "hidden", durability: "journaled" },
  "tool.reconciled": { level: "info", visibility: "hidden", durability: "journaled" },
  "tool.recovery_exhausted": { level: "error", visibility: "hidden", durability: "journaled" },
  "approval.requested": { level: "warning", visibility: "timeline", durability: "journaled" },
  "approval.resolved": { level: "info", visibility: "timeline", durability: "journaled" },
  "transaction.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "transaction.committed": { level: "success", visibility: "hidden", durability: "journaled" },
  "transaction.rolled_back": { level: "warning", visibility: "timeline", durability: "journaled" },
  "transaction.conflicted": { level: "error", visibility: "timeline", durability: "journaled" },
  "diff.updated": { level: "info", visibility: "timeline", durability: "journaled" },
  "task.created": { level: "info", visibility: "timeline", durability: "journaled" },
  "task.profile_resolved": { level: "info", visibility: "drawer", durability: "journaled" },
  "task.started": { level: "info", visibility: "timeline", durability: "journaled" },
  "task.progress": { level: "info", visibility: "live", durability: "ephemeral" },
  "task.await_interrupted": { level: "warning", visibility: "timeline", durability: "journaled" },
  "task.completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "task.failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "task.cancelled": { level: "warning", visibility: "timeline", durability: "journaled" },
  "job.started": { level: "info", visibility: "timeline", durability: "journaled" },
  "job.output": { level: "info", visibility: "live", durability: "ephemeral" },
  "job.completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "job.failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "notification.update_available": {
    level: "info",
    visibility: "timeline",
    durability: "ephemeral",
  },
  "notification.retry": { level: "warning", visibility: "timeline", durability: "ephemeral" },
  "error.provider": { level: "error", visibility: "timeline", durability: "journaled" },
  "error.protocol": { level: "error", visibility: "timeline", durability: "journaled" },
  "error.internal": { level: "error", visibility: "timeline", durability: "journaled" },
  "usage.updated": { level: "info", visibility: "drawer", durability: "journaled" },
  "permission.changed": { level: "info", visibility: "hidden", durability: "journaled" },
  "skills.changed": { level: "info", visibility: "hidden", durability: "journaled" },
  // Token saving events carry settings, numbers, and relaxation reasons only —
  // never prompt text, file contents, or tool output — and are journaled even
  // when performance telemetry is off, because a replayed turn must reproduce
  // the exact budgets it ran with.
  "token_saving.changed": { level: "info", visibility: "hidden", durability: "journaled" },
  "token_saving.policy_applied": { level: "info", visibility: "hidden", durability: "journaled" },
  "token_saving.relaxed": { level: "warning", visibility: "hidden", durability: "journaled" },
  "deep_plan.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.questionnaire_opened": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.questionnaire_updated": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.questionnaire_answered": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.plan_written": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.paused": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.resumed": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.draft_requested": { level: "info", visibility: "hidden", durability: "journaled" },
  "deep_plan.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "deep_plan.cancelled": { level: "warning", visibility: "hidden", durability: "journaled" },
  "model.capability_snapshot": { level: "info", visibility: "hidden", durability: "journaled" },
  "model.route_decided": { level: "info", visibility: "hidden", durability: "journaled" },
  "model.phase_changed": { level: "info", visibility: "hidden", durability: "journaled" },
  "model.route_changed": { level: "info", visibility: "hidden", durability: "journaled" },
  "model.route_escalated": { level: "warning", visibility: "timeline", durability: "journaled" },
  "reasoning.epoch_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "reasoning.epoch_reset": { level: "warning", visibility: "hidden", durability: "journaled" },
  "reasoning.context_effective": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.plan_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.evidence_selected": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.evidence_invalidated": { level: "warning", visibility: "hidden", durability: "journaled" },
  "context.observation_ingested": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.pack_compiled": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.item_evicted": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.evidence_rejected": { level: "warning", visibility: "hidden", durability: "journaled" },
  "context.cache_segment": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.scope_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.scope_seeded": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.handoff_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.handoff_validation_failed": { level: "warning", visibility: "hidden", durability: "journaled" },
  "context.handoff_accepted": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.handoff_rejected": { level: "warning", visibility: "hidden", durability: "journaled" },
  "context.handoff_consumed": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.scope_disposed": { level: "info", visibility: "hidden", durability: "journaled" },
  "cache.plan_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "cache.write_observed": { level: "info", visibility: "hidden", durability: "journaled" },
  "cache.read_observed": { level: "info", visibility: "hidden", durability: "journaled" },
  "native_lane.selected": { level: "info", visibility: "hidden", durability: "journaled" },
  "native_lane.fallback": { level: "warning", visibility: "drawer", durability: "journaled" },
  "program.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "program.tool_call_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "program.tool_call_admitted": { level: "info", visibility: "hidden", durability: "journaled" },
  "program.tool_call_denied": { level: "warning", visibility: "hidden", durability: "journaled" },
  "program.tool_call_completed": { level: "info", visibility: "hidden", durability: "journaled" },
  "program.completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "program.failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "hosted_agent.requested": { level: "info", visibility: "hidden", durability: "journaled" },
  "hosted_agent.spawned": { level: "info", visibility: "hidden", durability: "journaled" },
  "hosted_agent.progress": { level: "info", visibility: "hidden", durability: "ephemeral" },
  "hosted_agent.completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "hosted_agent.cancelled": { level: "warning", visibility: "timeline", durability: "journaled" },
  "hosted_agent.fallback_local": { level: "warning", visibility: "drawer", durability: "journaled" },
  "hosted_agent.evidence_rejected": { level: "warning", visibility: "hidden", durability: "journaled" },
  "tool.batch_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "tool.batch_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "evidence.recorded": { level: "info", visibility: "hidden", durability: "journaled" },
  "evidence.invalidated": { level: "warning", visibility: "hidden", durability: "journaled" },
  "verification.coverage_updated": { level: "info", visibility: "drawer", durability: "journaled" },
  "verification.plan_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "verification.step_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "verification.step_completed": { level: "info", visibility: "hidden", durability: "journaled" },
  "verification.escalated": { level: "warning", visibility: "timeline", durability: "journaled" },
  "budget.plan_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "budget.reservation_changed": { level: "info", visibility: "hidden", durability: "journaled" },
  "budget.guard_triggered": { level: "warning", visibility: "timeline", durability: "journaled" },
  "budget.exhausted": { level: "error", visibility: "timeline", durability: "journaled" },
  "retrieval.plan_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "retrieval.preview_completed": { level: "info", visibility: "hidden", durability: "journaled" },
  "retrieval.exact_selected": { level: "info", visibility: "hidden", durability: "journaled" },
  "retrieval.coverage_updated": { level: "info", visibility: "drawer", durability: "journaled" },
  "retrieval.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "verification.blocked_completion": { level: "error", visibility: "timeline", durability: "journaled" },
  "run.trace_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "repository.orientation_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "repository.orientation_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "repository.full_scan_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "repository.full_scan_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "context.prepare_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.prepare_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "context.pressure_evaluated": { level: "info", visibility: "hidden", durability: "journaled" },
  "context.compaction_planned": { level: "warning", visibility: "hidden", durability: "journaled" },
  "context.compaction_target_missed": { level: "warning", visibility: "timeline", durability: "journaled" },
  "context.compaction_emergency": { level: "error", visibility: "timeline", durability: "journaled" },
  "prompt.compile_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "prompt.compile_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "provider.connection_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "provider.connection_ready": { level: "info", visibility: "hidden", durability: "journaled" },
  "provider.request_sent": { level: "info", visibility: "hidden", durability: "journaled" },
  "provider.response_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "provider.first_delta": { level: "info", visibility: "hidden", durability: "journaled" },
  "provider.response_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "provider.fallback": { level: "warning", visibility: "hidden", durability: "journaled" },
  "verification.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "verification.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "review.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "review.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "run.trace_completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "edit.plan_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "edit.preview_completed": { level: "info", visibility: "drawer", durability: "journaled" },
  "edit.operation_resolved": { level: "info", visibility: "hidden", durability: "journaled" },
  "edit.rebased": { level: "warning", visibility: "drawer", durability: "journaled" },
  "edit.conflicted": { level: "error", visibility: "timeline", durability: "journaled" },
  "edit.staged": { level: "info", visibility: "hidden", durability: "journaled" },
  "edit.committed": { level: "success", visibility: "timeline", durability: "journaled" },
  "edit.no_change": { level: "info", visibility: "hidden", durability: "journaled" },
  "lsp.server_starting": { level: "info", visibility: "hidden", durability: "journaled" },
  "lsp.server_ready": { level: "success", visibility: "hidden", durability: "journaled" },
  "lsp.server_degraded": { level: "warning", visibility: "drawer", durability: "journaled" },
  "lsp.server_stopped": { level: "info", visibility: "hidden", durability: "journaled" },
  "lsp.document_opened": { level: "info", visibility: "hidden", durability: "ephemeral" },
  "lsp.document_changed": { level: "info", visibility: "hidden", durability: "ephemeral" },
  "lsp.document_closed": { level: "info", visibility: "hidden", durability: "ephemeral" },
  "lsp.request_started": { level: "info", visibility: "hidden", durability: "ephemeral" },
  "lsp.request_completed": { level: "info", visibility: "hidden", durability: "journaled" },
  "lsp.request_failed": { level: "warning", visibility: "drawer", durability: "journaled" },
  "lsp.diagnostics_updated": { level: "info", visibility: "drawer", durability: "journaled" },
  "lsp.workspace_edit_proposed": { level: "info", visibility: "drawer", durability: "journaled" },
  "lsp.workspace_edit_applied": { level: "success", visibility: "timeline", durability: "journaled" },
  "lsp.workspace_edit_rejected": { level: "warning", visibility: "timeline", durability: "journaled" },
  "memory.proposed": { level: "info", visibility: "hidden", durability: "journaled" },
  "memory.rejected": { level: "warning", visibility: "drawer", durability: "journaled" },
  "memory.created": { level: "success", visibility: "drawer", durability: "journaled" },
  "memory.revalidated": { level: "info", visibility: "hidden", durability: "journaled" },
  "memory.superseded": { level: "info", visibility: "hidden", durability: "journaled" },
  "memory.contested": { level: "warning", visibility: "drawer", durability: "journaled" },
  "memory.contest_resolved": { level: "info", visibility: "drawer", durability: "journaled" },
  "memory.invalidated": { level: "warning", visibility: "hidden", durability: "journaled" },
  "memory.recalled": { level: "info", visibility: "hidden", durability: "journaled" },
  "memory.forgotten": { level: "info", visibility: "drawer", durability: "journaled" },
  "memory.purged": { level: "warning", visibility: "hidden", durability: "journaled" },
  "daemon.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "daemon.ready": { level: "success", visibility: "hidden", durability: "journaled" },
  "daemon.degraded": { level: "warning", visibility: "timeline", durability: "journaled" },
  "daemon.shutting_down": { level: "info", visibility: "hidden", durability: "journaled" },
  "daemon.stopped": { level: "info", visibility: "hidden", durability: "journaled" },
  "workspace.supervisor_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "workspace.supervisor_stopped": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.owner_acquired": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.owner_lost": { level: "warning", visibility: "hidden", durability: "journaled" },
  "session.client_attached": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.client_detached": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.control_acquired": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.control_released": { level: "info", visibility: "hidden", durability: "journaled" },
  "session.recovery_started": { level: "warning", visibility: "timeline", durability: "journaled" },
  "session.recovery_completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "session.recovery_blocked": { level: "error", visibility: "timeline", durability: "journaled" },
  "command.accepted": { level: "info", visibility: "hidden", durability: "journaled" },
  "command.completed": { level: "success", visibility: "hidden", durability: "journaled" },
  "command.failed": { level: "error", visibility: "drawer", durability: "journaled" },
  "graph.created": { level: "info", visibility: "drawer", durability: "journaled" },
  "graph.updated": { level: "info", visibility: "hidden", durability: "journaled" },
  "graph.paused": { level: "warning", visibility: "drawer", durability: "journaled" },
  "graph.resumed": { level: "info", visibility: "drawer", durability: "journaled" },
  "graph.completed": { level: "success", visibility: "timeline", durability: "journaled" },
  "graph.failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "graph.cancelled": { level: "warning", visibility: "timeline", durability: "journaled" },
  "graph.blocked": { level: "warning", visibility: "drawer", durability: "journaled" },
  "agent.node_created": { level: "info", visibility: "drawer", durability: "journaled" },
  "agent.node_ready": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.node_queued": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.node_dispatched": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.node_started": { level: "info", visibility: "drawer", durability: "journaled" },
  "agent.node_waiting": { level: "info", visibility: "drawer", durability: "journaled" },
  "agent.node_paused": { level: "warning", visibility: "drawer", durability: "journaled" },
  "agent.node_resumed": { level: "info", visibility: "drawer", durability: "journaled" },
  "agent.node_completed": { level: "success", visibility: "drawer", durability: "journaled" },
  "agent.node_partial": { level: "warning", visibility: "drawer", durability: "journaled" },
  "agent.node_failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "agent.node_cancelled": { level: "warning", visibility: "drawer", durability: "journaled" },
  "agent.node_blocked": { level: "warning", visibility: "drawer", durability: "journaled" },
  "agent.attempt_created": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.attempt_interrupted": { level: "warning", visibility: "hidden", durability: "journaled" },
  "agent.attempt_reconciled": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.message_sent": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.message_delivered": { level: "info", visibility: "hidden", durability: "journaled" },
  "agent.handoff_created": { level: "info", visibility: "drawer", durability: "journaled" },
  "agent.handoff_accepted": { level: "success", visibility: "drawer", durability: "journaled" },
  "agent.handoff_rejected": { level: "warning", visibility: "drawer", durability: "journaled" },
  "worktree.create_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "worktree.created": { level: "success", visibility: "drawer", durability: "journaled" },
  "worktree.ready": { level: "info", visibility: "hidden", durability: "journaled" },
  "worktree.leased": { level: "info", visibility: "drawer", durability: "journaled" },
  "worktree.dirty": { level: "warning", visibility: "drawer", durability: "journaled" },
  "worktree.proposal_created": { level: "info", visibility: "drawer", durability: "journaled" },
  "worktree.abandoned": { level: "warning", visibility: "drawer", durability: "journaled" },
  "worktree.delete_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "worktree.deleted": { level: "info", visibility: "drawer", durability: "journaled" },
  "worktree.recovery_required": { level: "error", visibility: "timeline", durability: "journaled" },
  "merge.started": { level: "info", visibility: "drawer", durability: "journaled" },
  "merge.preview_completed": { level: "info", visibility: "drawer", durability: "journaled" },
  "merge.conflicted": { level: "error", visibility: "timeline", durability: "journaled" },
  "merge.resolution_proposed": { level: "info", visibility: "drawer", durability: "journaled" },
  "merge.resolution_applied": { level: "success", visibility: "timeline", durability: "journaled" },
  "merge.committed": { level: "success", visibility: "timeline", durability: "journaled" },
  "merge.verification_started": { level: "info", visibility: "hidden", durability: "journaled" },
  "merge.verification_completed": { level: "success", visibility: "drawer", durability: "journaled" },
  "merge.failed": { level: "error", visibility: "timeline", durability: "journaled" },
  "plugin.discovered": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.installed": { level: "success", visibility: "drawer", durability: "journaled" },
  "plugin.updated": { level: "info", visibility: "drawer", durability: "journaled" },
  "plugin.enabled": { level: "info", visibility: "drawer", durability: "journaled" },
  "plugin.disabled": { level: "warning", visibility: "drawer", durability: "journaled" },
  "plugin.grant_requested": { level: "warning", visibility: "timeline", durability: "journaled" },
  "plugin.grant_resolved": { level: "info", visibility: "timeline", durability: "journaled" },
  "plugin.started": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.ready": { level: "success", visibility: "hidden", durability: "journaled" },
  "plugin.degraded": { level: "warning", visibility: "drawer", durability: "journaled" },
  "plugin.stopped": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.hook_started": { level: "info", visibility: "hidden", durability: "ephemeral" },
  "plugin.hook_completed": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.hook_failed": { level: "warning", visibility: "drawer", durability: "journaled" },
  "plugin.hook_denied": { level: "warning", visibility: "timeline", durability: "journaled" },
  "plugin.tool_registered": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.command_registered": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.agent_registered": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.context_proposed": { level: "info", visibility: "hidden", durability: "journaled" },
  "plugin.circuit_opened": { level: "error", visibility: "drawer", durability: "journaled" },
  "plugin.state_changed": { level: "info", visibility: "hidden", durability: "journaled" },
};

/**
 * §20.9 MUST-journal set: final text, tool intent/result summaries, approvals,
 * mutations, usage, and task transitions.
 */
export function mustJournal(kind: CbcEventKind): boolean {
  return KIND_DEFAULTS[kind].durability === "journaled";
}

export function defaultsForKind(kind: CbcEventKind) {
  return KIND_DEFAULTS[kind];
}

export interface EventFactoryOptions {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly parentEventId?: string;
  readonly correlationId?: string;
  readonly callerId?: string;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly level?: EventLevel;
  readonly visibility?: EventVisibility;
  readonly durability?: EventDurability;
  readonly timestamp?: string;
}

/**
 * Monotonic sequence generator. §20.10 requires strict monotonicity within a
 * session, which consumers rely on to detect dropped lines.
 */
export class EventSequencer {
  #next: number;
  #counter = 0;

  constructor(startAfter = 0) {
    this.#next = startAfter + 1;
  }

  get lastSequence(): number {
    return this.#next - 1;
  }

  nextSequence(): number {
    return this.#next++;
  }

  /** Continue after a journal sequence restored from durable storage. */
  advanceTo(sequence: number): void {
    if (Number.isInteger(sequence) && sequence >= this.lastSequence) {
      this.#next = sequence + 1;
    }
  }

  nextId(): string {
    this.#counter += 1;
    return `evt_${this.#next - 1}_${this.#counter.toString(36)}`;
  }
}

/** Build a fully-populated envelope with per-kind defaults applied. */
export function createEvent<T>(
  sequencer: EventSequencer,
  kind: CbcEventKind,
  payload: T,
  options: EventFactoryOptions,
): CbcEvent<T> {
  const defaults = KIND_DEFAULTS[kind];
  const sequence = sequencer.nextSequence();
  const base = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence,
    id: `evt_${sequence}`,
    timestamp: options.timestamp ?? new Date().toISOString(),
    sessionId: options.sessionId,
    kind,
    level: options.level ?? defaults.level,
    visibility: options.visibility ?? defaults.visibility,
    durability: options.durability ?? defaults.durability,
    payload,
  };
  // exactOptionalPropertyTypes: only attach optional keys when defined.
  const event: Record<string, unknown> = { ...base };
  if (options.turnId !== undefined) event.turnId = options.turnId;
  if (options.agentId !== undefined) event.agentId = options.agentId;
  if (options.parentEventId !== undefined) event.parentEventId = options.parentEventId;
  if (options.correlationId !== undefined) event.correlationId = options.correlationId;
  if (options.callerId !== undefined) event.callerId = options.callerId;
  if (options.taskEpochId !== undefined) event.taskEpochId = options.taskEpochId;
  if (options.workspaceIdentityDigest !== undefined) event.workspaceIdentityDigest = options.workspaceIdentityDigest;
  return event as unknown as CbcEvent<T>;
}

export interface EventValidationIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Validate an envelope from an untrusted source (a resumed journal, a replayed
 * fixture, or a third-party JSONL consumer round-trip).
 */
export function validateEvent(value: unknown): EventValidationIssue[] {
  const issues: EventValidationIssue[] = [];
  if (typeof value !== "object" || value === null) {
    return [{ field: ".", message: "event must be an object" }];
  }
  const event = value as Record<string, unknown>;

  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    issues.push({
      field: "schemaVersion",
      message: `expected "${EVENT_SCHEMA_VERSION}", got ${JSON.stringify(event.schemaVersion)}`,
    });
  }
  if (typeof event.sequence !== "number" || !Number.isInteger(event.sequence) || event.sequence < 1) {
    issues.push({ field: "sequence", message: "must be a positive integer" });
  }
  for (const field of ["id", "timestamp", "sessionId", "kind"]) {
    if (typeof event[field] !== "string" || (event[field] as string).length === 0) {
      issues.push({ field, message: "must be a non-empty string" });
    }
  }
  if (typeof event.kind === "string" && !isKnownEventKind(event.kind)) {
    // §20.10: consumers must be able to skip unknown kinds, so this is a
    // warning-shaped issue rather than a hard structural failure.
    issues.push({ field: "kind", message: `unknown event kind "${event.kind}"` });
  }
  if (typeof event.kind === "string" && (V13_ANCESTRY_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    for (const field of ["turnId", "agentId", "callerId", "taskEpochId"]) {
      if (typeof event[field] !== "string" || (event[field] as string).length === 0) issues.push({ field, message: `v1.3 ${event.kind} requires ${field} ancestry` });
    }
  }
  if (!["debug", "info", "success", "warning", "error"].includes(event.level as string)) {
    issues.push({ field: "level", message: "invalid level" });
  }
  if (!["timeline", "live", "drawer", "hidden"].includes(event.visibility as string)) {
    issues.push({ field: "visibility", message: "invalid visibility" });
  }
  if (
    event.durability !== undefined &&
    !["ephemeral", "journaled"].includes(event.durability as string)
  ) {
    issues.push({ field: "durability", message: "invalid durability" });
  }
  if (!("payload" in event)) {
    issues.push({ field: "payload", message: "payload is required" });
  }
  if (typeof event.timestamp === "string" && Number.isNaN(Date.parse(event.timestamp))) {
    issues.push({ field: "timestamp", message: "must be an ISO 8601 timestamp" });
  }
  return issues;
}

/** Serialize to one JSONL line (§20.10). */
export function toJsonl(event: CbcEvent): string {
  return JSON.stringify(event);
}

/** Parse one JSONL line, returning `undefined` for unparseable input. */
export function fromJsonl(line: string): CbcEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const issues = validateEvent(parsed);
    if (issues.length === 0) return parsed as CbcEvent;
    // §20.10: an unrecognized kind is a version skew, not corruption. A consumer
    // must be able to skip the event, so it is handed through (the reducer's
    // default branch ignores it) instead of being dropped like a malformed line.
    // Any structural problem still rejects the whole event.
    const onlyUnknownKind = issues.every(
      (issue) => issue.field === "kind" && issue.message.startsWith("unknown event kind"),
    );
    if (onlyUnknownKind) return parsed as CbcEvent;
    return undefined;
  } catch {
    return undefined;
  }
}
