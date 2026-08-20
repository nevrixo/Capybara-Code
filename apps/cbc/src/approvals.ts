/**
 * Approval brokers — PRD §7.6, §13.2, §13.4, §13.8, AC-18, AC-19, AC-38.
 *
 * Two brokers, because §13.8 makes non-interactive approval a different problem
 * rather than a degraded version of the same one:
 *
 *   - Interactive: show the §7.6 card, offer only the scopes the policy actually
 *     permits, and record a granted rule so the same action does not re-ask.
 *   - Headless: never prompt. `deny-on-ask` denies and lets the model adapt,
 *     `fail-on-ask` aborts the run with exit code 4, and `allow-listed` consults a
 *     pre-approved list. AC-38 requires the run to exit 4 rather than hang, so
 *     there is no code path here that waits for input.
 */

import type { ApprovalBroker } from "@cbc/agent-kernel";
import {
  commandPrefixRule,
  renderApprovalCard,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalRule,
  type StoredRule,
} from "@cbc/permissions";
import { approvalChoices } from "@cbc/tui-components";

import { CliError, EXIT } from "./exit.ts";
import type { Host } from "./host.ts";

/** Rules granted during this session, held by the host rather than the kernel. */
export class GrantedRules {
  readonly #rules: StoredRule[] = [];

  get all(): readonly StoredRule[] {
    return this.#rules;
  }

  add(rule: StoredRule): void {
    this.#rules.push(rule);
  }

  /** Turn-scoped grants are dropped when the turn ends (§13.4). */
  clearTurnScoped(): void {
    // `allow_turn` is not stored as a rule at all — it is applied for the rest of
    // the batch and then forgotten. This exists so callers have one obvious place
    // to reset per-turn state if that ever changes.
  }
}

export interface InteractiveBrokerOptions {
  readonly host: Host;
  readonly granted: GrantedRules;
  /** Called after a decision so the timeline can record it (§20.7). */
  readonly onResolved?: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  /** Overrides the card presentation when the full TUI is driving (§6.4). */
  readonly present?: (
    request: ApprovalRequest,
    choices: readonly string[],
  ) => Promise<number>;
  /** Collected when the user picks "Deny and explain" (§7.6). */
  readonly explain?: () => Promise<string>;
  /**
   * Persists an "Always allow" grant so it survives this process (P0-13). The
   * in-memory grant applies immediately either way; a persistence failure only
   * costs future runs, and is surfaced through the diagnostics sink.
   */
  readonly persistRule?: (rule: StoredRule) => Promise<void>;
  readonly diagnostic?: (line: string) => void;
}

/**
 * The interactive broker.
 *
 * The choice list comes from `approvalChoices(request.offeredScopes)` rather than
 * being spelled out here, so §13.2's rule that R4–R6 never get a broad grant is
 * enforced by the policy engine and simply reflected in the UI.
 */
export class InteractiveApprovalBroker implements ApprovalBroker {
  readonly #options: InteractiveBrokerOptions;

  constructor(options: InteractiveBrokerOptions) {
    this.#options = options;
  }

  async request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return { kind: "deny", reason: "cancelled" };

    const choices = approvalChoices(request.offeredScopes);
    const index =
      this.#options.present !== undefined
        ? await this.#options.present(request, choices)
        : await this.#promptPlain(request, choices);

    const decision = await this.#decisionFor(request, choices, index);
    this.#options.onResolved?.(request, decision);
    return decision;
  }

  async #promptPlain(
    request: ApprovalRequest,
    choices: readonly string[],
  ): Promise<number> {
    // The line-oriented card goes to stderr so normal stdout remains available for
    // the answer (§8.3).
    for (const line of renderApprovalCard(request)) {
      this.#options.host.io.stderr(`${line}\n`);
    }
    return await this.#options.host.io.select("", choices);
  }

  async #decisionFor(
    request: ApprovalRequest,
    choices: readonly string[],
    index: number,
  ): Promise<ApprovalDecision> {
    // Cancelling the picker is a denial, never an allow.
    if (index < 0 || index >= choices.length) {
      return { kind: "deny", reason: "no decision was made" };
    }
    const choice = choices[index] as string;

    if (choice === "Allow once") return { kind: "allow_once" };
    if (choice === "Allow for this turn") return { kind: "allow_turn" };

    if (choice === "Allow for this session") {
      const rule = this.#ruleFor(request);
      const decision: ApprovalDecision = { kind: "allow_session", rule };
      this.#options.granted.add({
        rule,
        scope: "session",
        decision: "allow",
        grantedForRisk: request.riskClass,
      });
      return decision;
    }

    if (choice.startsWith("Always allow")) {
      const rule = this.#ruleFor(request);
      const decision: ApprovalDecision = { kind: "allow_project", rule };
      const stored: StoredRule = {
        rule,
        scope: "project",
        decision: "allow",
        grantedForRisk: request.riskClass,
      };
      this.#options.granted.add(stored);
      // P0-13: the grant must outlive this process. The in-memory rule already
      // applies to this run; persistence is best-effort but its failure is said
      // aloud rather than silently forgotten.
      if (this.#options.persistRule !== undefined) {
        try {
          await this.#options.persistRule(stored);
        } catch (error) {
          this.#options.diagnostic?.(
            `could not persist approval rule: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return decision;
    }

    if (choice === "Deny and explain") {
      const explanation = (await this.#options.explain?.()) ?? "";
      return explanation.length > 0
        ? { kind: "deny", reason: explanation }
        : { kind: "deny" };
    }

    return { kind: "deny" };
  }

  /**
   * Build the rule a broad grant implies.
   *
   * The policy engine attaches the exact `ruleCandidate` it derived from the
   * normalized action (§7.6), so "always allow this command prefix" persists the
   * command prefix — not a tool-wide grant wider than what the user approved.
   * The tool-scoped fallback only applies to actions with no command shape, and
   * it stays the safe (narrower) direction to be wrong in.
   */
  #ruleFor(request: ApprovalRequest): ApprovalRule {
    return request.ruleCandidate ?? { tool: request.action, network: request.network };
  }
}

export { commandPrefixRule };

export interface HeadlessBrokerOptions {
  readonly policy: "deny-on-ask" | "allow-listed" | "fail-on-ask";
  /** Rules that pre-approve an action, from config (§13.3). */
  readonly allowList?: readonly StoredRule[];
  readonly onResolved?: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  /** Diagnostics sink kept separate from normal command output. */
  readonly diagnostic?: (line: string) => void;
}

/**
 * The headless broker (§13.8, AC-38).
 *
 * `allow-listed` is deliberately thin: by the time an approval request reaches a
 * broker, the policy engine has already applied every rule it was given. A request
 * arriving here under `allow-listed` therefore means *no* rule matched, so the only
 * honest answer is a denial. Re-implementing rule matching here would be a second
 * matcher that could disagree with the first — exactly the kind of divergence
 * §24.1's "TypeScript cannot bypass a hard boundary" invariant is meant to prevent.
 */
export class HeadlessApprovalBroker implements ApprovalBroker {
  readonly #options: HeadlessBrokerOptions;

  constructor(options: HeadlessBrokerOptions) {
    this.#options = options;
  }

  async request(request: ApprovalRequest, _signal: AbortSignal): Promise<ApprovalDecision> {
    const reason = `approval is required for ${request.action} (${request.riskClass}) but this run is non-interactive`;

    if (this.#options.policy === "fail-on-ask") {
      // §8.9 code 4: approval was needed and unavailable.
      throw new CliError(EXIT.permission, reason, [
        `Action: ${request.display}`,
        `Reason: ${request.reason}`,
        "Re-run interactively, or pre-approve it in the permissions config.",
      ]);
    }

    this.#options.diagnostic?.(`denied: ${reason}`);
    const decision: ApprovalDecision = { kind: "deny", reason };
    this.#options.onResolved?.(request, decision);
    return decision;
  }
}

/** Choose the broker for a run. */
export function createApprovalBroker(options: {
  readonly nonInteractive: boolean;
  readonly headlessPolicy?: "deny-on-ask" | "allow-listed" | "fail-on-ask";
  readonly interactive?: InteractiveBrokerOptions;
  readonly headless?: Omit<HeadlessBrokerOptions, "policy">;
}): ApprovalBroker {
  if (options.nonInteractive || options.interactive === undefined) {
    return new HeadlessApprovalBroker({
      policy: options.headlessPolicy ?? "deny-on-ask",
      ...(options.headless ?? {}),
    });
  }
  return new InteractiveApprovalBroker(options.interactive);
}
