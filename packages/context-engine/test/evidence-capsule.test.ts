import { describe, expect, test } from "bun:test";

import { EvidenceLedger } from "../src/evidence.ts";

const CREATED_AT = "2026-08-30T00:00:00.000Z";

function ledger(): EvidenceLedger {
  const result = new EvidenceLedger({
    workspaceIdentityDigest: "workspace-1",
    now: () => CREATED_AT,
  });
  result.record({
    kind: "file_excerpt",
    locator: "src/index.ts#L1-L2",
    observedAt: CREATED_AT,
    summary: "export const value = 1;",
  });
  return result;
}

describe("evidence capsule integrity", () => {
  test("binds expiry to the digest so stale evidence cannot be revived", () => {
    const evidence = ledger();
    const capsule = evidence.createCapsule({
      sourceAgentId: "agent-scout-1",
      claims: ["the export exists"],
      expiresAt: "2026-08-31T00:00:00.000Z",
    });

    expect(evidence.acceptCapsule(capsule, {
      now: "2026-08-30T12:00:00.000Z",
    }).records).toHaveLength(1);
    expect(evidence.acceptCapsule({
      ...capsule,
      expiresAt: "2027-08-31T00:00:00.000Z",
    }).rejected[0]?.reason).toBe("capsule digest mismatch");
  });

  test("rejects expired capsules using parsed timestamps", () => {
    const evidence = ledger();
    const capsule = evidence.createCapsule({
      sourceAgentId: "agent-scout-1",
      claims: ["the export exists"],
      expiresAt: "2026-08-31T00:00:00.000Z",
    });

    expect(evidence.acceptCapsule(capsule, {
      now: "2026-09-01T00:00:00.000Z",
    }).rejected[0]?.reason).toBe("capsule expired");
  });

  test("rejects malformed or non-future expiry at creation", () => {
    const evidence = ledger();
    expect(() => evidence.createCapsule({
      sourceAgentId: "agent-scout-1",
      claims: ["the export exists"],
      expiresAt: "not-a-date",
    })).toThrow("evidence capsule expiry");
    expect(() => evidence.createCapsule({
      sourceAgentId: "agent-scout-1",
      claims: ["the export exists"],
      expiresAt: CREATED_AT,
    })).toThrow("evidence capsule expiry");
    expect(() => new EvidenceLedger({
      workspaceIdentityDigest: "workspace-1",
      now: () => "invalid-clock",
    }).createCapsule({
      sourceAgentId: "agent-scout-1",
      claims: ["the export exists"],
    })).toThrow("creation time");
  });

  test("digests the bounded claim that is actually replayed", () => {
    const evidence = ledger();
    const capsule = evidence.createCapsule({
      sourceAgentId: "agent-scout-1",
      claims: ["x".repeat(4_000)],
      expiresAt: "2026-08-31T00:00:00.000Z",
    });

    expect(capsule.claims[0]).toHaveLength(2_000);
    expect(evidence.acceptCapsule(capsule, {
      now: "2026-08-30T12:00:00.000Z",
    }).records).toHaveLength(1);
  });
});
