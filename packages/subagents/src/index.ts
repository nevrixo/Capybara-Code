/**
 * `@cbc/subagents` — roles, task contracts, the scheduler, writer leases, parent
 * synthesis, and custom agent definitions (PRD §15).
 *
 * §15.1: a subagent is the same `AgentKernel` with a different role, context,
 * permission scope, and budget. This package supplies those four things and the
 * lifecycle around them; it never calls a provider itself, which is what lets the
 * whole delegation model be tested without a network (AC-47).
 */

export * from "./roles.ts";
export * from "./budget-ledger.ts";
export * from "./delegation-coordinator.ts";
export * from "./task.ts";
export * from "./instance.ts";
export * from "./synthesis.ts";
export * from "./scheduler.ts";
export * from "./graph-authority.ts";
export * from "./graph-store.ts";
export * from "./discovery.ts";
export * from "./custom.ts";
export * from './hosted-scout.ts';
export * from './hosted-scout-local.ts';
export * from './hosted-scout-provider.ts';
