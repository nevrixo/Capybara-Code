/**
 * Context compaction — PRD §18.9, §18.10, AC-34.
 *
 * §18.9 is explicit that the original events are never deleted: compaction only
 * replaces what goes into the *model input*. The journal remains the source of
 * truth, so rollback, export, and replay all still see the full history.
 */

import type { SessionViewModel, TimelineItem } from "./reducer.ts";

/** §18.9 compaction trigger conditions. */
export type CompactionTrigger =
  | "soft_budget_70"
  | "tool_output_accumulation"
  | "user_requested"
  | "provider_context_error_expected";

export const COMPACTION_SOFT_BUDGET_RATIO = 0.7;

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
}

export const DEFAULT_RETAIN_PER_GROUP = 6;
export const DEFAULT_MAX_ITEM_CHARS = 600;

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
  /** §18.9 hierarchical view, which is what `renderCompactState` actually emits. */
  hierarchy: CompactHierarchy;
  /** Paths named by recent failures, for the §18.4 recent-failure weight. */
  failurePaths: string[];
}

export interface CompactionResult {
  readonly state: CompactState;
  readonly trigger: CompactionTrigger;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly eventsSummarized: number;
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
  } = {},
): CompactionTrigger | undefined {
  if (options.userRequested === true) return "user_requested";
  if (options.providerContextErrorExpected === true) return "provider_context_error_expected";
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
export function compact(
  model: SessionViewModel,
  trigger: CompactionTrigger,
  estimateTokens: (text: string) => number,
  options: CompactionOptions = {},
): CompactionResult {
  const userMessages = model.timeline.filter((i) => i.type === "user");
  const userGoal =
    userMessages.length > 0 && userMessages[0]?.type === "user"
      ? userMessages[0].text
      : "";

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
  const constraints = todoItems
    .filter((item) => item.status === "blocked")
    .map((item) => `blocked: ${item.text}`);

  const nextAction =
    todoItems.find((item) => item.status === "active")?.text ??
    todoItems.find((item) => item.status === "pending")?.text ??
    (unresolved.length > 0 ? "resolve outstanding failures" : "await user direction");

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
    hierarchy,
    failurePaths,
  };

  const tokensBefore = model.contextUsedTokens;
  const tokensAfter = estimateTokens(renderCompactState(state));

  return {
    state,
    trigger,
    tokensBefore,
    tokensAfter,
    eventsSummarized: model.timeline.length,
    journalPreserved: true,
  };
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
