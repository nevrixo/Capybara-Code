/**
 * Deterministic, transport-neutral plugin circuit breaker.
 *
 * A supervisor can share one breaker across hook, tool, and command invocations
 * to prevent a repeatedly failing plugin from delaying or destabilizing a host.
 * This module owns no process lifecycle; it only makes admission and recovery
 * decisions that a supervisor can persist or project into health events.
 */

export type PluginCircuitState = "closed" | "open" | "half-open";

export interface PluginCircuitSnapshot {
  readonly pluginId: string;
  readonly state: PluginCircuitState;
  readonly consecutiveFailures: number;
  readonly lastFailureAt?: number;
  readonly openedAt?: number;
  readonly retryAt?: number;
}

export interface PluginCircuitPermit {
  readonly pluginId: string;
  /**
   * Changes each time a circuit opens. Late completions from an earlier
   * generation can therefore never close a newer circuit.
   */
  readonly generation: number;
  readonly kind: "normal" | "probe";
  readonly probeId?: number;
}

export type PluginCircuitAdmission =
  | {
    readonly kind: "allowed";
    readonly state: "closed" | "half-open";
    readonly permit: PluginCircuitPermit;
  }
  | {
    readonly kind: "blocked";
    readonly state: "open";
    readonly retryAt: number;
  };

export interface PluginCircuitBreakerOptions {
  /** Consecutive failed invocations required to open a circuit. Defaults to 3. */
  readonly failureThreshold?: number;
  /** Delay before exactly one half-open recovery probe is admitted. Defaults to 30 seconds. */
  readonly cooldownMs?: number;
  /** Injectable clock for deterministic tests and persisted supervisor projections. */
  readonly now?: () => number;
}

interface CircuitEntry {
  state: PluginCircuitState;
  consecutiveFailures: number;
  generation: number;
  lastFailureAt?: number;
  openedAt?: number;
  retryAt?: number;
  probeId?: number;
}

const MAX_FAILURE_THRESHOLD = 100;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

export class PluginCircuitError extends Error {
  readonly code = "PLUGIN_CIRCUIT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginCircuitError";
  }
}

/**
 * Consumers retain the permit returned by admit and settle that same permit.
 * A late completion from an earlier generation cannot close a newer circuit.
 */
export class PluginCircuitBreaker {
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #nowSource: () => number;
  readonly #entries = new Map<string, CircuitEntry>();
  #lastObservedNow = 0;
  #nextProbeId = 0;

  constructor(options: PluginCircuitBreakerOptions = {}) {
    const failureThreshold = options.failureThreshold ?? 3;
    const cooldownMs = options.cooldownMs ?? 30_000;
    if (
      !Number.isSafeInteger(failureThreshold)
      || failureThreshold < 1
      || failureThreshold > MAX_FAILURE_THRESHOLD
    ) {
      throw new PluginCircuitError("failureThreshold must be a bounded positive integer");
    }
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > MAX_COOLDOWN_MS) {
      throw new PluginCircuitError("cooldownMs must be a bounded positive integer");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new PluginCircuitError("now must be a function");
    }
    this.#failureThreshold = failureThreshold;
    this.#cooldownMs = cooldownMs;
    this.#nowSource = options.now ?? (() => Date.now());
  }

  admit(pluginId: string): PluginCircuitAdmission {
    validatePluginId(pluginId);
    const entry = this.#entries.get(pluginId);
    if (entry === undefined) {
      return {
        kind: "allowed",
        state: "closed",
        permit: { pluginId, generation: 0, kind: "normal" },
      };
    }
    if (entry.state === "closed") {
      return {
        kind: "allowed",
        state: "closed",
        permit: { pluginId, generation: entry.generation, kind: "normal" },
      };
    }

    const retryAt = requiredRetryAt(entry);
    if (entry.state === "half-open" || this.#now() < retryAt) {
      return { kind: "blocked", state: "open", retryAt };
    }

    const probeId = this.#newProbeId();
    entry.state = "half-open";
    entry.probeId = probeId;
    return {
      kind: "allowed",
      state: "half-open",
      permit: { pluginId, generation: entry.generation, kind: "probe", probeId },
    };
  }

  recordSuccess(permit: PluginCircuitPermit): PluginCircuitSnapshot {
    validatePermit(permit);
    const entry = this.#entries.get(permit.pluginId);
    if (entry === undefined || entry.generation !== permit.generation) {
      return this.snapshot(permit.pluginId);
    }
    if (
      (permit.kind === "probe" && (entry.state !== "half-open" || entry.probeId !== permit.probeId))
      || (permit.kind === "normal" && entry.state !== "closed")
    ) {
      return this.snapshot(permit.pluginId);
    }
    this.#entries.delete(permit.pluginId);
    return this.snapshot(permit.pluginId);
  }

  recordFailure(permit: PluginCircuitPermit): PluginCircuitSnapshot {
    validatePermit(permit);
    let entry = this.#entries.get(permit.pluginId);
    if (entry === undefined) {
      if (permit.kind !== "normal" || permit.generation !== 0) {
        return this.snapshot(permit.pluginId);
      }
      entry = { state: "closed", consecutiveFailures: 0, generation: 0 };
      this.#entries.set(permit.pluginId, entry);
    }
    if (entry.generation !== permit.generation) return this.snapshot(permit.pluginId);

    const now = this.#now();
    if (permit.kind === "probe") {
      if (entry.state !== "half-open" || entry.probeId !== permit.probeId) {
        return this.snapshot(permit.pluginId);
      }
      entry.consecutiveFailures = Math.max(this.#failureThreshold, entry.consecutiveFailures + 1);
      entry.lastFailureAt = now;
      this.#open(entry, now);
      return this.snapshot(permit.pluginId);
    }

    if (entry.state !== "closed") return this.snapshot(permit.pluginId);
    entry.consecutiveFailures += 1;
    entry.lastFailureAt = now;
    if (entry.consecutiveFailures >= this.#failureThreshold) this.#open(entry, now);
    return this.snapshot(permit.pluginId);
  }

  snapshot(pluginId: string): PluginCircuitSnapshot {
    validatePluginId(pluginId);
    return snapshot(pluginId, this.#entries.get(pluginId));
  }

  snapshots(): readonly PluginCircuitSnapshot[] {
    return [...this.#entries.keys()]
      .sort()
      .map((pluginId) => snapshot(pluginId, this.#entries.get(pluginId)));
  }

  reset(pluginId: string): PluginCircuitSnapshot {
    validatePluginId(pluginId);
    this.#entries.delete(pluginId);
    return this.snapshot(pluginId);
  }

  #open(entry: CircuitEntry, now: number): void {
    entry.state = "open";
    entry.openedAt = now;
    entry.retryAt = saturatingAdd(now, this.#cooldownMs);
    delete entry.probeId;
    if (entry.generation === Number.MAX_SAFE_INTEGER) {
      throw new PluginCircuitError("circuit generation limit reached");
    }
    entry.generation += 1;
  }

  #newProbeId(): number {
    if (this.#nextProbeId === Number.MAX_SAFE_INTEGER) {
      throw new PluginCircuitError("circuit probe limit reached");
    }
    this.#nextProbeId += 1;
    return this.#nextProbeId;
  }

  #now(): number {
    const value = this.#nowSource();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PluginCircuitError("now must return a non-negative safe integer");
    }
    this.#lastObservedNow = Math.max(this.#lastObservedNow, value);
    return this.#lastObservedNow;
  }
}

function snapshot(pluginId: string, entry: CircuitEntry | undefined): PluginCircuitSnapshot {
  if (entry === undefined) {
    return { pluginId, state: "closed", consecutiveFailures: 0 };
  }
  return {
    pluginId,
    state: entry.state,
    consecutiveFailures: entry.consecutiveFailures,
    ...(entry.lastFailureAt === undefined ? {} : { lastFailureAt: entry.lastFailureAt }),
    ...(entry.openedAt === undefined ? {} : { openedAt: entry.openedAt }),
    ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
  };
}

function requiredRetryAt(entry: CircuitEntry): number {
  if (entry.retryAt === undefined) {
    throw new PluginCircuitError("open circuit is missing retryAt");
  }
  return entry.retryAt;
}

function validatePluginId(pluginId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u.test(pluginId)) {
    throw new PluginCircuitError("pluginId must be a canonical publisher/name identifier");
  }
}

function validatePermit(permit: PluginCircuitPermit): void {
  validatePluginId(permit.pluginId);
  if (!Number.isSafeInteger(permit.generation) || permit.generation < 0) {
    throw new PluginCircuitError("permit generation must be a non-negative safe integer");
  }
  if (permit.kind === "normal") {
    if (permit.probeId !== undefined) {
      throw new PluginCircuitError("normal permit must not include a probeId");
    }
    return;
  }
  if (
    permit.kind !== "probe"
    || !Number.isSafeInteger(permit.probeId)
    || (permit.probeId ?? 0) < 1
  ) {
    throw new PluginCircuitError("probe permit must include a positive safe probeId");
  }
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}
