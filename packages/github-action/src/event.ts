import { createTriggerEnvelope, type TriggerEnvelope } from "@cbc/integration-core";

export class GitHubTriggerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubTriggerError";
    this.code = code;
  }
}

export interface GitHubTriggerPolicy {
  readonly commandPrefix?: string;
  readonly allowedAssociations?: readonly string[];
  readonly trustedActors?: readonly string[];
  readonly allowForks?: boolean;
  readonly admitUntrusted?: boolean;
  readonly schedulePrompt?: string;
}

export interface GitHubEventInput {
  readonly eventName: string;
  readonly deliveryId: string;
  readonly repository: string;
  readonly actor: string;
  readonly ref: string;
  readonly sha: string;
  readonly payload: unknown;
}

export interface ParsedGitHubTrigger {
  readonly envelope: TriggerEnvelope;
  readonly fork: boolean;
  readonly actorAssociation?: string;
}

const DEFAULT_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

/**
 * Converts a provider payload into a small, fixed-shape envelope. PR bodies,
 * repository files, tokens, and unknown payload fields never cross this boundary.
 */
export function parseGitHubTrigger(
  input: GitHubEventInput,
  policy: GitHubTriggerPolicy = {},
): ParsedGitHubTrigger {
  const payload = record(input.payload, "GitHub event payload");
  const association = eventAssociation(input.eventName, payload);
  const prompt = eventPrompt(input.eventName, payload, policy);
  const headSha = eventHeadSha(input.eventName, payload) ?? input.sha;
  const repository = eventRepository(payload) ?? input.repository;
  const fork = isForkEvent(input.eventName, payload, repository);
  const associationTrusted = (policy.allowedAssociations ?? DEFAULT_ASSOCIATIONS)
    .includes((association ?? "").toUpperCase());
  const actorTrusted = (policy.trustedActors ?? []).includes(input.actor);
  const scheduleTrusted = input.eventName === "schedule" && policy.schedulePrompt !== undefined;
  const trusted = (associationTrusted || actorTrusted || scheduleTrusted)
    && (!fork || policy.allowForks === true);
  if (!trusted && policy.admitUntrusted !== true) {
    throw new GitHubTriggerError(
      "GITHUB_TRIGGER_UNTRUSTED",
      fork
        ? "fork event is not admitted by GitHub trigger policy"
        : "actor is not admitted by GitHub trigger policy",
    );
  }
  const evidenceRefs = eventEvidenceRefs(input.eventName, payload);
  const envelope = createTriggerEnvelope({
    source: "github",
    eventId: eventId(input.eventName, payload, input.deliveryId),
    deliveryId: input.deliveryId,
    repository,
    actor: input.actor,
    ...(association === undefined ? {} : { actorAssociation: association }),
    event: input.eventName,
    ref: eventRef(input.eventName, payload) ?? input.ref,
    headSha,
    trusted,
    promptText: prompt,
    evidenceRefs,
  });
  return Object.freeze({
    envelope,
    fork,
    ...(association === undefined ? {} : { actorAssociation: association }),
  });
}

function eventPrompt(
  eventName: string,
  payload: Record<string, unknown>,
  policy: GitHubTriggerPolicy,
): string {
  if (eventName === "schedule") {
    if (policy.schedulePrompt === undefined) {
      throw new GitHubTriggerError(
        "GITHUB_TRIGGER_PROMPT_MISSING",
        "scheduled events require a policy-owned prompt",
      );
    }
    return policy.schedulePrompt;
  }
  if (eventName === "workflow_dispatch") {
    const inputs = optionalRecord(payload.inputs);
    const prompt = inputs?.prompt;
    if (typeof prompt !== "string") {
      throw new GitHubTriggerError(
        "GITHUB_TRIGGER_PROMPT_MISSING",
        "workflow_dispatch requires inputs.prompt",
      );
    }
    return prompt;
  }
  const comment = optionalRecord(payload.comment);
  const body = comment?.body;
  if (typeof body !== "string") {
    throw new GitHubTriggerError(
      "GITHUB_TRIGGER_PROMPT_MISSING",
      "GitHub comment event does not contain comment.body",
    );
  }
  const prefix = policy.commandPrefix ?? "/capy";
  const trimmed = body.trim();
  if (trimmed !== prefix && !trimmed.startsWith(prefix + " ")) {
    throw new GitHubTriggerError(
      "GITHUB_TRIGGER_COMMAND_MISSING",
      "comment does not start with the configured Capybara command",
    );
  }
  const command = trimmed.slice(prefix.length).trim();
  if (command.length === 0) {
    throw new GitHubTriggerError(
      "GITHUB_TRIGGER_PROMPT_MISSING",
      "Capybara comment command requires a prompt",
    );
  }
  return command;
}

function eventAssociation(eventName: string, payload: Record<string, unknown>): string | undefined {
  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    const comment = optionalRecord(payload.comment);
    return typeof comment?.author_association === "string"
      ? comment.author_association.toUpperCase()
      : undefined;
  }
  const sender = optionalRecord(payload.sender);
  return typeof sender?.author_association === "string"
    ? sender.author_association.toUpperCase()
    : undefined;
}

function eventHeadSha(eventName: string, payload: Record<string, unknown>): string | undefined {
  if (
    eventName === "pull_request"
    || eventName === "pull_request_review"
    || eventName === "pull_request_review_comment"
  ) {
    const pull = optionalRecord(payload.pull_request);
    const head = optionalRecord(pull?.head);
    return typeof head?.sha === "string" ? head.sha : undefined;
  }
  return typeof payload.after === "string" ? payload.after : undefined;
}

function eventRef(eventName: string, payload: Record<string, unknown>): string | undefined {
  if (eventName.startsWith("pull_request")) {
    const pull = optionalRecord(payload.pull_request);
    const head = optionalRecord(pull?.head);
    return typeof head?.ref === "string" ? "refs/heads/" + head.ref : undefined;
  }
  return typeof payload.ref === "string" ? payload.ref : undefined;
}

function eventRepository(payload: Record<string, unknown>): string | undefined {
  const repository = optionalRecord(payload.repository);
  return typeof repository?.full_name === "string" ? repository.full_name : undefined;
}

function isForkEvent(eventName: string, payload: Record<string, unknown>, repository: string): boolean {
  if (eventName === "issue_comment" && optionalRecord(optionalRecord(payload.issue)?.pull_request) !== undefined) {
    // issue_comment does not carry the immutable PR head repository. Treat that
    // ambiguity like a fork until a trusted coordinator resolves the PR first.
    return true;
  }
  if (!eventName.startsWith("pull_request")) return false;
  const pull = optionalRecord(payload.pull_request);
  const head = optionalRecord(pull?.head);
  const headRepo = optionalRecord(head?.repo);
  return typeof headRepo?.full_name === "string" && headRepo.full_name !== repository;
}

function eventEvidenceRefs(
  eventName: string,
  payload: Record<string, unknown>,
): readonly string[] {
  const refs: string[] = [];
  const comment = optionalRecord(payload.comment);
  const issue = optionalRecord(payload.issue);
  const pull = optionalRecord(payload.pull_request);
  if (typeof comment?.id === "number" || typeof comment?.id === "string") {
    refs.push("github:comment:" + String(comment.id));
  }
  if (typeof issue?.number === "number") refs.push("github:issue:" + String(issue.number));
  if (typeof pull?.number === "number") refs.push("github:pull:" + String(pull.number));
  if (refs.length === 0) refs.push("github:event:" + eventName);
  return refs;
}

function eventId(eventName: string, payload: Record<string, unknown>, deliveryId: string): string {
  const comment = optionalRecord(payload.comment);
  if (typeof comment?.id === "number" || typeof comment?.id === "string") {
    return eventName + ":" + String(comment.id);
  }
  return eventName + ":" + deliveryId;
}

function record(value: unknown, name: string): Record<string, unknown> {
  const parsed = optionalRecord(value);
  if (parsed === undefined) throw new GitHubTriggerError("GITHUB_TRIGGER_INVALID", name + " must be an object");
  return parsed;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
