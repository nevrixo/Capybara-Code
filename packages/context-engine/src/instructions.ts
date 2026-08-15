/**
 * Project instruction files — PRD §18.2, AC-26 context, §T5.
 *
 * §18.2 search order:
 *
 * ```text
 * <repo>/AGENTS.md
 * <repo>/.capybara/AGENT.md
 * ancestor AGENTS.md files within workspace
 * subdirectory-specific AGENTS.md for touched paths
 * ```
 *
 * Two rules govern this file. Instructions load only **after** trust (§13.6), and
 * they never grant permission (§18.2) — the prompt layer wraps them as maintainer
 * conventions, not policy, so a repository cannot escalate its own privileges.
 */

import type { ProjectInstructions } from "@cbc/inference-domain";

/** Files consulted at the workspace root, in order. */
export const ROOT_INSTRUCTION_FILES: readonly string[] = ["AGENTS.md", ".capybara/AGENT.md"];

/** The per-directory instruction filename. */
export const DIRECTORY_INSTRUCTION_FILE = "AGENTS.md";

/** Per-directory override that replaces the primary file when present. */
export const OVERRIDE_INSTRUCTION_FILE = "AGENTS.override.md";

/** Legacy fallback kept for backwards compatibility (root only). */
export const LEGACY_INSTRUCTION_FILE = ".capybara/AGENT.md";

/** Global instruction files under the user config directory. */
export const GLOBAL_INSTRUCTION_FILES: readonly string[] = [OVERRIDE_INSTRUCTION_FILE, DIRECTORY_INSTRUCTION_FILE];

/**
 * §18.2 does not bound instruction size, but an unbounded file would silently
 * consume the L2 layer and push out repository context. Oversized files are
 * truncated with a visible marker rather than dropped, because a maintainer who
 * wrote them expects them to matter.
 */
export const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** Default cap on how many instruction files enter one prompt. */
export const MAX_INSTRUCTION_FILES = 8;

/** Hard cap on the total bytes of all instructions combined. */
export const MAX_TOTAL_INSTRUCTION_BYTES = 256 * 1024;

/**
 * Reads a workspace-relative file. Backed by the Rust runtime in production
 * (§19.6: file reads are brokered), and by a plain map in tests.
 */
export interface InstructionReader {
  read(path: string): Promise<string | undefined>;
}

export interface InstructionLoadOptions {
  /** §13.6: an untrusted workspace contributes no instructions at all. */
  readonly trusted: boolean;
  /** Paths the current task touches, used for directory-scoped instructions. */
  readonly touchedPaths?: readonly string[];
  readonly maxBytesPerFile?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
}

export interface GlobalInstructionLoadOptions {
  readonly maxBytesPerFile?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
}

export interface SkippedInstruction {
  readonly path: string;
  readonly reason: string;
}

export interface InstructionLoadResult {
  readonly instructions: ProjectInstructions[];
  readonly skipped: SkippedInstruction[];
}

/**
 * Every ancestor directory of `path`, shallowest first, excluding the workspace
 * root itself (the root file is already covered by `ROOT_INSTRUCTION_FILES`).
 *
 * `src/auth/login.ts` yields `["src", "src/auth"]`.
 */
export function ancestorDirectories(path: string): string[] {
  const normalized = normalizeRelative(path);
  const segments = normalized.split("/").filter((s) => s.length > 0);
  // The final segment is the file itself, so it contributes no directory.
  segments.pop();

  const directories: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    directories.push(current);
  }
  return directories;
}

/**
 * The full ordered candidate list for a set of touched paths. Deduplicated while
 * preserving §18.2's order, so a nearer file is always consulted after — and
 * therefore layered on top of — a broader one.
 */
export function instructionSearchPaths(touchedPaths: readonly string[] = []): string[] {
  const ordered: string[] = [...ROOT_INSTRUCTION_FILES];

  // Collect directories across all touched paths, shallowest first, so a shared
  // ancestor is visited once rather than once per file.
  const directories = new Set<string>();
  for (const touched of touchedPaths) {
    for (const directory of ancestorDirectories(touched)) directories.add(directory);
  }
  const byDepth = [...directories].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  for (const directory of byDepth) {
    ordered.push(`${directory}/${DIRECTORY_INSTRUCTION_FILE}`);
  }

  return dedupe(ordered);
}

export function globalInstructionSearchPaths(): string[] {
  return [...GLOBAL_INSTRUCTION_FILES];
}

export function resolveInstructionPath(directory: string, file: string): string {
  const normalized = normalizeRelative(directory);
  if (normalized.length === 0) return file;
  return `${normalized}/${file}`;
}

/**
 * Resolve the actual file to read for a logical instruction candidate.
 * Per-directory override replaces the primary file when present.
 */
export async function resolveInstructionCandidate(
  reader: InstructionReader,
  logicalPath: string,
): Promise<{ actualPath: string; content: string | undefined }> {
  if (logicalPath === ".capybara/AGENT.md") {
    const content = await reader.read(logicalPath);
    return { actualPath: logicalPath, content };
  }
  const directory = directoryOf(logicalPath);
  const primaryFile = basenameOf(logicalPath);
  if (primaryFile === DIRECTORY_INSTRUCTION_FILE) {
    const overridePath = directory.length > 0 ? `${directory}/${OVERRIDE_INSTRUCTION_FILE}` : OVERRIDE_INSTRUCTION_FILE;
    const overrideContent = await reader.read(overridePath);
    if (overrideContent !== undefined) {
      return { actualPath: overridePath, content: overrideContent };
    }
  }
  const content = await reader.read(logicalPath);
  return { actualPath: logicalPath, content };
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * Load the instruction files that exist, in §18.2 order.
 *
 * An untrusted workspace returns nothing and records why, so the context
 * inspector (§18.10) can show that instructions were withheld rather than
 * absent.
 */
export async function loadProjectInstructions(
  reader: InstructionReader,
  options: InstructionLoadOptions,
): Promise<InstructionLoadResult> {
  const candidates = instructionSearchPaths(options.touchedPaths ?? []);

  if (!options.trusted) {
    return {
      instructions: [],
      skipped: candidates.map((path) => ({
        path,
        reason: "the workspace is not trusted; project instructions were not loaded",
      })),
    };
  }

  const maxBytes = options.maxBytesPerFile ?? MAX_INSTRUCTION_BYTES;
  const maxFiles = options.maxFiles ?? MAX_INSTRUCTION_FILES;
  const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_INSTRUCTION_BYTES;
  const instructions: ProjectInstructions[] = [];
  const skipped: SkippedInstruction[] = [];
  let totalBytes = 0;

  for (const path of candidates) {
    if (instructions.length >= maxFiles) {
      skipped.push({ path, reason: `more than ${maxFiles} instruction files were found` });
      continue;
    }

    const { actualPath, content: raw } = await resolveInstructionCandidate(reader, path);
    if (raw === undefined) continue;

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      skipped.push({ path: actualPath, reason: "the file is empty" });
      continue;
    }

    let content = trimmed;
    let truncated = false;
    if (trimmed.length > maxBytes) {
      content = `${trimmed.slice(0, maxBytes)}\n\n…[truncated at ${maxBytes} bytes; ${
        trimmed.length - maxBytes
      } bytes omitted]`;
      truncated = true;
    }

    if (totalBytes + content.length > maxTotal) {
      const remaining = Math.max(0, maxTotal - totalBytes);
      if (remaining === 0) {
        skipped.push({ path: actualPath, reason: `combined instruction budget of ${maxTotal} bytes exceeded` });
        continue;
      }
      content = `${content.slice(0, remaining)}\n\n…[truncated at combined budget of ${maxTotal} bytes]`;
      truncated = true;
    }

    instructions.push({ path: actualPath, content });
    totalBytes += content.length;
    if (truncated && trimmed.length > maxBytes) {
      skipped.push({ path: actualPath, reason: `truncated to ${maxBytes} bytes` });
    } else if (truncated) {
      skipped.push({ path: actualPath, reason: `truncated to combined budget of ${maxTotal} bytes` });
    }
  }

  return { instructions, skipped };
}

export async function loadGlobalInstructions(
  reader: InstructionReader,
  options: GlobalInstructionLoadOptions = {},
): Promise<InstructionLoadResult> {
  const maxBytes = options.maxBytesPerFile ?? MAX_INSTRUCTION_BYTES;
  const maxFiles = options.maxFiles ?? MAX_INSTRUCTION_FILES;
  const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_INSTRUCTION_BYTES;
  const candidates = globalInstructionSearchPaths();
  const instructions: ProjectInstructions[] = [];
  const skipped: SkippedInstruction[] = [];
  let totalBytes = 0;

  let overrideLoaded = false;
  for (const file of candidates) {
    if (instructions.length >= maxFiles) {
      skipped.push({ path: file, reason: `more than ${maxFiles} instruction files were found` });
      continue;
    }
    if (overrideLoaded && file === DIRECTORY_INSTRUCTION_FILE) continue;

    const raw = await reader.read(file);
    if (raw === undefined) continue;

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      skipped.push({ path: file, reason: "the file is empty" });
      continue;
    }

    let content = trimmed;
    let truncated = false;
    if (trimmed.length > maxBytes) {
      content = `${trimmed.slice(0, maxBytes)}\n\n…[truncated at ${maxBytes} bytes; ${
        trimmed.length - maxBytes
      } bytes omitted]`;
      truncated = true;
    }

    if (totalBytes + content.length > maxTotal) {
      const remaining = Math.max(0, maxTotal - totalBytes);
      if (remaining === 0) {
        skipped.push({ path: file, reason: `combined instruction budget of ${maxTotal} bytes exceeded` });
        continue;
      }
      content = `${content.slice(0, remaining)}\n\n…[truncated at combined budget of ${maxTotal} bytes]`;
      truncated = true;
    }

    instructions.push({ path: file, content });
    totalBytes += content.length;
    if (file === OVERRIDE_INSTRUCTION_FILE) overrideLoaded = true;
    if (truncated && trimmed.length > maxBytes) {
      skipped.push({ path: file, reason: `truncated to ${maxBytes} bytes` });
    } else if (truncated) {
      skipped.push({ path: file, reason: `truncated to combined budget of ${maxTotal} bytes` });
    }
    if (overrideLoaded) break;
  }

  return { instructions, skipped };
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function depthOf(path: string): number {
  return path.split("/").length;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
