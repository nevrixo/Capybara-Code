import { describe, expect, test } from "bun:test";

import {
  APP_COMMAND_SCHEMA_VERSION,
  AppProtocolError,
  CommandDeduplicator,
  canonicalDigest,
  canonicalJson,
  negotiateAppProtocol,
  type CommandEnvelope,
  type OperationReceipt,
} from "../src/index.ts";

function command(payload: Record<string, unknown>, key = "key-1"): CommandEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: APP_COMMAND_SCHEMA_VERSION,
    commandId: "cmd-1",
    idempotencyKey: key,
    correlationId: "corr-1",
    clientId: "client-1",
    issuedAt: "2026-08-24T12:00:00.000Z",
    payload,
  };
}

function receipt(): OperationReceipt<string> {
  return {
    schemaVersion: APP_COMMAND_SCHEMA_VERSION,
    receiptId: "rcp-1",
    commandId: "cmd-1",
    idempotencyKey: "key-1",
    status: "completed",
    startedAt: "2026-08-24T12:00:00.000Z",
    finishedAt: "2026-08-24T12:00:01.000Z",
    evidenceIds: [],
    result: "ok",
  };
}

describe("App Protocol command contracts", () => {
  test("canonicalizes object keys deterministically", () => {
    expect(canonicalJson({ b: [2, { z: true, a: 1 }], a: "x" }))
      .toBe(canonicalJson({ a: "x", b: [2, { a: 1, z: true }] }));
    expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest({ b: 2, a: 1 }));
  });

  test("deduplicates simultaneous and completed commands", async () => {
    const dedupe = new CommandDeduplicator<Record<string, unknown>, string>();
    let runs = 0;
    const execute = async () => {
      runs += 1;
      return receipt();
    };
    const [first, second] = await Promise.all([
      dedupe.execute(command({ path: "a.ts" }), execute),
      dedupe.execute(command({ path: "a.ts" }), execute),
    ]);
    expect(runs).toBe(1);
    expect([first.kind, second.kind].sort()).toEqual(["executed", "replayed"]);
  });

  test("rejects a reused key with a different canonical payload", async () => {
    const dedupe = new CommandDeduplicator<Record<string, unknown>, string>();
    await dedupe.execute(command({ path: "a.ts" }), async () => receipt());
    await expect(dedupe.execute(command({ path: "b.ts" }), async () => receipt()))
      .rejects.toMatchObject({ structured: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  test("requires matching protocol majors", () => {
    expect(negotiateAppProtocol("1.4")).toBe("1.0");
    expect(() => negotiateAppProtocol("2.0")).toThrow(AppProtocolError);
  });
});
