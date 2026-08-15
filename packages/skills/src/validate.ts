/**
 * `capy skills validate` — PRD §16.8, SKILL-004, SKILL-005.
 *
 * §16.8's checklist, each mapped to a check below:
 *
 * - frontmatter schema
 * - duplicate name
 * - path traversal / symlink
 * - missing reference
 * - oversized file
 * - unsupported tool name
 * - compatibility range
 * - suspicious executable instruction warning
 *
 * Severity matters here. A structural problem is an `error` and blocks
 * registration; a safety signal is a `warning`, because §16.6 asks for injection
 * indicators to be *shown* rather than used to auto-reject a Skill whose subject
 * matter legitimately involves credentials or shell commands.
 */

import type { ToolDefinition } from "@cbc/tool-registry";

import { MAX_SKILL_BYTES } from "./frontmatter.ts";
import {
  isContainedReference,
  parseSkill,
  referencedFiles,
  referencedScripts,
  satisfiesCompatibility,
  scanForInjection,
  type SkillSource,
} from "./skill.ts";

export type ValidationSeverity = "error" | "warning";

export interface SkillValidationIssue {
  readonly severity: ValidationSeverity;
  readonly check: string;
  readonly message: string;
  readonly line?: number;
}

export interface SkillValidationInput {
  readonly path: string;
  readonly source: SkillSource;
  readonly content: string;
  /** Product version for the compatibility check. */
  readonly productVersion: string;
  /** Tools the host knows about; an unknown id is a typo the author should fix. */
  readonly knownTools?: readonly ToolDefinition[];
  /** Files that exist in the Skill directory, workspace-relative to it. */
  readonly directoryEntries?: readonly string[];
  /** Entries in the Skill directory that are symlinks (§16.6). */
  readonly symlinkEntries?: readonly string[];
  /** Names already claimed, for the duplicate check. */
  readonly existingNames?: readonly string[];
}

export interface SkillValidationReport {
  readonly path: string;
  readonly name?: string;
  readonly valid: boolean;
  readonly issues: SkillValidationIssue[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export function validateSkill(input: SkillValidationInput): SkillValidationReport {
  const issues: SkillValidationIssue[] = [];

  // ---- oversized file ----
  if (input.content.length > MAX_SKILL_BYTES) {
    issues.push({
      severity: "error",
      check: "size",
      message: `SKILL.md is ${input.content.length} bytes, over the ${MAX_SKILL_BYTES} byte limit`,
    });
  }

  // ---- frontmatter schema ----
  const parsed = parseSkill(input.content, { path: input.path, source: input.source });
  for (const issue of parsed.issues) {
    const structural = ["name", "description", "body", "frontmatter", "file"].includes(issue.field);
    issues.push({
      severity: structural ? "error" : "warning",
      check: "frontmatter",
      message: `${issue.field}: ${issue.message}`,
      ...(issue.line !== undefined ? { line: issue.line } : {}),
    });
  }

  const definition = parsed.definition;
  if (definition === undefined) {
    return report(input.path, undefined, issues);
  }

  const manifest = definition.manifest;

  // ---- duplicate name ----
  if ((input.existingNames ?? []).includes(manifest.name)) {
    issues.push({
      severity: "error",
      check: "duplicate-name",
      message: `another skill named '${manifest.name}' is already registered`,
    });
  }

  // ---- compatibility range ----
  if (manifest.compatibility !== undefined) {
    if (!satisfiesCompatibility(input.productVersion, manifest.compatibility)) {
      issues.push({
        severity: "error",
        check: "compatibility",
        message: `requires ${manifest.compatibility}, but this build is ${input.productVersion}`,
      });
    }
  }

  // ---- unsupported tool name ----
  if (manifest.requestedTools !== undefined && input.knownTools !== undefined) {
    const known = new Set(input.knownTools.map((tool) => tool.id));
    for (const id of manifest.requestedTools) {
      if (!known.has(id)) {
        issues.push({
          severity: "error",
          check: "tools",
          message: `'${id}' is not a known tool id`,
        });
      }
    }
  }

  // ---- path traversal ----
  for (const glob of manifest.allowedPaths ?? []) {
    if (glob.includes("..") || /^[/\\]/.test(glob) || /^[A-Za-z]:/.test(glob)) {
      issues.push({
        severity: "error",
        check: "path-traversal",
        message: `allowed_paths entry '${glob}' must be workspace-relative without '..'`,
      });
    }
  }

  const references = referencedFiles(definition.body);
  for (const reference of references) {
    if (!isContainedReference(reference)) {
      // SKILL-005: a reference may not escape the skill directory.
      issues.push({
        severity: "error",
        check: "path-traversal",
        message: `reference '${reference}' escapes the skill directory`,
      });
      continue;
    }

    // ---- missing reference ----
    if (input.directoryEntries !== undefined && !input.directoryEntries.includes(reference)) {
      issues.push({
        severity: "warning",
        check: "missing-reference",
        message: `reference '${reference}' does not exist in the skill directory`,
      });
    }
  }

  // ---- symlink ----
  for (const entry of input.symlinkEntries ?? []) {
    issues.push({
      severity: "error",
      check: "symlink",
      message: `'${entry}' is a symlink; a skill directory may not contain one (§16.6)`,
    });
  }

  // ---- suspicious executable instruction ----
  const scripts = referencedScripts(definition.body);
  if (scripts.length > 0) {
    issues.push({
      severity: "warning",
      check: "executable-instruction",
      message: `references script(s) ${scripts.join(", ")}; a skill never runs anything automatically, and each command still needs approval (§16.6)`,
    });
  }

  for (const indicator of scanForInjection(definition.body)) {
    issues.push({
      severity: "warning",
      check: "prompt-injection",
      message: `${indicator.note}: "${indicator.excerpt}"`,
    });
  }

  return report(input.path, manifest.name, issues);
}

function report(
  path: string,
  name: string | undefined,
  issues: SkillValidationIssue[],
): SkillValidationReport {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return {
    path,
    ...(name !== undefined ? { name } : {}),
    valid: errorCount === 0,
    issues,
    errorCount,
    warningCount,
  };
}

/** Render a report for `capy skills validate`. */
export function renderValidationReport(report: SkillValidationReport): string[] {
  const header = report.valid
    ? `✓ ${report.name ?? report.path} is valid`
    : `× ${report.name ?? report.path} is not valid`;
  const lines = [header, `  ${report.path}`];

  if (report.issues.length === 0) {
    lines.push("  no issues found");
    return lines;
  }

  for (const issue of report.issues) {
    const icon = issue.severity === "error" ? "×" : "!";
    const where = issue.line !== undefined ? `:${issue.line}` : "";
    lines.push(`  ${icon} [${issue.check}${where}] ${issue.message}`);
  }
  lines.push(
    `  ${report.errorCount} error(s), ${report.warningCount} warning(s)`,
  );
  return lines;
}
