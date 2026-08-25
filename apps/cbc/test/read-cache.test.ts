import { describe, expect, test } from "bun:test";

import type { ProposedAction } from "@cbc/permissions";
import { okResult } from "@cbc/tool-registry";

import { ReadCache, RuntimeToolExecutor } from "../src/tools.ts";

function readAction(callId: string, path: string): ProposedAction {
  return {
    callId,
    toolId: "fs.read",
    arguments: { path },
    reads: [path],
    display: `fs.read ${path}`,
  };
}

describe("ReadCache metadata and coalescing", () => {
  test("touching a hit keeps it in the LRU while another entry is evicted", () => {
    const cache = new ReadCache({ maxEntries: 2 });
    const a = cache.key("fs.read", { path: "a.ts" });
    const b = cache.key("fs.read", { path: "b.ts" });
    const c = cache.key("fs.read", { path: "c.ts" });
    cache.set(a, { result: okResult("a") });
    cache.set(b, { result: okResult("b") });

    expect(cache.get(a)?.result.summary).toBe("a");
    cache.set(c, { result: okResult("c") });

    expect(cache.get(a)).toBeDefined();
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(c)).toBeDefined();
  });

  test("path invalidation preserves unrelated metadata-bound entries", () => {
    const cache = new ReadCache();
    const a = cache.key("fs.read", { path: "src/a.ts" }, "0", "workspace:read");
    const b = cache.key("fs.read", { path: "src/b.ts" }, "0", "workspace:read");
    const execution = { result: okResult("read") };
    cache.set(a, execution, {
      paths: ["src/a.ts"],
      revisionToken: "a1",
      authority: "read",
      authorityScope: "workspace:read",
    });
    cache.set(b, execution, {
      paths: ["src/b.ts"],
      revisionToken: "b1",
      authority: "read",
      authorityScope: "workspace:read",
    });

    cache.invalidatePath("src/a.ts");

    expect(cache.getEntry(a, { authorityScope: "workspace:read" })).toBeUndefined();
    expect(cache.getEntry(b, { authorityScope: "workspace:read" })?.metadata.revisionToken).toBe("b1");
  });

  test("path invalidation can recover bindings from legacy keys", () => {
    const cache = new ReadCache();
    const a = cache.key("fs.read", { path: "src/a.ts" });
    const b = cache.key("fs.read", { path: "src/b.ts" });
    const execution = { result: okResult("read") };
    cache.set(a, execution);
    cache.set(b, execution);

    cache.invalidatePath("src/a.ts");

    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBeDefined();
  });

  test("restores fenced reads only after a runtime no-change proof", () => {
    let now = 10;
    const cache = new ReadCache({ now: () => now });
    const key = cache.key("fs.read", { path: "src/a.ts" });
    cache.set(key, { result: okResult("read a.ts") }, { paths: ["src/a.ts"] });

    const unchanged = cache.beginPotentialMutation();
    expect(cache.get(key)).toBeUndefined();
    cache.resolvePotentialMutation(unchanged, true);
    expect(cache.get(key)?.result.summary).toBe("read a.ts");

    now += 1;
    const changed = cache.beginPotentialMutation();
    cache.resolvePotentialMutation(changed, false);
    expect(cache.get(key)).toBeUndefined();
  });

  test("coalesces concurrent misses and removes the in-flight record after settlement", async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new ReadCache();
    const first = cache.coalesce("same", async () => {
      calls += 1;
      await gate;
      return "value";
    });
    const second = cache.coalesce("same", async () => {
      calls += 1;
      return "wrong";
    });

    expect(second.shared).toBe(true);
    release();
    expect(await first.promise).toBe("value");
    expect(await second.promise).toBe("value");
    expect(calls).toBe(1);
    await Promise.resolve();
    expect(cache.inFlightFor("same")).toBeUndefined();
  });

  test("path invalidation does not reject an unrelated in-flight read", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const cache = new ReadCache();
    const first = cache.coalesce("a", async () => { await gateA; return "a"; }, { paths: ["src/a.ts"] });
    const second = cache.coalesce("b", async () => { await gateB; return "b"; }, { paths: ["src/b.ts"] });

    cache.invalidatePath("src/a.ts");
    releaseA();
    releaseB();

    expect(await first.promise).toBe("a");
    expect(await second.promise).toBe("b");
    expect(cache.inFlightFor("a")).toBeUndefined();
    expect(cache.inFlightFor("b")).toBeUndefined();
  });
});

describe("RuntimeToolExecutor read coalescing", () => {
  test("shares raw dispatch but runs observation independently for each caller", async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observations: boolean[] = [];
    const runtime = {
      workspace: "/work",
      read: async (path: string) => {
        calls += 1;
        await gate;
        return { path, rendered: "COALESCED_READ_BODY" };
      },
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      readCache: new ReadCache(),
      onObservation: (event) => {
        observations.push(event.cacheHit);
        return false;
      },
    });

    const first = executor.execute(readAction("one", "src/a.ts"), new AbortController().signal);
    const second = executor.execute(readAction("two", "src/a.ts"), new AbortController().signal);
    release();
    const results = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(observations).toEqual([false, true]);
    expect(results[0]?.text).toContain("COALESCED_READ_BODY");
    expect(results[1]?.text).toContain("COALESCED_READ_BODY");
  });

  test("sensitive reads do not enter the shared cache", async () => {
    let calls = 0;
    const runtime = {
      workspace: "/work",
      read: async (path: string) => {
        calls += 1;
        return { path, rendered: "SENSITIVE_CACHE_SENTINEL" };
      },
    };
    const executor = new RuntimeToolExecutor({
      runtime: runtime as never,
      host: { now: () => 1 } as never,
      readCache: new ReadCache(),
      onObservation: () => false,
    });
    const signal = new AbortController().signal;

    await executor.execute(readAction("one", ".env"), signal);
    await executor.execute(readAction("two", ".env"), signal);

    expect(calls).toBe(2);
  });
});
