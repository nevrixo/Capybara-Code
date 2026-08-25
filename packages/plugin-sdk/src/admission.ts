// Compose plugin package, lockfile, signature-policy, and scope checks before install.

import type { PluginInstallScope } from "./contracts.ts";
import type { PluginPackageFile, PluginPackageVerification } from "./package.ts";
import {
  assertPluginLockEntryMatchesVerifiedManifest,
  assertPluginSignaturePolicy,
  type PluginLockEntry,
  type PluginSignaturePolicy,
} from "./lockfile.ts";
import {
  assertVerifiedPluginManifestDocument,
  type VerifiedPluginManifestDocument,
} from "./manifest-document.ts";
import { verifyPluginPackage } from "./package.ts";

export type PluginInstallSourceKind = "builtin" | "registry" | "local-path";

export interface PluginInstallAdmissionInput {
  readonly scope: PluginInstallScope;
  readonly sourceKind: PluginInstallSourceKind;
  readonly source: string;
  readonly manifestDocument: VerifiedPluginManifestDocument;
  readonly files: readonly PluginPackageFile[];
  readonly lockEntry: PluginLockEntry;
  readonly signaturePolicy?: PluginSignaturePolicy;
}

export interface PluginInstallAdmission {
  readonly pluginId: string;
  readonly version: string;
  readonly scope: PluginInstallScope;
  readonly sourceKind: PluginInstallSourceKind;
  readonly source: string;
  readonly runtimeKind: "wasi" | "stdio";
  readonly packageDigest: string;
  readonly manifestDigest: string;
  readonly signatureVerified: boolean;
  readonly package: PluginPackageVerification;
}

export class PluginInstallAdmissionError extends Error {
  readonly code = "PLUGIN_INSTALL_ADMISSION_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "PluginInstallAdmissionError";
  }
}

// This preflight is deliberately not an installer: it only produces immutable
// evidence suitable for a durable installation record or sandbox supervisor.
export function admitPluginInstall(input: PluginInstallAdmissionInput): PluginInstallAdmission {
  const value = record(input, "plugin install admission");
  rejectUnknown(
    value,
    ["scope", "sourceKind", "source", "manifestDocument", "files", "lockEntry", "signaturePolicy"],
    "plugin install admission",
  );

  const scope = parseScope(value.scope);
  const sourceKind = parseSourceKind(value.sourceKind);
  const source = parseSource(value.source);
  const signaturePolicy = parseSignaturePolicy(value.signaturePolicy, scope, sourceKind);
  const manifestDocument = value.manifestDocument as VerifiedPluginManifestDocument;
  const lockEntry = value.lockEntry as PluginLockEntry;

  assertVerifiedPluginManifestDocument(manifestDocument);
  if (scope === "project" && manifestDocument.manifest.runtime.kind !== "wasi") {
    fail("project plugins must use the isolated wasi runtime");
  }

  const packageVerification = verifyPluginPackage({
    manifest: manifestDocument.manifest,
    files: value.files as readonly PluginPackageFile[],
  });
  assertPluginLockEntryMatchesVerifiedManifest(lockEntry, manifestDocument);
  if (lockEntry.source !== source) {
    fail("plugin lock entry source must exactly match the admission source");
  }
  assertPluginSignaturePolicy(lockEntry, signaturePolicy);
  assertSignatureMetadataMatchesManifest(lockEntry, manifestDocument, signaturePolicy);

  return Object.freeze({
    pluginId: manifestDocument.manifest.id,
    version: manifestDocument.manifest.version,
    scope,
    sourceKind,
    source,
    runtimeKind: manifestDocument.manifest.runtime.kind,
    packageDigest: packageVerification.packageDigest,
    manifestDigest: manifestDocument.digest,
    signatureVerified: lockEntry.signature?.verified === true,
    package: packageVerification,
  });
}

function assertSignatureMetadataMatchesManifest(
  lockEntry: PluginLockEntry,
  document: VerifiedPluginManifestDocument,
  policy: PluginSignaturePolicy,
): void {
  const manifestSignature = document.manifest.signature;
  const lockSignature = lockEntry.signature;
  if (policy === "required" && manifestSignature === undefined) {
    fail("a required plugin signature policy needs a manifest signature");
  }
  if (lockSignature === undefined) return;
  if (manifestSignature === undefined || manifestSignature.keyId !== lockSignature.keyId) {
    fail("plugin lock signature keyId must match the manifest signature");
  }
}

function parseScope(value: unknown): PluginInstallScope {
  if (value === "builtin" || value === "user" || value === "project") return value;
  fail("plugin install scope is unsupported");
}

function parseSourceKind(value: unknown): PluginInstallSourceKind {
  if (value === "builtin" || value === "registry" || value === "local-path") return value;
  fail("plugin install source kind is unsupported");
}

function parseSource(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || UTF8.encode(value).byteLength > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("plugin install source must be bounded non-secret text");
  }
  return value;
}

function parseSignaturePolicy(
  value: unknown,
  scope: PluginInstallScope,
  sourceKind: PluginInstallSourceKind,
): PluginSignaturePolicy {
  const policy = value === undefined
    ? sourceKind === "local-path" && scope !== "builtin"
      ? "allow-unverified"
      : "required"
    : value;
  if (policy !== "required" && policy !== "allow-unverified") {
    fail("plugin signature policy is unsupported");
  }
  if (
    policy !== "required"
    && (scope === "builtin" || sourceKind === "builtin" || sourceKind === "registry")
  ) {
    fail("builtin and registry plugins require verified signatures");
  }
  return policy;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(name + " must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(name + " contains unsupported field " + key);
  }
}

function fail(message: string): never {
  throw new PluginInstallAdmissionError(message);
}

const UTF8 = new TextEncoder();
