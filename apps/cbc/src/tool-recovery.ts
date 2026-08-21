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

export interface ToolRecoveryRunnerOptions {
  readonly mode?: "off" | "safe" | "full";
  readonly maxAttempts?: number;
  readonly sessionId?: string;
  readonly emit?: <T>(kind: RecoveryEventKind, payload: T) => void;
  readonly reconcile?: (input: ToolRecoveryReconcileInput) => Promise<ToolExecution | undefined>;
  readonly rebase?: (input: ToolRecoveryRebaseInput) => Promise<ProposedAction | undefined> | ProposedAction | undefined;
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
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) return cancellationExecution();

    let execution: ToolExecution;
    try {
      execution = await executor.execute(currentAction, signal);
    } catch (error) {
      execution = {
        result: errorResult("INTERNAL", asErrorMessage(error), { retryable: true }),
      };
    }
    if (execution.result.ok) return execution;

    const failure = asFailure(execution);
    const decision = decideRecovery({ tool, failure, attempt });
    emit("tool.attempt_failed", {
      operationId,
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
        callId: currentAction.callId,
        toolId: currentAction.toolId,
        attempt,
        resolved: false,
        reason: "runtime could not prove that the operation committed",
      });
    }

    if (!decision.retry || attempt >= maxAttempts) {
      if (attempt > 1 || decision.recoveryClass !== "terminal" || decision.reconcile) {
        emit("tool.recovery_exhausted", {
          operationId,
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          code: failure.code,
          recoveryClass: decision.recoveryClass,
          reason: decision.reason,
        });
      }
      return execution;
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
          callId: currentAction.callId,
          toolId: currentAction.toolId,
          attempt,
          code: failure.code,
          recoveryClass: decision.recoveryClass,
          reason: "state rebase did not produce a new action",
        });
        return execution;
      }
      currentAction = rebased;
    }

    emit("tool.recovery_applied", {
      operationId,
      callId: currentAction.callId,
      toolId: currentAction.toolId,
      attempt,
      nextAttempt: attempt + 1,
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
