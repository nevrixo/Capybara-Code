/**
 * Context compaction — PRD §18.9, §18.10, AC-34.
 *
 * §18.9 is explicit that the original events are never deleted: compaction only
 * replaces what goes into the *model input*. The journal remains the source of
 * truth, so rollback, export, and replay all still see the full history.
 */

import { createHash } from "node:crypto";
import type { SessionViewModel, TimelineItem } from "./reducer.ts";

/** §18.9 compaction trigger conditions. */
export type CompactionTrigger =
  | "projected_pressure"
  | "emergency_pressure"
  | "tool_output"
  | "manual"
  | "provider_context_error"
  /** Legacy journal values remain readable and replayable. */
  | "soft_budget_70"
  | "tool_output_accumulation"
  | "user_requested"
  | "provider_context_error_expected";

export const COMPACTION_SOFT_BUDGET_RATIO = 0.7;
export const COMPACTION_EMERGENCY_RATIO = 0.9;

/**
 * A pointer to content that was too large to keep inline (§18.17).
 *
 * The handle, not the content, goes into the prompt. The model can still reach
 * the full text through the artifact store if it decides it needs it, which is
 * the difference between compaction and loss.
 */
export interface SummaryHandle {
  readonly label: string;
  readonly bytes: number;
  readonly artifactId?: string;
  /** One line describing what is inside, so the model can judge whether to open it. */
  readonly hint: string;
}

/**
 * One tier of the compacted state.
 *
 * Flat extractive summarization has a failure mode: as a session grows, every
 * category grows with it, and the summary itself becomes the thing that exceeds
 * the budget. A group instead keeps the highest-ranked entries verbatim, folds the
 * rest into a count, and spills anything individually oversized — so the group's
 * cost is bounded no matter how long the session runs.
 */
export interface CompactGroup {
  readonly heading: string;
  /** Highest-ranked entries, kept verbatim. */
  readonly retained: string[];
  /** How many lower-ranked entries were folded into a count line. */
  readonly foldedCount: number;
  /** Entries moved to the artifact store, referenced by handle. */
  readonly handles: SummaryHandle[];
}

/** §18.9 hierarchy: what was decided, what changed, what is still open. */
export interface CompactHierarchy {
  readonly decisions: CompactGroup;
  readonly diffSummary: CompactGroup;
  readonly unresolved: CompactGroup;
}

/** A reflection the kernel reached, as compaction needs it (§11.2). */
export interface CompactionReflection {
  readonly toolId: string;
  readonly category: string;
  readonly rootCause: string;
  readonly correctiveAction: string;
  readonly paths?: readonly string[];
}

export interface CompactionOptions {
  /** Desired upper bound for the rendered compact state. */
  readonly targetTokens?: number;
  /** Exact candidate measurement when the caller already compiled the request. */
  readonly currentTokens?: number;
  /** Monotonic capsule generation; defaults to one plus the source generation. */
  readonly generation?: number;
  /** Exact evidence handles pinned into the capsule. */
  readonly evidenceRefs?: readonly string[];
  /**
   * Reflections from the current turn, newest last. These rank above every other
   * unresolved item: an approach already tried and understood is the single most
   * expensive thing for a resumed turn to rediscover.
   */
  readonly reflections?: readonly CompactionReflection[];
  /** Entries kept verbatim per group before the rest is folded into a count. */
  readonly retainPerGroup?: number;
  /** An entry longer than this is spilled instead of kept inline. */
  readonly maxItemChars?: number;
  /** Hands an oversized entry to the artifact store. */
  readonly spill?: (label: string, content: string) => SummaryHandle | undefined;
  /** Latest authoritative goal contract; deterministic fallback never guesses older intent. */
  readonly currentGoal?: string;
  /** Explicit user constraints already extracted into the source bundle. */
  readonly userConstraints?: readonly string[];
}

export const DEFAULT_RETAIN_PER_GROUP = 6;
export const DEFAULT_MAX_ITEM_CHARS = 600;

export interface CompactTodoSnapshot {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "active" | "done" | "blocked" | "skipped";
  readonly blockedReason?: string;
}

export interface CompactionCapsule {
  readonly id: string;
  readonly generation: number;
  readonly sourceRange: { readonly firstSequence: number; readonly lastSequence: number };
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly mutations: ReadonlyArray<{ path: string; summary: string }>;
  readonly verification: readonly string[];
  readonly unresolved: readonly string[];
  readonly todoSnapshot: readonly CompactTodoSnapshot[];
  readonly evidenceRefs: readonly string[];
  readonly tokenCount: number;
  readonly digest: string;
  readonly narrativeHint?: string;
}

export interface CompactState {
  userGoal: string;
  decisions: string[];
  constraints: string[];
  filesRead: Array<{ path: string; why: string }>;
  filesChanged: Array<{ path: string; summary: string }>;
  testEvidence: string[];
  taskResults: string[];
  unresolved: string[];
  nextAction: string;
  readonly todoSnapshot: CompactTodoSnapshot[];
  readonly evidenceRefs: string[];
  /** §18.9 hierarchical view, which is what `renderCompactState` actually emits. */
  hierarchy: CompactHierarchy;
  /** Paths named by recent failures, for the §18.4 recent-failure weight. */
  failurePaths: string[];
}

export interface CompactionResult {
  readonly state: CompactState;
  readonly trigger: CompactionTrigger;
  readonly tokensBefore: number;
  /**
   * Size of the rendered L5 capsule.
   *
   * This is NOT the size of the next request. `tokensBefore` measures the whole
   * projected prompt, so presenting the two as a before/after pair claims a
   * reduction that compaction cannot deliver on its own: the fixed layers (L0-L4,
   * L6, tool schemas) are rebuilt every compile and are untouched here. Retained
   * for journal compatibility; prefer `capsuleTokens` when the capsule is what
   * you mean.
   * @deprecated Never use this field as compiled context usage.
   */
  readonly tokensAfter: number;
  /** Size of the rendered capsule alone. Never a prompt size. */
  readonly capsuleTokens: number;
  readonly eventsSummarized: number;
  readonly capsule: CompactionCapsule;
  /** §18.9: the journal is untouched. */
  readonly journalPreserved: true;
}

export function shouldCompact(
  model: SessionViewModel,
  options: {
    userRequested?: boolean;
    providerContextErrorExpected?: boolean;
    /**
     * Runtime-supplied soft-budget ratio (token saving). Defaults to the fixed
     * 0.7 so an unchanged product behaves exactly as before.
     */
    softBudgetRatio?: number;
    /** Adaptive candidate-request inputs, when the runtime has compiled a pack. */
    projectedTokens?: number;
    requiredFreeTokens?: number;
    emergencyRatio?: number;
  } = {},
): CompactionTrigger | undefined {
  if (options.userRequested === true) return "user_requested";
  if (options.providerContextErrorExpected === true) return "provider_context_error_expected";
  if (options.projectedTokens !== undefined) {
    const budget = Math.max(0, model.contextBudgetTokens);
    const projected = Math.max(0, options.projectedTokens);
    const requiredFree = Math.max(0, options.requiredFreeTokens ?? 0);
    const emergencyRatio = options.emergencyRatio !== undefined && options.emergencyRatio > 0 && options.emergencyRatio <= 1
      ? options.emergencyRatio
      : COMPACTION_EMERGENCY_RATIO;
    if (budget > 0 && model.contextUsedTokens / budget >= emergencyRatio) return "emergency_pressure";
    if (budget > 0 && (projected > budget || projected + requiredFree > budget)) return "projected_pressure";
    return undefined;
  }
  const ratio = Number.isFinite(options.softBudgetRatio) &&
    (options.softBudgetRatio as number) > 0 &&
    (options.softBudgetRatio as number) <= 1
    ? (options.softBudgetRatio as number)
    : COMPACTION_SOFT_BUDGET_RATIO;
  if (
    model.contextBudgetTokens > 0 &&
    model.contextUsedTokens / model.contextBudgetTokens >= ratio
  ) {
    return "soft_budget_70";
  }
  // Tool output accumulation: many completed tool calls with large summaries.
  const toolBytes = model.timeline
    .filter((i) => i.type === "tool")
    .reduce((sum, i) => sum + (i.type === "tool" ? (i.summary?.length ?? 0) : 0), 0);
  if (toolBytes > 128 * 1024) return "tool_output_accumulation";
  return undefined;
}

/**
 * Build the compact state from the timeline. Deliberately extractive rather than
 * generative: §18.9 requires decisions, files, tests, and unresolved items to
 * survive compaction, and a deterministic extraction cannot hallucinate them.
 */
export function compactDeterministicFallback(
  model: SessionViewModel,
  trigger: CompactionTrigger,
  estimateTokens: (text: string) => number,
  options: CompactionOptions = {},
): CompactionResult {
  const userMessages = model.timeline.filter((i) => i.type === "user");
  const userGoal = options.currentGoal ??
    (userMessages.length > 0 && userMessages.at(-1)?.type === "user"
      ? userMessages.at(-1)!.text
      : "");

  const decisions: string[] = [];
  const filesRead: Array<{ path: string; why: string }> = [];
  const testEvidence: string[] = [];
  const taskResults: string[] = [];
  const unresolved: string[] = [];

  for (const item of model.timeline) {
    switch (item.type) {
      case "commentary": {
        // Planning commentary carries the decision trail (§10.7).
        if (item.variant === "commentary" && item.text.length > 0) {
          decisions.push(item.text);
        }
        break;
      }
      case "tool": {
        if (item.toolId.startsWith("fs.read") || item.toolId === "fs.search") {
          const path = extractPath(item.argumentsSummary);
          if (path) filesRead.push({ path, why: item.summary ?? "inspected" });
        }
        if (item.toolId === "process.run" || item.toolId === "shell.run") {
          if (item.summary) {
            testEvidence.push(
              `${item.argumentsSummary}: ${item.status === "succeeded" ? "passed" : "failed"} — ${item.summary}`,
            );
          }
        }
        if (item.status === "failed") {
          unresolved.push(`${item.toolId} failed: ${item.summary ?? item.errorCode ?? "unknown"}`);
        }
        break;
      }
      case "task": {
        if (item.summary) {
          taskResults.push(`${item.role}/${item.title} (${item.state}): ${item.summary}`);
        }
        if (item.state === "failed" || item.state === "blocked") {
          unresolved.push(`task ${item.title} ended ${item.state}`);
        }
        break;
      }
      case "approval": {
        if (item.decision === "deny") {
          unresolved.push(`denied: ${item.display}${item.decisionReason ? ` (${item.decisionReason})` : ""}`);
        }
        break;
      }
      case "final": {
        if (item.report) {
          unresolved.push(...item.report.risks);
          for (const v of item.report.verification) {
            testEvidence.push(`${v.command ?? "verification"}: ${v.status} — ${v.evidence}`);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const filesChanged = [...model.changedFiles.entries()].map(([path, counts]) => ({
    path,
    summary: `+${counts.additions} -${counts.deletions}`,
  }));

  const todoItems = model.todo.items.length > 0 ? model.todo.items : model.plan;
  const constraints = [
    ...(options.userConstraints ?? []),
    ...todoItems
      .filter((item) => item.status === "blocked")
      .map((item) => `blocked: ${item.text}`),
  ];

  const nextAction =
    todoItems.find((item) => item.status === "active")?.text ??
    todoItems.find((item) => item.status === "pending")?.text ??
    (unresolved.length > 0 ? "resolve outstanding failures" : "await user direction");
  const todoSnapshot: CompactTodoSnapshot[] = todoItems.map((item) => ({
    id: item.id,
    text: item.text,
    status: item.status,
    ...(item.blockedReason === undefined ? {} : { blockedReason: item.blockedReason }),
  }));
  const evidenceRefs = dedupe([
    ...(options.evidenceRefs ?? []),
    ...model.timeline.flatMap((item) => item.type === "tool" ? item.artifacts ?? [] : []),
  ]);

  // ---- Reflections rank above everything else that is still open (§11.2) ----
  const reflections = options.reflections ?? [];
  const reflectionLines = reflections.map(
    (reflection) =>
      `${reflection.toolId} failed (${reflection.category}): ${reflection.rootCause} — next: ${reflection.correctiveAction}`,
  );
  const failurePaths = dedupe(reflections.flatMap((reflection) => [...(reflection.paths ?? [])]));

  const dedupedDecisions = dedupe(decisions);
  const dedupedUnresolved = dedupe(unresolved);

  const hierarchy: CompactHierarchy = {
    // Most recent decision first: it is the one the next step builds on.
    decisions: buildGroup("Decisions", [...dedupedDecisions].reverse(), options),
    diffSummary: buildGroup(
      "Diff summary",
      filesChanged.map((file) => `${file.path} (${file.summary})`),
      options,
    ),
    unresolved: buildGroup(
      "Unresolved",
      [...reflectionLines].reverse().concat([...dedupedUnresolved].reverse()),
      options,
    ),
  };

  const state: CompactState = {
    userGoal,
    decisions: dedupedDecisions.slice(-12),
    constraints: dedupe(constraints),
    filesRead: dedupeBy(filesRead, (f) => f.path).slice(-24),
    filesChanged,
    testEvidence: dedupe(testEvidence).slice(-12),
    taskResults: dedupe(taskResults),
    unresolved: dedupe([...reflectionLines, ...dedupedUnresolved]),
    // An explicit active plan step wins. Otherwise, if the loop is mid
    // self-correction, the correction *is* the next action — carrying a stale
    // pending step there would point a resumed turn back at the thing that failed.
    nextAction:
      todoItems.some((item) => item.status === "active")
        ? nextAction
        : (reflections[reflections.length - 1]?.correctiveAction ?? nextAction),
    todoSnapshot,
    evidenceRefs,
    hierarchy,
    failurePaths,
  };

  const boundedState = boundCompactState(state, estimateTokens, options.targetTokens);
  const tokensBefore = options.currentTokens !== undefined && Number.isFinite(options.currentTokens)
    ? Math.max(0, Math.floor(options.currentTokens))
    : model.contextUsedTokens;
  const tokensAfter = estimateTokens(renderCompactState(boundedState));
  const sequences = model.timeline.map((item) => item.sequence).filter((sequence) => Number.isSafeInteger(sequence));
  const sourceRange = {
    firstSequence: sequences.length > 0 ? Math.min(...sequences) : 0,
    lastSequence: sequences.length > 0 ? Math.max(...sequences) : 0,
  };
  const generation = Math.max(1, Math.floor(options.generation ?? model.contextGeneration + 1));
  const capsulePayload = {
    generation,
    sourceRange,
    goal: boundedState.userGoal,
    decisions: boundedState.decisions,
    mutations: boundedState.filesChanged,
    verification: boundedState.testEvidence,
    unresolved: boundedState.unresolved,
    todoSnapshot: boundedState.todoSnapshot,
    evidenceRefs: boundedState.evidenceRefs,
  };
  const digest = createHash("sha256").update(JSON.stringify(capsulePayload), "utf8").digest("hex");
  const capsule: CompactionCapsule = {
    id: `capsule-${generation}-${digest.slice(0, 16)}`,
    ...capsulePayload,
    tokenCount: tokensAfter,
    digest,
  };

  return {
    state: boundedState,
    trigger,
    tokensBefore,
    tokensAfter,
    capsuleTokens: tokensAfter,
    eventsSummarized: model.timeline.length,
    capsule,
    journalPreserved: true,
  };
}

/** @deprecated Use compactDeterministicFallback only at the emergency boundary. */
export const compact = compactDeterministicFallback;

/** Merge adjacent capsules without reopening their source timeline ranges. */
export function mergeCompactionCapsules(
  capsules: readonly CompactionCapsule[],
  generation = Math.max(0, ...capsules.map((capsule) => capsule.generation)) + 1,
): CompactionCapsule | undefined {
  if (capsules.length === 0) return undefined;
  const ordered = [...capsules].sort((left, right) => left.generation - right.generation || left.sourceRange.firstSequence - right.sourceRange.firstSequence);
  const latestTodo = new Map<string, CompactTodoSnapshot>();
  const mutations = new Map<string, { path: string; summary: string }>();
  for (const capsule of ordered) {
    for (const item of capsule.todoSnapshot) latestTodo.set(item.id, item);
    for (const mutation of capsule.mutations) mutations.set(mutation.path, mutation);
  }
  const payload = {
    generation,
    sourceRange: {
      firstSequence: Math.min(...ordered.map((capsule) => capsule.sourceRange.firstSequence)),
      lastSequence: Math.max(...ordered.map((capsule) => capsule.sourceRange.lastSequence)),
    },
    goal: ordered.find((capsule) => capsule.goal.length > 0)?.goal ?? "",
    decisions: dedupe(ordered.flatMap((capsule) => [...capsule.decisions])).slice(-24),
    mutations: [...mutations.values()],
    verification: dedupe(ordered.flatMap((capsule) => [...capsule.verification])).slice(-24),
    unresolved: dedupe(ordered.flatMap((capsule) => [...capsule.unresolved])).slice(-24),
    todoSnapshot: [...latestTodo.values()],
    evidenceRefs: dedupe(ordered.flatMap((capsule) => [...capsule.evidenceRefs])),
  };
  const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return {
    id: `capsule-${generation}-${digest.slice(0, 16)}`,
    ...payload,
    tokenCount: estimateTokens(renderMergedCapsule(payload)),
    digest,
  };
}

function renderMergedCapsule(payload: Omit<CompactionCapsule, "id" | "tokenCount" | "digest" | "narrativeHint">): string {
  return JSON.stringify(payload);
}

/** Reduce optional historical prose until a requested target is met. Pinned state stays. */
function boundCompactState(
  state: CompactState,
  estimateTokens: (text: string) => number,
  targetTokens: number | undefined,
): CompactState {
  if (targetTokens === undefined || !Number.isFinite(targetTokens) || targetTokens <= 0) return state;
  if (estimateTokens(renderCompactState(state)) <= targetTokens) return state;
  const target = Math.max(1_024, Math.floor(targetTokens));
  for (const retain of [3, 2, 1, 0]) {
    const candidate: CompactState = {
      ...state,
      decisions: state.decisions.slice(-retain),
      filesRead: state.filesRead.slice(-Math.max(2, retain * 2)),
      testEvidence: state.testEvidence.slice(-Math.max(2, retain * 2)),
      taskResults: state.taskResults.slice(-retain),
      unresolved: state.unresolved.slice(-Math.max(2, retain * 2)),
      hierarchy: {
        decisions: buildGroup("Decisions", state.decisions.slice(-retain), { retainPerGroup: retain, maxItemChars: 240 }),
        diffSummary: buildGroup("Diff summary", state.filesChanged.map((file) => `${file.path} (${file.summary})`), { retainPerGroup: Math.max(1, retain), maxItemChars: 240 }),
        unresolved: buildGroup("Unresolved", state.unresolved.slice(-Math.max(2, retain * 2)), { retainPerGroup: Math.max(1, retain), maxItemChars: 240 }),
      },
    };
    if (estimateTokens(renderCompactState(candidate)) <= target) return candidate;
  }
  // Every group is now empty and the target is still missed, so what remains is
  // pinned state — and `userGoal` is the only unbounded field among it. A long
  // first message otherwise floored every compaction at the same size forever,
  // making the capsule incompressible for the life of the session.
  const goalBudgetChars = Math.max(240, target * 2);
  const floored: CompactState = {
    ...state,
    decisions: [],
    filesRead: [],
    testEvidence: [],
    taskResults: [],
    unresolved: state.unresolved.slice(-2),
    userGoal: state.userGoal.length <= goalBudgetChars
      ? state.userGoal
      : `${state.userGoal.slice(0, goalBudgetChars)} …[truncated ${state.userGoal.length - goalBudgetChars} chars]`,
    hierarchy: {
      decisions: buildGroup("Decisions", [], { retainPerGroup: 0, maxItemChars: 240 }),
      diffSummary: buildGroup("Diff summary", state.filesChanged.map((file) => `${file.path} (${file.summary})`), { retainPerGroup: 1, maxItemChars: 240 }),
      unresolved: buildGroup("Unresolved", state.unresolved.slice(-2), { retainPerGroup: 1, maxItemChars: 240 }),
    },
  };
  // Return the floored candidate whether or not it met the target: it is never
  // larger than the input, and returning the unbounded original discarded the
  // reduction that was already achieved.
  return floored;
}

/**
 * Build one bounded tier from a ranked list (§18.9).
 *
 * `ranked` must already be ordered most-important-first; the ranking decision
 * belongs to the caller, which knows whether recency or severity ranks higher for
 * that group.
 */
export function buildGroup(
  heading: string,
  ranked: readonly string[],
  options: CompactionOptions = {},
): CompactGroup {
  const retainCount = options.retainPerGroup ?? DEFAULT_RETAIN_PER_GROUP;
  const maxItemChars = options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS;
  const handles: SummaryHandle[] = [];
  const inline: string[] = [];

  for (const item of ranked) {
    if (item.length <= maxItemChars) {
      inline.push(item);
      continue;
    }
    const label = `${slugify(heading)}-${handles.length + 1}.txt`;
    const handle = options.spill?.(label, item);
    if (handle !== undefined) {
      handles.push(handle);
      continue;
    }
    // No artifact store available: truncate rather than pay for the whole entry.
    // Losing the tail is better than letting one entry consume the group.
    inline.push(`${item.slice(0, maxItemChars)} …[truncated ${item.length - maxItemChars} chars]`);
  }

  const retained = inline.slice(0, retainCount);
  return {
    heading,
    retained,
    foldedCount: Math.max(0, inline.length - retained.length),
    handles,
  };
}

function renderGroup(group: CompactGroup): string[] {
  if (group.retained.length === 0 && group.handles.length === 0 && group.foldedCount === 0) {
    return [];
  }
  const lines = [`\n## ${group.heading}`];
  for (const item of group.retained) lines.push(`- ${item}`);
  if (group.foldedCount > 0) {
    lines.push(`- … ${group.foldedCount} earlier entr${group.foldedCount === 1 ? "y" : "ies"} omitted`);
  }
  for (const handle of group.handles) {
    const artifact = handle.artifactId !== undefined ? ` → ${handle.artifactId}` : "";
    lines.push(`- ${handle.label} (${handle.bytes} bytes)${artifact}: ${handle.hint}`);
  }
  return lines;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The prompt-facing rendering of the compact state (context layer L5). */
export function renderCompactState(state: CompactState): string {
  const lines: string[] = ["# Session state (compacted)"];
  if (state.userGoal) lines.push(`\n## Goal\n${state.userGoal}`);

  // The three hierarchy tiers are bounded; the remaining sections are naturally
  // small (constraints, verification, delegated results) and stay flat.
  lines.push(...renderGroup(state.hierarchy.decisions));

  if (state.constraints.length > 0) {
    lines.push(`\n## Constraints\n${state.constraints.map((c) => `- ${c}`).join("\n")}`);
  }
  if (state.filesRead.length > 0) {
    lines.push(
      `\n## Files inspected\n${state.filesRead.map((f) => `- ${f.path} — ${f.why}`).join("\n")}`,
    );
  }

  lines.push(...renderGroup(state.hierarchy.diffSummary));

  if (state.testEvidence.length > 0) {
    lines.push(`\n## Verification\n${state.testEvidence.map((t) => `- ${t}`).join("\n")}`);
  }
  if (state.taskResults.length > 0) {
    lines.push(`\n## Delegated results\n${state.taskResults.map((t) => `- ${t}`).join("\n")}`);
  }

  lines.push(...renderGroup(state.hierarchy.unresolved));

  if (state.todoSnapshot.length > 0) {
    lines.push(`\n## TODO snapshot\n${state.todoSnapshot.map((item) => `- [${item.status}] ${item.id}: ${item.text}${item.blockedReason === undefined ? "" : ` — ${item.blockedReason}`}`).join("\n")}`);
  }
  if (state.evidenceRefs.length > 0) {
    lines.push(`\n## Exact evidence\n${state.evidenceRefs.map((ref) => `- ${ref}`).join("\n")}`);
  }
  if (state.failurePaths.length > 0) {
    lines.push(
      `\n## Files implicated by failures\n${state.failurePaths.map((p) => `- ${p}`).join("\n")}`,
    );
  }

  lines.push(`\n## Next action\n${state.nextAction}`);
  return lines.join("\n");
}

/** §18.10 context inspector rows. Reports presence of reasoning items, never
 *  their contents. */
export interface ContextInspectorRow {
  layer: string;
  label: string;
  estimatedTokens: number;
  detail: string;
}

export interface ContextInspectorView {
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly percent: number;
  readonly rows: ContextInspectorRow[];
  readonly activeSkills: Array<{ name: string; version: string; source: string }>;
  readonly activeToolSchemas: string[];
  readonly reasoningItemsPresent: boolean;
  readonly cachedPrefixFingerprint?: string;
  readonly excludedLargeOutputs: Array<{ label: string; bytes: number; artifactId: string }>;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function extractPath(argumentsSummary: string): string | undefined {
  const match = /path=([^\s]+)/.exec(argumentsSummary);
  if (match?.[1]) return match[1];
  const query = /query=([^\s]+)/.exec(argumentsSummary);
  return query?.[1];
}

/**
 * Rough token estimate. §10.10's percentages are a product surface, not a
 * billing figure, so a deterministic character-based heuristic is preferable to
 * a heavyweight tokenizer: it never disagrees between runs.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let tokens = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    // CJK and emoji cost roughly one token per character; Latin text averages
    // closer to four characters per token.
    tokens += cp > 0x2e80 ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}

/** Timeline items that survive into the model input after compaction. */
export function retainedForPrompt(timeline: readonly TimelineItem[]): TimelineItem[] {
  // Only the latest user message and final answer are replayed verbatim; the
  // rest is represented by the compact state. Filter the original order so the
  // provider sees the user request before the answer it produced.
  const lastUser = [...timeline].reverse().find((i) => i.type === "user");
  const lastFinal = [...timeline].reverse().find((i) => i.type === "final");
  return timeline.filter((item) => item === lastUser || item === lastFinal);
}
