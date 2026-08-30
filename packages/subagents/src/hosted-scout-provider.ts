/**
 * Provider-backed hosted scout transport (§5.6, §5.7).
 *
 * The coordinator owns admission and evidence acceptance; this is the piece that
 * makes the lane reach a provider at all. It runs the separate read-only request
 * the builder produces and projects the result into the digest-bound capsule the
 * acceptor demands — the same projection the local fallback performs, so a
 * hosted report and a local one are checked on identical terms.
 */

import {
  digestHostedEvidenceCapsule,
  runHostedScout,
  type HostedEvidenceCapsule,
  type HostedScoutExecution,
  type HostedScoutReport,
  type HostedScoutRequest,
  type ModelToolSchema,
  type ReasoningEffort,
  type ReasoningMode,
} from "@cbc/provider-openai";

import type { HostedScoutTransport } from "./hosted-scout.ts";

export interface ProviderHostedScoutOptions {
  readonly execution: HostedScoutExecution;
  readonly model: string;
  /** The root catalog; only the admitted entries are ever serialized. */
  readonly catalog: () => readonly ModelToolSchema[];
  readonly reasoningMode?: ReasoningMode;
  readonly reasoningEffort?: ReasoningEffort;
  readonly safetyIdentifier?: string;
  readonly maxRounds?: number;
  readonly staleAfterSequence?: number;
}

/**
 * A hosted scout answers in prose plus the reads it performed. Recording those
 * reads as the capsule's evidence refs is what keeps §5.6's "결과는 evidence
 * capsule로 검증" honest: a claim with no read behind it arrives with no
 * evidence, and the parent can see that.
 */
export function providerHostedScoutTransport(
  options: ProviderHostedScoutOptions,
): HostedScoutTransport {
  return {
    async spawn(request, signal, progress) {
      const hostedRole = request.role === "reviewer" || request.role === "HostedReviewer"
        ? "HostedReviewer"
        : "HostedScout";
      progress?.({ note: `running the hosted ${hostedRole} subtree` });
      const run = await runHostedScout(hostedRole, request, {
        execution: options.execution,
        model: options.model,
        catalog: options.catalog(),
        ...(options.reasoningMode !== undefined ? { reasoningMode: options.reasoningMode } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.safetyIdentifier !== undefined ? { safetyIdentifier: options.safetyIdentifier } : {}),
        ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
        ...(request.requestedTokens !== undefined ? { maxOutputTokens: request.requestedTokens } : {}),
      }, signal);
      progress?.({ note: `hosted ${hostedRole} performed ${String(run.evidenceLocators.length)} read(s)`, tokenUsage: run.tokenUsage });

      const claims = run.text.split(/\n{2,}/u).map((claim) => claim.trim()).filter((claim) => claim.length > 0);
      if (claims.length === 0) throw new Error("the hosted scout returned no findings");
      const capsuleBody: Omit<HostedEvidenceCapsule, "digest"> = {
        taskId: request.taskId ?? request.agentId,
        agentClass: hostedRole,
        taskEpochId: request.taskEpochId,
        workspaceIdentityDigest: request.workspaceIdentityDigest ?? "",
        claims: claims.map((text) => ({
          text,
          evidenceRefs: run.evidenceLocators,
          // The provider does not score its own claims, and inventing a score
          // here would let a scout look more certain than it reported.
          confidence: 0.5,
        })),
        unresolved: [],
        suggestedNextSteps: [],
        tokenUsage: run.tokenUsage,
        ...(run.evidenceLocators.length > 0 ? { evidenceIds: [...run.evidenceLocators] } : {}),
        ...(options.staleAfterSequence !== undefined ? { staleAfterSequence: options.staleAfterSequence } : {}),
      };
      return {
        agentId: request.agentId,
        callerId: request.callerId,
        taskEpochId: request.taskEpochId,
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
        ...(request.workspaceIdentityDigest !== undefined
          ? { workspaceIdentityDigest: request.workspaceIdentityDigest }
          : {}),
        claims,
        evidenceCapsule: { ...capsuleBody, digest: digestHostedEvidenceCapsule(capsuleBody) },
      } satisfies HostedScoutReport;
    },
  };
}
