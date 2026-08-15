/**
 * Tool discovery — PRD §6.9, §12.2, §17.7, AC-09, R-08.
 *
 * §6.9 is explicit that the number shown is a *search rank*, never a model
 * confidence. R-08 warns that discovery must not hide a required tool, so
 * always-active tools are never gated behind a search and the drawer can list
 * the full catalog.
 */

import type { RiskClass, ToolDefinition, ToolSource } from "./catalog.ts";

export interface DiscoveryMatch {
  readonly toolId: string;
  readonly title: string;
  readonly description: string;
  readonly source: ToolSource;
  /** Search rank, not model confidence (§6.9). */
  readonly score: number;
  readonly risks: RiskClass[];
}

export interface ToolDiscoveryResult {
  readonly query: string;
  readonly matches: DiscoveryMatch[];
  readonly activated: string[];
  readonly activeCount: number;
  readonly totalCount: number;
  readonly limit: number;
}

export interface DiscoveryOptions {
  /** §21.4 `tools.activation_limit`, default 10. */
  readonly limit?: number;
  /**
   * Tools already active, so re-discovery does not double-count.
   *
   * Always-active tools are excluded from the budget by the caller: the limit
   * governs how many *discovered* schemas may be added, otherwise the baseline
   * catalog would consume the whole allowance and discovery could never activate
   * anything (R-08).
   */
  readonly alreadyActive?: readonly string[];
  /** Restrict discovery to a permitted subset, e.g. a read-only subagent. */
  readonly permitted?: (tool: ToolDefinition) => boolean;
}

/**
 * Rank the catalog against a natural-language query.
 *
 * Scoring is a deterministic BM25-flavoured keyword match: exact id match, then
 * title, then keyword hits weighted by rarity, then description. Determinism
 * matters because §6.9's ranked tree appears in golden TUI tests.
 */
export function rankTools(
  catalog: readonly ToolDefinition[],
  query: string,
  options: DiscoveryOptions = {},
): DiscoveryMatch[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const permitted = options.permitted ?? (() => true);
  const candidates = catalog.filter(permitted);

  // Document frequency per term, so a term matching every tool contributes little.
  const documentFrequency = new Map<string, number>();
  for (const term of new Set(terms)) {
    let count = 0;
    for (const tool of candidates) {
      if (haystack(tool).some((field) => field.includes(term))) count += 1;
    }
    documentFrequency.set(term, count);
  }

  const total = Math.max(1, candidates.length);
  const scored: DiscoveryMatch[] = [];

  for (const tool of candidates) {
    let score = 0;
    const idTokens = tokenize(tool.id);
    const titleTokens = tokenize(tool.title);
    const keywordTokens = tool.keywords.flatMap((k) => tokenize(k));
    const descriptionTokens = tokenize(tool.description);

    for (const term of terms) {
      const df = documentFrequency.get(term) ?? total;
      // Inverse document frequency: rarer terms discriminate more.
      const idf = Math.log(1 + total / Math.max(1, df));

      if (idTokens.includes(term)) score += 3.2 * idf;
      else if (idTokens.some((t) => t.startsWith(term) && term.length >= 3)) score += 1.6 * idf;

      if (titleTokens.includes(term)) score += 2.4 * idf;
      if (keywordTokens.includes(term)) score += 2.0 * idf;
      else if (keywordTokens.some((t) => t.startsWith(term) && term.length >= 4)) score += 0.9 * idf;
      if (descriptionTokens.includes(term)) score += 0.8 * idf;
    }

    // Slight preference for tools whose whole id appears verbatim in the query.
    if (query.toLowerCase().includes(tool.id.toLowerCase())) score += 2.5;

    if (score > 0) {
      scored.push({
        toolId: tool.id,
        title: tool.title,
        description: tool.description,
        source: tool.source,
        score: Math.round(score * 1000) / 1000,
        risks: riskRange(tool),
      });
    }
  }

  // Deterministic ordering: score desc, then id asc so ties never reorder.
  scored.sort((a, b) => (b.score - a.score) || a.toolId.localeCompare(b.toolId));
  return scored;
}

/** Perform a discovery call and decide which schemas to activate. */
export function discover(
  catalog: readonly ToolDefinition[],
  query: string,
  options: DiscoveryOptions = {},
): ToolDiscoveryResult {
  const limit = options.limit ?? 10;
  const alreadyActive = new Set(options.alreadyActive ?? []);
  const matches = rankTools(catalog, query, options);

  // §6.9: the selected schemas become usable from the next sampling step.
  const activated: string[] = [];
  for (const match of matches) {
    if (activated.length + alreadyActive.size >= limit) break;
    if (alreadyActive.has(match.toolId)) continue;
    activated.push(match.toolId);
  }

  return {
    query,
    matches,
    activated,
    activeCount: alreadyActive.size + activated.length,
    totalCount: catalog.length,
    limit,
  };
}

function riskRange(tool: ToolDefinition): RiskClass[] {
  if (tool.defaultRisk === tool.maxRisk) return [tool.defaultRisk];
  return [tool.defaultRisk, tool.maxRisk];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/u)
    .filter((token) => token.length > 0);
}

function haystack(tool: ToolDefinition): string[] {
  return [
    tool.id.toLowerCase(),
    tool.title.toLowerCase(),
    tool.description.toLowerCase(),
    ...tool.keywords.map((k) => k.toLowerCase()),
  ];
}

/**
 * Render the §6.9 discovery block. Kept here rather than in the TUI package so
 * the plain and OpenTUI renderers agree, and so golden tests can assert the tree
 * without a terminal.
 */
export function renderDiscoveryBlock(
  result: ToolDiscoveryResult,
  options: { topN?: number; icons?: boolean } = {},
): string[] {
  const topN = options.topN ?? 3;
  const icons = options.icons ?? true;
  const shown = result.matches.slice(0, topN);
  const lines: string[] = [
    `${icons ? "✓ " : ""}Tool Discovery: ${result.query}`,
    `│  ${result.matches.length} matches · ${result.activeCount} active · ${result.totalCount} total · limit:${result.limit}`,
  ];
  shown.forEach((match, index) => {
    const last = index === shown.length - 1;
    const connector = last ? "└─" : "├─";
    const continuation = last ? "   " : "│  ";
    lines.push(`${connector} ${match.title.padEnd(11)} score ${match.score.toFixed(3)}`);
    lines.push(`${continuation}${match.description}`);
  });
  if (result.matches.length > topN) {
    lines.push(`   …${result.matches.length - topN} more · press Enter for the full list`);
  }
  return lines;
}
