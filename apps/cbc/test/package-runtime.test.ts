import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalPluginPackageDigest,
  type PluginManifest,
} from "@cbc/plugin-sdk";

import {
  PackageRuntime,
  PackageRuntimeError,
} from "../src/package-runtime.ts";

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

function writeFixture(workspace: string): string {
  const encoder = new TextEncoder();
  const root = join(workspace, "packages", "quality");
  const runtimePath = "plugin.wasm";
  const runtimeBytes = encoder.encode(
    "function handle(params, host) { return { params, env: host.env }; }\n",
  );
  const pluginDigests = { [runtimePath]: digest(runtimeBytes) };
  const pluginManifest: PluginManifest = {
    schemaVersion: "1.0",
    id: "acme/quality-plugin",
    name: "Quality plugin",
    version: "1.0.0",
    publisher: "acme",
    description: "Package runtime test fixture.",
    license: "Apache-2.0",
    runtime: { kind: "wasi", entrypoint: runtimePath, protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=0.1.0" },
    permissions: { tools: ["fs.read"], workspaceRead: ["src/**"] },
    integrity: {
      files: pluginDigests,
      packageDigest: canonicalPluginPackageDigest(pluginDigests),
    },
  };
  const pluginManifestBytes = encoder.encode(JSON.stringify(pluginManifest));
  const files = {
    "plugins/quality/plugin.json": pluginManifestBytes,
    "plugins/quality/plugin.wasm": runtimeBytes,
  };
  const fileDigests = Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, digest(bytes)]),
  );
  const packageManifest = {
    schemaVersion: "1.0",
    id: "acme/typescript-quality",
    version: "1.0.0",
    capybara: ">=0.1.0",
    contents: { plugins: ["plugins/quality/plugin.json"] },
    permissions: { tools: ["fs.read"], workspaceRead: ["src/**"] },
    integrity: {
      files: fileDigests,
      packageDigest: canonicalPluginPackageDigest(fileDigests),
    },
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "capybara.package.json"), JSON.stringify(packageManifest));
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return "path:packages/quality";
}

function writeSkillFixture(workspace: string, name: string): string {
  const bytes = new TextEncoder().encode("# " + name + "\n");
  const path = "skills/" + name + "/SKILL.md";
  const digests = { [path]: digest(bytes) };
  const root = join(workspace, "packages", name);
  const manifest = {
    schemaVersion: "1.0",
    id: "acme/" + name,
    version: "1.0.0",
    capybara: ">=0.1.0",
    contents: { skills: [path] },
    permissions: {},
    integrity: {
      files: digests,
      packageDigest: canonicalPluginPackageDigest(digests),
    },
  };
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  writeFileSync(join(root, "capybara.package.json"), JSON.stringify(manifest));
  return "path:packages/" + name;
}

function runtime(root: string, projectTrusted = true): PackageRuntime {
  return new PackageRuntime({
    workspacePath: join(root, "workspace"),
    dataRoot: join(root, "data"),
    cacheRoot: join(root, "cache"),
    projectTrusted,
    now: () => "2026-08-30T00:00:00.000Z",
  });
}

describe("PackageRuntime", () => {
  test("installs, diagnoses, restores, and persists plugin enable state", async () => {
    const root = mkdtempSync(join(tmpdir(), "capy-package-runtime-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const source = writeFixture(workspace);
    const first = runtime(root);

    const receipt = await first.add({
      source,
      scope: "project",
      grants: { tools: ["fs.read"] },
      allowUnsignedLocal: true,
      idempotencyKey: "runtime-add",
    });
    expect(receipt.status).toBe("completed");
    expect((await first.list("effective")).map((item) => item.id))
      .toEqual(["acme/typescript-quality"]);
    expect(await first.doctor()).toEqual({ ok: true, packages: 1, issues: [] });
    expect(first.inspectPlugin("acme/quality-plugin")?.grants)
      .toEqual({ tools: ["fs.read"] });
    await first.setPluginEnabled("acme/quality-plugin", false);
    expect(first.inspectPlugin("acme/quality-plugin")?.enabled).toBe(false);
    const lockBefore = readFileSync(
      join(workspace, ".capybara", "packages.lock.json"),
      "utf8",
    );
    await first.dispose();

    const restored = runtime(root);
    expect(await restored.restoreAll()).toEqual([]);
    expect(restored.inspectPlugin("acme/quality-plugin")?.enabled).toBe(false);
    expect(readFileSync(
      join(workspace, ".capybara", "packages.lock.json"),
      "utf8",
    )).toBe(lockBefore);
    await restored.dispose();
  });

  test("requires trust for project changes and every local source", async () => {
    const root = mkdtempSync(join(tmpdir(), "capy-package-untrusted-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const source = writeFixture(workspace);
    const packages = runtime(root, false);

    await expect(packages.add({
      source,
      scope: "user",
      allowUnsignedLocal: true,
      idempotencyKey: "untrusted-local",
    })).rejects.toBeInstanceOf(PackageRuntimeError);
    await expect(packages.bootstrap({
      scope: "project",
      frozen: true,
      idempotencyKey: "untrusted-bootstrap",
    })).rejects.toMatchObject({ code: "PACKAGE_TRUST_REQUIRED" });
    await packages.dispose();
  });

  test("serializes concurrent mutations so both lock entries survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "capy-package-concurrent-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const alpha = writeSkillFixture(workspace, "alpha");
    const beta = writeSkillFixture(workspace, "beta");
    const packages = runtime(root);

    await Promise.all([
      packages.add({
        source: alpha,
        scope: "project",
        allowUnsignedLocal: true,
        idempotencyKey: "concurrent-alpha",
      }),
      packages.add({
        source: beta,
        scope: "project",
        allowUnsignedLocal: true,
        idempotencyKey: "concurrent-beta",
      }),
    ]);

    expect((await packages.list("project")).map((item) => item.id))
      .toEqual(["acme/alpha", "acme/beta"]);
    expect(() => readFileSync(
      join(workspace, ".capybara", "packages.lock.json.install.lock"),
      "utf8",
    )).toThrow();
    await packages.dispose();
  });
});
