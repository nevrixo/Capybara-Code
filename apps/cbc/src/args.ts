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
  | {
      readonly kind: "run";
      readonly prompt?: string;
      readonly resultFile?: string;
      readonly eventFile?: string;
      readonly permissionPolicy?: "deny-on-ask" | "allow-listed" | "fail-on-ask";
      readonly noDaemon?: boolean;
    }
  | { readonly kind: "acp" }
  | { readonly kind: "clients"; readonly sub: "list" | "doctor" }
  | { readonly kind: "integration"; readonly sub: "doctor"; readonly target?: "vscode" | "acp" | "github" }
  | { readonly kind: "github"; readonly sub: "install" | "doctor" }
  | { readonly kind: "trust"; readonly showDiff: boolean }
  | {
      readonly kind: "bootstrap";
      readonly frozen: boolean;
      readonly offline: boolean;
      readonly scope: "project" | "user";
    }
  | { readonly kind: "package"; readonly sub: "search"; readonly query: string }
  | {
      readonly kind: "package";
      readonly sub: "info";
      readonly packageId: string;
      readonly scope: "project" | "user" | "effective";
    }
  | {
      readonly kind: "package";
      readonly sub: "add";
      readonly source: string;
      readonly scope: "project" | "user";
      readonly allowUnsignedLocal: boolean;
      readonly grantRequested: boolean;
      readonly offline: boolean;
    }
  | {
      readonly kind: "package";
      readonly sub: "verify";
      readonly source: string;
      readonly scope: "project" | "user";
      readonly allowUnsignedLocal: boolean;
      readonly offline: boolean;
    }
  | {
      readonly kind: "package";
      readonly sub: "remove";
      readonly packageId: string;
      readonly scope: "project" | "user";
    }
  | {
      readonly kind: "package";
      readonly sub: "update";
      readonly packageId?: string;
      readonly scope: "project" | "user";
      readonly offline: boolean;
    }
  | {
      readonly kind: "package";
      readonly sub: "list" | "doctor";
      readonly packageId?: string;
      readonly scope: "project" | "user" | "effective";
    }
  | {
      readonly kind: "package";
      readonly sub: "publish";
      readonly path: string;
      readonly dryRun: boolean;
    }
  | { readonly kind: "package"; readonly sub: "init"; readonly path: string }
  | { readonly kind: "plugin"; readonly sub: "list" }
  | {
      readonly kind: "plugin";
      readonly sub: "inspect" | "enable" | "disable" | "grants";
      readonly pluginId: string;
    }
  | { readonly kind: "auth"; readonly sub: "login"; readonly device: boolean }
  | { readonly kind: "auth"; readonly sub: "api"; readonly fromStdin: boolean }
  | { readonly kind: "auth"; readonly sub: "status" }
  | { readonly kind: "auth"; readonly sub: "logout"; readonly all: boolean }
  | { readonly kind: "model"; readonly sub: "refresh" }
  | { readonly kind: "config"; readonly sub: "set"; readonly path: string; readonly value: string }
  | { readonly kind: "skills"; readonly sub: "list" | "doctor"; readonly json: boolean }
  | { readonly kind: "skills"; readonly sub: "validate"; readonly path: string; readonly json: boolean; readonly strict: boolean }
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

/** Split argv into positional arguments and flag tokens. */
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

/** Validate raw flags against allowed specs and build a typed map. */
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

/** Validate positional arguments match the command spec requirements. */
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
      const eventFile = flags.get("--event-file")?.value;
      const permissionPolicy = flags.get("--permission-policy")?.value;
      if (
        permissionPolicy !== undefined
        && permissionPolicy !== "deny-on-ask"
        && permissionPolicy !== "allow-listed"
        && permissionPolicy !== "fail-on-ask"
      ) {
        throw usageError("--permission-policy must be deny-on-ask, allow-listed, or fail-on-ask");
      }
      return {
        command: {
          kind: "run",
          ...(prompt.length > 0 ? { prompt } : {}),
          ...(typeof resultFile === "string" && resultFile.trim().length > 0 ? { resultFile } : {}),
          ...(typeof eventFile === "string" && eventFile.trim().length > 0 ? { eventFile } : {}),
          ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
          ...(flags.has("--no-daemon") ? { noDaemon: true } : {}),
        },
      };
    }
    case "acp":
      return { command: { kind: "acp" } };
    case "trust":
      return { command: { kind: "trust", showDiff: flags.has("--show-diff") } };
    case "bootstrap":
      return {
        command: {
          kind: "bootstrap",
          frozen: flags.has("--frozen"),
          offline: flags.has("--offline"),
          scope: mutationScope(flags, "capy bootstrap"),
        },
      };
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

/** Build a typed Command object from parsed subcommand arguments. */
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
  if (commandName === "clients" && (subName === "list" || subName === "doctor")) {
    return { kind: "clients", sub: subName };
  }
  if (commandName === "integration" && subName === "doctor") {
    const target = operands[0];
    if (target !== undefined && target !== "vscode" && target !== "acp" && target !== "github") {
      throw usageError("capy integration doctor target must be vscode, acp, or github");
    }
    return {
      kind: "integration",
      sub: "doctor",
      ...(target === undefined ? {} : { target }),
    };
  }
  if (commandName === "github" && (subName === "install" || subName === "doctor")) {
    return { kind: "github", sub: subName };
  }
  if (commandName === "package") {
    switch (subName) {
      case "search":
        return { kind: "package", sub: "search", query: operands[0] as string };
      case "info":
        return {
          kind: "package",
          sub: "info",
          packageId: operands[0] as string,
          scope: listScope(flags, "capy package info"),
        };
      case "add":
        return {
          kind: "package",
          sub: "add",
          source: operands[0] as string,
          scope: mutationScope(flags, "capy package add"),
          allowUnsignedLocal: flags.has("--allow-unsigned-local"),
          grantRequested: flags.has("--grant-requested"),
          offline: flags.has("--offline"),
        };
      case "verify":
        return {
          kind: "package",
          sub: "verify",
          source: operands[0] as string,
          scope: mutationScope(flags, "capy package verify"),
          allowUnsignedLocal: flags.has("--allow-unsigned-local"),
          offline: flags.has("--offline"),
        };
      case "remove":
        return {
          kind: "package",
          sub: "remove",
          packageId: operands[0] as string,
          scope: mutationScope(flags, "capy package remove"),
        };
      case "update":
        return {
          kind: "package",
          sub: "update",
          ...(operands[0] === undefined ? {} : { packageId: operands[0] }),
          scope: mutationScope(flags, "capy package update"),
          offline: flags.has("--offline"),
        };
      case "list":
      case "doctor":
        return {
          kind: "package",
          sub: subName,
          ...(subName === "doctor" && operands[0] !== undefined
            ? { packageId: operands[0] }
            : {}),
          scope: listScope(flags, "capy package " + subName),
        };
      case "publish":
        return {
          kind: "package",
          sub: "publish",
          path: operands[0] ?? ".",
          dryRun: flags.has("--dry-run"),
        };
      case "init":
        return { kind: "package", sub: "init", path: operands[0] ?? "." };
    }
  }
  if (commandName === "plugin") {
    if (subName === "list") return { kind: "plugin", sub: "list" };
    if (
      subName === "inspect"
      || subName === "enable"
      || subName === "disable"
      || subName === "grants"
    ) {
      return {
        kind: "plugin",
        sub: subName,
        pluginId: operands[0] as string,
      };
    }
  }
  if (commandName === "config" && subName === "set") {
    return {
      kind: "config",
      sub: "set",
      path: operands[0] as string,
      value: operands[1] as string,
    };
  }
  if (commandName === "skills") {
    if (subName === "list" || subName === "doctor") {
      return { kind: "skills", sub: subName, json: flags.has("--json") };
    }
    if (subName === "validate") {
      return {
        kind: "skills",
        sub: "validate",
        path: operands[0] as string,
        json: flags.has("--json"),
        strict: flags.has("--strict"),
      };
    }
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

function mutationScope(
  flags: Map<string, FlagToken>,
  context: string,
): "project" | "user" {
  if (flags.has("--project") && flags.has("--user")) {
    throw usageError(context + " accepts only one of --project or --user");
  }
  return flags.has("--user") ? "user" : "project";
}

function listScope(
  flags: Map<string, FlagToken>,
  context: string,
): "project" | "user" | "effective" {
  const selected = ["--project", "--user", "--effective"].filter((flag) => flags.has(flag));
  if (selected.length > 1) {
    throw usageError(context + " accepts only one scope flag");
  }
  if (flags.has("--project")) return "project";
  if (flags.has("--user")) return "user";
  return "effective";
}

export const HELP_TEXT = [
  "Capybara Code - independent coding agent for GPT-5.6",
  "",
  "Usage",
  "  capy [prompt...]                 open the interactive TUI",
  "  capy run [prompt...]             run headlessly",
  "  capy acp                         serve ACP v1 over stdio",
  "  capy --no-daemon [prompt...]     keep execution inside this process",
  "",
  "Commands",
  "  clients list|doctor              inspect App Protocol clients",
  "  integration doctor [target]      diagnose vscode, acp, or github",
  "  github install|doctor            manage GitHub Action integration",
  "  trust [--show-diff]              inspect or approve project trust",
  "  bootstrap [--frozen] [--offline] reconstruct declared packages",
  "  package search|info|add|remove   discover and change packages",
  "  package update|list|doctor       maintain immutable package locks",
  "  package verify|publish|init      verify or author packages",
  "  plugin list|inspect              inspect plugin runtimes",
  "  plugin enable|disable|grants     control plugin state and authority",
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
  "  skills list [--json]             list discovered Skills",
  "  skills doctor [--json]           explain discovery and rejection details",
  "  skills validate <path>           validate one SKILL.md",
  "  update [--check]                 check for a newer release",
  "  version                          print the version",
  "  help [topic]                     show help",
].join("\n");
