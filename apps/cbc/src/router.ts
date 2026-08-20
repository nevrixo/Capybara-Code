/**
 * Command router — PRD §8.1, §8.9.
 *
 * `parseArgs` produces a discriminated union, so the dispatch below is exhaustive by
 * construction: adding a command to §8.1's tree without handling it here fails to
 * compile rather than falling through to a generic error at runtime.
 *
 * The router also owns the two things every command shares: the §8.9 exit code, and
 * shutting the runtime down. Doing the latter in a `finally` means an early `throw`
 * cannot leave a sidecar running.
 */

import { HELP_TEXT, type Command, type CommonFlags } from "./args.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import { authApi, authLogin, authLogout, authStatus } from "./commands/auth.ts";
import { completion } from "./commands/completion.ts";
import { configGet, configPath, configPaths, configSet, configSources, configValidate } from "./commands/config.ts";
import { configInitCommand, initCommand } from "./commands/init.ts";
import { CommandContext, type CommandResult } from "./commands/context.ts";
import { doctor } from "./commands/doctor.ts";
import { interactive } from "./commands/interactive.ts";
import {
  mcpAdd,
  mcpDoctor,
  mcpList,
  mcpLogin,
  mcpLogout,
  mcpRemove,
  mcpSetEnabled,
} from "./commands/mcp.ts";
import { lspDoctor, lspList, lspSetEnabled } from "./commands/lsp.ts";
import { modelList, modelProfiles, modelRefresh, modelUse } from "./commands/model.ts";
import { run } from "./commands/run.ts";
import {
  sessionDelete,
  sessionExport,
  sessionFork,
  sessionList,
  sessionResume,
} from "./commands/session.ts";
import { skillsInspect, skillsList, skillsValidate } from "./commands/skills.ts";
import { permissionExplain, permissionReset, permissionSet, permissionStatus } from "./commands/permission.ts";
import { trustAdd, trustRemove, trustStatus } from "./commands/trust.ts";
import { update } from "./commands/update.ts";
import type { Host } from "./host.ts";

export interface RouteOptions {
  readonly host: Host;
  readonly version: string;
  readonly command: Command;
  readonly warnings?: readonly string[];
}

export async function route(options: RouteOptions): Promise<ExitCode> {
  const { command } = options;
  const flags: CommonFlags =
    command.kind === "interactive" || command.kind === "run" ? command.flags : {};

  const context = new CommandContext({
    host: options.host,
    version: options.version,
    ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
    ...(flags.plain === true ? { plain: true } : {}),
    ...(flags.noColor === true ? { noColor: true } : {}),
    ...(command.kind === "run" && command.jsonl ? { jsonl: true } : {}),
    ...(command.kind === "run" ? { nonInteractive: true } : {}),
    ...(flags.verbose === true ? { cliOverrides: { verbose: true } } : {}),
  });

  for (const warning of options.warnings ?? []) context.warn(warning);

  try {
    const result = await dispatch(context, command);
    return result.code;
  } catch (error) {
    return report(context, error);
  } finally {
    // §19.1: the sidecar is a child of this process, so it must not outlive it.
    // `CommandContext` starts it lazily, so commands that never touch the workspace
    // pay nothing here and stay inside §22.1's startup budget.
    await context.shutdown();
  }
}

async function dispatch(context: CommandContext, command: Command): Promise<CommandResult> {
  switch (command.kind) {
    case "interactive":
      return await interactive(context, {
        ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
        ...commonToArgs(command.flags),
      });

    case "run":
      return await run(context, {
        ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
        stdin: command.stdin,
        jsonl: command.jsonl,
        ...(command.output !== undefined ? { output: command.output } : {}),
        ...(command.permission !== undefined ? { permission: command.permission } : {}),
        ...commonToArgs(command.flags),
      });

    case "auth":
      switch (command.sub) {
        case "login":
          return await authLogin(context, { device: command.device });
        case "api":
          return await authApi(context, { fromStdin: command.fromStdin });
        case "status":
          return await authStatus(context);
        case "logout":
          return await authLogout(context, { all: command.all });
      }

    case "model":
      switch (command.sub) {
        case "list":
          return await modelList(context, { available: command.available });
        case "use":
          return await modelUse(context, { target: command.target });
        case "profiles":
          return await modelProfiles(context);
        case "refresh":
          return await modelRefresh(context);
      }

    case "session":
      switch (command.sub) {
        case "list":
          return await sessionList(context);
        case "resume":
          return await sessionResume(context, { id: command.id });
        case "fork":
          return await sessionFork(context, { id: command.id });
        case "export":
          return await sessionExport(context, {
            id: command.id,
            format: command.format,
            ...(command.output !== undefined ? { output: command.output } : {}),
          });
        case "delete":
          return await sessionDelete(context, { id: command.id });
      }

    case "skills":
      switch (command.sub) {
        case "list":
          return await skillsList(context);
        case "inspect":
          return await skillsInspect(context, { name: command.name });
        case "validate":
          return await skillsValidate(context, { path: command.path });
      }

    case "mcp":
      switch (command.sub) {
        case "list":
          return await mcpList(context, { verbose: command.verbose });
        case "add":
          return await mcpAdd(context, {
            name: command.name,
            ...(command.stdio !== undefined ? { stdio: command.stdio } : {}),
            ...(command.url !== undefined ? { url: command.url } : {}),
          });
        case "remove":
          return await mcpRemove(context, { name: command.name });
        case "enable":
          return await mcpSetEnabled(context, { name: command.name }, true);
        case "disable":
          return await mcpSetEnabled(context, { name: command.name }, false);
        case "login":
          return await mcpLogin(context, { name: command.name });
        case "logout":
          return await mcpLogout(context, { name: command.name });
        case "doctor":
          return await mcpDoctor(context, {
            ...(command.name !== undefined ? { name: command.name } : {}),
          });
      }

    case "lsp":
      switch (command.sub) {
        case "list":
          return await lspList(context);
        case "enable":
          return await lspSetEnabled(context, { name: command.name }, true);
        case "disable":
          return await lspSetEnabled(context, { name: command.name }, false);
        case "doctor":
          return await lspDoctor(context, {
            ...(command.name !== undefined ? { name: command.name } : {}),
          });
      }

    case "permission":
      switch (command.sub) {
        case "status":
          return await permissionStatus(context);
        case "set":
          return await permissionSet(context, { preset: command.preset, yes: command.yes });
        case "reset":
          return await permissionReset(context);
        case "explain":
          return await permissionExplain(context, { ...(command.preset !== undefined ? { preset: command.preset } : {}) });
      }

    case "config":
      switch (command.sub) {
        case "get":
          return await configGet(context, {
            ...(command.path !== undefined ? { path: command.path } : {}),
          });
        case "set":
          return await configSet(context, { path: command.path, value: command.value });
        case "path":
          return await configPath(context);
        case "paths":
          return await configPaths(context);
        case "validate":
          return await configValidate(context, { explain: command.explain });
        case "init":
          return await configInitCommand(context, {
            full: command.full,
            force: command.force,
          });
        case "sources":
          return await configSources(context);
      }

    case "init":
      return await initCommand(context, { force: command.force });

    case "trust":
      switch (command.sub) {
        case "status":
          return await trustStatus(context);
        case "add":
          return await trustAdd(context, { path: command.path });
        case "remove":
          return await trustRemove(context, { path: command.path });
      }

    case "doctor":
      return await doctor(context, { bundle: command.bundle, storage: command.storage });

    case "update":
      return await update(context, { check: command.check });

    case "completion":
      return await completion(context, { shell: command.shell });

    case "version":
      context.out(`capy ${context.version}`);
      return { code: EXIT.ok };

    case "help":
      context.out(HELP_TEXT);
      return { code: EXIT.ok };
  }
}

function commonToArgs(flags: CommonFlags): {
  model?: string;
  reasoning?: string;
  reasoningMode?: string;
  mode?: string;
  interactionMode?: "build" | "plan";
  permissionPreset?: "read" | "edit" | "auto" | "yolo";
  review?: "off" | "auto";
  resume?: string;
  readOnly?: boolean;
} {
  return {
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.reasoning !== undefined ? { reasoning: flags.reasoning } : {}),
    ...(flags.reasoningMode !== undefined ? { reasoningMode: flags.reasoningMode } : {}),
    ...(flags.mode !== undefined ? { mode: flags.mode } : {}),
    ...(flags.interactionMode !== undefined ? { interactionMode: flags.interactionMode } : {}),
    ...(flags.permission !== undefined ? { permissionPreset: flags.permission } : {}),
    ...(flags.review !== undefined ? { review: flags.review } : {}),
    ...(flags.resume !== undefined ? { resume: flags.resume } : {}),
    ...(flags.readOnly === true ? { readOnly: true } : {}),
  };
}

/**
 * Turn a thrown error into a §8.9 exit code.
 *
 * Diagnostics go to stderr unconditionally, including under `--jsonl`, so AC-37's
 * "stdout carries only events" holds even on the failure path.
 */
export function report(context: CommandContext, error: unknown): ExitCode {
  if (error instanceof CliError) {
    context.warn(`error: ${error.message}`);
    for (const line of error.detail) context.warn(line);
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  context.warn(`error: ${message}`);
  if (error instanceof Error && error.stack !== undefined && context.host.env.CBC_DEBUG === "1") {
    context.warn(error.stack);
  }
  return EXIT.internal;
}
