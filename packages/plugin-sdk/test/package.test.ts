import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  canonicalPluginPackageDigest,
  verifyPluginPackage,
  type PluginManifest,
  type PluginPackageFile,
} from "../src/index.ts";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function digest(value: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function fixture(): { readonly manifest: PluginManifest; readonly files: readonly PluginPackageFile[] } {
  const entrypoint = bytes("wasm plugin body");
  const readme = bytes("# Example plugin\n");
  const fileDigests = {
    "README.md": digest(readme),
    "plugin.wasm": digest(entrypoint),
  };
  const manifest: PluginManifest = {
    schemaVersion: "1.0",
    id: "acme/package-check",
    name: "Package check",
    version: "1.0.0",
    publisher: "acme",
    description: "Verifies package bytes before supervisor startup.",
    license: "Apache-2.0",
    runtime: { kind: "wasi", entrypoint: "plugin.wasm", protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=1.0.0" },
    permissions: {},
    integrity: {
      files: fileDigests,
      packageDigest: canonicalPluginPackageDigest(fileDigests),
    },
  };
  return {
    manifest,
    files: [
      { path: "plugin.wasm", bytes: entrypoint },
      { path: "README.md", bytes: readme },
    ],
  };
}

describe("verifyPluginPackage", () => {
  test("verifies every declared file and produces an order-independent package digest", () => {
    const input = fixture();
    const verified = verifyPluginPackage(input);

    expect(verified).toEqual({
      pluginId: "acme/package-check",
      packageDigest: input.manifest.integrity.packageDigest,
      fileDigests: input.manifest.integrity.files,
      totalBytes: input.files[0]!.bytes.byteLength + input.files[1]!.bytes.byteLength,
    });
    expect(Object.isFrozen(verified.fileDigests)).toBe(true);
  });

  test("uses UTF-8 path bytes for insertion-independent package ordering", () => {
    const first = canonicalPluginPackageDigest({
      "z.txt": "sha256:" + "a".repeat(64),
      "é.txt": "sha256:" + "b".repeat(64),
    });
    const second = canonicalPluginPackageDigest({
      "é.txt": "sha256:" + "b".repeat(64),
      "z.txt": "sha256:" + "a".repeat(64),
    });
    expect(first).toBe(second);
  });

  test("rejects modified bytes before a package digest can be accepted", () => {
    const input = fixture();
    const tampered = [
      { path: "plugin.wasm", bytes: bytes("modified plugin body") },
      input.files[1]!,
    ];
    expect(() => verifyPluginPackage({ manifest: input.manifest, files: tampered }))
      .toThrow("file digest");
  });

  test("requires exact path coverage and rejects traversal in a digest input", () => {
    const input = fixture();
    expect(() => verifyPluginPackage({
      manifest: input.manifest,
      files: [input.files[0]!],
    })).toThrow("exactly match");
    expect(() => verifyPluginPackage({
      manifest: input.manifest,
      files: [...input.files, { path: "extra.txt", bytes: bytes("extra") }],
    })).toThrow("exactly match");
    expect(() => canonicalPluginPackageDigest({
      "../outside": input.manifest.integrity.files["README.md"]!,
    })).toThrow("without traversal");
  });

  test("rejects a package digest that does not commit to the sorted file record", () => {
    const input = fixture();
    const manifest: PluginManifest = {
      ...input.manifest,
      integrity: {
        ...input.manifest.integrity,
        packageDigest: digest(bytes("wrong package digest")),
      },
    };
    expect(() => verifyPluginPackage({ manifest, files: input.files }))
      .toThrow("package digest");
  });
});
