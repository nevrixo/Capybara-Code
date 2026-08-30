/**
 * Action groups — PRD §6.5.
 *
 * §6.5 makes the model's default surface five verbs (inspect | change | verify |
 * delegate | remember) with the detailed tools loaded on demand, and states the
 * constraint the design has to hold to: "내부 tool ID와 permission classifier는
 * 유지한다. 상위 tool은 권한을 합치거나 우회하지 않고, 적절한 기존 도구 호출을
 * 만드는 facade다." So a group is not a tool that does anything. It is a naming
 * scheme: every group call must name one internal tool from that group's fixed
 * target list, and expansion is a total function into a real catalog id or a
 * refusal. Nothing here executes, and nothing here decides permissions — the
 * expanded id does, exactly as it would on a direct call.
 *
 * The targets are partitioned by the task the model is trying to do, not by risk
 * class. That is safe precisely because risk still comes from the expanded id:
 * `change` fronting both a preview and an apply does not give the preview the
 * apply's authority.
 */

import { NATIVE_TOOLS, type RiskClass, type ToolDefinition } from "./catalog.ts";

export const ACTION_GROUP_IDS = ["inspect", "change", "verify", "delegate", "remember"] as const;

export type ActionGroupId = (typeof ACTION_GROUP_IDS)[number];

/**
 * The complete target list per group. Every native tool belongs to exactly one
 * group, so a group surface can front the whole catalog and `actionGroupForTool`
 * is well defined; `actionGroupPartition` in the tests holds that invariant.
 */
export const ACTION_GROUP_TARGETS: Readonly<Record<ActionGroupId, readonly string[]>> = {
  inspect: [
    "artifact.read",
    "fs.glob",
    "fs.list",
    "fs.read",
    "fs.read_many",
    "fs.search",
    "git.diff",
    "git.log",
    "git.show",
    "git.status",
    "lsp.call_hierarchy",
    "lsp.code_actions",
    "lsp.declaration",
    "lsp.definition",
    "lsp.diagnostics",
    "lsp.document_highlights",
    "lsp.hover",
    "lsp.implementation",
    "lsp.references",
    "lsp.signature_help",
    "lsp.symbols",
    "lsp.type_definition",
    "lsp.workspace_symbols",
    "mcp.search",
    "repo.investigate",
    "skill.search",
    "task.search",
    "tool.discover",
    "worktree.inspect",
    "worktree.list",
  ],
  change: [
    "fs.apply_patch",
    "fs.delete",
    "fs.edit",
    "fs.edit.preview",
    "fs.move",
    "fs.write",
    "git.checkpoint",
    // The *_preview tools sit with the mutation they precede rather than with
    // the reads, because a model reaching for `change` wants the whole
    // preview-then-apply workflow in one place.
    "lsp.code_action_preview",
    "lsp.format_preview",
    "lsp.range_format_preview",
    "lsp.rename_preview",
    "merge.apply",
    "merge.preview",
    "merge.resolve",
    "worktree.create",
    "worktree.remove",
  ],
  verify: [
    "process.input",
    "process.run",
    "process.start",
    "process.stop",
    "shell.run",
    "verification.run_many",
  ],
  delegate: [
    "mcp.call",
    "mcp.read_resource",
    "plugin.invoke",
    "skill.load",
    "task.await",
    "task.cancel",
    "task.message",
    "task.spawn",
    "task.status",
    "user.ask",
    "user.ask_batch",
  ],
  remember: ["memory.remember", "memory.search", "todo.write"],
};

const TOOL_TO_GROUP: ReadonlyMap<string, ActionGroupId> = new Map(
  ACTION_GROUP_IDS.flatMap((group) =>
    ACTION_GROUP_TARGETS[group].map((toolId) => [toolId, group] as const),
  ),
);

export function isActionGroupId(value: string): value is ActionGroupId {
  return (ACTION_GROUP_IDS as readonly string[]).includes(value);
}

/** The group a detailed tool is reached through, or undefined if it is fronted by none. */
export function actionGroupForTool(toolId: string): ActionGroupId | undefined {
  return TOOL_TO_GROUP.get(toolId);
}

export type ActionGroupExpansion =
  | {
    readonly ok: true;
    readonly group: ActionGroupId;
    readonly toolId: string;
    readonly arguments: Record<string, unknown>;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Expand a group call into the internal call it stands for.
 *
 * Pure and total: the only outcomes are one concrete catalog id or a refusal.
 * A target outside the group's list is refused rather than mapped to a default,
 * because "the group could not work out what you meant" must never resolve to
 * something the model did not name (§6.5).
 */
export function expandActionGroupCall(group: string, args: unknown): ActionGroupExpansion {
  if (!isActionGroupId(group)) {
    return { ok: false, reason: `'${group}' is not an action group` };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: `${group} requires an object with 'tool' and 'arguments'` };
  }
  const record = args as Record<string, unknown>;
  const target = record.tool;
  if (typeof target !== "string" || target.length === 0) {
    return { ok: false, reason: `${group} requires 'tool' to name one internal tool` };
  }
  if (!ACTION_GROUP_TARGETS[group].includes(target)) {
    const owner = actionGroupForTool(target);
    return {
      ok: false,
      reason: owner === undefined
        ? `'${target}' is not a tool the ${group} group can call`
        : `'${target}' belongs to the ${owner} group, not ${group}`,
    };
  }
  const inner = record.arguments;
  if (inner !== undefined && (inner === null || typeof inner !== "object" || Array.isArray(inner))) {
    return { ok: false, reason: `${group} requires 'arguments' to be an object` };
  }
  return {
    ok: true,
    group,
    toolId: target,
    arguments: (inner as Record<string, unknown> | undefined) ?? {},
  };
}

const RISK_ORDER: readonly RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];

function widestRisk(risks: readonly RiskClass[]): RiskClass {
  return risks.reduce<RiskClass>(
    (worst, risk) => (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst) ? risk : worst),
    "R0",
  );
}

const GROUP_DESCRIPTIONS: Readonly<Record<ActionGroupId, string>> = {
  inspect: "Read the workspace: files, search, history, and language-server facts.",
  change: "Modify the workspace: patches, writes, moves, deletes, merges, and their previews.",
  verify: "Run commands that check the work: tests, builds, linters, and long-running processes.",
  delegate: "Hand work to a subagent, Skill, plugin, MCP server, or the user.",
  remember: "Record state that outlives the step: the TODO checklist and durable memory.",
};

const GROUP_KEYWORDS: Readonly<Record<ActionGroupId, readonly string[]>> = {
  inspect: ["inspect", "read", "search", "look", "examine", "history"],
  change: ["change", "edit", "write", "patch", "modify", "apply"],
  verify: ["verify", "test", "build", "lint", "typecheck", "run"],
  delegate: ["delegate", "subagent", "spawn", "skill", "ask"],
  remember: ["remember", "todo", "memory", "record", "note"],
};

function groupDefinition(group: ActionGroupId, catalog: readonly ToolDefinition[]): ToolDefinition {
  const targets = ACTION_GROUP_TARGETS[group].filter((id) => catalog.some((tool) => tool.id === id));
  const members = catalog.filter((tool) => targets.includes(tool.id));
  // Derived from the members rather than declared, so a group can never be
  // *less* alarming than the widest thing it fronts. Permissions are still taken
  // from the expanded id — this metadata only matters if some future path
  // classified a group call directly, and there it must not under-count.
  return {
    id: group,
    title: group.charAt(0).toUpperCase() + group.slice(1),
    description: `${GROUP_DESCRIPTIONS[group]} Name the internal tool in 'tool' and pass its own arguments in 'arguments'; the call runs as that tool, under that tool's permissions.`,
    source: "native",
    defaultRisk: widestRisk(members.map((tool) => tool.defaultRisk)),
    maxRisk: widestRisk(members.map((tool) => tool.maxRisk)),
    alwaysActive: false,
    mutates: members.some((tool) => tool.mutates),
    network: members.some((tool) => tool.network),
    keywords: GROUP_KEYWORDS[group],
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: `The internal tool this ${group} call runs as.`,
          enum: targets,
        },
        arguments: {
          type: "object",
          description: "Arguments for the named internal tool, validated against that tool's schema.",
          additionalProperties: true,
        },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
  };
}

/**
 * The five group entries, narrowed to the tools a given catalog actually has —
 * an experimental gate that withholds `fs.edit` must also withhold it from
 * `change`'s enum, or the model would be offered a target that cannot run.
 */
export function actionGroupTools(catalog: readonly ToolDefinition[] = NATIVE_TOOLS): ToolDefinition[] {
  return ACTION_GROUP_IDS.map((group) => groupDefinition(group, catalog)).filter(
    (tool) => actionGroupTargetsOf(tool).length > 0,
  );
}

/**
 * Compose a session catalog for an enabled set of groups.
 *
 * §6.6 requires the ablation to be run one group at a time, so this takes the
 * enabled set rather than a boolean: `change` can front the writers while
 * `inspect` still exposes the reads directly, and the bench can attribute a
 * quality change to one group. A fronted tool stays in the catalog and only
 * loses its always-active flag — it is still reachable by tool.discover and by
 * an internal id, because §6.5 keeps the internal ids and removing them would
 * make the facade the only path to a tool rather than a shorthand for it.
 *
 * The eager orchestration tools are never fronted: tool.discover has to stay
 * callable for on-demand loading to work at all, and todo.write is how the model
 * reports progress.
 */
export const UNFRONTED_TOOL_IDS: readonly string[] = ["tool.discover", "todo.write", "user.ask"];

export function applyActionSurface(
  catalog: readonly ToolDefinition[],
  enabled: readonly ActionGroupId[],
): ToolDefinition[] {
  if (enabled.length === 0) return [...catalog];
  const active = new Set(enabled.filter(isActionGroupId));
  const fronted = new Set(
    [...active].flatMap((group) => ACTION_GROUP_TARGETS[group]).filter(
      (toolId) => !UNFRONTED_TOOL_IDS.includes(toolId),
    ),
  );
  const groups = actionGroupTools(catalog)
    .filter((group) => active.has(group.id as ActionGroupId))
    .map((group) => ({ ...group, alwaysActive: true }));
  const detailed = catalog.map((tool) =>
    fronted.has(tool.id) && tool.alwaysActive ? { ...tool, alwaysActive: false } : tool,
  );
  return [...detailed, ...groups];
}

/** The target enum a group definition ended up carrying, for callers that gate on it. */
export function actionGroupTargetsOf(tool: ToolDefinition): readonly string[] {
  const properties = tool.parameters.properties as Record<string, { enum?: readonly string[] }> | undefined;
  return properties?.tool?.enum ?? [];
}
