import { describe, expect, test } from "bun:test";

import {
  pathIndexInvalidationForEvent,
  persistAndRefreshResumeCandidates,
  prepareSessionReplacement,
  SessionPersistenceQueue,
} from "../src/commands/interactive.ts";

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("interactive session lifecycle", () => {
  test("path index invalidation covers transactions, shells, processes, and background jobs", () => {
    const processCalls = new Set<string>();

    expect(pathIndexInvalidationForEvent(
      { kind: "tool.started", payload: { callId: "read", toolId: "fs.read" } },
      processCalls,
    )).toEqual({ dirty: false, refreshNow: false });
    expect(pathIndexInvalidationForEvent(
      { kind: "tool.started", payload: { callId: "run", toolId: "process.run" } },
      processCalls,
    )).toEqual({ dirty: false, refreshNow: false });
    expect(pathIndexInvalidationForEvent(
      { kind: "tool.completed", payload: { callId: "run" } },
      processCalls,
    )).toEqual({ dirty: true, refreshNow: false });
    expect(pathIndexInvalidationForEvent(
      { kind: "tool.completed", payload: { callId: "read" } },
      processCalls,
    )).toEqual({ dirty: false, refreshNow: false });

    pathIndexInvalidationForEvent(
      { kind: "tool.started", payload: { callId: "shell", toolId: "shell.run" } },
      processCalls,
    );
    expect(pathIndexInvalidationForEvent(
      { kind: "tool.failed", payload: { callId: "shell" } },
      processCalls,
    )).toEqual({ dirty: true, refreshNow: false });
    expect(pathIndexInvalidationForEvent(
      { kind: "transaction.committed", payload: {} },
      processCalls,
    )).toEqual({ dirty: true, refreshNow: false });
    expect(pathIndexInvalidationForEvent(
      { kind: "job.completed", payload: { jobId: "job-1" } },
      processCalls,
    )).toEqual({ dirty: true, refreshNow: true });
    expect(pathIndexInvalidationForEvent(
      { kind: "turn.completed", payload: {} },
      processCalls,
    )).toEqual({ dirty: false, refreshNow: true });

    pathIndexInvalidationForEvent(
      { kind: "tool.started", payload: { callId: "cancelled", toolId: "process.run" } },
      processCalls,
    );
    expect(pathIndexInvalidationForEvent(
      { kind: "turn.interrupted", payload: {} },
      processCalls,
    )).toEqual({ dirty: true, refreshNow: true });
    expect(processCalls.size).toBe(0);
  });

  test("a timed-out persistence stays in the single-flight queue", async () => {
    const warnings: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let flushes = 0;
    let snapshots = 0;
    let active = 0;
    let maxActive = 0;

    const session = {
      async flush(): Promise<void> {
        const call = ++flushes;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) await firstGate;
      },
      async snapshot(): Promise<boolean> {
        snapshots += 1;
        active -= 1;
        return true;
      },
    };
    const queue = new SessionPersistenceQueue(
      { warn: (warning) => warnings.push(warning) },
      15,
    );

    await queue.persist(session);
    expect(warnings.some((warning) => warning.includes("timed out"))).toBe(true);

    const secondWait = queue.persist(session);
    await delay(5);
    expect(flushes).toBe(1);
    expect(maxActive).toBe(1);

    releaseFirst();
    await secondWait;
    await queue.whenIdle();
    expect(flushes).toBe(2);
    expect(snapshots).toBe(2);
    expect(maxActive).toBe(1);
  });

  test("resume candidates refresh only after the latest activity is durable", async () => {
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const order: string[] = [];
    const session = {
      async flush(): Promise<void> {
        order.push("flush:start");
        await flushGate;
        order.push("flush:end");
      },
      async snapshot(): Promise<boolean> {
        order.push("snapshot");
        return true;
      },
    };
    const queue = new SessionPersistenceQueue({ warn: () => undefined }, 10);

    const pending = persistAndRefreshResumeCandidates(queue, session, async () => {
      order.push("refresh");
    });
    await delay(20);
    expect(order).toEqual(["flush:start"]);

    releaseFlush();
    await pending;
    expect(order).toEqual(["flush:start", "flush:end", "snapshot", "refresh"]);
  });

  test("failed replacement preserves the current session object", async () => {
    const current = { id: "current" };
    const result = await prepareSessionReplacement(current, async () => {
      throw new Error("bootstrap failed");
    });

    expect(result.ok).toBe(false);
    expect(result.current).toBe(current);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });

  test("successful replacement exposes old and new sessions at the swap point", async () => {
    const current = { id: "current" };
    const next = { id: "next" };
    const result = await prepareSessionReplacement(current, async () => next);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previous).toBe(current);
      expect(result.current).toBe(next);
    }
  });
});
