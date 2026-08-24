import { describe, expect, test } from "bun:test";

import {
  dispatchBeforeHooks,
  sortBeforeHooks,
  type EffectivePluginOperation,
  type RegisteredBeforeHook,
} from "../src/index.ts";

function operation(): EffectivePluginOperation {
  return {
    workspaceRead: ["src/**"],
    workspaceWrite: ["src/**"],
    credentialScopes: [],
    toolIds: ["fs.read", "fs.edit"],
    contextCandidateIds: ["ctx_a"],
    network: "allow",
    timeoutMs: 5_000,
    outputBytes: 8_192,
    maxNodes: 4,
    risk: "R2",
    sandbox: "standard",
  };
}

function hook(
  pluginId: string,
  scope: RegisteredBeforeHook["scope"],
  priority: RegisteredBeforeHook["priority"],
  ordinal: number,
  invoke: RegisteredBeforeHook["invoke"],
): RegisteredBeforeHook {
  return { pluginId, scope, priority, hook: "before.tool", ordinal, invoke };
}

describe("plugin before-hook dispatcher", () => {
  test("orders builtin, critical, and ordinary hooks deterministically", () => {
    const ordered = sortBeforeHooks([
      hook("zeta/project", "project", "ordinary", 1, async () => ({ action: "continue" })),
      hook("alpha/user", "user", "ordinary", 5, async () => ({ action: "continue" })),
      hook("zeta/user", "user", "critical", 2, async () => ({ action: "continue" })),
      hook("alpha/builtin", "builtin", "ordinary", 9, async () => ({ action: "continue" })),
      hook("alpha/project", "project", "critical", 1, async () => ({ action: "continue" })),
      hook("alpha/user", "user", "ordinary", 1, async () => ({ action: "continue" })),
    ]);

    expect(ordered.map((registration) => registration.pluginId + ":" + String(registration.ordinal))).toEqual([
      "alpha/builtin:9",
      "zeta/user:2",
      "alpha/project:1",
      "alpha/user:1",
      "alpha/user:5",
      "zeta/project:1",
    ]);
  });

  test("preserves a critical ask after deterministic narrowing", async () => {
    const calls: string[] = [];
    const result = await dispatchBeforeHooks([
      hook("alpha/builtin", "builtin", "critical", 0, async () => {
        calls.push("builtin");
        return {
          action: "narrow",
          reason: "network needs review",
          constraints: { network: "ask", toolIds: ["fs.read"] },
        };
      }),
      hook("gamma/project", "project", "critical", 0, async () => {
        calls.push("critical");
        return { action: "ask", reason: "destructive review", riskFloor: "R4" };
      }),
      hook("omega/project", "project", "ordinary", 0, async () => {
        calls.push("late");
        return { action: "continue" };
      }),
    ], {
      invocationId: "inv_1",
      operation: operation(),
    });

    expect(calls).toEqual(["builtin", "critical"]);
    expect(result).toMatchObject({
      action: "ask",
      riskFloor: "R4",
      effective: { network: "ask", toolIds: ["fs.read"], risk: "R4" },
      warnings: [],
      trace: [
        { pluginId: "alpha/builtin", status: "narrowed" },
        { pluginId: "gamma/project", status: "asked" },
      ],
    });
  });

  test("warns and continues after an ordinary hook attempts to widen authority", async () => {
    const calls: string[] = [];
    const result = await dispatchBeforeHooks([
      hook("beta/user", "user", "ordinary", 0, async () => {
        calls.push("ordinary");
        return {
          action: "narrow",
          reason: "attempted widening",
          constraints: { toolIds: ["new-tool"] },
        };
      }),
      hook("omega/project", "project", "ordinary", 0, async () => {
        calls.push("late");
        return { action: "continue" };
      }),
    ], {
      invocationId: "inv_ordinary_narrow",
      operation: operation(),
    });

    expect(calls).toEqual(["ordinary", "late"]);
    expect(result).toMatchObject({
      action: "continue",
      warnings: [{ pluginId: "beta/user", code: "PLUGIN_AUTHORITY_ESCALATION" }],
      trace: [
        { pluginId: "beta/user", status: "failed" },
        { pluginId: "omega/project", status: "continued" },
      ],
    });
  });

  test("fails closed for critical protocol errors while ordinary errors are fail-open by default", async () => {
    const ordinary = await dispatchBeforeHooks([
      hook("alpha/user", "user", "ordinary", 0, async () => {
        throw new Error("plugin crashed");
      }),
      hook("beta/user", "user", "ordinary", 0, async () => ({ action: "continue" })),
    ], {
      invocationId: "inv_ordinary",
      operation: operation(),
    });
    expect(ordinary).toMatchObject({
      action: "continue",
      warnings: [{ pluginId: "alpha/user", code: "PLUGIN_PROTOCOL_ERROR" }],
    });

    const critical = await dispatchBeforeHooks([
      hook("alpha/user", "user", "critical", 0, async () => ({ action: "unexpected" })),
      hook("beta/user", "user", "ordinary", 0, async () => ({ action: "continue" })),
    ], {
      invocationId: "inv_critical",
      operation: operation(),
    });
    expect(critical).toMatchObject({
      action: "deny",
      reason: "a required plugin hook could not complete safely",
      trace: [{ pluginId: "alpha/user", status: "failed" }],
    });
  });
});
