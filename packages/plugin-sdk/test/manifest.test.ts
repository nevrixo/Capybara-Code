import { describe, expect, test } from "bun:test";

import {
  PluginManifestError,
  validatePluginManifest,
  type PluginManifest,
} from "../src/index.ts";

const DIGEST = "sha256:" + "a".repeat(64);

function manifest(): PluginManifest {
  return {
    schemaVersion: "1.0",
    id: "acme/dependency-report",
    name: "Dependency report",
    version: "1.2.3",
    publisher: "acme",
    description: "Reports bounded dependency metadata.",
    license: "Apache-2.0",
    runtime: {
      kind: "wasi",
      entrypoint: "plugin.wasm",
      protocolVersion: "1.0.0",
    },
    compatibility: { capybara: ">=1.0.0", platforms: ["windows", "linux"] },
    hooks: [{ kind: "before.tool", ordinal: 2, critical: true }],
    tools: [{
      id: "dependency-report",
      title: "Dependency report",
      description: "Summarize dependencies.",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      requestedRisk: "R1",
      sideEffect: "read",
      network: false,
    }],
    commands: [{
      name: "dependency-report",
      description: "Generate the report.",
      argumentsSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      headless: true,
    }],
    contextProviders: [{
      id: "dependency-facts",
      title: "Dependency facts",
      description: "Proposes verified package facts.",
    }],
    ui: {
      drawers: [{ id: "dependency-report", title: "Dependencies", dataSource: "dependency-report" }],
      statusItems: [{ id: "dependency-status", label: "Dependencies", eventKinds: ["after.tool"] }],
    },
    permissions: {
      events: ["before.tool"],
      workspaceRead: ["package.json", "src/**"],
      tools: ["fs.read"],
      memory: "propose",
      artifacts: "create",
    },
    limits: { beforeHookMs: 2_000, afterHookMs: 5_000, maxOutputBytes: 4_096 },
    integrity: {
      files: { "plugin.wasm": DIGEST, "README.md": DIGEST },
      packageDigest: DIGEST,
    },
  };
}

describe("plugin manifest validation", () => {
  test("accepts a bounded manifest that mirrors the durable permission shape", () => {
    expect(() => validatePluginManifest(manifest())).not.toThrow();
  });

  test("rejects package traversal before an entrypoint can reach a runtime", () => {
    const invalid = {
      ...manifest(),
      runtime: {
        ...manifest().runtime,
        entrypoint: "../outside.wasm",
      },
    };
    expect(() => validatePluginManifest(invalid)).toThrow(PluginManifestError);
  });

  test("requires strict object schemas and deterministic hook registrations", () => {
    const looseSchema = {
      ...manifest(),
      tools: [{
        ...manifest().tools![0]!,
        parametersSchema: { type: "object", properties: {} },
      }],
    };
    expect(() => validatePluginManifest(looseSchema)).toThrow(/strict object schema/);

    const duplicateHook = {
      ...manifest(),
      hooks: [
        { kind: "before.tool" as const, ordinal: 2 },
        { kind: "before.tool" as const, ordinal: 2 },
      ],
    };
    expect(() => validatePluginManifest(duplicateHook)).toThrow(/duplicate kind and ordinal/);
  });

  test("rejects unknown permission fields instead of silently widening a request", () => {
    const invalid = {
      ...manifest(),
      permissions: {
        ...manifest().permissions,
        rawFilesystem: ["C:/"],
      },
    };
    expect(() => validatePluginManifest(invalid as PluginManifest)).toThrow(PluginManifestError);
  });
});
