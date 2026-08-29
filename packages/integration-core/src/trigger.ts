import { canonicalDigest } from "@cbc/app-protocol";

import { IntegrationContractError } from "./errors.ts";

export interface TriggerEnvelope {
  readonly schemaVersion: "1.0";
  readonly source: "github" | "local";
  readonly eventId: string;
  readonly deliveryId?: string;
  readonly repository: string;
  readonly actor: string;
  readonly actorAssociation?: string;
  readonly event: string;
  readonly ref: string;
  readonly headSha: string;
  readonly trusted: boolean;
  readonly promptText: string;
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
}

export type TriggerEnvelopeInput = Omit<TriggerEnvelope, "schemaVersion" | "idempotencyKey" | "promptText"> & {
  readonly promptText: string;
};

export function createTriggerEnvelope(input: TriggerEnvelopeInput): TriggerEnvelope {
  for (const [name, value] of [
    ["eventId", input.eventId],
    ["repository", input.repository],
    ["actor", input.actor],
    ["event", input.event],
    ["ref", input.ref],
    ["headSha", input.headSha],
  ] as const) {
    requireBoundedText(name, value, 512);
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(input.repository)) {
    throw new IntegrationContractError(
      "INTEGRATION_TRIGGER_INVALID",
      "repository must use owner/name form",
    );
  }
  if (!/^[a-f0-9]{40,64}$/iu.test(input.headSha)) {
    throw new IntegrationContractError(
      "INTEGRATION_TRIGGER_INVALID",
      "headSha must be an immutable hexadecimal revision",
    );
  }
  const promptText = normalizeTriggerPrompt(input.promptText);
  const delivery = input.deliveryId ?? input.eventId;
  const idempotencyKey = canonicalDigest([
    input.source,
    input.repository.toLowerCase(),
    delivery,
    input.headSha.toLowerCase(),
    promptText,
  ]);
  return Object.freeze({
    schemaVersion: "1.0",
    source: input.source,
    eventId: input.eventId,
    ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
    repository: input.repository,
    actor: input.actor,
    ...(input.actorAssociation === undefined
      ? {}
      : { actorAssociation: input.actorAssociation }),
    event: input.event,
    ref: input.ref,
    headSha: input.headSha.toLowerCase(),
    trusted: input.trusted,
    promptText,
    evidenceRefs: Object.freeze([...new Set(input.evidenceRefs)]),
    idempotencyKey,
  });
}

export type HeadlessPermissionPolicy = "deny-on-ask" | "allow-listed" | "fail-on-ask";

export type HeadlessApprovalDecision =
  | { readonly decision: "deny"; readonly exitCode: 0; readonly adapt: true }
  | { readonly decision: "allow"; readonly exitCode: 0; readonly adapt: false }
  | { readonly decision: "fail"; readonly exitCode: 4; readonly adapt: false };

export function resolveHeadlessApproval(input: {
  readonly policy: HeadlessPermissionPolicy;
  readonly actionKey: string;
  readonly allowList?: readonly string[];
}): HeadlessApprovalDecision {
  requireBoundedText("actionKey", input.actionKey, 1024);
  if (input.policy === "fail-on-ask") {
    return Object.freeze({ decision: "fail", exitCode: 4, adapt: false });
  }
  if (input.policy === "allow-listed" && (input.allowList ?? []).includes(input.actionKey)) {
    return Object.freeze({ decision: "allow", exitCode: 0, adapt: false });
  }
  return Object.freeze({ decision: "deny", exitCode: 0, adapt: true });
}

export interface ActionResult {
  readonly schemaVersion: "1.0";
  readonly status: "completed" | "partial" | "failed" | "cancelled" | "blocked";
  readonly exitCode: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly commitSha: string | null;
  readonly evidenceIds: readonly string[];
  readonly verification: readonly Readonly<Record<string, unknown>>[];
  readonly annotations: readonly Readonly<Record<string, unknown>>[];
  readonly artifacts: readonly Readonly<Record<string, unknown>>[];
}

export function validateActionResult(value: ActionResult): ActionResult {
  requireBoundedText("sessionId", value.sessionId, 256);
  requireBoundedText("turnId", value.turnId, 256);
  requireBoundedText("summary", value.summary, 64 * 1024);
  if (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) {
    throw new IntegrationContractError(
      "INTEGRATION_TRIGGER_INVALID",
      "action result exitCode must be between 0 and 255",
    );
  }
  if (new Set(value.changedFiles).size !== value.changedFiles.length) {
    throw new IntegrationContractError(
      "INTEGRATION_TRIGGER_INVALID",
      "action result changedFiles must not contain duplicates",
    );
  }
  return Object.freeze({
    ...value,
    changedFiles: Object.freeze([...value.changedFiles]),
    evidenceIds: Object.freeze([...value.evidenceIds]),
    verification: Object.freeze([...value.verification]),
    annotations: Object.freeze([...value.annotations]),
    artifacts: Object.freeze([...value.artifacts]),
  });
}

export function normalizeTriggerPrompt(prompt: string): string {
  const normalized = prompt
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  requireBoundedText("promptText", normalized, 64 * 1024);
  return normalized;
}

function requireBoundedText(name: string, value: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new IntegrationContractError(
      "INTEGRATION_TRIGGER_INVALID",
      name + " must be non-empty, trimmed, and bounded",
    );
  }
}
