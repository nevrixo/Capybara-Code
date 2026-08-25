/**
 * OpenAI Responses adapter — PRD §10.1, §10.6, §10.9, §10.12–§10.14.
 *
 * This is the only file that knows the Responses API wire format. Everything it
 * emits is a normalized `ModelEvent` (§10.2), so the agent kernel never sees a
 * provider object (§10.1, §19.4).
 *
 * §10.14: provider-hosted shell, file mutation, multi-agent, and programmatic
 * tool calling remain disabled. Capability-checked web search and image generation
 * are built in by default and can be disabled explicitly.
 */

import { createHash } from "node:crypto";

import { CACHE_DEFAULT_TTL } from "./policy.ts";
import {
  bundledCapability,
  capabilitySupports,
  chatGptCodexCapability,
  mergeCapabilitySnapshot,
  snapshotDescriptor,
  type ModelCapabilitySnapshot,
} from "./capabilities.ts";
import { OpenAiTurnSession, type WebSocketFactory } from "./turn-session.ts";
import {
  MODEL_REGISTRY,
  emptyUsage,
  findModel,
  supportsField,
  type CredentialLease,
  type CredentialValidation,
  type GeneratedImageOutput,
  type HostedToolCallName,
  type ModelAvailabilityReport,
  type ModelDescriptor,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelResponseItem,
  type ModelToolCall,
  type ModelUsage,
  type ProviderError,
  type ProviderCapabilities,
  type ProviderTransport,
  type ProviderTurnSession,
  type HostedTool,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;

interface ToolNameCodec {
  readonly toProvider: (name: string) => string;
  readonly fromProvider: (name: string) => string;
}

/**
 * The only shape of `fetch` this adapter uses: a URL plus init, returning a
 * `Response`. Deliberately narrower than `typeof fetch`, whose extra members
 * (`preconnect`) vary between runtime type packages and would otherwise force
 * every §25.6 contract-test double to implement them.
 */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Headers this adapter derives from its own options and will not let a caller
 * replace.
 *
 * `Authorization` is the important one: a configured header that overwrote it would
 * send a different secret than the lease the caller resolved, so the fingerprint in
 * `/status` would describe a credential that was never used. The org and project
 * headers are reserved for the same reason — they select who is billed.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "openai-organization",
  "openai-project",
  "chatgpt-account-id",
  "originator",
  "session-id",
  "user-agent",
]);

/** Safe, read/generate-only Responses tools exposed in every capable session. */
export const DEFAULT_HOSTED_TOOLS: readonly HostedTool[] = [
  { type: "web_search" },
  { type: "image_generation" },
];

export interface ChatGptInferenceOptions {
  readonly accountId: string;
  readonly originator?: string;
  readonly userAgent?: string;
}

export interface OpenAiProviderOptions {
  readonly credential: CredentialLease;
  readonly baseUrl?: string;
  /** Injected for contract tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  /** §10.6 privacy-preserving identifier. */
  readonly safetyIdentifier?: string;
  readonly organization?: string;
  readonly project?: string;
  /**
   * Extra headers sent with every request.
   *
   * Exists because `baseUrl` alone does not describe a host: an OAuth-fronted or
   * gateway deployment of the Responses API may require a tenant or account
   * selector alongside the bearer token. Those values belong to the deployment, so
   * they are configuration rather than something this adapter knows. Names in
   * `RESERVED_HEADERS` are ignored.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional built-in tool override. An empty array disables hosted tools. */
  readonly hostedTools?: readonly HostedTool[];
  /** Set false to disable hosted tools on the ChatGPT account backend. */
  readonly allowChatGptHostedTools?: boolean;
  /** OpenCode-style ChatGPT transport. Capybara still owns the agent loop. */
  /** Turn transport; account-backed ChatGPT sessions always use full HTTP replay. */
  readonly transport?: ProviderTransport;
  readonly serviceTier?: "standard" | "fast";
  readonly nativeCompaction?: boolean;
  readonly compactionThresholdTokens?: number;
  /** Injectable Bun-compatible socket factory for contract tests and alternate hosts. */
  readonly webSocketFactory?: WebSocketFactory;
  /** Expose deferred function schemas alongside the hosted tool_search tool. */
  readonly enableToolSearch?: boolean;

  readonly chatGpt?: ChatGptInferenceOptions;
}

export class OpenAiResponsesProvider implements ModelProvider {
  readonly id = "openai";
  readonly #options: OpenAiProviderOptions;
  readonly #fetch: FetchLike;
  readonly capabilities: ProviderCapabilities;

  /** Backend-aware capability snapshot; account hosted tools require an explicit opt-in. */
  capabilitySnapshot(modelId: string): ModelCapabilitySnapshot | undefined {
    const bundled = bundledCapability(modelId);
    if (bundled === undefined) return undefined;
    if (this.#options.chatGpt !== undefined) {
      const accountCapability = chatGptCodexCapability(modelId);
      if (accountCapability === undefined) return undefined;
      const accountHostedState = this.#options.allowChatGptHostedTools !== false ? "supported" : "unknown";
      return mergeCapabilitySnapshot(accountCapability, {
        native: {
          programmaticToolCalling: "unsupported",
          hostedMultiAgent: "unsupported",
          codeInterpreter: "unsupported",
          fileSearch: "unsupported",
          webSearch: accountHostedState,
          imageGeneration: accountHostedState,
          hostedShell: "unsupported",
          hostedApplyPatch: "unsupported",
          computerUse: "unsupported",
        },
      });
    }
    return bundled;
  }

  constructor(options: OpenAiProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    const platformBackend = options.chatGpt === undefined;
    this.capabilities = {
      websocket: platformBackend,
      previousResponse: platformBackend,
      parallelToolCalls: platformBackend,
      nativeCompaction: platformBackend,
      fastTier: platformBackend,
      toolSearch: platformBackend,
    };
  }
  createTurnSession(): ProviderTurnSession {
    const transport: ProviderTransport = this.#options.chatGpt === undefined
      ? (this.#options.transport ?? "http_full")
      : "http_full";
    return new OpenAiTurnSession({
      capabilities: this.capabilities,
      transport,
      webSocketUrl: `${this.#baseUrl().replace(/^http/iu, "ws")}/responses`,
      webSocketHeaders: this.#headers(),
      ...(this.#options.webSocketFactory !== undefined ? { webSocketFactory: this.#options.webSocketFactory } : {}),
      prepareWebSocketRequest: (request) => {
        const toolNames = createToolNameCodec(request);
        const model = findModel(request.model);
        return {
          body: this.#buildBody(request, model, toolNames, "websocket"),
          fromProviderToolName: toolNames.fromProvider,
        };
      },
      parseStream: parseResponseStream,
      httpStream: (request, signal) => this.stream(request, signal),
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    return (await this.listModelsWithAvailability(signal)).map((entry) => entry.model);
  }

  /**
   * §10.12 with honest states (P0-11): the bundled registry is knowledge, the
   * provider is the authority on access. When the provider cannot be reached the
   * models stay `unverified` — they are *not* reported as available, and a caller
   * that presents them must say the check could not run.
   */
  async listModelsWithAvailability(
    signal?: AbortSignal,
  ): Promise<ModelAvailabilityReport[]> {
    // The ChatGPT backend has no public /models route; entitlement is checked per
    // turn, so bundled knowledge is all there is until then.
    if (this.#options.chatGpt !== undefined) {
      return MODEL_REGISTRY.map((model) => ({
        model: snapshotDescriptor(this.capabilitySnapshot(model.id) ?? bundledCapability(model.id)!),
        availability: "known" as const,
      }));
    }

    try {
      const response = await this.#fetch(`${this.#baseUrl()}/models`, {
        method: "GET",
        headers: this.#headers(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        return MODEL_REGISTRY.map((model) => ({ model, availability: "unverified" as const }));
      }
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const available = new Set(
        (body.data ?? [])
          .map((model) => normalizeProviderModelId(model.id))
          .filter((id): id is string => id !== undefined),
      );
      if (available.size === 0) {
        // An empty listing says nothing about any model.
        return MODEL_REGISTRY.map((model) => ({ model, availability: "unverified" as const }));
      }

      // Keep the bundled descriptors authoritative for known models, but retain
      // provider-only IDs so model-registry diagnostics can explain the count
      // difference without pretending to know their context or tool surface.
      const knownIds = new Set(
        MODEL_REGISTRY.flatMap((model) => [model.id, ...model.aliases].map((id) => id.toLowerCase())),
      );
      const reports: ModelAvailabilityReport[] = MODEL_REGISTRY.map((model) => ({
        model,
        availability: [...available].some((id) =>
          id.toLowerCase() === model.id.toLowerCase() ||
          model.aliases.some((alias) => alias.toLowerCase() === id.toLowerCase()),
        )
          ? ("reachable" as const)
          : ("unavailable" as const),
      }));
      for (const id of available) {
        if (!knownIds.has(id.toLowerCase())) {
          reports.push({ model: discoveredModelDescriptor(id), availability: "reachable" });
        }
      }
      return reports;
    } catch {
      // §7.1 / §22.8: never let a network failure block the caller — but do not
      // pretend the check happened.
      return MODEL_REGISTRY.map((model) => ({ model, availability: "unverified" as const }));
    }
  }

  async validateCredential(
    credential: CredentialLease,
    signal?: AbortSignal,
  ): Promise<CredentialValidation> {
    const checkedAt = new Date().toISOString();
    if (this.#options.chatGpt !== undefined) {
      return {
        status: "restricted",
        checkedAt,
        availableModels: MODEL_REGISTRY.map((model) => model.id),
      };
    }
    try {
      const response = await this.#fetch(`${this.#baseUrl()}/models`, {
        method: "GET",
        headers: { ...this.#headers(), Authorization: `Bearer ${credential.secret}` },
        ...(signal ? { signal } : {}),
      });
      if (response.status === 401 || response.status === 403) {
        return { status: "invalid", checkedAt };
      }
      if (!response.ok) {
        // §9.4: a network or server error must not be reported as an invalid key.
        return { status: response.status >= 500 ? "network_error" : "restricted", checkedAt };
      }
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const availableModels = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
      const result: CredentialValidation = {
        status: availableModels.some((id) => id.startsWith("gpt-5.6")) ? "valid" : "restricted",
        checkedAt,
        availableModels,
      };
      return result;
    } catch {
      return { status: "network_error", checkedAt };
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const model = findModel(request.model);
    const toolNames = createToolNameCodec(request);
    const body = this.#buildBody(request, model, toolNames);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl()}/responses`, {
        method: "POST",
        headers: { ...this.#headers(request.requestId), "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        yield { type: "response.failed", error: cancelledError() };
        return;
      }
      yield {
        type: "response.failed",
        error: {
          kind: "network",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
      return;
    }

    if (!response.ok) {
      yield { type: "response.failed", error: await httpError(response) };
      return;
    }
    if (!response.body) {
      yield {
        type: "response.failed",
        error: { kind: "server", message: "provider returned no response body", retryable: true },
      };
      return;
    }

    yield { type: "response.started", requestId: request.requestId };
    yield* parseResponseStream(response.body, signal, toolNames.fromProvider);
  }

  #baseUrl(): string {
    return (this.#options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  #headers(sessionId?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    // Configured headers are applied first so the derived ones below win a
    // collision rather than being silently replaced.
    for (const [name, value] of Object.entries(this.#options.headers ?? {})) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    headers.Authorization = `Bearer ${this.#options.credential.secret}`;
    if (this.#options.chatGpt !== undefined) {
      headers["ChatGPT-Account-Id"] = this.#options.chatGpt.accountId;
      headers.originator = this.#options.chatGpt.originator ?? "capybara";
      headers["User-Agent"] = this.#options.chatGpt.userAgent ?? "capybara-code/0.1.0";
      if (sessionId !== undefined) headers["session-id"] = sessionId;
    }
    if (this.#options.organization) headers["OpenAI-Organization"] = this.#options.organization;
    if (this.#options.project) headers["OpenAI-Project"] = this.#options.project;
    return headers;
  }

  /** Select only hosted tools proven by the active model/backend snapshot. */
  #hostedToolsForRequest(
    request: ModelRequest,
    model: ModelDescriptor | undefined,
  ): HostedTool[] {
    const requested = request.hostedTools ?? this.#options.hostedTools ?? DEFAULT_HOSTED_TOOLS;
    if (requested.length === 0 || model === undefined) return [];
    const capability = this.capabilitySnapshot(model.id);
    if (capability === undefined) return [];
    return requested.filter((tool) => {
      if (this.#options.chatGpt !== undefined && this.#options.allowChatGptHostedTools === false) return false;
      if (tool.type === "tool_search") {
        return this.#options.enableToolSearch === true && this.capabilities.toolSearch;
      }
      const feature = tool.type === "web_search" || tool.type === "web_search_preview"
        ? "webSearch"
        : "imageGeneration";
      return capabilitySupports(capability, feature);
    });
  }

  /** §10.6 request policy, honouring the capability registry. */
  #buildBody(
    request: ModelRequest,
    model: ModelDescriptor | undefined,
    toolNames: ToolNameCodec,
    transport: "http" | "websocket" = "http",
  ): Record<string, unknown> {
    const cacheBreakpointsSupported =
      this.#options.chatGpt === undefined &&
      request.cache !== undefined &&
      model !== undefined &&
      supportsField(model, "cacheBreakpoints");
    const body: Record<string, unknown> = {
      model: request.model,
      ...(transport === "http" ? { stream: true } : {}),
      // §10.6: store:false keeps session ownership local.
      store: false,
      input: request.input.map((item, index) =>
        serializeInputItem(
          item,
          request.cache?.breakpoints.includes(index) ?? false,
          toolNames.toProvider,
          cacheBreakpointsSupported,
        ),
      ),
    };
    // The ChatGPT backend-api rejects `previous_response_id` ("Unsupported
    // parameter"), so continuation there is always the replayed input items,
    // which the kernel assembles in full for every request anyway.
    if (
      this.#options.chatGpt === undefined &&
      request.previousResponseId !== undefined &&
      request.previousResponseId.length > 0
    ) {
      body.previous_response_id = request.previousResponseId;
    }
    if (this.#options.chatGpt === undefined) {
      body.max_output_tokens = request.maxOutputTokens;
    }

    const reasoning: Record<string, unknown> = {
      effort: request.reasoning.effort,
      context: request.reasoning.context,
    };
    const proModeSupported = this.#options.chatGpt === undefined
      ? model === undefined || supportsField(model, "proMode")
      : this.capabilitySnapshot(request.model)?.reasoningModes.includes("pro") === true;
    if (request.reasoning.mode === "pro" && proModeSupported) reasoning.mode = "pro";
    // `none` is our provider-neutral sentinel for not requesting a reasoning
    // summary. The Responses API accepts only summary detail levels, so forward
    // it by omitting the field rather than sending an invalid literal.
    if (
      request.reasoning.summary !== "none" &&
      (model === undefined || supportsField(model, "reasoningSummary"))
    ) {
      reasoning.summary = request.reasoning.summary;
    }
    body.reasoning = reasoning;

    const hostedTools = this.#hostedToolsForRequest(request, model);
    const functionTools = request.tools.map((tool) => ({
      type: "function",
      name: toolNames.toProvider(tool.name),
      description: tool.description,
      parameters: normalizeProviderSchema(tool.parameters),
      strict: tool.strict && supportsProviderStrictSchema(tool.parameters),
      ...(this.#options.enableToolSearch === true && tool.deferLoading === true ? { defer_loading: true } : {}),
    }));
    if (functionTools.length > 0 || hostedTools.length > 0) {
      body.tools = [
        ...functionTools,
        ...hostedTools.map(serializeHostedTool),
      ];
      if (request.parallelToolCalls !== undefined && functionTools.length > 0) {
        if (this.capabilities.parallelToolCalls) body.parallel_tool_calls = request.parallelToolCalls;
      }
    }

    // §10.9: only send cache fields the model actually supports.
    if (
      this.#options.chatGpt === undefined &&
      request.cache &&
      cacheBreakpointsSupported
    ) {
      body.prompt_cache_key = request.cache.key;
      body.prompt_cache_options = {
        mode: request.cache.mode,
        ttl: request.cache.ttl || CACHE_DEFAULT_TTL,
      };
    }

    if (this.#options.chatGpt === undefined && request.safetyIdentifier) {
      body.safety_identifier = request.safetyIdentifier;
    }
    if (this.#options.chatGpt === undefined) {
      const contextManagement = request.contextManagement ?? (
        this.#options.nativeCompaction === true
          ? [{
              type: "compaction" as const,
              compactThreshold: Math.max(1_024, this.#options.compactionThresholdTokens ?? 80_000),
            }]
          : undefined
      );
      if (this.capabilities.nativeCompaction && contextManagement !== undefined) {
        body.context_management = contextManagement.map((entry) => ({
          type: entry.type,
          compact_threshold: entry.compactThreshold,
        }));
      }
      const serviceTier = request.serviceTier ?? this.#options.serviceTier;
      if (this.capabilities.fastTier && serviceTier !== undefined) {
        body.service_tier = serviceTier === "fast" ? "priority" : "default";
      }
    }

    return body;
  }
}

function serializeHostedTool(tool: HostedTool): Record<string, unknown> {
  if (tool.type === "tool_search") return { type: tool.type };
  if (tool.type !== "image_generation") {
    return {
      type: tool.type,
      ...(tool.searchContextSize !== undefined ? { search_context_size: tool.searchContextSize } : {}),
      ...(tool.userLocation !== undefined ? { user_location: tool.userLocation } : {}),
    };
  }
  return {
    type: tool.type,
    ...(tool.action !== undefined ? { action: tool.action } : {}),
    ...(tool.background !== undefined ? { background: tool.background } : {}),
    ...(tool.inputFidelity !== undefined ? { input_fidelity: tool.inputFidelity } : {}),
    ...(tool.outputFormat !== undefined ? { output_format: tool.outputFormat } : {}),
    ...(tool.quality !== undefined ? { quality: tool.quality } : {}),
    ...(tool.size !== undefined ? { size: tool.size } : {}),
  };
}

/**
 * OpenAI's strict function subset requires every declared object property to be
 * listed in the required JSON field. The catalog keeps a smaller required set so the local
 * validator can apply defaults, so normalize a copy only at the provider boundary.
 */
function normalizeProviderSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...schema };
  const properties = schema.properties;
  if (isRecord(properties)) {
    const normalizedProperties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(properties)) {
      normalizedProperties[name] = isRecord(property)
        ? normalizeProviderSchema(property)
        : property;
    }
    normalized.properties = normalizedProperties;
    normalized.required = Object.keys(normalizedProperties);
  } else if (schema.type === "object" && normalized.required === undefined) {
    normalized.required = [];
  }
  if (schema.type === "object" && normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  }

  for (const key of [
    "items",
    "additionalProperties",
    "not",
    "contains",
    "propertyNames",
    "if",
    "then",
    "else",
  ] as const) {
    const value = schema[key];
    if (isRecord(value)) normalized[key] = normalizeProviderSchema(value);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const value = schema[key];
    if (Array.isArray(value)) {
      normalized[key] = value.map((branch) =>
        isRecord(branch) ? normalizeProviderSchema(branch) : branch,
      );
    }
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeInputItem(
  item: ModelRequest["input"][number],
  applyBreakpoint: boolean,
  toProviderToolName: (name: string) => string,
  allowCacheBreakpoint: boolean,
): Record<string, unknown> {
  switch (item.type) {
    case "message": {
      const content = item.content.map((part, partIndex) => {
        const isLast = partIndex === item.content.length - 1;
        if (part.type === "input_text") {
          const serialized: Record<string, unknown> = { type: "input_text", text: part.text };
          if (
            allowCacheBreakpoint &&
            (part.cacheBreakpoint === true || (applyBreakpoint && isLast)) &&
            part.text.length > 0
          ) {
            serialized.prompt_cache_breakpoint = { mode: "explicit" };
          }
          return serialized;
        }
        return { type: "output_text", text: part.text };
      });
      const message: Record<string, unknown> = { type: "message", role: item.role, content };
      // §10.7: preserve the phase so commentary and final answer stay distinct
      // across replay.
      if (item.phase) message.phase = item.phase;
      return message;
    }
    case "function_call":
      return {
        type: "function_call",
        call_id: item.callId,
        name: toProviderToolName(item.name),
        arguments: item.argumentsText,
      };
    case "function_call_output":
      return { type: "function_call_output", call_id: item.callId, output: item.output };
    case "reasoning":
      // §10.6: encrypted reasoning content is opaque and never inspected. The
      // backend requires `summary` to accompany a replayed reasoning item; an
      // empty array satisfies it when no summary text was captured.
      return {
        type: "reasoning",
        encrypted_content: item.opaque,
        summary:
          item.summaryText !== undefined && item.summaryText.length > 0
            ? [{ type: "summary_text", text: item.summaryText }]
            : [],
      };
    case "compaction":
      return { type: "compaction", encrypted_content: item.opaque };
  }
}

/**
 * Parse a Responses SSE stream into normalized events.
 *
 * Tolerates out-of-order and duplicated deltas (§25.6), because a reconnecting
 * stream can legitimately repeat a frame.
 */
export async function* parseResponseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  fromProviderToolName: (name: string) => string = (name) => name,
): AsyncIterable<ModelEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** Tool call assembly state, keyed by the provider's item id. */
  const calls = new Map<string, { callId: string; name: string; argumentsText: string; emitted: boolean; callerId?: string; programId?: string; agentId?: string }>();
  const hostedCalls = new Map<string, HostedCallEntry>();
  const seenDeltas = new Set<string>();
  let terminal: "completed" | "incomplete" | "failed" | undefined;

  try {
    for (;;) {
      if (signal?.aborted === true) {
        terminal = "failed";
        yield { type: "response.failed", error: cancelledError() };
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        // Flush a split UTF-8 code point before parsing the final SSE block.
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      // SSE permits LF, CRLF, and (for older servers) mixed line endings. Match
      // the complete blank-line separator so a Windows response is yielded as
      // soon as each frame arrives instead of waiting for the stream to close.
      let boundaryMatch = /\r?\n\r?\n/.exec(buffer);
      while (boundaryMatch !== null) {
        const boundary = boundaryMatch.index;
        const separatorLength = boundaryMatch[0].length;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        boundaryMatch = /\r?\n\r?\n/.exec(buffer);

        const dataLines = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("");
        if (payload === "[DONE]") continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue; // Ignore an unparseable frame rather than aborting the turn.
        }

        if (terminal !== undefined) continue;
        for (const event of translate(parsed, calls, hostedCalls, seenDeltas, fromProviderToolName)) {
          const nextTerminal = responseTerminalKind(event);
          if (nextTerminal !== undefined) {
            // A provider completion proves pending calls are final even if a
            // redundant item/delta done frame was lost. Incomplete, failed,
            // and EOF streams must never promote partial calls to executable.
            if (nextTerminal === "completed") {
              for (const entry of calls.values()) {
                if (entry.emitted) continue;
                entry.emitted = true;
                yield {
                  type: "tool.call.completed",
                  call: toolCallFromEntry(entry, entry.argumentsText),
                };
              }
            }
            terminal = nextTerminal;
          }
          yield event;
        }
      }
      if (done) break;
    }

    // Usage is emitted exactly once per response, by the `response.completed`
    // (or `response.incomplete`) translation above; re-yielding the stored total
    // here used to double every `usage.updated` in the journal (§10.13).
    if (terminal === undefined) {
      terminal = "incomplete";
      yield { type: "response.incomplete", reason: "stream ended before response.completed" };
    }
  } catch (error) {
    if (terminal !== undefined) return;
    if (signal?.aborted === true) {
      terminal = "failed";
      yield { type: "response.failed", error: cancelledError() };
      return;
    }
    terminal = "failed";
    yield {
      type: "response.failed",
      error: {
        kind: "network",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  } finally {
    reader.releaseLock();
  }
}

function responseTerminalKind(
  event: ModelEvent,
): "completed" | "incomplete" | "failed" | undefined {
  if (event.type === "response.completed") return "completed";
  if (event.type === "response.incomplete") return "incomplete";
  if (event.type === "response.failed") return "failed";
  return undefined;
}


/** Keep provider ordering metadata available to the kernel without changing the enumerable legacy event shape. */
function withSequence<T extends object>(event: T, sequence: number | undefined): T & { readonly sequence?: number } {
  if (sequence === undefined) return event;
  Object.defineProperty(event, "sequence", {
    value: sequence,
    enumerable: false,
    configurable: true,
  });
  return event as T & { readonly sequence?: number };
}
function* translate(
  frame: Record<string, unknown>,
  calls: Map<string, { callId: string; name: string; argumentsText: string; emitted: boolean; callerId?: string; programId?: string; agentId?: string }>,
  hostedCalls: Map<string, HostedCallEntry>,
  seenDeltas: Set<string>,
  fromProviderToolName: (name: string) => string,
): Generator<ModelEvent> {
  const type = typeof frame.type === "string" ? frame.type : "";
  const outputIndex = typeof frame.output_index === "number" ? frame.output_index : undefined;
  // `response.output_item.*` frames can carry their identity only inside
  // `item.id`. Prefer the explicit frame id, then the nested item id, before
  // falling back to the output index so live deltas and durable items reconcile.
  const nestedItem = frame.item as Record<string, unknown> | undefined;
  const nestedItemId =
    typeof nestedItem?.id === "string" && nestedItem.id.length > 0
      ? nestedItem.id
      : undefined;
  const itemId = typeof frame.item_id === "string" ? frame.item_id : nestedItemId ?? String(outputIndex ?? "0");
  const sequence = typeof frame.sequence_number === "number" ? frame.sequence_number : undefined;

  /** Duplicate suppression: the same (type, item, sequence) is applied once. */
  const dedupeKey = sequence !== undefined ? `${type}:${itemId}:${sequence}` : undefined;
  if (dedupeKey !== undefined) {
    if (seenDeltas.has(dedupeKey)) return;
    seenDeltas.add(dedupeKey);
  }

  switch (type) {
    case "response.created": {
      const response = frame.response as Record<string, unknown> | undefined;
      yield {
        type: "response.created",
        responseId: typeof response?.id === "string" ? response.id : "unknown",
      };
      return;
    }
    case "response.in_progress":
      return;

    case "response.output_text.delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (delta.length === 0) return;
      // §10.7: commentary and final answer are distinct phases.
      const phase = typeof frame.phase === "string" ? frame.phase : undefined;
      if (phase === "commentary") {
        yield { type: "commentary.delta", text: delta, itemId, ...(outputIndex !== undefined ? { outputIndex } : {}) };
      } else {
        yield { type: "text.delta", text: delta, itemId, ...(outputIndex !== undefined ? { outputIndex } : {}) };
      }
      return;
    }

    case "response.reasoning_text.delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (delta.length > 0) {
        yield withSequence({ type: "reasoning.text.delta", text: delta, itemId, ...(outputIndex !== undefined ? { outputIndex } : {}) }, sequence);
      }
      return;
    }
    case "response.reasoning_text.done": {
      const text = typeof frame.text === "string" ? frame.text : "";
      if (text.length > 0) {
        yield withSequence({ type: "reasoning.text.done", text, itemId, ...(outputIndex !== undefined ? { outputIndex } : {}) }, sequence);
      }
      return;
    }
    case "response.reasoning_summary_text.delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (delta.length > 0) {
        yield withSequence({ type: "reasoning.summary.delta", text: delta, itemId, ...(outputIndex !== undefined ? { outputIndex } : {}) }, sequence);
      }
      return;
    }

    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
    case "response.image_generation_call.in_progress":
    case "response.image_generation_call.generating":
    case "response.image_generation_call.partial_image": {
      const name: HostedToolCallName = type.includes("web_search") ? "web_search" : "image_generation";
      const entry = hostedCalls.get(itemId) ?? { name, started: false, terminal: false };
      hostedCalls.set(itemId, entry);
      if (!entry.started) {
        entry.started = true;
        yield hostedStartedEvent(itemId, name);
      }
      return;
    }

    case "response.output_item.added": {
      const item = frame.item as Record<string, unknown> | undefined;
      if (item === undefined) return;
      const hostedEvents = hostedEventsFromItem(item, itemId, hostedCalls, false);
      if (hostedEvents !== undefined) {
        yield* hostedEvents;
        return;
      }
      if (item.type === "function_call") {
        const callId = typeof item.call_id === "string" ? item.call_id : itemId;
        const callerId = typeof item.caller_id === "string" ? item.caller_id : undefined;
        const programId = typeof item.program_id === "string" ? item.program_id : undefined;
        const agentId = typeof item.agent_id === "string" ? item.agent_id : undefined;
        const name = fromProviderToolName(typeof item.name === "string" ? item.name : "");
        calls.set(itemId, { callId, name, argumentsText: "", emitted: false, ...(callerId !== undefined ? { callerId } : {}), ...(programId !== undefined ? { programId } : {}), ...(agentId !== undefined ? { agentId } : {}) });
        yield { type: "tool.call.started", callId, name, ...(callerId !== undefined ? { callerId } : {}), ...(programId !== undefined ? { programId } : {}), ...(agentId !== undefined ? { agentId } : {}) };
        return;
      }
      const normalized = normalizeResponseItem(item, itemId, sequence);
      if (normalized !== undefined) yield { type: "response.item", item: normalized };
      return;
    }

    case "response.function_call_arguments.delta": {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      const entry = calls.get(itemId);
      if (!entry || delta.length === 0) return;
      entry.argumentsText += delta;
      yield { type: "tool.call.arguments.delta", callId: entry.callId, delta };
      return;
    }

    case "response.function_call_arguments.done": {
      const entry = calls.get(itemId);
      if (!entry) return;
      const complete = typeof frame.arguments === "string" ? frame.arguments : entry.argumentsText;
      entry.argumentsText = complete;
      if (entry.emitted) return;
      entry.emitted = true;
      yield {
        type: "tool.call.completed",
        call: toolCallFromEntry(entry, complete),
      };
      return;
    }

    case "response.output_item.done": {
      const item = frame.item as Record<string, unknown> | undefined;
      if (item === undefined) return;
      const hostedEvents = hostedEventsFromItem(item, itemId, hostedCalls, true);
      if (hostedEvents !== undefined) {
        yield* hostedEvents;
        return;
      }
      if (item.type !== "function_call") {
        const normalized = normalizeResponseItem(item, itemId, sequence);
        if (normalized !== undefined) yield { type: "response.item", item: normalized, authoritative: true };
        return;
      }
      const entry = calls.get(itemId);
      if (!entry || entry.emitted) return;
      entry.emitted = true;
      const complete = typeof item.arguments === "string" ? item.arguments : entry.argumentsText;
      yield {
        type: "tool.call.completed",
        call: toolCallFromEntry(entry, complete),
      };
      return;
    }

    case "response.completed": {
      const response = frame.response as Record<string, unknown> | undefined;
      const output = Array.isArray(response?.output) ? response.output : [];
      for (const [index, rawItem] of output.entries()) {
        if (!isRecord(rawItem)) continue;
        const completedItemId = typeof rawItem.id === "string" && rawItem.id.length > 0
          ? rawItem.id
          : `completed:${index}`;
        const hostedEvents = hostedEventsFromItem(rawItem, completedItemId, hostedCalls, true, true);
        if (hostedEvents !== undefined) {
          yield* hostedEvents;
          continue;
        }
        if (rawItem.type === "function_call") {
          const callId = typeof rawItem.call_id === "string" ? rawItem.call_id : completedItemId;
          const existing = calls.get(completedItemId);
          if (existing?.emitted === true) continue;
          const entry = existing ?? {
            callId,
            name: fromProviderToolName(typeof rawItem.name === "string" ? rawItem.name : ""),
            argumentsText: "",
            emitted: false,
          };
          entry.argumentsText = typeof rawItem.arguments === "string" ? rawItem.arguments : entry.argumentsText;
          entry.emitted = true;
          calls.set(completedItemId, entry);
          yield { type: "tool.call.completed", call: toolCallFromEntry(entry, entry.argumentsText) };
          continue;
        }
        const normalized = normalizeResponseItem(rawItem, completedItemId, index);
        if (normalized !== undefined) yield { type: "response.item", item: normalized, authoritative: true };
      }
      const usage = extractUsage(response?.usage);
      if (usage) yield { type: "usage", usage };
      yield {
        type: "response.completed",
        responseId: typeof response?.id === "string" ? response.id : "unknown",
      };
      return;
    }

    case "response.incomplete": {
      const response = frame.response as Record<string, unknown> | undefined;
      const details = response?.incomplete_details as Record<string, unknown> | undefined;
      const usage = extractUsage(response?.usage);
      if (usage) yield { type: "usage", usage };
      const responseId = typeof response?.id === "string" ? response.id : undefined;
      yield {
        type: "response.incomplete",
        reason: typeof details?.reason === "string" ? details.reason : "unknown",
        ...(responseId !== undefined ? { responseId } : {}),
      };
      return;
    }

    case "response.failed":
    case "error": {
      const response = frame.response as Record<string, unknown> | undefined;
      const nestedError = isRecord(response?.error)
        ? response.error
        : isRecord(frame.error)
          ? frame.error
          : {};
      const rawStatus = nestedError.status ?? frame.status;
      const status = typeof rawStatus === "number" && Number.isFinite(rawStatus)
        ? rawStatus
        : typeof rawStatus === "string" && /^\d{3}$/u.test(rawStatus)
          ? Number(rawStatus)
          : undefined;
      const code = typeof nestedError.code === "string"
        ? nestedError.code
        : typeof frame.code === "string"
          ? frame.code
          : undefined;
      const error: Record<string, unknown> = {
        ...nestedError,
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(typeof nestedError.message !== "string" && typeof frame.message === "string"
          ? { message: frame.message }
          : {}),
      };
      yield {
        type: "response.failed",
        error: normalizeProviderError(error, JSON.stringify(frame)),
      };
      return;
    }

    default:
      // Unknown provider frames stay bounded and opaque so a reconnect or
      // newer Responses item cannot disappear from the journal. They are never
      // interpreted as executable tool calls by the kernel.
      yield {
        type: "response.item",
        item: {
          kind: "unknown",
          itemId,
          sequence: sequence ?? 0,
          rawType: type || "unknown",
          opaque: boundedOpaque(frame) ?? "{}",
        },
      };
      return;
  }
}


function toolCallFromEntry(
  entry: { callId: string; name: string; callerId?: string; programId?: string; agentId?: string },
  argumentsText: string,
): ModelToolCall {
  return {
    callId: entry.callId,
    name: entry.name,
    argumentsText,
    ...(entry.callerId !== undefined ? { callerId: entry.callerId } : {}),
    ...(entry.programId !== undefined ? { programId: entry.programId } : {}),
    ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
  };
}

interface HostedCallEntry {
  readonly name: HostedToolCallName;
  started: boolean;
  terminal: boolean;
}

function hostedStartedEvent(callId: string, name: HostedToolCallName): ModelEvent {
  return {
    type: "hosted.tool.started",
    callId,
    name,
    display: name === "web_search" ? "Searching the web" : "Generating an image",
  };
}

function hostedEventsFromItem(
  item: Record<string, unknown>,
  fallbackId: string,
  calls: Map<string, HostedCallEntry>,
  done: boolean,
  finalResponse = false,
): ModelEvent[] | undefined {
  const rawType = typeof item.type === "string" ? item.type : "";
  const name: HostedToolCallName | undefined = rawType === "web_search_call"
    ? "web_search"
    : rawType === "image_generation_call"
      ? "image_generation"
      : undefined;
  if (name === undefined) return undefined;

  const callId = typeof item.id === "string" && item.id.length > 0
    ? item.id
    : typeof item.call_id === "string" && item.call_id.length > 0
      ? item.call_id
      : fallbackId;
  const entry = calls.get(callId) ?? { name, started: false, terminal: false };
  calls.set(callId, entry);
  const events: ModelEvent[] = [];
  if (!entry.started) {
    entry.started = true;
    events.push(hostedStartedEvent(callId, name));
  }
  if (!done || entry.terminal) return events;

  const status = typeof item.status === "string" ? item.status : "completed";
  if (status === "failed" || status === "cancelled" || (item.error !== undefined && item.error !== null)) {
    entry.terminal = true;
    const error = isRecord(item.error) && typeof item.error.message === "string"
      ? item.error.message
      : `${name === "web_search" ? "Web search" : "Image generation"} ${status}`;
    events.push({ type: "hosted.tool.failed", callId, name, message: error });
    return events;
  }
  if (name === "web_search") {
    entry.terminal = true;
    events.push({ type: "hosted.tool.completed", callId, name, summary: "Web search completed" });
    return events;
  }

  const image = generatedImageFromItem(item);
  if (image === undefined) {
    if (!finalResponse) return events;
    entry.terminal = true;
    events.push({
      type: "hosted.tool.failed",
      callId,
      name,
      message: "Image generation completed without image data",
    });
    return events;
  }
  entry.terminal = true;
  events.push({
    type: "hosted.tool.completed",
    callId,
    name,
    summary: "Image generated",
    image,
  });
  return events;
}

function generatedImageFromItem(item: Record<string, unknown>): GeneratedImageOutput | undefined {
  const result = typeof item.result === "string"
    ? item.result
    : isRecord(item.result) && typeof item.result.b64_json === "string"
      ? item.result.b64_json
      : isRecord(item.result) && typeof item.result.data === "string"
        ? item.result.data
        : undefined;
  if (result === undefined || result.length === 0) return undefined;
  const declaredFormat = item.output_format;
  const outputFormat: GeneratedImageOutput["outputFormat"] = declaredFormat === "jpeg" || declaredFormat === "webp" || declaredFormat === "png"
    ? declaredFormat
    : result.startsWith("/9j/")
      ? "jpeg"
      : result.startsWith("UklGR")
        ? "webp"
        : "png";
  return {
    base64: result,
    outputFormat,
    mediaType: outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png",
    ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
  };
}

function normalizeResponseItem(item: Record<string, unknown>, itemId: string, sequence: number | undefined): ModelResponseItem | undefined {
  const rawType = typeof item.type === "string" ? item.type : "unknown";
  const callerId = typeof item.caller_id === "string" ? item.caller_id : undefined;
  const programId = typeof item.program_id === "string" ? item.program_id : undefined;
  const agentId = typeof item.agent_id === "string" ? item.agent_id : undefined;
  const base = { itemId, ...(sequence !== undefined ? { sequence } : {}), rawType, ...(callerId !== undefined ? { callerId } : {}), ...(programId !== undefined ? { programId } : {}), ...(agentId !== undefined ? { agentId } : {}) };
  if (rawType === "message") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map(renderMessagePart).join("");
    return { ...base, kind: "message", ...(text.length > 0 ? { text } : {}), ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}) };
  }
  if (rawType === "function_call_output") {
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    return { ...base, kind: "function_call_output", ...(typeof item.call_id === "string" ? { callId: item.call_id } : {}), output };
  }
  if (rawType === "reasoning") {
    const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : item.encrypted_content !== undefined ? boundedOpaque(item.encrypted_content) : typeof item.opaque === "string" ? item.opaque : item.opaque !== undefined ? boundedOpaque(item.opaque) : undefined;
    const summary = reasoningSummaryText(item.summary);
    const reasoningText = reasoningContentText(item.content);
    return { ...base, kind: "reasoning", ...(encrypted !== undefined ? { opaque: encrypted } : {}), ...(reasoningText !== undefined ? { reasoningText } : {}), ...(summary !== undefined ? { summaryText: summary } : {}) };
  }
  if (rawType === "compaction") {
    const opaque = boundedOpaque(item.encrypted_content ?? item.opaque ?? item);
    return { ...base, kind: "compaction", ...(opaque !== undefined ? { opaque } : {}) };
  }
  if (rawType === "function_call") {
    return { ...base, kind: "function_call", ...(typeof item.call_id === "string" ? { callId: item.call_id } : {}), ...(typeof item.name === "string" ? { name: item.name } : {}), ...(typeof item.arguments === "string" ? { argumentsText: item.arguments } : {}) };
  }
  return { ...base, kind: "unknown" };
}

function renderMessagePart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part) || typeof part.text !== "string") return "";
  const citations = Array.isArray(part.annotations)
    ? part.annotations.filter((annotation): annotation is Record<string, unknown> =>
        isRecord(annotation) &&
        annotation.type === "url_citation" &&
        typeof annotation.url === "string" &&
        /^https?:\/\/[^\s]+$/iu.test(annotation.url),
      )
    : [];
  if (citations.length === 0) return part.text;

  let text = part.text;
  let lastStart = text.length;
  const unplaced: Record<string, unknown>[] = [];
  const descending = [...citations].sort((left, right) =>
    (typeof right.start_index === "number" ? right.start_index : -1) -
    (typeof left.start_index === "number" ? left.start_index : -1),
  );
  for (const citation of descending) {
    const start = citation.start_index;
    const end = citation.end_index;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < 0 ||
      end <= start ||
      end > text.length ||
      end > lastStart
    ) {
      unplaced.push(citation);
      continue;
    }
    const label = text.slice(start, end);
    const url = citation.url as string;
    text = `${text.slice(0, start)}[${escapeMarkdownLabel(label)}](${escapeMarkdownUrl(url)})${text.slice(end)}`;
    lastStart = start;
  }
  if (unplaced.length === 0) return text;

  const seen = new Set<string>();
  const links = unplaced.flatMap((citation) => {
    const url = citation.url as string;
    if (seen.has(url)) return [];
    seen.add(url);
    const title = typeof citation.title === "string" && citation.title.length > 0
      ? citation.title
      : url;
    return [`- [${escapeMarkdownLabel(title)}](${escapeMarkdownUrl(url)})`];
  });
  return links.length > 0 ? `${text}\n\nSources:\n${links.join("\n")}` : text;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/gu, "\\$1");
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/\)/gu, "%29").replace(/\(/gu, "%28");
}

function boundedOpaque(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? undefined : text.slice(0, 65_536);
}

/**
 * A reasoning item's `summary` may be a plain string or the wire's array of
 * `{ type: "summary_text", text }` parts. Reduce both to the display string so
 * a replayed item can carry it back.
 */
function reasoningSummaryText(summary: unknown): string | undefined {
  if (typeof summary === "string") return summary.length > 0 ? summary : undefined;
  if (!Array.isArray(summary)) return undefined;
  const text = summary
    .map((part) =>
      part !== null && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
        ? ((part as Record<string, unknown>).text as string)
        : "",
    )
    .join("");
  return text.length > 0 ? text : undefined;
}

function reasoningContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return record.type === "reasoning_text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}
function extractUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const result = emptyUsage();
  result.inputTokens = numberOf(usage.input_tokens);
  result.outputTokens = numberOf(usage.output_tokens);
  result.cachedInputTokens = numberOf(inputDetails?.cached_tokens);
  result.cacheWriteTokens = numberOf(inputDetails?.cache_write_tokens);
  result.reasoningTokens = numberOf(outputDetails?.reasoning_tokens);
  result.totalTokens = numberOf(usage.total_tokens) || result.inputTokens + result.outputTokens;
  return result;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Transport failures that arrive *inside* a provider error payload (an SSE
 * `error` frame or an HTTP error body) rather than as a thrown fetch error.
 * §10.13 counts a network reset as retryable, so these must map to `network`
 * and not fall through to `unknown`.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Some gateways omit a status code for their overload response. */
const OVERLOAD_MESSAGE = /servers?\s+(?:are\s+)?(?:currently\s+)?overloaded|server\s+overloaded/i;

export function normalizeProviderError(
  raw: Record<string, unknown>,
  fallback?: string,
): ProviderError {
  const message = typeof raw.message === "string" && raw.message.length > 0
    ? raw.message
    : fallback !== undefined && fallback.length > 0
      ? fallback.slice(0, 500)
      : "provider error";
  const code = typeof raw.code === "string" ? raw.code : undefined;
  const type = typeof raw.type === "string" ? raw.type : "";
  const status = typeof raw.status === "number" ? raw.status : undefined;

  let kind: ProviderError["kind"] = "unknown";
  if (type.includes("rate_limit") || code === "rate_limit_exceeded" || status === 429) {
    kind = "rate_limit";
  } else if (type.includes("authentication") || status === 401 || status === 403) {
    kind = "authentication";
  } else if (
    type.includes("invalid_request") ||
    code === "previous_response_not_found" ||
    status === 400
  ) {
    kind = "invalid_request";
  } else if (code === "context_length_exceeded") {
    kind = "context_length";
  } else if (type.includes("content") || code === "content_filter") {
    kind = "content_policy";
  } else if (status !== undefined && status >= 500) {
    kind = "server";
  } else if ((status === undefined || status >= 500) && OVERLOAD_MESSAGE.test(message)) {
    kind = "server";
  } else if (
    (code !== undefined && NETWORK_ERROR_CODES.has(code.toUpperCase())) ||
    type.includes("connection")
  ) {
    kind = "network";
  }

  // §10.13: 408, 429, and selected 5xx are retryable; validation and auth are not.
  const retryable =
    kind === "rate_limit" || kind === "server" || kind === "network" || status === 408;

  const error: ProviderError = { kind, message, retryable };
  return {
    ...error,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

/**
 * Error bodies do not all look like the platform's `{ error: { message } }`.
 * Gateway and backend-api deployments return `{ error: "..." }`, FastAPI-style
 * `{ detail: ... }`, or a bare message object. Accept every shape that carries
 * a human-readable reason so a failed turn reports the provider's actual words
 * instead of an opaque placeholder.
 */
function extractErrorBody(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { message: trimmed.slice(0, 500) };
  }
  if (!isRecord(parsed)) return { message: trimmed.slice(0, 500) };
  if (isRecord(parsed.error)) return parsed.error;
  if (typeof parsed.error === "string" && parsed.error.length > 0) {
    return { message: parsed.error };
  }
  const detail = parsed.detail;
  if (typeof detail === "string" && detail.length > 0) return { message: detail };
  if (isRecord(detail)) {
    return typeof detail.message === "string" ? detail : { message: JSON.stringify(detail) };
  }
  if (typeof parsed.message === "string") return parsed;
  return {};
}

async function httpError(response: Response): Promise<ProviderError> {
  let rawText = "";
  try {
    rawText = await response.text();
  } catch {
    /* unreadable error body */
  }
  const body = extractErrorBody(rawText);
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterMs =
    retryAfterHeader !== null && !Number.isNaN(Number(retryAfterHeader))
      ? Number(retryAfterHeader) * 1000
      : undefined;
  const base = normalizeProviderError({ ...body, status: response.status }, rawText);
  return retryAfterMs !== undefined ? { ...base, retryAfterMs } : base;
}

function discoveredModelDescriptor(id: string): ModelDescriptor {
  return {
    id,
    family: "unknown",
    aliases: [],
    reasoningEfforts: [],
    reasoningModes: ["standard"],
    supportsStreaming: false,
    supportsFunctionCalling: false,
    supportsReasoningSummary: false,
    supportsPromptCacheBreakpoints: false,
    sourceVersion: "provider-live",
  };
}

function normalizeProviderModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  // Model IDs are display-only here; keep them bounded and printable before they
  // reach terminal output or a command completion list.
  return id.length > 0 && id.length <= 128 && /^[\x21-\x7E]+$/u.test(id) ? id : undefined;
}

function cancelledError(): ProviderError {
  return { kind: "cancelled", message: "request cancelled by the user", retryable: false };
}


/**
 * CBC keeps human-readable dotted tool IDs (for example, `fs.read`) internally,
 * while the Responses API accepts only letters, numbers, underscores, and hyphens.
 * The per-request map keeps wire names valid without leaking the provider constraint
 * into the registry, permission rules, journals, or MCP routing.
 */
function createToolNameCodec(request: ModelRequest): ToolNameCodec {
  const names = new Set(request.tools.map((tool) => tool.name));
  for (const item of request.input) {
    if (item.type === "function_call") names.add(item.name);
  }

  const toProvider = new Map<string, string>();
  const fromProvider = new Map<string, string>();
  const ordered = [...names].sort();

  // Reserve already-valid names first so an encoded dotted ID cannot shadow one.
  for (const name of ordered) {
    if (!isProviderToolName(name)) continue;
    toProvider.set(name, name);
    fromProvider.set(name, name);
  }

  for (const name of ordered) {
    if (toProvider.has(name)) continue;
    for (let salt = 0; ; salt += 1) {
      const encoded = encodeProviderToolName(name, salt);
      if (fromProvider.has(encoded)) continue;
      toProvider.set(name, encoded);
      fromProvider.set(encoded, name);
      break;
    }
  }

  return {
    toProvider: (name) => {
      const encoded = toProvider.get(name);
      if (encoded === undefined) {
        throw new Error(`tool name '${name}' was not registered for this request`);
      }
      return encoded;
    },
    fromProvider: (name) => fromProvider.get(name) ?? name,
  };
}

function isProviderToolName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_PROVIDER_TOOL_NAME_LENGTH &&
    PROVIDER_TOOL_NAME_PATTERN.test(name)
  );
}

function encodeProviderToolName(name: string, salt: number): string {
  const readable = name
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool";
  const suffix = `_${providerToolNameHash(`${name}:${salt}`)}`;
  return `${readable.slice(0, MAX_PROVIDER_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

function providerToolNameHash(value: string): string {
  // Provider names are length-constrained, so retain a 64-bit SHA-256 prefix.
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
/**
 * Strict function schemas cannot describe arbitrary object keys. Keep strict
 * mode for fixed-shape tools, but let dynamic maps use the provider's flexible
 * schema mode while the local tool validator still enforces their shape.
 */
function supportsProviderStrictSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  if (
    schema.type === "object" &&
    Object.prototype.hasOwnProperty.call(schema, "additionalProperties") &&
    schema.additionalProperties !== false
  ) {
    return false;
  }

  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const property of Object.values(properties)) {
      if (!supportsProviderStrictSchema(property)) return false;
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      if (!schema.items.every((item) => supportsProviderStrictSchema(item))) return false;
    } else if (!supportsProviderStrictSchema(schema.items)) {
      return false;
    }
  }
  if (
    isRecord(schema.additionalProperties) &&
    !supportsProviderStrictSchema(schema.additionalProperties)
  ) {
    return false;
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (
      Array.isArray(branches) &&
      !branches.every((branch) => supportsProviderStrictSchema(branch))
    ) {
      return false;
    }
  }
  return true;
}
