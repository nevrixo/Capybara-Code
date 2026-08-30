/** Canonical identity for the benchmark cohorts: the 150-task release set and §5.27's. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CATEGORY_TARGETS,
  TARGET_TASK_COUNT,
  type BenchTask,
  type TaskCategory,
} from "@cbc/evals";

import { generatedSnapshotManifest } from "./generated-fixtures.ts";
import { OPENAI_NATIVE_SUITE, SUITE } from "./suite.ts";

export const COHORT_MANIFEST_PATH = "benchmarks/cbc-bench/cohort-manifest.json";

export interface CohortTaskManifest {
  readonly id: string;
  readonly category: TaskCategory;
  readonly language: string;
  readonly snapshot: string;
  readonly snapshotKind: "physical" | "generated";
  readonly snapshotDigest: string;
  readonly taskDigest: string;
}

/**
 * §5.27's additional cohort, digested under its own key.
 *
 * Kept beside the release body rather than inside it so `digest` stays a digest of
 * exactly the 150 release tasks. An artifact produced before this cohort existed still
 * carries the same release digest, which is the point: adding a second cohort must not
 * look like the release cohort changed.
 */
export interface OpenAiNativeCohortManifest {
  readonly taskCount: number;
  readonly tasks: readonly CohortTaskManifest[];
  readonly digest: string;
}

export interface CohortManifest {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly taskCount: number;
  readonly categoryTargets: Readonly<Record<TaskCategory, number>>;
  readonly tasks: readonly CohortTaskManifest[];
  readonly digest: string;
  readonly openAiNativeCohort: OpenAiNativeCohortManifest;
}

export async function buildCohortManifest(
  benchmarkRoot: string,
  tasks: readonly BenchTask[] = SUITE,
  openAiNativeTasks: readonly BenchTask[] = OPENAI_NATIVE_SUITE,
): Promise<CohortManifest> {
  const entries = await cohortEntries(benchmarkRoot, tasks);
  const openAiNativeEntries = await cohortEntries(benchmarkRoot, openAiNativeTasks);
  const body = {
    schemaVersion: "1.0" as const,
    taskCount: entries.length,
    categoryTargets: { ...CATEGORY_TARGETS },
    tasks: entries,
  };
  const openAiNativeBody = {
    taskCount: openAiNativeEntries.length,
    tasks: openAiNativeEntries,
  };
  return {
    ...body,
    generatedAt: new Date().toISOString(),
    digest: sha256(canonicalValue(body)),
    openAiNativeCohort: {
      ...openAiNativeBody,
      digest: sha256(canonicalValue(openAiNativeBody)),
    },
  };
}

async function cohortEntries(
  benchmarkRoot: string,
  tasks: readonly BenchTask[],
): Promise<CohortTaskManifest[]> {
  const entries: CohortTaskManifest[] = [];
  for (const task of tasks) {
    const snapshotDigest = task.generatedSnapshot === undefined
      ? await digestPhysicalSnapshot(join(benchmarkRoot, task.snapshot))
      : generatedSnapshotManifest(task).digest;
    entries.push({
      id: task.id,
      category: task.category,
      language: task.language,
      snapshot: task.snapshot,
      snapshotKind: task.generatedSnapshot === undefined ? "physical" : "generated",
      snapshotDigest,
      taskDigest: sha256(canonicalValue({
        id: task.id,
        category: task.category,
        language: task.language,
        title: task.title,
        snapshot: task.snapshot,
        generatedSnapshot: task.generatedSnapshot,
        prompt: task.prompt,
        acceptance: task.acceptance,
        network: task.network,
        expectedScope: task.expectedScope,
        expectedEvidence: task.expectedEvidence,
        budget: task.budget,
        risks: task.risks,
        permissionMode: task.permissionMode,
        expectedApprovals: task.expectedApprovals,
        expectedStatus: task.expectedStatus,
        // Spread conditionally rather than declared: canonicalValue emits a key whose
        // value is undefined, so an unconditional field would change every release
        // task's digest for a property none of them has.
        ...(task.followUpPrompts !== undefined
          ? { followUpPrompts: task.followUpPrompts }
          : {}),
        snapshotDigest,
      })),
    });
  }
  return entries;
}

export async function checkCohortManifest(
  benchmarkRoot: string,
  manifestPath = join(benchmarkRoot, "cohort-manifest.json"),
): Promise<{ readonly ok: boolean; readonly expected?: CohortManifest; readonly current: CohortManifest }> {
  const current = await buildCohortManifest(benchmarkRoot);
  let expected: CohortManifest | undefined;
  try {
    expected = JSON.parse(await readFile(manifestPath, "utf8")) as CohortManifest;
  } catch {
    return { ok: false, current };
  }
  const comparable = (manifest: CohortManifest): string => canonicalValue({
    schemaVersion: manifest.schemaVersion,
    taskCount: manifest.taskCount,
    categoryTargets: manifest.categoryTargets,
    tasks: manifest.tasks,
    digest: manifest.digest,
    openAiNativeCohort: manifest.openAiNativeCohort,
  });
  const expectedComparable = comparable(expected);
  const currentComparable = comparable(current);
  return { ok: expectedComparable === currentComparable, expected, current };
}

export function validateCohortManifestShape(manifest: CohortManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (manifest.taskCount !== TARGET_TASK_COUNT) {
    errors.push(`taskCount must be ${TARGET_TASK_COUNT}`);
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== manifest.taskCount) {
    errors.push("tasks length must equal taskCount");
  }
  for (const category of Object.keys(CATEGORY_TARGETS) as TaskCategory[]) {
    if (manifest.categoryTargets[category] !== CATEGORY_TARGETS[category]) {
      errors.push(`category target mismatch for ${category}`);
    }
    const actual = manifest.tasks.filter((task) => task.category === category).length;
    if (actual !== CATEGORY_TARGETS[category]) {
      errors.push(`category ${category} contains ${actual}, expected ${CATEGORY_TARGETS[category]}`);
    }
  }
  if (new Set(manifest.tasks.map((task) => task.id)).size !== manifest.tasks.length) {
    errors.push("task ids must be unique");
  }
  for (const task of manifest.tasks) {
    if (!/^[0-9a-f]{64}$/u.test(task.taskDigest)) {
      errors.push(`task ${task.id} taskDigest must be SHA-256 hex`);
    }
    if (!/^[0-9a-f]{64}$/u.test(task.snapshotDigest)) {
      errors.push(`task ${task.id} snapshotDigest must be SHA-256 hex`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.digest)) {
    errors.push("digest must be SHA-256 hex");
  } else {
    const body = {
      schemaVersion: manifest.schemaVersion,
      taskCount: manifest.taskCount,
      categoryTargets: manifest.categoryTargets,
      tasks: manifest.tasks,
    };
    if (sha256(canonicalValue(body)) !== manifest.digest) {
      errors.push("digest does not match the canonical cohort manifest body");
    }
  }

  // The §5.27 cohort has no category distribution to enforce — it is one task per shape
  // by construction — so only its identity and its own digest are checked.
  const cohort = manifest.openAiNativeCohort;
  if (cohort === undefined || !Array.isArray(cohort.tasks)) {
    errors.push("openAiNativeCohort must carry its own task list");
    return errors;
  }
  if (cohort.tasks.length !== cohort.taskCount) {
    errors.push("openAiNativeCohort tasks length must equal its taskCount");
  }
  if (new Set(cohort.tasks.map((task) => task.id)).size !== cohort.tasks.length) {
    errors.push("openAiNativeCohort task ids must be unique");
  }
  const releaseIds = new Set(manifest.tasks.map((task) => task.id));
  for (const task of cohort.tasks) {
    if (releaseIds.has(task.id)) {
      errors.push(`openAiNativeCohort task ${task.id} collides with a release cohort task`);
    }
    if (!/^[0-9a-f]{64}$/u.test(task.taskDigest) || !/^[0-9a-f]{64}$/u.test(task.snapshotDigest)) {
      errors.push(`openAiNativeCohort task ${task.id} digests must be SHA-256 hex`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(cohort.digest)) {
    errors.push("openAiNativeCohort digest must be SHA-256 hex");
  } else if (
    sha256(canonicalValue({ taskCount: cohort.taskCount, tasks: cohort.tasks })) !== cohort.digest
  ) {
    errors.push("openAiNativeCohort digest does not match its canonical body");
  }
  return errors;
}

async function digestPhysicalSnapshot(root: string): Promise<string> {
  const files: Array<{ readonly path: string; readonly bytes: number; readonly sha256: string }> = [];
  const glob = new Bun.Glob("**/*");
  for await (const relative of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
    const normalized = relative.replaceAll("\\", "/");
    if (normalized.split("/").includes("node_modules")) continue;
    const bytes = new Uint8Array(await Bun.file(join(root, relative)).arrayBuffer());
    files.push({ path: normalized, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return sha256(canonicalValue(files));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(record[key])}`
  ).join(",")}}`;
}
