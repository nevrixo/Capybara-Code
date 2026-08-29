import {
  admitPluginInstall,
  verifyPluginManifestDocument,
  type PluginInstallAdmission,
  type PluginLockEntry,
  type PluginManifest,
  type PluginPermissionRequest,
} from "@cbc/plugin-sdk";

import {
  emptyPackageLockfile,
  type PackageInstallScope,
  type PackageLockEntry,
  type PackageLockfile,
  type PackageOperationReceipt,
  type PackageRequestFile,
  type ResolvedPackage,
  type VerifiedPackage,
} from "./contracts.ts";
import type { PackageResolver } from "./resolver.ts";
import {
  PackageVerificationError,
  assertGrantNarrowing,
  packageLockDigest,
  validatePackageLockEntry,
  validatePackageLockfile,
  validatePackageRequestFile,
  verifyResolvedPackage,
} from "./verify.ts";

export interface StagedPackage {
  readonly operationId: string;
  readonly packageId: string;
  readonly root: string;
  readonly created?: boolean;
}

export interface PackageActivation {
  readonly verified: VerifiedPackage;
  readonly stage: StagedPackage;
  readonly scope: PackageInstallScope;
  readonly pluginAdmissions: readonly PluginInstallAdmission[];
}

export interface PackageInstallStore {
  readLockfile(): Promise<PackageLockfile>;
  writeLockfileAtomic(lockfile: PackageLockfile): Promise<void>;
  readReceipt(idempotencyKey: string): Promise<PackageOperationReceipt | undefined>;
  writeReceipt(receipt: PackageOperationReceipt): Promise<void>;
  stage(
    operationId: string,
    verified: VerifiedPackage,
    resolved: ResolvedPackage,
  ): Promise<StagedPackage>;
  activate(input: PackageActivation): Promise<void>;
  healthCheck(input: PackageActivation): Promise<boolean>;
  rollback(
    packageId: string,
    previous: PackageLockEntry | undefined,
  ): Promise<void>;
  cleanup(stage: StagedPackage): Promise<void>;
}

export interface PackageInstallerOptions {
  readonly resolver: PackageResolver;
  readonly store: PackageInstallStore;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
}

export interface PackageInstallInput {
  readonly source: string;
  readonly scope: PackageInstallScope;
  readonly grants?: PluginPermissionRequest;
  readonly idempotencyKey: string;
  readonly allowUnsignedLocal?: boolean;
  readonly offline?: boolean;
  readonly expectedLockEntry?: PackageLockEntry;
}

export class PackageInstallError extends Error {
  readonly code: string;
  readonly receipt: PackageOperationReceipt;

  constructor(code: string, message: string, receipt: PackageOperationReceipt) {
    super(message);
    this.name = "PackageInstallError";
    this.code = code;
    this.receipt = receipt;
  }
}

export class PackageInstallerService {
  readonly #resolver: PackageResolver;
  readonly #store: PackageInstallStore;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;

  constructor(options: PackageInstallerOptions) {
    this.#resolver = options.resolver;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? ((prefix) => prefix + crypto.randomUUID().replaceAll("-", ""));
  }

  async install(input: PackageInstallInput): Promise<PackageOperationReceipt> {
    requireIdempotencyKey(input.idempotencyKey);
    const existingReceipt = await this.#store.readReceipt(input.idempotencyKey);
    if (existingReceipt !== undefined) {
      if (existingReceipt.source !== input.source) {
        throw new Error("idempotency key was reused for a different package source");
      }
      return existingReceipt;
    }
    const startedAt = this.#now();
    const before = await this.#readLockfile();
    const beforeDigest = packageLockDigest(before);
    let verified: VerifiedPackage | undefined;
    let stage: StagedPackage | undefined;
    let previous: PackageLockEntry | undefined;
    try {
      const resolved = await this.#resolver.resolve(input.source, {
        ...(input.offline === undefined ? {} : { offline: input.offline }),
      });
      verified = verifyResolvedPackage(resolved, {
        ...(input.allowUnsignedLocal === undefined
          ? {}
          : { allowUnsignedLocal: input.allowUnsignedLocal }),
      });
      const grants = Object.freeze({ ...(input.grants ?? {}) });
      assertGrantNarrowing(grants, verified.manifest.permissions);
      const pluginAdmissions = admitContainedPlugins(
        verified,
        resolved,
        input.scope,
        grants,
      );
      const lockEntry = lockEntryFor(verified, grants);
      validatePackageLockEntry(lockEntry);
      if (
        input.expectedLockEntry !== undefined
        && JSON.stringify(input.expectedLockEntry) !== JSON.stringify(lockEntry)
      ) {
        throw new PackageVerificationError(
          "PACKAGE_FROZEN_MISMATCH",
          "resolved package does not match the frozen lock entry",
        );
      }
      previous = before.packages[verified.manifest.id];
      const operationId = this.#newId("pkgop_");
      stage = await this.#store.stage(operationId, verified, resolved);
      const next = Object.freeze({
        schemaVersion: "1.0" as const,
        packages: Object.freeze({
          ...before.packages,
          [verified.manifest.id]: lockEntry,
        }),
      });
      await this.#store.writeLockfileAtomic(next);
      const activation: PackageActivation = {
        verified,
        stage,
        scope: input.scope,
        pluginAdmissions,
      };
      await this.#store.activate(activation);
      if (!await this.#store.healthCheck(activation)) {
        throw new Error("package activation health check failed");
      }
      const completed = operationReceipt({
        receiptId: this.#newId("pkgrcp_"),
        idempotencyKey: input.idempotencyKey,
        operation: previous === undefined ? "install" : "update",
        packageId: verified.manifest.id,
        source: input.source,
        status: "completed",
        startedAt,
        finishedAt: this.#now(),
        lockDigestBefore: beforeDigest,
        lockDigestAfter: packageLockDigest(next),
      });
      await this.#store.writeReceipt(completed);
      return completed;
    } catch (error) {
      const packageId = verified?.manifest.id;
      if (packageId !== undefined) {
        await this.#store.writeLockfileAtomic(before).catch(() => undefined);
        await this.#store.rollback(packageId, previous).catch(() => undefined);
      }
      if (stage !== undefined) await this.#store.cleanup(stage).catch(() => undefined);
      const failed = operationReceipt({
        receiptId: this.#newId("pkgrcp_"),
        idempotencyKey: input.idempotencyKey,
        operation: previous === undefined ? "install" : "update",
        ...(packageId === undefined ? {} : { packageId }),
        source: input.source,
        status: packageId === undefined ? "failed" : "rolled-back",
        startedAt,
        finishedAt: this.#now(),
        lockDigestBefore: beforeDigest,
        lockDigestAfter: packageLockDigest(before),
        error: {
          code: error instanceof PackageVerificationError ? error.code : "PACKAGE_INSTALL_FAILED",
          message: error instanceof Error ? error.message : "package installation failed",
        },
      });
      await this.#store.writeReceipt(failed).catch(() => undefined);
      throw new PackageInstallError(failed.error!.code, failed.error!.message, failed);
    }
  }

  async verify(input: {
    readonly source: string;
    readonly idempotencyKey: string;
    readonly allowUnsignedLocal?: boolean;
    readonly offline?: boolean;
  }): Promise<PackageOperationReceipt> {
    requireIdempotencyKey(input.idempotencyKey);
    const existing = await this.#store.readReceipt(input.idempotencyKey);
    if (existing !== undefined) return existing;
    const startedAt = this.#now();
    const lockfile = await this.#readLockfile();
    const resolved = await this.#resolver.resolve(input.source, {
      ...(input.offline === undefined ? {} : { offline: input.offline }),
    });
    const verified = verifyResolvedPackage(resolved, {
      ...(input.allowUnsignedLocal === undefined
        ? {}
        : { allowUnsignedLocal: input.allowUnsignedLocal }),
    });
    const digest = packageLockDigest(lockfile);
    const result = operationReceipt({
      receiptId: this.#newId("pkgrcp_"),
      idempotencyKey: input.idempotencyKey,
      operation: "verify",
      packageId: verified.manifest.id,
      source: input.source,
      status: "verified",
      startedAt,
      finishedAt: this.#now(),
      lockDigestBefore: digest,
      lockDigestAfter: digest,
    });
    await this.#store.writeReceipt(result);
    return result;
  }

  async remove(input: {
    readonly packageId: string;
    readonly idempotencyKey: string;
  }): Promise<PackageOperationReceipt> {
    requireIdempotencyKey(input.idempotencyKey);
    const existing = await this.#store.readReceipt(input.idempotencyKey);
    if (existing !== undefined) return existing;
    const startedAt = this.#now();
    const before = await this.#readLockfile();
    const previous = before.packages[input.packageId];
    if (previous === undefined) throw new Error("package is not installed: " + input.packageId);
    const packages = { ...before.packages };
    delete packages[input.packageId];
    const next: PackageLockfile = {
      schemaVersion: "1.0",
      packages: Object.freeze(packages),
    };
    await this.#store.writeLockfileAtomic(next);
    try {
      await this.#store.rollback(input.packageId, undefined);
    } catch (error) {
      await this.#store.writeLockfileAtomic(before);
      throw error;
    }
    const result = operationReceipt({
      receiptId: this.#newId("pkgrcp_"),
      idempotencyKey: input.idempotencyKey,
      operation: "remove",
      packageId: input.packageId,
      source: previous.source,
      status: "removed",
      startedAt,
      finishedAt: this.#now(),
      lockDigestBefore: packageLockDigest(before),
      lockDigestAfter: packageLockDigest(next),
    });
    await this.#store.writeReceipt(result);
    return result;
  }

  async bootstrap(input: {
    readonly requests: PackageRequestFile;
    readonly lockfile: PackageLockfile;
    readonly frozen: boolean;
    readonly offline?: boolean;
    readonly idempotencyKey: string;
  }): Promise<readonly PackageOperationReceipt[]> {
    validatePackageRequestFile(input.requests);
    validatePackageLockfile(input.lockfile);
    if (input.frozen && input.requests.packages.length !== Object.keys(input.lockfile.packages).length) {
      throw new Error("frozen bootstrap request and lockfile package counts differ");
    }
    const receipts = [];
    for (const [index, request] of input.requests.packages.entries()) {
      const resolved = await this.#resolver.resolve(request.source, {
        ...(input.offline === undefined ? {} : { offline: input.offline }),
      });
      const verified = verifyResolvedPackage(resolved, {
        allowUnsignedLocal: request.source.startsWith("path:"),
      });
      const expected = input.lockfile.packages[verified.manifest.id];
      if (input.frozen && expected === undefined) {
        throw new Error("frozen bootstrap lock is missing " + verified.manifest.id);
      }
      receipts.push(await this.install({
        source: request.source,
        scope: request.scope,
        ...(request.grants === undefined ? {} : { grants: request.grants }),
        idempotencyKey: input.idempotencyKey + ":" + String(index),
        allowUnsignedLocal: request.source.startsWith("path:"),
        ...(input.offline === undefined ? {} : { offline: input.offline }),
        ...(expected === undefined ? {} : { expectedLockEntry: expected }),
      }));
    }
    return Object.freeze(receipts);
  }

  async #readLockfile(): Promise<PackageLockfile> {
    const lockfile = await this.#store.readLockfile();
    validatePackageLockfile(lockfile);
    return lockfile;
  }
}

export class InMemoryPackageInstallStore implements PackageInstallStore {
  lockfile: PackageLockfile = emptyPackageLockfile();
  readonly receipts = new Map<string, PackageOperationReceipt>();
  readonly stages = new Map<string, StagedPackage>();
  readonly active = new Map<string, PackageActivation>();
  readonly #previousActive = new Map<string, PackageActivation | undefined>();
  failHealthFor = new Set<string>();

  async readLockfile(): Promise<PackageLockfile> { return this.lockfile; }
  async writeLockfileAtomic(lockfile: PackageLockfile): Promise<void> {
    validatePackageLockfile(lockfile);
    this.lockfile = lockfile;
  }
  async readReceipt(key: string): Promise<PackageOperationReceipt | undefined> {
    return this.receipts.get(key);
  }
  async writeReceipt(value: PackageOperationReceipt): Promise<void> {
    this.receipts.set(value.idempotencyKey, value);
  }
  async stage(operationId: string, verified: VerifiedPackage): Promise<StagedPackage> {
    const stage = Object.freeze({
      operationId,
      packageId: verified.manifest.id,
      root: "/memory/packages/" + verified.packageDigest.slice("sha256:".length),
    });
    this.stages.set(operationId, stage);
    return stage;
  }
  async activate(input: PackageActivation): Promise<void> {
    this.#previousActive.set(
      input.verified.manifest.id,
      this.active.get(input.verified.manifest.id),
    );
    this.active.set(input.verified.manifest.id, input);
  }
  async healthCheck(input: PackageActivation): Promise<boolean> {
    return !this.failHealthFor.has(input.verified.manifest.id);
  }
  async rollback(packageId: string, previous: PackageLockEntry | undefined): Promise<void> {
    const prior = this.#previousActive.get(packageId);
    if (previous !== undefined && prior !== undefined) this.active.set(packageId, prior);
    else this.active.delete(packageId);
    this.#previousActive.delete(packageId);
  }
  async cleanup(stage: StagedPackage): Promise<void> {
    this.stages.delete(stage.operationId);
  }
}

function admitContainedPlugins(
  verified: VerifiedPackage,
  resolved: ResolvedPackage,
  scope: PackageInstallScope,
  grants: PluginPermissionRequest,
): readonly PluginInstallAdmission[] {
  const files = new Map(resolved.files.map((file) => [file.path, file.bytes]));
  const admissions = [];
  for (const pluginManifestPath of verified.manifest.contents.plugins ?? []) {
    const bytes = files.get(pluginManifestPath);
    if (bytes === undefined) {
      throw new PackageVerificationError(
        "PACKAGE_PLUGIN_MISSING",
        "package is missing plugin manifest " + pluginManifestPath,
      );
    }
    const document = verifyPluginManifestDocument(bytes);
    const plugin = document.manifest;
    assertGrantNarrowing(plugin.permissions, verified.manifest.permissions);
    const pluginGrants = intersectPermissions(grants, plugin.permissions);
    const prefix = directoryOf(pluginManifestPath);
    const pluginFiles = Object.keys(plugin.integrity.files).map((path) => {
      const packagePath = prefix.length === 0 ? path : prefix + "/" + path;
      const body = files.get(packagePath);
      if (body === undefined) throw new Error("package is missing plugin file " + packagePath);
      return { path, bytes: body };
    });
    const signatureVerified = verified.signatureVerified
      && plugin.signature !== undefined
      && plugin.signature.keyId === verified.manifest.signature?.keyId;
    const lockEntry: PluginLockEntry = {
      version: plugin.version,
      source: verified.source,
      packageDigest: plugin.integrity.packageDigest,
      manifestDigest: document.digest,
      grants: pluginGrants,
      ...(plugin.signature === undefined
        ? {}
        : { signature: { keyId: plugin.signature.keyId, verified: signatureVerified } }),
    };
    admissions.push(admitPluginInstall({
      scope,
      sourceKind: verified.sourceKind,
      source: verified.source,
      manifestDocument: document,
      files: pluginFiles,
      lockEntry,
      signaturePolicy: verified.sourceKind === "registry" ? "required" : "allow-unverified",
    }));
  }
  return Object.freeze(admissions);
}

function lockEntryFor(
  verified: VerifiedPackage,
  grants: PluginPermissionRequest,
): PackageLockEntry {
  return Object.freeze({
    version: verified.manifest.version,
    source: verified.source,
    sourceKind: verified.sourceKind,
    packageDigest: verified.packageDigest,
    manifestDigest: verified.manifestDigest,
    grants,
    contents: verified.manifest.contents,
    ...(verified.manifest.signature === undefined
      ? {}
      : {
          signature: {
            keyId: verified.manifest.signature.keyId,
            verified: true as const,
          },
        }),
  });
}

function intersectPermissions(
  grant: PluginPermissionRequest,
  requested: PluginPermissionRequest,
): PluginPermissionRequest {
  const out: Record<string, unknown> = {};
  for (const field of ARRAY_FIELDS) {
    const allowed = new Set(requested[field] ?? []);
    const values = (grant[field] ?? []).filter((value) => allowed.has(value));
    if (values.length > 0) out[field] = values;
  }
  for (const field of ENUM_FIELDS) {
    const value = grant[field];
    if (value !== undefined) out[field] = value;
  }
  const result = out as PluginPermissionRequest;
  assertGrantNarrowing(result, requested);
  return Object.freeze(result);
}

function operationReceipt(
  value: Omit<PackageOperationReceipt, "schemaVersion">,
): PackageOperationReceipt {
  return Object.freeze({ schemaVersion: "1.0", ...value });
}

function requireIdempotencyKey(value: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error("package operation idempotency key must be bounded");
  }
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

const ARRAY_FIELDS = [
  "events",
  "tools",
  "workspaceRead",
  "workspaceWrite",
  "networkDomains",
  "credentials",
] as const;
const ENUM_FIELDS = ["artifacts", "sessionState", "memory", "graph"] as const;
