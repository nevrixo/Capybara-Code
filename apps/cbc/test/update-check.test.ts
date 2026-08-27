import { describe, expect, test } from "bun:test";

import { CommandContext } from "../src/commands/context.ts";
import { join, resolvePaths, type Host, type HostFs, type HostIo } from "../src/host.ts";
import {
  beginUpdateCheck,
  channelAllows,
  isAllowedUpdateUrl,
  isDevelopmentCheckout,
  looksLikeSemver,
  parseGitHubReleases,
  resolveUpdate,
  selectNewestRelease,
  settleUpdateCheck,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_RELEASES_API_URL,
  updateStartupGate,
  versionFromTag,
  type UpdateFetcher,
  type VersionComparator,
} from "../src/update-check.ts";
import { emptyUpdateStore, updateStorePath, withCheckResult, withSkippedVersion } from "../src/update-store.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeHost extends Host {
  readonly files: Map<string, string>;
  readonly out: string[];
}

function createFakeHost(options: {
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  executableDir?: string;
  now?: () => number;
} = {}): FakeHost {
  const files = new Map<string, string>();
  const out: string[] = [];
  const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

  const io: HostIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => undefined,
    readStdin: async () => "",
    prompt: async () => "",
    select: async () => -1,
    isTty: options.isTty ?? true,
    columns: 100,
    rows: 30,
  };

  const fs: HostFs = {
    read: async (path) => files.get(normalize(path)),
    write: async (path, content) => {
      files.set(normalize(path), content);
    },
    atomicWrite: async (path, content) => {
      files.set(normalize(path), content);
    },
    exists: async (path) => files.has(normalize(path)),
    list: async () => [],
    mkdirp: async () => undefined,
    remove: async (path) => {
      files.delete(normalize(path));
    },
    isDirectory: async () => false,
  };

  return {
    io,
    fs,
    env: options.env ?? {},
    cwd: "/work/project",
    homeDir: "/home/dev",
    platform: "linux",
    version: "0.1.0-test",
    executableDir: options.executableDir ?? "/opt/capybara/bin",
    now: options.now ?? (() => 1_800_000_000_000),
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    files,
    out,
  };
}

/** Mirrors `cbc_update::is_newer` so fixture tests stay sidecar-free. */
function parseSemver(raw: string): { core: readonly [number, number, number]; pre?: string } | undefined {
  const trimmed = raw.trim().replace(/^v/, "");
  const dash = trimmed.indexOf("-");
  const corePart = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const pre = dash === -1 ? undefined : trimmed.slice(dash + 1);
  const pieces = corePart.split(".");
  const numbers: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const piece = pieces[index] ?? "0";
    if (!/^\d+$/.test(piece)) return undefined;
    numbers.push(Number(piece));
  }
  return { core: [numbers[0] as number, numbers[1] as number, numbers[2] as number], ...(pre !== undefined ? { pre } : {}) };
}

function semverIsNewer(current: string, candidate: string): boolean {
  const cur = parseSemver(current);
  const cand = parseSemver(candidate);
  if (cur === undefined || cand === undefined) return false;
  if (cand.pre !== undefined && cur.pre === undefined) return false;
  const compareCore = (a: readonly number[], b: readonly number[]): number => {
    for (let index = 0; index < 3; index += 1) {
      if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
    }
    return 0;
  };
  const coreOrder = compareCore([...cur.core], [...cand.core]);
  if (coreOrder !== 0) return coreOrder < 0;
  if (cur.pre !== undefined && cand.pre === undefined) return true;
  if (cur.pre !== undefined && cand.pre !== undefined) return cand.pre > cur.pre;
  return false;
}

const compare: VersionComparator = async (current, candidate) => semverIsNewer(current, candidate);

function release(tagName: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag_name: tagName, prerelease: tagName.includes("-"), ...overrides };
}

function fetcherReturning(body: string, calls: string[], status = 200): UpdateFetcher {
  return async (url) => {
    calls.push(url);
    return { status, body };
  };
}

const RELEASE_LIST = JSON.stringify([
  release("v0.1.1-alpha.8", {
    published_at: "2026-08-27T00:00:00.000Z",
    assets: [
      {
        name: "capybara-code-0.1.1-alpha.8-linux-x64.tar.gz",
        size: 1024,
        content_type: "application/gzip",
        browser_download_url: "https://github.com/nevrixo/Capybara-Code/releases/download/v0.1.1-alpha.8/capybara-code-0.1.1-alpha.8-linux-x64.tar.gz",
      },
      { name: "SHA256SUMS.txt", size: 200, browser_download_url: "https://evil.example/SHA256SUMS.txt" },
    ],
  }),
  release("v0.1.1-alpha.7"),
  release("v0.2.0-beta.1"),
  release("v9.9.9", { draft: true }),
  release("release-notes"),
]);

// ---------------------------------------------------------------------------
// §6.2 release selection
// ---------------------------------------------------------------------------

describe("release selection (§6.2)", () => {
  test("tags are read only with a v prefix", () => {
    expect(versionFromTag("v0.1.1-alpha.8")).toBe("0.1.1-alpha.8");
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("0.1.1-alpha.8")).toBeUndefined();
    expect(versionFromTag("release-1.2.3")).toBeUndefined();
    expect(versionFromTag("v1.2")).toBeUndefined();
  });

  test("drafts are dropped at parse time", () => {
    const releases = parseGitHubReleases(JSON.parse(RELEASE_LIST));
    expect(releases.map((entry) => entry.tagName)).toEqual([
      "v0.1.1-alpha.8",
      "v0.1.1-alpha.7",
      "v0.2.0-beta.1",
      "release-notes",
    ]);
  });

  test("non-v tag shapes are ignored during selection", async () => {
    const releases = parseGitHubReleases([{ tag_name: "release-notes" }, { tag_name: "1.0.1" }]);
    expect(await selectNewestRelease(releases, "1.0.0", "stable", compare)).toBeUndefined();
  });

  test("a payload that is not an array is rejected", () => {
    expect(() => parseGitHubReleases({ tag_name: "v1.0.0" })).toThrow();
    expect(() => parseGitHubReleases("nope")).toThrow();
  });

  test("asset URLs outside the allowlist are dropped", () => {
    const releases = parseGitHubReleases(JSON.parse(RELEASE_LIST));
    const assets = releases[0]!.assets;
    expect(assets[0]?.downloadUrl).toContain("github.com");
    expect(assets[1]?.downloadUrl).toBeUndefined();
  });

  test("the newest newer release wins; a stable install sees no prerelease", async () => {
    const releases = parseGitHubReleases(JSON.parse(RELEASE_LIST));
    const alpha = await selectNewestRelease(releases, "0.1.1-alpha.7", "stable", compare);
    // 0.2.0-beta.1 is newer than 0.1.1-alpha.8, and a prerelease install may
    // be offered newer prereleases.
    expect(alpha?.version).toBe("0.2.0-beta.1");

    const stable = await selectNewestRelease(releases, "1.0.0", "stable", compare);
    expect(stable).toBeUndefined();
  });

  test("the same or an older version offers nothing", async () => {
    const releases = parseGitHubReleases([{ tag_name: "v0.1.1-alpha.7" }]);
    expect(await selectNewestRelease(releases, "0.1.1-alpha.7", "stable", compare)).toBeUndefined();
    expect(await selectNewestRelease(releases, "0.1.1-alpha.9", "stable", compare)).toBeUndefined();
  });

  test("the beta channel keeps beta and stable candidates only", async () => {
    expect(channelAllows("beta", "0.2.0-beta.1")).toBe(true);
    expect(channelAllows("beta", "1.0.0")).toBe(true);
    expect(channelAllows("beta", "0.1.1-alpha.8")).toBe(false);
    expect(channelAllows("stable", "0.1.1-alpha.8")).toBe(true);
    expect(channelAllows("nightly", "0.1.1-alpha.8")).toBe(true);
  });

  test("broken versions never turn an update on", async () => {
    expect(await compare("not-a-version", "1.0.0")).toBe(false);
    expect(await compare("1.0.0", "not-a-version")).toBe(false);
    expect(looksLikeSemver("0.1.1-alpha.7")).toBe(true);
    expect(looksLikeSemver("dev-build")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.1 / §8.2 pinned network policy
// ---------------------------------------------------------------------------

describe("update network policy (§6.1, §8.2)", () => {
  test("discovery uses the releases list, never /releases/latest", () => {
    expect(UPDATE_RELEASES_API_URL).toBe(
      "https://api.github.com/repos/nevrixo/Capybara-Code/releases?per_page=20",
    );
    expect(UPDATE_RELEASES_API_URL.includes("/releases/latest")).toBe(false);
  });

  test("only the pinned hosts are contactable", () => {
    expect(isAllowedUpdateUrl("https://api.github.com/repos/nevrixo/Capybara-Code/releases")).toBe(true);
    expect(isAllowedUpdateUrl("https://objects.githubusercontent.com/x")).toBe(true);
    expect(isAllowedUpdateUrl("https://release-assets.githubusercontent.com/x")).toBe(true);
    expect(isAllowedUpdateUrl("https://evil.example/releases")).toBe(false);
    expect(isAllowedUpdateUrl("http://api.github.com/releases")).toBe(false);
    expect(isAllowedUpdateUrl("https://user:pass@api.github.com/releases")).toBe(false);
    expect(isAllowedUpdateUrl("https://127.0.0.1/releases")).toBe(false);
    expect(isAllowedUpdateUrl("not a url")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5.3 gating
// ---------------------------------------------------------------------------

describe("update gates (§5.3)", () => {
  const base = {
    check: true,
    isTty: true,
    nonInteractive: false,
    env: {},
    currentVersion: "0.1.1-alpha.7",
    developmentCheckout: false,
  };

  test("all gates open allows the check", () => {
    expect(updateStartupGate(base)).toEqual({ allowed: true });
  });

  test("updates.check = false blocks the network", () => {
    expect(updateStartupGate({ ...base, check: false }).allowed).toBe(false);
  });

  test("headless and piped runs are skipped", () => {
    expect(updateStartupGate({ ...base, nonInteractive: true }).allowed).toBe(false);
    expect(updateStartupGate({ ...base, isTty: false }).allowed).toBe(false);
  });

  test("CI environments are skipped", () => {
    expect(updateStartupGate({ ...base, env: { CI: "true" } }).allowed).toBe(false);
    expect(updateStartupGate({ ...base, env: { GITHUB_ACTIONS: "true" } }).allowed).toBe(false);
  });

  test("development checkouts are skipped", () => {
    expect(updateStartupGate({ ...base, developmentCheckout: true }).allowed).toBe(false);
    expect(isDevelopmentCheckout({ executableDir: "/repo/apps/cbc/src" })).toBe(true);
    expect(isDevelopmentCheckout({ executableDir: "/opt/capybara/bin" })).toBe(false);
    expect(isDevelopmentCheckout({ executableDir: "C:/repo/apps/cbc/src" })).toBe(true);
  });

  test("a non-semver current version is skipped", () => {
    expect(updateStartupGate({ ...base, currentVersion: "dev" }).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6.3 cache behaviour
// ---------------------------------------------------------------------------

describe("update cache and network resolution (§6.3)", () => {
  test("a known-new unskipped release prompts without touching the network", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const store = withCheckResult(emptyUpdateStore(), "2020-01-01T00:00:00.000Z", {
      version: "0.1.1-alpha.8",
      tag: "v0.1.1-alpha.8",
    });
    host.files.set(updateStorePath(paths), JSON.stringify(store));
    const calls: string[] = [];

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning("[]", calls),
    });

    expect(result.network).toBe(false);
    expect(result.candidate?.version).toBe("0.1.1-alpha.8");
    expect(result.candidate?.htmlUrl).toBe(
      "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
    );
    expect(calls).toEqual([]);
  });

  test("a fresh negative cache avoids the network", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const store = withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), undefined);
    host.files.set(updateStorePath(paths), JSON.stringify(store));
    const calls: string[] = [];

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning(RELEASE_LIST, calls),
    });

    expect(result.network).toBe(false);
    expect(result.candidate).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("a stale cache fetches and records the outcome", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const calls: string[] = [];

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning(RELEASE_LIST, calls),
    });

    expect(calls).toEqual([UPDATE_RELEASES_API_URL]);
    expect(result.network).toBe(true);
    expect(result.candidate?.version).toBe("0.2.0-beta.1");
    const written = JSON.parse(host.files.get(updateStorePath(paths)) ?? "{}") as Record<string, unknown>;
    expect(written.lastCheckAt).toBe(new Date(host.now()).toISOString());
    expect((written.lastKnown as Record<string, unknown>)?.version).toBe("0.2.0-beta.1");
  });

  test("force ignores a fresh cache (explicit capy update)", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const store = withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), undefined);
    host.files.set(updateStorePath(paths), JSON.stringify(store));
    const calls: string[] = [];

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning(RELEASE_LIST, calls),
      force: true,
    });

    expect(result.network).toBe(true);
    expect(calls).toEqual([UPDATE_RELEASES_API_URL]);
  });

  test("a legacy skipped last-known release is eligible for next-run reminders", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const store = withSkippedVersion(
      withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), {
        version: "0.1.1-alpha.8",
        tag: "v0.1.1-alpha.8",
      }),
      "0.1.1-alpha.8",
      new Date(host.now()).toISOString(),
    );
    host.files.set(updateStorePath(paths), JSON.stringify(store));
    const calls: string[] = [];

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning(RELEASE_LIST, calls),
    });

    expect(result.network).toBe(false);
    expect(result.candidate?.version).toBe("0.1.1-alpha.8");
    expect(calls).toEqual([]);
  });

  test("force bypasses a known-positive cache as well as a negative cache", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const store = withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), {
      version: "0.1.1-alpha.8",
      tag: "v0.1.1-alpha.8",
    });
    host.files.set(updateStorePath(paths), JSON.stringify(store));
    const calls: string[] = [];

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning(RELEASE_LIST, calls),
      force: true,
    });

    expect(result.network).toBe(true);
    expect(calls).toEqual([UPDATE_RELEASES_API_URL]);
    expect(result.candidate?.version).toBe("0.2.0-beta.1");
  });

  test("a forced check falls back to a known candidate when the network fails", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    const store = withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), {
      version: "0.1.1-alpha.8",
      tag: "v0.1.1-alpha.8",
    });
    host.files.set(updateStorePath(paths), JSON.stringify(store));

    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning("rate limited", [], 429),
      force: true,
    });

    expect(result.network).toBe(true);
    expect(result.error).toContain("429");
    expect(result.candidate?.version).toBe("0.1.1-alpha.8");
  });

  test("check failures fail open and do not poison the cache", async () => {
    for (const fetcher of [
      fetcherReturning("rate limited", [], 429),
      fetcherReturning("{not json", [], 200),
      fetcherReturning(JSON.stringify({ message: "not an array" }), [], 200),
    ]) {
      const host = createFakeHost();
      const paths = resolvePaths(host);
      const result = await resolveUpdate({
        host,
        paths,
        currentVersion: "0.1.1-alpha.7",
        channel: "stable",
        intervalHours: 24,
        isNewer: compare,
        fetcher,
      });
      expect(result.candidate).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(host.files.has(updateStorePath(paths))).toBe(false);
    }
  });

  test("a corrupt updates.json is read as an empty store", async () => {
    const host = createFakeHost();
    const paths = resolvePaths(host);
    host.files.set(updateStorePath(paths), "{\"version\":1,\"skippedVersions\":");
    const calls: string[] = [];
    const result = await resolveUpdate({
      host,
      paths,
      currentVersion: "0.1.1-alpha.7",
      channel: "stable",
      intervalHours: 24,
      isNewer: compare,
      fetcher: fetcherReturning("[]", calls),
    });
    expect(result.candidate).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(calls).toEqual([UPDATE_RELEASES_API_URL]);
  });
});

// ---------------------------------------------------------------------------
// §5.2 startup settlement against the real RPC seam
// ---------------------------------------------------------------------------

describe("startup update settlement (§5.2)", () => {
  async function fakeContext(options: {
    handler?: (request: { method: string; params: unknown }) => unknown;
    now?: () => number;
    env?: Record<string, string | undefined>;
  } = {}) {
    const { createFakeRuntime } = await import("./fake-runtime.ts");
    const host = createFakeHost({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    host.files.set(join("/opt", "capybara", "libexec", "cbc-runtime"), "");
    const fake = createFakeRuntime(
      options.handler !== undefined
        ? { handler: options.handler }
        : {
            handler: ({ method, params }) => {
              if (method !== "update.verify") throw new Error(`unexpected ${method}`);
              const record = params as { currentVersion?: string; candidateVersion?: string };
              return {
                mode: "version-compare",
                updateAvailable: semverIsNewer(record.currentVersion ?? "", record.candidateVersion ?? ""),
              };
            },
          },
    );
    const context = new CommandContext({ host, version: "0.1.1-alpha.7", runtimeSpawner: fake.spawner });
    return { context, host, requests: fake.requests };
  }

  test("a slow check settles late instead of blocking startup", async () => {
    let releaseFetch!: (value: { status: number; body: string }) => void;
    const pending = new Promise<{ status: number; body: string }>((resolve) => {
      releaseFetch = resolve;
    });

    const { context } = await fakeContext();

    // Drive settleUpdateCheck against a handle whose outcome arrives after the cap.
    const startedAt = context.host.now();
    const handle = {
      startedAt,
      outcome: pending.then((response) => ({
        store: emptyUpdateStore(),
        network: true,
        ...(response.status === 200
          ? {
              candidate: {
                version: "0.1.1-alpha.8",
                tag: "v0.1.1-alpha.8",
                htmlUrl: "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
              },
            }
          : {}),
      })),
    };

    const settlePromise = settleUpdateCheck(context, handle, { timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const early = await settlePromise;
    expect(early.candidate).toBeUndefined();
    expect(early.late).toBeDefined();

    releaseFetch({ status: 200, body: RELEASE_LIST });
    expect((await early.late)?.version).toBe("0.1.1-alpha.8");
    await context.shutdown();
  });

  test("a fast check yields a prompt candidate", async () => {
    const { context } = await fakeContext();
    // Legacy skip records no longer suppress next-run reminders.
    const store = withSkippedVersion(emptyUpdateStore(), "0.1.1-alpha.6", "");
    const handle = {
      startedAt: context.host.now(),
      outcome: Promise.resolve({
        store,
        network: true,
        candidate: {
          version: "0.1.1-alpha.8",
          tag: "v0.1.1-alpha.8",
          htmlUrl: "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
        },
      }),
    };
    const settled = await settleUpdateCheck(context, handle);
    expect(settled.candidate?.version).toBe("0.1.1-alpha.8");
    await context.shutdown();
  });

  test("a legacy skipped candidate reaches the prompt on the next run", async () => {
    const { context } = await fakeContext();
    const store = withSkippedVersion(emptyUpdateStore(), "0.1.1-alpha.8", "");
    const handle = {
      startedAt: context.host.now(),
      outcome: Promise.resolve({
        store,
        network: true,
        candidate: {
          version: "0.1.1-alpha.8",
          tag: "v0.1.1-alpha.8",
          htmlUrl: "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
        },
      }),
    };
    const settled = await settleUpdateCheck(context, handle);
    expect(settled.candidate?.version).toBe("0.1.1-alpha.8");
    expect(settled.late).toBeUndefined();
    await context.shutdown();
  });

  test("beginUpdateCheck fails open when the runtime is unavailable", async () => {
    const host = createFakeHost();
    // No runtime binary anywhere: the comparison cannot run.
    const context = new CommandContext({ host, version: "0.1.1-alpha.7" });
    const paths = resolvePaths(host);
    host.files.set(
      updateStorePath(paths),
      JSON.stringify(withCheckResult(emptyUpdateStore(), "2020-01-01T00:00:00.000Z", undefined)),
    );

    const handle = beginUpdateCheck(context, {
      fetcher: fetcherReturning(RELEASE_LIST, []),
    });
    const outcome = await handle.outcome;
    expect(outcome.candidate).toBeUndefined();
    expect(outcome.error).toBeDefined();
  });

  test("beginUpdateCheck asks the network on every start despite a fresh negative cache", async () => {
    const { context, host } = await fakeContext();
    const paths = resolvePaths(host);
    host.files.set(
      updateStorePath(paths),
      JSON.stringify(withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), undefined)),
    );
    const calls: string[] = [];

    const handle = beginUpdateCheck(context, {
      fetcher: fetcherReturning(RELEASE_LIST, calls),
    });
    const outcome = await handle.outcome;

    expect(outcome.network).toBe(true);
    expect(calls).toEqual([UPDATE_RELEASES_API_URL]);
    expect(outcome.candidate?.version).toBe("0.2.0-beta.1");
    await context.shutdown();
  });

  test("CBC_NO_UPDATE_CHECK keeps the check gated before any fetch", async () => {
    const { context } = await fakeContext({ env: { CBC_NO_UPDATE_CHECK: "1" } });
    const handle = beginUpdateCheck(context);
    const outcome = await handle.outcome;
    expect(outcome.gate).toBeDefined();
    expect(outcome.network).toBe(false);
    expect(outcome.candidate).toBeUndefined();
    await context.shutdown();
  });

  test("the startup cap constant is the documented 1500ms", () => {
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(1500);
  });
});
