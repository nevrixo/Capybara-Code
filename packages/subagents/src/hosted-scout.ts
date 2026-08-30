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
  type HostedScoutUsage,
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
  /** Injectable clock so the subtree deadline is testable without real waiting. */
  readonly now?: () => number;
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
  readonly #now: () => number;
  /**
   * §5.6 states two distinct limits, and one counter cannot be both. The used
   * count is keyed to the task epoch — a new epoch is a new task, so it starts
   * over — while the in-flight count is what makes "동시 실행 최대 3" a real
   * concurrency ceiling rather than a lifetime total.
   */
  #epochId: string;
  #agentsUsed = 0;
  #agentsInFlight = 0;
  #subtreeTokensUsed = 0;
  #subtreeStartedAt: number | undefined;

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
    this.#now = options.now ?? (() => Date.now());
    this.#epochId = options.taskEpochId;
  }

  get agentsUsed(): number {
    return this.#agentsUsed;
  }

  /** Tokens the whole scout subtree has spent, per §5.6's subtree budget. */
  get subtreeTokensUsed(): number {
    return this.#subtreeTokensUsed;
  }

  /** How long the subtree has been running, measured from its first admission. */
  #subtreeElapsedMs(): number {
    return this.#subtreeStartedAt === undefined ? 0 : Math.max(0, this.#now() - this.#subtreeStartedAt);
  }

  /** Hosted agents in flight right now, bounded by `maxConcurrentAgents`. */
  get agentsInFlight(): number {
    return this.#agentsInFlight;
  }

  #usage(): HostedScoutUsage {
    return {
      agentsUsed: this.#agentsUsed,
      agentsInFlight: this.#agentsInFlight,
      subtreeTokensUsed: this.#subtreeTokensUsed,
      subtreeElapsedMs: this.#subtreeElapsedMs(),
    };
  }

  /**
   * A task epoch change means the scouts of the previous task are irrelevant, so
   * their spend must not hold the new one's budget down. In-flight agents belong
   * to the old epoch and are still counted: they are still consuming provider
   * concurrency until they settle.
   */
  #rollEpoch(taskEpochId: string): void {
    if (taskEpochId === this.#epochId) return;
    this.#epochId = taskEpochId;
    this.#agentsUsed = 0;
    this.#subtreeTokensUsed = 0;
    this.#subtreeStartedAt = undefined;
  }

  async run(
    input: Omit<HostedScoutRequest, "callerId" | "taskEpochId" | "workspaceIdentityDigest">,
    signal: AbortSignal,
    taskEpochId: string = this.#taskEpochId,
  ): Promise<HostedScoutResult> {
    this.#rollEpoch(taskEpochId);
    const request: HostedScoutRequest = {
      ...input,
      callerId: this.#callerId,
      taskEpochId,
      workspaceIdentityDigest: this.#workspaceIdentityDigest,
      taskId: this.#taskId,
    };
    if (writeCapable(request.role)) {
      return { accepted: false, reason: `hosted agents cannot run the write-capable ${request.role} role` };
    }
    const decision = validateHostedScoutRequest(request, this.#policy, this.#usage());
    if (!decision.allowed) return { accepted: false, reason: decision.message };
    // The subtree clock starts at the first admitted scout, not at construction:
    // a coordinator built early in a turn must not burn its own deadline idling.
    this.#subtreeStartedAt ??= this.#now();
    // §5.6/§5.8: the gate narrows the catalog, so the *narrowed* list is what may
    // reach the transport. Forwarding the caller's own `requestedTools` left the
    // enforced set behind in the decision, and a transport that defaulted to its
    // own catalog could still have offered a writer tool the gate never admitted.
    const admitted: HostedScoutRequest = { ...request, requestedTools: decision.tools };
    this.#agentsUsed += 1;
    this.#emitter?.emit("hosted_agent.spawned", { agentId: request.agentId, role: request.role, taskEpochId: request.taskEpochId });
    // §5.6's subtree wall-time budget has to be a real deadline, the way
    // programmatic.ts bounds a program: without one, a provider that accepts the
    // request and never answers holds the turn open for as long as the caller
    // is willing to wait.
    const deadline = new AbortController();
    const remainingMs = Math.max(1, this.#policy.maxSubtreeWallTimeMs - this.#subtreeElapsedMs());
    const timer = setTimeout(() => deadline.abort(), remainingMs);
    this.#agentsInFlight += 1;
    try {
      return await this.#runAdmitted(request, admitted, AbortSignal.any([signal, deadline.signal]), deadline.signal);
    } finally {
      this.#agentsInFlight -= 1;
      clearTimeout(timer);
    }
  }

  async #runAdmitted(
    request: HostedScoutRequest,
    admitted: HostedScoutRequest,
    signal: AbortSignal,
    deadline: AbortSignal,
  ): Promise<HostedScoutResult> {
    const hosted = await this.#attempt(this.#transport, admitted, signal, deadline);
    if (hosted.accepted) return this.#complete(request.agentId, hosted);
    // An exhausted subtree deadline is a budget refusal, not a transport error:
    // retrying under it would spend a budget that is already gone.
    if (!signal.aborted && this.#fallback !== undefined) {
      this.#emitter?.emit("hosted_agent.fallback_local", {
        agentId: request.agentId,
        reason: hosted.reason,
      });
      const local = await this.#attempt(this.#fallback, admitted, signal, deadline);
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
    deadline: AbortSignal,
  ): Promise<HostedScoutResult> {
    try {
      const report = await transport.spawn(request, signal);
      if (deadline.aborted) return { accepted: false, reason: "hosted scout subtree wall-time budget exhausted" };
      if (signal.aborted) return { accepted: false, reason: "hosted scout cancelled" };
      const accepted = acceptHostedScoutReport(report, {
        callerId: this.#callerId,
        taskEpochId: this.#epochId,
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
      this.#subtreeTokensUsed += Math.max(0, report.evidenceCapsule.tokenUsage ?? 0);
      return { accepted: true, report, reason: "accepted" };
    } catch (error) {
      if (deadline.aborted) return { accepted: false, reason: "hosted scout subtree wall-time budget exhausted" };
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
