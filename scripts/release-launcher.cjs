#!/usr/bin/env node
"use strict";

/**
 * Public `capy` launcher. This file intentionally contains no installer, downloader,
 * or update logic: npm/Bun select the matching optional platform package at install
 * time, and the launcher simply executes its native binary.
 */

const { spawnSync } = require("node:child_process");

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

  const result = (options.spawn ?? spawnSync)(binary, argv, {
    stdio: "inherit",
    env: options.env ?? process.env,
  });

  if (result.error !== undefined) {
    writeError(`Capybara Code could not start ${binary}: ${result.error.message}`);
    return 1;
  }
  if (typeof result.status === "number") return result.status;
  if (result.signal !== null && result.signal !== undefined) {
    writeError(`Capybara Code stopped after signal ${result.signal}.`);
  }
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { PLATFORM_SPECS, platformSpec, resolveBinary, main };
