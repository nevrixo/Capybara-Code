/** Canonical identity for the 150-task release benchmark cohort. */

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
import { SUITE } from "./suite.ts";

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

export interface CohortManifest {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly taskCount: number;
  readonly categoryTargets: Readonly<Record<TaskCategory, number>>;
  readonly tasks: readonly CohortTaskManifest[];
  readonly digest: string;
}

export async function buildCohortManifest(
  benchmarkRoot: string,
  tasks: readonly BenchTask[] = SUITE,
): Promise<CohortManifest> {
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
        snapshotDigest,
      })),
    });
  }
  const body = {
    schemaVersion: "1.0" as const,
    taskCount: entries.length,
    categoryTargets: { ...CATEGORY_TARGETS },
    tasks: entries,
  };
  return {
    ...body,
    generatedAt: new Date().toISOString(),
    digest: sha256(canonicalValue(body)),
  };
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
  const expectedComparable = canonicalValue({
    schemaVersion: expected.schemaVersion,
    taskCount: expected.taskCount,
    categoryTargets: expected.categoryTargets,
    tasks: expected.tasks,
    digest: expected.digest,
  });
  const currentComparable = canonicalValue({
    schemaVersion: current.schemaVersion,
    taskCount: current.taskCount,
    categoryTargets: current.categoryTargets,
    tasks: current.tasks,
    digest: current.digest,
  });
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
