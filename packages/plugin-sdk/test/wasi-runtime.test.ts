import { describe, expect, test } from "bun:test";

import { invokeIsolatedPlugin } from "../src/wasi-runtime.ts";
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

function wasmCallImport(moduleName: string, importName: string): string {
  const encodeName = (value: string): number[] => {
    const bytes = [...Buffer.from(value, "utf8")];
    return [bytes.length, ...bytes];
  };
  const section = (id: number, payload: number[]): number[] => [id, payload.length, ...payload];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0x00, 0x00]),
    ...section(2, [1, ...encodeName(moduleName), ...encodeName(importName), 0x00, 0x00]),
    ...section(3, [1, 0x00]),
    ...section(7, [1, ...encodeName("handle"), 0x00, 0x01]),
    ...section(10, [1, 4, 0x00, 0x10, 0x00, 0x0b]),
  ];
  return Buffer.from(bytes).toString("binary");
}

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
    let read = false;
    await expect(invokeIsolatedPlugin({
      pluginId: "pub.widen",
      entrypoint: "plugin.js",
      method: "handle",
      timeoutMs: 1_000,
      grants,
      readFile: () => {
        read = true;
        return "leaked";
      },
      sourceText: `function handle(_params, host) { return host.read("src/secret.ts"); }`,
    })).rejects.toMatchObject({
      name: "WasiRuntimeError",
      code: "PLUGIN_CAPABILITY_DENIED",
    });
    expect(read).toBe(false);
  });

  test("granted read uses the host callback and never ambient filesystem", async () => {
    const result = await invokeIsolatedPlugin({
      pluginId: "pub.reader",
      entrypoint: "plugin.js",
      method: "handle",
      timeoutMs: 1_000,
      grants: { ...grants, workspaceRead: ["src/file.ts"] },
      readFile: (path) => {
        if (path !== "src/file.ts") throw new Error("unexpected path");
        return "granted contents";
      },
      sourceText: `function handle(_params, host) { return host.read("src/file.ts"); }`,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("granted contents");
  });

  test("javascript still denies network and write", async () => {
    const result = await invokeIsolatedPlugin({
      pluginId: "pub.deny-write",
      entrypoint: "plugin.js",
      method: "handle",
      timeoutMs: 1_000,
      grants: { ...grants, workspaceRead: ["src/file.ts"] },
      readFile: () => "ok",
      sourceText: `
        function handle(_params, host) {
          const denied = [];
          try { host.write("src/file.ts"); } catch (error) { denied.push(error.code); }
          try { host.network(); } catch (error) { denied.push(error.code); }
          return denied;
        }
      `,
    });
    expect(result.result).toEqual(["PLUGIN_CAPABILITY_DENIED", "PLUGIN_CAPABILITY_DENIED"]);
  });

  test("wasm still denies network and write", async () => {
    await expect(invokeIsolatedPlugin({
      pluginId: "pub.wasm-net",
      entrypoint: "plugin.wasm",
      method: "handle",
      timeoutMs: 1_000,
      grants,
      sourceText: wasmCallImport("capy", "net_connect"),
    })).rejects.toMatchObject({ code: "PLUGIN_CAPABILITY_DENIED" });

    await expect(invokeIsolatedPlugin({
      pluginId: "pub.wasm-write",
      entrypoint: "plugin.wasm",
      method: "handle",
      timeoutMs: 1_000,
      grants,
      sourceText: wasmCallImport("capy", "fs_write"),
    })).rejects.toMatchObject({ code: "PLUGIN_CAPABILITY_DENIED" });
  });
});
