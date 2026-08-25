// Verify a plugin manifest directly from its transport document.

import { createHash } from "node:crypto";

import type { PluginManifest } from "./contracts.ts";
import { validatePluginManifest } from "./manifest.ts";

export const MAX_PLUGIN_MANIFEST_DOCUMENT_BYTES = 4 * 1024 * 1024;

export interface VerifiedPluginManifestDocument {
  readonly manifest: PluginManifest;
  readonly digest: string;
  readonly byteLength: number;
}

export class PluginManifestDocumentError extends Error {
  readonly code = "PLUGIN_MANIFEST_DOCUMENT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginManifestDocumentError";
  }
}

// Parse untrusted package metadata once, validate its typed contract, and retain
// the exact source-byte digest used by a lockfile or signature verifier.
export function verifyPluginManifestDocument(bytes: Uint8Array): VerifiedPluginManifestDocument {
  if (!(bytes instanceof Uint8Array)) {
    throw new PluginManifestDocumentError("plugin manifest document must be a Uint8Array");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLUGIN_MANIFEST_DOCUMENT_BYTES) {
    throw new PluginManifestDocumentError(
      "plugin manifest document must contain 1 to " + MAX_PLUGIN_MANIFEST_DOCUMENT_BYTES + " bytes",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new PluginManifestDocumentError("plugin manifest document must be valid UTF-8 JSON");
  }

  try {
    validatePluginManifest(parsed as PluginManifest);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid manifest";
    throw new PluginManifestDocumentError("plugin manifest document is invalid: " + detail);
  }

  freezeJson(parsed);
  const verified = Object.freeze({
    manifest: parsed as PluginManifest,
    digest: sha256(bytes),
    byteLength: bytes.byteLength,
  });
  VERIFIED_DOCUMENTS.add(verified);
  return verified;
}

// Reject structurally similar objects: only this verifier can establish the
// source-byte provenance consumed by a lockfile or signature policy.
export function assertVerifiedPluginManifestDocument(
  value: unknown,
): asserts value is VerifiedPluginManifestDocument {
  if (
    typeof value !== "object"
    || value === null
    || !VERIFIED_DOCUMENTS.has(value)
  ) {
    throw new PluginManifestDocumentError(
      "verified plugin manifest document must be produced by its verifier",
    );
  }
}
function freezeJson(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeJson(child);
  }
  Object.freeze(value);
}

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

const VERIFIED_DOCUMENTS = new WeakSet<object>();
const UTF8 = new TextDecoder("utf-8", { fatal: true });
