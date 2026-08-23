import type { CbcEventKind } from "@cbc/protocol";
import type { ProposedAction } from "@cbc/permissions";
import {
  decideRecovery,
  errorResult,
  type RecoveryClass,
  type ToolDefinition,
  type ToolResult,
} from "@cbc/tool-registry";
import type { ToolExecutor } from "@cbc/agent-kernel";

export type ToolExecution = Awaited<ReturnType<ToolExecutor["execute"]>>;
export type RecoveryEventKind = Extract<
  CbcEventKind,
  | "tool.attempt_failed"
  | "tool.recovery_applied"
  | "tool.reconciled"
  | "tool.recovery_exhausted"
>;

export interface ToolRecoveryReconcileInput {
  readonly action: ProposedAction;
  readonly execution: ToolExecution;
  readonly operationId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface ToolRecoveryRebaseInput {
  readonly action: ProposedAction;
  readonly execution: ToolExecution;
  readonly operationId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface ToolRecoveryStateFenceInput {
  readonly action: ProposedAction;
  readonly execution: ToolExecution;
  readonly operationId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface ToolRecoveryRunnerOptions {
  readonly mode?: "off" | "safe" | "full";
  readonly maxAttempts?: number;
  readonly sessionId?: string;
  readonly emit?: <T>(kind: RecoveryEventKind, payload: T) => void;
  readonly reconcile?: (input: ToolRecoveryReconcileInput) => Promise<ToolExecution | undefined>;
  readonly rebase?: (input: ToolRecoveryRebaseInput) => Promise<ProposedAction | undefined> | ProposedAction | undefined;
  readonly stateFence?: (input: ToolRecoveryStateFenceInput) => Promise<boolean | void>;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asFailure(execution: ToolExecution): {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
} {
  const failure = execution.result.error;
  return {
    code: failure?.code ?? "INTERNAL",
    retryable: failure?.retryable === true,
    ...(failure?.details === undefined ? {} : { details: failure.details }),
  };
}

function cancellationExecution(): ToolExecution {
  return { result: errorResult("CANCELLED", "tool recovery cancelled", { retryable: false }) };
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("tool recovery cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withRecoveryExhaustedSummary(execution: ToolExecution, summary: string | undefined): ToolExecution {
  if (summary === undefined) return execution;
  const line = `Recovery exhausted ${summary}`;
  const text = execution.text?.trim();
  return {
    ...execution,
    text: text === undefined || text.length === 0 ? line : `${text}\n${line}`,
  };
}

function pathChangedTransition(failure: ReturnType<typeof asFailure>): string | undefined {
  if (failure.code.toUpperCase() !== "PATH_CHANGED") return undefined;
  const details = failure.details;
  if (details === undefined) return undefined;
  const path = typeof details.path === "string" ? details.path : "<workspace>";
  const before = details.generationBefore;
  const after = details.generationAfter;
  if ((typeof before !== "number" && before !== null) || (typeof after !== "number" && after !== null)) {
    return undefined;
  }
  return `${path}:${String(before)}->${String(after)}`;
}

function quiescenceFailure(execution: ToolExecution): ToolExecution {
  const details = execution.result.error?.details;
  return {
    ...execution,
    result: errorResult(
      "PATH_CHANGED",
      "the workspace did not become quiescent after a stale read; stop concurrent writers and retry",
      {
        retryable: false,
        details: { ...(details ?? {}), quiescence: "not_reached" },
      },
    ),
  };
}

/**
 * Execute one logical tool call while keeping physical attempts internal.
 *
 * The caller owns the visible `tool.started`/`tool.completed`/`tool.failed`
 * lifecycle. This runner emits only hidden recovery telemetry and returns one
 * final execution, so retries cannot duplicate model-visible observations.
 */
export async function executeWithRecovery(
  executor: ToolExecutor,
  tool: ToolDefinition,
  action: ProposedAction,
  signal: AbortSignal,
  options: ToolRecoveryRunnerOptions = {},
): Promise<ToolExecution> {
  if (options.mode === "off") return await executor.execute(action, signal);

  const operationId = `${options.sessionId ?? "session"}:${action.callId}`;
  const configuredMax = options.maxAttempts ?? tool.recovery?.maxAttempts ?? 1;
  const toolMax = tool.recovery?.maxAttempts ?? configuredMax;
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(configuredMax), Math.floor(toolMax)));
  const sleep = options.sleep ?? defaultSleep;
  const emit = <T>(kind: RecoveryEventKind, payload: T): void => {
    try {
      options.emit?.(kind, payload);
    } catch {
      // Recovery telemetry is observational and must never change tool truth.
    }
  };

  let currentAction = action;
  const fencedPathChangedTransitions = new Set<string>();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptId = `${operationId}:attempt-${attempt}`;
    if (signal.aborted) return cancellationExecution();

    let execution: ToolExecution;
    try {
      execution = await executor.execute(currentAction, signal);
    } catch (error) {
      execution = {
        result: errorResult("INTERNAL", asErrorMessage(error), { retryable: true }),
      };
    }
    // Abort is terminal for the logical call. Do not classify an executor-side
    // abort as a transient INTERNAL failure and start another physical attempt.
    if (signal.aborted) return cancellationExecution();
    if (execution.result.ok) return execution;

    const failure = asFailure(execution);
    const decision = decideRecovery({ tool, failure, attempt });
    emit("tool.attempt_failed", {
      operationId,
      attemptId,
      callId: currentAction.callId,
      toolId: currentAction.toolId,
      attempt,
      code: failure.code,
      recoveryClass: decision.recoveryClass,
      retryable: failure.retryable,
      reason: decision.reason,
    });

    if (decision.reconcile) {
      let reconciled: ToolExecution | undefined;
      try {
        reconciled = await options.reconcile?.({
          action: currentAction,
          execution,
          operationId,
          attempt,
          signal,
        });
      } catch (error) {
        emit("tool.reconciled", {
          operationId,
          attemptId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          resolved: false,
          message: asErrorMessage(error),
        });
      }
      if (reconciled !== undefined) {
        emit("tool.reconciled", {
          operationId,
          attemptId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          resolved: reconciled.result.ok,
          summary: reconciled.result.summary,
        });
        return reconciled;
      }
      emit("tool.reconciled", {
        operationId,
        attemptId,
        callId: currentAction.callId,
        toolId: currentAction.toolId,
        attempt,
        resolved: false,
        reason: "runtime could not prove that the operation committed",
      });
    }

    if (!decision.retry || attempt >= maxAttempts) {
      const recoveryAttempted = attempt > 1 || decision.recoveryClass !== "terminal" || decision.reconcile;
      if (recoveryAttempted) {
        emit("tool.recovery_exhausted", {
          operationId,
          attemptId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          code: failure.code,
          recoveryClass: decision.recoveryClass,
          reason: decision.reason,
        });
      }
      return withRecoveryExhaustedSummary(
        execution,
        recoveryAttempted
          ? `after ${attempt} attempt${attempt === 1 ? "" : "s"} (${decision.recoveryClass}): ${decision.reason}`
          : undefined,
      );
    }

    if (decision.recoveryClass === "state_fence_wait") {
      const transition = pathChangedTransition(failure);
      if (transition !== undefined && fencedPathChangedTransitions.has(transition)) {
        emit("tool.recovery_exhausted", {
          operationId,
          attemptId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          code: failure.code,
          recoveryClass: decision.recoveryClass,
          reason: "the same workspace generation transition recurred after a quiescence fence",
        });
        return withRecoveryExhaustedSummary(
          quiescenceFailure(execution),
          "the same PATH_CHANGED generation transition recurred after one quiescence fence",
        );
      }
      if (transition !== undefined) fencedPathChangedTransitions.add(transition);
      let quiescent = true;
      try {
        quiescent = (await options.stateFence?.({
          action: currentAction,
          execution,
          operationId,
          attempt,
          signal,
        })) !== false;
      } catch {
        quiescent = false;
      }
      if (!quiescent || signal.aborted) {
        emit("tool.recovery_exhausted", {
          operationId,
          attemptId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          code: failure.code,
          recoveryClass: decision.recoveryClass,
          reason: "the workspace did not become quiescent before replay",
        });
        return withRecoveryExhaustedSummary(
          quiescenceFailure(execution),
          "state_fence_wait could not establish workspace quiescence",
        );
      }
    }

    if (decision.recoveryClass === "state_rebase") {
      const rebased = await options.rebase?.({
        action: currentAction,
        execution,
        operationId,
        attempt,
        signal,
      });
      if (rebased === undefined) {
        emit("tool.recovery_exhausted", {
          operationId,
          attemptId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          code: failure.code,
          recoveryClass: decision.recoveryClass,
          reason: "state rebase did not produce a new action",
        });
        return withRecoveryExhaustedSummary(execution, "state_rebase did not produce a new action");
      }
      currentAction = rebased;
    }

    emit("tool.recovery_applied", {
      operationId,
      attemptId,
      callId: currentAction.callId,
      toolId: currentAction.toolId,
      attempt,
      nextAttempt: attempt + 1,
      nextAttemptId: `${operationId}:attempt-${attempt + 1}`,
      recoveryClass: decision.recoveryClass,
      delayMs: decision.delayMs,
      ...(decision.recoveryClass === "state_rebase" ? { actionRebased: true } : {}),
    });
    try {
      await sleep(decision.delayMs, signal);
    } catch {
      return cancellationExecution();
    }
  }

  return cancellationExecution();
}

export function recoveryClassForFailure(
  tool: ToolDefinition,
  execution: ToolExecution,
  attempt = 1,
): RecoveryClass {
  const failure = asFailure(execution);
  return decideRecovery({ tool, failure, attempt }).recoveryClass;
}

export function executionErrorResult(execution: ToolExecution): ToolResult | undefined {
  return execution.result.ok ? undefined : execution.result;
}
