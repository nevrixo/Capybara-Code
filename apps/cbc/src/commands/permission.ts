import { isPermissionPreset, permissionPresetDefinition, allPermissionPresets } from "@cbc/permissions";
import { EXIT, usageError } from "../exit.ts";
import { setUserConfigValue } from "../state.ts";
import type { CommandContext, CommandResult } from "./context.ts";

export async function permissionStatus(context: CommandContext): Promise<CommandResult> {
  const loaded = await context.config();
  const preset = loaded.config.permissions.preset ?? "auto";
  const lines = [
    `Permission  ${preset.toUpperCase()}`,
    `  ${permissionPresetDefinition(preset as "auto").description ?? ""}`,
    `Trust       ${loaded.config.sandbox.level}`,
    "",
    `Advanced`,
    `  Files       ${loaded.config.permissions.projectWrite}`,
    `  Network     ${loaded.config.permissions.network}`,
    `  Shell       ${loaded.config.permissions.shell}`,
  ];
  for (const line of lines) context.out(line);
  return { code: EXIT.ok };
}

export async function permissionSet(context: CommandContext, args: { preset: string; yes: boolean }): Promise<CommandResult> {
  if (!isPermissionPreset(args.preset)) {
    throw usageError(`unknown preset '${args.preset}'`, ["Use one of: read, edit, auto, yolo"]);
  }
  if (args.preset === "yolo" && !args.yes && context.host.io.isTty !== true) {
    throw usageError("yolo requires --yes", ["Run: capy permission set yolo --yes"]);
  }
  if (args.preset === "yolo" && !args.yes) {
    const answer = await (context.host.io as unknown as { confirm?: (msg: string, def: boolean) => Promise<boolean> }).confirm?.("Enable YOLO? All approvals skipped (trust/sandbox remain). Continue?", false);
    if (!answer) {
      context.out("Cancelled.");
      return { code: EXIT.ok };
    }
  }
  await setUserConfigValue(context.host, "permissions.preset", args.preset);
  context.out(`Permission set to ${args.preset.toUpperCase()}`);
  return { code: EXIT.ok };
}

export async function permissionReset(context: CommandContext): Promise<CommandResult> {
  await setUserConfigValue(context.host, "permissions.preset", "auto");
  context.out("Permission reset to AUTO");
  return { code: EXIT.ok };
}

export async function permissionExplain(context: CommandContext, args: { preset?: string }): Promise<CommandResult> {
  if (args.preset !== undefined) {
    if (!isPermissionPreset(args.preset)) throw usageError(`unknown preset '${args.preset}'`);
    const def = permissionPresetDefinition(args.preset as "read");
    context.out(`${def.label} — ${def.description}`);
    context.out(JSON.stringify(def.policy, null, 2));
    return { code: EXIT.ok };
  }
  for (const def of allPermissionPresets()) {
    context.out(`${def.label} — ${def.description}${def.dangerous ? " [dangerous]" : ""}`);
  }
  return { code: EXIT.ok };
}
