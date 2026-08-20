/**
 * The single declarative command registry — PRD §8.1, §8.2, P1-03.
 *
 * Everything the CLI says about its own surface is derived from this file:
 * the parser's flag validation, `HELP_TEXT`, and the shell completion
 * scripts. Before this existed the same tree was written three times — the
 * parser in `args.ts`, the help text, and `completion.ts`'s `TREE` — and the
 * three could drift the first time a flag changed.
 */

export type FlagKind =
  /** Present or absent. `--flag=value` is a usage error. */
  | "boolean"
  /** Requires a value: `--flag value` or `--flag=value`. */
  | "value"
  /** May appear bare (`--resume` means the last session). */
  | "optional-value";

export interface FlagSpec {
  /** Canonical spelling, with the leading dashes. */
  readonly name: string;
  readonly kind: FlagKind;
  readonly summary: string;
  /** Accepted spellings after `--flag=` or as the next token. */
  readonly values?: readonly string[];
  /** §8.2's one-letter spellings. */
  readonly short?: string;
}

export interface PositionalSpec {
  readonly label: string;
  readonly required: boolean;
  /** Consumes every remaining positional (the prompt). */
  readonly variadic?: boolean;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  /** Extra accepted spellings (`skill` for `skills`, §16.8). */
  readonly aliases?: readonly string[];
  /** Flags this command (and its subcommands) accept beyond the globals. */
  readonly flags?: readonly FlagSpec[];
  readonly positionals?: readonly PositionalSpec[];
  readonly subcommands?: readonly CommandSpec[];
  /** The subcommand used when the user gives none. */
  readonly defaultSubcommand?: string;
  /**
   * `deferred`: the command builder validates operands with its own wording
   * instead of the generic count check. `auth api` uses this for §8.4's
   * credential-in-shell-history refusal.
   */
  readonly operandPolicy?: "strict" | "deferred";
}

/** Flags accepted on every invocation. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "--help", kind: "boolean", summary: "show help", short: "-h" },
  { name: "--version", kind: "boolean", summary: "print the version", short: "-v" },
];

/** Flags shared by the interactive and headless entry points. */
export const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "--model", kind: "value", summary: "model id or alias" },
  {
    name: "--reasoning",
    kind: "value",
    summary: "none, low, medium, high, xhigh, max",
  },
  { name: "--reasoning-mode", kind: "value", summary: "standard or pro" },
  {
    name: "--mode",
    kind: "value",
    summary: "build or plan (legacy permission values are deprecated)",
    values: ["build", "plan"],
  },
  { name: "--interaction-mode", kind: "value", summary: "build or plan", values: ["build", "plan"] },
  { name: "--permission", kind: "value", summary: "permission preset: read, edit, auto, or yolo", values: ["read", "edit", "auto", "yolo"] },
  { name: "--review", kind: "value", summary: "off or auto", values: ["off", "auto"] },
  {
    name: "--plan",
    kind: "boolean",
    summary: "shorthand for --mode plan",
    short: "-p",
  },
  { name: "--yolo", kind: "boolean", summary: "shorthand for --permission yolo" },
  { name: "--plain", kind: "boolean", summary: "line-oriented output, no full-screen TUI" },
  { name: "--no-color", kind: "boolean", summary: "disable colour" },
  {
    name: "--resume",
    kind: "optional-value",
    summary: "resume a session, defaulting to the last",
  },
  { name: "--read-only", kind: "boolean", summary: "refuse every mutation" },
  { name: "--workspace", kind: "value", summary: "operate on another directory" },
  { name: "--verbose", kind: "boolean", summary: "show runtime diagnostics" },
];

/** Flags only `capy run` adds on top of the common set. */
export const RUN_FLAGS: readonly FlagSpec[] = [
  { name: "--jsonl", kind: "boolean", summary: "emit versioned JSONL events on stdout" },
  { name: "--stdin", kind: "boolean", summary: "read the prompt from stdin" },
  { name: "--output", kind: "value", summary: "write the final answer to a file" },
  {
    name: "--on-approval",
    kind: "value",
    summary: "deny, allow-listed, fail",
    values: ["deny", "allow-listed", "fail"],
  },
];

const NAME_OPERAND: readonly PositionalSpec[] = [
  { label: "<name>", required: true },
];

/** §8.1's command tree, as data. */
export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  {
    name: "run",
    summary: "run headlessly, for scripts and CI",
    flags: [...COMMON_FLAGS, ...RUN_FLAGS],
    positionals: [{ label: "[prompt...]", required: false, variadic: true }],
  },
  {
    name: "auth",
    summary: "manage credentials",
    subcommands: [
      {
        name: "login",
        summary: "sign in through the configured OAuth registration",
        flags: [{ name: "--device", kind: "boolean", summary: "user-code flow for headless hosts" }],
      },
      {
        name: "api",
        summary: "store an OpenAI Platform API key (masked prompt or --stdin)",
        flags: [{ name: "--stdin", kind: "boolean", summary: "read the key from stdin" }],
        // §8.4: the key must never be a positional. The builder emits the
        // shell-history refusal instead of the generic surplus-argument error.
        operandPolicy: "deferred",
      },
      { name: "status", summary: "show the active credential" },
      {
        name: "logout",
        summary: "drop stored credentials",
        flags: [{ name: "--all", kind: "boolean", summary: "drop every stored credential" }],
      },
    ],
  },
  {
    name: "model",
    summary: "inspect and select models",
    defaultSubcommand: "list",
    subcommands: [
      {
        name: "list",
        summary: "list models",
        flags: [{ name: "--available", kind: "boolean", summary: "only models reachable right now" }],
      },
      {
        name: "use",
        summary: "select a model id or profile:<name>",
        positionals: [{ label: "<target>", required: true }],
      },
      { name: "profiles", summary: "list model profiles" },
      { name: "refresh", summary: "refresh capability manifest from remote" },
    ],
  },
  {
    name: "session",
    summary: "inspect stored sessions",
    defaultSubcommand: "list",
    subcommands: [
      { name: "list", summary: "list sessions" },
      {
        name: "resume",
        summary: "resume a session",
        positionals: [{ label: "[id]", required: false }],
      },
      { name: "fork", summary: "fork a session", positionals: [{ label: "<id>", required: true }] },
      {
        name: "export",
        summary: "export a session journal",
        positionals: [{ label: "<id>", required: true }],
        flags: [
          {
            name: "--format",
            kind: "value",
            summary: "markdown, jsonl, or bundle",
            values: ["markdown", "jsonl", "bundle"],
          },
          { name: "--output", kind: "value", summary: "write to a file instead of stdout" },
        ],
      },
      { name: "delete", summary: "delete a session", positionals: [{ label: "<id>", required: true }] },
    ],
  },
  {
    name: "skills",
    summary: "inspect Skills",
    aliases: ["skill"],
    defaultSubcommand: "list",
    subcommands: [
      { name: "list", summary: "list discovered Skills" },
      {
        name: "inspect",
        summary: "show one Skill's definition",
        positionals: NAME_OPERAND,
      },
      {
        name: "validate",
        summary: "validate a SKILL.md file",
        positionals: [{ label: "<path>", required: true }],
      },
    ],
  },
  {
    name: "mcp",
    summary: "manage MCP servers",
    defaultSubcommand: "list",
    subcommands: [
      {
        name: "list",
        summary: "list configured servers",
        flags: [{ name: "--verbose", kind: "boolean", summary: "include definitions" }],
      },
      {
        name: "add",
        summary: "add a server",
        positionals: NAME_OPERAND,
        flags: [
          { name: "--stdio", kind: "value", summary: "stdio command line" },
          { name: "--url", kind: "value", summary: "HTTP(S) endpoint" },
        ],
      },
      { name: "remove", summary: "remove a server", positionals: NAME_OPERAND },
      { name: "enable", summary: "enable a server", positionals: NAME_OPERAND },
      { name: "disable", summary: "disable a server", positionals: NAME_OPERAND },
      { name: "login", summary: "sign in to a server", positionals: NAME_OPERAND },
      { name: "logout", summary: "sign out of a server", positionals: NAME_OPERAND },
      {
        name: "doctor",
        summary: "diagnose one server, or all of them",
        positionals: [{ label: "[name]", required: false }],
      },
    ],
  },
  {
    name: "init",
    summary: "create AGENTS.md in this workspace",
    flags: [{ name: "--force", kind: "boolean", summary: "overwrite an existing file" }],
  },
  {
    name: "config",
    summary: "read and write configuration",
    defaultSubcommand: "get",
    subcommands: [
      {
        name: "get",
        summary: "print one key, or the whole effective config",
        positionals: [{ label: "[path]", required: false }],
      },
      {
        name: "set",
        summary: "set a key in user config",
        positionals: [
          { label: "<path>", required: true },
          { label: "<value>", required: true },
        ],
      },
      { name: "path", summary: "print the user config file path" },
      { name: "paths", summary: "print every resolved location" },
      {
        name: "validate",
        summary: "check the effective config",
        flags: [
          {
            name: "--explain",
            kind: "boolean",
            summary: "show each key's status and effective consumer",
          },
        ],
      },
      {
        name: "init",
        summary: "create a config file",
        flags: [

          { name: "--full", kind: "boolean", summary: "write every default key" },
          { name: "--force", kind: "boolean", summary: "overwrite an existing file" },
        ],
      },
      { name: "sources", summary: "show config and instruction source layers" },
    ],
  },
  {
    name: "trust",
    summary: "project trust",
    defaultSubcommand: "status",
    subcommands: [
      { name: "status", summary: "show this workspace's trust state" },
      {
        name: "add",
        summary: "trust a directory",
        positionals: [{ label: "[path]", required: false }],
      },
      {
        name: "remove",
        summary: "revoke trust for a directory",
        positionals: [{ label: "[path]", required: false }],
      },
    ],
  },
  {
    name: "doctor",
    summary: "diagnose the installation",
    flags: [
      { name: "--bundle", kind: "boolean", summary: "write a debug bundle" },
      { name: "--storage", kind: "boolean", summary: "include storage detail" },
    ],
  },
  {
    name: "update",
    summary: "update Capybara Code",
    flags: [{ name: "--check", kind: "boolean", summary: "check only, do not install" }],
  },
  {
    name: "completion",
    summary: "emit a shell completion script",
    positionals: [{ label: "<shell>", required: false }],
    flags: [{ name: "--shell", kind: "value", summary: "bash, zsh, fish, powershell" }],
  },
  {
    name: "permission",
    aliases: ["permissions"],
    summary: "inspect and set permission preset",
    defaultSubcommand: "status",
    subcommands: [
      { name: "status", summary: "show effective permission preset" },
      {
        name: "set",
        summary: "set permission preset (read|edit|auto|yolo)",
        positionals: [{ label: "<preset>", required: true }],
        flags: [{ name: "--yes", kind: "boolean", summary: "confirm yolo without prompt" }],
      },
      { name: "reset", summary: "reset to product default" },
      {
        name: "explain",
        summary: "explain a preset",
        positionals: [{ label: "[preset]", required: false }],
      },
    ],
  },
  { name: "version", summary: "print the version" },
  {
    name: "help",
    summary: "show help",
    positionals: [{ label: "[topic]", required: false }],
  },
];

/** Look up a top-level command by name or alias. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMAND_REGISTRY.find(
    (spec) => spec.name === name || spec.aliases?.includes(name) === true,
  );
}

/** Every flag a command path accepts: globals plus command and subcommand flags. */
export function flagsFor(spec: CommandSpec | undefined, sub: CommandSpec | undefined): FlagSpec[] {
  return [...GLOBAL_FLAGS, ...(spec?.flags ?? []), ...(sub?.flags ?? [])];
}

/** The accepted `command -> subcommands` map, aliases included. */
export function commandTree(): Record<string, readonly string[]> {
  const tree: Record<string, readonly string[]> = {};
  for (const spec of COMMAND_REGISTRY) {
    const subs = (spec.subcommands ?? []).map((sub) => sub.name);
    tree[spec.name] = subs;
    for (const alias of spec.aliases ?? []) tree[alias] = subs;
  }
  return tree;
}

/** All top-level spellings, aliases included, in registry order. */
export function commandNames(): string[] {
  const names: string[] = [];
  for (const spec of COMMAND_REGISTRY) {
    names.push(spec.name);
    for (const alias of spec.aliases ?? []) names.push(alias);
  }
  return names;
}
