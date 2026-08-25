#!/usr/bin/env bun
/**
 * capy-daemon CLI: start | stop | status | logs. Default command is start.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CapybaraDaemon, daemonStatus } from "./daemon.ts";
import { spawnStdioWorker } from "./session-worker-host.ts";
import { resolveInstanceLockPaths } from "./instance-lock.ts";

const DEFAULT_COMMAND = "start";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = (argv[0] ?? DEFAULT_COMMAND).toLowerCase();
  const runtimeDir = flagValue(argv, "--runtime-dir") ?? process.env.CAPY_DAEMON_RUNTIME_DIR;
  const paths = resolveInstanceLockPaths(runtimeDir);

  switch (command) {
    case "start": {
      const capyEntry = join(dirname(import.meta.dir), "..", "cbc", "src", "main.ts");
      const daemon = new CapybaraDaemon({
        ...(runtimeDir !== undefined ? { runtimeDir } : {}),
        listen: true,
        ...(existsSync(capyEntry)
          ? {
              spawnSessionWorker: (sessionId: string) => spawnStdioWorker(
                process.execPath,
                [capyEntry, "session-worker", "--session-id", sessionId],
                { ...process.env, CBC_DAEMON: "0" },
              ),
            }
          : {}),
      });
      const health = await daemon.start();
      writePidFiles(paths.runtimeDir, health.daemonId);
      console.log(JSON.stringify({ ok: true, command: "start", health }, null, 2));
      await waitForSignal(async () => {
        await daemon.stop();
      });
      return 0;
    }
    case "stop": {
      const status = daemonStatus(runtimeDir);
      if (!status.running || status.record === undefined) {
        console.log(JSON.stringify({ ok: true, command: "stop", running: false }, null, 2));
        return 0;
      }
      try {
        process.kill(status.record.pid, "SIGTERM");
      } catch (error) {
        console.error(JSON.stringify({
          ok: false,
          command: "stop",
          error: error instanceof Error ? error.message : String(error),
        }));
        return 1;
      }
      console.log(JSON.stringify({
        ok: true,
        command: "stop",
        pid: status.record.pid,
      }, null, 2));
      return 0;
    }
    case "status": {
      const status = daemonStatus(runtimeDir);
      console.log(JSON.stringify({
        ok: true,
        command: "status",
        running: status.running,
        ...(status.record !== undefined ? { record: status.record } : {}),
        paths,
      }, null, 2));
      return 0;
    }
    case "logs": {
      const logPath = join(paths.runtimeDir, "daemon.log");
      if (!existsSync(logPath)) {
        console.log("");
        return 0;
      }
      const lines = Number(flagValue(argv, "--lines") ?? "100");
      const content = readFileSync(logPath, "utf8").split("\n");
      const slice = content.slice(Math.max(0, content.length - Math.max(1, lines)));
      console.log(slice.join("\n"));
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      console.log("Usage: capy-daemon [start|stop|status|logs] [--runtime-dir PATH]");
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      return 2;
  }
}

function waitForSignal(onStop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void onStop().finally(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function writePidFiles(runtimeDir: string, daemonId: string): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeDir, "daemon.pid"), String(process.pid) + "\n", { mode: 0o600 });
  appendFileSync(
    join(runtimeDir, "daemon.log"),
    `${new Date().toISOString()} started daemonId=${daemonId} pid=${String(process.pid)}\n`,
  );
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

if (import.meta.main) {
  main().then((code) => {
    // start waits on signals; other commands exit.
    if (code !== 0) process.exit(code);
  }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
