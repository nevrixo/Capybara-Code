/**
 * Session bootstrap — PRD §7.1, §7.8, §16.2, §18.3, §18.6.
 *
 * The interactive and headless entry points need the same nine things wired in the
 * same order, so that order lives here once. §7.1 fixes the sequence: capabilities,
 * workspace, trust, auth, model registry, *paint*, then the repository map and update
 * check in the background. The expensive steps are therefore separated from the cheap
 * ones — `bootstrapSession` does the cheap ones, and `warmContext` is what a caller
 * defers.
 */

import { join } from "node:path";

import {
  REPOSITORY_MAP_CACHE_MAX_BYTES,
  parseRepositoryMapCache,
} from "@cbc/context-engine";
import type { ConfigPermissionRule } from "@cbc/config-schema";
import { mcpActionArgumentsHash, type StoredRule } from "@cbc/permissions";
import { EVENT_SCHEMA_VERSION, isKnownEventKind, type CbcEvent } from "@cbc/protocol";
import {
  InferenceUtilityController,
  chatGptCodexCapability,
  findModel,
  inputContextBudget,
  snapshotDescriptor,
} from "@cbc/provider-openai";
import {
  emptyViewModel,
  DEFAULT_SESSION_PAGE_BYTES,
  DEFAULT_SESSION_PAGE_ITEMS,
  iterateReplayTailPages,
  parseSnapshotEnvelope,
  loadEarlierJournalPage,
  reduce,
  ResidentJournalWindow,
  validateSessionJournalPage,
  type JournalPageCursor,
  type SessionHydrationPosition,
  type SessionJournalPage,
  type StoredSnapshotEnvelope,
  type SessionViewModel,
  type TimelineItem,
} from "@cbc/session-domain";
import { builtinSkillFiles } from "@cbc/skills";

import {
  AgentSession,
  HostInstructionReader,
  parseAgentSessionSnapshot,
  shouldAutoRoute,
  type AgentSessionSnapshotSeed,
} from "./agent.ts";
import { readAuthMode } from "./auth-mode.ts";
import { GrantedRules } from "./approvals.ts";
import {
  createApprovalBroker,
  type InteractiveBrokerOptions,
} from "./approvals.ts";
import type { CommandContext } from "./commands/context.ts";
import { discoverSkillFiles, skillRoots } from "./commands/skills.ts";
import { resolveAccountSession, resolveCredential } from "./credentials.ts";
import { workspaceIdentityFor } from "./host.ts";
import { buildProvider, installationId, safetyIdentifierFor } from "./provider.ts";
import {
  repositoryGitIdentityFromStatus,
  repositoryMapCachePath,
  scanRepository,
  writeRepositoryScanCache,
  type RepositoryScanResult,
} from "./repository-map.ts";
import { appendApprovalRule, readApprovalRules } from "./rules-store.ts";
import type { Runtime, RuntimeSessionSummary } from "./runtime.ts";
import { LspHost, type LspServiceStatus } from "./lsp-host.ts";
import { DeferredMcpHost } from "./mcp-host.ts";
import {
  newSessionId,
  readSessionIndex,
  sessionIndexPath,
  writeSessionIndex,
  type SessionIndex,
} from "./state.ts";
import type { ToolBridges } from "./tools.ts";

export interface BootstrapOptions {
  readonly context: CommandContext;
  /** Session overrides from CLI flags, applied over the config (§21.2). */
  readonly overrides?: {
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly reasoningMode?: string;
    readonly permissionMode?: string;
    readonly interactionMode?: "build" | "plan";
    readonly permissionPreset?: "read" | "edit" | "auto" | "yolo";
    readonly reviewMode?: "off" | "auto";
  };
  readonly readOnly?: boolean;
  readonly headlessPolicy?: "deny-on-ask" | "allow-listed" | "fail-on-ask";
  /** `--resume <id|last>`. */
  readonly resume?: string;
  readonly onEvent?: (event: CbcEvent, model: SessionViewModel) => void;
  /** Receives live Python and TypeScript LSP states for an interactive sidebar. */
  readonly onLspStatus?: (servers: readonly LspServiceStatus[]) => void;
  /** Present only for interactive runs; its absence selects the headless broker. */
  readonly interactiveApprovals?: Omit<InteractiveBrokerOptions, "granted">;
  /** Optional UI-owned tool surfaces, such as a full-screen `user.ask` card. */
  readonly bridges?: ToolBridges;
}

export interface Bootstrapped {
  readonly session: AgentSession;
  readonly runtime: Runtime;
  readonly sessionId: string;
  readonly granted: GrantedRules;
  readonly credentialSource: string;
  readonly mockedProvider: boolean;
  readonly resumedFrom?: RuntimeSessionSummary;
  readonly warnings: string[];
  /** Managed Python and TypeScript language-server lifecycle for this session. */
  readonly lspHost: LspHost;
  /** Loads and projects one immutable page preceding the resident session history. */
  readonly loadEarlierHistory?: () => Promise<readonly TimelineItem[] | undefined>;
  /** P0-15: shut down any MCP server children for this session. */
  dispose?: () => Promise<void>;
}

/**
 * One-shot import of the legacy host session index into the runtime store (P0-05).
 *
 * Older builds kept `<data>/sessions/index.json`; the durable store is now the single
 * authority. Entries this workspace owns are re-created as session rows (their events,
 * if any, already live in SQLite), and the file is archived so the import runs once.
 * Entries belonging to other workspaces stay in the file until those workspaces import
 * them, so nothing is dropped.
 */
async function migrateHostSessionIndex(
  context: CommandContext,
  runtime: Runtime,
): Promise<void> {
  const index = await readSessionIndex(context.host, context.paths);
  if (index.sessions.length === 0) return;

  const workspaceKey = context.workspacePath.replace(/\\/g, "/").toLowerCase();
  const owned = index.sessions.filter(
    (entry) => entry.workspacePath.replace(/\\/g, "/").toLowerCase() === workspaceKey,
  );
  if (owned.length === 0) return;

  const existing = new Set(
    (await runtime.listSessions({ limit: 10_000, all: true })).sessions.map((s) => s.id),
  );

  for (const entry of owned) {
    if (existing.has(entry.id)) continue;
    try {
      await runtime.openSession({
        sessionId: entry.id,
        title: entry.title,
        modelProfile: "auto",
        permissionMode: "auto-review",
      });
      if (entry.state !== "active") {
        await runtime.setSessionStatus(entry.id, entry.state);
      }
    } catch {
      // A failed import must not block the run; the entry simply stays in the
      // legacy file until the next attempt.
    }
  }

  // Archive what this workspace owned; keep any foreign entries around.
  const remaining: SessionIndex = {
    version: 1,
    sessions: index.sessions.filter(
      (entry) => entry.workspacePath.replace(/\\/g, "/").toLowerCase() !== workspaceKey,
    ),
  };
  if (remaining.sessions.length === 0) {
    await context.host.fs.remove(sessionIndexPath(context.paths)).catch(() => undefined);
  } else {
    await writeSessionIndex(context.host, context.paths, remaining);
  }
}

/** Resolve `--resume <id|prefix|last|title>` against the durable store (P0-05). */
async function resolveResumedSession(
  runtime: Runtime,
  selector: string,
): Promise<RuntimeSessionSummary | undefined> {
  try {
    const resolved = await runtime.resolveSession({ selector });
    if (resolved.session !== undefined) return resolved.session;
    // Ambiguous prefixes/titles intentionally do not pick a session. The
    // bounded candidate list is useful to diagnostics without loading 10,000 rows.
    return undefined;
  } catch {
    // Older sidecars do not expose session.resolve yet. Keep a bounded, compatible
    // fallback while avoiding the previous unbounded list RPC on the hot path.
    const { sessions } = await runtime.listSessions({ limit: 128 });
    if (selector === "last") return sessions[0];
    const exact = sessions.find((session) => session.id === selector);
    if (exact !== undefined) return exact;
    const byTitle = sessions.find((session) => session.title === selector);
    if (byTitle !== undefined) return byTitle;
    const prefixes = sessions.filter(
      (session) => session.id.startsWith(selector) || session.title.startsWith(selector),
    );
    return prefixes.length === 1 ? prefixes[0] : undefined;
  }
}

/**
 * Bring up a session.
 *
 * Note the ordering of trust and config: the caller has already resolved trust (§7.1
 * step 3) before this runs, and `context.requireConfig()` reads it. Doing config first
 * would let an untrusted project's `config.toml` influence the run that was supposed
 * to gate it.
 */
export async function bootstrapSession(options: BootstrapOptions): Promise<Bootstrapped> {
  const context = options.context;
  const warnings: string[] = [];

  const runtime = await context.runtime();
  const loadedConfig = await context.config();
  const config = await context.requireConfig();
  const trust = await context.trust();

  // ---- §21.2: session overrides sit above config ----
  // Work on a session-local clone: the effective budget is model-dependent and
  // must not mutate the cached user/project configuration object.
  const effective = structuredCloneConfig(applyOverrides(config, options.overrides));
  const directModelOverride =
    options.overrides?.model !== undefined && !options.overrides.model.startsWith("profile:");
  // `model.default` is the visible fallback for the auto profile. Once a user
  // changes it to another model, that choice is explicit and must not be
  // replaced by the router on the first submitted turn.
  const autoRoute = shouldAutoRoute(effective.model, directModelOverride);
  const modelBudget = inputContextBudget(
    findModel(effective.model.default),
    effective.model.maxOutputTokens,
  );
  if (modelBudget !== undefined) {
    const configuredBudget = loadedConfig.provenance["model.softContextTokens"];
    // The historical 96K value remains a valid explicit preference. When the
    // setting is absent, use the model's safe input capacity (window minus its
    // maximum output) so the gauge and compaction policy match the active model.
    effective.model.softContextTokens =
      configuredBudget === undefined
        ? modelBudget
        : Math.min(effective.model.softContextTokens, modelBudget);
  }

  // ---- §9.2 credential, then the provider ----
  //
  // Two shapes, one per §9.5 auth surface. Account mode resolves its token directly
  // rather than through §9.2 precedence, so a stored API key cannot quietly
  // take over a session the user put in account mode and move the billing with it.
  const authMode = await readAuthMode(context.host, context.paths);
  const account =
    authMode === "account"
      ? await resolveAccountSession({
          runtime,
          host: context.host,
          paths: context.paths,
          env: context.host.env,
          now: () => context.host.now(),
        })
      : undefined;
  const credential =
    authMode === "account"
      ? undefined
      : await resolveCredential({
          runtime,
          env: context.host.env,
          host: context.host,
          paths: context.paths,
          now: () => context.host.now(),
        });
  const chatGptCodex = account?.protocol === "chatgpt";
  const accountCapability = chatGptCodex
    ? chatGptCodexCapability(effective.model.default)
    : undefined;
  if (accountCapability !== undefined) {
    // A ChatGPT/Codex account uses the account backend envelope instead of the
    // public API model profile. Override the earlier generic model calculation
    // so the sidebar and compaction policy share the real 272K input budget.
    const accountModelBudget = inputContextBudget(
      snapshotDescriptor(accountCapability),
      effective.model.maxOutputTokens,
    );
    if (accountModelBudget !== undefined) {
      const configuredBudget = loadedConfig.provenance["model.softContextTokens"];
      effective.model.softContextTokens =
        configuredBudget === undefined
          ? accountModelBudget
          : Math.min(effective.model.softContextTokens, accountModelBudget);
    }
  }

  const inferencePolicy =
    chatGptCodex
      ? new InferenceUtilityController({
          strategy: effective.model.router.strategy,
          targetLatencyMs: effective.model.router.targetLatencyMs,
          defaultModel: effective.model.router.defaultTier,
          cheapModel: effective.model.router.cheapTier,
          escalationModel: effective.model.router.escalationTier,
          maxCostUsd: effective.model.router.maxCostUsdPerTurn,
          capabilityResolver: chatGptCodexCapability,
        })
      : undefined;
  const install = await installationId(context.host, context.paths.data);
  const choice = await buildProvider({
    host: context.host,
    ...(authMode !== undefined ? { authMode } : {}),
    ...(account !== undefined
      ? {
          credential: account.lease,
          credentialSource: account.source,
          // §9.6 criterion 5: the token is only valid against the URL its
          // registration names, so that URL travels with the credential.
          baseUrl: account.baseUrl,
          accountProtocol: account.protocol,
          ...(account.accountId !== undefined ? { chatGptAccountId: account.accountId } : {}),
          ...(account.headers !== undefined ? { headers: account.headers } : {}),
        }
      : {}),
    ...(credential !== undefined
      ? { credential: credential.lease, credentialSource: credential.source }
      : {}),
    ...(options.readOnly === true || effective.agent.permissionMode === "plan"
      ? { readOnly: true }
      : {}),
    safetyIdentifier: safetyIdentifierFor(install),
    transport: effective.provider.openai.transport,
    serviceTier: effective.provider.openai.serviceTier,
    nativeCompaction: effective.model.context.providerCompaction,
    compactionThresholdTokens: effective.model.context.compactionThresholdTokens,
    enableToolSearch: effective.provider.openai.toolSearch,
  });

  // ---- §18.6 session identity (runtime store is the single authority, P0-05) ----
  await migrateHostSessionIndex(context, runtime);
  const resumedFrom =
    options.resume !== undefined
      ? await resolveResumedSession(runtime, options.resume)
      : undefined;
  if (options.resume !== undefined && resumedFrom === undefined) {
    // §7.8: a missing session is reported, not silently replaced by a new one — the
    // user asked to continue specific work.
    warnings.push(`no session matched '${options.resume}'; starting a new session`);
  }
  const sessionId = resumedFrom?.id ?? newSessionId(context.host.now());

  // ---- §13.3 policy inputs ----
  // P0-13: persisted "Always allow" grants are loaded once and feed the policy
  // engine for every run — interactive or headless — via `configRules`.
  // P0-01: a grant only applies to the workspace that earned it. The identity
  // is computed here once; the store filters on it, and new grants are bound
  // to it when they are persisted.
  const workspaceIdentity = await workspaceIdentityFor(context.host, context.workspacePath);
  const loadedRules = await readApprovalRules(context.host, context.paths, workspaceIdentity);
  if (loadedRules.disabledLegacyAllows > 0) {
    warnings.push(
      `${loadedRules.disabledLegacyAllows} older "always allow" grant(s) had no workspace binding and were disabled; re-approve them in the project they were meant for`,
    );
  }
  const persistedRules = loadedRules.rules;
  // P0-13: declarative `[permissions.rules]` from config are merged with the
  // persisted grants. They are scoped to the project, and the engine re-checks
  // workspace trust before honouring them, so a rule cannot grant anything in
  // an untrusted workspace.
  const configRules = configPermissionRulesToStored(effective.permissions.rules);
  const granted = new GrantedRules();
  const approvals = createApprovalBroker({
    nonInteractive: context.nonInteractive || options.interactiveApprovals === undefined,
    ...(options.headlessPolicy !== undefined ? { headlessPolicy: options.headlessPolicy } : {}),
    ...(options.interactiveApprovals !== undefined
      ? {
          interactive: {
            ...options.interactiveApprovals,
            granted,
            persistRule: (rule) =>
              appendApprovalRule(
                context.host,
                context.paths,
                rule,
                context.host.now(),
                workspaceIdentity,
              ),
            diagnostic: (line) => context.warn(line),
          },
        }
      : {}),
    headless: { diagnostic: (line) => context.warn(line) },
  });

  const reasoningEffortLocked =
    options.overrides?.reasoningEffort !== undefined ||
    effective.model.profile !== "auto" ||
    loadedConfig.provenance["model.reasoningEffort"] !== undefined;

  // ---- §17 MCP servers: assemble the host and connect only when allowed ----
  // A project-defined server only launches in a trusted workspace (§17.5);
  // `DeferredMcpHost` encodes that gate itself. Build retains the eager startup
  // budget, while Plan gets a manager for local catalog inspection without
  // starting stdio or HTTP transports.
  const interactionMode = effective.agent.interactionMode ?? (effective.agent.permissionMode === "plan" ? "plan" : "build");
  let sessionForMcp: AgentSession | undefined;
  let sessionForLsp: AgentSession | undefined;
  const lspHost = new LspHost({
    runtime,
    sessionId,
    workspaceRoot: context.workspacePath,
    workspaceTrusted: trust === "trusted-always" || trust === "trusted-once",
    readFile: async (path) => {
      const parts = path.split("/");
      if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
        return undefined;
      }
      return await context.host.fs.read(join(context.workspacePath, ...parts));
    },
    isBuildMode: () =>
      (sessionForLsp?.recorder.model.modeState.selected ??
        (resumedFrom === undefined ? interactionMode : "plan")) === "build",
    ...(options.onLspStatus !== undefined ? { onStatus: options.onLspStatus } : {}),
  });
  const mcpHost =
    Object.keys(effective.mcpServers).length > 0
      ? await DeferredMcpHost.create({
          servers: effective.mcpServers,
          workspaceRoot: context.workspacePath,
          clientVersion: context.version,
          runtime,
          sessionId,
          resolveEnv: (name) => context.host.env[name],
          workspaceTrusted: trust === "trusted-always" || trust === "trusted-once",
          // Provenance is field-granular. Treat a server as project-owned if
          // any of its effective fields came from the project layer; checking
          // only transport lets an untrusted project override command/URL/env
          // beneath a user-owned transport declaration.
          fromProjectConfig: (name) => Object.entries(loadedConfig.provenance).some(([key, source]) =>
            source === "project" && key.startsWith(`mcpServers.${name}.`)),
          now: () => context.host.now(),
          // A resumed session's durable mode is not known until its journal is
          // replayed. Fail closed to Plan so resume cannot launch MCP transports
          // before we inspect the selected mode; Build resumes activate below.
          initialMode: resumedFrom === undefined ? interactionMode : "plan",
          interactionMode: () => sessionForMcp?.recorder.model.modeState.selected ?? (resumedFrom === undefined ? interactionMode : "plan"),
          activationPolicy: (action) => {
            if (sessionForMcp === undefined) return resumedFrom === undefined && interactionMode === "build" ? "eager" : "deny";
            const permission = sessionForMcp.permissionContext();
            if (permission.planExecutionRequired !== true) return "eager";
            // Approval alone is not an execution grant. Only the one-shot
            // directive installed by /plan execute may activate a transport.
            if (permission.planExecutionActive !== true) return "deny";
            // Drafted/approved Plans may inspect only the cached catalog. A
            // declared MCP operation connects its target server lazily, never
            // every configured server via connectAll().
            if (permission.approvedPlan === undefined) return "deny";
            if (action.toolId === "mcp.search") return "target";
            const server = action.mcp?.server ?? (typeof action.arguments.server === "string" ? action.arguments.server : "");
            const tool = action.mcp?.tool ?? (typeof action.arguments.tool === "string" ? action.arguments.tool : typeof action.arguments.uri === "string" ? action.arguments.uri : "");
            return permission.approvedPlan.externalActions?.some((entry) =>
              entry.server === server &&
              entry.tool === tool &&
              (entry.argumentsHash === undefined || entry.argumentsHash === mcpActionArgumentsHash(action))
            ) === true ? "target" : "deny";
          },
        })
      : undefined;
  if (interactionMode === "plan" && Object.keys(effective.mcpServers).length > 0) {
    warnings.push("Plan mode: MCP execution is disabled; only local catalog inspection is available.");
  }
  if (mcpHost !== undefined) {
    const reported = new Set<string>();
    for (const failure of mcpHost.failures) {
      const line = `MCP server '${failure.server}': ${failure.error}`;
      reported.add(line);
      warnings.push(line);
    }
    // A slow handshake finishes after `warnings` has already been returned. Route
    // those later failures through the active diagnostic sink rather than losing
    // them or extending startup to wait for every external process/network.
    void mcpHost.ready.then(() => {
      for (const failure of mcpHost.failures) {
        const line = `MCP server '${failure.server}': ${failure.error}`;
        if (reported.has(line)) continue;
        reported.add(line);
        context.warn(line);
      }
    });
  }

  const session = new AgentSession({
    host: context.host,
    runtime,
    config: effective,
    autoRoute,
    ...(inferencePolicy !== undefined ? { inferencePolicy } : {}),
    ...(reasoningEffortLocked ? { reasoningEffortLocked: true } : {}),
    workspacePath: context.workspacePath,
    workspaceIdentityDigest: workspaceIdentity.workspaceDigest,
    trust,
    sessionId,
    provider: choice.provider,
    approvals,
    granted,
    nonInteractive: context.nonInteractive,
    ...(options.bridges !== undefined ? { bridges: options.bridges } : {}),
    ...(mcpHost !== undefined
      ? {
          mcpBridge: mcpHost.bridge,
          mcpHint: (server: string, tool: string) => {
            const descriptor = mcpHost.manager.catalog.find(server, tool);
            if (descriptor === undefined) return undefined;
            const claimedReadOnly = descriptor.annotations?.readOnlyHint;
            return {
              sideEffectHint: descriptor.risk,
              ...(typeof claimedReadOnly === "boolean"
                ? { annotatedReadOnly: claimedReadOnly }
                : {}),
            };
          },
        }
      : {}),
    beforeInteractionMode: async (target) => {
      if (target !== "plan") return;
      await lspHost.quiesce();
      await mcpHost?.quiesce?.();
    },
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.headlessPolicy !== undefined ? { headlessPolicy: options.headlessPolicy } : {}),
    configRules: [...configRules, ...persistedRules],
    globalInstructionReader: {
      read: async (path) => {
        const base = context.paths.config.replace(/\/+$/, "");
        const full = `${base}/${path.replace(/^\/+/, "")}`;
        try {
          return await context.host.fs.read(full);
        } catch {
          return undefined;
        }
      },
    },
    onEvent: (event, model) => {
      if (event.kind === "mode.changed" && model.modeState.selected === "build") {
        void lspHost.resume().catch(() => context.warn("LSP indexing could not resume"));
      }
      options.onEvent?.(event, model);
    },
    onJournalError: (_event, error) => {
      context.warn(
        `journal append failed; resume may be incomplete: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    now: () => context.host.now(),
    ...(resumedFrom !== undefined ? { startAfterSequence: 0 } : {}),
  });
  sessionForMcp = session;
  sessionForLsp = session;

  // ---- §16.2 Skills, catalog only (stage 1) ----
  const discovered = await discoverSkillFiles(
    context.host,
    skillRoots(context.host, context.workspacePath, context.paths.share),
    { workspaceTrusted: trust === "trusted-always" || trust === "trusted-once" },
  );
  const registered = session.skills.register([...builtinSkillFiles(), ...discovered]);
  for (const issue of registered.issues) {
    warnings.push(`skill ${issue.path}: ${issue.field}: ${issue.message}`);
  }

  // ---- §18.2 project instructions, trust-gated ----
  await session.context.loadInstructions({
    trusted: trust === "trusted-always" || trust === "trusted-once",
  });

  // Open the provider transport as soon as skills/instructions are available;
  // resume tail hydration and repository orientation can overlap this handshake.
  void session.prewarmProvider().catch(() => undefined);
  // ---- §18.6 the durable session row is created by `session.open` below; there is
  // no host-side index to keep in sync any more (P0-05). ----

  // §18.6: the session row must exist before any event is appended, so this is awaited
  // rather than fired off.
  const opened = await session.open({
    resumed: resumedFrom !== undefined,
    workspacePath: context.workspacePath,
    title: resumedFrom?.title ?? "Untitled session",
    // A resumed event must be sequenced after the replayed journal, otherwise it
    // can appear before the conversation it is meant to describe.
    emitEvent: resumedFrom === undefined,
  });
  if (!opened.ok) {
    warnings.push(`session journal unavailable, so resume will be incomplete: ${opened.detail}`);
  }

  const resumeDescriptor = opened.ok && config.perf.longSessionFastPath !== false
    ? parseResumeOpenDescriptor(opened.descriptor, sessionId)
    : undefined;
  let loadEarlierHistory: (() => Promise<readonly TimelineItem[] | undefined>) =
    createEarlierHistoryLoader(runtime, sessionId);
  if (resumedFrom !== undefined) {
    try {
      const loaded = await loadSessionEvents(runtime, sessionId, resumeDescriptor);
      session.hydrate(loaded.events, {
        ...(loaded.seed !== undefined ? { seed: loaded.seed } : {}),
        ...(loaded.snapshotPosition !== undefined
          ? { snapshotPosition: loaded.snapshotPosition }
          : {}),
        finalPosition: loaded.finalPosition,
      });
      // A resumed journal is authoritative for the selected interaction mode;
      // synchronize the Rust enforcement state after replay, not just at open.
      await runtime.setInteractionMode(session.viewModel.modeState.selected);
      if (session.viewModel.modeState.selected === "build" && mcpHost !== undefined) {
        // Build resumes are allowed to reconnect, but only after journal replay
        // has established that this is actually a Build session.
        void mcpHost.activate();
      }
      if (loaded.earliestLoadedPage?.earlierPage !== undefined) {
        loadEarlierHistory = createEarlierHistoryLoader(
          runtime,
          sessionId,
          loaded.earliestLoadedPage,
        );
      }
      if (loaded.integrityOk === false) {
        warnings.push("session journal integrity failed; resumed only the valid prefix");
      }
      session.emit("session.resumed", {
        sessionId,
        workspacePath: context.workspacePath,
        modelId: effective.model.default,
        permissionMode: effective.agent.permissionMode,
        reasoningEffort: effective.model.reasoningEffort,
        contextBudgetTokens: effective.model.softContextTokens,
        trust,
        detail: `Restored ${loaded.eventCount ?? loaded.events.length} prior event(s) and conversation history.`,
      });
    } catch (error) {
      warnings.push(
        `session history could not be restored: ${error instanceof Error ? error.message : String(error)}`,
      );
      session.emit("session.resumed", {
        sessionId,
        workspacePath: context.workspacePath,
        modelId: effective.model.default,
        permissionMode: effective.agent.permissionMode,
        reasoningEffort: effective.model.reasoningEffort,
        contextBudgetTokens: effective.model.softContextTokens,
        trust,
        detail: "Session resumed without prior event history.",
      });
    }
  }

  return {
    session,
    lspHost,
    runtime,
    sessionId,
    granted,
    credentialSource: choice.credentialSource,
    mockedProvider: choice.mocked,
    ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    warnings,
    ...(loadEarlierHistory !== undefined ? { loadEarlierHistory } : {}),
    dispose: async () => {
      try {
        await session.close();
      } finally {
        await Promise.all([lspHost.close(), mcpHost?.close()]);
      }
    },
  };
}

interface ResumeOpenDescriptor {
  readonly snapshot?: StoredSnapshotEnvelope;
  readonly integrityOk: boolean;
  readonly replay?: {
    readonly afterJournalSequence: number;
    readonly afterHash: string;
    readonly throughJournalSequence: number;
    readonly throughHash: string;
  };
}

function parseResumeOpenDescriptor(
  raw: unknown,
  sessionId: string,
): ResumeOpenDescriptor | undefined {
  if (!isRecord(raw)) return undefined;
  const replayRaw = isRecord(raw.replay) ? raw.replay : undefined;
  let replay: ResumeOpenDescriptor["replay"] | undefined;
  if (replayRaw !== undefined) {
    const afterJournalSequence = replayRaw.afterJournalSequence;
    const throughJournalSequence = replayRaw.throughJournalSequence;
    const afterHash = replayRaw.afterHash;
    const throughHash = replayRaw.throughHash;
    if (
      typeof afterJournalSequence !== "number" || !Number.isSafeInteger(afterJournalSequence) || afterJournalSequence < 0 ||
      typeof throughJournalSequence !== "number" || !Number.isSafeInteger(throughJournalSequence) || throughJournalSequence < afterJournalSequence ||
      typeof afterHash !== "string" || afterHash.length === 0 ||
      typeof throughHash !== "string" || throughHash.length === 0
    ) return undefined;
    replay = {
      afterJournalSequence,
      afterHash,
      throughJournalSequence,
      throughHash,
    };
  }
  let snapshot: StoredSnapshotEnvelope | undefined;
  if (raw.snapshot !== undefined && raw.snapshot !== null) {
    try {
      snapshot = parseSnapshotEnvelope(raw.snapshot, { expectedSessionId: sessionId });
    } catch {
      // A malformed descriptor must never turn a resume request into an unsafe
      // partial replay. Let the caller use the legacy genesis-replay path.
      return undefined;
    }
  }
  const integrity = isRecord(raw.integrity) ? raw.integrity : undefined;
  return {
    ...(snapshot !== undefined ? { snapshot } : {}),
    integrityOk: integrity?.ok !== false,
    ...(replay !== undefined ? { replay } : {}),
  };
}

interface LoadedSessionEvents {
  readonly events: CbcEvent[];
  readonly integrityOk: boolean;
  readonly eventCount?: number;
  readonly seed?: AgentSessionSnapshotSeed;
  readonly snapshotPosition?: SessionHydrationPosition;
  readonly finalPosition: SessionHydrationPosition;
  readonly earlierPage?: JournalPageCursor;
  readonly earliestLoadedPage?: SessionJournalPage;
}

interface CollectedSessionTail {
  readonly events: CbcEvent[];
  readonly snapshot?: StoredSnapshotEnvelope;
  readonly integrityOk: boolean;
  readonly eventCount?: number;
  readonly finalPosition: SessionHydrationPosition;
  readonly earlierPage?: JournalPageCursor;
  readonly earliestLoadedPage?: SessionJournalPage;
}

async function collectSessionTail(
  runtime: Runtime,
  sessionId: string,
  descriptor?: ResumeOpenDescriptor,
  overrideAfterJournalSequence?: number,
): Promise<CollectedSessionTail> {
  const events: CbcEvent[] = [];
  let snapshot: StoredSnapshotEnvelope | undefined =
    overrideAfterJournalSequence === undefined ? descriptor?.snapshot : undefined;
  let integrityOk = descriptor?.integrityOk ?? true;
  let eventCount: number | undefined;
  let earlierPage: JournalPageCursor | undefined;
  let earliestLoadedPage: SessionJournalPage | undefined;
  const replay = descriptor?.replay;
  const afterJournalSequence = overrideAfterJournalSequence ?? replay?.afterJournalSequence;
  const useDescriptorBoundary = replay !== undefined;
  let journalSequence = afterJournalSequence ?? 0;
  let streamSequence = snapshot?.streamSequence ?? snapshot?.journalSequence ?? 0;

  const transport = { load: async (params: Record<string, unknown>) =>
    await runtime.loadSession(params) };
  const replayOptions = {
    sessionId,
    ...(afterJournalSequence !== undefined ? { afterJournalSequence } : {}),
    ...(useDescriptorBoundary
      ? {
          tailOnly: false,
          includeSnapshot: false,
          ...(overrideAfterJournalSequence === undefined
            ? { afterHash: replay.afterHash }
            : { afterHash: "0".repeat(64) }),
          throughJournalSequence: replay.throughJournalSequence,
          throughHash: replay.throughHash,
        }
      : {}),
  } as const;
  for await (const page of iterateReplayTailPages(transport, replayOptions)) {
    snapshot ??= page.snapshot;
    earliestLoadedPage ??= page;
    earlierPage ??= page.earlierPage;
    const pageIntegrity = isRecord(page.integrity) ? page.integrity : undefined;
    if (pageIntegrity?.ok === false) integrityOk = false;
    if (eventCount === undefined && typeof page.eventCount === "number") {
      eventCount = page.eventCount;
    }
    if (streamSequence === 0 && page.snapshot !== undefined) {
      streamSequence = page.snapshot.streamSequence ?? page.snapshot.journalSequence;
      journalSequence = page.snapshot.journalSequence;
    }
    for (const stored of page.events) {
      journalSequence = stored.sequence;
      streamSequence = Math.max(
        streamSequence,
        stored.streamSequence ?? stored.sequence,
      );
      const event = restoreEvent(stored, sessionId);
      if (event !== undefined) events.push(event);
    }
    journalSequence = Math.max(journalSequence, page.page.through.sequence);
  }

  return {
    events,
    integrityOk,
    finalPosition: { journalSequence, streamSequence },
    ...(snapshot !== undefined ? { snapshot } : {}),
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(earlierPage !== undefined ? { earlierPage } : {}),
    ...(earliestLoadedPage !== undefined ? { earliestLoadedPage } : {}),
  };
}

export async function loadSessionEvents(
  runtime: Runtime,
  sessionId: string,
  descriptor?: ResumeOpenDescriptor,
): Promise<LoadedSessionEvents> {
  const tail = await collectSessionTail(runtime, sessionId, descriptor);
  const seed = tail.snapshot === undefined
    ? undefined
    : parseAgentSessionSnapshot(tail.snapshot.reducerState, sessionId);

  // Legacy/state-only snapshots cannot restore provider history. Replay the
  // complete immutable journal to the same frozen descriptor boundary.
  if (tail.snapshot !== undefined && seed === undefined) {
    const full = await collectSessionTail(runtime, sessionId, descriptor, 0);
    return {
      events: full.events,
      integrityOk: full.integrityOk,
      finalPosition: full.finalPosition,
      ...(full.eventCount !== undefined ? { eventCount: full.eventCount } : {}),
      ...(full.earlierPage !== undefined ? { earlierPage: full.earlierPage } : {}),
      ...(full.earliestLoadedPage !== undefined
        ? { earliestLoadedPage: full.earliestLoadedPage }
        : {}),
    };
  }

  return {
    events: tail.events,
    integrityOk: tail.integrityOk,
    finalPosition: tail.finalPosition,
    ...(tail.eventCount !== undefined ? { eventCount: tail.eventCount } : {}),
    ...(tail.earlierPage !== undefined ? { earlierPage: tail.earlierPage } : {}),
    ...(tail.earliestLoadedPage !== undefined
      ? { earliestLoadedPage: tail.earliestLoadedPage }
      : {}),
    ...(seed !== undefined && tail.snapshot !== undefined
      ? {
          seed,
          snapshotPosition: {
            journalSequence: tail.snapshot.journalSequence,
            streamSequence:
              tail.snapshot.streamSequence ?? tail.snapshot.journalSequence,
          },
        }
      : {}),
  };
}

export function createEarlierHistoryLoader(
  runtime: Runtime,
  sessionId: string,
  initialPage?: SessionJournalPage,
): () => Promise<readonly TimelineItem[] | undefined> {
  const transport = {
    load: async (params: Record<string, unknown>) => await runtime.loadSession(params),
  };
  let currentPage = initialPage;
  const historicalWindow = new ResidentJournalWindow<SessionJournalPage["events"][number]>({
    maxItems: 4_096,
    maxBytes: 16 * 1024 * 1024,
  });
  let exhausted = false;

  return async () => {
    if (exhausted) return undefined;
    let earlier: SessionJournalPage | undefined;
    if (currentPage === undefined) {
      // A live/new session has no bootstrap tail cursor. Read one O(1) probe to
      // freeze the current durable head, then page backward from head + 1.
      const probe = validateSessionJournalPage(
        await transport.load({
          sessionId,
          afterSequence: 0,
          limit: 1,
          maxBytes: 1,
        }),
        { expectedSessionId: sessionId },
      );
      const head = probe.page.journalHead;
      if (head.sequence === 0 || head.sequence >= Number.MAX_SAFE_INTEGER) {
        exhausted = true;
        return undefined;
      }
      earlier = validateSessionJournalPage(
        await transport.load({
          sessionId,
          beforeSequence: head.sequence + 1,
          throughSequence: head.sequence,
          throughHash: head.eventHash,
          limit: DEFAULT_SESSION_PAGE_ITEMS,
          maxBytes: DEFAULT_SESSION_PAGE_BYTES,
        }),
        { expectedSessionId: sessionId },
      );
    } else {
      earlier = await loadEarlierJournalPage(transport, sessionId, currentPage);
    }
    if (earlier === undefined) {
      exhausted = true;
      return undefined;
    }
    currentPage = earlier;
    historicalWindow.mergePage(earlier);
    let projected = emptyViewModel(sessionId);
    for (const stored of historicalWindow.items) {
      const event = restoreEvent(stored, sessionId);
      if (event !== undefined) projected = reduce(projected, event);
    }
    const omitted = historicalWindow.stats.omittedAfter;
    if (omitted === 0) return projected.timeline;
    return [
      ...projected.timeline,
      {
        type: "notice",
        id: `paged-history-omitted-${historicalWindow.stats.latestSequence ?? 0}`,
        sequence: (historicalWindow.stats.latestSequence ?? 0) + 1,
        level: "info",
        text: `… ${omitted} more recent durable event(s) omitted from the resident history window`,
      },
    ];
  };
}

export function restoreEvent(value: unknown, sessionId: string): CbcEvent | undefined {
  if (!isRecord(value)) return undefined;
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  // Reducer/event ordering uses the protocol stream sequence. The SQLite row
  // sequence is a separate dense durable position used only for paging.
  const sequence =
    typeof value.streamSequence === "number"
      ? value.streamSequence
      : typeof value.sequence === "number"
        ? value.sequence
        : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  if (
    kind === undefined ||
    !isKnownEventKind(kind) ||
    sequence === undefined ||
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    id === undefined ||
    timestamp === undefined
  ) {
    return undefined;
  }
  const event: Record<string, unknown> = {
    schemaVersion:
      typeof value.schemaVersion === "string" ? value.schemaVersion : EVENT_SCHEMA_VERSION,
    sequence,
    id,
    timestamp,
    sessionId,
    kind,
    level: typeof value.level === "string" ? value.level : "info",
    visibility: typeof value.visibility === "string" ? value.visibility : "timeline",
    durability: "journaled",
    payload: value.payload ?? {},
  };
  if (typeof value.turnId === "string") event.turnId = value.turnId;
  if (typeof value.agentId === "string") event.agentId = value.agentId;
  // P0-06: the v1.3 lineage fields survive a resume, so replayed history keeps its
  // attribution instead of collapsing into bare events.
  if (typeof value.callerId === "string") event.callerId = value.callerId;
  if (typeof value.taskEpochId === "string") event.taskEpochId = value.taskEpochId;
  if (typeof value.workspaceIdentityDigest === "string") {
    event.workspaceIdentityDigest = value.workspaceIdentityDigest;
  }
  if (typeof value.parentEventId === "string") event.parentEventId = value.parentEventId;
  if (typeof value.correlationId === "string") event.correlationId = value.correlationId;
  return event as unknown as CbcEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * §18.3's repository map, built after first paint.
 *
 * Failure is a warning rather than an error: §7.1 requires the TUI to be usable
 * before the scan lands, so a scan that never lands must leave the session working
 * with less information rather than not working.
 */
export interface WarmContextResult {
  readonly files: number;
  readonly cacheHit: boolean;
  readonly warning?: string;
  readonly state: "provisional" | "full";
  /** Present whenever a live walk continues without delaying the caller. */
  readonly refresh?: Promise<{ files: number; warning?: string }>;
}

export interface WarmContextOptions {
  /** Starts bounded symbol indexing once the authoritative scan has landed. */
  readonly lspHost?: LspHost;
}

export async function warmContext(
  context: CommandContext,
  session: AgentSession,
  options: WarmContextOptions = {},
): Promise<WarmContextResult> {
  const runtime = await context.runtime();
  const orientationStartedAt = context.host.now();
  const fullScanStartedAt = orientationStartedAt;
  if (session.performanceTelemetryEnabled) {
    session.emit("repository.orientation_started", { mode: session.orientationMode });
    session.emit("repository.full_scan_started", { mode: session.orientationMode });
  }
  // A reusable provider connection and repository discovery are independent.
  void session.prewarmProvider().catch(() => undefined);

  // Start all independent work immediately. Cached orientation or a short
  // progressive budget can release the first turn while the live scan continues.
  const scanGeneration = session.workspaceGeneration;
  const workspaceIdentityPromise = workspaceIdentityFor(context.host, context.workspacePath);
  const gitStatusPromise = runtime.gitStatus().catch(() => undefined);
  const scanPromise = scanRepository(runtime);
  void scanPromise.catch(() => undefined);

  const workspaceIdentity = await workspaceIdentityPromise;
  const cachePath = repositoryMapCachePath(context.paths.cache, workspaceIdentity.workspaceDigest);
  const cachedRawPromise = context.host.fs.readPrefix === undefined
    ? context.host.fs.read(cachePath).catch(() => undefined)
    : context.host.fs.readPrefix(cachePath, REPOSITORY_MAP_CACHE_MAX_BYTES).then(
        (result) => result?.truncated === true ? undefined : result?.content,
        () => undefined,
      );
  const [gitStatus, cachedRaw] = await Promise.all([gitStatusPromise, cachedRawPromise]);
  const cacheIdentity = {
    workspaceIdentityDigest: workspaceIdentity.workspaceDigest,
    git: repositoryGitIdentityFromStatus(gitStatus),
  };
  const cachedRecord = cacheIdentity.git.index === "unknown"
    ? undefined
    : parseRepositoryMapCache(cachedRaw, cacheIdentity);
  const cached: RepositoryScanResult | undefined = cachedRecord === undefined
    ? undefined
    : {
        files: cachedRecord.files,
        ...(cachedRecord.dirtyPaths.length > 0 ? { dirtyPaths: cachedRecord.dirtyPaths } : {}),
      };

  const refreshInput = {
    context,
    session,
    scanPromise,
    cachePath,
    cacheIdentity,
    scanGeneration,
    fullScanStartedAt,
    ...(options.lspHost !== undefined ? { lspHost: options.lspHost } : {}),
  } as const;

  if (cached !== undefined) {
    // Provisional orientation never becomes fresh L6 evidence; the live walk
    // below is the only path that promotes the repository map.
    session.context.ingestCachedScan(cached);
    const refresh = refreshRepositoryMap(refreshInput);
    session.trackRepositoryRefresh(refresh);
    void refresh.then((result) => {
      if (result.warning !== undefined) context.warn(result.warning);
    });
    if (session.performanceTelemetryEnabled) {
      session.emit("repository.orientation_completed", {
        state: "provisional",
        cacheHit: true,
        files: cached.files.length,
        durationMs: Math.max(0, context.host.now() - orientationStartedAt),
      });
    }
    return {
      files: cached.files.length,
      cacheHit: true,
      state: "provisional",
      refresh,
    };
  }

  const refresh = refreshRepositoryMap(refreshInput);
  session.trackRepositoryRefresh(refresh);
  if (session.orientationMode === "strict") {
    const result = await refresh;
    if (session.performanceTelemetryEnabled) {
      session.emit("repository.orientation_completed", {
        state: "full",
        cacheHit: false,
        files: result.files,
        durationMs: Math.max(0, context.host.now() - orientationStartedAt),
      });
    }
    return { ...result, cacheHit: false, state: "full" };
  }

  const settled = await Promise.race([
    refresh.then((result) => ({ kind: "full" as const, result })),
    new Promise<{ kind: "provisional" }>((resolve) => setTimeout(
      () => resolve({ kind: "provisional" }),
      75,
    )),
  ]);
  if (settled.kind === "full") {
    if (session.performanceTelemetryEnabled) {
      session.emit("repository.orientation_completed", {
        state: "full",
        cacheHit: false,
        files: settled.result.files,
        durationMs: Math.max(0, context.host.now() - orientationStartedAt),
      });
    }
    return { ...settled.result, cacheHit: false, state: "full" };
  }

  if (session.performanceTelemetryEnabled) {
    session.emit("repository.orientation_completed", {
      state: "provisional",
      cacheHit: false,
      files: 0,
      durationMs: Math.max(0, context.host.now() - orientationStartedAt),
    });
  }
  void refresh.then((result) => {
    if (result.warning !== undefined) context.warn(result.warning);
  });
  return { files: 0, cacheHit: false, state: "provisional", refresh };
}

async function refreshRepositoryMap(input: {
  readonly context: CommandContext;
  readonly session: AgentSession;
  readonly scanPromise: Promise<RepositoryScanResult>;
  readonly cachePath: string;
  readonly cacheIdentity: Parameters<typeof writeRepositoryScanCache>[2];
  readonly scanGeneration: number;
  readonly fullScanStartedAt: number;
  readonly lspHost?: LspHost;
}): Promise<{ files: number; warning?: string }> {
  const emitCompleted = (
    status: "completed" | "superseded" | "failed",
    files: number,
  ): void => {
    if (!input.session.performanceTelemetryEnabled) return;
    input.session.emit("repository.full_scan_completed", {
      status,
      files,
      durationMs: Math.max(0, input.context.host.now() - input.fullScanStartedAt),
    });
  };

  try {
    const scan = await input.scanPromise;
    if (!input.session.ingestRepositoryScan(scan, input.scanGeneration)) {
      emitCompleted("superseded", 0);
      return { files: 0, warning: "repository scan was superseded by a workspace mutation" };
    }
    if (input.lspHost !== undefined) {
      void input.lspHost
        .indexRepository(scan.files, input.session.context.repositoryIntelligence)
        .catch(() => input.context.warn("LSP indexing failed"));
    }
    try {
      await writeRepositoryScanCache(
        input.context.host,
        input.cachePath,
        input.cacheIdentity,
        scan,
        input.context.host.now(),
      );
    } catch {
      // Cache persistence is an optimization; the live map remains authoritative.
    }
    emitCompleted("completed", scan.files.length);
    return { files: scan.files.length };
  } catch (error) {
    emitCompleted("failed", 0);
    return {
      files: 0,
      warning: `repository scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Apply CLI and session overrides on top of the loaded config.
 *
 * A `profile:` selection resolves through `model.profiles` so `--model profile:deep`
 * and `/model deep` land on the same values as `capy model use profile:deep`.
 */
function applyOverrides(
  config: Awaited<ReturnType<CommandContext["requireConfig"]>>,
  overrides: BootstrapOptions["overrides"],
): Awaited<ReturnType<CommandContext["requireConfig"]>> {
  if (overrides === undefined) return withActiveProfile(config);

  const next = structuredCloneConfig(config);

  if (overrides.model !== undefined) {
    const profileName = overrides.model.startsWith("profile:")
      ? overrides.model.slice("profile:".length)
      : undefined;
    if (profileName !== undefined) {
      next.model.profile = profileName;
    } else {
      next.model.default = overrides.model;
      // An explicit model outranks a profile, so the profile is cleared rather than
      // silently reapplied below.
      next.model.profile = "auto";
    }
  }
  // Resolve a named profile before applying explicit effort/mode values. This keeps
  // the profile's model while preventing it from restoring its own reasoning choice.
  const effective = withActiveProfile(next);
  if (overrides.reasoningEffort !== undefined) {
    effective.model.reasoningEffort = overrides.reasoningEffort as typeof effective.model.reasoningEffort;
  }
  if (overrides.reasoningMode !== undefined) {
    effective.model.reasoningMode = overrides.reasoningMode as typeof effective.model.reasoningMode;
  }
  if (overrides.reasoningEffort !== undefined || overrides.reasoningMode !== undefined) {
    effective.model.profile = "auto";
  }
  if (overrides.permissionMode !== undefined) {
    const raw = overrides.permissionMode as string;
    if (raw === "build" || raw === "plan") {
      effective.agent.interactionMode = raw;
      if (raw === "plan" && effective.permissions.preset === undefined) effective.permissions.preset = "read";
    } else {
    const legacyMap: Record<string, string> = { plan: "read", ask: "custom" };
    const preset = (raw === "read" || raw === "edit" || raw === "auto" || raw === "yolo") ? raw : legacyMap[raw] ?? "auto";
    if (preset !== "custom") effective.permissions.preset = preset as never;
    effective.agent.permissionMode = overrides.permissionMode as typeof effective.agent.permissionMode;
    }
  }
  if (overrides.interactionMode !== undefined) effective.agent.interactionMode = overrides.interactionMode;
  if (overrides.permissionPreset !== undefined) effective.permissions.preset = overrides.permissionPreset;
  if (overrides.reviewMode !== undefined) effective.agent.reviewMode = overrides.reviewMode;

  return effective;
}

/** Fold the selected profile into the concrete model fields (§10.3, §21.5). */
function withActiveProfile<T extends Awaited<ReturnType<CommandContext["requireConfig"]>>>(
  config: T,
): T {
  const name = config.model.profile;
  const profile = config.model.profiles[name];
  if (profile === undefined || name === "auto") return config;

  const next = structuredCloneConfig(config);
  next.model.default = profile.model;
  next.model.reasoningMode = profile.reasoningMode;
  next.model.reasoningEffort = profile.reasoningEffort;
  return next as T;
}

function structuredCloneConfig<T>(config: T): T {
  // The config is plain JSON data, so a structured clone is exact and avoids the
  // aliasing bugs a shallow spread would introduce on nested tables.
  const cloned = structuredClone(config) as T;
  // `defaultConfig()` keeps the fast-path flag non-enumerable for backwards
  // compatibility with the documented default object. Preserve it explicitly
  // across this clone so an explicit false kill switch cannot disappear.
  const sourceRecord = config as T & { perf?: { longSessionFastPath?: unknown } };
  const targetRecord = cloned as T & { perf?: { longSessionFastPath?: unknown } };
  const fastPath = sourceRecord.perf?.longSessionFastPath;
  if (
    typeof fastPath === "boolean" &&
    targetRecord.perf !== undefined &&
    !("longSessionFastPath" in targetRecord.perf)
  ) {
    Object.defineProperty(targetRecord.perf, "longSessionFastPath", {
      value: fastPath,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return cloned;
}

/**
 * P0-13: turn declarative `[permissions.rules]` into the StoredRule shape the
 * policy engine consumes. Config rules carry no grant timestamp and are always
 * project-scoped; the engine re-checks workspace trust before honouring them.
 */
function configPermissionRulesToStored(rules: readonly ConfigPermissionRule[]): StoredRule[] {
  return rules.map((entry) => ({
    rule: {
      tool: entry.tool,
      ...(entry.program !== undefined ? { program: entry.program } : {}),
      ...(entry.argsExact !== undefined ? { argsExact: [...entry.argsExact] } : {}),
      ...(entry.argsPrefix !== undefined ? { argsPrefix: [...entry.argsPrefix] } : {}),
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(entry.paths !== undefined ? { paths: [...entry.paths] } : {}),
      ...(entry.server !== undefined ? { server: entry.server } : {}),
    },
    scope: "project",
    decision: entry.decision,
    grantedForRisk: entry.risk,
  }));
}
