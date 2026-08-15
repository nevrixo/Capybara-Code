/**
 * Parent synthesis — PRD §15.11, SUB-006.
 *
 * §15.11 is unambiguous: "Root는 child result를 신뢰 가능한 사실로 바로 취급하지
 * 않는다." A child's report is a *claim*. File hashes are checked against the
 * runtime's record, command exits against process events, and reviewer findings
 * are only as good as the evidence the parent can actually read.
 *
 * This matters because a child is a language model. It can report a passing test
 * it never ran. AC-50 forbids the final answer from repeating that claim, so the
 * check has to happen before the claim reaches the report.
 */

import type {
  ChildAgentResult,
  ChildCommandRun,
  ChildFileChange,
  EvidenceRef,
  ReviewFinding,
} from "./instance.ts";

/**
 * The durable facts the parent verifies against — file hashes from the runtime's
 * transaction log and command outcomes from process events (§18.15).
 */
export interface RuntimeEvidence {
  /** Workspace-relative path → hash the runtime recorded after the mutation. */
  readonly fileHashes: ReadonlyMap<string, string>;
  /** Command display → exit code the process supervisor observed. */
  readonly commandExits: ReadonlyMap<string, number>;
  /** Artifact ids the artifact store actually holds. */
  readonly artifactIds?: ReadonlySet<string>;
}

export type ClaimStatus = "verified" | "unverified" | "contradicted";

export interface VerifiedClaim<T> {
  readonly claim: T;
  readonly status: ClaimStatus;
  readonly detail: string;
}

export interface SynthesisResult {
  /** The child result with unverifiable claims stripped from the summary path. */
  readonly result: ChildAgentResult;
  readonly files: Array<VerifiedClaim<ChildFileChange>>;
  readonly commands: Array<VerifiedClaim<ChildCommandRun>>;
  /** Human-readable notes for the parent's risk list. */
  readonly discrepancies: string[];
  /** True when every claim the child made checks out. */
  readonly trustworthy: boolean;
}

/**
 * Verify one child's claims against the runtime record.
 *
 * A claim the runtime simply has no record of is `unverified`, not
 * `contradicted` — the runtime evidence may be incomplete (a read-only child
 * legitimately changes nothing). A claim the runtime *disagrees* with is
 * contradicted, and that is what feeds the parent's risk list.
 */
export function verifyChildResult(
  result: ChildAgentResult,
  evidence: RuntimeEvidence,
): SynthesisResult {
  const discrepancies: string[] = [];

  const files: Array<VerifiedClaim<ChildFileChange>> = result.filesChanged.map((claim) => {
    const recorded = evidence.fileHashes.get(claim.path);
    if (recorded === undefined) {
      discrepancies.push(
        `the child reported changing ${claim.path}, but the runtime recorded no mutation there`,
      );
      return {
        claim,
        status: "contradicted" as const,
        detail: "no runtime transaction touched this path",
      };
    }
    if (claim.afterHash !== undefined && claim.afterHash !== recorded) {
      discrepancies.push(
        `the child reported hash ${short(claim.afterHash)} for ${claim.path}, but the runtime recorded ${short(recorded)}`,
      );
      return {
        claim,
        status: "contradicted" as const,
        detail: `runtime hash is ${recorded}`,
      };
    }
    return { claim, status: "verified" as const, detail: `runtime hash ${short(recorded)}` };
  });

  const commands: Array<VerifiedClaim<ChildCommandRun>> = result.commandsRun.map((claim) => {
    const recorded = evidence.commandExits.get(claim.display);
    if (recorded === undefined) {
      discrepancies.push(
        `the child reported running '${claim.display}', but no process event records it`,
      );
      return {
        claim,
        status: "contradicted" as const,
        detail: "no process event for this command",
      };
    }
    if (claim.exitCode !== undefined && claim.exitCode !== recorded) {
      discrepancies.push(
        `the child reported exit ${claim.exitCode} for '${claim.display}', but the supervisor observed ${recorded}`,
      );
      return { claim, status: "contradicted" as const, detail: `observed exit ${recorded}` };
    }
    return { claim, status: "verified" as const, detail: `observed exit ${recorded}` };
  });

  // An artifact reference that does not resolve is a dangling pointer the user
  // would otherwise be invited to open.
  const knownArtifacts = evidence.artifactIds;
  const evidenceRefs: EvidenceRef[] = [];
  for (const ref of result.evidence) {
    if (ref.kind === "artifact" && knownArtifacts !== undefined && !knownArtifacts.has(ref.locator)) {
      discrepancies.push(`evidence artifact '${ref.locator}' does not exist in the artifact store`);
      continue;
    }
    evidenceRefs.push(ref);
  }

  const contradicted =
    files.some((f) => f.status === "contradicted") ||
    commands.some((c) => c.status === "contradicted");

  // A child that claimed success on unverifiable evidence must not be reported as
  // a clean success (AC-50 propagates through the parent's report).
  const status: ChildAgentResult["status"] =
    result.status === "completed" && contradicted ? "blocked" : result.status;

  const openRisks = [...result.openRisks];
  if (contradicted) {
    openRisks.push("some of the subagent's claims could not be confirmed against runtime evidence");
  }

  return {
    result: {
      ...result,
      status,
      evidence: evidenceRefs,
      openRisks,
    },
    files,
    commands,
    discrepancies,
    trustworthy: !contradicted && discrepancies.length === 0,
  };
}

export interface MergedExploration {
  /** Deduplicated evidence across children. */
  readonly evidence: EvidenceRef[];
  /** Summaries in child order, labelled by agent. */
  readonly summaries: Array<{ agentId: string; summary: string }>;
  /** Children that reported incompatible conclusions about the same locator. */
  readonly conflicts: Array<{ locator: string; agents: string[]; details: string[] }>;
  readonly openRisks: string[];
}

/**
 * Merge several read-only children's findings.
 *
 * §15.11 asks for two things here: duplicate exploration is merged, and
 * conflicting results are surfaced rather than silently resolved. The parent is
 * told which children disagreed so it can re-read the source itself instead of
 * picking whichever answer arrived last.
 */
export function mergeExplorations(
  results: ReadonlyArray<{ agentId: string; result: ChildAgentResult }>,
): MergedExploration {
  const byLocator = new Map<string, Array<{ agentId: string; ref: EvidenceRef }>>();
  const evidence: EvidenceRef[] = [];
  const seen = new Set<string>();
  const summaries: Array<{ agentId: string; summary: string }> = [];
  const openRisks: string[] = [];

  for (const { agentId, result } of results) {
    summaries.push({ agentId, summary: result.summary });
    openRisks.push(...result.openRisks);

    for (const ref of result.evidence) {
      const key = `${ref.kind}:${ref.locator}`;
      if (!seen.has(key)) {
        seen.add(key);
        evidence.push(ref);
      }
      byLocator.set(key, [...(byLocator.get(key) ?? []), { agentId, ref }]);
    }
  }

  const conflicts: Array<{ locator: string; agents: string[]; details: string[] }> = [];
  for (const [key, entries] of byLocator) {
    if (entries.length < 2) continue;
    const details = [...new Set(entries.map((e) => e.ref.detail).filter(isString))];
    if (details.length > 1) {
      conflicts.push({
        locator: key,
        agents: entries.map((e) => e.agentId),
        details,
      });
    }
  }

  return {
    evidence,
    summaries,
    conflicts,
    openRisks: [...new Set(openRisks)],
  };
}

/**
 * Reduce reviewer findings to the ones worth a repair cycle.
 *
 * §11.9 repairs only on a high-confidence defect, and §15.2 tells the reviewer to
 * prefer actionable defects over style nits. Filtering here rather than trusting
 * the reviewer's own severity keeps one over-eager reviewer from burning the
 * parent's single repair budget on a preference.
 */
export function blockingFindings(result: ChildAgentResult): ReviewFindingSummary {
  const findings = result.findings ?? [];
  const blocking: ReviewFinding[] = [];
  const rejected: ReviewFinding[] = [];

  for (const finding of findings) {
    const severeEnough = finding.severity === "critical" || finding.severity === "high";
    // A finding with no evidence is an opinion; §15.2 requires file/line proof.
    const hasEvidence = finding.evidence.trim().length > 0;
    if (severeEnough && hasEvidence) blocking.push(finding);
    else rejected.push(finding);
  }

  return { blocking, rejected };
}

export interface ReviewFindingSummary {
  readonly blocking: ReviewFinding[];
  readonly rejected: ReviewFinding[];
}

function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
