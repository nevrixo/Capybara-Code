#!/usr/bin/env bun
/**
 * `no-codex-runtime-dependency` — PRD §0.2, AC-01.
 *
 * §0.2 forbids a list of runtime dependencies and then asks CI for a test that proves
 * the absence. Absence is the awkward thing to test: every other check in this repo
 * compares two artefacts, whereas this one has to assert that a whole category of code
 * was never written. So it checks the four conditions §0.2 spells out, and each one is
 * a different kind of evidence:
 *
 *   1. no Codex runtime package in the production dependency graph  — manifests
 *   2. no `codex` / `codex app-server` / `codex exec` process spawn — source scan
 *   3. no `~/.codex` access on the default execution path           — source scan
 *   4. Root Agent integration tests complete on a mock provider     — the seam exists
 *
 * The scan is deliberately narrow about what counts as a violation. §0.2 is about
 * *behaviour*, not vocabulary: `capy auth login` has to tell the user that Capybara does
 * not reuse Codex credentials, and `crates/cbc-protocol` has to assert that
 * `codex.app_server` is not a known method. Both mention Codex in order to refuse it.
 * A check that flagged those would push authors toward deleting the refusals, which is
 * the opposite of the intent — so only executable forms are treated as failures.
 *
 * Static analysis cannot prove a process is never spawned; a name assembled at runtime
 * would slip past. That limitation is reported rather than glossed over, and the
 * mitigation is structural: `apps/cbc` reaches the OS only through the Rust runtime's
 * RPC surface (§19.5), and every method on it is enumerated in §20.3.
 */

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface Finding {
  readonly area: string;
  readonly detail: string;
}

const failures: Finding[] = [];
const notes: string[] = [];
let checks = 0;

function check(area: string, ok: boolean, detail: string): void {
  checks += 1;
  if (!ok) failures.push({ area, detail });
}

/** Source trees that ship or build the product. `docs/` is prose and is not scanned. */
const SOURCE_DIRS = ["apps", "packages", "crates", "benchmarks", "scripts", "fixtures"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".rs", ".mjs", ".cjs", ".js"]);

/**
 * This file, excluded from its own scan.
 *
 * The patterns below have to spell out the forms they forbid, so scanning this file
 * reports every one of them. Excluding it is not a loophole: the exclusion is a single
 * exact filename rather than a pattern, so no other file can opt out.
 */
const SELF = "scripts/check-no-codex-runtime.ts";

/**
 * Executable references to the Codex CLI.
 *
 * Each pattern targets a form that would actually run something, rather than any
 * mention of the word. `bareProgram` requires `codex` to be the *entire* quoted
 * string, which is the shape a spawn argument takes — `"codex.app_server"` and
 * `"Codex credentials"` both fall outside it.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}> = [
  {
    id: "bareProgram",
    pattern: /["'`]codex["'`]/i,
    why: "`codex` as a program or command literal",
  },
  {
    id: "subcommand",
    pattern: /codex[ \t]+(app-server|exec)\b/i,
    why: "`codex app-server` or `codex exec` invocation",
  },
  {
    id: "codexHome",
    pattern: /~[\\/]\.codex\b|\.codex[\\/]|\bCODEX_HOME\b/,
    why: "a `~/.codex` path or `CODEX_HOME` lookup",
  },
  {
    id: "sdk",
    pattern: /@openai\/codex|codex-sdk|openai-codex/i,
    why: "a Codex SDK import",
  },
];

async function sourceFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
        continue;
      }
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot !== -1 && SOURCE_EXTENSIONS.has(entry.name.slice(dot))) found.push(full);
    }
  }

  for (const dir of SOURCE_DIRS) await walk(`${ROOT}/${dir}`);
  return found.sort();
}

/** Every `package.json` that describes a workspace member, plus the root. */
async function manifests(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const found = [`${ROOT}/package.json`];

  for (const dir of ["apps", "packages", "benchmarks"]) {
    let entries;
    try {
      entries = await readdir(`${ROOT}/${dir}`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) found.push(`${ROOT}/${dir}/${entry.name}/package.json`);
    }
  }
  return found;
}

function relative(path: string): string {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // ---- §0.2 (1): production dependency graph ----
  //
  // `dependencies` only. A Codex package in `devDependencies` would still be wrong,
  // but it is a different claim than the one §0.2 makes, and conflating them would
  // make the failure message inaccurate.
  for (const path of await manifests()) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = (await file.json()) as Record<string, unknown>;
    } catch (error) {
      failures.push({
        area: "dependencies",
        detail: `${relative(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = manifest[field];
      if (typeof deps !== "object" || deps === null) continue;
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        check(
          "dependencies",
          !/codex/i.test(name),
          `${relative(path)} declares '${name}' in ${field}`,
        );
      }
    }
  }

  // The installed tree, so a transitive package is caught too.
  const { readdir } = await import("node:fs/promises");
  const installed = await readdir(`${ROOT}/node_modules`, { withFileTypes: true }).catch(
    () => undefined,
  );
  if (installed === undefined) {
    notes.push("node_modules is absent, so only the manifests were checked for (1).");
  } else {
    for (const entry of installed) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scoped = await readdir(`${ROOT}/node_modules/${entry.name}`).catch(() => []);
        for (const inner of scoped) {
          check(
            "dependencies",
            !/codex/i.test(inner),
            `node_modules/${entry.name}/${inner} is installed`,
          );
        }
        continue;
      }
      check("dependencies", !/codex/i.test(entry.name), `node_modules/${entry.name} is installed`);
    }
  }

  // Rust side: the workspace declares its externals in one place.
  const cargo = await Bun.file(`${ROOT}/Cargo.toml`).text();
  check(
    "dependencies",
    !/codex/i.test(cargo),
    "Cargo.toml references a codex crate",
  );

  // ---- §0.2 (2) and (3): source scan ----
  const files = await sourceFiles();
  check("scan.coverage", files.length > 0, "no source files were found to scan");

  let scanned = 0;
  for (const path of files) {
    if (relative(path) === SELF) continue;
    scanned += 1;
    const text = await Bun.file(path).text();
    const lines = text.split("\n");

    for (const [index, line] of lines.entries()) {
      if (!/codex/i.test(line)) continue;
      for (const rule of FORBIDDEN_PATTERNS) {
        if (!rule.pattern.test(line)) continue;
        check(
          `scan.${rule.id}`,
          false,
          `${relative(path)}:${index + 1} contains ${rule.why}\n    ${line.trim().slice(0, 160)}`,
        );
      }
    }
  }

  // ---- §0.2 (4): the mock-provider seam ----
  //
  // Checked structurally rather than by running the suite: `bun run test:ts` already
  // executes it, and this script has to stay runnable without a provider. What matters
  // here is that the seam exists and that the Root Agent tests use it, because that is
  // what makes AC-47 reachable without a network.
  const providerIndex = await Bun.file(`${ROOT}/packages/provider-openai/src/index.ts`).text();
  check(
    "mockProvider",
    providerIndex.includes("./mock.ts"),
    "packages/provider-openai does not export its mock provider (§0.2, AC-47)",
  );

  const mock = await Bun.file(`${ROOT}/packages/provider-openai/src/mock.ts`).text();
  check(
    "mockProvider",
    /class MockProvider implements ModelProvider/.test(mock),
    "MockProvider no longer implements ModelProvider, so it cannot stand in for the real one",
  );

  const kernelTest = await Bun.file(`${ROOT}/packages/agent-kernel/test/kernel.test.ts`).text();
  check(
    "mockProvider",
    /MockProvider/.test(kernelTest),
    "the Root Agent test suite does not exercise MockProvider (§0.2 item 4)",
  );

  // A Root Agent test that reached the network would make the suite credential-dependent.
  check(
    "mockProvider",
    !/api\.openai\.com/.test(kernelTest),
    "packages/agent-kernel/test names a live endpoint; the suite must run offline",
  );

  notes.push(
    "A spawn name assembled at runtime cannot be caught by a source scan. The structural mitigation is §19.5: apps/cbc reaches the OS only through the enumerated §20.3 RPC surface.",
  );

  // ---- report ----
  if (failures.length === 0) {
    console.log(`no-codex-runtime-dependency: ${checks} checks passed across ${scanned} file(s)`);
    for (const note of notes) console.log(`note: ${note}`);
    return 0;
  }

  const byArea = new Map<string, string[]>();
  for (const failure of failures) {
    const list = byArea.get(failure.area) ?? [];
    list.push(failure.detail);
    byArea.set(failure.area, list);
  }

  console.error(`no-codex-runtime-dependency: ${failures.length} of ${checks} checks failed\n`);
  for (const [area, details] of [...byArea].sort()) {
    console.error(area);
    for (const detail of details) {
      for (const line of detail.split("\n")) console.error(`  ${line}`);
    }
    console.error("");
  }
  console.error(
    "PRD §0.2 forbids depending on the Codex runtime. Capybara owns its agent loop, tools, and credentials; route the capability through cbc-runtime (§20.3) instead.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}

export { main as checkNoCodexRuntime };
