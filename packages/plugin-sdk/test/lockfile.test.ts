import { describe, expect, test } from "bun:test";

import {
  PluginLockfileError,
  assertPluginLockEntryMatchesManifest,
  assertPluginLockEntryMatchesVerifiedManifest,
  assertPluginSignaturePolicy,
  validatePluginLockfile,
  verifyPluginManifestDocument,
  type PluginLockEntry,
  type PluginLockfile,
  type PluginManifest,
} from "../src/index.ts";

const PACKAGE_DIGEST = "sha256:" + "a".repeat(64);
const MANIFEST_DIGEST = "sha256:" + "b".repeat(64);
const OTHER_DIGEST = "sha256:" + "c".repeat(64);

function manifest(): PluginManifest {
  return {
    schemaVersion: "1.0",
    id: "acme/locked",
    name: "Locked plugin",
    version: "1.2.3",
    publisher: "acme",
    description: "A plugin with an install-time lock entry.",
    license: "Apache-2.0",
    runtime: { kind: "wasi", entrypoint: "plugin.wasm", protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=1.0.0" },
    permissions: {
      events: ["before.tool", "after.tool"],
      tools: ["fs.read", "search.query"],
      workspaceRead: ["README.md", "src/**"],
      workspaceWrite: ["notes/**"],
      networkDomains: ["api.example.test"],
      credentials: ["repo-token"],
      artifacts: "create",
      sessionState: "write-own",
      memory: "propose",
      graph: "propose-node",
    },
    integrity: {
      files: { "plugin.wasm": PACKAGE_DIGEST },
      packageDigest: PACKAGE_DIGEST,
    },
  };
}

function entry(overrides: Partial<PluginLockEntry> = {}): PluginLockEntry {
  return {
    version: "1.2.3",
    source: "registry:acme",
    packageDigest: PACKAGE_DIGEST,
    manifestDigest: MANIFEST_DIGEST,
    signature: { keyId: "acme-release-2026", verified: true },
    grants: {
      events: ["after.tool"],
      tools: ["fs.read"],
      workspaceRead: ["src/**"],
      workspaceWrite: ["notes/**"],
      networkDomains: ["api.example.test"],
      credentials: ["repo-token"],
      artifacts: "read-own",
      sessionState: "read",
      memory: "search",
      graph: "observe",
    },
    ...overrides,
  };
}

function unsignedEntry(): PluginLockEntry {
  const signed = entry();
  return {
    version: signed.version,
    source: signed.source,
    packageDigest: signed.packageDigest,
    manifestDigest: signed.manifestDigest,
    grants: signed.grants,
  };
}

describe("plugin lockfile validation", () => {
  test("accepts an exact pin with grants narrower than its manifest request", () => {
    const lockfile: PluginLockfile = {
      schemaVersion: "1.0",
      plugins: { "acme/locked": entry() },
    };

    expect(() => validatePluginLockfile(lockfile)).not.toThrow();
    expect(() => assertPluginLockEntryMatchesManifest(
      "acme/locked",
      entry(),
      manifest(),
      MANIFEST_DIGEST,
    )).not.toThrow();
  });

  test("binds lock validation to a verified manifest document digest", () => {
    const document = verifyPluginManifestDocument(
      new TextEncoder().encode(JSON.stringify(manifest())),
    );
    const pinned = entry({ manifestDigest: document.digest });

    expect(() => assertPluginLockEntryMatchesVerifiedManifest(
      pinned,
      document,
    )).not.toThrow();
    expect(() => assertPluginLockEntryMatchesVerifiedManifest(
      entry(),
      document,
    )).toThrow(/manifestDigest/);
    expect(() => assertPluginLockEntryMatchesVerifiedManifest(
      pinned,
      { ...document },
    )).toThrow(/produced by/);
  });

  test("rejects grants that widen array or enum permissions", () => {
    const base = entry();
    const arrayWidened = entry({
      grants: { ...base.grants, workspaceRead: ["docs/**"] },
    });
    expect(() => assertPluginLockEntryMatchesManifest(
      "acme/locked",
      arrayWidened,
      manifest(),
      MANIFEST_DIGEST,
    )).toThrow(/widen manifest workspaceRead/);

    const requested = manifest();
    const lowerRequested: PluginManifest = {
      ...requested,
      permissions: { ...requested.permissions, memory: "search" },
    };
    const enumWidened = entry({
      grants: { ...base.grants, memory: "propose" },
    });
    expect(() => assertPluginLockEntryMatchesManifest(
      "acme/locked",
      enumWidened,
      lowerRequested,
      MANIFEST_DIGEST,
    )).toThrow(/widen manifest memory/);
  });

  test("requires exact version, package, and verified manifest digest pins", () => {
    expect(() => assertPluginLockEntryMatchesManifest(
      "acme/locked",
      entry({ version: "1.2.4" }),
      manifest(),
      MANIFEST_DIGEST,
    )).toThrow(/version/);
    expect(() => assertPluginLockEntryMatchesManifest(
      "acme/locked",
      entry({ packageDigest: OTHER_DIGEST }),
      manifest(),
      MANIFEST_DIGEST,
    )).toThrow(/packageDigest/);
    expect(() => assertPluginLockEntryMatchesManifest(
      "acme/locked",
      entry(),
      manifest(),
      OTHER_DIGEST,
    )).toThrow(/manifestDigest/);
  });

  test("enforces required signatures without doing cryptographic verification itself", () => {
    expect(() => assertPluginSignaturePolicy(unsignedEntry(), "required"))
      .toThrow(/verified signature/);
    expect(() => assertPluginSignaturePolicy(
      entry({ signature: { keyId: "acme-release-2026", verified: false } }),
      "required",
    )).toThrow(/verified signature/);
    expect(() => assertPluginSignaturePolicy(entry(), "required")).not.toThrow();
    expect(() => assertPluginSignaturePolicy(unsignedEntry(), "allow-unverified")).not.toThrow();
  });

  test("rejects unrecognized grant fields instead of silently accepting authority", () => {
    const invalid = {
      schemaVersion: "1.0",
      plugins: {
        "acme/locked": {
          ...entry(),
          grants: { ...entry().grants, rawFilesystem: ["C:/"] },
        },
      },
    };
    expect(() => validatePluginLockfile(invalid as PluginLockfile))
      .toThrow(PluginLockfileError);
  });
});
