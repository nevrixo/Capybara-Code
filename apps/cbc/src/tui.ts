/**
 * Interactive front end — PRD §6.2, §6.20, §6.21, §7.1, §7.7, §19.3, AC-04, AC-40.
 *
 * ?19.3's ladder gives two interactive shapes. This module owns both the plain
 * append-only fallback and the bundled fullscreen renderer. Both use the same
 * semantic blocks from `@cbc/tui-components`; the fullscreen path redraws a frame
 * in the alternate screen while the fallback keeps append-only scrollback.
 *
 * §6.21's sidebar is the one place the two rungs genuinely differ. A pinned right
 * column needs a viewport to be pinned inside; append-only scrollback has none. So
 * the same widgets are emitted as a panel at the points where they would otherwise
 * have changed on screen — after a turn, and on request — rather than pretending to
 * be pinned and scrolling five copies of themselves past the reader.
 *
 * Two behaviours are requirements rather than choices:
 *
 *   - AC-04: something is on screen before any network call. The banner and the
 *     workspace line print during `open()`, before a provider is even constructed.
 *   - AC-40: the terminal is restored on a normal exit, on `Ctrl+C`, and on a
 *     crash. `restore()` is idempotent and is wired to every exit path.
 */

import type { ApprovalRequest } from "@cbc/permissions";
import type { CbcEvent } from "@cbc/protocol";
import type { SessionViewModel, TaskState, TimelineApproval, TimelineItem, TimelineSubagentEvent, TimelineTask } from "@cbc/session-domain";
import {
  ProjectedTimeline,
  Theme,
  blockContext,
  compactPath,
  composeScreen,
  enterSequence,
  joinColumns,
  line,
  liveStateLabel,
  planLayout,
  renderAnsi,
  renderApproval,
  renderPlanApprovalPicker,
  renderInputPrompt,
  renderUserAsk,
  renderCompletionPopup,
  renderComposer,
  renderOverlay,
  renderPlain,
  renderRightSidebar,
  renderIntervalMs,
  renderStatusBar,
  renderTimelineItem,
  isCapturingOverlay,
  projectTimeline,
  restoreSequence,
  segment,
  stringWidth,
  graphemes,
  palette,
  sidebarFromViewModel,
  statusFromViewModel,
  truncateToWidth,
  wrapComposer,
  applySelectionOverlay,
  extractSelectionText,
  makeToast,
  osc52Copy,
  renderToast,
  toastExpired,
  TOAST_DURATION_MS,
  visibleLiveState,
  type BlockContext,
  type CompletionPopupOptions,
  type CompletionState,
  type GitStatusView,
  type LayoutPlan,
  type OverlayKind,
  type SelectionState,
  type Segment,
  type SidebarService,
  type StyledLine,
  type SubagentDetail,
  type TerminalCapabilities,
  type ThinkingVisibility,
  type TimelineRenderOptions,
  type ToastState,
  type ToolDetail,
} from "@cbc/tui-components";

/** Concise choices shown when a ready Plan Contract asks what to do next. */
export const PLAN_APPROVAL_CHOICES = [
  "Yes, proceed",
  "Approve and keep planning",
  "Open plan (read-only)",
  "No, keep planning",
] as const;

import type { Host } from "./host.ts";
import { isMouseEvent, type InputEvent, type MouseEvent } from "./keys.ts";
import {
  LiveSpanRegistry,
  type LiveSpanOutcome,
  type LiveSpanPhase,
  type LiveSpanView,
} from "./live-spans.ts";
import type { OpenTuiView, TerminalCursorPosition } from "./opentui-view.ts";
import type { LineWriter, RenderDecision } from "./output.ts";
import { TerminalFrameWriter } from "./terminal-writer.ts";
import { TuiPerfRecorder, tuiPerfEnabled } from "./tui-perf.ts";

export interface InteractiveUiOptions {
  readonly host: Host;
  readonly decision: RenderDecision;
  readonly writer: LineWriter;
  readonly workspacePath: string;
  readonly version: string;
  readonly provider?: string;
  readonly git?: GitStatusView;
  /** §6.21: MCP rows for the sidebar. */
  readonly mcpServers?: readonly SidebarService[];
  /** §6.21: type-checker / LSP rows for the sidebar. */
  readonly lspServers?: readonly SidebarService[];
  /**
   * §21.4 `[ui]` config, wired through to the render decisions (P1-02):
   * theme palette, mouse tracking, animation, cost visibility, status density.
   * Each is optional; absent values keep the capability-detected defaults.
   */
  readonly uiTheme?: string;
  readonly uiMouse?: boolean;
  readonly uiAnimations?: boolean;
  readonly uiShowCost?: boolean;
  readonly uiStatusDensity?: "auto" | "compact" | "full";
  readonly uiThinkingVisibility?: ThinkingVisibility;
  readonly uiToolDetail?: ToolDetail;
  readonly uiSubagentDetail?: SubagentDetail;
  readonly sidebarVisibility?: SidebarVisibility;
  readonly onSettingChange?: (
    key: "thinkingVisibility" | "toolDetail" | "subagentDetail" | "sidebar",
    value: string,
  ) => void;
  /**
   * The permission axes in effect for this session, rendered on the status bar
   * so the footer always shows what the policy engine will do — the mode name
   * alone does not say whether writes, shells, or the network are open.
   */
  readonly permissionsSummary?: string;
  readonly credentialSource?: string;
}

export type SidebarVisibility = "auto" | "show" | "hide";

export interface FrameRevisions {
  readonly layout: number;
  readonly timeline: number;
  readonly live: number;
  readonly sidebar: number;
  readonly composer: number;
  readonly completion: number;
  readonly status: number;
  readonly overlay: number;
  readonly selection: number;
}

export type FrameRegion = keyof FrameRevisions;

export interface SettingsMenuValue {
  readonly value: string;
  readonly label: string;
}

export interface SettingsMenuItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly values: readonly SettingsMenuValue[];
}

export interface SettingsMenuChange {
  readonly value?: string;
  readonly message?: string;
}

export type SettingsMenuChangeHandler = (
  key: string,
  value: string,
) => SettingsMenuChange | undefined;

interface SettingsMenuState {
  items: SettingsMenuItem[];
  selected: number;
  editing: boolean;
  valueSelected: number;
  onChange: SettingsMenuChangeHandler;
}

/** Provider phases that may arrive as low-latency assistant deltas. */
export type AssistantStreamPhase = LiveSpanPhase;

// Ten frames per second keeps the activity cue visible while the semantic viewport
// projection and native row renderer reuse every unchanged group/region;
// composer/provider updates retain their own coalesced frame cadence.
const FULL_SCREEN_SPINNER_INTERVAL_MS = 100;

/**
 * Renders session events as they arrive and reads user input.
 *
 * Rendering is *incremental by timeline length*: each flush emits only the items
 * that appeared since the last one. §22.3 caps frame cost by viewport rather than
 * history, and in an append-only terminal the cheapest way to honour that is to
 * never re-emit a block that has already scrolled past.
 */
export class InteractiveUi {
  readonly #options: InteractiveUiOptions;
  #context: BlockContext;
  #plan: LayoutPlan;
  #renderedItems = 0;
  /** First projected item retained by the bounded resident timeline in plain mode. */
  #plainTimelineHeadId: string | undefined;
  #plainRawTimelineLength = 0;
  #plainRawTimelineTailId: string | undefined;
  /**
   * Last snapshots painted to append-only scrollback. Full-screen frames never use
   * this reconciliation state, so those sessions do not allocate or retain it.
   */
  readonly #renderedSnapshots: Map<string, TimelineItem> | undefined;
  /** Source references from the last plain-mode flush. */
  readonly #renderedSources: Map<string, TimelineItem> | undefined;
  /** Rows the last `drawComposer` emitted, so they can be erased in place. */
  #composerLines = 0;
  /** Rows scrolled back from the newest timeline tail in the full-screen view. */
  #timelineScrollOffset = 0;
  /** Last known timeline range, used to clamp repeated input at the oldest row. */
  #timelineMaxScrollOffset: number | undefined;
  /** Physical size of the last painted frame, used to detect resize before input. */
  #lastFrameSize: { columns: number; rows: number } | undefined;
  /** Session-scoped visual index; plain append-only mode needs no frame projection. */
  #timelineProjection: ProjectedTimeline | undefined;
  #restored = false;
  #lastLiveLabel = "";
  #sidebarVisible: boolean | undefined;
  #mcpServers: readonly SidebarService[];
  #lspServers: readonly SidebarService[];
  #turnTitle: string | undefined;
  #latestModel: SessionViewModel | undefined;
  #residentModel: SessionViewModel | undefined;
  #historicalTimeline: readonly TimelineItem[] = [];
  #historicalRevision = 0;
  #historicalMergeCache:
    | {
        readonly historicalRevision: number;
        readonly residentTimeline: readonly TimelineItem[];
        readonly result: SessionViewModel;
      }
    | undefined;
  #loadEarlierHistory: (() => Promise<readonly TimelineItem[] | undefined>) | undefined;
  #loadingEarlierHistory = false;
  #historyLoaderGeneration = 0;
  #selectedReasoningEffort: string | undefined;
  #composerState: {
    text: string;
    cursor: number;
    metrics?: { readonly revision: number; readonly graphemes: readonly string[]; readonly charOffsets: readonly number[] };
  } = { text: "", cursor: 0 };
  #completion: CompletionState | undefined;
  #notices: string[] = [];
  #thinkingVisibility: ThinkingVisibility = "full";
  #toolDetail: ToolDetail = "compact";
  #subagentDetail: SubagentDetail = "drawer";
  #lastNoticeText: string | undefined;
  #lastNoticeCount = 0;
  #effectiveSandbox: string | undefined;
  /** Correlated provider text that has not landed as a durable event yet. */
  readonly #liveSpans = new LiveSpanRegistry();
  readonly #streamingItems = new Map<string, { revision: number; item: TimelineItem }>();
  /** One sink-delivered assistant mutation already painted in plain stream output. */
  #plainReconciledDurable:
    | {
        readonly eventId: string;
        readonly text: string;
        readonly phase: AssistantStreamPhase;
        readonly turnId?: string;
      }
    | undefined;
  #streamingOpen = false;
  #streamingPlainPhase: AssistantStreamPhase | undefined;
  readonly #fullScreen: boolean;
  #openTui: OpenTuiView | undefined;
  #ansiWriter: TerminalFrameWriter | undefined;
  readonly #perf: TuiPerfRecorder;
  /** Coalesces all full-screen frame requests behind one dirty boundary. */
  #frameTimer: ReturnType<typeof setTimeout> | undefined;
  #frameDirty = false;
  #dirtyRegions = new Set<FrameRegion>();
  #frameRevisions: FrameRevisions = {
    layout: 0,
    timeline: 0,
    live: 0,
    sidebar: 0,
    composer: 0,
    completion: 0,
    status: 0,
    overlay: 0,
    selection: 0,
  };
  #clearScreenOnNextFrame = false;
  /** Current live-state spinner frame for the full-screen renderer. */
  #liveFrame = 0;
  /** Repaints the live line while a turn is actively running. */
  #liveAnimationTimer: ReturnType<typeof setInterval> | undefined;
  #disposeOpenTuiResize: (() => void) | undefined;

  // -- Mouse selection -------------------------------------------------------
  /** Active mouse-drag selection, in frame coordinates. */
  #selection: SelectionState | undefined;
  /** The last painted frame, kept so a selection release can extract its text. */
  #lastFrame: readonly StyledLine[] = [];
  /** Pending toast, removed when its expiry passes. */
  #toast: ToastState | undefined;
  /** Toast expiry timer. */
  #toastTimer: ReturnType<typeof setTimeout> | undefined;

  #sessionId: string | undefined;
  #credentialSource: string | undefined;
  #isDraggingScrollbar = false;

  constructor(options: InteractiveUiOptions) {
    this.#options = options;
    this.#perf = new TuiPerfRecorder(tuiPerfEnabled(options.host.env));
    this.#plan = planLayout(options.decision.capabilities.columns, {
      rows: options.decision.capabilities.rows,
    });
    this.#context = blockContext(options.decision.capabilities, this.#plan.mainWidth);
    this.#mcpServers = options.mcpServers ?? [];
    this.#lspServers = options.lspServers ?? [];
    // Plain mode is append-only scrollback. Only the renderer-backed mode owns a
    // full-screen frame; treating plain as full-screen makes every keystroke erase
    // and repaint the entire terminal, and can starve a running turn on slow TTYs.
    this.#fullScreen = options.decision.mode === "opentui";
    this.#thinkingVisibility = options.uiThinkingVisibility ?? "full";
    this.#toolDetail = options.uiToolDetail ?? "compact";
    this.#subagentDetail = options.uiSubagentDetail ?? "drawer";
    this.#credentialSource = options.credentialSource;
    this.#sidebarVisible =
      options.sidebarVisibility === undefined || options.sidebarVisibility === "auto"
        ? undefined
        : options.sidebarVisibility === "show";
    this.#replan();
    this.#timelineProjection = this.#fullScreen ? new ProjectedTimeline() : undefined;
    this.#renderedSnapshots = this.#fullScreen ? undefined : new Map<string, TimelineItem>();
    this.#renderedSources = this.#fullScreen ? undefined : new Map<string, TimelineItem>();
  }

  get capabilities(): TerminalCapabilities {
    const base = this.#options.decision.capabilities;
    // §21.4 `ui.animations = false` maps onto reduced motion: slower frame
    // batching and the spinner fallbacks the capability already drives.
    if (this.#options.uiAnimations === false && !base.reducedMotion) {
      return { ...base, reducedMotion: true };
    }
    return base;
  }

  get theme(): Theme {
    const decisionTheme = this.#options.decision.theme;
    const name = this.#options.uiTheme;
    if (name === undefined || name === decisionTheme.name) return decisionTheme;
    // §21.4 `[tui] theme` selects a named palette; an unknown name keeps the
    // default rather than rendering with a half-resolved theme.
    const base = palette(name);
    if (base === undefined) return decisionTheme;
    return new Theme({ name, depth: decisionTheme.depth, palette: base });
  }

  get layout(): LayoutPlan {
    return this.#plan;
  }

  get timelineScrollOffset(): number {
    return this.#timelineScrollOffset;
  }

  get ansiWriterStats() {
    return this.#ansiWriter?.stats;
  }

  get perfSnapshot() {
    return this.#perf.snapshot();
  }

  get frameRevisions(): FrameRevisions {
    return { ...this.#frameRevisions };
  }

  get dirtyRegions(): readonly FrameRegion[] {
    return [...this.#dirtyRegions];
  }

  setSessionInfo(sessionId: string, credentialSource?: string): void {
    this.#sessionId = sessionId;
    if (credentialSource !== undefined) {
      this.#credentialSource = credentialSource;
    }
    this.#markFrameDirty("status", "sidebar");
    if (this.#fullScreen) this.#scheduleFrame();
  }

  setEffectiveSandbox(_level: string, _backends: readonly string[] = [], _degraded = false, _requestedLevel?: string): void {
  }

  /** Move the timeline line-by-line toward older output. */
  scrollUp(lines = 3): void {
    this.#moveTimelineScroll(Math.max(0, Math.floor(lines)));
  }

  /** Move the timeline line-by-line toward the live bottom. */
  scrollDown(lines = 3): void {
    this.#moveTimelineScroll(-Math.max(0, Math.floor(lines)));
  }

  /** Move the timeline one viewport page toward older output. */
  scrollPageUp(): void {
    this.#moveTimelineScroll(this.#timelinePageRows());
    if (
      this.#timelineMaxScrollOffset !== undefined &&
      this.#timelineScrollOffset >= this.#timelineMaxScrollOffset
    ) void this.#requestEarlierHistory();
  }

  /** Replace the immutable older-page source when a durable session changes. */
  setEarlierHistoryLoader(
    loader: (() => Promise<readonly TimelineItem[] | undefined>) | undefined,
  ): void {
    this.#invalidateTimelineScrollRange();
    this.#historyLoaderGeneration += 1;
    this.#loadEarlierHistory = loader;
    this.#historicalTimeline = [];
    this.#historicalRevision += 1;
    this.#historicalMergeCache = undefined;
    this.#loadingEarlierHistory = false;
    if (this.#residentModel !== undefined) {
      this.#latestModel = this.#residentModel;
    }
  }

  async #requestEarlierHistory(): Promise<void> {
    const loader = this.#loadEarlierHistory;
    if (!this.#fullScreen || loader === undefined || this.#loadingEarlierHistory) return;
    const generation = this.#historyLoaderGeneration;
    this.#loadingEarlierHistory = true;
    try {
      const historical = await loader();
      if (generation !== this.#historyLoaderGeneration) return;
      if (historical === undefined) {
        this.#loadEarlierHistory = undefined;
        return;
      }
      this.#historicalTimeline = historical;
      this.#historicalRevision += 1;
      this.#historicalMergeCache = undefined;
      if (this.#residentModel !== undefined) {
        this.#latestModel = this.#withHistoricalTimeline(this.#residentModel);
      }
      this.#timelineMaxScrollOffset = undefined;
      this.#timelineScrollOffset += this.#timelinePageRows();
      this.#markFrameDirty("timeline");
      this.#scheduleFrame();
    } catch (error) {
      if (generation === this.#historyLoaderGeneration) {
        this.diagnostic(
          `earlier session history could not be loaded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.#loadEarlierHistory = undefined;
      }
    } finally {
      if (generation === this.#historyLoaderGeneration) {
        this.#loadingEarlierHistory = false;
      }
    }
  }

  #withHistoricalTimeline(model: SessionViewModel): SessionViewModel {
    if (this.#historicalTimeline.length === 0) return model;
    const cached = this.#historicalMergeCache;
    if (
      cached?.historicalRevision === this.#historicalRevision &&
      cached.residentTimeline === model.timeline
    ) {
      return cached.result;
    }

    const merged = mergeHistoricalTimeline(this.#historicalTimeline, model.timeline);
    const result = merged.length === model.timeline.length
      ? model
      : { ...model, timeline: merged };
    this.#historicalMergeCache = {
      historicalRevision: this.#historicalRevision,
      residentTimeline: model.timeline,
      result,
    };
    return result;
  }

  /** Move the timeline one viewport page toward the live bottom. */
  scrollPageDown(): void {
    this.#moveTimelineScroll(-this.#timelinePageRows());
  }

  /** Apply a scroll delta once, avoiding redraws when a boundary already holds. */
  #moveTimelineScroll(delta: number): void {
    if (!this.#fullScreen || delta === 0) return;
    const size = this.#terminalSize();
    if (
      this.#lastFrameSize !== undefined &&
      (this.#lastFrameSize.columns !== size.columns || this.#lastFrameSize.rows !== size.rows)
    ) {
      this.#invalidateTimelineScrollRange();
    }
    const step = Math.max(1, Math.abs(delta));
    const next =
      delta > 0
        ? Math.min(
            this.#timelineMaxScrollOffset ?? Number.POSITIVE_INFINITY,
            this.#timelineScrollOffset + step,
          )
        : Math.max(0, this.#timelineScrollOffset - step);
    if (next === this.#timelineScrollOffset) return;
    this.#timelineScrollOffset = next;
    this.#markFrameDirty("timeline");
    this.#scheduleFrame();
  }
  /** Toggle the context sidebar and return its new visibility. */
  toggleSidebar(): boolean {
    const showing = this.#plan.showSidebar;
    return this.setSidebarVisibility(showing ? "hide" : "show");
  }

  /** Set the context sidebar visibility without relying on its current state. */
  setSidebarVisible(visible: boolean): boolean {
    return this.setSidebarVisibility(visible ? "show" : "hide");
  }

  setSidebarVisibility(visibility: SidebarVisibility): boolean {
    this.#sidebarVisible = visibility === "auto" ? undefined : visibility === "show";
    this.#replan();
    this.#markFrameDirty("layout", "sidebar", "composer", "timeline");
    if (this.#fullScreen) this.#scheduleFrame();
    this.#options.onSettingChange?.("sidebar", visibility);
    return this.#plan.showSidebar;
  }

  #accordionCollapsed = false;
  toggleAccordion(): string {
    this.#accordionCollapsed = !this.#accordionCollapsed;
    this.#timelineScrollOffset = 0;
    this.#invalidateTimelineScrollRange();
    this.#markFrameDirty("timeline");
    if (this.#fullScreen) this.#scheduleFrame();
    return this.#accordionCollapsed ? "Details collapsed · Ctrl+O to expand" : "Details expanded · Ctrl+O to collapse";
  }
  get accordionCollapsed(): boolean {
    return this.#accordionCollapsed;
  }

  get presentationPolicy(): {
    readonly thinkingVisibility: ThinkingVisibility;
    readonly toolDetail: ToolDetail;
    readonly subagentDetail: SubagentDetail;
  } {
    return {
      thinkingVisibility: this.#thinkingVisibility,
      toolDetail: this.#toolDetail,
      subagentDetail: this.#subagentDetail,
    };
  }

  get sidebarVisibility(): SidebarVisibility {
    return this.#sidebarVisible === undefined ? "auto" : this.#sidebarVisible ? "show" : "hide";
  }

  setThinkingVisibility(value: ThinkingVisibility): string {
    this.#thinkingVisibility = value;
    this.#timelineScrollOffset = 0;
    this.#invalidateTimelineScrollRange();
    this.#markFrameDirty("timeline");
    if (this.#fullScreen) this.#scheduleFrame();
    this.#options.onSettingChange?.("thinkingVisibility", value);
    return `Thinking visibility: ${value}`;
  }

  cycleThinkingVisibility(): string {
    const values: readonly ThinkingVisibility[] = ["full", "summary", "hidden"];
    const current = values.indexOf(this.#thinkingVisibility);
    return this.setThinkingVisibility(values[(current + 1) % values.length] ?? "full");
  }

  setToolDetail(value: ToolDetail): string {
    this.#toolDetail = value;
    this.#timelineScrollOffset = 0;
    this.#invalidateTimelineScrollRange();
    this.#markFrameDirty("timeline");
    if (this.#fullScreen) this.#scheduleFrame();
    this.#options.onSettingChange?.("toolDetail", value);
    return `Tool detail: ${value}`;
  }

  setSubagentDetail(value: SubagentDetail): string {
    this.#subagentDetail = value;
    this.#timelineScrollOffset = 0;
    this.#invalidateTimelineScrollRange();
    this.#markFrameDirty("timeline", "sidebar");
    if (this.#fullScreen) this.#scheduleFrame();
    this.#options.onSettingChange?.("subagentDetail", value);
    return `Subagent detail: ${value}`;
  }

  #timelineOptions(model: SessionViewModel): TimelineRenderOptions {
    return {
      modelId: model.modelId,
      thinkingVisibility: this.#thinkingVisibility,
      toolDetail: this.#toolDetail,
      subagentDetail: this.#subagentDetail,
      nowMs: this.#options.host.now(),
      ...(model.currentTurnId !== undefined ? { currentTurnId: model.currentTurnId } : {}),
      turnActive: !["idle", "completed", "cancelled", "failed", "partial"].includes(
        model.turnStatus,
      ),
      progressiveDisclosure: true,
      groupSucceededReads: true,
      ...(this.#accordionCollapsed
        ? {
            accordionCollapsed: true,
            accordionExpandedIds: liveExpandedIds(model),
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Overlay stack (P0-07) and approval focus (P0-08)
  // -------------------------------------------------------------------------
  /**
   * Open documents. In full-screen mode a slash command's multi-line output is
   * a document the user must be able to read in full — routing it through the
   * three-line notice queue silently destroyed everything past line three.
   */
  #overlay: { kind: OverlayKind; body: readonly StyledLine[]; offset: number } | undefined;
  /**
   * The pending approval, owned by the frame. While it is set, the single key
   * stream routes to {@link handleApprovalKey}; no second stdin reader is ever
   * attached (P0-08).
   */
  #approval:
    | {
        readonly request: ApprovalRequest;
        readonly choices: readonly string[];
        selected: number;
        resolve: (index: number) => void;
      }
    | undefined;

  /**
   * The focused Plan Contract decision. This intentionally has its own state
   * rather than masquerading as a permission ApprovalRequest: approving a Plan
   * changes the durable digest-bound execution contract, not a tool rule.
   */
  #planApproval:
    | {
        readonly state: SessionViewModel["todo"];
        readonly choices: readonly string[];
        selected: number;
        resolve: (index: number) => void;
      }
    | undefined;

  #promptRequest:
    | {
        readonly label: string;
        text: string;
        cursor: number;
        resolve: (value: string | undefined) => void;
      }
    | undefined;

  /** A `user.ask` choice list owned by the same key stream as approvals. */
  #userAsk:
    | {
        readonly question: string;
        readonly choices: readonly string[];
        selected: number;
        resolve: (index: number) => void;
      }
    | undefined;

  /** True while a document overlay is open. */
  get overlayOpen(): boolean {
    return this.#overlay !== undefined;
  }

  /** Whether the open overlay owns printable/editor keys instead of the composer. */
  get overlayCapturesInput(): boolean {
    return this.#settingsMenu !== undefined ||
      (this.#overlay !== undefined && isCapturingOverlay(this.#overlay.kind));
  }

  #settingsMenu: SettingsMenuState | undefined;

  /** True while an approval card is waiting for a decision. */
  get approvalActive(): boolean {
    return this.#approval !== undefined;
  }

  /** True while the focused Plan Contract picker is waiting for a decision. */
  get planApprovalActive(): boolean {
    return this.#planApproval !== undefined;
  }

  /** True while an inline input prompt is waiting for input. */
  get promptActive(): boolean {
    return this.#promptRequest !== undefined;
  }

  /** True while a `user.ask` choice card owns the session key stream. */
  get userAskActive(): boolean {
    return this.#userAsk !== undefined;
  }

  /** Current semantic renderer context for host-built document overlays. */
  get blockContext(): BlockContext {
    return this.#context;
  }

  /**
   * Show a document. Full-screen renders it as an overlay closed by `Esc`;
   * append-only mode prints it inline, which is the honest equivalent (§19.3).
   */
  openOverlay(kind: OverlayKind, body: readonly StyledLine[] | readonly string[]): void {
    this.#settingsMenu = undefined;
    this.#invalidateTimelineScrollRange();
    const lines = body.map((entry) =>
      typeof entry === "string"
        ? line("overlay", [segment(entry.length > 0 ? entry : " ", { fg: "fg.primary" })])
        : entry,
    );
    if (!this.#fullScreen) {
      this.#eraseComposer();
      this.#options.writer.write(renderOverlay(kind, lines, this.#context));
      this.#options.writer.text("");
      return;
    }
    this.#overlay = { kind, body: lines, offset: 0 };
    this.#scheduleFrame();
  }

  /**
   * Open the persistent settings picker. Passing a setting key skips the overview
   * and opens that setting's value picker immediately.
   */
  openSettings(
    items: readonly SettingsMenuItem[],
    onChange: SettingsMenuChangeHandler,
    initialSettingKey?: string,
  ): boolean {
    if (!this.#fullScreen || items.length === 0) return false;
    const selected = initialSettingKey === undefined
      ? 0
      : items.findIndex((item) => item.key === initialSettingKey);
    if (selected < 0) return false;
    const selectedItem = items[selected];
    if (selectedItem === undefined) return false;
    this.#settingsMenu = {
      items: items.map((item) => ({ ...item, values: [...item.values] })),
      selected,
      editing: initialSettingKey !== undefined && selectedItem.values.length > 0,
      valueSelected: Math.max(0, selectedItem.values.findIndex((value) => value.value === selectedItem.value)),
      onChange,
    };
    this.#refreshSettingsOverlay();
    return true;
  }

  /** Handle keys for the persistent settings picker. */
  handleOverlayKey(event: InputEvent): boolean {
    const menu = this.#settingsMenu;
    if (menu === undefined || isMouseEvent(event)) return false;

    const item = menu.items[menu.selected];
    if (item === undefined) return true;
    const count = menu.editing ? item.values.length : menu.items.length;
    if (count === 0) return true;

    const move = (delta: number): void => {
      if (menu.editing) {
        menu.valueSelected = (menu.valueSelected + delta + count) % count;
      } else {
        menu.selected = (menu.selected + delta + count) % count;
        const next = menu.items[menu.selected];
        if (next !== undefined) {
          menu.valueSelected = Math.max(0, next.values.findIndex((entry) => entry.value === next.value));
        }
      }
      this.#refreshSettingsOverlay();
    };

    switch (event.key) {
      case "up":
      case "ctrl+p":
        move(-1);
        return true;
      case "down":
      case "ctrl+n":
      case "tab":
        move(1);
        return true;
      case "home":
        if (menu.editing) menu.valueSelected = 0;
        else menu.selected = 0;
        this.#refreshSettingsOverlay();
        return true;
      case "end":
        if (menu.editing) menu.valueSelected = count - 1;
        else menu.selected = count - 1;
        this.#refreshSettingsOverlay();
        return true;
      case "left":
      case "escape":
        if (menu.editing) {
          menu.editing = false;
          this.#refreshSettingsOverlay();
        } else {
          this.closeOverlay();
        }
        return true;
      case "right":
      case "enter":
        if (!menu.editing) {
          menu.editing = true;
          menu.valueSelected = Math.max(0, item.values.findIndex((entry) => entry.value === item.value));
          this.#refreshSettingsOverlay();
          return true;
        }
        this.#applySettingsChoice(menu, item);
        return true;
      case "ctrl+c":
        return false;
      case "text": {
        const text = event.text ?? "";
        if (text === "\x03") {
          return false;
        }
        if (text.toLowerCase() === "q") {
          this.closeOverlay();
          return true;
        }
        if (!/^\d$/.test(text)) return true;
        const index = Number(text) - 1;
        if (index < 0 || index >= count) return true;
        if (menu.editing) menu.valueSelected = index;
        else menu.selected = index;
        this.#refreshSettingsOverlay();
        return true;
      }
      default:
        return true;
    }
  }

  #applySettingsChoice(
    menu: SettingsMenuState,
    item: SettingsMenuItem,
  ): void {
    const choice = item.values[menu.valueSelected];
    if (choice === undefined) return;
    const result = menu.onChange(item.key, choice.value);
    const nextValue = result?.value ?? choice.value;
    menu.items[menu.selected] = { ...item, value: nextValue };
    menu.editing = false;
    if (result?.message !== undefined) this.notice(result.message);
    this.#refreshSettingsOverlay();
  }

  #refreshSettingsOverlay(): void {
    const menu = this.#settingsMenu;
    if (menu === undefined) return;
    const lines = this.#settingsBody(menu);
    this.#overlay = {
      kind: "settings",
      body: lines.map((text) => line("overlay", [segment(text, { fg: "fg.primary" })])),
      offset: 0,
    };
    this.#scheduleFrame();
  }

  #settingsBody(menu: SettingsMenuState): string[] {
    const marker = this.capabilities.unicode ? "▸" : ">";
    if (menu.editing) {
      const item = menu.items[menu.selected];
      if (item === undefined) return [];
      const lines = [
        `Editing: ${item.label}`,
      ];
      const width = item.values.reduce((max, value) => Math.max(max, value.label.length), 0);
      for (const [index, value] of item.values.entries()) {
        const active = index === menu.valueSelected;
        const current = value.value === item.value ? "  (current)" : "";
        lines.push(`${active ? marker : " "} ${value.label.padEnd(width)}${current}`);
      }
      lines.push("");
      lines.push("Up/down choose · Enter apply · Esc back");
      return lines;
    }

    const lines: string[] = [];
    const width = menu.items.reduce((max, item) => Math.max(max, item.label.length), 0);
    for (const [index, item] of menu.items.entries()) {
      const active = index === menu.selected;
      const current = item.values.find((value) => value.value === item.value)?.label ?? item.value;
      lines.push(`${active ? marker : " "} ${item.label.padEnd(width)}  ${current}`);
    }
    lines.push("");
    lines.push("Up/down choose · Enter edit · Esc close");
    return lines;
  }

  scrollOverlay(delta: number): void {
    if (!this.#fullScreen || this.#overlay === undefined || delta === 0) return;
    const rows = Math.max(1, this.#openTui?.rows || this.#options.host.io.rows || 24);
    const bodyRows = Math.max(0, rows - 7);
    const contentRows = Math.max(0, this.#overlay.body.length - 2);
    const maxOffset = Math.max(0, contentRows - bodyRows);
    const next = Math.min(maxOffset, Math.max(0, this.#overlay.offset + Math.trunc(delta)));
    if (next === this.#overlay.offset) return;
    this.#overlay = { ...this.#overlay, offset: next };
    this.#scheduleFrame();
  }

  /** Close the open overlay, returning its kind for focus restoration. */
  closeOverlay(): OverlayKind | undefined {
    if (this.#overlay === undefined) return undefined;
    const kind = this.#overlay.kind;
    this.#settingsMenu = undefined;
    this.#overlay = undefined;
    this.#invalidateTimelineScrollRange();
    if (this.#fullScreen) this.#scheduleFrame();
    return kind;
  }

  /**
   * Present a focused Plan Contract picker and resolve with the chosen action.
   *
   * This shares the approval focus slot with permission cards, but keeps a
   * separate state/type because the choices call session plan APIs rather than
   * creating permission grants. `-1` means cancel.
   */
  requestPlanApproval(
    state: SessionViewModel["todo"],
    choices: readonly string[] = PLAN_APPROVAL_CHOICES,
  ): Promise<number> {
    if (!this.#fullScreen || choices.length === 0) return Promise.resolve(-1);
    // There is only one focus owner. A plan picker and a permission card must
    // never both consume the session key stream.
    if (this.#approval !== undefined) {
      const approval = this.#approval;
      this.#approval = undefined;
      approval.resolve(-1);
    }
    if (this.#planApproval !== undefined) {
      const pending = this.#planApproval;
      this.#planApproval = undefined;
      pending.resolve(-1);
    }
    return new Promise<number>((resolve) => {
      this.#planApproval = {
        state,
        choices: [...choices],
        selected: 0,
        resolve,
      };
      this.#invalidateTimelineScrollRange();
      this.#scheduleFrame();
    });
  }

  /**
   * Present an approval card inside the frame and resolve with the chosen index.
   *
   * Full-screen only: the plain fallback keeps the broker's own prompt. `-1`
   * means the user walked away (Esc / Ctrl+C), which the broker treats as a
   * denial — never as an allow.
   */
  requestApproval(request: ApprovalRequest, choices: readonly string[]): Promise<number> {
    if (!this.#fullScreen) {
      return Promise.resolve(-1);
    }
    // A second approval cannot stack over the first; the policy engine only
    // ever has one outstanding ask per session. It also cannot stack over a
    // focused Plan picker because both use the same single key stream.
    if (this.#approval !== undefined) {
      const approval = this.#approval;
      this.#approval = undefined;
      approval.resolve(-1);
    }
    if (this.#planApproval !== undefined) {
      const pending = this.#planApproval;
      this.#planApproval = undefined;
      pending.resolve(-1);
    }
    return new Promise<number>((resolve) => {
      this.#approval = { request, choices, selected: 0, resolve };
      this.#invalidateTimelineScrollRange();
      this.#scheduleFrame();
    });
  }

  /** Route one key to the pending approval card (P0-08's single input owner). */
  handleApprovalKey(event: InputEvent): void {
    const approval = this.#approval;
    if (approval === undefined || isMouseEvent(event)) return;
    const count = approval.choices.length;

    const finish = (index: number): void => {
      this.#approval = undefined;
      this.#invalidateTimelineScrollRange();
      approval.resolve(index);
      this.#scheduleFrame();
    };

    switch (event.key) {
      case "up":
      case "ctrl+p":
        approval.selected = (approval.selected - 1 + count) % count;
        this.#scheduleFrame();
        return;
      case "down":
      case "ctrl+n":
      case "tab":
        approval.selected = (approval.selected + 1) % count;
        this.#scheduleFrame();
        return;
      case "shift+tab":
        approval.selected = (approval.selected - 1 + count) % count;
        this.#scheduleFrame();
        return;
      case "home":
        approval.selected = 0;
        this.#scheduleFrame();
        return;
      case "end":
        approval.selected = count - 1;
        this.#scheduleFrame();
        return;
      case "enter":
        finish(approval.selected);
        return;
      case "escape":
      case "ctrl+c":
        // Walking away is a denial, and it must not double as a turn cancel:
        // the key stops here (P0-08).
        finish(-1);
        return;
      case "text": {
        // `1`–`9` jump-select the numbered choice.
        const digit = event.text !== undefined ? /^[1-9]$/.exec(event.text) : null;
        if (digit !== null) {
          const index = Number(digit[0]) - 1;
          if (index < count) {
            approval.selected = index;
            finish(index);
            return;
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** Present a `user.ask` choice list inside the active TUI frame. */
  requestUserAsk(question: string, choices: readonly string[]): Promise<number> {
    if (!this.#fullScreen || choices.length === 0) return Promise.resolve(-1);
    if (this.#userAsk !== undefined) {
      const pending = this.#userAsk;
      this.#userAsk = undefined;
      pending.resolve(-1);
    }
    return new Promise<number>((resolve) => {
      this.#userAsk = { question, choices: [...choices], selected: 0, resolve };
      this.#invalidateTimelineScrollRange();
      this.#scheduleFrame();
    });
  }

  /** Route one key to the focused `user.ask` choice list. */
  handleUserAskKey(event: InputEvent): void {
    const ask = this.#userAsk;
    if (ask === undefined || isMouseEvent(event)) return;
    const count = ask.choices.length;
    if (count === 0) return;

    const finish = (index: number): void => {
      this.#userAsk = undefined;
      this.#invalidateTimelineScrollRange();
      ask.resolve(index);
      this.#scheduleFrame();
    };

    switch (event.key) {
      case "up":
      case "ctrl+p":
        ask.selected = (ask.selected - 1 + count) % count;
        this.#scheduleFrame();
        return;
      case "down":
      case "ctrl+n":
      case "tab":
        ask.selected = (ask.selected + 1) % count;
        this.#scheduleFrame();
        return;
      case "shift+tab":
        ask.selected = (ask.selected - 1 + count) % count;
        this.#scheduleFrame();
        return;
      case "home":
        ask.selected = 0;
        this.#scheduleFrame();
        return;
      case "end":
        ask.selected = count - 1;
        this.#scheduleFrame();
        return;
      case "enter":
        finish(ask.selected);
        return;
      case "escape":
      case "ctrl+c":
        finish(-1);
        return;
      case "text": {
        const digit = event.text !== undefined ? /^[1-9]$/.exec(event.text) : null;
        if (digit !== null) {
          const index = Number(digit[0]) - 1;
          if (index < count) {
            ask.selected = index;
            finish(index);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** Route one key to the focused Plan Contract picker. */
  handlePlanApprovalKey(event: InputEvent): void {
    const plan = this.#planApproval;
    if (plan === undefined || isMouseEvent(event)) return;
    const count = plan.choices.length;
    if (count === 0) return;

    const finish = (index: number): void => {
      this.#planApproval = undefined;
      this.#invalidateTimelineScrollRange();
      plan.resolve(index);
      this.#scheduleFrame();
    };

    switch (event.key) {
      case "up":
      case "ctrl+p":
        plan.selected = (plan.selected - 1 + count) % count;
        this.#scheduleFrame();
        return;
      case "down":
      case "ctrl+n":
      case "tab":
        plan.selected = (plan.selected + 1) % count;
        this.#scheduleFrame();
        return;
      case "shift+tab":
        plan.selected = (plan.selected - 1 + count) % count;
        this.#scheduleFrame();
        return;
      case "home":
        plan.selected = 0;
        this.#scheduleFrame();
        return;
      case "end":
        plan.selected = count - 1;
        this.#scheduleFrame();
        return;
      case "enter":
        finish(plan.selected);
        return;
      case "escape":
      case "ctrl+c":
        finish(-1);
        return;
      case "text": {
        const digit = event.text !== undefined ? /^[1-9]$/.exec(event.text) : null;
        if (digit !== null) {
          const index = Number(digit[0]) - 1;
          if (index < count) {
            plan.selected = index;
            finish(index);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Present an inline prompt card inside the TUI frame and resolve with the typed text.
   */
  requestPrompt(label: string): Promise<string | undefined> {
    if (!this.#fullScreen) {
      return this.#options.host.io.prompt(label);
    }
    if (this.#promptRequest !== undefined) this.#promptRequest.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      this.#promptRequest = { label, text: "", cursor: 0, resolve };
      this.#invalidateTimelineScrollRange();
      this.#scheduleFrame();
    });
  }

  /** Route one key to the pending inline input prompt card. */
  handlePromptKey(event: InputEvent): void {
    const promptReq = this.#promptRequest;
    if (promptReq === undefined || isMouseEvent(event)) return;

    const finish = (value: string | undefined): void => {
      this.#promptRequest = undefined;
      this.#invalidateTimelineScrollRange();
      promptReq.resolve(value);
      this.#scheduleFrame();
    };

    switch (event.key) {
      case "enter":
        finish(promptReq.text);
        return;
      case "escape":
      case "ctrl+c":
        finish(undefined);
        return;
      case "backspace":
        if (promptReq.cursor > 0) {
          promptReq.text = promptReq.text.slice(0, promptReq.cursor - 1) + promptReq.text.slice(promptReq.cursor);
          promptReq.cursor--;
          this.#scheduleFrame();
        }
        return;
      case "delete":
        if (promptReq.cursor < promptReq.text.length) {
          promptReq.text = promptReq.text.slice(0, promptReq.cursor) + promptReq.text.slice(promptReq.cursor + 1);
          this.#scheduleFrame();
        }
        return;
      case "left":
      case "ctrl+b":
        if (promptReq.cursor > 0) {
          promptReq.cursor--;
          this.#scheduleFrame();
        }
        return;
      case "right":
      case "ctrl+f":
        if (promptReq.cursor < promptReq.text.length) {
          promptReq.cursor++;
          this.#scheduleFrame();
        }
        return;
      case "home":
      case "ctrl+a":
        promptReq.cursor = 0;
        this.#scheduleFrame();
        return;
      case "end":
      case "ctrl+e":
        promptReq.cursor = promptReq.text.length;
        this.#scheduleFrame();
        return;
      case "text":
        if (event.text !== undefined && event.text.length > 0) {
          promptReq.text =
            promptReq.text.slice(0, promptReq.cursor) + event.text + promptReq.text.slice(promptReq.cursor);
          promptReq.cursor += event.text.length;
          this.#scheduleFrame();
        }
        return;
      default:
        if (event.text !== undefined && event.text.length > 0) {
          promptReq.text =
            promptReq.text.slice(0, promptReq.cursor) + event.text + promptReq.text.slice(promptReq.cursor);
          promptReq.cursor += event.text.length;
          this.#scheduleFrame();
        }
        return;
    }
  }

  /** Replace the MCP rows the sidebar reports (§6.21). */
  setMcpServers(servers: readonly SidebarService[]): void {
    this.#mcpServers = [...servers];
    if (this.#fullScreen) this.#scheduleFrame();
  }

  /** Replace the LSP / type-checker rows the sidebar reports (§6.21). */
  setLspServers(servers: readonly SidebarService[]): void {
    this.#lspServers = [...servers];
    if (this.#fullScreen) this.#scheduleFrame();
  }

  /**
   * Name the current turn, shown as the sidebar's title.
   *
   * The full title is kept; renderers truncate it to the width they actually
   * have (`truncateMiddle` in the sidebar). Cutting it here by UTF-16 code
   * units could split a grapheme cluster in half and never matched the
   * sidebar's real width anyway (P2).
   */
  setTurnTitle(title: string | undefined): void {
    const trimmed = title?.trim();
    this.#turnTitle = trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
    if (this.#fullScreen) this.#scheduleFrame();
  }

  /** Show the effort selected for the next turn in the composer chrome. */
  setReasoningEffort(effort: string | undefined): void {
    const normalized = effort?.trim();
    this.#selectedReasoningEffort =
      normalized === undefined || normalized.length === 0 ? undefined : normalized;
    this.#invalidateTimelineScrollRange();
    if (this.#fullScreen) this.#scheduleFrame();
  }

  // -------------------------------------------------------------------------
  // Mouse selection, clipboard, and toast
  // -------------------------------------------------------------------------

  /**
   * Handle a decoded mouse event.
   *
   * Left-button press starts a selection, motion extends it, and release ends
   * it: the covered text is copied through the host clipboard bridge and a toast
   * confirms the result. Middle and right clicks are ignored at P0.
   */
  clearSelection(): void {
    if (this.#selection === undefined) return;
    this.#selection = undefined;
    this.#scheduleFrame();
  }

  handleMouseEvent(event: MouseEvent): void {
    if (!this.#fullScreen) return;
    if (event.shift) return;

    if (event.button === 64) {
      this.scrollUp(3);
      return;
    }
    if (event.button === 65) {
      this.scrollDown(3);
      return;
    }
    // SGR motion reports use the `M` terminator even when no button is held.
    // Only a primary-button event can start or continue a scrollbar drag.
    if (event.button !== 0) return;

    const lastRow = this.#lastFrame.length - 1;
    const isScrollbarCol = event.column >= Math.max(0, (this.#plan.showSidebar ? this.#plan.mainWidth : this.#plan.columns) - 1);
    
    if (!event.pressed) {
      this.#isDraggingScrollbar = false;
    }

    if ((isScrollbarCol || this.#isDraggingScrollbar) && lastRow >= 0 && (event.pressed || this.#isDraggingScrollbar)) {
      const maxOffset = this.#timelineMaxScrollOffset ?? 0;
      const viewportRows = Math.max(1, lastRow + 1);
      if (event.pressed) {
        this.#isDraggingScrollbar = true;
        if (maxOffset > 0 && viewportRows > 1) {
          const ratio = Math.min(1, Math.max(0, event.row / (viewportRows - 1)));
          const target = Math.round(maxOffset * (1 - ratio));
          this.#timelineScrollOffset = Math.max(0, Math.min(maxOffset, target));
          this.#scheduleFrame();
        }
        return;
      }
    }

    if (event.pressed && !this.#isDraggingScrollbar) {
      const anchor = { row: event.row, column: event.column };
      if (this.#selection === undefined) {
        this.#selection = { start: anchor, end: anchor, active: true };
      } else {
        this.#selection = { ...this.#selection, end: anchor, active: true };
      }
      this.#markFrameDirty("selection");
      this.#scheduleFrame();
      return;
    }

    const selection = this.#selection;
    this.#selection = undefined;
    this.#markFrameDirty("selection");
    this.#scheduleFrame();
    if (selection === undefined) return;
    const completedSelection: SelectionState = {
      ...selection,
      end: { row: event.row, column: event.column },
      active: false,
    };
    const text = extractSelectionText(this.#lastFrame, completedSelection);
    if (text.trim().length === 0) return;
    void this.#copyToClipboard(text);
  }

  /** Copy `text` through the OS bridge, with OSC 52 for legacy hosts. */
  async #copyToClipboard(text: string): Promise<void> {
    const charCount = text.length;
    const message = (copied: boolean): string => copied
      ? `Copied ${charCount} character${charCount === 1 ? "" : "s"} to clipboard`
      : "Could not copy to clipboard. Use Shift+drag or enable terminal clipboard access";

    const copy = this.#options.host.io.copyToClipboard;
    if (copy !== undefined) {
      let copied = false;
      try {
        copied = await copy(text);
      } catch {
        copied = false;
      }
      if (this.#restored) return;
      this.#showToast(
        makeToast(copied ? "success" : "warning", message(copied), this.#options.host.now()),
      );
      return;
    }

    this.#options.host.io.stdout(osc52Copy(text));
    this.#showToast(
      makeToast("info", "Clipboard request sent; if it fails, use Shift+drag", this.#options.host.now()),
    );
  }

  /** Show or replace the current toast and arm its expiry timer. */
  #showToast(toast: ToastState): void {
    this.#toast = toast;
    if (this.#toastTimer !== undefined) clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => {
      this.#toast = undefined;
      this.#toastTimer = undefined;
      this.#scheduleFrame();
    }, TOAST_DURATION_MS);
    (this.#toastTimer as unknown as { unref?: () => void }).unref?.();
    this.#scheduleFrame();
  }

  /** The current selection state, for testing. */
  get selection(): SelectionState | undefined {
    return this.#selection;
  }

  /** The current toast, for testing. */
  get toast(): ToastState | undefined {
    return this.#toast;
  }
  /**
   * §7.1 steps 1–6: paint before doing any work.
   *
   * The alternate screen is deliberately *not* entered. Plain interactive mode keeps
   * native scrollback, which is what makes the fallback useful rather than a
   * degraded imitation of the full renderer.
   */
  async open(options: { trustLabel?: string; sessionId?: string } = {}): Promise<void> {
    if (this.#fullScreen) {
      if (canUseNativeOpenTui(this.theme, this.#options.host.io.isTty)) {
        try {
          const { OpenTuiView } = await import("./opentui-view.ts");
          const view = await OpenTuiView.create({
            theme: this.theme,
            mouse: this.#options.uiMouse !== false,
          });
          this.#openTui = view;
          this.#disposeOpenTuiResize = view.onResize(() => {
            this.#replan();
            this.#scheduleFrame({ clearScreen: true });
          });
          this.#scheduleFrame({ immediate: true });
          return;
        } catch {
          // ?19.3: the renderer is optional at runtime. A missing native binding or
          // unsupported host must fall back to the ANSI fullscreen path, not abort.
          this.#openTui = undefined;
        }
      }
      this.#options.host.io.stdout(enterSequence({ mouse: this.#options.uiMouse !== false }));
      this.#scheduleFrame({ immediate: true });
      return;
    }

    const writer = this.#options.writer;
    writer.text("");
    writer.text(`Capybara Code ${this.#options.version}`);
    writer.text("Independent coding agent for GPT-5.6");
    writer.text("");
    writer.text(`Workspace: ${this.#options.workspacePath}`);
    if (options.trustLabel !== undefined) writer.text(`Trust:     ${options.trustLabel}`);
    if (options.sessionId !== undefined) writer.text(`Session:   ${options.sessionId}`);
    writer.text("");
  }

  /**
   * Paint a provider delta immediately.
   *
   * The durable `assistant.commentary`, `assistant.reasoning`, and
   * `assistant.reasoning_summary`/`assistant.final` events arrive after sampling. Keeping
   * the live text separate by phase makes the interaction feel live without mixing
   * a candidate final into the durable final-answer lane before its response shape
   * is known, or printing a pre-tool explanation twice.
   */
  stream(
    text: string,
    phase: AssistantStreamPhase = "candidate_final",
    options: {
      readonly provisional?: boolean;
      readonly agentId?: string;
      readonly turnId?: string;
      readonly itemId?: string;
      readonly correlationId?: string;
    } = {},
  ): void {
    const agentId = options.agentId ?? "root";
    if (agentId !== "root") return;
    // Plain scrollback cannot retract leaked text. Leave preview/hidden provider
    // summaries for their durable renderer, which applies the same policy as the
    // fullscreen projection.
    if (
      !this.#fullScreen &&
      (phase === "reasoning" || phase === "reasoning_summary") &&
      this.#thinkingVisibility !== "full"
    ) {
      return;
    }
    // Older call sites marked a final-shaped delta as provisional. Treat it as
    // a candidate answer so it cannot render in the durable final-answer lane.
    const streamPhase =
      phase === "final" && options.provisional === true ? "candidate_final" : phase;
    const span = this.#liveSpans.append({
      text,
      phase: streamPhase,
      agentId,
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(options.itemId !== undefined ? { itemId: options.itemId } : {}),
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
      ...(options.provisional !== undefined ? { provisional: options.provisional } : {}),
      nowMs: this.#options.host.now(),
    });
    if (span === undefined) return;

    if (this.#fullScreen) {
      this.#markFrameDirty("live", "timeline");
      this.#scheduleFrame();
      return;
    }
    if (!this.#streamingOpen) {
      this.#eraseComposer();
      // Plain scrollback keeps the assistant text at the exact stream position.
      // Do not open a second product-labelled chat block here; the durable timeline
      // event will still be suppressed once this streamed text has been shown.
      this.#streamingOpen = true;
      this.#streamingPlainPhase = streamPhase;
      this.#writePlainStreamHeader(streamPhase);
    } else if (this.#streamingPlainPhase !== streamPhase) {
      // Keep commentary, reasoning, and the final answer as separate assistant
      // blocks in append-only mode, just like the full-screen timeline.
      // A phase change gets a line break, not another standalone chat header.
      this.#options.host.io.stdout("\r\n");
      this.#streamingPlainPhase = streamPhase;
      this.#writePlainStreamHeader(streamPhase);
    }
    this.#options.host.io.stdout(text);
  }

  /**
   * The append-only renderer cannot redraw a timeline block after its durable
   * event lands, so label every semantic stream phase at its first visible chunk.
   */
  #writePlainStreamHeader(phase: AssistantStreamPhase): void {
    // Candidate-final bytes are already the response body. Do not add a
    // provisional phase label above them; only provider progress and reasoning
    // summaries receive visible stream headers.
    if (phase === "candidate_final" || phase === "final") {
      this.#lastLiveLabel = "";
      return;
    }
    const label =
      phase === "reasoning"
        ? "Thinking..."
        : phase === "reasoning_summary"
          ? "Reasoning summary..." : "Working...";
    if (this.#lastLiveLabel === label) return;
    this.#lastLiveLabel = label;
    this.#options.host.io.stdout(`  ${label}\r\n`);
  }

  /** Paint sanitized runtime process chunks while a tool is still running. */
  processOutput(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const record = payload as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    if (text.length === 0) return;
    const jobId = typeof record.jobId === "string" ? record.jobId : "process";
    const stream = record.stream === "stderr" ? "stderr" : "stdout";
    const prefix = `[${jobId} ${stream}] `;
    const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) return;
    if (this.#fullScreen) {
      for (const line of lines.slice(-3)) this.#pushNotice(`${prefix}${line}`);
      this.#scheduleFrame();
      return;
    }
    const composerWasOpen = this.#streamingOpen === false;
    this.#eraseComposer();
    this.#options.writer.text(lines.map((line) => `${prefix}${line}`).join("\n"));
    if (composerWasOpen) this.drawComposer(this.#composerState, this.#completion);
  }

  /** Finish the live line without waiting for journal persistence. */
  finishStream(): void {
    if (this.#fullScreen) {
      if (this.#liveSpans.hasOpenRoot(this.#latestModel?.currentTurnId)) this.#scheduleFrame();
      return;
    }
    if (!this.#streamingOpen) return;
    this.#options.host.io.stdout("\r\n");
    this.#streamingOpen = false;
    this.#streamingPlainPhase = undefined;
  }

  /** Close every provisional span owned by a turn on terminal outcomes. */
  closeStreams(
    outcome: Exclude<LiveSpanOutcome, "landed">,
    turnId?: string,
  ): void {
    this.finishStream();
    this.#liveSpans.closeTurn(turnId, outcome, this.#options.host.now());
    if (this.#fullScreen) this.#scheduleFrame();
  }

  /** Drop a stale partial stream when the user starts a new turn. */
  resetStream(): void {
    this.#timelineScrollOffset = 0;
    this.#timelineMaxScrollOffset = undefined;
    this.#liveSpans.clear();
    this.#streamingItems.clear();
    this.#plainReconciledDurable = undefined;
    this.#streamingOpen = false;
    this.#streamingPlainPhase = undefined;
    if (this.#fullScreen) this.#scheduleFrame();
  }
  /**
   * Clear presentation cursors before another durable session is shown.
   *
   * A `/resume` switch keeps the same terminal and reader alive, so the append-only
   * timeline cursor and fullscreen frame cache must not be allowed to hide the
   * resumed session's history behind the previous session's state.
   */
  resetSession(model: SessionViewModel): void {
    this.#cancelScheduledFrame();
    // A session replacement can race a focused Plan picker (for example, a
    // resume request arriving while the reader is awaiting its decision). Do not
    // leave the old promise or key ownership attached to the new session.
    if (this.#planApproval !== undefined) {
      const pending = this.#planApproval;
      this.#planApproval = undefined;
      pending.resolve(-1);
    }
    if (this.#userAsk !== undefined) {
      const pending = this.#userAsk;
      this.#userAsk = undefined;
      pending.resolve(-1);
    }
    // Timeline ids restart at the same sequence-derived values in every session.
    // A projection is session-scoped: never reuse same-id/same-revision groups
    // from the previous session.
    this.#timelineProjection = this.#fullScreen ? new ProjectedTimeline() : undefined;
    this.#renderedItems = 0;
    this.#plainTimelineHeadId = undefined;
    this.#plainRawTimelineLength = 0;
    this.#plainRawTimelineTailId = undefined;
    this.#timelineScrollOffset = 0;
    this.#timelineMaxScrollOffset = undefined;
    this.#renderedSnapshots?.clear();
    this.#renderedSources?.clear();
    this.#historyLoaderGeneration += 1;
    this.#historicalTimeline = [];
    this.#historicalRevision += 1;
    this.#historicalMergeCache = undefined;
    this.#loadEarlierHistory = undefined;
    this.#loadingEarlierHistory = false;
    this.#residentModel = model;
    this.#latestModel = model;
    this.#lastLiveLabel = "";
    this.#turnTitle = undefined;
    this.#selectedReasoningEffort = model.reasoningEffort;
    this.#notices = [];
    this.#lastNoticeText = undefined;
    this.#lastNoticeCount = 0;
    this.#composerState = { text: "", cursor: 0 };
    this.#completion = undefined;
    this.resetStream();
    if (!this.#fullScreen) {
      this.#eraseComposer();
      this.#options.host.io.stdout("\r\n");
    }
  }

  /**
   * Reconcile a durable assistant event before its model is flushed.
   *
   * Full-screen needs this because it bypasses append-only `#emit`. Plain mode keeps
   * one suppression marker for the projected mutation (which may merge consecutive
   * commentary under an older id); direct `flush()` callers still use `#emit` as a
   * compatibility fallback.
   */
  acceptDurableAssistantEvent(event: CbcEvent): void {
    if (event.agentId !== undefined && event.agentId !== "root") return;
    if (
      event.kind !== "assistant.commentary" &&
      event.kind !== "assistant.reasoning" &&
      event.kind !== "assistant.reasoning_summary" &&
      event.kind !== "assistant.final"
    ) {
      return;
    }

    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const phase: AssistantStreamPhase =
      event.kind === "assistant.final"
        ? "final"
        : event.kind === "assistant.reasoning"
          ? "reasoning"
          : event.kind === "assistant.reasoning_summary"
            ? "reasoning_summary"
            : "progress";
    const text =
      event.kind === "assistant.final" && typeof payload.answer === "string" && payload.answer.length > 0
        ? payload.answer
        : typeof payload.text === "string"
          ? payload.text
          : "";
    if (text.length === 0) return;

    const reconciled = this.#liveSpans.reconcile(
      {
        text,
        phase,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        agentId: event.agentId ?? "root",
        ...(typeof payload.itemId === "string" ? { itemId: payload.itemId } : {}),
        ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
      },
      this.#options.host.now(),
    );
    // Identity tells us which live item this durable event settles. Its text
    // must also match before plain scrollback elides the durable block: a
    // completed output item may recover deltas that were lost in transit.
    if (!this.#fullScreen && reconciled !== undefined && reconciled.text === text) {
      this.#plainReconciledDurable = {
        eventId: event.id,
        text,
        phase,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      };
    }
  }

  /**
   * Emit timeline items and result updates in journal order.
   *
   * Append-only output cannot move a response back above later text, so every
   * mutation is handled at the flush that follows its event: a tool call is printed
   * first, then its completion/progress line is appended immediately beneath it.
   * Task cards are anchors rather than deferred bundles; delegated calls are emitted
   * from their nested event list at the same moment they become observable.
   */
  flush(model: SessionViewModel): void {
    const previousModel = this.#residentModel;
    if (
      previousModel !== undefined &&
      (previousModel.timeline.length !== model.timeline.length ||
        previousModel.lastSequence !== model.lastSequence)
    ) {
      this.#timelineMaxScrollOffset = undefined;
    }
    this.#residentModel = model;
    this.#latestModel = this.#withHistoricalTimeline(model);
    this.#selectedReasoningEffort = model.reasoningEffort;
    this.#syncLiveAnimation(model);
    this.#replan();
    this.#markFrameDirty("layout", "timeline", "live", "sidebar", "status");

    // Full-screen rendering replaces the whole viewport. The projection, deep
    // comparison, cloning, and source maps below exist solely to reconcile mutable
    // records with append-only terminal scrollback. Keeping that path out of a
    // full-screen event callback makes ingest constant-time and leaves the expensive
    // frame work behind the scheduler boundary.
    if (this.#fullScreen) {
      this.#scheduleFrame();
      return;
    }

    const renderedSnapshots = this.#renderedSnapshots;
    const renderedSources = this.#renderedSources;
    if (renderedSnapshots === undefined || renderedSources === undefined) {
      throw new Error("plain timeline reconciliation state is unavailable");
    }

    const items = projectTimeline(model.timeline, this.#timelineOptions(model));
    const residentHeadId = items[0]?.id;
    const rawTailId = model.timeline.at(-1)?.id;
    const residentWindowShifted =
      (this.#plainTimelineHeadId !== undefined && residentHeadId !== this.#plainTimelineHeadId) ||
      (model.timeline.length <= this.#plainRawTimelineLength &&
        this.#plainRawTimelineTailId !== undefined &&
        rawTailId !== this.#plainRawTimelineTailId);
    if (residentWindowShifted) {
      const residentIds = new Set(items.map((item) => item.id));
      for (const id of renderedSnapshots.keys()) {
        if (!residentIds.has(id)) renderedSnapshots.delete(id);
      }
      for (const id of renderedSources.keys()) {
        if (!residentIds.has(id)) renderedSources.delete(id);
      }
    }
    this.#plainTimelineHeadId = residentHeadId;
    this.#plainRawTimelineLength = model.timeline.length;
    this.#plainRawTimelineTailId = rawTailId;

    // A task owns its child calls in the view model, but the terminal is a journal:
    // flatten both levels for this append-only pass and sort by event sequence. This
    // matters when a restored snapshot contains a child result alongside a later
    // parent message; walking the nested array first would put the child too late.
    for (const record of chronologicalPlainRecords(items)) {
      if (record.childEvent !== undefined && record.parentTask !== undefined) {
        // Subagent tool calls are rendered inside the parent TaskCard's tree,
        // rather than emitted as standalone main-timeline tool lines.
        continue;
      }

      const item = record.item;
      const source = renderedSources.get(item.id);
      const previous = renderedSnapshots.get(item.id);
      if (previous === undefined) {
        if (!this.#consumePlainReconciled(item)) this.#emit(item, model);
      } else if (source !== item && !timelineItemEqual(previous, item)) {
        if (!this.#consumePlainReconciled(item)) this.#emitUpdate(item, previous, model);
      }
    }

    // Store snapshots and source references only after every record has been
    // compared. A child record therefore sees the prior task state even when its
    // anchor is also part of this flush.
    for (const item of items) {
      const source = renderedSources.get(item.id);
      const previous = renderedSnapshots.get(item.id);
      if (
        previous === undefined ||
        (source !== item && !timelineItemEqual(previous, item))
      ) {
        renderedSnapshots.set(item.id, cloneTimelineItemForUi(item));
      }
      renderedSources.set(item.id, item);
    }

    this.#renderedItems = items.length;
    // A reducer dedupe can make a durable event produce no projected mutation.
    // Never let that event's suppression marker leak into a later flush.
    this.#plainReconciledDurable = undefined;
  }

  /**
   * Flush is idempotent, so draining at the end of a turn simply catches up with
   * the same chronological cursor. It no longer moves a task card away from the
   * point where the task was created.
   */
  drain(model: SessionViewModel): void {
    this.flush(model);
  }

  #consumePlainReconciled(item: TimelineItem): boolean {
    const pending = this.#plainReconciledDurable;
    if (pending === undefined) return false;
    const itemTurnId =
      "turnId" in item && typeof item.turnId === "string" ? item.turnId : undefined;
    if (
      pending.turnId !== undefined &&
      itemTurnId !== undefined &&
      pending.turnId !== itemTurnId
    ) {
      return false;
    }

    // The reducer keeps the durable event id as the timeline item id. Using it
    // avoids suppressing a later repeated sentence merely because its text and
    // phase happen to match a previously streamed item.
    if (item.id !== pending.eventId) return false;
    this.#plainReconciledDurable = undefined;
    return true;
  }

  #emit(item: TimelineItem, model: SessionViewModel): void {
    const durableText =
      item.type === "commentary"
        ? item.text
        : item.type === "final"
          ? item.answer ?? item.text
          : undefined;
    const reconciled =
      item.type === "commentary"
        ? this.#liveSpans.reconcile(
            {
              text: item.text,
              phase: item.variant,
              ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
              ...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
              ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
              ...(item.correlationId !== undefined ? { correlationId: item.correlationId } : {}),
            },
            this.#options.host.now(),
          )
        : item.type === "final"
          ? this.#liveSpans.reconcile(
              {
                text: item.answer ?? item.text,
                phase: "final",
                ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
                ...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
                ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
                ...(item.correlationId !== undefined ? { correlationId: item.correlationId } : {}),
              },
              this.#options.host.now(),
            )
          : undefined;
    if (
      !this.#fullScreen &&
      reconciled !== undefined &&
      durableText !== undefined &&
      reconciled.text === durableText
    ) {
      return;
    }
    const lines = renderTimelineItem(item, this.#context, {
      ...this.#timelineOptions(model),
      ...(item.type === "task" ? { hideSubagentEvents: true, maxToolNodes: 3 } : {}),
    });
    if (lines.length === 0 || this.#fullScreen) return;
    this.#writePlain(lines);
  }

  #emitChild(item: TimelineItem, model: SessionViewModel): void {
    if (item.type !== "tool") return;
    this.#writePlain(renderTimelineItem(item, this.#context, this.#timelineOptions(model)));
  }

  #emitToolUpdate(item: TimelineItem, model: SessionViewModel): void {
    if (item.type !== "tool") return;
    const rendered = renderTimelineItem(item, this.#context, this.#timelineOptions(model));
    const continuation = rendered.length > 1
      ? rendered.slice(1)
      : [line("tool", [
          segment("  ", { fg: "border.warm" }),
          segment("response: ", { fg: "fg.muted", bold: true }),
          segment(item.status, { fg: "fg.primary" }),
        ])];
    this.#writePlain(continuation);
  }

  #emitUpdate(
    item: TimelineItem,
    previous: TimelineItem,
    model: SessionViewModel,
    options: { readonly skipTaskState?: boolean } = {},
  ): void {
    if (this.#fullScreen) return;

    if (item.type === "tool") {
      this.#emitToolUpdate(item, model);
      return;
    }

    if (item.type === "task") {
      const previousTask = previous.type === "task" ? previous : undefined;
      const stateChanged =
        previousTask !== undefined &&
        (previousTask.state !== item.state ||
          previousTask.summary !== item.summary ||
          previousTask.progress !== item.progress);
      if (stateChanged && options.skipTaskState !== true) {
        this.#writePlain(
          renderTimelineItem(item, this.#context, {
            ...this.#timelineOptions(model),
            hideSubagentEvents: true,
            maxToolNodes: 3,
          }),
        );
      }
      return;
    }

    // Plan, approval, job, and other mutable blocks are uncommon in append-only
    // mode; when one changes, append its current block at the exact update point.
    this.#writePlain(
      renderTimelineItem(item, this.#context, this.#timelineOptions(model)),
    );
  }
  #writePlain(lines: readonly StyledLine[]): void {
    if (lines.length === 0 || this.#fullScreen) return;
    this.#eraseComposer();
    this.#options.writer.write(lines);
    this.#options.writer.text("");
  }

  /**
   * §6.12's live state, as a one-shot line.
   *
   * Repeats are suppressed. Without a full-screen renderer the line cannot be
   * rewritten in place, so re-printing an unchanged label would turn the state
   * indicator into noise scrolling past the actual work.
   */
  live(model: SessionViewModel): void {
    this.#residentModel = model;
    this.#latestModel = this.#withHistoricalTimeline(model);
    this.#syncLiveAnimation(model);
    this.#markFrameDirty("live", "status");
    const live = visibleLiveState(model);
    const rawLabel = live.kind === "idle" ? "" : liveStateLabel(live);
    // Hidden means the provider's reasoning summary itself is not disclosed;
    // retain a neutral progress indicator so a long request never looks stuck.
    const label =
      this.#thinkingVisibility === "hidden" &&
      (rawLabel === "Thinking..." || rawLabel === "Reasoning summary...")
        ? "Working..."
        : rawLabel;
    if ((label.length > 0) !== (this.#lastLiveLabel.length > 0)) {
      this.#invalidateTimelineScrollRange();
    }
    if (label === this.#lastLiveLabel) return;
    this.#lastLiveLabel = label;
    if (label.length === 0) {
      if (this.#fullScreen) this.#scheduleFrame();
      return;
    }
    if (this.#fullScreen) this.#scheduleFrame();
    else {
      this.#eraseComposer();
      // A live phase is UI output, not a diagnostic. In plain mode diagnostics
      // go to stderr, which some terminal hosts do not show in the transcript.
      // `text()` keeps JSONL safe by routing non-event prose to stderr.
      this.#options.writer.text(`  ${label}`);
    }
  }

  /** §6.13's status bar, printed after a turn rather than pinned. */
  status(model: SessionViewModel): void {
   this.#residentModel = model;
   this.#latestModel = this.#withHistoricalTimeline(model);
   this.#replan();
   this.#markFrameDirty("status");
   const plan = this.#plan;
   const lines = renderStatusBar(
     statusFromViewModel(model, {
       ...(this.#options.provider !== undefined ? { provider: this.#options.provider } : {}),
       ...(this.#options.git !== undefined ? { git: this.#options.git } : {}),
       workspacePath: this.#options.workspacePath,
       showCost: plan.showCost,
       ...(this.#options.permissionsSummary !== undefined
          ? { permissionDetail: this.#options.permissionsSummary }
          : {}),
     }),
      blockContext(this.#options.decision.capabilities, plan.columns),
      plan,
    );
     if (this.#fullScreen) this.#scheduleFrame();
     else {
       this.#eraseComposer();
       this.#options.writer.write(lines);
       if (model.modeState.selected === "plan") {
         this.#options.writer.write(
           renderPlanControls(model, blockContext(this.#options.decision.capabilities, plan.columns)),
         );
       }
     }
  }

  /**
   * §6.21's context sidebar, as a panel.
   *
   * Returns nothing when the width has hidden the sidebar, so `Ctrl+B` and a
   * resize have the same effect here as they would in the full-screen view.
   */
   sidebar(model: SessionViewModel): void {
     this.#residentModel = model;
     this.#latestModel = this.#withHistoricalTimeline(model);
     this.#replan();
     this.#markFrameDirty("sidebar");
    if (!this.#plan.showSidebar) {
      if (this.#fullScreen) this.#scheduleFrame();
      return;
    }

    const lines = renderRightSidebar(
      sidebarFromViewModel(model, {
        ...(this.#turnTitle !== undefined ? { title: this.#turnTitle } : {}),
        ...(this.#mcpServers.length > 0 ? { mcpServers: this.#mcpServers } : {}),
        ...(this.#lspServers.length > 0 ? { lspServers: this.#lspServers } : {}),
        ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
        ...(this.#credentialSource !== undefined ? { credentialSource: this.#credentialSource } : {}),
        showCost: this.#plan.showCost,
        notices: model.notices.map((notice) => notice.text),
      }),
      blockContext(this.#options.decision.capabilities, this.#plan.sidebarWidth),
      { compact: this.#plan.sidebarMode === "compact" },
    );
    if (lines.length === 0) return;
    if (this.#fullScreen) this.#scheduleFrame();
    else {
      this.#eraseComposer();
      this.#options.writer.write(lines);
    }
  }

  /**
   * Compose the full two-column screen (§6.2, §6.21).
   *
   * Used by the full-screen renderer and by golden tests. Kept on `InteractiveUi`
   * so both rungs of §19.3's ladder resolve the layout the same way rather than
   * each deciding for itself what 72% means.
   */
  compose(model: SessionViewModel, composerText = ""): ReturnType<typeof composeScreen> {
    return composeScreen({
      model,
      composer: { text: composerText, cursor: composerText.length },
      capabilities: this.capabilities,
      liveOptions: { frame: this.#liveFrame },
      ...(this.#sidebarVisible !== undefined ? { sidebarVisible: this.#sidebarVisible } : {}),
      ...(this.#options.uiShowCost !== undefined ? { showCost: this.#options.uiShowCost } : {}),
      ...(this.#options.uiStatusDensity !== undefined
        ? { statusDensity: this.#options.uiStatusDensity }
        : {}),
      ...(this.#turnTitle !== undefined ? { sidebarTitle: this.#turnTitle } : {}),
      ...(this.#mcpServers.length > 0 ? { mcpServers: this.#mcpServers } : {}),
      ...(this.#lspServers.length > 0 ? { lspServers: this.#lspServers } : {}),
      ...(this.#options.provider !== undefined ? { provider: this.#options.provider } : {}),
      ...(this.#options.git !== undefined ? { git: this.#options.git } : {}),
      workspacePath: this.#options.workspacePath,
      timelineOptions: {
        ...this.#timelineOptions(model),
      },
    });
  }

  /** Render arbitrary lines, e.g. an overlay body or a slash command's output. */
  show(lines: readonly StyledLine[]): void {
    if (this.#fullScreen) {
      for (const styled of lines) this.#pushNotice(styled.segments.map((part) => part.text).join(""));
      this.#scheduleFrame();
      return;
    }
    this.#eraseComposer();
    this.#options.writer.write(lines);
  }

  text(value: string): void {
    if (this.#fullScreen) {
      this.#pushNotice(value);
      this.#scheduleFrame();
      return;
    }
    this.#eraseComposer();
    this.#options.writer.text(value);
  }

  /**
   * Yield terminal ownership while a native prompt draws, then repaint the TUI.
   *
   * OpenTUI tracks its own back buffer and cannot observe escape sequences written
   * by another prompt. Letting both renderers draw concurrently leaves cleared
   * cells marked as unchanged, which is the large stepped block seen after the
   * model picker closes.
   */
  async withExternalPrompt<T>(prompt: () => Promise<T>): Promise<T> {
    if (!this.#fullScreen) return await prompt();

    const view = this.#openTui;
    if (view !== undefined) {
      view.suspend();
    } else {
      this.#options.host.io.stdout(restoreSequence());
    }

    try {
      return await prompt();
    } finally {
      if (view !== undefined) {
        view.resume();
      } else {
        this.#options.host.io.stdout(enterSequence({ mouse: this.#options.uiMouse !== false }));
      }
      this.#scheduleFrame({ immediate: true });
    }
  }

  /** Read the next prompt. Returns `undefined` at end of input. */
  async readPrompt(): Promise<string | undefined> {
    try {
      const line = await this.#options.host.io.prompt("> ");
      return line;
    } catch {
      // A `Ctrl+C` at the composer is an exit request, not an error (§6.15).
      return undefined;
    }
  }

  /**
   * Draw the composer and its §6.14 completion popup in place.
   *
   * Append-only scrollback cannot rewrite a line, so the previously drawn block is
   * erased with a cursor-up-and-clear sequence before the new one is written. That
   * is the one place this mode needs an escape sequence beyond colour: without it,
   * every keystroke would leave a copy of the prompt behind and typing `/mo` would
   * push three popups through the scrollback.
   */
  drawComposer(
    state: {
      text: string;
      cursor: number;
      metrics?: { readonly revision: number; readonly graphemes: readonly string[]; readonly charOffsets: readonly number[] };
    },
    completion?: CompletionState,
  ): void {
    this.#invalidateTimelineScrollRange();
    this.#composerState = { ...state };
    this.#completion = completion;
    this.#markFrameDirty("composer", "completion");
    if (this.#fullScreen) {
      // Keep stdin callbacks cheap. Rendering a complete frame synchronously for
      // every committed key can block provider/tool progress on terminals whose
      // stdout is backpressured, especially while a turn is active. The normal
      // frame timer still paints the draft and keeps the IME caret visible. A
       // Completion state is already updated synchronously in the reducer. Let the
       // normal frame boundary paint the popup so rapid typing remains coalesced.
       this.#scheduleFrame();
      return;
    }
    const context = blockContext(this.#options.decision.capabilities, this.#plan.columns);
    const lines: StyledLine[] = [
      ...renderComposer(
        { text: state.text, cursor: state.cursor },
        context,
        this.#plan,
      ),
    ];
    if (completion !== undefined) {
      lines.push(...renderCompletionPopup(completion, context, completionPopupOptions(completion)));
    }

    this.#eraseComposer();
    this.#composerLines = lines.length;

    const text =
      this.theme.depth === "none"
        ? renderPlain(lines)
        : renderAnsi(lines, {
            theme: this.theme,
            capabilities: this.#options.decision.capabilities,
            columns: this.#plan.columns,
          });
    // CRLF keeps the terminal cursor at column zero after a wide Hangul glyph.
    // Without it, the next cursor-up erase starts at the previous text width and
    // leaves a one-character ghost behind on every redraw.
    this.#options.host.io.stdout(`${text}\r\n`);
  }

  /**
   * Erase the drawn composer block, so a timeline block lands above it.
   *
   * Called before anything else writes, which keeps the composer visually pinned to
   * the bottom without a full-screen renderer.
   */
  eraseComposer(): void {
    if (this.#fullScreen) {
      this.#cancelScheduledFrame();
      this.#composerState = { text: "", cursor: 0 };
      this.#completion = undefined;
      this.#scheduleFrame();
      return;
    }
    this.#eraseComposer();
  }

  #eraseComposer(): void {
    if (this.#fullScreen) return;
    if (this.#composerLines === 0) return;
    // Up one line per drawn row, clearing each as it goes.
    this.#options.host.io.stdout(`\r\u001B[${this.#composerLines}A\u001B[0J`);
    this.#composerLines = 0;
  }

  diagnostic(text: string): void {
    const normalized = text.trim();
    if (normalized.length === 0) return;
    this.#pushNotice(normalized);
    this.#scheduleFrame();
  }

  /** Print a one-line notice above the composer, e.g. an armed-cancel hint. */
  notice(text: string): void {
    const normalized = text.trim();
    if (normalized.length === 0) return;
    if (this.#fullScreen) {
      this.#pushNotice(normalized);
      this.#scheduleFrame();
      return;
    }
    this.#eraseComposer();
    this.#options.writer.diagnostic(`  ${normalized}`);
  }

  /**
   * Restore terminal state (AC-40).
   *
   * Idempotent, and safe to call from a crash handler: the sequence is a constant,
   * so nothing has to be computed while unwinding.
   */
  restore(): void {
    this.#cancelScheduledFrame();
    // Resolve a focused Plan picker before releasing terminal ownership. A
    // pending readPrompt must not remain blocked if shutdown happens mid-choice.
    if (this.#planApproval !== undefined) {
      const pending = this.#planApproval;
      this.#planApproval = undefined;
      pending.resolve(-1);
    }
    if (this.#userAsk !== undefined) {
      const pending = this.#userAsk;
      this.#userAsk = undefined;
      pending.resolve(-1);
    }
    this.#stopLiveAnimation();
    if (this.#toastTimer !== undefined) {
      clearTimeout(this.#toastTimer);
      this.#toastTimer = undefined;
      this.#toast = undefined;
    }
    this.#selection = undefined;
    if (this.#restored) return;
    this.#restored = true;
    if (this.#perf.enabled) {
      this.#options.host.io.stderr(`[CBC_TUI_PERF] ${JSON.stringify(this.#perf.snapshot())}\n`);
    }
    if (this.#openTui !== undefined) {
      const view = this.#openTui;
      this.#openTui = undefined;
      this.#disposeOpenTuiResize?.();
      this.#disposeOpenTuiResize = undefined;
      view.destroy();
    } else if (this.#options.decision.mode === "opentui") {
      this.#options.host.io.stdout(restoreSequence());
    } else {
      // Plain mode never hid the cursor or switched screens; resetting attributes
      // still matters because a tool's output may have left SGR state behind.
      this.#options.host.io.stdout("\u001B[0m");
    }
  }

  #markFrameDirty(...regions: readonly FrameRegion[]): void {
    for (const region of regions) {
      this.#frameRevisions = {
        ...this.#frameRevisions,
        [region]: this.#frameRevisions[region] + 1,
      };
      this.#dirtyRegions.add(region);
    }
  }

  #clearFrameDirty(): void {
    this.#dirtyRegions.clear();
  }

  /**
   * Coalesce every full-screen mutation behind one dirty frame boundary.
   *
   * Event ingestion only updates semantic state and marks the frame dirty. Initial
   * ownership transitions may request an immediate paint; provider, tool, spinner,
   * and input bursts share the normal 16/33 ms timer.
   */
  #scheduleFrame(
    options: { readonly immediate?: boolean; readonly clearScreen?: boolean } = {},
  ): void {
    if (!this.#fullScreen) return;
    if (this.#dirtyRegions.size === 0) {
      this.#markFrameDirty(
        "layout",
        "timeline",
        "live",
        "sidebar",
        "composer",
        "completion",
        "status",
        "overlay",
        "selection",
      );
    }
    this.#frameDirty = true;
    this.#clearScreenOnNextFrame ||= options.clearScreen === true;

    if (options.immediate === true || process.stdout.isTTY !== true) {
      this.#paintScheduledFrame();
      return;
    }
    if (this.#frameTimer !== undefined) {
      this.#perf.recordDroppedFrame();
      return;
    }
    this.#frameTimer = setTimeout(() => {
      this.#frameTimer = undefined;
      this.#paintScheduledFrame();
    }, renderIntervalMs(this.capabilities));
    (this.#frameTimer as unknown as { unref?: () => void }).unref?.();
  }

  #paintScheduledFrame(): void {
    if (!this.#frameDirty) return;
    const clearScreen = this.#clearScreenOnNextFrame;
    this.#frameDirty = false;
    this.#clearScreenOnNextFrame = false;
    this.#renderFrame(clearScreen);
  }

  #cancelScheduledFrame(): void {
    if (this.#frameTimer !== undefined) {
      clearTimeout(this.#frameTimer);
      this.#frameTimer = undefined;
    }
    this.#frameDirty = false;
    this.#clearScreenOnNextFrame = false;
  }

  /** Keep a live turn visibly moving without redrawing idle frames. */
  #syncLiveAnimation(model: SessionViewModel): void {
    const live = visibleLiveState(model);
    const spinning =
      live.kind === "working" ||
      live.kind === "waiting_for_task" ||
      live.kind === "running_tests";
    if (
      !this.#fullScreen ||
      !spinning ||
      process.stdout.isTTY !== true ||
      this.capabilities.reducedMotion
    ) {
      this.#stopLiveAnimation();
      return;
    }
    if (this.#liveAnimationTimer !== undefined) return;

    this.#liveFrame = 0;
    this.#liveAnimationTimer = setInterval(() => {
      const live =
        this.#latestModel === undefined ? undefined : visibleLiveState(this.#latestModel);
      const stillSpinning =
        live?.kind === "working" ||
        live?.kind === "waiting_for_task" ||
        live?.kind === "running_tests";
      if (!this.#fullScreen || !stillSpinning) {
        this.#stopLiveAnimation();
        return;
      }
      this.#liveFrame += 1;
      this.#scheduleFrame();
    }, FULL_SCREEN_SPINNER_INTERVAL_MS);
    // The animation is presentation-only and must never keep a headless test or
    // shutdown path alive if the caller forgets to restore immediately.
    (this.#liveAnimationTimer as unknown as { unref?: () => void }).unref?.();
  }

  #stopLiveAnimation(): void {
    if (this.#liveAnimationTimer === undefined) return;
    clearInterval(this.#liveAnimationTimer);
    this.#liveAnimationTimer = undefined;
  }

  #pushNotice(value: string): void {
    const text = value.trim();
    if (text.length === 0) return;
    this.#invalidateTimelineScrollRange();
    this.#markFrameDirty("overlay");
    if (text === this.#lastNoticeText && this.#notices.length > 0) {
      this.#lastNoticeCount += 1;
      this.#notices[this.#notices.length - 1] = `${text} [x${this.#lastNoticeCount}]`;
      return;
    }
    this.#lastNoticeText = text;
    this.#lastNoticeCount = 1;
    this.#notices.push(text);
    if (this.#notices.length > 3) this.#notices.splice(0, this.#notices.length - 3);
  }

  #streamingProjectionViews(
    baseSequence: number,
    views: readonly LiveSpanView[],
  ): {
    readonly items: readonly TimelineItem[];
    readonly views: readonly {
      readonly id: string;
      readonly item: TimelineItem;
      readonly revision: number;
      readonly sourceView: LiveSpanView["sourceView"];
    }[];
  } {
    const phaseCounts = new Map<string, number>();
    const items: TimelineItem[] = [];
    const projectionViews: {
      id: string;
      item: TimelineItem;
      revision: number;
      sourceView: LiveSpanView["sourceView"];
    }[] = [];

    let sequence = baseSequence;
    for (const view of views) {
      const displayPhase = view.key.phase;
      const priorCount = phaseCounts.get(displayPhase) ?? 0;
      phaseCounts.set(displayPhase, priorCount + 1);
      const baseId =
        displayPhase === "progress"
          ? "streaming-progress"
          : displayPhase === "reasoning"
            ? "streaming-thinking"
            : displayPhase === "reasoning_summary"
              ? "streaming-reasoning"
            : displayPhase === "candidate_final"
              ? "streaming-candidate-final"
              : view.key.itemId === "final" || view.key.itemId === ""
                ? "streaming-answer"
                : view.key.itemId;
      const id = priorCount === 0 ? baseId : `${baseId}-${view.key.itemId}`;
      const nextSequence = ++sequence;
      const cached = this.#streamingItems.get(id);
      const item =
        cached?.revision === view.revision && cached.item.sequence === nextSequence
          ? cached.item
          : (displayPhase === "final"
              ? {
                  type: "final" as const,
                  id,
                  sequence: nextSequence,
                  text: view.fullText(),
                }
              : {
                  type: "commentary" as const,
                  id,
                  sequence: nextSequence,
                  variant: displayPhase === "reasoning"
                    ? "reasoning" as const
                    : displayPhase === "reasoning_summary"
                      ? "reasoning_summary" as const
                    : displayPhase === "candidate_final"
                      ? "candidate_final" as const
                      : "progress" as const,
                  text: view.fullText(),
                });
      this.#streamingItems.set(id, { revision: view.revision, item });
      items.push(item);
      projectionViews.push({
        id,
        item,
        revision: view.revision,
        sourceView: view.sourceView,
      });
    }

    const activeIds = new Set(projectionViews.map((entry) => entry.id));
    for (const id of this.#streamingItems.keys()) {
      if (!activeIds.has(id)) this.#streamingItems.delete(id);
    }
    return { items, views: projectionViews };
  }

  #renderFrame(clearScreen = false): void {
    const frameStart = this.#perf.beginFrame();
    this.#cancelScheduledFrame();
    if (clearScreen) {
      if (this.#openTui !== undefined) {
        this.#openTui.clear();
      } else {
        this.#ansiWriter?.reset();
      }
    }
    // The physical terminal size drives the frame. Forcing a larger logical
    // size made wrap, cursor, and IME positions disagree with the real cells
    // on small terminals (P2); the layout plan owns the compact breakpoints.
    const size = this.#terminalSize();
    if (
      this.#lastFrameSize !== undefined &&
      (this.#lastFrameSize.columns !== size.columns || this.#lastFrameSize.rows !== size.rows)
    ) {
      this.#invalidateTimelineScrollRange();
    }
    this.#lastFrameSize = size;
    const width = size.columns;
    const rows = size.rows;
    const capabilities = {
      ...this.capabilities,
      columns: width,
      rows,
    };
    const model = this.#latestModel;
    const liveTurnId = model?.currentTurnId;
    const streaming = this.#perf.measure("live_collect", () =>
      this.#streamingProjectionViews(
        model?.lastSequence ?? 0,
        model === undefined ? [] : this.#liveSpans.rootViews(liveTurnId),
      ));
    const streamingItems = streaming.items;
    const displayModel =
      model !== undefined && streamingItems.length > 0 && this.#timelineProjection === undefined
        ? {
            ...model,
            timeline: [...model.timeline, ...streamingItems],
          }
        : model;
    // A pristine session normally uses the landing screen, but an open document
    // still needs the session frame's body region.
    const showHome =
      displayModel === undefined ||
      (isPristineSession(displayModel) &&
        streamingItems.length === 0 &&
        this.#approval === undefined &&
        this.#planApproval === undefined &&
        this.#userAsk === undefined &&
        this.#promptRequest === undefined);
    const sessionModel =
      displayModel !== undefined && this.#selectedReasoningEffort !== undefined
        ? { ...displayModel, reasoningEffort: this.#selectedReasoningEffort }
        : displayModel;
    // Approval is rendered as an inline decision card within the timeline,
    // so the conversation history and live progress remain visible above it.
    const approval = this.#approval;
    const planApproval = this.#planApproval;
    const userAsk = this.#userAsk;
    const overlayLines =
      this.#overlay !== undefined
        ? renderOverlay(
            this.#overlay.kind,
            this.#overlay.body,
            blockContext(capabilities, width),
          )
        : undefined;

    const targetWidth = this.#plan.showSidebar ? this.#plan.mainWidth : width;
    const approvalCardLines =
      approval !== undefined
        ? renderApproval(approval.request, blockContext(capabilities, targetWidth), {
            offeredScopes: [...approval.request.offeredScopes],
            selected: approval.selected,
            active: true,
            compact: false,
          })
        : undefined;

    const planApprovalCardLines =
      planApproval !== undefined
        ? renderPlanApprovalPicker(planApproval.state, blockContext(capabilities, targetWidth), {
            choices: planApproval.choices,
            selected: planApproval.selected,
          })
        : undefined;

    const userAskCardLines =
      userAsk !== undefined
        ? renderUserAsk(userAsk, blockContext(capabilities, targetWidth))
        : undefined;

    const promptCardLines =
      this.#promptRequest !== undefined
        ? renderInputPrompt(this.#promptRequest, blockContext(capabilities, targetWidth))
        : undefined;

    const activeCardLines = userAskCardLines ?? promptCardLines ?? approvalCardLines ?? planApprovalCardLines;

    const renderedFrame = this.#perf.measure(
      showHome ? "chrome_render" : "timeline_render",
      () => showHome
      ? { lines: renderHomeFrame({
          columns: width,
          rows,
          version: this.#options.version,
          workspacePath: this.#options.workspacePath,
          model: model?.modelId ?? this.#options.provider ?? "gpt-5.6-sol",
           reasoningEffort: this.#selectedReasoningEffort ?? model?.reasoningEffort ?? "medium",
           interactionMode: model?.modeState.selected ?? "build",
           ...(model?.modeState.pending === undefined ? {} : { pendingInteractionMode: model.modeState.pending }),
          mcpCount: this.#mcpServers.length,
          composer: this.#composerState,
          notices: this.#notices,
          ...(this.#completion !== undefined ? { completion: this.#completion } : {}),
          ...(overlayLines !== undefined ? { overlay: overlayLines } : {}),
          theme: this.theme,
          capabilities,
        }) }
      : renderSessionFrame({
          model: sessionModel as SessionViewModel,
          columns: width,
          rows,
          composer: this.#composerState,
          ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
          ...(this.#credentialSource !== undefined ? { credentialSource: this.#credentialSource } : {}),
          ...(overlayLines !== undefined
            ? {
                overlay: overlayLines,
                overlayScrollOffset: this.#overlay?.offset ?? 0,
              }
            : {}),
          ...(activeCardLines !== undefined ? { approvalCard: activeCardLines } : {}),
          ...(approval !== undefined
            ? {
                offeredScopes: [...approval.request.offeredScopes],
                selectedApprovalChoice: approval.selected,
                activeApprovalId: approval.request.approvalId,
              }
            : {}),
          ...(this.#completion !== undefined ? { completion: this.#completion } : {}),
          ...(this.#sidebarVisible !== undefined ? { sidebarVisible: this.#sidebarVisible } : {}),
          ...(this.#turnTitle !== undefined ? { sidebarTitle: this.#turnTitle } : {}),
          mcpServers: this.#mcpServers,
          lspServers: this.#lspServers,
          timelineScrollOffsetFromBottom: this.#timelineScrollOffset,
          ...(this.#timelineMaxScrollOffset !== undefined
            ? { timelineMaxScrollOffsetHint: this.#timelineMaxScrollOffset }
            : {}),
           ...(this.#timelineProjection !== undefined
             ? { timelineProjection: this.#timelineProjection }
             : {}),
           ...(this.#timelineProjection !== undefined
             ? { streamingViews: streaming.views }
             : {}),
          liveFrame: this.#liveFrame,
          notices: this.#notices,
          ...(this.#options.permissionsSummary !== undefined
            ? { permissionDetail: this.#options.permissionsSummary }
            : {}),
          ...(this.#options.provider !== undefined ? { provider: this.#options.provider } : {}),
          workspacePath: this.#options.workspacePath,
          ...(this.#options.git !== undefined ? { git: this.#options.git } : {}),
          ...(this.#options.uiShowCost !== undefined
            ? { showCost: this.#options.uiShowCost }
            : {}),
          ...(this.#options.uiStatusDensity !== undefined
            ? { statusDensity: this.#options.uiStatusDensity }
            : {}),
          accordionCollapsed: this.#accordionCollapsed,
          thinkingVisibility: this.#thinkingVisibility,
          toolDetail: this.#toolDetail,
          subagentDetail: this.#subagentDetail,
          // Elapsed labels share the live-line cadence; sub-millisecond clock
          // changes must not invalidate every running task cache on event frames.
          nowMs:
            Math.floor(this.#options.host.now() / FULL_SCREEN_SPINNER_INTERVAL_MS) *
            FULL_SCREEN_SPINNER_INTERVAL_MS,
          theme: this.theme,
           capabilities,
         }),
    );

    if (renderedFrame.timelineMaxScrollOffset !== undefined) {
      this.#timelineMaxScrollOffset = renderedFrame.timelineMaxScrollOffset;
      this.#timelineScrollOffset = Math.max(
        0,
        Math.min(this.#timelineScrollOffset, renderedFrame.timelineMaxScrollOffset),
      );
    }
    let frame = this.#perf.measure("frame_fit_clip", () => {
      let fitted = paintFrameBase(renderedFrame.lines);
      // Apply the mouse-selection inverse-video overlay on top of the painted frame.
      fitted = applySelectionOverlay(fitted, this.#selection);
      // Inject the toast into the upper-right presentation layer when one is active.
      // The overlay keeps the composer, status bar, and frame height in place.
      if (this.#toast !== undefined && !toastExpired(this.#toast, this.#options.host.now())) {
        fitted = injectToast(fitted, this.#toast, blockContext(capabilities, width));
      }
      return fitted;
    });
    this.#lastFrame = frame;
    const cursor = resolveComposerCursor(frame, this.#composerState, width, rows);
    if (this.#openTui !== undefined) {
      this.#openTui.render(withRowRevisions(frame), cursor);
      this.#clearFrameDirty();
      this.#perf.endFrame(frameStart);
      return;
    }
    const cursorSequence = ansiCursorSequence(cursor);
    const terminalRows = this.#perf.measure("row_diff_or_ansi", () => frame.map((row) => {
      const rendered = this.theme.depth === "none"
        ? renderPlain([row])
        : renderAnsi([row], {
            theme: this.theme,
            capabilities: this.#options.decision.capabilities,
            columns: width,
          });
      // CRLF keeps wide rows from shifting the next cursor-addressed update on
      // terminals that leave the column unchanged after LF.
      return rendered.replaceAll("\n", "\r\n");
    }));
    this.#ansiWriter ??= new TerminalFrameWriter({
      write: (text) => this.#options.host.io.stdout(text),
      onDrain: (listener) => {
        const stdout = process.stdout as NodeJS.WriteStream & {
          on?: (event: string, callback: () => void) => void;
          off?: (event: string, callback: () => void) => void;
        };
        if (typeof stdout.on !== "function") return () => undefined;
        stdout.on("drain", listener);
        return () => stdout.off?.("drain", listener);
      },
    });
    this.#perf.measure("stdout_write", () => {
      this.#ansiWriter?.writeFrame(terminalRows, cursorSequence, { full: clearScreen });
    });
    this.#clearFrameDirty();
    this.#perf.endFrame(frameStart);
  }

  #timelinePageRows(): number {
    const rows = Math.max(2, this.#openTui?.rows || this.#options.host.io.rows || 24);
    return Math.max(1, Math.floor(rows / 2));
  }

  #terminalSize(): { columns: number; rows: number } {
    return {
      columns: Math.max(
        1,
        this.#openTui?.columns || this.#options.host.io.columns || this.#plan.columns,
      ),
      rows: Math.max(1, this.#openTui?.rows || this.#options.host.io.rows || 24),
    };
  }

  #invalidateTimelineScrollRange(): void {
    this.#timelineMaxScrollOffset = undefined;
  }


  /**
   * Recompute the layout from the terminal's current width.
   *
   * §6.16 requires a resize to be handled, and in plain mode the width is only
   * observable by asking the host. Re-planning on every flush is cheap and means a
   * terminal resized mid-turn wraps correctly on the next block rather than at the
   * next turn.
   */
  #replan(): void {
    this.#invalidateTimelineScrollRange();
    const columns = this.#options.host.io.columns ?? this.#options.decision.capabilities.columns;
    const rows = this.#options.host.io.rows ?? this.capabilities.rows;
    const plan = planLayout(columns, {
      rows,
      ...(this.#sidebarVisible !== undefined ? { sidebarVisible: this.#sidebarVisible } : {}),
    });
    this.#plan = plan;
    this.#context = blockContext(
      { ...this.#options.decision.capabilities, columns, rows },
      plan.mainWidth,
    );
  }
}

function mergeHistoricalTimeline(
  historical: readonly TimelineItem[],
  resident: readonly TimelineItem[],
): TimelineItem[] {
  const residentIds = new Set(resident.map((item) => item.id));
  const prefix = historical
    .filter((item) => !residentIds.has(item.id))
    .slice()
    .sort((left, right) => left.sequence - right.sequence);
  if (prefix.length === 0) return [...resident];

  const merged: TimelineItem[] = [];
  let left = 0;
  let right = 0;
  while (left < prefix.length || right < resident.length) {
    const historicalItem = prefix[left];
    const residentItem = resident[right];
    if (residentItem === undefined || (historicalItem !== undefined && historicalItem.sequence <= residentItem.sequence)) {
      merged.push(historicalItem as TimelineItem);
      left += 1;
    } else {
      merged.push(residentItem);
      right += 1;
    }
  }
  return merged;
}


// P1-02: presentation split into focused modules. The frame renderer and the
// timeline presenter are the same code paths the golden tests exercise.
import {
  chronologicalPlainRecords,
  cloneTimelineItemForUi,
  timelineItemEqual,
  timelineSubagentEventEqual,
} from "./tui-timeline.ts";
import {
  ansiCursorSequence,
  canUseNativeOpenTui,
  completionPopupOptions,
  injectToast,
  isPristineSession,
  liveExpandedIds,
  paintFrameBase,
  renderHomeFrame,
  renderPlanControls,
  renderSessionFrame,
  resolveComposerCursor,
  withRowRevisions,
} from "./tui-frame.ts";
import { installTerminalGuards } from "./tui-lifecycle.ts";

export { installTerminalGuards };
export { resolveComposerCursor } from "./tui-frame.ts";


/**
 * Bridges session events to the UI.
 *
 * Returned as a closure rather than wired inside `InteractiveUi` so headless runs can
 * substitute the JSONL writer for the same seam (§8.3).
 */
export function uiEventSink(
  ui: InteractiveUi,
): (event: CbcEvent, model: SessionViewModel) => void {
  return (event, model) => {
    if (event.kind === "job.output") {
      ui.processOutput(event.payload);
      ui.live(model);
      return;
    }
    if (event.kind === "assistant.delta") {
      const payload = event.payload as {
        text?: unknown;
        itemId?: unknown;
        phase?: unknown;
      };
      const phase =
        payload.phase === "commentary"
          ? "progress"
          : payload.phase === "progress" ||
              payload.phase === "reasoning" ||
              payload.phase === "reasoning_summary" ||
              payload.phase === "candidate_final" ||
              payload.phase === "final"
            ? payload.phase
            : undefined;
      if (phase !== undefined && typeof payload.text === "string") {
        ui.stream(payload.text, phase, {
          agentId: event.agentId ?? "root",
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          ...(typeof payload.itemId === "string" ? { itemId: payload.itemId } : {}),
          ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
        });
      }
      ui.live(model);
      return;
    }
    ui.acceptDurableAssistantEvent(event);
    ui.finishStream();
    if (event.kind === "user.message") ui.resetStream();
    ui.flush(model);
    if (event.kind === "mode.changed") ui.status(model);
    if (event.kind === "turn.cancelled") {
      ui.closeStreams("cancelled", event.turnId);
    } else if (
      event.kind === "error.provider" ||
      event.kind === "error.protocol" ||
      event.kind === "error.internal"
    ) {
      ui.closeStreams("failed", event.turnId);
    } else if (event.kind === "turn.completed") {
      ui.closeStreams("replaced", event.turnId);
    }
    ui.live(model);
  };
}
