#!/usr/bin/env node
"use strict";

/**
 * Public `capy` launcher. npm/Bun select the matching optional platform package
 * at install time. When the native binary explicitly requests an exact-version
 * update, this launcher waits for it to exit before invoking the same global
 * package manager. That ordering is required on Windows, where a running binary
 * cannot replace itself.
 */

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const UPDATE_HANDOFF_EXIT_CODE = 42;
const UPDATE_REQUEST_FILE_ENV = "CAPYBARA_UPDATE_REQUEST_FILE";
const UPDATE_MANAGER_ENV = "CAPYBARA_UPDATE_MANAGER";
const UPDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const PLATFORM_SPECS = Object.freeze({
  "win32:x64": Object.freeze({ packageName: "@ilbie/capybara-code-win32-x64", binary: "bin/capy.exe" }),
  "darwin:x64": Object.freeze({ packageName: "@ilbie/capybara-code-darwin-x64", binary: "bin/capy" }),
  "darwin:arm64": Object.freeze({ packageName: "@ilbie/capybara-code-darwin-arm64", binary: "bin/capy" }),
  "linux:x64": Object.freeze({ packageName: "@ilbie/capybara-code-linux-x64", binary: "bin/capy" }),
});

function platformSpec(platform = process.platform, arch = process.arch) {
  return PLATFORM_SPECS[`${platform}:${arch}`];
}

function resolveBinary(spec, resolver = require.resolve) {
  try {
    return resolver(`${spec.packageName}/${spec.binary}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Capybara Code could not find its ${spec.packageName} optional dependency.`,
        "Reinstall capybara-code without --omit=optional (or Bun's equivalent).",
        "For a manual install, use the matching archive from GitHub Releases and verify SHA256SUMS.txt.",
        `Resolver detail: ${detail}`,
      ].join("\n"),
    );
  }
}

function normalizedPath(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/") : "";
}

/** Bun's global package tree is rooted below `.bun`; all other published launchers use npm. */
function detectPackageManager(paths = [process.argv[1], __filename]) {
  return paths.some((value) => normalizedPath(value).toLowerCase().includes("/.bun/")) ? "bun" : "npm";
}

/** Resolve the package-manager executable without evaluating a shell command. */
function packageManagerCommand(manager, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.exists ?? existsSync;
  const sourcePaths = options.paths ?? [process.argv[1], __filename];
  const candidates = [];

  if (manager === "bun") {
    const executable = platform === "win32" ? "bun.exe" : "bun";
    if (typeof env.BUN_INSTALL === "string" && env.BUN_INSTALL.length > 0) {
      candidates.push(join(env.BUN_INSTALL, "bin", executable));
    }
    for (const source of sourcePaths) {
      const normalized = normalizedPath(source);
      const marker = normalized.toLowerCase().indexOf("/.bun/");
      if (marker !== -1) candidates.push(join(normalized.slice(0, marker + "/.bun".length), "bin", executable));
    }
    const absolute = candidates.find((candidate) => pathExists(candidate));
    return absolute ?? executable;
  }

  const executable = platform === "win32" ? "npm.cmd" : "npm";
  candidates.push(join(dirname(options.execPath ?? process.execPath), executable));
  const absolute = candidates.find((candidate) => pathExists(candidate));
  return absolute ?? executable;
}

/** Windows cannot spawn npm.cmd without a shell; execute npm-cli.js with Node instead. */
function packageManagerInvocation(manager, options = {}) {
  const platform = options.platform ?? process.platform;
  if (manager === "npm" && platform === "win32") {
    const execPath = options.execPath ?? process.execPath;
    const npmCli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const pathExists = options.exists ?? existsSync;
    if (pathExists(npmCli)) return { command: execPath, argsPrefix: [npmCli] };
  }
  return { command: packageManagerCommand(manager, options), argsPrefix: [] };
}

function parseUpdateRequest(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("update request is not an object");
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.packageName !== "capybara-code" ||
    typeof parsed.version !== "string" ||
    !UPDATE_VERSION_PATTERN.test(parsed.version) ||
    parsed.tag !== `v${parsed.version}`
  ) {
    throw new Error("update request failed validation");
  }
  return { version: parsed.version, tag: parsed.tag };
}

function installedPackageVersion(packageJsonPath = join(__dirname, "..", "package.json")) {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return typeof parsed.version === "string" ? parsed.version : undefined;
}

function installRequestedUpdate(request, manager, options = {}) {
  const writeError = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const writeOutput = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const invocation = options.managerInvocation ?? packageManagerInvocation(manager, options);
  const command = options.managerCommand ?? invocation.command;
  const argsPrefix = options.managerArgsPrefix ?? invocation.argsPrefix;
  const install = options.spawnUpdate ?? spawnSync;
  const packageSpec = `capybara-code@${request.version}`;

  writeOutput(`Updating Capybara Code to ${request.version} with ${manager}...`);
  const result = install(command, [...argsPrefix, "install", "-g", packageSpec], {
    stdio: "inherit",
    env: options.env ?? process.env,
  });
  if (result.error !== undefined) {
    writeError(`Capybara Code could not start ${manager}: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    writeError(`${manager} failed to install ${packageSpec} (exit ${String(result.status)}).`);
    return typeof result.status === "number" && result.status > 0 ? result.status : 1;
  }

  const verify = options.verifyInstalledVersion ?? installedPackageVersion;
  let installed;
  try {
    installed = verify();
  } catch (error) {
    writeError(`Capybara Code could not verify the installed version: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (installed !== request.version) {
    writeError(`The package manager completed, but capybara-code is ${String(installed)} instead of ${request.version}.`);
    return 1;
  }

  writeOutput(`Capybara Code ${request.version} installed successfully. Run capy again.`);
  return 0;
}

function main(argv = process.argv.slice(2), options = {}) {
  const writeError = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const spec = platformSpec(platform, arch);

  if (spec === undefined) {
    writeError(
      `Capybara Code Public Alpha does not support ${platform}/${arch}. ` +
      "Supported: Windows x64, macOS x64/ARM64, and Linux x64 (glibc).",
    );
    return 1;
  }

  let binary;
  try {
    binary = (options.resolveModule ?? require.resolve)(`${spec.packageName}/${spec.binary}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeError(
      [
        `Capybara Code could not find its ${spec.packageName} optional dependency.`,
        "Reinstall capybara-code without --omit=optional (or Bun's equivalent).",
        "For a manual install, use the matching archive from GitHub Releases and verify SHA256SUMS.txt.",
        `Resolver detail: ${detail}`,
      ].join("\n"),
    );
    return 1;
  }

  const baseEnv = { ...(options.env ?? process.env) };
  delete baseEnv[UPDATE_REQUEST_FILE_ENV];
  delete baseEnv[UPDATE_MANAGER_ENV];

  const manager = options.packageManager ?? detectPackageManager(options.managerPaths);
  let updateDirectory;
  try {
    updateDirectory = (options.makeUpdateDirectory ?? mkdtempSync)(
      join(options.tempDirectory ?? tmpdir(), "capy-update-"),
    );
  } catch {
    // The native binary sees no handoff marker and shows exact manual instructions.
  }

  const requestFile = updateDirectory === undefined ? undefined : join(updateDirectory, "request.json");
  const childEnv = {
    ...baseEnv,
    ...(requestFile === undefined
      ? {}
      : {
          [UPDATE_REQUEST_FILE_ENV]: requestFile,
          [UPDATE_MANAGER_ENV]: manager,
        }),
  };

  try {
    const result = (options.spawn ?? spawnSync)(binary, argv, {
      stdio: "inherit",
      env: childEnv,
    });

    if (result.error !== undefined) {
      writeError(`Capybara Code could not start ${binary}: ${result.error.message}`);
      return 1;
    }
    if (result.status === UPDATE_HANDOFF_EXIT_CODE) {
      if (requestFile === undefined) {
        writeError("Capybara Code requested an update without a secure launcher handoff.");
        return 1;
      }
      let request;
      try {
        request = parseUpdateRequest((options.readUpdateRequest ?? readFileSync)(requestFile, "utf8"));
      } catch (error) {
        writeError(`Capybara Code rejected the update request: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      return installRequestedUpdate(request, manager, {
        ...options,
        env: baseEnv,
        stderr: writeError,
      });
    }
    if (typeof result.status === "number") return result.status;
    if (result.signal !== null && result.signal !== undefined) {
      writeError(`Capybara Code stopped after signal ${result.signal}.`);
    }
    return 1;
  } finally {
    if (updateDirectory !== undefined) {
      try {
        (options.removeUpdateDirectory ?? rmSync)(updateDirectory, { recursive: true, force: true });
      } catch {}
    }
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  PLATFORM_SPECS,
  UPDATE_HANDOFF_EXIT_CODE,
  detectPackageManager,
  packageManagerCommand,
  packageManagerInvocation,
  parseUpdateRequest,
  installRequestedUpdate,
  platformSpec,
  resolveBinary,
  main,
};
