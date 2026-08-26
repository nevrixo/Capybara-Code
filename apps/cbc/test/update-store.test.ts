import { describe, expect, test } from "bun:test";

import { resolvePaths, type Host } from "../src/host.ts";
import {
  emptyUpdateStore,
  isVersionSkipped,
  parseUpdateStore,
  readUpdateStore,
  updateStorePath,
  withCheckResult,
  withSkippedVersion,
  writeUpdateStore,
} from "../src/update-store.ts";

function fakeHost(files = new Map<string, string>()): Host {
  const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    io: {
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: async () => "",
      prompt: async () => "",
      select: async () => -1,
      isTty: false,
      columns: 100,
      rows: 30,
    },
    fs: {
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
    },
    env: {},
    cwd: "/work/project",
    homeDir: "/home/dev",
    platform: "linux",
    version: "0.1.0-test",
    executableDir: "/opt/capybara/bin",
    now: () => 1_800_000_000_000,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

// A stand-in for the runtime's `is_newer` so store tests stay sidecar-free.
// The direction matches `update.verify`: true when `candidate` is newer.
function fakeIsNewer(order: readonly string[]): (current: string, candidate: string) => Promise<boolean> {
  return async (current, candidate) => {
    const a = order.indexOf(current);
    const b = order.indexOf(candidate);
    return a !== -1 && b !== -1 && b > a;
  };
}

describe("update store (§6.3)", () => {
  test("a missing store is empty", async () => {
    const host = fakeHost();
    const store = await readUpdateStore(host, resolvePaths(host));
    expect(store).toEqual(emptyUpdateStore());
  });

  test("the store lives in the user data directory, not the project", () => {
    const host = fakeHost();
    const paths = resolvePaths(host);
    expect(updateStorePath(paths)).toBe(`${paths.data}/updates.json`);
    expect(updateStorePath(paths).includes("/work/project")).toBe(false);
  });

  test("a valid store round-trips through write and read", async () => {
    const host = fakeHost();
    const paths = resolvePaths(host);
    const store = withSkippedVersion(
      withCheckResult(emptyUpdateStore(), "2026-08-27T12:00:00.000Z", {
        version: "0.1.1-alpha.8",
        tag: "v0.1.1-alpha.8",
        htmlUrl: "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
        publishedAt: "2026-08-27T00:00:00.000Z",
      }),
      "0.1.1-alpha.8",
      "2026-08-27T12:01:00.000Z",
    );
    await writeUpdateStore(host, paths, store);
    expect(await readUpdateStore(host, paths)).toEqual(store);
  });

  test("an unknown schema version fails closed to an empty store", () => {
    expect(parseUpdateStore({ version: 2, skippedVersions: { "1.0.0": { decidedAt: "" } } }))
      .toEqual(emptyUpdateStore());
    expect(parseUpdateStore({ skippedVersions: {} })).toEqual(emptyUpdateStore());
  });

  test("corrupt JSON and non-objects fail closed without throwing", async () => {
    for (const parsed of [[1, 2], "array", null, 42]) {
      expect(parseUpdateStore(parsed)).toEqual(emptyUpdateStore());
    }
    const files = new Map<string, string>();
    const host = fakeHost(files);
    const paths = resolvePaths(host);
    files.set(updateStorePath(paths), "{truncated");
    expect(await readUpdateStore(host, paths)).toEqual(emptyUpdateStore());
  });

  test("malformed entries are dropped, valid siblings kept", () => {
    const store = parseUpdateStore({
      version: 1,
      lastCheckAt: "not-a-date",
      lastKnown: { version: "not-semver", tag: "v?" },
      skippedVersions: {
        "0.1.1-alpha.8": { decidedAt: "2026-08-27T12:01:00.000Z" },
        "../../etc/passwd": { decidedAt: "" },
        "1.0.0": "not-an-object",
      },
    });
    expect(store.lastCheckAt).toBeUndefined();
    expect(store.lastKnown).toBeUndefined();
    expect(Object.keys(store.skippedVersions)).toEqual(["0.1.1-alpha.8"]);
  });

  test("a skip covers its own version and older releases", async () => {
    const order = ["0.1.1-alpha.7", "0.1.1-alpha.8", "0.1.1-alpha.9"];
    const isNewer = fakeIsNewer(order);
    const store = withSkippedVersion(emptyUpdateStore(), "0.1.1-alpha.8", "");

    expect(await isVersionSkipped(store, "0.1.1-alpha.8", isNewer)).toBe(true);
    expect(await isVersionSkipped(store, "0.1.1-alpha.7", isNewer)).toBe(true);
    expect(await isVersionSkipped(store, "0.1.1-alpha.9", isNewer)).toBe(false);
    expect(await isVersionSkipped(emptyUpdateStore(), "0.1.1-alpha.8", isNewer)).toBe(false);
  });
});
