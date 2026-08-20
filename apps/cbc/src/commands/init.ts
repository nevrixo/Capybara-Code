import { loadConfig } from "@cbc/config-schema";

import {
  GLOBAL_CONFIG_FULL_TEMPLATE,
  GLOBAL_CONFIG_TEMPLATE,
} from "../config-template.ts";
import { configError } from "../exit.ts";
import { join } from "../host.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

const AGENTS_TEMPLATE = `# AGENTS.md — Capybara Code workspace instructions

- Keep changes focused and reversible.
- Prefer existing patterns over new abstractions.
- Run \`bun run verify\` before proposing a merge.

## Build & Test

- Typecheck: \`bun run typecheck\`
- TypeScript tests: \`bun run test:ts\`
- Rust tests: \`cargo test --workspace\`
- Verify all: \`bun run verify\`

## Project Rules

- Do not store secrets in config files. Use environment variables or the keychain.
- Trust is required before project instructions or executable workspace integrations apply.
`;

async function atomicWrite(
  host: import("../host.ts").Host,
  targetPath: string,
  content: string,
): Promise<void> {
  await host.fs.atomicWrite(targetPath, content);
  const written = await host.fs.read(targetPath);
  if (written !== content) throw new Error(`failed to verify atomic write to ${targetPath}`);
}

export async function initCommand(
  context: CommandContext,
  args: { force: boolean },
): Promise<CommandResult> {
  const target = join(context.workspacePath, "AGENTS.md");
  context.out(`Target: ${target}`);
  const exists = await context.host.fs.exists(target);
  if (exists && !args.force) {
    throw configError(`AGENTS.md already exists at ${target}`, ["Use --force to overwrite."]);
  }
  await atomicWrite(context.host, target, AGENTS_TEMPLATE);
  const loaded = await context.host.fs.read(target);
  if (loaded === undefined || loaded.trim().length === 0) {
    throw configError(`failed to create ${target}`);
  }
  context.out(`Created ${target}`);
  context.out("Do not store secrets in AGENTS.md. Keep it focused on build, test, and project rules.");
  return ok();
}

export async function configInitCommand(
  context: CommandContext,
  args: { full: boolean; force: boolean },
): Promise<CommandResult> {
  const target = context.paths.configFile;
  const template = args.full ? GLOBAL_CONFIG_FULL_TEMPLATE : GLOBAL_CONFIG_TEMPLATE;

  context.out(`Target: ${target}`);
  const exists = await context.host.fs.exists(target);
  if (exists && !args.force) {
    throw configError(`config already exists at ${target}`, ["Use --force to overwrite."]);
  }

  await atomicWrite(context.host, target, template);
  const written = await context.host.fs.read(target);
  if (written === undefined) throw configError(`failed to create ${target}`);

  const probe = loadConfig({ userToml: written, env: {} });
  const errors = probe.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw configError(
      `generated config at ${target} failed validation`,
      errors.map((issue) => `${issue.path}: ${issue.message}`),
    );
  }

  context.out(`Created ${target}`);
  context.out("Validate with: capy config validate --explain");
  context.out("Do not store secrets in config files. Reference environment variables by name instead.");
  return ok();
}
