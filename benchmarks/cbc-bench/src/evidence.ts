import { createHash } from "node:crypto";

import { checkSourceTruth } from "../../../scripts/source-truth.ts";

import {
  checkCohortManifest,
  validateCohortManifestShape,
  type CohortManifest,
} from "./cohort-manifest.ts";

export interface SourceTruthEvidence {
  readonly schemaVersion: "1.0";
  readonly digest: string;
  readonly fileCount: number;
  readonly git: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly dirtyHash: string;
  };
}

export interface BenchmarkRepositoryEvidence {
  readonly schemaVersion: "1.0";
  readonly cohort: CohortManifest;
  readonly sourceTruth: SourceTruthEvidence;
  readonly digest: string;
}

export interface RepositoryEvidenceValidation {
  readonly evidence?: BenchmarkRepositoryEvidence;
  readonly errors: readonly string[];
}

/**
 * Load the checked-in benchmark cohort and the current canonical source identity.
 *
 * A benchmark must stop before spending provider time when either manifest is stale.
 * The source-truth Git fields are taken from the current workspace, while the cohort
 * manifest is the checked-in canonical document after byte-equivalence verification.
 */
export async function loadBenchmarkRepositoryEvidence(
  repositoryRoot: string,
  benchmarkRoot: string,
): Promise<BenchmarkRepositoryEvidence> {
  const [cohortCheck, sourceCheck] = await Promise.all([
    checkCohortManifest(benchmarkRoot),
    checkSourceTruth(repositoryRoot),
  ]);
  if (!cohortCheck.ok || cohortCheck.expected === undefined) {
    throw new Error("benchmark cohort manifest is stale or missing; run cbc-bench manifest");
  }
  const cohortIssues = validateCohortManifestShape(cohortCheck.expected);
  if (cohortIssues.length > 0) {
    throw new Error(`benchmark cohort manifest is invalid: ${cohortIssues.join("; ")}`);
  }
  if (!sourceCheck.ok) throw new Error(sourceCheck.message);

  return createBenchmarkRepositoryEvidence(
    cohortCheck.expected,
    {
      schemaVersion: "1.0",
      digest: sourceCheck.current.digest,
      fileCount: sourceCheck.current.fileCount,
      git: { ...sourceCheck.current.git },
    },
  );
}

export function createBenchmarkRepositoryEvidence(
  cohort: CohortManifest,
  sourceTruth: SourceTruthEvidence,
): BenchmarkRepositoryEvidence {
  const body = {
    schemaVersion: "1.0" as const,
    cohort,
    sourceTruth,
  };
  return {
    ...body,
    digest: sha256(canonicalValue(body)),
  };
}

/** Validate an artifact's embedded repository identity without trusting its digest. */
export function validateBenchmarkRepositoryEvidence(
  value: unknown,
): RepositoryEvidenceValidation {
  const errors: string[] = [];
  if (!isRecord(value) || value.schemaVersion !== "1.0") {
    return { errors: ["repositoryEvidence must be a schemaVersion 1.0 object"] };
  }

  const cohort = parseCohortManifest(value.cohort, errors);
  const sourceTruth = parseSourceTruthEvidence(value.sourceTruth, errors);
  const digest = typeof value.digest === "string" ? value.digest : undefined;
  if (digest === undefined || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    errors.push("repositoryEvidence.digest must be sha256:<64 lowercase hex>");
  }
  if (cohort === undefined || sourceTruth === undefined || digest === undefined) {
    return { errors };
  }

  const body = { schemaVersion: "1.0" as const, cohort, sourceTruth };
  if (sha256(canonicalValue(body)) !== digest) {
    errors.push("repositoryEvidence.digest does not match its canonical body");
  }
  const evidence = { ...body, digest } satisfies BenchmarkRepositoryEvidence;
  return errors.length === 0 ? { evidence, errors } : { errors };
}

export function repositoryEvidenceMatches(
  left: BenchmarkRepositoryEvidence,
  right: BenchmarkRepositoryEvidence,
): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

function parseCohortManifest(value: unknown, errors: string[]): CohortManifest | undefined {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !isRecord(value.categoryTargets)) {
    errors.push("repositoryEvidence.cohort must be a complete cohort manifest");
    return undefined;
  }
  const manifest = value as unknown as CohortManifest;
  try {
    errors.push(...validateCohortManifestShape(manifest).map((issue) => `cohort: ${issue}`));
  } catch (error) {
    errors.push(`cohort: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  return manifest;
}

function parseSourceTruthEvidence(
  value: unknown,
  errors: string[],
): SourceTruthEvidence | undefined {
  if (!isRecord(value) || value.schemaVersion !== "1.0" || !isRecord(value.git)) {
    errors.push("repositoryEvidence.sourceTruth must be a schemaVersion 1.0 object");
    return undefined;
  }
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    errors.push("sourceTruth.digest must be SHA-256 hex");
  }
  if (!Number.isInteger(value.fileCount) || (value.fileCount as number) < 1) {
    errors.push("sourceTruth.fileCount must be a positive integer");
  }
  if (typeof value.git.commit !== "string" || value.git.commit.length === 0) {
    errors.push("sourceTruth.git.commit must be non-empty");
  }
  if (typeof value.git.dirty !== "boolean") {
    errors.push("sourceTruth.git.dirty must be boolean");
  }
  if (typeof value.git.dirtyHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.git.dirtyHash)) {
    errors.push("sourceTruth.git.dirtyHash must be SHA-256 hex");
  }
  if (errors.some((issue) => issue.startsWith("sourceTruth."))) return undefined;
  return {
    schemaVersion: "1.0",
    digest: value.digest as string,
    fileCount: value.fileCount as number,
    git: {
      commit: value.git.commit as string,
      dirty: value.git.dirty as boolean,
      dirtyHash: value.git.dirtyHash as string,
    },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(record[key])}`
  ).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
