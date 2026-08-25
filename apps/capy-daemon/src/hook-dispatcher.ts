/**
 * Thin daemon wrapper around plugin-sdk before-hook dispatch.
 */

import {
  dispatchBeforeHooks,
  type BeforeHookDispatchOutcome,
  type BeforeHookInvocation,
  type HookDispatchOptions,
  type RegisteredBeforeHook,
} from "@cbc/plugin-sdk";

export interface HookDispatcherOptions extends HookDispatchOptions {}

export class HookDispatcher {
  readonly #options: HookDispatchOptions;
  readonly #hooks: RegisteredBeforeHook[] = [];

  constructor(options: HookDispatcherOptions = {}) {
    this.#options = options;
  }

  register(hook: RegisteredBeforeHook): void {
    this.#hooks.push(hook);
  }

  clear(): void {
    this.#hooks.length = 0;
  }

  list(): readonly RegisteredBeforeHook[] {
    return [...this.#hooks];
  }

  async dispatch(input: BeforeHookInvocation): Promise<BeforeHookDispatchOutcome> {
    return await dispatchBeforeHooks(this.#hooks, input, this.#options);
  }
}
