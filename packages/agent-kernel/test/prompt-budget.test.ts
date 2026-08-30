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

import {
  NATIVE_TOOLS,
  RISK_DESCRIPTIONS,
  ToolRegistry,
  allowsBroadRule,
  nativeToolsForFeatures,
  type ToolDefinition,
} from "@cbc/tool-registry";

import { ROOT_POLICY, TOOL_PROTOCOL, assemblePrompt, toModelSchema } from "../src/index.ts";

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
    // Policy text only, no project instructions or skills. Recorded 2026-08 at
    // 5,988 chars; §6.6's mutation-rule de-duplication and the removal of the
    // host risk taxonomy brought it to 4,985. Later passes must move this down,
    // never up.
    expect(assembled.stablePrefixText.length).toBeLessThanOrEqual(4_985);
  });
});

describe("each mutation rule is stated once (§6.6)", () => {
  test("the prompt no longer restates the schema's mutation mechanics", () => {
    const prompt = `${ROOT_POLICY}\n${TOOL_PROTOCOL}`;
    // §6.6 "같은 규칙을 한 번만 명시": intent, the per-tool hash field names, and
    // the patch header form live in the schemas and the failure messages, which
    // the model reads at the moment they apply. Restating them in the prompt cost
    // tokens on every turn to say the same thing a third time.
    for (const restated of ['intent:"create"', "expectedHash", "--- a/path", "+++ b/path", "recursive:true"]) {
      expect(prompt).not.toContain(restated);
    }
  });

  test("the rule itself still survives in one place", () => {
    // Removing the duplication must not remove the rule: the prompt keeps the
    // one fact the model has to know before it picks a tool.
    expect(ROOT_POLICY).toContain("Supply the checksum you read");
    expect(TOOL_PROTOCOL).toContain("checksum fs.read returned");
    expect(TOOL_PROTOCOL).toContain("either applies completely or not at all");
    // The schemas and the recovery message remain the canonical statement of the
    // mechanics, so a model that gets it wrong is still told exactly what to send.
    const patch = NATIVE_TOOLS.find((tool) => tool.id === "fs.apply_patch");
    expect(JSON.stringify(patch?.parameters)).toContain("+++ b/path");
    const write = NATIVE_TOOLS.find((tool) => tool.id === "fs.write");
    expect(JSON.stringify(write?.parameters)).toContain("Required when replacing an existing file");
  });

  test("the prompt still names tool.discover", () => {
    // Not duplication: without the name in the prompt the model can only find
    // the discovery path by first getting a rejection, which §6.6's active-tools
    // -only rule would then make the common case.
    expect(TOOL_PROTOCOL).toContain("tool.discover");
  });
});

describe("host-internal invariants stay out of the prompt (§6.6)", () => {
  test("the R0-R6 taxonomy is not in the model's prompt", () => {
    const prompt = `${ROOT_POLICY}\n${TOOL_PROTOCOL}`;
    // The classes are how the host decides; the model cannot compute them and has
    // no action that depends on knowing which one an action landed in.
    for (const internal of ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "pre-approved in bulk"]) {
      expect(prompt).not.toContain(internal);
    }
  });

  test("the one fact the model acts on survives", () => {
    expect(TOOL_PROTOCOL).toContain("approval for each individual operation");
  });

  test("removing the taxonomy from the prompt changed no host contract", () => {
    // The classifier is unchanged and still resolves by tool: the prompt was
    // never an input to it, which is exactly why the text was removable.
    for (const risk of ["R0", "R1", "R2", "R3", "R4", "R5", "R6"] as const) {
      expect(RISK_DESCRIPTIONS[risk]).toBeTruthy();
    }
    expect(allowsBroadRule("R3")).toBe(true);
    expect(allowsBroadRule("R4")).toBe(false);
    expect(NATIVE_TOOLS.find((tool) => tool.id === "fs.delete")?.maxRisk).toBe("R4");
  });
});
