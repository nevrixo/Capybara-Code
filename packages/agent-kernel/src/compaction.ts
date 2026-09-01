import type {
  CompactionSourceBundle,
  ModelCompactionSummaryV2,
} from "@cbc/session-domain";
import {
  emptyUsage,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
  type ProviderError,
  type ReasoningEffort,
} from "@cbc/provider-openai";

export interface ContextSummaryRequest {
  readonly requestId: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxOutputTokens: number;
  readonly summaryTokenBudget: number;
  readonly sourceBundle: CompactionSourceBundle;
  readonly signal: AbortSignal;
}

export type ContextSummaryResult =
  | {
      readonly ok: true;
      readonly summary: unknown;
      readonly rawText: string;
      readonly responseId?: string;
      readonly usage: ModelUsage;
    }
  | { readonly ok: false; readonly error: ProviderError };

export interface ContextSummaryModel {
  summarize(request: ContextSummaryRequest): Promise<ContextSummaryResult>;
}

const evidenceBoundTextSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["text", "evidenceRefs"],
  additionalProperties: false,
} as const;

const todoSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    status: { type: "string", enum: ["pending", "active", "done", "blocked", "skipped"] },
    blockedReason: { type: ["string", "null"] },
  },
  required: ["id", "text", "status", "blockedReason"],
  additionalProperties: false,
} as const;

const approvalSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    display: { type: "string" },
    status: { type: "string", enum: ["pending", "approved", "denied"] },
    reason: { type: "string" },
    decisionReason: { type: ["string", "null"] },
    evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: [
    "id",
    "action",
    "display",
    "status",
    "reason",
    "decisionReason",
    "evidenceRefs",
  ],
  additionalProperties: false,
} as const;

const questionnaireSchema = {
  type: ["object", "null"],
  properties: {
    id: { type: "string" },
    reason: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["id", "question", "required"],
        additionalProperties: false,
      },
    },
    evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["id", "reason", "questions", "evidenceRefs"],
  additionalProperties: false,
} as const;

export const MODEL_COMPACTION_SUMMARY_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  $defs: {
    evidenceBoundText: evidenceBoundTextSchema,
    todo: todoSchema,
    approval: approvalSchema,
  },
  properties: {
    schemaVersion: { type: "string", enum: ["2.0"] },
    sourceDigest: { type: "string" },
    goal: { type: "string" },
    currentState: { type: "string" },
    constraints: { type: "array", items: { $ref: "#/$defs/evidenceBoundText" } },
    decisions: { type: "array", items: { $ref: "#/$defs/evidenceBoundText" } },
    completedWork: { type: "array", items: { $ref: "#/$defs/evidenceBoundText" } },
    workspaceChanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          summary: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["path", "summary", "evidenceRefs"],
        additionalProperties: false,
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: ["string", "null"] },
          status: { type: "string", enum: ["passed", "failed", "not_run"] },
          text: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["command", "status", "text", "evidenceRefs"],
        additionalProperties: false,
      },
    },
    failedApproaches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          reason: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["text", "reason", "evidenceRefs"],
        additionalProperties: false,
      },
    },
    unresolved: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          nextAction: { type: ["string", "null"] },
          evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["text", "nextAction", "evidenceRefs"],
        additionalProperties: false,
      },
    },
    todos: { type: "array", items: { $ref: "#/$defs/todo" } },
    approvals: { type: "array", items: { $ref: "#/$defs/approval" } },
    pendingQuestionnaire: questionnaireSchema,
    nextAction: { type: "string" },
  },
  required: [
    "schemaVersion",
    "sourceDigest",
    "goal",
    "currentState",
    "constraints",
    "decisions",
    "completedWork",
    "workspaceChanges",
    "verification",
    "failedApproaches",
    "unresolved",
    "todos",
    "approvals",
    "pendingQuestionnaire",
    "nextAction",
  ],
  additionalProperties: false,
};

export const MODEL_COMPACTION_SYSTEM_PROMPT = [
  "Role: Context compaction engine.",
  "",
  "You are not the task agent. Do not continue the task, write code, call tools, or propose new work.",
  "Convert only the supplied source bundle into the required JSON schema.",
  "",
  "Rules:",
  "1. Preserve the latest goal and every active user constraint.",
  "2. Preserve TODO IDs, text, exact statuses, and blocked reasons.",
  "3. Preserve pending/denied approvals and any pending questionnaire exactly.",
  "4. Separate completed work, verified work, failed approaches, and unresolved work.",
  "5. Every factual list entry must reference one or more supplied evidence IDs.",
  "6. Never claim a test passed unless the source bundle marks it passed.",
  "7. Never invent a file path, command, decision, requirement, or evidence ID.",
  "8. Stay within the supplied summary token budget.",
  "9. Return JSON only.",
].join("\n");

export function buildContextSummaryModelRequest(
  request: Omit<ContextSummaryRequest, "signal">,
): ModelRequest {
  const input = {
    summaryTokenBudget: request.summaryTokenBudget,
    sourceBundle: request.sourceBundle,
  };
  return {
    requestId: request.requestId,
    model: request.model,
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: MODEL_COMPACTION_SYSTEM_PROMPT }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(input) }],
      },
    ],
    tools: [],
    hostedTools: [],
    reasoning: {
      mode: "standard",
      effort: request.reasoningEffort,
      summary: "none",
      context: "current_turn",
    },
    maxOutputTokens: Math.max(256, Math.floor(request.maxOutputTokens)),
    responseFormat: {
      type: "json_schema",
      name: "context_compaction_summary_v2",
      schema: MODEL_COMPACTION_SUMMARY_SCHEMA,
      strict: true,
    },
    store: false,
    parallelToolCalls: false,
  };
}

export class ProviderContextSummaryModel implements ContextSummaryModel {
  readonly #provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.#provider = provider;
  }

  async summarize(request: ContextSummaryRequest): Promise<ContextSummaryResult> {
    const modelRequest = buildContextSummaryModelRequest(request);
    const deltas: string[] = [];
    const authoritative = new Map<string, { text: string; sequence: number }>();
    let usage = emptyUsage();
    let responseId: string | undefined;
    let failure: ProviderError | undefined;
    let incompleteReason: string | undefined;
    let unexpectedToolCall = false;
    try {
      for await (const event of this.#provider.stream(modelRequest, request.signal)) {
        switch (event.type) {
          case "text.delta":
            deltas.push(event.text);
            break;
          case "response.item":
            if (
              event.authoritative === true &&
              event.item.kind === "message" &&
              event.item.text !== undefined
            ) {
              authoritative.set(event.item.itemId, {
                text: event.item.text,
                sequence: event.item.sequence ?? Number.MAX_SAFE_INTEGER,
              });
            }
            break;
          case "usage":
            usage = { ...event.usage };
            break;
          case "response.completed":
            responseId = event.responseId;
            break;
          case "response.incomplete":
            incompleteReason = event.reason;
            responseId ??= event.responseId;
            break;
          case "response.failed":
            failure = event.error;
            break;
          case "tool.call.started":
          case "tool.call.completed":
          case "hosted.tool.started":
          case "hosted.tool.completed":
            unexpectedToolCall = true;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: request.signal.aborted
          ? cancelledError()
          : {
              kind: "network",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
      };
    }
    if (request.signal.aborted) return { ok: false, error: cancelledError() };
    if (failure !== undefined) return { ok: false, error: failure };
    if (incompleteReason !== undefined) {
      return {
        ok: false,
        error: {
          kind: "server",
          message: `context summary response was incomplete: ${incompleteReason}`,
          retryable: true,
        },
      };
    }
    if (unexpectedToolCall) {
      return {
        ok: false,
        error: {
          kind: "invalid_request",
          message: "context summary model attempted a tool call despite an empty tool surface",
          retryable: false,
        },
      };
    }
    const fallbackText = [...authoritative.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((item) => item.text)
      .join("");
    const rawText = deltas.length > 0 ? deltas.join("") : fallbackText;
    if (rawText.trim().length === 0) {
      return {
        ok: false,
        error: {
          kind: "server",
          message: "context summary model returned no JSON text",
          retryable: true,
        },
      };
    }
    try {
      return {
        ok: true,
        summary: JSON.parse(rawText) as ModelCompactionSummaryV2,
        rawText,
        ...(responseId === undefined ? {} : { responseId }),
        usage,
      };
    } catch {
      return {
        ok: false,
        error: {
          kind: "invalid_request",
          message: "context summary model returned invalid JSON",
          retryable: false,
        },
      };
    }
  }
}

function cancelledError(): ProviderError {
  return {
    kind: "cancelled",
    message: "context compaction was cancelled",
    retryable: false,
  };
}
