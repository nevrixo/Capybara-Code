import { describe, expect, test } from "bun:test";

import {
  TaskEpochManager,
  type EpochChangeSet,
  type EpochResetReason,
  type EpochStartInput,
} from "../src/epoch.ts";

const START: EpochStartInput = {
  goalDigest: "goal-a",
  constraintDigest: "constraints-a",
  assumptionDigest: "assumptions-a",
  policyDigest: "policy-a",
  workspaceIdentityDigest: "workspace-a",
  toolsetDigest: "tools-a",
  modelId: "model-a",
  modelCapabilityDigest: "capability-a",
  now: "2026-01-01T00:00:00.000Z",
};

function manager(): TaskEpochManager {
  return new TaskEpochManager({ initial: START, now: () => "2026-01-01T00:00:01.000Z" });
}

describe("TaskEpochManager", () => {
  test("an unchanged transition is not reported as an initial reset and restores stable continuity", () => {
    const epochs = manager();
    const reset = epochs.transition({ goalChanged: true, goalDigest: "goal-b" });
    expect(reset.current.reasoningScope.continuity).toBe("current_turn");

    const unchanged = epochs.transition({ goalDigest: "goal-b" });
    expect(unchanged.reset).toBe(false);
    expect(unchanged.reason).toBe("unchanged");
    expect(unchanged.current.id).toBe(reset.current.id);
    expect(unchanged.current.reasoningScope).toMatchObject({
      continuity: "all_turns",
      goalStable: true,
      hypothesisInvalidated: false,
      allTurnsContinuity: true,
      reviewerRequested: false,
    });
  });

  test("preserves constraint, assumption, and capability digests when another signal resets the epoch", () => {
    const transition = manager().transition({ goalChanged: true, goalDigest: "goal-b" });
    expect(transition.current).toMatchObject({
      constraintDigest: START.constraintDigest,
      assumptionDigest: START.assumptionDigest,
      modelCapabilityDigest: START.modelCapabilityDigest,
    });
  });

  test("marks every unsafe reset reason as current-turn continuity", () => {
    const cases: ReadonlyArray<readonly [EpochResetReason, EpochChangeSet]> = [
      ["goal_changed", { goalChanged: true }],
      ["policy_changed", { policyChanged: true }],
      ["workspace_changed", { workspaceChanged: true }],
      ["toolset_changed", { toolsetChanged: true }],
      ["model_changed", { modelChanged: true }],
      ["hypothesis_invalidated", { hypothesisInvalidated: true }],
      ["review_requested", { reviewRequested: true }],
      ["priority_changed", { priorityChanged: true }],
      ["reflection_requested", { reflectionRequested: true }],
      ["assumption_invalidated", { assumptionInvalidated: true }],
      ["constraint_changed", { constraintChanged: true }],
      ["workspace_stale", { workspaceStale: true }],
      ["capability_changed", { modelCapabilityChanged: true }],
    ];

    for (const [reason, change] of cases) {
      const transition = manager().transition(change);
      expect(transition.reset, reason).toBe(true);
      expect(transition.reason, reason).toBe(reason);
      expect(transition.current.reasoningScope.continuity, reason).toBe("current_turn");
    }
  });

  test("does not invalidate an epoch for an ordinary correction with no invalidation signal", () => {
    const epochs = manager();
    const before = epochs.requireCurrent();
    const transition = epochs.transition({});
    expect(transition).toMatchObject({ reset: false, reason: "unchanged" });
    expect(transition.current.id).toBe(before.id);
  });

  test("uses deterministic reset priority when multiple unsafe signals arrive together", () => {
    const transition = manager().transition({
      goalChanged: true,
      policyChanged: true,
      workspaceStale: true,
      hypothesisInvalidated: true,
    });
    expect(transition.reason).toBe("workspace_stale");
  });
});
