/** Deterministic, bounded Agent Skills discovery for session bootstrap and reload. */

import { createHash } from "node:crypto";

import type { SkillsConfig } from "@cbc/config-schema";
import {
  MAX_SKILL_CATALOG_BYTES,
  MAX_SKILL_BYTES,
  builtinSkillFilesExcept,
  frontmatterOnly,
  type RegisterResult,
  type SkillDefinition,
  type SkillDuplicateRecord,
  type SkillFile,
  type SkillLoadIssue,
  type SkillOrigin,
  type SkillPrecedence,
  type SkillScope,
  type SkillShadowRecord,
  type SkillSource,
} from "@cbc/skills";

import { expandHome, join, parentOf, type Host } from "./host.ts";

export interface SkillRoot {
  readonly id: string;
  readonly scope: SkillScope;
  readonly origin: SkillOrigin;
  readonly source: SkillSource;
  readonly directory: string;
  readonly canonicalDirectory?: string;
  readonly projectDistance?: number;
  readonly explicitOrder: number;
  readonly precedence: SkillPrecedence;
  readonly recursive: true;
  readonly legacy?: boolean;
}

export interface SkillRootDiagnostic extends SkillRoot {
  readonly status: "scanned" | "missing" | "not-directory" | "escaped" | "failed";
  readonly candidates: number;
  readonly message?: string;
}

export interface SkillDiscoveryDiagnostic {
  readonly path: string;
  readonly rootId?: string;
  readonly field: string;
  readonly message: string;
  readonly line?: number;
  readonly severity: "error" | "warning";
}

export interface SkillDiscoverySnapshot {
  /** False when an incomplete reload retained the prior active catalog. */
  readonly applied: boolean;
  readonly revision: number;
  readonly generatedAt: string;
  readonly durationMs: number;
  readonly cwd: string;
  readonly worktreeRoot?: string;
  readonly roots: readonly SkillRootDiagnostic[];
  readonly accepted: readonly SkillDefinition[];
  readonly diagnostics: readonly SkillDiscoveryDiagnostic[];
  readonly rejected: readonly SkillDiscoveryDiagnostic[];
  readonly shadowed: readonly SkillShadowRecord[];
  readonly deduplicated: readonly SkillDuplicateRecord[];
  readonly invalidated: readonly string[];
  readonly digest: string;
}

export interface SkillDiscoveryInput {
  readonly cwd: string;
  readonly workspacePath: string;
  /** resolvePaths(host).skills: the only native global source of truth. */
  readonly nativeSkillsPath: string;
  readonly config: SkillsConfig;
}

export interface SkillDiscoveryServiceOptions {
  readonly host: Host;
  /** Applies one complete file set through SkillRegistry.prepare + replace. */
  readonly replace: (files: readonly SkillFile[]) => RegisterResult;
}

interface ScanResult {
  readonly files: SkillFile[];
  readonly roots: SkillRootDiagnostic[];
  readonly diagnostics: SkillDiscoveryDiagnostic[];
  readonly complete: boolean;
}

interface ScanLimits {
  readonly maxDepth: number;
  readonly maxCandidates: number;
  readonly scanTimeoutMs: number;
  readonly worktreeRoot?: string;
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "target", ".cache"]);
const SCAN_CONCURRENCY = 16;
const ORIGIN_RANK: Readonly<Record<SkillOrigin, number>> = {
  explicit: 0,
  capybara: 1,
  opencode: 2,
  agents: 3,
  claude: 4,
  legacy: 5,
  bundled: 9,
};

export class SkillDiscoveryService {
  readonly #host: Host;
  readonly #replace: (files: readonly SkillFile[]) => RegisterResult;
  #last: SkillDiscoverySnapshot | undefined;

  constructor(options: SkillDiscoveryServiceOptions) {
    this.#host = options.host;
    this.#replace = options.replace;
  }

  async discover(input: SkillDiscoveryInput): Promise<SkillDiscoverySnapshot> {
    return await this.#scanAndReplace(input, false);
  }

  async reload(input: SkillDiscoveryInput): Promise<SkillDiscoverySnapshot> {
    return await this.#scanAndReplace(input, true);
  }

  lastSnapshot(): SkillDiscoverySnapshot | undefined {
    return this.#last;
  }

  async #scanAndReplace(input: SkillDiscoveryInput, retainOnIncomplete: boolean): Promise<SkillDiscoverySnapshot> {
    const startedAt = this.#host.now();
    const cwd = await canonicalPath(this.#host, input.cwd);
    const worktreeRoot = await findWorktreeRoot(this.#host, cwd);
    const roots = input.config.enabled
      ? await skillRoots(this.#host, input, cwd, worktreeRoot)
      : [];
    const scan = await scanSkillRoots(this.#host, roots, {
      maxDepth: input.config.maxDepth,
      maxCandidates: input.config.maxCandidates,
      scanTimeoutMs: input.config.scanTimeoutMs,
      ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    });

    if (retainOnIncomplete && !scan.complete && this.#last !== undefined) {
      const retained = this.#last;
      const diagnostics = [...scan.diagnostics, {
        path: cwd,
        field: "reload",
        message: `incomplete Skill scan; retained active catalog revision ${retained.revision}`,
        severity: "error" as const,
      }].sort(compareDiagnostics);
      const snapshot: SkillDiscoverySnapshot = {
        applied: false,
        revision: retained.revision,
        generatedAt: new Date(this.#host.now()).toISOString(),
        durationMs: Math.max(0, this.#host.now() - startedAt),
        cwd,
        ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
        roots: scan.roots,
        accepted: retained.accepted,
        diagnostics,
        rejected: diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        shadowed: retained.shadowed,
        deduplicated: retained.deduplicated,
        invalidated: [],
        digest: retained.digest,
      };
      this.#last = snapshot;
      return snapshot;
    }

    const bundled = input.config.enabled && input.config.builtin.enabled
      ? builtinSkillFilesExcept(input.config.builtin.disabled).map(withBuiltinPrecedence)
      : [];
    // Registry replacement happens only after every root has produced a complete
    // candidate set, so a failed reload leaves the previous catalog untouched.
    const replaced = this.#replace([...bundled, ...scan.files]);
    const registryDiagnostics = replaced.issues.map(loadIssueDiagnostic);
    const diagnostics = [...scan.diagnostics, ...registryDiagnostics].sort(compareDiagnostics);
    const generatedAt = new Date(this.#host.now()).toISOString();
    const snapshot: SkillDiscoverySnapshot = {
      applied: true,
      revision: replaced.revision,
      generatedAt,
      durationMs: Math.max(0, this.#host.now() - startedAt),
      cwd,
      ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
      roots: scan.roots,
      accepted: replaced.registered,
      diagnostics,
      rejected: diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      shadowed: replaced.shadowRecords,
      deduplicated: replaced.deduplicated,
      invalidated: replaced.invalidated,
      digest: discoveryDigest(replaced.registered),
    };
    this.#last = snapshot;
    return snapshot;
  }
}

/**
 * Resolve project, user, compatibility, migration, and explicit roots.
 * Roots are canonicalized, precedence-sorted, and then capped.
 */
export async function skillRoots(
  host: Host,
  input: SkillDiscoveryInput,
  canonicalCwd = normalizePath(input.cwd),
  knownWorktreeRoot?: string,
): Promise<SkillRoot[]> {
  const worktreeRoot = knownWorktreeRoot ?? await findWorktreeRoot(host, canonicalCwd);
  const canonicalWorkspace = await canonicalPath(host, input.workspacePath);
  const projectDirectories = worktreeRoot !== undefined
    ? pathChain(canonicalCwd, worktreeRoot)
    : isWithin(canonicalCwd, canonicalWorkspace, host.platform)
      ? pathChain(canonicalCwd, canonicalWorkspace)
      : [canonicalCwd];

  const pending: Array<Omit<SkillRoot, "canonicalDirectory" | "precedence">> = [];
  let id = 0;
  const add = (root: Omit<SkillRoot, "id" | "canonicalDirectory" | "precedence" | "recursive">): void => {
    pending.push({ ...root, id: `skill-root-${++id}`, recursive: true });
  };

  for (const [distance, directory] of projectDirectories.entries()) {
    add(projectRoot(directory, ".capybara/skills", "capybara", distance));
    if (input.config.compatOpencode) {
      add(projectRoot(directory, ".opencode/skills", "opencode", distance));
      if (input.config.legacyPaths) {
        add({ ...projectRoot(directory, ".opencode/skill", "legacy", distance), legacy: true });
      }
    }
    if (input.config.compatAgents) add(projectRoot(directory, ".agents/skills", "agents", distance));
    if (input.config.compatClaude) add(projectRoot(directory, ".claude/skills", "claude", distance));
  }

  const xdgConfig = host.env.XDG_CONFIG_HOME ?? join(host.homeDir, ".config");
  add(userRoot(input.nativeSkillsPath, "capybara"));
  if (input.config.compatOpencode) {
    add(userRoot(join(xdgConfig, "opencode/skills"), "opencode"));
    if (input.config.legacyPaths) {
      add({ ...userRoot(join(xdgConfig, "opencode/skill"), "legacy"), legacy: true });
    }
  }
  if (input.config.compatAgents) add(userRoot(join(host.homeDir, ".agents/skills"), "agents"));
  if (input.config.compatClaude) add(userRoot(join(host.homeDir, ".claude/skills"), "claude"));
  if (input.config.legacyPaths) {
    add({ ...userRoot(join(xdgConfig, "capybara-code/skills"), "legacy"), legacy: true });
  }

  for (const [explicitOrder, configured] of input.config.paths.entries()) {
    const expanded = expandHome(configured, host.homeDir);
    const directory = isAbsolutePath(expanded) ? expanded : join(input.workspacePath, expanded);
    const canonical = await canonicalPath(host, directory);
    const project = worktreeRoot !== undefined && isWithin(canonical, worktreeRoot, host.platform);
    add({
      scope: project ? "project" : "user",
      origin: "explicit",
      source: project ? "project" : "user",
      directory: normalizePath(directory),
      ...(project ? { projectDistance: 0 } : {}),
      explicitOrder,
    });
  }

  const resolved: SkillRoot[] = [];
  for (const root of pending) {
    const canonicalDirectory = await canonicalPath(host, root.directory);
    resolved.push({
      ...root,
      canonicalDirectory,
      precedence: precedenceFor(root.scope, root.origin, root.projectDistance, root.explicitOrder, canonicalDirectory),
    });
  }
  resolved.sort(compareRoots);

  // Keep canonical root aliases in the scan. The registry collapses their files
  // and records the duplicate paths for `/skills doctor` instead of hiding why a
  // .claude → .agents symlink produced one catalog entry.
  return resolved.slice(0, input.config.maxRoots);
}

/** Compatibility API used by embedders and existing tests. */
export async function discoverSkillFiles(
  host: Host,
  roots: ReadonlyArray<SkillRoot | { source: SkillSource; directory: string }>,
  options: {
    workspaceTrusted?: boolean;
    maxDepth?: number;
    maxCandidates?: number;
    scanTimeoutMs?: number;
    worktreeRoot?: string;
  } = {},
): Promise<SkillFile[]> {
  const normalized: SkillRoot[] = [];
  for (const [index, candidate] of roots.entries()) {
    if ("precedence" in candidate) {
      normalized.push(candidate);
      continue;
    }
    const scope = scopeForSource(candidate.source);
    const origin = originForSource(candidate.source);
    const directory = normalizePath(candidate.directory);
    const canonicalDirectory = await canonicalPath(host, directory);
    normalized.push({
      id: `legacy-root-${index + 1}`,
      source: candidate.source,
      scope,
      origin,
      directory,
      canonicalDirectory,
      ...(scope === "project" ? { projectDistance: 0 } : {}),
      explicitOrder: index,
      precedence: precedenceFor(scope, origin, scope === "project" ? 0 : undefined, index, canonicalDirectory),
      recursive: true,
    });
  }
  const scanned = await scanSkillRoots(host, normalized, {
    maxDepth: options.maxDepth ?? 8,
    maxCandidates: options.maxCandidates ?? 512,
    scanTimeoutMs: options.scanTimeoutMs ?? 1_500,
    ...(options.worktreeRoot !== undefined ? { worktreeRoot: options.worktreeRoot } : {}),
  });
  return scanned.files;
}

async function scanSkillRoots(
  host: Host,
  roots: readonly SkillRoot[],
  limits: ScanLimits,
): Promise<ScanResult> {
  const files: SkillFile[] = [];
  const rootDiagnostics: SkillRootDiagnostic[] = [];
  const diagnostics: SkillDiscoveryDiagnostic[] = [];
  const startedAt = host.now();
  let exhausted = false;
  let complete = true;
  let candidateCount = 0;

  for (const root of roots) {
    let rootCandidates = 0;
    const canonicalDirectory = root.canonicalDirectory ?? await canonicalPath(host, root.directory);
    const isDirectory = await host.fs.isDirectory(root.directory).catch(() => false);
    if (!isDirectory) {
      const exists = await host.fs.exists(root.directory).catch(() => false);
      rootDiagnostics.push({
        ...root,
        canonicalDirectory,
        status: exists ? "not-directory" : "missing",
        candidates: 0,
      });
      continue;
    }
    if (
      root.scope === "project" &&
      limits.worktreeRoot !== undefined &&
      !isWithin(canonicalDirectory, limits.worktreeRoot, host.platform)
    ) {
      const message = "project Skill root resolves outside the worktree";
      rootDiagnostics.push({ ...root, canonicalDirectory, status: "escaped", candidates: 0, message });
      diagnostics.push({
        path: root.directory,
        rootId: root.id,
        field: "path",
        message,
        severity: "error",
      });
      continue;
    }

    const seenDirectories = new Set<string>();
    try {
      await walkDirectory(root.directory, canonicalDirectory, 0, root, seenDirectories);
      rootDiagnostics.push({
        ...root,
        canonicalDirectory,
        status: "scanned",
        candidates: rootCandidates,
        ...(root.legacy === true && rootCandidates > 0
          ? { message: "legacy path; migrate this Skill root" }
          : {}),
      });
      if (root.legacy === true && rootCandidates > 0) {
        diagnostics.push({
          path: root.directory,
          rootId: root.id,
          field: "path",
          message: "legacy Skill path detected; move these Skills to the native or non-legacy root",
          severity: "warning",
        });
      }
    } catch (error) {
      complete = false;
      const message = describe(error);
      rootDiagnostics.push({ ...root, canonicalDirectory, status: "failed", candidates: rootCandidates, message });
      diagnostics.push({ path: root.directory, rootId: root.id, field: "scan", message, severity: "error" });
    }
    if (exhausted) break;

    async function walkDirectory(
      rawDirectory: string,
      canonicalRoot: string,
      depth: number,
      activeRoot: SkillRoot,
      seen: Set<string>,
    ): Promise<void> {
      if (exhausted) return;
      if (host.now() - startedAt > limits.scanTimeoutMs) {
        exhausted = true;
        complete = false;
        diagnostics.push({
          path: rawDirectory,
          rootId: activeRoot.id,
          field: "scan",
          message: `Skill discovery exceeded the ${limits.scanTimeoutMs} ms scan budget`,
          severity: "error",
        });
        return;
      }

      const canonicalDirectory = await canonicalPath(host, rawDirectory);
      const directoryKey = pathKey(canonicalDirectory, host.platform);
      if (seen.has(directoryKey)) {
        diagnostics.push({
          path: rawDirectory,
          rootId: activeRoot.id,
          field: "path",
          message: "symlink cycle or repeated canonical directory was skipped",
          severity: "warning",
        });
        return;
      }
      seen.add(directoryKey);

      if (activeRoot.scope === "project" && !isWithin(canonicalDirectory, canonicalRoot, host.platform)) {
        diagnostics.push({
          path: rawDirectory,
          rootId: activeRoot.id,
          field: "path",
          message: "project Skill symlink escapes its declared root",
          severity: "error",
        });
        return;
      }

      const entries = (await host.fs.list(rawDirectory)).sort(compareText);
      if (entries.includes("SKILL.md")) {
        if (candidateCount >= limits.maxCandidates) {
          exhausted = true;
          complete = false;
          diagnostics.push({
            path: rawDirectory,
            rootId: activeRoot.id,
            field: "scan",
            message: `Skill discovery reached the ${limits.maxCandidates} candidate limit`,
            severity: "error",
          });
          return;
        }
        candidateCount += 1;
        rootCandidates += 1;
        const path = join(rawDirectory, "SKILL.md");
        const canonicalSkillPath = await canonicalPath(host, path);
        if (
          activeRoot.scope === "project" &&
          (!isWithin(canonicalSkillPath, canonicalRoot, host.platform) ||
            (limits.worktreeRoot !== undefined && !isWithin(canonicalSkillPath, limits.worktreeRoot, host.platform)))
        ) {
          diagnostics.push({
            path,
            rootId: activeRoot.id,
            field: "path",
            message: "project Skill symlink target escapes the allowed root",
            severity: "error",
          });
        } else {
          const prefix = host.fs.readPrefix === undefined
            ? undefined
            : await host.fs.readPrefix(path, MAX_SKILL_CATALOG_BYTES);
          if (prefix === undefined) {
            diagnostics.push({
              path,
              rootId: activeRoot.id,
              field: "file",
              message: host.fs.readPrefix === undefined
                ? "bounded file reads are unavailable on this host; refusing unbounded discovery"
                : "SKILL.md is unreadable",
              severity: "error",
            });
          } else {
            const manifest = frontmatterOnly(prefix.content);
            if (prefix.truncated && manifest.length === 0) {
              diagnostics.push({
                path,
                rootId: activeRoot.id,
                field: "frontmatter",
                message: `frontmatter exceeds the ${MAX_SKILL_CATALOG_BYTES} byte catalog limit`,
                severity: "error",
              });
            } else {
              const actualScope: SkillScope = limits.worktreeRoot !== undefined &&
                isWithin(canonicalSkillPath, limits.worktreeRoot, host.platform)
                ? "project"
                : activeRoot.scope;
              const actualSource: SkillSource = actualScope === "project" && activeRoot.source === "user"
                ? "project"
                : activeRoot.source;
              files.push({
                path,
                canonicalPath: canonicalSkillPath,
                source: actualSource,
                scope: actualScope,
                origin: activeRoot.origin,
                precedence: precedenceFor(
                  actualScope,
                  activeRoot.origin,
                  activeRoot.projectDistance,
                  activeRoot.explicitOrder,
                  canonicalSkillPath,
                ),
                content: manifest,
                metadataOnly: true,
                loadContent: async () => {
                  const currentCanonical = await canonicalPath(host, path);
                  if (pathKey(currentCanonical, host.platform) !== pathKey(canonicalSkillPath, host.platform)) return undefined;
                  if (
                    actualScope === "project" &&
                    ((activeRoot.scope === "project" && !isWithin(currentCanonical, canonicalRoot, host.platform)) ||
                      (limits.worktreeRoot !== undefined && !isWithin(currentCanonical, limits.worktreeRoot, host.platform)))
                  ) return undefined;
                  if (host.fs.readPrefix === undefined) return undefined;
                  const full = await host.fs.readPrefix(path, MAX_SKILL_BYTES + 1);
                  if (full === undefined) return undefined;
                  if (full.truncated || new TextEncoder().encode(full.content).byteLength > MAX_SKILL_BYTES) {
                    return "x".repeat(MAX_SKILL_BYTES + 1);
                  }
                  return full.content;
                },
              });
            }
          }
        }
      }

      if (depth >= limits.maxDepth || exhausted) return;
      const names = entries.filter((name) =>
        name !== "SKILL.md" && !EXCLUDED_DIRECTORIES.has(name.toLowerCase()));
      const children: string[] = [];
      for (let offset = 0; offset < names.length; offset += SCAN_CONCURRENCY) {
        const batch = await Promise.all(names.slice(offset, offset + SCAN_CONCURRENCY).map(async (name) => {
          const child = join(rawDirectory, name);
          return await host.fs.isDirectory(child).catch(() => false) ? child : undefined;
        }));
        for (const child of batch) if (child !== undefined) children.push(child);
      }
      for (const child of children) {
        await walkDirectory(child, canonicalRoot, depth + 1, activeRoot, seen);
        if (exhausted) return;
      }
    }
  }

  return { files, roots: rootDiagnostics, diagnostics, complete };
}

async function findWorktreeRoot(host: Host, cwd: string): Promise<string | undefined> {
  let current = normalizePath(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (await host.fs.exists(join(current, ".git")).catch(() => false)) return current;
    const parent = normalizePath(parentOf(current));
    if (parent.length === 0 || pathKey(parent, host.platform) === pathKey(current, host.platform)) break;
    current = parent;
  }
  return undefined;
}

function pathChain(start: string, stop: string): string[] {
  const out: string[] = [];
  let current = normalizePath(start);
  const target = normalizePath(stop);
  for (let depth = 0; depth < 64; depth += 1) {
    out.push(current);
    if (current === target || current.toLowerCase() === target.toLowerCase()) break;
    const parent = normalizePath(parentOf(current));
    if (parent === current || parent.length === 0) break;
    current = parent;
  }
  return out;
}

function projectRoot(
  directory: string,
  relative: string,
  origin: SkillOrigin,
  projectDistance: number,
): Omit<SkillRoot, "id" | "canonicalDirectory" | "precedence" | "recursive"> {
  return {
    scope: "project",
    origin,
    source: origin === "agents" ? "agents-dir" : "project",
    directory: join(directory, relative),
    projectDistance,
    explicitOrder: 0,
  };
}

function userRoot(
  directory: string,
  origin: SkillOrigin,
): Omit<SkillRoot, "id" | "canonicalDirectory" | "precedence" | "recursive"> {
  return {
    scope: "user",
    origin,
    source: "user",
    directory: normalizePath(directory),
    explicitOrder: 0,
  };
}

function withBuiltinPrecedence(file: SkillFile): SkillFile {
  const canonicalPath = file.canonicalPath ?? file.path;
  return {
    ...file,
    canonicalPath,
    scope: "builtin",
    origin: "bundled",
    precedence: precedenceFor("builtin", "bundled", undefined, 0, canonicalPath),
  };
}

function precedenceFor(
  scope: SkillScope,
  origin: SkillOrigin,
  projectDistance: number | undefined,
  explicitOrder: number,
  normalizedPath: string,
): SkillPrecedence {
  const scopeRank = scope === "project" ? 0 : scope === "user" ? 1 : 2;
  return [
    scopeRank,
    scope === "project" ? projectDistance ?? 0 : Number.MAX_SAFE_INTEGER,
    ORIGIN_RANK[origin],
    origin === "explicit" ? explicitOrder : 0,
    normalizePath(normalizedPath),
  ];
}

function compareRoots(left: SkillRoot, right: SkillRoot): number {
  for (let index = 0; index < 4; index += 1) {
    const difference = Number(left.precedence[index] ?? 0) - Number(right.precedence[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return compareText(left.precedence[4], right.precedence[4]);
}

function scopeForSource(source: SkillSource): SkillScope {
  return source === "builtin" ? "builtin" : source === "user" ? "user" : "project";
}

function originForSource(source: SkillSource): SkillOrigin {
  return source === "builtin" ? "bundled" : source === "agents-dir" ? "agents" : "capybara";
}

function loadIssueDiagnostic(issue: SkillLoadIssue): SkillDiscoveryDiagnostic {
  return {
    path: issue.path,
    field: issue.field,
    message: issue.message,
    ...(issue.line !== undefined ? { line: issue.line } : {}),
    severity: issue.severity,
  };
}

function compareDiagnostics(left: SkillDiscoveryDiagnostic, right: SkillDiscoveryDiagnostic): number {
  return compareText(left.path, right.path) || compareText(left.field, right.field) || compareText(left.message, right.message);
}

function discoveryDigest(definitions: readonly SkillDefinition[]): string {
  const records = definitions
    .map((definition) => ({
      name: definition.manifest.name,
      description: definition.manifest.description,
      scope: definition.scope,
      origin: definition.origin,
      version: definition.manifest.version ?? null,
      risk: definition.manifest.risk ?? null,
      canonicalPath: definition.canonicalPath,
      precedence: definition.precedence ?? null,
    }))
    .sort((left, right) => compareText(left.name, right.name));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function canonicalPath(host: Host, path: string): Promise<string> {
  const normalized = normalizePath(path);
  try {
    return normalizePath((await host.fs.realpath?.(normalized)) ?? normalized);
  } catch {
    return normalized;
  }
}

function isWithin(path: string, root: string, platform: string): boolean {
  const candidate = pathKey(path, platform);
  const boundary = pathKey(root, platform).replace(/\/+$/, "");
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

function pathKey(path: string, platform: string): string {
  const normalized = normalizePath(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const drive = normalized.match(/^([A-Za-z]:)(?:\/|$)/)?.[1];
  const prefix = normalized.startsWith("//")
    ? "//"
    : drive !== undefined
      ? `${drive}/`
      : normalized.startsWith("/")
        ? "/"
        : "";
  const remainder = prefix === "//"
    ? normalized.replace(/^\/+/, "")
    : drive !== undefined
      ? normalized.slice(drive.length).replace(/^\/+/, "")
      : prefix === "/"
        ? normalized.replace(/^\/+/, "")
        : normalized;
  const segments: string[] = [];
  for (const segment of remainder.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (prefix.length === 0) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return prefix || ".";
  return `${prefix}${segments.join("/")}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:[/\\]/.test(path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
