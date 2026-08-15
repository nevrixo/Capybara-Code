/** Correlated low-latency assistant text that has not landed in the timeline yet. */

import { AppendableMarkdownSourceIndex } from "@cbc/tui-components";

export type LiveSpanPhase = "progress" | "reasoning" | "reasoning_summary" | "candidate_final" | "final" | "commentary";
export type LiveSpanOutcome = "landed" | "cancelled" | "failed" | "replaced";

export interface LiveSpanKey {
  readonly turnId: string;
  readonly agentId: string;
  readonly phase: LiveSpanPhase;
  readonly itemId: string;
}

export interface LiveSpan {
  readonly key: LiveSpanKey;
  readonly text: string;
  readonly chunks: readonly string[];
  readonly revision: number;
  readonly charLength: number;
  readonly markdown: AppendableMarkdownSourceIndex;
  provisional: boolean;
  status: "open" | LiveSpanOutcome;
  readonly startedAtMs: number;
  endedAtMs?: number;
}

export interface LiveSpanView {
  readonly id: string;
  readonly key: LiveSpanKey;
  readonly chunks: readonly string[];
  readonly revision: number;
  readonly charLength: number;
  readonly provisional: boolean;
  readonly sourceView: AppendableMarkdownSourceIndex;
  fullText(): string;
}

export interface AppendLiveSpanInput {
  readonly text: string;
  readonly phase: LiveSpanPhase;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly itemId?: string;
  readonly correlationId?: string;
  readonly provisional?: boolean;
  readonly nowMs?: number;
}

export interface DurableAssistantSpan {
  readonly text: string;
  readonly phase: LiveSpanPhase;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly itemId?: string;
  readonly correlationId?: string;
}

const UNKNOWN_TURN = "turn:unknown";
const ROOT_AGENT = "root";


function keyText(key: LiveSpanKey): string {
  return `${key.turnId}\u0000${key.agentId}\u0000${key.phase}\u0000${key.itemId}`;
}


class LiveSpanRecord implements LiveSpan {
  readonly chunks: string[] = [];
  readonly markdown = new AppendableMarkdownSourceIndex();
  provisional: boolean;
  status: "open" | LiveSpanOutcome = "open";
  endedAtMs?: number;
  #revision = 0;
  #charLength = 0;

  constructor(
    readonly key: LiveSpanKey,
    text: string,
    provisional: boolean,
    readonly startedAtMs: number,
  ) {
    this.provisional = provisional;
    this.append(text);
  }

  get text(): string {
    return this.chunks.join("");
  }

  get revision(): number {
    return this.#revision;
  }

  get charLength(): number {
    return this.#charLength;
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.chunks.push(text);
    this.#charLength += text.length;
    this.#revision += 1;
    this.markdown.append(text);
  }
}

/**
 * Owns provisional provider text independently for each turn and agent.
 *
 * Durable events reconcile only with a matching span. This avoids the previous
 * global "suppress the next item" booleans, which could consume an unrelated
 * root event after a child delta or an out-of-order provider event.
 */
export class LiveSpanRegistry {
  readonly #spans = new Map<string, LiveSpanRecord>();
  #unidentifiedItemSequence = 0;

  append(input: AppendLiveSpanInput): LiveSpan | undefined {
    if (input.text.length === 0) return undefined;
    const key: LiveSpanKey = {
      turnId: input.turnId ?? UNKNOWN_TURN,
      agentId: input.agentId ?? ROOT_AGENT,
      phase: input.phase,
      // A phase is presentation metadata, never an identity. Real provider
      // events carry an item/correlation id; legacy callers without one get a
      // unique span rather than having unrelated text silently joined.
      itemId: input.itemId ?? input.correlationId ?? `unidentified:${++this.#unidentifiedItemSequence}`,
    };
    const id = keyText(key);
    const existing = this.#spans.get(id);
    if (existing !== undefined && existing.status === "open") {
      existing.append(input.text);
      existing.provisional ||= input.provisional === true;
      return existing;
    }

    const span = new LiveSpanRecord(
      key,
      input.text,
      input.provisional === true,
      input.nowMs ?? Date.now(),
    );
    this.#spans.set(id, span);
    return span;
  }

  reconcile(input: DurableAssistantSpan, nowMs = Date.now()): LiveSpan | undefined {
    const turnId = input.turnId ?? UNKNOWN_TURN;
    const agentId = input.agentId ?? ROOT_AGENT;
    const exactItemId = input.itemId ?? input.correlationId;
    // Text equality is not an identity proof: repeated prose can occur in two
    // adjacent assistant items. A durable event may only replace a live span when
    // the provider item/correlation identity is present and exactly matches.
    if (exactItemId === undefined) return undefined;

    const candidates = [...this.#spans.values()]
      .filter((span) => {
        if (span.status !== "open") return false;
        if (span.key.turnId !== turnId || span.key.agentId !== agentId) return false;
        if (span.key.itemId !== exactItemId) return false;
        return (
          span.key.phase === input.phase ||
          (span.key.phase === "candidate_final" &&
            (input.phase === "final" || input.phase === "progress"))
        );
      })
      .sort((left, right) => left.startedAtMs - right.startedAtMs);

    const span = candidates[0];
    if (span === undefined) return undefined;
    span.status = "landed";
    span.endedAtMs = nowMs;
    // Only open spans participate in rendering or future reconciliation. Return
    // the landed value to the caller for duplicate suppression, but do not retain
    // its (potentially very large) text for the rest of the session.
    this.#spans.delete(keyText(span.key));
    return span;
  }

  closeTurn(turnId: string | undefined, outcome: Exclude<LiveSpanOutcome, "landed">, nowMs = Date.now()): void {
    for (const [id, span] of this.#spans) {
      if (span.status !== "open") continue;
      if (turnId !== undefined && span.key.turnId !== turnId) continue;
      span.status = outcome;
      span.endedAtMs = nowMs;
      // Terminal outcomes are already represented by durable turn/error events.
      // Keeping closed stream text serves no presentation purpose and makes memory
      // grow with the number and size of prior responses.
      this.#spans.delete(id);
    }
  }

  rootText(phase: LiveSpanPhase, turnId?: string, provisional?: boolean): string {
    return [...this.#spans.values()]
      .filter(
        (span) =>
          span.status === "open" &&
          span.key.agentId === ROOT_AGENT &&
          span.key.phase === phase &&
          (provisional === undefined || span.provisional === provisional) &&
          (turnId === undefined || span.key.turnId === turnId),
      )
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((span) => span.text)
      .join("");
  }

  /** Stable source views for projection updates; no accumulated text join occurs. */
  rootViews(turnId?: string): readonly LiveSpanView[] {
    return [...this.#spans.values()]
      .filter(
        (span) =>
          span.status === "open" &&
          span.key.agentId === ROOT_AGENT &&
          (turnId === undefined || span.key.turnId === turnId),
      )
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((span) => ({
        id: keyText(span.key),
        key: { ...span.key },
        chunks: span.chunks,
        revision: span.revision,
        charLength: span.charLength,
        provisional: span.provisional,
        sourceView: span.markdown,
        fullText: () => span.text,
      }));
  }

  hasOpenRoot(turnId?: string): boolean {
    return [...this.#spans.values()].some(
      (span) =>
        span.status === "open" &&
        span.key.agentId === ROOT_AGENT &&
        (turnId === undefined || span.key.turnId === turnId),
    );
  }

  clear(): void {
    this.#spans.clear();
  }

  snapshot(): readonly LiveSpan[] {
    return [...this.#spans.values()].map((span) => ({
      key: { ...span.key },
      text: span.text,
      chunks: [...span.chunks],
      revision: span.revision,
      charLength: span.charLength,
      markdown: span.markdown,
      provisional: span.provisional,
      status: span.status,
      startedAtMs: span.startedAtMs,
      ...(span.endedAtMs !== undefined ? { endedAtMs: span.endedAtMs } : {}),
    }));
  }

}
