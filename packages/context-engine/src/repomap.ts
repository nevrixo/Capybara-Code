/**
 * Repository map — PRD §18.3.
 *
 * §18.3 asks for Git-tracked files, language distribution, manifests, likely test
 * directories, build scripts, entry points, recently changed files, and size and
 * binary status. It explicitly does **not** require a full AST index for MVP, so
 * this module works from a directory walk the Rust runtime already performs
 * (§19.5 "fast directory walk"), keeping the cold start off the critical path
 * (§7.1: the repo map is a background task).
 */

/** One file as reported by the runtime's workspace walk. */
export interface RepoFile {
  /** Workspace-relative, forward-slash separated. */
  readonly path: string;
  readonly bytes: number;
  readonly binary: boolean;
  /** Whether Git tracks the file. Untracked files still appear. */
  readonly tracked: boolean;
  readonly modifiedMs?: number;
}

export interface LanguageShare {
  readonly language: string;
  readonly files: number;
  readonly bytes: number;
  /** Fraction of non-generated, non-binary source bytes. */
  readonly share: number;
}

/** Bumped whenever the compact repository rendering changes shape. */
export const REPOSITORY_MAP_RENDER_VERSION = "repository-map-render-v1";

export interface RepositoryMap {
  readonly files: readonly RepoFile[];
  readonly byPath: ReadonlyMap<string, RepoFile>;
  readonly languages: readonly LanguageShare[];
  readonly manifests: readonly string[];
  readonly testDirectories: readonly string[];
  readonly buildScripts: readonly string[];
  readonly entryPoints: readonly string[];
  /** Most recently modified source files, newest first. */
  readonly recentlyChanged: readonly string[];
  readonly totalBytes: number;
  readonly sourceFileCount: number;
}

/** Extension → language, covering the §26.2 benchmark languages and common config. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  rs: "Rust",
  py: "Python",
  pyi: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "CSS",
  md: "Markdown",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  zig: "Zig",
};

/** Package and dependency manifests (§18.3 "package/manifests"). */
const MANIFEST_NAMES: readonly string[] = [
  "package.json",
  "pnpm-workspace.yaml",
  "bun.lock",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Makefile",
  "CMakeLists.txt",
  "deno.json",
];

/** Lockfiles are manifests for provenance but are never useful prompt context. */
const LOCKFILE_NAMES: readonly string[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
];

/** Directory names that indicate vendored or generated trees (§18.4 penalties). */
const VENDOR_DIRECTORIES: readonly string[] = [
  "node_modules",
  "vendor",
  "third_party",
  "bower_components",
  ".venv",
  "venv",
  "site-packages",
  ".yarn",
];

const GENERATED_DIRECTORIES: readonly string[] = [
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".cache",
  "generated",
  "__generated__",
];

const TEST_DIRECTORY_NAMES: readonly string[] = [
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "integration",
  "fixtures",
];

const BUILD_SCRIPT_NAMES: readonly string[] = [
  "Makefile",
  "justfile",
  "Justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "build.sh",
  "build.ps1",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

const ENTRY_POINT_BASENAMES: readonly string[] = [
  "main",
  "index",
  "app",
  "cli",
  "bin",
  "server",
  "lib",
  "mod",
  "__main__",
];

export function languageOf(path: string): string | undefined {
  const extension = extensionOf(path);
  if (extension === undefined) return undefined;
  return LANGUAGE_BY_EXTENSION[extension];
}

export function extensionOf(path: string): string | undefined {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
}

export function isVendored(path: string): boolean {
  return segmentsOf(path).some((segment) => VENDOR_DIRECTORIES.includes(segment));
}

export function isGenerated(path: string): boolean {
  if (segmentsOf(path).some((segment) => GENERATED_DIRECTORIES.includes(segment))) return true;
  const base = basenameOf(path);
  if (LOCKFILE_NAMES.includes(base)) return true;
  // Conventional generated-file suffixes.
  return /\.(min\.js|min\.css|map|pb\.go|g\.dart|generated\.ts|d\.ts)$/i.test(base);
}

export function isLockfile(path: string): boolean {
  return LOCKFILE_NAMES.includes(basenameOf(path));
}

export function isManifest(path: string): boolean {
  return MANIFEST_NAMES.includes(basenameOf(path));
}

export function isTestPath(path: string): boolean {
  const segments = segmentsOf(path);
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.includes(segment))) return true;
  const base = basenameOf(path);
  return /(\.|_|-)(test|spec)\.[A-Za-z0-9]+$/.test(base) || /^test_.+\.py$/.test(base);
}

/**
 * Whether a path is plausible prompt context: a non-binary, non-vendored,
 * non-generated file. Used both for the language histogram and as the default
 * candidate filter in §18.4 selection.
 */
export function isSourceCandidate(file: RepoFile): boolean {
  return !file.binary && !isVendored(file.path) && !isGenerated(file.path);
}

export interface RepositoryMapOptions {
  /** How many entries `recentlyChanged` keeps. */
  readonly recentLimit?: number;
  /** Paths Git reports as modified in the working tree, newest-relevant first. */
  readonly dirtyPaths?: readonly string[];
}

/** Build the §18.3 map from a directory walk. */
export function buildRepositoryMap(
  files: readonly RepoFile[],
  options: RepositoryMapOptions = {},
): RepositoryMap {
  const byPath = new Map<string, RepoFile>();
  for (const file of files) byPath.set(file.path, file);

  const candidates = files.filter(isSourceCandidate);

  // ---- Language distribution over source bytes only ----
  const languageTotals = new Map<string, { files: number; bytes: number }>();
  let sourceBytes = 0;
  for (const file of candidates) {
    const language = languageOf(file.path);
    if (language === undefined) continue;
    const entry = languageTotals.get(language) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.bytes;
    languageTotals.set(language, entry);
    sourceBytes += file.bytes;
  }
  const languages: LanguageShare[] = [...languageTotals.entries()]
    .map(([language, totals]) => ({
      language,
      files: totals.files,
      bytes: totals.bytes,
      share: sourceBytes === 0 ? 0 : totals.bytes / sourceBytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  // ---- Manifests, tests, build scripts, entry points ----
  const manifests = candidates
    .filter((file) => isManifest(file.path) && !isVendored(file.path))
    .map((file) => file.path)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const testDirectories = [
    ...new Set(
      files
        .filter((file) => isTestPath(file.path) && !isVendored(file.path))
        .map((file) => directoryOf(file.path))
        .filter((dir) => dir.length > 0),
    ),
  ].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const buildScripts = candidates
    .filter((file) => BUILD_SCRIPT_NAMES.includes(basenameOf(file.path)))
    .map((file) => file.path)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const entryPoints = candidates
    .filter((file) => {
      if (isTestPath(file.path)) return false;
      const base = basenameOf(file.path);
      const dot = base.lastIndexOf(".");
      if (dot <= 0) return false;
      if (languageOf(file.path) === undefined) return false;
      return ENTRY_POINT_BASENAMES.includes(base.slice(0, dot).toLowerCase());
    })
    .map((file) => file.path)
    // Shallower entry points are more likely to be the real ones.
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  // ---- Recently changed ----
  const recentLimit = options.recentLimit ?? 20;
  const dirty = (options.dirtyPaths ?? []).filter((path) => byPath.has(path));
  const byModified = candidates
    .filter((file) => file.modifiedMs !== undefined)
    .sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0))
    .map((file) => file.path);
  // Working-tree changes outrank mtime: they are what the user is working on.
  const recentlyChanged = [...new Set([...dirty, ...byModified])].slice(0, recentLimit);

  return {
    files,
    byPath,
    languages,
    manifests,
    testDirectories,
    buildScripts,
    entryPoints,
    recentlyChanged,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sourceFileCount: candidates.length,
  };
}

/** Renderings are immutable for a built map and recur on every prompt step. */
const RENDERED_REPOSITORY_MAPS = new WeakMap<RepositoryMap, Map<string, string>>();

/** A compact human/model-readable digest of the map for the L6 layer. */
export function renderRepositoryMap(map: RepositoryMap, options: { maxEntries?: number } = {}): string {
  const limit = options.maxEntries ?? 10;
  const cacheKey = `${REPOSITORY_MAP_RENDER_VERSION}:${limit}`;
  const cached = RENDERED_REPOSITORY_MAPS.get(map)?.get(cacheKey);
  if (cached !== undefined) return cached;

  const lines: string[] = ["Repository map:"];

  if (map.languages.length > 0) {
    const parts = map.languages
      .slice(0, 5)
      .map((entry) => `${entry.language} ${Math.round(entry.share * 100)}%`);
    lines.push(`- languages: ${parts.join(", ")}`);
  }
  lines.push(`- ${map.sourceFileCount} source file(s), ${formatBytes(map.totalBytes)} total`);
  if (map.manifests.length > 0) {
    lines.push(`- manifests: ${map.manifests.slice(0, limit).join(", ")}`);
  }
  if (map.entryPoints.length > 0) {
    lines.push(`- entry points: ${map.entryPoints.slice(0, limit).join(", ")}`);
  }
  if (map.testDirectories.length > 0) {
    lines.push(`- test directories: ${map.testDirectories.slice(0, limit).join(", ")}`);
  }
  if (map.buildScripts.length > 0) {
    lines.push(`- build scripts: ${map.buildScripts.slice(0, limit).join(", ")}`);
  }
  if (map.recentlyChanged.length > 0) {
    lines.push(`- recently changed: ${map.recentlyChanged.slice(0, limit).join(", ")}`);
  }
  const rendered = lines.join("\n");
  const byVersion = RENDERED_REPOSITORY_MAPS.get(map) ?? new Map<string, string>();
  byVersion.set(cacheKey, rendered);
  RENDERED_REPOSITORY_MAPS.set(map, byVersion);
  return rendered;
}

function depth(path: string): number {
  return segmentsOf(path).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
