/**
 * Skill registry — PRD §16.2, §16.4, §16.5, §16.6, SKILL-001, SKILL-002,
 * SKILL-004, SKILL-006, AC-26, AC-28.
 *
 * §16.4's three stages are the load-bearing structure:
 *
 * 1. catalog — name, description, risk, source. This is *all* that reaches the
 *    startup prompt (SKILL-001), which keeps the §10.9 cached prefix small.
 * 2. load — the full `SKILL.md` body, only when `skill.load` is called.
 * 3. reference read — individual reference files, only when the body asks.
 *
 * Collapsing these stages would put every Skill body in every request, which is
 * exactly what SKILL-001 exists to prevent.
 */

import type { SkillMetadata } from "@cbc/inference-domain";

import {
  catalogEntry,
  isContainedReference,
  isProjectSource,
  parseSkill,
  referencedFiles,
  satisfiesCompatibility,
  scanForInjection,
  type InjectionIndicator,
  type SkillCatalogEntry,
  type SkillDefinition,
  type SkillSource,
} from "./skill.ts";

/** §16.2 precedence: lower number wins. */
const SOURCE_RANK: Readonly<Record<SkillSource, number>> = {
  "agents-dir": 0,
  project: 1,
  user: 2,
  builtin: 3,
};

export interface SkillFile {
  readonly path: string;
  readonly source: SkillSource;
  /** Full content for eager/in-memory Skills, or frontmatter only at discovery. */
  readonly content: string;
  /** True when `content` deliberately omits the body. */
  readonly metadataOnly?: boolean;
  /** Stage-2 body read. Never invoked by registration or catalog search. */
  readonly loadContent?: () => Promise<string | undefined>;
}

export interface SkillLoadIssue {
  readonly path: string;
  readonly source: SkillSource;
  readonly field: string;
  readonly message: string;
  readonly line?: number;
}

export interface RegisterResult {
  readonly registered: SkillDefinition[];
  /** Definitions a nearer scope shadowed (§16.2 keeps them visible). */
  readonly shadowed: SkillDefinition[];
  readonly issues: SkillLoadIssue[];
}

export interface ReferenceRead {
  readonly path: string;
  readonly content: string;
}

export interface RegistryOptions {
  /** Product version, checked against each Skill's `compatibility` (§16.3). */
  readonly productVersion: string;
  /** §13.6: a project Skill's body is not loaded from an untrusted workspace. */
  readonly workspaceTrusted: boolean;
  /** Cap on a single reference file. §16.6 requires a references size limit. */
  readonly maxReferenceBytes?: number;
}

export const DEFAULT_MAX_REFERENCE_BYTES = 64 * 1024;

/**
 * Holds the catalog and tracks which Skills have been loaded this session.
 */
export class SkillRegistry {
  readonly #options: RegistryOptions;
  readonly #byName = new Map<string, SkillDefinition>();
  readonly #shadowed: SkillDefinition[] = [];
  readonly #loaded = new Set<string>();
  readonly #issues: SkillLoadIssue[] = [];
  readonly #loaders = new Map<string, () => Promise<string | undefined>>();
  readonly #loading = new Map<string, Promise<SkillLoadResult>>();

  constructor(options: RegistryOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#byName.size;
  }

  /**
   * Parse and register a batch of `SKILL.md` files.
   *
   * Files are sorted by §16.2 precedence first, so the nearest scope claims each
   * name and later duplicates are recorded as shadowed rather than overwriting.
   */
  register(files: readonly SkillFile[]): RegisterResult {
    const registered: SkillDefinition[] = [];
    const shadowed: SkillDefinition[] = [];
    const issues: SkillLoadIssue[] = [];

    const ordered = [...files].sort(
      (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.path.localeCompare(b.path),
    );

    for (const file of ordered) {
      const parsed = parseSkill(file.content, {
        path: file.path,
        source: file.source,
        // §13.6 / AC-28: an untrusted project Skill arrives metadata-only (its
        // body stripped at discovery), so the empty body must not be fatal — the
        // entry is listed, and `load` keeps refusing until the workspace is
        // trusted.
        allowEmptyBody:
          file.metadataOnly === true ||
          (isProjectSource(file.source) && !this.#options.workspaceTrusted),
      });

      for (const issue of parsed.issues) {
        issues.push({
          path: file.path,
          source: file.source,
          field: issue.field,
          message: issue.message,
          ...(issue.line !== undefined ? { line: issue.line } : {}),
        });
      }

      const definition = parsed.definition;
      // SKILL-004: an invalid Skill reports its source path and errors, and is
      // simply not registered.
      if (definition === undefined) continue;

      const compatibility = definition.manifest.compatibility;
      if (!satisfiesCompatibility(this.#options.productVersion, compatibility)) {
        issues.push({
          path: file.path,
          source: file.source,
          field: "compatibility",
          message: `requires ${compatibility}, but this build is ${this.#options.productVersion}`,
        });
        continue;
      }

      const existing = this.#byName.get(definition.manifest.name);
      if (existing !== undefined) {
        // §16.2: the nearer scope already won; keep the loser visible.
        shadowed.push(definition);
        this.#shadowed.push(definition);
        continue;
      }

      this.#byName.set(definition.manifest.name, definition);
      if (file.loadContent !== undefined) {
        this.#loaders.set(definition.manifest.name, file.loadContent);
      }
      registered.push(definition);
    }

    this.#issues.push(...issues);
    return { registered, shadowed, issues };
  }

  /** Everything registered, sorted by name. */
  all(): SkillDefinition[] {
    return [...this.#byName.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
  }

  get(name: string): SkillDefinition | undefined {
    return this.#byName.get(name);
  }

  shadowedDefinitions(): SkillDefinition[] {
    return [...this.#shadowed];
  }

  issues(): SkillLoadIssue[] {
    return [...this.#issues];
  }

  /** §16.4 stage 1. The only Skill data allowed in the startup prompt. */
  catalog(): SkillCatalogEntry[] {
    return this.all().map(catalogEntry);
  }

  /** The stage-1 catalog in the shape `PromptInputs.skillCatalog` expects. */
  promptCatalog(): SkillMetadata[] {
    return this.all().map((definition) => ({
      name: definition.manifest.name,
      description: definition.manifest.description,
      ...(definition.manifest.version !== undefined
        ? { version: definition.manifest.version }
        : {}),
      source: definition.source,
      ...(definition.manifest.risk !== undefined ? { risk: definition.manifest.risk } : {}),
    }));
  }

  /** Names loaded this session (§16.4 stage 2). */
  loadedNames(): string[] {
    return [...this.#loaded].sort();
  }

  isLoaded(name: string): boolean {
    return this.#loaded.has(name);
  }

  /**
   * §16.4 stage 2 — load one Skill body by name.
   *
   * SKILL-002 requires `$name` to be deterministic, so this is a map lookup, never
   * a fuzzy match. AC-28 is enforced here: a project Skill from an untrusted
   * workspace is refused rather than loaded.
   */
  load(name: string): SkillLoadResult {
    const definition = this.#byName.get(name);
    if (definition === undefined) return this.#missing(name);

    const trustRefusal = this.#trustRefusal(definition);
    if (trustRefusal !== undefined) return trustRefusal;
    if (definition.body.length === 0) {
      return {
        ok: false,
        reason: `the body for '${name}' is catalogued but has not been read; use the asynchronous skill.load path`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }
    return this.#activate(name, definition);
  }

  /**
   * Stage-2 load for on-disk Skills. Concurrent calls share one read, and the
   * body is accepted only if its manifest still matches the catalog metadata
   * observed at startup (TOCTOU-safe deterministic `$name` selection).
   */
  async loadAsync(name: string): Promise<SkillLoadResult> {
    const definition = this.#byName.get(name);
    if (definition === undefined) return this.#missing(name);

    const trustRefusal = this.#trustRefusal(definition);
    if (trustRefusal !== undefined) return trustRefusal;
    if (definition.body.length > 0) return this.#activate(name, definition);

    const pending = this.#loading.get(name);
    if (pending !== undefined) return await pending;
    const loader = this.#loaders.get(name);
    if (loader === undefined) {
      return {
        ok: false,
        reason: `the body for '${name}' is unavailable (${definition.path})`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }

    const loading = this.#loadLazy(name, definition, loader);
    this.#loading.set(name, loading);
    try {
      return await loading;
    } finally {
      this.#loading.delete(name);
    }
  }

  async #loadLazy(
    name: string,
    catalogued: SkillDefinition,
    loader: () => Promise<string | undefined>,
  ): Promise<SkillLoadResult> {
    let content: string | undefined;
    try {
      content = await loader();
    } catch (error) {
      return {
        ok: false,
        reason: `could not read '${name}' from ${catalogued.path}: ${describe(error)}`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }
    if (content === undefined) {
      return {
        ok: false,
        reason: `the body for '${name}' no longer exists at ${catalogued.path}`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }

    const parsed = parseSkill(content, {
      path: catalogued.path,
      source: catalogued.source,
      directory: catalogued.directory,
    });
    const loaded = parsed.definition;
    if (loaded === undefined) {
      const detail = parsed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
      return {
        ok: false,
        reason: `the body for '${name}' is no longer a valid Skill${detail.length > 0 ? `: ${detail}` : ""}`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }
    if (manifestFingerprint(loaded) !== manifestFingerprint(catalogued)) {
      return {
        ok: false,
        reason: `the manifest for '${name}' changed after discovery; restart to refresh the Skill catalog`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }

    this.#byName.set(name, loaded);
    return this.#activate(name, loaded);
  }

  #activate(name: string, definition: SkillDefinition): SkillLoadResult {
    this.#loaded.add(name);
    const indicators = scanForInjection(definition.body);
    const references = referencedFiles(definition.body);
    return {
      ok: true,
      definition,
      references: references.map((path) => ({
        path,
        contained: isContainedReference(path),
      })),
      injectionIndicators: indicators,
    };
  }

  #missing(name: string): SkillLoadResult {
    return {
      ok: false,
      reason: `no skill named '${name}' is registered`,
      available: this.all().map((skill) => skill.manifest.name),
    };
  }

  #trustRefusal(definition: SkillDefinition): SkillLoadResult | undefined {
    if (!isProjectSource(definition.source) || this.#options.workspaceTrusted) return undefined;
    return {
      ok: false,
      reason: `'${definition.manifest.name}' comes from an untrusted project (${definition.path}); trust the workspace to load it`,
      available: this.all().map((skill) => skill.manifest.name),
    };
  }

  /** Forget a loaded body, e.g. when compaction drops it from context. */
  unload(name: string): boolean {
    return this.#loaded.delete(name);
  }

  /** Loaded bodies in the shape `PromptInputs.loadedSkills` expects. */
  loadedBodies(): Array<{ name: string; body: string; source: string }> {
    const out: Array<{ name: string; body: string; source: string }> = [];
    for (const name of this.loadedNames()) {
      const definition = this.#byName.get(name);
      if (definition === undefined) continue;
      out.push({ name, body: definition.body, source: definition.source });
    }
    return out;
  }

  /**
   * §16.4 stage 3 — resolve a reference read request.
   *
   * Returns the workspace path to read, or a refusal. SKILL-005 is enforced before
   * any read is attempted; the Rust guard checks again at read time (§14.2).
   */
  resolveReference(name: string, reference: string): ReferenceResolution {
    const definition = this.#byName.get(name);
    if (definition === undefined) {
      return { ok: false, reason: `no skill named '${name}' is registered` };
    }
    if (!this.#loaded.has(name)) {
      // Stage 3 follows stage 2: a reference is only meaningful once the body that
      // names it is in context.
      return { ok: false, reason: `'${name}' has not been loaded; call skill.load first` };
    }
    if (!isContainedReference(reference)) {
      return {
        ok: false,
        reason: `reference '${reference}' escapes the skill directory (SKILL-005)`,
      };
    }

    const prefix = definition.directory.length > 0 ? `${definition.directory}/` : "";
    return { ok: true, path: `${prefix}${reference}`, maxBytes: this.#maxReferenceBytes() };
  }

  #maxReferenceBytes(): number {
    return this.#options.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES;
  }

  /**
   * §16.5 `$name` completion and NL search. Ranking is over stage-1 metadata only,
   * so search never forces a body to load.
   */
  search(query: string, limit = 5): Array<{ entry: SkillCatalogEntry; score: number }> {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    if (tokens.length === 0) return [];

    const scored = this.all().map((definition) => {
      const haystacks: Array<{ text: string; weight: number }> = [
        { text: definition.manifest.name, weight: 3 },
        { text: (definition.manifest.tags ?? []).join(" "), weight: 2 },
        { text: definition.manifest.description, weight: 1 },
      ];
      let score = 0;
      for (const field of haystacks) {
        const words = field.text.toLowerCase().split(/[^a-z0-9]+/);
        for (const token of tokens) {
          if (words.includes(token)) score += field.weight;
          else if (field.text.toLowerCase().includes(token)) score += field.weight * 0.5;
        }
      }
      return {
        entry: catalogEntry(definition),
        score: Math.round((score / tokens.length) * 1000) / 1000,
      };
    });

    return scored
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit);
  }
}

export type SkillLoadResult =
  | {
      readonly ok: true;
      readonly definition: SkillDefinition;
      readonly references: Array<{ path: string; contained: boolean }>;
      readonly injectionIndicators: InjectionIndicator[];
    }
  | { readonly ok: false; readonly reason: string; readonly available: string[] };

export type ReferenceResolution =
  | { readonly ok: true; readonly path: string; readonly maxBytes: number }
  | { readonly ok: false; readonly reason: string };


function manifestFingerprint(definition: SkillDefinition): string {
  const manifest = definition.manifest;
  return JSON.stringify({
    name: manifest.name,
    description: manifest.description,
    version: manifest.version ?? null,
    compatibility: manifest.compatibility ?? null,
    requestedTools: manifest.requestedTools ?? null,
    risk: manifest.risk ?? null,
    modelProfile: manifest.modelProfile ?? null,
    tags: manifest.tags ?? null,
    userInvocable: manifest.userInvocable,
    allowedPaths: manifest.allowedPaths ?? null,
    source: definition.source,
    path: definition.path,
    directory: definition.directory,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render the §16.5 `/skills` list.
 *
 * The source is always shown, because §16.2 requires it and because "which
 * `code-review` am I about to run" is the question a user actually has.
 */
export function renderSkillList(entries: readonly SkillCatalogEntry[]): string[] {
  if (entries.length === 0) return ["No skills are available."];

  const nameWidth = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
  const lines = [`${entries.length} skill(s) available:`];
  for (const entry of entries) {
    const version = entry.version !== undefined ? ` v${entry.version}` : "";
    const risk = entry.risk !== undefined ? ` risk:${entry.risk}` : "";
    lines.push(
      `  $${entry.name.padEnd(nameWidth)}  [${entry.source}${version}${risk}]  ${entry.description}`,
    );
  }
  return lines;
}

/** Render the detail view for `/skills <name>`. */
export function renderSkillDetail(definition: SkillDefinition): string[] {
  const manifest = definition.manifest;
  const lines = [
    `$${manifest.name}${manifest.version !== undefined ? ` v${manifest.version}` : ""}`,
    manifest.description,
    "",
    `Source        ${definition.source} (${definition.path})`,
  ];
  if (manifest.risk !== undefined) lines.push(`Risk          ${manifest.risk}`);
  if (manifest.compatibility !== undefined) {
    lines.push(`Compatibility ${manifest.compatibility}`);
  }
  if (manifest.modelProfile !== undefined) lines.push(`Model profile ${manifest.modelProfile}`);
  if (manifest.requestedTools !== undefined) {
    // Worded as a request so the reader is not misled into thinking it is a grant.
    lines.push(`Requests      ${manifest.requestedTools.join(", ")}`);
    lines.push("              (a request only; host policy decides — §16.6)");
  }
  if (manifest.tags !== undefined && manifest.tags.length > 0) {
    lines.push(`Tags          ${manifest.tags.join(", ")}`);
  }
  lines.push(`Invocable     ${manifest.userInvocable ? "yes" : "no (model-selected only)"}`);
  return lines;
}
