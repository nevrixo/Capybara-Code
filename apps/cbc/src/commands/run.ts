/** Headless capy run entry point. */

import { renderReport } from "@cbc/agent-kernel";

import { bootstrapSession, warmContext } from "../bootstrap.ts";
import { CliError, EXIT, exitForStatus, type ExitCode } from "../exit.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";
import { ensureTrust } from "../workspace-trust.ts";

export interface RunArgs {
  readonly prompt?: string;
}

interface FinalStatusPayload {
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  readonly exitCode: number;
  readonly changedFiles: string[];
  readonly tests?: { passed: number; failed: number; notRun: number };
  readonly risks?: string[];
}

export async function run(context: CommandContext, args: RunArgs): Promise<CommandResult> {
  const prompt = resolvePrompt(args);

  // A non-interactive run never prompts for trust. An untrusted workspace is
  // downgraded to read-only so the run can still inspect it safely.
  await ensureTrust(context);

  const boot = await bootstrapSession({
    context,
    headlessPolicy: "deny-on-ask",
  });

  for (const warning of boot.warnings) context.warn(warning);
  if (boot.mockedProvider) context.warn("using the scripted mock provider (CBC_MOCK_PROVIDER)");

  const scan = await warmContext(context, boot.session, { lspHost: boot.lspHost });
  if (scan.warning !== undefined) context.warn(scan.warning);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let code: ExitCode;
  let finalText = "";
  let payload: FinalStatusPayload;

  try {
    const result = await boot.session.submit(prompt, controller.signal);
    const report = result.report;
    finalText = renderReport(report, result.answer);
    code = exitForStatus(report.status);

    payload = {
      status: report.status,
      exitCode: code,
      changedFiles: report.changedFiles.map((file) => file.path),
      tests: {
        passed: report.verification.filter((step) => step.status === "passed").length,
        failed: report.verification.filter((step) => step.status === "failed").length,
        notRun: report.verification.filter((step) => step.status === "not_run").length,
      },
      ...(report.risks.length > 0 ? { risks: [...report.risks] } : {}),
    };
  } catch (error) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    const cliError = error instanceof CliError ? error : undefined;
    code = cliError?.code ?? EXIT.failure;
    finalText = error instanceof Error ? error.message : String(error);
    payload = { status: "failed", exitCode: code, changedFiles: [] };

    context.warn(finalText);
    for (const line of cliError?.detail ?? []) context.warn(line);

    await emitFinal(boot, payload);
    await boot.dispose?.();
    return { code };
  }

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  await emitFinal(boot, payload);
  await boot.dispose?.();
  context.out(finalText);

  return code === EXIT.ok ? ok() : { code };
}

async function emitFinal(
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  payload: FinalStatusPayload,
): Promise<void> {
  boot.session.emit("run.completed", payload);
  await boot.session.flush();
  await boot.session.snapshot(true);
}

function resolvePrompt(args: RunArgs): string {
  if (args.prompt === undefined || args.prompt.trim().length === 0) {
    throw new CliError(EXIT.usage, "capy run needs a prompt", [
      "Try: capy run \"Fix the failing parser test\"",
    ]);
  }
  return args.prompt.trim();
}