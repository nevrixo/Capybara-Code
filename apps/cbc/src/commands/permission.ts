import {
  allPermissionPresets,
  describeEffectivePermissionPolicy,
  isPermissionPreset,
  permissionPresetDefinition,
  resolvePermissionPolicy,
  type PermissionConfig,
} from "@cbc/permissions";
import { EXIT, CliError, usageError } from "../exit.ts";
import { updateUserConfigTransaction } from "../state.ts";
import type { CommandContext, CommandResult } from "./context.ts";

function configPermissions(config: Awaited<ReturnType<CommandContext["config"]>>["config"]): PermissionConfig {
  return {
    projectWrite: config.permissions.projectWrite,
    shell: config.permissions.shell,
    network: config.permissions.network,
    destructive: config.permissions.destructive,
    credentials: config.permissions.credentials,
    externalSideEffect: config.permissions.externalSideEffect,
  };
}

export async function permissionStatus(context: CommandContext): Promise<CommandResult> {
  const loaded = await context.config();
  const policy = resolvePermissionPolicy(
    loaded.config.permissions.preset,
    configPermissions(loaded.config),
    loaded.config.agent.permissionMode,
  );
  const trust = await context.trust();
  const lines = [
    `Permission  ${policy.effectiveKind.toUpperCase()}`,
    ...describeEffectivePermissionPolicy(policy),
    `Trust       ${trust}`,
    `Sandbox     ${loaded.config.sandbox.level}`,
    `Source      ${policy.selectedPreset === undefined
      ? (loaded.provenance["agent.permissionMode"] === undefined ? "default" : `legacy ${loaded.config.agent.permissionMode} (${loaded.provenance["agent.permissionMode"]})`)
      : (loaded.provenance["permissions.preset"] ?? "session")}`,
  ];
  if (policy.restrictions.length > 0) lines.push(`  Restrictions ${policy.restrictions.length}`);
  for (const line of lines) context.out(line);
  return { code: EXIT.ok };
}

export async function permissionSet(context: CommandContext, args: { preset: string; yes: boolean }): Promise<CommandResult> {
  if (!isPermissionPreset(args.preset)) {
    throw usageError(`unknown preset '${args.preset}'`, ["Use one of: read, edit, auto, yolo"]);
  }
  if (args.preset === "yolo" && !args.yes) {
    if (context.host.io.isTty !== true) throw usageError("yolo requires --yes", ["Run: capy permission set yolo --yes"]);
    const selected = await context.host.io.select(
      "YOLO skips soft approval prompts; trust, deny rules, credentials, Plan scope, sandbox, and OS permissions remain enforced.",
      ["Cancel", "Enable and save"],
    );
    if (selected !== 1) {
      context.out("Cancelled.");
      return { code: EXIT.ok };
    }
  }
  const result = await updateUserConfigTransaction(context.host, {
    set: { "permissions.preset": args.preset },
    // Canonical preset selection and legacy permission mode must be one write.
    unset: ["agent.permissionMode"],
  });
  const error = result.issues.find((issue) => issue.severity === "error");
  if (error !== undefined) {
    throw new CliError(EXIT.config, `permission preset was not saved${error === undefined ? "" : `: ${error.message}`}`,
      result.issues.filter((issue) => issue.severity === "error").map((issue) => `  ${issue.path}: ${issue.message}`));
  }
  const saved = await context.config();
  const effective = resolvePermissionPolicy(saved.config.permissions.preset, configPermissions(saved.config), saved.config.agent.permissionMode);
  context.out(`Permission set to ${args.preset.toUpperCase()} (effective ${effective.effectiveKind.toUpperCase()})`);
  if (effective.restrictions.length > 0) context.out(`Restrictions: ${effective.restrictions.length}`);
  return { code: EXIT.ok };
}

export async function permissionReset(context: CommandContext): Promise<CommandResult> {
  const result = await updateUserConfigTransaction(context.host, {
    unset: [
      "permissions.preset",
      "permissions.projectWrite",
      "permissions.shell",
      "permissions.network",
      "permissions.destructive",
      "permissions.credentials",
      "permissions.externalSideEffect",
      "agent.permissionMode",
    ],
  });
  const error = result.issues.find((issue) => issue.severity === "error");
  if (error !== undefined) {
    throw new CliError(EXIT.config, `permission reset was not saved: ${error.message}`);
  }
  context.out("Permission reset to product default (CUSTOM/ASK)");
  return { code: EXIT.ok };
}

export async function permissionExplain(context: CommandContext, args: { preset?: string }): Promise<CommandResult> {
  if (args.preset !== undefined) {
    if (!isPermissionPreset(args.preset)) throw usageError(`unknown preset '${args.preset}'`);
    const def = permissionPresetDefinition(args.preset);
    context.out(`${def.label} — ${def.description}`);
    context.out(JSON.stringify(def.policy, null, 2));
    return { code: EXIT.ok };
  }
  const loaded = await context.config();
  const policy = resolvePermissionPolicy(loaded.config.permissions.preset, configPermissions(loaded.config), loaded.config.agent.permissionMode);
  context.out("Effective permission policy");
  context.out(`Source ${policy.selectedPreset === undefined ? (loaded.provenance["agent.permissionMode"] ?? "default") : (loaded.provenance["permissions.preset"] ?? "session")}`);
  context.outLines(describeEffectivePermissionPolicy(policy));
  context.out("\nStatic presets");
  for (const def of allPermissionPresets()) context.out(`${def.label} — ${def.description}${def.dangerous ? " [dangerous]" : ""}`);
  return { code: EXIT.ok };
}
