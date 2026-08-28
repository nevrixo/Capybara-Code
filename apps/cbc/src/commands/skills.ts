/** Headless Skills discovery and validation commands. */

import { SkillRegistry, parseSkill, renderSkillDetail } from "@cbc/skills";

import type { Command } from "../args.ts";
import { EXIT } from "../exit.ts";
import { expandHome, join } from "../host.ts";
import {
  renderSkillDoctor,
  renderSkillSnapshotList,
  skillSnapshotJson,
} from "../skill-diagnostics.ts";
import { SkillDiscoveryService, type SkillDiscoveryInput } from "../skill-discovery.ts";
import type { CommandContext, CommandResult } from "./context.ts";

type SkillsCommand = Extract<Command, { readonly kind: "skills" }>;

export async function skillsCommand(
  context: CommandContext,
  command: SkillsCommand,
): Promise<CommandResult> {
  if (command.sub === "validate") return await validateSkill(context, command);

  const config = await context.requireConfig();
  const trust = await context.trust();
  const registry = new SkillRegistry({
    productVersion: context.version,
    workspaceTrusted: trust === "trusted-always" || trust === "trusted-once",
  });
  const service = new SkillDiscoveryService({
    host: context.host,
    replace: (files) => registry.replace(registry.prepare(files)),
  });
  const input: SkillDiscoveryInput = {
    cwd: context.host.cwd,
    workspacePath: context.workspacePath,
    nativeSkillsPath: context.paths.skills,
    config: config.skills,
  };
  const snapshot = await service.discover(input);
  if (command.json) {
    context.out(JSON.stringify(skillSnapshotJson(snapshot)));
  } else if (command.sub === "doctor") {
    context.outLines(renderSkillDoctor(snapshot));
  } else {
    context.outLines(renderSkillSnapshotList(snapshot));
  }
  return { code: EXIT.ok };
}

async function validateSkill(
  context: CommandContext,
  command: Extract<SkillsCommand, { readonly sub: "validate" }>,
): Promise<CommandResult> {
  const expanded = expandHome(command.path, context.host.homeDir);
  const path = isAbsolutePath(expanded) ? normalizePath(expanded) : join(context.workspacePath, expanded);
  const content = await context.host.fs.read(path);
  const parsed = content === undefined
    ? {
        issues: [{
          field: "file",
          message: "file does not exist or is unreadable",
          severity: "error" as const,
        }],
      }
    : parseSkill(content, {
        path,
        canonicalPath: normalizePath((await context.host.fs.realpath?.(path)) ?? path),
        source: "user",
        scope: "user",
        origin: "explicit",
      });
  const blocking = parsed.issues.filter((issue) =>
    issue.severity !== "warning" || command.strict,
  );
  const ok = parsed.definition !== undefined && blocking.length === 0;

  if (command.json) {
    context.out(JSON.stringify({
      ok,
      strict: command.strict,
      path,
      manifest: parsed.definition === undefined ? null : {
        ...parsed.definition.manifest,
        source: parsed.definition.source,
        scope: parsed.definition.scope,
        origin: parsed.definition.origin,
        canonicalPath: parsed.definition.canonicalPath,
      },
      issues: parsed.issues,
    }));
  } else {
    context.untrusted(`${ok ? "Valid" : "Invalid"} Skill: ${path}`);
    if (parsed.definition !== undefined) {
      for (const line of renderSkillDetail(parsed.definition)) context.untrusted(line);
    }
    for (const issue of parsed.issues) {
      context.untrusted(`${issue.severity === "warning" ? "warning" : "error"}: ${issue.field}${issue.line !== undefined ? `:${issue.line}` : ""}: ${issue.message}`);
    }
  }
  return { code: ok ? EXIT.ok : EXIT.failure };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:[/\\]/.test(path);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
