/** Parse the intentionally small public capy command surface. */

import {
  COMMAND_REGISTRY,
  GLOBAL_FLAGS,
  findCommand,
  type CommandSpec,
  type FlagSpec,
} from "./command-spec.ts";
import { usageError } from "./exit.ts";

export type Command =
  | { readonly kind: "interactive"; readonly prompt?: string; readonly noDaemon?: boolean }
  | { readonly kind: "run"; readonly prompt?: string; readonly resultFile?: string; readonly noDaemon?: boolean }
  | { readonly kind: "auth"; readonly sub: "login"; readonly device: boolean }
  | { readonly kind: "auth"; readonly sub: "api"; readonly fromStdin: boolean }
  | { readonly kind: "auth"; readonly sub: "status" }
  | { readonly kind: "auth"; readonly sub: "logout"; readonly all: boolean }
  | { readonly kind: "model"; readonly sub: "refresh" }
  | { readonly kind: "config"; readonly sub: "set"; readonly path: string; readonly value: string }
  | { readonly kind: "session-worker"; readonly sessionId?: string }
  | { readonly kind: "daemon"; readonly sub: "start" | "stop" | "status" | "logs" | "attach"; readonly sessionId?: string }
  | { readonly kind: "update"; readonly check?: boolean }
  | { readonly kind: "version" }
  | { readonly kind: "help"; readonly topic?: string };

export interface ParseResult {
  readonly command: Command;
}

interface FlagToken {
  readonly spec: FlagSpec;
  readonly value: string | boolean;
}

interface Tokens {
  readonly positionals: string[];
  readonly rawFlags: Array<{ readonly name: string; readonly value: string | boolean }>;
}

const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(
  [
    ...GLOBAL_FLAGS,
    ...COMMAND_REGISTRY.flatMap((spec) => [
      ...(spec.flags ?? []),
      ...(spec.subcommands ?? []).flatMap((sub) => sub.flags ?? []),
    ]),
  ]
    .filter((flag) => flag.kind === "value")
    .map((flag) => flag.name),
);

function tokenize(argv: readonly string[]): Tokens {
  const positionals: string[] = [];
  const rawFlags: Array<{ name: string; value: string | boolean }> = [];
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals !== -1) {
        rawFlags.push({ name: token.slice(0, equals), value: token.slice(equals + 1) });
        continue;
      }
      if (VALUE_FLAG_NAMES.has(token)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          rawFlags.push({ name: token, value: true });
          continue;
        }
        rawFlags.push({ name: token, value: next });
        i += 1;
        continue;
      }
      rawFlags.push({ name: token, value: true });
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      rawFlags.push({ name: token, value: true });
      continue;
    }
    positionals.push(token);
  }

  return { positionals, rawFlags };
}

function validateFlags(
  rawFlags: Tokens["rawFlags"],
  allowed: readonly FlagSpec[],
  contextLabel: string,
): Map<string, FlagToken> {
  const flags = new Map<string, FlagToken>();
  for (const raw of rawFlags) {
    const spec = allowed.find((candidate) => candidate.name === raw.name);
    if (spec === undefined) {
      throw usageError("unknown flag " + raw.name + " for " + contextLabel, [
        "Run capy help for the supported command list.",
      ]);
    }
    if (spec.kind === "boolean" && typeof raw.value === "string") {
      throw usageError(spec.name + " takes no value", ["Use it bare: " + spec.name]);
    }
    if (spec.kind === "value" && typeof raw.value !== "string") {
      throw usageError(spec.name + " needs a value");
    }
    flags.set(spec.name, { spec, value: raw.value });
  }
  return flags;
}

function validatePositionals(
  operands: readonly string[],
  spec: CommandSpec,
  contextLabel: string,
): void {
  const declared = spec.positionals ?? [];
  const variadic = declared.some((positional) => positional.variadic === true);
  const required = declared.filter((positional) => positional.required).length;
  const maximum = declared.filter((positional) => positional.variadic !== true).length;

  if (operands.length < required) {
    const usage = declared.map((positional) => positional.label).join(" ");
    throw usageError(contextLabel + " needs " + usage);
  }
  if (!variadic && operands.length > maximum) {
    throw usageError(contextLabel + " takes at most " + maximum + " argument(s)", [
      "Unexpected: " + operands.slice(maximum).map((operand) => "'" + operand + "'").join(", "),
    ]);
  }
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const tokens = tokenize(argv);
  const [first, ...rest] = tokens.positionals;
  const spec = first === undefined ? undefined : findCommand(first);

  if (spec === undefined) {
    const flags = validateFlags(tokens.rawFlags, GLOBAL_FLAGS, "capy");
    const prompt = tokens.positionals.join(" ").trim();
    return {
      command: {
        kind: "interactive",
        ...(prompt.length > 0 ? { prompt } : {}),
        ...(flags.has("--no-daemon") ? { noDaemon: true } : {}),
      },
    };
  }

  const contextLabel = "capy " + spec.name;
  if (spec.subcommands !== undefined) {
    const subName = rest[0];
    const sub = spec.subcommands.find((candidate) => candidate.name === subName);
    if (sub === undefined) {
      throw usageError(contextLabel + " needs a subcommand", [
        "Available: " + spec.subcommands.map((candidate) => candidate.name).join(", "),
      ]);
    }
    const operands = rest.slice(1);
    const flags = validateFlags(
      tokens.rawFlags,
      [...GLOBAL_FLAGS, ...(sub.flags ?? [])],
      contextLabel + " " + sub.name,
    );
    if (sub.operandPolicy !== "deferred") {
      validatePositionals(operands, sub, contextLabel + " " + sub.name);
    }
    return { command: buildSubcommand(spec.name, sub.name, operands, flags) };
  }

  const flags = validateFlags(tokens.rawFlags, [...GLOBAL_FLAGS, ...(spec.flags ?? [])], contextLabel);
  validatePositionals(rest, spec, contextLabel);
  switch (spec.name) {
    case "run": {
      const prompt = rest.join(" ").trim();
      const resultFile = flags.get("--result-file")?.value;
      return {
        command: {
          kind: "run",
          ...(prompt.length > 0 ? { prompt } : {}),
          ...(typeof resultFile === "string" && resultFile.trim().length > 0 ? { resultFile } : {}),
          ...(flags.has("--no-daemon") ? { noDaemon: true } : {}),
        },
      };
    }
    case "session-worker": {
      const sessionId = flags.get("--session-id")?.value;
      return {
        command: {
          kind: "session-worker",
          ...(typeof sessionId === "string" && sessionId.trim().length > 0 ? { sessionId } : {}),
        },
      };
    }
    case "update":
      return {
        command: {
          kind: "update",
          ...(flags.has("--check") ? { check: true } : {}),
        },
      };
    case "version":
      return { command: { kind: "version" } };
    case "help":
      return {
        command: { kind: "help", ...(rest[0] !== undefined ? { topic: rest[0] } : {}) },
      };
    default:
      throw usageError(contextLabel + " is not runnable");
  }
}

function buildSubcommand(
  commandName: string,
  subName: string,
  operands: readonly string[],
  flags: Map<string, FlagToken>,
): Command {
  if (commandName === "auth") {
    switch (subName) {
      case "login":
        return { kind: "auth", sub: "login", device: flags.has("--device") };
      case "api":
        if (operands.length > 0) {
          throw usageError("capy auth api does not accept the key as an argument", [
            "A key on the command line would be written to your shell history.",
            "Run capy auth api for a masked prompt, or pipe it with capy auth api --stdin.",
          ]);
        }
        return { kind: "auth", sub: "api", fromStdin: flags.has("--stdin") };
      case "status":
        return { kind: "auth", sub: "status" };
      case "logout":
        return { kind: "auth", sub: "logout", all: flags.has("--all") };
    }
  }
  if (commandName === "model" && subName === "refresh") {
    return { kind: "model", sub: "refresh" };
  }
  if (commandName === "config" && subName === "set") {
    return {
      kind: "config",
      sub: "set",
      path: operands[0] as string,
      value: operands[1] as string,
    };
  }
  if (commandName === "daemon") {
    switch (subName) {
      case "start":
      case "stop":
      case "status":
      case "logs":
        return { kind: "daemon", sub: subName };
      case "attach":
        return {
          kind: "daemon",
          sub: "attach",
          ...(operands[0] !== undefined ? { sessionId: operands[0] } : {}),
        };
    }
  }
  throw usageError("unsupported command: capy " + commandName + " " + subName);
}

export const HELP_TEXT = [
  "Capybara Code - independent coding agent for GPT-5.6",
  "",
  "Usage",
  "  capy [prompt...]                 open the interactive TUI",
  "  capy run [prompt...]             run headlessly",
  "  capy --no-daemon [prompt...]     keep execution inside this process",
  "",
  "Commands",
  "  daemon start                     start the local daemon",
  "  daemon stop                      stop the local daemon",
  "  daemon status                    show daemon health",
  "  daemon logs                      print recent daemon logs",
  "  daemon attach [id]               reconnect this client to daemon-owned work",
  "  auth login [--device]            sign in",
  "  auth api [--stdin]               store an API key",
  "  auth status                      show the active credential",
  "  auth logout [--all]              drop stored credentials",
  "  model refresh                    refresh model capabilities",
  "  config set <path> <value>        set a user configuration value",
  "  update [--check]                 check for a newer release",
  "  version                          print the version",
  "  help [topic]                     show help",
].join("\n");