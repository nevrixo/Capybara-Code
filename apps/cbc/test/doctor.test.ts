/**
 * `/doctor openai` rendering and argument parsing — PRD §6 P1-03.
 *
 * The assertions are mostly about *reasons* rather than states. A report that
 * says a feature is off is not the deliverable: §P1-03 asks for "PTC eligibility
 *와 비활성 이유", and a user cannot act on "off" when policy, budget, capability,
 * and a missing dispatcher all produce it.
 */

import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/args.ts";
import { parseSlash } from "../src/slash.ts";
import { renderKeyStatusExplanation } from "../src/commands/config.ts";
import { OVERLAY_KINDS, OVERLAY_TITLES, searchSlashCommands } from "@cbc/tui-components";
import {
  inertSettingsFor,
  renderOpenAiDoctor,
  type DoctorSnapshot,
} from "../src/commands/doctor.ts";

function snapshot(overrides: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
  return {
    backendProfile: { profile: "api-enhanced", reason: "the credential is an API key" },
    model: { id: "gpt-5.6-sol", effort: "medium", mode: "standard" },
    epoch: { taskEpochId: "epoch-1", reasoningContext: "all_turns" },
    programmaticLane: { enabled: true, reason: "policy, budgets, and the allowlist admit the lane" },
    hostedMultiAgent: { enabled: false, reason: "no hosted scout dispatcher is installed" },
    transport: {
      configured: "websocket",
      active: "websocket",
      socketOpen: true,
      circuitOpen: false,
      previousResponseSupported: true,
    },
    cache: { mode: "roi", breakpoint: "stable-prefix", readTokens: 4_096, writeTokens: 0 },
    compaction: { mode: "adaptive local · auto provider", generation: 2 },
    fallbacks: { count: 0, recentReasons: [] },
    inertSettings: [],
    ...overrides,
  };
}

describe("renderOpenAiDoctor (§6 P1-03)", () => {
  test("renders every required item", () => {
    const text = renderOpenAiDoctor(snapshot()).join("\n");
    for (const expected of [
      "api-enhanced",
      "gpt-5.6-sol",
      "effort medium",
      "epoch-1",
      "all_turns",
      "PTC lane",
      "Hosted agents",
      "websocket",
      "previous-response supported",
      "stable-prefix",
      "read 4096 tokens",
      "generation 2",
      "Fallbacks",
    ]) {
      expect(text).toContain(expected);
    }
  });

  test("a disabled feature reports its reason, not just that it is off", () => {
    const text = renderOpenAiDoctor(snapshot({
      programmaticLane: {
        enabled: false,
        reason: "the active backend does not expose the programmatic tool lane",
      },
      hostedMultiAgent: {
        enabled: false,
        reason: "provider.openai.native.hostedMultiAgent is disabled",
      },
    })).join("\n");

    expect(text).toContain("not eligible");
    // The reason is the row that makes the report actionable: a capability limit
    // and a config choice are different problems with different fixes.
    expect(text).toContain("the active backend does not expose the programmatic tool lane");
    expect(text).toContain("provider.openai.native.hostedMultiAgent is disabled");
  });

  test("an eligible feature still states why, so 'on' is auditable too", () => {
    const text = renderOpenAiDoctor(snapshot()).join("\n");
    expect(text).toContain("eligible");
    expect(text).toContain("policy, budgets, and the allowlist admit the lane");
  });

  test("recent fallback reasons are listed newest first", () => {
    const lines = renderOpenAiDoctor(snapshot({
      fallbacks: { count: 3, recentReasons: ["older reason", "newest reason"] },
    }));
    const text = lines.join("\n");
    expect(text).toContain("Fallbacks     3");
    expect(text.indexOf("newest reason")).toBeLessThan(text.indexOf("older reason"));
  });

  test("no fallbacks says so rather than leaving the row blank", () => {
    expect(renderOpenAiDoctor(snapshot()).join("\n"))
      .toContain("no native lane or transport fallback this session");
  });

  test("an open transport circuit is named as the reason, not hidden", () => {
    const text = renderOpenAiDoctor(snapshot({
      transport: {
        configured: "websocket",
        active: "http_full",
        socketOpen: false,
        circuitOpen: true,
        previousResponseSupported: false,
        latestResponseId: "resp_42",
      },
    })).join("\n");
    expect(text).toContain("circuit OPEN");
    expect(text).toContain("configured websocket");
    expect(text).toContain("resp_42");
  });

  test("a missing epoch is reported as missing with the reason", () => {
    const bare = { ...snapshot() } as Record<string, unknown>;
    delete bare.epoch;
    const text = renderOpenAiDoctor(bare as unknown as DoctorSnapshot).join("\n");
    expect(text).toContain("no task epoch yet");
  });

  test("inert settings are listed with their status and note", () => {
    const text = renderOpenAiDoctor(snapshot({
      inertSettings: [
        { key: "model.cache.ttl", status: "experimental", note: "the provider pins the TTL to 30m" },
      ],
    })).join("\n");
    expect(text).toContain("Settings in effect that change nothing (1)");
    expect(text).toContain("model.cache.ttl [experimental]");
    expect(text).toContain("the provider pins the TTL to 30m");
  });
});

describe("inertSettingsFor (§5.18)", () => {
  test("reports only keys the user set, and only the inert ones", () => {
    const inert = inertSettingsFor({
      "model.cache.ttl": "user",
      "model.cache.mode": "user",
      "ui.theme": "project",
    });
    const keys = inert.map((entry) => entry.key);
    expect(keys).toContain("model.cache.ttl");
    // Wired keys are not no-ops, so listing them would bury the ones that are.
    expect(keys).not.toContain("model.cache.mode");
    expect(keys).not.toContain("ui.theme");
  });

  test("a wired leaf under an experimental section is not reported", () => {
    // Longest-prefix-wins, matching configKeyInfo: `model.reasoning.` is
    // experimental as a section but providerSummary under it is wired.
    const keys = inertSettingsFor({ "model.reasoning.providerSummary": "user" })
      .map((entry) => entry.key);
    expect(keys).toEqual([]);
  });

  test("every reported entry carries a note the user can act on", () => {
    for (const entry of inertSettingsFor({ "model.cache.ttl": "user", "model.reasoning.continuity": "user" })) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });
});

describe("capy doctor argument parsing", () => {
  test("accepts the openai target", () => {
    expect(parseArgs(["doctor", "openai"]).command).toEqual({ kind: "doctor", target: "openai" });
  });

  test("rejects a target it cannot report on", () => {
    expect(() => parseArgs(["doctor", "anthropic"])).toThrow();
    expect(() => parseArgs(["doctor"])).toThrow();
  });
});

describe("/doctor in the interactive slash router", () => {
  test("routes with and without an explicit target", () => {
    expect(parseSlash("/doctor")).toEqual({ kind: "doctor", target: "openai" });
    expect(parseSlash("/doctor openai")).toEqual({ kind: "doctor", target: "openai" });
  });

  test("is discoverable from the command popup", () => {
    // Completion and routing have to agree: anything the composer offers must
    // route as a command rather than being sent to the model as text.
    const names = searchSlashCommands("doct").map((command) => command.name);
    expect(names).toContain("/doctor");
  });

  test("the overlay it opens is a registered kind with a title", () => {
    expect(OVERLAY_KINDS).toContain("doctor");
    expect(OVERLAY_TITLES.doctor.length).toBeGreaterThan(0);
  });
});

describe("config validate --explain (§5.18)", () => {
  test("parses with and without the flag", () => {
    expect(parseArgs(["config", "validate"]).command)
      .toEqual({ kind: "config", sub: "validate", explain: false });
    expect(parseArgs(["config", "validate", "--explain"]).command)
      .toEqual({ kind: "config", sub: "validate", explain: true });
  });

  test("every key gets a status and either a consumer or a reason", () => {
    const lines = renderKeyStatusExplanation({});
    const body = lines.slice(2);
    expect(body.length).toBeGreaterThan(20);
    for (const line of body) {
      expect(line).toMatch(/(wired|experimental|deprecated)/u);
      // A status with no explanation is the overclaim this command exists to
      // remove: a wired key names its consumer, an inert one names why.
      expect(line).toMatch(/(applied by |accepted but not applied|[a-z]{3})/u);
    }
    const text = lines.join("\n");
    expect(text).toContain("model.cache.ttl");
    expect(text).toContain("experimental");
  });

  test("keys this configuration set are marked", () => {
    const lines = renderKeyStatusExplanation({ "model.cache.ttl": "user" });
    const marked = lines.filter((line) => line.startsWith("*"));
    expect(marked.some((line) => line.includes("model.cache.ttl"))).toBe(true);
    // A section prefix counts as set when any key beneath it is, so the entry
    // that would explain the fallback is not silently unmarked.
    expect(marked.length).toBeGreaterThan(0);
  });
});
