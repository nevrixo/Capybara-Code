/** Global LSP configuration inspection and toggles. */

import { EXIT, usageError } from "../exit.ts";
import { resolveLspExecutable } from "../lsp-host.ts";
import { toSnakeCase, upsertTomlValue } from "../state.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

async function writeLspServerFields(
  context: CommandContext,
  server: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const file = context.paths.configFile;
  const existing = await context.host.fs.read(file);
  let lines = existing === undefined ? [] : existing.split("\n");

  for (const [key, value] of Object.entries(fields)) {
    lines = upsertTomlValue(lines, `lsp.servers.${server}.${toSnakeCase(key)}`, value);
  }

  await context.host.fs.mkdirp(context.paths.config);
  await context.host.fs.write(file, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return file;
}

export async function lspList(context: CommandContext): Promise<CommandResult> {
  await context.requireConfig();
  const loaded = await context.config();
  const servers = Object.entries(loaded.config.lspServers).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (servers.length === 0) {
    context.outLines([
      "No LSP servers are configured.",
      "",
      `Add a [lsp.servers.<name>] table to ${context.paths.configFile}`,
    ]);
    return ok();
  }

  const width = servers.reduce((maximum, [name]) => Math.max(maximum, name.length), 0);
  for (const [name, server] of servers) {
    const enabled = server.enabled === false ? "disabled" : "enabled";
    const source = loaded.provenance[`lspServers.${name}.command`] ?? "user";
    const command = [server.command, ...(server.args ?? [])].join(" ");
    context.out(
      `${name.padEnd(width)}  ${enabled.padEnd(8)}  [${source}]  ${command}  ` +
        `(${server.extensions.join(", ")} -> ${server.languageId})`,
    );
  }
  return ok();
}

export interface LspNameArgs {
  readonly name: string;
}

export async function lspSetEnabled(
  context: CommandContext,
  args: LspNameArgs,
  enabled: boolean,
): Promise<CommandResult> {
  const config = await context.requireConfig();
  if (config.lspServers[args.name] === undefined) {
    throw usageError(`no LSP server named '${args.name}'`);
  }
  const file = await writeLspServerFields(context, args.name, { enabled });
  context.out(`${enabled ? "Enabled" : "Disabled"} LSP server '${args.name}'`);
  context.out(`Wrote ${file}`);
  return ok();
}

export interface LspDoctorArgs {
  readonly name?: string;
}

/** Diagnose configuration and PATH visibility without spawning or installing. */
export async function lspDoctor(
  context: CommandContext,
  args: LspDoctorArgs,
): Promise<CommandResult> {
  const config = await context.requireConfig();
  const entries = Object.entries(config.lspServers)
    .filter(([name]) => args.name === undefined || name === args.name)
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    if (args.name !== undefined) throw usageError(`no LSP server named '${args.name}'`);
    context.out("No LSP servers are configured.");
    return ok();
  }

  let healthy = true;
  for (const [name, server] of entries) {
    if (server.enabled === false) {
      context.out(`- ${name}: disabled by global config`);
      continue;
    }
    const executable = resolveLspExecutable(server.command);
    if (executable === undefined) {
      healthy = false;
      context.out(
        `\u2717 ${name}: '${server.command}' was not found; ` +
          (server.installHint ?? "install it and make it available on PATH"),
      );
      continue;
    }
    context.out(`\u2713 ${name}: ${executable}`);
  }

  return healthy ? ok() : { code: EXIT.failure };
}
