/**
 * `@cbc/evals` — CBC Bench: task fixtures, metrics, scoring, and the release gate
 * (PRD §26).
 *
 * §26.1's premise is that agent quality cannot be verified by UI tests, so this package
 * measures outcomes on real repositories instead. It contains no execution: the runner
 * takes an `ExecuteTask` function, which is what lets the same scoring drive a scripted
 * mock provider in CI (AC-47) and a live model in a release evaluation.
 */

export * from "./task.ts";
export * from "./metrics.ts";
export * from "./scoring.ts";
export * from "./runner.ts";
export * from "./paired.ts";
export * from "./statistics.ts";
