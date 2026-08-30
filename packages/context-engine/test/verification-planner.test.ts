/**
 * Impact-based verification planner and turn verification contract — PRD
 * §5.20 (contract shape), §5.21 (impact inputs), §5.22 (verification order).
 *
 * These are pure functions, so the whole §5.22 ordering and the §5.20 field set
 * can be pinned without a kernel harness. The kernel-side enforcement of the
 * contract is covered in packages/agent-kernel/test/kernel.test.ts.
 */

import { describe, expect, test } from "bun:test";

import {
  buildTurnVerificationContract,
  planVerification,
  toLegacyVerificationCommand,
  verificationCommandDisplay,
  workspaceConsumerGraph,
  type VerificationChangeSet,
} from "../src/verification-planner.ts";

function stepIds(
  changedPaths: readonly string[],
  extra: Omit<VerificationChangeSet, "changedPaths"> = {},
): string[] {
  return planVerification({ changedPaths, ...extra }).steps.map((step) => step.id);
}

describe("planVerification order (§5.22)", () => {
  test("emits the seven-stage order for a typescript change", () => {
    expect(stepIds(["src/parser.ts"])).toEqual([
      "revision-match",
      "parse-sanity",
      "focused-tests",
      "diff-integrity",
      "evidence-freshness",
      "todo-consistency",
    ]);
  });

  test("revision-match is the first step, before any test result is credited", () => {
    const plan = planVerification({ changedPaths: ["src/a.ts"] });
    expect(plan.steps[0]?.id).toBe("revision-match");
    expect(plan.steps[0]?.tier).toBe(0);
    expect(plan.steps[0]?.required).toBe(true);
  });

  test("a high-risk change keeps the independent reviewer and the broader tier", () => {
    const ids = stepIds(["packages/permissions/src/policy.ts"], { riskLevel: "high" });
    expect(ids).toContain("package-tests");
    expect(ids).toContain("broader-tests");
    expect(ids).toContain("independent-review");
    // §5.22 orders the changed packages before their consumers.
    expect(ids.indexOf("package-tests")).toBeLessThan(ids.indexOf("broader-tests"));
    // The reviewer is a tier-4 signal, so it must not precede the diff review.
    expect(ids.indexOf("independent-review")).toBeGreaterThan(ids.indexOf("diff-integrity"));
  });

  test("a docs-only change set drops the mutation signal and runs no test tier", () => {
    const plan = planVerification({ changedPaths: ["docs/wiki/architecture.md", "docs/wiki/features.md"] });
    expect(plan.impact).toContain("docs_only");
    expect(plan.impact).not.toContain("mutation");
    expect(plan.steps.some((step) => step.id === "focused-tests")).toBe(false);
    expect(plan.steps.some((step) => step.id === "broader-tests")).toBe(false);
    expect(toLegacyVerificationCommand(plan)).toBeUndefined();
  });

  test("an empty change set plans nothing", () => {
    const plan = planVerification({ changedPaths: [] });
    expect(plan.steps).toEqual([]);
    expect(plan.requiredCoverage).toEqual([]);
  });

  test("a prior failure or a reflection path widens beyond the focused tier (§5.21)", () => {
    expect(stepIds(["src/a.ts"], { failedCommands: ["bun test a"] })).toContain("broader-tests");
    expect(stepIds(["src/a.ts"], { reflectionPaths: ["src/a.ts"] })).toContain("broader-tests");
  });

  test("requiredCoverage is the union of the required steps' coverage ids", () => {
    const plan = planVerification({ changedPaths: ["src/a.ts"], riskLevel: "critical" });
    expect([...plan.requiredCoverage]).toEqual([
      "revision_match",
      "parse",
      "focused_tests",
      "package_tests",
      "broader_tests",
      "affected_consumers",
      "diff_integrity",
      "authoritative_change_set",
      "evidence_freshness",
      "independent_review",
      "todo_consistency",
    ]);
  });

  test("the package and consumer tiers are scoped, not a full-matrix run (§5.22 steps 3-4)", () => {
    const plan = planVerification({
      changedPaths: ["packages/protocol-ts/src/events.ts"],
      riskLevel: "high",
    });
    const pkg = plan.steps.find((step) => step.id === "package-tests");
    const consumer = plan.steps.find((step) => step.id === "broader-tests");
    // A bare `bun test` here is what made the consumer tier indistinguishable
    // from running everything.
    expect(verificationCommandDisplay(pkg!.command!)).toBe("bun test packages/protocol-ts");
    expect(verificationCommandDisplay(consumer!.command!)).toBe("bun test packages/protocol-ts");
    expect(consumer?.covers).toContain("affected_consumers");
  });

  test("a rust change scopes the package tier to the changed crates", () => {
    const plan = planVerification({
      changedPaths: ["crates/cbc-fs/src/lib.rs"],
      riskLevel: "high",
    });
    const pkg = plan.steps.find((step) => step.id === "package-tests");
    expect(verificationCommandDisplay(pkg!.command!)).toBe("cargo test -p cbc-fs");
  });

  test("a low-risk single-file edit plans neither the package nor the consumer tier", () => {
    const ids = stepIds(["packages/agent-kernel/src/state.ts"]);
    expect(ids).not.toContain("package-tests");
    expect(ids).not.toContain("broader-tests");
  });

  test("the dependency signal is a manifest, not any path under packages/", () => {
    // `packages/x/src/y.ts` used to match the dependency regex, so every file in
    // the monorepo widened to the package and consumer tiers.
    expect(planVerification({ changedPaths: ["packages/a/src/y.ts"] }).impact).not.toContain("dependency");
    expect(planVerification({ changedPaths: ["packages/a/package.json"] }).impact).toContain("dependency");
    expect(planVerification({ changedPaths: ["bun.lock"] }).impact).toContain("dependency");
  });

  test("the legacy adapter prefers the narrowest executable step", () => {
    const plan = planVerification({ changedPaths: ["packages/x/test/a.test.ts"] });
    const legacy = toLegacyVerificationCommand(plan);
    expect(legacy?.command).toBe("bun test packages/x/test/a.test.ts");
  });

  test("a rust change set plans a cargo command", () => {
    const plan = planVerification({ changedPaths: ["crates/runtime/src/lib.rs"] });
    const focused = plan.steps.find((step) => step.id === "focused-tests");
    expect(focused?.command).toBeDefined();
    expect(verificationCommandDisplay(focused!.command!)).toBe("cargo test --workspace");
  });
});

describe("buildTurnVerificationContract (§5.20)", () => {
  test("carries the full §5.20 field set", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["packages/agent-kernel/src/kernel.ts"],
      workspaceGeneration: 7,
    });
    expect(contract.workspaceGeneration).toBe(7);
    expect(contract.changedPaths).toEqual(["packages/agent-kernel/src/kernel.ts"]);
    expect(contract.impactedPackages).toEqual(["packages/agent-kernel"]);
    expect(contract.reviewRequired).toBe(false);
    expect(contract.evidenceRequirements).toContain("revision_match");
    expect(contract.requiredChecks.every((check) => check.required)).toBe(true);
  });

  test("every required plan step becomes a required check", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["src/a.ts"],
      workspaceGeneration: 1,
    });
    expect(contract.requiredChecks.map((check) => check.id)).toEqual([
      "revision-match",
      "parse-sanity",
      "focused-tests",
      "diff-integrity",
      "evidence-freshness",
      "todo-consistency",
    ]);
  });

  test("normalizes windows separators and de-duplicates changed paths", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["packages\\a\\src\\x.ts", "packages/a/src/x.ts", ""],
      workspaceGeneration: 0,
    });
    expect(contract.changedPaths).toEqual(["packages/a/src/x.ts"]);
    expect(contract.impactedPackages).toEqual(["packages/a"]);
  });

  test("maps packages, apps, crates, and root paths to impacted packages", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: [
        "packages/protocol-ts/src/events.ts",
        "apps/cbc/src/agent.ts",
        "crates/runtime/src/lib.rs",
        "scripts/build.ts",
        "README.md",
      ],
      workspaceGeneration: 2,
    });
    expect([...contract.impactedPackages]).toEqual([
      ".",
      "apps/cbc",
      "crates/runtime",
      "packages/protocol-ts",
      "scripts",
    ]);
  });

  test("a high risk level requires the reviewer even when the host did not ask", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["src/a.ts"],
      workspaceGeneration: 3,
      riskLevel: "high",
    });
    expect(contract.reviewRequired).toBe(true);
    expect(contract.requiredChecks.map((check) => check.id)).toContain("independent-review");
  });

  test("an explicit host review decision wins over the derived one", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["src/a.ts"],
      workspaceGeneration: 3,
      riskLevel: "critical",
      reviewRequired: false,
    });
    expect(contract.reviewRequired).toBe(false);
  });

  test("tier 0-1 checks are scoped to the changed paths, later tiers to the packages", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["packages/a/src/x.ts"],
      workspaceGeneration: 4,
      riskLevel: "high",
    });
    const byId = new Map(contract.requiredChecks.map((check) => [check.id, check]));
    expect(byId.get("parse-sanity")?.scope).toEqual(["packages/a/src/x.ts"]);
    expect(byId.get("focused-tests")?.scope).toEqual(["packages/a/src/x.ts"]);
    expect(byId.get("diff-integrity")?.scope).toEqual(["packages/a"]);
  });

  test("a docs-only turn requires no test command at all (§5.24 low-risk edits)", () => {
    const contract = buildTurnVerificationContract({
      changedPaths: ["docs/wiki/features.md"],
      workspaceGeneration: 5,
    });
    expect(contract.requiredChecks.some((check) => check.command !== undefined && check.command.startsWith("bun test"))).toBe(false);
    expect(contract.reviewRequired).toBe(false);
  });
});

describe("workspaceConsumerGraph (§5.21 dependency graph)", () => {
  const MANIFESTS = [
    { directory: "packages/protocol-ts", name: "@cbc/protocol", dependencies: [] },
    { directory: "packages/provider-openai", name: "@cbc/provider", dependencies: ["@cbc/protocol"] },
    {
      directory: "packages/agent-kernel",
      name: "@cbc/agent-kernel",
      dependencies: ["@cbc/provider"],
    },
    { directory: "apps/cbc", name: "capybara-code", dependencies: ["@cbc/agent-kernel"] },
    { directory: "packages/skills", name: "@cbc/skills", dependencies: [] },
  ];

  test("reverses declared dependencies transitively", () => {
    const graph = workspaceConsumerGraph(MANIFESTS);
    // protocol-ts reaches agent-kernel only through provider-openai, so a
    // one-hop map would leave the real consumer untested.
    expect(graph.get("packages/protocol-ts")).toEqual([
      "apps/cbc",
      "packages/agent-kernel",
      "packages/provider-openai",
    ]);
    expect(graph.get("packages/agent-kernel")).toEqual(["apps/cbc"]);
    expect(graph.get("apps/cbc")).toEqual([]);
    expect(graph.get("packages/skills")).toEqual([]);
  });

  test("ignores dependencies on names outside the workspace", () => {
    const graph = workspaceConsumerGraph([
      { directory: "packages/a", name: "@cbc/a", dependencies: ["zod", "@cbc/missing"] },
    ]);
    expect(graph.get("packages/a")).toEqual([]);
  });

  test("a dependency cycle terminates instead of looping", () => {
    const graph = workspaceConsumerGraph([
      { directory: "packages/a", name: "@cbc/a", dependencies: ["@cbc/b"] },
      { directory: "packages/b", name: "@cbc/b", dependencies: ["@cbc/a"] },
    ]);
    // A package is not its own consumer, so the cycle resolves to the other member.
    expect(graph.get("packages/a")).toEqual(["packages/b"]);
    expect(graph.get("packages/b")).toEqual(["packages/a"]);
  });

  test("a change in a dependency pulls its consumers into the tier-4 scope", () => {
    const graph = workspaceConsumerGraph(MANIFESTS);
    const plan = planVerification({
      changedPaths: ["packages/protocol-ts/src/events.ts"],
      riskLevel: "high",
      packageConsumers: graph,
    });
    const consumer = plan.steps.find((step) => step.id === "broader-tests");
    expect(verificationCommandDisplay(consumer!.command!)).toBe(
      "bun test apps/cbc packages/agent-kernel packages/protocol-ts packages/provider-openai",
    );
  });

  test("without a graph the consumer tier stays at the changed packages", () => {
    const plan = planVerification({
      changedPaths: ["packages/protocol-ts/src/events.ts"],
      riskLevel: "high",
    });
    const consumer = plan.steps.find((step) => step.id === "broader-tests");
    expect(verificationCommandDisplay(consumer!.command!)).toBe("bun test packages/protocol-ts");
  });

  test("a package nothing depends on does not widen (§5.24 low-risk edits)", () => {
    const graph = workspaceConsumerGraph(MANIFESTS);
    const plan = planVerification({
      changedPaths: ["packages/skills/src/index.ts"],
      riskLevel: "high",
      packageConsumers: graph,
    });
    const consumer = plan.steps.find((step) => step.id === "broader-tests");
    expect(verificationCommandDisplay(consumer!.command!)).toBe("bun test packages/skills");
  });

  test("the contract forwards both the graph and the reflection paths", () => {
    const graph = workspaceConsumerGraph(MANIFESTS);
    const contract = buildTurnVerificationContract({
      changedPaths: ["packages/protocol-ts/src/events.ts"],
      workspaceGeneration: 3,
      // A reflection path alone widens past the focused tier; dropping it here
      // made the widening the kernel supplies dead on the contract path.
      reflectionPaths: ["packages/protocol-ts/src/events.ts"],
      packageConsumers: graph,
    });
    const consumer = contract.requiredChecks.find((check) => check.id === "broader-tests");
    // Not required at low risk, but it must be planned rather than absent.
    expect(
      planVerification({
        changedPaths: ["packages/protocol-ts/src/events.ts"],
        reflectionPaths: ["packages/protocol-ts/src/events.ts"],
        packageConsumers: graph,
      }).steps.some((step) => step.id === "broader-tests"),
    ).toBe(true);
    expect(consumer).toBeUndefined();

    const highRisk = buildTurnVerificationContract({
      changedPaths: ["packages/protocol-ts/src/events.ts"],
      workspaceGeneration: 3,
      riskLevel: "high",
      packageConsumers: graph,
    });
    expect(
      highRisk.requiredChecks.find((check) => check.id === "broader-tests")?.command,
    ).toBe("bun test apps/cbc packages/agent-kernel packages/protocol-ts packages/provider-openai");
  });
});
