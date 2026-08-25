import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapybaraDaemon } from "../../capy-daemon/src/daemon.ts";
import { CapybaraClient } from "@cbc/sdk";

import { sessionDaemonMode } from "../src/commands/daemon.ts";

describe("session daemon product flow", () => {
  test("keeps execution in-process for --no-daemon and CBC_DAEMON=0", () => {
    expect(sessionDaemonMode({ enabled: true, noDaemon: true })).toBe("embedded");
    expect(sessionDaemonMode({ enabled: true, envDaemon: "0" })).toBe("embedded");
    expect(sessionDaemonMode({ enabled: false })).toBe("embedded");
    expect(sessionDaemonMode({ enabled: true })).toBe("daemon");
  });

  test("unix attach/detach leaves an in-flight turn running", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "capy-daemon-"));
    const daemon = new CapybaraDaemon({
      runtimeDir,
      listen: true,
      executableDigest: "sha256:" + "ab".repeat(32),
    });
    await daemon.start();
    const socketPath = daemon.lock?.paths.socketPath;
    expect(typeof socketPath).toBe("string");
    if (typeof socketPath !== "string") throw new Error("daemon socket path missing");
    const client = await CapybaraClient.connect({
      transport: "unix",
      path: socketPath,
      client: { id: "client_tui", name: "capy", version: "1.0.0", kind: "tui" },
    });
    await client.request("session.attach", {
      sessionId: "ses_live",
      workspaceIdentityDigest: "ws_live",
      mode: "controller",
    });
    const actor = daemon.workspaces.get("ws_live")!.getSession("ses_live")!;
    await actor.dispatch({
      kind: "submit_turn",
      turnId: "turn_live",
      clientId: "client_tui",
      prompt: "keep going",
    });
    await client.request("session.detach", {
      sessionId: "ses_live",
      workspaceIdentityDigest: "ws_live",
    });
    expect(actor.state.activeTurnId).toBe("turn_live");
    expect(actor.state.attachedClients).toHaveLength(0);

    const reattached = await CapybaraClient.connect({
      transport: "unix",
      path: socketPath,
      client: { id: "client_tui2", name: "capy", version: "1.0.0", kind: "tui" },
    });
    await reattached.request("session.attach", {
      sessionId: "ses_live",
      workspaceIdentityDigest: "ws_live",
      mode: "observer",
    });
    expect(actor.state.activeTurnId).toBe("turn_live");
    await reattached.close();
    await client.close();
    await daemon.stop();
  });
});
