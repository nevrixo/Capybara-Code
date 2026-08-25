/**
 * Config key status registry — P1-04.
 *
 * §24.5 applies to configuration as well as to capabilities: a key the schema
 * accepts but nothing consumes is an overclaim, because setting it looks like
 * changing behaviour. Every dotted key therefore carries an explicit status:
 *
 *   wired        a named consumer applies the value at runtime
 *   experimental accepted and preserved, but no consumer applies it yet —
 *                setting it changes nothing, and the CLI says so
 *   deprecated   accepted with a warning; use the named replacement
 *
 * The table is curated on purpose: the status *is* the knowledge being
 * recorded, and deriving it automatically would only restate whichever code
 * happened to exist. `config validate --explain` renders it.
 */

export type ConfigKeyStatus = "wired" | "experimental" | "deprecated";

export interface ConfigKeyInfo {
  readonly status: ConfigKeyStatus;
  /** Where a wired value is actually applied. */
  readonly consumer?: string;
  /** What an experimental or deprecated key is waiting on / replaced by. */
  readonly note?: string;
}

/**
 * Longest-prefix-wins: a leaf entry overrides its section default. Prefixes
 * end in `.` so `ui.` never matches a hypothetical `uix` key.
 */
const KEY_STATUS: ReadonlyArray<readonly [string, ConfigKeyInfo]> = [
  // ---- ui: theme/mouse/animations/showCost/statusDensity are wired (P1-02);
  // colour mode still follows the `NO_COLOR` environment variable ----
  ["ui.theme", { status: "wired", consumer: "tui.ts theme palette selection" }],
  ["ui.color", { status: "experimental", note: "colour follows the `NO_COLOR` environment variable; this key is not read" }],
  ["ui.mouse", { status: "wired", consumer: "tui.ts / opentui-view.ts mouse tracking gate" }],
  ["ui.animations", { status: "wired", consumer: "tui.ts reduced-motion capability override" }],
  ["ui.showCost", { status: "wired", consumer: "tui-components planLayout / status bar & sidebar" }],
  ["ui.statusDensity", { status: "wired", consumer: "tui-components planLayout status surface" }],
  ["ui.thinkingMode", { status: "wired", consumer: "tui.ts presentation policy / setting popup" }],
  ["ui.thinkingVisibility", { status: "deprecated", note: "use ui.thinkingMode" }],
  ["ui.toolDetail", { status: "wired", consumer: "tui.ts presentation policy / setting popup" }],
  ["ui.subagentDetail", { status: "wired", consumer: "tui.ts presentation policy / setting popup" }],
  ["ui.sidebar", { status: "wired", consumer: "tui.ts sidebar visibility / setting popup" }],

  // ---- model: the core knobs are wired; tuning tables are not consumed yet ----
  ["model.profile", { status: "wired", consumer: "agent.ts (profile resolution / auto-route)" }],
  ["model.profiles.", { status: "wired", consumer: "agent.ts / model use profile:<name>" }],
  ["model.default", { status: "wired", consumer: "agent.ts (model id)" }],
  ["model.reasoningMode", { status: "wired", consumer: "agent.ts → provider request" }],
  ["model.reasoningEffort", { status: "wired", consumer: "agent.ts → provider request; /effort" }],
  ["model.reasoning.providerSummary", { status: "wired", consumer: "agent.ts/provider request" }],
  ["model.reasoning.summary", { status: "deprecated", note: "use model.reasoning.providerSummary" }],
  ["model.softContextTokens", { status: "wired", consumer: "agent.ts (context budget)" }],
  ["model.maxOutputTokens", { status: "wired", consumer: "agent.ts → provider request" }],
  ["model.router.cheapTier", { status: "wired", consumer: "agent.ts (router tiers)" }],
  ["model.router.defaultTier", { status: "wired", consumer: "agent.ts (router tiers)" }],
  ["model.router.escalationTier", { status: "wired", consumer: "agent.ts (router tiers)" }],
  ["model.router.maxCostUsdPerTurn", { status: "wired", consumer: "agent.ts (cost guard)" }],
  ["model.router.strategy", { status: "wired", consumer: "provider-openai InferenceUtilityController" }],
  ["model.router.targetLatencyMs", { status: "wired", consumer: "provider-openai latency routing objective" }],
  ["model.router.recordDecisions", { status: "wired", consumer: "AgentSession kernel-event filtering" }],
  ["model.router.phasePolicy", { status: "wired", consumer: "agent-kernel phase-aware sampling policy" }],
  ["model.context.defaultBand", { status: "experimental", note: "routing currently derives the band from measured prompt tokens" }],
  ["model.context.reserveOutputTokens", { status: "wired", consumer: "agent.ts (compaction reserve)" }],
  ["model.context.premiumBandPolicy", { status: "wired", consumer: "agent.ts (utility gating)" }],
  ["model.context.orientationMode", { status: "wired", consumer: "bootstrap.ts / AgentSession progressive repository warmup" }],
  ["model.context.providerCompaction", { status: "wired", consumer: "agent-kernel provider context management" }],
  ["model.context.compactionThresholdTokens", { status: "wired", consumer: "agent-kernel provider compaction threshold" }],
  ["model.context.bands", { status: "experimental", note: "band escalation is not implemented yet" }],
  ["model.context.premiumThresholdTokens", { status: "experimental", note: "premium band selection is not implemented yet" }],
  ["model.context.compaction", { status: "experimental", note: "compaction strategy is fixed to the evidence ledger today" }],
  ["model.cache.mode", { status: "wired", consumer: "agent.ts (cache planner)" }],
  ["model.cache.maxWritesPerTurn", { status: "wired", consumer: "agent.ts (cache planner)" }],
  ["model.cache.minimumReuseProbability", { status: "wired", consumer: "agent.ts (cache planner)" }],
  ["model.cache.ttlMinutes", { status: "experimental", note: "cache entries do not expire by TTL yet" }],
  ["model.cache.recordReadWriteTokens", { status: "experimental", note: "cache token accounting is not journaled yet" }],
  ["model.reasoning.", { status: "experimental", note: "reasoning continuity policy is fixed by the provider today" }],

  // ---- agent ----
  ["agent.permissionMode", { status: "wired", consumer: "agent.ts / approval flow" }],
  ["agent.tokenSaving", { status: "wired", consumer: "AgentSession saving controller → context, prompt, compaction, reporting" }],
  ["agent.toolRecovery.mode", { status: "wired", consumer: "agent.ts → logical tool recovery runner" }],
  ["agent.toolRecovery.maxAttempts", { status: "wired", consumer: "agent.ts → logical tool recovery runner" }],
  ["agent.todo.autoProgress", { status: "wired", consumer: "agent.ts → TODO preflight activation" }],
  ["agent.todo.safeRebase", { status: "wired", consumer: "agent.ts → TODO revision recovery" }],

  ["agent.promptCompiler", { status: "wired", consumer: "agent-kernel compiled prompt hot path" }],
  ["agent.compoundTools", { status: "wired", consumer: "agent.ts native compound tool activation" }],
  ["agent.verification.reviewPolicy", { status: "wired", consumer: "agent-kernel risk-based completion review" }],
  ["agent.verification.independentReviewRiskThreshold", { status: "wired", consumer: "agent-kernel change-risk review threshold" }],
  ["agent.verification.completionRequiresFreshEvidence", { status: "experimental", note: "completion currently enforces fresh evidence unconditionally" }],
  ["agent.verification.falseCompletePolicy", { status: "experimental", note: "truthfulness currently uses the blocking policy unconditionally" }],

  ["agent.toolGraph.", { status: "wired", consumer: "agent-kernel ToolExecutionGraph" }],
  ["agent.visibleCommentary", { status: "wired", consumer: "AgentSession event visibility + session reducer" }],
  ["agent.verification.", { status: "experimental", note: "the completion gate uses fixed policy today" }],

  // ---- subagents ----
  ["subagents.maxConcurrent", { status: "wired", consumer: "subagent-bridge → scheduler" }],
  ["subagents.maxDepth", { status: "wired", consumer: "agent.ts / scheduler depth check" }],
  ["subagents.maxPerTurn", { status: "deprecated", note: "removed; child registration is unbounded and overflow queues" }],
  ["subagents.writerPolicy", { status: "experimental", note: "exactly one writer is enforced by the scheduler constant" }],

  // ---- tools ----
  ["tools.", { status: "experimental", note: "activation and inline-output limits are fixed in the tool layer today" }],

  // ---- permissions / sandbox ----
  ["permissions.preset", { status: "wired", consumer: "agent.ts preset policy (presets.ts)" }],
  ["permissions.", { status: "wired", consumer: "agent.ts policy evaluation" }],
  ["sandbox.level", { status: "wired", consumer: "runtime initialize → Landlock allowlist on spawns" }],
  ["sandbox.networkForShell", { status: "wired", consumer: "runtime initialize → forced network deny on shells" }],

  // ---- sessions ----
  ["sessions.autoSnapshotEvents", { status: "wired", consumer: "agent.ts (snapshot cadence)" }],
  ["perf.longSessionFastPath", { status: "wired", consumer: "AgentSession bounded resume path" }],
  ["perf.contextPackProjection", { status: "wired", consumer: "AgentSession ContextPack → provider projection" }],
  ["perf.subagentProfileResolutionV2", { status: "wired", consumer: "SubagentBridge child profile resolver" }],
  ["perf.subagentContextReservations", { status: "wired", consumer: "SubagentScheduler p75 context telemetry" }],
  ["perf.phaseRouting", { status: "wired", consumer: "AgentKernel phase-aware route epochs" }],
  ["perf.budgetEnforcement", { status: "wired", consumer: "AgentKernel turn budget controller" }],
  ["perf.retrievalControllerV2", { status: "wired", consumer: "ContextEngine retrieval rollout" }],
  ["perf.verificationPlannerV2", { status: "wired", consumer: "AgentSession impact verification planner" }],
  ["perf.commentaryPolicyV2", { status: "wired", consumer: "AgentKernel evidence-linked commentary policy" }],
  ["sessions.retain", { status: "experimental", note: "session retention has no purge path yet" }],
  ["sessions.artifactRetentionDays", { status: "experimental", note: "artifact GC is not scheduled yet" }],

  // ---- privacy ----
  ["privacy.", { status: "experimental", note: "telemetry, crash reports, and provider store are not implemented; the defaults are the strict end" }],

  // ---- updates ----
  ["updates.channel", { status: "wired", consumer: "update command / manifest channel" }],
  ["updates.check", { status: "wired", consumer: "update command gate" }],
  ["updates.intervalHours", { status: "wired", consumer: "update command background-check cadence" }],

  // ---- provider ----
  ["provider.openai.transport", { status: "wired", consumer: "provider-openai turn session transport" }],
  ["provider.openai.serviceTier", { status: "wired", consumer: "provider-openai Responses request service tier" }],
  ["provider.openai.toolSearch", { status: "wired", consumer: "provider-openai deferred tool search" }],
  ["provider.openai.native.", { status: "experimental", note: "native lanes are read-only; the toggles feed the policy digest only" }],
  ["perf.", { status: "wired", consumer: "AgentSession performance event sampling" }],

  // ---- maps ----
  // ---- durable runtime feature gates (implemented incrementally) ----
  ["experimental.editEngineV2", { status: "wired", consumer: "AgentSession / RuntimeToolExecutor structured edit gate" }],
  ["experimental.fullLsp", { status: "wired", consumer: "bootstrap.ts / LspHost supervised LSP gate" }],
  ["edit.maxOperationsPerPlan", { status: "wired", consumer: "LspHost WorkspaceEdit adapter bound" }],
  ["edit.maxFileBytes", { status: "wired", consumer: "bootstrap.ts runtime exact edit snapshot bound" }],
  ["lsp.enabled", { status: "wired", consumer: "bootstrap.ts / LspHost startup gate" }],
  ["lsp.mutations.rename", { status: "wired", consumer: "bootstrap.ts LSP rename preview gate" }],
  ["lsp.mutations.formatting", { status: "wired", consumer: "bootstrap.ts LSP formatting preview gate" }],
  ["lsp.mutations.codeActions", { status: "wired", consumer: "bootstrap.ts LSP code action preview gate" }],
  ["lsp.mutations.maxFiles", { status: "wired", consumer: "LspHost exact snapshot path bound" }],
  ["lsp.mutations.maxChangedBytes", { status: "wired", consumer: "LspHost WorkspaceEdit emitted-text bound" }],
  ["lsp.maxPendingRequestsPerServer", { status: "wired", consumer: "LspHost JSON-RPC pending request bound" }],
  ["experimental.", { status: "experimental", note: "new runtime surfaces remain disabled until their feature gate is explicitly enabled" }],
  ["edit.", { status: "experimental", note: "Anchor/Range Edit Engine rollout is feature-gated" }],
  ["lsp.", { status: "experimental", note: "Full LSP service rollout is feature-gated" }],
  ["memory.", { status: "experimental", note: "durable memory is feature-gated" }],
  ["daemon.", { status: "experimental", note: "session daemon is feature-gated" }],
  ["agentGraph.", { status: "experimental", note: "persistent agent graph is feature-gated" }],
  ["worktrees.", { status: "experimental", note: "multi-worktree orchestration is feature-gated" }],
  ["plugins.", { status: "experimental", note: "isolated plugin runtime is feature-gated" }],
  ["appServer.", { status: "experimental", note: "App Server is feature-gated" }],
  ["sdk.", { status: "experimental", note: "SDK reconnect policy is reserved for the App Server rollout" }],
  ["mcpServers.", { status: "wired", consumer: "mcp commands / extension host" }],
  ["lspServers.", { status: "wired", consumer: "lsp commands / trusted workspace LSP host" }],
  ["keymap.", { status: "experimental", note: "key bindings are fixed in tui-components today" }],
];

/** The status record for a dotted config path, longest prefix winning. */
export function configKeyInfo(path: string): ConfigKeyInfo | undefined {
  let best: { prefix: string; info: ConfigKeyInfo } | undefined;
  for (const [prefix, info] of KEY_STATUS) {
    const matches = prefix.endsWith(".") ? path.startsWith(prefix) : path === prefix;
    if (matches && (best === undefined || prefix.length > best.prefix.length)) {
      best = { prefix, info };
    }
  }
  return best?.info;
}

/** Every registered entry, for tooling that renders the whole surface. */
export function configKeyStatusEntries(): ReadonlyArray<readonly [string, ConfigKeyInfo]> {
  return KEY_STATUS;
}
