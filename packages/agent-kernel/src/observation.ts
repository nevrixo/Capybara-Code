/**
 * Observation discipline and the completion contract — PRD §11.6, §11.7, §11.8,
 * AC-44, AC-50, TOOL-006.
 *
 * §11.6 pipeline: sanitize → detect secrets → parse structured fields → retain
 * head/tail → summarize repetitive lines → spill to artifact → emit a compact
 * observation. Raw tool output never goes straight into the prompt.
 */

import type { ArtifactRef, ToolResult } from "@cbc/tool-registry";

/** §11.6 default inline limits. */
export const INLINE_LIMITS = {
  maxLines: 200,
  maxBytes: 64 * 1024,
  maxSingleLineBytes: 8 * 1024,
} as const;

export interface ObservationInput {
  readonly toolId: string;
  readonly callId: string;
  readonly result: ToolResult;
  /** Raw text output, already sanitized and redacted by the runtime. */
  readonly text?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

/**
 * Failure taxonomy for the self-reflection loop.
 *
 * The four categories are deliberately coarse, because they map onto four
 * genuinely different next moves:
 *
 * - `schema_mismatch`   → re-issue the same intent with corrected arguments.
 * - `permission_denied` → the scope is wrong; narrow the approach or ask.
 * - `logic_bug`         → the agent's model of the code is wrong; re-read it.
 * - `environment_issue` → nothing about the plan is wrong; the world is.
 *
 * A finer taxonomy would look more precise without changing what the loop does
 * with it, and the raw `code` is kept alongside for the cases that need detail.
 */
export type FailureCategory =
  | "schema_mismatch"
  | "permission_denied"
  | "logic_bug"
  | "environment_issue";

/**
 * The automatically-derived part of a reflection: what kind of failure this was,
 * and enough of a fingerprint to notice the same failure recurring.
 *
 * This is computed from the tool result, never asked of the model. A model asked
 * to categorize its own failure will sometimes report the category that makes its
 * next action look justified.
 */
export interface ReflectionHint {
  readonly category: FailureCategory;
  /** The runtime's own error code, kept for the cases the category flattens. */
  readonly code: string;
  /**
   * Stable fingerprint of this failure. Two attempts that fail the same way
   * produce the same signature, which is what makes the three-strikes rule in
   * §11.3 enforceable rather than aspirational.
   */
  readonly signature: string;
  /** One line telling the loop what kind of correction is even applicable. */
  readonly guidance: string;
  /** Whether retrying the identical call could plausibly succeed. */
  readonly retryable: boolean;
  /** Paths named by the failure, fed back into context selection (§18.4). */
  readonly implicatedPaths: readonly string[];
}

export interface Observation {
  readonly callId: string;
  readonly toolId: string
  readonly ok: boolean;
  /** The compact text the model sees. */
  readonly text: string;
  readonly artifacts: ArtifactRef[];
  readonly truncated: boolean;
  readonly linesOmitted: number;
  readonly repetitionsCollapsed: number;
  /** Present only on a failure; drives the `reflecting` state (§11.2). */
  readonly reflectionHint?: ReflectionHint;
}

/** Error codes that mean "your arguments were wrong", not "the world is wrong". */
const SCHEMA_CODES: readonly string[] = [
  "INVALID_ARGUMENT",
  "INVALID_PARAMS",
  "INVALID_REQUEST",
  "PARSE_ERROR",
  "UNSUPPORTED_ENCODING",
  "PROTOCOL_INCOMPATIBLE",
];

const PERMISSION_CODES: readonly string[] = [
  "PERMISSION_DENIED",
  "APPROVAL_DENIED",
  "NETWORK_DENIED",
  "LEASE_VIOLATION",
  "PATH_OUTSIDE_WORKSPACE",
];

/**
 * Codes where the workspace or host, not the agent's reasoning, is at fault.
 * `HASH_MISMATCH` and `PATH_CHANGED` belong here because they mean something
 * outside the turn edited the file — retrying the same edit is correct once the
 * file is re-read.
 */
const ENVIRONMENT_CODES: readonly string[] = [
  "TIMEOUT",
  "CANCELLED",
  "SANDBOX_UNAVAILABLE",
  "RESOURCE_LIMIT",
  "OUTPUT_LIMIT",
  "TOO_MANY_REQUESTS",
  "NOT_INITIALIZED",
  "INTERNAL",
  "INTERNAL_ERROR",
  "HASH_MISMATCH",
  "PATH_CHANGED",
  "TRANSACTION_CONFLICT",
];

/**
 * Output that means a tool or dependency is absent. A non-zero exit is usually a
 * real defect, but "command not found" is not something a code change fixes, and
 * conflating the two sends the agent editing source to fix a missing binary.
 */
const MISSING_DEPENDENCY_PATTERNS: readonly RegExp[] = [
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /no such file or directory/i,
  /cannot find module/i,
  /ModuleNotFoundError/,
  /could not be located|unable to locate package/i,
  /executable file not found/i,
  /\bENOTFOUND\b|getaddrinfo/i,
];

/** Classify a failed tool result into the §11.2 reflection taxonomy. */
export function classifyFailure(input: {
  readonly toolId: string;
  readonly code: string;
  readonly message: string;
  readonly text?: string;
  readonly exitCode?: number;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}): ReflectionHint {
  const code = input.code.toUpperCase();
  const haystack = `${input.message}\n${input.text ?? ""}`;
  const environmentSmell = MISSING_DEPENDENCY_PATTERNS.some((p) => p.test(haystack));

  let category: FailureCategory;
  if (SCHEMA_CODES.includes(code)) {
    category = "schema_mismatch";
  } else if (PERMISSION_CODES.includes(code)) {
    category = "permission_denied";
  } else if (ENVIRONMENT_CODES.includes(code)) {
    category = "environment_issue";
  } else if (environmentSmell) {
    // Checked before the default so a missing binary is never read as a defect
    // in the code under change.
    category = "environment_issue";
  } else {
    // NOT_FOUND, ALREADY_EXISTS, PROCESS_EXIT_NONZERO and anything unmapped:
    // the agent's model of the code was wrong.
    category = "logic_bug";
  }

  const implicatedPaths = collectImplicatedPaths(input.details, `${input.message}\n${input.text ?? ""}`);

  return {
    category,
    code,
    signature: failureSignature(input.toolId, category, code, input.message),
    guidance: guidanceFor(category, input.toolId),
    retryable: input.retryable ?? category === "environment_issue",
    implicatedPaths,
  };
}

/**
 * A fingerprint that survives incidental variation. Line numbers, byte counts,
 * hashes and timings differ between two attempts that failed for the same
 * reason, so they are normalized away before hashing.
 */
export function failureSignature(
  toolId: string,
  category: FailureCategory,
  code: string,
  message: string,
): string {
  const normalized = message
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\b[a-f0-9]{7,}\b/g, "#")
    .replace(/\d+(\.\d+)?(ms|s|us|ns|%|kib|mib|bytes?)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${toolId}|${category}|${code}|${normalized}`;
}

function guidanceFor(category: FailureCategory, toolId: string): string {
  switch (category) {
    case "schema_mismatch":
      return `the arguments to ${toolId} did not satisfy its schema; correct them and re-issue the same intent rather than switching tools`;
    case "permission_denied":
      return "the action is outside the granted scope; narrow the approach or state what wider scope the task needs — do not retry the same call";
    case "environment_issue":
      return "the failure is in the environment, not the change; establish whether the prerequisite exists before editing anything";
    case "logic_bug":
      if (toolId === "fs.read") {
        return "the requested path is absent; do not repeat the read. If the task is to create it, use fs.write with intent=create after checking the parent directory";
      }
      return "the assumption behind this call was wrong; re-read the relevant source before attempting another edit";
  }
}

/**
 * Pull workspace-relative paths out of an error so context selection can weight
 * them (§18.4). Only path-shaped tokens with a known-ish extension are taken;
 * a permissive pattern would drag in prose and dilute the signal it feeds.
 */
function collectImplicatedPaths(
  details: Record<string, unknown> | undefined,
  text: string,
): string[] {
  const paths = new Set<string>();

  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && value.length < 512) paths.add(value);
  };
  if (details !== undefined) {
    push(details.path);
    push(details.file);
    for (const key of ["paths", "files", "stagedPaths"]) {
      const list = details[key];
      if (Array.isArray(list)) for (const entry of list) push(entry);
    }
  }

  const pattern =
    /(?:^|[\s"'(:])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w]{0,9})(?=$|[\s"'):,])/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate !== undefined) paths.add(candidate);
  }
  return [...paths].slice(0, 12);
}

/**
 * Collapse consecutive identical or near-identical lines. Test suites and build
 * logs are dominated by repetition, and §11.6 asks for it to be summarized rather
 * than paid for token by token.
 */
export function collapseRepetition(lines: readonly string[]): {
  lines: string[];
  collapsed: number;
} {
  const out: string[] = [];
  let collapsed = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as string;
    let run = 1;
    while (index + run < lines.length && normalizeForRepetition(lines[index + run] as string) === normalizeForRepetition(line)) {
      run += 1;
    }
    out.push(line);
    if (run > 2) {
      out.push(`… ${run - 1} more similar line(s) omitted`);
      collapsed += run - 1;
    } else if (run === 2) {
      out.push(lines[index + 1] as string);
    }
    index += run;
  }
  return { lines: out, collapsed };
}

function normalizeForRepetition(line: string): string {
  // Treat lines differing only in numbers, hex, paths, or timing as the same.
  return line
    .replace(/\d+(\.\d+)?(ms|s|us|ns|%)?/g, "#")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/[a-f0-9]{7,}/gi, "#")
    .trim();
}

/** Truncate a single overlong line (§11.6: 8 KiB per line). */
export function capLine(line: string, maxBytes = INLINE_LIMITS.maxSingleLineBytes): string {
  if (line.length <= maxBytes) return line;
  return `${line.slice(0, maxBytes)} …[line truncated: ${line.length} bytes]`;
}

/**
 * Build the compact observation. `spill` is called when the output exceeds the
 * inline budget, so the caller decides where the artifact lives.
 *
 * `spill` is awaited: the artifact handle the observation carries must be the
 * one the store actually created, otherwise the id/digest the model sees can
 * never read the stored bytes back (P0-08).
 */
export async function normalizeObservation(
  input: ObservationInput,
  options: {
    readonly maxLines?: number;
    readonly maxBytes?: number;
    readonly spill?: (label: string, content: string) => Promise<ArtifactRef | undefined>;
  } = {},
): Promise<Observation> {
  const maxLines = options.maxLines ?? INLINE_LIMITS.maxLines;
  const maxBytes = options.maxBytes ?? INLINE_LIMITS.maxBytes;
  const artifacts: ArtifactRef[] = [...(input.result.artifacts ?? [])];

  const header: string[] = [
    input.result.ok
      ? `${input.toolId} ok: ${input.result.summary}`
      : `${input.toolId} failed: ${input.result.error?.code ?? "ERROR"} — ${
          input.result.error?.message ?? input.result.summary
        }`,
  ];
  if (input.exitCode !== undefined) header.push(`exit code ${input.exitCode}`);
  if (input.durationMs !== undefined) header.push(`${input.durationMs} ms`);
  for (const warning of input.result.warnings ?? []) header.push(`warning: ${warning}`);

  const raw = input.text ?? "";

  // §11.2: a failure is tagged with its cause here, at the one point where the
  // raw result is still available. Doing it later would mean re-deriving the
  // cause from the compacted text the model sees.
  const hint: ReflectionHint | undefined = input.result.ok
    ? undefined
    : classifyFailure({
        toolId: input.toolId,
        code: input.result.error?.code ?? "INTERNAL",
        message: input.result.error?.message ?? input.result.summary,
        ...(raw.length > 0 ? { text: raw } : {}),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.result.error?.retryable !== undefined
          ? { retryable: input.result.error.retryable }
          : {}),
        ...(input.result.error?.details !== undefined
          ? { details: input.result.error.details }
          : {}),
      });

  if (raw.length === 0) {
    return {
      callId: input.callId,
      toolId: input.toolId,
      ok: input.result.ok,
      text: header.join(" · "),
      artifacts,
      truncated: false,
      linesOmitted: 0,
      repetitionsCollapsed: 0,
      ...(hint !== undefined ? { reflectionHint: hint } : {}),
    };
  }

  const allLines = raw.split("\n").map((line) => capLine(line));
  const { lines: collapsedLines, collapsed } = collapseRepetition(allLines);

  let body: string;
  let truncated = false;
  let linesOmitted = 0;

  if (collapsedLines.length <= maxLines && collapsedLines.join("\n").length <= maxBytes) {
    body = collapsedLines.join("\n");
  } else {
    truncated = true;
    // §12.7: tail-first error excerpt for large failures — the end of a failing
    // build is where the diagnosis is.
    const tailWeight = input.result.ok ? 0.35 : 0.65;
    const tailCount = Math.max(1, Math.floor(maxLines * tailWeight));
    const headCount = Math.max(1, maxLines - tailCount);
    const head = collapsedLines.slice(0, headCount);
    const tail = collapsedLines.slice(-tailCount);
    linesOmitted = Math.max(0, collapsedLines.length - head.length - tail.length);

    // Spill before composing the omission marker: the marker may only claim the
    // full output was stored once the store has actually acknowledged it.
    // The executor may already have materialized the raw output so its
    // observation hook can retain the runtime-minted handle. Reuse that handle
    // rather than storing the same bytes twice during normalization.
    const spilled = artifacts[0] ?? await options.spill?.(`${input.toolId}-${input.callId}.log`, raw);
    if (spilled !== undefined && !artifacts.some((artifact) => artifact.id === spilled.id)) {
      artifacts.push(spilled);
    }
    const omissionNote =
      spilled !== undefined
        ? `… ${linesOmitted} line(s) omitted; full output stored as an artifact …`
        : `… ${linesOmitted} line(s) omitted; the full output could not be stored …`;
    body = [...head, omissionNote, ...tail].join("\n");

    if (body.length > maxBytes) {
      body = `${body.slice(0, maxBytes)}\n…[observation truncated at ${maxBytes} bytes]`;
    }
  }

  const artifactNote =
    artifacts.length > 0
      ? `\nartifacts: ${artifacts.map((a) => `${a.id} sha256:${a.digest} (${a.bytes} bytes)`).join(", ")}`
      : "";

  return {
    callId: input.callId,
    toolId: input.toolId,
    ok: input.result.ok,
    text: `${header.join(" · ")}\n${body}${artifactNote}`,
    artifacts,
    truncated,
    linesOmitted,
    repetitionsCollapsed: collapsed,
    ...(hint !== undefined ? { reflectionHint: hint } : {}),
  };
}

/** Evidence coverage used to decide whether a completion claim is earned. */
export interface VerificationCoverage {
  readonly changedFiles: number;
  readonly changedSymbols: number;
  readonly requiredChecks: number;
  readonly passedChecks: number;
  readonly failedChecks: number;
  readonly notRunChecks: number;
  readonly staleEvidence: number;
  readonly unresolvedOperations: number;
  readonly highRiskFindings: number;
  readonly coverageStatus: "complete" | "partial" | "blocked";
}

export function buildVerificationCoverage(input: {
  readonly changedFiles: number;
  readonly changedSymbols?: number;
  readonly verification: readonly { readonly status: "passed" | "failed" | "not_run"; readonly required?: boolean }[];
  readonly staleEvidence?: number;
  readonly unresolvedOperations?: number;
  readonly highRiskFindings?: number;
}): VerificationCoverage {
  const required = input.verification.filter((check) => check.required !== false);
  const requiredChecks = required.length;
  const passedChecks = required.filter((check) => check.status === "passed").length;
  const failedChecks = required.filter((check) => check.status === "failed").length;
  const notRunChecks = required.filter((check) => check.status === "not_run").length;
  const staleEvidence = Math.max(0, Math.floor(input.staleEvidence ?? 0));
  const unresolvedOperations = Math.max(0, Math.floor(input.unresolvedOperations ?? 0));
  const highRiskFindings = Math.max(0, Math.floor(input.highRiskFindings ?? 0));
  const coverageStatus: VerificationCoverage["coverageStatus"] =
    failedChecks > 0 || staleEvidence > 0 || unresolvedOperations > 0 || highRiskFindings > 0
      ? "blocked"
      : input.changedFiles > 0 && (notRunChecks > 0 || passedChecks < requiredChecks)
        ? "partial"
        : "complete";
  return {
    changedFiles: Math.max(0, Math.floor(input.changedFiles)),
    changedSymbols: Math.max(0, Math.floor(input.changedSymbols ?? 0)),
    requiredChecks,
    passedChecks,
    failedChecks,
    notRunChecks,
    staleEvidence,
    unresolvedOperations,
    highRiskFindings,
    coverageStatus,
  };
}


/** §11.7 completion contract. */
export interface CompletionReport {
  status: "completed" | "partial" | "failed" | "cancelled";
  summary: string;
  changedFiles: Array<{
    path: string;
    additions?: number;
    deletions?: number;
    purpose: string;
  }>;
  verification: Array<{
    kind?: "command" | "check";
    command?: string;
    /** Diagnostic checks are reported, but do not decide completion status. */
    required?: boolean;
    status: "passed" | "failed" | "not_run";
    evidence: string;
  }>;
  delegatedTasks: Array<{ id: string; role: string; status: string; summary: string }>;
  risks: string[];
  nextStep?: string;
}

export function emptyReport(status: CompletionReport["status"] = "completed"): CompletionReport {
  return {
    status,
    summary: "",
    changedFiles: [],
    verification: [],
    delegatedTasks: [],
    risks: [],
  };
}

/**
 * AC-50: the final answer must not present unrun or failed tests as success.
 * This validator runs before the report is emitted and downgrades the status
 * rather than trusting the model's own claim.
 */
export interface TruthfulnessIssue {
  readonly field: string;
  readonly message: string;
}

/** Remove Git porcelain status prefixes before a path reaches user-facing output. */
export function normalizeReportPath(path: string): string {
  const raw = path.trimEnd();
  const value = raw.trim();
  if (raw.startsWith("??")) {
    const normalized = raw.slice(2).trimStart();
    return normalized.length > 0 ? normalized : value;
  }
  if (/^[ MADRCUT?!]{2}\s/.test(raw)) {
    const normalized = raw.slice(3).trimStart();
    return normalized.length > 0 ? normalized : value;
  }
  return value;
}

export function enforceTruthfulness(report: CompletionReport): {
  report: CompletionReport;
  issues: TruthfulnessIssue[];
} {
  const issues: TruthfulnessIssue[] = [];
  const corrected: CompletionReport = {
    ...report,
    changedFiles: report.changedFiles.map((file) => ({ ...file, path: normalizeReportPath(file.path) })),
    verification: [...report.verification],
    delegatedTasks: [...report.delegatedTasks],
    risks: [...report.risks],
  };

  const requiredVerification = corrected.verification.filter((v) => v.required !== false);
  const failed = requiredVerification.filter((v) => v.status === "failed");
  const notRun = requiredVerification.filter((v) => v.status === "not_run");
  const passed = requiredVerification.filter((v) => v.status === "passed");
  const hasBlockingFailure = (text: string): boolean =>
    /PERMISSION_DENIED|permission denied|untrusted|denied by policy|denied by the user/i.test(text);
  const hasPermissionBlockedWrite = failed.some((v) => hasBlockingFailure(`${v.command ?? ""} ${v.evidence}`))
    || notRun.some((v) => hasBlockingFailure(v.evidence))
    || corrected.risks.some((r) => hasBlockingFailure(r));

  if (hasPermissionBlockedWrite && corrected.changedFiles.length === 0) {
    const message = "writes were blocked by workspace permissions (untrusted/PERMISSION_DENIED) — no files changed, so verification cannot be 'passed'";
    if (passed.length > 0) {
      issues.push({ field: "verification", message });
      corrected.verification = corrected.verification.map((v) =>
        v.status === "passed" ? { ...v, status: "not_run", evidence: `${v.evidence} — not run: ${message}` } : v,
      );
      if (!corrected.risks.includes(message)) corrected.risks.push(message);
    }
    if (corrected.status === "completed") {
      issues.push({ field: "status", message });
      corrected.status = "partial";
      if (!corrected.risks.includes(message)) corrected.risks.push(message);
      corrected.nextStep = "Check workspace trust: change the trust status with 'capybara trust' and try again.";
    }
  }

  const requiredAfter = corrected.verification.filter((v) => v.required !== false);
  const failedAfter = requiredAfter.filter((v) => v.status === "failed");
  const notRunAfter = requiredAfter.filter((v) => v.status === "not_run");
  const passedAfter = requiredAfter.filter((v) => v.status === "passed");

  if (corrected.status === "completed" && failedAfter.length > 0) {
    issues.push({
      field: "status",
      message: `${failedAfter.length} verification step(s) failed, so the turn is not 'completed'`,
    });
    corrected.status = "partial";
  }

  if (corrected.status === "completed" && corrected.changedFiles.length > 0 && requiredAfter.length === 0) {
    issues.push({
      field: "verification",
      message: "files changed but no verification was recorded",
    });
    corrected.risks.push("no verification was run against these changes");
    corrected.status = "partial";
  }

  for (const step of requiredAfter.filter((v) => v.status === "not_run")) {
    if (step.evidence.trim().length === 0) {
      issues.push({
        field: "verification",
        message: `a 'not_run' verification step must record why it could not run`,
      });
    }
  }

  const claimsSuccess = /\b(all tests? pass|everything works|fully working|verified working)\b/i.test(
    corrected.summary,
  );
  if (claimsSuccess && (failedAfter.length > 0 || requiredAfter.length === 0 || hasPermissionBlockedWrite)) {
    issues.push({
      field: "summary",
      message: "the summary claims success that the recorded verification does not support",
    });
    corrected.summary = `${corrected.summary} (note: verification did not confirm this)`;
  }

  if (corrected.summary.trim().length === 0) {
    issues.push({ field: "summary", message: "summary must not be empty" });
    corrected.summary = describeFallbackSummary(corrected);
  }

  return { report: corrected, issues };
}

function describeFallbackSummary(report: CompletionReport): string {
  if (report.changedFiles.length === 0) return "No files were changed.";
  return `Changed ${report.changedFiles.length} file(s): ${report.changedFiles
    .map((f) => f.path)
    .slice(0, 5)
    .join(", ")}.`;
}

/** Build a partial report when a budget runs out (§11.3). */
export function partialReport(
  reason: string,
  base: Partial<CompletionReport> = {},
): CompletionReport {
  return {
    ...emptyReport("partial"),
    ...base,
    status: "partial",
    summary: base.summary ?? `Stopped early: ${reason}.`,
    risks: [...(base.risks ?? []), `the turn ended early because it ${reason}`],
    nextStep: base.nextStep ?? "review the partial changes and re-run with a larger budget",
  };
}

/** Render the report as the final answer text (§11.7, §7.4). */
export function renderReport(report: CompletionReport, answer?: string): string {
  const summary = answer?.trim().length ? answer.trim() : report.summary;
  if (report.status === "cancelled") {
    if (
      report.changedFiles.length === 0 &&
      report.verification.length === 0 &&
      report.delegatedTasks.length === 0
    ) {
      return ["Final answer", `Status: ${report.status}`, "", report.summary].join("\n");
    }
  }

  const lines: string[] = ["Final answer", `Status: ${report.status}`, "", summary, ""];

  if (report.changedFiles.length > 0) {
    lines.push("Changed");
    for (const file of report.changedFiles) {
      const counts =
        file.additions !== undefined || file.deletions !== undefined
          ? ` (+${file.additions ?? 0} -${file.deletions ?? 0})`
          : "";
      lines.push("- " + normalizeReportPath(file.path) + counts + " — " + file.purpose);
    }
    lines.push("");
  }

  if (report.verification.length > 0) {
    lines.push("Verification");
    for (const step of report.verification) {
      const label = step.required === false ? "diagnostic" : "required";
      lines.push(`- [${label}] ${step.command ?? "check"}: ${step.status} — ${step.evidence}`);
    }
    lines.push("");
  }

  if (report.delegatedTasks.length > 0) {
    lines.push("Delegated");
    for (const task of report.delegatedTasks) {
      lines.push(`- ${task.role} (${task.status}): ${task.summary}`);
    }
    lines.push("");
  }

  if (report.risks.length > 0 && report.status !== "cancelled") {
    lines.push("Risks");
    for (const risk of report.risks) lines.push(`- ${risk}`);
    lines.push("");
  }

  if (report.nextStep !== undefined && report.status !== "cancelled") {
    lines.push(`Next step: ${report.nextStep}`);
  }

  return lines.join("\n").trimEnd();
}

/** §11.8 verification ordering. */
export type VerificationStep =
  | { kind: "parse_sanity"; paths: string[] }
  | { kind: "closest_tests"; command: string; reason: string }
  | { kind: "broader_tests"; command: string; justification: string }
  | { kind: "git_diff" }
  | { kind: "independent_review" };

/**
 * Plan verification in the §11.8 order. `justification` is required for a broader
 * suite so a turn cannot casually run the whole test matrix.
 */
export function planVerification(options: {
  readonly changedPaths: readonly string[];
  readonly testCommandFor?: (paths: readonly string[]) => { command: string; reason: string } | undefined;
  /** Runner-provided commands override heuristics and are all authoritative. */
  readonly requiredCommands?: readonly { readonly command: string; readonly reason: string }[];
  readonly broaderJustification?: string;
  readonly autoReview: boolean;
}): VerificationStep[] {
  const steps: VerificationStep[] = [];
  if (options.changedPaths.length === 0) return steps;

  steps.push({ kind: "parse_sanity", paths: [...options.changedPaths] });

  // An explicitly empty runner contract means "record not_run; do not guess".
  // Only an absent contract permits repository heuristics.
  const planned = options.requiredCommands !== undefined
    ? options.requiredCommands
    : (() => {
        const focused = options.testCommandFor?.(options.changedPaths);
        return focused === undefined ? [] : [focused];
      })();
  const seen = new Set<string>();
  for (const command of planned) {
    const normalized = command.command.trim().replace(/\s+/g, " ");
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    steps.push({ kind: "closest_tests", command: command.command, reason: command.reason });
  }
  if (options.broaderJustification !== undefined && options.broaderJustification.length > 0) {
    steps.push({
      kind: "broader_tests",
      command: "full suite",
      justification: options.broaderJustification,
    });
  }
  steps.push({ kind: "git_diff" });
  if (options.autoReview) steps.push({ kind: "independent_review" });
  return steps;
}
