/**
 * Tool execution — PRD §12.1, §12.5, §12.6, §12.7, §12.8, §12.10, §18.17, AC-14.
 *
 * §12.1 draws the line this file sits on: TypeScript owns the *catalog and the
 * intent*, the Rust runtime owns *execution and the hard boundary*. Nothing here
 * touches the filesystem or spawns a process directly — every effect is an RPC, and
 * the runtime re-validates it (§19.7).
 *
 * Mutations are wrapped in a transaction per call. §12.5 requires a patch to apply
 * atomically or not at all, so a staging failure rolls back rather than leaving the
 * workspace half-edited (AC-14).
 */

import { createHash } from "node:crypto";
import type { ToolExecutor } from "@cbc/agent-kernel";
import { isSensitivePath } from "@cbc/context-engine";
import { actionHash, classifyCommand, type ProposedAction } from "@cbc/permissions";
import { RuntimeRpcError, type CapabilityReceipt, type ToolErrorCode } from "@cbc/protocol";
import { errorResult, okResult, type ArtifactRef, type ToolResult } from "@cbc/tool-registry";

import type { Host } from "./host.ts";
import type { ProcessOutcome, Runtime } from "./runtime.ts";
import { normalizePath } from "./normalizer.ts";

function environmentBinding(value: unknown): string {
  const entries = typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string").sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
    : [];
  const hash = createHash("sha256");
  for (const [name, text] of entries) {
    hash.update(String(Buffer.byteLength(name, "utf8")));
    hash.update(":");
    hash.update(name);
    hash.update(String(Buffer.byteLength(text, "utf8")));
    hash.update(":");
    hash.update(text);
  }
  return `env:sha256:${hash.digest("hex")}`;
}

/** Result of one execution, in the shape `ToolExecutor` promises. */
export interface Execution {
  result: ToolResult;
  text?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface ToolObservationEnvelope {
  readonly action: ProposedAction;
  readonly execution: Execution;
  readonly cacheHit: boolean;
  readonly observedAtMs: number;
  readonly agentId?: string;
  readonly turnId?: string;
  /** Workspace mutation generation captured before the runtime operation. */
  readonly workspaceGeneration?: number;
}

export type ToolObservationDisposition = "promoted" | "withheld" | "raw";
export interface ToolObservationAck {
  readonly disposition: ToolObservationDisposition;
  /** Generation for which the compiler guarantees this disposition is valid. */
  readonly workspaceGeneration?: number;
  /** Undo only this observation's new compiler leases if superseded after callback return. */
  readonly onGenerationMismatch?: () => void;
  /** read_many members whose exact bodies are guaranteed in this owner's L6. */
  readonly virtualizedPaths?: readonly string[];
}
export type ToolObservationResult = void | boolean | ToolObservationDisposition | ToolObservationAck;

/** Hooks for the subsystems that live above the runtime. */
export interface ToolBridges {
  /** `task.*` — supplied by the subagent scheduler once it is running. */
  readonly task?: (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
  /** `skill.search` / `skill.load` — supplied by the Skill registry. */
  readonly skill?: (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
  /** `mcp.*` — supplied by the MCP manager. */
  readonly mcp?: (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
  /** `user.ask` — supplied by the TUI or headless policy. */
  readonly ask?: (question: string, choices: readonly string[], signal: AbortSignal) => Promise<string>;
  /** `todo.write` — root session state, never a workspace side effect. */
  readonly todo?: (action: ProposedAction, signal: AbortSignal) => Promise<Execution>;
}

export interface ToolExecutorOptions {
  readonly runtime: Runtime;
  readonly host: Host;
  readonly bridges?: ToolBridges;
  /** Turn and agent identity recorded on each transaction (§18.15). */
  readonly scope?: () => {
    turnId?: string;
    agentId?: string;
    leasePathGlobs?: readonly string[];
    /** §11.2: the approach these mutations belong to, for checkpoint rollback. */
    checkpointId?: string;
    /** Monotonic generation incremented on every committed workspace mutation. */
    workspaceGeneration?: number;
  };
  /** Default process timeout when the model does not supply one (§12.4). */
  readonly defaultTimeoutMs?: number;
  readonly onTransaction?: (event: {
    kind: "started" | "committed" | "rolled_back";
    transactionId: string;
    paths: string[];
  }) => void;
  readonly onJobStarted?: (job: { jobId: string; display: string }) => void;
  readonly onArtifactSpilled?: (artifact: ArtifactRef, action: ProposedAction) => void;
  readonly onPathsTouched?: (paths: readonly string[]) => void;
  /** Process/shell tools may mutate paths they cannot enumerate statically. */
  readonly onWorkspacePotentiallyChanged?: (toolId: string, action?: ProposedAction) => void;
  /** Called for every logical hit/miss; failures are isolated from tool execution. */
  readonly onObservation?: (
    event: ToolObservationEnvelope,
  ) =>
    | ToolObservationResult
    | Promise<ToolObservationResult>;
  /**
   * Shared read cache. The same instance is given to the root executor and to
   * every subagent executor so a parent's reads answer its children's identical
   * reads (§15.1 delegation economics), instead of each agent re-listing the
   * workspace from scratch.
   */
  readonly readCache?: ReadCache;
  readonly sessionId?: string;
}

function args(action: ProposedAction): Record<string, unknown> {
  return action.arguments as Record<string, unknown>;
}

function str(action: ProposedAction, key: string): string | undefined {
  const value = args(action)[key];
  return typeof value === "string" ? value : undefined;
}

function num(action: ProposedAction, key: string): number | undefined {
  const value = args(action)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Map a runtime RPC failure onto the §12.10 taxonomy. */
/**
 * Convert an absolute path emitted by a model into the runtime workspace-relative
 * form when it names the current workspace. This handles both native Windows
 * paths and WSL /mnt/<drive> aliases without weakening the Rust path guard: paths
 * that do not prove they are inside the workspace are returned unchanged and are
 * still rejected there.
 */
function workspacePath(raw: string, workspace: string): string {
  const value = raw.trim();
  if (value.length === 0) return raw;
  const root = slash(workspace).replace(/\/+$/, "") || "/";
  const insensitive = /^[A-Za-z]:\//.test(root) || /^\/mnt\/[A-Za-z]\//i.test(root);
  const roots = pathAliases(root);
  for (const candidate of pathAliases(slash(value))) {
    for (const rootCandidate of roots) {
      const equal = insensitive
        ? candidate.toLowerCase() === rootCandidate.toLowerCase()
        : candidate === rootCandidate;
      if (equal) return ".";
      const prefix = rootCandidate === "/" ? "/" : `${rootCandidate}/`;
      const inside = insensitive
        ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
        : candidate.startsWith(prefix);
      if (inside) {
        const relative = candidate.slice(prefix.length);
        return normalizePath(relative.length > 0 ? relative : ".");
      }
    }
  }
  const normalizedValue = slash(value);
  if (!normalizedValue.startsWith("/") && !/^[A-Za-z]:/.test(normalizedValue)) {
    // Relative paths and glob patterns are still normalized even when they do
    // not have a workspace-root prefix.
    return normalizePath(normalizedValue);
  }
  return raw;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function pathAliases(value: string): string[] {
  const normalized = slash(value);
  const aliases = [normalized];
  const windows = /^([A-Za-z]):(\/.*)?$/.exec(normalized);
  if (windows) aliases.push(`/mnt/${windows[1]!.toLowerCase()}${windows[2] ?? ""}`);
  const wsl = /^\/mnt\/([A-Za-z])(\/.*)?$/i.exec(normalized);
  if (wsl) aliases.push(`${wsl[1]!.toUpperCase()}:${wsl[2] ?? ""}`);
  return [...new Set(aliases)];
}

function normalizeRuntimeOptions(
  raw: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  const out = { ...raw };
  for (const key of ["include", "path", "cwd"] as const) {
    if (typeof out[key] === "string") out[key] = workspacePath(out[key] as string, workspace);
  }
  if (Array.isArray(out.ignore)) {
    out.ignore = out.ignore.map((value) =>
      typeof value === "string" ? workspacePath(value, workspace) : value,
    );
  }
  if (Array.isArray(out.paths)) {
    out.paths = out.paths.map((value) =>
      typeof value === "string" ? workspacePath(value, workspace) : value,
    );
  }
  return out;
}

function normalizeDiffPaths(diff: string, workspace: string): string {
  return diff
    .split("\n")
    .map((line) => {
      const match = /^(---|\+\+\+)\s+([^\t]+)(\t.*)?$/.exec(line);
      if (!match || match[2] === "/dev/null") return line;
      const marker = match[1] === "---" ? "a/" : "b/";
      const rawPath = match[2]!.startsWith(marker)
        ? match[2]!.slice(marker.length)
        : match[2]!;
      const normalized = workspacePath(rawPath, workspace);
      return `${match[1]} ${marker}${normalized}${match[3] ?? ""}`;
    })
    .join("\n");
}

function normalizeExpectedHashes(
  value: unknown,
  workspace: string,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([path, hash]) => [
      workspacePath(path, workspace),
      hash,
    ]),
  );
}
export function toolErrorFrom(error: unknown): ToolResult {
  if (error instanceof RuntimeRpcError) {
    return errorResult(error.taxonomy, error.message, {
      retryable: error.retryable,
      ...(error.data !== undefined ? { details: error.data } : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const code: ToolErrorCode = /abort|cancel/i.test(message)
    ? "CANCELLED"
    : /not started|not initialized|initiali[sz]e/i.test(message)
      ? "NOT_INITIALIZED"
      : /timed out|timeout/i.test(message)
        ? "TIMEOUT"
        : "INTERNAL";
  return errorResult(code, message, { retryable: code === "INTERNAL" || code === "TIMEOUT" });
}

function readNeedsCapability(action: ProposedAction): boolean {
  return (action.reads ?? []).some(isSensitivePath);
}

function capabilityFields(capability: CapabilityReceipt | undefined): Record<string, string> {
  if (capability === undefined) return {};
  return {
    capabilityReceipt: capability.id,
    capabilitySessionId: capability.sessionId,
    capabilityActionHash: capability.actionHash,
  };
}

/**
 * Renders a process outcome for the model.
 *
 * stdout and stderr arrive already sanitized and redacted by the runtime (§9.8,
 * §14.8), so this only has to make the two streams distinguishable.
 */
export function renderProcessOutcome(outcome: ProcessOutcome): string {
  const parts: string[] = [];
  const exit = outcome.exitCode ?? null;
  parts.push(
    `${outcome.display} → ${outcome.state}${exit !== null ? ` (exit ${exit})` : ""} in ${outcome.durationMs} ms`,
  );
  if (outcome.stdout.length > 0) parts.push(outcome.stdout);
  if (outcome.stderr.length > 0) parts.push(`stderr:\n${outcome.stderr}`);
  if (outcome.truncated) {
    parts.push(`[output truncated at ${outcome.stdoutBytes + outcome.stderrBytes} bytes]`);
  }
  for (const warning of outcome.warnings) parts.push(`warning: ${warning}`);
  return parts.join("\n");
}

// Keep independently moderate outputs recoverable before accumulation compaction.
const OBSERVATION_ARTIFACT_THRESHOLD_BYTES = 8 * 1024;
/** Replace an exact read's L7 body after the context hook promoted it to L6. */
function virtualizePromotedRead(action: ProposedAction, execution: Execution): Execution {
  if (!execution.result.ok || (action.toolId !== "fs.read" && action.toolId !== "fs.read_many")) {
    return execution;
  }
  const data = execution.result.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return execution;
  if (action.toolId === "fs.read") {
    const record = data as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.checksum !== "string") return execution;
    return {
      ...execution,
      text: `${execution.result.summary}. Exact content was promoted to the repository context with runtime checksum ${record.checksum}; this function output is a locator, not a duplicate copy.`,
    };
  }
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.files)) return execution;
  const paths = record.files
    .filter((file): file is Record<string, unknown> => typeof file === "object" && file !== null && !Array.isArray(file))
    .map((file) => typeof file.path === "string" ? file.path : undefined)
    .filter((path): path is string => path !== undefined);
  const requested = new Set((action.reads ?? []).map(normalizeReadPath));
  const errorLines: string[] = [];
  if (Array.isArray(record.errors)) {
    for (const rawError of record.errors.slice(0, 32)) {
      if (typeof rawError !== "object" || rawError === null || Array.isArray(rawError)) continue;
      const error = rawError as Record<string, unknown>;
      const path = typeof error.path === "string" ? normalizeReadPath(error.path) : undefined;
      if (path === undefined || !requested.has(path) || isSensitivePath(path)) {
        errorLines.push("Sensitive or unbound read error withheld.");
        continue;
      }
      const nested = typeof error.error === "object" && error.error !== null && !Array.isArray(error.error)
        ? error.error as Record<string, unknown>
        : undefined;
      const message = typeof error.message === "string"
        ? error.message
        : typeof nested?.message === "string"
          ? nested.message
          : "read failed";
      const code = typeof error.code === "string"
        ? error.code
        : typeof nested?.code === "string"
          ? nested.code
          : undefined;
      errorLines.push(`${path}: ${code === undefined ? "" : `${code}: `}${message}`.slice(0, 512));
    }
  }
  const locator = `${execution.result.summary}. Exact content for ${paths.join(", ") || "the valid files"} was promoted to repository context.`;
  return {
    ...execution,
    text: errorLines.length === 0 ? locator : `${locator} Partial read errors:\n${errorLines.join("\n")}`,
  };
}

function normalizeReadPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function virtualizeWithheldRead(action: ProposedAction, execution: Execution): Execution {
  if (action.toolId !== "fs.read" && action.toolId !== "fs.read_many") return execution;
  const requested = new Set((action.reads ?? []).map(normalizeReadPath));
  const data = execution.result.data;
  if (action.toolId === "fs.read") {
    const record = typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    const responsePath = typeof record?.path === "string" ? normalizeReadPath(record.path) : undefined;
    if (responsePath === undefined || !requested.has(responsePath)) {
      return {
        ...execution,
        text: "Read output withheld because the runtime response could not be bound to the requested path.",
      };
    }
    return {
      ...execution,
      text: isSensitivePath(responsePath)
        ? "Read completed. Content for the requested sensitive path was intentionally withheld from both prompt layers."
        : `Read completed. Exact content for ${responsePath} was intentionally withheld; only a locator was retained.`,
    };
  }
  const safeRequested = [...requested].filter((path) => !isSensitivePath(path));
  return {
    ...execution,
    text: `Read-many completed. Sensitive, binary, malformed, or unbound members were withheld from both prompt layers; eligible non-sensitive requested ranges${safeRequested.length > 0 ? ` (${safeRequested.join(", ")})` : ""} are represented exactly in repository context.`,
  };
}

function readContainsSensitivePath(action: ProposedAction, execution: Execution): boolean {
  if (action.toolId !== "fs.read" && action.toolId !== "fs.read_many") return false;
  const paths = [...(action.reads ?? [])];
  const data = execution.result.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.path === "string") paths.push(record.path);
    if (Array.isArray(record.files)) {
      for (const file of record.files) {
        if (typeof file !== "object" || file === null || Array.isArray(file)) continue;
        const path = (file as Record<string, unknown>).path;
        if (typeof path === "string") paths.push(path);
      }
    }
  }
  return paths.some((path) => isSensitivePath(normalizeReadPath(path)));
}

/**
 * Preserve raw non-sensitive read_many members while failing closed on every
 * member whose response path cannot be bound to the requested safe path.
 */
function sanitizeSensitiveRawRead(action: ProposedAction, execution: Execution): Execution {
  if (action.toolId !== "fs.read" && action.toolId !== "fs.read_many") return execution;
  const requested = new Set((action.reads ?? []).map(normalizeReadPath));
  if (action.toolId === "fs.read") {
    const data = execution.result.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return virtualizeWithheldRead(action, execution);
    }
    const rawPath = (data as Record<string, unknown>).path;
    const path = typeof rawPath === "string" ? normalizeReadPath(rawPath) : undefined;
    return path !== undefined && requested.has(path) && !isSensitivePath(path)
      ? execution
      : virtualizeWithheldRead(action, execution);
  }
  const sensitiveRequested = new Set([...requested].filter(isSensitivePath));
  const data = execution.result.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ...execution, text: "Sensitive or unbound read_many content was withheld; the malformed remainder could not be rendered safely." };
  }
  const record = data as Record<string, unknown>;
  const safe: string[] = [];
  const withheld: string[] = [];
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (typeof file !== "object" || file === null || Array.isArray(file)) {
        withheld.push("malformed member");
        continue;
      }
      const entry = file as Record<string, unknown>;
      const rawPath = typeof entry.path === "string" ? entry.path : undefined;
      const path = rawPath === undefined ? undefined : normalizeReadPath(rawPath);
      const bound = path !== undefined && requested.has(path);
      if (!bound || path === undefined || isSensitivePath(path) || sensitiveRequested.has(path)) {
        withheld.push(path ?? "missing-path member");
      } else {
        safe.push(typeof entry.rendered === "string" ? entry.rendered : path);
      }
    }
  }
  if (Array.isArray(record.errors)) {
    for (const error of record.errors) {
      if (typeof error !== "object" || error === null || Array.isArray(error)) {
        withheld.push("malformed error");
        continue;
      }
      const entry = error as Record<string, unknown>;
      const rawPath = typeof entry.path === "string" ? entry.path : undefined;
      const path = rawPath === undefined ? undefined : normalizeReadPath(rawPath);
      if (path === undefined || !requested.has(path) || isSensitivePath(path) || sensitiveRequested.has(path)) {
        withheld.push(path ?? "missing-path error");
      } else {
        safe.push(`${path}: ${typeof entry.message === "string" ? entry.message : "read failed"}`);
      }
    }
  }
  return {
    ...execution,
    text: [
      `Sensitive content withheld or unbound for: ${[...new Set(withheld)].join(", ") || "read member"}.`,
      ...safe,
    ].join("\n\n"),
  };
}

function virtualizePartialReadMany(
  action: ProposedAction,
  execution: Execution,
  virtualizedPaths: readonly string[],
): Execution {
  if (action.toolId !== "fs.read_many" || virtualizedPaths.length === 0) return execution;
  const promoted = new Set(virtualizedPaths.map(normalizeReadPath));
  const requested = new Set((action.reads ?? []).map(normalizeReadPath));
  const data = execution.result.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return execution;
  const record = data as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (typeof file !== "object" || file === null || Array.isArray(file)) {
        lines.push("Malformed read member withheld.");
        continue;
      }
      const entry = file as Record<string, unknown>;
      const rawPath = typeof entry.path === "string" ? entry.path : undefined;
      const path = rawPath === undefined ? undefined : normalizeReadPath(rawPath);
      if (path === undefined || !requested.has(path) || isSensitivePath(path)) {
        lines.push(`Sensitive or unbound content withheld for ${path ?? "missing-path member"}.`);
      } else if (promoted.has(path)) {
        const checksum = typeof entry.checksum === "string" ? ` checksum ${entry.checksum}` : "";
        lines.push(`${path}: exact content promoted to repository context;${checksum || " locator only"}.`);
      } else {
        lines.push(typeof entry.rendered === "string" ? entry.rendered : path);
      }
    }
  }
  if (Array.isArray(record.errors)) {
    for (const error of record.errors) {
      if (typeof error !== "object" || error === null || Array.isArray(error)) continue;
      const entry = error as Record<string, unknown>;
      const rawPath = typeof entry.path === "string" ? entry.path : undefined;
      const path = rawPath === undefined ? undefined : normalizeReadPath(rawPath);
      if (path === undefined || !requested.has(path) || isSensitivePath(path)) {
        lines.push(`Sensitive or unbound read error withheld for ${path ?? "missing-path error"}.`);
      } else {
        lines.push(`${path}: ${typeof entry.message === "string" ? entry.message : "read failed"}`);
      }
    }
  }
  return { ...execution, text: lines.join("\n\n") };
}

function applyReadDisposition(
  action: ProposedAction,
  execution: Execution,
  disposition: ToolObservationDisposition,
  virtualizedPaths: readonly string[] = [],
): Execution {
  if (disposition === "promoted") return virtualizePromotedRead(action, execution);
  if (disposition === "withheld") return virtualizeWithheldRead(action, execution);
  if (virtualizedPaths.length > 0) return virtualizePartialReadMany(action, execution, virtualizedPaths);
  return sanitizeSensitiveRawRead(action, execution);
}

/**
 * Executes native tools against the runtime.
 *
 * `spill` awaits the runtime's `artifact.create` so the handle the observation
 * carries is the one the store actually minted (P0-08). An id/digest invented
 * here could never read the stored bytes back, which made every spilled output
 * a dangling reference.
 */
export class RuntimeToolExecutor implements ToolExecutor {
  readonly #options: ToolExecutorOptions;
  readonly #spilled: ArtifactRef[] = [];

  constructor(options: ToolExecutorOptions) {
    this.#options = options;
  }

  get spilledArtifacts(): readonly ArtifactRef[] {
    return this.#spilled;
  }

  async execute(action: ProposedAction, signal: AbortSignal): Promise<Execution> {
    const started = this.#options.host.now();
    const initialScope = this.#options.scope?.() ?? {};
    const cache = this.#options.readCache;
    const effectiveAction = actionWithReadPaths(action, this.#options.runtime.workspace);
    const canShareRead =
      cache !== undefined &&
      CACHEABLE_READ_TOOLS.has(effectiveAction.toolId) &&
      !readNeedsCapability(effectiveAction);
    const authorityScope = canShareRead
      ? `workspace:${cachePath(this.#options.runtime.workspace)}:read`
      : undefined;
    const cacheKey =
      canShareRead
        ? cache.key(
            effectiveAction.toolId,
            effectiveAction.arguments,
            initialScope.workspaceGeneration?.toString(),
            authorityScope,
          )
        : undefined;
    const cacheEpoch = cache !== undefined && cacheKey !== undefined
      ? cache.version(cacheKey)
      : undefined;
    let cacheHit = false;
    let execution: Execution;

    if (cache !== undefined && cacheKey !== undefined) {
      const entry = cache.getEntry(
        cacheKey,
        authorityScope === undefined ? {} : { authorityScope },
      );
      if (entry !== undefined) {
        const fresh = await this.#cacheEntryFresh(effectiveAction, entry, initialScope);
        if (fresh && cache.version(cacheKey) === cacheEpoch) {
          cacheHit = true;
          execution = { ...entry.execution, durationMs: this.#options.host.now() - started };
          return await this.#present(effectiveAction, execution, true, initialScope, started);
        }
      }
    }

    const dispatch = async (): Promise<Execution> => {
      try {
        const dispatched = await this.#dispatch(effectiveAction, signal);
        let result: Execution = {
          ...dispatched,
          durationMs: dispatched.durationMs ?? this.#options.host.now() - started,
        };
        // Read outputs must be bound/sanitized member-by-member before any artifact
        // is minted; otherwise a mixed aggregate can store sensitive bytes.
        if (effectiveAction.toolId !== "fs.read" && effectiveAction.toolId !== "fs.read_many") {
          result = await this.#attachLargeOutputArtifact(effectiveAction, result);
        }
        return result;
      } catch (error) {
        return {
          result: toolErrorFrom(error),
          durationMs: this.#options.host.now() - started,
        };
      }
    };

    if (cache !== undefined && cacheKey !== undefined) {
      const coalesced = cache.coalesce(cacheKey, dispatch, {
        paths: readPathsForAction(effectiveAction, this.#options.runtime.workspace),
      });
      cacheHit = coalesced.shared;
      execution = await coalesced.promise;
    } else {
      execution = await dispatch();
    }

    const currentGeneration = this.#options.scope?.().workspaceGeneration;
    if (
      cacheKey !== undefined &&
      ((cacheEpoch !== undefined && cache?.version(cacheKey) !== cacheEpoch) ||
        (initialScope.workspaceGeneration !== undefined &&
          currentGeneration !== undefined &&
          currentGeneration !== initialScope.workspaceGeneration))
    ) {
      execution = {
        result: errorResult(
          "PATH_CHANGED",
          "the workspace changed while this read was in flight; read again",
          { retryable: true },
        ),
        durationMs: this.#options.host.now() - started,
      };
    }
    // Only a clean read from the same workspace generation is cached: an error
    // observed now may be a transient state the next call should re-check.
    if (
      cache !== undefined &&
      cacheKey !== undefined &&
      execution.result.ok &&
      !readContainsSensitivePath(effectiveAction, execution) &&
      (cacheEpoch === undefined || cache.version(cacheKey) === cacheEpoch)
    ) {
      cache.set(
        cacheKey,
        execution,
        readCacheMetadataFor(
          effectiveAction,
          execution,
          this.#options.runtime.workspace,
          authorityScope ?? "",
          initialScope.agentId,
        ),
      );
    }

    if (
      effectiveAction.toolId === "process.run" ||
      effectiveAction.toolId === "shell.run" ||
      effectiveAction.toolId === "process.start" ||
      effectiveAction.toolId === "process.input" ||
      effectiveAction.toolId === "process.stop"
    ) {
      try {
        this.#options.onWorkspacePotentiallyChanged?.(effectiveAction.toolId, effectiveAction);
      } catch {
        // Context invalidation is conservative bookkeeping; it cannot rewrite
        // the runtime's process result.
      }
    }
    return await this.#present(effectiveAction, execution, cacheHit, initialScope, started);
  }

  async #cacheEntryFresh(
    action: ProposedAction,
    entry: ReadCacheEntry,
    scope: ReturnType<NonNullable<ToolExecutorOptions["scope"]>>,
  ): Promise<boolean> {
    const paths = entry.metadata.paths ?? [];
    const tokens = entry.metadata.revisionTokens;
    // A child consuming a parent-owned entry is already within the same
    // workspace/authority scope. Do not turn delegation reuse into a second
    // fingerprint RPC; the entry TTL and mutation fences still apply.
    if (
      entry.metadata.ownerAgentId !== undefined &&
      scope.agentId !== undefined &&
      entry.metadata.ownerAgentId !== scope.agentId
    ) return true;
    if (paths.length === 0 || tokens === undefined || Object.keys(tokens).length === 0) {
      // With no fingerprint provider, do not reuse a same-agent exact read. A
      // child can still consume the parent's read, preserving delegation sharing.
      return !(
        entry.metadata.ownerAgentId !== undefined &&
        scope.agentId !== undefined &&
        entry.metadata.ownerAgentId === scope.agentId
      );
    }

    const runtime = this.#options.runtime as Runtime & {
      fingerprint?: (path: string) => Promise<unknown>;
    };
    if (typeof runtime.fingerprint !== "function") {
      return !(
        entry.metadata.ownerAgentId !== undefined &&
        scope.agentId !== undefined &&
        entry.metadata.ownerAgentId === scope.agentId
      );
    }

    for (const path of paths) {
      const expected = tokens[path];
      if (expected === undefined) return false;
      try {
        const current = await runtime.fingerprint(path);
        const currentToken = typeof current === "string" ? current : readRevisionToken(current);
        if (currentToken === undefined || currentToken !== expected) return false;
      } catch {
        // A failed fingerprint is not proof that the old bytes are safe.
        return false;
      }
    }
    return true;
  }

  async #present(
    action: ProposedAction,
    execution: Execution,
    cacheHit: boolean,
    scope: ReturnType<NonNullable<ToolExecutorOptions["scope"]>>,
    started: number,
  ): Promise<Execution> {
    this.#notifyTouched(action);
    const acknowledgement = await this.#notifyObservation(action, execution, cacheHit, scope);
    const settledGeneration = this.#options.scope?.().workspaceGeneration;
    const generationChanged = CACHEABLE_READ_TOOLS.has(action.toolId) &&
      acknowledgement.workspaceGeneration !== undefined &&
      settledGeneration !== acknowledgement.workspaceGeneration;
    if (generationChanged) {
      try { acknowledgement.onGenerationMismatch?.(); } catch { /* compiler cleanup is isolated */ }
      return {
        result: errorResult("PATH_CHANGED", "the workspace changed while this read was being compiled; read again", { retryable: true }),
        durationMs: this.#options.host.now() - started,
      };
    }
    const providerExecution = applyReadDisposition(
      action,
      execution,
      acknowledgement.disposition,
      acknowledgement.virtualizedPaths ?? [],
    );
    return await this.#attachLargeOutputArtifact(action, providerExecution);
  }

  #notifyTouched(action: ProposedAction): void {
    const paths = [...(action.reads ?? []), ...(action.writes ?? [])];
    if (paths.length === 0) return;
    try {
      this.#options.onPathsTouched?.(paths);
    } catch {
      // Context/instruction refresh is best-effort and cannot turn a successful
      // runtime operation into a failed tool result.
    }
  }

  async #notifyObservation(
    action: ProposedAction,
    execution: Execution,
    cacheHit: boolean,
    scope: ReturnType<NonNullable<ToolExecutorOptions["scope"]>>,
  ): Promise<ToolObservationAck> {
    const containsSensitive = readContainsSensitivePath(action, execution);
    const callback = this.#options.onObservation;
    if (callback === undefined) return { disposition: "raw" };
    try {
      const result = await callback({
        action,
        execution,
        cacheHit,
        observedAtMs: this.#options.host.now(),
        ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
        ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
        ...(scope.workspaceGeneration !== undefined
          ? { workspaceGeneration: scope.workspaceGeneration }
          : {}),
      });
      if (typeof result === "object" && result !== null && "disposition" in result) {
        const acknowledgement = result as ToolObservationAck;
        if (["promoted", "withheld", "raw"].includes(acknowledgement.disposition)) {
          return acknowledgement;
        }
      }
      if (result === false || result === "raw") return { disposition: "raw" };
      if (result === "withheld") return { disposition: "withheld" };
      return { disposition: containsSensitive ? "withheld" : "promoted" };
    } catch {
      // If the context compiler is unavailable, a read response has not passed
      // path binding, freshness, or sensitive-path validation. Preserve the
      // runtime success result but fail the provider view closed.
      return { disposition: containsSensitive ? "withheld" : "raw" };
    }
  }

  async #attachLargeOutputArtifact(
    action: ProposedAction,
    execution: Execution,
  ): Promise<Execution> {
    const text = execution.text;
    if (
      text === undefined ||
      new TextEncoder().encode(text).byteLength <= OBSERVATION_ARTIFACT_THRESHOLD_BYTES ||
      action.toolId === "artifact.read" ||
      (execution.result.artifacts?.length ?? 0) > 0
    ) {
      return execution;
    }
    const artifact = await this.spill(`${action.toolId}-${action.callId}.log`, text);
    if (artifact === undefined) return execution;
    try { this.#options.onArtifactSpilled?.(artifact, action); } catch { /* inspector bookkeeping is isolated */ }
    const previewChars = 4_096;
    const head = text.slice(0, previewChars);
    const tail = text.length > previewChars ? text.slice(-previewChars) : "";
    return {
      ...execution,
      text: [
        head,
        ...(tail.length > 0 ? ["\n… full output spilled …\n", tail] : []),
        `\n[artifact id:${artifact.id} sha256:${artifact.digest} ${artifact.bytes} bytes; use artifact.read with {"digest":"${artifact.digest}"}]`,
      ].join(""),
      result: {
        ...execution.result,
        artifacts: [...(execution.result.artifacts ?? []), artifact],
      },
    };
  }

  async spill(label: string, content: string): Promise<ArtifactRef | undefined> {
    try {
      const response = (await this.#options.runtime.createArtifact({
        mediaType: "text/plain; charset=utf-8",
        content,
        encoding: "utf8",
        displayName: label,
        // The runtime's parameter is `retention`, not `retentionClass`.
        retention: "session",
      })) as { artifact?: Partial<ArtifactRef> & Record<string, unknown> };

      const artifact = response.artifact;
      if (artifact === undefined || typeof artifact.id !== "string" || typeof artifact.digest !== "string") {
        return undefined;
      }
      // Use only what the store minted: its id and digest address the bytes it
      // actually stored (after redaction), so the handle can read them back.
      const ref: ArtifactRef = {
        id: artifact.id,
        digest: artifact.digest,
        mediaType: typeof artifact.mediaType === "string" ? artifact.mediaType : "text/plain; charset=utf-8",
        bytes: typeof artifact.bytes === "number" ? artifact.bytes : new TextEncoder().encode(content).byteLength,
        redaction: artifact.redaction === "raw" || artifact.redaction === "derived" ? artifact.redaction : "redacted",
        displayName: label,
        retentionClass:
          artifact.retentionClass === "temporary" || artifact.retentionClass === "pinned"
            ? artifact.retentionClass
            : "session",
      };
      this.#spilled.push(ref);
      return ref;
    } catch {
      // §22.9: losing a spill degrades evidence, not the turn. Returning
      // `undefined` lets the observation say the output could not be stored
      // instead of pointing at a handle that does not resolve.
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async #dispatch(action: ProposedAction, signal: AbortSignal): Promise<Execution> {
    const runtime = this.#options.runtime;

    const workspace = runtime.workspace;
    switch (action.toolId) {
      case "todo.write":
        if (this.#options.bridges?.todo === undefined) {
          return {
            result: errorResult("TODO_UNAVAILABLE", "the session TODO controller is unavailable", { retryable: false }),
          };
        }
        return await this.#options.bridges.todo(action, signal);
      // ---- reads ----
      case "repo.investigate": {
        const input = args(action);
        const queries = Array.isArray(input.queries)
          ? input.queries.filter((query): query is string => typeof query === "string").slice(0, 5)
          : [];
        const requestedPaths = Array.isArray(input.paths)
          ? input.paths.filter((path): path is string => typeof path === "string").slice(0, 20)
          : [];
        const maxFiles = Math.max(1, Math.min(50, num(action, "maxFiles") ?? 20));
        const maxLinesPerFile = Math.max(1, Math.min(1_000, num(action, "maxLinesPerFile") ?? 200));
        const manifestPaths = input.includeManifests === false
          ? []
          : [
              "package.json", "pnpm-workspace.yaml", "tsconfig.json", "Cargo.toml",
              "pyproject.toml", "go.mod", "pom.xml", "build.gradle",
            ];
        const readPaths = [...new Set([...requestedPaths, ...manifestPaths])].slice(0, maxFiles);
        const normalizedPaths = readPaths.map((path) => workspacePath(path, workspace));
        const readAction = { ...action, reads: normalizedPaths };
        const capability = readNeedsCapability(readAction)
          ? await this.#issueCapability(readAction)
          : undefined;

        const searchesPromise = Promise.all(queries.map(async (query) => {
          try {
            const result = await runtime.search(query, normalizeRuntimeOptions({
              maxMatches: Math.max(1, Math.ceil(maxFiles / Math.max(1, queries.length))),
            }, workspace)) as {
              matches?: Array<{ path: string; line: number; text: string }>;
              filesWithMatches?: number;
              truncated?: boolean;
            };
            return { query, ...result };
          } catch (error) {
            return { query, error: error instanceof Error ? error.message : String(error) };
          }
        }));
        const readsPromise = normalizedPaths.length === 0
          ? Promise.resolve({ files: [], errors: [] } as {
              files: Array<{ path: string; rendered?: string }>;
              errors: Array<{ path: string; message: string }>;
            })
          : runtime.readMany({
              items: normalizedPaths.map((path) => ({ path, startLine: 1, maxLines: maxLinesPerFile })),
              maxTotalLines: maxLinesPerFile * Math.max(1, normalizedPaths.length),
              maxTotalBytes: 2 * 1_024 * 1_024,
              ...capabilityFields(capability),
            } as never).catch((error) => ({
              files: [],
              errors: [{ path: "<batch>", message: error instanceof Error ? error.message : String(error) }],
            }));
        const diffPromise = input.includeGitDiff === true
          ? runtime.gitDiff(normalizeRuntimeOptions(
              requestedPaths.length > 0 ? { paths: requestedPaths } : {},
              workspace,
            )).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
          : Promise.resolve(undefined);
        const [searches, readsRaw, diff] = await Promise.all([
          searchesPromise,
          readsPromise,
          diffPromise,
        ]);
        const reads = readsRaw as {
          files: Array<{ path: string; rendered?: string }>;
          errors: Array<{ path: string; message: string }>;
        };
        const sections = [
          ...searches.map((search) => {
            const matches = "matches" in search && Array.isArray(search.matches)
              ? search.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")
              : `[search failed: ${"error" in search ? search.error : "no matches"}]`;
            return `## Search: ${search.query}\n${matches}`;
          }),
          ...reads.files.map((file) => `## File: ${file.path}\n${file.rendered ?? ""}`),
          ...reads.errors.map((error) => `## File error: ${error.path}\n${error.message}`),
          ...(diff === undefined ? [] : [`## Git diff\n${renderCompoundDiff(diff)}`]),
        ];
        const rendered = sections.join("\n\n");
        const limit = 64 * 1_024;
        const text = rendered.length <= limit
          ? rendered
          : rendered.slice(0, limit) + "\n\n[repo.investigate output truncated at 64 KiB]";
        return {
          result: okResult(
            `investigated ${queries.length} query(s) and ${reads.files.length} file(s)`,
            { searches, reads, diff, truncated: rendered.length > limit },
          ),
          text,
        };
      }

      case "fs.read": {
        const capability = readNeedsCapability(action) ? await this.#issueCapability(action) : undefined;
        const data = (await runtime.read(workspacePath(str(action, "path") ?? ".", workspace), {
          ...normalizeRuntimeOptions(stripPath(args(action)), workspace),
          ...capabilityFields(capability),
        })) as {
          rendered?: string;
          binary?: boolean;
          path: string;
        };
        if (data.binary === true) {
          return {
            result: okResult(`${data.path} is binary`, data),
            text: `${data.path} is a binary file; no text excerpt is available.`,
          };
        }
        return {
          result: okResult(`read ${data.path}`, data),
          text: data.rendered ?? "",
        };
      }

      case "fs.read_many": {
        const itemRecords = readManyItemRecords(action);
        const items = itemRecords
          .filter((item): item is Record<string, unknown> & { path: string } => typeof item.path === "string")
          .map((item) => normalizeRuntimeOptions({
            ...item,
            path: workspacePath(item.path, workspace),
          }, workspace));
        const rawPaths = args(action).paths;
        const paths = items.length > 0
          ? items.map((item) => String(item.path))
          : (Array.isArray(rawPaths) ? rawPaths.filter((path): path is string => typeof path === "string").map((path) => workspacePath(path, workspace)) : []);
        const readAction = { ...action, reads: paths };
        const capability = readNeedsCapability(readAction) ? await this.#issueCapability(readAction) : undefined;
        const readOptions = {
          ...normalizeRuntimeOptions(stripPath(args(action)), workspace),
          ...capabilityFields(capability),
        };
        const data = (await (items.length > 0
          ? runtime.readMany({ items, ...readOptions } as never)
          : runtime.readMany(paths, readOptions))) as {
          files: Array<{ rendered?: string; path: string }>;
          errors: Array<{ path: string; message: string }>;
          truncated?: boolean;
          requested?: number;
          limit?: number;
        };
        const text = [
          ...data.files.map((file) => file.rendered ?? file.path),
          ...data.errors.map((error) => `${error.path}: ${error.message}`),
        ].join("\n\n");
        return {
          result: okResult(
            "read " + data.files.length + " file(s)" + (data.truncated ? " (first " + (data.limit ?? data.files.length) + " of " + (data.requested ?? "many") + ")" : ""),
            data,
          ),
          text: data.truncated ? text + "\n[read_many truncated]" : text,
        };
      }

      case "fs.list": {
        const data = (await runtime.list(workspacePath(str(action, "path") ?? ".", workspace), normalizeRuntimeOptions(stripPath(args(action)), workspace))) as {
          path: string;
          entries: Array<{ path?: string; name?: string; kind?: string }>;
          truncated: boolean;
        };
        const text = data.entries
          .map((entry) => `${entry.kind === "directory" ? "d" : "-"} ${entry.path ?? entry.name ?? ""}`)
          .join("\n");
        return {
          result: okResult(`${data.entries.length} entries in ${data.path}`, data),
          text: data.truncated ? `${text}\n[listing truncated]` : text,
        };
      }

      case "fs.glob": {
        const data = (await runtime.glob(workspacePath(str(action, "pattern") ?? "*", workspace), normalizeRuntimeOptions(stripPath(args(action)), workspace))) as {
          entries: Array<{ path?: string } | string>;
          truncated: boolean;
        };
        const paths = data.entries.map((entry) =>
          typeof entry === "string" ? entry : (entry.path ?? ""),
        );
        return {
          result: okResult(`${paths.length} match(es)`, { ...data, paths }),
          text: data.truncated ? `${paths.join("\n")}\n[truncated]` : paths.join("\n"),
        };
      }

      case "fs.search": {
        const data = (await runtime.search(str(action, "query") ?? "", normalizeRuntimeOptions(stripPath(args(action)), workspace))) as {
          matches: Array<{ path: string; line: number; text: string }>;
          filesWithMatches: number;
          truncated: boolean;
        };
        const text = data.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
        return {
          result: okResult(
            `${data.matches.length} match(es) in ${data.filesWithMatches} file(s)`,
            data,
          ),
          text: data.truncated ? `${text}\n[search truncated]` : text,
        };
      }

      // ---- mutations (§12.5, §12.6) ----
      case "fs.apply_patch": {
        const capability = await this.#issueCapability(action);
        return await this.#mutate(action, capability.id, async (transactionId) => {
          const staged = (await runtime.patch({
            transactionId,
            capabilityReceipt: capability.id,
            capabilitySessionId: capability.sessionId,
            capabilityActionHash: capability.actionHash,
            diff: normalizeDiffPaths(str(action, "diff") ?? "", workspace),
            ...(args(action).expectedHashes !== undefined
              ? { expectedHashes: normalizeExpectedHashes(args(action).expectedHashes, workspace) }
              : {}),
          })) as { stagedPaths: string[]; files: Array<{ path: string; hunks: number }> };
          return staged;
        });
      }

      case "fs.write": {
        const capability = await this.#issueCapability(action);
        return await this.#mutate(action, capability.id, async (transactionId) => {
          const writeIntent = str(action, "intent");
          const expectedHash = str(action, "expectedHash");
          // Strict provider schemas commonly materialize an optional string as
          // the empty string. An empty expectation means "not supplied" for
          // create/upsert, and forwarding it makes older sidecars report
          // HASH_MISMATCH for a path that is correctly absent. Replace keeps
          // the empty value strict so a caller cannot bypass the concurrency
          // check on an existing file.
          const expectedHashParam =
            expectedHash !== undefined &&
            (writeIntent === "replace" || expectedHash.length > 0)
              ? { expectedHash }
              : {};
          return (await runtime.write({
            transactionId,
            capabilityReceipt: capability.id,
            capabilitySessionId: capability.sessionId,
            capabilityActionHash: capability.actionHash,
            path: workspacePath(str(action, "path") ?? "", workspace),
            content: str(action, "content") ?? "",
            ...(writeIntent !== undefined ? { intent: writeIntent } : {}),
            ...expectedHashParam,
          })) as { stagedPaths: string[] };
        });
      }

      case "fs.move": {
        const capability = await this.#issueCapability(action);
        return await this.#mutate(action, capability.id, async (transactionId) => {
          return (await runtime.move({
            transactionId,
            capabilityReceipt: capability.id,
            capabilitySessionId: capability.sessionId,
            capabilityActionHash: capability.actionHash,
            from: workspacePath(str(action, "from") ?? "", workspace),
            to: workspacePath(str(action, "to") ?? "", workspace),
            ...(str(action, "expectedHash") !== undefined && str(action, "expectedHash") !== ""
              ? { expectedHash: str(action, "expectedHash") }
              : {}),
          })) as { from: string; to: string };
        });
      }

      case "fs.delete": {
        const capability = await this.#issueCapability(action);
        return await this.#mutate(action, capability.id, async (transactionId) => {
          return (await runtime.delete({
            transactionId,
            capabilityReceipt: capability.id,
            capabilitySessionId: capability.sessionId,
            capabilityActionHash: capability.actionHash,
            path: workspacePath(str(action, "path") ?? "", workspace),
            ...(args(action).recursive === true ? { recursive: true } : {}),
            ...(str(action, "expectedHash") !== undefined && str(action, "expectedHash") !== ""
              ? { expectedHash: str(action, "expectedHash") }
              : {}),
          })) as { stagedPaths: string[] };
        });
      }

      // ---- artifacts (§18.17) ----
      case "artifact.read": {
        const response = await runtime.readArtifact({
          digest: str(action, "digest"),
          ...(num(action, "excerptHeadLines") !== undefined ? { excerptHeadLines: num(action, "excerptHeadLines") } : {}),
          ...(num(action, "excerptTailLines") !== undefined ? { excerptTailLines: num(action, "excerptTailLines") } : {}),
          ...(num(action, "excerptMaxBytes") !== undefined ? { excerptMaxBytes: num(action, "excerptMaxBytes") } : {}),
        });
        const record = response as Record<string, unknown>;
        return {
          result: okResult(`Read artifact sha256:${str(action, "digest")?.slice(0, 12)}…`, response),
          text: typeof record.rendered === "string" ? record.rendered : JSON.stringify(response),
        };
      }

      // ---- processes (§12.7, §12.8) ----
      case "process.run":
      case "shell.run": {
        const capability = await this.#issueCapability(action);
        // A process can write anywhere in the workspace, so cached reads die
        // before it runs — a stale listing served after a build or a test run
        // is exactly the staleness the cache must never introduce.
        this.#options.readCache?.invalidateAll();
        // P0-04: the turn's abort signal reaches the runtime, which cancels the
        // foreground process instead of letting it outlive the turn.
        const outcome = await runtime.run(this.#processParams(action, capability.id), signal);
        const failed = outcome.state !== "exited" || (outcome.exitCode ?? 0) !== 0;
        const text = renderProcessOutcome(outcome);
        if (failed) {
          return {
            result: errorResult(
              (outcome.taxonomy as ToolErrorCode | null | undefined) ?? "PROCESS_EXIT_NONZERO",
              `${outcome.display} exited with ${outcome.exitCode ?? outcome.state}`,
              { details: { jobId: outcome.jobId }, summary: `${outcome.display} failed` },
            ),
            text,
            ...(outcome.exitCode !== null && outcome.exitCode !== undefined
              ? { exitCode: outcome.exitCode }
              : {}),
            durationMs: outcome.durationMs,
          };
        }
        return {
          result: okResult(`${outcome.display} succeeded`, outcome),
          text,
          exitCode: 0,
          durationMs: outcome.durationMs,
        };
      }

      case "process.start": {
        const capability = await this.#issueCapability(action);
        // A background job keeps mutating the workspace after this call
        // returns; dropping the cache now is the only invalidation point it
        // will ever get, and the TTL covers the rest.
        this.#options.readCache?.invalidateAll();
        const job = await runtime.startJob(this.#processParams(action, capability.id));
        this.#options.onJobStarted?.(job);
        return {
          result: okResult(`started ${job.display} as ${job.jobId}`, job),
          text: `Background job ${job.jobId} started: ${job.display}`,
        };
      }

      case "process.input": {
        // Input can drive a long-lived process that mutates the workspace; fence
        // reads before delivering it, just like foreground execution.
        this.#options.readCache?.invalidateAll();
        const data = (await runtime.sendInput({
          jobId: str(action, "jobId") ?? "",
          ...(str(action, "data") !== undefined ? { data: str(action, "data") } : {}),
          ...(args(action).close === true ? { close: true } : {}),
        }, this.#options.sessionId ?? "session-unknown")) as Record<string, unknown>;
        return { result: okResult("input delivered", data) };
      }

      case "process.stop": {
        // The job wrote while it lived; whatever was cached during that window
        // is suspect.
        this.#options.readCache?.invalidateAll();
        const data = (await runtime.stopJob(
          str(action, "jobId") ?? "",
          num(action, "graceMs"),
          this.#options.sessionId ?? "session-unknown",
        )) as Record<string, unknown>;
        return { result: okResult("job stopped", data) };
      }

      // ---- git (§12.2) ----
      case "git.status": {
        const data = await runtime.gitStatus();
        return { result: okResult("git status", data), text: data.statusBar };
      }

      case "git.diff": {
        const data = (await runtime.gitDiff(normalizeRuntimeOptions({ ...args(action) }, workspace))) as {
          files: Array<{ path: string; patch: string; additions: number; deletions: number }>;
          totalAdditions: number;
          totalDeletions: number;
        };
        const text = data.files
          .map((file) => `${file.path} +${file.additions} -${file.deletions}\n${file.patch}`)
          .join("\n");
        return {
          result: okResult(
            `${data.files.length} file(s), +${data.totalAdditions} -${data.totalDeletions}`,
            data,
          ),
          text,
        };
      }

      case "git.log": {
        const data = (await runtime.gitLog(normalizeRuntimeOptions({ ...args(action) }, workspace))) as {
          entries: Array<{ hash?: string; subject?: string; author?: string; date?: string }>;
        };
        const text = data.entries
          .map((e) => `${(e.hash ?? "").slice(0, 8)} ${e.date ?? ""} ${e.author ?? ""} ${e.subject ?? ""}`)
          .join("\n");
        return { result: okResult(`${data.entries.length} commit(s)`, data), text };
      }

      case "git.show": {
        const data = (await runtime.gitShow({
          revision: str(action, "revision") ?? "HEAD",
          ...(str(action, "path") !== undefined
                ? { path: workspacePath(str(action, "path")!, workspace) }
                : {}),
        })) as { content: string; revision: string };
        return { result: okResult(`showed ${data.revision}`, data), text: data.content };
      }

      case "git.checkpoint": {
        const data = (await runtime.gitCheckpoint(str(action, "label"))) as Record<string, unknown>;
        // P1-06: the runtime flags sensitive-looking paths the checkpoint is about
        // to capture. Surface them to the timeline so the user sees what will be
        // sealed in, instead of discovering it after the fact.
        const warnings = Array.isArray(data.warnings)
          ? (data.warnings as unknown[]).filter((w): w is string => typeof w === "string")
          : [];
        const text =
          warnings.length > 0
            ? `Created a safety checkpoint.\n${warnings.map((w) => `warning: ${w}`).join("\n")}`
            : undefined;
        return {
          result: okResult("created a safety checkpoint", data),
          ...(text !== undefined ? { text } : {}),
        };
      }

      // ---- interaction and extension ----
      case "user.ask": {
        const bridge = this.#options.bridges?.ask;
        if (bridge === undefined) {
          // §13.8: headless mode never prompts. The model observes the refusal and
          // must proceed on its own evidence or stop.
          return {
            result: errorResult(
              "PERMISSION_DENIED",
              "user.ask is unavailable in this mode; no interactive user is attached",
              { summary: "cannot ask the user in a non-interactive run" },
            ),
            text: "No interactive user is attached. Decide from available evidence or report a blocker.",
          };
        }
        const question = str(action, "question") ?? "";
        const choices = (args(action).choices as string[] | undefined) ?? [];
        const answer = await bridge(question, choices, signal);
        return {
          result: okResult("the user answered", { question, answer }),
          text: `User answered: ${answer}`,
        };
      }

      case "task.search":
      case "task.spawn":
      case "task.status":
      case "task.cancel":
        return await this.#viaBridge("task", action, signal, "subagents are not available");

      case "skill.search":
      case "skill.load":
        return await this.#viaBridge("skill", action, signal, "Skills are not available");

      case "mcp.search":
      case "mcp.call":
      case "mcp.read_resource":
        return await this.#viaBridge("mcp", action, signal, "no MCP server is configured");

      default:
        return {
          result: errorResult("INVALID_ARGUMENT", `no executor for tool '${action.toolId}'`),
        };
    }
  }

  async #viaBridge(
    name: "task" | "skill" | "mcp",
    action: ProposedAction,
    signal: AbortSignal,
    unavailable: string,
  ): Promise<Execution> {
    const bridge = this.#options.bridges?.[name];
    if (bridge === undefined) {
      return {
        result: errorResult(
          name === "mcp" ? "MCP_UNAVAILABLE" : "NOT_FOUND",
          `${action.toolId} is unavailable: ${unavailable}`,
        ),
      };
    }
    return await bridge(action, signal);
  }

  async #issueCapability(action: ProposedAction): Promise<CapabilityReceipt> {
    const runtime = this.#options.runtime as Runtime & {
      issueCapability?: (params: Record<string, unknown>) => Promise<CapabilityReceipt>;
    };
    if (runtime.issueCapability === undefined) {
      return {
        id: `test-cap-${action.callId}`,
        sessionId: this.#options.sessionId ?? "test-session",
        callId: action.callId,
        actionHash: actionHash(action),
        workspaceId: "test-workspace",
        operation: action.writes !== undefined && action.writes.length > 0
          ? "fs.transaction"
          : action.toolId === "fs.read_many" ? "fs.read" : action.toolId,
        resources: [...(action.reads ?? []), ...(action.writes ?? [])],
        network: "deny",
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        singleUse: true,
      };
    }
    const command = action.command;
    const raw = args(action);
    const shell = action.toolId === "shell.run";
    const program = shell
      ? str(action, "script") ?? str(action, "command") ?? ""
      : command?.program;
    const commandArgs = shell ? [] : command?.args;
    const cwd = command !== undefined
      ? workspacePath(command.cwd, this.#options.runtime.workspace)
      : undefined;
    const resources = [...(action.reads ?? []), ...(action.writes ?? [])].map((path) =>
      workspacePath(path, this.#options.runtime.workspace),
    );
    if (command !== undefined) resources.push(environmentBinding(raw.env));
    return await runtime.issueCapability({
      sessionId: this.#options.sessionId ?? "session-unknown",
      callId: action.callId,
      actionHash: actionHash(action),
      operation: action.writes !== undefined && action.writes.length > 0
        ? "fs.transaction"
        : action.toolId === "fs.read_many" ? "fs.read" : action.toolId,
      resources,
      ...(program !== undefined ? { program } : {}),
      ...(commandArgs !== undefined ? { args: commandArgs } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      network: command !== undefined && classifyCommand(command).network ? "allow" : "deny",
      ...(raw.networkIntent !== undefined ? { ttlMs: 120_000 } : {}),
    });
  }

  #processParams(action: ProposedAction, capabilityId: string): Record<string, unknown> {
    const raw = args(action);
    const workspace = this.#options.runtime.workspace;
    const command = action.command;
    const base: Record<string, unknown> = {
      program: command?.program ?? str(action, "program") ?? "",
      args: command?.args ?? [],
      cwd: workspacePath(command?.cwd ?? ".", workspace),
      timeoutMs: num(action, "timeoutMs") ?? this.#options.defaultTimeoutMs ?? 120_000,
      ...(num(action, "maxOutputBytes") !== undefined
        ? { maxOutputBytes: num(action, "maxOutputBytes") }
        : {}),
      ...(raw.env !== undefined ? { env: raw.env } : {}),
      ...(str(action, "envPolicy") !== undefined ? { envPolicy: str(action, "envPolicy") } : {}),
      // P0-03: the model's schema no longer carries a network *mode* — only an
      // intent, which the policy engine judged before this executor ran. The
      // runtime therefore receives no caller-chosen mode here and keeps its own
      // default; a future capability lease is the only path to a stricter one.
      ...(str(action, "stdin") !== undefined ? { stdin: str(action, "stdin") } : {}),
      cancelKey: action.callId,
      capabilityReceipt: capabilityId,
      capabilitySessionId: this.#options.sessionId ?? "session-unknown",
      capabilityActionHash: actionHash(action),
    };

    if (action.toolId === "shell.run") {
      // §12.3: a raw shell string goes to the runtime as one script with the
      // `rawShell` flag set, so the runtime applies the stricter isolation rather
      // than inferring intent from the program name.
      const script = str(action, "script") ?? str(action, "command") ?? "";
      return {
        ...base,
        program: script,
        args: [],
        rawShell: true,
        capabilityOperation: "shell.run",
      };
    }
    return base;
  }

  /**
   * Stage a mutation inside its own transaction and commit it.
   *
   * §12.5: staging failure rolls back. Committing separately from staging is what
   * makes a multi-file patch all-or-nothing (AC-14), and the rollback path runs even
   * when the staging error is a hash mismatch from a concurrent user edit (AC-13).
   */
  async #mutate(
    action: ProposedAction,
    capabilityId: string,
    stage: (transactionId: string) => Promise<Record<string, unknown>>,
  ): Promise<Execution> {
    const runtime = this.#options.runtime;
    const scope = this.#options.scope?.() ?? {};
    const begun = await runtime.beginTransaction({
      ...scope,
      capabilityReceipt: capabilityId,
      capabilitySessionId: this.#options.sessionId ?? "session-unknown",
      capabilityActionHash: actionHash(action),
    });
    const transactionId = begun.transactionId;
    this.#options.onTransaction?.({ kind: "started", transactionId, paths: [] });

    let staged: Record<string, unknown>;
    try {
      staged = await stage(transactionId);
    } catch (error) {
      await runtime.rollbackTransaction(transactionId, {
        capabilityReceipt: capabilityId,
        capabilitySessionId: this.#options.sessionId ?? "session-unknown",
        capabilityActionHash: actionHash(action),
      }).catch(() => undefined);
      this.#options.onTransaction?.({ kind: "rolled_back", transactionId, paths: [] });
      return { result: toolErrorFrom(error) };
    }

    try {
      const committed = (await runtime.commitTransaction(transactionId, {
        capabilityReceipt: capabilityId,
        capabilitySessionId: this.#options.sessionId ?? "session-unknown",
        capabilityActionHash: actionHash(action),
      })) as {
        operations?: Array<{ path: string; additions?: number; deletions?: number }>;
        totalAdditions?: number;
        totalDeletions?: number;
      };
       const operationPaths = (committed.operations ?? []).map((op) => op.path);
       const stagedPaths = Array.isArray(staged.stagedPaths)
         ? staged.stagedPaths.filter((path): path is string => typeof path === "string")
         : [];
       const paths = [...new Set([...operationPaths, ...stagedPaths])];
      this.#options.onTransaction?.({ kind: "committed", transactionId, paths });
      // The transaction result names the affected paths, so unrelated reads in
      // this agent and its siblings can remain cached safely.
      if (paths.length > 0) {
        this.#options.readCache?.invalidatePaths(
          paths.map((path) => workspacePath(path, runtime.workspace)),
        );
      }
      else this.#options.readCache?.invalidateAll();

      const data = { transactionId, ...staged, ...committed };
      const additions = committed.totalAdditions ?? 0;
      const deletions = committed.totalDeletions ?? 0;
      return {
        result: okResult(
          `${action.display} (+${additions} -${deletions})`,
          data,
        ),
        text: paths.length > 0
          ? `Committed ${paths.length} file(s): ${paths.join(", ")} (+${additions} -${deletions})`
          : `Committed transaction ${transactionId} with no file changes`,
      };
    } catch (error) {
      await runtime.rollbackTransaction(transactionId, {
        capabilityReceipt: capabilityId,
        capabilitySessionId: this.#options.sessionId ?? "session-unknown",
        capabilityActionHash: actionHash(action),
      }).catch(() => undefined);
      this.#options.onTransaction?.({ kind: "rolled_back", transactionId, paths: [] });
      return { result: toolErrorFrom(error) };
    }
  }
}

/** Drop keys the runtime derives itself, so a stray argument cannot override them. */
function stripPath(raw: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, paths: _paths, items: _items, pattern: _pattern, query: _query, ...rest } = raw;
  return rest;
}

/**
 * Read-only tools whose result is a pure function of the workspace state.
 *
 * These are the calls a parent and its children re-issue verbatim within one
 * turn — `package.json`, the directory listing, `.gitignore`, `git status` —
 * doubling the exploration cost of every delegation. Known mutations invalidate
 * their bound paths; process execution still fences the whole cache, and the TTL
 * bounds edits made outside the agent entirely.
 */
const CACHEABLE_READ_TOOLS: ReadonlySet<string> = new Set([
  "fs.read",
  "fs.read_many",
  "fs.list",
  "fs.glob",
  "fs.search",
  "git.status",
  "git.diff",
  "git.log",
  "git.show",
]);

/** JSON.stringify with sorted keys, so argument order never changes the key. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableStringify(record[key]))
      .join(",") +
    "}"
  );
}

function readManyItemRecords(action: ProposedAction): Array<Record<string, unknown>> {
  const value = args(action).items;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function readPathsForAction(action: ProposedAction, workspace: string): string[] {
  const paths = new Set<string>();
  for (const path of action.reads ?? []) paths.add(workspacePath(path, workspace));
  if (action.toolId === "fs.read") {
    const path = str(action, "path");
    if (path !== undefined) paths.add(workspacePath(path, workspace));
  }
  if (action.toolId === "fs.read_many") {
    const items = readManyItemRecords(action);
    if (items.length > 0) {
      for (const item of items) {
        if (typeof item.path === "string") paths.add(workspacePath(item.path, workspace));
      }
    } else {
      const rawPaths = args(action).paths;
      if (Array.isArray(rawPaths)) {
        for (const path of rawPaths) {
          if (typeof path === "string") paths.add(workspacePath(path, workspace));
        }
      }
    }
  }
  return [...paths];
}

function actionWithReadPaths(action: ProposedAction, workspace: string): ProposedAction {
  if (action.toolId !== "fs.read" && action.toolId !== "fs.read_many") return action;
  const paths = readPathsForAction(action, workspace);
  return paths.length > 0 ? { ...action, reads: paths } : action;
}

/** Extract a revision from either the v2 response or the legacy checksum field. */
export function readRevisionToken(value: unknown): string | undefined {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (typeof record?.revisionToken === "string" && record.revisionToken.length > 0) {
    return record.revisionToken;
  }
  return typeof record?.checksum === "string" && record.checksum.length > 0
    ? record.checksum
    : undefined;
}

function readCacheMetadataFor(
  action: ProposedAction,
  execution: Execution,
  workspace: string,
  authorityScope: string,
  ownerAgentId: string | undefined,
): ReadCacheMetadata {
  const paths = readPathsForAction(action, workspace);
  const revisions: Record<string, string> = {};
  const data = execution.result.data;
  if (action.toolId === "fs.read") {
    const path = typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).path
      : undefined;
    const revision = readRevisionToken(data);
    if (typeof path === "string" && revision !== undefined) revisions[workspacePath(path, workspace)] = revision;
  } else if (action.toolId === "fs.read_many" && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const files = (data as Record<string, unknown>).files;
    if (Array.isArray(files)) {
      for (const file of files) {
        if (typeof file !== "object" || file === null || Array.isArray(file)) continue;
        const record = file as Record<string, unknown>;
        const path = record.path;
        const revision = readRevisionToken(record);
        if (typeof path === "string" && revision !== undefined) revisions[workspacePath(path, workspace)] = revision;
      }
    }
  }
  return {
    paths,
    authority: "read",
    authorityScope,
    ...(ownerAgentId !== undefined ? { ownerAgentId } : {}),
    ...(Object.keys(revisions).length > 0 ? { revisionTokens: revisions } : {}),
    ...(action.toolId === "fs.read" && Object.values(revisions)[0] !== undefined
      ? { revisionToken: Object.values(revisions)[0] } : {}),
  };
}

export interface ReadCacheOptions {
  /** How long an entry may survive external (non-agent) edits. */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export interface ReadCacheMetadata {
  /** Paths whose contents or directory state are represented by the entry. */
  readonly paths?: readonly string[];
  /** Runtime revision/checksum for a single read. */
  readonly revisionToken?: string;
  /** Runtime revisions for members of a read_many response. */
  readonly revisionTokens?: Readonly<Record<string, string>>;
  /** The authority that produced the value; cached values are read-only. */
  readonly authority?: "read" | "session_state" | "workspace_write" | "process" | "network" | "external_effect";
  /** Scope shared by callers allowed to observe this value. */
  readonly authorityScope?: string;
  /** Optional capability scope. Capability-bearing values never match another scope. */
  readonly capabilityScope?: string;
  /** Used only for conservative no-fingerprint fallback validation. */
  readonly ownerAgentId?: string;
}

export interface ReadCacheEntry {
  readonly execution: Execution;
  readonly at: number;
  readonly metadata: ReadCacheMetadata;
}

export interface ReadCacheLookupOptions {
  readonly authorityScope?: string;
  readonly capabilityScope?: string;
}

export interface ReadCacheCoalesced<T> {
  readonly promise: Promise<T>;
  readonly shared: boolean;
}

export interface ReadCacheInflightMetadata {
  readonly paths?: readonly string[];
}

function cachePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized.length === 0 ? "." : normalized;
}

function cachePathsOverlap(left: string, right: string): boolean {
  const a = cachePath(left);
  const b = cachePath(right);
  if (a === "." || b === "." || a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Recover simple legacy path bindings when callers used the old two-argument set API. */
function inferCachePathsFromKey(key: string): readonly string[] | undefined {
  const separator = key.lastIndexOf("\u0000");
  if (separator < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(key.slice(separator + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const path of input.paths) if (typeof path === "string") paths.push(path);
  }
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const path = (item as Record<string, unknown>).path;
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

function copyReadCacheMetadata(metadata: ReadCacheMetadata = {}): ReadCacheMetadata {
  return {
    ...metadata,
    ...(metadata.paths !== undefined ? { paths: [...metadata.paths] } : {}),
    ...(metadata.revisionTokens !== undefined ? { revisionTokens: { ...metadata.revisionTokens } } : {}),
  };
}

/**
 * A shared per-workspace cache of pure read results.
 *
 * One instance is handed to the root executor and to every child executor the
 * subagent bridge runs, so an identical read issued by a child seconds after
 * its parent never reaches the runtime. Completed entries retain the old
 * synchronous `get`/`set` surface, while metadata lets the executor invalidate
 * only known paths and keep authority scopes separate.
 */
export class ReadCache {
  readonly #entries = new Map<string, ReadCacheEntry>();
  readonly #inFlight = new Map<string, { promise: Promise<unknown>; paths?: readonly string[] }>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  #epoch = 0;
  #globalEpoch = 0;
  readonly #keyEpochs = new Map<string, number>();

  constructor(options: ReadCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? (() => Date.now());
  }

  key(toolId: string, args: unknown, generation?: string, authorityScope?: string): string {
    const legacy = toolId + "\u0000" + (generation ?? "") + "\u0000" + stableStringify(args ?? {});
    return authorityScope === undefined
      ? legacy
      : toolId + "\u0000" + (generation ?? "") + "\u0000" + authorityScope + "\u0000" + stableStringify(args ?? {});
  }

  get(key: string): Execution | undefined {
    return this.getEntry(key)?.execution;
  }

  getEntry(key: string, options: ReadCacheLookupOptions = {}): ReadCacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#now() - entry.at >= this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    if (
      entry.metadata.authorityScope !== undefined &&
      entry.metadata.authorityScope !== options.authorityScope
    ) return undefined;
    if (
      entry.metadata.capabilityScope !== undefined &&
      entry.metadata.capabilityScope !== options.capabilityScope
    ) return undefined;
    // Map insertion order is the LRU order. A hit is a touch, but it does not
    // reset the TTL clock: external edits remain bounded by the original age.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  getMetadata(key: string, options: ReadCacheLookupOptions = {}): ReadCacheMetadata | undefined {
    return this.getEntry(key, options)?.metadata;
  }

  /** Version for one key; path-scoped invalidation does not disturb siblings. */
  version(key: string): string {
    return `${this.#globalEpoch}:${this.#keyEpochs.get(key) ?? 0}`;
  }

  touch(key: string): boolean {
    const entry = this.getEntry(key);
    return entry !== undefined;
  }

  set(key: string, execution: Execution, metadata: ReadCacheMetadata = {}): void {
    if (this.#maxEntries <= 0) return;
    // Updating an existing key must not evict an unrelated entry at capacity.
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, {
      execution,
      at: this.#now(),
      metadata: copyReadCacheMetadata(metadata),
    });
  }

  /** Coalesce concurrent misses without changing the completed-value API. */
  coalesce<T>(
    key: string,
    factory: () => Promise<T>,
    metadata: ReadCacheInflightMetadata = {},
  ): ReadCacheCoalesced<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      return { promise: existing.promise as Promise<T>, shared: true };
    }
    const promise = Promise.resolve().then(factory);
    this.#inFlight.set(key, {
      promise,
      ...(metadata.paths === undefined ? {} : { paths: [...metadata.paths] }),
    });
    void promise.then(
      () => { if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key); },
      () => { if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key); },
    );
    return { promise, shared: false };
  }

  /** Promise-only convenience for callers that do not need the shared flag. */
  getOrCreate<T>(key: string, factory: () => Promise<T>): Promise<T> {
    return this.coalesce(key, factory).promise;
  }

  inFlightFor(key: string): Promise<unknown> | undefined {
    return this.#inFlight.get(key)?.promise;
  }

  /** Invalidate entries whose metadata binds them to `path`. */
  invalidatePath(path: string): number {
    const target = cachePath(path);
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      const paths = entry.metadata.paths ?? inferCachePathsFromKey(key);
      // Legacy entries have no safe path binding. Drop them rather than risk a
      // stale hit after a scoped invalidation.
      if (paths === undefined || paths.length === 0 || paths.some((entryPath) => cachePathsOverlap(entryPath, target))) {
        this.#entries.delete(key);
        this.#bumpKey(key);
        removed += 1;
      }
    }
    for (const [key, inFlight] of this.#inFlight) {
      if (inFlight.paths === undefined || inFlight.paths.length === 0 || inFlight.paths.some((entryPath) => cachePathsOverlap(entryPath, target))) {
        this.#inFlight.delete(key);
        this.#bumpKey(key);
      }
    }
    this.#epoch += 1;
    return removed;
  }

  invalidatePaths(paths: readonly string[]): number {
    if (paths.length === 0) return 0;
    const targets = paths.map(cachePath);
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      const entryPaths = entry.metadata.paths ?? inferCachePathsFromKey(key);
      if (
        entryPaths === undefined ||
        entryPaths.length === 0 ||
        entryPaths.some((entryPath) => targets.some((target) => cachePathsOverlap(entryPath, target)))
      ) {
        this.#entries.delete(key);
        this.#bumpKey(key);
        removed += 1;
      }
    }
    for (const [key, inFlight] of this.#inFlight) {
      if (
        inFlight.paths === undefined ||
        inFlight.paths.length === 0 ||
        inFlight.paths.some((entryPath) => targets.some((target) => cachePathsOverlap(entryPath, target)))
      ) {
        this.#inFlight.delete(key);
        this.#bumpKey(key);
      }
    }
    this.#epoch += 1;
    return removed;
  }

  /** Alias useful to mutation call sites that already have a path list. */
  invalidate(pathOrPaths: string | readonly string[]): number {
    return typeof pathOrPaths === "string"
      ? this.invalidatePath(pathOrPaths)
      : this.invalidatePaths(pathOrPaths);
  }

  invalidateAll(): void {
    this.#entries.clear();
    this.#inFlight.clear();
    this.#epoch += 1;
    this.#globalEpoch += 1;
  }

  #bumpKey(key: string): void {
    this.#keyEpochs.set(key, (this.#keyEpochs.get(key) ?? 0) + 1);
  }

  get epoch(): number {
    return this.#epoch;
  }

  get size(): number {
    return this.#entries.size;
  }
}
function renderCompoundDiff(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value ?? "");
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") return `[git diff failed: ${record.error}]`;
  if (!Array.isArray(record.files)) return JSON.stringify(value);
  return record.files.map((entry) => {
    if (typeof entry !== "object" || entry === null) return String(entry);
    const file = entry as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "<unknown>";
    const additions = typeof file.additions === "number" ? file.additions : 0;
    const deletions = typeof file.deletions === "number" ? file.deletions : 0;
    const patch = typeof file.patch === "string" ? file.patch : "";
    return `${path} +${additions} -${deletions}\n${patch}`;
  }).join("\n\n");
}
