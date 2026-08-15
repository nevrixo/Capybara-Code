/**
 * `capy run` — PRD §8.3, §8.9, §13.8, §20.10, AC-37, AC-38, G8.
 *
 * Three contracts hold simultaneously here and each one is checkable:
 *
 *   - §8.3: no interactive prompt ever appears. The approval broker is the headless
 *     one, `user.ask` has no bridge, and the trust prompt is skipped in favour of
 *     read-only.
 *   - §20.10 / AC-37: with `--jsonl`, stdout carries nothing but event lines. Every
 *     diagnostic in this file goes through `context.warn`, which writes to stderr.
 *   - §8.9: the process exit code and the final status event carry the same value.
 *     They are computed once, from one place, so they cannot disagree.
 */

import { renderReport } from "@cbc/agent-kernel";

import { bootstrapSession, warmContext } from "../bootstrap.ts";
import { CliError, EXIT, exitForStatus, type ExitCode } from "../exit.ts";
import { JsonlWriter, type FinalStatusPayload } from "../output.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";
import { ensureTrust } from "./trust.ts";

export interface RunArgs {
  readonly prompt?: string;
  readonly stdin: boolean;
  readonly jsonl: boolean;
  readonly output?: string;
  readonly permission?: "deny-on-ask" | "allow-listed" | "fail-on-ask" | "deny" | "allow-listed" | "fail";
  readonly readOnly?: boolean;
  readonly model?: string;
  readonly reasoning?: string;
  readonly reasoningMode?: string;
  readonly mode?: string;
  readonly interactionMode?: "build" | "plan";
  readonly permissionPreset?: "read" | "edit" | "auto" | "yolo";
  readonly review?: "off" | "auto";
  readonly resume?: string;
}

export async function run(context: CommandContext, args: RunArgs): Promise<CommandResult> {
  const prompt = await resolvePrompt(context, args);

  // §13.8 step 0: a non-interactive run never asks about trust. `ensureTrust`
  // downgrades to read-only instead, so the run can still read a repository it was
  // pointed at without gaining write authority over it.
  await ensureTrust(context);

  const jsonl = args.jsonl
    ? new JsonlWriter({ host: context.host, sessionId: "pending" })
    : undefined;

  const boot = await bootstrapSession({
    context,
    overrides: {
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.reasoning !== undefined ? { reasoningEffort: args.reasoning } : {}),
      ...(args.reasoningMode !== undefined ? { reasoningMode: args.reasoningMode } : {}),
        ...(args.mode !== undefined ? { permissionMode: args.mode } : {}),
        ...(args.interactionMode !== undefined ? { interactionMode: args.interactionMode } : {}),
        ...(args.permissionPreset !== undefined ? { permissionPreset: args.permissionPreset } : {}),
        ...(args.review !== undefined ? { reviewMode: args.review } : {}),
    },
    ...(args.readOnly === true ? { readOnly: true } : {}),
    // §13.8: `deny-on-ask` is the default because it lets the model observe the
    // denial and adapt, which produces a useful partial result more often than
    // aborting the run does.
    headlessPolicy: ((args.permission === "deny" ? "deny-on-ask" : args.permission === "fail" ? "fail-on-ask" : args.permission) ?? "deny-on-ask") as "deny-on-ask" | "allow-listed" | "fail-on-ask",
    ...(args.resume !== undefined ? { resume: args.resume } : {}),
    onEvent: (event) => {
      if (jsonl === undefined) return;
      // The writer owns its own sequencer for §20.10 monotonicity; forwarding the
      // already-built envelope keeps the two streams identical in content.
      jsonl.forward(event);
    },
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

    // A `fail-on-ask` policy raises `CliError` with code 4 (AC-38). It has to reach
    // the final status event too, so it is converted rather than rethrown.
    const cliError = error instanceof CliError ? error : undefined;
    code = cliError?.code ?? EXIT.failure;
    finalText = error instanceof Error ? error.message : String(error);
    payload = { status: "failed", exitCode: code, changedFiles: [] };

    context.warn(finalText);
    for (const line of cliError?.detail ?? []) context.warn(line);

    await emitFinal(boot, payload);
    await writeOutputFile(context, args, finalText);
    await boot.dispose?.();
    return { code };
  }

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  await emitFinal(boot, payload);
  await writeOutputFile(context, args, finalText);
  await boot.dispose?.();

  if (jsonl === undefined) {
    // Without `--jsonl` the report itself is the answer, so it goes to stdout.
    context.out(finalText);
  }

  return code === EXIT.ok ? ok() : { code };
}

/**
 * §8.9: the final status event carries the same code as the process.
 *
 * Emitted through the session so it is journaled, reduced, and forwarded to the JSONL
 * stream by the same sink as every other event — which is what keeps the stream's last
 * line and the process exit code in agreement.
 *
 * The kernel has already emitted this turn's single `turn.completed`; the headless
 * process status is a separate `run.completed` event so the journal never carries
 * two completion events for one turn.
 */
async function emitFinal(
  boot: Awaited<ReturnType<typeof bootstrapSession>>,
  payload: FinalStatusPayload,
): Promise<void> {
  boot.session.emit("run.completed", payload);
  await boot.session.flush();
  await boot.session.snapshot(true);
}

async function writeOutputFile(
  context: CommandContext,
  args: RunArgs,
  finalText: string,
): Promise<void> {
  if (args.output === undefined) return;
  await context.host.fs.write(
    args.output,
    finalText.endsWith("\n") ? finalText : `${finalText}\n`,
  );
  context.warn(`wrote ${args.output}`);
}

/**
 * Where the prompt comes from.
 *
 * §8.3 shows both `capy run "text"` and `printf ... | capy run --stdin`. Supplying both
 * is a usage error rather than a silent preference: a script that does it is wrong
 * about one of them, and guessing hides the bug.
 */
async function resolvePrompt(context: CommandContext, args: RunArgs): Promise<string> {
  if (args.stdin && args.prompt !== undefined) {
    throw new CliError(EXIT.usage, "pass the prompt as an argument or with --stdin, not both");
  }
  if (args.stdin) {
    const text = (await context.host.io.readStdin()).trim();
    if (text.length === 0) throw new CliError(EXIT.usage, "--stdin was given but stdin was empty");
    return text;
  }
  if (args.prompt === undefined || args.prompt.trim().length === 0) {
    throw new CliError(EXIT.usage, "capy run needs a prompt", [
      'Try: capy run "Fix the failing parser test"',
      "Or pipe one: printf '%s' \"$TASK\" | capy run --stdin",
    ]);
  }
  return args.prompt.trim();
}
