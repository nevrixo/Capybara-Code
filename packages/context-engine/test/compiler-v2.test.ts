import { describe, expect, test } from "bun:test";

import {
  ContextCompiler,
  compileContext,
  explainContextItem,
} from "../src/compiler.ts";
import type { ContextItem, ContextRequest } from "../src/ir.ts";

const NOW = new Date("2026-01-02T03:04:05.000Z");

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    id: "request-test",
    goal: "Repair ConfigLoader after its failing test",
    phase: "investigate",
    mentionedPaths: ["src/config.ts"],
    mentionedSymbols: [],
    changedPaths: [],
    recentFailureRefs: [],
    budget: {
      modelContextLimit: 400,
      outputReserve: 100,
      hardInputLimit: 250,
      targetInputTokens: 200,
      exactEvidenceFloor: 60,
      explorationCeiling: 80,
    },
    workspaceIdentity: "workspace-a",
    ...overrides,
  };
}

function item(
  id: string,
  text: string,
  overrides: Partial<ContextItem> = {},
): ContextItem {
  return {
    id,
    kind: "file_excerpt",
    authority: "tool",
    trust: "untrusted",
    scope: { workspaceIdentity: "workspace-a", paths: ["src/config.ts"] },
    provenance: {
      source: "runtime",
      locator: id,
      digest: `${id}-digest`,
      observedAt: NOW.toISOString(),
    },
    freshness: { state: "fresh" },
    representation: { resolution: "snippet", exact: true, text },
    estimatedTokens: Math.ceil(text.length / 4),
    dependencies: [],
    utility: {
      relevance: 20,
      coverage: 10,
      novelty: 5,
      recency: 5,
      confidence: 5,
      verificationValue: 5,
      riskPenalty: 0,
    },
    ...overrides,
  };
}

describe("Context Compiler v2 P1", () => {
  test("prepares one deterministic hard-bounded pack with fresh exact evidence", async () => {
    const exact = item("exact-config", "export class ConfigLoader {}", { estimatedTokens: 40 });
    const stale = item("stale-config", "STALE MUST NOT APPEAR", {
      freshness: { state: "stale" },
    });
    const compiler = new ContextCompiler({ items: [exact, stale], now: () => NOW });
    const first = await compiler.prepare(request());
    const second = await compiler.compile(request());

    expect(first.id).toBe(second.id);
    expect(first.manifest.digest).toBe(second.manifest.digest);
    expect(first.estimatedTokens).toBeLessThanOrEqual(250);
    expect(first.exactEvidence.map((segment) => segment.item.id)).toContain("exact-config");
    expect(first.manifest.excluded.find((entry) => entry.id === "stale-config")?.code).toBe("stale_freshness");
    expect(first.manifest.budget.exactEvidenceFloor).toBe(60);
  });

  test("deduplicates exact/semantic content and atomically includes dependency closure", async () => {
    const map = item("map", "Repository map: src/config.ts", {
      kind: "symbol",
      representation: { resolution: "map", exact: false, text: "Repository map: src/config.ts" },
      estimatedTokens: 20,
      scope: { workspaceIdentity: "workspace-a", paths: ["src/config.ts"] },
    });
    const dependent = item("dependent", "export function loadConfig() {}", {
      dependencies: ["map"],
      estimatedTokens: 30,
    });
    const duplicate = item("duplicate", "export function loadConfig() {}", { estimatedTokens: 30 });
    const compiler = new ContextCompiler({ items: [dependent, duplicate, map], now: () => NOW });
    const pack = await compiler.prepare(request());

    expect(pack.manifest.itemIds).toContain("map");
    expect(pack.manifest.itemIds).toContain("dependent");
    expect(pack.manifest.excluded.find((entry) => entry.id === "duplicate")?.code).toMatch(/duplicate/);
    expect(pack.manifest.included.find((entry) => entry.id === "map")?.reasons).toContain("dependency");
    expect(explainContextItem(pack.manifest, "dependent")?.id).toBe("dependent");
  });

  test("dedupes duplicate ids before body dedupe so a replaced representative cannot erase other evidence", async () => {
    const oldText = "old unique exact source function oldVersion";
    const low = item("shared-id", oldText, {
      estimatedTokens: 20,
      utility: { relevance: 1, coverage: 1, novelty: 1, recency: 1, confidence: 1, verificationValue: 1, riskPenalty: 0 },
    });
    const high = item("shared-id", "new unique exact source function newVersion", {
      estimatedTokens: 20,
      utility: { relevance: 100, coverage: 1, novelty: 1, recency: 1, confidence: 1, verificationValue: 1, riskPenalty: 0 },
    });
    const oldPeer = item("old-peer", oldText, { estimatedTokens: 20 });
    const pack = await compileContext(request(), [low, high, oldPeer], { now: () => NOW });
    expect(pack.exactEvidence.find((segment) => segment.item.id === "shared-id")?.text).toContain("newVersion");
    expect(pack.exactEvidence.map((segment) => segment.item.id)).toContain("old-peer");
  });

  test("uses MMR ordering and a bounded exploration ceiling rather than greedy raw relevance", async () => {
    const repeatedA = item("repeat-a", "same config implementation words", {
      kind: "symbol",
      representation: { resolution: "summary", exact: false, text: "same config implementation words" },
      estimatedTokens: 45,
      utility: { relevance: 100, coverage: 1, novelty: 1, recency: 1, confidence: 1, verificationValue: 1, riskPenalty: 0 },
    });
    const repeatedB = item("repeat-b", "same config implementation words", {
      kind: "symbol",
      representation: { resolution: "summary", exact: false, text: "same config implementation words" },
      estimatedTokens: 45,
      utility: { relevance: 99, coverage: 1, novelty: 1, recency: 1, confidence: 1, verificationValue: 1, riskPenalty: 0 },
    });
    const diverse = item("diverse", "consumer call site dependency boundary", {
      kind: "symbol",
      representation: { resolution: "summary", exact: false, text: "consumer call site dependency boundary" },
      estimatedTokens: 45,
      utility: { relevance: 75, coverage: 40, novelty: 20, recency: 1, confidence: 1, verificationValue: 1, riskPenalty: 0 },
    });
    const pack = await compileContext(request({
      budget: { ...request().budget, explorationCeiling: 50, exactEvidenceFloor: 0 },
    }), [repeatedA, repeatedB, diverse], { now: () => NOW });
    const selected = pack.workingCode.map((segment) => segment.item.id);
    expect(selected).toContain("diverse");
    expect(selected.filter((id) => id.startsWith("repeat-")).length).toBeLessThanOrEqual(1);
    expect(pack.manifest.excluded.some((entry) => entry.code === "exploration_ceiling" || entry.code === "semantic_duplicate")).toBe(true);
  });

  test("MMR diagnostics count cached similarity work without changing pack identity", async () => {
    const items = [
      item("candidate-a", "config implementation details", { estimatedTokens: 20, scope: { workspaceIdentity: "workspace-a", paths: ["src/a.ts"] } }),
      item("candidate-b", "config consumer boundary", { estimatedTokens: 20, scope: { workspaceIdentity: "workspace-a", paths: ["src/b.ts"] } }),
      item("candidate-c", "config verification behavior", { estimatedTokens: 20, scope: { workspaceIdentity: "workspace-a", paths: ["src/c.ts"] } }),
    ];
    const compiler = new ContextCompiler({
      items,
      now: () => NOW,
      similarityDiagnostics: true,
    });
    const first = await compiler.prepareSample(request({
      budget: { ...request().budget, exactEvidenceFloor: 0 },
    }));
    const second = await compiler.prepareSample(request({
      budget: { ...request().budget, exactEvidenceFloor: 0 },
    }));

    expect(first.pack.id).toBe(second.pack.id);
    expect(first.pack.manifest.digest).toBe(second.pack.manifest.digest);
    expect(first.diagnostics?.mmr.selectionSteps).toBeGreaterThan(0);
    expect(first.diagnostics?.mmr.similarityChecks).toBeGreaterThan(0);
    expect(first.diagnostics?.mmr.redundancyUpdates).toBeGreaterThan(0);

    const withoutDiagnostics = await new ContextCompiler({ items, now: () => NOW }).prepareSample(request());
    expect(withoutDiagnostics.diagnostics).toBeUndefined();
  });

  test("async source and malformed candidates fail closed to a deterministic task-only fallback", async () => {
    const compiler = new ContextCompiler({
      items: async () => { throw new Error("LSP adapter unavailable"); },
      now: () => NOW,
    });
    const pack = await compiler.prepare(request());
    expect(pack.manifest.fallback.used).toBe(true);
    expect(pack.taskState.length).toBe(1);
    expect(pack.taskState[0]?.item.kind).toBe("task");
    expect(pack.estimatedTokens).toBeLessThanOrEqual(250);
  });

  test("workspace mismatch and missing dependencies are explainable exclusions", async () => {
    const foreign = item("foreign", "do not use", {
      scope: { workspaceIdentity: "workspace-b" },
    });
    const missing = item("missing-dependent", "depends on unavailable source", {
      dependencies: ["gone"],
    });
    const pack = await compileContext(request(), [foreign, missing], { now: () => NOW });
    expect(pack.manifest.excluded.find((entry) => entry.id === "foreign")?.code).toBe("workspace_mismatch");
    expect(pack.manifest.excluded.find((entry) => entry.id === "missing-dependent")?.code).toBe("missing_dependency");
    expect(pack.manifest.itemIds).not.toContain("missing-dependent");
  });
  test("explains candidate-cap omissions and fails closed on malformed freshness expiry", async () => {
    const invalidExpiry = item("invalid-expiry", "untrusted body", {
      freshness: { state: "fresh", expiresAt: "not-a-date" },
    });
    const capped = item("capped", "must have an explicit cap explanation");
    const compiler = new ContextCompiler({
      items: [invalidExpiry, capped],
      maxCandidates: 2, // the synthetic task plus invalidExpiry fit; capped does not
      now: () => NOW,
    });
    const pack = await compiler.prepare(request());
    expect(pack.manifest.excluded.find((entry) => entry.id === "invalid-expiry")?.code).toBe("expired");
    expect(pack.manifest.excluded.find((entry) => entry.id === "capped")?.code).toBe("candidate_limit");

    const invalidClock = new ContextCompiler({ now: () => new Date("not-a-date") });
    expect((await invalidClock.prepareSample(request())).preparedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  test("recent dialogue is counted and bounded inside the same hard input ceiling", async () => {
    const compiler = new ContextCompiler({
      items: [item("exact", "small exact body", { estimatedTokens: 20 })],
      recentDialogue: [
        { type: "function_call_output", callId: "old", output: "x".repeat(2_000) },
        { type: "function_call_output", callId: "latest", output: "recent" },
      ],
      now: () => NOW,
    });
    const pack = await compiler.prepare(request({
      budget: { ...request().budget, modelContextLimit: 100, outputReserve: 10, hardInputLimit: 40, targetInputTokens: 35 },
    }));
    expect(pack.estimatedTokens).toBeLessThanOrEqual(40);
    expect(pack.recentDialogue.map((entry) => entry.type === "function_call_output" ? entry.callId : "")).toContain("latest");
    expect(pack.recentDialogue.map((entry) => entry.type === "function_call_output" ? entry.callId : "")).not.toContain("old");
  });

});
