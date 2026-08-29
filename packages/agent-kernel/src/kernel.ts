/**
 * `AgentKernel` — the Root Agent loop (PRD §11).
 *
 * §11.1 responsibilities: turn lifecycle, prompt assembly, model streaming, tool
 * call collection, schema validation, permission evaluation, tool execution
 * coordination, observation normalization, delegation, budget accounting,
 * compaction, verification, and the completion contract.
 *
 * The same kernel runs subagents with a different role, budget, and permission
 * scope (§15.1), which is what makes a subagent a first-class CBC concept rather
 * than a provider feature.
 */

import type { CbcEventKind, EventVisibility } from "@cbc/protocol";
import {
  THINKING_MAX_DETAIL_CHARS,
  THINKING_MAX_SUMMARY_CHARS,
  ThinkingAssembler,
} from "./thinking.ts";
import {
  estimateCostUsd,
  emptyUsage,
  findModel,
  resolveProviderGenerationBudget,
  calculateNativeCompactionThreshold,
  clampEffortToModel,
  selectEffort,
  type ComplexityFeatures,
  type GeneratedImageOutput,
  type InferencePolicyDecision,
  type InferencePolicyPort,
  type ModelEvent,
  type ModelInputItem,
  type ModelProvider,
  type ModelResponseItem,
  type ModelRequest,
  type ModelUsage,
  type ProviderError,
  type ProviderTurnSession,
  type ReasoningContextScope,
  type ReasoningEffort,
  type ReasoningMode,
} from "@cbc/provider-openai";
import {
  decideRetry,
  effortChangeLine,
  reasoningContextScope,
} from "@cbc/provider-openai";
import {
  actionHash,
  classifyCommand,
  classifyCommandLane,
  evaluate,
  renderDenialObservation,
  type ApprovalDecision,
  type ApprovalRequest,
  type PermissionContext,
  type PermissionDecision,
  type ProposedAction,
} from "@cbc/permissions";
import {
  ToolExecutionGraph,
  ToolRegistry,
  renderValidationErrors,
  type ArtifactRef,
  type ToolResult,
  type ToolGraphCall,
  type ToolGraphLimits,
} from "@cbc/tool-registry";
import {
  buildVerificationCoverage,
  classifyFailure,
  deriveCompletionPresentation,
  enforceTruthfulness,
  normalizeObservation,
  partialReport,
  planVerification,
  renderReport,
  type CompletionPresentation,
  type CompletionReport,
  type FailureCategory,
  type Observation,
  type ReflectionHint,
} from "./observation.ts";
import {
  assemblePrompt,
  fingerprint,
  promptMaterializationCacheStats,
  type CompiledModelRequest,
  type PromptInputs,
} from "./prompt.ts";
import {
  assessChangeRisk,
  type ChangeRiskLevel,
  type ReviewPolicy,
} from "./risk.ts";

import {
  budgetExhausted,
  describeExhaustion,
  MAX_CONSECUTIVE_SAME_FAILURE,
  newBudget,
  ROOT_LIMITS,
  TurnStateMachine,
  type BudgetState,
  type LoopLimits,
  type TurnState,
} from "./state.ts";

// P1-05: `AgentRole` is provider- and kernel-neutral; the definition lives in
// `@cbc/inference-domain` and is re-exported here for existing call sites.
import type { AgentRole, WorkPhase, TurnBudgetController, BudgetEnforcementMode } from "@cbc/inference-domain";
import type { ContextPressureDecision } from "@cbc/session-domain";
import { reprojectPromptContextDialogue } from "@cbc/context-engine";
export type { AgentRole, WorkPhase };

/**
 * Fire the wrap-up nudge when this many tool calls (fewer) remain.
 *
 * Without it a child spends its last calls on open-ended exploration and is cut
 * off into a partial report that never reached a conclusion (§11.3). Nudging a
 * couple of calls early hands the model a chance to conclude with the evidence it
 * already has, which is what the parent can actually act on.
 */
const TOOL_BUDGET_NUDGE_REMAINING = 2;

/** A small, host-owned projection of the root session TODO list. */
type TodoProjectionItem = { readonly id?: string; readonly status: string; readonly text: string; readonly hostGenerated?: true };

/**
 * A rejected TODO mutation is represented by a host-owned item. Unlike a real
 * blocked task, it has a deterministic in-session recovery path: the model can
 * submit a valid, state-changing `todo.write` at the current revision.
 */
const TODO_MUTATION_ERROR_ID = "todo-controller-error";

function isTodoMutationRecovery(item: TodoProjectionItem): boolean {
  return item.id === TODO_MUTATION_ERROR_ID && item.hostGenerated === true;
}

/** Only `done` earns a completed Build-mode turn. */
function isTodoDone(item: TodoProjectionItem): boolean {
  return item.status === "done";
}

/** Pending/active items can be worked now; malformed state is repaired rather than trusted. */
function isActionableTodo(item: TodoProjectionItem): boolean {
  return (
    item.status === "pending" ||
    item.status === "active" ||
    (item.status !== "done" && item.status !== "blocked" && item.status !== "skipped")
  );
}

function isContinuableTodo(item: TodoProjectionItem): boolean {
  return isActionableTodo(item) || isTodoMutationRecovery(item);
}

function todoLabel(item: TodoProjectionItem): string {
  const text = item.text.replace(/\s+/gu, " ").trim().slice(0, 240);
  return `[${item.status}] ${text.length > 0 ? text : "unnamed TODO"}`;
}

function describeUnfinishedTodos(items: readonly TodoProjectionItem[]): string {
  const listed = items.slice(0, 3).map(todoLabel);
  return `${items.length} unfinished TODO item(s): ${listed.join(", ")}${
    items.length > listed.length ? ", …" : ""
  }`;
}

/** Tell the model exactly why its candidate answer was withheld. */
function renderTodoContinuationPrompt(items: readonly TodoProjectionItem[]): string {
  const mutationRecovery = items.find(isTodoMutationRecovery);
  if (mutationRecovery !== undefined) {
    const actionable = items.filter(isActionableTodo);
    return [
      "TODO completion gate: do not send a final answer yet.",
      "A previous todo.write was rejected. Repair the checklist automatically before continuing.",
      `- ${todoLabel(mutationRecovery)}`,
      "Call todo.write with the current revision. Do not include the host-generated 'todo-controller-error' item; preserve real existing items and establish or reopen the accurate work as pending or active.",
      ...(actionable.length === 0
        ? []
        : ["The following real root TODO items are also actionable:", ...actionable.map((item) => `- ${todoLabel(item)}`)]),
      "Only mark a real TODO done after it has been active and its work is verified. A Build-mode final answer is allowed only when every root TODO is done; real blocked or skipped work must remain a partial result.",
    ].join("\n");
  }
  return [
    "TODO completion gate: do not send a final answer yet.",
    "The following root TODO items are still actionable:",
    ...items.map((item) => `- ${todoLabel(item)}`),
    "Continue the work now. Before each step, update the TODO to active; after verified work, update it to done with evidence.",
    "If work genuinely cannot proceed, mark the item blocked with its blocker. A Build-mode final answer is allowed only when every root TODO is done; blocked or skipped work must remain a partial result.",
  ].join("\n");
}

/** Replace an optimistic provider answer when the runtime cannot finish its TODOs. */
function renderUnfinishedTodoAnswer(items: readonly TodoProjectionItem[]): string {
  return `I could not complete all root TODO items. Remaining: ${describeUnfinishedTodos(items)}.`;
}

/** A withheld final stays in model context without becoming a durable final answer. */
function asIntermediateAssistantItems(items: readonly ModelInputItem[]): ModelInputItem[] {
  return items.map((item) =>
    item.type === "message" && item.role === "assistant" && item.phase === "final_answer"
      ? { ...item, phase: "commentary" }
      : item,
  );
}

/** Ephemeral provider chunks are reduced/rendered at frame cadence, not token cadence. */
export const STREAM_FLUSH_MS = 24;
export const STREAM_FLUSH_CHARS = 1_024;

/**
 * Ephemeral stream phases are deliberately narrower than durable history. A
 * provider text delta can be a final answer only after all turn gates accept it,
 * so it is rendered as `candidate_final` until then.
 */
type AssistantDeltaPhase = "progress" | "thinking" | "reasoning" | "reasoning_summary" | "candidate_final";
interface AssistantDeltaPayload {
  readonly text: string;
  readonly phase: AssistantDeltaPhase;
  /** Stable provider output identity used to reconcile a later durable event. */
  readonly itemId?: string;
  readonly outputIndex?: number;
  /** Canonical identity for a semantic Thinking segment. */
  readonly thinkingId?: string;
  /** Provider channel retained as metadata, never as a UI phase. */
  readonly channel?: "detail" | "summary";
}

/** Response-local, ordered fixed-window coalescer for ephemeral assistant text. */
class AssistantDeltaCoalescer {
  readonly #emit: (payload: AssistantDeltaPayload) => void;
  readonly #signal: AbortSignal;
  readonly #onAbort: () => void;
  #phase: AssistantDeltaPhase | undefined;
  #itemId: string | undefined;
  #outputIndex: number | undefined;
  #thinkingId: string | undefined;
  #channel: "detail" | "summary" | undefined;
  #parts: string[] = [];
  #chars = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #deferredError: Error | undefined;
  #closed = false;

  constructor(emit: (payload: AssistantDeltaPayload) => void, signal: AbortSignal) {
    this.#emit = emit;
    this.#signal = signal;
    this.#onAbort = () => {
      if (this.#closed) return;
      try {
        this.#endWindow();
      } catch (error) {
        this.#deferredError = asError(error);
      }
    };
    signal.addEventListener("abort", this.#onAbort, { once: true });
  }

  append(
    text: string,
    phase: AssistantDeltaPhase,
    identity: {
      readonly itemId?: string;
      readonly outputIndex?: number;
      readonly thinkingId?: string;
      readonly channel?: "detail" | "summary";
    } = {},
  ): void {
    this.#throwDeferredError();
    if (this.#closed) throw new Error("assistant delta coalescer is closed");
    if (text.length === 0) return;

    if (
      this.#phase !== phase ||
      this.#itemId !== identity.itemId ||
      this.#outputIndex !== identity.outputIndex ||
      this.#thinkingId !== identity.thinkingId ||
      this.#channel !== identity.channel
    ) {
      this.#endWindow();
      this.#phase = phase;
      this.#itemId = identity.itemId;
      this.#outputIndex = identity.outputIndex;
      this.#thinkingId = identity.thinkingId;
      this.#channel = identity.channel;
      // Preserve time-to-first-text. The rest of a continuous response is emitted
      // at one fixed 24 ms window (or the bounded-size escape hatch) at a time.
      this.#emitPayload(text, phase, identity);
      this.#armTimer();
      return;
    }

    this.#parts.push(text);
    this.#chars += text.length;
    if (this.#chars >= STREAM_FLUSH_CHARS) this.#flushPending();
  }

  /** Flush before every non-delta provider event so semantic ordering is exact. */
  boundary(): void {
    if (this.#closed) return;
    this.#endWindow();
    this.#throwDeferredError();
  }

  close(): void {
    if (this.#closed) {
      this.#throwDeferredError();
      return;
    }
    try {
      this.#endWindow();
      this.#throwDeferredError();
    } finally {
      this.#closed = true;
      this.#clearTimer();
      this.#signal.removeEventListener("abort", this.#onAbort);
    }
  }

  #endWindow(): void {
    this.#clearTimer();
    this.#flushPending();
    this.#phase = undefined;
    this.#itemId = undefined;
    this.#outputIndex = undefined;
    this.#thinkingId = undefined;
    this.#channel = undefined;
  }

  #flushPending(): void {
    if (this.#parts.length === 0 || this.#phase === undefined) return;
    const text = this.#parts.join("");
    const phase = this.#phase;
    const identity = {
      ...(this.#itemId !== undefined ? { itemId: this.#itemId } : {}),
      ...(this.#outputIndex !== undefined ? { outputIndex: this.#outputIndex } : {}),
      ...(this.#thinkingId !== undefined ? { thinkingId: this.#thinkingId } : {}),
      ...(this.#channel !== undefined ? { channel: this.#channel } : {}),
    };
    // Clear before calling observers so an exception cannot duplicate this batch.
    this.#parts = [];
    this.#chars = 0;
    this.#emitPayload(text, phase, identity);
  }

  #emitPayload(
    text: string,
    phase: AssistantDeltaPhase,
    identity: {
      readonly itemId?: string;
      readonly outputIndex?: number;
      readonly thinkingId?: string;
      readonly channel?: "detail" | "summary";
    },
  ): void {
    this.#emit({ text, phase, ...identity });
  }

  #armTimer(): void {
    if (this.#timer !== undefined || this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed) return;
      const hadPending = this.#parts.length > 0;
      try {
        this.#flushPending();
        if (hadPending) this.#armTimer();
        else {
          this.#phase = undefined;
          this.#itemId = undefined;
          this.#outputIndex = undefined;
          this.#thinkingId = undefined;
          this.#channel = undefined;
        }
      } catch (error) {
        this.#deferredError = asError(error);
        this.#phase = undefined;
        this.#itemId = undefined;
        this.#outputIndex = undefined;
        this.#thinkingId = undefined;
        this.#channel = undefined;
        this.#clearTimer();
      }
    }, STREAM_FLUSH_MS);
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #throwDeferredError(): void {
    if (this.#deferredError === undefined) return;
    const error = this.#deferredError;
    this.#deferredError = undefined;
    throw error;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The conclusion of one `reflecting` step (§11.2).
 *
 * `errorCategory` comes from the deterministic taxonomy in `observation.ts`, not
 * from the model: a model asked to categorize its own failure will sometimes pick
 * whichever category makes its intended next action look justified.
 */
export interface ReflectionAnalysis {
  readonly errorCategory: FailureCategory;
  readonly rootCause: string;
  readonly correctiveAction: string;
  /**
   * True when the failure invalidates continuing the current approach rather
   * than only its last call. A checkpoint rollback additionally requires a
   * `logic_bug`: permission and environment failures require re-planning, but
   * do not prove that already committed workspace changes are wrong.
   */
  readonly approachInvalid: boolean;
  /** Consecutive occurrences of this exact failure, including this one. */
  readonly attempts: number;
  readonly signature: string;
  readonly toolId: string;
  /** Paths the failure named, for the §18.4 recent-failure weight. */
  readonly implicatedPaths: readonly string[];
}

export interface CheckpointRollback {
  readonly checkpointId: string;
  readonly revertedPaths: readonly string[];
  readonly skippedPaths?: readonly string[];
}

/**
 * The bridge to the Rust transaction journal (§12.5, §14.3).
 *
 * The kernel decides *that* an approach should be abandoned; only the runtime can
 * safely undo it, because only the runtime knows whether a path still holds the
 * content the agent wrote. Keeping the two apart is what stops a reflection from
 * deleting a user's concurrent edit.
 */
export interface CheckpointCoordinator {
  /** The most recent checkpoint worth returning to, if one exists. */
  current(): string | undefined;
  rollbackTo(checkpointId: string, signal: AbortSignal): Promise<CheckpointRollback>;
}

/** Input handed to an optional model-assisted reflector. */
export interface ReflectionInput {
  readonly observation: Observation;
  readonly hint: ReflectionHint;
  readonly attempts: number;
  readonly priorReflections: readonly ReflectionAnalysis[];
}

/** How the kernel reports progress. The host maps these onto §20.7 events. */
export interface KernelEmitter {
  emit<T>(kind: CbcEventKind, payload: T, options?: { turnId?: string; agentId?: string; callerId?: string; taskEpochId?: string; workspaceIdentityDigest?: string; visibility?: EventVisibility }): void;
}

/** Everything the kernel needs to actually run a tool. */
export interface ToolExecutor {
  execute(
    action: ProposedAction,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; text?: string; exitCode?: number; durationMs?: number }>;
  /**
   * Spill oversized output to an artifact (§18.17). Resolves with the handle the
   * store actually created — an id/digest the observation can read back — or
   * `undefined` when the store refused or was unreachable.
   */
  spill?(label: string, content: string): Promise<ArtifactRef | undefined>;
}

/** Resolves an approval request into a decision (§13.4). */
export interface ApprovalBroker {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** Turns a validated call into a normalized action for the policy engine. */
export interface ActionNormalizer {
  normalize(callId: string, toolId: string, args: Record<string, unknown>): ProposedAction;
}

export interface GeneratedImageHandle {
  readonly artifactId?: string;
  readonly outputPath?: string;
}

/** Who owns conversation continuation between provider requests (§10.6). */
export type ContinuationMode = "client_managed" | "previous_response";

export type ContextPressureGuardResult =
  | { readonly action: "accept"; readonly decision?: ContextPressureDecision }
  | { readonly action: "compact" | "emergency"; readonly targetTokens: number; readonly decision: ContextPressureDecision };

export interface KernelOptions {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly provider: ModelProvider;
  /** Defaults to local full replay, which keeps compaction under client control. */
  readonly continuationMode?: ContinuationMode;
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  /** Optional host wrapper for safe internal recovery of one logical call. */
  readonly executeWithRecovery?: (
    action: ProposedAction,
    signal: AbortSignal,
    context: { readonly emit: <T>(kind: CbcEventKind, payload: T) => void },
  ) => Promise<Awaited<ReturnType<ToolExecutor["execute"]>>>;
  /** Repair host-owned state immediately before a logical tool dispatch. */
  readonly beforeToolExecute?: (action: ProposedAction, signal: AbortSignal) => void | Promise<void>;
  readonly approvals: ApprovalBroker;
  readonly normalizer: ActionNormalizer;
  readonly emitter: KernelEmitter;
  readonly limits?: LoopLimits;
  readonly model: string;
  readonly reasoningMode?: ReasoningMode;
  readonly reasoningEffort?: ReasoningEffort;
  /** Provider summary-generation policy; intentionally independent from UI disclosure. */
  readonly reasoningSummary?: "auto" | "none";
  /** Keep an explicit effort fixed; adaptive selection is opt-in for auto profiles. */
  readonly reasoningEffortLocked?: boolean;
  readonly maxOutputTokens?: number;
  readonly toolGraph?: Partial<ToolGraphLimits>;

  /** Ask the provider to schedule independent function calls concurrently. */
  readonly parallelToolCalls?: boolean;
  /** Enable opaque server-side compaction when the active provider supports it. */
  readonly nativeCompaction?: boolean;
  /** Use model-relative native compaction instead of a fixed legacy threshold. */
  readonly nativeCompactionDynamic?: boolean;
  readonly compactionThresholdTokens?: number;
  /** OpenAI Fast mode (priority processing alias). */
  readonly serviceTier?: "standard" | "fast";
  /** Premium context-band policy (>272k bands) applied to route decisions. */
  readonly premiumContextPolicy?: "utility-gated" | "allow" | "deny";
  /** Route the turn using its concrete work phase instead of treating every sample as final. */
  readonly phasePolicy?: boolean;
  /** v1 bypasses stable materialization caches; v2 reuses versioned stable sections. */
  readonly promptCompiler?: "v1" | "v2";
  /** Classify direct commands into conservative graph lanes. */
  readonly commandClassification?: boolean;
  /** Optional turn budget guard; shadow/advisory/hard are rollout-safe. */
  readonly budgetController?: TurnBudgetController;
  readonly budgetEnforcement?: BudgetEnforcementMode;

  readonly permissionContext: () => PermissionContext;
  readonly promptInputs: () => PromptInputs;
  /** Give the host a chance to compact before a new provider sample. */
  readonly beforeSample?: () => void | Promise<void>;
  /** Evaluate the exact candidate request and compact at most once before sending it. */
  readonly contextPressureGuard?: (prompt: CompiledModelRequest) => ContextPressureGuardResult | Promise<ContextPressureGuardResult>;
  /** One-shot local recovery hook for a provider context-length response. */
  readonly onProviderContextError?: () => void | Promise<void>;
  /** §10.4 features for adaptive effort selection. */
  readonly complexity?: () => ComplexityFeatures;
  readonly inferencePolicy?: InferencePolicyPort;
  /**
   * Called once per turn with the routing decision, after the route events are
   * emitted and before `turn.started`. The host uses the *same* decision object
   * for cache planning and context-band events, so the plan it announces can
   * never disagree with the request the kernel actually sends (§10.5).
   */
  readonly onRouteDecided?: (
    route: InferencePolicyDecision,
    prompt: CompiledModelRequest,
  ) => void;
  /**
   * Called for the exact assembled object immediately before every provider
   * request, including tool-follow-up and wrap-up samples. Observer failures are
   * isolated from model truth just like route planning failures.
   */
  readonly onPromptCompiled?: (
    prompt: CompiledModelRequest,
    metadata?: {
      readonly requestId: string;
      readonly turnId: string;
      readonly modelId: string;
      readonly interactionMode: "build" | "plan";
    },
  ) => void;
  /** Persist provider-generated image bytes outside the journal. */
  readonly onGeneratedImage?: (
    callId: string,
    image: GeneratedImageOutput,
  ) => Promise<GeneratedImageHandle>;
  /** Let the utility controller choose a tier when the config profile is auto. */
  readonly autoRoute?: boolean;
  /** @deprecated Routing measures the exact compiled prompt instead. */
  readonly inferenceContextTokens?: () => number;
  readonly reserveOutputTokens?: number;
  /** Compute cache identity from the exact prompt about to be requested. */
  readonly cacheKey?: (prompt: CompiledModelRequest) => string | undefined;
  readonly safetyIdentifier?: string;
  /** v1.3 attribution supplied by the session epoch controller. */
  readonly callerId?: string;
  readonly taskEpochId?: () => string | undefined;
  readonly workspaceIdentityDigest?: () => string | undefined;
  /** §11.9 Auto Review: run an independent reviewer after edits. */
  readonly autoReview?: boolean;
  readonly reviewer?: (diffSummary: string, signal: AbortSignal) => Promise<ReviewOutcome>;
  /** Deterministic policy controlling whether a mutated turn gets a reviewer. */
  readonly reviewPolicy?: ReviewPolicy;
  readonly minimumReviewRisk?: ChangeRiskLevel;
  /** Fetch bounded, exact patch material independently of the authoring prompt. */
  readonly reviewMaterial?: (paths: readonly string[], signal: AbortSignal) => Promise<string>;

  /** §11.8: the focused test command for a set of changed paths. */
  readonly testCommandFor?: (paths: readonly string[]) => { command: string; reason: string } | undefined;
  /** Runner-owned commands that replace repository heuristics for final checks. */
  readonly requiredVerificationCommands?: readonly { readonly command: string; readonly reason: string }[];
  /** Optional host classifier for required, diagnostic, and forbidden commands. */
  readonly verificationCommandKind?: (command: string) => "required" | "diagnostic" | "off_contract" | "not_verification";
  /** Require at least one turn-local test, diff, or review result after mutation. */
  readonly completionRequiresFreshEvidence?: boolean;
  /** Whether missing fresh evidence blocks completion or remains a visible warning. */
  readonly falseCompletePolicy?: "block" | "warn";
  /** Host evidence counters used by the verification-first completion gate. */
  readonly verificationCoverage?: () => { readonly changedSymbols?: number; readonly staleEvidence?: number; readonly unresolvedOperations?: number; readonly highRiskFindings?: number };
  /** Immutable work intent captured at turn start. */
  readonly interactionMode?: () => "build" | "plan";
  /** Immutable Deep Plan policy captured at the same turn boundary. */
  readonly deepPlanMode?: () => "off" | "on";
  /** Root TODO projection used to prevent false completed reports. */
  readonly todoState?: () => readonly { readonly status: string; readonly text: string }[];
  /**
   * §11.2 self-reflection. On by default: a loop that cannot diagnose its own
   * failures retries them. Turn it off for a role where an extra model step costs
   * more than the correction is worth.
   */
  readonly selfCorrection?: boolean;
  /**
   * Optional deeper analysis of a failure, layered over the deterministic
   * taxonomy. Whatever it returns is merged on top, so a reflector that declines
   * to answer leaves a usable analysis behind rather than none.
   */
  readonly reflector?: (
    input: ReflectionInput,
    signal: AbortSignal,
  ) => Promise<Partial<ReflectionAnalysis> | undefined>;
  /** §12.5 bridge: undo an abandoned approach atomically. */
  readonly checkpoints?: CheckpointCoordinator;
  /**
   * Called as each reflection is reached, so the context engine can weight the
   * files a failure named *before* the next sample rather than after the turn
   * (§18.4). Reporting it only in `TurnResult` would make the signal arrive one
   * turn too late to be useful.
   */
  readonly onReflection?: (analysis: ReflectionAnalysis) => void;
  readonly now?: () => number;
}

export interface ReviewOutcome {
  readonly findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    title: string;
    evidence: string;
    recommendation: string;
  }>;
  readonly summary: string;
}

export interface TurnResult {
  readonly turnId: string;
  readonly state: TurnState;
  readonly report: CompletionReport;
  /** Host-owned display classification; report.status remains the SDK contract. */
  readonly presentation: CompletionPresentation;
  /** The provider's user-facing answer, kept separate from the evidence report. */
  readonly answer: string;
  readonly usage: ModelUsage;
  readonly estimatedCostUsd: number;
  readonly budget: BudgetState;
  readonly observations: Observation[];
  /** Every `reflecting` conclusion, in order (§11.2). */
  readonly reflections: ReflectionAnalysis[];
  readonly stateHistory: ReadonlyArray<{ from: TurnState; event: string; to: TurnState }>;
  /** Conversation items to carry into the next turn (§10.6 stateless replay). */
  readonly history: ModelInputItem[];
}

interface PendingCall {
  readonly callId: string;
  readonly name: string;
  readonly callerId?: string;
  readonly programId?: string;
  readonly agentId?: string;
  argumentsText: string;
}

/** §11.10 how a mid-turn user prompt is handled. */
export type InterruptMode = "queue" | "interrupt_and_redirect" | "new_task";

/**
 * The §11.3 wrap-up instruction sent when the tool budget is exhausted but
 * model steps remain. It converts a hard budget stop into an authored report:
 * the model names what it found, cites what it read, and marks honest gaps —
 * instead of the loop inventing a partial summary it never produced.
 */
export const TOOL_BUDGET_WRAP_UP_PROMPT = [
  "TOOL_BUDGET_EXHAUSTED: no further tool call will be executed.",
  "Do not issue more tool calls. Write your final report now from the evidence you already gathered:",
  "state your findings with the file and line evidence you read, and list anything you could not confirm as an open question instead of guessing.",
].join(" ");

export class AgentKernel {
  readonly #options: KernelOptions;
  readonly #limits: LoopLimits;
  readonly #now: () => number;

  readonly #providerSession: ProviderTurnSession;
  #history: ModelInputItem[] = [];
  /** Provider-owned continuation token; never journaled as prompt content. */
  #previousResponseId: string | undefined;
  /** First local history item not already represented by `#previousResponseId`. */
  #continuationHistoryCursor = 0;
  #usage: ModelUsage = emptyUsage();
  #observations: Observation[] = [];
  #continuationSignature: string | undefined;
  #previousResponseFallbackUsed = false;
  #providerContextRecoveryUsed = false;

  #changedFiles = new Map<string, { additions: number; deletions: number; purpose: string }>();
  #verification: CompletionReport["verification"] = [];
  #delegated: CompletionReport["delegatedTasks"] = [];
  #risks: string[] = [];
  #lastFailureSummary: string | undefined;
  #currentEffort: ReasoningEffort;
  #currentModel: string;
  #autoRoute: boolean;
  #reasoningEffortLocked: boolean;
  #serviceTier: "standard" | "fast" | undefined;
  #premiumContextPolicy: "utility-gated" | "allow" | "deny" | undefined;
  /** Any applied effect makes an automatic provider replay unsafe. */
  #sideEffectsApplied = false;
  /** Only explicitly external mutations contribute to change-review risk. */
  #externalSideEffectApplied = false;
  /**
   * Set when a mutating tool actually succeeded, independent of whether the
   * changed paths could be identified. §11.8 and AC-50 require verification to
   * be attempted whenever the workspace was touched, so gating verification on
   * a non-empty path list alone would let a turn report success with no evidence
   * after editing files.
   */
  #workspaceMutated = false;
  #turnCounter = 0;
  /** Set when the user redirects mid-turn (§11.10). */
  #redirect: string | undefined;
  /** Failed observations awaiting diagnosis in `reflecting` (§11.2). */
  #pendingFailures: Observation[] = [];
  #reflections: ReflectionAnalysis[] = [];
  /**
   * Consecutive count for the *current* failure signature only. A different
   * failure clears the map, which is what makes "three times in a row" mean in a
   * row rather than three times total.
   */
  #failureStreak = new Map<string, number>();
  /**
   * Why the turn stopped, when it stopped for a reason no budget describes.
   * Without this the partial report would borrow a budget message and claim a
   * limit that was never reached.
   */
  #stopReason: string | undefined;
  /**
   * The §11.3 wrap-up: when the tool budget runs out with model steps to
   * spare, the model gets exactly one final sample to author its own report
   * from the evidence already gathered. Without it the turn cuts straight to
   * a partial report the model never wrote — and an explorer that found
   * everything still comes back `blocked`, which is how a parent ends up
   * redoing the whole exploration itself.
   */
  #wrapUpUsed = false;
  /** Set while the wrap-up sample is in flight, so the budget guard lets it land. */
  #wrapUpInProgress = false;
  /** The wrap-up sample produced a final answer, so its completion is earned. */
  #wrapUpDelivered = false;
  /**
   * The single routing decision for the current turn. Decided once after adaptive
   * effort selection and shared by the request, the route events, the effort
   * clamp, the output budget, and the cost estimate — a second decision could
   * route the actual request to a different model than the one the events and
   * the billing named.
   */
  #turnRoute: InferencePolicyDecision | undefined;
  /** Monotonic phase route epoch; at most four route changes per turn. */
  #phase: WorkPhase = "orient";
  #routeEpoch = 0;
  /**
   * Actions the user allowed "for this turn" (§13.4). Keyed by the normalized
   * action hash, cleared when the turn ends: an `allow_turn` grant must apply to
   * the rest of the turn that asked for it and never leak into the next one.
   */
  #turnAllowedActions = new Set<string>();
  /**
   * Whether this turn already received the near-budget wrap-up nudge. Fired at
   * most once per turn: a single clear signal to conclude, not a recurring nag.
   */
  #budgetNudged = false;
  #activeInteractionMode: "build" | "plan" = "build";
  #activeDeepPlanMode: "off" | "on" = "off";

  constructor(options: KernelOptions) {
    this.#options = options;
    this.#limits = options.limits ?? ROOT_LIMITS;
    this.#now = options.now ?? (() => Date.now());
    this.#currentEffort = options.reasoningEffort ?? "medium";
    this.#currentModel = options.model;
    this.#autoRoute = options.autoRoute === true;
    this.#reasoningEffortLocked = options.reasoningEffortLocked === true;
    this.#serviceTier = options.serviceTier;
    this.#premiumContextPolicy = options.premiumContextPolicy;
    this.#providerSession = options.provider.createTurnSession?.() ?? {
      capabilities: options.provider.capabilities ?? {
        websocket: false,
        previousResponse: false,
        parallelToolCalls: false,
        nativeCompaction: false,
        fastTier: false,
        toolSearch: false,
      },
      prewarm: async () => {},
      stream: (request, signal) => options.provider.stream(request, signal),
      resetContinuation: () => {},
      close: async () => {},
    };

  }

  get history(): readonly ModelInputItem[] {
    return this.#history;
  }

  get usage(): ModelUsage {
    return this.#usage;
  }


  /** Open the reusable provider transport while repository orientation runs. */
  async prewarm(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (!this.#providerSession.capabilities.websocket) return;
    const interactionMode = this.#options.interactionMode?.() ?? "build";
    const deepPlanMode =
      interactionMode === "plan" ? this.#options.deepPlanMode?.() ?? "off" : "off";
    // A warm-up is not a work sample: it must not consume or carry the
    // token-saving directive, which belongs to the first real request.
    const { tokenSavingDirective: _tokenSavingDirective, ...warmupInputs } =
      this.#options.promptInputs();
    const compiled = assemblePrompt({
      ...warmupInputs,
      activeTools: this.#options.registry.activeToolsFor(interactionMode),
      interactionMode,
      deepPlanMode,
      history: [],
    }, { version: this.#options.promptCompiler ?? "v2" });
    await this.#providerSession.prewarm({
      requestId: "prewarm_" + this.#options.agentId + "_" + this.#now().toString(36),
      model: this.#currentModel,
      requestDigest: compiled.requestDigest,
      input: compiled.input,
      tools: compiled.tools,
      reasoning: {
        mode: this.#options.reasoningMode ?? "standard",
        effort: "none",
        summary: "none",
        context: "current_turn",
      },
      maxOutputTokens: 256,
      store: false,
      ...(this.#options.parallelToolCalls !== undefined &&
      this.#providerSession.capabilities.parallelToolCalls
        ? { parallelToolCalls: this.#options.parallelToolCalls }
        : {}),
      ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
    }, signal);
  }

  /** Release a persistent provider socket owned by this kernel. */
  async close(): Promise<void> {
    await this.#providerSession.close();
  }
  /** The effort that will be used for the next sampling step. */
  get reasoningEffort(): ReasoningEffort {
    return this.#currentEffort;
  }

  /** The model selected for the next sampling step. */
  get model(): string {
    return this.#currentModel;
  }

  /** The model the current turn is actually routed to (§10.5). */
  #routedModel(): string {
    return this.#turnRoute?.model ?? this.#currentModel;
  }

  /**
   * Root TODOs describe Build-mode work only. Plan mode deliberately leaves
   * implementation items pending until the user switches modes.
   */
  #todoCompletionGateEnabled(): boolean {
    return (
      this.#options.role === "root" &&
      this.#activeInteractionMode === "build" &&
      this.#options.todoState !== undefined
    );
  }

  /** Read TODO state fail-closed: an unavailable projection cannot earn success. */
  #unfinishedRootTodos(): TodoProjectionItem[] {
    if (!this.#todoCompletionGateEnabled()) return [];
    try {
      const state = this.#options.todoState?.();
      if (!Array.isArray(state)) throw new Error("TODO state projection was not an array");
      if (state.some((item) => typeof item.status !== "string" || typeof item.text !== "string")) {
        throw new Error("TODO state projection contained a malformed item");
      }
      return state.filter((item) => !isTodoDone(item));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `TODO state could not be read: ${detail}`;
      if (!this.#risks.includes(message)) this.#risks.push(message);
      return [{ status: "blocked", text: message }];
    }
  }

  /** Keep a withheld candidate visible to the next model sample, never to the user as final. */
  #appendWithheldFinal(items: readonly ModelInputItem[]): void {
    this.#history.push(...asIntermediateAssistantItems(items));
  }

  /**
   * Evaluate an action against the policy, honouring grants the user made for
   * this turn (§13.4). The hash is computed once by the caller because the
   * approval path needs it again to record an `allow_turn` grant.
   */
  #evaluateAction(action: ProposedAction, hash: string): PermissionDecision {
    if (this.#turnAllowedActions.has(hash)) {
      return { kind: "allow", scope: "turn", reason: "allowed for this turn" };
    }
    return evaluate(action, this.#options.permissionContext());
  }

  /** Apply an explicit user choice to the running session. */
  setReasoningEffort(effort: ReasoningEffort): void {
    this.#currentEffort = effort;
    this.#reasoningEffortLocked = true;
  }

  /** Pin the next turn to an explicit model instead of auto-routing. */
  setModel(model: string): void {
    this.#currentModel = model;
    this.#autoRoute = false;
  }

  /** The OpenAI Fast mode tier requested from the next sample on. */
  get serviceTier(): "standard" | "fast" | undefined {
    return this.#serviceTier;
  }

  /** Apply an interactive Fast mode choice to the running session. */
  setServiceTier(tier: "standard" | "fast"): void {
    this.#serviceTier = tier;
  }

  /** The premium context-band policy applied to the next route decision. */
  get premiumContextPolicy(): "utility-gated" | "allow" | "deny" | undefined {
    return this.#premiumContextPolicy;
  }

  /** Apply an interactive premium-context choice to the running session. */
  setPremiumContextPolicy(policy: "utility-gated" | "allow" | "deny"): void {
    this.#premiumContextPolicy = policy;
  }

  /** Seed history from a resumed session (§18.11). */
  /** Drop provider-owned continuation when task epoch assumptions change. */
  resetProviderContinuation(reason = "host reset"): void {
    this.#previousResponseId = undefined;
    this.#continuationHistoryCursor = 0;
    this.#continuationSignature = undefined;
    this.#providerSession.resetContinuation(reason);
  }

  #resetContinuationForHistoryRewrite(callIds: readonly string[]): void {
    if (this.#previousResponseId === undefined || callIds.length === 0) return;
    const affected = new Set(callIds);
    const anchoredThrough = Math.min(this.#continuationHistoryCursor, this.#history.length);
    for (let index = 0; index < anchoredThrough; index += 1) {
      const item = this.#history[index];
      if (item?.type === "function_call_output" && affected.has(item.callId)) {
        this.resetProviderContinuation("provider-visible historical tool output representation changed");
        return;
      }
    }
  }

  /** Adopt a freshly hydrated, caller-owned history without another full array copy. */
  adoptHydratedHistory(items: ModelInputItem[]): void {
    this.#history = items;
    // A hydrated journal has no persisted provider response to which its local
    // indices can safely refer. The next request establishes a fresh cursor.
    this.resetProviderContinuation();
  }

  /** Copy external history inputs; resume hydration uses adoptHydratedHistory instead. */
  hydrateHistory(items: readonly ModelInputItem[]): void {
    this.adoptHydratedHistory([...items]);
  }
  /** §11.10: merge a new instruction into the running turn. */
  redirect(text: string): void {
    this.#redirect = text;
  }

  /** Run one turn to a terminal state. */
  async runTurn(userInput: string, signal: AbortSignal): Promise<TurnResult> {
    this.#turnCounter += 1;
    const turnId = `turn_${this.#turnCounter}`;
    this.#activeInteractionMode = this.#options.interactionMode?.() ?? "build";
    this.#activeDeepPlanMode =
      this.#activeInteractionMode === "plan"
        ? this.#options.deepPlanMode?.() ?? "off"
        : "off";
    const machine = new TurnStateMachine("idle");
    const budget = newBudget(this.#now());
    const traceStartedAt = this.#now();
    // Every field that describes *this* turn starts empty. Anything left over
    // from a previous turn — changed files, risks, usage, verification results,
    // the fact that a mutation happened at all — would otherwise leak into the
    // next report and make a fresh turn claim another turn's work.
    this.#usage = emptyUsage();
    this.#options.budgetController?.reset();
    this.#observations = [];
    this.#changedFiles.clear();
    this.#verification = [];
    this.#delegated = [];
    this.#risks = [];
    this.#lastFailureSummary = undefined;
    this.#sideEffectsApplied = false;
    this.#externalSideEffectApplied = false;
    this.#workspaceMutated = false;
    this.#pendingFailures = [];
    this.#reflections = [];
    this.#reviewFindings = [];
    this.#failureStreak.clear();
    this.#stopReason = undefined;
    this.#wrapUpUsed = false;
    this.#wrapUpInProgress = false;
    this.#wrapUpDelivered = false;
    this.#pendingCalls = [];
    this.#turnRoute = undefined;
    this.#phase = "orient";
    this.#routeEpoch = 0;
    this.#turnAllowedActions.clear();
    this.#budgetNudged = false;
    this.#previousResponseFallbackUsed = false;
    this.#providerContextRecoveryUsed = false;

    const taskEpochId = this.#options.taskEpochId?.();
    const workspaceIdentityDigest = this.#options.workspaceIdentityDigest?.();
    const emit = <T>(kind: CbcEventKind, payload: T) =>
      this.#options.emitter.emit(kind, payload, {
        turnId,
        agentId: this.#options.agentId,
        ...(this.#options.callerId !== undefined ? { callerId: this.#options.callerId } : {}),
        ...(taskEpochId !== undefined ? { taskEpochId } : {}),
        ...(workspaceIdentityDigest !== undefined ? { workspaceIdentityDigest } : {}),
      });

    emit("run.trace_started", {
      turnId,
      agentId: this.#options.agentId,
      role: this.#options.role,
      interactionMode: this.#activeInteractionMode,
    });

    const budgetController = this.#options.budgetController;
    if (budgetController !== undefined) {
      emit("budget.plan_created", { mode: budgetController.mode, ...budgetController.snapshot() });
    }

    machine.apply("submit");

    if (userInput.trim().length === 0) {
      machine.apply("invalid_input");
      const report = { ...partialReport("received an empty request"), status: "failed" as const };
      emit("run.trace_completed", {
        turnId,
        status: "failed",
        durationMs: Math.max(0, this.#now() - traceStartedAt),
        reason: "empty_input",
      });
      emit("turn.completed", { status: "failed" });
      return this.#finish(turnId, machine, report, budget);
    }

    // ---- Adaptive effort (§10.4) ----
    this.#selectEffort(emit);

    // Compile once before routing. This is both the source of the routing token
    // count and the exact object used by the first provider request; rebuilding
    // after the route callback could make cache/context planning describe a
    // different prompt than the model receives.
    const firstPrompt = await this.#compilePrompt(userInput, emit);

    // ---- Routing: decided exactly once per turn, before any event or request
    // can name a model (§10.5). Every consumer — the route events below,
    // `turn.started`, each provider request, and the cost estimate — reads this
    // same decision.
    this.#turnRoute = this.#decideRoute(firstPrompt, userInput);
    this.#routeEpoch = this.#turnRoute === undefined ? 0 : 1;
    if (this.#turnRoute !== undefined) {
      this.#emitRouteEvents(this.#turnRoute, emit);
      try {
        this.#options.onRouteDecided?.(this.#turnRoute, firstPrompt);
      } catch {
        // Host planning (cache economics, context events) is best-effort; its
        // failure must not stop the turn it was planning.
      }
    }

    emit("turn.started", {
      model: this.#turnRoute?.model ?? this.#currentModel,
      reasoning: {
        mode: this.#turnRoute?.mode ?? this.#options.reasoningMode ?? "standard",
        effort: this.#turnRoute?.effort ?? this.#currentEffort,
      },
      permissionMode: this.#options.permissionContext().mode,
      interactionMode: this.#activeInteractionMode,
      agentId: this.#options.agentId,
      role: this.#options.role,
    });

    machine.apply("context_built");

    let pendingUserInput: string | undefined = userInput;
    let pendingCompiledPrompt: CompiledModelRequest | undefined = firstPrompt;
    let finalText = "";
    // A no-tool provider response is only a candidate final until the TODO and
    // verification gates accept it. Keeping it out of history until then lets us
    // reclassify it as commentary when the loop must continue.
    let pendingFinalItems: readonly ModelInputItem[] = [];
    /** Provider output identity for the candidate currently awaiting the gates. */
    let finalItemId: string | undefined;
    let pendingFinalCameFromWrapUp = false;
    let retryAttempt = 0;
    let abandonedApproach: ReflectionAnalysis | undefined;

    // ---- Main loop ----
    while (!machine.terminal) {
      if (signal.aborted) {
        machine.tryApply("cancel");
        break;
      }

      const exhaustion = budgetExhausted(budget, this.#limits, this.#now());
      if (
        exhaustion !== undefined &&
        !machine.isIn("verifying") &&
        !this.#wrapUpInProgress
      ) {
        if (
          exhaustion === "tool_calls" &&
          !this.#wrapUpUsed &&
          machine.isIn("observing") &&
          pendingUserInput === undefined &&
          budget.modelSteps < this.#limits.maxModelSteps
        ) {
          // §11.3 wrap-up: the tool budget is gone but model steps remain.
          // Reflection exists to correct tool use, and with no tool calls left
          // there is nothing left to correct — the one useful move is an
          // authored report from the evidence already gathered. Grant exactly
          // one final sample for it, then fall through to the honest report.
          this.#wrapUpUsed = true;
          this.#wrapUpInProgress = true;
          pendingUserInput = TOOL_BUDGET_WRAP_UP_PROMPT;
          emit("assistant.commentary", {
            text: `Tool budget exhausted after ${budget.toolCalls} call(s); requesting the final report from gathered evidence.`,
          });
          machine.apply("budget_remains");
        } else {
          // §11.3: never stop silently; move to verification so a partial report
          // is still produced. If the current state has no `budget_exhausted`
          // edge, verification is unreachable and the loop must stop here.
          machine.tryApply("budget_exhausted");
          if (!machine.isIn("verifying")) break;
        }
      }

      switch (machine.state) {
        case "sampling": {
          budget.modelSteps += 1;
          const sampledInput = pendingUserInput;
          const compiledPrompt = pendingCompiledPrompt;
          pendingCompiledPrompt = undefined;
          const stepResult = await this.#sample(
            sampledInput,
            turnId,
            signal,
            emit,
            compiledPrompt,
          );
          // Whatever this sample returns, the wrap-up flight is over: a final
          // answer earns the completion, anything else consumes the one grant.
          const wrapUpSample = this.#wrapUpInProgress;
          this.#wrapUpInProgress = false;
          // Keep every instruction in the provider-linked history. The current
          // input is sent as the variable suffix for this request, then recorded
          // immediately so a follow-up tool step and the next turn see it too.
          if (sampledInput !== undefined && sampledInput.trim().length > 0) {
            this.#history.push({
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: sampledInput }],
            });
          }
          pendingUserInput = undefined;

          if (stepResult.kind === "cancelled") {
            machine.tryApply("cancel");
            break;
          }
          if (stepResult.kind === "error") {
            if (
              stepResult.error.kind === "context_length" &&
              !this.#providerContextRecoveryUsed &&
              this.#options.onProviderContextError !== undefined
            ) {
              this.#providerContextRecoveryUsed = true;
              machine.apply("provider_error");
              await this.#options.onProviderContextError();
              emit("context.compaction_emergency", {
                trigger: "provider_context_error",
                reasonCodes: ["provider_context_error"],
                recompileLimit: 1,
              });
              this.resetProviderContinuation("provider context length error");
              machine.apply("retry_ready");
              pendingCompiledPrompt = undefined;
              break;
            }
            if (
              this.#options.continuationMode === "previous_response" &&
              !this.#previousResponseFallbackUsed &&
              (
                stepResult.error.code === "previous_response_not_found" ||
                /previous[_ ]response.+not found/iu.test(stepResult.error.message)
              )
            ) {
              this.#previousResponseFallbackUsed = true;
              machine.apply("provider_error");
              emit("provider.fallback", {
                requestId: turnId + "_step_" + (this.#observations.length + 1),
                from: this.#providerSession.transport ?? "http_previous",
                to: this.#providerSession.transport ?? "http_previous",
                reason: "previous_response_not_found; retrying once with full local history",
                continuation: "full_replay",
              });
              this.resetProviderContinuation("previous_response_not_found");
              machine.apply("retry_ready");
              break;
            }
            const decision = decideRetry(stepResult.error, retryAttempt, {
              sideEffectsAlreadyApplied: this.#sideEffectsApplied,
              externalSideEffectsAlreadyApplied: this.#externalSideEffectApplied,
            });
            machine.apply("provider_error");
            if (!decision.retry) {
              this.#lastFailureSummary = `provider error (${stepResult.error.kind}): ${stepResult.error.message}`;
              this.#risks.push(`provider error: ${stepResult.error.message}`);
              emit("error.provider", {
                message: stepResult.error.message,
                kind: stepResult.error.kind,
                retryable: stepResult.error.retryable,
                reason: decision.reason,
              });
              machine.apply("irrecoverable");
              break;
            }
            retryAttempt = decision.attempt;
            // §10.13 / AC-42: one compact retry notification.
            emit("notification.retry", {
              attempt: decision.attempt,
              delayMs: decision.delayMs,
              reason: stepResult.error.kind,
            });
            await sleep(decision.delayMs, signal);
            machine.apply("retry_ready");
            break;
          }

          if (stepResult.kind === "incomplete") {
            // Preserve the provider's opaque items and visible fragment as
            // intermediate context for a user-led continuation. It is never
            // accepted as final-answer history for this turn.
            this.#history.push(...stepResult.items);
            const reason = `provider response was incomplete (${stepResult.reason})`;
            this.#stopReason = reason;
            this.#risks.push(reason);
            finalText = stepResult.partialText.length > 0
              ? `[Partial provider response: ${stepResult.reason}]\n\n${stepResult.partialText}`
              : `[Partial provider response: ${stepResult.reason}]`;
            finalItemId = stepResult.itemId;
            // Do not retry/verify/complete a terminal provider truncation as if it
            // were a normal candidate final. A later user turn can continue with
            // the visible partial result and explicit reason.
            machine.apply("response_incomplete");
            break;
          }

          retryAttempt = 0;
          if (stepResult.kind === "tool_calls") {
            machine.apply("tool_calls");
            // Carry the model's own items forward so replay stays faithful.
            this.#history.push(...stepResult.items);
            this.#pendingCalls = stepResult.calls;
            break;
          }

          // A no-tool response is a candidate final. `verifying` decides whether
          // it is earned; unfinished root TODOs turn it into context for a
          // continuation instead of exposing it as a durable final answer.
          finalText = stepResult.text;
          pendingFinalItems = stepResult.items;
          finalItemId = stepResult.itemId;
          pendingFinalCameFromWrapUp = wrapUpSample;
          machine.apply("final_answer");
          break;
        }

        case "tool_selection": {
          const outcome = await this.#runPendingCalls(turnId, budget, signal, emit, machine);
          if (outcome === "cancelled") {
            machine.tryApply("cancel");
          }
          break;
        }

        case "observing": {
          if (this.#redirect !== undefined) {
            // §11.10 interrupt and redirect: fold the new instruction in.
            pendingUserInput = this.#redirect;
            this.#redirect = undefined;
            emit("turn.interrupted", { reason: "user redirected the current turn" });
          }
          // §11.2: a failed observation is diagnosed before the next sample, so
          // the model is handed a cause instead of a raw error to guess from.
          if (this.#pendingFailures.length > 0) {
            if (this.#reflectionAvailable(budget)) {
              machine.apply("reflection_needed");
              break;
            }
            // Out of reflection budget: drop the queue and say so once, rather
            // than re-checking it on every pass through `observing`.
            this.#dropPendingFailures();
          }
          const exhausted = budgetExhausted(budget, this.#limits, this.#now());
          this.#nudgeIfBudgetNearlySpent(budget, exhausted, (text) => {
            pendingUserInput = text;
          });
          machine.apply(exhausted === undefined ? "budget_remains" : "budget_exhausted");
          break;
        }

        case "reflecting": {
          budget.reflectionCycles += 1;
          const analysis = await this.#reflect(signal, emit);
          if (analysis === undefined) {
            // Nothing left to diagnose; fall through to the honest report.
            machine.apply("accepted");
            break;
          }

          if (analysis.attempts >= MAX_CONSECUTIVE_SAME_FAILURE) {
            // §11.3: a fourth identical attempt is repetition, not correction.
            // The turn stops and the decision goes back to the user.
            this.#stopReason = `hit the same failure ${analysis.attempts} times in a row (${analysis.errorCategory}: ${analysis.rootCause})`;
            this.#risks.push(
              `self-correction gave up after ${analysis.attempts} identical ${analysis.toolId} failures: ${analysis.rootCause}`,
            );
            emit("assistant.commentary", {
              text: `Stopping self-correction: ${analysis.toolId} failed the same way ${analysis.attempts} times. ${analysis.correctiveAction}`,
              commentaryKind: "recovery",
            });
            machine.apply("budget_exhausted");
            break;
          }

          pendingUserInput = renderReflectionPrompt(analysis);
          if (analysis.approachInvalid) {
            abandonedApproach = analysis;
            machine.apply("plan_invalidated");
          } else {
            machine.apply("hypothesis_updated");
          }
          break;
        }

        case "re_planning": {
          // A logic failure can invalidate the changes themselves. An
          // authorization or environment failure only blocks continuation, so
          // preserve already committed files while the replacement plan is made.
          await this.#rollbackAbandonedApproach(signal, emit, abandonedApproach);
          abandonedApproach = undefined;
          pendingUserInput = this.#rePlanPrompt(pendingUserInput);
          machine.apply("correction_ready");
          break;
        }

        case "verifying": {
          // A root TODO is a build obligation, not merely report metadata. Check
          // before verification so an optimistic no-tool answer cannot make the
          // turn terminal while work remains.
          const unfinishedBeforeVerification = this.#unfinishedRootTodos();
          const continuableBeforeVerification = unfinishedBeforeVerification.filter(isContinuableTodo);
          if (continuableBeforeVerification.length > 0) {
            const exhausted = budgetExhausted(budget, this.#limits, this.#now());
            if (exhausted === undefined) {
              const withheldText = finalText.trim();
              const withheldItemId = finalItemId;
              this.#appendWithheldFinal(pendingFinalItems);
              pendingFinalItems = [];
              pendingFinalCameFromWrapUp = false;
              if (withheldText.length > 0) {
                emit("assistant.commentary", {
                  text: withheldText,
                  ...(withheldItemId !== undefined ? { itemId: withheldItemId } : {}),
                });
              }
              finalText = "";
              finalItemId = undefined;
              pendingUserInput = renderTodoContinuationPrompt(unfinishedBeforeVerification);
              emit("assistant.commentary", {
                text: `Continuing: ${describeUnfinishedTodos(continuableBeforeVerification)}. The final answer is withheld until this work is resolved.`,
                commentaryKind: "verification",
              });
              machine.apply("todo_incomplete");
              break;
            }

            const message = `TODO has ${describeUnfinishedTodos(unfinishedBeforeVerification)}`;
            this.#appendWithheldFinal(pendingFinalItems);
            pendingFinalItems = [];
            pendingFinalCameFromWrapUp = false;
            finalText = renderUnfinishedTodoAnswer(unfinishedBeforeVerification);
            this.#stopReason = `${message}; ${describeExhaustion(exhausted, this.#limits)}`;
            machine.apply("todo_unresolved");
            break;
          }

          const verdict = await this.#verify(turnId, budget, signal, emit);
          if (verdict === "repair" && budget.repairCycles < this.#limits.maxRepairCycles) {
            // The candidate answer described an unaccepted change, so preserve it
            // only as intermediate context for the repair loop.
            const withheldText = finalText.trim();
            const withheldItemId = finalItemId;
            this.#appendWithheldFinal(pendingFinalItems);
            pendingFinalItems = [];
            pendingFinalCameFromWrapUp = false;
            if (withheldText.length > 0) {
              emit("assistant.commentary", {
                text: withheldText,
                ...(withheldItemId !== undefined ? { itemId: withheldItemId } : {}),
              });
            }
            finalText = "";
            finalItemId = undefined;
            budget.repairCycles += 1;
            const repairText = this.#repairPrompt();
            if (this.#reflectionAvailable(budget)) {
              // §11.8: a rejected verification is diagnosed before it is
              // repaired, so the repair addresses a cause rather than a symptom.
              this.#noteFailure({
                toolId: "verification.review",
                callId: `review_${budget.reviewCycles}`,
                code: "REVIEW_BLOCKING",
                message: "an independent review rejected the change",
                text: repairText,
              });
              machine.apply("reflection_needed");
              break;
            }
            pendingUserInput = repairText;
            machine.apply("needs_repair");
            break;
          }

          // Re-read after verification as well. This covers a TODO update that
          // arrives while a test/review is running and makes blocked/skipped work
          // a partial turn rather than a completed one.
          const unfinishedAfterVerification = this.#unfinishedRootTodos();
          if (unfinishedAfterVerification.length > 0) {
            const continuableAfterVerification = unfinishedAfterVerification.filter(isContinuableTodo);
            const exhausted = budgetExhausted(budget, this.#limits, this.#now());
            if (continuableAfterVerification.length > 0 && exhausted === undefined) {
              const withheldText = finalText.trim();
              const withheldItemId = finalItemId;
              this.#appendWithheldFinal(pendingFinalItems);
              pendingFinalItems = [];
              pendingFinalCameFromWrapUp = false;
              if (withheldText.length > 0) {
                emit("assistant.commentary", {
                  text: withheldText,
                  ...(withheldItemId !== undefined ? { itemId: withheldItemId } : {}),
                });
              }
              finalText = "";
              finalItemId = undefined;
              pendingUserInput = renderTodoContinuationPrompt(unfinishedAfterVerification);
              emit("assistant.commentary", {
                text: `Continuing: ${describeUnfinishedTodos(continuableAfterVerification)}. The final answer is withheld until this work is resolved.`,
              });
              machine.apply("todo_incomplete");
              break;
            }

            const message = `TODO has ${describeUnfinishedTodos(unfinishedAfterVerification)}`;
            this.#appendWithheldFinal(pendingFinalItems);
            pendingFinalItems = [];
            pendingFinalCameFromWrapUp = false;
            finalText = renderUnfinishedTodoAnswer(unfinishedAfterVerification);
            this.#stopReason = exhausted === undefined
              ? message
              : `${message}; ${describeExhaustion(exhausted, this.#limits)}`;
            machine.apply("todo_unresolved");
            break;
          }

          // Only an accepted candidate becomes durable final-answer history.
          this.#history.push(...pendingFinalItems);
          pendingFinalItems = [];
          if (pendingFinalCameFromWrapUp) this.#wrapUpDelivered = true;
          pendingFinalCameFromWrapUp = false;
          const nonModelExhaustion = budgetExhausted(
            budget,
            { ...this.#limits, maxModelSteps: Number.POSITIVE_INFINITY },
            this.#now(),
          );
          if (nonModelExhaustion !== undefined && !this.#wrapUpDelivered) {
            machine.apply("budget_exhausted");
            break;
          }
          // The model-step ceiling limits whether another sample may start; it
          // must not invalidate a final answer returned by the last permitted
          // sample. Other exhausted budgets retain their previous partial result.
          // The TODO and verification gates above have already decided
          // that no more work is required. Reclassifying that accepted answer as
          // partial is how a child that finished on step N was shown as BLOCKED
          // when its budget was exactly N steps.
          machine.apply("accepted");
          break;
        }

        case "cancelling": {
          machine.apply("cancel_complete");
          break;
        }

        default:
          // `preparing`, `executing`, and `awaiting_approval` are driven inside
          // the helpers above; reaching here means the loop has nothing to do.
          machine.tryApply("cancel");
          break;
      }
    }

    // ---- Build the report ----
    let report: CompletionReport;
    const exhaustion = budgetExhausted(budget, this.#limits, this.#now());

    if (machine.state === "cancelled") {
      report = {
        status: "cancelled",
        summary: finalText.length > 0 ? `${finalText} (cancelled)` : "The turn was cancelled.",
        changedFiles: this.#changedFileList(),
        verification: this.#verification,
        delegatedTasks: this.#delegated,
        risks: [...this.#risks, "the turn was cancelled before completing"],
        nextStep: "review any changes that were already applied",
      };
    } else if (machine.state === "failed") {
      report = {
        status: "failed",
        summary: finalText.length > 0 ? finalText : this.#lastFailureSummary ?? "The turn failed.",
        changedFiles: this.#changedFileList(),
        verification: this.#verification,
        delegatedTasks: this.#delegated,
        risks: this.#risks,
      };
    } else if (
      machine.state === "partial" ||
      (exhaustion !== undefined && machine.state !== "completed")
    ) {
      // A turn can reach `partial` without any budget being exhausted — the
      // three-strikes rule in §11.3 is the case. Borrowing a budget message
      // there would report a limit that was never reached. The mirror case is
      // a wrap-up that delivered a final answer: the exhaustion is real, but
      // the state machine accepted the report, so it is authored, not borrowed.
      const reason =
        exhaustion !== undefined
          ? describeExhaustion(exhaustion, this.#limits)
          : (this.#stopReason ?? "the turn stopped before completion");
      report = partialReport(reason, {
        // `exactOptionalPropertyTypes` forbids an explicit `undefined` here, so
        // the key is omitted entirely when there is no text to carry over.
        ...(finalText.length > 0 ? { summary: finalText } : {}),
        changedFiles: this.#changedFileList(),
        verification: this.#verification,
        delegatedTasks: this.#delegated,
        risks: this.#risks,
      });
    } else {
      report = {
        status: "completed",
        summary: finalText,
        changedFiles: this.#changedFileList(),
        verification: this.#verification,
        delegatedTasks: this.#delegated,
        risks: this.#risks,
      };
    }

    // AC-50: the report cannot claim unearned success.
    const { report: truthful, issues } = enforceTruthfulness(report);
    const hostCoverage = this.#options.verificationCoverage?.() ?? {};
    const coverage = buildVerificationCoverage({
      changedFiles: truthful.changedFiles.length,
      verification: truthful.verification,
      ...(hostCoverage.changedSymbols !== undefined ? { changedSymbols: hostCoverage.changedSymbols } : {}),
      ...(hostCoverage.staleEvidence !== undefined ? { staleEvidence: hostCoverage.staleEvidence } : {}),
      ...(hostCoverage.unresolvedOperations !== undefined ? { unresolvedOperations: hostCoverage.unresolvedOperations } : {}),
      ...(hostCoverage.highRiskFindings !== undefined ? { highRiskFindings: hostCoverage.highRiskFindings } : {}),
    });
    let finalReport = truthful;
    if (finalReport.status === "completed" && coverage.coverageStatus !== "complete") {
      const message = `verification coverage is ${coverage.coverageStatus}: ${coverage.failedChecks} failed, ${coverage.notRunChecks} not run, ${coverage.staleEvidence} stale evidence, ${coverage.unresolvedOperations} unresolved operation(s)`;
      issues.push({ field: "verificationCoverage", message });
      finalReport = {
        ...finalReport,
        status: "partial",
        risks: [...finalReport.risks, message],
        nextStep: "run the missing verification and refresh stale evidence before claiming completion",
      };
    }
    // Defense in depth for a TODO mutation that races the final acceptance check.
    // The normal path above continues sampling before a final answer is emitted.
    const unfinishedTodo = this.#unfinishedRootTodos();
    if (unfinishedTodo.length > 0) {
      const message = `TODO has ${describeUnfinishedTodos(unfinishedTodo)}`;
      const nextStep = unfinishedTodo[0]?.text;
      // Preserve the policy signal even when the pre-final gate already made
      // the report partial; consumers use it to explain why completion stopped.
      if (!issues.some((issue) => issue.field === "todo" && issue.message === message)) {
        issues.push({ field: "todo", message });
      }
      if (finalReport.status === "completed") {
        // Never render the provider's optimistic answer after a late TODO check
        // invalidates it. The deterministic partial text is deliberately used for
        // both `text` and `answer` below.
        finalText = renderUnfinishedTodoAnswer(unfinishedTodo);
        finalReport = {
          ...finalReport,
          status: "partial",
          risks: finalReport.risks.includes(message)
            ? finalReport.risks
            : [...finalReport.risks, message],
          ...(nextStep === undefined ? {} : { nextStep }),
        };
      } else if (finalReport.status !== "cancelled") {
        // A rejected TODO can exhaust the recovery loop before another model
        // answer exists. Do not emit an empty user-facing answer in that case.
        if (finalText.length === 0) finalText = renderUnfinishedTodoAnswer(unfinishedTodo);
        finalReport = {
          ...finalReport,
          risks: finalReport.risks.includes(message)
            ? finalReport.risks
            : [...finalReport.risks, message],
          ...(nextStep === undefined ? {} : { nextStep }),
        };
      }
    }
    // A corrected completion report is terminal, not a provider retry. Reusing
    // `notification.retry` here made the UI promise "Reconnecting..." even
    // though the turn was about to stop with a partial result. The durable
    // `verification.blocked_completion` event below carries these issues instead.

    // Final event order is a contract (§20.7): the answer lands first, then the
    // verification evidence, then exactly one terminal event. Emitting the
    // terminal event before `assistant.final` let the reducer finish the turn
    // and then be pushed back into `verifying` by the late final answer.
    const presentation = deriveCompletionPresentation(finalReport, finalText);
    emit("assistant.final", {
      // The text is the user-facing answer; the structured report remains separate.
      text: finalText.length > 0 ? finalText : finalReport.summary,
      answer: finalText,
      ...(finalItemId !== undefined ? { itemId: finalItemId } : {}),
      report: finalReport,
      presentation,
    });
    emit("verification.coverage_updated", coverage);
    if (issues.length > 0) {
      emit("verification.blocked_completion", {
        reasons: issues.map((issue) => issue.message),
        policy: "false_complete_policy:block",
      });
    }
    emit("run.trace_completed", {
      turnId,
      status: finalReport.status,
      durationMs: Math.max(0, this.#now() - traceStartedAt),
      modelSteps: budget.modelSteps,
      toolCalls: budget.toolCalls,
      reviewCycles: budget.reviewCycles,
      completionGate: coverage.coverageStatus,
    });

    if (machine.state === "cancelled") {
      emit("turn.cancelled", { reason: "user cancelled" });
    } else {
      emit("turn.completed", {
        status: finalReport.status,
        changedFiles: finalReport.changedFiles.map((f) => f.path),
        tests: summarizeTests(finalReport.verification),
      });
    }
    return this.#finish(turnId, machine, finalReport, budget, finalText);
  }

  #pendingCalls: PendingCall[] = [];

  #finish(
    turnId: string,
    machine: TurnStateMachine,
    report: CompletionReport,
    budget: BudgetState,
    answer = "",
  ): TurnResult {
    return {
      turnId,
      state: machine.state,
      report,
      presentation: deriveCompletionPresentation(report, answer),
      answer,
      usage: this.#usage,
      estimatedCostUsd: estimateCostUsd(this.#routedModel(), this.#usage),
      budget,
      observations: [...this.#observations],
      reflections: [...this.#reflections],
      stateHistory: machine.history,
      history: [...this.#history],
    };
  }

  /** Reflections recorded so far, for the §18.4 recent-failure weight. */
  get reflections(): readonly ReflectionAnalysis[] {
    return this.#reflections;
  }

  #selectEffort(emit: <T>(kind: CbcEventKind, payload: T) => void): void {
    const model = findModel(this.#currentModel);
    if (!model) return;

    const requested = this.#currentEffort;
    const normalized = clampEffortToModel(model, requested);
    if (normalized.clamped !== undefined) {
      this.#currentEffort = normalized.effort;
      emit("model.route_escalated", {
        text: `Reasoning adjusted: ${normalized.clamped.from} → ${normalized.effort} · ${normalized.clamped.reason}`,
        reasoningEffort: this.#currentEffort,
      });
      return;
    }
    const features = this.#options.complexity?.();
    if (!features || this.#reasoningEffortLocked) return;
    const decision = selectEffort(features, model);
    if (decision.effort !== this.#currentEffort) {
      const from = this.#currentEffort;
      this.#currentEffort = decision.effort;
      emit("assistant.commentary", {
        text: effortChangeLine(from, this.#currentEffort, decision.reason),
        reasoningEffort: this.#currentEffort,
      });
    }
    if (decision.clamped) {
      emit("model.route_escalated", {
        text: `Reasoning adjusted: ${decision.clamped.from} → ${this.#currentEffort} · ${decision.clamped.reason}`,
        reasoningEffort: this.#currentEffort,
      });
    }
  }

  /** Compile one provider prompt after best-effort context maintenance. */
  async #compilePrompt(
    userInput: string | undefined,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<CompiledModelRequest> {
    const prepareStartedAt = this.#now();
    emit("context.prepare_started", {
      historyItems: this.#history.length,
      continuationMode: this.#options.continuationMode ?? "client_managed",
    });
    try {
      await this.#options.beforeSample?.();
    } catch {
      // Context maintenance is best-effort; retain the prior safe view rather
      // than aborting the provider turn it was meant to protect.
    }
    emit("context.prepare_completed", {
      durationMs: Math.max(0, this.#now() - prepareStartedAt),
      historyItems: this.#history.length,
    });

    let history: readonly ModelInputItem[] = this.#history;
    const cacheBefore = promptMaterializationCacheStats();
    const compileStartedAt = this.#now();
    let promptInputs = this.#options.promptInputs();
    this.#resetContinuationForHistoryRewrite(
      promptInputs.historyRewriteCallIds ?? [],
    );
    const historyForPrompt = (): readonly ModelInputItem[] =>
      this.#options.continuationMode === "previous_response" &&
      this.#providerSession.capabilities.previousResponse &&
      this.#previousResponseId !== undefined
        ? this.#history.slice(this.#continuationHistoryCursor)
        : this.#history;
    history = historyForPrompt();
    emit("prompt.compile_started", {
      historyItems: history.length,
      fullReplay: history === this.#history,
    });
    const bindContinuationDialogue = (inputs: PromptInputs): PromptInputs =>
      history === this.#history || inputs.contextProjection === undefined
        ? inputs
        : {
            ...inputs,
            contextProjection: reprojectPromptContextDialogue(
              inputs.contextProjection,
              history,
            ),
          };
    promptInputs = bindContinuationDialogue(promptInputs);
    const assemble = (inputs: PromptInputs): CompiledModelRequest => assemblePrompt({
      ...inputs,
      activeTools: this.#options.registry.activeToolsFor(this.#activeInteractionMode),
      interactionMode: this.#activeInteractionMode,
      deepPlanMode: this.#activeDeepPlanMode,
      history,
      ...(userInput !== undefined ? { userInput } : {}),
    }, { version: this.#options.promptCompiler ?? "v2" });
    let compiled = assemble(promptInputs);
    let projectionMismatches = contextProjectionMismatches(promptInputs, compiled);
    if (projectionMismatches.length > 0) {
      const reason = projectionMismatches.join("; ");
      emit("context.evidence_rejected", {
        evidenceId: `context-projection-${this.#turnCounter}`,
        reason: `provider projection identity mismatch; retrying compilation: ${reason}`,
      });
      try {
        await this.#options.beforeSample?.();
      } catch {
        // The retry still uses the last safe prompt inputs when maintenance fails.
      }
      promptInputs = this.#options.promptInputs();
      this.#resetContinuationForHistoryRewrite(
        promptInputs.historyRewriteCallIds ?? [],
      );
      history = historyForPrompt();
      promptInputs = bindContinuationDialogue(promptInputs);
      compiled = assemble(promptInputs);
      projectionMismatches = contextProjectionMismatches(promptInputs, compiled);
      if (projectionMismatches.length > 0) {
        const finalReason = projectionMismatches.join("; ");
        compiled = {
          ...compiled,
          contextProjectionMismatch: finalReason,
        };
        emit("context.evidence_rejected", {
          evidenceId: `context-projection-${this.#turnCounter}`,
          reason: `provider projection identity mismatch after retry: ${finalReason}`,
        });
      }
    }
    const cacheAfter = promptMaterializationCacheStats();
    const taskEpochId = this.#options.taskEpochId?.();
    const result: CompiledModelRequest = taskEpochId === undefined
      ? compiled
      : { ...compiled, taskEpochId };
    emit("prompt.compile_completed", {
      durationMs: Math.max(0, this.#now() - compileStartedAt),
      packId: result.packId,
      requestDigest: result.requestDigest,
      inputTokens: result.inputTokens,
      stablePrefixTokens: result.stablePrefixTokens,
      serializedInputBytes: result.serializedInput.length,
      serializedToolBytes: result.serializedTools.length,
      stableCacheHits: cacheAfter.stableHits - cacheBefore.stableHits,
      stableCacheMisses: cacheAfter.stableMisses - cacheBefore.stableMisses,
      toolSchemaCacheHits: cacheAfter.toolSchemaHits - cacheBefore.toolSchemaHits,
      toolSchemaCacheMisses: cacheAfter.toolSchemaMisses - cacheBefore.toolSchemaMisses,
    });
    return result;
  }

  /** The turn's one routing decision; `undefined` when no policy is wired. */
  #phaseForSample(): WorkPhase {
    if (this.#lastFailureSummary !== undefined || this.#reflections.length > 0) return "repair";
    if (this.#workspaceMutated) return "implement";
    if (this.#observations.length > 0) return "investigate";
    return "orient";
  }

  /** Reconcile a route only when the work phase changes; the first route remains authoritative. */
  #maybeRouteForPhase(
    prompt: CompiledModelRequest,
    userInput: string | undefined,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): void {
    if (this.#options.phasePolicy !== true) return;
    const nextPhase = this.#phaseForSample();
    if (nextPhase === this.#phase) return;
    const previousPhase = this.#phase;
    this.#phase = nextPhase;
    emit("model.phase_changed", {
      from: previousPhase,
      to: nextPhase,
      epoch: this.#routeEpoch,
      reason: "runtime work state changed",
    });
    if (this.#routeEpoch >= 4) return;
    const nextRoute = this.#decideRoute(prompt, userInput ?? "", nextPhase);
    if (nextRoute === undefined) return;
    const previousRoute = this.#turnRoute;
    if (
      previousRoute !== undefined &&
      previousRoute.model === nextRoute.model &&
      previousRoute.mode === nextRoute.mode &&
      previousRoute.effort === nextRoute.effort &&
      previousRoute.intent === nextRoute.intent
    ) {
      return;
    }
    this.#routeEpoch += 1;
    this.#turnRoute = nextRoute;
    emit("model.route_changed", {
      epoch: this.#routeEpoch,
      phase: nextPhase,
      from: previousRoute === undefined
        ? undefined
        : { model: previousRoute.model, mode: previousRoute.mode, effort: previousRoute.effort, intent: previousRoute.intent },
      to: { model: nextRoute.model, mode: nextRoute.mode, effort: nextRoute.effort, intent: nextRoute.intent },
      reason: "phase-aware route reconciliation",
    });
    try {
      this.#options.onRouteDecided?.(nextRoute, prompt);
    } catch {
      // Route-dependent host telemetry/cache planning is best-effort.
    }
  }

  /** The first routing decision; later phases use route_changed epochs. */
  #decideRoute(
    prompt: CompiledModelRequest,
    userInput = "",
    phase: WorkPhase = this.#phase,
  ): InferencePolicyDecision | undefined {
    return this.#options.inferencePolicy?.decide({
      intent: this.#sampleIntent(userInput, phase),
      ...(this.#autoRoute === true ? {} : { explicitModel: this.#currentModel }),
      explicitEffort: this.#currentEffort,
      ...(this.#options.reasoningMode !== undefined ? { explicitMode: this.#options.reasoningMode } : {}),
      ...(this.#options.complexity !== undefined ? { complexity: this.#options.complexity() } : {}),
      contextTokens: prompt.inputTokens,
      configuredMaxOutputTokens: this.#options.maxOutputTokens ?? 32_000,
      needsReasoningSummary: (this.#options.reasoningSummary ?? "auto") === "auto",
      qualityFirst: this.#reasoningEffortLocked && this.#currentEffort === "max",
      ...(this.#premiumContextPolicy !== undefined ? { premiumPolicy: this.#premiumContextPolicy } : {}),
      ...(this.#options.reserveOutputTokens !== undefined ? { reserveOutputTokens: this.#options.reserveOutputTokens } : {}),
    });
  }

  #sampleIntent(userInput: string, phase: WorkPhase = this.#phase): import("@cbc/provider-openai").SampleIntent {
    if (this.#options.phasePolicy !== true) return "final";
    if (phase === "investigate") return "tool_select";
    if (phase === "implement" || phase === "repair") return "program";
    if (phase === "verify") return "tool_select";
    if (phase === "review") return "review";
    if (phase === "finalize") return "final";
    const normalized = userInput.toLowerCase();
    if (
      /\b(?:review|audit|security|deep(?:\s+|-)analysis|root[ -]cause|diagnos(?:e|is)|remediation)\b|\uB9AC\uBDF0|\uAC80\uD1A0|\uAC10\uC0AC|\uC2EC\uCE35|\uC2EC\uB3C4|\uC5C4\uACA9|\uCCA0\uC800|\uADFC\uBCF8\s*\uC6D0\uC778|\uC6D0\uC778\s*\uBD84\uC11D|\uD574\uACB0\s*\uBC29\uC548|\uC815\uBC00\s*\uBD84\uC11D|\uCDE8\uC57D\uC810/u.test(normalized)
    ) {
      return "review";
    }
    if (
      /\b(?:fix|implement|build|change|modify|refactor|add|remove|update)\b|\uC218\uC815|\uAD6C\uD604|\uACE0\uCCD0|\uBC14\uAFB8|\uCD94\uAC00|\uC0AD\uC81C|\uB9AC\uD329\uD130/u.test(normalized)
    ) {
      return "program";
    }
    if (this.#history.length === 0) return "inspect";
    return "tool_select";
  }

  /** Announce the routing decision exactly once, before anything acts on it. */
  #emitRouteEvents(
    route: InferencePolicyDecision,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): void {
    emit("model.route_decided", {
      model: route.model,
      modelTier: route.modelTier,
      intent: route.intent,
      effort: route.effort,
      mode: route.mode,
      reasoningContext: route.reasoningContext,
      contextBand: route.contextBand,
      lane: route.lane,
      maxAgents: route.maxAgents,
      maxParallelTools: route.maxParallelTools,
      maxCostUsd: route.maxCostUsd,
      phase: this.#phase,
      routeEpoch: this.#routeEpoch,
      rationaleCodes: route.rationaleCodes,
      reasonCode: route.reasonCode,
      warnings: route.warnings,
    });
    emit("model.capability_snapshot", {
      schemaVersion: route.capability.schemaVersion,
      snapshotVersion: route.capability.snapshotVersion,
      modelId: route.capability.modelId,
      digest: route.capability.digest,
      source: route.capability.source,
      contextWindow: route.capability.contextWindow,
      maxOutputTokens: route.capability.maxOutputTokens,
      native: route.capability.native,
    });
    emit("reasoning.context_effective", {
      requestedTokens: route.context.requestedTokens,
      contextBand: route.context.band,
      premium: route.context.premium,
      allowed: route.context.allowed,
      reason: route.context.reason,
    });
  }

  /** Advance local replay state after a response becomes provider-addressable. */
  #recordProviderContinuation(
    responseId: string | undefined,
    userInput: string | undefined,
    responseItems: readonly ModelInputItem[],
  ): void {
    if (
      this.#options.continuationMode !== "previous_response" ||
      !this.#providerSession.capabilities.previousResponse ||
      responseId === undefined ||
      responseId.length === 0
    ) {
      return;
    }
    this.#previousResponseId = responseId;
    this.#continuationHistoryCursor =
      this.#history.length +
      (userInput !== undefined && userInput.trim().length > 0 ? 1 : 0) +
      responseItems.length;
  }

  async #sample(
    userInput: string | undefined,
    turnId: string,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
    compiledPrompt?: CompiledModelRequest,
  ): Promise<
    | { kind: "tool_calls"; calls: PendingCall[]; items: ModelInputItem[] }
    | { kind: "final"; text: string; items: ModelInputItem[]; itemId?: string }
    | { kind: "incomplete"; reason: string; partialText: string; items: ModelInputItem[]; itemId?: string }
    | { kind: "error"; error: ProviderError }
    | { kind: "cancelled" }
  > {
    let assembled = compiledPrompt ?? await this.#compilePrompt(userInput, emit);
    if (assembled.contextProjectionMismatch !== undefined) {
      const reason = `context projection identity could not be verified: ${assembled.contextProjectionMismatch}`;
      this.#risks.push(reason);
      emit("context.evidence_rejected", {
        evidenceId: `context-projection-${this.#turnCounter}`,
        reason,
      });
      return {
        kind: "incomplete",
        reason,
        partialText: "",
        items: [],
      };
    }

    const guard = this.#options.contextPressureGuard;
    if (guard !== undefined) {
      const firstDecision = await guard(assembled);
      emit("context.pressure_evaluated", {
        state: firstDecision.decision?.state ?? "stable",
        projectedTokens: firstDecision.decision?.projectedTokens ?? assembled.inputTokens,
        requiredFreeTokens: firstDecision.decision?.requiredFreeTokens ?? 0,
        targetTokens: firstDecision.decision?.targetTokens,
        reasonCodes: firstDecision.decision?.reasonCodes ?? [],
        currentRatio: firstDecision.decision?.currentRatio,
        inputBudgetTokens: firstDecision.decision?.inputBudgetTokens,
        requestTokens: assembled.inputTokens,
      });
      if (firstDecision.action !== "accept") {
        emit("context.compaction_planned", {
          trigger: firstDecision.action === "emergency" ? "emergency_pressure" : "projected_pressure",
          targetTokens: firstDecision.targetTokens,
          projectedTokens: firstDecision.decision.projectedTokens,
          reasonCodes: firstDecision.decision.reasonCodes,
        });
        // The host callback performs the local compaction. Rebuild the exact
        // candidate once; a second pressure result is a hard safety boundary.
        assembled = await this.#compilePrompt(userInput, emit);
        const secondDecision = await guard(assembled);
        emit("context.pressure_evaluated", {
          state: secondDecision.decision?.state ?? "stable",
          projectedTokens: secondDecision.decision?.projectedTokens ?? assembled.inputTokens,
          requiredFreeTokens: secondDecision.decision?.requiredFreeTokens ?? 0,
          targetTokens: secondDecision.decision?.targetTokens,
          reasonCodes: secondDecision.decision?.reasonCodes ?? [],
          currentRatio: secondDecision.decision?.currentRatio,
          inputBudgetTokens: secondDecision.decision?.inputBudgetTokens,
          requestTokens: assembled.inputTokens,
          recompilation: 1,
        });
        if (secondDecision.action !== "accept") {
          emit(secondDecision.action === "emergency" ? "context.compaction_emergency" : "context.compaction_target_missed", {
            targetTokens: secondDecision.targetTokens,
            tokensAfter: assembled.inputTokens,
            projectedTokens: secondDecision.decision.projectedTokens,
            reasonCodes: secondDecision.decision.reasonCodes,
            recompileLimit: 1,
          });
          return {
            kind: "error",
            error: {
              kind: "context_length",
              code: "CONTEXT_BUDGET_EXCEEDED",
              message: "CONTEXT_BUDGET_EXCEEDED: adaptive compaction could not fit the next request after one recompile",
              retryable: false,
            },
          };
        }
      }
    }
    this.#maybeRouteForPhase(assembled, userInput, emit);
    // The turn's single routing decision (§10.5). Sampling steps never re-decide:
    // a second decision could disagree with the one the route events announced.
    const policyDecision = this.#turnRoute;
    const requestModelId = policyDecision?.model ?? this.#currentModel;
    const requestMode = policyDecision?.mode ?? this.#options.reasoningMode ?? "standard";
    const requestEffort = policyDecision?.effort ?? this.#currentEffort;
    const model = findModel(requestModelId);
    const scope: ReasoningContextScope = reasoningContextScope({
      isRoot: this.#options.role === "root",
      goalStable: true,
      isReviewer: this.#options.role === "reviewer",
      hypothesisInvalidated: false,
    });
    const requestedReasoningSummary = this.#options.reasoningSummary ?? "auto";
    const configuredMaxOutputTokens = this.#options.maxOutputTokens ?? 32_000;
    const providerGenerationBudget = model === undefined
      ? configuredMaxOutputTokens
      : resolveProviderGenerationBudget({
          model,
          configuredMaxOutputTokens,
          inputTokens: assembled.inputTokens,
          ...(this.#options.reserveOutputTokens !== undefined
            ? { safetyReserveTokens: this.#options.reserveOutputTokens }
            : {}),
        }).maxOutputTokens;

    const cacheKey = this.#options.cacheKey?.(assembled);
    const taskEpochId = this.#options.taskEpochId?.();
    const continuationSignature = [
      requestModelId,
      taskEpochId ?? "no-epoch",
      this.#activeInteractionMode,
      fingerprint(assembled.serializedTools),
      this.#phase,
      String(this.#routeEpoch),
    ].join(":");
    if (
      this.#previousResponseId !== undefined &&
      this.#continuationSignature !== undefined &&
      this.#continuationSignature !== continuationSignature
    ) {
      this.resetProviderContinuation("model, task epoch, toolset, or policy changed");
      this.#continuationSignature = continuationSignature;
      // The prompt was compiled while the old continuation cursor was still
      // active, so it contains only the incremental suffix. Once that provider
      // link is reset, sending the suffix as a full request can separate a
      // function call from its output. Re-enter preparation before any request or
      // budget reservation so the complete local history is compiled together.
      return await this.#sample(userInput, turnId, signal, emit);
    }
    this.#continuationSignature = continuationSignature;
    const requestId = turnId + "_step_" + (this.#observations.length + 1);
    const budgetController = this.#options.budgetController;
    if (budgetController !== undefined) {
      const predictedCostUsd = estimateCostUsd(requestModelId, {
        ...emptyUsage(),
        inputTokens: assembled.inputTokens,
        outputTokens: providerGenerationBudget,
        totalTokens: assembled.inputTokens + providerGenerationBudget,
      });
      const authorization = budgetController.authorize({
        sampleId: requestId,
        predictedInputTokens: assembled.inputTokens,
        predictedOutputTokens: providerGenerationBudget,
        predictedCostUsd,
        phase: this.#phase,
        mandatoryVerification: this.#workspaceMutated,
        mandatoryReview: this.#externalSideEffectApplied,
      });
      emit("budget.guard_triggered", {
        requestId,
        action: authorization.action,
        allowed: authorization.allowed,
        mode: authorization.mode,
        projectedUsd: authorization.projectedUsd,
        remainingUsd: authorization.remainingUsd,
        reason: authorization.reason,
        ...(authorization.degraded === undefined ? {} : { degraded: authorization.degraded }),
      });
      if (!authorization.allowed || !budgetController.reserve(requestId, predictedCostUsd)) {
        emit("budget.exhausted", {
          requestId,
          phase: this.#phase,
          reason: authorization.reason,
          projectedUsd: authorization.projectedUsd,
          remainingUsd: authorization.remainingUsd,
        });
        return {
          kind: "incomplete",
          reason: "turn budget exhausted before provider request",
          partialText: "",
          items: [],
        };
      }
    }
    const modelWindowTokens = model?.contextWindow ?? assembled.inputTokens + (this.#options.reserveOutputTokens ?? 32_000) + 8_192;
    const adaptiveLocalTargetTokens = Math.max(
      assembled.inputTokens,
      Math.floor(Math.max(1_024, modelWindowTokens - (this.#options.reserveOutputTokens ?? 32_000)) * 0.76),
    );
    const nativeThreshold = calculateNativeCompactionThreshold({
      modelWindowTokens,
      outputReserveTokens: this.#options.reserveOutputTokens ?? 32_000,
      adaptiveLocalTargetTokens,
    });
    const request: ModelRequest = {
      requestId,
      model: requestModelId,
      requestDigest: assembled.requestDigest,
      input: assembled.input,
      tools: assembled.tools,
      reasoning: {
        mode: requestMode,
        effort: requestEffort,
        summary: requestedReasoningSummary,
        context: scope,
      },
      ...(cacheKey !== undefined
        ? {
            cache: {
              key: cacheKey,
              mode: "explicit" as const,
              breakpoints: [assembled.cacheBreakpointIndex],
              ttl: "30m",
            },
          }
        : {}),
      // Provider generation capacity is resolved from model/config/context only.
      // Presentation previews must never be allowed to cap it at 512/12K.
      maxOutputTokens: Math.min(
        policyDecision?.outputTokens ?? configuredMaxOutputTokens,
        providerGenerationBudget,
      ),
      store: false,
      ...(this.#options.parallelToolCalls !== undefined &&
      this.#providerSession.capabilities.parallelToolCalls
        ? { parallelToolCalls: this.#options.parallelToolCalls }
        : {}),
      ...(this.#options.nativeCompaction === true && this.#providerSession.capabilities.nativeCompaction
        ? {
            contextManagement: [{
              type: "compaction" as const,
              compactThreshold: Math.max(
                1_024,
                this.#options.nativeCompactionDynamic === true
                  ? (nativeThreshold ?? 80_000)
                  : (this.#options.compactionThresholdTokens ?? 80_000),
              ),
            }],
          }
        : {}),
      ...(this.#serviceTier !== undefined && this.#providerSession.capabilities.fastTier ? { serviceTier: this.#serviceTier } : {}),
      ...(this.#options.callerId !== undefined ? { callerId: this.#options.callerId } : {}),
      ...(taskEpochId !== undefined ? { taskEpochId } : {}),
      ...(this.#options.continuationMode === "previous_response" &&
      this.#providerSession.capabilities.previousResponse &&
      this.#previousResponseId !== undefined
        ? { previousResponseId: this.#previousResponseId }
        : {}),
      ...(this.#options.safetyIdentifier !== undefined
        ? { safetyIdentifier: this.#options.safetyIdentifier }
        : {}),
    };
    try {
      this.#options.onPromptCompiled?.(assembled, {
        requestId,
        turnId,
        modelId: requestModelId,
        interactionMode: this.#activeInteractionMode,
      });
    } catch {
      // Telemetry/materialization observers are best-effort and must never alter
      // the provider request whose exact object they are inspecting.
    }

    const commentaryParts: string[] = [];
    const providerStartedAt = this.#now();
    const thinkingAssembler = new ThinkingAssembler({
      turnId,
      agentId: this.#options.agentId ?? "root",
      requestId: request.requestId,
      modelId: requestModelId,
      startedAtMs: providerStartedAt,
      now: this.#now,
    });
    // Live detail/summary deltas share the canonical semantic-segment identity.
    // Provider item ids remain provenance only and may differ across channels.
    let thinkingLiveId = ["thinking", turnId, this.#options.agentId ?? "root", request.requestId, "0"].join(":");
    const transport = this.#providerSession.transport ?? (
      this.#options.continuationMode === "previous_response" ? "http_previous" : "http_full"
    );
    emit("provider.connection_started", {
      requestId,
      transport,
    });
    emit("provider.request_sent", {
      requestId,
      transport,
      previousResponse: request.previousResponseId !== undefined,
      payloadBytes: assembled.serializedInput.length + assembled.serializedTools.length,
      fullPayloadBytes: request.previousResponseId === undefined ? assembled.serializedInput.length + assembled.serializedTools.length : 0,
      incrementalPayloadBytes: request.previousResponseId === undefined ? 0 : assembled.serializedInput.length + assembled.serializedTools.length,
      inputTokens: assembled.inputTokens,
      requestDigest: assembled.requestDigest,
    });
    let connectionReady = false;
    let firstDeltaObserved = false;

    const reasoningSummaryParts: string[] = [];
    let reasoningSummaryChars = 0;
    const appendReasoningSummary = (text: string): void => {
      const remaining = THINKING_MAX_SUMMARY_CHARS - reasoningSummaryChars;
      if (remaining <= 0) return;
      const bounded = text.slice(0, remaining);
      if (bounded.length === 0) return;
      reasoningSummaryParts.push(bounded);
      reasoningSummaryChars += bounded.length;
    };
    // Provider-visible reasoning is display-only; opaque content remains replay-only.
    const reasoningTextParts = new Map<string, string>();
    let reasoningTextChars = 0;
    const appendReasoningText = (itemId: string, text: string): void => {
      const previous = reasoningTextParts.get(itemId) ?? "";
      const remaining = THINKING_MAX_DETAIL_CHARS - (reasoningTextChars - previous.length);
      const bounded = text.slice(0, Math.max(0, remaining));
      const next = previous + bounded;
      reasoningTextParts.set(itemId, next);
      reasoningTextChars += next.length - previous.length;
    };
    const replaceReasoningText = (itemId: string, text: string): string => {
      const previous = reasoningTextParts.get(itemId) ?? "";
      const remaining = THINKING_MAX_DETAIL_CHARS - (reasoningTextChars - previous.length);
      const next = text.slice(0, Math.max(0, remaining));
      reasoningTextParts.set(itemId, next);
      reasoningTextChars += next.length - previous.length;
      return next;
    };
    const textParts: string[] = [];
    // `response.output_item.done` is authoritative and fills gaps when a delta
    // stream was lost or coalesced by a transport. Keep it keyed by provider item
    // identity instead of guessing from matching text.
    const authoritativeMessages = new Map<string, ModelResponseItem>();
    const authoritativeReasoning = new Map<string, ModelResponseItem>();
    let lastCommentaryItemId: string | undefined;
    let lastReasoningItemId: string | undefined;
    let lastReasoningProviderItemId: string | undefined;
    let lastReasoningTextItemId: string | undefined;
    let lastReasoningTextProviderItemId: string | undefined;
    let lastTextItemId: string | undefined;
    const deltas = new AssistantDeltaCoalescer(
      (payload) => emit("assistant.delta", payload),
      signal,
    );
    const calls = new Map<string, PendingCall>();
    const hostedStartedAt = new Map<string, number>();
    const generatedImageNotes: string[] = [];
    let failure: ProviderError | undefined;
    let incomplete: string | undefined;
    // An output item may be announced and then completed. Preserve opaque
    // continuation material once per provider item, replacing the announced
    // form with the completed one instead of replaying both.
    const opaqueItems = new Map<string, ModelInputItem>();
    let responseId: string | undefined;

    try {
      for await (const event of this.#providerSession.stream(request, signal)) {
        if (
          event.type !== "commentary.delta" &&
          event.type !== "reasoning.text.delta" &&
          event.type !== "reasoning.text.done" &&
          event.type !== "reasoning.summary.delta" &&
          event.type !== "text.delta"
        ) {
          deltas.boundary();
        }
        if (
          !firstDeltaObserved &&
          (event.type === "commentary.delta" ||
            event.type === "reasoning.text.delta" ||
            event.type === "reasoning.text.done" ||
            event.type === "reasoning.summary.delta" ||
            event.type === "text.delta" ||
            event.type === "tool.call.arguments.delta" ||
            event.type === "hosted.tool.started")
        ) {
          firstDeltaObserved = true;
          emit("provider.first_delta", {
            requestId,
            eventType: event.type,
            durationMs: Math.max(0, this.#now() - providerStartedAt),
          });
        }

        switch (event.type) {
        case "response.started":
          if (!connectionReady) {
            connectionReady = true;
            emit("provider.connection_ready", {
              requestId,
              transport,
              durationMs: Math.max(0, this.#now() - providerStartedAt),
              connectionReused: event.connectionReused === true,
            });
          }
          break;
        case "response.created":
          emit("provider.response_created", {
            requestId,
            responseId: event.responseId,
            durationMs: Math.max(0, this.#now() - providerStartedAt),
          });
          break;
        case "transport.fallback":
          emit("provider.fallback", {
            requestId,
            from: event.from,
            to: event.to,
            reason: event.reason,
          });
          break;
        case "commentary.delta": {
          commentaryParts.push(event.text);
          const itemId = event.itemId ?? `response:${request.requestId}:progress:${event.outputIndex ?? 0}`;
          lastCommentaryItemId = itemId;
          deltas.append(event.text, "progress", {
            itemId,
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
          });
          break;
        }
        case "reasoning.summary.delta": {
          const itemId = event.itemId ?? thinkingLiveId;
          lastReasoningItemId = itemId;
          if (event.itemId !== undefined) lastReasoningProviderItemId = event.itemId;
          const thinkingUpdate = thinkingAssembler.append({
            kind: "delta",
            channel: "summary",
            text: event.text,
            requestId: request.requestId,
            ...(event.itemId !== undefined ? { providerItemId: event.itemId } : {}),
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
            ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
            ...(event.deltaId !== undefined ? { deltaId: event.deltaId } : {}),
          });
          thinkingLiveId = thinkingUpdate.part.thinkingId;
          if (thinkingUpdate.changed) appendReasoningSummary(event.text);
          deltas.append(event.text, "thinking", {
            itemId,
            thinkingId: thinkingLiveId,
            channel: "summary",
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
          });
          break;
        }
        case "reasoning.text.delta": {
          const itemId = event.itemId ?? thinkingLiveId;
          lastReasoningTextItemId = itemId;
          if (event.itemId !== undefined) lastReasoningTextProviderItemId = event.itemId;
          const thinkingUpdate = thinkingAssembler.append({
            kind: "delta",
            channel: "detail",
            text: event.text,
            requestId: request.requestId,
            ...(event.itemId !== undefined ? { providerItemId: event.itemId } : {}),
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
            ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
            ...(event.deltaId !== undefined ? { deltaId: event.deltaId } : {}),
          });
          thinkingLiveId = thinkingUpdate.part.thinkingId;
          if (thinkingUpdate.changed) appendReasoningText(itemId, event.text);
          deltas.append(event.text, "thinking", {
            itemId,
            thinkingId: thinkingLiveId,
            channel: "detail",
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
          });
          break;
        }
        case "reasoning.text.done": {
          const itemId = event.itemId ?? thinkingLiveId;
          const streamed = reasoningTextParts.get(itemId);
          lastReasoningTextItemId = itemId;
          if (event.itemId !== undefined) lastReasoningTextProviderItemId = event.itemId;
          const thinkingUpdate = thinkingAssembler.append({
            kind: "replace",
            channel: "detail",
            text: event.text,
            requestId: request.requestId,
            ...(event.itemId !== undefined ? { providerItemId: event.itemId } : {}),
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
            ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
            ...(event.deltaId !== undefined ? { deltaId: event.deltaId } : {}),
            authoritative: true,
          });
          thinkingLiveId = thinkingUpdate.part.thinkingId;
          const authoritativeText = thinkingUpdate.changed
            ? replaceReasoningText(itemId, event.text)
            : reasoningTextParts.get(itemId) ?? "";
          const suffix =
            streamed === undefined
              ? authoritativeText
              : authoritativeText.startsWith(streamed)
                ? authoritativeText.slice(streamed.length)
                : "";
          if (suffix.length > 0) {
            deltas.append(suffix, "thinking", {
              itemId,
              thinkingId: thinkingLiveId,
              channel: "detail",
              ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
            });
          }
          break;
        }
        case "text.delta": {
          if (thinkingAssembler.hasOpenSegment) {
            thinkingLiveId = thinkingAssembler.boundary("final", request.requestId).part.thinkingId;
          }
          textParts.push(event.text);
          const itemId = event.itemId ?? `response:${request.requestId}:text:${event.outputIndex ?? 0}`;
          lastTextItemId = itemId;
          // A text delta is never a durable final answer while the turn is still
          // sampling. It may be followed by tool calls, a failed verification, or
          // an incomplete provider response, so expose a distinct candidate phase.
          deltas.append(event.text, "candidate_final", {
            itemId,
            ...(event.outputIndex !== undefined ? { outputIndex: event.outputIndex } : {}),
          });
          break;
        }
        case "tool.call.started":
          if (thinkingAssembler.hasOpenSegment) {
            thinkingLiveId = thinkingAssembler.boundary("tool", request.requestId).part.thinkingId;
          }
          calls.set(event.callId, { callId: event.callId, name: event.name, argumentsText: "", ...(event.callerId !== undefined ? { callerId: event.callerId } : {}), ...(event.programId !== undefined ? { programId: event.programId } : {}), ...(event.agentId !== undefined ? { agentId: event.agentId } : {}) });
          break;
        case "tool.call.arguments.delta": {
          const existing = calls.get(event.callId);
          if (existing) existing.argumentsText += event.delta;
          break;
        }
        case "tool.call.completed":
          calls.set(event.call.callId, {
            callId: event.call.callId,
            name: event.call.name,
            argumentsText: event.call.argumentsText,
            ...(event.call.callerId !== undefined ? { callerId: event.call.callerId } : {}),
            ...(event.call.programId !== undefined ? { programId: event.call.programId } : {}),
            ...(event.call.agentId !== undefined ? { agentId: event.call.agentId } : {}),
          });
          break;
        case "hosted.tool.started":
          if (thinkingAssembler.hasOpenSegment) {
            thinkingLiveId = thinkingAssembler.boundary("tool", request.requestId).part.thinkingId;
          }
          hostedStartedAt.set(event.callId, this.#now());
          emit("tool.started", {
            callId: event.callId,
            toolId: event.name,
            arguments: { providerHosted: true },
            display: event.display,
          });
          break;
        case "hosted.tool.completed": {
          const startedAt = hostedStartedAt.get(event.callId) ?? providerStartedAt;
          const durationMs = Math.max(0, this.#now() - startedAt);
          const artifactIds: string[] = [];
          if (event.image !== undefined) {
            if (this.#options.onGeneratedImage === undefined) {
              const message = "the host has no generated-image persistence handler";
              emit("tool.failed", {
                callId: event.callId,
                toolId: event.name,
                code: "INTERNAL",
                message,
                durationMs,
              });
              generatedImageNotes.push(`Image generation finished, but ${message}.`);
              break;
            }
            try {
              const stored = await this.#options.onGeneratedImage(event.callId, event.image);
              if (stored.artifactId === undefined && stored.outputPath === undefined) {
                throw new Error("the generated image could not be stored");
              }
              if (stored.artifactId !== undefined) artifactIds.push(stored.artifactId);
              generatedImageNotes.push(
                stored.outputPath !== undefined
                  ? `Generated image saved to \`${stored.outputPath}\`${stored.artifactId !== undefined ? ` (artifact \`${stored.artifactId}\`)` : ""}.`
                  : `Generated image stored as artifact \`${stored.artifactId}\`.`,
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              emit("tool.failed", {
                callId: event.callId,
                toolId: event.name,
                code: "INTERNAL",
                message,
                durationMs,
              });
              generatedImageNotes.push(`Image generation finished, but the result could not be saved: ${message}.`);
              break;
            }
          }
          emit("tool.completed", {
            callId: event.callId,
            toolId: event.name,
            summary: event.summary,
            durationMs,
            artifacts: artifactIds,
          });
          break;
        }
        case "hosted.tool.failed":
          if (event.name === "image_generation") {
            generatedImageNotes.push(`Image generation failed: ${event.message}`);
          }
          emit("tool.failed", {
            callId: event.callId,
            toolId: event.name,
            code: "PROVIDER_ERROR",
            message: event.message,
            durationMs: Math.max(0, this.#now() - (hostedStartedAt.get(event.callId) ?? providerStartedAt)),
          });
          break;
        case "response.item":
          if (event.authoritative === true && event.item.kind === "message" && event.item.text !== undefined) {
            authoritativeMessages.set(event.item.itemId, event.item);
          }
          if (
            event.authoritative === true &&
            event.item.kind === "reasoning" &&
            (event.item.summaryText !== undefined || event.item.reasoningText !== undefined)
          ) {
            authoritativeReasoning.set(event.item.itemId, event.item);
            if (event.item.reasoningText !== undefined) {
              lastReasoningTextItemId = event.item.itemId;
              lastReasoningTextProviderItemId = event.item.itemId;
            }
          }
          if (event.item.kind === "reasoning" && event.item.opaque !== undefined && event.item.opaque.length > 0) {
            opaqueItems.set(event.item.itemId, {
              type: "reasoning",
              opaque: event.item.opaque,
              ...(event.item.summaryText !== undefined ? { summaryText: event.item.summaryText } : {}),
            });
          } else if (event.item.kind === "compaction" && event.item.opaque !== undefined && event.item.opaque.length > 0) {
            opaqueItems.set(event.item.itemId, {
              type: "compaction",
              opaque: event.item.opaque,
            });
          }
          break;
        case "usage":
          this.#accumulateUsage(event.usage, emit, request.requestId, turnId);
          break;
        case "response.completed":
          responseId = event.responseId;
          break;
        case "response.incomplete":
          incomplete = event.reason;
          responseId ??= event.responseId;
          break;
        case "response.failed":
          failure = event.error;
          break;
        default:
          break;
        }
      }
    } finally {
      deltas.close();
    }

    emit("provider.response_completed", {
      requestId,
      responseId,
      status: failure !== undefined ? "failed" : incomplete !== undefined ? "incomplete" : "completed",
      durationMs: Math.max(0, this.#now() - providerStartedAt),
      firstDeltaObserved,
    });


    const orderedAuthoritativeMessages = [...authoritativeMessages.values()].sort(
      (left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
    );
    const fallbackCommentaryItems = orderedAuthoritativeMessages.filter((item) => item.phase === "commentary");
    const fallbackCommentary = fallbackCommentaryItems
      .map((item) => item.text ?? "")
      .join("");
    const fallbackTextItems = orderedAuthoritativeMessages.filter((item) => item.phase !== "commentary");
    const fallbackText = fallbackTextItems.map((item) => item.text ?? "").join("");
    const orderedAuthoritativeReasoning = [...authoritativeReasoning.values()].sort(
      (left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
    );
    const fallbackReasoningSummary = joinBounded(
      orderedAuthoritativeReasoning.map((item) => item.summaryText ?? ""),
      THINKING_MAX_SUMMARY_CHARS,
    );
    const fallbackReasoningText = joinBounded(
      orderedAuthoritativeReasoning.map((item) => item.reasoningText ?? ""),
      THINKING_MAX_DETAIL_CHARS,
    );
    const commentary = commentaryParts.length > 0 ? commentaryParts.join("") : fallbackCommentary;
    const reasoningSummary = reasoningSummaryParts.length > 0
      ? joinBounded(reasoningSummaryParts, THINKING_MAX_SUMMARY_CHARS)
      : fallbackReasoningSummary;
    const reasoningText =
      reasoningTextParts.size > 0
        ? joinBounded(reasoningTextParts.values(), THINKING_MAX_DETAIL_CHARS)
        : fallbackReasoningText;
    // The done item contains the complete message; prefer it over a partial delta
    // sequence when both are present.
    const providerText = fallbackText.trim().length > 0 ? fallbackText : textParts.join("");
    const text = generatedImageNotes.length > 0
      ? [providerText.trim(), generatedImageNotes.join("\n")].filter((part) => part.length > 0).join("\n\n")
      : providerText;
    const commentaryItemId = fallbackCommentaryItems.at(-1)?.itemId ?? lastCommentaryItemId;
    const reasoningItemId = orderedAuthoritativeReasoning.at(-1)?.itemId ?? lastReasoningProviderItemId;
    const reasoningTextItemId = orderedAuthoritativeReasoning
      .filter((item) => item.reasoningText !== undefined)
      .at(-1)?.itemId ??
      lastReasoningTextProviderItemId;
    const terminalItemId = fallbackTextItems.at(-1)?.itemId ?? lastTextItemId;

    const opaqueReasoningEvidence = [...opaqueItems.values()].some((item) => item.type === "reasoning");
    const opaqueReasoningProviderItemIds = [...opaqueItems.entries()]
      .filter(([, item]) => item.type === "reasoning")
      .map(([itemId]) => itemId);
    const thinkingEvidence =
      reasoningText.trim().length > 0 ||
      reasoningSummary.trim().length > 0 ||
      orderedAuthoritativeReasoning.length > 0 ||
      lastReasoningItemId !== undefined ||
      lastReasoningTextItemId !== undefined ||
      opaqueReasoningEvidence;
    if (thinkingEvidence) {
      if (
        opaqueReasoningProviderItemIds.length > 0 &&
        reasoningText.trim().length === 0 &&
        reasoningSummary.trim().length === 0 &&
        orderedAuthoritativeReasoning.every((item) => item.reasoningText === undefined && item.summaryText === undefined) &&
        !thinkingAssembler.hasOpenSegment &&
        thinkingAssembler.parts.every((part) => !opaqueReasoningProviderItemIds.some((itemId) => part.providerItemIds.includes(itemId)))
      ) {
        thinkingAssembler.boundary("response_end", request.requestId);
      }
      const canApplyAuthoritativeFallback = thinkingAssembler.parts.length === 0 || (thinkingAssembler.parts.length === 1 && thinkingAssembler.hasOpenSegment);
      if (canApplyAuthoritativeFallback && reasoningText.trim().length > 0) {
        thinkingAssembler.append({
          kind: "replace",
          channel: "detail",
          text: reasoningText,
          requestId: request.requestId,
          ...(reasoningTextItemId !== undefined ? { providerItemId: reasoningTextItemId } : {}),
          authoritative: true,
        });
      }
      if (canApplyAuthoritativeFallback && reasoningSummary.trim().length > 0) {
        thinkingAssembler.append({
          kind: "replace",
          channel: "summary",
          text: reasoningSummary.trim(),
          requestId: request.requestId,
          ...(reasoningItemId !== undefined ? { providerItemId: reasoningItemId } : {}),
          authoritative: true,
        });
      }
      const thinkingState = failure !== undefined ? (failure.kind === "cancelled" ? "interrupted" : "failed") : signal.aborted || incomplete !== undefined ? "interrupted" : "completed";
      const assembledThinking = thinkingAssembler.finish(thinkingState);
      const providerItemIds = [...new Set([
        ...assembledThinking.providerItemIds,
        ...opaqueReasoningProviderItemIds,
        ...orderedAuthoritativeReasoning.map((item) => item.itemId),
        ...(reasoningItemId !== undefined ? [reasoningItemId] : []),
        ...(reasoningTextItemId !== undefined ? [reasoningTextItemId] : []),
      ])];
      const partsToEmit = thinkingAssembler.parts.length > 0 ? thinkingAssembler.parts : [assembledThinking];
      const knownPartProviderItemIds = new Set(partsToEmit.flatMap((part) => part.providerItemIds));
      const fallbackProviderItemIds = providerItemIds.filter((itemId) => !knownPartProviderItemIds.has(itemId));
      for (const [partIndex, part] of partsToEmit.entries()) {
        const thinkingId = part.thinkingId;
        emit("assistant.thinking", {
          thinkingId,
          requestId: request.requestId,
          ...(responseId !== undefined ? { responseId } : {}),
          modelId: requestModelId,
          segmentIndex: part.segmentIndex,
          providerItemIds: [...new Set([...part.providerItemIds, ...(partIndex === partsToEmit.length - 1 ? fallbackProviderItemIds : [])])],
          state: part.state,
          sources: part.sources,
          ...(part.title !== undefined ? { title: part.title } : {}),
          ...(part.summaryText !== undefined ? { summaryText: part.summaryText } : {}),
          ...(part.summaryOrigin !== undefined ? { summaryOrigin: part.summaryOrigin } : {}),
          ...(part.detailText !== undefined ? { detailText: part.detailText } : {}),
          ...(part.startedAtMs !== undefined ? { startedAtMs: part.startedAtMs } : {}),
          ...(part.endedAtMs !== undefined ? { endedAtMs: part.endedAtMs } : {}),
          ...(part.durationMs !== undefined ? { durationMs: part.durationMs } : {}),
          ...(part.truncated === true ? { truncated: true } : {}),
        });
      }
    }

    if (failure) {
      this.#options.budgetController?.release(request.requestId);
      if (failure.kind === "cancelled") return { kind: "cancelled" };
      return { kind: "error", error: failure };
    }
    if (signal.aborted) {
      this.#options.budgetController?.release(request.requestId);
      return { kind: "cancelled" };
    }

    // §10.7: commentary and reasoning summary render at the same layer but stay
    // distinct types so replay preserves the phase.
    if (commentary.trim().length > 0) {
      emit("assistant.commentary", {
        text: commentary.trim(),
        ...(commentaryItemId !== undefined ? { itemId: commentaryItemId } : {}),
      });
    }
    if (reasoningText.trim().length > 0) {
      emit("assistant.reasoning", {
        text: reasoningText,
        thinkingId: thinkingLiveId,
        requestId: request.requestId,
        ...(responseId !== undefined ? { responseId } : {}),
        modelId: requestModelId,
        ...(reasoningTextItemId !== undefined ? { itemId: reasoningTextItemId } : {}),
      });
    }
    if (reasoningSummary.trim().length > 0) {
      emit("assistant.reasoning_summary", {
        text: reasoningSummary.trim(),
        thinkingId: thinkingLiveId,
        requestId: request.requestId,
        ...(responseId !== undefined ? { responseId } : {}),
        modelId: requestModelId,
        ...(reasoningItemId !== undefined ? { itemId: reasoningItemId } : {}),
      });
    }

    const items: ModelInputItem[] = [...opaqueItems.values()];
    if (commentary.trim().length > 0) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: commentary.trim() }],
        phase: "commentary",
      });
    }

    if (incomplete !== undefined) {
      // An incomplete response is not allowed to execute emitted tool calls or
      // pass through verification as a success. Preserve any useful fragment as
      // intermediate context and return a distinct terminal result instead.
      if (text.trim().length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: text.trim() }],
          phase: "commentary",
        });
      }
      this.#recordProviderContinuation(responseId, userInput, items);
      return {
        kind: "incomplete",
        reason: incomplete,
        partialText: text.trim(),
        items,
        ...(terminalItemId !== undefined ? { itemId: terminalItemId } : {}),
      };
    }

    if (calls.size > 0) {
      // Text in the same provider response as a tool call is an intermediate
      // assistant message, not the final answer. Classify it only after the
      // response shape is known so a tool never appears below a faux final block.
      if (text.trim().length > 0) {
        emit("assistant.commentary", {
          text: text.trim(),
          ...(terminalItemId !== undefined ? { itemId: terminalItemId } : {}),
        });
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: text.trim() }],
          phase: "commentary",
        });
      }

      for (const call of calls.values()) {
        items.push({
          type: "function_call",
          callId: call.callId,
          name: call.name,
          argumentsText: call.argumentsText,
          ...(call.callerId !== undefined ? { callerId: call.callerId } : {}),
          ...(call.programId !== undefined ? { programId: call.programId } : {}),
          ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
        });
      }
      this.#recordProviderContinuation(responseId, userInput, items);
      return { kind: "tool_calls", calls: [...calls.values()], items };
    }

    if (text.trim().length > 0) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: text.trim() }],
        phase: "final_answer",
      });
    }
    this.#recordProviderContinuation(responseId, userInput, items);
    return {
      kind: "final",
      text: text.trim(),
      items,
      ...(terminalItemId !== undefined ? { itemId: terminalItemId } : {}),
    };
  }

  async #executeTool(
    action: ProposedAction,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void = () => {},
  ): Promise<Awaited<ReturnType<ToolExecutor["execute"]>>> {
    if (this.#options.executeWithRecovery !== undefined) {
      return await this.#options.executeWithRecovery(action, signal, { emit });
    }
    return await this.#options.executor.execute(action, signal);
  }

  async #beforeToolExecute(action: ProposedAction, signal: AbortSignal): Promise<void> {
    await this.#options.beforeToolExecute?.(action, signal);
  }

  async #runPendingCalls(
    turnId: string,
    budget: BudgetState,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
    machine: TurnStateMachine,
  ): Promise<"done" | "cancelled"> {
    const calls = this.#pendingCalls;
    this.#pendingCalls = [];

    if (calls.length === 0) {
      // Defensive: an empty batch must still leave `tool_selection`.
      machine.tryApply("observed");
      return "done";
    }

    const outputHistoryStart = this.#history.length;
    const pendingById = new Map(calls.map((call) => [call.callId, call]));
    const graph = new ToolExecutionGraph(this.#options.toolGraph ?? {});
    const graphCalls: ToolGraphCall[] = calls.map((call) => {
      const tool = this.#options.registry.get(call.name);
      // Session-state revisions and workspace mutations remain serialized.
      const sessionState = tool?.authority === "session_state";
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(call.argumentsText) as unknown;
      } catch {
        rawArgs = undefined;
      }
      const argumentObject =
        typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
          ? rawArgs as Record<string, unknown>
          : undefined;
      const program = typeof argumentObject?.program === "string"
        ? argumentObject.program
        : undefined;
      const commandLane =
        this.#options.commandClassification === true &&
        call.name === "process.run" &&
        program !== undefined
          ? classifyCommandLane({
              program,
              args: Array.isArray(argumentObject?.args)
                ? argumentObject.args.filter((arg): arg is string => typeof arg === "string")
                : [],
              cwd: typeof argumentObject?.cwd === "string" ? argumentObject.cwd : ".",
            })
          : undefined;
      const kind = commandLane?.kind ??
        (call.name === "tool.discover" || tool?.mutates === true || sessionState
          ? "mutation"
          : call.name === "verification.run_many" || call.name.startsWith("process.") || call.name === "shell.run"
            ? "process"
            : tool?.network === true
              ? "external"
              : call.name.startsWith("test.")
                ? "test"
                : "read");
      const conflictKeys = sessionState
        ? [`session:${call.name}`]
        : commandLane?.conflictKeys ?? (tool?.conflictKeys?.(rawArgs) ?? []);
      const laneWrites = commandLane?.kind === "mutation" ||
        (commandLane?.kind === "test" && commandLane.exclusive);
      return {
        callId: call.callId,
        toolId: call.name,
        kind,
        conflictKeys,
        ...(tool?.mutates === true || sessionState || laneWrites
          ? { writes: conflictKeys.length > 0 ? conflictKeys : ["workspace:*"] }
          : { reads: conflictKeys }),
      };
    });
    const graphPlan = graph.plan(graphCalls);
    // Validate every streamed call before launching any side effect in the batch.
    // The cached results keep prefetch and sequential execution on one schema snapshot.
    const preflightValidation = new Map<string, ReturnType<ToolRegistry["validateCall"]>>();
    for (const call of calls) {
      preflightValidation.set(call.callId, this.#options.registry.validateCall(call.name, call.argumentsText, this.#activeInteractionMode));
    }
    for (const rejected of graphPlan.rejected) {
      this.#risks.push(`tool graph rejected ${rejected.callId}: ${rejected.message}`);
    }
    for (const batch of graphPlan.batches) {
      if (signal.aborted) return "cancelled";
      emit("tool.batch_started", {
        batchId: batch.batchId,
        kind: batch.kind,
        callIds: batch.calls.map((call) => call.callId),
        barrier: batch.barrier,
      });
      const prefetched = new Map<string, Promise<Awaited<ReturnType<ToolExecutor["execute"]>>>>();
      const preparedCallIds = new Set<string>();
      const prefetchedByKey = new Map<string, Promise<Awaited<ReturnType<ToolExecutor["execute"]>>>>();
      const releasePrefetched = (): void => {
        // A cancellation can leave work that was started concurrently but is no
        // longer awaited. Attach a rejection handler so a late provider failure
        // cannot become an unhandled rejection after the turn has returned.
        
        for (const execution of prefetched.values()) void execution.catch(() => undefined);
      };
      if (batch.kind === "read" || batch.kind === "test") {
        for (const graphCall of batch.calls) {
          if (signal.aborted) {
            releasePrefetched();
            return "cancelled";
          }
          if (budget.toolCalls + prefetched.size >= this.#limits.maxToolCalls) break;
          const call = pendingById.get(graphCall.callId);
          if (call === undefined) continue;
          const validation = preflightValidation.get(call.callId) ?? this.#options.registry.validateCall(call.name, call.argumentsText, this.#activeInteractionMode);
          if (!validation.ok) continue;
          const args = validation.value as Record<string, unknown>;
          const action = this.#options.normalizer.normalize(call.callId, call.name, args);
          const decision = this.#evaluateAction(action, actionHash(action));
          if (decision.kind !== "allow") continue;
          await this.#beforeToolExecute(action, signal);
          preparedCallIds.add(call.callId);
          emit("tool.started", {
            callId: call.callId,
            toolId: call.name,
            arguments: args,
            display: action.display,
          });
          const sharedKey = graphCall.conflictKeys !== undefined && graphCall.conflictKeys.length > 0
            ? `${call.name}:${[...graphCall.conflictKeys].sort().join("|")}`
            : undefined;
          let execution = sharedKey === undefined ? undefined : prefetchedByKey.get(sharedKey);
          if (execution === undefined) {
            try {
              execution = Promise.resolve(this.#executeTool(action, signal, emit));
            } catch (error) {
              execution = Promise.reject(error);
            }
            if (sharedKey !== undefined) prefetchedByKey.set(sharedKey, execution);
          }
          prefetched.set(call.callId, execution);
        }
      }
      for (const graphCall of batch.calls) {
        const call = pendingById.get(graphCall.callId);
        if (call === undefined) continue;
        if (signal.aborted) {
          releasePrefetched();
          return "cancelled";
        }
        if (budget.toolCalls >= this.#limits.maxToolCalls) {
          this.#risks.push(`tool call budget reached before ${call.name}`);
          // §11.2: a call the loop declines to run still owes the model an
          // observation. A silent drop leaves the model issuing tool calls into
          // a void, burning model steps to discover a limit it was never told
          // about — and the final report claims nothing about the missing work.
          emit("tool.failed", {
            callId: call.callId,
            toolId: call.name,
            code: "CANCELLED",
            message: `not executed: the ${this.#limits.maxToolCalls}-call tool budget is exhausted`,
          });
          this.#appendToolOutput(
            call,
            `TOOL_BUDGET_EXHAUSTED: ${call.name} was not executed; the ${this.#limits.maxToolCalls}-call tool budget is spent. Produce your final report from the evidence already gathered.`,
          );
          machine.tryApply("observed");
          continue;
        }
        budget.toolCalls += 1;

      // ---- Handle the discovery tool inline (§6.9) ----
      if (call.name === "tool.discover") {
        const validation = preflightValidation.get(call.callId) ?? this.#options.registry.validateCall(call.name, call.argumentsText, this.#activeInteractionMode);
        if (!validation.ok) {
          this.#recordObservationError(call, validation.errors, emit);
          // §11.2: an invalid call is an error observation, not a dead end.
          machine.tryApply("invalid_schema");
          continue;
        }
        // Discovery runs inline but still follows the §11.2 path so the turn
        // state stays truthful: allowed → executing → result → observing.
        machine.tryApply("allowed");
        const args = validation.value as { query: string; limit?: number };
        const result = this.#options.registry.discoverFor(args.query, this.#activeInteractionMode, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        emit("tool.discovery", result);
        this.#appendToolOutput(call, JSON.stringify({
          activated: result.activated,
          matches: result.matches.slice(0, 5),
          activeCount: result.activeCount,
        }));
        machine.tryApply("result");
        continue;
      }

      if (call.name === "verification.run_many") {
        const validation = preflightValidation.get(call.callId) ?? this.#options.registry.validateCall(
          call.name,
          call.argumentsText,
          this.#activeInteractionMode,
        );
        if (!validation.ok) {
          this.#recordObservationError(call, validation.errors, emit);
          machine.tryApply("invalid_schema");
          continue;
        }
        machine.tryApply("allowed");
        const input = validation.value as {
          commands: string[];
          maxParallel?: number;
          failFast?: boolean;
        };
        const requestedCommands = input.commands.slice(0, 12);
        const commands = requestedCommands.filter((command) => {
          const kind = this.#options.verificationCommandKind?.(command);
          return kind === undefined || kind === "required" || kind === "diagnostic";
        });
        const blockedCommands = requestedCommands.filter((command) => !commands.includes(command));
        if (blockedCommands.length > 0) {
          for (const command of blockedCommands) {
            const record = {
              command,
              required: false,
              status: "not_run" as const,
              evidence: "blocked because the command is outside the authoritative verification contract",
            };
            this.#recordVerification(record);
          }
        }
        const requestedParallel = Math.max(1, Math.min(
          input.maxParallel ?? 2,
          this.#options.toolGraph?.maxParallelTests ?? 2,
        ));
        const allIndependentlyParallel = commands.every((command) => {
          const tokens = parseCommandTokens(command);
          const program = tokens[0];
          if (program === undefined) return false;
          const lane = classifyCommandLane({ program, args: tokens.slice(1), cwd: "." });
          return lane.kind === "test" && !lane.exclusive;
        });
        const maxParallel = allIndependentlyParallel ? requestedParallel : 1;
        const results: Array<{
          command: string;
          status: "passed" | "failed" | "not_run";
          evidence: string;
        } | undefined> = new Array(commands.length);
        const authorized: Array<{
          readonly index: number;
          readonly command: string;
          readonly action: ProposedAction;
        }> = [];
        const startedAt = this.#now();
        emit("verification.started", {
          source: "verification.run_many",
          commands: commands.length,
          maxParallel,
        });

        // Approval is intentionally a separate, serial phase. Besides keeping the
        // prompts in stable input order, this guarantees the broker has at most one
        // request outstanding and that fail-on-ask cannot race already-started work.
        for (let index = 0; index < commands.length; index += 1) {
          const command = commands[index]!;
          const authorization = await this.#authorizeVerificationCommand(command, signal, emit);
          if (authorization.kind === "rejected") {
            results[index] = authorization.record;
            this.#recordVerification(authorization.record);
          } else {
            authorized.push({ index, command, action: authorization.action });
          }
        }

        // Only fully authorized commands enter the worker pool. Conservative lane
        // classification above collapses the pool to one for any shared-output,
        // mutating, external, shell-like, or otherwise unknown command.
        let cursor = 0;
        let stopped = false;
        const worker = async (): Promise<void> => {
          while (!stopped) {
            const item = authorized[cursor];
            cursor += 1;
            if (item === undefined) return;
            const record = await this.#executeAuthorizedVerificationCommand(
              item.command,
              item.action,
              signal,
            );
            results[item.index] = record;
            this.#recordVerification(record);
            if (record.status === "failed") {
              if (input.failFast === true) stopped = true;
            }
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(maxParallel, authorized.length) },
          () => worker(),
        ));
        for (let index = 0; index < commands.length; index += 1) {
          if (results[index] !== undefined) continue;
          const record = {
            command: commands[index]!,
            status: "not_run" as const,
            evidence: "not run because failFast stopped the compound verification batch",
          };
          results[index] = record;
          this.#recordVerification(record);
        }
        const stableResults = results.filter((record): record is NonNullable<typeof record> =>
          record !== undefined
        );
        emit("verification.completed", {
          source: "verification.run_many",
          status: blockedCommands.length === 0 && stableResults.every((record) => record.status === "passed") ? "passed" : "failed",
          records: stableResults.length + blockedCommands.length,
          durationMs: Math.max(0, this.#now() - startedAt),
        });
        this.#appendToolOutput(call, JSON.stringify({
          maxParallel,
          blockedCommands,
          results: stableResults,
        }));
        machine.tryApply("result");
        continue;
      }

      // ---- Validate (§12.1, AC-10) ----
      const validation = preflightValidation.get(call.callId) ?? this.#options.registry.validateCall(call.name, call.argumentsText, this.#activeInteractionMode);
      if (!validation.ok) {
        this.#recordObservationError(call, validation.errors, emit);
        // §11.2 `invalid schema → Observing(error)`. Skipping this transition
        // would leave the turn parked in `tool_selection`.
        machine.tryApply("invalid_schema");
        continue;
      }
      const args = validation.value as Record<string, unknown>;
      const action = this.#options.normalizer.normalize(call.callId, call.name, args);

      // ---- Permission (§13) ----
      const hash = actionHash(action);
      const decision = this.#evaluateAction(action, hash);
      if (decision.kind === "deny") {
        // AC-19: a denial becomes a structured observation.
        const text = renderDenialObservation(action, decision.reason);
        emit("tool.failed", {
          callId: call.callId,
          toolId: call.name,
          code: "APPROVAL_DENIED",
          message: decision.reason,
        });
        this.#appendToolOutput(call, text);
        // A denial is the failure most worth diagnosing: retrying it cannot
        // succeed, so the loop must be told to change approach, not to retry.
        this.#noteFailure({
          toolId: call.name,
          callId: call.callId,
          code: "APPROVAL_DENIED",
          message: decision.reason,
          text,
        });
        machine.tryApply("denied");
        continue;
      }

      if (decision.kind === "ask") {
        emit("approval.requested", decision.request);
        machine.tryApply("approval_needed");
        const resolution = await this.#options.approvals.request(decision.request, signal);
        emit("approval.resolved", {
          approvalId: decision.request.approvalId,
          decision: resolution.kind,
          ...(resolution.kind === "deny" && resolution.reason !== undefined
            ? { reason: resolution.reason }
            : {}),
        });
        if (resolution.kind === "deny") {
          const text = renderDenialObservation(
            action,
            "the user denied this action",
            resolution.reason,
          );
          this.#appendToolOutput(call, text);
          this.#noteFailure({
            toolId: call.name,
            callId: call.callId,
            code: "APPROVAL_DENIED",
            message: resolution.reason ?? "the user denied this action",
            text,
          });
          machine.tryApply("deny");
          continue;
        }
        if (resolution.kind === "allow_turn") {
          // §13.4: the grant covers the rest of this turn. Keying on the
          // normalized hash means the identical operation is re-approved without
          // re-asking, while any escalation asks again.
          this.#turnAllowedActions.add(hash);
        }
        machine.tryApply("allow");
      } else {
        machine.tryApply("allowed");
      }

      // ---- Execute ----
      if (!preparedCallIds.has(call.callId)) {
        await this.#beforeToolExecute(action, signal);
        preparedCallIds.add(call.callId);
      }
      if (!prefetched.has(call.callId)) {
        emit("tool.started", {
          callId: call.callId,
          toolId: call.name,
          arguments: args,
          display: action.display,
        });
      }
      const started = this.#now();
      let execution: Awaited<ReturnType<ToolExecutor["execute"]>>;
      try {
        const prefetchedExecution = prefetched.get(call.callId);
        execution = prefetchedExecution !== undefined ? await prefetchedExecution : await this.#executeTool(action, signal, emit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit("tool.failed", { callId: call.callId, toolId: call.name, code: "INTERNAL", message });
        this.#appendToolOutput(call, `INTERNAL: ${message}`);
        this.#noteFailure({
          toolId: call.name,
          callId: call.callId,
          code: "INTERNAL",
          message,
        });
        machine.tryApply("error");
        continue;
      }

      const durationMs = execution.durationMs ?? this.#now() - started;
      const changeDetail = changeDetailFromResult(execution.result.data);
      const tool = this.#options.registry.get(call.name);
      if (tool?.mutates === true || (action.writes?.length ?? 0) > 0) {
        // §10.13 / AC-43: once a mutation lands, replay is unsafe.
        this.#sideEffectsApplied = true;
        if (execution.result.ok) this.#workspaceMutated = true;

        // §15.11: the runtime, not the model, is the source of truth for which
        // paths changed. `action.writes` is only the normalized *intent*, and a
        // tool like `fs.apply_patch` carries its targets inside the diff, so the
        // result payload is consulted first.
        const reported = changedPathsFromResult(execution.result.data);
        for (const path of reported.length > 0 ? reported : action.writes ?? []) {
          const prior = this.#changedFiles.get(path);
          this.#changedFiles.set(path, {
            additions: changeDetail.additions ?? prior?.additions ?? 0,
            deletions: changeDetail.deletions ?? prior?.deletions ?? 0,
            purpose: prior?.purpose ?? execution.result.summary,
          });
        }
      }
      const externalSideEffect = actionHasExternalSideEffect(action);
      if (action.mcp !== undefined || externalSideEffect) this.#sideEffectsApplied = true;
      if (externalSideEffect) this.#externalSideEffectApplied = true;

      const observation = await normalizeObservation(
        {
          toolId: call.name,
          callId: call.callId,
          result: execution.result,
          ...(execution.text !== undefined ? { text: execution.text } : {}),
          ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
          durationMs,
        },
        {
          // A raw exact read is the runtime truth and may be the only copy when
          // L6 promotion was rejected. Never truncate it before its first sample
          // unless the executor already attached a recoverable artifact.
          ...((call.name === "fs.read" || call.name === "fs.read_many") &&
          (execution.result.artifacts?.length ?? 0) === 0
            ? { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }
            : {}),
          ...(this.#options.executor.spill
            ? { spill: this.#options.executor.spill.bind(this.#options.executor) }
            : {}),
        },
      );
      this.#observations.push(observation);

      // §6.4: a write carries a two-to-four line preview so the timeline can show
      // *what* changed without becoming a diff viewer. Derived from the runtime's
      // result rather than from the model's description of its own edit (§15.11).

      if (execution.result.ok) {
        emit("tool.completed", {
          callId: call.callId,
          toolId: call.name,
          summary: execution.result.summary,
          durationMs,
          artifacts: observation.artifacts.map((a) => a.id),
          ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
          ...changeDetail,
        });
      } else {
        emit("tool.failed", {
          callId: call.callId,
          toolId: call.name,
          code: execution.result.error?.code ?? "INTERNAL",
          message: execution.result.error?.message ?? execution.result.summary,
          durationMs,
          ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
          // §11.2: the taxonomy travels with the failure so the timeline shows
          // the same category the loop is about to act on.
          ...(observation.reflectionHint !== undefined
            ? { category: observation.reflectionHint.category }
            : {}),
        });
        if (this.#options.selfCorrection !== false) {
          this.#pendingFailures.push(observation);
        }
      }

      // Record process verification evidence (§11.8).
      if (
        (call.name === "process.run" || call.name === "shell.run") &&
        (this.#options.verificationCommandKind === undefined ||
          ["required", "diagnostic"].includes(this.#options.verificationCommandKind(action.display)))
      ) {
        this.#recordVerification({
          command: action.display,
          status: execution.result.ok ? "passed" : "failed",
          evidence: observation.text.split("\n")[0] ?? execution.result.summary,
          ...(this.#options.verificationCommandKind?.(action.display) === "diagnostic" ? { required: false } : {}),
        });
      }

      this.#appendToolOutput(call, observation.text);
      machine.tryApply("result");
      }
      emit("tool.batch_completed", {
        batchId: batch.batchId,
        kind: batch.kind,
        callIds: batch.calls.map((call) => call.callId),
      });
    }

    // Provider replay requires exactly one observation for every function call.
    // A planner rejection or scheduler defect must remain a local tool failure;
    // otherwise the next provider request is rejected before the model can recover.
    const answeredCallIds = new Set<string>();
    for (const item of this.#history.slice(outputHistoryStart)) {
      if (item.type === "function_call_output") answeredCallIds.add(item.callId);
    }
    for (const call of calls) {
      if (answeredCallIds.has(call.callId)) continue;
      const rejection = graphPlan.rejected.find((entry) => entry.callId === call.callId);
      const message = rejection === undefined
        ? "the tool execution graph did not schedule the call"
        : `the tool execution graph rejected the call (${rejection.code}): ${rejection.message}`;
      const text = `TOOL_GRAPH_UNSCHEDULED: ${call.name} was not executed; ${message}.`;
      if (rejection === undefined) this.#risks.push(`tool graph did not schedule ${call.callId}`);
      emit("tool.failed", {
        callId: call.callId,
        toolId: call.name,
        code: "INTERNAL",
        message,
      });
      this.#appendToolOutput(call, text);
      this.#noteFailure({
        toolId: call.name,
        callId: call.callId,
        code: "INTERNAL",
        message,
        text,
      });
    }

    // The batch is finished; the turn must be in `observing` before the loop
    // samples again. `executing` still owes its `result` edge, and anything
    // still sitting in `tool_selection` needs the `observed` edge — otherwise
    // `runTurn` would re-enter this method with an empty batch forever.
    if (machine.isIn("executing")) machine.tryApply("result");
    if (machine.isIn("tool_selection")) machine.tryApply("observed");
    return "done";
  }

  #recordObservationError(
    call: PendingCall,
    errors: ReadonlyArray<{ path: string; message: string }>,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): void {
    const text = renderValidationErrors(call.name, [...errors]);
    const message = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    emit("tool.failed", {
      callId: call.callId,
      toolId: call.name,
      code: "INVALID_ARGUMENT",
      message,
    });
    this.#appendToolOutput(call, text);
    this.#noteFailure({
      toolId: call.name,
      callId: call.callId,
      code: "INVALID_ARGUMENT",
      message,
      text,
    });
  }

  /** Append the tool result as a `function_call_output` so replay is faithful. */
  #appendToolOutput(call: PendingCall, output: string): void {
    this.#history.push({
      type: "function_call_output",
      callId: call.callId,
      output,
      ...(call.callerId !== undefined ? { callerId: call.callerId } : {}),
      ...(call.programId !== undefined ? { programId: call.programId } : {}),
      ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
    });
  }

  #accumulateUsage(
    usage: ModelUsage,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
    requestId?: string,
    turnId?: string,
  ): void {
    this.#usage = {
      inputTokens: this.#usage.inputTokens + usage.inputTokens,
      cachedInputTokens: this.#usage.cachedInputTokens + usage.cachedInputTokens,
      cacheWriteTokens: this.#usage.cacheWriteTokens + usage.cacheWriteTokens,
      outputTokens: this.#usage.outputTokens + usage.outputTokens,
      reasoningTokens: this.#usage.reasoningTokens + usage.reasoningTokens,
      totalTokens: this.#usage.totalTokens + usage.totalTokens,
    };
    this.#options.budgetController?.record(requestId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: estimateCostUsd(this.#routedModel(), usage),
    });

    if (usage.cacheWriteTokens > 0) emit("cache.write_observed", { tokens: usage.cacheWriteTokens });
    if (usage.cachedInputTokens > 0) emit("cache.read_observed", { tokens: usage.cachedInputTokens });
    emit("usage.updated", {
      ...usage,
      estimatedCostUsd: estimateCostUsd(this.#routedModel(), usage),
      // `inputTokens` describes this request's prompt. The aggregate usage above
      // is billing telemetry; using it here made the context gauge grow once per
      // sample even when the provider prompt stayed the same size.
      contextUsedTokens: usage.inputTokens,
      ...(requestId === undefined ? {} : { requestId }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  // -------------------------------------------------------------------------
  // Self-reflection (§11.2)
  // -------------------------------------------------------------------------

  /** Whether another `reflecting` step is permitted. */
  #reflectionAvailable(budget: BudgetState): boolean {
    if (this.#options.selfCorrection === false) return false;
    return budget.reflectionCycles < this.#limits.maxReflectionCycles;
  }

  /**
   * Inject a one-time wrap-up nudge when the tool budget is nearly (but not yet)
   * spent.
   *
   * A child that does not know it is about to be cut off spends its final calls on
   * open-ended exploration and ends in a partial report with no conclusion. Telling
   * it to conclude now, with the evidence it already gathered, turns that wall into
   * a graceful landing. Fired once per turn; only while some budget still remains,
   * because once it is exhausted the state machine takes over (§11.3).
   */
  #nudgeIfBudgetNearlySpent(
    budget: BudgetState,
    exhausted: ReturnType<typeof budgetExhausted>,
    inject: (text: string) => void,
  ): void {
    if (this.#budgetNudged) return;
    if (exhausted !== undefined) return;
    const toolRemaining = this.#limits.maxToolCalls - budget.toolCalls;
    if (toolRemaining <= 0 || toolRemaining > TOOL_BUDGET_NUDGE_REMAINING) return;
    this.#budgetNudged = true;
    inject(
      `Your tool-call budget is nearly spent: ${toolRemaining} call${
        toolRemaining === 1 ? "" : "s"
      } left. Stop exploring and produce your final structured conclusion now, using the evidence you already gathered. Only spend a remaining call if it is essential to that conclusion.`,
    );
  }

  /**
   * Queue a failure for diagnosis.
   *
   * Denials, schema rejections and review findings never produce a `ToolResult`,
   * so they would otherwise be invisible to reflection — and a denied write is
   * exactly the failure most worth diagnosing, because retrying it cannot work.
   */
  #noteFailure(input: {
    readonly toolId: string;
    readonly callId: string;
    readonly code: string;
    readonly message: string;
    readonly text?: string;
  }): void {
    if (this.#options.selfCorrection === false) return;
    const hint = classifyFailure({
      toolId: input.toolId,
      code: input.code,
      message: input.message,
      ...(input.text !== undefined ? { text: input.text } : {}),
    });
    this.#pendingFailures.push({
      callId: input.callId,
      toolId: input.toolId,
      ok: false,
      text: input.text ?? input.message,
      artifacts: [],
      truncated: false,
      linesOmitted: 0,
      repetitionsCollapsed: 0,
      reflectionHint: hint,
    });
  }

  /** Discard undiagnosed failures once the reflection budget is spent. */
  #dropPendingFailures(): void {
    if (this.#pendingFailures.length === 0) return;
    const summary = this.#pendingFailures
      .map((observation) => `${observation.toolId} (${observation.reflectionHint?.category ?? "unknown"})`)
      .join(", ");
    this.#pendingFailures = [];
    this.#risks.push(
      `${summary} failed and the self-correction budget was already spent, so the cause was not analysed`,
    );
  }

  /** Diagnose the oldest queued failure. */
  async #reflect(
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<ReflectionAnalysis | undefined> {
    const observation = this.#pendingFailures.shift();
    if (observation === undefined) return undefined;

    const analysis = await this.#analyzeFailure(observation, signal);
    this.#reflections.push(analysis);
    try {
      this.#options.onReflection?.(analysis);
    } catch {
      // A context-engine failure must not abort the correction it was meant to help.
    }

    // §P2: the diagnosis is user-visible, not an internal detail. A turn that
    // silently changes approach mid-flight is the thing users cannot follow.
    emit("assistant.commentary", {
      text: `Reflecting on ${analysis.toolId} (${analysis.errorCategory}): ${analysis.rootCause} → ${analysis.correctiveAction}`,
      commentaryKind: "recovery",
    });
    return analysis;
  }

  /**
   * Analyse a failed observation and set the hypothesis for the next attempt.
   *
   * The deterministic taxonomy is computed first and always stands on its own;
   * an injected `reflector` can only refine it. That ordering matters: if the
   * reflector is unavailable, times out, or returns nonsense, the loop still has
   * a usable category and a corrective action.
   */
  async #analyzeFailure(
    lastObservation: Observation,
    signal: AbortSignal,
  ): Promise<ReflectionAnalysis> {
    const hint =
      lastObservation.reflectionHint ??
      classifyFailure({
        toolId: lastObservation.toolId,
        code: "INTERNAL",
        message: lastObservation.text,
      });

    const attempts = this.#recordStreak(hint.signature);

    // The approach — not just the call — is suspect when the same failure has
    // already survived one correction, when the action is outside the granted
    // scope (retrying cannot widen it), or when the same category keeps
    // recurring under different signatures.
    const sameCategory = this.#reflections.filter(
      (prior) => prior.errorCategory === hint.category,
    ).length;
    const approachInvalid =
      attempts >= 2 || hint.category === "permission_denied" || sameCategory >= 2;

    const deterministic: ReflectionAnalysis = {
      errorCategory: hint.category,
      rootCause: describeRootCause(hint, lastObservation),
      correctiveAction: hint.guidance,
      approachInvalid,
      attempts,
      signature: hint.signature,
      toolId: lastObservation.toolId,
      implicatedPaths: hint.implicatedPaths,
    };

    if (this.#options.reflector === undefined) return deterministic;
    try {
      const refined = await this.#options.reflector(
        {
          observation: lastObservation,
          hint,
          attempts,
          priorReflections: [...this.#reflections],
        },
        signal,
      );
      if (refined === undefined) return deterministic;
      // The counted facts are the kernel's, not the reflector's: a reflector
      // that could rewrite `attempts` could talk its way past three strikes.
      return {
        ...deterministic,
        ...refined,
        attempts,
        signature: deterministic.signature,
      };
    } catch {
      return deterministic;
    }
  }

  /** Count consecutive occurrences of one failure signature. */
  #recordStreak(signature: string): number {
    const next = (this.#failureStreak.get(signature) ?? 0) + 1;
    // A different failure breaks the streak, so only the live signature is kept.
    this.#failureStreak.clear();
    this.#failureStreak.set(signature, next);
    return next;
  }

  /**
   * Undo the work of an abandoned approach through the runtime's transaction
   * journal. Paths the runtime declined to revert stay in the changed-file list,
   * because they really did change and the report must say so.
   */
  async #rollbackAbandonedApproach(
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
    analysis: ReflectionAnalysis | undefined,
  ): Promise<void> {
    // A failed permission check or unavailable runtime tells us that validation
    // could not continue; it says nothing about the source already written.
    // Only a code-level failure authorizes undoing committed workspace changes.
    if (analysis?.errorCategory !== "logic_bug") {
      if (this.#workspaceMutated) {
        const category = analysis?.errorCategory ?? "unknown failure";
        const toolId = analysis?.toolId ?? "the failed operation";
        this.#risks.push(
          `kept existing workspace changes because ${toolId} was blocked by ${category}; the failure did not show those changes were incorrect`,
        );
        emit("assistant.commentary", {
          text: `Keeping existing workspace changes: ${toolId} was blocked by ${category}, so the source was not rolled back.`,
          commentaryKind: "risk",
        });
      }
      return;
    }

    const coordinator = this.#options.checkpoints;
    if (coordinator === undefined || !this.#workspaceMutated) return;
    const checkpointId = coordinator.current();
    if (checkpointId === undefined) return;

    try {
      const outcome = await coordinator.rollbackTo(checkpointId, signal);
      for (const path of outcome.revertedPaths) this.#changedFiles.delete(path);
      if (this.#changedFiles.size === 0) this.#workspaceMutated = false;

      emit("transaction.rolled_back", {
        checkpointId: outcome.checkpointId,
        revertedPaths: [...outcome.revertedPaths],
        skippedPaths: [...(outcome.skippedPaths ?? [])],
        reason: "self-correction abandoned the approach that produced these changes",
      });

      for (const path of outcome.skippedPaths ?? []) {
        this.#risks.push(
          `${path} could not be rolled back to checkpoint ${outcome.checkpointId}; it still holds the abandoned change`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#risks.push(
        `rolling back to checkpoint ${checkpointId} failed (${message}); the abandoned changes are still applied`,
      );
    }
  }

  /** Wrap the reflection prompt with the instruction to rebuild the plan. */
  #rePlanPrompt(reflection: string | undefined): string {
    const lines = [
      "Your current approach has been abandoned. Do not continue it.",
      "",
      reflection ?? "The previous approach failed and no diagnosis is available.",
      "",
      "Re-plan before acting:",
      "1. State, in one line, what your previous approach assumed that turned out to be false.",
      "2. Name a different approach, not a variation of the same one.",
      "3. Name the first check that would prove the new approach viable, and run that check before editing anything.",
    ];
    if (this.#changedFiles.size > 0) {
      lines.push(
        "",
        `These paths still carry changes from the abandoned attempt: ${[...this.#changedFiles.keys()].join(", ")}. Account for them.`,
      );
    }
    return lines.join("\n");
  }

  async #verify(
    turnId: string,
    budget: BudgetState,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<"accept" | "repair"> {
    const changedPaths = [...this.#changedFiles.keys()];
    // A read-only turn needs no verification. A turn that mutated the workspace
    // always does, even if the exact paths could not be resolved (§11.8, AC-50).
    if (changedPaths.length === 0 && !this.#workspaceMutated) return "accept";
    if (changedPaths.length === 0) {
      this.#risks.push(
        "the workspace was modified but the changed paths could not be resolved from the tool result",
      );
    }
    const verificationStartedAt = this.#now();
    const risk = assessChangeRisk({
      files: [...this.#changedFiles.entries()].map(([path, file]) => ({ path, ...file })),
      workspaceMutated: this.#workspaceMutated,
      priorRepairCycles: budget.repairCycles,
      externalSideEffect: this.#externalSideEffectApplied,
      ...(this.#options.minimumReviewRisk !== undefined
        ? { minimumReviewRisk: this.#options.minimumReviewRisk }
        : {}),
    });
    emit("verification.started", {
      changedPaths,
      riskLevel: risk.level,
      riskScore: risk.score,
      riskReasons: risk.reasons,
    });

    const shouldReview = this.#options.autoReview === true &&
      ((this.#options.reviewPolicy ?? "always") === "always" || risk.reviewRequired);
    type ReviewRun =
      | { readonly review: ReviewOutcome; readonly inputBytes: number; readonly durationMs: number }
      | { readonly error: string; readonly inputBytes: number; readonly durationMs: number };
    let reviewPromise: Promise<ReviewRun> | undefined;
    if (
      shouldReview &&
      this.#options.reviewer !== undefined &&
      budget.reviewCycles < this.#limits.maxReviewCycles
    ) {
      budget.reviewCycles += 1;
      const reviewStartedAt = this.#now();
      emit("review.started", {
        reviewId: `review_${budget.reviewCycles}`,
        riskLevel: risk.level,
        changedPaths,
      });
      reviewPromise = (async (): Promise<ReviewRun> => {
        const pathSummary = changedPaths.length > 0
          ? changedPaths.map((path) => `- ${path}`).join("\n")
          : "- (the workspace was modified; changed paths were not reported)";
        let material = pathSummary;
        if (this.#options.reviewMaterial !== undefined) {
          try {
            const exact = await this.#options.reviewMaterial(changedPaths, signal);
            if (exact.trim().length > 0) material = exact;
          } catch (error) {
            material += `\n\n[exact diff unavailable: ${error instanceof Error ? error.message : String(error)}]`;
          }
        }
        const input = [
          `Risk: ${risk.level} (score ${risk.score})`,
          `Reasons: ${risk.reasons.join("; ")}`,
          "",
          material,
        ].join("\n");
        const inputBytes = new TextEncoder().encode(input).byteLength;
        try {
          const review = await this.#options.reviewer!(input, signal);
          return { review, inputBytes, durationMs: Math.max(0, this.#now() - reviewStartedAt) };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            inputBytes,
            durationMs: Math.max(0, this.#now() - reviewStartedAt),
          };
        }
      })();
    } else if (this.#options.autoReview === true && !shouldReview) {
      emit("review.completed", {
        status: "skipped",
        skipped: true,
        reason: `risk ${risk.level} is below the configured threshold`,
        riskLevel: risk.level,
        durationMs: 0,
        inputBytes: 0,
      });
    } else if (shouldReview) {
      const reason = this.#options.reviewer === undefined
        ? "no independent review was run because no reviewer is configured"
        : "risk policy required review but the review-cycle budget was exhausted";
      this.#recordVerification({ status: "not_run", evidence: reason });
      this.#risks.push(reason);
      emit("review.completed", {
        status: "not_run",
        skipped: false,
        reason,
        riskLevel: risk.level,
        durationMs: 0,
        inputBytes: 0,
      });
    }


    const steps = planVerification({
      // `planVerification` returns no steps for an empty path list, so an
      // unresolved mutation is represented by a synthetic marker rather than
      // silently skipping the plan.
      changedPaths: changedPaths.length > 0 ? changedPaths : ["<unresolved>"],
      ...(this.#options.testCommandFor ? { testCommandFor: this.#options.testCommandFor } : {}),
      ...(this.#options.requiredVerificationCommands ? { requiredCommands: this.#options.requiredVerificationCommands } : {}),
      autoReview: this.#options.autoReview === true,
    });

    // §11.8 / P0-12: every deterministic planned check runs through the same
    // policy and executor path as the model's own tool calls. Previously only
    // `closest_tests` was handled here, so HTML/CSS and other files with no
    // inferred test command produced zero verification records and were
    // incorrectly downgraded from completed to partial/blocked.
    for (const step of steps) {
      switch (step.kind) {
        case "parse_sanity": {
          const record = await this.#runFileSanity(step.paths, signal, emit);
          this.#recordVerification({ ...record, kind: "check" });
          break;
        }
        case "closest_tests": {
          if (this.#verification.some((v) => v.command === step.command)) break;
          if (signal.aborted) {
            this.#recordVerification({
              command: step.command,
              status: "not_run",
              evidence: "the turn was cancelled before verification could run",
            });
            break;
          }
          const record = await this.#runVerificationCommand(step.command, signal, emit);
          this.#recordVerification(record);
          break;
        }
        case "git_diff": {
          const record = await this.#runGitDiffSanity(changedPaths, signal, emit);
          this.#recordVerification({ ...record, kind: "check" });
          break;
        }
        case "broader_tests":
        case "independent_review":
          // Broader suites require an explicit command before execution, while
          // the independent review is started above and joined below.
          break;
      }
    }

    if (reviewPromise !== undefined) {
      const reviewRun = await reviewPromise;
      if ("error" in reviewRun) {
        const evidence = `independent review could not run: ${reviewRun.error}`;
        this.#recordVerification({ status: "not_run", evidence });
        this.#risks.push(evidence);
        emit("review.completed", {
          status: "not_run",
          skipped: false,
          reason: reviewRun.error,
          riskLevel: risk.level,
          durationMs: reviewRun.durationMs,
          inputBytes: reviewRun.inputBytes,
        });
      } else {
        const review = reviewRun.review;
        this.#delegated.push({
          id: `review_${budget.reviewCycles}`,
          role: "reviewer",
          status: "completed",
          summary: review.summary,
        });
        const blocking = review.findings.filter(
          (finding) => finding.severity === "critical" || finding.severity === "high",
        );
        this.#recordVerification({
          status: blocking.length > 0 ? "failed" : "passed",
          evidence: `independent review: ${review.summary}`,
        });
        emit("review.completed", {
          status: blocking.length > 0 ? "failed" : "passed",
          skipped: false,
          riskLevel: risk.level,
          findings: review.findings.length,
          blockingFindings: blocking.length,
          durationMs: reviewRun.durationMs,
          inputBytes: reviewRun.inputBytes,
        });
        for (const finding of blocking) {
          this.#risks.push(
            `${finding.severity}: ${finding.title} — ${finding.recommendation}`,
          );
        }
        if (blocking.length > 0 && budget.repairCycles < this.#limits.maxRepairCycles) {
          emit("assistant.commentary", {
            text: `Independent review found ${blocking.length} blocking issue(s); attempting one repair.`,
            commentaryKind: "risk",
          });
          this.#reviewFindings = blocking;
          emit("verification.completed", {
            status: "failed",
            durationMs: Math.max(0, this.#now() - verificationStartedAt),
            records: this.#verification.length,
            riskLevel: risk.level,
          });
          return "repair";
        }
      }
    }

    const verificationStatus = this.#verification.some(
      (record) => record.required !== false && (record.status === "failed" || record.status === "not_run"),
    ) ? "failed" : "passed";
    emit("verification.completed", {
      status: verificationStatus,
      durationMs: Math.max(0, this.#now() - verificationStartedAt),
      records: this.#verification.length,
      riskLevel: risk.level,
    });
    return "accept";
  }

  /**
   * Keep one authoritative result for each verification command. A failed check
   * followed by a successful retry is resolved evidence, not a permanent reason
   * to downgrade the final report to `partial`.
   */
  #recordVerification(record: CompletionReport["verification"][number]): void {
    const command = record.command?.trim();
    const classification = command === undefined
      ? undefined
      : this.#options.verificationCommandKind?.(command);
    const normalizedRecord = classification === "diagnostic" && record.required !== false
      ? { ...record, required: false }
      : record;
    if (command === undefined || command.length === 0) {
      this.#verification.push(normalizedRecord);
      return;
    }

    const previousIndex = this.#verification.findIndex((existing) => existing.command?.trim() === command);
    if (previousIndex === -1) this.#verification.push(normalizedRecord);
    else this.#verification[previousIndex] = normalizedRecord;

    const failureRisk = `verification failed: ${command}`;
    if (normalizedRecord.required !== false && normalizedRecord.status === "failed") {
      if (!this.#risks.includes(failureRisk)) this.#risks.push(failureRisk);
    } else if (normalizedRecord.status === "passed" || normalizedRecord.required === false) {
      this.#risks = this.#risks.filter((risk) => risk !== failureRisk);
    }
  }

  #verificationCallCounter = 0;

  /**
   * Execute one planned verification command (§11.8, P0-12).
   *
   * The command goes through the same policy evaluation, approval flow, and tool
   * executor as a model-proposed call — a verification run must not be a side door
   * around permissions. Denials and failures become the evidence text, so the final
   * report can say exactly what ran and what did not (AC-50).
   */
  async #authorizeVerificationCommand(
    command: string,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<
    | { readonly kind: "authorized"; readonly command: string; readonly action: ProposedAction }
    | {
        readonly kind: "rejected";
        readonly record: {
          readonly command: string;
          readonly status: "not_run";
          readonly evidence: string;
        };
      }
  > {
    const parts = parseCommandTokens(command);
    const program = parts[0];
    if (program === undefined) {
      return {
        kind: "rejected",
        record: { command, status: "not_run", evidence: "empty or malformed verification command" },
      };
    }
    const args = parts.slice(1);
    const workspaceRoot = this.#options.permissionContext().approvedPlan?.workspaceRoot ?? ".";
    const action = this.#verificationAction(
      "process.run",
      { program, args, cwd: workspaceRoot, timeoutMs: 300_000, maxOutputBytes: 65_536 },
      command,
    );

    return await this.#authorizeVerificationAction(command, action, signal, emit);
  }

  #verificationAction(
    toolId: string,
    arguments_: Record<string, unknown>,
    display: string,
  ): ProposedAction {
    const action = this.#options.normalizer.normalize(
      `verification_${(this.#verificationCallCounter += 1)}`,
      toolId,
      arguments_,
    );
    return { ...action, display };
  }

  async #authorizeVerificationAction(
    command: string,
    action: ProposedAction,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<
    | { readonly kind: "authorized"; readonly command: string; readonly action: ProposedAction }
    | {
        readonly kind: "rejected";
        readonly record: {
          readonly command: string;
          readonly status: "not_run";
          readonly evidence: string;
        };
      }
  > {
    const hash = actionHash(action);
    const decision = this.#evaluateAction(action, hash);
    if (decision.kind === "deny") {
      return {
        kind: "rejected",
        record: { command, status: "not_run", evidence: `denied by policy: ${decision.reason}` },
      };
    }
    if (decision.kind === "ask") {
      emit("approval.requested", decision.request);
      const resolution = await this.#options.approvals.request(decision.request, signal);
      emit("approval.resolved", {
        approvalId: decision.request.approvalId,
        decision: resolution.kind,
        ...(resolution.kind === "deny" && resolution.reason !== undefined
          ? { reason: resolution.reason }
          : {}),
      });
      if (resolution.kind === "deny") {
        return {
          kind: "rejected",
          record: {
            command,
            status: "not_run",
            evidence: `denied by the user: ${resolution.reason ?? "no reason given"}`,
          },
        };
      }
      if (resolution.kind === "allow_turn") this.#turnAllowedActions.add(hash);
    }
    return { kind: "authorized", command, action };
  }

  /**
   * Confirm that every changed path is still readable and capture the runtime's
   * post-write checksum. This is the deterministic minimum sanity check for
   * formats that do not have an inferred test command (for example HTML/CSS).
   */
  async #runFileSanity(
    paths: readonly string[],
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<CompletionReport["verification"][number]> {
    const command = `file checksum sanity (${paths.length} path${paths.length === 1 ? "" : "s"})`;
    if (paths.length === 0 || paths.some((path) => path === "<unresolved>")) {
      return {
        command,
        status: "not_run",
        evidence: "changed paths were unresolved, so post-write checksums could not be read",
      };
    }
    if (signal.aborted) {
      return { command, status: "not_run", evidence: "the turn was cancelled before file sanity could run" };
    }

    const evidence: string[] = [];
    for (let offset = 0; offset < paths.length; offset += 20) {
      const batch = paths.slice(offset, offset + 20);
      const action = this.#verificationAction(
        "fs.read_many",
        {
          paths: batch,
          maxLines: 1,
          maxTotalLines: Math.max(1, batch.length),
          maxTotalBytes: Math.max(1_024, batch.length * 1_024),
          concurrency: Math.min(4, batch.length),
        },
        command,
      );
      const authorization = await this.#authorizeVerificationAction(command, action, signal, emit);
      if (authorization.kind === "rejected") return authorization.record;

      try {
        const execution = await this.#executeTool(authorization.action, signal);
        if (!execution.result.ok) {
          return {
            command,
            status: "failed",
            evidence: execution.result.error?.message ?? execution.result.summary,
          };
        }

        const data = execution.result.data as {
          files?: Array<{ path?: string; checksum?: string; revisionToken?: string }>;
          errors?: Array<{ path?: string; message?: string }>;
        } | undefined;
        if (Array.isArray(data?.errors) && data.errors.length > 0) {
          return {
            command,
            status: "failed",
            evidence: data.errors
              .map((error) => `${error.path ?? "unknown path"}: ${error.message ?? "read failed"}`)
              .join("; ")
              .slice(0, 2_000),
          };
        }

        if (Array.isArray(data?.files)) {
          if (data.files.length < batch.length) {
            return {
              command,
              status: "failed",
              evidence: `runtime returned ${data.files.length} post-write read(s) for ${batch.length} changed path(s)`,
            };
          }
          for (const file of data.files) {
            const path = file.path ?? "unknown path";
            const checksum = file.checksum ?? file.revisionToken;
            evidence.push(checksum === undefined ? path : `${path} sha256:${checksum.slice(0, 12)}`);
          }
        } else {
          evidence.push(execution.result.summary);
        }
      } catch (error) {
        return {
          command,
          status: "failed",
          evidence: `file sanity could not run: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return {
      command,
      status: "passed",
      evidence: evidence.length > 0 ? evidence.join(", ").slice(0, 2_000) : "all changed files were readable",
    };
  }

  /** Run the planned scoped diff inspection even when no focused test exists. */
  async #runGitDiffSanity(
    paths: readonly string[],
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<CompletionReport["verification"][number]> {
    const command = "git diff (changed paths)";
    if (paths.length === 0) {
      return { command, status: "not_run", evidence: "changed paths were unresolved" };
    }
    if (signal.aborted) {
      return { command, status: "not_run", evidence: "the turn was cancelled before diff inspection" };
    }

    let inspectedFiles = 0;
    let additions = 0;
    let deletions = 0;
    for (let offset = 0; offset < paths.length; offset += 64) {
      const batch = paths.slice(offset, offset + 64);
      const action = this.#verificationAction("git.diff", { paths: batch }, command);
      const authorization = await this.#authorizeVerificationAction(command, action, signal, emit);
      if (authorization.kind === "rejected") return authorization.record;
      try {
        const execution = await this.#executeTool(authorization.action, signal);
        if (!execution.result.ok) {
          return {
            command,
            status: "failed",
            evidence: execution.result.error?.message ?? execution.result.summary,
          };
        }
        const data = execution.result.data as {
          files?: unknown[];
          totalAdditions?: number;
          totalDeletions?: number;
        } | undefined;
        inspectedFiles += Array.isArray(data?.files) ? data.files.length : 0;
        additions += typeof data?.totalAdditions === "number" ? data.totalAdditions : 0;
        deletions += typeof data?.totalDeletions === "number" ? data.totalDeletions : 0;
      } catch (error) {
        return {
          command,
          status: "failed",
          evidence: `git diff could not run: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return {
      command,
      status: "passed",
      evidence: `scoped diff inspected (${inspectedFiles} tracked file(s), +${additions} -${deletions}); post-write checksums cover untracked files`,
    };
  }

  async #executeAuthorizedVerificationCommand(
    command: string,
    action: ProposedAction,
    signal: AbortSignal,
  ): Promise<{ command: string; status: "passed" | "failed"; evidence: string }> {
    try {
      const execution = await this.#executeTool(action, signal);
      const exitCode = execution.exitCode ?? (execution.result.ok ? 0 : 1);
      const detail = (execution.text ?? execution.result.summary ?? "").trim();
      const evidence = detail.length > 2_000 ? `${detail.slice(0, 2_000)}??truncated]` : detail;
      if (execution.result.ok && exitCode === 0) {
        return { command, status: "passed", evidence: evidence === "" ? "exit 0" : evidence };
      }
      return {
        command,
        status: "failed",
        evidence: `exit ${exitCode}${evidence.length > 0 ? `: ${evidence}` : ""}`,
      };
    } catch (error) {
      return {
        command,
        status: "failed",
        evidence: `verification could not run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async #runVerificationCommand(
    command: string,
    signal: AbortSignal,
    emit: <T>(kind: CbcEventKind, payload: T) => void,
  ): Promise<{ command: string; status: "passed" | "failed" | "not_run"; evidence: string }> {
    const authorization = await this.#authorizeVerificationCommand(command, signal, emit);
    if (authorization.kind === "rejected") return authorization.record;
    return this.#executeAuthorizedVerificationCommand(command, authorization.action, signal);
  }
  #reviewFindings: ReviewOutcome["findings"] = [];

  #repairPrompt(): string {
    const lines = [
      "An independent reviewer found blocking issues in your change. Repair them with the smallest safe edit.",
      "",
    ];
    for (const finding of this.#reviewFindings) {
      lines.push(`- [${finding.severity}] ${finding.title}`);
      lines.push(`  evidence: ${finding.evidence}`);
      lines.push(`  recommendation: ${finding.recommendation}`);
    }
    this.#reviewFindings = [];
    return lines.join("\n");
  }

  /** Snapshot truthful run evidence when the outer command catches an exception. */
  snapshotCompletionReport(summary?: string): CompletionReport {
    const text = summary?.trim();
    return {
      status: "failed",
      summary: text && text.length > 0 ? text : this.#lastFailureSummary ?? "The turn failed.",
      changedFiles: this.#changedFileList(),
      verification: this.#verification.map((record) => ({ ...record })),
      delegatedTasks: this.#delegated.map((task) => ({ ...task })),
      risks: [...this.#risks],
    };
  }

  #changedFileList(): CompletionReport["changedFiles"] {
    return [...this.#changedFiles.entries()].map(([path, info]) => ({
      path,
      additions: info.additions,
      deletions: info.deletions,
      purpose: info.purpose,
    }));
  }
}

/**
 * The reflection prompt handed to the model on the next sample (§11.2).
 *
 * It is deliberately category-specific. A generic "that failed, try again" gives
 * the model nothing it did not already have in the observation, and the failure
 * modes differ enough that one instruction cannot serve all four: a schema error
 * wants the same intent re-expressed, while a denial wants a different intent.
 */
export function renderReflectionPrompt(analysis: ReflectionAnalysis): string {
  const lines: string[] = [
    `The last action failed. Diagnosis before you act again:`,
    "",
    `- tool: ${analysis.toolId}`,
    `- category: ${analysis.errorCategory}`,
    `- root cause: ${analysis.rootCause}`,
    `- corrective action: ${analysis.correctiveAction}`,
  ];
  if (analysis.attempts > 1) {
    lines.push(
      `- this is attempt ${analysis.attempts} at the same failure; a variation of the same call will fail the same way`,
    );
  }
  if (analysis.implicatedPaths.length > 0) {
    lines.push(`- paths named by the failure: ${analysis.implicatedPaths.join(", ")}`);
  }

  lines.push("", ...categoryInstructions(analysis.errorCategory));
  if (analysis.toolId === "fs.write") {
    lines.push(
      "",
      "fs.write correction: use intent=create when the target is absent; use intent=replace only after fs.read returns a real checksum. Never invent or reuse an empty checksum for replace.",
    );
  } else if (analysis.toolId === "fs.apply_patch") {
    lines.push(
      "",
      "fs.apply_patch correction: re-read the current file, then send one complete patch with --- a/path and +++ b/path headers. Prefer bare '@@' plus enough unchanged/removed old-side lines to identify exactly one location; numbered headers like '@@ -1,3 +1,4 @@' also work. Hunk counts are derived from the body, so do not hand-count them or append wrapper markers. For a new file, use fs.write with intent=create instead.",
    );
  } else if (analysis.toolId === "fs.read" && analysis.errorCategory === "logic_bug") {
    lines.push(
      "",
      "fs.read correction: NOT_FOUND means the path is absent; do not repeat the read. If the task is to create it, use fs.write with intent=create after checking the parent directory.",
    );
  }
  lines.push(
    "",
    "State your revised hypothesis in one line, then take the single next action it implies. Do not repeat the failed call unchanged.",
  );
  return lines.join("\n");
}

function categoryInstructions(category: FailureCategory): string[] {
  switch (category) {
    case "schema_mismatch":
      return [
        "Your intent was probably right and your arguments were wrong. Re-read the tool's schema,",
        "correct the arguments, and re-issue the same intent. Do not switch to a different tool to",
        "avoid the validation error.",
      ];
    case "permission_denied":
      return [
        "This action is outside the scope you were granted. Retrying it will be denied again.",
        "Either achieve the goal within your scope, or stop and state exactly what wider scope the",
        "task needs and why. Do not attempt to reach the same path by another route.",
      ];
    case "environment_issue":
      return [
        "The failure is in the environment, not in the change you are making. Establish whether the",
        "prerequisite actually exists before editing any source. Do not modify code to work around a",
        "missing tool or an absent dependency unless that is the task.",
      ];
    case "logic_bug":
      return [
        "Your model of the code was wrong. Re-read the relevant source and confirm the assumption",
        "that failed before making another edit. A second edit built on the same wrong assumption",
        "will fail the same way.",
      ];
  }
}

/** One sentence naming what actually went wrong, from evidence only. */
function describeRootCause(hint: ReflectionHint, observation: Observation): string {
  const detail = firstMeaningfulLine(observation.text);
  const where =
    hint.implicatedPaths.length > 0 ? ` at ${hint.implicatedPaths.slice(0, 3).join(", ")}` : "";
  switch (hint.category) {
    case "schema_mismatch":
      return `${observation.toolId} rejected the arguments (${hint.code})${where}: ${detail}`;
    case "permission_denied":
      return `${observation.toolId} was refused by policy (${hint.code})${where}: ${detail}`;
    case "environment_issue":
      return `the environment could not satisfy ${observation.toolId} (${hint.code})${where}: ${detail}`;
    case "logic_bug":
      return `${observation.toolId} contradicted an assumption in the change (${hint.code})${where}: ${detail}`;
  }
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  const chosen = line ?? "no detail was reported";
  return chosen.length > 220 ? `${chosen.slice(0, 220)}…` : chosen;
}

/**
 * Pull the workspace-relative paths a mutation actually touched out of a tool
 * result payload. The Rust runtime reports them as `stagedPaths`, a `files`
 * array, or a single `path` depending on the operation (§20.3), and any of those
 * shapes is more trustworthy than the model's own claim (§15.11).
 */
function changedPathsFromResult(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const record = data as Record<string, unknown>;
  const paths = new Set<string>();

  const pushPath = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) paths.add(value);
  };

  pushPath(record.path);
  for (const key of ["stagedPaths", "paths", "changedPaths"]) {
    const list = record[key];
    if (Array.isArray(list)) for (const entry of list) pushPath(entry);
  }
  for (const key of ["files", "operations"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") pushPath(entry);
      else if (typeof entry === "object" && entry !== null) {
        pushPath((entry as Record<string, unknown>).path);
      }
    }
  }
  return [...paths];
}

/** §6.4: at most four preview lines beside a write. */
const MAX_DIFF_PREVIEW_LINES = 4;

export interface DiffPreviewLine {
  readonly kind: "added" | "removed" | "context";
  readonly lineNumber?: number;
  readonly text: string;
}

export interface ChangeDetail {
  readonly additions?: number;
  readonly deletions?: number;
  readonly diffPreview?: readonly DiffPreviewLine[];
}

/**
 * Extract line counts and a short preview from a mutation result.
 *
 * The runtime reports a change either as counts on the result, as a `unifiedDiff`
 * string, or as both (§20.3). Reading whichever is present keeps the timeline
 * honest about what landed without every tool having to agree on one shape.
 */
export function changeDetailFromResult(data: unknown): ChangeDetail {
  if (typeof data !== "object" || data === null) return {};
  const record = data as Record<string, unknown>;

  const additions = firstNumber(record, ["additions", "linesAdded", "added", "totalAdditions"]);
  const deletions = firstNumber(record, ["deletions", "linesRemoved", "removed", "totalDeletions"]);

  const diff = record.unifiedDiff ?? record.diff ?? record.patch;
  const preview = typeof diff === "string" ? previewFromUnifiedDiff(diff) : [];

  // Counts absent from the payload are recovered from the diff itself rather than
  // reported as zero, because "+0 -0" beside a real edit reads as a no-op.
  const counted = typeof diff === "string" ? countUnifiedDiff(diff) : undefined;
  const resolvedAdditions = additions ?? counted?.additions;
  const resolvedDeletions = deletions ?? counted?.deletions;

  return {
    ...(resolvedAdditions !== undefined ? { additions: resolvedAdditions } : {}),
    ...(resolvedDeletions !== undefined ? { deletions: resolvedDeletions } : {}),
    ...(preview.length > 0 ? { diffPreview: preview } : {}),
  };
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** True only for an operation that explicitly mutates state outside the workspace. */
function actionHasExternalSideEffect(action: ProposedAction): boolean {
  if (
    action.mcp?.sideEffectHint === "write" ||
    action.mcp?.sideEffectHint === "destructive"
  ) {
    return true;
  }
  return action.command !== undefined && classifyCommand(action.command).externalSideEffect;
}
/** Parse a declared verification command without losing quoted argv boundaries. */
function parseCommandTokens(raw: string): string[] {
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
      if (char === "\\" && next !== undefined && /[\s"\\]/u.test(next)) { token += next; index += 1; }
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "\\") {
      if (next !== undefined && /[\s'"\\]/u.test(next)) { token += next; index += 1; }
      else token += char;
      continue;
    }
    if (/\s/u.test(char)) { if (token.length > 0) { tokens.push(token); token = ""; } continue; }
    token += char;
  }
  if (quote !== undefined) return [];
  if (token.length > 0) tokens.push(token);
  return tokens;
}


function contextProjectionMismatches(
  inputs: PromptInputs,
  compiled: CompiledModelRequest,
): string[] {
  const projection = inputs.contextProjection;
  if (projection === undefined) return [];
  const mismatches: string[] = [];
  const expectedManifest = projection.manifestDigest;
  const inputManifest = inputs.contextManifest?.compilerManifestDigest;
  const compiledManifest = compiled.contextManifest?.compilerManifestDigest;
  if (inputManifest !== expectedManifest) {
    mismatches.push("contextManifest.compilerManifestDigest does not match projection.manifestDigest");
  }
  if (compiledManifest !== expectedManifest) {
    mismatches.push("compiled.contextManifest.compilerManifestDigest does not match projection.manifestDigest");
  }
  if (compiled.providerContextDigest !== projection.renderedDigest) {
    mismatches.push("compiled.providerContextDigest does not match projection.renderedDigest");
  }
  return mismatches;
}

function countUnifiedDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * The first few changed lines of a unified diff, with their new line numbers.
 *
 * Additions and deletions only: context lines are what a reader already has on
 * screen, and spending two of four preview rows on unchanged text defeats the
 * point of the preview.
 */
function previewFromUnifiedDiff(diff: string): DiffPreviewLine[] {
  const out: DiffPreviewLine[] = [];
  let newLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      newLine = Number.parseInt(hunk[1] as string, 10);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) continue;

    if (line.startsWith("+")) {
      out.push({ kind: "added", lineNumber: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      out.push({ kind: "removed", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      newLine += 1;
      continue;
    } else {
      continue;
    }

    if (out.length >= MAX_DIFF_PREVIEW_LINES) break;
  }
  return out;
}

function summarizeTests(
  verification: CompletionReport["verification"],
): { passed: number; failed: number; notRun: number } {
  return {
    passed: verification.filter((v) => v.status === "passed").length,
    failed: verification.filter((v) => v.status === "failed").length,
    notRun: verification.filter((v) => v.status === "not_run").length,
  };
}


function joinBounded(values: Iterable<string>, maxChars: number): string {
  if (maxChars <= 0) return "";
  let result = "";
  for (const value of values) {
    const remaining = maxChars - result.length;
    if (remaining <= 0) break;
    result += value.slice(0, remaining);
  }
  return result;
}

function truncateSentences(text: string, max: number): string {
  // §6.8: render a reasoning summary as at most two sentences.
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.slice(0, max).join(" ");
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
