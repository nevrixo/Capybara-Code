/**
 * Custom agent definitions — PRD §15.13.
 *
 * Locations:
 *
 * ```text
 * ~/.config/capybara-code/agents/*.md
 * .capybara/agents/*.md
 * ```
 *
 * §15.13's closing sentence is the security rule: "Project agents는 trusted
 * workspace에서만 활성화한다." A project-supplied agent definition is untrusted
 * content, so it may *narrow* authority but never widen it — the same principle
 * §16.6 applies to Skills.
 */

import type { PermissionClass, SubagentRole } from "./roles.ts";
import { ROLE_DEFINITIONS, SUBAGENT_ROLES } from "./roles.ts";

export type CustomAgentSource = "user" | "project" | "builtin";

export interface CustomAgentDefinition {
  readonly name: string;
  readonly description: string;
  /** §15.13 `mode`. Only `subagent` is meaningful in P0. */
  readonly mode: "subagent";
  /** Base role whose defaults and instructions apply. */
  readonly baseRole: SubagentRole;
  readonly modelProfile: string;
  readonly permissionClass: PermissionClass;
  readonly maxTools: number;
  readonly instructions: string;
  readonly source: CustomAgentSource;
  readonly path: string;
}

export interface CustomAgentIssue {
  readonly field: string;
  readonly message: string;
}

export interface CustomAgentParseResult {
  readonly definition?: CustomAgentDefinition;
  readonly issues: CustomAgentIssue[];
}

/** Frontmatter fields §15.13 documents. Anything else is reported, not honoured. */
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "mode",
  "model_profile",
  "permissions",
  "max_tools",
  "base_role",
]);

const PERMISSION_CLASSES: readonly PermissionClass[] = ["read", "write", "process"];

/**
 * Parse one `*.md` agent definition.
 *
 * `trusted` gates whether a project definition is usable at all. An untrusted
 * project's file still parses so configuration diagnostics can show it exists and why it was
 * not activated — silence would look like a missing file.
 */
export function parseCustomAgent(
  raw: string,
  options: { path: string; source: CustomAgentSource; trusted: boolean },
): CustomAgentParseResult {
  const issues: CustomAgentIssue[] = [];

  if (options.source === "project" && !options.trusted) {
    return {
      issues: [
        {
          field: "trust",
          message: "project agent definitions are only activated in a trusted workspace (§15.13)",
        },
      ],
    };
  }

  const parsed = splitFrontmatter(raw);
  if (parsed === undefined) {
    return {
      issues: [{ field: "frontmatter", message: "the file has no YAML frontmatter block" }],
    };
  }

  const { fields, body } = parsed;

  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.has(key)) {
      issues.push({ field: key, message: `unknown frontmatter field '${key}'` });
    }
  }

  const name = fields.name?.trim() ?? "";
  if (name.length === 0) {
    issues.push({ field: "name", message: "name is required" });
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    issues.push({
      field: "name",
      message: `'${name}' must be lowercase letters, digits, and hyphens`,
    });
  } else if ((SUBAGENT_ROLES as readonly string[]).includes(name)) {
    // Shadowing a built-in role would make `task.spawn` ambiguous.
    issues.push({
      field: "name",
      message: `'${name}' collides with a built-in role name`,
    });
  }

  const description = fields.description?.trim() ?? "";
  if (description.length === 0) {
    issues.push({ field: "description", message: "description is required" });
  }

  const mode = fields.mode?.trim() ?? "subagent";
  if (mode !== "subagent") {
    issues.push({
      field: "mode",
      message: `mode '${mode}' is not supported; only 'subagent' exists in this release`,
    });
  }

  const baseRoleRaw = fields.base_role?.trim() ?? inferBaseRole(fields.permissions?.trim());
  if (!(SUBAGENT_ROLES as readonly string[]).includes(baseRoleRaw)) {
    issues.push({
      field: "base_role",
      message: `'${baseRoleRaw}' is not one of ${SUBAGENT_ROLES.join(", ")}`,
    });
  }
  const baseRole = ((SUBAGENT_ROLES as readonly string[]).includes(baseRoleRaw)
    ? baseRoleRaw
    : "explore") as SubagentRole;
  const definition = ROLE_DEFINITIONS[baseRole];

  const permissionsRaw = fields.permissions?.trim() ?? definition.permissionClass;
  if (!PERMISSION_CLASSES.includes(permissionsRaw as PermissionClass)) {
    issues.push({
      field: "permissions",
      message: `'${permissionsRaw}' is not one of ${PERMISSION_CLASSES.join(", ")}`,
    });
  }
  const requested = (PERMISSION_CLASSES.includes(permissionsRaw as PermissionClass)
    ? permissionsRaw
    : definition.permissionClass) as PermissionClass;

  // §15.13 / §16.6: a definition may narrow authority, never widen it.
  const permissionClass = narrower(requested, definition.permissionClass);
  if (permissionClass !== requested) {
    issues.push({
      field: "permissions",
      message: `'${requested}' exceeds the ${baseRole} role's '${definition.permissionClass}' authority and was narrowed`,
    });
  }

  const maxToolsRaw = fields.max_tools?.trim();
  let maxTools = definition.maxToolCalls;
  if (maxToolsRaw !== undefined && maxToolsRaw.length > 0) {
    const parsedMax = Number(maxToolsRaw);
    if (!Number.isInteger(parsedMax) || parsedMax <= 0) {
      issues.push({ field: "max_tools", message: `'${maxToolsRaw}' is not a positive integer` });
    } else {
      // A definition may lower the ceiling but not raise it (§15.7).
      maxTools = Math.min(parsedMax, definition.maxToolCalls);
      if (parsedMax > definition.maxToolCalls) {
        issues.push({
          field: "max_tools",
          message: `${parsedMax} exceeds the ${baseRole} ceiling of ${definition.maxToolCalls} and was clamped`,
        });
      }
    }
  }

  const instructions = body.trim();
  if (instructions.length === 0) {
    issues.push({ field: "body", message: "the definition has no instruction body" });
  }

  const blocking = issues.filter((issue) =>
    ["name", "description", "frontmatter", "trust", "body"].includes(issue.field),
  );
  if (blocking.length > 0) return { issues };

  return {
    definition: {
      name,
      description,
      mode: "subagent",
      baseRole,
      modelProfile: fields.model_profile?.trim() ?? definition.modelProfile,
      permissionClass,
      maxTools,
      instructions,
      source: options.source,
      path: options.path,
    },
    issues,
  };
}

/**
 * Resolve definitions from several sources. A nearer scope wins, matching §16.2's
 * precedence for Skills, and the winning source stays visible.
 */
export function resolveCustomAgents(
  definitions: readonly CustomAgentDefinition[],
): { agents: CustomAgentDefinition[]; shadowed: CustomAgentDefinition[] } {
  const rank: Record<CustomAgentSource, number> = { project: 0, user: 1, builtin: 2 };
  const byName = new Map<string, CustomAgentDefinition>();
  const shadowed: CustomAgentDefinition[] = [];

  for (const definition of [...definitions].sort((a, b) => rank[a.source] - rank[b.source])) {
    const existing = byName.get(definition.name);
    if (existing === undefined) {
      byName.set(definition.name, definition);
    } else {
      shadowed.push(definition);
    }
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    shadowed,
  };
}

function inferBaseRole(permissions: string | undefined): string {
  switch (permissions) {
    case "write":
      return "executor";
    case "process":
      return "test";
    case "read":
      return "reviewer";
    default:
      return "explore";
  }
}

/** The less-privileged of two classes. */
function narrower(a: PermissionClass, b: PermissionClass): PermissionClass {
  const order: Record<PermissionClass, number> = { read: 0, process: 1, write: 2 };
  return order[a] <= order[b] ? a : b;
}

interface Frontmatter {
  readonly fields: Record<string, string>;
  readonly body: string;
}

/**
 * Minimal frontmatter reader for the flat `key: value` blocks §15.13 shows.
 *
 * Deliberately not a general YAML parser: a full one would accept nested
 * structures and anchors this format has no use for, and every extra construct is
 * more attack surface in a file the project supplies (§T8).
 */
export function splitFrontmatter(raw: string): Frontmatter | undefined {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return undefined;

  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;

  const header = normalized.slice(normalized.indexOf("\n", 3) + 1, end);
  const bodyStart = normalized.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1);

  const fields: Record<string, string> = {};
  let currentKey: string | undefined;
  const listValues: Record<string, string[]> = {};

  for (const line of header.split("\n")) {
    if (line.trim().length === 0) continue;

    const listMatch = /^\s*-\s+(.*)$/.exec(line);
    if (listMatch && currentKey !== undefined) {
      const value = stripQuotes((listMatch[1] ?? "").trim());
      listValues[currentKey] = [...(listValues[currentKey] ?? []), value];
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").trim();
    const value = stripQuotes((match[2] ?? "").trim());
    currentKey = key;
    if (value.length > 0) fields[key] = value;
  }

  // Flatten any list values so callers see one consistent string shape.
  for (const [key, values] of Object.entries(listValues)) {
    if (fields[key] === undefined) fields[key] = values.join(",");
  }

  return { fields, body };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
