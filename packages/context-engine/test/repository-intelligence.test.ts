import { describe, expect, test } from "bun:test";

import {
  HeterogeneousRepositoryGraph,
  InMemoryLexicalIndex,
  RepositoryIntelligence,
  createSymbolRangeCandidate,
  evaluateLocalization,
  repositoryFileNodeId,
  repositorySymbolNodeId,
  type ManagedRepositoryAdapter,
  type SymbolInput,
} from "../src/repository-intelligence.ts";

function symbol(
  path: string,
  name: string,
  startLine: number,
  endLine: number,
  overrides: Partial<SymbolInput> = {},
): SymbolInput {
  return {
    path,
    name,
    kind: "function",
    range: { startLine, endLine },
    ...overrides,
  };
}

describe("P2 repository intelligence", () => {
  test("the lexical index is weighted, camel-aware, and insertion-order deterministic", () => {
    const documents = [
      {
        id: "file:z",
        kind: "file" as const,
        path: "src/unrelated.ts",
        fields: { content: "ConfigLoader appears once in prose" },
      },
      {
        id: "symbol:a",
        kind: "symbol" as const,
        path: "src/config-loader.ts",
        symbolId: "ConfigLoader",
        fields: { symbol: "ConfigLoader", signature: "class ConfigLoader" },
      },
    ];
    const forward = new InMemoryLexicalIndex();
    const reverse = new InMemoryLexicalIndex();
    for (const document of documents) forward.upsert(document);
    for (const document of [...documents].reverse()) reverse.upsert(document);

    const first = forward.search("config loader");
    expect(first.map((hit) => hit.id)).toEqual(reverse.search("config loader").map((hit) => hit.id));
    expect(first[0]?.id).toBe("symbol:a");
    expect(first[0]?.matchedFields).toContain("symbol");
  });

  test("symbol records keep exact ranges and materialize bounded signature spans", () => {
    const intelligence = new RepositoryIntelligence();
    intelligence.upsertFile({
      path: "src/service.ts",
      checksum: "abc123",
      text: Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"),
    });
    const record = intelligence.upsertSymbol(
      symbol("src/service.ts", "loadEffectiveConfig", 20, 50, {
        id: "load-config",
        signatureRange: { startLine: 18, endLine: 21 },
        signature: "export function loadEffectiveConfig(): Config",
        source: "lsp",
      }),
    );

    expect(record.range).toEqual({ startLine: 20, endLine: 50 });
    expect(
      createSymbolRangeCandidate(record, {
        resolution: "signature",
        contextLines: 10,
        totalLines: 25,
      }),
    ).toMatchObject({
      path: "src/service.ts",
      symbolId: "load-config",
      startLine: 8,
      endLine: 25,
      resolution: "signature",
    });
  });

  test("heterogeneous structural expansion is deterministic and hard-bounded to two hops", () => {
    const graph = new HeterogeneousRepositoryGraph();
    for (const node of [
      { id: "symbol:entry", kind: "symbol" as const, label: "entry" },
      { id: "symbol:middle", kind: "symbol" as const, label: "middle" },
      { id: "test:entry", kind: "test" as const, label: "entry test" },
      { id: "config:flags", kind: "config" as const, label: "flags" },
    ]) {
      graph.upsertNode(node);
    }
    graph.upsertEdge({ from: "symbol:entry", to: "symbol:middle", kind: "calls", source: "lsp" });
    graph.upsertEdge({ from: "test:entry", to: "symbol:entry", kind: "tests", source: "parser" });
    graph.upsertEdge({ from: "symbol:middle", to: "config:flags", kind: "configures", source: "inferred" });

    expect(graph.expand(["symbol:entry"], { hops: 1 }).nodes.map((hit) => hit.node.id)).toEqual([
      "symbol:entry",
      "symbol:middle",
      "test:entry",
    ]);
    const twoHop = graph.expand(["symbol:entry"], { hops: 2 });
    expect(twoHop.nodes.find((hit) => hit.node.id === "config:flags")?.hop).toBe(2);
    expect(() => graph.expand(["symbol:entry"], { hops: 3 as 2 })).toThrow("one or two hops");
    expect(graph.expand(["symbol:entry"], { hops: 2, maxNodes: 2 }).truncated).toBe(true);
  });

  test("retrieval combines lexical seeds, graph neighbors, and symbol ranges", () => {
    const intelligence = new RepositoryIntelligence();
    intelligence.upsertFile({ path: "src/api.ts", text: "handleRequest routes incoming requests" });
    intelligence.upsertFile({ path: "src/auth.ts", text: "permission enforcement" });
    intelligence.upsertFile({ path: "test/api.test.ts", text: "authentication regression" });
    const handler = intelligence.upsertSymbol(symbol("src/api.ts", "handleRequest", 10, 25, { id: "handler" }));
    const authorize = intelligence.upsertSymbol(symbol("src/auth.ts", "authorize", 30, 45, { id: "authorize" }));
    const regression = intelligence.upsertSymbol(symbol("test/api.test.ts", "rejectsGuests", 5, 12, { id: "regression" }));
    intelligence.upsertEdge({
      from: repositorySymbolNodeId(handler.id),
      to: repositorySymbolNodeId(authorize.id),
      kind: "calls",
      source: "lsp",
    });
    intelligence.upsertEdge({
      from: repositorySymbolNodeId(regression.id),
      to: repositorySymbolNodeId(handler.id),
      kind: "tests",
      source: "parser",
    });

    const result = intelligence.retrieve({
      query: "handle request",
      hops: 1,
      edgeKinds: ["calls", "tests"],
      maxRangeCandidates: 10,
    });
    expect(result.lexicalHits[0]?.symbolId).toBe("handler");
    expect(result.structural.nodes.map((hit) => hit.node.id)).toContain(repositorySymbolNodeId(authorize.id));
    expect(result.structural.nodes.map((hit) => hit.node.id)).toContain(repositorySymbolNodeId(regression.id));
    expect(result.rangeCandidates.map((candidate) => candidate.symbolId)).toEqual(
      expect.arrayContaining(["handler", "authorize", "regression"]),
    );
    expect(result.rangeCandidates.find((candidate) => candidate.symbolId === "authorize")?.startLine).toBe(30);
  });

  test("edge-kind and confidence filters exclude unrelated inferred neighbors", () => {
    const intelligence = new RepositoryIntelligence();
    intelligence.upsertFile({ path: "src/a.ts" });
    intelligence.upsertFile({ path: "src/b.ts" });
    const a = intelligence.upsertSymbol(symbol("src/a.ts", "a", 1, 2, { id: "a" }));
    const b = intelligence.upsertSymbol(symbol("src/b.ts", "b", 1, 2, { id: "b" }));
    intelligence.upsertEdge({
      from: repositorySymbolNodeId(a.id),
      to: repositorySymbolNodeId(b.id),
      kind: "changed_with",
      source: "inferred",
      confidence: 0.4,
    });

    const result = intelligence.graph.expand([repositorySymbolNodeId(a.id)], {
      hops: 1,
      edgeKinds: ["changed_with"],
      minConfidence: 0.5,
    });
    expect(result.nodes.map((hit) => hit.node.id)).toEqual([repositorySymbolNodeId(a.id)]);
  });

  test("file and symbol localization metrics report recall and precision at k", () => {
    const metrics = evaluateLocalization(
      [
        { path: "src/api.ts", symbolId: "handler", symbol: "handleRequest" },
        { path: "src/noise.ts", symbolId: "noise", symbol: "noise" },
        { path: "src/auth.ts", symbolId: "authorize", symbol: "authorize" },
      ],
      {
        expectedFiles: ["src/api.ts", "src/auth.ts"],
        expectedSymbols: ["handler", { path: "src/auth.ts", name: "authorize" }],
      },
      2,
    );

    expect(metrics.fileRecall).toBe(0.5);
    expect(metrics.symbolRecall).toBe(0.5);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.expectedFileHits).toEqual(["src/api.ts"]);
  });

  test("file removal clears symbol and graph state without touching external services", () => {
    const intelligence = new RepositoryIntelligence();
    intelligence.upsertFile({ path: "src/old.ts", text: "obsoleteSymbol" });
    intelligence.upsertSymbol(symbol("src/old.ts", "obsoleteSymbol", 1, 3, { id: "obsolete" }));
    expect(intelligence.removeFile("src\\old.ts")).toBe(true);
    expect(intelligence.search("obsoleteSymbol")).toHaveLength(0);
    expect(intelligence.graph.getNode(repositoryFileNodeId("src/old.ts"))).toBeUndefined();
    expect(intelligence.getSymbol("obsolete")).toBeUndefined();
  });

  test("the future managed adapter boundary is structural and optional", () => {
    // A compile-time assertion: the in-memory implementation does not require an
    // adapter, while an LSP implementation can satisfy this lifecycle later.
    const acceptsAdapter = (_adapter: ManagedRepositoryAdapter): boolean => true;
    expect(typeof acceptsAdapter).toBe("function");
    expect(new RepositoryIntelligence().fileCount).toBe(0);
  });
});
