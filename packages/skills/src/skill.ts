/**
 * Skill definitions and trust rules — PRD §16.1, §16.3, §16.6, AC-27, SKILL-003.
 */

import type { RiskClass, ToolDefinition } from "@cbc/tool-registry";

import {
  booleanField,
  listField,
  mapField,
  parseFrontmatter,
  scalarField,
  type FrontmatterIssue,
} from "./frontmatter.ts";

/**
 * §16.2 discovery locations, nearest first.
 *
 * §16.2's precedence rule — a nearer project scope wins, but the source stays
 * visible in the UI — is why `SkillSource` is carried on every definition rather
 * than being resolved away.
 */
export const SKILL_SEARCH_ROOTS: readonly { source: SkillSource; root: string }[] = [
  { source: "project", root: ".capybara/skills" },
  { source: "project", root: ".opencode/skills" },
  { source: "agents-dir", root: ".agents/skills" },
  { source: "project", root: ".claude/skills" },
  { source: "user", root: "<resolved config>/skills" },
  { source: "user", root: "~/.config/opencode/skills" },
  { source: "user", root: "~/.agents/skills" },
  { source: "user", root: "~/.claude/skills" },
  { source: "builtin", root: "<bundled>" },
];

export type SkillSource = "agents-dir" | "project" | "user" | "builtin";
export type SkillScope = "project" | "user" | "builtin";
export type SkillOrigin =
  | "explicit"
  | "capybara"
  | "opencode"
  | "agents"
  | "claude"
  | "legacy"
  | "bundled";
export type SkillPrecedence = readonly [number, number, number, number, string];

/**
 * Whether a source is workspace-supplied and therefore untrusted content (§16.6).
 * A user-level or bundled Skill was installed deliberately by the operator.
 */
export function isProjectSource(source: SkillSource, scope?: SkillScope): boolean {
  return scope === "project" || source === "agents-dir" || source === "project";
}

/** §16.3 `risk` values. */
export type SkillRisk = "read" | "write" | "process" | "network";

export const SKILL_RISKS: readonly SkillRisk[] = ["read", "write", "process", "network"];

/** Highest CBC risk class a Skill's declared risk implies. */
export function riskCeiling(risk: SkillRisk | undefined): RiskClass {
  switch (risk) {
    case "write":
      return "R2";
    case "process":
      return "R3";
    case "network":
      return "R3";
    case "read":
      return "R0";
    default:
      // An undeclared risk is not assumed safe.
      return "R3";
  }
}

/** §16.3 frontmatter, after validation. */
export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  /** Agent Skills environment note; informational, never a version gate. */
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Capybara product-version gate. */
  readonly requiresCapybara?: string;
  readonly version?: string;
  /**
   * §16.6: "frontmatter tool list은 권한 부여가 아니라 request declaration".
   * This is an upper bound the host may narrow, never a grant.
   */
  readonly requestedTools?: readonly string[];
  readonly risk?: SkillRisk;
  readonly modelProfile?: string;
  readonly tags?: readonly string[];
  readonly userInvocable: boolean;
  readonly allowedPaths?: readonly string[];
}

export interface SkillDefinition {
  readonly manifest: SkillManifest;
  /** Full `SKILL.md` body. Loaded at §16.4 stage 2, never at startup. */
  readonly body: string;
  readonly source: SkillSource;
  readonly scope: SkillScope;
  readonly origin: SkillOrigin;
  /** Path of the `SKILL.md` itself. */
  readonly path: string;
  readonly canonicalPath: string;
  /** Directory the Skill owns; references may not escape it (SKILL-005). */
  readonly directory: string;
  readonly precedence?: SkillPrecedence;
}

/** §16.4 stage 1: the only thing in the startup prompt (SKILL-001). */
export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk?: SkillRisk;
  readonly source: SkillSource;
  readonly scope: SkillScope;
  readonly origin: SkillOrigin;
  readonly version?: string;
  readonly userInvocable: boolean;
}

export function catalogEntry(definition: SkillDefinition): SkillCatalogEntry {
  return {
    name: definition.manifest.name,
    description: definition.manifest.description,
    ...(definition.manifest.risk !== undefined ? { risk: definition.manifest.risk } : {}),
    source: definition.source,
    scope: definition.scope,
    origin: definition.origin,
    ...(definition.manifest.version !== undefined
      ? { version: definition.manifest.version }
      : {}),
    userInvocable: definition.manifest.userInvocable,
  };
}

export interface SkillParseResult {
  readonly definition?: SkillDefinition;
  readonly issues: FrontmatterIssue[];
}

/** §16.3 known fields. Anything else is reported so typos surface. */
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "version",
  "compatibility",
  "metadata",
  "tools",
  "risk",
  "model_profile",
  "tags",
  "user_invocable",
  "allowed_paths",
  "allowed-tools",
  "x-capybara-requires",
  "x-capybara-version",
  "x-capybara-risk",
  "x-capybara-model-profile",
  "x-capybara-user-invocable",
  "x-capybara-allowed-paths",
]);

/** §16.3 requires a name that can appear as `$name` in the composer (§16.5). */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParseSkillOptions {
  readonly path: string;
  readonly source: SkillSource;
  readonly scope?: SkillScope;
  readonly origin?: SkillOrigin;
  readonly canonicalPath?: string;
  readonly precedence?: SkillPrecedence;
  readonly directory?: string;
  /**
   * §13.6 / AC-28: an untrusted project Skill is listed from metadata only, so
   * its (stripped, empty) body must not be treated as a fatal parse error. The
   * registry still refuses to *load* the body until the workspace is trusted.
   */
  readonly allowEmptyBody?: boolean;
}

/**
 * Parse one `SKILL.md`.
 *
 * `name` and `description` are the only required fields (§16.3); everything else
 * has a defined default. A missing required field is fatal because a Skill with no
 * name cannot be invoked and one with no description cannot be selected — §16.4
 * stage 1 gives the model nothing else to go on.
 */
export function parseSkill(raw: string, options: ParseSkillOptions): SkillParseResult {
  const parsed = parseFrontmatter(raw);
  if (parsed.raw === undefined) return { issues: parsed.issues };

  const unsafeFrontmatter = parsed.issues.some((issue) => issue.severity !== "warning");
  const issues: FrontmatterIssue[] = [...parsed.issues];
  const front = parsed.raw;

  for (const key of Object.keys(front.fields)) {
    if (!KNOWN_FIELDS.has(key)) {
      issues.push({
        field: key,
        message: `unknown frontmatter field '${key}'`,
        ...(front.lines[key] !== undefined ? { line: front.lines[key] } : {}),
        severity: "warning",
      });
    }
  }

  const name = scalarField(front, "name", issues)?.trim() ?? "";
  const directory = options.directory ?? directoryOf(options.path);
  if (name.length === 0) {
    issues.push({ field: "name", message: "name is required (§16.3)" });
  } else if (name.length > 64 || !NAME_PATTERN.test(name)) {
    issues.push({
      field: "name",
      message: `'${name}' should be at most 64 lowercase alphanumeric characters and single hyphens`,
      severity: "warning",
    });
  }
  const directoryName = directory.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1);
  if (name.length > 0 && directoryName !== undefined && directoryName !== name) {
    issues.push({
      field: "name",
      message: `Skill name '${name}' does not match its directory '${directoryName}'`,
      severity: "warning",
    });
  }

  const description = scalarField(front, "description", issues)?.trim() ?? "";
  if (description.length === 0) {
    issues.push({ field: "description", message: "description is required (§16.3)" });
  } else if (description.length > 4_096) {
    issues.push({
      field: "description",
      message: `the description is ${description.length} characters, over the 4096-character safety limit`,
      severity: "error",
    });
  } else if (description.length > 1_024) {
    issues.push({
      field: "description",
      message: `the description is ${description.length} characters; Agent Skills recommends at most 1024`,
      severity: "warning",
    });
  }

  const license = scalarField(front, "license", issues)?.trim();
  const compatibility = scalarField(front, "compatibility", issues)?.trim();
  if (compatibility !== undefined && compatibility.length > 500) {
    issues.push({
      field: "compatibility",
      message: `compatibility is ${compatibility.length} characters; Agent Skills recommends at most 500`,
      severity: "warning",
    });
  }
  if (compatibility !== undefined && isValidRange(compatibility)) {
    issues.push({
      field: "compatibility",
      message: "compatibility is now informational; use 'x-capybara-requires' for a Capybara version gate",
      severity: "warning",
    });
  }
  const metadata = mapField(front, "metadata", issues);

  const requiresCapybara = scalarField(front, "x-capybara-requires", issues)?.trim();
  if (requiresCapybara !== undefined && !isValidRange(requiresCapybara)) {
    issues.push({
      field: "x-capybara-requires",
      message: `'${requiresCapybara}' is not a recognized version range`,
      severity: "error",
    });
  }

  const riskRaw = aliasedScalar(front, "x-capybara-risk", "risk", issues)?.trim();
  if (riskRaw !== undefined && !SKILL_RISKS.includes(riskRaw as SkillRisk)) {
    issues.push({
      field: "x-capybara-risk",
      message: `'${riskRaw}' is not one of ${SKILL_RISKS.join(", ")}`,
      severity: "warning",
    });
  }
  const risk = SKILL_RISKS.includes(riskRaw as SkillRisk) ? (riskRaw as SkillRisk) : undefined;

  const requestedTools = requestedToolField(front, issues);
  const userInvocable = aliasedBoolean(
    front,
    "x-capybara-user-invocable",
    "user_invocable",
    issues,
  ) ?? true;
  const version = aliasedScalar(front, "x-capybara-version", "version", issues)?.trim();
  const modelProfile = aliasedScalar(
    front,
    "x-capybara-model-profile",
    "model_profile",
    issues,
  )?.trim();
  const tags = listField(front, "tags");
  const allowedPaths = aliasedList(
    front,
    "x-capybara-allowed-paths",
    "allowed_paths",
    issues,
  );

  const body = front.body.trim();
  if (body.length === 0 && options.allowEmptyBody !== true) {
    issues.push({ field: "body", message: "a SKILL.md needs instructions after the frontmatter" });
  }

  const fatal = issues.filter((issue) =>
    issue.severity !== "warning" &&
    ["name", "description", "body", "frontmatter", "file", "x-capybara-requires"].includes(issue.field),
  );
  if (unsafeFrontmatter || fatal.length > 0) return { issues };

  const manifest: SkillManifest = {
    name,
    description,
    ...(license !== undefined && license.length > 0 ? { license } : {}),
    ...(compatibility !== undefined && compatibility.length > 0 ? { compatibility } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(requiresCapybara !== undefined && requiresCapybara.length > 0
      ? { requiresCapybara }
      : {}),
    ...(version !== undefined && version.length > 0 ? { version } : {}),
    ...(requestedTools !== undefined ? { requestedTools } : {}),
    ...(risk !== undefined ? { risk } : {}),
    ...(modelProfile !== undefined && modelProfile.length > 0 ? { modelProfile } : {}),
    ...(tags !== undefined ? { tags } : {}),
    userInvocable,
    ...(allowedPaths !== undefined ? { allowedPaths } : {}),
  };

  return {
    definition: {
      manifest,
      body,
      source: options.source,
      scope: options.scope ?? scopeForSource(options.source),
      origin: options.origin ?? originForSource(options.source),
      path: options.path,
      canonicalPath: options.canonicalPath ?? options.path,
      directory,
      ...(options.precedence !== undefined ? { precedence: options.precedence } : {}),
    },
    issues,
  };
}

function requestedToolField(
  front: NonNullable<ReturnType<typeof parseFrontmatter>["raw"]>,
  issues: FrontmatterIssue[],
): string[] | undefined {
  const standard = front.fields["allowed-tools"];
  if (front.fields.tools !== undefined) deprecatedField(front, "tools", "allowed-tools", issues);
  const selected = standard ?? front.fields.tools;
  if (selected === undefined) return undefined;
  if (typeof selected === "string") {
    return selected.split(/\s+/).map((value) => value.trim()).filter((value) => value.length > 0);
  }
  if (Array.isArray(selected)) return [...selected];
  issues.push({ field: "allowed-tools", message: "allowed-tools must be a string or list", severity: "error" });
  return undefined;
}

function aliasedScalar(
  front: NonNullable<ReturnType<typeof parseFrontmatter>["raw"]>,
  current: string,
  legacy: string,
  issues: FrontmatterIssue[],
): string | undefined {
  if (front.fields[legacy] !== undefined) deprecatedField(front, legacy, current, issues);
  return scalarField(front, front.fields[current] !== undefined ? current : legacy, issues);
}

function aliasedBoolean(
  front: NonNullable<ReturnType<typeof parseFrontmatter>["raw"]>,
  current: string,
  legacy: string,
  issues: FrontmatterIssue[],
): boolean | undefined {
  if (front.fields[legacy] !== undefined) deprecatedField(front, legacy, current, issues);
  return booleanField(front, front.fields[current] !== undefined ? current : legacy, issues);
}

function aliasedList(
  front: NonNullable<ReturnType<typeof parseFrontmatter>["raw"]>,
  current: string,
  legacy: string,
  issues: FrontmatterIssue[],
): string[] | undefined {
  if (front.fields[legacy] !== undefined) deprecatedField(front, legacy, current, issues);
  return listField(front, front.fields[current] !== undefined ? current : legacy);
}

function deprecatedField(
  front: NonNullable<ReturnType<typeof parseFrontmatter>["raw"]>,
  legacy: string,
  current: string,
  issues: FrontmatterIssue[],
): void {
  issues.push({
    field: legacy,
    message: `'${legacy}' is deprecated; use '${current}'`,
    ...(front.lines[legacy] !== undefined ? { line: front.lines[legacy] } : {}),
    severity: "warning",
  });
}

function scopeForSource(source: SkillSource): SkillScope {
  if (source === "builtin") return "builtin";
  if (source === "user") return "user";
  return "project";
}

function originForSource(source: SkillSource): SkillOrigin {
  if (source === "builtin") return "bundled";
  if (source === "agents-dir") return "agents";
  return "capybara";
}

/**
 * Narrow a Skill's requested tools to what the host actually permits.
 *
 * This is AC-27 and SKILL-003 in one function. A Skill listing `process.run` gets
 * it only if the host already allows `process.run`; the declaration can never add
 * a capability. The result is an intersection, never a union.
 */
export function effectiveTools(
  manifest: SkillManifest,
  hostAllowed: readonly ToolDefinition[],
): { tools: ToolDefinition[]; denied: string[] } {
  const allowedById = new Map(hostAllowed.map((tool) => [tool.id, tool]));

  // No declaration means "whatever the host allows" — a Skill is instructions,
  // not a sandbox, so silence is not a restriction.
  if (manifest.requestedTools === undefined) {
    return { tools: [...hostAllowed], denied: [] };
  }

  const tools: ToolDefinition[] = [];
  const denied: string[] = [];
  for (const id of manifest.requestedTools) {
    const tool = allowedById.get(id);
    if (tool === undefined) denied.push(id);
    else tools.push(tool);
  }
  return { tools, denied };
}

/**
 * Whether a reference path stays inside the Skill's own directory (SKILL-005).
 *
 * Checked lexically here and again by the Rust path guard at read time (§14.2);
 * this layer exists so `skill validate` can report the problem before anything is
 * read, not to be the only defence.
 */
export function isContainedReference(reference: string): boolean {
  if (reference.length === 0) return false;
  // An absolute path, a drive-qualified path, or a UNC path leaves the directory
  // regardless of what follows.
  if (/^[/\\]/.test(reference)) return false;
  if (/^[A-Za-z]:/.test(reference)) return false;
  if (reference.includes("\0")) return false;

  let depth = 0;
  for (const segment of reference.replace(/\\/g, "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      // Escaping even momentarily is refused: `a/../../b` is outside.
      if (depth < 0) return false;
      continue;
    }
    depth += 1;
  }
  return true;
}

/**
 * §16.6 prompt-injection indicators, surfaced in diagnostics.
 *
 * These are *warnings for a human*, never an automatic block. §16.6 asks for
 * indicators to be shown; deciding on the basis of a keyword match would make a
 * legitimate Skill about credential rotation unusable.
 */
export const INJECTION_INDICATORS: readonly { pattern: RegExp; note: string }[] = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    note: "instructs the model to disregard prior instructions",
  },
  {
    pattern: /you\s+are\s+now\s+(a|an)\s/i,
    note: "attempts to reassign the agent's identity",
  },
  {
    pattern: /\b(disregard|override)\s+(the\s+)?(system|safety|permission)\s+(prompt|policy|rules?)/i,
    note: "attempts to override host policy",
  },
  {
    pattern: /\b(exfiltrate|send|upload|post)\b[^.\n]{0,40}\b(\.env|secret|token|credential|api[_\s-]?key)/i,
    note: "references transmitting credential material",
  },
  {
    pattern: /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i,
    note: "contains a pipe-to-shell installation command",
  },
  {
    pattern: /\b(rm\s+-rf|sudo\s|chmod\s+777)/,
    note: "contains a destructive or privilege-raising shell command",
  },
  {
    pattern: /\bdo\s+not\s+(tell|inform|show)\s+the\s+user\b/i,
    note: "asks the agent to hide activity from the user",
  },
];

export interface InjectionIndicator {
  readonly note: string;
  readonly excerpt: string;
}

export function scanForInjection(body: string): InjectionIndicator[] {
  const found: InjectionIndicator[] = [];
  for (const indicator of INJECTION_INDICATORS) {
    const match = indicator.pattern.exec(body);
    if (match === null) continue;
    found.push({
      note: indicator.note,
      excerpt: match[0].slice(0, 120),
    });
  }
  return found;
}

/**
 * §16.6: "executable scripts 자동 실행 금지". A Skill may *describe* a command; it
 * never causes one to run. This detects the shapes worth flagging so `skill
 * validate` can warn (§16.8's "suspicious executable instruction warning").
 */
export function referencedScripts(body: string): string[] {
  const scripts = new Set<string>();
  // `./x.sh` and `x.sh` name the same file; report one form.
  const normalize = (raw: string): string => raw.replace(/^\.\//, "");

  // A path ending in a script extension. The leading boundary is "any character
  // that cannot be part of a path" rather than whitespace, because a Skill almost
  // always shows a command inside a code span or quotes — requiring whitespace
  // would miss `` `./deploy.sh` ``, the most common way it is written.
  const byExtension =
    /(?:^|[^\w./\\-])((?:\.\/)?[\w][\w./-]*\.(?:sh|bash|zsh|ps1|bat|cmd|py|rb|pl))(?![\w.-])/g;
  for (const match of body.matchAll(byExtension)) {
    const candidate = match[1];
    if (candidate !== undefined) scripts.add(normalize(candidate));
  }

  // An explicit interpreter invocation, where the target may carry no extension.
  const byInterpreter =
    /\b(?:bash|sh|zsh|python3?|ruby|perl|node|bun|pwsh|powershell)\s+((?:\.\/)?[\w][\w./-]*)/g;
  for (const match of body.matchAll(byInterpreter)) {
    const candidate = match[1];
    if (candidate !== undefined) scripts.add(normalize(candidate));
  }

  return [...scripts];
}

/**
 * Extract the reference files a Skill's body points at, so §16.4 stage 3 knows
 * what may legitimately be read and §16.8 can report a broken link.
 */
export function referencedFiles(body: string): string[] {
  const files = new Set<string>();
  // Markdown links and inline code that looks like a relative path.
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (target !== undefined && !/^[a-z]+:/i.test(target) && !target.startsWith("#")) {
      files.add(target);
    }
  }
  for (const match of body.matchAll(/`([\w./-]+\.[A-Za-z0-9]{1,6})`/g)) {
    const target = match[1];
    if (target !== undefined && target.includes("/")) files.add(target);
  }
  return [...files];
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

/** Restricted semver-range recognizer for the x-capybara-requires extension. */
function isValidRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "*") return true;
  return trimmed.split("||").every((group) => {
    const normalized = group.trim().replace(/,/g, " ");
    const hyphen = /^(\d+(?:\.\d+){0,2})\s+-\s+(\d+(?:\.\d+){0,2})$/.exec(normalized);
    if (hyphen !== null) return parseVersion(hyphen[1] ?? "") !== undefined && parseVersion(hyphen[2] ?? "") !== undefined;
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
    return tokens.length > 0 && tokens.every((token) => /^(?:[<>]=?|\^|~)?\d+(?:\.\d+){0,2}$/.test(token));
  });
}

/**
 * Whether `version` satisfies `range`. Supports the comparison forms §16.3 shows;
 * an unrecognized range is treated as unsatisfied so an incompatible Skill fails
 * closed (§17.2 applies the same principle to protocol versions).
 */
export function satisfiesCompatibility(version: string, range: string | undefined): boolean {
  if (range === undefined || range.trim() === "*") return true;
  const target = parseVersion(version);
  if (target === undefined) return false;
  return range.split("||").some((group) => satisfiesGroup(target, group.trim()));
}

type Version = [number, number, number];

function parseVersion(raw: string): Version | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(raw.trim());
  if (match === null) return undefined;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function satisfiesGroup(target: Version, raw: string): boolean {
  const normalized = raw.replace(/,/g, " ");
  const hyphen = /^(\d+(?:\.\d+){0,2})\s+-\s+(\d+(?:\.\d+){0,2})$/.exec(normalized);
  if (hyphen !== null) {
    const lower = parseVersion(hyphen[1] ?? "");
    const upper = parseVersion(hyphen[2] ?? "");
    return lower !== undefined && upper !== undefined && compareVersions(target, lower) >= 0 && compareVersions(target, upper) <= 0;
  }
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => satisfiesComparator(target, token));
}

function satisfiesComparator(target: Version, token: string): boolean {
  const match = /^([<>]=?|\^|~)?(\d+(?:\.\d+){0,2})$/.exec(token);
  if (match === null) return false;
  const operator = match[1] ?? "=";
  const bound = parseVersion(match[2] ?? "");
  if (bound === undefined) return false;
  const cmp = compareVersions(target, bound);
  switch (operator) {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "^": return target[0] === bound[0] && cmp >= 0;
    case "~": return target[0] === bound[0] && target[1] === bound[1] && cmp >= 0;
    default: return cmp === 0;
  }
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
