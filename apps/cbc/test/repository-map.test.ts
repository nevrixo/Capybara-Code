import { describe, expect, test } from "bun:test";

import { warmContext } from "../src/bootstrap.ts";
import { workspaceIdentityFor } from "../src/host.ts";
import {
  readRepositoryScanCache,
  repositoryGitIdentityFromStatus,
  repositoryMapCachePath,
  scanRepository,
  scanRepositoryDelta,
  writeRepositoryScanCache,
} from "../src/repository-map.ts";

describe("repository-map startup warmup", () => {
  test("glob and git diff start in parallel", async () => {
    const started: string[] = [];
    let resolveGlob!: (value: unknown) => void;
    let resolveDiff!: (value: unknown) => void;
    const runtime = {
      glob: () => {
        started.push("glob");
        return new Promise<unknown>((resolve) => { resolveGlob = resolve; });
      },
      gitDiff: () => {
        started.push("diff");
        return new Promise<unknown>((resolve) => { resolveDiff = resolve; });
      },
      gitStatus: async () => ({ status: {}, statusBar: "" }),
    };

    const pending = scanRepository(runtime as never);
    expect(started).toEqual(["glob", "diff"]);
    resolveDiff({ files: [{ path: "src/main.ts" }] });
    resolveGlob({ entries: [{ path: "src/main.ts", bytes: 12, kind: "file" }] });
    const scan = await pending;
    expect(scan.files[0]?.path).toBe("src/main.ts");
    expect(scan.dirtyPaths).toEqual(["src/main.ts"]);
  });

  test("a failed git diff does not discard a successful directory walk", async () => {
    const scan = await scanRepository({
      glob: async () => ({ entries: ["README.md"] }),
      gitDiff: async () => { throw new Error("not git"); },
      gitStatus: async () => ({ status: { isRepository: false }, statusBar: "no git" }),
    } as never);
    expect(scan.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(scan.dirtyPaths).toBeUndefined();
  });

  test("propagates a truncated directory walk", async () => {
    const scan = await scanRepository({
      glob: async () => ({ entries: [{ path: "src/a.ts", kind: "file" }], truncated: true }),
      gitDiff: async () => ({ files: [] }),
      gitStatus: async () => ({ status: {}, statusBar: "" }),
    } as never);
    expect(scan.truncated).toBe(true);
  });

  test("refreshes known paths with parallel exact probes and reports deletions", async () => {
    const started: string[] = [];
    const delta = await scanRepositoryDelta({
      glob: async (pattern: string) => {
        started.push(`glob:${pattern}`);
        return pattern === "src/live.ts"
          ? { entries: [{ path: pattern, bytes: 4, kind: "file" }] }
          : { entries: [] };
      },
      list: async (path: string) => {
        started.push(`list:${path}`);
        return path === "src/live.ts"
          ? { entries: [{ path, bytes: 9, kind: "file", modifiedMs: 12 }] }
          : { entries: [] };
      },
      gitDiff: async () => ({ files: [] }),
      gitStatus: async () => ({ status: {}, statusBar: "" }),
    } as never, ["src/missing.ts", "src/live.ts"]);

    expect(started).toEqual([
      "glob:src/live.ts",
      "list:src/live.ts",
      "glob:src/missing.ts",
      "list:src/missing.ts",
    ]);
    expect(delta.files).toEqual([{
      path: "src/live.ts",
      bytes: 9,
      binary: false,
      tracked: true,
      modifiedMs: 12,
    }]);
    expect(delta.removedPaths).toEqual(["src/missing.ts"]);
  });

  test("Git cache identity covers normalized HEAD, index, worktree, rename, and untracked state", () => {
    const identity = (overrides: Record<string, unknown> = {}) => repositoryGitIdentityFromStatus({
      status: {
        isRepository: true,
        head: "aaa",
        staged: 1,
        unstaged: 1,
        untracked: 1,
        dirty: true,
        entries: [
          { path: "src/b.ts", indexStatus: "added", worktreeStatus: null },
          { path: "src\\a.ts", originalPath: "src/old-a.ts", indexStatus: "renamed", worktreeStatus: "modified" },
          { path: "new.txt", indexStatus: null, worktreeStatus: "untracked" },
        ],
        ...overrides,
      },
      statusBar: "",
    } as never);

    const base = identity();
    const reorderedAndNormalized = identity({
      entries: [
        { path: "new.txt", indexStatus: null, worktreeStatus: "untracked" },
        { path: "src/a.ts", originalPath: "src/old-a.ts", indexStatus: "renamed", worktreeStatus: "modified" },
        { path: "src/b.ts", indexStatus: "added", worktreeStatus: null },
      ],
    });
    expect(reorderedAndNormalized).toEqual(base);
    expect(identity({ head: "bbb" }).head).not.toBe(base.head);
    expect(identity({ staged: 2 }).index).not.toBe(base.index);
    expect(identity({ unstaged: 2 }).index).not.toBe(base.index);
    expect(identity({ untracked: 2 }).index).not.toBe(base.index);
    expect(identity({
      entries: [{ path: "src/a.ts", indexStatus: "renamed", worktreeStatus: "deleted", originalPath: "src/old-a.ts" }],
    }).index).not.toBe(base.index);
  });

  test("warmContext uses a matching cache immediately and refreshes in background", async () => {
    const disk = new Map<string, string>();
    const fs = {
      read: async (path: string) => disk.get(path),
      write: async (path: string, content: string) => { disk.set(path, content); },
      atomicWrite: async (path: string, content: string) => { disk.set(path, content); },
      exists: async (path: string) => disk.has(path),
      list: async () => [],
      mkdirp: async () => undefined,
      remove: async () => undefined,
      isDirectory: async () => false,
      statIdentity: async () => "1:2",
    };
    const host = {
      fs,
      now: () => 100,
    };
    const workspacePath = "/work/project";
    const workspace = await workspaceIdentityFor(host, workspacePath);
    const status = { status: { isRepository: true, head: "abc", entries: [] }, statusBar: "" };
    const cacheIdentity = {
      workspaceIdentityDigest: workspace.workspaceDigest,
      git: repositoryGitIdentityFromStatus(status),
    };
    const cachePath = repositoryMapCachePath("/cache", workspace.workspaceDigest);
    await writeRepositoryScanCache(
      host as never,
      cachePath,
      cacheIdentity,
      { files: [{ path: "cached.ts", bytes: 1, binary: false, tracked: true }] },
      1,
    );

    let resolveGlob!: (value: unknown) => void;
    const runtime = {
      gitStatus: async () => status,
      gitDiff: async () => ({ files: [] }),
      glob: async () => await new Promise<unknown>((resolve) => { resolveGlob = resolve; }),
    };
    const provisional: string[][] = [];
    const fresh: string[][] = [];
    let trackedRefresh: Promise<unknown> | undefined;
    const context = {
      runtime: async () => runtime,
      host,
      workspacePath,
      paths: { cache: "/cache" },
    };
    const session = {
      workspaceGeneration: 0,
      performanceTelemetryEnabled: false,
      orientationMode: "progressive",
      prewarmProvider: async () => undefined,
      context: {
        ingestCachedScan: (scan: { files: Array<{ path: string }> }) => {
          provisional.push(scan.files.map((file) => file.path));
        },
      },
      ingestRepositoryScan: (scan: { files: Array<{ path: string }> }) => {
        fresh.push(scan.files.map((file) => file.path));
        return true;
      },
      trackRepositoryRefresh: (refresh: Promise<unknown>) => {
        trackedRefresh = refresh;
      },
    };

    const warmed = await warmContext(context as never, session as never);
    expect(warmed.cacheHit).toBe(true);
    expect(warmed.files).toBe(1);
    expect(provisional).toEqual([["cached.ts"]]);
    expect(fresh).toEqual([]);
    expect(trackedRefresh).toBe(warmed.refresh);

    resolveGlob({ entries: [{ path: "fresh.ts", bytes: 2, kind: "file" }] });
    expect((await warmed.refresh)?.files).toBe(1);
    expect(provisional).toEqual([["cached.ts"]]);
    expect(fresh).toEqual([["fresh.ts"]]);
  });

  test("disk scan cache round-trips under a workspace-safe path", async () => {
    const files = new Map<string, string>();
    const fs = {
      read: async (path: string) => files.get(path),
      write: async (path: string, content: string) => { files.set(path, content); },
      atomicWrite: async (path: string, content: string) => { files.set(path, content); },
      exists: async (path: string) => files.has(path),
      list: async () => [],
      mkdirp: async () => undefined,
      remove: async () => undefined,
      isDirectory: async () => false,
    };
    const identity = {
      workspaceIdentityDigest: "workspace/custom/path",
      git: { head: "head", index: "index" },
    };
    const path = repositoryMapCachePath("/cache", identity.workspaceIdentityDigest);
    expect(path).toMatch(/^\/cache\/repository-maps\/[0-9a-f]{64}\.json$/);
    await writeRepositoryScanCache(
      { fs } as never,
      path,
      identity,
      { files: [{ path: "src/main.ts", bytes: 1, binary: false, tracked: true }] },
      10,
    );
    const cached = await readRepositoryScanCache({ fs } as never, path, identity);
    expect(cached?.files[0]?.path).toBe("src/main.ts");
    expect(await readRepositoryScanCache(
      { fs } as never,
      path,
      { ...identity, git: { ...identity.git, head: "changed" } },
    )).toBeUndefined();
  });
});
