/**
 * Provider boundary — PRD §10.1, §10.2, §19.4, Appendix B.2.
 *
 * §10.1: "OpenAI SDK object와 event type을 agent domain 바깥으로 노출하지
 * 않는다." Nothing in this file references an OpenAI wire type; the adapter in
 * `openai.ts` is the only place that knows the Responses API shape.
 *
 * P1-05: the model-neutral domain types (reasoning vocabulary, usage, model
 * metadata, budgets, pricing shape) live in `@cbc/inference-domain`. This
 * module imports them for its own interfaces and re-exports them so existing
 * `@cbc/provider-openai` call sites keep working.
 */

import {
  PRICING_REGISTRY_VERSION,
  SOFT_CONTEXT_BUDGETS,
  emptyUsage,
} from "@cbc/inference-domain";
import type {
  ModelAvailability,
  ModelAvailabilityReport,
  ModelDescriptor,
  ModelUsage,
  PriceEntry,
  ReasoningContextScope,
  ReasoningEffort,
  ReasoningMode,
} from "@cbc/inference-domain";

export { PRICING_REGISTRY_VERSION, SOFT_CONTEXT_BUDGETS, emptyUsage };
export type {
  ModelAvailability,
  ModelAvailabilityReport,
  ModelDescriptor,
  ModelUsage,
  PriceEntry,
  ReasoningContextScope,
  ReasoningEffort,
  ReasoningMode,
};

export type AssistantPhase = "commentary" | "final_answer";
/** Provider-neutral visible Thinking fragment; wire channel names stay adapter-local. */
export type ThinkingChannel = "detail" | "summary";
export type ThinkingBoundary = "tool" | "final" | "response_end" | "interrupted" | "failed";
export type ProviderThinkingFragment =
  | {
      readonly kind: "delta" | "replace";
      readonly channel: ThinkingChannel;
      readonly text: string;
      readonly requestId: string;
      readonly responseId?: string;
      readonly providerItemId?: string;
      readonly outputIndex?: number;
      readonly sequence?: number;
      readonly deltaId?: string;
      readonly authoritative?: boolean;
    }
  | {
      readonly kind: "boundary";
      readonly boundary: ThinkingBoundary;
      readonly requestId: string;
    };

export type ProviderTransport = "http_full" | "http_previous" | "websocket";

/** Caller linkage returned by Programmatic Tool Calling. */
export interface ModelToolCaller {
  readonly type: "program";
  readonly callerId: string;
}

export interface ProviderCapabilities {
  readonly websocket: boolean;
  readonly previousResponse: boolean;
  readonly parallelToolCalls: boolean;
  readonly nativeCompaction: boolean;
  readonly fastTier: boolean;
  readonly toolSearch: boolean;
}

/** Provider-hosted calls surfaced to the kernel for progress and durable outputs. */
export type HostedToolCallName = "web_search" | "image_generation";

export interface GeneratedImageOutput {
  readonly base64: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly outputFormat: "png" | "jpeg" | "webp";
  readonly revisedPrompt?: string;
}

/** §10.2 normalized model events. */
export type ModelEvent =
  | { type: "response.started"; requestId: string; connectionReused?: boolean }
  | { type: "response.created"; responseId: string }
  /** `authoritative` marks a completed output item suitable for delta recovery. */
  | { type: "response.item"; item: ModelResponseItem; authoritative?: true }
  | { type: "commentary.delta"; text: string; itemId?: string; outputIndex?: number }
  | { type: "reasoning.text.delta"; text: string; itemId?: string; outputIndex?: number; sequence?: number; deltaId?: string }
  | { type: "reasoning.text.done"; text: string; itemId?: string; outputIndex?: number; sequence?: number; deltaId?: string }
  | { type: "reasoning.summary.delta"; text: string; itemId?: string; outputIndex?: number; sequence?: number; deltaId?: string }
  | { type: "text.delta"; text: string; itemId?: string; outputIndex?: number }
  | { type: "tool.call.started"; callId: string; name: string; caller?: ModelToolCaller; callerId?: string; programId?: string; agentId?: string }
  | { type: "tool.call.arguments.delta"; callId: string; delta: string }
  | { type: "tool.call.completed"; call: ModelToolCall }
  | { type: "hosted.tool.started"; callId: string; name: HostedToolCallName; display: string }
  | { type: "hosted.tool.completed"; callId: string; name: HostedToolCallName; summary: string; image?: GeneratedImageOutput }
  | { type: "hosted.tool.failed"; callId: string; name: HostedToolCallName; message: string }
  | { type: "usage"; usage: ModelUsage }
  | { type: "response.completed"; responseId: string }
  | { type: "response.incomplete"; reason: string; responseId?: string }
  | { type: "transport.fallback"; from: ProviderTransport; to: ProviderTransport; reason: string }
  | { type: "response.failed"; error: ProviderError };

export type ModelResponseItemKind =
  | "message"
  | "function_call"
  | "function_call_output"
  | "reasoning"
  | "compaction"
  | "program"
  | "program_output"
  | "unknown";

/** Provider response item metadata preserved for ordered, opaque replay. */
export interface ModelResponseItem {
  readonly kind: ModelResponseItemKind;
  readonly itemId: string;
  readonly sequence?: number;
  readonly callId?: string;
  readonly name?: string;
  readonly argumentsText?: string;
  readonly output?: string;
  readonly code?: string;
  readonly fingerprint?: string;
  readonly result?: string;
  readonly status?: "completed" | "incomplete";
  readonly text?: string;
  readonly phase?: AssistantPhase;
  /** Encrypted/opaque provider content; never rendered or exported by CBC. */
  readonly opaque?: string;
  /** Provider-visible reasoning text, retained for display but never prompt replay. */
  readonly reasoningText?: string;
  readonly summaryText?: string;
  readonly rawType?: string;
  readonly caller?: ModelToolCaller;
  readonly callerId?: string;
  readonly programId?: string;
  readonly agentId?: string;
}
export interface ModelToolCall {
  readonly caller?: ModelToolCaller;
  readonly callerId?: string;
  readonly programId?: string;
  readonly agentId?: string;
  readonly callId: string;
  readonly name: string;
  /** Raw argument text as streamed. Parsing and validation happen in the kernel. */
  readonly argumentsText: string;
}

export type ProviderErrorKind =
  | "authentication"
  | "rate_limit"
  | "invalid_request"
  | "server"
  | "network"
  | "cancelled"
  | "content_policy"
  | "context_length"
  | "unknown";

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly code?: string;
}

/**
 * §10.6 stateless replay: every output item is preserved with its order and
 * provider linkage, and encrypted reasoning is opaque.
 */
export type ModelInputItem =
  | { type: "message"; role: "developer" | "user" | "assistant"; content: ModelContentPart[]; phase?: AssistantPhase }
  | { type: "function_call"; itemId?: string; callId: string; name: string; argumentsText: string; caller?: ModelToolCaller; callerId?: string; programId?: string; agentId?: string }
  | { type: "function_call_output"; itemId?: string; callId: string; output: string; caller?: ModelToolCaller; callerId?: string; programId?: string; agentId?: string }
  | { type: "reasoning"; opaque: string; summaryText?: string }
  | { type: "compaction"; opaque: string }
  | ModelProgramInputItem;

/** Provider-owned PTC output items accepted only for exact stateless replay. */
export type ModelProgramInputItem =
  | { type: "program"; itemId: string; callId: string; code: string; fingerprint: string }
  | { type: "program_output"; itemId: string; callId: string; result: string; status: "completed" | "incomplete" };

export type ModelContentPart =
  | { type: "input_text"; text: string; cacheBreakpoint?: boolean }
  | { type: "output_text"; text: string };

/** Provider-hosted tools available on the Responses API surface. */
export type HostedTool =
  | {
      /** `web_search_preview` remains accepted for older compatible endpoints. */
      readonly type: "web_search" | "web_search_preview";
      readonly searchContextSize?: "low" | "medium" | "high";
      readonly userLocation?: {
        readonly type: "approximate";
        readonly city?: string;
        readonly country?: string;
        readonly region?: string;
        readonly timezone?: string;
      };
    }
  | {
      readonly type: "image_generation";
      readonly action?: "auto" | "generate" | "edit";
      readonly background?: "transparent" | "opaque" | "auto";
      readonly inputFidelity?: "high" | "low" | "auto";
      readonly outputFormat?: "png" | "jpeg" | "webp";
      readonly quality?: "low" | "medium" | "high" | "auto";
      readonly size?: string;
    }
  | { readonly type: "tool_search" }
  | { readonly type: "programmatic_tool_calling" };

export interface ModelToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Tool Search can defer large schemas until the model selects a namespace. */
  readonly deferLoading?: boolean;
  readonly namespace?: string;
  /** Routes this tool directly, from hosted JavaScript, or both. */
  readonly allowedCallers?: readonly ("direct" | "programmatic")[];
  /** Predictable JSON object returned in `function_call_output.output`. */
  readonly outputSchema?: Record<string, unknown>;

  /** §12.4 requires strict schemas. */
  readonly strict: true;
}

export interface NativeCompactionThresholdInput {
  readonly modelWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly emergencyMarginTokens?: number;
  readonly adaptiveLocalTargetTokens: number;
  readonly providerHeadroomTokens?: number;
}

/** Calculate a model-relative native compaction threshold. */
export function calculateNativeCompactionThreshold(input: NativeCompactionThresholdInput): number | undefined {
  const window = Number.isFinite(input.modelWindowTokens) ? Math.floor(input.modelWindowTokens) : 0;
  const reserve = Number.isFinite(input.outputReserveTokens) ? Math.max(0, Math.floor(input.outputReserveTokens)) : 0;
  const target = Number.isFinite(input.adaptiveLocalTargetTokens) ? Math.max(0, Math.floor(input.adaptiveLocalTargetTokens)) : 0;
  if (window <= 0 || target <= 0) return undefined;
  const emergencyMargin = Number.isFinite(input.emergencyMarginTokens)
    ? Math.max(1_024, Math.floor(input.emergencyMarginTokens ?? 0))
    : Math.max(1_024, Math.floor(window * 0.02));
  const headroom = Number.isFinite(input.providerHeadroomTokens)
    ? Math.max(0, Math.floor(input.providerHeadroomTokens ?? 0))
    : Math.max(2_048, Math.floor(window * 0.04));
  const hardCeiling = window - reserve - emergencyMargin;
  if (hardCeiling < 1_024) return 1_024;
  return Math.max(1_024, Math.min(hardCeiling, target + headroom));
}

/** Short alias used by provider integrations. */
export const nativeCompactionThreshold = calculateNativeCompactionThreshold;

export interface ModelRequest {
  readonly requestId: string;
  readonly model: string;
  readonly input: ModelInputItem[];
  readonly tools: ModelToolSchema[];
  /** Optional per-request hosted-tool override. Omitted uses the provider defaults. */
  readonly hostedTools?: readonly HostedTool[];
  readonly reasoning: {
    readonly mode: ReasoningMode;
    readonly effort: ReasoningEffort;
    readonly summary: "auto" | "none";
    readonly context: ReasoningContextScope;
  };
  readonly cache?: {
    readonly key: string;
    readonly mode: "explicit";
    /** Indices into `input` whose last content part carries the breakpoint. */
    readonly breakpoints: number[];
    readonly ttl: string;
  };
  readonly maxOutputTokens: number;
  /** §10.6: `store:false` keeps session ownership local. */
  readonly store: false;
  /** §10.6 privacy-preserving identifier: a keyed hash, never PII. */
  readonly safetyIdentifier?: string;
  readonly parallelToolCalls?: boolean;
  /** Server-side context compaction; omitted unless both config and provider support it. */
  readonly contextManagement?: readonly { readonly type: "compaction"; readonly compactThreshold: number }[];
  /** Priority processing alias used by Fast mode. */
  readonly serviceTier?: "standard" | "fast";
  /** Canonical request body digest from the prompt compiler, for trace correlation only. */
  readonly requestDigest?: string;
  /** Attribution metadata; not sent as provider prompt content. */
  readonly taskEpochId?: string;
  readonly callerId?: string;
  /** Provider-owned continuation token; never treated as user content. */
  readonly previousResponseId?: string;
}

export interface CredentialLease {
  readonly leaseId: string;
  readonly account: string;
  readonly source: string;
  readonly expiresAtMs: number;
  readonly fingerprint: string;
  /** The secret itself. Never logged, never journaled, never in an event. */
  readonly secret: string;
}

export interface CredentialValidation {
  status: "valid" | "invalid" | "restricted" | "network_error";
  accountLabel?: string;
  organizationId?: string;
  projectId?: string;
  availableModels?: string[];
  checkedAt: string;
}

export interface ProviderTurnSession {
  readonly capabilities: ProviderCapabilities;
  readonly transport?: ProviderTransport;
  prewarm(request: ModelRequest, signal: AbortSignal): Promise<void>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  resetContinuation(reason: string): void;
  close(): Promise<void>;
}

export interface ModelProvider {
  readonly id: string;
  readonly capabilities?: ProviderCapabilities;
  createTurnSession?(): ProviderTurnSession;
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  validateCredential(
    credential: CredentialLease,
    signal?: AbortSignal,
  ): Promise<CredentialValidation>;
}

/**
 * §10.12 bundled capability registry. Kept in code rather than fetched so a
 * cold start never blocks on the network (§7.1).
 *
 * P0-11: the registry is *derived* from `BUNDLED_CAPABILITY_MANIFEST` — the
 * single versioned capability document — so the two can never disagree about a
 * model's context window, output budget, aliases, or reasoning surface.
 * (`capabilities.ts` imports this module's types only, so importing it here
 * creates no runtime cycle.)
 */
import { BUNDLED_CAPABILITY_MANIFEST, snapshotDescriptor } from "./capabilities.ts";

export const MODEL_REGISTRY: readonly ModelDescriptor[] =
  BUNDLED_CAPABILITY_MANIFEST.snapshots.map(snapshotDescriptor);

export function findModel(idOrAlias: string): ModelDescriptor | undefined {
  const needle = idOrAlias.toLowerCase();
  return MODEL_REGISTRY.find(
    (m) => m.id.toLowerCase() === needle || m.aliases.some((a) => a.toLowerCase() === needle),
  );
}

/** Return the safe input-token budget for a model. */
export function inputContextBudget(
  model: ModelDescriptor | undefined,
  configuredMaxOutputTokens?: number,
): number | undefined {
  const contextWindow = model?.contextWindow;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  const modelOutput = model?.maxOutputTokens;
  const configuredOutput = configuredMaxOutputTokens;
  const reservedOutput =
    modelOutput !== undefined && Number.isFinite(modelOutput) && modelOutput > 0
      ? modelOutput
      : configuredOutput !== undefined && Number.isFinite(configuredOutput) && configuredOutput > 0
        ? configuredOutput
        : 0;

  // Keep a usable floor for malformed registry entries.
  return Math.max(4_000, Math.floor(contextWindow - reservedOutput));
}

/** §10.6: never send an unsupported field. */
export function supportsField(
  model: ModelDescriptor,
  field: "reasoningSummary" | "cacheBreakpoints" | "proMode",
): boolean {
  switch (field) {
    case "reasoningSummary":
      return model.supportsReasoningSummary;
    case "cacheBreakpoints":
      return model.supportsPromptCacheBreakpoints;
    case "proMode":
      return model.reasoningModes.includes("pro");
  }
}

export function supportsEffort(model: ModelDescriptor, effort: ReasoningEffort): boolean {
  return model.reasoningEfforts.includes(effort);
}

/**
 * §23.7 pricing registry for the cost estimate. The timestamp is displayed and
 * the value is labelled as an estimate, never a billing source of truth. The
 * `PriceEntry` shape and `PRICING_REGISTRY_VERSION` live in
 * `@cbc/inference-domain`; only the concrete OpenAI price values live here.
 */
export const PRICING: Readonly<Record<string, PriceEntry>> = {
  "gpt-5.6": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    cacheWritePerMillion: 1.5625,
    outputPerMillion: 10,
  },
  "gpt-5.6-sol": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    cacheWritePerMillion: 1.5625,
    outputPerMillion: 10,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 0.4,
    cachedInputPerMillion: 0.04,
    cacheWritePerMillion: 0.5,
    outputPerMillion: 3.2,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.01,
    cacheWritePerMillion: 0.125,
    outputPerMillion: 0.8,
  },
};

export function estimateCostUsd(model: string, usage: ModelUsage): number {
  const price = PRICING[model] ?? PRICING[findModel(model)?.id ?? ""];
  if (!price) return 0;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedInput * price.inputPerMillion +
      usage.cachedInputTokens * price.cachedInputPerMillion +
      usage.cacheWriteTokens * price.cacheWritePerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}
