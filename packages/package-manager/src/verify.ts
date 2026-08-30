import { createHash } from "node:crypto";

import { canonicalDigest } from "@cbc/app-protocol";
import {
  canonicalPluginPackageDigest,
  type PluginPermissionRequest,
} from "@cbc/plugin-sdk";

import {
  CAPYBARA_PACKAGE_LOCK_SCHEMA_VERSION,
  CAPYBARA_PACKAGE_SCHEMA_VERSION,
  type CapybaraPackageContents,
  type CapybaraPackageManifest,
  type PackageFile,
  type PackageLockEntry,
  type PackageLockfile,
  type PackageRequestFile,
  type ResolvedPackage,
  type VerifiedPackage,
} from "./contracts.ts";

export const MAX_CAPYBARA_PACKAGE_FILES = 4_096;
export const MAX_CAPYBARA_PACKAGE_BYTES = 64 * 1024 * 1024;

export class PackageVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageVerificationError";
    this.code = code;
  }
}

export function verifyResolvedPackage(
  resolved: ResolvedPackage,
  options: { readonly allowUnsignedLocal?: boolean } = {},
): VerifiedPackage {
  validateSource(resolved.source, resolved.sourceKind);
  const manifest = parsePackageManifest(resolved.manifestBytes);
  if (
    !Array.isArray(resolved.files)
    || resolved.files.length === 0
    || resolved.files.length > MAX_CAPYBARA_PACKAGE_FILES
  ) {
    fail("PACKAGE_FILE_COUNT", "package files must be non-empty and bounded");
  }
  const expectedPaths = Object.keys(manifest.integrity.files).sort(compare);
  const files = new Map<string, Uint8Array>();
  const fileDigests: Record<string, string> = {};
  let totalBytes = 0;
  for (const file of resolved.files) {
    const path = packagePath(file.path);
    if (!(file.bytes instanceof Uint8Array)) fail("PACKAGE_FILE_INVALID", "package bytes are invalid");
    if (files.has(path)) fail("PACKAGE_DUPLICATE_PATH", "package contains duplicate path " + path);
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_CAPYBARA_PACKAGE_BYTES) {
      fail("PACKAGE_TOO_LARGE", "package exceeds the 64 MiB uncompressed limit");
    }
    files.set(path, file.bytes);
    fileDigests[path] = sha256(file.bytes);
  }
  if (files.size !== expectedPaths.length || expectedPaths.some((path) => !files.has(path))) {
    fail("PACKAGE_COVERAGE", "package files must exactly match integrity coverage");
  }
  for (const path of expectedPaths) {
    if (fileDigests[path] !== manifest.integrity.files[path]) {
      fail("PACKAGE_DIGEST_MISMATCH", "package file digest mismatch for " + path);
    }
  }
  const packageDigest = canonicalPluginPackageDigest(fileDigests);
  if (packageDigest !== manifest.integrity.packageDigest) {
    fail("PACKAGE_DIGEST_MISMATCH", "package digest does not match manifest");
  }
  for (const path of contentPaths(manifest.contents)) {
    if (!(path in manifest.integrity.files)) {
      fail("PACKAGE_CONTENT_UNCOVERED", "package content is outside integrity coverage: " + path);
    }
  }
  if (resolved.sourceKind === "registry") {
    if (manifest.signature === undefined || resolved.signatureVerified !== true) {
      fail("PACKAGE_SIGNATURE_REQUIRED", "registry package requires a verified signature");
    }
  } else if (
    manifest.signature === undefined
    && options.allowUnsignedLocal !== true
  ) {
    fail("PACKAGE_LOCAL_UNVERIFIED", "unsigned local package requires an explicit development opt-in");
  }
  if (manifest.signature !== undefined && resolved.signatureVerified !== true) {
    fail("PACKAGE_SIGNATURE_INVALID", "package signature metadata was not cryptographically verified");
  }
  return Object.freeze({
    manifest,
    manifestDigest: sha256(resolved.manifestBytes),
    packageDigest,
    fileDigests: Object.freeze(fileDigests),
    totalBytes,
    source: resolved.source,
    sourceKind: resolved.sourceKind,
    signatureVerified: resolved.signatureVerified,
  });
}

export function parsePackageManifest(bytes: Uint8Array): CapybaraPackageManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("PACKAGE_MANIFEST_INVALID", "package manifest must be valid UTF-8 JSON");
  }
  const value = record(parsed, "package manifest");
  rejectUnknown(value, [
    "schemaVersion",
    "id",
    "version",
    "capybara",
    "contents",
    "permissions",
    "integrity",
    "signature",
  ], "package manifest");
  if (value.schemaVersion !== CAPYBARA_PACKAGE_SCHEMA_VERSION) {
    fail("PACKAGE_MANIFEST_INVALID", "package schemaVersion must be 1.0");
  }
  packageId(value.id);
  semver(value.version, "package version");
  text(value.capybara, "package compatibility", 128);
  const contents = validateContents(value.contents);
  const permissions = validatePermissions(value.permissions);
  const integrity = record(value.integrity, "package integrity");
  rejectUnknown(integrity, ["files", "packageDigest"], "package integrity");
  const files = record(integrity.files, "package integrity files");
  if (Object.keys(files).length === 0 || Object.keys(files).length > MAX_CAPYBARA_PACKAGE_FILES) {
    fail("PACKAGE_MANIFEST_INVALID", "package integrity files must be non-empty and bounded");
  }
  const normalizedFiles: Record<string, string> = {};
  for (const [path, digest] of Object.entries(files)) {
    normalizedFiles[packagePath(path)] = shaDigest(digest, "file digest");
  }
  const packageDigest = shaDigest(integrity.packageDigest, "package digest");
  const signature = value.signature === undefined ? undefined : validateSignature(value.signature);
  return Object.freeze({
    schemaVersion: "1.0",
    id: value.id as string,
    version: value.version as string,
    capybara: value.capybara as string,
    contents,
    permissions,
    integrity: {
      files: Object.freeze(normalizedFiles),
      packageDigest,
    },
    ...(signature === undefined ? {} : { signature }),
  });
}

export function validatePackageLockfile(lockfile: PackageLockfile): void {
  const value = record(lockfile, "package lockfile");
  rejectUnknown(value, ["schemaVersion", "packages"], "package lockfile");
  if (value.schemaVersion !== CAPYBARA_PACKAGE_LOCK_SCHEMA_VERSION) {
    fail("PACKAGE_LOCK_INVALID", "package lock schemaVersion must be 1.0");
  }
  const packages = record(value.packages, "package lock entries");
  if (Object.keys(packages).length > 512) fail("PACKAGE_LOCK_INVALID", "package lock has too many entries");
  for (const [id, raw] of Object.entries(packages)) {
    packageId(id);
    validatePackageLockEntry(raw as PackageLockEntry);
  }
}

export function validatePackageLockEntry(entry: PackageLockEntry): void {
  const value = record(entry, "package lock entry");
  rejectUnknown(value, [
    "version",
    "source",
    "sourceKind",
    "packageDigest",
    "manifestDigest",
    "signature",
    "grants",
    "contents",
  ], "package lock entry");
  semver(value.version, "package lock version");
  if (value.sourceKind !== "registry" && value.sourceKind !== "local-path") {
    fail("PACKAGE_LOCK_INVALID", "package lock sourceKind is unsupported");
  }
  validateSource(value.source as string, value.sourceKind);
  shaDigest(value.packageDigest, "package lock packageDigest");
  shaDigest(value.manifestDigest, "package lock manifestDigest");
  validatePermissions(value.grants);
  validateContents(value.contents);
  if (value.sourceKind === "registry") {
    const signature = record(value.signature, "package lock signature");
    rejectUnknown(signature, ["keyId", "verified"], "package lock signature");
    text(signature.keyId, "package lock signature keyId", 128);
    if (signature.verified !== true) {
      fail("PACKAGE_LOCK_INVALID", "registry package lock signature must be verified");
    }
  }
}

export function validatePackageRequestFile(value: PackageRequestFile): void {
  const root = record(value, "package request file");
  rejectUnknown(root, ["schemaVersion", "packages"], "package request file");
  if (root.schemaVersion !== "1.0" || !Array.isArray(root.packages) || root.packages.length > 512) {
    fail("PACKAGE_REQUEST_INVALID", "package request file is invalid");
  }
  const sources = new Set<string>();
  for (const raw of root.packages) {
    const request = record(raw, "package request");
    rejectUnknown(request, ["source", "scope", "grants"], "package request");
    if (request.scope !== "project" && request.scope !== "user") {
      fail("PACKAGE_REQUEST_INVALID", "package request scope is unsupported");
    }
    const source = text(request.source, "package request source", 1024);
    if (sources.has(source)) fail("PACKAGE_REQUEST_INVALID", "package request source is duplicated");
    sources.add(source);
    if (request.grants !== undefined) validatePermissions(request.grants);
  }
}

export function assertGrantNarrowing(
  grant: PluginPermissionRequest,
  requested: PluginPermissionRequest,
): void {
  validatePermissions(grant);
  validatePermissions(requested);
  for (const field of ARRAY_PERMISSION_FIELDS) {
    const ceiling = new Set(requested[field] ?? []);
    if ((grant[field] ?? []).some((value) => !ceiling.has(value))) {
      fail("PACKAGE_GRANT_WIDENING", "package grants widen " + field);
    }
  }
  for (const field of ENUM_PERMISSION_FIELDS) {
    const ranks = ENUM_RANKS[field];
    const granted = grant[field] ?? ranks[0]!;
    const ceiling = requested[field] ?? ranks[0]!;
    if (ranks.indexOf(granted) > ranks.indexOf(ceiling)) {
      fail("PACKAGE_GRANT_WIDENING", "package grants widen " + field);
    }
  }
}

export function packageLockDigest(lockfile: PackageLockfile): string {
  validatePackageLockfile(lockfile);
  return canonicalDigest(lockfile);
}

function validateContents(value: unknown): CapybaraPackageContents {
  const contents = record(value, "package contents");
  rejectUnknown(contents, CONTENT_FIELDS, "package contents");
  const result: Record<string, readonly string[]> = {};
  for (const field of CONTENT_FIELDS) {
    const raw = contents[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.length > 512) {
      fail("PACKAGE_MANIFEST_INVALID", "package contents." + field + " must be a bounded array");
    }
    const items = raw.map((path) => packagePath(path));
    if (new Set(items).size !== items.length) {
      fail("PACKAGE_MANIFEST_INVALID", "package contents." + field + " contains duplicates");
    }
    result[field] = Object.freeze(items);
  }
  return Object.freeze(result as CapybaraPackageContents);
}

function validatePermissions(value: unknown): PluginPermissionRequest {
  const permissions = record(value, "package permissions");
  rejectUnknown(permissions, PERMISSION_FIELDS, "package permissions");
  const out: Record<string, unknown> = {};
  for (const field of ARRAY_PERMISSION_FIELDS) {
    const raw = permissions[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.length > 128) {
      fail("PACKAGE_MANIFEST_INVALID", "package permission " + field + " must be a bounded array");
    }
    const items = raw.map((item) => text(item, "package permission " + field, 256));
    if (new Set(items).size !== items.length) {
      fail("PACKAGE_MANIFEST_INVALID", "package permission " + field + " contains duplicates");
    }
    if (
      (field === "workspaceRead" || field === "workspaceWrite")
      && items.some((path) => path.startsWith("/") || path.includes("\\") || path.includes(".."))
    ) {
      fail("PACKAGE_MANIFEST_INVALID", "package workspace permissions must not traverse");
    }
    out[field] = Object.freeze(items);
  }
  for (const field of ENUM_PERMISSION_FIELDS) {
    const raw = permissions[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !ENUM_RANKS[field].includes(raw)) {
      fail("PACKAGE_MANIFEST_INVALID", "package permission " + field + " is unsupported");
    }
    out[field] = raw;
  }
  return Object.freeze(out as PluginPermissionRequest);
}

function validateSignature(value: unknown) {
  const signature = record(value, "package signature");
  rejectUnknown(signature, ["keyId", "algorithm", "value"], "package signature");
  const keyId = text(signature.keyId, "package signature keyId", 128);
  if (signature.algorithm !== "ed25519") {
    fail("PACKAGE_SIGNATURE_INVALID", "package signature algorithm must be ed25519");
  }
  const proof = text(signature.value, "package signature value", 4096);
  return Object.freeze({ keyId, algorithm: "ed25519" as const, value: proof });
}

function validateSource(source: unknown, kind: "registry" | "local-path"): void {
  const value = text(source, "package source", 1024);
  if (kind === "registry" && !value.startsWith("registry:")) {
    fail("PACKAGE_SOURCE_INVALID", "registry package source must start with registry:");
  }
  if (kind === "local-path" && !value.startsWith("path:")) {
    fail("PACKAGE_SOURCE_INVALID", "local package source must start with path:");
  }
}

function contentPaths(contents: CapybaraPackageContents): string[] {
  return CONTENT_FIELDS.flatMap((field) => [...(contents[field] ?? [])]);
}

function packagePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("PACKAGE_PATH_INVALID", "package path must be relative and non-traversing");
  }
  return value;
}

function packageId(value: unknown): void {
  if (
    typeof value !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
  ) {
    fail("PACKAGE_ID_INVALID", "package id must use publisher/name form");
  }
}

function semver(value: unknown, name: string): void {
  if (
    typeof value !== "string"
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    fail("PACKAGE_VERSION_INVALID", name + " must be semantic version");
  }
}

function shaDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail("PACKAGE_DIGEST_INVALID", name + " must be a lowercase sha256 digest");
  }
  return value;
}

function text(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("PACKAGE_TEXT_INVALID", name + " must be bounded text");
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("PACKAGE_SHAPE_INVALID", name + " must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail("PACKAGE_UNKNOWN_FIELD", name + " contains unsupported field " + unknown[0]);
  }
}

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function fail(code: string, message: string): never {
  throw new PackageVerificationError(code, message);
}

const CONTENT_FIELDS = [
  "plugins",
  "skills",
  "agents",
  "prompts",
  "themes",
  "hooks",
  "schemas",
  "assets",
] as const;
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
const PERMISSION_FIELDS = [...ARRAY_PERMISSION_FIELDS, ...ENUM_PERMISSION_FIELDS];
const ENUM_RANKS: Readonly<Record<EnumPermissionField, readonly string[]>> = {
  artifacts: ["none", "read-own", "create"],
  sessionState: ["none", "read", "write-own"],
  memory: ["none", "search", "propose"],
  graph: ["none", "observe", "propose-node"],
};
