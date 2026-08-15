/**
 * Output modes — PRD §8.3, §19.3, §20.10, AC-37, AC-45.
 *
 * §19.3's fallback ladder:
 *
 * ```text
 * interactive TTY + supported renderer  → OpenTUI mode
 * interactive TTY + renderer failure    → plain interactive mode
 * non-TTY                               → plain or JSONL mode
 * --plain                               → forced line-oriented mode
 * --jsonl                               → stable machine event stream
 * ```
 *
 * §20.10's contract is enforced here rather than trusted to callers: in JSONL mode
 * **stdout carries nothing but events**. Diagnostics go to stderr. AC-37 checks
 * exactly this, and a stray `console.log` anywhere would break every consumer.
 */

import {
  EVENT_SCHEMA_VERSION,
  EventSequencer,
  createEvent,
  toJsonl,
  type CbcEvent,
  type CbcEventKind,
} from "@cbc/protocol";
import {
  Theme,
  detectCapabilities,
  renderAnsi,
  renderPlain,
  sanitizeText,
  type StyledLine,
  type TerminalCapabilities,
} from "@cbc/tui-components";

import type { Host } from "./host.ts";

export type RenderMode = "opentui" | "plain" | "jsonl";

export interface RenderDecision {
  readonly mode: RenderMode;
  readonly capabilities: TerminalCapabilities;
  readonly theme: Theme;
  /** Why this mode was chosen, for `capy doctor`. */
  readonly reason: string;
}

export interface RenderModeInput {
  readonly host: Host;
  readonly jsonl?: boolean;
  readonly plain?: boolean;
  readonly noColor?: boolean;
  /** Whether the OpenTUI renderer is available in this build (§19.3). */
  readonly rendererAvailable?: boolean;
}

/**
 * Choose the output mode.
 *
 * `--jsonl` wins over everything, including `--plain`: a caller asking for a machine
 * stream has an unambiguous requirement, and silently giving them prose would be a
 * contract break rather than a preference.
 */
export function decideRenderMode(input: RenderModeInput): RenderDecision {
  const { host } = input;

  const env = input.noColor === true ? { ...host.env, NO_COLOR: "1" } : host.env;
  const capabilities = detectCapabilities(env, {
    columns: host.io.columns,
    rows: host.io.rows,
    isTty: host.io.isTty,
  });
  const theme = new Theme({ depth: capabilities.colorDepth });

  if (input.jsonl === true) {
    return {
      mode: "jsonl",
      capabilities,
      theme: new Theme({ depth: "none" }),
      reason: "--jsonl was requested",
    };
  }
  if (input.plain === true) {
    return { mode: "plain", capabilities, theme, reason: "--plain was requested" };
  }
  if (host.io.isTty !== true) {
    return { mode: "plain", capabilities, theme, reason: "not a terminal" };
  }
  if (input.rendererAvailable === false) {
    return { mode: "plain", capabilities, theme, reason: "native renderer unavailable" };
  }
  return { mode: "opentui", capabilities, theme, reason: "interactive terminal" };
}

// ---------------------------------------------------------------------------
// §20.10 JSONL
// ---------------------------------------------------------------------------

export interface JsonlWriterOptions {
  readonly host: Host;
  readonly sessionId: string;
  /** Sequence to continue from, when resuming (§20.10 strict monotonicity). */
  readonly startAfter?: number;
}

/**
 * Emits §20.6 envelopes as one JSON object per line.
 *
 * The sequencer is owned here so §20.10's "strict monotonic within a session" holds
 * even when several subsystems emit concurrently.
 */
export class JsonlWriter {
  readonly #host: Host;
  readonly #sessionId: string;
  readonly #sequencer: EventSequencer;
  #count = 0;

  constructor(options: JsonlWriterOptions) {
    this.#host = options.host;
    this.#sessionId = options.sessionId;
    this.#sequencer = new EventSequencer(options.startAfter ?? 0);
  }

  get count(): number {
    return this.#count;
  }

  get lastSequence(): number {
    return this.#sequencer.lastSequence;
  }

  emit<T>(
    kind: CbcEventKind,
    payload: T,
    options: { turnId?: string; agentId?: string } = {},
  ): CbcEvent<T> {
    const event = createEvent(this.#sequencer, kind, payload, {
      sessionId: this.#sessionId,
      timestamp: new Date(this.#host.now()).toISOString(),
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    });
    this.write(event);
    return event;
  }

  /**
   * Forward an envelope that was built elsewhere.
   *
   * Used when the session recorder already owns the sequencer: re-numbering the event
   * here would produce two different sequences for the same session, and §20.10's
   * monotonicity guarantee is only useful if the number a consumer sees matches the
   * one the journal recorded.
   */
  forward(event: CbcEvent): void {
    this.write(event);
  }

  /** §20.10: stdout is events and nothing else. */
  write(event: CbcEvent): void {
    this.#host.io.stdout(`${toJsonl(event)}\n`);
    this.#count += 1;
  }
}

/**
 * The §8.9 / §20.10 final status event.
 *
 * §8.9 requires the exit code to appear in the event as well as on the process, so a
 * consumer reading only the stream still learns the outcome.
 */
export interface FinalStatusPayload {
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  readonly exitCode: number;
  readonly changedFiles: string[];
  readonly tests?: { passed: number; failed: number; notRun: number };
  readonly risks?: string[];
}

// ---------------------------------------------------------------------------
// Plain and styled printing
// ---------------------------------------------------------------------------

/**
 * Writes rendered lines to the host.
 *
 * In `jsonl` mode this writes to **stderr**, so a human watching a CI log still sees
 * something while stdout stays machine-clean (§8.3).
 */
export class LineWriter {
  readonly #host: Host;
  readonly #decision: RenderDecision;

  constructor(host: Host, decision: RenderDecision) {
    this.#host = host;
    this.#decision = decision;
  }

  get mode(): RenderMode {
    return this.#decision.mode;
  }

  /** Write styled lines using the decided colour depth. */
  write(lines: readonly StyledLine[]): void {
    if (lines.length === 0) return;
    const text =
      this.#decision.theme.depth === "none"
        ? renderPlain(lines)
        : renderAnsi(lines, {
            theme: this.#decision.theme,
            capabilities: this.#decision.capabilities,
            columns: this.#decision.capabilities.columns,
          });
    this.#sink(`${text}\n`);
  }

  /** Write plain text, for command output that has no styling. */
  text(value: string): void {
    this.#sink(value.endsWith("\n") ? value : `${value}\n`);
  }

  /**
   * Write text CBC itself produced (paths, counts, status lines). Trusted text is
   * emitted verbatim — it carries no foreign control sequences by construction.
   */
  trustedText(value: string): void {
    this.text(value);
  }

  /**
   * Write text that came from somewhere else — a Skill body, an HTTP error body,
   * project config, tool or process output (P1-01). It is sanitized so a hostile
   * source cannot drive the terminal with escape sequences, and truncated so it
   * cannot flood the screen.
   */
  untrustedText(value: string): void {
    this.text(sanitizeText(value));
  }

  /** Write several plain lines. */
  lines(values: readonly string[]): void {
    if (values.length === 0) return;
    this.text(values.join("\n"));
  }

  /** Diagnostics always go to stderr (§8.3). */
  diagnostic(value: string): void {
    this.#host.io.stderr(value.endsWith("\n") ? value : `${value}\n`);
  }

  #sink(text: string): void {
    if (this.#decision.mode === "jsonl") this.#host.io.stderr(text);
    else this.#host.io.stdout(text);
  }
}

export { EVENT_SCHEMA_VERSION };
