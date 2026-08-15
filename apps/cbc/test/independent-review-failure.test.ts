import { describe, expect, test } from "bun:test";

import { loadConfig } from "@cbc/config-schema";
import {
  MockProvider,
  type CredentialLease,
  type CredentialValidation,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ProviderCapabilities,
  type ScriptedStep,
} from "@cbc/provider-openai";
import type { CbcEvent } from "@cbc/protocol";

import { AgentSession } from "../src/agent.ts";
import { GrantedRules } from "../src/approvals.ts";

const PATCH = [
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function authorSteps(): ScriptedStep[] {
  return [
    {
      toolCalls: [{ callId: "patch-readme", name: "fs.apply_patch", arguments: { diff: PATCH } }],
    },
    { text: "Patched README.md." },
  ];
}

class ThrowingReviewProvider implements ModelProvider {
  readonly id = "throwing-review";
  readonly capabilities: ProviderCapabilities;
  readonly #delegate: MockProvider;
  #streamCalls = 0;

  constructor() {
    this.#delegate = new MockProvider({ steps: authorSteps() });
    this.capabilities = this.#delegate.capabilities;
  }

  get streamCalls(): number {
    return this.#streamCalls;
  }

  async listModels(_signal?: AbortSignal) {
    return await this.#delegate.listModels();
  }

  async validateCredential(
    credential: CredentialLease,
    _signal?: AbortSignal,
  ): Promise<CredentialValidation> {
    return await this.#delegate.validateCredential(credential);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.#streamCalls += 1;
    if (this.#streamCalls === 3) throw new Error("review stream exploded");
    yield* this.#delegate.stream(request, signal);
  }
}

async function runMutatedTurn(provider: ModelProvider) {
  const events: CbcEvent[] = [];
  let now = 1_000;
  const runtime = {
    workspace: "/work",
    beginTransaction: async () => ({ transactionId: "tx-review-failure" }),
    patch: async () => ({
      stagedPaths: ["README.md"],
      files: [{ path: "README.md", hunks: 1 }],
    }),
    commitTransaction: async () => ({
      operations: [{ path: "README.md", additions: 1, deletions: 1 }],
      totalAdditions: 1,
      totalDeletions: 1,
    }),
    rollbackTransaction: async () => undefined,
    gitDiff: async () => ({
      files: [{ path: "README.md", patch: PATCH, additions: 1, deletions: 1 }],
    }),
    glob: async () => ({ entries: [], truncated: false }),
    read: async () => {
      throw new Error("not found");
    },
    appendEvents: async (params: { events?: unknown[] }) => ({
      appended: params.events?.length ?? 0,
      lastSequence: params.events?.length ?? 0,
    }),
    openSession: async () => ({ ok: true }),
    snapshotSession: async () => ({ ok: true }),
    loadSession: async () => ({ events: [] }),
  };
  const config = structuredClone(loadConfig({ projectTrusted: true, env: {} }).config);
  config.agent.reviewMode = "auto";
  config.agent.verification.reviewPolicy = "always";
  config.permissions.projectWrite = "auto";

  const session = new AgentSession({
    host: { now: () => ++now } as never,
    runtime: runtime as never,
    config,
    workspacePath: "/work",
    workspaceIdentityDigest: "d".repeat(64),
    trust: "trusted-always",
    sessionId: `review-failure-${now}`,
    provider,
    approvals: { request: async () => ({ kind: "allow_once" as const }) },
    granted: new GrantedRules(),
    nonInteractive: false,
    now: () => ++now,
    onEvent: (event) => {
      events.push(event);
    },
  });
  session.registry.activate(["fs.apply_patch"]);

  const result = await session.submit("Update README.md", new AbortController().signal);
  return { events, result };
}

async function expectReviewNotRun(provider: ModelProvider, marker: string): Promise<void> {
  const { events, result } = await runMutatedTurn(provider);
  const reviewRecords = result.report.verification.filter((record) =>
    record.evidence.includes("independent review")
  );

  expect(reviewRecords).toHaveLength(1);
  expect(reviewRecords[0]?.status).toBe("not_run");
  expect(
    result.report.verification.some(
      (record) => record.status === "passed" && record.evidence.includes("independent review"),
    ),
  ).toBe(false);
  expect(result.report.delegatedTasks.some((task) => task.role === "reviewer" && task.status === "completed"))
    .toBe(false);
  expect(result.report.risks.join("\n")).toContain(marker);
  expect(result.report.status).toBe("partial");

  const completed = events.find((event) => event.kind === "review.completed");
  expect(completed).toBeDefined();
  expect((completed?.payload as { status?: string }).status).toBe("not_run");
}

describe("AgentSession independent review failures", () => {
  test("a thrown provider error is not recorded as a clean review", async () => {
    const provider = new ThrowingReviewProvider();
    await expectReviewNotRun(provider, "review stream exploded");
    expect(provider.streamCalls).toBe(3);
  });

  test("response.failed is not recorded as a clean review", async () => {
    const provider = new MockProvider({
      steps: [
        ...authorSteps(),
        {
          error: {
            kind: "server",
            message: "review provider unavailable",
            retryable: true,
          },
        },
      ],
    });

    await expectReviewNotRun(provider, "review provider unavailable");
    expect(provider.requests).toHaveLength(3);
  });

  test("response.incomplete is not recorded as a clean review", async () => {
    const provider = new MockProvider({
      steps: [...authorSteps(), { incompleteReason: "max_output_tokens" }],
    });

    await expectReviewNotRun(provider, "max_output_tokens");
    expect(provider.requests).toHaveLength(3);
  });
});
