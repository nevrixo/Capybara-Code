/** Public package and plugin command handlers. */

import { createHash, randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

import type { PackageInstallScope } from "@cbc/package-manager";
import { canonicalPluginPackageDigest } from "@cbc/plugin-sdk";

import type { Command } from "../args.ts";
import { CliError, EXIT } from "../exit.ts";
import { join } from "../host.ts";
import {
  PackageRuntimeError,
  type PackageListScope,
} from "../package-runtime.ts";
import type { CommandContext, CommandResult } from "./context.ts";

type PackageCommand = Extract<Command, { readonly kind: "package" }>;
type PluginCommand = Extract<Command, { readonly kind: "plugin" }>;

export async function bootstrapPackages(
  context: CommandContext,
  input: Extract<Command, { readonly kind: "bootstrap" }>,
): Promise<CommandResult> {
  const runtime = await context.packages();
  const receipts = await runtime.bootstrap({
    scope: input.scope,
    frozen: input.frozen,
    offline: input.offline,
    idempotencyKey: operationKey("bootstrap"),
  });
  context.out(JSON.stringify({
    status: "completed",
    frozen: input.frozen,
    offline: input.offline,
    packages: receipts.length,
    receipts,
  }, null, 2));
  return { code: EXIT.ok };
}

export async function packageCommand(
  context: CommandContext,
  command: PackageCommand,
): Promise<CommandResult> {
  const runtime = await context.packages();
  switch (command.sub) {
    case "add": {
      if (command.source.startsWith("path:") && command.allowUnsignedLocal) {
        context.warn(
          "warning: installing unsigned local package code after workspace trust approval",
        );
      }
      const preview = await runtime.preview({
        source: command.source,
        allowUnsignedLocal: command.allowUnsignedLocal,
        offline: command.offline,
      });
      context.out(JSON.stringify({
        package: preview.id,
        version: preview.version,
        signatureVerified: preview.signatureVerified,
        requested: preview.permissions,
        granted: command.grantRequested ? preview.permissions : {},
      }, null, 2));
      const receipt = await runtime.add({
        source: command.source,
        scope: command.scope,
        idempotencyKey: operationKey("add"),
        ...(command.grantRequested ? { grants: preview.permissions } : {}),
        allowUnsignedLocal: command.allowUnsignedLocal,
        offline: command.offline,
      });
      context.out(JSON.stringify(receipt, null, 2));
      return { code: EXIT.ok };
    }
    case "remove": {
      const receipt = await runtime.remove({
        packageId: command.packageId,
        scope: command.scope,
        idempotencyKey: operationKey("remove"),
      });
      context.out(JSON.stringify(receipt, null, 2));
      return { code: EXIT.ok };
    }
    case "update": {
      const receipts = await runtime.update({
        ...(command.packageId === undefined ? {} : { packageId: command.packageId }),
        scope: command.scope,
        idempotencyKey: operationKey("update"),
        offline: command.offline,
      });
      context.out(JSON.stringify({ status: "completed", receipts }, null, 2));
      return { code: EXIT.ok };
    }
    case "verify": {
      const receipt = await runtime.verify({
        source: command.source,
        scope: command.scope,
        idempotencyKey: operationKey("verify"),
        allowUnsignedLocal: command.allowUnsignedLocal,
        offline: command.offline,
      });
      context.out(JSON.stringify(receipt, null, 2));
      return { code: EXIT.ok };
    }
    case "list": {
      const packages = await runtime.list(command.scope);
      if (packages.length === 0) {
        context.out("No packages installed.");
      } else {
        context.outLines(packages.map((item) =>
          item.id + " " + item.version + " [" + item.scope + "] "
          + (item.signatureVerified ? "signed" : "local-unverified")
          + " " + item.packageDigest
        ));
      }
      return { code: EXIT.ok };
    }
    case "info": {
      const info = await runtime.inspectPackage(command.packageId, command.scope);
      const registry = info === undefined
        ? await runtime.inspectRegistry(command.packageId)
        : undefined;
      if (info === undefined && registry === undefined) {
        throw new PackageRuntimeError(
          "PACKAGE_NOT_FOUND",
          "package is not installed: " + command.packageId,
        );
      }
      context.out(JSON.stringify(info ?? { registry }, null, 2));
      return { code: EXIT.ok };
    }
    case "doctor": {
      const report = await runtime.doctor(command.packageId, command.scope);
      context.out(JSON.stringify(report, null, 2));
      return { code: report.ok ? EXIT.ok : EXIT.failure };
    }
    case "search": {
      const packages = await runtime.searchRegistry(command.query);
      context.out(JSON.stringify({ packages }, null, 2));
      return { code: EXIT.ok };
    }
    case "publish": {
      if (!command.dryRun) {
        throw new CliError(
          EXIT.permission,
          "publishing is approval-gated; this build supports --dry-run only",
        );
      }
      const source = localSource(context.workspacePath, command.path);
      const receipt = await runtime.verify({
        source,
        scope: "project",
        idempotencyKey: operationKey("publish-dry-run"),
        allowUnsignedLocal: true,
        offline: true,
      });
      context.out(JSON.stringify({
        status: "verified",
        published: false,
        source,
        receipt,
      }, null, 2));
      return { code: EXIT.ok };
    }
    case "init":
      await initializePackage(context, command.path);
      return { code: EXIT.ok };
  }
}

export async function pluginCommand(
  context: CommandContext,
  command: PluginCommand,
): Promise<CommandResult> {
  const runtime = await context.packages();
  const warnings = await runtime.restoreAll();
  for (const warning of warnings) context.warn(warning);
  switch (command.sub) {
    case "list": {
      const plugins = runtime.plugins();
      if (plugins.length === 0) context.out("No active plugins.");
      else {
        context.outLines(plugins.map((item) =>
          item.id + " " + item.version + " [" + item.scope + "] "
          + (item.enabled ? "enabled" : "disabled") + " " + item.health.status
        ));
      }
      return { code: warnings.length === 0 ? EXIT.ok : EXIT.partial };
    }
    case "inspect": {
      const plugin = runtime.inspectPlugin(command.pluginId);
      if (plugin === undefined) {
        throw new PackageRuntimeError(
          "PACKAGE_NOT_FOUND",
          "plugin is not installed: " + command.pluginId,
        );
      }
      context.out(JSON.stringify(plugin, null, 2));
      return { code: EXIT.ok };
    }
    case "enable":
    case "disable": {
      const plugin = await runtime.setPluginEnabled(command.pluginId, command.sub === "enable");
      context.out(JSON.stringify(plugin, null, 2));
      return { code: EXIT.ok };
    }
    case "grants": {
      const plugin = runtime.inspectPlugin(command.pluginId);
      if (plugin === undefined) {
        throw new PackageRuntimeError(
          "PACKAGE_NOT_FOUND",
          "plugin is not installed: " + command.pluginId,
        );
      }
      context.out(JSON.stringify({
        pluginId: plugin.id,
        requested: plugin.requested,
        granted: plugin.grants,
      }, null, 2));
      return { code: EXIT.ok };
    }
  }
}

export function mapPackageCommandError(error: PackageRuntimeError): CliError {
  if (error.code === "PACKAGE_TRUST_REQUIRED") {
    return new CliError(EXIT.permission, error.message, [
      "Run capy trust and review the project-control diff first.",
    ]);
  }
  if (error.code === "PACKAGE_REGISTRY_UNAVAILABLE") {
    return new CliError(EXIT.config, error.message);
  }
  return new CliError(EXIT.failure, error.message);
}

function operationKey(operation: string): string {
  return "cli:" + operation + ":" + randomUUID();
}

function localSource(workspacePath: string, path: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, path);
  const traversal = relative(root, target);
  if (
    traversal === ".."
    || traversal.startsWith(".." + sep)
    || traversal.startsWith("/")
  ) {
    throw new CliError(EXIT.permission, "package path escapes the trusted workspace");
  }
  return "path:" + (traversal.length === 0 ? "." : traversal.replaceAll("\\", "/"));
}

async function initializePackage(context: CommandContext, path: string): Promise<void> {
  const trust = await context.trust();
  if (trust !== "trusted-always" && trust !== "trusted-once") {
    throw new CliError(EXIT.permission, "package init requires a trusted workspace");
  }
  const source = localSource(context.workspacePath, path);
  const relativeRoot = source.slice("path:".length);
  const root = join(context.workspacePath, relativeRoot);
  const skillBody = [
    "---",
    "name: example",
    "description: Replace this with the package Skill description.",
    "---",
    "",
    "# Example",
    "",
    "Add package instructions here.",
    "",
  ].join("\n");
  const skillPath = "skills/example/SKILL.md";
  const digest = "sha256:" + createHash("sha256").update(skillBody).digest("hex");
  const manifest = {
    schemaVersion: "1.0",
    id: "local/example-package",
    version: "0.1.0",
    capybara: ">=0.1.0",
    contents: { skills: [skillPath] },
    permissions: {},
    integrity: {
      files: { [skillPath]: digest },
      packageDigest: canonicalPluginPackageDigest({ [skillPath]: digest }),
    },
  };
  await context.host.fs.mkdirp(join(root, "skills", "example"));
  const manifestPath = join(root, "capybara.package.json");
  const skillFilePath = join(root, skillPath);
  if (
    await context.host.fs.exists(manifestPath)
    || await context.host.fs.exists(skillFilePath)
  ) {
    throw new CliError(EXIT.failure, "package init refused to overwrite existing files");
  }
  if (context.host.fs.writeNew !== undefined) {
    const createdManifest = await context.host.fs.writeNew(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if (!createdManifest) {
      throw new CliError(EXIT.failure, "package init lost a concurrent manifest race");
    }
    const createdSkill = await context.host.fs.writeNew(skillFilePath, skillBody);
    if (!createdSkill) {
      await context.host.fs.remove(manifestPath).catch(() => undefined);
      throw new CliError(EXIT.failure, "package init lost a concurrent Skill race");
    }
  } else {
    await context.host.fs.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await context.host.fs.write(skillFilePath, skillBody);
  }
  context.out("Initialized package at " + root);
}
