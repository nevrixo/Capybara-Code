import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/args.ts";
import { updateCommand } from "../src/commands/update.ts";
import { join, resolvePaths, type Host, type HostFs, type HostIo } from "../src/host.ts";
import { readUpdateStore, updateStorePath, withSkippedVersion, emptyUpdateStore, withCheckResult } from "../src/update-store.ts";
import { EXIT } from "../src/exit.ts";

// ---------------------------------------------------------------------------
// Harness (same shape as the other apps/cbc unit tests)
// ---------------------------------------------------------------------------

interface CommandHost extends Host {
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, string>;
  selections: number[];
}

function createCommandHost(options: {
  isTty?: boolean;
  env?: Record<string, string | undefined>;
  executableDir?: string;
} = {}): CommandHost {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const selections: number[] = [];
  const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

  const io: HostIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    readStdin: async () => "",
    prompt: async () => "",
    select: async () => selections.shift() ?? -1,
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
    remove: async () => undefined,
    isDirectory: async () => false,
  };

  return {
    io,
    fs,
    env: options.env ?? {},
    cwd: "/work/project",
    homeDir: "/home/dev",
    platform: "linux",
    version: "0.1.1-alpha.7",
    executableDir: options.executableDir ?? "/opt/capybara/bin",
    now: () => 1_800_000_000_000,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    out,
    err,
    files,
    selections,
  };
}

function parseSemver(raw: string): { core: readonly [number, number, number]; pre?: string } | undefined {
  const trimmed = raw.trim().replace(/^v/, "");
  const dash = trimmed.indexOf("-");
  const corePart = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const pre = dash === -1 ? undefined : trimmed.slice(dash + 1);
  const numbers: number[] = [];
  for (const piece of corePart.split(".")) {
    if (!/^\d+$/.test(piece)) return undefined;
    numbers.push(Number(piece));
  }
  while (numbers.length < 3) numbers.push(0);
  return {
    core: [numbers[0] as number, numbers[1] as number, numbers[2] as number],
    ...(pre !== undefined ? { pre } : {}),
  };
}

function semverIsNewer(current: string, candidate: string): boolean {
  const cur = parseSemver(current);
  const cand = parseSemver(candidate);
  if (cur === undefined || cand === undefined) return false;
  if (cand.pre !== undefined && cur.pre === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((cur.core[index] ?? 0) !== (cand.core[index] ?? 0)) {
      return (cand.core[index] ?? 0) > (cur.core[index] ?? 0);
    }
  }
  if (cur.pre !== undefined && cand.pre === undefined) return true;
  if (cur.pre !== undefined && cand.pre !== undefined) return cand.pre > cur.pre;
  return false;
}

async function commandContext(options: {
  host: CommandHost;
  version?: string;
  nonInteractive?: boolean;
}) {
  const { CommandContext } = await import("../src/commands/context.ts");
  const { createFakeRuntime } = await import("./fake-runtime.ts");
  const { host } = options;
  host.files.set(join("/opt", "capybara", "libexec", "cbc-runtime"), "");
  const fake = createFakeRuntime({
    handler: ({ method, params }) => {
      if (method !== "update.verify") throw new Error(`unexpected ${method}`);
      const record = params as { currentVersion?: string; candidateVersion?: string };
      return {
        mode: "version-compare",
        updateAvailable: semverIsNewer(record.currentVersion ?? "", record.candidateVersion ?? ""),
      };
    },
  });
  const context = new CommandContext({
    host,
    version: options.version ?? "0.1.1-alpha.7",
    runtimeSpawner: fake.spawner,
    ...(options.nonInteractive === true ? { nonInteractive: true } : {}),
  });
  return context;
}

function releasesBody(newest: string): string {
  return JSON.stringify([
    { tag_name: `v${newest}`, prerelease: newest.includes("-"), published_at: "2026-08-27T00:00:00.000Z" },
  ]);
}

const fetcherOf = (status: number, body: string) => async () => ({ status, body });

describe("capy update (§9.3)", () => {
  test("parses with and without --check", () => {
    expect(parseArgs(["update"]).command).toEqual({ kind: "update" });
    expect(parseArgs(["update", "--check"]).command).toEqual({ kind: "update", check: true });
  });

  test("--check exits 2 when a newer release exists", async () => {
    const host = createCommandHost({ isTty: false });
    const context = await commandContext({ host });
    const result = await updateCommand(context, { check: true }, {
      fetcher: fetcherOf(200, releasesBody("0.1.1-alpha.8")),
    });
    expect(result.code).toBe(2);
    expect(host.out.join("\n")).toContain("update available: 0.1.1-alpha.8");
    await context.shutdown();
  });

  test("--check exits 0 when up to date", async () => {
    const host = createCommandHost({ isTty: false });
    const context = await commandContext({ host });
    const result = await updateCommand(context, { check: true }, {
      fetcher: fetcherOf(200, releasesBody("0.1.1-alpha.7")),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(host.out.join("\n")).toContain("up to date");
    await context.shutdown();
  });

  test("--check exits 1 when the check itself fails", async () => {
    const host = createCommandHost({ isTty: false });
    const context = await commandContext({ host });
    const result = await updateCommand(context, { check: true }, { fetcher: fetcherOf(429, "rate limited") });
    expect(result.code).toBe(EXIT.failure);
    expect(host.err.join("\n")).toContain("update check failed");
    await context.shutdown();
  });

  test("a skipped release is not reported as available", async () => {
    const host = createCommandHost({ isTty: false });
    const context = await commandContext({ host });
    const paths = resolvePaths(host);
    host.files.set(
      updateStorePath(paths),
      JSON.stringify(withSkippedVersion(emptyUpdateStore(), "0.1.1-alpha.8", "")),
    );
    const result = await updateCommand(context, { check: true }, {
      fetcher: fetcherOf(200, releasesBody("0.1.1-alpha.8")),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(host.out.join("\n")).toContain("up to date");
    await context.shutdown();
  });

  test("disabled checks print a note and touch no network", async () => {
    const host = createCommandHost({ env: { CBC_NO_UPDATE_CHECK: "1" } });
    const context = await commandContext({ host });
    let called = false;
    const result = await updateCommand(context, {}, {
      fetcher: async () => {
        called = true;
        return { status: 200, body: "[]" };
      },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(called).toBe(false);
    expect(host.out.join("\n")).toContain("disabled");
    await context.shutdown();
  });

  test("development checkouts never self-update", async () => {
    const host = createCommandHost({ executableDir: "/repo/apps/cbc/src" });
    const context = await commandContext({ host });
    const result = await updateCommand(context, {}, { fetcher: fetcherOf(200, "[]") });
    expect(result.code).toBe(EXIT.ok);
    expect(host.out.join("\n")).toContain("development checkout");
    await context.shutdown();
  });

  test("a non-TTY never installs and reports the exact-version path", async () => {
    const host = createCommandHost({ isTty: false });
    const context = await commandContext({ host, nonInteractive: true });
    const result = await updateCommand(context, {}, {
      fetcher: fetcherOf(200, releasesBody("0.1.1-alpha.8")),
    });
    expect(result.code).toBe(2);
    const text = host.out.join("\n");
    expect(text).toContain("npm install -g capybara-code@0.1.1-alpha.8");
    expect(text).toContain("SHA256SUMS.txt");
    await context.shutdown();
  });

  test("Update now on a TTY prints the guidance and exits successfully", async () => {
    const host = createCommandHost();
    host.selections.push(0);
    const context = await commandContext({ host });
    const result = await updateCommand(context, {}, {
      fetcher: fetcherOf(200, releasesBody("0.1.1-alpha.8")),
    });
    expect(result.code).toBe(EXIT.ok);
    const text = host.out.join("\n");
    expect(text).toContain("A new version of Capybara Code is available");
    expect(text).toContain("npm install -g capybara-code@0.1.1-alpha.8");
    await context.shutdown();
  });

  test("Skip this version persists the decision", async () => {
    const host = createCommandHost();
    host.selections.push(1);
    const context = await commandContext({ host });
    const result = await updateCommand(context, {}, {
      fetcher: fetcherOf(200, releasesBody("0.1.1-alpha.8")),
    });
    expect(result.code).toBe(EXIT.ok);
    const store = await readUpdateStore(host, resolvePaths(host));
    expect(Object.keys(store.skippedVersions)).toEqual(["0.1.1-alpha.8"]);
    await context.shutdown();
  });

  test("the interval cache is ignored for an explicit check", async () => {
    const host = createCommandHost({ isTty: false });
    const context = await commandContext({ host });
    const paths = resolvePaths(host);
    host.files.set(
      updateStorePath(paths),
      JSON.stringify(withCheckResult(emptyUpdateStore(), new Date(host.now()).toISOString(), undefined)),
    );
    let calls = 0;
    const result = await updateCommand(context, { check: true }, {
      fetcher: async () => {
        calls += 1;
        return { status: 200, body: releasesBody("0.1.1-alpha.8") };
      },
    });
    expect(result.code).toBe(2);
    expect(calls).toBe(1);
    await context.shutdown();
  });
});
