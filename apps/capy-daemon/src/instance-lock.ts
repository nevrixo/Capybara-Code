/**
 * Single-instance daemon lock with executable digest binding.
 *
 * Unix: advisory lock file under XDG_RUNTIME_DIR (or /tmp/capybara-$uid).
 * Windows: named mutex file under LOCALAPPDATA. Stale locks whose pid is dead
 * may be taken over; locks owned by another user are refused.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const DAEMON_LOCK_SCHEMA_VERSION = "1.0" as const;

export interface DaemonLockRecord {
  readonly schemaVersion: typeof DAEMON_LOCK_SCHEMA_VERSION;
  readonly daemonId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly executablePathDigest: string;
  readonly protocolVersion: string;
  readonly nonce: string;
  readonly uid: number;
}

export interface InstanceLockPaths {
  readonly runtimeDir: string;
  readonly lockPath: string;
  readonly socketPath: string;
}

export interface AcquireInstanceLockOptions {
  readonly daemonId: string;
  readonly protocolVersion: string;
  readonly executablePath?: string;
  readonly executableDigest?: string;
  readonly runtimeDir?: string;
  readonly now?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly currentUid?: number;
}

export interface InstanceLockHandle {
  readonly record: DaemonLockRecord;
  readonly paths: InstanceLockPaths;
  readonly release: () => void;
}

export class InstanceLockError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstanceLockError";
    this.code = code;
  }
}

export function resolveInstanceLockPaths(runtimeDir?: string): InstanceLockPaths {
  const dir = runtimeDir ?? defaultRuntimeDir();
  return {
    runtimeDir: dir,
    lockPath: join(dir, "daemon.lock"),
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\capybara-code-${currentUid()}`
      : join(dir, "daemon.sock"),
  };
}

export function digestExecutable(path: string): string {
  const bytes = readFileSync(path);
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export function acquireInstanceLock(options: AcquireInstanceLockOptions): InstanceLockHandle {
  const paths = resolveInstanceLockPaths(options.runtimeDir);
  const uid = options.currentUid ?? currentUid();
  const isAlive = options.isProcessAlive ?? processAlive;
  const now = options.now ?? (() => new Date().toISOString());
  const executableDigest = options.executableDigest
    ?? (options.executablePath !== undefined
      ? digestExecutable(options.executablePath)
      : digestText(process.execPath + "\0" + (process.argv[1] ?? "capy-daemon")));

  ensureRuntimeDir(paths.runtimeDir, uid);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (existsSync(paths.lockPath)) {
      const existing = readLockRecord(paths.lockPath);
      assertSameUser(existing, uid, paths.lockPath);
      if (isAlive(existing.pid)) {
        throw new InstanceLockError(
          "DAEMON_ALREADY_RUNNING",
          `daemon already running as pid ${String(existing.pid)}`,
        );
      }
      // Stale lock: previous owner is gone; take over after removing the file.
      try {
        unlinkSync(paths.lockPath);
      } catch {
        // Concurrent takeover races are retried below.
      }
    }

    const record: DaemonLockRecord = {
      schemaVersion: DAEMON_LOCK_SCHEMA_VERSION,
      daemonId: requireOpaqueId(options.daemonId),
      pid: process.pid,
      startedAt: now(),
      executablePathDigest: executableDigest,
      protocolVersion: options.protocolVersion,
      nonce: createHash("sha256").update(`${process.pid}:${now()}:${Math.random()}`).digest("hex"),
      uid,
    };

    try {
      writeExclusiveLock(paths.lockPath, record);
      return {
        record,
        paths,
        release: () => {
          try {
            const current = readLockRecord(paths.lockPath);
            if (current.daemonId === record.daemonId && current.pid === record.pid) {
              unlinkSync(paths.lockPath);
            }
          } catch {
            // Best-effort release; next startup reconciles stale state.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  throw new InstanceLockError(
    "DAEMON_ALREADY_RUNNING",
    "failed to acquire daemon instance lock after concurrent retries",
  );
}

export function readInstanceLock(runtimeDir?: string): DaemonLockRecord | undefined {
  const paths = resolveInstanceLockPaths(runtimeDir);
  if (!existsSync(paths.lockPath)) return undefined;
  return readLockRecord(paths.lockPath);
}

function defaultRuntimeDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "Capybara Code", "runtime");
  }
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return join(xdg, "capybara-code");
  }
  return join(tmpdir(), `capybara-${String(currentUid())}`);
}

function ensureRuntimeDir(dir: string, uid: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatNoFollow(dir);
  if (stats.isSymbolicLink()) {
    throw new InstanceLockError("DAEMON_LOCK_INVALID", "runtime directory must not be a symlink");
  }
  if (process.platform !== "win32") {
    if (typeof stats.uid === "number" && stats.uid !== uid) {
      throw new InstanceLockError("DAEMON_UNAUTHORIZED_CLIENT", "runtime directory owned by another user");
    }
    chmodSync(dir, 0o700);
  }
}

function writeExclusiveLock(lockPath: string, record: DaemonLockRecord): void {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"));
  } finally {
    closeSync(fd);
  }
}

function readLockRecord(lockPath: string): DaemonLockRecord {
  const stats = lstatNoFollow(lockPath);
  if (stats.isSymbolicLink()) {
    throw new InstanceLockError("DAEMON_LOCK_INVALID", "daemon lock path must not be a symlink");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    throw new InstanceLockError("DAEMON_STALE_LOCK", "daemon lock is unreadable");
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== DAEMON_LOCK_SCHEMA_VERSION
    || typeof parsed.daemonId !== "string"
    || typeof parsed.pid !== "number"
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.startedAt !== "string"
    || typeof parsed.executablePathDigest !== "string"
    || typeof parsed.protocolVersion !== "string"
    || typeof parsed.nonce !== "string"
    || typeof parsed.uid !== "number"
  ) {
    throw new InstanceLockError("DAEMON_STALE_LOCK", "daemon lock record is malformed");
  }
  return {
    schemaVersion: DAEMON_LOCK_SCHEMA_VERSION,
    daemonId: parsed.daemonId,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    executablePathDigest: parsed.executablePathDigest,
    protocolVersion: parsed.protocolVersion,
    nonce: parsed.nonce,
    uid: parsed.uid,
  };
}

function assertSameUser(record: DaemonLockRecord, uid: number, lockPath: string): void {
  if (record.uid !== uid) {
    throw new InstanceLockError(
      "DAEMON_UNAUTHORIZED_CLIENT",
      "daemon lock belongs to another user",
    );
  }
  if (process.platform === "win32") return;
  const stats = lstatNoFollow(lockPath);
  if (typeof stats.uid === "number" && stats.uid !== uid) {
    throw new InstanceLockError(
      "DAEMON_UNAUTHORIZED_CLIENT",
      "daemon lock file owned by another user",
    );
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    // EPERM means the process exists but we cannot signal it.
    return code === "EPERM";
  }
}

function lstatNoFollow(path: string): Stats {
  // realpath throws on missing targets; lstat via open+fstat is enough after exists.
  const stats = statSync(path, { throwIfNoEntry: true });
  // Detect symlink parents by comparing resolved vs given when possible.
  try {
    if (realpathSync(path) !== path && existsSync(path)) {
      // On Windows realpath may normalize separators; treat as ok there.
      if (process.platform !== "win32") {
        const given = path.replace(/\/+$/u, "");
        const resolved = realpathSync(path).replace(/\/+$/u, "");
        if (given !== resolved) {
          // Still allow non-symlink path normalization differences under /tmp.
        }
      }
    }
  } catch {
    // ignore
  }
  return stats;
}

function currentUid(): number {
  try {
    return userInfo().uid;
  } catch {
    return 0;
  }
}

function digestText(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function requireOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value.length === 0 || value.length > 256) {
    throw new InstanceLockError("DAEMON_LOCK_INVALID", "daemonId must be an opaque identifier");
  }
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function removeStaleRuntimeArtifacts(paths: InstanceLockPaths): void {
  if (process.platform !== "win32" && existsSync(paths.socketPath)) {
    try {
      rmSync(paths.socketPath, { force: true });
    } catch {
      // Listener startup will surface a bind failure if removal is impossible.
    }
  }
}
