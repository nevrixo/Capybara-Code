import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for subagent startup");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("parent cancellation", () => {
  test("aborting a turn cancels its live subagents", async () => {
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
              goal: "Read src/child.ts and report it.",
              context: [],
              constraints: ["Read only; do not modify files."],
              expectedOutput: ["Report the source file."],
              allowedPaths: [],
              forbiddenPaths: [],
              verification: [],
              modelProfile: "auto",
              dependencies: [],
            },
          }],
        },
        // The child deliberately waits. It can finish only if its own signal is
        // aborted by the parent-cancellation listener.
        { delayMs: 30_000, text: "Child complete." },
      ],
    });
    const events: CbcEvent[] = [];
    let now = 1_000;
    const runtime = {
      workspace: "/work",
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
      config: loadConfig({ projectTrusted: true, env: {} }).config,
      workspacePath: "/work",
      workspaceIdentityDigest: "a".repeat(64),
      trust: "trusted-always",
      sessionId: "session-subagent-cancellation",
      provider,
      approvals: { request: async () => ({ kind: "allow_once" as const }) },
      granted: new GrantedRules(),
      nonInteractive: false,
      now: () => ++now,
      onEvent: (event) => { events.push(event); },
    });
    session.registry.activate(["task.spawn"]);

    const controller = new AbortController();
    const turn = session.submit("Delegate a long-running read", controller.signal);
    await waitUntil(() => events.some((event) => event.kind === "task.started"));

    controller.abort();
    const result = await turn;

    expect(result.report.status).toBe("cancelled");
    expect(events.some((event) => event.kind === "task.cancelled")).toBe(true);
    expect(session.viewModel.activeTasks).toHaveLength(0);
    await session.close();
  }, 5_000);
});