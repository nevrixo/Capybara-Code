import { describe, expect, test } from "bun:test";

import { defaultConfig, profileStrategy } from "@cbc/config-schema";
import { deriveVerificationLevel } from "@cbc/provider-openai";

/**
 * §P1-03's recommended-profile table. A profile is only worth selecting if the
 * three columns it names — model, execution, verification — actually differ, so
 * these assert the table rather than the type.
 */
describe("recommended profile strategies", () => {
  const profiles = defaultConfig().model.profiles;

  test("every profile names all three dimensions", () => {
    for (const [name, profile] of Object.entries(profiles)) {
      const strategy = profileStrategy(profile);
      expect(profile.model, name).toBeTruthy();
      // Resolved rather than read raw: a profile may legally omit a column, and
      // the accessor is what every consumer sees.
      expect(strategy.execution, name).toBeTruthy();
      expect(strategy.verification, name).toBeTruthy();
    }
  });

  test("Fast, Balanced, Deep, and Quality differ observably", () => {
    const shape = (name: string) => {
      const p = profiles[name];
      if (p === undefined) throw new Error(`profile ${name} is missing`);
      const s = profileStrategy(p);
      return `${p.model}|${p.reasoningMode}|${p.reasoningEffort}|${s.execution}|${s.verification}`;
    };
    const shapes = ["fast", "balanced", "deep", "quality"].map(shape);
    // Four distinct shapes: if two profiles collapsed to the same one, selecting
    // between them would be a no-op the user could not detect.
    expect(new Set(shapes).size).toBe(4);
  });

  test("the table's execution column follows the PRD's ordering", () => {
    const execution = (name: string): string => {
      const profile = profiles[name];
      if (profile === undefined) throw new Error(`profile ${name} is missing`);
      return profileStrategy(profile).execution;
    };
    expect(execution("fast")).toBe("direct_first");
    expect(execution("balanced")).toBe("program_eligible");
    expect(execution("deep")).toBe("hosted_scout");
    // §P1-03's Quality row is "명확한 분할만 multi-agent" — split only.
    expect(execution("quality")).toBe("split_only");
  });

  test("verification deepens monotonically across the table", () => {
    const rank = { focused: 0, package: 1, integration: 2, independent_review: 3 } as const;
    const order: number[] = [];
    for (const name of ["fast", "balanced", "deep"] as const) {
      const profile = profiles[name];
      if (profile === undefined) throw new Error(`profile ${name} is missing`);
      order.push(rank[profileStrategy(profile).verification]);
    }
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeLessThan(order[2]!);
  });

  test("no profile makes max effort or pro reasoning the default", () => {
    // §12's rule 9: the highest tier is only promoted once a bench run justifies
    // it, so the *default* profile must not be the expensive one.
    const active = profiles[defaultConfig().model.profile];
    expect(active?.reasoningEffort).not.toBe("max");
    expect(active?.reasoningMode).not.toBe("pro");
  });
});

describe("a profile floor raises verification but never lowers it", () => {
  test("a floor deepens a turn the facts would have left shallow", () => {
    const bare = deriveVerificationLevel({ intent: "program", phase: "implement" });
    const floored = deriveVerificationLevel({
      intent: "program",
      phase: "implement",
      profileFloor: "independent_review",
    });
    expect(floored.level).toBe("independent_review");
    expect(floored.codes).toContain("verify:profile-floor");
    expect(bare.level).not.toBe("independent_review");
  });

  test("a shallow floor cannot lower a critical-risk turn", () => {
    // This is the invariant that keeps a preset from overriding a safety
    // judgement: a Fast profile on a credential change still gets the review.
    const decision = deriveVerificationLevel({
      intent: "program",
      phase: "implement",
      changeRisk: "critical",
      profileFloor: "focused",
    });
    expect(decision.level).toBe("independent_review");
  });

  test("a shallow floor cannot lower a repair phase either", () => {
    const decision = deriveVerificationLevel({
      intent: "program",
      phase: "repair",
      profileFloor: "focused",
    });
    expect(decision.level).toBe("integration");
  });

  test("plan mode still honours a review floor", () => {
    const focused = deriveVerificationLevel({ intent: "inspect", interactionMode: "plan" });
    expect(focused.level).toBe("focused");

    const reviewed = deriveVerificationLevel({
      intent: "inspect",
      interactionMode: "plan",
      profileFloor: "independent_review",
    });
    expect(reviewed.level).toBe("independent_review");
  });

  test("no floor leaves the derived level untouched", () => {
    const input = { intent: "program" as const, phase: "implement" as const, changeRisk: "high" as const };
    expect(deriveVerificationLevel(input).level)
      .toBe(deriveVerificationLevel({ ...input, profileFloor: "focused" }).level);
  });
});
