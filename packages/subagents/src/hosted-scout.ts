/**
 * Hosted Scout Lane adapter.
 *
 * A provider may execute a bounded read-only scout, but CBC still owns the
 * admission decision and accepts only an identity-matched evidence capsule.
 * The transport is injected so tests and local providers cannot accidentally
 * acquire a shell, patch, credential, or external-side-effect capability.
 */

import {
  acceptHostedScoutReport,
  DEFAULT_HOSTED_SCOUT_POLICY,
  validateHostedScoutRequest,
  type HostedScoutPolicy,
  type HostedScoutReport,
  type HostedScoutRequest,
} from "@cbc/provider-openai";

export interface HostedScoutTransport {
  spawn(request: HostedScoutRequest, signal: AbortSignal): Promise<HostedScoutReport>;
}

export interface HostedScoutEmitter {
  emit(
    kind:
      | "hosted_agent.spawned"
      | "hosted_agent.progress"
      | "hosted_agent.completed"
      | "hosted_agent.cancelled"
      | "hosted_agent.fallback_local"
      | "hosted_agent.evidence_rejected",
    payload: Record<string, unknown>,
  ): void;
}

export interface HostedScoutCoordinatorOptions {
  readonly policy?: HostedScoutPolicy;
  readonly transport: HostedScoutTransport;
  /** Optional local read-only transport used once when the hosted lane fails. */
  readonly fallback?: HostedScoutTransport;
  readonly emitter?: HostedScoutEmitter;
  readonly workspaceIdentityDigest: string;
  readonly taskEpochId: string;
  readonly callerId: string;
  readonly taskId: string;
  readonly currentSequence?: number;
}

export interface HostedScoutResult {
  readonly accepted: boolean;
  readonly report?: HostedScoutReport;
  readonly reason: string;
}

export class HostedScoutCoordinator {
  readonly #policy: HostedScoutPolicy;
  readonly #transport: HostedScoutTransport;
  readonly #fallback: HostedScoutTransport | undefined;
  readonly #emitter: HostedScoutEmitter | undefined;
  readonly #workspaceIdentityDigest: string;
  readonly #taskEpochId: string;
  readonly #callerId: string;
  readonly #taskId: string;
  readonly #currentSequence: number | undefined;
  #agentsUsed = 0;

  constructor(options: HostedScoutCoordinatorOptions) {
    this.#policy = options.policy ?? DEFAULT_HOSTED_SCOUT_POLICY;
    this.#transport = options.transport;
    this.#fallback = options.fallback;
    this.#emitter = options.emitter;
    this.#workspaceIdentityDigest = options.workspaceIdentityDigest;
    this.#taskEpochId = options.taskEpochId;
    this.#callerId = options.callerId;
    this.#taskId = options.taskId;
    this.#currentSequence = options.currentSequence;
  }

  get agentsUsed(): number {
    return this.#agentsUsed;
  }

  async run(input: Omit<HostedScoutRequest, "callerId" | "taskEpochId" | "workspaceIdentityDigest">, signal: AbortSignal): Promise<HostedScoutResult> {
    const request: HostedScoutRequest = {
      ...input,
      callerId: this.#callerId,
      taskEpochId: this.#taskEpochId,
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
      taskId: this.#taskId,
    };
    const decision = validateHostedScoutRequest(request, this.#policy, { agentsUsed: this.#agentsUsed });
    if (!decision.allowed) return { accepted: false, reason: decision.message };
    this.#agentsUsed += 1;
    this.#emitter?.emit("hosted_agent.spawned", { agentId: request.agentId, role: request.role, taskEpochId: request.taskEpochId });
    const hosted = await this.#attempt(this.#transport, request, signal);
    if (hosted.accepted) return this.#complete(request.agentId, hosted);
    if (!signal.aborted && this.#fallback !== undefined) {
      this.#emitter?.emit("hosted_agent.fallback_local", {
        agentId: request.agentId,
        reason: hosted.reason,
      });
      const local = await this.#attempt(this.#fallback, request, signal);
      if (local.accepted) return this.#complete(request.agentId, local);
      this.#emitter?.emit("hosted_agent.cancelled", { agentId: request.agentId, reason: local.reason });
      return local;
    }
    this.#emitter?.emit("hosted_agent.cancelled", { agentId: request.agentId, reason: hosted.reason });
    return hosted;
  }

  async #attempt(
    transport: HostedScoutTransport,
    request: HostedScoutRequest,
    signal: AbortSignal,
  ): Promise<HostedScoutResult> {
    try {
      const report = await transport.spawn(request, signal);
      if (signal.aborted) return { accepted: false, reason: "hosted scout cancelled" };
      const accepted = acceptHostedScoutReport(report, {
        callerId: this.#callerId,
        taskEpochId: this.#taskEpochId,
        workspaceIdentityDigest: this.#workspaceIdentityDigest,
        taskId: this.#taskId,
        ...(this.#currentSequence !== undefined ? { currentSequence: this.#currentSequence } : {}),
      });
      if (!accepted.accepted) {
        this.#emitter?.emit("hosted_agent.evidence_rejected", {
          agentId: request.agentId,
          reason: accepted.reason,
        });
        return { accepted: false, reason: accepted.reason };
      }
      return { accepted: true, report, reason: "accepted" };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  #complete(agentId: string, result: HostedScoutResult): HostedScoutResult {
    const report = result.report!;
    this.#emitter?.emit("hosted_agent.completed", {
      agentId,
      evidenceIds: report.evidenceCapsule.evidenceIds ?? [],
      claimCount: report.evidenceCapsule.claims?.length ?? 0,
    });
    return result;
  }
}
