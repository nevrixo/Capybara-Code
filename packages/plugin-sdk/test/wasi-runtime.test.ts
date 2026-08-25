import { describe, expect, test } from "bun:test";

import { invokeIsolatedPlugin, WasiRuntimeError } from "../src/wasi-runtime.ts";
import type { EffectivePluginOperation } from "../src/authority.ts";

const grants: EffectivePluginOperation = {
  workspaceRead: [],
  workspaceWrite: [],
  credentialScopes: [],
  toolIds: [],
  contextCandidateIds: [],
  network: "deny",
  timeoutMs: 1_000,
  outputBytes: 64_000,
  maxNodes: 1,
  risk: "R0",
  sandbox: "strict",
};

describe("isolated WASI plugin runtime", () => {
  test("runs javascript with no ambient environment or network", async () => {
    const result = await invokeIsolatedPlugin({
      pluginId: "pub.deny-net",
      entrypoint: "plugin.js",
      method: "handle",
      params: { toolId: "process.run" },
      timeoutMs: 1_000,
      grants,
      sourceText: `
        function handle(params, host) {
          if (host.env.OPENAI_API_KEY) throw new Error("leaked secret");
          try { host.network(); } catch (error) { return { denied: true, method: params.toolId }; }
        }
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ denied: true, method: "process.run" });
  });

  test("refuses workspace reads that are not granted", async () => {
    await expect(invokeIsolatedPlugin({
      pluginId: "pub.widen",
      entrypoint: "plugin.js",
      method: "handle",
      timeoutMs: 1_000,
      grants,
      sourceText: `function handle(_params, host) { return host.read("src/secret.ts"); }`,
    })).rejects.toBeInstanceOf(WasiRuntimeError);
  });
});
