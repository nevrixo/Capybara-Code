import {
  APP_COMMAND_SCHEMA_VERSION,
  type CommandEnvelope,
  type OperationReceipt,
} from "@cbc/app-protocol";
import {
  validateActionResult,
  type ActionResult,
  type TriggerEnvelope,
} from "@cbc/integration-core";

export interface GitHubActionAppClient {
  readonly clientId: string;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export async function runGitHubActionTurn(input: {
  readonly app: GitHubActionAppClient;
  readonly trigger: TriggerEnvelope;
  readonly sessionId: string;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
}): Promise<ActionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const newId = input.newId ?? ((prefix: string) => prefix + crypto.randomUUID().replaceAll("-", ""));
  const command: CommandEnvelope<{
    prompt: string;
    trigger: TriggerEnvelope;
    headless: true;
  }> = {
    schemaVersion: APP_COMMAND_SCHEMA_VERSION,
    commandId: newId("cmd_github_"),
    idempotencyKey: input.trigger.idempotencyKey,
    correlationId: newId("cor_github_"),
    clientId: input.app.clientId,
    sessionId: input.sessionId,
    issuedAt: now(),
    payload: {
      prompt: input.trigger.promptText,
      trigger: input.trigger,
      headless: true,
    },
  };
  const receipt = await input.app.request<OperationReceipt>("turn.submit", { command });
  const result = optionalRecord(receipt.result);
  const report = optionalRecord(result?.report) ?? result ?? {};
  const status = actionStatus(receipt.status);
  return validateActionResult({
    schemaVersion: "1.0",
    status,
    exitCode: exitCode(status),
    sessionId: input.sessionId,
    turnId: typeof result?.turnId === "string" ? result.turnId : receipt.commandId,
    summary: typeof report.summary === "string" ? report.summary : "Capybara action " + status,
    changedFiles: stringArray(report.changedFiles),
    commitSha: typeof result?.commitSha === "string" ? result.commitSha : null,
    evidenceIds: [...receipt.evidenceIds],
    verification: recordArray(report.verification),
    annotations: recordArray(result?.annotations),
    artifacts: recordArray(result?.artifacts),
  });
}

function actionStatus(status: OperationReceipt["status"]): ActionResult["status"] {
  if (
    status === "completed"
    || status === "partial"
    || status === "failed"
    || status === "cancelled"
    || status === "blocked"
  ) {
    return status;
  }
  return "partial";
}

function exitCode(status: ActionResult["status"]): number {
  if (status === "completed") return 0;
  if (status === "cancelled") return 7;
  if (status === "partial") return 8;
  if (status === "blocked") return 4;
  return 1;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = optionalRecord(entry);
        return record === undefined ? [] : [record];
      })
    : [];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
