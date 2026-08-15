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
      "codex_matched",
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
      schemaVersion: "1.0",
      id: "mismatched-adapter",
      version: "1.0.0",
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
      "codex_matched",
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
