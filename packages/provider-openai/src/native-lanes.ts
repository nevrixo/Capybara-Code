/**
 * Policy gates for provider-native programmatic tool calling (PTC) and hosted
 * read-only scouts. Provider capabilities describe what an endpoint offers;
 * these gates describe what CBC is willing to expose in this session. They
 * never grant a Rust permission, writer lease, or approval.
 */

import { createHash } from "node:crypto";

export const PROGRAM_TOOL_ALLOWLIST = [
  "fs.read",
  "fs.read_many",
  "fs.list",
  "fs.glob",
  "fs.search",
  "git.status",
  "git.diff",
  "git.log",
] as const;

export type ProgramToolId = (typeof PROGRAM_TOOL_ALLOWLIST)[number];

export interface ProgramToolCall {
  readonly callId: string;
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly callerId: string;
  readonly taskEpochId: string;
  readonly reads?: readonly string[];
}

export interface ProgramPolicy {
  /** v1.3 wire-compatible aliases used by the program lane contract. */
  readonly allowedToolIds?: readonly string[];
  readonly maxProgramBytes?: number;
  readonly maxWallTimeMs?: number;
  readonly maxIntermediateBytes?: number;
  readonly allowLoops?: boolean;
  readonly maxLoopIterations?: number;
  readonly maxRetries?: number;
  readonly failOpen?: false;
  readonly enabled: boolean;
  readonly maxToolCalls: number;
  readonly maxParallelCalls: number;
  readonly maxOutputBytes: number;
  readonly allowlist?: readonly string[];
}

export const DEFAULT_PROGRAM_POLICY: ProgramPolicy = {
  allowedToolIds: PROGRAM_TOOL_ALLOWLIST,
  maxProgramBytes: 262_144,
  maxWallTimeMs: 30_000,
  maxIntermediateBytes: 4_194_304,
  allowLoops: false,
  maxLoopIterations: 0,
  maxRetries: 1,
  failOpen: false,
  enabled: true,
  maxToolCalls: 24,
  maxParallelCalls: 6,
  maxOutputBytes: 1_048_576,
};

export interface ProgramPolicyDecision {
  readonly allowed: boolean;
  readonly code:
    | "allowed"
    | "disabled"
    | "budget_exhausted"
    | "parallel_budget_exhausted"
    | "unknown_tool"
    | "mutation_denied"
    | "caller_missing"
    | "epoch_missing"
    | "lineage_mismatch"
    | "invalid_arguments";
  readonly message: string;
  readonly normalizedToolId?: ProgramToolId;
}

export function validateProgramToolCall(
  call: Partial<ProgramToolCall>,
  policy: ProgramPolicy = DEFAULT_PROGRAM_POLICY,
  usage: {
    readonly callsUsed?: number;
    readonly parallelCalls?: number;
    readonly expectedCallerId?: string;
    readonly expectedTaskEpochId?: string;
  } = {},
): ProgramPolicyDecision {
  if (!policy.enabled) return { allowed: false, code: "disabled", message: "programmatic tool calling is disabled by policy" };
  if ((usage.callsUsed ?? 0) >= policy.maxToolCalls) return { allowed: false, code: "budget_exhausted", message: `PTC budget is capped at ${policy.maxToolCalls} calls` };
  if ((usage.parallelCalls ?? 0) >= policy.maxParallelCalls) return { allowed: false, code: "parallel_budget_exhausted", message: `PTC parallelism is capped at ${policy.maxParallelCalls} calls` };
  if (typeof call.callerId !== "string" || call.callerId.length === 0) return { allowed: false, code: "caller_missing", message: "PTC calls require callerId ancestry" };
  if (typeof call.taskEpochId !== "string" || call.taskEpochId.length === 0) return { allowed: false, code: "epoch_missing", message: "PTC calls require a taskEpochId" };
  if (usage.expectedCallerId !== undefined && call.callerId !== usage.expectedCallerId) return { allowed: false, code: "lineage_mismatch", message: "PTC caller ancestry does not match the active program" };
  if (usage.expectedTaskEpochId !== undefined && call.taskEpochId !== usage.expectedTaskEpochId) return { allowed: false, code: "lineage_mismatch", message: "PTC call belongs to a different task epoch" };
  if (typeof call.toolId !== "string") return { allowed: false, code: "unknown_tool", message: "PTC tool id is missing" };
  const allowlist = new Set(policy.allowedToolIds ?? policy.allowlist ?? PROGRAM_TOOL_ALLOWLIST);
  if (!(PROGRAM_TOOL_ALLOWLIST as readonly string[]).includes(call.toolId)) return { allowed: false, code: "unknown_tool", message: `'${call.toolId}' is not a known PTC tool` };
  if (!allowlist.has(call.toolId)) return { allowed: false, code: "mutation_denied", message: `'${call.toolId}' is not enabled by the read-only PTC policy` };
  if (call.arguments === undefined || call.arguments === null || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return { allowed: false, code: "invalid_arguments", message: "PTC arguments must be a JSON object" };
  return { allowed: true, code: "allowed", message: "read-only PTC call accepted", normalizedToolId: call.toolId as ProgramToolId };
}

export interface ProgramOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly digest: string;
}

export interface ProgramEvidenceClaim {
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly paths?: readonly string[];
}

/** Structured result accepted from a completed hosted program. */
export interface ProgramEvidenceResult {
  readonly status: "complete" | "partial" | "failed";
  readonly taskEpochId: string;
  readonly workspaceIdentityDigest: string;
  readonly claims: readonly ProgramEvidenceClaim[];
  readonly missing: readonly string[];
  readonly diagnostics: readonly string[];
  readonly stats: {
    readonly calls: number;
    readonly parallelPeak: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
  };
}

export interface ProgramEvidenceDecision {
  readonly accepted: boolean;
  readonly errors: readonly string[];
}

/** Validate a program's reduced result before it can become model evidence. */
export function validateProgramEvidenceResult(
  value: unknown,
  expected: { readonly taskEpochId: string; readonly workspaceIdentityDigest: string },
): ProgramEvidenceDecision {
  const errors: string[] = [];
  if (!isRecord(value)) return { accepted: false, errors: ["program evidence result must be an object"] };
  if (value.status !== "complete" && value.status !== "partial" && value.status !== "failed") errors.push("program evidence status is invalid");
  if (value.taskEpochId !== expected.taskEpochId) errors.push("program evidence belongs to a different task epoch");
  if (value.workspaceIdentityDigest !== expected.workspaceIdentityDigest) errors.push("program evidence belongs to a different workspace");
  if (!validStringArray(value.missing, 256, 8_192)) errors.push("program evidence missing list is invalid");
  if (!validStringArray(value.diagnostics, 256, 8_192)) errors.push("program evidence diagnostics are invalid");
  if (!Array.isArray(value.claims) || value.claims.length > 256) {
    errors.push("program evidence claims are invalid");
  } else {
    for (const claim of value.claims) {
      if (!isRecord(claim) || typeof claim.text !== "string" || claim.text.length === 0 || claim.text.length > 8_192) {
        errors.push("program evidence claim text is invalid");
        continue;
      }
      if (!validStringArray(claim.evidenceIds, 256, 256) || claim.evidenceIds.length === 0) errors.push("program evidence claim requires bounded evidence ids");
      if (claim.paths !== undefined && !validStringArray(claim.paths, 256, 4_096)) errors.push("program evidence claim paths are invalid");
    }
  }
  if (!isRecord(value.stats)) {
    errors.push("program evidence stats are missing");
  } else {
    for (const field of ["calls", "parallelPeak", "inputBytes", "outputBytes"] as const) {
      const metric = value.stats[field];
      if (typeof metric !== "number" || !Number.isSafeInteger(metric) || metric < 0) errors.push(`program evidence stats.${field} is invalid`);
    }
  }
  return { accepted: errors.length === 0, errors };
}

/** Bound provider-produced output before it becomes an observation/evidence record. */
export function sanitizeProgramOutput(value: unknown, maxBytes = DEFAULT_PROGRAM_POLICY.maxOutputBytes): ProgramOutput {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const clean = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const bytes = new TextEncoder().encode(clean);
  const limit = Math.max(0, Math.floor(maxBytes));
  const truncated = bytes.byteLength > limit;
  const bounded = truncated ? new TextDecoder().decode(bytes.slice(0, limit)) : clean;
  return { text: bounded, truncated, bytes: new TextEncoder().encode(bounded).byteLength, digest: stableDigest(bounded) };
}

export type HostedRole = "HostedScout" | "HostedReviewer";

export interface HostedScoutPolicy {
  readonly enabled: boolean;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly maxTokensPerAgent: number;
  readonly allowlistedTools: readonly string[];
  readonly allowShell: false;
  readonly allowApplyPatch: false;
  readonly allowComputerUse: false;
  readonly requireEvidenceCapsule: true;
}

export const DEFAULT_HOSTED_SCOUT_POLICY: HostedScoutPolicy = {
  enabled: true,
  maxAgents: 3,
  maxDepth: 1,
  maxTokensPerAgent: 16_000,
  allowlistedTools: PROGRAM_TOOL_ALLOWLIST,
  allowShell: false,
  allowApplyPatch: false,
  allowComputerUse: false,
  requireEvidenceCapsule: true,
};

export interface HostedScoutRequest {
  readonly role: HostedRole;
  readonly agentId: string;
  readonly callerId: string;
  readonly taskEpochId: string;
  readonly taskId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly depth: number;
  readonly prompt: string;
  readonly requestedTokens?: number;
  readonly requestedTools?: readonly string[];
}

export interface HostedScoutDecision {
  readonly allowed: boolean;
  readonly code: "allowed" | "disabled" | "agent_budget" | "depth_budget" | "token_budget" | "caller_missing" | "epoch_missing" | "tool_denied" | "prompt_invalid";
  readonly message: string;
  readonly tools: readonly string[];
}

export function validateHostedScoutRequest(
  request: Partial<HostedScoutRequest>,
  policy: HostedScoutPolicy = DEFAULT_HOSTED_SCOUT_POLICY,
  usage: { readonly agentsUsed?: number } = {},
): HostedScoutDecision {
  if (!policy.enabled) return { allowed: false, code: "disabled", message: "hosted scouts are disabled by policy", tools: [] };
  if ((usage.agentsUsed ?? 0) >= policy.maxAgents) return { allowed: false, code: "agent_budget", message: `hosted scouts are capped at ${policy.maxAgents}`, tools: [] };
  if (typeof request.depth !== "number" || !Number.isInteger(request.depth) || request.depth < 0 || request.depth > policy.maxDepth) return { allowed: false, code: "depth_budget", message: `hosted scout depth is capped at ${policy.maxDepth}`, tools: [] };
  if (request.requestedTokens !== undefined && (!Number.isFinite(request.requestedTokens) || !Number.isInteger(request.requestedTokens) || request.requestedTokens < 0 || request.requestedTokens > policy.maxTokensPerAgent)) return { allowed: false, code: "token_budget", message: `hosted scout tokens are capped at ${policy.maxTokensPerAgent}`, tools: [] };
  if (typeof request.callerId !== "string" || request.callerId.length === 0) return { allowed: false, code: "caller_missing", message: "hosted scouts require callerId ancestry", tools: [] };
  if (typeof request.taskEpochId !== "string" || request.taskEpochId.length === 0) return { allowed: false, code: "epoch_missing", message: "hosted scouts require a taskEpochId", tools: [] };
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) return { allowed: false, code: "prompt_invalid", message: "hosted scout prompt is empty", tools: [] };
  const requested = request.requestedTools ?? policy.allowlistedTools;
  const denied = requested.filter((tool) => !policy.allowlistedTools.includes(tool));
  if (denied.length > 0) return { allowed: false, code: "tool_denied", message: `hosted scout requested denied tool(s): ${denied.join(", ")}`, tools: [] };
  return { allowed: true, code: "allowed", message: "read-only hosted scout accepted", tools: [...requested] };
}

export interface HostedEvidenceClaim {
  readonly text: string;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
}

/** Bounded provider report accepted by the host after identity and epoch checks. */
export interface HostedEvidenceCapsule {
  /** v1.3 exact capsule identity; optional fields retain the v1.2 compact adapter. */
  readonly taskId?: string;
  readonly agentClass?: HostedRole | string;
  readonly taskEpochId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly claims?: readonly HostedEvidenceClaim[];
  readonly unresolved?: readonly string[];
  readonly suggestedNextSteps?: readonly string[];
  readonly tokenUsage?: number;
  readonly staleAfterSequence?: number;
  /** Legacy evidence IDs remain an optional compact index for the local ledger. */
  readonly evidenceIds?: readonly string[];
  readonly digest: string;
}

export type EvidenceCapsule = HostedEvidenceCapsule;

export interface HostedScoutReport {
  readonly agentId: string;
  readonly callerId: string;
  readonly taskEpochId: string;
  readonly taskId?: string;
  readonly workspaceIdentityDigest?: string;
  readonly claims: readonly string[];
  readonly evidenceCapsule: HostedEvidenceCapsule;
}

export interface HostedReportDecision {
  readonly accepted: boolean;
  readonly reason: "accepted" | "missing_capsule" | "workspace_mismatch" | "epoch_mismatch" | "caller_mismatch" | "agent_missing" | "digest_mismatch";
}

export function acceptHostedScoutReport(
  report: Partial<HostedScoutReport>,
  expected: { readonly callerId: string; readonly taskEpochId: string; readonly workspaceIdentityDigest?: string; readonly taskId?: string; readonly currentSequence?: number },
): HostedReportDecision {
  if (typeof report.evidenceCapsule !== "object" || report.evidenceCapsule === null) return { accepted: false, reason: "missing_capsule" };
  if (typeof report.agentId !== "string" || report.agentId.length === 0) return { accepted: false, reason: "agent_missing" };
  if (report.callerId !== expected.callerId) return { accepted: false, reason: "caller_mismatch" };
  if (report.taskEpochId !== expected.taskEpochId) return { accepted: false, reason: "epoch_mismatch" };
  if (expected.workspaceIdentityDigest !== undefined && report.workspaceIdentityDigest !== expected.workspaceIdentityDigest) return { accepted: false, reason: "workspace_mismatch" };
  if (expected.workspaceIdentityDigest !== undefined && report.evidenceCapsule.workspaceIdentityDigest !== expected.workspaceIdentityDigest) return { accepted: false, reason: "workspace_mismatch" };
  if (expected.taskId !== undefined && report.taskId !== expected.taskId) return { accepted: false, reason: "epoch_mismatch" };

  const capsule = report.evidenceCapsule;
  if (typeof capsule.digest !== "string" || capsule.digest.length === 0 || capsule.digest.length > 128) return { accepted: false, reason: "digest_mismatch" };
  const richKeys = ["taskId", "agentClass", "taskEpochId", "workspaceIdentityDigest", "claims", "unresolved", "suggestedNextSteps", "tokenUsage"];
  const rich = richKeys.some((key) => Object.prototype.hasOwnProperty.call(capsule, key));
  const evidenceIds = capsule.evidenceIds;
  if (evidenceIds !== undefined && (!Array.isArray(evidenceIds) || evidenceIds.length > 256 || new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 256))) return { accepted: false, reason: "digest_mismatch" };

  if (rich) {
    if (typeof capsule.taskId !== "string" || capsule.taskId.length === 0 || capsule.taskId.length > 256) return { accepted: false, reason: "digest_mismatch" };
    if (typeof capsule.agentClass !== "string" || capsule.agentClass.length === 0 || capsule.agentClass.length > 64) return { accepted: false, reason: "digest_mismatch" };
    if (typeof capsule.taskEpochId !== "string" || capsule.taskEpochId.length === 0) return { accepted: false, reason: "epoch_mismatch" };
    if (typeof capsule.workspaceIdentityDigest !== "string" || capsule.workspaceIdentityDigest.length === 0) return { accepted: false, reason: "workspace_mismatch" };
    if (!Array.isArray(capsule.claims) || capsule.claims.length > 256 || capsule.claims.some((claim) => typeof claim?.text !== "string" || claim.text.length > 8_192 || !Array.isArray(claim.evidenceRefs) || claim.evidenceRefs.length > 256 || claim.evidenceRefs.some((ref: unknown) => typeof ref !== "string" || ref.length === 0 || ref.length > 256) || typeof claim.confidence !== "number" || !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1)) return { accepted: false, reason: "digest_mismatch" };
    if (!Array.isArray(capsule.unresolved) || capsule.unresolved.length > 256 || capsule.unresolved.some((value) => typeof value !== "string" || value.length > 8_192)) return { accepted: false, reason: "digest_mismatch" };
    if (!Array.isArray(capsule.suggestedNextSteps) || capsule.suggestedNextSteps.length > 256 || capsule.suggestedNextSteps.some((value) => typeof value !== "string" || value.length > 8_192)) return { accepted: false, reason: "digest_mismatch" };
    if (typeof capsule.tokenUsage !== "number" || !Number.isInteger(capsule.tokenUsage) || capsule.tokenUsage < 0 || capsule.tokenUsage > DEFAULT_HOSTED_SCOUT_POLICY.maxTokensPerAgent) return { accepted: false, reason: "digest_mismatch" };
    if (capsule.staleAfterSequence !== undefined && (!Number.isInteger(capsule.staleAfterSequence) || capsule.staleAfterSequence < 0 || (expected.currentSequence !== undefined && capsule.staleAfterSequence <= expected.currentSequence))) return { accepted: false, reason: "workspace_mismatch" };
    if (capsule.taskEpochId !== report.taskEpochId) return { accepted: false, reason: "epoch_mismatch" };
    if (expected.taskId !== undefined && capsule.taskId !== expected.taskId) return { accepted: false, reason: "epoch_mismatch" };
    if (report.taskId !== undefined && capsule.taskId !== report.taskId) return { accepted: false, reason: "epoch_mismatch" };
    if (expected.workspaceIdentityDigest !== undefined && capsule.workspaceIdentityDigest !== expected.workspaceIdentityDigest) return { accepted: false, reason: "workspace_mismatch" };
    const expectedDigest = digestHostedEvidenceCapsule(capsule);
    if (capsule.digest !== expectedDigest) return { accepted: false, reason: "digest_mismatch" };
  } else if (evidenceIds === undefined) {
    return { accepted: false, reason: "digest_mismatch" };
  }
  return { accepted: true, reason: "accepted" };
}
export function digestHostedEvidenceCapsule(capsule: Omit<HostedEvidenceCapsule, "digest"> & { readonly digest?: string }): string {
  const { digest: _ignored, ...body } = capsule;
  return stableDigest(body);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
function stableDigest(value: unknown): string {
  const canonical = canonicalize(value);
  const text = typeof canonical === "string" ? canonical : JSON.stringify(canonical);
  return createHash("sha256").update(text).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) =>
    typeof entry === "string" && entry.length > 0 && entry.length <= maxLength
  );
}
