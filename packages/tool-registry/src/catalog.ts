/**
 * Native tool catalog — PRD §12.2, §12.4, §13.2.
 *
 * §12.4 schema rules: strict JSON Schema, `additionalProperties: false`,
 * relative paths by default, absolute paths behind an explicit flag plus
 * approval, mandatory timeout and output limits, and an expected hash or create
 * policy on every mutation tool.
 */

/** §13.2 risk classes. */
export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export const RISK_DESCRIPTIONS: Record<RiskClass, string> = {
  R0: "read-only, local, bounded",
  R1: "local reversible execution",
  R2: "bounded workspace mutation",
  R3: "network, dependency, or broad execution",
  R4: "destructive or privileged local action",
  R5: "credential or outside-workspace access",
  R6: "external system side effect",
};

/**
 * §13.2: R4–R6 may never receive a session-wide or project-wide allow rule.
 */
export function allowsBroadRule(risk: RiskClass): boolean {
  return risk === "R0" || risk === "R1" || risk === "R2" || risk === "R3";
}

export type ToolSource = "native" | "skill" | "mcp";
export interface ToolExecutionMetadata {
  readonly idempotency: "pure" | "idempotent" | "non_idempotent";
  readonly authority: "read" | "session_state" | "workspace_write" | "process" | "network" | "external_effect";
  readonly conflictKeys: (args: unknown) => readonly string[];
  readonly canRunInProgram: boolean;
  readonly canRunInHostedAgent: boolean;
  readonly maxParallelism: number;
  readonly resultSchemaId: string;
}

export interface ToolDefinition {
  readonly id: string;
  /** Short title used in the discovery tree (§6.9). */
  readonly title: string;
  readonly description: string;
  readonly source: ToolSource;
  /** Baseline risk; the classifier may promote it (§13.5). */
  readonly defaultRisk: RiskClass;
  /** Highest risk this tool can reach once arguments are considered. */
  readonly maxRisk: RiskClass;
  readonly parameters: Record<string, unknown>;
  /** Always offered to the model rather than requiring discovery (§6.9). */
  readonly alwaysActive: boolean;
  /** True when the tool mutates the workspace, for the writer lease (§12.9). */
  readonly mutates: boolean;
  /** True when the tool may reach the network. */
  readonly network: boolean;
  /** Search keywords for discovery ranking. */
  readonly keywords: readonly string[];  /** v1.3 execution metadata; registry fills safe defaults for legacy tools. */
  readonly idempotency?: ToolExecutionMetadata["idempotency"];
  readonly authority?: ToolExecutionMetadata["authority"];
  readonly conflictKeys?: (args: unknown) => readonly string[];
  readonly canRunInProgram?: boolean;
  readonly canRunInHostedAgent?: boolean;
  readonly maxParallelism?: number;
  readonly resultSchemaId?: string;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    // §12.4: strict schemas reject unknown keys.
    additionalProperties: false,
  };
}

const relativePath = {
  type: "string",
  description: "Workspace-relative path. Absolute paths require allowAbsolute and approval.",
  minLength: 1,
  maxLength: 4096,
};

const timeoutMs = {
  type: "integer",
  description: "Hard timeout in milliseconds. Clamped to the runtime ceiling.",
  minimum: 100,
  maximum: 600_000,
  default: 120_000,
};

const maxOutputBytes = {
  type: "integer",
  description: "Maximum captured output in bytes. Excess is stored as an artifact.",
  minimum: 1_024,
  maximum: 10_485_760,
  default: 1_048_576,
};

/** Keep the model-facing read window aligned with context promotion. */
export const DEFAULT_READ_MAX_LINES = 400;

const readRangeProperties = {
  path: relativePath,
  startLine: { type: "integer", minimum: 1, default: 1 },
  maxLines: { type: "integer", minimum: 1, maximum: 5_000, default: DEFAULT_READ_MAX_LINES },
  mode: { type: "string", enum: ["preview", "exact"], default: "exact" },
  maxBytes: {
    type: "integer",
    minimum: 1_024,
    maximum: 8 * 1024 * 1024,
    description: "Maximum file bytes read by the runtime before an excerpt is made.",
  },
  allowAbsolute: { type: "boolean", default: false },
};

const readManyItem = objectSchema(readRangeProperties, ["path"]);

/** The P0 native catalog from §12.2. */
export const NATIVE_TOOLS: readonly ToolDefinition[] = [
  // ---- Filesystem and search ----
  {
    id: "fs.read",
    title: "Read",
    description: "Read one file, optionally a line range, with a content checksum.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R5",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["read", "file", "open", "cat", "view", "inspect", "source"],
    parameters: objectSchema(
      {
        ...readRangeProperties,
      },
      ["path"],
    ),
  },
  {
    id: "fs.read_many",
    title: "ReadMany",
    description: "Read several files in one bounded batch.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R5",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["read", "batch", "multiple", "files", "parallel"],
    parameters: objectSchema(
      {
        // `paths` is the legacy batch shape. `items` adds independent ranges while
        // keeping the old sidecar request usable during the protocol transition.
        paths: {
          type: "array",
          items: relativePath,
          minItems: 1,
          maxItems: 20,
        },
        items: {
          type: "array",
          items: readManyItem,
          minItems: 1,
          maxItems: 20,
        },
        maxLines: { type: "integer", minimum: 1, maximum: 5_000, default: DEFAULT_READ_MAX_LINES },
        maxTotalLines: { type: "integer", minimum: 1, maximum: 10_000 },
        maxTotalBytes: { type: "integer", minimum: 1_024, maximum: 16 * 1024 * 1024 },
        concurrency: { type: "integer", minimum: 1, maximum: 8, default: 4 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        allowAbsolute: { type: "boolean", default: false },
      },
      [],
    ),
  },
  {
    id: "fs.list",
    title: "List",
    description: "List the entries of one directory.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["list", "directory", "ls", "tree", "folder", "browse"],
    parameters: objectSchema(
      {
        path: { ...relativePath, default: "." },
        maxEntries: { type: "integer", minimum: 1, maximum: 5_000, default: 500 },
        includeIgnored: { type: "boolean", default: false },
      },
      [],
    ),
  },
  {
    id: "fs.glob",
    title: "Glob",
    description: "Find files by glob pattern.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["glob", "find", "pattern", "match", "files", "search paths"],
    parameters: objectSchema(
      {
        pattern: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 2_000, default: 200 },
      },
      ["pattern"],
    ),
  },
  {
    id: "fs.search",
    title: "Search",
    description: "Search file contents for a literal or regular expression.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["search", "grep", "ripgrep", "find text", "symbol", "usage", "reference"],
    parameters: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 1_024 },
        include: { type: "string", description: "Restrict to paths matching this glob." },
        caseSensitive: { type: "boolean", default: false },
        regex: { type: "boolean", default: false },
        maxMatches: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      ["query"],
    ),
  },
  {
    id: "fs.apply_patch",
    title: "ApplyPatch",
    description: "Apply a structured unified diff as one all-or-nothing transaction.",
    source: "native",
    defaultRisk: "R2",
    maxRisk: "R2",
    alwaysActive: true,
    mutates: true,
    network: false,
    keywords: ["patch", "diff", "edit", "modify", "apply", "change", "fix"],
    parameters: objectSchema(
      {
        diff: { type: "string", minLength: 1, maxLength: 2_000_000 },
        // §12.5: expected hashes give optimistic concurrency per file.
        expectedHashes: {
          type: "object",
          description: "Map of workspace-relative path to the SHA-256 read earlier.",
          additionalProperties: { type: "string" },
        },
      },
      ["diff"],
    ),
  },
  {
    id: "fs.write",
    title: "Write",
    description: "Create or replace a complete file.",
    source: "native",
    defaultRisk: "R2",
    maxRisk: "R2",
    alwaysActive: true,
    mutates: true,
    network: false,
    keywords: ["write", "create", "file", "new", "replace", "save"],
    parameters: objectSchema(
      {
        path: relativePath,
        content: { type: "string", maxLength: 1_048_576 },
        // §12.6: create/replace intent must be explicit.
        intent: { type: "string", enum: ["create", "replace", "upsert"], default: "create" },
        expectedHash: {
          type: "string",
          description: "Required when replacing an existing file.",
        },
      },
      ["path", "content", "intent"],
    ),
  },
  {
    id: "fs.move",
    title: "Move",
    description: "Move or rename a path.",
    source: "native",
    defaultRisk: "R2",
    maxRisk: "R2",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["move", "rename", "mv", "relocate"],
    parameters: objectSchema(
      {
        from: relativePath,
        to: relativePath,
        expectedHash: {
          type: "string",
          description: "Required when moving an existing file: the checksum fs.read returned.",
        },
      },
      ["from", "to"],
    ),
  },
  {
    id: "fs.delete",
    title: "Delete",
    description: "Delete a file or directory.",
    source: "native",
    // §12.2: R3–R4 by default because deletion is not locally reversible.
    defaultRisk: "R3",
    maxRisk: "R4",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["delete", "remove", "rm", "unlink", "erase"],
    parameters: objectSchema(
      {
        path: relativePath,
        recursive: { type: "boolean", default: false },
        expectedHash: {
          type: "string",
          description: "Required when deleting an existing file: the checksum fs.read returned.",
        },
      },
      ["path"],
    ),
  },

  // ---- Process ----
  {
    id: "process.run",
    title: "Run",
    description: "Run an executable with an explicit argv and wait for it to exit.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R6",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["run", "execute", "command", "test", "build", "compile", "lint", "format"],
    parameters: objectSchema(
      {
        // §12.3: executable plus argv, never a raw string.
        program: { type: "string", minLength: 1, maxLength: 512 },
        args: { type: "array", items: { type: "string", maxLength: 4_096 }, maxItems: 128, default: [] },
        cwd: { ...relativePath, default: "." },
        timeoutMs,
        maxOutputBytes,
        env: { type: "object", additionalProperties: { type: "string" } },
        // §24.1 / P0-03: the model states *intent*; the policy engine decides.
        // A `network` mode the model could set to `allow` was a grant, which the
        // model must never make — so the mode itself is gone from this schema.
        networkIntent: {
          type: "object",
          properties: {
            required: { type: "boolean", default: false },
            reason: { type: "string", maxLength: 512 },
          },
          required: ["required"],
          additionalProperties: false,
        },
      },
      ["program", "timeoutMs"],
    ),
  },
  {
    id: "process.start",
    title: "Start",
    description: "Start a background job and return its stable job ID.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R6",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["background", "start", "job", "daemon", "watch", "monitor", "server"],
    parameters: objectSchema(
      {
        program: { type: "string", minLength: 1, maxLength: 512 },
        args: { type: "array", items: { type: "string" }, maxItems: 128, default: [] },
        cwd: { ...relativePath, default: "." },
        timeoutMs,
        maxOutputBytes,
      },
      ["program", "timeoutMs"],
    ),
  },
  {
    id: "process.input",
    title: "Input",
    description: "Write to a running job's standard input.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R6",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["stdin", "input", "interactive", "type", "respond"],
    parameters: objectSchema(
      {
        jobId: { type: "string", minLength: 1 },
        data: { type: "string", maxLength: 65_536 },
        close: { type: "boolean", default: false },
      },
      ["jobId"],
    ),
  },
  {
    id: "process.stop",
    title: "Stop",
    description: "Terminate a job this session owns, including its descendants.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R1",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["stop", "kill", "terminate", "cancel", "job"],
    parameters: objectSchema({ jobId: { type: "string", minLength: 1 } }, ["jobId"]),
  },
  {
    id: "shell.run",
    title: "Shell",
    description:
      "Run a raw shell script. Needed only for pipes, redirection, and shell built-ins.",
    source: "native",
    // §12.3: raw shell is approval-gated by default.
    defaultRisk: "R3",
    maxRisk: "R6",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["shell", "bash", "sh", "pipe", "redirect", "script", "chain"],
    parameters: objectSchema(
      {
        script: { type: "string", minLength: 1, maxLength: 65_536 },
        cwd: { ...relativePath, default: "." },
        timeoutMs,
        maxOutputBytes,
      },
      ["script", "timeoutMs"],
    ),
  },

  // ---- artifacts (§18.17) ----
  {
    id: "artifact.read",
    title: "ArtifactRead",
    description: "Read a bounded head/tail excerpt of a previously spilled artifact by its SHA-256 digest.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["artifact", "spill", "output", "log", "digest", "recover"],
    parameters: objectSchema(
      {
        digest: { type: "string", minLength: 64, maxLength: 64 },
        excerptHeadLines: { type: "integer", minimum: 0, maximum: 2_000, default: 200 },
        excerptTailLines: { type: "integer", minimum: 0, maximum: 2_000, default: 200 },
        excerptMaxBytes: { type: "integer", minimum: 1_024, maximum: 65_536, default: 65_536 },
      },
      ["digest"],
    ),
  },

  // ---- Git ----
  {
    id: "git.status",
    title: "GitStatus",
    description: "Summarize the repository status.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["git", "status", "branch", "dirty", "staged", "untracked"],
    parameters: objectSchema({}, []),
  },
  {
    id: "git.diff",
    title: "GitDiff",
    description: "Show the working tree or a range diff.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["git", "diff", "changes", "hunks", "review"],
    parameters: objectSchema(
      {
        range: { type: "string", description: "A revision range such as HEAD~1..HEAD." },
        paths: { type: "array", items: relativePath, maxItems: 64 },
      },
      [],
    ),
  },
  {
    id: "git.log",
    title: "GitLog",
    description: "List recent commits.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["git", "log", "history", "commits", "blame"],
    parameters: objectSchema(
      { limit: { type: "integer", minimum: 1, maximum: 200, default: 20 }, path: relativePath },
      [],
    ),
  },
  {
    id: "git.show",
    title: "GitShow",
    description: "Show a commit or a path at a revision.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["git", "show", "revision", "commit", "previous version"],
    parameters: objectSchema(
      { revision: { type: "string", minLength: 1 }, path: relativePath },
      ["revision"],
    ),
  },
  {
    id: "git.checkpoint",
    title: "GitCheckpoint",
    description:
      "Create a local safety checkpoint object without committing to any branch.",
    source: "native",
    defaultRisk: "R2",
    maxRisk: "R2",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["git", "checkpoint", "safety", "stash", "snapshot", "backup"],
    parameters: objectSchema({ label: { type: "string", maxLength: 200 } }, []),
  },

  // ---- Interaction and extension ----
  {
    id: "user.ask",
    title: "Ask",
    description: "Ask the user for a clarification or a choice.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["ask", "clarify", "question", "choose", "confirm", "user"],
    parameters: objectSchema(
      {
        question: { type: "string", minLength: 1, maxLength: 2_000 },
        choices: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 8 },
      },
      ["question"],
    ),
  },
  {
    id: "task.search",
    title: "TaskSearch",
    description: "Discover subagent roles suited to a piece of work.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    // Keep discovery language-matched for Korean prompts as well as English ones.
    keywords: [
      "subagent",
      "agent",
      "delegate",
      "role",
      "task",
      "parallel",
      "explore",
      "\uC11C\uBE0C",
      "\uC5D0\uC774\uC804\uD2B8",
      "\uD558\uC704",
      "\uC791\uC5C5",
      "\uCF54\uB4DC\uBCA0\uC774\uC2A4",
      "\uBD84\uC11D",
    ],
    parameters: objectSchema({ query: { type: "string", minLength: 1, maxLength: 500 } }, ["query"]),
  },
  {
    id: "task.spawn",
    title: "Task",
    description:
      "Spawn a subagent to complete a scoped parallel task. The §15.4 contract is enforced at spawn: " +
      "the goal must be a specific, scoped objective of at least 20 characters (vague goals like 'fix the repo' are refused); " +
      "writer roles (executor, refactorer) need allowedPaths plus explicit constraints and expectedOutput; " +
      "read-only roles must not receive allowedPaths. " +
      "Pass facts you already collected in context so the child does not re-read them.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R2",
    alwaysActive: false,
    mutates: false,
    network: false,
    // Keep discovery language-matched for Korean prompts as well as English ones.
    keywords: [
      "subagent",
      "spawn",
      "delegate",
      "task",
      "parallel",
      "executor",
      "reviewer",
      "\uC11C\uBE0C",
      "\uC5D0\uC774\uC804\uD2B8",
      "\uD558\uC704",
      "\uC791\uC5C5",
      "\uCF54\uB4DC\uBCA0\uC774\uC2A4",
      "\uBD84\uC11D",
    ],
    parameters: objectSchema(
      {
        role: { type: "string", enum: ["explore", "planner", "architect", "executor", "refactorer", "reviewer", "test"] },
        name: { type: "string", minLength: 1, maxLength: 80 },
        // §15.4: goal, constraints, and contract are mandatory (SUB-002).
        title: { type: "string", minLength: 1, maxLength: 80 },
        // MIN_GOAL_LENGTH in @cbc/subagents is 20; a shorter goal passes the schema
        // only to be refused by validateTask, wasting the call with INVALID_ARGUMENT.
        goal: { type: "string", minLength: 20, maxLength: 2_000 },
        constraints: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 500 },
          minItems: 1,
          maxItems: 12,
        },
        expectedOutput: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 500 },
          minItems: 1,
          maxItems: 12,
        },
        context: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 500 },
          maxItems: 12,
          default: [],
        },
        allowedPaths: { type: "array", items: relativePath, maxItems: 32, default: [] },
        forbiddenPaths: { type: "array", items: relativePath, maxItems: 32, default: [] },
        verification: { type: "array", items: { type: "string", maxLength: 500 }, default: [] },
        modelProfile: { type: "string", default: "auto" },
        dependencies: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 80 },
          maxItems: 2,
          default: [],
        },
        // §15.7 caps every child at five minutes; buildTask clamps anything
        // larger, so the schema states the real ceiling instead of a value a
        // spawn can never actually receive.
        deadlineMs: { type: "integer", minimum: 1_000, maximum: 300_000, default: 300_000 },
        detached: { type: "boolean", default: false },
      },
      ["role", "title", "goal", "constraints", "expectedOutput"],
    ),
  },
  {
    id: "task.status",
    title: "Subagent",
    description: "Manage and inspect detached task subagents.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["subagent", "status", "inspect", "await", "monitor", "task", "progress"],
    parameters: objectSchema(
      { taskId: { type: "string" }, awaitCompletion: { type: "boolean", default: false } },
      [],
    ),
  },
  {
    id: "task.cancel",
    title: "TaskCancel",
    description: "Cancel a running subagent, its processes, and its transaction.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R1",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["cancel", "abort", "stop", "task", "subagent"],
    parameters: objectSchema(
      { taskId: { type: "string", minLength: 1 }, reason: { type: "string", maxLength: 500 } },
      ["taskId"],
    ),
  },
  {
    id: "skill.search",
    title: "SkillSearch",
    description: "Find Skill metadata matching a piece of work.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["skill", "workflow", "procedure", "playbook", "recipe"],
    parameters: objectSchema({ query: { type: "string", minLength: 1, maxLength: 500 } }, ["query"]),
  },
  {
    id: "skill.load",
    title: "SkillLoad",
    description: "Load a Skill's full instructions on demand.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["skill", "load", "instructions", "activate"],
    parameters: objectSchema({ name: { type: "string", minLength: 1, maxLength: 128 } }, ["name"]),
  },
  {
    id: "mcp.search",
    title: "McpSearch",
    description: "Find an MCP server capability.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["mcp", "external", "integration", "server", "capability", "issue tracker"],
    parameters: objectSchema({ query: { type: "string", minLength: 1, maxLength: 500 } }, ["query"]),
  },
  {
    id: "mcp.call",
    title: "McpCall",
    description: "Invoke an MCP tool on a configured server.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R6",
    alwaysActive: false,
    mutates: false,
    network: true,
    keywords: ["mcp", "call", "invoke", "external", "tool"],
    parameters: objectSchema(
      {
        server: { type: "string", minLength: 1 },
        tool: { type: "string", minLength: 1 },
        arguments: { type: "object", additionalProperties: true },
      },
      ["server", "tool"],
    ),
  },
  {
    id: "mcp.read_resource",
    title: "McpResource",
    description: "Read an MCP resource.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R1",
    alwaysActive: false,
    mutates: false,
    network: true,
    keywords: ["mcp", "resource", "read", "document", "docs"],
    parameters: objectSchema(
      { server: { type: "string", minLength: 1 }, uri: { type: "string", minLength: 1 } },
      ["server", "uri"],
    ),
  },
  {
    id: "todo.write",
    title: "TodoWrite",
    description: "Update the root session TODO checklist with a revision and evidence. Valid lifecycle: new->pending/active, pending->active, active->done with evidence. One request may hand off an active item to done and a different pending item to active; preserve item scope during completion.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    authority: "session_state",
    keywords: ["todo", "plan", "checklist", "track", "progress"],
    parameters: objectSchema(
      {
        expectedRevision: { type: "integer", minimum: 0 },
        reason: { type: "string", minLength: 1, maxLength: 300 },
        document: {
          type: "object",
          additionalProperties: false,
          required: ["goal", "context", "criticalFiles", "verification", "risks", "rollback"],
          properties: {
            goal: { type: "string", minLength: 1, maxLength: 1000 },
            context: { type: "array", minItems: 1, maxItems: 128, items: { type: "string", minLength: 1, maxLength: 500 } },
            assumptions: { type: "array", maxItems: 128, items: { type: "string", maxLength: 500 } },
            criticalFiles: {
              type: "array", minItems: 1, maxItems: 128,
              items: {
                type: "object", additionalProperties: false, required: ["path"],
                properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, symbols: { type: "array", maxItems: 32, items: { type: "string", maxLength: 240 } }, anchors: { type: "array", maxItems: 32, items: { type: "string", maxLength: 240 } }, anchor: { type: "string", maxLength: 240 }, reason: { type: "string", maxLength: 500 }, purpose: { type: "string", maxLength: 500 } },
              },
            },
            verification: {
              type: "array", minItems: 1, maxItems: 128,
              items: {
                type: "object", additionalProperties: false,
                properties: { id: { type: "string", maxLength: 64 }, description: { type: "string", maxLength: 500 }, command: { type: "string", maxLength: 1000 }, expected: { type: "string", maxLength: 1000 }, expectedResult: { type: "string", maxLength: 1000 }, status: { enum: ["pending", "running", "passed", "failed", "not_run"] }, evidence: { type: "string", maxLength: 1000 } },
              },
            },
            externalActions: {
              type: "array", maxItems: 128,
              items: { type: "object", additionalProperties: false, required: ["server", "tool"], properties: { server: { type: "string", minLength: 1, maxLength: 128 }, tool: { type: "string", minLength: 1, maxLength: 256 }, action: { type: "string", maxLength: 256 }, description: { type: "string", maxLength: 500 }, reason: { type: "string", maxLength: 500 }, risk: { type: "string", maxLength: 120 }, detail: { type: "string", maxLength: 500 }, arguments: { type: "object", additionalProperties: true } } },
            },
            risks: { type: "array", maxItems: 128, items: { type: "string", maxLength: 500 } },
            rollback: { type: "array", maxItems: 128, items: { type: "string", maxLength: 500 } },
          },
        },
        items: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "text", "status"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              text: { type: "string", minLength: 1, maxLength: 240 },
              status: { enum: ["pending", "active", "done", "blocked", "skipped"] },
              kind: { enum: ["analysis", "implementation", "verification"] },
              details: { type: "string", maxLength: 1000 },
              files: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 4096 } },
              symbols: { type: "array", maxItems: 32, items: { type: "string", maxLength: 240 } },
              acceptanceCriteria: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
              dependsOn: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } },
              commands: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
              evidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 240 } },
              blockedReason: { type: "string", maxLength: 300 },
            },
          },
        },
      },
      ["expectedRevision", "reason", "items"],
    ),
  },
  {
    id: "tool.discover",
    title: "Discover",
    description: "Search the tool catalog and activate the schemas you need.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["discover", "tools", "capability", "search", "activate"],
    parameters: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
      ["query"],
    ),
  },
  {
    id: "repo.investigate",
    title: "Investigate",
    description: "Run bounded repository searches, reads, manifest discovery, and an optional git diff in one read-only call.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R5",
    alwaysActive: true,
    mutates: false,
    network: false,
    authority: "read",
    keywords: ["repository", "investigate", "search", "read", "manifest", "diff", "batch"],
    parameters: objectSchema(
      {
        queries: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 1_024 },
          maxItems: 5,
        },
        paths: {
          type: "array",
          items: relativePath,
          maxItems: 20,
        },
        includeManifests: { type: "boolean", default: true },
        includeGitDiff: { type: "boolean", default: false },
        maxFiles: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        maxLinesPerFile: { type: "integer", minimum: 1, maximum: 1_000, default: 200 },
      },
      [],
    ),
  },
  {
    id: "verification.run_many",
    title: "VerifyMany",
    description: "Run several bounded verification commands with per-command permission checks and stable ordered results.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R4",
    alwaysActive: true,
    mutates: false,
    network: false,
    authority: "process",
    keywords: ["verification", "tests", "lint", "typecheck", "build", "parallel", "batch"],
    parameters: objectSchema(
      {
        commands: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 2_000 },
          minItems: 1,
          maxItems: 12,
        },
        maxParallel: { type: "integer", minimum: 1, maximum: 4, default: 2 },
        failFast: { type: "boolean", default: false },
      },
      ["commands"],
    ),
  },
] as const;

export function withExecutionMetadata(tool: ToolDefinition): ToolDefinition {
  const authority: ToolExecutionMetadata["authority"] = tool.authority ?? (tool.mutates
    ? "workspace_write"
    : tool.id.startsWith("process.") || tool.id === "shell.run" || tool.id.startsWith("test.")
      ? "process"
      : tool.network
        ? (tool.id.startsWith("mcp.") ? "external_effect" : "network")
        : "read");
  const idempotency: ToolExecutionMetadata["idempotency"] = tool.mutates || authority === "external_effect" || authority === "process"
    ? "non_idempotent"
    : tool.network
      ? "idempotent"
      : "pure";
  const readOnlyLocal = authority === "read" && tool.network === false;
  const maxParallelism = authority === "read" ? 8 : authority === "process" ? 2 : 1;
  return {
    ...tool,
    idempotency: tool.idempotency ?? idempotency,
    authority,
    conflictKeys: tool.conflictKeys ?? defaultConflictKeys,
    canRunInProgram: tool.canRunInProgram ?? (readOnlyLocal && ["fs.read", "fs.read_many", "fs.list", "fs.glob", "fs.search", "git.status", "git.diff", "git.log"].includes(tool.id)),
    canRunInHostedAgent: tool.canRunInHostedAgent ?? (readOnlyLocal && ["fs.read", "fs.read_many", "fs.list", "fs.glob", "fs.search", "git.status", "git.diff", "git.log"].includes(tool.id)),
    maxParallelism: tool.maxParallelism ?? maxParallelism,
    resultSchemaId: tool.resultSchemaId ?? `${tool.id}.result`,
  };
}

/** Model-facing Plan filter. Session-state updates are safe but workspace effects are not. */
export function isPlanSafeTool(tool: ToolDefinition): boolean {
  return tool.authority === "session_state" || (
    (tool.authority ?? "read") === "read" &&
    tool.defaultRisk === "R0" &&
    tool.mutates === false &&
    tool.network === false
  );
}

function defaultConflictKeys(args: unknown): readonly string[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const input = args as Record<string, unknown>;
  const keys: string[] = [];
  for (const key of ["path", "from", "to", "cwd", "server", "uri"]) {
    if (typeof input[key] === "string") keys.push(`${key}:${input[key]}`);
  }
  if (Array.isArray(input.paths)) for (const path of input.paths) if (typeof path === "string") keys.push(`path:${path}`);
  return [...new Set(keys)].sort();
}
export function findTool(id: string): ToolDefinition | undefined {
  const tool = NATIVE_TOOLS.find((t) => t.id === id);
  return tool === undefined ? undefined : withExecutionMetadata(tool);
}

export function alwaysActiveTools(): ToolDefinition[] {
  return NATIVE_TOOLS.filter((t) => t.alwaysActive).map(withExecutionMetadata);
}

/** §12.4 common result envelope. */
export interface ArtifactRef {
  id: string;
  digest: string;
  mediaType: string;
  bytes: number;
  redaction: "raw" | "redacted" | "derived";
  displayName?: string;
  retentionClass: "session" | "temporary" | "pinned";
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  artifacts?: ArtifactRef[];
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  data?: unknown;
}

export function okResult(summary: string, data?: unknown, extras?: Partial<ToolResult>): ToolResult {
  return { ok: true, summary, ...(data !== undefined ? { data } : {}), ...extras };
}

export function errorResult(
  code: string,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown>; summary?: string } = {},
): ToolResult {
  return {
    ok: false,
    summary: options.summary ?? `${code}: ${message}`,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
  };
}
