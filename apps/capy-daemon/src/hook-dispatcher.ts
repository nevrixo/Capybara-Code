/**
 * Thin daemon wrapper around plugin-sdk before- and after-hook dispatch.
 */

import {
  dispatchAfterHooks,
  dispatchBeforeHooks,
  type AfterHookDispatchOutcome,
  type AfterHookInvocation,
  type BeforeHookDispatchOutcome,
  type BeforeHookInvocation,
  type HookDispatchOptions,
  type RegisteredAfterHook,
  type RegisteredBeforeHook,
} from "@cbc/plugin-sdk";

export interface HookDispatcherOptions extends HookDispatchOptions {}

export class HookDispatcher {
  readonly #options: HookDispatchOptions;
  readonly #hooks: RegisteredBeforeHook[] = [];
  readonly #afterHooks: RegisteredAfterHook[] = [];

  constructor(options: HookDispatcherOptions = {}) {
    this.#options = options;
  }

  register(hook: RegisteredBeforeHook): void {
    this.#hooks.push(hook);
  }

  registerAfter(hook: RegisteredAfterHook): void {
    this.#afterHooks.push(hook);
  }

  clear(): void {
    this.#hooks.length = 0;
    this.#afterHooks.length = 0;
  }

  list(): readonly RegisteredBeforeHook[] {
    return [...this.#hooks];
  }

  listAfter(): readonly RegisteredAfterHook[] {
    return [...this.#afterHooks];
  }

  async dispatch(input: BeforeHookInvocation): Promise<BeforeHookDispatchOutcome> {
    return await dispatchBeforeHooks(this.#hooks, input, this.#options);
  }

  async dispatchAfter(input: AfterHookInvocation): Promise<AfterHookDispatchOutcome> {
    return await dispatchAfterHooks(this.#afterHooks, input, this.#options);
  }
}
