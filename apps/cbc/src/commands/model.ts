/**
 * `capy model` — PRD §8.5, §10.3, §10.12, AC-48.
 *
 * §8.5 requires `model list` to distinguish three things: what the bundled registry
 * knows about, what the current credential can actually reach, and what is
 * unavailable or unverified. Collapsing those would make AC-48's transparency
 * requirement unmeetable — a user has to be able to tell "this build does not know
 * that model" from "your key cannot use it".
 */

import {
  BUNDLED_CAPABILITY_MANIFEST,
  MODEL_REGISTRY,
  findModel,
  refreshCapabilityManifest,
  resolveCapabilityManifest,
} from "@cbc/provider-openai";

import { readAuthMode } from "../auth-mode.ts";
import { configError, usageError } from "../exit.ts";
import { resolveAccountSession, resolveCredential } from "../credentials.ts";
import { buildProvider } from "../provider.ts";
import { setUserConfigValue } from "../state.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export interface ModelListArgs {
  readonly available: boolean;
}

export async function modelList(
  context: CommandContext,
  args: ModelListArgs,
): Promise<CommandResult> {
  const config = await context.requireConfig();

  let reachable: Set<string> | undefined;
  if (args.available) {
    reachable = await reachableModels(context);
    if (reachable === undefined) {
      context.warn("no credential available; showing the bundled registry only");
    }
  }

  const manifest = await resolveCapabilityManifest({
    host: context.host,
    cacheDir: context.paths.cache,
    env: context.host.env,
  }).catch(() => ({
    manifest: BUNDLED_CAPABILITY_MANIFEST,
    source: "bundled" as const,
    refreshed: false,
    snapshots: BUNDLED_CAPABILITY_MANIFEST.snapshots,
  }));
  const snapshots = manifest.snapshots.length > 0 ? manifest.snapshots : BUNDLED_CAPABILITY_MANIFEST.snapshots;
  const sourceLabel = manifest.source;

  const lines: string[] = [];
  const registryModels = snapshots.map((snap) => ({
    id: snap.modelId,
    aliases: [...snap.aliases],
    reasoningEfforts: [...snap.reasoningEfforts],
    contextWindow: snap.contextWindow,
    maxOutputTokens: snap.maxOutputTokens,
    tier: snap.tier ?? "unknown",
    source: snap.source,
  }));
  const width = registryModels.reduce((max, model) => Math.max(max, model.id.length), 0);

  for (const model of registryModels) {
    const marks: string[] = [];
    if (model.id === config.model.default) marks.push("default");
    if (reachable !== undefined) {
      marks.push(reachable.has(model.id) ? "available" : "unavailable");
    } else {
      marks.push(sourceLabel === "remote" || sourceLabel === "cache" ? sourceLabel : "registry");
    }
    marks.push(`${model.tier}`);
    marks.push(`ctx ${formatTokens(model.contextWindow)}/${formatTokens(model.maxOutputTokens)}`);
    if (model.aliases.length > 0) marks.push(`aliases: ${model.aliases.join(", ")}`);
    lines.push(
      `${model.id.padEnd(width)}  ${model.reasoningEfforts.join("/")}  ${marks.join(" · ")}`,
    );
  }

  if (reachable !== undefined) {
    const knownIds = new Set(registryModels.map((m) => m.id.toLowerCase()));
    const unknown = [...reachable].filter((id) => !knownIds.has(id.toLowerCase()) && findModel(id) === undefined);
    if (unknown.length > 0) {
      lines.push("");
      lines.push("Reachable but not in this build's capability registry (unverified):");
      for (const id of unknown.sort()) lines.push(`  ${id}`);
    }
  }

  lines.push("");
  const providerCount = reachable === undefined ? "provider not queried" : `provider observed: ${reachable.size}`;
  lines.push(`Registry models: ${registryModels.length}; ${providerCount}; ctx = model window / max output`);
  lines.push(`Registry version: ${manifest.manifest.manifestVersion} · source: ${sourceLabel}`);
  if (sourceLabel === "override") lines.push("Override active via CBC_CAPABILITY_OVERRIDE");
  if (context.host.env.CBC_CAPABILITY_URL) lines.push(`Manifest URL: ${context.host.env.CBC_CAPABILITY_URL}`);
  context.outLines(lines);
  return ok();
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(Number.isInteger(millions * 10) ? 1 : 2)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export async function modelRefresh(context: CommandContext): Promise<CommandResult> {
  const result = await refreshCapabilityManifest({
    host: context.host,
    cacheDir: context.paths.cache,
    env: context.host.env,
  });
  if (result.error) context.warn(result.error);
  context.out(`Capability manifest: ${result.source} · ${result.manifest.manifestVersion} · ${result.snapshots.length} model(s)`);
  if (result.refreshed) context.out("Refreshed from remote.");
  else if (result.source === "cache") context.out("Using cached manifest (remote unavailable).");
  else if (result.source === "bundled") context.out("Using bundled manifest.");
  return ok();
}

export async function modelProfiles(context: CommandContext): Promise<CommandResult> {
  const config = await context.requireConfig();
  const entries = Object.entries(config.model.profiles);
  const width = entries.reduce((max, [name]) => Math.max(max, name.length), 0);

  const lines = entries.map(([name, profile]) => {
    const active = name === config.model.profile ? " (active)" : "";
    return `${name.padEnd(width)}  ${profile.model}  ${profile.reasoningMode}/${profile.reasoningEffort}${active}`;
  });
  context.outLines(lines);
  return ok();
}

export interface ModelUseArgs {
  readonly target: string;
}

/**
 * `capy model use <id|profile:name>`.
 *
 * Written to the user config rather than the project config: §21.3 keeps project
 * config from carrying anything that alters credentials or weakens policy, and a
 * model choice is a personal default rather than a repository fact.
 */
export async function modelUse(
  context: CommandContext,
  args: ModelUseArgs,
): Promise<CommandResult> {
  const config = await context.requireConfig();
  const target = args.target.trim();

  if (target.startsWith("profile:")) {
    const name = target.slice("profile:".length);
    if (config.model.profiles[name] === undefined) {
      throw usageError(`unknown profile '${name}'`, [
        `Available: ${Object.keys(config.model.profiles).join(", ")}`,
      ]);
    }
    const written = await setUserConfigValue(context.host, "model.profile", name);
    if (written.issues.some((issue) => issue.severity === "error")) {
      throw configError(
        `could not set model.profile`,
        written.issues.map((issue) => `  ${issue.message}`),
      );
    }
    const profile = config.model.profiles[name];
    context.out(`Profile set to ${name} (${profile?.model ?? "?"}, ${profile?.reasoningEffort ?? "?"})`);
    context.out(`Wrote ${written.written}`);
    return ok();
  }

  const descriptor = findModel(target);
  if (descriptor === undefined) {
    throw usageError(`unknown model '${target}'`, [
      "Run `capy model list` to see the models this build knows about.",
      "Aliases are accepted, e.g. `gpt-5.6` for gpt-5.6-sol.",
    ]);
  }

  // A concrete model selection must leave profile resolution in auto mode. Otherwise
  // bootstrap applies the still-active named profile and silently restores its model.
  const profile = await setUserConfigValue(context.host, "model.profile", "auto");
  if (profile.issues.some((issue) => issue.severity === "error")) {
    throw configError(
      "could not clear model.profile",
      profile.issues.map((issue) => `  ${issue.message}`),
    );
  }

  const written = await setUserConfigValue(context.host, "model.default", descriptor.id);
  if (written.issues.some((issue) => issue.severity === "error")) {
    throw configError(
      "could not set model.default",
      written.issues.map((issue) => `  ${issue.message}`),
    );
  }
  context.out(`Default model set to ${descriptor.id}`);
  if (target !== descriptor.id) context.out(`  ('${target}' is an alias)`);
  context.out(`Wrote ${written.written}`);
  return ok();
}

/**
 * Which models the current credential can reach.
 *
 * Returns `undefined` when there is no credential, so the caller can distinguish
 * "nothing is reachable" from "we could not ask".
 */
async function reachableModels(context: CommandContext): Promise<Set<string> | undefined> {
  const authMode = await readAuthMode(context.host, context.paths);
  try {
    if (authMode === "account") {
      const runtime = await context.runtime();
      const account = await resolveAccountSession({
        runtime,
        host: context.host,
        paths: context.paths,
        env: context.host.env,
        now: () => context.host.now(),
      });
      if (account === undefined) return undefined;
      const choice = await buildProvider({
        host: context.host,
        authMode: "account",
        credential: account.lease,
        credentialSource: account.source,
        baseUrl: account.baseUrl,
        ...(account.headers !== undefined ? { headers: account.headers } : {}),
      });
      return new Set((await choice.provider.listModels()).map((model) => model.id));
    }

    const runtime = await context.runtime();
    const credential = await resolveCredential({
      runtime,
      env: context.host.env,
      host: context.host,
      paths: context.paths,
      now: () => context.host.now(),
    });
    if (credential === undefined) return undefined;

    const choice = await buildProvider({
      host: context.host,
      credential: credential.lease,
      credentialSource: credential.source,
      ...(authMode !== undefined ? { authMode } : {}),
    });
    return new Set((await choice.provider.listModels()).map((model) => model.id));
  } catch {
    return undefined;
  }
}