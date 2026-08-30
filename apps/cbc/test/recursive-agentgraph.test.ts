import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";
import type { CustomAgentDefinition } from "@cbc/subagents";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

function runtimeStub() {
  return {
    workspace: "/work",
    workspaceId: "workspace_recursive",
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
}

function session(
  provider: MockProvider,
  events: CbcEvent[],
  id: string,
  customAgents: readonly CustomAgentDefinition[] = [],
) {
  let now = 10_000;
  return new AgentSession({
    host: { now: () => ++now } as never,
    runtime: runtimeStub() as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "a".repeat(64),
    trust: "trusted-always",
    sessionId: id,
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    ...(customAgents.length === 0 ? {} : { customAgents }),
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
}

describe("recursive AgentGraph bridge", () => {
  test("lets a child spawn a grandchild through its subtree facade", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "root-spawn",
            name: "task.spawn",
            arguments: {
              role: "architect",
              title: "Map storage architecture",
              goal: "Map the storage architecture and delegate one focused exploration.",
              constraints: ["Read only."],
              expectedOutput: ["Return architecture and child evidence."],
              context: [],
              allowedPaths: [],
              forbiddenPaths: [],
              verification: [],
              dependencies: [],
            },
          }],
        },
        {
          toolCalls: [{
            callId: "child-spawn",
            name: "task.spawn",
            arguments: {
              role: "explore",
              title: "Explore storage module",
              goal: "Explore the storage module and report exact source evidence.",
              constraints: ["Read only."],
              expectedOutput: ["Return exact storage evidence."],
              context: [],
              allowedPaths: [],
              forbiddenPaths: [],
              verification: [],
              dependencies: [],
            },
          }],
        },
        { text: "Grandchild storage evidence complete." },
        { text: "Architect combined the child evidence." },
        { text: "Root accepted the recursive result." },
      ],
    });
    const events: CbcEvent[] = [];
    const agent = session(provider, events, "session_recursive");
    agent.registry.activate(["task.spawn"]);

    const result = await agent.submit(
      "Delegate an architecture task that delegates storage exploration.",
      new AbortController().signal,
    );

    expect(result.answer).toContain("Root accepted");
    expect(provider.requests).toHaveLength(5);
    const created = events
      .filter((event) => event.kind === "task.created")
      .map((event) => event.payload as { taskId: string; parentId?: string; depth?: number });
    expect(created.map((entry) => entry.depth)).toEqual([1, 2]);
    expect(created[1]?.parentId).toBe(created[0]?.taskId);
    expect(JSON.stringify(provider.requests[1])).toContain("task.spawn");
  });

  test("blocks a writer before sampling when isolated worktree runtime is unavailable", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "writer-spawn",
            name: "task.spawn",
            arguments: {
              role: "executor",
              title: "Implement parser fix",
              goal: "Implement the scoped parser fix in src/parser.ts and verify it.",
              constraints: ["Change only the delegated parser file."],
              expectedOutput: ["Return the edit receipt and verification."],
              context: [],
              allowedPaths: ["src/parser.ts"],
              forbiddenPaths: [],
              verification: ["bun test"],
              dependencies: [],
            },
          }],
        },
        { text: "Writer isolation was reported as blocked." },
      ],
    });
    const events: CbcEvent[] = [];
    const agent = session(provider, events, "session_writer_preflight");
    agent.registry.activate(["task.spawn"]);

    const result = await agent.submit(
      "Delegate the parser edit.",
      new AbortController().signal,
    );

    expect(result.answer).toContain("Writer isolation");
    expect(provider.requests).toHaveLength(2);
    const terminal = events.find((event) =>
      event.kind === "task.failed"
      && (event.payload as { status?: string }).status === "blocked"
    );
    expect(terminal).toBeDefined();
    expect(JSON.stringify(terminal?.payload)).toContain("worktree isolation preflight failed");
  });

  test("discovers and spawns a package custom agent with narrowed hard limits", async () => {
    const custom: CustomAgentDefinition = {
      name: "package-reviewer",
      description: "Review package-defined security boundaries.",
      mode: "subagent",
      baseRole: "reviewer",
      modelProfile: "economy",
      permissionClass: "read",
      maxTools: 3,
      instructions: "Inspect trust boundaries and return concise evidence.",
      source: "project",
      path: "/cache/agents/package-reviewer.md",
    };
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [{
            callId: "custom-search",
            name: "task.search",
            arguments: { query: "package security reviewer" },
          }],
        },
        {
          toolCalls: [{
            callId: "custom-spawn",
            name: "task.spawn",
            arguments: {
              role: "package-reviewer",
              title: "Review package trust",
              goal: "Review package trust boundaries and return exact security evidence.",
              constraints: ["Read only."],
              expectedOutput: ["Return concise security evidence."],
              context: [],
              allowedPaths: [],
              forbiddenPaths: [],
              verification: [],
              dependencies: [],
            },
          }],
        },
        { text: "Package trust review complete." },
        { text: "Root accepted the custom review." },
      ],
    });
    const events: CbcEvent[] = [];
    const agent = session(
      provider,
      events,
      "session_custom_package_agent",
      [custom],
    );
    agent.registry.activate(["task.search", "task.spawn"]);

    const result = await agent.submit(
      "Find and delegate to the package security reviewer.",
      new AbortController().signal,
    );

    expect(result.answer).toContain("Root accepted");
    expect(JSON.stringify(provider.requests[1])).toContain("package-reviewer");
    expect(JSON.stringify(provider.requests[2])).toContain(custom.instructions);
    const instance = agent.taskInstances()[0]!;
    expect(instance.role).toBe("reviewer");
    expect(instance.name).toBe("package-reviewer");
    expect(instance.modelProfile).toBe("economy");
    expect(instance.budget.maxToolCalls).toBe(3);
    expect(instance.permissions.canWrite).toBe(false);
    expect(instance.permissions.canRunProcess).toBe(false);
  });
});
