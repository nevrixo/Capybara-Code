import { describe, expect, test } from "bun:test";

import { MergeCoordinator, containsConflictMarkers } from "../src/merge-coordinator.ts";
import { WorktreeManager, WorktreeManagerError } from "../src/worktree-manager.ts";

describe("worktree one-writer and merge apply", () => {
  test("refuses a second writer lease on the same worktree", () => {
    const manager = new WorktreeManager({ now: () => "2026-08-25T00:00:00.000Z" });
    manager.create({
      id: "wt_a",
      workspaceIdentityDigest: "ws_1",
      path: "/tmp/wt-a",
      baseCommit: "abc",
      baseWorkspaceRevision: "1",
    });
    manager.acquireWriterLease({
      leaseId: "lease_1",
      worktreeId: "wt_a",
      nodeId: "agt_one",
      ownerEpoch: 1,
      allowedPaths: ["src/a.ts"],
    });
    expect(() => manager.acquireWriterLease({
      leaseId: "lease_2",
      worktreeId: "wt_a",
      nodeId: "agt_two",
      ownerEpoch: 1,
      allowedPaths: ["src/b.ts"],
    })).toThrow(WorktreeManagerError);
  });

  test("applies disjoint writers through the Edit Engine plan without conflict markers", () => {
    const merge = new MergeCoordinator({ now: () => "2026-08-25T00:00:00.000Z", newId: () => "mrg_1" });
    const applied = merge.apply([
      { path: "src/a.ts", baseText: "export const a = 1;\n", oursText: "export const a = 2;\n", theirsText: "export const a = 1;\n" },
      { path: "src/b.ts", baseText: "export const b = 1;\n", oursText: "export const b = 1;\n", theirsText: "export const b = 3;\n" },
    ], { "src/a.ts": "rev_a", "src/b.ts": "rev_b" });
    expect(applied.applied).toBe(true);
    expect(applied.conflicts).toHaveLength(0);
    const plan = merge.toEditEnginePlan(applied, {
      sessionId: "ses_1",
      workspaceIdentityDigest: "ws_1",
      revisions: { "src/a.ts": "rev_a", "src/b.ts": "rev_b" },
    });
    expect(plan).toBeDefined();
    const operations = plan!.operations as Array<{ kind: string; content?: string }>;
    expect(operations.some((operation) => operation.kind === "create_file")).toBe(true);
    expect(operations.every((operation) =>
      typeof operation.content !== "string" || !containsConflictMarkers(operation.content),
    )).toBe(true);
  });

  test("fails closed when both writers edit the same file", () => {
    const merge = new MergeCoordinator({ now: () => "2026-08-25T00:00:00.000Z", newId: () => "mrg_2" });
    const applied = merge.apply([
      { path: "src/a.ts", baseText: "one", oursText: "two", theirsText: "three" },
    ]);
    expect(applied.applied).toBe(false);
    expect(applied.conflicts).toHaveLength(1);
    expect(merge.toEditEnginePlan(applied, {
      sessionId: "ses_1",
      workspaceIdentityDigest: "ws_1",
    })).toBeUndefined();
  });
});
