import { describe, expect, test } from "bun:test";

import {
  ContextEngine,
  createContextScope,
  evidenceDigest,
  exportContextHandoff,
  importContextHandoff,
  validateContextHandoff,
} from "../src/index.ts";

function makeEngine(): ContextEngine {
  return new ContextEngine({
    reader: { read: async () => undefined },
    softContextTokens: 8_000,
    activeExcerptTokens: 1_200,
  });
}

function makeScope(scopeId: string, agentId: string, engine = makeEngine()) {
  return createContextScope({
    scopeId,
    agentId,
    ...(agentId === "root" ? {} : { parentScopeId: "ctx_root", taskId: "task-" + agentId }),
    createdGeneration: 1,
    engine,
  });
}

describe("agent context scopes and validated handoffs", () => {
  test("keeps child semantic state private until an accepted handoff", () => {
    const root = makeScope("ctx_root", "root");
    const child = makeScope("ctx_child", "agent_child");
    expect(root.engine).not.toBe(child.engine);

    const childRecord = child.engine.recordEvidence({
      id: "evidence-child-read",
      kind: "file_excerpt",
      locator: "src/child.ts#L1",
      digest: evidenceDigest("child-body"),
      summary: "child read",
      metadata: { path: "src/child.ts" },
      provenance: {
        agentId: "agent_child",
        taskId: "task-agent_child",
        callId: "child-read",
        observedAt: "2026-08-21T00:00:00.000Z",
        cacheHit: false,
        source: "local",
      },
    });
    const rootDigestBefore = root.engine.contextDigest();
    expect(root.engine.evidence.all()).toHaveLength(0);

    const handoff = exportContextHandoff(child, {
      taskId: "task-agent_child",
      parentScopeId: "ctx_root",
      seedCapsuleDigest: "capsule-digest",
      baseGeneration: 1,
      completionGeneration: 1,
      status: "completed",
      claims: ["child read completed"],
      allowedPaths: ["src"],
      now: "2026-08-21T00:00:01.000Z",
    });
    expect(handoff.evidence.map((entry) => entry.id)).toContain(childRecord.id);
    expect(root.engine.contextDigest()).toBe(rootDigestBefore);

    const validation = validateContextHandoff(handoff, {
      parentScopeId: "ctx_root",
      expectedTaskId: "task-agent_child",
      expectedSourceAgentId: "agent_child",
      expectedSeedCapsuleDigest: "capsule-digest",
      currentGeneration: 1,
      allowedPaths: ["src"],
      forbiddenPaths: [],
    });
    expect(validation.valid).toBe(true);

    const imported = importContextHandoff(root, handoff, {
      parentScopeId: "ctx_root",
      expectedTaskId: "task-agent_child",
      expectedSourceAgentId: "agent_child",
      expectedSeedCapsuleDigest: "capsule-digest",
      currentGeneration: 1,
      allowedPaths: ["src"],
      forbiddenPaths: [],
    });
    expect(imported.accepted).toBe(true);
    expect(imported.importedEvidenceIds).toContain(childRecord.id);
    const importedRecord = root.engine.evidence.get(childRecord.id as any);
    expect(importedRecord?.provenance?.firstObservedBy).toBe("agent_child");
    expect(importedRecord?.provenance?.importedFromHandoffIds).toEqual([handoff.handoffId]);

    const duplicate = importContextHandoff(root, handoff, {
      parentScopeId: "ctx_root",
      expectedTaskId: "task-agent_child",
      expectedSourceAgentId: "agent_child",
      expectedSeedCapsuleDigest: "capsule-digest",
      currentGeneration: 1,
      allowedPaths: ["src"],
      forbiddenPaths: [],
    });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.alreadyConsumed).toBe(true);
  });

  test("retains append-only provenance when a cache hit repeats the same fact", () => {
    const root = makeScope("ctx_root", "root");
    const digest = evidenceDigest("same-fact");
    root.engine.recordEvidence({
      id: "evidence-shared",
      kind: "tool_observation",
      locator: "src/shared.ts",
      digest,
      summary: "root observation",
      provenance: {
        agentId: "root",
        callId: "root-read",
        observedAt: "2026-08-21T00:00:00.000Z",
        cacheHit: false,
        source: "local",
      },
    });
    const repeated = root.engine.recordEvidence({
      id: "evidence-shared",
      kind: "tool_observation",
      locator: "src/shared.ts",
      digest,
      summary: "cache-hit observation",
      provenance: {
        agentId: "agent_child",
        taskId: "task-child",
        callId: "child-read",
        observedAt: "2026-08-21T00:00:02.000Z",
        cacheHit: true,
        source: "local",
      },
    });
    expect(repeated.provenance?.firstObservedBy).toBe("root");
    expect(repeated.provenance?.observations).toHaveLength(2);
    expect(repeated.provenance?.observations.at(-1)?.agentId).toBe("agent_child");
    expect(repeated.provenance?.observations.at(-1)?.cacheHit).toBe(true);
  });

  test("rejects stale or unauthorized handoffs before importing exact bodies", () => {
    const child = makeScope("ctx_child", "agent_child");
    child.engine.recordEvidence({
      id: "evidence-outside",
      kind: "file_excerpt",
      locator: "private/secret.ts#L1",
      digest: evidenceDigest("secret"),
      summary: "outside authority",
      metadata: { path: "private/secret.ts" },
      provenance: {
        agentId: "agent_child",
        taskId: "task-agent_child",
        callId: "read-secret",
        observedAt: "2026-08-21T00:00:00.000Z",
        cacheHit: false,
        source: "local",
      },
    });
    const handoff = exportContextHandoff(child, {
      taskId: "task-agent_child",
      parentScopeId: "ctx_root",
      seedCapsuleDigest: "capsule-digest",
      baseGeneration: 1,
      completionGeneration: 1,
      status: "completed",
      allowedPaths: ["private"],
      now: "2026-08-21T00:00:01.000Z",
    });
    const stale = validateContextHandoff(handoff, {
      parentScopeId: "ctx_root",
      expectedTaskId: "task-agent_child",
      expectedSourceAgentId: "agent_child",
      expectedSeedCapsuleDigest: "capsule-digest",
      currentGeneration: 2,
      allowedPaths: ["src"],
      forbiddenPaths: [],
    });
    expect(stale.valid).toBe(false);
    expect(stale.issues).toEqual(expect.arrayContaining([
      "context handoff generation is stale",
      "context handoff evidence path is outside authority: private/secret.ts",
    ]));
  });

  test("disposal clears child evidence, exact bodies, and consumed state", () => {
    const child = makeScope("ctx_child", "agent_child");
    child.engine.addExcerpt({
      path: "src/child.ts",
      text: "export const child = true;",
      checksum: "a".repeat(64),
      startLine: 1,
      totalLines: 1,
    }, { relevanceScore: 100, leaseForNextCompiledPack: true, leaseOwner: "agent_child" });
    child.engine.recordEvidence({
      id: "evidence-child",
      kind: "file_excerpt",
      locator: "src/child.ts#L1",
      digest: evidenceDigest("child"),
      summary: "child body",
      provenance: {
        agentId: "agent_child",
        callId: "child-read",
        observedAt: "2026-08-21T00:00:00.000Z",
        cacheHit: false,
        source: "local",
      },
    });
    expect(child.engine.excerpts.excerpts().length).toBe(1);
    child.markTerminal();
    child.dispose();
    expect(child.lifecycle).toBe("disposed");
    expect(child.engine.evidence.all()).toHaveLength(0);
    expect(child.engine.excerpts.excerpts()).toHaveLength(0);
    expect(child.consumedHandoffIds).toEqual([]);
  });
});