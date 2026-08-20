/**
 * The interactive session — PRD §7.1, §7.4, §7.7, §8.2, §8.10, §19.3, AC-04, AC-40.
 *
 * §7.1's ordering is the structure of this function: detect, resolve the workspace,
 * decide trust, check auth, load the model registry, **paint**, then warm the
 * repository map and update check in the background. The paint happens before the
 * provider or the repository scan exists, which is what AC-04 measures.
 *
 * §7.7's cancellation semantics are wired to one `AbortController` per turn:
 * `Esc Esc` during sampling aborts the turn and leaves the partial text marked.
 * The interactive composer reserves `Ctrl+C Ctrl+C` for program exit; `Esc Esc` cancels work.
 */

import { isTokenSavingLevel } from "@cbc/agent-kernel";
import type { ReasoningEffort } from "@cbc/config-schema";
import type { CbcEvent } from "@cbc/protocol";
import type { SessionViewModel } from "@cbc/session-domain";
import { findModel, MODEL_REGISTRY } from "@cbc/provider-openai";
import { describeEffectivePermissionPolicy, isPermissionPreset, resolvePermissionPolicy } from "@cbc/permissions";
import { renderSkillList } from "@cbc/skills";
import { SUBAGENT_ROLES, roleDefinition } from "@cbc/subagents";
import {
  DEFAULT_KEYMAP,
  renderContextUsage,
  renderTodoList,
  renderPlanContract,
  lineText,
  SLASH_COMMANDS,
  applyRemapping,
  renderKeymapHelp,
  type CompletionCandidate,
  type KeyBinding,
  type SidebarService,
} from "@cbc/tui-components";

import { bootstrapSession, warmContext } from "../bootstrap.ts";
import type { ToolBridges } from "../tools.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { workspaceIdentityFor } from "../host.ts";
import { InputReader } from "../input-reader.ts";
import { inertKeyStream } from "../keys.ts";
import { WorkspacePathMentionIndex } from "../path-mentions.ts";
import { listApprovalRules, revokeApprovalRule } from "../rules-store.ts";
import { setUserConfigValue } from "../state.ts";
import {
  REASONING_EFFORTS,
  parseSlash,
  slashArgumentValues,
  slashCompletions,
} from "../slash.ts";
import {
  InteractiveUi,
  installTerminalGuards,
  uiEventSink,
  type SettingsMenuChange,
  type SettingsMenuItem,
} from "../tui.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";
import { ensureTrust, trustLabel } from "./trust.ts";

export interface InteractiveArgs {
  readonly prompt?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly reasoningMode?: string;
  readonly mode?: string;
  readonly interactionMode?: "build" | "plan";
  readonly permissionPreset?: "read" | "edit" | "auto" | "yolo";
  readonly review?: "off" | "auto";
  readonly resume?: string;
  readonly readOnly?: boolean;
}

export async function interactive(
  context: CommandContext,
  args: InteractiveArgs,
): Promise<CommandResult> {
  // §7.1 step 3, before anything reads the workspace.
  const trust = await ensureTrust(context);
  if (trust === "exit") return ok();

  // P1-02: the `[ui]` config drives real render decisions — theme palette,
  // mouse tracking, animation, cost visibility, status density. Read leniently:
  // a config error must not strand the terminal mid-startup; `config validate`
  // still reports it, and the session bootstrap refuses it before any turn.
  const loaded = await context.config();
  const uiConfig = loaded.config.ui;
  const remapped = applyRemapping(DEFAULT_KEYMAP, loaded.config.keymap);
  const effectiveKeymap = remapped.keymap;
  for (const issue of remapped.issues) context.warn(`keymap: ${issue}`);

  const perms = loaded.config.permissions;
  const startupPreset = args.permissionPreset ??
    (args.mode === "plan" || args.interactionMode === "plan" ? "read" :
      args.mode === "read" || args.mode === "edit" || args.mode === "auto" || args.mode === "yolo"
        ? args.mode
        : undefined);
  const policy = resolvePermissionPolicy(startupPreset, { projectWrite: perms.projectWrite, shell: perms.shell, network: perms.network, destructive: perms.destructive, credentials: perms.credentials, externalSideEffect: perms.externalSideEffect }, args.mode ?? loaded.config.agent.permissionMode);
  const presetLabel = policy.effectiveKind.toUpperCase();
  const permissionsSummary = args.readOnly === true ? `RO · ${presetLabel}` : presetLabel;
  let settingWriteTail: Promise<void> = Promise.resolve();
  const persistSetting = (
    key: "thinkingVisibility" | "thinkingMode" | "toolDetail" | "subagentDetail" | "sidebar",
    value: string,
  ): void => {
    settingWriteTail = settingWriteTail
      .then(async () => {
        const result = await setUserConfigValue(context.host, `ui.${key}`, value);
        const error = result.issues.find((issue) => issue.severity === "error");
        if (error !== undefined) context.warn(`setting ${key} was not saved: ${error.message}`);
      })
      .catch((error: unknown) => {
        context.warn(
          `setting ${key} was not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  const ui = new InteractiveUi({
    host: context.host,
    decision: context.decision,
    writer: context.writer,
    workspacePath: context.workspacePath,
    version: context.version,
    mcpServers: await configuredMcpServers(context),
    lspServers: [],
    uiTheme: uiConfig.theme,
    uiMouse: uiConfig.mouse,
    uiAnimations: uiConfig.animations,
    uiShowCost: uiConfig.showCost,
    uiStatusDensity: uiConfig.statusDensity,
    uiThinkingVisibility: uiConfig.thinkingVisibility,
    uiThinkingMode: uiConfig.thinkingMode,
    uiToolDetail: uiConfig.toolDetail,
    uiSubagentDetail: uiConfig.subagentDetail,
    sidebarVisibility: uiConfig.sidebar,
    onSettingChange: persistSetting,
    permissionsSummary,
  });
  context.setDiagnosticSink((text) => ui.diagnostic(text));

  // AC-40: restore on every exit path, including a crash during startup.
  const uninstallGuards = installTerminalGuards(ui, {
    onFatal: (error) => {
      context.warn(error instanceof Error ? error.message : String(error));
    },
  });

  const removeRuntimeNotifications = context.onRuntimeNotification((method, params) => {
    if (method === "process.output") ui.processOutput(params);
  });

  try {
    // §7.1 step 6: paint first.
    await ui.open({ trustLabel: trustLabel(trust) });

    // The trust prompt runs before the runtime exists so it can paint first. Once
    // the runtime is started, mirror the session decision into its filesystem guard
    // before the first turn; otherwise `trusted-once` remains host-only and a write
    // is rejected as untrusted by the Rust boundary.
    const runtime = await context.runtime();
    const capabilities = runtime.capabilities;
    if (capabilities !== undefined) {
      ui.setEffectiveSandbox(
        capabilities.sandboxLevel,
        capabilities.sandboxBackends,
        capabilities.sandboxLevel !== loaded.config.sandbox.level,
        loaded.config.sandbox.level,
      );
    }
    await ensureTrust(context, { runtime });

    let suppressUiEvents = false;
    let activeSessionId: string | undefined;
    // Coalesce workspace-invalidating events into an idle rescan. Native fs tools
    // commit transactions, while processes and shells may mutate without one.
    // The rescan callback is installed below, after the initial scan exists, and is
    // never invoked from the composer's key-processing path.
    let pathIndexDirty = false;
    let requestPathIndexRefresh: (() => void) | undefined;
    let pathMentions: WorkspacePathMentionIndex | undefined;
    let schedulePathCompletionRefresh: () => void = () => undefined;
    const processMutationCalls = new Set<string>();
    const sink = uiEventSink(ui);
    const onEvent = (event: CbcEvent, model: SessionViewModel): void => {
      if (suppressUiEvents || (activeSessionId !== undefined && event.sessionId !== activeSessionId)) return;

      const dirtyBeforeEvent = pathIndexDirty;
      const invalidation = pathIndexInvalidationForEvent(event, processMutationCalls);
      if (invalidation.dirty) pathIndexDirty = true;
      // Background jobs can finish while the composer is idle, with no later turn
      // boundary available to notice the dirty flag.
      if (invalidation.refreshNow) requestPathIndexRefresh?.();
      const eventPayload = typeof event.payload === "object" && event.payload !== null
        ? event.payload as Record<string, unknown>
        : undefined;
      if (event.kind === "transaction.committed") {
        const upserts = new Set<string>();
        const removed = new Set<string>();
        const rawPaths = eventPayload?.paths;
        if (Array.isArray(rawPaths)) {
          for (const path of rawPaths) {
            if (typeof path === "string") upserts.add(path);
          }
        }
        const operations = eventPayload?.operations;
        if (Array.isArray(operations)) {
          for (const operation of operations) {
            if (typeof operation !== "object" || operation === null || Array.isArray(operation)) continue;
            const record = operation as Record<string, unknown>;
            if (typeof record.path !== "string") continue;
            const action = String(record.operation ?? record.action ?? record.kind ?? "").toLowerCase();
            if (action === "delete" || action === "remove" || action === "removed") removed.add(record.path);
            else upserts.add(record.path);
          }
        }
        if (upserts.size > 0 || removed.size > 0) {
          pathMentions?.applyDelta([...upserts], [...removed]);
          // A fully described native transaction has already supplied the exact
          // delta; do not turn its terminal event into a repository-wide scan.
          if (!dirtyBeforeEvent) pathIndexDirty = false;
          schedulePathCompletionRefresh();
        }
      }
      if ((event.kind as string) === "permission.changed") {
        const selected = typeof eventPayload?.selectedPreset === "string" ? eventPayload.selectedPreset.toUpperCase() : undefined;
        const effective = typeof eventPayload?.effectiveKind === "string" ? eventPayload.effectiveKind.toUpperCase() : undefined;
        const label = selected === "YOLO" && effective === "YOLO" ? "YOLO" : effective ?? selected ?? "CUSTOM";
        ui.setPermissionSummary(args.readOnly === true ? `RO · ${label}` : label);
      }
      sink(event, model);
    };

    // P0-08: in the full-screen renderer an approval is a focus state of the UI,
    // answered through the session's single key stream. The plain fallback keeps
    // the broker's own line-oriented prompt; attaching a second stdin reader to
    // a full-screen session is exactly what split escape sequences and phantom
    // turn cancels.
    const fullScreen = context.decision.mode === "opentui";

    const fullScreenUserAsk: NonNullable<ToolBridges["ask"]> = async (question, choices, signal) => {
      if (signal.aborted) return "cancelled";
      if (choices.length === 0) {
        const answer = await ui.requestPrompt(question);
        return signal.aborted ? "cancelled" : answer ?? "declined";
      }

      const selected = await ui.requestUserAsk(question, choices);
      if (signal.aborted) return "cancelled";
      return selected >= 0 && selected < choices.length
        ? choices[selected] ?? "declined"
        : "declined";
    };

    const bootstrapOptions = (resume: string | undefined) => ({
      context,
      overrides: {
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.reasoning !== undefined ? { reasoningEffort: args.reasoning } : {}),
        ...(args.reasoningMode !== undefined ? { reasoningMode: args.reasoningMode } : {}),
        ...(args.mode !== undefined ? { permissionMode: args.mode } : {}),
        ...(args.interactionMode !== undefined ? { interactionMode: args.interactionMode } : {}),
        ...(args.permissionPreset !== undefined ? { permissionPreset: args.permissionPreset } : {}),
        ...(args.review !== undefined ? { reviewMode: args.review } : {}),
      },
      ...(args.readOnly === true ? { readOnly: true } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(fullScreen ? { bridges: { ask: fullScreenUserAsk } } : {}),
      interactiveApprovals: {
        host: context.host,
        explain: async () => {
          if (!fullScreen) {
            return await context.host.io.prompt("Explain why (sent to the model): ");
          }
          const answer = await ui.requestPrompt("Explain why (sent to the model):");
          return answer ?? "";
        },
        ...(fullScreen
          ? {
              present: (request: import("@cbc/permissions").ApprovalRequest, choices: readonly string[]) =>
                ui.requestApproval(request, choices),
            }
          : {}),
      },
      onLspStatus: (servers: readonly SidebarService[]) => ui.setLspServers(servers),
      onEvent,
    });

    let boot = await bootstrapSession(bootstrapOptions(args.resume));
    activeSessionId = boot.sessionId;
    ui.setSessionInfo(boot.sessionId, boot.credentialSource);
    ui.setEarlierHistoryLoader(boot.loadEarlierHistory);

    for (const warning of boot.warnings) context.warn(warning);
    if (boot.mockedProvider) {
      context.warn("using the scripted mock provider (CBC_MOCK_PROVIDER)");
    }
    if (boot.resumedFrom !== undefined) {
      ui.text(`Resumed ${boot.resumedFrom.id} (${boot.resumedFrom.turnCount} prior turn(s))`);
    }

    // §7.1 step 7: repository map after first paint, never blocking it.
    let resumeCandidates: CompletionCandidate[] = [];
    const refreshResumeCandidates = async (): Promise<void> => {
      try {
        const runtime = await context.runtime();
        const { sessions } = await runtime.listSessions({ limit: 30 });
        const sorted = [...sessions].sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
        );
        resumeCandidates = sorted.slice(0, 30).map((entry) => {
          const rawTitle = entry.title?.trim() ?? "";
          const hasTitle = rawTitle.length > 0 && rawTitle !== "Untitled session";
          const display = hasTitle ? rawTitle : entry.id;
          return {
            value: display,
            detail: hasTitle
              ? `${entry.id} · ${entry.state} · ${entry.turnCount} turn(s)`
              : `${entry.state} · ${entry.turnCount} turn(s)`,
            insert: entry.id,
          };
        });
      } catch {
        resumeCandidates = [];
      }
    };
    await refreshResumeCandidates();

    // `CompletionSources.paths` is synchronous because it runs on every keypress.
    // Populate this in-memory index from the existing background repository scan
    // rather than performing an RPC (or disk walk) from the composer reducer.
    pathMentions = new WorkspacePathMentionIndex();
    let refreshPathCompletions: (() => void) | undefined;
    let pathCompletionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    schedulePathCompletionRefresh = (): void => {
      if (pathCompletionRefreshTimer !== undefined) return;
      pathCompletionRefreshTimer = setTimeout(() => {
        pathCompletionRefreshTimer = undefined;
        refreshPathCompletions?.();
      }, 50);
    };
    let scanGeneration = 0;
    const scanSession = (session: typeof boot.session) => {
      const generation = ++scanGeneration;
      return warmContext(context, session, { lspHost: boot.lspHost }).then((scan) => {
        if (scan.warning !== undefined) context.warn(scan.warning);
        if (generation === scanGeneration) {
          const files = session.context.repositoryMap?.files ?? [];
          pathMentions.replaceFiles(files);
          schedulePathCompletionRefresh();
        }
        return scan;
      });
    };
    let scanPromise: Promise<unknown> = scanSession(boot.session);
    requestPathIndexRefresh = () => {
      if (!pathIndexDirty) return;
      pathIndexDirty = false;
      scanPromise = scanSession(boot.session);
    };

    let exitCode: ExitCode = EXIT.ok;
    let pending = args.prompt;

    let persistence = new SessionPersistenceQueue(context);
    /**
     * P1-02: `Ctrl+A` and `Ctrl+T` emit an `open_overlay` effect; this is the
     * side effect it maps to. The content comes from live session state, so it
     * is built at key-press time, not cached.
     */
    const openNamedOverlay = (name: string): void => {
      const model = boot.session.viewModel;
      if (name === "jobs") {
        const lines: string[] = [];
        if (model.activeTasks.length === 0 && model.activeJobs.length === 0) {
          lines.push("No active tasks or background jobs.");
        }
        for (const task of model.activeTasks) {
          lines.push(`task ${task.taskId}  ${task.role}  ${task.state}  ${task.goal}`);
        }
        for (const job of model.activeJobs) {
          lines.push(`job  ${job.jobId}  ${job.state}  ${job.display}`);
        }
        ui.openOverlay("jobs", lines);
        return;
      }
      if (name === "agents") {
        const lines = ["Built-in roles (§15.2):"];
        for (const role of SUBAGENT_ROLES) {
          const definition = roleDefinition(role);
          lines.push(
            `  ${role.padEnd(9)} ${definition.permissionClass.padEnd(8)} ${definition.description}`,
          );
        }
        const running = model.activeTasks;
        if (running.length > 0) {
          lines.push("", "Running now:");
          for (const task of running) {
            lines.push(`  ${task.taskId}  ${task.role}  ${task.state}  ${task.goal}`);
          }
        }
        ui.openOverlay("agents", lines);
        return;
      }
      if (name === "details") {
        const lines: string[] = [];
        for (const item of model.timeline.slice(-200)) {
          const record = item as unknown as Record<string, unknown>;
          const owner =
            typeof record.agentId === "string" ? record.agentId : "root";
          const detail = [
            record.toolId,
            record.argumentsSummary,
            record.state,
            record.summary,
            record.text,
          ].find((value): value is string =>
            typeof value === "string" && value.length > 0);
          lines.push(
            `${String(item.sequence).padStart(6)}  ${owner.padEnd(10)} ${item.type.padEnd(14)} ${detail ?? ""}`,
          );
          if (item.type === "task") {
            for (const event of item.subagentEvents) {
              lines.push(
                `${String(event.sequence).padStart(6)}  ${item.role.padEnd(10)} tool           ${event.toolId} ${event.argumentsSummary} [${event.status}]`,
              );
            }
          }
        }
        ui.openOverlay(
          "details",
          lines.length > 0 ? lines : ["No transcript events yet."],
        );
        return;
      }
      if (name === "help") {
        ui.openOverlay("help", [
          "Composer:",
          "  @path          Mention a workspace file or folder",
          "",
          "Keys:",
          ...renderKeymapHelp(effectiveKeymap),
          "",
          "Slash commands:",
          ...SLASH_COMMANDS.map((command) =>
            `  ${command.name.padEnd(14)} ${command.description}`),
        ]);
        return;
      }
      if (name === "context") {
        ui.openOverlay("context", renderContextUsage(model.contextUsage, ui.blockContext));
        return;
      }
      if (name === "todo") {
        ui.openOverlay("todo", renderTodoList(model.todo, ui.blockContext));
        return;
      }
      if (name === "sessions") {
        ui.openOverlay(
          "sessions",
          resumeCandidates.length > 0
            ? resumeCandidates.map((candidate) =>
                `${candidate.value}${candidate.detail !== undefined ? `  ${candidate.detail}` : ""}`)
            : ["No resumable sessions found."],
        );
        return;
      }
      if (name === "diff") {
        const changes = model.timeline.filter((item) =>
          item.type === "diff" ||
          (item.type === "tool" &&
            /write|patch|delete|apply/i.test(item.toolId)));
        ui.openOverlay(
          "diff",
          changes.length > 0
            ? changes.map((item) => {
                const record = item as unknown as Record<string, unknown>;
                return `${item.sequence}  ${String(record.toolId ?? item.type)}  ${String(record.summary ?? record.argumentsSummary ?? "")}`;
              })
            : ["No recorded file changes in this session."],
        );
        return;
      }
      ui.notice(`No overlay named '${name}'.`);
    };

    // §6.14 / §7.7: one key reader for the whole session. Raw mode staying open is
    // what lets `Esc` reach a running turn — with it open only during a prompt read,
    // the sole interruption a turn could observe was `SIGINT`.
    const keys = context.host.io.keyStream?.() ?? inertKeyStream();
    let automaticPlanPromptKey: string | undefined;
    const reader = new InputReader({
      keys,
      ui,
      activeTaskId: () => boot.session.viewModel.activeTasks[0]?.taskId,
      onCancelTask: (taskId, reason) => boot.session.cancelTask(taskId, reason),
      onOpenOverlay: openNamedOverlay,
      onPromptReady: () => {
        if (!fullScreen) return undefined;
        const current = boot.session.viewModel.modeState;
        const planState = boot.session.viewModel.todo;
        if (current.activeTurn !== undefined || planState.document === undefined) return undefined;

        const readiness = boot.session.planReadiness;
        if (!readiness.ready) {
          const promptKey = `${boot.sessionId}:revision-${planState.revision}`;
          if (automaticPlanPromptKey === promptKey) return undefined;
          automaticPlanPromptKey = promptKey;
          // Older sessions, or a model that created a contract in Build mode
          // before the boundary was enforced, must still have an escape hatch.
          // Move to the read-only review mode so a blocked contract can be
          // refined instead of throwing on every queued message.
          return boot.session.requestInteractionMode("plan", "quiescence").then((mode) => {
            if (mode.kind === "applied" || boot.session.viewModel.modeState.selected === "plan") {
              const approval = boot.session.planApproval;
              const approvedScopeBlocked = readiness.digest !== undefined && approval?.digest === readiness.digest;
              ui.text(approvedScopeBlocked
                ? "Approved Plan execution is blocked. Revise the Plan before proceeding."
                : "Plan needs revision before it can be approved.");
              for (const blocker of readiness.blockers) ui.text(`  blocker: ${blocker}`);
            } else {
              ui.notice("Plan needs revision, but Plan mode could not be installed yet.");
            }
            ui.flush(boot.session.viewModel);
            return undefined;
          });
        }
        const expectedPlanDigest = readiness.ready ? readiness.digest : undefined;
        if (expectedPlanDigest === undefined) return undefined;
        const approval = boot.session.planApproval;
        if (approval !== undefined && approval.digest === expectedPlanDigest) return undefined;
        const promptKey = `${boot.sessionId}:${expectedPlanDigest}`;
        if (automaticPlanPromptKey === promptKey) return undefined;
        automaticPlanPromptKey = promptKey;

        return ui.requestPlanApproval(planState).then(async (choice) => {
          if (choice < 0 || choice > 3) return undefined;
          const currentReadiness = boot.session.planReadiness;
          if (!currentReadiness.ready || currentReadiness.digest !== expectedPlanDigest) {
            ui.notice("Plan changed while the choice was open. Review the updated plan first.");
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          if (choice === 2) {
            automaticPlanPromptKey = undefined;
            ui.openOverlay("plan", renderPlanContract(boot.session.viewModel.todo, ui.blockContext));
            return undefined;
          }
          if (choice === 3) {
            ui.notice("Plan remains read-only. Type feedback to refine it.");
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          if (choice === 1) {
            const result = boot.session.approveTodo("ui", "keep");
            ui.text(result.ok
              ? "Plan approved. It remains read-only until you choose Yes, proceed."
              : result.message);
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          const result = await boot.session.preparePlanExecution("keep", "ui");
          if (!result.ok) {
            ui.text(result.message);
            for (const blocker of result.blockers ?? []) ui.text(`  blocker: ${blocker}`);
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          ui.text("Starting the approved plan.");
          ui.flush(boot.session.viewModel);
          return result.directive;
        });
      },
      onCycleInteractionMode: () => {
        const current = boot.session.viewModel.modeState;
        // A second Shift+Tab cancels a deferred transition by requesting the
        // currently selected mode. Otherwise cycle to the opposite mode.
        const target = current.pending ?? (current.selected === "build" ? "plan" : "build");
        if (current.pending !== undefined) {
          void boot.session.requestInteractionMode(current.selected, "key");
          return undefined;
        }

        if (current.selected === "plan" && target === "build") {
          // An empty Plan is just the read-only interaction mode, not an
          // execution contract. Preserve the ordinary mode toggle until a
          // structured draft exists; otherwise the readiness gate below would
          // strand a fresh Plan session because there is nothing to approve.
          const planState = boot.session.viewModel.todo;
          const hasPlanContract = planState.document !== undefined || planState.items.length > 0;
          if (!hasPlanContract) {
            void boot.session.requestInteractionMode(target, "key");
            return undefined;
          }

          // A Plan choice is only meaningful between turns. Keep Shift+Tab from
          // opening a second decision focus while the running-turn reader is
          // watching Esc for cancellation.
          const turnActive = current.activeTurn !== undefined ||
            !["idle", "completed", "cancelled", "failed", "partial"].includes(boot.session.viewModel.turnStatus);
          if (turnActive) {
            ui.notice("Finish or stop the current turn before approving a Plan.");
            ui.flush(boot.session.viewModel);
            return undefined;
          }

          const readiness = boot.session.planReadiness;
          if (!readiness.ready) {
            ui.text("Plan is not ready for approval.");
            for (const blocker of readiness.blockers) ui.text(`  blocker: ${blocker}`);
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          const expectedPlanDigest = readiness.digest;
          if (expectedPlanDigest === undefined) {
            ui.notice("Plan digest is unavailable; review the Plan before approving it.");
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          const approval = boot.session.planApproval;
          if (approval !== undefined && approval.digest === expectedPlanDigest) {
            // Preserve the established fast path for an already approved
            // digest: Shift+Tab executes it without asking a second question.
            return boot.session.executeApprovedPlan("shift_tab").then((result) => {
              if (!result.ok) {
                ui.text(result.message);
                ui.flush(boot.session.viewModel);
                return undefined;
              }
              ui.flush(boot.session.viewModel);
              return result.directive;
            });
          }

          // A ready but unapproved Plan gets an inline, single-key-stream picker
          // just like a permission card. The selected action is explicit: approve
          // only stays in Plan; execute choices call preparePlanExecution, which
          // records the ui approval before installing Build execution scope.
          // Append-only/plain mode has no redraw-safe focused card, so do not make
          // Shift+Tab appear to do nothing there; the slash commands remain the
          // line-oriented fallback.
          if (!fullScreen) {
            ui.notice("Plan is ready; use /plan approve --keep|--compact, then /plan execute.");
            ui.flush(boot.session.viewModel);
            return undefined;
          }
          return ui.requestPlanApproval(boot.session.viewModel.todo).then(async (choice) => {
            if (choice < 0 || choice >= 4) return undefined;
            // The picker owns a snapshot while the key stream is focused. A
            // concurrent Plan update must never turn that reviewed snapshot into
            // approval of a different execution scope.
            const currentReadiness = boot.session.planReadiness;
            if (!currentReadiness.ready || currentReadiness.digest !== expectedPlanDigest) {
              ui.notice("Plan changed while approval was open; review the updated Plan again.");
              ui.flush(boot.session.viewModel);
              return undefined;
            }
            if (choice === 2) {
              automaticPlanPromptKey = undefined;
              ui.openOverlay("plan", renderPlanContract(boot.session.viewModel.todo, ui.blockContext));
              return undefined;
            }
            if (choice === 3) {
              ui.notice("Plan remains read-only. Type feedback to refine it.");
              ui.flush(boot.session.viewModel);
              return undefined;
            }
            if (choice === 1) {
              const approval = boot.session.approveTodo("ui", "keep");
              ui.text(approval.ok
                ? "Plan approved. It remains read-only until you choose Yes, proceed."
                : approval.message);
              ui.flush(boot.session.viewModel);
              return undefined;
            }
            const result = await boot.session.preparePlanExecution("keep", "ui");
            if (!result.ok) {
              ui.text(result.message);
              for (const blocker of result.blockers ?? []) ui.text(`  blocker: ${blocker}`);
              ui.flush(boot.session.viewModel);
              return undefined;
            }
            ui.text("Starting the approved plan.");
            ui.flush(boot.session.viewModel);
            return result.directive;
          });
        }

        void boot.session.requestInteractionMode(target, "key");
        return undefined;
      },
      onRunningSlashCommand: (text) => {
        const intent = parseSlash(text);
        if (intent.kind !== "set_mode") return false;
        const current = boot.session.viewModel.modeState;
        const target = intent.mode ?? (current.selected === "build" ? "plan" : "build");
        void boot.session.requestInteractionMode(target, "slash");
        return true;
      },
      keymap: effectiveKeymap,
      sources: {
        commands: SLASH_COMMANDS,
        paths: (query) => pathMentions?.candidates(query) ?? [],
        argumentValues: (input) => {
          const values = slashArgumentValues(input, {
            sessions: resumeCandidates,
            model: boot.session.viewModel.modelId,
          });
          if (values === undefined) return undefined;
          const currentValues =
            input.command === "/model"
              ? new Set([boot.session.viewModel.modelId])
              : input.command === "/effort"
                ? new Set([boot.session.viewModel.reasoningEffort])
                : undefined;
          if (currentValues === undefined) return values;
          return [...values]
            .sort(
              (left, right) => Number(currentValues.has(right.value)) - Number(currentValues.has(left.value)),
            )
            .map((candidate) =>
              currentValues.has(candidate.value)
                ? {
                    ...candidate,
                    detail: candidate.detail === undefined ? "current" : `current / ${candidate.detail}`,
                  }
                : candidate,
            );
        },
      },
      now: () => context.host.now(),
    });
    refreshPathCompletions = () => reader.refreshCompletions();
    reader.start();
    const selectOutsideTui = async (
      question: string,
      choices: readonly string[],
    ): Promise<number> =>
      await reader.withExternalInput(async () =>
        await ui.withExternalPrompt(async () =>
          await context.host.io.select(question, choices),
        ),
      );

    const switchToSession = async (id: string): Promise<boolean> => {
      if (id === boot.sessionId) {
        ui.text(`Already in session ${id}.`);
        return true;
      }

      await persistence.persist(boot.session, true);
      suppressUiEvents = true;
      try {
        const replacement = await prepareSessionReplacement(boot, async () =>
          await bootstrapSession(bootstrapOptions(id)),
        );
        if (!replacement.ok) {
          context.warn(`Could not resume ${id}: ${replacement.error instanceof Error ? replacement.error.message : String(replacement.error)}`);
          return false;
        }
        const nextBoot = replacement.current;
        const previousBoot = replacement.previous;
        const previousPersistence = persistence;
        boot = nextBoot;
        persistence = new SessionPersistenceQueue(context);
        disposeAfterPersistence(previousPersistence, previousBoot, context);
        activeSessionId = nextBoot.sessionId;
        ui.setSessionInfo(nextBoot.sessionId, nextBoot.credentialSource);
        ui.resetSession(nextBoot.session.viewModel);
        ui.setEarlierHistoryLoader(nextBoot.loadEarlierHistory);
        ui.flush(nextBoot.session.viewModel);
        for (const warning of nextBoot.warnings) context.warn(warning);
        if (nextBoot.mockedProvider) {
          context.warn("using the scripted mock provider (CBC_MOCK_PROVIDER)");
        }
        if (nextBoot.resumedFrom !== undefined) {
          ui.text(
            `Resumed ${nextBoot.resumedFrom.id} (${nextBoot.resumedFrom.turnCount} prior turn(s))`,
          );
        }
        await refreshResumeCandidates();
        pathIndexDirty = false;
        processMutationCalls.clear();
        scanPromise = scanSession(boot.session);
        exitCode = EXIT.ok;
        return true;
      } catch (error) {
        context.warn(
          `Could not resume ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        suppressUiEvents = false;
      }
    };

    const startNewSession = async (): Promise<boolean> => {
      await persistence.persist(boot.session, true);
      suppressUiEvents = true;
      try {
        const replacement = await prepareSessionReplacement(boot, async () =>
          await bootstrapSession(bootstrapOptions(undefined)),
        );
        if (!replacement.ok) {
          context.warn(`Could not start a new chat: ${replacement.error instanceof Error ? replacement.error.message : String(replacement.error)}`);
          return false;
        }
        const nextBoot = replacement.current;
        const previousBoot = replacement.previous;
        const previousPersistence = persistence;
        boot = nextBoot;
        persistence = new SessionPersistenceQueue(context);
        disposeAfterPersistence(previousPersistence, previousBoot, context);
        activeSessionId = nextBoot.sessionId;
        ui.setSessionInfo(nextBoot.sessionId, nextBoot.credentialSource);
        ui.resetSession(nextBoot.session.viewModel);
        ui.setEarlierHistoryLoader(nextBoot.loadEarlierHistory);
        ui.flush(nextBoot.session.viewModel);
        for (const warning of nextBoot.warnings) context.warn(warning);
        if (nextBoot.mockedProvider) {
          context.warn("using the scripted mock provider (CBC_MOCK_PROVIDER)");
        }
        await refreshResumeCandidates();
        pathIndexDirty = false;
        processMutationCalls.clear();
        scanPromise = scanSession(boot.session);
        exitCode = EXIT.ok;
        return true;
      } catch (error) {
        context.warn(
          `Could not start a new chat: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        suppressUiEvents = false;
      }
    };

    try {
      for (;;) {
        const input = pending ?? (await reader.readPrompt());
        pending = undefined;

        // End of input, or the exit confirmed with `Ctrl+C Ctrl+C`.
        if (input === undefined) break;

        const text = input.trim();
        if (text.length === 0) continue;

        const intent = parseSlash(text);
        if (intent.kind !== "not_slash") {
          const outcome = await handleSlash(
            context,
            ui,
            boot,
            intent,
            effectiveKeymap,
            selectOutsideTui,
          );
          if (outcome === "quit") break;
          if (typeof outcome !== "string") {
            if (outcome.kind === "resume") {
              await switchToSession(outcome.id);
            } else if (outcome.kind === "new_session") {
              await startNewSession();
            } else if (outcome.kind === "submit") {
              pending = outcome.prompt;
            } else {
              pending = outcome.directive;
            }
          }
          continue;
        }

        // Make sure the map is in before the first real turn, so the model is not
        // reasoning about a repository it has not been shown.
        if (boot.session.orientationMode === "strict") await scanPromise;

        const controller = new AbortController();
        // `SIGINT` is still wired for the non-TTY path, where the key reader is
        // inert and a signal is the only interruption available.
        const onSignal = (): void => controller.abort();
        process.on("SIGINT", onSignal);

        // §6.21: the sidebar's title is the turn's goal, so the panel says what the
        // numbers below it are being spent on.
        ui.setTurnTitle(text);

        // Surface any paste-token attachments the composer staged for this turn.
        // The prompt text already contains `[Image N]` / `[Text N]` tokens; this
        // is the host-side acknowledgement so the user can see what each token
        // resolved to before the model receives the message.
        const attachments = reader.lastAttachments;
        if (attachments.length > 0) {
          for (const attachment of attachments) {
            if (attachment.kind === "image" && attachment.path !== undefined) {
              context.out(`Attached image: ${attachment.token} -> ${attachment.path}`);
            } else if (attachment.kind === "text") {
              const preview = attachment.text ?? "";
              const summary =
                preview.length > 40 ? `${preview.slice(0, 40)}…` : preview.replace(/\n/g, " ");
              context.out(`Attached text: ${attachment.token} (${summary.length} chars)`);
            }
          }
        }

        try {
          await reader.duringTurn(controller, boot.session, async () => {
            const result = await boot.session.submit(text, controller.signal);
            ui.flush(boot.session.viewModel);
            // Flush emits task anchors and child responses as their events arrive; draining
            // at the end of a turn is an idempotent catch-up for any final snapshot.
            ui.drain(boot.session.viewModel);
            ui.text("");
            ui.status(boot.session.viewModel);
            ui.text("");
            ui.sidebar(boot.session.viewModel);
            ui.text("");
          });
          if (reader.takeExitRequested()) {
            exitCode = EXIT.ok;
            break;
          }

          // P1-02: a prompt typed while the turn ran is submitted next, and the
          // user saw it queued rather than wondering whether Enter did anything.
          const queuedPlan = boot.session.viewModel.todo.document !== undefined &&
            (() => {
              const readiness = boot.session.planReadiness;
              return !readiness.ready || boot.session.planApproval?.digest !== readiness.digest;
            })();
          // Let an idle Plan decision take precedence over text queued while
          // the drafting turn was still running. Otherwise the queued text is
          // submitted in Build mode and hits the very execution gate the UI was
          // meant to present. Restoring it preserves the user's draft behind
          // the focused Plan card.
          if (queuedPlan) {
            reader.restoreQueuedMessage();
          } else {
            const queued = reader.takeQueuedMessage();
            if (queued !== undefined) pending = queued;
          }
          exitCode = EXIT.ok;
        } catch (error) {
          // A cancelled or failed turn still did work; its chronological timeline remains
          // visible, and drain only catches up a final state (§6.11).
          ui.drain(boot.session.viewModel);
          if (reader.takeExitRequested()) {
            exitCode = EXIT.ok;
            break;
          }

          // The queued next prompt goes back to the editor instead of being
          // silently sent after a turn the user stopped (P1-02).
          if (reader.restoreQueuedMessage()) {
            ui.notice("Queued message restored to the editor.");
          }
          context.warn(error instanceof Error ? error.message : String(error));
          exitCode = EXIT.failure;
        } finally {
          process.off("SIGINT", onSignal);
        }

        void persistence.persist(boot.session);
        // Fallback for providers that return without a terminal turn event. The
        // callback coalesces all native/process mutations observed during the turn.
        requestPathIndexRefresh?.();
      }
    } finally {
      requestPathIndexRefresh = undefined;
      processMutationCalls.clear();
      reader.stop();
    }

    // §18.16: snapshot on a clean exit so the next resume starts from state rather
    // than a full replay.
    await persistence.persist(boot.session, true);
    await settingWriteTail;
    disposeAfterPersistence(persistence, boot, context);
    ui.text("");
    ui.text(`Session saved as ${boot.sessionId}`);
    return exitCode === EXIT.ok ? ok() : { code: exitCode };
  } finally {
    removeRuntimeNotifications();
    context.setDiagnosticSink(undefined);
    ui.restore();
    uninstallGuards();
  }
}

/** Classify session events that can stale the synchronous `@path` index. */
export function pathIndexInvalidationForEvent(
  event: Pick<CbcEvent, "kind" | "payload">,
  processMutationCalls: Set<string>,
): { readonly dirty: boolean; readonly refreshNow: boolean } {
  const payload = typeof event.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
  const callId = typeof payload.callId === "string" ? payload.callId : undefined;

  if (event.kind === "tool.started" && callId !== undefined) {
    const toolId = typeof payload.toolId === "string" ? payload.toolId : "";
    if (toolId === "shell.run" || toolId.startsWith("process.")) {
      processMutationCalls.add(callId);
    }
    return { dirty: false, refreshNow: false };
  }

  if ((event.kind === "tool.completed" || event.kind === "tool.failed") && callId !== undefined) {
    return { dirty: processMutationCalls.delete(callId), refreshNow: false };
  }

  if (event.kind === "transaction.committed") {
    return { dirty: true, refreshNow: false };
  }
  if (event.kind === "job.completed" || event.kind === "job.failed") {
    return { dirty: true, refreshNow: true };
  }
  if (
    event.kind === "turn.completed" ||
    event.kind === "turn.cancelled" ||
    event.kind === "turn.interrupted"
  ) {
    // A cancellation can overtake the tool's own failed event. Conservatively
    // refresh if a process call was still outstanding, then forget its call ID.
    const dirty = processMutationCalls.size > 0;
    processMutationCalls.clear();
    return { dirty, refreshNow: true };
  }
  return { dirty: false, refreshNow: false };
}

const SESSION_PERSIST_TIMEOUT_MS = 5_000;
export type PreparedSessionReplacement<T> =
  | { readonly ok: true; readonly current: T; readonly previous: T }
  | { readonly ok: false; readonly current: T; readonly error: unknown };

/**
 * Prepare a replacement before exposing or disposing either session.
 * A failed bootstrap returns the exact current object unchanged.
 */
export async function prepareSessionReplacement<T>(
  current: T,
  prepare: () => Promise<T>,
): Promise<PreparedSessionReplacement<T>> {
  try {
    return { ok: true, current: await prepare(), previous: current };
  } catch (error) {
    return { ok: false, current, error };
  }
}

interface PersistableSession {
  flush(): Promise<void>;
  snapshot(force?: boolean): Promise<boolean>;
}

/**
 * Serializes journal flushes and snapshots for one live session.
 *
 * A caller may stop waiting after the UI timeout, but the underlying operation
 * remains the queue tail. The next request joins that tail instead of touching
 * the recorder concurrently.
 */
export class SessionPersistenceQueue {
  readonly #context: Pick<CommandContext, "warn">;
  readonly #timeoutMs: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    context: Pick<CommandContext, "warn">,
    timeoutMs = SESSION_PERSIST_TIMEOUT_MS,
  ) {
    this.#context = context;
    this.#timeoutMs = timeoutMs;
  }

  async persist(session: PersistableSession, force = false): Promise<void> {
    let reported = false;
    const operation = this.#tail.then(async () => {
      await session.flush();
      await session.snapshot(force);
    });

    this.#tail = operation.catch((error: unknown) => {
      if (!reported) {
        reported = true;
        this.#warn(error);
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("session persistence timed out")),
        this.#timeoutMs,
      );
    });

    try {
      await Promise.race([operation, timeout]);
    } catch (error) {
      if (!reported) {
        reported = true;
        this.#warn(error);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  whenIdle(): Promise<void> {
    return this.#tail;
  }

  #warn(error: unknown): void {
    this.#context.warn(
      `session persistence degraded; continuing without blocking input: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function disposeAfterPersistence(
  persistence: SessionPersistenceQueue,
  boot: { readonly dispose?: () => Promise<void> },
  context: Pick<CommandContext, "warn">,
): void {
  void persistence
    .whenIdle()
    .then(async () => await boot.dispose?.())
    .catch((error: unknown) => {
      context.warn(
        `session cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}


/**
 * The MCP rows the §6.21 sidebar starts with.
 *
 * Read from config rather than from a live client: §7.1 paints before anything
 * connects, and a panel that waited for a handshake would be blank for exactly the
 * seconds a user is deciding whether the tool started correctly. A disabled server
 * is listed as `disabled` for the same reason — its absence would be indistinguish-
 * able from a server that failed to start.
 */
async function configuredMcpServers(context: CommandContext): Promise<SidebarService[]> {
  try {
    const loaded = await context.config();
    return Object.entries(loaded.config.mcpServers).map(([name, config]) => ({
      name,
      state: config.enabled === false ? ("disabled" as const) : ("starting" as const),
      detail: config.transport,
    }));
  } catch {
    // A malformed config is reported by `capy doctor`; it must not stop the
    // session from painting (§7.1, AC-04).
    return [];
  }
}

type SlashOutcome = "continue" | "quit" | { readonly kind: "resume"; readonly id: string } | { readonly kind: "new_session" } | { readonly kind: "execute_plan"; readonly directive: string } | { readonly kind: "submit"; readonly prompt: string };
type ActiveSession = Awaited<ReturnType<typeof bootstrapSession>>["session"];
type InteractiveSelect = (
  question: string,
  choices: readonly string[],
) => Promise<number>;

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One row in the `/setting` picker.
 *
 * Presentation rows apply through the UI and persist to `ui.*`; the token
 * saving row applies through the running session and persists to
 * `agent.tokenSaving` — a user-only key a project config can never set.
 */
interface SettingDescriptor extends SettingsMenuItem {
  /** Omitted for session actions that belong in the picker but are not config. */
  readonly configPath?: string;
  readonly apply: (session: ActiveSession, value: string) => SettingsMenuChange;
}

function settingDescriptors(ui: InteractiveUi, session: ActiveSession): SettingDescriptor[] {
  return [
    {
      key: "subagents",
      label: "Subagents",
      value: ui.presentationPolicy.subagentDetail,
      configPath: "ui.subagentDetail",
      values: [
        { value: "drawer", label: "Drawer" },
        { value: "inline", label: "Inline" },
      ],
      apply: (_active, value) => {
        if (value === "drawer" || value === "inline") {
          return { value, message: ui.setSubagentDetail(value) };
        }
        return { message: "Use the Subagents setting's popup values." };
      },
    },
    {
      key: "details",
      label: "Details",
      value: ui.presentationPolicy.toolDetail,
      configPath: "ui.toolDetail",
      values: [
        { value: "compact", label: "Compact" },
        { value: "full", label: "Full" },
      ],
      apply: (_active, value) => {
        if (value === "compact" || value === "full") {
          return { value, message: ui.setToolDetail(value) };
        }
        return { message: "Use the Details setting's popup values." };
      },
    },
    {
      key: "thinking",
      label: "Thinking",
      value: ui.presentationPolicy.thinkingMode,
      configPath: "ui.thinkingMode",
      values: [
        { value: "expanded", label: "Expanded" },
        { value: "collapsed", label: "Collapsed" },
        { value: "off", label: "Off" },
      ],
      apply: (_active, value) => {
        if (value === "expanded" || value === "collapsed" || value === "off") {
          return { value, message: ui.setThinkingMode(value) };
        }
        return { message: "Use the Thinking setting's popup values." };
      },
    },
    {
      key: "sidebar",
      label: "Sidebar",
      value: ui.sidebarVisibility,
      configPath: "ui.sidebar",
      values: [
        { value: "auto", label: "Auto" },
        { value: "show", label: "Show" },
        { value: "hide", label: "Hide" },
      ],
      apply: (active, value) => {
        if (value !== "auto" && value !== "show" && value !== "hide") {
          return { message: "Use the Sidebar setting's popup values." };
        }
        const requested = value === "show";
        const showing = ui.setSidebarVisibility(value as "auto" | "show" | "hide");
        if (showing) ui.sidebar(active.viewModel);
        return value === "auto"
          ? { value, message: `Context sidebar ${showing ? "shown" : "hidden"} (auto).` }
          : showing === requested
          ? { value, message: `Context sidebar ${showing ? "shown" : "hidden"}.` }
          : {
              value: showing ? "show" : "hide",
              message: "The sidebar needs more terminal width to be shown.",
            };
      },
    },
    {
      key: "token-saving",
      label: "Token saving",
      value: session.tokenSaving.requestedLevel,
      configPath: "agent.tokenSaving",
      values: [
        { value: "off", label: "Off" },
        { value: "light", label: "Light" },
        { value: "balanced", label: "Balanced (recommended)" },
        { value: "strong", label: "Strong" },
      ],
      apply: (active, value) => {
        if (!isTokenSavingLevel(value)) {
          return { message: "Use Off, Light, Balanced, or Strong for Token saving." };
        }
        active.setTokenSaving(value, "slash");
        return {
          value,
          message: `Token saving set to ${value.toUpperCase()}; active for the next message.`,
        };
      },
    },
    {
      key: "todo",
      label: "TODO",
      value: "show",
      values: [
        { value: "show", label: "Open" },
        { value: "clear", label: "Clear" },
        { value: "approve", label: "Approval help" },
        { value: "hide", label: "Close settings" },
      ],
      apply: (active, value) => {
        if (value === "show") {
          ui.openOverlay("todo", renderTodoList(active.viewModel.todo, ui.blockContext));
          return { value: "show" };
        }
        if (value === "clear") {
          const state = active.viewModel.todo;
          const result = active.writeTodo({
            expectedRevision: state.revision,
            items: [],
            reason: "cleared by user",
            source: "user",
            clearDocument: true,
          });
          return {
            value: "show",
            message: result.ok ? "TODO cleared." : result.message,
          };
        }
        if (value === "approve") {
          return {
            value: "show",
            message: "TODO approval is digest-bound; use /plan approve --keep or /plan approve --compact.",
          };
        }
        if (value === "hide") {
          ui.closeOverlay();
          return { value: "show" };
        }
        return { message: "Use Open, Clear, Approval help, or Close settings for TODO." };
      },
    },
  ];
}

function applySetting(
  ui: InteractiveUi,
  session: ActiveSession,
  descriptors: readonly SettingDescriptor[],
  key: string,
  value: string,
): SettingsMenuChange {
  const descriptor = descriptors.find((entry) => entry.key === key);
  if (descriptor === undefined) return { message: `Unknown setting '${key}'.` };
  return descriptor.apply(session, value);
}

let agentSettingWriteTail: Promise<void> = Promise.resolve();

/**
 * Persist a non-UI setting row to the user config, serialized behind a write
 * tail so rapid picker changes cannot interleave file writes.
 */
function persistAgentSetting(
  context: CommandContext,
  ui: InteractiveUi,
  descriptor: SettingDescriptor,
  value: string,
): void {
  const configPath = descriptor.configPath;
  if (configPath === undefined) return;
  const reportFailure = (reason: string): void => {
    ui.notice(
      `${descriptor.label} ${value.toUpperCase()} is active for this session, ` +
        `but the setting was not saved: ${reason}`,
    );
  };
  agentSettingWriteTail = agentSettingWriteTail
    .then(async () => {
      const written = await setUserConfigValue(context.host, configPath, value);
      const error = written.issues.find((issue) => issue.severity === "error");
      if (error !== undefined) reportFailure(error.message);
    })
    .catch((error: unknown) => {
      reportFailure(error instanceof Error ? error.message : String(error));
    });
}

/**
 * Execute a slash intent.
 *
 * §8.10 keeps these entirely local. Anything not implementable without the
 * full-screen renderer reports what it would show rather than silently doing nothing —
 * a command that appears to work but does not is worse than one that says so.
 */
async function handleSlash(
  context: CommandContext,
  ui: InteractiveUi,
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  intent: ReturnType<typeof parseSlash>,
  effectiveKeymap: readonly KeyBinding[],
  selectOutsideTui: InteractiveSelect,
): Promise<SlashOutcome> {
  const session = boot.session;

  switch (intent.kind) {
    case "quit":
      return "quit";

    case "new_session":
      return { kind: "new_session" };

    case "help": {
      // P0-07: help is a document. In the full-screen renderer it opens as an
      // overlay the user can read in full — the notice queue only keeps three
      // lines, which used to swallow everything below the first keys.
      const lines = ["Slash commands:"];
      for (const command of slashCompletions("")) {
        lines.push(`  ${command.value.padEnd(12)} ${command.detail}`);
      }
      lines.push("", "Keys:");
      for (const keyLine of renderKeymapHelp(effectiveKeymap)) lines.push(`  ${keyLine}`);
      ui.openOverlay("help", lines);
      return "continue";
    }

    case "status": {
      // P0-07: status is a document too; the notice queue kept three of its
      // nine lines.
      const model = session.viewModel;
      const loaded = await context.config();
      const permissions = loaded.config.permissions;
      const configuredPolicy = resolvePermissionPolicy(permissions.preset, { projectWrite: permissions.projectWrite, shell: permissions.shell, network: permissions.network, destructive: permissions.destructive, credentials: permissions.credentials, externalSideEffect: permissions.externalSideEffect }, loaded.config.agent.permissionMode);
      const policy = session.permissionContext().effectivePolicy ?? configuredPolicy;
      const saving = session.tokenSaving;
      const savingPlan = saving.plan;
      const savingLines = savingPlan === undefined
        ? [`Token save ${saving.requestedLevel.toUpperCase()}`]
        : savingPlan.effectiveLevel === savingPlan.requestedLevel
        ? [
            `Token save ${savingPlan.effectiveLevel.toUpperCase()} · Ponytail ${capitalize(savingPlan.ponytail)}`,
          ]
        : [
            `Token save ${savingPlan.requestedLevel.toUpperCase()} requested · ${savingPlan.effectiveLevel.toUpperCase()} effective`,
            `Relaxed by ${savingPlan.reasons[0] ?? "work risk"}`,
            `Policy     Ponytail ${capitalize(savingPlan.ponytail)} · context ${Math.round(savingPlan.targetInputRatio * 100)}% · compact ${Math.round(savingPlan.localCompactionRatio * 100)}%`,
          ];
      const lines = [
        `Session    ${model.sessionId}`,
        `Model      ${model.modelId} · ${model.reasoningEffort}`,
        `Mode       ${model.modeState.selected.toUpperCase()}`,
        ...savingLines,
        ...describeEffectivePermissionPolicy(policy),
        `Trust      ${await context.trust()}`,
        `Sandbox    ${loaded.config.sandbox.level}`,
        `Source    ${session.permissionPreset !== undefined && session.permissionPreset !== permissions.preset ? "session" : (loaded.provenance["permissions.preset"] ?? loaded.provenance["agent.permissionMode"] ?? "default")}`,
        ...(model.modeState.pending === undefined ? [] : [`Pending    ${model.modeState.pending.toUpperCase()} next turn`]),
        `Turns      ${model.turnCount} (${model.cancelledTurns} cancelled)`,
        `Context    ${model.contextUsedTokens} / ${model.contextBudgetTokens} tokens`,
        `Todo       r${model.todo.revision} · ${model.todo.items.filter((item) => item.status === "done").length}/${model.todo.items.length} done`,
        `Tokens     in ${model.usage.inputTokens} (cached ${model.usage.cachedInputTokens}) · out ${model.usage.outputTokens} · reasoning ${model.usage.reasoningTokens}`,
        // §9.2 / §23.7: cost is a product surface, so it is shown by default.
        `Cost       $${model.usage.estimatedCostUsd.toFixed(4)} (estimated)`,
        `Credential ${boot.credentialSource}`,
        "",
      ];
      ui.openOverlay("status", lines);
      return "continue";
    }

    case "approvals": {
      const identity = await workspaceIdentityFor(context.host, context.workspacePath);
      const argument = intent.argument?.trim();
      if (argument !== undefined && argument.startsWith("revoke")) {
        const id = argument.replace(/^revoke\s+/, "").trim();
        if (id.length === 0) {
          ui.text("Usage: /approvals revoke <id> — see /approvals for ids.");
          return "continue";
        }
        const removed = await revokeApprovalRule(context.host, context.paths, id);
        ui.text(removed ? `Revoked ${id}.` : `No saved approval with id ${id}.`);
        return "continue";
      }
      const entries = await listApprovalRules(context.host, context.paths, identity);
      if (entries.length === 0) {
        ui.openOverlay("approvals", [
          "No saved approval rules for this workspace.",
          "",
          "Approve an action with 'Always allow' to add one; revoke it with",
          "/approvals revoke <id>.",
        ]);
        return "continue";
      }
      const lines = entries.map((entry) => {
        const rule = entry.rule;
        const what = [
          rule.tool,
          ...(rule.program !== undefined ? [rule.program] : []),
          ...(rule.argsExact !== undefined
            ? [`[${rule.argsExact.join(" ")}]`]
            : rule.argsPrefix !== undefined && rule.argsPrefix.length > 0
              ? [`${rule.argsPrefix.join(" ")}…`]
              : []),
          ...(rule.cwd !== undefined ? [`cwd=${rule.cwd}`] : []),
          ...(rule.server !== undefined ? [rule.server] : []),
        ].join(" ");
        const age = entry.grantedAt.slice(0, 10);
        return `${entry.id}  ${entry.decision.padEnd(5)} ${what.padEnd(36)} ${age}${entry.legacy ? "  [legacy]" : ""}`;
      });
      lines.push("", "Revoke one with /approvals revoke <id>.");
      ui.openOverlay("approvals", lines);
      return "continue";
    }

    case "set_model": {
      const target = intent.model?.trim();
      // Inline model selections are durable defaults for the next session.
      // The running kernel keeps its current model until the next session.
      if (target === undefined || target.length === 0) return "continue";
      const descriptor = findModel(target);
      if (descriptor === undefined) {
        context.warn("Unknown model " + target);
        return "continue";
      }

      const settings = [
        ["model.profile", "auto"],
        ["model.default", descriptor.id],
      ] as const;
      const { setUserConfigValue } = await import("../state.ts");
      for (const [path, value] of settings) {
        const written = await setUserConfigValue(context.host, path, value);
        const error = written.issues.find((issue) => issue.severity === "error");
        if (error !== undefined) {
          ui.text(`Could not save model selection: ${error.message}`);
          return "continue";
        }
      }

      const current = session.viewModel.modelId;
      const status =
        descriptor.id === current
          ? "already active"
          : "starts next session; current session stays on " + current;
      ui.text("Model saved: " + descriptor.id + " · " + status);
      return "continue";
    }

    case "set_reasoning": {
      if (intent.value === undefined) return "continue";
      if (!REASONING_EFFORTS.includes(intent.value)) {
        context.warn(`'${intent.value}' is not a valid reasoning effort`);
        return "continue";
      }
      const settings = [
        ["model.profile", "auto"],
        ["model.reasoningEffort", intent.value],
      ] as const;
      const { setUserConfigValue } = await import("../state.ts");
      for (const [path, value] of settings) {
        const written = await setUserConfigValue(context.host, path, value);
        const error = written.issues.find((issue) => issue.severity === "error");
        if (error !== undefined) {
          ui.text(`Could not save effort selection: ${error.message}`);
          return "continue";
        }
      }
      session.setReasoningEffort(intent.value as ReasoningEffort);
      ui.setReasoningEffort(intent.value);
      ui.text(`Effort saved: ${intent.value}; active for the next message.`);
      return "continue";
    }

    case "setting": {
      const setting = intent.setting;
      const value = intent.value;
      const descriptors = settingDescriptors(ui, session);
      // Session application is immediate; persistence is queued. A failed
      // write reports itself without rolling back the live session value.
      const applyAndPersist = (key: string, next: string): SettingsMenuChange => {
        const descriptor = descriptors.find((entry) => entry.key === key);
        const result = applySetting(ui, session, descriptors, key, next);
        if (
          descriptor !== undefined &&
          descriptor.configPath !== undefined &&
          result.value !== undefined &&
          // ui.* rows persist through the UI's onSettingChange callback.
          !descriptor.configPath.startsWith("ui.")
        ) {
          persistAgentSetting(context, ui, descriptor, result.value);
        }
        return result;
      };

      if (setting === undefined) {
        if (ui.openSettings(descriptors, applyAndPersist)) {
          return "continue";
        }

        const settingIndex = await selectOutsideTui(
          "Setting",
          descriptors.map((item) => `${item.label} (${item.value})`),
        );
        const selected = descriptors[settingIndex];
        if (selected === undefined) return "continue";
        const valueIndex = await selectOutsideTui(
          selected.label,
          selected.values.map((entry) => entry.label),
        );
        const selectedValue = selected.values[valueIndex];
        if (selectedValue !== undefined) {
          const result = applyAndPersist(selected.key, selectedValue.value);
          if (result.message !== undefined) ui.notice(result.message);
        }
        return "continue";
      }

      const selected = descriptors.find((entry) => entry.key === setting);
      if (selected === undefined) {
        ui.notice(`Unknown setting '${setting}'.`);
        return "continue";
      }

      // `/setting <name>` already identifies the row, so open that row's value
      // picker directly instead of making the user pass through the overview.
      if (value === undefined) {
        if (ui.openSettings(descriptors, applyAndPersist, selected.key)) {
          return "continue";
        }

        const valueIndex = await selectOutsideTui(
          selected.label,
          selected.values.map((entry) => entry.label),
        );
        const selectedValue = selected.values[valueIndex];
        if (selectedValue !== undefined) {
          const result = applyAndPersist(selected.key, selectedValue.value);
          if (result.message !== undefined) ui.notice(result.message);
        }
        return "continue";
      }

      const result = applyAndPersist(selected.key, value);
      if (result.message !== undefined) ui.notice(result.message);
      return "continue";
    }

    case "set_permission": {
      const preset = intent.preset;
      if (preset === undefined) {
        const loaded = await context.config();
        const configuredPolicy = resolvePermissionPolicy(loaded.config.permissions.preset, { projectWrite: loaded.config.permissions.projectWrite, shell: loaded.config.permissions.shell, network: loaded.config.permissions.network, destructive: loaded.config.permissions.destructive, credentials: loaded.config.permissions.credentials, externalSideEffect: loaded.config.permissions.externalSideEffect }, loaded.config.agent.permissionMode);
        const policy = session.permissionContext().effectivePolicy ?? configuredPolicy;
        ui.text(`Permission: ${policy.effectiveKind.toUpperCase()} (${policy.digest.slice(0, 12)}) · source ${session.permissionPreset !== undefined && session.permissionPreset !== loaded.config.permissions.preset ? "session" : (loaded.provenance["permissions.preset"] ?? loaded.provenance["agent.permissionMode"] ?? "default")}`);
        return "continue";
      }
      if (!isPermissionPreset(preset)) {
        context.warn(`'${preset}' is not a permission preset (read|edit|auto|yolo)`);
        return "continue";
      }
      let save = intent.save === true;
      if (preset === "yolo") {
        const selected = await selectOutsideTui(
          "YOLO skips soft approval prompts; trust, deny rules, credentials, Plan scope, sandbox, and OS permissions remain enforced.",
          ["Cancel", "Enable for this session", "Enable and save"],
        );
        if (selected < 1) return "continue";
        save = selected === 2;
      }
      // Confirmation happens before session mutation. A failed persistence keeps
      // the session change visible but reports that it was not saved.
      // Keep the AgentSession receiver: extracting this method loses the private
      // field brand and crashes immediately after a completion is selected.
      session.setPermissionPreset(preset);
      if (save) {
        const { updateUserConfigTransaction } = await import("../state.ts");
        const result = await updateUserConfigTransaction(context.host, { set: { "permissions.preset": preset }, unset: ["agent.permissionMode"] });
        const error = result.issues.find((issue) => issue.severity === "error");
        if (error !== undefined) {
          ui.text(`Permission set to ${preset.toUpperCase()} for this session, but was not saved${error === undefined ? "." : `: ${error.message}`}`);
        } else {
          ui.text(`Permission set to ${preset.toUpperCase()} and saved.`);
        }
      } else {
        ui.text(`Permission set to ${preset.toUpperCase()} for this session.`);
      }
      return "continue";
    }
    case "plan": {
      const strategy = intent.contextStrategy ?? "keep";
      if (intent.action === "enter") {
        const result = await session.requestInteractionMode("plan", "slash");
        ui.text(result.kind === "unchanged" ? "Already in Plan mode." : "Plan mode enabled. Draft a structured Plan Contract, then use /plan approve and /plan execute.");
        return "continue";
      }
      if (intent.action === "show") {
        ui.openOverlay("plan", renderPlanContract(session.viewModel.todo, ui.blockContext));
        return "continue";
      }
      if (intent.action === "refine") {
        if (intent.instruction === undefined) {
          ui.text("Usage: /plan refine <what to change>");
          return "continue";
        }
        const mode = await session.requestInteractionMode("plan", "slash");
        if (mode.kind !== "applied" && session.viewModel.modeState.selected !== "plan") {
          ui.text("Could not enter Plan mode to refine the contract.");
          return "continue";
        }
        return {
          kind: "submit",
          prompt: [
            "HOST PLAN REFINEMENT REQUEST:",
            intent.instruction,
            "Revise the structured Plan Contract to satisfy this request. Use todo.write with the current revision; preserve unchanged scope, and do not modify files, run processes, or call MCP.",
            "If the requested change affects files, commands, dependencies, acceptance criteria, or external actions, the previous approval must be considered stale and will be invalidated by the host.",
          ].join("\n"),
        };
      }
      if (intent.action === "approve") {
        const result = session.approveTodo("slash", strategy);
        ui.text(result.ok ? `Plan revision ${result.state.revision} approved (${strategy}); digest ${result.state.approval?.digest ?? "unknown"}.` : result.message);
        return "continue";
      }
      const result = await session.preparePlanExecution(strategy, "slash");
      if (!result.ok) {
        ui.text(result.message);
        for (const blocker of result.blockers ?? []) ui.text(`  blocker: ${blocker}`);
        return "continue";
      }
      ui.text(`Executing approved Plan (${strategy}).`);
      return { kind: "execute_plan", directive: result.directive };
    }

    case "set_mode": {
      const current = session.viewModel.modeState;
      if (intent.mode === undefined) {
        ui.openOverlay("status", [
          `Mode       ${current.selected.toUpperCase()}`,
          ...(current.pending === undefined ? [] : [`Pending    ${current.pending.toUpperCase()} next turn`]),
          "",
          "Shift+Tab or /mode build|plan switches the interaction mode.",
        ]);
        return "continue";
      }
      const result = await session.requestInteractionMode(intent.mode, "slash");
      if (result.kind === "unchanged") {
        ui.status(session.viewModel);
        return "continue";
      }
      if (intent.save) {
        const saved = await setUserConfigValue(context.host, "agent.interactionMode", intent.mode);
        const error = saved.issues.find((issue) => issue.severity === "error");
        if (error !== undefined) ui.text(`Mode changed for this session but was not saved: ${error.message}`);
      }
      return "continue";
    }

    case "compact": {
      const result = session.compactContext({ userRequested: true });
      if (result === undefined) {
        ui.text("Nothing to compact yet.");
        return "continue";
      }
      ui.text(
        `Compacted ${result.eventsSummarized} event(s): ${result.tokensBefore} →${result.tokensAfter} estimated tokens (${result.trigger}).`,
      );
      ui.text("Original journal events were retained.");
      return "continue";
    }
    case "export": {
      ui.text(`Run \`capy session export ${session.viewModel.sessionId} --format ${intent.format}\`.`);
      return "continue";
    }

    case "overlay":
      // §19.3: an overlay is a *lens* over state the session already holds, so in
      // plain mode the same content is printed inline. Pickers use the host's
      // keyboard select surface when one is available, while the remaining overlays
      // render their read-only contents inline.
      return await handleOverlay(context, ui, boot, intent.overlay);

    case "resume": {
      const id = intent.id?.trim();
      if (id === undefined || id.length === 0) {
        ui.text("Choose a session from the /resume popup.");
        return "continue";
      }
      return { kind: "resume", id };
    }

    case "unknown": {
      context.warn(`unknown command '${intent.name}'`);
      if (intent.suggestions.length > 0) {
        context.warn(`did you mean: ${intent.suggestions.slice(0, 5).join(", ")}`);
      }
      return "continue";
    }

    case "not_slash":
      return "continue";
  }
}

/**
 * Open an overlay (§6.17, §19.3).
 *
 * P0-07: the content is built as a document first, then handed to
 * `ui.openOverlay`, which renders it as a real overlay in the full-screen
 * renderer and prints it inline in append-only mode. Routing it through
 * `ui.text` instead lost everything past the notice queue's third line.
 */
async function handleOverlay(
  context: CommandContext,
  ui: InteractiveUi,
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  overlay: string,
): Promise<SlashOutcome> {
  const session = boot.session;

  switch (overlay) {
    case "details": {
      const lines: string[] = [];
      for (const item of session.viewModel.timeline.slice(-200)) {
        const record = item as unknown as Record<string, unknown>;
        const owner =
          typeof record.agentId === "string" ? record.agentId : "root";
        const detail = [
          record.toolId,
          record.argumentsSummary,
          record.state,
          record.summary,
          record.text,
        ].find((value): value is string =>
          typeof value === "string" && value.length > 0);
        lines.push(
          `${String(item.sequence).padStart(6)}  ${owner.padEnd(10)} ${item.type.padEnd(14)} ${detail ?? ""}`,
        );
        if (item.type === "task") {
          for (const event of item.subagentEvents) {
            lines.push(
              `${String(event.sequence).padStart(6)}  ${item.role.padEnd(10)} tool           ${event.toolId} ${event.argumentsSummary} [${event.status}]`,
            );
          }
        }
      }
      ui.openOverlay("details", lines.length > 0 ? lines : ["No transcript events yet."]);
      return "continue";
    }

    case "skills": {
      ui.openOverlay("skills", [...renderSkillList(session.skills.catalog())]);
      return "continue";
    }

    case "context": {
      const { renderContextInspection } = await import("@cbc/context-engine");
      const inspection = session.inspectContext();
      ui.openOverlay("context", [
        ...renderContextUsage(session.viewModel.contextUsage, ui.blockContext).map(lineText),
        ...renderContextInspection(inspection),
      ]);
      return "continue";
    }

    case "todo": {
      ui.openOverlay("todo", renderTodoList(session.viewModel.todo, ui.blockContext));
      return "continue";
    }

    case "diff": {
      try {
        const runtime = await context.runtime();
        const diff = (await runtime.gitDiff({})) as {
          files?: Array<{ path: string; additions: number; deletions: number }>;
          totalAdditions?: number;
          totalDeletions?: number;
        };
        const files = diff.files ?? [];
        if (files.length === 0) {
          ui.openOverlay("diff", ["No changes in the working tree."]);
          return "continue";
        }
        const lines = files.map(
          (file) => `  ${file.path}  +${file.additions} -${file.deletions}`,
        );
        lines.push(
          `  ${files.length} file(s), +${diff.totalAdditions ?? 0} -${diff.totalDeletions ?? 0}`,
        );
        ui.openOverlay("diff", lines);
      } catch (error) {
        context.warn(error instanceof Error ? error.message : String(error));
      }
      return "continue";
    }

    case "jobs": {
      const model = session.viewModel;
      if (model.activeTasks.length === 0 && model.activeJobs.length === 0) {
        ui.openOverlay("jobs", ["No active tasks or background jobs."]);
        return "continue";
      }
      const lines = model.activeTasks.map(
        (task) => `  task ${task.taskId}  ${task.role}  ${task.state}  ${task.goal}`,
      );
      for (const job of model.activeJobs) {
        lines.push(`  job  ${job.jobId}  ${job.state}  ${job.display}`);
      }
      ui.openOverlay("jobs", lines);
      return "continue";
    }

    case "agents": {
      const lines = ["Built-in roles (§15.2):"];
      for (const role of SUBAGENT_ROLES) {
        const definition = roleDefinition(role);
        lines.push(
          `  ${role.padEnd(9)} ${definition.permissionClass.padEnd(8)} ${definition.description}`,
        );
      }
      ui.openOverlay("agents", lines);
      return "continue";
    }

    case "mcp": {
      const loaded = await context.config();
      const servers = Object.entries(loaded.config.mcpServers);
      if (servers.length === 0) {
        ui.openOverlay("mcp", ["No MCP servers are configured."]);
        return "continue";
      }
      ui.openOverlay(
        "mcp",
        servers.map(
          ([name, config]) =>
            `  ${name}  ${config.transport}  ${config.enabled === false ? "disabled" : "enabled"}`,
        ),
      );
      return "continue";
    }

    case "sessions": {
      try {
        const runtime = await context.runtime();
        const { sessions } = await runtime.listSessions({ limit: 15 });
        const entries = [...sessions]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .slice(0, 15);
        if (entries.length === 0) {
          ui.openOverlay("sessions", ["No sessions recorded for this workspace."]);
          return "continue";
        }
        ui.openOverlay(
          "sessions",
          entries.map((entry) => {
            const marker = entry.id === session.viewModel.sessionId ? "*" : " ";
            return `${marker} ${entry.id}  ${entry.state.padEnd(11)}  ${entry.title}`;
          }),
        );
      } catch {
        ui.openOverlay("sessions", ["Session list is unavailable."]);
      }
      return "continue";
    }

    case "model_picker": {
      const current = session.viewModel.modelId;
      const lines = [`Model choices (current: ${current}):`];
      for (const model of MODEL_REGISTRY) {
        const aliases = model.aliases.length > 0 ? " (" + model.aliases.join(", ") + ")" : "";
        const active = model.id === current ? " [current]" : "";
        lines.push("  " + model.id + active + aliases);
      }
      lines.push("Type /model followed by a choice, then press Tab.");
      ui.openOverlay("model_picker", lines);
      return "continue";
    }

    case "reasoning_picker":
      ui.openOverlay("reasoning_picker", [
        "Use `/effort <none|low|medium|high|xhigh|max>` or `/effort <standard|pro>`.",
      ]);
      return "continue";

    case "command_palette":
    case "help":
    default: {
      const lines = ["Slash commands:"];
      for (const command of slashCompletions("")) {
        lines.push(`  ${command.value.padEnd(12)} ${command.detail}`);
      }
      ui.openOverlay("help", lines);
      return "continue";
    }
  }
}
