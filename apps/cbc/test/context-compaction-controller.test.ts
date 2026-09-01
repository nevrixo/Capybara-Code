import { describe, expect, test } from "bun:test";

import {
  assemblePrompt,
  type CompiledModelRequest,
  type ContextSummaryModel,
  type ContextSummaryRequest,
  type ContextSummaryResult,
} from "@cbc/agent-kernel";
import { defaultConfig } from "@cbc/config-schema";
import { MockProvider, emptyUsage, type ModelInputItem } from "@cbc/provider-openai";
import { EventSequencer, createEvent } from "@cbc/protocol";
import {
  emptyViewModel,
  reduce,
  type ModelCompactionSummaryV2,
  type SessionViewModel,
} from "@cbc/session-domain";
import {
  ContextCompactionController,
  splitHistoryForCompaction,
  type CompactionLifecycleEventKind,
  type ContextCompactionCandidate,
  type ContextCompactionHost,
  type ContextCompactionSnapshot,
} from "../src/context-compaction-controller.ts";

class TestSummaryModel implements ContextSummaryModel {
  calls = 0;
  readonly #invalid: boolean;
  readonly #changeSource: (() => void) | undefined;

  constructor(options: { invalid?: boolean; changeSource?: () => void } = {}) {
    this.#invalid = options.invalid === true;
    this.#changeSource = options.changeSource;
  }

  async summarize(request: ContextSummaryRequest): Promise<ContextSummaryResult> {
    this.calls += 1;
    this.#changeSource?.();
    const bundle = request.sourceBundle;
    const summary: ModelCompactionSummaryV2 = {
      schemaVersion: "2.0",
      sourceDigest: this.#invalid ? "invalid-source" : bundle.sourceDigest,
      goal: bundle.currentGoal?.goal ?? "",
      currentState: "Relevant prior state is summarized.",
      constraints: bundle.userConstraints.map((entry, index) => ({
        text: `User instruction ${index + 1} remains active.`,
        evidenceRefs: entry.evidenceRefs,
      })),
      decisions: bundle.decisions.map((entry) => ({ ...entry })),
      completedWork: bundle.completedWork.map((entry) => ({ ...entry })),
      workspaceChanges: bundle.changedFiles.map((file) => ({
        path: file.path,
        summary: file.diffSummary,
        evidenceRefs: file.evidenceRefs,
      })),
      verification: bundle.verification.map((check) => ({
        command: check.command,
        status: check.status,
        text: check.summary,
        evidenceRefs: check.evidenceRefs,
      })),
      failedApproaches: bundle.failures.map((failure) => ({
        text: failure.summary,
        reason: failure.correctiveAction ?? "retry safely",
        evidenceRefs: failure.evidenceRefs,
      })),
      unresolved: [],
      todos: bundle.todos.map((item) => ({
        ...item,
        blockedReason: item.blockedReason ?? null,
      })),
      approvals: bundle.approvals.map((item) => ({ ...item })),
      pendingQuestionnaire: bundle.pendingQuestionnaire === null
        ? null
        : structuredClone(bundle.pendingQuestionnaire),
      nextAction: bundle.todos.find((item) => item.status === "active")?.text ??
        "continue the current request",
    };
    return {
      ok: true,
      summary,
      rawText: JSON.stringify(summary),
      responseId: `summary-${this.calls}`,
      usage: {
        ...emptyUsage(),
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
  }
}

class TestHost implements ContextCompactionHost {
  readonly events: Array<{ kind: CompactionLifecycleEventKind; payload: Readonly<Record<string, unknown>> }> = [];
  committed: ContextCompactionCandidate | undefined;
  model: SessionViewModel;
  history: ModelInputItem[];
  compactState: string | undefined;
  generation = 0;
  sourceIdentity = "source-1";
  budget = 100_000;

  constructor(model: SessionViewModel, history: ModelInputItem[]) {
    this.model = model;
    this.history = history;
  }

  snapshot(): ContextCompactionSnapshot {
    return {
      model: this.model,
      history: this.history,
      ...(this.compactState === undefined ? {} : { compactState: this.compactState }),
      reflections: [],
      generation: this.generation,
      sourceIdentity: this.sourceIdentity,
      sampledThrough: this.history.length,
      modelId: "gpt-5.6-sol",
      inputBudgetTokens: this.budget,
      modelContextWindowTokens: this.budget + 32_000,
      outputReserveTokens: 32_000,
    };
  }

  preview(input: {
    readonly history: readonly ModelInputItem[];
    readonly compactState?: string;
    readonly generation: number;
    readonly userInput?: string;
  }): CompiledModelRequest {
    return assemblePrompt({
      activeTools: [],
      projectInstructions: [],
      skillCatalog: [],
      loadedSkills: [],
      history: input.history,
      ...(input.compactState === undefined ? {} : { compactState: input.compactState }),
      contextGeneration: input.generation,
      ...(input.userInput === undefined ? {} : { userInput: input.userInput }),
    });
  }

  commit(candidate: ContextCompactionCandidate): void {
    this.committed = candidate;
    this.history = [...candidate.history];
    this.compactState = candidate.compactState;
    this.generation = candidate.generation;
    this.sourceIdentity = `source-${candidate.generation + 1}`;
  }

  emit(
    kind: CompactionLifecycleEventKind,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.events.push({ kind, payload });
  }
}

function sessionFixture(): { model: SessionViewModel; history: ModelInputItem[] } {
  const sequencer = new EventSequencer();
  let model = emptyViewModel("controller");
  const history: ModelInputItem[] = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    const user = `Instruction ${turn}: preserve requirement ${turn}.`;
    model = reduce(model, createEvent(
      sequencer,
      "user.message",
      { text: user },
      { sessionId: model.sessionId },
    ));
    history.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: user }],
    });
    history.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `Prior answer ${turn}: ${"x".repeat(16_000)}` }],
      phase: "final_answer",
    });
  }
  return { model, history };
}

function makeController(
  host: TestHost,
  summaryModel: ContextSummaryModel,
  config = defaultConfig(),
): ContextCompactionController {
  config.model.context.compactionRecentTurns = 1;
  config.model.context.compactionTargetRatio = 0.6;
  return new ContextCompactionController({
    provider: new MockProvider({ steps: [] }),
    host,
    config,
    summaryModel,
  });
}

describe("history compaction split", () => {
  test("keeps recent turns and widens the tail for tool call/output pairs", () => {
    const history: ModelInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old" }],
      },
      { type: "function_call", callId: "pair", name: "fs.read", argumentsText: "{}" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "new" }],
      },
      { type: "function_call_output", callId: "pair", output: "result" },
    ];
    const split = splitHistoryForCompaction(history, 1);
    expect(split.tailStart).toBe(1);
    expect(split.recentTail.map((item) => item.type)).toEqual([
      "function_call",
      "message",
      "function_call_output",
    ]);
  });

  test("pins an incomplete call even when no recent turn is requested", () => {
    const history: ModelInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old" }],
      },
      { type: "function_call", callId: "pending", name: "process.run", argumentsText: "{}" },
    ];
    const split = splitHistoryForCompaction(history, 0);
    expect(split.tailStart).toBe(1);
    expect(split.recentTail).toEqual([history[1]!]);
  });
});

describe("ContextCompactionController", () => {
  test("validates, stages, recompiles, and commits exact model-summary metrics", async () => {
    const fixture = sessionFixture();
    const host = new TestHost(fixture.model, fixture.history);
    const before = host.preview({
      history: host.history,
      generation: 0,
    });
    host.budget = Math.ceil(before.inputTokens / 0.91);
    const summaryModel = new TestSummaryModel();
    const controller = makeController(host, summaryModel);
    const result = await controller.compact({
      prompt: before,
      signal: new AbortController().signal,
      trigger: "ratio",
      pressureState: "compact",
      reasonCodes: ["current_trigger_ratio"],
    });
    expect(result.kind).toBe("compacted");
    expect(summaryModel.calls).toBe(1);
    expect(host.committed?.receipt.strategy).toBe("model_summary");
    expect(host.committed?.receipt.compiledTokensAfter).toBe(
      host.committed?.compiled.inputTokens,
    );
    expect(host.committed?.receipt.summaryTokens).not.toBe(
      host.committed?.receipt.compiledTokensAfter,
    );
    expect(host.committed?.receipt.ratioBefore).toBeGreaterThanOrEqual(0.9);
    expect(host.committed?.history.length).toBeLessThan(fixture.history.length);
    expect(host.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "context.compaction_prepared",
        "context.compaction_started",
        "context.compaction_model_completed",
      ]),
    );
  });

  test("preserves old history below 97 percent when validation fails", async () => {
    const fixture = sessionFixture();
    const host = new TestHost(fixture.model, fixture.history);
    const original = structuredClone(host.history);
    const before = host.preview({ history: host.history, generation: 0 });
    host.budget = Math.ceil(before.inputTokens / 0.91);
    const summaryModel = new TestSummaryModel({ invalid: true });
    const controller = makeController(host, summaryModel);
    const first = await controller.compact({
      prompt: before,
      signal: new AbortController().signal,
      trigger: "ratio",
      pressureState: "compact",
    });
    const second = await controller.compact({
      prompt: before,
      signal: new AbortController().signal,
      trigger: "ratio",
      pressureState: "compact",
    });
    expect(first.kind).toBe("aborted");
    expect(second.kind).toBe("aborted");
    expect(summaryModel.calls).toBe(1);
    expect(host.committed).toBeUndefined();
    expect(host.history).toEqual(original);
    expect(host.events.some((event) =>
      event.kind === "context.compaction_validation_failed")).toBe(true);
  });

  test("uses deterministic fallback only at the emergency boundary", async () => {
    const fixture = sessionFixture();
    const host = new TestHost(fixture.model, fixture.history);
    const before = host.preview({ history: host.history, generation: 0 });
    host.budget = Math.ceil(before.inputTokens / 0.98);
    const controller = makeController(host, new TestSummaryModel({ invalid: true }));
    const result = await controller.compact({
      prompt: before,
      signal: new AbortController().signal,
      trigger: "ratio",
      pressureState: "emergency",
    });
    expect(result.kind).toBe("compacted");
    expect(host.committed?.receipt.strategy).toBe("deterministic_fallback");
    expect(host.committed?.receipt.fallbackUsed).toBe(true);
  });

  test("aborts atomically when the source identity changes during the model call", async () => {
    const fixture = sessionFixture();
    const host = new TestHost(fixture.model, fixture.history);
    const original = structuredClone(host.history);
    const before = host.preview({ history: host.history, generation: 0 });
    host.budget = Math.ceil(before.inputTokens / 0.91);
    const controller = makeController(
      host,
      new TestSummaryModel({ changeSource: () => { host.sourceIdentity = "changed"; } }),
    );
    const result = await controller.compact({
      prompt: before,
      signal: new AbortController().signal,
      trigger: "ratio",
      pressureState: "compact",
    });
    expect(result).toMatchObject({
      kind: "aborted",
      reasonCodes: ["source_generation_changed"],
    });
    expect(host.committed).toBeUndefined();
    expect(host.history).toEqual(original);
  });
});
