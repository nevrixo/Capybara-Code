/**
 * `capy trust` and the §7.1 first-run trust prompt — PRD §7.1, §13.6, AC-28.
 *
 * §13.6 makes trust the gate on project config, project MCP stdio servers, project
 * agent definitions, and project Skill bodies. That is why the prompt runs before
 * anything else reads the workspace, and why a corrupt or absent record resolves to
 * `untrusted` rather than to a permissive default.
 */

import type { TrustState } from "@cbc/permissions";
import { stringWidth } from "@cbc/tui-components";

import { EXIT } from "../exit.ts";
import type { Runtime } from "../runtime.ts";
import {
  readTrustStore,
  trustStateFor,
  withTrust,
  writeTrustStore,
  type TrustRecord,
  type TrustStore,
} from "../state.ts";
import { ok, resolveWorkspace, type CommandContext, type CommandResult } from "./context.ts";

const TRUST_LABELS: Readonly<Record<TrustState, string>> = {
  untrusted: "not trusted",
  "trusted-once": "trusted for this session",
  "trusted-always": "always trusted",
  "read-only": "read-only",
};

export function trustLabel(state: TrustState): string {
  return TRUST_LABELS[state];
}

export async function trustStatus(context: CommandContext): Promise<CommandResult> {
  // The runtime is the trust authority (P0-01). When it is already up its answer
  // wins — it sees filesystem identity, which the host store cannot. A status read
  // with no sidecar still answers from the shared store file (§22.1: an admin read
  // must not pay for a sidecar), and the two agree because the file is written in
  // the runtime's format by the runtime alone.
  let store: TrustStore;
  let state: TrustState;
  if (context.runtimeStarted) {
    const runtime = await context.runtime();
    const read = await runtime.readTrust();
    state = read.state as TrustState;
    store = await runtimeTrustStore(runtime);
  } else {
    store = await context.trustStore();
    const identity = await context.host.fs.statIdentity?.(context.workspacePath);
    state = trustStateFor(store, context.workspacePath, identity);
  }

  const normalizedWorkspace = context.workspacePath.replace(/\\/g, "/").toLowerCase();
  const record =
    Object.values(store.records).find(
      (entry) => entry.path.replace(/\\/g, "/").toLowerCase() === normalizedWorkspace,
    ) ?? store.records[context.workspacePath.replace(/\\/g, "/").toLowerCase()];

  const lines = [
    `Workspace  ${context.workspacePath}`,
    `Trust      ${trustLabel(state)}`,
  ];
  if (record !== undefined) {
    lines.push(`Decided    ${record.decidedAt}`);
    if (record.fingerprint !== undefined && record.fingerprint.length > 0) {
      lines.push(`Identity   ${record.fingerprint}`);
    }
  }
  lines.push("");
  lines.push(
    state === "untrusted"
      ? "Project config, project MCP servers, project agents, and project Skill bodies are not loaded."
      : state === "read-only"
        ? "Mutations are refused; reads and project instructions are allowed."
        : "Project configuration is applied.",
  );

  const others = Object.values(store.records).filter(
    (entry) => entry.path.replace(/\\/g, "/").toLowerCase() !== normalizedWorkspace,
  );
  if (others.length > 0) {
    lines.push("");
    lines.push(`${others.length} other trusted path(s):`);
    for (const entry of others.slice(0, 20)) {
      lines.push(`  ${trustLabel(entry.state).padEnd(18)} ${entry.path}`);
    }
  }

  context.outLines(lines);
  return ok();
}

/** Mirror the runtime's trust records into the host `TrustStore` shape. */
async function runtimeTrustStore(runtime: Runtime): Promise<TrustStore> {
  const { records } = await runtime.listTrust();
  const out: Record<string, TrustRecord> = {};
  for (const record of records) {
    if (record.state !== "trusted-always" && record.state !== "read-only") continue;
    out[record.canonicalPath] = {
      path: record.canonicalPath,
      state: record.state,
      decidedAt: record.decidedAt,
      ...(record.filesystemId.length > 0 ? { fingerprint: record.filesystemId } : {}),
    };
  }
  return { version: 1, records: out };
}

export interface TrustPathArgs {
  readonly path: string;
}

/**
 * `capy trust add` / `remove` go through the runtime rather than writing the store
 * file directly (P0-01). The runtime canonicalizes the path and records filesystem
 * identity, and persisting through it keeps the in-memory authority and the durable
 * file in one place. The host cache is then refreshed from the shared store so the
 * rest of this invocation agrees.
 */
async function mutateTrustViaRuntime(
  context: CommandContext,
  mutate: (runtime: Runtime) => Promise<{ canonicalPath: string }>,
): Promise<void> {
  const runtime = await context.runtime();
  const { canonicalPath } = await mutate(runtime);
  const store = await readTrustStore(context.host, context.paths);
  const isCurrent =
    canonicalPath === context.workspacePath ||
    canonicalPath.replace(/\\/g, "/").toLowerCase() ===
      context.workspacePath.replace(/\\/g, "/").toLowerCase();
  if (isCurrent) {
    const identity = await context.host.fs.statIdentity?.(context.workspacePath);
    context.setTrust(trustStateFor(store, context.workspacePath, identity), store);
  } else {
    context.setTrust(await context.trust(), store);
  }
}

export async function trustAdd(
  context: CommandContext,
  args: TrustPathArgs,
): Promise<CommandResult> {
  const target = resolveWorkspace(context.host, args.path);
  let canonical = target;
  await mutateTrustViaRuntime(context, async (runtime) => {
    const result = await runtime.setTrustFor(target, "trusted-always");
    canonical = result.canonicalPath;
    return result;
  });
  context.out(`Trusted ${canonical}`);
  return ok();
}

export async function trustRemove(
  context: CommandContext,
  args: TrustPathArgs,
): Promise<CommandResult> {
  const target = resolveWorkspace(context.host, args.path);
  let canonical = target;
  await mutateTrustViaRuntime(context, async (runtime) => {
    const result = await runtime.removeTrustFor(target);
    canonical = result.canonicalPath;
    return result;
  });
  context.out(`Removed trust for ${canonical}`);
  return ok();
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
  if (options.runtime !== undefined) {
    await options.runtime.writeTrust(decision);
    const refreshed = await readTrustStore(context.host, context.paths);
    context.setTrust(decision, refreshed);
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
    }
  }

  // Mirror the decision into the runtime when one is already up, so the guard and
  // the host agree without a second prompt (§13.6 keys on filesystem identity).

  context.out("");
  return decision;
}

/** Exit code for a user who chose "Exit" at the trust prompt. */
export const TRUST_DECLINED_EXIT = EXIT.ok;
