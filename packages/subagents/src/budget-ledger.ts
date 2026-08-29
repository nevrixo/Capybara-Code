export interface GraphBudgetLimits {
  readonly maxToolCalls: number;
  readonly maxModelCalls: number;
  readonly maxWallClockMs: number;
  readonly maxContextTokens: number;
  readonly maxCostUsd: number;
}

export interface GraphBudgetAmount {
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly wallClockMs: number;
  readonly contextTokens: number;
  readonly costUsd: number;
}

export interface GraphBudgetReservation extends GraphBudgetAmount {
  readonly nodeId: string;
  readonly parentId: string;
  readonly reservedAt: string;
  readonly state: "reserved" | "settled" | "released";
  readonly actual?: GraphBudgetAmount;
}

export interface GraphBudgetSnapshot {
  readonly schemaVersion: "1.0";
  readonly limits: GraphBudgetLimits;
  readonly reservations: readonly GraphBudgetReservation[];
  readonly consumed: GraphBudgetAmount;
}

export class GraphBudgetExceeded extends Error {
  readonly resource: keyof GraphBudgetAmount;

  constructor(resource: keyof GraphBudgetAmount) {
    super("agent graph " + resource + " budget is exhausted");
    this.name = "GraphBudgetExceeded";
    this.resource = resource;
  }
}

export class GraphBudgetLedger {
  readonly #limits: GraphBudgetLimits;
  readonly #reservations = new Map<string, GraphBudgetReservation>();
  #consumed: GraphBudgetAmount = zeroAmount();

  constructor(limits: GraphBudgetLimits, snapshot?: GraphBudgetSnapshot) {
    this.#limits = validateLimits(limits);
    if (snapshot !== undefined) {
      this.#consumed = normalizeAmount(snapshot.consumed);
      for (const reservation of snapshot.reservations) {
        this.#reservations.set(reservation.nodeId, Object.freeze({
          ...reservation,
          ...(reservation.actual === undefined
            ? {}
            : { actual: Object.freeze(normalizeAmount(reservation.actual)) }),
        }));
      }
    }
  }

  get snapshot(): GraphBudgetSnapshot {
    return Object.freeze({
      schemaVersion: "1.0",
      limits: Object.freeze({ ...this.#limits }),
      reservations: Object.freeze([...this.#reservations.values()]),
      consumed: Object.freeze({ ...this.#consumed }),
    });
  }

  reserve(input: {
    readonly nodeId: string;
    readonly parentId: string;
    readonly amount: GraphBudgetAmount;
    readonly parentCeiling?: GraphBudgetAmount;
    readonly reservedAt?: string;
  }): GraphBudgetReservation {
    if (this.#reservations.has(input.nodeId)) {
      throw new Error("budget reservation already exists for " + input.nodeId);
    }
    const amount = normalizeAmount(input.amount);
    if (input.parentCeiling !== undefined) {
      const parentCeiling = normalizeAmount(input.parentCeiling);
      for (const resource of RESOURCE_KEYS) {
        if (amount[resource] > parentCeiling[resource]) throw new GraphBudgetExceeded(resource);
      }
    }
    const totals = addAmounts(this.#consumed, this.#reservedTotal());
    for (const resource of RESOURCE_KEYS) {
      if (totals[resource] + amount[resource] > limitValue(this.#limits, resource)) {
        throw new GraphBudgetExceeded(resource);
      }
    }
    const reservation: GraphBudgetReservation = Object.freeze({
      nodeId: input.nodeId,
      parentId: input.parentId,
      ...amount,
      reservedAt: input.reservedAt ?? new Date().toISOString(),
      state: "reserved",
    });
    this.#reservations.set(input.nodeId, reservation);
    return reservation;
  }

  settle(nodeId: string, actual?: Partial<GraphBudgetAmount>): GraphBudgetReservation | undefined {
    const current = this.#reservations.get(nodeId);
    if (current === undefined || current.state !== "reserved") return current;
    const reserved = amountFromReservation(current);
    const normalizedActual = actual === undefined
      ? reserved
      : normalizeAmount({
          toolCalls: actual.toolCalls ?? reserved.toolCalls,
          modelCalls: actual.modelCalls ?? reserved.modelCalls,
          wallClockMs: actual.wallClockMs ?? reserved.wallClockMs,
          contextTokens: actual.contextTokens ?? reserved.contextTokens,
          costUsd: actual.costUsd ?? reserved.costUsd,
        });
    this.#consumed = addAmounts(this.#consumed, normalizedActual);
    const settled: GraphBudgetReservation = Object.freeze({
      ...current,
      state: "settled",
      actual: Object.freeze(normalizedActual),
    });
    this.#reservations.set(nodeId, settled);
    return settled;
  }

  release(nodeId: string): GraphBudgetReservation | undefined {
    const current = this.#reservations.get(nodeId);
    if (current === undefined || current.state !== "reserved") return current;
    const released: GraphBudgetReservation = Object.freeze({ ...current, state: "released" });
    this.#reservations.set(nodeId, released);
    return released;
  }

  releaseMany(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) this.release(nodeId);
  }

  #reservedTotal(): GraphBudgetAmount {
    let total = zeroAmount();
    for (const reservation of this.#reservations.values()) {
      if (reservation.state !== "reserved") continue;
      total = addAmounts(total, amountFromReservation(reservation));
    }
    return total;
  }
}

const RESOURCE_KEYS = [
  "toolCalls",
  "modelCalls",
  "wallClockMs",
  "contextTokens",
  "costUsd",
] as const;

function zeroAmount(): GraphBudgetAmount {
  return { toolCalls: 0, modelCalls: 0, wallClockMs: 0, contextTokens: 0, costUsd: 0 };
}

function normalizeAmount(amount: GraphBudgetAmount): GraphBudgetAmount {
  return {
    toolCalls: nonNegativeInteger(amount.toolCalls),
    modelCalls: nonNegativeInteger(amount.modelCalls),
    wallClockMs: nonNegativeInteger(amount.wallClockMs),
    contextTokens: nonNegativeInteger(amount.contextTokens),
    costUsd: nonNegativeNumber(amount.costUsd),
  };
}

function validateLimits(limits: GraphBudgetLimits): GraphBudgetLimits {
  const normalized = {
    maxToolCalls: nonNegativeInteger(limits.maxToolCalls),
    maxModelCalls: nonNegativeInteger(limits.maxModelCalls),
    maxWallClockMs: nonNegativeInteger(limits.maxWallClockMs),
    maxContextTokens: nonNegativeInteger(limits.maxContextTokens),
    maxCostUsd: nonNegativeNumber(limits.maxCostUsd),
  };
  if (Object.values(normalized).some((value) => value <= 0)) {
    throw new TypeError("agent graph budget limits must be positive");
  }
  return Object.freeze(normalized);
}

function amountFromReservation(value: GraphBudgetReservation): GraphBudgetAmount {
  return {
    toolCalls: value.toolCalls,
    modelCalls: value.modelCalls,
    wallClockMs: value.wallClockMs,
    contextTokens: value.contextTokens,
    costUsd: value.costUsd,
  };
}

function addAmounts(left: GraphBudgetAmount, right: GraphBudgetAmount): GraphBudgetAmount {
  return {
    toolCalls: left.toolCalls + right.toolCalls,
    modelCalls: left.modelCalls + right.modelCalls,
    wallClockMs: left.wallClockMs + right.wallClockMs,
    contextTokens: left.contextTokens + right.contextTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

function limitValue(
  limits: GraphBudgetLimits,
  resource: keyof GraphBudgetAmount,
): number {
  if (resource === "toolCalls") return limits.maxToolCalls;
  if (resource === "modelCalls") return limits.maxModelCalls;
  if (resource === "wallClockMs") return limits.maxWallClockMs;
  if (resource === "contextTokens") return limits.maxContextTokens;
  return limits.maxCostUsd;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("budget amount must be non-negative");
  return Math.floor(value);
}

function nonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("budget amount must be non-negative");
  return value;
}
