/**
 * G0 source-of-truth guard.
 *
 * The repository contains historical `.orig` snapshots and generated Rust/JS
 * output. This command fingerprints only canonical implementation roots, so a
 * benchmark or review cannot accidentally import a stale snapshot as source.
 *
 *   bun run source-truth          # print the current canonical manifest
 *   bun run source-truth --write  # update .source-truth.json
 *   bun run source-truth:check    # compare the checked-in manifest
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Documentation is intentionally outside the source-truth boundary. It can be
// added, removed, or kept in a local checkout without changing the canonical
// implementation identity used by verification and release evidence.
const ROOTS = ["apps", "packages", "benchmarks", "crates", "schemas", "scripts", "fixtures"] as const;
const MANIFEST_PATH = ".source-truth.json";
/**
 * Canonical top-level files (P1-08): root manifests, lockfiles, toolchain pins,
 * and the README are source truth too — a review that fingerprints only code roots
 * can still import a stale `Cargo.toml` or `package.json`.
 */
const ROOT_FILES = [
  "package.json",
  "Cargo.toml",
  "Cargo.lock",
  "bun.lock",
  "rust-toolchain.toml",
  "tsconfig.json",
  "pnpm-workspace.yaml",
  "README.md",
] as const;
const EXCLUDED = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])target([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])benchmarks([\\/][^\\/]+)?[\\/]results([\\/]|$)/,
  /\.orig$/i,
  /\.bak$/i,
  /\.tmp$/i,
  // The manifest cannot fingerprint itself.
  /[.]source-truth[.]json$/,
];

/**
 * Git may check text files out with CRLF on Windows and LF on Linux. Source
 * truth is a repository identity, so its digest must be independent of that
 * checkout policy. Valid UTF-8 text is canonicalized to LF; binary or invalid
 * UTF-8 content remains byte-for-byte unchanged.
 */
function canonicalFileBytes(raw: Uint8Array): Uint8Array {
  if (raw.includes(0)) return raw;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!text.includes("\u0000") && (text.includes("\r\n") || text.includes("\r"))) {
      return new TextEncoder().encode(text.replace(/\r\n?/gu, "\n"));
    }
  } catch {
    // Non-UTF-8 content is treated as binary and hashed as-is.
  }
  return raw;
}

export interface SourceTruthEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface HistoricalArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly classification: "historical-backup";
}

export interface SourceTruthManifest {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly git: {
    readonly commit: string;
    readonly dirty: boolean;
    /** SHA-256 of the tracked/untracked source status plus canonical file digest. */
    readonly dirtyHash: string;
  };
  readonly roots: readonly string[];
  readonly rootFiles: readonly string[];
  readonly ignoredPatterns: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly historicalArtifacts: readonly HistoricalArtifact[];
  readonly toolVersions: {
    readonly bun: string;
    readonly node: string;
    readonly cargo: string;
    readonly rustc: string;
    readonly typescript: string;
  };
  readonly fileCount: number;
  readonly files: readonly SourceTruthEntry[];
  readonly digest: string;
}

export async function buildSourceTruthManifest(repo = process.cwd()): Promise<SourceTruthManifest> {
  const files: SourceTruthEntry[] = [];
  const historicalArtifacts: HistoricalArtifact[] = [];
  const historicalGlob = new Bun.Glob("**/*.orig");
  for await (const relative of historicalGlob.scan({ cwd: repo, onlyFiles: true, dot: true })) {
    const normalized = relative.replaceAll("\\", "/");
    if (["node_modules/", "dist/", "target/", "__pycache__/"] .some((prefix) => normalized.includes(prefix))) continue;
    const bytes = canonicalFileBytes(new Uint8Array(await Bun.file(resolve(repo, relative)).arrayBuffer()));
    historicalArtifacts.push({ path: normalized, bytes: bytes.byteLength, sha256: await sha256(bytes), classification: "historical-backup" });
  }
  historicalArtifacts.sort((left, right) => left.path.localeCompare(right.path));
  for (const root of ROOTS) {
    const glob = new Bun.Glob(`${root}/**/*`);
    for await (const relative of glob.scan({ cwd: repo, onlyFiles: true, dot: true })) {
      if (EXCLUDED.some((pattern) => pattern.test(relative))) continue;
      const bytes = canonicalFileBytes(new Uint8Array(await Bun.file(resolve(repo, relative)).arrayBuffer()));
      files.push({ path: relative.replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: await sha256(bytes) });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  for (const rootFile of ROOT_FILES) {
    try {
      const bytes = canonicalFileBytes(new Uint8Array(await Bun.file(resolve(repo, rootFile)).arrayBuffer()));
      files.push({ path: rootFile, bytes: bytes.byteLength, sha256: await sha256(bytes) });
    } catch {
      // An absent optional root file (e.g. a lockfile in a pruned archive)
      // contributes nothing; its absence is visible in the manifest's file list.
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const body = { schemaVersion: "1.0", roots: ROOTS, rootFiles: ROOT_FILES, historicalArtifacts, files };
  const digest = await sha256(new TextEncoder().encode(JSON.stringify(body)));
  const git = await readGitState(repo, digest);
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    git,
    roots: [...ROOTS],
    rootFiles: [...ROOT_FILES],
    ignoredPatterns: EXCLUDED.map((pattern) => pattern.source),
    excludedPaths: [".source-truth.json", "docs/ (optional documentation)", "**/*.orig (classified historical-backup)", "node_modules/", "dist/", "target/", "__pycache__/", "benchmarks/**/results/"],
    toolVersions: await readToolVersions(repo),
    fileCount: files.length,
    historicalArtifacts,
    files,
    digest,
  };
}

export async function checkSourceTruth(repo = process.cwd()): Promise<{ ok: boolean; message: string; current: SourceTruthManifest }> {
  const current = await buildSourceTruthManifest(repo);
  const manifestFile = resolve(repo, MANIFEST_PATH);
  let expected: SourceTruthManifest | undefined;
  try {
    expected = JSON.parse(await readFile(manifestFile, "utf8")) as SourceTruthManifest;
  } catch {
    return { ok: false, message: `${MANIFEST_PATH} is missing; run bun run source-truth --write`, current };
  }
  // The check compares canonical content only. `git` and `toolVersions` are
  // provenance — they record where and with what the manifest was generated, but
  // a different machine or a dirty checkout must not make identical sources fail
  // verification (P1-08: the check must be usable inside `verify`).
  const currentComparable = JSON.stringify({
    roots: current.roots,
    rootFiles: current.rootFiles,
    excludedPaths: current.excludedPaths,
    historicalArtifacts: current.historicalArtifacts,
    fileCount: current.fileCount,
    files: current.files,
    digest: current.digest,
  });
  const expectedComparable = JSON.stringify({
    roots: expected.roots,
    rootFiles: expected.rootFiles ?? [],
    excludedPaths: expected.excludedPaths,
    historicalArtifacts: expected.historicalArtifacts,
    fileCount: expected.fileCount,
    files: expected.files,
    digest: expected.digest,
  });
  return {
    ok: currentComparable === expectedComparable,
    message: currentComparable === expectedComparable ? `source truth OK (${current.files.length} files, ${current.digest})` : `${MANIFEST_PATH} is stale; run bun run source-truth --write`,
    current,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function commandVersion(repo: string, command: string, args: string[]): string {
  try {
    const result = Bun.spawnSync([command, ...args], { cwd: repo, stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return "unavailable";
    return new TextDecoder().decode(result.stdout).trim().split(/\r?\n/, 1)[0] || "unavailable";
  } catch {
    return "unavailable";
  }
}

async function readGitState(repo: string, digest: string): Promise<SourceTruthManifest["git"]> {
  const commit = commandVersion(repo, "git", ["rev-parse", "HEAD"]) || "unavailable";
  let status = "unavailable";
  try {
    const result = Bun.spawnSync(
      ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":!" + MANIFEST_PATH],
      { cwd: repo, stdout: "pipe", stderr: "ignore" },
    );
    if (result.exitCode === 0) status = new TextDecoder().decode(result.stdout).replaceAll("\r\n", "\n");
  } catch {
    // Keep source truth useful in unpacked/offline archives without Git.
  }
  return {
    commit,
    dirty: status !== "" && status !== "unavailable",
    dirtyHash: await sha256(new TextEncoder().encode(`${status}\n${digest}`)),
  };
}

async function readToolVersions(repo: string): Promise<SourceTruthManifest["toolVersions"]> {
  let typescript = "unavailable";
  try {
    const packageJson = JSON.parse(await readFile(resolve(repo, "node_modules/typescript/package.json"), "utf8")) as { version?: string };
    if (packageJson.version) typescript = packageJson.version;
  } catch {
    // TypeScript is optional in an unpacked source archive.
  }
  return {
    bun: Bun.version,
    node: process.version,
    cargo: commandVersion(repo, "cargo", ["--version"]),
    rustc: commandVersion(repo, "rustc", ["--version"]),
    typescript,
  };
}

if (import.meta.main) {
  const repo = process.cwd();
  if (process.argv.includes("--write")) {
    const manifest = await buildSourceTruthManifest(repo);
    await mkdir(resolve(repo, dirname(MANIFEST_PATH)), { recursive: true });
    await writeFile(resolve(repo, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`wrote ${MANIFEST_PATH} (${manifest.files.length} files, ${manifest.digest})`);
  } else if (process.argv.includes("--check")) {
    const result = await checkSourceTruth(repo);
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
  } else {
    const manifest = await buildSourceTruthManifest(repo);
    console.log(JSON.stringify(manifest, null, 2));
  }
}

