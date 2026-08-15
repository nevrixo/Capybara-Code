import { describe, expect, test } from "bun:test";

import type { CbcEventKind } from "@cbc/protocol";
import { MockProvider } from "@cbc/provider-openai";
import { NATIVE_TOOLS, ToolRegistry, okResult } from "@cbc/tool-registry";

import { AgentKernel } from "../src/index.ts";

interface RecordedEvent {
  readonly kind: CbcEventKind;
  readonly payload: unknown;
}

describe("previous_response recovery", () => {
  test("retries a missing cursor once with the complete local transcript", async () => {
    const provider = new MockProvider({
      steps: [
        {
          toolCalls: [
            {
              callId: "recovery-call",
              name: "fs.read",
              arguments: { path: "src/recovery.ts" },
            },
          ],
        },
        {
          error: {
            kind: "invalid_request",
            code: "previous_response_not_found",
            message: "previous_response_not_found: the linked response expired",
            retryable: false,
          },
        },
        { text: "Recovered exactly once." },
      ],
    });
    const events: RecordedEvent[] = [];
    const kernel = new AgentKernel({
      agentId: "root",
      role: "root",
      provider,
      registry: new ToolRegistry(),
      emitter: {
        emit: (kind, payload) => {
          events.push({ kind, payload });
        },
      },
      executor: {
        execute: async () => ({
          result: okResult("read completed"),
          text: "RECOVERY_TOOL_OUTPUT_SENTINEL",
          durationMs: 1,
        }),
        spill: async (label, content) => ({
          id: `artifact-${label}`,
          digest: "d".repeat(64),
          mediaType: "text/plain",
          bytes: content.length,
          redaction: "redacted" as const,
          retentionClass: "session" as const,
        }),
      },
      approvals: {
        request: async () => ({ kind: "allow_once" }),
      },
      normalizer: {
        normalize: (callId, toolId, args) => ({
          callId,
          toolId,
          arguments: args,
          display: `${toolId} ${JSON.stringify(args)}`,
          ...(typeof args.path === "string" ? { reads: [args.path] } : {}),
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
      }),
      promptInputs: () => ({
        activeTools: [],
        projectInstructions: [],
        skillCatalog: [],
        loadedSkills: [],
        repositoryContext: [],
        history: [],
      }),
      continuationMode: "previous_response",
    });

    const result = await kernel.runTurn(
      "RECOVERY_ORIGINAL_USER_SENTINEL",
      new AbortController().signal,
    );

    expect(result.state).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]?.previousResponseId).toBeUndefined();
    expect(provider.requests[1]?.previousResponseId).toBe("mock_resp_1");

    const recoveryRequest = provider.requests[2];
    expect(recoveryRequest?.previousResponseId).toBeUndefined();
    expect(JSON.stringify(recoveryRequest?.input)).toContain("RECOVERY_ORIGINAL_USER_SENTINEL");
    expect(
      recoveryRequest?.input.some(
        (item) =>
          item.type === "function_call" &&
          item.callId === "recovery-call" &&
          item.name === "fs.read",
      ),
    ).toBe(true);
    expect(
      recoveryRequest?.input.some(
        (item) =>
          item.type === "function_call_output" &&
          item.callId === "recovery-call" &&
          item.output.includes("RECOVERY_TOOL_OUTPUT_SENTINEL"),
      ),
    ).toBe(true);

    const fallbacks = events.filter((event) => event.kind === "provider.fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.payload).toMatchObject({ continuation: "full_replay" });
  });
});
