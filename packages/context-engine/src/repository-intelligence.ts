/**
 * Deterministic, in-memory repository intelligence primitives (RFC P2).
 *
 * This module deliberately has no filesystem, process, database, or language-server
 * dependency. Callers feed it already-authorized text and normalized structural
 * observations. Raw file text is tokenized during ingestion and is not retained by
 * the lexical index.
 */

export const MAX_STRUCTURAL_HOPS = 2 as const;
export const DEFAULT_LEXICAL_LIMIT = 20;
export const MAX_LEXICAL_LIMIT = 200;
export const DEFAULT_STRUCTURAL_NODE_LIMIT = 64;
export const MAX_STRUCTURAL_NODE_LIMIT = 256;
export const DEFAULT_STRUCTURAL_EDGE_LIMIT = 128;
export const MAX_STRUCTURAL_EDGE_LIMIT = 512;

export type StructuralHopLimit = 1 | 2;

/** One-based, inclusive line range. Columns, when present, are zero-based. */
export interface SymbolRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
}

export type RepositorySymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "interface"
  | "trait"
  | "enum"
  | "enum_member"
  | "type"
  | "type_parameter"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "parameter"
  | "operator"
  | "event"
  | "key"
  | "unknown";

export type SymbolSource = "lsp" | "parser" | "lexical" | "manual";

/** A stable symbol identity plus the exact range needed for materialization. */
export interface SymbolRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: RepositorySymbolKind;
  readonly path: string;
  /** Full definition/body range. */
  readonly range: SymbolRange;
  /** Identifier range, if supplied by an LSP/document-symbol adapter. */
  readonly selectionRange?: SymbolRange;
  /** Signature and leading documentation range, when known. */
  readonly signatureRange?: SymbolRange;
  readonly containerName?: string;
  readonly signature?: string;
  readonly documentation?: string;
  readonly source: SymbolSource;
  readonly confidence: number;
}

export type SymbolInput = Omit<SymbolRecord, "id" | "source" | "confidence"> & {
  readonly id?: string;
  readonly source?: SymbolSource;
  readonly confidence?: number;
};

export type RepositoryNodeKind =
  | "file"
  | "module"
  | "symbol"
  | "test"
  | "config"
  | "diagnostic";

export interface RepositoryGraphNode {
  readonly id: string;
  readonly kind: RepositoryNodeKind;
  readonly label: string;
  readonly path?: string;
  readonly symbolId?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type RepositoryEdgeKind =
  | "contains"
  | "imports"
  | "defines"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "tests"
  | "configures"
  | "changed_with"
  | "failed_at";

export type RepositoryEdgeSource =
  | "lsp"
  | "parser"
  | "git"
  | "runtime"
  | "inferred"
  | "manual";

export interface RepositoryGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: RepositoryEdgeKind;
  readonly source: RepositoryEdgeSource;
  /** Confidence is always normalized to the closed interval [0, 1]. */
  readonly confidence: number;
  /** Exact adapter/parser observations are distinguishable from heuristics. */
  readonly exact: boolean;
}

export type RepositoryGraphEdgeInput = Omit<RepositoryGraphEdge, "id" | "source" | "confidence" | "exact"> & {
  readonly id?: string;
  readonly source?: RepositoryEdgeSource;
  readonly confidence?: number;
  readonly exact?: boolean;
};

export type LexicalField =
  | "path"
  | "basename"
  | "symbol"
  | "signature"
  | "comments"
  | "errorText"
  | "content";

export type LexicalDocumentKind = "file" | "symbol" | "diagnostic";

export interface LexicalDocumentInput {
  readonly id: string;
  readonly kind: LexicalDocumentKind;
  readonly path: string;
  readonly symbolId?: string;
  readonly fields: Partial<Record<LexicalField, string | readonly string[]>>;
}

export interface LexicalSearchOptions {
  readonly limit?: number;
  readonly kinds?: readonly LexicalDocumentKind[];
  readonly requireAllTerms?: boolean;
}

export interface LexicalSearchHit {
  readonly id: string;
  readonly kind: LexicalDocumentKind;
  readonly path: string;
  readonly symbolId?: string;
  /** BM25-like score. It is meaningful for ordering within this index snapshot. */
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly matchedFields: readonly LexicalField[];
}

const LEXICAL_FIELDS: readonly LexicalField[] = [
  "path",
  "basename",
  "symbol",
  "signature",
  "comments",
  "errorText",
  "content",
];

const LEXICAL_FIELD_WEIGHT: Readonly<Record<LexicalField, number>> = {
  path: 4,
  basename: 5,
  symbol: 9,
  signature: 5,
  comments: 2,
  errorText: 4,
  content: 1,
};

type TermFields = Map<LexicalField, number>;

interface IndexedLexicalDocument {
  readonly id: string;
  readonly kind: LexicalDocumentKind;
  readonly path: string;
  readonly symbolId?: string;
  readonly terms: ReadonlyMap<string, ReadonlyMap<LexicalField, number>>;
  readonly weightedLength: number;
}

/**
 * A small deterministic FTS-like inverted index.
 *
 * It uses weighted BM25-style scoring and stable code-point tie breaks. The index
 * retains term frequencies and locators, never the supplied content/comments.
 */
export class InMemoryLexicalIndex {
  readonly #documents = new Map<string, IndexedLexicalDocument>();
  readonly #postings = new Map<string, Set<string>>();

  get size(): number {
    return this.#documents.size;
  }

  upsert(input: LexicalDocumentInput): void {
    if (input.id.length === 0) throw new Error("lexical document id must not be empty");
    const path = normalizeRepositoryPath(input.path);
    this.remove(input.id);

    const terms = new Map<string, TermFields>();
    let weightedLength = 0;
    for (const field of LEXICAL_FIELDS) {
      const value = input.fields[field];
      if (value === undefined) continue;
      const texts = typeof value === "string" ? [value] : value;
      for (const text of texts) {
        for (const token of tokenizeLexicalText(text)) {
          const fields = terms.get(token) ?? new Map<LexicalField, number>();
          fields.set(field, (fields.get(field) ?? 0) + 1);
          terms.set(token, fields);
          weightedLength += LEXICAL_FIELD_WEIGHT[field];
        }
      }
    }

    const document: IndexedLexicalDocument = {
      id: input.id,
      kind: input.kind,
      path,
      ...(input.symbolId === undefined ? {} : { symbolId: input.symbolId }),
      terms,
      weightedLength: Math.max(1, weightedLength),
    };
    this.#documents.set(input.id, document);
    for (const term of terms.keys()) {
      const posting = this.#postings.get(term) ?? new Set<string>();
      posting.add(input.id);
      this.#postings.set(term, posting);
    }
  }

  remove(id: string): boolean {
    const previous = this.#documents.get(id);
    if (previous === undefined) return false;
    this.#documents.delete(id);
    for (const term of previous.terms.keys()) {
      const posting = this.#postings.get(term);
      posting?.delete(id);
      if (posting?.size === 0) this.#postings.delete(term);
    }
    return true;
  }

  clear(): void {
    this.#documents.clear();
    this.#postings.clear();
  }

  search(query: string, options: LexicalSearchOptions = {}): readonly LexicalSearchHit[] {
    const queryTerms = unique(tokenizeLexicalText(query));
    if (queryTerms.length === 0 || this.#documents.size === 0) return [];

    const kindFilter = options.kinds === undefined ? undefined : new Set(options.kinds);
    const eligibleDocuments = [...this.#documents.values()].filter(
      (document) => kindFilter === undefined || kindFilter.has(document.kind),
    );
    if (eligibleDocuments.length === 0) return [];
    const eligibleIds = new Set(eligibleDocuments.map((document) => document.id));
    const averageLength =
      eligibleDocuments.reduce((sum, document) => sum + document.weightedLength, 0) /
      eligibleDocuments.length;

    const candidateIds = new Set<string>();
    for (const term of queryTerms) {
      for (const id of this.#postings.get(term) ?? []) {
        if (eligibleIds.has(id)) candidateIds.add(id);
      }
    }

    const k1 = 1.2;
    const b = 0.75;
    const hits: LexicalSearchHit[] = [];
    for (const id of candidateIds) {
      const document = this.#documents.get(id);
      if (document === undefined) continue;
      const matchedTerms: string[] = [];
      const matchedFields = new Set<LexicalField>();
      let score = 0;

      for (const term of queryTerms) {
        const fields = document.terms.get(term);
        if (fields === undefined) continue;
        matchedTerms.push(term);
        let weightedFrequency = 0;
        for (const [field, count] of fields) {
          matchedFields.add(field);
          weightedFrequency += count * LEXICAL_FIELD_WEIGHT[field];
        }
        let documentFrequency = 0;
        for (const postingId of this.#postings.get(term) ?? []) {
          if (eligibleIds.has(postingId)) documentFrequency += 1;
        }
        const inverseDocumentFrequency = Math.log(
          1 +
            (eligibleDocuments.length - documentFrequency + 0.5) /
              (documentFrequency + 0.5),
        );
        const denominator =
          weightedFrequency +
          k1 * (1 - b + b * (document.weightedLength / averageLength));
        score +=
          inverseDocumentFrequency *
          ((weightedFrequency * (k1 + 1)) / Math.max(Number.EPSILON, denominator));
      }

      if (options.requireAllTerms === true && matchedTerms.length !== queryTerms.length) continue;
      // Reward documents covering more of a multi-term request without changing
      // the deterministic BM25 ordering for single-term requests.
      score *= 0.5 + 0.5 * (matchedTerms.length / queryTerms.length);
      hits.push({
        id: document.id,
        kind: document.kind,
        path: document.path,
        ...(document.symbolId === undefined ? {} : { symbolId: document.symbolId }),
        score,
        matchedTerms,
        matchedFields: LEXICAL_FIELDS.filter((field) => matchedFields.has(field)),
      });
    }

    const limit = boundedInteger(options.limit ?? DEFAULT_LEXICAL_LIMIT, 0, MAX_LEXICAL_LIMIT);
    return hits
      .sort(
        (left, right) =>
          right.score - left.score ||
          lexicalKindRank(left.kind) - lexicalKindRank(right.kind) ||
          compareText(left.path, right.path) ||
          compareText(left.id, right.id),
      )
      .slice(0, limit);
  }
}

export interface StructuralExpansionOptions {
  /** Runtime validation intentionally rejects zero or more than two hops. */
  readonly hops?: StructuralHopLimit;
  readonly direction?: "outgoing" | "incoming" | "both";
  readonly edgeKinds?: readonly RepositoryEdgeKind[];
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly minConfidence?: number;
}

export interface StructuralNodeHit {
  readonly node: RepositoryGraphNode;
  readonly hop: 0 | 1 | 2;
  readonly viaEdgeId?: string;
}

export interface StructuralExpansionResult {
  readonly seeds: readonly string[];
  readonly missingSeeds: readonly string[];
  readonly nodes: readonly StructuralNodeHit[];
  readonly edges: readonly RepositoryGraphEdge[];
  readonly truncated: boolean;
}

/** A heterogeneous graph with bounded deterministic breadth-first expansion. */
export class HeterogeneousRepositoryGraph {
  readonly #nodes = new Map<string, RepositoryGraphNode>();
  readonly #edges = new Map<string, RepositoryGraphEdge>();
  readonly #outgoing = new Map<string, Set<string>>();
  readonly #incoming = new Map<string, Set<string>>();

  get nodeCount(): number {
    return this.#nodes.size;
  }

  get edgeCount(): number {
    return this.#edges.size;
  }

  upsertNode(node: RepositoryGraphNode): void {
    if (node.id.length === 0) throw new Error("graph node id must not be empty");
    this.#nodes.set(node.id, {
      ...node,
      ...(node.path === undefined ? {} : { path: normalizeRepositoryPath(node.path) }),
    });
  }

  getNode(id: string): RepositoryGraphNode | undefined {
    return this.#nodes.get(id);
  }

  nodes(): readonly RepositoryGraphNode[] {
    return [...this.#nodes.values()].sort((left, right) => compareText(left.id, right.id));
  }

  removeNode(id: string): boolean {
    if (!this.#nodes.delete(id)) return false;
    const incident = new Set([
      ...(this.#outgoing.get(id) ?? []),
      ...(this.#incoming.get(id) ?? []),
    ]);
    for (const edgeId of incident) this.removeEdge(edgeId);
    this.#outgoing.delete(id);
    this.#incoming.delete(id);
    return true;
  }

  upsertEdge(input: RepositoryGraphEdgeInput): RepositoryGraphEdge {
    if (!this.#nodes.has(input.from) || !this.#nodes.has(input.to)) {
      throw new Error(`graph edge endpoints must exist: ${input.from} -> ${input.to}`);
    }
    const source = input.source ?? "manual";
    const confidence = confidenceValue(input.confidence ?? defaultEdgeConfidence(source));
    const exact = input.exact ?? (source !== "inferred");
    const id = input.id ?? repositoryEdgeId(input.from, input.kind, input.to, source);
    const previous = this.#edges.get(id);
    if (previous !== undefined) {
      this.#outgoing.get(previous.from)?.delete(id);
      this.#incoming.get(previous.to)?.delete(id);
    }
    const edge: RepositoryGraphEdge = {
      id,
      from: input.from,
      to: input.to,
      kind: input.kind,
      source,
      confidence,
      exact,
    };
    this.#edges.set(id, edge);
    addToSetMap(this.#outgoing, edge.from, id);
    addToSetMap(this.#incoming, edge.to, id);
    return edge;
  }

  getEdge(id: string): RepositoryGraphEdge | undefined {
    return this.#edges.get(id);
  }

  edges(): readonly RepositoryGraphEdge[] {
    return [...this.#edges.values()].sort(compareEdges);
  }

  removeEdge(id: string): boolean {
    const edge = this.#edges.get(id);
    if (edge === undefined) return false;
    this.#edges.delete(id);
    this.#outgoing.get(edge.from)?.delete(id);
    this.#incoming.get(edge.to)?.delete(id);
    return true;
  }

  clear(): void {
    this.#nodes.clear();
    this.#edges.clear();
    this.#outgoing.clear();
    this.#incoming.clear();
  }

  expand(
    seedIds: readonly string[],
    options: StructuralExpansionOptions = {},
  ): StructuralExpansionResult {
    const hops = options.hops ?? 1;
    if (hops !== 1 && hops !== 2) {
      throw new RangeError("structural retrieval is bounded to one or two hops");
    }
    const maxNodes = boundedInteger(
      options.maxNodes ?? DEFAULT_STRUCTURAL_NODE_LIMIT,
      1,
      MAX_STRUCTURAL_NODE_LIMIT,
    );
    const maxEdges = boundedInteger(
      options.maxEdges ?? DEFAULT_STRUCTURAL_EDGE_LIMIT,
      0,
      MAX_STRUCTURAL_EDGE_LIMIT,
    );
    const minConfidence = confidenceValue(options.minConfidence ?? 0);
    const direction = options.direction ?? "both";
    const allowedKinds = options.edgeKinds === undefined ? undefined : new Set(options.edgeKinds);
    const requestedSeeds = unique(seedIds).sort(compareText);
    const missingSeeds = requestedSeeds.filter((id) => !this.#nodes.has(id));
    const presentSeeds = requestedSeeds.filter((id) => this.#nodes.has(id));
    const visits = new Map<string, StructuralNodeHit>();
    let truncated = presentSeeds.length > maxNodes;
    let frontier: string[] = [];

    for (const id of presentSeeds.slice(0, maxNodes)) {
      const node = this.#nodes.get(id);
      if (node === undefined) continue;
      visits.set(id, { node, hop: 0 });
      frontier.push(id);
    }

    const selectedEdges = new Map<string, RepositoryGraphEdge>();
    for (let depth = 1; depth <= hops && frontier.length > 0; depth += 1) {
      const candidates: Array<{ edge: RepositoryGraphEdge; neighbor: string }> = [];
      for (const nodeId of frontier) {
        for (const edgeId of this.#adjacentEdgeIds(nodeId, direction)) {
          const edge = this.#edges.get(edgeId);
          if (edge === undefined) continue;
          if (allowedKinds !== undefined && !allowedKinds.has(edge.kind)) continue;
          if (edge.confidence < minConfidence) continue;
          if (direction === "outgoing" && edge.from !== nodeId) continue;
          if (direction === "incoming" && edge.to !== nodeId) continue;
          const neighbor = edge.from === nodeId ? edge.to : edge.from;
          candidates.push({ edge, neighbor });
        }
      }
      candidates.sort(
        (left, right) =>
          compareEdges(left.edge, right.edge) || compareText(left.neighbor, right.neighbor),
      );

      const next = new Set<string>();
      for (const candidate of candidates) {
        const alreadyVisited = visits.has(candidate.neighbor);
        const edgeAlreadySelected = selectedEdges.has(candidate.edge.id);
        if (!edgeAlreadySelected && selectedEdges.size >= maxEdges) {
          if (!alreadyVisited) truncated = true;
          continue;
        }
        if (!alreadyVisited && visits.size >= maxNodes) {
          truncated = true;
          continue;
        }
        if (!alreadyVisited) {
          const node = this.#nodes.get(candidate.neighbor);
          if (node === undefined) continue;
          const hop = depth as 1 | 2;
          visits.set(candidate.neighbor, {
            node,
            hop,
            viaEdgeId: candidate.edge.id,
          });
          next.add(candidate.neighbor);
        }
        // Only report edges whose two endpoints are in the returned subgraph.
        if (visits.has(candidate.edge.from) && visits.has(candidate.edge.to)) {
          selectedEdges.set(candidate.edge.id, candidate.edge);
        }
      }
      frontier = [...next].sort(compareText);
    }

    return {
      seeds: presentSeeds.slice(0, maxNodes),
      missingSeeds,
      nodes: [...visits.values()].sort(
        (left, right) => left.hop - right.hop || compareText(left.node.id, right.node.id),
      ),
      edges: [...selectedEdges.values()].sort(compareEdges),
      truncated,
    };
  }

  #adjacentEdgeIds(
    nodeId: string,
    direction: "outgoing" | "incoming" | "both",
  ): readonly string[] {
    const ids = new Set<string>();
    if (direction !== "incoming") {
      for (const id of this.#outgoing.get(nodeId) ?? []) ids.add(id);
    }
    if (direction !== "outgoing") {
      for (const id of this.#incoming.get(nodeId) ?? []) ids.add(id);
    }
    return [...ids].sort(compareText);
  }
}

/** Backwards-friendly concise name for consumers that prefer CodeGraph terminology. */
export { HeterogeneousRepositoryGraph as HeterogeneousCodeGraph };

export interface RepositoryFileInput {
  readonly path: string;
  /** Text is consumed into term frequencies and then discarded. */
  readonly text?: string;
  /** Alias accepted for ingest pipelines that call file text `content`. */
  readonly content?: string;
  readonly comments?: string | readonly string[];
  readonly errorText?: string | readonly string[];
  readonly checksum?: string;
  readonly language?: string;
  readonly nodeKind?: Extract<RepositoryNodeKind, "file" | "module" | "test" | "config">;
}

export interface RepositoryFileRecord {
  readonly path: string;
  readonly checksum?: string;
  readonly language?: string;
  readonly lineCount?: number;
  readonly nodeKind: Extract<RepositoryNodeKind, "file" | "module" | "test" | "config">;
}

export interface SymbolRangeCandidate {
  readonly path: string;
  readonly checksum?: string;
  readonly symbol: string;
  readonly symbolId: string;
  readonly kind: RepositorySymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
  readonly resolution: "signature" | "body" | "full";
  readonly reason: string;
  readonly score: number;
  readonly graphHop?: 0 | 1 | 2;
}

export interface SymbolRangeCandidateOptions {
  readonly resolution?: "signature" | "body" | "full";
  readonly contextLines?: number;
  readonly totalLines?: number;
  readonly checksum?: string;
  readonly reason?: string;
  readonly score?: number;
  readonly graphHop?: 0 | 1 | 2;
}

export function createSymbolRangeCandidate(
  symbol: SymbolRecord,
  options: SymbolRangeCandidateOptions = {},
): SymbolRangeCandidate {
  const resolution = options.resolution ?? "body";
  const selectedRange =
    resolution === "signature"
      ? symbol.signatureRange ?? symbol.selectionRange ?? symbol.range
      : symbol.range;
  const contextLines = boundedInteger(options.contextLines ?? 0, 0, 200);
  const startLine = Math.max(1, selectedRange.startLine - contextLines);
  const unboundedEnd = selectedRange.endLine + contextLines;
  const endLine = Math.max(
    startLine,
    options.totalLines === undefined
      ? unboundedEnd
      : Math.min(Math.max(1, options.totalLines), unboundedEnd),
  );
  return {
    path: symbol.path,
    ...(options.checksum === undefined ? {} : { checksum: options.checksum }),
    symbol: symbol.name,
    symbolId: symbol.id,
    kind: symbol.kind,
    startLine,
    endLine,
    ...(selectedRange.startColumn === undefined ? {} : { startColumn: selectedRange.startColumn }),
    ...(selectedRange.endColumn === undefined ? {} : { endColumn: selectedRange.endColumn }),
    resolution,
    reason: options.reason ?? `definition range for ${symbol.name}`,
    score: options.score ?? symbol.confidence,
    ...(options.graphHop === undefined ? {} : { graphHop: options.graphHop }),
  };
}

/** RFC spelling: materialization produces a ContextSpan-shaped range candidate. */
export const materializeSymbolRange = createSymbolRangeCandidate;

export interface RepositoryRetrievalRequest extends StructuralExpansionOptions {
  readonly query?: string;
  readonly mentionedPaths?: readonly string[];
  /** IDs and exact names are both accepted. */
  readonly mentionedSymbols?: readonly string[];
  readonly seedNodeIds?: readonly string[];
  readonly lexicalLimit?: number;
  readonly graphSeedLimit?: number;
  readonly maxRangeCandidates?: number;
  readonly rangeResolution?: "signature" | "body" | "full";
  readonly rangeContextLines?: number;
}

export interface RepositoryRetrievalResult {
  readonly lexicalHits: readonly LexicalSearchHit[];
  readonly seedNodeIds: readonly string[];
  readonly structural: StructuralExpansionResult;
  readonly rangeCandidates: readonly SymbolRangeCandidate[];
}

interface CandidateAccumulator {
  readonly symbol: SymbolRecord;
  score: number;
  hop?: 0 | 1 | 2;
  readonly reasons: Set<string>;
}

/**
 * Self-contained P2 facade combining the lexical index, symbol table, and graph.
 */
export class RepositoryIntelligence {
  readonly lexical = new InMemoryLexicalIndex();
  readonly graph = new HeterogeneousRepositoryGraph();
  readonly #files = new Map<string, RepositoryFileRecord>();
  readonly #symbols = new Map<string, SymbolRecord>();
  readonly #symbolsByPath = new Map<string, Set<string>>();

  get fileCount(): number {
    return this.#files.size;
  }

  get symbolCount(): number {
    return this.#symbols.size;
  }

  files(): readonly RepositoryFileRecord[] {
    return [...this.#files.values()].sort((left, right) => compareText(left.path, right.path));
  }

  symbols(path?: string): readonly SymbolRecord[] {
    const records =
      path === undefined
        ? [...this.#symbols.values()]
        : [...(this.#symbolsByPath.get(normalizeRepositoryPath(path)) ?? [])]
            .map((id) => this.#symbols.get(id))
            .filter((symbol): symbol is SymbolRecord => symbol !== undefined);
    return records.sort(compareSymbols);
  }

  getFile(path: string): RepositoryFileRecord | undefined {
    return this.#files.get(normalizeRepositoryPath(path));
  }

  getSymbol(id: string): SymbolRecord | undefined {
    return this.#symbols.get(id);
  }

  upsertFile(input: RepositoryFileInput): RepositoryFileRecord {
    const path = normalizeRepositoryPath(input.path);
    const text = input.text ?? input.content;
    const record: RepositoryFileRecord = {
      path,
      ...(input.checksum === undefined ? {} : { checksum: input.checksum }),
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(text === undefined ? {} : { lineCount: lineCount(text) }),
      nodeKind: input.nodeKind ?? inferFileNodeKind(path),
    };
    this.#files.set(path, record);
    this.graph.upsertNode({
      id: repositoryFileNodeId(path),
      kind: record.nodeKind,
      label: path,
      path,
    });
    this.lexical.upsert({
      id: lexicalFileDocumentId(path),
      kind: "file",
      path,
      fields: {
        path,
        basename: basename(path),
        ...(text === undefined ? {} : { content: text }),
        ...(input.comments === undefined ? {} : { comments: input.comments }),
        ...(input.errorText === undefined ? {} : { errorText: input.errorText }),
      },
    });
    return record;
  }

  removeFile(pathInput: string): boolean {
    const path = normalizeRepositoryPath(pathInput);
    if (!this.#files.has(path)) return false;
    for (const symbolId of [...(this.#symbolsByPath.get(path) ?? [])]) {
      this.removeSymbol(symbolId);
    }
    this.#symbolsByPath.delete(path);
    this.#files.delete(path);
    this.lexical.remove(lexicalFileDocumentId(path));
    this.graph.removeNode(repositoryFileNodeId(path));
    return true;
  }

  upsertSymbol(input: SymbolInput): SymbolRecord {
    const path = normalizeRepositoryPath(input.path);
    if (!this.#files.has(path)) this.upsertFile({ path });
    const range = normalizeSymbolRange(input.range);
    const selectionRange =
      input.selectionRange === undefined ? undefined : normalizeSymbolRange(input.selectionRange);
    const signatureRange =
      input.signatureRange === undefined ? undefined : normalizeSymbolRange(input.signatureRange);
    const id =
      input.id ?? repositorySymbolId(path, input.name, input.kind, range.startLine, range.startColumn);
    if (id.length === 0) throw new Error("symbol id must not be empty");
    if (input.name.trim().length === 0) throw new Error("symbol name must not be empty");
    const previous = this.#symbols.get(id);
    if (previous !== undefined) this.removeSymbol(id);
    const record: SymbolRecord = {
      id,
      name: input.name,
      kind: input.kind,
      path,
      range,
      ...(selectionRange === undefined ? {} : { selectionRange }),
      ...(signatureRange === undefined ? {} : { signatureRange }),
      ...(input.containerName === undefined ? {} : { containerName: input.containerName }),
      ...(input.signature === undefined ? {} : { signature: input.signature }),
      ...(input.documentation === undefined ? {} : { documentation: input.documentation }),
      source: input.source ?? "manual",
      confidence: confidenceValue(input.confidence ?? (input.source === "lexical" ? 0.5 : 1)),
    };
    this.#symbols.set(id, record);
    addToSetMap(this.#symbolsByPath, path, id);
    this.lexical.upsert({
      id: lexicalSymbolDocumentId(id),
      kind: "symbol",
      path,
      symbolId: id,
      fields: {
        path,
        basename: basename(path),
        symbol: [record.name, record.containerName ?? ""],
        ...(record.signature === undefined ? {} : { signature: record.signature }),
        ...(record.documentation === undefined ? {} : { comments: record.documentation }),
      },
    });
    const nodeId = repositorySymbolNodeId(id);
    this.graph.upsertNode({
      id: nodeId,
      kind: "symbol",
      label: record.name,
      path,
      symbolId: id,
      metadata: { symbolKind: record.kind },
    });
    for (const kind of ["contains", "defines"] as const) {
      this.graph.upsertEdge({
        from: repositoryFileNodeId(path),
        to: nodeId,
        kind,
        source: record.source === "lsp" ? "lsp" : record.source === "parser" ? "parser" : "manual",
        confidence: record.confidence,
        exact: record.source !== "lexical",
      });
    }
    return record;
  }

  replaceSymbols(
    pathInput: string,
    inputs: readonly (Omit<SymbolInput, "path"> & { readonly path?: string })[],
  ): readonly SymbolRecord[] {
    const path = normalizeRepositoryPath(pathInput);
    for (const id of [...(this.#symbolsByPath.get(path) ?? [])]) this.removeSymbol(id);
    const records = inputs.map((input) => this.upsertSymbol({ ...input, path }));
    return records.sort(compareSymbols);
  }

  removeSymbol(id: string): boolean {
    const symbol = this.#symbols.get(id);
    if (symbol === undefined) return false;
    this.#symbols.delete(id);
    const pathSymbols = this.#symbolsByPath.get(symbol.path);
    pathSymbols?.delete(id);
    if (pathSymbols?.size === 0) this.#symbolsByPath.delete(symbol.path);
    this.lexical.remove(lexicalSymbolDocumentId(id));
    this.graph.removeNode(repositorySymbolNodeId(id));
    return true;
  }

  upsertNode(node: RepositoryGraphNode): void {
    this.graph.upsertNode(node);
  }

  upsertEdge(input: RepositoryGraphEdgeInput): RepositoryGraphEdge {
    return this.graph.upsertEdge(input);
  }

  search(query: string, options: LexicalSearchOptions = {}): readonly LexicalSearchHit[] {
    return this.lexical.search(query, options);
  }

  retrieve(request: RepositoryRetrievalRequest): RepositoryRetrievalResult {
    const lexicalHits =
      request.query === undefined || request.query.trim().length === 0
        ? []
        : this.lexical.search(
            request.query,
            request.lexicalLimit === undefined ? {} : { limit: request.lexicalLimit },
          );
    const seeds = new Set<string>();

    for (const rawPath of request.mentionedPaths ?? []) {
      let path: string;
      try {
        path = normalizeRepositoryPath(rawPath);
      } catch {
        continue;
      }
      const nodeId = repositoryFileNodeId(path);
      if (this.graph.getNode(nodeId) !== undefined) seeds.add(nodeId);
    }
    const exactSymbolIds = new Set<string>();
    for (const mention of request.mentionedSymbols ?? []) {
      const byId = this.#symbols.get(mention);
      if (byId !== undefined) exactSymbolIds.add(byId.id);
      for (const symbol of this.#symbols.values()) {
        if (symbol.name === mention) exactSymbolIds.add(symbol.id);
      }
    }
    for (const id of exactSymbolIds) seeds.add(repositorySymbolNodeId(id));
    for (const id of request.seedNodeIds ?? []) {
      if (this.graph.getNode(id) !== undefined) seeds.add(id);
    }

    const graphSeedLimit = boundedInteger(request.graphSeedLimit ?? 12, 1, 64);
    for (const hit of lexicalHits) {
      if (seeds.size >= graphSeedLimit) break;
      const nodeId =
        hit.kind === "symbol" && hit.symbolId !== undefined
          ? repositorySymbolNodeId(hit.symbolId)
          : repositoryFileNodeId(hit.path);
      if (this.graph.getNode(nodeId) !== undefined) seeds.add(nodeId);
    }

    const seedNodeIds = [...seeds].sort(compareText);
    const structural = this.graph.expand(seedNodeIds, {
      ...(request.hops === undefined ? {} : { hops: request.hops }),
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      ...(request.edgeKinds === undefined ? {} : { edgeKinds: request.edgeKinds }),
      ...(request.maxNodes === undefined ? {} : { maxNodes: request.maxNodes }),
      ...(request.maxEdges === undefined ? {} : { maxEdges: request.maxEdges }),
      ...(request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence }),
    });
    const accumulators = new Map<string, CandidateAccumulator>();
    const addCandidate = (
      symbol: SymbolRecord,
      score: number,
      reason: string,
      hop?: 0 | 1 | 2,
    ): void => {
      const current = accumulators.get(symbol.id);
      if (current === undefined) {
        accumulators.set(symbol.id, {
          symbol,
          score,
          ...(hop === undefined ? {} : { hop }),
          reasons: new Set([reason]),
        });
        return;
      }
      current.score = Math.max(current.score, score);
      current.reasons.add(reason);
      if (hop !== undefined && (current.hop === undefined || hop < current.hop)) current.hop = hop;
    };

    for (const symbolId of exactSymbolIds) {
      const symbol = this.#symbols.get(symbolId);
      if (symbol !== undefined) addCandidate(symbol, 1_000, "symbol explicitly mentioned", 0);
    }
    for (const hit of lexicalHits) {
      if (hit.symbolId !== undefined) {
        const symbol = this.#symbols.get(hit.symbolId);
        if (symbol !== undefined) addCandidate(symbol, hit.score, "lexical symbol match");
      } else {
        for (const symbol of this.symbols(hit.path)) {
          addCandidate(symbol, hit.score * 0.75, "symbol in a lexically matched file");
        }
      }
    }
    for (const hit of structural.nodes) {
      const directSymbol =
        hit.node.symbolId === undefined ? undefined : this.#symbols.get(hit.node.symbolId);
      if (directSymbol !== undefined) {
        addCandidate(
          directSymbol,
          100 / (hit.hop + 1),
          hit.hop === 0 ? "structural seed" : `${hit.hop}-hop structural neighbor`,
          hit.hop,
        );
      } else if (hit.node.path !== undefined && hit.node.kind !== "diagnostic") {
        for (const symbol of this.symbols(hit.node.path)) {
          addCandidate(
            symbol,
            75 / (hit.hop + 1),
            hit.hop === 0 ? "symbol in seed file" : `symbol in ${hit.hop}-hop file`,
            hit.hop,
          );
        }
      }
    }

    const maxCandidates = boundedInteger(request.maxRangeCandidates ?? 32, 0, 128);
    const rangeCandidates = [...accumulators.values()]
      .sort(
        (left, right) =>
          right.score - left.score || compareSymbols(left.symbol, right.symbol),
      )
      .slice(0, maxCandidates)
      .map((candidate) => {
        const file = this.#files.get(candidate.symbol.path);
        return createSymbolRangeCandidate(candidate.symbol, {
          resolution: request.rangeResolution ?? "body",
          ...(request.rangeContextLines === undefined
            ? {}
            : { contextLines: request.rangeContextLines }),
          ...(file?.lineCount === undefined ? {} : { totalLines: file.lineCount }),
          ...(file?.checksum === undefined ? {} : { checksum: file.checksum }),
          reason: [...candidate.reasons].sort(compareText).join("; "),
          score: candidate.score,
          ...(candidate.hop === undefined ? {} : { graphHop: candidate.hop }),
        });
      });

    return { lexicalHits, seedNodeIds, structural, rangeCandidates };
  }

  clear(): void {
    this.#files.clear();
    this.#symbols.clear();
    this.#symbolsByPath.clear();
    this.lexical.clear();
    this.graph.clear();
  }
}

/** Concise alias useful at call sites that name the component an index. */
export { RepositoryIntelligence as RepositoryIntelligenceIndex };

export interface LocalizationCandidate {
  readonly path: string;
  readonly symbolId?: string;
  readonly symbol?: string;
  readonly nodeId?: string;
  readonly graphHop?: 0 | 1 | 2;
}

export interface ExpectedSymbol {
  readonly id?: string;
  readonly name?: string;
  readonly path?: string;
}

export interface LocalizationExpectation {
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly (string | ExpectedSymbol)[];
  readonly expectedGraphNodeIds?: readonly string[];
}

export interface LocalizationMetrics {
  readonly k: number;
  readonly retrievedFiles: readonly string[];
  readonly retrievedSymbols: readonly string[];
  readonly expectedFileHits: readonly string[];
  readonly expectedSymbolHits: readonly string[];
  readonly fileRecall: number;
  readonly symbolRecall: number;
  readonly filePrecision: number;
  readonly symbolPrecision: number;
  readonly precision: number;
  readonly graphHopCoverage: number;
  readonly missedDependencyRate: number;
}

/** Compute deterministic recall/precision metrics over the first k ranked spans. */
export function evaluateLocalization(
  candidates: readonly LocalizationCandidate[],
  expectation: LocalizationExpectation,
  k = candidates.length,
): LocalizationMetrics {
  const boundedK = Math.max(0, Math.floor(k));
  const top = candidates.slice(0, boundedK);
  const expectedFiles = unique(expectation.expectedFiles.map(normalizeRepositoryPath));
  const retrievedFiles = unique(
    top.map((candidate) => normalizeRepositoryPath(candidate.path)),
  );
  const expectedFileSet = new Set(expectedFiles);
  const expectedFileHits = expectedFiles.filter((path) => retrievedFiles.includes(path));

  const expectedSymbols = expectation.expectedSymbols;
  const expectedSymbolKeys = expectedSymbols.map(expectedSymbolKey);
  const matchedExpected = new Set<number>();
  const retrievedSymbols: string[] = [];
  let relevantCandidates = 0;
  let retrievedSymbolCandidateCount = 0;
  for (const candidate of top) {
    const candidateKey = localizationCandidateSymbolKey(candidate);
    if (candidateKey !== undefined) {
      retrievedSymbolCandidateCount += 1;
      if (!retrievedSymbols.includes(candidateKey)) retrievedSymbols.push(candidateKey);
    }
    let relevant = expectedFileSet.has(normalizeRepositoryPath(candidate.path));
    for (let index = 0; index < expectedSymbols.length; index += 1) {
      const expected = expectedSymbols[index];
      if (expected !== undefined && matchesExpectedSymbol(candidate, expected)) {
        matchedExpected.add(index);
        relevant = true;
      }
    }
    if (relevant) relevantCandidates += 1;
  }
  const expectedSymbolHits = [...matchedExpected]
    .sort((left, right) => left - right)
    .map((index) => expectedSymbolKeys[index])
    .filter((value): value is string => value !== undefined);

  const expectedGraphNodes = unique(expectation.expectedGraphNodeIds ?? []);
  const retrievedGraphNodes = new Set(
    top
      .filter((candidate) => candidate.graphHop !== undefined && candidate.graphHop <= 2)
      .map((candidate) => candidate.nodeId)
      .filter((id): id is string => id !== undefined),
  );
  const graphHits = expectedGraphNodes.filter((id) => retrievedGraphNodes.has(id)).length;
  const graphHopCoverage = ratio(graphHits, expectedGraphNodes.length, 1);

  return {
    k: boundedK,
    retrievedFiles,
    retrievedSymbols,
    expectedFileHits,
    expectedSymbolHits,
    fileRecall: ratio(expectedFileHits.length, expectedFiles.length, 1),
    symbolRecall: ratio(matchedExpected.size, expectedSymbols.length, 1),
    filePrecision: ratio(expectedFileHits.length, retrievedFiles.length, 1),
    symbolPrecision: ratio(matchedExpected.size, retrievedSymbolCandidateCount, 1),
    precision: ratio(relevantCandidates, top.length, 1),
    graphHopCoverage,
    missedDependencyRate: 1 - graphHopCoverage,
  };
}

export const localizationMetricsAtK = evaluateLocalization;

export interface LocalizationCase {
  readonly candidates: readonly LocalizationCandidate[];
  readonly expectation: LocalizationExpectation;
}

export interface LocalizationSuiteMetrics {
  readonly cases: number;
  readonly k: number;
  readonly fileRecall: number;
  readonly symbolRecall: number;
  readonly precision: number;
}

/** Macro-average localization metrics so large repositories do not dominate. */
export function evaluateLocalizationSuite(
  cases: readonly LocalizationCase[],
  k: number,
): LocalizationSuiteMetrics {
  const metrics = cases.map((entry) => evaluateLocalization(entry.candidates, entry.expectation, k));
  return {
    cases: cases.length,
    k: Math.max(0, Math.floor(k)),
    fileRecall: mean(metrics.map((entry) => entry.fileRecall)),
    symbolRecall: mean(metrics.map((entry) => entry.symbolRecall)),
    precision: mean(metrics.map((entry) => entry.precision)),
  };
}

// ---------------------------------------------------------------------------
// Optional managed-adapter boundary. Implementations may wrap an LSP later;
// RepositoryIntelligence itself never starts a daemon.
// ---------------------------------------------------------------------------

export type ManagedRepositoryAdapterState =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface ManagedRepositoryAdapterStart {
  readonly workspaceRoot: string;
  readonly workspaceIdentity: string;
  readonly languageIds?: readonly string[];
}

export interface ManagedAdapterRequestOptions {
  /** Adapters must normalize and cap their result to this bound. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface BoundedAdapterResult<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
}

export interface ManagedAdapterDocument {
  readonly path: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

export interface RepositoryLocation {
  readonly path: string;
  readonly range: SymbolRange;
}

export interface RepositoryDiagnostic extends RepositoryLocation {
  readonly id: string;
  readonly message: string;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly code?: string;
  readonly source?: string;
}

/**
 * Lifecycle and bounded read-only capabilities for a future LSP/tree-sitter
 * adapter. Implementations are responsible for rejecting URIs outside the root.
 */
export interface ManagedRepositoryAdapter {
  readonly id: string;
  readonly state: ManagedRepositoryAdapterState;
  start(options: ManagedRepositoryAdapterStart, signal?: AbortSignal): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
  syncDocument(document: ManagedAdapterDocument, signal?: AbortSignal): Promise<void>;
  closeDocument(path: string, signal?: AbortSignal): Promise<void>;
  workspaceSymbols(
    query: string,
    options?: ManagedAdapterRequestOptions,
  ): Promise<BoundedAdapterResult<SymbolInput>>;
  documentSymbols(
    path: string,
    options?: ManagedAdapterRequestOptions,
  ): Promise<BoundedAdapterResult<SymbolInput>>;
  definition(
    location: RepositoryLocation,
    options?: ManagedAdapterRequestOptions,
  ): Promise<BoundedAdapterResult<RepositoryLocation>>;
  references(
    location: RepositoryLocation,
    options?: ManagedAdapterRequestOptions,
  ): Promise<BoundedAdapterResult<RepositoryLocation>>;
  diagnostics(
    path: string | undefined,
    options?: ManagedAdapterRequestOptions,
  ): Promise<BoundedAdapterResult<RepositoryDiagnostic>>;
}

export interface ManagedRepositoryAdapterFactory {
  create(): ManagedRepositoryAdapter;
}

/** LSP-specific naming aliases for adapters implementing the managed boundary. */
export interface ManagedLspAdapter extends ManagedRepositoryAdapter {}
export interface ManagedLspAdapterFactory {
  create(): ManagedLspAdapter;
}

// ---------------------------------------------------------------------------
// Stable identities and normalization helpers
// ---------------------------------------------------------------------------

export function normalizeRepositoryPath(input: string): string {
  if (input.includes("\0")) throw new Error("repository path must not contain NUL");
  let path = input.replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/{2,}/g, "/");
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`repository path must be workspace-relative: ${input}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    throw new Error(`repository path escapes or is not canonical: ${input}`);
  }
  return segments.filter((segment) => segment !== ".").join("/");
}

export function repositoryFileNodeId(path: string): string {
  return `file:${normalizeRepositoryPath(path)}`;
}

export function repositorySymbolNodeId(symbolId: string): string {
  return `symbol:${symbolId}`;
}

export function repositorySymbolId(
  path: string,
  name: string,
  kind: RepositorySymbolKind,
  startLine: number,
  startColumn = 0,
): string {
  return `${normalizeRepositoryPath(path)}#${kind}:${name}@${startLine}:${startColumn}`;
}

export function repositoryEdgeId(
  from: string,
  kind: RepositoryEdgeKind,
  to: string,
  source: RepositoryEdgeSource = "manual",
): string {
  return `edge:${encodeURIComponent(from)}:${kind}:${encodeURIComponent(to)}:${source}`;
}

/** Public tokenizer primarily for deterministic fixture/eval inspection. */
export function tokenizeLexicalText(text: string): readonly string[] {
  const normalized = text.normalize("NFKC");
  const chunks = normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    const folded = chunk.toLocaleLowerCase("en-US");
    if (folded.length > 0) tokens.push(folded);
    const camelParts = chunk
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
      .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
      .split(" ");
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        const token = part.toLocaleLowerCase("en-US");
        if (token.length > 0) tokens.push(token);
      }
    }
  }
  return tokens;
}

function normalizeSymbolRange(range: SymbolRange): SymbolRange {
  if (!Number.isInteger(range.startLine) || range.startLine < 1) {
    throw new RangeError("symbol range startLine must be a positive integer");
  }
  if (!Number.isInteger(range.endLine) || range.endLine < range.startLine) {
    throw new RangeError("symbol range endLine must be at or after startLine");
  }
  if (
    range.startColumn !== undefined &&
    (!Number.isInteger(range.startColumn) || range.startColumn < 0)
  ) {
    throw new RangeError("symbol range startColumn must be a non-negative integer");
  }
  if (
    range.endColumn !== undefined &&
    (!Number.isInteger(range.endColumn) || range.endColumn < 0)
  ) {
    throw new RangeError("symbol range endColumn must be a non-negative integer");
  }
  return {
    startLine: range.startLine,
    endLine: range.endLine,
    ...(range.startColumn === undefined ? {} : { startColumn: range.startColumn }),
    ...(range.endColumn === undefined ? {} : { endColumn: range.endColumn }),
  };
}

function defaultEdgeConfidence(source: RepositoryEdgeSource): number {
  switch (source) {
    case "lsp":
    case "parser":
    case "git":
    case "runtime":
      return 1;
    case "manual":
      return 0.8;
    case "inferred":
      return 0.5;
  }
}

function confidenceValue(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("confidence must be finite and between zero and one");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new RangeError("bound must be finite");
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function lexicalKindRank(kind: LexicalDocumentKind): number {
  switch (kind) {
    case "symbol":
      return 0;
    case "file":
      return 1;
    case "diagnostic":
      return 2;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSymbols(left: SymbolRecord, right: SymbolRecord): number {
  return (
    compareText(left.path, right.path) ||
    left.range.startLine - right.range.startLine ||
    (left.range.startColumn ?? 0) - (right.range.startColumn ?? 0) ||
    compareText(left.name, right.name) ||
    compareText(left.id, right.id)
  );
}

function compareEdges(left: RepositoryGraphEdge, right: RepositoryGraphEdge): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.from, right.from) ||
    compareText(left.to, right.to) ||
    compareText(left.id, right.id)
  );
}

function addToSetMap<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function inferFileNodeKind(
  path: string,
): Extract<RepositoryNodeKind, "file" | "module" | "test" | "config"> {
  const lower = path.toLocaleLowerCase("en-US");
  if (
    /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(lower) ||
    /(?:\.|_|-)(?:test|spec)\.[^/]+$/.test(lower) ||
    /(^|\/)test_[^/]+\.py$/.test(lower)
  ) {
    return "test";
  }
  if (
    /(^|\/)(config|configs|\.config)(\/|$)/.test(lower) ||
    /(?:^|\/)(?:tsconfig|package|cargo|pyproject|go\.mod|makefile)(?:\.|$)/.test(lower) ||
    /\.(?:toml|ya?ml|ini)$/.test(lower)
  ) {
    return "config";
  }
  return "file";
}

function lexicalFileDocumentId(path: string): string {
  return `lex:file:${path}`;
}

function lexicalSymbolDocumentId(symbolId: string): string {
  return `lex:symbol:${symbolId}`;
}

function expectedSymbolKey(expected: string | ExpectedSymbol): string {
  if (typeof expected === "string") return expected;
  if (expected.id !== undefined) return expected.id;
  const path = expected.path === undefined ? "*" : normalizeRepositoryPath(expected.path);
  return `${path}#${expected.name ?? "*"}`;
}

function localizationCandidateSymbolKey(candidate: LocalizationCandidate): string | undefined {
  if (candidate.symbolId !== undefined) return candidate.symbolId;
  if (candidate.symbol !== undefined) {
    return `${normalizeRepositoryPath(candidate.path)}#${candidate.symbol}`;
  }
  return undefined;
}

function matchesExpectedSymbol(
  candidate: LocalizationCandidate,
  expected: string | ExpectedSymbol,
): boolean {
  if (typeof expected === "string") {
    return candidate.symbolId === expected || candidate.symbol === expected;
  }
  if (expected.id !== undefined && candidate.symbolId !== expected.id) return false;
  if (expected.name !== undefined && candidate.symbol !== expected.name) return false;
  if (
    expected.path !== undefined &&
    normalizeRepositoryPath(candidate.path) !== normalizeRepositoryPath(expected.path)
  ) {
    return false;
  }
  return expected.id !== undefined || expected.name !== undefined || expected.path !== undefined;
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
