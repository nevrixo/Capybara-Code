/** Provider response-item fidelity without persisting raw chain-of-thought. */

export type ResponseItemKind = "message" | "function_call" | "function_call_output" | "reasoning" | "unknown";

export interface ProviderResponseItem {
  readonly type: ResponseItemKind;
  readonly id?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly argumentsText?: string;
  readonly output?: string;
  readonly text?: string;
  /** Encrypted/opaque reasoning returned by the provider. Never inspect it. */
  readonly encryptedContent?: string;
  readonly phase?: "commentary" | "final_answer";
  readonly raw?: Record<string, unknown>;
}

export interface ResponseItemEnvelope {
  readonly responseId?: string;
  readonly itemId: string;
  readonly sequence: number;
  readonly kind: ResponseItemKind;
  readonly callerId?: string;
  readonly programId?: string;
  readonly agentId?: string;
  readonly phase?: "commentary" | "final_answer";
  readonly item: ProviderResponseItem;
  /** True for opaque reasoning, allowing UI/export code to redact by default. */
  readonly opaque: boolean;
}

export interface ResponseItemMetadata {
  readonly responseId?: string;
  readonly itemId?: string;
  readonly sequence?: number;
  readonly callerId?: string;
  readonly programId?: string;
  readonly agentId?: string;
  readonly phase?: "commentary" | "final_answer";
}

/** Normalize a provider item while retaining only replay-relevant fields. */
export function normalizeResponseItem(
  raw: unknown,
  metadata: ResponseItemMetadata = {},
): ResponseItemEnvelope {
  const source = isRecord(raw) ? raw : {};
  const type = typeof source.type === "string" ? source.type : "unknown";
  const kind = responseKind(type);
  const encryptedContent = source.encrypted_content !== undefined ? boundedOpaque(source.encrypted_content) : undefined;
  const item: ProviderResponseItem = {
    type: kind,
    ...(typeof source.id === "string" ? { id: source.id } : {}),
    ...(typeof source.call_id === "string" ? { callId: source.call_id } : {}),
    ...(typeof source.name === "string" ? { name: source.name } : {}),
    ...(typeof source.arguments === "string" ? { argumentsText: source.arguments } : {}),
    ...(typeof source.output === "string" ? { output: source.output } : {}),
    ...(typeof source.text === "string" ? { text: source.text } : {}),
    ...(encryptedContent !== undefined ? { encryptedContent } : {}),
    ...(metadata.phase !== undefined ? { phase: metadata.phase } : typeof source.phase === "string" && isPhase(source.phase) ? { phase: source.phase } : {}),
    // Unknown provider fields remain opaque but are bounded and never executable.
    ...(kind === "unknown" ? { raw: boundedRecord(source) } : {}),
  };
  const itemId = metadata.itemId ?? (typeof source.id === "string" ? source.id : `item_${metadata.sequence ?? 0}`);
  const sequence = Number.isInteger(metadata.sequence) && (metadata.sequence ?? 0) >= 0 ? metadata.sequence! : 0;
  return {
    ...(metadata.responseId !== undefined ? { responseId: metadata.responseId } : {}),
    itemId,
    sequence,
    kind,
    ...(metadata.callerId !== undefined ? { callerId: metadata.callerId } : {}),
    ...(metadata.programId !== undefined ? { programId: metadata.programId } : {}),
    ...(metadata.agentId !== undefined ? { agentId: metadata.agentId } : {}),
    ...(item.phase !== undefined ? { phase: item.phase } : {}),
    item,
    opaque: kind === "reasoning" || kind === "unknown",
  };
}

export type ReplayInputAncestry = { readonly callerId?: string; readonly programId?: string; readonly agentId?: string };

export type ReplayInputItem =
  | ({ readonly type: "message"; readonly role: "assistant"; readonly text: string; readonly phase?: "commentary" | "final_answer" } & ReplayInputAncestry)
  | ({ readonly type: "function_call"; readonly callId: string; readonly name: string; readonly argumentsText: string } & ReplayInputAncestry)
  | ({ readonly type: "function_call_output"; readonly callId: string; readonly output: string } & ReplayInputAncestry)
  | ({ readonly type: "reasoning"; readonly opaque: string; readonly summaryText?: string } & ReplayInputAncestry);

/** Convert complete response envelopes to stateless replay items. */
export function replayableResponseItems(envelopes: readonly ResponseItemEnvelope[]): ReplayInputItem[] {
  const output: ReplayInputItem[] = [];
  for (const envelope of [...envelopes].sort((a, b) => a.sequence - b.sequence)) {
    const item = envelope.item;
    switch (envelope.kind) {
      case "message":
        if (item.text !== undefined && item.text.length > 0) {
          output.push({ type: "message", role: "assistant", text: item.text, ...(item.phase !== undefined ? { phase: item.phase } : {}), ...ancestryOf(envelope) });
        }
        break;
      case "function_call":
        if (item.callId !== undefined && item.name !== undefined) {
          output.push({ type: "function_call", callId: item.callId, name: item.name, argumentsText: item.argumentsText ?? "", ...ancestryOf(envelope) });
        }
        break;
      case "function_call_output":
        if (item.callId !== undefined) output.push({ type: "function_call_output", callId: item.callId, output: item.output ?? "", ...ancestryOf(envelope) });
        break;
      case "reasoning":
        if (item.encryptedContent !== undefined && item.encryptedContent.length > 0) {
          output.push({ type: "reasoning", opaque: item.encryptedContent, ...(item.text !== undefined ? { summaryText: item.text } : {}), ...ancestryOf(envelope) });
        }
        break;
      case "unknown":
        // Unknown items are retained by the journal as envelopes, but cannot be
        // replayed into a model request until a reader understands their type.
        break;
    }
  }
  return output;
}

/** Export-safe projection: opaque reasoning is excluded unless explicitly requested. */
export function exportResponseItem(
  envelope: ResponseItemEnvelope,
  options: { readonly includeOpaque?: boolean } = {},
): Record<string, unknown> | undefined {
  if (envelope.opaque && options.includeOpaque !== true) return undefined;
  return {
    itemId: envelope.itemId,
    sequence: envelope.sequence,
    kind: envelope.kind,
    ...(envelope.responseId !== undefined ? { responseId: envelope.responseId } : {}),
    ...(envelope.callerId !== undefined ? { callerId: envelope.callerId } : {}),
    ...(envelope.programId !== undefined ? { programId: envelope.programId } : {}),
    ...(envelope.agentId !== undefined ? { agentId: envelope.agentId } : {}),
    ...(envelope.phase !== undefined ? { phase: envelope.phase } : {}),
    ...(envelope.kind === "reasoning"
      ? { hasOpaqueContent: envelope.item.encryptedContent !== undefined, summary: envelope.item.text }
      : { item: envelope.item }),
  };
}

function ancestryOf(envelope: ResponseItemEnvelope): ReplayInputAncestry {
  return {
    ...(envelope.callerId !== undefined ? { callerId: envelope.callerId } : {}),
    ...(envelope.programId !== undefined ? { programId: envelope.programId } : {}),
    ...(envelope.agentId !== undefined ? { agentId: envelope.agentId } : {}),
  };
}

function boundedOpaque(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? undefined : text.slice(0, 65_536);
}

function responseKind(type: string): ResponseItemKind {
  if (type === "message" || type === "output_text") return "message";
  if (type === "function_call") return "function_call";
  if (type === "function_call_output") return "function_call_output";
  if (type === "reasoning") return "reasoning";
  return "unknown";
}

function isPhase(value: unknown): value is "commentary" | "final_answer" {
  return value === "commentary" || value === "final_answer";
}

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    if (typeof entry === "string") output[key] = entry.slice(0, 4096);
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) output[key] = entry;
    else if (Array.isArray(entry)) output[key] = entry.slice(0, 16);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export interface ResponseReplayPlan {
  readonly mode: "previous_response" | "items";
  readonly previousResponseId?: string;
  readonly items: readonly ReplayInputItem[];
  /** Older readers must not write when an opaque item cannot be understood. */
  readonly compatible: boolean;
  readonly reason: string;
}

/** Prefer provider-side continuation when it is explicitly available; otherwise
 * replay the complete bounded response-item sequence without inventing hidden
 * reasoning text. */
export function buildResponseReplayPlan(
  envelopes: readonly ResponseItemEnvelope[],
  options: { readonly previousResponseId?: string; readonly providerContinuationAvailable?: boolean } = {},
): ResponseReplayPlan {
  if (options.previousResponseId !== undefined && options.providerContinuationAvailable === true) {
    return {
      mode: "previous_response",
      previousResponseId: options.previousResponseId,
      items: [],
      compatible: true,
      reason: "provider-owned response continuation is available",
    };
  }
  const items = replayableResponseItems(envelopes);
  const hasOpaque = envelopes.some((envelope) => envelope.opaque && envelope.item.type === "reasoning");
  return {
    mode: "items",
    items,
    compatible: !hasOpaque || items.some((item) => item.type === "reasoning"),
    reason: hasOpaque ? "complete response items are replayed with opaque reasoning preserved" : "complete response items are replayed locally",
  };
}
