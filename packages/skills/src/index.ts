/**
 * `@cbc/skills` — Agent Skills: `SKILL.md` parsing, discovery, progressive
 * disclosure, trust, and the bundled Skills (PRD §16).
 *
 * §16.1 draws the boundary: a Skill is reusable instructions, references, and
 * templates — not an executable plugin. Nothing in this package runs anything, and
 * §16.6 keeps a Skill's declared tool list a *request* the host may narrow but
 * never a grant.
 */

export * from "./frontmatter.ts";
export * from "./skill.ts";
export * from "./registry.ts";
export * from "./builtin.ts";
