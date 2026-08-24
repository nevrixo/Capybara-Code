/**
 * Deterministic before-hook dispatch semantics.
 *
 * This module is transport- and runtime-neutral. A WASI or stdio supervisor
 * supplies the invocation function, while this layer fixes ordering, budgets,
 * failure policy, and monotonic authority application.
 */

import {
  validateNarrowing,
  type EffectivePluginOperation,
  type HookConstraints,
} from "./authority.ts";
import {
  type PluginHookKind,
  type PluginInstallScope,
  type PluginRiskClass,
} from "./contracts.ts";

export type PluginHookPriority = "critical" | "ordinary";

export interface HookAnnotation {
  readonly kind: string;
  readonly message: string;
}

export type BeforeHookDecision =
  | { readonly action: "continue"; readonly annotations?: readonly HookAnnotation[] }
  | { readonly action: "deny"; readonly reason: string }
  | { readonly action: "ask"; readonly reason: string; readonly riskFloor?: PluginRiskClass }
  | { readonly action: "narrow"; readonly constraints: HookConstraints; readonly reason: string };

export interface BeforeHookInvocation {
  readonly invocationId: string;
  readonly operation: EffectivePluginOperation;
}

export interface RegisteredBeforeHook {
  readonly pluginId: string;
  readonly scope: PluginInstallScope;
  readonly priority: PluginHookPriority;
  readonly hook: PluginHookKind;
  readonly ordinal: number;
  readonly invoke: (input: BeforeHookInvocation) => Promise<unknown>;
}

export interface HookDispatchOptions {
  readonly perHookTimeoutMs?: number;
  readonly aggregateTimeoutMs?: number;
  readonly ordinaryFailure?: "open-with-warning" | "closed";
  readonly now?: () => number;
}

export interface HookWarning {
  readonly pluginId: string;
  readonly hook: PluginHookKind;
  readonly code: "PLUGIN_TIMEOUT" | "PLUGIN_PROTOCOL_ERROR" | "PLUGIN_AUTHORITY_ESCALATION";
}

export interface HookTrace {
  readonly pluginId: string;
  readonly hook: PluginHookKind;
  readonly status: "continued" | "narrowed" | "denied" | "asked" | "failed";
}

interface HookOutcomeBase {
  readonly effective: EffectivePluginOperation;
  readonly annotations: readonly HookAnnotation[];
  readonly warnings: readonly HookWarning[];
  readonly trace: readonly HookTrace[];
}

export type BeforeHookDispatchOutcome =
  | (HookOutcomeBase & { readonly action: "continue" })
  | (HookOutcomeBase & { readonly action: "deny"; readonly reason: string })
  | (HookOutcomeBase & {
    readonly action: "ask";
    readonly reason: string;
    readonly riskFloor?: PluginRiskClass;
  });

export class PluginHookDispatchError extends Error {
  readonly code = "PLUGIN_HOOK_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginHookDispatchError";
  }
}

/**
 * Plan §13.14 ordering: builtin policy hooks, user critical, project critical,
 * user ordinary, project ordinary, then bytewise plugin id and manifest ordinal.
 */
export function sortBeforeHooks(
  registrations: readonly RegisteredBeforeHook[],
): readonly RegisteredBeforeHook[] {
  const unique = new Set<string>();
  for (const registration of registrations) {
    validateRegistration(registration);
    const key = registration.pluginId + "\u0000" + registration.hook + "\u0000" + String(registration.ordinal);
    if (unique.has(key)) {
      throw new PluginHookDispatchError("a plugin hook may be registered once per ordinal");
    }
    unique.add(key);
  }
  return [...registrations].sort((left, right) => {
    const group = hookGroup(left) - hookGroup(right);
    if (group !== 0) return group;
    if (left.pluginId < right.pluginId) return -1;
    if (left.pluginId > right.pluginId) return 1;
    if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
    if (left.hook < right.hook) return -1;
    if (left.hook > right.hook) return 1;
    return 0;
  });
}

/**
 * Runs the supplied registrations sequentially. A plugin receives the already
 * narrowed operation from earlier hooks, never a more permissive original.
 */
export async function dispatchBeforeHooks(
  registrations: readonly RegisteredBeforeHook[],
  input: BeforeHookInvocation,
  options: HookDispatchOptions = {},
): Promise<BeforeHookDispatchOutcome> {
  validateInvocation(input);
  const configuration = normalizeOptions(options);
  const ordered = sortBeforeHooks(registrations);
  const annotations: HookAnnotation[] = [];
  const warnings: HookWarning[] = [];
  const trace: HookTrace[] = [];
  let effective = cloneOperation(input.operation);
  const startedAt = configuration.now();

  for (const registration of ordered) {
    const remaining = configuration.aggregateTimeoutMs - (configuration.now() - startedAt);
    if (remaining <= 0) {
      const stopped = failureOutcome(
        registration,
        "PLUGIN_TIMEOUT",
        effective,
        annotations,
        warnings,
        trace,
        configuration,
      );
      if (stopped !== undefined) return stopped;
      continue;
    }

    let decision: BeforeHookDecision;
    try {
      decision = parseDecision(await withTimeout(
        Promise.resolve().then(() => registration.invoke({
          invocationId: input.invocationId,
          operation: effective,
        })),
        Math.min(configuration.perHookTimeoutMs, remaining),
      ));
    } catch (error) {
      const code = error instanceof HookTimeoutError ? "PLUGIN_TIMEOUT" : "PLUGIN_PROTOCOL_ERROR";
      const stopped = failureOutcome(
        registration,
        code,
        effective,
        annotations,
        warnings,
        trace,
        configuration,
      );
      if (stopped !== undefined) return stopped;
      continue;
    }

    if (decision.action === "continue") {
      annotations.push(...(decision.annotations ?? []));
      trace.push({ pluginId: registration.pluginId, hook: registration.hook, status: "continued" });
      continue;
    }

    if (decision.action === "deny") {
      trace.push({ pluginId: registration.pluginId, hook: registration.hook, status: "denied" });
      return {
        action: "deny",
        reason: decision.reason,
        effective,
        annotations,
        warnings,
        trace,
      };
    }

    if (decision.action === "ask") {
      const narrowed = decision.riskFloor === undefined
        ? { ok: true as const, effective }
        : validateNarrowing(effective, { riskFloor: decision.riskFloor });
      if (!narrowed.ok) {
        const stopped = failureOutcome(
          registration,
          "PLUGIN_AUTHORITY_ESCALATION",
          effective,
          annotations,
          warnings,
          trace,
          configuration,
        );
        if (stopped !== undefined) return stopped;
        continue;
      }
      effective = narrowed.effective;
      trace.push({ pluginId: registration.pluginId, hook: registration.hook, status: "asked" });
      return {
        action: "ask",
        reason: decision.reason,
        ...(decision.riskFloor === undefined ? {} : { riskFloor: decision.riskFloor }),
        effective,
        annotations,
        warnings,
        trace,
      };
    }

    const narrowed = validateNarrowing(effective, decision.constraints);
    if (!narrowed.ok) {
      const stopped = failureOutcome(
        registration,
        "PLUGIN_AUTHORITY_ESCALATION",
        effective,
        annotations,
        warnings,
        trace,
        configuration,
      );
      if (stopped !== undefined) return stopped;
      continue;
    }
    effective = narrowed.effective;
    trace.push({ pluginId: registration.pluginId, hook: registration.hook, status: "narrowed" });
  }

  return { action: "continue", effective, annotations, warnings, trace };
}

function failureOutcome(
  registration: RegisteredBeforeHook,
  code: HookWarning["code"],
  effective: EffectivePluginOperation,
  annotations: readonly HookAnnotation[],
  warnings: HookWarning[],
  trace: HookTrace[],
  options: Required<Pick<HookDispatchOptions, "ordinaryFailure">>,
): BeforeHookDispatchOutcome | undefined {
  trace.push({ pluginId: registration.pluginId, hook: registration.hook, status: "failed" });
  const failClosed = registration.scope === "builtin"
    || registration.priority === "critical"
    || options.ordinaryFailure === "closed";
  if (failClosed) {
    return {
      action: "deny",
      reason: "a required plugin hook could not complete safely",
      effective,
      annotations,
      warnings,
      trace,
    };
  }
  warnings.push({ pluginId: registration.pluginId, hook: registration.hook, code });
  return undefined;
}

function parseDecision(value: unknown): BeforeHookDecision {
  const decision = record(value, "hook decision");
  const action = decision.action;
  if (action === "continue") {
    rejectUnknown(decision, ["action", "annotations"], "continue decision");
    return {
      action,
      ...(decision.annotations === undefined ? {} : { annotations: parseAnnotations(decision.annotations) }),
    };
  }
  if (action === "deny") {
    rejectUnknown(decision, ["action", "reason"], "deny decision");
    return { action, reason: boundedText(decision.reason, "deny reason", 512) };
  }
  if (action === "ask") {
    rejectUnknown(decision, ["action", "reason", "riskFloor"], "ask decision");
    return {
      action,
      reason: boundedText(decision.reason, "ask reason", 512),
      ...(decision.riskFloor === undefined ? {} : { riskFloor: risk(decision.riskFloor) }),
    };
  }
  if (action === "narrow") {
    rejectUnknown(decision, ["action", "constraints", "reason"], "narrow decision");
    return {
      action,
      constraints: parseConstraints(decision.constraints),
      reason: boundedText(decision.reason, "narrow reason", 512),
    };
  }
  throw new PluginHookDispatchError("hook decision action is unsupported");
}

function parseConstraints(value: unknown): HookConstraints {
  const constraints = record(value, "hook constraints");
  rejectUnknown(constraints, [
    "workspaceRead",
    "workspaceWrite",
    "credentialScopes",
    "toolIds",
    "contextCandidateIds",
    "network",
    "timeoutMs",
    "outputBytes",
    "maxNodes",
    "riskFloor",
    "sandbox",
  ], "hook constraints");
  return {
    ...(constraints.workspaceRead === undefined ? {} : { workspaceRead: textArray(constraints.workspaceRead, "workspaceRead") }),
    ...(constraints.workspaceWrite === undefined ? {} : { workspaceWrite: textArray(constraints.workspaceWrite, "workspaceWrite") }),
    ...(constraints.credentialScopes === undefined ? {} : { credentialScopes: textArray(constraints.credentialScopes, "credentialScopes") }),
    ...(constraints.toolIds === undefined ? {} : { toolIds: textArray(constraints.toolIds, "toolIds") }),
    ...(constraints.contextCandidateIds === undefined ? {} : { contextCandidateIds: textArray(constraints.contextCandidateIds, "contextCandidateIds") }),
    ...(constraints.network === undefined ? {} : { network: network(constraints.network) }),
    ...(constraints.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(constraints.timeoutMs, "timeoutMs") }),
    ...(constraints.outputBytes === undefined ? {} : { outputBytes: positiveInteger(constraints.outputBytes, "outputBytes") }),
    ...(constraints.maxNodes === undefined ? {} : { maxNodes: positiveInteger(constraints.maxNodes, "maxNodes") }),
    ...(constraints.riskFloor === undefined ? {} : { riskFloor: risk(constraints.riskFloor) }),
    ...(constraints.sandbox === undefined ? {} : { sandbox: sandbox(constraints.sandbox) }),
  };
}

function parseAnnotations(value: unknown): readonly HookAnnotation[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new PluginHookDispatchError("hook annotations must contain at most 32 objects");
  }
  return value.map((item) => {
    const annotation = record(item, "hook annotation");
    rejectUnknown(annotation, ["kind", "message"], "hook annotation");
    return {
      kind: boundedText(annotation.kind, "annotation kind", 128),
      message: boundedText(annotation.message, "annotation message", 512),
    };
  });
}

function validateRegistration(value: RegisteredBeforeHook): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.pluginId)) {
    throw new PluginHookDispatchError("pluginId must be a canonical publisher/name identifier");
  }
  if (value.scope !== "builtin" && value.scope !== "user" && value.scope !== "project") {
    throw new PluginHookDispatchError("hook scope is unsupported");
  }
  if (value.priority !== "critical" && value.priority !== "ordinary") {
    throw new PluginHookDispatchError("hook priority is unsupported");
  }
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal > 10_000) {
    throw new PluginHookDispatchError("hook ordinal must be a bounded non-negative integer");
  }
  if (typeof value.invoke !== "function") {
    throw new PluginHookDispatchError("hook invoke must be a function");
  }
}

function validateInvocation(input: BeforeHookInvocation): void {
  if (
    typeof input.invocationId !== "string"
    || input.invocationId.length === 0
    || input.invocationId.length > 256
    || input.invocationId.trim() !== input.invocationId
  ) {
    throw new PluginHookDispatchError("invocationId must be a bounded opaque identifier");
  }
}

function normalizeOptions(options: HookDispatchOptions): Required<HookDispatchOptions> {
  const normalized: Required<HookDispatchOptions> = {
    perHookTimeoutMs: options.perHookTimeoutMs ?? 2_000,
    aggregateTimeoutMs: options.aggregateTimeoutMs ?? 5_000,
    ordinaryFailure: options.ordinaryFailure ?? "open-with-warning",
    now: options.now ?? (() => Date.now()),
  };
  for (const [name, value] of [
    ["perHookTimeoutMs", normalized.perHookTimeoutMs],
    ["aggregateTimeoutMs", normalized.aggregateTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
      throw new PluginHookDispatchError(name + " must be a bounded positive integer");
    }
  }
  return normalized;
}

function hookGroup(value: RegisteredBeforeHook): number {
  if (value.scope === "builtin") return 0;
  if (value.priority === "critical" && value.scope === "user") return 1;
  if (value.priority === "critical" && value.scope === "project") return 2;
  if (value.priority === "ordinary" && value.scope === "user") return 3;
  return 4;
}

function cloneOperation(value: EffectivePluginOperation): EffectivePluginOperation {
  return {
    workspaceRead: [...value.workspaceRead],
    workspaceWrite: [...value.workspaceWrite],
    credentialScopes: [...value.credentialScopes],
    toolIds: [...value.toolIds],
    contextCandidateIds: [...value.contextCandidateIds],
    network: value.network,
    timeoutMs: value.timeoutMs,
    outputBytes: value.outputBytes,
    maxNodes: value.maxNodes,
    risk: value.risk,
    sandbox: value.sandbox,
  };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HookTimeoutError()), timeoutMs);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class HookTimeoutError extends Error {
  constructor() {
    super("plugin hook timed out");
    this.name = "HookTimeoutError";
  }
}

function network(value: unknown): "deny" | "ask" | "allow" {
  if (value === "deny" || value === "ask" || value === "allow") return value;
  throw new PluginHookDispatchError("hook network constraint is unsupported");
}

function sandbox(value: unknown): "strict" | "standard" | "unrestricted" {
  if (value === "strict" || value === "standard" || value === "unrestricted") return value;
  throw new PluginHookDispatchError("hook sandbox constraint is unsupported");
}

function risk(value: unknown): PluginRiskClass {
  if (value === "R0" || value === "R1" || value === "R2" || value === "R3" || value === "R4") {
    return value;
  }
  throw new PluginHookDispatchError("hook risk floor is unsupported");
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0 || value > 16 * 1024 * 1024) {
    throw new PluginHookDispatchError(name + " must be a bounded positive integer");
  }
  return value;
}

function textArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new PluginHookDispatchError(name + " must contain at most 128 strings");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const parsed = boundedText(item, name, 256);
    if (seen.has(parsed)) throw new PluginHookDispatchError(name + " must not contain duplicates");
    seen.add(parsed);
    return parsed;
  });
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new PluginHookDispatchError(name + " must be bounded non-empty text");
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginHookDispatchError(name + " must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PluginHookDispatchError(name + " contains an unsupported field");
  }
}
