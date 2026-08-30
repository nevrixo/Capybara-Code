import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  PackageActivation,
  PackageActivationHost,
} from "@cbc/package-manager";
import type { PluginPermissionRequest } from "@cbc/plugin-sdk";
import { verifyPluginManifestDocument } from "@cbc/plugin-sdk";

import {
  PluginSupervisor,
  type PluginWorkerSpec,
} from "./plugin-supervisor.ts";

export class PluginSupervisorPackageActivationHost implements PackageActivationHost {
  readonly #supervisor: PluginSupervisor;
  readonly #projectTrusted: boolean;
  readonly #packagePlugins = new Map<string, readonly string[]>();
  readonly #rollbackSpecs = new Map<string, readonly PluginWorkerSpec[]>();
  readonly #pluginOwners = new Map<string, string>();
  readonly #rollbackOwners = new Map<string, ReadonlyMap<string, string>>();
  readonly #pluginGrants = new Map<string, PluginPermissionRequest>();
  readonly #rollbackGrants = new Map<string, ReadonlyMap<string, PluginPermissionRequest>>();

  constructor(options: {
    readonly supervisor: PluginSupervisor;
    readonly projectTrusted: boolean;
  }) {
    this.#supervisor = options.supervisor;
    this.#projectTrusted = options.projectTrusted;
  }

  packageForPlugin(pluginId: string): string | undefined {
    return this.#pluginOwners.get(pluginId);
  }

  grantsForPlugin(pluginId: string): PluginPermissionRequest | undefined {
    return this.#pluginGrants.get(pluginId);
  }

  async activate(input: PackageActivation): Promise<void> {
    const packageId = input.verified.manifest.id;
    const specs: PluginWorkerSpec[] = [];
    for (const manifestPath of input.verified.manifest.contents.plugins ?? []) {
      const absoluteManifest = inside(input.stage.root, manifestPath);
      const document = verifyPluginManifestDocument(
        new Uint8Array(await readFile(absoluteManifest)),
      );
      const admission = input.pluginAdmissions.find(
        (item) => item.pluginId === document.manifest.id,
      );
      if (admission === undefined || admission.version !== document.manifest.version) {
        throw new Error("plugin activation is not bound to its admission evidence");
      }
      const pluginRoot = dirname(absoluteManifest);
      const entrypoint = inside(pluginRoot, document.manifest.runtime.entrypoint);
      specs.push({
        pluginId: document.manifest.id,
        scope: input.scope,
        manifest: document.manifest,
        command: entrypoint,
        cwd: pluginRoot,
        trustedWorkspace: input.scope !== "project" || this.#projectTrusted,
      });
    }
    const previous: PluginWorkerSpec[] = [];
    const previousOwners = new Map<string, string>();
    const previousGrants = new Map<string, PluginPermissionRequest>();
    for (const pluginId of this.#packagePlugins.get(packageId) ?? specs.map((item) => item.pluginId)) {
      const inspected = this.#supervisor.inspect(pluginId);
      const existingOwner = this.#pluginOwners.get(pluginId);
      if (inspected !== undefined && existingOwner !== undefined && existingOwner !== packageId) {
        throw new Error(
          "plugin id collision: " + pluginId + " is already owned by " + existingOwner,
        );
      }
      if (inspected !== undefined) previous.push(inspected.spec);
      const owner = existingOwner;
      if (owner !== undefined) previousOwners.set(pluginId, owner);
      const grant = this.#pluginGrants.get(pluginId);
      if (grant !== undefined) previousGrants.set(pluginId, grant);
      this.#supervisor.uninstall(pluginId);
      this.#pluginOwners.delete(pluginId);
      this.#pluginGrants.delete(pluginId);
    }
    this.#rollbackSpecs.set(packageId, Object.freeze(previous));
    this.#rollbackOwners.set(packageId, previousOwners);
    this.#rollbackGrants.set(packageId, previousGrants);
    const installed: string[] = [];
    try {
      for (const spec of specs) {
        this.#supervisor.install(spec);
        installed.push(spec.pluginId);
        this.#pluginOwners.set(spec.pluginId, packageId);
        const admission = input.pluginAdmissions.find(
          (item) => item.pluginId === spec.pluginId,
        );
        this.#pluginGrants.set(spec.pluginId, admission?.grants ?? {});
      }
      this.#packagePlugins.set(packageId, Object.freeze(installed));
    } catch (error) {
      for (const pluginId of installed) {
        this.#supervisor.uninstall(pluginId);
        this.#pluginOwners.delete(pluginId);
        this.#pluginGrants.delete(pluginId);
      }
      for (const spec of previous) {
        this.#supervisor.install(spec);
        const owner = previousOwners.get(spec.pluginId);
        if (owner !== undefined) this.#pluginOwners.set(spec.pluginId, owner);
        const grant = previousGrants.get(spec.pluginId);
        if (grant !== undefined) this.#pluginGrants.set(spec.pluginId, grant);
      }
      throw error;
    }
  }

  async healthCheck(input: PackageActivation): Promise<boolean> {
    return input.pluginAdmissions.every(
      (admission) => this.#supervisor.health(admission.pluginId).status === "ready",
    );
  }

  async rollback(
    packageId: string,
    previous: import("@cbc/package-manager").PackageLockEntry | undefined,
  ): Promise<void> {
    for (const pluginId of this.#packagePlugins.get(packageId) ?? []) {
      this.#supervisor.uninstall(pluginId);
      if (this.#pluginOwners.get(pluginId) === packageId) this.#pluginOwners.delete(pluginId);
      this.#pluginGrants.delete(pluginId);
    }
    this.#packagePlugins.delete(packageId);
    const specs = this.#rollbackSpecs.get(packageId) ?? [];
    const owners = this.#rollbackOwners.get(packageId) ?? new Map<string, string>();
    const grants = this.#rollbackGrants.get(packageId)
      ?? new Map<string, PluginPermissionRequest>();
    this.#rollbackSpecs.delete(packageId);
    this.#rollbackOwners.delete(packageId);
    this.#rollbackGrants.delete(packageId);
    if (previous !== undefined) {
      for (const spec of specs) {
        this.#supervisor.install(spec);
        const owner = owners.get(spec.pluginId);
        if (owner !== undefined) this.#pluginOwners.set(spec.pluginId, owner);
        const grant = grants.get(spec.pluginId);
        if (grant !== undefined) this.#pluginGrants.set(spec.pluginId, grant);
      }
      if (specs.length > 0) {
        this.#packagePlugins.set(packageId, Object.freeze(specs.map((item) => item.pluginId)));
      }
    }
  }
}

function inside(root: string, relativePath: string): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, ...relativePath.split("/"));
  const prefix = normalizedRoot.endsWith("\\") || normalizedRoot.endsWith("/")
    ? normalizedRoot
    : normalizedRoot + (process.platform === "win32" ? "\\" : "/");
  const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const comparableExactRoot = process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const comparableRoot = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  if (comparableTarget !== comparableExactRoot && !comparableTarget.startsWith(comparableRoot)) {
    throw new Error("package activation path escaped the immutable cache root");
  }
  return target;
}
