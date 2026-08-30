/**
 * §6.3 `/learn` — the Strategy Capsule review surface (P1-01).
 *
 * The verbs are deliberately thin: every decision they make is enforced inside
 * CapsuleStore, so this module parses, delegates, and renders. That is what
 * keeps the §6.3 gates honest — a caller cannot activate a workspace capsule by
 * reaching a different code path, because the refusal lives in the store rather
 * than in this dispatcher.
 *
 * Capsule state lives in the session's MemoryService and is not yet journalled
 * through the runtime memory store, so the headless command reports the
 * effective policy and defers the lifecycle verbs to the interactive session
 * that owns them.
 */

import type { MemoryService, StrategyCapsule } from "@cbc/memory-service";

import type { Command } from "../args.ts";
import { EXIT } from "../exit.ts";
import type { CommandContext, CommandResult } from "./context.ts";

export type LearnAction = "review" | "accept" | "reject" | "forget" | "rollback";

export const LEARN_ACTIONS: readonly LearnAction[] = Object.freeze([
  "review",
  "accept",
  "reject",
  "forget",
  "rollback",
]);

export function isLearnAction(value: string | undefined): value is LearnAction {
  return value !== undefined && (LEARN_ACTIONS as readonly string[]).includes(value);
}

/** Accepts a bare digest as well as a full id, matching /memory's handling. */
export function normalizeCapsuleId(argument: string): `capsule-${string}` {
  const trimmed = argument.trim();
  return (trimmed.startsWith("capsule-") ? trimmed : `capsule-${trimmed}`) as `capsule-${string}`;
}

export interface LearnRequest {
  readonly action: LearnAction;
  readonly argument?: string;
}

export interface LearnOutcome {
  readonly lines: readonly string[];
  /** False when the request could not be carried out, so callers can style it. */
  readonly ok: boolean;
}

/**
 * Apply one `/learn` verb against a live MemoryService. Errors become rendered
 * lines rather than throwing: a mistyped capsule id should not end the turn.
 */
export function applyLearnRequest(service: MemoryService, request: LearnRequest): LearnOutcome {
  if (request.action === "review") {
    return { ok: true, lines: renderCapsuleReview(service) };
  }
  if (request.argument === undefined || request.argument.trim().length === 0) {
    return { ok: false, lines: [`/learn ${request.action} needs a capsule id. Run /learn review first.`] };
  }
  const id = normalizeCapsuleId(request.argument);
  try {
    switch (request.action) {
      case "accept": {
        // §6.3: reaching accept through the command *is* the user approval that
        // workspace and user scope require; the store still enforces the
        // observation threshold, so an accept can legitimately be refused.
        const result = service.activateCapsule(id, { approved: true, reason: "accepted from /learn" });
        if (!result.activated) {
          return {
            ok: false,
            lines: [`Cannot activate ${id} yet:`, ...result.reasons.map((reason) => `  ${reason}`)],
          };
        }
        return { ok: true, lines: [`Activated ${id}.`, `  ${describeCapsule(result.capsule)}`] };
      }
      case "reject": {
        const capsule = service.rejectCapsule(id, "rejected from /learn");
        return { ok: true, lines: [`Rejected ${capsule.id}; it will not be recalled.`] };
      }
      case "forget": {
        const capsule = service.forgetCapsule(id, "forgotten from /learn");
        return { ok: true, lines: [`Forgot ${capsule.id}; its audit history is retained.`] };
      }
      case "rollback": {
        const capsule = service.rollbackCapsule(id);
        return {
          ok: true,
          lines: [
            `Rolled ${capsule.id} back to revision ${capsule.revision}; it is ${capsule.status} again.`,
            `  ${describeCapsule(capsule)}`,
          ],
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      lines: [`/learn ${request.action} failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * §6.4's audit view. It shows evidence count, observation count, and
 * invalidators, because "why is this active" and "what would retire it" are the
 * two questions the user cannot answer from a statement alone.
 */
export function renderCapsuleReview(service: MemoryService): readonly string[] {
  const view = service.auditCapsules();
  const header = `strategy capsules: policy ${view.policy}, ${view.minVerifiedObservations} verified observations required`;
  if (view.capsules.length === 0) {
    return [header, "No strategy capsules have been proposed in this session."];
  }
  const lines: string[] = [header];
  for (const capsule of view.capsules) {
    lines.push(`[${capsule.status}/${capsule.scope}] ${capsule.id}`);
    lines.push(`  ${capsule.statement}`);
    lines.push(`  ${describeCapsule(capsule)}`);
    if (capsule.invalidators.length > 0) {
      lines.push(`  invalidated by: ${capsule.invalidators.join("; ")}`);
    }
  }
  return lines;
}

function describeCapsule(capsule: StrategyCapsule): string {
  const parts = [
    capsule.kind,
    `${capsule.observedCount} observation(s)`,
    `${capsule.evidenceIds.length} evidence`,
    `confidence ${capsule.confidence.toFixed(2)}`,
    `revision ${capsule.revision}`,
  ];
  if (capsule.expiresAt !== undefined) parts.push(`expires ${capsule.expiresAt}`);
  return parts.join(", ");
}

type LearnCommand = Extract<Command, { readonly kind: "learn" }>;

/**
 * Headless `capy learn`. Capsules are session state, so this reports the
 * effective §8.4 policy rather than pretending to hold a lifecycle it cannot
 * reach; the verbs run inside an interactive session.
 */
export async function learnCommand(
  context: CommandContext,
  command: LearnCommand,
): Promise<CommandResult> {
  const config = await context.requireConfig();
  const learning = config.agent.learning;
  context.outLines([
    `strategy_capsules = "${learning.strategyCapsules}"`,
    `min_verified_observations = ${learning.minVerifiedObservations}`,
  ]);
  if (learning.strategyCapsules === "off") {
    context.outLines(["Strategy capsule learning is disabled; no capsule will be proposed."]);
    return { code: EXIT.ok };
  }
  context.outLines(
    command.sub === "review"
      ? ["Capsules are session state: run /learn review inside a session to audit them."]
      : [`Run /learn ${command.sub} <id> inside a session; capsule state is not stored outside one.`],
  );
  return { code: EXIT.ok };
}
