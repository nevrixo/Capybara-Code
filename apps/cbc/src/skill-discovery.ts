/** Discover Skill metadata for session bootstrap. */

import {
  MAX_SKILL_CATALOG_BYTES,
  frontmatterOnly,
  type SkillFile,
  type SkillSource,
} from "@cbc/skills";

import { expandHome, join, type Host } from "./host.ts";
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
