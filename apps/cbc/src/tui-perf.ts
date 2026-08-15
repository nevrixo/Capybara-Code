/** Low-overhead, opt-in TUI phase instrumentation for CBC_TUI_PERF=1. */

export const TUI_PERF_PHASES = [
  "live_collect",
  "timeline_sync",
  "timeline_render",
  "chrome_render",
  "column_join",
  "frame_fit_clip",
  "row_diff_or_ansi",
  "stdout_write",
] as const;

export type TuiPerfPhase = (typeof TUI_PERF_PHASES)[number];

export interface TuiPerfSnapshot {
  readonly enabled: boolean;
  readonly frames: number;
  readonly droppedFrames: number;
  readonly eventLoopDelaySamples: number;
  readonly phaseMs: Readonly<Record<TuiPerfPhase, number>>;
  readonly phaseCounts: Readonly<Record<TuiPerfPhase, number>>;
}

type MutablePhaseMap = Record<TuiPerfPhase, number>;

function emptyPhaseMap(): MutablePhaseMap {
  return Object.fromEntries(TUI_PERF_PHASES.map((phase) => [phase, 0])) as MutablePhaseMap;
}

export class TuiPerfRecorder {
  readonly #enabled: boolean;
  readonly #phaseMs = emptyPhaseMap();
  readonly #phaseCounts = emptyPhaseMap();
  #frames = 0;
  #droppedFrames = 0;
  #eventLoopDelaySamples = 0;

  constructor(enabled = false) {
    this.#enabled = enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  beginFrame(): number {
    if (!this.#enabled) return 0;
    this.#frames += 1;
    return performance.now();
  }

  endFrame(start: number): void {
    if (!this.#enabled || start === 0) return;
    // Keep this as an observable sample without adding another phase name to the
    // public contract; event-loop delay is supplied by host integrations when they
    // have a monitor available.
    if (performance.now() - start > 16) this.#eventLoopDelaySamples += 1;
  }

  measure<T>(phase: TuiPerfPhase, operation: () => T): T {
    if (!this.#enabled) return operation();
    const start = performance.now();
    try {
      return operation();
    } finally {
      this.#phaseMs[phase] += performance.now() - start;
      this.#phaseCounts[phase] += 1;
    }
  }

  recordDroppedFrame(): void {
    if (this.#enabled) this.#droppedFrames += 1;
  }

  recordEventLoopDelay(): void {
    if (this.#enabled) this.#eventLoopDelaySamples += 1;
  }

  snapshot(): TuiPerfSnapshot {
    return {
      enabled: this.#enabled,
      frames: this.#frames,
      droppedFrames: this.#droppedFrames,
      eventLoopDelaySamples: this.#eventLoopDelaySamples,
      phaseMs: { ...this.#phaseMs },
      phaseCounts: { ...this.#phaseCounts },
    };
  }

  reset(): void {
    this.#frames = 0;
    this.#droppedFrames = 0;
    this.#eventLoopDelaySamples = 0;
    for (const phase of TUI_PERF_PHASES) {
      this.#phaseMs[phase] = 0;
      this.#phaseCounts[phase] = 0;
    }
  }
}

export function tuiPerfEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CBC_TUI_PERF === "1";
}
