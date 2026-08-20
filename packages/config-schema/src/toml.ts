/**
 * A focused TOML reader for `config.toml` (PRD §21.4) and `SKILL.md`-adjacent
 * metadata.
 *
 * Scope is deliberately the subset the PRD's configuration format uses: tables,
 * dotted keys, strings, integers, floats, booleans, and flat arrays. Anything
 * outside that surface is reported as an issue rather than silently accepted, so
 * malformed global config cannot be misread as a permissive one.
 */

export interface TomlIssue {
  readonly line: number;
  readonly message: string;
}

export interface TomlResult {
  /** Dotted-path map, ready to feed `mergeConfig`. */
  readonly values: Record<string, unknown>;
  readonly issues: TomlIssue[];
}

export function parseToml(input: string): TomlResult {
  const values: Record<string, unknown> = {};
  const issues: TomlIssue[] = [];
  let tablePrefix = "";
  /** Array-of-tables counters, e.g. `[[allow]]`. */
  const arrayCounters = new Map<string, number>();

  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = stripComment(raw).trim();
    if (line.length === 0) continue;

    // Array of tables: [[name]]
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const name = line.slice(2, -2).trim();
      if (!isValidKeyPath(name)) {
        issues.push({ line: index + 1, message: `invalid table name '${name}'` });
        continue;
      }
      const next = (arrayCounters.get(name) ?? -1) + 1;
      arrayCounters.set(name, next);
      tablePrefix = `${normalizeKeyPath(name)}.${next}`;
      continue;
    }

    // Table header: [name]
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (!isValidKeyPath(name)) {
        issues.push({ line: index + 1, message: `invalid table name '${name}'` });
        continue;
      }
      tablePrefix = normalizeKeyPath(name);
      continue;
    }

    const eq = findAssignment(line);
    if (eq < 0) {
      issues.push({ line: index + 1, message: `expected 'key = value', found '${line}'` });
      continue;
    }
    const rawKey = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (!isValidKeyPath(rawKey)) {
      issues.push({ line: index + 1, message: `invalid key '${rawKey}'` });
      continue;
    }

    const parsed = parseValue(rawValue);
    if (parsed.error) {
      issues.push({ line: index + 1, message: parsed.error });
      continue;
    }

    const key = normalizeKeyPath(rawKey);
    const path = tablePrefix.length > 0 ? `${tablePrefix}.${key}` : key;
    values[path] = parsed.value;
  }

  return { values, issues };
}

function stripComment(line: string): string {
  let inString = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function findAssignment(line: string): number {
  let inString = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "=") return i;
  }
  return -1;
}

function isValidKeyPath(key: string): boolean {
  if (key.length === 0) return false;
  return key
    .split(".")
    .every((part) => /^(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')$/.test(part.trim()));
}

function normalizeKeyPath(key: string): string {
  return key
    .split(".")
    .map((part) => {
      const trimmed = part.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        return trimmed.slice(1, -1);
      }
      return trimmed;
    })
    .join(".");
}

interface ValueResult {
  value?: unknown;
  error?: string;
}

function parseValue(raw: string): ValueResult {
  if (raw.length === 0) return { error: "missing value" };

  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };

  if (raw.startsWith('"""') || raw.startsWith("'''")) {
    return { error: "multi-line strings are not supported in Capybara config" };
  }

  if (raw.startsWith('"')) {
    const end = findStringEnd(raw, '"');
    if (end < 0) return { error: "unterminated string" };
    return { value: unescapeBasic(raw.slice(1, end)) };
  }
  if (raw.startsWith("'")) {
    const end = findStringEnd(raw, "'");
    if (end < 0) return { error: "unterminated literal string" };
    return { value: raw.slice(1, end) };
  }

  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) return { error: "inline arrays must be on one line" };
    const body = raw.slice(1, -1).trim();
    if (body.length === 0) return { value: [] };
    const parts = splitTopLevel(body);
    const items: unknown[] = [];
    for (const part of parts) {
      const parsed = parseValue(part.trim());
      if (parsed.error) return { error: `in array: ${parsed.error}` };
      items.push(parsed.value);
    }
    return { value: items };
  }

  if (raw.startsWith("{")) {
    return { error: "inline tables are not supported in Capybara config" };
  }

  // Numbers. TOML allows underscores as digit separators.
  const numeric = raw.replace(/_/g, "");
  if (/^[+-]?\d+$/.test(numeric)) {
    const asNumber = Number(numeric);
    if (!Number.isSafeInteger(asNumber)) return { error: `integer out of range: ${raw}` };
    return { value: asNumber };
  }
  if (/^[+-]?(?:\d+\.\d+|\d+[eE][+-]?\d+|\d+\.\d+[eE][+-]?\d+)$/.test(numeric)) {
    return { value: Number(numeric) };
  }

  return { error: `unrecognized value '${raw}'` };
}

function findStringEnd(raw: string, quote: string): number {
  for (let i = 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\" && quote === '"') {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

function unescapeBasic(text: string): string {
  return text.replace(/\\(["\\nrt]|u[0-9a-fA-F]{4})/g, (_match, group: string) => {
    switch (group) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return String.fromCharCode(Number.parseInt(group.slice(1), 16));
    }
  });
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

/**
 * Extract MCP server definitions from a parsed config layer.
 * `[mcp.servers.<name>]` in §17.3 becomes `mcpServers.<name>`.
 */
export function extractMcpServers(values: Record<string, unknown>): Record<string, unknown> {
  return extractServerTable(values, "mcp", "mcpServers");
}

/** `[lsp.servers.<name>]` becomes the runtime's `lspServers.<name>` map. */
export function extractLspServers(values: Record<string, unknown>): Record<string, unknown> {
  return extractServerTable(values, "lsp", "lspServers");
}

function extractServerTable(
  values: Record<string, unknown>,
  table: "mcp" | "lsp",
  target: "mcpServers" | "lspServers",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prefix = `${table}.servers.`;
  for (const [path, value] of Object.entries(values)) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const separator = remainder.indexOf(".");
    if (separator <= 0 || separator === remainder.length - 1) continue;
    const server = remainder.slice(0, separator);
    const field = remainder.slice(separator + 1);
    out[`${target}.${server}.${camelize(field)}`] = value;
  }
  return out;
}

function camelize(snake: string): string {
  return snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Collect `[[permissions.rules]]` array-of-tables entries (flattened to
 * `permissions.rules.<index>.<field>`) into a single `permissions.rules` array
 * (P0-13). Returns an empty object when no rules are present, so the spread in
 * `normalizeConfigKeys` leaves the default untouched.
 */
export function extractPermissionRules(values: Record<string, unknown>): Record<string, unknown> {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [path, value] of Object.entries(values)) {
    const match = /^permissions\.rules\.(\d+)\.(.+)$/.exec(path);
    if (match === null) continue;
    const index = Number(match[1]);
    const field = camelize(match[2] as string);
    const entry = byIndex.get(index) ?? {};
    entry[field] = value;
    byIndex.set(index, entry);
  }
  if (byIndex.size === 0) return {};
  const rules = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => entry);
  return { "permissions.rules": rules };
}

/**
 * Normalize snake_case TOML keys to the camelCase config paths, so the
 * documented file format and the internal schema can differ without a mapping
 * table at every call site.
 */
export function normalizeConfigKeys(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    if (path.startsWith("mcp.servers.")) continue; // handled separately
    if (path.startsWith("lsp.servers.")) continue; // handled separately
    if (path.startsWith("permissions.rules.")) continue; // aggregated below (P0-13)
    const normalized = path
      .split(".")
      .map((segment, index) => (index === 0 ? segment : camelize(segment)))
      .join(".");
    out[normalized] = value;
  }
  return {
    ...out,
    ...extractMcpServers(values),
    ...extractLspServers(values),
    ...extractPermissionRules(values),
  };
}
