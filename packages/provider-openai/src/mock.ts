/**
 * Mock provider — PRD §0.2 ("mock provider만으로 Root Agent 통합 테스트를
 * 완료할 수 있어야 한다"), §25.6, AC-47.
 *
 * Scripts are declarative so a test states the model's behaviour rather than the
 * SSE bytes. It implements the same `ModelProvider` interface as the real
 * adapter, so the kernel cannot tell them apart.
 */

import {
  MODEL_REGISTRY,
  emptyUsage,
  type CredentialLease,
  type CredentialValidation,
  type ModelDescriptor,
  type ModelCompactionRequest,
  type ModelCompactionResult,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
  type ProviderError,
  type ProviderCapabilities,
} from "./types.ts";

/** One scripted model turn. */
export interface ScriptedStep {
  /** §10.7 visible preamble. */
  readonly commentary?: string;
  readonly reasoningSummary?: string;
  /** Final answer text; presence ends the turn. */
  readonly text?: string;
  readonly toolCalls?: Array<{ callId: string; name: string; arguments: unknown | string }>;
  readonly usage?: Partial<ModelUsage>;
  /** Force an error instead of a normal completion. */
  readonly error?: ProviderError;
  /** Emit `response.incomplete` with this reason. */
  readonly incompleteReason?: string;
  /** Split text into this many deltas, to exercise streaming assembly. */
  readonly deltaChunks?: number;
  /** Duplicate every delta once, to exercise the dedupe path (§25.6). */
  readonly duplicateDeltas?: boolean;
  /** Delay before the first event, to exercise cancellation. */
  readonly delayMs?: number;
}

export interface MockProviderOptions {
  readonly steps: ScriptedStep[];
  /** Repeat the last step forever instead of failing when steps run out. */
  readonly repeatLast?: boolean;
  readonly models?: ModelDescriptor[];
  readonly validation?: CredentialValidation;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly compactionError?: ProviderError;
  readonly compactionOpaque?: string;
}

export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly capabilities: ProviderCapabilities;
  readonly requests: ModelRequest[] = [];
  readonly compactionRequests: ModelCompactionRequest[] = [];
  #index = 0;
  readonly #options: MockProviderOptions;

  constructor(options: MockProviderOptions) {
    this.#options = options;
    this.capabilities = {
      websocket: false,
      previousResponse: true,
      parallelToolCalls: false,
      nativeCompaction: false,
      fastTier: false,
      toolSearch: false,
      ...options.capabilities,
    };
  }

  get callCount(): number {
    return this.requests.length;
  }

  /** Last request, for asserting prompt assembly and tool activation. */
  get lastRequest(): ModelRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  reset(): void {
    this.#index = 0;
    this.requests.length = 0;
    this.compactionRequests.length = 0;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.#options.models ?? [...MODEL_REGISTRY];
  }

  async validateCredential(_credential: CredentialLease): Promise<CredentialValidation> {
    return (
      this.#options.validation ?? {
        status: "valid",
        checkedAt: new Date().toISOString(),
        availableModels: (this.#options.models ?? MODEL_REGISTRY).map((m) => m.id),
      }
    );
  }

  async compact(
    request: ModelCompactionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompactionResult> {
    this.compactionRequests.push(structuredClone(request));
    if (signal.aborted) {
      return {
        ok: false,
        error: { kind: "cancelled", message: "request cancelled by the user", retryable: false },
      };
    }
    if (this.#options.compactionError !== undefined) {
      return { ok: false, error: this.#options.compactionError };
    }

    const retainedUsers = request.input
      .filter((item) => item.type === "message" && item.role === "user")
      .map((item) => structuredClone(item));
    const output = [
      ...retainedUsers,
      {
        type: "compaction" as const,
        opaque: this.#options.compactionOpaque ?? `mock-compaction-${this.compactionRequests.length}`,
      },
    ];
    const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request.input).length / 4));
    const outputTokens = Math.max(1, Math.ceil(JSON.stringify(output).length / 4));
    return {
      ok: true,
      responseId: `mock-compact-${this.compactionRequests.length}`,
      output,
      usage: {
        inputTokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);

    const step = this.#nextStep();
    if (!step) {
      yield {
        type: "response.failed",
        error: {
          kind: "invalid_request",
          message: `mock provider ran out of scripted steps after ${this.#index} calls`,
          retryable: false,
        },
      };
      return;
    }

    if (step.delayMs !== undefined && step.delayMs > 0) {
      const aborted = await sleepUnlessAborted(step.delayMs, signal);
      if (aborted) {
        yield {
          type: "response.failed",
          error: { kind: "cancelled", message: "request cancelled by the user", retryable: false },
        };
        return;
      }
    }
    if (signal.aborted) {
      yield {
        type: "response.failed",
        error: { kind: "cancelled", message: "request cancelled by the user", retryable: false },
      };
      return;
    }

    yield { type: "response.started", requestId: request.requestId };

    if (step.error) {
      yield { type: "response.failed", error: step.error };
      return;
    }

    if (step.commentary !== undefined) {
      for (const chunk of chunkText(step.commentary, step.deltaChunks ?? 1)) {
        yield { type: "commentary.delta", text: chunk };
        if (step.duplicateDeltas === true) yield { type: "commentary.delta", text: chunk };
      }
    }

    if (step.reasoningSummary !== undefined) {
      yield { type: "reasoning.summary.delta", text: step.reasoningSummary };
    }

    for (const call of step.toolCalls ?? []) {
      const argumentsText =
        typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
      yield { type: "tool.call.started", callId: call.callId, name: call.name };
      for (const chunk of chunkText(argumentsText, step.deltaChunks ?? 1)) {
        yield { type: "tool.call.arguments.delta", callId: call.callId, delta: chunk };
      }
      yield {
        type: "tool.call.completed",
        call: { callId: call.callId, name: call.name, argumentsText },
      };
    }

    if (step.text !== undefined) {
      for (const chunk of chunkText(step.text, step.deltaChunks ?? 1)) {
        yield { type: "text.delta", text: chunk };
      }
    }

    const usage: ModelUsage = { ...emptyUsage(), ...step.usage };
    if (usage.totalTokens === 0) usage.totalTokens = usage.inputTokens + usage.outputTokens;
    yield { type: "usage", usage };

    if (step.incompleteReason !== undefined) {
      yield { type: "response.incomplete", reason: step.incompleteReason };
      return;
    }

    yield { type: "response.completed", responseId: `mock_resp_${this.#index}` };
  }

  #nextStep(): ScriptedStep | undefined {
    const steps = this.#options.steps;
    if (this.#index < steps.length) {
      const step = steps[this.#index];
      this.#index += 1;
      return step;
    }
    if (this.#options.repeatLast === true && steps.length > 0) {
      return steps[steps.length - 1];
    }
    return undefined;
  }
}

function chunkText(text: string, chunks: number): string[] {
  if (chunks <= 1 || text.length === 0) return [text];
  const size = Math.ceil(text.length / chunks);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build an SSE body from scripted frames, for adapter contract tests (§25.6). */
export function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
        controller.enqueue(encoder.encode(`event: message\ndata: ${payload}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Split an SSE body across arbitrary chunk boundaries. */
export function chunkedSseStream(frames: unknown[], chunkSize: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = frames
    .map((frame) => `event: message\ndata: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`)
    .join("");
  const bytes = encoder.encode(`${text}data: [DONE]\n\n`);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
      }
      controller.close();
    },
  });
}

/** A credential lease for tests. Never a real key. */
export function fakeLease(secret = "sk-mock-not-a-real-key-000000"): CredentialLease {
  return {
    leaseId: "lease_test",
    account: "openai-api",
    source: "test",
    expiresAtMs: Date.now() + 900_000,
    fingerprint: "abcdef123456",
    secret,
  };
}
