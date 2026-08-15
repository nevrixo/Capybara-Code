import { describe, expect, test } from "bun:test";

import { loadConfig, type ConfigLayer } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import { V13_EVENT_KINDS } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

interface JournalWireEvent {
  readonly id: string;
  readonly kind: string;
}

function journalRuntime() {
  const journal: JournalWireEvent[] = [];
  let durableSequence = 0;
  const runtime = {
    workspace: "/work",
    appendEvents: async (params: { events?: readonly JournalWireEvent[] }) => {
      const batch = [...(params.events ?? [])];
      journal.push(...batch.map((event) => ({ ...event })));
      const events = batch.map((event) => ({ id: event.id, sequence: ++durableSequence }));
      return { appended: batch.length, lastSequence: durableSequence, events };
    },
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
  return { runtime, journal };
}

async function runTurn(
  sessionId: string,
  overrides: ConfigLayer,
): Promise<readonly JournalWireEvent[]> {
  const { runtime, journal } = journalRuntime();
  const config = loadConfig({
    projectTrusted: true,
    env: {},
    sessionOverrides: {
      "agent.reviewMode": "off",
      ...overrides,
    },
  }).config;
  let now = 10_000;
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: runtime as never,
    config,
    workspacePath: "/work",
    workspaceIdentityDigest: "f".repeat(64),
    trust: "trusted-always",
    sessionId,
    provider: new MockProvider({ steps: [{ text: "Done." }] }),
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
  });

  await session.submit("Answer without tools", new AbortController().signal);
  await session.flush();
  await session.close();
  return journal;
}

const V13_KINDS = new Set<string>(V13_EVENT_KINDS);
const PERFORMANCE_LIFECYCLE_KINDS = new Set<string>([
  "run.trace_started",
  "run.trace_completed",
  "repository.orientation_started",
  "repository.orientation_completed",
  "repository.full_scan_started",
  "repository.full_scan_completed",
  "context.prepare_started",
  "context.prepare_completed",
  "prompt.compile_started",
  "prompt.compile_completed",
  "provider.connection_started",
  "provider.connection_ready",
  "provider.request_sent",
  "provider.response_created",
  "provider.first_delta",
  "provider.response_completed",
  "provider.fallback",
]);
const AUDIT_EVIDENCE_KINDS = [
  "verification.started",
  "verification.completed",
  "review.started",
  "review.completed",
] as const;

function v13Kinds(events: readonly JournalWireEvent[]): string[] {
  return events
    .map((event) => event.kind)
    .filter((kind) => V13_KINDS.has(kind))
    .sort();
}

function performanceLifecycleKinds(events: readonly JournalWireEvent[]): string[] {
  return events
    .map((event) => event.kind)
    .filter((kind) => PERFORMANCE_LIFECYCLE_KINDS.has(kind))
    .sort();
}

describe("AgentSession performance event recording", () => {
  test.each([
    ["telemetry disabled", { "perf.telemetry": false, "perf.sampleRate": 1 }],
    ["zero sample rate", { "perf.telemetry": true, "perf.sampleRate": 0 }],
  ] as const)("does not journal performance lifecycle events when %s", async (_label, overrides) => {
    const events = await runTurn(`perf-off-${_label.replaceAll(" ", "-")}`, overrides);

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "assistant.final")).toBe(true);
    expect(performanceLifecycleKinds(events)).toEqual([]);
    expect(v13Kinds(events)).toEqual(expect.arrayContaining([
      "reasoning.epoch_started",
      "context.plan_created",
      "context.evidence_selected",
      "context.pack_compiled",
      "cache.plan_created",
    ]));
  });

  test("recordDecisions=false suppresses only route decisions", async () => {
    const recorded = await runTurn("route-recorded", {
      "perf.telemetry": true,
      "perf.sampleRate": 1,
      "model.router.recordDecisions": true,
    });
    const suppressed = await runTurn("route-suppressed", {
      "perf.telemetry": true,
      "perf.sampleRate": 1,
      "model.router.recordDecisions": false,
    });

    const recordedKinds = v13Kinds(recorded);
    const suppressedKinds = v13Kinds(suppressed);
    expect(recordedKinds.filter((kind) => kind === "model.route_decided")).toHaveLength(1);
    expect(suppressedKinds).not.toContain("model.route_decided");
    expect(suppressedKinds.filter((kind) => kind === "model.capability_snapshot")).toHaveLength(1);
    expect(recordedKinds.filter((kind) => kind !== "model.route_decided")).toEqual(suppressedKinds);
  });

  test("keeps verification and review evidence when telemetry is disabled", async () => {
    const { runtime, journal } = journalRuntime();
    Object.assign(runtime, {
      issueCapability: async () => ({ id: "cap_write" }),
      beginTransaction: async () => ({ transactionId: "tx_write" }),
      write: async () => ({ stagedPaths: ["README.md"] }),
      commitTransaction: async () => ({
        operations: [{ path: "README.md", additions: 1, deletions: 0 }],
        totalAdditions: 1,
        totalDeletions: 0,
      }),
      rollbackTransaction: async () => undefined,
      glob: async () => ({
        entries: [{ path: "README.md", bytes: 8, binary: false, tracked: true }],
        truncated: false,
      }),
      gitDiff: async () => ({
        files: [{
          path: "README.md",
          additions: 1,
          deletions: 0,
          patch: "+updated",
        }],
      }),
    });
    const config = loadConfig({
      projectTrusted: true,
      env: {},
      sessionOverrides: {
        "perf.telemetry": false,
        "perf.sampleRate": 1,
        "agent.reviewMode": "auto",
        "agent.verification.reviewPolicy": "always",
      },
    }).config;
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "write-readme",
            name: "fs.write",
            arguments: { path: "README.md", content: "updated", intent: "upsert" },
          }],
        },
        { text: "Updated README." },
        { text: JSON.stringify({ summary: "No issues found.", findings: [] }) },
      ],
    });
    let now = 20_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config,
      workspacePath: "/work",
      workspaceIdentityDigest: "a".repeat(64),
      trust: "trusted-always",
      sessionId: "perf-off-audit-evidence",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
    });
    session.registry.activate(["fs.write"]);

    await session.submit("Update README.md", new AbortController().signal);
    await session.flush();
    await session.close();

    const kinds = journal.map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(AUDIT_EVIDENCE_KINDS));
    expect(performanceLifecycleKinds(journal)).toEqual([]);
  });
});
