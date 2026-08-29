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
  const controllers = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    let message: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    if (message.method === "session.close") {
      for (const controller of controllers.values()) controller.abort(new Error("session closed"));
      writeResponse(message.id, { closed: true });
      break;
    }
    const work = dispatchWorkerMessage(boot, message, controllers).then(
      (result) => writeResponse(message.id, result),
      (error) => writeError(message.id, error),
    );
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  await Promise.allSettled([...pending]);
  await boot.dispose?.();
  return ok();
}

async function dispatchWorkerMessage(
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  message: { readonly id?: string; readonly method?: string; readonly params?: Record<string, unknown> },
  controllers: Map<string, AbortController>,
): Promise<unknown> {
  const params = message.params ?? {};
  if (message.method === "turn.cancel") {
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (turnId !== undefined) controllers.get(turnId)?.abort(new Error("turn cancelled"));
    else for (const controller of controllers.values()) controller.abort(new Error("turn cancelled"));
    return { cancelled: true };
  }
  if (message.method === "turn.submit") {
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : "turn_worker_" + crypto.randomUUID().replaceAll("-", "");
    const controller = new AbortController();
    controllers.set(turnId, controller);
    try {
      const result = await boot.session.submit(prompt, controller.signal);
      return {
        turnId: boot.session.viewModel.currentTurnId ?? turnId,
        status: result.report.status,
        answer: result.answer,
        report: result.report,
      };
    } finally {
      controllers.delete(turnId);
    }
  }
  if (message.method === "graph.get") {
    return {
      graph: boot.session.taskGraphSnapshot(),
      budget: boot.session.taskBudgetSnapshot(),
      recovery: boot.session.taskRecoveryReport(),
    };
  }
  if (message.method === "graph.listNodes") {
    return { nodes: boot.session.taskInstances() };
  }
  if (message.method === "task.get") {
    const taskId = requiredString(params.taskId, "taskId");
    const instance = boot.session.taskInstance(taskId);
    if (instance === undefined) throw new Error("unknown task");
    return { instance };
  }
  if (message.method === "task.wait") {
    const taskId = requiredString(params.taskId, "taskId");
    const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs >= 0
      ? params.timeoutMs
      : undefined;
    return {
      taskId,
      result: await boot.session.waitTask(
        taskId,
        timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      ),
      instance: boot.session.taskInstance(taskId),
    };
  }
  if (message.method === "task.message") {
    const taskId = requiredString(params.taskId, "taskId");
    const kind = requiredString(params.kind, "kind");
    boot.session.messageTask(taskId, kind, params.body);
    return { taskId, kind, queued: true };
  }
  if (message.method === "task.cancel") {
    const taskId = requiredString(params.taskId, "taskId");
    const reason = typeof params.reason === "string"
      ? params.reason
      : "cancelled through daemon App Protocol";
    return { taskId, result: await boot.session.cancelTaskResult(taskId, reason) };
  }
  throw Object.assign(new Error("method not found"), { code: -32601 });
}

function writeResponse(id: string | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function writeError(id: string | undefined, error: unknown): void {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "number"
    ? error.code
    : -32603;
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: error instanceof Error ? error.message : "session worker error",
    },
  }) + "\n");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(name + " must be a non-empty string");
  }
  return value;
}

export const SESSION_WORKER_EXIT = EXIT;
