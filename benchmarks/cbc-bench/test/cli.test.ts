import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capabilitySnapshotDigest, profileById } from "@cbc/evals";

import { cbcBench } from "../src/cli.ts";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("cbc-bench CLI wiring", () => {
  test("paired refuses to fabricate capability evidence", async () => {
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    cleanups.push(() => error.mockRestore());

    expect(await cbcBench(["paired"])).toBe(2);
    expect(errors.join("\n")).toContain("--capability-snapshot");
  });

  test("run fails closed for an eval axis the product cannot apply", async () => {
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    cleanups.push(() => error.mockRestore());

    expect(await cbcBench(["run", "--profile", "all-tools"])).toBe(2);
    expect(errors.join("\n")).toContain("cannot be applied faithfully");
  });

  test("profiles reports unsupported comparisons instead of pretending they are wired", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    cleanups.push(() => log.mockRestore());

    expect(await cbcBench(["profiles"])).toBe(0);
    expect(lines.some((line) => line.includes("all-tools") && line.includes("[unsupported]"))).toBe(true);
    expect(lines.some((line) => line.includes("standard-medium") && line.includes("[wired]"))).toBe(true);
  });

  test("matched competitor comparison requires an explicit neutral adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbc-bench-adapter-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const capabilityPath = join(directory, "capabilities.json");
    await Bun.write(capabilityPath, JSON.stringify({
      backend: "api",
      capturedAt: "2026-08-12T00:00:00.000Z",
      capabilities: { websocket: true },
    }));
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    cleanups.push(() => error.mockRestore());

    expect(await cbcBench([
      "paired",
      "--comparison",
      "external_backbone_matched",
      "--capability-snapshot",
      capabilityPath,
    ])).toBe(2);
    expect(errors.join("\n")).toContain("--baseline-adapter");
  });

  test("matched competitor adapter is bound to the exact profile and capability snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbc-bench-adapter-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const capability = {
      backend: "api",
      capturedAt: "2026-08-12T00:00:00.000Z",
      capabilities: { websocket: true },
    } as const;
    const capabilityPath = join(directory, "capabilities.json");
    const adapterPath = join(directory, "adapter.json");
    await Bun.write(capabilityPath, JSON.stringify(capability));
    const wrongProfile = profileById("standard-high");
    if (wrongProfile === undefined) throw new Error("standard-high profile missing");
    await Bun.write(adapterPath, JSON.stringify({
      schemaVersion: "1.1",
      id: "mismatched-adapter",
      identity: {
        product: "codex_cli",
        version: "1.0.0",
        model: wrongProfile.model,
        authSurface: "openai-api-key",
        mode: "backbone_matched",
      },
      program: process.execPath,
      args: ["run", "runner.ts", "{input}", "{output}"],
      appliedProfile: wrongProfile,
      capabilityDigest: capabilitySnapshotDigest(capability),
      implementationDigest: capabilitySnapshotDigest({
        backend: "adapter",
        capturedAt: "2026-08-12T00:00:00.000Z",
        capabilities: { fixture: true },
      }),
      passEnvironment: [],
    }));
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    cleanups.push(() => error.mockRestore());

    expect(await cbcBench([
      "paired",
      "--comparison",
      "external_backbone_matched",
      "--capability-snapshot",
      capabilityPath,
      "--baseline-adapter",
      adapterPath,
    ])).toBe(2);
    expect(errors.join("\n")).toContain("profile does not match");
  });

  test("gate routes legacy summaries through strict release-evidence inspection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbc-bench-cli-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const candidate = join(directory, "candidate.json");
    await Bun.write(
      candidate,
      JSON.stringify({
        summary: {
          profile: "candidate",
          taskCount: 1,
        },
        skipped: [],
        results: [{ taskId: "task-1" }],
      }),
    );

    const errors: string[] = [];
    const output: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      output.push(String(value));
    });
    cleanups.push(() => error.mockRestore());
    cleanups.push(() => log.mockRestore());

    expect(await cbcBench(["gate", "--candidate", candidate])).toBe(1);
    expect(output.join("\n")).toContain("release evidence: legacy");
    expect(errors.join("\n")).toContain("requires a paired result artifact");
  });
});

describe("§5.27 cohort selection", () => {
  test("coverage reports the openai-native cohort instead of the release mix", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    cleanups.push(() => log.mockRestore());

    expect(await cbcBench(["coverage", "--cohort", "openai-native"])).toBe(0);
    const rendered = lines.join("\n");
    expect(rendered).toContain("11 task(s) of 150 target");
    // Eleven tasks are not the release distribution, and the report says so rather
    // than presenting the cohort as the benchmark.
    expect(rendered).toContain("below the §26.2 target");
  });

  test("an unknown cohort is refused before anything runs", async () => {
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    cleanups.push(() => error.mockRestore());

    expect(await cbcBench(["coverage", "--cohort", "nonsense"])).toBe(2);
    expect(errors.join("\n")).toContain("--cohort must be one of release, openai-native");
  });

  test("a cohort task id is unreachable from the release cohort", async () => {
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    cleanups.push(() => error.mockRestore());

    // §5.27's tasks reuse the release categories, so the release cohort has to stay
    // closed: a cohort id matching nothing here is what keeps its composition fixed.
    expect(await cbcBench(["run", "--filter", "on-ptc-aggregation"])).toBe(2);
    expect(errors.join("\n")).toContain("no task matches 'on-ptc-aggregation' in the release cohort");
  });

  test("the cohort flag is documented in the usage text", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    cleanups.push(() => log.mockRestore());

    expect(await cbcBench(["help"])).toBe(0);
    expect(lines.join("\n")).toContain("--cohort <id>");
  });
});
