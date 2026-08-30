/**
 * Builtin hook templates — PRD §6 P1-03.
 *
 * §P1-03 asks that the plugin/hook substrate not be rebuilt but *productized*:
 * the deterministic dispatcher in `hooks.ts` already fixes ordering, budgets,
 * and authority, and every hook kind the five templates need already exists in
 * `PLUGIN_HOOK_KINDS`. What was missing is product content — the bus was
 * constructed empty, so a fresh install shipped a hook system with nothing in it.
 *
 * A builtin is not a privileged plugin. It goes through the same registration
 * and the same dispatch as a user or project hook; `scope: "builtin"` only
 * places it first in the §13.14 ordering and makes it fail closed, both of which
 * the dispatcher already implements. What this module adds is a declaration form
 * that cannot get those two wrong, and an id namespace (`capybara/<template>`)
 * so a builtin is attributable in a trace rather than anonymous.
 *
 * Templates are declarative on purpose: each carries its kind, ordinal, and
 * criticality, and takes its behaviour as a handler the host supplies. The host
 * owns the formatter, the LSP client, the verification contract, and the
 * compaction capsule; the SDK must not reach for any of them.
 */

import {
  PLUGIN_HOOK_KINDS,
  type PluginHookKind,
} from "./contracts.ts";
import {
  type AfterHookInvocation,
  type BeforeHookDecision,
  type BeforeHookInvocation,
  type RegisteredAfterHook,
  type RegisteredBeforeHook,
} from "./hooks.ts";

/** The five §P1-03 default templates. */
export type BuiltinHookTemplate =
  | "after_edit"
  | "before_final"
  | "on_failure"
  | "on_session_start"
  | "on_compaction";

export const BUILTIN_HOOK_TEMPLATES: readonly BuiltinHookTemplate[] = [
  "after_edit",
  "before_final",
  "on_failure",
  "on_session_start",
  "on_compaction",
];

export interface BuiltinHookSpec {
  readonly template: BuiltinHookTemplate;
  /** The generic kind this template rides; all five already exist. */
  readonly kind: PluginHookKind;
  /**
   * Whether a failure blocks. Only `before_final` is critical: it is the one
   * template whose failure means "we could not confirm the work", and treating
   * that as permission to finish would defeat the check.
   */
  readonly critical: boolean;
  readonly ordinal: number;
  readonly summary: string;
}

/**
 * The template table.
 *
 * Ordinals are spaced by ten so a later template can be inserted between two
 * without renumbering the rest, which would silently reorder registrations that
 * a test or a trace already pins.
 */
const BUILTIN_HOOK_SPECS: Readonly<Record<BuiltinHookTemplate, BuiltinHookSpec>> = {
  after_edit: {
    template: "after_edit",
    kind: "after.tool_execute",
    critical: false,
    ordinal: 10,
    summary: "run the workspace formatter and re-read LSP diagnostics after a mutating edit",
  },
  before_final: {
    template: "before_final",
    kind: "before.verification",
    critical: true,
    ordinal: 20,
    summary: "require fresh evidence for every command the turn verification contract marks required",
  },
  on_failure: {
    template: "on_failure",
    kind: "on.tool_error",
    critical: false,
    ordinal: 30,
    summary: "record failure evidence together with the epoch transition it caused",
  },
  on_session_start: {
    template: "on_session_start",
    kind: "after.session_create",
    critical: false,
    ordinal: 40,
    summary: "compare project-instruction and memory digests against the previous session",
  },
  on_compaction: {
    template: "on_compaction",
    kind: "after.context_pack",
    critical: false,
    ordinal: 50,
    summary: "assert unresolved TODO work and referenced evidence survived compaction",
  },
};

export class BuiltinHookError extends Error {
  readonly code = "BUILTIN_HOOK_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BuiltinHookError";
  }
}

export function builtinHookSpec(template: BuiltinHookTemplate): BuiltinHookSpec {
  const spec = BUILTIN_HOOK_SPECS[template];
  if (spec === undefined) throw new BuiltinHookError("unknown builtin hook template");
  return spec;
}

/** `capybara/<template>` — attributable in a trace, and a canonical plugin id. */
export function builtinHookPluginId(template: BuiltinHookTemplate): string {
  return "capybara/" + template.replace(/_/gu, "-");
}

/**
 * Declare a builtin before-hook.
 *
 * The scope and priority come from the table rather than the caller: a builtin
 * registered as `ordinary` would fail open, and a template whose whole purpose is
 * to gate completion must not be silently downgradable at its registration site.
 */
export function registerBuiltinBeforeHook(
  template: BuiltinHookTemplate,
  invoke: (input: BeforeHookInvocation) => BeforeHookDecision | Promise<BeforeHookDecision>,
): RegisteredBeforeHook {
  const spec = assertRegisterable(template, invoke);
  return {
    pluginId: builtinHookPluginId(template),
    scope: "builtin",
    priority: spec.critical ? "critical" : "ordinary",
    hook: spec.kind,
    ordinal: spec.ordinal,
    invoke: async (input) => await invoke(input),
  };
}

/** Declare a builtin observation hook. After hooks cannot deny, ask, or narrow. */
export function registerBuiltinAfterHook(
  template: BuiltinHookTemplate,
  invoke: (input: AfterHookInvocation) => void | Promise<void>,
): RegisteredAfterHook {
  const spec = assertRegisterable(template, invoke);
  return {
    pluginId: builtinHookPluginId(template),
    scope: "builtin",
    // An observation hook is never critical whatever the table says: it runs
    // after a receipt exists, so failing it closed could only invalidate work
    // that already happened.
    priority: "ordinary",
    hook: spec.kind,
    ordinal: spec.ordinal,
    invoke: async (input) => {
      await invoke(input);
      return undefined;
    },
  };
}

function assertRegisterable(template: BuiltinHookTemplate, invoke: unknown): BuiltinHookSpec {
  const spec = builtinHookSpec(template);
  if (typeof invoke !== "function") {
    throw new BuiltinHookError("builtin hook handler must be a function");
  }
  // A template naming a kind the dispatcher does not know would register fine
  // and never fire, which is the failure mode hardest to notice.
  if (!PLUGIN_HOOK_KINDS.includes(spec.kind)) {
    throw new BuiltinHookError("builtin hook template names an unsupported hook kind");
  }
  return spec;
}
