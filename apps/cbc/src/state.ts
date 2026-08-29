/**
 * Host-side persistent state — PRD §13.6, §18.6, §21.2, PERM-001.
 *
 * Three stores live here: layered configuration, the project trust record, and
 * the session index. Configuration is user-global and does not depend on workspace
 * trust; trust still gates executable workspace features such as LSP and Skills.
 */

import {
  defaultConfig,
  loadConfig,
  normalizeConfigPath,
  readPath,
  writePath,
  type CbcConfig,
  type ConfigIssue,
  type ConfigSource,
  type LoadConfigResult,
} from "@cbc/config-schema";
import type { TrustState } from "@cbc/permissions";

import { GLOBAL_CONFIG_TEMPLATE } from "./config-template.ts";
import { join, type Host } from "./host.ts";
import { resolvePaths, type CbcPaths } from "./host.ts";
import {
  projectTrustMatches,
  type ProjectTrustSnapshot,
} from "./project-trust.ts";

// ---------------------------------------------------------------------------
// §13.6 trust
// ---------------------------------------------------------------------------

/** One trust decision, keyed by canonical workspace path. */
export interface TrustRecord {
  readonly path: string;
  readonly state: Exclude<TrustState, "trusted-once">;
  readonly decidedAt: string;
  /**
   * §13.6: a trust record stores filesystem identity, not just the symlink path.
   * The Rust guard supplies this; it is recorded so a moved or replaced directory
   * does not silently inherit the decision.
   */
  readonly fingerprint?: string;
}

export interface TrustStore {
  readonly version: 1;
  readonly records: Record<string, TrustRecord>;
}

export function emptyTrustStore(): TrustStore {
  return { version: 1, records: {} };
}

export async function readTrustStore(host: Host, paths: CbcPaths): Promise<TrustStore> {
  const raw = await host.fs.read(paths.trustStore);
  if (raw === undefined) return emptyTrustStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyTrustStore();
    const store = parsed as { version?: unknown; records?: unknown };
    if (typeof store.records !== "object" || store.records === null) return emptyTrustStore();
    // The runtime is the trust authority (P0-01) and persists records in its own
    // shape (`{records: {canonical: {canonicalPath, filesystemId, state, ...}}}`,
    // no `version` key). Accept both shapes so the host and the runtime agree.
    if (store.version !== undefined && store.version !== 1) return emptyTrustStore();
    const records: Record<string, TrustRecord> = {};
    for (const [key, value] of Object.entries(store.records as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      const state = entry.state;
      if (
        state !== "trusted-always" &&
        state !== "read-only" &&
        state !== "untrusted"
      ) {
        continue;
      }
      const decidedAt = typeof entry.decidedAt === "string" ? entry.decidedAt : "";
      if (typeof entry.canonicalPath === "string") {
        // Runtime-format record.
        records[key] = {
          path: entry.canonicalPath,
          state,
          decidedAt,
          ...(typeof entry.filesystemId === "string" && entry.filesystemId.length > 0
            ? { fingerprint: entry.filesystemId }
            : {}),
        };
      } else if (typeof entry.path === "string") {
        records[key] = {
          path: entry.path,
          state,
          decidedAt,
          ...(typeof entry.fingerprint === "string" ? { fingerprint: entry.fingerprint } : {}),
        };
      }
    }
    return { version: 1, records };
  } catch {
    // A corrupt trust store must not be read as "everything is trusted". Failing
    // to an empty store means the user is asked again (§13.6, fail closed).
    return emptyTrustStore();
  }
}

export async function writeTrustStore(
  host: Host,
  paths: CbcPaths,
  store: TrustStore,
): Promise<void> {
  await host.fs.mkdirp(paths.data);
  // Persist in the runtime's shape (`canonicalPath`/`filesystemId` records, no
  // `version` wrapper) so the Rust trust authority reads exactly what the host
  // wrote — one store, one format (P0-01).
  const runtimeShape = {
    records: Object.fromEntries(
      Object.entries(store.records).map(([key, record]) => [
        key,
        {
          canonicalPath: record.path,
          filesystemId: record.fingerprint ?? "",
          state: record.state,
          decidedAt: record.decidedAt,
        },
      ]),
    ),
  };
  await host.fs.atomicWrite(paths.trustStore, `${JSON.stringify(runtimeShape, null, 2)}\n`);
}

/**
 * Look up the trust state for a workspace.
 *
 * An unknown workspace is `untrusted`, which is the whole point: §7.1's first-run
 * flow exists because a fresh directory has made no promises.
 */
export function trustStateFor(
  store: TrustStore,
  workspacePath: string,
  filesystemIdentity?: string,
): TrustState {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const byKey = store.records[trustKey(workspacePath)] ?? store.records[normalized];
  const record = byKey ?? Object.values(store.records).find(
    (candidate) => candidate.path.replace(/\\/g, "/").replace(/\/+$/, "") === normalized,
  );
  if (
    record === undefined ||
    filesystemIdentity === undefined ||
    filesystemIdentity.length === 0 ||
    record.fingerprint === undefined ||
    record.fingerprint.length === 0 ||
    record.fingerprint !== filesystemIdentity
  ) {
    return "untrusted";
  }
  return record.state;
}

export function trustKey(workspacePath: string): string {
  return workspacePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function withTrust(
  store: TrustStore,
  record: TrustRecord,
): TrustStore {
  return {
    version: 1,
    records: { ...store.records, [trustKey(record.path)]: record },
  };
}

export function withoutTrust(store: TrustStore, workspacePath: string): TrustStore {
  const records = { ...store.records };
  delete records[trustKey(workspacePath)];
  return { version: 1, records };
}

export interface ProjectControlTrustRecord {
  readonly path: string;
  readonly fingerprint: string;
  readonly decidedAt: string;
  readonly project: ProjectTrustSnapshot;
}

export interface ProjectControlTrustStore {
  readonly version: 2;
  readonly records: Readonly<Record<string, ProjectControlTrustRecord>>;
}

export function emptyProjectControlTrustStore(): ProjectControlTrustStore {
  return { version: 2, records: {} };
}

export async function readProjectControlTrustStore(
  host: Host,
  paths: CbcPaths,
): Promise<ProjectControlTrustStore> {
  const path = paths.projectTrustStore ?? join(paths.data, "project-trust.json");
  const raw = await host.fs.read(path);
  if (raw === undefined) return emptyProjectControlTrustStore();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return emptyProjectControlTrustStore();
    }
    const root = parsed as Record<string, unknown>;
    if (root.version !== 2 || typeof root.records !== "object" || root.records === null) {
      return emptyProjectControlTrustStore();
    }
    const records: Record<string, ProjectControlTrustRecord> = {};
    for (const [key, value] of Object.entries(root.records as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (
        typeof record.path !== "string"
        || typeof record.fingerprint !== "string"
        || typeof record.decidedAt !== "string"
        || !isProjectTrustSnapshot(record.project)
      ) {
        continue;
      }
      records[key] = {
        path: record.path,
        fingerprint: record.fingerprint,
        decidedAt: record.decidedAt,
        project: record.project,
      };
    }
    return { version: 2, records };
  } catch {
    return emptyProjectControlTrustStore();
  }
}

export async function writeProjectControlTrustStore(
  host: Host,
  paths: CbcPaths,
  store: ProjectControlTrustStore,
): Promise<void> {
  await host.fs.mkdirp(paths.data);
  await host.fs.atomicWrite(
    paths.projectTrustStore ?? join(paths.data, "project-trust.json"),
    JSON.stringify(store, null, 2) + "\n",
  );
}

export function withProjectControlTrust(
  store: ProjectControlTrustStore,
  record: ProjectControlTrustRecord,
): ProjectControlTrustStore {
  return {
    version: 2,
    records: { ...store.records, [trustKey(record.path)]: record },
  };
}

export function projectControlTrustMatches(
  store: ProjectControlTrustStore,
  workspacePath: string,
  filesystemIdentity: string | undefined,
  project: ProjectTrustSnapshot,
): boolean {
  if (!project.hasProjectControlFiles) return true;
  if (filesystemIdentity === undefined || filesystemIdentity.length === 0) return false;
  const record = store.records[trustKey(workspacePath)];
  return record !== undefined
    && record.fingerprint === filesystemIdentity
    && projectTrustMatches(record.project, project);
}

// ---------------------------------------------------------------------------
// §21.2 configuration
// ---------------------------------------------------------------------------

export interface LoadedConfig extends LoadConfigResult {
  readonly userConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectLocalConfigPath: string;
  readonly projectConfigApplied: boolean;
}

/**
 * Create the one global config file on first use without replacing an existing
 * file. `writeNew` gives the real host an exclusive create; small test hosts fall
 * back to a checked atomic write.
 */
export async function ensureGlobalConfig(host: Host): Promise<boolean> {
  const paths = resolvePaths(host);
  if (await host.fs.exists(paths.configFile)) return false;
  await host.fs.mkdirp(paths.config);
  if (host.fs.writeNew !== undefined) {
    return await host.fs.writeNew(paths.configFile, GLOBAL_CONFIG_TEMPLATE);
  }
  if (await host.fs.exists(paths.configFile)) return false;
  await host.fs.atomicWrite(paths.configFile, GLOBAL_CONFIG_TEMPLATE);
  return true;
}

/** Assemble the effective global configuration. */
export async function loadEffectiveConfig(
  host: Host,
  options: {
    readonly cliOverrides?: Record<string, unknown>;
    readonly sessionOverrides?: Record<string, unknown>;
    readonly projectTrusted?: boolean;
    readonly workspacePath?: string;
  } = {},
): Promise<LoadedConfig> {
  const paths = resolvePaths(host);
  await ensureGlobalConfig(host);
  const userToml = await host.fs.read(paths.configFile);
  const workspacePath = options.workspacePath ?? host.cwd;
  const projectConfigPath = join(workspacePath, ".capybara", "config.toml");
  const projectLocalConfigPath = join(workspacePath, ".capybara", "config.local.toml");
  const projectToml = await host.fs.read(projectConfigPath);
  const projectLocalToml = await host.fs.read(projectLocalConfigPath);

  const result = loadConfig({
    ...(userToml !== undefined ? { userToml } : {}),
    ...(projectToml !== undefined ? { projectToml } : {}),
    ...(projectLocalToml !== undefined ? { projectLocalToml } : {}),
    projectTrusted: options.projectTrusted === true,
    env: host.env,
    ...(options.cliOverrides !== undefined ? { cliOverrides: options.cliOverrides } : {}),
    ...(options.sessionOverrides !== undefined
      ? { sessionOverrides: options.sessionOverrides }
      : {}),
  });

  return {
    ...result,
    userConfigPath: paths.configFile,
    projectConfigPath,
    projectLocalConfigPath,
    projectConfigApplied:
      options.projectTrusted === true
      && (projectToml !== undefined || projectLocalToml !== undefined),
  };
}

function isProjectTrustSnapshot(value: unknown): value is ProjectTrustSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === "2.0"
    && typeof record.projectDigest === "string"
    && typeof record.configDigest === "string"
    && typeof record.packageManifestDigest === "string"
    && typeof record.packageLockDigest === "string"
    && typeof record.executableDigest === "string"
    && typeof record.capabilityDigest === "string"
    && Array.isArray(record.requestedCapabilities)
    && record.requestedCapabilities.every((entry) => typeof entry === "string")
    && typeof record.hasProjectControlFiles === "boolean";
}

/** Read one dotted config path from the effective config. */
export function configValue(config: CbcConfig, path: string): unknown {
  return readPath(config, normalizeConfigPath(path));
}

/**
 * Write one dotted path into the single global config file.
 *
 * Project configuration files are not part of the product's configuration model;
 * every persistent edit targets the resolved global user-config path.
 */
export interface UserConfigTransaction {
  readonly set?: Readonly<Record<string, unknown>>;
  readonly unset?: readonly string[];
}

export interface UserConfigTransactionResult {
  readonly written: boolean;
  readonly path: string;
  readonly issues: ConfigIssue[];
  readonly content?: string;
}

/**
 * Validate and persist a group of user config edits as one atomic transaction.
 * Every resulting semantic error blocks the write, including cross-field errors
 * whose path is different from the key being edited.
 */
export async function updateUserConfigTransaction(
  host: Host,
  transaction: UserConfigTransaction,
): Promise<UserConfigTransactionResult> {
  const paths = resolvePaths(host);
  await ensureGlobalConfig(host);
  const existing = await host.fs.read(paths.configFile);
  const before = (existing ?? "").replace(/\r\n/g, "\n");
  let lines = before.length === 0 ? [] : before.split("\n");
  for (const rawPath of transaction.unset ?? []) {
    lines = unsetTomlValue(lines, normalizeConfigPath(rawPath));
  }
  for (const [rawPath, value] of Object.entries(transaction.set ?? {})) {
    const canonicalPath = normalizeConfigPath(rawPath);
    // Exercise the same path safety guard used by the schema before editing text.
    writePath(defaultConfig(), canonicalPath, value);
    lines = upsertTomlValue(lines, canonicalPath, value);
  }
  const candidate = lines.length === 0 ? "" : `${lines.join("\n").replace(/\n+$/u, "")}\n`;
  const baseline = loadConfig({
    ...(before.length > 0 ? { userToml: before } : {}),
    env: {},
  });
  const baselineErrors = new Set(baseline.issues.filter((issue) => issue.severity === "error").map((issue) => issue.path + "|" + issue.source + "|" + issue.message));
  const merged = loadConfig({
    ...(candidate.length > 0 ? { userToml: candidate } : {}),
    env: {},
  });
  const newErrors = merged.issues.filter((issue) => issue.severity === "error" && !baselineErrors.has(issue.path + "|" + issue.source + "|" + issue.message));
  if (newErrors.length > 0) return { written: false, path: paths.configFile, issues: merged.issues };
  if (candidate === before) return { written: false, path: paths.configFile, issues: merged.issues, content: candidate };
  try {
    await host.fs.mkdirp(paths.config);
    await host.fs.atomicWrite(paths.configFile, candidate);
  } catch (error) {
    const issue: ConfigIssue = {
      severity: "error",
      path: "config",
      source: "user",
      message: `could not atomically write ${paths.configFile}: ${error instanceof Error ? error.message : String(error)}`,
    };
    return { written: false, path: paths.configFile, issues: [...merged.issues, issue], content: candidate };
  }
  return { written: true, path: paths.configFile, issues: merged.issues, content: candidate };
}

export async function setUserConfigValue(
  host: Host,
  path: string,
  value: string,
): Promise<{ issues: ConfigIssue[]; written: string }> {
  const result = await updateUserConfigTransaction(host, {
    set: { [normalizeConfigPath(path)]: coerceConfigValue(value) },
  });
  return { issues: result.issues, written: result.path };
}
/** Interpret a CLI string as a boolean, number, or string. */
export function coerceConfigValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Insert or replace a dotted key in a TOML document, preserving the rest.
 *
 * Rewriting the whole file from the parsed model would drop comments the user
 * wrote, so the existing text is edited in place. Only the flat `[section] key =`
 * shape §21.4 documents is handled; anything deeper is appended as a new section.
 */
export function upsertTomlValue(
  lines: readonly string[],
  dottedPath: string,
  value: unknown,
): string[] {
  const segments = dottedPath.split(".");
  const key = segments.pop() as string;
  const section = segments.join(".");
  const rendered = renderTomlValue(value);
  const snakeKey = toSnakeCase(key);

  const out = [...lines];

  let sectionStart = -1;
  let sectionEnd = out.length;
  if (section.length === 0) {
    sectionStart = -1;
    sectionEnd = out.findIndex((line) => /^\s*\[/.test(line));
    if (sectionEnd === -1) sectionEnd = out.length;
  } else {
    const header = `[${section}]`;
    sectionStart = out.findIndex((line) => line.trim() === header);
    if (sectionStart !== -1) {
      sectionEnd = out.length;
      for (let i = sectionStart + 1; i < out.length; i += 1) {
        if (/^\s*\[/.test(out[i] as string)) {
          sectionEnd = i;
          break;
        }
      }
    }
  }

  if (section.length > 0 && sectionStart === -1) {
    // A brand-new section goes at the end.
    if (out.length > 0 && (out.at(-1) ?? "").trim().length > 0) out.push("");
    out.push(`[${section}]`, `${snakeKey} = ${rendered}`);
    return out;
  }

  const searchFrom = sectionStart === -1 ? 0 : sectionStart + 1;
  const keyPattern = new RegExp(`^\\s*${escapeRegex(snakeKey)}\\s*=`);
  for (let i = searchFrom; i < sectionEnd; i += 1) {
    if (keyPattern.test(out[i] as string)) {
      out[i] = `${snakeKey} = ${rendered}`;
      return out;
    }
  }

  out.splice(sectionEnd, 0, `${snakeKey} = ${rendered}`);
  return out;
}

/** Remove one dotted key while preserving comments and surrounding sections. */
export function unsetTomlValue(lines: readonly string[], dottedPath: string): string[] {
  const segments = dottedPath.split(".");
  const key = segments.pop() as string;
  const section = segments.join(".");
  const snakeKey = toSnakeCase(key);
  const out = [...lines];
  let sectionStart = -1;
  let sectionEnd = out.length;
  if (section.length === 0) {
    sectionEnd = out.findIndex((line) => /^\s*\[/.test(line));
    if (sectionEnd === -1) sectionEnd = out.length;
  } else {
    const header = `[${section}]`;
    sectionStart = out.findIndex((line) => line.trim() === header);
    if (sectionStart === -1) return out;
    for (let i = sectionStart + 1; i < out.length; i += 1) {
      if (/^\s*\[/.test(out[i] as string)) {
        sectionEnd = i;
        break;
      }
    }
  }
  const from = sectionStart === -1 ? 0 : sectionStart + 1;
  const pattern = new RegExp(`^\\s*${escapeRegex(snakeKey)}\\s*=`);
  for (let i = sectionEnd - 1; i >= from; i -= 1) {
    if (pattern.test(out[i] as string)) out.splice(i, 1);
  }
  return out;
}
function renderTomlValue(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderTomlValue).join(", ")}]`;
  return JSON.stringify(String(value));
}

/** `softContextTokens` in code is `soft_context_tokens` in TOML (§21.4). */
export function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// §18.6 session index
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §18.6 legacy session index — read-only, for the one-shot migration (P0-05)
//
// The runtime's SQLite store is the single session authority now. These helpers
// exist only so bootstrap can import an old `<data>/sessions/index.json` into the
// store and then archive the file. New code must not read or write the index.
// ---------------------------------------------------------------------------

export interface SessionIndexEntry {
  readonly id: string;
  readonly workspacePath: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: "active" | "completed" | "interrupted" | "archived";
  readonly turnCount: number;
}

export interface SessionIndex {
  readonly version: 1;
  readonly sessions: SessionIndexEntry[];
}

export function sessionIndexPath(paths: CbcPaths): string {
  return join(paths.sessions, "index.json");
}

export async function readSessionIndex(host: Host, paths: CbcPaths): Promise<SessionIndex> {
  const raw = await host.fs.read(sessionIndexPath(paths));
  if (raw === undefined) return { version: 1, sessions: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { version: 1, sessions: [] };
    const index = parsed as Partial<SessionIndex>;
    if (!Array.isArray(index.sessions)) return { version: 1, sessions: [] };
    return { version: 1, sessions: index.sessions };
  } catch {
    return { version: 1, sessions: [] };
  }
}

export async function writeSessionIndex(
  host: Host,
  paths: CbcPaths,
  index: SessionIndex,
): Promise<void> {
  await host.fs.mkdirp(paths.sessions);
  await host.fs.write(sessionIndexPath(paths), `${JSON.stringify(index, null, 2)}\n`);
}

/** Generate a session id that sorts chronologically. */
export function newSessionId(nowMs: number, random = Math.random): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `ses_${stamp}_${suffix}`;
}

export type { CbcConfig, ConfigIssue, ConfigSource };
