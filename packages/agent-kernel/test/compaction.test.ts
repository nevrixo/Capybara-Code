import { describe, expect, test } from "bun:test";

import {
  buildCompactionSourceBundle,
  emptyViewModel,
  type ModelCompactionSummaryV2,
} from "@cbc/session-domain";
import { MockProvider } from "@cbc/provider-openai";
import {
  ProviderContextSummaryModel,
  buildContextSummaryModelRequest,
} from "../src/compaction.ts";

function sourceBundle() {
  return buildCompactionSourceBundle(emptyViewModel("summary-model"));
}

function summary(sourceDigest: string): ModelCompactionSummaryV2 {
  return {
    schemaVersion: "2.0",
    sourceDigest,
    goal: "",
    currentState: "No prior task state.",
    constraints: [],
    decisions: [],
    completedWork: [],
    workspaceChanges: [],
    verification: [],
    failedApproaches: [],
    unresolved: [],
    todos: [],
    approvals: [],
    pendingQuestionnaire: null,
    nextAction: "await user direction",
  };
}

describe("context summary model", () => {
  test("builds an isolated no-tools strict-schema request", () => {
    const bundle = sourceBundle();
    const request = buildContextSummaryModelRequest({
      requestId: "compact-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      maxOutputTokens: 4_096,
      summaryTokenBudget: 2_048,
      sourceBundle: bundle,
    });
    expect(request.tools).toEqual([]);
    expect(request.hostedTools).toEqual([]);
    expect(request.store).toBe(false);
    expect(request.parallelToolCalls).toBe(false);
    expect(request.reasoning).toMatchObject({
      mode: "standard",
      effort: "low",
      summary: "none",
      context: "current_turn",
    });
    expect(request.responseFormat).toMatchObject({
      type: "json_schema",
      name: "context_compaction_summary_v2",
      strict: true,
    });
    expect(request.contextManagement).toBeUndefined();
  });

  test("collects and parses a structured provider response", async () => {
    const bundle = sourceBundle();
    const provider = new MockProvider({
      steps: [{ text: JSON.stringify(summary(bundle.sourceDigest)) }],
    });
    const model = new ProviderContextSummaryModel(provider);
    const result = await model.summarize({
      requestId: "compact-2",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      maxOutputTokens: 4_096,
      summaryTokenBudget: 2_048,
      sourceBundle: bundle,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toEqual(summary(bundle.sourceDigest));
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  test("fails closed on invalid JSON", async () => {
    const bundle = sourceBundle();
    const model = new ProviderContextSummaryModel(new MockProvider({
      steps: [{ text: "not-json" }],
    }));
    const result = await model.summarize({
      requestId: "compact-invalid",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      maxOutputTokens: 1_024,
      summaryTokenBudget: 512,
      sourceBundle: bundle,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "invalid_request", retryable: false },
    });
  });

  test("rejects tool calls from the compaction model", async () => {
    const bundle = sourceBundle();
    const model = new ProviderContextSummaryModel(new MockProvider({
      steps: [{
        toolCalls: [{ callId: "bad", name: "fs.read", arguments: { path: "x" } }],
      }],
    }));
    const result = await model.summarize({
      requestId: "compact-tool",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      maxOutputTokens: 1_024,
      summaryTokenBudget: 512,
      sourceBundle: bundle,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "invalid_request", retryable: false },
    });
  });

  test("propagates cancellation without adopting partial output", async () => {
    const bundle = sourceBundle();
    const controller = new AbortController();
    controller.abort();
    const model = new ProviderContextSummaryModel(new MockProvider({
      steps: [{ text: JSON.stringify(summary(bundle.sourceDigest)) }],
    }));
    const result = await model.summarize({
      requestId: "compact-cancel",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      maxOutputTokens: 1_024,
      summaryTokenBudget: 512,
      sourceBundle: bundle,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "cancelled", retryable: false },
    });
  });
});
