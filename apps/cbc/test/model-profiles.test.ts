import { describe, expect, test } from "bun:test";

import { defaultConfig, profileStrategy } from "@cbc/config-schema";

import { parseArgs } from "../src/args.ts";
import { withActiveProfile } from "../src/bootstrap.ts";
import { parseSlash } from "../src/slash.ts";

/**
 * §6 P1-03's recommended profiles have to be *selectable* and *honoured*. Adding
 * the two strategy columns to the schema was not enough on its own: before this,
 * `model.profiles` held rows nothing could pick and nothing downstream read.
 */
const effectiveFor = (name: string) => {
  const base = defaultConfig();
  base.model.profile = name;
  return withActiveProfile(base);
};

describe("selecting a recommended profile", () => {
  test("capy model use accepts the prefixed and bare form alike", () => {
    expect(parseArgs(["model", "use", "profile:deep"]).command).toEqual({
      kind: "model",
      sub: "use",
      profile: "deep",
    });
    expect(parseArgs(["model", "use", "deep"]).command).toEqual({
      kind: "model",
      sub: "use",
      profile: "deep",
    });
  });

  test("capy model use requires a name", () => {
    expect(() => parseArgs(["model", "use", "profile:"])).toThrow(/needs a profile name/);
  });

  test("/model profile:<name> is a profile choice, not a model id", () => {
    expect(parseSlash("/model profile:quality")).toEqual({
      kind: "set_profile",
      profile: "quality",
    });
    // A bare argument still means a model: no model id contains a colon, so the
    // two cannot collide.
    expect(parseSlash("/model gpt-5.6-sol")).toEqual({ kind: "set_model", model: "gpt-5.6-sol" });
  });
});

describe("a selected profile reaches execution", () => {
  test("Fast and Deep resolve to observably different effective configs", () => {
    const fast = effectiveFor("fast");
    const deep = effectiveFor("deep");

    // Model strategy.
    expect(fast.model.default).toBe("gpt-5.6-terra");
    expect(deep.model.default).toBe("gpt-5.6-sol");
    expect(fast.model.reasoningEffort).toBe("low");
    expect(deep.model.reasoningEffort).toBe("high");

    // Execution strategy: Fast keeps a small PTC and closes the hosted subtree;
    // Deep is the row that opens it.
    expect(fast.provider.openai.native.hostedMultiAgent).toBe("disabled");
    expect(deep.provider.openai.native.hostedMultiAgent).toBe("read-only");
    expect(fast.provider.openai.native.maxProgramToolCalls).toBeLessThan(
      deep.provider.openai.native.maxProgramToolCalls,
    );

    // Verification strategy.
    expect(deep.agent.verification.reviewPolicy).toBe("always");
    expect(fast.agent.verification.reviewPolicy).toBe("risk");
  });

  test("Balanced keeps the program lane at full budget without the hosted scout", () => {
    const balanced = effectiveFor("balanced");
    const base = defaultConfig();
    expect(profileStrategy(base.model.profiles.balanced ?? {}).execution).toBe("program_eligible");
    expect(balanced.provider.openai.native.maxProgramToolCalls).toBe(
      base.provider.openai.native.maxProgramToolCalls,
    );
    expect(balanced.provider.openai.native.hostedMultiAgent).toBe("disabled");
    expect(balanced.agent.verification.reviewPolicy).toBe("risk");
  });

  test("Quality admits multi-agent on a split and asks for the full contract", () => {
    const quality = effectiveFor("quality");
    expect(quality.model.reasoningMode).toBe("pro");
    expect(quality.provider.openai.native.hostedMultiAgent).toBe("read-only");
    expect(quality.agent.verification.reviewPolicy).toBe("always");
  });

  test("every recommended row produces a distinct effective shape", () => {
    const shape = (name: string): string => {
      const config = effectiveFor(name);
      const native = config.provider.openai.native;
      return [
        config.model.default,
        config.model.reasoningMode,
        config.model.reasoningEffort,
        native.hostedMultiAgent,
        native.maxProgramToolCalls,
        config.agent.verification.reviewPolicy,
      ].join("|");
    };
    const shapes = ["fast", "balanced", "deep", "quality"].map(shape);
    expect(new Set(shapes).size).toBe(4);
  });

  test("a profile narrows but never widens what the user already configured", () => {
    const base = defaultConfig();
    base.model.profile = "deep";
    // A user who closed the hosted subtree, or tightened the program budget, keeps
    // their own number: a preset is a preference, not a way past a config decision.
    base.provider.openai.native.hostedMultiAgent = "disabled";
    base.provider.openai.native.maxProgramToolCalls = 2;
    const effective = withActiveProfile(base);
    expect(effective.provider.openai.native.hostedMultiAgent).toBe("disabled");

    const tightFast = defaultConfig();
    tightFast.model.profile = "fast";
    tightFast.provider.openai.native.maxProgramToolCalls = 2;
    expect(withActiveProfile(tightFast).provider.openai.native.maxProgramToolCalls).toBe(2);
  });
});

describe("§12 rule 9: the default profile stays where the eval put it", () => {
  test("the shipped default is auto and is unchanged by the fold", () => {
    const base = defaultConfig();
    expect(base.model.profile).toBe("auto");
    // `auto` names no row, so the fold is a no-op: adding the strategy columns must
    // not silently move anyone who never picked a profile.
    const effective = withActiveProfile(base);
    expect(effective.model.default).toBe(base.model.default);
    expect(effective.model.reasoningEffort).toBe(base.model.reasoningEffort);
    expect(effective.provider.openai.native.hostedMultiAgent).toBe(
      base.provider.openai.native.hostedMultiAgent,
    );
    expect(effective.agent.verification.reviewPolicy).toBe(base.agent.verification.reviewPolicy);
    expect(effective.model.reasoningMode).not.toBe("pro");
    expect(effective.model.reasoningEffort).not.toBe("max");
  });

  test("a manual model choice is not a profile and folds nothing", () => {
    const base = defaultConfig();
    base.model.profile = "manual";
    base.model.default = "gpt-5.6-luna";
    const effective = withActiveProfile(base);
    expect(effective.model.default).toBe("gpt-5.6-luna");
    expect(effective.agent.verification.reviewPolicy).toBe("risk");
  });
});
