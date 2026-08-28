/** Atomic Skill catalog registry with progressive disclosure and reload safety. */

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
  type SkillOrigin,
  type SkillPrecedence,
  type SkillScope,
  type SkillSource,
} from "./skill.ts";

export interface SkillFile {
  readonly path: string;
  readonly canonicalPath?: string;
  readonly source: SkillSource;
  readonly scope?: SkillScope;
  readonly origin?: SkillOrigin;
  readonly precedence?: SkillPrecedence;
  /** Full content for eager/in-memory Skills, or frontmatter only at discovery. */
  readonly content: string;
  /** True when content deliberately omits the body. */
  readonly metadataOnly?: boolean;
  /** Stage-2 body read. Never invoked by registration or catalog search. */
  readonly loadContent?: () => Promise<string | undefined>;
}

export interface SkillLoadIssue {
  readonly path: string;
  readonly canonicalPath?: string;
  readonly source: SkillSource;
  readonly scope: SkillScope;
  readonly origin: SkillOrigin;
  readonly field: string;
  readonly message: string;
  readonly line?: number;
  readonly severity: "error" | "warning";
}

export interface SkillShadowRecord {
  readonly name: string;
  readonly winner: SkillDefinition;
  readonly shadowed: SkillDefinition;
  readonly reason: string;
}

export interface SkillDuplicateRecord {
  readonly canonicalPath: string;
  readonly winnerPath: string;
  readonly duplicatePath: string;
  readonly reason: string;
}

export interface PreparedSkillRegistrySnapshot {
  readonly files: readonly SkillFile[];
  readonly definitions: readonly SkillDefinition[];
  readonly loaders: ReadonlyArray<readonly [string, () => Promise<string | undefined>]>;
  readonly shadowRecords: readonly SkillShadowRecord[];
  readonly deduplicated: readonly SkillDuplicateRecord[];
  readonly issues: readonly SkillLoadIssue[];
}

export interface RegisterResult {
  readonly registered: SkillDefinition[];
  /** Definitions a higher-precedence candidate shadowed. */
  readonly shadowed: SkillDefinition[];
  readonly shadowRecords: SkillShadowRecord[];
  readonly deduplicated: SkillDuplicateRecord[];
  readonly issues: SkillLoadIssue[];
  readonly revision: number;
  readonly invalidated: string[];
}

export interface ReferenceRead {
  readonly path: string;
  readonly content: string;
}

export interface RegistryOptions {
  /** Product version checked only against x-capybara-requires. */
  readonly productVersion: string;
  /** A project Skill body is never loaded from an untrusted workspace. */
  readonly workspaceTrusted: boolean;
  readonly maxReferenceBytes?: number;
}

export const DEFAULT_MAX_REFERENCE_BYTES = 64 * 1024;

export class SkillRegistry {
  readonly #options: RegistryOptions;
  #byName = new Map<string, SkillDefinition>();
  #shadowRecords: SkillShadowRecord[] = [];
  #deduplicated: SkillDuplicateRecord[] = [];
  #loaded = new Set<string>();
  #issues: SkillLoadIssue[] = [];
  #loaders = new Map<string, () => Promise<string | undefined>>();
  readonly #loading = new Map<string, Promise<SkillLoadResult>>();
  #files: SkillFile[] = [];
  #revision = 0;

  constructor(options: RegistryOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#byName.size;
  }

  get revision(): number {
    return this.#revision;
  }

  get workspaceTrusted(): boolean {
    return this.#options.workspaceTrusted;
  }

  /** Parse a complete candidate set without mutating the active catalog. */
  prepare(files: readonly SkillFile[]): PreparedSkillRegistrySnapshot {
    const ordered = [...files].sort(compareSkillFiles);
    const definitions = new Map<string, SkillDefinition>();
    const winnerFiles = new Map<string, SkillFile>();
    const loaders = new Map<string, () => Promise<string | undefined>>();
    const shadowRecords: SkillShadowRecord[] = [];
    const deduplicated: SkillDuplicateRecord[] = [];
    const issues: SkillLoadIssue[] = [];
    const canonicalWinners = new Map<string, SkillFile>();

    for (const file of ordered) {
      const canonicalPath = normalizePath(file.canonicalPath ?? file.path);
      const canonicalKey = canonicalPathKey(canonicalPath);
      const canonicalWinner = canonicalWinners.get(canonicalKey);
      if (canonicalWinner !== undefined) {
        deduplicated.push({
          canonicalPath,
          winnerPath: canonicalWinner.path,
          duplicatePath: file.path,
          reason: "same canonical SKILL.md",
        });
        continue;
      }
      canonicalWinners.set(canonicalKey, file);

      const scope = file.scope ?? scopeForSource(file.source);
      const origin = file.origin ?? originForSource(file.source);
      const parsed = parseSkill(file.content, {
        path: file.path,
        canonicalPath,
        source: file.source,
        scope,
        origin,
        ...(file.precedence !== undefined ? { precedence: file.precedence } : {}),
        allowEmptyBody:
          file.metadataOnly === true ||
          (isProjectSource(file.source, scope) && !this.#options.workspaceTrusted),
      });

      for (const issue of parsed.issues) {
        issues.push({
          path: file.path,
          canonicalPath,
          source: file.source,
          scope,
          origin,
          field: issue.field,
          message: issue.message,
          ...(issue.line !== undefined ? { line: issue.line } : {}),
          severity: issue.severity ?? "error",
        });
      }

      const definition = parsed.definition;
      if (definition === undefined) continue;

      const requires = definition.manifest.requiresCapybara;
      if (!satisfiesCompatibility(this.#options.productVersion, requires)) {
        issues.push({
          path: file.path,
          canonicalPath,
          source: file.source,
          scope,
          origin,
          field: "x-capybara-requires",
          message: `requires ${requires}, but this build is ${this.#options.productVersion}`,
          severity: "error",
        });
        continue;
      }

      const name = definition.manifest.name;
      const existing = definitions.get(name);
      if (existing !== undefined) {
        const winnerFile = winnerFiles.get(name);
        shadowRecords.push({
          name,
          winner: existing,
          shadowed: definition,
          reason: `lower precedence than ${winnerFile?.path ?? existing.path}`,
        });
        continue;
      }

      definitions.set(name, definition);
      winnerFiles.set(name, file);
      if (file.loadContent !== undefined) loaders.set(name, file.loadContent);
    }

    return {
      files: [...files],
      definitions: [...definitions.values()].sort(compareDefinitionsByName),
      loaders: [...loaders.entries()],
      shadowRecords,
      deduplicated,
      issues,
    };
  }

  /** Atomically replace the active catalog with a fully prepared snapshot. */
  replace(snapshot: PreparedSkillRegistrySnapshot): RegisterResult {
    const nextByName = new Map<string, SkillDefinition>();
    const nextLoaded = new Set<string>();
    const invalidated: string[] = [];

    for (const definition of snapshot.definitions) {
      const old = this.#byName.get(definition.manifest.name);
      if (
        old !== undefined &&
        this.#loaded.has(definition.manifest.name) &&
        old.body.length > 0 &&
        manifestFingerprint(old) === manifestFingerprint(definition)
      ) {
        nextByName.set(definition.manifest.name, old);
        nextLoaded.add(definition.manifest.name);
      } else {
        nextByName.set(definition.manifest.name, definition);
        if (old !== undefined && this.#loaded.has(definition.manifest.name)) {
          invalidated.push(definition.manifest.name);
        }
      }
    }
    for (const name of this.#loaded) {
      if (!nextByName.has(name)) invalidated.push(name);
    }

    this.#byName = nextByName;
    this.#loaded = nextLoaded;
    this.#loaders = new Map(snapshot.loaders);
    this.#shadowRecords = [...snapshot.shadowRecords];
    this.#deduplicated = [...snapshot.deduplicated];
    this.#issues = [...snapshot.issues];
    this.#files = [...snapshot.files];
    this.#revision += 1;
    // Existing promises cannot be cancelled, but their captured revision makes
    // them discard results instead of writing into this new catalog.
    this.#loading.clear();

    return {
      registered: this.all(),
      shadowed: this.#shadowRecords.map((record) => record.shadowed),
      shadowRecords: [...this.#shadowRecords],
      deduplicated: [...this.#deduplicated],
      issues: [...this.#issues],
      revision: this.#revision,
      invalidated: [...new Set(invalidated)].sort(compareText),
    };
  }

  /** Backwards-compatible append API; discovery v2 uses prepare + replace. */
  register(files: readonly SkillFile[]): RegisterResult {
    return this.replace(this.prepare([...this.#files, ...files]));
  }

  all(): SkillDefinition[] {
    return [...this.#byName.values()].sort(compareDefinitionsByName);
  }

  get(name: string): SkillDefinition | undefined {
    return this.#byName.get(name);
  }

  shadowedDefinitions(): SkillDefinition[] {
    return this.#shadowRecords.map((record) => record.shadowed);
  }

  shadowRecords(): SkillShadowRecord[] {
    return [...this.#shadowRecords];
  }

  duplicateRecords(): SkillDuplicateRecord[] {
    return [...this.#deduplicated];
  }

  issues(): SkillLoadIssue[] {
    return [...this.#issues];
  }

  catalog(): SkillCatalogEntry[] {
    return this.all().map(catalogEntry);
  }

  promptCatalog(): SkillMetadata[] {
    return this.all().map((definition) => ({
      name: definition.manifest.name,
      description: definition.manifest.description,
      ...(definition.manifest.version !== undefined ? { version: definition.manifest.version } : {}),
      source: definition.source,
      ...(definition.manifest.risk !== undefined ? { risk: definition.manifest.risk } : {}),
    }));
  }

  loadedNames(): string[] {
    return [...this.#loaded].sort(compareText);
  }

  isLoaded(name: string): boolean {
    return this.#loaded.has(name);
  }

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

    const revision = this.#revision;
    const loading = this.#loadLazy(name, definition, loader, revision);
    this.#loading.set(name, loading);
    try {
      return await loading;
    } finally {
      if (this.#loading.get(name) === loading) this.#loading.delete(name);
    }
  }

  async #loadLazy(
    name: string,
    catalogued: SkillDefinition,
    loader: () => Promise<string | undefined>,
    revision: number,
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
    if (revision !== this.#revision || this.#byName.get(name) !== catalogued) {
      return {
        ok: false,
        reason: `the Skill catalog changed while '${name}' was loading; retry against revision ${this.#revision}`,
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
      canonicalPath: catalogued.canonicalPath,
      source: catalogued.source,
      scope: catalogued.scope,
      origin: catalogued.origin,
      directory: catalogued.directory,
      ...(catalogued.precedence !== undefined ? { precedence: catalogued.precedence } : {}),
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
        reason: `the manifest for '${name}' changed after discovery; run /skills reload`,
        available: this.all().map((skill) => skill.manifest.name),
      };
    }

    this.#byName.set(name, loaded);
    return this.#activate(name, loaded);
  }

  #activate(name: string, definition: SkillDefinition): SkillLoadResult {
    this.#loaded.add(name);
    return {
      ok: true,
      definition,
      references: referencedFiles(definition.body).map((path) => ({
        path,
        contained: isContainedReference(path),
      })),
      injectionIndicators: scanForInjection(definition.body),
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
    if (!isProjectSource(definition.source, definition.scope) || this.#options.workspaceTrusted) {
      return undefined;
    }
    return {
      ok: false,
      reason: `'${definition.manifest.name}' comes from an untrusted project (${definition.path}); trust the workspace to load it`,
      available: this.all().map((skill) => skill.manifest.name),
    };
  }

  unload(name: string): boolean {
    return this.#loaded.delete(name);
  }

  loadedBodies(): Array<{ name: string; body: string; source: string }> {
    const out: Array<{ name: string; body: string; source: string }> = [];
    for (const name of this.loadedNames()) {
      const definition = this.#byName.get(name);
      if (definition !== undefined) out.push({ name, body: definition.body, source: definition.source });
    }
    return out;
  }

  resolveReference(name: string, reference: string): ReferenceResolution {
    const definition = this.#byName.get(name);
    if (definition === undefined) return { ok: false, reason: `no skill named '${name}' is registered` };
    if (!this.#loaded.has(name)) return { ok: false, reason: `'${name}' has not been loaded; call skill.load first` };
    if (!isContainedReference(reference)) {
      return { ok: false, reason: `reference '${reference}' escapes the skill directory (SKILL-005)` };
    }
    const prefix = definition.directory.length > 0 ? `${definition.directory}/` : "";
    return { ok: true, path: `${prefix}${reference}`, maxBytes: this.#options.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES };
  }

  search(query: string, limit = 5): Array<{ entry: SkillCatalogEntry; score: number }> {
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    if (tokens.length === 0) return [];
    return this.all()
      .map((definition) => {
        const haystacks: Array<{ text: string; weight: number }> = [
          { text: definition.manifest.name, weight: 3 },
          { text: (definition.manifest.tags ?? []).join(" "), weight: 2 },
          { text: definition.manifest.description, weight: 1 },
        ];
        let score = 0;
        for (const field of haystacks) {
          const lowered = field.text.toLowerCase();
          const words = lowered.split(/[^a-z0-9]+/);
          for (const token of tokens) {
            if (words.includes(token)) score += field.weight;
            else if (lowered.includes(token)) score += field.weight * 0.5;
          }
        }
        return { entry: catalogEntry(definition), score: Math.round((score / tokens.length) * 1_000) / 1_000 };
      })
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || compareText(left.entry.name, right.entry.name))
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
    license: manifest.license ?? null,
    compatibility: manifest.compatibility ?? null,
    metadata: manifest.metadata ?? null,
    requiresCapybara: manifest.requiresCapybara ?? null,
    version: manifest.version ?? null,
    requestedTools: manifest.requestedTools ?? null,
    risk: manifest.risk ?? null,
    modelProfile: manifest.modelProfile ?? null,
    tags: manifest.tags ?? null,
    userInvocable: manifest.userInvocable,
    allowedPaths: manifest.allowedPaths ?? null,
    source: definition.source,
    scope: definition.scope,
    origin: definition.origin,
    path: definition.path,
    canonicalPath: definition.canonicalPath,
    directory: definition.directory,
    precedence: definition.precedence ?? null,
  });
}

function compareSkillFiles(left: SkillFile, right: SkillFile): number {
  const a = left.precedence ?? fallbackPrecedence(left);
  const b = right.precedence ?? fallbackPrecedence(right);
  for (let index = 0; index < 4; index += 1) {
    const difference = Number(a[index] ?? 0) - Number(b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const byPath = compareText(a[4], b[4]);
  return byPath !== 0 ? byPath : compareText(left.path, right.path);
}

function fallbackPrecedence(file: SkillFile): SkillPrecedence {
  const scope = file.scope ?? scopeForSource(file.source);
  const origin = file.origin ?? originForSource(file.source);
  const scopeRank = scope === "project" ? 0 : scope === "user" ? 1 : 2;
  const originRank: Readonly<Record<SkillOrigin, number>> = {
    explicit: 0,
    capybara: 1,
    opencode: 2,
    agents: 3,
    claude: 4,
    legacy: 5,
    bundled: 9,
  };
  return [scopeRank, scope === "project" ? 0 : Number.MAX_SAFE_INTEGER, originRank[origin], 0, normalizePath(file.canonicalPath ?? file.path)];
}

function scopeForSource(source: SkillSource): SkillScope {
  return source === "builtin" ? "builtin" : source === "user" ? "user" : "project";
}

function originForSource(source: SkillSource): SkillOrigin {
  return source === "builtin" ? "bundled" : source === "agents-dir" ? "agents" : "capybara";
}

function compareDefinitionsByName(left: SkillDefinition, right: SkillDefinition): number {
  return compareText(left.manifest.name, right.manifest.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function canonicalPathKey(path: string): string {
  const normalized = normalizePath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderSkillList(entries: readonly SkillCatalogEntry[]): string[] {
  if (entries.length === 0) return ["No skills are available."];
  const nameWidth = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
  const lines = [`${entries.length} skill(s) available:`];
  for (const entry of entries) {
    const version = entry.version !== undefined ? ` v${entry.version}` : "";
    const risk = entry.risk !== undefined ? ` risk:${entry.risk}` : "";
    lines.push(`  $${entry.name.padEnd(nameWidth)}  [${entry.scope}/${entry.origin}${version}${risk}]  ${entry.description}`);
  }
  return lines;
}

export function renderSkillDetail(definition: SkillDefinition): string[] {
  const manifest = definition.manifest;
  const lines = [
    `$${manifest.name}${manifest.version !== undefined ? ` v${manifest.version}` : ""}`,
    manifest.description,
    "",
    `Source        ${definition.scope}/${definition.origin}`,
    `Path          ${definition.path}`,
    `Canonical     ${definition.canonicalPath}`,
  ];
  if (manifest.license !== undefined) lines.push(`License       ${manifest.license}`);
  if (manifest.risk !== undefined) lines.push(`Risk          ${manifest.risk}`);
  if (manifest.compatibility !== undefined) lines.push(`Compatibility ${manifest.compatibility}`);
  if (manifest.requiresCapybara !== undefined) lines.push(`Requires      Capybara ${manifest.requiresCapybara}`);
  if (manifest.modelProfile !== undefined) lines.push(`Model profile ${manifest.modelProfile}`);
  if (manifest.requestedTools !== undefined) {
    lines.push(`Requests      ${manifest.requestedTools.join(", ")}`);
    lines.push("              (a request only; host policy decides)");
  }
  if (manifest.metadata !== undefined && Object.keys(manifest.metadata).length > 0) {
    lines.push(`Metadata      ${Object.entries(manifest.metadata).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  if (manifest.tags !== undefined && manifest.tags.length > 0) lines.push(`Tags          ${manifest.tags.join(", ")}`);
  lines.push(`Invocable     ${manifest.userInvocable ? "yes" : "no (model-selected only)"}`);
  return lines;
}
