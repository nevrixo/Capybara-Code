/**
 * Durable TODO and Plan Contract renderers.
 *
 * The original TODO widget intentionally stays available for old journals.  A
 * structured Plan Contract is rendered by the same module so the timeline,
 * overlay, plain renderer, and fullscreen composer all agree on the contract a
 * Build turn is allowed to execute.
 */

import { planDigest, type PlanDocument, type PlanItem, type TodoListState } from "@cbc/session-domain";

import { fitLine, line, segment, wrapPrefixedLines, type BlockContext, type Segment, type StyledLine } from "./segments.ts";
import { sanitizeInline } from "./sanitize.ts";
import { stringWidth } from "./width.ts";
import { todoBox } from "./chrome.ts";
import type { ThemeToken } from "./theme.ts";

/** A display-compatible file anchor (kept structural for old/new session models). */
export interface PlanFileAnchorView {
  readonly path: string;
  readonly purpose?: string;
  readonly anchor?: string;
  readonly anchors?: readonly string[];
  readonly symbols?: readonly string[];
}

/** A display-compatible verification check. */
export interface PlanVerificationCheckView {
  readonly id?: string;
  readonly command?: string;
  readonly expected?: string;
  readonly expectedResult?: string;
  readonly description?: string;
  readonly status?: "pending" | "running" | "passed" | "failed" | "not_run";
  readonly evidence?: string;
}

/** A display-compatible external action declaration. */
export interface PlanExternalActionView {
  readonly server?: string;
  readonly tool?: string;
  readonly action?: string;
  readonly reason?: string;
  readonly risk?: string;
  readonly detail?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

/** The durable document portions that form the visible Plan Contract. */
export interface PlanDocumentView {
  readonly goal: string;
  readonly context: readonly string[];
  readonly assumptions?: readonly string[];
  readonly criticalFiles: readonly PlanFileAnchorView[];
  readonly verification: readonly PlanVerificationCheckView[];
  readonly externalActions?: readonly PlanExternalActionView[];
  readonly risks: readonly string[];
  readonly rollback: readonly string[];
}

/** Approval metadata shown by the contract lens. */
export interface PlanApprovalView {
  readonly revision: number;
  readonly digest: string;
  readonly approvedAt?: string;
  readonly via?: "shift_tab" | "slash" | "ui" | string;
  readonly contextStrategy?: "keep" | "compact";
}

/** Readiness information can be supplied by session-domain or derived here. */
export interface PlanReadinessView {
  readonly ready: boolean;
  readonly blockers?: readonly string[];
  readonly digest?: string;
}

/** Optional fields accepted from both the legacy TODO state and Plan Contract state. */
export interface PlanContractRenderInput {
  readonly document?: PlanDocumentView;
  readonly planDocument?: PlanDocumentView;
  readonly contract?: PlanDocumentView | { readonly document?: PlanDocumentView };
  readonly items?: readonly PlanItem[];
  readonly plan?: readonly PlanItem[];
  readonly todo?: TodoListState | { readonly items?: readonly PlanItem[] };
  readonly revision?: number;
  readonly approvedRevision?: number;
  readonly approval?: PlanApprovalView;
  readonly planApproval?: PlanApprovalView;
  readonly readiness?: PlanReadinessView;
  readonly planReadiness?: PlanReadinessView;
  readonly digest?: string;
}

/** Internal display shape for fields added to PlanItem after the original release. */
type PlanItemView = PlanItem & {
  readonly details?: string;
  readonly files?: readonly string[];
  readonly symbols?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly commands?: readonly string[];
};

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord | undefined {
  return typeof value === "object" && value !== null ? value as AnyRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => sanitizeInline(entry, 400))
    .filter((entry) => entry.length > 0);
}

function objectList(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is AnyRecord => entry !== undefined) : [];
}

function documentFrom(value: unknown): PlanDocumentView | undefined {
  const root = record(value);
  if (root === undefined) return undefined;

  // Hosts commonly expose the document as `planDocument`, `document`, or a
  // contract wrapper. Accept all three so snapshot migrations do not make the
  // renderer disappear while the model catches up.
  const nested = record(root.document) ?? record(root.planDocument) ??
    (record(root.contract)?.document !== undefined ? record(record(root.contract)?.document) : record(root.contract));
  const source = nested ?? root;
  const goal = text(source.goal);
  const context = textList(source.context);
  const assumptions = textList(source.assumptions);
  const criticalFiles = objectList(source.criticalFiles).flatMap((entry): PlanFileAnchorView[] => {
    const path = text(entry.path);
    if (path === undefined) return [];
    const anchors = textList(entry.anchors);
    const anchor = text(entry.anchor);
    const symbols = textList(entry.symbols);
    const purpose = text(entry.purpose) ?? text(entry.reason);
    const result: PlanFileAnchorView = { path };
    const withPurpose = purpose === undefined ? result : { ...result, purpose };
    const withAnchor = anchor === undefined ? withPurpose : { ...withPurpose, anchor };
    const withAnchors = anchors.length === 0 ? withAnchor : { ...withAnchor, anchors };
    const withSymbols = symbols.length === 0 ? withAnchors : { ...withAnchors, symbols };
    return [withSymbols];
  });
  const verification = objectList(source.verification).map((entry): PlanVerificationCheckView => {
    const result: PlanVerificationCheckView = {};
    const id = text(entry.id);
    const command = text(entry.command);
    const expected = text(entry.expected);
    const expectedResult = text(entry.expectedResult);
    const description = text(entry.description);
    const evidence = text(entry.evidence);
    const withId = id === undefined ? result : { ...result, id };
    const withCommand = command === undefined ? withId : { ...withId, command };
    const withExpected = expected === undefined ? withCommand : { ...withCommand, expected };
    const withExpectedResult = expectedResult === undefined ? withExpected : { ...withExpected, expectedResult };
    const withDescription = description === undefined ? withExpectedResult : { ...withExpectedResult, description };
    const status: PlanVerificationCheckView["status"] | undefined =
      entry.status === "pending" || entry.status === "running" || entry.status === "passed" ||
      entry.status === "failed" || entry.status === "not_run"
        ? entry.status as PlanVerificationCheckView["status"]
        : undefined;
    const withStatus = status === undefined ? withDescription : { ...withDescription, status };
    return evidence === undefined ? withStatus : { ...withStatus, evidence };
  });
  const externalActions = objectList(source.externalActions).map((entry): PlanExternalActionView => {
    const result: PlanExternalActionView = {};
    const server = text(entry.server);
    const tool = text(entry.tool);
    const action = text(entry.action);
    const reason = text(entry.reason);
    const risk = text(entry.risk);
    const detail = text(entry.detail) ?? text(entry.description);
    const withServer = server === undefined ? result : { ...result, server };
    const withTool = tool === undefined ? withServer : { ...withServer, tool };
    const withAction = action === undefined ? withTool : { ...withTool, action };
    const withReason = reason === undefined ? withAction : { ...withAction, reason };
    const withRisk = risk === undefined ? withReason : { ...withReason, risk };
    const withDetail = detail === undefined ? withRisk : { ...withRisk, detail };
    return record(entry.arguments) === undefined ? withDetail : { ...withDetail, arguments: entry.arguments as Readonly<Record<string, unknown>> };
  });

  // A malformed/corrupt document is deliberately not presented as a valid
  // contract. A partial object is still useful to show as an unapproved draft,
  // so normalize absent arrays to empty lists rather than throwing in a render.
  if (goal === undefined && context.length === 0 && criticalFiles.length === 0 && verification.length === 0 &&
      textList(source.risks).length === 0 && textList(source.rollback).length === 0) {
    return undefined;
  }
  return {
    goal: goal ?? "(goal not provided)",
    context,
    ...(assumptions.length > 0 ? { assumptions } : {}),
    criticalFiles,
    verification,
    ...(externalActions.length > 0 ? { externalActions } : {}),
    risks: textList(source.risks),
    rollback: textList(source.rollback),
  };
}

function itemsFrom(value: unknown): readonly PlanItem[] {
  const root = record(value);
  if (root === undefined) return [];
  const todo = record(root.todo);
  const candidates: unknown[] = Array.isArray(root.items)
    ? root.items
    : Array.isArray(root.plan) ? root.plan
    : todo !== undefined && Array.isArray(todo.items) ? todo.items
    : [];
  return candidates.filter((entry): entry is PlanItem => record(entry) !== undefined);
}

function approvalFrom(value: unknown): PlanApprovalView | undefined {
  const root = record(value);
  if (root === undefined) return undefined;
  const raw = record(root.approval) ?? record(root.planApproval);
  if (raw === undefined || typeof raw.revision !== "number" || typeof raw.digest !== "string") return undefined;
  const result: PlanApprovalView = { revision: raw.revision, digest: raw.digest };
  const approvedAt = text(raw.approvedAt);
  const withTime = approvedAt === undefined ? result : { ...result, approvedAt };
  const withVia = typeof raw.via === "string" ? { ...withTime, via: raw.via } : withTime;
  return raw.contextStrategy === "keep" || raw.contextStrategy === "compact"
    ? { ...withVia, contextStrategy: raw.contextStrategy }
    : withVia;
}

function readinessFrom(value: unknown): PlanReadinessView | undefined {
  const root = record(value);
  if (root === undefined) return undefined;
  const raw = record(root.readiness) ?? record(root.planReadiness);
  if (raw === undefined || typeof raw.ready !== "boolean") return undefined;
  return { ready: raw.ready, ...(textList(raw.blockers).length > 0 ? { blockers: textList(raw.blockers) } : {}) };
}

function planItemsForInput(input: PlanContractRenderInput): readonly PlanItem[] {
  if (input.items !== undefined) return input.items;
  if (input.plan !== undefined) return input.plan;
  const todo = record(input.todo);
  return todo !== undefined && Array.isArray(todo.items)
    ? todo.items.filter((entry): entry is PlanItem => record(entry) !== undefined)
    : [];
}

function planDocumentForInput(input: PlanContractRenderInput): PlanDocumentView | undefined {
  return documentFrom(input.document ?? input.planDocument ?? input.contract);
}

function planApprovalForInput(input: PlanContractRenderInput): PlanApprovalView | undefined {
  return input.approval ?? input.planApproval ?? approvalFrom(input);
}

/**
 * Derive the digest from the raw contract when available. `documentFrom()` is a
 * presentation adapter and intentionally maps a few legacy fields (for example,
 * external-action `description` to `detail`); hashing that display shape would
 * produce an identity different from the session-domain contract.
 */
function rawPlanDocumentForInput(value: unknown): unknown {
  const root = record(value);
  if (root === undefined) return undefined;
  const direct = record(root.document) ?? record(root.planDocument);
  if (direct !== undefined) return direct;
  const contract = record(root.contract);
  if (contract !== undefined) return record(contract.document) ?? contract;
  return typeof root.goal === "string" ? root : undefined;
}

function currentPlanDigest(
  input: unknown,
  document: PlanDocumentView | undefined,
  items: readonly PlanItem[],
): string | undefined {
  const rawDocument = rawPlanDocumentForInput(input);
  for (const candidate of [rawDocument, document]) {
    if (candidate === undefined) continue;
    try {
      return planDigest(candidate as PlanDocument, items);
    } catch {
      // A malformed display snapshot should remain renderable; fall back to the
      // next shape and let readiness continue to report the useful blockers.
    }
  }
  return undefined;
}

function planReadinessForInput(input: PlanContractRenderInput, document: PlanDocumentView | undefined, items: readonly PlanItem[]): PlanReadinessView {
  return input.readiness ?? input.planReadiness ?? computePlanReadiness(document, items);
}

/**
 * Derive the visible readiness gate. The session-domain controller is the
 * authority for approval; this pure copy is intentionally conservative and is
 * used only when a hydrated view does not carry diagnostics yet.
 */
export function computePlanReadiness(
  document: PlanDocumentView | undefined,
  items: readonly PlanItem[],
): PlanReadinessView {
  const blockers: string[] = [];
  if (document === undefined) blockers.push("structured Plan Contract is missing");
  if (document !== undefined && document.goal.trim().length === 0) blockers.push("Goal is missing");
  if (document !== undefined && document.context.length === 0) blockers.push("Context is missing");
  if (document !== undefined && document.criticalFiles.length === 0) blockers.push("Critical files are missing");
  if (document !== undefined && document.verification.length === 0) blockers.push("Verification is missing");

  const implementation = items.filter((item) => item.kind === "implementation");
  const verification = items.filter((item) => item.kind === "verification");
  if (items.length === 0) blockers.push("Approach has no steps");
  if (implementation.length === 0) blockers.push("Approach has no implementation step");
  if (verification.length === 0) blockers.push("Approach has no verification step");

  for (const item of implementation) {
    const detail = item as PlanItemView;
    if ((detail.files?.length ?? 0) === 0) blockers.push(`implementation step '${item.id}' has no file anchor`);
    if ((detail.acceptanceCriteria?.length ?? 0) === 0) blockers.push(`implementation step '${item.id}' has no acceptance criteria`);
    if (document !== undefined && detail.files !== undefined && detail.files.length > 0 && document.criticalFiles.length > 0) {
      const allowed = document.criticalFiles.map((file) => file.path);
      for (const file of detail.files) {
        if (!allowed.some((anchor) => file === anchor || file.startsWith(`${anchor}/`))) {
          blockers.push(`implementation file '${file}' is outside Critical files`);
        }
      }
    }
  }
  if (items.some((item) => item.status === "blocked")) blockers.push("blocked approach step exists");
  // An open analysis step is deliberately NOT a blocker. Analysis is the reading
  // and reasoning that produces the plan, so a plan that is otherwise complete —
  // goal, context, critical files, verification, anchored implementation steps —
  // is approvable whether or not the model bothered to tick its own research
  // items off. Gating on it stranded finished plans behind an amber banner the
  // user could not clear by editing anything, since the missing thing was a
  // status the model never returns to. Genuine incompleteness is still caught by
  // the structural blockers above.
  if (document !== undefined && document.verification.some((check) =>
    (check.command ?? check.expected ?? check.expectedResult) === undefined)) {
    blockers.push("verification check has no command or expected result");
  }
  return { ready: blockers.length === 0, ...(blockers.length > 0 ? { blockers } : {}) };
}

function statusToken(status: PlanItem["status"]): ThemeToken {
  switch (status) {
    case "done": return "accent.green";
    case "active": return "accent.coral";
    case "blocked": return "accent.amber";
    case "skipped": return "fg.muted";
    case "pending": return "accent.cyan";
  }
}

function appendLabel(lines: StyledLine[], label: string, context: BlockContext): void {
  lines.push(fitLine("header", [segment(label, { fg: "accent.cyan", bold: true })], context));
}

function appendValue(lines: StyledLine[], value: string, context: BlockContext, options: { indent?: string; token?: ThemeToken } = {}): void {
  const indent = options.indent ?? "  ";
  const token = options.token ?? "fg.primary";
  const clean = sanitizeInline(value, 800);
  if (clean.length === 0) return;
  lines.push(...wrapPrefixedLines(
    [segment(indent, { fg: "fg.muted" })],
    clean,
    context,
    { fg: token },
  ));
}

function renderApprovalSummary(
  approval: PlanApprovalView | undefined,
  readiness: PlanReadinessView,
  digest: string | undefined,
  revision: number,
  context: BlockContext,
): StyledLine[] {
  const lines: StyledLine[] = [];
  const ready = readiness.ready;
  // Approval is digest-bound, not revision-bound. Progress/evidence updates can
  // advance the durable revision without changing the execution scope.
  const approvedScope = approval !== undefined && digest !== undefined && approval.digest === digest;
  const approved = readiness.ready && approvedScope;
  const executionBlocked = !ready && approvedScope;
  lines.push(fitLine("notice", [
    segment(approved ? "✓ Approved" : executionBlocked ? "! Approved scope blocked" : ready ? "○ Ready for approval" : "! Blocked", {
      fg: approved ? "accent.green" : ready && !executionBlocked ? "accent.cyan" : "accent.amber",
      bold: true,
    }),
    segment(approved || executionBlocked ? `  revision ${revision}` : "  Plan Contract", { fg: "fg.muted" }),
  ], context));
  if (digest !== undefined) {
    lines.push(fitLine("body", [segment("  digest: ", { fg: "fg.muted" }), segment(sanitizeInline(digest, 160), { fg: "accent.cyan" })], context));
  }
  if (approval !== undefined) {
    const detail = [
      approval.via !== undefined ? `via ${approval.via}` : undefined,
      approval.contextStrategy !== undefined ? approval.contextStrategy : undefined,
      approval.approvedAt !== undefined ? approval.approvedAt : undefined,
    ].filter((entry): entry is string => entry !== undefined).join(" · ");
    if (detail.length > 0) appendValue(lines, detail, context, { indent: "  ", token: "accent.green" });
  }
  if (!ready) {
    for (const blocker of readiness.blockers ?? ["Plan is not ready"]) {
      appendValue(lines, blocker, context, { indent: "  blocker: ", token: "accent.amber" });
    }
  }
  return lines;
}

/** Render only the document body (without approval metadata or the title). */
export function renderPlanDocument(
  document: PlanDocumentView,
  context: BlockContext,
  options: { readonly items?: readonly PlanItem[] } = {},
): StyledLine[] {
  const lines: StyledLine[] = [];
  appendLabel(lines, "Goal", context);
  appendValue(lines, document.goal, context);

  appendLabel(lines, "Context", context);
  if (document.context.length === 0) appendValue(lines, "(none recorded)", context, { token: "fg.muted" });
  for (const value of document.context) appendValue(lines, value, context);
  if ((document.assumptions?.length ?? 0) > 0) {
    appendLabel(lines, "Assumptions", context);
    for (const value of document.assumptions ?? []) appendValue(lines, value, context);
  }

  appendLabel(lines, "Critical files & anchors", context);
  if (document.criticalFiles.length === 0) appendValue(lines, "(none recorded)", context, { token: "accent.amber" });
  for (const file of document.criticalFiles) {
    const anchors = [
      ...(file.anchors ?? []),
      ...(file.anchor !== undefined ? [file.anchor] : []),
      ...(file.symbols ?? []),
    ];
    const suffix = [
      anchors.length > 0 ? ` · ${anchors.join(", ")}` : undefined,
      file.purpose !== undefined ? ` — ${file.purpose}` : undefined,
    ].filter((entry): entry is string => entry !== undefined).join("");
    appendValue(lines, `${file.path}${suffix}`, context, { token: "fg.primary" });
  }

  appendLabel(lines, "Approach", context);
  const items = options.items ?? [];
  if (items.length === 0) appendValue(lines, "(no approach steps)", context, { token: "fg.muted" });
  for (const [index, raw] of items.entries()) {
    const item = raw as PlanItemView;
    const kind = item.kind !== undefined ? `${item.kind} · ` : "";
    const marker = `${index + 1}. [${item.status}] ${kind}${item.text}`;
    appendValue(lines, marker, context, { indent: "  ", token: statusToken(item.status) });
    if (item.details !== undefined) appendValue(lines, item.details, context, { indent: "      ", token: "fg.muted" });
    if ((item.files?.length ?? 0) > 0) appendValue(lines, `files: ${item.files!.join(", ")}`, context, { indent: "      ", token: "fg.muted" });
    if ((item.symbols?.length ?? 0) > 0) appendValue(lines, `symbols: ${item.symbols!.join(", ")}`, context, { indent: "      ", token: "fg.muted" });
    if ((item.acceptanceCriteria?.length ?? 0) > 0) appendValue(lines, `acceptance: ${item.acceptanceCriteria!.join("; ")}`, context, { indent: "      ", token: "fg.muted" });
    if ((item.dependsOn?.length ?? 0) > 0) appendValue(lines, `depends on: ${item.dependsOn!.join(", ")}`, context, { indent: "      ", token: "fg.muted" });
    if ((item.commands?.length ?? 0) > 0) appendValue(lines, `commands: ${item.commands!.join(" && ")}`, context, { indent: "      ", token: "accent.cyan" });
  }

  appendLabel(lines, "Verification", context);
  if (document.verification.length === 0) appendValue(lines, "(none recorded)", context, { token: "accent.amber" });
  for (const check of document.verification) {
    const command = check.command !== undefined ? `$ ${check.command}` : check.description ?? "check";
    const expected = check.expected ?? check.expectedResult;
    const state = check.status !== undefined ? `[${check.status}] ` : "";
    appendValue(lines, `${state}${command}${expected !== undefined ? ` → ${expected}` : ""}`, context, {
      token: check.status === "failed" ? "accent.red" : check.status === "passed" ? "accent.green" : "fg.primary",
    });
    if (check.evidence !== undefined) appendValue(lines, `evidence: ${check.evidence}`, context, { indent: "      ", token: "fg.muted" });
  }

  appendLabel(lines, "External actions", context);
  if ((document.externalActions?.length ?? 0) === 0) appendValue(lines, "none declared", context, { token: "fg.muted" });
  for (const action of document.externalActions ?? []) {
    const target = [action.server, action.tool, action.action].filter((entry): entry is string => entry !== undefined).join("/") || "external action";
    const args = action.arguments === undefined ? undefined : Object.keys(action.arguments).join(", ");
    const detail = [action.reason, action.risk !== undefined ? `risk: ${action.risk}` : undefined, action.detail, args !== undefined ? `args: ${args}` : undefined]
      .filter((entry): entry is string => entry !== undefined).join(" — ");
    appendValue(lines, detail.length > 0 ? `${target} — ${detail}` : target, context, { token: "accent.amber" });
  }

  appendLabel(lines, "Risks", context);
  if (document.risks.length === 0) appendValue(lines, "none recorded", context, { token: "fg.muted" });
  for (const risk of document.risks) appendValue(lines, risk, context, { token: "accent.amber" });

  appendLabel(lines, "Rollback", context);
  if (document.rollback.length === 0) appendValue(lines, "none recorded", context, { token: "fg.muted" });
  for (const step of document.rollback) appendValue(lines, step, context, { token: "fg.primary" });
  return lines;
}

/** Render a complete Plan Contract including readiness and approval metadata. */
export function renderPlanContract(input: PlanContractRenderInput | PlanDocumentView, context: BlockContext): StyledLine[] {
  const root = record(input) ?? {};
  const document = documentFrom(input);
  const items = planItemsForInput(input as PlanContractRenderInput);
  const approval = planApprovalForInput(input as PlanContractRenderInput);
  const revision = typeof root.revision === "number"
    ? root.revision
    : typeof root.planRevision === "number" ? root.planRevision : 0;
  const readiness = planReadinessForInput(input as PlanContractRenderInput, document, items);
  const derivedDigest = currentPlanDigest(input, document, items);
  const readinessDigest = typeof readiness === "object" && typeof (readiness as unknown as Record<string, unknown>).digest === "string"
    ? (readiness as unknown as Record<string, unknown>).digest as string
    : undefined;
  // Never let an approval digest become the current scope identity merely
  // because the caller omitted a fresh readiness digest. Progress updates may
  // preserve approval, but edits to scope must render as unapproved.
  // Prefer the digest derived from the current raw contract whenever available;
  // caller-supplied display metadata can be stale after a Plan edit.
  const digest = derivedDigest ?? text(root.digest) ?? readinessDigest ?? approval?.digest;

  const lines: StyledLine[] = [
    fitLine("header", [segment(`Plan Contract${revision > 0 ? `  r${revision}` : ""}`, { fg: "fg.primary", bold: true })], context),
  ];
  if (document === undefined) {
    appendValue(lines, "No structured Plan Contract drafted.", context, { token: "fg.muted" });
  } else {
    lines.push(...renderPlanDocument(document, context, { items }));
  }
  lines.push(...renderApprovalSummary(approval, readiness, digest, revision, context));
  return lines;
}

/** Render approval metadata by itself for compact status/approval overlays. */
export function renderPlanApproval(
  approval: PlanApprovalView | undefined,
  context: BlockContext,
  options: { readonly readiness?: PlanReadinessView; readonly revision?: number; readonly digest?: string } = {},
): StyledLine[] {
  const revision = options.revision ?? approval?.revision ?? 0;
  const readiness = options.readiness ?? { ready: approval !== undefined };
  return renderApprovalSummary(approval, readiness, options.digest ?? approval?.digest, revision, context);
}

/**
 * Render the focused Plan approval picker used by the fullscreen TUI.
 *
 * This is deliberately separate from the permission approval card: a Plan choice
 * changes the durable approval/execution state, not a tool permission, so it must
 * not acquire permission-specific labels or semantics. The picker is intentionally
 * compact; the complete contract remains available in the Plan overlay.
 */
export function renderPlanApprovalPicker(
  input: PlanContractRenderInput | TodoListState,
  context: BlockContext,
  options: {
    readonly choices: readonly string[];
    readonly selected?: number;
    readonly readiness?: PlanReadinessView;
  },
): StyledLine[] {
  const root = record(input) ?? {};
  const document = documentFrom(input);
  const items = planItemsForInput(input as PlanContractRenderInput);
  const derivedReadiness = planReadinessForInput(input as PlanContractRenderInput, document, items);
  const readiness = options.readiness ?? derivedReadiness;
  const revision = typeof root.revision === "number"
    ? root.revision
    : typeof root.planRevision === "number" ? root.planRevision : 0;
  // Show the digest that will be recorded even before approval.  The focused
  // picker is the user's last review point; hiding the contract identity here
  // would make the approval UI less auditable than the Plan review overlay.
  const derivedDigest = currentPlanDigest(input, document, items);
  // Prefer the current scope digest over approval metadata: a stale approval
  // must never be presented as the digest of the draft currently on screen.
  // Prefer the digest derived from the current raw contract whenever available;
  // caller-supplied display metadata can be stale after a Plan edit.
  const digest = derivedDigest ?? text(root.digest) ?? readiness.digest ??
    planApprovalForInput(input as PlanContractRenderInput)?.digest;
  const choices = options.choices;
  const selected = choices.length === 0
    ? -1
    : Math.max(0, Math.min(choices.length - 1, options.selected ?? 0));
  const divider = context.capabilities.unicode ? "─" : "-";
  const lines: StyledLine[] = [
    fitLine("approval", [segment(divider.repeat(Math.max(12, context.columns)), { fg: "border.warm", dim: true })], context),
    fitLine("approval", [
      segment("  📋 ", { fg: "accent.cyan" }),
      segment("Plan ready", { fg: "accent.cyan", bold: true }),
      segment(`  r${revision}`, { fg: "fg.muted" }),
    ], context),
    fitLine("approval", [], context),
  ];
  if (document?.goal !== undefined) {
    lines.push(fitLine("approval", [
      segment("    Goal: ", { fg: "fg.muted" }),
      segment(sanitizeInline(document.goal, 240), { fg: "fg.primary", bold: true }),
    ], context));
  }
  lines.push(fitLine("approval", [
    segment("    Scope: ", { fg: "fg.muted" }),
    segment(`${items.length} step${items.length === 1 ? "" : "s"} · ${document?.criticalFiles.length ?? 0} file anchor${(document?.criticalFiles.length ?? 0) === 1 ? "" : "s"} · ${document?.verification.length ?? 0} verification check${(document?.verification.length ?? 0) === 1 ? "" : "s"}`, { fg: "fg.primary" }),
  ], context));
  if (digest !== undefined) {
    lines.push(fitLine("approval", [
      segment("    Digest: ", { fg: "fg.muted" }),
      segment(sanitizeInline(digest, 160), { fg: "accent.cyan" }),
    ], context));
  }
  if (!readiness.ready) {
    const blocker = readiness.blockers?.[0] ?? "Plan is not ready for approval";
    lines.push(fitLine("approval", [
      segment("    Blocked: ", { fg: "accent.amber" }),
      segment(sanitizeInline(blocker, 240), { fg: "accent.amber" }),
    ], context));
  }
  lines.push(fitLine("approval", [], context));
  lines.push(fitLine("approval", [segment("  What would you like to do?", { fg: "fg.primary", bold: true })], context));
  choices.forEach((choice, index) => {
    const active = index === selected;
    const cursor = active ? (context.capabilities.unicode ? "❯ " : "> ") : "  ";
    const bg = active ? "bg.task" as const : undefined;
    const style = active
      ? { fg: "fg.primary" as const, bold: true, ...(bg === undefined ? {} : { bg }) }
      : { fg: "fg.muted" as const };
    lines.push(fitLine("approval", [
      segment(`  ${cursor}`, { fg: "accent.cyan", bold: true, ...(bg === undefined ? {} : { bg }) }),
      segment(`${index + 1}. `, style),
      segment(sanitizeInline(choice, 180), style),
    ], context));
  });
  lines.push(fitLine("approval", [], context));
  lines.push(fitLine("approval", [
    segment("  Esc to cancel", { fg: "fg.muted", dim: true }),
    segment("  ·  ", { fg: "fg.muted", dim: true }),
    segment("Tab/↑↓: Move  Enter: Select", { fg: "fg.muted", italic: true }),
  ], context));
  lines.push(fitLine("approval", [segment(divider.repeat(Math.max(12, context.columns)), { fg: "border.warm", dim: true })], context));
  return lines;
}

/**
 * Render the compact TODO projection used once a Plan has been accepted.
 *
 * Keeping this separate from `renderPlanContract` is intentional: the Plan review
 * overlay retains the full contract, while the normal conversation and TODO view
 * should not repeat all of its detail after approval.
 */
export function renderNormalTodoList(
  input: {
    readonly items: readonly PlanItem[];
    readonly revision?: number;
    readonly approvedRevision?: number;
  },
  context: BlockContext,
): StyledLine[] {
  const done = input.items.filter((item) => item.status === "done").length;
  const lines: StyledLine[] = [
    fitLine("header", [segment(`Todo ${done}/${input.items.length} done`, { fg: "fg.primary", bold: true })], context),
  ];
  if (input.approvedRevision !== undefined) {
    lines.push(fitLine("body", [segment(`Approved revision ${input.approvedRevision}`, { fg: "accent.green" })], context));
  }
  if (input.items.length === 0) {
    lines.push(fitLine("body", [segment("No TODO items.", { fg: "fg.muted" })], context));
    return lines;
  }
  for (const item of input.items) {
    const token = statusToken(item.status);
    lines.push(fitLine("body", [
      segment(`${todoBox(item.status)} `, { fg: token }),
      segment(sanitizeInline(item.text, Math.max(1, context.columns - 10)), { fg: item.status === "done" ? "fg.muted" : "fg.primary" }),
    ], context));
    if (item.status === "blocked" && item.blockedReason !== undefined) {
      lines.push(fitLine("body", [segment(`    blocked: ${sanitizeInline(item.blockedReason, Math.max(1, context.columns - 12))}`, { fg: "accent.amber" })], context));
    }
    if (item.status === "done" && item.evidence !== undefined && item.evidence.length > 0) {
      lines.push(fitLine("body", [segment(`    evidence: ${item.evidence.length}`, { fg: "fg.muted" })], context));
    }
  }
  return lines;
}

/** Below this width the "full contract" hint gets its own line. */
const PLAN_SUMMARY_INLINE_HINT_COLUMNS = 60;

/** How the full contract is reached from the collapsed timeline projection. */
const PLAN_SUMMARY_HINT = "Ctrl+X P for full contract";

/** Blockers shown inline before the summary falls back to a "+N more" count. */
const PLAN_SUMMARY_MAX_BLOCKERS = 2;

/**
 * Render the collapsed Plan projection used by the conversation timeline.
 *
 * A Plan Contract is a document, and repainting all of it on every frame buried
 * the conversation it was supposed to describe. This keeps what a reader has to
 * act on — the goal, step progress, readiness, and why execution is blocked —
 * and defers the rest to the Plan/TODO overlay, which still renders in full via
 * `renderPlanContract`.
 *
 * The status vocabulary is deliberately lifted from `renderApprovalSummary` so
 * the collapsed and full views can never disagree about whether a scope is
 * approved. Blockers are never hidden: a user must not be stopped without being
 * told why, so they survive collapse while the prose sections do not.
 */
export function renderPlanSummary(
  input: PlanContractRenderInput | PlanDocumentView,
  context: BlockContext,
): StyledLine[] {
  const root = record(input) ?? {};
  const document = documentFrom(input);
  const items = planItemsForInput(input as PlanContractRenderInput);
  const approval = planApprovalForInput(input as PlanContractRenderInput);
  const readiness = planReadinessForInput(input as PlanContractRenderInput, document, items);
  const revision = typeof root.revision === "number"
    ? root.revision
    : typeof root.planRevision === "number" ? root.planRevision : 0;
  const digest = currentPlanDigest(input, document, items) ?? text(root.digest) ?? readiness.digest;

  // Same three-way state as the full contract's approval summary.
  const approvedScope = approval !== undefined && digest !== undefined && approval.digest === digest;
  const ready = readiness.ready;
  const approved = ready && approvedScope;
  const executionBlocked = !ready && approvedScope;
  const status = approved
    ? "✓ Approved"
    : executionBlocked
      ? "! Approved scope blocked"
      : ready ? "○ Ready for approval" : "! Blocked";
  const statusStyle: ThemeToken = approved
    ? "accent.green"
    : ready && !executionBlocked ? "accent.cyan" : "accent.amber";

  const heading: Segment[] = [
    segment("Plan", { fg: "fg.primary", bold: true }),
    segment(revision > 0 ? `  r${revision}` : "", { fg: "fg.muted" }),
    segment("  ·  ", { fg: "fg.muted" }),
    segment(status, { fg: statusStyle, bold: true }),
  ];
  const inlineHint = context.columns >= PLAN_SUMMARY_INLINE_HINT_COLUMNS;
  if (inlineHint) {
    const used = heading.reduce((total, part) => total + stringWidth(part.text), 0);
    const gap = context.columns - used - stringWidth(PLAN_SUMMARY_HINT);
    if (gap >= 2) {
      heading.push(segment(" ".repeat(gap), {}));
      heading.push(segment(PLAN_SUMMARY_HINT, { fg: "fg.muted", dim: true }));
    }
  }
  const lines: StyledLine[] = [fitLine("header", heading, context)];
  if (!inlineHint) {
    lines.push(fitLine("body", [segment(`  ${PLAN_SUMMARY_HINT}`, { fg: "fg.muted", dim: true })], context));
  }

  if (document !== undefined && document.goal.trim().length > 0) {
    lines.push(...wrapPrefixedLines(
      [segment("  Goal: ", { fg: "fg.muted" })],
      sanitizeInline(document.goal, 400),
      context,
      { fg: "fg.primary" },
    ));
  }

  const done = items.filter((item) => item.status === "done").length;
  const blocked = items.filter((item) => item.status === "blocked").length;
  const active = items.filter((item) => item.status === "active").length;
  const progress = [
    `${done}/${items.length} done`,
    active > 0 ? `${active} active` : undefined,
    blocked > 0 ? `${blocked} blocked` : undefined,
  ].filter((entry): entry is string => entry !== undefined).join(" · ");
  lines.push(fitLine("body", [
    segment("  Steps: ", { fg: "fg.muted" }),
    segment(progress, { fg: blocked > 0 ? "accent.amber" : "fg.primary" }),
  ], context));

  if (!ready) {
    const blockers = readiness.blockers ?? ["Plan is not ready"];
    for (const blocker of blockers.slice(0, PLAN_SUMMARY_MAX_BLOCKERS)) {
      lines.push(...wrapPrefixedLines(
        [segment("  blocker: ", { fg: "fg.muted" })],
        sanitizeInline(blocker, 400),
        context,
        { fg: "accent.amber" },
      ));
    }
    const hidden = blockers.length - PLAN_SUMMARY_MAX_BLOCKERS;
    if (hidden > 0) {
      lines.push(fitLine("body", [
        segment(`  +${hidden} more blocker${hidden === 1 ? "" : "s"}`, { fg: "accent.amber", dim: true }),
      ], context));
    }
  }

  if (digest !== undefined) {
    // The short form is enough to tell two scopes apart at a glance; the full
    // 64-character identity stays available in the overlay and the picker.
    lines.push(fitLine("body", [segment(`  ${shortPlanDigest(digest)}`, { fg: "accent.cyan", dim: true })], context));
  }
  return lines;
}

/** `plan-sha256-<8 hex>` — the auditable prefix, not the whole hash. */
function shortPlanDigest(digest: string): string {
  const match = /^(plan-sha256-)([0-9a-f]{8})[0-9a-f]*$/u.exec(digest);
  return match !== null ? `${match[1]}${match[2]}` : sanitizeInline(digest, 24);
}

/**
 * Legacy TODO overlay. A digest-valid approval intentionally selects the compact
 * projection; stale approval metadata still renders the full contract so it is
 * not mistaken for an accepted execution scope.
 */
export function renderTodoList(state: TodoListState, context: BlockContext): StyledLine[] {
  const document = documentFrom(state);
  let digest: string | undefined;
  try {
    digest = planDigest(state.document, state.items);
  } catch {
    digest = undefined;
  }
  const approved = state.approval !== undefined && digest !== undefined && state.approval.digest === digest;
  const readiness = document === undefined ? undefined : computePlanReadiness(document, state.items);
  // A digest-valid approval is still useful history, but a blocked execution
  // must render as a contract so it cannot look like an ordinary approved TODO.
  if (document !== undefined && (!approved || readiness?.ready !== true)) {
    return renderPlanContract({
      document: state.document ?? document,
      items: state.items,
      revision: state.revision,
      ...(readiness === undefined ? {} : { readiness }),
      ...(digest === undefined ? {} : { digest }),
      ...(state.approval === undefined ? {} : { approval: state.approval }),
      ...(state.approvedRevision === undefined ? {} : { approvedRevision: state.approvedRevision }),
    }, context);
  }
  return renderNormalTodoList({ items: state.items, revision: state.revision, ...(state.approvedRevision === undefined ? {} : { approvedRevision: state.approvedRevision }) }, context);
}

export function todoToken(status: PlanItem["status"]): ThemeToken {
  return statusToken(status);
}
