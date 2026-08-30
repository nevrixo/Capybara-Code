/**
 * §8.4 [agent.learning] — the Evidence-backed Strategy Capsule policy keys
 * (P1-01, §6.3).
 */

import { describe, expect, test } from "bun:test";

import { configEnumValues, configKeyInfo, defaultConfig, mergeConfig, parseToml, normalizeConfigKeys } from "../src/index.ts";

describe("agent.learning (§6.3, §8.4)", () => {
  test("the default is suggestion-only with three verified observations", () => {
    const learning = defaultConfig().agent.learning;
    expect(learning.strategyCapsules).toBe("suggest");
    expect(learning.minVerifiedObservations).toBe(3);
  });

  test("the §8.4 TOML spelling reaches the schema path", () => {
    const parsed = parseToml(`
[agent.learning]
strategy_capsules = "suggest"
min_verified_observations = 3
`);
    const normalized = normalizeConfigKeys(parsed.values);
    expect(normalized["agent.learning.strategyCapsules"]).toBe("suggest");
    expect(normalized["agent.learning.minVerifiedObservations"]).toBe(3);
  });

  test("the policy ladder accepts off | suggest | on and nothing else", () => {
    expect(configEnumValues("agent.learning.strategyCapsules")).toEqual(["off", "suggest", "on"]);

    for (const value of ["off", "suggest", "on"] as const) {
      const merged = mergeConfig([{ source: "user", values: { "agent.learning.strategyCapsules": value } }]);
      expect(merged.config.agent.learning.strategyCapsules).toBe(value);
      expect(merged.issues.some((issue) =>
        issue.path === "agent.learning.strategyCapsules" && issue.severity === "error"
      )).toBe(false);
    }

    const rejected = mergeConfig([
      { source: "user", values: { "agent.learning.strategyCapsules": "auto" } },
    ]);
    expect(rejected.issues.some((issue) =>
      issue.path === "agent.learning.strategyCapsules" && issue.severity === "error"
    )).toBe(true);
  });

  test("a project may decline capsules but may never promote the user's policy", () => {
    const weakened = mergeConfig([
      { source: "user", values: { "agent.learning.strategyCapsules": "suggest" } },
      { source: "project", values: { "agent.learning.strategyCapsules": "on" } },
    ]);
    expect(weakened.config.agent.learning.strategyCapsules).toBe("suggest");
    expect(weakened.issues.some((issue) =>
      issue.path === "agent.learning.strategyCapsules" && issue.severity === "error"
    )).toBe(true);

    const tightened = mergeConfig([
      { source: "user", values: { "agent.learning.strategyCapsules": "suggest" } },
      { source: "project", values: { "agent.learning.strategyCapsules": "off" } },
    ]);
    expect(tightened.config.agent.learning.strategyCapsules).toBe("off");
    expect(tightened.issues.some((issue) =>
      issue.path === "agent.learning.strategyCapsules" && issue.severity === "error"
    )).toBe(false);
  });

  test("the observation threshold cannot be set below one trajectory", () => {
    const merged = mergeConfig([
      { source: "user", values: { "agent.learning.minVerifiedObservations": 0 } },
    ]);
    expect(merged.issues.some((issue) =>
      issue.path === "agent.learning.minVerifiedObservations" && issue.severity === "error"
    )).toBe(true);
  });

  test("both keys are wired, and name the consumer that reads them", () => {
    const policy = configKeyInfo("agent.learning.strategyCapsules");
    expect(policy?.status).toBe("wired");
    expect(policy?.consumer).toContain("CapsuleStore");

    const threshold = configKeyInfo("agent.learning.minVerifiedObservations");
    expect(threshold?.status).toBe("wired");
    expect(threshold?.consumer).toContain("CapsuleStore");
  });
});
