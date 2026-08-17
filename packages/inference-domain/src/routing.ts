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

/** Coarse work phase used for route epochs and verification-aware scheduling. */
export type WorkPhase =
  | "orient"
  | "investigate"
  | "implement"
  | "repair"
  | "verify"
  | "review"
  | "finalize";

/** Alias used by sampling controllers that do not own the turn state machine. */
export type SamplePhase = WorkPhase;

export interface RouteEpoch {
  readonly epoch: number;
  readonly phase: WorkPhase;
  readonly model: string;
  readonly effort: ReasoningEffort;
  readonly mode: string;
  readonly reason: string;
}

export interface PhaseTransition {
  readonly from: WorkPhase;
  readonly to: WorkPhase;
  readonly reason: string;
}

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
