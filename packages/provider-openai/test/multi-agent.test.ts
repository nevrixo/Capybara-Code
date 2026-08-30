import { describe, expect, test } from "bun:test";

import {
  buildHostedScoutRequest,
  validateHostedScoutRequest,
  type HostedScoutRequest,
  type ModelToolSchema,
} from "../src/index.ts";

function tool(name: string): ModelToolSchema {
  return { name, description: name, parameters: { type: "object", properties: {} }, strict: true };
}

/** A root turn's catalog: read-only tools alongside the writer ones. */
const ROOT_CATALOG: readonly ModelToolSchema[] = [
  tool("fs.read"),
  tool("fs.search"),
  tool("git.diff"),
  tool("fs.edit"),
  tool("shell.run"),
  tool("apply_patch"),
];

function scoutRequest(overrides: Partial<HostedScoutRequest> = {}): HostedScoutRequest {
  return {
    role: "explore",
    agentId: "agent-scout-1",
    callerId: "root",
    taskEpochId: "epoch-1",
    taskId: "task-1",
    workspaceIdentityDigest: "workspace-1",
    depth: 0,
    prompt: "Find where routing decides the native lane.",
    requestedTools: ["fs.read", "fs.search"],
    ...overrides,
  };
}

describe("hosted scout request construction", () => {
  test("builds a separate read-only request that carries none of the root's writer tools", () => {
    // §5.6's central invariant: the scout runs as its own read-only request, not
    // as a widened root turn. The builder is handed the whole root catalog on
    // purpose — only the admitted entries may be serialized.
    const request = scoutRequest();
    const decision = validateHostedScoutRequest(request);
    expect(decision.allowed).toBe(true);

    const built = buildHostedScoutRequest({
      requestId: "req-scout-1",
      model: "gpt-5.6",
      role: decision.role!,
      request: { ...request, requestedTools: decision.tools },
      catalog: ROOT_CATALOG,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const names = built.request.tools.map((entry) => entry.name);
    expect(names).toEqual(["fs.read", "fs.search"]);
    for (const writer of ["fs.edit", "shell.run", "apply_patch"]) {
      expect(names).not.toContain(writer);
    }
    // No hosted tool either: web_search or image_generation would be an external
    // side effect the gate never admitted.
    expect(built.request.hostedTools).toEqual([]);
    expect(built.request.store).toBe(false);
    expect(built.request.reasoning.context).toBe("current_turn");
    expect(built.request.previousResponseId).toBeUndefined();
    expect(built.request.taskEpochId).toBe("epoch-1");
    expect(built.request.callerId).toBe("root");
    // The scout is told its own prompt and nothing of the parent's history.
    expect(built.request.input).toHaveLength(2);
    expect(JSON.stringify(built.request.input)).toContain("read-only scout");
  });

  test("refuses to build a request whose catalog is not read-only", () => {
    // The gate would never produce this, so the builder is refusing a caller
    // that assembled the list itself rather than taking decision.tools.
    const forged = buildHostedScoutRequest({
      requestId: "req-scout-2",
      model: "gpt-5.6",
      role: "HostedScout",
      request: scoutRequest({ requestedTools: ["fs.read", "fs.edit"] }),
      catalog: ROOT_CATALOG,
    });
    expect(forged).toMatchObject({ ok: false });
    if (forged.ok) return;
    expect(forged.reason).toContain("not read-only");

    // An admitted tool the local catalog cannot supply is also a refusal: a
    // silently shorter catalog would look like a working scout with fewer reads.
    const incomplete = buildHostedScoutRequest({
      requestId: "req-scout-3",
      model: "gpt-5.6",
      role: "HostedScout",
      request: scoutRequest({ requestedTools: ["fs.read", "lsp.symbols"] }),
      catalog: ROOT_CATALOG,
    });
    expect(incomplete).toMatchObject({ ok: false });
    if (incomplete.ok) return;
    expect(incomplete.reason).toContain("missing admitted tool");
  });

  test("bounds the scout's output by the smaller of the policy and the request", () => {
    const built = buildHostedScoutRequest({
      requestId: "req-scout-4",
      model: "gpt-5.6",
      role: "HostedReviewer",
      request: scoutRequest({ role: "reviewer", requestedTokens: 2_048 }),
      catalog: ROOT_CATALOG,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.maxOutputTokens).toBe(2_048);
  });
});
