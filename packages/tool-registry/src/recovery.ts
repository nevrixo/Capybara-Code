import type { ToolDefinition, ToolExecutionMetadata, ToolIdempotency, ToolRecoveryMetadata } from "./catalog.ts";

export type RecoveryClass =
  | "input_repair"
  | "state_rebase"
  | "state_fence_wait"
  | "transient_safe_replay"
  | "unknown_outcome_reconcile"
  | "terminal";

export interface ToolRecoveryPolicy {
  readonly maxAttempts: number;
  readonly retryableCodes: readonly string[];
  readonly retrySafety: ToolRecoveryMetadata["retrySafety"];
  readonly reconcile?: ToolRecoveryMetadata["reconcile"];
}

export interface RecoveryFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface RecoveryDecision {
  readonly recoveryClass: RecoveryClass;
  readonly retry: boolean;
  readonly reconcile: boolean;
  readonly terminal: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

const NEVER_RETRY = new Set([
  "APPROVAL_DENIED",
  "PERMISSION_DENIED",
  "CANCELLED",
  "INVALID_ARGUMENT",
  "PROCESS_EXIT_NONZERO",
  "PROCESS_FAILED",
  "COMMAND_NOT_FOUND",
  "AUTHENTICATION",
  "HASH_MISMATCH_SCOPE",
]);

const DEFAULT_RETRYABLE = new Set([
  "INTERNAL",
  "NOT_INITIALIZED",
  "TIMEOUT",
  "PATH_CHANGED",
  "HASH_MISMATCH",
  "NETWORK_UNAVAILABLE",
  "RATE_LIMITED",
  "TEMPORARY_UNAVAILABLE",
  "MCP_TRANSPORT",
]);

export function defaultRecoveryPolicy(metadata: Pick<ToolExecutionMetadata, "idempotency" | "authority">): ToolRecoveryPolicy {
  const reconcilable = metadata.idempotency === "reconcilable" || metadata.authority === "process" || metadata.authority === "external_effect";
  return {
    maxAttempts: metadata.idempotency === "pure" || metadata.idempotency === "idempotent" || metadata.idempotency === "reconcilable" ? 3 : 1,
    retryableCodes: [...DEFAULT_RETRYABLE],
    retrySafety: reconcilable ? "reconcile" : metadata.idempotency === "pure" || metadata.idempotency === "idempotent" ? "always" : "never",
    ...(metadata.authority === "process" ? { reconcile: "process_job" as const } : metadata.authority === "external_effect" ? { reconcile: "mcp_operation" as const } : {}),
  };
}

function policyFor(tool: Pick<ToolDefinition, "idempotency" | "authority" | "recovery">): ToolRecoveryPolicy {
  const fallback = defaultRecoveryPolicy({
    idempotency: (tool.idempotency ?? "non_idempotent") as ToolIdempotency,
    authority: tool.authority ?? "read",
  });
  return {
    ...fallback,
    ...(tool.recovery?.maxAttempts === undefined ? {} : { maxAttempts: Math.max(1, Math.floor(tool.recovery.maxAttempts)) }),
    ...(tool.recovery?.retryableCodes === undefined ? {} : { retryableCodes: [...tool.recovery.retryableCodes] }),
    ...(tool.recovery?.retrySafety === undefined ? {} : { retrySafety: tool.recovery.retrySafety }),
    ...(tool.recovery?.reconcile === undefined ? {} : { reconcile: tool.recovery.reconcile }),
  };
}

/** Pure decision matrix: it never invokes a transport or mutates state. */
export function decideRecovery(input: {
  readonly tool: Pick<ToolDefinition, "idempotency" | "authority" | "recovery">;
  readonly failure: RecoveryFailure;
  readonly attempt: number;
}): RecoveryDecision {
  const { tool, failure } = input;
  const policy = policyFor(tool);
  const attempt = Math.max(1, Math.floor(input.attempt));
  const code = failure.code.toUpperCase();
  const delayMs = Math.min(1_000, 25 * 2 ** Math.max(0, attempt - 1));
  if (NEVER_RETRY.has(code)) {
    return { recoveryClass: "terminal", retry: false, reconcile: false, terminal: true, delayMs: 0, reason: `${code} is terminal` };
  }
  if (code === "TODO_REVISION_CONFLICT" && tool.authority === "session_state" && attempt < policy.maxAttempts) {
    return { recoveryClass: "state_rebase", retry: true, reconcile: false, terminal: false, delayMs: 0, reason: "progress-only session state may be rebased once" };
  }
  const retryable = failure.retryable && (policy.retryableCodes.includes(code) || DEFAULT_RETRYABLE.has(code));
  if (code === "PATH_CHANGED" && retryable && attempt < policy.maxAttempts && (tool.idempotency === "pure" || tool.idempotency === "idempotent") && policy.retrySafety !== "never") {
    return { recoveryClass: "state_fence_wait", retry: true, reconcile: false, terminal: false, delayMs: 0, reason: "PATH_CHANGED requires a workspace quiescence fence before replay" };
  }
  if (retryable && attempt < policy.maxAttempts && (tool.idempotency === "pure" || tool.idempotency === "idempotent") && policy.retrySafety !== "never") {
    return { recoveryClass: "transient_safe_replay", retry: true, reconcile: false, terminal: false, delayMs, reason: `${code} is safe to replay for ${tool.idempotency} operation` };
  }
  if (retryable && (tool.idempotency === "reconcilable" || tool.authority === "process" || tool.authority === "external_effect") && policy.reconcile !== undefined) {
    return { recoveryClass: "unknown_outcome_reconcile", retry: false, reconcile: true, terminal: false, delayMs: 0, reason: `${code} requires ${policy.reconcile} reconciliation before replay` };
  }
  return { recoveryClass: "terminal", retry: false, reconcile: false, terminal: true, delayMs: 0, reason: retryable ? "recovery budget or safety contract is exhausted" : `${code} is not retryable` };
}

/** Convenience classifier for callers that only need the recovery class. */
export function classifyRecovery(
  tool: Pick<ToolDefinition, "idempotency" | "authority" | "recovery">,
  failure: RecoveryFailure,
  attempt = 1,
): RecoveryClass {
  return decideRecovery({ tool, failure, attempt }).recoveryClass;
}