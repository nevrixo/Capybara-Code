import { describe, expect, test } from "bun:test";

import { Runtime } from "../src/runtime.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function testHost() {
  return {
    env: { CBC_RUNTIME_BINARY: "/runtime" },
    homeDir: "/home/test",
    platform: "linux",
    executableDir: "/bin",
    cwd: "/work",
    fs: { exists: async (path: string) => path === "/runtime" },
  } as never;
}

describe("typed runtime read facade", () => {
  test("adds revision and authority metadata while retaining legacy fields", async () => {
    const fake = createFakeRuntime({
      handler: ({ method }) => method === "fs.read"
        ? {
            path: "src/a.ts",
            checksum: "a".repeat(64),
            excerpt: {
              path: "src/a.ts",
              checksum: "a".repeat(64),
              startLine: 2,
              endLine: 3,
              totalLines: 4,
              text: "two\nthree",
              partial: true,
              omittedBefore: 1,
              omittedAfter: 1,
            },
            rendered: "legacy rendered body",
          }
        : { files: [], errors: [] },
    });
    const runtime = await Runtime.start({
      host: testHost(),
      workspace: "/work",
      dataDir: "/data",
      clientVersion: "test",
      spawner: fake.spawner,
    });

    const response = await runtime.read({ path: "src/a.ts", mode: "preview", maxBytes: 4_096 });
    expect(response.mode).toBe("preview");
    expect(response.revisionToken).toBe("a".repeat(64));
    expect(response.authoritativeForWrite).toBe(false);
    expect(response.rendered).toBe("legacy rendered body");
    expect(response.excerpt.endOfFile).toBe(false);
    expect(response.excerpt.text).toBe("two\nthree");

    const fingerprint = await runtime.fingerprint("src/a.ts");
    expect(fingerprint.revisionToken).toBe("a".repeat(64));
    await runtime.stop();
  });

  test("typed read_many sends items and a legacy paths fallback", async () => {
    const fake = createFakeRuntime({
      handler: ({ method, params }) => {
        if (method !== "fs.read_many") return { files: [], errors: [] };
        const request = params as { items?: Array<{ path: string }>; paths?: string[] };
        expect(request.items?.[0]?.path).toBe("src/a.ts");
        expect(request.paths).toEqual(["src/a.ts"]);
        return {
          files: [{ path: "src/a.ts", checksum: "b".repeat(64), rendered: "body" }],
          errors: [],
        };
      },
    });
    const runtime = await Runtime.start({
      host: testHost(),
      workspace: "/work",
      dataDir: "/data",
      clientVersion: "test",
      spawner: fake.spawner,
    });

    const response = await runtime.readMany({
      items: [{ path: "src/a.ts", startLine: 3, maxLines: 2 }],
      concurrency: 1,
    });
    expect(response.files[0]?.revisionToken).toBe("b".repeat(64));
    expect(response.files[0]?.rendered).toBe("body");
    await runtime.stop();
  });

  test("forkSidecar starts a second sidecar with its own workspace root", async () => {
    const workspaces: string[] = [];
    const spawner: import("@cbc/protocol").RuntimeSpawner = (binary) => {
      workspaces.push(binary);
      return createFakeRuntime().spawner(binary);
    };
    const runtime = await Runtime.start({
      host: testHost(),
      workspace: "/work",
      dataDir: "/data",
      clientVersion: "test",
      spawner,
    });
    const sidecar = await runtime.forkSidecar("/work/.capybara/worktrees/agt_1", "/work/.capybara/worktrees/agt_1/.capybara");
    expect(sidecar).not.toBe(runtime);
    expect(workspaces.length).toBe(2);
    await sidecar.stop();
    await runtime.stop();
  });

  test("listWorktrees treats an unknown sidecar method as an empty list", async () => {
    const fake = createFakeRuntime({
      handler: ({ method }) => {
        if (method === "worktree.list") {
          const error = new Error("unknown method: worktree.list") as Error & { code: number };
          error.code = -32601;
          throw error;
        }
        return {};
      },
    });
    const runtime = await Runtime.start({
      host: testHost(),
      workspace: "/work",
      dataDir: "/data",
      clientVersion: "test",
      spawner: fake.spawner,
    });
    await expect(runtime.listWorktrees()).resolves.toEqual({ worktrees: [] });
    await runtime.stop();
  });

  test("listWorktrees treats a missing git repository as an empty list", async () => {
    const fake = createFakeRuntime({
      handler: ({ method }) => {
        if (method === "worktree.list") {
          const error = new Error("/work is not a Git repository") as Error & {
            code: number;
            data: { taxonomy: string };
          };
          error.code = -32003;
          error.data = { taxonomy: "NOT_FOUND" };
          throw error;
        }
        return {};
      },
    });
    const runtime = await Runtime.start({
      host: testHost(),
      workspace: "/work",
      dataDir: "/data",
      clientVersion: "test",
      spawner: fake.spawner,
    });
    await expect(runtime.listWorktrees()).resolves.toEqual({ worktrees: [] });
    await runtime.stop();
  });
});
