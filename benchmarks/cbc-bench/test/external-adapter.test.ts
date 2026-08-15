import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent, EventSequencer } from "@cbc/protocol";
import { profileById, type BenchTask } from "@cbc/evals";

import {
  createExternalBenchmarkRunner,
  parseExternalBenchmarkAdapter,
  type BenchmarkEnvironment,
} from "../src/execution.ts";
import { resolveExecutionProfile } from "../src/profile.ts";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const IMPLEMENTATION_DIGEST = digest("external-adapter-fixture");

function profile() {
  const value = profileById("standard-medium");
  if (value === undefined) throw new Error("standard-medium profile missing");
  return value;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    id: "matched-runner",
    version: "1.2.3",
    program: process.execPath,
    args: ["run", "adapter.ts", "{input}", "{output}"],
    appliedProfile: profile(),
    capabilityDigest: "capability-digest",
    implementationDigest: IMPLEMENTATION_DIGEST,
    passEnvironment: [],
    ...overrides,
  };
}

const TASK: BenchTask = {
  id: "external-adapter-fixture",
  category: "repository_understanding",
  language: "typescript",
  title: "External adapter fixture",
  snapshot: "generated/external-adapter-fixture",
  generatedSnapshot: {
    generator: "cbc-bench",
    version: "1.0",
    template: "repository-understanding",
    parameters: { index: 1 },
  },
  prompt: "Summarize the fixture and produce a valid external trace.",
  acceptance: [{ program: "cbc-bench-check", args: [] }],
  network: "deny",
  expectedScope: ["ANSWER.md"],
  expectedEvidence: { reportMentions: ["fixture"] },
  budget: { maxWallTimeMs: 10_000, maxTotalTokens: 1_000, maxToolCalls: 2 },
  risks: [],
};

describe("neutral external benchmark adapter", () => {
  test("binds an absolute shell-free adapter to profile, capability, and implementation evidence", () => {
    const applied = profile();
    const adapter = parseExternalBenchmarkAdapter(
      manifest({ passEnvironment: ["TEST_ALLOWED_ENV"] }),
      applied,
      "capability-digest",
    );

    expect(adapter.id).toBe("matched-runner");
    expect(adapter.version).toBe("1.2.3");
    expect(adapter.program).toBe(process.execPath);
    expect(adapter.appliedProfile).toEqual(applied);
    expect(adapter.passEnvironment).toEqual(["TEST_ALLOWED_ENV"]);
    expect(adapter.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("rejects relative programs, missing exchange paths, profile drift, and executable-control env", () => {
    const applied = profile();
    expect(() => parseExternalBenchmarkAdapter(
      manifest({ program: "runner" }),
      applied,
      "capability-digest",
    )).toThrow("absolute path");

    expect(() => parseExternalBenchmarkAdapter(
      manifest({ args: ["{input}"] }),
      applied,
      "capability-digest",
    )).toThrow("{output}");

    expect(() => parseExternalBenchmarkAdapter(
      manifest({ appliedProfile: { ...applied, reasoningEffort: "high" } }),
      applied,
      "capability-digest",
    )).toThrow("profile does not match");

    expect(() => parseExternalBenchmarkAdapter(
      manifest({ passEnvironment: ["NODE_OPTIONS"] }),
      applied,
      "capability-digest",
    )).toThrow("executable-control");
  });

  test("rejects a persisted manifest digest that does not match the canonical adapter body", () => {
    expect(() => parseExternalBenchmarkAdapter(
      manifest({ manifestDigest: digest("tampered-adapter-manifest") }),
      profile(),
      "capability-digest",
    )).toThrow("manifestDigest");
  });

  test("executes through file exchange, strips undeclared host values, and validates CBC events", async () => {
    const root = await mkdtemp(join(tmpdir(), "cbc-external-adapter-"));
    const previousValue = process.env.UNDECLARED_TEST_ENV;
    process.env.UNDECLARED_TEST_ENV = "opaque-test-value";
    try {
      const environment: BenchmarkEnvironment = {
        root,
        data: join(root, "data"),
        cache: join(root, "cache"),
        logs: join(root, "logs"),
      };
      await Promise.all([
        mkdir(environment.data, { recursive: true }),
        mkdir(environment.cache, { recursive: true }),
        mkdir(environment.logs, { recursive: true }),
      ]);
      const event = createEvent(
        new EventSequencer(0),
        "turn.completed",
        { status: "completed" },
        { sessionId: "external-session", turnId: "external-turn" },
      );
      const script = join(root, "adapter.ts");
      await writeFile(script, [
        "const inputPath = Bun.argv[2];",
        "const outputPath = Bun.argv[3];",
        "if (process.env.UNDECLARED_TEST_ENV) throw new Error('host value leaked');",
        "const input = await Bun.file(inputPath).json();",
        `const event = ${JSON.stringify(event)};`,
        "await Bun.write(outputPath, JSON.stringify({",
        "  schemaVersion: '1.0',",
        "  executionId: input.executionId,",
        "  adapterId: input.adapter.id,",
        "  adapterVersion: input.adapter.version,",
        "  adapterManifestDigest: input.adapter.manifestDigest,",
        "  capabilityDigest: input.capabilityDigest,",
        "  taskId: input.task.id,",
        "  profileId: input.profile.id,",
        "  startedAtMs: 100,",
        "  finishedAtMs: 250,",
        "  exitCode: 0,",
        "  events: [event],",
        "}));",
        "",
      ].join("\n"), "utf8");

      const applied = profile();
      const adapter = parseExternalBenchmarkAdapter(
        manifest({
          id: "fake-external-runner",
          program: process.execPath,
          args: ["run", script, "{input}", "{output}"],
        }),
        applied,
        "capability-digest",
      );
      const runner = createExternalBenchmarkRunner({
        repositoryRoot: root,
        benchmarkRoot: root,
        executionProfile: resolveExecutionProfile(applied),
        environment,
        concurrency: 1,
        keepWorkspaces: true,
        adapter,
      });
      const execution = await runner.execute({
        task: TASK,
        profile: applied,
        workspace: root,
        signal: new AbortController().signal,
      });

      expect(execution.startedAtMs).toBe(100);
      expect(execution.finishedAtMs).toBe(250);
      expect(execution.exitCode).toBe(0);
      expect(execution.events).toHaveLength(1);
      expect(execution.events[0]?.kind).toBe("turn.completed");
    } finally {
      if (previousValue === undefined) delete process.env.UNDECLARED_TEST_ENV;
      else process.env.UNDECLARED_TEST_ENV = previousValue;
      await rm(root, { recursive: true, force: true });
    }
  });
});
