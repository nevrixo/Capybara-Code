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

  test("pending questionnaire survives controller detach and blocks workspace eviction", async () => {
    const dir = runtimeDir();
    const daemon = new CapybaraDaemon({
      runtimeDir: dir,
      backend: fakeBackend(),
      listen: false,
      executableDigest: DIGEST,
    });
    await daemon.start();
    await daemon.attachSession({
      sessionId: "ses_questions",
      workspaceIdentityDigest: "ws_questions",
      connectionId: "conn_questions",
      clientId: "client_questions",
      mode: "controller",
    });
    const workspace = daemon.workspaces.get("ws_questions")!;
    const actor = workspace.getSession("ses_questions")!;
    await actor.dispatch({
      kind: "submit_turn",
      turnId: "turn_questions",
      clientId: "client_questions",
      prompt: "plan",
    });
    await actor.dispatch({
      kind: "mark_waiting_user_input",
      questionnaireId: "cache-round-1",
    });
    const detached = await daemon.detachSession({
      sessionId: "ses_questions",
      workspaceIdentityDigest: "ws_questions",
      connectionId: "conn_questions",
    });
    expect(detached.lifecycle).toBe("waiting_user_input");
    expect(detached.pendingUserInputId).toBe("cache-round-1");
    expect(detached.activeTurnId).toBe("turn_questions");
    expect(workspace.isIdle(Date.now() + 60_000)).toBe(false);

    await actor.dispatch({
      kind: "attach_client",
      connectionId: "conn_questions_2",
      clientId: "client_questions",
      mode: "controller",
    });
    const resolved = await actor.dispatch({
      kind: "resolve_user_input",
      clientId: "client_questions",
      questionnaireId: "cache-round-1",
    });
    expect(resolved.lifecycle).toBe("running");
    expect(resolved.pendingUserInputId).toBeUndefined();
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
    expect(supervisor.inspect("acme/narrow-only")?.enabled).toBe(true);
    supervisor.setEnabled("acme/narrow-only", false);
    expect(supervisor.health("acme/narrow-only").status).toBe("disabled");
    await expect(supervisor.invoke({
      pluginId: "acme/narrow-only",
      method: "hooks.before.tool",
    })).rejects.toMatchObject({ code: "PLUGIN_DISABLED" });
    supervisor.setEnabled("acme/narrow-only", true);
    expect(supervisor.health("acme/narrow-only").status).toBe("ready");
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

  test("worktree.list returns registered worktrees instead of an unknown method", async () => {
    const dir = runtimeDir();
    const daemon = new CapybaraDaemon({
      runtimeDir: dir,
      listen: false,
      executableDigest: DIGEST,
      daemonId: "dmn_worktree",
    });
    await daemon.start();
    daemon.worktrees.create({
      id: "wt_agent",
      workspaceIdentityDigest: "ws_1",
      path: "worktrees/ws_1/wt_agent/repo",
      baseCommit: "abc123",
      baseWorkspaceRevision: "1",
    });
    const initialized = await daemon.dispatch(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "server.initialize",
      params: {
        protocolVersion: "1.0",
        client: {
          id: "client_tui",
          name: "capy",
          version: "1.0.0",
          kind: "tui",
        },
        capabilities: {
          eventStreaming: true,
          eventAck: true,
          approvals: true,
          interactivePrompts: true,
          artifactStreaming: false,
          richDiff: false,
        },
      },
    });
    expect("result" in initialized).toBe(true);
    const connectionId = "result" in initialized
      ? (initialized.result as { connectionId: string }).connectionId
      : undefined;
    const listed = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "worktree.list",
      params: { workspaceIdentityDigest: "ws_1" },
    });
    expect("error" in listed).toBe(false);
    expect("result" in listed).toBe(true);
    if ("result" in listed) {
      const worktrees = (listed.result as { worktrees: Array<{ id: string; path: string }> }).worktrees;
      expect(worktrees).toEqual([
        expect.objectContaining({
          id: "wt_agent",
          path: "worktrees/ws_1/wt_agent/repo",
        }),
      ]);
    }
    await daemon.stop();
  });

  test("session.ensure owns a worker without a command envelope", async () => {
    const dir = runtimeDir();
    const daemon = new CapybaraDaemon({
      runtimeDir: dir,
      listen: false,
      executableDigest: DIGEST,
      daemonId: "dmn_ensure",
    });
    await daemon.start();
    const initialized = await daemon.dispatch(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "server.initialize",
      params: {
        protocolVersion: "1.0",
        client: {
          id: "client_tui",
          name: "capy",
          version: "1.0.0",
          kind: "tui",
        },
        capabilities: {
          eventStreaming: true,
          eventAck: true,
          approvals: true,
          interactivePrompts: true,
          artifactStreaming: false,
          richDiff: false,
        },
      },
    });
    expect("result" in initialized).toBe(true);
    const connectionId = "result" in initialized
      ? (initialized.result as { connectionId: string }).connectionId
      : undefined;
    const ensured = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "session.ensure",
      params: { sessionId: "ses_owned" },
    });
    expect("error" in ensured).toBe(false);
    expect("result" in ensured).toBe(true);
    if ("result" in ensured) {
      expect(ensured.result).toEqual({ sessionId: "ses_owned", owned: true });
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

describe("default App backend session receipts", () => {
  test("creates, lists, submits, retries, and cancels through one durable command contract", async () => {
    const dir = runtimeDir();
    const prompts: string[] = [];
    const cancellations: string[] = [];
    const workerRequests: Array<{ method: string; params: unknown }> = [];
    const daemon = new CapybaraDaemon({
      runtimeDir: dir,
      listen: false,
      executableDigest: DIGEST,
      sessionExecutor: {
        async submit(request) {
          prompts.push(request.prompt);
          return {
            turnId: request.turnId,
            status: "completed",
            answer: "done",
            report: { summary: "done", changedFiles: [], verification: [] },
          };
        },
        async cancel(sessionId, turnId) {
          cancellations.push(sessionId + ":" + (turnId ?? ""));
        },
        async request(_sessionId, method, params) {
          workerRequests.push({ method, params });
          return { method, params };
        },
      },
    });
    await daemon.start();
    const initialized = await daemon.dispatch(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "server.initialize",
      params: {
        protocolVersion: "1.0",
        client: {
          id: "client_integration",
          name: "integration test",
          version: "1.0.0",
          kind: "ide",
        },
        capabilities: {
          eventStreaming: true,
          eventAck: true,
          approvals: true,
          interactivePrompts: true,
          artifactStreaming: true,
          richDiff: true,
          taskTree: true,
          planReview: true,
        },
      },
    });
    if (!("result" in initialized)) throw new Error(initialized.error.message);
    const connectionId = (initialized.result as { connectionId: string }).connectionId;
    const command = (
      commandId: string,
      payload: unknown,
      sessionId?: string,
    ) => ({
      schemaVersion: "1.0",
      commandId,
      idempotencyKey: "idem_" + commandId,
      correlationId: "cor_" + commandId,
      clientId: "client_integration",
      ...(sessionId === undefined ? {} : { sessionId }),
      issuedAt: "2026-08-30T00:00:00.000Z",
      payload,
    });
    const createRequest = {
      jsonrpc: "2.0" as const,
      id: 2,
      method: "session.create",
      params: {
        command: command("create", {
          workspaceIdentityDigest: "ws_integration",
          cwd: "C:/workspace",
        }),
      },
    };
    const created = await daemon.dispatch(connectionId, createRequest);
    const replayedCreate = await daemon.dispatch(connectionId, { ...createRequest, id: 3 });
    if (!("result" in created) || !("result" in replayedCreate)) throw new Error("session create failed");
    const createReceipt = created.result as { receiptId: string; result: { sessionId: string } };
    const replayReceipt = replayedCreate.result as { receiptId: string };
    expect(replayReceipt.receiptId).toBe(createReceipt.receiptId);
    const sessionId = createReceipt.result.sessionId;

    const attached = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "session.attach",
      params: {
        sessionId,
        workspaceIdentityDigest: "ws_integration",
        mode: "controller",
      },
    });
    expect("result" in attached).toBe(true);

    const turnRequest = {
      jsonrpc: "2.0" as const,
      id: 5,
      method: "turn.submit",
      params: {
        command: command("turn", { prompt: "fix parser", turnId: "turn_1" }, sessionId),
      },
    };
    const submitted = await daemon.dispatch(connectionId, turnRequest);
    const retried = await daemon.dispatch(connectionId, { ...turnRequest, id: 6 });
    expect("result" in submitted && (submitted.result as { status: string }).status).toBe("completed");
    expect("result" in retried && (retried.result as { receiptId: string }).receiptId)
      .toBe("result" in submitted ? (submitted.result as { receiptId: string }).receiptId : "");
    expect(prompts).toEqual(["fix parser"]);

    const listed = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 7,
      method: "session.list",
      params: { workspaceIdentityDigest: "ws_integration" },
    });
    expect("result" in listed && JSON.stringify(listed.result)).toContain(sessionId);

    const graph = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 71,
      method: "graph.get",
      params: { sessionId },
    });
    expect("result" in graph && (graph.result as { method: string }).method).toBe("graph.get");

    const messaged = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 72,
      method: "task.message",
      params: {
        command: command("message", {
          taskId: "agent_1",
          kind: "instruction",
          body: { text: "continue" },
        }, sessionId),
      },
    });
    expect("result" in messaged && (messaged.result as { status: string }).status).toBe("completed");

    const packageInspect = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 73,
      method: "package.inspect",
      params: { sessionId, packageId: "acme/quality" },
    });
    expect("result" in packageInspect).toBe(true);
    const packageInstallRequest = {
      jsonrpc: "2.0" as const,
      id: 74,
      method: "package.install",
      params: {
        command: command("package-install", {
          source: "registry:acme/quality",
          scope: "project",
        }, sessionId),
      },
    };
    const packageInstalled = await daemon.dispatch(connectionId, packageInstallRequest);
    const packageReplayed = await daemon.dispatch(
      connectionId,
      { ...packageInstallRequest, id: 75 },
    );
    expect(
      "result" in packageInstalled
      && (packageInstalled.result as { status: string }).status,
    ).toBe("completed");
    expect(
      "result" in packageReplayed
      && (packageReplayed.result as { receiptId: string }).receiptId,
    ).toBe(
      "result" in packageInstalled
        ? (packageInstalled.result as { receiptId: string }).receiptId
        : "",
    );
    expect(workerRequests.map((entry) => entry.method)).toEqual([
      "graph.get",
      "task.message",
      "package.inspect",
      "package.install",
    ]);
    expect(workerRequests.at(-1)?.params).toEqual({
      source: "registry:acme/quality",
      scope: "project",
      idempotencyKey: "idem_package-install",
    });

    const cancelled = await daemon.dispatch(connectionId, {
      jsonrpc: "2.0",
      id: 8,
      method: "turn.cancel",
      params: {
        command: command("cancel", { turnId: "turn_1" }, sessionId),
      },
    });
    expect("result" in cancelled && (cancelled.result as { status: string }).status).toBe("cancelled");
    expect(cancellations).toEqual([sessionId + ":turn_1"]);
    await daemon.stop();
  });
});
