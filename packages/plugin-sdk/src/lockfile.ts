// Strict, transport-neutral plugin lockfile contracts.

import type { PluginManifest, PluginPermissionRequest } from "./contracts.ts";
import {
  assertVerifiedPluginManifestDocument,
  type VerifiedPluginManifestDocument,
} from "./manifest-document.ts";
import { validatePluginManifest } from "./manifest.ts";

export const PLUGIN_LOCKFILE_SCHEMA_VERSION = "1.0" as const;
export const MAX_PLUGIN_LOCKFILE_ENTRIES = 512;

export type PluginSignaturePolicy = "required" | "allow-unverified";

export interface PluginLockSignature {
  readonly keyId: string;
  readonly verified: boolean;
}

export interface PluginLockEntry {
  readonly version: string;
  readonly source: string;
  readonly packageDigest: string;
  readonly manifestDigest: string;
  readonly signature?: PluginLockSignature;
  readonly grants: PluginPermissionRequest;
}

export interface PluginLockfile {
  readonly schemaVersion: typeof PLUGIN_LOCKFILE_SCHEMA_VERSION;
  readonly plugins: Readonly<Record<string, PluginLockEntry>>;
}

export class PluginLockfileError extends Error {
  readonly code = "PLUGIN_LOCKFILE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginLockfileError";
  }
}

export function validatePluginLockfile(lockfile: PluginLockfile): void {
  const root = record(lockfile, "plugin lockfile");
  rejectUnknown(root, ["schemaVersion", "plugins"], "plugin lockfile");
  if (root.schemaVersion !== PLUGIN_LOCKFILE_SCHEMA_VERSION) {
    fail("plugin lockfile schemaVersion must be 1.0");
  }
  const plugins = record(root.plugins, "plugin lockfile plugins");
  const ids = Object.keys(plugins);
  if (ids.length > MAX_PLUGIN_LOCKFILE_ENTRIES) {
    fail("plugin lockfile has too many entries");
  }
  for (const id of ids) {
    pluginId(id, "plugin lockfile plugin id");
    validatePluginLockEntry(plugins[id] as PluginLockEntry);
  }
}

export function validatePluginLockEntry(entry: PluginLockEntry): void {
  const value = record(entry, "plugin lock entry");
  rejectUnknown(
    value,
    ["version", "source", "packageDigest", "manifestDigest", "signature", "grants"],
    "plugin lock entry",
  );
  semver(value.version, "plugin lock entry version");
  text(value.source, "plugin lock entry source", 512);
  digest(value.packageDigest, "plugin lock entry packageDigest");
  digest(value.manifestDigest, "plugin lock entry manifestDigest");
  validateSignature(value.signature);
  validatePermissions(value.grants, "plugin lock entry grants");
}

// Assert that a durable pin names exactly this validated manifest and that its
// stored grant never widens the manifest's permission request.
export function assertPluginLockEntryMatchesManifest(
  pluginIdValue: string,
  entry: PluginLockEntry,
  manifest: PluginManifest,
  verifiedManifestDigest: string,
): void {
  pluginId(pluginIdValue, "plugin id");
  validatePluginLockEntry(entry);
  validatePluginManifest(manifest);
  digest(verifiedManifestDigest, "verified manifest digest");
  if (pluginIdValue !== manifest.id) {
    fail("plugin lock entry id must match manifest id");
  }
  if (entry.version !== manifest.version) {
    fail("plugin lock entry version must exactly match manifest version");
  }
  if (entry.packageDigest !== manifest.integrity.packageDigest) {
    fail("plugin lock entry packageDigest must exactly match manifest packageDigest");
  }
  if (entry.manifestDigest !== verifiedManifestDigest) {
    fail("plugin lock entry manifestDigest must exactly match the verified manifest digest");
  }
  assertNarrowerPermissions(entry.grants, manifest.permissions);
}

// Prefer this bridge when a manifest came from an untrusted package document:
// it binds the lock entry to the document verifier's exact source-byte digest.
export function assertPluginLockEntryMatchesVerifiedManifest(
  entry: PluginLockEntry,
  document: VerifiedPluginManifestDocument,
): void {
  assertVerifiedPluginManifestDocument(document);
  assertPluginLockEntryMatchesManifest(
    document.manifest.id,
    entry,
    document.manifest,
    document.digest,
  );
}

// A required policy rejects omitted or explicitly unverified lock metadata.
// Cryptographic verification remains the responsibility of the package trust
// layer that owns publisher keys and revocation state.
export function assertPluginSignaturePolicy(
  entry: PluginLockEntry,
  policy: PluginSignaturePolicy,
): void {
  validatePluginLockEntry(entry);
  if (policy !== "required" && policy !== "allow-unverified") {
    fail("plugin signature policy is unsupported");
  }
  if (policy === "required" && entry.signature?.verified !== true) {
    fail("plugin lock entry requires a verified signature");
  }
}

function assertNarrowerPermissions(
  granted: PluginPermissionRequest,
  requested: PluginPermissionRequest,
): void {
  for (const field of ARRAY_PERMISSION_FIELDS) {
    const grant = granted[field] ?? [];
    const request = requested[field] ?? [];
    const allowed = new Set(request);
    if (grant.some((value) => !allowed.has(value))) {
      fail("plugin lock entry grants widen manifest " + field);
    }
  }
  for (const field of ENUM_PERMISSION_FIELDS) {
    const ranks = ENUM_PERMISSION_RANKS[field];
    const grantedValue = granted[field] ?? ranks[0]!;
    const requestedValue = requested[field] ?? ranks[0]!;
    if (ranks.indexOf(grantedValue) > ranks.indexOf(requestedValue)) {
      fail("plugin lock entry grants widen manifest " + field);
    }
  }
}

function validatePermissions(value: unknown, name: string): void {
  const permissions = record(value, name);
  rejectUnknown(permissions, ALL_PERMISSION_FIELDS, name);
  for (const field of ARRAY_PERMISSION_FIELDS) {
    const items = permissions[field];
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length > 128) {
      fail(name + "." + field + " must be a bounded array");
    }
    const seen = new Set<string>();
    for (const item of items) {
      const textValue = text(item, name + "." + field, 256);
      if (seen.has(textValue)) fail(name + "." + field + " must not contain duplicates");
      seen.add(textValue);
      if (
        (field === "workspaceRead" || field === "workspaceWrite")
        && (textValue.startsWith("/") || textValue.includes("\\") || textValue.includes(".."))
      ) {
        fail(name + "." + field + " must use logical non-traversing paths");
      }
    }
  }
  for (const field of ENUM_PERMISSION_FIELDS) {
    const ranks = ENUM_PERMISSION_RANKS[field];
    const item = permissions[field];
    if (item !== undefined && (typeof item !== "string" || !ranks.includes(item))) {
      fail(name + "." + field + " is unsupported");
    }
  }
}

function validateSignature(value: unknown): void {
  if (value === undefined) return;
  const signature = record(value, "plugin lock entry signature");
  rejectUnknown(signature, ["keyId", "verified"], "plugin lock entry signature");
  opaqueId(signature.keyId, "plugin lock entry signature keyId");
  if (typeof signature.verified !== "boolean") {
    fail("plugin lock entry signature verified must be boolean");
  }
}

function pluginId(value: unknown, name: string): void {
  if (
    typeof value !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
  ) {
    fail(name + " must be a canonical publisher/name identifier");
  }
}

function semver(value: unknown, name: string): void {
  if (
    typeof value !== "string"
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    fail(name + " must be a semantic version");
  }
}

function digest(value: unknown, name: string): void {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    fail(name + " must be a lowercase sha256 digest");
  }
}

function opaqueId(value: unknown, name: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value.trim() !== value
    || !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    fail(name + " must be a bounded opaque identifier");
  }
}

function text(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || UTF8.encode(value).byteLength > maxBytes
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(name + " must be bounded non-secret text");
  }
  return value;
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
  throw new PluginLockfileError(message);
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UTF8 = new TextEncoder();
type ArrayPermissionField =
  | "events"
  | "tools"
  | "workspaceRead"
  | "workspaceWrite"
  | "networkDomains"
  | "credentials";
type EnumPermissionField = "artifacts" | "sessionState" | "memory" | "graph";
const ARRAY_PERMISSION_FIELDS: readonly ArrayPermissionField[] = [
  "events",
  "tools",
  "workspaceRead",
  "workspaceWrite",
  "networkDomains",
  "credentials",
];
const ENUM_PERMISSION_FIELDS: readonly EnumPermissionField[] = [
  "artifacts",
  "sessionState",
  "memory",
  "graph",
];
const ENUM_PERMISSION_RANKS: Readonly<Record<EnumPermissionField, readonly string[]>> = {
  artifacts: ["none", "read-own", "create"],
  sessionState: ["none", "read", "write-own"],
  memory: ["none", "search", "propose"],
  graph: ["none", "observe", "propose-node"],
};
const ALL_PERMISSION_FIELDS: readonly string[] = [
  ...ARRAY_PERMISSION_FIELDS,
  ...ENUM_PERMISSION_FIELDS,
];
