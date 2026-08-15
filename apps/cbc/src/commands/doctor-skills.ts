/**
 * The Skills summary line for `capy doctor` — PRD §23.3, §16.2.
 *
 * Kept separate from `doctor.ts` so the doctor does not import the whole Skill
 * discovery path just to print one line, and so a failure while scanning Skills
 * degrades that single check instead of the whole diagnosis.
 */

import { SkillRegistry, builtinSkillFiles } from "@cbc/skills";

import { discoverSkillFiles, skillRoots } from "./skills.ts";
import type { CommandContext } from "./context.ts";

export interface SkillsSummary {
  readonly registered: number;
  readonly rejected: number;
  readonly shadowed: number;
}

export async function skillsSummary(context: CommandContext): Promise<SkillsSummary> {
  const trust = await context.trust();
  const trusted = trust === "trusted-always" || trust === "trusted-once";
  const registry = new SkillRegistry({
    productVersion: context.version,
    workspaceTrusted: trusted,
  });

  const discovered = await discoverSkillFiles(
    context.host,
    skillRoots(context.host, context.workspacePath, context.paths.share),
    { workspaceTrusted: trusted },
  );
  const result = registry.register([...builtinSkillFiles(), ...discovered]);

  return {
    registered: result.registered.length,
    // An issue list can hold several entries for one file; the count that matters
    // to a user is how many Skills failed to register.
    rejected: new Set(result.issues.map((issue) => issue.path)).size,
    shadowed: result.shadowed.length,
  };
}
