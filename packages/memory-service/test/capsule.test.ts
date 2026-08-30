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

describe("CapsuleStore activation gate (§6.3)", () => {
  test("a single verified trajectory never activates", () => {
    const { store } = storeFixture();
    const proposed = store.propose(proposal({ routeIds: ["route-1"] }));
    expect(proposed.accepted).toBe(true);
    if (!proposed.accepted) return;

    const result = store.activate(proposed.capsule.id);
    expect(result.activated).toBe(false);
    if (!result.activated) {
      expect(result.reasons.join(" ")).toContain("independent verified observations");
    }
    expect(store.get(proposed.capsule.id)?.status).toBe("proposed");
    expect(store.recall()).toEqual([]);
  });

  test("activation succeeds once the configured threshold is reached", () => {
    const { store } = storeFixture();
    const first = store.propose(proposal({ routeIds: ["route-1"] }));
    store.propose(proposal({ routeIds: ["route-2"], evidenceIds: ["ev-2"] }));
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;

    // Default threshold is three, so two trajectories are still short.
    expect(store.activate(first.capsule.id).activated).toBe(false);

    store.propose(proposal({ routeIds: ["route-3"], evidenceIds: ["ev-3"] }));
    const result = store.activate(first.capsule.id, { approved: true });
    expect(result.activated).toBe(true);
    if (!result.activated) return;
    expect(result.capsule.status).toBe("active");
    expect(store.recall().map((capsule) => capsule.id)).toEqual([first.capsule.id]);
  });

  test("the threshold comes from config but never drops below two", () => {
    const lenient = new CapsuleStore({ minVerifiedObservations: 1, now: () => "2026-01-01T00:00:00.000Z" });
    expect(lenient.minVerifiedObservations).toBe(2);
    const proposed = lenient.propose(proposal({ routeIds: ["route-1"] }));
    expect(proposed.accepted).toBe(true);
    if (!proposed.accepted) return;
    expect(lenient.activate(proposed.capsule.id).activated).toBe(false);

    const strict = new CapsuleStore({ minVerifiedObservations: 5 });
    expect(strict.minVerifiedObservations).toBe(5);
  });

  test("a rejected capsule is forgotten and cannot be reactivated", () => {
    const store = new CapsuleStore({ minVerifiedObservations: 2, now: () => "2026-01-01T00:00:00.000Z" });
    store.propose(proposal({ routeIds: ["route-1"] }));
    const second = store.propose(proposal({ routeIds: ["route-2"], evidenceIds: ["ev-2"] }));
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;

    const rejected = store.reject(second.capsule.id);
    expect(rejected.status).toBe("forgotten");
    const retry = store.activate(second.capsule.id);
    expect(retry.activated).toBe(false);
    if (!retry.activated) expect(retry.reasons.join(" ")).toContain("forgotten");
    expect(store.recall()).toEqual([]);
  });

  test("an expired active capsule drops out of recall", () => {
    const store = new CapsuleStore({ minVerifiedObservations: 2, now: () => "2026-01-01T00:00:00.000Z" });
    store.propose(proposal({ routeIds: ["route-1"], expiresAt: "2026-02-01T00:00:00.000Z" }));
    const second = store.propose(proposal({ routeIds: ["route-2"], evidenceIds: ["ev-2"] }));
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(store.activate(second.capsule.id, { approved: true }).activated).toBe(true);

    expect(store.recall({ now: "2026-01-15T00:00:00.000Z" })).toHaveLength(1);
    expect(store.recall({ now: "2026-03-01T00:00:00.000Z" })).toEqual([]);
  });
});

describe("CapsuleStore approval policy (§6.3)", () => {
  function readyStore(policy: "off" | "suggest" | "on", scope: "session" | "workspace" | "user") {
    const store = new CapsuleStore({
      minVerifiedObservations: 2,
      policy,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    store.propose(proposal({ scope, routeIds: ["route-1"] }));
    const second = store.propose(proposal({ scope, routeIds: ["route-2"], evidenceIds: ["ev-2"] }));
    return { store, proposed: second };
  }

  test("workspace scope cannot activate without approval", () => {
    const { store, proposed } = readyStore("suggest", "workspace");
    expect(proposed.accepted).toBe(true);
    if (!proposed.accepted) return;

    const refused = store.activate(proposed.capsule.id);
    expect(refused.activated).toBe(false);
    if (!refused.activated) expect(refused.reasons.join(" ")).toContain("approval");
    expect(store.recall()).toEqual([]);

    const approved = store.activate(proposed.capsule.id, { approved: true });
    expect(approved.activated).toBe(true);
    expect(store.recall()).toHaveLength(1);
  });

  test("user scope needs approval even under the permissive policy", () => {
    const { store, proposed } = readyStore("on", "user");
    expect(proposed.accepted).toBe(true);
    if (!proposed.accepted) return;
    expect(store.requiresApproval("user")).toBe(true);
    expect(store.activate(proposed.capsule.id).activated).toBe(false);
    expect(store.activate(proposed.capsule.id, { approved: true }).activated).toBe(true);
  });

  test("the default policy keeps even session scope suggestion-only", () => {
    const { store, proposed } = readyStore("suggest", "session");
    expect(store.policy).toBe("suggest");
    expect(store.requiresApproval("session")).toBe(true);
    expect(proposed.accepted).toBe(true);
    if (!proposed.accepted) return;
    expect(store.activate(proposed.capsule.id).activated).toBe(false);
  });

  test("policy `on` activates session scope unattended and nothing wider", () => {
    const { store, proposed } = readyStore("on", "session");
    expect(store.requiresApproval("session")).toBe(false);
    expect(store.requiresApproval("workspace")).toBe(true);
    expect(proposed.accepted).toBe(true);
    if (!proposed.accepted) return;
    expect(store.activate(proposed.capsule.id).activated).toBe(true);
  });

  test("policy `off` refuses the proposal outright", () => {
    const { store, proposed } = readyStore("off", "session");
    expect(proposed.accepted).toBe(false);
    if (!proposed.accepted) expect(proposed.reasons.join(" ")).toContain("disabled");
    expect(store.size).toBe(0);
  });
});

describe("CapsuleStore invalidators (§6.3, §6.4)", () => {
  function activeCapsule(invalidators: readonly string[]) {
    const store = new CapsuleStore({
      minVerifiedObservations: 2,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    store.propose(proposal({ routeIds: ["route-1"], invalidators }));
    const second = store.propose(proposal({ routeIds: ["route-2"], evidenceIds: ["ev-2"] }));
    if (!second.accepted) throw new Error("fixture proposal was rejected");
    const activated = store.activate(second.capsule.id, { approved: true });
    if (!activated.activated) throw new Error("fixture capsule did not activate");
    return { store, capsule: activated.capsule };
  }

  test("a matching code change contests the capsule and drops it from recall", () => {
    const { store, capsule } = activeCapsule(["packages/config-schema changed"]);
    expect(store.recall()).toHaveLength(1);

    const result = store.evaluateInvalidators({
      kind: "code",
      subjects: ["packages/config-schema/src/schema.ts"],
    });

    expect(result.contested.map((entry) => entry.id)).toEqual([capsule.id]);
    expect(store.get(capsule.id)?.status).toBe("contested");
    expect(store.recall()).toEqual([]);
  });

  test("a toolset change matches an invalidator that names the kind", () => {
    const { store, capsule } = activeCapsule(["toolset changed"]);
    expect(store.evaluateInvalidators({ kind: "toolset" }).contested).toHaveLength(1);
    expect(store.get(capsule.id)?.status).toBe("contested");
  });

  test("a policy change matches only capsules that named policy", () => {
    const { store, capsule } = activeCapsule(["permissions policy digest changed"]);
    expect(store.evaluateInvalidators({ kind: "code", subjects: ["src/app.ts"] }).contested).toEqual([]);
    expect(store.get(capsule.id)?.status).toBe("active");

    expect(store.evaluateInvalidators({ kind: "policy" }).contested).toHaveLength(1);
    expect(store.recall()).toEqual([]);
  });

  test("an unrelated change leaves the capsule active", () => {
    const { store, capsule } = activeCapsule(["docs/wiki changed"]);
    const result = store.evaluateInvalidators({ kind: "code", subjects: ["crates/cbc-runtime/src/lib.rs"] });
    expect(result.contested).toEqual([]);
    expect(store.get(capsule.id)?.status).toBe("active");
    expect(store.recall()).toHaveLength(1);
  });

  test("a contested capsule cannot be re-activated without resolution", () => {
    const { store, capsule } = activeCapsule(["toolset changed"]);
    store.evaluateInvalidators({ kind: "toolset" });

    const retry = store.activate(capsule.id, { approved: true });
    expect(retry.activated).toBe(false);
    if (!retry.activated) expect(retry.reasons.join(" ")).toContain("contested");
  });

  test("invalidation is recorded in the transition log with its reason", () => {
    const { store } = activeCapsule(["toolset changed"]);
    store.evaluateInvalidators({ kind: "toolset" });

    const last = store.transitionLog().at(-1);
    expect(last?.toStatus).toBe("contested");
    expect(last?.reason).toContain("toolset");
  });
});
