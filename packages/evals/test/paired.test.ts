import { describe, expect, test } from "bun:test";

import {
  EVAL_PROFILES,
  buildPairedSchedule,
  runPairedSuite,
  type BenchTask,
  type CapabilitySnapshot,
} from "../src/index.ts";
import { createEvent, EventSequencer } from "@cbc/protocol";

const profiles = {
  baseline: EVAL_PROFILES[0]!,
  candidate: EVAL_PROFILES[1]!,
};

const task: BenchTask = {
  id: "paired-example",
  category: "local_bug_fix",
  language: "typescript",
  title: "Paired example",
  snapshot: "tasks/paired-example",
  prompt: "Fix the example.",
  acceptance: [{ program: "bun", args: ["test"] }],
  network: "deny",
  expectedScope: ["src/example.ts"],
  expectedEvidence: { reportMentions: ["example"] },
  budget: { maxWallTimeMs: 10_000, maxTotalTokens: 1_000, maxToolCalls: 4 },
  risks: [],
};

describe("paired A/B schedule", () => {
  test("ABBA balances variants and labels the first occurrence cold", () => {
    const schedule = buildPairedSchedule(profiles, { repetitions: 2, order: "abba" });
    expect(schedule.map((run) => run.variant)).toEqual([
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
    expect(schedule.map((run) => run.repetition)).toEqual([1, 1, 2, 2]);
    expect(schedule.map((run) => run.temperature)).toEqual(["cold", "cold", "warm", "warm"]);
  });

  test("odd repetition counts remain balanced", () => {
    const schedule = buildPairedSchedule(profiles, { repetitions: 3 });
    expect(schedule).toHaveLength(6);
    expect(schedule.filter((run) => run.variant === "baseline")).toHaveLength(3);
    expect(schedule.filter((run) => run.variant === "candidate")).toHaveLength(3);
  });

  test("seeded randomized order is stable and balanced", () => {
    const first = buildPairedSchedule(profiles, {
      repetitions: 8,
      order: "seeded_randomized",
      seed: "release-2026-08",
    });
    const second = buildPairedSchedule(profiles, {
      repetitions: 8,
      order: "seeded_randomized",
      seed: "release-2026-08",
    });
    expect(first.map((run) => run.variant)).toEqual(second.map((run) => run.variant));
    expect(first.filter((run) => run.variant === "baseline")).toHaveLength(8);
    expect(first.filter((run) => run.variant === "candidate")).toHaveLength(8);
    expect(first.every((run) => run.seed === "release-2026-08")).toBe(true);
  });

  test("randomized order requires a seed and repetitions must be positive", () => {
    expect(() => buildPairedSchedule(profiles, {
      repetitions: 2,
      order: "seeded_randomized",
    })).toThrow("requires an explicit seed");
    expect(() => buildPairedSchedule(profiles, { repetitions: 0 })).toThrow(
      "positive integer",
    );
  });

  test("custom thermal policies can label comparable repetitions", () => {
    const schedule = buildPairedSchedule(profiles, {
      repetitions: 2,
      thermalPolicy: ({ repetition }) => repetition === 1 ? "warm" : "cold",
    });
    expect(schedule.map((run) => run.temperature)).toEqual(["warm", "warm", "cold", "cold"]);
  });
});

describe("paired A/B runner", () => {
  test("runs sequential repetitions and records capability metadata", async () => {
    const seen: string[] = [];
    const capabilities = {
      websocket: true,
      previousResponse: true,
      transport: "websocket",
    };
    const snapshot: CapabilitySnapshot = {
      backend: "openai-api",
      provider: "openai",
      capturedAt: "2026-08-12T00:00:00.000Z",
      capabilities,
      metadata: { region: "ap-northeast" },
    };
    const sequencer = new EventSequencer(0);

    const result = await runPairedSuite([task], profiles, {
      repetitions: 2,
      order: "abba",
      capabilitySnapshot: snapshot,
      requireCompleteCoverage: false,
      beforeRun: (run) => {
        seen.push(`before:${run.variant}:${run.repetition}:${run.temperature}`);
      },
      runner: (run) => ({
        appliedProfile: run.profile,
        prepare: async () => `/tmp/${run.variant}-${run.repetition}`,
        execute: async () => ({
          events: [createEvent(sequencer, "turn.completed", { status: "completed" }, {
            sessionId: `ses-${run.sequence}`,
            timestamp: "2026-08-12T00:00:01.000Z",
          })],
          startedAtMs: 0,
          finishedAtMs: run.variant === "baseline" ? 10 : 8,
          exitCode: 0,
        }),
        acceptance: async () => [{
          label: "bun test",
          passed: true,
          wasPassingBefore: false,
        }],
      }),
      afterRun: (run) => {
        seen.push(`after:${run.variant}:${run.repetition}:${run.temperature}`);
      },
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
    });

    expect(result.runs).toHaveLength(4);
    expect(result.aggregate.baseline.taskCount).toBe(2);
    expect(result.aggregate.candidate.taskCount).toBe(2);
    expect(result.aggregate.gate.status).toBe("passed");
    expect(result.capabilitySnapshot).toEqual(snapshot);
    expect(result.capabilitySnapshot.capabilities).not.toBe(capabilities);
    expect(seen).toEqual([
      "before:baseline:1:cold",
      "after:baseline:1:cold",
      "before:candidate:1:cold",
      "after:candidate:1:cold",
      "before:candidate:2:warm",
      "after:candidate:2:warm",
      "before:baseline:2:warm",
      "after:baseline:2:warm",
    ]);
  });
});
