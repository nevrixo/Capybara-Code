/** Workspace trust used by interactive and headless sessions. */

import type { TrustState } from "@cbc/permissions";
import { stringWidth } from "@cbc/tui-components";

import type { Runtime } from "./runtime.ts";
import {
  readTrustStore,
  withProjectControlTrust,
  withTrust,
  writeProjectControlTrustStore,
  writeTrustStore,
} from "./state.ts";
import type { CommandContext } from "./commands/context.ts";

const TRUST_LABELS: Readonly<Record<TrustState, string>> = {
  untrusted: "not trusted",
  "trusted-once": "trusted for this session",
  "trusted-always": "always trusted",
  "read-only": "read-only",
};

export function trustLabel(state: TrustState): string {
  return TRUST_LABELS[state];
}
export type TrustDecision = TrustState | "exit";

/**
 * §7.1's first-run prompt.
 *
 * `trusted-once` is never persisted — it is a session-scoped answer, and writing it
 * would silently upgrade a one-time decision into a standing one. The record is only
 * written for `trusted-always` and `read-only`.
 */
export async function ensureTrust(
  context: CommandContext,
  options: { runtime?: Runtime } = {},
): Promise<TrustDecision> {
  let current = await context.trust();
  if (current !== "untrusted" && options.runtime !== undefined) {
    if (current === "trusted-once") {
      await options.runtime.writeTrust(current);
      return current;
    }
    const authoritative = await options.runtime.readTrust();
    if (authoritative.state === current) return current;
    context.warn("stored trust no longer matches the runtime filesystem identity; asking again");
    context.setTrust("untrusted");
    current = "untrusted";
  }
  if (current !== "untrusted") return current;

  if (context.nonInteractive) {
    // §13.6: an untrusted workspace in a non-interactive run is not promoted. The
    // run continues read-only rather than failing, so `capy run` can still analyze a
    // repository it was pointed at without being granted write authority.
    context.warn(`workspace is not trusted; continuing read-only: ${context.workspacePath}`);
    context.setTrust("read-only");
    return "read-only";
  }

  const choices = [
    "1. Yes, proceed",
    "2. Always trust this path",
    "3. Open read-only",
    "4. No, exit",
  ];
  const projectSnapshot = await context.projectTrustSnapshot();

  const termWidth = Math.min(84, Math.max(54, (context.host.io.columns || 80) - 4));
  const innerWidth = termWidth - 6;

  const topBorder = `\x1b[38;5;214m╭${"─".repeat(termWidth - 2)}╮\x1b[0m`;
  const bottomBorder = `\x1b[38;5;214m╰${"─".repeat(termWidth - 2)}╯\x1b[0m`;
  const boxRow = (content: string = "") => {
    const rawLen = stringWidth(content.replace(/\x1b\[[0-9;]*m/g, ""));
    const pad = Math.max(0, innerWidth - rawLen);
    return `\x1b[38;5;214m│\x1b[0m  ${content}${" ".repeat(pad)}  \x1b[38;5;214m│\x1b[0m`;
  };

  context.out("");
  context.out(topBorder);
  context.out(boxRow(""));
  context.out(boxRow("\x1b[1;38;5;214mDo you trust the files in this folder?\x1b[0m"));
  context.out(boxRow(""));
  context.out(boxRow(`\x1b[1;36m${context.workspacePath}\x1b[0m`));
  context.out(boxRow(""));
  context.out(boxRow("Capybara Code may read files in this folder. Reading untrusted"));
  context.out(boxRow("files may lead Capybara Code to behave in unexpected ways."));
  context.out(boxRow(""));
  context.out(boxRow("With your permission Capybara Code may execute files in this"));
  context.out(boxRow("folder. Executing untrusted code is unsafe."));
  if (projectSnapshot.hasProjectControlFiles) {
    context.out(boxRow(""));
    context.out(boxRow(
      "Project capabilities: " +
        (projectSnapshot.requestedCapabilities.join(", ") || "configuration only"),
    ));
    context.out(boxRow("Trust digest: " + projectSnapshot.projectDigest.slice(0, 26) + "…"));
  }
  context.out(boxRow(""));
  context.out(boxRow(""));
  context.out(bottomBorder);
  context.out("");

  const index = await context.host.io.select("", choices);

  const decision: TrustDecision =
    index === 0
      ? "trusted-once"
      : index === 1
        ? "trusted-always"
        : index === 2
          ? "read-only"
          : "exit";

  if (decision === "exit") return "exit";

  const store = await context.trustStore();
  const projectStore = await context.projectControlTrustStore();
  if (options.runtime !== undefined) {
    await options.runtime.writeTrust(decision);
    const refreshed = await readTrustStore(context.host, context.paths);
    context.setTrust(decision, refreshed);
    if (decision === "trusted-always") {
      const fingerprint = await context.host.fs.statIdentity?.(context.workspacePath);
      if (fingerprint !== undefined && fingerprint.length > 0) {
        const nextProjectStore = withProjectControlTrust(projectStore, {
          path: context.workspacePath,
          fingerprint,
          decidedAt: new Date(context.host.now()).toISOString(),
          project: projectSnapshot,
        });
        await writeProjectControlTrustStore(context.host, context.paths, nextProjectStore);
        context.setProjectControlTrustStore(nextProjectStore);
      }
    }
  } else if (decision === "trusted-once") {
    context.setTrust("trusted-once", store);
  } else {
    const fingerprint = await context.host.fs.statIdentity?.(context.workspacePath);
    if (fingerprint === undefined || fingerprint.length === 0) {
      context.warn("filesystem identity is unavailable; this trust decision applies to this invocation only");
      context.setTrust(decision, store);
    } else {
      const next = withTrust(store, {
        path: context.workspacePath,
        state: decision,
        decidedAt: new Date(context.host.now()).toISOString(),
        fingerprint,
      });
      await writeTrustStore(context.host, context.paths, next);
      context.setTrust(decision, next);
      if (decision === "trusted-always") {
        const nextProjectStore = withProjectControlTrust(projectStore, {
          path: context.workspacePath,
          fingerprint,
          decidedAt: new Date(context.host.now()).toISOString(),
          project: projectSnapshot,
        });
        await writeProjectControlTrustStore(context.host, context.paths, nextProjectStore);
        context.setProjectControlTrustStore(nextProjectStore);
      }
    }
  }

  // Mirror the decision into the runtime when one is already up, so the guard and
  // the host agree without a second prompt (§13.6 keys on filesystem identity).

  context.out("");
  return decision;
}
