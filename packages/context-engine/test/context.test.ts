/**
 * Context engine tests — PRD §18.2, §18.3, §18.4, §18.5, §18.10, §25.2.
 */

import { describe, expect, test } from "bun:test";

import {
  ContextEngine,
  DEFAULT_EXCERPT_LINES,
  ExcerptStore,
  MAX_INSTRUCTION_BYTES,
  REFLECTION_WINDOW,
  REPOSITORY_MAP_CACHE_MAX_BYTES,
  SELECTION_WEIGHTS,
  ancestorDirectories,
  buildExcerpt,
  buildRepositoryMap,
  cachedEstimateTokens,
  parseRepositoryMapCache,
  repositoryMapCacheKey,
  repositoryFileNodeId,
  serializeRepositoryMapCache,
  tokenEstimateCacheSize,
  instructionSearchPaths,
  isGenerated,
  isSensitivePath,
  isSourceCandidate,
  isTestPath,
  isVendored,
  languageOf,
  loadProjectInstructions,
  renderContextInspection,
  renderExcerpt,
  renderRepositoryMap,
  prepareSelectionScoringContext,
  scoreFile,
  selectContext,
  sourceCandidatesForTest,
  testCandidatesForSource,
  type FileContent,
  type InstructionReader,
  type RepoFile,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reader(files: Record<string, string>): InstructionReader {
  return {
    read: async (path) => files[path],
  };
}

function file(path: string, overrides: Partial<RepoFile> = {}): RepoFile {
  return {
    path,
    bytes: 1_000,
    binary: false,
    tracked: true,
    ...overrides,
  };
}

function content(path: string, lines: number, checksum = "a".repeat(64)): FileContent {
  return {
    path,
    text: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"),
    checksum,
    totalLines: lines,
    startLine: 1,
  };
}

// ---------------------------------------------------------------------------
// §18.2 project instructions
// ---------------------------------------------------------------------------

describe("project instructions (§18.2)", () => {
  test("ancestor directories exclude the file and the root", () => {
    expect(ancestorDirectories("src/auth/login.ts")).toEqual(["src", "src/auth"]);
    expect(ancestorDirectories("README.md")).toEqual([]);
  });

  test("search order puts root files first, then directories shallowest-first", () => {
    const paths = instructionSearchPaths(["src/auth/login.ts", "src/api/routes.ts"]);
    expect(paths[0]).toBe("AGENTS.md");
    expect(paths[1]).toBe(".capybara/AGENT.md");
    expect(paths.indexOf("src/AGENTS.md")).toBeLessThan(paths.indexOf("src/auth/AGENTS.md"));
    expect(paths).toContain("src/api/AGENTS.md");
  });

  test("a shared ancestor is listed once", () => {
    const paths = instructionSearchPaths(["src/a.ts", "src/b.ts"]);
    expect(paths.filter((p) => p === "src/AGENTS.md")).toHaveLength(1);
  });

  test("an untrusted workspace loads nothing and says why (§13.6)", async () => {
    const result = await loadProjectInstructions(reader({ "AGENTS.md": "use tabs" }), {
      trusted: false,
    });
    expect(result.instructions).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("not trusted");
  });

  test("a trusted workspace loads files in order, nearest last", async () => {
    const result = await loadProjectInstructions(
      reader({
        "AGENTS.md": "root rules",
        "src/AGENTS.md": "src rules",
      }),
      { trusted: true, touchedPaths: ["src/main.ts"] },
    );
    expect(result.instructions.map((i) => i.path)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
  });

  test("an empty instruction file is skipped rather than adding a blank layer", async () => {
    const result = await loadProjectInstructions(reader({ "AGENTS.md": "   \n  " }), {
      trusted: true,
    });
    expect(result.instructions).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("the file is empty");
  });

  test("an oversized instruction file is truncated, not dropped", async () => {
    const huge = "x".repeat(MAX_INSTRUCTION_BYTES + 500);
    const result = await loadProjectInstructions(reader({ "AGENTS.md": huge }), { trusted: true });
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]?.content).toContain("truncated");
    expect(result.skipped[0]?.reason).toContain("truncated");
  });

  test("a missing file is simply absent, not an error", async () => {
    const result = await loadProjectInstructions(reader({}), { trusted: true });
    expect(result.instructions).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §18.3 repository map
// ---------------------------------------------------------------------------

describe("repository map (§18.3)", () => {
  test("classifies languages by extension", () => {
    expect(languageOf("src/a.ts")).toBe("TypeScript");
    expect(languageOf("src/a.rs")).toBe("Rust");
    expect(languageOf("s.py")).toBe("Python");
    expect(languageOf("LICENSE")).toBeUndefined();
  });

  test("recognizes vendored and generated trees", () => {
    expect(isVendored("node_modules/x/index.js")).toBe(true);
    expect(isVendored("src/index.js")).toBe(false);
    expect(isGenerated("dist/bundle.js")).toBe(true);
    expect(isGenerated("target/debug/app")).toBe(true);
    expect(isGenerated("Cargo.lock")).toBe(true);
    expect(isGenerated("src/main.rs")).toBe(false);
  });

  test("recognizes test paths across conventions", () => {
    expect(isTestPath("test/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.tsx")).toBe(true);
    expect(isTestPath("tests/test_thing.py")).toBe(true);
    expect(isTestPath("src/main.ts")).toBe(false);
  });

  test("language share is computed over source bytes only", () => {
    const map = buildRepositoryMap([
      file("src/a.ts", { bytes: 3_000 }),
      file("src/b.rs", { bytes: 1_000 }),
      // Neither of these may influence the histogram.
      file("node_modules/dep/index.js", { bytes: 500_000 }),
      file("dist/out.js", { bytes: 500_000 }),
      file("logo.png", { bytes: 9_000, binary: true }),
    ]);
    const languages = map.languages.map((l) => l.language);
    expect(languages).toEqual(["TypeScript", "Rust"]);
    expect(map.languages[0]?.share).toBeCloseTo(0.75, 5);
    expect(map.sourceFileCount).toBe(2);
  });

  test("collects manifests, test directories, build scripts, and entry points", () => {
    const map = buildRepositoryMap([
      file("package.json"),
      file("Cargo.toml"),
      file("Makefile"),
      file("src/main.rs"),
      file("src/index.ts"),
      file("tests/api.test.ts"),
      file("node_modules/dep/package.json"),
    ]);
    expect(map.manifests).toContain("package.json");
    expect(map.manifests).toContain("Cargo.toml");
    // A vendored manifest is not the project's own.
    expect(map.manifests).not.toContain("node_modules/dep/package.json");
    expect(map.buildScripts).toContain("Makefile");
    expect(map.testDirectories).toContain("tests");
    expect(map.entryPoints).toContain("src/main.rs");
    expect(map.entryPoints).toContain("src/index.ts");
  });

  test("a test file is not treated as an entry point", () => {
    const map = buildRepositoryMap([file("test/index.test.ts")]);
    expect(map.entryPoints).toHaveLength(0);
  });

  test("working-tree changes outrank mtime in recentlyChanged", () => {
    const map = buildRepositoryMap(
      [
        file("src/old.ts", { modifiedMs: 5_000 }),
        file("src/dirty.ts", { modifiedMs: 1 }),
      ],
      { dirtyPaths: ["src/dirty.ts"] },
    );
    expect(map.recentlyChanged[0]).toBe("src/dirty.ts");
  });

  test("the rendered digest names the concrete orientation points", () => {
    const map = buildRepositoryMap([file("package.json"), file("src/index.ts")]);
    const text = renderRepositoryMap(map);
    expect(text).toContain("Repository map:");
    expect(text).toContain("package.json");
    expect(text).toContain("src/index.ts");
  });

  test("isSourceCandidate rejects binary, vendored, and generated files", () => {
    expect(isSourceCandidate(file("src/a.ts"))).toBe(true);
    expect(isSourceCandidate(file("a.png", { binary: true }))).toBe(false);
    expect(isSourceCandidate(file("node_modules/a/i.js"))).toBe(false);
    expect(isSourceCandidate(file("dist/a.js"))).toBe(false);
  });

  test("disk cache is bound to workspace identity plus Git HEAD and status", () => {
    const identity = {
      workspaceIdentityDigest: "workspace-a",
      git: { head: "abc123", index: "index-1" },
    };
    const raw = serializeRepositoryMapCache({
      ...identity,
      createdAtMs: 123,
      files: [file("src/main.ts", { bytes: 42 })],
      dirtyPaths: ["src/main.ts"],
    });
    const parsed = parseRepositoryMapCache(raw, identity);
    expect(parsed?.files[0]?.path).toBe("src/main.ts");
    expect(parsed?.key).toBe(repositoryMapCacheKey(identity));
    expect(parseRepositoryMapCache(raw, { ...identity, git: { ...identity.git, head: "other" } })).toBeUndefined();
    expect(parseRepositoryMapCache(raw, { ...identity, git: { ...identity.git, index: "other" } })).toBeUndefined();
    expect(parseRepositoryMapCache(raw, { ...identity, workspaceIdentityDigest: "workspace-b" })).toBeUndefined();
  });

  test("disk cache parser rejects path traversal and corrupt records", () => {
    const identity = { workspaceIdentityDigest: "w", git: { head: "h", index: "i" } };
    const valid = JSON.parse(serializeRepositoryMapCache({
      ...identity,
      createdAtMs: 1,
      files: [file("src/main.ts")],
    })) as Record<string, unknown>;
    valid.files = [{ path: "../outside", bytes: 1, binary: false, tracked: true }];
    expect(parseRepositoryMapCache(JSON.stringify(valid), identity)).toBeUndefined();
    expect(parseRepositoryMapCache("{", identity)).toBeUndefined();
    expect(parseRepositoryMapCache("x".repeat(REPOSITORY_MAP_CACHE_MAX_BYTES + 1), identity)).toBeUndefined();
  });

  test("stable token estimates are version-key memoized without retaining source text", () => {
    const before = tokenEstimateCacheSize();
    const first = cachedEstimateTokens("same stable prompt fragment");
    const afterFirst = tokenEstimateCacheSize();
    expect(cachedEstimateTokens("same stable prompt fragment")).toBe(first);
    expect(tokenEstimateCacheSize()).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThanOrEqual(before);
  });

  test("a provisional cached scan orients the UI without creating fresh L6 evidence", () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 16_000,
    });
    context.ingestCachedScan({ files: [file("src/cached.ts")] });

    expect(context.repositoryMap?.files.map((entry) => entry.path)).toEqual(["src/cached.ts"]);
    expect(context.repositoryMapDirty).toBe(true);
    expect(context.repositoryContext().join("\n")).not.toContain('kind="repository_map"');
    expect(context.selectEvidence({ requireFresh: true }).records.some(
      (record) => record.kind === "repository_map",
    )).toBe(false);

    context.ingestScan({ files: [file("src/live.ts")] });
    expect(context.repositoryMapDirty).toBe(false);
    expect(context.repositoryContext().join("\n")).toContain('kind="repository_map"');
  });

  test("a truncated scan preserves prior files and remains dirty", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 16_000 });
    context.ingestScan({ files: [file("src/old.ts"), file("src/kept.ts")] });
    context.ingestScan({ files: [file("src/old.ts", { bytes: 2 })], truncated: true });

    expect(context.repositoryMap?.files.map((entry) => entry.path)).toEqual(["src/old.ts", "src/kept.ts"]);
    expect(context.repositoryMapDirty).toBe(true);
    expect(context.repositoryContext().join("\n")).not.toContain('kind="repository_map"');
  });

  test("a complete repository delta updates only changed and removed paths", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 16_000 });
    context.ingestScan({ files: [file("src/old.ts"), file("src/kept.ts")] });
    context.ingestRepositoryDelta({
      files: [file("src/new.ts", { bytes: 2 })],
      removedPaths: ["src/old.ts"],
      dirtyPaths: ["src/new.ts", "src/old.ts"],
    });

    expect(context.repositoryMap?.files.map((entry) => entry.path)).toEqual(["src/kept.ts", "src/new.ts"]);
    expect(context.repositoryMapDirty).toBe(false);
    expect(context.repositoryContext().join("\n")).toContain('kind="repository_map"');
  });
});

// ---------------------------------------------------------------------------
// §18.4 selection
// ---------------------------------------------------------------------------

describe("context selection (§18.4)", () => {
  const map = buildRepositoryMap([
    file("src/parser.ts", { bytes: 2_000 }),
    file("src/parser.test.ts", { bytes: 1_500 }),
    file("src/unrelated.ts", { bytes: 2_000 }),
    file("docs/guide.md", { bytes: 40_000 }),
    file("node_modules/dep/index.js", { bytes: 1_000 }),
    file("dist/bundle.js", { bytes: 1_000 }),
    file(".env", { bytes: 100 }),
  ]);

  test("credential-looking paths are recognized (§T4)", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath("home/.ssh/id_rsa")).toBe(true);
    expect(isSensitivePath("src/env.ts")).toBe(false);
  });

  test("a sensitive path is excluded even when it would otherwise score", () => {
    const scored = scoreFile(file(".env"), { mentionedPaths: [".env"] }, map);
    expect(scored.excluded).toBe(true);
    expect(scored.reasons[0]).toContain("credential material");
  });

  test("selection never volunteers a sensitive path", () => {
    const result = selectContext(map, { searchMatches: new Map([[".env", 5]]) });
    expect(result.selected.map((s) => s.path)).not.toContain(".env");
    expect(result.excluded.some((s) => s.path === ".env")).toBe(true);
  });

  test("an explicit mention outranks everything else", () => {
    const result = selectContext(map, { mentionedPaths: ["src/unrelated.ts"] });
    expect(result.selected[0]?.path).toBe("src/unrelated.ts");
    expect(result.selected[0]?.reasons).toContain("the user referenced this path explicitly");
  });

  test("search matches raise the score and are capped", () => {
    const few = scoreFile(file("src/parser.ts"), { searchMatches: new Map([["src/parser.ts", 1]]) }, map);
    const many = scoreFile(file("src/parser.ts"), { searchMatches: new Map([["src/parser.ts", 99]]) }, map);
    expect(many.score).toBeGreaterThan(few.score);
    expect(many.score - few.score).toBeLessThanOrEqual(60);
  });

  test("a changed file pulls in its matching test", () => {
    const result = selectContext(map, { changedPaths: ["src/parser.ts"] });
    const test = result.selected.find((s) => s.path === "src/parser.test.ts");
    expect(test).toBeDefined();
    expect(test?.reasons.some((r) => r.includes("likely covers"))).toBe(true);
  });

  test("vendored and generated files are excluded, not merely penalized", () => {
    const result = selectContext(map, { searchMatches: new Map([["dist/bundle.js", 3]]) });
    expect(result.selected.map((s) => s.path)).not.toContain("dist/bundle.js");
    expect(result.selected.map((s) => s.path)).not.toContain("node_modules/dep/index.js");
  });

  test("size penalty pushes a large file below a small relevant one", () => {
    const large = scoreFile(file("docs/guide.md", { bytes: 40_000 }), {}, map);
    const small = scoreFile(file("src/parser.ts", { bytes: 2_000 }), {}, map);
    expect(small.score).toBeGreaterThan(large.score);
  });

  test("the byte budget is respected and overflow is reported", () => {
    const result = selectContext(
      map,
      {
        searchMatches: new Map([
          ["src/parser.ts", 5],
          ["src/unrelated.ts", 5],
        ]),
      },
      { maxTotalBytes: 2_500 },
    );
    expect(result.selected).toHaveLength(1);
    expect(result.omittedForBudget).toHaveLength(1);
  });

  test("a mention survives a budget that would otherwise drop it", () => {
    const result = selectContext(
      map,
      { mentionedPaths: ["docs/guide.md"] },
      { maxTotalBytes: 10 },
    );
    expect(result.selected.map((s) => s.path)).toContain("docs/guide.md");
  });

  test("a trailing-slash folder mention expands only within normal selection budgets", () => {
    const result = selectContext(
      map,
      { mentionedPaths: ["src/"] },
      { maxFiles: 2, maxTotalBytes: 3_500 },
    );
    expect(result.selected).toHaveLength(2);
    expect(result.selected.every((entry) => entry.path.startsWith("src/"))).toBe(true);
    expect(result.selected.every((entry) =>
      entry.reasons.includes("the user referenced this file's directory explicitly")
    )).toBe(true);
    expect(result.omittedForBudget.some((entry) => entry.path === "src/unrelated.ts")).toBe(true);
    expect(result.selected.map((entry) => entry.path)).not.toContain(".env");
  });

  test("the prepared scoring context and shortlist remain deterministic on large maps", () => {
    const files = Array.from({ length: 32 }, (_, index) => file(`src/file-${index}.ts`));
    const signals = { taskText: "select the source files" };
    const map = buildRepositoryMap(files);
    const prepared = prepareSelectionScoringContext(map, signals);
    expect(prepared.taskTokens.has("select")).toBe(true);
    expect(prepared.mentionedPaths.size).toBe(0);

    const first = selectContext(map, signals, {
      maxFiles: 5,
      minScore: 0,
      shortlistCap: 5,
    });
    const second = selectContext(buildRepositoryMap([...files].reverse()), signals, {
      maxFiles: 5,
      minScore: 0,
      shortlistCap: 5,
    });

    expect(first.selected.map((entry) => entry.path)).toEqual(second.selected.map((entry) => entry.path));
    expect(first.considered).toBe(5);
    expect(first.diagnostics).toEqual({
      shortlistCap: 5,
      candidateCount: 32,
      shortlistedCount: 5,
      scoredCount: 5,
      skippedByShortlist: 27,
    });
  });

  test("shortlisting keeps exact mentions distinct from folder mentions", () => {
    const mentionedMap = buildRepositoryMap([
      file("src/a.ts"),
      file("src/b.ts"),
      file("dist/generated.js"),
    ]);
    const folder = selectContext(
      mentionedMap,
      { mentionedPaths: ["src/"] },
      { minScore: 0, maxFiles: 1, shortlistCap: 1 },
    );
    expect(folder.selected).toHaveLength(1);
    expect(folder.selected[0]?.reasons).toContain("the user referenced this file's directory explicitly");
    expect(folder.excluded.some((entry) => entry.path === "dist/generated.js")).toBe(true);

    const exact = selectContext(
      mentionedMap,
      { mentionedPaths: ["dist/generated.js"] },
      { shortlistCap: 0 },
    );
    expect(exact.selected.map((entry) => entry.path)).toEqual(["dist/generated.js"]);
    expect(exact.selected[0]?.reasons).toContain("the user referenced this path explicitly");
  });

  test("test-to-source mapping works in both directions", () => {
    expect(testCandidatesForSource("src/parser.ts")).toContain("src/parser.test.ts");
    expect(testCandidatesForSource("src/parser.ts")).toContain("src/__tests__/parser.test.ts");
    expect(sourceCandidatesForTest("src/parser.test.ts")).toContain("src/parser.ts");
    // A source file has no source counterpart, and a test no test counterpart.
    expect(sourceCandidatesForTest("src/parser.ts")).toHaveLength(0);
    expect(testCandidatesForSource("src/parser.test.ts")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §18.5 excerpts
// ---------------------------------------------------------------------------

describe("file excerpts (§18.5)", () => {
  test("an excerpt carries path, checksum, line numbers, and totals", () => {
    const excerpt = buildExcerpt(content("src/a.ts", 3, "b".repeat(64)));
    const text = renderExcerpt(excerpt);
    expect(text).toContain('path="src/a.ts"');
    expect(text).toContain(`sha256="${"b".repeat(64)}"`);
    expect(text).toContain('lines="1-3 of 3"');
    expect(text).toContain("1 | line 1");
    expect(text).toContain("3 | line 3");
  });

  test("omitted ranges are marked on both sides", () => {
    const excerpt = buildExcerpt({
      path: "src/a.ts",
      text: "line 10\nline 11",
      checksum: "c".repeat(64),
      totalLines: 100,
      startLine: 10,
    });
    const text = renderExcerpt(excerpt);
    expect(text).toContain("9 earlier line(s) omitted");
    expect(text).toContain("89 later line(s) omitted");
  });

  test("a long file is capped at the excerpt window", () => {
    const excerpt = buildExcerpt(content("src/big.ts", DEFAULT_EXCERPT_LINES + 50));
    expect(excerpt.endLine).toBe(DEFAULT_EXCERPT_LINES);
    expect(excerpt.linesOmittedAfter).toBe(50);
  });

  test("the same excerpt is not stored twice", () => {
    const store = new ExcerptStore();
    expect(store.add(buildExcerpt(content("src/a.ts", 5)))).toBe(true);
    expect(store.add(buildExcerpt(content("src/a.ts", 5)))).toBe(false);
    expect(store.size).toBe(1);
  });

  test("a wider excerpt supersedes a narrower one it contains", () => {
    const store = new ExcerptStore();
    const checksum = "d".repeat(64);
    store.add(
      buildExcerpt({ path: "a.ts", text: "l2\nl3", checksum, totalLines: 10, startLine: 2 }),
    );
    store.add(
      buildExcerpt({ path: "a.ts", text: "l1\nl2\nl3\nl4", checksum, totalLines: 10, startLine: 1 }),
    );
    expect(store.size).toBe(1);
    expect(store.excerpts()[0]?.startLine).toBe(1);
  });

  test("a narrower excerpt inside an existing one is not added", () => {
    const store = new ExcerptStore();
    const checksum = "d".repeat(64);
    store.add(
      buildExcerpt({ path: "a.ts", text: "l1\nl2\nl3\nl4", checksum, totalLines: 10, startLine: 1 }),
    );
    expect(
      store.add(
        buildExcerpt({ path: "a.ts", text: "l2\nl3", checksum, totalLines: 10, startLine: 2 }),
      ),
    ).toBe(false);
  });

  test("a changed checksum invalidates the stale copy (AC-13 evidence)", () => {
    const store = new ExcerptStore();
    store.add(buildExcerpt(content("src/a.ts", 5, "1".repeat(64))));
    expect(store.isStale("src/a.ts", "2".repeat(64))).toBe(true);

    store.add(buildExcerpt(content("src/a.ts", 5, "2".repeat(64))));
    expect(store.size).toBe(1);
    expect(store.excerpts()[0]?.checksum).toBe("2".repeat(64));
    expect(store.isStale("src/a.ts", "2".repeat(64))).toBe(false);
  });

  test("detectStale reports drift against a fresh listing", () => {
    const store = new ExcerptStore();
    store.add(buildExcerpt(content("a.ts", 2, "1".repeat(64))));
    store.add(buildExcerpt(content("b.ts", 2, "9".repeat(64))));
    const stale = store.detectStale(
      new Map([
        ["a.ts", "5".repeat(64)],
        ["b.ts", "9".repeat(64)],
      ]),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.path).toBe("a.ts");
  });

  test("invalidate drops every excerpt of a path", () => {
    const store = new ExcerptStore();
    store.add(buildExcerpt(content("a.ts", 2)));
    expect(store.invalidate("a.ts")).toBe(1);
    expect(store.size).toBe(0);
    expect(store.checksumFor("a.ts")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engine and §18.10 inspector
// ---------------------------------------------------------------------------

describe("ContextEngine and the inspector (§18.1, §18.10)", () => {
  function engine() {
    return new ContextEngine({
      reader: reader({ "AGENTS.md": "prefer small diffs" }),
      softContextTokens: 96_000,
    });
  }

  test("selection is a no-op before a scan arrives (§7.1)", () => {
    const result = engine().select({ mentionedPaths: ["a.ts"] });
    expect(result.selected).toHaveLength(0);
    expect(result.considered).toBe(0);
  });

  test("repositoryContext leads with the map, then the excerpts", async () => {
    const e = engine();
    e.ingestScan({ files: [file("src/index.ts")] });
    await e.loadInstructions({ trusted: true });
    e.addExcerpt(content("src/index.ts", 3));

    const sections = e.repositoryContext();
    expect(sections[0]).toContain("Repository map:");
    expect(sections.some((section) => section.includes('path="src/index.ts"'))).toBe(true);
    expect(sections.some((section) => section.includes("<evidence-index>"))).toBe(true);
  });

  test("already-excerpted files are not re-selected", () => {
    const e = engine();
    e.ingestScan({ files: [file("src/a.ts"), file("src/b.ts")] });
    e.addExcerpt(content("src/a.ts", 3));
    const result = e.select({ searchMatches: new Map([["src/a.ts", 9], ["src/b.ts", 1]]) });
    expect(result.selected.map((s) => s.path)).not.toContain("src/a.ts");
  });

  test("a mutation invalidates the excerpt so the next read is fresh", () => {
    const e = engine();
    e.addExcerpt(content("src/a.ts", 3));
    expect(e.excerpts.size).toBe(1);
    e.invalidate("src/a.ts");
    expect(e.excerpts.size).toBe(0);
  });

  test("the inspector reports every layer and the budget fraction", async () => {
    const e = engine();
    e.ingestScan({ files: [file("src/index.ts")] });
    await e.loadInstructions({ trusted: true });
    e.addExcerpt(content("src/index.ts", 20));

    const view = e.inspect({
      policyText: "policy",
      toolProtocolText: "protocol",
      toolSchemaIds: ["fs.read", "fs.apply_patch"],
      userInput: "fix the parser",
      reasoningItemCount: 3,
      cachePrefixFingerprint: "abc12345",
    });

    expect(view.layers.map((l) => l.layer)).toEqual([
      "L0_policy",
      "L1_tool_semantics",
      "L2_project_instructions",
      "L3_active_skills",
      "L4_task_and_plan",
      "L5_compact_state",
      "L6_repository_context",
      "L7_tool_observations",
      "L8_user_input",
    ]);
    expect(view.softBudgetTokens).toBe(96_000);
    expect(view.usedTokens).toBeGreaterThan(0);
    expect(view.layers.find((l) => l.layer === "L2_project_instructions")?.detail).toBe("AGENTS.md");
    expect(view.activeFiles[0]?.path).toBe("src/index.ts");
  });

  test("the inspector reports reasoning presence but never contents (§10.7)", () => {
    const view = engine().inspect({ reasoningItemCount: 4 });
    expect(view.reasoning.items).toBe(4);
    expect(view.reasoning.note).toContain("never displayed");
    // No field anywhere carries reasoning text.
    expect(JSON.stringify(view)).not.toContain("chain-of-thought");
  });

  test("withheld instructions are visible in the inspector, not silently absent", async () => {
    const e = engine();
    await e.loadInstructions({ trusted: false });
    const view = e.inspect({});
    expect(view.instructionsSkipped.some((s) => s.reason.includes("not trusted"))).toBe(true);
    expect(renderContextInspection(view).join("\n")).toContain("Instruction files not applied");
  });

  test("spilled output is recorded for the inspector (§18.10)", () => {
    const e = engine();
    e.noteExcludedOutput("pnpm test", 2_000_000, "art_1");
    const rendered = renderContextInspection(e.inspect({})).join("\n");
    expect(rendered).toContain("Excluded large outputs");
    expect(rendered).toContain("art_1");
  });

  test("the rendered inspector shows the budget percentage", () => {
    const rendered = renderContextInspection(engine().inspect({ userInput: "hi" })).join("\n");
    expect(rendered).toMatch(/Context \d+% of 96,000 token soft budget/);
  });
});

// ---------------------------------------------------------------------------
// Recent-failure weighting (§11.2, §18.4)
// ---------------------------------------------------------------------------

describe("recent failure weight (§18.4)", () => {
  const map = buildRepositoryMap([
    file("src/parser.ts"),
    file("src/unrelated.ts"),
    file("src/deep/nested/other.ts"),
  ]);

  test("a file a recent failure named is weighted and the reason is recorded", () => {
    const withFailure = scoreFile(
      file("src/parser.ts"),
      { recentFailurePaths: ["src/parser.ts"] },
      map,
    );
    const without = scoreFile(file("src/parser.ts"), {}, map);

    expect(withFailure.score).toBeGreaterThan(without.score);
    expect(withFailure.score - without.score).toBe(SELECTION_WEIGHTS.recentFailure);
    // §18.10: the inspector has to be able to say why the file is there.
    expect(withFailure.reasons.some((r) => r.includes("recent failure"))).toBe(true);
  });

  test("the weight stays below the changed-file signal", () => {
    // The file an error mentioned is not always the file that must change; a higher
    // weight would let one noisy stack trace crowd out the change set.
    expect(SELECTION_WEIGHTS.recentFailure).toBeLessThan(SELECTION_WEIGHTS.changedFile);
  });

  test("a failed file pulls its neighbours into focus", () => {
    const neighbour = scoreFile(
      file("src/unrelated.ts"),
      { recentFailurePaths: ["src/parser.ts"] },
      map,
    );
    expect(neighbour.reasons.some((r) => r.includes("same directory"))).toBe(true);
  });

  test("a sensitive path is still never selected, whatever failed", () => {
    const secret = scoreFile(file(".env"), { recentFailurePaths: [".env"] }, map);
    expect(secret.excluded).toBe(true);
  });

  test("selection ranks the failed file above an equally-plausible sibling", () => {
    const result = selectContext(map, { recentFailurePaths: ["src/unrelated.ts"] }, { maxFiles: 3 });
    expect(result.selected[0]?.path).toBe("src/unrelated.ts");
  });
});

describe("engine reflection window (§11.2, §18.9)", () => {
  function engine(): ContextEngine {
    const created = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    created.ingestScan({ files: [file("src/parser.ts"), file("src/other.ts")] });
    return created;
  }

  const reflection = (toolId: string, paths: string[]) => ({
    toolId,
    category: "logic_bug",
    rootCause: `${toolId} contradicted an assumption`,
    correctiveAction: "re-read the source",
    paths,
  });

  test("a recorded reflection feeds selection without the caller threading it", () => {
    const context = engine();
    context.noteReflection(reflection("fs.read", ["src/parser.ts"]));

    const result = context.select({});
    const parser = result.selected.find((f) => f.path === "src/parser.ts");
    expect(parser?.reasons.some((r) => r.includes("recent failure"))).toBe(true);
  });

  test("an explicit signal from the caller wins over the engine's window", () => {
    const context = engine();
    context.noteReflection(reflection("fs.read", ["src/parser.ts"]));

    // An explicitly empty list means "no failure weighting", not "use the default".
    // Without the weight the file scores below the floor and is not selected at all.
    const suppressed = context.select({ recentFailurePaths: [] });
    expect(suppressed.selected.map((f) => f.path)).not.toContain("src/parser.ts");

    const applied = context.select({});
    expect(applied.selected.map((f) => f.path)).toContain("src/parser.ts");
  });

  test("a reflection invalidates the stale excerpt it implicates (§18.5)", () => {
    const context = engine();
    context.addExcerpt(content("src/parser.ts", 20));
    expect(context.excerpts.size).toBe(1);

    // The failure is evidence that what the engine holds is wrong, so re-reading
    // beats re-asserting.
    context.noteReflection(reflection("fs.read", ["src/parser.ts"]));
    expect(context.excerpts.size).toBe(0);
  });

  test("the window is bounded, newest first", () => {
    const context = engine();
    for (let i = 0; i < 12; i += 1) {
      context.noteReflection(reflection(`tool_${i}`, [`src/f${i}.ts`]));
    }
    expect(context.reflections.length).toBe(REFLECTION_WINDOW);
    expect(context.recentFailurePaths()[0]).toBe("src/f11.ts");
    expect(context.recentFailurePaths(2)).toHaveLength(2);
  });

  test("a clean turn forgets the failures that led to it", () => {
    const context = engine();
    context.noteReflection(reflection("fs.read", ["src/parser.ts"]));
    context.forgetReflections();
    expect(context.reflections).toHaveLength(0);
    expect(context.recentFailurePaths()).toHaveLength(0);
  });

  test("unresolved failures are rendered for L5 rather than dropped", () => {
    const context = engine();
    context.noteReflection(reflection("fs.read", ["src/parser.ts"]));
    const lines = context.unresolvedFromReflections();
    expect(lines[0]).toContain("fs.read failed (logic_bug)");
    expect(lines[0]).toContain("next: re-read the source");
  });

  test("the inspector explains which failures are biasing selection (§18.10, P2)", () => {
    const context = engine();
    context.noteReflection(reflection("process.run", ["src/parser.ts"]));
    const view = context.inspect({ compactState: "# Session state (compacted)" });

    expect(view.recentFailures).toHaveLength(1);
    expect(view.recentFailures[0]?.toolId).toBe("process.run");
    expect(
      view.layers.find((l) => l.layer === "L5_compact_state")?.detail,
    ).toContain("1 unresolved failure");

    const rendered = renderContextInspection(view).join("\n");
    expect(rendered).toContain("Recent failures weighting selection");
    expect(rendered).toContain("src/parser.ts");
  });
});

// ---------------------------------------------------------------------------
// Context compiler P0 observation/evidence working loop
// ---------------------------------------------------------------------------

describe("Context compiler P0 production primitives", () => {
  function readData(options: {
    path?: string;
    checksum?: string;
    text?: string;
    startLine?: number;
    totalLines?: number;
  } = {}) {
    const path = options.path ?? "src/a.ts";
    const checksum = options.checksum ?? "a".repeat(64);
    const text = options.text ?? "export const a = 1;";
    const startLine = options.startLine ?? 1;
    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    const totalLines = options.totalLines ?? Math.max(lineCount, startLine + lineCount - 1);
    return {
      path,
      binary: false,
      checksum,
      excerpt: {
        path,
        checksum,
        startLine,
        endLine: lineCount === 0 ? startLine - 1 : startLine + lineCount - 1,
        totalLines,
        text,
        partial: startLine > 1 || startLine + lineCount - 1 < totalLines,
        omittedBefore: startLine - 1,
        omittedAfter: Math.max(0, totalLines - (startLine + lineCount - 1)),
      },
    };
  }

  function toolObservation(
    toolId: string,
    data: unknown,
    options: {
      cacheHit?: boolean;
      callId?: string;
      ok?: boolean;
      text?: string;
      agentId?: string;
      exitCode?: number;
      reads?: string[];
      artifacts?: Array<{
        id: string;
        digest: string;
        mediaType: string;
        bytes: number;
        redaction: "raw" | "redacted" | "derived";
        retentionClass: "session" | "temporary" | "pinned";
      }>;
    } = {},
  ) {
    const callId = options.callId ?? "call-1";
    const record = typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    const derivedReads = toolId === "fs.read" && typeof record?.path === "string"
      ? [record.path]
      : toolId === "fs.read_many"
        ? [
            ...(Array.isArray(record?.files) ? record.files : []),
            ...(Array.isArray(record?.errors) ? record.errors : []),
          ].flatMap((entry) =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
              typeof (entry as Record<string, unknown>).path === "string"
              ? [(entry as Record<string, unknown>).path as string]
              : [])
        : toolId.startsWith("fs.") ? ["src/a.ts"] : [];
    const reads = options.reads ?? derivedReads;
    return {
      action: {
        callId,
        toolId,
        arguments: toolId === "fs.read" ? { path: reads[0] ?? "src/a.ts" } : {},
        reads,
        display: toolId,
      },
      execution: {
        result: {
          ok: options.ok ?? true,
          summary: `${toolId} result`,
          data,
          ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
          ...((options.ok ?? true) ? {} : {
            error: { code: "PROCESS_EXIT_NONZERO", message: "failed", retryable: false },
          }),
        },
        ...(options.text !== undefined ? { text: options.text } : {}),
        ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
        durationMs: 12,
      },
      cacheHit: options.cacheHit ?? false,
      observedAtMs: options.cacheHit ? 2 : 1,
      agentId: options.agentId ?? "root",
      turnId: "turn-1",
    } as const;
  }

  test("fs.read becomes one exact excerpt and stable evidence ID", () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 96_000,
      workspaceIdentityDigest: "workspace-1",
    });
    const first = context.ingestToolObservation(toolObservation("fs.read", readData()));
    const second = context.ingestToolObservation(
      toolObservation("fs.read", readData(), { cacheHit: true, callId: "call-2", agentId: "child-1" }),
    );

    expect(first.exactContentPromoted).toBe(true);
    expect(second.exactContentPromoted).toBe(true);
    expect(first.evidence[0]?.id).toBe(second.evidence[0]?.id);
    expect(context.excerpts.size).toBe(1);
    expect(context.selectEvidence({ kinds: ["file_excerpt"] }).records).toHaveLength(1);
    expect(context.selectEvidence({ kinds: ["file_excerpt"] }).records[0]?.metadata?.agentId).toBe("child-1");
    expect(context.selectEvidence({ kinds: ["file_excerpt"] }).records[0]?.metadata?.cacheHit).toBe(true);

    const prompt = context.repositoryContext().join("\n\n");
    expect(prompt.match(/export const a = 1;/g)).toHaveLength(1);
    expect(prompt).toContain(first.evidence[0]?.id ?? "missing");
    expect(first.evidence[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("preview reads never become exact or write-authoritative evidence", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const result = context.ingestToolObservation(toolObservation("fs.read", {
      ...readData(),
      mode: "preview",
      revisionToken: "revision:metadata",
      authoritativeForWrite: false,
    }));

    expect(result.exactContentPromoted).toBe(false);
    expect(result.safeToVirtualize).toBe(false);
    expect(context.excerpts.size).toBe(0);
    expect(result.rejected.some((entry) => entry.reason.includes("preview"))).toBe(true);
  });

  test("read_many keeps valid files and records bounded partial errors", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const result = context.ingestToolObservation(
      toolObservation("fs.read_many", {
        files: [
          readData({ path: "src/a.ts", checksum: "a".repeat(64), text: "a" }),
          readData({ path: "src/b.ts", checksum: "b".repeat(64), text: "b" }),
        ],
        errors: [{ path: "src/missing.ts", message: "not found" }],
      }),
    );
    expect(result.excerptIds).toHaveLength(2);
    expect(result.evidence.filter((record) => record.kind === "file_excerpt")).toHaveLength(2);
    expect(result.evidence.some((record) => record.summary.includes("partial read error"))).toBe(true);
    expect(context.repositoryContext().join("\n")).toContain("src/b.ts");
  });

  test("a new checksum invalidates old evidence and excludes it from materialization", () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 96_000,
      workspaceIdentityDigest: "workspace-1",
    });
    const old = context.ingestToolObservation(
      toolObservation("fs.read", readData({ checksum: "1".repeat(64), text: "old value" })),
    ).evidence[0]!;
    const fresh = context.ingestToolObservation(
      toolObservation("fs.read", readData({ checksum: "2".repeat(64), text: "new value" }), { callId: "call-2" }),
    );
    expect(fresh.invalidatedEvidenceIds).toContain(old.id);
    expect(context.evidence.get(old.id)?.freshness).toBe("invalid");
    const prompt = context.repositoryContext({
      evidence: context.selectEvidence({ requireFresh: false }),
    }).join("\n");
    expect(prompt).not.toContain("old value");
    expect(prompt).toContain("new value");
    expect(context.lastMaterialization.rejected.some((entry) => entry.id === old.id)).toBe(true);
  });

  test("non-overlapping distant ranges remain active in a 400+ line file", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    context.ingestToolObservation(
      toolObservation("fs.read", readData({
        path: "src/large.ts",
        checksum: "f".repeat(64),
        text: "symbol one\nreturn 1",
        startLine: 10,
        totalLines: 900,
      })),
    );
    context.ingestToolObservation(
      toolObservation("fs.read", readData({
        path: "src/large.ts",
        checksum: "f".repeat(64),
        text: "symbol two\nreturn 2",
        startLine: 700,
        totalLines: 900,
      }), { callId: "call-2" }),
    );
    expect(context.excerpts.size).toBe(2);
    expect(context.activeExcerpts.size).toBe(2);
    const prompt = context.repositoryContext().join("\n");
    expect(prompt).toContain("symbol one");
    expect(prompt).toContain("symbol two");
  });

  test("active excerpt eviction is hard-budgeted but exact evidence is retained", () => {
    let now = 0;
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 4_000,
      activeExcerptTokens: 40,
      now: () => ++now,
    });
    let rawFallbacks = 0;
    for (let index = 0; index < 3; index += 1) {
      const result = context.ingestToolObservation(
        toolObservation("fs.read", readData({
          path: `src/${index}.ts`,
          checksum: String(index).repeat(64),
          text: `export const value${index} = "${"x".repeat(120)}";`,
        }), { callId: `call-${index}` }),
      );
      if (!result.exactContentPromoted) rawFallbacks += 1;
    }
    context.repositoryContext();
    expect(context.activeExcerpts.totalEstimatedTokens).toBeLessThanOrEqual(40);
    expect(context.excerpts.size).toBe(3);
    expect(context.selectEvidence({ kinds: ["file_excerpt"] }).records).toHaveLength(3);
    expect(rawFallbacks).toBeGreaterThan(0);
  });

  test("instruction refresh replaces edits, removes deletions, and fails closed when untrusted", async () => {
    const files: Record<string, string | undefined> = { "AGENTS.md": "old instruction" };
    const dynamicReader: InstructionReader = { read: async (path) => files[path] };
    const untrusted = new ContextEngine({ reader: dynamicReader, softContextTokens: 96_000 });
    await untrusted.loadInstructions({ trusted: false });
    await untrusted.refreshInstructionsForPaths(["src/a.ts"]);
    expect(untrusted.instructions).toHaveLength(0);

    const trusted = new ContextEngine({ reader: dynamicReader, softContextTokens: 96_000 });
    await trusted.loadInstructions({ trusted: true, touchedPaths: ["src/a.ts"] });
    expect(trusted.instructions[0]?.content).toBe("old instruction");
    files["AGENTS.md"] = "new instruction";
    await trusted.refreshInstructionsForPaths(["src/a.ts"]);
    expect(trusted.instructions[0]?.content).toBe("new instruction");
    delete files["AGENTS.md"];
    await trusted.refreshInstructionsForPaths(["src/a.ts"]);
    expect(trusted.instructions).toHaveLength(0);
  });

  test("an excerpt larger than the active budget is retained as evidence but not reported promoted", () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 4_000,
      activeExcerptTokens: 10,
    });
    const source = "oversized:" + "x".repeat(400);
    const result = context.ingestToolObservation(
      toolObservation("fs.read", readData({ text: source })),
    );
    expect(result.handled).toBe(true);
    expect(result.exactContentPromoted).toBe(false);
    expect(result.excerptIds).toHaveLength(0);
    expect(context.activeExcerpts.size).toBe(0);
    expect(context.selectEvidence({ kinds: ["file_excerpt"] }).records).toHaveLength(1);
    expect(context.repositoryContext().join("\n")).not.toContain(source);
  });

  test("sensitive single and mixed reads are safe to virtualize without indexing secrets", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const secret = "SECRET_CONTEXT_P0_SENTINEL";
    const single = context.ingestToolObservation(
      toolObservation("fs.read", readData({
        path: ".env",
        checksum: "7".repeat(64),
        text: secret,
      })),
    );
    expect(single.handled).toBe(true);
    expect(single.exactContentPromoted).toBe(false);
    expect(single.safeToVirtualize).toBe(true);

    const mixed = context.ingestToolObservation(
      toolObservation("fs.read_many", {
        files: [
          readData({ path: "src/safe.ts", checksum: "8".repeat(64), text: "safe value" }),
          readData({ path: ".env", checksum: "7".repeat(64), text: secret }),
        ],
        errors: [],
      }, { callId: "call-mixed" }),
    );
    expect(mixed.safeToVirtualize).toBe(true);
    expect(mixed.exactContentPromoted).toBe(false);
    const prompt = context.repositoryContext().join("\n");
    expect(prompt).toContain("safe value");
    expect(prompt).not.toContain(secret);
  });

  test("a contained reread never relabels a wider exact excerpt", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const checksum = "9".repeat(64);
    const wide = context.ingestToolObservation(
      toolObservation("fs.read", readData({
        path: "src/range.ts",
        checksum,
        text: "one\ntwo\nthree\nfour",
        startLine: 1,
        totalLines: 4,
      })),
    );
    const narrow = context.ingestToolObservation(
      toolObservation("fs.read", readData({
        path: "src/range.ts",
        checksum,
        text: "two\nthree",
        startLine: 2,
        totalLines: 4,
      }), { callId: "call-narrow" }),
    );
    expect(wide.excerptIds).toHaveLength(1);
    expect(narrow.excerptIds).toEqual(wide.excerptIds);
    const prompt = context.repositoryContext().join("\n");
    expect(prompt).toContain("one");
    expect(prompt).toContain("four");
    const wideEvidence = wide.evidence.find((record) => record.kind === "file_excerpt")!;
    expect(prompt).toContain(`<context-item id="${wideEvidence.id}" kind="file_excerpt">`);
    const narrowEvidence = narrow.evidence.find(
      (record) => record.kind === "file_excerpt" && record.id !== wideEvidence.id,
    );
    expect(narrowEvidence?.metadata?.coveredByExcerptId).toBe(wide.excerptIds[0]);
  });

  test("a failed explicit reread invalidates a previously fresh excerpt", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const old = context.ingestToolObservation(
      toolObservation("fs.read", readData({ path: "src/a.ts", text: "OLD_SENTINEL" })),
    );
    const failed = context.ingestToolObservation(
      toolObservation("fs.read", undefined, { ok: false, callId: "call-missing" }),
    );
    const oldId = old.evidence.find((record) => record.kind === "file_excerpt")!.id;
    expect(failed.invalidatedEvidenceIds).toContain(oldId);
    expect(context.evidence.get(oldId)?.freshness).toBe("invalid");
    expect(context.repositoryContext().join("\n")).not.toContain("OLD_SENTINEL");
  });

  test("text changing to binary invalidates and removes the old exact version", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const old = context.ingestToolObservation(
      toolObservation("fs.read", readData({ path: "src/value.dat", checksum: "a".repeat(64), text: "OLD" })),
    );
    const binary = context.ingestToolObservation(
      toolObservation("fs.read", {
        path: "src/value.dat",
        checksum: "b".repeat(64),
        binary: true,
      }, { callId: "call-binary" }),
    );
    const oldId = old.evidence.find((record) => record.kind === "file_excerpt")!.id;
    expect(binary.invalidatedEvidenceIds).toContain(oldId);
    expect(binary.exactContentPromoted).toBe(false);
    expect(context.repositoryContext().join("\n")).not.toContain("OLD");
  });

  test("text changing to the runtime's empty-file range invalidates the old version", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const old = context.ingestToolObservation(
      toolObservation("fs.read", readData({ path: "src/empty.ts", checksum: "c".repeat(64), text: "OLD" })),
    );
    const empty = context.ingestToolObservation(
      toolObservation("fs.read", {
        path: "src/empty.ts",
        checksum: "d".repeat(64),
        binary: false,
        excerpt: {
          path: "src/empty.ts",
          checksum: "d".repeat(64),
          startLine: 1,
          endLine: 1,
          totalLines: 0,
          text: "",
          partial: false,
          omittedBefore: 0,
          omittedAfter: 0,
        },
      }, { callId: "call-empty" }),
    );
    const oldId = old.evidence.find((record) => record.kind === "file_excerpt")!.id;
    expect(empty.invalidatedEvidenceIds).toContain(oldId);
    expect(empty.handled).toBe(true);
    const prompt = context.repositoryContext().join("\n");
    expect(prompt).not.toContain("OLD");
    expect(prompt).toContain('lines="1-0 of 0"');
  });

  test("a committed mutation invalidates workspace-snapshot evidence and the repository map", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    context.ingestScan({ files: [file("src/a.ts"), file("package.json")] });
    const search = context.ingestToolObservation(
      toolObservation("fs.search", {
        matches: [{ path: "src/a.ts", line: 1, column: 1, text: "needle" }],
        truncated: false,
      }),
    ).evidence[0]!;
    const mapId = context.selectEvidence({ kinds: ["repository_map"] }).records[0]!.id;
    expect(context.repositoryContext().join("\n")).toContain(mapId);

    const invalidation = context.invalidate("src/a.ts", "transaction committed");
    expect(invalidation.evidenceInvalidated.map((record) => record.id)).toEqual(
      expect.arrayContaining([mapId, search.id]),
    );
    expect(context.repositoryMap).toBeUndefined();
    expect(context.repositoryMapDirty).toBe(true);
    context.ingestScan({ files: [file("src/b.ts")] });
    expect(context.repositoryMapDirty).toBe(false);
    const prompt = context.repositoryContext({
      evidence: context.selectEvidence({ requireFresh: false }),
    }).join("\n");
    expect(prompt).not.toContain(mapId);
    expect(prompt).not.toContain(search.id);
  });

  test("large process output materializes a runtime artifact handle", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const artifact = {
      id: "artifact-runtime-1",
      digest: "d".repeat(64),
      mediaType: "text/plain",
      bytes: 100_000,
      redaction: "redacted" as const,
      retentionClass: "session" as const,
    };
    context.ingestToolObservation(
      toolObservation("process.run", {}, {
        text: "x".repeat(100_000),
        artifacts: [artifact],
        exitCode: 0,
      }),
    );
    const prompt = context.repositoryContext().join("\n");
    expect(prompt).toContain("<artifact-handles>");
    expect(prompt).toContain("artifact-runtime-1");
    expect(prompt).toContain(artifact.digest);
  });

  test("a read larger than the exact window stays raw instead of losing its tail", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const source = Array.from({ length: 500 }, (_, index) => `LINE_${index + 1}`).join("\n");
    const result = context.ingestToolObservation(
      toolObservation("fs.read", readData({
        path: "src/500.ts",
        checksum: "5".repeat(64),
        text: source,
        totalLines: 500,
      })),
    );
    expect(result.handled).toBe(true);
    expect(result.exactContentPromoted).toBe(false);
    expect(result.safeToVirtualize).toBe(false);
    expect(result.excerptIds).toHaveLength(0);
    expect(context.repositoryContext().join("\n")).not.toContain("LINE_500");
  });

  test("pending promotion leases preserve the first virtualized read until compilation", () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 4_000,
      activeExcerptTokens: 150,
    });
    const firstText = `FIRST_LEASE_SENTINEL ${"a".repeat(60)}`;
    const secondText = `SECOND_LEASE_SENTINEL ${"b".repeat(60)}`;
    const first = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/first.ts", checksum: "1".repeat(64), text: firstText,
    })));
    const second = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/second.ts", checksum: "2".repeat(64), text: secondText,
    }), { callId: "lease-2" }));
    expect(first.exactContentPromoted).toBe(true);
    expect(second.exactContentPromoted).toBe(false);
    const prompt = context.repositoryContext().join("\n");
    expect(prompt).toContain("FIRST_LEASE_SENTINEL");
    expect(prompt).not.toContain("SECOND_LEASE_SENTINEL");
  });

  test("read_many rollback never removes an earlier observation's pending lease", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const firstData = readData({ path: "src/a.ts", checksum: "a".repeat(64), text: "EARLIER_LEASE" });
    const first = context.ingestToolObservation(toolObservation("fs.read", firstData));
    const tooLarge = Array.from({ length: 401 }, (_, index) => `RAW_${index + 1}`).join("\n");
    const batch = context.ingestToolObservation(toolObservation("fs.read_many", {
      files: [firstData, readData({
        path: "src/large.ts", checksum: "b".repeat(64), text: tooLarge, totalLines: 401,
      })],
      errors: [],
    }, { callId: "rollback-batch" }));
    expect(first.exactContentPromoted).toBe(true);
    expect(batch.safeToVirtualize).toBe(false);
    expect(context.repositoryContext().join("\n")).toContain("EARLIER_LEASE");
  });

  test("checksum drift invalidates snapshot evidence once, not on an unchanged reread", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    context.ingestScan({ files: [{ path: "src/a.ts", bytes: 10, binary: false, tracked: true }] });
    context.ingestToolObservation(toolObservation("fs.read", readData({
      checksum: "a".repeat(64), text: "old",
    })));
    const oldSearch = context.ingestToolObservation(toolObservation("fs.search", {
      matches: [{ path: "src/a.ts", line: 1, text: "old" }], truncated: false,
    }, { callId: "old-search" })).evidence[0]!;
    const oldRun = context.ingestToolObservation(toolObservation("process.run", {}, {
      callId: "old-test", text: "passed", exitCode: 0,
    })).evidence[0]!;
    const changed = context.ingestToolObservation(toolObservation("fs.read", readData({
      checksum: "b".repeat(64), text: "new",
    }), { callId: "changed" }));
    expect(changed.invalidatedEvidenceIds).toEqual(expect.arrayContaining([oldSearch.id, oldRun.id]));
    const freshRun = context.ingestToolObservation(toolObservation("process.run", {}, {
      callId: "fresh-test", text: "passed again", exitCode: 0,
    })).evidence[0]!;
    const unchanged = context.ingestToolObservation(toolObservation("fs.read", readData({
      checksum: "b".repeat(64), text: "new",
    }), { callId: "unchanged" }));
    expect(unchanged.invalidatedEvidenceIds).toHaveLength(0);
    expect(context.evidence.get(freshRun.id)?.freshness).toBe("fresh");
  });

  test("malformed read provenance and empty ranges are never virtualized", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const mismatched = readData({ path: "src/a.ts", text: "body" });
    mismatched.excerpt.path = "src/b.ts";
    const pathResult = context.ingestToolObservation(toolObservation("fs.read", mismatched));
    expect(pathResult.safeToVirtualize).toBe(false);

    const invalidRange = readData({ path: "src/a.ts", text: "body" });
    invalidRange.excerpt.endLine = 0;
    const rangeResult = context.ingestToolObservation(toolObservation("fs.read", invalidRange, { callId: "bad-range" }));
    expect(rangeResult.safeToVirtualize).toBe(false);
  });

  test("an overall failed read_many invalidates every previously fresh requested path", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 96_000 });
    const first = context.ingestToolObservation(toolObservation("fs.read", readData())).evidence[0]!;
    const failed = context.ingestToolObservation(toolObservation("fs.read_many", undefined, {
      callId: "failed-many", ok: false, reads: ["src/a.ts"],
    }));
    expect(failed.invalidatedEvidenceIds).toContain(first.id);
    expect(context.evidence.get(first.id)?.freshness).toBe("invalid");
  });


  test("a child pack cannot release a root promotion lease", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000, activeExcerptTokens: 120 });
    const first = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/root.ts", checksum: "1".repeat(64), text: `ROOT_OWNER_SENTINEL ${"a".repeat(50)}`,
    }), { agentId: "root", callId: "root-owner" }));
    expect(first.exactContentPromoted).toBe(true);
    context.repositoryContext();
    context.markPromptCompiled(first.excerptIds, "child-1");
    context.addExcerpt({
      path: "src/evict.ts", checksum: "2".repeat(64), text: `EVICTION_SENTINEL ${"b".repeat(100)}`,
      totalLines: 1, startLine: 1,
    }, { relevanceScore: 10_000 });
    expect(context.repositoryContext().join("\n")).toContain("ROOT_OWNER_SENTINEL");
    context.markPromptCompiled(first.excerptIds, "root");
  });

  test("a wider child reread transfers rather than drops a pending root owner", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000, activeExcerptTokens: 300 });
    const root = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/shared.ts", checksum: "3".repeat(64), text: "ROOT_NARROW_SENTINEL", totalLines: 3,
    }), { agentId: "root", callId: "narrow-root" }));
    const child = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/shared.ts", checksum: "3".repeat(64), text: "ROOT_NARROW_SENTINEL\nWIDER_CHILD_LINE\nTAIL", totalLines: 3,
    }), { agentId: "child-1", callId: "wide-child" }));
    expect(root.exactContentPromoted).toBe(true);
    expect(child.exactContentPromoted).toBe(true);
    const materialized = context.repositoryContext();
    context.markPromptCompiled(context.lastMaterialization.excerptIds, "child-1");
    context.addExcerpt({
      path: "src/other.ts", checksum: "4".repeat(64), text: "x".repeat(200), totalLines: 1, startLine: 1,
    }, { relevanceScore: 10_000 });
    expect(context.repositoryContext().join("\n")).toContain("ROOT_NARROW_SENTINEL");
    expect(materialized.join("\n")).toContain("WIDER_CHILD_LINE");
  });

  test("complete repository materialization obeys its hard token ceiling", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 1_000, activeExcerptTokens: 120 });
    context.ingestScan({ files: Array.from({ length: 80 }, (_, index) => ({
      path: `src/file-${index}.ts`, bytes: 1_000 + index, binary: false, tracked: true,
    })) });
    for (let index = 0; index < 100; index += 1) {
      context.recordEvidence({
        kind: "tool_observation",
        locator: `src/file-${index % 80}.ts#${"locator".repeat(100)}`,
        digest: `${index}`.padStart(64, "0"),
        observedAt: new Date(index * 1_000).toISOString(),
        summary: `SUMMARY_${index}_${"adversarial".repeat(200)}`,
      });
    }
    const rendered = context.repositoryContext().join("\n\n");
    expect(cachedEstimateTokens(rendered)).toBeLessThanOrEqual(120);
    expect(context.lastMaterialization.estimatedTokens).toBeLessThanOrEqual(120);
    expect(context.lastMaterialization.omitted).toBeGreaterThan(0);
  });


  test("a retained exact excerpt rehydrates provenance after ledger trimming", () => {
    const context = new ContextEngine({
      reader: reader({}), softContextTokens: 4_000, activeExcerptTokens: 200, maxEvidenceRecords: 2,
    });
    const read = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/old.ts", checksum: "9".repeat(64), text: "TRIMMED_PROVENANCE_SENTINEL",
    }), { callId: "old-read" }));
    context.repositoryContext();
    context.markPromptCompiled(read.excerptIds, "root");
    for (let index = 0; index < 8; index += 1) {
      context.recordEvidence({
        kind: "tool_observation", locator: `overflow-${index}`,
        digest: `${index}`.padStart(64, "f"), observedAt: new Date(index * 1_000 + 10).toISOString(),
        summary: `overflow ${index}`,
      });
    }
    expect(context.repositoryContext().join("\n")).toContain("TRIMMED_PROVENANCE_SENTINEL");
    const retainedId = read.excerptIds[0];
    expect(retainedId).toBeDefined();
    if (retainedId === undefined) throw new Error("expected retained excerpt id");
    expect(context.lastMaterialization.excerptIds).toContain(retainedId);
  });


  test("an older asynchronous instruction load cannot overwrite a newer refresh", async () => {
    const pending: Array<(value: string) => void> = [];
    const deferredReader = {
      read: async (path: string) => {
        if (path !== "AGENTS.md") return undefined;
        return await new Promise<string>((resolve) => pending.push(resolve));
      },
    };
    const context = new ContextEngine({ reader: deferredReader, softContextTokens: 4_000 });
    const older = context.loadInstructions({ trusted: true });
    await Promise.resolve();
    const newer = context.refreshInstructionsForPaths([]);
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    pending[1]?.("NEWER_INSTRUCTION");
    await newer;
    pending[0]?.("OLDER_INSTRUCTION");
    await older;
    expect(context.instructions.map((entry) => entry.content).join("\n")).toContain("NEWER_INSTRUCTION");
    expect(context.instructions.map((entry) => entry.content).join("\n")).not.toContain("OLDER_INSTRUCTION");
  });

  test("every budget-admitted locatorized read is present in its owner's immediate pack", () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 4_000,
      activeExcerptTokens: 2_000,
    });
    const promoted: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      const path = `src/tiny-${index}.ts`;
      const result = context.ingestToolObservation(toolObservation(
        "fs.read",
        readData({ path, checksum: index.toString(16).padStart(64, "0"), text: `export const tiny${index}=1;` }),
        { callId: `tiny-${index}` },
      ));
      if (result.safeToVirtualize) promoted.push(...result.excerptIds);
    }
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBeLessThan(64);
    context.repositoryContext({ maxTokens: 2_000 });
    expect(new Set<string>(context.lastMaterialization.excerptIds)).toEqual(new Set<string>(promoted));
    expect(context.lastMaterialization.rejected.filter((entry) => promoted.includes(entry.id))).toEqual([]);
  });

  test("directory invalidation removes descendant excerpts and evidence", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000 });
    const read = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/nested/a.ts", checksum: "e".repeat(64), text: "DIRECTORY_INVALIDATION_SENTINEL",
    })));
    expect(read.safeToVirtualize).toBe(true);
    expect(context.repositoryContext().join("\n")).toContain("DIRECTORY_INVALIDATION_SENTINEL");
    context.invalidate("src", "recursive directory mutation");
    expect(context.repositoryContext().join("\n")).not.toContain("DIRECTORY_INVALIDATION_SENTINEL");
    expect(context.selectEvidence({ ids: read.evidence.map((entry) => entry.id), requireFresh: true }).records).toEqual([]);
  });

  test("unrequested safe-looking read paths never enter evidence or exact context", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000 });
    const result = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "private/notes.txt", checksum: "9".repeat(64), text: "UNBOUND_SECRET_SENTINEL",
    }), { reads: ["public.ts"] }));
    expect(result.safeToVirtualize).toBe(true);
    expect(result.exactContentPromoted).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(context.repositoryContext().join("\n")).not.toContain("UNBOUND_SECRET_SENTINEL");
  });

  test("unbound read_many errors cannot leak response paths or messages into L6", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000 });
    const secret = "UNBOUND_ERROR_SECRET_SENTINEL";
    context.ingestToolObservation(toolObservation("fs.read_many", {
      files: [], errors: [{ path: "private/notes.txt", message: secret }],
    }, { reads: ["public.ts"] }));
    const rendered = context.repositoryContext().join("\n");
    expect(rendered).not.toContain("private/notes.txt");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("sensitive or unbound error");
  });

  test("terminal owner cleanup releases every child promotion lease", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000, activeExcerptTokens: 200 });
    const child = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/child-final.ts", checksum: "a".repeat(64), text: "x".repeat(120),
    }), { agentId: "child-terminal", callId: "child-final-read" }));
    expect(child.excerptIds).toHaveLength(1);
    context.cancelPromotionLeasesForOwner("child-terminal");
    expect(context.activeExcerpts.has(child.excerptIds[0] ?? "missing")).toBe(false);
    const root = context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/root-next.ts", checksum: "b".repeat(64), text: "y".repeat(120),
    }), { agentId: "root", callId: "root-next-read" }));
    expect(root.exactContentPromoted).toBe(true);
  });

  test("a live scan seeds P2 path index and bounded structural retrieval informs selection", () => {
    const context = new ContextEngine({ reader: reader({}), softContextTokens: 4_000 });
    context.ingestScan({ files: [
      file("src/config-loader.ts"),
      file("lib/config-consumer.ts"),
      file("src/unrelated.ts"),
    ] });
    expect(context.repositoryIntelligence.fileCount).toBe(3);
    context.repositoryIntelligence.upsertEdge({
      from: repositoryFileNodeId("src/config-loader.ts"),
      to: repositoryFileNodeId("lib/config-consumer.ts"),
      kind: "imports",
      source: "parser",
    });
    const selected = context.select({ taskText: "Investigate config loader failure" });
    expect(selected.selected.map((entry) => entry.path)).toContain("src/config-loader.ts");
    expect(selected.selected.map((entry) => entry.path)).toContain("lib/config-consumer.ts");
    expect(selected.selected.find((entry) => entry.path === "lib/config-consumer.ts")?.reasons)
      .toContain("a bounded repository-graph neighbor of the retrieval seed");

    context.ingestScan({ files: [file("src/config-loader.ts")] });
    expect(context.repositoryIntelligence.getFile("lib/config-consumer.ts")).toBeUndefined();
  });

  test("prepareSample produces an immutable P1 pack from live fresh engine evidence", async () => {
    const context = new ContextEngine({
      reader: reader({}),
      softContextTokens: 4_000,
      workspaceIdentityDigest: "p1-workspace",
    });
    context.ingestScan({ files: [file("src/config.ts")] });
    context.ingestToolObservation(toolObservation("fs.read", readData({
      path: "src/config.ts", checksum: "c".repeat(64), text: "export const config = true;",
    })));
    const pack = await context.prepareSample({
      id: "p1-live-pack",
      goal: "Inspect src/config.ts",
      phase: "investigate",
      mentionedPaths: ["src/config.ts"],
      mentionedSymbols: [],
      changedPaths: [],
      recentFailureRefs: [],
      workspaceIdentity: "p1-workspace",
      budget: {
        modelContextLimit: 1_000,
        outputReserve: 200,
        hardInputLimit: 700,
        targetInputTokens: 600,
        exactEvidenceFloor: 40,
        explorationCeiling: 200,
      },
    });
    expect(pack.estimatedTokens).toBeLessThanOrEqual(700);
    expect(pack.exactEvidence.some((segment) => segment.item.scope.paths?.includes("src/config.ts"))).toBe(true);
    expect(context.lastCompiledContextPack?.id).toBe(pack.id);
    expect(context.inspect({}).compilerPack?.manifestDigest).toBe(pack.manifest.digest);
    const exactId = pack.exactEvidence[0]?.item.id;
    expect(exactId === undefined ? undefined : context.explainContextItem(exactId)?.id).toBe(exactId);
  });

});
