import { describe, expect, test } from "bun:test";

import { configKeyInfo, defaultConfig, loadConfig, mergeConfig } from "../src/index.ts";

describe("tool recovery configuration", () => {
  test("ships safe recovery and TODO defaults", () => {
    const config = defaultConfig();
    expect(config.agent.toolRecovery).toEqual({ mode: "safe", maxAttempts: 3 });
    expect(config.agent.todo).toEqual({ autoProgress: true, safeRebase: true });
  });

  test("accepts bounded user overrides", () => {
    const merged = mergeConfig([
      {
        source: "user",
        values: {
          "agent.toolRecovery.mode": "full",
          "agent.toolRecovery.maxAttempts": 5,
          "agent.todo.autoProgress": false,
          "agent.todo.safeRebase": false,
        },
      },
    ]);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.agent.toolRecovery).toEqual({ mode: "full", maxAttempts: 5 });
    expect(merged.config.agent.todo).toEqual({ autoProgress: false, safeRebase: false });
  });

  test("rejects an unsafe attempt budget and reports wired key status", () => {
    const merged = loadConfig({
      projectTrusted: true,
      env: {},
      userToml: "[agent.tool_recovery]\nmax_attempts = 0\n",
    });
    expect(merged.issues.some((issue) => issue.path === "agent.toolRecovery.maxAttempts" && issue.severity === "error")).toBe(true);
    expect(configKeyInfo("agent.toolRecovery.mode")?.status).toBe("wired");
    expect(configKeyInfo("agent.todo.autoProgress")?.status).toBe("wired");
  });
});
