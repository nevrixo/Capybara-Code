/**
 * In-process plugin hook bus. Isolated WASI/stdio workers live in the daemon
 * supervisor; this host only applies already-admitted, monotonic hook results
 * before a tool executes in the embedded CLI. After hooks are fail-open.
 */

import {
  dispatchAfterHooks,
  dispatchBeforeHooks,
  type AfterHookInvocation,
  type BeforeHookInvocation,
  type EffectivePluginOperation,
  type RegisteredAfterHook,
  type RegisteredBeforeHook,
} from "@cbc/plugin-sdk";
import type { ProposedAction } from "@cbc/permissions";

export class PluginHookBus {
  readonly #hooks: RegisteredBeforeHook[];
  readonly #afterHooks: RegisteredAfterHook[];

  constructor(
    hooks: readonly RegisteredBeforeHook[] = [],
    afterHooks: readonly RegisteredAfterHook[] = [],
  ) {
    this.#hooks = [...hooks];
    this.#afterHooks = [...afterHooks];
  }

  register(hook: RegisteredBeforeHook): void {
    this.#hooks.push(hook);
  }

  registerAfter(hook: RegisteredAfterHook): void {
    this.#afterHooks.push(hook);
  }

  async beforeTool(action: ProposedAction): Promise<void> {
    if (this.#hooks.length === 0) return;
    const operation = operationFromAction(action);
    const invocation: BeforeHookInvocation = {
      invocationId: action.callId,
      operation,
    };
    const outcome = await dispatchBeforeHooks(this.#hooks, invocation, {
      ordinaryFailure: "open-with-warning",
    });
    if (outcome.action === "deny") {
      throw new Error(`plugin denied ${action.toolId}: ${outcome.reason}`);
    }
  }

  async afterTool(action: ProposedAction, result: AfterHookInvocation["result"]): Promise<void> {
    if (this.#afterHooks.length === 0) return;
    const invocation: AfterHookInvocation = {
      invocationId: action.callId,
      operation: operationFromAction(action),
      result,
    };
    await dispatchAfterHooks(this.#afterHooks, invocation, {
      ordinaryFailure: "open-with-warning",
    });
  }
}

function operationFromAction(action: ProposedAction): EffectivePluginOperation {
  return {
    workspaceRead: action.reads ?? [],
    workspaceWrite: action.writes ?? [],
    credentialScopes: [],
    toolIds: [action.toolId],
    contextCandidateIds: [],
    network: "deny",
    timeoutMs: 30_000,
    outputBytes: 1024 * 1024,
    maxNodes: 1,
    risk: "R0",
    sandbox: "strict",
  };
}
