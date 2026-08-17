import { describe, expect, test } from "bun:test";

import { emptyViewModel, serializeModel } from "@cbc/session-domain";

import { parseAgentSessionSnapshot } from "../src/agent.ts";
import {
  createEarlierHistoryLoader,
  loadSessionEvents,
  restoreEvent,
} from "../src/bootstrap.ts";
import type { Runtime } from "../src/runtime.ts";

const encoder = new TextEncoder();
const hash = (sequence: number) => sequence.toString(16).padStart(64, "0");

function storedEvent(journalSequence: number, streamSequence: number, prevHash: string) {
  return {
    sessionId: "session-1",
    sequence: journalSequence,
    streamSequence,
    id: `evt_${streamSequence}_test`,
    kind: "user.message",
    timestamp: "2026-08-09T00:00:00.000Z",
    schemaVersion: "1.0",
    payload: { text: `message ${streamSequence}` },
    prevHash,
    eventHash: hash(journalSequence),
    level: "info",
    visibility: "user",
  };
}

function page(
  events: readonly ReturnType<typeof storedEvent>[],
  options: {
    anchorSequence: number;
    anchorHash?: string;
    throughSequence: number;
    snapshot?: Record<string, unknown>;
  },
) {
  const first = events[0];
  const last = events.at(-1);
  return {
    events,
    page: {
      direction: "forward",
      anchorSequence: options.anchorSequence,
      ...(options.anchorHash !== undefined ? { anchorHash: options.anchorHash } : {}),
      ...(first !== undefined
        ? { firstSequence: first.sequence, firstPrevHash: first.prevHash }
        : {}),
      ...(last !== undefined
        ? { lastSequence: last.sequence, lastEventHash: last.eventHash }
        : {}),
      through: {
        sequence: options.throughSequence,
        eventHash: hash(options.throughSequence),
      },
      journalHead: {
        sequence: options.throughSequence,
        eventHash: hash(options.throughSequence),
      },
      hasMoreBefore: options.anchorSequence > 0,
      hasMoreAfter: false,
      encodedBytes: encoder.encode(JSON.stringify(events)).byteLength,
      maxBytes: 4 * 1024 * 1024,
      itemLimit: 1_000,
      truncatedByBytes: false,
      oversizedSingleEvent: false,
    },
    integrity: { ok: true },
    eventCount: options.throughSequence,
    tailOnly: true,
    ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
  };
}

function journalPage(
  events: readonly ReturnType<typeof storedEvent>[],
  options: {
    direction: "forward" | "backward";
    anchorSequence: number;
    anchorHash?: string;
    throughSequence: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
  },
) {
  const first = events[0];
  const last = events.at(-1);
  const response: Record<string, unknown> = {
    events,
    page: {
      direction: options.direction,
      anchorSequence: options.anchorSequence,
      ...(options.anchorHash !== undefined ? { anchorHash: options.anchorHash } : {}),
      ...(first !== undefined
        ? { firstSequence: first.sequence, firstPrevHash: first.prevHash }
        : {}),
      ...(last !== undefined
        ? { lastSequence: last.sequence, lastEventHash: last.eventHash }
        : {}),
      through: { sequence: options.throughSequence, eventHash: hash(options.throughSequence) },
      journalHead: { sequence: options.throughSequence, eventHash: hash(options.throughSequence) },
      hasMoreBefore: options.hasMoreBefore,
      hasMoreAfter: options.hasMoreAfter,
      encodedBytes: encoder.encode(JSON.stringify(events)).byteLength,
      maxBytes: 4 * 1024 * 1024,
      itemLimit: 1_000,
      truncatedByBytes: false,
      oversizedSingleEvent: false,
    },
    integrity: { ok: true },
    eventCount: options.throughSequence,
    tailOnly: false,
  };
  if (options.hasMoreBefore && first !== undefined) {
    response.earlierPage = {
      beforeSequence: first.sequence,
      beforeHash: first.eventHash,
      throughSequence: options.throughSequence,
      throughHash: hash(options.throughSequence),
    };
  }
  if (options.hasMoreAfter && last !== undefined) {
    response.laterPage = {
      afterSequence: last.sequence,
      afterHash: last.eventHash,
      throughSequence: options.throughSequence,
      throughHash: hash(options.throughSequence),
    };
  }
  return response;
}

function runtimeReturning(response: unknown): Runtime {
  return {
    loadSession: async () => response,
  } as unknown as Runtime;
}

describe("paged session resume", () => {
  test("restores protocol stream sequence separately from journal sequence", async () => {
    const events = [storedEvent(1, 10, hash(0)), storedEvent(2, 12, hash(1))];
    const loaded = await loadSessionEvents(
      runtimeReturning(page(events, { anchorSequence: 0, throughSequence: 2 })),
      "session-1",
    );

    expect(loaded.events.map((event) => event.sequence)).toEqual([10, 12]);
    expect(loaded.finalPosition).toEqual({ journalSequence: 2, streamSequence: 12 });
    expect(loaded.seed).toBeUndefined();
  });

  test("seeds reducer and provider history from a versioned snapshot then replays only its tail", async () => {
    const model = emptyViewModel("session-1");
    const snapshot = {
      snapshotVersion: 1,
      sessionId: "session-1",
      journalSequence: 1,
      streamSequence: 10,
      journalHash: hash(1),
      reducerState: {
        agentSessionSnapshotVersion: 1,
        model: serializeModel(model),
        promptHistory: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "before snapshot" }],
        }],
        compactState: "decisions retained",
        turnCounter: 4,
      },
    };
    const tail = [storedEvent(2, 12, hash(1))];
    const loaded = await loadSessionEvents(
      runtimeReturning(page(tail, {
        anchorSequence: 1,
        anchorHash: hash(1),
        throughSequence: 2,
        snapshot,
      })),
      "session-1",
    );

    expect(loaded.events.map((event) => event.sequence)).toEqual([12]);
    expect(loaded.snapshotPosition).toEqual({ journalSequence: 1, streamSequence: 10 });
    expect(loaded.finalPosition).toEqual({ journalSequence: 2, streamSequence: 12 });
    expect(loaded.seed?.model.sessionId).toBe("session-1");
    expect(loaded.seed?.promptHistory).toHaveLength(1);
    expect(loaded.seed?.compactState).toBe("decisions retained");
    expect(loaded.seed?.turnCounter).toBe(4);
  });

  test("lazily freezes the live durable head and pages backward with stable cursors", async () => {
    const all = Array.from({ length: 5 }, (_, index) =>
      storedEvent(index + 1, index + 1, hash(index)));
    const responses = [
      journalPage(all.slice(0, 1), {
        direction: "forward",
        anchorSequence: 0,
        throughSequence: 5,
        hasMoreBefore: false,
        hasMoreAfter: true,
      }),
      journalPage(all.slice(2), {
        direction: "backward",
        anchorSequence: 6,
        throughSequence: 5,
        hasMoreBefore: true,
        hasMoreAfter: false,
      }),
      journalPage(all.slice(0, 2), {
        direction: "backward",
        anchorSequence: 3,
        anchorHash: hash(3),
        throughSequence: 5,
        hasMoreBefore: false,
        hasMoreAfter: true,
      }),
    ];
    const requests: Record<string, unknown>[] = [];
    const runtime = {
      loadSession: async (params: Record<string, unknown>) => {
        requests.push(params);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected page request");
        return response;
      },
    } as unknown as Runtime;
    const loadEarlier = createEarlierHistoryLoader(runtime, "session-1");

    const tail = await loadEarlier();
    const complete = await loadEarlier();

    expect(tail?.map((item) => item.sequence)).toEqual([3, 4, 5]);
    expect(complete?.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.beforeSequence).toBe(6);
    expect(requests[1]?.throughHash).toBe(hash(5));
    expect(requests[2]?.beforeSequence).toBe(3);
    expect(requests[2]?.beforeHash).toBe(hash(3));
  });


  test("accepts a bounded v3 resume capsule and rejects byte-digest drift", () => {
    const model = serializeModel(emptyViewModel("session-1"));
    const history = [{
      content: [{ text: "resume me", type: "input_text" }],
      role: "user",
      type: "message",
    }] as const;
    const historyDigest = new Bun.CryptoHasher("sha256").update(JSON.stringify(history)).digest("hex");
    const serializedBytes = encoder.encode(JSON.stringify(history)).byteLength;
    const valid = parseAgentSessionSnapshot({
      agentSessionSnapshotVersion: 3,
      model,
      promptCapsule: { history, historyDigest, serializedBytes },
      resumeView: {
        tailItemLimit: 48,
        tailByteLimit: 768 * 1024,
        omittedCount: 0,
        omittedRanges: [],
      },
      turnCounter: 1,
      residentTimelineOmitted: 0,
    }, "session-1");
    expect(valid?.promptHistory as unknown).toEqual(history);
    expect(valid?.promptHistoryDigest).toBe(historyDigest);
    expect(valid?.promptSerializedBytes).toBe(serializedBytes);
    expect(parseAgentSessionSnapshot({
      agentSessionSnapshotVersion: 3,
      model,
      promptCapsule: { history, historyDigest, serializedBytes: serializedBytes + 1 },
      resumeView: {
        tailItemLimit: 48,
        tailByteLimit: 768 * 1024,
        omittedCount: 0,
        omittedRanges: [],
      },
      turnCounter: 1,
    }, "session-1")).toBeUndefined();
  });

  test("rejects malformed prompt-history and reducer shapes in app snapshots", () => {
    const model = serializeModel(emptyViewModel("session-1"));
    expect(parseAgentSessionSnapshot({
      agentSessionSnapshotVersion: 1,
      model,
      promptHistory: [{ type: "message", role: "user", content: [{ type: "input_text" }] }],
      turnCounter: 1,
    }, "session-1")).toBeUndefined();
    expect(parseAgentSessionSnapshot({
      agentSessionSnapshotVersion: 1,
      model: { ...model, timeline: [null] },
      promptHistory: [],
      turnCounter: 1,
    }, "session-1")).toBeUndefined();
  });

  test("restoreEvent rejects malformed envelopes but accepts durable stream gaps", () => {
    expect(restoreEvent({ sequence: 1 }, "session-1")).toBeUndefined();
    expect(restoreEvent(storedEvent(3, 99, hash(2)), "session-1")?.sequence).toBe(99);
  });
});
