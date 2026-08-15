/**
 * Deterministic Context Compiler v2 (P1).
 *
 * This module deliberately has no provider, journal, or filesystem dependency.
 * It turns immutable typed candidates into one bounded ContextPack that callers
 * can hand unchanged to prompt assembly, cache planning, telemetry, and the
 * inspector.  Learned policies may rank candidates elsewhere; the compiler owns
 * the non-negotiable trust/freshness/dependency/budget rules.
 */

import { evidenceDigest } from "./evidence.ts";
import {
  CONTEXT_IR_VERSION,
  type ContextBucket,
  type ContextExclusionReasonCode,
  type ContextFallbackManifest,
  type ContextInclusionReasonCode,
  type ContextItem,
  type ContextManifest,
  type ContextManifestExclusion,
  type ContextManifestInclusion,
  type ContextPack,
  type ContextRequest,
  type ContextSegment,
} from "./ir.ts";

export const DEFAULT_MMR_LAMBDA = 0.45;
export const DEFAULT_MAX_CONTEXT_CANDIDATES = 2_048;

/** An optional async source lets maintenance/LSP refresh complete before sampling. */
export type ContextItemSource =
  | readonly ContextItem[]
  | (() => readonly ContextItem[] | Promise<readonly ContextItem[]>);

export interface ContextCompilerOptions {
  readonly items?: ContextItemSource;
  readonly recentDialogue?: ContextPack["recentDialogue"];
  /** Injected clock keeps packs deterministic in tests and replay. */
  readonly now?: () => Date;
  /** 0 means pure utility order; 1 maximally penalizes redundant candidates. */
  readonly mmrLambda?: number;
  readonly maxCandidates?: number;
  /** Keep MMR work counters outside the compiled pack identity. */
  readonly similarityDiagnostics?: boolean;
}

export interface ContextCompilerDiagnostics {
  readonly mmr: {
    readonly similarityChecks: number;
    readonly redundancyUpdates: number;
    readonly selectionSteps: number;
  };
}

export interface ContextPreparation {
  readonly pack: ContextPack;
  readonly preparedAt: string;
  /** Optional telemetry; never contributes to `pack.id` or manifest digests. */
  readonly diagnostics?: ContextCompilerDiagnostics;
}

interface Candidate {
  readonly item: ContextItem;
  readonly bucket: Exclude<ContextBucket, "recent_dialogue">;
  readonly text: string;
  readonly tokens: number;
  readonly utility: number;
  readonly semanticKey?: string;
  readonly similaritySignals: ReadonlySet<string>;
}

interface MmrDiagnosticsAccumulator {
  similarityChecks: number;
  redundancyUpdates: number;
  selectionSteps: number;
}

interface CompileResult {
  readonly pack: ContextPack;
  readonly diagnostics?: ContextCompilerDiagnostics;
}

interface CompileState {
  readonly request: ContextRequest;
  readonly now: Date;
  readonly hardLimit: number;
  readonly targetLimit: number;
  readonly bucketTargets: Record<ContextBucket, number>;
  readonly bucketTokens: Record<ContextBucket, number>;
  readonly candidates: Map<string, Candidate>;
  readonly aliases: Map<string, string>;
  readonly included: Map<string, ContextManifestInclusion>;
  readonly selected: Map<string, Candidate>;
  readonly exclusions: ContextManifestExclusion[];
  totalTokens: number;
}

/**
 * Deterministic per-sample allocator.  `prepare` is async even for a static item
 * array so a caller may use it as the single awaited pre-sample compiler path.
 */
export class ContextCompiler {
  readonly #source: ContextItemSource;
  readonly #recentDialogue: ContextPack["recentDialogue"];
  readonly #now: () => Date;
  readonly #mmrLambda: number;
  readonly #maxCandidates: number;
  readonly #similarityDiagnostics: boolean;
  #lastDiagnostics: ContextCompilerDiagnostics | undefined;

  constructor(options: ContextCompilerOptions | readonly ContextItem[] = {}) {
    const normalized: ContextCompilerOptions = Array.isArray(options)
      ? { items: options as readonly ContextItem[] }
      : options as ContextCompilerOptions;
    this.#source = normalized.items ?? [];
    this.#recentDialogue = normalized.recentDialogue ?? [];
    this.#now = normalized.now ?? (() => new Date());
    this.#mmrLambda = clamp(normalized.mmrLambda ?? DEFAULT_MMR_LAMBDA, 0, 1);
    this.#maxCandidates = boundedInteger(
      normalized.maxCandidates ?? DEFAULT_MAX_CONTEXT_CANDIDATES,
      1,
      16_384,
    );
    this.#similarityDiagnostics = normalized.similarityDiagnostics ?? false;
  }

  /** Prepare the exact pack for one provider sample. Failures become a safe task-only pack. */
  async prepare(request: ContextRequest): Promise<ContextPack> {
    const result = await this.#prepareInternal(request);
    this.#lastDiagnostics = result.diagnostics;
    return result.pack;
  }

  /** Diagnostics for the most recently prepared pack, when explicitly enabled. */
  get lastDiagnostics(): ContextCompilerDiagnostics | undefined {
    return this.#lastDiagnostics;
  }

  async #prepareInternal(request: ContextRequest): Promise<CompileResult> {
    const now = validDate(this.#now()) ?? new Date(0);
    const mmrDiagnostics = this.#similarityDiagnostics ? createMmrDiagnostics() : undefined;
    try {
      const source = typeof this.#source === "function" ? await this.#source() : this.#source;
      const pack = compilePack(
        request,
        source,
        this.#recentDialogue,
        now,
        this.#mmrLambda,
        this.#maxCandidates,
        mmrDiagnostics,
      );
      return {
        pack,
        ...(mmrDiagnostics === undefined ? {} : { diagnostics: freezeMmrDiagnostics(mmrDiagnostics) }),
      };
    } catch (error) {
      return {
        pack: fallbackPack(request, this.#recentDialogue, now, error instanceof Error ? error.message : "candidate preparation failed"),
        ...(mmrDiagnostics === undefined ? {} : { diagnostics: freezeMmrDiagnostics(mmrDiagnostics) }),
      };
    }
  }

  /** RFC-friendly alias used by callers that name the whole operation compilation. */
  async compile(request: ContextRequest): Promise<ContextPack> {
    return await this.prepare(request);
  }

  /** Includes the timestamp separately when telemetry needs to record preparation latency. */
  async prepareSample(request: ContextRequest): Promise<ContextPreparation> {
    const result = await this.#prepareInternal(request);
    this.#lastDiagnostics = result.diagnostics;
    const preparedAt = validDate(this.#now()) ?? new Date(0);
    return Object.freeze({
      pack: result.pack,
      preparedAt: preparedAt.toISOString(),
      ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
    });
  }
}

/** Functional convenience for adapters that have one item snapshot rather than a long-lived compiler. */
export async function prepareContext(
  request: ContextRequest,
  items: ContextItemSource = [],
  options: Omit<ContextCompilerOptions, "items"> = {},
): Promise<ContextPack> {
  return await new ContextCompiler({ ...options, items }).prepare(request);
}

/** Alias retained for direct call sites that use "compile" terminology. */
export const compileContext = prepareContext;

/** Explain an already compiled decision without triggering another selection pass. */
export function explainContextItem(
  manifest: ContextManifest,
  id: string,
): ContextManifestInclusion | ContextManifestExclusion | undefined {
  return manifest.included.find((entry) => entry.id === id) ??
    manifest.excluded.find((entry) => entry.id === id);
}

function compilePack(
  request: ContextRequest,
  input: readonly ContextItem[],
  recentDialogue: ContextPack["recentDialogue"],
  now: Date,
  mmrLambda: number,
  maxCandidates: number,
  mmrDiagnostics?: MmrDiagnosticsAccumulator,
): ContextPack {
  const task = taskItem(request, now);
  const allCandidates = [task, ...input];
  const candidatesInput = allCandidates.slice(0, maxCandidates);
  const candidateLimitExclusions = allCandidates.slice(maxCandidates);
  const budget = normalizeBudget(request);
  // Dialogue is part of provider input too. Keep the newest whole items that fit
  // before allocating compiler segments; a stale/oversized history item must not
  // silently push the exact evidence pack past its hard ceiling.
  const boundedDialogue = boundDialogue(recentDialogue, budget.hardInputLimit);
  const dialogueTokens = estimateDialogueTokens(boundedDialogue);
  const state: CompileState = {
    request,
    now,
    hardLimit: Math.max(0, budget.hardInputLimit - dialogueTokens),
    targetLimit: Math.max(0, budget.targetInputTokens - dialogueTokens),
    bucketTargets: budget.bucketTargets,
    bucketTokens: emptyBucketRecord(),
    candidates: new Map(),
    aliases: new Map(),
    included: new Map(),
    selected: new Map(),
    exclusions: [],
    totalTokens: 0,
  };

  normalizeCandidates(candidatesInput, state);
  // A bounded compiler must still explain candidates it deliberately never
  // normalized; otherwise cap-induced omissions look like missing provenance.
  for (const skipped of candidateLimitExclusions) {
    exclude(
      state,
      safeId(skipped),
      "candidate_limit",
      `candidate limit (${maxCandidates}) reached before this item`,
      safeTokens(skipped),
    );
  }

  // Policy/tool/instruction/task items are deterministic hard requirements. They
  // may borrow from their bucket target but never from the absolute hard ceiling.
  const mandatory = [...state.candidates.values()]
    .filter((candidate) => isMandatory(candidate.item))
    .sort(compareCandidates);
  for (const candidate of mandatory) includeWithDependencies(state, candidate.item.id, "mandatory", true);

  // Exact evidence has a floor: allocate it before exploratory code, but remain
  // truthful when the request itself cannot afford the floor.
  const exact = sortedByMmr(
    [...state.candidates.values()].filter((candidate) => candidate.bucket === "exact_evidence"),
    state.selected,
    mmrLambda,
    mmrDiagnostics,
  );
  for (const candidate of exact) {
    if (state.bucketTokens.exact_evidence >= budget.exactEvidenceFloor) break;
    includeWithDependencies(state, candidate.item.id, "exact_evidence_floor", true);
  }

  // Then take explicit task signals before soft utility candidates.
  const remaining = sortedByMmr(
    [...state.candidates.values()].filter((candidate) => !state.selected.has(candidate.item.id)),
    state.selected,
    mmrLambda,
    mmrDiagnostics,
  );
  for (const candidate of remaining) {
    const reason = selectionReason(candidate.item, request);
    const exploratory = candidate.bucket === "working_code" && !candidate.item.representation.exact;
    if (exploratory && state.bucketTokens.working_code + candidate.tokens > budget.explorationCeiling) {
      exclude(state, candidate.item.id, "exploration_ceiling", "non-exact working code exceeded the exploration ceiling", candidate.tokens, candidate.bucket);
      continue;
    }
    includeWithDependencies(state, candidate.item.id, reason, reason !== "mmr_utility");
  }

  return buildPack(state, boundedDialogue, false);
}

function normalizeCandidates(items: readonly ContextItem[], state: CompileState): void {
  // First choose one deterministic representative for every id. Dedupe by body
  // happens only after that pass: otherwise replacing an id winner can leave an
  // exact/semantic map pointing at content which is no longer eligible.
  const ids = new Map<string, Candidate>();
  for (const raw of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    const candidate = makeCandidate(raw);
    if (candidate === undefined) {
      exclude(state, safeId(raw), "unmaterializable", "candidate had no safe materialization", safeTokens(raw));
      continue;
    }
    const freshness = freshnessIssue(candidate.item, state.request, state.now);
    if (freshness !== undefined) {
      exclude(state, candidate.item.id, freshness.code, freshness.reason, candidate.tokens, candidate.bucket);
      continue;
    }
    const earlier = ids.get(candidate.item.id);
    if (earlier === undefined) {
      ids.set(candidate.item.id, candidate);
      continue;
    }
    const winner = compareSameId(earlier, candidate) <= 0 ? earlier : candidate;
    const loser = winner === earlier ? candidate : earlier;
    ids.set(candidate.item.id, winner);
    exclude(
      state,
      loser.item.id,
      "duplicate_id",
      `duplicate item id; kept deterministic representative ${winner.item.id}`,
      loser.tokens,
      loser.bucket,
      winner.item.id,
    );
  }

  const exact = new Map<string, string>();
  const semantic = new Map<string, string>();
  for (const candidate of [...ids.values()].sort(compareCandidates)) {
    const exactKey = candidate.item.representation.exact ? evidenceDigest({
      resolution: candidate.item.representation.resolution,
      text: candidate.text,
      artifactId: candidate.item.representation.artifactId,
      range: candidate.item.representation.range,
    }) : undefined;
    if (exactKey !== undefined && exact.has(exactKey)) {
      const canonical = exact.get(exactKey)!;
      state.aliases.set(candidate.item.id, canonical);
      exclude(state, candidate.item.id, "exact_duplicate", `identical exact content already represented by ${canonical}`, candidate.tokens, candidate.bucket, canonical);
      continue;
    }
    if (candidate.semanticKey !== undefined && semantic.has(candidate.semanticKey)) {
      const canonical = semantic.get(candidate.semanticKey)!;
      state.aliases.set(candidate.item.id, canonical);
      exclude(state, candidate.item.id, "semantic_duplicate", `semantic duplicate already represented by ${canonical}`, candidate.tokens, candidate.bucket, canonical);
      continue;
    }
    state.candidates.set(candidate.item.id, candidate);
    if (exactKey !== undefined) exact.set(exactKey, candidate.item.id);
    if (candidate.semanticKey !== undefined) semantic.set(candidate.semanticKey, candidate.item.id);
  }
}

function includeWithDependencies(
  state: CompileState,
  rawId: string,
  primaryReason: ContextInclusionReasonCode,
  bypassBucketTarget: boolean,
): boolean {
  const id = resolveAlias(state, rawId);
  const target = state.candidates.get(id);
  if (target === undefined) {
    exclude(state, rawId, "missing_dependency", `candidate is unavailable: ${rawId}`, 0);
    return false;
  }
  if (state.selected.has(id)) return true;
  const closure: Candidate[] = [];
  const visiting = new Set<string>();
  const missing: string[] = [];
  const visit = (candidateId: string): void => {
    const canonical = resolveAlias(state, candidateId);
    if (state.selected.has(canonical) || visiting.has(canonical)) return;
    visiting.add(canonical);
    const candidate = state.candidates.get(canonical);
    if (candidate === undefined) {
      missing.push(candidateId);
      return;
    }
    for (const dependency of candidate.item.dependencies) visit(dependency);
    closure.push(candidate);
  };
  visit(id);
  if (missing.length > 0) {
    exclude(
      state,
      id,
      "missing_dependency",
      `required dependency is unavailable: ${[...new Set(missing)].sort().join(", ")}`,
      target.tokens,
      target.bucket,
      undefined,
      [...new Set(missing)].sort(),
    );
    return false;
  }
  const newCandidates = closure.filter((candidate) => !state.selected.has(candidate.item.id));
  const total = newCandidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
  if (state.totalTokens + total > state.hardLimit) {
    exclude(state, id, "hard_budget", `dependency closure needs ${total} tokens beyond hard input ceiling`, target.tokens, target.bucket);
    return false;
  }
  // Treat the soft target as a real allocator boundary for non-mandatory utility
  // candidates. Explicit requests and exact-floor safety work can borrow until hard.
  if (!bypassBucketTarget && state.totalTokens + total > state.targetLimit) {
    exclude(state, id, "target_budget", "candidate would exceed target input budget", target.tokens, target.bucket);
    return false;
  }
  for (const candidate of newCandidates) {
    const dependency = candidate.item.id !== id;
    const bucketTarget = state.bucketTargets[candidate.bucket];
    if (!dependency && !bypassBucketTarget && state.bucketTokens[candidate.bucket] + candidate.tokens > bucketTarget) {
      exclude(state, id, "bucket_budget", `candidate would exceed ${candidate.bucket} allocation`, target.tokens, target.bucket);
      return false;
    }
  }
  // All checks have happened before mutation: dependency closure is atomic.
  for (const candidate of newCandidates) {
    const dependency = candidate.item.id !== id;
    const reason: ContextInclusionReasonCode = dependency ? "dependency" : primaryReason;
    const segmentId = `segment-${candidate.item.id}`;
    state.selected.set(candidate.item.id, candidate);
    state.totalTokens += candidate.tokens;
    state.bucketTokens[candidate.bucket] += candidate.tokens;
    state.included.set(candidate.item.id, Object.freeze({
      id: candidate.item.id,
      segmentId,
      bucket: candidate.bucket,
      estimatedTokens: candidate.tokens,
      score: candidate.utility,
      reason: reasonText(reason),
      reasons: Object.freeze([reason]),
      dependencies: Object.freeze(candidate.item.dependencies.map((dependencyId) => resolveAlias(state, dependencyId)).sort()),
    }));
  }
  return true;
}

function buildPack(
  state: CompileState,
  recentDialogue: ContextPack["recentDialogue"],
  fallback: boolean,
  fallbackReason?: string,
): ContextPack {
  const grouped: Record<Exclude<ContextBucket, "recent_dialogue">, ContextSegment[]> = {
    stable_prefix: [], task_state: [], working_code: [], exact_evidence: [], memory_handles: [],
  };
  for (const candidate of [...state.selected.values()].sort(compareCandidates)) {
    const inclusion = state.included.get(candidate.item.id);
    if (inclusion === undefined) continue;
    grouped[candidate.bucket].push(Object.freeze({
      id: inclusion.segmentId,
      bucket: candidate.bucket,
      item: candidate.item,
      text: candidate.text,
      estimatedTokens: candidate.tokens,
      stable: candidate.bucket === "stable_prefix",
      exact: candidate.item.representation.exact,
      cacheBreakpoint: candidate.bucket === "stable_prefix",
    }));
  }
  const buckets = [
    ...grouped.stable_prefix,
    ...grouped.task_state,
    ...grouped.working_code,
    ...grouped.exact_evidence,
    ...grouped.memory_handles,
  ];
  const flattened = buckets;
  const stablePrefixTokens = grouped.stable_prefix.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
  const budget = normalizeBudget(state.request);
  const fallbackManifest: ContextFallbackManifest = Object.freeze({
    used: fallback,
    ...(fallbackReason === undefined ? {} : { reason: fallbackReason }),
    droppedMandatoryItemIds: Object.freeze(
      state.exclusions.filter((entry) => entry.code === "hard_budget" || entry.code === "missing_dependency")
        .map((entry) => entry.id).sort(),
    ),
  });
  const estimatedTokens = state.totalTokens + estimateDialogueTokens(recentDialogue);
  const manifestBase = {
    version: CONTEXT_IR_VERSION,
    requestId: requestId(state.request),
    phase: state.request.phase,
    ...(state.request.workspaceIdentity === undefined ? {} : { workspaceIdentity: state.request.workspaceIdentity }),
    included: Object.freeze([...state.included.values()].sort((left, right) => left.id.localeCompare(right.id))),
    excluded: Object.freeze([...state.exclusions].sort((left, right) => left.id.localeCompare(right.id) || left.code.localeCompare(right.code))),
    itemIds: Object.freeze([...state.selected.keys()].sort()),
    budget: Object.freeze({
      modelContextLimit: state.request.budget.modelContextLimit,
      outputReserve: state.request.budget.outputReserve,
      providerInputLimit: budget.providerInputLimit,
      requestedHardInputLimit: state.request.budget.hardInputLimit,
      hardInputLimit: budget.hardInputLimit,
      requestedTargetInputTokens: state.request.budget.targetInputTokens,
      targetInputTokens: budget.targetInputTokens,
      exactEvidenceFloor: budget.exactEvidenceFloor,
      explorationCeiling: budget.explorationCeiling,
      bucketTargets: Object.freeze({ ...state.bucketTargets }),
      bucketTokens: Object.freeze({ ...state.bucketTokens, recent_dialogue: estimateDialogueTokens(recentDialogue) }),
    }),
    estimatedTokens,
    stablePrefixTokens,
    exactEvidenceTokens: state.bucketTokens.exact_evidence,
    relevantTokenDensity: state.totalTokens === 0
      ? 0
      : [...state.selected.values()].reduce((sum, candidate) => sum + Math.max(0, candidate.utility), 0) / state.totalTokens,
    fallback: fallbackManifest,
  } as const;
  const manifest: ContextManifest = Object.freeze({ ...manifestBase, digest: evidenceDigest(manifestBase) });
  const packPayload = {
    manifest: manifest.digest,
    segments: flattened.map((segment) => ({ id: segment.id, itemId: segment.item.id, bucket: segment.bucket, tokens: segment.estimatedTokens })),
    dialogue: recentDialogue.map(dialogueIdentity),
  };
  const id = `context-pack-${evidenceDigest(packPayload)}`;
  const cacheBreakpoints = grouped.stable_prefix.length > 0 ? Object.freeze([grouped.stable_prefix.length]) : Object.freeze([] as number[]);
  return Object.freeze({
    id,
    stablePrefix: Object.freeze(grouped.stable_prefix),
    taskState: Object.freeze(grouped.task_state),
    workingCode: Object.freeze(grouped.working_code),
    exactEvidence: Object.freeze(grouped.exact_evidence),
    recentDialogue: Object.freeze([...recentDialogue]),
    memoryHandles: Object.freeze(grouped.memory_handles),
    manifest,
    estimatedTokens,
    stablePrefixTokens,
    cacheBreakpoints,
  });
}

function fallbackPack(
  request: ContextRequest,
  recentDialogue: ContextPack["recentDialogue"],
  now: Date,
  reason: string,
): ContextPack {
  const budget = normalizeBudget(request);
  const boundedDialogue = boundDialogue(recentDialogue, budget.hardInputLimit);
  const dialogueTokens = estimateDialogueTokens(boundedDialogue);
  const state: CompileState = {
    request, now, hardLimit: Math.max(0, budget.hardInputLimit - dialogueTokens), targetLimit: Math.max(0, budget.targetInputTokens - dialogueTokens),
    bucketTargets: budget.bucketTargets, bucketTokens: emptyBucketRecord(), candidates: new Map(), aliases: new Map(),
    included: new Map(), selected: new Map(), exclusions: [], totalTokens: 0,
  };
  const task = makeCandidate(taskItem(request, now));
  if (task !== undefined) state.candidates.set(task.item.id, task);
  if (task !== undefined) includeWithDependencies(state, task.item.id, "fallback", true);
  return buildPack(state, boundedDialogue, true, truncate(reason, 240));
}

function taskItem(request: ContextRequest, now: Date): ContextItem {
  const observedAt = request.observedAt ?? now.toISOString();
  const text = request.subgoal === undefined ? request.goal : `${request.goal}\n\nCurrent subgoal: ${request.subgoal}`;
  const id = `task-${evidenceDigest({ goal: request.goal, subgoal: request.subgoal, phase: request.phase, id: request.id })}`;
  return Object.freeze({
    id,
    kind: "task",
    authority: "user",
    trust: "trusted",
    scope: Object.freeze({
      workspaceIdentity: request.workspaceIdentity ?? "unbound-workspace",
      ...(request.taskEpochId === undefined ? {} : { taskEpochId: request.taskEpochId }),
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(request.mentionedPaths.length === 0 ? {} : { paths: Object.freeze([...request.mentionedPaths]) }),
      ...(request.mentionedSymbols.length === 0 ? {} : { symbols: Object.freeze([...request.mentionedSymbols]) }),
    }),
    provenance: Object.freeze({ source: "context-request", locator: `request:${requestId(request)}`, digest: evidenceDigest(text), observedAt }),
    freshness: Object.freeze({ state: "fresh" }),
    representation: Object.freeze({ resolution: "summary", exact: true, text }),
    estimatedTokens: estimateTokens(text),
    dependencies: Object.freeze([]),
    utility: Object.freeze({ relevance: 1_000, coverage: 1_000, novelty: 1, recency: 1, confidence: 1, verificationValue: 1, riskPenalty: 0 }),
  });
}

function makeCandidate(item: ContextItem): Candidate | undefined {
  if (!isContextItem(item)) return undefined;
  const text = materialize(item);
  if (text === undefined) return undefined;
  const tokens = boundedInteger(item.estimatedTokens > 0 ? item.estimatedTokens : estimateTokens(text), 1, Number.MAX_SAFE_INTEGER);
  const semantic = semanticKey(item, text);
  return Object.freeze({
    item: freezeItem(item),
    bucket: bucketFor(item),
    text,
    tokens,
    utility: utilityScore(item),
    similaritySignals: new Set([
      ...(item.scope.paths ?? []),
      ...(item.scope.symbols ?? []),
      ...item.dependencies,
    ]),
    ...(semantic === undefined ? {} : { semanticKey: semantic }),
  });
}

function isContextItem(value: unknown): value is ContextItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<ContextItem>;
  return typeof item.id === "string" && item.id.length > 0 && item.kind !== undefined &&
    item.authority !== undefined && item.trust !== undefined && item.scope !== undefined &&
    item.provenance !== undefined && item.freshness !== undefined && item.representation !== undefined &&
    Array.isArray(item.dependencies) && typeof item.estimatedTokens === "number" && item.utility !== undefined;
}

function freezeItem(item: ContextItem): ContextItem {
  return Object.freeze({
    ...item,
    scope: Object.freeze({ ...item.scope, ...(item.scope.paths === undefined ? {} : { paths: Object.freeze([...item.scope.paths]) }), ...(item.scope.symbols === undefined ? {} : { symbols: Object.freeze([...item.scope.symbols]) }) }),
    provenance: Object.freeze({ ...item.provenance, ...(item.provenance.parentEvidenceIds === undefined ? {} : { parentEvidenceIds: Object.freeze([...item.provenance.parentEvidenceIds]) }) }),
    freshness: Object.freeze({ ...item.freshness, ...(item.freshness.invalidatedBy === undefined ? {} : { invalidatedBy: Object.freeze([...item.freshness.invalidatedBy]) }) }),
    representation: Object.freeze({ ...item.representation, ...(item.representation.range === undefined ? {} : { range: Object.freeze({ ...item.representation.range }) }) }),
    dependencies: Object.freeze([...item.dependencies]),
    utility: Object.freeze({ ...item.utility }),
  });
}

function materialize(item: ContextItem): string | undefined {
  const text = item.representation.text;
  if (typeof text === "string") return text;
  if (item.representation.artifactId !== undefined && item.representation.artifactId.length > 0) {
    return `[artifact handle: ${item.representation.artifactId}]`;
  }
  // Handles without a runtime artifact still preserve a safe, inspectable locator.
  if (item.representation.resolution === "handle") return `[context handle: ${item.provenance.locator}]`;
  return undefined;
}

function bucketFor(item: ContextItem): Exclude<ContextBucket, "recent_dialogue"> {
  if (item.kind === "policy" || item.kind === "tool_schema" || item.kind === "instruction") return "stable_prefix";
  if (item.kind === "task" || item.kind === "plan" || item.kind === "decision" || item.kind === "assumption") return "task_state";
  if (item.kind === "memory") return "memory_handles";
  if (item.representation.exact || item.kind === "file_excerpt" || item.kind === "diff" || item.kind === "test_result" || item.kind === "tool_observation") return "exact_evidence";
  return "working_code";
}

function isMandatory(item: ContextItem): boolean {
  return item.kind === "policy" || item.kind === "tool_schema" || item.kind === "instruction" || item.kind === "task";
}

function freshnessIssue(item: ContextItem, request: ContextRequest, now: Date): { code: ContextExclusionReasonCode; reason: string } | undefined {
  if (item.freshness.state === "invalid") return { code: "invalid_freshness", reason: "invalid evidence is never compilable" };
  if (item.freshness.state === "stale") return { code: "stale_freshness", reason: "stale evidence is never compilable" };
  if (item.freshness.expiresAt !== undefined) {
    const expiresAt = Date.parse(item.freshness.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return {
        code: "expired",
        reason: Number.isFinite(expiresAt)
          ? "candidate freshness expiry has elapsed"
          : "candidate freshness expiry is invalid",
      };
    }
  }
  if (request.workspaceIdentity !== undefined && item.scope.workspaceIdentity !== request.workspaceIdentity && item.authority !== "system") {
    return { code: "workspace_mismatch", reason: "candidate belongs to a different workspace identity" };
  }
  return undefined;
}

function selectionReason(item: ContextItem, request: ContextRequest): ContextInclusionReasonCode {
  const paths = new Set(item.scope.paths ?? []);
  const symbols = new Set(item.scope.symbols ?? []);
  if (request.mentionedPaths.some((path) => paths.has(path))) return "explicit_mention";
  if (request.mentionedSymbols.some((symbol) => symbols.has(symbol))) return "explicit_mention";
  if (request.changedPaths.some((path) => paths.has(path))) return "changed_path";
  if (item.provenance.parentEvidenceIds?.some((id) => request.recentFailureRefs.includes(id))) return "recent_failure";
  return "mmr_utility";
}

function sortedByMmr(
  candidates: readonly Candidate[],
  selected: ReadonlyMap<string, Candidate>,
  lambda: number,
  diagnostics?: MmrDiagnosticsAccumulator,
): Candidate[] {
  const remaining = [...candidates];
  const result: Candidate[] = [];
  const reference = [...selected.values()];
  const redundancy = new Map<string, number>();

  // The reference set is fixed for this pass. Seed every candidate's cached
  // maximum once, then only compare it with each newly chosen candidate.
  for (const candidate of remaining) {
    let maximum = 0;
    for (const other of reference) {
      maximum = Math.max(maximum, similarity(candidate, other, diagnostics));
      if (maximum === 1) break;
    }
    redundancy.set(candidate.item.id, maximum);
  }

  while (remaining.length > 0) {
    let nextIndex = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      const left = remaining[nextIndex]!;
      const right = remaining[index]!;
      const comparison = compareMmr(
        left,
        right,
        redundancy.get(left.item.id) ?? 0,
        redundancy.get(right.item.id) ?? 0,
        lambda,
      );
      // The old implementation sorted and shifted. Retaining the first equal
      // candidate preserves stable tie behavior without another full sort.
      if (comparison > 0) nextIndex = index;
    }
    const next = remaining.splice(nextIndex, 1)[0];
    if (next !== undefined) result.push(next);
    if (next === undefined) continue;
    if (diagnostics !== undefined) diagnostics.selectionSteps += 1;

    for (const candidate of remaining) {
      const current = redundancy.get(candidate.item.id) ?? 0;
      if (current === 1) continue;
      const candidateSimilarity = similarity(candidate, next, diagnostics);
      if (candidateSimilarity > current) redundancy.set(candidate.item.id, candidateSimilarity);
      if (diagnostics !== undefined) diagnostics.redundancyUpdates += 1;
    }
  }
  return result;
}

function compareMmr(
  left: Candidate,
  right: Candidate,
  leftRedundancy: number,
  rightRedundancy: number,
  lambda: number,
): number {
  const leftScore = mmrScore(left, leftRedundancy, lambda);
  const rightScore = mmrScore(right, rightRedundancy, lambda);
  return rightScore - leftScore || compareCandidates(left, right);
}

function mmrScore(candidate: Candidate, redundancy: number, lambda: number): number {
  return candidate.utility - lambda * redundancy * Math.max(1, candidate.utility);
}

function similarity(
  left: Candidate,
  right: Candidate,
  diagnostics?: MmrDiagnosticsAccumulator,
): number {
  if (diagnostics !== undefined) diagnostics.similarityChecks += 1;
  if (left.semanticKey !== undefined && left.semanticKey === right.semanticKey) return 1;
  const leftSignals = left.similaritySignals;
  const rightSignals = right.similaritySignals;
  if (leftSignals.size === 0 || rightSignals.size === 0) return 0;
  let shared = 0;
  for (const value of leftSignals) if (rightSignals.has(value)) shared += 1;
  return shared / (leftSignals.size + rightSignals.size - shared);
}

function utilityScore(item: ContextItem): number {
  const utility = item.utility;
  return Math.max(0, utility.relevance + utility.coverage + utility.novelty + utility.recency + utility.confidence + utility.verificationValue - utility.riskPenalty);
}

function createMmrDiagnostics(): MmrDiagnosticsAccumulator {
  return { similarityChecks: 0, redundancyUpdates: 0, selectionSteps: 0 };
}

function freezeMmrDiagnostics(
  diagnostics: MmrDiagnosticsAccumulator,
): ContextCompilerDiagnostics {
  return Object.freeze({
    mmr: Object.freeze({
      similarityChecks: diagnostics.similarityChecks,
      redundancyUpdates: diagnostics.redundancyUpdates,
      selectionSteps: diagnostics.selectionSteps,
    }),
  });
}

function semanticKey(item: ContextItem, text: string): string | undefined {
  if (item.kind === "policy" || item.kind === "tool_schema") return undefined;
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  return normalized.length < 12 ? undefined : evidenceDigest({ bucket: bucketFor(item), trust: item.trust, normalized });
}

function normalizeBudget(request: ContextRequest): {
  readonly providerInputLimit: number;
  readonly hardInputLimit: number;
  readonly targetInputTokens: number;
  readonly exactEvidenceFloor: number;
  readonly explorationCeiling: number;
  readonly bucketTargets: Record<ContextBucket, number>;
} {
  const inputLimit = Math.max(0, Math.floor(request.budget.modelContextLimit) - Math.max(0, Math.floor(request.budget.outputReserve)));
  const hard = Math.max(0, Math.min(inputLimit, Math.floor(request.budget.hardInputLimit)));
  const target = Math.max(0, Math.min(hard, Math.floor(request.budget.targetInputTokens)));
  const exactFloor = Math.max(0, Math.min(hard, Math.floor(request.budget.exactEvidenceFloor)));
  const exploration = Math.max(0, Math.min(hard, Math.floor(request.budget.explorationCeiling)));
  // Allocation targets are a soft partition. Mandatory/explicit/floor work can
  // borrow, but arbitrary utility candidates cannot silently consume all buckets.
  const stable = Math.floor(target * 0.24);
  const task = Math.floor(target * 0.14);
  const exact = Math.max(Math.floor(target * 0.28), exactFloor);
  const memory = Math.floor(target * 0.08);
  const dialogue = Math.floor(target * 0.10);
  const working = Math.max(0, target - stable - task - exact - memory - dialogue);
  return Object.freeze({
    providerInputLimit: inputLimit,
    hardInputLimit: hard,
    targetInputTokens: target,
    exactEvidenceFloor: exactFloor,
    explorationCeiling: exploration,
    bucketTargets: Object.freeze({
      stable_prefix: stable,
      task_state: task,
      working_code: working,
      exact_evidence: exact,
      recent_dialogue: dialogue,
      memory_handles: memory,
    }),
  });
}

function emptyBucketRecord(): Record<ContextBucket, number> {
  return { stable_prefix: 0, task_state: 0, working_code: 0, exact_evidence: 0, recent_dialogue: 0, memory_handles: 0 };
}

function exclude(
  state: CompileState,
  id: string,
  code: ContextExclusionReasonCode,
  reason: string,
  estimatedTokens: number,
  bucket?: Exclude<ContextBucket, "recent_dialogue">,
  duplicateOf?: string,
  missingDependencyIds?: readonly string[],
): void {
  if (state.exclusions.some((entry) => entry.id === id && entry.code === code)) return;
  state.exclusions.push(Object.freeze({
    id,
    code,
    reason,
    estimatedTokens: Math.max(0, Math.floor(estimatedTokens)),
    ...(bucket === undefined ? {} : { bucket }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
    ...(missingDependencyIds === undefined ? {} : { missingDependencyIds: Object.freeze([...missingDependencyIds]) }),
  }));
}

function resolveAlias(state: CompileState, id: string): string {
  let resolved = id;
  const visited = new Set<string>();
  while (state.aliases.has(resolved) && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = state.aliases.get(resolved)!;
  }
  return resolved;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return right.utility - left.utility || left.tokens - right.tokens || left.item.id.localeCompare(right.item.id);
}

/** Tie-break duplicate ids without depending on caller array order. */
function compareSameId(left: Candidate, right: Candidate): number {
  const primary = compareCandidates(left, right);
  if (primary !== 0) return primary;
  return evidenceDigest({
    text: left.text,
    provenance: left.item.provenance,
    representation: left.item.representation,
    dependencies: left.item.dependencies,
  }).localeCompare(evidenceDigest({
    text: right.text,
    provenance: right.item.provenance,
    representation: right.item.representation,
    dependencies: right.item.dependencies,
  }));
}

function requestId(request: ContextRequest): string {
  return request.id ?? `request-${evidenceDigest({
    goal: request.goal,
    subgoal: request.subgoal,
    phase: request.phase,
    workspaceIdentity: request.workspaceIdentity,
    taskEpochId: request.taskEpochId,
    turnId: request.turnId,
  })}`;
}

function dialogueIdentity(item: ContextPack["recentDialogue"][number]): unknown {
  if (item.type === "function_call") return { type: item.type, callId: item.callId, name: item.name };
  if (item.type === "function_call_output") return { type: item.type, callId: item.callId, output: item.output };
  if (item.type === "message") return { type: item.type, role: item.role, content: item.content };
  return { type: item.type };
}

function boundDialogue(
  dialogue: ContextPack["recentDialogue"],
  hardInputLimit: number,
): ContextPack["recentDialogue"] {
  const retained: ContextPack["recentDialogue"][number][] = [];
  let tokens = 0;
  for (const item of [...dialogue].reverse()) {
    const itemTokens = estimateTokens(JSON.stringify(dialogueIdentity(item)));
    if (tokens + itemTokens > hardInputLimit) continue;
    retained.push(item);
    tokens += itemTokens;
  }
  return retained.reverse();
}

function estimateDialogueTokens(dialogue: ContextPack["recentDialogue"]): number {
  return dialogue.reduce((sum, item) => sum + estimateTokens(JSON.stringify(dialogueIdentity(item))), 0);
}

function reasonText(reason: ContextInclusionReasonCode): string {
  switch (reason) {
    case "current_task": return "current task";
    case "mandatory": return "mandatory policy/task contract";
    case "explicit_mention": return "explicit task path or symbol mention";
    case "changed_path": return "current changed path";
    case "recent_failure": return "recent failure evidence";
    case "exact_evidence_floor": return "exact evidence floor";
    case "dependency": return "required dependency closure";
    case "bucket_allocation": return "allocated context bucket";
    case "mmr_utility": return "highest marginal MMR utility";
    case "fallback": return "deterministic safe fallback";
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function safeId(value: unknown): string {
  return typeof value === "object" && value !== null && "id" in value && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : "invalid-context-item";
}

function safeTokens(value: unknown): number {
  return typeof value === "object" && value !== null && "estimatedTokens" in value && typeof (value as { estimatedTokens?: unknown }).estimatedTokens === "number"
    ? Math.max(0, Math.floor((value as { estimatedTokens: number }).estimatedTokens))
    : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function boundedInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)));
}

function validDate(value: Date): Date | undefined {
  return Number.isFinite(value.getTime()) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
