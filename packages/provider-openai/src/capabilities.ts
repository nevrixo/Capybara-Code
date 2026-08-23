/**
 * Versioned provider capability contracts.
 *
 * A model id is only a name.  The Responses API surface behind that name can
 * change, and an account endpoint may expose a smaller subset than the bundled
 * product profile.  This module keeps the conservative, serialisable snapshot
 * used by routing and policy decisions.  It deliberately contains no provider
 * SDK types and never treats an unknown capability as enabled.
 *
 * P1-05: the capability state lattice itself is provider-neutral and lives in
 * `@cbc/inference-domain`; this module re-exports it for existing call sites.
 */

import { createHash } from "node:crypto";

import type { ModelDescriptor, PriceEntry, ReasoningEffort, ReasoningMode } from "./types.ts";
import {
  CAPABILITY_SCHEMA_VERSION,
  type CapabilitySource,
  type CapabilityState,
} from "@cbc/inference-domain";

export { CAPABILITY_SCHEMA_VERSION };
export type { CapabilitySource, CapabilityState };

export interface NativeCapabilitySet {
  readonly programmaticToolCalling: CapabilityState;
  readonly hostedMultiAgent: CapabilityState;
  readonly codeInterpreter: CapabilityState;
  readonly fileSearch: CapabilityState;
  readonly webSearch: CapabilityState;
  /** Responses API image-generation hosted tool. */
  readonly imageGeneration: CapabilityState;
  readonly hostedShell: CapabilityState;
  readonly hostedApplyPatch: CapabilityState;
  readonly computerUse: CapabilityState;
}

export interface ModelCapabilitySnapshot {
  readonly schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  readonly snapshotVersion: string;
  readonly modelId: string;
  readonly snapshotId?: string;
  readonly tier?: "sol" | "terra" | "luna" | "unknown";
  readonly maxContextTokens?: number;
  readonly family: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly aliases: readonly string[];
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly reasoningModes: readonly ReasoningMode[];
  readonly supportsStreaming: boolean;
  readonly supportsFunctionCalling: boolean;
  readonly supportsReasoningSummary: boolean;
  readonly supportsPersistedReasoning?: boolean;
  readonly supportsPromptCacheBreakpoints: boolean;
  readonly native: NativeCapabilitySet;
  readonly supportsProgrammaticTools?: boolean;
  readonly supportsHostedMultiAgent?: boolean;
  readonly supportedHostedTools?: readonly string[];
  readonly cache?: { readonly explicitBreakpoints: boolean; readonly maxWritesPerRequest: number; readonly minimumTtl: string };
  /**
   * Billing boundary only. It must never be treated as a model context-window
   * or usable input-budget limit.
   */
  readonly pricingBand?: { readonly premiumThresholdTokens: number; readonly premiumMultiplier?: number };
  readonly pricing?: PriceEntry;
  readonly source: CapabilitySource;
  /** Digest excludes source, observedAt, and this field itself. */
  readonly digest: string;
  /** Canonical provenance label; `provenanceSources` retains merged ancestry. */
  readonly provenance?: "bundled" | "provider" | "admin" | readonly string[];
  readonly provenanceSources?: readonly string[];
  readonly observedAt?: string;
  readonly expiresAt?: string;
}

export interface CapabilityManifest {
  readonly schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  readonly manifestVersion: string;
  readonly generatedAt: string;
  readonly snapshots: readonly ModelCapabilitySnapshot[];
  readonly digest: string;
}

const ALL_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const SAFE_NATIVE: NativeCapabilitySet = {
  programmaticToolCalling: "unsupported",
  hostedMultiAgent: "unsupported",
  codeInterpreter: "unsupported",
  fileSearch: "unsupported",
  webSearch: "unsupported",
  imageGeneration: "unsupported",
  hostedShell: "unsupported",
  hostedApplyPatch: "unsupported",
  computerUse: "unsupported",
};

/**
 * ChatGPT account sessions reach Codex through the ChatGPT/Codex backend rather
 * than the public Responses API model profile. Keep that backend's documented
 * envelope separate from the generic API registry.
 */
export const CHATGPT_CODEX_CONTEXT_WINDOW = 400_000;
export const CHATGPT_CODEX_MAX_OUTPUT_TOKENS = 128_000;
const CHATGPT_CODEX_PROFILE_OBSERVED_AT = "2026-08-14T00:00:00.000Z";

/**
 * A bundled manifest is available offline and is never a permission grant.
 *
 * P0-11: this manifest is the single versioned capability document. The legacy
 * `MODEL_REGISTRY` is derived from it (see `snapshotDescriptor`), so aliases,
 * context, output, reasoning, and pricing live in exactly one place. The numbers
 * mirror the current documented model profile; account-backend entitlements still
 * require an explicit provider confirmation before hosted tools are sent.
 */
export const BUNDLED_CAPABILITY_MANIFEST: CapabilityManifest = buildManifest(
  "2026-08-11",
  [
    bundled({
      id: "gpt-5.6-sol",
      tier: "sol",
      aliases: ["gpt-5.6", "sol"],
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: [...ALL_EFFORTS],
      reasoningModes: ["standard", "pro"],
      supportsReasoningSummary: true,
    }),
    bundled({
      id: "gpt-5.6-terra",
      tier: "terra",
      aliases: ["terra"],
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: [...ALL_EFFORTS],
      reasoningModes: ["standard"],
      supportsReasoningSummary: true,
    }),
    bundled({
      id: "gpt-5.6-luna",
      tier: "luna",
      aliases: ["luna"],
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: [...ALL_EFFORTS],
      reasoningModes: ["standard"],
      supportsReasoningSummary: false,
    }),
  ],
);

interface BundledSpec {
  readonly id: string;
  readonly tier: "sol" | "terra" | "luna";
  readonly aliases: readonly string[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly reasoningModes: readonly ReasoningMode[];
  readonly supportsReasoningSummary: boolean;
}

function bundled(spec: BundledSpec): Omit<ModelCapabilitySnapshot, "digest"> {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    snapshotVersion: "2026-08-11",
    modelId: spec.id,
    family: "gpt-5.6",
    aliases: [...spec.aliases],
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    reasoningEfforts: [...spec.reasoningEfforts],
    reasoningModes: [...spec.reasoningModes],
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsReasoningSummary: spec.supportsReasoningSummary,
    supportsPromptCacheBreakpoints: true,
    native: {
      ...SAFE_NATIVE,
      programmaticToolCalling: "supported",
      hostedMultiAgent: "supported",
      // GPT-5.6 Responses surface advertises both hosted tools. The
      // account transport can still downgrade these to unknown when its
      // backend has not published an equivalent entitlement contract.
      webSearch: "supported",
      imageGeneration: "supported",
    },
    source: "bundled",
    provenance: "bundled",
  };
}

/**
 * Project a capability snapshot back to the legacy `ModelDescriptor` shape.
 * P0-11: `MODEL_REGISTRY` is built from this, so the registry and the manifest
 * cannot disagree about a model's context window, output budget, or reasoning
 * surface. Bundled snapshots carry no `observedAt` — a wall clock would make the
 * derived registry (and any digest over it) nondeterministic.
 */
export function snapshotDescriptor(snapshot: ModelCapabilitySnapshot): ModelDescriptor {
  return {
    id: snapshot.modelId,
    family: snapshot.family,
    aliases: [...snapshot.aliases],
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens,
    reasoningEfforts: [...snapshot.reasoningEfforts],
    reasoningModes: [...snapshot.reasoningModes],
    supportsStreaming: snapshot.supportsStreaming,
    supportsFunctionCalling: snapshot.supportsFunctionCalling,
    supportsReasoningSummary: snapshot.supportsReasoningSummary,
    supportsPromptCacheBreakpoints: snapshot.supportsPromptCacheBreakpoints,
    sourceVersion: snapshot.snapshotVersion,
  };
}

export function createCapabilitySnapshot(
  input: Omit<ModelCapabilitySnapshot, "schemaVersion" | "digest"> &
    Partial<Pick<ModelCapabilitySnapshot, "schemaVersion">>,
): ModelCapabilitySnapshot {
  const contextWindow = finitePositive(input.contextWindow, 0);
  const normalizedNative = normalizeNative(input.native);
  const tier = input.tier ?? inferTier(input.modelId);
  const base = {
    schemaVersion: input.schemaVersion ?? CAPABILITY_SCHEMA_VERSION,
    snapshotVersion: input.snapshotVersion,
    modelId: input.modelId,
    snapshotId: input.snapshotId ?? input.snapshotVersion,
    tier,
    maxContextTokens: contextWindow,
    family: input.family,
    contextWindow,
    maxOutputTokens: finitePositive(input.maxOutputTokens, 0),
    aliases: uniqueAliases(input.aliases),
    reasoningEfforts: uniqueEfforts(input.reasoningEfforts),
    reasoningModes: uniqueModes(input.reasoningModes),
    supportsStreaming: input.supportsStreaming === true,
    supportsFunctionCalling: input.supportsFunctionCalling === true,
    supportsReasoningSummary: input.supportsReasoningSummary === true,
    supportsPersistedReasoning: input.supportsPersistedReasoning ?? input.supportsReasoningSummary === true,
    supportsPromptCacheBreakpoints: input.supportsPromptCacheBreakpoints === true,
    native: normalizedNative,
    supportsProgrammaticTools: normalizedNative.programmaticToolCalling === "supported",
    supportsHostedMultiAgent: normalizedNative.hostedMultiAgent === "supported",
    supportedHostedTools: [
      ...(normalizedNative.hostedMultiAgent === "supported" ? ["fs.read", "fs.read_many", "fs.list", "fs.glob", "fs.search"] : []),
      ...(normalizedNative.webSearch === "supported" ? ["web_search"] : []),
      ...(normalizedNative.imageGeneration === "supported" ? ["image_generation"] : []),
    ],
    cache: { explicitBreakpoints: input.supportsPromptCacheBreakpoints === true, maxWritesPerRequest: 2, minimumTtl: "30m" },
    pricingBand: { premiumThresholdTokens: 272_000 },
    ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
  };
  const result = {
    ...base,
    source: input.source,
    provenance: typeof input.provenance === "string"
      ? input.provenance
      : input.source === "provider" || input.source === "merged" ? "provider" : "bundled",
    ...(Array.isArray(input.provenance) ? { provenanceSources: [...input.provenance] } : {}),
    ...(input.provenanceSources !== undefined ? { provenanceSources: [...input.provenanceSources] } : {}),
    // Wall-clock timestamps belong to provider observations, never to the bundled
    // manifest: a bundled snapshot must be byte-identical across builds (P0-11).
    ...(input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    digest: digestOf(base),
  } as ModelCapabilitySnapshot;
  return result;
}

/** Resolve aliases against the bundled manifest without contacting a provider. */
export function bundledCapability(modelIdOrAlias: string): ModelCapabilitySnapshot | undefined {
  const needle = modelIdOrAlias.toLowerCase();
  return BUNDLED_CAPABILITY_MANIFEST.snapshots.find((candidate) => {
    if (candidate.modelId.toLowerCase() === needle) return true;
    return candidate.aliases.some((alias) => alias.toLowerCase() === needle);
  });
}

/**
 * Resolve the capability envelope used by a ChatGPT/Codex account login.
 *
 * The account backend shares the public models' effort ladder, but it does not
 * expose the Responses API's `reasoning.mode` switch. Keep that distinction in
 * the capability snapshot so profiles such as `review` are downgraded before a
 * child request is sent instead of failing once and succeeding only after the
 * parent continues in standard mode.
 *
 * All three variants share the account backend's 400K context window and 128K
 * output ceiling. The explicit native copy matters: this is a context-profile
 * override, not an unverified provider capability observation.
 */
export function chatGptCodexCapability(
  modelIdOrAlias: string,
): ModelCapabilitySnapshot | undefined {
  const bundled = bundledCapability(modelIdOrAlias);
  if (bundled === undefined) return undefined;
  return mergeCapabilitySnapshot(
    bundled,
    {
      snapshotVersion: [bundled.snapshotVersion, "chatgpt-codex"].join("-"),
      contextWindow: CHATGPT_CODEX_CONTEXT_WINDOW,
      maxOutputTokens: CHATGPT_CODEX_MAX_OUTPUT_TOKENS,
      reasoningModes: ["standard"],
      native: bundled.native,
      provenanceSources: ["bundled", "chatgpt-codex-account"],
      observedAt: CHATGPT_CODEX_PROFILE_OBSERVED_AT,
    },
    CHATGPT_CODEX_PROFILE_OBSERVED_AT,
  );
}

/** Convert a legacy descriptor into a capability snapshot for mixed-version callers. */
export function snapshotFromDescriptor(descriptor: ModelDescriptor): ModelCapabilitySnapshot {
  const native: NativeCapabilitySet = { ...SAFE_NATIVE };
  return createCapabilitySnapshot({
    snapshotVersion: descriptor.sourceVersion,
    modelId: descriptor.id,
    family: descriptor.family,
    contextWindow: descriptor.contextWindow ?? 0,
    maxOutputTokens: descriptor.maxOutputTokens ?? 0,
    aliases: [...descriptor.aliases],
    reasoningEfforts: descriptor.reasoningEfforts.filter(isEffort),
    reasoningModes: descriptor.reasoningModes.filter(isMode),
    supportsStreaming: descriptor.supportsStreaming,
    supportsFunctionCalling: descriptor.supportsFunctionCalling,
    supportsReasoningSummary: descriptor.supportsReasoningSummary,
    supportsPromptCacheBreakpoints: descriptor.supportsPromptCacheBreakpoints,
    native,
    source: "fallback",
    provenance: ["legacy-model-descriptor"],
  });
}

export interface ProviderCapabilityRecord {
  readonly modelId?: unknown;
  readonly contextWindow?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly reasoningEfforts?: unknown;
  readonly reasoningModes?: unknown;
  readonly supportsStreaming?: unknown;
  readonly supportsFunctionCalling?: unknown;
  readonly supportsReasoningSummary?: unknown;
  readonly supportsPersistedReasoning?: unknown;
  readonly maxContextTokens?: unknown;
  readonly tier?: unknown;
  readonly supportsPromptCacheBreakpoints?: unknown;
  readonly native?: unknown;
  readonly pricing?: unknown;
  readonly snapshotVersion?: unknown;
  readonly provenance?: unknown;
  readonly provenanceSources?: unknown;
  readonly observedAt?: unknown;
  readonly expiresAt?: unknown;
}

/**
 * Merge a provider response with the bundled profile.  Fields absent or malformed
 * in the response stay conservative; a provider cannot broaden a permission class
 * through an unrecognised value.
 */
export function mergeCapabilitySnapshot(
  bundledSnapshot: ModelCapabilitySnapshot,
  providerRecord: ProviderCapabilityRecord,
  observedAt = new Date().toISOString(),
): ModelCapabilitySnapshot {
  const provider = isRecord(providerRecord) ? providerRecord : {};
  const native = isRecord(provider.native) ? provider.native : {};
  const mergedNative: NativeCapabilitySet = {
    programmaticToolCalling: mergeState(bundledSnapshot.native.programmaticToolCalling, native.programmaticToolCalling),
    hostedMultiAgent: mergeState(bundledSnapshot.native.hostedMultiAgent, native.hostedMultiAgent),
    codeInterpreter: mergeState(bundledSnapshot.native.codeInterpreter, native.codeInterpreter),
    fileSearch: mergeState(bundledSnapshot.native.fileSearch, native.fileSearch),
    webSearch: mergeState(bundledSnapshot.native.webSearch, native.webSearch),
    imageGeneration: mergeState(bundledSnapshot.native.imageGeneration, native.imageGeneration),
    hostedShell: mergeState(bundledSnapshot.native.hostedShell, native.hostedShell),
    hostedApplyPatch: mergeState(bundledSnapshot.native.hostedApplyPatch, native.hostedApplyPatch),
    computerUse: mergeState(bundledSnapshot.native.computerUse, native.computerUse),
  };
  const record = provider as Record<string, unknown>;
  return createCapabilitySnapshot({
    snapshotVersion: stringOr(record.snapshotVersion, bundledSnapshot.snapshotVersion),
    modelId: stringOr(record.modelId, bundledSnapshot.modelId),
    family: bundledSnapshot.family,
    contextWindow: numberOr(record.contextWindow, bundledSnapshot.contextWindow),
    maxOutputTokens: numberOr(record.maxOutputTokens, bundledSnapshot.maxOutputTokens),
    aliases: [...bundledSnapshot.aliases],
    reasoningEfforts: Array.isArray(record.reasoningEfforts) ? record.reasoningEfforts.filter(isEffort) : bundledSnapshot.reasoningEfforts,
    reasoningModes: Array.isArray(record.reasoningModes) ? record.reasoningModes.filter(isMode) : bundledSnapshot.reasoningModes,
    supportsStreaming: boolOr(record.supportsStreaming, bundledSnapshot.supportsStreaming),
    supportsFunctionCalling: boolOr(record.supportsFunctionCalling, bundledSnapshot.supportsFunctionCalling),
    supportsReasoningSummary: boolOr(record.supportsReasoningSummary, bundledSnapshot.supportsReasoningSummary),
    supportsPersistedReasoning: boolOr(record.supportsPersistedReasoning, bundledSnapshot.supportsPersistedReasoning ?? bundledSnapshot.supportsReasoningSummary),
    supportsPromptCacheBreakpoints: boolOr(record.supportsPromptCacheBreakpoints, bundledSnapshot.supportsPromptCacheBreakpoints),
    native: mergedNative,
    ...(isRecord(record.pricing) ? { pricing: record.pricing as unknown as PriceEntry } : bundledSnapshot.pricing !== undefined ? { pricing: bundledSnapshot.pricing } : {}),
    source: "merged",
    provenance: isProvenance(record.provenance) ? record.provenance : ["bundled", "provider"],
    ...(isProvenanceSources(record.provenanceSources) ? { provenanceSources: record.provenanceSources } : {}),
    observedAt: stringOr(record.observedAt, observedAt),
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
  });
}

export function capabilityIsFresh(snapshot: ModelCapabilitySnapshot, now = new Date()): boolean {
  if (snapshot.expiresAt === undefined) return true;
  const expiresAt = Date.parse(snapshot.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt > now.getTime();
}

export function capabilitySupports(
  snapshot: ModelCapabilitySnapshot,
  feature: keyof NativeCapabilitySet,
): boolean {
  return capabilityIsFresh(snapshot) && snapshot.native[feature] === "supported";
}

export function capabilityAllowsReasoning(
  snapshot: ModelCapabilitySnapshot,
  effort: ReasoningEffort,
  mode: ReasoningMode,
): boolean {
  return capabilityIsFresh(snapshot) && snapshot.reasoningEfforts.includes(effort) && snapshot.reasoningModes.includes(mode);
}

function buildManifest(version: string, entries: readonly (Omit<ModelCapabilitySnapshot, "digest">)[]): CapabilityManifest {
  const snapshots = entries.map((entry) => createCapabilitySnapshot(entry));
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    manifestVersion: version,
    generatedAt: `${version}T00:00:00.000Z`,
    snapshots,
    digest: digestOf({ version, snapshots: snapshots.map(({ digest: _digest, ...rest }) => rest) }),
  };
}

function isProvenance(value: unknown): value is "bundled" | "provider" | "admin" | readonly string[] {
  return value === "bundled" || value === "provider" || value === "admin" || isProvenanceSources(value);
}

function isProvenanceSources(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") && value.length <= 16;
}

function normalizeNative(value: NativeCapabilitySet): NativeCapabilitySet {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    programmaticToolCalling: stateOf(source.programmaticToolCalling),
    hostedMultiAgent: stateOf(source.hostedMultiAgent),
    codeInterpreter: stateOf(source.codeInterpreter),
    fileSearch: stateOf(source.fileSearch),
    webSearch: stateOf(source.webSearch),
    imageGeneration: stateOf(source.imageGeneration),
    hostedShell: stateOf(source.hostedShell),
    hostedApplyPatch: stateOf(source.hostedApplyPatch),
    computerUse: stateOf(source.computerUse),
  };
}

function mergeState(bundledValue: CapabilityState, providerValue: unknown): CapabilityState {
  if (providerValue === "unsupported") return "unsupported";
  if (providerValue === "supported" && bundledValue === "supported") return "supported";
  return "unknown";
}

function stateOf(value: unknown): CapabilityState {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

function uniqueEfforts(values: readonly ReasoningEffort[]): ReasoningEffort[] {
  return [...new Set(values.filter(isEffort))];
}

function uniqueAliases(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((alias) => typeof alias === "string" && alias.length > 0))];
}

function uniqueModes(values: readonly ReasoningMode[]): ReasoningMode[] {
  return [...new Set(values.filter(isMode))];
}

function isEffort(value: unknown): value is ReasoningEffort {
  return ALL_EFFORTS.includes(value as ReasoningEffort);
}

function isMode(value: unknown): value is ReasoningMode {
  return value === "standard" || value === "pro";
}

function inferTier(modelId: string): "sol" | "terra" | "luna" | "unknown" {
  const normalized = modelId.toLowerCase();
  if (normalized.endsWith("-sol") || normalized === "gpt-5.6") return "sol";
  if (normalized.endsWith("-terra")) return "terra";
  if (normalized.endsWith("-luna")) return "luna";
  return "unknown";
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable, non-secret digest for manifests and cacheable policy decisions. */
function digestOf(value: unknown): string {
  const text = JSON.stringify(value, (_key, current) => {
    if (isRecord(current)) {
      return Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
    }
    if (Array.isArray(current)) return current;
    return current;
  });
  return createHash("sha256").update(text).digest("hex");
}
