/** Release-cohort integrity and generated-snapshot determinism. */

import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";

import {
  CATEGORY_TARGETS,
  OPENAI_NATIVE_CATEGORY_MAPPING,
  OPENAI_NATIVE_TASK_CATEGORIES,
  TARGET_TASK_COUNT,
  TASK_CATEGORIES,
  suiteCoverage,
  validateTask,
} from "@cbc/evals";

import {
  generatedSnapshotFiles,
  generatedSnapshotManifest,
} from "../src/generated-fixtures.ts";
import { OPENAI_NATIVE_SUITE, SUITE, cohortTasks, selectTasks } from "../src/suite.ts";

const BENCH = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/u, "$1")
  .replace(/\/+$/u, "");

describe("release benchmark cohort", () => {
  test("contains the exact 150-task category distribution", () => {
    const coverage = suiteCoverage(SUITE);

    expect(coverage.total).toBe(TARGET_TASK_COUNT);
    expect(TARGET_TASK_COUNT).toBe(150);
    expect(coverage.meetsTarget).toBe(true);
    expect(coverage.shortfalls).toEqual([]);
    for (const category of TASK_CATEGORIES) {
      expect(coverage.byCategory[category], `category ${category}`).toBe(CATEGORY_TARGETS[category]);
    }
  });

  test("every task validates and every id is unique", () => {
    for (const task of SUITE) {
      expect(validateTask(task), `task ${task.id}`).toEqual([]);
    }
    expect(new Set(SUITE.map((task) => task.id)).size).toBe(SUITE.length);
  });

  test("physical snapshots exist; generated snapshots are deterministic and unique", async () => {
    const generatedDigests = new Set<string>();
    for (const task of SUITE) {
      if (task.generatedSnapshot === undefined) {
        const info = await stat(`${BENCH}/${task.snapshot}`).catch(() => undefined);
        expect(info?.isDirectory(), `physical snapshot for ${task.id}`).toBe(true);
        continue;
      }

      expect(task.snapshot).toBe(`generated/${task.id}`);
      const first = generatedSnapshotManifest(task);
      const second = generatedSnapshotManifest(task);
      expect(first).toEqual(second);
      expect(first.fileCount).toBeGreaterThan(0);
      expect(first.files.every((file) => file.path.length > 0 && !file.path.includes(".."))).toBe(true);
      expect(generatedDigests.has(first.digest), `duplicate generated snapshot ${task.id}`).toBe(false);
      generatedDigests.add(first.digest);
    }
    expect(generatedDigests.size).toBe(TARGET_TASK_COUNT - 1);
  });

  test("generated hidden acceptance is not copied into agent-visible snapshots", () => {
    for (const task of SUITE.filter((entry) => entry.generatedSnapshot !== undefined)) {
      const files = generatedSnapshotFiles(task);
      expect(Object.keys(files).some((path) => /check|acceptance|hidden/iu.test(path))).toBe(false);
      expect(Object.keys(files).some((path) => path.split(/[\\/]/u).includes("node_modules"))).toBe(false);
      if (task.category === "diff_review") {
        expect(task.acceptance).toEqual([]);
      } else {
        expect(task.acceptance).toEqual([
          { program: "cbc-bench-check", args: [], timeoutMs: 30_000 },
        ]);
      }
    }
  });

  test("a task with an expected approval is reachable outside Plan mode", () => {
    for (const task of SUITE) {
      if ((task.expectedApprovals ?? []).length === 0) continue;
      expect(task.permissionMode, `task ${task.id}`).not.toBe("plan");
    }
  });

  test("mutating categories declare a non-empty expected scope", () => {
    for (const task of SUITE) {
      expect(task.expectedScope.length, `task ${task.id}`).toBeGreaterThan(0);
    }
  });

  test("selectTasks matches ids, every category, and every represented language", () => {
    expect(selectTasks("all")).toHaveLength(TARGET_TASK_COUNT);
    expect(selectTasks("bf-off-by-one").map((task) => task.id)).toEqual(["bf-off-by-one"]);
    for (const category of TASK_CATEGORIES) {
      expect(selectTasks(category)).toHaveLength(CATEGORY_TARGETS[category]);
    }
    for (const language of new Set(SUITE.map((task) => task.language))) {
      expect(selectTasks(language).every((task) => task.language === language)).toBe(true);
    }
    expect(selectTasks("nonexistent")).toEqual([]);
  });
});

describe("physical smoke snapshot hygiene", () => {
  test("the hand-authored fixture has an orientation point and no node_modules", async () => {
    const task = SUITE.find((entry) => entry.generatedSnapshot === undefined);
    expect(task).toBeDefined();
    const entries = await readdir(`${BENCH}/${task!.snapshot}`);
    expect(entries.some((entry) => ["AGENTS.md", "package.json", "Cargo.toml", "README.md"].includes(entry)))
      .toBe(true);
    expect(entries).not.toContain("node_modules");
  });
});

describe("§5.27 openai-native cohort", () => {
  test("covers all eleven §5.27 shapes without touching the 150-task release mix", () => {
    expect(OPENAI_NATIVE_SUITE).toHaveLength(11);
    expect(OPENAI_NATIVE_TASK_CATEGORIES).toHaveLength(11);
    expect(SUITE).toHaveLength(TARGET_TASK_COUNT);
    expect(suiteCoverage(SUITE).meetsTarget).toBe(true);

    // Every cohort task is a distinct fixture, and none of them leaked into SUITE.
    const releaseIds = new Set(SUITE.map((task) => task.id));
    for (const task of OPENAI_NATIVE_SUITE) {
      expect(releaseIds.has(task.id), `cohort task ${task.id} leaked into SUITE`).toBe(false);
    }
    for (const kind of OPENAI_NATIVE_TASK_CATEGORIES) {
      const id = `on-${kind.replaceAll("_", "-")}`;
      const task = OPENAI_NATIVE_SUITE.find((entry) => entry.id === id);
      expect(task, `missing cohort task for ${kind}`).toBeDefined();
      expect(task!.category).toBe(OPENAI_NATIVE_CATEGORY_MAPPING[kind]);
    }
  });

  test("every cohort task validates and its generated snapshot is deterministic", () => {
    const digests = new Set<string>();
    for (const task of OPENAI_NATIVE_SUITE) {
      expect(validateTask(task), `task ${task.id}`).toEqual([]);
      expect(task.snapshot).toBe(`generated/${task.id}`);
      const first = generatedSnapshotManifest(task);
      expect(first).toEqual(generatedSnapshotManifest(task));
      expect(first.fileCount).toBeGreaterThan(0);
      expect(digests.has(first.digest), `duplicate snapshot ${task.id}`).toBe(false);
      digests.add(first.digest);

      const files = generatedSnapshotFiles(task);
      expect(Object.keys(files).some((path) => /check|acceptance|hidden/iu.test(path))).toBe(false);
    }
    expect(digests.size).toBe(11);
  });

  test("only the redirect task scripts a follow-up prompt", () => {
    const withFollowUps = OPENAI_NATIVE_SUITE.filter(
      (task) => (task.followUpPrompts ?? []).length > 0,
    );
    expect(withFollowUps.map((task) => task.id)).toEqual(["on-mid-turn-redirect"]);
    expect(withFollowUps[0]!.followUpPrompts![0]).toContain("redirected.txt");
    expect(SUITE.some((task) => (task.followUpPrompts ?? []).length > 0)).toBe(false);
  });

  test("the cohort is a separate selection axis from the filter", () => {
    expect(cohortTasks("release")).toHaveLength(TARGET_TASK_COUNT);
    expect(cohortTasks("openai-native")).toHaveLength(11);
    expect(selectTasks("all", "openai-native")).toHaveLength(11);
    expect(selectTasks("on-ptc-aggregation", "openai-native").map((task) => task.id))
      .toEqual(["on-ptc-aggregation"]);
    // A release-cohort filter must not start matching cohort tasks that reuse its
    // categories.
    expect(selectTasks("repository_understanding"))
      .toHaveLength(CATEGORY_TARGETS.repository_understanding);
    expect(selectTasks("on-ptc-aggregation")).toEqual([]);
  });
});
