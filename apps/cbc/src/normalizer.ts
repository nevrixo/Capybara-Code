/**
 * Action normalization — PRD §12.4, §13.5, §13.8, §17.8, PERM-006.
 *
 * The policy engine decides on a `ProposedAction`, not on raw tool arguments. This
 * module is the only place that maps one to the other, which matters for two
 * reasons:
 *
 *   - PERM-006 hashes the *normalized* operation, so `./src/a.ts` and `src/a.ts`
 *     have to become the same action or an approval rule would not match a second
 *     time.
 *   - §13.5 escalates on uncertainty. An unrecognized tool still yields an action
 *     with its arguments visible on the card, rather than something the classifier
 *     silently treats as harmless.
 */

import type { ActionNormalizer } from "@cbc/agent-kernel";
import {
  detectProcessSemantics,
  type CommandSpec,
  type ProcessSemantics,
  type ProposedAction,
} from "@cbc/permissions";

/** Tools whose path arguments are writes rather than reads. */
const WRITE_TOOLS = new Set([
  "fs.apply_patch",
  "fs.write",
  "fs.move",
  "fs.delete",
]);

const READ_PATH_KEYS = ["path", "file", "target"] as const;
const READ_PATHS_KEYS = ["paths", "files"] as const;

/**
 * Normalize a workspace-relative path.
 *
 * `.` segments are dropped and separators unified so the same file always produces
 * the same string. `..` is deliberately *kept*: stripping it here would hide a
 * traversal attempt from the approval card, and the Rust guard is the component
 * that gets to reject it (§14.2, §19.7).
 *
 * A path that normalizes to nothing becomes `"."` rather than `""`. Dropping to empty
 * meant `process.run` with the default `cwd: "."` sent an empty string, and the runtime
 * correctly rejected it as `invalid path encoding: path is empty` — so every default-cwd
 * process call failed.
 */
export function normalizePath(raw: string): string {
  const unified = raw.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "." || segment.length === 0) continue;
    segments.push(segment);
  }
  const absolute = unified.startsWith("/");
  if (segments.length === 0) return absolute ? "/" : ".";
  return `${absolute ? "/" : ""}${segments.join("/")}`;
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayField(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function collectPaths(args: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of READ_PATH_KEYS) {
    const value = stringField(args, key);
    if (value !== undefined) found.push(value);
  }
  for (const key of READ_PATHS_KEYS) {
    found.push(...stringArrayField(args, key));
  }
  // `fs.move` names its operands differently.
  const from = stringField(args, "from");
  const to = stringField(args, "to");
  if (from !== undefined) found.push(from);
  if (to !== undefined) found.push(to);
  return dedupe(found.map(normalizePath));
}

/** Paths mentioned in a unified diff, so a patch declares what it touches. */
export function pathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    const plus = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
    if (plus?.[1] !== undefined && plus[1] !== "/dev/null") {
      paths.push(normalizePath(plus[1].trim()));
      continue;
    }
    const minus = /^---\s+(?:a\/)?(.+)$/.exec(line);
    if (minus?.[1] !== undefined && minus[1] !== "/dev/null") {
      paths.push(normalizePath(minus[1].trim()));
    }
  }
  return dedupe(paths);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...args };
  for (const key of READ_PATH_KEYS) {
    const value = normalized[key];
    if (typeof value === "string") normalized[key] = normalizePath(value);
  }
  for (const key of READ_PATHS_KEYS) {
    const value = normalized[key];
    if (!Array.isArray(value)) continue;
    normalized[key] = value.map((item) => typeof item === "string" ? normalizePath(item) : item);
  }
  for (const key of ["from", "to", "cwd"] as const) {
    const value = normalized[key];
    if (typeof value === "string") normalized[key] = normalizePath(value);
  }
  return normalized;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Build the command spec for a process or shell tool.
 *
 * `shell.run` sets `rawShell`, which the classifier uses to escalate: §12.3 treats
 * a raw shell string as a different risk from a direct executable invocation
 * because the arguments are no longer separable.
 *
 * P0-04: the spec carries the detected {@link ProcessSemantics}. `sh -c`,
 * `cmd /c`, `node -e`, `python -c` and siblings arriving through `process.run`
 * are *not* direct executable invocations, and the classifier, the policy gate,
 * and the rule store all rely on this field to treat them as what they are.
 */
function commandFor(
  toolId: string,
  args: Record<string, unknown>,
  defaultCwd: string,
): CommandSpec | undefined {
  if (toolId === "shell.run") {
    // The full script is the command. The first token stays as `program` for
    // display only; the classifier analyses `script`, never the token.
    const script = stringField(args, "script") ?? stringField(args, "command") ?? "";
    return {
      program: script.trim().split(/\s+/)[0] ?? "",
      args: [],
      cwd: normalizePath(stringField(args, "cwd") ?? defaultCwd),
      rawShell: true,
      semantics: "shell-script",
      script,
      ...(rawEnv(args) !== undefined ? { env: rawEnv(args) as Record<string, string> } : {}),
    };
  }

  if (toolId === "process.run" || toolId === "process.start") {
    const program = stringField(args, "program") ?? "";
    const argv = stringArrayField(args, "args");
    const intent = networkIntentFor(args);
    const spec: CommandSpec = {
      program,
      args: argv,
      cwd: normalizePath(stringField(args, "cwd") ?? defaultCwd),
      ...(rawEnv(args) !== undefined ? { env: rawEnv(args) as Record<string, string> } : {}),
      ...(intent !== undefined ? { networkIntent: intent } : {}),
    };
    const semantics = detectProcessSemantics(spec);
    if (semantics !== "direct-executable") {
      return {
        ...spec,
        semantics,
        // Everything after the `-c` / `--eval` flag is one unparsed program.
        script: argv.slice(1).join(" "),
      };
    }
    return spec;
  }

  return undefined;
}

/**
 * The model's declared network need (P0-03).
 *
 * Intent only: the policy engine turns it into a risk class and the approval
 * question, and the runtime receives a mode the policy chose — never one the
 * model chose.
 */
function networkIntentFor(
  args: Record<string, unknown>,
): { required: boolean; reason?: string } | undefined {
  const value = args.networkIntent;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.required !== true) return undefined;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return reason.length > 0 ? { required: true, reason } : { required: true };
}

export type { ProcessSemantics };

function rawEnv(args: Record<string, unknown>): Record<string, string> | undefined {
  const value = args.env;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Human-readable one-liner for the approval card (§7.6). */
export function displayFor(toolId: string, args: Record<string, unknown>): string {
  switch (toolId) {
    case "shell.run":
      return `shell: ${truncate(stringField(args, "script") ?? stringField(args, "command") ?? "", 160)}`;
    case "process.run":
    case "process.start": {
      const program = stringField(args, "program") ?? "?";
      const rest = stringArrayField(args, "args").join(" ");
      return truncate(rest.length > 0 ? `${program} ${rest}` : program, 160);
    }
    case "fs.apply_patch": {
      const paths = pathsFromDiff(stringField(args, "diff") ?? "");
      return paths.length > 0 ? `patch ${paths.join(", ")}` : "patch (no files)";
    }
    case "fs.write":
      return `write ${stringField(args, "path") ?? "?"}`;
    case "fs.move":
      return `move ${stringField(args, "from") ?? "?"} → ${stringField(args, "to") ?? "?"}`;
    case "fs.delete":
      return `delete ${stringField(args, "path") ?? "?"}`;
    case "mcp.call":
      return `${stringField(args, "server") ?? "?"}/${stringField(args, "tool") ?? "?"}`;
    case "mcp.read_resource":
      return `read ${stringField(args, "uri") ?? "?"} from ${stringField(args, "server") ?? "?"}`;
    default: {
      const paths = collectPaths(args);
      if (paths.length > 0) return `${toolId} ${paths.join(", ")}`;
      const query = stringField(args, "query") ?? stringField(args, "pattern");
      if (query !== undefined) return `${toolId} ${truncate(query, 120)}`;
      return toolId;
    }
  }
}

export type McpHintResolver = (
  server: string,
  tool: string,
) => {
  annotatedReadOnly?: boolean;
  sideEffectHint?: "read" | "write" | "destructive" | "unknown";
} | undefined;

export interface NormalizerOptions {
  /** Workspace-relative default cwd for process tools. */
  readonly defaultCwd?: string;
  /**
   * Side-effect hints from the MCP catalog. §17.8 treats a server's own
   * `readOnlyHint` as a hint only, so the resolved risk is supplied by the host
   * rather than read out of the model's arguments.
   */
  readonly mcpHint?: McpHintResolver;
}

/** The `ActionNormalizer` the kernel is given. */
export class HostActionNormalizer implements ActionNormalizer {
  readonly #options: NormalizerOptions;

  constructor(options: NormalizerOptions = {}) {
    this.#options = options;
  }

  normalize(callId: string, toolId: string, args: Record<string, unknown>): ProposedAction {
    const defaultCwd = this.#options.defaultCwd ?? ".";
    const normalizedArgs = normalizeArguments(args);
    const command = commandFor(toolId, normalizedArgs, defaultCwd);

    const declaredPaths = collectPaths(normalizedArgs);
    const patchPaths =
      toolId === "fs.apply_patch" ? pathsFromDiff(stringField(normalizedArgs, "diff") ?? "") : [];
    const paths = dedupe([...declaredPaths, ...patchPaths]);

    const writes = WRITE_TOOLS.has(toolId) ? paths : [];
    const reads = WRITE_TOOLS.has(toolId) ? [] : paths;

    const mcp =
      toolId === "mcp.call" || toolId === "mcp.read_resource"
        ? this.#mcpDescriptor(normalizedArgs)
        : undefined;

    return {
      callId,
      toolId,
      arguments: normalizedArgs,
      ...(reads.length > 0 ? { reads } : {}),
      ...(writes.length > 0 ? { writes } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      display: displayFor(toolId, normalizedArgs),
    };
  }

  #mcpDescriptor(args: Record<string, unknown>): ProposedAction["mcp"] {
    const server = stringField(args, "server") ?? "unknown";
    const tool = stringField(args, "tool") ?? stringField(args, "uri") ?? "unknown";
    const hint = this.#options.mcpHint?.(server, tool);
    return {
      server,
      tool,
      ...(hint?.annotatedReadOnly !== undefined
        ? { annotatedReadOnly: hint.annotatedReadOnly }
        : {}),
      // §13.5: unknown means escalate, so an unresolved capability is `unknown`
      // rather than assumed to be a read.
      sideEffectHint: hint?.sideEffectHint ?? "unknown",
    };
  }
}
