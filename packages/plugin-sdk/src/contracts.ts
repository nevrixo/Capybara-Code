/** Core versioned contracts for isolated Capybara plugins. */

export const PLUGIN_SCHEMA_VERSION = "1.0" as const;
export const PLUGIN_PROTOCOL_VERSION = "1.0" as const;

export type PluginRuntimeKind = "wasi" | "stdio";
export type PluginInstallScope = "builtin" | "user" | "project";
export type PluginRiskClass = "R0" | "R1" | "R2" | "R3" | "R4";
export type PluginToolSideEffect = "read" | "write" | "destructive" | "external" | "unknown";

export const PLUGIN_HOOK_KINDS = [
  "before.session_create",
  "after.session_create",
  "before.session_resume",
  "after.session_resume",
  "before.session_close",
  "after.session_close",
  "before.turn",
  "before.prompt_compile",
  "after.prompt_compile",
  "before.model_request",
  "after.model_response",
  "after.turn",
  "before.tool",
  "before.tool_execute",
  "after.tool_execute",
  "after.tool",
  "on.tool_error",
  "before.edit_plan",
  "before.transaction_commit",
  "after.transaction_commit",
  "on.transaction_conflict",
  "before.verification",
  "after.verification",
  "before.review",
  "after.review",
  "before.agent_spawn",
  "after.agent_complete",
  "before.worktree_create",
  "after.worktree_proposal",
  "before.merge",
  "after.merge",
  "before.context_select",
  "after.context_pack",
  "before.memory_write",
  "after.memory_write",
  "on.memory_invalidate",
] as const;

export type PluginHookKind = (typeof PLUGIN_HOOK_KINDS)[number];

export interface PluginPermissionRequest {
  readonly events?: readonly string[];
  readonly tools?: readonly string[];
  readonly workspaceRead?: readonly string[];
  readonly workspaceWrite?: readonly string[];
  readonly networkDomains?: readonly string[];
  readonly credentials?: readonly string[];
  readonly artifacts?: "none" | "read-own" | "create";
  readonly sessionState?: "none" | "read" | "write-own";
  readonly memory?: "none" | "search" | "propose";
  readonly graph?: "none" | "observe" | "propose-node";
}

export interface PluginRuntimeManifest {
  readonly kind: PluginRuntimeKind;
  readonly entrypoint: string;
  readonly protocolVersion: string;
}

export interface PluginCompatibility {
  readonly capybara: string;
  readonly platforms?: readonly string[];
}

export interface PluginHookSubscriptionManifest {
  readonly kind: PluginHookKind;
  readonly ordinal?: number;
  readonly critical?: boolean;
}

export interface PluginToolManifest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly parametersSchema: unknown;
  readonly requestedRisk: PluginRiskClass;
  readonly sideEffect: PluginToolSideEffect;
  readonly network: boolean;
  readonly resultSchema?: unknown;
}

export interface PluginCommandManifest {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly argumentsSchema: unknown;
  readonly headless: boolean;
}

export interface PluginContextProviderManifest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface PluginUiManifest {
  readonly drawers?: readonly {
    readonly id: string;
    readonly title: string;
    readonly dataSource: string;
  }[];
  readonly statusItems?: readonly {
    readonly id: string;
    readonly label: string;
    readonly eventKinds: readonly string[];
  }[];
}

export interface PluginLimitRequest {
  readonly beforeHookMs?: number;
  readonly afterHookMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxStateBytes?: number;
}

export interface PluginSignature {
  readonly keyId: string;
  readonly algorithm: string;
  readonly signature: string;
}

export interface PluginManifest {
  readonly schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly description: string;
  readonly license: string;
  readonly runtime: PluginRuntimeManifest;
  readonly compatibility: PluginCompatibility;
  readonly hooks?: readonly PluginHookSubscriptionManifest[];
  readonly tools?: readonly PluginToolManifest[];
  readonly commands?: readonly PluginCommandManifest[];
  readonly contextProviders?: readonly PluginContextProviderManifest[];
  readonly ui?: PluginUiManifest;
  readonly permissions: PluginPermissionRequest;
  readonly limits?: PluginLimitRequest;
  readonly integrity: {
    readonly files: Readonly<Record<string, string>>;
    readonly packageDigest: string;
  };
  readonly signature?: PluginSignature;
}
