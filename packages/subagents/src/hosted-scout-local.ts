/**
 * Local subagent fallback for the hosted scout lane (§5.6, §5.8).
 *
 * "결과 수집 실패 시 로컬 subagent로 fallback" means the local subagent path, and
 * the coordinator's fallback was a second injected `HostedScoutTransport` — so in
 * production a hosted failure fell back to nothing and the task stopped. This
 * adapter is the real path: it runs the same read-only explore/reviewer child the
 * runtime already knows how to run, and projects its result into the identity-
 * matched capsule the acceptor demands, so a locally produced report is trusted
 * no more readily than a provider's.
 */

import {
  digestHostedEvidenceCapsule,
  type HostedEvidenceCapsule,
  type HostedScoutReport,
  type HostedScoutRequest,
} from "@cbc/provider-openai";

import type { ChildAgentResult, EvidenceRef } from "./instance.ts";
import type { HostedScoutTransport } from "./hosted-scout.ts";
import { roleDefinition, type SubagentRole } from "./roles.ts";
import type { AgentTask } from "./task.ts";

/** The local role a hosted class runs as when the lane falls back. */
export type LocalScoutRole = Extract<SubagentRole, "explore" | "reviewer">;

export interface LocalScoutSpawn {
  readonly role: LocalScoutRole;
  readonly task: AgentTask;
  readonly signal: AbortSignal;
}

/**
 * The scheduler-shaped surface this adapter needs. Kept to the one call rather
 * than the whole `DelegationCoordinator` so a host can supply the coordinator,
 * a bare scheduler, or a session-level wrapper.
 */
export interface LocalScoutRunner {
  run(spawn: LocalScoutSpawn): Promise<ChildAgentResult | undefined>;
}

export interface LocalHostedScoutTransportOptions {
  readonly runner: LocalScoutRunner;
  /** Sequence a stale capsule is invalidated after, mirroring the hosted lane. */
  readonly staleAfterSequence?: number;
}

function localRoleFor(role: HostedScoutRequest["role"]): LocalScoutRole {
  return role === "reviewer" || role === "HostedReviewer" ? "reviewer" : "explore";
}

/** Read-only child task. `allowedPaths` stays empty, so the child cannot write. */
function scoutTask(request: HostedScoutRequest, role: LocalScoutRole): AgentTask {
  return {
    title: `Hosted ${role} fallback for ${request.agentId}`,
    goal: request.prompt,
    context: [
      "The hosted multi-agent lane failed, so this investigation runs locally instead.",
      "Report findings with evidence references; the parent verifies them before use.",
    ],
    constraints: [
      "Read-only: do not edit files, run processes, or request approvals.",
      `Restricted to the admitted read-only tools: ${(request.requestedTools ?? []).join(", ")}`,
    ],
    expectedOutput: ["Findings with an evidence reference for each claim", "Anything that stayed unresolved"],
    allowedPaths: [],
    forbiddenPaths: [],
    verification: [],
    deadlineMs: roleDefinition(role).maxDurationMs,
    dependencies: [],
  };
}

function evidenceLocator(ref: EvidenceRef): string {
  return ref.locator.length > 0 ? ref.locator : ref.label;
}

/**
 * A local child reports prose plus evidence refs; the hosted acceptor wants a
 * digest-bound capsule. Projecting one into the other here is what lets the
 * coordinator revalidate a local report on exactly the same terms as a remote
 * one — the fallback earns no shortcut for being local.
 */
export function localScoutReport(
  request: HostedScoutRequest,
  result: ChildAgentResult,
  options: { readonly staleAfterSequence?: number } = {},
): HostedScoutReport {
  const evidenceIds = [...new Set(result.evidence.map(evidenceLocator))].filter((id) => id.length > 0);
  const claims = [
    result.summary,
    ...(result.findings ?? []).map((finding) => `${finding.severity}: ${finding.title} — ${finding.recommendation}`),
  ].filter((text) => text.trim().length > 0);
  const capsuleBody: Omit<HostedEvidenceCapsule, "digest"> = {
    taskId: request.taskId ?? request.agentId,
    agentClass: localRoleFor(request.role),
    taskEpochId: request.taskEpochId,
    workspaceIdentityDigest: request.workspaceIdentityDigest ?? "",
    claims: claims.map((text) => ({
      text,
      evidenceRefs: evidenceIds,
      // A local child does not score its own confidence, and the parent must not
      // be told it did. Reporting a flat mid-confidence keeps the capsule honest.
      confidence: 0.5,
    })),
    unresolved: [...result.openRisks],
    suggestedNextSteps: result.recommendedNextStep === undefined ? [] : [result.recommendedNextStep],
    // Local execution spends the parent's own budget, which the graph ledger
    // already accounts for; charging it to the hosted subtree would double-count.
    tokenUsage: 0,
    ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
    ...(options.staleAfterSequence !== undefined ? { staleAfterSequence: options.staleAfterSequence } : {}),
  };
  return {
    agentId: request.agentId,
    callerId: request.callerId,
    taskEpochId: request.taskEpochId,
    ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
    ...(request.workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest: request.workspaceIdentityDigest } : {}),
    claims,
    evidenceCapsule: { ...capsuleBody, digest: digestHostedEvidenceCapsule(capsuleBody) },
  };
}

/**
 * Wrap the local subagent path as a `HostedScoutTransport`, so §5.8's "fall back
 * and continue the same task" is satisfied by work that actually happens.
 */
export function localHostedScoutTransport(
  options: LocalHostedScoutTransportOptions,
): HostedScoutTransport {
  return {
    async spawn(request, signal, progress) {
      const role = localRoleFor(request.role);
      progress?.({ note: `running the local ${role} subagent instead` });
      const result = await options.runner.run({ role, task: scoutTask(request, role), signal });
      if (result === undefined) throw new Error("the local scout subagent produced no result");
      if (result.status !== "completed") {
        throw new Error(`the local scout subagent ${result.status}: ${result.summary}`);
      }
      return localScoutReport(request, result, options);
    },
  };
}
