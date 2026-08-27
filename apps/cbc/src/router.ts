/** Route the public capy commands and normalize their exit codes. */

import { HELP_TEXT, type Command } from "./args.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import { authApi, authLogin, authLogout, authStatus } from "./commands/auth.ts";
import { configSet } from "./commands/config.ts";
import { CommandContext, type CommandResult } from "./commands/context.ts";
import { interactive } from "./commands/interactive.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { sessionWorker } from "./commands/session-worker.ts";
import { modelRefresh } from "./commands/model.ts";
import { run } from "./commands/run.ts";
import { updateCommand } from "./commands/update.ts";
import type { Host } from "./host.ts";

export interface RouteOptions {
  readonly host: Host;
  readonly version: string;
  readonly command: Command;
}

export async function route(options: RouteOptions): Promise<ExitCode> {
  const context = new CommandContext({
    host: options.host,
    version: options.version,
    ...(options.command.kind === "run" ? { nonInteractive: true } : {}),
  });

  try {
    const result = await dispatch(context, options.command);
    return result.code;
  } catch (error) {
    return report(context, error);
  } finally {
    await context.shutdown();
  }
}

async function dispatch(context: CommandContext, command: Command): Promise<CommandResult> {
  switch (command.kind) {
    case "interactive":
      return await interactive(context, {
        ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
        ...(command.noDaemon === true ? { noDaemon: true } : {}),
      });

    case "run":
      return await run(context, {
        ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
        ...(command.resultFile !== undefined ? { resultFile: command.resultFile } : {}),
        ...(command.noDaemon === true ? { noDaemon: true } : {}),
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
      return await modelRefresh(context);

    case "config":
      return await configSet(context, { path: command.path, value: command.value });

    case "session-worker":
      return await sessionWorker(context, {
        ...(command.sessionId !== undefined ? { sessionId: command.sessionId } : {}),
      });

    case "daemon":
      return await daemonCommand(context, {
        sub: command.sub,
        ...(command.sessionId !== undefined ? { sessionId: command.sessionId } : {}),
      });

    case "update":
      return await updateCommand(context, {
        ...(command.check === true ? { check: true } : {}),
      });

    case "version":
      context.out("capy " + context.version);
      return { code: EXIT.ok };

    case "help":
      context.out(HELP_TEXT);
      return { code: EXIT.ok };
  }
}

/** Turn a thrown error into the stable CLI exit code. */
export function report(context: CommandContext, error: unknown): ExitCode {
  if (error instanceof CliError) {
    context.warn("error: " + error.message);
    for (const line of error.detail) context.warn(line);
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  context.warn("error: " + message);
  if (error instanceof Error && error.stack !== undefined && context.host.env.CBC_DEBUG === "1") {
    context.warn(error.stack);
  }
  return EXIT.internal;
}