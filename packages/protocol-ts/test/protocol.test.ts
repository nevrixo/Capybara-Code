/**
 * Protocol tests — PRD §25.2, §25.7, AC-37.
 */

import { describe, expect, test } from "bun:test";

import {
  ALL_EVENT_KINDS,
  DEFAULT_READ_MAX_LINES,
  EVENT_KINDS,
  RUNTIME_FEATURE_EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  EventSequencer,
  FrameDecoder,
  LIMITS,
  NOTIFICATION_METHODS,
  PROTOCOL_VERSION,
  REQUEST_METHODS,
  RuntimeRpcError,
  TOOL_ERROR_CODES,
  codeToTaxonomy,
  createEvent,
  defaultsForKind,
  encodeFrame,
  fromJsonl,
  isKnownEventKind,
  isKnownNotificationMethod,
  isKnownRequestMethod,
  isProtocolCompatible,
  jsonDepth,
  mustJournal,
  parseProtocolVersion,
  toJsonl,
  validateEvent,
} from "../src/index.ts";

describe("event envelope (§20.6)", () => {
  test("createEvent produces a complete envelope", () => {
    const sequencer = new EventSequencer();
    const event = createEvent(sequencer, "turn.started", { model: "gpt-5.6" }, {
      sessionId: "ses_1",
      turnId: "turn_1",
    });
    expect(event.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(event.sequence).toBe(1);
    expect(event.sessionId).toBe("ses_1");
    expect(event.turnId).toBe("turn_1");
    expect(event.kind).toBe("turn.started");
    expect(validateEvent(event)).toEqual([]);
  });

  test("sequence is strictly monotonic within a session (§20.10)", () => {
    const sequencer = new EventSequencer();
    const sequences = EVENT_KINDS.slice(0, 10).map(
      (kind) => createEvent(sequencer, kind, {}, { sessionId: "s" }).sequence,
    );
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sequencer.lastSequence).toBe(10);
  });

  test("resuming continues the sequence rather than restarting", () => {
    const sequencer = new EventSequencer(41);
    expect(createEvent(sequencer, "session.resumed", {}, { sessionId: "s" }).sequence).toBe(42);
  });

  test("optional fields are omitted, not set to undefined", () => {
    const event = createEvent(new EventSequencer(), "user.message", { text: "hi" }, {
      sessionId: "s",
    });
    expect("turnId" in event).toBe(false);
    expect("agentId" in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain("null");
  });

  test("every registered kind has defaults", () => {
    expect(EVENT_KINDS.length).toBe(71);
    expect(RUNTIME_FEATURE_EVENT_KINDS.length).toBeGreaterThan(80);
    for (const kind of ALL_EVENT_KINDS) {
      const defaults = defaultsForKind(kind);
      expect(defaults.level).toBeTruthy();
      expect(defaults.visibility).toBeTruthy();
      expect(defaults.durability).toBeTruthy();
    }
  });

  test("Skills catalog changes are known, hidden, and journaled", () => {
    expect(isKnownEventKind("skills.changed")).toBe(true);
    expect(mustJournal("skills.changed")).toBe(true);
    expect(defaultsForKind("skills.changed").visibility).toBe("hidden");
  });

  test("Deep Plan questionnaire checkpoints are hidden and journaled", () => {
    expect(isKnownEventKind("deep_plan.questionnaire_opened")).toBe(true);
    expect(mustJournal("deep_plan.questionnaire_updated")).toBe(true);
    expect(defaultsForKind("deep_plan.questionnaire_answered").visibility).toBe("hidden");
  });

  test("runtime-feature kinds are known and journaled by default except live LSP/plugin hooks", () => {
    for (const kind of ["edit.committed", "memory.created", "graph.created", "worktree.created", "plugin.hook_denied"] as const) {
      expect(isKnownEventKind(kind)).toBe(true);
      expect(mustJournal(kind)).toBe(true);
    }
    expect(mustJournal("plugin.hook_started")).toBe(false);
    expect(mustJournal("lsp.document_changed")).toBe(false);
  });

  test("Context P0 telemetry is hidden and durable", () => {
    for (const kind of [
      "context.observation_ingested",
      "context.pack_compiled",
      "context.item_evicted",
      "context.evidence_rejected",
      "context.cache_segment",
    ] as const) {
      expect(isKnownEventKind(kind)).toBe(true);
      expect(defaultsForKind(kind).visibility).toBe("hidden");
      expect(defaultsForKind(kind).durability).toBe("journaled");
      expect(mustJournal(kind)).toBe(true);
      expect(validateEvent(createEvent(new EventSequencer(), kind, {}, { sessionId: "s" }))).toEqual([]);
    }
    expect(defaultsForKind("context.evidence_rejected").level).toBe("warning");
  });

  test("§20.9 MUST-journal events are journaled", () => {
    for (const kind of [
      "assistant.final",
      "tool.started",
      "tool.completed",
      "approval.requested",
      "approval.resolved",
      "transaction.committed",
      "usage.updated",
      "task.completed",
    ] as const) {
      expect(mustJournal(kind)).toBe(true);
    }
  });

  test("high-frequency deltas are ephemeral so they can be coalesced", () => {
    for (const kind of ["tool.progress", "job.output", "task.progress"] as const) {
      expect(mustJournal(kind)).toBe(false);
    }
  });

  test("unknown kinds are detectable so consumers can skip them", () => {
    expect(isKnownEventKind("turn.started")).toBe(true);
    expect(isKnownEventKind("turn.teleported")).toBe(false);
  });
});

describe("event validation", () => {
  test("rejects a wrong schema version", () => {
    const issues = validateEvent({
      schemaVersion: "2.0",
      sequence: 1,
      id: "e",
      timestamp: new Date().toISOString(),
      sessionId: "s",
      kind: "turn.started",
      level: "info",
      visibility: "timeline",
      durability: "journaled",
      payload: {},
    });
    expect(issues.some((i) => i.field === "schemaVersion")).toBe(true);
  });

  test("rejects non-positive sequence", () => {
    const base = createEvent(new EventSequencer(), "turn.started", {}, { sessionId: "s" });
    expect(validateEvent({ ...base, sequence: 0 }).some((i) => i.field === "sequence")).toBe(true);
    expect(validateEvent({ ...base, sequence: 1.5 }).some((i) => i.field === "sequence")).toBe(true);
  });

  test("rejects malformed timestamps", () => {
    const base = createEvent(new EventSequencer(), "turn.started", {}, { sessionId: "s" });
    expect(
      validateEvent({ ...base, timestamp: "not-a-date" }).some((i) => i.field === "timestamp"),
    ).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(validateEvent(null).length).toBeGreaterThan(0);
    expect(validateEvent("x").length).toBeGreaterThan(0);
    expect(validateEvent(42).length).toBeGreaterThan(0);
  });
});

describe("JSONL contract (§20.10, AC-37)", () => {
  test("round-trips through one line", () => {
    const event = createEvent(new EventSequencer(), "assistant.commentary", {
      text: "I'll inspect the failing path.",
    }, { sessionId: "ses_1", turnId: "turn_1" });
    const line = toJsonl(event);
    expect(line).not.toContain("\n");
    expect(fromJsonl(line)).toEqual(event);
  });

  test("survives CJK and emoji payloads", () => {
    const event = createEvent(new EventSequencer(), "user.message", {
      text: "서브 에이전트 사용해서 파이썬 아무 코드나 작성해줘 🐹",
    }, { sessionId: "ses_1" });
    const parsed = fromJsonl(toJsonl(event));
    expect((parsed?.payload as { text: string }).text).toContain("서브 에이전트");
  });

  test("rejects malformed lines instead of throwing", () => {
    expect(fromJsonl("{not json")).toBeUndefined();
    expect(fromJsonl("")).toBeUndefined();
    expect(fromJsonl("   ")).toBeUndefined();
    expect(fromJsonl('{"schemaVersion":"9.9"}')).toBeUndefined();
  });

  test("an unknown kind is skippable, not corruption (§20.10, P0-06)", () => {
    // A newer producer may add kinds an older client does not know. The client
    // must be able to skip them rather than dropping the line as malformed.
    const event = createEvent(new EventSequencer(), "user.message", { text: "x" }, {
      sessionId: "ses_1",
    });
    const newer = JSON.parse(toJsonl(event)) as Record<string, unknown>;
    newer.kind = "turn.teleported";
    const parsed = fromJsonl(JSON.stringify(newer));
    expect(parsed).toBeDefined();
    expect(isKnownEventKind((parsed as { kind: string }).kind)).toBe(false);
  });

  test("a structural failure still rejects even with an unknown kind", () => {
    const event = createEvent(new EventSequencer(), "user.message", { text: "x" }, {
      sessionId: "ses_1",
    });
    const broken = JSON.parse(toJsonl(event)) as Record<string, unknown>;
    broken.kind = "turn.teleported";
    broken.sequence = 0; // structurally invalid
    expect(fromJsonl(JSON.stringify(broken))).toBeUndefined();
  });

  test("payload text containing a newline stays on one line", () => {
    const event = createEvent(new EventSequencer(), "tool.completed", {
      summary: "line1\nline2\nline3",
    }, { sessionId: "s" });
    const line = toJsonl(event);
    expect(line.split("\n")).toHaveLength(1);
    expect((fromJsonl(line)?.payload as { summary: string }).summary).toBe("line1\nline2\nline3");
  });
});

describe("frame codec (§20.1)", () => {
  test("encodes a 4-byte big-endian length prefix", () => {
    const frame = encodeFrame("hi");
    expect(frame.byteLength).toBe(6);
    expect(Array.from(frame.subarray(0, 4))).toEqual([0, 0, 0, 2]);
  });

  test("round-trips through the incremental decoder", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame('{"a":1}'));
    expect(Array.from(decoder.drain())).toEqual(['{"a":1}']);
  });

  test("reassembles frames split across arbitrary chunk boundaries", () => {
    const frame = encodeFrame('{"method":"runtime.heartbeat"}');
    const decoder = new FrameDecoder();
    for (const byte of frame) {
      decoder.push(new Uint8Array([byte]));
      // Nothing emitted until the final byte arrives.
    }
    expect(Array.from(decoder.drain())).toEqual(['{"method":"runtime.heartbeat"}']);
    expect(decoder.pendingBytes).toBe(0);
  });

  test("drains several frames from one chunk", () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame('{"n":1}');
    const b = encodeFrame('{"n":2}');
    const merged = new Uint8Array(a.byteLength + b.byteLength);
    merged.set(a, 0);
    merged.set(b, a.byteLength);
    decoder.push(merged);
    expect(Array.from(decoder.drain())).toEqual(['{"n":1}', '{"n":2}']);
  });

  test("holds a partial frame until complete", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame('{"long":"payload"}');
    decoder.push(frame.subarray(0, 6));
    expect(Array.from(decoder.drain())).toEqual([]);
    expect(decoder.pendingBytes).toBe(6);
    decoder.push(frame.subarray(6));
    expect(Array.from(decoder.drain())).toEqual(['{"long":"payload"}']);
  });

  test("preserves embedded newlines and unicode", () => {
    const payload = '{"text":"line1\\nline2 한국어 🐹"}';
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame(payload));
    expect(Array.from(decoder.drain())).toEqual([payload]);
  });

  test("rejects an oversized declared length", () => {
    const decoder = new FrameDecoder();
    const bogus = new Uint8Array(8);
    new DataView(bogus.buffer).setUint32(0, 0xffffffff, false);
    decoder.push(bogus);
    expect(() => Array.from(decoder.drain())).toThrow(/exceeds/);
  });

  test("rejects a zero-length frame in both directions", () => {
    expect(() => encodeFrame("")).toThrow(/zero-length/);
    const decoder = new FrameDecoder();
    decoder.push(new Uint8Array([0, 0, 0, 0]));
    expect(() => Array.from(decoder.drain())).toThrow(/zero-length/);
  });

  test("refuses to encode beyond the frame limit", () => {
    const huge = "x".repeat(LIMITS.maxFrameBytes + 1);
    expect(() => encodeFrame(huge)).toThrow(/exceeds/);
  });
});

describe("method registry drift (§20.11)", () => {
  test("request method count matches the PRD list", () => {
    // §20.3 lists 39. `fs.transaction.rollback_to_checkpoint` is the 40th, added for
    // the §11.2 self-correction loop; `workspace.trust.{list,set,remove}` are the
    // 41st–43rd so the CLI manages trust through the runtime (P0-01);
    // `session.{list,resolve,set_status,export,fork,delete}` are the 44th–49th (P0-05); and
    // `runtime.cancel`, `runtime.capability.issue`, `fs.fingerprint`, and
    // `workspace.mode.write` are additions to the original PRD list.
    expect(REQUEST_METHODS.length).toBe(75);
    expect(REQUEST_METHODS).toContain("fs.transaction.rollback_to_checkpoint");
    expect(REQUEST_METHODS).toContain("workspace.trust.set");
    expect(REQUEST_METHODS).toContain("session.fork");
    expect(REQUEST_METHODS).toContain("runtime.cancel");
    expect(REQUEST_METHODS).toContain("fs.fingerprint");
    expect(REQUEST_METHODS).toContain("fs.edit.preview");
    expect(REQUEST_METHODS).toContain("fs.edit");
    expect(new Set(REQUEST_METHODS).size).toBe(REQUEST_METHODS.length);
    expect(REQUEST_METHODS).toContain("memory.search");
    expect(REQUEST_METHODS).toContain("memory.remember");
    expect(REQUEST_METHODS).toContain("memory.list");
    expect(REQUEST_METHODS).toContain("memory.verify");
    expect(REQUEST_METHODS).toContain("worktree.create");
    expect(REQUEST_METHODS).toContain("merge.preview");
    expect(REQUEST_METHODS).toContain("app.subscription.ack");
    expect(REQUEST_METHODS).toContain("app.subscription.replay");
  });

  test("filesystem read defaults are shared across the protocol", () => {
    expect(DEFAULT_READ_MAX_LINES).toBe(400);
  });

  test("notification method count matches the PRD list", () => {
    expect(NOTIFICATION_METHODS.length).toBe(11);
    expect(new Set(NOTIFICATION_METHODS).size).toBe(NOTIFICATION_METHODS.length);
  });

  test("unknown methods are rejected", () => {
    expect(isKnownRequestMethod("fs.read")).toBe(true);
    expect(isKnownRequestMethod("codex.app_server")).toBe(false);
    expect(isKnownNotificationMethod("runtime.heartbeat")).toBe(true);
    expect(isKnownNotificationMethod("runtime.teleport")).toBe(false);
  });

  test("the taxonomy covers every runtime failure code", () => {
    expect(TOOL_ERROR_CODES.length).toBe(23);
    expect(TOOL_ERROR_CODES).toContain("PATH_OUTSIDE_WORKSPACE");
    expect(TOOL_ERROR_CODES).toContain("APPROVAL_DENIED");
    expect(TOOL_ERROR_CODES).toContain("MCP_UNAVAILABLE");
    expect(TOOL_ERROR_CODES).toContain("NOT_INITIALIZED");
    expect(TOOL_ERROR_CODES).toContain("RESOURCE_LIMIT");
  });
});

describe("error mapping", () => {
  test("maps runtime codes onto the taxonomy", () => {
    expect(codeToTaxonomy(-32000)).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(codeToTaxonomy(-32001)).toBe("HASH_MISMATCH");
    expect(codeToTaxonomy(-32007)).toBe("TIMEOUT");
    expect(codeToTaxonomy(-32012)).toBe("TRANSACTION_CONFLICT");
    expect(codeToTaxonomy(-32013)).toBe("PROTOCOL_INCOMPATIBLE");
    expect(codeToTaxonomy(-32014)).toBe("LEASE_VIOLATION");
    expect(codeToTaxonomy(-32015)).toBe("RESOURCE_LIMIT");
    expect(codeToTaxonomy(-32016)).toBe("NOT_INITIALIZED");
    expect(codeToTaxonomy(-32017)).toBe("TOO_MANY_REQUESTS");
    expect(codeToTaxonomy(-32019)).toBe("PERMISSION_DENIED");
    expect(codeToTaxonomy(-1)).toBe("INTERNAL");
  });

  test("prefers the runtime-supplied taxonomy over the code", () => {
    const error = new RuntimeRpcError({
      code: -32603,
      message: "boom",
      data: { taxonomy: "OUTPUT_LIMIT" },
    });
    expect(error.taxonomy).toBe("OUTPUT_LIMIT");
    expect(error.message).toBe("boom");
  });

  test("validation and permission failures are not retryable (§10.13)", () => {
    const denied = new RuntimeRpcError({
      code: -32019,
      message: "denied",
      data: { taxonomy: "PERMISSION_DENIED" },
    });
    expect(denied.retryable).toBe(false);
    const timeout = new RuntimeRpcError({
      code: -32007,
      message: "slow",
      data: { taxonomy: "TIMEOUT" },
    });
    expect(timeout.retryable).toBe(true);
    const deterministicInternal = new RuntimeRpcError({
      code: -32603,
      message: "missing revision",
      data: { taxonomy: "INTERNAL", retryable: false },
    });
    expect(deterministicInternal.retryable).toBe(false);
  });
});

describe("protocol version (§19.12)", () => {
  test("parses and compares", () => {
    expect(parseProtocolVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseProtocolVersion("2")).toEqual({ major: 2, minor: 0 });
    expect(parseProtocolVersion("1.2.3")).toBeUndefined();
    expect(parseProtocolVersion("abc")).toBeUndefined();
  });

  test("major mismatch is incompatible", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION, "1.4")).toBe(true);
    expect(isProtocolCompatible(PROTOCOL_VERSION, "2.0")).toBe(false);
    expect(isProtocolCompatible(PROTOCOL_VERSION, "garbage")).toBe(false);
  });
});

describe("json depth guard (§20.4)", () => {
  test("measures nesting", () => {
    expect(jsonDepth({ a: 1 })).toBe(2);
    expect(jsonDepth({ a: { b: { c: 1 } } })).toBe(4);
    expect(jsonDepth([[[1]]])).toBe(4);
    expect(jsonDepth("scalar")).toBe(1);
  });

  test("short-circuits rather than recursing without bound", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5_000; i += 1) deep = [deep];
    expect(jsonDepth(deep)).toBeGreaterThan(LIMITS.maxJsonDepth);
  });
});
