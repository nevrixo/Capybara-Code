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
  validateProgramToolCall,
  type ProgramOutput,
  type ProgramPolicy,
  type ProgramToolCall,
} from "./native-lanes.ts";

export interface ProgramLaneRequest {
  readonly programId: string;
  readonly callerId: string;
  readonly taskEpochId: string;
  readonly calls: readonly Partial<ProgramToolCall>[];
  readonly sourceBytes?: number;
  readonly intermediateBytes?: number;
  readonly elapsedMs?: number;
  readonly loopIterations?: number;
}

export interface ProgramLaneResult {
  readonly accepted: boolean;
  readonly programId: string;
  readonly outputs: readonly ProgramOutput[];
  readonly denied: readonly { callId?: string; code: string; message: string }[];
  readonly reason: string;
}

/**
 * Admission-only coordinator. Execution remains injected by the host; this
 * class validates ancestry, limits, and output bounds before a caller can
 * invoke its own read-only tool bridge.
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
    if (typeof request.programId !== "string" || request.programId.length === 0 || typeof request.callerId !== "string" || request.callerId.length === 0 || typeof request.taskEpochId !== "string" || request.taskEpochId.length === 0) {
      return { accepted: false, programId: request.programId, outputs: [], denied: [{ code: "ancestry_missing", message: "programId, callerId, and taskEpochId are required" }], reason: "program ancestry is incomplete" };
    }
    if (request.sourceBytes !== undefined && (!Number.isFinite(request.sourceBytes) || request.sourceBytes < 0 || request.sourceBytes > (this.#policy.maxProgramBytes ?? Number.POSITIVE_INFINITY))) {
      return { accepted: false, programId: request.programId, outputs: [], denied: [{ code: "program_budget", message: "program source exceeds the byte budget" }], reason: "program byte budget exceeded" };
    }
    if (request.intermediateBytes !== undefined && (!Number.isFinite(request.intermediateBytes) || request.intermediateBytes < 0 || request.intermediateBytes > (this.#policy.maxIntermediateBytes ?? Number.POSITIVE_INFINITY))) {
      return { accepted: false, programId: request.programId, outputs: [], denied: [{ code: "intermediate_budget", message: "program intermediate data exceeds the byte budget" }], reason: "program intermediate budget exceeded" };
    }
    if (request.elapsedMs !== undefined && (!Number.isFinite(request.elapsedMs) || request.elapsedMs < 0 || request.elapsedMs > (this.#policy.maxWallTimeMs ?? Number.POSITIVE_INFINITY))) {
      return { accepted: false, programId: request.programId, outputs: [], denied: [{ code: "wall_time_budget", message: "program wall time exceeds the budget" }], reason: "program wall-time budget exceeded" };
    }
    if ((request.loopIterations ?? 0) > (this.#policy.maxLoopIterations ?? 0) || (request.loopIterations ?? 0) > 0 && this.#policy.allowLoops !== true) {
      return { accepted: false, programId: request.programId, outputs: [], denied: [{ code: "loop_denied", message: "program loops are disabled or exceed the iteration budget" }], reason: "program loop policy denied" };
    }
    let callsUsed = 0;
    for (const call of request.calls) {
      const decision = validateProgramToolCall(call, this.#policy, {
        callsUsed,
      });
      if (!decision.allowed) denied.push({ ...(typeof call.callId === "string" ? { callId: call.callId } : {}), code: decision.code, message: decision.message });
      else callsUsed += 1;
    }
    return denied.length > 0
      ? { accepted: false, programId: request.programId, outputs: [], denied, reason: "one or more program calls were denied" }
      : { accepted: true, programId: request.programId, outputs: [], denied: [], reason: "read-only program admitted" };
  }

  boundOutput(value: unknown): ProgramOutput {
    return sanitizeProgramOutput(value, this.#policy.maxOutputBytes);
  }
}
