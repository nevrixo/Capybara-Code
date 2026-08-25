/**
 * Run metrics — PRD §26.4.
 *
 * §26.4 groups metrics into outcome, agent behaviour, cost/latency, and UX trace. The
 * grouping is kept because it maps onto who reads them: outcome gates a release,
 * behaviour and UX trace guide the prompt and the TUI, cost informs §26.6's budget
 * argument.
 *
 * Every metric here is derived from the §20.6 event stream rather than from
 * instrumentation added for the benchmark. That is what makes them trustworthy: the
 * events are the same ones the TUI and the journal see, so a metric cannot drift from
 * what the product actually did.
 */

import type { CbcEvent } from "@cbc/protocol";

// ---------------------------------------------------------------------------
// §26.4 metric shapes
// ---------------------------------------------------------------------------

export interface OutcomeMetrics {
  /** §26.4: did the hidden tests pass. */
  readonly hiddenTestsPassed: boolean;
  readonly hiddenTestsRun: number;
  readonly hiddenTestsFailed: number;
  /** Files changed that the task did not expect to be touched. */
  readonly outOfScopeFiles: string[];
  /** Files the task expected to change that were not changed. */
  readonly missedScopeFiles: string[];
  /**
   * Precision of the change: expected-and-changed over total-changed. 1 means nothing
   * unexpected was touched; an empty change set scores 0 rather than 1, because
   * "changed nothing" is not precision.
   */
  readonly scopePrecision: number;
  /** Acceptance tests that passed before the run and fail after it. */
  readonly regressions: number;
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  /** The task's declared expectation, echoed so aggregation can score it (P1-08). */
  readonly expectedStatus?: "completed" | "partial";
  /**
   * P1-08: a task may be expected to end `partial` (a plan-mode review, a denied
   * dependency install). A run that ends in the wrong status is scored, not just
   * recorded: completing a task that should have stopped is a failure like any other.
   * True when the task declares no expectation.
   */
  readonly statusMatched: boolean;
}

export interface BehaviorMetrics {
  readonly toolCalls: number;
  /** Calls that returned an error the model could have avoided. */
  readonly failedToolCalls: number;
  /** §26.4 "tool call schema errors": AC-10's validation failures. */
  readonly schemaErrors: number;
  /** Distinct files read. High counts on a narrow task suggest poor context selection. */
  readonly filesRead: number;
  /** Files read more than once, which usually means an excerpt was dropped. */
  readonly redundantReads: number;
  readonly approvalsRequested: string[];
  readonly approvalsGranted: number;
  readonly approvalsDenied: number;
  /** Approvals that were expected but never asked for. A missed R4-R6 ask is a §26.6 gate. */
  readonly missingApprovals: string[];
  /** Approvals asked for that the task did not expect. */
  readonly unexpectedApprovals: string[];
  readonly retries: number;
  readonly subagentsSpawned: number;
  readonly subagentsUseful: number;
  readonly discoveryCalls: number;
  /** §11.2: how many times the loop diagnosed its own failure before acting again. */
  readonly selfCorrections: number;
  /**
   * Reflections by failure category, so a run's dominant failure mode is visible
   * without reading the transcript. A run full of `schema_mismatch` is a tool-schema
   * problem; one full of `logic_bug` is a context-selection problem.
   */
  readonly selfCorrectionCategories: Record<string, number>;
  /** §11.3: times the loop stopped after repeating one failure three times. */
  readonly abandonedCorrections: number;
}

export interface CostMetrics {
  readonly timeToFirstCommentaryMs: number | undefined;
  readonly timeToFirstToolMs: number | undefined;
  readonly totalWallTimeMs: number;
  readonly timeToFirstProviderRequestMs: number | undefined;
  readonly timeToResponseCreatedMs: number | undefined;
  readonly timeToFirstProviderDeltaMs: number | undefined;
  readonly preProviderLocalMs: number;
  readonly repositoryWaitMs: number;
  readonly promptCompileMs: number;
  readonly providerWallMs: number;
  readonly fullPayloadBytes: number;
  readonly incrementalPayloadBytes: number;
  readonly providerRequests: number;
  readonly modelSteps: number;
  readonly reusedConnections: number;
  readonly providerFallbacks: number;
  readonly toolActiveMs: number;
  readonly toolWaitMs: number;
  readonly verificationWallMs: number;
  readonly reviewWallMs: number;
  readonly reviewCalls: number;
  readonly reviewInputBytes: number;
  readonly provisionalContextTurns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  /** Cached share of input tokens, so §10.9's caching strategy is measurable. */
  readonly cacheHitRate: number;
  /** Tokens spent by children, as a share of the total. */
  readonly subagentTokenShare: number;
}

/**
 * Context-compiler telemetry derived only from the durable event stream.
 *
 * Token fields are totals across compiled packs: a run with three model requests paid
 * for three prompts, so reporting only the last pack would hide the actual context
 * cost. Older journals that predate Context P0 produce zeroes rather than failing.
 */
export interface ContextMetrics {
  readonly packsCompiled: number;
  /** Actual input tokens assembled for model requests (`totalInputTokens`). */
  readonly actualPromptTokens: number;
  /** Canonical payload-name alias for `actualPromptTokens`. */
  readonly totalInputTokens: number;
  readonly stablePrefixTokens: number;
  readonly variableTokens: number;
  readonly exactEvidenceTokens: number;
  readonly excerptTokens: number;
  /** Evidence/excerpt appearances across packs, not distinct IDs across the run. */
  readonly evidenceItems: number;
  readonly excerptItems: number;
  readonly evictions: number;
  /** Canonical count-name alias for `evictions`. */
  readonly evictedItemCount: number;
  readonly evictedTokens: number;
  readonly evidenceRejections: number;
  /** Canonical count-name alias for `evidenceRejections`. */
  readonly rejectedEvidenceCount: number;
  readonly staleEvidenceRejections: number;
  /** Rejections whose reason or pack accounting marks the evidence non-fresh. */
  readonly staleEvidenceCount: number;
  /** Repeated IDs inside one compiled pack; reuse across separate requests is not duplication. */
  readonly duplicateItems: number;
  readonly duplicateTokens: number;
  readonly duplicateTokenRatio: number;
  readonly cacheSegments: number;
  readonly cacheSegmentTokens: number;
}

export interface UxTraceMetrics {
  /** §26.4: near-duplicate commentary lines, which read as the agent stalling. */
  readonly repetitiveCommentary: number;
  /**
   * P2 violations: a mutation with no preceding tool.started, or a committed
   * transaction the timeline never showed.
   */
  readonly invisibleSideEffects: number;
  /** Background tasks that finished without a completion event reaching the timeline. */
  readonly unclearBackgroundStates: number;
  /** §11.7's report fields that were present. Out of five. */
  readonly reportCompleteness: number;
  /** AC-50: report claims that the event stream does not support. */
  readonly unsupportedClaims: string[];
  /**
   * P1-08: expected report mentions that are absent. A task can pass its tests and
   * still answer the wrong question; the mention check is what ties the report to
   * the asked behavior.
   */
  readonly missingReportMentions: string[];
  /** P1-08: risks the task expected the report to surface, and it did not. */
  readonly missingRiskMentions: string[];
}

export interface RunMetrics {
  readonly taskId: string;
  readonly profile: string;
  readonly outcome: OutcomeMetrics;
  readonly behavior: BehaviorMetrics;
  readonly cost: CostMetrics;
  readonly context: ContextMetrics;
  readonly ux: UxTraceMetrics;
  readonly eventCount: number;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface MetricInput {
  readonly taskId: string;
  readonly profile: string;
  readonly events: readonly CbcEvent[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /** Result of running the hidden acceptance tests after the run. */
  readonly acceptance: ReadonlyArray<{ passed: boolean; label: string; wasPassingBefore: boolean }>;
  readonly expectedScope: readonly string[];
  readonly expectedApprovals: readonly string[];
  readonly expectedEvidence: {
    readonly reportMentions: readonly string[];
    readonly verificationCommands?: readonly string[];
    readonly risksMentioned?: readonly string[];
  };
  /** Set when the task declares how it should end (P1-08). */
  readonly expectedStatus?: "completed" | "partial";
}

/**
 * The §11.2 reflection commentary line, matched by its failure category.
 *
 * The categories are the coupling point rather than the surrounding words: they come
 * from a closed set in `@cbc/agent-kernel`, so a wording change to the line is a
 * harmless drift while a category change is a real one that should be noticed here.
 */
const REFLECTION_LINE =
  /^Reflecting on \S+ \((schema_mismatch|permission_denied|logic_bug|environment_issue)\)/;

const ABANDONED_CORRECTION_LINE = /^Stopping self-correction:/;

function payload(event: CbcEvent): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function eventMs(event: CbcEvent): number {
  const parsed = Date.parse(event.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface TimeInterval {
  readonly startMs: number;
  readonly endMs: number;
}

/** Wall-clock duration of intervals with overlap removed. */
function unionDurationMs(intervals: readonly TimeInterval[]): number {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs))
    .map((interval) => ({
      startMs: Math.min(interval.startMs, interval.endMs),
      endMs: Math.max(interval.startMs, interval.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (sorted.length === 0) return 0;

  let total = 0;
  let start = sorted[0]!.startMs;
  let end = sorted[0]!.endMs;
  for (const interval of sorted.slice(1)) {
    if (interval.startMs <= end) {
      end = Math.max(end, interval.endMs);
      continue;
    }
    total += end - start;
    start = interval.startMs;
    end = interval.endMs;
  }
  return total + end - start;
}

function completedDurationMs(
  events: readonly CbcEvent[],
  kinds: readonly CbcEvent["kind"][],
): number {
  const accepted = new Set<CbcEvent["kind"]>(kinds);
  return unionDurationMs(events.flatMap((event): TimeInterval[] => {
    if (!accepted.has(event.kind)) return [];
    const durationMs = optionalNumber(payload(event).durationMs) ?? 0;
    const endMs = eventMs(event);
    return durationMs === 0 ? [] : [{ startMs: endMs - durationMs, endMs }];
  }));
}

function providerPayloadBytes(event: CbcEvent, mode: "full" | "incremental"): number {
  const body = payload(event);
  const explicit = optionalNumber(
    mode === "full" ? body.fullPayloadBytes : body.incrementalPayloadBytes,
  );
  if (explicit !== undefined) return explicit;
  const previousResponse = body.previousResponse === true;
  return previousResponse === (mode === "incremental")
    ? optionalNumber(body.payloadBytes) ?? 0
    : 0;

}
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function firstNumber(
  body: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = optionalNumber(body[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function idArray(body: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = body[key];
    if (!Array.isArray(value)) continue;
    return value
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null
            ? str((entry as Record<string, unknown>).id) ??
              str((entry as Record<string, unknown>).evidenceId) ??
              str((entry as Record<string, unknown>).excerptId)
            : undefined,
      )
      .filter((entry): entry is string => entry !== undefined);
  }
  return [];
}

function hasAnyKey(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function collectionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "boolean") return value ? 1 : 0;
  return Math.floor(optionalNumber(value) ?? 0);
}

function repeatedIdCount(ids: readonly string[]): number {
  const seen = new Set<string>();
  let repeats = 0;
  for (const id of ids) {
    if (seen.has(id)) repeats += 1;
    else seen.add(id);
  }
  return repeats;
}

function rejectionReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (typeof entry !== "object" || entry === null) return [];
    const reason = str((entry as Record<string, unknown>).reason);
    return reason === undefined ? [] : [reason];
  });
}

const EVIDENCE_ID_KEYS = ["evidenceIds", "selectedEvidenceIds", "activeEvidenceIds"] as const;
const EXCERPT_ID_KEYS = ["excerptIds", "activeExcerptIds", "exactExcerptIds"] as const;
const ITEM_ID_KEYS = ["itemIds", "contextItemIds", "manifestItemIds"] as const;

/**
 * Derive Context P0 pack quality/cost metrics from normal journal events.
 *
 * New payload names are preferred, with aliases for preview/legacy producers. If a
 * stream contains `context.pack_compiled`, legacy `context.plan_created` entries are
 * ignored so a producer that emits both cannot double-charge a prompt.
 */
export function deriveContextMetrics(events: readonly CbcEvent[]): ContextMetrics {
  const compiledPacks = events.filter((event) => event.kind === "context.pack_compiled");
  const packEvents = compiledPacks.length > 0
    ? compiledPacks
    : events.filter((event) => event.kind === "context.plan_created");

  let actualPromptTokens = 0;
  let stablePrefixTokens = 0;
  let variableTokens = 0;
  let exactEvidenceTokens = 0;
  let excerptTokens = 0;
  let evidenceItems = 0;
  let excerptItems = 0;
  let duplicateItems = 0;
  let duplicateTokens = 0;
  let explicitRatioTotal = 0;
  let explicitRatioCount = 0;
  let packAdvertisesStableTokens = false;
  let packAdvertisesEvidence = false;

  for (const event of packEvents) {
    const body = payload(event);
    const total = firstNumber(body, [
      "totalInputTokens",
      "actualPromptTokens",
      "promptTokens",
      "estimatedTokens",
      "totalTokens",
    ]);
    const stable = firstNumber(body, ["stablePrefixTokens", "stableTokens"]);
    const variable = firstNumber(body, ["variableTokens", "dynamicTokens"]);
    const exact = firstNumber(body, [
      "exactEvidenceTokens",
      "evidenceTokens",
      "activeExactTokens",
    ]);
    const excerpts = firstNumber(body, [
      "excerptTokens",
      "activeExcerptTokens",
      "exactExcerptTokens",
    ]);
    const duplicates = firstNumber(body, ["duplicateTokens", "duplicateTokenCount"]);
    const ratio = firstNumber(body, ["duplicateTokenRatio", "duplicationRatio"]);

    actualPromptTokens += total ?? 0;
    stablePrefixTokens += stable ?? 0;
    variableTokens += variable ?? Math.max(0, (total ?? 0) - (stable ?? 0));
    exactEvidenceTokens += exact ?? 0;
    excerptTokens += excerpts ?? 0;
    if (stable !== undefined) packAdvertisesStableTokens = true;

    const evidenceIds = idArray(body, EVIDENCE_ID_KEYS);
    const excerptIds = idArray(body, EXCERPT_ID_KEYS);
    if (hasAnyKey(body, EVIDENCE_ID_KEYS)) {
      packAdvertisesEvidence = true;
      evidenceItems += evidenceIds.length;
    } else {
      evidenceItems += Math.floor(firstNumber(body, ["evidenceCount", "selectedEvidenceCount"]) ?? 0);
      if (hasAnyKey(body, ["evidenceCount", "selectedEvidenceCount"])) {
        packAdvertisesEvidence = true;
      }
    }
    excerptItems += hasAnyKey(body, EXCERPT_ID_KEYS)
      ? excerptIds.length
      : Math.floor(firstNumber(body, ["excerptCount", "activeExcerptCount"]) ?? 0);

    const itemIds = idArray(body, ITEM_ID_KEYS);
    const idsForDedupe = hasAnyKey(body, ITEM_ID_KEYS)
      ? itemIds
      : [...evidenceIds, ...excerptIds];
    duplicateItems += Math.floor(
      firstNumber(body, ["duplicateItems", "duplicateItemCount"]) ??
        repeatedIdCount(idsForDedupe),
    );

    if (duplicates !== undefined) {
      duplicateTokens += duplicates;
    } else if (ratio !== undefined && total !== undefined) {
      // Preview producers emitted only the ratio. Weighting it by the pack size
      // reconstructs a run-level ratio without averaging a 10-token and 10k-token pack.
      duplicateTokens += ratio * total;
    }
    if (ratio !== undefined) {
      explicitRatioTotal += ratio;
      explicitRatioCount += 1;
    }
  }

  // Before `context.pack_compiled`, the cache plan was the only durable source for
  // stable-prefix size and evidence selection used a separate event.
  if (!packAdvertisesStableTokens) {
    for (const event of events) {
      if (event.kind !== "cache.plan_created") continue;
      stablePrefixTokens += firstNumber(payload(event), ["stablePrefixTokens", "stableTokens"]) ?? 0;
    }
  }
  if (!packAdvertisesEvidence) {
    for (const event of events) {
      if (event.kind !== "context.evidence_selected") continue;
      const body = payload(event);
      evidenceItems += hasAnyKey(body, EVIDENCE_ID_KEYS)
        ? idArray(body, EVIDENCE_ID_KEYS).length
        : Math.floor(firstNumber(body, ["evidenceCount", "selectedEvidenceCount"]) ?? 0);
    }
  }

  const evictionEvents = events.filter((event) => event.kind === "context.item_evicted");
  let evictions = 0;
  let evictedTokens = 0;
  for (const event of evictionEvents) {
    const body = payload(event);
    const ids = idArray(body, ["itemIds", "excerptIds", "evictedItemIds"]);
    evictions += ids.length > 0
      ? ids.length
      : Math.max(1, Math.floor(firstNumber(body, ["count", "evictionCount"]) ?? 1));
    evictedTokens += firstNumber(body, ["estimatedTokens", "evictedTokens", "tokens"]) ?? 0;
  }

  const explicitRejections = events.filter(
    (event) => event.kind === "context.evidence_rejected",
  );
  let evidenceRejections = 0;
  let staleEvidenceRejections = 0;
  const countRejections = (body: Record<string, unknown>): void => {
    const rejectionKeys = ["rejected", "rejections", "evidenceIds"] as const;
    const rejected = body.rejected ?? body.rejections ?? body.evidenceIds;
    const advertisedCollection = hasAnyKey(body, rejectionKeys);
    const staleCount = firstNumber(body, [
      "staleEvidenceCount", "staleEvidenceRejections",
    ]);
    evidenceRejections += advertisedCollection
      ? collectionCount(rejected)
      : Math.floor(firstNumber(body, ["count", "rejectedEvidenceCount"]) ?? staleCount ?? 1);
    const reasons = [str(body.reason), ...rejectionReasons(rejected)].filter(
      (reason): reason is string => reason !== undefined,
    );
    staleEvidenceRejections += staleCount ?? reasons.filter((reason) =>
      /stale|invalid|expired|mismatch|changed|missing/i.test(reason),
    ).length;
  };

  if (explicitRejections.length > 0) {
    for (const event of explicitRejections) countRejections(payload(event));
  } else {
    const packRejections = packEvents.filter((event) => hasAnyKey(payload(event), [
      "rejected", "rejections", "rejectedEvidenceCount", "staleEvidenceCount",
    ]));
    if (packRejections.length > 0) {
      for (const event of packRejections) countRejections(payload(event));
    } else {
      // Legacy selection events embedded rejected IDs/reasons rather than emitting one
      // event per rejection. Prefer them over observation-level shape rejections.
      const legacySelections = events.filter(
        (event) => event.kind === "context.evidence_selected" &&
          hasAnyKey(payload(event), ["rejected", "rejections", "rejectedEvidenceCount"]),
      );
      if (legacySelections.length > 0) {
        for (const event of legacySelections) countRejections(payload(event));
      } else {
        for (const event of events) {
          if (event.kind !== "context.observation_ingested") continue;
          const body = payload(event);
          if (hasAnyKey(body, ["rejected", "rejections", "rejectedEvidenceCount"])) {
            countRejections(body);
          }
        }
      }
    }
  }

  const explicitSegments = events.filter((event) => event.kind === "context.cache_segment");
  let cacheSegments = 0;
  let cacheSegmentTokens = 0;
  if (explicitSegments.length > 0) {
    for (const event of explicitSegments) {
      const body = payload(event);
      const segments = body.segments;
      cacheSegments += Array.isArray(segments) ? segments.length : 1;
      if (Array.isArray(segments)) {
        for (const segment of segments) {
          if (typeof segment === "object" && segment !== null) {
            cacheSegmentTokens += firstNumber(segment as Record<string, unknown>, [
              "tokens", "tokenCount", "stablePrefixTokens",
            ]) ?? 0;
          }
        }
      } else {
        cacheSegmentTokens += firstNumber(body, ["tokens", "tokenCount", "stablePrefixTokens"]) ?? 0;
      }
    }
  } else {
    for (const event of packEvents) {
      const segments = payload(event).cacheSegments;
      if (!Array.isArray(segments)) continue;
      cacheSegments += segments.length;
      for (const segment of segments) {
        if (typeof segment === "object" && segment !== null) {
          cacheSegmentTokens += firstNumber(segment as Record<string, unknown>, [
            "tokens", "tokenCount", "stablePrefixTokens",
          ]) ?? 0;
        }
      }
    }
  }

  const duplicateTokenRatio = actualPromptTokens > 0
    ? duplicateTokens / actualPromptTokens
    : explicitRatioCount > 0
      ? explicitRatioTotal / explicitRatioCount
      : 0;

  return {
    packsCompiled: compiledPacks.length,
    actualPromptTokens,
    totalInputTokens: actualPromptTokens,
    stablePrefixTokens,
    variableTokens,
    exactEvidenceTokens,
    excerptTokens,
    evidenceItems,
    excerptItems,
    evictions,
    evictedItemCount: evictions,
    evictedTokens,
    evidenceRejections,
    rejectedEvidenceCount: evidenceRejections,
    staleEvidenceRejections,
    staleEvidenceCount: staleEvidenceRejections,
    duplicateItems,
    duplicateTokens,
    duplicateTokenRatio,
    cacheSegments,
    cacheSegmentTokens,
  };
}

/**
 * Simple glob match for scope globs. Supports `*`, `**`, and `?`.
 *
 * Deliberately small rather than pulling in a matcher: the scope patterns in a task
 * fixture are authored alongside this code, so exotic syntax is a fixture bug rather
 * than something to support.
 */
export function globMatch(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(path);
}

/** Derive every §26.4 metric from one run's events. */
export function deriveMetrics(input: MetricInput): RunMetrics {
  const events = input.events;

  // ---- outcome ----
  const changedFiles = new Set<string>();
  for (const event of events) {
    if (event.kind !== "transaction.committed" && event.kind !== "diff.updated") continue;
    const paths = payload(event).paths ?? payload(event).files;
    if (Array.isArray(paths)) {
      for (const entry of paths) {
        const path = typeof entry === "string" ? entry : str((entry as Record<string, unknown>)?.path);
        if (path !== undefined) changedFiles.add(path);
      }
    }
  }

  const inScope = [...changedFiles].filter((path) =>
    input.expectedScope.some((pattern) => globMatch(pattern, path)),
  );
  const outOfScopeFiles = [...changedFiles].filter((path) => !inScope.includes(path)).sort();
  // A scope glob with no matching change is "missed". A pattern like `src/**` cannot be
  // reported this way, so only literal patterns are checked.
  const missedScopeFiles = input.expectedScope
    .filter((pattern) => !/[*?]/.test(pattern))
    .filter((pattern) => !changedFiles.has(pattern))
    .sort();

  const failedTests = input.acceptance.filter((test) => !test.passed);
  const regressions = input.acceptance.filter(
    (test) => test.wasPassingBefore && !test.passed,
  ).length;

  const finalStatus = lastStatus(events);

  const outcome: OutcomeMetrics = {
    hiddenTestsPassed: input.acceptance.length > 0 && failedTests.length === 0,
    hiddenTestsRun: input.acceptance.length,
    hiddenTestsFailed: failedTests.length,
    outOfScopeFiles,
    missedScopeFiles,
    // Zero changes scores zero: "touched nothing" is not precise, it is inert.
    scopePrecision: changedFiles.size === 0 ? 0 : inScope.length / changedFiles.size,
    regressions,
    status: finalStatus,
    ...(input.expectedStatus !== undefined ? { expectedStatus: input.expectedStatus } : {}),
    statusMatched: input.expectedStatus === undefined || finalStatus === input.expectedStatus,
  };

  // ---- behaviour ----
  const readPaths: string[] = [];
  const approvalsRequested: string[] = [];
  let toolCalls = 0;
  let failedToolCalls = 0;
  let schemaErrors = 0;
  let approvalsGranted = 0;
  let approvalsDenied = 0;
  let retries = 0;
  let subagentsSpawned = 0;
  let subagentsUseful = 0;
  let discoveryCalls = 0;
  let selfCorrections = 0;
  let abandonedCorrections = 0;
  const selfCorrectionCategories: Record<string, number> = {};

  for (const event of events) {
    const body = payload(event);
    switch (event.kind) {
      case "tool.started": {
        toolCalls += 1;
        const toolId = str(body.toolId);
        if (toolId === "fs.read" || toolId === "fs.read_many") {
          const args = (body.arguments ?? {}) as Record<string, unknown>;
          const single = str(args.path);
          if (single !== undefined) readPaths.push(single);
          if (Array.isArray(args.paths)) {
            for (const entry of args.paths) if (typeof entry === "string") readPaths.push(entry);
          }
        }
        break;
      }
      case "tool.failed":
        failedToolCalls += 1;
        if (str(body.code) === "INVALID_ARGUMENT") schemaErrors += 1;
        break;
      case "tool.discovery":
        discoveryCalls += 1;
        break;
      case "approval.requested": {
        const action = str(body.action);
        if (action !== undefined) approvalsRequested.push(action);
        break;
      }
      case "approval.resolved": {
        const decision = str(body.decision) ?? "";
        if (decision.startsWith("allow")) approvalsGranted += 1;
        else approvalsDenied += 1;
        break;
      }
      case "notification.retry":
        retries += 1;
        break;
      case "assistant.commentary": {
        // §11.2's reflection line is a normal commentary event, because the diagnosis
        // is meant to be visible to the user (P2). Matching on the taxonomy token
        // rather than on prose keeps this from counting a model's own musings.
        const reflection = REFLECTION_LINE.exec(str(body.text) ?? "");
        if (reflection?.[1] !== undefined) {
          selfCorrections += 1;
          const category = reflection[1];
          selfCorrectionCategories[category] = (selfCorrectionCategories[category] ?? 0) + 1;
        } else if (ABANDONED_CORRECTION_LINE.test(str(body.text) ?? "")) {
          abandonedCorrections += 1;
        }
        break;
      }
      case "task.created":
        subagentsSpawned += 1;
        break;
      case "task.completed": {
        // §15.11: a child is "useful" when the parent could verify its evidence, which
        // the completion payload records. A child that completed with nothing to show
        // cost tokens without contributing.
        const evidence = body.evidence;
        if (Array.isArray(evidence) ? evidence.length > 0 : str(body.summary) !== undefined) {
          subagentsUseful += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  const uniqueReads = new Set(readPaths);
  const behavior: BehaviorMetrics = {
    toolCalls,
    failedToolCalls,
    schemaErrors,
    filesRead: uniqueReads.size,
    redundantReads: readPaths.length - uniqueReads.size,
    approvalsRequested,
    approvalsGranted,
    approvalsDenied,
    missingApprovals: input.expectedApprovals.filter(
      (expected) => !approvalsRequested.includes(expected),
    ),
    unexpectedApprovals: approvalsRequested.filter(
      (actual) => !input.expectedApprovals.includes(actual),
    ),
    retries,
    subagentsSpawned,
    subagentsUseful,
    discoveryCalls,
    selfCorrections,
    selfCorrectionCategories,
    abandonedCorrections,
  };

  // ---- cost and latency ----
  const firstCommentary = events.find((event) => event.kind === "assistant.commentary");
  const firstTool = events.find((event) => event.kind === "tool.started");
  const usage = lastUsage(events);
  const childTokens = childTokenTotal(events);

  const firstProviderRequest = events.find((event) => event.kind === "provider.request_sent");
  const firstResponseCreated = events.find((event) => event.kind === "provider.response_created");
  const firstProviderDelta = events.find((event) => event.kind === "provider.first_delta");
  const providerRequests = events.filter((event) => event.kind === "provider.request_sent");
  const toolStarts = new Map<string, number>();
  const toolActiveIntervals: TimeInterval[] = [];
  const toolWaitIntervals: TimeInterval[] = [];
  for (const event of events) {
    const body = payload(event);
    const callId = str(body.callId);
    const callKey = callId === undefined ? undefined : `${event.agentId ?? "root"}:${callId}`;
    if (event.kind === "tool.started" && callKey !== undefined) {
      toolStarts.set(callKey, eventMs(event));
      continue;
    }
    const settled = event.kind === "tool.completed" || event.kind === "tool.failed";
    if (!settled || callKey === undefined) continue;
    const activeMs = optionalNumber(body.durationMs);
    const completedAt = eventMs(event);
    const startedAt = toolStarts.get(callKey);
    toolStarts.delete(callKey);
    if (activeMs === undefined) continue;
    const activeStart = startedAt ?? completedAt - activeMs;
    if (activeMs > 0) {
      toolActiveIntervals.push({ startMs: activeStart, endMs: activeStart + activeMs });
    }
    if (startedAt !== undefined && completedAt > startedAt + activeMs) {
      toolWaitIntervals.push({ startMs: startedAt + activeMs, endMs: completedAt });
    }
  }
  const traceStepEvents = events.filter((event) =>
    event.kind === "run.trace_completed" &&
    optionalNumber(payload(event).modelSteps) !== undefined
  );
  const modelSteps = traceStepEvents.length > 0
    ? traceStepEvents.reduce((sum, event) => sum + (optionalNumber(payload(event).modelSteps) ?? 0), 0)
    : providerRequests.length;
  const cost: CostMetrics = {
    timeToFirstCommentaryMs:
      firstCommentary !== undefined
        ? Math.max(0, eventMs(firstCommentary) - input.startedAtMs)
        : undefined,
    timeToFirstToolMs: firstTool !== undefined
      ? Math.max(0, eventMs(firstTool) - input.startedAtMs)
      : undefined,
    totalWallTimeMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
    timeToFirstProviderRequestMs: firstProviderRequest === undefined
      ? undefined
      : Math.max(0, eventMs(firstProviderRequest) - input.startedAtMs),
    timeToResponseCreatedMs: firstResponseCreated === undefined
      ? undefined
      : Math.max(0, eventMs(firstResponseCreated) - input.startedAtMs),
    timeToFirstProviderDeltaMs: firstProviderDelta === undefined
      ? undefined
      : Math.max(0, eventMs(firstProviderDelta) - input.startedAtMs),
    preProviderLocalMs: firstProviderRequest === undefined
      ? Math.max(0, input.finishedAtMs - input.startedAtMs)
      : Math.max(0, eventMs(firstProviderRequest) - input.startedAtMs),
    repositoryWaitMs: completedDurationMs(events, ["repository.orientation_completed"]),
    promptCompileMs: completedDurationMs(events, ["prompt.compile_completed"]),
    providerWallMs: completedDurationMs(events, ["provider.response_completed"]),
    fullPayloadBytes: providerRequests.reduce(
      (sum, event) => sum + providerPayloadBytes(event, "full"),
      0,
    ),
    incrementalPayloadBytes: providerRequests.reduce(
      (sum, event) => sum + providerPayloadBytes(event, "incremental"),
      0,
    ),
    providerRequests: providerRequests.length,
    modelSteps,
    reusedConnections: events.filter(
      (event) => event.kind === "provider.connection_ready" && payload(event).connectionReused === true,
    ).length,
    providerFallbacks: events.filter((event) => event.kind === "provider.fallback").length,
    toolActiveMs: unionDurationMs(toolActiveIntervals),
    toolWaitMs: unionDurationMs(toolWaitIntervals),
    verificationWallMs: completedDurationMs(events, ["verification.completed"]),
    reviewWallMs: completedDurationMs(events, ["review.completed"]),
    reviewCalls: events.filter((event) => event.kind === "review.started").length,
    reviewInputBytes: events
      .filter((event) => event.kind === "review.completed")
      .reduce((sum, event) => sum + (optionalNumber(payload(event).inputBytes) ?? 0), 0),
    provisionalContextTurns: events.filter(
      (event) =>
        event.kind === "repository.orientation_completed" &&
        payload(event).state === "provisional",
    ).length,
    ...usage,
    cacheHitRate: usage.inputTokens === 0 ? 0 : usage.cachedInputTokens / usage.inputTokens,
    subagentTokenShare:
      usage.inputTokens + usage.outputTokens === 0
        ? 0
        : childTokens / (usage.inputTokens + usage.outputTokens),
  };

  // ---- compiled context ----
  const context = deriveContextMetrics(events);

  // ---- UX trace ----
  const commentary = events
    .filter((event) => event.kind === "assistant.commentary")
    .map((event) => str(payload(event).text) ?? "");
  const finalEvent = [...events].reverse().find((event) => event.kind === "assistant.final");
  const report = (payload(finalEvent ?? ({} as CbcEvent)).report ?? {}) as Record<string, unknown>;

  const ux: UxTraceMetrics = {
    repetitiveCommentary: countRepetitive(commentary),
    invisibleSideEffects: countInvisibleSideEffects(events),
    unclearBackgroundStates: countUnclearBackground(events),
    reportCompleteness: reportCompleteness(report),
    unsupportedClaims: unsupportedClaims(report, events, input.expectedEvidence),
    missingReportMentions: missingMentions(reportText(report), input.expectedEvidence.reportMentions),
    missingRiskMentions: missingMentions(riskText(report), input.expectedEvidence.risksMentioned ?? []),
  };

  return {
    taskId: input.taskId,
    profile: input.profile,
    outcome,
    behavior,
    cost,
    context,
    ux,
    eventCount: events.length,
  };
}

function lastStatus(events: readonly CbcEvent[]): OutcomeMetrics["status"] {
  for (const event of [...events].reverse()) {
    if (event.kind !== "turn.completed" && event.kind !== "turn.cancelled") continue;
    const status = str(payload(event).status);
    if (event.kind === "turn.cancelled") return "cancelled";
    if (status === "completed" || status === "partial" || status === "failed") return status;
  }
  // No terminal event at all means the run did not finish, which is a failure rather
  // than an unknown.
  return "failed";
}

function lastUsage(events: readonly CbcEvent[]): {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
} {
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
  };
  const usageEvents = events.filter((event) => event.kind === "usage.updated");
  // Current producers attach a request id and emit one usage delta per provider
  // response. Journals predating that contract carried running totals without a
  // request id, so retain last-value behavior only for those legacy streams.
  const perRequestDeltas = usageEvents.some((event) =>
    str(payload(event).requestId) !== undefined
  );
  for (const event of usageEvents) {
    const body = payload(event);
    const merge = (prior: number, value: unknown): number =>
      perRequestDeltas ? prior + num(value) : num(value);
    totals.inputTokens = merge(totals.inputTokens, body.inputTokens);
    totals.cachedInputTokens = merge(totals.cachedInputTokens, body.cachedInputTokens);
    totals.cacheWriteTokens = merge(totals.cacheWriteTokens, body.cacheWriteTokens);
    totals.outputTokens = merge(totals.outputTokens, body.outputTokens);
    totals.reasoningTokens = merge(totals.reasoningTokens, body.reasoningTokens);
    totals.estimatedCostUsd = merge(totals.estimatedCostUsd, body.estimatedCostUsd);
  }
  return totals;
}

/** Tokens attributable to subagents, identified by a non-root `agentId`. */
function childTokenTotal(events: readonly CbcEvent[]): number {
  const childEvents = events.filter((event) =>
    event.kind === "usage.updated" &&
    event.agentId !== undefined &&
    event.agentId !== "root"
  );
  if (childEvents.some((event) => str(payload(event).requestId) !== undefined)) {
    return childEvents.reduce((sum, event) => {
      const body = payload(event);
      return sum + num(body.inputTokens) + num(body.outputTokens);
    }, 0);
  }

  // Legacy journals used running totals. Keep the maximum total per child,
  // rather than taking one global maximum and dropping sibling agents.
  const byAgent = new Map<string, number>();
  for (const event of childEvents) {
    const body = payload(event);
    const total = num(body.inputTokens) + num(body.outputTokens);
    byAgent.set(event.agentId!, Math.max(byAgent.get(event.agentId!) ?? 0, total));
  }
  return [...byAgent.values()].reduce((sum, value) => sum + value, 0);
}

/** Words compared when deciding whether two commentary lines say the same thing. */
const REPETITION_PREFIX_WORDS = 5;

/**
 * Count near-duplicate commentary.
 *
 * The pattern that reads as stalling is "Let me check the file" repeated with a
 * different filename each time, so the identifier has to be removed *before* the prefix
 * is taken. Stripping punctuation first would fold `src/a.ts` into `srcats` and leave it
 * in the key, making every line unique and the metric always zero.
 */
export function countRepetitive(lines: readonly string[]): number {
  const seen = new Map<string, number>();
  let repeats = 0;

  for (const line of lines) {
    const key = line
      .toLowerCase()
      .split(/\s+/)
      // Drop path- and identifier-shaped tokens: those are the varying part.
      .filter((word) => !/[/\\.]/.test(word) && !/\d/.test(word))
      .map((word) => word.replace(/[^a-z]/g, ""))
      .filter((word) => word.length > 0)
      .slice(0, REPETITION_PREFIX_WORDS)
      .join(" ");

    if (key.length === 0) continue;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) repeats += 1;
  }
  return repeats;
}

/**
 * P2: no invisible side effects.
 *
 * A committed transaction must have a `transaction.started` before it and a visible
 * `tool.started` in the same turn. A commit with neither means the workspace changed
 * without the timeline saying so.
 */
export function countInvisibleSideEffects(events: readonly CbcEvent[]): number {
  let invisible = 0;
  const startedTransactions = new Set<string>();
  const visibleToolTurns = new Set<string>();

  for (const event of events) {
    const body = payload(event);
    if (event.kind === "transaction.started") {
      const id = str(body.transactionId);
      if (id !== undefined) startedTransactions.add(id);
    }
    if (event.kind === "tool.started" && event.visibility === "timeline") {
      visibleToolTurns.add(event.turnId ?? "");
    }
    if (event.kind === "transaction.committed") {
      const id = str(body.transactionId);
      const announced = id !== undefined && startedTransactions.has(id);
      const visible = visibleToolTurns.has(event.turnId ?? "");
      if (!announced || !visible) invisible += 1;
    }
  }
  return invisible;
}

/** §6.11: a background task that ended must have said so on the timeline. */
export function countUnclearBackground(events: readonly CbcEvent[]): number {
  const started = new Set<string>();
  const settled = new Set<string>();
  for (const event of events) {
    const body = payload(event);
    const id = str(body.taskId) ?? str(body.jobId);
    if (id === undefined) continue;
    if (event.kind === "task.started" || event.kind === "job.started") started.add(id);
    if (
      event.kind === "task.completed" ||
      event.kind === "task.failed" ||
      event.kind === "task.cancelled" ||
      event.kind === "job.completed" ||
      event.kind === "job.failed"
    ) {
      settled.add(id);
    }
  }
  return [...started].filter((id) => !settled.has(id)).length;
}

/** §11.7's five required report parts. */
export function reportCompleteness(report: Record<string, unknown>): number {
  let present = 0;
  if (typeof report.summary === "string" && report.summary.length > 0) present += 1;
  if (Array.isArray(report.changedFiles)) present += 1;
  if (Array.isArray(report.verification)) present += 1;
  if (Array.isArray(report.risks)) present += 1;
  if (typeof report.status === "string") present += 1;
  return present;
}

/**
 * The report as searchable text (P1-08). Lowercased JSON of the whole report:
 * mentions can legitimately appear in the summary, the verification list, or the
 * risks, and scoring one field only would reward reports that hide information
 * elsewhere.
 */
export function reportText(report: Record<string, unknown>): string {
  return JSON.stringify(report).toLowerCase();
}

/** The report's risks, flattened to searchable text. */
export function riskText(report: Record<string, unknown>): string {
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const parts = risks.map((risk) => {
    if (typeof risk === "string") return risk;
    if (typeof risk === "object" && risk !== null) {
      const entry = risk as Record<string, unknown>;
      return [entry.message, entry.risk, entry.description]
        .filter((value): value is string => typeof value === "string")
        .join(" ");
    }
    return "";
  });
  return parts.join(" ").toLowerCase();
}

/** Expected terms absent from the text, case-insensitively. */
export function missingMentions(text: string, expected: readonly string[]): string[] {
  return expected
    .filter((term) => term.length > 0)
    .filter((term) => !text.includes(term.toLowerCase()));
}

/**
 * AC-50: report claims the event stream does not support.
 *
 * Two checks, both cases seen in practice: a verification the report calls `passed`
 * with no matching process run, and a changed file with no committed transaction. A
 * report is only evidence if it can be contradicted.
 */
export function unsupportedClaims(
  report: Record<string, unknown>,
  events: readonly CbcEvent[],
  expected: MetricInput["expectedEvidence"],
): string[] {
  const claims: string[] = [];

  const ranCommands = new Set<string>();
  const committedPaths = new Set<string>();
  for (const event of events) {
    const body = payload(event);
    if (event.kind === "tool.started") {
      const display = str(body.display);
      if (display !== undefined) ranCommands.add(display);
    }
    if (event.kind === "transaction.committed") {
      const paths = body.paths;
      if (Array.isArray(paths)) {
        for (const path of paths) if (typeof path === "string") committedPaths.add(path);
      }
    }
  }

  const verification = Array.isArray(report.verification) ? report.verification : [];
  for (const step of verification) {
    if (typeof step !== "object" || step === null) continue;
    const entry = step as Record<string, unknown>;
    if (entry.status !== "passed") continue;
    const command = str(entry.command);
    if (command === undefined) continue;
    const matched = [...ranCommands].some(
      (ran) => ran.includes(command) || command.includes(ran),
    );
    if (!matched) claims.push(`claims '${command}' passed, but no such command was run`);
  }

  const changed = Array.isArray(report.changedFiles) ? report.changedFiles : [];
  for (const file of changed) {
    const path =
      typeof file === "string" ? file : str((file as Record<string, unknown>)?.path);
    if (path === undefined) continue;
    if (committedPaths.size > 0 && !committedPaths.has(path)) {
      claims.push(`claims '${path}' changed, but no transaction committed it`);
    }
  }

  for (const command of expected.verificationCommands ?? []) {
    const claimed = verification.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        (str((step as Record<string, unknown>).command) ?? "").includes(command),
    );
    if (!claimed) claims.push(`the report never mentions the expected verification '${command}'`);
  }

  return claims;
}
