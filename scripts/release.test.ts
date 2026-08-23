import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { archiveNameFor } from "./archive-release.ts";
import { expectedVersionFromArgs } from "./check-release.ts";
import { launcherPackageManifest, platformPackageManifest } from "./package-npm.ts";
import { runtimePathFor } from "./smoke-release.ts";
import {
  PRODUCT_PACKAGE,
  ROOT,
  assertAlphaVersion,
  assertArtifactSafety,
  assertReleaseVersions,
  releaseTarget,
  releaseTargetNames,
  versionFromTag,
} from "./release-common.ts";

const require = createRequire(import.meta.url);
const launcher = require("./release-launcher.cjs") as {
  platformSpec(platform?: string, arch?: string): { packageName: string; binary: string } | undefined;
  main(argv?: readonly string[], options?: Record<string, unknown>): number;
};

const VERSION = "0.1.0-alpha.2";

describe("Public Alpha release metadata", () => {
  test("accepts only alpha tags and requires every source to agree", () => {
    expect(versionFromTag("v0.1.0-alpha.2")).toBe(VERSION);
    expect(expectedVersionFromArgs(["--version", "v0.1.0-alpha.2"])).toBe(VERSION);
    expect(expectedVersionFromArgs([], { GITHUB_REF_NAME: "v0.1.0-alpha.2" })).toBe(VERSION);
    expect(() => assertAlphaVersion("0.1.0")).toThrow("alpha version");
    expect(() => versionFromTag("0.1.0-alpha.2")).toThrow("must start with 'v'");
    expect(() => assertReleaseVersions({ root: VERSION, app: VERSION, cargo: "0.1.0-alpha.3", cli: VERSION })).toThrow("disagree");
  });

  test("maps exactly the supported platform packages", () => {
    expect(releaseTargetNames()).toEqual(["windows-x64", "darwin-x64", "darwin-arm64", "linux-x64"]);
    expect(releaseTarget("windows-x64")).toMatchObject({
      npmPackage: "@nevrixo/capybara-code-win32-x64",
      npmDirectory: "capybara-code-win32-x64",
      platform: "win32",
      arch: "x64",
      executableExtension: ".exe",
    });
    expect(releaseTarget("linux-x64")).toMatchObject({
      npmPackage: "@nevrixo/capybara-code-linux-x64",
      npmDirectory: "capybara-code-linux-x64",
      libc: "glibc",
    });
    expect(() => releaseTarget("linux-arm64")).toThrow("unknown release target");
  });

  test("creates constrained platform and launcher package manifests", () => {
    const platform = platformPackageManifest("linux-x64", VERSION);
    expect(platform).toMatchObject({
      name: "@nevrixo/capybara-code-linux-x64",
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
      "@nevrixo/capybara-code-win32-x64": VERSION,
      "@nevrixo/capybara-code-darwin-x64": VERSION,
      "@nevrixo/capybara-code-darwin-arm64": VERSION,
      "@nevrixo/capybara-code-linux-x64": VERSION,
    });
  });

  test("uses native archive extensions on each host family", () => {
    expect(archiveNameFor(VERSION, "windows-x64", "win32")).toBe("capybara-code-0.1.0-alpha.2-windows-x64.zip");
    expect(archiveNameFor(VERSION, "linux-x64", "linux")).toBe("capybara-code-0.1.0-alpha.2-linux-x64.tar.gz");
  });

  test("derives the sidecar strictly relative to the packaged bin directory", () => {
    expect(runtimePathFor("/tmp/capybara-code/bin/..", "linux-x64")).toBe("/tmp/capybara-code/libexec/cbc-runtime");
    expect(runtimePathFor("/tmp/capybara-code/bin/..", "windows-x64")).toBe("/tmp/capybara-code/libexec/cbc-runtime.exe");
  });
});

describe("public capy launcher", () => {
  test("maps Node and Bun host platforms to their optional package", () => {
    expect(launcher.platformSpec("win32", "x64")).toEqual({
      packageName: "@nevrixo/capybara-code-win32-x64",
      binary: "bin/capy.exe",
    });
    expect(launcher.platformSpec("darwin", "arm64")).toEqual({
      packageName: "@nevrixo/capybara-code-darwin-arm64",
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
        expect(specifier).toBe("@nevrixo/capybara-code-linux-x64/bin/capy");
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
