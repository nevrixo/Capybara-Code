/**
 * A narrow, host-supplied verification contract for non-interactive runners.
 *
 * The contract is deliberately optional: normal CLI sessions retain the existing
 * repository-aware planner. A runner such as Pier can set it to make the final
 * checks authoritative and stop a guessed package manager from changing a good
 * required result into an unrelated failure.
 */

import type { ProposedAction } from "@cbc/permissions";

export type VerificationCommandKind =
  | "required"
  | "diagnostic"
  | "off_contract"
  | "not_verification";

export interface VerificationContract {
  readonly source: "pier" | "repository" | "detected";
  readonly requiredCommands: readonly string[];
  readonly diagnosticCommands: readonly string[];
  readonly forbiddenPrograms: readonly string[];
  /** Allow a runner to explicitly prohibit guessed verification when no command is authoritative. */
  readonly enforceOnly: boolean;
}

const MAX_COMMANDS = 24;
const MAX_COMMAND_LENGTH = 1_024;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function commandList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const commands = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_COMMAND_LENGTH);
  return [...new Set(commands)].slice(0, MAX_COMMANDS);
}

function programList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z0-9._+-]{1,128}$/.test(entry)))]
    .slice(0, MAX_COMMANDS);
}

/** Parse untrusted runner input without allowing it to broaden a command surface. */
export function parseVerificationContract(value: unknown): VerificationContract | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const source = input.source;
  if (source !== "pier" && source !== "repository" && source !== "detected") return undefined;
  const requiredCommands = commandList(input.requiredCommands);
  const diagnosticCommands = commandList(input.diagnosticCommands);
  const enforceOnly = input.enforceOnly === true;
  if (requiredCommands.length === 0 && diagnosticCommands.length === 0 && !enforceOnly) return undefined;
  return {
    source,
    requiredCommands,
    diagnosticCommands,
    forbiddenPrograms: programList(input.forbiddenPrograms),
    enforceOnly,
  };
}

/** Read the integration-only environment payload. Invalid JSON simply disables it. */
export function verificationContractFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): VerificationContract | undefined {
  const raw = environment.CBC_VERIFICATION_CONTRACT;
  if (raw === undefined || raw.trim().length === 0 || raw.length > 32_768) return undefined;
  try {
    return parseVerificationContract(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Render the command form produced by the normalizer without trusting display text. */
export function commandForVerification(action: ProposedAction): string {
  if (action.command !== undefined) {
    return [action.command.program, ...action.command.args].join(" ").trim();
  }
  const argumentsRecord = action.arguments as Record<string, unknown>;
  const script = argumentsRecord.script ?? argumentsRecord.command;
  return typeof script === "string" ? script.trim() : action.display.trim();
}

export function canonicalVerificationCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function programFor(command: string): string | undefined {
  const first = canonicalVerificationCommand(command).split(" ", 1)[0];
  if (first === undefined || first.length === 0) return undefined;
  return first.replace(/^['"]|['"]$/g, "").toLowerCase();
}

/**
 * Keep this detection intentionally conservative. It only decides whether an
 * unknown command needs contract review; ordinary build, git, and inspection
 * commands remain available to the agent.
 */
export function looksLikeVerificationCommand(command: string): boolean {
  const normalized = ` ${canonicalVerificationCommand(command).toLowerCase()} `;
  return /(^|\s)(?:go\s+test|cargo\s+(?:test|check|clippy)|pytest\b|vitest\b|jest\b|mocha\b|ava\b|tsc\b|eslint\b|ruff\b)/.test(normalized)
    || /(^|\s)(?:npm|pnpm|bun|yarn)\s+(?:run\s+)?(?:test|type-?check|check|lint)(?:\s|$)/.test(normalized)
    || /(^|\s)(?:test|type-?check|lint|verify)(?:\s|$)/.test(normalized);
}

/** Classify a process or a verification.run_many string against the contract. */
export function classifyVerificationCommand(
  contract: VerificationContract | undefined,
  command: string,
): VerificationCommandKind {
  if (contract === undefined) return "not_verification";
  const canonical = canonicalVerificationCommand(command);
  if (canonical.length === 0) return "not_verification";
  if (contract.requiredCommands.some((entry) => canonicalVerificationCommand(entry) === canonical)) {
    return "required";
  }
  if (contract.diagnosticCommands.some((entry) => canonicalVerificationCommand(entry) === canonical)) {
    return "diagnostic";
  }
  const program = programFor(canonical);
  if ((program !== undefined && contract.forbiddenPrograms.includes(program)) || looksLikeVerificationCommand(canonical)) {
    return "off_contract";
  }
  return "not_verification";
}

export function classifyVerificationAction(
  contract: VerificationContract | undefined,
  action: ProposedAction,
): VerificationCommandKind {
  if (action.toolId !== "process.run" && action.toolId !== "shell.run") return "not_verification";
  return classifyVerificationCommand(contract, commandForVerification(action));
}
