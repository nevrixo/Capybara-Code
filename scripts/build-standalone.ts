#!/usr/bin/env bun
/**
 * Release builder — PRD §19.2, §19.9, §19.10.
 *
 * Produces the §19.2 archive layout:
 *
 * ```text
 * capybara-code-<version>-<target>/
 * ├─ bin/capy
 * ├─ libexec/cbc-runtime
 * ├─ libexec/capy-daemon
 * ├─ share/capybara/{skills,schemas,model-registry.json,notices}
 * └─ manifest.json
 * ```
 *
 * Two properties of that layout are load-bearing rather than cosmetic. `bin/` and
 * `libexec/` are siblings because §19.2 requires `capy` to launch the sidecar from an
 * absolute path derived from its own location — never by searching `PATH`. And
 * `share/capybara/` is populated at build time because §7.1 forbids a cold start from
 * blocking on the network: the model registry and the bundled Skills have to be on
 * disk before first run.
 *
 * §19.9 asks for an SBOM, third-party notices, and a checksum manifest in every
 * artifact. All three are produced here. Release archives get a separate SHA-256 file.
 * Signing is not implemented for this Public Alpha, so `manifest.json` explicitly says
 * that the artifact is unsigned. The release pipeline must not claim otherwise; that is the
 * overclaim §24.5 warns about.
 */

import { MODEL_REGISTRY, PRICING, PRICING_REGISTRY_VERSION } from "@cbc/provider-openai";
import { builtinSkillFiles } from "@cbc/skills";
import { PROTOCOL_VERSION } from "@cbc/protocol";
import { EVENT_SCHEMA_VERSION } from "@cbc/protocol";
import { isAbsolute, join, resolve } from "node:path";

import { CBC_VERSION } from "../apps/cbc/src/main.ts";

const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/+$/, "");

// A compiled Bun runtime can carry debug metadata from Bun's own build machine
// (for example `/Users/runner/work/_temp/...`). Do not use a generic home
// directory as a needle: it would reject every such binary despite no path from
// this checkout being shipped. The checkout root is the meaningful local path
// that a release artifact must not expose.
const LOCAL_BUILD_PATHS = [ROOT];

interface BuildOptions {
  readonly target: string;
  readonly outDir: string;
  readonly compile: boolean;
  readonly includeRuntime: boolean;
  readonly runtimeProfile: "debug" | "release";
}

/** Bun's compile targets, mapped to the §19.11 platform tiers. */
const TARGETS: Readonly<Record<string, { bunTarget: string; exe: string; tier: string }>> = {
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", exe: "", tier: "1" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", exe: "", tier: "1" },
  "linux-x64": { bunTarget: "bun-linux-x64", exe: "", tier: "1" },
  "linux-arm64": { bunTarget: "bun-linux-arm64", exe: "", tier: "1" },
  "linux-x64-musl": { bunTarget: "bun-linux-x64-musl", exe: "", tier: "2" },
  "windows-x64": { bunTarget: "bun-windows-x64", exe: ".exe", tier: "beta" },
};

function defaultTarget(): string {
  const platform = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "win32") return "windows-x64";
  return `linux-${arch}`;
}

/** Resolve Cargo's standard target override the same way as the runtime build. */
export function runtimeTargetDirectory(
  root = ROOT,
  cargoTargetDir = process.env.CARGO_TARGET_DIR,
): string {
  if (cargoTargetDir === undefined || cargoTargetDir.trim().length === 0) {
    return join(root, "target");
  }
  return isAbsolute(cargoTargetDir) ? cargoTargetDir : resolve(root, cargoTargetDir);
}

function parseOptions(argv: readonly string[]): BuildOptions {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags.set(token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(token, next);
      i += 1;
    } else {
      flags.set(token, true);
    }
  }

  const target = typeof flags.get("--target") === "string"
    ? (flags.get("--target") as string)
    : defaultTarget();

  if (TARGETS[target] === undefined) {
    throw new Error(
      `unknown target '${target}'. Known: ${Object.keys(TARGETS).join(", ")}`,
    );
  }

  const developmentLauncher = flags.has("--development-launcher");
  if (developmentLauncher && flags.has("--compile")) {
    throw new Error("--compile and --development-launcher cannot be used together");
  }

  return {
    target,
    outDir: typeof flags.get("--out") === "string" ? (flags.get("--out") as string) : `${ROOT}/dist`,
    // Distribution is the default. A checkout-bound launcher is useful only for an
    // explicit local-development stage and must never be mistaken for a release.
    compile: !developmentLauncher,
    includeRuntime: !flags.has("--no-runtime"),
    runtimeProfile: flags.get("--debug-runtime") === true ? "debug" : "release",
  };
}

async function main(argv: readonly string[]): Promise<number> {
  let options: BuildOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const spec = TARGETS[options.target] as { bunTarget: string; exe: string; tier: string };
  const name = `capybara-code-${CBC_VERSION}-${options.target}`;
  const stage = `${options.outDir}/${name}`;

  console.log(`building ${name}`);
  console.log(`  target tier ${spec.tier} (§19.11)`);

  await rm(stage);
  await mkdirp(`${stage}/bin`);
  await mkdirp(`${stage}/libexec`);
  await mkdirp(`${stage}/share/capybara/skills`);
  await mkdirp(`${stage}/share/capybara/schemas`);
  await mkdirp(`${stage}/share/capybara/notices`);

  const artifacts: Array<{ path: string; bytes: number; sha256: string }> = [];
  const warnings: string[] = [];

  // ---- bin/capy ----
  const binPath = `${stage}/bin/capy${spec.exe}`;
  if (options.compile) {
    const result = await compileExecutable(spec.bunTarget, binPath);
    if (!result.ok) {
      console.error(result.detail);
      return 1;
    }
  } else {
    // An explicit local-development launcher rather than a release binary.
    await write(
      `${stage}/bin/capy`,
      [
        "#!/usr/bin/env bash",
        "# Development launcher. `--compile` produces the real standalone executable.",
        'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        `exec bun run "${ROOT}/apps/cbc/src/main.ts" "$@"`,
        "",
      ].join("\n"),
    );
    warnings.push(
      "bin/capy is a development launcher and must not be distributed",
    );
  }

  // ---- libexec/cbc-runtime ----
  if (options.includeRuntime) {
    const runtimeName = `cbc-runtime${options.target.startsWith("windows") ? ".exe" : ""}`;
    const source = join(runtimeTargetDirectory(), options.runtimeProfile, runtimeName);
    if (await exists(source)) {
      await copy(source, `${stage}/libexec/${runtimeName}`);
      console.log(`  libexec/${runtimeName} from ${source}`);
    } else {
      // §19.7 verifies the runtime at startup, so shipping without it would produce a
      // binary that cannot do anything. Fail rather than emit a broken archive.
      console.error(
        [
          `error: ${source} does not exist`,
          `Build it first: cargo build --${options.runtimeProfile === "release" ? "release" : "profile=dev"} -p cbc-runtime`,
          "Or pass --no-runtime to stage the TypeScript side only.",
        ].join("\n"),
      );
      return 1;
    }
  } else {
    warnings.push("cbc-runtime is omitted: --no-runtime was passed, so normal workspace sessions cannot start");
  }

  // ---- libexec/capy-daemon ----
  const daemonName = `capy-daemon${options.target.startsWith("windows") ? ".exe" : ""}`;
  const daemonPath = `${stage}/libexec/${daemonName}`;
  if (options.compile) {
    const daemon = await compileExecutable(spec.bunTarget, daemonPath, `${ROOT}/apps/capy-daemon/src/main.ts`);
    if (!daemon.ok) {
      console.error(daemon.detail);
      return 1;
    }
  } else {
    await write(
      daemonPath.replace(/\.exe$/, ""),
      [
        "#!/usr/bin/env bash",
        'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        `exec bun run "${ROOT}/apps/capy-daemon/src/main.ts" "$@"`,
        "",
      ].join("\n"),
    );
    warnings.push("libexec/capy-daemon is a development launcher and must not be distributed");
  }

  // POSIX executability is part of the artifact contract, not a property we can
  // leave to whichever archiver or package transport happens to run later.
  // Bun.write() does not promise to preserve the source mode when it copies the
  // Rust sidecar, so normalize and verify both native entry points explicitly.
  if (spec.exe === "") {
    await makeExecutable(binPath);
    if (options.includeRuntime) await makeExecutable(`${stage}/libexec/cbc-runtime`);
    await makeExecutable(`${stage}/libexec/capy-daemon`);
  }

  // ---- share/capybara ----
  let skillCount = 0;
  for (const skill of builtinSkillFiles()) {
    // `builtinSkillFiles` reports a virtual path; the directory name is what matters
    // on disk, because §16.2 makes the directory the Skill's ownership boundary.
    const directory = skillDirectoryName(skill.path);
    await mkdirp(`${stage}/share/capybara/skills/${directory}`);
    await write(`${stage}/share/capybara/skills/${directory}/SKILL.md`, skill.content);
    skillCount += 1;
  }
  console.log(`  share/capybara/skills: ${skillCount} bundled Skill(s)`);

  for (const relative of await schemaFiles()) {
    const content = await read(`${ROOT}/schemas/${relative}`);
    if (content === undefined) continue;
    await mkdirp(`${stage}/share/capybara/schemas/${dirnameOf(relative)}`);
    await write(`${stage}/share/capybara/schemas/${relative}`, content);
  }

  // §10.12: the capability registry ships on disk so a cold start never fetches it.
  await write(
    `${stage}/share/capybara/model-registry.json`,
    `${JSON.stringify(
      {
        registryVersion: MODEL_REGISTRY[0]?.sourceVersion ?? "unknown",
        pricingVersion: PRICING_REGISTRY_VERSION,
        models: MODEL_REGISTRY,
        pricing: PRICING,
      },
      null,
      2,
    )}\n`,
  );

  const notices = await buildNotices();
  await write(`${stage}/share/capybara/notices/THIRD-PARTY.md`, notices.text);

  // ---- SBOM (§19.9) ----
  const sbom = await buildSbom();
  await write(`${stage}/share/capybara/notices/sbom.json`, `${JSON.stringify(sbom, null, 2)}\n`);

  // Bun can leave an external source map next to a compiled standalone binary even
  // though the build requests `--sourcemap=none`. The binary does not reference it,
  // while the map embeds source content, so it must never become part of a release
  // artifact or its checksum manifest.
  const sourceMaps = (await walk(stage, stage)).filter((relative) => relative.endsWith(".map"));
  for (const sourceMap of sourceMaps) {
    await rm(`${stage}/${sourceMap}`);
  }
  if (sourceMaps.length > 0) {
    console.log(`  omitted ${sourceMaps.length} generated source map(s) from release artifact`);
  }

  if (options.compile) {
    const localPathLeak = await findLocalBuildPathLeak(stage, LOCAL_BUILD_PATHS);
    if (localPathLeak !== undefined) {
      await rm(stage);
      console.error(`error: generated release artifact contains a local build path in ${localPathLeak}`);
      return 1;
    }
  }

  // ---- checksum manifest (§19.9) ----
  for (const relative of await walk(stage, stage)) {
    if (relative === "manifest.json") continue;
    const bytes = await Bun.file(`${stage}/${relative}`).arrayBuffer();
    artifacts.push({
      path: relative,
      bytes: bytes.byteLength,
      sha256: await sha256(bytes),
    });
  }

  const manifest = {
    schemaVersion: "1.0",
    name,
    productVersion: CBC_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    target: options.target,
    platformTier: spec.tier,
    builtAt: new Date().toISOString(),
    compiled: options.compile,
    // §19.9 and §24.5: do not imply an unimplemented signing scheme.
    signature: { signed: false, note: "unsigned Public Alpha artifact; verify the release SHA-256 checksums" },
    sbom: "share/capybara/notices/sbom.json",
    notices: "share/capybara/notices/THIRD-PARTY.md",
    files: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
    warnings,
  };
  await write(`${stage}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("");
  console.log(`staged ${artifacts.length} file(s) in ${stage}`);
  console.log(`  total ${formatBytes(artifacts.reduce((sum, file) => sum + file.bytes, 0))}`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  console.log("");
  console.log("Next: package the artifact and publish release SHA-256 checksums (§19.9).");
  return 0;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Run `bun build --compile`.
 *
 * Cross-compiling is left to Bun's own `--target` support. R-13 flags archive size as
 * a risk, so the byte count is reported: a regression there should be visible in build
 * output rather than discovered at download time.
 */
async function compileExecutable(
  bunTarget: string,
  outfile: string,
  entry = `${ROOT}/apps/cbc/src/main.ts`,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const args = [
    "build",
    "--compile",
    "--minify",
    "--sourcemap=none",
    `--target=${bunTarget}`,
    `--outfile=${outfile}`,
    entry,
  ];
  console.log(`  bun ${args.join(" ")}`);

  const proc = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    return { ok: false, detail: [`bun build failed with exit ${code}`, out, err].join("\n") };
  }
  if (await exists(outfile)) {
    const bytes = (await Bun.file(outfile).arrayBuffer()).byteLength;
    console.log(`  bin/capy is ${formatBytes(bytes)} (R-13: watch this number)`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// SBOM and notices
// ---------------------------------------------------------------------------

/**
 * Build a CycloneDX-shaped SBOM from the lockfile and the workspace manifests.
 *
 * Read from `bun.lock` rather than from `node_modules`, so the SBOM describes what the
 * build was *pinned* to rather than what happens to be installed.
 */
async function buildSbom(): Promise<Record<string, unknown>> {
  const components: Array<Record<string, unknown>> = [];

  const lock = await read(`${ROOT}/bun.lock`);
  if (lock !== undefined) {
    // `"name": ["name@version", "", {...}, "sha512-..."]` for a registry package.
    for (const match of lock.matchAll(/"([^"]+)":\s*\[\s*"([^"@][^"]*)@([^"]+)"[\s\S]*?(?:"(sha512-[^"]+)")?\s*\]/g)) {
      const [, key, packageName, version, integrity] = match;
      if (key === undefined || packageName === undefined || version === undefined) continue;
      if (version.startsWith("workspace:")) continue;
      components.push({
        type: "library",
        name: packageName,
        version,
        ...(integrity !== undefined ? { hashes: [{ alg: "SHA-512", content: integrity }] } : {}),
        scope: "required",
      });
    }
  }

  const cargoLock = await read(`${ROOT}/Cargo.lock`);
  if (cargoLock !== undefined) {
    let currentName: string | undefined;
    for (const line of cargoLock.split("\n")) {
      const nameMatch = /^name = "([^"]+)"$/.exec(line.trim());
      if (nameMatch?.[1] !== undefined) {
        currentName = nameMatch[1];
        continue;
      }
      const versionMatch = /^version = "([^"]+)"$/.exec(line.trim());
      if (versionMatch?.[1] !== undefined && currentName !== undefined) {
        components.push({
          type: "library",
          name: currentName,
          version: versionMatch[1],
          purl: `pkg:cargo/${currentName}@${versionMatch[1]}`,
          scope: "required",
        });
        currentName = undefined;
      }
    }
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: "application", name: "capybara-code", version: CBC_VERSION },
      // Stated rather than implied: this is derived from lockfiles, so a dependency
      // pulled in outside a lockfile would not appear.
      properties: [{ name: "capy:source", value: "bun.lock and Cargo.lock" }],
    },
    components: dedupeComponents(components),
  };
}

function dedupeComponents(
  components: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const component of components) {
    const key = `${String(component.name)}@${String(component.version)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(component);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function buildNotices(): Promise<{ text: string; count: number }> {
  const sbom = await buildSbom();
  const components = (sbom.components ?? []) as Array<Record<string, unknown>>;

  const lines = [
    "# Third-party notices",
    "",
    `Capybara Code ${CBC_VERSION}`,
    "",
    "This build includes the components listed below. Licence texts are not reproduced",
    "here: the list is generated from `bun.lock` and `Cargo.lock`, which record versions",
    "rather than licence bodies. The release pipeline attaches full licence texts.",
    "",
    `## Components (${components.length})`,
    "",
  ];
  for (const component of components) {
    lines.push(`- ${String(component.name)} ${String(component.version)}`);
  }
  lines.push("");
  return { text: lines.join("\n"), count: components.length };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function localPathVariants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return [];
  return [...new Set([
    trimmed,
    trimmed.replaceAll("\\", "/"),
    trimmed.replaceAll("/", "\\"),
  ])];
}

async function findLocalBuildPathLeak(
  stage: string,
  localPaths: readonly string[],
): Promise<string | undefined> {
  const needles = [...new Set(localPaths.flatMap(localPathVariants))];
  if (needles.length === 0) return undefined;
  const decoder = new TextDecoder();
  for (const relative of await walk(stage, stage)) {
    const text = decoder.decode(await Bun.file(`${stage}/${relative}`).arrayBuffer());
    if (needles.some((needle) => text.includes(needle))) return relative;
  }
  return undefined;
}

async function schemaFiles(): Promise<string[]> {
  const root = `${ROOT}/schemas`;
  // `Bun.file(dir).exists()` is false for a directory, so `exists()` cannot be used
  // here. `walk` already tolerates a missing directory by returning nothing.
  return (await walk(root, root)).filter((relative) => relative.endsWith(".json"));
}

async function walk(root: string, directory: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = `${directory}/${entry}`;
    const info = await stat(full).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isDirectory()) {
      out.push(...(await walk(root, full)));
    } else {
      out.push(full.slice(root.length + 1).replace(/\\/g, "/"));
    }
  }
  return out;
}

function dirnameOf(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? "" : relative.slice(0, slash);
}

function skillDirectoryName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  // `<something>/<name>/SKILL.md` — the parent directory is the Skill's name.
  return parts.length >= 2 ? (parts[parts.length - 2] as string) : "skill";
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function read(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

async function write(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

async function copy(from: string, to: string): Promise<void> {
  await Bun.write(to, Bun.file(from));
}

async function makeExecutable(path: string): Promise<void> {
  const { chmod, stat } = await import("node:fs/promises");
  await chmod(path, 0o755);
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o111) === 0) {
    throw new Error(`failed to make release executable: ${path}`);
  }
}

async function mkdirp(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}

async function rm(path: string): Promise<void> {
  const { rm: remove } = await import("node:fs/promises");
  await remove(path, { recursive: true, force: true });
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { main as buildStandalone, TARGETS, defaultTarget };
