import { describe, expect, test } from "bun:test";

import {
  buildCohortManifest,
  checkCohortManifest,
  validateCohortManifestShape,
} from "../src/cohort-manifest.ts";

const BENCH = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/u, "$1")
  .replace(/\/+$/u, "");

describe("benchmark cohort manifest", () => {
  test("builds a deterministic canonical identity for all 150 tasks", async () => {
    const first = await buildCohortManifest(BENCH);
    const second = await buildCohortManifest(BENCH);

    expect(validateCohortManifestShape(first)).toEqual([]);
    expect(first.taskCount).toBe(150);
    expect(first.digest).toBe(second.digest);
    expect(first.tasks).toEqual(second.tasks);
    expect(first.tasks.filter((task) => task.snapshotKind === "physical")).toHaveLength(1);
    expect(first.tasks.filter((task) => task.snapshotKind === "generated")).toHaveLength(149);
    expect(first.tasks.every((task) => /^[0-9a-f]{64}$/u.test(task.taskDigest))).toBe(true);
    expect(first.tasks.every((task) => /^[0-9a-f]{64}$/u.test(task.snapshotDigest))).toBe(true);
  });

  test("checked-in manifest exactly matches prompts, contracts, and snapshots", async () => {
    const result = await checkCohortManifest(BENCH);
    expect(result.ok, `run cbc-bench manifest; current digest ${result.current.digest}`).toBe(true);
    expect(validateCohortManifestShape(result.expected!)).toEqual([]);
  });

  test("shape validation rejects category and digest tampering", async () => {
    const manifest = await buildCohortManifest(BENCH);
    const tampered = {
      ...manifest,
      digest: "not-a-digest",
      categoryTargets: {
        ...manifest.categoryTargets,
        security_safety: 14,
      },
    };
    const errors = validateCohortManifestShape(tampered);

    expect(errors).toContain("category target mismatch for security_safety");
    expect(errors).toContain("digest must be SHA-256 hex");
  });
});

describe("§5.27 cohort manifest", () => {
  test("digests the second cohort under its own key without moving the release digest", async () => {
    const manifest = await buildCohortManifest(BENCH);

    expect(validateCohortManifestShape(manifest)).toEqual([]);
    // The release identity is still exactly the 150 tasks: adding a cohort must not look
    // like the release cohort changed.
    expect(manifest.taskCount).toBe(150);
    expect(manifest.tasks).toHaveLength(150);
    expect(manifest.openAiNativeCohort.taskCount).toBe(11);
    expect(manifest.openAiNativeCohort.digest).not.toBe(manifest.digest);

    const releaseIds = new Set(manifest.tasks.map((task) => task.id));
    for (const task of manifest.openAiNativeCohort.tasks) {
      expect(releaseIds.has(task.id)).toBe(false);
      expect(task.snapshotKind).toBe("generated");
      expect(task.snapshotDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("shape validation rejects a tampered or colliding second cohort", async () => {
    const manifest = await buildCohortManifest(BENCH);

    expect(validateCohortManifestShape({
      ...manifest,
      openAiNativeCohort: { ...manifest.openAiNativeCohort, taskCount: 12 },
    })).toContain("openAiNativeCohort tasks length must equal its taskCount");

    const collided = {
      ...manifest,
      openAiNativeCohort: {
        ...manifest.openAiNativeCohort,
        tasks: [
          { ...manifest.openAiNativeCohort.tasks[0]!, id: manifest.tasks[0]!.id },
          ...manifest.openAiNativeCohort.tasks.slice(1),
        ],
      },
    };
    expect(validateCohortManifestShape(collided))
      .toContain(`openAiNativeCohort task ${manifest.tasks[0]!.id} collides with a release cohort task`);
  });
});
