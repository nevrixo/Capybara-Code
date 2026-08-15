/**
 * The context engine — PRD §18.1, §18.10, §18.11.
 *
 * §18.1 orders the layers L0–L8 and states the rule that gives the whole design
 * its shape: a lower layer is never overridden by an untrusted instruction in a
 * higher one. `assemblePrompt` in `@cbc/agent-kernel` owns the rendering of those
 * layers; this class owns *what goes into* L2, L6, and the bookkeeping the
 * inspector needs.
 */

import type { ProjectInstructions, SkillMetadata } from "@cbc/inference-domain";
import type { ProposedAction } from "@cbc/permissions";
import type { ArtifactRef, ToolResult } from "@cbc/tool-registry";

import { cachedEstimateTokens } from "./cache.ts";
import { explainContextItem, prepareContext } from "./compiler.ts";
import type {
  ContextItem,
  ContextManifestExclusion,
  ContextManifestInclusion,
  ContextPack,
  ContextRequest,
} from "./ir.ts";
import {
  ActiveExcerptSet,
  DEFAULT_EXCERPT_LINES,
  EvidenceExcerptStore,
  buildExcerpt,
  estimateRenderedTokens,
  excerptId,
  renderExcerpt,
  type ActiveExcerptEntry,
  type FileContent,
  type FileExcerpt,
} from "./excerpts.ts";
import {
  EvidenceLedger,
  evidenceDigest,
  type EvidenceInput,
  type EvidenceSelection,
  type EvidenceRecord,
} from "./evidence.ts";
import {
  loadGlobalInstructions,
  loadProjectInstructions,
  type InstructionReader,
  type SkippedInstruction,
} from "./instructions.ts";
import {
  buildRepositoryMap,
  renderRepositoryMap,
  type RepoFile,
  type RepositoryMap,
} from "./repomap.ts";
import { RepositoryIntelligence } from "./repository-intelligence.ts";
import {
  isSensitivePath,
  selectContext,
  type SelectionOptions,
  type SelectionResult,
  type SelectionSignals,
} from "./selection.ts";

/** §18.1 layer identifiers, mirroring `ContextLayer` in the kernel's prompt module. */
export const CONTEXT_LAYERS = [
  "L0_policy",
  "L1_tool_semantics",
  "L2_project_instructions",
  "L3_active_skills",
  "L4_task_and_plan",
  "L5_compact_state",
  "L6_repository_context",
  "L7_tool_observations",
  "L8_user_input",
] as const;

export type ContextLayerId = (typeof CONTEXT_LAYERS)[number];

export interface ContextEngineOptions {
  readonly reader: InstructionReader;
  readonly globalReader?: InstructionReader;
  /** §10.10 soft budget for the owning agent role. */
  readonly softContextTokens: number;
  readonly selection?: SelectionOptions;
  readonly maxExcerptLines?: number;
  /** Hard L6 working-set ceiling, independent of provider history compaction. */
  readonly activeExcerptTokens?: number;
  /** Workspace identity used to reject stale evidence after a checkout/reset. */
  readonly workspaceIdentityDigest?: string;
  /** Test/embedding bound; retained excerpt provenance is rehydrated if trimmed. */
  readonly maxEvidenceRecords?: number;
  readonly now?: () => number;
}

/** One row of the §18.10 context inspector. */
export interface InspectorLayerRow {
  readonly layer: ContextLayerId;
  readonly estimatedTokens: number;
  readonly detail: string;
}

/**
 * §18.10 requires the inspector to report the *presence* of reasoning items, not
 * their contents. §10.7 forbids displaying or exporting raw reasoning, so the
 * count is the only thing carried here.
 */
export interface ReasoningPresence {
  readonly items: number;
  readonly note: string;
}

export interface ContextInspection {
  readonly softBudgetTokens: number;
  readonly usedTokens: number;
  readonly usedFraction: number;
  readonly layers: InspectorLayerRow[];
  readonly activeFiles: Array<{ path: string; lines: string; checksum: string }>;
  readonly skills: Array<{ name: string; version?: string; source: string }>;
  readonly toolSchemas: string[];
  readonly reasoning: ReasoningPresence;
  /** §10.9 cache prefix fingerprint, so a cache miss is explainable. */
  readonly cachePrefixFingerprint?: string;
  readonly compiledPackId?: string;
  readonly compiledInputTokens?: number;
  /** P1 manifest summary for `/context` explanations; never raw candidate text. */
  readonly compilerPack?: {
    readonly id: string;
    readonly manifestDigest: string;
    readonly included: number;
    readonly excluded: number;
    readonly fallback: boolean;
  };
  /** §18.10 "excluded large outputs". */
  readonly excludedLargeOutputs: Array<{ label: string; bytes: number; artifactId?: string }>;
  readonly instructionsSkipped: SkippedInstruction[];
  /**
   * Failures currently biasing selection (§11.2, §18.4). Shown because P2 extends
   * to context: a user who sees a file appear in the prompt should be able to find
   * out that a failure put it there.
   */
  readonly recentFailures: Array<{ toolId: string; category: string; paths: string[] }>;
}

export interface ToolObservationExecution {
  readonly result: ToolResult;
  readonly text?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

/** Neutral structural contract accepted from root and child executors. */
export interface ToolObservation {
  readonly action: ProposedAction;
  readonly execution: ToolObservationExecution;
  readonly cacheHit: boolean;
  readonly observedAtMs: number;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface ToolObservationIngestResult {
  readonly handled: boolean;
  readonly exactContentPromoted: boolean;
  /** Raw L7 output may be replaced without losing or exposing exact content. */
  readonly safeToVirtualize: boolean;
  readonly evidence: readonly EvidenceRecord[];
  readonly excerptIds: readonly `excerpt-${string}`[];
  /** Leases first acquired by this observer, safe to cancel on an async race. */
  readonly newlyLeasedExcerptIds: readonly `excerpt-${string}`[];
  /** Safe read_many members leased for L6 even when siblings must remain raw. */
  readonly partiallyPromotedPaths: readonly string[];
  readonly invalidatedEvidenceIds: readonly `evidence-${string}`[];
  readonly artifactIds: readonly string[];
  readonly rejected: readonly { reason: string; locator?: string }[];
}

export interface ContextMaterialization {
  readonly evidenceIds: readonly `evidence-${string}`[];
  readonly excerptIds: readonly `excerpt-${string}`[];
  readonly rejected: readonly { id: string; reason: string }[];
  readonly estimatedTokens: number;
  readonly omitted: number;
}

export interface ContextInvalidation {
  readonly excerptsRemoved: number;
  readonly evidenceInvalidated: readonly EvidenceRecord[];
}

export interface ContextExcerptEviction extends ActiveExcerptEntry {
  readonly reason: "budget" | "invalidated" | "superseded";
}

export interface RepositoryScan {
  readonly files: readonly RepoFile[];
  readonly dirtyPaths?: readonly string[];
  /** A bounded walk did not observe the complete workspace. */
  readonly truncated?: boolean;
}

/** Bounded metadata refresh for paths known to have changed. */
export interface RepositoryDelta {
  readonly files: readonly RepoFile[];
  readonly removedPaths: readonly string[];
  readonly dirtyPaths?: readonly string[];
  /** One or more exact probes were incomplete or truncated. */
  readonly truncated?: boolean;
}

/**
 * One reflection the kernel reached, as the context engine needs it (§11.2).
 *
 * The engine keeps only what affects context: the category, the cause in one
 * line, and the paths involved. It deliberately does not keep the reflection
 * prompt, because replaying an old prompt into a later turn would re-instruct the
 * model to correct something it already corrected.
 */
export interface RecordedReflection {
  readonly toolId: string;
  readonly category: string;
  readonly rootCause: string;
  readonly correctiveAction: string;
  readonly paths: readonly string[];
}

/**
 * How many reflections stay in the window.
 *
 * Small on purpose. The point of the recent-failure weight is *recency*; a long
 * memory of failures would keep re-selecting files that stopped being relevant
 * several attempts ago, and eventually every file has failed at least once.
 */
export const REFLECTION_WINDOW = 8;

/**
 * Holds the per-session context state: the repository map, the loaded project
 * instructions, and the excerpts currently in the prompt.
 */
export class ContextEngine {
  readonly #options: ContextEngineOptions;
  readonly #excerpts: EvidenceExcerptStore;
  readonly #activeExcerpts: ActiveExcerptSet;
  readonly #activeExcerptBudget: number;
  readonly evidence: EvidenceLedger;

  #map: RepositoryMap | undefined;
  #mapDirty = false;
  #mapEvidenceId: `evidence-${string}` | undefined;
  #instructions: ProjectInstructions[] = [];
  #globalInstructions: ProjectInstructions[] = [];
  #projectInstructions: ProjectInstructions[] = [];
  #globalInstructionsSkipped: SkippedInstruction[] = [];
  #projectInstructionsSkipped: SkippedInstruction[] = [];
  #instructionsSkipped: SkippedInstruction[] = [];
  #projectTrusted = false;
  #instructionRefreshRevision = 0;
  readonly #instructionTouchedPaths = new Set<string>();
  #lastSelection: SelectionResult | undefined;
  /** P2's bounded lexical/symbol/graph index; raw scan text is never retained here. */
  readonly #repositoryIntelligence = new RepositoryIntelligence();
  /** Paths supplied by the most recent live scan, for stale file removal only. */
  readonly #repositoryScanPaths = new Set<string>();
  #lastMaterialization: ContextMaterialization = {
    evidenceIds: [], excerptIds: [], rejected: [], estimatedTokens: 0, omitted: 0,
  };
  /** The immutable P1 pack most recently prepared for a provider sample. */
  #lastCompiledContextPack: ContextPack | undefined;
  #excludedOutputs: Array<{ label: string; bytes: number; artifactId?: string }> = [];
  readonly #artifactHandles = new Map<string, ArtifactRef>();
  readonly #excerptEvidence = new Map<`excerpt-${string}`, `evidence-${string}`>();
  readonly #excerptEvidenceRecords = new Map<`excerpt-${string}`, EvidenceRecord>();
  /** Virtualized reads leased until their exact body appears in a compiled pack. */
  readonly #pendingPromotions = new Set<`excerpt-${string}`>();
  readonly #pendingPromotionOwners = new Map<`excerpt-${string}`, Set<string>>();
  #pendingEvictions: ContextExcerptEviction[] = [];
  #recentToolPaths: string[] = [];
  readonly #searchMatches = new Map<string, number>();
  /** Newest last, capped at `REFLECTION_WINDOW`. */
  #reflections: RecordedReflection[] = [];

  constructor(options: ContextEngineOptions) {
    this.#options = options;
    this.#excerpts = new EvidenceExcerptStore();
    this.#activeExcerpts = new ActiveExcerptSet(this.#excerpts, {
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#activeExcerptBudget = Math.max(
      0,
      Math.floor(options.activeExcerptTokens ?? Math.min(24_000, options.softContextTokens * 0.2)),
    );
    this.evidence = new EvidenceLedger({
      ...(options.workspaceIdentityDigest !== undefined
        ? { workspaceIdentityDigest: options.workspaceIdentityDigest }
        : {}),
      ...(options.maxEvidenceRecords !== undefined ? { maxRecords: options.maxEvidenceRecords } : {}),
    });
  }

  get repositoryMap(): RepositoryMap | undefined {
    return this.#map;
  }

  get repositoryMapDirty(): boolean {
    return this.#mapDirty;
  }

  /**
   * A cached map may orient the first turn but is never promoted to fresh
   * repository evidence. The explicit wrapper prevents consumers from treating
   * this bounded hint as mutation- or completion-grade truth.
   */
  provisionalRepositoryOrientation(maxEntries = 12): string | undefined {
    if (this.#map === undefined || !this.#mapDirty) return undefined;
    return [
      '<repository-orientation state="provisional" evidence="unverified">',
      renderRepositoryMap(this.#map, { maxEntries }),
      "</repository-orientation>",
    ].join("\n");
  }

  /** Live P2 repository intelligence; callers may add bounded LSP symbols/edges. */
  get repositoryIntelligence(): RepositoryIntelligence {
    return this.#repositoryIntelligence;
  }

  get instructions(): readonly ProjectInstructions[] {
    return this.#instructions;
  }

  get excerpts(): EvidenceExcerptStore {
    return this.#excerpts;
  }

  get activeExcerpts(): ActiveExcerptSet {
    return this.#activeExcerpts;
  }

  get activeExcerptBudget(): number {
    return this.#activeExcerptBudget;
  }

  get lastSelection(): SelectionResult | undefined {
    return this.#lastSelection;
  }

  get lastMaterialization(): ContextMaterialization {
    return this.#lastMaterialization;
  }

  /** Exact immutable ContextPack prepared by the last `prepareSample` call. */
  get lastCompiledContextPack(): ContextPack | undefined {
    return this.#lastCompiledContextPack;
  }

  recentToolPaths(limit = 24): string[] {
    return this.#recentToolPaths.slice(-Math.max(0, limit));
  }

  searchMatches(): ReadonlyMap<string, number> {
    return new Map(this.#searchMatches);
  }

  drainEvictions(): ContextExcerptEviction[] {
    const events = this.#pendingEvictions;
    this.#pendingEvictions = [];
    return events;
  }

  /** Record a bounded observation for identity-aware context selection. */
  recordEvidence(input: EvidenceInput): EvidenceRecord {
    return this.evidence.record(input);
  }

  selectEvidence(options: Parameters<EvidenceLedger["select"]>[0] = {}): EvidenceSelection {
    return this.evidence.select(options);
  }

  invalidateEvidence(id: `evidence-${string}`, reason?: string): boolean {
    return this.evidence.invalidate(id, reason);
  }

  /** Reflections still inside the recency window, newest last. */
  get reflections(): readonly RecordedReflection[] {
    return this.#reflections;
  }

  /**
   * Record a reflection so the next selection can weight the files it named
   * (§18.4) and the next compaction can carry it as unresolved work (§18.9).
   */
  noteReflection(reflection: RecordedReflection): void {
    this.#reflections.push(reflection);
    if (this.#reflections.length > REFLECTION_WINDOW) {
      this.#reflections = this.#reflections.slice(-REFLECTION_WINDOW);
    }
    // The failure is evidence that what the engine holds for these paths is
    // stale or incomplete, so the cached excerpt is dropped and the file is
    // re-read rather than re-asserted.
    for (const path of reflection.paths) {
      this.invalidate(path, "recent failure requires a fresh read", { workspaceChanged: false });
    }
  }

  /**
   * Drop the reflection window. Called when a turn completes cleanly: the
   * failures that led there have been resolved, and continuing to weight them
   * would bias the next, unrelated request.
   */
  forgetReflections(): void {
    this.#reflections = [];
  }

  /** Paths named by recent failures, newest first and deduplicated (§18.4). */
  recentFailurePaths(limit = 12): string[] {
    const seen = new Set<string>();
    for (const reflection of [...this.#reflections].reverse()) {
      for (const path of reflection.paths) {
        if (seen.size >= limit) return [...seen];
        seen.add(path);
      }
    }
    return [...seen];
  }

  /**
   * The reflection window rendered as unresolved-work lines for L5 (§18.9).
   *
   * Compaction otherwise loses exactly the information a resumed turn needs most:
   * that an approach was already tried and why it did not work.
   */
  unresolvedFromReflections(): string[] {
    return this.#reflections.map(
      (reflection) =>
        `${reflection.toolId} failed (${reflection.category}): ${reflection.rootCause} — next: ${reflection.correctiveAction}`,
    );
  }

  /**
   * Install a disk-cached map for immediate UI/orientation use without asserting
   * it as fresh L6 evidence. Git status cannot prove same-state content changes,
   * and non-Git workspaces have no status identity at all, so a provisional map
   * stays dirty and is excluded from repositoryContext until a live scan arrives.
   */
  ingestCachedScan(scan: RepositoryScan): RepositoryMap {
    if (this.#mapEvidenceId !== undefined) {
      this.evidence.invalidate(this.#mapEvidenceId, "repository map replaced by provisional cache");
      this.#mapEvidenceId = undefined;
    }
    this.#map = buildRepositoryMap(scan.files, {
      ...(scan.dirtyPaths !== undefined ? { dirtyPaths: scan.dirtyPaths } : {}),
    });
    this.#mapDirty = true;
    this.#repositoryScanPaths.clear();
    for (const file of scan.files) this.#repositoryScanPaths.add(normalizeRepositoryPath(file.path));
    return this.#map;
  }

  /**
   * Ingest a workspace scan. §7.1 runs this in the background after first paint,
   * so the engine must be usable — just less informed — before it arrives.
   */
  ingestScan(scan: RepositoryScan): RepositoryMap {
    if (scan.truncated === true) {
      const merged = new Map(this.#map?.files.map((file) => [normalizeRepositoryPath(file.path), file]) ?? []);
      for (const file of scan.files) merged.set(normalizeRepositoryPath(file.path), file);
      this.#map = buildRepositoryMap([...merged.values()], {
        ...(scan.dirtyPaths !== undefined ? { dirtyPaths: scan.dirtyPaths } : {}),
      });
      this.#mapDirty = true;
      this.#updateRepositoryIntelligence(scan.files.map((file) => normalizeRepositoryPath(file.path)));
      this.#invalidateRepositoryMapEvidence("truncated repository scan");
      for (const file of scan.files) this.#repositoryScanPaths.add(normalizeRepositoryPath(file.path));
      return this.#map;
    }

    this.#map = buildRepositoryMap(scan.files, {
      ...(scan.dirtyPaths !== undefined ? { dirtyPaths: scan.dirtyPaths } : {}),
    });
    this.#mapDirty = false;
    const scannedPaths = new Set(scan.files.map((file) => normalizeRepositoryPath(file.path)));
    this.#updateRepositoryIntelligence([...scannedPaths]);
    for (const path of this.#repositoryScanPaths) {
      if (!scannedPaths.has(path)) this.#repositoryIntelligence.removeFile(path);
    }
    this.#repositoryScanPaths.clear();
    for (const path of scannedPaths) this.#repositoryScanPaths.add(path);
    this.#recordRepositoryMapEvidence();
    return this.#map;
  }

  /**
   * Apply a bounded exact-path refresh without pretending it was a full walk.
   * A complete delta can preserve a previously complete map; a delta over a
   * provisional/truncated map remains dirty until a complete scan arrives.
   */
  ingestRepositoryDelta(delta: RepositoryDelta): RepositoryMap {
    const previous = this.#map?.files ?? [];
    const files = new Map(previous.map((file) => [normalizeRepositoryPath(file.path), file]));
    const removed = delta.truncated === true ? [] : delta.removedPaths;
    for (const rawPath of removed) {
      const path = normalizeRepositoryPath(rawPath);
      for (const knownPath of [...files.keys()]) {
        if (knownPath === path || knownPath.startsWith(`${path}/`)) {
          files.delete(knownPath);
          this.#repositoryIntelligence.removeFile(knownPath);
          this.#repositoryScanPaths.delete(knownPath);
        }
      }
    }
    for (const file of delta.files) {
      const path = normalizeRepositoryPath(file.path);
      files.set(path, file);
      this.#repositoryScanPaths.add(path);
      this.#repositoryIntelligence.upsertFile({ path });
    }

    const wasComplete = this.#map !== undefined && !this.#mapDirty;
    this.#map = buildRepositoryMap([...files.values()], {
      ...(delta.dirtyPaths !== undefined ? { dirtyPaths: delta.dirtyPaths } : {}),
    });
    this.#mapDirty = !wasComplete || delta.truncated === true;
    this.#invalidateRepositoryMapEvidence("repository map delta applied");
    if (!this.#mapDirty) this.#recordRepositoryMapEvidence();
    return this.#map;
  }

  #updateRepositoryIntelligence(paths: readonly string[]): void {
    for (const path of paths) this.#repositoryIntelligence.upsertFile({ path });
  }

  #invalidateRepositoryMapEvidence(reason: string): void {
    if (this.#mapEvidenceId === undefined) return;
    this.evidence.invalidate(this.#mapEvidenceId, reason);
    this.#mapEvidenceId = undefined;
  }

  #recordRepositoryMapEvidence(): void {
    if (this.#map === undefined || this.#mapDirty) return;
    this.#invalidateRepositoryMapEvidence("repository map refreshed");
    const rendered = renderRepositoryMap(this.#map);
    const mapEvidence = this.recordEvidence({
      kind: "repository_map",
      locator: "repository-map",
      digest: evidenceDigest({
        files: this.#map.files.map(({ path, bytes, modifiedMs }) => ({ path, bytes, modifiedMs })),
        rendered,
      }),
      summary: `${this.#map.sourceFileCount} source file(s), ${this.#map.totalBytes} bytes`,
      metadata: { files: this.#map.files.length },
    });
    this.#mapEvidenceId = mapEvidence.id;
  }

  /** Load L2 instructions. Trust-gated per §13.6. Global instructions are always loaded. */
  async loadInstructions(options: {
    trusted: boolean;
    touchedPaths?: readonly string[];
  }): Promise<ProjectInstructions[]> {
    const revision = ++this.#instructionRefreshRevision;
    this.#projectTrusted = options.trusted;
    for (const path of options.touchedPaths ?? []) this.#instructionTouchedPaths.add(path);

    const globalReader = this.#options.globalReader;
    const globalResult = globalReader === undefined
      ? { instructions: [] as ProjectInstructions[], skipped: [] as SkippedInstruction[] }
      : await loadGlobalInstructions(globalReader, {});
    const projectResult = await loadProjectInstructions(this.#options.reader, {
      trusted: this.#projectTrusted,
      touchedPaths: [...this.#instructionTouchedPaths],
    });

    if (revision !== this.#instructionRefreshRevision) return this.#instructions;
    this.#globalInstructions = globalResult.instructions;
    this.#projectInstructions = projectResult.instructions;
    this.#globalInstructionsSkipped = globalResult.skipped;
    this.#projectInstructionsSkipped = projectResult.skipped;
    this.#rebuildInstructionView();
    return this.#instructions;
  }

  /**
   * Recompute the complete touched-directory chain. Replacement rather than
   * append handles edits, override swaps, deletions, and canonical hierarchy in
   * one deterministic operation. An untrusted workspace always fails closed.
   */
  async refreshInstructionsForPaths(paths: readonly string[]): Promise<ProjectInstructions[]> {
    const revision = ++this.#instructionRefreshRevision;
    for (const path of paths) this.#instructionTouchedPaths.add(path);
    if (!this.#projectTrusted) return this.#instructions;

    const result = await loadProjectInstructions(this.#options.reader, {
      trusted: this.#projectTrusted,
      touchedPaths: [...this.#instructionTouchedPaths],
    });
    if (revision !== this.#instructionRefreshRevision) return this.#instructions;
    this.#projectInstructions = result.instructions;
    this.#projectInstructionsSkipped = result.skipped;
    this.#rebuildInstructionView();
    return this.#instructions;
  }

  #rebuildInstructionView(): void {
    this.#instructions = [...this.#globalInstructions, ...this.#projectInstructions];
    this.#instructionsSkipped = [
      ...this.#globalInstructionsSkipped,
      ...this.#projectInstructionsSkipped,
    ];
  }

  /** Run §18.4 selection against the current map. */
  select(signals: SelectionSignals, options: SelectionOptions = {}): SelectionResult {
    if (!this.#map) {
      const empty: SelectionResult = {
        selected: [],
        considered: 0,
        omittedForBudget: [],
        excluded: [],
      };
      this.#lastSelection = empty;
      return empty;
    }
    const merged: SelectionOptions = {
      ...this.#options.selection,
      ...options,
      // Only ranges already active in this prompt are skipped. An evicted range
      // or a different range of the same file remains eligible for reactivation.
      exclude: [
        ...(this.#options.selection?.exclude ?? []),
        ...(options.exclude ?? []),
        ...[...new Set(this.#excerpts.excerpts().map((excerpt) => excerpt.path))]
          .filter((path) => {
            const ids = this.#excerpts.idsForPath(path);
            return ids.length > 0 && ids.every((id) => this.#activeExcerpts.has(id));
          }),
      ],
    };
    // The recent-failure signal comes from the engine's own reflection window
    // unless the caller supplied one, so a host does not have to remember to
    // thread it through on every call for self-correction to affect context.
    const withFailures: SelectionSignals =
      signals.recentFailurePaths !== undefined
        ? signals
        : { ...signals, recentFailurePaths: this.recentFailurePaths() };

    // P2 retrieval augments, rather than replaces, the deterministic P0 scorer.
    // Its index contains only path/symbol metadata unless a caller explicitly
    // contributes bounded LSP data, and every resulting path still traverses the
    // normal sensitive/generated/budget gates in selectContext.
    let enriched = withFailures;
    try {
      const retrieval = this.#repositoryIntelligence.retrieve({
        ...(withFailures.taskText === undefined ? {} : { query: withFailures.taskText }),
        ...(withFailures.mentionedPaths === undefined ? {} : { mentionedPaths: withFailures.mentionedPaths }),
        hops: 2,
        maxNodes: 64,
        maxEdges: 128,
        maxRangeCandidates: 32,
      });
      const searchMatches = new Map(withFailures.searchMatches ?? []);
      for (const hit of retrieval.lexicalHits) {
        searchMatches.set(hit.path, (searchMatches.get(hit.path) ?? 0) + 1);
      }
      const structuralPaths = new Set(withFailures.structuralPaths ?? []);
      for (const hit of retrieval.structural.nodes) {
        if (hit.node.path !== undefined) structuralPaths.add(hit.node.path);
      }
      enriched = {
        ...withFailures,
        ...(searchMatches.size > 0 ? { searchMatches } : {}),
        ...(structuralPaths.size > 0 ? { structuralPaths: [...structuralPaths].sort() } : {}),
      };
    } catch {
      // Index/LSP adapters are optional orientation aids; an invalid adapter must
      // never interrupt the existing evidence-backed selection path.
    }

    this.#lastSelection = selectContext(this.#map, enriched, merged);
    this.activateSelection(this.#lastSelection);
    return this.#lastSelection;
  }

  /**
   * P1's sole asynchronous preparation boundary. Existing callers may continue
   * to materialize L6 directly while they migrate, but new prompt/cache/UI paths
   * can consume this immutable pack without re-running selection.
   */
  async prepareSample(
    request: ContextRequest,
    options: { readonly recentDialogue?: ContextPack["recentDialogue"] } = {},
  ): Promise<ContextPack> {
    const pack = await prepareContext(request, this.#compilerItems(request), {
      ...(options.recentDialogue === undefined ? {} : { recentDialogue: options.recentDialogue }),
      now: () => new Date(this.#options.now?.() ?? Date.now()),
    });
    this.#lastCompiledContextPack = pack;
    return pack;
  }

  /** Short alias for hosts that refer to prompt compilation as `prepare`. */
  async prepare(
    request: ContextRequest,
    options: { readonly recentDialogue?: ContextPack["recentDialogue"] } = {},
  ): Promise<ContextPack> {
    return await this.prepareSample(request, options);
  }

  /** Read-only explanation from the exact previous P1 manifest. */
  explainContextItem(id: string): ContextManifestInclusion | ContextManifestExclusion | undefined {
    return this.#lastCompiledContextPack === undefined
      ? undefined
      : explainContextItem(this.#lastCompiledContextPack.manifest, id);
  }

  #compilerItems(request: ContextRequest): ContextItem[] {
    const workspaceIdentity = request.workspaceIdentity ?? this.#options.workspaceIdentityDigest ?? "unbound-workspace";
    const observedAt = new Date(this.#options.now?.() ?? Date.now()).toISOString();
    const items: ContextItem[] = [];
    const add = (item: ContextItem): void => { items.push(item); };
    const base = (id: string, kind: ContextItem["kind"], authority: ContextItem["authority"], trust: ContextItem["trust"], text: string, exact: boolean, resolution: ContextItem["representation"]["resolution"], provenance: ContextItem["provenance"], paths?: readonly string[]): ContextItem => ({
      id,
      kind,
      authority,
      trust,
      scope: {
        workspaceIdentity,
        ...(paths === undefined || paths.length === 0 ? {} : { paths: [...paths] }),
      },
      provenance,
      freshness: { state: "fresh" },
      representation: { resolution, exact, text },
      estimatedTokens: cachedEstimateTokens(text),
      dependencies: [],
      utility: {
        relevance: kind === "instruction" || kind === "policy" ? 100 : 20,
        coverage: resolution === "map" ? 20 : 5,
        novelty: 1,
        recency: 1,
        confidence: exact ? 1 : 0.7,
        verificationValue: kind === "test_result" ? 10 : 1,
        riskPenalty: 0,
      },
    });

    for (const instruction of this.#instructions) {
      const digest = evidenceDigest({ path: instruction.path, content: instruction.content });
      add(base(
        `instruction-${digest}`,
        "instruction",
        "workspace_maintainer",
        this.#projectTrusted ? "trusted" : "untrusted",
        instruction.content,
        true,
        "full",
        { source: "project-instructions", locator: instruction.path, digest, observedAt },
        [instruction.path],
      ));
    }

    if (this.#map !== undefined && !this.#mapDirty && this.#mapEvidenceId !== undefined) {
      const record = this.evidence.get(this.#mapEvidenceId);
      if (record?.freshness === "fresh") {
        const text = renderRepositoryMap(this.#map);
        add(base(
          `map-${record.id}`,
          "tool_observation",
          "tool",
          "untrusted",
          text,
          false,
          "map",
          { source: "repository-map", locator: record.locator, digest: record.digest, observedAt: record.observedAt, parentEvidenceIds: [record.id] },
        ));
      }
    }

    for (const id of this.#activeExcerpts.excerptIds()) {
      const excerpt = this.#excerpts.getById(id);
      if (excerpt === undefined) continue;
      let evidenceId = this.#excerptEvidence.get(id);
      let record = evidenceId === undefined ? undefined : this.evidence.get(evidenceId);
      // The exact store deliberately outlives the bounded ledger. Restore its
      // immutable provenance before P1 compilation, or omit it entirely: an
      // unbound retained body must never be labelled fresh merely because it is
      // still resident in memory.
      if (evidenceId !== undefined && record === undefined) {
        const retained = this.#excerptEvidenceRecords.get(id);
        if (retained !== undefined) {
          const restored = this.recordEvidence({
            kind: retained.kind,
            locator: retained.locator,
            digest: retained.digest,
            summary: retained.summary,
            ...(retained.workspaceIdentityDigest === undefined
              ? {}
              : { workspaceIdentityDigest: retained.workspaceIdentityDigest }),
            metadata: { ...(retained.metadata ?? {}), retainedObservedAt: retained.observedAt, provenanceRehydrated: true },
          });
          evidenceId = restored.id;
          record = restored;
          this.#excerptEvidence.set(id, restored.id);
          this.#excerptEvidenceRecords.set(id, restored);
        }
      }
      if (record?.freshness !== "fresh") continue;
      const text = renderExcerpt(excerpt);
      add({
        ...base(
          id,
          "file_excerpt",
          "tool",
          "untrusted",
          text,
          true,
          "snippet",
          {
            source: "runtime-read",
            locator: excerpt.path,
            digest: excerpt.checksum,
            observedAt: record?.observedAt ?? observedAt,
            ...(evidenceId === undefined ? {} : { parentEvidenceIds: [evidenceId] }),
          },
          [excerpt.path],
        ),
        freshness: { state: record?.freshness ?? "unknown" },
        representation: {
          resolution: "snippet",
          exact: true,
          text,
          range: { startLine: excerpt.startLine, endLine: excerpt.endLine },
        },
      });
    }

    // Summaries preserve provenance for non-read observations without promoting
    // their potentially large raw output into the exact-evidence bucket.
    for (const record of this.evidence.select({ requireFresh: true, limit: 256 }).records) {
      if (record.kind === "repository_map" || record.kind === "file_excerpt") continue;
      const kind: ContextItem["kind"] = record.kind === "test_result"
        ? "test_result"
        : record.kind === "review_finding"
          ? "decision"
          : "tool_observation";
      add(base(
        `summary-${record.id}`,
        kind,
        "tool",
        "untrusted",
        record.summary,
        false,
        "summary",
        { source: record.kind, locator: record.locator, digest: record.digest, observedAt: record.observedAt, parentEvidenceIds: [record.id] },
      ));
    }
    return items;
  }

  /** Reactivate exact observations selected for a new task without re-reading. */
  activateSelection(selection: SelectionResult): void {
    const relevanceById = new Map<string, number>();
    const ids: `excerpt-${string}`[] = [];
    for (const selected of selection.selected) {
      for (const id of this.#excerpts.idsForPath(selected.path)) {
        ids.push(id);
        relevanceById.set(id, selected.score);
      }
    }
    this.#recordEvictions(
      this.#activeExcerpts.activate(ids, this.#activeExcerptBudget, {
        relevanceById,
        protectedIds: this.#pendingPromotions,
      }),
      "budget",
    );
  }

  /** Add a freshly read file to the exact store and active working set. */
  addExcerpt(
    content: FileContent,
    options: {
      readonly pinnedByUser?: boolean;
      readonly relevanceScore?: number;
      /** Production reads use a lease so virtualization remains valid until compilation. */
      readonly leaseForNextCompiledPack?: boolean;
      /** Root/child lease owner; another agent's pack cannot release it. */
      readonly leaseOwner?: string;
    } = {},
  ): boolean {
    const excerpt = buildExcerpt(content, {
      ...(this.#options.maxExcerptLines !== undefined
        ? { maxLines: this.#options.maxExcerptLines }
        : {}),
    });
    const supersededPending = this.#excerpts.excerpts()
      .filter((existing) =>
        existing.path === excerpt.path &&
        existing.checksum === excerpt.checksum &&
        excerpt.startLine <= existing.startLine &&
        excerpt.endLine >= existing.endLine &&
        this.#pendingPromotions.has(excerptId(existing)))
      .map((existing) => excerptId(existing));
    const supersededSet = new Set(supersededPending);
    const otherProtectedTokens = [...this.#pendingPromotions]
      .filter((id) => !supersededSet.has(id))
      .reduce((sum, id) => {
        const pendingExcerpt = this.#excerpts.getById(id);
        return sum + (pendingExcerpt === undefined ? 0 : this.#wrappedExcerptTokens(id, pendingExcerpt));
      }, 0);
    const replacementId = excerptId(excerpt);
    const replacementTokens = this.#wrappedExcerptTokens(replacementId, excerpt);
    const canTransfer = otherProtectedTokens + replacementTokens <= Math.floor(this.#activeExcerptBudget * 0.7);
    const transferredOwners = new Set<string>();
    if (canTransfer) {
      for (const oldId of supersededPending) {
        for (const owner of this.#pendingPromotionOwners.get(oldId) ?? []) transferredOwners.add(owner);
      }
    }
    const added = this.#excerpts.add(excerpt, {
      ...(canTransfer ? {} : { preserveIds: this.#pendingPromotions }),
    });
    const superseded = this.#activeExcerpts.pruneMissing();
    this.#recordEvictions(superseded, "superseded");
    for (const entry of superseded) {
      this.#pendingPromotions.delete(entry.id);
      this.#pendingPromotionOwners.delete(entry.id);
    }
    const id = this.#excerpts.coveringId(excerpt);
    if (id !== undefined) {
      if (options.leaseForNextCompiledPack === true) {
        for (const owner of transferredOwners) {
          this.#leaseForNextCompiledPack(id, options.relevanceScore ?? 100, owner);
        }
        this.#leaseForNextCompiledPack(id, options.relevanceScore ?? 100, options.leaseOwner ?? "root");
      } else {
        this.#recordEvictions(
          this.#activeExcerpts.activate([id], this.#activeExcerptBudget, {
            ...options,
            protectedIds: this.#pendingPromotions,
          }),
          "budget",
        );
      }
    }
    return added;
  }

  #wrappedExcerptTokens(id: `excerpt-${string}`, excerpt: FileExcerpt): number {
    const evidenceId = this.#excerptEvidence.get(id) ?? id;
    return estimateRenderedTokens([
      `<context-item id="${evidenceId}" kind="file_excerpt">`,
      renderExcerpt(excerpt),
      "</context-item>",
    ].join("\n"));
  }

  /** Lease a complete exact read so sibling observations cannot evict it before the next pack. */
  #leaseForNextCompiledPack(id: `excerpt-${string}`, relevanceScore = 100, owner = "root"): boolean {
    for (const pendingId of [...this.#pendingPromotions]) {
      if (!this.#excerpts.hasId(pendingId)) {
        this.#pendingPromotions.delete(pendingId);
        this.#pendingPromotionOwners.delete(pendingId);
      }
    }
    const excerpt = this.#excerpts.getById(id);
    if (excerpt === undefined) return false;
    let protectedTokens = 0;
    for (const pendingId of this.#pendingPromotions) {
      const pendingExcerpt = this.#excerpts.getById(pendingId);
      if (pendingExcerpt !== undefined) {
        protectedTokens += this.#wrappedExcerptTokens(pendingId, pendingExcerpt);
      }
    }
    const candidateTokens = this.#pendingPromotions.has(id)
      ? 0
      : this.#wrappedExcerptTokens(id, excerpt);
    const promotionBudget = Math.floor(this.#activeExcerptBudget * 0.7);
    if (protectedTokens + candidateTokens > promotionBudget) return false;

    const protectedIds = new Set<string>(this.#pendingPromotions);
    protectedIds.add(id);
    this.#recordEvictions(
      this.#activeExcerpts.activate([id], this.#activeExcerptBudget, {
        relevanceScore,
        protectedIds,
      }),
      "budget",
    );
    if (!this.#activeExcerpts.has(id)) return false;
    this.#pendingPromotions.add(id);
    const owners = this.#pendingPromotionOwners.get(id) ?? new Set<string>();
    owners.add(owner);
    this.#pendingPromotionOwners.set(id, owners);
    return true;
  }

  /** Release only leases whose exact ranges were actually present in this provider pack. */
  markPromptCompiled(excerptIds: readonly string[], owner = "root"): void {
    for (const rawId of excerptIds) {
      const id = rawId as `excerpt-${string}`;
      const owners = this.#pendingPromotionOwners.get(id);
      if (owners === undefined) continue;
      owners.delete(owner);
      if (owners.size > 0) continue;
      this.#pendingPromotionOwners.delete(id);
      this.#pendingPromotions.delete(id);
    }
  }

  /** Cancel this observer's new leases when its async acknowledgement is superseded. */
  cancelPromotionLeases(excerptIds: readonly string[], owner = "root"): void {
    const deactivate: `excerpt-${string}`[] = [];
    for (const rawId of excerptIds) {
      const id = rawId as `excerpt-${string}`;
      const owners = this.#pendingPromotionOwners.get(id);
      owners?.delete(owner);
      if (owners !== undefined && owners.size > 0) continue;
      this.#pendingPromotionOwners.delete(id);
      this.#pendingPromotions.delete(id);
      deactivate.push(id);
    }
    this.#recordEvictions(this.#activeExcerpts.deactivate(deactivate), "budget");
  }

  /** Release every outstanding lease owned by a terminal/cancelled agent. */
  cancelPromotionLeasesForOwner(owner: string): void {
    const owned = [...this.#pendingPromotionOwners]
      .filter(([, owners]) => owners.has(owner))
      .map(([id]) => id);
    this.cancelPromotionLeases(owned, owner);
  }

  /** Safe descriptor paired with an exact materialization for provider-history deduplication. */
  exactExcerptDescriptor(id: string): {
    id: `excerpt-${string}`;
    path: string;
    text: string;
    checksum: string;
    startLine: number;
    endLine: number;
  } | undefined {
    const excerpt = this.#excerpts.getById(id);
    if (excerpt === undefined) return undefined;
    return {
      id: id as `excerpt-${string}`,
      path: excerpt.path,
      text: excerpt.text,
      checksum: excerpt.checksum,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
    };
  }

  /** Exact body lookup used for duplicate-context telemetry (never rendered to the user). */
  exactExcerptText(id: string): string | undefined {
    return this.#excerpts.getById(id)?.text;
  }

  estimatedTokensForExcerpts(ids: readonly string[]): number {
    return ids.reduce((sum, id) => {
      const excerpt = this.#excerpts.getById(id);
      return sum + (excerpt === undefined ? 0 : estimateRenderedTokens(renderExcerpt(excerpt)));
    }, 0);
  }

  /** Drop an atomic read-many promotion when any sibling must remain raw. */
  #rollbackPromotions(
    ids: readonly `excerpt-${string}`[],
    preserve: ReadonlySet<string> = new Set(),
    owner = "root",
  ): void {
    const createdHere = ids.filter((id) => !preserve.has(id));
    const unprotected: `excerpt-${string}`[] = [];
    for (const id of createdHere) {
      const owners = this.#pendingPromotionOwners.get(id);
      owners?.delete(owner);
      if (owners !== undefined && owners.size > 0) continue;
      this.#pendingPromotionOwners.delete(id);
      this.#pendingPromotions.delete(id);
      unprotected.push(id);
    }
    this.#recordEvictions(this.#activeExcerpts.deactivate(unprotected), "budget");
  }

  /** Drop path-bound prompt data and evidence after a committed mutation. */
  invalidate(
    path: string,
    reason = "path changed",
    options: { readonly workspaceChanged?: boolean } = {},
  ): ContextInvalidation {
    const normalized = normalizeObservationPath(path);
    const activeRemoved = this.#activeExcerpts.deactivatePath(normalized);
    this.#recordEvictions(activeRemoved, "invalidated");
    const staleIds = this.#excerpts.idsForPath(normalized);
    const excerptsRemoved = this.#excerpts.invalidate(normalized);
    for (const id of staleIds) {
      this.#excerptEvidence.delete(id);
      this.#excerptEvidenceRecords.delete(id);
      this.#pendingPromotions.delete(id);
      this.#pendingPromotionOwners.delete(id);
    }
    const workspaceChanged = options.workspaceChanged !== false;
    const evidenceInvalidated = this.evidence.invalidateWhere(
      (record) =>
        evidenceNamesPath(record, normalized) ||
        (workspaceChanged && isWorkspaceSnapshotEvidence(record)),
      reason,
    );
    if (workspaceChanged) {
      this.#mapDirty = true;
      // A repository map is a workspace snapshot, not a timeless orientation fact.
      // Omit it and stop selecting against it until the next bounded scan.
      this.#map = undefined;
      this.#mapEvidenceId = undefined;
      this.#lastSelection = undefined;
    }
    return { excerptsRemoved, evidenceInvalidated };
  }

  /** Fail closed when a tool may have changed paths it cannot enumerate. */
  invalidateWorkspace(reason = "workspace may have changed"): ContextInvalidation {
    const active = this.#activeExcerpts.entries();
    this.#recordEvictions(this.#activeExcerpts.deactivate(active.map((entry) => entry.id)), "invalidated");
    let excerptsRemoved = 0;
    for (const excerpt of this.#excerpts.excerpts()) {
      excerptsRemoved += this.#excerpts.invalidate(excerpt.path);
    }
    this.#excerptEvidence.clear();
    this.#excerptEvidenceRecords.clear();
    this.#pendingPromotions.clear();
    this.#pendingPromotionOwners.clear();
    const evidenceInvalidated = this.evidence.invalidateWhere(() => true, reason);
    this.#mapDirty = true;
    this.#map = undefined;
    this.#mapEvidenceId = undefined;
    this.#lastSelection = undefined;
    return { excerptsRemoved, evidenceInvalidated };
  }

  #recordEvictions(
    entries: readonly ActiveExcerptEntry[],
    reason: ContextExcerptEviction["reason"],
  ): void {
    for (const entry of entries) this.#pendingEvictions.push({ ...entry, reason });
  }

  /**
   * Promote a typed runtime observation into durable evidence and the bounded
   * working set. Shape validation is deliberately local: malformed extension or
   * stale cache data is rejected rather than asserted to the model.
   */
  ingestToolObservation(event: ToolObservation): ToolObservationIngestResult {
    const evidence: EvidenceRecord[] = [];
    const excerptIds: `excerpt-${string}`[] = [];
    const invalidatedEvidenceIds: `evidence-${string}`[] = [];
    const rejected: Array<{ reason: string; locator?: string }> = [];
    const artifacts = event.execution.result.artifacts ?? [];
    for (const artifact of artifacts) {
      this.recordArtifactHandle(artifact, artifact.displayName ?? event.action.display);
    }
    const observedAt = new Date(event.observedAtMs).toISOString();
    const provenance = observationMetadata(event);

    const record = (input: Omit<EvidenceInput, "observedAt">): EvidenceRecord => {
      const created = this.recordEvidence({ ...input, observedAt });
      evidence.push(created);
      return created;
    };

    const promotedThisCall: `excerpt-${string}`[] = [];
    const leaseOwner = event.agentId ?? "root";
    const pendingBeforeCall = new Set<string>(
      [...this.#pendingPromotionOwners]
        .filter(([, owners]) => owners.has(leaseOwner))
        .map(([id]) => id),
    );
    const invalidateFailedReadPath = (rawPath: string, reason: string): void => {
      const invalidation = this.invalidate(normalizeObservationPath(rawPath), reason);
      for (const candidate of invalidation.evidenceInvalidated) {
        if (!invalidatedEvidenceIds.includes(candidate.id)) invalidatedEvidenceIds.push(candidate.id);
      }
    };

    const ingestRead = (value: unknown): {
      handled: boolean;
      disposition: "promoted" | "withheld" | "raw";
      path?: string;
    } => {
      // Path/checksum identity is validated before the detailed body. A new
      // runtime checksum invalidates the old version even when the replacement
      // is binary, empty, or otherwise malformed.
      if (!isRecord(value)) {
        rejected.push({ reason: "read result is not an object" });
        return { handled: false, disposition: "raw" };
      }
      const rawPath = stringField(value, "path");
      if (rawPath === undefined) {
        rejected.push({ reason: "read result has no path" });
        return { handled: false, disposition: "raw" };
      }
      const checksum = stringField(value, "checksum");
      if (checksum === undefined) {
        rejected.push({ reason: "read result has no runtime checksum", locator: rawPath });
        return { handled: false, disposition: "raw" };
      }
      const path = normalizeObservationPath(rawPath);
      if (!requestedReadPaths.has(path)) {
        rejected.push({ reason: "runtime read path was not bound to the requested path", locator: path });
        return { handled: true, disposition: "withheld" };
      }
      this.#noteToolPath(path);

      const checksumDrift = this.#excerpts.isStale(path, checksum) || this.evidence.all().some(
        (candidate) =>
          candidate.freshness === "fresh" &&
          candidate.metadata?.path === path &&
          typeof candidate.metadata.runtimeChecksum === "string" &&
          candidate.metadata.runtimeChecksum !== checksum,
      );
      if (checksumDrift) {
        // A changed checksum is an externally observed workspace mutation. Exact
        // excerpts are not the only dependent facts: maps, searches, diffs, and
        // test outcomes are snapshot-scoped and must become stale together.
        const invalidation = this.invalidate(path, "runtime checksum changed");
        for (const candidate of invalidation.evidenceInvalidated) {
          if (!invalidatedEvidenceIds.includes(candidate.id)) invalidatedEvidenceIds.push(candidate.id);
        }
      }

      const parsed = parseReadObservation(value);
      if (!parsed.ok) {
        rejected.push({ reason: parsed.reason, ...(parsed.path !== undefined ? { locator: parsed.path } : {}) });
        return { handled: false, disposition: "raw" };
      }

      if (parsed.binary) {
        record({
          kind: "tool_observation",
          locator: path,
          digest: parsed.checksum,
          summary: `${path} is binary; no text was indexed`,
          metadata: { ...provenance, path, runtimeChecksum: parsed.checksum, binary: true },
        });
        // Keep the runtime's binary locator in L7; no exact text entered L6.
        return { handled: true, disposition: "withheld" };
      }
      if (isSensitivePath(path)) {
        record({
          kind: "tool_observation",
          locator: path,
          digest: parsed.checksum,
          summary: `${path} was read explicitly; sensitive content was withheld from context indexing`,
          metadata: { ...provenance, path, runtimeChecksum: parsed.checksum, sensitive: true },
        });
        rejected.push({ reason: "sensitive path content is not indexed", locator: path });
        return { handled: true, disposition: "withheld" };
      }

      const returnedLines = parsed.endLine >= parsed.startLine
        ? parsed.endLine - parsed.startLine + 1
        : 0;
      const maxExcerptLines = this.#options.maxExcerptLines ?? DEFAULT_EXCERPT_LINES;
      if (returnedLines > maxExcerptLines) {
        record({
          kind: "tool_observation",
          locator: `${path}#L${parsed.startLine}-L${parsed.endLine}`,
          digest: evidenceDigest({ path, runtimeChecksum: parsed.checksum, text: parsed.text }),
          summary: `${path}:${parsed.startLine}-${parsed.endLine} exceeded the ${maxExcerptLines}-line exact-promotion window`,
          metadata: {
            ...provenance,
            path,
            runtimeChecksum: parsed.checksum,
            startLine: parsed.startLine,
            endLine: parsed.endLine,
            totalLines: parsed.totalLines,
            exactContentRetained: false,
          },
        });
        rejected.push({
          reason: `complete read exceeds the ${maxExcerptLines}-line exact-promotion window`,
          locator: path,
        });
        return { handled: true, disposition: "raw" };
      }

      const content: FileContent = {
        path,
        text: parsed.text,
        checksum: parsed.checksum,
        totalLines: parsed.totalLines,
        startLine: parsed.startLine,
      };
      const built = buildExcerpt(content, {
        ...(this.#options.maxExcerptLines !== undefined
          ? { maxLines: this.#options.maxExcerptLines }
          : {}),
      });
      this.addExcerpt(content, {
        relevanceScore: 100,
        leaseForNextCompiledPack: true,
        leaseOwner,
      });
      const id = this.#excerpts.coveringId(built);
      if (id === undefined) {
        rejected.push({ reason: "exact excerpt could not be retained", locator: path });
        return { handled: false, disposition: "raw" };
      }
      const stored = this.#excerpts.getById(id);
      if (stored === undefined) {
        rejected.push({ reason: "retained excerpt disappeared before activation", locator: path });
        return { handled: false, disposition: "raw" };
      }
      const created = record({
        kind: "file_excerpt",
        locator: `${path}#L${built.startLine}-L${built.endLine}`,
        digest: evidenceDigest({
          path,
          runtimeChecksum: parsed.checksum,
          startLine: built.startLine,
          endLine: built.endLine,
          text: built.text,
        }),
        summary: `${path}:${built.startLine}-${built.endLine} (sha256:${parsed.checksum.slice(0, 12)}…)`,
        metadata: {
          ...provenance,
          path,
          runtimeChecksum: parsed.checksum,
          startLine: built.startLine,
          endLine: built.endLine,
          totalLines: built.totalLines,
          excerptId: id,
          ...(excerptId(built) !== id ? { coveredByExcerptId: id } : {}),
        },
      });

      // A contained reread may resolve to a wider stored excerpt. Never relabel
      // that wider exact source with the narrower observation's evidence ID.
      if (this.#excerptEvidence.get(id) === undefined) {
        if (excerptId(built) === id) {
          this.#excerptEvidence.set(id, created.id);
          this.#excerptEvidenceRecords.set(id, created);
        } else {
          const covering = record({
            kind: "file_excerpt",
            locator: `${path}#L${stored.startLine}-L${stored.endLine}`,
            digest: evidenceDigest({
              path,
              runtimeChecksum: stored.checksum,
              startLine: stored.startLine,
              endLine: stored.endLine,
              text: stored.text,
            }),
            summary: `${path}:${stored.startLine}-${stored.endLine} (sha256:${stored.checksum.slice(0, 12)}…)`,
            metadata: {
              ...provenance,
              path,
              runtimeChecksum: stored.checksum,
              startLine: stored.startLine,
              endLine: stored.endLine,
              totalLines: stored.totalLines,
              excerptId: id,
            },
          });
          this.#excerptEvidence.set(id, covering.id);
          this.#excerptEvidenceRecords.set(id, covering);
        }
      }

      if (!this.#activeExcerpts.has(id) || !this.#pendingPromotions.has(id)) {
        rejected.push({ reason: "exact excerpt exceeded the active prompt budget or a pending promotion lease", locator: path });
        return { handled: true, disposition: "raw" };
      }
      excerptIds.push(id);
      promotedThisCall.push(id);
      return { handled: true, disposition: "promoted", path };
    };

    let handled = true;
    let exactContentPromoted = false;
    let safeToVirtualize = false;
    const partiallyPromotedPaths: string[] = [];
    const data = event.execution.result.data;
    const requestedReadPaths = new Set((event.action.reads ?? []).map(normalizeObservationPath));
    switch (event.action.toolId) {
      case "fs.read": {
        if (!event.execution.result.ok) {
          for (const path of event.action.reads ?? []) {
            invalidateFailedReadPath(path, "explicit reread could not revalidate the path");
          }
          record({
            kind: "tool_observation",
            locator: actionLocator(event.action),
            digest: evidenceDigest({ result: event.execution.result, text: event.execution.text }),
            summary: "Read failed; the requested path could not be revalidated",
            metadata: provenance,
          });
          break;
        }
        const read = ingestRead(data);
        handled = read.handled;
        exactContentPromoted = read.disposition === "promoted";
        safeToVirtualize = read.disposition !== "raw";
        break;
      }
      case "fs.read_many": {
        if (!event.execution.result.ok) {
          for (const path of event.action.reads ?? []) {
            invalidateFailedReadPath(path, "explicit read_many could not revalidate the path");
          }
          rejected.push({ reason: "fs.read_many failed before returning a valid files array" });
          handled = false;
          break;
        }
        if (!isRecord(data) || !Array.isArray(data.files)) {
          rejected.push({ reason: "fs.read_many result has no valid files array" });
          handled = false;
          break;
        }
        let validFiles = 0;
        let anyPromoted = false;
        let anyWithheld = false;
        let allSafeToVirtualize = data.files.length > 0;
        for (const file of data.files) {
          const read = ingestRead(file);
          if (read.handled) validFiles += 1;
          if (read.disposition === "promoted") {
            anyPromoted = true;
            if (read.path !== undefined) partiallyPromotedPaths.push(read.path);
          }
          if (read.disposition === "withheld") anyWithheld = true;
          if (read.disposition === "raw") allSafeToVirtualize = false;
        }
        safeToVirtualize = allSafeToVirtualize && validFiles === data.files.length;
        // Any sensitive/binary member makes the aggregate a truthful withheld
        // locator even when other safe members were promoted exactly.
        exactContentPromoted = safeToVirtualize && anyPromoted && !anyWithheld;
        if (safeToVirtualize) {
          // The whole output will be locatorized; no per-member rewrite is needed.
          partiallyPromotedPaths.length = 0;
        }
        // When only a subset is exact, keep its leases and expose the member plan
        // to the executor. It strips those bodies while retaining raw siblings.

        const errors = Array.isArray(data.errors)
          ? data.errors.filter(isRecord).slice(0, 20)
          : [];
        if (errors.length > 0) {
          const safeErrors: string[] = [];
          let withheldErrors = 0;
          for (const entry of errors) {
            const rawPath = stringField(entry, "path");
            const path = rawPath === undefined ? undefined : normalizeObservationPath(rawPath);
            if (path === undefined || !requestedReadPaths.has(path) || isSensitivePath(path)) {
              withheldErrors += 1;
              continue;
            }
            invalidateFailedReadPath(path, "fs.read_many could not revalidate the path");
            safeErrors.push(`${path}: ${oneLine(stringField(entry, "message") ?? "read failed")}`);
          }
          const visibleSummary = [
            ...safeErrors,
            ...(withheldErrors > 0 ? [`${withheldErrors} sensitive or unbound error(s) withheld`] : []),
          ].join("; ");
          record({
            kind: "tool_observation",
            locator: `fs.read_many:errors:${event.action.callId}`,
            digest: evidenceDigest({ count: errors.length, safeErrors, withheldErrors }),
            summary: `${errors.length} partial read error(s): ${visibleSummary}`,
            metadata: { ...provenance, validFiles, errors: errors.length, withheldErrors },
          });
        }
        if (validFiles === 0 && data.files.length > 0) handled = false;
        break;
      }
      case "fs.search": {
        if (!event.execution.result.ok || !isRecord(data) || !Array.isArray(data.matches)) {
          rejected.push({ reason: "fs.search result has no valid matches array" });
          handled = false;
          break;
        }
        const query = stringField(event.action.arguments, "query") ?? "";
        const matches = data.matches.filter(isSearchMatch).slice(0, 200);
        const counts = new Map<string, number>();
        for (const match of matches) {
          const path = normalizeObservationPath(match.path);
          counts.set(path, (counts.get(path) ?? 0) + 1);
          this.#searchMatches.set(path, Math.min(20, (this.#searchMatches.get(path) ?? 0) + 1));
          this.#noteToolPath(path);
        }
        this.#trimSearchMatches();
        const top = [...counts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 12);
        record({
          kind: "tool_observation",
          locator: `fs.search:${query}`,
          digest: evidenceDigest({ query, matches }),
          summary: `${matches.length} search match(es)${top.length > 0 ? `: ${top.map(([path, count]) => `${path} (${count})`).join(", ")}` : ""}`,
          metadata: {
            ...provenance,
            query: query.slice(0, 500),
            matches: matches.length,
            files: counts.size,
            topPaths: top.map(([path]) => path).join(",").slice(0, 1_000),
            truncated: data.truncated === true,
          },
        });
        break;
      }
      case "process.run":
      case "shell.run": {
        const display = event.action.display;
        const testLike = /(^|\s)(test|check|lint|typecheck)(\s|$)|cargo test|bun test|pytest|go test/i.test(display);
        const artifact = artifacts[0];
        record({
          kind: testLike ? "test_result" : "tool_observation",
          locator: display.slice(0, 1_000),
          digest: evidenceDigest({
            display,
            ok: event.execution.result.ok,
            exitCode: event.execution.exitCode,
            text: event.execution.text,
            artifacts: artifacts.map(({ id, digest }) => ({ id, digest })),
          }),
          summary: `${display}: ${event.execution.result.ok ? "passed" : "failed"}${event.execution.exitCode !== undefined ? ` (exit ${event.execution.exitCode})` : ""}`,
          metadata: {
            ...provenance,
            ok: event.execution.result.ok,
            ...(event.execution.exitCode !== undefined ? { exitCode: event.execution.exitCode } : {}),
            ...(event.execution.durationMs !== undefined ? { durationMs: event.execution.durationMs } : {}),
            ...(artifact !== undefined ? {
              artifactId: artifact.id,
              artifactDigest: artifact.digest,
              artifactBytes: artifact.bytes,
            } : {}),
          },
        });
        break;
      }
      case "git.diff": {
        if (!event.execution.result.ok || !isRecord(data) || !Array.isArray(data.files)) {
          rejected.push({ reason: "git.diff result has no valid files array" });
          handled = false;
          break;
        }
        const files = data.files.filter(isRecord);
        const paths = files
          .map((file) => stringField(file, "path"))
          .filter((path): path is string => path !== undefined)
          .map(normalizeObservationPath);
        for (const path of paths) this.#noteToolPath(path);
        const artifact = artifacts[0];
        record({
          kind: "tool_observation",
          locator: `git.diff:${paths.join(",")}`,
          digest: evidenceDigest({ files, text: event.execution.text }),
          summary: `${paths.length} changed file(s): ${paths.slice(0, 20).join(", ")}`,
          metadata: {
            ...provenance,
            paths: paths.join(",").slice(0, 2_000),
            files: paths.length,
            additions: numberField(data, "totalAdditions") ?? 0,
            deletions: numberField(data, "totalDeletions") ?? 0,
            ...(artifact !== undefined ? {
              artifactId: artifact.id,
              artifactDigest: artifact.digest,
              artifactBytes: artifact.bytes,
            } : {}),
          },
        });
        break;
      }
      default:
        handled = false;
        break;
    }

    return {
      handled,
      exactContentPromoted,
      safeToVirtualize,
      evidence,
      excerptIds: [...new Set(excerptIds)],
      newlyLeasedExcerptIds: [...new Set(promotedThisCall.filter((id) =>
        !pendingBeforeCall.has(id) && this.#pendingPromotionOwners.get(id)?.has(leaseOwner) === true
      ))],
      partiallyPromotedPaths: [...new Set(partiallyPromotedPaths)],
      invalidatedEvidenceIds: [...new Set(invalidatedEvidenceIds)],
      artifactIds: artifacts.map((artifact) => artifact.id),
      rejected,
    };
  }

  #noteToolPath(path: string): void {
    this.#recentToolPaths = [...this.#recentToolPaths.filter((entry) => entry !== path), path].slice(-64);
  }

  #trimSearchMatches(): void {
    if (this.#searchMatches.size <= 256) return;
    const keep = [...this.#searchMatches.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 256);
    this.#searchMatches.clear();
    for (const [path, count] of keep) this.#searchMatches.set(path, count);
  }

  /** Register a runtime-minted, model-callable artifact without duplicating inspector rows. */
  recordArtifactHandle(artifact: ArtifactRef, label = artifact.displayName ?? artifact.id): void {
    if (this.#artifactHandles.has(artifact.id)) return;
    this.#artifactHandles.set(artifact.id, artifact);
    this.noteExcludedOutput(label, artifact.bytes, artifact.id);
  }

  /** Record output that was spilled rather than included, for the inspector. */
  noteExcludedOutput(label: string, bytes: number, artifactId?: string): void {
    this.#excludedOutputs.push({
      label,
      bytes,
      ...(artifactId !== undefined ? { artifactId } : {}),
    });
  }

  /**
   * Materialize the bounded L6 view from one fresh evidence selection. The
   * resulting manifest is retained so telemetry/cache/inspector can describe the
   * exact strings handed to prompt assembly rather than a parallel estimate.
   */
  repositoryContext(options: {
    includeMap?: boolean;
    evidence?: EvidenceSelection;
    maxTokens?: number;
  } = {}): string[] {
    const materializationBudget = Math.min(
      this.#activeExcerptBudget,
      Math.max(0, Math.floor(options.maxTokens ?? this.#activeExcerptBudget)),
    );
    // Exact bodies get a fixed majority; the remainder bounds provenance index,
    // wrappers, map, and handles. Pending virtualized reads use this same ratio.
    const excerptBudget = Math.floor(materializationBudget * 0.7);
    this.#recordEvictions(
      this.#activeExcerpts.evictUntilWithin(excerptBudget, this.#pendingPromotions),
      "budget",
    );

    const requested = options.evidence ?? this.selectEvidence({ limit: 64, requireFresh: true });
    const requestedIds = requested.records.map((record) => record.id);
    const revalidated = this.selectEvidence({ ids: requestedIds, requireFresh: true });
    const records = new Map(revalidated.records.map((record) => [record.id, record]));
    const rejected = [...requested.rejected, ...revalidated.rejected];

    // Orientation and active exact ranges are hard compiler dependencies. Add
    // their evidence records when fresh even if a caller supplied a narrower
    // soft selection; stale dependencies remain rejected and absent.
    // The bounded ledger may trim old facts while the exact store intentionally
    // retains their bodies. Rehydrate active provenance from its immutable record
    // before freshness selection rather than leaving a permanently orphaned range.
    for (const id of this.#activeExcerpts.excerptIds()) {
      const evidenceId = this.#excerptEvidence.get(id);
      if (evidenceId === undefined || this.evidence.get(evidenceId) !== undefined) continue;
      const retained = this.#excerptEvidenceRecords.get(id);
      if (retained === undefined) continue;
      const restored = this.recordEvidence({
        kind: retained.kind,
        locator: retained.locator,
        digest: retained.digest,
        summary: retained.summary,
        ...(retained.workspaceIdentityDigest !== undefined
          ? { workspaceIdentityDigest: retained.workspaceIdentityDigest }
          : {}),
        metadata: {
          ...(retained.metadata ?? {}),
          retainedObservedAt: retained.observedAt,
          provenanceRehydrated: true,
        },
      });
      this.#excerptEvidence.set(id, restored.id);
      this.#excerptEvidenceRecords.set(id, restored);
    }

    const dependencyIds: `evidence-${string}`[] = [];
    if (options.includeMap !== false && this.#mapEvidenceId !== undefined) {
      dependencyIds.push(this.#mapEvidenceId);
    }
    for (const id of this.#activeExcerpts.excerptIds()) {
      const evidenceId = this.#excerptEvidence.get(id);
      if (evidenceId !== undefined) dependencyIds.push(evidenceId);
    }
    if (dependencyIds.length > 0) {
      const dependencies = this.selectEvidence({ ids: dependencyIds, requireFresh: true });
      for (const record of dependencies.records) records.set(record.id, record);
      rejected.push(...dependencies.rejected);
    }

    const selected = [...records.values()].sort(
      (left, right) => right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id),
    );
    const selectedIds = new Set(selected.map((record) => record.id));
    const budgetRejected: Array<{ id: string; reason: string }> = [];
    const exactSections: string[] = [];
    const activeIds: `excerpt-${string}`[] = [];
    const exactEvidenceIds = new Set<`evidence-${string}`>();
    const withinBudget = (candidate: readonly string[]): boolean =>
      cachedEstimateTokens(candidate.join("\n\n")) <= materializationBudget;

    // Exact active ranges have first claim because their L7 copies may already be
    // virtualized. Leases were admitted against the same 70% quota.
    const materializationOrder = [...this.#activeExcerpts.excerptIds()].sort((left, right) =>
      Number(this.#pendingPromotions.has(right)) - Number(this.#pendingPromotions.has(left)) || left.localeCompare(right)
    );
    for (const id of materializationOrder) {
      const excerpt = this.#excerpts.getById(id);
      if (excerpt === undefined) continue;
      const evidenceId = this.#excerptEvidence.get(id);
      if (evidenceId !== undefined && !selectedIds.has(evidenceId)) continue;
      const rendered = this.#excerpts.rendered([id])[0];
      if (rendered === undefined) continue;
      const section = [
        `<context-item id="${evidenceId ?? id}" kind="file_excerpt">`,
        rendered,
        "</context-item>",
      ].join("\n");
      if (!withinBudget([...exactSections, section])) {
        budgetRejected.push({ id, reason: "exact excerpt omitted by complete L6 token budget" });
        continue;
      }
      exactSections.push(section);
      activeIds.push(id);
      if (evidenceId !== undefined) exactEvidenceIds.add(evidenceId);
    }

    let mapSection: string | undefined;
    if (options.includeMap !== false && this.#map && this.#mapEvidenceId !== undefined && selectedIds.has(this.#mapEvidenceId)) {
      const candidate = [
        `<context-item id="${this.#mapEvidenceId}" kind="repository_map">`,
        renderRepositoryMap(this.#map),
        "</context-item>",
      ].join("\n");
      if (withinBudget([candidate, ...exactSections])) mapSection = candidate;
      else budgetRejected.push({ id: this.#mapEvidenceId, reason: "repository map omitted by complete L6 token budget" });
    }

    const indexRecords: EvidenceRecord[] = [];
    const prioritized = [...selected].sort(
      (left, right) => Number(exactEvidenceIds.has(right.id)) - Number(exactEvidenceIds.has(left.id)) ||
        right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id),
    );
    const renderIndex = (entries: readonly EvidenceRecord[]): string | undefined => entries.length === 0
      ? undefined
      : [
          "<evidence-index>",
          ...entries.map((record) =>
            `- ${record.id} [${record.kind}] ${oneLine(record.locator).slice(0, 800)}: ${oneLine(record.summary).slice(0, 800)}`
          ),
          "</evidence-index>",
        ].join("\n");
    for (const record of prioritized) {
      const trial = renderIndex([...indexRecords, record]);
      const trialSections = [
        ...(mapSection !== undefined ? [mapSection] : []),
        ...(trial !== undefined ? [trial] : []),
        ...exactSections,
      ];
      if (withinBudget(trialSections)) indexRecords.push(record);
      else budgetRejected.push({ id: record.id, reason: "evidence index entry omitted by complete L6 token budget" });
    }

    const chosenRecordIds = new Set<`evidence-${string}`>([
      ...exactEvidenceIds,
      ...indexRecords.map((record) => record.id),
      ...(mapSection !== undefined && this.#mapEvidenceId !== undefined ? [this.#mapEvidenceId] : []),
    ]);
    const handleLines: string[] = [];
    for (const record of selected) {
      if (!chosenRecordIds.has(record.id)) continue;
      const artifactId = record.metadata?.artifactId;
      if (typeof artifactId !== "string") continue;
      const artifact = this.#artifactHandles.get(artifactId);
      if (artifact === undefined) continue;
      const line = `- ${artifact.id} sha256:${artifact.digest} ${artifact.bytes} bytes ${artifact.mediaType}`;
      const trialHandles = ["<artifact-handles>", ...handleLines, line, "</artifact-handles>"].join("\n");
      const trialSections = [
        ...(mapSection !== undefined ? [mapSection] : []),
        ...(renderIndex(indexRecords) !== undefined ? [renderIndex(indexRecords)!] : []),
        ...exactSections,
        trialHandles,
      ];
      if (withinBudget(trialSections)) handleLines.push(line);
      else budgetRejected.push({ id: record.id, reason: "artifact handle omitted by complete L6 token budget" });
    }

    const sections = [
      ...(mapSection !== undefined ? [mapSection] : []),
      ...(renderIndex(indexRecords) !== undefined ? [renderIndex(indexRecords)!] : []),
      ...exactSections,
      ...(handleLines.length > 0 ? [["<artifact-handles>", ...handleLines, "</artifact-handles>"].join("\n")] : []),
    ];
    const uniqueRejected = dedupeRejections([...rejected, ...budgetRejected]);
    this.#lastMaterialization = {
      evidenceIds: [...chosenRecordIds],
      excerptIds: activeIds,
      rejected: uniqueRejected,
      estimatedTokens: cachedEstimateTokens(sections.join("\n\n")),
      omitted: requested.omitted + budgetRejected.length,
    };
    return sections;
  }

  /** Build the §18.10 inspector view. */
  inspect(input: {
    readonly activeSkills?: readonly SkillMetadata[];
    readonly loadedSkillBodies?: readonly { name: string; body: string }[];
    readonly toolSchemaIds?: readonly string[];
    readonly stablePrefixText?: string;
    readonly compactState?: string;
    readonly taskText?: string;
    readonly userInput?: string;
    readonly historyText?: string;
    readonly reasoningItemCount?: number;
    readonly policyText?: string;
    readonly toolProtocolText?: string;
    readonly cachePrefixFingerprint?: string;
    /** Exact L6 text from the last compiled provider request; avoids recompilation. */
    readonly repositoryText?: string;
    readonly compiledPackId?: string;
    readonly compiledInputTokens?: number;
    /** Exact per-layer attribution captured by prompt assembly for this pack. */
    readonly layerTokenCounts?: Partial<Record<ContextLayerId, number>>;
    /** Exact excerpt membership from this pack, not the engine's later active set. */
    readonly activeExcerptIds?: readonly string[];
  }): ContextInspection {
    const repositoryText = input.repositoryText ?? this.repositoryContext().join("\n\n");
    const instructionsText = this.#instructions.map((file) => file.content).join("\n\n");
    const skillsText = [
      ...(input.activeSkills ?? []).map((skill) => `${skill.name}: ${skill.description}`),
      ...(input.loadedSkillBodies ?? []).map((skill) => skill.body),
    ].join("\n\n");
    const inspectedExcerptIds = input.activeExcerptIds ?? this.#activeExcerpts.excerptIds();
    const inspectedExcerpts = inspectedExcerptIds
      .map((id) => this.#excerpts.getById(id))
      .filter((excerpt): excerpt is FileExcerpt => excerpt !== undefined);

    const layers: InspectorLayerRow[] = [
      {
        layer: "L0_policy",
        estimatedTokens: input.layerTokenCounts?.L0_policy ?? cachedEstimateTokens(input.policyText ?? ""),
        detail: "root operating contract",
      },
      {
        layer: "L1_tool_semantics",
        estimatedTokens: input.layerTokenCounts?.L1_tool_semantics ?? cachedEstimateTokens(input.toolProtocolText ?? ""),
        detail: `${(input.toolSchemaIds ?? []).length} active tool schema(s)`,
      },
      {
        layer: "L2_project_instructions",
        estimatedTokens: input.layerTokenCounts?.L2_project_instructions ?? cachedEstimateTokens(instructionsText),
        detail:
          this.#instructions.length === 0
            ? "none loaded"
            : this.#instructions.map((file) => file.path).join(", "),
      },
      {
        layer: "L3_active_skills",
        estimatedTokens: input.layerTokenCounts?.L3_active_skills ?? cachedEstimateTokens(skillsText),
        detail: `${(input.activeSkills ?? []).length} catalogued, ${
          (input.loadedSkillBodies ?? []).length
        } loaded`,
      },
      {
        layer: "L4_task_and_plan",
        estimatedTokens: input.layerTokenCounts?.L4_task_and_plan ?? cachedEstimateTokens(input.taskText ?? ""),
        detail: input.taskText === undefined ? "no explicit task" : "current task and plan",
      },
      {
        layer: "L5_compact_state",
        estimatedTokens: input.layerTokenCounts?.L5_compact_state ?? cachedEstimateTokens(input.compactState ?? ""),
        detail:
          input.compactState === undefined
            ? "not compacted"
            : `compacted summary in use, carrying ${this.#reflections.length} unresolved failure(s)`,
      },
      {
        layer: "L6_repository_context",
        estimatedTokens: input.layerTokenCounts?.L6_repository_context ?? cachedEstimateTokens(repositoryText),
        detail: `${inspectedExcerpts.length} active excerpt(s) (${this.#excerpts.size} exact retained at compilation) across ${
          new Set(inspectedExcerpts.map((excerpt) => excerpt.path)).size
        } file(s)`,
      },
      {
        layer: "L7_tool_observations",
        estimatedTokens: input.layerTokenCounts?.L7_tool_observations ?? cachedEstimateTokens(input.historyText ?? ""),
        detail: "prior conversation and tool observations",
      },
      {
        layer: "L8_user_input",
        estimatedTokens: input.layerTokenCounts?.L8_user_input ?? cachedEstimateTokens(input.userInput ?? ""),
        detail: "latest user message",
      },
    ];

    const usedTokens = input.compiledInputTokens ??
      layers.reduce((sum, row) => sum + row.estimatedTokens, 0);
    const budget = this.#options.softContextTokens;

    const inspection: ContextInspection = {
      softBudgetTokens: budget,
      usedTokens,
      usedFraction: budget === 0 ? 0 : usedTokens / budget,
      layers,
      activeFiles: inspectedExcerpts.map((excerpt) => ({
          path: excerpt.path,
          lines: `${excerpt.startLine}-${excerpt.endLine} of ${excerpt.totalLines}`,
          checksum: excerpt.checksum,
        })),
      skills: (input.activeSkills ?? []).map((skill) => ({
        name: skill.name,
        ...(skill.version !== undefined ? { version: skill.version } : {}),
        source: skill.source,
      })),
      toolSchemas: [...(input.toolSchemaIds ?? [])],
      reasoning: {
        items: input.reasoningItemCount ?? 0,
        // §10.7/§18.10: presence only. Contents are never surfaced.
        note: "reasoning items are retained as opaque provider payloads and are never displayed",
      },
      ...(input.cachePrefixFingerprint !== undefined
        ? { cachePrefixFingerprint: input.cachePrefixFingerprint }
        : {}),
      ...(input.compiledPackId !== undefined ? { compiledPackId: input.compiledPackId } : {}),
      ...(input.compiledInputTokens !== undefined
        ? { compiledInputTokens: input.compiledInputTokens }
        : {}),
      ...(this.#lastCompiledContextPack === undefined ? {} : {
        compilerPack: {
          id: this.#lastCompiledContextPack.id,
          manifestDigest: this.#lastCompiledContextPack.manifest.digest,
          included: this.#lastCompiledContextPack.manifest.included.length,
          excluded: this.#lastCompiledContextPack.manifest.excluded.length,
          fallback: this.#lastCompiledContextPack.manifest.fallback.used,
        },
      }),
      excludedLargeOutputs: [...this.#excludedOutputs],
      instructionsSkipped: [...this.#instructionsSkipped],
      recentFailures: this.#reflections.map((reflection) => ({
        toolId: reflection.toolId,
        category: reflection.category,
        paths: [...reflection.paths],
      })),
    };
    return inspection;
  }
}

interface ParsedReadObservation {
  readonly ok: true;
  readonly path: string;
  readonly checksum: string;
  readonly binary: boolean;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly mode: "exact";
}

interface RejectedReadObservation {
  readonly ok: false;
  readonly reason: string;
  readonly path?: string;
}

function parseReadObservation(value: unknown): ParsedReadObservation | RejectedReadObservation {
  if (!isRecord(value)) return { ok: false, reason: "read result is not an object" };
  const path = stringField(value, "path");
  if (path === undefined) return { ok: false, reason: "read result has no path" };
  // Legacy sidecars did not carry mode metadata and are treated as exact because
  // their checksum was produced by the old full-read path. New previews are never
  // eligible for evidence promotion, even if an extension incorrectly attaches a
  // checksum to one.
  if (value.mode === "preview" || value.authoritativeForWrite === false) {
    return { ok: false, reason: "preview reads are not authoritative exact evidence", path };
  }
  if (value.mode !== undefined && value.mode !== "exact") {
    return { ok: false, reason: "read result has an unknown mode", path };
  }
  if (value.mode === "exact" && value.authoritativeForWrite !== true) {
    return { ok: false, reason: "exact read is not authoritative for writes", path };
  }
  const checksum = stringField(value, "checksum");
  if (checksum === undefined) return { ok: false, reason: "read result has no runtime checksum", path };
  if (value.binary === true) {
    return {
      ok: true,
      path,
      checksum,
      binary: true,
      text: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      mode: "exact",
    };
  }
  if (!isRecord(value.excerpt)) return { ok: false, reason: "read result has no excerpt object", path };
  const excerpt = value.excerpt;
  const excerptPath = stringField(excerpt, "path");
  if (excerptPath !== undefined && normalizeObservationPath(excerptPath) !== normalizeObservationPath(path)) {
    return { ok: false, reason: "read excerpt path disagrees with the file path", path };
  }
  const text = stringFieldAllowEmpty(excerpt, "text");
  const startLine = numberField(excerpt, "startLine");
  const endLine = numberField(excerpt, "endLine");
  const totalLines = numberField(excerpt, "totalLines");
  const excerptChecksum = stringField(excerpt, "checksum") ?? checksum;
  const emptyRange =
    text === "" && totalLines === 0 && startLine === 1 && (endLine === 0 || endLine === 1);
  if (
    text === undefined ||
    startLine === undefined ||
    endLine === undefined ||
    totalLines === undefined ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    !Number.isInteger(totalLines) ||
    startLine < 1 ||
    totalLines < 0 ||
    (!emptyRange && (endLine < startLine || endLine > totalLines))
  ) {
    return { ok: false, reason: "read excerpt range/text shape is invalid", path };
  }
  const textLines = text === ""
    ? (emptyRange ? 0 : 1)
    : text.endsWith("\n")
      ? text.slice(0, -1).split("\n").length
      : text.split("\n").length;
  if (!emptyRange && textLines !== endLine - startLine + 1) {
    return { ok: false, reason: "read excerpt line count disagrees with its range", path };
  }
  if (excerptChecksum !== checksum) {
    return { ok: false, reason: "read excerpt checksum disagrees with the file checksum", path };
  }
  return {
    ok: true,
    path,
    checksum,
    binary: false,
    text,
    startLine,
    endLine: emptyRange ? 0 : endLine,
    totalLines,
    mode: "exact",
  };
}

function observationMetadata(event: ToolObservation): Record<string, string | number | boolean> {
  return {
    toolId: event.action.toolId,
    callId: event.action.callId,
    cacheHit: event.cacheHit,
    observedAtMs: event.observedAtMs,
    ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
  };
}

function normalizeObservationPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/u, "");
}

function actionLocator(action: ProposedAction): string {
  const input = isRecord(action.arguments) ? action.arguments : {};
  return stringField(input, "path") ?? action.display;
}

function isWorkspaceSnapshotEvidence(record: EvidenceRecord): boolean {
  if (record.kind === "repository_map" || record.kind === "test_result" || record.kind === "review_finding") {
    return true;
  }
  const toolId = record.metadata?.toolId;
  return toolId === "fs.search" || toolId === "process.run" || toolId === "shell.run" || toolId === "git.diff";
}

function evidenceNamesPath(record: EvidenceRecord, path: string): boolean {
  const within = (candidate: string): boolean => candidate === path || candidate.startsWith(`${path}/`);
  if (typeof record.metadata?.path === "string" && within(normalizeObservationPath(record.metadata.path))) return true;
  if (typeof record.metadata?.paths === "string") {
    if (record.metadata.paths.split(",").map(normalizeObservationPath).some(within)) return true;
  }
  const locatorPath = normalizeObservationPath(record.locator.split(/[#:]L?\d*/u, 1)[0] ?? record.locator);
  return within(locatorPath);
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function stringFieldAllowEmpty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isSearchMatch(value: unknown): value is { path: string; line: number; text: string } {
  return isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.line === "number" &&
    Number.isFinite(value.line) &&
    typeof value.text === "string";
}

function dedupeRejections(
  entries: readonly { id: string; reason: string }[],
): Array<{ id: string; reason: string }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; reason: string }> = [];
  for (const entry of entries) {
    const key = `${entry.id}\u0000${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/** Render the inspector as the `/context` overlay body (§18.10). */
export function renderContextInspection(view: ContextInspection): string[] {
  const lines: string[] = [
    `Context ${Math.round(view.usedFraction * 100)}% of ${view.softBudgetTokens.toLocaleString()} token soft budget`,
    "",
  ];

  if (view.compiledPackId !== undefined) {
    lines.push(`Compiled pack: ${view.compiledPackId}${
      view.compiledInputTokens !== undefined ? ` (${view.compiledInputTokens} input tokens)` : ""
    }`, "");
  }
  if (view.compilerPack !== undefined) {
    lines.push(
      `Compiler manifest: ${view.compilerPack.id} (${view.compilerPack.included} included, ${view.compilerPack.excluded} excluded${view.compilerPack.fallback ? ", fallback" : ""})`,
      `Compiler digest: ${view.compilerPack.manifestDigest}`,
      "",
    );
  }

  const widest = view.layers.reduce((max, row) => Math.max(max, row.layer.length), 0);
  for (const row of view.layers) {
    lines.push(
      `${row.layer.padEnd(widest)}  ${String(row.estimatedTokens).padStart(7)}t  ${row.detail}`,
    );
  }

  if (view.activeFiles.length > 0) {
    lines.push("", "Active files");
    for (const file of view.activeFiles) {
      lines.push(`- ${file.path} (${file.lines}) sha256:${file.checksum.slice(0, 12)}…`);
    }
  }

  if (view.skills.length > 0) {
    lines.push("", "Skills");
    for (const skill of view.skills) {
      lines.push(`- ${skill.name}${skill.version ? ` v${skill.version}` : ""} [${skill.source}]`);
    }
  }

  lines.push("", `Reasoning items: ${view.reasoning.items} (${view.reasoning.note})`);

  if (view.cachePrefixFingerprint !== undefined) {
    lines.push(`Cache prefix: ${view.cachePrefixFingerprint}`);
  }

  if (view.recentFailures.length > 0) {
    lines.push("", "Recent failures weighting selection");
    for (const failure of view.recentFailures) {
      const where = failure.paths.length > 0 ? `: ${failure.paths.join(", ")}` : "";
      lines.push(`- ${failure.toolId} (${failure.category})${where}`);
    }
  }

  if (view.excludedLargeOutputs.length > 0) {
    lines.push("", "Excluded large outputs");
    for (const output of view.excludedLargeOutputs) {
      const artifact = output.artifactId !== undefined ? ` → ${output.artifactId}` : "";
      lines.push(`- ${output.label} (${output.bytes} bytes)${artifact}`);
    }
  }

  if (view.instructionsSkipped.length > 0) {
    lines.push("", "Instruction files not applied");
    for (const skipped of view.instructionsSkipped) {
      lines.push(`- ${skipped.path}: ${skipped.reason}`);
    }
  }

  return lines;
}
