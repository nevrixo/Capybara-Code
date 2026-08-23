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
export const GLOBAL_FLAGS: readonly FlagSpec[] = [];

export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  {
    name: "run",
    summary: "run headlessly",
    flags: [{ name: "--result-file", kind: "value", summary: "write a machine-readable integration result" }],
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
  { name: "version", summary: "print the version" },
  {
    name: "help",
    summary: "show help",
    positionals: [{ label: "[topic]", required: false }],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMAND_REGISTRY.find((spec) => spec.name === name);
}

/** Retained for generated consumers while the command tree stays declarative. */
export function commandTree(): Record<string, readonly string[]> {
  return Object.fromEntries(
    COMMAND_REGISTRY.map((spec) => [spec.name, (spec.subcommands ?? []).map((sub) => sub.name)]),
  );
}

export function commandNames(): string[] {
  return COMMAND_REGISTRY.map((spec) => spec.name);
}