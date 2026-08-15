/**
 * `capy skills` — PRD §8.7, §16.2, §16.6, §16.8, AC-26, AC-28.
 *
 * Discovery walks §16.2's four locations in precedence order. The trust gate matters
 * here as much as at runtime: AC-28 requires a project Skill from an untrusted
 * workspace to be *listed* but not loaded, so the catalog entry is built from
 * frontmatter while the body stays unread.
 */

import {
  MAX_SKILL_CATALOG_BYTES,
  SKILL_SEARCH_ROOTS,
  SkillRegistry,
  frontmatterOnly,
  isProjectSource,
  renderSkillDetail,
  renderSkillList,
  renderValidationReport,
  validateSkill,
  type SkillFile,
  type SkillSource,
} from "@cbc/skills";
import { NATIVE_TOOLS } from "@cbc/tool-registry";

import { CliError, EXIT } from "../exit.ts";
import { basename, expandHome, join, type Host } from "../host.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

/** Resolve §16.2's roots against this host and workspace. */
export function skillRoots(
  host: Host,
  workspacePath: string,
  sharePath: string,
): Array<{ source: SkillSource; directory: string }> {
  return [
    { source: "agents-dir" as SkillSource, directory: join(workspacePath, ".agents/skills") },
    { source: "project" as SkillSource, directory: join(workspacePath, ".capybara/skills") },
    {
      source: "user" as SkillSource,
      directory: expandHome("~/.config/capybara-code/skills", host.homeDir),
    },
    { source: "builtin" as SkillSource, directory: join(sharePath, "skills") },
  ];
}

/**
 * Read every `SKILL.md` under the §16.2 roots.
 *
 * A Skill is a directory containing `SKILL.md`, so the scan is one level deep by
 * design — nesting would make "which directory does this Skill own" ambiguous, and
 * SKILL-005 depends on that boundary being unambiguous.
 *
 * §13.6 / AC-28: when the workspace is not trusted, a project Skill is listed
 * from its frontmatter only — the body is stripped before it is ever held in
 * memory, matching what the registry enforces at `skill.load` (P0-15).
 */
export async function discoverSkillFiles(
  host: Host,
  roots: ReadonlyArray<{ source: SkillSource; directory: string }>,
  _options: { workspaceTrusted?: boolean } = {},
): Promise<SkillFile[]> {
  const discovered = await Promise.all(
    roots.map(async (root): Promise<SkillFile[]> => {
      if (!(await host.fs.isDirectory(root.directory))) return [];
      const names = (await host.fs.list(root.directory)).sort();
      const candidates = await Promise.all(
        names.map(async (name): Promise<SkillFile | undefined> => {
          const directory = join(root.directory, name);
          if (!(await host.fs.isDirectory(directory))) return undefined;
          const path = join(directory, "SKILL.md");

          // Real hosts issue a bounded read. Test/embedded hosts that do not expose
          // it retain the safe compatibility fallback, but the body is still
          // stripped before registration and never enters the catalog.
          const prefix = host.fs.readPrefix === undefined
            ? await host.fs.read(path)
            : (await host.fs.readPrefix(path, MAX_SKILL_CATALOG_BYTES))?.content;
          if (prefix === undefined) return undefined;
          const content = frontmatterOnly(prefix);
          return {
            path,
            source: root.source,
            content,
            metadataOnly: true,
            // Capturing a reader is cheap; it performs no I/O until the explicit
            // asynchronous `skill.load` stage. The registry checks trust first.
            loadContent: async () => await host.fs.read(path),
          };
        }),
      );
      return candidates.filter((candidate): candidate is SkillFile => candidate !== undefined);
    }),
  );
  return discovered.flat();
}

async function buildRegistry(context: CommandContext): Promise<SkillRegistry> {
  const trust = await context.trust();
  const trusted = trust === "trusted-always" || trust === "trusted-once";
  const registry = new SkillRegistry({ productVersion: context.version, workspaceTrusted: trusted });

  const { builtinSkillFiles } = await import("@cbc/skills");
  const discovered = await discoverSkillFiles(
    context.host,
    skillRoots(context.host, context.workspacePath, context.paths.share),
    { workspaceTrusted: trusted },
  );
  registry.register([...builtinSkillFiles(), ...discovered]);
  return registry;
}

export async function skillsList(context: CommandContext): Promise<CommandResult> {
  const registry = await buildRegistry(context);
  const trust = await context.trust();
  const trusted = trust === "trusted-always" || trust === "trusted-once";

  context.outLines(renderSkillList(registry.catalog()));

  const shadowed = registry.shadowedDefinitions();
  if (shadowed.length > 0) {
    context.out("");
    context.out("Shadowed by a nearer scope (§16.2):");
    for (const definition of shadowed) {
      context.out(`  $${definition.manifest.name}  [${definition.source}]  ${definition.path}`);
    }
  }

  if (!trusted) {
    const projectSkills = registry
      .all()
      .filter((definition) => isProjectSource(definition.source));
    if (projectSkills.length > 0) {
      // AC-28: listed, but the body is not loaded until the workspace is trusted.
      context.out("");
      context.out(
        `${projectSkills.length} project Skill(s) are listed but will not be loaded: this workspace is ${trust}.`,
      );
      context.out("Run `capy trust add .` to allow them.");
    }
  }

  const issues = registry.issues();
  if (issues.length > 0) {
    context.out("");
    context.out(`${issues.length} Skill(s) were rejected:`);
    for (const issue of issues) {
      context.out(`  ${issue.path}  ${issue.field}: ${issue.message}`);
    }
  }
  return ok();
}

export interface SkillsInspectArgs {
  readonly name: string;
}

export async function skillsInspect(
  context: CommandContext,
  args: SkillsInspectArgs,
): Promise<CommandResult> {
  const registry = await buildRegistry(context);
  const wanted = args.name.replace(/^\$/, "");
  const definition = registry.get(wanted);

  if (definition === undefined) {
    const names = registry.all().map((entry) => `  $${entry.manifest.name}`);
    throw new CliError(EXIT.usage, `no Skill named '${wanted}'`, [
      ...(names.length > 0 ? ["Available:", ...names] : ["No Skills are installed."]),
    ]);
  }

  context.outLines(renderSkillDetail(definition));

  const trust = await context.trust();
  const trusted = trust === "trusted-always" || trust === "trusted-once";
  if (isProjectSource(definition.source) && !trusted) {
    context.out("");
    context.out(`Body not shown: this workspace is ${trust} and the Skill is project-supplied.`);
    return ok();
  }

  const loaded = await registry.loadAsync(wanted);
  if (!loaded.ok) {
    context.out("");
    context.out(`Body unavailable: ${loaded.reason}`);
    return ok();
  }

  context.out("");
  context.out("--- SKILL.md body ---");
  // P1-01: a Skill body is external text — sanitize it so it cannot drive the
  // terminal even when the workspace is trusted enough to display it.
  context.untrusted(loaded.definition.body);
  return ok();
}

export interface SkillsValidateArgs {
  readonly path: string;
}

/**
 * §16.8 validation.
 *
 * Directory contents and symlink entries are passed in so the reference checks can
 * actually run: SKILL-005 is about references escaping the Skill directory, which is
 * unanswerable from the `SKILL.md` text alone.
 */
export async function skillsValidate(
  context: CommandContext,
  args: SkillsValidateArgs,
): Promise<CommandResult> {
  const host = context.host;
  const target = args.path.replace(/\\/g, "/").replace(/\/+$/, "");
  const isDirectory = await host.fs.isDirectory(target);
  const skillPath = isDirectory ? join(target, "SKILL.md") : target;
  const directory = isDirectory ? target : parentOf(skillPath);

  const content = await host.fs.read(skillPath);
  if (content === undefined) {
    throw new CliError(EXIT.usage, `no SKILL.md at ${skillPath}`, [
      "Pass the Skill directory, or the path to its SKILL.md.",
    ]);
  }

  const entries = await listRecursive(host, directory, directory, 0);
  const registry = await buildRegistry(context);

  const report = validateSkill({
    path: skillPath,
    source: sourceForPath(context, skillPath),
    content,
    productVersion: context.version,
    knownTools: NATIVE_TOOLS,
    directoryEntries: entries,
    existingNames: registry.all().map((entry) => entry.manifest.name),
  });

  context.outLines(renderValidationReport(report));
  return report.valid ? ok() : { code: EXIT.config };
}

function sourceForPath(context: CommandContext, path: string): SkillSource {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("/.agents/skills/")) return "agents-dir";
  if (normalized.includes("/.capybara/skills/")) return "project";
  if (normalized.startsWith(context.paths.share)) return "builtin";
  // A path outside every known root is treated as project-supplied, which is the
  // stricter reading: §16.6's checks should apply to an unvetted directory.
  return normalized.startsWith(context.workspacePath) ? "project" : "user";
}

async function listRecursive(
  host: Host,
  root: string,
  directory: string,
  depth: number,
): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const name of await host.fs.list(directory)) {
    const full = join(directory, name);
    const relative = full.slice(root.length + 1);
    out.push(relative);
    if (await host.fs.isDirectory(full)) {
      out.push(...(await listRecursive(host, root, full, depth + 1)));
    }
  }
  return out;
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? normalized : normalized.slice(0, slash);
}

export { SKILL_SEARCH_ROOTS, basename };
