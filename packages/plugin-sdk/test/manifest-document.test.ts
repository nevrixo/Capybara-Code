import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  MAX_PLUGIN_MANIFEST_DOCUMENT_BYTES,
  PluginManifestDocumentError,
  verifyPluginManifestDocument,
  type PluginManifest,
} from "../src/index.ts";

const PACKAGE_DIGEST = "sha256:" + "a".repeat(64);
const UTF8 = new TextEncoder();

function manifest(): PluginManifest {
  return {
    schemaVersion: "1.0",
    id: "acme/document",
    name: "Document plugin",
    version: "1.2.3",
    publisher: "acme",
    description: "A manifest loaded from exact transport bytes.",
    license: "Apache-2.0",
    runtime: { kind: "wasi", entrypoint: "plugin.wasm", protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=1.0.0" },
    permissions: { workspaceRead: ["src/**"], memory: "search" },
    integrity: {
      files: { "plugin.wasm": PACKAGE_DIGEST },
      packageDigest: PACKAGE_DIGEST,
    },
  };
}

function digest(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

describe("plugin manifest document verification", () => {
  test("validates a manifest and retains its exact source-byte digest", () => {
    const compact = UTF8.encode(JSON.stringify(manifest()));
    const formatted = UTF8.encode(JSON.stringify(manifest(), null, 2));
    const verified = verifyPluginManifestDocument(compact);

    expect(verified.digest).toBe(digest(compact));
    expect(verified.byteLength).toBe(compact.byteLength);
    expect(verified.manifest).toEqual(manifest());
    expect(verifyPluginManifestDocument(formatted).digest).not.toBe(verified.digest);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.manifest)).toBe(true);
    expect(Object.isFrozen(verified.manifest.permissions)).toBe(true);
  });

  test("rejects malformed bytes and manifests that do not meet the strict contract", () => {
    expect(() => verifyPluginManifestDocument(new Uint8Array([0xc3, 0x28])))
      .toThrow(PluginManifestDocumentError);
    expect(() => verifyPluginManifestDocument(UTF8.encode("{")))
      .toThrow(PluginManifestDocumentError);
    expect(() => verifyPluginManifestDocument(UTF8.encode(JSON.stringify({
      ...manifest(),
      rawFilesystem: "C:/",
    })))).toThrow(PluginManifestDocumentError);
  });

  test("bounds an untrusted manifest document before decoding it", () => {
    expect(() => verifyPluginManifestDocument(
      new Uint8Array(MAX_PLUGIN_MANIFEST_DOCUMENT_BYTES + 1),
    )).toThrow(/1 to/);
  });
});
