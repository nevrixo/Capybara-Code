/**
 * Action-group permission classification — PRD §6.5.
 *
 * §6.5 allows a facade over the detailed tools on one condition: "내부 tool ID와
 * permission classifier는 유지한다. 상위 tool은 권한을 합치거나 우회하지 않고,
 * 적절한 기존 도구 호출을 만드는 facade다." These tests are that condition. Each
 * one compares the group-mediated call against the direct call it stands for,
 * and the only acceptable answer is "identical".
 */

import { describe, expect, test } from "bun:test";

import { NATIVE_TOOLS, nativeToolsForFeatures, type RiskClass } from "@cbc/tool-registry";

import {
  actionHash,
  assessRisk,
  deriveActionTraits,
  evaluate,
  resolveActionTarget,
  type PermissionContext,
  type ProposedAction,
} from "../src/index.ts";

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    mode: "auto-review",
    trust: "trusted-always",
    rules: [],
    catalog: NATIVE_TOOLS,
    agentRole: "root",
    nonInteractive: false,
    configPermissions: {
      shell: "safe-auto",
      network: "ask",
      destructive: "ask",
      credentials: "deny",
      externalSideEffect: "ask",
    },
    ...overrides,
  };
}

function baselineRiskOf(toolId: string): RiskClass {
  const tool = NATIVE_TOOLS.find((entry) => entry.id === toolId);
  if (tool === undefined) throw new Error(`missing catalog tool '${toolId}'`);
  return tool.defaultRisk;
}

function direct(toolId: string, args: Record<string, unknown>, extra: Partial<ProposedAction> = {}): ProposedAction {
  return { callId: "c1", toolId, arguments: args, display: toolId, ...extra };
}

function grouped(
  group: string,
  toolId: string,
  args: Record<string, unknown>,
  extra: Partial<ProposedAction> = {},
): ProposedAction {
  return {
    callId: "c1",
    toolId: group,
    arguments: { tool: toolId, arguments: args },
    display: toolId,
    ...extra,
  };
}

describe("action groups are classified by their expanded tool (§6.5)", () => {
  test("a change group call carries the writer tool's exact risk", () => {
    const args = { path: "src/a.ts", content: "x", expectedHash: "deadbeef" };
    const viaGroup = assessRisk(grouped("change", "fs.write", args), NATIVE_TOOLS);
    const viaDirect = assessRisk(direct("fs.write", args, { writes: ["src/a.ts"] }), NATIVE_TOOLS);
    const viaGroupWithWrites = assessRisk(
      grouped("change", "fs.write", args, { writes: ["src/a.ts"] }),
      NATIVE_TOOLS,
    );
    expect(viaGroupWithWrites.risk).toBe(viaDirect.risk);
    // Not the R3 unknown-tool default, and not a merged group risk.
    expect(viaGroup.risk).toBe(baselineRiskOf("fs.write"));
    expect(viaGroup.risk).not.toBe("R3");
  });

  test("no group collapses two different risk classes into one", () => {
    // Both live in `change`; if the group carried the permission, these would be
    // indistinguishable and one grant would cover both.
    const patch = assessRisk(grouped("change", "fs.apply_patch", { path: "a.ts" }), NATIVE_TOOLS);
    const remove = assessRisk(grouped("change", "fs.delete", { path: "a.ts" }), NATIVE_TOOLS);
    expect(patch.risk).toBe(baselineRiskOf("fs.apply_patch"));
    expect(remove.risk).toBe(baselineRiskOf("fs.delete"));
    expect(patch.risk).not.toBe(remove.risk);
  });

  test("the classifier still sees a group-mediated command", () => {
    const command = { program: "git", args: ["reset", "--hard", "HEAD~1"], cwd: "/repo" };
    const viaGroup = assessRisk(
      grouped("verify", "process.run", { program: "git", args: command.args }, { command }),
      NATIVE_TOOLS,
    );
    const viaDirect = assessRisk(
      direct("process.run", { program: "git", args: command.args }, { command }),
      NATIVE_TOOLS,
    );
    expect(viaGroup.risk).toBe(viaDirect.risk);
    expect(viaGroup.classification?.destructive).toBe(viaDirect.classification?.destructive);
    expect(viaGroup.reasons).toEqual(viaDirect.reasons);
  });

  test("traits and the whole decision match the direct call", () => {
    const command = { program: "npm", args: ["install", "sharp"], cwd: "/repo" };
    const args = { program: "npm", args: command.args };
    const groupTraits = deriveActionTraits(grouped("verify", "process.run", args, { command }), NATIVE_TOOLS);
    const directTraits = deriveActionTraits(direct("process.run", args, { command }), NATIVE_TOOLS);
    expect(groupTraits).toEqual(directTraits);

    const groupDecision = evaluate(grouped("verify", "process.run", args, { command }), context());
    const directDecision = evaluate(direct("process.run", args, { command }), context());
    expect(groupDecision.kind).toBe(directDecision.kind);
    if (groupDecision.kind === "ask" && directDecision.kind === "ask") {
      // The approval card, the persisted rule, and the audit hash must all name
      // process.run — the user cannot be asked to approve "verify".
      expect(groupDecision.request.riskClass).toBe(directDecision.request.riskClass);
      expect(groupDecision.request.actionHash).toBe(directDecision.request.actionHash);
      expect(groupDecision.request.ruleCandidate).toEqual(directDecision.request.ruleCandidate);
      expect(JSON.stringify(groupDecision.request)).not.toContain("verify");
    }
  });

  test("the audit hash of a group call is the hash of the internal call", () => {
    const args = { path: "src/a.ts", content: "x", expectedHash: "deadbeef" };
    const expanded = resolveActionTarget(grouped("change", "fs.write", args), NATIVE_TOOLS);
    expect(expanded.kind).toBe("expanded");
    if (expanded.kind !== "expanded") return;
    // PERM-006's hash covers the normalized operation; a facade must not create
    // a second identity for the same operation.
    expect(actionHash(expanded.action)).toBe(actionHash(direct("fs.write", args)));
    expect(expanded.action.toolId).toBe("fs.write");
  });

  test("an unresolvable group is refused, never defaulted to something permissive", () => {
    for (const bad of [
      grouped("change", "fs.nonexistent", {}),
      grouped("change", "fs.read", {}),
      { callId: "c1", toolId: "change", arguments: {}, display: "change" } satisfies ProposedAction,
      { callId: "c1", toolId: "change", arguments: { tool: 7 }, display: "change" } satisfies ProposedAction,
    ]) {
      const resolved = resolveActionTarget(bad, NATIVE_TOOLS);
      expect(resolved.kind).toBe("refused");
      // R6 rather than the R3 unknown-tool baseline: an unresolvable facade must
      // be the least permissive way to ask, not the most.
      expect(assessRisk(bad, NATIVE_TOOLS).risk).toBe("R6");
      expect(evaluate(bad, context()).kind).toBe("deny");
      // Even the most permissive preset denies it.
      expect(evaluate(bad, context({ preset: "yolo" })).kind).toBe("deny");
    }
  });

  test("a group cannot reach a tool the session's catalog withheld", () => {
    // fs.edit exists in NATIVE_TOOLS but not in a default-gated catalog. Calling
    // it through `change` must be refused rather than admitted by the group.
    const gated = nativeToolsForFeatures();
    const call = grouped("change", "fs.edit", { path: "a.ts" });
    expect(gated.some((tool) => tool.id === "fs.edit")).toBe(false);
    expect(resolveActionTarget(call, gated).kind).toBe("refused");
    expect(evaluate(call, context({ catalog: gated })).kind).toBe("deny");
    // With the gate on, the same call resolves and is classified as fs.edit.
    const enabled = nativeToolsForFeatures({ editEngineV2: true });
    const resolved = resolveActionTarget(call, enabled);
    expect(resolved.kind).toBe("expanded");
    if (resolved.kind === "expanded") expect(resolved.action.toolId).toBe("fs.edit");
  });

  test("read-only and untrusted boundaries still bind through a group", () => {
    const write = grouped("change", "fs.write", { path: "a.ts", content: "x", expectedHash: "d" }, {
      writes: ["a.ts"],
    });
    expect(evaluate(write, context({ readOnly: true })).kind).toBe("deny");
    const run = grouped("verify", "process.run", { program: "ls", args: [] }, {
      command: { program: "ls", args: [], cwd: "/repo" },
    });
    expect(evaluate(run, context({ trust: "untrusted" })).kind).toBe("deny");
  });

  test("a group call to a credential path is denied exactly as the direct call is", () => {
    const args = { path: ".env", content: "TOKEN=1", expectedHash: "d" };
    const viaGroup = evaluate(grouped("change", "fs.write", args, { writes: [".env"] }), context());
    const viaDirect = evaluate(direct("fs.write", args, { writes: [".env"] }), context());
    expect(viaGroup.kind).toBe("deny");
    expect(viaGroup).toEqual(viaDirect);
  });

  test("a direct internal call is untouched by the group resolution path", () => {
    const resolved = resolveActionTarget(direct("fs.read", { path: "a.ts" }), NATIVE_TOOLS);
    expect(resolved.kind).toBe("direct");
    if (resolved.kind === "direct") expect(resolved.action.toolId).toBe("fs.read");
  });
});
