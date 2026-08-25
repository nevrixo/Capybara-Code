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
export type ToolIdempotency = "pure" | "idempotent" | "reconcilable" | "non_idempotent";

export interface ToolRecoveryMetadata {
  readonly maxAttempts: number;
  readonly retryableCodes: readonly string[];
  readonly retrySafety: "always" | "before_dispatch" | "reconcile" | "never";
  readonly reconcile?: "runtime_operation" | "process_job" | "mcp_operation";
}

export interface ToolExecutionMetadata {
  readonly idempotency: ToolIdempotency;
  readonly authority: "read" | "session_state" | "workspace_write" | "process" | "network" | "external_effect";
  readonly conflictKeys: (args: unknown) => readonly string[];
  readonly canRunInProgram: boolean;
  readonly canRunInHostedAgent: boolean;
  readonly maxParallelism: number;
  readonly resultSchemaId: string;
  readonly recovery: ToolRecoveryMetadata;
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
  readonly recovery?: Partial<ToolRecoveryMetadata>;
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

/** Bounded zero-based UTF-16 coordinates accepted by semantic LSP lookups. */
const lspTextDocumentPosition = {
  path: {
    ...relativePath,
    maxLength: 512,
    description: "Workspace-relative source path for a bounded LSP semantic lookup.",
  },
  line: { type: "integer", minimum: 0, maximum: 1_000_000 },
  character: { type: "integer", minimum: 0, maximum: 1_000_000 },
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
  recordEvidence: {
    type: "boolean",
    description: "Persist an opaque evidence ID only for a complete exact read; sensitive or partial reads are refused.",
  },
  allowAbsolute: { type: "boolean", default: false },
};

const readManyItem = objectSchema(readRangeProperties, ["path"]);
const structuredEditOperation = {
  type: "object",
  properties: {
    operationId: { type: "string", minLength: 1, maxLength: 256 },
    kind: {
      type: "string",
      enum: [
        "replace_anchor",
        "replace_range",
        "insert_before",
        "insert_after",
        "delete_anchor",
        "create_file",
        "move_file",
        "delete_file",
      ],
    },
    path: relativePath,
    toPath: relativePath,
  },
  required: ["operationId", "kind", "path"],
  // Rust owns operation-specific and anchor/range validation.
  additionalProperties: true,
};

const structuredEditPlan = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", enum: ["1.0"] },
    id: { type: "string", minLength: 1, maxLength: 256 },
    source: { type: "string", enum: ["model", "lsp", "plugin", "merge", "user"] },
    workspaceIdentityDigest: { type: "string", minLength: 1, maxLength: 512 },
    sessionId: { type: "string", minLength: 1, maxLength: 256 },
    operations: { type: "array", items: structuredEditOperation, minItems: 1, maxItems: 100 },
    conflictPolicy: { type: "string", enum: ["fail", "safe_rebase"] },
    createdAt: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: [
    "schemaVersion",
    "id",
    "source",
    "workspaceIdentityDigest",
    "sessionId",
    "operations",
    "conflictPolicy",
    "createdAt",
  ],
  // The versioned plan has anchor-specific fields Rust validates authoritatively.
  additionalProperties: true,
};


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
    id: "lsp.diagnostics",
    title: "LspDiagnostics",
    description: "Read bounded, revision-bound diagnostics cached from configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "pure",
    maxParallelism: 2,
    resultSchemaId: "lsp.diagnostics.v1",
    keywords: ["lsp", "diagnostics", "type errors", "language server", "problems"],
    parameters: objectSchema(
      {
        path: relativePath,
      },
      ["path"],
    ),
  },
  {
    id: "lsp.symbols",
    title: "LspDocumentSymbols",
    description: "Read bounded document symbols through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.symbols.v1",
    keywords: ["lsp", "symbols", "document outline", "structure", "language server"],
    parameters: objectSchema(
      {
        path: {
          ...relativePath,
          maxLength: 512,
          description: "Workspace-relative source path for a bounded LSP document-symbol lookup.",
        },
      },
      ["path"],
    ),
  },
  {
    id: "lsp.workspace_symbols",
    title: "LspWorkspaceSymbols",
    description: "Search bounded workspace-local symbols through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.workspace_symbols.v1",
    keywords: ["lsp", "workspace symbols", "find symbol", "symbol search", "language server"],
    parameters: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "Bounded symbol-search text sent only to configured local language servers.",
        },
      },
      ["query"],
    ),
  },
  {
    id: "lsp.definition",
    title: "LspDefinition",
    description: "Find bounded workspace-local definition locations through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.definition.v1",
    keywords: ["lsp", "definition", "go to definition", "symbol", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.declaration",
    title: "LspDeclaration",
    description: "Find bounded workspace-local declaration locations through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.declaration.v1",
    keywords: ["lsp", "declaration", "go to declaration", "symbol", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.type_definition",
    title: "LspTypeDefinition",
    description: "Find bounded workspace-local type-definition locations through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.type_definition.v1",
    keywords: ["lsp", "type definition", "go to type", "symbol", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.implementation",
    title: "LspImplementation",
    description: "Find bounded workspace-local implementation locations through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.implementation.v1",
    keywords: ["lsp", "implementation", "go to implementation", "symbol", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.references",
    title: "LspReferences",
    description: "Find bounded workspace-local references through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.references.v1",
    keywords: ["lsp", "references", "usages", "find references", "language server"],
    parameters: objectSchema(
      {
        ...lspTextDocumentPosition,
        includeDeclaration: {
          type: "boolean",
          default: true,
          description: "Whether the declaration itself should be included in reference results.",
        },
      },
      ["path", "line", "character"],
    ),
  },
  {
    id: "lsp.hover",
    title: "LspHover",
    description: "Read bounded hover text through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.hover.v1",
    keywords: ["lsp", "hover", "symbol information", "type information", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.signature_help",
    title: "LspSignatureHelp",
    description: "Read bounded signature labels through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.signature_help.v1",
    keywords: ["lsp", "signature", "parameters", "call help", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.document_highlights",
    title: "LspDocumentHighlights",
    description: "Read bounded document-local symbol highlights through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.document_highlights.v1",
    keywords: ["lsp", "highlights", "symbol occurrences", "read write", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.call_hierarchy",
    title: "LspCallHierarchy",
    description:
      "Read one bounded incoming or outgoing workspace-local call-hierarchy page through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 1,
    resultSchemaId: "lsp.call_hierarchy.v1",
    keywords: [
      "lsp",
      "call hierarchy",
      "incoming calls",
      "outgoing calls",
      "callers",
      "callees",
      "language server",
    ],
    parameters: objectSchema(
      {
        ...lspTextDocumentPosition,
        direction: {
          type: "string",
          enum: ["incoming", "outgoing"],
          description: "Whether to return callers (incoming) or callees (outgoing).",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 256,
          default: 0,
          description: "Zero-based bounded page offset.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 32,
          default: 16,
          description: "Maximum number of call edges returned in this page.",
        },
      },
      ["path", "line", "character", "direction"],
    ),
  },
  {
    id: "lsp.code_actions",
    title: "LspCodeActions",
    description: "Read a bounded non-executable code-action catalog through configured local language servers.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 2,
    resultSchemaId: "lsp.code_actions.v1",
    keywords: ["lsp", "code actions", "quick fix", "refactor", "language server"],
    parameters: objectSchema(lspTextDocumentPosition, ["path", "line", "character"]),
  },
  {
    id: "lsp.code_action_preview",
    title: "LspCodeActionPreview",
    description: "Create a bounded revision-bound proposal from a command-free code action without writing files.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 1,
    resultSchemaId: "lsp.code_action_preview.v1",
    keywords: ["lsp", "code action", "quick fix", "refactor", "preview", "language server"],
    parameters: objectSchema(
      {
        ...lspTextDocumentPosition,
        actionIndex: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description: "Zero-based index from lsp.code_actions. The returned proposal does not write files.",
        },
      },
      ["path", "line", "character", "actionIndex"],
    ),
  },
  {
    id: "lsp.format_preview",
    title: "LspFormatPreview",
    description:
      "Create a bounded current-revision formatting proposal through configured local language servers without writing files.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 1,
    resultSchemaId: "lsp.format_preview.v1",
    keywords: ["lsp", "format", "formatting", "preview", "language server"],
    parameters: objectSchema(
      {
        path: {
          ...relativePath,
          maxLength: 512,
          description: "Workspace-relative source path for a bounded formatting proposal.",
        },
      },
      ["path"],
    ),
  },
  {
    id: "lsp.range_format_preview",
    title: "LspRangeFormatPreview",
    description:
      "Create a bounded current-revision formatting proposal for one explicit source range without writing files.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 1,
    resultSchemaId: "lsp.range_format_preview.v1",
    keywords: ["lsp", "range", "format", "formatting", "preview", "language server"],
    parameters: objectSchema(
      {
        path: {
          ...relativePath,
          maxLength: 512,
          description: "Workspace-relative source path for a bounded range formatting proposal.",
        },
        startLine: { type: "integer", minimum: 0, maximum: 1_000_000 },
        startCharacter: { type: "integer", minimum: 0, maximum: 1_000_000 },
        endLine: { type: "integer", minimum: 0, maximum: 1_000_000 },
        endCharacter: { type: "integer", minimum: 0, maximum: 1_000_000 },
      },
      ["path", "startLine", "startCharacter", "endLine", "endCharacter"],
    ),
  },
  {
    id: "lsp.rename_preview",
    title: "LspRenamePreview",
    description: "Create a bounded revision-bound rename proposal through configured local language servers without writing files.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    idempotency: "idempotent",
    maxParallelism: 1,
    resultSchemaId: "lsp.rename_preview.v1",
    keywords: ["lsp", "rename", "refactor", "preview", "language server"],
    parameters: objectSchema(
      {
        ...lspTextDocumentPosition,
        newName: {
          type: "string",
          minLength: 1,
          maxLength: 1_024,
          description: "New symbol name. The returned proposal does not write files.",
        },
      },
      ["path", "line", "character", "newName"],
    ),
  },
  {
    id: "memory.search",
    title: "RecallMemory",
    description: "Recall bounded, fresh, evidence-backed memory from this workspace only.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "read",
    keywords: ["memory", "recall", "evidence", "fact", "history", "context"],
    parameters: objectSchema(
      {
        key: { type: "string", minLength: 1, maxLength: 512 },
        query: { type: "string", minLength: 1, maxLength: 2_048 },
        statuses: {
          type: "array",
          items: { type: "string", enum: ["active", "superseded", "contested"] },
          maxItems: 3,
        },
        scopes: {
          type: "array",
          items: { type: "string", enum: ["workspace", "session", "task"] },
          maxItems: 3,
        },
        taskId: { type: "string", minLength: 1, maxLength: 256 },
        path: relativePath,
        limit: { type: "integer", minimum: 1, maximum: 200, default: 32 },
      },
      [],
    ),
  },
  {
    id: "memory.remember",
    title: "Remember",
    description: "Persist a concise fact only when one or more runtime-issued evidence IDs support it.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R1",
    alwaysActive: false,
    mutates: false,
    network: false,
    authority: "session_state",
    idempotency: "reconcilable",
    maxParallelism: 1,
    keywords: ["memory", "remember", "evidence", "fact", "persist", "context"],
    parameters: objectSchema(
      {
        key: { type: "string", minLength: 1, maxLength: 512 },
        value: {
          type: "string",
          minLength: 1,
          maxLength: 16 * 1_024,
          description: "A concise factual claim, never raw transcript, secrets, or hidden reasoning.",
        },
        scope: { type: "string", enum: ["workspace", "session", "task"], default: "workspace" },
        taskId: { type: "string", minLength: 1, maxLength: 256 },
        paths: { type: "array", items: relativePath, maxItems: 128 },
        evidenceIds: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 512 },
          minItems: 1,
          maxItems: 128,
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "A concise factual label for the transition, not chain-of-thought.",
        },
      },
      ["key", "value", "evidenceIds"],
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
    id: "fs.edit.preview",
    title: "PreviewEdit",
    description: "Resolve an anchor/range edit plan against the current workspace without writing files.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R5",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["edit", "preview", "anchor", "range", "replace", "refactor"],
    parameters: objectSchema(
      { plan: structuredEditPlan },
      ["plan"],
    ),
  },
  {
    id: "fs.edit",
    title: "Edit",
    description: "Re-preflight and atomically apply an anchor/range edit plan in one transaction.",
    source: "native",
    defaultRisk: "R2",
    maxRisk: "R2",
    alwaysActive: true,
    mutates: true,
    network: false,
    keywords: ["edit", "anchor", "range", "replace", "refactor", "move", "delete"],
    parameters: objectSchema(
      { plan: structuredEditPlan },
      ["plan"],
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
    description: "Read a bounded head/tail excerpt of a previously spilled artifact by its SHA-256 digest or displayed artifact handle.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R0",
    alwaysActive: true,
    mutates: false,
    network: false,
    keywords: ["artifact", "spill", "output", "log", "digest", "recover"],
    parameters: objectSchema(
      {
        digest: {
          type: "string",
          description: "A 64-character SHA-256 digest or an art_ artifact handle from tool output.",
          minLength: 28,
          maxLength: 71,
          pattern: "^(?:[0-9a-fA-F]{64}|sha256:[0-9a-fA-F]{64}|art_(?:[0-9a-fA-F]{24}|[0-9a-fA-F]{64}))$",
        },
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
  {
    id: "worktree.list",
    title: "WorktreeList",
    description: "List isolated Git worktrees bound to this repository identity.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R1",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["worktree", "git", "parallel", "isolation"],
    parameters: objectSchema({}, []),
  },
  {
    id: "worktree.inspect",
    title: "WorktreeInspect",
    description: "Inspect one managed worktree path, HEAD, and lease state.",
    source: "native",
    defaultRisk: "R0",
    maxRisk: "R1",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["worktree", "inspect", "git"],
    parameters: objectSchema({ path: relativePath }, ["path"]),
  },
  {
    id: "worktree.create",
    title: "WorktreeCreate",
    description: "Create a detached Git worktree under the runtime data root from a verified commit.",
    source: "native",
    defaultRisk: "R2",
    maxRisk: "R3",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["worktree", "create", "isolate", "writer"],
    parameters: objectSchema(
      {
        path: relativePath,
        commit: { type: "string", minLength: 1, maxLength: 128 },
        requireClean: { type: "boolean", default: true },
      },
      ["path", "commit"],
    ),
  },
  {
    id: "worktree.remove",
    title: "WorktreeRemove",
    description: "Remove a managed worktree after its writer lease is released.",
    source: "native",
    defaultRisk: "R3",
    maxRisk: "R4",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["worktree", "remove", "cleanup"],
    parameters: objectSchema({ path: relativePath }, ["path"]),
  },
  {
    id: "merge.preview",
    title: "MergePreview",
    description: "Preview a three-way merge without writing conflict markers into working files.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R2",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["merge", "preview", "conflict", "worktree"],
    parameters: objectSchema(
      {
        base: { type: "string", minLength: 1, maxLength: 128 },
        ours: { type: "string", minLength: 1, maxLength: 128 },
        theirs: { type: "string", minLength: 1, maxLength: 128 },
      },
      ["base", "ours", "theirs"],
    ),
  },
  {
    id: "merge.apply",
    title: "MergeApply",
    description: "Apply a conflict-free three-way merge through the structured Edit Engine. Conflicts fail closed and never write conflict markers.",
    source: "native",
    defaultRisk: "R3",
    maxRisk: "R4",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["merge", "apply", "worktree", "edit"],
    parameters: objectSchema(
      {
        base: { type: "string", minLength: 1, maxLength: 128 },
        ours: { type: "string", minLength: 1, maxLength: 128 },
        theirs: { type: "string", minLength: 1, maxLength: 128 },
      },
      ["base", "ours", "theirs"],
    ),
  },
  {
    id: "merge.resolve",
    title: "MergeResolve",
    description: "Resolve one merge conflict as ours, theirs, or manual text, then apply the result through the Edit Engine.",
    source: "native",
    defaultRisk: "R3",
    maxRisk: "R4",
    alwaysActive: false,
    mutates: true,
    network: false,
    keywords: ["merge", "resolve", "conflict", "worktree"],
    parameters: objectSchema(
      {
        path: relativePath,
        choice: { type: "string", enum: ["ours", "theirs", "manual"] },
        ours: { type: "string" },
        theirs: { type: "string" },
        base: { type: "string" },
        manualText: { type: "string" },
      },
      ["path", "choice"],
    ),
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
      "writer roles (executor, refactorer) need a write scope — pass allowedPaths, or name the files in the goal so they can be inferred; " +
      "constraints and expectedOutput are filled from the goal or matching Plan item when omitted; " +
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
          maxItems: 12,
          default: [],
        },
        expectedOutput: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 500 },
          maxItems: 12,
          default: [],
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
          default: [],
        },
        // §15.7 caps every child at five minutes; buildTask clamps anything
        // larger, so the schema states the real ceiling instead of a value a
        // spawn can never actually receive.
        deadlineMs: { type: "integer", minimum: 1_000, maximum: 300_000, default: 300_000 },
        detached: { type: "boolean", default: false },
      },
      ["role", "title", "goal"],
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
      {
        taskId: { type: "string" },
        awaitCompletion: { type: "boolean", default: false },
        collectContext: { type: "boolean", default: false },
      },
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
    id: "plugin.invoke",
    title: "PluginInvoke",
    description:
      "Invoke an admitted plugin tool. The call still goes through ToolRegistry, permission policy, and the runtime; plugins cannot widen authority.",
    source: "native",
    defaultRisk: "R1",
    maxRisk: "R2",
    alwaysActive: false,
    mutates: false,
    network: false,
    keywords: ["plugin", "hook", "extension", "invoke"],
    parameters: objectSchema(
      {
        pluginId: { type: "string", minLength: 1, maxLength: 200 },
        method: { type: "string", minLength: 1, maxLength: 200 },
        params: { type: "object" },
      },
      ["pluginId", "method"],
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
    authority: "network",
    idempotency: "idempotent",
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
    idempotency: "reconcilable",
    recovery: { maxAttempts: 2, retryableCodes: ["TODO_REVISION_CONFLICT"], retrySafety: "before_dispatch" },
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
/** Experimental tools are absent from the default model catalog until enabled. */
const EDIT_ENGINE_TOOL_IDS = new Set(["fs.edit.preview", "fs.edit"]);
const DURABLE_MEMORY_TOOL_IDS = new Set(["memory.search", "memory.remember"]);
const WORKTREE_TOOL_IDS = new Set([
  "worktree.list",
  "worktree.inspect",
  "worktree.create",
  "worktree.remove",
  "merge.preview",
  "merge.apply",
  "merge.resolve",
]);
const PLUGIN_TOOL_IDS = new Set(["plugin.invoke"]);
const FULL_LSP_TOOL_IDS = new Set([
  "lsp.diagnostics",
  "lsp.symbols",
  "lsp.workspace_symbols",
  "lsp.definition",
  "lsp.declaration",
  "lsp.type_definition",
  "lsp.implementation",
  "lsp.references",
  "lsp.hover",
  "lsp.signature_help",
  "lsp.document_highlights",
  "lsp.call_hierarchy",
  "lsp.code_actions",
  "lsp.code_action_preview",
  "lsp.format_preview",
  "lsp.range_format_preview",
  "lsp.rename_preview",
]);
const LSP_RENAME_PREVIEW_TOOL_IDS = new Set(["lsp.rename_preview"]);
const LSP_CODE_ACTION_PREVIEW_TOOL_IDS = new Set(["lsp.code_action_preview"]);
const LSP_FORMAT_PREVIEW_TOOL_IDS = new Set([
  "lsp.format_preview",
  "lsp.range_format_preview",
]);

export interface NativeToolFeatures {
  readonly editEngineV2?: boolean;
  readonly durableMemory?: boolean;
  readonly worktreeMultiAgent?: boolean;
  readonly fullLsp?: boolean;
  /** Requires the separate LSP mutation rollout and the structured edit engine. */
  readonly lspRenamePreview?: boolean;
  /** Requires the command-free code-action mutation rollout and structured edit engine. */
  readonly lspCodeActionPreview?: boolean;
  /** Requires the formatting mutation rollout and structured edit engine. */
  readonly lspFormattingPreview?: boolean;
  readonly pluginRuntime?: boolean;
}

export function nativeToolsForFeatures(features: NativeToolFeatures = {}): ToolDefinition[] {
  return NATIVE_TOOLS.filter((tool) =>
    (!EDIT_ENGINE_TOOL_IDS.has(tool.id) || features.editEngineV2 === true) &&
    (!DURABLE_MEMORY_TOOL_IDS.has(tool.id) || features.durableMemory === true) &&
    (!WORKTREE_TOOL_IDS.has(tool.id) || features.worktreeMultiAgent === true) &&
    (!FULL_LSP_TOOL_IDS.has(tool.id) || features.fullLsp === true) &&
    (!PLUGIN_TOOL_IDS.has(tool.id) || features.pluginRuntime === true) &&
    (
      !LSP_RENAME_PREVIEW_TOOL_IDS.has(tool.id) ||
      (features.editEngineV2 === true && features.lspRenamePreview === true)
    ) &&
    (
      !LSP_CODE_ACTION_PREVIEW_TOOL_IDS.has(tool.id) ||
      (features.editEngineV2 === true && features.lspCodeActionPreview === true)
    ) &&
    (
      !LSP_FORMAT_PREVIEW_TOOL_IDS.has(tool.id) ||
      (features.editEngineV2 === true && features.lspFormattingPreview === true)
    ),
  );
}


export function withExecutionMetadata(tool: ToolDefinition): ToolDefinition {
  const authority: ToolExecutionMetadata["authority"] = tool.authority ?? (tool.mutates
    ? "workspace_write"
    : tool.id.startsWith("process.") || tool.id === "shell.run" || tool.id.startsWith("test.")
      ? "process"
      : tool.network
        ? (tool.id.startsWith("mcp.") ? "external_effect" : "network")
        : "read");
  const idempotency: ToolExecutionMetadata["idempotency"] = tool.idempotency ?? (
    authority === "session_state"
      ? "reconcilable"
      : tool.mutates || authority === "external_effect" || authority === "process"
        ? "non_idempotent"
        : tool.network
          ? "idempotent"
          : "pure"
  );
  const readOnlyLocal = authority === "read" && tool.network === false;
  const maxParallelism = authority === "read" ? 8 : authority === "process" ? 2 : 1;
  const recovery: ToolRecoveryMetadata = {
    maxAttempts: tool.recovery?.maxAttempts ?? (idempotency === "pure" || idempotency === "idempotent" || idempotency === "reconcilable" ? 3 : 1),
    retryableCodes: tool.recovery?.retryableCodes ?? ["NOT_INITIALIZED", "TIMEOUT", "PATH_CHANGED", "HASH_MISMATCH", "NETWORK_UNAVAILABLE", "RATE_LIMITED", "TEMPORARY_UNAVAILABLE"],
    retrySafety: tool.recovery?.retrySafety ?? (idempotency === "pure" || idempotency === "idempotent" ? "always" : "never"),
    ...(tool.recovery?.reconcile === undefined ? {} : { reconcile: tool.recovery.reconcile }),
  };
  return {
    ...tool,
    idempotency: tool.idempotency ?? idempotency,
    authority,
    conflictKeys: tool.conflictKeys ?? defaultConflictKeys,
    canRunInProgram: tool.canRunInProgram ?? (readOnlyLocal && ["fs.read", "fs.read_many", "fs.list", "fs.glob", "fs.search", "git.status", "git.diff", "git.log"].includes(tool.id)),
    canRunInHostedAgent: tool.canRunInHostedAgent ?? (readOnlyLocal && ["fs.read", "fs.read_many", "fs.list", "fs.glob", "fs.search", "git.status", "git.diff", "git.log"].includes(tool.id)),
    maxParallelism: tool.maxParallelism ?? maxParallelism,
    resultSchemaId: tool.resultSchemaId ?? `${tool.id}.result`,
    recovery,
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

export function alwaysActiveTools(features: NativeToolFeatures = {}): ToolDefinition[] {
  return nativeToolsForFeatures(features).filter((t) => t.alwaysActive).map(withExecutionMetadata);
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
