/**
 * Persistent approval rules — PRD §13.3, §13.4, P0-13, P0-01.
 *
 * "Always allow" grants must outlive the process that collected them. They live in a
 * user-local file (`approvals.json`, never inside the workspace), and they are the
 * only rules that are persisted: a session grant dies with the session, exactly as
 * §13.4 intends.
 *
 * P0-01: a grant is bound to the workspace that earned it. The v1 store recorded
 * only the rule itself, so a command allowed in one repository applied to every
 * repository the user ever trusted — the UI said "in this project" while the file
 * said "everywhere". v2 records the workspace identity (canonical path, filesystem
 * identity, digest) and a loader only returns rules bound to the current
 * workspace.
 *
 * Migration is fail-closed. A v1 *allow* rule carries no project identifier, so it
 * is disabled rather than guessed at — the user re-approves in the workspace the
 * rule was meant for. A v1 *deny* rule is kept: it can only withhold, which is the
 * safe direction for a rule whose origin is unknown.
 *
 * Loading fails closed throughout — a corrupt store yields no rules, never a
 * permissive default. The policy engine still re-checks trust before honouring a
 * project rule, so a file written under one repository cannot grant anything in an
 * untrusted one.
 */

import type { ApprovalRule, StoredRule } from "@cbc/permissions";
import type { RiskClass } from "@cbc/tool-registry";

import { fnv1aHex, workspaceIdentityMatches, type Host, type CbcPaths, type WorkspaceIdentity } from "./host.ts";

/** A v2 entry: the rule plus the workspace that earned it. */
interface PersistedRuleV2 {
  readonly id: string;
  readonly workspace: {
    readonly canonicalPath: string;
    readonly filesystemId: string;
    readonly workspaceDigest: string;
  };
  readonly rule: ApprovalRule;
  readonly scope: "project";
  readonly decision: "allow" | "deny";
  readonly grantedForRisk: RiskClass;
  readonly grantedAt: string;
  readonly lastUsedAt?: string;
}

/** The historical entry, kept only so migration can read it. */
interface PersistedRuleV1 {
  readonly rule: ApprovalRule;
  readonly scope: "project";
  readonly decision: "allow" | "deny";
  readonly grantedForRisk: RiskClass;
  readonly grantedAt: string;
}

interface ApprovalRulesFileV2 {
  readonly version: 2;
  readonly rules: readonly (PersistedRuleV2 | PersistedRuleV1)[];
}

export interface LoadedApprovalRules {
  /** Rules that apply to the current workspace. */
  readonly rules: StoredRule[];
  /** v1 allow rules disabled by the migration, for a one-time notice. */
  readonly disabledLegacyAllows: number;
}

export interface StoredRuleEntry {
  readonly id: string;
  readonly rule: ApprovalRule;
  readonly decision: "allow" | "deny";
  readonly grantedForRisk: RiskClass;
  readonly grantedAt: string;
  readonly workspaceDigest: string;
  readonly legacy: boolean;
}

const RISK_CLASSES = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"] as const;

/**
 * Load the persisted rules that apply to `workspace`.
 *
 * Rules bound to any other workspace stay in the file untouched — they still
 * apply when that workspace opens them.
 */
export async function readApprovalRules(
  host: Host,
  paths: CbcPaths,
  workspace: WorkspaceIdentity,
): Promise<LoadedApprovalRules> {
  const file = await readRulesFile(host, paths);
  const rules: StoredRule[] = [];
  let disabledLegacyAllows = 0;

  for (const entry of file.rules) {
    if (isV2(entry)) {
      if (!workspaceIdentityMatches(entry.workspace, workspace)) continue;
      rules.push(toStoredRule(entry));
      continue;
    }
    // v1 entries carry no workspace binding. Denials are kept (fail-closed);
    // allows are disabled and reported so the user can re-approve them.
    if (entry.decision === "deny") {
      rules.push(toStoredRule(entry));
    } else {
      disabledLegacyAllows += 1;
    }
  }

  return { rules, disabledLegacyAllows };
}

/** Every persisted entry for this workspace, for inspection and revocation. */
export async function listApprovalRules(
  host: Host,
  paths: CbcPaths,
  workspace: WorkspaceIdentity,
): Promise<StoredRuleEntry[]> {
  const file = await readRulesFile(host, paths);
  const out: StoredRuleEntry[] = [];
  for (const entry of file.rules) {
    if (isV2(entry)) {
      if (!workspaceIdentityMatches(entry.workspace, workspace)) continue;
      out.push({
        id: entry.id,
        rule: entry.rule,
        decision: entry.decision,
        grantedForRisk: entry.grantedForRisk,
        grantedAt: entry.grantedAt,
        workspaceDigest: entry.workspace.workspaceDigest,
        legacy: false,
      });
      continue;
    }
    if (entry.decision !== "deny") continue;
    out.push({
      id: ruleId(entry.rule, entry.decision, ""),
      rule: entry.rule,
      decision: entry.decision,
      grantedForRisk: entry.grantedForRisk,
      grantedAt: entry.grantedAt,
      workspaceDigest: "",
      legacy: true,
    });
  }
  return out;
}

/** Remove one persisted rule by id. Returns true when an entry was removed. */
export async function revokeApprovalRule(
  host: Host,
  paths: CbcPaths,
  id: string,
): Promise<boolean> {
  const file = await readRulesFile(host, paths);
  const kept = file.rules.filter((entry) => !(isV2(entry) && entry.id === id));
  if (kept.length === file.rules.length) return false;
  await writeRulesFile(host, paths, { version: 2, rules: kept });
  return true;
}

/** Persist one granted rule bound to `workspace`. Duplicate grants are idempotent. */
export async function appendApprovalRule(
  host: Host,
  paths: CbcPaths,
  stored: StoredRule,
  nowMs: number,
  workspace: WorkspaceIdentity,
): Promise<void> {
  const existing = await readRulesFile(host, paths);
  const id = ruleId(stored.rule, stored.decision, workspace.workspaceDigest);
  const duplicate = existing.rules.some(
    (entry) => isV2(entry) && entry.id === id,
  );
  if (duplicate) return;

  const persisted: PersistedRuleV2 = {
    id,
    workspace: {
      canonicalPath: workspace.canonicalPath,
      filesystemId: workspace.filesystemId,
      workspaceDigest: workspace.workspaceDigest,
    },
    rule: stored.rule,
    scope: "project",
    decision: stored.decision,
    grantedForRisk: stored.grantedForRisk,
    grantedAt: new Date(nowMs).toISOString(),
  };
  await writeRulesFile(host, paths, { version: 2, rules: [...existing.rules, persisted] });
}

/** Record that a persisted rule matched, for later inspection. Best-effort. */
export async function touchApprovalRule(
  host: Host,
  paths: CbcPaths,
  id: string,
  nowMs: number,
): Promise<void> {
  const file = await readRulesFile(host, paths);
  let changed = false;
  const rules = file.rules.map((entry) => {
    if (!isV2(entry) || entry.id !== id) return entry;
    changed = true;
    return { ...entry, lastUsedAt: new Date(nowMs).toISOString() };
  });
  if (changed) await writeRulesFile(host, paths, { version: 2, rules });
}

async function writeRulesFile(
  host: Host,
  paths: CbcPaths,
  file: ApprovalRulesFileV2,
): Promise<void> {
  await host.fs.mkdirp(paths.config);
  await host.fs.write(paths.approvalStore, `${JSON.stringify(file, null, 2)}\n`);
}

async function readRulesFile(host: Host, paths: CbcPaths): Promise<ApprovalRulesFileV2> {
  const raw = await host.fs.read(paths.approvalStore);
  if (raw === undefined) return { version: 2, rules: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { version: 2, rules: [] };
    const file = parsed as { version?: unknown; rules?: unknown };
    if (file.version !== 1 && file.version !== 2) return { version: 2, rules: [] };
    if (!Array.isArray(file.rules)) return { version: 2, rules: [] };
    const rules: (PersistedRuleV2 | PersistedRuleV1)[] = [];
    for (const entry of file.rules) {
      const stored = parseStoredRule(entry, file.version);
      if (stored !== undefined) rules.push(stored);
    }
    return { version: 2, rules };
  } catch {
    // Fail closed: an unreadable grant file means nothing is pre-approved.
    return { version: 2, rules: [] };
  }
}

function isV2(entry: PersistedRuleV2 | PersistedRuleV1): entry is PersistedRuleV2 {
  return typeof (entry as PersistedRuleV2).id === "string";
}

function toStoredRule(entry: PersistedRuleV2 | PersistedRuleV1): StoredRule {
  return {
    rule: entry.rule,
    scope: entry.scope,
    decision: entry.decision,
    grantedForRisk: entry.grantedForRisk,
  };
}

/** Stable id: the grant itself plus the workspace it is bound to. */
function ruleId(rule: ApprovalRule, decision: "allow" | "deny", workspaceDigest: string): string {
  return `rule_${fnv1aHex(`${workspaceDigest}\u0000${JSON.stringify(rule)}\u0000${decision}`)}`;
}

function parseStoredRule(
  value: unknown,
  version: number,
): PersistedRuleV2 | PersistedRuleV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Partial<PersistedRuleV2> & { grantedAt?: unknown };
  if (entry.scope !== "project") return undefined;
  if (entry.decision !== "allow" && entry.decision !== "deny") return undefined;
  if (typeof entry.grantedForRisk !== "string" || !RISK_CLASSES.includes(entry.grantedForRisk)) {
    return undefined;
  }
  const rule = parseApprovalRule(entry.rule);
  if (rule === undefined) return undefined;
  const grantedAt =
    typeof entry.grantedAt === "string" ? entry.grantedAt : new Date(0).toISOString();

  if (version === 2 && typeof entry.id === "string") {
    const workspace = entry.workspace;
    if (
      typeof workspace !== "object" ||
      workspace === null ||
      typeof workspace.canonicalPath !== "string" ||
      typeof workspace.workspaceDigest !== "string"
    ) {
      // A v2 entry that cannot prove where it came from is dropped: loading it
      // would recreate exactly the leak v2 exists to close.
      return undefined;
    }
    return {
      id: entry.id,
      workspace: {
        canonicalPath: workspace.canonicalPath,
        filesystemId:
          typeof workspace.filesystemId === "string" ? workspace.filesystemId : "",
        workspaceDigest: workspace.workspaceDigest,
      },
      rule,
      scope: "project",
      decision: entry.decision,
      grantedForRisk: entry.grantedForRisk,
      grantedAt,
      ...(typeof entry.lastUsedAt === "string" ? { lastUsedAt: entry.lastUsedAt } : {}),
    };
  }

  return { rule, scope: "project", decision: entry.decision, grantedForRisk: entry.grantedForRisk, grantedAt };
}

function parseApprovalRule(value: unknown): ApprovalRule | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rule = value as Partial<ApprovalRule>;
  if (typeof rule.tool !== "string") return undefined;
  return {
    tool: rule.tool,
    ...(typeof rule.program === "string" ? { program: rule.program } : {}),
    ...(Array.isArray(rule.argsExact)
      ? { argsExact: rule.argsExact.filter((arg): arg is string => typeof arg === "string") }
      : {}),
    ...(Array.isArray(rule.argsPrefix)
      ? { argsPrefix: rule.argsPrefix.filter((arg): arg is string => typeof arg === "string") }
      : {}),
    ...(typeof rule.cwd === "string" ? { cwd: rule.cwd } : {}),
    ...(Array.isArray(rule.paths)
      ? { paths: rule.paths.filter((path): path is string => typeof path === "string") }
      : {}),
    ...(typeof rule.server === "string" ? { server: rule.server } : {}),
    ...(typeof rule.network === "boolean" ? { network: rule.network } : {}),
    ...(typeof rule.sideEffect === "boolean" ? { sideEffect: rule.sideEffect } : {}),
  };
}
