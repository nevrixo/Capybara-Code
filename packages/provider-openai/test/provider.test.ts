/**
 * Provider contract tests — PRD §25.6, AC-42, AC-43, AC-47, AC-48, AC-49.
 *
 * §25.6: the regular suite must not depend on the live API. Every case here uses
 * recorded SSE fixtures or the mock provider.
 */

import { describe, expect, test } from "bun:test";

import {
  BUNDLED_CAPABILITY_MANIFEST,
  chatGptCodexCapability,
  snapshotDescriptor,
  InferenceUtilityController,
  MAX_RETRY_ATTEMPTS,
  MODEL_REGISTRY,
  calculateNativeCompactionThreshold,
  MockProvider,
  OpenAiResponsesProvider,
  PRICING_REGISTRY_VERSION,
  buildCacheKey,
  chunkedSseStream,
  complexityScore,
  decideCaching,
  decideRetry,
  defaultFeatures,
  effortChangeLine,
  effortForScore,
  estimateCostUsd,
  fakeLease,
  findModel,
  inputContextBudget,
  normalizeProviderError,
  outputBudget,
  resolveProviderGenerationBudget,
  parseResponseStream,
  reasoningContextScope,
  clampEffortToModel,
  selectEffort,
  selectReasoningMode,
  sseStream,
  supportsEffort,
  type FetchLike,
  type ModelEvent,
  type ModelRequest,
  type OpenAiProviderOptions,
} from "../src/index.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "req_1",
    model: "gpt-5.6",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [],
    reasoning: { mode: "standard", effort: "medium", summary: "auto", context: "all_turns" },
    maxOutputTokens: 4_000,
    store: false,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("model registry (§10.12)", () => {
  test("calculates native compaction from the model window", () => {
    const threshold = calculateNativeCompactionThreshold({
      modelWindowTokens: 200_000,
      outputReserveTokens: 32_000,
      adaptiveLocalTargetTokens: 120_000,
    });
    expect(threshold).toBe(136_000);
    expect(calculateNativeCompactionThreshold({
      modelWindowTokens: 64_000,
      outputReserveTokens: 32_000,
      adaptiveLocalTargetTokens: 60_000,
    })).toBeLessThan(64_000);
  });
  test("includes the three GPT-5.6 family members", () => {
    expect(MODEL_REGISTRY.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  test("resolves aliases", () => {
    expect(findModel("sol")?.id).toBe("gpt-5.6-sol");
    expect(findModel("terra")?.id).toBe("gpt-5.6-terra");
    expect(findModel("GPT-5.6-LUNA")?.id).toBe("gpt-5.6-luna");
    expect(findModel("nope")).toBeUndefined();
  });

  test("derives an input budget from the model window and output ceiling", () => {
    expect(inputContextBudget(findModel("gpt-5.6"))).toBe(922_000);
    expect(inputContextBudget(findModel("gpt-5.6-luna"))).toBe(922_000);
    expect(inputContextBudget(undefined, 12_000)).toBeUndefined();
  });
  test("records per-model capability differences", () => {
    expect(supportsEffort(findModel("gpt-5.6")!, "max")).toBe(true);
    expect(supportsEffort(findModel("gpt-5.6-luna")!, "xhigh")).toBe(true);
    expect(findModel("gpt-5.6-luna")!.supportsReasoningSummary).toBe(false);
    expect(findModel("gpt-5.6")!.reasoningModes).toContain("pro");
    expect(findModel("gpt-5.6-terra")!.reasoningModes).not.toContain("pro");
  });
});

describe("hosted capability profiles", () => {
  test("the bundled GPT-5.6 profile exposes current context and hosted tool metadata", () => {
    for (const model of MODEL_REGISTRY) {
      expect(model.contextWindow).toBe(1_050_000);
      expect(model.maxOutputTokens).toBe(128_000);
    }
    const provider = new OpenAiResponsesProvider({ credential: fakeLease() });
    const snapshot = provider.capabilitySnapshot("gpt-5.6")!;
    // 272K is the published premium-pricing boundary, not a context cap.
    expect(snapshot.pricingBand?.premiumThresholdTokens).toBe(272_000);
    expect(snapshot.contextWindow).toBe(1_050_000);
    expect(snapshot.native.webSearch).toBe("supported");
    expect(snapshot.native.imageGeneration).toBe("supported");
    expect(snapshot.supportedHostedTools).toContain("web_search");
    expect(snapshot.supportedHostedTools).toContain("image_generation");
  });

  test("ChatGPT/Codex account profile uses 400K for Sol, Terra, and Luna", () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      chatGpt: { accountId: "acct" },
    });
    for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const snapshot = provider.capabilitySnapshot(modelId)!;
      expect(snapshot.contextWindow).toBe(400_000);
      expect(snapshot.maxOutputTokens).toBe(128_000);
      expect(inputContextBudget(snapshotDescriptor(snapshot))).toBe(272_000);
      expect(snapshot.reasoningModes).toEqual(["standard"]);
    }

    expect(provider.capabilitySnapshot("gpt-5.6")!.native.webSearch).toBe("supported");
    const disabled = new OpenAiResponsesProvider({
      credential: fakeLease(),
      chatGpt: { accountId: "acct" },
      allowChatGptHostedTools: false,
    });
    expect(disabled.capabilitySnapshot("gpt-5.6")!.native.webSearch).toBe("unknown");
  });
});
describe("ChatGPT/Codex routing profile", () => {
  test("uses the account envelope for every Sol/Terra/Luna routing decision", () => {
    const policy = new InferenceUtilityController({
      capabilityResolver: chatGptCodexCapability,
    });
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const decision = policy.decide({
        intent: "program",
        explicitModel: model,
        contextTokens: 272_001,
        reserveOutputTokens: 128_000,
      });
      expect(decision.capability.contextWindow).toBe(400_000);
      expect(inputContextBudget(snapshotDescriptor(decision.capability))).toBe(272_000);
      expect(decision.context.allowed).toBe(false);
    }
  });

  test("downgrades a pro child profile before it reaches the account backend", () => {
    const decision = new InferenceUtilityController({
      capabilityResolver: chatGptCodexCapability,
    }).decide({
      intent: "review",
      explicitModel: "gpt-5.6-sol",
      explicitMode: "pro",
      explicitEffort: "high",
      contextTokens: 1_000,
    });

    expect(decision.mode).toBe("standard");
    expect(decision.effort).toBe("high");
  });
});

describe("adaptive reasoning (§10.4, AC-48)", () => {
  test("score maps to effort per the PRD table", () => {
    expect(effortForScore(0)).toBe("low");
    expect(effortForScore(2)).toBe("low");
    expect(effortForScore(3)).toBe("medium");
    expect(effortForScore(5)).toBe("medium");
    expect(effortForScore(6)).toBe("high");
    expect(effortForScore(7)).toBe("high");
    expect(effortForScore(8)).toBe("xhigh");
    expect(effortForScore(9)).toBe("xhigh");
    expect(effortForScore(10)).toBe("max");
  });

  test("a trivial task scores low", () => {
    expect(complexityScore(defaultFeatures())).toBeLessThanOrEqual(2);
  });

  test("risk and ambiguity raise the score", () => {
    const score = complexityScore({
      ...defaultFeatures(),
      requestedConcerns: 3,
      expectedFilesTouched: 8,
      failingTestAmbiguity: 2,
      crossLanguageImpact: true,
      highRiskDomain: true,
    });
    expect(score).toBeGreaterThanOrEqual(8);
  });

  test("max effort requires explicit confirmation (§10.4)", () => {
    const features = {
      ...defaultFeatures(),
      requestedConcerns: 5,
      expectedFilesTouched: 20,
      failingTestAmbiguity: 2 as const,
      crossLanguageImpact: true,
      concurrencyInvolved: true,
      highRiskDomain: true,
      userSpecifiedDepth: "deep" as const,
      previousFailedAttempts: 3,
    };
    const unconfirmed = selectEffort(features, findModel("gpt-5.6")!);
    expect(unconfirmed.score).toBe(10);
    expect(unconfirmed.effort).toBe("xhigh");
    expect(unconfirmed.requiresConfirmation).toBe(true);
    expect(unconfirmed.clamped?.from).toBe("max");

    const confirmed = selectEffort(features, findModel("gpt-5.6")!, { maxConfirmed: true });
    expect(confirmed.effort).toBe("max");
    const limitedLuna = {
      ...findModel("gpt-5.6-luna")!,
      reasoningEfforts: ["none", "low", "medium", "high"],
    };
    const luna = selectEffort(features, limitedLuna);
    expect(luna.effort).toBe("high");
    expect(supportsEffort(limitedLuna, luna.effort)).toBe(true);
  });

  test("an effort supported by the model is not clamped", () => {
    const decision = selectEffort(
      { ...defaultFeatures(), highRiskDomain: true, failingTestAmbiguity: 2, crossLanguageImpact: true, requestedConcerns: 4 },
      findModel("gpt-5.6-luna")!,
    );
    expect(decision.clamped).toBeUndefined();
    expect(decision.effort).toBe("high");
    expect(supportsEffort(findModel("gpt-5.6-luna")!, decision.effort)).toBe(true);
  });

  test("clamps an explicitly requested effort to a limited model capability", () => {
    const limitedLuna = {
      ...findModel("gpt-5.6-luna")!,
      reasoningEfforts: ["none", "low", "medium", "high"],
    };
    const result = clampEffortToModel(limitedLuna, "max");
    expect(result.effort).toBe("high");
    expect(result.clamped?.from).toBe("max");
  });

  test("the effort change line matches the PRD wording", () => {
    expect(effortChangeLine("medium", "high", "ambiguous cross-module failure")).toBe(
      "Reasoning adjusted: medium → high · ambiguous cross-module failure",
    );
  });

  test("the decision carries a human-readable reason", () => {
    const decision = selectEffort(
      { ...defaultFeatures(), failingTestAmbiguity: 1, previousFailedAttempts: 1 },
      findModel("gpt-5.6")!,
    );
    expect(decision.reason).toContain("ambiguous failing test");
    expect(decision.reason).toContain("previous failed attempt");
  });
});

describe("pro mode gate (§10.5)", () => {
  test("only enabled on explicit request or a permitted high-severity review", () => {
    const model = findModel("gpt-5.6")!;
    const base = {
      userRequested: false,
      autoReviewHighSeverity: false,
      configAllows: true,
      evalJustified: false,
    };
    expect(selectReasoningMode(base, model).mode).toBe("standard");
    expect(selectReasoningMode({ ...base, userRequested: true }, model).mode).toBe("pro");
    expect(
      selectReasoningMode({ ...base, autoReviewHighSeverity: true }, model).mode,
    ).toBe("pro");
    expect(
      selectReasoningMode(
        { ...base, autoReviewHighSeverity: true, configAllows: false },
        model,
      ).mode,
    ).toBe("standard");
  });

  test("pro mode surfaces a cost warning", () => {
    const decision = selectReasoningMode(
      { userRequested: true, autoReviewHighSeverity: false, configAllows: true, evalJustified: false },
      findModel("gpt-5.6")!,
    );
    expect(decision.showCostWarning).toBe(true);
  });

  test("a model without pro mode falls back to standard", () => {
    const decision = selectReasoningMode(
      { userRequested: true, autoReviewHighSeverity: false, configAllows: true, evalJustified: false },
      findModel("gpt-5.6-terra")!,
    );
    expect(decision.mode).toBe("standard");
    expect(decision.reason).toContain("does not offer pro reasoning");
  });
});

describe("output budget (§10.11)", () => {
  test("keeps presentation sizing separate from provider generation capacity", () => {
    const model = findModel("gpt-5.6")!;
    // The compatibility helper no longer has a phase token cap.
    expect(outputBudget("commentary", model, 64_000)).toBe(64_000);
    const generation = resolveProviderGenerationBudget({
      model,
      configuredMaxOutputTokens: 64_000,
      inputTokens: 2_000,
    });
    expect(generation.maxOutputTokens).toBe(64_000);
    expect(generation.maxOutputTokens).toBeGreaterThan(12_000);
  });

  test("caps generation only at the model/context ceiling", () => {
    const luna = findModel("gpt-5.6-luna")!;
    const generation = resolveProviderGenerationBudget({
      model: luna,
      configuredMaxOutputTokens: 1_000_000,
      inputTokens: luna.contextWindow! - 3_000,
      safetyReserveTokens: 1_000,
    });
    expect(generation.maxOutputTokens).toBe(2_000);
    expect(generation.maxOutputTokens).toBeLessThanOrEqual(luna.maxOutputTokens!);
  });
});

describe("deep reasoning budget warning", () => {
  test("surfaces an explicit max-effort budget conflict instead of silently truncating", () => {
    const decision = new InferenceUtilityController().decide({
      intent: "inspect",
      explicitEffort: "max",
      contextTokens: 1_000,
      configuredMaxOutputTokens: 12_000,
      needsReasoningSummary: true,
    });

    expect(decision.model).toBe("gpt-5.6-sol");
    expect(decision.outputTokens).toBe(12_000);
    expect(decision.warnings.some((warning) => warning.includes("deep-reasoning recommendation"))).toBe(true);
  });
});
describe("prompt caching (§10.9)", () => {
  test("no explicit write below the 1,024 token threshold", () => {
    const decision = decideCaching(500, 1, findModel("gpt-5.6")!, { prefixLikelyReused: true });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain("below the 1024 token threshold");
  });

  test("no write when the prefix is unlikely to be reused", () => {
    const decision = decideCaching(4_000, 1, findModel("gpt-5.6")!, { prefixLikelyReused: false });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain("unlikely to be reused");
  });

  test("caps writes at four per request", () => {
    const decision = decideCaching(8_000, 9, findModel("gpt-5.6")!, { prefixLikelyReused: true });
    expect(decision.enabled).toBe(true);
    expect(decision.breakpointCount).toBe(4);
  });

  test("downgrades safely when the model lacks explicit breakpoints", () => {
    const model = { ...findModel("gpt-5.6")!, supportsPromptCacheBreakpoints: false };
    const decision = decideCaching(8_000, 2, model, { prefixLikelyReused: true });
    expect(decision.enabled).toBe(false);
    expect(decision.downgradedToImplicit).toBe(true);
  });

  test("the cache key contains no user text, secret, or timestamp", () => {
    const key = buildCacheKey({
      workspaceHash: "ws1234",
      policyHash: "pol5678",
      toolsetHash: "tool9012",
      skillMetaHash: "skill345",
      stableShard: "a",
    });
    expect(key).toBe("capy:v1:ws1234:pol5678:tool9012:skill345:a");
    expect(key).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(key).not.toContain("sk-");
  });
});

describe("reasoning continuity (§10.8)", () => {
  test("root keeps all turns while the goal is stable", () => {
    expect(
      reasoningContextScope({
        isRoot: true,
        goalStable: true,
        isReviewer: false,
        hypothesisInvalidated: false,
      }),
    ).toBe("all_turns");
  });

  test("subagents, reviewers, pivots, and invalidated hypotheses reset", () => {
    const cases = [
      { isRoot: false, goalStable: true, isReviewer: false, hypothesisInvalidated: false },
      { isRoot: true, goalStable: true, isReviewer: true, hypothesisInvalidated: false },
      { isRoot: true, goalStable: false, isReviewer: false, hypothesisInvalidated: false },
      { isRoot: true, goalStable: true, isReviewer: false, hypothesisInvalidated: true },
    ];
    for (const c of cases) expect(reasoningContextScope(c)).toBe("current_turn");
  });
});

describe("retry policy (§10.13, AC-42, AC-43)", () => {
  test("rate limits back off with a bounded progressive delay", () => {
    const first = decideRetry({ kind: "rate_limit", retryable: true }, 0, {
      sideEffectsAlreadyApplied: false,
    });
    expect(first.retry).toBe(true);
    expect(first.delayMs).toBeGreaterThan(0);

    const later = decideRetry({ kind: "rate_limit", retryable: true }, 3, {
      sideEffectsAlreadyApplied: false,
    });
    expect(later.delayMs).toBeGreaterThan(first.delayMs);
    expect(later.delayMs).toBeLessThanOrEqual(30_000);

    const delays = Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, attempt) =>
      decideRetry({ kind: "rate_limit", retryable: true }, attempt, {
        sideEffectsAlreadyApplied: false,
      }),
    );
    expect(delays.every((decision) => decision.retry)).toBe(true);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!.delayMs).toBeGreaterThan(delays[index - 1]!.delayMs);
    }
    expect(
      decideRetry({ kind: "rate_limit", retryable: true }, MAX_RETRY_ATTEMPTS, {
        sideEffectsAlreadyApplied: false,
      }).retry,
    ).toBe(false);
  });

  test("honours a retry-after hint", () => {
    const decision = decideRetry(
      { kind: "rate_limit", retryable: true, retryAfterMs: 2_500 },
      0,
      { sideEffectsAlreadyApplied: false },
    );
    expect(decision.delayMs).toBe(2_500);
  });

  test("authentication and validation errors are not retried", () => {
    for (const kind of ["authentication", "invalid_request", "content_policy", "cancelled"]) {
      expect(
        decideRetry({ kind, retryable: false }, 0, { sideEffectsAlreadyApplied: false }).retry,
      ).toBe(false);
    }
  });

  test("no blind replay after a non-idempotent tool succeeded (AC-43)", () => {
    const decision = decideRetry({ kind: "network", retryable: true }, 0, {
      sideEffectsAlreadyApplied: true,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("non-idempotent tool already ran");
  });

  test("retries explicit overload rejection after a local mutation", () => {
    for (const kind of ["server", "rate_limit"] as const) {
      const decision = decideRetry({ kind, retryable: true }, 0, {
        sideEffectsAlreadyApplied: true,
        externalSideEffectsAlreadyApplied: false,
      });
      expect(decision.retry).toBe(true);
      expect(decision.attempt).toBe(1);
    }
  });

  test("does not resample after an external side effect", () => {
    const decision = decideRetry({ kind: "server", retryable: true }, 0, {
      sideEffectsAlreadyApplied: true,
      externalSideEffectsAlreadyApplied: true,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("external action already ran");
  });

  test("the retry budget is bounded", () => {
    expect(
      decideRetry({ kind: "server", retryable: true }, MAX_RETRY_ATTEMPTS, { sideEffectsAlreadyApplied: false })
        .retry,
    ).toBe(false);
  });
});

describe("provider error normalization (§10.13)", () => {
  test("classifies each documented category", () => {
    expect(normalizeProviderError({ status: 429, type: "rate_limit_error" }).kind).toBe("rate_limit");
    expect(normalizeProviderError({ status: 401 }).kind).toBe("authentication");
    expect(normalizeProviderError({ status: 400, type: "invalid_request_error" }).kind).toBe(
      "invalid_request",
    );
    expect(normalizeProviderError({ status: 503 }).kind).toBe("server");
    expect(normalizeProviderError({ code: "context_length_exceeded" }).kind).toBe("context_length");
  });

  test("marks only transient categories retryable", () => {
    expect(normalizeProviderError({ status: 429 }).retryable).toBe(true);
    expect(normalizeProviderError({ status: 503 }).retryable).toBe(true);
    expect(normalizeProviderError({ status: 408 }).retryable).toBe(true);
    expect(normalizeProviderError({ status: 400 }).retryable).toBe(false);
    expect(normalizeProviderError({ status: 401 }).retryable).toBe(false);
  });

  test("recognizes a status-less overload message as retryable", () => {
    const error = normalizeProviderError({
      message: "Our servers are currently overloaded. Please try again later.",
    });
    expect(error.kind).toBe("server");
    expect(error.retryable).toBe(true);
  });
});

describe("cost estimate (§23.7, AC-49)", () => {
  test("prices cached and uncached input separately", () => {
    const cost = estimateCostUsd("gpt-5.6", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.25, 4);

    const cachedCost = estimateCostUsd("gpt-5.6", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1_000_000,
    });
    expect(cachedCost).toBeLessThan(cost);
  });

  test("an unknown model estimates zero rather than guessing", () => {
    expect(
      estimateCostUsd("some-other-model", {
        inputTokens: 1000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1000,
        reasoningTokens: 0,
        totalTokens: 2000,
      }),
    ).toBe(0);
  });

  test("the pricing registry is timestamped", () => {
    expect(PRICING_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("SSE normalization (§10.2, §25.6)", () => {
  test("assembles text deltas and completion", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          { type: "response.created" },
          { type: "response.output_text.delta", delta: "Hello ", item_id: "m1", sequence_number: 1 },
          { type: "response.output_text.delta", delta: "world", item_id: "m1", sequence_number: 2 },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { input_tokens: 100, output_tokens: 20 } },
          },
        ]),
      ),
    );
    const text = events
      .filter((e): e is Extract<ModelEvent, { type: "text.delta" }> => e.type === "text.delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello world");
    expect(events.some((e) => e.type === "response.completed")).toBe(true);
  });

  test("separates commentary from the final answer (§10.7)", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_text.delta",
            delta: "I'll inspect the failing path.",
            item_id: "c1",
            phase: "commentary",
            sequence_number: 1,
          },
          { type: "response.output_text.delta", delta: "Fixed.", item_id: "m1", sequence_number: 2 },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    expect(events.some((e) => e.type === "commentary.delta")).toBe(true);
    expect(events.some((e) => e.type === "text.delta")).toBe(true);
  });

  test("emits reasoning summary deltas", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Weighed two options.",
            item_id: "r1",
            sequence_number: 1,
          },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    expect(
      events.find((e) => e.type === "reasoning.summary.delta"),
    ).toEqual({ type: "reasoning.summary.delta", text: "Weighed two options.", itemId: "r1" });
  });

  test("emits provider-visible reasoning text without exposing opaque content", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          { type: "response.reasoning_text.delta", delta: "First ", item_id: "r1", sequence_number: 1 },
          { type: "response.reasoning_text.done", text: "First complete thought.", item_id: "r1", sequence_number: 2 },
          { type: "response.output_item.done", item_id: "r1", item: { type: "reasoning", encrypted_content: "opaque", content: [{ type: "reasoning_text", text: "First complete thought." }] } },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    expect(events).toContainEqual({ type: "reasoning.text.delta", text: "First ", itemId: "r1" });
    expect(events).toContainEqual({ type: "reasoning.text.done", text: "First complete thought.", itemId: "r1" });
    expect(events).toContainEqual({
      type: "response.item",
      authoritative: true,
      item: expect.objectContaining({
        kind: "reasoning",
        opaque: "opaque",
        reasoningText: "First complete thought.",
      }),
    });
  });
  test("marks a completed output item as authoritative recovery data", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item_id: "message_1",
            item: { type: "message", content: [] },
          },
          {
            type: "response.output_item.done",
            item_id: "message_1",
            item: { type: "message", content: [{ type: "output_text", text: "Recovered final text." }] },
          },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    expect(events).toContainEqual({
      type: "response.item",
      authoritative: true,
      item: expect.objectContaining({ kind: "message", itemId: "message_1", text: "Recovered final text." }),
    });
  });
  test("uses a nested completed item id when the SSE frame omits item_id", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_text.delta",
            delta: "I will inspect the workspace.",
            item_id: "commentary_1",
            phase: "commentary",
            sequence_number: 1,
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "commentary_1",
              type: "message",
              phase: "commentary",
              content: [{ type: "output_text", text: "I will inspect the workspace." }],
            },
          },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );

    expect(events).toContainEqual({
      type: "commentary.delta",
      text: "I will inspect the workspace.",
      itemId: "commentary_1",
    });
    expect(events).toContainEqual({
      type: "response.item",
      authoritative: true,
      item: expect.objectContaining({
        kind: "message",
        itemId: "commentary_1",
        text: "I will inspect the workspace.",
        phase: "commentary",
      }),
    });
  });

  test("surfaces hosted web search progress and preserves clickable URL citations", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item: { id: "ws_1", type: "web_search_call", status: "searching" },
          },
          {
            type: "response.output_item.done",
            item: { id: "ws_1", type: "web_search_call", status: "completed" },
          },
          {
            type: "response.output_item.done",
            item: {
              id: "message_1",
              type: "message",
              phase: "final_answer",
              content: [{
                type: "output_text",
                text: "OpenAI builds AI systems.",
                annotations: [{
                  type: "url_citation",
                  start_index: 0,
                  end_index: 6,
                  title: "OpenAI",
                  url: "https://openai.com/",
                }],
              }],
            },
          },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );

    expect(events.filter((event) => event.type === "hosted.tool.started")).toHaveLength(1);
    expect(events).toContainEqual({
      type: "hosted.tool.completed",
      callId: "ws_1",
      name: "web_search",
      summary: "Web search completed",
    });
    expect(events).toContainEqual({
      type: "response.item",
      authoritative: true,
      item: expect.objectContaining({
        kind: "message",
        text: "[OpenAI](https://openai.com/) builds AI systems.",
      }),
    });
  });

  test("recovers the final generated image from response.completed", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item: { id: "img_1", type: "image_generation_call", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            item: { id: "img_1", type: "image_generation_call", status: "completed", error: null },
          },
          {
            type: "response.completed",
            response: {
              id: "r",
              output: [{
                id: "img_1",
                type: "image_generation_call",
                status: "completed",
                result: base64,
                output_format: "png",
                revised_prompt: "A capybara writing code",
              }],
            },
          },
        ]),
      ),
    );

    expect(events).toContainEqual({
      type: "hosted.tool.started",
      callId: "img_1",
      name: "image_generation",
      display: "Generating an image",
    });
    expect(events).toContainEqual({
      type: "hosted.tool.completed",
      callId: "img_1",
      name: "image_generation",
      summary: "Image generated",
      image: {
        base64,
        mediaType: "image/png",
        outputFormat: "png",
        revisedPrompt: "A capybara writing code",
      },
    });
    expect(events.filter((event) => event.type === "hosted.tool.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "hosted.tool.failed")).toBe(false);
  });

  test("assembles a tool call across argument deltas", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item_id: "i1",
            item: { type: "function_call", call_id: "call_1", name: "fs.read" },
            sequence_number: 1,
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "i1",
            delta: '{"path":',
            sequence_number: 2,
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "i1",
            delta: '"src/a.ts"}',
            sequence_number: 3,
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "i1",
            arguments: '{"path":"src/a.ts"}',
            sequence_number: 4,
          },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    const completed = events.find(
      (e): e is Extract<ModelEvent, { type: "tool.call.completed" }> =>
        e.type === "tool.call.completed",
    );
    expect(completed?.call.callId).toBe("call_1");
    expect(completed?.call.name).toBe("fs.read");
    expect(completed?.call.argumentsText).toBe('{"path":"src/a.ts"}');
  });

  test("handles multiple tool calls in one response", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item_id: "i1",
            item: { type: "function_call", call_id: "c1", name: "fs.read" },
            sequence_number: 1,
          },
          {
            type: "response.output_item.added",
            item_id: "i2",
            item: { type: "function_call", call_id: "c2", name: "fs.glob" },
            sequence_number: 2,
          },
          { type: "response.function_call_arguments.done", item_id: "i1", arguments: "{}", sequence_number: 3 },
          { type: "response.function_call_arguments.done", item_id: "i2", arguments: "{}", sequence_number: 4 },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    expect(events.filter((e) => e.type === "tool.call.completed")).toHaveLength(2);
  });

  test("suppresses duplicate deltas (§25.6)", async () => {
    const frame = {
      type: "response.output_text.delta",
      delta: "once",
      item_id: "m1",
      sequence_number: 7,
    };
    const events = await collect(
      parseResponseStream(sseStream([frame, frame, { type: "response.completed", response: { id: "r" } }])),
    );
    expect(events.filter((e) => e.type === "text.delta")).toHaveLength(1);
  });

  test("reassembles frames split across chunk boundaries", async () => {
    const events = await collect(
      parseResponseStream(
        chunkedSseStream(
          [
            { type: "response.output_text.delta", delta: "chunked", item_id: "m", sequence_number: 1 },
            { type: "response.completed", response: { id: "r" } },
          ],
          7,
        ),
      ),
    );
    expect(
      events.filter((e): e is Extract<ModelEvent, { type: "text.delta" }> => e.type === "text.delta")[0]
        ?.text,
    ).toBe("chunked");
  });

  test("accepts CRLF SSE separators without waiting for stream completion", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: message\r\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "live",
              item_id: "m",
              sequence_number: 1,
            })}\r\n\r\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\r\n\r\n"));
        controller.close();
      },
    });
    const events = await collect(parseResponseStream(body));
    expect(events).toContainEqual({ type: "text.delta", text: "live", itemId: "m" });
  });

  test("normalizes usage including cache fields (AC-49)", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.completed",
            response: {
              id: "r",
              usage: {
                input_tokens: 2_000,
                output_tokens: 400,
                total_tokens: 2_400,
                input_tokens_details: { cached_tokens: 1_500, cache_write_tokens: 500 },
                output_tokens_details: { reasoning_tokens: 250 },
              },
            },
          },
        ]),
      ),
    );
    const usage = events.find(
      (e): e is Extract<ModelEvent, { type: "usage" }> => e.type === "usage",
    )?.usage;
    expect(usage?.inputTokens).toBe(2_000);
    expect(usage?.cachedInputTokens).toBe(1_500);
    expect(usage?.cacheWriteTokens).toBe(500);
    expect(usage?.reasoningTokens).toBe(250);
  });

  test("a response emits usage exactly once (P0-11)", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.completed",
            response: {
              id: "r",
              usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            },
          },
        ]),
      ),
    );
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  test("an incomplete response also emits usage exactly once (P0-11)", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.incomplete",
            response: {
              id: "r",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            },
          },
        ]),
      ),
    );
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  test("reports an incomplete response with its reason (§10.11)", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.incomplete",
            response: { id: "r", incomplete_details: { reason: "max_output_tokens" } },
          },
        ]),
      ),
    );
    expect(events).toContainEqual({ type: "response.incomplete", reason: "max_output_tokens", responseId: "r" });
  });

  test("reports a failure with a normalized error", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.failed",
            response: { error: { type: "rate_limit_error", message: "slow down", status: 429 } },
          },
        ]),
      ),
    );
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("rate_limit");
    expect(failure?.error.retryable).toBe(true);
  });

  test("ignores unparseable frames instead of aborting the turn", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          "{not json",
          { type: "response.output_text.delta", delta: "ok", item_id: "m", sequence_number: 1 },
          { type: "response.completed", response: { id: "r" } },
        ]),
      ),
    );
    expect(events.some((e) => e.type === "text.delta")).toBe(true);
    expect(events.some((e) => e.type === "response.completed")).toBe(true);
  });

  test("a truncated stream reports incomplete without promoting a pending call", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item_id: "i1",
            item: { type: "function_call", call_id: "c1", name: "fs.read" },
            sequence_number: 1,
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "i1",
            delta: '{"path":"a"}',
            sequence_number: 2,
          },
          // No `done`, no `response.completed`: the connection dropped.
        ]),
      ),
    );
    expect(events.some((e) => e.type === "tool.call.completed")).toBe(false);
    expect(events.some((e) => e.type === "response.incomplete")).toBe(true);
  });

  test("a real response completion preserves a pending call exactly once", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.output_item.added",
            item_id: "i1",
            item: { type: "function_call", call_id: "c1", name: "fs.read" },
            sequence_number: 1,
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "i1",
            delta: '{"path":"a"}',
            sequence_number: 2,
          },
          { type: "response.completed", response: { id: "r" }, sequence_number: 3 },
        ]),
      ),
    );
    expect(events.filter((event) => event.type === "tool.call.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(events.some((event) => event.type === "response.incomplete")).toBe(false);
  });

  test("incomplete and failed responses never promote unfinished calls", async () => {
    const prefix = [
      {
        type: "response.output_item.added",
        item_id: "i1",
        item: { type: "function_call", call_id: "c1", name: "fs.read" },
        sequence_number: 1,
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "i1",
        delta: '{"path":',
        sequence_number: 2,
      },
    ];
    const incomplete = await collect(
      parseResponseStream(
        sseStream([
          ...prefix,
          {
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
            sequence_number: 3,
          },
        ]),
      ),
    );
    const failed = await collect(
      parseResponseStream(
        sseStream([
          ...prefix,
          {
            type: "response.failed",
            response: { error: { message: "provider failed", status: 500 } },
            sequence_number: 3,
          },
        ]),
      ),
    );
    expect(incomplete.some((event) => event.type === "tool.call.completed")).toBe(false);
    expect(failed.some((event) => event.type === "tool.call.completed")).toBe(false);
  });

  test("emits the first provider terminal exactly once", async () => {
    const events = await collect(
      parseResponseStream(
        sseStream([
          {
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
          },
          { type: "response.completed", response: { id: "late" } },
          { type: "error", status: 503, error: { message: "later failure" } },
        ]),
      ),
    );
    const terminals = events.filter((event) =>
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    );
    expect(terminals).toEqual([{ type: "response.incomplete", reason: "max_output_tokens" }]);
  });

  test("merges top-level WebSocket status and code into nested errors", async () => {
    const serverEvents = await collect(
      parseResponseStream(sseStream([{ type: "error", status: "503", error: { message: "down" } }])),
    );
    const previousEvents = await collect(
      parseResponseStream(sseStream([{
        type: "error",

        status: 400,
        code: "previous_response_not_found",
        error: { message: "expired" },
      }])),
    );
    const server = serverEvents.find((event) => event.type === "response.failed");
    const previous = previousEvents.find((event) => event.type === "response.failed");
    expect(server?.type === "response.failed" ? server.error.kind : undefined).toBe("server");
    expect(server?.type === "response.failed" ? server.error.retryable : undefined).toBe(true);
    expect(
      previous?.type === "response.failed" ? previous.error.kind : undefined,
    ).toBe("invalid_request");
    expect(
      previous?.type === "response.failed" ? previous.error.code : undefined,
    ).toBe("previous_response_not_found");
  });

  test("mid-stream cancellation yields a cancelled error", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      parseResponseStream(
        sseStream([{ type: "response.output_text.delta", delta: "x", item_id: "m", sequence_number: 1 }]),
        controller.signal,
      ),
    );
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("cancelled");
    expect(failure?.error.retryable).toBe(false);
  });
});

describe("request body policy (§10.6, §10.14)", () => {
  async function captureBody(req: ModelRequest, providerOptions: Omit<Partial<OpenAiProviderOptions>, "credential"> = {}): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      ...providerOptions,
      fetchImpl: (async (_url, init) => {
        captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return new Response(sseStream([{ type: "response.completed", response: { id: "r" } }]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as FetchLike,
    });
    await collect(provider.stream(req, new AbortController().signal));
    return captured;
  }

  test("always sends store:false and stream:true", async () => {
    const body = await captureBody(request());
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test("sends reasoning mode, effort, summary, and context", async () => {
    const body = await captureBody(
      request({
        reasoning: { mode: "pro", effort: "high", summary: "auto", context: "all_turns" },
      }),
    );
    const reasoning = body.reasoning as Record<string, unknown>;
    expect(reasoning.effort).toBe("high");
    expect(reasoning.context).toBe("all_turns");
    expect(reasoning.mode).toBe("pro");
    expect(reasoning.summary).toBe("auto");
  });

  test("omits pro mode for the ChatGPT account backend", async () => {
    const body = await captureBody(
      request({
        model: "gpt-5.6-sol",
        reasoning: { mode: "pro", effort: "high", summary: "auto", context: "current_turn" },
      }),
      { chatGpt: { accountId: "acct" } },
    );

    const reasoning = body.reasoning as Record<string, unknown>;
    expect(reasoning.mode).toBeUndefined();
    expect(reasoning.effort).toBe("high");
  });

  test("omits reasoning summary for a model that does not support it (§10.6)", async () => {
    const body = await captureBody(request({ model: "gpt-5.6-luna" }));
    expect((body.reasoning as Record<string, unknown>).summary).toBeUndefined();
  });

  test("omits the internal no-summary sentinel instead of sending it to the provider", async () => {
    const body = await captureBody(
      request({
        reasoning: { mode: "standard", effort: "medium", summary: "none", context: "current_turn" },
      }),
    );
    expect((body.reasoning as Record<string, unknown>).summary).toBeUndefined();
  });

  test("sends the cache key and an explicit breakpoint", async () => {
    const body = await captureBody(
      request({
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "stable prefix" }],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
        ],
        cache: { key: "capy:v1:a:b:c:d:e", mode: "explicit", breakpoints: [0], ttl: "30m" },
      }),
    );
    expect(body.prompt_cache_key).toBe("capy:v1:a:b:c:d:e");
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content[0]?.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(input[1]?.content[0]?.prompt_cache_breakpoint).toBeUndefined();
  });

  test("sends CBC function schemas alongside safe built-in hosted tools", async () => {
    const body = await captureBody(
      request({
        tools: [
          {
            name: "fs.read",
            description: "read a file",
            parameters: { type: "object", properties: { pattern: { type: "string" }, limit: { type: "integer", default: 200 } }, required: ["pattern"], additionalProperties: false },
            strict: true,
          },
        ],
      }),
    );
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3);
    expect(tools[0]?.type).toBe("function");
    expect(tools.slice(1).map((tool) => tool.type)).toEqual(["web_search", "image_generation"]);
    expect(tools[0]?.strict).toBe(true);
    expect((tools[0]?.parameters as Record<string, unknown>).required).toEqual(["pattern", "limit"]);
    expect(String(tools[0]?.name)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tools[0]?.name).not.toBe("fs.read");
    // No hosted shell, file mutation, computer use, or multi-agent tool types.
    const serialized = JSON.stringify(body);
    for (const forbidden of ["code_interpreter", "computer_use", "local_shell", "file_search"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("keeps internal namespace metadata off individual function tools", async () => {
    const deferredTool = {
      name: "fs.read",
      description: "read a file",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      deferLoading: true,
      namespace: "fs",
      strict: true,
    } as const;

    const disabled = await captureBody(request({ tools: [deferredTool] }));
    const disabledTool = (disabled.tools as Array<Record<string, unknown>>)[0];
    expect(disabledTool?.namespace).toBeUndefined();
    expect(disabledTool?.defer_loading).toBeUndefined();

    const enabled = await captureBody(
      request({ tools: [deferredTool] }),
      { enableToolSearch: true },
    );
    const enabledTool = (enabled.tools as Array<Record<string, unknown>>)[0];
    expect(enabledTool?.type).toBe("function");
    expect(enabledTool?.namespace).toBeUndefined();
    expect(enabledTool?.defer_loading).toBe(true);
  });

  test("supports a per-request Responses hosted-tool override", async () => {
    const body = await captureBody(request({
      hostedTools: [
        { type: "web_search", searchContextSize: "high" },
        { type: "image_generation", quality: "high", outputFormat: "png" },
      ],
    }));
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.type)).toEqual(["web_search", "image_generation"]);
    expect(tools[0]?.search_context_size).toBe("high");
    expect(tools[1]?.quality).toBe("high");
    expect(tools[1]?.output_format).toBe("png");
  });

  test("an empty per-request override disables built-in hosted tools", async () => {
    const body = await captureBody(request({ hostedTools: [] }));
    expect(body.tools).toBeUndefined();
  });

  test("sends hosted tools through ChatGPT by default and honors an explicit disable", async () => {
    const allowed = await captureBody(request(), { chatGpt: { accountId: "acct" } });
    expect((allowed.tools as Array<Record<string, unknown>>).map((tool) => tool.type)).toEqual([
      "web_search",
      "image_generation",
    ]);
    const blocked = await captureBody(request(), {
      chatGpt: { accountId: "acct" },
      allowChatGptHostedTools: false,
    });
    expect(blocked.tools).toBeUndefined();
  });
  test("round trips dotted tool IDs through provider-safe names", async () => {
    let captured: Record<string, unknown> = {};
    let wireName = "";
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async (_url, init) => {
        captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        const tools = captured.tools as Array<Record<string, unknown>>;
        wireName = String(tools[0]?.name);
        return new Response(
          sseStream([
            {
              type: "response.output_item.added",
              item_id: "i1",
              item: { type: "function_call", call_id: "call_new", name: wireName },
              sequence_number: 1,
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "i1",
              arguments: '{"path":"src/a.ts"}',
              sequence_number: 2,
            },
            { type: "response.completed", response: { id: "r" }, sequence_number: 3 },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }) as FetchLike,
    });

    const events = await collect(
      provider.stream(
        request({
          input: [
            {
              type: "function_call",
              callId: "call_old",
              name: "fs.read",
              argumentsText: '{"path":"README.md"}',
            },
            { type: "function_call_output", callId: "call_old", output: "ok" },
          ],
          tools: [
            {
              name: "fs.read",
              description: "read a file",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              strict: true,
            },
          ],
        }),
        new AbortController().signal,
      ),
    );

    const replay = (captured.input as Array<Record<string, unknown>>)[0];
    expect(wireName).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(wireName.length).toBeLessThanOrEqual(64);
    expect(replay?.name).toBe(wireName);
    const completed = events.find(
      (event): event is Extract<ModelEvent, { type: "tool.call.completed" }> =>
        event.type === "tool.call.completed",
    );
    expect(completed?.call.name).toBe("fs.read");
  });

  test("preserves the assistant phase across replay (§10.7)", async () => {
    const body = await captureBody(
      request({
        input: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I'll inspect the path." }],
            phase: "commentary",
          },
        ],
      }),
    );
    expect((body.input as Array<Record<string, unknown>>)[0]?.phase).toBe("commentary");
  });

  test("passes encrypted reasoning through opaquely (§10.6)", async () => {
    const body = await captureBody(
      request({ input: [{ type: "reasoning", opaque: "OPAQUE_BLOB" }] }),
    );
    const item = (body.input as Array<Record<string, unknown>>)[0];
    expect(item?.type).toBe("reasoning");
    expect(item?.encrypted_content).toBe("OPAQUE_BLOB");
  });

  test("sends a safety identifier only when supplied, and it carries no PII", async () => {
    const withId = await captureBody(request({ safetyIdentifier: "a1b2c3d4e5f6" }));
    expect(withId.safety_identifier).toBe("a1b2c3d4e5f6");
    expect(String(withId.safety_identifier)).not.toContain("@");
    const without = await captureBody(request());
    expect(without.safety_identifier).toBeUndefined();
  });
});

describe("HTTP failure handling", () => {
  test("a 429 becomes a retryable rate-limit error with retry-after", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }), {
          status: 429,
          headers: { "retry-after": "3" },
        })) as FetchLike,
    });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("rate_limit");
    expect(failure?.error.retryAfterMs).toBe(3_000);
  });

  test("a 401 is not retryable", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () => new Response("{}", { status: 401 })) as FetchLike,
    });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("authentication");
    expect(failure?.error.retryable).toBe(false);
  });

  test("a network throw becomes a retryable network error", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as FetchLike,
    });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("network");
    expect(failure?.error.retryable).toBe(true);
  });
});

describe("credential validation (§9.4)", () => {
  test("a network failure is not reported as an invalid key", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as FetchLike,
    });
    const result = await provider.validateCredential(fakeLease());
    expect(result.status).toBe("network_error");
  });

  test("a 401 is invalid", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () => new Response("{}", { status: 401 })) as FetchLike,
    });
    expect((await provider.validateCredential(fakeLease())).status).toBe("invalid");
  });

  test("a key without GPT-5.6 access is restricted, not invalid", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 })) as FetchLike,
    });
    const result = await provider.validateCredential(fakeLease());
    expect(result.status).toBe("restricted");
    expect(result.availableModels).toEqual(["gpt-4o"]);
  });

  test("a valid key reports available models and a timestamp", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-5.6" }] }), { status: 200 })) as FetchLike,
    });
    const result = await provider.validateCredential(fakeLease());
    expect(result.status).toBe("valid");
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  test("listModels degrades to the bundled registry when offline (§22.8)", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as FetchLike,
    });
    expect((await provider.listModels()).length).toBe(MODEL_REGISTRY.length);
  });

  test("a network failure reports models as unverified, never reachable (P0-11)", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as FetchLike,
    });
    const report = await provider.listModelsWithAvailability();
    expect(report.length).toBe(MODEL_REGISTRY.length);
    for (const entry of report) {
      expect(entry.availability).toBe("unverified");
    }
  });

  test("a live listing separates reachable from unavailable models (P0-11)", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-4o" }] }), { status: 200 })) as FetchLike,
    });
    const report = await provider.listModelsWithAvailability();
    const byId = new Map(report.map((entry) => [entry.model.id, entry.availability]));
    expect(byId.get("gpt-5.6-sol")).toBe("reachable");
    expect(byId.get("gpt-5.6-terra")).toBe("unavailable");
    expect(byId.get("gpt-5.6-luna")).toBe("unavailable");
    expect(byId.get("gpt-4o")).toBe("reachable");
    expect(report.find((entry) => entry.model.id === "gpt-4o")?.model.contextWindow).toBeUndefined();
  });

  test("the ChatGPT backend reports bundled knowledge as known, not reachable", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      chatGpt: { accountId: "acct", originator: "capybara" },
    });
    const report = await provider.listModelsWithAvailability();
    for (const entry of report) {
      expect(entry.availability).toBe("known");
    }
  });
});

describe("single capability source (P0-11)", () => {
  test("MODEL_REGISTRY is derived from the bundled manifest — no drift possible", () => {
    expect(MODEL_REGISTRY.length).toBe(BUNDLED_CAPABILITY_MANIFEST.snapshots.length);
    for (const descriptor of MODEL_REGISTRY) {
      const snapshot = BUNDLED_CAPABILITY_MANIFEST.snapshots.find(
        (candidate) => candidate.modelId === descriptor.id,
      );
      expect(snapshot).toBeDefined();
      expect(descriptor.contextWindow).toBe(snapshot!.contextWindow);
      expect(descriptor.maxOutputTokens).toBe(snapshot!.maxOutputTokens);
      expect([...descriptor.aliases]).toEqual([...snapshot!.aliases]);
    }
  });

  test("bundled snapshots carry no wall-clock observedAt, so digests are stable", () => {
    for (const snapshot of BUNDLED_CAPABILITY_MANIFEST.snapshots) {
      expect(snapshot.observedAt).toBeUndefined();
      expect(snapshot.source).toBe("bundled");
    }
    // Generation is deterministic: a canonical SHA-256 digest, stable across imports.
    expect(BUNDLED_CAPABILITY_MANIFEST.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mock provider (AC-47)", () => {
  test("scripts a commentary + tool call + final answer sequence", async () => {
    const provider = new MockProvider({
      steps: [
        {
          commentary: "I'll read the file first.",
          toolCalls: [{ callId: "c1", name: "fs.read", arguments: { path: "src/a.ts" } }],
        },
        { text: "Done." },
      ],
    });

    const first = await collect(provider.stream(request(), new AbortController().signal));
    expect(first.some((e) => e.type === "commentary.delta")).toBe(true);
    const call = first.find(
      (e): e is Extract<ModelEvent, { type: "tool.call.completed" }> =>
        e.type === "tool.call.completed",
    );
    expect(call?.call.name).toBe("fs.read");
    expect(JSON.parse(call!.call.argumentsText)).toEqual({ path: "src/a.ts" });

    const second = await collect(provider.stream(request(), new AbortController().signal));
    expect(second.some((e) => e.type === "text.delta")).toBe(true);
    expect(provider.callCount).toBe(2);
  });

  test("records requests so prompt assembly can be asserted", async () => {
    const provider = new MockProvider({ steps: [{ text: "ok" }] });
    await collect(
      provider.stream(request({ reasoning: { mode: "standard", effort: "high", summary: "auto", context: "all_turns" } }), new AbortController().signal),
    );
    expect(provider.lastRequest?.reasoning.effort).toBe("high");
  });

  test("scripts an error", async () => {
    const provider = new MockProvider({
      steps: [
        {
          error: { kind: "rate_limit", message: "429", retryable: true, retryAfterMs: 1_000 },
        },
      ],
    });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("rate_limit");
  });

  test("scripts an incomplete response", async () => {
    const provider = new MockProvider({ steps: [{ text: "partial", incompleteReason: "max_output_tokens" }] });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    expect(events.some((e) => e.type === "response.incomplete")).toBe(true);
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
  });

  test("honours cancellation during a delay", async () => {
    const provider = new MockProvider({ steps: [{ text: "slow", delayMs: 5_000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const events = await collect(provider.stream(request(), controller.signal));
    expect(Date.now() - started).toBeLessThan(2_000);
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.kind).toBe("cancelled");
  });

  test("running out of steps is an explicit failure, not a hang", async () => {
    const provider = new MockProvider({ steps: [{ text: "one" }] });
    await collect(provider.stream(request(), new AbortController().signal));
    const events = await collect(provider.stream(request(), new AbortController().signal));
    const failure = events.find(
      (e): e is Extract<ModelEvent, { type: "response.failed" }> => e.type === "response.failed",
    );
    expect(failure?.error.message).toContain("ran out of scripted steps");
  });

  test("repeatLast keeps a loop-limit test going", async () => {
    const provider = new MockProvider({
      steps: [{ toolCalls: [{ callId: "c", name: "fs.read", arguments: {} }] }],
      repeatLast: true,
    });
    for (let i = 0; i < 5; i += 1) {
      const events = await collect(provider.stream(request(), new AbortController().signal));
      expect(events.some((e) => e.type === "tool.call.completed")).toBe(true);
    }
    expect(provider.callCount).toBe(5);
  });

  test("validates a credential without network access", async () => {
    const provider = new MockProvider({ steps: [] });
    const result = await provider.validateCredential(fakeLease());
    expect(result.status).toBe("valid");
  });

  test("chunked deltas still assemble correctly", async () => {
    const provider = new MockProvider({
      steps: [{ text: "abcdefghij", deltaChunks: 5 }],
    });
    const events = await collect(provider.stream(request(), new AbortController().signal));
    const text = events
      .filter((e): e is Extract<ModelEvent, { type: "text.delta" }> => e.type === "text.delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("abcdefghij");
    expect(events.filter((e) => e.type === "text.delta")).toHaveLength(5);
  });
});

describe("configured request headers", () => {
  async function captureHeaders(
    options: Partial<ConstructorParameters<typeof OpenAiResponsesProvider>[0]> = {},
  ): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      ...options,
      fetchImpl: (async (_url, init) => {
        captured = { ...((init as RequestInit).headers as Record<string, string>) };
        return new Response(sseStream([{ type: "response.completed", response: { id: "r" } }]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as FetchLike,
    });
    await collect(provider.stream(request(), new AbortController().signal));
    return captured;
  }

  test("a deployment header is sent alongside the bearer token", async () => {
    const headers = await captureHeaders({ headers: { "X-Tenant-Id": "tenant-7" } });
    expect(headers["X-Tenant-Id"]).toBe("tenant-7");
    expect(headers.Authorization).toBe(`Bearer ${fakeLease().secret}`);
  });

  test("a configured header cannot replace the credential or the billing selectors", async () => {
    const headers = await captureHeaders({
      organization: "org_real",
      project: "proj_real",
      headers: {
        // Casing varies across configuration sources, so the guard is case-insensitive.
        authorization: "Bearer not-the-lease",
        "OpenAI-Organization": "org_swapped",
        "openai-project": "proj_swapped",
      },
    });
    expect(headers.Authorization).toBe(`Bearer ${fakeLease().secret}`);
    expect(headers["OpenAI-Organization"]).toBe("org_real");
    expect(headers["OpenAI-Project"]).toBe("proj_real");
    // The rejected spellings must not survive as separate entries either.
    expect(headers.authorization).toBeUndefined();
    expect(headers["openai-project"]).toBeUndefined();
  });

  test("no configured headers leaves the request shape unchanged", async () => {
    const headers = await captureHeaders();
    expect(Object.keys(headers).sort()).toEqual(["Accept", "Authorization", "Content-Type"]);
  });
});
describe("ChatGPT account transport", () => {
  test("uses the ChatGPT Responses route and Capybara-owned request contract", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      baseUrl: "https://chatgpt.com/backend-api/codex",
      chatGpt: { accountId: "acct_123", originator: "capybara" },
      headers: {
        "ChatGPT-Account-Id": "acct_attacker",
        originator: "not-capybara",
      },
      fetchImpl: (async (url, init) => {
        capturedUrl = url;
        capturedHeaders = { ...((init as RequestInit).headers as Record<string, string>) };
        capturedBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return new Response(
          sseStream([{ type: "response.completed", response: { id: "r" } }]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }) as FetchLike,
    });

    await collect(
      provider.stream(
        request({
          input: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "stable prefix", cacheBreakpoint: true }],
            },
          ],
          safetyIdentifier: "api-only",
          cache: { key: "cache-only", mode: "explicit", breakpoints: [0], ttl: "30m" },
          previousResponseId: "resp_previous",
        }),
        new AbortController().signal,
      ),
    );

    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(capturedHeaders.Authorization).toBe(`Bearer ${fakeLease().secret}`);
    expect(capturedHeaders["ChatGPT-Account-Id"]).toBe("acct_123");
    expect(capturedHeaders.originator).toBe("capybara");
    expect(capturedHeaders["session-id"]).toBe("req_1");
    expect(capturedHeaders["User-Agent"]).toBe("capybara-code/0.1.0");
    expect(capturedBody.max_output_tokens).toBeUndefined();
    expect(capturedBody.prompt_cache_key).toBeUndefined();
    expect(capturedBody.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(capturedBody)).not.toContain("prompt_cache_breakpoint");
    expect(capturedBody.safety_identifier).toBeUndefined();
    expect(capturedBody.store).toBe(false);
    // The ChatGPT backend-api rejects previous_response_id ("Unsupported
    // parameter"); continuity is carried by the replayed input items instead.
    expect(capturedBody.previous_response_id).toBeUndefined();
  });

  test("sends previous_response_id on the platform transport", async () => {
    let capturedBody: Record<string, unknown> = {};
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async (_url, init) => {
        capturedBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return new Response(
          sseStream([{ type: "response.completed", response: { id: "r" } }]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }) as FetchLike,
    });

    await collect(
      provider.stream(request({ previousResponseId: "resp_previous" }), new AbortController().signal),
    );

    expect(capturedBody.previous_response_id).toBe("resp_previous");
  });

  test("surfaces the provider's real words from non-standard error bodies", async () => {
    const bodies = [
      JSON.stringify({ detail: "Unsupported parameter: previous_response_id" }),
      JSON.stringify({ error: "model is not available" }),
      "plain text gateway failure",
    ];
    for (const body of bodies) {
      const provider = new OpenAiResponsesProvider({
        credential: fakeLease(),
        fetchImpl: (async () =>
          new Response(body, { status: 400, headers: { "Content-Type": "application/json" } })) as FetchLike,
      });
      const events = await collect(provider.stream(request(), new AbortController().signal));
      const failed = events.find((e) => e.type === "response.failed");
      expect(failed).toBeDefined();
      if (failed?.type === "response.failed") {
        expect(failed.error.kind).toBe("invalid_request");
        expect(failed.error.message).not.toBe("provider error");
        expect(failed.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("lists the bundled registry without calling a missing ChatGPT models route", async () => {
    let calls = 0;
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      baseUrl: "https://chatgpt.com/backend-api/codex",
      chatGpt: { accountId: "acct_123" },
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("must not call /models");
      }) as FetchLike,
    });

    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(MODEL_REGISTRY.map((model) => model.id));
    for (const model of models) {
      expect(model.contextWindow).toBe(400_000);
      expect(model.maxOutputTokens).toBe(128_000);
    }
    expect(calls).toBe(0);
  });
});
