/**
 * Hidden daemon child: owns AgentSession so a TUI exit cannot kill the turn.
 *
 * Speaks NDJSON JSON-RPC on stdin/stdout. Detach is a client event; this process
 * only stops on turn.cancel, session.close, or SIGTERM.
 */

import { createInterface } from "node:readline";

import { bootstrapSession } from "../bootstrap.ts";
import { EXIT } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export interface SessionWorkerArgs {
  readonly sessionId?: string;
  readonly resume?: string;
}

export async function sessionWorker(
  context: CommandContext,
  args: SessionWorkerArgs,
): Promise<CommandResult> {
  const boot = await bootstrapSession({
    context,
    noDaemon: true,
    ...(args.resume !== undefined ? { resume: args.resume } : {}),
    ...(args.sessionId !== undefined ? { resume: args.sessionId } : {}),
  });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    let message: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    if (message.method === "session.close") {
      await boot.dispose?.();
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { closed: true } }) + "\n");
      break;
    }
    if (message.method === "turn.cancel") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { cancelled: true } }) + "\n");
      continue;
    }
    if (message.method !== "turn.submit") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      }) + "\n");
      continue;
    }
    const prompt = typeof message.params?.prompt === "string" ? message.params.prompt : "";
    const controller = new AbortController();
    const result = await boot.session.submit(prompt, controller.signal);
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? message.params?.turnId,
      result: {
        turnId: boot.session.viewModel.currentTurnId,
        status: result.report.status,
        answer: result.answer,
        report: result.report,
      },
    }) + "\n");
  }
  await boot.dispose?.();
  return ok();
}

export const SESSION_WORKER_EXIT = EXIT;
