import { describe, expect, test } from "bun:test";

import { ToolExecutionGraph, type ToolGraphCall } from "../src/index.ts";

const parallelReads: readonly ToolGraphCall[] = [
  { callId: "slow", toolId: "fs.read", kind: "read", reads: ["slow.ts"] },
  { callId: "fast", toolId: "fs.read", kind: "read", reads: ["fast.ts"] },
];

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("ToolExecutionGraph result ordering", () => {
  test("defaults to deterministic planned-call order", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const run = new ToolExecutionGraph().run(parallelReads, (call) => (
      call.callId === "slow" ? slow.promise : fast.promise
    ));

    fast.resolve("fast-result");
    await Promise.resolve();
    slow.resolve("slow-result");

    const result = await run;
    expect(result.results.map((entry) => entry.callId)).toEqual(["slow", "fast"]);
    expect(result.results.map((entry) => entry.value)).toEqual(["slow-result", "fast-result"]);
  });

  test("can preserve parallel completion order within each batch", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const graph = new ToolExecutionGraph({ stableResultOrder: false });
    const run = graph.run(parallelReads, (call) => (
      call.callId === "slow" ? slow.promise : fast.promise
    ));

    fast.resolve("fast-result");
    await Promise.resolve();
    slow.resolve("slow-result");

    const result = await run;
    expect(graph.limits.stableResultOrder).toBe(false);
    expect(result.results.map((entry) => entry.callId)).toEqual(["fast", "slow"]);
    expect(result.results.map((entry) => entry.value)).toEqual(["fast-result", "slow-result"]);
  });

  test("keeps dependency batch boundaries even when completion ordering is enabled", async () => {
    const graph = new ToolExecutionGraph({ stableResultOrder: false });
    const calls: readonly ToolGraphCall[] = [
      ...parallelReads,
      { callId: "after", toolId: "fs.read", kind: "read", reads: ["after.ts"], dependencies: ["slow", "fast"] },
    ];
    const slow = deferred<string>();
    const fast = deferred<string>();
    const started: string[] = [];
    const run = graph.run(calls, (call) => {
      started.push(call.callId);
      if (call.callId === "slow") return slow.promise;
      if (call.callId === "fast") return fast.promise;
      return "after-result";
    });

    expect(started).toEqual(["slow", "fast"]);
    fast.resolve("fast-result");
    await Promise.resolve();
    expect(started).toEqual(["slow", "fast"]);
    slow.resolve("slow-result");

    const result = await run;
    expect(started).toEqual(["slow", "fast", "after"]);
    expect(result.results.map((entry) => entry.callId)).toEqual(["fast", "slow", "after"]);
  });
});
