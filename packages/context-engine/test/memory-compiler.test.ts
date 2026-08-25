import { describe, expect, test } from "bun:test";

import { ContextEngine, MemoryBank, type MemoryEvidence } from "../src/index.ts";

function reader(): { read(path: string): Promise<string | undefined> } {
  return { read: async () => undefined };
}

describe("durable memory compiler injection", () => {
  test("active memory becomes a memory_handles segment and contested memory does not", async () => {
    const evidence = new Map<string, MemoryEvidence>([
      ["evidence-ok", {
        id: "evidence-ok",
        freshness: "fresh",
        observedAt: "2026-01-01T00:00:00.000Z",
        exact: true,
        workspaceIdentityDigest: "ws-a",
        digest: "digest-ok",
      }],
    ]);
    const bank = new MemoryBank({
      resolveEvidence: (id) => evidence.get(id),
      workspaceIdentity: "ws-a",
      sessionId: "ses-1",
    });
    expect(bank.write({
      key: "build.command",
      value: "bun test",
      scope: "workspace",
      confidence: 0.9,
      evidenceIds: ["evidence-ok"],
      validFor: { workspaceIdentity: "ws-a" },
    }).accepted).toBe(true);

    const engine = new ContextEngine({
      reader: reader(),
      softContextTokens: 8_000,
      workspaceIdentityDigest: "ws-a",
    });
    engine.attachMemory(bank, 8);
    const pack = await engine.prepareSample({
      goal: "run tests",
      phase: "investigate",
      mentionedPaths: [],
      mentionedSymbols: [],
      changedPaths: [],
      recentFailureRefs: [],
      workspaceIdentity: "ws-a",
      budget: {
        modelContextLimit: 8_000,
        outputReserve: 1_000,
        hardInputLimit: 4_000,
        targetInputTokens: 2_000,
        exactEvidenceFloor: 0,
        explorationCeiling: 1_000,
      },
    });
    expect(pack.memoryHandles.some((segment) => segment.item.kind === "memory")).toBe(true);
    expect(pack.manifest.included.some((entry) => entry.id.startsWith("memory-"))).toBe(true);
  });
});
