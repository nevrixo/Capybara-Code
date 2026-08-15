/**
 * Permission policy — PRD §13, Appendix B.3, Appendix C, AC-16, AC-18, AC-19,
 * AC-38, PERM-001..PERM-006.
 *
 * §24.1 invariant 1: "모델은 permission을 직접 grant할 수 없다." Nothing the model
 * says can reach `allow`; only a user decision or a pre-existing rule can.
 */

import { createHash } from "node:crypto";

import type { RiskClass, ToolDefinition } from "@cbc/tool-registry";
import { allowsBroadRule } from "@cbc/tool-registry";

import {
  classifyCommand,
  detectProcessSemantics,
  maxRisk,
  type Classification,
  type CommandSpec,
} from "./classifier.ts";
import {
  inferPermissionPresetFromConfig,
  legacyPermissionModeToPreset,
  type PermissionPreset,
} from "./presets.ts";

/** §13.1 permission modes. `full`/`dangerously-skip-permissions` do not exist. */
export type PermissionMode = "plan" | "ask" | "auto" | "auto-review";
export type InteractionMode = "build" | "plan";

export type TrustState = "untrusted" | "trusted-once" | "trusted-always" | "read-only";

export interface ProposedAction {
  readonly callId: string;
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Normalized workspace-relative paths this action reads. */
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  /** Present for process and shell tools. */
  readonly command?: CommandSpec;
  /** Present for MCP calls. */
  readonly mcp?: {
    readonly server: string;
    readonly tool: string;
    /** Server-declared annotation, treated as a hint only (§17.8). */
    readonly annotatedReadOnly?: boolean;
    readonly sideEffectHint?: "read" | "write" | "destructive" | "unknown";
  };
  /** Human-readable rendering shown on the approval card. */
  readonly display: string;
}

export interface ApprovalRule {
  readonly tool: string;
  readonly program?: string;
  /** Legacy compatibility; new grants use exact argv matching. */
  readonly argsPrefix?: readonly string[];
  readonly argsExact?: readonly string[];
  readonly cwd?: string;
  readonly paths?: readonly string[];
  readonly server?: string;
  readonly network?: boolean;
  readonly sideEffect?: boolean;
  /** Exact digest of the explicit process environment covered by this grant. */
  readonly envHash?: string;
  /** Exact digest of MCP arguments covered by this grant. */
  readonly argumentsHash?: string;
}

export type RuleScope = "session" | "project";

export interface StoredRule {
  readonly rule: ApprovalRule;
  readonly scope: RuleScope;
  readonly decision: "allow" | "deny";
  /** Risk at the time of the grant, so an escalated action re-asks. */
  readonly grantedForRisk: RiskClass;
}

export interface PlanFileScope {
  /** Concrete workspace-relative file or directory anchor. */
  readonly path: string;
}

export interface PlanCommandScope {
  readonly program: string;
  readonly args: readonly string[];
  /** Exact workspace root used for this command. */
  readonly cwd: string;
  /** Whether the declared command is expected to require network access. */
  readonly network?: boolean;
}

export interface PlanMcpScope {
  readonly server: string;
  readonly tool: string;
  /** Canonical digest of the declared MCP payload, when the Plan bound one. */
  readonly argumentsHash?: string;
}

/** Digest-bound execution ceiling produced by an explicitly approved Plan. */
export interface ApprovedPlanScope {
  readonly digest: string;
  readonly workspaceRoot?: string;
  readonly files?: readonly PlanFileScope[];
  readonly commands?: readonly PlanCommandScope[];
  readonly externalActions?: readonly PlanMcpScope[];
}

export interface PermissionContext {
  readonly mode: PermissionMode;
  /** Independent work-intent ceiling; Plan is always read-only unless approved. */
  readonly interactionMode?: InteractionMode;
  /** Digest-bound Plan scope. Missing or malformed scope fails closed for effects. */
  readonly approvedPlan?: ApprovedPlanScope;
  /** Alias accepted by embedders during the migration to approvedPlan. */
  readonly planScope?: ApprovedPlanScope;
  /** A drafted Plan/TODO is present and therefore needs a one-shot execution directive. */
  readonly planExecutionRequired?: boolean;
  /** True only during the one Build turn explicitly authorized by /plan execute. */
  readonly planExecutionActive?: boolean;
  /** Trusted canonical workspace root supplied by the host, never by the model. */
  readonly workspaceRoot?: string;
  /** New preset surface — when set, overrides legacy mode branching. */
  readonly preset?: PermissionPreset;
  readonly trust: TrustState;
  /** Rules from config plus rules the user granted this session (§13.3). */
  readonly rules: readonly StoredRule[];
  /** Deny rules from project/user policy that outrank everything (§13.8 step 1). */
  readonly hardDeny?: readonly ApprovalRule[];
  readonly catalog: readonly ToolDefinition[];
  /** Role of the agent proposing the action, for scoped subagents (§15.2). */
  readonly agentRole:
    | "root"
    | "explore"
    | "planner"
    | "architect"
    | "executor"
    | "refactorer"
    | "reviewer"
    | "test";
  /** Capability limits for a delegated child, independent of its role label. */
  readonly agentCapabilities?: {
    readonly canWrite?: boolean;
    readonly canRunProcess?: boolean;
    readonly allowedPaths?: readonly string[];
    readonly forbiddenPaths?: readonly string[];
  };
  /** True in `capy run` (§13.8): never prompt. */
  readonly nonInteractive: boolean;
  /** `--read-only` CLI flag (§13.8 step 2). */
  readonly readOnly?: boolean;
  /** Headless approval policy file (§13.8 step 3). */
  readonly headlessPolicy?: "deny-on-ask" | "allow-listed" | "fail-on-ask";
  /** §21.4 `[permissions]` block. */
  readonly configPermissions?: {
    /** Absent means `auto`: the historical behaviour. */
    readonly projectWrite?: "plan" | "ask" | "auto";
    readonly shell: "deny" | "ask" | "safe-auto";
    readonly network: "deny" | "ask" | "allow";
    readonly destructive: "deny" | "ask";
    readonly credentials: "deny" | "ask";
    readonly externalSideEffect: "deny" | "ask";
  };
}

/** Tools that execute code, and therefore can mutate anything the user can. */
const MCP_WRITE_NAME =
  /create|update|delete|close|merge|comment|write|post|put|patch|remove|send|assign|publish|deploy|upload|set|add|edit/i;

const PROCESS_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  "process.run",
  "process.start",
  "process.input",
  "shell.run",
]);

export function isProcessExecutionTool(toolId: string): boolean {
  return PROCESS_EXECUTION_TOOLS.has(toolId) && toolId !== "process.stop";
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly callId: string;
  readonly action: string;
  readonly display: string;
  readonly cwd?: string;
  readonly riskClass: RiskClass;
  readonly reason: string;
  readonly network: boolean;
  readonly sideEffects: string[];
  /** §13.2: R4–R6 may not offer a broad allow. */
  readonly offeredScopes: Array<"once" | "turn" | "session" | "project">;
  /** Stable hash for the audit record (§18.15 `approvals.action_hash`). */
  readonly actionHash: string;
  /**
   * The exact rule a broad grant would persist, built from the normalized action
   * (§7.6). Without it the broker could only fall back to a tool-scoped rule,
   * which is wider than the "this command prefix" the user actually approved.
   */
  readonly ruleCandidate?: ApprovalRule;
}

export type PermissionDecision =
  | { kind: "allow"; scope: "operation" | "turn" | "session"; reason: string }
  | { kind: "ask"; request: ApprovalRequest }
  | { kind: "deny"; reason: string };

export type ApprovalDecision =
  | { kind: "allow_once" }
  | { kind: "allow_turn" }
  | { kind: "allow_session"; rule: ApprovalRule }
  | { kind: "allow_project"; rule: ApprovalRule }
  | { kind: "deny"; reason?: string }
  | { kind: "edit"; replacement: ProposedAction };

/** Stable hash of the complete normalized operation (PERM-006). */
export function actionHash(action: ProposedAction): string {
  return digestCanonical({
    toolId: action.toolId,
    arguments: action.arguments,
    program: action.command?.program,
    args: action.command?.args,
    cwd: action.command?.cwd,
    env: action.command?.env ?? {},
    networkIntent: action.command?.networkIntent,
    writes: [...(action.writes ?? [])].sort(),
    reads: [...(action.reads ?? [])].sort(),
    mcp: action.mcp,
  });
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** Stable canonical digest shared by Plan argument bindings and policy hashes. */
export const canonicalDigest = digestCanonical;

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $number: String(value) };
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return { $type: typeof value, $value: String(value) };
}

/** Resolve the effective risk of an action, combining tool baseline + classifier. */
export function assessRisk(
  action: ProposedAction,
  catalog: readonly ToolDefinition[],
): { risk: RiskClass; classification?: Classification; reasons: string[] } {
  const tool = catalog.find((t) => t.id === action.toolId);
  const baseline = tool?.defaultRisk ?? "R3";
  const reasons: string[] = [];

  if (action.command) {
    const classification = classifyCommand(action.command, baseline);
    // The classifier may raise risk but never lower it below the declared max.
    const capped = tool ? capAt(classification.risk, tool.maxRisk) : classification.risk;
    return { risk: capped, classification, reasons: classification.reasons };
  }

  if (action.mcp) {
    // §17.8: an unknown MCP tool defaults to ask, and a server's own
    // "read-only" claim is only a hint the classifier may override.
    let risk: RiskClass = "R3";
    const hint = action.mcp.sideEffectHint ?? "unknown";
    if (hint === "read") risk = "R0";
    if (hint === "write") risk = "R6";
    if (hint === "destructive") risk = "R6";
    if (hint === "unknown") {
      risk = "R3";
      reasons.push("the MCP tool's side effects are unknown");
    }
    const nameSuggestsWrite = MCP_WRITE_NAME.test(action.mcp.tool);
    if (nameSuggestsWrite) {
      risk = maxRisk(risk, "R6");
      reasons.push(`'${action.mcp.tool}' looks like an external side effect`);
      if (action.mcp.annotatedReadOnly === true) {
        // §17.8: CBC may promote risk even when the server claims read-only.
        reasons.push(
          "the server annotated this tool read-only, but its name indicates a side effect",
        );
      }
    }
    return { risk, reasons };
  }

  // Path-based sensitivity for pure filesystem actions.
  let risk = baseline;
  const paths = [...(action.reads ?? []), ...(action.writes ?? [])];
  if (paths.some(isSensitivePath)) {
    risk = maxRisk(risk, "R5");
    reasons.push("touches credential-like paths");
  }
  if (paths.some((p) => p.startsWith("..") || p.startsWith("/") || p.startsWith("~"))) {
    risk = maxRisk(risk, "R5");
    reasons.push("targets a path outside the workspace");
  }
  return { risk, reasons };
}

function capAt(risk: RiskClass, ceiling: RiskClass): RiskClass {
  const order: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];
  return order.indexOf(risk) > order.indexOf(ceiling) ? ceiling : risk;
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return [".env", ".pem", ".key", "id_rsa", "id_ed25519", ".ssh/", ".aws/", ".npmrc", ".netrc"].some(
    (marker) => lower.includes(marker),
  );
}


/** Validate the path anchors supplied by a Plan before they reach policy. */
export function validatePlanScopePath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//u, "");
  if (!path || path === "." || path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.startsWith("~")) {
    throw new Error(`Plan scope path '${raw}' must be workspace-relative`);
  }
  if (path.split("/").some((part) => part === ".." || part.length === 0)) {
    throw new Error(`Plan scope path '${raw}' contains traversal`);
  }
  if (/[*?\[\]]/u.test(path)) throw new Error(`Plan scope path '${raw}' may not contain wildcards`);
  return path;
}

function normalizeWorkspaceRoot(raw: string): string | undefined {
  const unified = raw.replace(/\\/g, "/");
  if (unified.length === 0 || (!unified.startsWith("/") && !/^[A-Za-z]:\//u.test(unified))) return undefined;
  if (unified === "/" || /^[A-Za-z]:\/$/u.test(unified)) return unified;
  return unified.replace(/\/+$/u, "");
}

export function normalizeApprovedPlanScope(scope: ApprovedPlanScope | undefined): ApprovedPlanScope | undefined {
  if (scope === undefined || typeof scope !== "object" || typeof scope.digest !== "string" || !/^plan-sha256-[a-f0-9]{64}$/u.test(scope.digest)) return undefined;
  try {
    if (scope.workspaceRoot !== undefined && typeof scope.workspaceRoot !== "string") return undefined;
    const workspaceRoot = scope.workspaceRoot === undefined ? undefined : normalizeWorkspaceRoot(scope.workspaceRoot);
    if (scope.workspaceRoot !== undefined && workspaceRoot === undefined) return undefined;
    const files = (scope.files ?? []).map((entry) => ({ path: validatePlanScopePath(entry.path) }));
    const rawCommands = scope.commands ?? [];
    if (rawCommands.length > 0 && workspaceRoot === undefined) return undefined;
    const commands = rawCommands.map((entry) => {
      if (typeof entry.program !== "string" || !Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string") || typeof entry.cwd !== "string" || (entry.network !== undefined && typeof entry.network !== "boolean")) throw new Error("malformed Plan command scope");
      const cwd = normalizeWorkspaceRoot(entry.cwd);
      if (cwd === undefined || cwd !== workspaceRoot) throw new Error("Plan command cwd must equal workspaceRoot");
      return {
        program: entry.program,
        args: [...entry.args],
        cwd,
        ...(entry.network === undefined ? {} : { network: entry.network === true }),
      };
    });
    const externalActions = (scope.externalActions ?? []).map((entry) => {
      if (typeof entry.server !== "string" || typeof entry.tool !== "string" || (entry.argumentsHash !== undefined && (typeof entry.argumentsHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.argumentsHash)))) throw new Error("malformed Plan MCP scope");
      return {
        server: entry.server,
        tool: entry.tool,
        ...(entry.argumentsHash === undefined ? {} : { argumentsHash: entry.argumentsHash }),
      };
    });
    return {
      digest: scope.digest,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(files.length > 0 ? { files } : {}),
      ...(commands.length > 0 ? { commands } : {}),
      ...(externalActions.length > 0 ? { externalActions } : {}),
    };
  } catch {
    return undefined;
  }
}

function pathWithinPlanScope(path: string, anchor: string): boolean {
  let normalizedPath: string;
  let normalizedAnchor: string;
  try {
    normalizedPath = validatePlanScopePath(path).replace(/\/$/u, "");
    normalizedAnchor = validatePlanScopePath(anchor).replace(/\/$/u, "");
  } catch {
    return false;
  }
  return normalizedPath === normalizedAnchor || normalizedPath.startsWith(`${normalizedAnchor}/`);
}

function tokenizePlanCommand(raw: string): { readonly program: string; readonly args: readonly string[] } | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  const text = raw.trim();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") { quote = undefined; continue; }
      if (char === "\\" && next !== undefined && /[\s"\\]/u.test(next)) {
        token += next;
        index += 1;
      } else token += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (char === "\\") {
      if (next !== undefined && /[\s'"\\]/u.test(next)) {
        token += next;
        index += 1;
      } else token += char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (token.length > 0) { tokens.push(token); token = ""; }
      continue;
    }
    token += char;
  }
  if (quote !== undefined) return undefined;
  if (token.length > 0) tokens.push(token);
  const program = tokens.shift();
  return program === undefined || program.length === 0 ? undefined : { program, args: tokens };
}

/** Canonical payload binding for a digest-bound MCP external action. */
export function mcpActionArgumentsHash(action: ProposedAction): string {
  const args = action.arguments as Record<string, unknown>;
  if (action.toolId === "mcp.call") {
    return digestCanonical(args.arguments ?? {});
  }
  if (action.toolId === "mcp.read_resource") {
    return digestCanonical({ uri: args.uri });
  }
  return digestCanonical(args);
}

function actionInApprovedPlanScope(
  action: ProposedAction,
  scope: ApprovedPlanScope,
  options: { readonly workspaceRoot?: string } = {},
): { readonly inScope: boolean; readonly forceAsk: boolean; readonly reason?: string } {
  if (action.toolId === "process.stop") return { inScope: true, forceAsk: false };
  const toolIsFileMutation = action.toolId === "fs.write" || action.toolId === "fs.apply_patch";
  const destructiveFileMutation = action.toolId === "fs.delete" || action.toolId === "fs.move";
  if (destructiveFileMutation) {
    const paths = [...(action.reads ?? []), ...(action.writes ?? [])];
    const inScope = paths.length > 0 && paths.every((path) => (scope.files ?? []).some((anchor) => pathWithinPlanScope(path, anchor.path)));
    return inScope
      ? { inScope: true, forceAsk: true, reason: "destructive Plan operation still requires one-operation approval" }
      : { inScope: false, forceAsk: false, reason: "file path is outside the approved Plan scope" };
  }
  if (toolIsFileMutation) {
    const paths = [...(action.reads ?? []), ...(action.writes ?? [])];
    if (paths.length === 0 || !paths.every((path) => (scope.files ?? []).some((anchor) => pathWithinPlanScope(path, anchor.path)))) {
      return { inScope: false, forceAsk: false, reason: "file path is outside the approved Plan scope" };
    }
    return { inScope: true, forceAsk: false };
  }
  if (isProcessExecutionTool(action.toolId)) {
    if (action.toolId === "process.input") return { inScope: false, forceAsk: false, reason: "process.input has no exact command proof in a Plan" };
    const command = action.command;
    if (command === undefined || (command.env !== undefined && Object.keys(command.env).length > 0)) {
      return { inScope: false, forceAsk: false, reason: "Plan process execution requires an exact command without environment injection" };
    }
    const workspaceRoot = options.workspaceRoot ?? scope.workspaceRoot;
    const trustedRoot = workspaceRoot === undefined ? undefined : normalizeWorkspaceRoot(workspaceRoot);
    const declaredRoot = scope.workspaceRoot === undefined ? undefined : normalizeWorkspaceRoot(scope.workspaceRoot);
    if (trustedRoot === undefined || declaredRoot === undefined || trustedRoot !== declaredRoot) {
      return { inScope: false, forceAsk: false, reason: "Plan command scope has no trusted workspace root" };
    }
    const cwdMatches = (candidate: PlanCommandScope): boolean => candidate.cwd === trustedRoot;
    const comparable = command.rawShell === true
      ? tokenizePlanCommand(command.script ?? "")
      : { program: command.program, args: command.args };
    if (comparable === undefined) return { inScope: false, forceAsk: false, reason: "raw shell command could not be tokenized for Plan scope" };
    const networkRequired = classifyCommand(command).network === true || command.networkIntent?.required === true;
    const match = (scope.commands ?? []).some((candidate) =>
      candidate.program === comparable.program &&
      (candidate.network === true) === networkRequired &&
      cwdMatches(candidate) &&
      (command.cwd === trustedRoot || command.cwd === ".") &&
      candidate.args.length === comparable.args.length &&
      candidate.args.every((arg, index) => arg === comparable.args[index]),
    );
    if (!match) return { inScope: false, forceAsk: false, reason: "process command, argv, or workspace cwd is outside the approved Plan scope" };
    const shellLike = command.rawShell === true || detectProcessSemantics(command) !== "direct-executable";
    return { inScope: true, forceAsk: shellLike, ...(shellLike ? { reason: "raw shell commands are never automatically approved" } : {}) };
  }
  if (action.mcp !== undefined || action.toolId === "mcp.call" || action.toolId === "mcp.read_resource") {
    const server = action.mcp?.server ?? String(action.arguments.server ?? "");
    const tool = action.mcp?.tool ?? String(action.arguments.tool ?? "");
    const match = (scope.externalActions ?? []).some((entry) =>
      entry.server === server &&
      entry.tool === tool &&
      (entry.argumentsHash === undefined || entry.argumentsHash === mcpActionArgumentsHash(action))
    );
    return match
      ? { inScope: true, forceAsk: true, reason: "MCP operations retain their normal external-side-effect approval" }
      : { inScope: false, forceAsk: false, reason: "MCP server/tool or arguments are outside the approved Plan scope" };
  }
  // Reads remain available in Plan, but networked/unverified operations do not.
  if ((action.reads?.length ?? 0) > 0 && action.writes?.length === 0 && action.mcp === undefined && action.command === undefined) return { inScope: true, forceAsk: false };
  return { inScope: false, forceAsk: false, reason: "operation is not declared in the approved Plan scope" };
}

/**
 * Why *every* workspace mutation would be refused in this context, or
 * `undefined` when a concrete action could still be allowed.
 *
 * This is the spawn-time preflight for writer subagents: the gates below do not
 * depend on the specific action, so a child admitted despite them can only
 * discover the denial at its final write — after spending its whole budget on
 * work that could never land (§15.3). Failing at spawn is the honest version.
 */
export function mutationBlockReason(context: PermissionContext): string | undefined {
  if (context.readOnly === true) return "--read-only forbids workspace mutation";
  if ((context.planExecutionRequired === true || context.approvedPlan !== undefined || context.planScope !== undefined) && context.interactionMode === "build" && normalizeApprovedPlanScope(context.approvedPlan ?? context.planScope) === undefined) {
    return "a drafted Plan requires explicit digest-bound execution approval";
  }
  if (context.trust === "untrusted") return "this project is not trusted, so mutation is refused";
  if (context.trust === "read-only") return "this project was opened read-only";
  if (context.preset === "read" && !(context.approvedPlan !== undefined && context.interactionMode === "build")) return "Plan mode does not modify the workspace";
  if ((context.interactionMode === undefined && context.mode === "plan") || context.interactionMode === "plan") return "Plan mode does not modify the workspace";
  return undefined;
}

/**
 * Why *every* process execution would be refused in this context, or
 * `undefined` when a concrete command could still run.
 *
 * Mirrors the runtime's `require_process_allowed`: an untrusted workspace has
 * not earned code execution (§13.6). A read-only workspace no longer keeps it
 * either (P0-02): a process can write anywhere the user can, so "read-only"
 * that still runs code is read-only in name only.
 */
export function processBlockReason(context: PermissionContext): string | undefined {
  if ((context.planExecutionRequired === true || context.approvedPlan !== undefined || context.planScope !== undefined) && context.interactionMode === "build" && normalizeApprovedPlanScope(context.approvedPlan ?? context.planScope) === undefined) {
    return "a drafted Plan requires explicit digest-bound execution approval";
  }
  if (context.trust === "untrusted") {
    return "workspace is untrusted; running processes requires a trust decision";
  }
  if (context.readOnly === true) {
    return "read-only mode does not allow process execution; a process can mutate the workspace";
  }
  if (context.trust === "read-only") {
    return "this project was opened read-only; process execution is not allowed";
  }
  if (context.preset === "read" && !(context.approvedPlan !== undefined && context.interactionMode === "build")) {
    return "Plan mode does not run processes";
  }
  if ((context.interactionMode === undefined && context.mode === "plan") || context.interactionMode === "plan") {
    return "Plan mode does not run processes";
  }
  return undefined;
}

/**
 * The core policy evaluation. Order follows §13.8 so headless and interactive
 * runs agree on precedence.
 */
export function evaluate(
  action: ProposedAction,
  context: PermissionContext,
): PermissionDecision {
  const tool = context.catalog.find((t) => t.id === action.toolId);
  const { risk, classification, reasons } = assessRisk(action, context.catalog);
  const hash = actionHash(action);
  const mcpSideEffect =
    action.mcp !== undefined &&
    (action.mcp.sideEffectHint === "write" ||
      action.mcp.sideEffectHint === "destructive" ||
      MCP_WRITE_NAME.test(action.mcp.tool));
  const mcpDestructive = action.mcp?.sideEffectHint === "destructive";
  const mcpUnknownOrSideEffect = action.mcp !== undefined && action.mcp.sideEffectHint !== "read";
  /** A local or external mutation declared by the normalized operation. */
  const isWrite = tool?.mutates === true || (action.writes?.length ?? 0) > 0 || mcpSideEffect || mcpUnknownOrSideEffect;
  const isProcessExecution = isProcessExecutionTool(action.toolId);
  /**
   * P0-02: running code is a *potential* mutation whatever the tool metadata
   * says — a process can write anywhere the user can, which is also why the
   * executor drops the read cache before every run. Read-only gates key on
   * this, while the role gate below still keys on declared writes alone so a
   * read-only subagent keeps its read-shaped commands.
   */
  const potentialMutation = isWrite || isProcessExecution;
  const network =
    classification?.network === true ||
    tool?.network === true ||
    action.command?.networkIntent?.required === true;
  const shellLike =
    action.toolId === "shell.run" ||
    action.command?.rawShell === true ||
    classification?.shellLike === true;
  let planForceAskReason: string | undefined;
  let planScopeForcesAsk = false;

  // ---- Step 1: hard deny invariants ----
  for (const rule of context.hardDeny ?? []) {
    if (matchesRule(rule, action)) {
      return { kind: "deny", reason: `denied by policy rule for ${rule.tool}` };
    }
  }
  // §21.4 `credentials = "deny"` is a hard invariant, not an ask.
  if (risk === "R5" && (context.configPermissions?.credentials ?? "deny") === "deny") {
    return {
      kind: "deny",
      reason:
        "credential material is denied by policy; it is not passed to the model even with approval",
    };
  }

  // ---- Step 2: CLI --read-only (P0-02: processes included) ----
  if (context.readOnly === true) {
    if (isProcessExecution) {
      return {
        kind: "deny",
        reason:
          "read-only mode does not allow process execution; a process can mutate the workspace",
      };
    }
    if (isWrite) {
      return { kind: "deny", reason: "--read-only forbids workspace mutation" };
    }
  }

  // ---- Trust gates (§13.6, P0-02) ----
  if (context.trust === "untrusted") {
    if (isProcessExecution) {
      return {
        kind: "deny",
        reason: "workspace is untrusted; running processes requires a trust decision",
      };
    }
    if (potentialMutation) {
      return { kind: "deny", reason: "this project is not trusted, so mutation is refused" };
    }
  }
  if (context.trust === "read-only") {
    if (isProcessExecution) {
      return {
        kind: "deny",
        reason: "this project was opened read-only; process execution is not allowed",
      };
    }
    if (potentialMutation) {
      return { kind: "deny", reason: "this project was opened read-only" };
    }
  }

  // ---- Config deny gates (P0-05: before any stored allow rule) ----
  // A deny configured *after* a rule was granted must win immediately; a saved
  // allow is a convenience for the user, never an override of current policy.
  const config = context.configPermissions;
  if (config) {
    if ((classification?.destructive === true || mcpDestructive) && config.destructive === "deny") {
      return { kind: "deny", reason: "destructive actions are denied by policy" };
    }
    if (network && config.network === "deny") {
      return { kind: "deny", reason: "network access is denied by policy" };
    }
    if ((classification?.externalSideEffect === true || mcpSideEffect) && config.externalSideEffect === "deny") {
      return { kind: "deny", reason: "external side effects are denied by policy" };
    }
    // P0-04: `shell = "deny"` covers every shell-shaped invocation, whichever
    // tool carries it — `process.run sh -c` included.
    if (config.shell === "deny" && shellLike) {
      // AC-27: a Skill cannot bypass this.
      return { kind: "deny", reason: "raw shell is denied by policy" };
    }
    if ((config.projectWrite ?? "auto") === "plan" && potentialMutation) {
      return { kind: "deny", reason: 'permissions.project_write = "plan" denies workspace mutation and process execution' };
    }
  }

  // `network = ask` is an approval boundary even for a classifier-known read
  // operation. In particular, an MCP server's read annotation must not turn a
  // remote connection into an automatic allow.
  if (network && config?.network === "ask") {
    planForceAskReason ??= "network access requires approval";
  }

  // ---- Stored deny rules (still outrank every allow) ----
  for (const stored of context.rules) {
    if (stored.decision === "deny" && matchesRule(stored.rule, action)) {
      return { kind: "deny", reason: `denied by a ${stored.scope} rule` };
    }
  }

  // ---- Role scoping (§15.2) ----
  // `refactorer` writes by definition — removing a code smell means editing the
  // code. `architect` does not: it assesses impact, and an assessor that can
  // rewrite what it is assessing is no longer an independent check.
  if (isWrite && !["root", "executor", "refactorer"].includes(context.agentRole)) {
    return {
      kind: "deny",
      reason: `the ${context.agentRole} role is read-only and may not mutate the workspace`,
    };
  }

  const isProcessTool = isProcessExecution || action.toolId === "process.stop";
  if (isProcessTool && action.toolId !== "process.stop" && context.agentCapabilities?.canRunProcess === false) {
    return {
      kind: "deny",
      reason: "the " + context.agentRole + " role is not permitted to run processes",
    };
  }
  // Delegated capability ceilings are independent of role labels and stored
  // rules. Unknown MCP effects count as writes until a read annotation proves
  // otherwise; a read-only child can never turn that uncertainty into an ask.
  const capabilities = context.agentCapabilities;
  if (capabilities?.canWrite === false && isWrite) {
    return { kind: "deny", reason: `the ${context.agentRole} capability does not permit workspace or external mutation` };
  }
  const capabilityPaths = [
    ...(action.reads ?? []),
    ...(action.writes ?? []),
    ...(isProcessExecution && action.command?.cwd !== undefined ? [action.command.cwd] : []),
  ];
  const workspaceBoundAction = action.toolId.startsWith("fs.") || action.toolId.startsWith("git.") || isProcessExecution;
  if (workspaceBoundAction && capabilityPaths.length === 0 && (capabilities?.allowedPaths?.length ?? 0) > 0) {
    return { kind: "deny", reason: "the delegated path scope cannot prove this workspace-wide action is allowed" };
  }
  if (workspaceBoundAction && capabilityPaths.length === 0 && (capabilities?.forbiddenPaths?.length ?? 0) > 0) {
    return { kind: "deny", reason: "the delegated path scope cannot prove this workspace-wide action avoids forbidden paths" };
  }
  if (capabilityPaths.length > 0) {
    if (capabilities?.forbiddenPaths?.some((pattern) => capabilityPaths.some((path) => capabilityPathMatches(pattern, path)))) {
      return { kind: "deny", reason: "the action touches a path forbidden to this delegated agent" };
    }
    // An explicit positive scope is a ceiling for reads, writes, and process
    // working directories. Empty means the task did not request path scoping;
    // writer tasks are rejected earlier unless they provide a non-empty lease.
    if (capabilities?.allowedPaths !== undefined && capabilities.allowedPaths.length > 0 && capabilityPaths.some((path) => !capabilities.allowedPaths!.some((pattern) => capabilityPathMatches(pattern, path)))) {
      return { kind: "deny", reason: "the action touches a path outside this delegated agent's allowed scope" };
    }
  }
  // ---- Preset gates (new surface — §4.1) ----
  // Interaction mode is the live work-intent authority. Legacy callers that
  // omit it retain `mode: plan` semantics; AgentSession always supplies it so
  // an explicitly installed Build execution can leave a Plan-started session.
  const inPlan = context.interactionMode === "plan" || (context.interactionMode === undefined && context.mode === "plan");
  const approvedScope = normalizeApprovedPlanScope(context.approvedPlan ?? context.planScope);
  const configuredPreset: PermissionPreset | "custom" | undefined =
    context.preset ??
    (context.mode ? legacyPermissionModeToPreset(context.mode) : undefined) ??
    inferPermissionPresetFromConfig(config as Record<string, string> | undefined);
  // `--plan` historically installs the read preset as a startup default. An
  // explicit digest-bound execution is the documented escape hatch; keep all
  // hard/config deny gates, but run the ordinary risk policy instead of making
  // every approved file operation impossible.
  const effectivePreset: PermissionPreset | "custom" | undefined =
    approvedScope !== undefined && !inPlan && configuredPreset === "read" ? "auto" : configuredPreset;
  const effectful = potentialMutation || action.mcp !== undefined || tool?.source === "mcp";
  // An approved scope is a ceiling in Build execution too. It is deliberately
  // checked before presets and stored rules, so YOLO or an old allow rule cannot
  // widen the digest-bound contract.
  const planScopeProvided = context.approvedPlan !== undefined || context.planScope !== undefined;
  if (!inPlan && effectful && (context.planExecutionRequired === true || planScopeProvided) && approvedScope === undefined) {
    return { kind: "deny", reason: "a drafted Plan requires explicit digest-bound execution approval" };
  }
  if (approvedScope !== undefined && !inPlan && effectful) {
    if (action.toolId === "process.stop") return { kind: "allow", scope: "operation", reason: "stopping an existing process is always safe" };
    const membership = actionInApprovedPlanScope(action, approvedScope, context.workspaceRoot === undefined ? {} : { workspaceRoot: context.workspaceRoot });
    if (!membership.inScope) return { kind: "deny", reason: membership.reason ?? "operation is outside the approved Plan scope" };
    if (membership.forceAsk) {
      planForceAskReason = membership.reason;
      planScopeForcesAsk = true;
    }
    if (classification !== undefined && (
      classification.destructive || classification.privileged || classification.externalSideEffect ||
      classification.touchesCredentials || classification.network || ["R4", "R5", "R6"].includes(risk)
    )) {
      planForceAskReason ??= "high-risk or externally effectful command requires one-operation approval";
      planScopeForcesAsk = true;
    }
  }
  if (inPlan) {
    // Termination is safe even if trust was revoked or the runtime is already in Plan.
    if (action.toolId === "process.stop") {
      return { kind: "allow", scope: "operation", reason: "stopping an existing process is always safe" };
    }
    if (effectful) {
      // A digest-bound scope authorizes only the subsequent Build turn. It
      // never turns Plan into a write-capable mode, even when a caller passes
      // an otherwise valid approval object directly to policy.
      return { kind: "deny", reason: "Plan mode is read-only; execute the approved Plan in Build mode" };
    }
    if (network || risk !== "R0") return { kind: "deny", reason: `Plan mode allows read-only inspection only (this action is ${risk})` };
    return { kind: "allow", scope: "operation", reason: "read-only inspection in Plan mode" };
  }
  if (effectivePreset === "read" && !(approvedScope !== undefined && !inPlan)) {
    if (potentialMutation || network || action.mcp !== undefined || tool?.source === "mcp") return { kind: "deny", reason: "read preset does not modify the workspace or use network" };
    if (risk !== "R0") return { kind: "deny", reason: `read preset allows read-only inspection only (this action is ${risk})` };
    return { kind: "allow", scope: "operation", reason: "read-only inspection" };
  }
  if (effectivePreset === "yolo" && planForceAskReason === undefined) {
    return { kind: "allow", scope: "operation", reason: "YOLO — hard boundaries already passed" };
  }
  if (effectivePreset === "edit") {
    if (isProcessExecution || network) {
      return { kind: "deny", reason: "Edit mode does not run processes or use network" };
    }
    if (risk !== "R0" && risk !== "R1" && risk !== "R2") {
      return { kind: "deny", reason: `Edit mode denies ${risk} actions` };
    }
    return { kind: "allow", scope: "operation", reason: `Edit mode allows ${risk} file operation` };
  }

  // ---- Stored allow rules (P0-05: after every deny above) ----
  for (const stored of context.rules) {
    if (planScopeForcesAsk) break;
    if (stored.decision !== "allow" || !matchesRule(stored.rule, action)) continue;
    // PERM-003: a rule granted at a lower risk does not cover an escalation.
    if (riskExceeds(risk, stored.grantedForRisk)) {
      break;
    }
    // §13.2: R4–R6 can never have been stored broadly, but double-check.
    if (!allowsBroadRule(risk)) break;
    if (stored.scope === "project" && context.trust !== "trusted-always" && context.trust !== "trusted-once") {
      break;
    }
    return {
      kind: "allow",
      scope: stored.scope === "session" ? "session" : "turn",
      reason: `matched a ${stored.scope} allow rule`,
    };
  }

  // `project_write = "ask"` forces an approval for every mutation path,
  // including a write-capable process, regardless of the permission mode
  // (P0-06). Falling through here lands the action at the ask below.
  const projectWriteForcesAsk =
    (config?.projectWrite ?? "auto") === "ask" && (isWrite || isProcessExecution);

  // ---- Auto and Auto Review ----
  const autoMode = context.mode === "auto" || context.mode === "auto-review";
  const isAutoPreset = effectivePreset === "auto";
  const autoEffective = (autoMode || isAutoPreset) && !projectWriteForcesAsk && planForceAskReason === undefined;
  if (autoEffective) {
    if (risk === "R0" || (risk === "R1" && classification?.executesProjectCode !== true)) {
      const label = isAutoPreset ? "auto" : context.mode;
      return { kind: "allow", scope: "operation", reason: `${risk} action in ${label} mode` };
    }
    if (risk === "R2" && (config?.destructive ?? "ask") !== "deny") {
      return {
        kind: "allow",
        scope: "operation",
        reason: "bounded workspace mutation in Auto mode",
      };
    }
  }

  // ---- Ask mode ----
  if (context.mode === "ask" && !projectWriteForcesAsk && planForceAskReason === undefined) {
    if (risk === "R0") {
      return { kind: "allow", scope: "operation", reason: "read-only action" };
    }
    // §13.1: safe process may be allowed by the classifier in ask mode. A
    // shell-shaped invocation never qualifies, whichever tool carries it.
    if (
      risk === "R1" &&
      config?.shell === "safe-auto" &&
      classification?.readsOnly === true &&
      classification.executesProjectCode === false &&
      !shellLike
    ) {
      return {
        kind: "allow",
        scope: "operation",
        reason: "classified as a safe local command",
      };
    }
  }

  // ---- Everything else asks ----
  // §13.8 / AC-38: `evaluate` decides only allow/ask/deny. How an ask is resolved
  // when nobody can answer it — deny-on-ask, fail-on-ask, allow-listed — belongs
  // to the approval broker, because `fail-on-ask` must abort the run with exit
  // code 4 (§8.9), and a denial decided here would never reach it.
  const ruleCandidate = commandPrefixRule(action);
  const request: ApprovalRequest = {
    approvalId: `ap_${hash}`,
    callId: action.callId,
    action: action.toolId,
    display: action.display,
    ...(action.command ? { cwd: action.command.cwd } : {}),
    riskClass: risk,
    reason: [
      ...reasons,
      ...(planForceAskReason !== undefined && !reasons.includes(planForceAskReason) ? [planForceAskReason] : []),
    ].join("; ") || `${risk} action requires approval`,
    network,
    sideEffects: classification?.sideEffects ?? [],
    offeredScopes: offeredScopes(risk, context, shellLike),
    actionHash: hash,
    ...(ruleCandidate !== undefined ? { ruleCandidate } : {}),
  };

  return { kind: "ask", request };
}

function offeredScopes(
  risk: RiskClass,
  context: PermissionContext,
  shellLike: boolean,
): Array<"once" | "turn" | "session" | "project"> {
  // §13.2: R4–R6 get per-operation approval only.
  if (!allowsBroadRule(risk)) return ["once"];
  // P0-04: a shell script or inline interpreter code is one unparsed program,
  // so no stored rule can honestly describe it. Grants stop at this turn.
  if (shellLike) return ["once", "turn"];
  const scopes: Array<"once" | "turn" | "session" | "project"> = ["once", "turn", "session"];
  // §13.4: `allow_project` requires a trusted project.
  if (context.trust === "trusted-always") scopes.push("project");
  return scopes;
}

function riskExceeds(risk: RiskClass, granted: RiskClass): boolean {
  const order: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];
  return order.indexOf(risk) > order.indexOf(granted);
}

/** Exact, composable rule matching (§13.7). */
export function matchesRule(rule: ApprovalRule, action: ProposedAction): boolean {
  if (rule.tool !== action.toolId && rule.tool !== "*") return false;

  if (rule.program !== undefined) {
    const program = action.command?.program;
    if (program === undefined) return false;
    const base = program.split(/[\\/]/).pop() ?? program;
    if (base !== rule.program && program !== rule.program) return false;
  }

  if (rule.argsExact !== undefined) {
    const args = action.command?.args ?? [];
    if (args.length !== rule.argsExact.length || args.some((arg, index) => arg !== rule.argsExact?.[index])) {
      return false;
    }
  } else if (rule.argsPrefix !== undefined) {
    const args = action.command?.args ?? [];
    if (args.length < rule.argsPrefix.length) return false;
    for (let i = 0; i < rule.argsPrefix.length; i += 1) {
      if (args[i] !== rule.argsPrefix[i]) return false;
    }
  }

  if (rule.cwd !== undefined && action.command?.cwd !== rule.cwd) return false;

  if (rule.paths !== undefined) {
    const paths = [...(action.reads ?? []), ...(action.writes ?? [])];
    if (paths.length === 0) return false;
    const allMatch = paths.every((path) =>
      rule.paths!.some((pattern) => pathRuleMatches(pattern, path)),
    );
    if (!allMatch) return false;
  }

  if (rule.server !== undefined && action.mcp?.server !== rule.server) return false;

  if (rule.network !== undefined) {
    const network = action.command ? classifyCommand(action.command).network : false;
    if (network !== rule.network) return false;
  }

  if (rule.sideEffect !== undefined) {
    const sideEffect = action.mcp !== undefined && action.mcp.sideEffectHint !== "read";
    if (sideEffect !== rule.sideEffect) return false;
  }

  const actionEnv = action.command?.env ?? {};
  if (rule.envHash !== undefined) {
    if (digestCanonical(actionEnv) !== rule.envHash) return false;
  } else if (Object.keys(actionEnv).length > 0) {
    return false;
  }

  if (rule.argumentsHash !== undefined) {
    if (digestCanonical(action.arguments) !== rule.argumentsHash) return false;
  } else if (action.mcp !== undefined && Object.keys(action.arguments).length > 0) {
    return false;
  }

  return true;
}

function capabilityPathMatches(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return normalizedPattern === normalizedPath || globLike(normalizedPattern, normalizedPath);
}

function pathRuleMatches(pattern: string, path: string): boolean {
  // Reuse the scheduler's glob semantics for consistency.
  const normalized = pattern.replace(/^~\//, "");
  if (normalized === path) return true;
  return globLike(normalized, path) || globLike(normalized, path.split("/").pop() ?? path);
}

function globLike(pattern: string, text: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(text);
}

/** Turn a user approval into a stored rule (§13.4). */
export function ruleFromDecision(
  action: ProposedAction,
  decision: ApprovalDecision,
  risk: RiskClass,
): StoredRule | undefined {
  if (decision.kind !== "allow_session" && decision.kind !== "allow_project") return undefined;
  // §13.2: refuse to persist a broad rule for R4–R6.
  if (!allowsBroadRule(risk)) return undefined;
  return {
    rule: decision.rule,
    scope: decision.kind === "allow_session" ? "session" : "project",
    decision: "allow",
    grantedForRisk: risk,
  };
}

/** Build the rule a "always allow this command prefix" choice implies (§7.6). */
export function commandPrefixRule(action: ProposedAction): ApprovalRule | undefined {
  if (!action.command) return undefined;
  // P0-04: a shell script or inline interpreter code is one unparsed program;
  // a prefix rule for it would silently cover every other script.
  if (detectProcessSemantics(action.command) !== "direct-executable") return undefined;
  const rule: ApprovalRule = {
    tool: action.toolId,
    program: action.command.program,
    argsExact: [...action.command.args],
    cwd: action.command.cwd,
    network: classifyCommand(action.command).network,
    envHash: digestCanonical(action.command.env ?? {}),
  };
  return rule;
}

/** §7.6 approval card rendering, shared by the TUI and the plain renderer. */
export function renderApprovalCard(request: ApprovalRequest): string[] {
  const lines: string[] = [];
  const actionLower = request.action.toLowerCase();
  let category = `${request.action} request`;
  if (actionLower.includes("bash") || actionLower.includes("shell") || actionLower.includes("exec") || actionLower.includes("cmd")) {
    category = "Bash command";
  } else if (actionLower.includes("write") || actionLower.includes("edit") || actionLower.includes("create")) {
    category = "File write";
  } else if (actionLower.includes("read")) {
    category = "File read";
  } else if (actionLower.includes("net") || actionLower.includes("fetch")) {
    category = "Network request";
  }

  lines.push("--------------------------------------------------");
  lines.push(`${category}  [${request.riskClass}]`);
  lines.push("");
  lines.push(`  ${request.display}`);
  if (request.reason && request.reason !== request.display) {
    lines.push(`  ${request.reason}`);
  }
  if (request.cwd !== undefined) {
    lines.push(`  CWD: ${request.cwd}`);
  }
  lines.push("");
  lines.push("Do you want to proceed?");

  const options: string[] = ["Allow once"];
  if (request.offeredScopes.includes("turn")) options.push("Allow for this turn");
  if (request.offeredScopes.includes("session")) options.push("Allow for this session");
  if (request.offeredScopes.includes("project")) {
    options.push("Always allow this command prefix in this project");
  }
  options.push("Deny", "Deny and explain");

  options.forEach((option, index) => {
    let label = option;
    if (option === "Allow once") label = "Yes";
    else if (option === "Allow for this turn") label = "Yes, allow for this turn";
    else if (option === "Allow for this session") label = "Yes, allow for this session";
    else if (option.startsWith("Always allow")) label = "Yes, and always allow in this project";
    else if (option === "Deny") label = "No (Deny)";
    else if (option === "Deny and explain") label = "Type here to tell model what to do differently";

    lines.push(`${index === 0 ? "❯" : " "} ${index + 1}. ${label}`);
  });
  lines.push("");
  lines.push("Esc to cancel");
  lines.push("--------------------------------------------------");
  return lines;
}

/** §11.6 / AC-19: the observation the model receives after a denial. */
export function renderDenialObservation(
  action: ProposedAction,
  reason: string,
  userExplanation?: string,
): string {
  const lines = [
    `APPROVAL_DENIED: ${action.toolId} was not executed.`,
    `Reason: ${reason}`,
  ];
  if (userExplanation !== undefined && userExplanation.length > 0) {
    lines.push(`User explanation: ${userExplanation}`);
  }
  lines.push("Choose a different approach that does not require this action.");
  return lines.join("\n");
}
