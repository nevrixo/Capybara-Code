/** Human and JSON renderers for Skills Discovery v2 snapshots. */

import { renderSkillDetail, type SkillDefinition, type SkillRegistry } from "@cbc/skills";

import type { SkillDiscoverySnapshot } from "./skill-discovery.ts";

export const SKILL_DISCOVERY_STARTUP_NOTICE =
  "Found Skill files but none were loadable. Run `/skills doctor`.";

/** Warn only when external candidates existed and every active entry is bundled. */
export function skillDiscoveryStartupNotice(snapshot: SkillDiscoverySnapshot): string | undefined {
  const onlyBuiltins = snapshot.accepted.every((definition) => definition.scope === "builtin");
  const rejectedExternalCandidate = snapshot.roots.some((root) => root.scope !== "builtin" && root.candidates > 0) &&
    snapshot.rejected.length > 0;
  return onlyBuiltins && rejectedExternalCandidate ? SKILL_DISCOVERY_STARTUP_NOTICE : undefined;
}

export function renderSkillSnapshotList(snapshot: SkillDiscoverySnapshot): string[] {
  const lines = [
    `Skills ${snapshot.accepted.length} available · ${snapshot.rejected.length} rejected · ${snapshot.shadowed.length} shadowed · revision ${snapshot.revision}`,
  ];
  for (const scope of ["project", "user", "builtin"] as const) {
    const definitions = snapshot.accepted.filter((definition) => definition.scope === scope);
    if (definitions.length === 0) continue;
    lines.push("", `${capitalize(scope)} (${definitions.length})`);
    const width = definitions.reduce((maximum, definition) => Math.max(maximum, definition.manifest.name.length), 0);
    for (const definition of definitions) {
      lines.push(
        `  $${definition.manifest.name.padEnd(width)}  [${definition.origin} · ${safe(definition.path)}]  ${safe(definition.manifest.description)}`,
      );
    }
  }
  lines.push("", "Run `/skills doctor` for discovery details.");
  return lines;
}

export function renderSkillSnapshotDetail(
  snapshot: SkillDiscoverySnapshot,
  registry: Pick<SkillRegistry, "isLoaded" | "workspaceTrusted">,
  name: string,
): string[] {
  const definition = snapshot.accepted.find((candidate) => candidate.manifest.name === name);
  if (definition === undefined) {
    return [
      `No Skill named '${safe(name)}' is active.`,
      snapshot.accepted.length > 0
        ? `Available: ${snapshot.accepted.map((candidate) => candidate.manifest.name).join(", ")}`
        : "No Skills are available.",
    ];
  }
  const shadowed = snapshot.shadowed.filter((record) => record.name === name);
  const distance = definition.scope === "project" && definition.precedence !== undefined &&
      Number.isFinite(definition.precedence[1])
    ? `, distance ${definition.precedence[1]}`
    : "";
  const trust = definition.scope === "project"
    ? registry.workspaceTrusted ? "trusted project" : "untrusted project (body load blocked)"
    : "operator-installed";
  return [
    ...renderSkillDetail(definition).map(safe),
    `Winner        ${definition.scope}/${definition.origin}${distance}`,
    `Loaded        ${registry.isLoaded(name) ? "yes" : "no"}`,
    `Trust         ${trust}`,
    `Revision      ${snapshot.revision}`,
    `Shadowed      ${shadowed.length}`,
    ...shadowed.map((record) => `  - ${safe(record.shadowed.path)} (${safe(record.reason)})`),
  ];
}

export function renderSkillDoctor(snapshot: SkillDiscoverySnapshot): string[] {
  const lines = [
    "Skill discovery doctor",
    `cwd            ${safe(snapshot.cwd)}`,
    `worktree       ${safe(snapshot.worktreeRoot ?? "not detected")}`,
    `last scan      ${snapshot.generatedAt}`,
    `duration       ${snapshot.durationMs} ms`,
    `revision       ${snapshot.revision}`,
    `digest         ${snapshot.digest}`,
    "",
    "Roots",
  ];
  if (snapshot.roots.length === 0) lines.push("- discovery disabled or no roots configured");
  for (const root of snapshot.roots) {
    const marker = root.status === "scanned" ? "+" : root.status === "missing" ? "-" : "!";
    const suffix = root.message !== undefined ? ` (${safe(root.message)})` : "";
    lines.push(`${marker} ${safe(root.directory)}  ${root.candidates} file(s)  [${root.scope}/${root.origin}]${suffix}`);
  }

  lines.push("", "Rejected / warnings");
  if (snapshot.diagnostics.length === 0) lines.push("- none");
  for (const diagnostic of snapshot.diagnostics) {
    const location = diagnostic.line !== undefined ? `${safe(diagnostic.path)}:${diagnostic.line}` : safe(diagnostic.path);
    lines.push(`${diagnostic.severity === "error" ? "!" : "~"} ${location}: ${safe(diagnostic.field)}: ${safe(diagnostic.message)}`);
  }

  lines.push("", "Shadowed");
  if (snapshot.shadowed.length === 0) lines.push("- none");
  for (const record of snapshot.shadowed) {
    lines.push(`- ${record.name}: ${safe(record.winner.path)} wins over ${safe(record.shadowed.path)} (${safe(record.reason)})`);
  }

  lines.push("", "Canonical duplicates");
  if (snapshot.deduplicated.length === 0) lines.push("- none");
  for (const duplicate of snapshot.deduplicated) {
    lines.push(`- ${safe(duplicate.duplicatePath)} = ${safe(duplicate.winnerPath)} (${safe(duplicate.canonicalPath)})`);
  }
  return lines;
}

/** JSON-safe metadata only: never serialize a Skill body or lazy loader. */
export function skillSnapshotJson(snapshot: SkillDiscoverySnapshot): Record<string, unknown> {
  return {
    applied: snapshot.applied,
    revision: snapshot.revision,
    generatedAt: snapshot.generatedAt,
    durationMs: snapshot.durationMs,
    cwd: snapshot.cwd,
    worktreeRoot: snapshot.worktreeRoot ?? null,
    digest: snapshot.digest,
    roots: snapshot.roots,
    skills: snapshot.accepted.map(skillDefinitionJson),
    diagnostics: snapshot.diagnostics,
    shadowed: snapshot.shadowed.map((record) => ({
      name: record.name,
      winner: record.winner.path,
      shadowed: record.shadowed.path,
      reason: record.reason,
    })),
    deduplicated: snapshot.deduplicated,
    invalidated: snapshot.invalidated,
  };
}

function skillDefinitionJson(definition: SkillDefinition): Record<string, unknown> {
  return {
    name: definition.manifest.name,
    description: definition.manifest.description,
    license: definition.manifest.license ?? null,
    compatibility: definition.manifest.compatibility ?? null,
    metadata: definition.manifest.metadata ?? null,
    requiresCapybara: definition.manifest.requiresCapybara ?? null,
    version: definition.manifest.version ?? null,
    risk: definition.manifest.risk ?? null,
    requestedTools: definition.manifest.requestedTools ?? null,
    userInvocable: definition.manifest.userInvocable,
    source: definition.source,
    scope: definition.scope,
    origin: definition.origin,
    path: definition.path,
    canonicalPath: definition.canonicalPath,
    precedence: definition.precedence ?? null,
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function safe(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "?");
}
