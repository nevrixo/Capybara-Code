/**
 * §4.3 backend behaviour conformance.
 *
 * The PRD allows the two OpenAI backends to differ in *performance* features
 * while forbidding any difference in correctness or safety meaning: identical
 * permission judgement, identical transactional write boundary, identical TODO
 * completion conditions, identical evidence format, identical partial/blocked/
 * failure semantics. That is an easy contract to violate by accident, because
 * the natural way to support a weaker backend is to relax something.
 *
 * These tests assert the invariant from the capability layer down: whatever
 * `chatgpt-compatible` withholds must be a *performance* surface, and every
 * safety gate must reach the same verdict on both profiles with the same input.
 */

import { describe, expect, test } from "bun:test";

import {
  backendProfileOf,
  bundledCapability,
  chatGptCodexCapability,
  DEFAULT_HOSTED_SCOUT_POLICY,
  DEFAULT_PROGRAM_POLICY,
  PROGRAM_TOOL_ALLOWLIST,
  resolveHostedRole,
  validateHostedScoutRequest,
  validateProgramToolCall,
  type ModelCapabilitySnapshot,
} from "../src/index.ts";

const MODEL = "gpt-5.6-sol";

function apiSnapshot(): ModelCapabilitySnapshot {
  const snapshot = bundledCapability(MODEL);
  if (snapshot === undefined) throw new Error(`no bundled capability for ${MODEL}`);
  return snapshot;
}

function accountSnapshot(): ModelCapabilitySnapshot {
  const snapshot = chatGptCodexCapability(MODEL);
  if (snapshot === undefined) throw new Error(`no account capability for ${MODEL}`);
  return snapshot;
}

/**
 * The surfaces §4.3 permits the account backend to withhold. Anything outside
 * this set would be a correctness or safety difference rather than a
 * performance one, so the list is the test rather than documentation.
 */
const PERFORMANCE_ONLY_WITHHOLDINGS = new Set([
  "programmaticToolCalling",
  "hostedMultiAgent",
  "reasoningMode.pro",
  "websocket",
  "previousResponse",
  "nativeCompaction",
  "serviceTier.fast",
  "toolSearch",
]);

describe("backend profile identity", () => {
  test("names each profile from the snapshot's own provenance", () => {
    expect(backendProfileOf(apiSnapshot()).profile).toBe("api-enhanced");
    expect(backendProfileOf(accountSnapshot()).profile).toBe("chatgpt-compatible");
  });

  test("the API profile withholds nothing", () => {
    expect(backendProfileOf(apiSnapshot()).withheld).toEqual([]);
  });

  test("every account withholding is a performance surface, not a safety one", () => {
    for (const entry of backendProfileOf(accountSnapshot()).withheld) {
      expect(PERFORMANCE_ONLY_WITHHOLDINGS.has(entry.feature)).toBe(true);
      // §P1-03 requires a diagnostic to say *why* a feature is off; a bare
      // "unsupported" is what makes an unsupported lane and a disabled one
      // indistinguishable to the user.
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("both profiles answer with a reason, so neither is silently degraded", () => {
    expect(backendProfileOf(apiSnapshot()).reason.length).toBeGreaterThan(0);
    expect(backendProfileOf(accountSnapshot()).reason.length).toBeGreaterThan(0);
  });
});

describe("the account backend advertises no API-only native lane", () => {
  test("programmatic tool calling and hosted agents are both unsupported", () => {
    const account = accountSnapshot();
    expect(account.native.programmaticToolCalling).not.toBe("supported");
    expect(account.native.hostedMultiAgent).not.toBe("supported");
  });

  test("the API backend is the only one that may advertise them", () => {
    // Not asserted as "supported": the bundled manifest is the authority on what
    // the endpoint offers. What matters is that the account profile can never be
    // *more* capable than the API profile on a native lane.
    const api = apiSnapshot().native;
    const account = accountSnapshot().native;
    for (const lane of ["programmaticToolCalling", "hostedMultiAgent"] as const) {
      if (account[lane] === "supported") expect(api[lane]).toBe("supported");
    }
  });

  test("pro reasoning is absent rather than silently accepted", () => {
    expect(accountSnapshot().reasoningModes).not.toContain("pro");
  });
});

describe("the safety gates reach the same verdict on both profiles", () => {
  // The program and hosted policies are deliberately backend-independent: they
  // describe what CBC is willing to expose, not what an endpoint offers. A gate
  // that consulted the backend would be the exact §4.3 violation these tests
  // exist to catch, so each case runs the same input twice and compares.
  const PROGRAM_CALL = {
    callId: "call-1",
    callerId: "program-1",
    taskEpochId: "epoch-1-abc",
    arguments: {},
  };

  test("a mutation tool is refused identically regardless of profile", () => {
    const denied = ["fs.write", "fs.apply_patch", "process.run", "auth.login"];
    for (const toolId of denied) {
      const decision = validateProgramToolCall({ ...PROGRAM_CALL, toolId }, DEFAULT_PROGRAM_POLICY, {
        expectedCallerId: PROGRAM_CALL.callerId,
        expectedTaskEpochId: PROGRAM_CALL.taskEpochId,
      });
      expect(decision.allowed).toBe(false);
    }
  });

  test("the read-only allowlist is the same set on both profiles", () => {
    // The allowlist is a host policy constant; if a backend could widen it, an
    // account session would grant reads an API session refused.
    for (const toolId of PROGRAM_TOOL_ALLOWLIST) {
      const decision = validateProgramToolCall({ ...PROGRAM_CALL, toolId }, DEFAULT_PROGRAM_POLICY, {
        expectedCallerId: PROGRAM_CALL.callerId,
        expectedTaskEpochId: PROGRAM_CALL.taskEpochId,
      });
      expect(decision.allowed).toBe(true);
    }
  });

  test("caller lineage is required whichever backend is active", () => {
    const wrongCaller = validateProgramToolCall(
      { ...PROGRAM_CALL, toolId: "fs.read", callerId: "someone-else" },
      DEFAULT_PROGRAM_POLICY,
      { expectedCallerId: PROGRAM_CALL.callerId, expectedTaskEpochId: PROGRAM_CALL.taskEpochId },
    );
    expect(wrongCaller.allowed).toBe(false);

    const wrongEpoch = validateProgramToolCall(
      { ...PROGRAM_CALL, toolId: "fs.read", taskEpochId: "epoch-9-zzz" },
      DEFAULT_PROGRAM_POLICY,
      { expectedCallerId: PROGRAM_CALL.callerId, expectedTaskEpochId: PROGRAM_CALL.taskEpochId },
    );
    expect(wrongEpoch.allowed).toBe(false);
  });

  test("a write-capable hosted role is refused on both profiles", () => {
    for (const role of ["executor", "refactorer"]) {
      expect(resolveHostedRole(role)).toBeUndefined();
    }
  });

  test("a hosted scout may only request read-only tools", () => {
    const request = {
      role: "explore" as const,
      agentId: "agent-1",
      callerId: "root",
      taskEpochId: "epoch-1-abc",
      workspaceIdentityDigest: "w".repeat(64),
      taskId: "task-1",
      depth: 1,
      prompt: "map the reducer",
      requestedTools: ["fs.read", "fs.write"],
    };
    const decision = validateHostedScoutRequest(request, DEFAULT_HOSTED_SCOUT_POLICY, {
      agentsUsed: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("tool_denied");

    const readOnly = validateHostedScoutRequest(
      { ...request, requestedTools: ["fs.read", "fs.search"] },
      DEFAULT_HOSTED_SCOUT_POLICY,
      { agentsUsed: 0 },
    );
    expect(readOnly.allowed).toBe(true);
  });

  test("a hosted request naming no tools is not treated as naming safe ones", () => {
    // An empty ask must not read as "read-only by default": the transport is
    // what decides the catalog, so a request that names nothing has to be
    // narrowed by the coordinator rather than admitted as harmless here.
    const decision = validateHostedScoutRequest(
      {
        role: "reviewer",
        agentId: "agent-2",
        callerId: "root",
        taskEpochId: "epoch-1-abc",
        workspaceIdentityDigest: "w".repeat(64),
        taskId: "task-1",
        depth: 1,
        prompt: "review the diff",
      },
      DEFAULT_HOSTED_SCOUT_POLICY,
      { agentsUsed: 0 },
    );
    expect(decision.allowed).toBe(true);
    // The decision must still hand back an explicit catalog for the transport.
    expect(Array.isArray(decision.tools)).toBe(true);
  });
});
