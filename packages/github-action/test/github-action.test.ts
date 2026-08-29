import { describe, expect, test } from "bun:test";

import type { OperationReceipt } from "@cbc/app-protocol";
import {
  createTriggerEnvelope,
  type ActionResult,
} from "@cbc/integration-core";

import {
  GitHubTriggerError,
  GitHubWriteCoordinator,
  InMemoryGitHubSideEffectJournal,
  parseGitHubTrigger,
  runGitHubActionTurn,
  type GitHubWriter,
} from "../src/index.ts";

const SHA = "a".repeat(40);

function issueCommentPayload(body = "/capy fix the parser") {
  return {
    repository: { full_name: "nevrixo/capybara-code" },
    comment: {
      id: 42,
      body,
      author_association: "MEMBER",
    },
    issue: { number: 7 },
    installation: { token: "ghs_must_not_cross_the_boundary" },
    sender: { login: "maintainer" },
  };
}

function trustedTrigger() {
  return createTriggerEnvelope({
    source: "github",
    eventId: "issue_comment:42",
    deliveryId: "delivery_1",
    repository: "nevrixo/capybara-code",
    actor: "maintainer",
    actorAssociation: "MEMBER",
    event: "issue_comment",
    ref: "refs/heads/develop",
    headSha: SHA,
    trusted: true,
    promptText: "fix the parser",
    evidenceRefs: ["github:comment:42"],
  });
}

function completedResult(changedFiles: readonly string[] = ["src/parser.ts"]): ActionResult {
  return {
    schemaVersion: "1.0",
    status: "completed",
    exitCode: 0,
    sessionId: "session_1",
    turnId: "turn_1",
    summary: "Fixed the parser",
    changedFiles,
    commitSha: null,
    evidenceIds: ["evidence_1"],
    verification: [{ status: "passed", command: "bun test" }],
    annotations: [],
    artifacts: [],
  };
}

describe("GitHub trigger admission", () => {
  test("derives a stable minimal envelope for delivery retries", () => {
    const input = {
      eventName: "issue_comment",
      deliveryId: "delivery_1",
      repository: "nevrixo/capybara-code",
      actor: "maintainer",
      ref: "refs/heads/develop",
      sha: SHA,
      payload: issueCommentPayload(),
    };
    const first = parseGitHubTrigger(input);
    const retry = parseGitHubTrigger(input);
    expect(first.envelope.idempotencyKey).toBe(retry.envelope.idempotencyKey);
    expect(first.envelope.promptText).toBe("fix the parser");
    expect(first.envelope.evidenceRefs).toEqual([
      "github:comment:42",
      "github:issue:7",
    ]);
    expect(JSON.stringify(first.envelope)).not.toContain("ghs_must_not_cross_the_boundary");
    expect(JSON.stringify(first.envelope)).not.toContain("installation");
  });

  test("marks fork review comments untrusted even for a member actor", () => {
    const parsed = parseGitHubTrigger({
      eventName: "pull_request_review_comment",
      deliveryId: "delivery_fork",
      repository: "nevrixo/capybara-code",
      actor: "maintainer",
      ref: "refs/pull/5/head",
      sha: SHA,
      payload: {
        repository: { full_name: "nevrixo/capybara-code" },
        comment: {
          id: 99,
          body: "/capy review this",
          author_association: "MEMBER",
        },
        pull_request: {
          number: 5,
          head: {
            sha: "b".repeat(40),
            ref: "feature",
            repo: { full_name: "contributor/fork" },
          },
        },
      },
    }, { admitUntrusted: true });
    expect(parsed.fork).toBe(true);
    expect(parsed.envelope.trusted).toBe(false);
    expect(parsed.envelope.headSha).toBe("b".repeat(40));
  });

  test("rejects commands from untrusted actors by default", () => {
    const payload = issueCommentPayload();
    payload.comment.author_association = "NONE";
    expect(() => parseGitHubTrigger({
      eventName: "issue_comment",
      deliveryId: "delivery_untrusted",
      repository: "nevrixo/capybara-code",
      actor: "stranger",
      ref: "refs/heads/develop",
      sha: SHA,
      payload,
    })).toThrow(GitHubTriggerError);
  });
});

describe("GitHub write coordinator", () => {
  test("reconciles concurrent delivery retries without duplicate side effects", async () => {
    let comments = 0;
    let commits = 0;
    let pullRequests = 0;
    const writer: GitHubWriter = {
      async comment() {
        comments += 1;
        await Promise.resolve();
        return { id: "comment_1" };
      },
      async commit(input) {
        commits += 1;
        expect(input.expectedHeadSha).toBe(SHA);
        return { sha: "c".repeat(40) };
      },
      async pullRequest(input) {
        pullRequests += 1;
        expect(input.headSha).toBe("c".repeat(40));
        return { number: 10 };
      },
    };
    const coordinator = new GitHubWriteCoordinator({
      writer,
      journal: new InMemoryGitHubSideEffectJournal(),
      policy: {
        comment: true,
        commit: true,
        pullRequest: true,
        now: () => "2026-08-30T00:00:00.000Z",
      },
    });
    const [first, retry] = await Promise.all([
      coordinator.reconcile(trustedTrigger(), completedResult()),
      coordinator.reconcile(trustedTrigger(), completedResult()),
    ]);
    expect(first).toEqual(retry);
    expect(comments).toBe(1);
    expect(commits).toBe(1);
    expect(pullRequests).toBe(1);
  });

  test("fails closed on workflow mutations and untrusted commit attempts", async () => {
    const writer: GitHubWriter = {
      async comment() { return { id: "comment_1" }; },
      async commit() { return { sha: "c".repeat(40) }; },
    };
    const coordinator = new GitHubWriteCoordinator({
      writer,
      journal: new InMemoryGitHubSideEffectJournal(),
      policy: { commit: true },
    });
    await expect(coordinator.reconcile(
      trustedTrigger(),
      completedResult([".github/workflows/release.yml"]),
    )).rejects.toThrow("workflow");
    await expect(coordinator.reconcile(
      { ...trustedTrigger(), trusted: false },
      completedResult(),
    )).rejects.toThrow("untrusted");
  });
});

describe("GitHub headless runner", () => {
  test("uses the trigger digest as the turn idempotency key and emits a canonical result", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const result = await runGitHubActionTurn({
      app: {
        clientId: "client_ci",
        async request<T>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          return {
            schemaVersion: "1.0",
            receiptId: "receipt_1",
            commandId: "command_1",
            idempotencyKey: trustedTrigger().idempotencyKey,
            status: "completed",
            startedAt: "2026-08-30T00:00:00.000Z",
            finishedAt: "2026-08-30T00:00:01.000Z",
            evidenceIds: ["evidence_1"],
            result: {
              turnId: "turn_1",
              report: {
                summary: "Fixed parser",
                changedFiles: ["src/parser.ts"],
                verification: [{ status: "passed" }],
              },
            },
          } satisfies OperationReceipt as T;
        },
      },
      trigger: trustedTrigger(),
      sessionId: "session_1",
      now: () => "2026-08-30T00:00:00.000Z",
      newId: (prefix) => prefix + "fixed",
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.method).toBe("turn.submit");
    expect(JSON.stringify(calls[0]?.params)).toContain(trustedTrigger().idempotencyKey);
  });
});
