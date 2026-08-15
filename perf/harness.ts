/**
 * Counter-first performance regression scenarios for Capybara Code.
 *
 * Wall-clock measurements are deliberately diagnostic. Correctness, public
 * operation counters, cache hit rates, batching boundaries, and work-growth
 * ratios decide pass/fail so this suite remains useful on laptops and CI hosts.
 */

import {
  AppendableMarkdownSourceIndex,
  MarkdownRenderCache,
  ProjectedTimeline,
  createMarkdownSourceIndex,
  defaultTheme,
  lineText,
  measureAndTruncate,
  renderMarkdown,
  renderMarkdownTail,
  resetWidthDiagnostics,
  stringWidth,
  widthDiagnostics,
  type BlockContext,
  type TerminalCapabilities,
} from "../packages/tui-components/src/index.ts";
import {
  DEFAULT_SESSION_PAGE_BYTES,
  JOURNAL_BATCH_MAX_BYTES,
  JOURNAL_BATCH_MAX_EVENTS,
  MAX_RESIDENT_SUBAGENT_EVENTS,
  ResidentJournalWindow,
  SessionRecorder,
  boundResidentViewModel,
  emptyViewModel,
  loadEarlierJournalPage,
  reduce,
  replayJournalTail,
  validateSessionJournalPage,
  type JournalTransport,
  type SessionJournalPage,
  type SessionLoadTransport,
  type SessionViewModel,
  type StoredJournalEvent,
  type TimelineItem,
  type TimelineNotice,
} from "../packages/session-domain/src/index.ts";
import * as sessionDomainExports from "../packages/session-domain/src/index.ts";
import {
  EventSequencer,
  createEvent,
  type CbcEvent,
} from "../packages/protocol-ts/src/index.ts";
import { LiveSpanRegistry } from "../apps/cbc/src/live-spans.ts";
import { renderSessionFrame } from "../apps/cbc/src/tui-frame.ts";
import { ComposerSession } from "../apps/cbc/src/composer.ts";
import { WorkspacePathMentionIndex } from "../apps/cbc/src/path-mentions.ts";
import { TerminalFrameWriter } from "../apps/cbc/src/terminal-writer.ts";
import {
  buildRepositoryMap,
  RetrievalController,
  selectContext,
  type RetrievalAdapter,
  type RetrievalCandidate,
  type RetrievalObservation,
  type RepoFile,
} from "../packages/context-engine/src/index.ts";
import { DEFAULT_READ_MAX_LINES, okResult } from "../packages/tool-registry/src/index.ts";
import { ReadCache, type Execution } from "../apps/cbc/src/tools.ts";
import { scanRepository } from "../apps/cbc/src/repository-map.ts";

export type HarnessMode = "full" | "quick";

export interface TimingDistribution {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface GateResult {
  readonly name: string;
  readonly pass: boolean;
  readonly actual: unknown;
  readonly expected: string;
}

export interface ScenarioReport {
  readonly name: string;
  readonly description: string;
  readonly sizes: Record<string, unknown>;
  readonly timings: Record<string, TimingDistribution>;
  readonly counters: Record<string, unknown>;
  readonly ratios: Record<string, number | null>;
  readonly correctness: Record<string, unknown>;
  readonly gates: readonly GateResult[];
  readonly notes?: readonly string[];
  readonly pass: boolean;
}

export interface PerformanceHarnessReport {
  readonly schemaVersion: 1;
  readonly suite: "capybara-performance-regression";
  readonly mode: HarnessMode;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly runtime: {
    readonly bun: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly scenarios: readonly ScenarioReport[];
  readonly summary: {
    readonly scenarios: number;
    readonly passed: number;
    readonly failed: number;
    readonly failingGates: readonly string[];
  };
  readonly pass: boolean;
}

interface HarnessConfig {
  readonly timelineSizes: readonly [number, number];
  readonly unchangedSamples: number;
  readonly appendCount: number;
  readonly viewportRows: number;
  readonly deepOffsetRows: number;
  readonly viewportWarmSamples: number;
  readonly markdownCharacters: number;
  readonly markdownColdSamples: number;
  readonly markdownWarmSamples: number;
  readonly reducerDeltaCount: number;
  readonly reducerSamples: number;
  readonly liveSpanCycles: number;
  readonly liveSpanConcurrency: number;
  readonly liveSpanChunks: number;
  readonly idleFrames: number;
  readonly residentEventMultiplier: number;
  readonly pagingEvents: number;
  readonly pagingPageItems: number;
  readonly residentJournalEvents: number;
  readonly residentJournalMaxItems: number;
  readonly residentViewItems: number;
  readonly residentViewMaxItems: number;
  readonly widthIterations: number;
  readonly streamingGrowthChunks: number;
  readonly activeFrameSamples: number;
  readonly composerDraft: number;
  readonly pathIndexEntries: number;
  readonly ansiFrameSamples: number;
}

const CONFIGS: Readonly<Record<HarnessMode, HarnessConfig>> = {
  full: {
    timelineSizes: [10_000, 100_000],
    unchangedSamples: 21,
    appendCount: 32,
    viewportRows: 40,
    deepOffsetRows: 5_000,
    viewportWarmSamples: 11,
    markdownCharacters: 1_000_000,
    markdownColdSamples: 3,
    markdownWarmSamples: 15,
    reducerDeltaCount: 4_000,
    reducerSamples: 7,
    liveSpanCycles: 2_000,
    liveSpanConcurrency: 8,
    liveSpanChunks: 4,
    idleFrames: 12,
    residentEventMultiplier: 4,
    pagingEvents: 2_500,
    pagingPageItems: 137,
    residentJournalEvents: 4_096,
    residentJournalMaxItems: 128,
    residentViewItems: 2_000,
    residentViewMaxItems: 128,
    widthIterations: 50_000,
    streamingGrowthChunks: 1_000,
    activeFrameSamples: 30,
    composerDraft: 50_000,
    pathIndexEntries: 7_500,
    ansiFrameSamples: 6,
  },
  quick: {
    timelineSizes: [1_000, 10_000],
    unchangedSamples: 7,
    appendCount: 8,
    viewportRows: 20,
    deepOffsetRows: 250,
    viewportWarmSamples: 5,
    markdownCharacters: 100_000,
    markdownColdSamples: 2,
    markdownWarmSamples: 5,
    reducerDeltaCount: 500,
    reducerSamples: 3,
    liveSpanCycles: 100,
    liveSpanConcurrency: 4,
    liveSpanChunks: 3,
    idleFrames: 4,
    residentEventMultiplier: 2,
    pagingEvents: 257,
    pagingPageItems: 64,
    residentJournalEvents: 512,
    residentJournalMaxItems: 64,
    residentViewItems: 256,
    residentViewMaxItems: 48,
    widthIterations: 5_000,
    streamingGrowthChunks: 100,
    activeFrameSamples: 8,
    composerDraft: 10_000,
    pathIndexEntries: 7_500,
    ansiFrameSamples: 4,
  },
};

export const SCENARIO_NAMES = [
  "unicode-width-hotloop",
  "streaming-markdown-growth",
  "active-frame-surrogate",
  "composer-edit-latency",
  "path-completion-max-index",
  "ansi-diff-and-backpressure",
  "projected-timeline",
  "giant-markdown",
  "reducer-delta-burst",
  "live-span-cleanup",
  "session-recorder-batching",
  "idle-frame-surrogate",
  "resident-window-and-paging",
  "read-cache-coalescing",
  "repository-scan-truncation",
  "selection-shortlist-50k",
  "retrieval-controller-stop-rules",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

const BLOCK_CONTEXT: BlockContext = {
  columns: 100,
  capabilities: {
    unicode: true,
    italic: true,
    reducedMotion: false,
    stableEmojiWidth: true,
  },
};

const TERMINAL_CAPABILITIES: TerminalCapabilities = {
  colorDepth: "none",
  italic: true,
  unicode: true,
  stableEmojiWidth: true,
  reducedMotion: false,
  mouse: false,
  columns: 100,
  rows: 30,
  hyperlinks: false,
};

const round = (value: number, places = 4): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** Deterministic nearest-rank percentile summary used by the JSON report. */
export function summarizeDurations(values: readonly number[]): TimingDistribution {
  if (values.length === 0) {
    return { samples: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const medianIndex = Math.floor((sorted.length - 1) * 0.5);
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  return {
    samples: sorted.length,
    medianMs: round(sorted[medianIndex] ?? 0),
    p95Ms: round(sorted[Math.max(0, p95Index)] ?? 0),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

function elapsed(start: number): number {
  return performance.now() - start;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return numerator === 0 ? 1 : null;
  return round(numerator / denominator);
}

/** Additive smoothing is useful when the ideal operation counter is zero. */
function zeroSafeGrowth(larger: number, smaller: number): number {
  return round((larger + 1) / (smaller + 1));
}

function gate(name: string, pass: boolean, actual: unknown, expected: string): GateResult {
  return { name, pass, actual, expected };
}

function finishScenario(
  report: Omit<ScenarioReport, "pass">,
): ScenarioReport {
  return { ...report, pass: report.gates.every((entry) => entry.pass) };
}

function makeNotices(count: number, sequenceStart = 1): TimelineNotice[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "notice" as const,
    id: `perf-notice-${sequenceStart + index}`,
    sequence: sequenceStart + index,
    level: "info" as const,
    text: `performance history row ${sequenceStart + index}`,
  }));
}

interface ProjectionObservation {
  readonly size: number;
  readonly buildMs: number;
  readonly unchangedDurations: readonly number[];
  readonly appendMs: number;
  readonly deepColdMs: number;
  readonly deepWarmDurations: readonly number[];
  readonly unchangedInspected: number;
  readonly unchangedFullRebuilds: number;
  readonly appendInspected: number;
  readonly appended: number;
  readonly appendFullRebuilds: number;
  readonly deepRenderedGroups: number;
  readonly deepViewportQueries: number;
  readonly warmRenderedGroups: number;
  readonly outputLines: number;
  readonly expectedLength: number;
  readonly actualLength: number;
  readonly groupCount: number;
}

export function runProjectedTimelineScenario(config: HarnessConfig): ScenarioReport {
  const observations: ProjectionObservation[] = [];

  for (const size of config.timelineSizes) {
    const items = makeNotices(size);
    const projection = new ProjectedTimeline({}, { maxRenderVariants: 2 });
    let start = performance.now();
    projection.reset(items);
    const buildMs = elapsed(start);

    projection.resetStats();
    const unchangedDurations: number[] = [];
    for (let sample = 0; sample < config.unchangedSamples; sample += 1) {
      start = performance.now();
      projection.sync(items);
      unchangedDurations.push(elapsed(start));
    }
    const unchangedStats = projection.stats;

    const appendedItems = makeNotices(config.appendCount, size + 1);
    const nextItems: readonly TimelineItem[] = [...items, ...appendedItems];
    projection.resetStats();
    start = performance.now();
    const appendSync = projection.sync(nextItems);
    const appendMs = elapsed(start);
    const appendStats = projection.stats;

    projection.resetStats();
    start = performance.now();
    const deepLines = projection.renderWindow(
      BLOCK_CONTEXT,
      {},
      config.viewportRows,
      config.deepOffsetRows,
    );
    const deepColdMs = elapsed(start);
    const deepStats = projection.stats;

    projection.resetStats();
    const deepWarmDurations: number[] = [];
    for (let sample = 0; sample < config.viewportWarmSamples; sample += 1) {
      start = performance.now();
      projection.renderWindow(
        BLOCK_CONTEXT,
        {},
        config.viewportRows,
        config.deepOffsetRows,
      );
      deepWarmDurations.push(elapsed(start));
    }
    const warmStats = projection.stats;

    observations.push({
      size,
      buildMs,
      unchangedDurations,
      appendMs,
      deepColdMs,
      deepWarmDurations,
      unchangedInspected: unchangedStats.sourceItemsInspected,
      unchangedFullRebuilds: unchangedStats.fullRebuilds,
      appendInspected: appendStats.sourceItemsInspected,
      appended: appendStats.appended,
      appendFullRebuilds: appendStats.fullRebuilds,
      deepRenderedGroups: deepStats.renderedGroups,
      deepViewportQueries: deepStats.viewportQueries,
      warmRenderedGroups: warmStats.renderedGroups,
      outputLines: deepLines.length,
      expectedLength: size + config.appendCount,
      actualLength: projection.length,
      groupCount: projection.groupCount,
    });

    // A rebuilt append path would still return the right model, so retain this
    // independently observable signal in the correctness record below.
    if (appendSync.rebuilt) {
      observations[observations.length - 1] = {
        ...(observations[observations.length - 1] as ProjectionObservation),
        appendFullRebuilds: appendStats.fullRebuilds + 1,
      };
    }
  }

  const smaller = observations[0] as ProjectionObservation;
  const larger = observations[1] as ProjectionObservation;
  const deepGrowth = ratio(larger.deepRenderedGroups, smaller.deepRenderedGroups);
  const unchangedGrowth = zeroSafeGrowth(
    larger.unchangedInspected,
    smaller.unchangedInspected,
  );
  const appendWorkGrowth = ratio(
    larger.appendInspected / config.appendCount,
    smaller.appendInspected / config.appendCount,
  );
  const maxExpectedRows = config.viewportRows + config.deepOffsetRows + 4;

  const gates = [
    gate(
      "unchanged sync inspects no durable history",
      observations.every((entry) => entry.unchangedInspected === 0),
      observations.map((entry) => entry.unchangedInspected),
      "0 at both history sizes",
    ),
    gate(
      "unchanged sync never rebuilds",
      observations.every((entry) => entry.unchangedFullRebuilds === 0),
      observations.map((entry) => entry.unchangedFullRebuilds),
      "0 at both history sizes",
    ),
    gate(
      "append sync work equals appended suffix",
      observations.every(
        (entry) =>
          entry.appendInspected === config.appendCount &&
          entry.appended === config.appendCount &&
          entry.appendFullRebuilds === 0,
      ),
      observations.map((entry) => ({
        inspected: entry.appendInspected,
        appended: entry.appended,
        rebuilds: entry.appendFullRebuilds,
      })),
      `${config.appendCount} inspected/appended and 0 rebuilds`,
    ),
    gate(
      "deep viewport work is independent of total resident history",
      deepGrowth !== null && deepGrowth <= 1.1,
      deepGrowth,
      "rendered-group growth ratio <= 1.10",
    ),
    gate(
      "warm deep viewport renders no additional groups",
      observations.every((entry) => entry.warmRenderedGroups === 0),
      observations.map((entry) => entry.warmRenderedGroups),
      "0 cache misses after the cold query",
    ),
    gate(
      "projection and viewport remain correct",
      observations.every(
        (entry) =>
          entry.actualLength === entry.expectedLength &&
          entry.groupCount === entry.expectedLength &&
          entry.outputLines >= config.viewportRows &&
          entry.outputLines <= maxExpectedRows,
      ),
      observations.map((entry) => ({
        length: entry.actualLength,
        groups: entry.groupCount,
        outputLines: entry.outputLines,
      })),
      `exact length/group count and ${config.viewportRows}..${maxExpectedRows} rendered rows`,
    ),
  ];

  const timings: Record<string, TimingDistribution> = {};
  for (const entry of observations) {
    const label = String(entry.size);
    timings[`build_${label}`] = summarizeDurations([entry.buildMs]);
    timings[`unchanged_sync_${label}`] = summarizeDurations(entry.unchangedDurations);
    timings[`append_sync_${label}`] = summarizeDurations([entry.appendMs]);
    timings[`deep_viewport_cold_${label}`] = summarizeDurations([entry.deepColdMs]);
    timings[`deep_viewport_warm_${label}`] = summarizeDurations(entry.deepWarmDurations);
  }

  return finishScenario({
    name: "projected-timeline",
    description:
      "ProjectedTimeline unchanged/append fast paths at two history sizes plus a deep row-indexed viewport.",
    sizes: {
      historyItems: [...config.timelineSizes],
      appendItems: config.appendCount,
      viewportRows: config.viewportRows,
      deepOffsetRows: config.deepOffsetRows,
    },
    timings,
    counters: {
      byHistorySize: Object.fromEntries(
        observations.map((entry) => [
          String(entry.size),
          {
            unchangedCalls: config.unchangedSamples,
            unchangedSourceItemsInspected: entry.unchangedInspected,
            unchangedFullRebuilds: entry.unchangedFullRebuilds,
            appendSourceItemsInspected: entry.appendInspected,
            appended: entry.appended,
            appendFullRebuilds: entry.appendFullRebuilds,
            deepRenderedGroups: entry.deepRenderedGroups,
            deepViewportQueries: entry.deepViewportQueries,
            warmRenderedGroups: entry.warmRenderedGroups,
          },
        ]),
      ),
    },
    ratios: {
      unchangedCounterGrowth100kVs10k: unchangedGrowth,
      appendWorkPerItemGrowthLargeVsSmall: appendWorkGrowth,
      deepRenderedGroupGrowthLargeVsSmall: deepGrowth,
      unchangedTimingGrowthDiagnostic: ratio(
        summarizeDurations(larger.unchangedDurations).medianMs,
        summarizeDurations(smaller.unchangedDurations).medianMs,
      ),
      deepColdTimingGrowthDiagnostic: ratio(larger.deepColdMs, smaller.deepColdMs),
    },
    correctness: {
      lengthsExact: observations.every((entry) => entry.actualLength === entry.expectedLength),
      groupCountsExact: observations.every((entry) => entry.groupCount === entry.expectedLength),
      viewportRowsBounded: observations.every(
        (entry) => entry.outputLines >= config.viewportRows && entry.outputLines <= maxExpectedRows,
      ),
    },
    gates,
    notes: [
      "Timing growth is diagnostic only; counter growth and exact fast-path behavior are gated.",
      "In quick mode the ratio labels still mean larger-vs-smaller even though sizes are 1k/10k.",
    ],
  });
}

function giantMarkdown(targetCharacters: number): string {
  const chunks: string[] = [];
  let characters = 0;
  let section = 0;
  while (characters < targetCharacters) {
    const chunk = [
      `## Performance section ${section}`,
      `- **bold ${section}** and _italic_ with \`code-${section}\` and [link](https://example.test/${section})`,
      `> viewport-safe quote ${"x".repeat(48)} ${section}`,
      `plain terminal markdown row ${section} ${"capybara ".repeat(6)}`,
    ].join("\n") + "\n";
    chunks.push(chunk);
    characters += chunk.length;
    section += 1;
  }
  return chunks.join("").slice(0, targetCharacters);
}

export function runGiantMarkdownScenario(config: HarnessConfig): ScenarioReport {
  const source = giantMarkdown(config.markdownCharacters);
  const coldDurations: number[] = [];
  const coldSignatures: string[] = [];
  let coldMisses = 0;
  let coldHits = 0;
  let warmCache: MarkdownRenderCache | undefined;
  let warmBaseline: ReturnType<typeof renderMarkdown> | undefined;

  for (let sample = 0; sample < config.markdownColdSamples; sample += 1) {
    const cache = new MarkdownRenderCache({
      maxEntries: 2,
      maxSourceCharacters: source.length + 1,
    });
    const start = performance.now();
    const lines = renderMarkdown(source, BLOCK_CONTEXT, {}, cache);
    coldDurations.push(elapsed(start));
    const stats = cache.stats;
    coldMisses += stats.misses;
    coldHits += stats.hits;
    coldSignatures.push(
      `${lines.length}:${lineText(lines[0] ?? { kind: "blank", segments: [] })}:${lineText(
        lines[lines.length - 1] ?? { kind: "blank", segments: [] },
      )}`,
    );
    if (warmCache === undefined) {
      warmCache = cache;
      warmBaseline = lines;
    }
  }

  const cache = warmCache as MarkdownRenderCache;
  const baseline = warmBaseline as ReturnType<typeof renderMarkdown>;
  cache.resetStats();
  const warmDurations: number[] = [];
  let sameReferenceCount = 0;
  for (let sample = 0; sample < config.markdownWarmSamples; sample += 1) {
    const start = performance.now();
    const lines = renderMarkdown(source, BLOCK_CONTEXT, {}, cache);
    warmDurations.push(elapsed(start));
    if (lines === baseline) sameReferenceCount += 1;
  }
  const warmStats = cache.stats;
  const signaturesAgree = new Set(coldSignatures).size === 1;
  const viewportRows = 40;
  const sourceIndex = createMarkdownSourceIndex(source);
  const lazyViewport = renderMarkdownTail(
    source,
    sourceIndex,
    BLOCK_CONTEXT,
    {},
    viewportRows,
  );
  const authoritativeViewport = baseline.slice(Math.max(0, baseline.length - viewportRows));
  const lazyViewportExact =
    JSON.stringify(lazyViewport.lines) === JSON.stringify(authoritativeViewport);
  const coldTiming = summarizeDurations(coldDurations);
  const warmTiming = summarizeDurations(warmDurations);
  const warmHitRatio = ratio(warmStats.hits, config.markdownWarmSamples);

  const gates = [
    gate(
      "every cold render is one cache miss",
      coldMisses === config.markdownColdSamples && coldHits === 0,
      { coldMisses, coldHits },
      `${config.markdownColdSamples} misses and 0 hits`,
    ),
    gate(
      "every warm render is a cache hit",
      warmStats.hits === config.markdownWarmSamples && warmStats.misses === 0,
      { hits: warmStats.hits, misses: warmStats.misses },
      `${config.markdownWarmSamples} hits and 0 misses`,
    ),
    gate(
      "warm cache returns the exact rendered value",
      sameReferenceCount === config.markdownWarmSamples && signaturesAgree,
      { sameReferenceCount, signaturesAgree },
      "all calls share the cold line array and all cold signatures agree",
    ),
    gate(
      "giant viewport is authoritative and history-bounded",
      lazyViewportExact &&
        lazyViewport.bounded &&
        lazyViewport.sourceLinesRendered <= viewportRows,
      {
        exact: lazyViewportExact,
        bounded: lazyViewport.bounded,
        sourceLinesRendered: lazyViewport.sourceLinesRendered,
        viewportRows,
      },
      `exact final ${viewportRows} rows after inspecting at most ${viewportRows} source lines`,
    ),
    gate(
      "giant source retention remains bounded",
      warmStats.entries === 1 && warmStats.sourceCharacters === source.length,
      { entries: warmStats.entries, sourceCharacters: warmStats.sourceCharacters },
      `1 entry retaining exactly ${source.length} source characters`,
    ),
  ];

  return finishScenario({
    name: "giant-markdown",
    description: "Cold and cache-warm rendering of one giant Markdown timeline item.",
    sizes: {
      sourceCharacters: source.length,
      sourceLines: source.split("\n").length,
      renderedLines: baseline.length,
      coldSamples: config.markdownColdSamples,
      warmSamples: config.markdownWarmSamples,
    },
    timings: {
      cold: coldTiming,
      warm: warmTiming,
    },
    counters: {
      coldCacheMisses: coldMisses,
      coldCacheHits: coldHits,
      warmCacheHits: warmStats.hits,
      warmCacheMisses: warmStats.misses,
      cacheEvictions: warmStats.evictions,
      retainedEntries: warmStats.entries,
      retainedSourceCharacters: warmStats.sourceCharacters,
      viewportSourceLinesRendered: lazyViewport.sourceLinesRendered,
      viewportOutputLines: lazyViewport.lines.length,
    },
    ratios: {
      warmHitRatio,
      retainedSourceRatio: ratio(warmStats.sourceCharacters, source.length),
      warmVsColdMedianTimingDiagnostic: ratio(warmTiming.medianMs, coldTiming.medianMs),
      warmVsColdP95TimingDiagnostic: ratio(warmTiming.p95Ms, coldTiming.p95Ms),
    },
    correctness: {
      nonEmptyOutput: baseline.length > 0,
      coldSignaturesAgree: signaturesAgree,
      warmReferenceIdentityPreserved: sameReferenceCount === config.markdownWarmSamples,
      lazyViewportExact,
      lazyViewportBounded: lazyViewport.bounded,
    },
    gates,
    notes: [
      "No wall-clock threshold is gated; cache operations and output identity are deterministic.",
      "The viewport gate compares lazy giant-Markdown output with the authoritative full renderer.",
    ],
  });
}

interface ReducerObservation {
  readonly historySize: number;
  readonly durations: readonly number[];
  readonly referenceChanges: number;
  readonly exactReconstructions: number;
  readonly finalSequenceMatches: number;
  readonly finalStatusMatches: number;
}

function deltaEvents(
  sessionId: string,
  startAfter: number,
  count: number,
): { readonly events: readonly CbcEvent<{ text: string; phase: "final"; itemId: string }>[]; readonly expected: string } {
  const sequencer = new EventSequencer(startAfter);
  const events: CbcEvent<{ text: string; phase: "final"; itemId: string }>[] = [];
  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = `δ${index.toString(36)};`;
    chunks.push(text);
    events.push(
      createEvent(
        sequencer,
        "assistant.delta",
        { text, phase: "final", itemId: "perf-final" },
        { sessionId, turnId: "perf-turn", agentId: "root" },
      ),
    );
  }
  return { events, expected: chunks.join("") };
}

export function runReducerDeltaScenario(config: HarnessConfig): ScenarioReport {
  const observations: ReducerObservation[] = [];

  for (const historySize of config.timelineSizes) {
    const sessionId = `perf-reducer-${historySize}`;
    const timeline: TimelineItem[] = makeNotices(historySize);
    const generated = deltaEvents(sessionId, historySize, config.reducerDeltaCount);
    const durations: number[] = [];
    let referenceChanges = 0;
    let exactReconstructions = 0;
    let finalSequenceMatches = 0;
    let finalStatusMatches = 0;

    for (let sample = 0; sample < config.reducerSamples; sample += 1) {
      let model: SessionViewModel = {
        ...emptyViewModel(sessionId),
        timeline,
        lastSequence: historySize,
      };
      const reconstructed: string[] = [];
      const start = performance.now();
      for (const event of generated.events) {
        model = reduce(model, event);
        reconstructed.push(event.payload.text);
        if (model.timeline !== timeline) referenceChanges += 1;
      }
      const rebuilt = reconstructed.join("");
      durations.push(elapsed(start));
      if (rebuilt === generated.expected) exactReconstructions += 1;
      if (model.lastSequence === historySize + config.reducerDeltaCount) {
        finalSequenceMatches += 1;
      }
      if (model.turnStatus === "sampling" && model.live.label === "Writing...") {
        finalStatusMatches += 1;
      }
    }

    observations.push({
      historySize,
      durations,
      referenceChanges,
      exactReconstructions,
      finalSequenceMatches,
      finalStatusMatches,
    });
  }

  const smaller = observations[0] as ReducerObservation;
  const larger = observations[1] as ReducerObservation;
  const expectedRuns = config.reducerSamples;
  const referenceGrowth = zeroSafeGrowth(larger.referenceChanges, smaller.referenceChanges);
  const gates = [
    gate(
      "delta burst never clones the resident timeline",
      observations.every((entry) => entry.referenceChanges === 0),
      observations.map((entry) => entry.referenceChanges),
      "0 reference changes at both history sizes",
    ),
    gate(
      "delta reconstruction surrogate is exact",
      observations.every((entry) => entry.exactReconstructions === expectedRuns),
      observations.map((entry) => entry.exactReconstructions),
      `${expectedRuns} exact reconstructions per size`,
    ),
    gate(
      "delta envelope state is reconstructed exactly",
      observations.every(
        (entry) =>
          entry.finalSequenceMatches === expectedRuns &&
          entry.finalStatusMatches === expectedRuns,
      ),
      observations.map((entry) => ({
        sequence: entry.finalSequenceMatches,
        status: entry.finalStatusMatches,
      })),
      `${expectedRuns} final sequence/status matches per size`,
    ),
    gate(
      "observed history-touch growth is constant",
      referenceGrowth <= 1,
      referenceGrowth,
      "zero-safe growth ratio <= 1.0",
    ),
  ];

  return finishScenario({
    name: "reducer-delta-burst",
    description:
      "Root assistant.delta bursts over small/large resident histories with an exact ordered-text reconstruction surrogate.",
    sizes: {
      historyItems: [...config.timelineSizes],
      deltasPerBurst: config.reducerDeltaCount,
      samplesPerSize: config.reducerSamples,
      reconstructedCharacters: generatedCharacterCount(config.reducerDeltaCount),
    },
    timings: Object.fromEntries(
      observations.map((entry) => [
        `burst_${entry.historySize}`,
        summarizeDurations(entry.durations),
      ]),
    ),
    counters: {
      byHistorySize: Object.fromEntries(
        observations.map((entry) => [
          String(entry.historySize),
          {
            reducerCalls: config.reducerDeltaCount * config.reducerSamples,
            timelineReferenceChanges: entry.referenceChanges,
            exactReconstructions: entry.exactReconstructions,
          },
        ]),
      ),
    },
    ratios: {
      timelineReferenceChangeGrowthLargeVsSmall: referenceGrowth,
      callsPerDelta: 1,
      medianTimingGrowthDiagnostic: ratio(
        summarizeDurations(larger.durations).medianMs,
        summarizeDurations(smaller.durations).medianMs,
      ),
      p95TimingGrowthDiagnostic: ratio(
        summarizeDurations(larger.durations).p95Ms,
        summarizeDurations(smaller.durations).p95Ms,
      ),
    },
    correctness: {
      exactOrderedText: observations.every((entry) => entry.exactReconstructions === expectedRuns),
      timelineIdentityPreserved: observations.every((entry) => entry.referenceChanges === 0),
      finalSequenceAndLiveStateExact: observations.every(
        (entry) => entry.finalSequenceMatches === expectedRuns && entry.finalStatusMatches === expectedRuns,
      ),
    },
    gates,
    notes: [
      "The reducer intentionally does not own root provisional text; the ordered collector is the reconstruction surrogate.",
      "Timing is diagnostic; timeline identity is the deterministic no-history-copy operation counter.",
    ],
  });
}

function generatedCharacterCount(count: number): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) total += `δ${index.toString(36)};`.length;
  return total;
}

export function runLiveSpanCleanupScenario(config: HarnessConfig): ScenarioReport {
  const registry = new LiveSpanRegistry();
  const cycleDurations: number[] = [];
  let peakResident = 0;
  let appendCalls = 0;
  let landed = 0;
  let closed = 0;
  let reconciliationFailures = 0;
  const landedPerCycle = Math.floor(config.liveSpanConcurrency / 2);

  for (let cycle = 0; cycle < config.liveSpanCycles; cycle += 1) {
    const turnId = `perf-turn-${cycle}`;
    const expectedByAgent = new Map<string, string>();
    const start = performance.now();
    for (let agentIndex = 0; agentIndex < config.liveSpanConcurrency; agentIndex += 1) {
      const agentId = `agent-${agentIndex}`;
      const itemId = `item-${cycle}-${agentIndex}`;
      const chunks: string[] = [];
      for (let chunkIndex = 0; chunkIndex < config.liveSpanChunks; chunkIndex += 1) {
        const text = `${cycle}:${agentIndex}:${chunkIndex}:${"x".repeat(48)};`;
        chunks.push(text);
        registry.append({
          text,
          phase: "final",
          turnId,
          agentId,
          itemId,
          nowMs: cycle,
        });
        appendCalls += 1;
      }
      expectedByAgent.set(agentId, chunks.join(""));
    }
    peakResident = Math.max(peakResident, registry.snapshot().length);

    for (let agentIndex = 0; agentIndex < landedPerCycle; agentIndex += 1) {
      const agentId = `agent-${agentIndex}`;
      const match = registry.reconcile(
        {
          text: expectedByAgent.get(agentId) ?? "",
          phase: "final",
          turnId,
          agentId,
          itemId: `item-${cycle}-${agentIndex}`,
        },
        cycle + 1,
      );
      if (match === undefined) reconciliationFailures += 1;
      else landed += 1;
    }
    registry.closeTurn(turnId, "cancelled", cycle + 1);
    closed += config.liveSpanConcurrency - landedPerCycle;
    cycleDurations.push(elapsed(start));
  }

  const finalSnapshot = registry.snapshot();
  const expectedLanded = config.liveSpanCycles * landedPerCycle;
  const expectedClosed = config.liveSpanCycles * (config.liveSpanConcurrency - landedPerCycle);
  const cleanupRatio = ratio(landed + closed, config.liveSpanCycles * config.liveSpanConcurrency);
  const gates = [
    gate(
      "resident spans are bounded by active concurrency",
      peakResident <= config.liveSpanConcurrency,
      peakResident,
      `<= ${config.liveSpanConcurrency}`,
    ),
    gate(
      "landed and terminal spans are deleted",
      finalSnapshot.length === 0,
      finalSnapshot.length,
      "0 retained spans",
    ),
    gate(
      "all matching durable spans reconcile",
      landed === expectedLanded && reconciliationFailures === 0,
      { landed, reconciliationFailures },
      `${expectedLanded} landed and 0 failures`,
    ),
    gate(
      "all non-landed spans receive terminal cleanup",
      closed === expectedClosed && cleanupRatio === 1,
      { closed, cleanupRatio },
      `${expectedClosed} closed and cleanup ratio 1`,
    ),
  ];

  return finishScenario({
    name: "live-span-cleanup",
    description: "Repeated concurrent provisional spans reconcile/close without retaining prior response text.",
    sizes: {
      cycles: config.liveSpanCycles,
      activeConcurrency: config.liveSpanConcurrency,
      chunksPerSpan: config.liveSpanChunks,
      totalSpans: config.liveSpanCycles * config.liveSpanConcurrency,
    },
    timings: {
      cycle: summarizeDurations(cycleDurations),
    },
    counters: {
      appendCalls,
      landed,
      closed,
      reconciliationFailures,
      peakResidentSpans: peakResident,
      finalResidentSpans: finalSnapshot.length,
      finalResidentCharacters: finalSnapshot.reduce((total, span) => total + span.text.length, 0),
    },
    ratios: {
      cleanupRatio,
      peakVsConcurrency: ratio(peakResident, config.liveSpanConcurrency),
      appendCallsPerSpan: ratio(
        appendCalls,
        config.liveSpanCycles * config.liveSpanConcurrency,
      ),
      finalResidentRatio: ratio(finalSnapshot.length, config.liveSpanConcurrency),
    },
    correctness: {
      allReconciliationsMatched: reconciliationFailures === 0,
      noClosedTextRetained: finalSnapshot.length === 0,
      peakEqualsActiveSet: peakResident === config.liveSpanConcurrency,
    },
    gates,
  });
}

interface BatchObservation {
  readonly count: number;
  readonly bytes: number;
  readonly firstId?: string;
  readonly lastId?: string;
}

class FakeJournalTransport implements JournalTransport {
  readonly batches: BatchObservation[] = [];
  #nextSequence = 0;

  async open(_params: Record<string, unknown>): Promise<unknown> {
    return {};
  }

  async append(params: Record<string, unknown>): Promise<unknown> {
    const events = Array.isArray(params.events)
      ? params.events.filter(
          (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
        )
      : [];
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const event of events) bytes += encoder.encode(JSON.stringify(event)).byteLength + 1;
    const first = events[0];
    const last = events[events.length - 1];
    this.batches.push({
      count: events.length,
      bytes,
      ...(typeof first?.id === "string" ? { firstId: first.id } : {}),
      ...(typeof last?.id === "string" ? { lastId: last.id } : {}),
    });
    const acknowledged = events.map((event) => ({
      id: event.id,
      sequence: ++this.#nextSequence,
    }));
    return {
      appended: acknowledged.length,
      lastSequence: this.#nextSequence,
      events: acknowledged,
    };
  }

  async snapshot(_params: Record<string, unknown>): Promise<unknown> {
    return {};
  }

  async load(_params: Record<string, unknown>): Promise<unknown> {
    return {};
  }
}

export async function runSessionRecorderBatchingScenario(): Promise<ScenarioReport> {
  const countTransport = new FakeJournalTransport();
  const countDurable: string[] = [];
  const countRecorder = new SessionRecorder({
    sessionId: "perf-count-batching",
    transport: countTransport,
    onDurable: (event) => countDurable.push(event.id),
  });
  const countEvents = JOURNAL_BATCH_MAX_EVENTS * 2 + 1;
  const countEmitDurations: number[] = [];
  for (let index = 0; index < countEvents; index += 1) {
    const start = performance.now();
    countRecorder.emit("user.message", { text: `count-${index}` });
    countEmitDurations.push(elapsed(start));
  }
  let start = performance.now();
  await countRecorder.flush();
  const countFlushMs = elapsed(start);

  const byteTransport = new FakeJournalTransport();
  const byteDurable: string[] = [];
  const byteRecorder = new SessionRecorder({
    sessionId: "perf-byte-batching",
    transport: byteTransport,
    onDurable: (event) => byteDurable.push(event.id),
  });
  // Two individually valid events whose aggregate necessarily crosses the cap.
  const bytePayloadCharacters = Math.max(
    1,
    Math.floor(JOURNAL_BATCH_MAX_BYTES * 0.55) - 2_048,
  );
  const giantPayload = "b".repeat(bytePayloadCharacters);
  const byteEmitDurations: number[] = [];
  for (let index = 0; index < 2; index += 1) {
    start = performance.now();
    byteRecorder.emit("user.message", { text: giantPayload, marker: index });
    byteEmitDurations.push(elapsed(start));
  }
  start = performance.now();
  await byteRecorder.flush();
  const byteFlushMs = elapsed(start);

  const countShape = countTransport.batches.map((batch) => batch.count);
  const byteShape = byteTransport.batches.map((batch) => batch.count);
  const expectedCountShape = [
    JOURNAL_BATCH_MAX_EVENTS,
    JOURNAL_BATCH_MAX_EVENTS,
    1,
  ];
  const countShapeExact = JSON.stringify(countShape) === JSON.stringify(expectedCountShape);
  const byteShapeExact = JSON.stringify(byteShape) === JSON.stringify([1, 1]);
  const allBatchesWithinLimits = [...countTransport.batches, ...byteTransport.batches].every(
    (batch) => batch.count <= JOURNAL_BATCH_MAX_EVENTS && batch.bytes <= JOURNAL_BATCH_MAX_BYTES,
  );

  const gates = [
    gate(
      "32-count batching boundary is exact",
      countShapeExact,
      countShape,
      JSON.stringify(expectedCountShape),
    ),
    gate(
      "byte boundary splits two over-cap aggregate events",
      byteShapeExact,
      byteShape,
      "[1,1]",
    ),
    gate(
      "every transport batch respects count and byte caps",
      allBatchesWithinLimits,
      [...countTransport.batches, ...byteTransport.batches].map((batch) => ({
        count: batch.count,
        bytes: batch.bytes,
      })),
      `count <= ${JOURNAL_BATCH_MAX_EVENTS}, bytes <= ${JOURNAL_BATCH_MAX_BYTES}`,
    ),
    gate(
      "fake transport acknowledges every event exactly once",
      countDurable.length === countEvents && byteDurable.length === 2,
      { countDurable: countDurable.length, byteDurable: byteDurable.length },
      `${countEvents} count events and 2 byte events`,
    ),
  ];

  const totalBatches = countTransport.batches.length + byteTransport.batches.length;
  return finishScenario({
    name: "session-recorder-batching",
    description: "SessionRecorder count/byte batching against an ordered acknowledging fake transport.",
    sizes: {
      countEvents,
      byteEvents: 2,
      bytePayloadCharacters,
      maxEventsPerBatch: JOURNAL_BATCH_MAX_EVENTS,
      maxBytesPerBatch: JOURNAL_BATCH_MAX_BYTES,
    },
    timings: {
      count_emit: summarizeDurations(countEmitDurations),
      count_flush: summarizeDurations([countFlushMs]),
      byte_emit: summarizeDurations(byteEmitDurations),
      byte_flush: summarizeDurations([byteFlushMs]),
    },
    counters: {
      countBatchShape: countShape,
      countBatchBytes: countTransport.batches.map((batch) => batch.bytes),
      byteBatchShape: byteShape,
      byteBatchBytes: byteTransport.batches.map((batch) => batch.bytes),
      appendCalls: totalBatches,
      durableCallbacks: countDurable.length + byteDurable.length,
    },
    ratios: {
      durableCallbackRatio: ratio(countDurable.length + byteDurable.length, countEvents + 2),
      countBatchFillRatio: ratio(countShape[0] ?? 0, JOURNAL_BATCH_MAX_EVENTS),
      largestByteBatchFillRatio: ratio(
        Math.max(...byteTransport.batches.map((batch) => batch.bytes)),
        JOURNAL_BATCH_MAX_BYTES,
      ),
      appendCallsPerEvent: ratio(totalBatches, countEvents + 2),
    },
    correctness: {
      countShapeExact,
      byteShapeExact,
      orderedAcknowledgements: countDurable.length === countEvents && byteDurable.length === 2,
      everyBatchWithinLimits: allBatchesWithinLimits,
    },
    gates,
    notes: ["Emit/flush timing is diagnostic; exact transport batch shapes are gated."],
  });
}

export function runUnicodeWidthHotloopScenario(config: HarnessConfig): ScenarioReport {
  const durations: number[] = [];
  const samples = ["hello world", "Capybara-123", "한글", "👨‍👩‍👧", "e\u0301"];
  resetWidthDiagnostics();
  let checksum = 0;
  const start = performance.now();
  for (let index = 0; index < config.widthIterations; index += 1) {
    const value = samples[index % samples.length] ?? "";
    checksum += stringWidth(value);
    checksum += measureAndTruncate(`${value} ${value}`, 24).width;
  }
  durations.push(elapsed(start));
  const diagnostics = widthDiagnosticsForHarness();
  const gates = [
    gate(
      "printable ASCII width uses no grapheme array allocation",
      diagnostics.graphemeArrayAllocations === 0,
      diagnostics.graphemeArrayAllocations,
      "0 grapheme arrays",
    ),
    gate(
      "Unicode reference widths remain exact",
      stringWidth("한글") === 4 && stringWidth("👨‍👩‍👧") === 2 && stringWidth("e\u0301") === 1,
      { hangul: stringWidth("한글"), emoji: stringWidth("👨‍👩‍👧"), combining: stringWidth("e\u0301") },
      "Hangul=4, emoji ZWJ=2, combining=1",
    ),
  ];
  return finishScenario({
    name: "unicode-width-hotloop",
    description: "Width kernel fast path and allocation gate across ASCII and Unicode labels.",
    sizes: { iterations: config.widthIterations, sampleKinds: samples.length },
    timings: { width_hotloop: summarizeDurations(durations) },
    counters: { widthOperations: config.widthIterations * samples.length, checksum, ...diagnostics },
    ratios: { graphemeArraysPerIteration: ratio(diagnostics.graphemeArrayAllocations, config.widthIterations) },
    correctness: { unicodeMatrix: gates[1]?.pass === true },
    gates,
    notes: ["Wall-clock is diagnostic; allocation and Unicode semantics are gated."],
  });
}

function widthDiagnosticsForHarness(): { readonly graphemeArrayAllocations: number } {
  // Keep the harness independent of the optional segmenter detail while exposing
  // the deterministic allocation counter.
  return { graphemeArrayAllocations: widthDiagnostics().graphemeArrayAllocations };
}

export function runStreamingMarkdownGrowthScenario(config: HarnessConfig): ScenarioReport {
  const index = new AppendableMarkdownSourceIndex();
  const durations: number[] = [];
  const chunk = "streaming markdown line with **content**\n".repeat(32).slice(0, 1_024);
  const start = performance.now();
  for (let count = 0; count < config.streamingGrowthChunks; count += 1) {
    index.append(chunk);
  }
  durations.push(elapsed(start));
  const fullText = index.fullText();
  const stats = index.stats;
  const finalCharacters = chunk.length * config.streamingGrowthChunks;
  const gates = [
    gate(
      "append source inspection remains linear",
      stats.sourceCharactersInspected <= finalCharacters * 2,
      stats.sourceCharactersInspected,
      `<= ${finalCharacters * 2} inspected characters`,
    ),
    gate(
      "append path does not rebuild full text per delta",
      stats.fullTextCalls <= 1,
      stats.fullTextCalls,
      "at most one fullText call",
    ),
    gate("all safe chunks remain chunkable", index.chunkable, index.chunkable, "true"),
    gate("full text length is exact", fullText.length === finalCharacters, fullText.length, String(finalCharacters)),
  ];
  return finishScenario({
    name: "streaming-markdown-growth",
    description: "Arbitrary streaming Markdown chunks with incremental line/fence state.",
    sizes: { chunks: config.streamingGrowthChunks, chunkCharacters: chunk.length, finalCharacters },
    timings: { append: summarizeDurations(durations) },
    counters: { ...stats, lineCount: index.lineCount },
    ratios: {
      inspectedToFinalCharacters: ratio(stats.sourceCharactersInspected, finalCharacters),
      fullTextCallsPerChunk: ratio(stats.fullTextCalls, config.streamingGrowthChunks),
    },
    correctness: { exactLength: fullText.length === finalCharacters, chunkable: index.chunkable },
    gates,
  });
}

export function runActiveFrameSurrogateScenario(config: HarnessConfig): ScenarioReport {
  const model: SessionViewModel = {
    ...emptyViewModel("perf-active-frame"),
    timeline: makeNotices(120),
    lastSequence: 120,
    currentTurnId: "turn-active",
    turnStatus: "sampling",
    live: { kind: "working", label: "Thinking...", interruptHint: "esc" },
  };
  const registry = new LiveSpanRegistry();
  const projection = new ProjectedTimeline();
  const durations: number[] = [];
  const frameLines: number[] = [];

  for (let frame = 0; frame < config.activeFrameSamples; frame += 1) {
    registry.append({
      text: frame === 0 ? "stream" : " chunk",
      phase: "commentary",
      turnId: "turn-active",
      agentId: "root",
      nowMs: frame,
    });
    const live = registry.rootViews("turn-active").map((view) => ({
      id: "streaming-commentary",
      revision: view.revision,
      sourceView: view.sourceView,
      item: {
        type: "commentary" as const,
        id: "streaming-commentary",
        sequence: 121,
        variant: "commentary" as const,
        text: view.fullText(),
      },
    }));
    const start = performance.now();
    const rendered = renderSessionFrame({
      columns: 120,
      rows: 40,
      theme: defaultTheme("none"),
      capabilities: { ...TERMINAL_CAPABILITIES, columns: 120, rows: 40 },
      model,
      composer: { text: "draft", cursor: 5 },
      sidebarVisible: true,
      mcpServers: [],
      lspServers: [],
      workspacePath: "/perf/workspace",
      notices: [],
      timelineScrollOffsetFromBottom: 0,
      timelineProjection: projection,
      streamingViews: live,
      liveFrame: frame,
    });
    durations.push(elapsed(start));
    frameLines.push(rendered.lines.length);
  }
  const stats = projection.stats;
  const gates = [
    gate("active frame always fits terminal height", frameLines.every((count) => count === 40), frameLines, "40 lines"),
    gate("streaming projection computes no mutable text fingerprint", stats.itemFingerprintsComputed === 0, stats.itemFingerprintsComputed, "0 fingerprints"),
    gate("streaming revisions reach the projection", stats.streamingRevisionUpdates >= config.activeFrameSamples, stats.streamingRevisionUpdates, `>= ${config.activeFrameSamples}`),
  ];
  return finishScenario({
    name: "active-frame-surrogate",
    description: "Two-column active streaming frame with a reused projection.",
    sizes: { frames: config.activeFrameSamples, historyItems: model.timeline.length, columns: 120, rows: 40 },
    timings: { frame: summarizeDurations(durations) },
    counters: { ...stats, renderedFrames: frameLines.length },
    ratios: { fingerprintsPerFrame: ratio(stats.itemFingerprintsComputed, config.activeFrameSamples) },
    correctness: { exactHeight: frameLines.every((count) => count === 40) },
    gates,
  });
}

export function runComposerEditLatencyScenario(config: HarnessConfig): ScenarioReport {
  const composer = new ComposerSession();
  const draft = "x".repeat(config.composerDraft);
  const durations: number[] = [];
  const start = performance.now();
  composer.set(draft, draft.length);
  durations.push(elapsed(start));
  const editStart = performance.now();
  composer.handle({ key: "backspace" }, { turnRunning: false });
  composer.handle({ key: "text", text: "y" }, { turnRunning: false });
  composer.handle({ key: "backspace" }, { turnRunning: false });
  durations.push(elapsed(editStart));
  const gates = [
    gate("large draft edit preserves grapheme cursor semantics", composer.cursor === config.composerDraft - 1, composer.cursor, String(config.composerDraft - 1)),
    gate("large draft remains bounded and non-empty", composer.text.length === config.composerDraft - 1, composer.text.length, String(config.composerDraft - 1)),
  ];
  return finishScenario({
    name: "composer-edit-latency",
    description: "Large draft set plus insert/backspace reducer workload.",
    sizes: { draftCharacters: config.composerDraft, edits: 3 },
    timings: { set_and_edit: summarizeDurations(durations) },
    counters: { graphemes: composer.cursor, finalCharacters: composer.text.length },
    ratios: { editToDraftRatio: ratio(durations[1] ?? 0, durations[0] ?? 0) },
    correctness: { cursorAtTail: composer.cursor === config.composerDraft - 1 },
    gates,
  });
}

export function runPathCompletionMaxIndexScenario(config: HarnessConfig): ScenarioReport {
  const index = new WorkspacePathMentionIndex();
  index.replaceFiles(Array.from({ length: config.pathIndexEntries }, (_, entry) => ({
    path: `src/file-${entry}.ts`,
  })));
  const start = performance.now();
  const candidates = index.candidates("src/file-", { limit: 100 });
  const duration = elapsed(start);
  const stats = index.stats;
  const gates = [
    gate("path completion returns the bounded limit", candidates.length === 100, candidates.length, "100 candidates"),
    gate("path completion performs no full sort", stats.fullSortCalls === 0, stats.fullSortCalls, "0 full sort calls"),
    gate("path completion retains no oversized ranked array", stats.rankedEntriesRetained <= 100, stats.rankedEntriesRetained, "<= 100 ranked entries"),
  ];
  return finishScenario({
    name: "path-completion-max-index",
    description: "Normalized path index prefix query with bounded top-K ranking.",
    sizes: { requestedFiles: config.pathIndexEntries, indexedEntries: index.size, resultLimit: 100 },
    timings: { query: summarizeDurations([duration]) },
    counters: { ...stats, returnedCandidates: candidates.length },
    ratios: { inspectedToIndexed: ratio(stats.inspectedEntries, index.size) },
    correctness: { resultLimit: candidates.length === 100 },
    gates,
  });
}

export function runAnsiDiffAndBackpressureScenario(config: HarnessConfig): ScenarioReport {
  const writes: string[] = [];
  let blocked = true;
  let drainListener: (() => void) | undefined;
  const writer = new TerminalFrameWriter({
    write(value) {
      if (blocked) return false;
      writes.push(value);
      return true;
    },
    onDrain(listener) {
      drainListener = listener;
      return () => {
        if (drainListener === listener) drainListener = undefined;
      };
    },
  });
  const cursor = "\u001B[1;1H";
  writer.writeFrame(["one", "two"], cursor, { full: true });
  for (let index = 0; index < config.ansiFrameSamples; index += 1) {
    writer.writeFrame([`latest-${index}`, "two"], cursor);
  }
  blocked = false;
  drainListener?.();
  writer.writeFrame([`latest-${config.ansiFrameSamples}`, "changed"], cursor);
  const stats = writer.stats;
  const normalDiff = writes[1] ?? "";
  const gates = [
    gate("backpressure keeps at most one pending frame", stats.maxPendingFrames <= 1, stats.maxPendingFrames, "<= 1"),
    gate("new frames coalesce while blocked", stats.framesCoalesced >= config.ansiFrameSamples, stats.framesCoalesced, `>= ${config.ansiFrameSamples}`),
    gate("normal diff frame does not clear the full screen", !normalDiff.includes("\u001B[2J"), normalDiff.includes("\u001B[2J"), "false"),
    gate("changed-row output remains bounded", stats.outputRowsChanged <= config.ansiFrameSamples + 3, stats.outputRowsChanged, `<= ${config.ansiFrameSamples + 3}`),
  ];
  return finishScenario({
    name: "ansi-diff-and-backpressure",
    description: "ANSI row diff output with latest-frame-only backpressure handling.",
    sizes: { frames: config.ansiFrameSamples + 2, rows: 2 },
    timings: { write: summarizeDurations([]) },
    counters: { ...stats, writes: writes.length },
    ratios: { coalescedPerSubmitted: ratio(stats.framesCoalesced, stats.framesSubmitted) },
    correctness: { pendingBounded: stats.maxPendingFrames <= 1, normalDiff: !normalDiff.includes("\u001B[2J") },
    gates,
  });
}

export function runIdleFrameSurrogateScenario(config: HarnessConfig): ScenarioReport {
  const model = emptyViewModel("perf-idle-frame");
  const theme = defaultTheme("none");
  const durations: number[] = [];
  const serializedFrames: string[] = [];
  const lineCounts: number[] = [];

  for (let frame = 0; frame < config.idleFrames; frame += 1) {
    const start = performance.now();
    const rendered = renderSessionFrame({
      columns: TERMINAL_CAPABILITIES.columns,
      rows: TERMINAL_CAPABILITIES.rows,
      theme,
      capabilities: TERMINAL_CAPABILITIES,
      model,
      composer: { text: "", cursor: 0 },
      mcpServers: [],
      lspServers: [],
      workspacePath: "/perf/workspace",
      notices: [],
      timelineScrollOffsetFromBottom: 0,
      liveFrame: frame,
    });
    durations.push(elapsed(start));
    serializedFrames.push(JSON.stringify(rendered.lines));
    lineCounts.push(rendered.lines.length);
  }

  const uniqueFrames = new Set(serializedFrames).size;
  const changedFrames = Math.max(0, uniqueFrames - 1);
  const outputBytes = serializedFrames[0]?.length ?? 0;
  const gates = [
    gate(
      "idle liveFrame changes produce no visual frame",
      uniqueFrames === 1,
      uniqueFrames,
      "1 unique semantic frame",
    ),
    gate(
      "idle frame always fits terminal rows",
      lineCounts.every((count) => count === TERMINAL_CAPABILITIES.rows),
      lineCounts,
      `${TERMINAL_CAPABILITIES.rows} lines for every frame value`,
    ),
  ];

  return finishScenario({
    name: "idle-frame-surrogate",
    description:
      "Public renderSessionFrame surrogate: changing animation frame while idle must not change semantic output.",
    sizes: {
      frameValues: config.idleFrames,
      columns: TERMINAL_CAPABILITIES.columns,
      rows: TERMINAL_CAPABILITIES.rows,
      serializedOutputBytes: outputBytes,
    },
    timings: {
      render: summarizeDurations(durations),
    },
    counters: {
      renderCalls: config.idleFrames,
      uniqueSemanticFrames: uniqueFrames,
      observableAnimatedTransitions: changedFrames,
    },
    ratios: {
      changedFrameRatio: ratio(changedFrames, Math.max(1, config.idleFrames - 1)),
      uniqueOutputRatio: ratio(uniqueFrames, config.idleFrames),
    },
    correctness: {
      outputStableAcrossLiveFrame: uniqueFrames === 1,
      exactTerminalHeight: lineCounts.every((count) => count === TERMINAL_CAPABILITIES.rows),
    },
    gates,
    notes: [
      "This is a no-frame semantic surrogate; scheduler wake-up behavior is not exported by the inspected public API.",
    ],
  });
}

function storedPerfEvent(sessionId: string, sequence: number): StoredJournalEvent {
  return {
    sessionId,
    sequence,
    id: `stored-${sequence}`,
    kind: "assistant.commentary",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "1.0",
    payload: { text: `page-event-${sequence}` },
    prevHash: sequence === 1 ? "genesis" : `hash-${sequence - 1}`,
    eventHash: `hash-${sequence}`,
    streamSequence: sequence,
  };
}

function encodedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

class FakePagedLoadTransport implements SessionLoadTransport {
  readonly calls: Record<string, unknown>[] = [];
  readonly pageSizes: number[] = [];
  readonly #events: readonly StoredJournalEvent[];
  readonly #sessionId: string;

  constructor(sessionId: string, eventCount: number) {
    this.#sessionId = sessionId;
    this.#events = Array.from({ length: eventCount }, (_, index) =>
      storedPerfEvent(sessionId, index + 1),
    );
  }

  async load(params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ ...params });
    if (params.sessionId !== this.#sessionId) throw new Error("unexpected paging session");
    const requested = typeof params.limit === "number" ? Math.floor(params.limit) : 1_000;
    const limit = Math.max(1, requested);
    const total = this.#events.length;
    const backward = typeof params.beforeSequence === "number";
    let start: number;
    let end: number;
    let direction: "forward" | "backward";
    let anchorSequence: number;
    let anchorHash: string;

    if (backward) {
      const before = Math.max(1, Math.floor(params.beforeSequence as number));
      end = Math.min(total, before - 1);
      start = Math.max(1, end - limit + 1);
      direction = "backward";
      anchorSequence = before;
      anchorHash = before > total ? `hash-${total}` : `hash-${before}`;
    } else {
      const after =
        typeof params.afterSequence === "number"
          ? Math.max(0, Math.floor(params.afterSequence))
          : 0;
      start = after + 1;
      end = Math.min(total, after + limit);
      direction = "forward";
      anchorSequence = after;
      anchorHash = after === 0 ? "genesis" : `hash-${after}`;
      if (typeof params.afterHash === "string" && params.afterHash !== anchorHash) {
        throw new Error("paging cursor hash changed");
      }
    }

    const events = start <= end ? this.#events.slice(start - 1, end) : [];
    this.pageSizes.push(events.length);
    const through = { sequence: total, eventHash: `hash-${total}` };
    const first = events[0];
    const last = events[events.length - 1];
    const maxBytes =
      typeof params.maxBytes === "number" ? Math.floor(params.maxBytes) : DEFAULT_SESSION_PAGE_BYTES;
    return {
      events,
      page: {
        direction,
        anchorSequence,
        anchorHash,
        ...(first !== undefined
          ? { firstSequence: first.sequence, firstPrevHash: first.prevHash }
          : {}),
        ...(last !== undefined
          ? { lastSequence: last.sequence, lastEventHash: last.eventHash }
          : {}),
        through,
        journalHead: through,
        hasMoreBefore: start > 1,
        hasMoreAfter: end < total,
        encodedBytes: encodedJsonBytes(events),
        maxBytes,
        itemLimit: limit,
        truncatedByBytes: false,
        oversizedSingleEvent: false,
      },
      ...(start > 1
        ? {
            earlierPage: {
              beforeSequence: start,
              beforeHash: first?.prevHash ?? `hash-${start - 1}`,
              throughSequence: total,
              throughHash: `hash-${total}`,
            },
          }
        : {}),
      ...(end < total
        ? {
            laterPage: {
              afterSequence: end,
              afterHash: `hash-${end}`,
              throughSequence: total,
              throughHash: `hash-${total}`,
            },
          }
        : {}),
      tailOnly: !backward,
      eventCount: total,
    };
  }
}

interface PerfResidentViewItem {
  readonly sequence: number;
  readonly type: "tool" | "notice";
  readonly status?: "running";
  readonly [key: string]: unknown;
}

export async function runResidentWindowAndPagingScenario(
  config: HarnessConfig,
): Promise<ScenarioReport> {
  const runtimeExportNames = Object.keys(sessionDomainExports).sort();
  const relevantExports = runtimeExportNames.filter((name) =>
    /(page|paging|resident|window)/iu.test(name),
  );
  const pagingExports = relevantExports.filter((name) => /(page|paging|window)/iu.test(name));
  const requiredPersistenceExports = [
    "ResidentJournalWindow",
    "boundResidentViewModel",
    "iterateReplayTailPages",
    "replayJournalTail",
    "loadEarlierJournalPage",
  ];
  const sessionId = "perf-resident-window";

  // Existing reducer-level child detail residency contract.
  const taskId = "perf-task";
  const sequencer = new EventSequencer();
  let model = emptyViewModel(sessionId);
  model = reduce(
    model,
    createEvent(
      sequencer,
      "task.created",
      {
        taskId,
        role: "perf",
        title: "Resident child-call window",
        goal: "Bound retained details",
        constraints: [],
        contract: [],
      },
      { sessionId },
    ),
  );

  const totalCalls = MAX_RESIDENT_SUBAGENT_EVENTS * config.residentEventMultiplier;
  const pairDurations: number[] = [];
  for (let index = 0; index < totalCalls; index += 1) {
    const callId = `resident-call-${index}`;
    const start = performance.now();
    model = reduce(
      model,
      createEvent(
        sequencer,
        "tool.started",
        { callId, toolId: "fs.read", display: `/tmp/file-${index}` },
        { sessionId, agentId: taskId },
      ),
    );
    model = reduce(
      model,
      createEvent(
        sequencer,
        "tool.completed",
        { callId, summary: `read ${index}`, durationMs: 1 },
        { sessionId, agentId: taskId },
      ),
    );
    pairDurations.push(elapsed(start));
  }

  const task = model.timeline.find(
    (item): item is Extract<TimelineItem, { type: "task" }> =>
      item.type === "task" && item.taskId === taskId,
  );
  const childResidentCount = task?.subagentEvents.length ?? -1;
  const totalObserved = task?.subagentEventCount ?? -1;
  const childOmitted = task?.subagentEventsOmitted ?? -1;
  const expectedChildOmitted = totalCalls - MAX_RESIDENT_SUBAGENT_EVENTS;
  const expectedOldest = `resident-call-${expectedChildOmitted}`;
  const oldestResident = task?.subagentEvents[0]?.callId;
  const childResidentExact =
    childResidentCount === MAX_RESIDENT_SUBAGENT_EVENTS &&
    totalObserved === totalCalls &&
    childOmitted === expectedChildOmitted &&
    oldestResident === expectedOldest;

  // New page-wise replay: the fake freezes a through hash and never materializes
  // more than pageItems events in a response.
  const pagingTransport = new FakePagedLoadTransport(sessionId, config.pagingEvents);
  let start = performance.now();
  const replayed = await replayJournalTail<number>(pagingTransport, {
    sessionId,
    pageItems: config.pagingPageItems,
    pageBytes: DEFAULT_SESSION_PAGE_BYTES,
    seed: () => 0,
    apply: (sum, event) => sum + event.sequence,
  });
  const replayMs = elapsed(start);
  const expectedPages = Math.ceil(config.pagingEvents / config.pagingPageItems);
  const expectedSequenceSum = (config.pagingEvents * (config.pagingEvents + 1)) / 2;
  const frozenFollowupCalls = pagingTransport.calls.slice(1).filter(
    (call) =>
      call.throughSequence === config.pagingEvents &&
      call.throughHash === `hash-${config.pagingEvents}`,
  ).length;
  const replayExact =
    replayed.eventsApplied === config.pagingEvents &&
    replayed.pagesLoaded === expectedPages &&
    replayed.state === expectedSequenceSum &&
    replayed.journalSequence === config.pagingEvents &&
    replayed.through.sequence === config.pagingEvents &&
    Math.max(...pagingTransport.pageSizes) <= config.pagingPageItems;

  // Explicit earlier-page cursor traversal complements forward tail replay.
  const earlierTransport = new FakePagedLoadTransport(sessionId, config.pagingEvents);
  const newestRaw = await earlierTransport.load({
    sessionId,
    beforeSequence: config.pagingEvents + 1,
    beforeHash: `hash-${config.pagingEvents}`,
    throughSequence: config.pagingEvents,
    throughHash: `hash-${config.pagingEvents}`,
    limit: config.pagingPageItems,
    maxBytes: DEFAULT_SESSION_PAGE_BYTES,
  });
  const newestPage: SessionJournalPage = validateSessionJournalPage(newestRaw, {
    expectedSessionId: sessionId,
  });
  start = performance.now();
  const earlierPage = await loadEarlierJournalPage(
    earlierTransport,
    sessionId,
    newestPage,
    { pageItems: config.pagingPageItems, pageBytes: DEFAULT_SESSION_PAGE_BYTES },
  );
  const earlierLoadMs = elapsed(start);
  const earlierPageExact =
    earlierPage !== undefined &&
    earlierPage.events.length > 0 &&
    earlierPage.page.lastSequence === (newestPage.page.firstSequence ?? 1) - 1 &&
    earlierPage.page.through.sequence === config.pagingEvents;

  // Public ResidentJournalWindow with a pinned old card and a newest-side tail.
  const journalItems = Array.from({ length: config.residentJournalEvents }, (_, index) =>
    storedPerfEvent(sessionId, index + 1),
  );
  const residentWireBytes = 16;
  const residentMaxBytes =
    2 + config.residentJournalMaxItems * residentWireBytes +
    Math.max(0, config.residentJournalMaxItems - 1);
  const residentWindow = new ResidentJournalWindow<StoredJournalEvent>({
    maxItems: config.residentJournalMaxItems,
    maxBytes: residentMaxBytes,
    sizeOf: () => residentWireBytes,
    trackLifecyclePins: false,
  });
  residentWindow.merge(journalItems.slice(0, config.residentJournalMaxItems));
  const releaseOldPin = residentWindow.pin(1);
  const residentMergeDurations: number[] = [];
  const mergePageItems = Math.max(1, Math.floor(config.residentJournalMaxItems / 2));
  for (
    let offset = config.residentJournalMaxItems;
    offset < journalItems.length;
    offset += mergePageItems
  ) {
    start = performance.now();
    residentWindow.merge(journalItems.slice(offset, offset + mergePageItems));
    residentMergeDurations.push(elapsed(start));
  }
  const journalWindowStats = residentWindow.stats;
  const journalResidentItems = residentWindow.items;
  const journalExpectedOmitted = config.residentJournalEvents - config.residentJournalMaxItems;
  const journalExpectedRecentStart =
    config.residentJournalEvents - config.residentJournalMaxItems + 2;
  const journalRange = journalWindowStats.omittedRanges[0];
  const journalWindowExact =
    journalWindowStats.itemCount === config.residentJournalMaxItems &&
    journalWindowStats.pinnedItems === 1 &&
    journalWindowStats.omittedBefore === journalExpectedOmitted &&
    journalWindowStats.omittedAfter === 0 &&
    journalWindowStats.overBudget === false &&
    journalResidentItems[0]?.sequence === 1 &&
    journalResidentItems[1]?.sequence === journalExpectedRecentStart &&
    journalResidentItems.at(-1)?.sequence === config.residentJournalEvents &&
    journalRange?.firstSequence === 2 &&
    journalRange.lastSequence === journalExpectedRecentStart - 1 &&
    journalRange.count === journalExpectedOmitted;
  releaseOldPin();

  // Bound a reducer-like model without disturbing its aggregate/active state.
  const viewItems: PerfResidentViewItem[] = Array.from(
    { length: config.residentViewItems },
    (_, index) =>
      index === 0
        ? { sequence: 1, type: "tool" as const, status: "running" as const }
        : { sequence: index + 1, type: "notice" as const },
  );
  const activeMarker = { id: "still-active" };
  const sourceViewModel = { timeline: viewItems, activeMarker, aggregate: 42 };
  const viewMaxBytes =
    2 + config.residentViewMaxItems * residentWireBytes +
    Math.max(0, config.residentViewMaxItems - 1);
  start = performance.now();
  const boundedView = boundResidentViewModel(sourceViewModel, {
    maxItems: config.residentViewMaxItems,
    maxBytes: viewMaxBytes,
    priorOmittedCount: 7,
    sizeOf: () => residentWireBytes,
  });
  const boundViewMs = elapsed(start);
  const expectedViewOmitted = config.residentViewItems - config.residentViewMaxItems;
  const boundedTimeline = boundedView.model.timeline;
  const boundRange = boundedView.omittedRanges[0];
  const boundedViewExact =
    boundedTimeline.length === config.residentViewMaxItems &&
    boundedTimeline[0]?.sequence === 1 &&
    boundedTimeline[1]?.sequence === expectedViewOmitted + 2 &&
    boundedTimeline.at(-1)?.sequence === config.residentViewItems &&
    boundedView.omittedNow === expectedViewOmitted &&
    boundedView.omittedCount === expectedViewOmitted + 7 &&
    boundedView.overBudget === false &&
    boundRange?.firstSequence === 2 &&
    boundRange.lastSequence === expectedViewOmitted + 1 &&
    boundedView.model.activeMarker === activeMarker &&
    boundedView.model.aggregate === 42;

  const publicApisPresent = requiredPersistenceExports.every((name) =>
    runtimeExportNames.includes(name),
  );
  const gates = [
    gate(
      "legacy resident child-call window is exactly capped",
      childResidentCount === MAX_RESIDENT_SUBAGENT_EVENTS,
      childResidentCount,
      String(MAX_RESIDENT_SUBAGENT_EVENTS),
    ),
    gate(
      "legacy resident eviction preserves total and omitted counts",
      childResidentExact,
      { totalObserved, childOmitted, oldestResident },
      `${totalCalls} observed, ${expectedChildOmitted} omitted, oldest ${expectedOldest}`,
    ),
    gate(
      "new public paging and resident APIs are exported",
      publicApisPresent,
      relevantExports,
      requiredPersistenceExports.join(", "),
    ),
    gate(
      "paged tail replay reconstructs the exact frozen journal",
      replayExact,
      {
        eventsApplied: replayed.eventsApplied,
        pagesLoaded: replayed.pagesLoaded,
        state: replayed.state,
        journalSequence: replayed.journalSequence,
        peakPageItems: Math.max(...pagingTransport.pageSizes),
      },
      `${config.pagingEvents} events, ${expectedPages} pages, sequence sum ${expectedSequenceSum}`,
    ),
    gate(
      "every replay continuation pins the initial through boundary",
      frozenFollowupCalls === Math.max(0, expectedPages - 1),
      frozenFollowupCalls,
      String(Math.max(0, expectedPages - 1)),
    ),
    gate(
      "earlier-page cursor loads the exact preceding page",
      earlierPageExact,
      {
        newestFirst: newestPage.page.firstSequence,
        earlierLast: earlierPage?.page.lastSequence,
        earlierItems: earlierPage?.events.length,
      },
      "earlier last sequence is newest first sequence - 1",
    ),
    gate(
      "ResidentJournalWindow bounds data while preserving an old pin",
      journalWindowExact,
      {
        stats: journalWindowStats,
        firstSequences: journalResidentItems.slice(0, 3).map((item) => item.sequence),
        latestSequence: journalResidentItems.at(-1)?.sequence,
      },
      `${config.residentJournalMaxItems} items: pinned sequence 1 plus newest tail`,
    ),
    gate(
      "boundResidentViewModel preserves pins, aggregates, and omission reconstruction",
      boundedViewExact,
      {
        residentItems: boundedTimeline.length,
        omittedNow: boundedView.omittedNow,
        omittedCount: boundedView.omittedCount,
        firstSequences: boundedTimeline.slice(0, 3).map((item) => item.sequence),
        ranges: boundedView.omittedRanges,
      },
      `${config.residentViewMaxItems} resident items and exact omitted range`,
    ),
  ];

  return finishScenario({
    name: "resident-window-and-paging",
    description:
      "Public frozen journal paging, earlier-page cursors, ResidentJournalWindow, boundResidentViewModel, and reducer child-detail residency.",
    sizes: {
      childResidentLimit: MAX_RESIDENT_SUBAGENT_EVENTS,
      completedChildCalls: totalCalls,
      pagingEvents: config.pagingEvents,
      pagingPageItems: config.pagingPageItems,
      expectedPagingPages: expectedPages,
      residentJournalEvents: config.residentJournalEvents,
      residentJournalMaxItems: config.residentJournalMaxItems,
      residentViewItems: config.residentViewItems,
      residentViewMaxItems: config.residentViewMaxItems,
      detectedPagingExports: pagingExports.length,
    },
    timings: {
      child_call_start_complete: summarizeDurations(pairDurations),
      replay_paged_tail: summarizeDurations([replayMs]),
      load_earlier_page: summarizeDurations([earlierLoadMs]),
      resident_journal_merge_page: summarizeDurations(residentMergeDurations),
      bound_resident_view_model: summarizeDurations([boundViewMs]),
    },
    counters: {
      relevantRuntimeExports: relevantExports,
      pagingRuntimeExports: pagingExports,
      pagingTransportLoads: pagingTransport.calls.length,
      pagingEventsApplied: replayed.eventsApplied,
      pagingPagesLoaded: replayed.pagesLoaded,
      pagingPeakPageItems: Math.max(...pagingTransport.pageSizes),
      frozenThroughContinuationLoads: frozenFollowupCalls,
      childTotalCalls: totalObserved,
      childResidentCalls: childResidentCount,
      childOmittedCalls: childOmitted,
      journalResidentItems: journalWindowStats.itemCount,
      journalOmittedBefore: journalWindowStats.omittedBefore,
      journalPinnedItems: journalWindowStats.pinnedItems,
      boundedViewItems: boundedTimeline.length,
      boundedViewOmittedNow: boundedView.omittedNow,
    },
    ratios: {
      pageLoadRatio: ratio(replayed.pagesLoaded, expectedPages),
      peakPageFillRatio: ratio(
        Math.max(...pagingTransport.pageSizes),
        config.pagingPageItems,
      ),
      journalResidentToInputRatio: ratio(
        journalWindowStats.itemCount,
        config.residentJournalEvents,
      ),
      journalRetainedVsBound: ratio(
        journalWindowStats.itemCount,
        config.residentJournalMaxItems,
      ),
      boundedViewRetainedVsBound: ratio(
        boundedTimeline.length,
        config.residentViewMaxItems,
      ),
      childResidentToTotalRatio: ratio(childResidentCount, totalCalls),
    },
    correctness: {
      childResidentExact,
      replayExact,
      frozenThroughBoundaryExact: frozenFollowupCalls === Math.max(0, expectedPages - 1),
      earlierPageExact,
      journalWindowExact,
      boundedViewExact,
      pagingApiStatus: "exported-and-exercised",
    },
    gates,
    notes: [
      `Detected and exercised paging/window exports: ${relevantExports.join(", ")}.`,
      "Resident eviction is in-memory only; exact omission ranges and earlier cursors are checked.",
    ],
  });
}

function errorScenario(name: string, error: unknown): ScenarioReport {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return finishScenario({
    name,
    description: "Scenario threw before producing measurements.",
    sizes: {},
    timings: { failed: summarizeDurations([]) },
    counters: {},
    ratios: {},
    correctness: { completed: false, error: detail },
    gates: [gate("scenario completes", false, detail, "no exception")],
  });
}

export async function runReadCacheCoalescingScenario(): Promise<ScenarioReport> {
  let now = 0;
  const cache = new ReadCache({ ttlMs: 10_000, now: () => now, maxEntries: 8 });
  const execution: Execution = {
    result: okResult("read src/a.ts", { path: "src/a.ts", checksum: "r1" }),
    text: "const a = 1;",
  };
  const keyA = cache.key("fs.read", { path: "src/a.ts", maxLines: 400 }, "0", "workspace:read");
  const keyB = cache.key("fs.read", { path: "src/b.ts", maxLines: 400 }, "0", "workspace:read");
  let runtimeReads = 0;
  const started = performance.now();
  const first = cache.coalesce(keyA, async () => {
    runtimeReads += 1;
    await Promise.resolve();
    return execution;
  });
  const second = cache.coalesce(keyA, async () => {
    runtimeReads += 1;
    return execution;
  });
  const [firstResult, secondResult] = await Promise.all([first.promise, second.promise]);
  cache.set(keyA, firstResult, {
    paths: ["src/a.ts"],
    authority: "read",
    authorityScope: "workspace:read",
    revisionToken: "r1",
  });
  cache.set(keyB, execution, {
    paths: ["src/b.ts"],
    authority: "read",
    authorityScope: "workspace:read",
    revisionToken: "r1",
  });
  const hitBeforeMutation = cache.getEntry(keyA, { authorityScope: "workspace:read" }) !== undefined;
  const removed = cache.invalidatePath("src/a.ts");
  const unrelatedEntryRetained = cache.getEntry(keyB, { authorityScope: "workspace:read" }) !== undefined;
  now += 1;

  const gates = [
    gate("identical concurrent reads share one runtime operation", runtimeReads === 1, runtimeReads, "1 runtime read"),
    gate("coalesced callers receive the same successful result", firstResult === secondResult, firstResult === secondResult, "same execution"),
    gate("cache entry validates before mutation", hitBeforeMutation, hitBeforeMutation, "true"),
    gate("path invalidation removes only the affected entry", removed === 1 && unrelatedEntryRetained, { removed, unrelatedEntryRetained }, "one removed and unrelated retained"),
  ];
  return finishScenario({
    name: "read-cache-coalescing",
    description: "Revision-scoped shared read cache with concurrent coalescing and path invalidation.",
    sizes: { entries: 2, maxEntries: 8, ttlMs: 10_000 },
    timings: { coalesce_and_invalidate: summarizeDurations([elapsed(started)]) },
    counters: {
      runtimeReads,
      coalescedRequests: second.shared ? 1 : 0,
      cacheEntriesAfterInvalidation: cache.size,
      pathInvalidations: removed,
      defaultReadMaxLines: DEFAULT_READ_MAX_LINES,
      clock: now,
    },
    ratios: {
      runtimeReadsPerCaller: ratio(runtimeReads, 2),
      retainedAfterPathInvalidation: ratio(cache.size, 1),
    },
    correctness: {
      sharedResult: firstResult === secondResult,
      unrelatedEntryRetained,
      defaultWindowAligned: DEFAULT_READ_MAX_LINES === 400,
    },
    gates,
  });
}

export async function runRepositoryScanTruncationScenario(): Promise<ScenarioReport> {
  const files = Array.from({ length: 5_001 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    bytes: 128,
    binary: false,
    tracked: true,
  }));
  let globCalls = 0;
  let diffCalls = 0;
  const started = performance.now();
  const scan = await scanRepository({
    glob: async () => {
      globCalls += 1;
      return { entries: files, truncated: true };
    },
    gitDiff: async () => {
      diffCalls += 1;
      return { files: [{ path: "src/file-1.ts" }] };
    },
    gitStatus: async () => ({ status: {}, statusBar: "" }),
  });
  const gates = [
    gate("truncation survives repository scan", scan.truncated === true, scan.truncated, "true"),
    gate("bounded walk retains returned files", scan.files.length === files.length, scan.files.length, String(files.length)),
    gate("walk and diff are both issued", globCalls === 1 && diffCalls === 1, { globCalls, diffCalls }, "one walk and one diff"),
    gate("truncated scan does not expose a fresh complete snapshot", scan.truncated !== false, scan.truncated !== false, "not false"),
  ];
  return finishScenario({
    name: "repository-scan-truncation",
    description: "Repository map scan preserves bounded-walk truncation and dirty-path metadata.",
    sizes: { returnedEntries: files.length, scanLimit: 5_000 },
    timings: { scan: summarizeDurations([elapsed(started)]) },
    counters: {
      globCalls,
      diffCalls,
      entriesReturned: scan.files.length,
      dirtyPaths: scan.dirtyPaths?.length ?? 0,
      truncated: scan.truncated === true,
    },
    ratios: {
      returnedToLimit: ratio(scan.files.length, 5_000),
      dirtyPathRatio: ratio(scan.dirtyPaths?.length ?? 0, scan.files.length),
    },
    correctness: {
      truncationPropagated: scan.truncated === true,
      dirtyPathBound: scan.dirtyPaths?.[0] === "src/file-1.ts",
    },
    gates,
  });
}

export function runSelectionShortlistScenario(config: HarnessConfig): ScenarioReport {
  const fileCount = 50_000;
  const files: RepoFile[] = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/module-${index}.ts`,
    bytes: 512,
    binary: false,
    tracked: true,
  }));
  const map = buildRepositoryMap(files);
  const started = performance.now();
  const result = selectContext(map, {
    mentionedPaths: ["src/module-4242.ts"],
    changedPaths: ["src/module-100.ts"],
    recentToolPaths: ["src/module-100.ts"],
    searchMatches: new Map([["src/module-4242.ts", 4]]),
    taskText: "update module 4242",
  }, {
    shortlistCap: 1_024,
    maxFiles: 12,
    maxTotalBytes: 64 * 1024,
  });
  const diagnostics = result.diagnostics;
  const scored = diagnostics?.scoredCount ?? result.considered;
  const shortlist = diagnostics?.shortlistedCount ?? scored;
  const gates = [
    gate("selection retains the explicit mention", result.selected.some((file) => file.path === "src/module-4242.ts"), result.selected.map((file) => file.path), "explicit path selected"),
    gate("shortlist stays within the bounded candidate cap", shortlist <= 1_024, shortlist, "<= 1024"),
    gate("scoring work stays within the shortlist", scored <= 1_024, scored, "<= 1024 scored candidates"),
    gate("selection diagnostics account for skipped candidates", (diagnostics?.skippedByShortlist ?? 0) + shortlist === diagnostics?.candidateCount, diagnostics, "skipped + shortlisted = candidate count"),
  ];
  return finishScenario({
    name: "selection-shortlist-50k",
    description: "Deterministic selection shortlist over a 50k-file repository map.",
    sizes: { files: fileCount, shortlistCap: 1_024, configuredMaxFiles: 12, quickConfigPathEntries: config.pathIndexEntries },
    timings: { selection: summarizeDurations([elapsed(started)]) },
    counters: {
      filesVisited: fileCount,
      candidateCount: diagnostics?.candidateCount ?? 0,
      shortlistCandidates: shortlist,
      scoredCandidates: scored,
      selectedFiles: result.selected.length,
      omittedForBudget: result.omittedForBudget.length,
      excluded: result.excluded.length,
    },
    ratios: {
      scoredToMap: ratio(scored, fileCount),
      shortlistToMap: ratio(shortlist, fileCount),
      selectedToMap: ratio(result.selected.length, fileCount),
    },
    correctness: {
      explicitMentionSelected: result.selected.some((file) => file.path === "src/module-4242.ts"),
      deterministicOrder: result.selected.every((file, index, selected) => index === 0 || selected[index - 1]!.score >= file.score),
    },
    gates,
  });
}

export async function runRetrievalControllerScenario(): Promise<ScenarioReport> {
  const calls = { search: 0, preview: 0, exact: 0 };
  const candidate: RetrievalCandidate = { path: "src/parser.ts", startLine: 120, maxLines: 40, score: 10 };
  const read = (mode: "preview" | "exact"): RetrievalObservation => ({
    path: candidate.path,
    mode,
    startLine: candidate.startLine ?? 1,
    endLine: (candidate.startLine ?? 1) + 1,
    text: "parse(input)",
    revisionToken: `${mode}-r1`,
    ...(mode === "exact" ? { checksum: "sha256-r1" } : {}),
    authoritativeForWrite: mode === "exact",
    endOfFile: false,
    truncatedByBytes: false,
    bytesScanned: mode === "preview" ? 128 : 512,
    sufficient: false,
  });
  const adapter: RetrievalAdapter = {
    async search() {
      calls.search += 1;
      return [candidate];
    },
    async preview() {
      calls.preview += 1;
      return read("preview");
    },
    async exact() {
      calls.exact += 1;
      return read("exact");
    },
  };
  const started = performance.now();
  const result = await new RetrievalController(adapter, {
    budget: {
      maxSearchCalls: 1,
      maxPreviewCalls: 1,
      maxExactCalls: 1,
      maxBytesScanned: 1_024,
      maxEvidenceTokens: 256,
    },
  }).run("parser implementation");
  const gates = [
    gate("search precedes preview", calls.search === 1 && calls.preview === 1, calls, "one search and one preview"),
    gate("exact expansion happens only after preview", calls.exact === 1 && result.exact.length === 1, calls, "one exact evidence read"),
    gate("exact evidence is write-authoritative", result.exact[0]?.authoritativeForWrite === true, result.exact[0]?.authoritativeForWrite, "true"),
    gate("preview is not write-authoritative", result.previews[0]?.authoritativeForWrite === false, result.previews[0]?.authoritativeForWrite, "false"),
    gate("read budgets remain bounded", result.stats.bytesScanned <= 1_024, result.stats.bytesScanned, "<= 1024 bytes scanned"),
  ];
  return finishScenario({
    name: "retrieval-controller-stop-rules",
    description: "Search, preview, exact expansion, authority validation, and bounded retrieval stop rules.",
    sizes: { candidates: result.candidates.length, maxBytesScanned: 1_024, maxEvidenceTokens: 256 },
    timings: { retrieval: summarizeDurations([elapsed(started)]) },
    counters: {
      searchCalls: calls.search,
      previewCalls: calls.preview,
      exactCalls: calls.exact,
      bytesScanned: result.stats.bytesScanned,
      evidenceTokens: result.stats.evidenceTokens,
      readsAvoided: result.stats.readsAvoided,
    },
    ratios: {
      exactToPreview: ratio(calls.exact, calls.preview),
      bytesToBudget: ratio(result.stats.bytesScanned, 1_024),
    },
    correctness: {
      stopReason: result.stopReason,
      exactEvidenceCount: result.exact.length,
      previewAuthority: result.previews[0]?.authoritativeForWrite === false,
    },
    gates,
  });
}

export interface RunHarnessOptions {
  readonly mode?: HarnessMode;
  readonly scenarios?: readonly ScenarioName[];
}

export async function runPerformanceHarness(
  options: RunHarnessOptions = {},
): Promise<PerformanceHarnessReport> {
  const mode = options.mode ?? "full";
  const config = CONFIGS[mode];
  const selected = new Set<ScenarioName>(options.scenarios ?? SCENARIO_NAMES);
  const startedAt = new Date().toISOString();
  const suiteStart = performance.now();
  const reports: ScenarioReport[] = [];

  const run = async (name: ScenarioName, fn: () => ScenarioReport | Promise<ScenarioReport>) => {
    if (!selected.has(name)) return;
    try {
      reports.push(await fn());
    } catch (error) {
      reports.push(errorScenario(name, error));
    }
  };

  await run("unicode-width-hotloop", () => runUnicodeWidthHotloopScenario(config));
  await run("streaming-markdown-growth", () => runStreamingMarkdownGrowthScenario(config));
  await run("active-frame-surrogate", () => runActiveFrameSurrogateScenario(config));
  await run("composer-edit-latency", () => runComposerEditLatencyScenario(config));
  await run("path-completion-max-index", () => runPathCompletionMaxIndexScenario(config));
  await run("ansi-diff-and-backpressure", () => runAnsiDiffAndBackpressureScenario(config));
  await run("projected-timeline", () => runProjectedTimelineScenario(config));
  await run("giant-markdown", () => runGiantMarkdownScenario(config));
  await run("reducer-delta-burst", () => runReducerDeltaScenario(config));
  await run("live-span-cleanup", () => runLiveSpanCleanupScenario(config));
  await run("session-recorder-batching", () => runSessionRecorderBatchingScenario());
  await run("idle-frame-surrogate", () => runIdleFrameSurrogateScenario(config));
  await run("resident-window-and-paging", () => runResidentWindowAndPagingScenario(config));
  await run("read-cache-coalescing", () => runReadCacheCoalescingScenario());
  await run("repository-scan-truncation", () => runRepositoryScanTruncationScenario());
  await run("selection-shortlist-50k", () => runSelectionShortlistScenario(config));
  await run("retrieval-controller-stop-rules", () => runRetrievalControllerScenario());

  const failingGates = reports.flatMap((report) =>
    report.gates
      .filter((entry) => !entry.pass)
      .map((entry) => `${report.name}: ${entry.name}`),
  );
  const passed = reports.filter((report) => report.pass).length;
  const failed = reports.length - passed;
  return {
    schemaVersion: 1,
    suite: "capybara-performance-regression",
    mode,
    startedAt,
    durationMs: round(elapsed(suiteStart)),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    scenarios: reports,
    summary: {
      scenarios: reports.length,
      passed,
      failed,
      failingGates,
    },
    pass: failed === 0,
  };
}
