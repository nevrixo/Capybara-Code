import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { profileById } from "@cbc/evals";

import {
  benchmarkApprovalCommands,
  benchmarkRuntimeCompatibilityIssues,
} from "../src/execution.ts";
import {
  benchmarkConfigToml,
  parseBenchmarkApprovalCommand,
  resolveExecutionProfile,
  UnsupportedProfileError,
} from "../src/profile.ts";
import { SUITE } from "../src/suite.ts";

function profile(id: string) {
  const value = profileById(id);
  if (value === undefined) throw new Error(`missing fixture profile ${id}`);
  return value;
}

function loadGeneratedConfig(
  profileId: string,
  performanceVariant: "legacy" | "optimized" = "optimized",
) {
  const resolved = resolveExecutionProfile(profile(profileId), { performanceVariant });
  const toml = benchmarkConfigToml(resolved, { network: "deny" });
  const loaded = loadConfig({
    userToml: toml,
    projectTrusted: false,
    env: {},
  });
  expect(loaded.tomlIssues).toEqual([]);
  expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  return { resolved, loaded };
}

describe("benchmark execution profile", () => {
  test("maps the optimized candidate axes to real product controls", () => {
    const resolved = resolveExecutionProfile(profile("standard-medium"));

    expect(resolved.applied).toEqual(profile("standard-medium"));
    expect(resolved.performanceVariant).toBe("optimized");
    expect(resolved.mechanisms.autoReview).toBe("user-config:agent.review-mode");
    expect(resolved.config.modelCacheMode).toBe("roi");
    expect(resolved.config.performance).toMatchObject({
      promptCompiler: "v2",
      compoundTools: true,
      commandClassification: true,
      providerParallelTools: true,
      reviewPolicy: "risk",
      orientationMode: "progressive",
      providerCompaction: true,
      phasePolicy: true,
      transport: "websocket",
      serviceTier: "standard",
      toolSearch: false,
    });
  });

  test("writes the complete optimized feature set into isolated user config", () => {
    const { loaded } = loadGeneratedConfig("no-cache", "optimized");

    expect(loaded.config.model.default).toBe(profile("no-cache").model);
    expect(loaded.config.model.reasoningMode).toBe(profile("no-cache").reasoningMode);
    expect(loaded.config.model.reasoningEffort).toBe(profile("no-cache").reasoningEffort);
    expect(loaded.config.model.cache.mode).toBe("off");
    expect(loaded.config.agent.promptCompiler).toBe("v2");
    expect(loaded.config.agent.compoundTools).toBe(true);
    expect(loaded.config.agent.toolGraph.commandClassification).toBe(true);
    expect(loaded.config.agent.toolGraph.providerParallelTools).toBe(true);
    expect(loaded.config.agent.verification.reviewPolicy).toBe("risk");
    expect(loaded.config.model.context.orientationMode).toBe("progressive");
    expect(loaded.config.model.context.providerCompaction).toBe(true);
    expect(loaded.config.model.router.phasePolicy).toBe(true);
    expect(loaded.config.provider.openai.transport).toBe("websocket");
    expect(loaded.config.provider.openai.serviceTier).toBe("standard");
    expect(loaded.config.permissions.network).toBe("deny");
    expect(loaded.config.sandbox.networkForShell).toBe("deny");
  });

  test("writes the conservative legacy baseline feature set into product config", () => {
    const { resolved, loaded } = loadGeneratedConfig("standard-medium", "legacy");

    expect(resolved.performanceVariant).toBe("legacy");
    expect(loaded.config.agent.promptCompiler).toBe("v1");
    expect(loaded.config.agent.compoundTools).toBe(false);
    expect(loaded.config.agent.toolGraph.commandClassification).toBe(false);
    expect(loaded.config.agent.toolGraph.providerParallelTools).toBe(false);
    expect(loaded.config.agent.verification.reviewPolicy).toBe("always");
    expect(loaded.config.model.context.orientationMode).toBe("strict");
    expect(loaded.config.model.context.providerCompaction).toBe(false);
    expect(loaded.config.model.router.phasePolicy).toBe(false);
    expect(loaded.config.provider.openai.transport).toBe("http_full");
  });

  test("writes review selection into isolated product config", () => {
    expect(loadGeneratedConfig("no-auto-review").loaded.config.agent.reviewMode).toBe("off");
    expect(loadGeneratedConfig("standard-medium").loaded.config.agent.reviewMode).toBe("auto");
  });

  test("writes each task mode into isolated product config", () => {
    const resolved = resolveExecutionProfile(profile("standard-medium"));
    const load = (permissionMode: "plan" | "auto") =>
      loadConfig({
        userToml: benchmarkConfigToml(resolved, { permissionMode }),
        projectTrusted: false,
        env: {},
      });

    const plan = load("plan");
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(plan.config.agent.interactionMode).toBe("plan");
    expect(plan.config.permissions.preset).toBe("read");

    const auto = load("auto");
    expect(auto.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(auto.config.agent.interactionMode).toBe("build");
    expect(auto.config.permissions.preset).toBe("auto");
  });

  test("fails closed when the product has no switch for a requested axis", () => {
    for (const id of ["all-tools", "no-subagents"]) {
      expect(() => resolveExecutionProfile(profile(id))).toThrow(UnsupportedProfileError);
    }
  });

  test("pre-approves only the declared shell-free verification command", () => {
    const resolved = resolveExecutionProfile(profile("standard-medium"));
    const toml = benchmarkConfigToml(resolved, {
      network: "deny",
      approvalCommands: ["bun test", "bun test"],
    });
    const loaded = loadConfig({ userToml: toml, projectTrusted: false, env: {} });

    expect(loaded.tomlIssues).toEqual([]);
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(loaded.config.permissions.rules).toEqual([
      {
        tool: "process.run",
        decision: "allow",
        risk: "R1",
        program: "bun",
        argsPrefix: ["test"],
      },
    ]);
  });

  test("parses verification commands without introducing a shell", () => {
    expect(parseBenchmarkApprovalCommand("python -m pytest")).toEqual({
      program: "python",
      argsPrefix: ["-m", "pytest"],
    });
    expect(parseBenchmarkApprovalCommand('bun test "test/unit suite"')).toEqual({
      program: "bun",
      argsPrefix: ["test", "test/unit suite"],
    });
    expect(() => parseBenchmarkApprovalCommand("bun test | tee result.txt")).toThrow(
      "shell operator",
    );
    expect(() => parseBenchmarkApprovalCommand('bun test "unterminated')).toThrow(
      "unterminated quote",
    );
  });

  test("does not grant verification execution to Plan or expected-partial tasks", () => {
    const bugFix = SUITE.find((task) => task.id === "bf-off-by-one");
    const denial = SUITE.find((task) => task.id === "pd-001");
    const review = SUITE.find((task) => task.id === "dr-001");
    if (bugFix === undefined || denial === undefined || review === undefined) {
      throw new Error("benchmark policy fixtures are missing");
    }

    expect(benchmarkApprovalCommands(bugFix)).toEqual(["bun test"]);
    expect(benchmarkApprovalCommands(denial)).toEqual([]);
    expect(benchmarkApprovalCommands(review)).toEqual([]);
  });

  test("refuses to score network-deny tasks without a real runtime backend", () => {
    const task = SUITE.find((entry) => entry.id === "bf-off-by-one");
    if (task === undefined) throw new Error("benchmark policy fixture is missing");

    expect(
      benchmarkRuntimeCompatibilityIssues([task], {
        platform: "windows",
        sandboxBackends: [],
      }),
    ).toEqual([
      "selected cohort requires network=deny, but windows reports no network-namespace or seccomp enforcement backend; this run cannot be scored",
    ]);
    expect(
      benchmarkRuntimeCompatibilityIssues([task], {
        platform: "linux",
        sandboxBackends: ["landlock", "seccomp", "rlimit"],
      }),
    ).toEqual([]);
    expect(
      benchmarkRuntimeCompatibilityIssues([{ ...task, network: "allow" }], {
        platform: "windows",
        sandboxBackends: [],
      }),
    ).toEqual([]);
  });
});
