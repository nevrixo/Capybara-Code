/**
 * Restricted YAML frontmatter for Agent Skills.
 *
 * The parser intentionally implements only the data shapes the Agent Skills
 * format needs: scalars, scalar lists, one string-to-string metadata map, and
 * literal/folded block scalars. YAML tags, anchors, aliases, merge keys, and
 * nested containers are rejected so discovery never becomes an object-construction
 * or expansion surface.
 */

export type FrontmatterMap = Readonly<Record<string, string>>;
export type FrontmatterValue = string | string[] | FrontmatterMap;

export interface RawFrontmatter {
  readonly fields: Record<string, FrontmatterValue>;
  readonly body: string;
  /** 1-based line number of each field, for validation messages. */
  readonly lines: Record<string, number>;
}

export interface FrontmatterIssue {
  readonly field: string;
  readonly message: string;
  readonly line?: number;
  readonly severity?: "error" | "warning";
}

export interface FrontmatterParseResult {
  readonly raw?: RawFrontmatter;
  readonly issues: FrontmatterIssue[];
}

/** A complete Skill body is loaded only on explicit skill.load. */
export const MAX_SKILL_BYTES = 256 * 1024;
/** Startup discovery reads only this frontmatter-sized prefix. */
export const MAX_SKILL_CATALOG_BYTES = 32 * 1024;

interface ParsedBlock<T> {
  readonly value: T;
  /** Next frontmatter line index to inspect. */
  readonly next: number;
}

/** Parse the safe Agent Skills subset without throwing. */
export function parseFrontmatter(raw: string): FrontmatterParseResult {
  const issues: FrontmatterIssue[] = [];
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_SKILL_BYTES) {
    return {
      issues: [{
        field: "file",
        message: `the file is ${bytes} bytes, over the ${MAX_SKILL_BYTES} byte limit`,
        severity: "error",
      }],
    };
  }

  const normalized = raw.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return {
      issues: [{
        field: "frontmatter",
        message: "a SKILL.md must open with a '---' frontmatter delimiter",
        line: 1,
        severity: "error",
      }],
    };
  }

  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closing = index;
      break;
    }
  }
  if (closing === -1) {
    return {
      issues: [{
        field: "frontmatter",
        message: "the frontmatter block is never closed with '---'",
        severity: "error",
      }],
    };
  }

  const fields: Record<string, FrontmatterValue> = {};
  const fieldLines: Record<string, number> = {};
  let index = 1;
  while (index < closing) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    if (line.trim().length === 0 || /^\s*#/.test(line)) {
      index += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      issues.push({
        field: "frontmatter",
        message: "unexpected indentation outside a list, metadata map, or block scalar",
        line: lineNumber,
        severity: "error",
      });
      index += 1;
      continue;
    }

    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (fieldMatch === null) {
      issues.push({
        field: "frontmatter",
        message: `line ${lineNumber} is neither a 'key: value' pair nor supported YAML`,
        line: lineNumber,
        severity: "error",
      });
      index += 1;
      continue;
    }

    const key = fieldMatch[1] ?? "";
    const rest = stripInlineComment(fieldMatch[2] ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      issues.push({
        field: key,
        message: `duplicate field '${key}'; the later value wins`,
        line: lineNumber,
        severity: "warning",
      });
    }
    fieldLines[key] = lineNumber;

    if (isUnsafeYamlToken(rest)) {
      issues.push({
        field: "frontmatter",
        message: `YAML tags, anchors, and aliases are not allowed in '${key}'`,
        line: lineNumber,
        severity: "error",
      });
      index += 1;
      continue;
    }

    if (/^[|>][+-]?$/.test(rest)) {
      const parsed = parseBlockScalar(lines, index + 1, closing, rest.startsWith(">"));
      fields[key] = parsed.value;
      index = parsed.next;
      continue;
    }

    if (rest.length === 0) {
      if (key === "metadata") {
        const parsed = parseMetadataMap(lines, index + 1, closing, issues);
        fields[key] = parsed.value;
        index = parsed.next;
      } else {
        const parsed = parseBlockList(lines, index + 1, closing, key, issues);
        fields[key] = parsed.value;
        index = parsed.next;
      }
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      fields[key] = parseFlowList(rest.slice(1, -1), key, lineNumber, issues);
      index += 1;
      continue;
    }

    if (rest.startsWith("{") && rest.endsWith("}")) {
      if (key !== "metadata") {
        issues.push({
          field: "frontmatter",
          message: `nested maps are supported only for 'metadata', not '${key}'`,
          line: lineNumber,
          severity: "error",
        });
      } else {
        fields[key] = parseFlowMap(rest.slice(1, -1), lineNumber, issues);
      }
      index += 1;
      continue;
    }

    fields[key] = parseScalar(rest);
    index += 1;
  }

  return {
    raw: {
      fields,
      body: lines.slice(closing + 1).join("\n"),
      lines: fieldLines,
    },
    issues,
  };
}

/** Keep only the bounded manifest, never a discovered Skill body. */
export function frontmatterOnly(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return "";
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") return lines.slice(0, index + 1).join("\n");
  }
  return "";
}

export function scalarField(
  raw: RawFrontmatter,
  key: string,
  issues: FrontmatterIssue[],
): string | undefined {
  const value = raw.fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({
      field: key,
      message: `'${key}' must be a single value`,
      ...(raw.lines[key] !== undefined ? { line: raw.lines[key] } : {}),
      severity: "error",
    });
    return undefined;
  }
  return value;
}

/** Read a list, accepting a scalar as one item for legacy Capybara fields. */
export function listField(raw: RawFrontmatter, key: string): string[] | undefined {
  const value = raw.fields[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? [...value] : undefined;
}

export function mapField(
  raw: RawFrontmatter,
  key: string,
  issues: FrontmatterIssue[],
): Readonly<Record<string, string>> | undefined {
  const value = raw.fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" && !Array.isArray(value)) return { ...value };
  issues.push({
    field: key,
    message: `'${key}' must be a string-to-string map`,
    ...(raw.lines[key] !== undefined ? { line: raw.lines[key] } : {}),
    severity: "error",
  });
  return undefined;
}

export function booleanField(
  raw: RawFrontmatter,
  key: string,
  issues: FrontmatterIssue[],
): boolean | undefined {
  const value = scalarField(raw, key, issues);
  if (value === undefined) return undefined;
  const lowered = value.toLowerCase();
  if (["true", "yes", "on"].includes(lowered)) return true;
  if (["false", "no", "off"].includes(lowered)) return false;
  issues.push({
    field: key,
    message: `'${value}' is not a boolean`,
    ...(raw.lines[key] !== undefined ? { line: raw.lines[key] } : {}),
    severity: "error",
  });
  return undefined;
}

function parseBlockList(
  lines: readonly string[],
  start: number,
  closing: number,
  key: string,
  issues: FrontmatterIssue[],
): ParsedBlock<string[]> {
  const values: string[] = [];
  let index = start;
  while (index < closing) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || /^\s*#/.test(line)) {
      index += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    const match = /^\s+-\s*(.*)$/.exec(line);
    if (match === null) {
      issues.push({
        field: "frontmatter",
        message: `only scalar list items are allowed under '${key}'`,
        line: index + 1,
        severity: "error",
      });
      index += 1;
      continue;
    }
    const raw = stripInlineComment(match[1] ?? "").trim();
    if (raw.length === 0 || isUnsafeYamlToken(raw)) {
      issues.push({
        field: key,
        message: raw.length === 0 ? "a list item is empty" : "YAML tags, anchors, and aliases are not allowed",
        line: index + 1,
        severity: "error",
      });
    } else {
      values.push(parseScalar(raw));
    }
    index += 1;
  }
  return { value: values, next: index };
}

function parseMetadataMap(
  lines: readonly string[],
  start: number,
  closing: number,
  issues: FrontmatterIssue[],
): ParsedBlock<Record<string, string>> {
  const value: Record<string, string> = {};
  let index = start;
  while (index < closing) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || /^\s*#/.test(line)) {
      index += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    const match = /^\s+([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      issues.push({
        field: "frontmatter",
        message: "metadata entries must be indented 'key: value' pairs",
        line: index + 1,
        severity: "error",
      });
      index += 1;
      continue;
    }
    const key = parseScalar((match[1] ?? "").trim());
    const raw = stripInlineComment(match[2] ?? "").trim();
    if (key === "<<" || raw.length === 0 || isUnsafeYamlToken(raw) || /^[{[]/.test(raw)) {
      issues.push({
        field: "metadata",
        message: "metadata keys and values must be plain strings; merge keys and nested values are not allowed",
        line: index + 1,
        severity: "error",
      });
    } else if (Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push({
        field: "metadata",
        message: `duplicate metadata key '${key}'; the later value wins`,
        line: index + 1,
        severity: "warning",
      });
      value[key] = parseScalar(raw);
    } else {
      value[key] = parseScalar(raw);
    }
    index += 1;
  }
  return { value, next: index };
}

function parseBlockScalar(
  lines: readonly string[],
  start: number,
  closing: number,
  folded: boolean,
): ParsedBlock<string> {
  let end = start;
  while (end < closing) {
    const line = lines[end] ?? "";
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    end += 1;
  }
  const body = lines.slice(start, end);
  const indents = body
    .filter((line) => line.trim().length > 0)
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0)
    .filter((indent) => indent > 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const normalized = body.map((line) => line.trim().length === 0 ? "" : line.slice(indent));
  return { value: folded ? foldLines(normalized) : normalized.join("\n"), next: end };
}

function foldLines(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    paragraphs.push(current.join(" "));
    current = [];
  };
  for (const line of lines) {
    if (line.length === 0) flush();
    else current.push(line);
  }
  flush();
  return paragraphs.join("\n");
}

function parseFlowList(
  body: string,
  key: string,
  line: number,
  issues: FrontmatterIssue[],
): string[] {
  if (body.trim().length === 0) return [];
  const values: string[] = [];
  for (const part of splitFlow(body)) {
    const raw = stripInlineComment(part).trim();
    if (raw.length === 0 || isUnsafeYamlToken(raw) || /^[{[]/.test(raw)) {
      issues.push({
        field: key,
        message: "flow lists may contain scalar values only",
        line,
        severity: "error",
      });
      continue;
    }
    values.push(parseScalar(raw));
  }
  return values;
}

function parseFlowMap(
  body: string,
  line: number,
  issues: FrontmatterIssue[],
): Record<string, string> {
  const value: Record<string, string> = {};
  if (body.trim().length === 0) return value;
  for (const part of splitFlow(body)) {
    const colon = findUnquoted(part, ":");
    if (colon < 1) {
      issues.push({
        field: "metadata",
        message: "metadata flow entries must be 'key: value' pairs",
        line,
        severity: "error",
      });
      continue;
    }
    const key = parseScalar(part.slice(0, colon).trim());
    const raw = stripInlineComment(part.slice(colon + 1)).trim();
    if (key === "<<" || raw.length === 0 || isUnsafeYamlToken(raw) || /^[{[]/.test(raw)) {
      issues.push({
        field: "metadata",
        message: "metadata must contain string keys and string values only",
        line,
        severity: "error",
      });
      continue;
    }
    value[key] = parseScalar(raw);
  }
  return value;
}

function parseScalar(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'");
  if (first === '"' && last === '"') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {}
    return value.slice(1, -1);
  }
  return value;
}

function isUnsafeYamlToken(value: string): boolean {
  return /^[!&*]/.test(value.trim());
}

function stripInlineComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function splitFlow(value: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function findUnquoted(value: string, needle: string): number {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === needle) return index;
  }
  return -1;
}
