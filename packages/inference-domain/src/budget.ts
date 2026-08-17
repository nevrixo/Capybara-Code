/**
 * Deterministic turn-level budget guard.
 *
 * The ledger is deliberately provider-neutral. A host may run it in shadow or
 * advisory mode during rollout; hard mode refuses a request once spent plus
 * active/future reservations would exceed the ceiling.
 */
export type BudgetEnforcementMode = "shadow" | "advisory" | "hard";
export type BudgetAction = "allow" | "recompile" | "reroute" | "deny";

export interface TurnBudgetLedger {
  readonly ceilingUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly futureReservationsUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly remainingUsd: number;
}

export interface BudgetAuthorizationRequest {
  readonly sampleId?: string;
  readonly predictedInputTokens: number;
  readonly predictedOutputTokens: number;
  readonly predictedCostUsd: number;
  readonly phase?: string;
  readonly mandatoryVerification?: boolean;
  readonly mandatoryReview?: boolean;
  readonly optionalWork?: boolean;
}

export interface BudgetAuthorization {
  readonly action: BudgetAction;
  readonly allowed: boolean;
  readonly mode: BudgetEnforcementMode;
  readonly projectedUsd: number;
  readonly remainingUsd: number;
  readonly reason: string;
  readonly degraded?: "context" | "output" | "cheap_route" | "optional_work" | "partial";
}

export interface TurnBudgetControllerOptions {
  readonly ceilingUsd: number;
  readonly mode?: BudgetEnforcementMode;
  readonly reserveUsd?: number;
  readonly now?: () => number;
}

export class TurnBudgetController {
  readonly #ceilingUsd: number;
  readonly #mode: BudgetEnforcementMode;
  readonly #futureReservationsUsd: number;
  readonly #reservations = new Map<string, number>();
  #spentUsd = 0;
  #reservedUsd = 0;
  #inputTokens = 0;
  #outputTokens = 0;

  constructor(options: TurnBudgetControllerOptions) {
    this.#ceilingUsd = Math.max(0, finite(options.ceilingUsd));
    this.#mode = options.mode ?? "advisory";
    this.#futureReservationsUsd = Math.max(0, finite(options.reserveUsd ?? 0));
  }

  get mode(): BudgetEnforcementMode {
    return this.#mode;
  }

  reset(): void {
    this.#reservations.clear();
    this.#spentUsd = 0;
    this.#reservedUsd = 0;
    this.#inputTokens = 0;
    this.#outputTokens = 0;
  }

  snapshot(): TurnBudgetLedger {
    const remainingUsd = Math.max(
      0,
      this.#ceilingUsd -
        this.#spentUsd -
        this.#reservedUsd -
        this.#futureReservationsUsd,
    );
    return {
      ceilingUsd: this.#ceilingUsd,
      spentUsd: this.#spentUsd,
      reservedUsd: this.#reservedUsd,
      futureReservationsUsd: this.#futureReservationsUsd,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      remainingUsd,
    };
  }

  reserve(id: string, amountUsd: number): boolean {
    const amount = Math.max(0, finite(amountUsd));
    if (this.#mode === "hard" && this.#spentUsd + this.#reservedUsd + amount > this.#ceilingUsd) return false;
    const previous = this.#reservations.get(id) ?? 0;
    this.#reservedUsd += amount - previous;
    this.#reservations.set(id, amount);
    return true;
  }

  release(id: string): number {
    const amount = this.#reservations.get(id) ?? 0;
    this.#reservations.delete(id);
    this.#reservedUsd = Math.max(0, this.#reservedUsd - amount);
    return amount;
  }

  record(sampleId: string | undefined, usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number }): void {
    if (sampleId !== undefined) this.release(sampleId);
    this.#spentUsd += Math.max(0, finite(usage.costUsd));
    this.#inputTokens += Math.max(0, Math.floor(usage.inputTokens));
    this.#outputTokens += Math.max(0, Math.floor(usage.outputTokens));
  }

  authorize(request: BudgetAuthorizationRequest): BudgetAuthorization {
    const projectedUsd =
      this.#spentUsd +
      this.#reservedUsd +
      this.#futureReservationsUsd +
      Math.max(0, finite(request.predictedCostUsd));
    const remainingUsd = Math.max(
      0,
      this.#ceilingUsd -
        this.#spentUsd -
        this.#reservedUsd -
        this.#futureReservationsUsd,
    );
    if (projectedUsd <= this.#ceilingUsd) {
      return {
        action: "allow",
        allowed: true,
        mode: this.#mode,
        projectedUsd,
        remainingUsd,
        reason: "within turn budget",
      };
    }
    const overflow = projectedUsd - this.#ceilingUsd;
    if (this.#mode === "shadow" || this.#mode === "advisory") {
      return {
        action: "allow",
        allowed: true,
        mode: this.#mode,
        projectedUsd,
        remainingUsd,
        reason: "budget exceeded in shadow mode",
      };
    }
    if (request.mandatoryVerification === true || request.mandatoryReview === true) {
      return {
        action: "deny",
        allowed: false,
        mode: this.#mode,
        projectedUsd,
        remainingUsd,
        reason: "mandatory verification or review cannot be silently removed",
        degraded: "partial",
      };
    }
    if (request.optionalWork === true) {
      return {
        action: "deny",
        allowed: false,
        mode: this.#mode,
        projectedUsd,
        remainingUsd,
        reason: "optional work was removed to preserve the turn ceiling",
        degraded: "optional_work",
      };
    }
    if (request.predictedInputTokens > 0 && overflow < Math.max(0.01, request.predictedCostUsd * 0.75)) {
      return {
        action: "recompile",
        allowed: false,
        mode: this.#mode,
        projectedUsd,
        remainingUsd,
        reason: "reduce context before requesting the provider",
        degraded: "context",
      };
    }
    if (request.predictedOutputTokens > 0 && overflow < Math.max(0.01, request.predictedCostUsd * 0.9)) {
      return {
        action: "reroute",
        allowed: false,
        mode: this.#mode,
        projectedUsd,
        remainingUsd,
        reason: "reduce output or use the cheap route",
        degraded: "cheap_route",
      };
    }
    return {
      action: "deny",
      allowed: false,
      mode: this.#mode,
      projectedUsd,
      remainingUsd,
      reason: "turn budget exhausted",
      degraded: "partial",
    };
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}