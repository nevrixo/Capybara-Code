/**
 * Action group definitions and resolution — PRD §6.5.
 */

import { describe, expect, test } from "bun:test";

import {
  ACTION_GROUP_IDS,
  ACTION_GROUP_TARGETS,
  NATIVE_TOOLS,
  actionGroupForTool,
  actionGroupTargetsOf,
  actionGroupTools,
  expandActionGroupCall,
  isActionGroupId,
  nativeToolsForFeatures,
} from "../src/index.ts";

describe("action groups (§6.5)", () => {
  test("the five groups partition the whole native catalog", () => {
    expect([...ACTION_GROUP_IDS]).toEqual(["inspect", "change", "verify", "delegate", "remember"]);
    const targets = ACTION_GROUP_IDS.flatMap((group) => [...ACTION_GROUP_TARGETS[group]]);
    // Every catalog tool is reachable through exactly one group, so the group
    // surface can front the whole catalog and no tool becomes unreachable.
    expect([...targets].sort()).toEqual([...new Set(targets)].sort());
    expect(targets.slice().sort()).toEqual(NATIVE_TOOLS.map((tool) => tool.id).sort());
    for (const tool of NATIVE_TOOLS) {
      expect(actionGroupForTool(tool.id)).toBeDefined();
    }
  });

  test("a group call resolves to the internal tool it names", () => {
    const expanded = expandActionGroupCall("change", {
      tool: "fs.write",
      arguments: { path: "src/a.ts", content: "x", expectedHash: "abc" },
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.toolId).toBe("fs.write");
    expect(expanded.group).toBe("change");
    expect(expanded.arguments).toEqual({ path: "src/a.ts", content: "x", expectedHash: "abc" });
  });

  test("expansion refuses rather than defaulting to a tool the model did not name", () => {
    // A missing, wrong-typed, or unknown target is a refusal — never a fallback
    // onto something the group happens to contain.
    for (const args of [{}, { tool: "" }, { tool: 7 }, { tool: "fs.nonexistent" }, [], null, "fs.write"]) {
      const result = expandActionGroupCall("change", args);
      expect(result.ok).toBe(false);
    }
    expect(expandActionGroupCall("everything", { tool: "fs.write" }).ok).toBe(false);
    expect(isActionGroupId("everything")).toBe(false);
  });

  test("a group cannot reach into another group's targets", () => {
    const crossed = expandActionGroupCall("inspect", { tool: "fs.write", arguments: {} });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    // The refusal names the owning group so the model can retry correctly
    // instead of guessing.
    expect(crossed.reason).toContain("change");
    expect(expandActionGroupCall("verify", { tool: "fs.read", arguments: {} }).ok).toBe(false);
    expect(expandActionGroupCall("remember", { tool: "task.spawn", arguments: {} }).ok).toBe(false);
  });

  test("omitted arguments expand to an empty object, not to undefined", () => {
    const expanded = expandActionGroupCall("inspect", { tool: "git.status" });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    // The internal tool's own schema then decides whether that is valid, so
    // required-argument enforcement stays with the tool (§6.5).
    expect(expanded.arguments).toEqual({});
    expect(expandActionGroupCall("inspect", { tool: "git.status", arguments: null }).ok).toBe(false);
  });

  test("a group's declared risk is never lower than the widest tool it fronts", () => {
    const groups = actionGroupTools();
    const change = groups.find((tool) => tool.id === "change");
    const inspect = groups.find((tool) => tool.id === "inspect");
    expect(change?.mutates).toBe(true);
    expect(inspect?.mutates).toBe(false);
    for (const group of groups) {
      for (const targetId of actionGroupTargetsOf(group)) {
        const target = NATIVE_TOOLS.find((tool) => tool.id === targetId);
        expect(target).toBeDefined();
        expect(group.maxRisk >= (target?.maxRisk ?? "R0")).toBe(true);
      }
    }
  });

  test("a group only offers targets the active catalog actually has", () => {
    // Withholding fs.edit behind editEngineV2 must withhold it from change's
    // enum too, or the model is offered a target that cannot run.
    const gated = actionGroupTools(nativeToolsForFeatures());
    const change = gated.find((tool) => tool.id === "change");
    expect(actionGroupTargetsOf(change!)).not.toContain("fs.edit");
    expect(actionGroupTargetsOf(change!)).toContain("fs.apply_patch");

    const enabled = actionGroupTools(nativeToolsForFeatures({ editEngineV2: true }));
    expect(actionGroupTargetsOf(enabled.find((tool) => tool.id === "change")!)).toContain("fs.edit");
    // remember is entirely gated on durableMemory except todo.write, so it must
    // still exist rather than vanish.
    expect(gated.map((tool) => tool.id)).toContain("remember");
  });

  test("group definitions are strict, discoverable, and inactive by default", () => {
    for (const group of actionGroupTools()) {
      expect(group.parameters.additionalProperties).toBe(false);
      expect(group.parameters.required).toEqual(["tool", "arguments"]);
      // §6.6 exposes active tools only; nothing here activates a group. The
      // config gate decides that, so the default surface is unchanged.
      expect(group.alwaysActive).toBe(false);
      expect(group.keywords.length).toBeGreaterThan(0);
      expect(group.description).toContain("under that tool's permissions");
    }
  });

  test("group ids do not collide with any internal tool id", () => {
    // The facade must not shadow a real tool: expansion resolves *to* internal
    // ids, so a group named like one would make the target ambiguous.
    for (const group of ACTION_GROUP_IDS) {
      expect(NATIVE_TOOLS.some((tool) => tool.id === group)).toBe(false);
    }
  });
});
