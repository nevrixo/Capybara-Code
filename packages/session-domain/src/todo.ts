/** Durable Plan Contract/TODO state and its single state-changing controller. */

import { createHash } from "node:crypto";
import type { InteractionMode } from "./mode.ts";

export type TodoStatus = "pending" | "active" | "done" | "blocked" | "skipped";
export type TodoSource = "model" | "user" | "migration" | "host";
export type TodoTransitionSource = TodoSource | "host_recovery";
export type PlanApprovalVia = "shift_tab" | "slash" | "ui";
export type PlanContextStrategy = "keep" | "compact";

export interface PlanFileAnchor {
  readonly path: string;
  readonly symbols?: readonly string[];
  readonly anchors?: readonly string[];
  readonly anchor?: string;
  readonly reason?: string;
  readonly purpose?: string;
}

export interface PlanVerificationCheck {
  readonly id?: string;
  readonly description?: string;
  readonly command?: string;
  readonly expected?: string;
  readonly expectedResult?: string;
  readonly status?: "pending" | "running" | "passed" | "failed" | "not_run";
  readonly evidence?: string;
}

export interface PlanExternalAction {
  readonly server: string;
  readonly tool: string;
  readonly action?: string;
  readonly description?: string;
  readonly reason?: string;
  readonly risk?: string;
  readonly detail?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface PlanDocument {
  readonly goal: string;
  readonly context: readonly string[];
  readonly assumptions?: readonly string[];
  readonly criticalFiles: readonly PlanFileAnchor[];
  readonly verification: readonly PlanVerificationCheck[];
  readonly externalActions?: readonly PlanExternalAction[];
  readonly risks: readonly string[];
  readonly rollback: readonly string[];
}

export interface PlanItem {
  readonly id: string;
  readonly text: string;
  readonly status: TodoStatus;
  readonly kind?: "analysis" | "implementation" | "verification";
  readonly details?: string;
  readonly files?: readonly string[];
  readonly symbols?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly commands?: readonly string[];
  readonly evidence?: readonly string[];
  readonly blockedReason?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Ephemeral host-owned completion-gate marker; never persisted as user scope. */
  readonly hostGenerated?: true;
}

/** Host-owned proof that a completion reflects work observed during this turn. */
export interface TodoHostEvidence {
  readonly turnId?: string;
  readonly workStarted?: boolean;
  readonly changedPaths?: readonly string[];
  readonly delegatedChanges?: readonly string[];
  readonly verificationPassed?: boolean;
  readonly evidenceRefs?: readonly string[];
}

/** Durable trace for a lifecycle mutation, including host-compiled steps. */
export interface TodoTransitionStep {
  readonly revision: number;
  readonly id: string;
  readonly from: TodoStatus | "new";
  readonly to: TodoStatus;
  readonly source: TodoTransitionSource;
  readonly evidenceRefs?: readonly string[];
}

export interface TodoActionIntent {
  readonly toolId: string;
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly display?: string;
  readonly command?: string;
}

export interface TodoMutationInput {
  readonly expectedRevision: number;
  readonly items: readonly PlanItem[];
  readonly reason: string;
  readonly source: TodoSource;
  readonly document?: PlanDocument;
  readonly clearDocument?: boolean;
  readonly hostEvidence?: TodoHostEvidence;
}

export interface TodoMutationPlan {
  readonly baseRevision: number;
  readonly finalRevision: number;
  readonly steps: readonly TodoTransitionStep[];
  readonly finalState: TodoListState;
  readonly recovery: readonly string[];
  readonly input: TodoMutationInput;
}
export interface PlanApproval {
  readonly revision: number;
  /** `plan-sha256-<hex>`; the prefix makes accidental cross-domain use obvious. */
  readonly digest: string;
  readonly approvedAt: string;
  readonly via: PlanApprovalVia;
  readonly contextStrategy: PlanContextStrategy;
}

export interface PlanReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly digest?: string;
}

export interface TodoListState {
  readonly revision: number;
  /** Legacy display-only field; never treated as execution approval. */
  readonly approvedRevision?: number;
  readonly items: readonly PlanItem[];
  readonly updatedAt: string;
  readonly document?: PlanDocument;
  readonly approval?: PlanApproval;
  /** Host-owned marker persisted when a model TODO mutation was rejected. */
  readonly modelMutationError?: string;
}

export type TodoUpdateResult =
  | { readonly ok: true; readonly changed: boolean; readonly state: TodoListState; readonly transitionTrace?: readonly TodoTransitionStep[] }
  | {
      readonly ok: false;
      readonly code:
        | "TODO_REVISION_CONFLICT"
        | "TODO_INVALID_TRANSITION"
        | "TODO_LIMIT_EXCEEDED"
        | "TODO_INVALID_INPUT"
        | "PLAN_NOT_READY"
        | "PLAN_NOT_APPROVED";
      readonly message: string;
      readonly currentRevision: number;
      readonly state: TodoListState;
      readonly blockers?: readonly string[];
    };

export interface TodoControllerOptions {
  readonly mode: () => InteractionMode;
  readonly now?: () => string;
  /** Disable automatic progress-only revision rebasing for rollback/debug. */
  readonly safeRebase?: boolean;
  readonly emit: (
    kind: "plan.created" | "plan.updated" | "plan.approved",
    payload: Record<string, unknown>,
  ) => void;
}

const MAX_ITEMS = 20;
const MAX_DOCUMENT_ARRAY = 128;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const ANSI_OR_CONTROL = /[\u0000-\u001F\u007F\u001B]/gu;
const TODO_STATUSES = new Set<TodoStatus>(["pending", "active", "done", "blocked", "skipped"]);
const TODO_KINDS = new Set<NonNullable<PlanItem["kind"]>>(["analysis", "implementation", "verification"]);

export function emptyTodoState(now = new Date().toISOString()): TodoListState {
  return { revision: 0, items: [], updatedAt: now };
}

export function sanitizeTodoText(value: string, maxLength: number): string {
  return value.replace(ANSI_OR_CONTROL, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function normalizedPlanPath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//u, "");
  if (path.length === 0 || path === "." || path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.startsWith("~")) {
    throw new Error(`Plan path '${raw}' must be workspace-relative`);
  }
  if (path.split("/").some((part) => part === ".." || part.length === 0)) {
    throw new Error(`Plan path '${raw}' may not contain traversal segments`);
  }
  if (/[?*\[\]]/u.test(path)) throw new Error(`Plan path '${raw}' may not contain wildcards`);
  return path;
}

function normalizeStringArray(value: readonly string[] | undefined, max = MAX_DOCUMENT_ARRAY): string[] {
  if (value === undefined) return [];
  if (value.length > max) throw new Error(`Plan array supports at most ${max} entries`);
  return value.map((entry) => sanitizeTodoText(entry, 500)).filter((entry) => entry.length > 0);
}

export function normalizePlanDocument(document: PlanDocument | undefined): PlanDocument | undefined {
  if (document === undefined) return undefined;
  if (typeof document !== "object" || document === null) throw new Error("Plan document must be an object");
  const goal = sanitizeTodoText(document.goal, 1_000);
  if (goal.length === 0) throw new Error("Plan goal is required");
  const context = normalizeStringArray(document.context, MAX_DOCUMENT_ARRAY);
  if (context.length === 0) throw new Error("Plan context is required");
  if (!Array.isArray(document.criticalFiles) || document.criticalFiles.length === 0) throw new Error("Plan criticalFiles is required");
  if (!Array.isArray(document.verification) || document.verification.length === 0) throw new Error("Plan verification is required");
  if (!Array.isArray(document.risks) || !Array.isArray(document.rollback)) throw new Error("Plan risks and rollback must be arrays");
  const criticalFiles = document.criticalFiles.map((anchor) => {
    if (typeof anchor !== "object" || anchor === null || typeof anchor.path !== "string") throw new Error("Plan critical file anchor is invalid");
    const path = normalizedPlanPath(anchor.path);
    const symbols = normalizeStringArray(anchor.symbols, 32);
    const anchors = normalizeStringArray(anchor.anchors, 32);
    const anchorName = anchor.anchor === undefined ? undefined : sanitizeTodoText(anchor.anchor, 240);
    const reason = anchor.reason === undefined ? undefined : sanitizeTodoText(anchor.reason, 500);
    const purpose = anchor.purpose === undefined ? undefined : sanitizeTodoText(anchor.purpose, 500);
    return {
      path,
      ...(symbols.length > 0 ? { symbols } : {}),
      ...(anchors.length > 0 ? { anchors } : {}),
      ...(anchorName ? { anchor: anchorName } : {}),
      ...(reason ? { reason } : {}),
      ...(purpose ? { purpose } : {}),
    };
  });
  const verification = document.verification.map((check) => {
    if (typeof check !== "object" || check === null) throw new Error("Plan verification check is invalid");
    const id = typeof check.id === "string" ? sanitizeTodoText(check.id, 64) : undefined;
    const description = typeof check.description === "string" ? sanitizeTodoText(check.description, 500) : undefined;
    const command = typeof check.command === "string" ? sanitizeTodoText(check.command, 1_000) : undefined;
    const expected = typeof check.expected === "string" ? sanitizeTodoText(check.expected, 1_000) : undefined;
    const expectedResult = typeof check.expectedResult === "string" ? sanitizeTodoText(check.expectedResult, 1_000) : undefined;
    const evidence = typeof check.evidence === "string" ? sanitizeTodoText(check.evidence, 1_000) : undefined;
    const status = ["pending", "running", "passed", "failed", "not_run"].includes(String(check.status)) ? check.status as PlanVerificationCheck["status"] : undefined;
    return { ...(id ? { id } : {}), ...(description ? { description } : {}), ...(command ? { command } : {}), ...(expected ? { expected } : {}), ...(expectedResult ? { expectedResult } : {}), ...(status === undefined ? {} : { status }), ...(evidence ? { evidence } : {}) };
  });
  const externalActions = (document.externalActions ?? []).map((action) => {
    if (typeof action !== "object" || action === null || typeof action.server !== "string" || typeof action.tool !== "string") throw new Error("Plan external action is invalid");
    const server = sanitizeTodoText(action.server, 128);
    const tool = sanitizeTodoText(action.tool, 256);
    if (!server || !tool) throw new Error("Plan external action requires server and tool");
    const actionName = action.action === undefined ? undefined : sanitizeTodoText(action.action, 256);
    const description = action.description === undefined ? undefined : sanitizeTodoText(action.description, 500);
    const reason = action.reason === undefined ? undefined : sanitizeTodoText(action.reason, 500);
    const risk = action.risk === undefined ? undefined : sanitizeTodoText(action.risk, 120);
    const detail = action.detail === undefined ? undefined : sanitizeTodoText(action.detail, 500);
    const args = action.arguments === undefined ? undefined : structuredClone(action.arguments);
    return { server, tool, ...(actionName ? { action: actionName } : {}), ...(description ? { description } : {}), ...(reason ? { reason } : {}), ...(risk ? { risk } : {}), ...(detail ? { detail } : {}), ...(args === undefined ? {} : { arguments: args }) };
  });
  return {
    goal,
    context,
    ...(document.assumptions === undefined ? {} : { assumptions: normalizeStringArray(document.assumptions) }),
    criticalFiles,
    verification,
    ...(externalActions.length > 0 ? { externalActions } : {}),
    risks: normalizeStringArray(document.risks),
    rollback: normalizeStringArray(document.rollback),
  };
}

export function normalizeTodoItems(items: readonly PlanItem[], now = new Date().toISOString()): PlanItem[] {
  if (items.length > MAX_ITEMS) throw new Error(`TODO supports at most ${MAX_ITEMS} items`);
  const ids = new Set<string>();
  let active = 0;
  return items.map((raw) => {
    if (!ID_PATTERN.test(raw.id) || ids.has(raw.id)) throw new Error(`invalid or duplicate TODO id '${raw.id}'`);
    ids.add(raw.id);
    const text = sanitizeTodoText(raw.text, 240);
    if (text.length === 0) throw new Error(`TODO '${raw.id}' has empty text`);
    if (!TODO_STATUSES.has(raw.status)) throw new Error(`TODO '${raw.id}' has invalid status`);
    if (raw.kind !== undefined && !TODO_KINDS.has(raw.kind)) throw new Error(`TODO '${raw.id}' has invalid kind`);
    if (raw.createdAt !== undefined && typeof raw.createdAt !== "string") throw new Error(`TODO '${raw.id}' has invalid createdAt`);
    if (raw.updatedAt !== undefined && typeof raw.updatedAt !== "string") throw new Error(`TODO '${raw.id}' has invalid updatedAt`);
    if (raw.status === "active") active += 1;
    if (raw.status === "blocked" && sanitizeTodoText(raw.blockedReason ?? "", 300).length === 0) throw new Error(`blocked TODO '${raw.id}' requires blockedReason`);
    const evidence = normalizeStringArray(raw.evidence, 12).map((entry) => entry.slice(0, 240));
    if (raw.status === "done" && (raw.kind === "implementation" || raw.kind === "verification") && evidence.length === 0) throw new Error(`completed TODO '${raw.id}' requires evidence`);
    const files = raw.files?.map(normalizedPlanPath);
    const symbols = normalizeStringArray(raw.symbols, 32);
    const acceptanceCriteria = normalizeStringArray(raw.acceptanceCriteria, 32);
    const dependsOn = normalizeStringArray(raw.dependsOn, 20);
    const commands = normalizeStringArray(raw.commands, 20).map((entry) => entry.slice(0, 1_000));
    return {
      id: raw.id,
      text,
      status: raw.status,
      ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
      ...(raw.details ? { details: sanitizeTodoText(raw.details, 1_000) } : {}),
      ...(files !== undefined && files.length > 0 ? { files } : {}),
      ...(symbols.length > 0 ? { symbols } : {}),
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(commands.length > 0 ? { commands } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(raw.blockedReason !== undefined ? { blockedReason: sanitizeTodoText(raw.blockedReason, 300) } : {}),
      createdAt: raw.createdAt ?? now,
      updatedAt: now,
    };
  });
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return String(value);
}

/** Digest only the approved execution scope; progress/evidence/timestamps are excluded. */
export function planDigest(document: PlanDocument | undefined, items: readonly PlanItem[]): string | undefined {
  if (document === undefined) return undefined;
  const scopeItems = items.map((item) => ({
    id: item.id,
    text: item.text,
    ...(item.kind === undefined ? {} : { kind: item.kind }),
    ...(item.details === undefined ? {} : { details: item.details }),
    ...(item.files === undefined ? {} : { files: [...item.files] }),
    ...(item.symbols === undefined ? {} : { symbols: [...item.symbols] }),
    ...(item.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: [...item.acceptanceCriteria] }),
    ...(item.dependsOn === undefined ? {} : { dependsOn: [...item.dependsOn] }),
    ...(item.commands === undefined ? {} : { commands: [...item.commands] }),
  }));
  const scopeDocument = {
    ...document,
    // Verification status/evidence are runtime progress, not execution scope.
    verification: document.verification.map(({ status: _status, evidence: _evidence, ...check }) => check),
  };
  const payload = canonicalize({ document: scopeDocument, items: scopeItems });
  const hex = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return `plan-sha256-${hex}`;
}

function sameScope(documentA: PlanDocument | undefined, itemsA: readonly PlanItem[], documentB: PlanDocument | undefined, itemsB: readonly PlanItem[]): boolean {
  return planDigest(documentA, itemsA) === planDigest(documentB, itemsB);
}

function pathWithinAnchor(path: string, anchor: string): boolean {
  const a = normalizedPlanPath(anchor).replace(/\/$/u, "");
  const p = normalizedPlanPath(path).replace(/\/$/u, "");
  return p === a || p.startsWith(`${a}/`);
}

export function assessPlanReadiness(document: PlanDocument | undefined, items: readonly PlanItem[]): PlanReadiness {
  const blockers: string[] = [];
  if (document === undefined) blockers.push("structured Plan document is missing");
  if (document !== undefined) {
    if (document.context.length === 0) blockers.push("Context is required");
    if (document.criticalFiles.length === 0) blockers.push("Critical files are required");
    if (document.verification.length === 0) blockers.push("Verification is required");
    if (document.goal.trim().length === 0) blockers.push("Goal is required");
    for (const check of document.verification) if ((check.command ?? check.expected ?? check.expectedResult ?? "").trim().length === 0) blockers.push(`verification '${check.id ?? check.description ?? "check"}' needs command or expected result`);
  }
  if (items.length === 0) blockers.push("Approach must contain at least one step");
  const implementations = items.filter((item) => item.kind === "implementation");
  const verifications = items.filter((item) => item.kind === "verification");
  if (implementations.length === 0) blockers.push("an implementation step is required");
  if (verifications.length === 0) blockers.push("a verification step is required");
  if (items.some((item) => item.status === "blocked")) blockers.push("blocked steps must be resolved");
  if (items.some((item) => item.kind === "analysis" && !["done", "skipped"].includes(item.status))) blockers.push("analysis steps must be done or skipped");
  for (const item of implementations) {
    if ((item.files?.length ?? 0) === 0) blockers.push(`implementation step '${item.id}' needs file anchors`);
    if ((item.acceptanceCriteria?.length ?? 0) === 0) blockers.push(`implementation step '${item.id}' needs acceptance criteria`);
    if (document !== undefined) {
      for (const path of item.files ?? []) {
        if (!document.criticalFiles.some((anchor) => pathWithinAnchor(path, anchor.path))) blockers.push(`implementation file '${path}' is outside Critical Files`);
      }
    }
  }
  const digest = document === undefined ? undefined : planDigest(document, items);
  return digest === undefined ? { ready: blockers.length === 0, blockers } : { ready: blockers.length === 0, blockers, digest };
}

function sameItems(left: readonly PlanItem[], right: readonly PlanItem[]): boolean {
  const semantic = (items: readonly PlanItem[]) => items.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...item }) => item);
  return JSON.stringify(semantic(left)) === JSON.stringify(semantic(right));
}

function todoScope(item: PlanItem): unknown {
  return {
    id: item.id,
    text: item.text,
    kind: item.kind ?? null,
    details: item.details ?? null,
    files: item.files ?? [],
    symbols: item.symbols ?? [],
    acceptanceCriteria: item.acceptanceCriteria ?? [],
    dependsOn: item.dependsOn ?? [],
    commands: item.commands ?? [],
  };
}

/**
 * todo.write replaces the whole list, but its rich scope fields are optional
 * in the tool schema. After compaction a progress update may legitimately
 * omit them. Preserve only omitted fields from the authoritative item; an
 * explicitly different value still goes through the normal reopen checks.
 */
function mergeOmittedModelFields(previous: PlanItem | undefined, next: PlanItem): PlanItem {
  if (previous === undefined) return next;
  return {
    ...next,
    ...(next.kind === undefined && previous.kind !== undefined ? { kind: previous.kind } : {}),
    ...(next.details === undefined && previous.details !== undefined ? { details: previous.details } : {}),
    ...(next.files === undefined && previous.files !== undefined ? { files: previous.files } : {}),
    ...(next.symbols === undefined && previous.symbols !== undefined ? { symbols: previous.symbols } : {}),
    ...(next.acceptanceCriteria === undefined && previous.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: previous.acceptanceCriteria }
      : {}),
    ...(next.dependsOn === undefined && previous.dependsOn !== undefined ? { dependsOn: previous.dependsOn } : {}),
    ...(next.commands === undefined && previous.commands !== undefined ? { commands: previous.commands } : {}),
    ...(next.evidence === undefined && previous.evidence !== undefined ? { evidence: previous.evidence } : {}),
    ...(next.status === "blocked" && next.blockedReason === undefined && previous.blockedReason !== undefined
      ? { blockedReason: previous.blockedReason }
      : {}),
    ...(previous.createdAt === undefined ? {} : { createdAt: previous.createdAt }),
  };
}

function safeNormalizedPath(raw: string): string | undefined {
  try { return normalizedPlanPath(raw); } catch { return undefined; }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = safeNormalizedPath(left);
  const b = safeNormalizedPath(right);
  if (a === undefined || b === undefined) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function hostEvidenceSupportsCompletion(
  previous: PlanItem,
  next: PlanItem,
  evidence: TodoHostEvidence | undefined,
): boolean {
  if (evidence === undefined || evidence.workStarted !== true) return false;
  if (previous.status !== "pending" || next.status !== "done") return false;
  if (next.kind === "implementation") {
    const observedPaths = [
      ...(evidence.changedPaths ?? []),
      ...(evidence.delegatedChanges ?? []),
    ];
    const scoped = (next.files ?? []).some((file) => observedPaths.some((path) => pathsOverlap(file, path)));
    // Delegation is host evidence, not a blanket completion grant: the
    // delegated paths must still overlap the implementation item scope.
    return scoped || (next.files === undefined && observedPaths.length > 0);
  }
  if (next.kind === "verification") return evidence.verificationPassed === true;
  return false;
}

function dependenciesSatisfied(item: PlanItem, items: readonly PlanItem[]): boolean {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  return (item.dependsOn ?? []).every((dependency) => {
    const dependencyItem = byId.get(dependency);
    return dependencyItem !== undefined && (dependencyItem.status === "done" || dependencyItem.status === "skipped");
  });
}

function actionMatchesTodo(item: PlanItem, action: TodoActionIntent): boolean {
  const actionPaths = [...(action.reads ?? []), ...(action.writes ?? [])];
  const pathMatch = (item.files ?? []).some((file) => actionPaths.some((path) => pathsOverlap(file, path)));
  const actionText = `${action.command ?? ""} ${action.display ?? ""}`.trim();
  const commandMatch = actionText.length > 0 && (item.commands ?? []).some((command) =>
    actionText === command || actionText.includes(command) || command.includes(actionText),
  );
  return pathMatch || commandMatch;
}

function isWorkAction(action: TodoActionIntent): boolean {
  return (action.writes?.length ?? 0) > 0 ||
    action.toolId === "process.run" ||
    action.toolId === "shell.run" ||
    action.toolId === "process.start" ||
    action.toolId === "verification.run_many";
}

function transitionTraceFor(
  previous: readonly PlanItem[],
  next: readonly PlanItem[],
  revision: number,
  source: TodoTransitionSource,
): TodoTransitionStep[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return next.flatMap((item) => {
    const before = previousById.get(item.id);
    if (before === undefined || before.status === item.status) return [];
    return [{ revision, id: item.id, from: before.status, to: item.status, source }];
  });
}

/**
 * Planning often discovers an analysis result before the first durable TODO
 * write. Unlike implementation work, that observation has already happened
 * in the read-only turn, so it can be recorded atomically when it carries
 * concrete evidence. A later write may add observations to an already-done
 * analysis item without reopening it. Keep this deliberately narrow: an
 * implementation item can never use this shortcut to claim work was performed.
 */
function isEvidenceBackedAnalysisCompletion(
  previous: PlanItem | undefined,
  next: PlanItem,
): boolean {
  if (next.kind !== "analysis" || next.status !== "done") return false;
  if (previous === undefined) {
    return next.evidence?.some((entry) => entry.trim().length > 0) ?? false;
  }
  if (previous.kind !== "analysis") return false;
  // An already-completed analysis may record additional observations without
  // reopening. First-time completion still needs concrete evidence.
  if (previous.status === "done") return true;
  if (previous.status !== "pending" && previous.status !== "active") return false;
  return next.evidence?.some((entry) => entry.trim().length > 0) ?? false;
}

function scopesEqual(left: PlanItem, right: PlanItem): boolean {
  return JSON.stringify(todoScope(left)) === JSON.stringify(todoScope(right));
}

/** Explain an invalid model transition in terms the next todo.write can repair. */
export function todoTransitionError(previous: PlanItem | undefined, next: PlanItem): string | undefined {
  // Evidence is model-controlled metadata; it cannot prove that a brand-new
  // implementation was actually performed. A TODO must pass through an
  // observable non-terminal state before it can earn completion.
  if (previous === undefined) {
    if (next.status !== "done" || isEvidenceBackedAnalysisCompletion(previous, next)) return undefined;
    return `TODO '${next.id}' cannot be created as done; create it as pending or active first`;
  }
  const scopeChanged = JSON.stringify(todoScope(previous)) !== JSON.stringify(todoScope(next));
  // A completed/terminal item may receive additional evidence, but changing the
  // work itself must first reopen through a non-terminal state. Otherwise a model
  // can detour through `blocked`/`skipped` and still claim the new scope done.
  if (scopeChanged && next.status !== "pending" && next.status !== "active" && !isEvidenceBackedAnalysisCompletion(previous, next)) {
    return `TODO '${next.id}' changes its scope while ${next.status}; preserve its existing text and scope for this update, or reopen it as pending or active before changing scope`;
  }
  if (next.status === "done") {
    // Completion is earned only from observable active work. A pending, blocked,
    // skipped, or unknown implementation item cannot jump directly to done on
    // model evidence. Read-only analysis is the exception above: it may have
    // completed before its first TODO write, but must carry evidence.
    if (
      previous.status === "active" ||
      isEvidenceBackedAnalysisCompletion(previous, next) ||
      (previous.status === "done" && !scopeChanged)
    ) return undefined;
    if (previous.status === "pending") {
      return `TODO '${next.id}' cannot move from pending to done; first submit a separate todo.write that marks this item active, then complete it in a later update`;
    }
    if (previous.status === "blocked") {
      return `TODO '${next.id}' cannot move from blocked to done; first reopen it as active, then complete it in a later update`;
    }
    if (previous.status === "skipped") {
      return `TODO '${next.id}' cannot move from skipped to done; first reopen it as pending, then active, before completing it`;
    }
    return `TODO '${next.id}' cannot move from ${previous.status} to done without an explicit active completion step`;
  }
  if ((previous.status === "done" || previous.status === "skipped") && next.status === "active") {
    return `TODO '${next.id}' cannot move directly from ${previous.status} to active; reopen it as pending first`;
  }
  return undefined;
}

export function todoTransitionAllowed(previous: PlanItem | undefined, next: PlanItem): boolean {
  return todoTransitionError(previous, next) === undefined;
}

/** Plan mode drafts execution work; it may not turn a future step into a blocker. */
function planModeDraftTransitionError(previous: PlanItem | undefined, next: PlanItem): string | undefined {
  if (next.kind === "analysis") return undefined;
  if (previous === undefined) {
    if (next.status === "pending") return undefined;
    return `Plan mode cannot create execution TODO '${next.id}' as ${next.status}; create it as pending and wait for Build mode to execute it`;
  }
  if (next.status === previous.status || next.status === "pending") return undefined;
  return `Plan mode cannot move execution TODO '${next.id}' from ${previous.status} to ${next.status}; preserve its status or reset it to pending until Build mode runs it`;
}

export class TodoController {
  #state: TodoListState;
  /** A rejected model mutation is unresolved work, even when no valid TODO exists yet. */
  #lastModelMutationError: string | undefined;
  readonly #options: TodoControllerOptions;
  constructor(options: TodoControllerOptions, initial = emptyTodoState(options.now?.() ?? new Date().toISOString())) {
    this.#options = options;
    this.#state = sanitizeHydratedTodoState(initial, options.now?.() ?? new Date().toISOString());
    this.#lastModelMutationError = this.#state.modelMutationError;
  }
  current(): TodoListState { return structuredClone(this.#state); }
  /**
   * Completion-gate projection. A rejected model update cannot be treated as if
   * there were no TODOs (notably on the first revision), so expose a host-owned
   * blocked sentinel until a valid model update or explicit user repair occurs.
   */
  completionItems(): readonly PlanItem[] {
    const items = this.#state.items.map((item) => ({ ...item }));
    if (this.#lastModelMutationError === undefined) return items;
    return [
      ...items,
      {
        id: "todo-controller-error",
        text: "Repair the rejected TODO update before reporting completion",
        status: "blocked",
        kind: "analysis",
        blockedReason: this.#lastModelMutationError,
        createdAt: this.#state.updatedAt,
        updatedAt: this.#state.updatedAt,
        hostGenerated: true,
      },
    ];
  }
  readiness(): PlanReadiness { return assessPlanReadiness(this.#state.document, this.#state.items); }
  digest(): string | undefined { return planDigest(this.#state.document, this.#state.items); }
  hydrate(state: TodoListState): void {
    this.#state = sanitizeHydratedTodoState(state, this.#options.now?.() ?? new Date().toISOString());
    this.#lastModelMutationError = this.#state.modelMutationError;
  }

  /**
   * Build-mode fast path: record the one actionable pending item before a
   * workspace/process action starts. Ambiguous plans stay untouched.
   */
  autoActivateForAction(action: TodoActionIntent): TodoUpdateResult {
    if (this.#options.mode() !== "build" || !isWorkAction(action)) {
      return { ok: true, changed: false, state: this.current() };
    }
    if (this.#state.items.some((item) => item.status === "active")) {
      return { ok: true, changed: false, state: this.current() };
    }
    const candidates = this.#state.items.filter((item) => item.status === "pending" && dependenciesSatisfied(item, this.#state.items));
    const matches = candidates.filter((item) => actionMatchesTodo(item, action));
    const target = matches.length === 1 ? matches[0] : matches.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
    if (target === undefined) return { ok: true, changed: false, state: this.current() };
    const items = this.#state.items.map((item) => item.id === target.id ? { ...item, status: "active" as const } : item);
    return this.replace({
      expectedRevision: this.#state.revision,
      reason: `host recovery: started TODO '${target.id}' before ${action.toolId}`,
      source: "host",
      items,
    });
  }

  /** Compute a durable mutation without changing this controller. */
  planMutation(input: TodoMutationInput): TodoMutationPlan | TodoUpdateResult {
    const shadow = new TodoController({ ...this.#options, emit: () => undefined }, this.current());
    const result = shadow.replace(input);
    if (!result.ok) return result;
    return {
      baseRevision: this.#state.revision,
      finalRevision: result.state.revision,
      steps: result.transitionTrace ?? [],
      finalState: result.state,
      recovery: result.transitionTrace?.some((step) => step.source === "host_recovery") ? ["lifecycle_compiled"] : [],
      input,
    };
  }

  /** Commit a plan only if its CAS base is still the current revision. */
  commitMutation(plan: TodoMutationPlan): TodoUpdateResult {
    if (plan.baseRevision !== this.#state.revision) {
      return this.conflict(`planned revision ${plan.baseRevision} is stale; current revision is ${this.#state.revision}`, plan.input.source);
    }
    return this.replace({ ...plan.input, expectedRevision: plan.baseRevision });
  }
  replace(input: TodoMutationInput): TodoUpdateResult {
    const currentRevision = this.#state.revision;
    const staleRevision = input.expectedRevision !== currentRevision;
    if (input.expectedRevision > currentRevision || (staleRevision && input.source !== "model")) {
      return this.conflict(`expected revision ${input.expectedRevision}, current revision is ${currentRevision}`, input.source);
    }
    const reason = sanitizeTodoText(input.reason, 300);
    if (!reason) return this.invalid("TODO reason is required", "TODO_INVALID_INPUT", input.source);
    if (input.source === "model" && this.#state.items.some((item) => item.id === "todo-hydration-error")) {
      return this.invalid("persisted TODO state is corrupt; a user must repair it before model updates", "TODO_INVALID_TRANSITION", input.source);
    }
    const previousItems = this.#state.items;
    const previousById = new Map(previousItems.map((item) => [item.id, item]));
    const requestedItems = input.source === "model"
      ? input.items.map((item) => mergeOmittedModelFields(previousById.get(item.id), item))
      : input.items;
    let items: PlanItem[];
    let document: PlanDocument | undefined;
    try {
      items = normalizeTodoItems(requestedItems, this.#options.now?.() ?? new Date().toISOString());
      document = input.clearDocument === true
        ? undefined
        : normalizePlanDocument(input.document ?? this.#state.document);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.invalid(message, message.includes("at most") ? "TODO_LIMIT_EXCEEDED" : "TODO_INVALID_INPUT", input.source);
    }

    // A stale model revision may be rebased exactly once when the requested
    // change preserves every item's approved scope. Status/evidence progress is
    // safe to merge; additions, removals, or any scope change are not.
    const safeRebase = this.#options.safeRebase !== false && staleRevision && input.source === "model" &&
      items.length === previousItems.length &&
      sameScope(document, items, this.#state.document, previousItems) &&
      items.every((item) => {
        const previous = previousById.get(item.id);
        return previous !== undefined &&
          JSON.stringify(todoScope(previous)) === JSON.stringify(todoScope(item)) &&
          !(previous.status === "active" && item.status === "pending") &&
          !(previous.status === "done" && item.status !== "done") &&
          !(previous.status === "skipped" && item.status !== "skipped");
      });
    if (staleRevision && !safeRebase) {
      return this.conflict(`expected revision ${input.expectedRevision}, current revision is ${currentRevision}`, input.source);
    }

    // A structured document is a user-reviewable execution contract, not a
    // richer spelling of an ordinary Build TODO. If a Build-mode model could
    // introduce one, the next mutation would correctly be denied by the digest-
    // bound policy, but the user would be stranded in a contract they never chose.
    if (
      input.source === "model" &&
      input.document !== undefined &&
      this.#options.mode() !== "plan" &&
      !sameScope(document, items, this.#state.document, previousItems)
    ) {
      return this.invalid(
        "structured Plan Contracts can only be drafted in Plan mode; use ordinary TODO items in Build mode or explicitly enter Plan mode first",
        "TODO_INVALID_TRANSITION",
        input.source,
      );
    }
    if (items.filter((item) => item.status === "active").length > 1) {
      return this.invalid("only one root TODO may be active", "TODO_INVALID_TRANSITION", input.source);
    }
    if (input.source === "model") {
      const nextIds = new Set(items.map((item) => item.id));
      const removedUnfinished = previousItems.filter((item) => item.status !== "done" && !nextIds.has(item.id));
      if (removedUnfinished.length > 0) {
        return this.invalid(`model TODO update cannot remove unfinished item(s): ${removedUnfinished.map((item) => item.id).join(", ")}`, "TODO_INVALID_TRANSITION", input.source);
      }
    }
    if (input.source === "model" && this.#options.mode() === "plan" && document !== undefined) {
      const planModeError = items
        .map((item) => planModeDraftTransitionError(previousById.get(item.id), item))
        .find((message): message is string => message !== undefined);
      if (planModeError !== undefined) return this.invalid(planModeError, "TODO_INVALID_TRANSITION", input.source);
    }

    // Compile the narrow pending -> active -> done gap only when the host can
    // prove that this turn actually changed the item's scope (or passed its
    // verification). The model still supplies the final evidence and status.
    // A completed-item rescope is the inverse: reopen through pending in this
    // same write so the model does not have to issue a second todo.write.
    const compiledIds = new Set<string>();
    const reopenedIds = new Set<string>();
    if (input.source === "model") {
      items = items.map((item) => {
        const previous = previousById.get(item.id);
        if (previous === undefined) return item;
        if (
          previous.status === "pending" &&
          item.status === "done" &&
          hostEvidenceSupportsCompletion(previous, item, input.hostEvidence)
        ) {
          compiledIds.add(item.id);
          return item;
        }
        if (
          (previous.status === "done" || previous.status === "skipped" || previous.status === "blocked") &&
          item.status !== "pending" &&
          item.status !== "active" &&
          !scopesEqual(previous, item) &&
          !isEvidenceBackedAnalysisCompletion(previous, item)
        ) {
          reopenedIds.add(item.id);
          const { blockedReason: _blockedReason, ...rest } = item;
          return { ...rest, status: "pending" };
        }
        return item;
      });
    }
    if (compiledIds.size > 0 && previousItems.some((item) => item.status === "active" && !compiledIds.has(item.id))) {
      return this.invalid("host completion compiler cannot activate a second root TODO while another item is active", "TODO_INVALID_TRANSITION", input.source);
    }
    const transitionError = items
      .map((item) => {
        const previous = previousById.get(item.id);
        const compilerPrevious = compiledIds.has(item.id) && previous !== undefined
          ? { ...previous, status: "active" as const }
          : previous;
        return todoTransitionError(compilerPrevious, item);
      })
      .find((message): message is string => message !== undefined);
    if (transitionError !== undefined) return this.invalid(transitionError, "TODO_INVALID_TRANSITION", input.source);

    const previousRevision = this.#state.revision;
    const sameScopeAsCurrent = sameItems(items, previousItems) && sameScope(document, items, this.#state.document, previousItems);
    if (this.#state.modelMutationError !== undefined && input.source === "model" && sameScopeAsCurrent) {
      return this.invalid("an explicit user repair is required after a rejected TODO update", "TODO_INVALID_TRANSITION", input.source);
    }
    if (sameScopeAsCurrent) {
      const repairedMutationError = this.#state.modelMutationError;
      this.#lastModelMutationError = undefined;
      if (repairedMutationError !== undefined) {
        const { modelMutationError: _modelMutationError, ...withoutMutationError } = this.#state;
        this.#state = withoutMutationError;
        // Even a semantic no-op repair must be durable; otherwise the reducer
        // snapshot can retain the rejected marker across a restart.
        this.#options.emit(previousRevision === 0 ? "plan.created" : "plan.updated", {
          revision: this.#state.revision,
          previousRevision: this.#state.revision,
          source: input.source,
          reason,
          mode: this.#options.mode(),
          items: this.#state.items,
          ...(this.#state.document === undefined ? {} : { document: this.#state.document }),
          ...(this.#state.approvedRevision === undefined ? {} : { approvedRevision: this.#state.approvedRevision }),
          ...(this.#state.approval === undefined ? {} : { approval: this.#state.approval }),
          ...(this.digest() === undefined ? {} : { digest: this.digest() }),
        });
      }
      return { ok: true, changed: repairedMutationError !== undefined, state: this.current() };
    }

    this.#lastModelMutationError = undefined;
    const preserveApproval = this.#state.approval !== undefined && sameScope(document, items, this.#state.document, previousItems);
    const compiledLifecycle = compiledIds.size > 0 || reopenedIds.size > 0;
    const finalRevision = previousRevision + (compiledIds.size > 0 ? 2 : 1);
    const modelSource: TodoTransitionSource = input.source === "host" ? "host_recovery" : input.source;
    const transitionTrace: TodoTransitionStep[] = compiledLifecycle
      ? items.flatMap((item) => {
          const previous = previousById.get(item.id);
          if (compiledIds.has(item.id)) {
            return [
              { revision: previousRevision + 1, id: item.id, from: "pending" as const, to: "active" as const, source: "host_recovery" as const },
              {
                revision: finalRevision,
                id: item.id,
                from: "active" as const,
                to: "done" as const,
                source: "model" as const,
                ...(input.hostEvidence?.evidenceRefs === undefined ? {} : { evidenceRefs: [...input.hostEvidence.evidenceRefs] }),
              },
            ];
          }
          if (previous === undefined || previous.status === item.status) return [];
          return [{
            revision: finalRevision,
            id: item.id,
            from: previous.status,
            to: item.status,
            source: reopenedIds.has(item.id) ? "host_recovery" as const : modelSource,
          }];
        })
      : transitionTraceFor(previousItems, items, finalRevision, modelSource);
    this.#state = {
      revision: finalRevision,
      ...(preserveApproval && this.#state.approval !== undefined ? { approval: this.#state.approval } : {}),
      ...(preserveApproval && this.#state.approvedRevision !== undefined ? { approvedRevision: this.#state.approvedRevision } : {}),
      items,
      updatedAt: this.#options.now?.() ?? new Date().toISOString(),
      ...(document === undefined ? {} : { document }),
    };
    this.#options.emit(previousRevision === 0 ? "plan.created" : "plan.updated", {
      revision: this.#state.revision,
      previousRevision,
      source: input.source,
      reason,
      mode: this.#options.mode(),
      items: this.#state.items,
      ...(document === undefined ? {} : { document }),
      ...(this.#state.approvedRevision === undefined ? {} : { approvedRevision: this.#state.approvedRevision }),
      ...(this.#state.approval === undefined ? {} : { approval: this.#state.approval }),
      ...(this.digest() === undefined ? {} : { digest: this.digest() }),
      ...(transitionTrace.length === 0 ? {} : { transitionTrace }),
      ...((safeRebase || compiledLifecycle) ? { recovery: [...(safeRebase ? ["safe_rebase"] : []), ...(compiledLifecycle ? ["lifecycle_compiled"] : [])] } : {}),
    });
    return { ok: true, changed: true, state: this.current(), ...(transitionTrace.length === 0 ? {} : { transitionTrace }) };
  }  clear(input: { readonly expectedRevision: number; readonly reason: string; readonly source: "user" | "model" }): TodoUpdateResult { return this.replace({ ...input, items: [], clearDocument: true }); }
  approve(revision: number, via: PlanApprovalVia, contextStrategy: PlanContextStrategy = "keep"): TodoUpdateResult {
    if (revision !== this.#state.revision) return this.conflict(`expected revision ${revision}, current revision is ${this.#state.revision}`);
    if (!(via === "shift_tab" || via === "slash" || via === "ui")) return this.invalid("Plan approval source is invalid", "TODO_INVALID_INPUT");
    if (!(contextStrategy === "keep" || contextStrategy === "compact")) return this.invalid("Plan context strategy is invalid", "TODO_INVALID_INPUT");
    const readiness = this.readiness();
    if (!readiness.ready || readiness.digest === undefined) return this.invalidWithBlockers(`Plan is not ready for approval: ${readiness.blockers.join("; ")}`, "PLAN_NOT_READY", readiness.blockers);
    const approval: PlanApproval = { revision, digest: readiness.digest, approvedAt: this.#options.now?.() ?? new Date().toISOString(), via, contextStrategy };
    this.#state = { ...this.#state, approval, approvedRevision: revision, updatedAt: this.#options.now?.() ?? new Date().toISOString() };
    this.#options.emit("plan.approved", { revision, digest: approval.digest, approvedAt: approval.approvedAt, via, contextStrategy, approval });
    return { ok: true, changed: true, state: this.current() };
  }
  approvalValid(): boolean {
    const approval = this.#state.approval;
    const digest = this.digest();
    return approval !== undefined && digest !== undefined && typeof approval.digest === "string" && approval.digest === digest && Number.isSafeInteger(approval.revision) && approval.revision >= 0 && approval.revision <= this.#state.revision;
  }
  private conflict(message: string, source?: TodoSource): TodoUpdateResult {
    this.rememberModelFailure(source, message);
    return { ok: false, code: "TODO_REVISION_CONFLICT", message, currentRevision: this.#state.revision, state: this.current() };
  }
  private invalid(message: string, code: Exclude<TodoUpdateResult & { ok: false }, never>["code"], source?: TodoSource): TodoUpdateResult {
    this.rememberModelFailure(source, message);
    return { ok: false, code: code as any, message, currentRevision: this.#state.revision, state: this.current() };
  }
  private rememberModelFailure(source: TodoSource | undefined, message: string): void {
    if (source !== "model") return;
    const marker = sanitizeTodoText(`TODO update rejected: ${message}`, 300);
    this.#lastModelMutationError = marker;
    this.#state = {
      ...this.#state,
      modelMutationError: marker,
      updatedAt: this.#options.now?.() ?? new Date().toISOString(),
    };
  }
  private invalidWithBlockers(message: string, code: "PLAN_NOT_READY" | "PLAN_NOT_APPROVED", blockers: readonly string[]): TodoUpdateResult {
    return { ok: false, code, message, currentRevision: this.#state.revision, state: this.current(), blockers };
  }
}

function sanitizeHydratedTodoState(state: TodoListState, now: string): TodoListState {
  const rawState = state as unknown;
  const rawRecord = typeof rawState === "object" && rawState !== null
    ? rawState as Record<string, unknown>
    : undefined;
  const fallbackRevision = rawRecord !== undefined && Number.isSafeInteger(rawRecord.revision) && Number(rawRecord.revision) >= 0
    ? Number(rawRecord.revision)
    : 0;
  try {
    if (rawRecord === undefined) throw new Error("persisted TODO state must be an object");
    if (!Array.isArray(rawRecord.items)) throw new Error("persisted TODO items must be an array");
    if (!Number.isSafeInteger(rawRecord.revision) || Number(rawRecord.revision) < 0) {
      throw new Error("persisted TODO revision is invalid");
    }
    const items = normalizeTodoItems(rawRecord.items as PlanItem[], now);
    const document = normalizePlanDocument(rawRecord.document as PlanDocument | undefined);
    const revision = Number(rawRecord.revision);
    const digest = planDigest(document, items);
    const rawApproval = rawRecord.approval as PlanApproval | undefined;
    const approval = rawApproval !== undefined && digest !== undefined && typeof rawApproval.digest === "string" && rawApproval.digest === digest && ["shift_tab", "slash", "ui"].includes(rawApproval.via) && ["keep", "compact"].includes(rawApproval.contextStrategy) && Number.isSafeInteger(rawApproval.revision) && rawApproval.revision >= 0 && rawApproval.revision <= revision && typeof rawApproval.approvedAt === "string"
      ? rawApproval
      : undefined;
    const approvedRevision = rawRecord.approvedRevision;
    if (approvedRevision !== undefined && (!Number.isSafeInteger(approvedRevision) || Number(approvedRevision) < 0 || Number(approvedRevision) > revision)) {
      throw new Error("persisted TODO approval revision is invalid");
    }
    const modelMutationError = rawRecord.modelMutationError === undefined
      ? undefined
      : typeof rawRecord.modelMutationError === "string"
        ? sanitizeTodoText(rawRecord.modelMutationError, 300)
        : (() => { throw new Error("persisted TODO mutation error is invalid"); })();
    return {
      revision,
      items,
      updatedAt: typeof rawRecord.updatedAt === "string" ? rawRecord.updatedAt : now,
      ...(document === undefined ? {} : { document }),
      ...(approval === undefined ? {} : { approval }),
      ...(approval === undefined || approvedRevision === undefined ? {} : { approvedRevision: Number(approvedRevision) }),
      ...(modelMutationError ? { modelMutationError } : {}),
    };
  } catch (error) {
    const detail = sanitizeTodoText(error instanceof Error ? error.message : String(error), 240);
    const blockedReason = `TODO state could not be restored safely: ${detail || "invalid persisted plan"}`;
    return {
      revision: fallbackRevision,
      items: [{
        id: "todo-hydration-error",
        text: "Repair the persisted TODO state before reporting completion",
        status: "blocked",
        kind: "analysis",
        blockedReason,
        createdAt: now,
        updatedAt: now,
      }],
      updatedAt: now,
    };
  }
}
