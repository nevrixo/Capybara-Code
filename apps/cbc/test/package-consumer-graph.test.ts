/**
 * §5.21's dependency-graph impact input, end to end from the workspace manifests.
 *
 * The pure reversal is covered in packages/context-engine. What this pins is that
 * a real session reads the manifests and hands the kernel a graph, because until
 * it did, the §5.22 step-4 consumer tier could only widen to the changed packages
 * — a change in one package went out with none of its consumers verified.
 */

import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import { MockProvider } from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

const MANIFESTS: Readonly<Record<string, string>> = {
  "packages/protocol-ts/package.json": JSON.stringify({ name: "@cbc/protocol" }),
  "packages/provider-openai/package.json": JSON.stringify({
    name: "@cbc/provider",
    dependencies: { "@cbc/protocol": "workspace:*", zod: "^3" },
  }),
  "packages/agent-kernel/package.json": JSON.stringify({
    name: "@cbc/agent-kernel",
    // A dev dependency still makes a package a consumer: its tests import the
    // changed package, so its suite is exactly what a change can break.
    devDependencies: { "@cbc/provider": "workspace:*" },
  }),
  "apps/cbc/package.json": JSON.stringify({
    name: "capybara-code",
    dependencies: { "@cbc/agent-kernel": "workspace:*" },
  }),
  // A malformed manifest must drop out rather than abandon the whole graph.
  "packages/broken/package.json": "{ not json",
};

const CHECKSUM = "a".repeat(64);

/**
 * The consumer tier is only *required* at high change risk, so each scenario edits
 * a security-sensitive path: assessChangeRisk floors that at score 5, which is
 * high. A benign one-file edit stays at the focused and package tiers, which is
 * the §5.24 behaviour the low-risk cases elsewhere pin.
 */
function harness(changedPath: string) {
  let now = 1_000;
  const provider = new MockProvider({
    steps: [
      {
        commentary: "Applying the change.",
        toolCalls: [{
          callId: "w1",
          name: "fs.write",
          arguments: { path: changedPath, content: "export const x = 1;\n", intent: "create" },
        }],
      },
      { text: "Done." },
    ],
  });
  const events: CbcEvent[] = [];
  const runtime = {
    workspace: "/work",
    glob: async () => ({
      entries: [
        ...Object.keys(MANIFESTS).map((path) => ({ path, kind: "file", bytes: 64 })),
        { path: changedPath, kind: "file", bytes: 128 },
      ],
    }),
    gitDiff: async () => ({ files: [{ path: changedPath }], totalAdditions: 1, totalDeletions: 0 }),
    read: async () => ({ path: changedPath, binary: false, checksum: CHECKSUM, rendered: "" }),
    readMany: async () => ({ files: [{ path: changedPath, checksum: CHECKSUM }], errors: [] }),
    write: async () => ({ path: changedPath, revisionAfter: CHECKSUM }),
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
  const session = new AgentSession({
    host: {
      now: () => ++now,
      fs: { read: async (path: string) => MANIFESTS[path] },
    } as never,
    runtime: runtime as never,
    config: loadConfig({ projectTrusted: true, env: {} }).config,
    workspacePath: "/work",
    workspaceIdentityDigest: "c".repeat(64),
    trust: "trusted-always",
    sessionId: "session-package-graph",
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => { events.push(event); },
  });
  return { session, events };
}

function planPayload(events: readonly CbcEvent[]): {
  readonly impactedPackages?: readonly string[];
  readonly requiredChecks?: readonly { id: string; command?: string }[];
} | undefined {
  const plan = events.find((event) => event.kind === "verification.plan_created");
  return plan?.payload as never;
}

function consumerCommand(events: readonly CbcEvent[]): string | undefined {
  return planPayload(events)?.requiredChecks?.find((check) => check.id === "broader-tests")?.command;
}

describe("workspace package consumer graph (§5.21)", () => {
  test("a change in a dependency widens the consumer tier to its dependents", async () => {
    // provider-openai is consumed by agent-kernel, which is consumed by apps/cbc,
    // so a transitive reversal has to reach both. A path-prefix guess reaches
    // neither, which is what this input exists to fix.
    const { session, events } = harness("packages/provider-openai/src/credentials.ts");
    await session.submit("change the route decision", new AbortController().signal);

    const command = consumerCommand(events);
    expect(command).toBeDefined();
    expect(command).toContain("packages/agent-kernel");
    expect(command).toContain("apps/cbc");
    expect(command).toContain("packages/provider-openai");
  });

  test("a package nothing depends on does not widen past itself", async () => {
    const { session, events } = harness("apps/cbc/src/credentials.ts");
    await session.submit("change the session", new AbortController().signal);

    // apps/cbc is a leaf: nothing declares it as a dependency, so an unnecessary
    // full-suite run here is exactly what §5.24 asks to reduce.
    expect(consumerCommand(events)).toBe("bun test apps/cbc");
  });

  test("a malformed manifest drops out rather than abandoning the graph", async () => {
    // packages/broken/package.json is not JSON. The other four members still have
    // to produce a usable reversal.
    const { session, events } = harness("packages/protocol-ts/src/credentials.ts");
    await session.submit("change an event kind", new AbortController().signal);

    const command = consumerCommand(events);
    expect(command).toContain("packages/provider-openai");
    expect(command).not.toContain("packages/broken");
  });
});
