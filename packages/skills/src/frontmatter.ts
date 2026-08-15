/**
 * `SKILL.md` frontmatter — PRD §16.3, §16.6, §T8.
 *
 * §16.6 treats a project Skill as untrusted content, and §T8 lists a malicious
 * Skill package as a named threat. So this is a deliberately small parser for the
 * flat scalar-and-list subset §16.3 documents, not a general YAML reader: anchors,
 * merge keys, nested maps, and multi-document streams are all constructs the
 * format has no use for and every one of them is more surface to get wrong.
 *
 * Anything outside the subset is reported as an issue rather than guessed at.
 */

/** Field values §16.3 allows: a scalar or a list of scalars. */
export type FrontmatterValue = string | string[];

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
}

export interface FrontmatterParseResult {
  readonly raw?: RawFrontmatter;
  readonly issues: FrontmatterIssue[];
}

/** §16.6: a Skill file that is absurdly large is a denial-of-context problem. */
export const MAX_SKILL_BYTES = 256 * 1024;
/** Startup discovery reads at most this many bytes per on-disk Skill. */
export const MAX_SKILL_CATALOG_BYTES = 32 * 1024;

/**
 * Split a `SKILL.md` into frontmatter fields and body.
 *
 * Returns issues instead of throwing, because §16.8's `skill validate` has to be
 * able to report *every* problem in a file rather than stopping at the first.
 */
export function parseFrontmatter(raw: string): FrontmatterParseResult {
  const issues: FrontmatterIssue[] = [];

  if (raw.length > MAX_SKILL_BYTES) {
    return {
      issues: [
        {
          field: "file",
          message: `the file is ${raw.length} bytes, over the ${MAX_SKILL_BYTES} byte limit`,
        },
      ],
    };
  }

  const normalized = raw.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return {
      issues: [
        {
          field: "frontmatter",
          message: "a SKILL.md must open with a '---' frontmatter delimiter",
          line: 1,
        },
      ],
    };
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return {
      issues: [
        { field: "frontmatter", message: "the frontmatter block is never closed with '---'" },
      ],
    };
  }

  const fields: Record<string, FrontmatterValue> = {};
  const fieldLines: Record<string, number> = {};
  let currentListKey: string | undefined;

  for (let i = 1; i < closing; i += 1) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;

    if (line.trim().length === 0) continue;
    // A comment line.
    if (/^\s*#/.test(line)) continue;

    // ---- List item under the previous key ----
    const listMatch = /^(\s*)-\s*(.*)$/.exec(line);
    if (listMatch !== null) {
      if (currentListKey === undefined) {
        issues.push({
          field: "frontmatter",
          message: "a list item appears before any field name",
          line: lineNumber,
        });
        continue;
      }
      const value = unquote((listMatch[2] ?? "").trim());
      if (value.length === 0) {
        issues.push({
          field: currentListKey,
          message: "a list item is empty",
          line: lineNumber,
        });
        continue;
      }
      const existing = fields[currentListKey];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        fields[currentListKey] = [value];
      }
      continue;
    }

    // ---- `key: value` ----
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (fieldMatch === null) {
      issues.push({
        field: "frontmatter",
        message: `line ${lineNumber} is neither a 'key: value' pair nor a list item`,
        line: lineNumber,
      });
      continue;
    }

    const key = fieldMatch[1] ?? "";
    const rest = (fieldMatch[2] ?? "").trim();

    if (key in fields) {
      issues.push({ field: key, message: `duplicate field '${key}'`, line: lineNumber });
    }
    fieldLines[key] = lineNumber;

    if (rest.length === 0) {
      // A block list follows on subsequent lines.
      currentListKey = key;
      fields[key] = [];
      continue;
    }

    currentListKey = undefined;

    // Inline flow list: `tools: [a, b]`.
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      fields[key] =
        inner.length === 0
          ? []
          : inner
              .split(",")
              .map((part) => unquote(part.trim()))
              .filter((part) => part.length > 0);
      continue;
    }

    fields[key] = unquote(rest);
  }

  // A key that opened a block list but received no items is an empty list, which
  // is meaningful (an explicit "no tools requested") and kept as such.
  const bodyStart = closing + 1;
  const body = lines.slice(bodyStart).join("\n");

  return { raw: { fields, body, lines: fieldLines }, issues };
}

/**
 * Reduce a `SKILL.md` to its frontmatter block, dropping the body.
 *
 * §13.6 / AC-28: untrusted discovery may *list* a project Skill from its
 * metadata, but the body must not be read into the process at all. Keeping only
 * the delimited frontmatter means the manifest parses while the body never
 * exists in memory to leak, render, or be loaded by accident.
 */
export function frontmatterOnly(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  // No frontmatter delimiter: nothing may be listed, and handing the whole file
  // through would defeat the point — return an empty document and let the parser
  // report the file as invalid.
  if (lines[0]?.trim() !== "---") return "";
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      return lines.slice(0, i + 1).join("\n");
    }
  }
  // Never closed: keep nothing; the parser will report the unterminated block.
  return "";
}

/** Read a field as a scalar, reporting when a list was supplied instead. */
export function scalarField(
  raw: RawFrontmatter,
  key: string,
  issues: FrontmatterIssue[],
): string | undefined {
  const value = raw.fields[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    issues.push({
      field: key,
      message: `'${key}' must be a single value, not a list`,
      ...(raw.lines[key] !== undefined ? { line: raw.lines[key] } : {}),
    });
    return undefined;
  }
  return value;
}

/** Read a field as a list, accepting a lone scalar as a one-element list. */
export function listField(raw: RawFrontmatter, key: string): string[] | undefined {
  const value = raw.fields[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value];
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
  });
  return undefined;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
