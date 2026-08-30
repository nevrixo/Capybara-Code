import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { archiveNameFor } from "./archive-release.ts";
import {
  assertGlibcBuildHost,
  compareDottedVersions,
  newestGlibcSymbolVersion,
  parseGlibcVersion,
  releaseRuntimeRustFlags,
} from "./build-runtime.ts";
import { runtimeTargetDirectory } from "./build-standalone.ts";
import { expectedVersionFromArgs } from "./check-release.ts";
import { launcherPackageManifest, platformPackageManifest } from "./package-npm.ts";
import { runtimePathFor } from "./smoke-release.ts";
import {
  PRODUCT_PACKAGE,
  ROOT,
  assertAlphaVersion,
  assertArtifactSafety,
  assertReleaseVersions,
  assertStandaloneArtifact,
  releaseTarget,
  releaseTargetNames,
  versionFromTag,
} from "./release-common.ts";

const require = createRequire(import.meta.url);
const launcher = require("./release-launcher.cjs") as {
  readonly UPDATE_HANDOFF_EXIT_CODE: number;
  detectPackageManager(paths?: readonly string[]): "bun" | "npm";
  packageManagerCommand(
    manager: "bun" | "npm",
    options?: Record<string, unknown>,
  ): string;
  packageManagerInvocation(
    manager: "bun" | "npm",
    options?: Record<string, unknown>,
  ): { command: string; argsPrefix: readonly string[] };
  parseUpdateRequest(raw: string): { version: string; tag: string };
  platformSpec(platform?: string, arch?: string): { packageName: string; binary: string } | undefined;
  main(argv?: readonly string[], options?: Record<string, unknown>): number;
};

const VERSION = "0.1.2-alpha.1";

describe("Public Alpha release metadata", () => {
  test("accepts only alpha tags and requires every source to agree", () => {
    expect(versionFromTag("v0.1.2-alpha.1")).toBe(VERSION);
    expect(expectedVersionFromArgs(["--version", "v0.1.2-alpha.1"])).toBe(VERSION);
    expect(expectedVersionFromArgs([], { GITHUB_REF_NAME: "v0.1.2-alpha.1" })).toBe(VERSION);
    expect(() => assertAlphaVersion("0.1.0")).toThrow("alpha version");
    expect(() => versionFromTag("0.1.2-alpha.1")).toThrow("must start with 'v'");
    expect(() => assertReleaseVersions({ root: VERSION, app: VERSION, cargo: "0.1.0-alpha.9", cli: VERSION })).toThrow("disagree");
  });

  test("maps exactly the supported platform packages", () => {
    expect(releaseTargetNames()).toEqual(["windows-x64", "darwin-x64", "darwin-arm64", "linux-x64"]);
    expect(releaseTarget("windows-x64")).toMatchObject({
      npmPackage: "@ilbie/capybara-code-win32-x64",
      npmDirectory: "capybara-code-win32-x64",
      platform: "win32",
      arch: "x64",
      executableExtension: ".exe",
    });
    expect(releaseTarget("linux-x64")).toMatchObject({
      npmPackage: "@ilbie/capybara-code-linux-x64",
      npmDirectory: "capybara-code-linux-x64",
      libc: "glibc",
    });
    expect(() => releaseTarget("linux-arm64")).toThrow("unknown release target");
  });

  test("creates constrained platform and launcher package manifests", () => {
    const platform = platformPackageManifest("linux-x64", VERSION);
    expect(platform).toMatchObject({
      name: "@ilbie/capybara-code-linux-x64",
      version: VERSION,
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
      files: ["bin", "libexec", "share", "manifest.json", "LICENSE"],
      publishConfig: { access: "public", tag: "alpha" },
    });
    expect(platform).not.toHaveProperty("scripts");

    const root = launcherPackageManifest(VERSION);
    expect(PRODUCT_PACKAGE).toBe("capybara-code");
    expect(root.name).toBe(PRODUCT_PACKAGE);
    expect(root.bin).toEqual({ capy: "bin/capy.cjs" });
    expect(root.optionalDependencies).toEqual({
      "@ilbie/capybara-code-win32-x64": VERSION,
      "@ilbie/capybara-code-darwin-x64": VERSION,
      "@ilbie/capybara-code-darwin-arm64": VERSION,
      "@ilbie/capybara-code-linux-x64": VERSION,
    });
  });

  test("uses native archive extensions on each host family", () => {
    expect(archiveNameFor(VERSION, "windows-x64", "win32")).toBe("capybara-code-0.1.2-alpha.1-windows-x64.zip");
    expect(archiveNameFor(VERSION, "linux-x64", "linux")).toBe("capybara-code-0.1.2-alpha.1-linux-x64.tar.gz");
  });

  test("derives the sidecar strictly relative to the packaged bin directory", () => {
    expect(runtimePathFor("/tmp/capybara-code/bin/..", "linux-x64")).toBe("/tmp/capybara-code/libexec/cbc-runtime");
    expect(runtimePathFor("/tmp/capybara-code/bin/..", "windows-x64")).toBe("/tmp/capybara-code/libexec/cbc-runtime.exe");
  });

  test("packages the runtime from Cargo's configured target directory", () => {
    const root = join(tmpdir(), "capybara-root");
    expect(runtimeTargetDirectory(root, undefined)).toBe(join(root, "target"));
    expect(runtimeTargetDirectory(root, "verification-target")).toBe(
      join(root, "verification-target"),
    );
    const sharedTarget = join(tmpdir(), "capybara-shared-target");
    expect(runtimeTargetDirectory(root, sharedTarget)).toBe(sharedTarget);
  });

  test("enforces portable native runtime build settings", () => {
    expect(compareDottedVersions("2.31", "2.9")).toBeGreaterThan(0);
    expect(compareDottedVersions("2.31.0", "2.31")).toBe(0);
    expect(parseGlibcVersion("glibc 2.31")).toBe("2.31");
    expect(parseGlibcVersion("ldd (Ubuntu GLIBC 2.35-0ubuntu3.14) 2.35")).toBe("2.35");
    expect(newestGlibcSymbolVersion("GLIBC_2.17 GLIBC_2.31 GLIBC_2.2.5")).toBe("2.31");
    expect(assertGlibcBuildHost("2.31", "glibc 2.31")).toBe("2.31");
    expect(() => assertGlibcBuildHost("2.31", "glibc 2.35")).toThrow("newer than supported baseline");

    const windowsFlags = releaseRuntimeRustFlags("C:\\repo", ["C:\\Users\\builder"], "win32");
    const linuxFlags = releaseRuntimeRustFlags("/repo", ["/home/builder"], "linux");
    expect(windowsFlags).toContain("-Ctarget-feature=+crt-static");
    expect(linuxFlags).not.toContain("-Ctarget-feature=+crt-static");
  });

  test("pins documented platform floors and performs a real sidecar handshake", async () => {
    const [workflow, readme, smoke] = await Promise.all([
      readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
      readFile(join(ROOT, "README.md"), "utf8"),
      readFile(join(ROOT, "scripts", "smoke-release.ts"), "utf8"),
    ]);

    expect(workflow).toContain("image: ubuntu:20.04");
    expect(workflow).toContain('CBC_RELEASE_GLIBC_BASELINE: "2.31"');
    expect(workflow).toContain('macos_deployment_target: "13.0"');
    expect(workflow).toContain("needs: [validate, build-native, build-linux]");
    expect(smoke).toContain("await client.start()");
    expect(smoke).toContain('"--capabilities"');

    expect(readme).toContain("Windows 10 version 1809 or newer");
    expect(readme).toContain("macOS 13 Ventura or newer");
    expect(readme).toContain("Ubuntu 20.04 or newer");
    expect(readme).toContain("glibc 2.31 or newer");
  });

  test("seals native npm packages before artifact transport can strip execute modes", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const packStep = workflow.indexOf("Pack native npm tarball before artifact transfer");
    const uploadStep = workflow.indexOf("Upload immutable npm tarball and native archive");

    expect(packStep).toBeGreaterThan(-1);
    expect(uploadStep).toBeGreaterThan(packStep);
    expect(workflow).toContain("dist/npm-tarballs/");
    expect(workflow).toContain('npm publish "${package_tarball}"');
    expect(workflow).not.toContain('npm publish "./dist/npm/${package_dir}"');
    expect(workflow).toContain('test -x "${verify_dir}/package/bin/capy"');
    expect(workflow).toContain('test -x "${verify_dir}/package/libexec/cbc-runtime"');
  });

  test("publishes every post-bootstrap package exclusively through OIDC", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("Publish npm packages with npm trusted publishing");
    expect(workflow).toContain('npm publish "${package_tarball}" --tag alpha --access public --provenance');
    expect(workflow).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN: ${{ secrets.");
  });
});

describe("public capy launcher", () => {
  test("maps Node and Bun host platforms to their optional package", () => {
    expect(launcher.platformSpec("win32", "x64")).toEqual({
      packageName: "@ilbie/capybara-code-win32-x64",
      binary: "bin/capy.exe",
    });
    expect(launcher.platformSpec("darwin", "arm64")).toEqual({
      packageName: "@ilbie/capybara-code-darwin-arm64",
      binary: "bin/capy",
    });
    expect(launcher.platformSpec("linux", "arm64")).toBeUndefined();
  });

  test("forwards arguments and native exit status", () => {
    let received: { binary?: string; argv?: readonly string[] } = {};
    const exitCode = launcher.main(["--version"], {
      platform: "linux",
      arch: "x64",
      resolveModule: (specifier: string) => {
        expect(specifier).toBe("@ilbie/capybara-code-linux-x64/bin/capy");
        return "/tmp/capy";
      },
      spawn: (binary: string, argv: readonly string[]) => {
        received = { binary, argv };
        return { status: 17, signal: null };
      },
      stderr: () => undefined,
    });
    expect(exitCode).toBe(17);
    expect(received).toEqual({ binary: "/tmp/capy", argv: ["--version"] });
  });

  test("detects the global package manager from the launcher path", () => {
    expect(launcher.detectPackageManager(["/home/dev/.bun/bin/capy"])).toBe("bun");
    expect(
      launcher.detectPackageManager([
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\capybara-code\\bin\\capy.cjs",
      ]),
    ).toBe("npm");
    const bunCommand = launcher.packageManagerCommand("bun", {
      platform: "linux",
      env: { BUN_INSTALL: "/home/dev/.bun" },
      paths: [],
      exists: (path: string) => path.replace(/\\/g, "/") === "/home/dev/.bun/bin/bun",
    });
    expect(bunCommand.replace(/\\/g, "/")).toBe("/home/dev/.bun/bin/bun");

    const windowsNpm = launcher.packageManagerInvocation("npm", {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      exists: (path: string) => path.endsWith("node_modules\\npm\\bin\\npm-cli.js"),
    });
    expect(windowsNpm.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(windowsNpm.argsPrefix).toEqual([
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    ]);
  });

  test("installs the exact requested version after the native binary exits", () => {
    const updates: Array<{ command: string; args: readonly string[]; env?: Record<string, string> }> = [];
    const output: string[] = [];
    const version = "0.1.1-alpha.11";
    const exitCode = launcher.main([], {
      platform: "linux",
      arch: "x64",
      packageManager: "bun",
      managerCommand: "/home/dev/.bun/bin/bun",
      env: {
        PATH: "/home/dev/.bun/bin:/usr/bin",
        CAPYBARA_UPDATE_MANAGER: "attacker-controlled",
        CAPYBARA_UPDATE_REQUEST_FILE: "/tmp/attacker-controlled",
      },
      resolveModule: () => "/tmp/capy",
      spawn: () => ({ status: launcher.UPDATE_HANDOFF_EXIT_CODE, signal: null }),
      readUpdateRequest: () => JSON.stringify({
        schemaVersion: 1,
        packageName: "capybara-code",
        version,
        tag: `v${version}`,
      }),
      spawnUpdate: (
        command: string,
        args: readonly string[],
        options: { env?: Record<string, string> },
      ) => {
        updates.push({
          command,
          args,
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        return { status: 0, signal: null };
      },
      verifyInstalledVersion: () => version,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.command).toBe("/home/dev/.bun/bin/bun");
    expect(updates[0]?.args).toEqual(["install", "-g", "capybara-code@0.1.1-alpha.11"]);
    expect(updates[0]?.env?.CAPYBARA_UPDATE_MANAGER).toBeUndefined();
    expect(updates[0]?.env?.CAPYBARA_UPDATE_REQUEST_FILE).toBeUndefined();
    expect(output.join("\n")).toContain("installed successfully");
  });

  test("rejects malformed update requests before invoking a package manager", () => {
    const errors: string[] = [];
    let installed = false;
    const exitCode = launcher.main([], {
      platform: "linux",
      arch: "x64",
      packageManager: "npm",
      resolveModule: () => "/tmp/capy",
      spawn: () => ({ status: launcher.UPDATE_HANDOFF_EXIT_CODE, signal: null }),
      readUpdateRequest: () => JSON.stringify({
        schemaVersion: 1,
        packageName: "capybara-code",
        version: "alpha",
        tag: "v0.1.1-alpha.11",
      }),
      spawnUpdate: () => {
        installed = true;
        return { status: 0, signal: null };
      },
      stderr: (line: string) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(installed).toBe(false);
    expect(errors.join("\n")).toContain("rejected the update request");
  });

  test("explains absent optional dependencies and unsupported hosts", () => {
    const errors: string[] = [];
    expect(launcher.main([], {
      platform: "linux",
      arch: "x64",
      resolveModule: () => { throw new Error("not installed"); },
      stderr: (message: string) => errors.push(message),
    })).toBe(1);
    expect(errors.join("\n")).toContain("without --omit=optional");

    expect(launcher.main([], {
      platform: "linux",
      arch: "arm64",
      stderr: (message: string) => errors.push(message),
    })).toBe(1);
    expect(errors.join("\n")).toContain("does not support linux/arm64");
  });
});

describe("release artifact safety", () => {
  test("requires both POSIX native entry points to be executable", async () => {
    if (process.platform === "win32") return;

    const directory = await mkdtemp(join(tmpdir(), "capy-release-modes-"));
    const capy = join(directory, "bin", "capy");
    const runtime = join(directory, "libexec", "cbc-runtime");
    try {
      await Promise.all([
        mkdir(join(directory, "bin"), { recursive: true }),
        mkdir(join(directory, "libexec"), { recursive: true }),
        mkdir(join(directory, "share", "capybara"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(capy, "capy", { mode: 0o644 }),
        writeFile(runtime, "runtime", { mode: 0o644 }),
        writeFile(
          join(directory, "manifest.json"),
          JSON.stringify({ productVersion: VERSION, target: "linux-x64", compiled: true }),
          "utf8",
        ),
      ]);

      await expect(assertStandaloneArtifact(directory, "linux-x64", VERSION)).rejects.toThrow(
        "no execute permission",
      );
      await chmod(capy, 0o755);
      await expect(assertStandaloneArtifact(directory, "linux-x64", VERSION)).rejects.toThrow(
        "no execute permission",
      );
      await chmod(runtime, 0o755);
      await expect(assertStandaloneArtifact(directory, "linux-x64", VERSION)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects source maps, nested share/share, and local paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capy-release-artifact-"));
    try {
      await writeFile(join(directory, "safe.txt"), "public artifact", "utf8");
      await assertArtifactSafety(directory);

      // Bun standalone executables retain compiler debug metadata under the
      // runner's home directory. That is not a path from this checkout.
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "/home/runner";
      await writeFile(join(directory, "bun-runtime.txt"), `${home}/work/_temp/webkit-release`, "utf8");
      await assertArtifactSafety(directory);
      await rm(join(directory, "bun-runtime.txt"));

      await writeFile(join(directory, "checkout-path.txt"), `built in ${ROOT}`, "utf8");
      await expect(assertArtifactSafety(directory)).rejects.toThrow("local build path");
      await rm(join(directory, "checkout-path.txt"));

      await writeFile(join(directory, "main.js.map"), "{}", "utf8");
      await expect(assertArtifactSafety(directory, [directory])).rejects.toThrow("source map");
      await rm(join(directory, "main.js.map"));

      await mkdir(join(directory, "share", "share"), { recursive: true });
      await writeFile(join(directory, "share", "share", "bad.txt"), "bad", "utf8");
      await expect(assertArtifactSafety(directory, [directory])).rejects.toThrow("duplicated share");
      await rm(join(directory, "share"), { recursive: true, force: true });

      await writeFile(join(directory, "path.txt"), `built in ${directory}`, "utf8");
      await expect(assertArtifactSafety(directory, [directory])).rejects.toThrow("local build path");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
