import { describe, expect, test } from "bun:test";

import {
  PluginCircuitBreaker,
  type PluginCircuitAdmission,
  type PluginCircuitPermit,
} from "../src/index.ts";

const PLUGIN_ID = "acme/guard";

function allowed(admission: PluginCircuitAdmission): PluginCircuitPermit {
  if (admission.kind !== "allowed") throw new Error("expected circuit admission");
  return admission.permit;
}

describe("PluginCircuitBreaker", () => {
  test("opens after bounded consecutive failures and blocks during cooldown", () => {
    let now = 1_000;
    const circuit = new PluginCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 100,
      now: () => now,
    });

    for (let index = 0; index < 3; index += 1) {
      circuit.recordFailure(allowed(circuit.admit(PLUGIN_ID)));
    }

    expect(circuit.snapshot(PLUGIN_ID)).toEqual({
      pluginId: PLUGIN_ID,
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: 1_000,
      openedAt: 1_000,
      retryAt: 1_100,
    });
    expect(circuit.admit(PLUGIN_ID)).toEqual({
      kind: "blocked",
      state: "open",
      retryAt: 1_100,
    });
    now = 1_099;
    expect(circuit.admit(PLUGIN_ID)).toMatchObject({ kind: "blocked", retryAt: 1_100 });
  });

  test("resets a closed circuit after a successful invocation", () => {
    let now = 1_000;
    const circuit = new PluginCircuitBreaker({ now: () => now });
    circuit.recordFailure(allowed(circuit.admit(PLUGIN_ID)));

    now = 1_001;
    circuit.recordSuccess(allowed(circuit.admit(PLUGIN_ID)));

    now = 1_002;
    circuit.recordFailure(allowed(circuit.admit(PLUGIN_ID)));
    expect(circuit.snapshot(PLUGIN_ID)).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
      lastFailureAt: 1_002,
    });
  });

  test("admits exactly one half-open probe and closes after recovery", () => {
    let now = 10;
    const circuit = new PluginCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 25,
      now: () => now,
    });
    circuit.recordFailure(allowed(circuit.admit(PLUGIN_ID)));

    now = 35;
    const probe = circuit.admit(PLUGIN_ID);
    expect(probe).toMatchObject({ kind: "allowed", state: "half-open" });
    expect(circuit.admit(PLUGIN_ID)).toEqual({
      kind: "blocked",
      state: "open",
      retryAt: 35,
    });

    circuit.recordSuccess(allowed(probe));
    expect(circuit.snapshot(PLUGIN_ID)).toEqual({
      pluginId: PLUGIN_ID,
      state: "closed",
      consecutiveFailures: 0,
    });
    expect(circuit.admit(PLUGIN_ID)).toMatchObject({ kind: "allowed", state: "closed" });
  });

  test("reopens a failed probe and ignores stale completions from an older generation", () => {
    let now = 0;
    const circuit = new PluginCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      now: () => now,
    });
    const original = allowed(circuit.admit(PLUGIN_ID));
    circuit.recordFailure(original);

    now = 10;
    const probe = allowed(circuit.admit(PLUGIN_ID));
    circuit.recordFailure(probe);
    circuit.recordSuccess(original);

    expect(circuit.snapshot(PLUGIN_ID)).toMatchObject({
      state: "open",
      consecutiveFailures: 2,
      retryAt: 20,
    });
  });

  test("does not allow a backward clock to bypass an open circuit", () => {
    let now = 100;
    const circuit = new PluginCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 50,
      now: () => now,
    });
    circuit.recordFailure(allowed(circuit.admit(PLUGIN_ID)));

    now = 10;
    expect(circuit.admit(PLUGIN_ID)).toEqual({
      kind: "blocked",
      state: "open",
      retryAt: 150,
    });
    now = 150;
    expect(circuit.admit(PLUGIN_ID)).toMatchObject({ kind: "allowed", state: "half-open" });
  });

  test("keeps snapshots deterministic and validates bounded configuration", () => {
    const circuit = new PluginCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5,
      now: () => 0,
    });
    circuit.recordFailure(allowed(circuit.admit("zeta/guard")));
    circuit.recordFailure(allowed(circuit.admit("alpha/guard")));

    expect(circuit.snapshots().map((entry) => entry.pluginId)).toEqual([
      "alpha/guard",
      "zeta/guard",
    ]);
    expect(() => new PluginCircuitBreaker({ failureThreshold: 0 })).toThrow(
      "failureThreshold must be a bounded positive integer",
    );
    expect(() => new PluginCircuitBreaker({ cooldownMs: 0 })).toThrow(
      "cooldownMs must be a bounded positive integer",
    );
  });
});
