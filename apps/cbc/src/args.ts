/**
 * Argument parsing — PRD §8.1, §8.2, §8.3, §8.4, P1-03.
 *
 * §8.1's command tree, parsed into a discriminated union so the router's dispatch is
 * exhaustive by construction.
 *
 * P1-03: the tree itself lives once, in `command-spec.ts`. This module validates
 * argv against that registry — unknown flags, missing values, flags a command does
 * not take, and surplus positionals are usage errors — and `HELP_TEXT` is rendered
 * from the same registry, so the parser and the help cannot describe different CLIs.
 *
 * One rule shapes the flag handling: §8.4 states that a credential is never accepted
 * as a positional argument, because that would put it in shell history. `auth api`
 * therefore has no value slot at all — the key arrives on a masked prompt or stdin.
 */

import {
  COMMAND_REGISTRY,
  COMMON_FLAGS,
  GLOBAL_FLAGS,
  RUN_FLAGS,
  findCommand,
  type CommandSpec,
  type FlagSpec,
} from "./command-spec.ts";
import { EXIT, usageError, type CliError } from "./exit.ts";

export type PermissionModeArg = "build" | "plan" | "ask" | "auto" | "auto-review" | "read" | "edit" | "yolo";
export type PermissionPresetArg = "read" | "edit" | "auto" | "yolo";

export type HeadlessPolicyArg = "deny-on-ask" | "allow-listed" | "fail-on-ask" | "deny" | "fail";

/** Flags shared by the interactive and headless entry points. */
export interface CommonFlags {
  readonly model?: string;
  readonly reasoning?: string;
  readonly reasoningMode?: string;
  readonly mode?: PermissionModeArg;
  readonly interactionMode?: "build" | "plan";
  readonly permission?: PermissionPresetArg;
  readonly review?: "off" | "auto";
  /** §8.2 `--plan` is shorthand for `--mode plan`. */
  readonly plan?: boolean;
  readonly plain?: boolean;
  readonly noColor?: boolean;
  readonly resume?: string;
  readonly readOnly?: boolean;
  readonly workspace?: string;
  readonly verbose?: boolean;
}

export type Command =
  | { readonly kind: "interactive"; readonly prompt?: string; readonly flags: CommonFlags }
  | {
      readonly kind: "run";
      readonly prompt?: string;
      readonly flags: CommonFlags;
      readonly jsonl: boolean;
      readonly stdin: boolean;
      readonly output?: string;
      readonly permission?: HeadlessPolicyArg;
    }
  | { readonly kind: "permission"; readonly sub: "status" }
  | { readonly kind: "permission"; readonly sub: "set"; readonly preset: string; readonly yes: boolean }
  | { readonly kind: "permission"; readonly sub: "reset" }
  | { readonly kind: "permission"; readonly sub: "explain"; readonly preset?: string }
  | { readonly kind: "auth"; readonly sub: "login"; readonly device: boolean }
  | { readonly kind: "auth"; readonly sub: "api"; readonly fromStdin: boolean }
  | { readonly kind: "auth"; readonly sub: "status" }
  | { readonly kind: "auth"; readonly sub: "logout"; readonly all: boolean }
  | { readonly kind: "model"; readonly sub: "list"; readonly available: boolean }
  | { readonly kind: "model"; readonly sub: "use"; readonly target: string }
  | { readonly kind: "model"; readonly sub: "profiles" }
  | { readonly kind: "model"; readonly sub: "refresh" }
  | { readonly kind: "session"; readonly sub: "list" }
  | { readonly kind: "session"; readonly sub: "resume"; readonly id: string }
  | { readonly kind: "session"; readonly sub: "fork"; readonly id: string }
  | {
      readonly kind: "session";
      readonly sub: "export";
      readonly id: string;
      readonly format: "markdown" | "jsonl" | "bundle";
      readonly output?: string;
    }
  | { readonly kind: "session"; readonly sub: "delete"; readonly id: string }
  | { readonly kind: "skills"; readonly sub: "list" }
  | { readonly kind: "skills"; readonly sub: "inspect"; readonly name: string }
  | { readonly kind: "skills"; readonly sub: "validate"; readonly path: string }
  | { readonly kind: "mcp"; readonly sub: "list"; readonly verbose: boolean }
  | {
      readonly kind: "mcp";
      readonly sub: "add";
      readonly name: string;
      readonly stdio?: string;
      readonly url?: string;
    }
  | { readonly kind: "mcp"; readonly sub: "remove"; readonly name: string }
  | { readonly kind: "mcp"; readonly sub: "enable"; readonly name: string }
  | { readonly kind: "mcp"; readonly sub: "disable"; readonly name: string }
  | { readonly kind: "mcp"; readonly sub: "login"; readonly name: string }
  | { readonly kind: "mcp"; readonly sub: "logout"; readonly name: string }
  | { readonly kind: "mcp"; readonly sub: "doctor"; readonly name?: string }
  | { readonly kind: "lsp"; readonly sub: "list" }
  | { readonly kind: "lsp"; readonly sub: "enable"; readonly name: string }
  | { readonly kind: "lsp"; readonly sub: "disable"; readonly name: string }
  | { readonly kind: "lsp"; readonly sub: "doctor"; readonly name?: string }
  | { readonly kind: "config"; readonly sub: "get"; readonly path?: string }
  | { readonly kind: "config"; readonly sub: "set"; readonly path: string; readonly value: string }
  | { readonly kind: "config"; readonly sub: "path" }
  | { readonly kind: "config"; readonly sub: "paths" }
  | { readonly kind: "config"; readonly sub: "validate"; readonly explain: boolean }
  | { readonly kind: "config"; readonly sub: "init"; readonly full: boolean; readonly force: boolean }
  | { readonly kind: "config"; readonly sub: "sources" }
  | { readonly kind: "init"; readonly force: boolean }
  | { readonly kind: "trust"; readonly sub: "status" }
  | { readonly kind: "trust"; readonly sub: "add"; readonly path: string }
  | { readonly kind: "trust"; readonly sub: "remove"; readonly path: string }
  | { readonly kind: "doctor"; readonly bundle: boolean; readonly storage: boolean }
  | { readonly kind: "update"; readonly check: boolean }
  | { readonly kind: "completion"; readonly shell: string }
  | { readonly kind: "version" }
  | { readonly kind: "help"; readonly topic?: string };

export interface ParseResult {
  readonly command: Command;
  /** Non-fatal notes, e.g. a deprecated spelling that was accepted. */
  readonly warnings: string[];
}

interface FlagToken {
  readonly name: string;
  readonly spec: FlagSpec;
  readonly value: string | boolean;
}

interface Tokens {
  readonly positionals: string[];
  /** Raw flag spellings in argv order, before validation against the registry. */
  readonly rawFlags: { readonly name: string; readonly value: string | boolean }[];
}

/**
 * Every value-taking flag in the registry, across all commands. Tokenizing
 * happens before the command is known, so a flag's value is consumed whenever
 * *any* command would take one for that spelling; per-command validation then
 * rejects a flag where it does not belong.
 */
const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(
  [
    ...GLOBAL_FLAGS,
    ...COMMON_FLAGS,
    ...RUN_FLAGS,
    ...COMMAND_REGISTRY.flatMap((spec) => [
      ...(spec.flags ?? []),
      ...(spec.subcommands ?? []).flatMap((sub) => sub.flags ?? []),
    ]),
  ]
    .filter((flag) => flag.kind !== "boolean")
    .map((flag) => flag.name),
);

/**
 * Split argv into positionals and raw flags.
 *
 * `--` ends flag parsing, so `capy -- --not-a-flag` sends the literal text as a
 * prompt. A prompt that happens to start with a dash is a real case, and there has
 * to be a way to express it.
 */
function tokenize(argv: readonly string[]): Tokens {
  const positionals: string[] = [];
  const rawFlags: { name: string; value: string | boolean }[] = [];
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
          // Recorded as `true`: an optional-value flag reads that as its default,
          // a required-value flag fails validation with "needs a value".
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

/** Resolve a raw spelling (long or short) against the allowed flag set. */
function resolveFlag(name: string, allowed: readonly FlagSpec[]): FlagSpec | undefined {
  return allowed.find((spec) => spec.name === name || spec.short === name);
}

/**
 * Validate every flag against the registry and bind values.
 *
 * Unknown flags, flags the command does not take, missing values, values on
 * boolean flags, and values outside a stated set are all usage errors (P1-03).
 */
function validateFlags(
  rawFlags: Tokens["rawFlags"],
  allowed: readonly FlagSpec[],
  contextLabel: string,
): Map<string, FlagToken> {
  const flags = new Map<string, FlagToken>();

  for (let i = 0; i < rawFlags.length; i += 1) {
    const raw = rawFlags[i] as { name: string; value: string | boolean };
    const spec = resolveFlag(raw.name, allowed);
    if (spec === undefined) {
      const near = nearestFlagHint(raw.name, allowed);
      throw usageError(`unknown flag ${raw.name} for ${contextLabel}`, [
        ...(near !== undefined ? [`Did you mean ${near}?`] : []),
        `Run \`capy help\` for the full flag list.`,
      ]);
    }

    if (spec.kind === "boolean") {
      if (typeof raw.value === "string") {
        throw usageError(`${spec.name} takes no value`, [
          `Use it bare: \`${spec.name}\``,
        ]);
      }
      flags.set(spec.name, { name: spec.name, spec, value: true });
      continue;
    }

    if (typeof raw.value === "string") {
      const legacyHeadlessPermission = spec.name === "--permission" && contextLabel === "capy run" && ["deny-on-ask", "allow-listed", "fail-on-ask", "deny", "fail"].includes(raw.value);
      const legacyPermissionMode = spec.name === "--mode" && (contextLabel === "capy" || contextLabel === "capy run") && ["read", "edit", "auto", "yolo", "ask", "auto-review"].includes(raw.value);
      if (!legacyHeadlessPermission && !legacyPermissionMode) checkEnum(spec, raw.value);
      flags.set(spec.name, { name: spec.name, spec, value: raw.value });
      continue;
    }

    if (spec.kind === "optional-value") {
      // A bare optional-value flag means "the default": `--resume` resumes the
      // last session. The sentinel keeps the two spellings distinguishable.
      flags.set(spec.name, { name: spec.name, spec, value: true });
      continue;
    }

    // `--flag value`: the next positional-looking token is the value.
    throw usageError(`${spec.name} needs a value`, [
      spec.summary !== "" ? `Expected: \`${spec.name} <value>\` — ${spec.summary}` : "",
    ].filter((line) => line.length > 0));
  }

  return flags;
}

function checkEnum(spec: FlagSpec, value: string): void {
  if (spec.values === undefined) return;
  if (spec.values.includes(value)) return;
  throw usageError(`${spec.name} must be one of ${spec.values.join(", ")}`, [
    `'${value}' is not one of the accepted values`,
  ]);
}

/** Suggest the closest allowed flag for a typo, when one is plausible. */
function nearestFlagHint(name: string, allowed: readonly FlagSpec[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const spec of allowed) {
    const distance = editDistance(name, spec.name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = spec.name;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const rows = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) rows[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0] as number;
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous + (a[i - 1] === b[j - 1] ? 0 : 1);
      const current = rows[j] as number;
      rows[j] = Math.min(substitution, current + 1, (rows[j - 1] as number) + 1);
      previous = current;
    }
  }
  return rows[b.length] as number;
}

function flagString(flags: Map<string, FlagToken>, name: string): string | undefined {
  const value = flags.get(name)?.value;
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Map<string, FlagToken>, name: string): boolean {
  return flags.has(name);
}

function commonFlags(flags: Map<string, FlagToken>, warnings: string[]): CommonFlags {
  const modeRaw = flagString(flags, "--mode");
  const interactionRaw = flagString(flags, "--interaction-mode");
  const permissionRaw = flagString(flags, "--permission");
  const reviewRaw = flagString(flags, "--review");
  let mode: PermissionModeArg | undefined;
  let review: "off" | "auto" | undefined =
    reviewRaw === "off" || reviewRaw === "auto" ? reviewRaw : undefined;
  let permission: PermissionPresetArg | undefined =
    permissionRaw === "read" || permissionRaw === "edit" || permissionRaw === "auto" || permissionRaw === "yolo"
      ? permissionRaw
      : undefined;
  if (modeRaw !== undefined) {
    if (["read", "edit", "auto", "yolo"].includes(modeRaw)) {
      // Compatibility only: permission presets used to be accepted by --mode.
      permission = modeRaw as PermissionPresetArg;
      warnings.push(`--mode ${modeRaw} is deprecated; use --permission ${modeRaw}`);
    } else if (modeRaw === "auto-review") {
      if (permission === undefined) permission = "auto";
      if (review === undefined) review = "auto";
      warnings.push("--mode auto-review is deprecated; use --permission auto --review auto");
    } else {
      mode = modeRaw as PermissionModeArg;
      if (mode === "ask") warnings.push("--mode ask is deprecated; use the default CUSTOM/ASK policy");
    }
  }
  const plan = flagBool(flags, "--plan");
  const yolo = flagBool(flags, "--yolo");
  if (yolo && modeRaw !== undefined && modeRaw !== "build" && modeRaw !== "plan") {
    warnings.push(`--yolo and --mode ${modeRaw} conflict; --yolo wins`);
  }
  if (yolo) {
    // --yolo is a permission alias, never a permissionMode value.
    permission = "yolo";
  }
  if (plan && ((mode !== undefined && mode !== "plan") || (modeRaw !== undefined && modeRaw !== "plan"))) {
    // Rather than silently picking one, say which won.
    warnings.push(`--plan and --mode ${modeRaw ?? mode} conflict; --plan wins`);
  }

  return {
    ...(flagString(flags, "--model") !== undefined ? { model: flagString(flags, "--model") as string } : {}),
    ...(flagString(flags, "--reasoning") !== undefined
      ? { reasoning: flagString(flags, "--reasoning") as string }
      : {}),
    ...(flagString(flags, "--reasoning-mode") !== undefined
      ? { reasoningMode: flagString(flags, "--reasoning-mode") as string }
      : {}),
    ...(plan ? { plan: true, mode: "plan" as const } : mode !== undefined ? { mode } : {}),
    ...(interactionRaw !== undefined ? { interactionMode: interactionRaw as "build" | "plan" } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(flagBool(flags, "--plain") ? { plain: true } : {}),
    ...(flagBool(flags, "--no-color") ? { noColor: true } : {}),
    ...(flagString(flags, "--resume") !== undefined
      ? { resume: flagString(flags, "--resume") as string }
      : flagBool(flags, "--resume")
        ? { resume: "last" }
        : {}),
    ...(flagBool(flags, "--read-only") ? { readOnly: true } : {}),
    ...(flagString(flags, "--workspace") !== undefined
      ? { workspace: flagString(flags, "--workspace") as string }
      : {}),
    ...(flagBool(flags, "--verbose") ? { verbose: true } : {}),
  };
}

/** Bind and count-check the positionals a (sub)command declares. */
function bindPositionals(
  operands: readonly string[],
  spec: CommandSpec | undefined,
  contextLabel: string,
): readonly string[] {
  const declared = spec?.positionals ?? [];
  const variadic = declared.some((positional) => positional.variadic === true);
  const fixedCount = declared.filter((positional) => positional.variadic !== true).length;

  if (!variadic && operands.length > fixedCount) {
    const extra = operands.slice(fixedCount);
    throw usageError(
      `${contextLabel} takes ${fixedCount === 0 ? "no arguments" : `at most ${fixedCount} argument(s)`}`,
      [`Unexpected: ${extra.map((operand) => `'${operand}'`).join(", ")}`],
    );
  }
  return operands;
}

/** Parse argv (without the executable and script names). */
export function parseArgs(argv: readonly string[]): ParseResult {
  const warnings: string[] = [];
  const tokens = tokenize(argv);

  // Global flags are checked first so `--help` and `--version` win wherever they
  // appear, but an unknown flag anywhere is still an error: validating against
  // the global set alone would let typos through to become prompt text.
  const helpOrVersion = tokens.rawFlags.find(
    (raw) => raw.name === "--help" || raw.name === "-h" || raw.name === "--version" || raw.name === "-v",
  );

  const [first, ...rest] = tokens.positionals;
  const spec = first === undefined ? undefined : findCommand(first);

  if (helpOrVersion !== undefined) {
    if (helpOrVersion.name === "--version" || helpOrVersion.name === "-v") {
      return { command: { kind: "version" }, warnings };
    }
    return {
      command: { kind: "help", ...(first !== undefined ? { topic: first } : {}) },
      warnings,
    };
  }

  // The interactive entry point: no command word means everything is a prompt.
  if (spec === undefined) {
    const flags = validateFlags(tokens.rawFlags, [...GLOBAL_FLAGS, ...COMMON_FLAGS], "capy");
    const prompt = tokens.positionals.join(" ").trim();
    return {
      command: {
        kind: "interactive",
        ...(prompt.length > 0 ? { prompt } : {}),
        flags: commonFlags(flags, warnings),
      },
      warnings,
    };
  }

  const contextLabel = `capy ${spec.name}`;

  // Commands with subcommands resolve the second positional against them.
  if (spec.subcommands !== undefined && spec.subcommands.length > 0) {
    const subName = rest[0];
    const sub =
      subName === undefined
        ? spec.defaultSubcommand !== undefined
          ? spec.subcommands.find((candidate) => candidate.name === spec.defaultSubcommand)
          : undefined
        : spec.subcommands.find((candidate) => candidate.name === subName);

    if (sub === undefined) {
      const available = spec.subcommands.map((candidate) => candidate.name).join(", ");
      throw usageError(`${contextLabel} needs a subcommand`, [`Available: ${available}`]);
    }

    const operands = rest.slice(subName === undefined ? 0 : 1);
    const flags = validateFlags(
      tokens.rawFlags,
      [...GLOBAL_FLAGS, ...(spec.flags ?? []), ...(sub.flags ?? [])],
      `${contextLabel} ${sub.name}`,
    );
    if (sub.operandPolicy !== "deferred") {
      bindPositionals(operands, sub, `${contextLabel} ${sub.name}`);
    }
    return {
      command: buildSubcommand(spec.name, sub.name, operands, flags, warnings),
      warnings,
    };
  }

  // Leaf commands: run, doctor, update, completion, init.
  const flags = validateFlags(tokens.rawFlags, [...GLOBAL_FLAGS, ...(spec.flags ?? [])], contextLabel);
  const operands = rest;
  bindPositionals(operands, spec, contextLabel);
  if (spec.name === "init") {
    return { command: buildInit(spec.name, operands, flags), warnings };
  }
  return { command: buildLeafCommand(spec.name, operands, flags, warnings), warnings };
}

/** Build a Command from a resolved subcommand and its validated inputs. */
function buildSubcommand(
  commandName: string,
  subName: string,
  operands: readonly string[],
  flags: Map<string, FlagToken>,
  warnings: string[],
): Command {
  switch (commandName) {
    case "permission":
      return buildPermission(subName, operands, flags);
    case "auth":
      return buildAuth(subName, operands, flags);
    case "model":
      return buildModel(subName, operands, flags);
    case "session":
      return buildSession(subName, operands, flags);
    case "skills":
      return buildSkills(subName, operands);
    case "mcp":
      return buildMcp(subName, operands, flags);
    case "lsp":
      return buildLsp(subName, operands);
    case "config":
      return buildConfig(subName, operands, flags);
    case "trust":
      return buildTrust(subName, operands);
    default:
      throw usageError(`capy ${commandName} has no subcommands`);
  }
}

function buildPermission(sub: string, operands: readonly string[], flags: Map<string, FlagToken>): Command {
  switch (sub) {
    case "status":
      return { kind: "permission", sub: "status" };
    case "set": {
      const preset = operands[0];
      if (preset === undefined) throw usageError("capy permission set needs a preset (read|edit|auto|yolo)");
      return { kind: "permission", sub: "set", preset, yes: flagBool(flags, "--yes") };
    }
    case "reset":
      return { kind: "permission", sub: "reset" };
    case "explain":
      return { kind: "permission", sub: "explain", ...(operands[0] !== undefined ? { preset: operands[0] } : {}) };
    default:
      throw usageError("capy permission needs a subcommand", ["Available: status, set, reset, explain"]);
  }
}

function buildLeafCommand(
  commandName: string,
  operands: readonly string[],
  flags: Map<string, FlagToken>,
  warnings: string[],
): Command {
  switch (commandName) {
    case "run": {
      const prompt = operands.join(" ").trim();
      const onApproval = flagString(flags, "--on-approval");
      const rawPermission = flagString(flags, "--permission");
      let permission: HeadlessPolicyArg | undefined;
      if (onApproval !== undefined) {
        permission = onApproval as HeadlessPolicyArg;
      } else if (rawPermission !== undefined && !["read", "edit", "auto", "yolo"].includes(rawPermission)) {
        // One-release compatibility for the old overloaded spelling. Canonical
        // presets never enter the headless approval field.
        warnings.push("--permission approval spellings are deprecated; use --on-approval");
        const map: Record<string, HeadlessPolicyArg> = { "deny-on-ask": "deny", "fail-on-ask": "fail", "allow-listed": "allow-listed" };
        permission = map[rawPermission];
        if (permission === undefined) throw usageError(`unsupported legacy --permission value '${rawPermission}'`);
      }
      return {
        kind: "run",
        ...(prompt.length > 0 ? { prompt } : {}),
        flags: commonFlags(flags, warnings),
        jsonl: flagBool(flags, "--jsonl"),
        stdin: flagBool(flags, "--stdin"),
        ...(flagString(flags, "--output") !== undefined
          ? { output: flagString(flags, "--output") as string }
          : {}),
        ...(permission !== undefined ? { permission } : {}),
      };
    }
    case "doctor":
      return {
        kind: "doctor",
        bundle: flagBool(flags, "--bundle"),
        storage: flagBool(flags, "--storage"),
      };
    case "update":
      return { kind: "update", check: flagBool(flags, "--check") };
    case "completion":
      return {
        kind: "completion",
        shell: operands[0] ?? flagString(flags, "--shell") ?? "bash",
      };
    case "version":
      return { kind: "version" };
    case "help":
      return {
        kind: "help",
        ...(operands[0] !== undefined ? { topic: operands[0] } : {}),
      };
    default:
      throw usageError(`capy ${commandName} is not a runnable command`);
  }
}

function buildAuth(
  sub: string,
  operands: readonly string[],
  flags: Map<string, FlagToken>,
): Command {
  switch (sub) {
    case "login":
      return { kind: "auth", sub: "login", device: flagBool(flags, "--device") };
    case "api": {
      // §8.4: a key is never a positional argument.
      if (operands.length > 0) {
        throw usageError(
          "capy auth api does not accept the key as an argument",
          [
            "A key on the command line would be written to your shell history.",
            "Run `capy auth api` for a masked prompt, or pipe it with `capy auth api --stdin`.",
          ],
        );
      }
      return { kind: "auth", sub: "api", fromStdin: flagBool(flags, "--stdin") };
    }
    case "status":
      return { kind: "auth", sub: "status" };
    case "logout":
      return { kind: "auth", sub: "logout", all: flagBool(flags, "--all") };
    default:
      throw usageError("capy auth needs a subcommand", ["Available: login, api, status, logout"]);
  }
}

function buildModel(sub: string, operands: readonly string[], flags: Map<string, FlagToken>): Command {
  switch (sub) {
    case "list":
      return { kind: "model", sub: "list", available: flagBool(flags, "--available") };
    case "use": {
      const target = operands[0];
      if (target === undefined) {
        throw usageError("capy model use needs a model id or `profile:<name>`");
      }
      return { kind: "model", sub: "use", target };
    }
    case "profiles":
      return { kind: "model", sub: "profiles" };
    case "refresh":
      return { kind: "model", sub: "refresh" };
    default:
      throw usageError("capy model needs a subcommand", ["Available: list, use, profiles, refresh"]);
  }
}

function buildSession(sub: string, operands: readonly string[], flags: Map<string, FlagToken>): Command {
  const requireId = (subName: string): string => {
    const id = operands[0];
    if (id === undefined) throw usageError(`capy session ${subName} needs a session id`);
    return id;
  };

  switch (sub) {
    case "list":
      return { kind: "session", sub: "list" };
    case "resume":
      return { kind: "session", sub: "resume", id: operands[0] ?? "last" };
    case "fork":
      return { kind: "session", sub: "fork", id: requireId("fork") };
    case "export": {
      const formatRaw = flagString(flags, "--format") ?? "markdown";
      return {
        kind: "session",
        sub: "export",
        id: requireId("export"),
        format: formatRaw as "markdown" | "jsonl" | "bundle",
        ...(flagString(flags, "--output") !== undefined
          ? { output: flagString(flags, "--output") as string }
          : {}),
      };
    }
    case "delete":
      return { kind: "session", sub: "delete", id: requireId("delete") };
    default:
      throw usageError("capy session needs a subcommand", [
        "Available: list, resume, fork, export, delete",
      ]);
  }
}

function buildSkills(sub: string, operands: readonly string[]): Command {
  switch (sub) {
    case "list":
      return { kind: "skills", sub: "list" };
    case "inspect": {
      const name = operands[0];
      if (name === undefined) throw usageError("capy skills inspect needs a skill name");
      return { kind: "skills", sub: "inspect", name };
    }
    case "validate": {
      const path = operands[0];
      if (path === undefined) throw usageError("capy skills validate needs a path");
      return { kind: "skills", sub: "validate", path };
    }
    default:
      throw usageError("capy skills needs a subcommand", [
        "Available: list, inspect, validate",
      ]);
  }
}

function buildMcp(sub: string, operands: readonly string[], flags: Map<string, FlagToken>): Command {
  const requireName = (subName: string): string => {
    const name = operands[0];
    if (name === undefined) throw usageError(`capy mcp ${subName} needs a server name`);
    return name;
  };

  switch (sub) {
    case "list":
      return { kind: "mcp", sub: "list", verbose: flagBool(flags, "--verbose") };
    case "add": {
      const name = requireName("add");
      const stdio = flagString(flags, "--stdio");
      const url = flagString(flags, "--url");
      if (stdio === undefined && url === undefined) {
        throw usageError("capy mcp add needs either --stdio or --url");
      }
      if (stdio !== undefined && url !== undefined) {
        throw usageError("capy mcp add takes --stdio or --url, not both");
      }
      return {
        kind: "mcp",
        sub: "add",
        name,
        ...(stdio !== undefined ? { stdio } : {}),
        ...(url !== undefined ? { url } : {}),
      };
    }
    case "remove":
      return { kind: "mcp", sub: "remove", name: requireName("remove") };
    case "enable":
      return { kind: "mcp", sub: "enable", name: requireName("enable") };
    case "disable":
      return { kind: "mcp", sub: "disable", name: requireName("disable") };
    case "login":
      return { kind: "mcp", sub: "login", name: requireName("login") };
    case "logout":
      return { kind: "mcp", sub: "logout", name: requireName("logout") };
    case "doctor":
      return {
        kind: "mcp",
        sub: "doctor",
        ...(operands[0] !== undefined ? { name: operands[0] } : {}),
      };
    default:
      throw usageError("capy mcp needs a subcommand", [
        "Available: list, add, remove, enable, disable, login, logout, doctor",
      ]);
  }
}

function buildLsp(sub: string, operands: readonly string[]): Command {
  const requireName = (subName: string): string => {
    const name = operands[0];
    if (name === undefined) throw usageError(`capy lsp ${subName} needs a server name`);
    return name;
  };

  switch (sub) {
    case "list":
      return { kind: "lsp", sub: "list" };
    case "enable":
      return { kind: "lsp", sub: "enable", name: requireName("enable") };
    case "disable":
      return { kind: "lsp", sub: "disable", name: requireName("disable") };
    case "doctor":
      return {
        kind: "lsp",
        sub: "doctor",
        ...(operands[0] !== undefined ? { name: operands[0] } : {}),
      };
    default:
      throw usageError("capy lsp needs a subcommand", [
        "Available: list, enable, disable, doctor",
      ]);
  }
}

function buildConfig(sub: string, operands: readonly string[], flags: Map<string, FlagToken>): Command {
  switch (sub) {
    case "get":
      return {
        kind: "config",
        sub: "get",
        ...(operands[0] !== undefined ? { path: operands[0] } : {}),
      };
    case "set": {
      const path = operands[0];
      const value = operands[1];
      if (path === undefined || value === undefined) {
        throw usageError("capy config set needs a path and a value");
      }
      return { kind: "config", sub: "set", path, value };
    }
    case "path":
      return { kind: "config", sub: "path" };
    // §18.14 mentions `capy config paths` for showing every resolved location.
    case "paths":
      return { kind: "config", sub: "paths" };
    case "validate":
      return { kind: "config", sub: "validate", explain: flagBool(flags, "--explain") };
    case "init":
      return {
        kind: "config",
        sub: "init",
        full: flagBool(flags, "--full"),
        force: flagBool(flags, "--force"),
      };
    case "sources":
      return { kind: "config", sub: "sources" };
    default:
      throw usageError("capy config needs a subcommand", [
        "Available: get, set, path, paths, validate, init, sources",
      ]);
  }
}

function buildInit(_sub: string, _operands: readonly string[], flags: Map<string, FlagToken>): Command {
  return { kind: "init", force: flagBool(flags, "--force") };
}

function buildTrust(sub: string, operands: readonly string[]): Command {
  switch (sub) {
    case "status":
      return { kind: "trust", sub: "status" };
    case "add":
      return { kind: "trust", sub: "add", path: operands[0] ?? "." };
    case "remove":
      return { kind: "trust", sub: "remove", path: operands[0] ?? "." };
    default:
      throw usageError("capy trust needs a subcommand", ["Available: status, add, remove"]);
  }
}

/** §8.1's command tree, rendered for `capy --help` from the registry (P1-03). */
export const HELP_TEXT = renderHelp();

function renderHelp(): string {
  const commandEntries = COMMAND_REGISTRY.filter((spec) => spec.name !== "run").map((spec) => {
    const subs = (spec.subcommands ?? []).map((sub) => sub.name).join("|");
    const names = [spec.name, ...(spec.aliases ?? [])].join("|");
    const left = subs.length > 0 ? `${names} ${subs}` : names;
    return [left, spec.summary] as const;
  });
  const commandWidth = Math.max(...commandEntries.map(([left]) => left.length)) + 2;
  const commandLines = commandEntries.map(
    ([left, summary]) => `  ${left.padEnd(commandWidth)}${summary}`,
  );

  const flagLine = (flag: FlagSpec): string => {
    const arg = flag.kind === "boolean" ? "" : flag.kind === "value" ? " <value>" : " [value]";
    return `  ${(flag.name + arg).padEnd(30)}${flag.summary}`;
  };

  return [
    "Capybara Code — independent coding agent for GPT-5.6",
    "",
    "Usage",
    "  capy [prompt...]              open the interactive TUI, optionally sending a prompt",
    "  capy run [prompt...]          run headlessly, for scripts and CI",
    "",
    "Commands",
    ...commandLines,
    "",
    "Interactive flags",
    ...COMMON_FLAGS.map(flagLine),
    "",
    "Headless flags",
    ...RUN_FLAGS.map(flagLine),
    "",
    "Exit codes",
    "  0 success · 1 failure · 2 usage · 3 auth · 4 permission · 5 provider",
    "  6 tool · 7 cancelled · 8 partial · 9 config · 10 internal",
  ].join("\n");
}

export { EXIT };
export type { CliError };
