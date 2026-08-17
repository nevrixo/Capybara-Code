/**
 * `@cbc/inference-domain` — the model-neutral inference domain (P1-05).
 *
 * Generic model, capability, routing, and usage types, plus the neutral
 * contracts shared across packages. Provider adapters and the agent kernel
 * depend on this package — never the other way around — so `context-engine`,
 * `skills`, and `subagents` can describe inference without importing a
 * provider's wire format or the kernel's turn loop.
 */

export * from "./model.ts";
export * from "./capability.ts";
export * from "./routing.ts";
export * from "./usage.ts";
export * from "./budget.ts";
