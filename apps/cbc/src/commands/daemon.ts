/**
 * Local daemon process control. The daemon binary is always resolved relative
 * to this launcher — never by searching PATH — so a user-installed namesake
 * cannot hijack session ownership.
 *
 * The CLI never writes the instance lock; the daemon process is the sole owner.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { spawn } from "node:child_process";

import { CapybaraClient } from "@cbc/sdk";

import {
  daemonStatus,
} from "../../../capy-daemon/src/daemon.ts";
import {
  readInstanceLock,
  resolveInstanceLockPaths,
} from "../../../capy-daemon/src/instance-lock.ts";
import { EXIT } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export type DaemonSubcommand = "start" | "stop" | "status" | "logs" | "attach";

export interface DaemonCommandArgs {
  readonly sub: DaemonSubcommand;
  readonly sessionId?: string;
}

export type SessionDaemonMode = "embedded" | "daemon";

export interface SessionDaemonHandle {
  readonly mode: SessionDaemonMode;
  readonly socketPath?: string;
  readonly daemonId?: string;
  readonly pid?: number;
}

function runtimeDirFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const override = env.CAPY_DAEMON_RUNTIME_DIR;
  return typeof override === "string" && override.trim().length > 0 ? override : undefined;
}

export function daemonLockPath(runtimeDir?: string): string {
  return resolveInstanceLockPaths(runtimeDir).lockPath;
}

export function daemonLogPath(runtimeDir?: string): string {
  return join(resolveInstanceLockPaths(runtimeDir).runtimeDir, "daemon.log");
}

export function daemonSocketPath(runtimeDir?: string): string {
  return resolveInstanceLockPaths(runtimeDir).socketPath;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveDaemonExecutable(context: CommandContext): string | undefined {
  const name = process.platform === "win32" ? "capy-daemon.exe" : "capy-daemon";
  const candidates = [
    join(context.host.executableDir, "..", "libexec", name),
    join(dirname(process.execPath), "..", "libexec", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Decide whether this process should attach to the local daemon.
 *
 * `--no-daemon` and `CBC_DAEMON=0` keep execution inside this process.
 */
export function sessionDaemonMode(input: {
  readonly noDaemon?: boolean;
  readonly envDaemon?: string;
  readonly enabled?: boolean;
}): SessionDaemonMode {
  if (input.noDaemon === true) return "embedded";
  if (input.envDaemon === "0" || input.envDaemon === "false") return "embedded";
  if (input.enabled !== true) return "embedded";
  return "daemon";
}

export async function ensureSessionDaemon(input: {
  readonly context: CommandContext;
  readonly noDaemon?: boolean;
  readonly enabled?: boolean;
  readonly autostart?: boolean;
  readonly runtimeDir?: string;
}): Promise<SessionDaemonHandle> {
  const env = input.context.host.env;
  const mode = sessionDaemonMode({
    ...(input.noDaemon !== undefined ? { noDaemon: input.noDaemon } : {}),
    ...(typeof env.CBC_DAEMON === "string" ? { envDaemon: env.CBC_DAEMON } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
  if (mode === "embedded") return { mode: "embedded" };

  const runtimeDir = input.runtimeDir ?? runtimeDirFromEnv(env);
  const existing = daemonStatus(runtimeDir);
  if (existing.running && existing.record !== undefined) {
    return {
      mode: "daemon",
      socketPath: resolveInstanceLockPaths(runtimeDir).socketPath,
      daemonId: existing.record.daemonId,
      pid: existing.record.pid,
    };
  }
  if (input.autostart === false) {
    input.context.warn("session daemon is enabled but not running; pass --no-daemon to stay in-process");
    return { mode: "embedded" };
  }
  await startDaemonProcess(input.context, runtimeDir);
  const ready = await waitForDaemon(runtimeDir, 8_000);
  if (!ready.running || ready.record === undefined) {
    input.context.warn("session daemon did not become ready; continuing in-process");
    return { mode: "embedded" };
  }
  return {
    mode: "daemon",
    socketPath: resolveInstanceLockPaths(runtimeDir).socketPath,
    daemonId: ready.record.daemonId,
    pid: ready.record.pid,
  };
}

export async function daemonCommand(
  context: CommandContext,
  args: DaemonCommandArgs,
): Promise<CommandResult> {
  switch (args.sub) {
    case "start":
      return await startDaemon(context);
    case "stop":
      return await stopDaemon(context);
    case "status":
      return await statusDaemon(context);
    case "logs":
      return await logsDaemon(context);
    case "attach":
      return await attachDaemon(context, args.sessionId);
  }
}

async function startDaemon(context: CommandContext): Promise<CommandResult> {
  const runtimeDir = runtimeDirFromEnv(context.host.env);
  const existing = daemonStatus(runtimeDir);
  if (existing.running && existing.record !== undefined) {
    context.out(`daemon already running pid=${existing.record.pid} id=${existing.record.daemonId}`);
    return ok();
  }
  await startDaemonProcess(context, runtimeDir);
  const ready = await waitForDaemon(runtimeDir, 8_000);
  if (!ready.running || ready.record === undefined) {
    context.warn("daemon process started but the instance lock did not appear");
    return { code: EXIT.internal };
  }
  context.out(`daemon started pid=${ready.record.pid} id=${ready.record.daemonId}`);
  return ok();
}

async function startDaemonProcess(context: CommandContext, runtimeDir?: string): Promise<void> {
  const paths = resolveInstanceLockPaths(runtimeDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  const executable = resolveDaemonExecutable(context);
  const env = {
    ...process.env,
    ...(runtimeDir !== undefined ? { CAPY_DAEMON_RUNTIME_DIR: runtimeDir } : {}),
  };
  const child = executable === undefined
    ? spawn(process.execPath, [
        join(import.meta.dir, "..", "..", "..", "capy-daemon", "src", "main.ts"),
        "start",
        ...(runtimeDir !== undefined ? ["--runtime-dir", runtimeDir] : []),
      ], {
        detached: true,
        stdio: "ignore",
        env,
      })
    : spawn(executable, ["start", ...(runtimeDir !== undefined ? ["--runtime-dir", runtimeDir] : [])], {
        detached: true,
        stdio: "ignore",
        env,
      });
  child.unref();
}

async function waitForDaemon(runtimeDir: string | undefined, timeoutMs: number): Promise<ReturnType<typeof daemonStatus>> {
  const started = Date.now();
  let status = daemonStatus(runtimeDir);
  while (!status.running && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = daemonStatus(runtimeDir);
  }
  return status;
}

async function stopDaemon(context: CommandContext): Promise<CommandResult> {
  const runtimeDir = runtimeDirFromEnv(context.host.env);
  const existing = daemonStatus(runtimeDir);
  if (!existing.running || existing.record === undefined) {
    context.out("daemon is not running");
    return ok();
  }
  if (processAlive(existing.record.pid)) {
    try {
      process.kill(existing.record.pid, "SIGTERM");
    } catch (error) {
      context.warn("could not signal daemon: " + (error instanceof Error ? error.message : String(error)));
      return { code: EXIT.internal };
    }
  }
  context.out(`daemon stop requested pid=${existing.record.pid}`);
  return ok();
}

async function statusDaemon(context: CommandContext): Promise<CommandResult> {
  const runtimeDir = runtimeDirFromEnv(context.host.env);
  const existing = daemonStatus(runtimeDir);
  if (!existing.running || existing.record === undefined) {
    const stale = readInstanceLock(runtimeDir);
    context.out(stale === undefined ? "daemon: stopped" : "daemon: stale-lock");
    return ok();
  }
  context.out([
    "daemon: running",
    `pid: ${existing.record.pid}`,
    `id: ${existing.record.daemonId}`,
    `socket: ${resolveInstanceLockPaths(runtimeDir).socketPath}`,
  ].join("\n"));
  return ok();
}

async function logsDaemon(context: CommandContext): Promise<CommandResult> {
  const runtimeDir = runtimeDirFromEnv(context.host.env);
  try {
    const text = await readFile(daemonLogPath(runtimeDir), "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0).slice(-100);
    context.out(lines.length > 0 ? lines.join("\n") : "daemon log is empty");
  } catch {
    context.out("daemon log is not available yet");
  }
  return ok();
}

async function attachDaemon(context: CommandContext, sessionId: string | undefined): Promise<CommandResult> {
  const runtimeDir = runtimeDirFromEnv(context.host.env);
  const existing = daemonStatus(runtimeDir);
  if (!existing.running || existing.record === undefined) {
    context.warn("daemon is not running; start it with capy daemon start or pass --no-daemon");
    return { code: EXIT.internal };
  }
  const socketPath = resolveInstanceLockPaths(runtimeDir).socketPath;
  try {
    const client = await CapybaraClient.connect({
      transport: process.platform === "win32" ? "pipe" : "unix",
      path: socketPath,
      client: {
        id: "cli_attach",
        name: "capy",
        version: context.version,
        kind: "cli",
      },
    });
    const attached = await client.request("session.attach", {
      sessionId: sessionId ?? "ses_local",
      workspaceIdentityDigest: "ws_local",
      mode: "observer",
    });
    await client.close();
    context.out(
      sessionId === undefined
        ? `attached as observer to ${existing.record.daemonId}`
        : `attached as observer to ${existing.record.daemonId} work ${sessionId}`,
    );
    void attached;
  } catch (error) {
    context.warn("could not attach: " + (error instanceof Error ? error.message : String(error)));
    return { code: EXIT.internal };
  }
  return ok();
}
