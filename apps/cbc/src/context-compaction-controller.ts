import { createHash } from "node:crypto";

import {
  ProviderContextSummaryModel,
  type CompiledModelRequest,
  type ContextSummaryModel,
  type ContextSummaryResult,
} from "@cbc/agent-kernel";
import type { CbcConfig, ReasoningEffort } from "@cbc/config-schema";
import type {
  ModelInputItem,
  ModelProvider,
  ModelUsage,
  ProviderError,
} from "@cbc/provider-openai";
import {
  buildCompactionSourceBundle,
  calculateSummaryBudget,
  compactDeterministicFallback,
  compactionSummaryDigest,
  estimateTokens,
  renderCompactState,
  renderModelCompactionSummary,
  validateModelCompactionSummary,
  type CompactionCapsule,
  type CompactionReceiptTrigger,
  type CompactionReceiptV2,
  type CompactionReflection,
  type CompactionSourceBundle,
  type CompactionStrategy,
  type GoalContract,
  type GoalEvaluation,
  type ModelCompactionSummaryV2,
  type SessionViewModel,
} from "@cbc/session-domain";

export type CompactionLifecycleEventKind =
  | "context.compaction_prepared"
  | "context.compaction_started"
  | "context.compaction_model_completed"
  | "context.compaction_validation_failed"
  | "context.compaction_committed"
  | "context.compaction_aborted"
  | "context.compaction_target_missed";

export interface ContextCompactionSnapshot {
  readonly model: SessionViewModel;
  readonly history: readonly ModelInputItem[];
  readonly compactState?: string;
  readonly currentGoal?: GoalContract;
  readonly goalEvaluation?: GoalEvaluation;
  readonly reflections: readonly CompactionReflection[];
  readonly generation: number;
  readonly sourceIdentity: string;
  readonly sampledThrough?: number;
  readonly modelId: string;
  readonly inputBudgetTokens: number;
  readonly modelContextWindowTokens: number;
  readonly outputReserveTokens: number;
}

export interface ContextCompactionCandidate {
  readonly history: readonly ModelInputItem[];
  readonly compactState?: string;
  readonly capsule?: CompactionCapsule;
  readonly generation: number;
  readonly strategy: CompactionStrategy;
  readonly receipt: CompactionReceiptV2;
  readonly compiled: CompiledModelRequest;
  readonly providerUsage?: ModelUsage;
  readonly providerResponseId?: string;
  readonly providerOpaque?: string;
}

export interface ContextCompactionHost {
  snapshot(): ContextCompactionSnapshot;
  preview(input: {
    readonly history: readonly ModelInputItem[];
    readonly compactState?: string;
    readonly generation: number;
    readonly userInput?: string;
  }): CompiledModelRequest;
  commit(candidate: ContextCompactionCandidate): void | Promise<void>;
  emit(kind: CompactionLifecycleEventKind, payload: Readonly<Record<string, unknown>>): void;
}

export interface ContextCompactionRequest {
  readonly prompt: CompiledModelRequest;
  readonly userInput?: string;
  readonly signal: AbortSignal;
  readonly trigger: CompactionReceiptTrigger;
  readonly pressureState: "compact" | "emergency" | "hard_emergency";
  readonly reasonCodes?: readonly string[];
  readonly forceStrategy?: CbcConfig["model"]["context"]["compactionStrategy"];
}

export type ContextCompactionOutcome =
  | {
      readonly kind: "compacted";
      readonly receipt: CompactionReceiptV2;
      readonly itemsBefore: number;
      readonly itemsAfter: number;
      readonly providerUsage?: ModelUsage;
    }
  | { readonly kind: "nothing" }
  | { readonly kind: "busy" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "aborted";
      readonly error?: ProviderError;
      readonly reasonCodes: readonly string[];
    };

interface StagedSummary {
  readonly strategy: CompactionStrategy;
  readonly history: readonly ModelInputItem[];
  readonly compactState?: string;
  readonly capsule?: CompactionCapsule;
  readonly summaryTokens: number;
  readonly summaryDigest: string;
  readonly providerUsage?: ModelUsage;
  readonly providerResponseId?: string;
  readonly providerOpaque?: string;
}

export interface HistoryCompactionSplit {
  readonly prefix: readonly ModelInputItem[];
  readonly recentTail: readonly ModelInputItem[];
  readonly tailStart: number;
}

interface StageSummaryInput {
  readonly configuredStrategy: CbcConfig["model"]["context"]["compactionStrategy"];
  readonly request: ContextCompactionRequest;
  readonly snapshot: ContextCompactionSnapshot;
  readonly split: HistoryCompactionSplit;
  readonly bundle: CompactionSourceBundle;
  readonly generation: number;
  readonly summaryBudgetTokens: number;
}

type StageSummaryResult =
  | { readonly kind: "ready"; readonly value: StagedSummary }
  | {
      readonly kind: "failed";
      readonly reasonCodes: readonly string[];
      readonly error?: ProviderError;
    };

export function splitHistoryForCompaction(
  history: readonly ModelInputItem[],
  recentTurns: number,
  sampledThrough?: number,
): HistoryCompactionSplit {
  const requestedTurns = Math.max(0, Math.floor(recentTurns));
  const userIndexes = history.flatMap((item, index) =>
    item.type === "message" && item.role === "user" ? [index] : []);
  let tailStart = requestedTurns === 0 || userIndexes.length === 0
    ? history.length
    : userIndexes[Math.max(0, userIndexes.length - requestedTurns)] ?? history.length;
  if (sampledThrough !== undefined && sampledThrough >= 0) {
    tailStart = Math.min(tailStart, Math.min(history.length, Math.floor(sampledThrough)));
  }
  const calls = new Map<string, number>();
  const outputs = new Map<string, number>();
  history.forEach((item, index) => {
    if (item.type === "function_call" || item.type === "program") calls.set(item.callId, index);
    if (item.type === "function_call_output" || item.type === "program_output") {
      outputs.set(item.callId, index);
    }
  });
  for (const [callId, callIndex] of calls) {
    const outputIndex = outputs.get(callId);
    if (outputIndex === undefined) tailStart = Math.min(tailStart, callIndex);
    else if (callIndex < tailStart && outputIndex >= tailStart) tailStart = callIndex;
  }
  return {
    prefix: history.slice(0, tailStart),
    recentTail: history.slice(tailStart),
    tailStart,
  };
}

export class ContextCompactionController {
  readonly #provider: ModelProvider;
  readonly #summaryModel: ContextSummaryModel;
  readonly #host: ContextCompactionHost;
  readonly #config: CbcConfig;
  readonly #attempts = new Map<number, number>();
  #active = false;

  constructor(options: {
    readonly provider: ModelProvider;
    readonly host: ContextCompactionHost;
    readonly config: CbcConfig;
    readonly summaryModel?: ContextSummaryModel;
  }) {
    this.#provider = options.provider;
    this.#host = options.host;
    this.#config = options.config;
    this.#summaryModel = options.summaryModel ?? new ProviderContextSummaryModel(options.provider);
  }

  async compact(request: ContextCompactionRequest): Promise<ContextCompactionOutcome> {
    if (this.#active) return { kind: "busy" };
    if (!this.#config.experimental.contextCompactionV2) return { kind: "disabled" };
    const configuredStrategy = request.forceStrategy ??
      this.#config.model.context.compactionStrategy;
    if (configuredStrategy === "off") return { kind: "disabled" };
    const snapshot = this.#host.snapshot();
    const split = splitHistoryForCompaction(
      snapshot.history,
      this.#config.model.context.compactionRecentTurns,
      snapshot.sampledThrough,
    );
    if (split.prefix.length === 0 && snapshot.compactState === undefined) {
      return { kind: "nothing" };
    }

    this.#active = true;
    try {
      const bundle = buildCompactionSourceBundle(snapshot.model, {
        ...(snapshot.currentGoal === undefined ? {} : { currentGoal: snapshot.currentGoal }),
        ...(snapshot.goalEvaluation === undefined
          ? {}
          : { goalEvaluation: snapshot.goalEvaluation }),
        generation: snapshot.generation,
        transcriptPrefix: sanitizeTranscript(split.prefix),
        recentTail: sanitizeTranscript(split.recentTail),
        ...(snapshot.compactState === undefined
          ? {}
          : { priorCompactState: snapshot.compactState }),
        reflections: snapshot.reflections,
      });
      const targetCompiledTokens = Math.max(
        1_024,
        Math.floor(
          snapshot.inputBudgetTokens *
          this.#config.model.context.compactionTargetRatio,
        ),
      );
      let fixedPrompt: CompiledModelRequest;
      try {
        fixedPrompt = this.#host.preview({
          history: split.recentTail,
          generation: snapshot.generation + 1,
          ...(request.userInput === undefined ? {} : { userInput: request.userInput }),
        });
      } catch (error) {
        return this.#abort(
          request,
          ["staged_fixed_compile_failed"],
          internalError(error),
        );
      }
      const budget = calculateSummaryBudget({
        targetCompiledTokens,
        fixedTokens: fixedPrompt.inputTokens,
      });
      const compressiblePrefixTokens = Math.max(
        0,
        request.prompt.inputTokens - fixedPrompt.inputTokens,
      );
      this.#host.emit("context.compaction_prepared", {
        generation: snapshot.generation,
        sourceDigest: bundle.sourceDigest,
        compiledTokensBefore: request.prompt.inputTokens,
        compressiblePrefixTokens,
        fixedTokens: fixedPrompt.inputTokens,
        targetCompiledTokens,
        summaryBudgetTokens: budget.summaryBudgetTokens,
        trigger: request.trigger,
      });
      if (budget.irreducible) {
        this.#host.emit("context.compaction_target_missed", {
          generation: snapshot.generation,
          targetCompiledTokens,
          fixedTokens: fixedPrompt.inputTokens,
          reasonCodes: ["irreducible_prompt_floor"],
        });
        return this.#abort(request, ["irreducible_prompt_floor"]);
      }

      const generation = snapshot.generation + 1;
      this.#host.emit("context.compaction_started", {
        generation,
        strategy: configuredStrategy,
        model: this.#compactionModel(snapshot.modelId),
        compiledTokensBefore: request.prompt.inputTokens,
        inputBudgetTokens: snapshot.inputBudgetTokens,
        trigger: request.trigger,
      });
      const staged = await this.#stageSummary({
        configuredStrategy,
        request,
        snapshot,
        split,
        bundle,
        generation,
        summaryBudgetTokens: budget.summaryBudgetTokens,
      });
      if (staged.kind === "failed") {
        return this.#abort(request, staged.reasonCodes, staged.error);
      }
      if (this.#host.snapshot().sourceIdentity !== snapshot.sourceIdentity) {
        return this.#abort(request, ["source_generation_changed"]);
      }

      let compiled: CompiledModelRequest;
      try {
        compiled = this.#host.preview({
          history: staged.value.history,
          ...(staged.value.compactState === undefined
            ? {}
            : { compactState: staged.value.compactState }),
          generation,
          ...(request.userInput === undefined ? {} : { userInput: request.userInput }),
        });
      } catch (error) {
        return this.#abort(
          request,
          ["staged_history_compile_failed"],
          internalError(error),
        );
      }
      const targetMet = compiled.inputTokens <= targetCompiledTokens;
      const reasonCodes = [
        ...(request.reasonCodes ?? []),
        ...(targetMet ? [] : ["target_compiled_ratio_missed"]),
      ];
      const receipt: CompactionReceiptV2 = {
        schemaVersion: "2.0",
        strategy: staged.value.strategy,
        trigger: request.trigger,
        inputBudgetTokens: snapshot.inputBudgetTokens,
        modelContextWindowTokens: snapshot.modelContextWindowTokens,
        outputReserveTokens: snapshot.outputReserveTokens,
        compiledTokensBefore: request.prompt.inputTokens,
        compressiblePrefixTokens,
        summaryTokens: staged.value.summaryTokens,
        compiledTokensAfter: compiled.inputTokens,
        ratioBefore: request.prompt.inputTokens / snapshot.inputBudgetTokens,
        ratioAfter: compiled.inputTokens / snapshot.inputBudgetTokens,
        targetRatio: this.#config.model.context.compactionTargetRatio,
        sourceDigest: bundle.sourceDigest,
        summaryDigest: staged.value.summaryDigest,
        generation,
        fallbackUsed: staged.value.strategy === "deterministic_fallback",
        targetMet,
        reasonCodes,
      };
      if (!targetMet) {
        this.#host.emit("context.compaction_target_missed", {
          receipt,
          targetCompiledTokens,
          reasonCodes,
        });
      }
      await this.#host.commit({
        ...staged.value,
        generation,
        receipt,
        compiled,
      });
      return {
        kind: "compacted",
        receipt,
        itemsBefore: snapshot.history.length,
        itemsAfter: staged.value.history.length,
        ...(staged.value.providerUsage === undefined
          ? {}
          : { providerUsage: staged.value.providerUsage }),
      };
    } finally {
      this.#active = false;
    }
  }

  async #stageSummary(input: StageSummaryInput): Promise<StageSummaryResult> {
    const emergency =
      input.request.pressureState === "emergency" ||
      input.request.pressureState === "hard_emergency" ||
      input.request.trigger === "provider_context_error";
    let lastError: ProviderError | undefined;
    const reasons: string[] = [];
    if (
      input.configuredStrategy === "provider-native" ||
      input.configuredStrategy === "hybrid"
    ) {
      const provider = await this.#stageProviderNative(input);
      if (provider.kind === "ready") return provider;
      lastError = provider.error;
      reasons.push(...provider.reasonCodes);
      if (input.configuredStrategy === "provider-native" && !emergency) {
        return provider;
      }
    }
    if (
      input.configuredStrategy === "model-summary" ||
      input.configuredStrategy === "hybrid"
    ) {
      const model = await this.#stageModelSummary(input);
      if (model.kind === "ready") return model;
      lastError = model.error ?? lastError;
      reasons.push(...model.reasonCodes);
    }
    if (
      emergency &&
      this.#config.model.context.compactionFallback === "evidence-ledger"
    ) {
      return {
        kind: "ready",
        value: this.#stageDeterministicFallback(input),
      };
    }
    return {
      kind: "failed",
      reasonCodes: [...new Set(reasons.length > 0 ? reasons : ["compaction_strategy_failed"])],
      ...(lastError === undefined ? {} : { error: lastError }),
    };
  }

  async #stageProviderNative(input: StageSummaryInput): Promise<StageSummaryResult> {
    const compact = this.#provider.compact;
    if (compact === undefined) {
      return {
        kind: "failed",
        reasonCodes: ["provider_compaction_unsupported"],
        error: {
          kind: "invalid_request",
          message: `${this.#provider.id} does not expose provider context compaction`,
          retryable: false,
        },
      };
    }
    const providerInput: ModelInputItem[] = [
      ...(input.snapshot.compactState === undefined
        ? []
        : [{
            type: "message" as const,
            role: "developer" as const,
            content: [{
              type: "input_text" as const,
              text: [
                "Prior verified session state to preserve during provider compaction:",
                input.snapshot.compactState,
              ].join("\n\n"),
            }],
          }]),
      ...input.snapshot.history.map((item) => structuredClone(item)),
    ];
    let result: Awaited<ReturnType<NonNullable<ModelProvider["compact"]>>>;
    try {
      result = await compact.call(this.#provider, {
        requestId: `compact_${input.snapshot.model.sessionId}_${input.generation}`,
        model: input.snapshot.modelId,
        input: providerInput,
        tools: [],
        serviceTier: this.#config.provider.openai.serviceTier,
      }, input.request.signal);
    } catch (error) {
      return {
        kind: "failed",
        reasonCodes: ["provider_compaction_exception"],
        error: input.request.signal.aborted
          ? cancelledError()
          : internalError(error, "network"),
      };
    }
    if (!result.ok) {
      return {
        kind: "failed",
        reasonCodes: ["provider_compaction_failed"],
        error: result.error,
      };
    }
    const opaque = result.output.findLast((item) => item.type === "compaction");
    if (opaque?.type !== "compaction" || opaque.opaque.length === 0) {
      return {
        kind: "failed",
        reasonCodes: ["provider_compaction_missing_opaque"],
        error: {
          kind: "server",
          message: "provider compaction returned no opaque continuation item",
          retryable: true,
        },
      };
    }
    return {
      kind: "ready",
      value: {
        strategy: "provider_native",
        history: result.output,
        summaryTokens: estimateTokens(JSON.stringify(result.output)),
        summaryDigest: hash(result.output),
        providerUsage: result.usage,
        providerResponseId: result.responseId,
        providerOpaque: opaque.opaque,
      },
    };
  }

  async #stageModelSummary(input: StageSummaryInput): Promise<StageSummaryResult> {
    const attempts = this.#attempts.get(input.snapshot.generation) ?? 0;
    const maximum = this.#config.model.context.compactionMaxAttemptsPerGeneration;
    if (attempts >= maximum) {
      return {
        kind: "failed",
        reasonCodes: ["model_attempt_limit_reached"],
      };
    }
    this.#attempts.set(input.snapshot.generation, attempts + 1);
    const effort = this.#config.model.context.compactionReasoningEffort as ReasoningEffort;
    let result: ContextSummaryResult;
    try {
      result = await this.#summaryModel.summarize({
        requestId: `summary_${input.snapshot.model.sessionId}_${input.generation}_${attempts + 1}`,
        model: this.#compactionModel(input.snapshot.modelId),
        reasoningEffort: effort,
        maxOutputTokens: Math.max(
          256,
          Math.min(
            this.#config.model.maxOutputTokens,
            Math.max(1_024, input.summaryBudgetTokens * 2),
          ),
        ),
        summaryTokenBudget: input.summaryBudgetTokens,
        sourceBundle: input.bundle,
        signal: input.request.signal,
      });
    } catch (error) {
      return {
        kind: "failed",
        reasonCodes: ["model_summary_exception"],
        error: input.request.signal.aborted
          ? cancelledError()
          : internalError(error, "network"),
      };
    }
    if (!result.ok) {
      return {
        kind: "failed",
        reasonCodes: ["model_summary_failed"],
        error: result.error,
      };
    }
    this.#host.emit("context.compaction_model_completed", {
      generation: input.generation,
      model: this.#compactionModel(input.snapshot.modelId),
      responseId: result.responseId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    const validation = validateModelCompactionSummary(
      result.summary,
      input.bundle,
      {
        estimateTokens,
        summaryBudgetTokens: input.summaryBudgetTokens,
        expectedGeneration: input.snapshot.generation,
      },
    );
    if (!validation.valid) {
      this.#host.emit("context.compaction_validation_failed", {
        generation: input.generation,
        sourceDigest: input.bundle.sourceDigest,
        issues: validation.issues,
      });
      return {
        kind: "failed",
        reasonCodes: [
          "model_summary_validation_failed",
          ...validation.issues.map((issue) => issue.code),
        ],
      };
    }
    const compactState = renderModelCompactionSummary(validation.value);
    const summaryTokens = estimateTokens(compactState);
    return {
      kind: "ready",
      value: {
        strategy: "model_summary",
        history: input.split.recentTail,
        compactState,
        capsule: modelSummaryCapsule(
          validation.value,
          input.bundle,
          input.generation,
          summaryTokens,
        ),
        summaryTokens,
        summaryDigest: compactionSummaryDigest(validation.value),
        providerUsage: result.usage,
        ...(result.responseId === undefined ? {} : { providerResponseId: result.responseId }),
      },
    };
  }

  #stageDeterministicFallback(input: StageSummaryInput): StagedSummary {
    const trigger = input.request.trigger === "manual"
      ? "manual"
      : input.request.trigger === "provider_context_error"
        ? "provider_context_error"
        : input.request.pressureState === "compact"
          ? "projected_pressure"
          : "emergency_pressure";
    const result = compactDeterministicFallback(
      input.snapshot.model,
      trigger,
      estimateTokens,
      {
        targetTokens: input.summaryBudgetTokens,
        currentTokens: input.request.prompt.inputTokens,
        generation: input.generation,
        ...(input.bundle.currentGoal === null
          ? {}
          : { currentGoal: input.bundle.currentGoal.goal }),
        userConstraints: input.bundle.userConstraints.map((entry) => entry.text),
        evidenceRefs: input.bundle.evidenceCatalog.map((entry) => entry.id),
        reflections: input.snapshot.reflections,
      },
    );
    const compactState = renderCompactState(result.state);
    return {
      strategy: "deterministic_fallback",
      history: input.split.recentTail,
      compactState,
      capsule: result.capsule,
      summaryTokens: result.capsuleTokens,
      summaryDigest: result.capsule.digest,
    };
  }

  #compactionModel(activeModel: string): string {
    const configured = this.#config.model.context.compactionModel;
    return configured === "same" ? activeModel : configured;
  }

  #abort(
    request: ContextCompactionRequest,
    reasonCodes: readonly string[],
    error?: ProviderError,
  ): ContextCompactionOutcome {
    this.#host.emit("context.compaction_aborted", {
      trigger: request.trigger,
      reasonCodes,
      ...(error === undefined ? {} : { error: error.message, errorKind: error.kind }),
    });
    return {
      kind: "aborted",
      ...(error === undefined ? {} : { error }),
      reasonCodes,
    };
  }
}

function sanitizeTranscript(items: readonly ModelInputItem[]): unknown[] {
  return items.map((item) => {
    if (item.type === "reasoning") {
      return {
        type: "reasoning",
        opaquePresent: item.opaque.length > 0,
        ...(item.summaryText === undefined ? {} : { summaryText: item.summaryText }),
      };
    }
    if (item.type === "compaction") {
      return { type: "compaction", opaquePresent: item.opaque.length > 0 };
    }
    return structuredClone(item);
  });
}

function modelSummaryCapsule(
  summary: ModelCompactionSummaryV2,
  bundle: CompactionSourceBundle,
  generation: number,
  tokenCount: number,
): CompactionCapsule {
  const digest = compactionSummaryDigest(summary);
  const evidenceRefs = [
    ...summary.constraints.flatMap((entry) => entry.evidenceRefs),
    ...summary.decisions.flatMap((entry) => entry.evidenceRefs),
    ...summary.completedWork.flatMap((entry) => entry.evidenceRefs),
    ...summary.workspaceChanges.flatMap((entry) => entry.evidenceRefs),
    ...summary.verification.flatMap((entry) => entry.evidenceRefs),
    ...summary.failedApproaches.flatMap((entry) => entry.evidenceRefs),
    ...summary.unresolved.flatMap((entry) => entry.evidenceRefs),
    ...summary.approvals.flatMap((entry) => entry.evidenceRefs),
    ...(summary.pendingQuestionnaire?.evidenceRefs ?? []),
  ];
  return {
    id: `capsule-${generation}-${digest.slice(0, 16)}`,
    generation,
    sourceRange: bundle.sourceRange,
    goal: summary.goal,
    decisions: summary.decisions.map((entry) => entry.text),
    mutations: summary.workspaceChanges.map((change) => ({
      path: change.path,
      summary: change.summary,
    })),
    verification: summary.verification.map((check) =>
      `[${check.status}] ${check.command ?? "verification"}: ${check.text}`),
    unresolved: [
      ...summary.failedApproaches.map((failure) =>
        `${failure.text}: ${failure.reason}`),
      ...summary.unresolved.map((item) =>
        `${item.text}${item.nextAction ? ` — next: ${item.nextAction}` : ""}`),
    ],
    todoSnapshot: summary.todos.map((item) => ({
      id: item.id,
      text: item.text,
      status: item.status,
      ...(item.blockedReason === null ? {} : { blockedReason: item.blockedReason }),
    })),
    evidenceRefs: [...new Set(evidenceRefs)],
    tokenCount,
    digest,
    narrativeHint: "model_summary",
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function internalError(
  error: unknown,
  kind: ProviderError["kind"] = "unknown",
): ProviderError {
  return {
    kind,
    message: error instanceof Error ? error.message : String(error),
    retryable: kind === "network" || kind === "server",
  };
}

function cancelledError(): ProviderError {
  return {
    kind: "cancelled",
    message: "context compaction was cancelled",
    retryable: false,
  };
}
