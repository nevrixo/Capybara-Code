import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import { EventSequencer, RuntimeRpcError, createEvent, type CbcEvent } from "@cbc/protocol";

import { AgentSession, MAX_READ_FRESHNESS_RECORDS, shouldAutoRoute } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("AgentSession Context P0 production loop", () => {
  test("treats a changed default model as an explicit selection", () => {
    const model = loadConfig({ projectTrusted: true, env: {} }).config.model;

    expect(shouldAutoRoute(model)).toBe(true);
    expect(shouldAutoRoute({ ...model, default: "gpt-5.6-luna" })).toBe(false);
    expect(shouldAutoRoute(model, true)).toBe(false);
    expect(shouldAutoRoute({ ...model, profile: "fast", default: "gpt-5.6-terra" })).toBe(false);
    expect(
      shouldAutoRoute({
        ...model,
        profile: "manual",
        default: "gpt-5.6-sol",
        reasoningEffort: "low",
      }),
    ).toBe(false);
  });

  test("fs.read is promoted once into L6 before the next provider sample", async () => {
    const source = "export const CONTEXT_P0_SENTINEL = 1;";
    const checksum = "a".repeat(64);
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "read-1", name: "fs.read", arguments: { path: "src/a.ts" } }] },
        { text: "Done." },
      ],
    });
    const events: CbcEvent[] = [];
    let now = 1_000;
    const runtime = {
      workspace: "/work",
      read: async () => ({
        path: "src/a.ts",
        binary: false,
        checksum,
        excerpt: {
          path: "src/a.ts",
          checksum,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          text: source,
          partial: false,
          omittedBefore: 0,
          omittedAfter: 0,
        },
        rendered: `<file path="src/a.ts">${source}</file>`,
      }),
      appendEvents: async (params: { events?: unknown[] }) => ({
        appended: params.events?.length ?? 0,
        lastSequence: params.events?.length ?? 0,
      }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    const config = loadConfig({ projectTrusted: true, env: {} }).config;
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config,
      workspacePath: "/work",
      workspaceIdentityDigest: "b".repeat(64),
      trust: "trusted-always",
      sessionId: "session-context-p0",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["fs.read"]);

    await session.submit("Read src/a.ts", new AbortController().signal);

    expect(provider.requests).toHaveLength(2);
    const first = JSON.stringify(provider.requests[0]);
    const second = JSON.stringify(provider.requests[1]);
    expect(first).not.toContain(source);
    expect(occurrenceCount(second, source)).toBe(1);
    expect(second).toContain("promoted to the repository context");

    const packs = events.filter((event) => event.kind === "context.pack_compiled");
    expect(packs).toHaveLength(2);
    const selected = events.filter((event) => event.kind === "context.evidence_selected");
    expect(selected).toHaveLength(2);
    const lastPack = packs.at(-1)?.payload as {
      evidenceIds?: string[]; excerptIds?: string[]; compilerPackId?: string; compilerManifestDigest?: string;
    };
    const lastSelected = selected.at(-1)?.payload as { evidenceIds?: string[]; excerptIds?: string[] };
    expect(lastSelected.evidenceIds).toEqual(lastPack.evidenceIds);
    expect(lastPack.compilerPackId).toStartWith("context-pack-");
    expect(lastPack.compilerManifestDigest).toHaveLength(64);
    expect(lastSelected.excerptIds).toEqual(lastPack.excerptIds);

    const ingested = events.find((event) => event.kind === "context.observation_ingested");
    expect(ingested?.agentId).toBe("root");
    expect((ingested?.payload as { cacheHit?: boolean }).cacheHit).toBe(false);

    const manifestBeforeInspect = structuredClone(session.context.lastMaterialization);
    const inspection = session.inspectContext();
    const lastPackPayload = packs.at(-1)?.payload as {
      packId?: string;
      totalInputTokens?: number;
    };
    expect(inspection.compiledPackId).toBe(lastPackPayload.packId);
    expect(inspection.compiledInputTokens).toBe(lastPackPayload.totalInputTokens);
    expect(inspection.compilerPack?.id).toBe(lastPack.compilerPackId);
    expect(inspection.layers.reduce((sum, layer) => sum + layer.estimatedTokens, 0)).toBe(
      inspection.compiledInputTokens ?? -1,
    );
    const exactSnapshot = structuredClone(inspection);
    session.registry.activate(["fs.search"]);
    expect(session.inspectContext()).toEqual(exactSnapshot);
    expect(session.context.lastMaterialization).toEqual(manifestBeforeInspect);
  });
  test("an accepted child handoff enters the parent prompt with child provenance", async () => {
    const source = "export const CHILD_CONTEXT_P0_SENTINEL = 2;";
    const checksum = "c".repeat(64);
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "spawn-1",
            name: "task.spawn",
            arguments: {
              role: "explore",
              name: "reader",
              title: "Read one source file",
              goal: "Read src/child.ts and report its exported constant.",
              constraints: ["Read only; do not modify files."],
              expectedOutput: ["Report the exported constant."],
              context: [],
              allowedPaths: [],
              forbiddenPaths: [],
              verification: [],
              modelProfile: "auto",
              dependencies: [],
            },
          }],
        },
        { toolCalls: [{ callId: "child-read", name: "fs.read", arguments: { path: "src/child.ts" } }] },
        { text: "Child complete." },
        { text: "Root complete." },
      ],
    });
    const events: CbcEvent[] = [];
    let now = 2_000;
    const runtime = {
      workspace: "/work",
      read: async () => ({
        path: "src/child.ts",
        binary: false,
        checksum,
        excerpt: {
          path: "src/child.ts",
          checksum,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          text: source,
          partial: false,
          omittedBefore: 0,
          omittedAfter: 0,
        },
        rendered: `<file path="src/child.ts">${source}</file>`,
      }),
      appendEvents: async (params: { events?: unknown[] }) => ({
        appended: params.events?.length ?? 0,
        lastSequence: params.events?.length ?? 0,
      }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    const config = loadConfig({ projectTrusted: true, env: {} }).config;
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config,
      workspacePath: "/work",
      workspaceIdentityDigest: "d".repeat(64),
      trust: "trusted-always",
      sessionId: "session-child-context-p0",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["task.spawn"]);

    await session.submit("Delegate reading src/child.ts", new AbortController().signal);

    expect(provider.requests).toHaveLength(4);
    // Capsule mode keeps the child's own read raw in its private history rather
    // than replacing it with a parent-L6 locator it cannot dereference.
    expect(occurrenceCount(JSON.stringify(provider.requests[2]), source)).toBe(1);
    // The root's follow-up request is rebuilt after the child finishes and sees
    // the shared parent ContextEngine working set.
    expect(occurrenceCount(JSON.stringify(provider.requests[3]), source)).toBe(1);
    const childIngest = events.find(
      (event) => event.kind === "context.observation_ingested" && event.agentId !== "root",
    );
    expect(childIngest).toBeDefined();
    expect(childIngest?.agentId).toMatch(/^agent_/);
    const payload = childIngest?.payload as { evidenceIds?: string[] };
    expect(payload.evidenceIds?.length).toBeGreaterThan(0);
    const parentPack = [...events]
      .reverse()
      .find((event) => event.kind === "context.pack_compiled" && event.agentId === "root");
    expect((parentPack?.payload as { evidenceIds?: string[] }).evidenceIds).toEqual(
      expect.arrayContaining(payload.evidenceIds ?? []),
    );
    expect(events.some((event) => event.kind === "context.handoff_created" && event.agentId !== "root")).toBe(true);
    expect(events.some((event) => event.kind === "context.handoff_accepted" && event.agentId === "root")).toBe(true);
    expect(events.some((event) => event.kind === "context.handoff_consumed" && event.agentId === "root")).toBe(true);
  });

  test("a child capsule excludes parent exact context outside its task path boundary", async () => {
    const sentinel = "PARENT_EXACT_OUTSIDE_CHILD_BOUNDARY_SENTINEL";
    const checksum = "9".repeat(64);
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "read-private", name: "fs.read", arguments: { path: "src/private.ts" } }] },
        {
          toolCalls: [{
            callId: "spawn-scoped",
            name: "task.spawn",
            arguments: {
              role: "executor",
              name: "scoped-worker",
              title: "Implement one scoped source change",
              goal: "Inspect the delegated scope and report how the allowed source change should be implemented.",
              context: ["The parent has unrelated exact evidence that must not be inherited."],
              constraints: ["Do not access or change files outside the granted path."],
              expectedOutput: ["Return a concise scoped implementation report."],
              allowedPaths: ["src/allowed.ts"],
              forbiddenPaths: [],
              verification: ["Report whether focused verification is needed."],
              modelProfile: "auto",
              dependencies: [],
            },
          }],
        },
        { text: "Scoped child complete." },
        { text: "Root complete." },
      ],
    });
    let now = 2_500;
    const runtime = {
      workspace: "/work",
      read: async () => ({
        path: "src/private.ts",
        binary: false,
        checksum,
        excerpt: {
          path: "src/private.ts",
          checksum,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          text: sentinel,
          partial: false,
          omittedBefore: 0,
          omittedAfter: 0,
        },
        rendered: `<file path="src/private.ts">${sentinel}</file>`,
      }),
      appendEvents: async (params: { events?: unknown[] }) => ({
        appended: params.events?.length ?? 0,
        lastSequence: params.events?.length ?? 0,
      }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      // This test isolates context-capsule projection. Keep the explicit
      // compatibility writer mode so worktree preflight is covered separately.
      config: loadConfig({
        projectTrusted: true,
        env: {},
        userToml: "[subagents]\nwriter_policy = \"single-lease\"\n",
      }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "8".repeat(64),
      trust: "trusted-always",
      sessionId: "session-child-capsule-boundary",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
    });
    session.registry.activate(["fs.read", "task.spawn"]);

    await session.submit("Read src/private.ts, then delegate only src/allowed.ts", new AbortController().signal);

    expect(provider.requests).toHaveLength(4);
    const parentWithExactContext = JSON.stringify(provider.requests[1]?.input);
    const childRequest = JSON.stringify(provider.requests[2]?.input);
    expect(parentWithExactContext).toContain(sentinel);
    expect(childRequest).not.toContain(sentinel);
    expect(childRequest).not.toContain("src/private.ts");
    expect(childRequest).toContain("Scoped task context capsule");
    expect(childRequest).toContain("context-capsule-");
    expect(childRequest).toContain("allowedPaths");
    expect(childRequest).toContain("src/allowed.ts");
    expect(childRequest).toContain("inputTokens");
    expect(childRequest).toContain("toolCalls");
  });

  test("an immediate reread observes a changed checksum and excludes the old excerpt", async () => {
    const oldSource = "export const VERSION = 'old';";
    const newSource = "export const VERSION = 'new';";
    const checksums = ["1".repeat(64), "2".repeat(64)];
    let reads = 0;
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "read-old", name: "fs.read", arguments: { path: "src/version.ts" } }] },
        { toolCalls: [{ callId: "read-new", name: "fs.read", arguments: { path: "src/version.ts" } }] },
        { text: "Done." },
      ],
    });
    const events: CbcEvent[] = [];
    let now = 3_000;
    const runtime = {
      workspace: "/work",
      read: async () => {
        const index = Math.min(reads++, 1);
        const text = index === 0 ? oldSource : newSource;
        const checksum = checksums[index]!;
        return {
          path: "src/version.ts",
          binary: false,
          checksum,
          excerpt: {
            path: "src/version.ts",
            checksum,
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            text,
            partial: false,
            omittedBefore: 0,
            omittedAfter: 0,
          },
          rendered: `<file path="src/version.ts">${text}</file>`,
        };
      },
      appendEvents: async (params: { events?: unknown[] }) => ({
        appended: params.events?.length ?? 0,
        lastSequence: params.events?.length ?? 0,
      }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    const config = loadConfig({ projectTrusted: true, env: {} }).config;
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config,
      workspacePath: "/work",
      workspaceIdentityDigest: "e".repeat(64),
      trust: "trusted-always",
      sessionId: "session-stale-context-p0",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["fs.read"]);

    await session.submit("Inspect src/version.ts twice", new AbortController().signal);

    expect(reads).toBe(2);
    const middle = JSON.stringify(provider.requests[1]);
    const last = JSON.stringify(provider.requests[2]);
    expect(middle).toContain(oldSource);
    expect(last).toContain(newSource);
    expect(last).not.toContain(oldSource);
    const stale = events.find(
      (event) => event.kind === "context.evidence_rejected" &&
        String((event.payload as { reason?: string }).reason).includes("stale"),
    );
    expect(stale).toBeDefined();
  });


  test("tool discovery recomputes cache identity and planning for the exact second sample", async () => {
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "discover-1", name: "tool.discover", arguments: { query: "search files by text", limit: 8 } }] },
        { text: "Done." },
      ],
    });
    const events: CbcEvent[] = [];
    let now = 4_000;
    const instruction = `Long stable instruction. ${"maintainer convention ".repeat(700)}`;
    const runtime = {
      workspace: "/work",
      read: async (path: string) => {
        if (path !== "AGENTS.md") throw new Error("not found");
        return { binary: false, excerpt: { text: instruction } };
      },
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    const config = loadConfig({
      projectTrusted: true,
      env: {},
      userToml: "[model.cache]\nmode = \"always\"\n",
    }).config;
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config,
      workspacePath: "/work",
      workspaceIdentityDigest: "f".repeat(64),
      trust: "trusted-always",
      sessionId: "session-cache-replan-p0",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    await session.context.loadInstructions({ trusted: true });
    await session.submit("Discover a search tool", new AbortController().signal);

    expect(provider.requests).toHaveLength(2);
    const [first, second] = provider.requests;
    expect(first?.cache?.key).toBeDefined();
    expect(second?.cache?.key).toBeDefined();
    expect(second?.cache?.key).not.toBe(first?.cache?.key);
    expect(second?.tools.length).toBeGreaterThan(first?.tools.length ?? 0);
    const plans = events.filter((event) => event.kind === "cache.plan_created");
    const packs = events.filter((event) => event.kind === "context.pack_compiled");
    expect(plans).toHaveLength(2);
    expect(packs).toHaveLength(2);
    const contextPlans = events.filter((event) => event.kind === "context.plan_created");
    expect(contextPlans).toHaveLength(2);
    for (let index = 0; index < 2; index += 1) {
      expect((contextPlans[index]?.payload as { packId?: string }).packId).toBe(
        (packs[index]?.payload as { packId?: string }).packId,
      );
      expect((contextPlans[index]?.payload as { requestedTokens?: number }).requestedTokens).toBe(
        (packs[index]?.payload as { totalInputTokens?: number }).totalInputTokens,
      );
      expect((plans[index]?.payload as { packId?: string }).packId).toBe(
        (packs[index]?.payload as { packId?: string }).packId,
      );
      expect((plans[index]?.payload as { stablePrefixTokens?: number }).stablePrefixTokens).toBe(
        (packs[index]?.payload as { stablePrefixTokens?: number }).stablePrefixTokens,
      );
    }
  });


  test("shell deletion of AGENTS.md cannot reach the next sample through stale instructions or cache", async () => {
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "shell-agents", name: "shell.run", arguments: { script: "rm AGENTS.md", timeoutMs: 1_000 } }] },
        { text: "Instructions refreshed." },
      ],
    });
    const oldInstruction = `OLD_AGENT_INSTRUCTION_SENTINEL ${"old convention ".repeat(700)}`;
    let instructionPresent = true;
    let now = 8_000;
    const runtime = {
      workspace: "/work",
      read: async (path: string) => {
        if (path === "AGENTS.md" && instructionPresent) {
          return { binary: false, excerpt: { text: oldInstruction } };
        }
        throw new Error("not found");
      },
      async issueCapability(params: Record<string, unknown>) {
        return {
          id: "cap-shell", sessionId: "session-shell-agents", callId: params.callId ?? "shell-agents",
          actionHash: "a".repeat(64), workspaceId: "work", operation: "shell.run",
          resources: ["."], network: "deny" as const, expiresAtMs: Number.MAX_SAFE_INTEGER, singleUse: true as const,
        };
      },
      run: async () => {
        instructionPresent = false;
        return {
          state: "exited", exitCode: 0, display: "rm AGENTS.md", durationMs: 1,
          stdout: "", stderr: "", warnings: [], truncated: false, stdoutBytes: 0, stderrBytes: 0, jobId: "job-shell",
        };
      },
      glob: async () => ({ entries: [], truncated: false }),
      gitDiff: async () => ({ files: [] }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const config = loadConfig({
      projectTrusted: true, env: {}, userToml: "[model.cache]\nmode = \"always\"\n",
    }).config;
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never, config,
      workspacePath: "/work", workspaceIdentityDigest: "a".repeat(64), trust: "trusted-always",
      sessionId: "session-shell-agents", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["shell.run"]);
    await session.context.loadInstructions({ trusted: true });
    await session.submit("Delete the obsolete instruction file", new AbortController().signal);

    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[0]?.input)).toContain("OLD_AGENT_INSTRUCTION_SENTINEL");
    expect(JSON.stringify(provider.requests[1]?.input)).not.toContain("OLD_AGENT_INSTRUCTION_SENTINEL");
    expect(provider.requests[1]?.cache?.key).not.toBe(provider.requests[0]?.cache?.key);
    expect(session.context.instructions).toHaveLength(0);
  });


  test("model-capacity pressure keeps an unsampled 401-line raw read through the next sample", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{ callId: "raw-401", name: "fs.read", arguments: { path: "src/large.ts" } }],
          usage: { inputTokens: 50_000 },
        },
        { text: "Saw the tail." },
      ],
    });
    const lines = Array.from({ length: 401 }, (_, index) =>
      index === 400 ? `RAW_COMPACTION_LINE_401_${"z".repeat(400)}` : `RAW_LINE_${index + 1}_${"x".repeat(400)}`
    );
    const source = lines.join("\n");
    let now = 12_000;
    const runtime = {
      workspace: "/work",
      read: async () => ({
        path: "src/large.ts", binary: false, checksum: "c".repeat(64), bytes: source.length,
        totalLines: 401, startLine: 1, endLine: 401,
        excerpt: { path: "src/large.ts", checksum: "c".repeat(64), totalLines: 401, startLine: 1, endLine: 401, text: source },
        rendered: source,
      }),
      glob: async () => ({ entries: [], truncated: false }), gitDiff: async () => ({ files: [] }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "c".repeat(64), trust: "trusted-always",
      sessionId: "session-raw-compaction", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    await session.submit("Read the whole large file", new AbortController().signal);
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1]?.input)).toContain("RAW_COMPACTION_LINE_401");
    expect(session.compactState).toBeUndefined();
  });


  test("evidence selection telemetry preserves the materialization's omitted count", async () => {
    const provider = new MockProvider({ steps: [{ text: "Done." }] });
    const events: CbcEvent[] = [];
    let now = 16_000;
    const runtime = {
      workspace: "/work",
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "e".repeat(64), trust: "trusted-always",
      sessionId: "session-evidence-omitted", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    for (let index = 0; index < 90; index += 1) {
      session.context.recordEvidence({
        kind: "tool_observation", locator: `item-${index}`, digest: `${index}`.padStart(64, "0"),
        observedAt: new Date(index * 1_000).toISOString(), summary: `fact ${index}`,
      });
    }
    await session.submit("Use the evidence", new AbortController().signal);
    const selected = events.findLast((event) => event.kind === "context.evidence_selected");
    expect((selected?.payload as { omitted?: number }).omitted).toBeGreaterThan(0);
    expect((selected?.payload as { omitted?: number }).omitted).toBe(session.context.lastMaterialization.omitted);
  });


  test("mixed sensitive and promoted read_many content appears exactly once", async () => {
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "mixed-promoted", name: "fs.read_many", arguments: { paths: ["src/secret.ts", "src/safe.ts"] } }] },
        { text: "Done." },
      ],
    });
    const secret = "MIXED_PROMOTED_SECRET";
    const sentinel = "MIXED_SAFE_EXACT_SENTINEL";
    let now = 20_000;
    const file = (path: string, text: string, checksum: string) => ({
      path, binary: false, checksum, bytes: text.length, totalLines: 1, startLine: 1, endLine: 1,
      excerpt: { path, checksum, totalLines: 1, startLine: 1, endLine: 1, text }, rendered: text,
    });
    const runtime = {
      workspace: "/work",
      readMany: async () => ({ files: [file(".env", secret, "d".repeat(64)), file("src/safe.ts", sentinel, "e".repeat(64))], errors: [] }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "b".repeat(64), trust: "trusted-always",
      sessionId: "session-mixed-promoted", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["fs.read_many"]);
    await session.submit("Read both files", new AbortController().signal);
    const second = JSON.stringify(provider.requests[1]?.input);
    expect(second).not.toContain(secret);
    expect(occurrenceCount(second, sentinel)).toBe(1);
  });

  test("a naturally exited background job is reconciled before the next pack", async () => {
    const provider = new MockProvider({
      steps: [
        { toolCalls: [{ callId: "job-1", name: "process.start", arguments: {
          program: "echo", args: ["done"], cwd: ".", timeoutMs: 10_000,
        } }] },
        { text: "Job complete." },
      ],
    });
    let now = 9_000;
    let requestsAtStatusResolution = -1;
    const runtime = {
      workspace: "/work",
      startJob: async () => ({ jobId: "job-natural", display: "echo done" }),
      jobStatus: async (jobId?: string) => {
        if (jobId === undefined) return { jobs: ["job-natural"], activeCount: 1 };
        await new Promise((resolve) => setTimeout(resolve, 5));
        requestsAtStatusResolution = provider.requests.length;
        return { jobId, state: "exited", elapsedMs: 5 };
      },
      glob: async () => ({ entries: [{ path: "src/after-job.ts", bytes: 12, binary: false }] }),
      gitDiff: async () => ({ files: [] }),
      read: async () => { throw new Error("not found"); },
      appendEvents: async (params: { events?: unknown[] }) => ({
        appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0,
      }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "a".repeat(64),
      trust: "trusted-always", sessionId: "natural-job", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["process.start"]);
    await session.submit("Start and observe a short background job", new AbortController().signal);
    expect(provider.requests).toHaveLength(2);
    expect(requestsAtStatusResolution).toBe(1);
    expect(session.context.repositoryMapDirty).toBe(false);
  });

  test("a later exact activation rewrites only its matching raw historical range", async () => {
    const lines = Array.from({ length: 500 }, (_, index) =>
      index === 0 || index === 2 ? "REPEATED_RANGE_SENTINEL" : `line-${index + 1}`);
    const fullText = lines.join("\n");
    const fullRendered = `<file path="src/repeat.ts">\n${lines.map((line, index) =>
      `${String(index + 1).padStart(6, " ")} | ${line}`).join("\n")}\n</file>`;
    const checksum = "7".repeat(64);
    let reads = 0;
    const provider = new MockProvider({ steps: [
      { toolCalls: [{ callId: "full", name: "fs.read", arguments: { path: "src/repeat.ts" } }] },
      { toolCalls: [{ callId: "line-3", name: "fs.read", arguments: { path: "src/repeat.ts", startLine: 3, maxLines: 1 } }] },
      { text: "Done." },
    ] });
    const runtime = {
      workspace: "/work",
      read: async () => {
        reads += 1;
        return reads === 1 ? {
          path: "src/repeat.ts", binary: false, checksum, totalLines: 500,
          excerpt: { path: "src/repeat.ts", checksum, startLine: 1, endLine: 500, totalLines: 500, text: fullText },
          rendered: fullRendered,
        } : {
          path: "src/repeat.ts", binary: false, checksum, totalLines: 500,
          excerpt: { path: "src/repeat.ts", checksum, startLine: 3, endLine: 3, totalLines: 500, text: "REPEATED_RANGE_SENTINEL" },
          rendered: `<file path="src/repeat.ts">\n     3 | REPEATED_RANGE_SENTINEL\n</file>`,
        };
      },
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    let now = 10_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "8".repeat(64), trust: "trusted-always",
      sessionId: "later-exact", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["fs.read"]);
    await session.submit("Read the full file, then line 3", new AbortController().signal);
    const third = JSON.stringify(provider.requests[2]?.input);
    expect(occurrenceCount(third, "REPEATED_RANGE_SENTINEL")).toBe(2);
    expect(third).toContain("exact content virtualized as excerpt-");
    expect(third).toContain("     1 | REPEATED_RANGE_SENTINEL");
  });

  test("parallel PATH_CHANGED recoveries share one dirty repository refresh", async () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: paths.map((path, index) => ({
            callId: `stale-${index}`,
            name: "fs.read",
            arguments: { path },
          })),
        },
        { text: "Recovered." },
      ],
    });
    let session!: AgentSession;
    const readAttempts = new Map<string, number>();
    let activeFullScans = 0;
    let maxConcurrentFullScans = 0;
    let fullScans = 0;
    const runtime = {
      workspace: "/work",
      read: async (path: string) => {
        const attempt = (readAttempts.get(path) ?? 0) + 1;
        readAttempts.set(path, attempt);
        if (attempt === 1) {
          session.context.invalidateWorkspace("test concurrent stale reads");
          throw new RuntimeRpcError({
            code: -32603,
            message: "stale read",
            data: {
              taxonomy: "PATH_CHANGED",
              retryable: true,
              path,
              generationBefore: 0,
              generationAfter: 0,
            },
          });
        }
        const text = `fresh:${path}`;
        return {
          path,
          binary: false,
          checksum: path.endsWith("a.ts") ? "a".repeat(64) : "b".repeat(64),
          totalLines: 1,
          excerpt: { path, startLine: 1, endLine: 1, totalLines: 1, text },
          rendered: `<file path="${path}">${text}</file>`,
        };
      },
      glob: async (pattern: string) => {
        if (pattern === "**/*") {
          fullScans += 1;
          activeFullScans += 1;
          maxConcurrentFullScans = Math.max(maxConcurrentFullScans, activeFullScans);
          await new Promise<void>((resolve) => setTimeout(resolve, 15));
          activeFullScans -= 1;
          return { entries: paths.map((path) => ({ path, bytes: 1, binary: false })) };
        }
        return { entries: [{ path: pattern, bytes: 1, binary: false }] };
      },
      gitDiff: async () => ({ files: [] }),
      appendEvents: async (params: { events?: unknown[] }) => ({
        appended: params.events?.length ?? 0,
        lastSequence: params.events?.length ?? 0,
      }),
      openSession: async () => ({ ok: true }),
      snapshotSession: async () => ({ ok: true }),
      loadSession: async () => ({ events: [] }),
    };
    let now = 10_500;
    session = new AgentSession({
      host: { now: () => ++now } as never,
      runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "9".repeat(64),
      trust: "trusted-always",
      sessionId: "parallel-stale-refresh",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
    });
    session.registry.activate(["fs.read"]);
    await session.submit("Read both files after a concurrent change", new AbortController().signal);

    expect(fullScans).toBeGreaterThanOrEqual(1);
    expect(maxConcurrentFullScans).toBe(1);
    expect(session.context.repositoryMapDirty).toBe(false);
    expect(JSON.stringify(provider.requests[1]?.input)).not.toContain("did not become quiescent");
  });

  test("a workspace mutation removes prior raw read bytes from the next provider view", async () => {
    const lines = Array.from({ length: 500 }, (_, index) =>
      index === 499 ? "STALE_RAW_AFTER_MUTATION_SENTINEL" : `old-${index + 1}`);
    const text = lines.join("\n");
    const provider = new MockProvider({ steps: [
      { toolCalls: [{ callId: "raw-old", name: "fs.read", arguments: { path: "src/old.ts" } }] },
      { toolCalls: [{ callId: "mutate", name: "shell.run", arguments: { script: "touch src/old.ts", timeoutMs: 1_000 } }] },
      { text: "Done." },
    ] });
    const runtime = {
      workspace: "/work",
      read: async () => ({
        path: "src/old.ts", binary: false, checksum: "1".repeat(64), totalLines: 500,
        excerpt: { path: "src/old.ts", checksum: "1".repeat(64), startLine: 1, endLine: 500, totalLines: 500, text },
        rendered: `<file path="src/old.ts">\n${lines.map((line, index) => `${index + 1} | ${line}`).join("\n")}\n</file>`,
      }),
      run: async () => ({ state: "exited", exitCode: 0, display: "touch", durationMs: 1,
        stdout: "", stderr: "", warnings: [], truncated: false, stdoutBytes: 0, stderrBytes: 0, jobId: "mutate-job" }),
      glob: async () => ({ entries: [{ path: "src/old.ts", bytes: 1, binary: false }] }),
      gitDiff: async () => ({ files: [{ path: "src/old.ts" }] }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    let now = 11_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "2".repeat(64), trust: "trusted-always",
      sessionId: "stale-raw-mutation", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["fs.read", "shell.run"]);
    await session.submit("Read, mutate, then reassess", new AbortController().signal);
    expect(JSON.stringify(provider.requests[1]?.input)).toContain("STALE_RAW_AFTER_MUTATION_SENTINEL");
    expect(JSON.stringify(provider.requests[2]?.input)).not.toContain("STALE_RAW_AFTER_MUTATION_SENTINEL");
    expect(JSON.stringify(provider.requests[2]?.input)).toContain("PATH_CHANGED");
  });

  test("five moderate current-turn outputs are artifactized into a smaller next pack", async () => {
    const large = `OUTPUT_HEAD_${"x".repeat(30_000)}_OUTPUT_TAIL`;
    const calls = (indexes: number[]) => indexes.map((index) => ({
      callId: `run-${index}`, name: "process.run",
      arguments: { program: "echo", args: [String(index)], cwd: ".", timeoutMs: 1_000 },
    }));
    const provider = new MockProvider({ steps: [
      { toolCalls: calls([0, 1, 2]) },
      { toolCalls: calls([3, 4]) },
      { text: "Done." },
    ] });
    const events: CbcEvent[] = [];
    let artifact = 0;
    const runtime = {
      workspace: "/work",
      run: async () => ({ state: "exited", exitCode: 0, display: "echo", durationMs: 1,
        stdout: large, stderr: "", warnings: [], truncated: false,
        stdoutBytes: large.length, stderrBytes: 0, jobId: "run-job" }),
      createArtifact: async (params: Record<string, unknown>) => {
        artifact += 1;
        return { artifact: { id: `artifact-${artifact}`, digest: String(artifact).repeat(64).slice(0, 64),
          bytes: String(params.content).length, mediaType: "text/plain", redaction: "raw",
          retentionClass: "session" } };
      },
      glob: async () => ({ entries: [] }), gitDiff: async () => ({ files: [] }),
      read: async () => { throw new Error("not found"); },
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    let now = 12_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "3".repeat(64), trust: "trusted-always",
      sessionId: "multi-output-compaction", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["process.run"]);
    await session.submit("Run five verbose commands", new AbortController().signal);
    expect(artifact).toBe(5);
    expect(events.filter((event) => event.kind === "session.compacted").length).toBeLessThanOrEqual(1);
    const second = JSON.stringify(provider.requests[2]?.input);
    expect(second).toContain("use artifact.read");
    expect(second.length).toBeLessThan(60_000);
    expect(occurrenceCount(second, "OUTPUT_HEAD_")).toBe(5);
    expect(second).toContain("OUTPUT_TAIL");
    expect(session.inspectContext().excludedLargeOutputs.filter((entry) => entry.artifactId !== undefined)).toHaveLength(5);
  });

  test("hydrated read bodies and locators fail closed until reread", async () => {
    const provider = new MockProvider({ steps: [{ text: "Resumed safely." }] });
    const runtime = {
      workspace: "/work", jobStatus: async () => ({ jobs: [], activeCount: 0 }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    let now = 13_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "4".repeat(64), trust: "trusted-always",
      sessionId: "resume-stale-read", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    const sequencer = new EventSequencer();
    const eventOptions = { sessionId: "resume-stale-read", timestamp: "2026-08-09T00:00:00Z" };
    session.hydrate([
      createEvent(sequencer, "user.message", { text: "Read src/old.ts" }, eventOptions),
      createEvent(sequencer, "tool.started", {
        callId: "hydrated-read", toolId: "fs.read", arguments: { path: "src/old.ts" },
      }, eventOptions),
      createEvent(sequencer, "tool.completed", {
        callId: "hydrated-read", summary: "HYDRATED_STALE_READ_SENTINEL promoted to repository context",
      }, eventOptions),
    ]);
    await session.submit("Continue after resume", new AbortController().signal);
    const request = JSON.stringify(provider.requests[0]?.input);
    expect(request).not.toContain("HYDRATED_STALE_READ_SENTINEL");
    expect(request).toContain("PATH_CHANGED");
  });

  test("a shell-created nested AGENTS.md enters the immediate next pack", async () => {
    const instruction = "NEW_NESTED_AGENT_INSTRUCTION_SENTINEL";
    let created = false;
    const provider = new MockProvider({ steps: [
      { toolCalls: [{ callId: "create-nested", name: "shell.run", arguments: {
        script: "mkdir -p src/new && printf rules > src/new/AGENTS.md", timeoutMs: 1_000,
      } }] },
      { text: "Nested instructions loaded." },
    ] });
    const runtime = {
      workspace: "/work",
      run: async () => {
        created = true;
        return { state: "exited", exitCode: 0, display: "create nested instructions", durationMs: 1,
          stdout: "", stderr: "", warnings: [], truncated: false, stdoutBytes: 0, stderrBytes: 0, jobId: "nested-job" };
      },
      glob: async () => ({ entries: created ? [
        { path: "src/new/AGENTS.md", bytes: instruction.length, binary: false },
        { path: "src/new/file.ts", bytes: 10, binary: false },
      ] : [] }),
      gitDiff: async () => ({ files: created ? [{ path: "src/new/AGENTS.md" }] : [] }),
      read: async (path: string) => {
        if (created && path === "src/new/AGENTS.md") return { binary: false, excerpt: { text: instruction } };
        throw new Error("not found");
      },
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    let now = 14_000;
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "5".repeat(64), trust: "trusted-always",
      sessionId: "nested-instructions", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["shell.run"]);
    await session.context.loadInstructions({ trusted: true });
    await session.submit("Create nested project instructions", new AbortController().signal);
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(instruction);
    expect(JSON.stringify(provider.requests[1]?.input)).toContain(instruction);
    expect(session.context.instructions.some((entry) => entry.path === "src/new/AGENTS.md")).toBe(true);
  });

  test("verification classes survive other checks but become partial after a mutation until rerun", async () => {
    const provider = new MockProvider({ steps: [
      { toolCalls: [{ callId: "test-old", name: "process.run", arguments: { program: "bun", args: ["test"], cwd: ".", timeoutMs: 1_000 } }] },
      { toolCalls: [{ callId: "types-old", name: "process.run", arguments: { program: "bun", args: ["run", "typecheck"], cwd: ".", timeoutMs: 1_000 } }] },
      { toolCalls: [{ callId: "mutate", name: "shell.run", arguments: { script: "touch changed.ts", timeoutMs: 1_000 } }] },
      { toolCalls: [{ callId: "test-new", name: "process.run", arguments: { program: "bun", args: ["test"], cwd: ".", timeoutMs: 1_000 } }] },
      { text: "Implemented and retested." },
    ] });
    let now = 15_000;
    const runtime = {
      workspace: "/work",
      run: async (params: { program?: string; script?: string }) => ({
        state: "exited", exitCode: 0, display: params.script ?? `${params.program ?? "bun"} test`, durationMs: 1,
        stdout: "ok", stderr: "", warnings: [], truncated: false, stdoutBytes: 2, stderrBytes: 0, jobId: `verify-${++now}`,
      }),
      glob: async () => ({ entries: [{ path: "changed.ts", bytes: 0, binary: false }] }),
      gitDiff: async () => ({ files: [{ path: "changed.ts" }] }),
      read: async () => { throw new Error("not found"); },
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({
      host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work", workspaceIdentityDigest: "6".repeat(64), trust: "trusted-always",
      sessionId: "verification-epochs", provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now,
    });
    session.registry.activate(["process.run", "shell.run"]);
    const result = await session.submit("Make a change and verify it", new AbortController().signal);
    expect(result.report.status).toBe("partial");
    expect(result.report.risks.join(" ")).toContain("1 stale evidence");
  });

  test("rerunning a stale verification class after mutation restores completed status", async () => {
    const provider = new MockProvider({ steps: [
      { toolCalls: [{ callId: "test-before", name: "process.run", arguments: { program: "bun", args: ["test"], cwd: ".", timeoutMs: 1_000 } }] },
      { toolCalls: [{ callId: "change", name: "shell.run", arguments: { script: "touch fresh.ts", timeoutMs: 1_000 } }] },
      { toolCalls: [{ callId: "test-after", name: "process.run", arguments: { program: "bun", args: ["test"], cwd: ".", timeoutMs: 1_000 } }] },
      { text: "Changed and freshly verified." },
    ] });
    let now = 16_000;
    const runtime = {
      workspace: "/work",
      run: async (params: { program?: string; script?: string }) => ({ state: "exited", exitCode: 0,
        display: params.script ?? "bun test", durationMs: 1, stdout: "ok", stderr: "", warnings: [],
        truncated: false, stdoutBytes: 2, stderrBytes: 0, jobId: `fresh-${++now}` }),
      glob: async () => ({ entries: [{ path: "fresh.ts", bytes: 0, binary: false }] }),
      gitDiff: async () => ({ files: [{ path: "fresh.ts" }] }),
      read: async () => { throw new Error("not found"); },
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({ host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config, workspacePath: "/work",
      workspaceIdentityDigest: "7".repeat(64), trust: "trusted-always", sessionId: "fresh-verification",
      provider, approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now });
    session.registry.activate(["process.run", "shell.run"]);
    const result = await session.submit("Change and verify", new AbortController().signal);
    expect(result.report.status).toBe("completed");
    expect(result.report.risks.join(" ")).not.toContain("stale evidence");
  });

  test("read provenance remains bounded even when prompt compaction never runs", async () => {
    const checksum = "8".repeat(64);
    let now = 17_000;
    const runtime = {
      workspace: "/work",
      read: async () => ({ path: "src/bounded.ts", binary: false, checksum,
        excerpt: { path: "src/bounded.ts", checksum, startLine: 1, endLine: 1, totalLines: 1,
          text: "export const bounded = true;", partial: false, omittedBefore: 0, omittedAfter: 0 },
        rendered: "export const bounded = true;" }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const session = new AgentSession({ host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config, workspacePath: "/work",
      workspaceIdentityDigest: "8".repeat(64), trust: "trusted-always", sessionId: "bounded-provenance",
      provider: new MockProvider({ steps: [] }), approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now });
    for (let index = 0; index < MAX_READ_FRESHNESS_RECORDS + 9; index += 1) {
      await session.executor.execute({ callId: `bounded-${index}`, toolId: "fs.read",
        arguments: { path: "src/bounded.ts" }, reads: ["src/bounded.ts"], display: "fs.read src/bounded.ts" },
      new AbortController().signal);
    }
    expect(session.kernel.history).toHaveLength(0);
    expect(session.freshnessStateStats().readCalls).toBe(MAX_READ_FRESHNESS_RECORDS);
    session.kernel.hydrateHistory([
      { type: "function_call", callId: "bounded-0", name: "fs.read", argumentsText: '{"path":"src/bounded.ts"}' },
      { type: "function_call_output", callId: "bounded-0", output: "export const leaked = true;" },
    ]);
    expect(session.promptInputs().staleReadCallIds).toContain("bounded-0");
  });

  test("an inherited running job fences cached instructions before the first sample", async () => {
    const instruction = "INHERITED_JOB_STALE_INSTRUCTION_SENTINEL";
    let polls = 0;
    let now = 18_000;
    const runtime = {
      workspace: "/work",
      read: async (path: string) => path === "AGENTS.md"
        ? { path, binary: false, checksum: "9".repeat(64), excerpt: { text: instruction }, rendered: instruction }
        : Promise.reject(new Error("not found")),
      jobStatus: async () => { polls += 1; return { jobs: [{ jobId: "inherited-job", state: "running" }] }; },
      glob: async () => ({ entries: [] }), gitDiff: async () => ({ files: [] }),
      appendEvents: async (params: { events?: unknown[] }) => ({ appended: params.events?.length ?? 0, lastSequence: params.events?.length ?? 0 }),
      openSession: async () => ({ ok: true }), snapshotSession: async () => ({ ok: true }), loadSession: async () => ({ events: [] }),
    };
    const provider = new MockProvider({ steps: [{ text: "Waiting for the job." }] });
    const session = new AgentSession({ host: { now: () => ++now } as never, runtime: runtime as never,
      config: loadConfig({ projectTrusted: true, env: {} }).config, workspacePath: "/work",
      workspaceIdentityDigest: "9".repeat(64), trust: "trusted-always", sessionId: "inherited-job",
      provider, approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(), nonInteractive: false, now: () => ++now });
    await session.context.loadInstructions({ trusted: true });
    await session.submit("Continue safely", new AbortController().signal);
    expect(polls).toBeGreaterThan(0);
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(instruction);
  });

});
