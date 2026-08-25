import { describe, expect, test } from "bun:test";

import type { MemoryEvidence } from "@cbc/context-engine";

import { MemoryService, detectSecretShaped, memoryToContextItem } from "../src/index.ts";

function evidence(
  id: string,
  observedAt: string,
  overrides: Partial<MemoryEvidence> = {},
): MemoryEvidence {
  return {
    id,
    freshness: "fresh",
    observedAt,
    exact: true,
    workspaceIdentityDigest: "workspace-a",
    digest: `${id}-digest`,
    ...overrides,
  };
}

function serviceFixture(workspaceIdentity = "workspace-a") {
  let now = "2026-01-01T00:00:00.000Z";
  const records = new Map<string, MemoryEvidence>();
  const service = new MemoryService({
    resolveEvidence: (id) => records.get(id),
    workspaceIdentity,
    sessionId: "session-a",
    taskId: "task-a",
    branch: "main",
    now: () => now,
  });
  return {
    service,
    records,
    setNow(value: string) {
      now = value;
    },
  };
}

describe("memory-service", () => {
  test("rejects secret-shaped remember candidates", () => {
    const { service, records } = serviceFixture();
    records.set("ev-1", evidence("ev-1", "2026-01-01T00:00:00.000Z"));

    const password = service.remember({
      key: "db.password",
      value: "hunter2",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["ev-1"],
    });
    expect(password.accepted).toBe(false);
    if (!password.accepted) expect(password.reasons.join(" ")).toContain("password");

    const token = service.remember({
      key: "deploy.note",
      value: "store the access_token in vault",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["ev-1"],
    });
    expect(token.accepted).toBe(false);
    if (!token.accepted) expect(token.reasons.join(" ")).toContain("token");

    expect(detectSecretShaped("api_key", "x").some((reason) => reason.includes("api_key"))).toBe(true);
    expect(service.size).toBe(0);
  });

  test("never recalls contested records", () => {
    const { service, records, setNow } = serviceFixture();
    const observedAt = "2026-01-01T00:00:00.000Z";
    records.set("ev-left", evidence("ev-left", observedAt));
    records.set("ev-right", evidence("ev-right", observedAt));

    const left = service.remember({
      key: "formatter",
      value: "prettier",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["ev-left"],
    });
    expect(left.accepted).toBe(true);

    const right = service.remember({
      key: "formatter",
      value: "biome",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["ev-right"],
    });
    expect(right.accepted).toBe(true);
    if (right.accepted) expect(right.action).toBe("contested");

    expect(service.recall({ key: "formatter" })).toHaveLength(0);
    expect(service.inspect().contestedIds.length).toBe(2);

    setNow("2026-01-03T00:00:00.000Z");
    records.set("ev-resolution", evidence("ev-resolution", "2026-01-03T00:00:00.000Z"));
    if (!left.accepted) throw new Error("expected left write");
    service.resolveContest({
      winnerId: left.record.id,
      evidenceIds: ["ev-resolution"],
      reason: "checked-in config wins",
    });
    expect(service.recall({ key: "formatter" })[0]?.value).toBe("prettier");
  });

  test("enforces cross-workspace isolation", () => {
    const { service, records } = serviceFixture("workspace-a");
    records.set("ev-1", evidence("ev-1", "2026-01-01T00:00:00.000Z"));
    const accepted = service.remember({
      key: "build.command",
      value: "bun test",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["ev-1"],
    });
    expect(accepted.accepted).toBe(true);

    const foreign = service.remember({
      key: "build.command",
      value: "bun test",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["ev-1"],
      validFor: { workspaceIdentity: "workspace-b" },
    });
    expect(foreign.accepted).toBe(false);
    if (!foreign.accepted) expect(foreign.reasons.join(" ")).toContain("cross-workspace");

    expect(service.recall({ workspaceIdentity: "workspace-b" })).toHaveLength(0);
    expect(service.recall()).toHaveLength(1);
  });

  test("snapshot round-trip preserves forgotten ids and recall", () => {
    const { service, records } = serviceFixture();
    records.set("ev-1", evidence("ev-1", "2026-01-01T00:00:00.000Z"));
    records.set("ev-2", evidence("ev-2", "2026-01-01T00:00:01.000Z"));

    const first = service.remember({
      key: "pkg.manager",
      value: "bun",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["ev-1"],
    });
    const second = service.remember({
      key: "test.runner",
      value: "bun test",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["ev-2"],
    });
    expect(first.accepted && second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) throw new Error("writes failed");

    service.forget(first.record.id);
    expect(service.recall().map((record) => record.key)).toEqual(["test.runner"]);

    const snap = service.snapshot();
    const restored = MemoryService.fromSnapshot(snap, {
      resolveEvidence: (id) => records.get(id),
      sessionId: "session-a",
      taskId: "task-a",
      branch: "main",
      now: () => "2026-01-04T00:00:00.000Z",
    });
    expect(restored.snapshot()).toEqual(snap);
    expect(restored.recall().map((record) => record.key)).toEqual(["test.runner"]);
    expect(restored.inspect().forgottenIds).toEqual([first.record.id]);
  });

  test("ingestRestored hydrates a store-backed record without write-gate evidence", () => {
    const { service } = serviceFixture();
    service.ingestRestored({
      id: "memory-restored",
      key: "build.system",
      value: "ninja",
      scope: "workspace",
      status: "active",
      confidence: 0.9,
      evidenceIds: ["ev-store"],
      validFor: { workspaceIdentity: "workspace-a" },
      createdAt: "2026-01-01T00:00:00.000Z",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
      evidenceObservedAt: "2026-01-01T00:00:00.000Z",
      supersedes: [],
      contestedWith: [],
      revision: 1,
    });
    expect(service.recall().map((record) => record.key)).toEqual(["build.system"]);
  });

  test("toContextItems projects active recalled records", () => {
    const { service, records } = serviceFixture();
    records.set("ev-1", evidence("ev-1", "2026-01-01T00:00:00.000Z"));
    const write = service.remember({
      key: "lint.tool",
      value: "biome",
      scope: "workspace",
      confidence: 0.91,
      evidenceIds: ["ev-1"],
    });
    expect(write.accepted).toBe(true);
    if (!write.accepted) throw new Error("write failed");

    const items = service.toContextItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "memory",
      id: write.record.id,
      layer: "L5_compact_state",
      text: "lint.tool: biome",
      provenance: {
        memoryId: write.record.id,
        evidenceIds: ["ev-1"],
        scope: "workspace",
        confidence: 0.91,
      },
    });
    expect(items[0]!.tokens).toBeGreaterThan(0);
    expect(memoryToContextItem(write.record).kind).toBe("memory");
  });
});
