import { describe, expect, test } from "bun:test";

import { ApprovalManager } from "../src/approval-manager.ts";
import { EventHub } from "../src/event-hub.ts";
import { recoverDaemonState } from "../src/recovery.ts";
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
});
