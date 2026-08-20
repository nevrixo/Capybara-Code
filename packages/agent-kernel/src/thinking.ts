/**
 * Provider-neutral Thinking assembly.
 *
 * Provider reasoning events are transport details.  This module turns those
 * details into one semantic segment without ever manufacturing text that the
 * provider did not disclose.  It is intentionally independent from the TUI so
 * live, durable, resume, and export projections can share the same contract.
 */

export type ThinkingFragmentChannel = "detail" | "summary";
export type ThinkingBoundary = "tool" | "final" | "response_end" | "interrupted" | "failed";

export type ThinkingFragment =
  | {
      readonly kind: "delta";
      readonly channel: ThinkingFragmentChannel;
      readonly text: string;
      readonly requestId: string;
      readonly responseId?: string;
      readonly providerItemId?: string;
      readonly outputIndex?: number;
      /** A transport sequence/delta id used for duplicate suppression. */
      readonly sequence?: number;
      readonly deltaId?: string;
      readonly authoritative?: false;
    }
  | {
      readonly kind: "replace";
      readonly channel: ThinkingFragmentChannel;
      readonly text: string;
      readonly requestId: string;
      readonly responseId?: string;
      readonly providerItemId?: string;
      readonly outputIndex?: number;
      readonly sequence?: number;
      readonly deltaId?: string;
      readonly authoritative: true;
    }
  | {
      readonly kind: "boundary";
      readonly boundary: ThinkingBoundary;
      readonly requestId: string;
    };

export type ThinkingAssemblyState = "streaming" | "completed" | "interrupted" | "failed";
export type ThinkingAssemblySource = "provider_summary" | "provider_reasoning" | "status_only";
export type ThinkingAssemblySummaryOrigin = "provider" | "derived_from_visible_detail";

export interface ThinkingAssembly {
  readonly thinkingId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly requestId: string;
  readonly responseId?: string;
  readonly modelId?: string;
  readonly segmentIndex: number;
  readonly providerItemIds: readonly string[];
  readonly state: ThinkingAssemblyState;
  readonly sources: readonly ThinkingAssemblySource[];
  readonly title?: string;
  readonly summaryText?: string;
  readonly summaryOrigin?: ThinkingAssemblySummaryOrigin;
  readonly detailText?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly durationMs?: number;
  readonly truncated?: boolean;
}

export interface ThinkingAssemblerOptions {
  readonly turnId: string;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly responseId?: string;
  readonly modelId?: string;
  readonly segmentIndex?: number;
  readonly startedAtMs?: number;
  readonly maxSummaryChars?: number;
  readonly maxDetailChars?: number;
  readonly now?: () => number;
}

export interface ThinkingAssemblerUpdate {
  readonly part: ThinkingAssembly;
  readonly changed: boolean;
  readonly closed: boolean;
}

export const THINKING_MAX_SUMMARY_CHARS = 4 * 1024;
export const THINKING_MAX_DETAIL_CHARS = 64 * 1024;
const DEFAULT_MAX_SUMMARY = THINKING_MAX_SUMMARY_CHARS;
const DEFAULT_MAX_DETAIL = THINKING_MAX_DETAIL_CHARS;

/**
 * Assemble one request's semantic reasoning segments.
 *
 * `append`/`ingest` are aliases on purpose: provider adapters and tests can use
 * whichever verb best describes their event loop.  A boundary closes the open
 * segment; a later reasoning fragment starts the next segment automatically.
 */
export class ThinkingAssembler {
  readonly #turnId: string;
  readonly #agentId: string;
  readonly #requestId: string;
  readonly #responseId: string | undefined;
  readonly #modelId: string | undefined;
  readonly #maxSummaryChars: number;
  readonly #maxDetailChars: number;
  readonly #now: () => number;
  readonly #startedAtMs: number | undefined;
  #segmentIndex: number;
  #open: MutableAssembly | undefined;
  #parts: ThinkingAssembly[] = [];
  #endedAtMs: number | undefined;
  readonly #seen = new Set<string>();
  readonly #lastSequence = new Map<string, number>();

  constructor(options: ThinkingAssemblerOptions) {
    this.#turnId = options.turnId;
    this.#agentId = options.agentId ?? "root";
    this.#requestId = options.requestId ?? "request:unknown";
    this.#responseId = options.responseId;
    this.#modelId = options.modelId;
    this.#segmentIndex = Math.max(0, Math.floor(options.segmentIndex ?? 0));
    this.#startedAtMs = options.startedAtMs;
    this.#maxSummaryChars = Math.max(1, Math.floor(options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY));
    this.#maxDetailChars = Math.max(1, Math.floor(options.maxDetailChars ?? DEFAULT_MAX_DETAIL));
    this.#now = options.now ?? (() => Date.now());
  }

  get parts(): readonly ThinkingAssembly[] {
    return this.snapshot();
  }

  get hasOpenSegment(): boolean {
    return this.#open !== undefined;
  }
  /** Add a provider fragment and return the affected canonical projection. */
  append(fragment: ThinkingFragment): ThinkingAssemblerUpdate {
    if (fragment.kind === "boundary") return this.boundary(fragment.boundary, fragment.requestId);
    if (fragment.requestId !== this.#requestId) {
      return { part: this.#statusOnlyPart(), changed: false, closed: false };
    }
    if (fragment.kind === "delta" && fragment.text.length === 0) {
      return { part: this.#ensureOpen().toPublic(), changed: false, closed: false };
    }
    const duplicateKey = this.#duplicateKey(fragment);
    if (fragment.kind === "delta" && duplicateKey !== undefined && this.#seen.has(duplicateKey)) {
      return { part: this.#ensureOpen().toPublic(), changed: false, closed: false };
    }
    if (fragment.kind === "delta" && fragment.sequence !== undefined) {
      const sequenceKey = this.#sequenceKey(fragment);
      const lastSequence = this.#lastSequence.get(sequenceKey);
      if (lastSequence !== undefined && fragment.sequence <= lastSequence) {
        return { part: this.#ensureOpen().toPublic(), changed: false, closed: false };
      }
      this.#lastSequence.set(sequenceKey, fragment.sequence);
    }
    if (fragment.kind === "delta" && duplicateKey !== undefined) this.#seen.add(duplicateKey);
    const open = this.#ensureOpen();
    if (fragment.providerItemId !== undefined) open.providerItemIds.add(fragment.providerItemId);
    if (fragment.responseId !== undefined) open.responseId = fragment.responseId;
    if (fragment.kind === "replace") {
      open.replace(fragment.channel, fragment.text);
    } else {
      open.append(fragment.channel, fragment.text);
    }
    const publicPart = open.toPublic();
    this.#replacePart(publicPart);
    return { part: publicPart, changed: true, closed: false };
  }

  ingest(fragment: ThinkingFragment): ThinkingAssemblerUpdate {
    return this.append(fragment);
  }

  push(fragment: ThinkingFragment): ThinkingAssemblerUpdate {
    return this.append(fragment);
  }

  /** Close the current segment at a semantic boundary. */
  boundary(
    boundary: ThinkingBoundary,
    requestId = this.#requestId,
  ): ThinkingAssemblerUpdate {
    if (requestId !== this.#requestId) {
      return { part: this.#statusOnlyPart(), changed: false, closed: false };
    }
    const open = this.#open;
    if (open === undefined) {
      const part = this.#statusOnlyPart(this.#stateForBoundary(boundary));
      this.#open = undefined;
      this.#seen.clear();
      this.#lastSequence.clear();
      this.#segmentIndex += 1;
      return { part, changed: true, closed: true };
    }
    open.state = this.#stateForBoundary(boundary);
    open.endedAtMs = this.#now();
    const part = open.toPublic();
    this.#replacePart(part);
    this.#open = undefined;
    this.#seen.clear();
    this.#lastSequence.clear();
    this.#segmentIndex += 1;
    return { part, changed: true, closed: true };
  }

  close(boundary: "response_end" | "interrupted" | "failed" = "response_end"): ThinkingAssembly {
    return this.boundary(boundary).part;
  }

  finish(state: Exclude<ThinkingAssemblyState, "streaming"> = "completed"): ThinkingAssembly {
    const open = this.#open;
    if (open === undefined) {
      const last = this.#parts.at(-1);
      if (last !== undefined) {
        if (last.state === state) return last;
        const endedAtMs = last.endedAtMs ?? this.#now();
        const updated: ThinkingAssembly = {
          ...last,
          state,
          endedAtMs,
          durationMs: Math.max(0, endedAtMs - (last.startedAtMs ?? endedAtMs)),
        };
        this.#replacePart(updated);
        this.#endedAtMs = endedAtMs;
        return updated;
      }
      const part = this.#statusOnlyPart(state);
      this.#open = undefined;
      this.#seen.clear();
      this.#lastSequence.clear();
      this.#endedAtMs = part.endedAtMs;
      this.#segmentIndex += 1;
      return part;
    }
    open.state = state;
    open.endedAtMs = this.#now();
    const part = open.toPublic();
    this.#replacePart(part);
    this.#open = undefined;
    this.#seen.clear();
    this.#lastSequence.clear();
    this.#endedAtMs = open.endedAtMs;
    this.#segmentIndex += 1;
    return part;
  }

  finalize(state: Exclude<ThinkingAssemblyState, "streaming"> = "completed"): ThinkingAssembly {
    return this.finish(state);
  }

  /** Finalize the open segment, or create a truthful header-only part. */
  snapshot(state: ThinkingAssemblyState = "streaming"): readonly ThinkingAssembly[] {
    const parts = [...this.#parts];
    if (this.#open !== undefined) {
      const current = this.#open.toPublic(state);
      if (parts.length === 0 || parts.at(-1)?.thinkingId !== current.thinkingId) parts.push(current);
      else parts[parts.length - 1] = current;
    }
    return parts;
  }

  current(): ThinkingAssembly {
    if (this.#open !== undefined) return this.#open.toPublic();
    return this.#parts.at(-1) ?? this.#statusOnlyPart("streaming");
  }

  #ensureOpen(): MutableAssembly {
    if (this.#open !== undefined) return this.#open;
    this.#open = new MutableAssembly({
      turnId: this.#turnId,
      agentId: this.#agentId,
      requestId: this.#requestId,
      ...(this.#responseId !== undefined ? { responseId: this.#responseId } : {}),
      ...(this.#modelId !== undefined ? { modelId: this.#modelId } : {}),
      segmentIndex: this.#segmentIndex,
      startedAtMs: this.#startedAtMs ?? this.#now(),
      maxSummaryChars: this.#maxSummaryChars,
      maxDetailChars: this.#maxDetailChars,
    });
    return this.#open;
  }

  #replacePart(part: ThinkingAssembly): void {
    const index = this.#parts.findIndex((entry) => entry.thinkingId === part.thinkingId);
    if (index < 0) this.#parts.push(part);
    else this.#parts[index] = part;
  }

  #statusOnlyPart(state: ThinkingAssemblyState = "completed"): ThinkingAssembly {
    const open = this.#ensureOpen();
    open.state = state;
    if (state !== "streaming") open.endedAtMs ??= this.#endedAtMs ?? this.#now();
    const part = open.toPublic(state);
    this.#replacePart(part);
    return part;
  }

  #stateForBoundary(boundary: ThinkingBoundary): Exclude<ThinkingAssemblyState, "streaming"> {
    switch (boundary) {
      case "interrupted": return "interrupted";
      case "failed": return "failed";
      case "tool":
      case "final":
      case "response_end":
        return "completed";
    }
  }

  #sequenceKey(fragment: Exclude<ThinkingFragment, { kind: "boundary" }>): string {
    return `${fragment.channel}:${fragment.outputIndex ?? "*"}`;
  }

  #duplicateKey(fragment: Exclude<ThinkingFragment, { kind: "boundary" }>): string | undefined {
    if (fragment.deltaId !== undefined) return `id:${fragment.channel}:${fragment.deltaId}`;
    if (fragment.sequence !== undefined) return `seq:${this.#sequenceKey(fragment)}:${fragment.sequence}`;
    return undefined;
  }
}

interface MutableAssemblyOptions {
  readonly turnId: string;
  readonly agentId: string;
  readonly requestId: string;
  readonly responseId?: string;
  readonly modelId?: string;
  readonly segmentIndex: number;
  readonly startedAtMs: number;
  readonly maxSummaryChars: number;
  readonly maxDetailChars: number;
}

class MutableAssembly {
  readonly turnId: string;
  readonly agentId: string;
  readonly requestId: string;
  responseId: string | undefined;
  readonly modelId: string | undefined;
  readonly segmentIndex: number;
  readonly startedAtMs: number;
  readonly maxSummaryChars: number;
  readonly maxDetailChars: number;
  state: ThinkingAssemblyState = "streaming";
  endedAtMs?: number;
  readonly providerItemIds = new Set<string>();
  detailText = "";
  summaryText = "";
  truncated = false;

  constructor(options: MutableAssemblyOptions) {
    this.turnId = options.turnId;
    this.agentId = options.agentId;
    this.requestId = options.requestId;
    this.responseId = options.responseId;
    this.modelId = options.modelId;
    this.segmentIndex = options.segmentIndex;
    this.startedAtMs = options.startedAtMs;
    this.maxSummaryChars = options.maxSummaryChars;
    this.maxDetailChars = options.maxDetailChars;
  }

  get thinkingId(): string {
    return `thinking:${this.turnId}:${this.agentId}:${this.requestId}:${this.segmentIndex}`;
  }

  append(channel: ThinkingFragmentChannel, text: string): void {
    if (channel === "detail") this.detailText = this.#bounded(this.detailText + text, this.maxDetailChars);
    else this.summaryText = this.#bounded(this.summaryText + text, this.maxSummaryChars);
  }

  replace(channel: ThinkingFragmentChannel, text: string): void {
    if (channel === "detail") this.detailText = this.#bounded(text, this.maxDetailChars);
    else this.summaryText = this.#bounded(text, this.maxSummaryChars);
  }

  toPublic(state = this.state): ThinkingAssembly {
    const summary = parseSummary(this.summaryText);
    const detail = this.detailText.trim();
    const summaryBody = summary.body.trim();
    const sources: ThinkingAssemblySource[] = [];
    if (summaryBody.length > 0 || summary.title.length > 0) sources.push("provider_summary");
    if (detail.length > 0) sources.push("provider_reasoning");
    if (sources.length === 0) sources.push("status_only");
    const summaryText = summaryBody || summary.title || (detail.length > 0 ? derivePreview(detail) : "");
    const summaryOrigin: ThinkingAssemblySummaryOrigin | undefined =
      summaryBody.length > 0 || summary.title.length > 0
        ? "provider"
        : detail.length > 0
          ? "derived_from_visible_detail"
          : undefined;
    const endedAtMs = this.endedAtMs;
    const durationMs = endedAtMs === undefined ? undefined : Math.max(0, endedAtMs - this.startedAtMs);
    return {
      thinkingId: this.thinkingId,
      turnId: this.turnId,
      agentId: this.agentId,
      requestId: this.requestId,
      ...(this.responseId !== undefined ? { responseId: this.responseId } : {}),
      ...(this.modelId !== undefined ? { modelId: this.modelId } : {}),
      segmentIndex: this.segmentIndex,
      providerItemIds: [...this.providerItemIds],
      state,
      sources,
      ...(summary.title.length > 0 ? { title: summary.title } : {}),
      ...(summaryText.length > 0 ? { summaryText } : {}),
      ...(summaryOrigin !== undefined ? { summaryOrigin } : {}),
      ...(detail.length > 0 ? { detailText: detail } : {}),
      startedAtMs: this.startedAtMs,
      ...(endedAtMs !== undefined ? { endedAtMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  #bounded(value: string, max: number): string {
    if (value.length <= max) return value;
    this.truncated = true;
    return value.slice(0, max);
  }
}

function parseSummary(value: string): { readonly title: string; readonly body: string } {
  const trimmed = value.trim();
  const match = /^\*\*([^*\n]{1,80})\*\*\s*(?:\n+\s*\n+|\n+)?([\s\S]*)$/u.exec(trimmed);
  if (match === null) return { title: "", body: trimmed };
  return { title: match[1]?.trim() ?? "", body: match[2]?.trim() ?? "" };
}

function derivePreview(value: string): string {
  const first = value
    .split(/(?:\r?\n)+/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (first ?? "").slice(0, 160);
}
