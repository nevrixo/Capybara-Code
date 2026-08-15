/**
 * Provider-neutral routing vocabulary — P1-05.
 *
 * The decisions an inference router makes (which phase a turn is in, which
 * effort to select and why) described without any provider's request shape.
 * The OpenAI adapter's policy module produces these values.
 */

import type { ReasoningEffort } from "./model.ts";

/** The phase of a turn the router is reasoning about (§10.5). */
export type TurnPhase = "commentary" | "tool_call" | "final_answer";

/** The outcome of selecting a reasoning effort (§10.4, AC-48). */
export interface EffortDecision {
  readonly effort: ReasoningEffort;
  readonly score: number;
  /** Set when the requested effort was clamped, so §AC-48 can surface it. */
  readonly clamped?: { from: ReasoningEffort; reason: string };
  /** Human-readable reason for the timeline line in §10.4. */
  readonly reason: string;
  /** True when `max` needs explicit user confirmation. */
  readonly requiresConfirmation: boolean;
}
