/**
 * Configuration schema and precedence — PRD §21.
 *
 * Product precedence, lowest to highest:
 *   1. built-in defaults
 *   2. the single global user config
 *   3. environment variables
 *   4. CLI flags
 *   5. interactive session override
 *
 * Deprecated project source labels remain in `mergeConfig` only for source
 * compatibility. `loadConfig` never reads or applies a project configuration.
 */

import { configKeyInfo } from "./key-status.ts";

export type PermissionMode = "plan" | "ask" | "auto" | "auto-review";
export type PermissionPreset = "read" | "edit" | "auto" | "yolo";
export type InteractionMode = "build" | "plan";
export type ReviewMode = "off" | "auto";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningMode = "standard" | "pro";
export type ColorMode = "auto" | "always" | "never";
export type StatusDensity = "auto" | "compact" | "full";
export type ThinkingVisibility = "full" | "summary" | "hidden";
export type ThinkingMode = "expanded" | "collapsed" | "off";
export type ToolDetail = "compact" | "full";
export type SubagentDetail = "drawer" | "inline";
export type SidebarVisibility = "auto" | "show" | "hide";

export interface UiConfig {
  theme: string;
  color: ColorMode;
  mouse: boolean;
  animations: boolean;
  showCost: boolean;
  statusDensity: StatusDensity;
  thinkingMode: ThinkingMode;
  /** Legacy alias; populated from thinkingMode during config migration. */
  thinkingVisibility: ThinkingVisibility;
  toolDetail: ToolDetail;
  subagentDetail: SubagentDetail;
  sidebar: SidebarVisibility;
}

export type ModelRouterStrategy = "utility" | "latency" | "cost";
export type PremiumBandPolicy = "deny" | "allow" | "utility-gated";
export type CacheMode = "roi" | "always" | "off";

export interface ModelRouterConfig {
  strategy: ModelRouterStrategy;
  phasePolicy: boolean;
  cheapTier: string;
  defaultTier: string;
  escalationTier: string;
  maxCostUsdPerTurn: number;
  targetLatencyMs: number;
  recordDecisions: boolean;
}

export interface ModelReasoningConfig {
  /** Provider request policy; intentionally independent from UI disclosure. */
  providerSummary: "auto" | "off";
  /** Legacy provider-summary alias. */
  summary: "auto" | "none";
  continuity: "task-epoch";
  proPolicy: "eval-gated";
  maxPolicy: "eval-gated";
  resetOnWorkspaceChange: boolean;
  preserveOpaqueItems: boolean;
}

export interface ModelContextConfig {
  bands: number[];
  defaultBand: number;
  premiumThresholdTokens: number;
  premiumBandPolicy: PremiumBandPolicy;
  compaction: "evidence-ledger";
  reserveOutputTokens: number;
  orientationMode: "strict" | "progressive";
  providerCompaction: boolean;
  compactionThresholdTokens: number;
}

export interface ModelCacheConfig {
  mode: CacheMode;
  maxWritesPerTurn: number;
  ttlMinutes: number;
  minimumReuseProbability: number;
  recordReadWriteTokens: boolean;
}

export interface ProviderOpenAINativeConfig {
  programmaticToolCalling: "read-only" | "disabled";
  hostedMultiAgent: "read-only" | "disabled";
  maxHostedAgents: number;
  maxProgramToolCalls: number;
  maxProgramParallelCalls: number;
  allowHostedShell: boolean;
  allowHostedApplyPatch: boolean;
  allowComputerUse: boolean;
}

export interface ProviderConfig {
  openai: {
    native: ProviderOpenAINativeConfig;
    transport: "http_full" | "http_previous" | "websocket";
    serviceTier: "standard" | "fast";
    toolSearch: boolean;
  };
}

export interface ToolGraphConfig {
  maxParallelReads: number;
  maxParallelTests: number;
  serializeMutations: boolean;
  stableResultOrder: boolean;
  commandClassification: boolean;
  providerParallelTools: boolean;
}

export interface VerificationConfig {
  completionRequiresFreshEvidence: boolean;
  independentReviewRiskThreshold: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
  falseCompletePolicy: "block" | "warn";
  reviewPolicy: "always" | "risk";
}
export interface ModelConfig {
  profile: string;
  default: string;
  reasoningMode: ReasoningMode;
  reasoningEffort: ReasoningEffort;
  softContextTokens: number;
  maxOutputTokens: number;
  router: ModelRouterConfig;
  reasoning: ModelReasoningConfig;
  context: ModelContextConfig;
  cache: ModelCacheConfig;
  profiles: Record<string, ModelProfileConfig>;
}

export interface ModelProfileConfig {
  model: string;
  reasoningMode: ReasoningMode;
  reasoningEffort: ReasoningEffort;
}

export type SavingLevel = "off" | "light" | "balanced" | "strong";
export type ToolRecoveryMode = "off" | "safe" | "full";

export interface ToolRecoveryConfig {
  mode: ToolRecoveryMode;
  maxAttempts: number;
}

export interface TodoConfig {
  autoProgress: boolean;
  safeRebase: boolean;
}

// Adaptive saving profile.
export interface AgentConfig {
  permissionMode: PermissionMode;
  /** Independent work intent; permissionMode remains for old config readers. */
  interactionMode?: InteractionMode;
  reviewMode?: ReviewMode;
  visibleCommentary: boolean;
  tokenSaving: SavingLevel;
  promptCompiler: "v1" | "v2";
  compoundTools: boolean;
  toolRecovery: ToolRecoveryConfig;
  todo: TodoConfig;
  toolGraph: ToolGraphConfig;
  verification: VerificationConfig;
}

export interface PerformanceConfig {
  telemetry: boolean;
  sampleRate: number;
  /** Rollout switches for the performance-plan optimizations. */
  contextPackProjection?: boolean;
  subagentProfileResolutionV2?: boolean;
  subagentContextReservations?: boolean;
  phaseRouting?: boolean;
  budgetEnforcement?: "shadow" | "advisory" | "hard";
  retrievalControllerV2?: boolean;
  verificationPlannerV2?: boolean;
  commentaryPolicyV2?: boolean;
  /** Long-session bounded resume optimizations; omitted means enabled. */
  longSessionFastPath?: boolean;
}

export interface SubagentsConfig {
  maxConcurrent: number;
  maxDepth: number;
  writerPolicy: "single-lease";
}

export interface ToolsConfig {
  activationLimit: number;
  inlineOutputBytes: number;
  inlineOutputLines: number;
}

/**
 * §13.3 a declarative approval rule written in config (P0-13).
 *
 * Config rules are merged with the persisted `approvals.json` grants before the
 * policy engine runs. A config rule names a tool and the match criteria; the
 * engine still re-checks workspace trust before honouring it, so a rule in one
 * repository's config cannot grant anything in an untrusted workspace.
 */
export interface ConfigPermissionRule {
  readonly tool: string;
  readonly decision: "allow" | "deny";
  /** Risk the rule applies to; an escalated action re-asks. */
  readonly risk: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
  readonly program?: string;
  readonly argsExact?: string[];
  readonly argsPrefix?: string[];
  readonly cwd?: string;
  readonly paths?: string[];
  readonly server?: string;
}

export interface PermissionsConfig {
  preset?: PermissionPreset;
  projectWrite: "plan" | "ask" | "auto";
  shell: "deny" | "ask" | "safe-auto";
  network: "deny" | "ask" | "allow";
  destructive: "deny" | "ask";
  credentials: "deny" | "ask";
  externalSideEffect: "deny" | "ask";
  /** §13.3 declarative approval rules, merged with persisted grants (P0-13). */
  rules: ConfigPermissionRule[];
}

export interface SandboxConfig {
  level: "none" | "workspace" | "standard" | "strict";
  networkForShell: "deny" | "ask" | "allow";
}

export interface SessionsConfig {
  retain: boolean;
  artifactRetentionDays: number;
  autoSnapshotEvents: number;
}

export interface PrivacyConfig {
  telemetry: boolean;
  crashReports: "off" | "ask" | "on";
  providerStore: boolean;
}

export interface UpdatesConfig {
  channel: "stable" | "beta" | "nightly";
  check: boolean;
  intervalHours: number;
}

export interface McpServerConfig {
  transport: "stdio" | "streamable_http";
  command?: string;
  args?: string[];
  url?: string;
  env?: string[];
  auth?: "none" | "oauth" | "bearer";
  enabled?: boolean;
  /** Whether this server should connect during session bootstrap instead of on first use. */
  connectOnStartup?: boolean;
  timeoutMs?: number;
}

export interface LspServerConfig {
  command: string;
  args?: string[];
  extensions: string[];
  languageId: string;
  enabled?: boolean;
  installHint?: string;
  timeoutMs?: number;
}

export interface ExperimentalConfig {
  editEngineV2: boolean;
  fullLsp: boolean;
  sessionDaemon: boolean;
  durableMemory: boolean;
  persistentAgentGraph: boolean;
  worktreeMultiAgent: boolean;
  pluginRuntime: boolean;
  appServer: boolean;
}

export interface EditConfig {
  engine: "anchor-range-v2";
  maxOperationsPerPlan: number;
  maxFileBytes: number;
  maxAnchorTextBytes: number;
  maxAnchorCandidates: number;
  safeRebase: boolean;
  previewBeforeLspMutation: boolean;
  recordResolutionEvidence: boolean;
  limits: { maxTotalChangedBytes: number; maxTotalFiles: number; maxDiffPreviewLines: number };
}

export interface LspConfig {
  enabled: boolean;
  planMode: "disabled" | "read-only-certified";
  maxOpenDocumentsPerServer: number;
  maxPendingRequestsPerServer: number;
  maxDiagnosticsPerFile: number;
  maxWorkspaceSymbols: number;
  restartLimit: number;
  restartWindowSeconds: number;
  recordQueryEvidence: boolean;
  mutations: { rename: boolean; codeActions: boolean; formatting: boolean; previewRequired: boolean; maxFiles: number; maxChangedBytes: number };
  commands: { allow: string[] };
}

export interface MemoryConfig {
  enabled: boolean;
  workspaceEnabled: boolean;
  sessionEnabled: boolean;
  taskEnabled: boolean;
  autoCandidates: boolean;
  requireExactEvidenceForWorkspace: boolean;
  allowSessionFallback: boolean;
  maxRecordsPerWorkspace: number;
  maxValueBytes: number;
  recallLimit: number;
  recallTokenBudget: number;
  retentionDays: number;
  confidence: { workspace: number; session: number; task: number };
  privacy: { storeRawTranscript: false; storeSensitivePaths: boolean; allowPluginProposals: boolean };
}

export interface DaemonConfig {
  enabled: boolean;
  autostart: boolean;
  idleShutdownMinutes: number;
  workspaceIdleMinutes: number;
  heartbeatSeconds: number;
  ownerLeaseSeconds: number;
  gracefulShutdownSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
  transport: { mode: "local"; allowTcp: false; socketPath: "auto"; maxConnections: number; maxFrameBytes: number };
  clients: { controlLeaseSeconds: number; detachGraceSeconds: number; maxEventQueueItems: number; maxEventQueueBytes: number };
}

export interface AgentGraphConfig {
  enabled: boolean;
  maxDepth: number;
  maxNodes: number;
  maxConcurrentNodes: number;
  maxConcurrentReaders: number;
  maxConcurrentWriters: number;
  maxAttemptsPerNode: number;
  checkpointEvents: number;
  messageBytes: number;
  recoveryPolicy: "safe-retry" | "manual";
  budget: { mode: "hard" | "advisory"; maxCostUsd: number; maxToolCalls: number; maxWallClockMinutes: number };
}

export interface WorktreesConfig {
  enabled: boolean;
  root: "auto";
  maxActive: number;
  maxActiveWriters: number;
  requireCleanBase: boolean;
  retentionHours: number;
  runtimePerWorktree: boolean;
  lspPerWorktree: boolean;
  merge: { previewRequired: boolean; independentReview: boolean; verifyOnBase: boolean; autoMergeDisjoint: boolean; conflictPolicy: "block" };
}

export interface PluginsConfig {
  enabled: boolean;
  allowProjectWasi: boolean;
  allowProjectStdio: false;
  allowUnsafeLocal: false;
  requireSignatureForRegistry: boolean;
  maxActivePerWorkspace: number;
  limits: { beforeHookMs: number; afterHookMs: number; aggregateBeforeHookMs: number; maxOutputBytes: number; maxStateBytes: number; maxReentrancyDepth: number; maxNestedToolCalls: number };
  failure: { criticalBefore: "closed"; ordinaryBefore: "open-with-warning" | "closed"; after: "open"; circuitFailures: number };
}

export interface AppServerConfig {
  enabled: boolean;
  transport: "local";
  allowLoopbackWebsocket: false;
  maxConnections: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxSubscriptionsPerClient: number;
  maxSessionsPerSubscription: number;
  events: { maxBatchEvents: number; maxBatchBytes: number; ackTimeoutSeconds: number; slowClientPolicy: "replay" | "disconnect" };
}

export interface SdkConfig {
  reconnect: boolean;
  reconnectMaxAttempts: number;
}
export interface CbcConfig {
  ui: UiConfig;
  model: ModelConfig;
  agent: AgentConfig;
  subagents: SubagentsConfig;
  tools: ToolsConfig;
  permissions: PermissionsConfig;
  sandbox: SandboxConfig;
  sessions: SessionsConfig;
  privacy: PrivacyConfig;
  updates: UpdatesConfig;
  provider: ProviderConfig;
  perf: PerformanceConfig;
  experimental: ExperimentalConfig;
  edit: EditConfig;
  lsp: LspConfig;
  memory: MemoryConfig;
  daemon: DaemonConfig;
  agentGraph: AgentGraphConfig;
  worktrees: WorktreesConfig;
  plugins: PluginsConfig;
  appServer: AppServerConfig;
  sdk: SdkConfig;
  mcpServers: Record<string, McpServerConfig>;
  lspServers: Record<string, LspServerConfig>;
  keymap: Record<string, string>;
}

/** §21.4 defaults, matching the documented example config exactly. */
export function defaultConfig(): CbcConfig {
  const config: CbcConfig = {
    ui: {
      theme: "capybara-dark",
      color: "auto",
      // Mouse reporting is required for wheel events to reach the full-screen
      // timeline instead of being interpreted as composer history navigation.
      mouse: true,
      animations: true,
      showCost: true,
      statusDensity: "auto",
      thinkingMode: "collapsed",
      thinkingVisibility: "summary",
      toolDetail: "compact",
      subagentDetail: "drawer",
      sidebar: "auto",
    },
    model: {
      profile: "auto",
      default: "gpt-5.6-sol",
      reasoningMode: "standard",
      reasoningEffort: "medium",
      softContextTokens: 96_000,
      // Keep enough shared generation capacity for reasoning and a visible answer.
      maxOutputTokens: 32_000,
      router: {
        strategy: "utility",
        phasePolicy: true,
        cheapTier: "gpt-5.6-luna",
        defaultTier: "gpt-5.6-terra",
        escalationTier: "gpt-5.6-sol",
        maxCostUsdPerTurn: 2,
        targetLatencyMs: 90_000,
        recordDecisions: true,
      },
      reasoning: {
        // Request summaries independently of whether the current TUI renders them.
        providerSummary: "auto",
        summary: "auto",
        continuity: "task-epoch",
        proPolicy: "eval-gated",
        maxPolicy: "eval-gated",
        resetOnWorkspaceChange: true,
        preserveOpaqueItems: true,
      },
      context: {
        bands: [64_000, 192_000, 272_000, 512_000, 1_000_000],
        defaultBand: 192_000,
        premiumThresholdTokens: 272_000,
        premiumBandPolicy: "utility-gated",
        compaction: "evidence-ledger",
        reserveOutputTokens: 32_000,
        orientationMode: "progressive",
        providerCompaction: true,
        compactionThresholdTokens: 80_000,
      },
      cache: {
        mode: "roi",
        maxWritesPerTurn: 2,
        ttlMinutes: 30,
        minimumReuseProbability: 0.55,
        recordReadWriteTokens: true,
      },
      // §10.3 profile table.
      profiles: {
        auto: { model: "gpt-5.6-sol", reasoningMode: "standard", reasoningEffort: "medium" },
        fast: { model: "gpt-5.6-terra", reasoningMode: "standard", reasoningEffort: "low" },
        balanced: { model: "gpt-5.6-sol", reasoningMode: "standard", reasoningEffort: "medium" },
        deep: { model: "gpt-5.6-sol", reasoningMode: "standard", reasoningEffort: "high" },
        review: { model: "gpt-5.6-sol", reasoningMode: "pro", reasoningEffort: "high" },
        economy: { model: "gpt-5.6-luna", reasoningMode: "standard", reasoningEffort: "low" },
      },
    },
    agent: {
      // Interim default per the security review: until per-process capability
      // leases exist, execution asks rather than assumes. `auto` /
      // `auto-review` remain available as explicit opt-ins.
      permissionMode: "ask",
      interactionMode: "build",
      reviewMode: "auto",
      visibleCommentary: true,
      tokenSaving: "off",
      promptCompiler: "v2",
      compoundTools: true,
      toolRecovery: { mode: "safe", maxAttempts: 3 },
      todo: { autoProgress: true, safeRebase: true },
      toolGraph: {
        maxParallelReads: 8,
        maxParallelTests: 2,
        serializeMutations: true,
        stableResultOrder: true,
        commandClassification: true,
        providerParallelTools: true,
      },
      verification: {
        completionRequiresFreshEvidence: true,
        independentReviewRiskThreshold: "R3",
        falseCompletePolicy: "block",
        reviewPolicy: "risk",
      },
    },
    subagents: {
      maxConcurrent: 3,
      maxDepth: 1,
      writerPolicy: "single-lease",
    },
    tools: {
      activationLimit: 10,
      inlineOutputBytes: 65_536,
      inlineOutputLines: 200,
    },
    permissions: {
      projectWrite: "auto",
      shell: "safe-auto",
      network: "ask",
      destructive: "ask",
      credentials: "deny",
      externalSideEffect: "ask",
      rules: [],
    },
    sandbox: {
      level: "workspace",
      networkForShell: "ask",
    },
    sessions: {
      retain: true,
      artifactRetentionDays: 30,
      autoSnapshotEvents: 100,
    },
    privacy: {
      telemetry: false,
      crashReports: "ask",
      providerStore: false,
    },
    updates: {
      channel: "stable",
      check: true,
      intervalHours: 24,
    },
    provider: {
      openai: {
        transport: "websocket",
        serviceTier: "standard",
        toolSearch: false,
        native: {
          programmaticToolCalling: "read-only",
          hostedMultiAgent: "read-only",
          maxHostedAgents: 3,
          maxProgramToolCalls: 24,
          maxProgramParallelCalls: 6,
          allowHostedShell: false,
          allowHostedApplyPatch: false,
          allowComputerUse: false,
        },
      },
    },
    perf: {
      telemetry: true,
      sampleRate: 1,
      contextPackProjection: true,
      subagentProfileResolutionV2: true,
      subagentContextReservations: true,
      phaseRouting: true,
      budgetEnforcement: "advisory",
      retrievalControllerV2: true,
      verificationPlannerV2: true,
      commentaryPolicyV2: true,
    },
    // Every new runtime surface is opt-in at the common gate. The detailed
    // limits are still materialized so enabling a feature never requires an
    // unsafe, partially specified configuration.
    experimental: {
      editEngineV2: false,
      fullLsp: false,
      sessionDaemon: false,
      durableMemory: false,
      persistentAgentGraph: false,
      worktreeMultiAgent: false,
      pluginRuntime: false,
      appServer: false,
    },
    edit: {
      engine: "anchor-range-v2",
      maxOperationsPerPlan: 100,
      maxFileBytes: 8_388_608,
      maxAnchorTextBytes: 65_536,
      maxAnchorCandidates: 32,
      safeRebase: true,
      previewBeforeLspMutation: true,
      recordResolutionEvidence: true,
      limits: { maxTotalChangedBytes: 16_777_216, maxTotalFiles: 100, maxDiffPreviewLines: 300 },
    },
    lsp: {
      enabled: true,
      planMode: "disabled",
      maxOpenDocumentsPerServer: 128,
      maxPendingRequestsPerServer: 64,
      maxDiagnosticsPerFile: 1_000,
      maxWorkspaceSymbols: 5_000,
      restartLimit: 3,
      restartWindowSeconds: 300,
      recordQueryEvidence: true,
      mutations: { rename: true, codeActions: true, formatting: true, previewRequired: true, maxFiles: 100, maxChangedBytes: 16_777_216 },
      commands: { allow: [] },
    },
    memory: {
      enabled: true,
      workspaceEnabled: true,
      sessionEnabled: true,
      taskEnabled: true,
      autoCandidates: true,
      requireExactEvidenceForWorkspace: true,
      allowSessionFallback: true,
      maxRecordsPerWorkspace: 10_000,
      maxValueBytes: 16_384,
      recallLimit: 32,
      recallTokenBudget: 4_096,
      retentionDays: 180,
      confidence: { workspace: 0.8, session: 0.5, task: 0.5 },
      privacy: { storeRawTranscript: false, storeSensitivePaths: false, allowPluginProposals: true },
    },
    daemon: {
      enabled: true,
      autostart: true,
      idleShutdownMinutes: 30,
      workspaceIdleMinutes: 10,
      heartbeatSeconds: 5,
      ownerLeaseSeconds: 20,
      gracefulShutdownSeconds: 10,
      logLevel: "info",
      transport: { mode: "local", allowTcp: false, socketPath: "auto", maxConnections: 32, maxFrameBytes: 8_388_608 },
      clients: { controlLeaseSeconds: 30, detachGraceSeconds: 5, maxEventQueueItems: 1_000, maxEventQueueBytes: 8_388_608 },
    },
    agentGraph: {
      enabled: true,
      maxDepth: 3,
      maxNodes: 10_000,
      maxConcurrentNodes: 8,
      maxConcurrentReaders: 8,
      maxConcurrentWriters: 4,
      maxAttemptsPerNode: 3,
      checkpointEvents: 25,
      messageBytes: 65_536,
      recoveryPolicy: "safe-retry",
      budget: { mode: "hard", maxCostUsd: 20, maxToolCalls: 1_000, maxWallClockMinutes: 120 },
    },
    worktrees: {
      enabled: true,
      root: "auto",
      maxActive: 8,
      maxActiveWriters: 4,
      requireCleanBase: true,
      retentionHours: 24,
      runtimePerWorktree: true,
      lspPerWorktree: true,
      merge: { previewRequired: true, independentReview: true, verifyOnBase: true, autoMergeDisjoint: true, conflictPolicy: "block" },
    },
    plugins: {
      enabled: true,
      allowProjectWasi: true,
      allowProjectStdio: false,
      allowUnsafeLocal: false,
      requireSignatureForRegistry: true,
      maxActivePerWorkspace: 16,
      limits: { beforeHookMs: 2_000, afterHookMs: 5_000, aggregateBeforeHookMs: 5_000, maxOutputBytes: 1_048_576, maxStateBytes: 1_048_576, maxReentrancyDepth: 2, maxNestedToolCalls: 8 },
      failure: { criticalBefore: "closed", ordinaryBefore: "open-with-warning", after: "open", circuitFailures: 3 },
    },
    appServer: {
      enabled: true,
      transport: "local",
      allowLoopbackWebsocket: false,
      maxConnections: 32,
      maxRequestBytes: 8_388_608,
      maxResponseBytes: 8_388_608,
      maxSubscriptionsPerClient: 16,
      maxSessionsPerSubscription: 32,
      events: { maxBatchEvents: 100, maxBatchBytes: 1_048_576, ackTimeoutSeconds: 30, slowClientPolicy: "replay" },
    },
    sdk: { reconnect: true, reconnectMaxAttempts: 8 },

    // Executable integrations live in the generated global TOML. Keeping these
    // maps empty makes that file the only source of service definitions.
    mcpServers: {},
    lspServers: {},
    keymap: {},
  };
  Object.defineProperty(config.perf, "longSessionFastPath", {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return config;
}

export type ConfigSource =
  | "default"
  | "user"
  | "project"
  | "project-local"
  | "environment"
  | "cli"
  | "session";

export interface ConfigIssue {
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
  readonly source: ConfigSource;
}

export interface EffectiveConfig {
  readonly config: CbcConfig;
  /** Which source last set each dotted path, for configuration diagnostics. */
  readonly provenance: Record<string, ConfigSource>;
  readonly issues: ConfigIssue[];
}

/**
 * §21.7 forbidden project keys. A project may never carry a credential value or
 * name a host environment variable for an MCP process; those bindings are
 * user-owned because a launched server can read and exfiltrate the value.
 */
const FORBIDDEN_PROJECT_PATHS = [
  "auth",
  "credentials",
  "apiKey",
  "api_key",
  "openaiApiKey",
  "openai_api_key",
  "token",
  "secret",
  "password",
] as const;

/**
 * §21.3 override policy: keys a project layer may not set at all.
 *
 * "Trusted" authorizes reading a project's code and taking its model hints; it
 * does not authorize rewriting the user's supply-chain or data-handling choices:
 * the update channel, the provider's hosted-feature toggles, and telemetry all
 * stay user-owned.
 */
const USER_ONLY_PROJECT_PREFIXES = [
  "agent.tokenSaving",
  "updates.",
  "provider.openai.",
  "perf.",
  "daemon.",
  "appServer.",
  "sdk.",
  "plugins.allowProjectStdio",
  "plugins.allowUnsafeLocal",
  "plugins.requireSignatureForRegistry",
  "worktrees.root",
  "memory.privacy.",
] as const;

/**
 * Monotonic policy keys. The array runs strictest → most permissive; a project
 * layer may move the value left (stricter) but never right. A user who sets
 * `network = "deny"` keeps that floor against every repository they open.
 */
const MONOTONIC_PROJECT_ORDER: Record<string, readonly string[]> = {
  "permissions.preset": ["read", "edit", "auto", "yolo"],
  "permissions.projectWrite": ["plan", "ask", "auto"],
  "permissions.network": ["deny", "ask", "allow"],
  "permissions.shell": ["deny", "ask", "safe-auto"],
  "permissions.destructive": ["deny", "ask"],
  "permissions.credentials": ["deny", "ask"],
  "permissions.externalSideEffect": ["deny", "ask"],
  // Strictest first, like every other scale here: moving right is a weakening.
  "sandbox.level": ["strict", "standard", "workspace", "none"],
  "sandbox.networkForShell": ["deny", "ask", "allow"],
  "agent.permissionMode": ["plan", "ask", "auto-review", "auto"],
  "agent.interactionMode": ["build", "plan"],
  // Review safeguards are also monotonic: projects may require more review,
  // but may never relax the user's (or an earlier project's) effective floor.
  "agent.reviewMode": ["auto", "off"],
  "agent.verification.reviewPolicy": ["always", "risk"],
  "agent.verification.independentReviewRiskThreshold": ["R0", "R1", "R2", "R3", "R4", "R5", "R6"],
  "agent.verification.falseCompletePolicy": ["block", "warn"],
  "privacy.crashReports": ["off", "ask", "on"],
};

/**
 * Strict values for monotonic booleans. Projects may select or preserve the
 * strict value, but may never flip an effective strict value to its weaker peer.
 */
const MONOTONIC_PROJECT_BOOLEAN_STRICT_VALUE: Readonly<Record<string, boolean>> = {
  "privacy.telemetry": false,
  "privacy.providerStore": false,
  "agent.verification.completionRequiresFreshEvidence": true,
  "experimental.editEngineV2": false,
  "experimental.fullLsp": false,
  "experimental.sessionDaemon": false,
  "experimental.durableMemory": false,
  "experimental.persistentAgentGraph": false,
  "experimental.worktreeMultiAgent": false,
  "experimental.pluginRuntime": false,
  "experimental.appServer": false,
  "edit.safeRebase": false,
  "lsp.mutations.rename": false,
  "lsp.mutations.codeActions": false,
  "lsp.mutations.formatting": false,
  "memory.workspaceEnabled": false,
  "worktrees.enabled": false,
};

const ENUMS: Record<string, readonly string[]> = {
  "ui.thinkingVisibility": ["full", "summary", "hidden"],
  "ui.thinkingMode": ["expanded", "collapsed", "off"],
  "ui.toolDetail": ["compact", "full"],
  "ui.subagentDetail": ["drawer", "inline"],
  "ui.sidebar": ["auto", "show", "hide"],
  "permissions.preset": ["read", "edit", "auto", "yolo"],
  "model.router.strategy": ["utility", "latency", "cost"],
  "model.context.orientationMode": ["strict", "progressive"],
  "model.context.premiumBandPolicy": ["deny", "allow", "utility-gated"],
  "model.cache.mode": ["roi", "always", "off"],
  "provider.openai.native.programmaticToolCalling": ["read-only", "disabled"],
  "provider.openai.native.hostedMultiAgent": ["read-only", "disabled"],
  "provider.openai.transport": ["http_full", "http_previous", "websocket"],
  "provider.openai.serviceTier": ["standard", "fast"],
  "agent.tokenSaving": ["off", "light", "balanced", "strong"],
  "agent.toolRecovery.mode": ["off", "safe", "full"],
  "perf.budgetEnforcement": ["shadow", "advisory", "hard"],
  "agent.promptCompiler": ["v1", "v2"],
  "agent.verification.reviewPolicy": ["always", "risk"],
  "agent.verification.independentReviewRiskThreshold": ["R0", "R1", "R2", "R3", "R4", "R5", "R6"],
  "agent.verification.falseCompletePolicy": ["block", "warn"],  "ui.color": ["auto", "always", "never"],
  "ui.statusDensity": ["auto", "compact", "full"],
  "model.reasoningMode": ["standard", "pro"],
  "model.reasoningEffort": ["none", "low", "medium", "high", "xhigh", "max"],
  "model.reasoning.summary": ["auto", "none"],
  "model.reasoning.providerSummary": ["auto", "off"],
  "agent.permissionMode": ["plan", "ask", "auto", "auto-review"],
  "agent.interactionMode": ["build", "plan"],
  "agent.reviewMode": ["off", "auto"],
  "subagents.writerPolicy": ["single-lease"],
  "permissions.projectWrite": ["plan", "ask", "auto"],
  "permissions.shell": ["deny", "ask", "safe-auto"],
  "permissions.network": ["deny", "ask", "allow"],
  "permissions.destructive": ["deny", "ask"],
  "permissions.credentials": ["deny", "ask"],
  "permissions.externalSideEffect": ["deny", "ask"],
  "sandbox.level": ["none", "workspace", "standard", "strict"],
  "sandbox.networkForShell": ["deny", "ask", "allow"],
  "privacy.crashReports": ["off", "ask", "on"],
  "updates.channel": ["stable", "beta", "nightly"],
  "edit.engine": ["anchor-range-v2"],
  "lsp.planMode": ["disabled", "read-only-certified"],
  "daemon.logLevel": ["debug", "info", "warn", "error"],
  "daemon.transport.mode": ["local"],
  "daemon.transport.socketPath": ["auto"],
  "agentGraph.recoveryPolicy": ["safe-retry", "manual"],
  "agentGraph.budget.mode": ["hard", "advisory"],
  "worktrees.root": ["auto"],
  "worktrees.merge.conflictPolicy": ["block"],
  "plugins.failure.criticalBefore": ["closed"],
  "plugins.failure.ordinaryBefore": ["open-with-warning", "closed"],
  "plugins.failure.after": ["open"],
  "appServer.transport": ["local"],
  "appServer.events.slowClientPolicy": ["replay", "disconnect"],
};

/**
 * The allowed values for a dotted config key, when it is an enum (§21.4).
 *
 * Exposed so a caller that offers these values to the user — `/effort`'s
 * completion popup, `capy config set`'s suggestions — reads them from the schema
 * rather than restating them. A second copy is a copy that eventually disagrees
 * with the validator, and then the UI offers a value the config rejects.
 */
export function configEnumValues(key: string): readonly string[] | undefined {
  return ENUMS[key];
}

/** Deprecated keys and their replacements (§21.7 migration message). */
const REMOVED: Readonly<Record<string, string>> = {
  "agent.maxSteps": "root turns now run until completion or cancellation",
  "agent.maxToolCalls": "root turns now run until completion or cancellation",
  "agent.maxWallTimeMinutes": "root turns now run until completion or cancellation",
  "subagents.maxPerTurn": "child registration is now unbounded per turn and excess parallel work is queued",
};

const DEPRECATED: Record<string, string> = {
  "agent.mode": "agent.permissionMode",
  "model.reasoning": "model.reasoningEffort",
  "ui.colors": "ui.color",
  "sandbox.enabled": "sandbox.level",
  "ui.thinkingVisibility": "ui.thinkingMode",
  "model.reasoning.summary": "model.reasoning.providerSummary",
};

/** A partial config layer, keyed by dotted path. */
export type ConfigLayer = Record<string, unknown>;

/**
 * Merge layers in §21.2 order. Later layers win, except where §21.3 makes a key
 * user-only or monotonic: a trusted project layer can never weaken the user's
 * security policy. Unknown keys become warnings; type and enum violations become
 * errors.
 */
export function mergeConfig(
  layers: ReadonlyArray<{ source: ConfigSource; values: ConfigLayer }>,
): EffectiveConfig {
  const config = defaultConfig();
  const provenance: Record<string, ConfigSource> = {};
  const issues: ConfigIssue[] = [];  const explicitThinkingKeys = new Set<string>();
  for (const layer of layers) {
    if (Object.prototype.hasOwnProperty.call(layer.values, "ui.thinkingMode")) explicitThinkingKeys.add("ui.thinkingMode");
    if (Object.prototype.hasOwnProperty.call(layer.values, "model.reasoning.providerSummary")) explicitThinkingKeys.add("model.reasoning.providerSummary");
  }

  // Servers the user defined themselves. A project may add servers, but it may
  // not rewrite a user-defined one — an overridden command/env would run the
  // user's credentials against a server the user never chose (§17).
  const userMcpServers = new Set<string>();
  for (const layer of layers) {
    if (layer.source !== "user") continue;
    for (const key of Object.keys(layer.values)) {
      if (!hasUnsafePathSegment(key) && key.startsWith("mcpServers.")) {
        userMcpServers.add(key.split(".")[1] as string);
      }
    }
  }

  for (const layer of layers) {
    for (const [path, rawValue] of Object.entries(layer.values)) {
      let value = rawValue;
      if (value === undefined) continue;

      if (hasUnsafePathSegment(path)) {
        issues.push({
          severity: "error",
          path,
          source: layer.source,
          message: "configuration path '" + path + "' contains a forbidden object-property segment",
        });
        continue;
      }

      // §13.6 / §21.3: a project layer must not carry credentials.
      if ((layer.source === "project" || layer.source === "project-local") && isForbiddenProjectPath(path)) {
        issues.push({
          severity: "error",
          path,
          source: layer.source,
          message: `project config may not set '${path}'; credentials come from the user keychain`,
        });
        continue;
      }

      const removedReason = REMOVED[path];
      if (removedReason !== undefined) {
        issues.push({
          severity: "warning",
          path,
          source: layer.source,
          message: `'${path}' was removed; ${removedReason}`,
        });
        continue;
      }

      const replacement = DEPRECATED[path];
      if (replacement) {
        issues.push({
          severity: "warning",
          path,
          source: layer.source,
          message: `'${path}' is deprecated; use '${replacement}'`,
        });
      }

      const target = replacement ?? path;
      if (replacement !== undefined && explicitThinkingKeys.has(replacement)) {
        issues.push({
          severity: "warning",
          path,
          source: layer.source,
          message: `'${path}' is ignored because '${replacement}' is set`,
        });
        continue;
      }
      if (path === "ui.thinkingVisibility") {
        value = value === "full" ? "expanded" : value === "summary" ? "collapsed" : value === "hidden" ? "off" : value;
      }
      if (path === "model.reasoning.summary") value = value === "none" ? "off" : value;

      if (hasUnsafePathSegment(target)) {
        issues.push({
          severity: "error",
          path: target,
          source: layer.source,
          message: "configuration path '" + target + "' contains a forbidden object-property segment",
        });
        continue;
      }

      const isProjectLayer = layer.source === "project" || layer.source === "project-local";
      if (target === "permissions.preset" && value === "yolo" && isProjectLayer) {
        issues.push({
          severity: "error",
          path: target,
          source: layer.source,
          message: "project config may not enable yolo",
        });
        continue;
      }
      if (isProjectLayer) {
        if (target === "permissions.rules" && Array.isArray(value)) {
          const restrictiveRules = value.filter(
            (rule): rule is Record<string, unknown> =>
              typeof rule === "object" &&
              rule !== null &&
              !Array.isArray(rule) &&
              rule.decision !== "allow",
          );
          const projectAllows = value.length - restrictiveRules.length;
          if (projectAllows > 0) {
            issues.push({
              severity: "error",
              path: target,
              source: layer.source,
              message: "project config may declare deny rules only; allow rules require explicit user approval",
            });
          }
          value = restrictiveRules;
        }
        if (USER_ONLY_PROJECT_PREFIXES.some((prefix) => target.startsWith(prefix))) {
          issues.push({
            severity: "error",
            path: target,
            source: layer.source,
            message: `'${target}' is user-only; a project cannot change the user's supply-chain or data-handling policy`,
          });
          continue;
        }
        if (target.startsWith("mcpServers.")) {
          const serverName = target.split(".")[1] as string;
          if (userMcpServers.has(serverName)) {
            issues.push({
              severity: "error",
              path: target,
              source: layer.source,
              message: `project config may not override the user-defined MCP server '${serverName}'`,
            });
            continue;
          }
        }
        const order = MONOTONIC_PROJECT_ORDER[target];
        if (order !== undefined && typeof value === "string") {
          const current = readPath(config, target);
          if (
            typeof current === "string" &&
            order.includes(value) &&
            order.indexOf(value) > order.indexOf(current)
          ) {
            issues.push({
              severity: "error",
              path: target,
              source: layer.source,
              message: `project config may not weaken '${target}' from '${current}' to '${value}'`,
            });
            continue;
          }
        }
        const strictBooleanValue = MONOTONIC_PROJECT_BOOLEAN_STRICT_VALUE[target];
        if (
          typeof strictBooleanValue === "boolean" &&
          typeof value === "boolean" &&
          value !== strictBooleanValue &&
          readPath(config, target) === strictBooleanValue
        ) {
          issues.push({
            severity: "error",
            path: target,
            source: layer.source,
            message: `project config may not weaken '${target}' from '${strictBooleanValue}' to '${value}'`,
          });
          continue;
        }
      }

      const existing = readPath(config, target);
      if (
        existing === undefined &&
        target !== "permissions.preset" &&
        !target.startsWith("mcpServers.") &&
        !target.startsWith("lspServers.") &&
        !target.startsWith("keymap.") &&
        !target.startsWith("model.profiles.")
      ) {
        issues.push({
          severity: "warning",
          path: target,
          source: layer.source,
          message: `unknown configuration key '${target}'`,
        });
        continue;
      }

      const enumValues = ENUMS[target];
      if (enumValues && typeof value === "string" && !enumValues.includes(value)) {
        issues.push({
          severity: "error",
          path: replacement !== undefined ? path : target,
          source: layer.source,
          message: `'${value}' is not one of ${enumValues.join(", ")}`,
        });
        continue;
      }

      if (
        existing !== undefined &&
        (Array.isArray(existing) !== Array.isArray(value) ||
          (!Array.isArray(existing) && typeof existing !== typeof value))
      ) {
        issues.push({
          severity: "error",
          path: target,
          source: layer.source,
          message: `expected ${typeof existing}, got ${typeof value}`,
        });
        continue;
      }

      const dynamicTypeError = validateDynamicValue(target, value);
      if (dynamicTypeError !== undefined) {
        issues.push({
          severity: "error",
          path: target,
          source: layer.source,
          message: dynamicTypeError,
        });
        continue;
      }

      writePath(config, target, value);
      provenance[target] = layer.source;

      // P1-04: a key the schema accepts but nothing consumes must say so.
      // Setting an experimental key changes nothing at runtime, and a silent
      // no-op is exactly the overclaim §24.5 forbids.
      const status = configKeyInfo(target)?.status;
      if (status === "experimental") {
        issues.push({
          severity: "warning",
          path: target,
          source: layer.source,
          message: `'${target}' is experimental and not applied yet`,
        });
      }
    }
  }

  // Thinking keys are dual-read for one compatibility window. New keys win;
  // aliases are materialized so older consumers see the same effective value.
  syncThinkingAliases(config, provenance);
  // Legacy config values are migrated at load time without widening authority.
  // Explicit new fields always win.
  if (provenance["agent.interactionMode"] === undefined && config.agent.permissionMode === "plan") {
    config.agent.interactionMode = "plan";
  }
  if (provenance["agent.reviewMode"] === undefined && config.agent.permissionMode === "auto-review") {
    config.agent.reviewMode = "auto";
  }
  issues.push(...validateSemantics(config, provenance));
  return { config, provenance, issues };
}

function syncThinkingAliases(config: CbcConfig, provenance: Record<string, ConfigSource>): void {
  const uiSource = provenance["ui.thinkingMode"] ?? provenance["ui.thinkingVisibility"];
  if (provenance["ui.thinkingMode"] !== undefined) {
    const mode = config.ui.thinkingMode;
    config.ui.thinkingVisibility = mode === "expanded" ? "full" : mode === "collapsed" ? "summary" : "hidden";
  } else {
    const legacy = config.ui.thinkingVisibility;
    config.ui.thinkingMode = legacy === "full" ? "expanded" : legacy === "summary" ? "collapsed" : "off";
  }
  if (uiSource !== undefined) {
    provenance["ui.thinkingMode"] = uiSource;
    provenance["ui.thinkingVisibility"] = uiSource;
  }

  const providerSource = provenance["model.reasoning.providerSummary"] ?? provenance["model.reasoning.summary"];
  if (provenance["model.reasoning.providerSummary"] !== undefined) {
    config.model.reasoning.summary = config.model.reasoning.providerSummary === "off" ? "none" : "auto";
  } else {
    config.model.reasoning.providerSummary = config.model.reasoning.summary === "none" ? "off" : "auto";
  }
  if (providerSource !== undefined) {
    provenance["model.reasoning.providerSummary"] = providerSource;
    provenance["model.reasoning.summary"] = providerSource;
  }
}
function isForbiddenProjectPath(path: string): boolean {
  const segments = path.split(".").map((segment) => segment.toLowerCase());
  const forbidden = new Set(FORBIDDEN_PROJECT_PATHS.map((entry) => entry.toLowerCase()));
  return (
    segments.some((segment) => forbidden.has(segment)) ||
    (segments.length === 3 && segments[0] === "mcpservers" && segments[2] === "env")
  );
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function hasUnsafePathSegment(path: string): boolean {
  const segments = path.split(".");
  return segments.some((segment) => segment.length === 0 || UNSAFE_PATH_SEGMENTS.has(segment));
}

const CONSTANT_FALSE_CONFIG_PATHS = new Set([
  "memory.privacy.storeRawTranscript",
  "daemon.transport.allowTcp",
  "plugins.allowProjectStdio",
  "plugins.allowUnsafeLocal",
  "appServer.allowLoopbackWebsocket",
]);
function validateDynamicValue(path: string, value: unknown): string | undefined {
  if (CONSTANT_FALSE_CONFIG_PATHS.has(path)) {
    return value === false ? undefined : `'${path}' is a fixed false safety boundary`;
  }
  if (path === "lsp.commands.allow") {
    return isStringArray(value) ? undefined : "expected an array of command names";
  }
  if (path === "model.context.bands") {
    return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? undefined
      : "expected an array of finite numbers";
  }
  if (path === "permissions.rules") {
    if (!Array.isArray(value)) return "expected an array of permission rules";
    const validRisk = new Set(["R0", "R1", "R2", "R3", "R4", "R5", "R6"]);
    const valid = value.every((entry) => {
      if (!isPlainRecord(entry)) return false;
      if (typeof entry.tool !== "string" || !["allow", "deny"].includes(String(entry.decision))) return false;
      if (!validRisk.has(String(entry.risk))) return false;
      for (const field of ["program", "cwd", "server"] as const) {
        if (entry[field] !== undefined && typeof entry[field] !== "string") return false;
      }
      for (const field of ["argsExact", "argsPrefix", "paths"] as const) {
        if (entry[field] !== undefined && !isStringArray(entry[field])) return false;
      }
      return Object.keys(entry).every((key) =>
        ["tool", "decision", "risk", "program", "argsExact", "argsPrefix", "cwd", "paths", "server"].includes(key),
      );
    });
    return valid ? undefined : "expected well-typed permission rule objects";
  }

  const segments = path.split(".");
  if (segments[0] === "mcpServers") {
    if (segments.length !== 3) return "MCP server settings must name one supported field";
    const field = segments[2] as string;
    if (field === "transport") {
      return value === "stdio" || value === "streamable_http" ? undefined : "expected 'stdio' or 'streamable_http'";
    }
    if (field === "auth") {
      return value === "none" || value === "oauth" || value === "bearer"
        ? undefined
        : "expected 'none', 'oauth', or 'bearer'";
    }
    if (field === "command" || field === "url") return typeof value === "string" ? undefined : "expected string";
    if (field === "args" || field === "env") return isStringArray(value) ? undefined : "expected an array of strings";
    if (field === "enabled" || field === "connectOnStartup") {
      return typeof value === "boolean" ? undefined : "expected boolean";
    }
    if (field === "timeoutMs") {
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? undefined : "expected a positive finite number";
    }
    return "unknown MCP server field '" + field + "'";
  }
  if (segments[0] === "lspServers") {
    if (segments.length !== 3) return "LSP server settings must name one supported field";
    const field = segments[2] as string;
    if (field === "command" || field === "languageId") {
      return typeof value === "string" && value.trim().length > 0
        ? undefined
        : "expected a non-empty string";
    }
    if (field === "installHint") return typeof value === "string" ? undefined : "expected string";
    if (field === "args" || field === "extensions") {
      return isStringArray(value) ? undefined : "expected an array of strings";
    }
    if (field === "enabled") return typeof value === "boolean" ? undefined : "expected boolean";
    if (field === "timeoutMs") {
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 100
        ? undefined
        : "expected a finite integer of at least 100 milliseconds";
    }
    return "unknown LSP server field '" + field + "'";
  }
  if (segments[0] === "model" && segments[1] === "profiles") {
    if (segments.length !== 4) return "model profile settings must name one supported field";
    const field = segments[3] as string;
    if (field === "model") return typeof value === "string" ? undefined : "expected string";
    if (field === "reasoningMode") {
      return value === "standard" || value === "pro" ? undefined : "expected 'standard' or 'pro'";
    }
    if (field === "reasoningEffort") {
      return ["none", "low", "medium", "high", "xhigh", "max"].includes(String(value))
        ? undefined
        : "expected a valid reasoning effort";
    }
    return "unknown model profile field '" + field + "'";
  }
  if (segments[0] === "keymap") {
    return segments.length === 2 && typeof value === "string" ? undefined : "keymap entries must be strings";
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface IntegerConstraint {
  readonly minimum: number;
  readonly maximum?: number;
}

/** Scalar integer constraints mirrored from config.schema.json. */
const INTEGER_CONSTRAINTS: Readonly<Record<string, IntegerConstraint>> = {
  "model.softContextTokens": { minimum: 8_000 },
  "model.maxOutputTokens": { minimum: 256 },
  "model.router.targetLatencyMs": { minimum: 1 },
  "model.context.defaultBand": { minimum: 1 },
  "model.context.premiumThresholdTokens": { minimum: 1 },
  "model.context.reserveOutputTokens": { minimum: 1 },
  "model.context.compactionThresholdTokens": { minimum: 1_024 },
  "model.cache.maxWritesPerTurn": { minimum: 0 },
  "model.cache.ttlMinutes": { minimum: 1 },
  "agent.toolGraph.maxParallelReads": { minimum: 1 },
  "agent.toolGraph.maxParallelTests": { minimum: 1 },
  "agent.toolRecovery.maxAttempts": { minimum: 1, maximum: 5 },
  "subagents.maxConcurrent": { minimum: 1, maximum: 8 },
  "subagents.maxDepth": { minimum: 0, maximum: 1 },
  "tools.activationLimit": { minimum: 1 },
  "tools.inlineOutputBytes": { minimum: 1_024 },
  "tools.inlineOutputLines": { minimum: 10 },
  "sessions.artifactRetentionDays": { minimum: 0 },
  "sessions.autoSnapshotEvents": { minimum: 1 },
  "updates.intervalHours": { minimum: 1 },
  "provider.openai.native.maxHostedAgents": { minimum: 0 },
  "provider.openai.native.maxProgramToolCalls": { minimum: 0 },
  "provider.openai.native.maxProgramParallelCalls": { minimum: 1 },
  "edit.maxOperationsPerPlan": { minimum: 1, maximum: 100 },
  "edit.maxFileBytes": { minimum: 1 },
  "edit.maxAnchorTextBytes": { minimum: 1 },
  "edit.maxAnchorCandidates": { minimum: 1 },
  "edit.limits.maxTotalChangedBytes": { minimum: 1 },
  "edit.limits.maxTotalFiles": { minimum: 1, maximum: 100 },
  "edit.limits.maxDiffPreviewLines": { minimum: 1 },
  "lsp.maxOpenDocumentsPerServer": { minimum: 1 },
  "lsp.maxPendingRequestsPerServer": { minimum: 1 },
  "lsp.maxDiagnosticsPerFile": { minimum: 1 },
  "lsp.maxWorkspaceSymbols": { minimum: 1 },
  "lsp.restartLimit": { minimum: 0 },
  "lsp.restartWindowSeconds": { minimum: 1 },
  "lsp.mutations.maxFiles": { minimum: 1, maximum: 100 },
  "lsp.mutations.maxChangedBytes": { minimum: 1 },
  "memory.maxRecordsPerWorkspace": { minimum: 1 },
  "memory.maxValueBytes": { minimum: 1 },
  "memory.recallLimit": { minimum: 1 },
  "memory.recallTokenBudget": { minimum: 1 },
  "memory.retentionDays": { minimum: 0 },
  "daemon.idleShutdownMinutes": { minimum: 0 },
  "daemon.workspaceIdleMinutes": { minimum: 0 },
  "daemon.heartbeatSeconds": { minimum: 1 },
  "daemon.ownerLeaseSeconds": { minimum: 1 },
  "daemon.gracefulShutdownSeconds": { minimum: 1 },
  "daemon.transport.maxConnections": { minimum: 1 },
  "daemon.transport.maxFrameBytes": { minimum: 1_024 },
  "daemon.clients.controlLeaseSeconds": { minimum: 1 },
  "daemon.clients.detachGraceSeconds": { minimum: 0 },
  "daemon.clients.maxEventQueueItems": { minimum: 1 },
  "daemon.clients.maxEventQueueBytes": { minimum: 1_024 },
  "agentGraph.maxDepth": { minimum: 0 },
  "agentGraph.maxNodes": { minimum: 1 },
  "agentGraph.maxConcurrentNodes": { minimum: 1 },
  "agentGraph.maxConcurrentReaders": { minimum: 1 },
  "agentGraph.maxConcurrentWriters": { minimum: 1 },
  "agentGraph.maxAttemptsPerNode": { minimum: 1 },
  "agentGraph.checkpointEvents": { minimum: 1 },
  "agentGraph.messageBytes": { minimum: 1_024 },
  "agentGraph.budget.maxToolCalls": { minimum: 0 },
  "agentGraph.budget.maxWallClockMinutes": { minimum: 1 },
  "worktrees.maxActive": { minimum: 1 },
  "worktrees.maxActiveWriters": { minimum: 1 },
  "worktrees.retentionHours": { minimum: 0 },
  "plugins.maxActivePerWorkspace": { minimum: 1 },
  "plugins.limits.beforeHookMs": { minimum: 1 },
  "plugins.limits.afterHookMs": { minimum: 1 },
  "plugins.limits.aggregateBeforeHookMs": { minimum: 1 },
  "plugins.limits.maxOutputBytes": { minimum: 1_024 },
  "plugins.limits.maxStateBytes": { minimum: 1_024 },
  "plugins.limits.maxReentrancyDepth": { minimum: 0 },
  "plugins.limits.maxNestedToolCalls": { minimum: 0 },
  "plugins.failure.circuitFailures": { minimum: 1 },
  "appServer.maxConnections": { minimum: 1 },
  "appServer.maxRequestBytes": { minimum: 1_024 },
  "appServer.maxResponseBytes": { minimum: 1_024 },
  "appServer.maxSubscriptionsPerClient": { minimum: 1 },
  "appServer.maxSessionsPerSubscription": { minimum: 1 },
  "appServer.events.maxBatchEvents": { minimum: 1 },
  "appServer.events.maxBatchBytes": { minimum: 1_024 },
  "appServer.events.ackTimeoutSeconds": { minimum: 1 },
  "sdk.reconnectMaxAttempts": { minimum: 0 },
};


/** Cross-field checks (§21.7 "conflicting permission warning"). */
function validateSemantics(
  config: CbcConfig,
  provenance: Record<string, ConfigSource>,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  // Attribute each finding to the layer that actually set the offending value,
  // so configuration diagnostics point at the file to fix rather than at defaults.
  const sourceOf = (path: string): ConfigSource => provenance[path] ?? "default";

  for (const [name, configured] of Object.entries(config.lspServers)) {
    const server = configured as Partial<LspServerConfig>;
    for (const field of ["command", "languageId"] as const) {
      if (typeof server[field] !== "string" || server[field]?.trim().length === 0) {
        const path = `lspServers.${name}.${field}`;
        issues.push({
          severity: "error",
          path,
          source: sourceOf(path),
          message: `LSP server '${name}' requires a non-empty ${field}`,
        });
      }
    }
    const extensionsPath = `lspServers.${name}.extensions`;
    if (
      !Array.isArray(server.extensions) ||
      server.extensions.length === 0 ||
      server.extensions.some((extension) => extension.length < 2 || !extension.startsWith("."))
    ) {
      issues.push({
        severity: "error",
        path: extensionsPath,
        source: sourceOf(extensionsPath),
        message: `LSP server '${name}' requires one or more dot-prefixed extensions`,
      });
    }
  }

  for (const [path, constraint] of Object.entries(INTEGER_CONSTRAINTS)) {
    const value = readPath(config, path);
    if (typeof value !== "number") continue;
    const outsideRange =
      value < constraint.minimum ||
      (constraint.maximum !== undefined && value > constraint.maximum);
    if (!Number.isFinite(value) || !Number.isInteger(value) || outsideRange) {
      const expectedRange = constraint.maximum === undefined
        ? `at least ${constraint.minimum}`
        : `between ${constraint.minimum} and ${constraint.maximum}`;
      issues.push({
        severity: "error",
        path,
        source: sourceOf(path),
        message: `'${path}' must be a finite integer ${expectedRange}`,
      });
    }
  }


  if (
    config.permissions.preset !== undefined &&
    provenance["permissions.preset"] !== undefined &&
    provenance["agent.permissionMode"] !== undefined
  ) {
    const compatibleMode: Partial<Record<PermissionPreset, PermissionMode>> = {
      read: "plan",
      auto: "auto",
    };
    if (compatibleMode[config.permissions.preset] !== config.agent.permissionMode) {
      issues.push({
        severity: "error",
        path: "permissions.preset",
        source: sourceOf("permissions.preset"),
        message: "permissions.preset conflicts with the explicitly configured agent.permissionMode",
      });
    }
  }

  if (config.agent.permissionMode === "plan" && config.permissions.projectWrite === "auto") {
    issues.push({
      severity: "warning",
      path: "permissions.projectWrite",
      source: sourceOf("permissions.projectWrite"),
      message: "plan mode denies workspace writes, so 'auto' project_write has no effect",
    });
  }
  if (config.model.softContextTokens < 4_000) {
    issues.push({
      severity: "error",
      path: "model.softContextTokens",
      source: sourceOf("model.softContextTokens"),
      message: "soft context budget must be at least 4000 tokens",
    });
  }
  if (config.model.cache.ttlMinutes !== 30) {
    issues.push({
      severity: "warning",
      path: "model.cache.ttlMinutes",
      source: sourceOf("model.cache.ttlMinutes"),
      message: "the current provider supports a 30 minute prompt-cache TTL; this value is normalized to 30 minutes at request time",
    });
  }
  if (config.model.maxOutputTokens < 256) {
    issues.push({
      severity: "error",
      path: "model.maxOutputTokens",
      source: sourceOf("model.maxOutputTokens"),
      message: "max output tokens must be at least 256",
    });
  }
  const compactionThresholdTokens = config.model.context.compactionThresholdTokens;
  if (
    !Number.isFinite(compactionThresholdTokens) ||
    !Number.isInteger(compactionThresholdTokens) ||
    compactionThresholdTokens < 1_024
  ) {
    issues.push({
      severity: "error",
      path: "model.context.compactionThresholdTokens",
      source: sourceOf("model.context.compactionThresholdTokens"),
      message: "provider compaction threshold must be a finite integer of at least 1024 tokens",
    });
  }
  if (!Number.isFinite(config.perf.sampleRate) || config.perf.sampleRate < 0 || config.perf.sampleRate > 1) {
    issues.push({
      severity: "error",
      path: "perf.sampleRate",
      source: sourceOf("perf.sampleRate"),
      message: "performance telemetry sample rate must be between 0 and 1",
    });
  }
  for (const [path, parallelism] of [
    ["agent.toolGraph.maxParallelReads", config.agent.toolGraph.maxParallelReads],
    ["agent.toolGraph.maxParallelTests", config.agent.toolGraph.maxParallelTests],
  ] as const) {
    if (
      !Number.isFinite(parallelism) ||
      !Number.isInteger(parallelism) ||
      parallelism < 1
    ) {
      issues.push({
        severity: "error",
        path,
        source: sourceOf(path),
        message: "tool graph parallelism must be a finite integer of at least 1",
      });
    }
  }
  if (config.subagents.maxDepth > 1) {
    issues.push({
      severity: "error",
      path: "subagents.maxDepth",
      source: sourceOf("subagents.maxDepth"),
      message: "delegation depth is capped at 1",
    });
  }
  if (config.subagents.maxConcurrent < 1) {
    issues.push({
      severity: "error",
      path: "subagents.maxConcurrent",
      source: sourceOf("subagents.maxConcurrent"),
      message: "at least one concurrent subagent must be allowed",
    });
  }
  if (config.tools.activationLimit < 1) {
    issues.push({
      severity: "error",
      path: "tools.activationLimit",
      source: sourceOf("tools.activationLimit"),
      message: "tool activation limit must be at least 1",
    });
  }
  if (!(config.model.profile in config.model.profiles)) {
    issues.push({
      severity: "error",
      path: "model.profile",
      source: sourceOf("model.profile"),
      message: `profile '${config.model.profile}' is not defined in model.profiles`,
    });
  }
  return issues;
}

export function readPath(target: unknown, path: string): unknown {
  if (hasUnsafePathSegment(path)) return undefined;
  let current: unknown = target;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Accepts any object rather than `Record<string, unknown>` so the typed
 * `CbcConfig` tree can be written through without an index signature, mirroring
 * `readPath`'s `unknown` input.
 */
export function writePath(target: object, path: string, value: unknown): void {
  if (hasUnsafePathSegment(path)) throw new TypeError("unsafe configuration path '" + path + "'");
  const segments = path.split(".");
  let current = target as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[segment] = Object.create(null) as Record<string, unknown>;
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = value;
}

/** §21.6 environment variables mapped onto config paths. */
export function environmentLayer(env: Record<string, string | undefined>): ConfigLayer {
  const layer: ConfigLayer = {};
  const map: Record<string, string> = {
    CBC_MODEL: "model.default",
    CBC_REASONING_EFFORT: "model.reasoningEffort",
    CBC_REASONING_MODE: "model.reasoningMode",
    CBC_PERMISSION_MODE: "agent.permissionMode",
  };
  for (const [variable, path] of Object.entries(map)) {
    const value = env[variable];
    if (value !== undefined && value.length > 0) layer[path] = value;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") layer["ui.color"] = "never";
  if (env.CBC_NO_UPDATE_CHECK !== undefined && env.CBC_NO_UPDATE_CHECK !== "") {
    layer["updates.check"] = false;
  }
  // §21.6: OPENAI_API_KEY is a credential source, never copied into config.
  return layer;
}

/** §21.1 resolved paths, honouring the documented overrides. */
export interface ConfigPaths {
  config: string;
  data: string;
  cache: string;
  logs: string;
}

export function resolvePaths(
  env: Record<string, string | undefined>,
  homeDir: string,
  platform: string,
): ConfigPaths {
  const home = env.CAPYBARA_HOME;
  if (home !== undefined && home.length > 0) {
    return {
      config: join(home, "config.toml"),
      data: join(home, "data"),
      cache: join(home, "cache"),
      logs: join(home, "logs"),
    };
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local");
    const base = join(local, "capybara-code");
    return {
      config: env.CAPYBARA_CONFIG ?? join(base, "config.toml"),
      data: env.CAPYBARA_DATA_DIR ?? join(base, "data"),
      cache: env.CAPYBARA_CACHE_DIR ?? join(base, "cache"),
      logs: env.CAPYBARA_LOG_DIR ?? join(base, "logs"),
    };
  }

  return {
    config:
      env.CAPYBARA_CONFIG ??
      join(env.XDG_CONFIG_HOME ?? join(homeDir, ".config"), "capybara", "config.toml"),
    data:
      env.CAPYBARA_DATA_DIR ??
      join(env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"), "capybara"),
    cache: env.CAPYBARA_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homeDir, ".cache"), "capybara"),
    logs: env.CAPYBARA_LOG_DIR ?? join(homeDir, ".local", "state", "capybara", "logs"),
  };
}

function join(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * Normalize a user-facing dotted config path to the camelCase schema path.
 * TOML files already pass through this conversion; CLI paths need the same
 * treatment so documented names such as `model.reasoning_effort` address the
 * setting that the runtime actually reads.
 */
export function normalizeConfigPath(path: string): string {
  return path
    .split(".")
    .map((segment, index) =>
      index === 0
        ? segment
        : segment.replace(
            /_([a-z])/g,
            (_match, character: string) => character.toUpperCase(),
          ),
    )
    .join(".");
}
