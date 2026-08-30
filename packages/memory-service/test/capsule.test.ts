/**
 * §6.2/§6.3 Strategy Capsule store — proposal entry, evidence gating, and
 * secret rejection (P1-01).
 */

import { describe, expect, test } from "bun:test";

import { CapsuleStore, capsuleId, type CapsuleProposalInput } from "../src/index.ts";

function storeFixture() {
  let now = "2026-01-01T00:00:00.000Z";
  const store = new CapsuleStore({ now: () => now });
  return {
    store,
    setNow(value: string) {
      now = value;
    },
  };
}

function proposal(overrides: Partial<CapsuleProposalInput> = {}): CapsuleProposalInput {
  return {
    kind: "workflow",
    statement: "run bun run typecheck before claiming a change compiles",
    scope: "workspace",
    evidenceIds: ["ev-1"],
    confidence: 0.9,
    routeIds: ["route-1"],
    ...overrides,
  };
}

describe("CapsuleStore proposal entry (§6.2, §6.3)", () => {
  test("a capsule enters as proposed and never as active", () => {
    const { store } = storeFixture();
    const result = store.propose(proposal());

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.action).toBe("proposed");
    expect(result.capsule.status).toBe("proposed");
    expect(store.all().every((capsule) => capsule.status === "proposed")).toBe(true);
  });

  test("the full §6.2 shape is carried, including the fields MemoryRecord lacks", () => {
    const { store } = storeFixture();
    const result = store.propose(proposal({
      kind: "invariant",
      invalidators: ["package.json changed", "toolset changed"],
      expiresAt: "2026-06-01T00:00:00.000Z",
      routeIds: ["route-a", "route-b"],
    }));

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const capsule = result.capsule;
    expect(capsule.kind).toBe("invariant");
    expect(capsule.scope).toBe("workspace");
    expect(capsule.statement.length).toBeGreaterThan(0);
    expect(capsule.evidenceIds).toEqual(["ev-1"]);
    expect(capsule.invalidators).toEqual(["package.json changed", "toolset changed"]);
    expect(capsule.createdFromRouteIds).toEqual(["route-a", "route-b"]);
    expect(capsule.observedCount).toBe(2);
    expect(capsule.expiresAt).toBe("2026-06-01T00:00:00.000Z");
    expect(capsule.revision).toBe(1);
  });

  test("a proposal with no evidence is rejected, session scope included", () => {
    const { store } = storeFixture();
    for (const scope of ["session", "workspace", "user"] as const) {
      const result = store.propose(proposal({ scope, evidenceIds: [] }));
      expect(result.accepted).toBe(false);
      if (result.accepted) continue;
      expect(result.reasons.join(" ")).toContain("evidence");
    }
    expect(store.size).toBe(0);
  });

  test("a secret-shaped statement is never stored", () => {
    const { store } = storeFixture();
    const result = store.propose(proposal({
      statement: "deploy with the api_key from the shared vault",
    }));

    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reasons.join(" ")).toContain("api_key");
    expect(store.size).toBe(0);
  });

  test("the same claim on a second route accrues a trajectory, not a duplicate", () => {
    const { store, setNow } = storeFixture();
    store.propose(proposal({ routeIds: ["route-1"] }));
    setNow("2026-01-02T00:00:00.000Z");
    const second = store.propose(proposal({ routeIds: ["route-2"], evidenceIds: ["ev-2"] }));

    expect(store.size).toBe(1);
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(second.action).toBe("observed");
    expect(second.capsule.observedCount).toBe(2);
    expect(second.capsule.evidenceIds).toEqual(["ev-1", "ev-2"]);
    expect(second.capsule.revision).toBe(2);
    expect(second.capsule.status).toBe("proposed");
  });

  test("re-observing on the same route does not inflate the count", () => {
    const { store } = storeFixture();
    store.propose(proposal({ routeIds: ["route-1"] }));
    const repeat = store.propose(proposal({ routeIds: ["route-1"], evidenceIds: ["ev-9"] }));

    expect(repeat.accepted).toBe(true);
    if (!repeat.accepted) return;
    expect(repeat.capsule.observedCount).toBe(1);
  });

  test("the same statement at a different scope is a different capsule", () => {
    const { store } = storeFixture();
    store.propose(proposal({ scope: "session" }));
    store.propose(proposal({ scope: "workspace" }));
    expect(store.size).toBe(2);
    expect(capsuleId("workflow", proposal().statement, "session"))
      .not.toBe(capsuleId("workflow", proposal().statement, "workspace"));
  });

  test("the transition log records the proposal and survives a snapshot round trip", () => {
    const { store } = storeFixture();
    store.propose(proposal());

    const log = store.transitionLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.fromStatus).toBe("absent");
    expect(log[0]?.toStatus).toBe("proposed");

    const restored = CapsuleStore.fromSnapshot(store.snapshot());
    expect(restored.snapshot()).toEqual(store.snapshot());
  });

  test("a snapshot with a secret-shaped capsule does not restore it", () => {
    const { store } = storeFixture();
    store.propose(proposal());
    const snapshot = store.snapshot();
    const poisoned = {
      ...snapshot,
      capsules: snapshot.capsules.map((capsule) => ({
        ...capsule,
        statement: "the refresh_token lives in ~/.cbc",
      })),
    };

    expect(CapsuleStore.fromSnapshot(poisoned).size).toBe(0);
  });
});
