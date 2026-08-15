/**
 * Context selection — PRD §18.4.
 *
 * §18.4's scoring model, transcribed:
 *
 * ```text
 * relevance =
 *   explicit @mention
 * + search match
 * + symbol/path proximity
 * + recent tool use
 * + changed-file relation
 * + test-to-source mapping
 * - file size penalty
 * - generated/vendor penalty
 * - secret/sensitive penalty
 * ```
 *
 * Every term carries a reason string. §18.10's context inspector shows *why* a
 * file was included, and P2 ("no invisible side effects") extends to context: the
 * user should be able to see what the model was given and on what grounds.
 */

import {
  basenameOf,
  directoryOf,
  isGenerated,
  isSourceCandidate,
  isTestPath,
  isVendored,
  type RepoFile,
  type RepositoryMap,
} from "./repomap.ts";

/** Weights for the §18.4 terms. Positive terms first, then penalties. */
export const SELECTION_WEIGHTS = {
  mention: 100,
  searchMatch: 12,
  /** Per-match cap so one huge file cannot dominate on match count alone. */
  searchMatchCap: 60,
  pathProximitySameDirectory: 20,
  pathProximitySameTree: 8,
  nameSimilarity: 16,
  recentToolUse: 24,
  /** Bounded 1–2 hop code-graph neighbor; weaker than direct tool evidence. */
  structuralNeighbor: 18,
  changedFile: 30,
  /**
   * A file named by a failure the agent is currently reflecting on (§11.2).
   *
   * Weighted just below `changedFile` on purpose: it is a strong hint, but the
   * file the error mentioned is not always the file that must change, and a
   * higher weight would let one noisy stack trace crowd out the change set.
   */
  recentFailure: 25,
  testForChangedSource: 22,
  sourceForChangedTest: 22,
  entryPoint: 6,
  manifest: 4,
  sizePenaltyPerKib: 0.4,
  sizePenaltyMax: 40,
  generatedPenalty: 60,
  vendorPenalty: 80,
  sensitivePenalty: 1_000,
} as const;

/**
 * Paths that must never be auto-selected into a prompt. §T4 (secret
 * exfiltration) and Appendix C.4 both call for `.env` and key material to stay
 * out of model context, and §13.7's example deny rule lists exactly these.
 * A user can still read one deliberately; selection just never volunteers it.
 */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env($|\.|\/)/i,
  /(^|\/)\.env\.[A-Za-z0-9_.-]+$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.gnupg\//i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials(\.json|\.yaml|\.yml|\.toml)?$/i,
  /(^|\/)secrets?(\.json|\.yaml|\.yml|\.toml)$/i,
  /\.jks$/i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

/** Signals gathered from the current turn, feeding the §18.4 terms. */
export interface SelectionSignals {
  /** Paths the user named with `@path` (§6.14). Strongest possible signal. */
  readonly mentionedPaths?: readonly string[];
  /** Path → number of `fs.search` hits. */
  readonly searchMatches?: ReadonlyMap<string, number>;
  /** Paths a tool already read or wrote this turn. */
  readonly recentToolPaths?: readonly string[];
  /** Bounded 1–2 hop repository-graph neighbors of retrieval seeds (P2). */
  readonly structuralPaths?: readonly string[];
  /** Paths changed in the working tree or by this turn. */
  readonly changedPaths?: readonly string[];
  /**
   * Paths named by failures the agent recently reflected on (§11.2).
   *
   * A failed attempt is evidence about where the truth is. If the loop just
   * discovered that its model of `src/parser.ts` was wrong, that file is worth
   * re-reading before the next attempt — which is exactly what the previous
   * attempt failed to do.
   */
  readonly recentFailurePaths?: readonly string[];
  /** Free-text task description, used for name similarity. */
  readonly taskText?: string;
}

/**
 * Immutable, per-selection indexes used by the scorer.
 *
 * Keeping exact mentions separate from the folder-aware lookup is deliberate:
 * an exact mention can bypass generated/vendor penalties, while a folder
 * mention only expands the normal candidate search.
 */
export interface SelectionScoringContext {
  readonly signals: SelectionSignals;
  readonly mentionedPaths: ReadonlySet<string>;
  readonly recentToolPaths: ReadonlySet<string>;
  readonly structuralPaths: ReadonlySet<string>;
  readonly changedPaths: ReadonlySet<string>;
  readonly recentFailurePaths: ReadonlySet<string>;
  readonly focusPaths: readonly string[];
  readonly taskTokens: ReadonlySet<string>;
  readonly entryPoints: ReadonlySet<string>;
  readonly manifests: ReadonlySet<string>;
  /** Source candidates plus exact mentions, retained in repository-map order. */
  readonly candidates: readonly RepoFile[];
  readonly candidateSet: ReadonlySet<RepoFile>;
  /** First changed source whose conventional test candidate is this path. */
  readonly testsForChangedSources: ReadonlyMap<string, string>;
  /** First changed test whose conventional source candidate is this path. */
  readonly sourcesForChangedTests: ReadonlyMap<string, string>;
}

/** Prepare the signal indexes once instead of rebuilding them per file. */
export function prepareSelectionScoringContext(
  map: RepositoryMap,
  signals: SelectionSignals,
): SelectionScoringContext;
/** Argument-order overload for callers that start from the signal snapshot. */
export function prepareSelectionScoringContext(
  signals: SelectionSignals,
  map: RepositoryMap,
): SelectionScoringContext;
export function prepareSelectionScoringContext(
  first: RepositoryMap | SelectionSignals,
  second: RepositoryMap | SelectionSignals,
): SelectionScoringContext {
  const map = isRepositoryMap(first) ? first : second as RepositoryMap;
  const signals = isRepositoryMap(first) ? second as SelectionSignals : first;
  const mentionedPaths = new Set(signals.mentionedPaths ?? []);
  const recentToolPaths = new Set(signals.recentToolPaths ?? []);
  const structuralPaths = new Set(signals.structuralPaths ?? []);
  const changedPaths = new Set(signals.changedPaths ?? []);
  const recentFailurePaths = new Set(signals.recentFailurePaths ?? []);
  const focusPaths = [
    ...mentionedPaths,
    ...changedPaths,
    ...recentToolPaths,
    ...structuralPaths,
    ...recentFailurePaths,
  ];
  const taskTokens = new Set(
    signals.taskText === undefined ? [] : tokenize(signals.taskText),
  );
  const testsForChangedSources = new Map<string, string>();
  for (const source of changedPaths) {
    for (const candidate of testCandidatesForSource(source)) {
      if (!testsForChangedSources.has(candidate)) testsForChangedSources.set(candidate, source);
    }
  }
  const sourcesForChangedTests = new Map<string, string>();
  for (const test of changedPaths) {
    for (const candidate of sourceCandidatesForTest(test)) {
      if (!sourcesForChangedTests.has(candidate)) sourcesForChangedTests.set(candidate, test);
    }
  }
  const candidates = map.files.filter((file) =>
    isSourceCandidate(file) || mentionedPaths.has(file.path),
  );
  const candidateSet = new Set(candidates);

  return Object.freeze({
    signals,
    mentionedPaths,
    recentToolPaths,
    structuralPaths,
    changedPaths,
    recentFailurePaths,
    focusPaths: Object.freeze(focusPaths),
    taskTokens,
    entryPoints: new Set(map.entryPoints),
    manifests: new Set(map.manifests),
    candidates: Object.freeze(candidates),
    candidateSet,
    testsForChangedSources,
    sourcesForChangedTests,
  });
}

export interface ScoredFile {
  readonly path: string;
  readonly score: number;
  readonly reasons: string[];
  readonly bytes: number;
  /** True when a penalty makes the file ineligible regardless of score. */
  readonly excluded: boolean;
}

export interface SelectionOptions {
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  /** Score below which a file is not worth its tokens. */
  readonly minScore?: number;
  /** Never select these, e.g. paths already in the compacted state. */
  readonly exclude?: readonly string[];
  /**
   * Opt-in bound for non-mentioned files scored on large repository maps.
   * Exact file mentions remain in the shortlist; folder mentions receive the
   * normal folder reason and a shortlist priority, but still obey this cap,
   * maxFiles, and maxTotalBytes like the legacy selector.
   */
  readonly shortlistCap?: number;
}

export interface SelectionDiagnostics {
  readonly shortlistCap: number;
  readonly candidateCount: number;
  readonly shortlistedCount: number;
  readonly scoredCount: number;
  readonly skippedByShortlist: number;
}

export interface SelectionResult {
  readonly selected: ScoredFile[];
  readonly considered: number;
  /** Files that scored above the floor but did not fit the byte budget. */
  readonly omittedForBudget: ScoredFile[];
  readonly excluded: ScoredFile[];
  /** Present only when the opt-in shortlist is used. */
  readonly diagnostics?: SelectionDiagnostics;
}

/**
 * Map a source path to the test paths that most plausibly cover it, and the
 * reverse. §18.4 lists "test-to-source mapping" as a scoring term and §11.8 needs
 * the "closest relevant tests", so both directions are useful.
 */
export function testCandidatesForSource(path: string): string[] {
  if (isTestPath(path)) return [];
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return [];
  const stem = base.slice(0, dot);
  const extension = base.slice(dot + 1);
  const directory = directoryOf(path);
  const prefix = directory.length > 0 ? `${directory}/` : "";

  return [
    `${prefix}${stem}.test.${extension}`,
    `${prefix}${stem}.spec.${extension}`,
    `${prefix}__tests__/${stem}.test.${extension}`,
    `${prefix}test/${stem}.test.${extension}`,
    `${prefix}tests/${stem}.test.${extension}`,
    `${prefix}test_${stem}.${extension}`,
    `${prefix}tests/test_${stem}.${extension}`,
    // Sibling `test/` and `tests/` trees mirroring `src/`.
    `${prefix.replace(/(^|\/)src\//, "$1test/")}${stem}.test.${extension}`,
    `${prefix.replace(/(^|\/)src\//, "$1tests/")}${stem}.test.${extension}`,
  ].filter((candidate) => candidate !== path);
}

export function sourceCandidatesForTest(path: string): string[] {
  if (!isTestPath(path)) return [];
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return [];
  const extension = base.slice(dot + 1);
  let stem = base.slice(0, dot);
  stem = stem.replace(/[.\-_](test|spec)$/i, "").replace(/^test_/i, "");

  const directory = directoryOf(path);
  const withoutTestDir = directory
    .replace(/(^|\/)(__tests__|tests?|specs?|e2e|integration)(\/|$)/g, "$1")
    .replace(/\/+$/, "")
    .replace(/\/\//g, "/");
  const candidates = new Set<string>();
  for (const dir of [directory, withoutTestDir, withoutTestDir.replace(/(^|\/)test(s)?\//, "$1src/")]) {
    const prefix = dir.length > 0 ? `${dir}/` : "";
    candidates.add(`${prefix}${stem}.${extension}`);
    candidates.add(`${prefix}${stem}/index.${extension}`);
  }
  candidates.delete(path);
  return [...candidates];
}

/** Score one file against the current signals. */
export function scoreFile(
  file: RepoFile,
  signals: SelectionSignals,
  map: RepositoryMap,
): ScoredFile {
  return scoreFileWithContext(file, prepareSelectionScoringContext(map, signals));
}

function scoreFileWithContext(
  file: RepoFile,
  context: SelectionScoringContext,
): ScoredFile {
  const reasons: string[] = [];
  let score = 0;
  let excluded = false;

  // ---- Hard exclusion: sensitive material never enters context automatically ----
  if (isSensitivePath(file.path)) {
    return {
      path: file.path,
      score: -SELECTION_WEIGHTS.sensitivePenalty,
      reasons: ["excluded: the path looks like credential material (§T4)"],
      bytes: file.bytes,
      excluded: true,
    };
  }

  // ---- Positive terms ----
  const mentioned = context.mentionedPaths;
  const mentionedDirectly = isMentioned(file.path, mentioned);
  if (mentionedDirectly) {
    score += SELECTION_WEIGHTS.mention;
    reasons.push(
      mentioned.has(file.path)
        ? "the user referenced this path explicitly"
        : "the user referenced this file's directory explicitly",
    );
  }

  const matches = context.signals.searchMatches?.get(file.path) ?? 0;
  if (matches > 0) {
    const value = Math.min(
      SELECTION_WEIGHTS.searchMatchCap,
      matches * SELECTION_WEIGHTS.searchMatch,
    );
    score += value;
    reasons.push(`${matches} search match(es)`);
  }

  if (context.recentToolPaths.has(file.path)) {
    score += SELECTION_WEIGHTS.recentToolUse;
    reasons.push("a tool already read this file this turn");
  }
  if (context.structuralPaths.has(file.path)) {
    score += SELECTION_WEIGHTS.structuralNeighbor;
    reasons.push("a bounded repository-graph neighbor of the retrieval seed");
  }

  if (context.changedPaths.has(file.path)) {
    score += SELECTION_WEIGHTS.changedFile;
    reasons.push("the file is part of the current change set");
  }

  if (context.recentFailurePaths.has(file.path)) {
    score += SELECTION_WEIGHTS.recentFailure;
    reasons.push("a recent failure named this file, so the assumption about it is suspect");
  }

  // Proximity to the files that already matter. A file the loop just failed on is
  // in focus by the same logic as one it changed: it is where the work is.
  const focus = context.focusPaths;
  if (focus.length > 0 && !focus.includes(file.path)) {
    const directory = directoryOf(file.path);
    const sameDirectory = focus.some((other) => directoryOf(other) === directory);
    if (sameDirectory) {
      score += SELECTION_WEIGHTS.pathProximitySameDirectory;
      reasons.push("same directory as a file already in focus");
    } else if (
      focus.some((other) => sharedPrefixDepth(other, file.path) >= 2)
    ) {
      score += SELECTION_WEIGHTS.pathProximitySameTree;
      reasons.push("same subtree as a file already in focus");
    }
  }

  // Test-to-source mapping in both directions (§18.4).
  const changedSource = context.testsForChangedSources.get(file.path);
  if (changedSource !== undefined) {
      score += SELECTION_WEIGHTS.testForChangedSource;
      reasons.push(`likely covers the changed file ${changedSource}`);
  }
  const changedTest = context.sourcesForChangedTests.get(file.path);
  if (changedTest !== undefined) {
      score += SELECTION_WEIGHTS.sourceForChangedTest;
      reasons.push(`is the subject of the changed test ${changedTest}`);
  }

  // Name similarity against the task text: a cheap stand-in for the symbol
  // proximity term until a symbol index lands (§18.3 keeps that out of P0).
  if (context.signals.taskText !== undefined && context.signals.taskText.length > 0) {
    const stem = stemOf(file.path);
    if (stem.length >= 4 && context.taskTokens.has(stem.toLowerCase())) {
      score += SELECTION_WEIGHTS.nameSimilarity;
      reasons.push(`the request names '${stem}'`);
    }
  }

  if (context.entryPoints.has(file.path)) {
    score += SELECTION_WEIGHTS.entryPoint;
    reasons.push("is a repository entry point");
  }
  if (context.manifests.has(file.path)) {
    score += SELECTION_WEIGHTS.manifest;
    reasons.push("is a package manifest");
  }

  // ---- Penalties ----
  const sizePenalty = Math.min(
    SELECTION_WEIGHTS.sizePenaltyMax,
    (file.bytes / 1024) * SELECTION_WEIGHTS.sizePenaltyPerKib,
  );
  if (sizePenalty >= 1) {
    score -= sizePenalty;
    reasons.push(`size penalty for ${(file.bytes / 1024).toFixed(1)} KiB`);
  }

  if (isGenerated(file.path)) {
    score -= SELECTION_WEIGHTS.generatedPenalty;
    reasons.push("generated or build output");
    // §18.4: generated files are included only when explicitly needed.
    if (!mentioned.has(file.path)) excluded = true;
  }
  if (isVendored(file.path)) {
    score -= SELECTION_WEIGHTS.vendorPenalty;
    reasons.push("vendored dependency");
    if (!mentioned.has(file.path)) excluded = true;
  }
  if (file.binary) {
    reasons.push("binary file");
    excluded = true;
  }

  return { path: file.path, score, reasons, bytes: file.bytes, excluded };
}

/**
 * Select the files worth spending context on.
 *
 * An explicit `@mention` bypasses the score floor and the byte budget check for
 * its own entry: the user asked for it, so silently dropping it would be worse
 * than exceeding the budget slightly (§6.14, P2).
 */
export function selectContext(
  map: RepositoryMap,
  signals: SelectionSignals,
  options: SelectionOptions = {},
): SelectionResult {
  const maxFiles = options.maxFiles ?? 12;
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024;
  const minScore = options.minScore ?? 1;
  const skip = new Set(options.exclude ?? []);
  const scoring = prepareSelectionScoringContext(map, signals);
  const mentioned = scoring.mentionedPaths;
  const shortlistCap = normalizeShortlistCap(options.shortlistCap);

  const scored: ScoredFile[] = [];
  const excluded: ScoredFile[] = [];

  const shortlistCandidates = shortlistCap === undefined
    ? undefined
    : buildShortlist(
      scoring.candidates.filter((file) => !skip.has(file.path)),
      scoring,
      shortlistCap,
    );
  const candidateCount = shortlistCandidates?.candidateCount ?? 0;
  const shortlistedPaths = shortlistCandidates?.paths;

  for (const file of map.files) {
    if (skip.has(file.path)) continue;
    // Binary and vendored files are not candidates unless named outright.
    if (!scoring.candidateSet.has(file)) {
      // Still score it so the inspector can explain the exclusion.
      excluded.push(scoreFileWithContext(file, scoring));
      continue;
    }
    if (shortlistedPaths !== undefined && !shortlistedPaths.has(file.path)) continue;
    const result = scoreFileWithContext(file, scoring);
    if (result.excluded) {
      excluded.push(result);
      continue;
    }
    scored.push(result);
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const selected: ScoredFile[] = [];
  const omittedForBudget: ScoredFile[] = [];
  let bytes = 0;

  for (const candidate of scored) {
    const isMentioned = mentioned.has(candidate.path);
    if (!isMentioned && candidate.score < minScore) continue;
    if (!isMentioned && selected.length >= maxFiles) {
      omittedForBudget.push(candidate);
      continue;
    }
    if (!isMentioned && bytes + candidate.bytes > maxTotalBytes) {
      omittedForBudget.push(candidate);
      continue;
    }
    selected.push(candidate);
    bytes += candidate.bytes;
  }

  return {
    selected,
    considered: scored.length,
    omittedForBudget,
    excluded,
    ...(shortlistCandidates === undefined
      ? {}
      : {
          diagnostics: {
            shortlistCap: shortlistCap!,
            candidateCount,
            shortlistedCount: shortlistCandidates.paths.size,
            scoredCount: scored.length,
            skippedByShortlist: Math.max(0, candidateCount - shortlistCandidates.paths.size),
          },
        }),
  };
}

interface Shortlist {
  readonly candidateCount: number;
  readonly paths: ReadonlySet<string>;
}

function buildShortlist(
  candidates: readonly RepoFile[],
  context: SelectionScoringContext,
  cap: number,
): Shortlist {
  const mentioned = candidates.filter((file) => context.mentionedPaths.has(file.path));
  const optional = candidates
    .filter((file) => !context.mentionedPaths.has(file.path))
    .sort((left, right) =>
      shortlistPriority(right, context) - shortlistPriority(left, context) ||
      left.path.localeCompare(right.path),
    );
  const paths = new Set<string>(mentioned.map((file) => file.path));
  for (const file of optional) {
    if (paths.size >= cap) break;
    paths.add(file.path);
  }
  return { candidateCount: candidates.length, paths };
}

function shortlistPriority(file: RepoFile, context: SelectionScoringContext): number {
  let priority = 0;
  if (isMentioned(file.path, context.mentionedPaths)) priority += 10_000;
  const matches = context.signals.searchMatches?.get(file.path) ?? 0;
  if (matches > 0) priority += 1_000 + Math.min(matches, 1_000);
  if (context.changedPaths.has(file.path)) priority += 800;
  if (context.recentFailurePaths.has(file.path)) priority += 700;
  if (context.recentToolPaths.has(file.path)) priority += 600;
  if (context.structuralPaths.has(file.path)) priority += 500;
  if (context.testsForChangedSources.has(file.path)) priority += 400;
  if (context.sourcesForChangedTests.has(file.path)) priority += 400;
  if (context.entryPoints.has(file.path)) priority += 100;
  if (context.manifests.has(file.path)) priority += 90;
  const stem = stemOf(file.path).toLowerCase();
  if (stem.length >= 4 && context.taskTokens.has(stem)) priority += 80;
  return priority;
}

function isMentioned(path: string, mentions: Iterable<string>): boolean {
  for (const mention of mentions) {
    if (mention === path || (mention.endsWith("/") && path.startsWith(mention))) return true;
  }
  return false;
}

function sharedPrefixDepth(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) {
    shared += 1;
  }
  return shared;
}

function stemOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0);
}

function normalizeShortlistCap(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function isRepositoryMap(value: RepositoryMap | SelectionSignals): value is RepositoryMap {
  return "files" in value && "byPath" in value;
}
