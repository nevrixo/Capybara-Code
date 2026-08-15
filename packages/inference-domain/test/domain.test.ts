/**
 * `@cbc/inference-domain` — P1-05.
 *
 * The package is a leaf: it must not import a provider adapter or the kernel.
 * These tests pin the neutral vocabulary and confirm the package stands alone.
 */

import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_SCHEMA_VERSION,
  PRICING_REGISTRY_VERSION,
  SOFT_CONTEXT_BUDGETS,
  emptyUsage,
  type AgentRole,
  type CapabilityState,
  type EffortDecision,
  type ModelDescriptor,
  type ModelUsage,
  type ProjectInstructions,
  type ReasoningEffort,
  type SkillMetadata,
  type TurnPhase,
} from "../src/index.ts";

describe("inference-domain (P1-05)", () => {
  test("soft context budgets cover every non-root role", () => {
    const roles: readonly AgentRole[] = [
      "root",
      "explore",
      "planner",
      "architect",
      "executor",
      "refactorer",
      "reviewer",
      "test",
    ];
    for (const role of roles) {
      expect(SOFT_CONTEXT_BUDGETS[role], role).toBeGreaterThan(0);
    }
  });

  test("emptyUsage is a zeroed token account", () => {
    const usage: ModelUsage = emptyUsage();
    expect(usage.totalTokens).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  test("capability and pricing versions are pinned", () => {
    expect(CAPABILITY_SCHEMA_VERSION).toBe("1.0");
    expect(PRICING_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("neutral contracts are structurally usable without a provider", () => {
    const instructions: ProjectInstructions = { path: "AGENTS.md", content: "be safe" };
    const skill: SkillMetadata = { name: "tdd", description: "test first", source: "builtin" };
    const descriptor: ModelDescriptor = {
      id: "gpt-test",
      family: "gpt",
      aliases: [],
      reasoningEfforts: ["low", "high"],
      reasoningModes: ["standard"],
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsReasoningSummary: true,
      supportsPromptCacheBreakpoints: true,
      sourceVersion: "test",
    };
    expect(instructions.path).toBe("AGENTS.md");
    expect(skill.name).toBe("tdd");
    expect(descriptor.id).toBe("gpt-test");
  });

  test("routing decision shapes are provider-neutral", () => {
    const effort: ReasoningEffort = "high";
    const decision: EffortDecision = {
      effort,
      score: 4,
      reason: "multi-file change",
      requiresConfirmation: false,
    };
    const phase: TurnPhase = "tool_call";
    const state: CapabilityState = "supported";
    expect(decision.effort).toBe("high");
    expect(phase).toBe("tool_call");
    expect(state).toBe("supported");
  });
});
