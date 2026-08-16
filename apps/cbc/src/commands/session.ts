/**
 * `capy session` — PRD §7.8, §8.6, §18.6, §18.12, §18.19, AC-35.
 *
 * P0-05: the runtime's SQLite store is the single session authority. Every command
 * here goes through a `session.*` RPC — there is no host-side index or journal file
 * to drift out of sync. §8.6 still means `delete` removes the transcript (and the
 * store rows that own it) but never a keychain credential.
 */

import { exportMarkdown, redactWorkspacePath, type SessionManifest } from "@cbc/session-domain";

import { CliError, EXIT, usageError } from "../exit.ts";
import { workspaceHash } from "../host.ts";
import { newSessionId } from "../state.ts";
import type { RuntimeSessionSummary } from "../runtime.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export async function sessionList(context: CommandContext): Promise<CommandResult> {
  const runtime = await context.runtime();
  const { sessions: entries } = await runtime.listSessions({ limit: 200 });

  if (entries.length === 0) {
    context.out(`No sessions recorded for ${context.workspacePath}`);
    return ok();
  }

  const lines = entries.map((entry) => {
    const when = entry.updatedAt.replace("T", " ").slice(0, 19);
    return `${entry.id}  ${when}  ${entry.state.padEnd(11)}  ${entry.turnCount} turn(s)  ${entry.title}`;
  });
  context.outLines(lines);
  return ok();
}

export interface SessionIdArgs {
  readonly id: string;
}

/**
 * Resolve a selector against the durable store, scoped to this workspace (§8.6).
 *
 * A prefix match is accepted because ids are long timestamps and typing one in full
 * is not a reasonable expectation — but only within this workspace, so a session
 * from another repository can never be resumed, exported, or deleted by mistake.
 */
async function requireSession(
  context: CommandContext,
  selector: string,
): Promise<RuntimeSessionSummary> {
  const runtime = await context.runtime();
  const { sessions } = await runtime.listSessions({ limit: 10_000 });

  const entry =
    selector === "last"
      ? sessions[0]
      : sessions.find((session) => session.id === selector) ??
        sessions.find((session) => session.title === selector) ??
        findUniquePrefix(sessions, selector);

  if (entry === undefined) {
    const available = sessions
      .slice(0, 10)
      .map((candidate) => `  ${candidate.id}  ${candidate.title}`);
    throw new CliError(
      EXIT.usage,
      selector === "last"
        ? "there is no previous session for this workspace"
        : `no session matches '${selector}'`,
      available.length > 0 ? ["Available:", ...available] : [],
    );
  }
  return entry;
}

function findUniquePrefix(
  sessions: readonly RuntimeSessionSummary[],
  selector: string,
): RuntimeSessionSummary | undefined {
  const matches = sessions.filter(
    (session) => session.id.startsWith(selector) || session.title.startsWith(selector),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * `capy session resume` outside the TUI.
 *
 * §7.8 lists what resume restores, all of which is journal state the interactive
 * front end rebuilds. From the CLI the useful action is to report what *would* be
 * restored, then hand off — so this prints the summary and tells the user how to
 * continue, rather than silently opening a UI they did not ask for.
 */
export async function sessionResume(
  context: CommandContext,
  args: SessionIdArgs,
): Promise<CommandResult> {
  const entry = await requireSession(context, args.id);

  context.outLines([
    `Session   ${entry.id}`,
    `Title     ${entry.title}`,
    `Workspace ${entry.workspacePath}`,
    `State     ${entry.state}`,
    `Turns     ${entry.turnCount}`,
    `Updated   ${entry.updatedAt}`,
    `Storage   runtime session store (SQLite)`,
    "",
    `Continue it with: capy --resume ${entry.id}`,
  ]);
  return ok();
}

/** §18.12: a fork copies the durable journal under a new id, leaving the parent alone. */
export async function sessionFork(
  context: CommandContext,
  args: SessionIdArgs,
): Promise<CommandResult> {
  const entry = await requireSession(context, args.id);
  const runtime = await context.runtime();
  const forkId = newSessionId(context.host.now());

  await runtime.forkSession({
    sessionId: entry.id,
    newSessionId: forkId,
    title: `${entry.title} (fork)`,
  });

  context.out(`Forked ${entry.id} to ${forkId}`);
  context.out(`Continue it with: capy --resume ${forkId}`);
  return ok();
}

export interface SessionExportArgs {
  readonly id: string;
  readonly format: "markdown" | "jsonl" | "bundle";
  readonly output?: string;
}

export async function sessionExport(
  context: CommandContext,
  args: SessionExportArgs,
): Promise<CommandResult> {
  const entry = await requireSession(context, args.id);
  const runtime = await context.runtime();

  const exported = await runtime.exportSession(entry.id).catch((error) => {
    throw new CliError(
      EXIT.failure,
      `no journal found for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      ["The session may have been deleted, or it never produced a durable event."],
    );
  });

  const manifest = toManifest(exported.manifest);

  let body: string;
  if (args.format === "jsonl") {
    body = exported.jsonl;
  } else if (args.format === "markdown") {
    const model = await replayModel(exported.jsonl, entry);
    body = exportMarkdown(model, manifest);
  } else {
    // §18.19's bundle: manifest plus journal in one self-describing document, so a
    // consumer does not need the store layout to read it.
    body = `${JSON.stringify({ manifest, schemaVersion: manifest.schemaVersion }, null, 2)}\n---\n${exported.jsonl}`;
  }

  if (args.output !== undefined) {
    await context.host.fs.write(args.output, body.endsWith("\n") ? body : `${body}\n`);
    context.out(`Exported ${entry.id} to ${args.output}`);
  } else {
    context.out(body);
  }
  return ok();
}

/** §8.6 / §18.19: remove the transcript and its store rows, never the credential. */
export async function sessionDelete(
  context: CommandContext,
  args: SessionIdArgs,
): Promise<CommandResult> {
  if (args.id === "last") {
    // Deleting by "last" is too easy to get wrong to allow silently.
    throw usageError("capy session delete needs an explicit session id", [
      "Run `capy session list` and pass the id you mean.",
    ]);
  }
  const entry = await requireSession(context, args.id);
  const runtime = await context.runtime();
  await runtime.deleteSession(entry.id);

  context.out(`Deleted ${entry.id} from the session store`);
  context.out("Stored credentials were not touched.");
  return ok();
}

function toManifest(entry: RuntimeSessionSummary): SessionManifest {
  return {
    schemaVersion: entry.schemaVersion || "1.0",
    id: entry.id,
    workspacePath: redactWorkspacePath(entry.workspacePath),
    workspaceFingerprint: entry.workspaceFingerprint || workspaceHash(entry.workspacePath),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    title: entry.title,
    modelProfile: entry.modelProfile || "unknown",
    permissionMode: entry.permissionMode || "unknown",
    lastEventSequence: entry.lastEventSequence,
    state: entry.state,
  };
}

/** Rebuild the view model from an exported JSONL journal (§20.8 replay). */
async function replayModel(jsonl: string, entry: RuntimeSessionSummary) {
  const { fromJsonl } = await import("@cbc/protocol");
  const { replay } = await import("@cbc/session-domain");
  const events = jsonl
    .split("\n")
    .map((line) => fromJsonl(line))
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  return replay(entry.id, events);
}
