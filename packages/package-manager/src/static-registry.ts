/** Signed, read-only static package registry over HTTPS. */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { canonicalJson } from "@cbc/app-protocol";

import type {
  CapybaraPackageManifest,
  PackageFile,
  ResolvedPackage,
} from "./contracts.ts";
import type {
  PackageResolveOptions,
  RegistryPackageTransport,
} from "./resolver.ts";
import {
  PackageVerificationError,
  parsePackageManifest,
  verifyResolvedPackage,
} from "./verify.ts";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 96 * 1024 * 1024;
const MAX_INDEX_PACKAGES = 20_000;
const MAX_VERSIONS_PER_PACKAGE = 256;

export interface StaticRegistryPackageVersion {
  readonly version: string;
  readonly artifact: string;
  readonly manifestDigest: string;
  readonly packageDigest: string;
  readonly keyId: string;
  readonly withdrawn: boolean;
}

export interface StaticRegistryPackage {
  readonly id: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly latest: string;
  readonly versions: readonly StaticRegistryPackageVersion[];
}

export interface StaticRegistrySnapshot {
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly signingKeyId: string;
  readonly packages: readonly StaticRegistryPackage[];
}

export interface SignedStaticRegistryOptions {
  readonly baseUrl: string;
  /** PEM strings or SPKI DER bytes, keyed by immutable key id. */
  readonly pinnedKeys: Readonly<Record<string, string | Uint8Array>>;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

interface RegistryIndexDocument {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly packages: readonly StaticRegistryPackage[];
  readonly revokedKeyIds: readonly string[];
  readonly signature: {
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly value: string;
  };
}

export class SignedStaticRegistryTransport implements RegistryPackageTransport {
  readonly #base: URL;
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #fetch: NonNullable<SignedStaticRegistryOptions["fetch"]>;
  readonly #now: () => number;
  #indexPromise: Promise<RegistryIndexDocument> | undefined;

  constructor(options: SignedStaticRegistryOptions) {
    this.#base = new URL(options.baseUrl);
    if (this.#base.protocol !== "https:") {
      throw new Error("package registry base URL must use HTTPS");
    }
    if (!this.#base.pathname.endsWith("/")) this.#base.pathname += "/";
    const keys = new Map<string, KeyObject>();
    for (const [keyId, value] of Object.entries(options.pinnedKeys)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(keyId)) {
        throw new Error("package registry key id is invalid");
      }
      keys.set(
        keyId,
        typeof value === "string"
          ? createPublicKey(value)
          : createPublicKey({ key: Buffer.from(value), format: "der", type: "spki" }),
      );
    }
    if (keys.size === 0) throw new Error("package registry requires at least one pinned key");
    this.#keys = keys;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  async search(query: string): Promise<readonly StaticRegistryPackage[]> {
    const normalized = boundedText(query, "registry search query", 256).toLowerCase();
    const index = await this.#index();
    return Object.freeze(index.packages.filter((item) =>
      normalized.length === 0
      || item.id.toLowerCase().includes(normalized)
      || item.description.toLowerCase().includes(normalized)
      || item.keywords.some((keyword) => keyword.toLowerCase().includes(normalized))
    ));
  }

  async inspect(packageId: string): Promise<StaticRegistryPackage | undefined> {
    return (await this.#index()).packages.find((item) => item.id === packageId);
  }

  async snapshot(): Promise<StaticRegistrySnapshot> {
    const index = await this.#index();
    return {
      generatedAt: index.generatedAt,
      expiresAt: index.expiresAt,
      signingKeyId: index.signature.keyId,
      packages: index.packages,
    };
  }

  async fetch(
    source: string,
    options: PackageResolveOptions = {},
  ): Promise<ResolvedPackage> {
    if (options.offline === true) {
      throw new PackageVerificationError(
        "PACKAGE_OFFLINE_MISS",
        "signed registry access is disabled in offline mode",
      );
    }
    const requested = parseRegistrySource(source);
    const index = await this.#index();
    const entry = index.packages.find((item) => item.id === requested.packageId);
    if (entry === undefined) {
      throw new PackageVerificationError(
        "PACKAGE_NOT_FOUND",
        "signed registry has no package " + requested.packageId,
      );
    }
    const versionName = requested.version ?? entry.latest;
    const version = entry.versions.find((item) => item.version === versionName);
    if (version === undefined) {
      throw new PackageVerificationError(
        "PACKAGE_VERSION_NOT_FOUND",
        "signed registry has no version " + versionName + " for " + entry.id,
      );
    }
    if (version.withdrawn) {
      throw new PackageVerificationError(
        "PACKAGE_WITHDRAWN",
        entry.id + "@" + version.version + " was withdrawn from the registry",
      );
    }
    if (!this.#keys.has(version.keyId)) {
      throw new PackageVerificationError(
        "PACKAGE_SIGNING_KEY_UNKNOWN",
        "package version uses an unpinned signing key " + version.keyId,
      );
    }
    if (index.revokedKeyIds.includes(version.keyId)) {
      throw new PackageVerificationError(
        "PACKAGE_SIGNING_KEY_REVOKED",
        "package version uses a revoked signing key " + version.keyId,
      );
    }
    const artifactUrl = confinedUrl(this.#base, version.artifact);
    const artifact = record(
      await fetchJson(this.#fetch, artifactUrl.href, MAX_ARTIFACT_BYTES),
      "registry artifact",
    );
    rejectUnknown(artifact, ["schemaVersion", "manifest", "files"], "registry artifact");
    if (artifact.schemaVersion !== "1.0") {
      throw invalid("registry artifact schemaVersion is unsupported");
    }
    const manifestBytes = decodeBase64(artifact.manifest, "artifact manifest");
    const manifest = parsePackageManifest(manifestBytes);
    if (
      manifest.id !== entry.id
      || manifest.version !== version.version
      || sha256(manifestBytes) !== version.manifestDigest
      || manifest.integrity.packageDigest !== version.packageDigest
    ) {
      throw invalid("registry artifact identity or digest metadata does not match the signed index");
    }
    verifyManifestSignature(manifest, version.keyId, this.#keys.get(version.keyId)!);
    const files = parseArtifactFiles(artifact.files);
    const resolved = Object.freeze({
      source,
      sourceKind: "registry",
      manifestBytes,
      files,
      signatureVerified: true,
    });
    // The transport itself is a trust boundary: callers never receive bytes
    // whose paths, file set, or content digests have not already been checked.
    verifyResolvedPackage(resolved);
    return resolved;
  }

  async #index(): Promise<RegistryIndexDocument> {
    this.#indexPromise ??= this.#loadIndex().catch((error) => {
      this.#indexPromise = undefined;
      throw error;
    });
    return await this.#indexPromise;
  }

  async #loadIndex(): Promise<RegistryIndexDocument> {
    const url = confinedUrl(this.#base, "index.json");
    const raw = record(
      await fetchJson(this.#fetch, url.href, MAX_INDEX_BYTES),
      "registry index",
    );
    rejectUnknown(
      raw,
      ["schemaVersion", "generatedAt", "expiresAt", "packages", "revokedKeyIds", "signature"],
      "registry index",
    );
    if (raw.schemaVersion !== "1.0") throw invalid("registry index schemaVersion is unsupported");
    const generatedAt = isoInstant(raw.generatedAt, "generatedAt");
    const expiresAt = isoInstant(raw.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= this.#now()) throw invalid("registry index is expired");
    if (Date.parse(generatedAt) > this.#now() + 5 * 60_000) {
      throw invalid("registry index generatedAt is in the future");
    }
    const revokedKeyIds = stringArray(raw.revokedKeyIds, "revokedKeyIds", 1_024);
    const signature = parseSignature(raw.signature);
    const key = this.#keys.get(signature.keyId);
    if (key === undefined || revokedKeyIds.includes(signature.keyId)) {
      throw invalid("registry index signing key is not pinned and active");
    }
    const signedBody = {
      schemaVersion: "1.0",
      generatedAt,
      expiresAt,
      packages: raw.packages,
      revokedKeyIds,
    };
    if (!verifyEd25519(key, canonicalJson(signedBody), signature.value)) {
      throw invalid("registry index signature verification failed");
    }
    const packages = parsePackages(raw.packages);
    return Object.freeze({
      schemaVersion: "1.0",
      generatedAt,
      expiresAt,
      packages,
      revokedKeyIds,
      signature,
    });
  }
}

function parsePackages(value: unknown): readonly StaticRegistryPackage[] {
  if (!Array.isArray(value) || value.length > MAX_INDEX_PACKAGES) {
    throw invalid("registry packages must be a bounded array");
  }
  const ids = new Set<string>();
  const packages = value.map((item) => {
    const entry = record(item, "registry package");
    rejectUnknown(entry, ["id", "description", "keywords", "latest", "versions"], "registry package");
    const id = packageId(entry.id);
    if (ids.has(id)) throw invalid("registry contains duplicate package " + id);
    ids.add(id);
    const description = boundedText(entry.description ?? "", "package description", 1_024);
    const keywords = stringArray(entry.keywords ?? [], "package keywords", 64)
      .map((keyword) => boundedText(keyword, "package keyword", 64));
    const latest = version(entry.latest);
    if (!Array.isArray(entry.versions) || entry.versions.length > MAX_VERSIONS_PER_PACKAGE) {
      throw invalid("registry package versions must be a bounded array");
    }
    const seen = new Set<string>();
    const versions = entry.versions.map((candidate) => {
      const item = record(candidate, "registry package version");
      rejectUnknown(
        item,
        ["version", "artifact", "manifestDigest", "packageDigest", "keyId", "withdrawn"],
        "registry package version",
      );
      const parsedVersion = version(item.version);
      if (seen.has(parsedVersion)) throw invalid("registry package contains a duplicate version");
      seen.add(parsedVersion);
      return Object.freeze({
        version: parsedVersion,
        artifact: boundedText(item.artifact, "artifact path", 2_048),
        manifestDigest: sha256Digest(item.manifestDigest, "manifestDigest"),
        packageDigest: sha256Digest(item.packageDigest, "packageDigest"),
        keyId: boundedText(item.keyId, "keyId", 128),
        withdrawn: item.withdrawn === true,
      });
    });
    if (!seen.has(latest)) throw invalid("registry latest does not name a listed version");
    return Object.freeze({ id, description, keywords: Object.freeze(keywords), latest, versions: Object.freeze(versions) });
  });
  return Object.freeze(packages);
}

function parseArtifactFiles(value: unknown): readonly PackageFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) {
    throw invalid("registry artifact files must be a bounded non-empty array");
  }
  const seen = new Set<string>();
  let total = 0;
  const files = value.map((candidate) => {
    const item = record(candidate, "registry artifact file");
    rejectUnknown(item, ["path", "content"], "registry artifact file");
    const path = boundedText(item.path, "artifact file path", 512);
    if (seen.has(path)) throw invalid("registry artifact has a duplicate file path");
    seen.add(path);
    const bytes = decodeBase64(item.content, "artifact file content");
    total += bytes.byteLength;
    if (total > 64 * 1024 * 1024) throw invalid("registry artifact expands beyond 64 MiB");
    return Object.freeze({ path, bytes });
  });
  return Object.freeze(files);
}

function verifyManifestSignature(
  manifest: CapybaraPackageManifest,
  expectedKeyId: string,
  key: KeyObject,
): void {
  if (manifest.signature?.keyId !== expectedKeyId) {
    throw invalid("package manifest signing key does not match the signed index");
  }
  const { signature: _signature, ...body } = manifest;
  if (!verifyEd25519(key, canonicalJson(body), manifest.signature.value)) {
    throw invalid("package manifest signature verification failed");
  }
}

function parseRegistrySource(source: string): { packageId: string; version?: string } {
  if (!source.startsWith("registry:")) throw invalid("registry source must start with registry:");
  const value = source.slice("registry:".length);
  const at = value.lastIndexOf("@");
  const slash = value.lastIndexOf("/");
  if (at > slash) {
    return { packageId: packageId(value.slice(0, at)), version: version(value.slice(at + 1)) };
  }
  return { packageId: packageId(value) };
}

function packageId(value: unknown): string {
  const id = boundedText(value, "package id", 160);
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw invalid("package id must be publisher/name");
  }
  return id;
}

function version(value: unknown): string {
  const parsed = boundedText(value, "package version", 64);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed)) {
    throw invalid("package version must be semver-like");
  }
  return parsed;
}

function parseSignature(value: unknown): RegistryIndexDocument["signature"] {
  const signature = record(value, "registry signature");
  rejectUnknown(signature, ["keyId", "algorithm", "value"], "registry signature");
  if (signature.algorithm !== "ed25519") throw invalid("registry signature algorithm must be ed25519");
  return {
    keyId: boundedText(signature.keyId, "signature keyId", 128),
    algorithm: "ed25519",
    value: boundedText(signature.value, "signature value", 1_024),
  };
}

function verifyEd25519(key: KeyObject, text: string, proof: string): boolean {
  try {
    return verifySignature(
      null,
      Buffer.from(text, "utf8"),
      key,
      Buffer.from(proof, "base64"),
    );
  } catch {
    return false;
  }
}

async function fetchJson(
  fetcher: NonNullable<SignedStaticRegistryOptions["fetch"]>,
  url: string,
  maxBytes: number,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw invalid("registry request failed with HTTP " + response.status);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw invalid("registry response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw invalid("registry response is too large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("registry response is not valid UTF-8 JSON");
  }
}

function confinedUrl(base: URL, path: string): URL {
  const target = new URL(path, base);
  if (
    target.protocol !== "https:"
    || target.origin !== base.origin
    || !target.pathname.startsWith(base.pathname)
    || target.username.length > 0
    || target.password.length > 0
  ) {
    throw invalid("registry URL escaped its configured HTTPS origin and path");
  }
  return target;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(name + " must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(name + " contains unsupported field " + key);
  }
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(name + " must be bounded text");
  }
  return value;
}

function stringArray(value: unknown, name: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw invalid(name + " must be a bounded string array");
  }
  return [...value] as string[];
}

function isoInstant(value: unknown, name: string): string {
  const text = boundedText(value, name, 64);
  if (!Number.isFinite(Date.parse(text))) throw invalid(name + " must be an ISO timestamp");
  return text;
}

function sha256Digest(value: unknown, name: string): string {
  const text = boundedText(value, name, 80);
  if (!/^sha256:[a-f0-9]{64}$/u.test(text)) throw invalid(name + " must be a SHA-256 digest");
  return text;
}

function decodeBase64(value: unknown, name: string): Uint8Array {
  const text = boundedText(value, name, MAX_ARTIFACT_BYTES * 2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)) {
    throw invalid(name + " must be canonical base64");
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function invalid(message: string): PackageVerificationError {
  return new PackageVerificationError("PACKAGE_REGISTRY_INVALID", message);
}
