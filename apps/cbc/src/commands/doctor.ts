/**
 * `capy doctor openai` — the §6 P1-03 OpenAI diagnostic.
 *
 * The report answers one question: which of this build's OpenAI-first features
 * is actually running right now, and for each one that is not, *why*. That last
 * half is the point. Every value here was already computable somewhere in the
 * runtime, but only as a per-turn event or a private field, so a user whose PTC
 * lane silently fell back had no way to tell a config choice from a backend
 * limit from a missing dispatcher — three problems with three different fixes,
 * all of which render as "off".
 *
 * The renderer is a pure function of a plain snapshot so the same rows can be
 * produced from a live session, from the CLI with no session at all, and from a
 * test. Anything unavailable is reported as unavailable with the reason, never
 * omitted: a missing row reads as "fine" and would be the same overclaim §5.18
 * rejects for configuration keys.
 */

import { configKeyStatusEntries, type ConfigKeyStatus } from "@cbc/config-schema";

import { EXIT } from "../exit.ts";
import type { CommandContext, CommandResult } from "./context.ts";

/** A feature's state plus the reason it holds, for one report row. */
export interface DoctorFeatureState {
  readonly enabled: boolean;
  /** Required in both directions — see the module comment. */
  readonly reason: string;
}

export interface DoctorSnapshot {
  /** §4.1/§4.2 backend identity, and why this one is active. */
  readonly backendProfile: { readonly profile: string; readonly reason: string };
  readonly model: { readonly id: string; readonly effort: string; readonly mode: string };
  /** Undefined before the first turn establishes an epoch. */
  readonly epoch?: { readonly taskEpochId: string; readonly reasoningContext: string; readonly resetReason?: string };
  readonly programmaticLane: DoctorFeatureState;
  readonly hostedMultiAgent: DoctorFeatureState;
  readonly transport: {
    readonly configured: string;
    readonly active: string;
    readonly socketOpen: boolean;
    readonly circuitOpen: boolean;
    readonly previousResponseSupported: boolean;
    readonly latestResponseId?: string;
  };
  readonly cache: {
    readonly mode: string;
    readonly breakpoint: string;
    readonly readTokens: number;
    readonly writeTokens: number;
  };
  readonly compaction: { readonly mode: string; readonly generation: number };
  readonly fallbacks: { readonly count: number; readonly recentReasons: readonly string[] };
  /** Settings accepted by the schema that no consumer applies (§5.18). */
  readonly inertSettings: readonly { readonly key: string; readonly status: ConfigKeyStatus; readonly note: string }[];
}

const UNSET = "—";

/**
 * The §P1-03 output items, in the order the PRD lists them.
 *
 * Two-column layout rather than prose: the report is scanned for one row, not
 * read start to finish, and a fixed label column makes a disabled feature's
 * reason line up with the feature instead of trailing a sentence.
 */
export function renderOpenAiDoctor(snapshot: DoctorSnapshot): readonly string[] {
  const lines: string[] = ["OpenAI diagnostic", ""];

  lines.push(row("Backend", snapshot.backendProfile.profile));
  lines.push(indent(snapshot.backendProfile.reason));
  lines.push(row("Model", `${snapshot.model.id} · ${snapshot.model.mode} · effort ${snapshot.model.effort}`));

  if (snapshot.epoch === undefined) {
    lines.push(row("Epoch", UNSET));
    lines.push(indent("no task epoch yet; the first turn establishes one"));
  } else {
    lines.push(row("Epoch", `${snapshot.epoch.taskEpochId} · reasoning ${snapshot.epoch.reasoningContext}`));
    if (snapshot.epoch.resetReason !== undefined) {
      lines.push(indent(`last transition: ${snapshot.epoch.resetReason}`));
    }
  }

  lines.push(...feature("PTC lane", snapshot.programmaticLane));
  lines.push(...feature("Hosted agents", snapshot.hostedMultiAgent));

  const transport = snapshot.transport;
  lines.push(row(
    "Transport",
    `${transport.active}${transport.active === transport.configured ? "" : ` (configured ${transport.configured})`}`,
  ));
  lines.push(indent([
    `socket ${transport.socketOpen ? "open" : "closed"}`,
    transport.circuitOpen ? "circuit OPEN (cooling down after transport failures)" : "circuit closed",
    `previous-response ${transport.previousResponseSupported ? "supported" : "unsupported"}`,
    ...(transport.latestResponseId !== undefined ? [`latest ${transport.latestResponseId}`] : []),
  ].join(" · ")));

  lines.push(row("Cache", `${snapshot.cache.mode} · breakpoint ${snapshot.cache.breakpoint}`));
  lines.push(indent(`read ${snapshot.cache.readTokens} tokens · write ${snapshot.cache.writeTokens} tokens`));

  lines.push(row("Compaction", `${snapshot.compaction.mode} · generation ${snapshot.compaction.generation}`));

  lines.push(row("Fallbacks", String(snapshot.fallbacks.count)));
  if (snapshot.fallbacks.recentReasons.length === 0) {
    lines.push(indent("no native lane or transport fallback this session"));
  } else {
    // Most recent first: the reason a user is about to ask about is the last one
    // that happened, not the first.
    for (const reason of [...snapshot.fallbacks.recentReasons].reverse()) {
      lines.push(indent(reason));
    }
  }

  lines.push("");
  if (snapshot.inertSettings.length === 0) {
    lines.push("No no-op settings are in effect.");
  } else {
    lines.push(`Settings in effect that change nothing (${snapshot.inertSettings.length}):`);
    for (const setting of snapshot.inertSettings) {
      lines.push(indent(`${setting.key} [${setting.status}] — ${setting.note}`));
    }
  }
  lines.push("");
  return lines;
}

function feature(label: string, state: DoctorFeatureState): readonly string[] {
  return [row(label, state.enabled ? "eligible" : "not eligible"), indent(state.reason)];
}

function row(label: string, value: string): string {
  return label.padEnd(14) + value;
}

function indent(text: string): string {
  return "              " + text;
}

/**
 * Which explicitly-set config keys are inert.
 *
 * Only keys the user actually set are reported: the status registry lists every
 * experimental key in the schema, and printing all of them would bury the two
 * the user chose in a list of forty they never touched. `provenance` is the
 * record of what a config layer wrote, so it is exactly the right filter.
 */
export function inertSettingsFor(
  provenance: Readonly<Record<string, string>>,
): readonly { readonly key: string; readonly status: ConfigKeyStatus; readonly note: string }[] {
  const registry = configKeyStatusEntries();
  const inert: { key: string; status: ConfigKeyStatus; note: string }[] = [];
  for (const key of Object.keys(provenance).sort()) {
    // Longest-prefix-wins, matching `configKeyInfo`: a leaf entry overrides its
    // section default, so a wired leaf under an experimental section is wired.
    let best: readonly [string, { readonly status: ConfigKeyStatus; readonly note?: string; readonly consumer?: string }] | undefined;
    for (const entry of registry) {
      const pattern = entry[0];
      const matches = pattern.endsWith(".") ? key.startsWith(pattern) : key === pattern;
      if (matches && (best === undefined || pattern.length > best[0].length)) best = entry;
    }
    if (best === undefined) continue;
    const info = best[1];
    if (info.status === "wired") continue;
    inert.push({
      key,
      status: info.status,
      note: info.note ?? "accepted but not applied",
    });
  }
  return inert;
}

/**
 * The headless `capy doctor openai` entry point.
 *
 * Reported without starting a session: a diagnostic that needs a turn to run is
 * useless for the case it exists for, which is a user asking why a feature is
 * off before doing any work. The values a live session owns — epoch, transport
 * socket, cache tokens, fallback tally — therefore report their pre-session
 * state with the reason, rather than being omitted.
 */
export async function doctorCommand(
  context: CommandContext,
  target: "openai",
): Promise<CommandResult> {
  const loaded = await context.config();
  const config = loaded.config;
  const openai = config.provider.openai;

  // The profile the *config* asks for; `auto` resolves from the credential at
  // session start, which this command deliberately does not perform.
  const configuredProfile = openai.profile;
  const backendProfile = configuredProfile === "auto"
    ? {
        profile: "auto",
        reason: "resolved from the active credential when a session starts: an API key selects api-enhanced, an account login selects chatgpt-compatible",
      }
    : {
        profile: configuredProfile,
        reason: `pinned by provider.openai.profile; a credential of the other kind will be reported as a mismatch`,
      };

  const programmaticEnabled = openai.native.programmaticToolCalling === "read-only";
  const snapshot: DoctorSnapshot = {
    backendProfile,
    model: {
      id: config.model.default,
      effort: config.model.reasoningEffort,
      mode: config.model.reasoningMode,
    },
    programmaticLane: {
      enabled: programmaticEnabled && openai.native.maxProgramToolCalls > 0,
      reason: !programmaticEnabled
        ? "provider.openai.native.programmaticToolCalling is disabled"
        : openai.native.maxProgramToolCalls <= 0
          ? "the per-turn program call budget is zero"
          : `configured read-only with up to ${openai.native.maxProgramToolCalls} calls (${openai.native.maxProgramParallelCalls} parallel); backend capability is confirmed per turn`,
    },
    hostedMultiAgent: {
      enabled: false,
      reason: openai.native.hostedMultiAgent === "disabled"
        ? "provider.openai.native.hostedMultiAgent is disabled"
        : "configured, but a hosted subtree only runs when a session installs the scout dispatcher",
    },
    transport: {
      configured: openai.transport,
      active: "not connected",
      socketOpen: false,
      circuitOpen: false,
      previousResponseSupported: openai.transport !== "http_full",
    },
    cache: {
      mode: config.model.cache.mode,
      breakpoint: config.model.cache.breakpoint,
      readTokens: 0,
      writeTokens: 0,
    },
    compaction: {
      mode: `${config.model.context.compactionPolicy} local · ${config.model.context.providerCompactionMode} provider`,
      generation: 0,
    },
    fallbacks: { count: 0, recentReasons: [] },
    inertSettings: inertSettingsFor(loaded.provenance),
  };

  context.outLines([
    ...renderOpenAiDoctor(snapshot),
    `Reported from configuration for ${target}; per-turn values need a running session.`,
    "",
  ]);
  return { code: EXIT.ok };
}
