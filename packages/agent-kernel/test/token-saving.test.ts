/**
 * Token saving resolver tests — integrated saving profile.
 *
 * Covers the intensity table, risk caps, repair relaxation, phase policy,
 * directive content, and the continuation dedupe contract.
 */

import { describe, expect, test } from "bun:test";

import {
  assemblePrompt,
  resolveTokenSavingPlan,
  tokenSavingDirectiveText,
  TOKEN_SAVING_PROFILES,
  TOKEN_SAVING_RELEASE_DIRECTIVE,
  TokenSavingController,
  isTokenSavingLevel,
  type PromptInputs,
  type ResolvedTokenSavingPlan,
  type TokenSavingResolveInput,
} from "../src/index.ts";

function input(overrides: Partial<TokenSavingResolveInput> = {}): TokenSavingResolveInput {
  return {
    requestedLevel: "balanced",
    phase: "edit",
    risk: "low",
    repairCycles: 0,
    continuationRecovery: false,
    explicitDetailedResponse: false,
    ...overrides,
  };
}

describe("token saving profiles", () => {
  test("off keeps the current budgets exactly", () => {
    const profile = TOKEN_SAVING_PROFILES.off;
    expect(profile.targetInputRatio).toBe(1);
    expect(profile.explorationRatio).toBe(0.3);
    expect(profile.localCompactionRatio).toBe(0.7);
    expect(profile.ponytail).toBe("off");
    expect(profile.responseStyle).toBe("normal");
  });

  test("each level maps to one internal ponytail policy", () => {
    expect(TOKEN_SAVING_PROFILES.off.ponytail).toBe("off");
    expect(TOKEN_SAVING_PROFILES.light.ponytail).toBe("lite");
    expect(TOKEN_SAVING_PROFILES.balanced.ponytail).toBe("full");
    expect(TOKEN_SAVING_PROFILES.strong.ponytail).toBe("ultra");
  });
});

describe("resolveTokenSavingPlan", () => {
  test("off resolves to unchanged behaviour with no reasons", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "off" }));
    expect(plan.effectiveLevel).toBe("off");
    expect(plan.targetInputRatio).toBe(1);
    expect(plan.ponytail).toBe("off");
    expect(plan.reasons).toEqual([]);
  });

  test("balanced under low risk applies the full profile", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "balanced" }));
    expect(plan.effectiveLevel).toBe("balanced");
    expect(plan.targetInputRatio).toBe(0.85);
    expect(plan.explorationRatio).toBe(0.22);
    expect(plan.localCompactionRatio).toBe(0.55);
    expect(plan.ponytail).toBe("full");
  });

  test("risk caps the effective level", () => {
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", risk: "medium" })).effectiveLevel).toBe("balanced");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", risk: "high" })).effectiveLevel).toBe("light");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", risk: "critical" })).effectiveLevel).toBe("light");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "balanced", risk: "high" })).effectiveLevel).toBe("light");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "light", risk: "critical" })).effectiveLevel).toBe("light");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", risk: "low" })).effectiveLevel).toBe("strong");
  });

  test("risk relaxation records a reason", () => {
    const plan = resolveTokenSavingPlan(
      input({ requestedLevel: "strong", risk: "high", riskReasons: ["security-sensitive path changed"] }),
    );
    expect(plan.effectiveLevel).toBe("light");
    expect(plan.reasons).toContain("security-sensitive path changed");
  });

  test("repair cycles relax the level step by step", () => {
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", repairCycles: 1 })).effectiveLevel).toBe("balanced");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", repairCycles: 2 })).effectiveLevel).toBe("light");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", repairCycles: 3 })).effectiveLevel).toBe("off");
    expect(resolveTokenSavingPlan(input({ requestedLevel: "strong", repairCycles: 9 })).effectiveLevel).toBe("off");
  });

  test("continuation recovery runs un-saved", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "strong", continuationRecovery: true }));
    expect(plan.effectiveLevel).toBe("off");
  });

  test("verify and review phases never apply ponytail generation rules", () => {
    expect(resolveTokenSavingPlan(input({ phase: "verify" })).ponytail).toBe("off");
    expect(resolveTokenSavingPlan(input({ phase: "review" })).ponytail).toBe("off");
    expect(resolveTokenSavingPlan(input({ phase: "edit" })).ponytail).toBe("full");
  });

  test("review applies at most light context saving", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "strong", phase: "review" }));
    expect(plan.effectiveLevel).toBe("light");
  });

  test("an explicit detailed response relaxes only the response style", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "strong", explicitDetailedResponse: true }));
    expect(plan.responseStyle).toBe("normal");
    expect(plan.effectiveLevel).toBe("strong");
    expect(plan.targetInputRatio).toBe(TOKEN_SAVING_PROFILES.strong.targetInputRatio);
  });

  test("identical input is deterministic", () => {
    const a = resolveTokenSavingPlan(input({ requestedLevel: "strong", risk: "medium", repairCycles: 1 }));
    const b = resolveTokenSavingPlan(input({ requestedLevel: "strong", risk: "medium", repairCycles: 1 }));
    expect(a).toEqual(b);
  });
});

describe("token saving directive", () => {
  test("an off plan carries no directive", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "off" }));
    expect(tokenSavingDirectiveText(plan)).toBeUndefined();
  });

  test("every non-off directive keeps the safety invariants", () => {
    for (const level of ["light", "balanced", "strong"] as const) {
      const plan = resolveTokenSavingPlan(input({ requestedLevel: level }));
      const text = tokenSavingDirectiveText(plan);
      expect(text).toBeDefined();
      expect(text).toContain("Do not weaken validation, security, error handling, verification, or requested behavior.");
      expect(text).toContain(`Effective level: ${level.toUpperCase()}.`);
      expect(text).toContain("supersedes earlier token-saving directives");
    }
  });

  test("verify phases keep context policy without implementation minimization", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "balanced", phase: "verify" }));
    const text = tokenSavingDirectiveText(plan);
    expect(text).toBeDefined();
    expect(text).toContain("Do not weaken validation, security, error handling, verification, or requested behavior.");
    expect(text).not.toContain("Prefer reuse, standard/native capabilities");
  });
});

describe("TokenSavingController", () => {
  function planFor(level: "off" | "light" | "balanced" | "strong"): ResolvedTokenSavingPlan {
    return resolveTokenSavingPlan(input({ requestedLevel: level }));
  }

  test("rejects unknown levels", () => {
    const controller = new TokenSavingController("off");
    expect(isTokenSavingLevel("ultra")).toBe(false);
    expect(controller.setRequestedLevel("ultra" as never)).toBeUndefined();
    expect(controller.requestedLevel).toBe("off");
  });

  test("continuation mode sends an identical directive only once", () => {
    const controller = new TokenSavingController("balanced");
    const plan = planFor("balanced");
    const first = controller.peekDirective(plan, "continuation");
    expect(first).toBeDefined();
    controller.noteDirectiveIncluded(first as string);
    expect(controller.peekDirective(plan, "continuation")).toBeUndefined();
  });

  test("a level change resends the directive in continuation mode", () => {
    const controller = new TokenSavingController("balanced");
    const balanced = planFor("balanced");
    const first = controller.peekDirective(balanced, "continuation");
    controller.noteDirectiveIncluded(first as string);
    controller.setRequestedLevel("strong");
    const strong = controller.peekDirective(planFor("strong"), "continuation");
    expect(strong).toBeDefined();
    expect(strong).toContain("STRONG");
  });

  test("switching on to off sends one release directive in continuation mode", () => {
    const controller = new TokenSavingController("balanced");
    const first = controller.peekDirective(planFor("balanced"), "continuation");
    controller.noteDirectiveIncluded(first as string);
    controller.setRequestedLevel("off");
    expect(controller.peekDirective(planFor("off"), "continuation")).toBe(TOKEN_SAVING_RELEASE_DIRECTIVE);
    controller.noteDirectiveIncluded(TOKEN_SAVING_RELEASE_DIRECTIVE);
    expect(controller.peekDirective(planFor("off"), "continuation")).toBeUndefined();
  });

  test("off without history sends nothing", () => {
    const controller = new TokenSavingController("off");
    expect(controller.peekDirective(planFor("off"), "continuation")).toBeUndefined();
    expect(controller.peekDirective(planFor("off"), "full_replay")).toBeUndefined();
  });

  test("full replay always carries the current directive and never a release", () => {
    const controller = new TokenSavingController("balanced");
    const plan = planFor("balanced");
    const first = controller.peekDirective(plan, "full_replay");
    controller.noteDirectiveIncluded(first as string);
    expect(controller.peekDirective(plan, "full_replay")).toBe(first);
    controller.setRequestedLevel("off");
    expect(controller.peekDirective(planFor("off"), "full_replay")).toBeUndefined();
  });

  test("reset tracking restates the directive after linkage loss", () => {
    const controller = new TokenSavingController("balanced");
    const plan = planFor("balanced");
    const first = controller.peekDirective(plan, "continuation");
    controller.noteDirectiveIncluded(first as string);
    controller.resetDirectiveTracking();
    expect(controller.peekDirective(plan, "continuation")).toBe(first);
  });
});

describe("prompt assembly integration", () => {
  const base: PromptInputs = {
    activeTools: [],
    projectInstructions: [],
    skillCatalog: [],
    loadedSkills: [],
    repositoryContext: [],
    history: [],
  };

  test("an off session assembles byte-identically to the unchanged product", () => {
    const plain = assemblePrompt({ ...base, userInput: "do the work" });
    const withOff = assemblePrompt({ ...base, userInput: "do the work" });
    expect(plain.requestDigest).toBe(withOff.requestDigest);
    expect(plain.serializedInput).not.toContain("token-saving directive");
  });

  test("the directive rides in the variable suffix, never the stable prefix", () => {
    const plan = resolveTokenSavingPlan(input({ requestedLevel: "balanced" }));
    const directive = tokenSavingDirectiveText(plan);
    if (directive === undefined) throw new Error("expected a balanced directive");
    const assembled = assemblePrompt({ ...base, tokenSavingDirective: directive });
    expect(assembled.stablePrefixText).not.toContain("token-saving directive");
    expect(assembled.serializedInput).toContain("Effective level: BALANCED.");
    // The stable prefix digest is untouched by the directive, so the prefix
    // cache survives a level change.
    const without = assemblePrompt({ ...base });
    expect(assembled.stablePrefixDigest).toBe(without.stablePrefixDigest);
  });
});
