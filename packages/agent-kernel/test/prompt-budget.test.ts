/**
 * PRD §6.7 — the default tool-schema token budget.
 *
 * §6.7's success criterion is a *measurable decrease* in the tokens the default
 * tool surface costs. `toolTokens` was already computed per request and folded
 * into L1, but nothing recorded what it currently is, so "reduced" was not a
 * claim anyone could check. These baselines are the reference point: a §6.5
 * surface change that lowers them updates the numbers with the measurement in
 * the commit, and one that raises them fails here instead of silently landing.
 */

import { describe, expect, test } from "bun:test";

import { nativeToolsForFeatures, ToolRegistry, type ToolDefinition } from "@cbc/tool-registry";

import { assemblePrompt, toModelSchema } from "../src/index.ts";

/** Every experimental gate on — the widest surface a product session can reach. */
const ALL_GATES = {
  editEngineV2: true,
  durableMemory: true,
  worktreeMultiAgent: true,
  fullLsp: true,
  lspRenamePreview: true,
  lspCodeActionPreview: true,
  lspFormattingPreview: true,
  pluginRuntime: true,
} as const;

function activeSurface(
  features: Parameters<typeof nativeToolsForFeatures>[0],
  mode: "build" | "plan",
): { readonly catalog: number; readonly tools: ToolDefinition[]; readonly chars: number } {
  const catalog = nativeToolsForFeatures(features);
  const registry = new ToolRegistry(catalog);
  const tools = registry.activeToolsFor(mode);
  return { catalog: catalog.length, tools, chars: JSON.stringify(tools.map(toModelSchema)).length };
}

describe("default tool schema budget (§6.7)", () => {
  test("the Build-mode default surface stays within its recorded baseline", () => {
    const measured = activeSurface({}, "build");
    // Recorded 2026-08: 37 catalog / 16 active / 11,724 chars ~ 2.9K tokens.
    expect(measured.catalog).toBe(37);
    expect(measured.tools.length).toBe(16);
    expect(measured.chars).toBeLessThanOrEqual(11_724);
  });

  test("the widest experimental surface stays within its recorded baseline", () => {
    const measured = activeSurface(ALL_GATES, "build");
    // Recorded 2026-08: 66 catalog / 18 active / 14,877 chars ~ 3.7K tokens.
    expect(measured.catalog).toBe(66);
    expect(measured.tools.length).toBe(18);
    expect(measured.chars).toBeLessThanOrEqual(14_877);
  });

  test("Plan mode never costs more than Build mode", () => {
    const build = activeSurface(ALL_GATES, "build");
    const plan = activeSurface(ALL_GATES, "plan");
    // Plan mode is a strict subset, so its schema cost is a lower bound on
    // Build's — a change that inverts this means a Plan-only tool appeared.
    expect(plan.tools.length).toBeLessThan(build.tools.length);
    expect(plan.chars).toBeLessThan(build.chars);
  });

  test("assemblePrompt reports the same tool cost the budget measures", () => {
    const { tools } = activeSurface({}, "build");
    const assembled = assemblePrompt({
      activeTools: tools,
      projectInstructions: [],
      skillCatalog: [],
      loadedSkills: [],
      repositoryContext: [],
      history: [],
    });
    // The budget above is only meaningful if it measures the same serialization
    // the prompt actually bills for.
    expect(JSON.stringify(assembled.tools).length).toBe(activeSurface({}, "build").chars);
    expect(assembled.layerTokens.L1_tool_semantics).toBeGreaterThan(0);
  });

  test("the minimal stable prefix stays within its recorded baseline", () => {
    const assembled = assemblePrompt({
      activeTools: [],
      projectInstructions: [],
      skillCatalog: [],
      loadedSkills: [],
      repositoryContext: [],
      history: [],
    });
    // Policy text only, no project instructions or skills. Recorded 2026-08:
    // 5,988 chars ~ 1,497 tokens. §6.6's de-duplication passes must move this
    // down, never up.
    expect(assembled.stablePrefixText.length).toBeLessThanOrEqual(5_988);
  });
});
