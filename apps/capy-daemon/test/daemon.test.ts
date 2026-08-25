import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APP_PROTOCOL_VERSION,
  type EventReplayResult,
} from "@cbc/app-protocol";
import type { AppServerBackend, AppServerSubscription } from "@cbc/app-server";

import { ApprovalManager } from "../src/approval-manager.ts";
import { CapybaraDaemon } from "../src/daemon.ts";
import { EventHub } from "../src/event-hub.ts";
import {
  acquireInstanceLock,
  InstanceLockError,
  type DaemonLockRecord,
} from "../src/instance-lock.ts";
import { pluginCannotWidenAuthority, PluginSupervisor } from "../src/plugin-supervisor.ts";
import type { PluginManifest } from "@cbc/plugin-sdk";

const DIGEST = "sha256:" + "a".repeat(64);

function tempRuntime(): string {
  return mkdtempSync(join(tmpdir(), "capy-daemon-"));
}

const runtimes: string[] = [];

afterEach(() => {
  while (runtimes.length > 0) {
    const dir = runtimes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function runtimeDir(): string {
  const dir = tempRuntime();
  runtimes.push(dir);
  return dir;
}

function fakeBackend(): AppServerBackend {
  const subscriptions = new Map<string, AppServerSubscription>();
  return {
    async registerClient() {},
    async createSubscription(input) {
      const record: AppServerSubscription = {
        id: input.id,
        clientId: input.clientId,
        sessionId: input.sessionId,
        state: "active",
        lastAckedSequence: input.initialAckedSequence,
      };
      subscriptions.set(record.id, record);
      return record;
    },
    async acknowledgeSubscription(input) {
      const existing = subscriptions.get(input.subscriptionId)!;
      const record = { ...existing, lastAckedSequence: input.sequence };
      subscriptions.set(record.id, record);
      return record;
    },
    async setSubscriptionState(input) {
      const existing = subscriptions.get(input.subscriptionId)!;
      const record = { ...existing, state: input.state };
      subscriptions.set(record.id, record);
      return record;
    },
    async replaySubscription(input): Promise<EventReplayResult> {
      const existing = subscriptions.get(input.subscriptionId)!;
      return {
        subscription: existing,
        cursor: {
          sessionId: existing.sessionId,
          journalSequence: input.afterSequence ?? existing.lastAckedSequence,
        },
        events: [],
        hasMore: false,
      };
    },
    async health() {
      return { status: "ready" };
    },
    async dispatch() {
      return { ok: true };
    },
  };
}

function pluginManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: "1.0",
    id: "acme/narrow-only",
    name: "Narrow only",
    version: "1.0.0",
    publisher: "acme",
    description: "Fixture plugin.",
    license: "Apache-2.0",
    runtime: { kind: "stdio", entrypoint: "plugin.js", protocolVersion: "1.0.0" },
    compatibility: { capybara: ">=0.1.0" },
    permissions: {
      workspaceRead: [],
      networkDomains: [],
    },
    integrity: {
      files: { "plugin.js": DIGEST },
      packageDigest: DIGEST,
    },
    ...overrides,
  };
}

describe("instance lock", () => {
  test("takes over a stale lock when the recorded pid is dead", () => {
    const dir = runtimeDir();
    const stale: DaemonLockRecord = {
      schemaVersion: "1.0",
      daemonId: "dmn_stale",
      pid: 1_000_000_007,
      startedAt: "2026-01-01T00:00:00.000Z",
      executablePathDigest: DIGEST,
      protocolVersion: APP_PROTOCOL_VERSION,
      nonce: "nonce_stale",
      uid: process.getuid?.() ?? 0,
    };
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify(stale), { mode: 0o600 });

    const handle = acquireInstanceLock({
      daemonId: "dmn_fresh",
      protocolVersion: APP_PROTOCOL_VERSION,
      runtimeDir: dir,
      executableDigest: DIGEST,
      isProcessAlive: () => false,
      currentUid: stale.uid,
    });
    expect(handle.record.daemonId).toBe("dmn_fresh");
    handle.release();
  });

  test("two concurrent starts refuse the second live owner", () => {
    const dir = runtimeDir();
    const first = acquireInstanceLock({
      daemonId: "dmn_one",
      protocolVersion: APP_PROTOCOL_VERSION,
      runtimeDir: dir,
      executableDigest: DIGEST,
      isProcessAlive: () => true,
      currentUid: process.getuid?.() ?? 0,
    });
    expect(() => acquireInstanceLock({
      daemonId: "dmn_two",
      protocolVersion: APP_PROTOCOL_VERSION,
      runtimeDir: dir,
      executableDigest: DIGEST,
      isProcessAlive: () => true,
      currentUid: process.getuid?.() ?? 0,
    })).toThrow(InstanceLockError);
    first.release();
  });
});

describe("session attach/detach and approvals", () => {
  test("attach/detach preserves control-independent turn state and approvals", async () => {
    const dir = runtimeDir();
    const daemon = new CapybaraDaemon({
      runtimeDir: dir,
      backend: fakeBackend(),
      listen: false,
      executableDigest: DIGEST,
    });
    await daemon.start();

    const attached = await daemon.attachSession({
      sessionId: "ses_1",
      workspaceIdentityDigest: "ws_1",
      connectionId: "conn_1",
      clientId: "client_1",
      mode: "controller",
    });
    expect(attached.controlLease?.clientId).toBe("client_1");

    const actor = daemon.workspaces.get("ws_1")!.getSession("ses_1")!;
    await actor.dispatch({
      kind: "submit_turn",
      turnId: "turn_1",
      clientId: "client_1",
      prompt: "do work",
    });

    const approval = daemon.approvals.request({
      approvalId: "appr_1",
      sessionId: "ses_1",
      turnId: "turn_1",
      request: {
        title: "network",
        summary: "allow fetch",
        actionHash: "hash_1",
        network: true,
      },
    });
    await actor.dispatch({ kind: "mark_waiting_approval", approvalId: approval.approvalId });

    const detached = await daemon.detachSession({
      sessionId: "ses_1",
      workspaceIdentityDigest: "ws_1",
      connectionId: "conn_1",
    });
    expect(detached.attachedClients).toHaveLength(0);
    expect(detached.activeTurnId).toBe("turn_1");
    expect(detached.pendingApprovalIds).toContain("appr_1");
    expect(daemon.approvals.get("appr_1")?.state).toBe("pending");

    await daemon.stop();
  });
});

describe("event hub cursor", () => {
  test("slow clients switch to replay mode instead of unbounded queues", () => {
    const hub = new EventHub({ maxQueueItems: 2, maxQueueBytes: 10_000 });
    hub.subscribe({
      id: "sub_1",
      sessionId: "ses_cursor",
      clientId: "client_a",
      initialAckedSequence: 0,
    });
    hub.publish("ses_cursor", { schemaVersion: "1.0", id: "e1", kind: "turn.started" });
    hub.publish("ses_cursor", { schemaVersion: "1.0", id: "e2", kind: "turn.progress" });
    const forced = hub.publish("ses_cursor", { schemaVersion: "1.0", id: "e3", kind: "turn.completed" });
    expect(forced.replayForced).toBe(1);
    expect(hub.subscription("sub_1").mode).toBe("replay");

    const replay = hub.replay({
      subscriptionId: "sub_1",
      afterSequence: 0,
      maxEvents: 10,
      maxBytes: 100_000,
    });
    expect(replay.events.map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
    expect(replay.cursorSequence).toBe(3);
  });
});

describe("plugin authority", () => {
  test("plugin cannot widen authority", async () => {
    expect(pluginCannotWidenAuthority({
      workspaceRead: ["src/**"],
      workspaceWrite: [],
      credentialScopes: [],
      toolIds: ["fs.read"],
      contextCandidateIds: [],
      network: "deny",
      timeoutMs: 1_000,
      outputBytes: 1_024,
      maxNodes: 1,
      risk: "R1",
      sandbox: "strict",
    }, {
      network: "allow",
      workspaceRead: ["src/**", "secrets/**"],
    })).toBe(true);

    const supervisor = new PluginSupervisor();
    supervisor.install({
      pluginId: "acme/narrow-only",
      scope: "user",
      manifest: pluginManifest(),
      command: "true",
    });
    await expect(supervisor.invoke({
      pluginId: "acme/narrow-only",
      method: "hooks.before.tool",
      operation: {
        workspaceRead: ["src/**"],
        workspaceWrite: [],
        credentialScopes: [],
        toolIds: [],
        contextCandidateIds: [],
        network: "deny",
        timeoutMs: 100,
        outputBytes: 100,
        maxNodes: 1,
        risk: "R0",
        sandbox: "strict",
      },
      proposedConstraints: { network: "allow" },
    })).rejects.toMatchObject({ code: "PLUGIN_AUTHORITY_ESCALATION" });
  });

  test("wasi plugins run without ambient secrets", async () => {
    const dir = runtimeDir();
    const entry = join(dir, "plugin.js");
    writeFileSync(entry, "function handle(params, host) { return { env: host.env, method: params.ok }; }\n");
    const supervisor = new PluginSupervisor();
    supervisor.install({
      pluginId: "acme/narrow-only",
      scope: "user",
      cwd: dir,
      manifest: pluginManifest({
        runtime: { kind: "wasi", entrypoint: "plugin.js", protocolVersion: "1.0.0" },
      }),
      command: "true",
    });
    const result = await supervisor.invoke({
      pluginId: "acme/narrow-only",
      method: "handle",
      params: { ok: true },
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ env: {}, method: true });
  });
});

describe("CapybaraDaemon with fake backend", () => {
  test("hosts AppServer initialize through the injected backend", async () => {
    const dir = runtimeDir();
    const backend = fakeBackend();
    const daemon = new CapybaraDaemon({
      runtimeDir: dir,
      backend,
      listen: false,
      executableDigest: DIGEST,
      daemonId: "dmn_test",
    });
    await daemon.start();
    const response = await daemon.dispatch(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "server.initialize",
      params: {
        protocolVersion: "1.0",
        client: {
          id: "client_sdk",
          name: "test",
          version: "1.0.0",
          kind: "sdk",
        },
        capabilities: {
          eventStreaming: true,
          eventAck: true,
          approvals: true,
          interactivePrompts: false,
          artifactStreaming: false,
          richDiff: false,
        },
      },
    });
    expect("result" in response).toBe(true);
    if ("result" in response) {
      expect((response.result as { daemonId: string }).daemonId).toBe("dmn_test");
    }
    await daemon.stop();
  });
});

describe("approval manager detach survival", () => {
  test("pending approvals remain after manager clients disappear", () => {
    const approvals = new ApprovalManager();
    approvals.request({
      approvalId: "appr_detach",
      sessionId: "ses_x",
      turnId: "turn_x",
      request: {
        title: "shell",
        summary: "run build",
        actionHash: "ah_1",
      },
    });
    expect(approvals.listPending("ses_x")).toHaveLength(1);
    // No client registry is required; detach is a session concern.
    expect(approvals.get("appr_detach")?.state).toBe("pending");
  });
});
