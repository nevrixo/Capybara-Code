/**
 * `capy completion <shell>` — PRD §8.1, P1-03.
 *
 * The command tree is generated from the single declarative registry in
 * `command-spec.ts` — the same data that drives the parser and the help text —
 * so a subcommand or flag added there reaches every shell's script without a
 * second edit. A hand-written script per shell would drift from §8.1 the first
 * time a subcommand changed.
 */

import {
  commandNames,
  commandTree,
  COMMAND_REGISTRY,
  GLOBAL_FLAGS,
  findCommand,
} from "../command-spec.ts";
import { usageError } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

/** §8.1's tree, flattened to `command -> subcommands`, aliases included. */
const TREE: Readonly<Record<string, readonly string[]>> = commandTree();

/** Every top-level spelling, aliases included. */
const COMMANDS: readonly string[] = commandNames();

/** The flags a given command accepts — globals plus its own and its subcommands'. */
function flagsForCommand(command: string): string[] {
  const spec = findCommand(command);
  if (spec === undefined) return GLOBAL_FLAGS.map((flag) => flag.name);
  const subFlags = (spec.subcommands ?? []).flatMap((sub) => sub.flags ?? []);
  const names = new Set<string>([
    ...GLOBAL_FLAGS.map((flag) => flag.name),
    ...(spec.flags ?? []).map((flag) => flag.name),
    ...subFlags.map((flag) => flag.name),
  ]);
  return [...names];
}

/** Flags offered when no command-specific set applies. */
const FALLBACK_FLAGS: readonly string[] = GLOBAL_FLAGS.map((flag) => flag.name);

export interface CompletionArgs {
  readonly shell: string;
}

export async function completion(
  context: CommandContext,
  args: CompletionArgs,
): Promise<CommandResult> {
  const shell = args.shell.toLowerCase();
  switch (shell) {
    case "bash":
      context.out(bashScript());
      return ok();
    case "zsh":
      context.out(zshScript());
      return ok();
    case "fish":
      context.out(fishScript());
      return ok();
    case "powershell":
    case "pwsh":
      context.out(powershellScript());
      return ok();
    default:
      throw usageError(`no completion script for '${args.shell}'`, [
        "Supported: bash, zsh, fish, powershell",
      ]);
  }
}

function bashScript(): string {
  const cases = Object.entries(TREE)
    .filter(([command, subs]) => subs.length > 0 && command === findCommand(command)?.name)
    .map(([command, subs]) => `      ${command}) words="${subs.join(" ")}" ;;`)
    .join("\n");

  const flagCases = COMMAND_REGISTRY.filter((spec) => (spec.flags?.length ?? 0) > 0 || (spec.subcommands ?? []).some((sub) => (sub.flags?.length ?? 0) > 0))
    .map((spec) => `      ${spec.name}) flags="${flagsForCommand(spec.name).join(" ")}" ;;`)
    .join("\n");

  return `# capy bash completion. Add to ~/.bashrc:
#   eval "$(capy completion bash)"
_capy_complete() {
  local cur prev words flags
  cur="\${COMP_WORDS[COMP_CWORD]}"

  if [[ \$COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "${COMMANDS.join(" ")}" -- "\$cur") )
    return
  fi

  case "\${COMP_WORDS[1]}" in
${flagCases}
      *) flags="${FALLBACK_FLAGS.join(" ")}" ;;
  esac

  if [[ "\$cur" == -* ]]; then
    COMPREPLY=( \$(compgen -W "\$flags" -- "\$cur") )
    return
  fi

  case "\${COMP_WORDS[1]}" in
${cases}
      *) words="" ;;
  esac
  COMPREPLY=( \$(compgen -W "\$words" -- "\$cur") )
}
complete -F _capy_complete capy`;
}

function zshScript(): string {
  const cases = Object.entries(TREE)
    .filter(([command, subs]) => subs.length > 0 && command === findCommand(command)?.name)
    .map(([command, subs]) => `        ${command}) _values 'subcommand' ${subs.join(" ")} ;;`)
    .join("\n");

  const flagCases = COMMAND_REGISTRY.filter((spec) => flagsForCommand(spec.name).length > GLOBAL_FLAGS.length)
    .map((spec) => `        ${spec.name}) _values 'flag' ${flagsForCommand(spec.name).join(" ")} ; return ;;`)
    .join("\n");

  return `#compdef capy
# capy zsh completion. Add to ~/.zshrc:
#   eval "$(capy completion zsh)"
_capy() {
  local -a commands
  commands=(${COMMANDS.join(" ")})

  if (( CURRENT == 2 )); then
    _values 'command' \${commands[@]}
    return
  fi

  case "\${words[2]}" in
${flagCases}
  esac

  case "\${words[2]}" in
${cases}
  esac

  _values 'flag' ${FALLBACK_FLAGS.join(" ")}
}
_capy "$@"`;
}

function fishScript(): string {
  const lines: string[] = [
    "# capy fish completion. Save to ~/.config/fish/completions/cbc.fish",
    "complete -c capy -f",
  ];
  for (const command of COMMANDS) {
    lines.push(
      `complete -c capy -n "__fish_use_subcommand" -a "${command}"`,
    );
  }
  for (const [command, subs] of Object.entries(TREE)) {
    for (const sub of subs) {
      lines.push(`complete -c capy -n "__fish_seen_subcommand_from ${command}" -a "${sub}"`);
    }
  }
  // Command-specific flags first, so a flag that only one command takes is not
  // offered everywhere.
  for (const spec of COMMAND_REGISTRY) {
    const own = flagsForCommand(spec.name).filter(
      (flag) => !FALLBACK_FLAGS.includes(flag),
    );
    for (const flag of own) {
      lines.push(
        `complete -c capy -n "__fish_seen_subcommand_from ${spec.name}" -l "${flag.replace(/^--/, "")}"`,
      );
    }
  }
  for (const flag of FALLBACK_FLAGS) {
    lines.push(`complete -c capy -l "${flag.replace(/^--/, "")}"`);
  }
  return lines.join("\n");
}

function powershellScript(): string {
  const subMap = Object.entries(TREE)
    .filter(([command, subs]) => subs.length > 0 && command === findCommand(command)?.name)
    .map(([command, subs]) => `    '${command}' = @(${subs.map((sub) => `'${sub}'`).join(", ")})`)
    .join("\n");

  const flagMap = COMMAND_REGISTRY.filter((spec) => flagsForCommand(spec.name).length > GLOBAL_FLAGS.length)
    .map((spec) => `    '${spec.name}' = @(${flagsForCommand(spec.name).map((flag) => `'${flag}'`).join(", ")})`)
    .join("\n");

  return `# capy PowerShell completion. Add to $PROFILE:
#   capy completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName capy -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @(${COMMANDS.map((command) => `'${command}'`).join(", ")})
  $globalFlags = @(${FALLBACK_FLAGS.map((flag) => `'${flag}'`).join(", ")})
  $commandFlags = @{
${flagMap}
  }
  $subcommands = @{
${subMap}
  }

  $tokens = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
  $first = if ($tokens.Count -ge 1) { $tokens[0] } else { '' }

  if ($wordToComplete.StartsWith('-')) {
    $flags = $globalFlags
    if ($commandFlags.ContainsKey($first)) { $flags = $commandFlags[$first] }
    $flags | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
    }
    return
  }

  if ($tokens.Count -le 1) {
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    return
  }

  if ($subcommands.ContainsKey($first)) {
    $subcommands[$first] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}`;
}

export { TREE as COMMAND_TREE, COMMANDS, FALLBACK_FLAGS };
