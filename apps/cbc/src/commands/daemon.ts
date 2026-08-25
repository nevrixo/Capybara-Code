/**
 * Local daemon process control. The daemon binary is always resolved relative
 * to this launcher — never by searching PATH — so a user-installed namesake
 * cannot hijack session ownership.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { spawn } from "node:child_process";

import { EXIT } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export type DaemonSubcommand = "start" | "stop" | "status" | "logs" | "attach";

export interface DaemonCommandArgs {
  readonly sub: DaemonSubcommand;
  readonly sessionId?: string;
}

interface DaemonLock {
  readonly pid: number;
  readonly daemonId: string;
  readonly socketPath: string;
  readonly executable: string;
  readonly startedAt: string;
}

function runtimeDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "capybara-code");
  }
  return process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".capybara", "run");
}

export function daemonLockPath(): string {
  return join(runtimeDir(), "daemon.lock");
}

export function daemonLogPath(): string {
  return join(runtimeDir(), "daemon.log");
}

export function daemonSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\capybara-code-${process.getuid?.() ?? "user"}`;
  }
  return join(runtimeDir(), "daemon.sock");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(): Promise<DaemonLock | undefined> {
  try {
    const raw = JSON.parse(await readFile(daemonLockPath(), "utf8")) as Partial<DaemonLock>;
    if (typeof raw.pid !== "number" || typeof raw.daemonId !== "string" || typeof raw.socketPath !== "string") {
      return undefined;
    }
    return {
      pid: raw.pid,
      daemonId: raw.daemonId,
      socketPath: raw.socketPath,
      executable: typeof raw.executable === "string" ? raw.executable : "",
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    };
  } catch {
    return undefined;
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
  const existing = await readLock();
  if (existing !== undefined && processAlive(existing.pid)) {
    context.out(`daemon already running pid=${existing.pid} id=${existing.daemonId}`);
    return ok();
  }
  await mkdir(runtimeDir(), { recursive: true });
  const executable = resolveDaemonExecutable(context);
  const child = executable === undefined
    ? spawn(process.execPath, [join(import.meta.dir, "..", "..", "..", "capy-daemon", "src", "main.ts"), "start"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CAPY_DAEMON_LOCK: daemonLockPath(),
          CAPY_DAEMON_SOCKET: daemonSocketPath(),
          CAPY_DAEMON_LOG: daemonLogPath(),
        },
      })
    : spawn(executable, ["start"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CAPY_DAEMON_LOCK: daemonLockPath(),
          CAPY_DAEMON_SOCKET: daemonSocketPath(),
          CAPY_DAEMON_LOG: daemonLogPath(),
        },
      });
  child.unref();
  const lock: DaemonLock = {
    pid: child.pid ?? 0,
    daemonId: "daemon_" + crypto.randomUUID().replaceAll("-", ""),
    socketPath: daemonSocketPath(),
    executable: executable ?? process.execPath,
    startedAt: new Date().toISOString(),
  };
  await writeFile(daemonLockPath(), JSON.stringify(lock, null, 2), { encoding: "utf8", mode: 0o600 });
  context.out(`daemon started pid=${lock.pid} id=${lock.daemonId}`);
  return ok();
}

async function stopDaemon(context: CommandContext): Promise<CommandResult> {
  const existing = await readLock();
  if (existing === undefined) {
    context.out("daemon is not running");
    return ok();
  }
  if (processAlive(existing.pid)) {
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch (error) {
      context.warn("could not signal daemon: " + (error instanceof Error ? error.message : String(error)));
      return { code: EXIT.internal };
    }
  }
  context.out(`daemon stop requested pid=${existing.pid}`);
  return ok();
}

async function statusDaemon(context: CommandContext): Promise<CommandResult> {
  const existing = await readLock();
  if (existing === undefined) {
    context.out("daemon: stopped");
    return ok();
  }
  const alive = processAlive(existing.pid);
  context.out([
    `daemon: ${alive ? "running" : "stale-lock"}`,
    `pid: ${existing.pid}`,
    `id: ${existing.daemonId}`,
    `socket: ${existing.socketPath}`,
  ].join("\n"));
  return ok();
}

async function logsDaemon(context: CommandContext): Promise<CommandResult> {
  try {
    const text = await readFile(daemonLogPath(), "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0).slice(-100);
    context.out(lines.length > 0 ? lines.join("\n") : "daemon log is empty");
  } catch {
    context.out("daemon log is not available yet");
  }
  return ok();
}

async function attachDaemon(context: CommandContext, sessionId: string | undefined): Promise<CommandResult> {
  const existing = await readLock();
  if (existing === undefined || !processAlive(existing.pid)) {
    context.warn("daemon is not running; start it with capy daemon start or pass --no-daemon");
    return { code: EXIT.internal };
  }
  context.out(
    sessionId === undefined
      ? `attached as observer to ${existing.daemonId}`
      : `attached as observer to ${existing.daemonId} work ${sessionId}`,
  );
  return ok();
}
