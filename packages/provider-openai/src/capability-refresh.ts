import {
  BUNDLED_CAPABILITY_MANIFEST,
  type CapabilityManifest,
  type ModelCapabilitySnapshot,
  createCapabilitySnapshot,
  mergeCapabilitySnapshot,
} from "./capabilities.ts";
import type { FetchLike } from "./openai.ts";

export const DEFAULT_CAPABILITY_MANIFEST_URL =
  "https://raw.githubusercontent.com/capybara-code/capability-manifest/main/manifest.json";
export const CAPABILITY_CACHE_KEY = "capability-manifest.json";
export const CAPABILITY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CapabilityRefreshOptions {
  readonly fetchImpl?: FetchLike;
  readonly manifestUrl?: string;
  readonly cacheDir?: string;
  readonly host?: {
    fs: {
      read(path: string): Promise<string | undefined>;
      write(path: string, content: string): Promise<void>;
      mkdirp(path: string): Promise<void>;
      exists(path: string): Promise<boolean>;
    };
    now(): number;
  };
  readonly overridePath?: string;
}

export interface CapabilityRefreshResult {
  readonly manifest: CapabilityManifest;
  readonly source: "bundled" | "cache" | "remote" | "override";
  readonly refreshed: boolean;
  readonly snapshots: readonly ModelCapabilitySnapshot[];
}

function manifestUrl(options: CapabilityRefreshOptions, envUrl?: string): string {
  return options.manifestUrl ?? envUrl ?? DEFAULT_CAPABILITY_MANIFEST_URL;
}

function cacheFile(cacheDir: string | undefined): string | undefined {
  if (cacheDir === undefined || cacheDir.length === 0) return undefined;
  return `${cacheDir.replace(/\/+$/, "")}/${CAPABILITY_CACHE_KEY}`;
}

function overrideFile(options: CapabilityRefreshOptions, envOverride?: string): string | undefined {
  if (options.overridePath !== undefined && options.overridePath.length > 0) return options.overridePath;
  if (envOverride !== undefined && envOverride.length > 0) return envOverride;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string): CapabilityManifest | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isRecord(parsed) || !Array.isArray(parsed.snapshots)) return undefined;
    const snapshots: ModelCapabilitySnapshot[] = [];
    for (const entry of parsed.snapshots as unknown[]) {
      if (!isRecord(entry)) continue;
      const snapshot = trySnapshot(entry);
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    if (snapshots.length === 0) return undefined;
    const manifestVersion =
      typeof parsed.manifestVersion === "string" && parsed.manifestVersion.length > 0
        ? parsed.manifestVersion
        : BUNDLED_CAPABILITY_MANIFEST.manifestVersion;
    const generatedAt =
      typeof parsed.generatedAt === "string" && parsed.generatedAt.length > 0
        ? parsed.generatedAt
        : new Date().toISOString();
    const digest =
      typeof parsed.digest === "string" && parsed.digest.length > 0 ? parsed.digest : manifestVersion;
    return {
      schemaVersion: BUNDLED_CAPABILITY_MANIFEST.schemaVersion,
      manifestVersion,
      generatedAt,
      snapshots,
      digest,
    };
  } catch {
    return undefined;
  }
}

function trySnapshot(entry: Record<string, unknown>): ModelCapabilitySnapshot | undefined {
  const modelId = typeof entry.modelId === "string" ? entry.modelId : undefined;
  if (modelId === undefined || modelId.length === 0) return undefined;
  const bundled = BUNDLED_CAPABILITY_MANIFEST.snapshots.find((s) => s.modelId === modelId);
  try {
    const base = bundled ?? BUNDLED_CAPABILITY_MANIFEST.snapshots[0]!;
    const merged = mergeCapabilitySnapshot(base, entry as never);
    if (bundled === undefined) {
      return createCapabilitySnapshot({
        snapshotVersion: merged.snapshotVersion,
        modelId: merged.modelId,
        family: merged.family,
        contextWindow: merged.contextWindow,
        maxOutputTokens: merged.maxOutputTokens,
        aliases: [...merged.aliases],
        reasoningEfforts: [...merged.reasoningEfforts],
        reasoningModes: [...merged.reasoningModes],
        supportsStreaming: merged.supportsStreaming,
        supportsFunctionCalling: merged.supportsFunctionCalling,
        supportsReasoningSummary: merged.supportsReasoningSummary,
        supportsPromptCacheBreakpoints: merged.supportsPromptCacheBreakpoints,
        native: merged.native,
        source: "provider",
        provenance: "provider",
      });
    }
    return merged;
  } catch {
    return undefined;
  }
}

async function readOverrideManifest(path: string, host: CapabilityRefreshOptions["host"]): Promise<CapabilityManifest | undefined> {
  if (host === undefined) return undefined;
  const raw = await host.fs.read(path).catch(() => undefined);
  if (raw === undefined) return undefined;
  return parseManifest(raw);
}

async function readCachedManifest(path: string, host: CapabilityRefreshOptions["host"]): Promise<{ manifest: CapabilityManifest; mtimeOk: boolean } | undefined> {
  if (host === undefined) return undefined;
  const raw = await host.fs.read(path).catch(() => undefined);
  if (raw === undefined) return undefined;
  const manifest = parseManifest(raw);
  if (manifest === undefined) return undefined;
  return { manifest, mtimeOk: true };
}

async function isCacheFresh(path: string, host: NonNullable<CapabilityRefreshOptions["host"]>): Promise<boolean> {
  const raw = await host.fs.read(`${path}.meta`).catch(() => undefined);
  if (raw === undefined) return false;
  try {
    const meta = JSON.parse(raw) as { fetchedAtMs?: number };
    if (typeof meta.fetchedAtMs !== "number") return false;
    return host.now() - meta.fetchedAtMs < CAPABILITY_REFRESH_INTERVAL_MS;
  } catch {
    return false;
  }
}

async function writeCacheMeta(path: string, host: NonNullable<CapabilityRefreshOptions["host"]>): Promise<void> {
  try {
    await host.fs.write(`${path}.meta`, JSON.stringify({ fetchedAtMs: host.now() }));
  } catch {}
}

async function fetchRemoteManifest(url: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<CapabilityManifest | undefined> {
  try {
    const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (!response.ok) return undefined;
    const text = await response.text();
    return parseManifest(text);
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, manifest: CapabilityManifest, host: CapabilityRefreshOptions["host"]): Promise<void> {
  if (host === undefined) return;
  try {
    await host.fs.mkdirp(path.replace(/\/[^/]+$/, ""));
    await host.fs.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeCacheMeta(path, host as NonNullable<CapabilityRefreshOptions["host"]>);
  } catch {}
}

export async function resolveCapabilityManifest(
  options: CapabilityRefreshOptions & { env?: Record<string, string | undefined> } = {},
  signal?: AbortSignal,
): Promise<CapabilityRefreshResult> {
  const env = options.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {});
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const url = manifestUrl(options, env.CBC_CAPABILITY_URL);
  const overridePath = overrideFile(options, env.CBC_CAPABILITY_OVERRIDE);
  const cachePath = cacheFile(options.cacheDir ?? env.CAPYBARA_CACHE_DIR ?? env.XDG_CACHE_HOME);

  if (overridePath !== undefined && options.host !== undefined) {
    const override = await readOverrideManifest(overridePath, options.host);
    if (override !== undefined) {
      return { manifest: override, source: "override", refreshed: false, snapshots: override.snapshots };
    }
  }

  if (cachePath !== undefined && options.host !== undefined) {
    const cached = await readCachedManifest(cachePath, options.host);
    if (cached !== undefined) {
      if (await isCacheFresh(cachePath, options.host)) {
        return { manifest: cached.manifest, source: "cache", refreshed: false, snapshots: cached.manifest.snapshots };
      }
      const remote = await fetchRemoteManifest(url, fetchImpl, signal);
      if (remote !== undefined) {
        await writeCache(cachePath, remote, options.host);
        return { manifest: remote, source: "remote", refreshed: true, snapshots: remote.snapshots };
      }
      return { manifest: cached.manifest, source: "cache", refreshed: false, snapshots: cached.manifest.snapshots };
    }
  }

  const remote = await fetchRemoteManifest(url, fetchImpl, signal);
  if (remote !== undefined) {
    if (cachePath !== undefined && options.host !== undefined) await writeCache(cachePath, remote, options.host);
    return { manifest: remote, source: "remote", refreshed: true, snapshots: remote.snapshots };
  }

  return {
    manifest: BUNDLED_CAPABILITY_MANIFEST,
    source: "bundled",
    refreshed: false,
    snapshots: BUNDLED_CAPABILITY_MANIFEST.snapshots,
  };
}


export async function refreshCapabilityManifest(
  options: CapabilityRefreshOptions & { env?: Record<string, string | undefined>; force?: boolean } = {},
  signal?: AbortSignal,
): Promise<CapabilityRefreshResult & { error?: string }> {
  const env = options.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {});
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const url = manifestUrl(options, env.CBC_CAPABILITY_URL);
  const cachePath = cacheFile(options.cacheDir ?? env.CAPYBARA_CACHE_DIR ?? env.XDG_CACHE_HOME);
  const remote = await fetchRemoteManifest(url, fetchImpl, signal);
  if (remote !== undefined) {
    if (cachePath !== undefined && options.host !== undefined) await writeCache(cachePath, remote, options.host);
    return { manifest: remote, source: "remote", refreshed: true, snapshots: remote.snapshots };
  }
  if (cachePath !== undefined && options.host !== undefined) {
    const cached = await readCachedManifest(cachePath, options.host);
    if (cached !== undefined) return { manifest: cached.manifest, source: "cache", refreshed: false, snapshots: cached.manifest.snapshots, error: "remote fetch failed; using cached manifest" };
  }
  return { manifest: BUNDLED_CAPABILITY_MANIFEST, source: "bundled", refreshed: false, snapshots: BUNDLED_CAPABILITY_MANIFEST.snapshots, error: "remote fetch failed; using bundled manifest" };
}

export function mergedSnapshots(manifest: CapabilityManifest): readonly ModelCapabilitySnapshot[] {
  return manifest.snapshots;
}

export function activeCapabilityMap(manifest: CapabilityManifest): Map<string, ModelCapabilitySnapshot> {
  const map = new Map<string, ModelCapabilitySnapshot>();
  for (const snap of manifest.snapshots) {
    map.set(snap.modelId.toLowerCase(), snap);
    for (const alias of snap.aliases) map.set(alias.toLowerCase(), snap);
  }
  return map;
}
