/**
 * `@cbc/context-engine` — project instructions, the repository map, context
 * selection, file excerpts, and the context inspector (PRD §18).
 *
 * Session persistence, compaction, and the resume reducer live in
 * `@cbc/session-domain`; this package decides *what the model is shown*, not how
 * it is stored.
 */

export * from "./instructions.ts";
export * from "./repomap.ts";
export * from "./repomap-cache.ts";
export * from "./selection.ts";
export * from "./excerpts.ts";
export * from "./engine.ts";
export * from './evidence.ts';
export * from "./context-plan.ts";
export * from "./cache.ts";
// Context Compiler v2 foundations. Keep these public so the kernel, tools, UI,
// evals, and managed LSP adapters share the same typed contracts.
export * from "./ir.ts";
export * from "./compiler.ts";
export * from "./repository-intelligence.ts";
export * from "./memory.ts";
export * from "./context-ops.ts";
export * from "./optimizer.ts";
export * from "./retrieval-controller.ts";
export * from "./projection.ts";
export * from "./verification-planner.ts";

export * from "./scope.ts";
