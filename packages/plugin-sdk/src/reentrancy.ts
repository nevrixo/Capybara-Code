// Deterministic reentrancy limits for plugin-originated host tool calls.
// This restriction layer never grants authority. The host must still run normal
// policy, grant, event, and receipt checks after every admission.

import {
  PLUGIN_HOOK_KINDS,
  type PluginHookKind,
  type PluginToolSideEffect,
} from "./contracts.ts";

export const DEFAULT_PLUGIN_REENTRANCY_DEPTH = 2;
export const DEFAULT_PLUGIN_TOOL_CALL_BUDGET = 8;
export const MAX_PLUGIN_REENTRANCY_DEPTH = 8;
export const MAX_PLUGIN_TOOL_CALL_BUDGET = 64;

export interface PluginHookIdentity {
  readonly pluginId: string;
  readonly hook: PluginHookKind;
}

export interface PluginInvocationContext {
  readonly invocationId: string;
  readonly rootOperationId: string;
  readonly depth: number;
  readonly visitedPluginHooks: readonly string[];
  readonly toolCallBudget: number;
  readonly activePluginHook: PluginHookIdentity;
}

export interface PluginInvocationStart extends PluginHookIdentity {
  readonly invocationId: string;
  readonly rootOperationId: string;
  readonly toolCallBudget?: number;
}

export interface PluginNestedHookStart extends PluginHookIdentity {
  readonly invocationId: string;
}

export interface PluginHostToolRequest {
  readonly toolId: string;
  readonly sideEffect: PluginToolSideEffect;
}

export interface PluginReentrancyGuardOptions {
  readonly maxDepth?: number;
  readonly toolCallBudget?: number;
}

export class PluginReentrancyError extends Error {
  readonly code = "PLUGIN_REENTRANCY_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "PluginReentrancyError";
  }
}

// Tracks nested plugin hooks without exposing ambient authority.
export class PluginReentrancyGuard {
  readonly #maxDepth: number;
  readonly #toolCallBudget: number;

  constructor(options: PluginReentrancyGuardOptions = {}) {
    this.#maxDepth = boundedInteger(
      options.maxDepth ?? DEFAULT_PLUGIN_REENTRANCY_DEPTH,
      "maxDepth",
      0,
      MAX_PLUGIN_REENTRANCY_DEPTH,
    );
    this.#toolCallBudget = boundedInteger(
      options.toolCallBudget ?? DEFAULT_PLUGIN_TOOL_CALL_BUDGET,
      "toolCallBudget",
      1,
      MAX_PLUGIN_TOOL_CALL_BUDGET,
    );
  }

  begin(input: PluginInvocationStart): PluginInvocationContext {
    validateInvocationId(input.invocationId, "invocationId");
    validateInvocationId(input.rootOperationId, "rootOperationId");
    validateHookIdentity(input);
    const toolCallBudget = boundedInteger(
      input.toolCallBudget ?? this.#toolCallBudget,
      "toolCallBudget",
      1,
      MAX_PLUGIN_TOOL_CALL_BUDGET,
    );
    const identity = freezeIdentity(input);
    return freezeContext({
      invocationId: input.invocationId,
      rootOperationId: input.rootOperationId,
      depth: 0,
      visitedPluginHooks: [hookKey(identity)],
      toolCallBudget,
      activePluginHook: identity,
    });
  }

  // Consume a tool budget slot; ordinary policy and grant checks still follow.
  admitToolCall(
    context: PluginInvocationContext,
    request: PluginHostToolRequest,
  ): PluginInvocationContext {
    validateContext(context, this.#maxDepth);
    validateInvocationId(request.toolId, "toolId");
    if (!isToolSideEffect(request.sideEffect)) {
      throw new PluginReentrancyError("tool sideEffect must be a supported value");
    }
    if (context.toolCallBudget <= 0) {
      throw new PluginReentrancyError("plugin invocation exhausted its host tool-call budget");
    }
    if (
      (context.activePluginHook.hook === "before.tool"
        || isObservationHook(context.activePluginHook.hook))
      && request.sideEffect !== "read"
    ) {
      throw new PluginReentrancyError(
        "this plugin hook may only initiate read-only host tools",
      );
    }
    return freezeContext({
      ...context,
      visitedPluginHooks: context.visitedPluginHooks,
      activePluginHook: context.activePluginHook,
      toolCallBudget: context.toolCallBudget - 1,
    });
  }

  // Enter a plugin hook that normal host event dispatch reached after a tool call.
  enterNestedHook(
    parent: PluginInvocationContext,
    input: PluginNestedHookStart,
  ): PluginInvocationContext {
    validateContext(parent, this.#maxDepth);
    validateInvocationId(input.invocationId, "invocationId");
    validateHookIdentity(input);
    if (input.invocationId === parent.invocationId) {
      throw new PluginReentrancyError("nested plugin invocationId must differ from its parent");
    }
    if (parent.depth >= this.#maxDepth) {
      throw new PluginReentrancyError("plugin hook reentrancy depth limit exceeded");
    }

    const identity = freezeIdentity(input);
    const key = hookKey(identity);
    if (parent.visitedPluginHooks.includes(key)) {
      throw new PluginReentrancyError(
        "the same plugin hook cannot re-enter within one root operation",
      );
    }
    return freezeContext({
      invocationId: input.invocationId,
      rootOperationId: parent.rootOperationId,
      depth: parent.depth + 1,
      visitedPluginHooks: [...parent.visitedPluginHooks, key],
      toolCallBudget: parent.toolCallBudget,
      activePluginHook: identity,
    });
  }
}

function validateContext(context: PluginInvocationContext, maxDepth: number): void {
  if (!isRecord(context)) {
    throw new PluginReentrancyError("plugin invocation context must be an object");
  }
  validateInvocationId(context.invocationId, "invocationId");
  validateInvocationId(context.rootOperationId, "rootOperationId");
  validateHookIdentity(context.activePluginHook);
  if (!Number.isSafeInteger(context.depth) || context.depth < 0 || context.depth > maxDepth) {
    throw new PluginReentrancyError("plugin invocation context has an invalid depth");
  }
  if (
    !Number.isSafeInteger(context.toolCallBudget)
    || context.toolCallBudget < 0
    || context.toolCallBudget > MAX_PLUGIN_TOOL_CALL_BUDGET
  ) {
    throw new PluginReentrancyError("plugin invocation context has an invalid tool-call budget");
  }
  if (
    !Array.isArray(context.visitedPluginHooks)
    || context.visitedPluginHooks.length !== context.depth + 1
    || new Set(context.visitedPluginHooks).size !== context.visitedPluginHooks.length
    || !context.visitedPluginHooks.includes(hookKey(context.activePluginHook))
    || context.visitedPluginHooks.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new PluginReentrancyError("plugin invocation context has an invalid hook ancestry");
  }
}

function validateHookIdentity(value: PluginHookIdentity): void {
  if (!isRecord(value)) {
    throw new PluginReentrancyError("plugin hook identity must be an object");
  }
  if (
    typeof value.pluginId !== "string"
    || value.pluginId.length === 0
    || value.pluginId.length > 256
    || value.pluginId.trim() !== value.pluginId
    || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(value.pluginId)
  ) {
    throw new PluginReentrancyError("pluginId must be a canonical publisher/name identifier");
  }
  if (!isPluginHookKind(value.hook)) {
    throw new PluginReentrancyError("hook must be a supported plugin hook kind");
  }
}

function validateInvocationId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PluginReentrancyError(field + " must be a bounded opaque identifier");
  }
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PluginReentrancyError(field + " must be an integer between " + min + " and " + max);
  }
  return value;
}

function hookKey(identity: PluginHookIdentity): string {
  return identity.pluginId + "#" + identity.hook;
}

function freezeIdentity(identity: PluginHookIdentity): PluginHookIdentity {
  return Object.freeze({ pluginId: identity.pluginId, hook: identity.hook });
}

function freezeContext(context: PluginInvocationContext): PluginInvocationContext {
  return Object.freeze({
    ...context,
    visitedPluginHooks: Object.freeze([...context.visitedPluginHooks]),
    activePluginHook: freezeIdentity(context.activePluginHook),
  });
}

function isObservationHook(hook: PluginHookKind): boolean {
  return hook.startsWith("after.") || hook.startsWith("on.");
}

function isPluginHookKind(value: unknown): value is PluginHookKind {
  return typeof value === "string" && (PLUGIN_HOOK_KINDS as readonly string[]).includes(value);
}

function isToolSideEffect(value: unknown): value is PluginToolSideEffect {
  return value === "read"
    || value === "write"
    || value === "destructive"
    || value === "external"
    || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

