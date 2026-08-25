/**
 * In-process plugin hook bus. Isolated WASI/stdio workers live in the daemon
 * supervisor; this host only applies already-admitted, monotonic hook results
 * before a tool executes in the embedded CLI.
 */

import {
  dispatchBeforeHooks,
  type BeforeHookInvocation,
  type EffectivePluginOperation,
  type RegisteredBeforeHook,
} from "@cbc/plugin-sdk";
import type { ProposedAction } from "@cbc/permissions";

export class PluginHookBus {
  readonly #hooks: RegisteredBeforeHook[];

  constructor(hooks: readonly RegisteredBeforeHook[] = []) {
    this.#hooks = [...hooks];
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
