import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { bundledCapability, MockProvider } from "@cbc/provider-openai";
import { RuntimeRpcError, type CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function sessionRuntime(read?: (path: string) => Promise<never>) {
  return {
    workspace: "/work",
    read: read ?? (async () => ({
      path: "ignored",
      binary: false,
      checksum: "a".repeat(64),
      rendered: "",
    })),
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
  readonly provider: MockProvider;
}

function harness(sessionId: string, provider: MockProvider, read?: (path: string) => Promise<never>): Harness {
  const events: CbcEvent[] = [];
  let now = 500;
  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: sessionRuntime(read) as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "e".repeat(64),
    trust: "trusted-always",
    sessionId,
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  return { session, events, provider };
}

function resetReasons(events: readonly CbcEvent[]): readonly string[] {
  return events
    .filter((event) => event.kind === "reasoning.epoch_reset")
    .map((event) => (event.payload as { reason: string }).reason);
}

describe("epoch invalidation signals", () => {
  test("an interactive model switch resets the epoch immediately", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-model-changed", provider);
    await session.submit("Fix the parser", new AbortController().signal);
    const before = session.taskEpoch.requireCurrent().id;

    session.setModel("gpt-5.1-codex-mini");

    expect(session.taskEpoch.requireCurrent().id).not.toBe(before);
    expect(resetReasons(events)).toContain("model_changed");
    expect(session.taskEpoch.scope().continuity).toBe("current_turn");
  });

  test("the first route adopts the live capability digest without resetting the epoch", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-capability-adopt", provider);
    await session.submit("Fix the parser", new AbortController().signal);

    const epoch = session.taskEpoch.requireCurrent();
    const route = provider.requests[0]?.model ?? "gpt-5.6-terra";
    const liveDigest = bundledCapability(route)?.digest;
    expect(liveDigest).toBeDefined();
    expect(epoch.modelCapabilityDigest).toBe(liveDigest as string);
    expect(resetReasons(events)).not.toContain("capability_changed");
  });

  test("narrowing the active catalog to plan-safe tools resets the epoch", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-toolset-changed", provider);
    await session.submit("Fix the parser", new AbortController().signal);
    const before = session.taskEpoch.requireCurrent();

    const result = await session.requestInteractionMode("plan", "slash");
    expect(result.kind).toBe("applied");

    const after = session.taskEpoch.requireCurrent();
    expect(after.id).not.toBe(before.id);
    expect(after.toolsetDigest).not.toBe(before.toolsetDigest);
    expect(resetReasons(events)).toContain("toolset_changed");
  });

  test("a permission preset switch resets the epoch", async () => {
    const provider = new MockProvider({ steps: [{ text: "first" }, { text: "second" }] });
    const { session, events } = harness("epoch-policy-changed", provider);
    await session.submit("Fix the parser", new AbortController().signal);
    const before = session.taskEpoch.requireCurrent();

    session.setPermissionPreset("read");

    const after = session.taskEpoch.requireCurrent();
    expect(after.id).not.toBe(before.id);
    expect(after.policyDigest).not.toBe(before.policyDigest);
    expect(resetReasons(events)).toContain("policy_changed");
  });

  test("a plain tool failure does not reset the epoch", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "read-missing",
            name: "fs.read",
            arguments: { path: "does/not/exist.ts" },
          }],
        },
        { text: "recovered without abandoning the approach" },
      ],
    });
    const { session, events } = harness("epoch-tool-failure", provider, async () => {
      throw new Error("ENOENT: no such file");
    });

    await session.submit("Read the missing file", new AbortController().signal);

    expect(events.some((event) => event.kind === "tool.failed")).toBe(true);
    // The turn's opening goal is journaled as epoch_started. A tool that simply
    // failed is an ordinary correction, not an abandoned approach, so nothing
    // may add a hypothesis_invalidated reset on top of it.
    expect(events.filter((event) => event.kind === "reasoning.epoch_started")).toHaveLength(1);
    expect(resetReasons(events)).toEqual([]);
    expect(session.taskEpoch.requireCurrent().resetReason).toBe("goal_changed");
  });

  test("an externally reported stale read marks the epoch stale", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "stale-read",
            name: "fs.read",
            arguments: { path: "src/parser.ts" },
          }],
        },
        { text: "recovered against the new bytes" },
      ],
    });
    let attempts = 0;
    const { session, events } = harness("epoch-workspace-stale", provider, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new RuntimeRpcError({
          code: -32603,
          message: "stale read",
          data: {
            taxonomy: "PATH_CHANGED",
            retryable: true,
            path: "src/parser.ts",
            generationBefore: 0,
            generationAfter: 0,
          },
        });
      }
      return {
        path: "src/parser.ts",
        binary: false,
        checksum: "b".repeat(64),
        rendered: "<file path='src/parser.ts'>fresh</file>",
      } as never;
    });

    await session.submit("Read the parser", new AbortController().signal);

    // §5.11 row 5: the bytes moved without this session writing them, so the
    // reasoning built on the pre-change read cannot carry forward.
    const stale = events.find((event) =>
      event.kind === "reasoning.epoch_reset" &&
      (event.payload as { reason: string }).reason === "workspace_stale"
    );
    expect(stale).toBeDefined();
    expect((stale?.payload as { continuity: string }).continuity).toBe("current_turn");
  });

  test("this session's own mutation advances the workspace identity without a stale reset", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "own-mutation",
            name: "shell.run",
            arguments: { script: "touch src/parser.ts", timeoutMs: 1_000 },
          }],
        },
        { text: "mutated the parser" },
        { text: "second turn" },
      ],
    });
    let now = 8_000;
    const events: CbcEvent[] = [];
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: {
        ...sessionRuntime(),
        async issueCapability(params: Record<string, unknown>) {
          return {
            id: "cap-own", sessionId: "epoch-workspace-own",
            callId: params.callId ?? "own-mutation", actionHash: "a".repeat(64),
            workspaceId: "work", operation: "shell.run", resources: ["."],
            network: "deny" as const, expiresAtMs: Number.MAX_SAFE_INTEGER,
            singleUse: true as const,
          };
        },
        run: async () => ({
          state: "exited", exitCode: 0, display: "touch src/parser.ts", durationMs: 1,
          stdout: "", stderr: "", warnings: [], truncated: false,
          stdoutBytes: 0, stderrBytes: 0, jobId: "job-own",
        }),
        glob: async () => ({ entries: [], truncated: false }),
        gitDiff: async () => ({ files: [] }),
      } as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "e".repeat(64),
      trust: "trusted-always",
      sessionId: "epoch-workspace-own",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["shell.run"]);
    const startupIdentity = session.taskEpoch.requireCurrent().workspaceIdentityDigest;

    await session.submit("Touch the parser", new AbortController().signal);
    const afterMutation = session.taskEpoch.requireCurrent();
    expect(session.workspaceGeneration).toBeGreaterThan(0);

    // The mutation is ours, so §5.11 row 6 refreshes identity in place: the
    // reasoning that produced it still holds.
    expect(resetReasons(events)).not.toContain("workspace_stale");

    // ...and the next turn must carry the identity the mutation advanced, not
    // the constant startup digest the transition used to re-send every turn.
    await session.submit("Now update the tests", new AbortController().signal);
    expect(session.taskEpoch.requireCurrent().workspaceIdentityDigest)
      .toBe(afterMutation.workspaceIdentityDigest);
    expect(afterMutation.workspaceIdentityDigest).not.toBe(startupIdentity);
  });

  test("the independent reviewer runs in its own epoch and inherits no parent reasoning", async () => {
    const patch = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "patch-readme", name: "fs.apply_patch", arguments: { diff: patch } }] },
        { text: "Patched README.md." },
        { text: '{"summary":"looks fine","findings":[]}' },
      ],
    });
    const config = structuredClone(loadConfig({ projectTrusted: true, env: {} }).config);
    config.agent.reviewMode = "auto";
    config.agent.verification.reviewPolicy = "always";
    config.permissions.projectWrite = "auto";

    let now = 1_000;
    const events: CbcEvent[] = [];
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: {
        ...sessionRuntime(),
        beginTransaction: async () => ({ transactionId: "tx-review-epoch" }),
        patch: async () => ({ stagedPaths: ["README.md"], files: [{ path: "README.md", hunks: 1 }] }),
        commitTransaction: async () => ({
          operations: [{ path: "README.md", additions: 1, deletions: 1 }],
          totalAdditions: 1,
          totalDeletions: 1,
        }),
        rollbackTransaction: async () => undefined,
        gitDiff: async () => ({
          files: [{ path: "README.md", patch, additions: 1, deletions: 1 }],
        }),
        glob: async () => ({ entries: [], truncated: false }),
      } as never,
      config,
      workspacePath: "/work",
      workspaceIdentityDigest: "d".repeat(64),
      trust: "trusted-always",
      sessionId: "epoch-review-requested",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["fs.apply_patch"]);

    await session.submit("Update README.md", new AbortController().signal);

    // §5.13's first completion criterion: the reviewer never evaluates with the
    // author's reasoning, and §5.11 requires that boundary to be an epoch.
    expect(resetReasons(events)).toContain("review_requested");
    const reviewRequest = provider.requests.find((request) =>
      request.requestId.startsWith("review_")
    );
    expect(reviewRequest).toBeDefined();
    expect(reviewRequest?.reasoning.context).toBe("current_turn");
    expect(reviewRequest?.previousResponseId).toBeUndefined();
    // Nothing the author produced may be replayed into the review.
    expect(reviewRequest?.input).toHaveLength(1);
  });
});
