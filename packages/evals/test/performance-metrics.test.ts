import { describe, expect, test } from "bun:test";

import { deriveMetrics } from "../src/index.ts";
import { createEvent, EventSequencer, type CbcEvent, type CbcEventKind } from "@cbc/protocol";

function events(
  entries: ReadonlyArray<{
    readonly kind: CbcEventKind;
    readonly atMs: number;
    readonly payload?: Record<string, unknown>;
    readonly agentId?: string;
  }>,
): CbcEvent[] {
  const sequencer = new EventSequencer(0);
  return entries.map((entry) => createEvent(
    sequencer,
    entry.kind,
    entry.payload ?? {},
    {
      sessionId: "ses-performance",
      timestamp: new Date(entry.atMs).toISOString(),
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
    },
  ));
}

function derive(stream: readonly CbcEvent[], startedAtMs = 1_000, finishedAtMs = 3_000) {
  return deriveMetrics({
    taskId: "performance",
    profile: "candidate",
    events: stream,
    startedAtMs,
    finishedAtMs,
    acceptance: [],
    expectedScope: [],
    expectedApprovals: [],
    expectedEvidence: { reportMentions: [] },
  });
}

describe("performance cost metrics", () => {
  test("derives provider, payload, tool, verification, and review timings", () => {
    const metrics = derive(events([
      {
        kind: "repository.orientation_completed",
        atMs: 1_100,
        payload: { durationMs: 100, state: "provisional" },
      },
      { kind: "prompt.compile_completed", atMs: 1_200, payload: { durationMs: 100 } },
      { kind: "prompt.compile_completed", atMs: 1_250, payload: { durationMs: 100 } },
      { kind: "tool.started", atMs: 1_250, payload: { callId: "a" } },
      {
        kind: "provider.request_sent",
        atMs: 1_300,
        payload: { payloadBytes: 999, fullPayloadBytes: 110, previousResponse: false },
      },
      { kind: "tool.started", atMs: 1_300, payload: { callId: "b" } },
      {
        kind: "provider.connection_ready",
        atMs: 1_320,
        payload: { connectionReused: true, durationMs: 20 },
      },
      { kind: "provider.response_created", atMs: 1_350, payload: { durationMs: 50 } },
      { kind: "provider.first_delta", atMs: 1_450, payload: { durationMs: 150 } },
      { kind: "tool.completed", atMs: 1_500, payload: { callId: "b", durationMs: 200 } },
      { kind: "tool.completed", atMs: 1_550, payload: { callId: "a", durationMs: 200 } },
      { kind: "provider.response_completed", atMs: 1_800, payload: { durationMs: 500 } },
      {
        kind: "provider.request_sent",
        atMs: 1_900,
        payload: { payloadBytes: 25, previousResponse: true },
      },
      { kind: "review.started", atMs: 2_100, payload: {} },
      { kind: "provider.response_completed", atMs: 2_200, payload: { durationMs: 300 } },
      {
        kind: "verification.completed",
        atMs: 2_400,
        payload: { durationMs: 200, source: "verification.run_many" },
      },
      {
        kind: "review.completed",
        atMs: 2_400,
        payload: { durationMs: 300, inputBytes: 40, status: "passed" },
      },
      {
        kind: "review.completed",
        atMs: 2_450,
        payload: { durationMs: 0, inputBytes: 0, status: "skipped" },
      },
      { kind: "verification.completed", atMs: 2_500, payload: { durationMs: 400 } },
      { kind: "provider.fallback", atMs: 2_600, payload: { reason: "closed" } },
      { kind: "run.trace_completed", atMs: 2_900, payload: { modelSteps: 2 } },
    ]));

    expect(metrics.cost).toMatchObject({
      timeToFirstProviderRequestMs: 300,
      timeToResponseCreatedMs: 350,
      timeToFirstProviderDeltaMs: 450,
      preProviderLocalMs: 300,
      repositoryWaitMs: 100,
      promptCompileMs: 150,
      providerWallMs: 800,
      fullPayloadBytes: 110,
      incrementalPayloadBytes: 25,
      providerRequests: 2,
      modelSteps: 2,
      reusedConnections: 1,
      providerFallbacks: 1,
      toolActiveMs: 250,
      toolWaitMs: 100,
      verificationWallMs: 400,
      reviewWallMs: 300,
      reviewCalls: 1,
      reviewInputBytes: 40,
      provisionalContextTurns: 1,
      totalWallTimeMs: 2_000,
    });
  });

  test("empty and inverted runs produce safe zero or undefined values", () => {
    const metrics = derive([], 2_000, 1_000);
    expect(metrics.cost.totalWallTimeMs).toBe(0);
    expect(metrics.cost.preProviderLocalMs).toBe(0);
    expect(metrics.cost.timeToFirstProviderRequestMs).toBeUndefined();
    expect(metrics.cost.timeToResponseCreatedMs).toBeUndefined();
    expect(metrics.cost.timeToFirstProviderDeltaMs).toBeUndefined();
    expect(metrics.cost.providerRequests).toBe(0);
    expect(metrics.cost.providerWallMs).toBe(0);
    expect(metrics.cost.toolActiveMs).toBe(0);
    expect(metrics.cost.toolWaitMs).toBe(0);
  });

  test("model step count falls back to provider requests for older journals", () => {
    const metrics = derive(events([
      { kind: "provider.request_sent", atMs: 1_100, payload: { payloadBytes: 10 } },
      { kind: "provider.request_sent", atMs: 1_200, payload: { payloadBytes: 5 } },
    ]));
    expect(metrics.cost.modelSteps).toBe(2);
  });
});

describe("route and native lane metrics", () => {
  test("ingests the turn's route receipt, lane fallback, and program calls", () => {
    const metrics = derive(events([
      { kind: "provider.request_sent", atMs: 1_100, payload: { payloadBytes: 10 } },
      {
        kind: "native_lane.fallback",
        atMs: 1_150,
        payload: {
          routeId: "route-1",
          requestedLane: "program_tool_calling",
          selectedLane: "direct",
          reason: "program lane is unsupported on this account",
        },
      },
      { kind: "program.started", atMs: 1_160, payload: { programId: "p1" } },
      { kind: "program.tool_call_started", atMs: 1_170, payload: { programId: "p1" } },
      { kind: "program.tool_call_admitted", atMs: 1_175, payload: { programId: "p1" } },
      { kind: "program.tool_call_started", atMs: 1_178, payload: { programId: "p1" } },
      { kind: "program.tool_call_denied", atMs: 1_180, payload: { programId: "p1" } },
      { kind: "program.completed", atMs: 1_200, payload: { programId: "p1" } },
      { kind: "tool.started", atMs: 1_200, payload: { callId: "a" } },
      { kind: "tool.started", atMs: 1_210, payload: { callId: "b" } },
      { kind: "tool.completed", atMs: 1_400, payload: { callId: "b", durationMs: 190 } },
      { kind: "tool.completed", atMs: 1_500, payload: { callId: "a", durationMs: 300 } },
      { kind: "provider.response_completed", atMs: 1_600, payload: { durationMs: 500 } },
      { kind: "task.created", atMs: 1_650, payload: { taskId: "child-1" } },
      {
        kind: "turn.completed",
        atMs: 2_000,
        payload: {
          status: "completed",
          routeReceipt: {
            routeId: "route-1",
            planned: {
              model: "gpt-5.6",
              lane: "program_tool_calling",
              maxAgents: 3,
              maxParallelTools: 4,
            },
            actual: {
              model: "gpt-5.6",
              lane: "direct",
              agentsSpawned: 1,
              parallelPeak: 2,
              fallbackReasons: ["program lane is unsupported on this account"],
            },
          },
        },
      },
    ]));

    expect(metrics.route).toMatchObject({
      routeId: "route-1",
      plannedLane: "program_tool_calling",
      actualLane: "direct",
      lanePlanHonored: false,
      plannedMaxAgents: 3,
      plannedMaxParallelTools: 4,
      agentsSpawned: 1,
      parallelPeak: 2,
      laneFallbacks: 1,
      programLaneFallbacks: 1,
      programsStarted: 1,
      programsCompleted: 1,
      programCalls: 2,
      programCallsAdmitted: 1,
      programCallsDenied: 1,
    });
    expect(metrics.route.fallbackReasons).toEqual([
      "program lane is unsupported on this account",
    ]);
    // Two program-lane attempts were made (the plan plus the fallback), one lost.
    expect(metrics.route.ptcFallbackRate).toBeCloseTo(1 / 3, 8);
    // Something was in flight only from the first request (1_100) to its response
    // (1_600) — the tool calls overlap that window — so of the run's 2_000 ms span,
    // 1_500 ms had nothing in flight at all.
    expect(metrics.route.idleWaitMs).toBe(1_500);
  });

  test("a journal with no receipt reports an unviolated plan rather than a failure", () => {
    const metrics = derive(events([
      { kind: "tool.started", atMs: 1_100, payload: { callId: "a" } },
      { kind: "tool.completed", atMs: 1_200, payload: { callId: "a", durationMs: 100 } },
    ]));

    expect(metrics.route.lanePlanHonored).toBe(true);
    expect(metrics.route.plannedLane).toBeUndefined();
    expect(metrics.route.actualLane).toBeUndefined();
    expect(metrics.route.laneFallbacks).toBe(0);
    expect(metrics.route.ptcFallbackRate).toBe(0);
    expect(metrics.route.parallelPeak).toBe(1);
  });

  test("a lane selection that honors the plan records no fallback", () => {
    const metrics = derive(events([
      {
        kind: "native_lane.selected",
        atMs: 1_100,
        payload: { routeId: "route-2", lane: "program_tool_calling", maxAgents: 2 },
      },
      {
        kind: "turn.completed",
        atMs: 1_900,
        payload: {
          status: "completed",
          routeReceipt: {
            routeId: "route-2",
            planned: { lane: "program_tool_calling", maxAgents: 2, maxParallelTools: 2 },
            actual: { lane: "program_tool_calling", agentsSpawned: 0, parallelPeak: 1, fallbackReasons: [] },
          },
        },
      },
    ]));

    expect(metrics.route.lanePlanHonored).toBe(true);
    expect(metrics.route.laneSelections).toBe(1);
    expect(metrics.route.laneFallbacks).toBe(0);
    expect(metrics.route.programLaneFallbacks).toBe(0);
    expect(metrics.route.ptcFallbackRate).toBe(0);
  });
});
