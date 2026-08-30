/**
 * Action-group dispatch through the kernel — PRD §6.5.
 *
 * The point of these tests is that the facade is invisible below the dispatch
 * boundary. §6.5 keeps the internal tool ids and the permission classifier, so
 * what the executor receives, what the timeline records, and what a denial names
 * must all be the internal tool — indistinguishable from the direct call.
 */

import { describe, expect, test } from "bun:test";

import type { CbcEventKind } from "@cbc/protocol";
import { MockProvider, type ScriptedStep } from "@cbc/provider-openai";
import { NATIVE_TOOLS, ToolRegistry, okResult } from "@cbc/tool-registry";
import type { PermissionContext, ProposedAction } from "@cbc/permissions";

import { AgentKernel } from "../src/index.ts";

interface Recorded {
  readonly kind: CbcEventKind;
  readonly payload: unknown;
}

function harness(steps: ScriptedStep[], permission: Partial<PermissionContext> = {}) {
  const events: Recorded[] = [];
  const executed: ProposedAction[] = [];
  const registry = new ToolRegistry();
  const kernel = new AgentKernel({
    agentId: "root",
    role: "root",
    provider: new MockProvider({ steps, repeatLast: true }),
    registry,
    emitter: { emit: (kind, payload) => { events.push({ kind, payload }); } },
    executor: {
      execute: async (action) => {
        executed.push(action);
        return { result: okResult(`${action.toolId} completed`), durationMs: 1 };
      },
      spill: async (label, content) => ({
        id: `art_${label}`,
        digest: "d".repeat(64),
        mediaType: "text/plain",
        bytes: content.length,
        redaction: "redacted" as const,
        retentionClass: "session" as const,
      }),
    },
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    normalizer: {
      normalize: (callId, toolId, args) => ({
        callId,
        toolId,
        arguments: args,
        display: `${toolId} ${JSON.stringify(args).slice(0, 60)}`,
        ...(typeof args.path === "string" && toolId === "fs.read" ? { reads: [args.path] } : {}),
      }),
    },
    model: "gpt-5.6",
    permissionContext: () => ({
      mode: "auto",
      trust: "trusted-always",
      rules: [],
      catalog: NATIVE_TOOLS,
      agentRole: "root",
      nonInteractive: false,
      configPermissions: {
        shell: "safe-auto",
        network: "ask",
        destructive: "ask",
        credentials: "deny",
        externalSideEffect: "ask",
      },
      ...permission,
    }),
    promptInputs: () => ({
      activeTools: registry.activeTools(),
      projectInstructions: [],
      skillCatalog: [],
      loadedSkills: [],
      repositoryContext: [],
      history: [],
    }),
  });
  return { kernel, events, executed, registry };
}

function payloadsOf(events: readonly Recorded[], kind: CbcEventKind): unknown[] {
  return events.filter((event) => event.kind === kind).map((event) => event.payload);
}

describe("action group dispatch (§6.5)", () => {
  test("a group call executes as the internal tool it names", async () => {
    const { kernel, events, executed } = harness([
      {
        toolCalls: [{
          callId: "c1",
          name: "inspect",
          arguments: { tool: "fs.read", arguments: { path: "src/a.ts" } },
        }],
      },
      { text: "done" },
    ]);
    await kernel.runTurn("read the file", new AbortController().signal);

    // The executor, the permission check, and the timeline all see fs.read.
    expect(executed.map((action) => action.toolId)).toEqual(["fs.read"]);
    // Validated against fs.read's own schema, so its defaults are applied — the
    // group never gets to decide what a well-formed fs.read call looks like.
    expect(executed[0]?.arguments).toMatchObject({ path: "src/a.ts", maxLines: 400, mode: "exact" });
    const started = payloadsOf(events, "tool.started") as Array<{ toolId: string }>;
    expect(started.map((payload) => payload.toolId)).toEqual(["fs.read"]);
    // The expansion itself is recorded exactly once, so a replay can still tell
    // the model reached the tool through a group.
    const expanded = payloadsOf(events, "tool.group_expanded") as Array<{
      callId: string;
      group: string;
      toolId: string;
    }>;
    expect(expanded).toEqual([{ callId: "c1", group: "inspect", toolId: "fs.read" }]);
  });

  test("the group id appears nowhere in the executed action or the timeline", async () => {
    const { kernel, events, executed } = harness([
      {
        toolCalls: [{
          callId: "c1",
          name: "inspect",
          arguments: { tool: "fs.read", arguments: { path: "src/a.ts" } },
        }],
      },
      { text: "done" },
    ]);
    await kernel.runTurn("read the file", new AbortController().signal);
    expect(JSON.stringify(executed)).not.toContain("inspect");
    // Only the one expansion record mentions the group.
    const mentions = events.filter((event) => JSON.stringify(event.payload).includes("\"inspect\""));
    expect(mentions.map((event) => event.kind)).toEqual(["tool.group_expanded"]);
  });

  test("an inactive target is still rejected through a group", async () => {
    // task.spawn is not always-active, so §6.6's discovery gate must still bite.
    const { kernel, events, executed } = harness([
      {
        toolCalls: [{
          callId: "c1",
          name: "delegate",
          arguments: { tool: "task.spawn", arguments: { role: "explore", goal: "find the parser entry point" } },
        }],
      },
      { text: "done" },
    ]);
    await kernel.runTurn("spawn a scout", new AbortController().signal);
    expect(executed).toHaveLength(0);
    const failures = payloadsOf(events, "tool.failed") as Array<{ toolId: string; message: string }>;
    // The rejection names the internal tool and the existing discovery remedy —
    // the group did not become a way around activation.
    expect(failures[0]?.toolId).toBe("task.spawn");
    expect(failures.some((failure) => failure.message.includes("tool.discover"))).toBe(true);
  });

  test("an unresolvable group call is refused with the internal-tool reason", async () => {
    const { kernel, events, executed } = harness([
      { toolCalls: [{ callId: "c1", name: "change", arguments: { tool: "fs.read", arguments: {} } }] },
      { text: "done" },
    ]);
    await kernel.runTurn("edit the file", new AbortController().signal);
    expect(executed).toHaveLength(0);
    const failures = payloadsOf(events, "tool.failed") as Array<{ toolId: string; message: string }>;
    expect(failures[0]?.toolId).toBe("change");
    // Naming the owning group turns a wrong guess into a one-turn correction.
    expect(failures[0]?.message).toContain("inspect");
    expect(payloadsOf(events, "tool.group_expanded")).toHaveLength(0);
  });

  test("malformed group arguments are refused rather than executed", async () => {
    const { kernel, events, executed } = harness([
      { toolCalls: [{ callId: "c1", name: "change", arguments: "{not json" }] },
      { text: "done" },
    ]);
    await kernel.runTurn("edit the file", new AbortController().signal);
    expect(executed).toHaveLength(0);
    expect(payloadsOf(events, "tool.failed")).toHaveLength(1);
  });

  test("a group call and the direct call produce the same executed action", async () => {
    const viaGroup = harness([
      {
        toolCalls: [{
          callId: "c1",
          name: "inspect",
          arguments: { tool: "fs.read", arguments: { path: "src/a.ts" } },
        }],
      },
      { text: "done" },
    ]);
    await viaGroup.kernel.runTurn("read the file", new AbortController().signal);

    const viaDirect = harness([
      { toolCalls: [{ callId: "c1", name: "fs.read", arguments: { path: "src/a.ts" } }] },
      { text: "done" },
    ]);
    await viaDirect.kernel.runTurn("read the file", new AbortController().signal);

    // Identical down to reads and display, so the transaction, the approval card,
    // and the evidence are the same operation either way.
    expect(viaGroup.executed).toEqual(viaDirect.executed);
  });

  test("a direct call is untouched by the group path", async () => {
    const { kernel, events, executed } = harness([
      { toolCalls: [{ callId: "c1", name: "fs.read", arguments: { path: "src/a.ts" } }] },
      { text: "done" },
    ]);
    await kernel.runTurn("read the file", new AbortController().signal);
    expect(executed.map((action) => action.toolId)).toEqual(["fs.read"]);
    expect(payloadsOf(events, "tool.group_expanded")).toHaveLength(0);
  });
});
