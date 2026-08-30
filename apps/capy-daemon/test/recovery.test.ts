import { describe, expect, test } from "bun:test";

import { ApprovalManager } from "../src/approval-manager.ts";
import { EventHub } from "../src/event-hub.ts";
import { persistRecoveryState, recoverDaemonState } from "../src/recovery.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSupervisorRegistry } from "../src/workspace-supervisor.ts";

describe("daemon crash recovery", () => {
  test("reconciles an open turn as interrupted without duplicating work", async () => {
    const recovered = await recoverDaemonState({
      workspaces: new WorkspaceSupervisorRegistry(),
      approvals: new ApprovalManager(),
      eventHub: new EventHub(),
      now: () => "2026-08-25T00:00:00.000Z",
      sessions: [
        {
          sessionId: "ses_1",
          workspaceIdentityDigest: "ws_1",
          lastJournalSequence: 12,
          hadOpenTurn: true,
        },
        {
          sessionId: "ses_2",
          workspaceIdentityDigest: "ws_1",
          lastJournalSequence: 4,
        },
      ],
    });
    expect(recovered.interruptedTurns).toBe(1);
    expect(recovered.ownerEpochBump).toBe(2);
    expect(recovered.recovered.find((session) => session.sessionId === "ses_1")?.classification).toBe(
      "interrupted_recoverable",
    );
    expect(recovered.recovered.find((session) => session.sessionId === "ses_2")?.classification).toBe(
      "safe_idle",
    );
  });

  test("classifies kill points for approval, integrity, and idle sessions", async () => {
    const recovered = await recoverDaemonState({
      workspaces: new WorkspaceSupervisorRegistry(),
      approvals: new ApprovalManager(),
      eventHub: new EventHub(),
      now: () => "2026-08-25T00:00:00.000Z",
      sessions: [
        {
          sessionId: "ses_approval",
          workspaceIdentityDigest: "ws_1",
          pendingApprovalIds: ["appr_1"],
        },
        {
          sessionId: "ses_corrupt",
          workspaceIdentityDigest: "ws_1",
          integrityOk: false,
        },
        {
          sessionId: "ses_idle",
          workspaceIdentityDigest: "ws_1",
        },
        {
          sessionId: "ses_question",
          workspaceIdentityDigest: "ws_1",
          pendingQuestionnaireId: "cache-round-1",
          hadOpenTurn: true,
        },
      ],
    });
    expect(recovered.recovered.find((session) => session.sessionId === "ses_approval")?.classification).toBe(
      "waiting_approval",
    );
    expect(recovered.recovered.find((session) => session.sessionId === "ses_corrupt")?.classification).toBe(
      "failed_integrity",
    );
    expect(recovered.recovered.find((session) => session.sessionId === "ses_idle")?.classification).toBe(
      "safe_idle",
    );
    expect(recovered.recovered.find((session) => session.sessionId === "ses_question")).toMatchObject({
      classification: "waiting_user_input",
      pendingQuestionnaireId: "cache-round-1",
    });
  });

  test("reloads persisted session seeds and event-hub journals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capy-recovery-"));
    const path = join(dir, "recovery.json");
    const hub = new EventHub();
    hub.publish("ses_persisted", {
      schemaVersion: "1.0",
      id: "evt_1",
      kind: "turn.started",
      payload: { prompt: "keep going" },
    });
    persistRecoveryState(path, {
      schemaVersion: "1",
      sessions: [{
        sessionId: "ses_persisted",
        workspaceIdentityDigest: "ws_1",
        hadOpenTurn: true,
        lastJournalSequence: 1,
      }],
      eventHub: hub.exportSnapshot(),
    });
    const restoredHub = new EventHub();
    const recovered = await recoverDaemonState({
      workspaces: new WorkspaceSupervisorRegistry(),
      approvals: new ApprovalManager(),
      eventHub: restoredHub,
      persistedPath: path,
      now: () => "2026-08-25T00:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe("1");
    expect(recovered.recovered[0]?.sessionId).toBe("ses_persisted");
    expect(recovered.interruptedTurns).toBe(1);
    expect(restoredHub.cursor("ses_persisted")).toBeGreaterThanOrEqual(1);
  });
});
