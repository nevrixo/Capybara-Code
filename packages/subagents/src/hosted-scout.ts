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
  emit(kind: "hosted_agent.spawned" | "hosted_agent.progress" | "hosted_agent.completed" | "hosted_agent.cancelled", payload: Record<string, unknown>): void;
}

export interface HostedScoutCoordinatorOptions {
  readonly policy?: HostedScoutPolicy;
  readonly transport: HostedScoutTransport;
  readonly emitter?: HostedScoutEmitter;
  readonly workspaceIdentityDigest?: string;
  readonly taskEpochId: string;
  readonly callerId: string;
  readonly taskId?: string;
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
  readonly #emitter: HostedScoutEmitter | undefined;
  readonly #workspaceIdentityDigest: string | undefined;
  readonly #taskEpochId: string;
  readonly #callerId: string;
  readonly #taskId: string | undefined;
  readonly #currentSequence: number | undefined;
  #agentsUsed = 0;

  constructor(options: HostedScoutCoordinatorOptions) {
    this.#policy = options.policy ?? DEFAULT_HOSTED_SCOUT_POLICY;
    this.#transport = options.transport;
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
      ...(this.#workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest: this.#workspaceIdentityDigest } : {}),
      ...(this.#taskId !== undefined ? { taskId: this.#taskId } : {}),
    };
    const decision = validateHostedScoutRequest(request, this.#policy, { agentsUsed: this.#agentsUsed });
    if (!decision.allowed) return { accepted: false, reason: decision.message };
    this.#agentsUsed += 1;
    this.#emitter?.emit("hosted_agent.spawned", { agentId: request.agentId, role: request.role, taskEpochId: request.taskEpochId });
    try {
      const report = await this.#transport.spawn(request, signal);
      if (signal.aborted) {
        this.#emitter?.emit("hosted_agent.cancelled", { agentId: request.agentId, reason: "cancelled" });
        return { accepted: false, reason: "hosted scout cancelled" };
      }
      const accepted = acceptHostedScoutReport(report, {
        callerId: this.#callerId,
        taskEpochId: this.#taskEpochId,
        ...(this.#workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest: this.#workspaceIdentityDigest } : {}),
        ...(this.#taskId !== undefined ? { taskId: this.#taskId } : {}),
        ...(this.#currentSequence !== undefined ? { currentSequence: this.#currentSequence } : {}),
      });
      if (!accepted.accepted) {
        this.#emitter?.emit("hosted_agent.cancelled", { agentId: request.agentId, reason: accepted.reason });
        return { accepted: false, reason: accepted.reason };
      }
      this.#emitter?.emit("hosted_agent.completed", { agentId: request.agentId, evidenceIds: report.evidenceCapsule.evidenceIds ?? [], claimCount: report.evidenceCapsule.claims?.length ?? 0 });
      return { accepted: true, report, reason: "accepted" };
    } catch (error) {
      this.#emitter?.emit("hosted_agent.cancelled", { agentId: request.agentId, reason: error instanceof Error ? error.message : String(error) });
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

