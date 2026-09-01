import { createHash } from "node:crypto";

import type { GoalContract, GoalEvaluation } from "./goal-contract.ts";
import type { CompactTodoSnapshot, CompactionReflection } from "./compaction.ts";
import type { SessionViewModel, TimelineItem } from "./reducer.ts";

export type CompactionStrategy = "model_summary" | "provider_native" | "deterministic_fallback";
export type CompactionReceiptTrigger = "ratio" | "projection" | "manual" | "provider_context_error";

export interface EvidenceBoundText {
  readonly text: string;
  readonly evidenceRefs: readonly string[];
}

export interface CompactionGoalSnapshot {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
  readonly successCriteria: readonly string[];
  readonly allowedScope: readonly string[];
  readonly stopConditions: readonly string[];
  readonly outstandingCriteria: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ApprovalSnapshot {
  readonly id: string;
  readonly action: string;
  readonly display: string;
  readonly status: "pending" | "approved" | "denied";
  readonly reason: string;
  readonly decisionReason: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface PendingQuestionnaireSnapshot {
  readonly id: string;
  readonly reason: string;
  readonly questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly required: boolean;
  }[];
  readonly evidenceRefs: readonly string[];
}

export interface CompactionChangedFile {
  readonly path: string;
  readonly diffSummary: string;
  readonly evidenceRefs: readonly string[];
}

export interface CompactionVerification {
  readonly command: string | null;
  readonly status: "passed" | "failed" | "not_run";
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface CompactionFailure {
  readonly summary: string;
  readonly correctiveAction: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface CompactionEvidenceCatalogEntry {
  readonly id: string;
  readonly kind:
    | "goal"
    | "user"
    | "todo"
    | "approval"
    | "questionnaire"
    | "file"
    | "verification"
    | "failure"
    | "decision"
    | "completion"
    | "artifact";
}

export interface CompactionSourceBundle {
  readonly schemaVersion: "2.0";
  readonly generation: number;
  readonly sourceRange: {
    readonly firstSequence: number;
    readonly lastSequence: number;
  };
  readonly sourceDigest: string;
  readonly currentGoal: CompactionGoalSnapshot | null;
  readonly userConstraints: readonly EvidenceBoundText[];
  readonly decisions: readonly EvidenceBoundText[];
  readonly completedWork: readonly EvidenceBoundText[];
  readonly todos: readonly CompactTodoSnapshot[];
  readonly todoEvidenceRefs: Readonly<Record<string, readonly string[]>>;
  readonly approvals: readonly ApprovalSnapshot[];
  readonly pendingQuestionnaire: PendingQuestionnaireSnapshot | null;
  readonly changedFiles: readonly CompactionChangedFile[];
  readonly verification: readonly CompactionVerification[];
  readonly failures: readonly CompactionFailure[];
  readonly evidenceCatalog: readonly CompactionEvidenceCatalogEntry[];
  readonly transcriptPrefix: readonly unknown[];
  readonly recentTail: readonly unknown[];
}

export interface ModelCompactionSummaryV2 {
  readonly schemaVersion: "2.0";
  readonly sourceDigest: string;
  readonly goal: string;
  readonly currentState: string;
  readonly constraints: readonly EvidenceBoundText[];
  readonly decisions: readonly EvidenceBoundText[];
  readonly completedWork: readonly EvidenceBoundText[];
  readonly workspaceChanges: readonly {
    readonly path: string;
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly verification: readonly {
    readonly command: string | null;
    readonly status: "passed" | "failed" | "not_run";
    readonly text: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly failedApproaches: readonly {
    readonly text: string;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly unresolved: readonly {
    readonly text: string;
    readonly nextAction: string | null;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly todos: readonly CompactTodoSnapshot[];
  readonly approvals: readonly ApprovalSnapshot[];
  readonly pendingQuestionnaire: PendingQuestionnaireSnapshot | null;
  readonly nextAction: string;
}

export interface CompactionReceiptV2 {
  readonly schemaVersion: "2.0";
  readonly strategy: CompactionStrategy;
  readonly trigger: CompactionReceiptTrigger;
  readonly inputBudgetTokens: number;
  readonly modelContextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly compiledTokensBefore: number;
  readonly compressiblePrefixTokens: number;
  readonly summaryTokens: number;
  readonly compiledTokensAfter: number;
  readonly ratioBefore: number;
  readonly ratioAfter: number;
  readonly targetRatio: number;
  readonly sourceDigest: string;
  readonly summaryDigest: string;
  readonly generation: number;
  readonly fallbackUsed: boolean;
  readonly targetMet: boolean;
  readonly reasonCodes: readonly string[];
}

export interface BuildCompactionSourceBundleOptions {
  readonly currentGoal?: GoalContract;
  readonly goalEvaluation?: GoalEvaluation;
  readonly generation?: number;
  readonly transcriptPrefix?: readonly unknown[];
  readonly recentTail?: readonly unknown[];
  readonly priorCompactState?: string;
  readonly reflections?: readonly CompactionReflection[];
}

export interface ModelCompactionValidationIssue {
  readonly code:
    | "invalid_shape"
    | "unknown_evidence"
    | "unknown_path"
    | "goal_mismatch"
    | "constraint_dropped"
    | "todo_mismatch"
    | "approval_mismatch"
    | "questionnaire_mismatch"
    | "verification_mismatch"
    | "failure_dropped"
    | "budget_exceeded"
    | "source_changed";
  readonly path: string;
  readonly message: string;
}

export type ModelCompactionValidationResult =
  | { readonly valid: true; readonly value: ModelCompactionSummaryV2; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ModelCompactionValidationIssue[] };

export function buildCompactionSourceBundle(
  model: SessionViewModel,
  options: BuildCompactionSourceBundleOptions = {},
): CompactionSourceBundle {
  const catalog = new Map<string, CompactionEvidenceCatalogEntry["kind"]>();
  const register = (id: string, kind: CompactionEvidenceCatalogEntry["kind"]): string => {
    catalog.set(id, kind);
    return id;
  };
  const evidenceFor = (item: TimelineItem, kind: CompactionEvidenceCatalogEntry["kind"]): string =>
    register(item.id, kind);
  const userItems = model.timeline.filter((item) => item.type === "user");
  const userConstraints = userItems.map((item) => ({
    text: item.text,
    evidenceRefs: [evidenceFor(item, "user")],
  }));
  const latestUser = userItems.at(-1);
  const goalContract = options.currentGoal;
  const goalEvaluation = options.goalEvaluation;
  const currentGoal: CompactionGoalSnapshot | null = goalContract === undefined
    ? latestUser === undefined
      ? null
      : {
          id: `latest-${latestUser.id}`,
          goal: latestUser.text,
          status: "active",
          successCriteria: [],
          allowedScope: [],
          stopConditions: [],
          outstandingCriteria: [],
          evidenceRefs: [evidenceFor(latestUser, "goal")],
        }
    : {
        id: goalContract.id,
        goal: goalContract.goal,
        status: goalEvaluation?.status ?? "active",
        successCriteria: goalContract.successCriteria.map((criterion) => criterion.statement),
        allowedScope: [...goalContract.allowedScope],
        stopConditions: [...goalContract.stopConditions],
        outstandingCriteria: [...(goalEvaluation?.outstandingCriteria ?? [])],
        evidenceRefs: [register(`goal:${goalContract.id}`, "goal")],
      };

  const decisions = model.timeline
    .filter((item): item is Extract<TimelineItem, { type: "commentary" }> =>
      item.type === "commentary" && item.text.trim().length > 0)
    .slice(-32)
    .map((item) => ({
      text: item.text,
      evidenceRefs: [evidenceFor(item, "decision")],
    }));
  const completedWork: EvidenceBoundText[] = [];
  for (const item of model.timeline) {
    if (item.type === "tool" && item.status === "succeeded" && item.summary?.trim()) {
      completedWork.push({
        text: `${item.toolId}: ${item.summary}`,
        evidenceRefs: [evidenceFor(item, "completion")],
      });
    } else if (item.type === "final" && item.report?.summary.trim()) {
      completedWork.push({
        text: item.report.summary,
        evidenceRefs: [evidenceFor(item, "completion")],
      });
    }
  }

  const todoItems = model.todo.items.length > 0 ? model.todo.items : model.plan;
  const todos: CompactTodoSnapshot[] = todoItems.map((item) => ({
    id: item.id,
    text: item.text,
    status: item.status,
    ...(item.blockedReason === undefined ? {} : { blockedReason: item.blockedReason }),
  }));
  const todoEvidenceRefs: Record<string, readonly string[]> = {};
  for (const item of todos) {
    todoEvidenceRefs[item.id] = [
      register(`todo:${model.todo.revision}:${item.id}`, "todo"),
    ];
  }

  const approvals: ApprovalSnapshot[] = model.timeline
    .filter((item) => item.type === "approval")
    .map((item) => ({
      id: item.approvalId,
      action: item.action,
      display: item.display,
      status: item.decision === undefined
        ? "pending"
        : item.decision === "deny"
          ? "denied"
          : "approved",
      reason: item.reason,
      decisionReason: item.decisionReason ?? null,
      evidenceRefs: [evidenceFor(item, "approval")],
    }));
  const pending = model.deepPlan?.pendingQuestionnaire;
  const pendingQuestionnaire: PendingQuestionnaireSnapshot | null = pending === undefined
    ? null
    : {
        id: pending.questionnaireId,
        reason: pending.reason,
        questions: pending.questions.map((question) => ({
          id: question.id,
          question: question.question,
          required: question.required,
        })),
        evidenceRefs: [
          register(
            `questionnaire:${model.deepPlan?.revision ?? 0}:${pending.questionnaireId}`,
            "questionnaire",
          ),
        ],
      };

  const changedFiles = buildChangedFiles(model, register);
  const verification = buildVerification(model, register);
  const failures = buildFailures(model, options.reflections ?? [], register);
  for (const item of model.timeline) {
    if (item.type !== "tool") continue;
    for (const artifact of item.artifacts ?? []) register(artifact, "artifact");
  }
  const sequences = model.timeline.map((item) => item.sequence);
  const sourceRange = {
    firstSequence: sequences.length === 0 ? 0 : Math.min(...sequences),
    lastSequence: sequences.length === 0 ? 0 : Math.max(...sequences),
  };
  const transcriptPrefix = [
    ...(options.priorCompactState === undefined
      ? []
      : [{ type: "prior_compact_state", text: options.priorCompactState }]),
    ...clonePlain(options.transcriptPrefix ?? []),
  ];
  const payload = {
    schemaVersion: "2.0" as const,
    generation: Math.max(0, Math.floor(options.generation ?? model.contextGeneration)),
    sourceRange,
    currentGoal,
    userConstraints,
    decisions,
    completedWork: completedWork.slice(-64),
    todos,
    todoEvidenceRefs,
    approvals,
    pendingQuestionnaire,
    changedFiles,
    verification,
    failures,
    evidenceCatalog: [...catalog.entries()]
      .map(([id, kind]) => ({ id, kind }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    transcriptPrefix,
    recentTail: clonePlain(options.recentTail ?? []),
  };
  return {
    ...payload,
    sourceDigest: digest(payload),
  };
}

function buildChangedFiles(
  model: SessionViewModel,
  register: (id: string, kind: CompactionEvidenceCatalogEntry["kind"]) => string,
): CompactionChangedFile[] {
  const purposes = new Map<string, { summary: string; refs: string[] }>();
  for (const item of model.timeline) {
    if (item.type !== "diff") continue;
    for (const file of item.files) {
      const entry = purposes.get(file.path) ?? { summary: "", refs: [] };
      if (file.purpose?.trim()) entry.summary = file.purpose.trim();
      entry.refs.push(register(item.id, "file"));
      purposes.set(file.path, entry);
    }
  }
  return [...model.changedFiles.entries()].map(([path, counts]) => {
    const semantic = purposes.get(path);
    return {
      path,
      diffSummary: semantic?.summary || `+${counts.additions} -${counts.deletions}`,
      evidenceRefs: semantic?.refs.length
        ? [...new Set(semantic.refs)]
        : [register(`file:${path}`, "file")],
    };
  });
}

function buildVerification(
  model: SessionViewModel,
  register: (id: string, kind: CompactionEvidenceCatalogEntry["kind"]) => string,
): CompactionVerification[] {
  const records: CompactionVerification[] = [];
  for (const item of model.timeline) {
    if (
      item.type === "tool" &&
      (item.toolId === "process.run" || item.toolId === "shell.run") &&
      isVerificationCommand(item.argumentsSummary)
    ) {
      records.push({
        command: item.argumentsSummary || null,
        status: item.status === "succeeded"
          ? "passed"
          : item.status === "failed"
            ? "failed"
            : "not_run",
        summary: item.summary ?? item.errorCode ?? item.status,
        evidenceRefs: [register(item.id, "verification")],
      });
    }
    if (item.type !== "final" || item.report === undefined) continue;
    for (const verification of item.report.verification) {
      records.push({
        command: verification.command ?? null,
        status: verification.status,
        summary: verification.evidence,
        evidenceRefs: [register(item.id, "verification")],
      });
    }
  }
  return dedupeRecords(records, (record) =>
    JSON.stringify([record.command, record.status, record.summary, record.evidenceRefs]));
}

function buildFailures(
  model: SessionViewModel,
  reflections: readonly CompactionReflection[],
  register: (id: string, kind: CompactionEvidenceCatalogEntry["kind"]) => string,
): CompactionFailure[] {
  const failures: CompactionFailure[] = [];
  for (const item of model.timeline) {
    if (item.type === "tool" && item.status === "failed") {
      const reflection = [...reflections].reverse().find((candidate) => candidate.toolId === item.toolId);
      failures.push({
        summary: `${item.toolId} failed: ${item.summary ?? item.errorCode ?? "unknown"}`,
        correctiveAction: reflection?.correctiveAction ?? null,
        evidenceRefs: [register(item.id, "failure")],
      });
    } else if (item.type === "task" && (item.state === "failed" || item.state === "blocked")) {
      failures.push({
        summary: `task ${item.title} ended ${item.state}${item.blocker ? `: ${item.blocker}` : ""}`,
        correctiveAction: null,
        evidenceRefs: [register(item.id, "failure")],
      });
    }
  }
  for (const [index, reflection] of reflections.entries()) {
    const ref = register(`reflection:${index}:${reflection.toolId}`, "failure");
    failures.push({
      summary: `${reflection.toolId} failed (${reflection.category}): ${reflection.rootCause}`,
      correctiveAction: reflection.correctiveAction,
      evidenceRefs: [ref],
    });
  }
  return dedupeRecords(failures, (failure) => JSON.stringify(failure));
}

function isVerificationCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return /(?:^|\s)(?:test|typecheck|lint|check|build)(?:\s|$)|cargo test|pytest|go test|gradle(?:\.bat)? (?:test|build)|dotnet test/u.test(normalized);
}

function dedupeRecords<T>(records: readonly T[], key: (record: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const record of records) {
    const id = key(record);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(record);
  }
  return output;
}

function clonePlain<T>(value: T): T {
  return structuredClone(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function compactionSummaryDigest(summary: ModelCompactionSummaryV2): string {
  return digest(summary);
}

export function calculateSummaryBudget(input: {
  readonly targetCompiledTokens: number;
  readonly fixedTokens: number;
  readonly minimumSummaryTokens?: number;
}): {
  readonly summaryBudgetTokens: number;
  readonly irreducible: boolean;
} {
  const target = Math.max(0, Math.floor(input.targetCompiledTokens));
  const fixed = Math.max(0, Math.floor(input.fixedTokens));
  const available = target - fixed;
  if (available <= 0) return { summaryBudgetTokens: 0, irreducible: true };
  return {
    summaryBudgetTokens: Math.max(
      Math.max(1, Math.floor(input.minimumSummaryTokens ?? 1_024)),
      available,
    ),
    irreducible: false,
  };
}

export function renderModelCompactionSummary(summary: ModelCompactionSummaryV2): string {
  const lines = [
    "# Session state (model-compacted)",
    `Source digest: ${summary.sourceDigest}`,
    "",
    "## Goal",
    summary.goal,
    "",
    "## Current state",
    summary.currentState,
  ];
  appendBoundText(lines, "Constraints", summary.constraints);
  appendBoundText(lines, "Decisions", summary.decisions);
  appendBoundText(lines, "Completed work", summary.completedWork);
  if (summary.workspaceChanges.length > 0) {
    lines.push("", "## Workspace changes");
    for (const change of summary.workspaceChanges) {
      lines.push(`- ${change.path}: ${change.summary} [${change.evidenceRefs.join(", ")}]`);
    }
  }
  if (summary.verification.length > 0) {
    lines.push("", "## Verification");
    for (const check of summary.verification) {
      lines.push(`- [${check.status}] ${check.command ?? "verification"}: ${check.text} [${check.evidenceRefs.join(", ")}]`);
    }
  }
  if (summary.failedApproaches.length > 0) {
    lines.push("", "## Failed approaches");
    for (const failure of summary.failedApproaches) {
      lines.push(`- ${failure.text} — ${failure.reason} [${failure.evidenceRefs.join(", ")}]`);
    }
  }
  if (summary.unresolved.length > 0) {
    lines.push("", "## Unresolved");
    for (const item of summary.unresolved) {
      lines.push(`- ${item.text}${item.nextAction ? ` — next: ${item.nextAction}` : ""} [${item.evidenceRefs.join(", ")}]`);
    }
  }
  if (summary.todos.length > 0) {
    lines.push("", "## TODO snapshot");
    for (const item of summary.todos) {
      lines.push(`- [${item.status}] ${item.id}: ${item.text}${item.blockedReason ? ` — ${item.blockedReason}` : ""}`);
    }
  }
  if (summary.approvals.length > 0) {
    lines.push("", "## Approvals");
    for (const approval of summary.approvals) {
      lines.push(`- [${approval.status}] ${approval.id}: ${approval.display}`);
    }
  }
  if (summary.pendingQuestionnaire !== null) {
    lines.push("", "## Pending questionnaire", `- ${summary.pendingQuestionnaire.id}: ${summary.pendingQuestionnaire.reason}`);
  }
  lines.push("", "## Next action", summary.nextAction);
  return lines.join("\n");
}

function appendBoundText(lines: string[], heading: string, entries: readonly EvidenceBoundText[]): void {
  if (entries.length === 0) return;
  lines.push("", `## ${heading}`);
  for (const entry of entries) lines.push(`- ${entry.text} [${entry.evidenceRefs.join(", ")}]`);
}

export function validateModelCompactionSummary(
  candidate: unknown,
  bundle: CompactionSourceBundle,
  options: {
    readonly estimateTokens: (text: string) => number;
    readonly summaryBudgetTokens: number;
    readonly expectedGeneration?: number;
  },
): ModelCompactionValidationResult {
  const issues: ModelCompactionValidationIssue[] = [];
  if (!isModelCompactionSummary(candidate)) {
    return invalid([{
      code: "invalid_shape",
      path: "$",
      message: "model compaction summary does not match schema 2.0",
    }]);
  }
  const value = clonePlain(candidate);
  if (value.sourceDigest !== bundle.sourceDigest) {
    issues.push({
      code: "source_changed",
      path: "$.sourceDigest",
      message: "summary source digest does not match the staged source bundle",
    });
  }
  if (
    options.expectedGeneration !== undefined &&
    bundle.generation !== options.expectedGeneration
  ) {
    issues.push({
      code: "source_changed",
      path: "$.generation",
      message: "context generation changed while summary validation was pending",
    });
  }
  const expectedGoal = bundle.currentGoal?.goal ?? "";
  if (value.goal !== expectedGoal) {
    issues.push({
      code: "goal_mismatch",
      path: "$.goal",
      message: "summary must preserve the latest goal contract exactly",
    });
  }

  const allowedEvidence = new Set(bundle.evidenceCatalog.map((entry) => entry.id));
  for (const [path, refs] of summaryEvidenceReferences(value)) {
    for (const reference of refs) {
      if (!allowedEvidence.has(reference)) {
        issues.push({
          code: "unknown_evidence",
          path,
          message: `summary references evidence outside the source bundle: ${reference}`,
        });
      }
    }
  }
  const constraintRefs = new Set(value.constraints.flatMap((entry) => entry.evidenceRefs));
  for (const source of bundle.userConstraints) {
    if (!source.evidenceRefs.some((reference) => constraintRefs.has(reference))) {
      issues.push({
        code: "constraint_dropped",
        path: "$.constraints",
        message: `active user instruction was not represented: ${source.evidenceRefs.join(",")}`,
      });
    }
  }

  if (JSON.stringify(value.todos) !== JSON.stringify(bundle.todos)) {
    issues.push({
      code: "todo_mismatch",
      path: "$.todos",
      message: "TODO ids, statuses, text, and blocked reasons must remain exact",
    });
  }
  if (JSON.stringify(value.approvals) !== JSON.stringify(bundle.approvals)) {
    issues.push({
      code: "approval_mismatch",
      path: "$.approvals",
      message: "approval decisions and pending state must remain exact",
    });
  }
  if (JSON.stringify(value.pendingQuestionnaire) !== JSON.stringify(bundle.pendingQuestionnaire)) {
    issues.push({
      code: "questionnaire_mismatch",
      path: "$.pendingQuestionnaire",
      message: "pending questionnaire state must remain exact",
    });
  }

  const allowedPaths = new Set(bundle.changedFiles.map((file) => file.path));
  for (const [index, change] of value.workspaceChanges.entries()) {
    if (!allowedPaths.has(change.path)) {
      issues.push({
        code: "unknown_path",
        path: `$.workspaceChanges[${index}].path`,
        message: `summary invented or retained an unavailable path: ${change.path}`,
      });
    }
  }
  validateVerification(value, bundle, issues);
  validateFailureCoverage(value, bundle, issues);

  const tokens = options.estimateTokens(renderModelCompactionSummary(value));
  if (tokens > Math.max(0, Math.floor(options.summaryBudgetTokens))) {
    issues.push({
      code: "budget_exceeded",
      path: "$",
      message: `rendered summary uses ${tokens} tokens; budget is ${options.summaryBudgetTokens}`,
    });
  }
  return issues.length === 0
    ? { valid: true, value: Object.freeze(value), issues: [] }
    : invalid(issues);
}

function validateVerification(
  summary: ModelCompactionSummaryV2,
  bundle: CompactionSourceBundle,
  issues: ModelCompactionValidationIssue[],
): void {
  const represented = new Set(summary.verification.flatMap((entry) => entry.evidenceRefs));
  for (const source of bundle.verification) {
    if (!source.evidenceRefs.some((reference) => represented.has(reference))) {
      issues.push({
        code: "verification_mismatch",
        path: "$.verification",
        message: `verification result was dropped: ${source.evidenceRefs.join(",")}`,
      });
    }
  }
  for (const [index, check] of summary.verification.entries()) {
    const source = bundle.verification.find((candidate) =>
      candidate.evidenceRefs.some((reference) => check.evidenceRefs.includes(reference)));
    if (
      source === undefined ||
      source.status !== check.status ||
      (check.command !== null && source.command !== check.command)
    ) {
      issues.push({
        code: "verification_mismatch",
        path: `$.verification[${index}]`,
        message: "verification command/status is not supported by its evidence",
      });
    }
  }
}

function validateFailureCoverage(
  summary: ModelCompactionSummaryV2,
  bundle: CompactionSourceBundle,
  issues: ModelCompactionValidationIssue[],
): void {
  const represented = new Set([
    ...summary.failedApproaches.flatMap((entry) => entry.evidenceRefs),
    ...summary.unresolved.flatMap((entry) => entry.evidenceRefs),
  ]);
  for (const source of bundle.failures) {
    if (!source.evidenceRefs.some((reference) => represented.has(reference))) {
      issues.push({
        code: "failure_dropped",
        path: "$.failedApproaches",
        message: `failed approach was dropped: ${source.evidenceRefs.join(",")}`,
      });
    }
  }
}

function invalid(
  issues: readonly ModelCompactionValidationIssue[],
): ModelCompactionValidationResult {
  return { valid: false, issues: Object.freeze([...issues]) };
}

function isModelCompactionSummary(value: unknown): value is ModelCompactionSummaryV2 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "sourceDigest",
    "goal",
    "currentState",
    "constraints",
    "decisions",
    "completedWork",
    "workspaceChanges",
    "verification",
    "failedApproaches",
    "unresolved",
    "todos",
    "approvals",
    "pendingQuestionnaire",
    "nextAction",
  ])) return false;
  if (
    value.schemaVersion !== "2.0" ||
    !isString(value.sourceDigest) ||
    !isString(value.goal) ||
    !isString(value.currentState) ||
    !isString(value.nextAction)
  ) return false;
  if (
    !isArrayOf(value.constraints, isEvidenceBoundText) ||
    !isArrayOf(value.decisions, isEvidenceBoundText) ||
    !isArrayOf(value.completedWork, isEvidenceBoundText)
  ) return false;
  if (!isArrayOf(value.workspaceChanges, (entry) =>
    isRecord(entry) &&
    hasOnlyKeys(entry, ["path", "summary", "evidenceRefs"]) &&
    isString(entry.path) &&
    isString(entry.summary) &&
    isEvidenceRefs(entry.evidenceRefs))) return false;
  if (!isArrayOf(value.verification, (entry) =>
    isRecord(entry) &&
    hasOnlyKeys(entry, ["command", "status", "text", "evidenceRefs"]) &&
    (entry.command === null || isString(entry.command)) &&
    ["passed", "failed", "not_run"].includes(String(entry.status)) &&
    isString(entry.text) &&
    isEvidenceRefs(entry.evidenceRefs))) return false;
  if (!isArrayOf(value.failedApproaches, (entry) =>
    isRecord(entry) &&
    hasOnlyKeys(entry, ["text", "reason", "evidenceRefs"]) &&
    isString(entry.text) &&
    isString(entry.reason) &&
    isEvidenceRefs(entry.evidenceRefs))) return false;
  if (!isArrayOf(value.unresolved, (entry) =>
    isRecord(entry) &&
    hasOnlyKeys(entry, ["text", "nextAction", "evidenceRefs"]) &&
    isString(entry.text) &&
    (entry.nextAction === null || isString(entry.nextAction)) &&
    isEvidenceRefs(entry.evidenceRefs))) return false;
  if (!isArrayOf(value.todos, isTodoSnapshot)) return false;
  if (!isArrayOf(value.approvals, isApprovalSnapshot)) return false;
  return value.pendingQuestionnaire === null ||
    isPendingQuestionnaireSnapshot(value.pendingQuestionnaire);
}

function isEvidenceBoundText(value: unknown): value is EvidenceBoundText {
  return isRecord(value) &&
    hasOnlyKeys(value, ["text", "evidenceRefs"]) &&
    isString(value.text) &&
    isEvidenceRefs(value.evidenceRefs);
}

function isTodoSnapshot(value: unknown): value is CompactTodoSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "text", "status", "blockedReason"])) return false;
  return isString(value.id) &&
    isString(value.text) &&
    ["pending", "active", "done", "blocked", "skipped"].includes(String(value.status)) &&
    (value.blockedReason === undefined || isString(value.blockedReason));
}

function isApprovalSnapshot(value: unknown): value is ApprovalSnapshot {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "action",
      "display",
      "status",
      "reason",
      "decisionReason",
      "evidenceRefs",
    ]) &&
    isString(value.id) &&
    isString(value.action) &&
    isString(value.display) &&
    ["pending", "approved", "denied"].includes(String(value.status)) &&
    isString(value.reason) &&
    (value.decisionReason === null || isString(value.decisionReason)) &&
    isEvidenceRefs(value.evidenceRefs);
}

function isPendingQuestionnaireSnapshot(
  value: unknown,
): value is PendingQuestionnaireSnapshot {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "reason", "questions", "evidenceRefs"]) &&
    isString(value.id) &&
    isString(value.reason) &&
    isEvidenceRefs(value.evidenceRefs) &&
    isArrayOf(value.questions, (question) =>
      isRecord(question) &&
      hasOnlyKeys(question, ["id", "question", "required"]) &&
      isString(question.id) &&
      isString(question.question) &&
      typeof question.required === "boolean");
}

function summaryEvidenceReferences(
  summary: ModelCompactionSummaryV2,
): Array<readonly [string, readonly string[]]> {
  return [
    ...summary.constraints.map((entry, index) =>
      [`$.constraints[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.decisions.map((entry, index) =>
      [`$.decisions[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.completedWork.map((entry, index) =>
      [`$.completedWork[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.workspaceChanges.map((entry, index) =>
      [`$.workspaceChanges[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.verification.map((entry, index) =>
      [`$.verification[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.failedApproaches.map((entry, index) =>
      [`$.failedApproaches[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.unresolved.map((entry, index) =>
      [`$.unresolved[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...summary.approvals.map((entry, index) =>
      [`$.approvals[${index}].evidenceRefs`, entry.evidenceRefs] as const),
    ...(summary.pendingQuestionnaire === null
      ? []
      : [[
          "$.pendingQuestionnaire.evidenceRefs",
          summary.pendingQuestionnaire.evidenceRefs,
        ] as const]),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key)) &&
    allowed.filter((key) => key !== "blockedReason").every((key) =>
      key in value || key === "pendingQuestionnaire");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isEvidenceRefs(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isArrayOf(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is readonly unknown[] {
  return Array.isArray(value) && value.every(predicate);
}
