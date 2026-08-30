/**
 * Public programmatic-tool lane entry point.
 *
 * The policy implementation lives in `native-lanes.ts`; this file gives the
 * protocol a stable name and a small coordinator that can be used by a
 * Responses adapter without ever acquiring filesystem or process authority.
 */

export * from "./native-lanes.ts";

import {
  DEFAULT_PROGRAM_POLICY,
  sanitizeProgramOutput,
  validateProgramEvidenceResult,
  validateProgramToolCall,
  type ProgramEvidenceDecision,
  type ProgramOutput,
  type ProgramPolicy,
  type ProgramToolCall,
} from "./native-lanes.ts";

export interface ProgramLaneRequest {
  readonly programId: string;
  /** The provider program call_id copied from nested function-call caller metadata. */
  readonly callerId: string;
  readonly taskEpochId: string;
  readonly calls: readonly Partial<ProgramToolCall>[];
  /** Host-observed calls already completed for this program before this pause. */
  readonly callsUsed?: number;
  readonly source?: string;
  readonly sourceBytes?: number;
  readonly intermediateBytes?: number;
  readonly elapsedMs?: number;
  readonly loopIterations?: number;
}

export type ProgramCoordinatorState =
  | "idle"
  | "program_received"
  | "call_admitted"
  | "host_execution"
  | "output_validated"
  | "output_submitted"
  | "program_resumed"
  | "program_completed"
  | "fallback"
  | "denied";

export interface ProgramCoordinatorEvent {
  readonly state: ProgramCoordinatorState;
  readonly programId: string;
  readonly callId?: string;
  readonly detail?: string;
}

export interface ProgramCallOutput {
  readonly callId: string;
  readonly callerId: string;
  readonly output: ProgramOutput;
}

export interface ProgramExecutionStats {
  readonly calls: number;
  readonly parallelPeak: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly elapsedMs: number;
  readonly retries: number;
}

export interface ProgramLaneResult {
  readonly accepted: boolean;
  readonly programId: string;
  readonly state: ProgramCoordinatorState;
  readonly outputs: readonly ProgramCallOutput[];
  readonly denied: readonly { callId?: string; code: string; message: string }[];
  readonly reason: string;
  readonly stats: ProgramExecutionStats;
}

export interface ProgramToolExecutor {
  execute(call: ProgramToolCall, signal: AbortSignal): Promise<unknown>;
}

export interface ProgramExecutionOptions {
  readonly signal?: AbortSignal;
  readonly emit?: (event: ProgramCoordinatorEvent) => void;
  readonly now?: () => number;
}

/**
 * Incremental coordinator. Execution remains injected by the host; this class
 * validates ancestry, limits, and output bounds before any read-only call can
 * cross the existing authority boundary.
 */
export class ProgrammaticToolLane {
  readonly #policy: ProgramPolicy;

  constructor(policy: Partial<ProgramPolicy> = {}) {
    const allowedToolIds = policy.allowedToolIds ?? policy.allowlist;
    this.#policy = {
      ...DEFAULT_PROGRAM_POLICY,
      ...policy,
      ...(allowedToolIds !== undefined ? { allowedToolIds, allowlist: allowedToolIds } : {}),
      failOpen: false,
    };
  }

  admit(request: ProgramLaneRequest): ProgramLaneResult {
    const denied: Array<{ callId?: string; code: string; message: string }> = [];
    const stats = emptyStats(request);
    if (typeof request.programId !== "string" || request.programId.length === 0 || typeof request.callerId !== "string" || request.callerId.length === 0 || typeof request.taskEpochId !== "string" || request.taskEpochId.length === 0) {
      return { accepted: false, programId: request.programId, state: "denied", outputs: [], denied: [{ code: "ancestry_missing", message: "programId, callerId, and taskEpochId are required" }], reason: "program ancestry is incomplete", stats };
    }
    const sourceBytes = request.source === undefined ? request.sourceBytes : byteLength(request.source);
    if (sourceBytes !== undefined && (!Number.isFinite(sourceBytes) || sourceBytes < 0 || sourceBytes > (this.#policy.maxProgramBytes ?? Number.POSITIVE_INFINITY))) {
      return { accepted: false, programId: request.programId, state: "denied", outputs: [], denied: [{ code: "program_budget", message: "program source exceeds the byte budget" }], reason: "program byte budget exceeded", stats };
    }
    if (request.intermediateBytes !== undefined && (!Number.isFinite(request.intermediateBytes) || request.intermediateBytes < 0 || request.intermediateBytes > (this.#policy.maxIntermediateBytes ?? Number.POSITIVE_INFINITY))) {
      return { accepted: false, programId: request.programId, state: "denied", outputs: [], denied: [{ code: "intermediate_budget", message: "program intermediate data exceeds the byte budget" }], reason: "program intermediate budget exceeded", stats };
    }
    if (request.elapsedMs !== undefined && (!Number.isFinite(request.elapsedMs) || request.elapsedMs < 0 || request.elapsedMs > (this.#policy.maxWallTimeMs ?? Number.POSITIVE_INFINITY))) {
      return { accepted: false, programId: request.programId, state: "denied", outputs: [], denied: [{ code: "wall_time_budget", message: "program wall time exceeds the budget" }], reason: "program wall-time budget exceeded", stats };
    }
    if ((request.loopIterations ?? 0) > (this.#policy.maxLoopIterations ?? 0) || (request.loopIterations ?? 0) > 0 && this.#policy.allowLoops !== true) {
      return { accepted: false, programId: request.programId, state: "denied", outputs: [], denied: [{ code: "loop_denied", message: "program loops are disabled or exceed the iteration budget" }], reason: "program loop policy denied", stats };
    }
    if (
      request.callsUsed !== undefined &&
      (!Number.isSafeInteger(request.callsUsed) || request.callsUsed < 0)
    ) {
      return {
        accepted: false,
        programId: request.programId,
        state: "denied",
        outputs: [],
        denied: [{ code: "program_budget", message: "prior program call usage is invalid" }],
        reason: "program call usage is invalid",
        stats,
      };
    }
    let callsUsed = request.callsUsed ?? 0;
    const callIds = new Set<string>();
    for (const call of request.calls) {
      if (typeof call.callId !== "string" || call.callId.length === 0 || callIds.has(call.callId)) {
        denied.push({ ...(typeof call.callId === "string" ? { callId: call.callId } : {}), code: "call_id_invalid", message: "program call ids must be non-empty and unique" });
        continue;
      }
      callIds.add(call.callId);
      const decision = validateProgramToolCall(call, this.#policy, {
        callsUsed,
        expectedCallerId: request.callerId,
        expectedTaskEpochId: request.taskEpochId,
      });
      if (!decision.allowed) denied.push({ ...(typeof call.callId === "string" ? { callId: call.callId } : {}), code: decision.code, message: decision.message });
      else callsUsed += 1;
    }
    return denied.length > 0
      ? { accepted: false, programId: request.programId, state: "denied", outputs: [], denied, reason: "one or more program calls were denied", stats }
      : { accepted: true, programId: request.programId, state: "call_admitted", outputs: [], denied: [], reason: "read-only program admitted", stats };
  }

  boundOutput(value: unknown): ProgramOutput {
    return sanitizeProgramOutput(value, this.#policy.maxOutputBytes);
  }

  /**
   * Execute one paused program batch through a host-owned read-only executor.
   * The generated JavaScript never runs here; only provider-returned function
   * calls cross this boundary.
   */
  async run(
    request: ProgramLaneRequest,
    executor: ProgramToolExecutor,
    options: ProgramExecutionOptions = {},
  ): Promise<ProgramLaneResult> {
    const signal = options.signal ?? new AbortController().signal;
    const now = options.now ?? (() => Date.now());
    const startedAt = now();
    const emit = (state: ProgramCoordinatorState, callId?: string, detail?: string): void => {
      options.emit?.({ state, programId: request.programId, ...(callId !== undefined ? { callId } : {}), ...(detail !== undefined ? { detail } : {}) });
    };
    emit("program_received");
    const admission = this.admit(request);
    if (!admission.accepted) {
      emit("denied", undefined, admission.reason);
      return admission;
    }

    const calls = request.calls as readonly ProgramToolCall[];
    const outputs: Array<ProgramCallOutput | undefined> = new Array(calls.length);
    const denied: Array<{ callId?: string; code: string; message: string }> = [];
    const maxParallel = Math.max(1, Math.min(this.#policy.maxParallelCalls, calls.length || 1));
    const maxWallTimeMs = Math.max(1, this.#policy.maxWallTimeMs ?? 30_000);
    const maxIntermediateBytes = Math.max(0, this.#policy.maxIntermediateBytes ?? Number.POSITIVE_INFINITY);
    let cursor = 0;
    let active = 0;
    let parallelPeak = 0;
    let outputBytes = 0;
    let callsExecuted = 0;
    let retries = 0;
    let stopped = false;

    const worker = async (): Promise<void> => {
      while (!stopped && !signal.aborted) {
        const index = cursor;
        cursor += 1;
        const call = calls[index];
        if (call === undefined) return;
        const elapsed = Math.max(0, now() - startedAt) + Math.max(0, request.elapsedMs ?? 0);
        const remainingMs = maxWallTimeMs - elapsed;
        if (remainingMs <= 0) {
          denied.push({ callId: call.callId, code: "wall_time_budget", message: "program wall-time budget was exhausted before execution" });
          stopped = true;
          return;
        }
        emit("call_admitted", call.callId);
        active += 1;
        parallelPeak = Math.max(parallelPeak, active);
        emit("host_execution", call.callId);
        try {
          const executed = await executeWithRetry(
            executor,
            call,
            signal,
            remainingMs,
            Math.max(0, Math.floor(this.#policy.maxRetries ?? 0)),
          );
          retries += executed.retries;
          callsExecuted += 1;
          const output = this.boundOutput(executed.value);
          outputBytes += output.bytes;
          if (outputBytes + Math.max(0, request.intermediateBytes ?? 0) > maxIntermediateBytes) {
            denied.push({ callId: call.callId, code: "intermediate_budget", message: "program intermediate data exceeded the byte budget" });
            stopped = true;
            emit("fallback", call.callId, "intermediate byte budget exceeded");
            return;
          }
          outputs[index] = { callId: call.callId, callerId: call.callerId, output };
          emit("output_validated", call.callId);
          emit("output_submitted", call.callId);
        } catch (error) {
          denied.push({
            callId: call.callId,
            code: signal.aborted ? "cancelled" : "execution_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          stopped = true;
          emit("fallback", call.callId, "host execution failed");
        } finally {
          active -= 1;
        }
      }
    };

    await Promise.all(Array.from({ length: maxParallel }, () => worker()));
    const stats: ProgramExecutionStats = {
      calls: callsExecuted,
      parallelPeak,
      inputBytes: inputBytes(request),
      outputBytes,
      elapsedMs: Math.max(0, now() - startedAt) + Math.max(0, request.elapsedMs ?? 0),
      retries,
    };
    if (signal.aborted || denied.length > 0) {
      return {
        accepted: false,
        programId: request.programId,
        state: "fallback",
        outputs: outputs.filter((entry): entry is ProgramCallOutput => entry !== undefined),
        denied,
        reason: signal.aborted ? "program execution was cancelled" : "program execution requires direct fallback",
        stats,
      };
    }
    emit("program_resumed");
    return {
      accepted: true,
      programId: request.programId,
      state: "program_resumed",
      outputs: outputs.filter((entry): entry is ProgramCallOutput => entry !== undefined),
      denied: [],
      reason: "all read-only outputs are ready to resume the hosted program",
      stats,
    };
  }

  /** Validate the eventual program_output before accepting it as evidence. */
  complete(
    result: unknown,
    expected: { readonly taskEpochId: string; readonly workspaceIdentityDigest: string },
    emit?: (event: ProgramCoordinatorEvent) => void,
    programId = "unknown-program",
  ): ProgramEvidenceDecision {
    const decision = validateProgramEvidenceResult(result, expected);
    emit?.({
      state: decision.accepted ? "program_completed" : "denied",
      programId,
      detail: decision.accepted ? "program evidence accepted" : decision.errors.join("; "),
    });
    return decision;
  }
}

function emptyStats(request: ProgramLaneRequest): ProgramExecutionStats {
  return {
    calls: 0,
    parallelPeak: 0,
    inputBytes: inputBytes(request),
    outputBytes: 0,
    elapsedMs: Math.max(0, request.elapsedMs ?? 0),
    retries: 0,
  };
}

function inputBytes(request: ProgramLaneRequest): number {
  const sourceBytes = request.source === undefined ? Math.max(0, request.sourceBytes ?? 0) : byteLength(request.source);
  return sourceBytes + request.calls.reduce((total, call) => total + byteLength(JSON.stringify(call.arguments ?? {})), 0);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function executeWithRetry(
  executor: ProgramToolExecutor,
  call: ProgramToolCall,
  signal: AbortSignal,
  timeoutMs: number,
  maxRetries: number,
): Promise<{ readonly value: unknown; readonly retries: number }> {
  let retries = 0;
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  while (true) {
    try {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error("program wall-time budget exceeded");
      const timeoutSignal = AbortSignal.timeout(remainingMs);
      const effectiveSignal = AbortSignal.any([signal, timeoutSignal]);
      return {
        value: await withTimeout(executor.execute(call, effectiveSignal), effectiveSignal, remainingMs),
        retries,
      };
    } catch (error) {
      if (signal.aborted || retries >= maxRetries || !retryable(error)) throw error;
      retries += 1;
    }
  }
}

function withTimeout<T>(pending: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("program execution aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("program wall-time budget exceeded")), Math.max(1, timeoutMs));
    const abort = (): void => reject(new DOMException("program execution aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { readonly retryable?: unknown }).retryable === true;
}
