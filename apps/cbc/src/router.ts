/** Route the public capy commands and normalize their exit codes. */

import { HELP_TEXT, type Command } from "./args.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import { acpCommand } from "./commands/acp.ts";
import { authApi, authLogin, authLogout, authStatus } from "./commands/auth.ts";
import { configSet, configValidate } from "./commands/config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { learnCommand } from "./commands/learn.ts";
import { skillsCommand } from "./commands/skills.ts";
import { clientsCommand, githubCommand, integrationDoctor } from "./commands/integrations.ts";
import { trustCommand } from "./commands/trust.ts";
import {
  bootstrapPackages,
  mapPackageCommandError,
  packageCommand,
  pluginCommand,
} from "./commands/packages.ts";
import { CommandContext, type CommandResult } from "./commands/context.ts";
import { PackageRuntimeError } from "./package-runtime.ts";
import { interactive } from "./commands/interactive.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { sessionWorker } from "./commands/session-worker.ts";
import { modelRefresh, modelUseProfile } from "./commands/model.ts";
import { run } from "./commands/run.ts";
import { updateCommand } from "./commands/update.ts";
import type { Host } from "./host.ts";
import {
  PackageInstallError,
  PackageVerificationError,
  UnsupportedPackageSourceError,
} from "@cbc/package-manager";

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

/** Dispatch a parsed command to its handler and return the result. */
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
        ...(command.eventFile !== undefined ? { eventFile: command.eventFile } : {}),
        ...(command.permissionPolicy !== undefined ? { permissionPolicy: command.permissionPolicy } : {}),
        ...(command.noDaemon === true ? { noDaemon: true } : {}),
      });

    case "acp":
      return await acpCommand(context);

    case "clients":
      return await clientsCommand(context, command.sub);

    case "doctor":
      return await doctorCommand(context, command.target);

    case "integration":
      return await integrationDoctor(context, command.target);

    case "github":
      return await githubCommand(context, command.sub);

    case "trust":
      return await trustCommand(context, { showDiff: command.showDiff });

    case "bootstrap":
      return await bootstrapPackages(context, command);

    case "package":
      return await packageCommand(context, command);

    case "plugin":
      return await pluginCommand(context, command);

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
      return command.sub === "use"
        ? await modelUseProfile(context, { profile: command.profile })
        : await modelRefresh(context);

    case "config":
      return command.sub === "validate"
        ? await configValidate(context, { explain: command.explain })
        : await configSet(context, { path: command.path, value: command.value });

    case "skills":
      return await skillsCommand(context, command);

    case "learn":
      return await learnCommand(context, command);

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
  if (error instanceof PackageRuntimeError) {
    return report(context, mapPackageCommandError(error));
  }
  if (error instanceof PackageInstallError) {
    context.warn(JSON.stringify(error.receipt));
    return report(context, new CliError(EXIT.failure, error.message));
  }
  if (
    error instanceof PackageVerificationError
    || error instanceof UnsupportedPackageSourceError
  ) {
    return report(context, new CliError(EXIT.config, error.message));
  }
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
