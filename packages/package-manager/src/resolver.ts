import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CapybaraPackageSignature,
  PackageLockfile,
  ResolvedPackage,
} from "./contracts.ts";
import { packageCacheEntryPath } from "./filesystem-store.ts";
import {
  PackageVerificationError,
  parsePackageManifest,
  validatePackageLockfile,
} from "./verify.ts";

export interface PackageResolveOptions {
  readonly offline?: boolean;
}

export interface PackageResolver {
  resolve(source: string, options?: PackageResolveOptions): Promise<ResolvedPackage>;
}

export class CompositePackageResolver implements PackageResolver {
  readonly #resolvers: readonly PackageResolver[];

  constructor(resolvers: readonly PackageResolver[]) {
    this.#resolvers = [...resolvers];
  }

  async resolve(source: string, options: PackageResolveOptions = {}): Promise<ResolvedPackage> {
    const errors: string[] = [];
    for (const resolver of this.#resolvers) {
      try {
        return await resolver.resolve(source, options);
      } catch (error) {
        if (error instanceof UnsupportedPackageSourceError) {
          errors.push(error.message);
          continue;
        }
        throw error;
      }
    }
    throw new UnsupportedPackageSourceError(
      "no package resolver accepted " + source + (errors.length > 0 ? ": " + errors.join("; ") : ""),
    );
  }
}

export class UnsupportedPackageSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPackageSourceError";
  }
}

export interface LocalPathPackageResolverOptions {
  readonly workspaceRoot: string;
  readonly signatureVerifier?: (
    manifestBytes: Uint8Array,
    signature: CapybaraPackageSignature,
  ) => Promise<boolean>;
}

export class LocalPathPackageResolver implements PackageResolver {
  readonly #workspaceRoot: string;
  readonly #signatureVerifier: LocalPathPackageResolverOptions["signatureVerifier"];

  constructor(options: LocalPathPackageResolverOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#signatureVerifier = options.signatureVerifier;
  }

  async resolve(source: string): Promise<ResolvedPackage> {
    if (!source.startsWith("path:")) {
      throw new UnsupportedPackageSourceError("local resolver accepts path: sources only");
    }
    const requested = source.slice("path:".length);
    if (requested.length === 0 || requested.includes("\0")) {
      throw new PackageVerificationError("PACKAGE_SOURCE_INVALID", "local package path is invalid");
    }
    const packageRoot = resolve(this.#workspaceRoot, requested);
    await assertContained(await realpath(this.#workspaceRoot), await realpath(packageRoot));
    const rootStat = await lstat(packageRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new PackageVerificationError(
        "PACKAGE_SOURCE_INVALID",
        "local package root must be a real directory",
      );
    }
    const manifestPath = resolve(packageRoot, "capybara.package.json");
    await assertRegularFile(packageRoot, manifestPath);
    const manifestBytes = new Uint8Array(await readFile(manifestPath));
    const manifest = parsePackageManifest(manifestBytes);
    const files = [];
    for (const path of Object.keys(manifest.integrity.files).sort()) {
      const absolute = resolve(packageRoot, ...path.split("/"));
      await assertRegularFile(packageRoot, absolute);
      files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
    }
    const signatureVerified = manifest.signature === undefined
      ? false
      : await this.#signatureVerifier?.(manifestBytes, manifest.signature) ?? false;
    return Object.freeze({
      source,
      sourceKind: "local-path",
      manifestBytes,
      files: Object.freeze(files),
      signatureVerified,
    });
  }
}

export interface RegistryPackageTransport {
  fetch(source: string, options: PackageResolveOptions): Promise<ResolvedPackage>;
}

/**
 * Network/cache policy stays outside the verifier. The transport must return
 * frozen bytes; this wrapper fences source kind and offline behavior.
 */
export class RegistryPackageResolver implements PackageResolver {
  readonly #transport: RegistryPackageTransport;

  constructor(transport: RegistryPackageTransport) {
    this.#transport = transport;
  }

  async resolve(source: string, options: PackageResolveOptions = {}): Promise<ResolvedPackage> {
    if (!source.startsWith("registry:")) {
      throw new UnsupportedPackageSourceError("registry resolver accepts registry: sources only");
    }
    const resolved = await this.#transport.fetch(source, options);
    if (resolved.source !== source || resolved.sourceKind !== "registry") {
      throw new PackageVerificationError(
        "PACKAGE_SOURCE_INVALID",
        "registry transport returned mismatched source identity",
      );
    }
    return resolved;
  }
}

export interface ImmutableCachePackageResolverOptions {
  readonly cacheRoot: string;
  readonly lockfile: PackageLockfile | (() => Promise<PackageLockfile>);
}

/** Read only bytes pinned by an already-validated lockfile from the immutable cache. */
export class ImmutableCachePackageResolver implements PackageResolver {
  readonly #cacheRoot: string;
  readonly #lockfile: ImmutableCachePackageResolverOptions["lockfile"];

  constructor(options: ImmutableCachePackageResolverOptions) {
    this.#cacheRoot = resolve(options.cacheRoot);
    this.#lockfile = options.lockfile;
  }

  async resolve(source: string): Promise<ResolvedPackage> {
    const lockfile = typeof this.#lockfile === "function"
      ? await this.#lockfile()
      : this.#lockfile;
    validatePackageLockfile(lockfile);
    const matches = Object.entries(lockfile.packages)
      .filter(([, entry]) => entry.source === source);
    if (matches.length !== 1) {
      throw new UnsupportedPackageSourceError(
        matches.length === 0
          ? "immutable cache has no lock entry for " + source
          : "immutable cache source is ambiguous: " + source,
      );
    }
    const [packageId, entry] = matches[0]!;
    const packageRoot = packageCacheEntryPath(
      this.#cacheRoot,
      packageId,
      entry.version,
      entry.packageDigest,
    );
    const manifestPath = resolve(packageRoot, "capybara.package.json");
    await assertRegularFile(packageRoot, manifestPath);
    const manifestBytes = new Uint8Array(await readFile(manifestPath));
    const manifest = parsePackageManifest(manifestBytes);
    const files = [];
    for (const path of Object.keys(manifest.integrity.files).sort()) {
      const absolute = resolve(packageRoot, ...path.split("/"));
      await assertRegularFile(packageRoot, absolute);
      files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
    }
    return Object.freeze({
      source,
      sourceKind: entry.sourceKind,
      manifestBytes,
      files: Object.freeze(files),
      signatureVerified: entry.sourceKind === "registry"
        && entry.signature?.verified === true,
    });
  }
}

export class MemoryPackageResolver implements PackageResolver {
  readonly #packages: ReadonlyMap<string, ResolvedPackage>;

  constructor(packages: ReadonlyMap<string, ResolvedPackage> | Readonly<Record<string, ResolvedPackage>>) {
    this.#packages = packages instanceof Map
      ? packages
      : new Map(Object.entries(packages));
  }

  async resolve(source: string): Promise<ResolvedPackage> {
    const resolved = this.#packages.get(source);
    if (resolved === undefined) throw new UnsupportedPackageSourceError("unknown package source " + source);
    return resolved;
  }
}

async function assertRegularFile(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  await assertContained(canonicalRoot, canonical);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PackageVerificationError(
      "PACKAGE_SPECIAL_FILE",
      "package content must be a regular non-symlink file",
    );
  }
}

async function assertContained(root: string, path: string): Promise<void> {
  const traversal = relative(root, path);
  if (
    traversal === ".."
    || traversal.startsWith(".." + sep)
    || isAbsolute(traversal)
  ) {
    throw new PackageVerificationError(
      "PACKAGE_PATH_ESCAPE",
      "local package path escapes the trusted workspace",
    );
  }
}
