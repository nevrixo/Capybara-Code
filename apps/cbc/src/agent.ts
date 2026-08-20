/**
 * Session assembly ??PRD 짠11, 짠13.3, 짠16.4, 짠18.1, 짠18.6, 짠20.8.
 *
 * One class, `AgentSession`, holds everything a running session needs: the kernel,
 * the tool registry, the context engine, the Skill catalog, the event sequencer, and
 * the reduced view model. 짠20.8 makes the reducer the only path from events to view
 * model, so every emitter in the process funnels through `#emit` here ??the TUI, the
 * JSONL stream, and the journal all observe the same ordered sequence.
 */

import { createHash } from "node:crypto";

import {
  AgentKernel,
  ROOT_LIMITS,
  assessChangeRisk,
  resolveTokenSavingPlan,
  riskLevelForPermissionThreshold,
  TokenSavingController,
  type ApprovalBroker,
  type CompiledModelRequest,
  type KernelEmitter,
  type PromptInputs,
  type ResolvedTokenSavingPlan,
  type ReviewOutcome,
  type TokenSavingLevel,
  type TokenSavingPhase,
  type TurnResult,
} from "@cbc/agent-kernel";
import type { CbcConfig, ReasoningEffort } from "@cbc/config-schema";
import { requestModeChange, TaskEpochManager, type InteractionMode, type ModeChangeSource } from "@cbc/session-domain";
import {
  ContextEngine,
  planVerification,
  projectContextPack,
  toLegacyVerificationCommand,
  createTaskContextCapsule,
  isSensitivePath,
  scopedExactExcerptBodyDigest,
  scopedExactExcerptIdentityDigest,
  validateTaskContextCapsule,
  type ContextInspection,
  type ContextPack,
  type EvidenceSelection,
  type InstructionReader,
  type RepositoryDelta,
  type ScopedExactExcerpt,
  type RepositoryScan,
  type TaskContextCapsule,
  type ToolObservationIngestResult,
} from "@cbc/context-engine";
import { canonicalDigest, classifyCommand, mcpActionArgumentsHash, normalizeApprovedPlanScope, resolvePermissionPolicy, type PermissionPreset, type ApprovedPlanScope, type PlanCommandScope, type PermissionContext, type ProposedAction, type StoredRule, type TrustState } from "@cbc/permissions";
import type { CbcEvent, CbcEventKind, EventVisibility } from "@cbc/protocol";
import {
  CachePlanner,
  InferenceUtilityController,
  selectContextBand,
  type InferencePolicyDecision,
  type InferencePolicyPort,
  type ModelInputItem,
  type ModelProvider,
} from "@cbc/provider-openai";
import {
  compact,
  PROMPT_CAPSULE_BYTE_LIMIT,
  PROMPT_CAPSULE_ITEM_LIMIT,
  RESUME_TAIL_BYTE_LIMIT,
  RESUME_TAIL_ITEM_LIMIT,
  estimateTokens,
  makeContextUsageSnapshot,
  renderCompactState,
  shouldCompact,
  SessionRecorder,
  deserializeModel,
  serializeModel,
  TodoController,
  type PlanItem,
  type PlanDocument,
  type PlanApproval,
  type PlanContextStrategy,
  type CompactionResult,
  type JournalTransport,
  type SessionHydrationPosition,
  type SessionViewModel,
} from "@cbc/session-domain";
import {
  SkillRegistry,
  builtinSkillFiles,
  type SkillDefinition,
  type SkillFile,
} from "@cbc/skills";
import type { ChildRunContext, SubagentScheduler } from "@cbc/subagents";
import { errorResult, NATIVE_TOOLS, okResult, ToolRegistry, globMatch, type ToolDefinition } from "@cbc/tool-registry";

import type { GrantedRules } from "./approvals.ts";
import { ExtensionManager } from "./extensions.ts";
import type { Host } from "./host.ts";
import { SubagentBridge } from "./subagent-bridge.ts";
import { HostActionNormalizer, type McpHintResolver } from "./normalizer.ts";
import type { Runtime } from "./runtime.ts";
import {
  ReadCache,
  RuntimeToolExecutor,
  type ToolBridges,
  type ToolObservationAck,
  type ToolObservationEnvelope,
} from "./tools.ts";
import { extractPathMentions, extractSymbolMentions } from "./path-mentions.ts";
import { scanRepository, scanRepositoryDelta } from "./repository-map.ts";

const PERFORMANCE_EVENT_KINDS = new Set<CbcEventKind>([
  "run.trace_started",
  "repository.orientation_started",
  "repository.orientation_completed",
  "repository.full_scan_started",
  "repository.full_scan_completed",
  "context.prepare_started",
  "context.prepare_completed",
  "prompt.compile_started",
  "prompt.compile_completed",
  "provider.connection_started",
  "provider.connection_ready",
  "provider.request_sent",
  "provider.response_created",
  "provider.first_delta",
  "provider.response_completed",
  "provider.fallback",
  "run.trace_completed",
]);

export interface AgentSessionOptions {
  readonly host: Host;
  readonly runtime: Runtime;
  readonly config: CbcConfig;
  readonly workspacePath: string;
  readonly trust: TrustState;
  readonly sessionId: string;
  readonly provider: ModelProvider;
  readonly approvals: ApprovalBroker;
  readonly granted: GrantedRules;
  readonly nonInteractive: boolean;
  /** True when the selected effort came from an explicit user/profile choice. */
  readonly reasoningEffortLocked?: boolean;
  /** Optional host-computed workspace identity; changes invalidate the epoch. */
  readonly workspaceIdentityDigest?: string;
  /** P0-15: a live `mcp.*` bridge (usually from `bootstrapMcpHost`). */
  readonly mcpBridge?: NonNullable<ToolBridges["mcp"]>;
  /** Resolved catalog risk shared by the root and every child normalizer. */
  readonly mcpHint?: McpHintResolver;
  readonly inferencePolicy?: InferencePolicyPort;
  /** Whether the utility router may replace the configured model per turn. */
  readonly autoRoute?: boolean;
  readonly readOnly?: boolean;
  readonly headlessPolicy?: "deny-on-ask" | "allow-listed" | "fail-on-ask";
  /** Config-supplied rules, merged with anything granted this session (짠13.3). */
  readonly configRules?: readonly StoredRule[];
  /** Drain external startup before installing the runtime Plan boundary. */
  readonly beforeInteractionMode?: (target: InteractionMode) => Promise<void>;
  readonly globalInstructionReader?: import("@cbc/context-engine").InstructionReader;
  readonly bridges?: ToolBridges;
  /** Every event, after reduction. The TUI and the JSONL writer both use this. */
  readonly onEvent?: (event: CbcEvent, model: SessionViewModel) => void;
  readonly onJournalError?: (event: CbcEvent, error: unknown) => void;
  readonly now?: () => number;
  readonly startAfterSequence?: number;
}

/**
 * Auto routing is the default only while the configured model still matches the
 * auto profile's fallback. A changed model.default is a concrete user choice,
 * even though the config keeps profile=auto so named profile resolution is not
 * applied over it.
 */
export function shouldAutoRoute(
  model: CbcConfig["model"],
  directModelOverride = false,
): boolean {
  return model.profile === "auto" &&
    !directModelOverride &&
    model.default === model.profiles.auto?.model;
}

/**
 * The 짠20.9 journal, backed by the runtime's append-only store.
 *
 * 짠19.5 gives the Rust side ownership of the durable journal, so this is a thin
 * forwarder rather than a second implementation.
 */
export class RuntimeJournalTransport implements JournalTransport {
  readonly #runtime: Runtime;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  async open(params: Record<string, unknown>): Promise<unknown> {
    return await this.#runtime.openSession(params);
  }

  async append(params: Record<string, unknown>): Promise<unknown> {
    return await this.#runtime.appendEvents(params);
  }

  async snapshot(params: Record<string, unknown>): Promise<unknown> {
    return await this.#runtime.snapshotSession(params);
  }

  async load(params: Record<string, unknown>): Promise<unknown> {
    return await this.#runtime.loadSession(params);
  }
}

/** Reads workspace files through the runtime, per 짠19.6's brokered-read rule. */
export class RuntimeInstructionReader implements InstructionReader {
  readonly #runtime: Runtime;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  async read(path: string): Promise<string | undefined> {
    try {
      const data = (await this.#runtime.read(path, { maxLines: 4_000 })) as {
        binary?: boolean;
        excerpt?: { text?: string };
      };
      if (data.binary === true) return undefined;
      return data.excerpt?.text;
    } catch {
      // A missing or unreadable instruction file is not an error; 짠18.2 simply has
      // fewer layers to work with.
      return undefined;
    }
  }
}

export class HostInstructionReader implements InstructionReader {
  readonly #host: Host;

  constructor(host: Host) {
    this.#host = host;
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await this.#host.fs.read(path);
    } catch {
      return undefined;
    }
  }
}

const AGENT_SESSION_SNAPSHOT_VERSION = 3;
/** Bounded provenance index; evicted calls fail closed during prompt rewriting. */
export const MAX_READ_FRESHNESS_RECORDS = 4_096;

export interface AgentSessionSnapshotSeed {
  readonly model: SessionViewModel;
  readonly promptHistory: readonly ModelInputItem[];
  readonly promptHistoryDigest?: string;
  readonly promptSerializedBytes?: number;
  readonly compactState?: string;
  readonly turnCounter: number;
  readonly residentTimelineOmitted?: number;
}

export interface AgentSessionHydrationOptions {
  readonly seed?: AgentSessionSnapshotSeed;
  readonly snapshotPosition?: SessionHydrationPosition;
  readonly finalPosition?: SessionHydrationPosition;
}

function isSnapshotHistoryItem(value: unknown): value is ModelInputItem {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "message":
      return (
        ["developer", "user", "assistant"].includes(String(value.role)) &&
        Array.isArray(value.content) &&
        value.content.every((part) =>
          isRecord(part) &&
          (part.type === "input_text" || part.type === "output_text") &&
          typeof part.text === "string"
        )
      );
    case "function_call":
      return typeof value.callId === "string" &&
        typeof value.name === "string" &&
        typeof value.argumentsText === "string";
    case "function_call_output":
      return typeof value.callId === "string" && typeof value.output === "string";
    case "reasoning":
      return typeof value.opaque === "string" &&
        (value.summaryText === undefined || typeof value.summaryText === "string");
    default:
      return false;
  }
}

/** Parse only the versioned, prompt-complete snapshot payload emitted below. */
export function parseAgentSessionSnapshot(
  raw: unknown,
  expectedSessionId: string,
): AgentSessionSnapshotSeed | undefined {
  if (!isRecord(raw)) return undefined;
  const version = raw.agentSessionSnapshotVersion;
  if (typeof version !== "number" || ![1, 2, AGENT_SESSION_SNAPSHOT_VERSION].includes(version)) return undefined;
  const model = deserializeModel(raw.model);
  if (model === undefined || model.sessionId !== expectedSessionId) return undefined;

  let historyRaw: unknown;
  let historyDigest: string | undefined;
  let serializedBytes: number | undefined;
  if (version === AGENT_SESSION_SNAPSHOT_VERSION) {
    const capsule = isRecord(raw.promptCapsule) ? raw.promptCapsule : undefined;
    const resumeView = isRecord(raw.resumeView) ? raw.resumeView : undefined;
    if (capsule === undefined || resumeView === undefined || !Array.isArray(capsule.history)) return undefined;
    const tailItemLimit = resumeView.tailItemLimit;
    const tailByteLimit = resumeView.tailByteLimit;
    const omittedCount = resumeView.omittedCount;
    if (
      tailItemLimit !== RESUME_TAIL_ITEM_LIMIT ||
      tailByteLimit !== RESUME_TAIL_BYTE_LIMIT ||
      typeof omittedCount !== "number" || !Number.isSafeInteger(omittedCount) || omittedCount < 0 ||
      !Array.isArray(resumeView.omittedRanges)
    ) return undefined;
    historyRaw = capsule.history;
    if (typeof capsule.historyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(capsule.historyDigest)) return undefined;
    if (typeof capsule.serializedBytes !== "number" || !Number.isSafeInteger(capsule.serializedBytes) || capsule.serializedBytes < 0) return undefined;
    historyDigest = capsule.historyDigest;
    serializedBytes = capsule.serializedBytes;
    if (capsule.history.length > RESUME_TAIL_ITEM_LIMIT || capsule.history.length > PROMPT_CAPSULE_ITEM_LIMIT) return undefined;
  } else {
    historyRaw = raw.promptHistory;
  }
  if (!Array.isArray(historyRaw) || !historyRaw.every(isSnapshotHistoryItem)) return undefined;
  const promptHistory = structuredClone(historyRaw) as ModelInputItem[];
  const actualDigest = stableDigest(promptHistory);
  const actualBytes = new TextEncoder().encode(JSON.stringify(promptHistory)).byteLength;
  if (historyDigest !== undefined && historyDigest !== actualDigest) return undefined;
  if (serializedBytes !== undefined && serializedBytes !== actualBytes) return undefined;
  if (actualBytes > PROMPT_CAPSULE_BYTE_LIMIT) return undefined;

  const turnCounter = raw.turnCounter;
  if (typeof turnCounter !== "number" || !Number.isSafeInteger(turnCounter) || turnCounter < 0) return undefined;
  const residentTimelineOmitted = raw.residentTimelineOmitted;
  if (
    residentTimelineOmitted !== undefined &&
    (typeof residentTimelineOmitted !== "number" || !Number.isSafeInteger(residentTimelineOmitted) || residentTimelineOmitted < 0)
  ) return undefined;
  return {
    model,
    promptHistory,
    ...(historyDigest === undefined ? {} : { promptHistoryDigest: historyDigest }),
    ...(serializedBytes === undefined ? {} : { promptSerializedBytes: serializedBytes }),
    turnCounter,
    ...(residentTimelineOmitted !== undefined ? { residentTimelineOmitted } : {}),
    ...(typeof raw.compactState === "string" && raw.compactState.length > 0 ? { compactState: raw.compactState } : {}),
  };
}

function promptHistoryCapsule(history: readonly ModelInputItem[]): {
  readonly history: readonly ModelInputItem[];
  readonly historyDigest: string;
  readonly serializedBytes: number;
  readonly omittedCount: number;
  readonly omittedRanges: readonly { readonly start: number; readonly end: number }[];
} {
  const selected: ModelInputItem[] = [];
  let bytes = 2;
  for (let index = history.length - 1; index >= 0 && selected.length < RESUME_TAIL_ITEM_LIMIT; index -= 1) {
    const item = history[index];
    if (item === undefined) continue;
    const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength + 1;
    if (selected.length > 0 && bytes + itemBytes > RESUME_TAIL_BYTE_LIMIT) break;
    selected.unshift(structuredClone(item));
    bytes += itemBytes;
  }
  const historyDigest = stableDigest(selected);
  const serializedBytes = new TextEncoder().encode(JSON.stringify(selected)).byteLength;
  const omittedCount = Math.max(0, history.length - selected.length);
  return {
    history: Object.freeze(selected),
    historyDigest,
    serializedBytes,
    omittedCount,
    omittedRanges: omittedCount === 0 ? Object.freeze([]) : Object.freeze([{ start: 0, end: omittedCount }]),
  };
}
function verificationProcessClass(toolId: string, display: string): string | undefined {
  if (toolId !== "process.run" && toolId !== "shell.run") return undefined;
  const normalized = display.toLowerCase();
  if (/typecheck/.test(normalized)) return "typecheck";
  if (/(^|\s)lint(\s|$)/.test(normalized)) return "lint";
  if (/(^|\s)test(\s|$)|cargo test|bun test|pytest|go test/.test(normalized)) return "test";
  if (/(^|\s)check(\s|$)/.test(normalized)) return "check";
  return undefined;
}

function isVerificationProcess(toolId: string, display: string): boolean {
  return verificationProcessClass(toolId, display) !== undefined;
}

function normalizedWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function evidenceRecordPath(
  record: EvidenceSelection["records"][number],
): string | undefined {
  const metadataPath = record.metadata?.path;
  if (typeof metadataPath === "string" && metadataPath.length > 0) {
    return normalizedWorkspacePath(metadataPath).replace(/\/$/u, "");
  }
  if (record.kind !== "file_excerpt") return undefined;
  const locatorPath = record.locator.split("#L", 1)[0];
  return locatorPath === undefined || locatorPath.length === 0
    ? undefined
    : normalizedWorkspacePath(locatorPath).replace(/\/$/u, "");
}

function pathMatchesTaskBoundary(path: string, rawBoundary: string): boolean {
  const boundary = normalizedWorkspacePath(rawBoundary).replace(/\/$/u, "");
  if (boundary === "." || boundary.length === 0) return true;
  if (/[*?[\]]/u.test(boundary)) return globMatch(boundary, path);
  return path === boundary || path.startsWith(`${boundary}/`);
}

function pathAllowedForTask(
  path: string,
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): boolean {
  return allowedPaths.some((boundary) => pathMatchesTaskBoundary(path, boundary)) &&
    !forbiddenPaths.some((boundary) => pathMatchesTaskBoundary(path, boundary));
}

export class AgentSession {
  readonly registry: ToolRegistry;
  readonly context: ContextEngine;
  readonly skills: SkillRegistry;
  readonly subagents: SubagentScheduler;
  readonly executor: RuntimeToolExecutor;
  readonly kernel: AgentKernel;
  readonly taskEpoch: TaskEpochManager;
  readonly inferencePolicy: InferencePolicyPort;

  readonly recorder: SessionRecorder;

  readonly #options: AgentSessionOptions;
  readonly #performanceTelemetryEnabled: boolean;
  readonly #loadedSkills = new Map<string, SkillDefinition>();
  #todoController!: TodoController;
  /** Digest-bound Build execution capability; a cancelled turn keeps it available for an immediate retry. */
  #planExecution: { readonly digest: string; readonly contextStrategy: PlanContextStrategy } | undefined;
  #compactState: string | undefined;
  #taskDescription: string | undefined;
  #cacheKey: string | undefined;
  #lastCompiledPackId: string | undefined;
  /** P1's pre-sample immutable candidate pack; P0 L6 remains the safe renderer during migration. */
  #preparedContextPack: ContextPack | undefined;
  #lastContextInspection: ContextInspection | undefined;
  #lastRepositoryContext: readonly string[] = [];
  #currentRoute: InferencePolicyDecision | undefined;
  #currentContextBand: string | number | undefined;
  /** Evidence selected for the current turn, announced once the route is known. */
  #turnEvidence: EvidenceSelection | undefined;
  #checkpointId: string | undefined;
  #turnCounter = 0;
  #workspaceGeneration = 0;
  #repositoryRefreshRevision = 0;
  #repositoryRefresh: Promise<void> | undefined;
  readonly #pendingRepositoryDeltaPaths = new Set<string>();
  readonly #subagentCapsules = new Map<string, { generation: number; capsule: TaskContextCapsule }>();
  #lastToolOutputCompactionHistoryLength = 0;
  #lastCompiledRootHistoryLength = 0;
  #lastRepositoryScanPaths: readonly string[] = [];
  readonly #changedPaths = new Set<string>();
  readonly #verificationGenerations = new Map<string, { generation: number; ok: boolean }>();
  #verificationInvalidatingGeneration = 0;
  readonly #readObservationGenerations = new Map<string, { paths: readonly string[]; generation: number }>();
  readonly #hydratedStaleReadCallIds = new Set<string>();
  readonly #pathMutationGenerations = new Map<string, number>();
  #wholeWorkspaceReadInvalidationGeneration = 0;
  readonly #activeBackgroundJobs = new Set<string>();
  #backgroundJobsReconciled = true;
  #compacting = false;
  #epochAnnounced = false;
  readonly #subagentBridge: SubagentBridge;
  readonly #readCache: ReadCache;
  /** Integrated token-saving controller (`agent.tokenSaving`). */
  readonly #tokenSaving: TokenSavingController;
  /** Provider continuation was lost mid-turn; the next recovery sample is Off. */
  #tokenSavingContinuationRecovery = false;
  /** The most recently resolved plan, for `/status` and inspectors. */
  #tokenSavingLastPlan: ResolvedTokenSavingPlan | undefined;

  constructor(options: AgentSessionOptions) {
    this.#options = options;
    const performanceSampleRate = Math.min(1, Math.max(0, options.config.perf.sampleRate));
    const performanceSampleBucket = Number.parseInt(stableDigest(options.sessionId).slice(0, 8), 16) /
      0xffff_ffff;
    this.#performanceTelemetryEnabled = options.config.perf.telemetry &&
      performanceSampleRate > 0 &&
      (performanceSampleRate === 1 || performanceSampleBucket < performanceSampleRate);
    // A runtime may outlive this AgentSession and still own write-capable jobs.
    // Probe it before the first provider sample; lightweight test doubles that
    // do not implement process status remain compatible.
    this.#backgroundJobsReconciled = typeof options.runtime.jobStatus !== "function";
    this.#permissionPreset = options.config.permissions.preset;
    this.#tokenSaving = new TokenSavingController(options.config.agent.tokenSaving);
    this.taskEpoch = new TaskEpochManager({
      initial: {
        goalDigest: "unassigned-goal",
        policyDigest: stableDigest({
          mode: options.config.agent.permissionMode,
          provider: options.config.provider.openai,
          phasePolicy: options.config.model.router.phasePolicy,
          promptCompiler: options.config.agent.promptCompiler,
          compoundTools: options.config.agent.compoundTools,
        }),
        workspaceIdentityDigest: options.workspaceIdentityDigest ?? stableDigest(options.workspacePath),
        toolsetDigest: stableDigest(NATIVE_TOOLS.filter((tool) => options.config.agent.compoundTools || (tool.id !== "repo.investigate" && tool.id !== "verification.run_many")).map((tool) => tool.id)),
        modelId: options.config.model.default,
      },
    });
    this.inferencePolicy = options.inferencePolicy ?? new InferenceUtilityController({
      strategy: options.config.model.router.strategy,
      targetLatencyMs: options.config.model.router.targetLatencyMs,
      defaultModel: options.config.model.router.defaultTier,
      cheapModel: options.config.model.router.cheapTier,
      escalationModel: options.config.model.router.escalationTier,
      maxCostUsd: options.config.model.router.maxCostUsdPerTurn,
    });
    this.recorder = new SessionRecorder({
      sessionId: options.sessionId,
      transport: new RuntimeJournalTransport(options.runtime),
      contextBudgetTokens: options.config.model.softContextTokens,
      snapshotEveryEvents: options.config.sessions.autoSnapshotEvents,
      serializeSnapshot: (model) => {
        const prompt = promptHistoryCapsule(this.kernel.history);
        return {
          agentSessionSnapshotVersion: AGENT_SESSION_SNAPSHOT_VERSION,
          model: serializeModel(model),
          promptCapsule: {
            history: prompt.history,
            historyDigest: prompt.historyDigest,
            serializedBytes: prompt.serializedBytes,
          },
          resumeView: {
            tailItemLimit: RESUME_TAIL_ITEM_LIMIT,
            tailByteLimit: RESUME_TAIL_BYTE_LIMIT,
            omittedCount: prompt.omittedCount,
            omittedRanges: prompt.omittedRanges,
          },
          ...(this.#compactState !== undefined ? { compactState: this.#compactState } : {}),
          turnCounter: this.#turnCounter,
          residentTimelineOmitted: this.recorder.residentTimelineOmitted,
        };
      },
      ...(options.startAfterSequence !== undefined
        ? { startAfterSequence: options.startAfterSequence }
        : {}),
      onEvent: (event) => {
        // A provider fallback drops continuation state, so the next recovery
        // sample runs un-saved and must restate any saving directive.
        if (event.kind === "provider.fallback") {
          this.#tokenSavingContinuationRecovery = true;
          this.#tokenSaving.resetDirectiveTracking();
        }
        options.onEvent?.(event, this.recorder.model);
      },
      onJournalError: (event, error) => {
        // 짠22.9: a journal failure degrades durability, not the turn. It is
        // surfaced so the user knows resume may be incomplete.
        options.onJournalError?.(event, error);
      },
    });

    this.registry = new ToolRegistry(NATIVE_TOOLS.filter((tool) => options.config.agent.compoundTools || (tool.id !== "repo.investigate" && tool.id !== "verification.run_many")));
    this.#todoController = new TodoController({
      mode: () => this.recorder.model.modeState.selected,
      now: () => new Date(options.now?.() ?? options.host.now()).toISOString(),
      emit: (kind, payload) => this.#emit(kind, payload),
    });
    this.context = new ContextEngine({
      reader: new RuntimeInstructionReader(options.runtime),
      ...(options.globalInstructionReader !== undefined ? { globalReader: options.globalInstructionReader } : {}),
      softContextTokens: options.config.model.softContextTokens,
      activeExcerptTokens: Math.min(24_000, Math.max(2_000, Math.floor(options.config.model.softContextTokens * 0.2))),
      ...(options.workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest: options.workspaceIdentityDigest } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.skills = new SkillRegistry({
      productVersion: "0.1.0",
      workspaceTrusted: options.trust === "trusted-always" || options.trust === "trusted-once",
    });
    // One read cache serves the root executor and every child executor the
    // subagent bridge runs: a parent's reads answer its children's identical
    // reads, so a delegation stops paying twice for the same exploration.
    // Keep completed reads shareable for the root and children. Known mutations
    // invalidate paths immediately; the nonzero TTL bounds edits made outside CBC.
    const readCacheTtlMs = Math.max(1, options.config.model.cache.ttlMinutes * 60_000);
    const readCache = new ReadCache({ now: () => options.host.now(), ttlMs: readCacheTtlMs });
    this.#readCache = readCache;
    this.#subagentBridge = new SubagentBridge({
      sessionId: options.sessionId,
      host: options.host,
      runtime: options.runtime,
      config: options.config,
      selectedModel: () => this.#currentRoute?.model ?? options.config.model.default,
      inferencePolicy: this.inferencePolicy,
      provider: options.provider,
      approvals: options.approvals,
      ...(options.mcpHint !== undefined ? { mcpHint: options.mcpHint } : {}),
      readCache,
      permissionContext: () => this.permissionContext(),
      promptInputs: () => this.promptInputs(),
      createContextCapsule: (childContext) => this.#createSubagentContextCapsule(childContext),
      emit: <T>(
        kind: CbcEventKind,
        payload: T,
        eventOptions?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string },
      ) => this.#emitKernelEvent(kind, payload, eventOptions),
      ...(options.bridges !== undefined ? { bridges: options.bridges } : {}),
      onInvalidate: (path) => {
        readCache.invalidatePath(this.#canonicalWorkspacePath(path));
        this.#invalidateContextPath(path, "sub-agent mutation committed");
      },
      workspaceGeneration: () => this.#workspaceGeneration,
      onWorkspacePotentiallyChanged: (toolId, action) => {
        readCache.invalidateAll();
        this.#invalidateWholeWorkspace(`${toolId} may have changed the workspace`, {
          verificationNeutral: action !== undefined && isVerificationProcess(toolId, action.display),
        });
      },
      onObservation: (event) => this.#ingestToolObservation(event),
      onArtifactSpilled: (artifact, action) => {
        this.context.recordArtifactHandle(artifact, `${action.toolId} ${action.callId}`);
      },
      onChildFinished: (agentId) => {
        this.context.cancelPromotionLeasesForOwner(agentId);
      },
      onBackgroundJobStarted: (jobId) => { this.#activeBackgroundJobs.add(jobId); },
      beforeSample: () => this.#reconcileBackgroundJobs(),
      onPromptCompiled: (prompt, route, childScope) => {
        const epoch = this.taskEpoch.current();
        this.#handleCompiledPrompt(prompt, {
          ...(route !== undefined ? { route, contextBand: route.context.band } : {}),
          scope: {
            ...(childScope.turnId !== undefined ? { turnId: childScope.turnId } : {}),
            agentId: childScope.agentId,
            callerId: childScope.agentId,
            ...(epoch !== undefined
              ? {
                  taskEpochId: epoch.id,
                  workspaceIdentityDigest: epoch.workspaceIdentityDigest,
                }
              : {}),
          },
          updateRootInspector: false,
        });
      },
      cacheKey: (prompt, route) => this.#cacheKeyForPrompt(prompt, route),
      testCommandFor: (paths) => testCommandFor(paths, options.config.perf.verificationPlannerV2 !== false),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.subagents = this.#subagentBridge.scheduler;

    // Preserve a host-provided task bridge, but install the real scheduler when
    // the session did not supply one. P0-15: the extension manager contributes the
    // Skill, MCP, and user.ask bridges too ??a host-supplied bridge always wins.
    const extensions = new ExtensionManager({
      registry: this.skills,
      host: options.host,
      nonInteractive: options.nonInteractive,
    });
    const bridges: ToolBridges = {
      task: options.bridges?.task ?? this.#subagentBridge.execute,
      skill: options.bridges?.skill ?? extensions.bridges.skill,
      ask: options.bridges?.ask ?? extensions.bridges.ask,
      mcp: options.bridges?.mcp ?? options.mcpBridge ?? extensions.bridges.mcp,
      todo: async (action) => this.#executeTodoWrite(action),
    };


    this.executor = new RuntimeToolExecutor({
      runtime: options.runtime,
      host: options.host,
      sessionId: options.sessionId,
      bridges,
      readCache,
      scope: () => {
        const turnId = this.recorder.model.currentTurnId;
        return {
          ...(turnId !== undefined ? { turnId } : {}),
          agentId: "root",
          // Tagging every transaction with the current approach is what lets the
          // runtime find the whole set later; by the time reflection abandons an
          // approach, the transactions it created are already closed.
          ...(this.#checkpointId !== undefined ? { checkpointId: this.#checkpointId } : {}),
          workspaceGeneration: this.#workspaceGeneration,
        };
      },
      onWorkspacePotentiallyChanged: (toolId, action) => {
        readCache.invalidateAll();
        this.#invalidateWholeWorkspace(`${toolId} may have changed the workspace`, {
          verificationNeutral: action !== undefined && isVerificationProcess(toolId, action.display),
        });
      },
      onTransaction: (event) => {
        // 짠20.6 puts `turnId` on the envelope, and a transaction always belongs to a
        // turn. Omitting it made the transaction unattributable: any consumer correlating
        // a commit with the tool call that caused it ??including 짠26.4's
        // invisible-side-effect metric ??saw a mutation with no visible origin.
        this.#emit(
          event.kind === "started"
            ? "transaction.started"
            : event.kind === "committed"
              ? "transaction.committed"
              : "transaction.rolled_back",
          { transactionId: event.transactionId, paths: event.paths },
          this.#currentScope(),
        );
        if (event.kind === "committed") {
          if (event.paths.length > 0) {
            readCache.invalidatePaths(event.paths.map((path) => this.#canonicalWorkspacePath(path)));
            for (const path of event.paths) {
              this.#changedPaths.add(path);
              this.#invalidateContextPath(path, "transaction committed");
            }
          } else {
            readCache.invalidateAll();
            this.#invalidateWholeWorkspace("transaction committed without known paths");
          }
        }
      },
      onArtifactSpilled: (artifact, action) => {
        this.context.recordArtifactHandle(artifact, `${action.toolId} ${action.callId}`);
      },
      onJobStarted: (job) => {
        this.#activeBackgroundJobs.add(job.jobId);
        this.#emit(
          "job.started",
          { jobId: job.jobId, display: job.display },
          this.#currentScope(),
        );
      },
      onObservation: (event) => this.#ingestToolObservation(event),
    });

    const emitter: KernelEmitter = {
      emit: <T>(kind: CbcEventKind, payload: T, opts?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string; visibility?: EventVisibility }) => {
        this.#emitKernelEvent(kind, payload, opts);
      },
    };

    this.kernel = new AgentKernel({
      agentId: "root",
      role: "root",
      continuationMode: options.config.provider.openai.transport === "http_full" ? "client_managed" : "previous_response",
      provider: options.provider,
      registry: this.registry,
      executor: this.executor,
      approvals: options.approvals,
      normalizer: new HostActionNormalizer({
        defaultCwd: ".",
        ...(options.mcpHint !== undefined ? { mcpHint: options.mcpHint } : {}),
      }),
      emitter,
      limits: {
        ...ROOT_LIMITS,
        maxModelSteps: options.config.agent.maxSteps,
        maxToolCalls: options.config.agent.maxToolCalls,
        maxWallTimeMs: options.config.agent.maxWallTimeMinutes * 60_000,
        maxChildDepth: options.config.subagents.maxDepth,
      },
      model: options.config.model.default,
      autoRoute: options.autoRoute ?? shouldAutoRoute(options.config.model),
      reasoningMode: options.config.model.reasoningMode,
      reasoningEffort: options.config.model.reasoningEffort,
      // Provider generation is independent from the current TUI disclosure mode.
      reasoningSummary: options.config.model.reasoning.summary,
      inferencePolicy: this.inferencePolicy,
      reserveOutputTokens: this.#options.config.model.context.reserveOutputTokens,
      onRouteDecided: (route) => {
        this.#currentRoute = route;
        this.#currentContextBand = route.context.band;
      },
      onPromptCompiled: (assembled, metadata) => this.#handleCompiledPrompt(
        assembled,
        metadata === undefined ? {} : { metadata },
      ),
      callerId: "root",
      taskEpochId: () => this.taskEpoch.current()?.id,
      workspaceIdentityDigest: () => this.taskEpoch.current()?.workspaceIdentityDigest,
      ...(options.reasoningEffortLocked === true ? { reasoningEffortLocked: true } : {}),
      maxOutputTokens: options.config.model.maxOutputTokens,
      promptCompiler: options.config.agent.promptCompiler,
      parallelToolCalls: options.config.agent.toolGraph.providerParallelTools,
      nativeCompaction: options.config.model.context.providerCompaction,
      compactionThresholdTokens: options.config.model.context.compactionThresholdTokens,
      serviceTier: options.config.provider.openai.serviceTier,
      phasePolicy: options.config.model.router.phasePolicy,
      commandClassification: options.config.agent.toolGraph.commandClassification,
      toolGraph: options.config.agent.toolGraph,
      cacheKey: (assembled) => this.#cacheKeyForPrompt(assembled),
      safetyIdentifier: stableDigest({ sessionId: options.sessionId, workspace: this.taskEpoch.current()?.workspaceIdentityDigest }),
      complexity: () => ({
        requestedConcerns: this.#taskDescription === undefined ? 1 : Math.min(4, this.#taskDescription.split(/\s+/u).length),
        expectedFilesTouched: this.context.lastSelection?.selected.length ?? 0,
        repositorySize: this.context.repositoryMap?.files.length ?? 0,
        failingTestAmbiguity: this.context.reflections.length > 0 ? 2 : 0,
        crossLanguageImpact: false,
        concurrencyInvolved: false,
        highRiskDomain: this.#options.config.permissions.credentials === "deny" ? false : true,
        userSpecifiedDepth: "normal" as const,
        previousFailedAttempts: this.context.reflections.length,
      }),
      autoReview: options.config.agent.reviewMode === "auto" || options.config.agent.permissionMode === "auto-review",
      // 짠11.9 / P0-12: when auto-review is on, the reviewer actually exists ??a
      // separate provider call with its own context, so the review is independent
      // of the turn that produced the change.
      ...(options.config.agent.reviewMode === "auto" || options.config.agent.permissionMode === "auto-review"
        ? { reviewer: (diffSummary: string, signal: AbortSignal) => this.#independentReview(diffSummary, signal) }
        : {}),
      reviewPolicy: options.config.agent.verification.reviewPolicy,
      minimumReviewRisk: riskLevelForPermissionThreshold(options.config.agent.verification.independentReviewRiskThreshold),
      reviewMaterial: (paths, signal) => this.#reviewMaterial(paths, signal),

      verificationCoverage: () => ({
        staleEvidence: [...this.#verificationGenerations.values()].filter(
          (verification) => verification.ok && verification.generation < this.#verificationInvalidatingGeneration,
        ).length,
      }),
      permissionContext: () => this.permissionContext(),
      promptInputs: () => this.promptInputs(),
      interactionMode: () => this.recorder.model.modeState.selected,
      todoState: () => {
        const items = [...this.#todoController.completionItems()];
        // An approved Plan is a digest-bound execution capability. If the model
        // changes its scope during the turn, statuses alone must not let an
        // optimistic final claim completion under the old approval.
        const planState = this.#todoController.current();
        if (planState.document !== undefined && this.#planExecution === undefined) {
          items.push({
            id: "plan-approval-required",
            text: "Explicitly approve the Plan and execute it in Build mode before reporting completion",
            status: "blocked",
          });
        } else if (
          planState.document !== undefined &&
          this.#planExecution !== undefined &&
          (!this.#todoController.approvalValid() || this.#planExecution.digest !== this.#todoController.digest())
        ) {
          items.push({
            id: "plan-approval-invalidated",
            text: "Re-review and approve the changed Plan scope before reporting completion",
            status: "blocked",
          });
        }
        return items;
      },
      beforeSample: async () => {
        await this.#reconcileBackgroundJobs();
        const history = this.kernel.history;
        const newToolOutputs = history
          .slice(this.#lastToolOutputCompactionHistoryLength)
          .filter((item): item is Extract<ModelInputItem, { type: "function_call_output" }> =>
            item.type === "function_call_output");
        const newToolBytes = newToolOutputs.reduce(
          (sum, item) => sum + new TextEncoder().encode(item.output).byteLength,
          0,
        );
        const hasTruncatedObservation = newToolOutputs.some((item) =>
          /line\(s\) omitted|observation truncated|full output (?:stored|could not be stored)/i.test(item.output)
        );
        const accumulated = hasTruncatedObservation || newToolBytes > 128 * 1024;
        if (accumulated) await this.#artifactizeAccumulatedOutputs(newToolOutputs);
        this.compactContext({ toolOutputAccumulation: accumulated });
        if (accumulated) this.#lastToolOutputCompactionHistoryLength = this.kernel.history.length;
        await this.#prepareContextPack();
      },
      testCommandFor: (paths) => testCommandFor(paths, options.config.perf.verificationPlannerV2 !== false),
      // 짠11.2: a reflection immediately biases context selection toward the files
      // the failure named, so the next sample re-reads them instead of guessing
      // again (짠18.4).
      onReflection: (analysis) => {
        this.context.noteReflection({
          toolId: analysis.toolId,
          category: analysis.errorCategory,
          rootCause: analysis.rootCause,
          correctiveAction: analysis.correctiveAction,
          paths: [...analysis.implicatedPaths],
        });
      },
      // 짠12.5: when reflection abandons an approach, the runtime undoes what that
      // approach wrote. The kernel decides; only the runtime can decide per path
      // whether undoing is safe.
        checkpoints: {
        current: () => this.#checkpointId,
          rollbackTo: async (checkpointId) => {
            const outcome = await options.runtime.rollbackToCheckpoint(checkpointId);
            if (outcome.revertedPaths.length > 0) {
              readCache.invalidatePaths(outcome.revertedPaths.map((path) => this.#canonicalWorkspacePath(path)));
            }
          for (const path of outcome.revertedPaths) {
            this.#invalidateContextPath(path, "checkpoint rollback reverted the workspace");
          }
          await this.context.refreshInstructionsForPaths(outcome.revertedPaths);
          const deltaPaths = this.#takeRepositoryDeltaPaths();
          if (deltaPaths.length > 0 && !this.context.repositoryMapDirty) {
            await this.#refreshRepositoryDelta(deltaPaths);
          }
          if (this.context.repositoryMapDirty) await this.#refreshRepositoryMap();
          // A new approach must not be able to roll back into the abandoned one.
          this.#checkpointId = undefined;
          return {
            checkpointId: outcome.checkpointId,
            revertedPaths: outcome.revertedPaths,
            skippedPaths: outcome.skippedPaths.map((entry) => entry.path),
          };
        },
      },
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /**
   * The approach the current mutations belong to (짠11.2).
   *
   * Rotated at the start of every turn and cleared once rolled back, so a
   * checkpoint can never be used to undo work from an approach that already ended.
   */
  get checkpointId(): string | undefined {
    return this.#checkpointId;
  }

  get viewModel(): SessionViewModel {
    return this.recorder.model;
  }


  get orientationMode(): "strict" | "progressive" {
    return this.#options.config.model.context.orientationMode;
  }

  prewarmProvider(signal?: AbortSignal): Promise<void> {
    return signal === undefined ? this.kernel.prewarm() : this.kernel.prewarm(signal);
  }

  close(): Promise<void> {
    return this.kernel.close();
  }

  get performanceTelemetryEnabled(): boolean {
    return this.#performanceTelemetryEnabled;
  }
  get compactState(): string | undefined {
    return this.#compactState;
  }

  get lastSequence(): number {
    return this.recorder.lastSequence;
  }

  /** Wait for every journal append to be acknowledged (짠20.9). */
  async flush(): Promise<void> {
    await this.recorder.flush();
  }

  /** 짠18.16 snapshot, forced on a clean exit. */
  async snapshot(force = false): Promise<boolean> {
    return await this.recorder.maybeSnapshot(force);
  }

  /** Seed reducer + prompt state from a validated snapshot, then replay its tail. */
  hydrate(
    events: readonly CbcEvent[],
    options: AgentSessionHydrationOptions = {},
  ): void {
    if (options.seed !== undefined) {
      if (options.snapshotPosition === undefined) {
        throw new Error("snapshotPosition is required with a snapshot seed");
      }
      this.recorder.hydrateSeededModel(options.seed.model, options.snapshotPosition, {
        ...(options.seed.residentTimelineOmitted !== undefined
          ? { residentTimelineOmitted: options.seed.residentTimelineOmitted }
          : {}),
      });
      this.#compactState = options.seed.compactState;
      this.#turnCounter = Math.max(this.#turnCounter, options.seed.turnCounter);
    }
    this.recorder.hydrate(events, options.finalPosition);
    this.#todoController.hydrate(this.recorder.model.todo);
    // The controller is the fail-closed authority for hydrated Plan state. Keep
    // the reducer/UI projection in lockstep when a snapshot contained malformed
    // or stale approval bytes.
    const hydratedTodo = this.#todoController.current();
    const hydratedModel = this.recorder.model as unknown as { todo: typeof hydratedTodo; plan: PlanItem[] };
    hydratedModel.todo = hydratedTodo;
    hydratedModel.plan = hydratedTodo.items.map((item) => ({ ...item }));
    this.registry.setInteractionMode(this.recorder.model.modeState.selected);
    this.kernel.hydrateHistory(
      historyFromEvents(events, options.seed?.promptHistory ?? []),
    );
    // Context/evidence stores are intentionally not trusted across process restart.
    // Every hydrated read output (including a prior locator) must be reread before use.
    for (const item of this.kernel.history) {
      if (item.type === "function_call" && (item.name === "fs.read" || item.name === "fs.read_many")) {
        this.#hydratedStaleReadCallIds.add(item.callId);
      }
    }
    const compacted = [...events].reverse().find((event) => event.kind === "session.compacted");
    const payload = compacted !== undefined && isRecord(compacted.payload) ? compacted.payload : undefined;
    if (typeof payload?.compactState === "string" && payload.compactState.length > 0) {
      this.#compactState = payload.compactState;
    }
    this.#turnCounter = Math.max(this.#turnCounter, turnCounterFromEvents(events));
    this.#backgroundJobsReconciled = false;
  }

  /** Register the bundled Skills plus any discovered on disk (짠16.2). */
  registerSkills(files: readonly SkillFile[] = []): void {
    this.skills.register([...builtinSkillFiles(), ...files]);
  }

  /** Record a Skill body the model explicitly loaded (짠16.4 stage 2). */
  markSkillLoaded(name: string): SkillDefinition | undefined {
    const definition = this.skills.get(name);
    if (definition !== undefined && definition.body.length > 0) this.#loadedSkills.set(name, definition);
    return definition;
  }

  #canonicalWorkspacePath(path: string): string {
    const normalized = normalizedWorkspacePath(path);
    const workspace = normalizedWorkspacePath(this.#options.workspacePath).replace(/\/$/, "");
    const relative = normalized === workspace
      ? ""
      : normalized.startsWith(`${workspace}/`)
        ? normalized.slice(workspace.length + 1)
        : normalized;
    return relative.replace(/^\//, "");
  }

  #skillBodiesForPrompt(): Array<{ name: string; body: string; source: string }> {
    const bodies = new Map(
      this.skills.loadedBodies().map((skill) => [skill.name, skill] as const),
    );
    // Preserve the legacy explicit marker for embedders that provide an eager
    // Skill bridge, while preferring the registry's stage-2 body when both exist.
    for (const definition of this.#loadedSkills.values()) {
      const name = definition.manifest.name;
      if (!bodies.has(name) && definition.body.length > 0) {
        bodies.set(name, { name, body: definition.body, source: definition.source });
      }
    }
    return [...bodies.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  setTaskDescription(text: string | undefined): void {
    this.#taskDescription = text;
  }

  setCompactState(text: string | undefined): void {
    this.#compactState = text;
  }

  async #ingestToolObservation(event: ToolObservationEnvelope): Promise<ToolObservationAck> {
    if (event.action.toolId === "process.stop" && event.execution.result.ok) {
      const jobId = (event.action.arguments as Record<string, unknown>).jobId;
      if (typeof jobId === "string") this.#activeBackgroundJobs.delete(jobId);
    }
    const errorCode = event.execution.result.error?.code;
    if (!event.execution.result.ok && (errorCode === "HASH_MISMATCH" || errorCode === "PATH_CHANGED")) {
      const affected = [...new Set([...(event.action.reads ?? []), ...(event.action.writes ?? [])])];
      if (affected.length === 0) {
        this.#readCache.invalidateAll();
        this.#invalidateWholeWorkspace(`${event.action.toolId} reported ${errorCode}`);
      } else {
        this.#readCache.invalidatePaths(affected.map((path) => this.#canonicalWorkspacePath(path)));
        for (const path of affected) {
          this.#invalidateContextPath(path, `${event.action.toolId} reported ${errorCode}`);
        }
      }
    }
    const contextObservation = event.agentId !== undefined && event.agentId !== "root"
      ? { ...event, promotionOwner: "root" }
      : event;
    const result = this.context.ingestToolObservation(contextObservation);
    const scope = {
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      agentId: event.agentId ?? "root",
      callerId: event.agentId ?? "root",
      ...(this.taskEpoch.current() !== undefined
        ? {
            taskEpochId: this.taskEpoch.requireCurrent().id,
            workspaceIdentityDigest: this.taskEpoch.requireCurrent().workspaceIdentityDigest,
          }
        : {}),
    };

    this.#emit("context.observation_ingested", {
      toolId: event.action.toolId,
      callId: event.action.callId,
      cacheHit: event.cacheHit,
      evidenceIds: result.evidence.map((record) => record.id),
      excerptIds: result.excerptIds,
      artifactIds: result.artifactIds,
      invalidatedEvidenceIds: result.invalidatedEvidenceIds,
      rejected: result.rejected,
    }, scope);
    for (const record of result.evidence) {
      this.#emit("evidence.recorded", {
        evidenceId: record.id,
        kind: record.kind,
        locator: record.locator,
        digest: record.digest,
        freshness: record.freshness,
        cacheHit: event.cacheHit,
      }, scope);
    }
    if (result.invalidatedEvidenceIds.length > 0) {
      // A checksum drift/failed revalidation is an observed workspace-generation
      // boundary. Parallel reads from the older generation must not be promoted.
      this.#workspaceGeneration += 1;
      this.#verificationInvalidatingGeneration = this.#workspaceGeneration;
      for (const path of event.action.reads ?? []) this.#recordPathMutation(path);
    }
    for (const evidenceId of result.invalidatedEvidenceIds) {
      this.#emit("context.evidence_invalidated", {
        evidenceId,
        reason: "runtime checksum changed",
      }, scope);
      this.#emit("evidence.invalidated", {
        evidenceId,
        reason: "runtime checksum changed",
      }, scope);
      this.#emit("context.evidence_rejected", {
        evidenceId,
        reason: "stale evidence rejected after runtime checksum changed",
      }, scope);
    }
    const compilerGeneration = this.#workspaceGeneration;
    if (
      event.execution.result.ok &&
      (event.action.toolId === "fs.read" || event.action.toolId === "fs.read_many")
    ) {
      this.#readObservationGenerations.set(event.action.callId, {
        paths: (event.action.reads ?? []).map((path) => this.#canonicalWorkspacePath(path)),
        generation: compilerGeneration,
      });
      while (this.#readObservationGenerations.size > MAX_READ_FRESHNESS_RECORDS) {
        const oldestCallId = this.#readObservationGenerations.keys().next().value as string | undefined;
        if (oldestCallId === undefined) break;
        this.#readObservationGenerations.delete(oldestCallId);
      }
    }
    if (
      isVerificationProcess(event.action.toolId, event.action.display)
    ) {
      this.#verificationGenerations.set(
        verificationProcessClass(event.action.toolId, event.action.display) ?? event.action.display,
        { generation: compilerGeneration, ok: event.execution.result.ok },
      );
    }
    for (const entry of result.rejected) {
      this.#emit("context.evidence_rejected", {
        evidenceId: entry.locator ?? `${event.action.toolId}:${event.action.callId}`,
        reason: entry.reason,
      }, scope);
    }

    const touched = [...new Set([...(event.action.reads ?? []), ...(event.action.writes ?? [])])];
    if (touched.length > 0) {
      const instructionDigestBefore = stableDigest(this.context.instructions);
      await this.context.refreshInstructionsForPaths(touched);
      const instructionDigestAfter = stableDigest(this.context.instructions);
      if (instructionDigestAfter !== instructionDigestBefore) {
        this.#cacheKey = undefined;
        this.#emit("context.cache_segment", {
          segmentId: "stable-instructions",
          digest: instructionDigestAfter,
          tokens: estimateTokens(this.context.instructions.map((instruction) => instruction.content).join("\n")),
          stable: true,
          invalidated: true,
          reason: "project instructions changed",
        }, scope);
      }
    }

    if (
      event.action.toolId === "process.run" ||
      event.action.toolId === "shell.run" ||
      event.action.toolId === "process.start" ||
      event.action.toolId === "process.input" ||
      event.action.toolId === "process.stop"
    ) {
      const instructionDigestBefore = stableDigest(this.context.instructions);
      await this.context.refreshInstructionsForPaths([]);
      const instructionDigestAfter = stableDigest(this.context.instructions);
      if (instructionDigestAfter !== instructionDigestBefore) {
        this.#cacheKey = undefined;
        this.#emit("context.cache_segment", {
          segmentId: "stable-instructions",
          digest: instructionDigestAfter,
          tokens: estimateTokens(this.context.instructions.map((instruction) => instruction.content).join("\n")),
          stable: true,
          invalidated: true,
          reason: `${event.action.toolId} changed project instructions`,
        }, scope);
      }
    }
    const pendingDeltaPaths = this.#takeRepositoryDeltaPaths();
    if (pendingDeltaPaths.length > 0 && !this.context.repositoryMapDirty) {
      await this.#refreshRepositoryDelta(pendingDeltaPaths);
    }
    if (this.context.repositoryMapDirty) await this.#refreshRepositoryMap();
    if (
      (event.action.toolId === "process.run" ||
        event.action.toolId === "shell.run" ||
        event.action.toolId === "process.start" ||
        event.action.toolId === "process.input" ||
        event.action.toolId === "process.stop") &&
      this.#lastRepositoryScanPaths.length > 0
    ) {
      const instructionDigestBefore = stableDigest(this.context.instructions);
      await this.context.refreshInstructionsForPaths(this.#lastRepositoryScanPaths);
      const instructionDigestAfter = stableDigest(this.context.instructions);
      if (instructionDigestAfter !== instructionDigestBefore) {
        this.#cacheKey = undefined;
        this.#emit("context.cache_segment", {
          segmentId: "stable-instructions",
          digest: instructionDigestAfter,
          tokens: estimateTokens(this.context.instructions.map((instruction) => instruction.content).join("\n")),
          stable: true,
          invalidated: true,
          reason: `${event.action.toolId} changed nested project instructions`,
        }, scope);
      }
    }

    if (this.#taskDescription !== undefined) {
      this.context.select({
        taskText: this.#taskDescription,
        mentionedPaths: extractPathMentions(this.#taskDescription),
        searchMatches: this.context.searchMatches(),
        recentToolPaths: this.context.recentToolPaths(),
        changedPaths: [...this.#changedPaths],
        recentFailurePaths: this.context.recentFailurePaths(),
      });
    }
    this.#turnEvidence = this.context.selectEvidence({ limit: 64, requireFresh: true });
    this.#emitExcerptEvictions(scope);

    // Only suppress an exact read's L7 body when the complete observation is
    // active in the bounded L6 working set. Evidence-only storage is not enough.
    const leaseOwner = "root";
    const cancelNewLeases = (): void => {
      this.context.cancelPromotionLeases(result.newlyLeasedExcerptIds, leaseOwner);
    };
    if (
      (this.#activeBackgroundJobs.size > 0 || !this.#backgroundJobsReconciled) &&
      (event.action.toolId === "fs.read" || event.action.toolId === "fs.read_many")
    ) {
      cancelNewLeases();
      return { disposition: "raw", workspaceGeneration: compilerGeneration - 1 };
    }
    if (this.#workspaceGeneration !== compilerGeneration) {
      cancelNewLeases();
      // Return the generation this observation was compiled against so the
      // executor converts the now-stale read into PATH_CHANGED with no body.
      return { disposition: "raw", workspaceGeneration: compilerGeneration };
    }
    if (event.action.toolId === "fs.read" || event.action.toolId === "fs.read_many") {
      if (!result.handled || !result.safeToVirtualize) {
        return {
          disposition: "raw",
          workspaceGeneration: compilerGeneration,
          onGenerationMismatch: cancelNewLeases,
          ...(result.partiallyPromotedPaths.length > 0
            ? { virtualizedPaths: result.partiallyPromotedPaths }
            : {}),
        };
      }
      return {
        disposition: result.exactContentPromoted ? "promoted" : "withheld",
        workspaceGeneration: compilerGeneration,
        onGenerationMismatch: cancelNewLeases,
      };
    }
    return { disposition: "promoted", workspaceGeneration: compilerGeneration, onGenerationMismatch: cancelNewLeases };
  }

  async #reconcileBackgroundJobs(): Promise<void> {
    if (!this.#backgroundJobsReconciled) {
      try {
        const listing = await this.#options.runtime.jobStatus(undefined, this.#options.sessionId);
        const jobs = isRecord(listing) && Array.isArray(listing.jobs)
          ? listing.jobs.flatMap((job): string[] => {
              if (typeof job === "string") return [job];
              if (!isRecord(job) || typeof job.jobId !== "string") return [];
              const state = typeof job.state === "string" ? job.state : undefined;
              return state === undefined || ["starting", "running"].includes(state)
                ? [job.jobId]
                : [];
            })
          : [];
        for (const jobId of jobs) this.#activeBackgroundJobs.add(jobId);
        this.#backgroundJobsReconciled = true;
      } catch {
        // Retry on the next sample; hydrated read outputs are independently
        // fail-closed until reread, so a transient probe cannot re-expose them.
        return;
      }
    }
    if (this.#activeBackgroundJobs.size === 0) return;
    let terminalObserved = false;
    for (const jobId of [...this.#activeBackgroundJobs]) {
      try {
        const raw = await this.#options.runtime.jobStatus(jobId, this.#options.sessionId);
        const state = isRecord(raw) && typeof raw.state === "string" ? raw.state : undefined;
        if (state !== undefined && !["starting", "running"].includes(state)) {
          this.#activeBackgroundJobs.delete(jobId);
          terminalObserved = true;
        }
      } catch (error) {
        if (error instanceof Error && /NOT_FOUND|no such job/i.test(error.message)) {
          this.#activeBackgroundJobs.delete(jobId);
          terminalObserved = true;
        }
      }
    }
    if (!terminalObserved) return;
    this.#readCache.invalidateAll();
    this.#invalidateWholeWorkspace("background process reached a terminal state");
    if (this.#activeBackgroundJobs.size > 0) return;
    await this.#refreshRepositoryMap();
  }

  #takeRepositoryDeltaPaths(): string[] {
    const paths = [...this.#pendingRepositoryDeltaPaths].sort((left, right) => left.localeCompare(right));
    this.#pendingRepositoryDeltaPaths.clear();
    return paths;
  }

  async #refreshRepositoryDelta(paths: readonly string[]): Promise<void> {
    if (paths.length === 0 || this.#activeBackgroundJobs.size > 0) return;
    const generation = this.#workspaceGeneration;
    const revision = ++this.#repositoryRefreshRevision;
    try {
      const delta = await scanRepositoryDelta(this.#options.runtime, paths);
      if (revision !== this.#repositoryRefreshRevision) return;
      if (!this.ingestRepositoryDelta(delta, generation)) return;
      await this.context.refreshInstructionsForPaths(paths);
      if (revision !== this.#repositoryRefreshRevision || generation !== this.#workspaceGeneration) return;
      // A truncated exact probe cannot establish a complete repository snapshot.
      // Keep it dirty and immediately use the normal full-scan fallback.
      if (delta.truncated === true || this.context.repositoryMapDirty) {
        await this.#refreshRepositoryMap();
      }
    } catch {
      // A known-path optimization must never leave an old map presented as fresh.
      this.#invalidateWholeWorkspace("repository delta refresh failed");
      await this.#refreshRepositoryMap();
    }
  }

  async #refreshRepositoryMap(): Promise<void> {
    if (this.#activeBackgroundJobs.size > 0) return;
    const generation = this.#workspaceGeneration;
    const revision = ++this.#repositoryRefreshRevision;
    try {
      const scan = await scanRepository(this.#options.runtime);
      if (revision !== this.#repositoryRefreshRevision) return;
      // A superseded generation is intentionally discarded; the dirty flag stays
      // set so the next observation/startup refresh can retry with a live scan.
      const instructionDigestBefore = stableDigest(this.context.instructions);
      if (!this.ingestRepositoryScan(scan, generation)) return;
      await this.context.refreshInstructionsForPaths(scan.files.map((file) => file.path));
      if (revision !== this.#repositoryRefreshRevision || generation !== this.#workspaceGeneration) return;
      const instructionDigestAfter = stableDigest(this.context.instructions);
      if (instructionDigestAfter !== instructionDigestBefore) {
        this.#cacheKey = undefined;
        this.#emit("context.cache_segment", {
          segmentId: "stable-instructions",
          digest: instructionDigestAfter,
          tokens: estimateTokens(this.context.instructions.map((instruction) => instruction.content).join("\n")),
          stable: true,
          invalidated: true,
          reason: "accepted repository scan changed project instructions",
        }, this.#currentScope());
      }
    } catch {
      // Safe fallback: keep the stale map omitted. A later observation can retry.
    }
  }

  #invalidateWholeWorkspace(
    reason: string,
    options: { readonly verificationNeutral?: boolean } = {},
  ): void {
    this.#pendingRepositoryDeltaPaths.clear();
    this.#subagentCapsules.clear();
    this.#workspaceGeneration += 1;
    this.kernel.resetProviderContinuation(`workspace generation changed: ${reason}`);
    this.#wholeWorkspaceReadInvalidationGeneration = this.#workspaceGeneration;
    if (options.verificationNeutral !== true) {
      this.#verificationInvalidatingGeneration = this.#workspaceGeneration;
    }
    this.#cacheKey = undefined;
    const invalidation = this.context.invalidateWorkspace(reason);
    const scope = this.#currentScope();
    for (const record of invalidation.evidenceInvalidated) {
      this.#emit("context.evidence_invalidated", {
        evidenceId: record.id,
        reason,
      }, scope);
      this.#emit("evidence.invalidated", {
        evidenceId: record.id,
        reason,
      }, scope);
      this.#emit("context.evidence_rejected", {
        evidenceId: record.id,
        reason: `stale evidence rejected: ${reason}`,
      }, scope);
    }
    this.#emitExcerptEvictions(scope);
  }

  #recordPathMutation(path: string): void {
    this.#pathMutationGenerations.set(this.#canonicalWorkspacePath(path), this.#workspaceGeneration);
    if (this.#pathMutationGenerations.size > 4_096) {
      const oldest = [...this.#pathMutationGenerations.entries()]
        .sort((left, right) => left[1] - right[1])
        .slice(0, this.#pathMutationGenerations.size - 4_096);
      for (const [oldPath, generation] of oldest) {
        this.#pathMutationGenerations.delete(oldPath);
        this.#wholeWorkspaceReadInvalidationGeneration = Math.max(
          this.#wholeWorkspaceReadInvalidationGeneration,
          generation,
        );
      }
    }
    this.#changedPaths.add(path);
    while (this.#changedPaths.size > 256) {
      const oldestChanged = this.#changedPaths.values().next().value;
      if (typeof oldestChanged !== "string") break;
      this.#changedPaths.delete(oldestChanged);
    }
  }

  #invalidateContextPath(path: string, reason: string): void {
    this.#workspaceGeneration += 1;
    this.kernel.resetProviderContinuation(`workspace generation changed: ${reason}`);
    this.#verificationInvalidatingGeneration = this.#workspaceGeneration;
    this.#recordPathMutation(path);
    this.#pendingRepositoryDeltaPaths.add(this.#canonicalWorkspacePath(path));
    // The exact path is known, so keep unrelated repository-map entries and let
    // the bounded delta refresh replace/remove only this path.
    const invalidation = this.context.invalidate(path, reason, { workspaceChanged: false });
    const scope = this.#currentScope();
    for (const record of invalidation.evidenceInvalidated) {
      this.#emit("context.evidence_invalidated", {
        evidenceId: record.id,
        path,
        reason,
      }, scope);
      this.#emit("evidence.invalidated", {
        evidenceId: record.id,
        path,
        reason,
      }, scope);
      this.#emit("context.evidence_rejected", {
        evidenceId: record.id,
        reason: `stale evidence rejected: ${reason}`,
      }, scope);
    }
    this.#emitExcerptEvictions(scope);
  }

  #cachePlanForPrompt(
    assembled: CompiledModelRequest,
    route: InferencePolicyDecision | undefined = this.#currentRoute,
  ): {
    readonly key?: string;
    readonly plan: ReturnType<CachePlanner["plan"]>;
    readonly stableDigestValue: string;
  } {
    const epoch = this.taskEpoch.current();
    const stableDigestValue = assembled.stablePrefixDigest;
    const plan = new CachePlanner({
      maxWritesPerTurn: this.#options.config.model.cache.maxWritesPerTurn,
      minimumReuseProbability: this.#options.config.model.cache.minimumReuseProbability,
    }).plan({
      stablePrefixTokens: assembled.stablePrefixTokens,
      expectedReuseCount: 1,
      invalidationProbability: 0,
      candidateBreakpoints: 1,
      maxWritesPerTurn: this.#options.config.model.cache.maxWritesPerTurn,
      model: route?.capability ?? this.#options.config.model.default,
      mode: this.#options.config.model.cache.mode,
    });
    const key = epoch !== undefined && route !== undefined &&
        (plan.mode === "write" || plan.mode === "read-only")
      ? stableDigest({
          workspaceIdentityDigest: epoch.workspaceIdentityDigest,
          modelCapabilityDigest: route.capability.digest,
          exactStablePrefixDigest: stableDigestValue,
          toolSchemas: assembled.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: tool.strict,
          })),
          permissionTrustContractVersion: "context-p0-v1",
        })
      : undefined;
    return { ...(key !== undefined ? { key } : {}), plan, stableDigestValue };
  }

  /** Cache identity is derived again from the exact request, not mutable callback state. */
  #cacheKeyForPrompt(
    assembled: CompiledModelRequest,
    route: InferencePolicyDecision | undefined = this.#currentRoute,
  ): string | undefined {
    return this.#cachePlanForPrompt(assembled, route).key;
  }

  /** Plan cache + emit manifest/inspector for every exact provider sample. */
  #handleCompiledPrompt(
    assembled: CompiledModelRequest,
    options: {
      readonly route?: InferencePolicyDecision;
      readonly scope?: { turnId?: string; agentId: string; callerId: string; taskEpochId?: string; workspaceIdentityDigest?: string };
      readonly updateRootInspector?: boolean;
      readonly contextBand?: string | number;
      readonly metadata?: {
        readonly requestId: string;
        readonly turnId: string;
        readonly modelId: string;
        readonly interactionMode: "build" | "plan";
      };
    } = {},
  ): void {
    // A directive only counts as delivered once this exact object carries it;
    // child prompts that drop the field leave the root's delivery pending.
    this.#recordTokenSavingDirectiveDelivery(assembled);
    const route = options.route ?? this.#currentRoute;
    const planned = this.#cachePlanForPrompt(assembled, route);
    const scope = options.scope ?? this.#currentScope();
    const packId = assembled.packId;
    const exactContext = selectContextBand(assembled.inputTokens, {
      ...(route !== undefined ? { capability: route.capability } : {}),
      premiumPolicy: route?.context.premium === true && route.context.allowed
        ? "allow"
        : this.#options.config.model.context.premiumBandPolicy,
      reserveOutputTokens: this.#options.config.model.context.reserveOutputTokens,
    });
    if (options.updateRootInspector !== false) {
      this.#currentContextBand = exactContext.band;
      this.#lastCompiledRootHistoryLength = this.kernel.history.length;
    }
    this.#emit("context.plan_created", {
      packId,
      contextBand: exactContext.band,
      requestedTokens: assembled.inputTokens,
      reserveOutputTokens: this.#options.config.model.context.reserveOutputTokens,
      premium: exactContext.premium,
      allowed: exactContext.allowed,
      reason: exactContext.reason,
      utilityGated: this.#options.config.model.context.premiumBandPolicy === "utility-gated",
      evidenceLedger: true,
    }, scope);
    this.#cacheKey = planned.key;
    this.#emit("context.cache_segment", {
      packId,
      segmentId: `stable-${planned.stableDigestValue.slice(0, 16)}`,
      digest: planned.stableDigestValue,
      tokens: assembled.stablePrefixTokens,
      stable: true,
    }, scope);
    this.#emit("cache.plan_created", {
      packId,
      mode: planned.plan.mode,
      stablePrefixTokens: planned.plan.stablePrefixTokens,
      expectedReuseProbability: planned.plan.expectedReuseProbability,
      expectedReadTokens: planned.plan.expectedReadTokens,
      expectedWriteTokens: planned.plan.expectedWriteTokens,
      expectedNetSavingsUsd: planned.plan.expectedNetSavingsUsd,
      reason: planned.plan.reason,
    }, scope);
    this.#emitCompiledPack(
      assembled,
      packId,
      scope,
      options.updateRootInspector !== false,
      exactContext.band,
      options.metadata,
    );
  }

  /** Emit the manifest for the exact prompt object about to reach the provider. */
  #emitCompiledPack(
    assembled: CompiledModelRequest,
    packId: string,
    scope: { turnId?: string; agentId: string; callerId: string; taskEpochId?: string; workspaceIdentityDigest?: string },
    updateRootInspector: boolean,
    contextBand: string | number | undefined,
    metadata?: {
      readonly requestId: string;
      readonly turnId: string;
      readonly modelId: string;
      readonly interactionMode: "build" | "plan";
    },
  ): void {
    const materialized = assembled.contextManifest ?? this.context.lastMaterialization;
    const compilerPackId = assembled.contextManifest?.compilerPackId;
    const compilerManifestDigest = assembled.contextManifest?.compilerManifestDigest;
    if (updateRootInspector) this.#lastCompiledPackId = packId;
    const epoch = this.taskEpoch.current();
    const modelId = metadata?.modelId ?? this.#currentRoute?.model ?? this.#options.config.model.default;
    const modelWindowTokens = this.#currentRoute?.capability.contextWindow ??
      this.#options.config.model.softContextTokens + this.#options.config.model.context.reserveOutputTokens;
    const reserveOutputTokens = this.#options.config.model.context.reserveOutputTokens;
    const budgetTokens = Math.min(
      this.#options.config.model.softContextTokens,
      Math.max(0, modelWindowTokens - reserveOutputTokens),
    );
    const contextUsage = makeContextUsageSnapshot({
      packId,
      ...(metadata?.requestId === undefined ? {} : { requestId: metadata.requestId }),
      ...(metadata?.turnId === undefined ? {} : { turnId: metadata.turnId }),
      modelId,
      budgetTokens,
      modelWindowTokens,
      outputReserveTokens: reserveOutputTokens,
      usedTokens: assembled.inputTokens,
      categories: assembled.usageBreakdown.categories,
      source: "estimated",
    });
    const priorOutputs = assembled.input.flatMap((item) =>
      item.type === "function_call_output" ? [item.output] : []
    );
    let duplicateTokens = 0;
    for (const excerptId of materialized.excerptIds) {
      const exactText = this.context.exactExcerptText(excerptId);
      if (exactText !== undefined && exactText.length > 0 && priorOutputs.some((output) => output.includes(exactText))) {
        duplicateTokens += estimateTokens(exactText);
      }
    }
    const staleEvidenceCount = materialized.rejected.filter((rejection) =>
      /evidence is (?:stale|invalid)|workspace identity mismatch/i.test(rejection.reason)
    ).length;
    this.#emit("context.pack_compiled", {
      packId,
      totalInputTokens: assembled.inputTokens,
      estimatedTokens: assembled.inputTokens,
      stablePrefixTokens: assembled.stablePrefixTokens,
      variableTokens: Math.max(0, assembled.inputTokens - assembled.stablePrefixTokens),
      exactEvidenceTokens: materialized.estimatedTokens,
      excerptTokens: this.context.estimatedTokensForExcerpts(materialized.excerptIds),
      itemIds: [...materialized.evidenceIds, ...materialized.excerptIds],
      evidenceIds: materialized.evidenceIds,
      excerptIds: materialized.excerptIds,
      duplicateTokens,
      staleEvidenceCount,
      rejectedEvidenceCount: materialized.rejected.length,
      contextUsage,
      continuationMode: "client_managed",
      ...(compilerPackId === undefined ? {} : {
        compilerPackId,
        ...(compilerManifestDigest === undefined ? {} : { compilerManifestDigest }),
      }),
    }, scope);
    this.#emit("context.evidence_selected", {
      ...(epoch !== undefined ? { taskEpochId: epoch.id } : {}),
      packId,
      contextBand: contextBand ?? "unknown",
      evidenceIds: materialized.evidenceIds,
      excerptIds: materialized.excerptIds,
      rejected: materialized.rejected,
      omitted: materialized.omitted,
    }, scope);
    for (const rejection of materialized.rejected) {
      this.#emit("context.evidence_rejected", {
        evidenceId: rejection.id,
        reason: rejection.reason,
        packId,
      }, scope);
    }
    if (updateRootInspector) {
      this.#lastContextInspection = this.context.inspect({
        activeSkills: this.skills.promptCatalog(),
        loadedSkillBodies: [...this.#loadedSkills.values()].map((definition) => ({
          name: definition.manifest.name,
          body: definition.body,
        })),
        toolSchemaIds: assembled.tools.map((tool) => tool.name),
        stablePrefixText: assembled.stablePrefixText,
        ...(this.#compactState !== undefined ? { compactState: this.#compactState } : {}),
        ...(this.#taskDescription !== undefined
          ? { taskText: this.#taskDescription, userInput: this.#taskDescription }
          : {}),
        historyText: assembled.serializedInput,
        reasoningItemCount: assembled.input.filter((item) => item.type === "reasoning").length,
        repositoryText: this.#lastRepositoryContext.join("\n\n"),
        cachePrefixFingerprint: assembled.stablePrefixDigest,
        compiledPackId: packId,
        compiledInputTokens: assembled.inputTokens,
        layerTokenCounts: assembled.layerTokens,
        activeExcerptIds: materialized.excerptIds,
      });
    }
    // Release only after this exact object has captured the leased ranges.
    this.context.markPromptCompiled(materialized.excerptIds, scope.agentId ?? "root");
    this.#emitExcerptEvictions(scope);
  }

  #emitExcerptEvictions(
    scope: { turnId?: string; agentId: string; callerId: string; taskEpochId?: string; workspaceIdentityDigest?: string },
  ): void {
    for (const eviction of this.context.drainEvictions()) {
      this.#emit("context.item_evicted", {
        itemId: eviction.id,
        excerptId: eviction.id,
        estimatedTokens: eviction.estimatedTokens,
        reason: eviction.reason,
      }, scope);
    }
  }

  /** Compact the prompt history when it reaches the effective input budget. */
  async #artifactizeAccumulatedOutputs(
    outputs: readonly Extract<ModelInputItem, { type: "function_call_output" }>[],
  ): Promise<void> {
    const replacements = new Map<string, string>();
    for (const item of outputs) {
      if (/\[artifact [^\]\n]+\]/.test(item.output)) continue;
      const artifact = await this.executor.spill(`compaction-${item.callId}.log`, item.output);
      if (artifact === undefined) continue;
      replacements.set(
        item.callId,
        `Output externalized before sampling: [artifact ${artifact.id} sha256:${artifact.digest} ${artifact.bytes} bytes; use artifact.read with this digest]`,
      );
      this.context.recordArtifactHandle(artifact, `tool output ${item.callId}`);
    }
    if (replacements.size === 0) return;
    this.kernel.hydrateHistory(this.kernel.history.map((item) =>
      item.type === "function_call_output" && replacements.has(item.callId)
        ? { ...item, output: replacements.get(item.callId)! }
        : item));
  }

  compactContext(options: { userRequested?: boolean; toolOutputAccumulation?: boolean } = {}): CompactionResult | undefined {
    if (this.#compacting) return undefined;
    // Token saving moves only the local soft-budget trigger; the journal and
    // the provider-native threshold stay exactly where they were.
    const savingPlan = this.#tokenSavingResolve(this.#tokenSavingPhase());
    const trigger = shouldCompact(this.recorder.model, {
      ...options,
      softBudgetRatio: savingPlan.localCompactionRatio,
    }) ??
      (options.toolOutputAccumulation === true ? "tool_output_accumulation" : undefined);
    if (trigger === undefined) return undefined;

    this.#compacting = true;
    try {
      const result = compact(this.recorder.model, trigger, estimateTokens, {
        reflections: this.context.reflections.map((reflection) => ({
          toolId: reflection.toolId,
          category: reflection.category,
          rootCause: reflection.rootCause,
          correctiveAction: reflection.correctiveAction,
          paths: [...reflection.paths],
        })),
      });
      const state = renderCompactState(result.state);
      this.#compactState = state;
      // The journal retains every event; only the provider-facing replay is
      // shortened. This is what prevents old tool output from being paid again
      // on every sample after compaction.
      this.kernel.hydrateHistory(retainHistoryForPrompt(
        this.kernel.history,
        this.#lastCompiledRootHistoryLength,
      ));
      // Hydration drops provider continuation, so the next full replay must
      // restate the saving directive from scratch.
      this.#tokenSaving.resetDirectiveTracking();
      this.#lastCompiledRootHistoryLength = Math.min(
        this.#lastCompiledRootHistoryLength,
        this.kernel.history.length,
      );
      this.#pruneReadFreshnessState();
      this.#lastToolOutputCompactionHistoryLength = this.kernel.history.length;
      this.kernel.resetProviderContinuation();
      this.#emit("session.compacted", {
        trigger: result.trigger,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        eventsSummarized: result.eventsSummarized,
        compactState: state,
      });
      return result;
    } finally {
      this.#compacting = false;
    }
  }

  get todo(): ReturnType<TodoController["current"]> {
    return this.#todoController.current();
  }

  get planReadiness() {
    return this.#todoController.readiness();
  }

  get planApproval(): PlanApproval | undefined {
    return this.#todoController.current().approval;
  }

  writeTodo(input: {
    readonly expectedRevision: number;
    readonly items: readonly PlanItem[];
    readonly reason: string;
    readonly source: "model" | "user" | "migration";
    readonly document?: PlanDocument;
    readonly clearDocument?: boolean;
  }): ReturnType<TodoController["replace"]> {
    return this.#todoController.replace(input);
  }

  approveTodo(
    via: "shift_tab" | "slash" | "ui",
    contextStrategy: PlanContextStrategy = "keep",
  ): ReturnType<TodoController["approve"]> {
    return this.#todoController.approve(this.#todoController.current().revision, via, contextStrategy);
  }

  /** Build the exact scope ceiling used by the permission broker for one execution. */
  approvedPlanScope(): ApprovedPlanScope | undefined {
    const state = this.#todoController.current();
    const approval = state.approval;
    const digest = this.#todoController.digest();
    if (approval === undefined || digest === undefined || approval.digest !== digest || this.#planExecution === undefined) return undefined;
    const files = new Map<string, { path: string }>();
    for (const anchor of state.document?.criticalFiles ?? []) files.set(anchor.path, { path: anchor.path });
    for (const item of state.items) for (const path of item.files ?? []) files.set(path, { path });
    const externalActions = (state.document?.externalActions ?? []).map((entry) => ({
      server: entry.server,
      tool: entry.tool,
      ...(entry.arguments === undefined ? {} : { argumentsHash: canonicalDigest(entry.arguments) }),
    }));
    const commandTexts = [
      ...state.items.flatMap((item) => item.commands ?? []),
      ...(state.document?.verification ?? []).flatMap((check) => check.command === undefined ? [] : [check.command]),
    ];
    const commands = commandTexts.flatMap((text) => {
      const parsed = parsePlanCommand(text, this.#options.workspacePath);
      if (parsed === undefined) return [];
      const network = classifyCommand(parsed).network;
      return [network ? { ...parsed, network: true } : parsed];
    });
    return normalizeApprovedPlanScope({
      digest,
      workspaceRoot: this.#options.workspacePath,
      ...(files.size > 0 ? { files: [...files.values()] } : {}),
      ...(commands.length > 0 ? { commands } : {}),
      ...(externalActions.length > 0 ? { externalActions } : {}),
    });
  }

  /** Execute an already-approved contract without changing its approval metadata. */
  async executeApprovedPlan(
    via: "shift_tab" | "slash" | "ui" = "shift_tab",
  ): Promise<{ readonly ok: true; readonly directive: string; readonly state: ReturnType<TodoController["current"]> } | { readonly ok: false; readonly message: string; readonly blockers?: readonly string[] }> {
    const state = this.#todoController.current();
    const readiness = this.#todoController.readiness();
    if (!readiness.ready) return { ok: false, message: "Plan is not ready for execution", blockers: readiness.blockers };
    if (state.approval === undefined || !this.#todoController.approvalValid()) return { ok: false, message: "Plan has not been approved; choose Yes, proceed in the Plan prompt first" };
    this.#planExecution = { digest: state.approval.digest, contextStrategy: state.approval.contextStrategy };
    const mode = await this.requestInteractionMode("build", via === "ui" || via === "shift_tab" ? "key" : "slash");
    if (mode.kind !== "applied" && this.recorder.model.modeState.selected !== "build") {
      this.#planExecution = undefined;
      return { ok: false, message: "Build mode could not be installed; resolve quiescence blockers first" };
    }
    if (state.approval.contextStrategy === "compact") this.compactContext({ userRequested: true });
    return {
      ok: true,
      state,
      directive: [
        "HOST EXECUTION DIRECTIVE: execute the explicitly approved Plan Contract now.",
        `Approved digest: ${state.approval.digest}`,
        "Only use files, exact commands, and external actions declared by this digest-bound Plan scope.",
        "Update each Plan step with progress and evidence; run the declared verification before reporting completion.",
      ].join("\n"),
    };
  }

  /** Prepare a digest-bound Build turn; ordinary mode changes cannot call this implicitly. */
  async preparePlanExecution(
    contextStrategy: PlanContextStrategy = "keep",
    via: "shift_tab" | "slash" | "ui" = "slash",
  ): Promise<{ readonly ok: true; readonly directive: string; readonly state: ReturnType<TodoController["current"]> } | { readonly ok: false; readonly message: string; readonly blockers?: readonly string[] }> {
    const approval = this.approveTodo(via, contextStrategy);
    if (!approval.ok) return { ok: false, message: approval.message, ...(approval.blockers === undefined ? {} : { blockers: approval.blockers }) };
    if (approval.state.approval?.contextStrategy !== contextStrategy) {
      // The explicit execute choice is also the place where a user may switch
      // the provider-facing strategy without mutating the approved scope.
      const state = this.#todoController.current();
      const approved = this.#todoController.approve(state.revision, via, contextStrategy);
      if (!approved.ok) return { ok: false, message: approved.message };
    }
    return await this.executeApprovedPlan(via === "slash" ? "slash" : via);
  }

  async requestInteractionMode(target: InteractionMode, source: ModeChangeSource): Promise<ReturnType<typeof requestModeChange>> {
    const model = this.recorder.model;
    // Build is an execution boundary. A plain /mode build or Shift+Tab may not
    // turn a drafted Plan into an execution contract; only preparePlanExecution can.
    if (target === "build" && model.modeState.selected === "plan" && this.#planExecution === undefined && (this.#todoController.current().document !== undefined || this.#todoController.current().items.length > 0)) {
      this.#emit("error.internal", { code: "PLAN_EXECUTE_REQUIRED", message: "Review the Plan and choose Yes, proceed before switching to Build mode." }, this.#currentScope());
      return { kind: "unchanged", state: model.modeState };
    }
    const activity = {
      turnRunning: model.modeState.activeTurn !== undefined ||
        ["preparing", "sampling", "tool_selection", "awaiting_approval", "executing", "observing", "verifying"].includes(model.turnStatus),
      activeWriteTools: model.activeTools.filter((tool) => this.registry.get(tool.toolId)?.mutates === true).length,
      activeProcesses: model.activeJobs.map((job) => job.jobId),
      activeTransactions: [],
      activeWriterSubagents: model.activeTasks.filter((task) => task.role === "executor" || task.role === "refactorer").map((task) => task.taskId),
      pendingApprovals: model.pendingApproval === undefined ? [] : [model.pendingApproval.approvalId],
    };
    const result = requestModeChange(model.modeState, { target, source }, activity);
    if (result.kind === "unchanged") return result;
    if (target === "plan" && this.#options.beforeInteractionMode !== undefined) {
      try {
        await this.#options.beforeInteractionMode(target);
      } catch (error) {
        this.#emit("error.internal", { code: "MODE_SYNC_FAILED", message: error instanceof Error ? error.message : String(error) }, this.#currentScope());
        return { kind: "unchanged", state: model.modeState };
      }
    }
    if (result.kind === "applied" && typeof this.#options.runtime.setInteractionMode === "function") {
      try {
        await this.#options.runtime.setInteractionMode(target);
      } catch (error) {
        this.#emit("error.internal", { code: "MODE_SYNC_FAILED", message: error instanceof Error ? error.message : String(error) }, this.#currentScope());
        return { kind: "unchanged", state: model.modeState };
      }
    }
    const effectiveAt = result.kind === "applied" ? "immediate" : activity.activeProcesses.length > 0 || activity.activeWriterSubagents.length > 0 || activity.pendingApprovals.length > 0 ? "after_quiescence" : "next_turn";
    this.#emit("mode.changed", {
      from: model.modeState.selected,
      to: target,
      source,
      effectiveAt,
      revision: result.state.revision,
      ...(result.state.blockers === undefined ? {} : { blockers: result.state.blockers }),
    });
    if (result.kind === "applied") {
      this.registry.setInteractionMode(target);
      // Moving back to Plan is an explicit return to review. Do not let a
      // cancelled Build turn's execution capability survive that choice.
      if (target === "plan") this.#planExecution = undefined;
    }
    return result;
  }

  async #executeTodoWrite(action: ProposedAction): Promise<import("./tools.ts").Execution> {
    const input = action.arguments;
    const expectedRevision = input.expectedRevision;
    const reason = input.reason;
    const rawItems = input.items;
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      typeof reason !== "string" ||
      !Array.isArray(rawItems)
    ) {
      return { result: errorResult("TODO_INVALID_INPUT", "todo.write requires expectedRevision, reason, and items") };
    }
    const items = rawItems.filter((item): item is PlanItem =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).text === "string" &&
      typeof (item as Record<string, unknown>).status === "string",
    );
    if (items.length !== rawItems.length) {
      return { result: errorResult("TODO_INVALID_INPUT", "todo.write contains a malformed item") };
    }
    const document = isRecord(input.document) ? input.document as unknown as PlanDocument : undefined;
    // Build-mode schemas omit `document`, but a provider can replay a stale
    // schema or emit an extra field. Ignore only that field so an ordinary TODO
    // update does not create a rejected-mutation marker. The TodoController
    // still refuses direct Build-mode Plan Contract drafts.
    const ignoredBuildModeDocument = document !== undefined && this.recorder.model.modeState.selected === "build";
    const result = this.#todoController.replace({
      expectedRevision,
      items,
      reason,
      source: "model",
      ...(document === undefined || ignoredBuildModeDocument ? {} : { document }),
    });
    if (!result.ok) {
      const recoveryState = {
        expectedRevision: result.currentRevision,
        items: result.state.items,
        ...(result.state.document === undefined ? {} : { document: result.state.document }),
      };
      return {
        result: errorResult(result.code, result.message, {
          retryable: result.code === "TODO_REVISION_CONFLICT",
          details: { currentRevision: result.currentRevision, currentState: result.state },
        }),
        text: result.code + ": " + result.message + "\nCurrent TODO state (use this expectedRevision and preserve item scope):\n" + JSON.stringify(recoveryState),
      };
    }
    return {
      result: okResult(
        `TODO updated to revision ${result.state.revision}${ignoredBuildModeDocument ? "; Build mode ignored the structured Plan Contract field" : ""}`,
        result.state,
      ),
      text: `${ignoredBuildModeDocument ? "Build mode ignored the structured Plan Contract field; ordinary TODO items were saved.\n" : ""}${JSON.stringify(result.state)}`,
    };
  }

  /**
   * 짠6.11: stop waiting on a subagent from the keyboard.
   *
   * The wait is interrupted, not the child ??the subagent keeps running and the
   * timeline records `task.await_interrupted`. Returns false when nothing is
   * actually waiting on the task, so the UI reports the no-op honestly.
   */
  interruptTaskWait(taskId: string): boolean {
    return this.#subagentBridge.interruptAwait(taskId);
  }

  /** Cancel a specific subagent task and abort its execution. */
  async cancelTask(taskId: string, reason?: string): Promise<void> {
    await this.#subagentBridge.cancelTask(taskId, reason);
  }

  /** Cancel all running subagents and abort their executions. */
  async cancelAllTasks(reason?: string): Promise<void> {
    await this.#subagentBridge.cancelAllTasks(reason);
  }

  /** Apply an interactive effort choice to this session immediately. */
  setReasoningEffort(effort: ReasoningEffort): void {
    this.kernel.setReasoningEffort(effort);
    // Keep the effective config in sync for code that reads the live session
    // settings (the persisted user config is written by the slash-command router).
    this.#options.config.model.reasoningEffort = effort;
  }

  /** The requested token-saving level and the most recently applied plan. */
  get tokenSaving(): {
    readonly requestedLevel: TokenSavingLevel;
    readonly plan: ResolvedTokenSavingPlan | undefined;
  } {
    return {
      requestedLevel: this.#tokenSaving.requestedLevel,
      plan: this.#tokenSavingLastPlan,
    };
  }

  /**
   * Apply an interactive token-saving choice to this session immediately.
   *
   * The level takes effect from the next provider sample on: the context
   * budget, compaction ratio, directive, and response style are all resolved
   * per sample. The persisted user config is written by the caller.
   */
  setTokenSaving(
    level: TokenSavingLevel,
    source: "slash" | "config" | "benchmark" = "slash",
  ): { from: TokenSavingLevel; to: TokenSavingLevel } | undefined {
    const transition = this.#tokenSaving.setRequestedLevel(level);
    if (transition === undefined) return undefined;
    this.#options.config.agent.tokenSaving = level;
    this.#emit("token_saving.changed", {
      from: transition.from,
      to: transition.to,
      source,
    }, this.#currentScope());
    return transition;
  }

  /**
   * The work phase used for token-saving resolution this moment. The runtime
   * only ever samples in investigate/edit/verify, which is also exactly the
   * subset the context pack compiler accepts as a phase.
   */
  #tokenSavingPhase(): "investigate" | "edit" | "verify" {
    const task = this.#taskDescription ?? "";
    if (/(?:test|verify|validation|check)/iu.test(task)) return "verify";
    return this.#changedPaths.size > 0 ? "edit" : "investigate";
  }

  /** Explicit user requests for detail suspend response conciseness only. */
  #explicitDetailedResponse(): boolean {
    const task = this.#taskDescription ?? "";
    return /상세(?:히|하게)?|자세(?:히|하게)?|심층(?:적(?:으로)?)?|심도\s*있게|엄격(?:하게)?|철저(?:하게)?|근본\s*원인|해결\s*방안|전체\s*분석|정밀\s*분석|단계별로|\b(?:deep|in-depth|thorough|rigorous)\s+analysis\b|\broot[ -]cause\b|\bexplain(?:\s+in\s+detail)?\b|\bstep[ -]by[ -]step\b|\bfull analysis\b|\bshow (?:me )?why\b/iu.test(task);
  }

  /**
   * Resolve the effective saving plan for one sample, reusing the repository's
   * deterministic change-risk assessment rather than a second classifier.
   * Repair cycles relax the level through the resolver, not the risk score,
   * so a recovery sample is never counted twice.
   */
  #tokenSavingResolve(phase: TokenSavingPhase): ResolvedTokenSavingPlan {
    const files = [...this.recorder.model.changedFiles.entries()].map(
      ([path, counts]) => ({
        path,
        additions: counts.additions,
        deletions: counts.deletions,
      }),
    );
    const risk = assessChangeRisk({
      files,
      workspaceMutated: files.length > 0,
    });
    const plan = resolveTokenSavingPlan({
      requestedLevel: this.#tokenSaving.requestedLevel,
      phase,
      risk: risk.level,
      riskReasons: risk.reasons,
      repairCycles: this.context.reflections.length,
      continuationRecovery: this.#tokenSavingContinuationRecovery,
      explicitDetailedResponse: this.#explicitDetailedResponse(),
    });
    this.#tokenSavingLastPlan = plan;
    return plan;
  }

  /**
   * The directive the next compiled prompt should carry, if any.
   *
   * Pure peek: delivery is confirmed only when a compiled prompt actually
   * contains the directive (see `#recordTokenSavingDirectiveDelivery`), so a
   * child prompt that drops the field cannot consume the parent's directive.
   */
  #tokenSavingDirectiveForPrompt(): string | undefined {
    const mode = this.#options.config.provider.openai.transport === "http_full"
      ? "full_replay" as const
      : "continuation" as const;
    const plan = this.#tokenSavingResolve(this.#tokenSavingPhase());
    return this.#tokenSaving.peekDirective(plan, mode);
  }

  /** Confirm delivery once a compiled prompt demonstrably carries the directive. */
  #recordTokenSavingDirectiveDelivery(assembled: CompiledModelRequest): void {
    if (!assembled.serializedInput.includes("Host token-saving directive")) return;
    const included = this.#tokenSavingDirectiveForPrompt();
    if (included !== undefined) this.#tokenSaving.noteDirectiveIncluded(included);
  }

  /** Journal the effective policy for turn reproducibility (§18.2). */
  #emitTokenSavingPolicy(plan: ResolvedTokenSavingPlan): void {
    const soft = Math.max(0, this.#options.config.model.softContextTokens);
    this.#emit("token_saving.policy_applied", {
      requestedLevel: plan.requestedLevel,
      effectiveLevel: plan.effectiveLevel,
      ponytail: plan.ponytail,
      targetInputTokens: Math.floor(soft * plan.targetInputRatio),
      explorationCeiling: Math.floor(soft * plan.explorationRatio),
      localCompactionRatio: plan.localCompactionRatio,
      responseStyle: plan.responseStyle,
      reasons: [...plan.reasons],
    }, this.#currentScope());
    if (plan.effectiveLevel !== plan.requestedLevel) {
      this.#emit("token_saving.relaxed", {
        requestedLevel: plan.requestedLevel,
        effectiveLevel: plan.effectiveLevel,
        reasons: [...plan.reasons],
      }, this.#currentScope());
    }
  }

  /**
   * 짠13.3's policy inputs, rebuilt on every evaluation.
   *
   * Rebuilding rather than caching matters: a rule granted mid-turn has to apply to
   * the very next call in the same batch, and `--read-only` has to keep applying
   * even if the model asks again.
   */
  #permissionPreset: PermissionPreset | undefined;

  get permissionPreset(): PermissionPreset | undefined {
    return this.#permissionPreset;
  }

  setPermissionPreset(preset: PermissionPreset): void {
    const from = this.#permissionPreset ?? this.#options.config.permissions.preset;
    this.#permissionPreset = preset;
    this.#options.config.permissions.preset = preset;
    const effective = resolvePermissionPolicy(preset, {
      projectWrite: this.#options.config.permissions.projectWrite,
      shell: this.#options.config.permissions.shell,
      network: this.#options.config.permissions.network,
      destructive: this.#options.config.permissions.destructive,
      credentials: this.#options.config.permissions.credentials,
      externalSideEffect: this.#options.config.permissions.externalSideEffect,
    }, this.#options.config.agent.permissionMode);
    this.#emit("permission.changed" as never, {
      from,
      to: preset,
      selectedPreset: effective.selectedPreset,
      effectiveKind: effective.effectiveKind,
      restrictions: effective.restrictions,
      policyDigest: effective.digest,
      scope: "session",
      source: "slash",
    } as never, this.#currentScope() as never);
  }

  permissionContext(): PermissionContext {
    const config = this.#options.config;
    const modeState = this.recorder.model.modeState;
    const interactionMode: InteractionMode = modeState.activeTurn ?? modeState.selected;
    const planState = this.#todoController.current();
    const approvedPlan = this.approvedPlanScope();
    return {
      mode: config.agent.permissionMode,
      interactionMode,
      // Ordinary TODOs are progress tracking, not execution contracts. Only
      // a structured Plan document creates the digest-bound approval boundary.
      planExecutionRequired: planState.document !== undefined,
      planExecutionActive: this.#planExecution !== undefined,
      workspaceRoot: this.#options.workspacePath,
      ...(approvedPlan === undefined ? {} : { approvedPlan }),
      ...(this.#permissionPreset !== undefined ? { preset: this.#permissionPreset } : {}),
      effectivePolicy: resolvePermissionPolicy(this.#permissionPreset ?? config.permissions.preset, { projectWrite: config.permissions.projectWrite, shell: config.permissions.shell, network: config.permissions.network, destructive: config.permissions.destructive, credentials: config.permissions.credentials, externalSideEffect: config.permissions.externalSideEffect }, config.agent.permissionMode),
      // AUTO direct executables require proof from the live runtime. A config
      // default alone is not evidence that a sandbox was actually installed.
      sandboxEnforceable: this.#options.runtime.capabilities?.sandboxLevel !== undefined
        ? this.#options.runtime.capabilities.sandboxLevel !== "none"
        : false,
      trust: this.#options.trust,
      rules: [...(this.#options.configRules ?? []), ...this.#options.granted.all],
      catalog: this.registry.all(),
      agentRole: "root",
      nonInteractive: this.#options.nonInteractive,
      ...(this.#options.readOnly === true ? { readOnly: true } : {}),
      ...(this.#options.headlessPolicy !== undefined
        ? { headlessPolicy: this.#options.headlessPolicy }
        : {}),
      configPermissions: {
        projectWrite: config.permissions.projectWrite,
        shell: config.permissions.shell,
        network: config.permissions.network,
        destructive: config.permissions.destructive,
        credentials: config.permissions.credentials,
        externalSideEffect: config.permissions.externalSideEffect,
      },
    };
  }

  /**
   * 짠11.9 / P0-12: the independent review is a fresh provider call with its own
   * context ??it sees only the diff summary, not the reasoning that produced it.
   * The reviewer is asked for a strict JSON verdict; a response that cannot be
   * parsed is treated as "no findings" but keeps the reviewer's own words, so a
   * broken review never masquerades as a clean one and never throws the turn.
   */
  async #reviewMaterial(paths: readonly string[], signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("review material request was cancelled");
    const raw = await this.#options.runtime.gitDiff({ paths: [...paths] });
    if (signal.aborted) throw new Error("review material request was cancelled");
    if (typeof raw !== "object" || raw === null || !("files" in raw)) {
      throw new Error("runtime returned a malformed git diff");
    }
    const files = (raw as {
      readonly files?: readonly {
        readonly path?: unknown;
        readonly patch?: unknown;
        readonly additions?: unknown;
        readonly deletions?: unknown;
      }[];
    }).files;
    if (!Array.isArray(files)) throw new Error("runtime git diff omitted files");
    const rendered = files.map((file) => {
      const path = typeof file.path === "string" ? file.path : "<unknown>";
      const additions = typeof file.additions === "number" ? file.additions : 0;
      const deletions = typeof file.deletions === "number" ? file.deletions : 0;
      const patch = typeof file.patch === "string" ? file.patch : "";
      return `### ${path} (+${additions} -${deletions})\n${patch}`;
    }).join("\n\n");
    const limit = 64 * 1_024;
    return rendered.length <= limit
      ? rendered
      : rendered.slice(0, limit) + "\n\n[diff truncated at 64 KiB]";
  }

  /** Independent provider call over the bounded material above. */
  async #independentReview(diffSummary: string, signal: AbortSignal): Promise<ReviewOutcome> {
    const config = this.#options.config;
    const prompt = [
      "You are an independent code reviewer. You did not write this change and you have no context beyond what is shown.",
      "Review the following change summary for correctness, safety, and obvious regressions.",
      "Respond with ONLY a JSON object of the exact shape:",
      '{"summary":"...","findings":[{"severity":"critical|high|medium|low","title":"...","evidence":"...","recommendation":"..."}]}',
      "If there are no problems, return an empty findings array.",
      "",
      "Change summary:",
      diffSummary,
    ].join("\n");

    let text = "";
    try {
      const stream = this.#options.provider.stream(
        {
          requestId: `review_${this.#options.sessionId}_${Date.now().toString(36)}`,
          model: config.model.default,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
          tools: [],
          reasoning: {
            mode: config.model.reasoningMode,
            effort: config.model.reasoningEffort,
            summary: "none",
            context: "current_turn",
          },
          maxOutputTokens: Math.max(1024, Math.min(8192, config.model.maxOutputTokens)),
          store: false,
        },
        signal,
      );
      for await (const event of stream) {
        if (event.type === "text.delta") text += event.text;
        if (event.type === "response.failed") {
          throw new Error(`provider review failed: ${event.error.message}`);
        }
        if (event.type === "response.incomplete") {
          throw new Error(`provider review was incomplete: ${event.reason}`);
        }
      }
    } catch (error) {
      throw new Error(
        `independent review could not run: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    return parseReviewOutcome(text);
  }

  /**
   * Associate the startup's live repository walk with this session. A cached map
   * may paint immediately, but the first provider sample waits for this live
   * promotion (or performs a fallback scan) before compiling L6 evidence.
   */
  trackRepositoryRefresh(refresh: Promise<unknown>): void {
    const tracked = refresh.then(
      () => undefined,
      () => undefined,
    );
    this.#repositoryRefresh = tracked;
    void tracked.then(() => {
      if (this.#repositoryRefresh === tracked) this.#repositoryRefresh = undefined;
    });
  }

  async #ensureRepositoryMapFresh(): Promise<void> {
    if (!this.context.repositoryMapDirty) return;
    const pending = this.#repositoryRefresh;
    if (pending !== undefined) await pending;
    if (this.context.repositoryMapDirty) await this.#refreshRepositoryMap();
  }

  /** Generation token used to reject out-of-order background repository scans. */
  get workspaceGeneration(): number {
    return this.#workspaceGeneration;
  }

  ingestRepositoryScan(scan: RepositoryScan, expectedGeneration: number): boolean {
    if (expectedGeneration !== this.#workspaceGeneration) return false;
    if (scan.truncated === true) {
      this.#lastRepositoryScanPaths = [...new Set([
        ...this.#lastRepositoryScanPaths,
        ...scan.files.map((file) => file.path),
      ])];
    } else {
      this.#lastRepositoryScanPaths = scan.files.map((file) => file.path);
    }
    this.context.ingestScan(scan);
    return true;
  }

  ingestRepositoryDelta(delta: RepositoryDelta, expectedGeneration: number): boolean {
    if (expectedGeneration !== this.#workspaceGeneration) return false;
    this.#lastRepositoryScanPaths = [...new Set([
      ...this.#lastRepositoryScanPaths,
      ...delta.files.map((file) => file.path),
    ])];
    this.context.ingestRepositoryDelta(delta);
    return true;
  }

  /** Read-only inspector of the exact most recently compiled provider pack. */
  /** Bounded freshness-state counts exposed for health checks and long-session regression tests. */
  freshnessStateStats(): { readonly readCalls: number; readonly mutatedPaths: number } {
    return Object.freeze({
      readCalls: this.#readObservationGenerations.size,
      mutatedPaths: this.#pathMutationGenerations.size,
    });
  }

  inspectContext(): ContextInspection {
    if (this.#lastContextInspection !== undefined) {
      return structuredClone(this.#lastContextInspection);
    }
    return this.context.inspect({
      activeSkills: this.skills.promptCatalog(),
      loadedSkillBodies: this.#skillBodiesForPrompt().map((skill) => ({
        name: skill.name,
        body: skill.body,
      })),
      toolSchemaIds: this.registry.activeIds(),
      ...(this.#compactState !== undefined ? { compactState: this.#compactState } : {}),
      ...(this.#taskDescription !== undefined
        ? { taskText: this.#taskDescription, userInput: this.#taskDescription }
        : {}),
      historyText: JSON.stringify(this.kernel.history),
      reasoningItemCount: this.kernel.history.filter((item) => item.type === "reasoning").length,
      repositoryText: this.#lastRepositoryContext.join("\n\n"),
    });
  }

  #pathMutationGenerationFor(path: string): number {
    const segments = path.split("/").filter(Boolean);
    let latest = 0;
    for (let length = 1; length <= segments.length; length += 1) {
      latest = Math.max(latest, this.#pathMutationGenerations.get(segments.slice(0, length).join("/")) ?? 0);
    }
    return latest;
  }

  #pruneReadFreshnessState(): void {
    const retainedCalls = new Set(this.kernel.history.flatMap((item) =>
      item.type === "function_call" ? [item.callId] : []));
    for (const callId of [...this.#readObservationGenerations.keys()]) {
      if (!retainedCalls.has(callId)) this.#readObservationGenerations.delete(callId);
    }
    if (this.#readObservationGenerations.size === 0) {
      this.#pathMutationGenerations.clear();
      return;
    }
    const oldest = Math.min(...[...this.#readObservationGenerations.values()].map((entry) => entry.generation));
    for (const [path, generation] of this.#pathMutationGenerations) {
      if (generation <= oldest) this.#pathMutationGenerations.delete(path);
    }
  }

  /**
   * Compile the parent's durable evidence index into a child-specific capsule.
   * Only fresh exact records whose concrete path is inside the task boundary are
   * referenced; raw evidence text remains in the parent store and the child can
   * read permitted source through its own executor.
   */
  #createSubagentContextCapsule(childContext: ChildRunContext): TaskContextCapsule {
    const allowedPaths = childContext.task.allowedPaths.length > 0
      ? [...childContext.task.allowedPaths]
      : ["."];
    const forbiddenPaths = [...childContext.task.forbiddenPaths];
    const cached = this.#subagentCapsules.get(childContext.instance.id);
    if (cached?.generation === this.#workspaceGeneration) {
      const validation = this.#validateSubagentCapsule(cached.capsule);
      if (validation.valid) return cached.capsule;
      this.#subagentCapsules.delete(childContext.instance.id);
    }

    const selected = this.context.selectEvidence({ limit: 64, requireFresh: true });
    const records = selected.records.filter((record) => {
      if (record.kind !== "file_excerpt") return false;
      const path = evidenceRecordPath(record);
      return path !== undefined &&
        !isSensitivePath(path) &&
        pathAllowedForTask(path, allowedPaths, forbiddenPaths);
    });
    const byId = new Map(records.map((record) => [record.id, record]));
    const bodyBudget = Math.floor(Math.max(0, childContext.instance.budget.softContextTokens) * 0.7);
    let bodyTokens = 0;
    const scopedExactExcerpts: ScopedExactExcerpt[] = [];
    const bodyCandidates = records.flatMap((record): ScopedExactExcerpt[] => {
        const rawExcerptId = record.metadata?.excerptId;
        if (typeof rawExcerptId !== "string") return [];
        const descriptor = this.context.exactExcerptDescriptor(rawExcerptId);
        if (descriptor === undefined || isSensitivePath(descriptor.path)) return [];
        const identity = {
          evidenceId: record.id,
          excerptId: descriptor.id,
          path: descriptor.path,
          checksum: descriptor.checksum,
          startLine: descriptor.startLine,
          endLine: descriptor.endLine,
        };
        return [{
          ...identity,
          body: descriptor.text,
          identityDigest: scopedExactExcerptIdentityDigest(identity),
          bodyDigest: scopedExactExcerptBodyDigest(descriptor.text),
        }];
      });
    const uniqueBodyCandidates = [...new Map(bodyCandidates.map((candidate) => [candidate.excerptId, candidate])).values()]
      .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.excerptId.localeCompare(right.excerptId));
    for (const candidate of uniqueBodyCandidates) {
      const candidateTokens = estimateTokens(candidate.body);
      if (bodyTokens + candidateTokens > bodyBudget) continue;
      scopedExactExcerpts.push(candidate);
      bodyTokens += candidateTokens;
    }
    const createdAt = new Date(
      this.#options.now?.() ?? this.#options.host.now(),
    ).toISOString();
    const epoch = this.taskEpoch.current();
    const capsule = createTaskContextCapsule({
      taskId: childContext.instance.id,
      role: childContext.instance.role,
      ...(epoch !== undefined ? { workspaceIdentity: epoch.workspaceIdentityDigest } : {}),
      contract: {
        goal: childContext.task.goal,
        deliverable: childContext.task.expectedOutput.length > 0
          ? childContext.task.expectedOutput.join("; ")
          : childContext.task.title,
        allowedPaths,
        ...(forbiddenPaths.length > 0 ? { forbiddenPaths } : {}),
        forbiddenActions: [
          "task.spawn",
          ...(!childContext.instance.permissions.canWrite ? ["workspace.write"] : []),
          ...(!childContext.instance.permissions.canRunProcess ? ["process.run"] : []),
        ],
      },
      symbols: [],
      evidenceRefs: records.map((record) => ({
        id: record.id,
        digest: record.digest,
        locator: record.locator,
        observedAt: record.observedAt,
        freshness: record.freshness,
      })),
      ...(scopedExactExcerpts.length > 0 ? { scopedExactExcerpts } : {}),
      memoryHandles: [],
      parentDecisions: this.recorder.model.todo.items
        .filter((step) => step.status !== "done")
        .map((step) => step.text),
      budget: {
        inputTokens: childContext.instance.budget.softContextTokens,
        outputTokens: this.#options.config.model.maxOutputTokens,
        toolCalls: childContext.instance.budget.maxToolCalls,
      },
      createdAt,
    });
    const validation = validateTaskContextCapsule(capsule, {
      now: createdAt,
      resolveEvidence: (id) => {
        const record = byId.get(id as `evidence-${string}`);
        return record === undefined
          ? undefined
          : { id: record.id, digest: record.digest, freshness: record.freshness };
      },
    });
    if (!validation.valid) {
      throw new Error(`invalid subagent context capsule: ${validation.issues.join("; ")}`);
    }
    if (this.#subagentCapsules.size >= 256) {
      const oldest = this.#subagentCapsules.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#subagentCapsules.delete(oldest);
    }
    this.#subagentCapsules.set(childContext.instance.id, {
      generation: this.#workspaceGeneration,
      capsule,
    });
    return capsule;
  }

  #validateSubagentCapsule(capsule: TaskContextCapsule): ReturnType<typeof validateTaskContextCapsule> {
    return validateTaskContextCapsule(capsule, {
      now: new Date(this.#options.now?.() ?? this.#options.host.now()).toISOString(),
      resolveEvidence: (id) => {
        const record = this.context.evidence.get(id as `evidence-${string}`);
        return record === undefined
          ? undefined
          : { id: record.id, digest: record.digest, freshness: record.freshness };
      },
    });
  }

  /** Build P1's immutable candidate pack after all async maintenance settles. */
  async #prepareContextPack(): Promise<void> {
    if (this.#activeBackgroundJobs.size > 0 || !this.#backgroundJobsReconciled) {
      this.#preparedContextPack = undefined;
      return;
    }
    const task = this.#taskDescription ?? "Continue the current task";
    // Refresh the bounded materialization ledger before compiling the immutable
    // pack; provider text still comes only from the projection below.
    this.context.repositoryContext({
      ...(this.#turnEvidence !== undefined ? { evidence: this.#turnEvidence } : {}),
      maxTokens: Math.max(0, this.context.activeExcerptBudget - 64),
    });
    const planState = this.#todoController.current();
    const activePlanItem = planState.items.find((item) => item.status === "active") ??
      planState.items.find((item) => item.status === "pending");
    const activePlanStep = activePlanItem === undefined
      ? undefined
      : `${activePlanItem.id}: ${activePlanItem.text}`;
    const mentionedPaths = extractPathMentions(task);
    const mentionedSymbols = [...new Set([
      ...extractSymbolMentions(task),
      ...(activePlanItem?.symbols ?? []),
    ])].slice(0, 32);
    const recentFailureRefs = (this.#turnEvidence?.records ?? [])
      .filter((record) => record.kind === "test_result" || record.kind === "review_finding")
      .map((record) => record.id)
      .slice(-12);
    const epoch = this.taskEpoch.current();
    const soft = Math.max(0, this.#options.config.model.softContextTokens);
    const reserve = Math.max(0, this.#options.config.model.context.reserveOutputTokens);
    const phase = this.#tokenSavingPhase();
    // Token saving only moves the soft target and the exploration ceiling. The
    // hard input limit and the exact-evidence floor are untouched, so saving
    // can never starve mandatory or exact evidence.
    const savingPlan = this.#tokenSavingResolve(phase);
    this.#preparedContextPack = await this.context.prepareSample({
      id: `sample-${this.#options.sessionId}-${this.recorder.model.currentTurnId ?? "pending"}`,
      goal: task,
      phase,
      mentionedPaths,
      mentionedSymbols,
      changedPaths: [...this.#changedPaths],
      recentFailureRefs,
      ...(activePlanStep === undefined ? {} : { activePlanStep, subgoal: activePlanStep }),
      ...(epoch === undefined ? {} : {
        workspaceIdentity: epoch.workspaceIdentityDigest,
        taskEpochId: epoch.id,
      }),
      budget: {
        modelContextLimit: soft + reserve,
        outputReserve: reserve,
        hardInputLimit: soft,
        targetInputTokens: Math.floor(soft * savingPlan.targetInputRatio),
        exactEvidenceFloor: Math.min(this.context.activeExcerptBudget, Math.floor(soft * 0.35)),
        explorationCeiling: Math.floor(soft * savingPlan.explorationRatio),
      },
    }, { recentDialogue: this.kernel.history });
  }

  /** 짠18.1's layers, assembled from one evidence-backed working view. */
  promptInputs(): PromptInputs {
    const backgroundJobActive = this.#activeBackgroundJobs.size > 0 || !this.#backgroundJobsReconciled;
    const provisionalOrientation = this.orientationMode === "progressive"
      ? this.context.provisionalRepositoryOrientation()
      : undefined;
    const repositoryContext = backgroundJobActive ? [] : [
      ...this.context.repositoryContext({
        ...(this.#turnEvidence !== undefined ? { evidence: this.#turnEvidence } : {}),
        // Reserve provider-owned L6 heading/untrusted-wrapper bytes inside the same ceiling.
        maxTokens: Math.max(0, this.context.activeExcerptBudget - 64),
      }),
      ...(provisionalOrientation === undefined ? [] : [provisionalOrientation]),
    ];
    this.#lastRepositoryContext = repositoryContext;
    const materialized = backgroundJobActive
      ? Object.freeze({
          evidenceIds: Object.freeze([] as `evidence-${string}`[]),
          excerptIds: Object.freeze([] as `excerpt-${string}`[]),
          rejected: Object.freeze([] as { id: string; reason: string }[]),
          estimatedTokens: 0,
          omitted: 0,
        })
      : this.context.lastMaterialization;
    this.#turnEvidence = this.context.selectEvidence({
      ids: materialized.evidenceIds,
      requireFresh: true,
    });
    const virtualizedExcerpts = materialized.excerptIds.flatMap((id) => {
      const descriptor = this.context.exactExcerptDescriptor(id);
      return descriptor === undefined ? [] : [descriptor];
    });
    const contextProjection =
      backgroundJobActive ||
        this.#preparedContextPack === undefined ||
        this.#options.config.perf.contextPackProjection === false
        ? undefined
        : projectContextPack(this.#preparedContextPack, {
            recentDialogue: this.kernel.history,
            virtualizedExcerpts,
          });
    const staleReadCallIds = new Set(
      [...this.#readObservationGenerations]
        .filter(([, observation]) =>
          observation.generation < this.#wholeWorkspaceReadInvalidationGeneration ||
          observation.paths.some((path) =>
            observation.generation < this.#pathMutationGenerationFor(path)
          ))
        .map(([callId]) => callId),
    );
    // A read whose bounded provenance record was evicted cannot be proven fresh.
    // Scan the already-bounded resident history once and fail it closed rather
    // than retaining another unbounded tombstone set.
    for (const item of this.kernel.history) {
      if (
        item.type === "function_call" &&
        (item.name === "fs.read" || item.name === "fs.read_many") &&
        !this.#readObservationGenerations.has(item.callId)
      ) staleReadCallIds.add(item.callId);
    }
    for (const callId of this.#hydratedStaleReadCallIds) staleReadCallIds.add(callId);
    const historyRewriteCallIds = new Set(staleReadCallIds);
    const virtualizedPaths = new Set(
      virtualizedExcerpts.map((excerpt) => this.#canonicalWorkspacePath(excerpt.path)),
    );
    for (const [callId, observation] of this.#readObservationGenerations) {
      if (observation.paths.some((path) => virtualizedPaths.has(path))) {
        historyRewriteCallIds.add(callId);
      }
    }
    const tokenSavingDirective = this.#tokenSavingDirectiveForPrompt();
    return {
      activeTools: this.registry.activeTools(),
      projectInstructions: backgroundJobActive ? [] : this.context.instructions,
      skillCatalog: this.skills.promptCatalog(),
      loadedSkills: this.#skillBodiesForPrompt(),
      ...(tokenSavingDirective === undefined ? {} : { tokenSavingDirective }),
      ...(this.#taskDescription !== undefined ? { taskDescription: this.#taskDescription } : {}),
      ...(this.recorder.model.todo.items.length > 0 ? { plan: this.recorder.model.todo.items } : {}),
      ...(this.recorder.model.todo.items.length > 0 ||
        this.recorder.model.todo.document !== undefined ||
        this.recorder.model.todo.approval !== undefined ||
        this.recorder.model.todo.modelMutationError !== undefined ? {
        planContract: {
          ...(this.recorder.model.todo.document === undefined ? {} : { ...this.recorder.model.todo.document }),
          items: this.recorder.model.todo.items,
          revision: this.recorder.model.todo.revision,
          ...(this.recorder.model.todo.modelMutationError === undefined ? {} : { mutationError: this.recorder.model.todo.modelMutationError }),
          ...(this.recorder.model.todo.approval === undefined ? {} : { approval: this.recorder.model.todo.approval, digest: this.recorder.model.todo.approval.digest }),
          readiness: this.#todoController.readiness(),
        },
      } : {}),
      interactionMode: this.recorder.model.modeState.activeTurn ?? this.recorder.model.modeState.selected,
      ...(this.#compactState !== undefined ? { compactState: this.#compactState } : {}),
      ...(contextProjection === undefined ? { repositoryContext } : { contextProjection }),
      contextManifest: {
        ...structuredClone(materialized),
        ...(this.#preparedContextPack === undefined ? {} : {
          compilerPackId: this.#preparedContextPack.id,
          compilerManifestDigest: this.#preparedContextPack.manifest.digest,
        }),
      },
      ...(virtualizedExcerpts.length > 0 ? { virtualizedExcerpts } : {}),
      ...(staleReadCallIds.size > 0 ? { staleReadCallIds: [...staleReadCallIds] } : {}),
      ...(historyRewriteCallIds.size > 0 ? { historyRewriteCallIds: [...historyRewriteCallIds].sort() } : {}),
      history: this.kernel.history,
    };
  }

  /**
   * Open the durable session, then emit the 짠20.7 `session.started` event.
   *
   * The order is not optional. 짠18.6 stores events in a table keyed on the session row,
   * so appending before `session.open` fails the foreign key ??which is exactly what
   * happened: every append reported `FOREIGN KEY constraint failed` and the journal
   * silently recorded nothing, leaving resume with no events to replay.
   *
   * A failure to open is a warning rather than a fatal error: 짠22.9 treats losing
   * durability as a degradation, and refusing to run a turn because the journal is
   * unavailable would be a worse trade than running it un-journaled and saying so.
   */
  async open(options: { resumed?: boolean; workspacePath?: string; title?: string; emitEvent?: boolean } = {}): Promise<
    { ok: true; descriptor?: unknown } | { ok: false; detail: string }
  > {
    const initialInteractionMode: InteractionMode = this.#options.config.agent.interactionMode ?? (this.#options.config.agent.permissionMode === "plan" ? "plan" : "build");
    let opened: { ok: true; descriptor?: unknown } | { ok: false; detail: string } = { ok: true };
    try {
      const descriptor = await this.#options.runtime.openSession({
        sessionId: this.#options.sessionId,
        resume: options.resumed === true,
        title: options.title ?? "Untitled session",
        modelProfile: this.#options.config.model.profile,
        permissionMode: this.#options.config.agent.permissionMode,
        interactionMode: initialInteractionMode,
      });
      opened = { ok: true, descriptor };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Resuming a session the store has never seen is a normal case: the index row can
      // outlive the journal. Fall back to creating it.
      if (options.resumed === true) {
        try {
          const descriptor = await this.#options.runtime.openSession({
            sessionId: this.#options.sessionId,
            resume: false,
            title: options.title ?? "Untitled session",
            modelProfile: this.#options.config.model.profile,
            permissionMode: this.#options.config.agent.permissionMode,
            interactionMode: initialInteractionMode,
          });
          opened = { ok: true, descriptor };
        } catch (inner) {
          opened = {
            ok: false,
            detail: inner instanceof Error ? inner.message : String(inner),
          };
        }
      } else {
        opened = { ok: false, detail };
      }
    }

    this.registry.setInteractionMode(initialInteractionMode);
    if (options.emitEvent !== false) {
      this.#emit(options.resumed === true ? "session.resumed" : "session.started", {
        sessionId: this.#options.sessionId,
        workspacePath: options.workspacePath ?? this.#options.workspacePath,
        modelId: this.#options.config.model.default,
        permissionMode: this.#options.config.agent.permissionMode,
        interactionMode: initialInteractionMode,
        permissionPreset: this.#permissionPreset,
        reasoningEffort: this.#options.config.model.reasoningEffort,
        contextBudgetTokens: this.#options.config.model.softContextTokens,
        trust: this.#options.trust,
      });
    }
    return opened;
  }

  /** Record the user's message, then run a turn. */
  async submit(prompt: string, signal: AbortSignal): Promise<TurnResult> {
    const planState = this.#todoController.current();
    if (this.recorder.model.modeState.selected === "build" && planState.document !== undefined) {
      if (this.#planExecution === undefined) throw new Error("A drafted Plan Contract is not executable yet; choose Yes, proceed in the Plan prompt.");
      if (!this.#todoController.approvalValid() || this.#planExecution.digest !== this.#todoController.digest()) {
        this.#planExecution = undefined;
        throw new Error("The approved Plan Contract digest is stale; review and approve the plan again.");
      }
    }
    if (this.orientationMode === "strict") await this.#ensureRepositoryMapFresh();
    const pendingMode = this.recorder.model.modeState.pending;
    if (pendingMode !== undefined && this.recorder.model.modeState.activeTurn === undefined) {
      await this.requestInteractionMode(pendingMode, "quiescence");
      if (this.recorder.model.modeState.pending !== undefined) {
        throw new Error(`MODE_CHANGE_PENDING: cannot start a turn until ${pendingMode} mode is quiescent`);
      }
    }
    this.setTaskDescription(prompt);
    this.context.select({
      taskText: prompt,
      mentionedPaths: extractPathMentions(prompt),
      searchMatches: this.context.searchMatches(),
      recentToolPaths: this.context.recentToolPaths(),
      changedPaths: [...this.#changedPaths],
      recentFailurePaths: this.context.recentFailurePaths(),
    });
    this.#turnEvidence = this.context.selectEvidence({ limit: 64, requireFresh: true });

    // A turn boundary ends any mid-turn recovery posture, and the journaled
    // policy must announce the exact budgets this turn will run with.
    this.#tokenSavingContinuationRecovery = false;
    this.#emitTokenSavingPolicy(this.#tokenSavingResolve(this.#tokenSavingPhase()));

    const epoch = this.taskEpoch.transition({
      goalDigest: stableDigest(prompt),
      modelId: this.#options.config.model.default,
      workspaceIdentityDigest: this.#options.workspaceIdentityDigest ?? stableDigest(this.#options.workspacePath),
    });
    if (epoch.reset) {
      this.kernel.resetProviderContinuation();
      this.#tokenSaving.resetDirectiveTracking();
    }
    this.#emit(this.#epochAnnounced ? "reasoning.epoch_reset" : "reasoning.epoch_started", {
      taskEpochId: epoch.current.id,
      generation: epoch.current.generation,
      reason: epoch.reason,
      workspaceIdentityDigest: epoch.current.workspaceIdentityDigest,
    }, this.#currentScope());
    this.#epochAnnounced = true;
    // Routing is decided exactly once, inside the kernel (짠10.5). The kernel
    // emits `model.route_decided` / `model.capability_snapshot` /
    // `reasoning.context_effective` from that decision and hands it back to the
    // `onRouteDecided` hook for cache planning and the context-band events, so
    // the announced route, the provider request, and the cost estimate always
    // name the same model.
    //
    // Keep the next turn from inheriting a prompt that already crossed the
    // effective model budget. The kernel repeats this check before each sample,
    // which also covers long tool-heavy turns.
    this.compactContext();
    // Include the selected effort on the user boundary so the reducer and a
    // resumed journal agree about the setting before `turn.started` arrives.
    this.#emit("user.message", {
      text: prompt,
      reasoningEffort: this.kernel.reasoningEffort,
    }, this.#currentScope());
    this.#turnCounter += 1;
    // A parent cancellation must also terminate every child. Without this
    // listener Esc only ended the root wait, leaving an active task card (and its
    // provider session) behind in the UI.
    let childCancellation: Promise<void> | undefined;
    const cancelChildren = (): void => {
      if (childCancellation !== undefined) return;
      childCancellation = this.#subagentBridge
        .cancelAllTasks("parent turn cancelled")
        .catch((error) => {
          this.#emit(
            "error.internal",
            {
              code: "SUBAGENT_CANCEL_FAILED",
              message: `could not cancel subagents: ${error instanceof Error ? error.message : String(error)}`,
            },
            this.#currentScope(),
          );
        });
    };
    if (signal.aborted) cancelChildren();
    else signal.addEventListener("abort", cancelChildren, { once: true });
    this.subagents.beginTurn();
    // A fresh checkpoint per turn: an approach abandoned in this turn must never be
    // able to roll back changes the previous turn already reported as done.
    this.#checkpointId = `ckpt_${this.#options.sessionId}_${this.#turnCounter}`;
    let result: TurnResult;
    let retainPlanExecution = false;
    try {
      result = await this.kernel.runTurn(prompt, signal);
      // Cancelling stops the current turn, but it does not revoke the user's
      // digest-bound approval. Keep it for a follow-up "continue" request;
      // the next submit still validates that the Plan scope has not changed.
      retainPlanExecution = result.report.status === "cancelled";
    } finally {
      signal.removeEventListener("abort", cancelChildren);
      // A completed or failed turn consumes the execution directive. A
      // cancellation is resumable so users do not need to re-approve an
      // unchanged Plan Contract just to continue it.
      if (!retainPlanExecution) this.#planExecution = undefined;
    }
    const pendingAfterTurn = this.recorder.model.modeState.pending;
    if (pendingAfterTurn !== undefined) await this.requestInteractionMode(pendingAfterTurn, "quiescence");
    if (result.report.status === "completed") {
      // The failures that led here are resolved, so continuing to weight the files
      // they named would bias the next, unrelated request.
      this.context.forgetReflections();
    }
    return result;
  }

  /** Emit an event that did not come from the kernel, e.g. a local notice. */
  emit<T>(kind: CbcEventKind, payload: T, options?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string; visibility?: EventVisibility }): CbcEvent<T> {
    return this.#emit(kind, payload, options);
  }

  /** The turn and agent an out-of-band event belongs to. */
  #currentScope(): { turnId?: string; agentId: string; callerId: string; taskEpochId?: string; workspaceIdentityDigest?: string } {
    const turnId = this.recorder.model.currentTurnId;
    return {
      ...(turnId !== undefined ? { turnId } : {}),
      agentId: "root",
      callerId: "root",
      ...(this.taskEpoch.current() !== undefined ? { taskEpochId: this.taskEpoch.requireCurrent().id, workspaceIdentityDigest: this.taskEpoch.requireCurrent().workspaceIdentityDigest } : {}),
    };
  }

  /** Apply session-level telemetry and routing-recording switches to every kernel. */
  #emitKernelEvent<T>(
    kind: CbcEventKind,
    payload: T,
    options?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string; visibility?: EventVisibility },
  ): void {
    if (!this.#performanceTelemetryEnabled && PERFORMANCE_EVENT_KINDS.has(kind)) return;
    if (!this.#options.config.model.router.recordDecisions && kind === "model.route_decided") return;
    if (
      kind === "assistant.commentary" &&
      this.#options.config.perf.commentaryPolicyV2 !== false &&
      this.#options.config.agent.visibleCommentary === false
    ) {
      const record = isRecord(payload) ? payload : undefined;
      const commentaryKind = record?.commentaryKind;
      const alwaysVisible = record?.alwaysVisible === true;
      const critical = commentaryKind === "risk" || commentaryKind === "verification" || commentaryKind === "recovery";
      if (!alwaysVisible && !critical) options = { ...options, visibility: "hidden" };
    }
    this.#emit(kind, payload, options);
  }

  #emit<T>(
    kind: CbcEventKind,
    payload: T,
    options?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string; visibility?: EventVisibility },
  ): CbcEvent<T> {
    const now = this.#options.now ?? (() => Date.now());
    const event = this.recorder.emit(kind, payload, {
      timestamp: new Date(now()).toISOString(),
      ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(options?.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options?.callerId !== undefined ? { callerId: options.callerId } : {}),
      ...(options?.taskEpochId !== undefined ? { taskEpochId: options.taskEpochId } : {}),
      ...(options?.workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest: options.workspaceIdentityDigest } : {}),
      ...(options?.visibility !== undefined ? { visibility: options.visibility } : {}),
    });
    this.#settlePendingInteractionMode(kind);
    return event;
  }

  /** Commit a deferred mode request as soon as the reducer reaches quiescence. */
  #settlePendingInteractionMode(eventKind: CbcEventKind): void {
    if (eventKind === "mode.changed") return;
    const model = this.recorder.model;
    if (model.modeState.pending === undefined || model.modeState.activeTurn !== undefined) return;
    void this.requestInteractionMode(model.modeState.pending, "quiescence");
  }
}

function parsePlanCommand(raw: string, cwd: string): PlanCommandScope | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const text = raw.trim();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = undefined; continue; }
      if (char === "\\" && next !== undefined && /[\s"\\]/u.test(next)) {
        token += next;
        index += 1;
      } else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "\\") {
      if (next !== undefined && /[\s'"\\]/u.test(next)) {
        token += next;
        index += 1;
      } else token += char; // preserve Windows path separators
      continue;
    }
    if (/\s/u.test(char)) {
      if (token.length > 0) { tokens.push(token); token = ""; }
      continue;
    }
    token += char;
  }
  if (quote !== undefined) return undefined;
  if (token.length > 0) tokens.push(token);
  const program = tokens.shift();
  if (program === undefined || program.length === 0 || cwd.length === 0) return undefined;
  return { program, args: tokens, cwd };
}

function retainHistoryForPrompt(
  history: readonly ModelInputItem[],
  sampledThrough?: number,
): ModelInputItem[] {
  const lastUserIndex = history.findLastIndex(
    (item) => item.type === "message" && item.role === "user",
  );
  const lastFinalIndex = history.findLastIndex(
    (item) =>
      item.type === "message" &&
      item.role === "assistant" &&
      (item.phase === "final_answer" || item.content.some((part) => part.type === "output_text")),
  );
  // Never compact the current, unsampled tail. In particular a function-call
  // output may be the only remaining copy when exact L6 promotion was rejected.
  // Older turns are represented by compactState; retain their final answer only
  // for conversational shape, plus every item from the latest user onward.
  return history
    .filter((_item, index) =>
      (lastUserIndex >= 0 && index >= lastUserIndex) ||
      (sampledThrough !== undefined && index >= sampledThrough) ||
      index === lastFinalIndex
    )
    .map((item) => {
      if (item.type !== "function_call_output" || item.output.length <= 4_096) return item;
      const handles = item.output.match(/\[artifact [^\]\n]+\]/g);
      const handle = handles?.at(-1);
      // Never discard an unsampled body unless the runtime minted a bounded,
      // model-callable recovery handle for the exact stored bytes.
      if (handle === undefined) return item;
      return {
        ...item,
        output: `${item.output.slice(0, 512)}\n??compacted recoverable output ??n${handle}`,
      };
    });
}
function turnCounterFromEvents(events: readonly CbcEvent[]): number {
  let maximum = 0;
  for (const event of events) {
    const candidates = [
      event.turnId,
      isRecord(event.payload) && typeof event.payload.turnId === "string"
        ? event.payload.turnId
        : undefined,
    ];
    for (const candidate of candidates) {
      const match = candidate === undefined ? undefined : /^turn_(\d+)$/.exec(candidate);
      if (match !== undefined && match !== null) maximum = Math.max(maximum, Number(match[1]));
    }
  }
  return maximum;
}

function historyFromEvents(
  events: readonly CbcEvent[],
  initial: readonly ModelInputItem[] = [],
): ModelInputItem[] {
  const history: ModelInputItem[] = [...initial];
  for (const event of events) {
    const payload = isRecord(event.payload) ? event.payload : {};
    switch (event.kind) {
      case "session.compacted": {
        // A compact marker without its summary can come from an older journal or
        // a truncated append. Keep the full replay in that case rather than
        // dropping context the provider has no replacement for.
        if (typeof payload.compactState === "string" && payload.compactState.length > 0) {
          // Match the live kernel: the summary replaces the old transcript while
          // retaining the most recent user/answer pair for conversational shape.
          history.splice(0, history.length, ...retainHistoryForPrompt(history));
        }
        break;
      }
      case "user.message": {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text.length > 0) {
          history.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          });
        }
        break;
      }
      case "assistant.commentary": {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text.length > 0) {
          history.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
            phase: "commentary",
          });
        }
        break;
      }
      case "assistant.reasoning":
      case "assistant.reasoning_summary": {
        // A provider disclosure is presentation-only. Replaying it as assistant
        // commentary changes the next prompt and can make a resumed session reason
        // over its own prior summary instead of the opaque provider continuity item.
        break;
      }
      case "assistant.final": {
        const report = isRecord(payload.report) ? payload.report : undefined;
        const text =
          (typeof payload.answer === "string" && payload.answer) ||
          (typeof report?.summary === "string" && report.summary) ||
          (typeof payload.text === "string" && payload.text) ||
          "";
        if (text.length > 0) {
          history.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
            // A partial terminal report is useful context but never an accepted
            // final answer for the resumed prompt.
            phase: report?.status === "completed" ? "final_answer" : "commentary",
          });
        }
        break;
      }
      case "tool.started": {
        const callId = typeof payload.callId === "string" ? payload.callId : "";
        const name = typeof payload.toolId === "string" ? payload.toolId : "";
        if (callId.length === 0 || name.length === 0) break;
        const args = payload.arguments;
        history.push({
          type: "function_call",
          callId,
          name,
          argumentsText: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        });
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const callId = typeof payload.callId === "string" ? payload.callId : "";
        if (callId.length === 0) break;
        const output =
          typeof payload.summary === "string"
            ? payload.summary
            : typeof payload.message === "string"
              ? payload.message
              : "tool call completed";
        history.push({ type: "function_call_output", callId, output });
        break;
      }
      default:
        break;
    }
  }
  return history;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * 짠11.8's focused test command.
 *
 * Only conclusions the repository actually supports are drawn: a TypeScript change
 * gets the project's test script, and anything else returns `undefined` so the
 * kernel reports 
ot_run` with a reason instead of inventing a command that would
 * fail for the wrong reason.
 */
export function testCommandFor(
  paths: readonly string[],
  plannerV2 = false,
): { command: string; reason: string } | undefined {
  if (paths.length === 0) return undefined;
  if (plannerV2) {
    const planned = planVerification({ changedPaths: paths });
    const legacy = toLegacyVerificationCommand(planned);
    if (legacy !== undefined) return legacy;
  }

  const hasTs = paths.some((path) => /\.(ts|tsx|mts|cts)$/.test(path));
  const hasRust = paths.some((path) => path.endsWith(".rs"));

  if (hasRust) {
    return { command: "cargo test --workspace", reason: "Rust sources changed" };
  }
  if (hasTs) {
    return { command: "bun test", reason: "TypeScript sources changed" };
  }
  return undefined;
}

/** Native tools plus anything Skills or MCP contributed, for `--help` style output. */
export function catalogSnapshot(registry: ToolRegistry): ToolDefinition[] {
  return registry.all();
}

function stableDigest(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, (_key, current) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return current;
  });
  return createHash("sha256").update(text).digest("hex");
}

const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;

/**
 * Parse the reviewer's JSON verdict (P0-12). Defensive on purpose: the reviewer
 * output is untrusted model text, so anything malformed degrades to "no findings,
 * here is what the reviewer said" rather than crashing the turn or, worse, being
 * read as a clean bill of health when it was not.
 */
export function parseReviewOutcome(text: string): ReviewOutcome {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { findings: [{ severity: "high", title: "reviewer returned no output", evidence: "empty response", recommendation: "re-run independent review" }], summary: "independent review failed: the reviewer returned no output ??verification is not confirmed" };
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { findings: [{ severity: "high", title: "reviewer returned malformed output", evidence: trimmed.slice(0, 500), recommendation: "re-run independent review with JSON output" }], summary: `independent review failed: malformed output ??${trimmed.slice(0, 500)}` };
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
      summary?: unknown;
      findings?: unknown;
    };
    const findings: ReviewOutcome["findings"] = [];
    if (Array.isArray(parsed.findings)) {
      for (const entry of parsed.findings) {
        if (typeof entry !== "object" || entry === null) continue;
        const finding = entry as Record<string, unknown>;
        const severity = finding.severity;
        if (
          typeof severity !== "string" ||
          !REVIEW_SEVERITIES.includes(severity as (typeof REVIEW_SEVERITIES)[number])
        ) {
          continue;
        }
        if (typeof finding.title !== "string" || finding.title.length === 0) continue;
        findings.push({
          severity: severity as (typeof REVIEW_SEVERITIES)[number],
          title: finding.title,
          evidence: typeof finding.evidence === "string" ? finding.evidence : "",
          recommendation: typeof finding.recommendation === "string" ? finding.recommendation : "",
        });
      }
    }
    return {
      findings,
      summary: typeof parsed.summary === "string" && parsed.summary.length > 0
        ? parsed.summary
        : findings.length === 0
          ? "no findings"
          : `${findings.length} finding(s)`,
    };
  } catch {
    return { findings: [{ severity: "high", title: "reviewer JSON parse failed", evidence: trimmed.slice(0, 500), recommendation: "re-run independent review" }], summary: `independent review failed: invalid JSON ??${trimmed.slice(0, 500)}` };
  }
}
