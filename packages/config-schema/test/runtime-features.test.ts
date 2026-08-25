import { describe, expect, test } from "bun:test";

import { configKeyInfo, defaultConfig, mergeConfig } from "../src/index.ts";

describe("durable runtime configuration gates", () => {
  test("ships every wired runtime surface enabled, with a user-owned disable gate", () => {
    const config = defaultConfig();
    expect(config.experimental).toEqual({
      editEngineV2: true,
      fullLsp: true,
      sessionDaemon: true,
      durableMemory: true,
      persistentAgentGraph: true,
      worktreeMultiAgent: true,
      pluginRuntime: true,
      appServer: true,
    });
    expect(config.edit.maxOperationsPerPlan).toBe(100);
    expect(config.memory.privacy.storeRawTranscript).toBe(false);
    expect(config.daemon.transport.allowTcp).toBe(false);
    expect(config.plugins.allowProjectStdio).toBe(false);
    expect(config.appServer.allowLoopbackWebsocket).toBe(false);
  });

  test("applies wired user-owned feature gates without a false rollout warning", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "experimental.editEngineV2": true,
        "experimental.fullLsp": true,
        "lsp.mutations.formatting": true,
        "lsp.mutations.codeActions": true,
      },
    }]);
    expect(merged.config.experimental.editEngineV2).toBe(true);
    expect(merged.config.experimental.fullLsp).toBe(true);
    expect(merged.config.lsp.mutations.formatting).toBe(true);
    expect(merged.config.lsp.mutations.codeActions).toBe(true);
    expect(merged.issues.some((issue) =>
      issue.path === "experimental.editEngineV2" ||
      issue.path === "experimental.fullLsp" ||
      issue.path === "lsp.mutations.formatting" ||
      issue.path === "lsp.mutations.codeActions",
    )).toBe(false);
    expect(configKeyInfo("experimental.editEngineV2")?.status).toBe("wired");
    expect(configKeyInfo("experimental.fullLsp")?.status).toBe("wired");
    expect(configKeyInfo("lsp.mutations.formatting")?.status).toBe("wired");
    expect(configKeyInfo("lsp.mutations.codeActions")?.status).toBe("wired");
  });

  test("rejects invalid constrained settings and fixed safety-boundary values", () => {
    const merged = mergeConfig([{
      source: "user",
      values: {
        "lsp.planMode": "unsafe",
        "memory.privacy.storeRawTranscript": true,
        "lsp.commands.allow": "not-an-array",
      },
    }]);
    expect(merged.config.lsp.planMode).toBe("disabled");
    expect(merged.config.memory.privacy.storeRawTranscript).toBe(false);
    expect(merged.issues.filter((issue) => issue.severity === "error")).toHaveLength(3);
  });

  test("does not let a project re-enable a user-disabled runtime feature", () => {
    const merged = mergeConfig([
      { source: "user", values: { "experimental.fullLsp": false } },
      { source: "project", values: { "experimental.fullLsp": true } },
    ]);
    expect(merged.config.experimental.fullLsp).toBe(false);
    expect(merged.issues).toContainEqual(expect.objectContaining({
      path: "experimental.fullLsp",
      severity: "error",
    }));
  });

  test("allows a project to narrow an LSP mutation while reserving daemon ownership to the user", () => {
    const narrowed = mergeConfig([{ source: "project", values: { "lsp.mutations.rename": false } }]);
    expect(narrowed.config.lsp.mutations.rename).toBe(false);
    expect(narrowed.issues.some((issue) => issue.severity === "error")).toBe(false);

    const daemon = mergeConfig([{ source: "project", values: { "daemon.autostart": false } }]);
    expect(daemon.config.daemon.autostart).toBe(true);
    expect(daemon.issues).toContainEqual(expect.objectContaining({
      path: "daemon.autostart",
      severity: "error",
    }));
  });
});
