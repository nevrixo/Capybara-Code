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

import { ROLE_DEFINITIONS, type SubagentRole } from "./roles.ts";

/**
 * §5.6 denies `executor`, `refactorer`, and *any* custom role that needs write
 * authority. The provider gate can only refuse by name, because it cannot see
 * the subagent role table; this is the one layer that can, so the denial is
 * made by authority here — a custom role whose `base_role` resolves to a
 * writer is refused even if it is spelled like a scout.
 */
function writeCapable(role: string): boolean {
  const definition = ROLE_DEFINITIONS[role as SubagentRole];
  return definition !== undefined && (definition.canWrite || definition.canRunProcess);
}

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
    if (writeCapable(request.role)) {
      return { accepted: false, reason: `hosted agents cannot run the write-capable ${request.role} role` };
    }
    const decision = validateHostedScoutRequest(request, this.#policy, { agentsUsed: this.#agentsUsed });
    if (!decision.allowed) return { accepted: false, reason: decision.message };
    // §5.6/§5.8: the gate narrows the catalog, so the *narrowed* list is what may
    // reach the transport. Forwarding the caller's own `requestedTools` left the
    // enforced set behind in the decision, and a transport that defaulted to its
    // own catalog could still have offered a writer tool the gate never admitted.
    const admitted: HostedScoutRequest = { ...request, requestedTools: decision.tools };
    this.#agentsUsed += 1;
    this.#emitter?.emit("hosted_agent.spawned", { agentId: request.agentId, role: request.role, taskEpochId: request.taskEpochId });
    const hosted = await this.#attempt(this.#transport, admitted, signal);
    if (hosted.accepted) return this.#complete(request.agentId, hosted);
    if (!signal.aborted && this.#fallback !== undefined) {
      this.#emitter?.emit("hosted_agent.fallback_local", {
        agentId: request.agentId,
        reason: hosted.reason,
      });
      const local = await this.#attempt(this.#fallback, admitted, signal);
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
