/**
 * Deterministic in-memory host for plugin unit tests.
 *
 * It intentionally offers only logical, grant-checked workspace reads. It is
 * not an execution sandbox and must never be used to authorize production
 * plugins; the Rust supervisor remains that authority.
 */

import type { PluginHookKind, PluginPermissionRequest } from "./contracts.ts";
import {
  definePlugin,
  type PluginDefinition,
  type PluginToolContext,
  type PluginWorkspaceReader,
} from "./define.ts";
import type { BeforeHookDecision, BeforeHookInvocation } from "./hooks.ts";

export type PluginTestHostErrorCode =
  | "PLUGIN_PERMISSION_DENIED"
  | "PLUGIN_TOOL_NOT_FOUND"
  | "PLUGIN_HOOK_NOT_FOUND"
  | "PLUGIN_WORKSPACE_NOT_FOUND";

export class PluginTestHostError extends Error {
  readonly code: PluginTestHostErrorCode;

  constructor(code: PluginTestHostErrorCode, message: string) {
    super(message);
    this.name = "PluginTestHostError";
    this.code = code;
  }
}

export interface PluginTestHostOptions {
  readonly plugin: PluginDefinition;
  readonly grants?: PluginPermissionRequest;
  readonly workspace?: Readonly<Record<string, string>>;
  readonly invocationId?: string;
}

export interface PluginTestHost {
  invokeTool(id: string, args: unknown): Promise<unknown>;
  invokeHook(kind: PluginHookKind, input: BeforeHookInvocation): Promise<BeforeHookDecision>;
  readonly pluginId: string;
}

/**
 * Build a pure test host with no ambient filesystem access. Workspace fixture
 * keys and tool read paths are canonical workspace-relative logical paths.
 */
export function createPluginTestHost(options: PluginTestHostOptions): PluginTestHost {
  const plugin = definePlugin(options.plugin);
  const workspace = normalizeWorkspace(options.workspace ?? {});
  const grants = options.grants ?? {};
  const invocationId = options.invocationId ?? "test_invocation";

  const reader: PluginWorkspaceReader = {
    async read(input) {
      const path = logicalPath(input.path, "workspace read path");
      if (!isGranted(path, grants.workspaceRead ?? [])) {
        throw new PluginTestHostError(
          "PLUGIN_PERMISSION_DENIED",
          "workspace read is outside the granted logical paths",
        );
      }
      const text = workspace[path];
      if (text === undefined) {
        throw new PluginTestHostError(
          "PLUGIN_WORKSPACE_NOT_FOUND",
          "workspace fixture does not contain the requested logical path",
        );
      }
      return { path, text };
    },
  };

  const context: PluginToolContext = {
    pluginId: plugin.manifest.id,
    invocationId,
    grantedPermissions: grants,
    workspace: reader,
  };

  return {
    pluginId: plugin.manifest.id,
    async invokeTool(id, args) {
      const handler = plugin.tools?.[id];
      if (handler === undefined) {
        throw new PluginTestHostError("PLUGIN_TOOL_NOT_FOUND", "plugin tool is not declared");
      }
      return await handler(args, context);
    },
    async invokeHook(kind, input) {
      const handler = plugin.hooks?.[kind];
      if (handler === undefined) {
        throw new PluginTestHostError("PLUGIN_HOOK_NOT_FOUND", "plugin hook is not declared");
      }
      return await handler(input);
    },
  };
}

function normalizeWorkspace(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [path, text] of Object.entries(input)) {
    const logical = logicalPath(path, "workspace fixture path");
    if (typeof text !== "string" || text.length > 1_048_576) {
      throw new PluginTestHostError(
        "PLUGIN_WORKSPACE_NOT_FOUND",
        "workspace fixture text must be bounded UTF-8 text",
      );
    }
    normalized[logical] = text;
  }
  return normalized;
}

function isGranted(path: string, patterns: readonly string[]): boolean {
  return patterns.some((raw) => {
    const pattern = logicalPattern(raw);
    if (pattern === "**") return true;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return path === prefix || path.startsWith(prefix + "/");
    }
    return path === pattern;
  });
}

function logicalPattern(value: string): string {
  if (value === "**") return value;
  const suffix = value.endsWith("/**") ? "/**" : "";
  const base = suffix.length === 0 ? value : value.slice(0, -suffix.length);
  return logicalPath(base, "workspace grant") + suffix;
}

function logicalPath(value: string, name: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new PluginTestHostError(
      "PLUGIN_PERMISSION_DENIED",
      name + " must be a workspace-relative logical path",
    );
  }
  return value;
}
