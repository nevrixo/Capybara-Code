/**
 * Bounded retrieval orchestration for context preparation.
 *
 * The controller is intentionally adapter-based. It owns ordering, budgets, and
 * the preview/exact authority boundary, while the host owns the actual search and
 * runtime reads. This keeps cache, capability, and observation handling in the
 * host executor rather than creating a second filesystem path here.
 */

export type RetrievalPhase = "search" | "preview" | "exact" | "stop";

export interface RetrievalBudget {
  readonly maxSearchCalls: number;
  readonly maxPreviewCalls: number;
  readonly maxExactCalls: number;
  readonly maxBytesScanned: number;
  readonly maxEvidenceTokens: number;
}

export interface RetrievalCandidate {
  readonly path: string;
  readonly startLine?: number;
  readonly maxLines?: number;
  readonly score?: number;
  readonly symbol?: string;
}

export interface RetrievalReadRequest extends RetrievalCandidate {
  readonly mode: "preview" | "exact";
}

export interface RetrievalObservation {
  readonly path: string;
  readonly mode: "preview" | "exact";
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly revisionToken: string;
  readonly checksum?: string;
  readonly authoritativeForWrite: boolean;
  readonly endOfFile: boolean;
  readonly truncatedByBytes: boolean;
  readonly bytesScanned: number;
  readonly bytesReturned?: number;
  readonly estimatedTokens?: number;
  /** Adapter-level sufficiency signal for preview stop rules. */
  readonly sufficient?: boolean;
}

export interface RetrievalAdapter {
  search(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly RetrievalCandidate[]>;
  preview(
    request: RetrievalReadRequest,
    signal?: AbortSignal,
  ): Promise<RetrievalObservation>;
  exact(
    request: RetrievalReadRequest,
    signal?: AbortSignal,
  ): Promise<RetrievalObservation>;
}

export interface RetrievalControllerOptions {
  readonly budget: RetrievalBudget;
  readonly maxCandidates?: number;
  /** Defaults to the adapter's explicit `sufficient` flag. */
  readonly isSufficient?: (
    observation: RetrievalObservation,
    candidate: RetrievalCandidate,
  ) => boolean;
  readonly signal?: AbortSignal;
}

export interface RetrievalControllerStats {
  readonly searchCalls: number;
  readonly previewCalls: number;
  readonly exactCalls: number;
  readonly bytesScanned: number;
  readonly evidenceTokens: number;
  readonly readsAvoided: number;
}

export interface RetrievalControllerResult {
  readonly phase: RetrievalPhase;
  readonly stopReason:
    | "sufficient_preview"
    | "exact_evidence"
    | "search_budget"
    | "preview_budget"
    | "exact_budget"
    | "byte_budget"
    | "evidence_budget"
    | "candidate_exhausted"
    | "aborted"
    | "adapter_error"
    | "non_authoritative_exact";
  readonly candidates: readonly RetrievalCandidate[];
  readonly previews: readonly RetrievalObservation[];
  readonly exact: readonly RetrievalObservation[];
  readonly errors: readonly { phase: "search" | "preview" | "exact"; path?: string; message: string }[];
  readonly stats: RetrievalControllerStats;
}

const DEFAULT_MAX_CANDIDATES = 64;

/**
 * Run deterministic search -> preview -> exact retrieval under explicit budgets.
 * A preview can inform selection but is never returned as exact evidence or write
 * authority. Exact reads must carry both a revision token and write authority.
 */
export class RetrievalController {
  readonly #adapter: RetrievalAdapter;
  readonly #options: RetrievalControllerOptions;

  constructor(adapter: RetrievalAdapter, options: RetrievalControllerOptions) {
    this.#adapter = adapter;
    this.#options = {
      ...options,
      budget: normalizeBudget(options.budget),
      maxCandidates: normalizeLimit(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES),
    };
  }

  async run(query: string): Promise<RetrievalControllerResult> {
    const budget = this.#options.budget;
    const errors: Array<{ phase: "search" | "preview" | "exact"; path?: string; message: string }> = [];
    const previews: RetrievalObservation[] = [];
    const exact: RetrievalObservation[] = [];
    let bytesScanned = 0;
    let evidenceTokens = 0;
    let previewCalls = 0;
    let exactCalls = 0;
    let readsAvoided = 0;

    if (this.#aborted()) {
      return this.#result("aborted", [], previews, exact, errors, 0, 0, 0, 0, 0);
    }
    if (budget.maxSearchCalls < 1) {
      return this.#result("search_budget", [], previews, exact, errors, 0, 0, 0, 0, 0);
    }

    let candidates: RetrievalCandidate[] = [];
    try {
      candidates = this.#normalizeCandidates(await this.#adapter.search(query, this.#options.signal));
    } catch (error) {
      errors.push({ phase: "search", message: messageOf(error) });
      return this.#result("adapter_error", candidates, previews, exact, errors, 1, 0, 0, 0, 0);
    }

    if (candidates.length === 0) {
      return this.#result("candidate_exhausted", candidates, previews, exact, errors, 1, 0, 0, 0, 0);
    }

    for (const candidate of candidates) {
      if (this.#aborted()) {
        return this.#result("aborted", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }
      if (previewCalls >= budget.maxPreviewCalls) {
        return this.#result("preview_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }
      if (bytesScanned >= budget.maxBytesScanned) {
        return this.#result("byte_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }

      const request: RetrievalReadRequest = { ...candidate, mode: "preview" };
      let observation: RetrievalObservation;
      previewCalls += 1;
      try {
        observation = await this.#adapter.preview(request, this.#options.signal);
        assertPreview(observation, candidate.path);
      } catch (error) {
        errors.push({ phase: "preview", path: candidate.path, message: messageOf(error) });
        continue;
      }
      previews.push(observation);
      bytesScanned += nonNegative(observation.bytesScanned);
      if (bytesScanned > budget.maxBytesScanned) {
        return this.#result("byte_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }

      const sufficient = this.#options.isSufficient?.(observation, candidate) ?? observation.sufficient === true;
      if (sufficient) {
        readsAvoided += Math.max(0, candidates.length - previews.length);
        return this.#result("sufficient_preview", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }

      if (exactCalls >= budget.maxExactCalls) {
        return this.#result("exact_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }
      const previewTokens = estimateObservationTokens(observation);
      if (evidenceTokens + previewTokens > budget.maxEvidenceTokens && budget.maxEvidenceTokens > 0) {
        return this.#result("evidence_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      }

      exactCalls += 1;
      try {
        const exactObservation = await this.#adapter.exact({ ...candidate, mode: "exact" }, this.#options.signal);
        assertExact(exactObservation, candidate.path);
        const exactTokens = estimateObservationTokens(exactObservation);
        if (evidenceTokens + exactTokens > budget.maxEvidenceTokens) {
          return this.#result("evidence_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
        }
        exact.push(exactObservation);
        evidenceTokens += exactTokens;
        bytesScanned += nonNegative(exactObservation.bytesScanned);
        if (bytesScanned > budget.maxBytesScanned) {
          return this.#result("byte_budget", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
        }
        return this.#result("exact_evidence", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
      } catch (error) {
        const message = messageOf(error);
        errors.push({ phase: "exact", path: candidate.path, message });
        if (/authoritative|checksum|revision/i.test(message)) {
          return this.#result("non_authoritative_exact", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
        }
      }
    }

    return this.#result("candidate_exhausted", candidates, previews, exact, errors, 1, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided);
  }

  #normalizeCandidates(candidates: readonly RetrievalCandidate[]): RetrievalCandidate[] {
    const seen = new Set<string>();
    return [...candidates]
      .filter((candidate) => typeof candidate.path === "string" && candidate.path.length > 0)
      .sort((left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        left.path.localeCompare(right.path) ||
        (left.startLine ?? 1) - (right.startLine ?? 1) ||
        (left.maxLines ?? 0) - (right.maxLines ?? 0),
      )
      .filter((candidate) => {
        const key = `${candidate.path}#${candidate.startLine ?? 1}-${candidate.maxLines ?? 0}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, this.#options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  }

  #aborted(): boolean {
    return this.#options.signal?.aborted === true;
  }

  #result(
    stopReason: RetrievalControllerResult["stopReason"],
    candidates: readonly RetrievalCandidate[],
    previews: readonly RetrievalObservation[],
    exact: readonly RetrievalObservation[],
    errors: readonly { phase: "search" | "preview" | "exact"; path?: string; message: string }[],
    searchCalls: number,
    previewCalls: number,
    exactCalls: number,
    bytesScanned: number,
    evidenceTokens: number,
    readsAvoided = 0,
  ): RetrievalControllerResult {
    const phase: RetrievalPhase = stopReason === "sufficient_preview"
      ? "preview"
      : stopReason === "exact_evidence"
        ? "exact"
        : "stop";
    return Object.freeze({
      phase,
      stopReason,
      candidates: Object.freeze([...candidates]),
      previews: Object.freeze([...previews]),
      exact: Object.freeze([...exact]),
      errors: Object.freeze([...errors]),
      stats: Object.freeze({ searchCalls, previewCalls, exactCalls, bytesScanned, evidenceTokens, readsAvoided }),
    });
  }
}

function normalizeBudget(budget: RetrievalBudget): RetrievalBudget {
  return Object.freeze({
    maxSearchCalls: normalizeLimit(budget.maxSearchCalls),
    maxPreviewCalls: normalizeLimit(budget.maxPreviewCalls),
    maxExactCalls: normalizeLimit(budget.maxExactCalls),
    maxBytesScanned: Math.max(0, Math.floor(Number.isFinite(budget.maxBytesScanned) ? budget.maxBytesScanned : 0)),
    maxEvidenceTokens: Math.max(0, Math.floor(Number.isFinite(budget.maxEvidenceTokens) ? budget.maxEvidenceTokens : 0)),
  });
}

function normalizeLimit(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function estimateObservationTokens(observation: RetrievalObservation): number {
  return Math.max(0, Math.floor(observation.estimatedTokens ?? observation.text.length / 4));
}

function assertPreview(observation: RetrievalObservation, path: string): void {
  if (observation.path !== path) throw new Error(`preview path mismatch for ${path}`);
  if (observation.mode !== "preview") throw new Error(`preview adapter returned ${observation.mode}`);
  if (observation.authoritativeForWrite) throw new Error(`preview for ${path} is write-authoritative`);
  if (typeof observation.revisionToken !== "string" || observation.revisionToken.length === 0) {
    throw new Error(`preview for ${path} has no revision token`);
  }
}

function assertExact(observation: RetrievalObservation, path: string): void {
  if (observation.path !== path) throw new Error(`exact path mismatch for ${path}`);
  if (observation.mode !== "exact") throw new Error(`exact adapter returned ${observation.mode}`);
  if (!observation.authoritativeForWrite) throw new Error(`exact for ${path} is not authoritative`);
  if (typeof observation.revisionToken !== "string" || observation.revisionToken.length === 0) {
    throw new Error(`exact for ${path} has no revision token`);
  }
  if (typeof observation.checksum !== "string" || observation.checksum.length === 0) {
    throw new Error(`exact for ${path} has no checksum`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
