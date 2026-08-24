/**
 * Monotonic authority checks for plugin before-hook decisions.
 *
 * A plugin can only remove capabilities or raise caution. It never gains the
 * ability to add paths, relax network or sandbox policy, increase a bound, or
 * lower the host's assessed risk.
 */

import type { PluginRiskClass } from "./contracts.ts";

export type PluginNetworkMode = "deny" | "ask" | "allow";
export type PluginSandboxLevel = "strict" | "standard" | "unrestricted";

export interface EffectivePluginOperation {
  readonly workspaceRead: readonly string[];
  readonly workspaceWrite: readonly string[];
  readonly credentialScopes: readonly string[];
  readonly toolIds: readonly string[];
  readonly contextCandidateIds: readonly string[];
  readonly network: PluginNetworkMode;
  readonly timeoutMs: number;
  readonly outputBytes: number;
  readonly maxNodes: number;
  readonly risk: PluginRiskClass;
  readonly sandbox: PluginSandboxLevel;
}

export interface HookConstraints {
  readonly workspaceRead?: readonly string[];
  readonly workspaceWrite?: readonly string[];
  readonly credentialScopes?: readonly string[];
  readonly toolIds?: readonly string[];
  readonly contextCandidateIds?: readonly string[];
  readonly network?: PluginNetworkMode;
  readonly timeoutMs?: number;
  readonly outputBytes?: number;
  readonly maxNodes?: number;
  readonly riskFloor?: PluginRiskClass;
  readonly sandbox?: PluginSandboxLevel;
}

export interface NarrowingViolation {
  readonly field: string;
  readonly reason: string;
}

export type NarrowingResult =
  | { readonly ok: true; readonly effective: EffectivePluginOperation }
  | { readonly ok: false; readonly violations: readonly NarrowingViolation[] };

/**
 * Apply a plugin-proposed narrowing only if every proposed field is a subset or
 * stricter bound of the host operation. A single widening invalidates the whole
 * decision; partial application would make hook behavior ambiguous.
 */
export function validateNarrowing(
  original: EffectivePluginOperation,
  proposed: HookConstraints,
): NarrowingResult {
  const violations: NarrowingViolation[] = [];
  const workspaceRead = narrowedSet(
    original.workspaceRead,
    proposed.workspaceRead,
    "workspaceRead",
    violations,
  );
  const workspaceWrite = narrowedSet(
    original.workspaceWrite,
    proposed.workspaceWrite,
    "workspaceWrite",
    violations,
  );
  const credentialScopes = narrowedSet(
    original.credentialScopes,
    proposed.credentialScopes,
    "credentialScopes",
    violations,
  );
  const toolIds = narrowedSet(original.toolIds, proposed.toolIds, "toolIds", violations);
  const contextCandidateIds = narrowedSet(
    original.contextCandidateIds,
    proposed.contextCandidateIds,
    "contextCandidateIds",
    violations,
  );

  const network = narrowedEnum(
    original.network,
    proposed.network,
    { deny: 0, ask: 1, allow: 2 },
    "network",
    violations,
  );
  const sandbox = narrowedEnum(
    original.sandbox,
    proposed.sandbox,
    { strict: 0, standard: 1, unrestricted: 2 },
    "sandbox",
    violations,
  );
  const timeoutMs = narrowedPositiveBound(
    original.timeoutMs,
    proposed.timeoutMs,
    "timeoutMs",
    violations,
  );
  const outputBytes = narrowedPositiveBound(
    original.outputBytes,
    proposed.outputBytes,
    "outputBytes",
    violations,
  );
  const maxNodes = narrowedPositiveBound(
    original.maxNodes,
    proposed.maxNodes,
    "maxNodes",
    violations,
  );
  const risk = raisedRisk(original.risk, proposed.riskFloor, violations);

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    effective: {
      workspaceRead,
      workspaceWrite,
      credentialScopes,
      toolIds,
      contextCandidateIds,
      network,
      timeoutMs,
      outputBytes,
      maxNodes,
      risk,
      sandbox,
    },
  };
}

function narrowedSet(
  original: readonly string[],
  proposed: readonly string[] | undefined,
  field: string,
  violations: NarrowingViolation[],
): readonly string[] {
  const host = validSet(original, field, "host", violations);
  if (proposed === undefined) return host;
  const candidate = validSet(proposed, field, "plugin", violations);
  const allowed = new Set(host);
  for (const value of candidate) {
    if (!allowed.has(value)) {
      violations.push({
        field,
        reason: "plugin added a value that is absent from the host operation",
      });
    }
  }
  // Keep host ordering: hook-controlled ordering must not affect command semantics.
  const selected = new Set(candidate);
  return host.filter((value) => selected.has(value));
}

function validSet(
  values: readonly string[],
  field: string,
  source: string,
  violations: NarrowingViolation[],
): readonly string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (
      typeof value !== "string"
      || value.length === 0
      || value.length > 256
      || value.trim() !== value
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      violations.push({ field, reason: source + " value is not bounded text" });
      continue;
    }
    if (unique.has(value)) {
      violations.push({ field, reason: source + " values must be unique" });
      continue;
    }
    unique.add(value);
    normalized.push(value);
  }
  return normalized;
}

function narrowedEnum<T extends string>(
  original: T,
  proposed: T | undefined,
  rank: Readonly<Record<T, number>>,
  field: string,
  violations: NarrowingViolation[],
): T {
  if (rank[original] === undefined) {
    violations.push({ field, reason: "host policy is unsupported" });
    return original;
  }
  if (proposed === undefined) return original;
  if (rank[proposed] === undefined) {
    violations.push({ field, reason: "plugin policy is unsupported" });
    return original;
  }
  if (rank[proposed] > rank[original]) {
    violations.push({ field, reason: "plugin relaxed the host policy" });
    return original;
  }
  return proposed;
}

function narrowedPositiveBound(
  original: number,
  proposed: number | undefined,
  field: string,
  violations: NarrowingViolation[],
): number {
  if (!Number.isSafeInteger(original) || original <= 0) {
    violations.push({ field, reason: "host bound must be a positive safe integer" });
    return original;
  }
  if (proposed === undefined) return original;
  if (!Number.isSafeInteger(proposed) || proposed <= 0) {
    violations.push({ field, reason: "plugin bound must be a positive safe integer" });
    return original;
  }
  if (proposed > original) {
    violations.push({ field, reason: "plugin increased the host bound" });
    return original;
  }
  return proposed;
}

function raisedRisk(
  original: PluginRiskClass,
  proposed: PluginRiskClass | undefined,
  violations: NarrowingViolation[],
): PluginRiskClass {
  const rank: Readonly<Record<PluginRiskClass, number>> = {
    R0: 0,
    R1: 1,
    R2: 2,
    R3: 3,
    R4: 4,
  };
  if (rank[original] === undefined) {
    violations.push({ field: "riskFloor", reason: "host risk is unsupported" });
    return original;
  }
  if (proposed === undefined) return original;
  if (rank[proposed] === undefined) {
    violations.push({ field: "riskFloor", reason: "plugin risk is unsupported" });
    return original;
  }
  if (rank[proposed] < rank[original]) {
    violations.push({ field: "riskFloor", reason: "plugin lowered the host risk" });
    return original;
  }
  return proposed;
}
