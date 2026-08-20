/**
 * Host-side MCP bootstrap (P0-15) — `buildMcpBridgeForManager`.
 *
 * These tests exercise the bridge contract without spawning real servers: a call
 * to an unavailable server fails honestly with `MCP_UNAVAILABLE` rather than
 * pretending the work happened (§24.5), and search reports zero capabilities for
 * an empty manager.
 */

import { describe, expect, test } from "bun:test";

import { buildDescriptors, McpCatalog, McpClientManager } from "@cbc/mcp-client";
import type { ProposedAction } from "@cbc/permissions";

import {
  bootstrapMcpHost,
  buildMcpBridgeForManager,
  DeferredMcpHost,
} from "../src/mcp-host.ts";

describe("buildMcpBridgeForManager (P0-15)", () => {
  test("mcp.search reports no capabilities for an empty manager", async () => {
    const manager = new McpClientManager({ catalog: new McpCatalog() });
    const bridge = buildMcpBridgeForManager(manager);
    const execution = await bridge(
      { callId: "1", toolId: "mcp.search", arguments: { query: "anything" }, display: "search" },
      new AbortController().signal,
    );
    expect(execution.result.ok).toBe(true);
    expect(execution.text).toContain("No MCP capabilities matched.");
  });

  test("mcp.call on an unreachable server fails honestly with MCP_UNAVAILABLE", async () => {
    const manager = new McpClientManager({ catalog: new McpCatalog() });
    const bridge = buildMcpBridgeForManager(manager);
    const execution = await bridge(
      {
        callId: "2",
        toolId: "mcp.call",
        arguments: { server: "nope", tool: "inspect", arguments: {} },
        display: "call nope.inspect",
      } as ProposedAction,
      new AbortController().signal,
    );
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error?.code).toBe("MCP_UNAVAILABLE");
    }
  });

  test("mcp.read_resource for an unavailable server surfaces MCP_UNAVAILABLE", async () => {
    const manager = new McpClientManager({ catalog: new McpCatalog() });
    const bridge = buildMcpBridgeForManager(manager);
    const execution = await bridge(
      {
        callId: "3",
        toolId: "mcp.read_resource",
        arguments: { server: "nope", uri: "file:///tmp/missing" },
        display: "read nope resource",
      } as ProposedAction,
      new AbortController().signal,
    );
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error?.code).toBe("MCP_UNAVAILABLE");
    }
  });

  test("bootstrap returns at a zero startup budget while connection continues safely", async () => {
    let resolveCapability!: (value: Record<string, string>) => void;
    let startCalls = 0;
    const runtime = {
      issueCapability: async () => await new Promise<Record<string, string>>((resolve) => {
        resolveCapability = resolve;
      }),
      startJob: async () => {
        startCalls += 1;
        return { jobId: "job-1", display: "fake" };
      },
      sendInput: async () => undefined,
      stopJob: async () => undefined,
      jobStatus: async () => ({ state: "running" }),
      subscribeNotifications: () => () => undefined,
    };

    const host = await bootstrapMcpHost({
      servers: { slow: { transport: "stdio", command: "fake" } },
      workspaceRoot: "/work",
      clientVersion: "0.1.0",
      runtime: runtime as never,
      sessionId: "session-1",
      resolveEnv: () => undefined,
      startupBudgetMs: 0,
    });
    expect(host.manager.get("slow")?.client.state).toBe("starting");
    expect(startCalls).toBe(0);

    // Shutdown can race the scheduled capability request without launching an
    // orphan process after the session has gone away.
    await host.close();
    resolveCapability({ id: "cap", sessionId: "session-1", actionHash: "hash" });
    await host.ready;
    expect(startCalls).toBe(0);
  });
});

describe("startup connection policy", () => {
  test("does not start a server that opts out of session bootstrap", async () => {
    let capabilityCalls = 0;
    let environmentReads = 0;
    const runtime = {
      issueCapability: async () => {
        capabilityCalls += 1;
        return { id: "cap", sessionId: "session-1", actionHash: "hash" };
      },
      startJob: async () => ({ jobId: "job-1", display: "fake" }),
      sendInput: async () => undefined,
      stopJob: async () => undefined,
      jobStatus: async () => ({ state: "running" }),
      subscribeNotifications: () => () => undefined,
    };

    const host = await bootstrapMcpHost({
      servers: {
        deferred: {
          transport: "stdio",
          command: "fake",
          env: ["NOT_READ_AT_STARTUP"],
          connectOnStartup: false,
        },
      },
      workspaceRoot: "/work",
      clientVersion: "0.1.0",
      runtime: runtime as never,
      sessionId: "session-1",
      resolveEnv: () => {
        environmentReads += 1;
        return undefined;
      },
      startupBudgetMs: 0,
    });

    expect(capabilityCalls).toBe(0);
    expect(environmentReads).toBe(0);
    await host.close();
  });
});

describe("DeferredMcpHost", () => {
  test("Plan search reads a local catalog without starting configured transports", async () => {
    let capabilityCalls = 0;
    let envReads = 0;
    const catalog = new McpCatalog();
    catalog.set(
      "docs",
      buildDescriptors({
        server: "docs",
        tools: [{ name: "list_issues", inputSchema: { type: "object" } }],
      }),
    );
    const runtime = {
      issueCapability: async () => {
        capabilityCalls += 1;
        return { id: "cap", sessionId: "session-1", actionHash: "hash" };
      },
      startJob: async () => ({ jobId: "job-1", display: "fake" }),
      sendInput: async () => undefined,
      stopJob: async () => undefined,
      jobStatus: async () => ({ state: "running" }),
      subscribeNotifications: () => () => undefined,
    };
    const host = await DeferredMcpHost.create({
      servers: { docs: { transport: "stdio", command: "fake" } },
      catalog,
      workspaceRoot: "/work",
      clientVersion: "0.1.0",
      runtime: runtime as never,
      sessionId: "session-1",
      resolveEnv: () => {
        envReads += 1;
        return undefined;
      },
      initialMode: "plan",
      interactionMode: () => "plan",
    });

    const execution = await host.bridge(
      {
        callId: "plan-search",
        toolId: "mcp.search",
        arguments: { query: "issues" },
        display: "search issues",
      },
      new AbortController().signal,
    );
    expect(execution.result.ok).toBe(true);
    expect(execution.text).toContain("docs/list_issues");
    expect(capabilityCalls).toBe(0);
    expect(envReads).toBe(0);
    await host.close();
  });
});
