/** Headless capy run entry point. */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderChatResponse, renderReport, type CompletionPresentation, type CompletionReport } from "@cbc/agent-kernel";
import {
  validateTriggerEnvelope,
  type HeadlessPermissionPolicy,
  type TriggerEnvelope,
} from "@cbc/integration-core";
import type { CbcEvent } from "@cbc/protocol";

import { bootstrapSession, warmContext } from "../bootstrap.ts";
import { submitTurnOverApp } from "../session-app-client.ts";
import { CliError, EXIT, exitForStatus, type ExitCode } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";
import { ensureTrust } from "../workspace-trust.ts";

export interface RunArgs {
  readonly prompt?: string;
  /** Internal machine-readable result sink for repository-owned integrations. */
  readonly resultFile?: string;
  /** Strict minimized integration envelope; raw provider payloads are rejected. */
  readonly eventFile?: string;
  readonly permissionPolicy?: HeadlessPermissionPolicy;
  /** Internal event tap used by repository-owned integrations such as cbc-bench. */
  readonly onEvent?: (event: CbcEvent) => void;
  /** Internal cancellation signal; the public CLI installs process signal handlers. */
  readonly signal?: AbortSignal;
  readonly noDaemon?: boolean;
}

interface FinalStatusPayload {
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  readonly exitCode: number;
  readonly changedFiles: string[];
  readonly turnId: string;
  readonly summary: string;
  readonly commitSha: null;
  readonly evidenceIds: readonly string[];
  readonly verification: readonly Readonly<Record<string, unknown>>[];
  readonly annotations: readonly Readonly<Record<string, unknown>>[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  readonly tests?: { passed: number; failed: number; notRun: number };
  readonly risks?: string[];
  /** A category only; never serialize unredacted exception text into the result. */
  readonly errorCategory?: string;
}

interface ResultFilePayload extends FinalStatusPayload {
  readonly schemaVersion: "1.0";
  readonly sessionId: string;
}

export async function run(context: CommandContext, args: RunArgs): Promise<CommandResult> {
  const trigger = await resolveTrigger(args, context);
  const prompt = resolvePrompt(args, trigger);
  const resultFile = resolveResultFile(args);
  const resultJournalFile = resolveResultJournalFile(resultFile);

  // A non-interactive run never prompts for trust. An untrusted workspace is
  // downgraded to read-only so the run can still inspect it safely.
  await ensureTrust(context);

  const boot = await bootstrapSession({
    context,
    headlessPolicy: args.permissionPolicy ?? "deny-on-ask",
    ...(args.noDaemon === true ? { noDaemon: true } : {}),
    ...(args.onEvent !== undefined ? { onEvent: (event) => args.onEvent?.(event) } : {}),
  });

  for (const warning of boot.warnings) context.warn(warning);
  if (boot.mockedProvider) context.warn("using the scripted mock provider (CBC_MOCK_PROVIDER)");

  const scan = await warmContext(context, boot.session, { lspHost: boot.lspHost });
  if (scan.warning !== undefined) context.warn(scan.warning);

  const controller = args.signal === undefined ? new AbortController() : undefined;
  const signal = args.signal ?? controller?.signal ?? AbortSignal.abort();
  const onSignal = (): void => controller?.abort();
  if (controller !== undefined) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  let code: ExitCode;
  let finalText = "";
  let payload: FinalStatusPayload;

  try {
    const submitted = await submitTurnOverApp({
      client: boot.appClient,
      sessionId: boot.sessionId,
      prompt,
      signal,
      ...(trigger === undefined ? {} : { idempotencyKey: trigger.idempotencyKey }),
    });
    const result = boot.appClient ? boot.session.snapshotCompletionReport(submitted.answer) : undefined;
    const report = (submitted.report as CompletionReport | undefined) ?? result ?? boot.session.snapshotCompletionReport(submitted.answer);
    const presentation = submitted.presentation as CompletionPresentation | undefined;
    // Headless runs default to the same chat-first contract. `--report`/legacy
    // integrations can continue to call renderReport directly.
    finalText = renderChatResponse(report, submitted.answer, presentation === undefined ? {} : { presentation });
    code = exitForStatus(report.status);
    payload = payloadFromReport(report, code, submitted.turnId, undefined, trigger);
  } catch (error) {
    if (controller !== undefined) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }

    const cliError = error instanceof CliError ? error : undefined;
    code = cliError?.code ?? EXIT.failure;
    finalText = error instanceof Error ? error.message : String(error);
    // A failure can happen after writes and verification records already landed.
    // Preserve the session snapshot instead of publishing a misleading empty list.
    payload = payloadFromReport(
      boot.session.snapshotCompletionReport(finalText),
      code,
      boot.session.viewModel.currentTurnId ?? "turn_failed",
      errorCategory(error),
      trigger,
    );

    context.warn(finalText);
    for (const line of cliError?.detail ?? []) context.warn(line);

    await emitFinal(boot, payload, resultFile, resultJournalFile, context);
    await boot.dispose?.();
    return { code };
  }

  if (controller !== undefined) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  await emitFinal(boot, payload, resultFile, resultJournalFile, context);
  await boot.dispose?.();
  if (finalText.length > 0) context.out(finalText);

  return code === EXIT.ok ? ok() : { code };
}

function payloadFromReport(
  report: CompletionReport,
  exitCode: number,
  turnId: string,
  errorCategory?: string,
  trigger?: TriggerEnvelope,
): FinalStatusPayload {
  return {
    status: report.status,
    exitCode,
    changedFiles: report.changedFiles.map((file) => file.path),
    turnId,
    summary: report.summary,
    commitSha: null,
    evidenceIds: [...(trigger?.evidenceRefs ?? [])],
    verification: report.verification.map((step) => ({ ...step })),
    annotations: [],
    artifacts: [],
    tests: {
      passed: report.verification.filter((step) => step.status === "passed").length,
      failed: report.verification.filter((step) => step.status === "failed").length,
      notRun: report.verification.filter((step) => step.status === "not_run").length,
    },
    ...(report.risks.length > 0 ? { risks: [...report.risks] } : {}),
    ...(errorCategory !== undefined ? { errorCategory } : {}),
  };
}

async function emitFinal(
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  payload: FinalStatusPayload,
  resultFile: string | undefined,
  resultJournalFile: string | undefined,
  context: CommandContext,
): Promise<void> {
  boot.session.emit("run.completed", payload);
  await boot.session.flush();
  await boot.session.snapshot(true);
  if (resultFile !== undefined) {
    try {
      await writeResultFile(resultFile, {
        schemaVersion: "1.0",
        sessionId: boot.sessionId,
        ...payload,
      });
    } catch {
      // Result export is a diagnostic integration boundary. It must never erase
      // the terminal status that the CLI has already journaled and emitted.
      context.warn("could not write machine-readable run result file");
    }
  }
  if (resultJournalFile !== undefined) {
    try {
      const exported = await boot.runtime.exportSession(boot.sessionId);
      await writeAtomicTextFile(resultJournalFile, exported.jsonl);
    } catch {
      // Keep the primary result and terminal exit truth even when a legacy
      // integration cannot collect the session journal.
      context.warn("could not export durable run journal fallback");
    }
  }
}

function resolveResultFile(args: RunArgs): string | undefined {
  const value = args.resultFile ?? process.env.CBC_RUN_RESULT_PATH;
  const path = value?.trim();
  return path && path.length > 0 ? path : undefined;
}

function resolveResultJournalFile(resultFile: string | undefined): string | undefined {
  const configured = process.env.CBC_RUN_JOURNAL_PATH?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return resultFile === undefined ? undefined : `${resultFile}.journal.jsonl`;
}

async function writeResultFile(path: string, payload: ResultFilePayload): Promise<void> {
  await writeAtomicTextFile(path, `${JSON.stringify(payload)}\n`);
}

async function writeAtomicTextFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function errorCategory(error: unknown): string {
  if (error instanceof CliError) return "cli_error";
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  const name = error instanceof Error ? error.name.toLowerCase() : "unknown";
  if (name.includes("timeout")) return "timeout";
  return "unhandled";
}

function resolvePrompt(args: RunArgs, trigger: TriggerEnvelope | undefined): string {
  if (trigger !== undefined && args.prompt !== undefined && args.prompt.trim().length > 0) {
    throw new CliError(EXIT.usage, "capy run accepts either a prompt or --event-file, not both");
  }
  const prompt = trigger?.promptText ?? args.prompt;
  if (prompt === undefined || prompt.trim().length === 0) {
    throw new CliError(EXIT.usage, "capy run needs a prompt", [
      "Try: capy run \"Fix the failing parser test\"",
    ]);
  }
  return prompt.trim();
}

async function resolveTrigger(
  args: RunArgs,
  context: CommandContext,
): Promise<TriggerEnvelope | undefined> {
  if (args.eventFile === undefined) return undefined;
  const content = await context.host.fs.read(args.eventFile);
  if (content === undefined) {
    throw new CliError(EXIT.usage, "integration event file does not exist", [args.eventFile]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CliError(EXIT.usage, "integration event file is not valid JSON");
  }
  let trigger: TriggerEnvelope;
  try {
    trigger = validateTriggerEnvelope(parsed);
  } catch {
    throw new CliError(EXIT.permission, "integration event envelope failed validation");
  }
  if (!trigger.trusted) {
    throw new CliError(EXIT.permission, "untrusted integration triggers are denied in headless runs");
  }
  return trigger;
}
