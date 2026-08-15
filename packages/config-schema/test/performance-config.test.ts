import { describe, expect, test } from "bun:test";

import { defaultConfig, mergeConfig } from "../src/index.ts";

describe("performance configuration", () => {
  test("ships the recommended fast-path defaults as one coherent profile", () => {
    const config = defaultConfig();

    expect(config.model.router.phasePolicy).toBe(true);
    expect(config.model.context).toMatchObject({
      orientationMode: "progressive",
      providerCompaction: true,
      compactionThresholdTokens: 80_000,
    });
    expect(config.provider.openai).toMatchObject({
      transport: "websocket",
      serviceTier: "standard",
      toolSearch: false,
    });
    expect(config.agent).toMatchObject({ promptCompiler: "v2", compoundTools: true });
    expect(config.agent.toolGraph).toMatchObject({
      commandClassification: true,
      providerParallelTools: true,
    });
    expect(config.agent.verification.reviewPolicy).toBe("risk");
    expect(config.perf).toEqual({ telemetry: true, sampleRate: 1 });
  });

  test("accepts supported transport, phase, review, and sampling overrides", () => {
    const merged = mergeConfig([{ source: "user", values: {
      "model.router.phasePolicy": false,
      "model.context.orientationMode": "strict",
      "model.context.providerCompaction": false,
      "model.context.compactionThresholdTokens": 4_096,
      "provider.openai.transport": "http_previous",
      "provider.openai.serviceTier": "fast",
      "provider.openai.toolSearch": true,
      "agent.promptCompiler": "v1",
      "agent.compoundTools": false,
      "agent.toolGraph.commandClassification": false,
      "agent.toolGraph.providerParallelTools": false,
      "agent.verification.reviewPolicy": "always",
      "perf.telemetry": false,
      "perf.sampleRate": 0.25,
    } }]);

    expect(merged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(merged.config.provider.openai.transport).toBe("http_previous");
    expect(merged.config.provider.openai.serviceTier).toBe("fast");
    expect(merged.config.agent.verification.reviewPolicy).toBe("always");
    expect(merged.config.perf.sampleRate).toBe(0.25);
  });

  test("rejects unsupported performance enum values and preserves defaults", () => {
    const merged = mergeConfig([{ source: "user", values: {
      "model.context.orientationMode": "eager",
      "provider.openai.transport": "udp",
      "provider.openai.serviceTier": "turbo",
      "agent.promptCompiler": "v3",
      "agent.verification.reviewPolicy": "never",
    } }]);

    expect(merged.issues.filter((issue) => issue.severity === "error")).toHaveLength(5);
    expect(merged.config.model.context.orientationMode).toBe("progressive");
    expect(merged.config.provider.openai.transport).toBe("websocket");
    expect(merged.config.provider.openai.serviceTier).toBe("standard");
    expect(merged.config.agent.promptCompiler).toBe("v2");
    expect(merged.config.agent.verification.reviewPolicy).toBe("risk");
  });

  test("reports every unsafe performance range", () => {
    const invalidCases = [
      ["perf.sampleRate", -0.01],
      ["perf.sampleRate", 1.01],
      ["model.context.compactionThresholdTokens", 1_023],
      ["agent.toolGraph.maxParallelReads", 0],
      ["agent.toolGraph.maxParallelTests", 0],
    ] as const;

    const missingErrors: string[] = [];
    for (const [path, value] of invalidCases) {
      const merged = mergeConfig([{ source: "user", values: { [path]: value } }]);
      const hasError = merged.issues.some((issue) =>
        issue.severity === "error" &&
        (issue.path === path || (path.startsWith("agent.toolGraph.") && issue.path === "agent.toolGraph")),
      );
      if (!hasError) missingErrors.push(path);
    }
    expect(missingErrors).toEqual([]);
  });

  test("keeps provider transport and performance telemetry user-owned", () => {
    const merged = mergeConfig([{ source: "project", values: {
      "provider.openai.transport": "http_full",
      "perf.telemetry": false,
    } }]);

    expect(merged.config.provider.openai.transport).toBe("websocket");
    expect(merged.config.perf.telemetry).toBe(true);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toHaveLength(2);
    expect(merged.issues.every((issue) => issue.message.includes("user-only"))).toBe(true);
  });
});
