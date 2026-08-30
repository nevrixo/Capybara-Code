/**
 * Builtin hook template registration — PRD §6 P1-03.
 *
 * These assertions are about the two properties a builtin cannot be allowed to
 * get wrong at its registration site: it sorts first (§13.14) and it fails
 * closed. Both are already implemented by the dispatcher, so what is tested here
 * is that the declaration form cannot produce a registration that opts out.
 */

import { describe, expect, test } from "bun:test";

import {
  BUILTIN_HOOK_TEMPLATES,
  BuiltinHookError,
  builtinHookPluginId,
  builtinHookSpec,
  dispatchAfterHooks,
  dispatchBeforeHooks,
  PLUGIN_HOOK_KINDS,
  registerBuiltinAfterHook,
  registerBuiltinBeforeHook,
  sortBeforeHooks,
  type RegisteredBeforeHook,
} from "../src/index.ts";

const OPERATION = {
  workspaceRead: [],
  workspaceWrite: [],
  credentialScopes: [],
  toolIds: ["fs.edit"],
  contextCandidateIds: [],
  network: "deny" as const,
  timeoutMs: 1_000,
  outputBytes: 1_024,
  maxNodes: 1,
  risk: "R0" as const,
  sandbox: "strict" as const,
};

describe("builtin hook templates (§6 P1-03)", () => {
  test("all five templates exist and ride kinds the dispatcher knows", () => {
    expect(BUILTIN_HOOK_TEMPLATES).toEqual([
      "after_edit",
      "before_final",
      "on_failure",
      "on_session_start",
      "on_compaction",
    ]);
    for (const template of BUILTIN_HOOK_TEMPLATES) {
      const spec = builtinHookSpec(template);
      expect(PLUGIN_HOOK_KINDS).toContain(spec.kind);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
  });

  test("only before_final is critical", () => {
    // Its failure means "we could not confirm the work"; treating that as
    // permission to finish would defeat the check. Every other template runs
    // after a receipt exists, so failing it closed could only invalidate work
    // that already happened.
    for (const template of BUILTIN_HOOK_TEMPLATES) {
      expect(builtinHookSpec(template).critical).toBe(template === "before_final");
    }
  });

  test("ordinals are distinct and spaced so a later template can be inserted", () => {
    const ordinals = BUILTIN_HOOK_TEMPLATES.map((template) => builtinHookSpec(template).ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);
  });

  test("registration pins builtin scope and derives priority from the table", () => {
    const critical = registerBuiltinBeforeHook("before_final", () => ({ action: "continue" }));
    expect(critical.scope).toBe("builtin");
    expect(critical.priority).toBe("critical");
    expect(critical.pluginId).toBe("capybara/before-final");
    expect(critical.hook).toBe("before.verification");

    // Even a template the table marks critical registers as ordinary when it is
    // an observation hook, because an after hook cannot change authority.
    const observation = registerBuiltinAfterHook("before_final", () => undefined);
    expect(observation.priority).toBe("ordinary");
  });

  test("plugin ids are canonical, so a builtin is attributable in a trace", () => {
    for (const template of BUILTIN_HOOK_TEMPLATES) {
      expect(builtinHookPluginId(template)).toMatch(
        /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u,
      );
    }
  });

  test("a non-function handler is refused at declaration", () => {
    expect(() => registerBuiltinBeforeHook("after_edit", undefined as never))
      .toThrow(BuiltinHookError);
  });

  test("a builtin sorts ahead of user and project hooks", () => {
    const user: RegisteredBeforeHook = {
      pluginId: "acme/aaa",
      scope: "user",
      priority: "critical",
      hook: "before.verification",
      ordinal: 0,
      invoke: async () => ({ action: "continue" }),
    };
    const builtin = registerBuiltinBeforeHook("before_final", () => ({ action: "continue" }));
    const ordered = sortBeforeHooks([user, builtin]);
    expect(ordered[0]?.pluginId).toBe(builtin.pluginId);
  });

  test("a builtin before-hook denial reaches the caller", async () => {
    const outcome = await dispatchBeforeHooks(
      [registerBuiltinBeforeHook("before_final", () => ({
        action: "deny",
        reason: "the contract requires a test run with no fresh evidence",
      }))],
      { invocationId: "call-1", operation: OPERATION },
    );
    expect(outcome.action).toBe("deny");
    if (outcome.action === "deny") {
      expect(outcome.reason).toContain("fresh evidence");
    }
  });

  test("a throwing builtin before-hook fails closed", async () => {
    // `ordinaryFailure: "open-with-warning"` is the host default, so this proves
    // the builtin scope itself closes rather than the dispatch option doing it.
    const outcome = await dispatchBeforeHooks(
      [registerBuiltinBeforeHook("after_edit", () => {
        throw new Error("formatter crashed");
      })],
      { invocationId: "call-2", operation: OPERATION },
      { ordinaryFailure: "open-with-warning" },
    );
    expect(outcome.action).toBe("deny");
  });

  test("a throwing builtin observation hook only warns", async () => {
    const outcome = await dispatchAfterHooks(
      [registerBuiltinAfterHook("on_failure", () => {
        throw new Error("evidence store unavailable");
      })],
      { invocationId: "call-3", operation: OPERATION, result: { ok: false, code: "TOOL_FAILED" } },
    );
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.trace[0]?.status).toBe("failed");
  });

  test("an observation hook that returns a value does not break dispatch", async () => {
    // The dispatcher rejects any after-hook decision but `continue`; the wrapper
    // returns undefined so a handler's incidental return value cannot trip it.
    const outcome = await dispatchAfterHooks(
      [registerBuiltinAfterHook("on_compaction", () => "unresolved work preserved" as unknown as void)],
      { invocationId: "call-4", operation: OPERATION, result: { ok: true } },
    );
    expect(outcome.warnings).toHaveLength(0);
    expect(outcome.trace[0]?.status).toBe("continued");
  });
});
