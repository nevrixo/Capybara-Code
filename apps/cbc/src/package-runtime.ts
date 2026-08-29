/**
 * Durable package facade shared by the CLI, embedded App backend, and sessions.
 *
 * Project declarations stay in the repository. Immutable bytes, receipts, and
 * enable/disable choices stay in host-owned directories.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  CompositePackageResolver,
  FileSystemPackageInstallStore,
  ImmutableCachePackageResolver,
  LocalPathPackageResolver,
  PackageInstallerService,
  UnsupportedPackageSourceError,
  emptyPackageLockfile,
  validatePackageLockfile,
  validatePackageRequestFile,
  verifyResolvedPackage,
  type PackageInstallScope,
  type PackageLockEntry,
  type PackageLockfile,
  type PackageOperationReceipt,
  type PackageRequest,
  type PackageRequestFile,
  type PackageResolver,
  type StaticRegistryPackage,
} from "@cbc/package-manager";
import type { AppMethod } from "@cbc/app-protocol";
import type { PluginPermissionRequest } from "@cbc/plugin-sdk";

import { PluginSupervisorPackageActivationHost } from "../../capy-daemon/src/package-activation.ts";
import {
  PluginSupervisor,
  type PluginInvokeRequest,
} from "../../capy-daemon/src/plugin-supervisor.ts";

export type PackageListScope = PackageInstallScope | "effective";

export const PACKAGE_RUNTIME_APP_METHODS = Object.freeze([
  "plugin.inspect",
  "plugin.install",
  "plugin.update",
  "plugin.enable",
  "plugin.disable",
  "plugin.grants",
  "plugin.resolveGrant",
  "package.inspect",
  "package.install",
  "package.remove",
  "package.update",
  "package.verify",
  "package.bootstrap",
] satisfies AppMethod[]);

export interface PackageRuntimeOptions {
  readonly workspacePath: string;
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly projectTrusted: boolean;
  readonly now?: () => string;
  readonly registryResolver?: PackageResolver;
  readonly registryCatalog?: {
    search(query: string): Promise<readonly StaticRegistryPackage[]>;
    inspect(packageId: string): Promise<StaticRegistryPackage | undefined>;
  };
}

export interface PackageScopePaths {
  readonly requestsPath: string;
  readonly lockfilePath: string;
  readonly receiptsPath: string;
}

export interface InstalledPackageView {
  readonly id: string;
  readonly scope: PackageInstallScope;
  readonly effective: boolean;
  readonly version: string;
  readonly source: string;
  readonly sourceKind: PackageLockEntry["sourceKind"];
  readonly packageDigest: string;
  readonly manifestDigest: string;
  readonly signatureVerified: boolean;
  readonly signingKeyId?: string;
  readonly grants: PluginPermissionRequest;
  readonly contents: PackageLockEntry["contents"];
}

export interface InstalledPluginView {
  readonly id: string;
  readonly packageId?: string;
  readonly scope: string;
  readonly version: string;
  readonly runtimeKind: "wasi" | "stdio";
  readonly enabled: boolean;
  readonly health: ReturnType<PluginSupervisor["health"]>;
  readonly requested: PluginPermissionRequest;
  readonly grants: PluginPermissionRequest;
}

interface PluginStateFile {
  readonly schemaVersion: "1.0";
  readonly workspaces: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export class PackageRuntimeError extends Error {
  readonly code:
    | "PACKAGE_TRUST_REQUIRED"
    | "PACKAGE_NOT_FOUND"
    | "PACKAGE_REGISTRY_UNAVAILABLE";

  constructor(code: PackageRuntimeError["code"], message: string) {
    super(message);
    this.name = "PackageRuntimeError";
    this.code = code;
  }
}

export class PackageRuntime {
  readonly supervisor: PluginSupervisor;
  readonly #workspacePath: string;
  readonly #dataRoot: string;
  readonly #cacheRoot: string;
  readonly #projectTrusted: boolean;
  readonly #now: () => string;
  readonly #registryResolver: PackageResolver | undefined;
  readonly #registryCatalog: PackageRuntimeOptions["registryCatalog"];
  readonly #activationHost: PluginSupervisorPackageActivationHost;
  readonly #workspaceKey: string;
  readonly #pluginStatePath: string;
  readonly #scopeTails = new Map<PackageInstallScope, Promise<void>>();
  readonly #activePackageRoots = new Map<string, {
    readonly root: string;
    readonly skillPaths: readonly string[];
  }>();

  constructor(options: PackageRuntimeOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#dataRoot = resolve(options.dataRoot);
    this.#cacheRoot = resolve(options.cacheRoot, "packages");
    this.#projectTrusted = options.projectTrusted;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#registryResolver = options.registryResolver;
    this.#registryCatalog = options.registryCatalog;
    this.#workspaceKey = createHash("sha256")
      .update(this.#workspacePath.replaceAll("\\", "/").toLowerCase())
      .digest("hex");
    this.#pluginStatePath = join(this.#dataRoot, "packages", "plugin-state.json");
    this.supervisor = new PluginSupervisor();
    this.#activationHost = new PluginSupervisorPackageActivationHost({
      supervisor: this.supervisor,
      projectTrusted: this.#projectTrusted,
    });
  }

  paths(scope: PackageInstallScope): PackageScopePaths {
    if (scope === "project") {
      const root = join(this.#workspacePath, ".capybara");
      return {
        requestsPath: join(root, "packages.json"),
        lockfilePath: join(root, "packages.lock.json"),
        receiptsPath: join(
          this.#dataRoot,
          "packages",
          "receipts",
          this.#workspaceKey + "-project.json",
        ),
      };
    }
    const root = join(this.#dataRoot, "packages");
    return {
      requestsPath: join(root, "packages.json"),
      lockfilePath: join(root, "packages.lock.json"),
      receiptsPath: join(root, "receipts", "user.json"),
    };
  }

  appMethods(): readonly AppMethod[] {
    return this.#registryCatalog === undefined
      ? PACKAGE_RUNTIME_APP_METHODS
      : Object.freeze([...PACKAGE_RUNTIME_APP_METHODS, "package.search" as const]);
  }

  async searchRegistry(query: string): Promise<readonly StaticRegistryPackage[]> {
    if (this.#registryCatalog === undefined) {
      throw new PackageRuntimeError(
        "PACKAGE_REGISTRY_UNAVAILABLE",
        "no signed package registry is configured",
      );
    }
    return await this.#registryCatalog.search(query);
  }

  async inspectRegistry(packageId: string): Promise<StaticRegistryPackage | undefined> {
    return await this.#registryCatalog?.inspect(packageId);
  }

  async add(input: {
    readonly source: string;
    readonly scope: PackageInstallScope;
    readonly idempotencyKey: string;
    readonly grants?: PluginPermissionRequest;
    readonly allowUnsignedLocal?: boolean;
    readonly offline?: boolean;
  }): Promise<PackageOperationReceipt> {
    return await this.#exclusive(input.scope, async () => {
    this.#requireScopeTrust(input.scope);
    this.#requireLocalSourceTrust(input.source);
    const resolver = this.#sourceResolver();
    const resolved = await this.#resolveSource(resolver, input.source, input.offline);
    const verified = verifyResolvedPackage(resolved, {
      ...(input.allowUnsignedLocal === undefined
        ? {}
        : { allowUnsignedLocal: input.allowUnsignedLocal }),
    });
    const beforeRequests = await this.readRequests(input.scope);
    const beforeLock = await this.readLockfile(input.scope);
    const replacedSource = beforeLock.packages[verified.manifest.id]?.source;
    const request: PackageRequest = {
      source: input.source,
      scope: input.scope,
      ...(input.grants === undefined ? {} : { grants: input.grants }),
    };
    const nextRequests: PackageRequestFile = {
      schemaVersion: "1.0",
      packages: Object.freeze([
        ...beforeRequests.packages.filter(
          (item) => item.source !== input.source && item.source !== replacedSource,
        ),
        request,
      ]),
    };
    await this.writeRequests(input.scope, nextRequests);
    try {
      return await this.#service(input.scope, resolver).install({
        source: input.source,
        scope: input.scope,
        ...(input.grants === undefined ? {} : { grants: input.grants }),
        idempotencyKey: input.idempotencyKey,
        ...(input.allowUnsignedLocal === undefined
          ? {}
          : { allowUnsignedLocal: input.allowUnsignedLocal }),
        ...(input.offline === undefined ? {} : { offline: input.offline }),
      });
    } catch (error) {
      await this.writeRequests(input.scope, beforeRequests).catch(() => undefined);
      throw error;
    }
    });
  }

  async preview(input: {
    readonly source: string;
    readonly allowUnsignedLocal?: boolean;
    readonly offline?: boolean;
  }): Promise<{
    readonly id: string;
    readonly version: string;
    readonly source: string;
    readonly signatureVerified: boolean;
    readonly permissions: PluginPermissionRequest;
    readonly contents: PackageLockEntry["contents"];
  }> {
    this.#requireLocalSourceTrust(input.source);
    const resolved = await this.#resolveSource(
      this.#sourceResolver(),
      input.source,
      input.offline,
    );
    const verified = verifyResolvedPackage(resolved, {
      ...(input.allowUnsignedLocal === undefined
        ? {}
        : { allowUnsignedLocal: input.allowUnsignedLocal }),
    });
    return Object.freeze({
      id: verified.manifest.id,
      version: verified.manifest.version,
      source: verified.source,
      signatureVerified: verified.signatureVerified,
      permissions: verified.manifest.permissions,
      contents: verified.manifest.contents,
    });
  }

  async remove(input: {
    readonly packageId: string;
    readonly scope: PackageInstallScope;
    readonly idempotencyKey: string;
  }): Promise<PackageOperationReceipt> {
    return await this.#exclusive(input.scope, async () => {
    this.#requireScopeTrust(input.scope);
    const beforeLock = await this.readLockfile(input.scope);
    const entry = beforeLock.packages[input.packageId];
    if (entry === undefined) {
      throw new PackageRuntimeError(
        "PACKAGE_NOT_FOUND",
        "package is not installed: " + input.packageId,
      );
    }
    const beforeRequests = await this.readRequests(input.scope);
    const nextRequests: PackageRequestFile = {
      schemaVersion: "1.0",
      packages: Object.freeze(
        beforeRequests.packages.filter((item) => item.source !== entry.source),
      ),
    };
    await this.writeRequests(input.scope, nextRequests);
    try {
      return await this.#service(input.scope, this.#sourceResolver()).remove({
        packageId: input.packageId,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      await this.writeRequests(input.scope, beforeRequests).catch(() => undefined);
      throw error;
    }
    });
  }

  async update(input: {
    readonly packageId?: string;
    readonly scope: PackageInstallScope;
    readonly idempotencyKey: string;
    readonly offline?: boolean;
  }): Promise<readonly PackageOperationReceipt[]> {
    return await this.#exclusive(input.scope, async () => {
    this.#requireScopeTrust(input.scope);
    const requests = await this.readRequests(input.scope);
    const lockfile = await this.readLockfile(input.scope);
    const selected: ReadonlyArray<readonly [string, PackageLockEntry | undefined]> =
      input.packageId === undefined
        ? Object.entries(lockfile.packages)
        : [[input.packageId, lockfile.packages[input.packageId]]];
    const resolver = this.#sourceResolver();
    const receipts: PackageOperationReceipt[] = [];
    for (const [packageId, entry] of selected) {
      if (entry === undefined) {
        throw new PackageRuntimeError(
          "PACKAGE_NOT_FOUND",
          "package is not installed: " + packageId,
        );
      }
      const request = requests.packages.find((item) => item.source === entry.source);
      if (request === undefined) throw new Error("package request is missing for " + packageId);
      this.#requireLocalSourceTrust(request.source);
      receipts.push(await this.#service(input.scope, resolver).install({
        source: request.source,
        scope: input.scope,
        ...(request.grants === undefined ? {} : { grants: request.grants }),
        idempotencyKey: input.idempotencyKey + ":" + packageId,
        allowUnsignedLocal: request.source.startsWith("path:"),
        ...(input.offline === undefined ? {} : { offline: input.offline }),
      }));
    }
    return Object.freeze(receipts);
    });
  }

  async verify(input: {
    readonly source: string;
    readonly scope: PackageInstallScope;
    readonly idempotencyKey: string;
    readonly allowUnsignedLocal?: boolean;
    readonly offline?: boolean;
  }): Promise<PackageOperationReceipt> {
    return await this.#exclusive(input.scope, async () => {
    this.#requireLocalSourceTrust(input.source);
    return await this.#service(input.scope, this.#sourceResolver()).verify({
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      ...(input.allowUnsignedLocal === undefined
        ? {}
        : { allowUnsignedLocal: input.allowUnsignedLocal }),
      ...(input.offline === undefined ? {} : { offline: input.offline }),
    });
    });
  }

  async bootstrap(input: {
    readonly scope?: PackageInstallScope;
    readonly frozen: boolean;
    readonly offline?: boolean;
    readonly idempotencyKey: string;
  }): Promise<readonly PackageOperationReceipt[]> {
    const scope = input.scope ?? "project";
    return await this.#exclusive(scope, async () => {
    this.#requireScopeTrust(scope);
    const requests = await this.readRequests(scope);
    const lockfile = await this.readLockfile(scope);
    const resolver = new CompositePackageResolver([
      new ImmutableCachePackageResolver({ cacheRoot: this.#cacheRoot, lockfile }),
      this.#sourceResolver(),
    ]);
    return await this.#service(scope, resolver).bootstrap({
      requests,
      lockfile,
      frozen: input.frozen,
      ...(input.offline === undefined ? {} : { offline: input.offline }),
      idempotencyKey: input.idempotencyKey,
    });
    });
  }

  async restoreAll(): Promise<readonly string[]> {
    const warnings: string[] = [];
    for (const scope of ["user", "project"] as const) {
      if (scope === "project" && !this.#projectTrusted) continue;
      try {
        const requests = await this.readRequests(scope);
        const lockfile = await this.readLockfile(scope);
        if (requests.packages.length === 0 && Object.keys(lockfile.packages).length === 0) {
          continue;
        }
        const activations = await this.#service(
          scope,
          new ImmutableCachePackageResolver({ cacheRoot: this.#cacheRoot, lockfile }),
        ).restore({ requests, lockfile, offline: true });
        for (const activation of activations) {
          this.#activePackageRoots.set(activation.verified.manifest.id, {
            root: activation.stage.root,
            skillPaths: Object.freeze([
              ...(activation.verified.manifest.contents.skills ?? []),
            ]),
          });
        }
      } catch (error) {
        warnings.push(
          scope + " package restore failed: "
          + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    await this.#applyPluginState();
    return Object.freeze(warnings);
  }

  skillRoots(): readonly string[] {
    const roots = new Set<string>();
    for (const active of this.#activePackageRoots.values()) {
      for (const skillPath of active.skillPaths) {
        roots.add(dirname(resolve(active.root, ...skillPath.split("/"))));
      }
    }
    return Object.freeze([...roots].sort());
  }

  async list(scope: PackageListScope = "effective"): Promise<readonly InstalledPackageView[]> {
    const user = await this.#viewsFor("user");
    const project = await this.#viewsFor("project");
    if (scope === "user") return user;
    if (scope === "project") return project;
    const effective = new Map<string, InstalledPackageView>();
    for (const item of user) effective.set(item.id, { ...item, effective: true });
    if (this.#projectTrusted) {
      for (const item of project) effective.set(item.id, { ...item, effective: true });
    }
    return Object.freeze(
      [...effective.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  async inspectPackage(
    packageId: string,
    scope: PackageListScope = "effective",
  ): Promise<InstalledPackageView | undefined> {
    return (await this.list(scope)).find((item) => item.id === packageId);
  }

  async doctor(
    packageId?: string,
    scope: PackageListScope = "effective",
  ): Promise<{
    readonly ok: boolean;
    readonly packages: number;
    readonly issues: readonly string[];
  }> {
    const views = await this.list(scope);
    const selected = packageId === undefined
      ? views
      : views.filter((item) => item.id === packageId);
    if (packageId !== undefined && selected.length === 0) {
      return { ok: false, packages: 0, issues: ["package is not installed: " + packageId] };
    }
    const issues: string[] = [];
    for (const item of selected) {
      try {
        const lockfile = await this.readLockfile(item.scope);
        const resolved = await new ImmutableCachePackageResolver({
          cacheRoot: this.#cacheRoot,
          lockfile,
        }).resolve(item.source);
        const verified = verifyResolvedPackage(resolved, {
          allowUnsignedLocal: item.sourceKind === "local-path",
        });
        if (
          verified.manifest.id !== item.id
          || verified.manifest.version !== item.version
          || verified.packageDigest !== item.packageDigest
          || verified.manifestDigest !== item.manifestDigest
        ) {
          issues.push(item.id + ": immutable cache does not match lockfile");
        }
      } catch (error) {
        issues.push(item.id + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
    return {
      ok: issues.length === 0,
      packages: selected.length,
      issues: Object.freeze(issues),
    };
  }

  plugins(): readonly InstalledPluginView[] {
    return Object.freeze([...this.supervisor.list()].sort().map((pluginId) => {
      const inspected = this.supervisor.inspect(pluginId)!;
      const packageId = this.#activationHost.packageForPlugin(pluginId);
      return {
        id: pluginId,
        ...(packageId === undefined ? {} : { packageId }),
        scope: inspected.spec.scope,
        version: inspected.spec.manifest.version,
        runtimeKind: inspected.spec.manifest.runtime.kind,
        enabled: inspected.enabled,
        health: this.supervisor.health(pluginId),
        requested: inspected.spec.manifest.permissions,
        grants: this.#activationHost.grantsForPlugin(pluginId) ?? {},
      };
    }));
  }

  inspectPlugin(pluginId: string): InstalledPluginView | undefined {
    return this.plugins().find((item) => item.id === pluginId);
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<InstalledPluginView> {
    this.supervisor.setEnabled(pluginId, enabled);
    const state = await this.#readPluginState();
    const workspace = { ...(state.workspaces[this.#workspaceKey] ?? {}) };
    workspace[pluginId] = enabled;
    await atomicJsonWrite(this.#pluginStatePath, {
      schemaVersion: "1.0",
      workspaces: { ...state.workspaces, [this.#workspaceKey]: workspace },
    } satisfies PluginStateFile);
    return this.inspectPlugin(pluginId)!;
  }

  async dispatchApp(input: {
    readonly method: AppMethod;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
  }): Promise<unknown> {
    const payload = record(input.payload);
    switch (input.method) {
      case "package.search":
        return {
          packages: await this.searchRegistry(
            typeof payload.query === "string" ? payload.query : "",
          ),
        };
      case "plugin.inspect": {
        const pluginId = requiredString(payload, "pluginId");
        const plugin = this.inspectPlugin(pluginId);
        if (plugin === undefined) {
          throw new PackageRuntimeError("PACKAGE_NOT_FOUND", "plugin is not installed: " + pluginId);
        }
        return plugin;
      }
      case "plugin.grants": {
        const pluginId = requiredString(payload, "pluginId");
        const plugin = this.inspectPlugin(pluginId);
        if (plugin === undefined) {
          throw new PackageRuntimeError("PACKAGE_NOT_FOUND", "plugin is not installed: " + pluginId);
        }
        return { pluginId, requested: plugin.requested, granted: plugin.grants };
      }
      case "plugin.enable":
      case "plugin.disable":
        return await this.setPluginEnabled(
          requiredString(payload, "pluginId"),
          input.method === "plugin.enable",
        );
      case "plugin.install":
      case "package.install":
        return await this.add({
          source: requiredString(payload, "source"),
          scope: packageScope(payload.scope),
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
          ...(permissionRequest(payload.grants) === undefined
            ? {}
            : { grants: permissionRequest(payload.grants)! }),
          ...(typeof payload.allowUnsignedLocal === "boolean"
            ? { allowUnsignedLocal: payload.allowUnsignedLocal }
            : {}),
          ...(typeof payload.offline === "boolean" ? { offline: payload.offline } : {}),
        });
      case "plugin.update": {
        const pluginId = requiredString(payload, "pluginId");
        const packageId = this.#activationHost.packageForPlugin(pluginId);
        if (packageId === undefined) {
          throw new PackageRuntimeError("PACKAGE_NOT_FOUND", "plugin is not installed: " + pluginId);
        }
        const plugin = this.inspectPlugin(pluginId)!;
        return await this.update({
          packageId,
          scope: packageScope(plugin.scope),
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
          ...(typeof payload.offline === "boolean" ? { offline: payload.offline } : {}),
        });
      }
      case "plugin.resolveGrant": {
        const pluginId = requiredString(payload, "pluginId");
        const packageId = this.#activationHost.packageForPlugin(pluginId);
        if (packageId === undefined) {
          throw new PackageRuntimeError("PACKAGE_NOT_FOUND", "plugin is not installed: " + pluginId);
        }
        const plugin = this.inspectPlugin(pluginId)!;
        const packageInfo = await this.inspectPackage(packageId, packageScope(plugin.scope));
        if (packageInfo === undefined) {
          throw new PackageRuntimeError("PACKAGE_NOT_FOUND", "package is not installed: " + packageId);
        }
        return await this.add({
          source: packageInfo.source,
          scope: packageInfo.scope,
          grants: permissionRequest(payload.grants) ?? {},
          allowUnsignedLocal: packageInfo.sourceKind === "local-path",
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
        });
      }
      case "package.inspect": {
        const packageId = requiredString(payload, "packageId");
        const info = await this.inspectPackage(packageId, packageListScope(payload.scope));
        const registry = info === undefined ? await this.inspectRegistry(packageId) : undefined;
        if (info === undefined && registry === undefined) {
          throw new PackageRuntimeError("PACKAGE_NOT_FOUND", "package is not installed: " + packageId);
        }
        return info ?? { registry };
      }
      case "package.remove":
        return await this.remove({
          packageId: requiredString(payload, "packageId"),
          scope: packageScope(payload.scope),
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
        });
      case "package.update":
        return await this.update({
          ...(typeof payload.packageId === "string" && payload.packageId.length > 0
            ? { packageId: payload.packageId }
            : {}),
          scope: packageScope(payload.scope),
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
          ...(typeof payload.offline === "boolean" ? { offline: payload.offline } : {}),
        });
      case "package.verify":
        return await this.verify({
          source: requiredString(payload, "source"),
          scope: packageScope(payload.scope),
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
          ...(typeof payload.allowUnsignedLocal === "boolean"
            ? { allowUnsignedLocal: payload.allowUnsignedLocal }
            : {}),
          ...(typeof payload.offline === "boolean" ? { offline: payload.offline } : {}),
        });
      case "package.bootstrap":
        return await this.bootstrap({
          scope: packageScope(payload.scope),
          frozen: payload.frozen === true,
          ...(typeof payload.offline === "boolean" ? { offline: payload.offline } : {}),
          idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
        });
      default:
        throw new Error(input.method + " is not supported by the package runtime");
    }
  }

  async readRequests(scope: PackageInstallScope): Promise<PackageRequestFile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.paths(scope).requestsPath, "utf8"),
      ) as PackageRequestFile;
      validatePackageRequestFile(parsed);
      return parsed;
    } catch (error) {
      if (isMissing(error)) {
        return Object.freeze({ schemaVersion: "1.0", packages: Object.freeze([]) });
      }
      throw error;
    }
  }

  async writeRequests(
    scope: PackageInstallScope,
    requests: PackageRequestFile,
  ): Promise<void> {
    validatePackageRequestFile(requests);
    await atomicJsonWrite(this.paths(scope).requestsPath, requests);
  }

  async readLockfile(scope: PackageInstallScope): Promise<PackageLockfile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.paths(scope).lockfilePath, "utf8"),
      ) as PackageLockfile;
      validatePackageLockfile(parsed);
      return parsed;
    } catch (error) {
      if (isMissing(error)) return emptyPackageLockfile();
      throw error;
    }
  }

  async invoke(input: PluginInvokeRequest): Promise<unknown> {
    return (await this.supervisor.invoke(input)).result;
  }

  async dispose(): Promise<void> {
    await this.supervisor.stopAll();
  }

  #service(scope: PackageInstallScope, resolver: PackageResolver): PackageInstallerService {
    const paths = this.paths(scope);
    return new PackageInstallerService({
      resolver,
      store: new FileSystemPackageInstallStore({
        lockfilePath: paths.lockfilePath,
        cacheRoot: this.#cacheRoot,
        receiptsPath: paths.receiptsPath,
        activationHost: this.#activationHost,
      }),
      now: this.#now,
    });
  }

  #sourceResolver(): PackageResolver {
    const resolvers: PackageResolver[] = [
      new LocalPathPackageResolver({ workspaceRoot: this.#workspacePath }),
    ];
    if (this.#registryResolver !== undefined) resolvers.push(this.#registryResolver);
    return new CompositePackageResolver(resolvers);
  }

  async #resolveSource(
    resolver: PackageResolver,
    source: string,
    offline: boolean | undefined,
  ) {
    try {
      return await resolver.resolve(source, {
        ...(offline === undefined ? {} : { offline }),
      });
    } catch (error) {
      if (error instanceof UnsupportedPackageSourceError && source.startsWith("registry:")) {
        throw new PackageRuntimeError(
          "PACKAGE_REGISTRY_UNAVAILABLE",
          "no signed package registry is configured for " + source,
        );
      }
      throw error;
    }
  }

  #requireScopeTrust(scope: PackageInstallScope): void {
    if (scope === "project" && !this.#projectTrusted) {
      throw new PackageRuntimeError(
        "PACKAGE_TRUST_REQUIRED",
        "project package changes require a trusted workspace",
      );
    }
  }

  #requireLocalSourceTrust(source: string): void {
    if (source.startsWith("path:") && !this.#projectTrusted) {
      throw new PackageRuntimeError(
        "PACKAGE_TRUST_REQUIRED",
        "local package sources require a trusted workspace",
      );
    }
  }

  async #exclusive<T>(
    scope: PackageInstallScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#scopeTails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(async () => await gate);
    this.#scopeTails.set(scope, tail);
    await previous.catch(() => undefined);
    const lockPath = this.paths(scope).lockfilePath + ".install.lock";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await acquireOperationLock(lockPath);
      return await operation();
    } finally {
      await handle?.close().catch(() => undefined);
      if (handle !== undefined) await rm(lockPath, { force: true }).catch(() => undefined);
      release();
      if (this.#scopeTails.get(scope) === tail) this.#scopeTails.delete(scope);
    }
  }

  async #viewsFor(scope: PackageInstallScope): Promise<readonly InstalledPackageView[]> {
    const lockfile = await this.readLockfile(scope);
    return Object.freeze(Object.entries(lockfile.packages).map(([id, entry]) => ({
      id,
      scope,
      effective: false,
      version: entry.version,
      source: entry.source,
      sourceKind: entry.sourceKind,
      packageDigest: entry.packageDigest,
      manifestDigest: entry.manifestDigest,
      signatureVerified: entry.signature?.verified === true,
      ...(entry.signature === undefined ? {} : { signingKeyId: entry.signature.keyId }),
      grants: entry.grants,
      contents: entry.contents,
    })).sort((left, right) => left.id.localeCompare(right.id)));
  }

  async #applyPluginState(): Promise<void> {
    const state = await this.#readPluginState();
    const workspace = state.workspaces[this.#workspaceKey] ?? {};
    for (const [pluginId, enabled] of Object.entries(workspace)) {
      if (this.supervisor.inspect(pluginId) !== undefined) {
        this.supervisor.setEnabled(pluginId, enabled);
      }
    }
  }

  async #readPluginState(): Promise<PluginStateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#pluginStatePath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("plugin state is malformed");
      }
      const root = parsed as Record<string, unknown>;
      if (
        root.schemaVersion !== "1.0"
        || typeof root.workspaces !== "object"
        || root.workspaces === null
        || Array.isArray(root.workspaces)
      ) {
        throw new Error("plugin state is malformed");
      }
      for (const value of Object.values(root.workspaces as Record<string, unknown>)) {
        if (
          typeof value !== "object"
          || value === null
          || Array.isArray(value)
          || Object.values(value).some((enabled) => typeof enabled !== "boolean")
        ) {
          throw new Error("plugin state is malformed");
        }
      }
      return {
        schemaVersion: "1.0",
        workspaces: root.workspaces as PluginStateFile["workspaces"],
      };
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: "1.0", workspaces: {} };
      throw error;
    }
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp-" + process.pid + "-" + randomUUID();
  let committed = false;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireOperationLock(
  path: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({
      schemaVersion: "1.0",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }) + "\n");
    return handle;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  let ownerPid: number | undefined;
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0) {
      ownerPid = record.pid;
    }
  } catch {
    // A malformed lock is stale evidence, never authority.
  }
  if (ownerPid !== undefined && processAlive(ownerPid)) {
    throw new Error("another package operation is already running (pid " + ownerPid + ")");
  }
  await rm(path, { force: true });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({
      schemaVersion: "1.0",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }) + "\n");
    return handle;
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new Error("another package operation acquired the lock");
    }
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package method payload must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0 || field.length > 512) {
    throw new Error(key + " must be a bounded non-empty string");
  }
  return field;
}

function requiredIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("package mutations require an idempotency key");
  }
  return value;
}

function packageScope(value: unknown): PackageInstallScope {
  if (value === undefined || value === "project") return "project";
  if (value === "user") return "user";
  throw new Error("package scope must be project or user");
}

function packageListScope(value: unknown): PackageListScope {
  if (value === undefined || value === "effective") return "effective";
  return packageScope(value);
}

function permissionRequest(value: unknown): PluginPermissionRequest | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("grants must be an object");
  }
  return value as PluginPermissionRequest;
}
