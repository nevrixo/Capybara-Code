import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function sessionRuntime() {
  return {
    workspace: "/work",
    read: async () => ({
      path: "ignored",
      binary: false,
      checksum: "a".repeat(64),
      rendered: "",
    }),
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
}

interface Harness {
  readonly session: AgentSession;
  readonly events: CbcEvent[];
}

function harness(sessionId: string): Harness {
  const events: CbcEvent[] = [];
  let now = 1_000;
  const session = new AgentSession({
    host: { now: () => (now += 1_000) } as never,
    runtime: sessionRuntime() as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "c".repeat(64),
    trust: "trusted-always",
    sessionId,
    provider: new MockProvider({ steps: [{ text: "done" }] }),
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => (now += 1_000),
    onEvent: (event) => { events.push(event); },
  });
  return { session, events };
}

describe("session goal contract", () => {
  test("a session with no contract behaves as before", () => {
    const { session } = harness("goal-absent");
    expect(session.goalContract()).toBeUndefined();
    expect(session.goalEvaluation()).toBeUndefined();
    expect(session.goalContractRecord).toBeUndefined();
  });

  test("declaring a goal binds it to the current epoch and workspace", () => {
    const { session } = harness("goal-declared");
    session.startGoalContract({
      goal: "migrate the reducer",
      successCriteria: [{ id: "c1", statement: "reducer done", kind: "todo", refs: ["t1"] }],
    });
    const contract = session.goalContract();
    expect(contract?.goal).toBe("migrate the reducer");
    expect(contract?.taskEpochId).toBe(session.taskEpoch.requireCurrent().id);
    expect(contract?.workspaceIdentityDigest)
      .toBe(session.taskEpoch.requireCurrent().workspaceIdentityDigest);
  });

  test("a declared contract is durable from the moment it is evaluated", () => {
    const { session } = harness("goal-durable");
    session.startGoalContract({
      goal: "survive a detach",
      successCriteria: [{ id: "c1", statement: "step", kind: "todo", refs: ["t1"] }],
    });
    const record = session.goalContractRecord;
    expect(record?.contract.goal).toBe("survive a detach");
    expect(record?.evaluation.outstandingCriteria).toEqual(["c1"]);

    // A detached process hands the record to a fresh session; the resumed goal
    // must be the same contract, not a re-derived one with a fresh budget.
    const resumed = harness("goal-durable-resumed").session;
    expect(resumed.hydrateGoalContract(JSON.parse(JSON.stringify(record)))).toBe(true);
    expect(resumed.goalContract()?.id).toBe(record?.contract.id);
    expect(resumed.goalEvaluation()?.outstandingCriteria).toEqual(["c1"]);
  });

  test("hydrating junk leaves the session contract-free rather than half adopted", () => {
    const { session } = harness("goal-bad-hydrate");
    expect(session.hydrateGoalContract({ contract: { id: "x" } })).toBe(false);
    expect(session.goalContract()).toBeUndefined();
  });

  test("clearing a goal removes it", () => {
    const { session } = harness("goal-cleared");
    session.startGoalContract({ goal: "temporary goal" });
    expect(session.goalContract()).toBeDefined();
    session.clearGoalContract();
    expect(session.goalContract()).toBeUndefined();
  });

  test("a declared goal reports its open criteria immediately", () => {
    const { session } = harness("goal-open");
    const evaluation = session.startGoalContract({
      goal: "two open criteria",
      successCriteria: [
        { id: "c1", statement: "first", kind: "todo", refs: ["t1"] },
        { id: "c2", statement: "second", kind: "verification", refs: ["bun test"] },
      ],
    });
    expect(evaluation?.status).toBe("active");
    expect(evaluation?.outstandingCriteria).toEqual(["c1", "c2"]);
  });
});
