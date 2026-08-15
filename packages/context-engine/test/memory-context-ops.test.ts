import { describe, expect, test } from "bun:test";

import {
  MemoryBank,
  type MemoryEvidence,
} from "../src/memory.ts";
import {
  ContextOperationError,
  ContextOperations,
  createTaskContextCapsule,
  pathAllowedByCapsule,
  scopedExactExcerptBodyDigest,
  scopedExactExcerptIdentityDigest,
  structuredCompactStateIssues,
  validateChildEvidenceResult,
  validateContextOp,
  validateTaskContextCapsule,
  type StructuredCompactStateV2,
} from "../src/context-ops.ts";

function evidence(
  id: string,
  observedAt: string,
  overrides: Partial<MemoryEvidence> = {},
): MemoryEvidence {
  return {
    id,
    freshness: "fresh",
    observedAt,
    exact: true,
    workspaceIdentityDigest: "workspace-a",
    digest: `${id}-digest`,
    ...overrides,
  };
}

function memoryFixture() {
  let now = "2026-01-01T00:00:00.000Z";
  const records = new Map<string, MemoryEvidence>();
  const bank = new MemoryBank({
    resolveEvidence: (id) => records.get(id),
    workspaceIdentity: "workspace-a",
    sessionId: "session-a",
    taskId: "task-a",
    branch: "main",
    now: () => now,
  });
  return {
    bank,
    records,
    setNow(value: string) {
      now = value;
    },
  };
}

function compactState(): StructuredCompactStateV2 {
  return {
    schemaVersion: "2",
    task: {
      goal: "implement durable context operations",
      constraints: ["preserve exact evidence"],
      acceptanceCriteria: ["tests pass"],
    },
    decisions: [{ text: "use immutable source items", status: "active", evidenceIds: ["ev-a"] }],
    assumptions: [{ text: "line ranges are one based", confidence: 0.9, evidenceIds: ["ev-a"] }],
    changedSymbols: [{ path: "src/a.ts", symbol: "a", purpose: "exercise compaction", checksum: "abc" }],
    verification: [{ command: "bun test", status: "passed", evidenceIds: ["ev-b"] }],
    unresolved: [],
    memoryHandles: ["memory-build-command"],
  };
}

describe("evidence-backed durable memory", () => {
  test("rejects writes without resolvable fresh evidence", () => {
    const { bank, records } = memoryFixture();
    expect(bank.write({
      key: "build.command",
      value: "bun test",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["missing"],
    })).toMatchObject({ accepted: false, action: "rejected" });

    records.set("stale", evidence("stale", "2026-01-01T00:00:00.000Z", { freshness: "stale" }));
    const stale = bank.write({
      key: "build.command",
      value: "bun test",
      scope: "workspace",
      confidence: 0.95,
      evidenceIds: ["stale"],
    });
    expect(stale.accepted).toBe(false);
    if (!stale.accepted) expect(stale.reasons.join(" ")).toContain("stale");
    expect(bank.size).toBe(0);
    expect(bank.transitionLog()).toHaveLength(0);
  });

  test("enforces workspace/session/task validity and session-only fallback", () => {
    const { bank, records } = memoryFixture();
    records.set("ev-workspace", evidence("ev-workspace", "2026-01-01T00:00:00.000Z"));
    records.set("ev-session", evidence("ev-session", "2026-01-01T00:00:01.000Z"));
    records.set("ev-task", evidence("ev-task", "2026-01-01T00:00:02.000Z"));
    records.set("ev-low", evidence("ev-low", "2026-01-01T00:00:03.000Z"));

    bank.writeOrThrow({ key: "workspace.fact", value: "workspace", scope: "workspace", confidence: 0.9, evidenceIds: ["ev-workspace"] });
    bank.writeOrThrow({ key: "session.fact", value: "session", scope: "session", confidence: 0.8, evidenceIds: ["ev-session"] });
    bank.writeOrThrow({ key: "task.fact", value: "task", scope: "task", confidence: 0.8, evidenceIds: ["ev-task"] });
    const fallback = bank.write({ key: "candidate.fact", value: "tentative", scope: "workspace", confidence: 0.7, evidenceIds: ["ev-low"] });

    expect(fallback).toMatchObject({ accepted: true, action: "session_only" });
    if (fallback.accepted) expect(fallback.record.scope).toBe("session");
    expect(bank.select({ sessionId: "different", taskId: "different" }).map((record) => record.key)).toEqual(["workspace.fact"]);
    expect(bank.select().map((record) => record.scope)).toEqual(["task", "session", "session", "workspace"]);
  });

  test("newer exact evidence supersedes a contradictory active claim", () => {
    const { bank, records, setNow } = memoryFixture();
    records.set("ev-old", evidence("ev-old", "2026-01-01T00:00:00.000Z"));
    const old = bank.writeOrThrow({
      key: "test.command",
      value: "npm test",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["ev-old"],
    });

    setNow("2026-01-02T00:00:00.000Z");
    records.set("ev-new", evidence("ev-new", "2026-01-02T00:00:00.000Z"));
    const next = bank.write({
      key: "test.command",
      value: "bun test",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["ev-new"],
    });

    expect(next).toMatchObject({ accepted: true, action: "superseded_previous", record: { status: "active" } });
    expect(bank.get(old.id)?.status).toBe("superseded");
    expect(bank.select({ key: "test.command" })[0]?.value).toBe("bun test");
  });

  test("equal/conflicting evidence contests rather than overwriting and later evidence resolves it", () => {
    const { bank, records, setNow } = memoryFixture();
    const observedAt = "2026-01-01T00:00:00.000Z";
    records.set("ev-left", evidence("ev-left", observedAt));
    records.set("ev-right", evidence("ev-right", observedAt));
    const left = bank.writeOrThrow({ key: "formatter", value: "prettier", scope: "workspace", confidence: 0.9, evidenceIds: ["ev-left"] });
    const right = bank.write({ key: "formatter", value: "biome", scope: "workspace", confidence: 0.9, evidenceIds: ["ev-right"] });
    expect(right).toMatchObject({ accepted: true, action: "contested", record: { status: "contested" } });
    expect(bank.get(left.id)?.status).toBe("contested");
    expect(bank.select({ key: "formatter" })).toHaveLength(0);
    expect(bank.select({ key: "formatter", statuses: ["contested"] })).toHaveLength(2);

    setNow("2026-01-03T00:00:00.000Z");
    records.set("ev-resolution", evidence("ev-resolution", "2026-01-03T00:00:00.000Z"));
    const resolved = bank.resolveContest({
      winnerId: left.id,
      evidenceIds: ["ev-resolution"],
      reason: "the checked-in configuration is authoritative",
    });
    expect(resolved.winner.status).toBe("active");
    expect(resolved.superseded[0]?.status).toBe("superseded");
  });

  test("branch-specific claims coexist and snapshots resume equivalently", () => {
    const { bank, records } = memoryFixture();
    records.set("ev-main", evidence("ev-main", "2026-01-01T00:00:00.000Z"));
    records.set("ev-release", evidence("ev-release", "2026-01-02T00:00:00.000Z"));
    bank.writeOrThrow({
      key: "deploy.target",
      value: "staging",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["ev-main"],
      validFor: { branch: "main" },
    });
    bank.writeOrThrow({
      key: "deploy.target",
      value: "production",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["ev-release"],
      validFor: { branch: "release" },
    });
    expect(bank.all().every((record) => record.status === "active")).toBe(true);
    expect(bank.select({ branch: "main" })[0]?.value).toBe("staging");
    expect(bank.select({ branch: "release" })[0]?.value).toBe("production");

    const serialized = bank.serialize();
    const restored = MemoryBank.deserialize(serialized, {
      resolveEvidence: (id) => records.get(id),
      workspaceIdentity: "workspace-a",
      sessionId: "new-session",
      taskId: "new-task",
      branch: "main",
      now: () => "2026-01-04T00:00:00.000Z",
    });
    expect(restored.serialize()).toBe(serialized);
    expect(Object.isFrozen(restored.transitionLog())).toBe(true);
    expect(Object.isFrozen(restored.transitionLog()[0])).toBe(true);
  });
});

describe("deterministic context operations", () => {
  function operations() {
    return new ContextOperations({
      items: [
        { id: "item-a", text: "one\ntwo\nthree", evidenceIds: ["ev-a"] },
        { id: "item-b", text: "alpha\nbeta", evidenceIds: ["ev-b"] },
      ],
      now: () => "2026-02-01T00:00:00.000Z",
    });
  }

  test("keep and one-based snippet operate only on the working view", () => {
    const context = operations();
    context.apply({ kind: "keep", ids: ["item-a"] });
    context.apply({ kind: "snippet", id: "item-a", range: { startLine: 2, endLine: 3 } });
    expect(context.keptItemIds()).toEqual(["item-a"]);
    expect(context.workingItems().find((item) => item.id === "item-a")).toMatchObject({
      text: "two\nthree",
      resolution: "snippet",
      range: { startLine: 2, endLine: 3 },
    });
    expect(context.sourceItems().find((item) => item.id === "item-a")?.text).toBe("one\ntwo\nthree");
    expect(() => context.apply({ kind: "snippet", id: "item-a", range: { startLine: 0, endLine: 1 } })).toThrow(ContextOperationError);
  });

  test("delete evicts and recall restores immutable exact source", () => {
    const context = operations();
    context.apply({ kind: "delete", ids: ["item-a"], reason: "lower relevance" });
    expect(context.workingItems().some((item) => item.id === "item-a")).toBe(false);
    expect(context.sourceItems().some((item) => item.id === "item-a")).toBe(true);
    context.apply({ kind: "recall", evidenceIds: ["ev-a"] });
    expect(context.workingItems().find((item) => item.id === "item-a")?.text).toBe("one\ntwo\nthree");
  });

  test("compress validates evidence refs and retains recallable originals", () => {
    const context = operations();
    const invalid = compactState();
    const invalidIssues = structuredCompactStateIssues(
      { ...invalid, decisions: [{ ...invalid.decisions[0]!, evidenceIds: ["unknown"] }] },
      context.knownEvidenceIds(),
    );
    expect(invalidIssues.join(" ")).toContain("unknown");

    const result = context.apply({ kind: "compress", ids: ["item-a", "item-b"], into: compactState() });
    expect(result.createdItemIds[0]).toStartWith("compact-");
    expect(context.workingItems()).toHaveLength(1);
    expect(context.sourceItems()).toHaveLength(2);
    context.apply({ kind: "recall", evidenceIds: ["ev-a"] });
    expect(context.workingItems().some((item) => item.id === "item-a")).toBe(true);
  });

  test("offload replaces content with a handle and recall is deterministic", () => {
    const context = operations();
    const result = context.apply({ kind: "offload", ids: ["item-b"], artifactId: "artifact-stdout" });
    expect(result.createdItemIds[0]).toStartWith("offload-");
    expect(context.workingItems().some((item) => item.artifactId === "artifact-stdout")).toBe(true);
    expect(context.offloads()[0]).toMatchObject({ artifactId: "artifact-stdout", sourceItemIds: ["item-b"] });
    context.apply({ kind: "recall", evidenceIds: ["ev-b"] });
    expect(context.workingItems().some((item) => item.id === "item-b")).toBe(true);
  });

  test("rollback restores a checkpoint, preserves requested evidence, and never rewrites its log", () => {
    const context = operations();
    const checkpoint = context.createCheckpoint("before-edit");
    context.apply({ kind: "snippet", id: "item-a", range: { startLine: 2, endLine: 2 } });
    context.apply({ kind: "delete", ids: ["item-b"], reason: "temporary" });
    const beforeLogLength = context.operationLog().length;
    context.apply({ kind: "rollback", checkpointId: checkpoint.id, preserveEvidence: ["ev-a"] });

    expect(context.workingItems().find((item) => item.id === "item-a")?.text).toBe("two");
    expect(context.workingItems().some((item) => item.id === "item-b")).toBe(true);
    expect(context.operationLog()).toHaveLength(beforeLogLength + 1);
    expect(context.rollbackLog()).toHaveLength(1);
    expect(Object.isFrozen(context.rollbackLog())).toBe(true);
    expect(Object.isFrozen(context.rollbackLog()[0])).toBe(true);
    expect(context.rollbackLog()[0]?.checkpointId).toBe("before-edit");
  });

  test("snapshot round-trip preserves working state and immutable operation history", () => {
    const context = operations();
    context.createCheckpoint("initial");
    context.apply({ kind: "delete", ids: ["item-a"], reason: "budget" });
    context.apply({ kind: "recall", evidenceIds: ["ev-a"] });
    const serialized = context.serialize();
    const restored = ContextOperations.deserialize(serialized, {
      now: () => "2026-02-02T00:00:00.000Z",
    });
    expect(restored.serialize()).toBe(serialized);
    expect(restored.workingDigest()).toBe(context.workingDigest());
  });

  test("the public operation validator enforces item/evidence/checkpoint boundaries", () => {
    const context = operations();
    const issues = validateContextOp(
      { kind: "recall", evidenceIds: ["outside"] },
      { allowedEvidenceIds: context.knownEvidenceIds() },
    );
    expect(issues.join(" ")).toContain("outside");
    expect(validateContextOp(
      { kind: "snippet", id: "item-a", range: { startLine: 1, endLine: 2 } },
      { allowedItemIds: context.knownItemIds() },
    )).toHaveLength(0);
  });
});

describe("task-scoped context capsule", () => {
  function capsule() {
    return createTaskContextCapsule({
      taskId: "task-child-1",
      role: "test investigator",
      workspaceIdentity: "workspace-a",
      contract: {
        goal: "investigate parser failure",
        deliverable: "evidence-backed finding",
        allowedPaths: ["src/parser", "test/parser.test.ts"],
        forbiddenPaths: ["src/parser/secrets"],
        forbiddenActions: ["network", "git.push"],
      },
      symbols: [{
        path: "src/parser/index.ts",
        checksum: "abc123",
        symbol: "parse",
        startLine: 10,
        endLine: 40,
        resolution: "body",
        reason: "failing stack points here",
      }],
      evidenceRefs: [{ id: "ev-parser", digest: "digest-parser", freshness: "fresh" }],
      memoryHandles: ["memory-parser-convention"],
      parentDecisions: ["do not change public syntax"],
      budget: { inputTokens: 8_000, outputTokens: 2_000, toolCalls: 12 },
      createdAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-03-02T00:00:00.000Z",
    });
  }

  test("capsule binds budgets, exact refs, and canonical path boundaries into its digest", () => {
    const created = capsule();
    expect(created.exactEvidenceIds).toEqual(["ev-parser"]);
    expect(created.capsuleId).toBe(`context-capsule-${created.digest}`);
    expect(pathAllowedByCapsule(created, "src/parser/index.ts")).toBe(true);
    expect(pathAllowedByCapsule(created, "src/parser/secrets/key.ts")).toBe(false);
    expect(pathAllowedByCapsule(created, "../outside.ts")).toBe(false);
    expect(validateTaskContextCapsule(created, {
      now: "2026-03-01T12:00:00.000Z",
      resolveEvidence: (id) => id === "ev-parser"
        ? { id, digest: "digest-parser", freshness: "fresh" }
        : undefined,
    })).toEqual({ valid: true, issues: [] });
  });

  test("tampering and out-of-bound child paths are rejected", () => {
    const created = capsule();
    const tampered = {
      ...created,
      budget: { ...created.budget, toolCalls: 1_000 },
    };
    expect(validateTaskContextCapsule(tampered).issues).toContain("context capsule digest mismatch");

    const child = validateChildEvidenceResult(created, {
      capsuleDigest: created.digest,
      claims: [{ text: "parse is failing", evidenceIds: ["ev-parser"] }],
      changedPaths: ["src/unrelated.ts"],
      tests: [],
      unresolved: [],
    });
    expect(child.valid).toBe(false);
    expect(child.issues.join(" ")).toContain("outside capsule");
  });

  test("scoped exact bodies are boundary-checked and digest-bound", () => {
    const body = "export const scoped = true;";
    const created = createTaskContextCapsule({
      taskId: "task-scoped-body",
      role: "executor",
      workspaceIdentity: "workspace-a",
      contract: {
        goal: "inspect one scoped source body for the delegated change",
        deliverable: "a scoped implementation finding",
        allowedPaths: ["src/**/*.ts"],
        forbiddenPaths: ["src/private/**"],
        forbiddenActions: ["network"],
      },
      symbols: [],
      evidenceRefs: [{ id: "ev-scoped", digest: "digest-scoped", freshness: "fresh" }],
      scopedExactExcerpts: [{
        evidenceId: "ev-scoped",
        excerptId: `excerpt-${"1".repeat(64)}`,
        path: "src/lib/scoped.ts",
        checksum: "2".repeat(64),
        startLine: 1,
        endLine: 1,
        body,
      }],
      memoryHandles: [],
      parentDecisions: [],
      budget: { inputTokens: 1_000, toolCalls: 4 },
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    const excerpt = created.scopedExactExcerpts?.[0];
    expect(excerpt?.bodyDigest).toBe(scopedExactExcerptBodyDigest(body));
    expect(excerpt?.identityDigest).toBe(scopedExactExcerptIdentityDigest(excerpt!));
    expect(pathAllowedByCapsule(created, "src/lib/scoped.ts")).toBe(true);
    expect(pathAllowedByCapsule(created, "src/private/scoped.ts")).toBe(false);
    expect(validateTaskContextCapsule(created, {
      now: "2026-03-01T12:00:00.000Z",
      resolveEvidence: (id) => ({ id, digest: "digest-scoped", freshness: "fresh" }),
    })).toEqual({ valid: true, issues: [] });

    const tampered = {
      ...created,
      scopedExactExcerpts: [{ ...excerpt!, body: "tampered" }],
    };
    expect(validateTaskContextCapsule(tampered).issues.join(" ")).toContain("body digest mismatch");
    expect(validateTaskContextCapsule(tampered).issues.join(" ")).toContain("capsule digest mismatch");
  });
});
