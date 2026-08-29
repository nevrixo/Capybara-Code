import { describe, expect, test } from "bun:test";

import {
  APP_CAPABILITY_SCHEMA_REVISION,
  APP_METHODS,
  APP_PROTOCOL_VERSION,
  finalizeCapabilitySnapshot,
  type AppMethodCapability,
  type EventReplayResult,
} from "@cbc/app-protocol";

import {
  EventReplayProjector,
  IntegrationContractError,
  ReconnectStateMachine,
  createEditorContextAttachment,
  createTriggerEnvelope,
  digestText,
  projectApproval,
  projectEditReceipt,
  resolveHeadlessApproval,
  validateTriggerEnvelope,
} from "../src/index.ts";

function capabilitySnapshot() {
  const methods = Object.fromEntries(
    APP_METHODS.map((method) => [method, { state: "available" } satisfies AppMethodCapability]),
  ) as Record<(typeof APP_METHODS)[number], AppMethodCapability>;
  return finalizeCapabilitySnapshot({
    protocolVersion: APP_PROTOCOL_VERSION,
    schemaRevision: APP_CAPABILITY_SCHEMA_REVISION,
    serverVersion: "0.1.0",
    transport: "stdio",
    methods,
    events: {
      replay: true,
      ack: true,
      snapshots: false,
      maxBatchEvents: 64,
      maxBatchBytes: 65_536,
    },
    presentation: {
      richDiff: true,
      inlineApprovals: true,
      taskTree: true,
      planReview: true,
      artifacts: true,
    },
  });
}

function replay(): EventReplayResult {
  return {
    subscription: {
      id: "sub_1",
      clientId: "client_1",
      sessionId: "ses_1",
      state: "active",
      lastAckedSequence: 0,
    },
    cursor: { sessionId: "ses_1", journalSequence: 2 },
    events: [
      {
        schemaVersion: "1.0",
        sequence: 1,
        id: "evt_1",
        timestamp: "2026-08-30T00:00:00.000Z",
        sessionId: "ses_1",
        kind: "turn.started",
        level: "info",
        visibility: "session",
        durability: "journaled",
        payload: {},
      },
      {
        schemaVersion: "1.0",
        sequence: 2,
        id: "evt_2",
        timestamp: "2026-08-30T00:00:01.000Z",
        sessionId: "ses_1",
        kind: "assistant.final",
        level: "info",
        visibility: "session",
        durability: "journaled",
        payload: { text: "done" },
      },
    ],
    hasMore: false,
  };
}

describe("integration reconnect and replay", () => {
  test("retains the durable ACK across a transport reconnect", () => {
    const machine = new ReconnectStateMachine();
    machine.beginConnect();
    machine.initialize({ connectionId: "conn_1", capabilitySnapshot: capabilitySnapshot() });
    machine.attach("ses_1", { sessionId: "ses_1", journalSequence: 4 });
    machine.disconnected("transport closed");
    machine.beginConnect();
    machine.initialize({ connectionId: "conn_2", capabilitySnapshot: capabilitySnapshot() });
    expect(machine.beginReplay()).toEqual({ sessionId: "ses_1", journalSequence: 4 });
    machine.completeReplay("complete");
    expect(machine.snapshot.phase).toBe("ready");
    expect(machine.snapshot.lastAckedCursor?.journalSequence).toBe(4);
  });

  test("projects a replay page exactly once and advances ACK monotonically", () => {
    const projector = new EventReplayProjector("ses_1");
    const first = projector.apply(replay());
    const retry = projector.apply(replay());
    expect(first.events.map((event) => event.id)).toEqual(["evt_1", "evt_2"]);
    expect(retry.events).toHaveLength(0);
    expect(retry.duplicateCount).toBe(2);
    projector.acknowledge(first.cursor);
    expect(projector.checkpoint.lastAckedSequence).toBe(2);
    expect(() => projector.acknowledge({ sessionId: "ses_1", journalSequence: 1 }))
      .toThrow(IntegrationContractError);
  });
});

describe("editor context and review projection", () => {
  test("includes bounded unsaved text and rejects secret-bearing selections", () => {
    const text = "const answer = 42;";
    const attachment = createEditorContextAttachment({
      workspaceIdentityDigest: "sha256:" + "a".repeat(64),
      uri: "file:///workspace/src/main.ts",
      documentRevision: "rev_1",
      languageId: "typescript",
      source: "unsaved",
      selection: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: text.length },
      selectedText: text,
      textDigest: digestText(text),
    });
    expect(attachment.text).toBe(text);
    expect(attachment.textOmitted).toBe(false);
    expect(() => createEditorContextAttachment({
      workspaceIdentityDigest: "ws_1",
      uri: "file:///workspace/.env",
      documentRevision: "rev_1",
      languageId: "dotenv",
      source: "disk",
      textDigest: digestText(""),
    })).toThrow(IntegrationContractError);
  });

  test("makes stale and partial edit receipts non-applicable", () => {
    const stale = projectEditReceipt({
      receiptId: "receipt_1",
      status: "completed",
      workspaceRevisionBefore: 3,
      workspaceRevisionAfter: 4,
      operations: [{
        operationId: "op_1",
        kind: "modify",
        path: "src/main.ts",
        patch: "@@ -1 +1 @@",
      }],
    }, 2);
    expect(stale.stale).toBe(true);
    expect(stale.applyAllowed).toBe(false);

    const partial = projectEditReceipt({
      receiptId: "receipt_2",
      status: "partial",
      workspaceRevisionBefore: 3,
      operations: [{
        operationId: "op_2",
        kind: "modify",
        path: "src/main.ts",
        patch: "@@ -1 +1 @@",
      }],
    }, 3);
    expect(partial.applyAllowed).toBe(false);
    expect(partial.reason).toContain("new plan");
  });

  test("approval projections reveal only a bounded action hash preview", () => {
    const card = projectApproval({
      approvalId: "approval_1",
      tool: "process.run",
      action: "run tests",
      command: "bun test",
      cwd: "C:/workspace",
      writePaths: [],
      networkDestinations: [],
      risk: "R2",
      reason: "verification",
      offeredScopes: ["once", "turn"],
      actionHash: "sha256:" + "b".repeat(64),
    });
    expect(card.actionHashPreview).toHaveLength(18);
    expect("actionHash" in card).toBe(false);
  });
});

describe("trigger and headless policy", () => {
  test("normalizes commands before deriving the delivery idempotency key", () => {
    const base = {
      source: "github" as const,
      eventId: "event_1",
      deliveryId: "delivery_1",
      repository: "nevrixo/capybara-code",
      actor: "maintainer",
      actorAssociation: "MEMBER",
      event: "issue_comment",
      ref: "refs/heads/develop",
      headSha: "a".repeat(40),
      trusted: true,
      evidenceRefs: ["github:event_1"],
    };
    const first = createTriggerEnvelope({ ...base, promptText: "/capy fix this  \r\n" });
    const retry = createTriggerEnvelope({ ...base, promptText: "/capy fix this" });
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
  });

  test("never waits interactively in headless permission modes", () => {
    expect(resolveHeadlessApproval({
      policy: "fail-on-ask",
      actionKey: "process:bun-test",
    })).toEqual({ decision: "fail", exitCode: 4, adapt: false });
    expect(resolveHeadlessApproval({
      policy: "allow-listed",
      actionKey: "process:bun-test",
      allowList: ["process:bun-test"],
    }).decision).toBe("allow");
    expect(resolveHeadlessApproval({
      policy: "deny-on-ask",
      actionKey: "network:example.com",
    }).decision).toBe("deny");
  });

  test("rejects raw or tampered event files instead of treating them as trigger envelopes", () => {
    const trigger = createTriggerEnvelope({
      source: "github",
      eventId: "event_1",
      deliveryId: "delivery_1",
      repository: "nevrixo/capybara-code",
      actor: "maintainer",
      event: "issue_comment",
      ref: "refs/heads/develop",
      headSha: "a".repeat(40),
      trusted: true,
      promptText: "fix parser",
      evidenceRefs: [],
    });
    expect(validateTriggerEnvelope(trigger)).toEqual(trigger);
    expect(() => validateTriggerEnvelope({
      ...trigger,
      idempotencyKey: "sha256:" + "b".repeat(64),
    })).toThrow(IntegrationContractError);
    expect(() => validateTriggerEnvelope({
      ...trigger,
      rawPayload: { token: "secret" },
    })).toThrow(IntegrationContractError);
  });
});
