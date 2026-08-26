/**
 * The startup update prompt — §5.1.
 *
 * Same orange box, same `host.io.select` input, same place in the sequence as
 * the folder-trust prompt: after trust, before the TUI paints. Esc cancels for
 * this run only and never exits the process, unlike trust's "No, exit".
 */

import type { CommandContext } from "./commands/context.ts";
import { stringWidth } from "@cbc/tui-components";

import { UPDATE_REPO_URL, type ReleaseCandidate } from "./update-check.ts";
import { readUpdateStore, withSkippedVersion, writeUpdateStore } from "./update-store.ts";

export type UpdatePromptDecision = "update" | "skip" | "later";

const BOX_COLOR = "\u001B[38;5;214m";
const RESET = "\u001B[0m";

/** Render the box exactly like the trust prompt: fixed width, hard-wrapped copy. */
export function renderUpdateBoxLines(
  currentVersion: string,
  candidate: ReleaseCandidate,
  termWidth: number,
): string[] {
  const innerWidth = termWidth - 6;

  const topBorder = `${BOX_COLOR}╭${"─".repeat(termWidth - 2)}╮${RESET}`;
  const bottomBorder = `${BOX_COLOR}╰${"─".repeat(termWidth - 2)}╯${RESET}`;
  const boxRow = (content: string = ""): string => {
    const rawLen = stringWidth(content.replace(/\u001B\[[0-9;]*m/g, ""));
    const pad = Math.max(0, innerWidth - rawLen);
    return `${BOX_COLOR}│${RESET}  ${content}${" ".repeat(pad)}  ${BOX_COLOR}│${RESET}`;
  };

  return [
    "",
    topBorder,
    boxRow(""),
    boxRow("\u001B[1;38;5;214mA new version of Capybara Code is available\u001B[0m"),
    boxRow(""),
    boxRow(`current   ${currentVersion}`),
    boxRow(`latest    \u001B[1;36m${candidate.version}\u001B[0m`),
    boxRow(""),
    boxRow("Source: github.com/nevrixo/Capybara-Code"),
    boxRow(`Release: ${UPDATE_REPO_URL}/`),
    boxRow(`         releases/tag/${candidate.tag}`),
    boxRow(""),
    boxRow("Updates replace the installed capy binary. Skip keeps"),
    boxRow("this version and will not ask again until a newer one."),
    boxRow(""),
    bottomBorder,
    "",
  ];
}

/** Ask the user; the answer drives the rest of startup (§5.4). */
export async function ensureUpdatePrompt(
  context: CommandContext,
  candidate: ReleaseCandidate,
): Promise<UpdatePromptDecision> {
  const choices = ["1. Update now", "2. Skip this version"];

  const termWidth = Math.min(84, Math.max(54, (context.host.io.columns || 80) - 4));
  for (const lineText of renderUpdateBoxLines(context.version, candidate, termWidth)) {
    context.out(lineText);
  }

  const index = await context.host.io.select("", choices);
  // Esc / cancel is a session-only skip: nothing is persisted and the process
  // continues into the TUI.
  return index === 0 ? "update" : index === 1 ? "skip" : "later";
}

/**
 * PR-1 scope for "Update now" (Q1): no self-install yet. Print the verified
 * manual path for the exact GitHub tag version and exit; the user re-runs
 * `capy`. Self-installing belongs to the later PRs in the plan.
 */
export function printUpdateGuidance(context: CommandContext, candidate: ReleaseCandidate): void {
  context.out("");
  context.out(`To update to ${candidate.version}, install the exact version with the`);
  context.out("package manager used to install Capybara Code:");
  context.out("");
  context.out(`  npm install -g capybara-code@${candidate.version}`);
  context.out("");
  context.out("or download the archive and verify SHA256SUMS.txt before installing:");
  context.out("");
  context.out(`  ${candidate.htmlUrl}`);
  context.out("");
  context.out("Then run capy again.");
}

/** Persist "Skip this version" so it is not asked again until a newer release. */
export async function recordSkippedUpdate(context: CommandContext, version: string): Promise<void> {
  try {
    const store = await readUpdateStore(context.host, context.paths);
    const next = withSkippedVersion(store, version, new Date(context.host.now()).toISOString());
    await writeUpdateStore(context.host, context.paths, next);
  } catch {
    // A failed write only means the user will be asked again sooner.
  }
}
