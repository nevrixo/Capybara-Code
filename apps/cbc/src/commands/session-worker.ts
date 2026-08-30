/**
 * Hidden daemon child: owns AgentSession so a TUI exit cannot kill the turn.
 *
 * Speaks NDJSON JSON-RPC on stdin/stdout. Detach is a client event; this process
 * only stops on turn.cancel, session.close, or SIGTERM.
 */

import { createInterface } from "node:readline";

import type { AppMethod } from "@cbc/app-protocol";
import type {
  DeepPlanAnswer,
  UserAskBatchInput,
  UserAskBatchResult,
} from "@cbc/session-domain";

import { bootstrapSession } from "../bootstrap.ts";
import { EXIT } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export interface SessionWorkerArgs {
  readonly sessionId?: string;
  readonly resume?: string;
}

export interface PendingWorkerQuestionnaire {
  readonly input: UserAskBatchInput;
  readonly onDraftChange?: (
    answers: readonly DeepPlanAnswer[],
    activeQuestionIndex: number,
  ) => void;
  readonly resolve: (result: UserAskBatchResult) => void;
}

export async function sessionWorker(
  context: CommandContext,
  args: SessionWorkerArgs,
): Promise<CommandResult> {
  const questionnaires = new Map<string, PendingWorkerQuestionnaire>();
  const boot = await bootstrapSession({
    context,
    noDaemon: true,
    ...(args.resume !== undefined ? { resume: args.resume } : {}),
    ...(args.sessionId !== undefined ? { resume: args.sessionId } : {}),
    bridges: {
      askBatch: async (input, signal, onDraftChange) => await new Promise<UserAskBatchResult>(
        (resolve) => {
          const prior = questionnaires.get(input.questionnaireId);
          prior?.resolve({
            questionnaireId: input.questionnaireId,
            status: "cancelled",
            answers: [],
          });
          let settled = false;
          const finish = (result: UserAskBatchResult): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            if (questionnaires.get(input.questionnaireId)?.resolve === finish) {
              questionnaires.delete(input.questionnaireId);
            }
            resolve(result);
          };
          const onAbort = (): void => finish({
            questionnaireId: input.questionnaireId,
            status: "cancelled",
            answers: [],
          });
          questionnaires.set(input.questionnaireId, {
            input,
            ...(onDraftChange === undefined ? {} : { onDraftChange }),
            resolve: finish,
          });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        },
      ),
    },
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
      for (const [questionnaireId, pendingQuestionnaire] of questionnaires) {
        pendingQuestionnaire.resolve({
          questionnaireId,
          status: "cancelled",
          answers: [],
        });
      }
      writeResponse(message.id, { closed: true });
      break;
    }
    const work = dispatchSessionWorkerMessage(boot, message, controllers, questionnaires).then(
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

export async function dispatchSessionWorkerMessage(
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  message: { readonly id?: string; readonly method?: string; readonly params?: Record<string, unknown> },
  controllers: Map<string, AbortController>,
  questionnaires: Map<string, PendingWorkerQuestionnaire>,
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
  if (message.method === "turn.input.get") {
    return {
      pending: boot.session.deepPlanState.pendingQuestionnaire,
      state: boot.session.deepPlanState,
    };
  }
  if (message.method === "turn.input.update") {
    const questionnaireId = requiredString(params.questionnaireId, "questionnaireId");
    const answers = deepPlanAnswers(params.answers);
    const activeQuestionIndex =
      typeof params.activeQuestionIndex === "number" &&
      Number.isSafeInteger(params.activeQuestionIndex) &&
      params.activeQuestionIndex >= 0
        ? params.activeQuestionIndex
        : 0;
    const pendingQuestionnaire = questionnaires.get(questionnaireId);
    if (pendingQuestionnaire?.onDraftChange !== undefined) {
      pendingQuestionnaire.onDraftChange(answers, activeQuestionIndex);
    } else {
      boot.session.updateDeepPlanQuestionnaireDraft(
        questionnaireId,
        answers,
        activeQuestionIndex,
      );
    }
    return {
      questionnaireId,
      updated: true,
      state: boot.session.deepPlanState,
    };
  }
  if (message.method === "turn.input.resolve") {
    const questionnaireId = requiredString(params.questionnaireId, "questionnaireId");
    const status = params.status;
    if (
      status !== "submitted" &&
      status !== "draft_now" &&
      status !== "paused" &&
      status !== "cancelled" &&
      status !== "unavailable"
    ) throw new Error("status is invalid");
    const result: UserAskBatchResult = {
      questionnaireId,
      status,
      answers: deepPlanAnswers(params.answers),
    };
    const pendingQuestionnaire = questionnaires.get(questionnaireId);
    if (pendingQuestionnaire !== undefined) {
      pendingQuestionnaire.resolve(result);
      return { questionnaireId, accepted: true, continuationRequired: false };
    }
    boot.session.resolveDeepPlanQuestionnaire(result);
    return { questionnaireId, accepted: true, continuationRequired: true };
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
  if (message.method === "plugin.list") {
    return { plugins: boot.packageRuntime.plugins() };
  }
  if (
    message.method !== undefined
    && boot.packageRuntime.appMethods().includes(message.method as AppMethod)
  ) {
    const {
      sessionId: _sessionId,
      idempotencyKey,
      ...payload
    } = params;
    return await boot.packageRuntime.dispatchApp({
      method: message.method as AppMethod,
      payload,
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
    });
  }
  throw Object.assign(new Error("method not found"), { code: -32601 });
}

function deepPlanAnswers(value: unknown): DeepPlanAnswer[] {
  if (!Array.isArray(value)) throw new Error("answers must be an array");
  return value.map((raw, index): DeepPlanAnswer => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`answers[${index}] must be an object`);
    }
    const answer = raw as Record<string, unknown>;
    const questionId = requiredString(answer.questionId, `answers[${index}].questionId`);
    const decisionKey = requiredString(answer.decisionKey, `answers[${index}].decisionKey`);
    if (
      answer.selectedOptionIds !== undefined &&
      (!Array.isArray(answer.selectedOptionIds) ||
        answer.selectedOptionIds.some((id) => typeof id !== "string"))
    ) throw new Error(`answers[${index}].selectedOptionIds must be strings`);
    if (answer.customText !== undefined && typeof answer.customText !== "string") {
      throw new Error(`answers[${index}].customText must be a string`);
    }
    return {
      questionId,
      decisionKey,
      ...(answer.selectedOptionIds === undefined
        ? {}
        : { selectedOptionIds: answer.selectedOptionIds as string[] }),
      ...(typeof answer.customText === "string"
        ? { customText: answer.customText }
        : {}),
    };
  });
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
