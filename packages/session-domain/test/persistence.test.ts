import { describe, expect, test } from "bun:test";

import { createEvent, EventSequencer, type CbcEvent } from "@cbc/protocol";
import {
  ResidentJournalWindow,
  SessionRecorder,
  boundResidentViewModel,
  createSnapshotEnvelope,
  emptyViewModel,
  isUnresolvedTimelineItem,
  iterateReplayTailPages,
  loadEarlierJournalPage,
  parseSnapshotEnvelope,
  replayJournalTail,
  serializeModel,
  snapshotEnvelopeChecksum,
  validateSessionJournalPage,
  validateStoredSnapshot,
  type JournalTransport,
  type SessionJournalPage,
  type StoredJournalEvent,
} from "../src/index.ts";

const encoder = new TextEncoder();
const hash = (character: string): string => character.repeat(64);

function storedEvent(
  sequence: number,
  previousHash: string,
  eventHash: string,
  streamSequence = sequence,
): StoredJournalEvent {
  return {
    sessionId: "ses_1",
    sequence,
    id: `evt_${streamSequence}`,
    kind: "user.message",
    timestamp: `2026-08-09T00:00:0${sequence}Z`,
    schemaVersion: "1.0",
    payload: { value: sequence },
    prevHash: previousHash,
    eventHash,
    streamSequence,
  };
}

function pageResponse(
  events: readonly StoredJournalEvent[],
  options: {
    anchorSequence: number;
    anchorHash: string;
    throughSequence: number;
    throughHash: string;
    headSequence?: number;
    direction?: "forward" | "backward";
    hasMoreBefore?: boolean;
    hasMoreAfter?: boolean;
    snapshot?: unknown;
    earlierPage?: unknown;
    laterPage?: unknown;
    tailOnly?: boolean;
  },
): Record<string, unknown> {
  const first = events[0];
  const last = events.at(-1);
  return {
    events,
    page: {
      direction: options.direction ?? "forward",
      anchorSequence: options.anchorSequence,
      anchorHash: options.anchorHash,
      ...(first !== undefined
        ? { firstSequence: first.sequence, firstPrevHash: first.prevHash }
        : {}),
      ...(last !== undefined
        ? { lastSequence: last.sequence, lastEventHash: last.eventHash }
        : {}),
      through: { sequence: options.throughSequence, eventHash: options.throughHash },
      journalHead: {
        sequence: options.headSequence ?? options.throughSequence,
        eventHash: options.headSequence === undefined
          ? options.throughHash
          : hash("f"),
      },
      hasMoreBefore: options.hasMoreBefore ?? options.anchorSequence > 0,
      hasMoreAfter: options.hasMoreAfter ?? false,
      encodedBytes: encoder.encode(JSON.stringify(events)).byteLength,
      maxBytes: 4 * 1024 * 1024,
      itemLimit: 1_000,
      truncatedByBytes: false,
      oversizedSingleEvent: false,
    },
    earlierPage: options.earlierPage ?? null,
    laterPage: options.laterPage ?? null,
    snapshot: options.snapshot ?? null,
    tailOnly: options.tailOnly ?? false,
  };
}

describe("snapshot envelope persistence", () => {
  test("distinguishes durable and stream positions and verifies the full checksum", async () => {
    const envelope = createSnapshotEnvelope({
      sessionId: "ses_1",
      journalSequence: 2,
      streamSequence: 5,
      journalHash: hash("b"),
      reducerState: { sessionId: "ses_1", lastSequence: 5, timeline: [] },
    });
    const checksum = await snapshotEnvelopeChecksum(envelope);
    const stored = await validateStoredSnapshot({
      ...envelope,
      checksum,
      createdAt: "2026-08-09T00:00:00Z",
      legacy: false,
    }, { expectedSessionId: "ses_1", requireChecksum: true });

    expect(stored.journalSequence).toBe(2);
    expect(stored.streamSequence).toBe(5);
    expect(stored.checksum).toBe(checksum);
    await expect(validateStoredSnapshot({
      ...stored,
      reducerState: { ...stored.reducerState, lastSequence: 6 },
    })).rejects.toThrow("checksum");
  });

  test("upgrades legacy sequence aliases but rejects future versions and malformed state", () => {
    const legacy = parseSnapshotEnvelope({
      sessionId: "ses_1",
      sequence: 3,
      reducerState: { sessionId: "ses_1", timeline: [] },
    });
    expect(legacy?.legacy).toBe(true);
    expect(legacy?.journalSequence).toBe(3);
    expect(parseSnapshotEnvelope({
      snapshotVersion: 99,
      sessionId: "ses_1",
      journalSequence: 0,
      reducerState: {},
    })).toBeUndefined();
    expect(parseSnapshotEnvelope({
      snapshotVersion: 1,
      sessionId: "ses_1",
      journalSequence: 0,
      reducerState: [],
    })).toBeUndefined();
  });
});

describe("stable journal paging and tail-only replay", () => {
  test("replays only the snapshot tail across a frozen through hash", async () => {
    const h1 = hash("1");
    const h2 = hash("2");
    const h3 = hash("3");
    const snapshotBase = createSnapshotEnvelope({
      sessionId: "ses_1",
      journalSequence: 1,
      streamSequence: 3,
      journalHash: h1,
      reducerState: { sessionId: "ses_1", total: 10 },
    });
    const snapshot = {
      ...snapshotBase,
      checksum: await snapshotEnvelopeChecksum(snapshotBase),
      legacy: false,
    };
    const requests: Array<Record<string, unknown>> = [];
    const transport = {
      load: async (params: Record<string, unknown>) => {
        requests.push(params);
        if (params.tailOnly === true) {
          return pageResponse([storedEvent(2, h1, h2, 5)], {
            anchorSequence: 1,
            anchorHash: h1,
            throughSequence: 3,
            throughHash: h3,
            hasMoreAfter: true,
            snapshot,
            tailOnly: true,
          });
        }
        expect(params.afterSequence).toBe(2);
        expect(params.afterHash).toBe(h2);
        expect(params.throughSequence).toBe(3);
        expect(params.throughHash).toBe(h3);
        return pageResponse([storedEvent(3, h2, h3, 8)], {
          anchorSequence: 2,
          anchorHash: h2,
          throughSequence: 3,
          throughHash: h3,
        });
      },
    };

    const replayed = await replayJournalTail(transport, {
      sessionId: "ses_1",
      seed: (loaded) => Number(loaded?.reducerState.total ?? 0),
      apply: (total, event) => total + Number((event.payload as { value: number }).value),
    });
    expect(replayed.state).toBe(15);
    expect(replayed.eventsApplied).toBe(2);
    expect(replayed.pagesLoaded).toBe(2);
    expect(replayed.journalSequence).toBe(3);
    expect(replayed.streamSequence).toBe(8);
    expect(requests).toHaveLength(2);
  });

  test("rejects a page gap and exposes a stable earlier-page request", async () => {
    const h1 = hash("1");
    const h2 = hash("2");
    const h3 = hash("3");
    const h4 = hash("4");
    const current = validateSessionJournalPage(pageResponse([
      storedEvent(3, h2, h3),
      storedEvent(4, h3, h4),
    ], {
      anchorSequence: 2,
      anchorHash: h2,
      throughSequence: 4,
      throughHash: h4,
      hasMoreBefore: true,
      earlierPage: {
        beforeSequence: 3,
        beforeHash: h3,
        throughSequence: 4,
        throughHash: h4,
      },
    }), { expectedSessionId: "ses_1" });

    const earlierRaw = pageResponse([
      storedEvent(1, hash("0"), h1),
      storedEvent(2, h1, h2),
    ], {
      direction: "backward",
      anchorSequence: 3,
      anchorHash: h3,
      throughSequence: 4,
      throughHash: h4,
      hasMoreBefore: false,
      hasMoreAfter: true,
    });
    const calls: unknown[] = [];
    const earlier = await loadEarlierJournalPage({
      load: async (params) => {
        calls.push(params);
        return earlierRaw;
      },
    }, "ses_1", current);
    expect(earlier?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({ beforeSequence: 3, beforeHash: h3 });

    const gap = pageResponse([
      storedEvent(1, hash("0"), h1),
      storedEvent(3, h1, h3),
    ], {
      anchorSequence: 0,
      anchorHash: hash("0"),
      throughSequence: 3,
      throughHash: h3,
    });
    expect(() => validateSessionJournalPage(gap)).toThrow("sequence gap");
  });

  test("an app-incomplete snapshot automatically falls back to frozen full replay", async () => {
    const h0 = hash("0");
    const h1 = hash("1");
    const h2 = hash("2");
    const h3 = hash("3");
    const snapshotBase = createSnapshotEnvelope({
      sessionId: "ses_1",
      journalSequence: 2,
      streamSequence: 2,
      journalHash: h2,
      reducerState: { sessionId: "ses_1", model: {}, promptHistoryVersion: 0 },
    });
    const snapshot = {
      ...snapshotBase,
      checksum: await snapshotEnvelopeChecksum(snapshotBase),
      legacy: false,
    };
    const requests: Array<Record<string, unknown>> = [];
    const transport = {
      load: async (params: Record<string, unknown>) => {
        requests.push(params);
        if (params.tailOnly === true) {
          return pageResponse([storedEvent(3, h2, h3)], {
            anchorSequence: 2,
            anchorHash: h2,
            throughSequence: 3,
            throughHash: h3,
            snapshot,
            tailOnly: true,
          });
        }
        expect(params.afterSequence).toBe(0);
        expect(params.afterHash).toBe(h0);
        expect(params.throughSequence).toBe(3);
        return pageResponse([
          storedEvent(1, h0, h1),
          storedEvent(2, h1, h2),
          storedEvent(3, h2, h3),
        ], {
          anchorSequence: 0,
          anchorHash: h0,
          throughSequence: 3,
          throughHash: h3,
        });
      },
    };

    const pages: SessionJournalPage[] = [];
    for await (const page of iterateReplayTailPages(transport, {
      sessionId: "ses_1",
      acceptSnapshot: (candidate) => candidate.reducerState.promptHistoryVersion === 1,
    })) {
      pages.push(page);
    }
    expect(requests).toHaveLength(2);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.snapshot).toBeUndefined();
    expect(pages[0]?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  test("async page iterator never fetches the snapshot prefix", async () => {
    const h1 = hash("1");
    const response = pageResponse([], {
      anchorSequence: 1,
      anchorHash: h1,
      throughSequence: 1,
      throughHash: h1,
      tailOnly: true,
    });
    const requests: unknown[] = [];
    const pages: SessionJournalPage[] = [];
    for await (const page of iterateReplayTailPages({
      load: async (params) => {
        requests.push(params);
        return response;
      },
    }, { sessionId: "ses_1", afterJournalSequence: 1, afterHash: h1 })) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tailOnly: true, afterSequence: 1, afterHash: h1 });
  });
});

describe("resident journal and view-model windows", () => {
  test("lifecycle pins survive boundary pressure and release on terminal events", () => {
    const window = new ResidentJournalWindow<StoredJournalEvent>({
      maxItems: 3,
      maxBytes: 100_000,
    });
    const base = (sequence: number, kind: string, payload: unknown): StoredJournalEvent => ({
      ...storedEvent(sequence, sequence === 1 ? hash("0") : hash(String(sequence - 1)), hash(String(sequence))),
      kind,
      payload,
    });
    window.merge([
      base(1, "task.started", { taskId: "task-a" }),
      base(2, "user.message", { text: "old terminal detail" }),
      base(3, "user.message", { text: "middle" }),
      base(4, "user.message", { text: "newest" }),
    ]);

    // Sequence one is pinned, but sequence two is evicted by scanning inward.
    expect(window.items.map((item) => item.sequence)).toEqual([1, 3, 4]);
    expect(window.isPinned(1)).toBe(true);
    expect(window.stats.omittedRanges).toEqual([
      { firstSequence: 2, lastSequence: 2, count: 1 },
    ]);
    expect(window.stats.overBudget).toBe(false);

    window.merge([base(5, "task.completed", { taskId: "task-a" })]);
    expect(window.isPinned(1)).toBe(false);
    expect(window.items.map((item) => item.sequence)).toEqual([3, 4, 5]);
    expect(window.stats.itemCount).toBeLessThanOrEqual(3);
  });

  test("manual pins report safe overflow rather than evicting pinned state", () => {
    const window = new ResidentJournalWindow<StoredJournalEvent>({
      maxItems: 1,
      maxBytes: 100_000,
      trackLifecyclePins: false,
    });
    window.merge([storedEvent(1, hash("0"), hash("1"))]);
    const release = window.pin(1);
    window.merge([storedEvent(2, hash("1"), hash("2"))]);
    expect(window.items.map((item) => item.sequence)).toEqual([1]);
    expect(window.stats.overBudget).toBe(false);
    release();
  });

  test("resident window overflows only when all remaining events are pinned", () => {
    const window = new ResidentJournalWindow<StoredJournalEvent>({
      maxItems: 1,
      maxBytes: 100_000,
    });
    window.merge([
      { ...storedEvent(1, hash("0"), hash("1")), kind: "task.started", payload: { taskId: "a" } },
      { ...storedEvent(2, hash("1"), hash("2")), kind: "task.started", payload: { taskId: "b" } },
    ]);
    expect(window.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect(window.stats.pinnedItems).toBe(2);
    expect(window.stats.overBudget).toBe(true);
  });

  test("bounds unpinned middle items while preserving active aggregate state", () => {
    const activeTasks = [{ taskId: "task-a" }];
    const model = {
      timeline: [
        { type: "task", sequence: 1, state: "running" },
        { type: "notice", sequence: 2 },
        { type: "notice", sequence: 3 },
        { type: "approval", sequence: 4, decision: "pending" },
        { type: "notice", sequence: 5 },
      ],
      activeTasks,
      activeTools: [{ callId: "call-a" }],
      activeJobs: [{ jobId: "job-a" }],
      usage: { inputTokens: 42 },
    };
    const bounded = boundResidentViewModel(model, {
      maxItems: 2,
      maxBytes: 100_000,
    });
    expect(bounded.model.timeline.map((item) => item.sequence)).toEqual([1, 4]);
    expect(bounded.model.activeTasks).toBe(activeTasks);
    expect(bounded.model.usage).toBe(model.usage);
    expect(bounded.omittedCount).toBe(3);
    expect(bounded.omittedRanges).toEqual([
      { firstSequence: 2, lastSequence: 3, count: 2 },
      { firstSequence: 5, lastSequence: 5, count: 1 },
    ]);
    expect(bounded.omittedPageAnchors).toEqual([
      { beforeSequence: 4 },
      { beforeSequence: 6 },
    ]);
    expect(bounded.overBudget).toBe(false);
  });

  test("reports overflow only when pinned items alone exceed the budget", () => {
    const bounded = boundResidentViewModel({
      timeline: [
        { type: "task", sequence: 1, state: "blocked" },
        { type: "approval", sequence: 2, decision: "pending" },
        { type: "notice", sequence: 3 },
      ],
    }, {
      maxItems: 1,
      maxBytes: 100_000,
    });
    expect(bounded.model.timeline.map((item) => item.sequence)).toEqual([1, 2]);
    expect(bounded.overBudget).toBe(true);
    expect(bounded.omittedRanges).toEqual([
      { firstSequence: 3, lastSequence: 3, count: 1 },
    ]);
  });

  test("accepts the concrete SessionViewModel type without a reducer dependency cycle", () => {
    const bounded = boundResidentViewModel(emptyViewModel("ses_1"), {
      maxItems: 100,
      maxBytes: 100_000,
    });
    expect(bounded.model.sessionId).toBe("ses_1");
  });

  test("pins blocked tasks and undecided approvals", () => {
    expect(isUnresolvedTimelineItem({ type: "task", sequence: 1, state: "blocked" })).toBe(true);
    expect(isUnresolvedTimelineItem({ type: "approval", sequence: 2 })).toBe(true);
    expect(isUnresolvedTimelineItem({ type: "approval", sequence: 3, decision: "pending" })).toBe(true);
    expect(isUnresolvedTimelineItem({ type: "approval", sequence: 4, decision: "approved" })).toBe(false);
  });
});

describe("SessionRecorder snapshot/resume hooks", () => {
  function transport(): JournalTransport & { snapshots: Array<Record<string, unknown>> } {
    const snapshots: Array<Record<string, unknown>> = [];
    let journalSequence = 0;
    return {
      snapshots,
      open: async () => ({}),
      append: async (params) => {
        const events = params.events as Array<{ id: string }>;
        const acknowledged = events.map((event) => ({
          id: event.id,
          sequence: ++journalSequence,
          eventHash: hash(String(journalSequence)),
          prevHash: journalSequence === 1 ? hash("0") : hash(String(journalSequence - 1)),
        }));
        return { appended: events.length, lastSequence: journalSequence, events: acknowledged };
      },
      snapshot: async (params) => {
        snapshots.push(params);
        return {};
      },
      load: async () => ({}),
    };
  }

  test("supports extensible prompt-safe snapshot payloads while retaining legacy aliases", async () => {
    const t = transport();
    const recorder = new SessionRecorder({
      sessionId: "ses_1",
      transport: t,
      serializeSnapshot: (model) => ({
        sessionId: model.sessionId,
        model: serializeModel(model),
        kernelHistory: [{ role: "user", content: "keep me" }],
        compactState: "summary",
      }),
    });
    recorder.emit("user.message", { text: "hello" });
    await recorder.maybeSnapshot(true);

    expect(t.snapshots).toHaveLength(1);
    expect(t.snapshots[0]).toMatchObject({
      snapshotVersion: 1,
      sequence: 1,
      journalSequence: 1,
      streamSequence: 1,
      reducerState: {
        sessionId: "ses_1",
        kernelHistory: [{ role: "user", content: "keep me" }],
        compactState: "summary",
      },
    });
  });

  test("hydrates a seeded model with explicit durable and stream positions", () => {
    const t = transport();
    const recorder = new SessionRecorder({ sessionId: "ses_1", transport: t });
    recorder.hydrateSeededModel(emptyViewModel("ses_1"), {
      journalSequence: 2,
      streamSequence: 5,
    });
    const sequencer = new EventSequencer(5);
    const tail = createEvent(sequencer, "user.message", { text: "tail" }, { sessionId: "ses_1" });
    recorder.hydrate([tail as CbcEvent], { journalSequence: 3, streamSequence: 6 });

    expect(recorder.lastJournalSequence).toBe(3);
    expect(recorder.lastSequence).toBe(6);
    expect(recorder.model.timeline).toHaveLength(1);
    expect(recorder.emit("assistant.delta", { text: "next" }).sequence).toBe(7);
    expect(() => recorder.hydrateSeededModel(emptyViewModel("ses_1"), {
      journalSequence: 4,
      streamSequence: 3,
    })).toThrow("streamSequence");
  });
});
