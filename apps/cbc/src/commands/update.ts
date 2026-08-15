/**
 * `capy update` — PRD §6.19, §19.9, §19.10, §22.8, AC-41.
 *
 * AC-41 is the requirement that shapes this: an update check never blocks startup and
 * never installs anything without consent. The check is a cached, best-effort read;
 * an offline machine gets a note and a normal exit, not a failure (§22.8).
 *
 * Installation is deliberately not performed here. This Public Alpha has no release
 * discovery feed, shell installer, or archive-signing scheme. `--check` reports cached
 * information, while `capy update` gives the explicit npm, Bun, and SHA-256 verification
 * instructions for a manual reinstall.
 */

import { join } from "../host.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

interface UpdateCache {
  readonly checkedAtMs: number;
  readonly latestVersion?: string;
  readonly channel: string;
  readonly note?: string;
}

function cachePath(context: CommandContext): string {
  return join(context.paths.cache, "update-check.json");
}

export async function readUpdateCache(
  context: CommandContext,
): Promise<UpdateCache | undefined> {
  const raw = await context.host.fs.read(cachePath(context));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as UpdateCache;
    return typeof parsed.checkedAtMs === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeUpdateCache(context: CommandContext, cache: UpdateCache): Promise<void> {
  await context.host.fs.mkdirp(context.paths.cache);
  await context.host.fs.write(cachePath(context), `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * Compare two semantic versions.
 *
 * Pre-release ordering is intentionally simplified to "a pre-release sorts before its
 * release": that is enough to decide whether to offer an update, and a full semver
 * comparator here would be unused precision.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core = "", pre = ""] = value.replace(/^v/, "").split("-", 2);
    return {
      parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre,
    };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const left = a.parts[i] ?? 0;
    const right = b.parts[i] ?? 0;
    if (left !== right) return left > right;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === "") return true;
  if (b.pre === "") return false;
  return a.pre > b.pre;
}

/**
 * Whether a background check is due (§21.4 `updates.interval_hours`).
 *
 * Exported so the interactive front end can decide without duplicating the cadence
 * rule — §7.1 step 7 runs this in the background after first paint.
 */
export function checkDue(cache: UpdateCache | undefined, nowMs: number, intervalHours: number): boolean {
  if (cache === undefined) return true;
  return nowMs - cache.checkedAtMs >= intervalHours * 3_600_000;
}

export interface UpdateArgs {
  readonly check: boolean;
}

export async function update(
  context: CommandContext,
  args: UpdateArgs,
): Promise<CommandResult> {
  const config = await context.requireConfig();

  if (!config.updates.check && args.check) {
    context.out("Update checks are disabled (updates.check = false).");
    return ok();
  }

  const cached = await readUpdateCache(context);
  const lines: string[] = [
    `Installed  ${context.version}`,
    `Channel    ${config.updates.channel}`,
  ];

  if (cached !== undefined) {
    lines.push(`Last check ${new Date(cached.checkedAtMs).toISOString()}`);
    if (cached.latestVersion !== undefined) lines.push(`Latest     ${cached.latestVersion}`);
    if (cached.note !== undefined) lines.push(`Note       ${cached.note}`);
  } else {
    lines.push("Last check never");
  }

  // This Public Alpha intentionally has no discovery feed. Listing explicit reinstall commands
  // is more honest than inventing a release endpoint or claiming a signing scheme that
  // has not been deployed.
  lines.push("");
  lines.push("This build has no configured release feed, so no remote version was fetched.");
  lines.push("To update this Public Alpha, reinstall explicitly:");
  lines.push("  - npm: npm install -g capybara-code@alpha");
  lines.push("  - Bun: bun install -g capybara-code@alpha");
  lines.push("  - GitHub Releases: download the matching archive and verify SHA256SUMS.txt");

  await writeUpdateCache(context, {
    checkedAtMs: context.host.now(),
    channel: config.updates.channel,
    note: "no release feed configured; reinstall with npm, Bun, or a verified release archive",
  });

  context.outLines(lines);

  if (!args.check) {
    context.out("This command does not download or install updates automatically.");
  }
  return ok();
}
