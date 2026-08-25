import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  PluginInstallAdmissionError,
  admitPluginInstall,
  canonicalPluginPackageDigest,
  verifyPluginManifestDocument,
  type PluginInstallAdmissionInput,
  type PluginLockEntry,
  type PluginInstallScope,
  type PluginInstallSourceKind,
  type PluginManifest,
  type PluginSignaturePolicy,
} from "../src/index.ts";

const UTF8 = new TextEncoder();

interface FixtureOptions {
  readonly scope?: PluginInstallScope;
  readonly sourceKind?: PluginInstallSourceKind;
  readonly runtimeKind?: "wasi" | "stdio";
  readonly signed?: boolean;
  readonly signaturePolicy?: PluginSignaturePolicy;
}

function fixture(options: FixtureOptions = {}): PluginInstallAdmissionInput {
  const runtimeKind = options.runtimeKind ?? "wasi";
  const entrypoint = runtimeKind === "wasi" ? "plugin.wasm" : "plugin.cjs";
  const bytes = UTF8.encode("isolated " + runtimeKind + " plugin");
  const fileDigest = digest(bytes);
  const packageDigest = canonicalPluginPackageDigest({ [entrypoint]: fileDigest });
  const signed = options.signed ?? true;
  const manifest: PluginManifest = {
    schemaVersion: "1.0",
    id: "acme/admission",
    name: "Admission plugin",
    version: "1.2.3",
    publisher: "acme",
    description: "A package admitted only after cross-layer verification.",
    license: "Apache-2.0",
    runtime: { kind: runtimeKind, entrypoint, protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=1.0.0" },
    permissions: { workspaceRead: ["src/**"], artifacts: "read-own" },
    integrity: {
      files: { [entrypoint]: fileDigest },
      packageDigest,
    },
    ...(signed
      ? { signature: { keyId: "acme-release-2026", algorithm: "ed25519", signature: "base64proof" } }
      : {}),
  };
  const manifestDocument = verifyPluginManifestDocument(
    UTF8.encode(JSON.stringify(manifest)),
  );
  const source = options.sourceKind === "local-path" ? "path:plugins/admission" : "registry:acme";
  const lockEntry: PluginLockEntry = {
    version: manifest.version,
    source,
    packageDigest,
    manifestDigest: manifestDocument.digest,
    grants: { workspaceRead: ["src/**"], artifacts: "read-own" },
    ...(signed ? { signature: { keyId: "acme-release-2026", verified: true } } : {}),
  };

  return {
    scope: options.scope ?? "project",
    sourceKind: options.sourceKind ?? "registry",
    source,
    manifestDocument,
    files: [{ path: entrypoint, bytes }],
    lockEntry,
    ...(options.signaturePolicy === undefined ? {} : { signaturePolicy: options.signaturePolicy }),
  };
}

function digest(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

describe("plugin installation admission", () => {
  test("composes verified manifest, package, lock, signature, and scope evidence", () => {
    const admitted = admitPluginInstall(fixture());

    expect(admitted).toMatchObject({
      pluginId: "acme/admission",
      version: "1.2.3",
      scope: "project",
      sourceKind: "registry",
      source: "registry:acme",
      runtimeKind: "wasi",
      signatureVerified: true,
    });
    expect(admitted.packageDigest).toBe(admitted.package.packageDigest);
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  test("rejects unsigned registry packages and stale signature key metadata", () => {
    expect(() => admitPluginInstall(fixture({ signed: false })))
      .toThrow(/verified signature/);

    const input = fixture();
    expect(() => admitPluginInstall({
      ...input,
      lockEntry: {
        ...input.lockEntry,
        signature: { keyId: "another-key", verified: true },
      },
    })).toThrow(/keyId/);
  });

  test("rejects a project stdio plugin before any executable can be admitted", () => {
    expect(() => admitPluginInstall(fixture({
      scope: "project",
      sourceKind: "local-path",
      runtimeKind: "stdio",
      signed: false,
      signaturePolicy: "allow-unverified",
    }))).toThrow(/isolated wasi runtime/);
  });

  test("requires source equality, authentic verifier provenance, and intact package bytes", () => {
    const input = fixture();
    expect(() => admitPluginInstall({ ...input, source: "registry:other" }))
      .toThrow(/source/);
    expect(() => admitPluginInstall({
      ...input,
      manifestDocument: { ...input.manifestDocument },
    })).toThrow(/produced by/);

    const original = input.files[0]!;
    expect(() => admitPluginInstall({
      ...input,
      files: [{ ...original, bytes: UTF8.encode("tampered package") }],
    })).toThrow(/file digest/);
  });

  test("returns a stable domain error for malformed admission input", () => {
    expect(() => admitPluginInstall({} as PluginInstallAdmissionInput))
      .toThrow(PluginInstallAdmissionError);
  });
});
