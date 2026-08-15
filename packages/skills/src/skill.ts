/**
 * Skill definitions and trust rules — PRD §16.1, §16.3, §16.6, AC-27, SKILL-003.
 */

import type { RiskClass, ToolDefinition } from "@cbc/tool-registry";

import {
  booleanField,
  listField,
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
  { source: "agents-dir", root: ".agents/skills" },
  { source: "project", root: ".capybara/skills" },
  { source: "user", root: "~/.config/capybara-code/skills" },
  { source: "builtin", root: "<bundled>" },
];

export type SkillSource = "agents-dir" | "project" | "user" | "builtin";

/**
 * Whether a source is workspace-supplied and therefore untrusted content (§16.6).
 * A user-level or bundled Skill was installed deliberately by the operator.
 */
export function isProjectSource(source: SkillSource): boolean {
  return source === "agents-dir" || source === "project";
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
  readonly version?: string;
  /** Semver range this Skill claims compatibility with. */
  readonly compatibility?: string;
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
  /** Path of the `SKILL.md` itself. */
  readonly path: string;
  /** Directory the Skill owns; references may not escape it (SKILL-005). */
  readonly directory: string;
}

/** §16.4 stage 1: the only thing in the startup prompt (SKILL-001). */
export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk?: SkillRisk;
  readonly source: SkillSource;
  readonly version?: string;
  readonly userInvocable: boolean;
}

export function catalogEntry(definition: SkillDefinition): SkillCatalogEntry {
  return {
    name: definition.manifest.name,
    description: definition.manifest.description,
    ...(definition.manifest.risk !== undefined ? { risk: definition.manifest.risk } : {}),
    source: definition.source,
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
  "version",
  "compatibility",
  "tools",
  "risk",
  "model_profile",
  "tags",
  "user_invocable",
  "allowed_paths",
  "allowed-tools",
]);

/** §16.3 requires a name that can appear as `$name` in the composer (§16.5). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ParseSkillOptions {
  readonly path: string;
  readonly source: SkillSource;
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

  const issues: FrontmatterIssue[] = [...parsed.issues];
  const front = parsed.raw;

  for (const key of Object.keys(front.fields)) {
    if (!KNOWN_FIELDS.has(key)) {
      issues.push({
        field: key,
        message: `unknown frontmatter field '${key}'`,
        ...(front.lines[key] !== undefined ? { line: front.lines[key] } : {}),
      });
    }
  }

  const name = scalarField(front, "name", issues)?.trim() ?? "";
  if (name.length === 0) {
    issues.push({ field: "name", message: "name is required (§16.3)" });
  } else if (!NAME_PATTERN.test(name)) {
    issues.push({
      field: "name",
      message: `'${name}' must be lowercase letters, digits, and hyphens, starting alphanumeric`,
    });
  }

  const description = scalarField(front, "description", issues)?.trim() ?? "";
  if (description.length === 0) {
    issues.push({ field: "description", message: "description is required (§16.3)" });
  } else if (description.length > 500) {
    // Stage 1 metadata sits in the cached prefix; a paragraph per Skill defeats it.
    issues.push({
      field: "description",
      message: `the description is ${description.length} characters; keep it under 500 so the catalog stays cheap (§16.4)`,
    });
  }

  const riskRaw = scalarField(front, "risk", issues)?.trim();
  if (riskRaw !== undefined && !SKILL_RISKS.includes(riskRaw as SkillRisk)) {
    issues.push({
      field: "risk",
      message: `'${riskRaw}' is not one of ${SKILL_RISKS.join(", ")}`,
    });
  }
  const risk = SKILL_RISKS.includes(riskRaw as SkillRisk) ? (riskRaw as SkillRisk) : undefined;

  const compatibility = scalarField(front, "compatibility", issues)?.trim();
  if (compatibility !== undefined && !isValidRange(compatibility)) {
    issues.push({
      field: "compatibility",
      message: `'${compatibility}' is not a recognized version range`,
    });
  }

  // `allowed-tools` is the Agent Skills spelling; `tools` is §16.3's. Accept both
  // so a standard-compliant Skill from the wider ecosystem loads unchanged (P8).
  const requestedTools = listField(front, "tools") ?? listField(front, "allowed-tools");
  const userInvocable = booleanField(front, "user_invocable", issues) ?? true;
  const version = scalarField(front, "version", issues)?.trim();
  const modelProfile = scalarField(front, "model_profile", issues)?.trim();
  const tags = listField(front, "tags");
  const allowedPaths = listField(front, "allowed_paths");

  const body = front.body.trim();
  if (body.length === 0 && options.allowEmptyBody !== true) {
    issues.push({ field: "body", message: "a SKILL.md needs instructions after the frontmatter" });
  }

  const fatal = issues.filter((issue) =>
    ["name", "description", "body", "frontmatter", "file"].includes(issue.field),
  );
  if (fatal.length > 0) return { issues };

  const manifest: SkillManifest = {
    name,
    description,
    ...(version !== undefined && version.length > 0 ? { version } : {}),
    ...(compatibility !== undefined && compatibility.length > 0 ? { compatibility } : {}),
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
      path: options.path,
      directory: options.directory ?? directoryOf(options.path),
    },
    issues,
  };
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

/** Very small semver-range recognizer for §16.3 `compatibility`. */
function isValidRange(range: string): boolean {
  return /^(\*|[<>]=?|\^|~)?\s*\d+(\.\d+)?(\.\d+)?(\s*-\s*\d+(\.\d+)?(\.\d+)?)?$/.test(range.trim());
}

/**
 * Whether `version` satisfies `range`. Supports the comparison forms §16.3 shows;
 * an unrecognized range is treated as unsatisfied so an incompatible Skill fails
 * closed (§17.2 applies the same principle to protocol versions).
 */
export function satisfiesCompatibility(version: string, range: string | undefined): boolean {
  if (range === undefined || range.trim() === "*") return true;
  const trimmed = range.trim();
  const target = parseVersion(version);
  if (target === undefined) return false;

  const match = /^([<>]=?|\^|~)?\s*(.+)$/.exec(trimmed);
  if (match === null) return false;
  const operator = match[1] ?? "=";
  const bound = parseVersion(match[2] ?? "");
  if (bound === undefined) return false;

  const cmp = compareVersions(target, bound);
  switch (operator) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "^":
      // Same major, at or above the bound.
      return target[0] === bound[0] && cmp >= 0;
    case "~":
      // Same major and minor, at or above the bound.
      return target[0] === bound[0] && target[1] === bound[1] && cmp >= 0;
    default:
      return cmp === 0;
  }
}

type Version = [number, number, number];

function parseVersion(raw: string): Version | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  if (match === null) return undefined;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
