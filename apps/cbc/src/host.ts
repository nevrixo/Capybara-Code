/**
 * Host environment — PRD §19.2, §21.1, §22.1.
 *
 * Every command takes a `Host` rather than reaching for `process` or `Bun`
 * directly. Two reasons, both practical: §25.9's PTY tests and the CLI unit tests
 * need to drive stdin, stdout, and the filesystem without a real terminal, and
 * §19.2 requires the runtime binary to be launched from a *verified absolute path*
 * — which is far easier to guarantee when path resolution is one injectable seam.
 */

import { createHash } from "node:crypto";

import type { ExitCode } from "./exit.ts";
import type { KeyStream } from "./keys.ts";

export interface HostIo {
  /** Returns false when the underlying stream applies backpressure. */
  stdout(text: string): boolean | number | void;
  stderr(text: string): void;
  /** Read all of stdin for credential import and other host-owned input flows. */
  readStdin(): Promise<string>;
  /** Stream newline-delimited protocol input without buffering the whole process lifetime. */
  readLines?(): AsyncIterable<string>;
  /** Prompt for a line. `masked` is required for a credential (§7.2, §9.3). */
  prompt(question: string, options?: { masked?: boolean }): Promise<string>;
  /** Present a choice list, returning the selected index or -1 for cancel. */
  select(question: string, choices: readonly string[]): Promise<number>;
  /**
   * A key-level reader for the interactive composer (§6.14, §7.7).
   *
   * Separate from `prompt` because the two answer different questions. `prompt`
   * reads one line and returns it; this keeps raw mode open for the whole session so
   * `Esc` reaches the agent *while a turn is running*. Absent on a host that has no
   * terminal, which is why callers check for it rather than assuming it.
  */
  keyStream?(): KeyStream;
  /** Copy user-selected text through the host OS clipboard when available. */
  copyToClipboard?(text: string): Promise<boolean>;
  readonly isTty: boolean;
  readonly columns: number;
  readonly rows: number;
}

export interface HostReadPrefixResult {
  readonly content: string;
  /** True when bytes remained after the returned prefix. */
  readonly truncated: boolean;
}

export interface HostFs {
  read(path: string): Promise<string | undefined>;
  /** Optional bounded read used for metadata-only startup discovery. */
  readPrefix?(path: string, maxBytes: number): Promise<HostReadPrefixResult | undefined>;
  /** Optional binary write used for user-facing generated media. */
  writeBytes?(path: string, content: Uint8Array): Promise<void>;
  write(path: string, content: string): Promise<void>;
  /** Create a new file without replacing an existing one. */
  writeNew?(path: string, content: string): Promise<boolean>;
  /** Durable same-directory temp write followed by an atomic rename. */
  atomicWrite(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Directory entries, names only. Returns `[]` when the directory is absent. */
  list(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Whether the path is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /** Resolve symlinks/junctions for deterministic discovery and containment. */
  realpath?(path: string): Promise<string | undefined>;
  /**
   * Filesystem identity of a directory, mirroring the Rust trust store's
   * `filesystem_id` (§13.6): `"<dev>:<ino>"` on Unix, `undefined` elsewhere or
   * when the path cannot be stat'd. Optional so test hosts may omit it;
   * callers fall back to path-only identity, exactly like the trust store.
   */
  statIdentity?(path: string): Promise<string | undefined>;
}

export interface Host {
  readonly io: HostIo;
  readonly fs: HostFs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly homeDir: string;
  readonly platform: string;
  readonly version: string;
  /** Directory holding the running executable, for §19.2's `libexec` lookup. */
  readonly executableDir: string;
  now(): number;
  exit(code: ExitCode): never;
}

// ---------------------------------------------------------------------------
// §21.1 paths
// ---------------------------------------------------------------------------

export interface CbcPaths {
  readonly config: string;
  readonly configFile: string;
  readonly data: string;
  readonly cache: string;
  readonly logs: string;
  /** Bundled Skills, schemas, and the model registry (§19.2). */
  readonly share: string;
  /** The `cbc-runtime` sidecar (§19.2). */
  readonly runtimeBinary: string;
  readonly sessions: string;
  readonly artifacts: string;
  readonly agents: string;
  readonly skills: string;
  readonly trustStore: string;
  /** Host-local project-control digest overlay; it can only narrow runtime trust. */
  readonly projectTrustStore?: string;
  readonly approvalStore: string;
}

/**
 * Resolve the §21.1 paths.
 *
 * §21.1 gives Unix-like defaults and says Windows uses "a platform-appropriate
 * local application data directory". The environment overrides are honoured first
 * because §21.1 lists them, and because a test needs somewhere disposable to write.
 */
export function resolvePaths(host: Pick<Host, "env" | "homeDir" | "platform" | "executableDir">): CbcPaths {
  const env = host.env;
  const home = host.homeDir;
  const windows = host.platform === "win32";

  const capybaraHome = env.CAPYBARA_HOME;
  const configFileOverride = env.CAPYBARA_CONFIG !== undefined && env.CAPYBARA_CONFIG.trim().length > 0
    ? env.CAPYBARA_CONFIG
    : undefined;

  const configRoot =
    configFileOverride !== undefined
      ? parentOf(configFileOverride)
      : capybaraHome !== undefined
      ? join(capybaraHome, "config")
      : windows
        ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "capybara")
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "capybara");

  const dataRoot =
    env.CAPYBARA_DATA_DIR ??
    (capybaraHome !== undefined
      ? join(capybaraHome, "data")
      : windows
        ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "capybara", "data")
        : join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "capybara"));

  const cacheRoot =
    env.CAPYBARA_CACHE_DIR ??
    (capybaraHome !== undefined
      ? join(capybaraHome, "cache")
      : windows
        ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "capybara", "cache")
        : join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "capybara"));

  const logRoot =
    env.CAPYBARA_LOG_DIR ??
    (capybaraHome !== undefined
      ? join(capybaraHome, "logs")
      : windows
        ? join(cacheRoot, "logs")
        : join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "capybara", "logs"));

  // §19.2: `bin/cbc` and `libexec/cbc-runtime` are siblings inside the release
  // archive, so the sidecar is found relative to this executable and never through
  // PATH.
  const share = join(parentOf(host.executableDir), "share", "capybara");
  const runtimeBinary = join(
    parentOf(host.executableDir),
    "libexec",
    windows ? "cbc-runtime.exe" : "cbc-runtime",
  );

  return {
    config: configRoot,
    configFile: configFileOverride ?? join(configRoot, "config.toml"),
    data: dataRoot,
    cache: cacheRoot,
    logs: logRoot,
    share,
    runtimeBinary,
    sessions: join(dataRoot, "sessions"),
    artifacts: join(dataRoot, "artifacts"),
    agents: join(configRoot, "agents"),
    skills: join(configRoot, "skills"),
    trustStore: join(dataRoot, "trust.json"),
    projectTrustStore: join(dataRoot, "project-trust.json"),
    approvalStore: join(dataRoot, "approvals.json"),
  };
}

/**
 * Candidate locations for the runtime binary, in preference order.
 *
 * The packaged layout comes first. A development checkout is checked next so `bun
 * run apps/cbc/src/main.ts` works against `cargo build` output — without that,
 * nothing could be exercised end to end before a release is cut.
 *
 * §19.2's rule holds throughout: every candidate is an absolute path derived from a
 * known location, and `PATH` is never searched.
 */
export function runtimeBinaryCandidates(
  host: Pick<Host, "env" | "homeDir" | "platform" | "executableDir" | "cwd">,
): string[] {
  const windows = host.platform === "win32";
  const name = windows ? "cbc-runtime.exe" : "cbc-runtime";
  const candidates: string[] = [];

  const override = host.env.CBC_RUNTIME_BINARY;
  if (override !== undefined && override.length > 0) candidates.push(override);

  candidates.push(resolvePaths(host).runtimeBinary);
  // A release archive invoked in place, where `bin/` sits beside `libexec/`.
  candidates.push(join(host.executableDir, name));

  // Development checkout root derived from module location. Prefer debug:
  // `cargo build` and `cargo test` refresh it, while an older release artifact
  // may still be present from packaging. Selecting that stale release can pair
  // the current TypeScript host with a runtime that does not implement the same
  // tool surface.
  try {
    const projectRoot = new URL("../../..", import.meta.url).pathname
      .replace(/^\/([A-Za-z]:)/, "$1")
      .replace(/\/+$/, "");
    candidates.push(join(projectRoot, "target", "debug", name));
    candidates.push(join(projectRoot, "target", "release", name));
  } catch {}

  // Honor CARGO_TARGET_DIR so a WSL Linux build can keep artifacts off /mnt/c
  // without colliding with a Windows `target/` next to the same checkout.
  const cargoTarget = host.env.CARGO_TARGET_DIR;
  if (cargoTarget !== undefined && cargoTarget.length > 0) {
    candidates.push(join(cargoTarget, "debug", name));
    candidates.push(join(cargoTarget, "release", name));
  }

  // Development: `cargo build` and `cargo build --release` output.
  candidates.push(join(host.cwd, "target", "debug", name));
  candidates.push(join(host.cwd, "target", "release", name));

  return dedupe(candidates);
}

/**
 * Locate the runtime binary, or explain why it is missing.
 *
 * §19.7 requires the runtime version and protocol to be verified at startup; this
 * is the step before that, and failing here with a clear message is better than a
 * spawn error deep inside the client.
 */
export async function findRuntimeBinary(
  host: Pick<Host, "env" | "homeDir" | "platform" | "executableDir" | "cwd" | "fs">,
): Promise<{ path: string } | { missing: string[] }> {
  const candidates = runtimeBinaryCandidates(host);
  for (const candidate of candidates) {
    if (await host.fs.exists(candidate)) return { path: candidate };
  }
  return { missing: candidates };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Join path segments.
 *
 * Deliberately small and separator-normalizing rather than importing `node:path`:
 * every path CBC stores or compares is forward-slash normalized so a trust record
 * or session key written on one platform still matches on another.
 */
export function join(...parts: readonly string[]): string {
  const cleaned = parts
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part.replace(/[/\\]+$/, "") : part.replace(/^[/\\]+|[/\\]+$/g, "")));
  return cleaned.join("/").replace(/\\/g, "/");
}

export function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return normalized;
  return normalized.slice(0, slash);
}

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/** Expand a leading `~` against the home directory. */
export function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homeDir, path.slice(2));
  }
  return path;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Canonical SHA-256 identity digest. The historical export name is retained for
 * source compatibility; callers now receive a collision-resistant 64-hex digest.
 */
export function fnv1aHex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A stable identifier for a workspace path.
 *
 * Used as the session directory name (§18.6) and the trust record key (§13.6).
 * §13.6 also requires filesystem identity rather than the symlink path alone; the
 * Rust guard supplies that, and this is the display-and-lookup key.
 */
export function workspaceHash(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return fnv1aHex(normalized);
}

/**
 * The identity a persisted "always allow" rule is bound to (P0-01).
 *
 * A rule that does not name the workspace that earned it applies to every
 * workspace the user ever trusts — which is what the v1 store did. The
 * canonical path plus the filesystem identity plus a digest of both makes the
 * grant local to the repository the user actually approved.
 */
export interface WorkspaceIdentity {
  readonly canonicalPath: string;
  /** `dev:ino` on Unix, empty elsewhere; mirrors the Rust trust store. */
  readonly filesystemId: string;
  readonly workspaceDigest: string;
}

export async function workspaceIdentityFor(
  host: Pick<Host, "fs">,
  workspacePath: string,
): Promise<WorkspaceIdentity> {
  const canonicalPath = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  let filesystemId = "";
  try {
    filesystemId = (await host.fs.statIdentity?.(canonicalPath)) ?? "";
  } catch {
    filesystemId = "";
  }
  return {
    canonicalPath,
    filesystemId,
    workspaceDigest: fnv1aHex(`${canonicalPath}\u0000${filesystemId}`),
  };
}

/**
 * Whether a persisted workspace identity still names the same workspace.
 *
 * Mirrors the trust store's `matches`: when either side lacks a filesystem
 * identity the path alone decides, but an identity mismatch never upgrades to
 * a match.
 */
export function workspaceIdentityMatches(
  stored: { readonly canonicalPath?: string; readonly filesystemId?: string; readonly workspaceDigest?: string },
  current: WorkspaceIdentity,
): boolean {
  if (typeof stored.workspaceDigest === "string" && stored.workspaceDigest.length > 0) {
    return stored.workspaceDigest === current.workspaceDigest;
  }
  const storedPath = (stored.canonicalPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (storedPath.length === 0) return false;
  const samePath =
    storedPath === current.canonicalPath ||
    storedPath.toLowerCase() === current.canonicalPath.toLowerCase();
  if (!samePath) return false;
  const storedFs = stored.filesystemId ?? "";
  if (storedFs.length === 0 || current.filesystemId.length === 0) return true;
  return storedFs === current.filesystemId;
}
