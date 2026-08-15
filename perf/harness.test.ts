import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "./cli.ts";
import {
  SCENARIO_NAMES,
  runPerformanceHarness,
  summarizeDurations,
} from "./harness.ts";

describe("performance harness statistics", () => {
  test("uses deterministic nearest-rank median and p95", () => {
    expect(summarizeDurations([9, 1, 4, 2, 8])).toEqual({
      samples: 5,
      medianMs: 4,
      p95Ms: 9,
      minMs: 1,
      maxMs: 9,
    });
    expect(summarizeDurations([])).toEqual({
      samples: 0,
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
    });
  });

  test("parses quick and selected-scenario CLI options", () => {
    expect(parseCliArgs(["--quick", "--pretty", "--scenario", "giant-markdown,idle-frame-surrogate"])).toEqual({
      mode: "quick",
      pretty: true,
      scenarios: ["giant-markdown", "idle-frame-surrogate"],
      help: false,
      list: false,
    });
    expect(() => parseCliArgs(["--scenario", "not-real"])).toThrow("unknown scenario");
  });
});

describe("counter-first regression suite", () => {
  test(
    "quick mode exercises every scenario without timing-sensitive gates",
    async () => {
      const report = await runPerformanceHarness({ mode: "quick" });
      expect(report.pass).toBe(true);
      expect(report.summary.failed).toBe(0);
      expect(report.scenarios.map((scenario) => scenario.name)).toEqual([...SCENARIO_NAMES]);

      for (const scenario of report.scenarios) {
        expect(scenario.pass).toBe(true);
        expect(scenario.gates.length).toBeGreaterThan(0);
        expect(Object.keys(scenario.timings).length).toBeGreaterThan(0);
        for (const timing of Object.values(scenario.timings)) {
          expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.medianMs);
          expect(timing.maxMs).toBeGreaterThanOrEqual(timing.minMs);
        }
      }

      const batching = report.scenarios.find(
        (scenario) => scenario.name === "session-recorder-batching",
      );
      expect(batching?.correctness).toMatchObject({
        countShapeExact: true,
        byteShapeExact: true,
        everyBatchWithinLimits: true,
      });

      const projection = report.scenarios.find(
        (scenario) => scenario.name === "projected-timeline",
      );
      expect(projection?.correctness).toMatchObject({
        lengthsExact: true,
        groupCountsExact: true,
        viewportRowsBounded: true,
      });
    },
    30_000,
  );
});
