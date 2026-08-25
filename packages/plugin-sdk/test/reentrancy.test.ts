import { describe, expect, test } from "bun:test";

import {
  PluginReentrancyError,
  PluginReentrancyGuard,
} from "../src/index.ts";

const PLUGIN_ID = "acme/guard";

function root(
  guard: PluginReentrancyGuard,
  hook: "before.tool" | "before.turn" | "after.tool" = "before.turn",
  toolCallBudget = 3,
) {
  return guard.begin({
    invocationId: "inv_root",
    rootOperationId: "operation_root",
    pluginId: PLUGIN_ID,
    hook,
    toolCallBudget,
  });
}

describe("PluginReentrancyGuard", () => {
  test("carries deterministic ancestry and preserves the root operation", () => {
    const guard = new PluginReentrancyGuard({ maxDepth: 2 });
    const admitted = guard.admitToolCall(root(guard), {
      toolId: "fs.read",
      sideEffect: "read",
    });
    const nested = guard.enterNestedHook(admitted, {
      invocationId: "inv_nested",
      pluginId: "acme/observer",
      hook: "after.tool",
    });

    expect(admitted.toolCallBudget).toBe(2);
    expect(nested).toEqual({
      invocationId: "inv_nested",
      rootOperationId: "operation_root",
      depth: 1,
      visitedPluginHooks: [
        "acme/guard#before.turn",
        "acme/observer#after.tool",
      ],
      toolCallBudget: 2,
      activePluginHook: {
        pluginId: "acme/observer",
        hook: "after.tool",
      },
    });
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.visitedPluginHooks)).toBe(true);
  });

  test("blocks same-hook cycles and a third nested level by default", () => {
    const guard = new PluginReentrancyGuard();
    const first = guard.enterNestedHook(root(guard), {
      invocationId: "inv_one",
      pluginId: "acme/one",
      hook: "before.turn",
    });
    const second = guard.enterNestedHook(first, {
      invocationId: "inv_two",
      pluginId: "acme/two",
      hook: "before.turn",
    });

    expect(() => guard.enterNestedHook(second, {
      invocationId: "inv_three",
      pluginId: "acme/three",
      hook: "before.turn",
    })).toThrow("depth limit");
    expect(() => guard.enterNestedHook(root(guard), {
      invocationId: "inv_cycle",
      pluginId: PLUGIN_ID,
      hook: "before.turn",
    })).toThrow("cannot re-enter");
  });

  test("limits before.tool and observation hooks to read-only host tools", () => {
    const guard = new PluginReentrancyGuard();
    const beforeTool = root(guard, "before.tool");
    expect(() => guard.admitToolCall(beforeTool, {
      toolId: "fs.write",
      sideEffect: "write",
    })).toThrow(PluginReentrancyError);
    expect(guard.admitToolCall(beforeTool, {
      toolId: "fs.read",
      sideEffect: "read",
    }).toolCallBudget).toBe(2);

    const observation = root(guard, "after.tool");
    expect(() => guard.admitToolCall(observation, {
      toolId: "process.run",
      sideEffect: "external",
    })).toThrow("read-only");
  });

  test("enforces the bounded tool-call budget and rejects malformed context", () => {
    const guard = new PluginReentrancyGuard({ toolCallBudget: 1 });
    const exhausted = guard.admitToolCall(root(guard, "before.turn", 1), {
      toolId: "fs.read",
      sideEffect: "read",
    });
    expect(() => guard.admitToolCall(exhausted, {
      toolId: "fs.read",
      sideEffect: "read",
    })).toThrow("budget");

    const malformed = {
      ...root(guard),
      depth: 1,
      visitedPluginHooks: ["acme/guard#before.turn"],
    };
    expect(() => guard.admitToolCall(malformed, {
      toolId: "fs.read",
      sideEffect: "read",
    })).toThrow("invalid hook ancestry");
    expect(() => new PluginReentrancyGuard({ maxDepth: 9 })).toThrow("maxDepth");
  });
});

