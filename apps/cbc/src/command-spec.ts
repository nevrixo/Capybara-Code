/**
 * The public capy command registry.
 *
 * Keep this surface deliberately small. Interactive settings belong in /setting;
 * the CLI only exposes process entry points, authentication, capability refresh,
 * the low-level config setter, and help/version commands.
 */

export type FlagKind = "boolean" | "value";

export interface FlagSpec {
  readonly name: string;
  readonly kind: FlagKind;
  readonly summary: string;
}

export interface PositionalSpec {
  readonly label: string;
  readonly required: boolean;
  readonly variadic?: boolean;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly flags?: readonly FlagSpec[];
  readonly positionals?: readonly PositionalSpec[];
  readonly subcommands?: readonly CommandSpec[];
  /** Let a command provide a security-specific operand error. */
  readonly operandPolicy?: "strict" | "deferred";
}

/** No flag aliases are global; use capy help and capy version. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "--no-daemon", kind: "boolean", summary: "run the session inside this process instead of attaching to the local daemon" },
];

export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  {
    name: "run",
    summary: "run headlessly",
    flags: [
      { name: "--result-file", kind: "value", summary: "write a machine-readable integration result" },
      { name: "--event-file", kind: "value", summary: "read a validated integration trigger envelope" },
      { name: "--permission-policy", kind: "value", summary: "deny-on-ask, allow-listed, or fail-on-ask" },
    ],
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
        summary: "store an OpenAI Platform API key",
        flags: [{ name: "--stdin", kind: "boolean", summary: "read the key from stdin" }],
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
    summary: "refresh model capabilities",
    subcommands: [
      { name: "refresh", summary: "refresh capability manifest from remote" },
    ],
  },
  {
    name: "config",
    summary: "write configuration",
    subcommands: [
      {
        name: "set",
        summary: "set a key in user config",
        positionals: [
          { label: "<path>", required: true },
          { label: "<value>", required: true },
        ],
      },
    ],
  },
  {
    name: "acp",
    summary: "serve ACP v1 over stdio and attach it to the local daemon",
  },
  {
    name: "doctor",
    summary: "diagnose the active OpenAI backend, lanes, cache, and inert settings",
    subcommands: [
      { name: "openai", summary: "report each OpenAI feature and why a disabled one is off" },
    ],
  },
  {
    name: "clients",
    summary: "inspect App Protocol clients and transport health",
    subcommands: [
      { name: "list", summary: "show the current client and inventory support" },
      { name: "doctor", summary: "diagnose client roles, replay, and transport" },
    ],
  },
  {
    name: "integration",
    summary: "diagnose first-party integration compatibility",
    subcommands: [
      {
        name: "doctor",
        summary: "diagnose VS Code, ACP, or GitHub integration",
        positionals: [{ label: "[vscode|acp|github]", required: false }],
      },
    ],
  },
  {
    name: "github",
    summary: "install or diagnose GitHub automation",
    subcommands: [
      { name: "install", summary: "create a safe default GitHub Actions workflow" },
      { name: "doctor", summary: "validate the repository GitHub workflow" },
    ],
  },
  {
    name: "trust",
    summary: "inspect or approve the workspace project-control digest",
    flags: [
      { name: "--show-diff", kind: "boolean", summary: "print digest and capability changes without prompting" },
    ],
  },
  {
    name: "bootstrap",
    summary: "reconstruct the declared package environment",
    flags: [
      { name: "--frozen", kind: "boolean", summary: "require packages.json and lockfile to match exactly" },
      { name: "--offline", kind: "boolean", summary: "use only local sources and the immutable cache" },
      { name: "--project", kind: "boolean", summary: "bootstrap project packages (default)" },
      { name: "--user", kind: "boolean", summary: "bootstrap user packages" },
    ],
  },
  {
    name: "package",
    summary: "manage signed packages and reproducible locks",
    subcommands: [
      {
        name: "search",
        summary: "search the configured signed registry",
        positionals: [{ label: "<query>", required: true }],
      },
      {
        name: "info",
        summary: "inspect an installed package",
        flags: packageListFlags(),
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "add",
        summary: "resolve, verify, lock, and activate a package",
        flags: [
          ...packageMutationFlags(),
          { name: "--allow-unsigned-local", kind: "boolean", summary: "explicitly allow an unsigned path: development package" },
          { name: "--grant-requested", kind: "boolean", summary: "explicitly grant the package's requested authority" },
          { name: "--offline", kind: "boolean", summary: "forbid registry network access" },
        ],
        positionals: [{ label: "<source>", required: true }],
      },
      {
        name: "remove",
        summary: "remove a package and deactivate its plugins",
        flags: packageMutationFlags(),
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "update",
        summary: "update one or all packages without widening grants",
        flags: [
          ...packageMutationFlags(),
          { name: "--offline", kind: "boolean", summary: "forbid registry network access" },
        ],
        positionals: [{ label: "[id]", required: false }],
      },
      {
        name: "verify",
        summary: "verify package integrity without activation",
        flags: [
          ...packageMutationFlags(),
          { name: "--allow-unsigned-local", kind: "boolean", summary: "explicitly allow an unsigned path: development package" },
          { name: "--offline", kind: "boolean", summary: "forbid registry network access" },
        ],
        positionals: [{ label: "<source>", required: true }],
      },
      {
        name: "list",
        summary: "list installed packages",
        flags: packageListFlags(),
      },
      {
        name: "doctor",
        summary: "verify lockfile and immutable cache consistency",
        flags: packageListFlags(),
        positionals: [{ label: "[id]", required: false }],
      },
      {
        name: "publish",
        summary: "validate a package for publication",
        flags: [{ name: "--dry-run", kind: "boolean", summary: "validate only; perform no external write" }],
        positionals: [{ label: "[path]", required: false }],
      },
      {
        name: "init",
        summary: "create a minimal Skill package",
        positionals: [{ label: "[path]", required: false }],
      },
    ],
  },
  {
    name: "plugin",
    summary: "inspect and control installed plugin runtimes",
    subcommands: [
      { name: "list", summary: "list active plugins" },
      {
        name: "inspect",
        summary: "inspect source, runtime, health, and authority",
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "enable",
        summary: "enable an installed plugin",
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "disable",
        summary: "disable an installed plugin",
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "grants",
        summary: "show requested and effective plugin grants",
        positionals: [{ label: "<id>", required: true }],
      },
    ],
  },
  {
    name: "skills",
    summary: "inspect and validate Agent Skills discovery",
    subcommands: [
      {
        name: "list",
        summary: "list active Skills",
        flags: [{ name: "--json", kind: "boolean", summary: "write metadata as JSON" }],
      },
      {
        name: "doctor",
        summary: "show discovery roots and rejection reasons",
        flags: [{ name: "--json", kind: "boolean", summary: "write diagnostics as JSON" }],
      },
      {
        name: "validate",
        summary: "validate one SKILL.md",
        flags: [
          { name: "--json", kind: "boolean", summary: "write validation as JSON" },
          { name: "--strict", kind: "boolean", summary: "treat compatibility warnings as failures" },
        ],
        positionals: [{ label: "<path>", required: true }],
      },
    ],
  },
  {
    name: "learn",
    summary: "review and decide evidence-backed strategy capsules",
    subcommands: [
      { name: "review", summary: "audit proposed, active, and contested capsules" },
      {
        name: "accept",
        summary: "approve one capsule proposal",
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "reject",
        summary: "decline one capsule proposal",
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "forget",
        summary: "retire an active capsule, retaining its audit history",
        positionals: [{ label: "<id>", required: true }],
      },
      {
        name: "rollback",
        summary: "restore a capsule to its previous revision",
        positionals: [{ label: "<id>", required: true }],
      },
    ],
  },
  {
    name: "session-worker",
    summary: "internal: own a session as a daemon child process",
    flags: [
      { name: "--session-id", kind: "value", summary: "session to resume or create" },
    ],
  },
  {
    name: "daemon",
    summary: "manage the local session daemon",
    subcommands: [
      { name: "start", summary: "start the local daemon if it is not already running" },
      { name: "stop", summary: "stop the local daemon" },
      { name: "status", summary: "print daemon health and ownership" },
      { name: "logs", summary: "print recent daemon diagnostic lines" },
      {
        name: "attach",
        summary: "attach this client to existing daemon-owned work",
        positionals: [{ label: "[id]", required: false }],
      },
    ],
  },
  {
    name: "update",
    summary: "check for a newer release",
    flags: [
      { name: "--check", kind: "boolean", summary: "report through the exit code only; install nothing" },
    ],
  },
  { name: "version", summary: "print the version" },
  {
    name: "help",
    summary: "show help",
    positionals: [{ label: "[topic]", required: false }],
  },
];

function packageMutationFlags(): readonly FlagSpec[] {
  return [
    { name: "--project", kind: "boolean", summary: "use project scope (default)" },
    { name: "--user", kind: "boolean", summary: "use user scope" },
  ];
}

function packageListFlags(): readonly FlagSpec[] {
  return [
    ...packageMutationFlags(),
    { name: "--effective", kind: "boolean", summary: "show effective merged state (default)" },
  ];
}

/** Find a command spec by name in the registry. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMAND_REGISTRY.find((spec) => spec.name === name);
}

/** Retained for generated consumers while the command tree stays declarative. */
export function commandTree(): Record<string, readonly string[]> {
  return Object.fromEntries(
    COMMAND_REGISTRY.map((spec) => [spec.name, (spec.subcommands ?? []).map((sub) => sub.name)]),
  );
}

/** Return the list of public command names, excluding internal commands. */
export function commandNames(): string[] {
  // The daemon's session-worker entry point is an internal spawn target, not a
  // public command. Keep it in the parser registry without advertising it.
  return COMMAND_REGISTRY
    .filter((spec) => spec.name !== "session-worker")
    .map((spec) => spec.name);
}
