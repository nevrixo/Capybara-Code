import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HOSTED_SCOUT_POLICY,
  digestHostedEvidenceCapsule,
  resolveHostedRole,
  validateHostedScoutRequest,
  type HostedScoutReport,
  type HostedScoutRequest,
} from "@cbc/provider-openai";

import {
  HostedScoutCoordinator,
  type HostedScoutEmitter,
} from "../src/hosted-scout.ts";

function validRequest(overrides: Partial<HostedScoutRequest> = {}): HostedScoutRequest {
  return {
    role: "HostedScout",
    agentId: "agent-scout-1",
    callerId: "root",
    taskEpochId: "epoch-1",
    taskId: "task-1",
    workspaceIdentityDigest: "workspace-1",
    depth: 0,
    prompt: "Inspect the routing implementation and cite evidence.",
    requestedTools: ["fs.read", "fs.search"],
    ...overrides,
  };
}

function report(request: HostedScoutRequest): HostedScoutReport {
  const capsuleBody = {
    taskId: request.taskId!,
    agentClass: request.role,
    taskEpochId: request.taskEpochId,
    workspaceIdentityDigest: request.workspaceIdentityDigest!,
    claims: [{ text: "routing is read-only", evidenceRefs: ["ev-1"], confidence: 0.9 }],
    unresolved: [],
    suggestedNextSteps: [],
    tokenUsage: 120,
    evidenceIds: ["ev-1"],
  } as const;
  return {
    agentId: request.agentId,
    callerId: request.callerId,
    taskEpochId: request.taskEpochId,
    taskId: request.taskId!,
    workspaceIdentityDigest: request.workspaceIdentityDigest!,
    claims: ["routing is read-only"],
    evidenceCapsule: {
      ...capsuleBody,
      digest: digestHostedEvidenceCapsule(capsuleBody),
    },
  };
}

function scout(agentId: string, overrides: Partial<HostedScoutRequest> = {}): Omit<HostedScoutRequest, "callerId" | "taskEpochId" | "workspaceIdentityDigest"> {
  return {
    role: "explore",
    agentId,
    taskId: "task-1",
    depth: 0,
    prompt: "Inspect routing.",
    requestedTools: ["fs.read"],
    ...overrides,
  };
}

describe("hosted scout safety boundary", () => {
  test("rejects forged roles, missing identity, and policy attempts to widen the catalog", () => {
    expect(validateHostedScoutRequest({
      ...validRequest(),
      role: "executor" as unknown as "HostedScout",
    })).toMatchObject({ allowed: false, code: "role_invalid" });
    expect(validateHostedScoutRequest({
      ...validRequest(),
      agentId: "",
    })).toMatchObject({ allowed: false, code: "agent_missing" });
    expect(validateHostedScoutRequest({
      ...validRequest(),
      workspaceIdentityDigest: "",
    })).toMatchObject({ allowed: false, code: "workspace_missing" });
    expect(validateHostedScoutRequest(
      validRequest({ requestedTools: ["fs.edit"] }),
      {
        ...DEFAULT_HOSTED_SCOUT_POLICY,
        allowlistedTools: [...DEFAULT_HOSTED_SCOUT_POLICY.allowlistedTools, "fs.edit"],
      },
    )).toMatchObject({ allowed: false, code: "tool_denied" });
  });

  test("accepts the PRD role names and refuses the write-capable ones", () => {
    // §5.6 names explore/architect/reviewer as the allowed roles; the gate used
    // to know only its own two class names, so the PRD spelling was rejected.
    expect(resolveHostedRole("explore")).toBe("HostedScout");
    expect(resolveHostedRole("architect")).toBe("HostedScout");
    expect(resolveHostedRole("reviewer")).toBe("HostedReviewer");
    expect(resolveHostedRole("executor")).toBeUndefined();
    expect(resolveHostedRole("refactorer")).toBeUndefined();
    expect(validateHostedScoutRequest(validRequest({ role: "architect" }))).toMatchObject({
      allowed: true,
      role: "HostedScout",
    });
    expect(validateHostedScoutRequest(validRequest({ role: "reviewer" }))).toMatchObject({
      allowed: true,
      role: "HostedReviewer",
    });
  });

  test("refuses a write-capable role by authority rather than by name", async () => {
    const coordinator = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      transport: {
        spawn: async () => {
          throw new Error("a writer role must never reach the transport");
        },
      },
    });

    for (const role of ["executor", "refactorer", "test"] as const) {
      const result = await coordinator.run({
        role: role as unknown as "HostedScout",
        agentId: `agent-${role}`,
        taskId: "task-1",
        depth: 0,
        prompt: "Change the routing implementation.",
        requestedTools: ["fs.read"],
      }, new AbortController().signal);
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("write-capable");
    }
    expect(coordinator.agentsUsed).toBe(0);
  });

  test("hands the transport the narrowed catalog rather than the caller's request", async () => {
    // §5.8 exposes only a read-only catalog to a hosted agent. The gate computed
    // the narrowed set and the coordinator dropped it, so a transport was free to
    // fall back to its own catalog — including writer tools the gate never saw.
    const seen: Array<readonly string[] | undefined> = [];
    const coordinator = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      transport: {
        spawn: async (request) => {
          seen.push(request.requestedTools);
          return report(request);
        },
      },
    });

    const result = await coordinator.run({
      role: "explore",
      agentId: "agent-scout-1",
      taskId: "task-1",
      depth: 0,
      prompt: "Inspect routing.",
      requestedTools: ["fs.read", "fs.search"],
    }, new AbortController().signal);

    expect(result.accepted).toBe(true);
    expect(seen).toEqual([["fs.read", "fs.search"]]);

    // A request that names no tools is narrowed to the allowlist, not left open.
    const defaulted = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      transport: {
        spawn: async (request) => {
          seen.push(request.requestedTools);
          return report(request);
        },
      },
    });
    await defaulted.run({
      role: "explore",
      agentId: "agent-scout-2",
      taskId: "task-1",
      depth: 0,
      prompt: "Inspect routing.",
    }, new AbortController().signal);
    expect(seen[1]).toEqual([...DEFAULT_HOSTED_SCOUT_POLICY.allowlistedTools]);
    expect(seen[1]).not.toContain("fs.edit");
  });

  test("bounds the subtree by tokens and by wall time, not just per agent", async () => {
    // §5.6 budgets the whole scout subtree. A per-agent token ceiling alone lets
    // a sequence of individually cheap scouts run without bound, and gives a
    // provider that never answers no deadline at all.
    const tokenBudget = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      policy: { ...DEFAULT_HOSTED_SCOUT_POLICY, maxAgents: 8, maxSubtreeTokens: 200 },
      transport: { spawn: async (request) => report(request) },
    });
    const first = await tokenBudget.run(scout("agent-1"), new AbortController().signal);
    expect(first.accepted).toBe(true);
    expect(tokenBudget.subtreeTokensUsed).toBe(120);
    const second = await tokenBudget.run(scout("agent-2"), new AbortController().signal);
    expect(second.accepted).toBe(true);
    expect(tokenBudget.subtreeTokensUsed).toBe(240);
    const third = await tokenBudget.run(scout("agent-3"), new AbortController().signal);
    expect(third).toMatchObject({ accepted: false });
    expect(third.reason).toContain("subtree is capped at 200 tokens");

    // A provider that accepts and never answers is cut off by the deadline.
    let clock = 0;
    const stalled = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      policy: { ...DEFAULT_HOSTED_SCOUT_POLICY, maxSubtreeWallTimeMs: 5 },
      now: () => clock,
      transport: {
        spawn: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
      fallback: { spawn: async (request) => report(request) },
    });
    const stalledResult = await stalled.run(scout("agent-stalled"), new AbortController().signal);
    expect(stalledResult).toMatchObject({ accepted: false });
    expect(stalledResult.reason).toContain("wall-time budget exhausted");

    // Once the subtree clock is past the budget, the gate refuses admission.
    clock = 10_000;
    const expired = await stalled.run(scout("agent-late"), new AbortController().signal);
    expect(expired.reason).toContain("capped at 5ms");
  });

  test("falls back once to a local read-only transport and revalidates evidence", async () => {
    const events: Array<{ kind: Parameters<HostedScoutEmitter["emit"]>[0]; payload: Record<string, unknown> }> = [];
    const coordinator = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      transport: {
        spawn: async () => {
          throw new Error("hosted beta unavailable");
        },
      },
      fallback: {
        spawn: async (request) => report(request),
      },
      emitter: {
        emit: (kind, payload) => events.push({ kind, payload }),
      },
    });

    const result = await coordinator.run({
      role: "HostedScout",
      agentId: "agent-scout-1",
      taskId: "task-1",
      depth: 0,
      prompt: "Inspect routing.",
      requestedTools: ["fs.read"],
    }, new AbortController().signal);

    expect(result.accepted).toBe(true);
    expect(result.report?.evidenceCapsule.evidenceIds).toEqual(["ev-1"]);
    expect(coordinator.agentsUsed).toBe(1);
    expect(events.map((event) => event.kind)).toEqual([
      "hosted_agent.spawned",
      "hosted_agent.fallback_local",
      "hosted_agent.completed",
    ]);
  });

  test("rejects mismatched fallback evidence instead of trusting local provenance", async () => {
    const coordinator = new HostedScoutCoordinator({
      taskEpochId: "epoch-1",
      taskId: "task-1",
      callerId: "root",
      workspaceIdentityDigest: "workspace-1",
      transport: { spawn: async () => { throw new Error("offline"); } },
      fallback: {
        spawn: async (request) => ({
          ...report(request),
          workspaceIdentityDigest: "workspace-other",
        }),
      },
    });

    const result = await coordinator.run({
      role: "HostedReviewer",
      agentId: "agent-reviewer-1",
      taskId: "task-1",
      depth: 0,
      prompt: "Review the evidence.",
      requestedTools: ["git.diff"],
    }, new AbortController().signal);
    expect(result).toMatchObject({ accepted: false, reason: "workspace_mismatch" });
  });
});
