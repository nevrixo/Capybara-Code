import { describe, expect, test } from "bun:test";

import {
  PluginDefinitionError,
  definePlugin,
  type PluginDefinition,
  type PluginManifest,
} from "../src/index.ts";
import {
  PluginTestHostError,
  createPluginTestHost,
} from "../src/testing.ts";

const DIGEST = "sha256:" + "b".repeat(64);

function manifest(): PluginManifest {
  return {
    schemaVersion: "1.0",
    id: "acme/test-plugin",
    name: "Test plugin",
    version: "1.0.0",
    publisher: "acme",
    description: "A minimal test plugin.",
    license: "Apache-2.0",
    runtime: { kind: "wasi", entrypoint: "plugin.wasm", protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=1.0.0" },
    hooks: [{ kind: "before.tool" }],
    tools: [{
      id: "read-logical-file",
      title: "Read logical file",
      description: "Reads through the host grant.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requestedRisk: "R1",
      sideEffect: "read",
      network: false,
    }],
    commands: [{
      name: "read-logical-file",
      description: "Read through the host grant.",
      argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
      headless: true,
    }],
    permissions: { workspaceRead: ["package.json"] },
    integrity: { files: { "plugin.wasm": DIGEST }, packageDigest: DIGEST },
  };
}

function plugin(): PluginDefinition {
  return definePlugin({
    manifest: manifest(),
    hooks: {
      "before.tool": async () => ({
        action: "narrow",
        reason: "keep reads local",
        constraints: { toolIds: ["fs.read"] },
      }),
    },
    tools: {
      "read-logical-file": async (args, context) => {
        const path = typeof args === "string" ? args : "package.json";
        return await context.workspace.read({ path });
      },
    },
    commands: {
      "read-logical-file": async (_args, context) => ({
        pluginId: context.pluginId,
        granted: context.grantedPermissions.workspaceRead ?? [],
      }),
    },
  });
}

describe("definePlugin and the test host", () => {
  test("binds handlers to declared contributions and exposes only grant-checked logical reads", async () => {
    const host = createPluginTestHost({
      plugin: plugin(),
      grants: { workspaceRead: ["package.json"] },
      workspace: { "package.json": "{\"name\":\"capy\"}", "secret.txt": "never expose" },
    });

    expect(await host.invokeTool("read-logical-file", "package.json")).toEqual({
      path: "package.json",
      text: "{\"name\":\"capy\"}",
    });
    expect(await host.invokeHook("before.tool", {
      invocationId: "inv_tool",
      operation: {
        workspaceRead: ["package.json"],
        workspaceWrite: [],
        credentialScopes: [],
        toolIds: ["fs.read"],
        contextCandidateIds: [],
        network: "deny",
        timeoutMs: 1_000,
        outputBytes: 4_096,
        maxNodes: 1,
        risk: "R1",
        sandbox: "strict",
      },
    })).toMatchObject({ action: "narrow" });
  });

  test("denies ungranted logical paths without exposing a real filesystem", async () => {
    const host = createPluginTestHost({
      plugin: plugin(),
      grants: { workspaceRead: ["package.json"] },
      workspace: { "package.json": "{}", "secret.txt": "never expose" },
    });

    await expect(host.invokeTool("read-logical-file", "secret.txt"))
      .rejects.toMatchObject({ code: "PLUGIN_PERMISSION_DENIED" } satisfies Partial<PluginTestHostError>);
  });

  test("rejects undeclared and missing handlers before a plugin is invoked", () => {
    expect(() => definePlugin({
      ...plugin(),
      tools: {
        "read-logical-file": async () => ({}),
        undeclared: async () => ({}),
      },
    })).toThrow(PluginDefinitionError);

    expect(() => definePlugin({
      ...plugin(),
      hooks: {},
    })).toThrow(PluginDefinitionError);
  });
});
