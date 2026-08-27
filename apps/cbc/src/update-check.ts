/**
 * Startup update discovery — GitHub Releases is the version truth.
 *
 * The host fetches metadata and asks; it never interprets semver. Installation
 * is handed to the npm/Bun launcher after the native binary exits. Version
 * comparison is delegated to the runtime's `update.verify`
 * (version-compare mode), and every network failure fails open: a dead GitHub
 * must not stop `capy` from starting.
 *
 * The endpoint is the releases *list*, not `/releases/latest`: Public Alpha
 * ships only prereleases, and `latest` hides those forever.
 */

import type { UpdatesConfig } from "@cbc/config-schema";

import type { CommandContext } from "./commands/context.ts";
import { type CbcPaths, type Host } from "./host.ts";
import { safeOAuthRequest } from "./oauth-network.ts";
import {
  emptyUpdateStore,
  readUpdateStore,
  withCheckResult,
  writeUpdateStore,
  type UpdateLastKnown,
  type UpdateStore,
} from "./update-store.ts";

export const UPDATE_REPO_OWNER = "nevrixo";
export const UPDATE_REPO_NAME = "Capybara-Code";
export const UPDATE_REPO_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}`;
export const UPDATE_RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases?per_page=20`;
/** §5.2: the metadata check is capped so startup never waits on the network for long. */
export const UPDATE_CHECK_TIMEOUT_MS = 1_500;
/** §8.1: the releases JSON is capped at 1 MiB. */
export const UPDATE_MAX_METADATA_BYTES = 1024 * 1024;

const ALLOWED_UPDATE_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export class UpdateCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

export interface ReleaseCandidate {
  readonly version: string;
  readonly tag: string;
  /** Built from the pinned repository constant, never from the API's html_url. */
  readonly htmlUrl: string;
  readonly publishedAt?: string;
}

export type VersionComparator = (current: string, candidate: string) => Promise<boolean>;

/** The runtime is the semver authority (§3.1): the host never compares versions itself. */
export function runtimeVersionComparator(context: CommandContext): VersionComparator {
  return async (current, candidate) => {
    const runtime = await context.runtime();
    const result = (await runtime.verifyUpdate({ currentVersion: current, candidateVersion: candidate })) as {
      updateAvailable?: unknown;
    };
    return result.updateAvailable === true;
  };
}

// ---------------------------------------------------------------------------
// §6.1 / §8.2 network
// ---------------------------------------------------------------------------

/** Whether a URL may be contacted at all during an update check. */
export function isAllowedUpdateUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  return ALLOWED_UPDATE_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ""));
}

export interface UpdateFetchOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
}

export interface UpdateFetchResponse {
  readonly status: number;
  readonly body: string;
}

export type UpdateFetcher = (url: string, options: UpdateFetchOptions) => Promise<UpdateFetchResponse>;

/**
 * Hardened GET against the pinned hosts. Reuses the OAuth hardening (DNS pinning,
 * public-address checks, redirect refusal, size caps) and adds the update host
 * allowlist. No request body, no environment tokens: the User-Agent is the only
 * identifier sent (§8.6).
 */
export function createHardenedReleaseFetcher(): UpdateFetcher {
  return async (url, options) => {
    if (!isAllowedUpdateUrl(url)) {
      throw new UpdateCheckError(`update URL is outside the pinned hosts: ${url}`);
    }
    const response = await safeOAuthRequest(url, {
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      headers: {
        "user-agent": options.userAgent,
        accept: "application/vnd.github+json",
      },
    });
    return { status: response.status, body: response.body };
  };
}

// ---------------------------------------------------------------------------
// §6.2 / §8.3 release selection
// ---------------------------------------------------------------------------

export interface GitHubAssetInfo {
  readonly name: string;
  readonly bytes?: number;
  readonly contentType?: string;
  /** Present only when the URL is on an allowed host; untrusted URLs are dropped. */
  readonly downloadUrl?: string;
}

export interface GitHubReleaseInfo {
  readonly tagName: string;
  readonly prerelease: boolean;
  readonly publishedAt?: string;
  readonly assets: readonly GitHubAssetInfo[];
}

/**
 * Parse the releases list strictly: only the fields the update path uses are
 * read, drafts are dropped, and asset URLs that leave the allowlist are not
 * carried forward.
 */
export function parseGitHubReleases(raw: unknown): GitHubReleaseInfo[] {
  if (!Array.isArray(raw)) throw new UpdateCheckError("releases payload is not an array");
  const releases: GitHubReleaseInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.draft === true) continue;
    if (typeof record.tag_name !== "string" || record.tag_name.length === 0) continue;

    const assets: GitHubAssetInfo[] = [];
    if (Array.isArray(record.assets)) {
      for (const asset of record.assets) {
        if (typeof asset !== "object" || asset === null || Array.isArray(asset)) continue;
        const item = asset as Record<string, unknown>;
        if (typeof item.name !== "string" || item.name.length === 0) continue;
        const downloadUrl =
          typeof item.browser_download_url === "string" && isAllowedUpdateUrl(item.browser_download_url)
            ? item.browser_download_url
            : undefined;
        assets.push({
          name: item.name,
          ...(typeof item.size === "number" ? { bytes: item.size } : {}),
          ...(typeof item.content_type === "string" ? { contentType: item.content_type } : {}),
          ...(downloadUrl !== undefined ? { downloadUrl } : {}),
        });
      }
    }

    releases.push({
      tagName: record.tag_name,
      prerelease: record.prerelease === true,
      ...(typeof record.published_at === "string" ? { publishedAt: record.published_at } : {}),
      assets,
    });
  }
  return releases;
}

const TAG_VERSION_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** `v0.1.1-alpha.8` → `0.1.1-alpha.8`. Any other tag shape is ignored (§6.2). */
export function versionFromTag(tag: string): string | undefined {
  return TAG_VERSION_PATTERN.exec(tag)?.[1];
}

/**
 * §6.2 channel mapping. `stable` adds no filter — the runtime's comparison
 * already keeps prereleases away from stable installs. `nightly` behaves like
 * `stable` until it exists.
 */
export function channelAllows(channel: UpdatesConfig["channel"], version: string): boolean {
  if (channel !== "beta") return true;
  const prerelease = version.split("-", 2)[1];
  if (prerelease === undefined) return true;
  return prerelease.includes("beta");
}

export function releaseTagUrl(tag: string): string {
  return `${UPDATE_REPO_URL}/releases/tag/${tag}`;
}

/** Keep only newer releases, then propose the single newest one (§6.2). */
export async function selectNewestRelease(
  releases: readonly GitHubReleaseInfo[],
  currentVersion: string,
  channel: UpdatesConfig["channel"],
  isNewer: VersionComparator,
): Promise<ReleaseCandidate | undefined> {
  let best: { version: string; release: GitHubReleaseInfo } | undefined;
  for (const release of releases) {
    const version = versionFromTag(release.tagName);
    if (version === undefined) continue;
    if (!channelAllows(channel, version)) continue;
    if (!(await isNewer(currentVersion, version))) continue;
    if (best === undefined || (await isNewer(best.version, version))) best = { version, release };
  }
  if (best === undefined) return undefined;
  return {
    version: best.version,
    tag: best.release.tagName,
    htmlUrl: releaseTagUrl(best.release.tagName),
    ...(best.release.publishedAt !== undefined ? { publishedAt: best.release.publishedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// §5.3 gating
// ---------------------------------------------------------------------------

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function looksLikeSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/**
 * Source checkouts run an interpreter over `apps/cbc/src/main.ts`, so the
 * executable directory is the source directory itself. Release binaries —
 * archive or npm platform package — live in a `bin/` directory instead.
 * A development checkout never self-updates (§7.1), and in the first increment
 * it is not even prompted (Q2).
 */
export function isDevelopmentCheckout(host: Pick<Host, "executableDir">): boolean {
  return host.executableDir.replace(/\\/g, "/").endsWith("/apps/cbc/src");
}

export interface UpdateGate {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function updateStartupGate(input: {
  readonly check: boolean;
  readonly isTty: boolean;
  readonly nonInteractive: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly currentVersion: string;
  readonly developmentCheckout: boolean;
}): UpdateGate {
  const deny = (reason: string): UpdateGate => ({ allowed: false, reason });
  if (!input.check) return deny("updates.check is disabled");
  if (input.nonInteractive) return deny("non-interactive run");
  if (!input.isTty) return deny("stdin is not a TTY");
  if (input.env.CI === "true" || input.env.GITHUB_ACTIONS === "true") return deny("CI environment");
  if (input.developmentCheckout) return deny("development checkout");
  if (!looksLikeSemver(input.currentVersion)) return deny("current version is not semver");
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Cache + network resolution
// ---------------------------------------------------------------------------

export interface ResolveUpdateOptions {
  readonly host: Host;
  readonly paths: CbcPaths;
  readonly currentVersion: string;
  readonly channel: UpdatesConfig["channel"];
  readonly intervalHours: number;
  readonly isNewer: VersionComparator;
  readonly fetcher?: UpdateFetcher;
  readonly timeoutMs?: number;
  /** Explicit `capy update`: ignore the interval cache and ask the network. */
  readonly force?: boolean;
  readonly now?: () => number;
}

export interface ResolveUpdateResult {
  readonly candidate?: ReleaseCandidate;
  readonly store: UpdateStore;
  readonly network: boolean;
  readonly error?: string;
}

/**
 * Resolve the newest release from the cache or the network.
 *
 * Non-forced callers may reuse a known release or a fresh negative result.
 * Interactive startup and `capy update` force a network attempt; a known newer
 * release remains a fallback when that attempt fails.
 */
export async function resolveUpdate(options: ResolveUpdateOptions): Promise<ResolveUpdateResult> {
  const store = await readUpdateStore(options.host, options.paths);
  const nowMs = (options.now ?? options.host.now)();
  const cached = await newerCachedCandidate(options.currentVersion, store, options.isNewer);

  if (!options.force && cached !== undefined) return { candidate: cached, store, network: false };

  if (!options.force && store.lastCheckAt !== undefined) {
    const elapsedMs = nowMs - Date.parse(store.lastCheckAt);
    if (Number.isFinite(elapsedMs) && elapsedMs < options.intervalHours * 3_600_000) {
      return { store, network: false };
    }
  }

  const fetcher = options.fetcher ?? createHardenedReleaseFetcher();
  try {
    const response = await fetcher(UPDATE_RELEASES_API_URL, {
      timeoutMs: options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
      maxResponseBytes: UPDATE_MAX_METADATA_BYTES,
      userAgent: `capybara-code/${options.currentVersion}`,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        ...(cached === undefined ? {} : { candidate: cached }),
        store,
        network: true,
        error: `GitHub returned status ${response.status}`,
      };
    }
    const releases = parseGitHubReleases(JSON.parse(response.body));
    const candidate = await selectNewestRelease(releases, options.currentVersion, options.channel, options.isNewer);
    const updated = withCheckResult(
      store,
      new Date(nowMs).toISOString(),
      candidate === undefined
        ? undefined
        : {
            version: candidate.version,
            tag: candidate.tag,
            htmlUrl: candidate.htmlUrl,
            ...(candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt } : {}),
          },
    );
    await writeUpdateStoreSafely(options.host, options.paths, updated);
    return { ...(candidate !== undefined ? { candidate } : {}), store: updated, network: true };
  } catch (error) {
    return {
      ...(cached === undefined ? {} : { candidate: cached }),
      store,
      network: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function newerCachedCandidate(
  currentVersion: string,
  store: UpdateStore,
  isNewer: VersionComparator,
): Promise<ReleaseCandidate | undefined> {
  if (store.lastKnown === undefined) return undefined;
  return (await isNewer(currentVersion, store.lastKnown.version))
    ? candidateFromCache(store.lastKnown)
    : undefined;
}

function candidateFromCache(lastKnown: UpdateLastKnown): ReleaseCandidate {
  return {
    version: lastKnown.version,
    tag: lastKnown.tag,
    htmlUrl: lastKnown.htmlUrl ?? releaseTagUrl(lastKnown.tag),
    ...(lastKnown.publishedAt !== undefined ? { publishedAt: lastKnown.publishedAt } : {}),
  };
}

async function writeUpdateStoreSafely(host: Host, paths: CbcPaths, store: UpdateStore): Promise<void> {
  try {
    await writeUpdateStore(host, paths, store);
  } catch {
    // A failed cache write must never surface as a startup error.
  }
}

// ---------------------------------------------------------------------------
// Interactive startup glue
// ---------------------------------------------------------------------------

export interface UpdateCheckOutcome {
  /** Set when a gate kept the check from running. */
  readonly gate?: string;
  readonly candidate?: ReleaseCandidate;
  readonly store: UpdateStore;
  readonly network: boolean;
  readonly error?: string;
}

export interface UpdateCheckHandle {
  readonly startedAt: number;
  readonly outcome: Promise<UpdateCheckOutcome>;
}

/**
 * Kick the check off before trust is even answered (§5.2), so the GitHub
 * response can arrive while the user reads the trust box.
 */
export function beginUpdateCheck(
  context: CommandContext,
  options: { readonly fetcher?: UpdateFetcher; readonly timeoutMs?: number } = {},
): UpdateCheckHandle {
  return {
    startedAt: context.host.now(),
    outcome: runStartupUpdateCheck(context, options),
  };
}

async function runStartupUpdateCheck(
  context: CommandContext,
  options: { readonly fetcher?: UpdateFetcher; readonly timeoutMs?: number },
): Promise<UpdateCheckOutcome> {
  try {
    const loaded = await context.config();
    const updates = loaded.config.updates;
    const gate = updateStartupGate({
      check: updates.check,
      isTty: context.host.io.isTty,
      nonInteractive: context.nonInteractive,
      env: context.host.env,
      currentVersion: context.version,
      developmentCheckout: isDevelopmentCheckout(context.host),
    });
    if (!gate.allowed) {
      return {
        ...(gate.reason !== undefined ? { gate: gate.reason } : {}),
        store: emptyUpdateStore(),
        network: false,
      };
    }
    return await resolveUpdate({
      host: context.host,
      paths: context.paths,
      currentVersion: context.version,
      channel: updates.channel,
      intervalHours: updates.intervalHours,
      isNewer: runtimeVersionComparator(context),
      force: true,
      ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (error) {
    return {
      store: emptyUpdateStore(),
      network: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SettledUpdateCheck {
  /** The candidate to prompt for, when the check finished inside the cap. */
  readonly candidate?: ReleaseCandidate;
  /** Resolves once a late check confirms a release, for the fallback banner. */
  readonly late?: Promise<ReleaseCandidate | undefined>;
}

/**
 * Wait for the parallel check up to the hard cap (§5.2). A late result is not
 * lost — it is handed back so the TUI can raise the fallback banner.
 */
export async function settleUpdateCheck(
  context: CommandContext,
  handle: UpdateCheckHandle,
  options: { timeoutMs?: number } = {},
): Promise<SettledUpdateCheck> {
  const cap = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const remainingMs = handle.startedAt + cap - context.host.now();

  if (remainingMs > 0) {
    try {
      const outcome = await withDeadline(handle.outcome, remainingMs);
      return outcome.candidate === undefined ? {} : { candidate: outcome.candidate };
    } catch {
      // The cap expired; fall through to the late path.
    }
  }

  const late = handle.outcome.then((outcome) => outcome.candidate).catch(() => undefined);
  return { late };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpdateCheckError("update check timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
