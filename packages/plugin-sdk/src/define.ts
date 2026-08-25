/**
 * Safe authoring surface for plugins.
 *
 * Definition-time validation prevents a package from claiming handlers that its
 * signed manifest did not declare. Runtime grants are still evaluated by the
 * host; this module intentionally exposes no ambient filesystem, network, or
 * credential APIs.
 */

import type {
  PluginCommandManifest,
  PluginHookKind,
  PluginManifest,
  PluginPermissionRequest,
} from "./contracts.ts";
import type { BeforeHookDecision, BeforeHookInvocation } from "./hooks.ts";
import { validatePluginManifest } from "./manifest.ts";

export interface PluginWorkspaceReader {
  read(input: { readonly path: string }): Promise<{ readonly path: string; readonly text: string }>;
}

export interface PluginToolContext {
  readonly pluginId: string;
  readonly invocationId: string;
  readonly grantedPermissions: PluginPermissionRequest;
  readonly workspace: PluginWorkspaceReader;
}

export type PluginHookHandler = (
  input: BeforeHookInvocation,
) => BeforeHookDecision | Promise<BeforeHookDecision>;

export type PluginToolHandler = (
  args: unknown,
  context: PluginToolContext,
) => unknown | Promise<unknown>;

export type PluginCommandHandler = (
  args: unknown,
  context: PluginToolContext,
) => unknown | Promise<unknown>;

export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly hooks?: Partial<Record<PluginHookKind, PluginHookHandler>>;
  readonly tools?: Readonly<Record<string, PluginToolHandler>>;
  readonly commands?: Readonly<Record<string, PluginCommandHandler>>;
}

export class PluginDefinitionError extends Error {
  readonly code = "PLUGIN_DEFINITION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginDefinitionError";
  }
}

/**
 * Declare a plugin without granting it any runtime authority. Every supplied
 * handler must correspond to a manifest contribution and every manifest
 * contribution must have exactly one local handler.
 */
export function definePlugin<T extends PluginDefinition>(definition: T): T {
  if (!isRecord(definition)) throw new PluginDefinitionError("plugin definition must be an object");
  rejectUnknown(definition, ["manifest", "hooks", "tools", "commands"], "plugin definition");
  validatePluginManifest(definition.manifest);

  const manifest = definition.manifest;
  validateHooks(manifest, definition.hooks);
  validateTools(manifest, definition.tools);
  validateCommands(manifest.commands, definition.commands);
  return definition;
}

function validateHooks(
  manifest: PluginManifest,
  handlers: PluginDefinition["hooks"],
): void {
  const declared = new Set(manifest.hooks?.map((hook) => hook.kind) ?? []);
  const supplied = handlers ?? {};
  for (const [kind, handler] of Object.entries(supplied)) {
    if (!declared.has(kind as PluginHookKind)) {
      throw new PluginDefinitionError("hook handler is not declared by the manifest");
    }
    if (typeof handler !== "function") {
      throw new PluginDefinitionError("hook handler must be a function");
    }
  }
  for (const kind of declared) {
    if (typeof supplied[kind] !== "function") {
      throw new PluginDefinitionError("manifest hook is missing a handler");
    }
  }
}

function validateTools(
  manifest: PluginManifest,
  handlers: PluginDefinition["tools"],
): void {
  validateContributions(
    manifest.tools?.map((tool) => tool.id) ?? [],
    handlers ?? {},
    "tool",
  );
}

function validateCommands(
  manifest: readonly PluginCommandManifest[] | undefined,
  handlers: PluginDefinition["commands"],
): void {
  validateContributions(
    manifest?.map((command) => command.name) ?? [],
    handlers ?? {},
    "command",
  );
}

function validateContributions(
  declared: readonly string[],
  handlers: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const expected = new Set(declared);
  for (const [id, handler] of Object.entries(handlers)) {
    if (!expected.has(id)) {
      throw new PluginDefinitionError(label + " handler is not declared by the manifest");
    }
    if (typeof handler !== "function") {
      throw new PluginDefinitionError(label + " handler must be a function");
    }
  }
  for (const id of expected) {
    if (typeof handlers[id] !== "function") {
      throw new PluginDefinitionError("manifest " + label + " is missing a handler");
    }
  }
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new PluginDefinitionError(name + " contains an unsupported field");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
