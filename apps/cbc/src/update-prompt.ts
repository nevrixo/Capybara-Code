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
import { automaticUpdateManager } from "./update-install.ts";

export type UpdatePromptDecision = "update" | "later";

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
    boxRow("Release:"),
    boxRow(`  ${UPDATE_REPO_URL}/`),
    boxRow(`  releases/tag/${candidate.tag}`),
    boxRow(""),
    boxRow("Update now installs it, or shows exact steps."),
    boxRow("Next time keeps this version only for this run."),
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
  const manager = automaticUpdateManager(context.host);
  const choices = [
    manager === undefined ? "1. Show update instructions" : `1. Update now with ${manager}`,
    "2. Remind me next time",
  ];

  const termWidth = Math.min(84, Math.max(54, (context.host.io.columns || 80) - 4));
  for (const lineText of renderUpdateBoxLines(context.version, candidate, termWidth)) {
    context.out(lineText);
  }

  const index = await context.host.io.select("", choices);
  // Esc / cancel is a session-only skip: nothing is persisted and the process
  // continues into the TUI.
  return index === 0 ? "update" : "later";
}

/** Manual fallback for archive launches or a failed launcher handoff. */
export function printUpdateGuidance(context: CommandContext, candidate: ReleaseCandidate): void {
  context.out("");
  context.out(`To update to ${candidate.version}, install the exact version with the`);
  context.out("package manager used to install Capybara Code:");
  context.out("");
  context.out(`  npm install -g capybara-code@${candidate.version}`);
  context.out(`  bun install -g capybara-code@${candidate.version}`);
  context.out("");
  context.out("or download the archive and verify SHA256SUMS.txt before installing:");
  context.out("");
  context.out(`  ${candidate.htmlUrl}`);
  context.out("");
  context.out("Then run capy again.");
}
