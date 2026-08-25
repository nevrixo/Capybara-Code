// Deterministic, in-memory plugin package integrity verification.

import { createHash } from "node:crypto";

import type { PluginManifest } from "./contracts.ts";
import { validatePluginManifest } from "./manifest.ts";

export const MAX_PLUGIN_PACKAGE_FILES = 4_096;
export const MAX_PLUGIN_PACKAGE_BYTES = 64 * 1024 * 1024;

export interface PluginPackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PluginPackageInput {
  readonly manifest: PluginManifest;
  readonly files: readonly PluginPackageFile[];
}

export interface PluginPackageVerification {
  readonly pluginId: string;
  readonly packageDigest: string;
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly totalBytes: number;
}

export class PluginPackageVerificationError extends Error {
  readonly code = "PLUGIN_PACKAGE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginPackageVerificationError";
  }
}

// Verify layout and both digest layers before a package can enter a supervisor.
export function verifyPluginPackage(input: PluginPackageInput): PluginPackageVerification {
  if (!isRecord(input)) {
    throw new PluginPackageVerificationError("plugin package input must be an object");
  }
  validatePluginManifest(input.manifest);
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_PLUGIN_PACKAGE_FILES) {
    throw new PluginPackageVerificationError(
      "plugin package files must contain 1 to " + MAX_PLUGIN_PACKAGE_FILES + " entries",
    );
  }

  const expected = input.manifest.integrity.files;
  const expectedPaths = Object.keys(expected).sort(bytewiseCompare);
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const file of input.files) {
    if (!isRecord(file)) {
      throw new PluginPackageVerificationError("plugin package file must be an object");
    }
    const path = packagePath(file.path);
    if (!(file.bytes instanceof Uint8Array)) {
      throw new PluginPackageVerificationError("plugin package file bytes must be a Uint8Array");
    }
    if (files.has(path)) {
      throw new PluginPackageVerificationError("plugin package contains duplicate file paths");
    }
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_PLUGIN_PACKAGE_BYTES) {
      throw new PluginPackageVerificationError(
        "plugin package exceeds " + MAX_PLUGIN_PACKAGE_BYTES + " bytes",
      );
    }
    files.set(path, file.bytes);
  }

  if (files.size !== expectedPaths.length) {
    throw new PluginPackageVerificationError(
      "plugin package files must exactly match manifest integrity coverage",
    );
  }

  const actualDigests: Record<string, string> = {};
  for (const path of expectedPaths) {
    const bytes = files.get(path);
    if (bytes === undefined) {
      throw new PluginPackageVerificationError(
        "plugin package is missing manifest-declared file " + path,
      );
    }
    const actual = sha256(bytes);
    if (actual !== expected[path]) {
      throw new PluginPackageVerificationError(
        "plugin package file digest does not match manifest for " + path,
      );
    }
    actualDigests[path] = actual;
  }

  const packageDigest = canonicalPluginPackageDigest(actualDigests);
  if (packageDigest !== input.manifest.integrity.packageDigest) {
    throw new PluginPackageVerificationError("plugin package digest does not match manifest");
  }

  return Object.freeze({
    pluginId: input.manifest.id,
    packageDigest,
    fileDigests: Object.freeze(actualDigests),
    totalBytes,
  });
}

// Compute the package digest from sorted path/digest records with unambiguous
// NUL and newline separators. It intentionally hashes file digests, not paths
// on disk, so it is portable across package transports.
export function canonicalPluginPackageDigest(fileDigests: Readonly<Record<string, string>>): string {
  if (!isRecord(fileDigests)) {
    throw new PluginPackageVerificationError("plugin package digest input must be an object");
  }
  const paths = Object.keys(fileDigests).sort(bytewiseCompare);
  if (paths.length === 0 || paths.length > MAX_PLUGIN_PACKAGE_FILES) {
    throw new PluginPackageVerificationError(
      "plugin package digest input must contain 1 to " + MAX_PLUGIN_PACKAGE_FILES + " files",
    );
  }

  const hash = createHash("sha256");
  for (const path of paths) {
    const digest = fileDigests[path];
    packagePath(path);
    if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
      throw new PluginPackageVerificationError("plugin package digest input contains an invalid file digest");
    }
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(digest, "utf8");
    hash.update("\n", "utf8");
  }
  return "sha256:" + hash.digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function packagePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new PluginPackageVerificationError(
      "plugin package path must be a package-relative path without traversal",
    );
  }
  return value;
}

function bytewiseCompare(left: string, right: string): number {
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftBytes[index]! - rightBytes[index]!;
    if (delta !== 0) return delta;
  }
  return leftBytes.length - rightBytes.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UTF8 = new TextEncoder();
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
