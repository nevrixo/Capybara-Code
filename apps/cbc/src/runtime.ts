/**
 * Runtime sidecar client — PRD §19.1, §19.2, §19.7, §20.1–§20.5.
 *
 * `RuntimeClient` in `@cbc/protocol` owns the framing and the handshake. This
 * module owns the two things that are genuinely host concerns: spawning the
 * process from a verified absolute path (§19.2), and giving the rest of the app a
 * typed surface instead of raw `request(method, params)` calls.
 *
 * The spawner is here rather than in `@cbc/protocol` because Bun's `stdin` pipe is
 * a `FileSink`, not a `WritableStream`. Adapting it is a runtime detail of the CLI,
 * and keeping it out of the protocol package leaves that package testable with a
 * plain fake.
 */

import {
  RuntimeClient,
  RuntimeRpcError,
  JSONRPC_ERROR_CODES,
  type CapabilityReceipt,
  type EditApplyRequest,
  type EditPreviewRequest,
  type InitializeResult,
  type RuntimeCapabilities,
  type RuntimeHealth,
  type RuntimeProcess,
  type RuntimeSpawner,
  type StructuredEditResponse,
} from "@cbc/protocol";
import type { CredentialLease } from "@cbc/provider-openai";

import { CliError, EXIT } from "./exit.ts";
import { findRuntimeBinary, type Host } from "./host.ts";

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** The subset of Bun's `FileSink` this module needs. */
interface ByteSink {
  write(chunk: Uint8Array): number;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
}

/**
 * Present a Bun `FileSink` as a `WritableStream`.
 *
 * Each frame is flushed as it is written. Buffering would be faster, but the
 * runtime cannot answer a request it has not received, and a stalled handshake is
 * far worse than a syscall per frame.
 */
function sinkToWritable(sink: ByteSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    async close() {
      await sink.end();
    },
    async abort() {
      await sink.end();
    },
  });
}

export interface SpawnerOptions {
  readonly workspace: string;
  readonly dataDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const RUNTIME_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

/**
 * Build the sidecar environment from a narrow non-secret allowlist. Provider
 * credentials are delivered over the authenticated protocol as short leases;
 * they must never be readable from /proc/<sidecar>/environ by a sandboxed child.
 */
export function runtimeSidecarEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !RUNTIME_ENV_ALLOWLIST.has(name.toUpperCase())) continue;
    result[name] = value;
  }
  return result;
}

/** Build a spawner that launches the sidecar from a verified absolute path. */
export function createRuntimeSpawner(options: SpawnerOptions): RuntimeSpawner {
  return (binary: string): RuntimeProcess => {
    const spawn = (globalThis as { Bun?: { spawn?: unknown } }).Bun?.spawn;
    if (typeof spawn !== "function") {
      throw new CliError(
        EXIT.internal,
        "no process spawner is available in this JavaScript runtime",
        ["`capy` must run under Bun, or the standalone executable must be used."],
      );
    }

    const child = Bun.spawn({
      cmd: [binary, "--workspace", options.workspace, "--data-dir", options.dataDir],
      cwd: options.workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: runtimeSidecarEnvironment(options.env ?? process.env),
    });

    return {
      stdin: sinkToWritable(child.stdin as unknown as ByteSink),
      stdout: child.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: child.stderr as unknown as ReadableStream<Uint8Array>,
      exited: child.exited,
      kill: (signal?: number | NodeJS.Signals) => {
        child.kill(signal);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Typed facade
// ---------------------------------------------------------------------------

export interface WorkspaceInspection {
  readonly workspaceId: string;
  readonly interactionMode: "build" | "plan";
  readonly canonicalPath: string;
  readonly fingerprint: string;
  readonly caseInsensitive: boolean;
  readonly isGitRepository: boolean;
  readonly gitRoot?: string;
  readonly trustState: string;
  readonly trustLabel: string;
  readonly sandbox: Record<string, unknown>;
  readonly dataDir: string;
}

export interface TrustReadResult {
  readonly canonicalPath: string;
  readonly filesystemId: string;
  readonly state: string;
  readonly label: string;
  readonly allowsProjectConfig: boolean;
  readonly allowsMutation: boolean;
}

export interface TrustListRecord {
  readonly canonicalPath: string;
  readonly filesystemId: string;
  readonly state: string;
  readonly decidedAt: string;
  readonly gitRoot?: string;
}

export interface TrustWriteResult {
  readonly canonicalPath: string;
  readonly filesystemId?: string;
  readonly state: string;
  readonly label: string;
  readonly persisted: boolean;
}

export type ReadMode = "preview" | "exact";

/** Typed read request used by new callers; string/path overloads remain supported. */
export interface ReadRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly maxLines?: number;
  readonly mode?: ReadMode;
  readonly maxBytes?: number;
  /** Persist opaque evidence only for an exact, complete, non-sensitive read. */
  readonly recordEvidence?: boolean;
  readonly allowAbsolute?: boolean;
}

export interface ReadExcerpt {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines?: number;
  readonly endOfFile: boolean;
  readonly text: string;
  readonly truncatedByBytes: boolean;
  /** Legacy sidecar fields retained for context-engine compatibility. */
  readonly path?: string;
  readonly checksum?: string;
  readonly partial?: boolean;
  readonly omittedBefore?: number;
  readonly omittedAfter?: number;
  readonly [key: string]: unknown;
}

/**
 * New metadata is additive. The legacy response fields are intentionally part of
 * this type because older sidecars do not return the v2 metadata yet.
 */
export interface ReadResponse {
  readonly path: string;
  readonly mode: ReadMode;
  readonly revisionToken: string;
  readonly checksum?: string;
  readonly evidenceId?: string;
  readonly authoritativeForWrite: boolean;
  readonly excerpt: ReadExcerpt;
  readonly binary?: boolean;
  readonly bytes?: number;
  readonly text?: string | null;
  readonly rendered?: string;
  readonly totalLines?: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly partial?: boolean;
  readonly omittedBefore?: number;
  readonly omittedAfter?: number;
  readonly [key: string]: unknown;
}

export interface ReadManyRequest {
  readonly items: readonly ReadRequest[];
  readonly maxTotalLines?: number;
  readonly maxTotalBytes?: number;
  readonly concurrency?: number;
  readonly allowAbsolute?: boolean;
}

export interface ReadManyError {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
  readonly [key: string]: unknown;
}

export interface ReadManyResponse {
  readonly files: ReadResponse[];
  readonly errors: ReadManyError[];
  readonly truncated?: boolean;
  readonly requested?: number;
  readonly limit?: number;
  readonly [key: string]: unknown;
}

export interface FingerprintRequest {
  readonly path: string;
  readonly allowAbsolute?: boolean;
}

export interface FingerprintResponse {
  readonly path: string;
  readonly revisionToken: string;
  readonly checksum?: string;
}

export type DurableMemoryScope = "workspace" | "session" | "task";
export type DurableMemoryStatus = "active" | "superseded" | "contested" | "forgotten";

export interface RuntimeMemoryRecord {
  readonly id: string;
  readonly workspaceIdentityDigest: string;
  readonly scope: DurableMemoryScope;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly worktreeId?: string;
  readonly key: string;
  readonly value: string;
  readonly status: DurableMemoryStatus;
  readonly confidence: number;
  readonly validFor: Record<string, unknown>;
  readonly evidenceIds: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly lastValidatedAt: string;
  readonly evidenceObservedAt: string;
  readonly exactEvidenceObservedAt?: string;
  readonly expiresAt?: string;
  readonly [key: string]: unknown;
}

export interface MemorySearchRequest {
  readonly key?: string;
  readonly query?: string;
  readonly statuses?: readonly RuntimeMemoryRecord["status"][];
  readonly scopes?: readonly DurableMemoryScope[];
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly worktreeId?: string;
  readonly path?: string;
  readonly limit?: number;
}

export interface MemorySearchResponse {
  readonly workspaceIdentityDigest: string;
  readonly freshEvidenceRequired: true;
  readonly limit: number;
  readonly memories: RuntimeMemoryRecord[];
}

export interface MemoryRememberProposal {
  readonly key: string;
  readonly value: string;
  readonly evidenceIds: readonly string[];
  readonly scope?: DurableMemoryScope;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly worktreeId?: string;
  readonly paths?: readonly string[];
  readonly confidence?: number;
  /** A concise factual label; never a raw transcript or chain of thought. */
  readonly reason?: string;
  readonly agentId?: string;
}

export interface MemoryRememberResponse {
  readonly workspaceIdentityDigest: string;
  readonly idempotent: boolean;
  readonly memory: RuntimeMemoryRecord;
}

export interface MemoryListResponse {
  readonly workspaceIdentityDigest: string;
  readonly memories: RuntimeMemoryRecord[];
}

export interface MemoryRecordResponse {
  readonly workspaceIdentityDigest: string;
  readonly memory: RuntimeMemoryRecord;
}

export interface MemoryForgetRequest {
  readonly id: string;
  readonly reason?: string;
}

export interface MemoryResolveContestRequest {
  readonly winnerId: string;
  readonly loserIds: readonly string[];
  readonly reason: string;
}

export interface MemoryVerifyResponse extends MemoryRecordResponse {
  readonly fresh: boolean;
}

type LegacyReadOptions = ReadRequest & Record<string, unknown>;

function isMethodNotFound(error: unknown): boolean {
  return error instanceof RuntimeRpcError && error.code === JSONRPC_ERROR_CODES.methodNotFound;
}

function isWorktreeListUnavailable(error: unknown): boolean {
  if (!(error instanceof RuntimeRpcError)) return false;
  if (isMethodNotFound(error)) return true;
  return error.taxonomy === "NOT_FOUND";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readMode(value: unknown, fallback: ReadMode): ReadMode {
  return value === "preview" || value === "exact" ? value : fallback;
}

function normalizeReadResponse(raw: unknown, request: ReadRequest): ReadResponse {
  const source = objectRecord(raw);
  const path = stringValue(source.path) ?? request.path;
  const checksum = stringValue(source.checksum);
  const evidenceId = stringValue(source.evidenceId);
  const revisionToken = stringValue(source.revisionToken) ?? checksum ?? "";
  const mode = readMode(source.mode, request.mode ?? "exact");
  const sourceExcerpt = objectRecord(source.excerpt);
  const startLine = numberValue(sourceExcerpt.startLine) ?? numberValue(source.startLine) ?? request.startLine ?? 1;
  const endLine = numberValue(sourceExcerpt.endLine) ?? numberValue(source.endLine) ?? startLine - 1;
  const totalLines = numberValue(sourceExcerpt.totalLines) ?? numberValue(source.totalLines);
  const text = stringValue(sourceExcerpt.text) ?? stringValue(source.text) ?? "";
  const legacyStartLine = numberValue(source.startLine);
  const legacyEndLine = numberValue(source.endLine);
  const legacyOmittedBefore = numberValue(source.omittedBefore);
  const omittedAfter = numberValue(sourceExcerpt.omittedAfter) ?? numberValue(source.omittedAfter);
  const endOfFile = typeof sourceExcerpt.endOfFile === "boolean"
    ? sourceExcerpt.endOfFile
    : omittedAfter === undefined || omittedAfter === 0;
  const truncatedByBytes = sourceExcerpt.truncatedByBytes === true || source.truncatedByBytes === true;
  const excerpt: ReadExcerpt = {
    ...sourceExcerpt,
    startLine,
    endLine,
    ...(totalLines !== undefined ? { totalLines } : {}),
    endOfFile,
    text,
    truncatedByBytes,
  };
  return {
    ...source,
    path,
    mode,
    revisionToken,
    ...(checksum !== undefined ? { checksum } : {}),
    ...(evidenceId !== undefined ? { evidenceId } : {}),
    authoritativeForWrite:
      typeof source.authoritativeForWrite === "boolean"
        ? source.authoritativeForWrite
        : mode === "exact" && checksum !== undefined,
    excerpt,
    ...(typeof source.binary === "boolean" ? { binary: source.binary } : {}),
    ...(typeof source.bytes === "number" ? { bytes: source.bytes } : {}),
    ...(typeof source.text === "string" || source.text === null ? { text: source.text } : {}),
    ...(typeof source.rendered === "string" ? { rendered: source.rendered } : {}),
    ...(totalLines !== undefined ? { totalLines } : {}),
    ...(legacyStartLine !== undefined ? { startLine: legacyStartLine } : {}),
    ...(legacyEndLine !== undefined ? { endLine: legacyEndLine } : {}),
    ...(typeof source.partial === "boolean" ? { partial: source.partial } : {}),
    ...(legacyOmittedBefore !== undefined ? { omittedBefore: legacyOmittedBefore } : {}),
    ...(omittedAfter !== undefined ? { omittedAfter } : {}),
  };
}

function normalizeReadManyResponse(
  raw: unknown,
  requestItems: readonly ReadRequest[],
): ReadManyResponse {
  const source = objectRecord(raw);
  const rawFiles = Array.isArray(source.files) ? source.files : [];
  const files = rawFiles.map((file) => {
    const record = objectRecord(file);
    const path = stringValue(record.path);
    const matching = path === undefined
      ? undefined
      : requestItems.find((item) => item.path === path);
    return normalizeReadResponse(record, matching ?? { path: path ?? "" });
  });
  const errors: ReadManyError[] = (Array.isArray(source.errors) ? source.errors : [])
    .filter((error): error is Record<string, unknown> => typeof error === "object" && error !== null && !Array.isArray(error))
    .map((error) => {
      const code = stringValue(error.code);
      return {
        ...error,
        path: stringValue(error.path) ?? "",
        message: stringValue(error.message) ?? "read failed",
        ...(code !== undefined ? { code } : {}),
      };
    });
  return {
    ...source,
    files,
    errors,
    ...(typeof source.truncated === "boolean" ? { truncated: source.truncated } : {}),
    ...(typeof source.requested === "number" ? { requested: source.requested } : {}),
    ...(typeof source.limit === "number" ? { limit: source.limit } : {}),
  };
}

/** One durable session row as the runtime reports it (§18.7, P0-05). */
export interface RuntimeSessionSummary {
  readonly schemaVersion: string;
  readonly id: string;
  readonly workspacePath: string;
  readonly workspaceFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly modelProfile: string;
  readonly permissionMode: string;
  readonly parentSessionId?: string;
  readonly lastEventSequence: number;
  readonly state: "active" | "completed" | "interrupted" | "archived";
  readonly turnCount: number;
}

export interface RuntimeSessionResolveResult {
  readonly session?: RuntimeSessionSummary;
  readonly candidates: RuntimeSessionSummary[];
}
export const EXECUTABLE_CAPABILITY_PROGRAMS = [
  "go", "cargo", "npm", "pnpm", "bun", "rg", "grep", "sed", "cat",
] as const;

export type ExecutableCapabilityProgram = typeof EXECUTABLE_CAPABILITY_PROGRAMS[number];
export type ExecutableCapabilities = Readonly<Partial<Record<ExecutableCapabilityProgram, boolean>>>;

export interface ProcessOutcome {
  readonly jobId: string;
  readonly state: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly durationMs: number;
  readonly display: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly warnings: string[];
  readonly taxonomy?: string | null;
  /** Bounded runtime token captured immediately before foreground execution. */
  readonly workspaceRevisionBefore?: string | null;
  /** Bounded runtime token captured after foreground execution settles. */
  readonly workspaceRevisionAfter?: string | null;
  /**
   * False only when the runtime could prove the workspace content was unchanged.
   * Null/undefined means the scan was unavailable or intentionally bounded.
   */
  readonly workspaceChangeObserved?: boolean | null;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly indexStatus?: unknown;
  readonly worktreeStatus?: unknown;
  readonly originalPath?: string;
}

export interface GitStatusResult {
  readonly status: {
    readonly isRepository?: boolean;
    readonly branch?: string;
    readonly head?: string;
    readonly ahead?: number;
    readonly behind?: number;
    readonly staged?: number;
    readonly unstaged?: number;
    readonly untracked?: number;
    readonly additions?: number;
    readonly deletions?: number;
    readonly dirty?: boolean;
    readonly entries?: readonly GitStatusEntry[];
  };
  readonly statusBar: string;
}

export interface RuntimeOptions {
  readonly host: Host;
  readonly workspace: string;
  readonly dataDir: string;
  readonly clientVersion: string;
  readonly pty?: boolean;
  /** Requested sandbox level (`sandbox.level`); the runtime clamps it. */
  readonly sandboxLevel?: "none" | "workspace" | "standard" | "strict";
  readonly networkForShell?: "deny" | "ask" | "allow";
  readonly interactionMode?: "build" | "plan";
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly onHealthChange?: (health: RuntimeHealth, detail?: string) => void;
  readonly onStderr?: (line: string) => void;
  /** Injected in tests so the whole CLI can run without a real sidecar. */
  readonly spawner?: RuntimeSpawner;
}

/** Identity fields every capability-protected runtime RPC must carry together. */
export interface RuntimeCapabilityBinding {
  readonly capabilityReceipt: string;
  readonly capabilitySessionId: string;
  readonly capabilityActionHash: string;
}

export interface WorktreeCreateRequest extends RuntimeCapabilityBinding {
  readonly path: string;
  readonly commit: string;
  readonly requireClean?: boolean;
  readonly allowLongPath?: boolean;
}

export interface WorktreeRemoveRequest extends RuntimeCapabilityBinding {
  readonly path: string;
  readonly hasActiveWriter?: boolean;
}

/**
 * The sidecar, as the rest of the CLI sees it.
 *
 * Errors are translated into `CliError` with §8.9 codes at this boundary. A
 * `PERMISSION_DENIED` from the runtime and a policy denial in TypeScript should exit
 * the same way, and that is only true if the mapping happens once.
 */
export class Runtime {
  readonly #client: RuntimeClient;
  readonly #options: RuntimeOptions;
  #binary: string | undefined;
  #initialized: InitializeResult | undefined;
  readonly #notificationListeners = new Set<(method: string, params: unknown) => void>();

  private constructor(client: RuntimeClient, options: RuntimeOptions) {
    this.#client = client;
    this.#options = options;
  }

  /**
   * Locate the binary and complete the handshake.
   *
   * §19.7 requires the runtime version and protocol to be verified at startup.
   * `RuntimeClient.start` performs the protocol check; the binary check happens
   * first so a missing sidecar produces a message about installation rather than a
   * spawn stack trace.
   */
  static async start(options: RuntimeOptions): Promise<Runtime> {
    const located = await findRuntimeBinary(options.host);
    if ("missing" in located) {
      throw new CliError(EXIT.internal, "the cbc-runtime sidecar could not be found", [
        "Looked in:",
        ...located.missing.map((path) => `  ${path}`),
        "",
        "In a development checkout, build it with `cargo build -p cbc-runtime`.",
        "On WSL, build with Linux rustc so the sidecar is `cbc-runtime`, not `cbc-runtime.exe`.",
        "In a release install, reinstall the archive so bin/ and libexec/ stay together.",
      ]);
    }

    const spawner =
      options.spawner ??
      createRuntimeSpawner({
        workspace: options.workspace,
        dataDir: options.dataDir,
      });

    let runtime: Runtime | undefined;
    const client = new RuntimeClient(
      {
        runtimeBinary: located.path,
        workspace: options.workspace,
        clientVersion: options.clientVersion,
        dataDir: options.dataDir,
        pty: options.pty ?? true,
        ...(options.sandboxLevel !== undefined ? { sandboxLevel: options.sandboxLevel } : {}),
        ...(options.networkForShell !== undefined
          ? { networkForShell: options.networkForShell }
          : {}),
        ...(options.interactionMode !== undefined ? { interactionMode: options.interactionMode } : {}),
        onNotification: (method: string, params: unknown) => {
          options.onNotification?.(method, params);
          if (runtime !== undefined) {
            for (const listener of runtime.#notificationListeners) listener(method, params);
          }
        },
        ...(options.onHealthChange !== undefined ? { onHealthChange: options.onHealthChange } : {}),
        ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
      },
      spawner,
    );

    runtime = new Runtime(client, options);
    runtime.#binary = located.path;

    try {
      runtime.#initialized = await client.start();
    } catch (error) {
      throw new CliError(
        EXIT.internal,
        error instanceof Error ? error.message : String(error),
        ["The runtime sidecar did not complete the protocol handshake."],
      );
    }
    return runtime;
  }

  get binaryPath(): string | undefined {
    return this.#binary;
  }

  get capabilities(): RuntimeCapabilities | undefined {
    return this.#client.capabilities;
  }

  /** Runner-observed executable availability, with no PATH values or locations. */
  async executableCapabilities(): Promise<ExecutableCapabilities | undefined> {
    const response = objectRecord(await this.#client.request("runtime.capabilities", {}));
    const values = objectRecord(response.executables);
    const snapshot: Partial<Record<ExecutableCapabilityProgram, boolean>> = {};
    for (const program of EXECUTABLE_CAPABILITY_PROGRAMS) {
      const available = values[program];
      if (typeof available === "boolean") snapshot[program] = available;
    }
    return Object.keys(snapshot).length === 0 ? undefined : Object.freeze(snapshot);
  }

  get runtimeVersion(): string | undefined {
    return this.#client.runtimeVersion;
  }

  get protocolVersion(): string | undefined {
    return this.#initialized?.protocolVersion;
  }

  get workspaceId(): string | undefined {
    return this.#client.workspaceId;
  }

  get health(): RuntimeHealth {
    return this.#client.health;
  }

  get workspace(): string {
    return this.#options.workspace;
  }

  /** Runtime-owned root used for managed worktrees and other sidecar state. */
  get dataDir(): string {
    return this.#options.dataDir;
  }

  async issueCapability(params: {
    readonly sessionId: string;
    readonly callId: string;
    readonly actionHash: string;
    readonly operation: string;
    readonly resources?: readonly string[];
    readonly program?: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly network?: "deny" | "ask" | "allow";
    readonly ttlMs?: number;
  }): Promise<CapabilityReceipt> {
    return await this.#client.issueCapability(params);
  }

  subscribeNotifications(handler: (method: string, params: unknown) => void): () => void {
    this.#notificationListeners.add(handler);
    return () => this.#notificationListeners.delete(handler);
  }

  async stop(): Promise<void> {
    this.#notificationListeners.clear();
    await this.#client.stop();
  }

  /**
   * Start a second sidecar rooted at an isolated worktree. The child process
   * has its own workspace, data dir, and write admission; it does not share
   * the parent's FileTransaction lock.
   */
  async forkSidecar(workspace: string, dataDir: string): Promise<Runtime> {
    return await Runtime.start({
      host: this.#options.host,
      workspace,
      dataDir,
      clientVersion: this.#options.clientVersion,
      pty: this.#options.pty ?? true,
      ...(this.#options.sandboxLevel !== undefined ? { sandboxLevel: this.#options.sandboxLevel } : {}),
      ...(this.#options.networkForShell !== undefined ? { networkForShell: this.#options.networkForShell } : {}),
      ...(this.#options.interactionMode !== undefined ? { interactionMode: this.#options.interactionMode } : {}),
      ...(this.#options.spawner !== undefined ? { spawner: this.#options.spawner } : {}),
      ...(this.#options.onHealthChange !== undefined ? { onHealthChange: this.#options.onHealthChange } : {}),
      ...(this.#options.onStderr !== undefined ? { onStderr: this.#options.onStderr } : {}),
    });
  }

  // ---- workspace ----

  async inspect(): Promise<WorkspaceInspection> {
    return (await this.#client.request("workspace.inspect", {})) as WorkspaceInspection;
  }

  /** Synchronize the live interaction mode with the Rust enforcement boundary. */
  async setInteractionMode(mode: "build" | "plan"): Promise<{
    readonly mode: "build" | "plan";
    readonly previousMode?: "build" | "plan";
    readonly changed: boolean;
    readonly quiescent: boolean;
    readonly blockers?: Record<string, unknown>;
  }> {
    return (await this.#client.request("workspace.mode.write", { mode })) as {
      mode: "build" | "plan";
      previousMode?: "build" | "plan";
      changed: boolean;
      quiescent: boolean;
      blockers?: Record<string, unknown>;
    };
  }

  async readTrust(): Promise<TrustReadResult> {
    return (await this.#client.request("workspace.trust.read", {})) as TrustReadResult;
  }

  async writeTrust(state: string): Promise<{ state: string; persisted: boolean }> {
    return (await this.#client.request("workspace.trust.write", { state })) as {
      state: string;
      persisted: boolean;
    };
  }

  /** Every persisted trust decision, as the runtime sees them (§13.6, P0-01). */
  async listTrust(): Promise<{ records: TrustListRecord[] }> {
    return (await this.#client.request("workspace.trust.list", {})) as {
      records: TrustListRecord[];
    };
  }

  /**
   * Set (or revoke) trust for an explicit path. The runtime canonicalizes the path
   * and records filesystem identity, so the CLI never writes the store itself.
   */
  async setTrustFor(path: string, state: string): Promise<TrustWriteResult> {
    return (await this.#client.request("workspace.trust.set", { path, state })) as TrustWriteResult;
  }

  async removeTrustFor(path: string): Promise<{ canonicalPath: string; removed: boolean }> {
    return (await this.#client.request("workspace.trust.remove", { path })) as {
      canonicalPath: string;
      removed: boolean;
    };
  }

  /**
   * Idempotent reads may be retried when the sidecar reports a transient internal
   * failure or request timeout. Mutations intentionally do not use this path: a
   * timed-out write must never be replayed without an idempotency key.
   */
  async #stableRead(
     method: "fs.list" | "fs.glob" | "fs.search" | "fs.read" | "fs.read_many" | "fs.fingerprint" | "git.status" | "git.diff" | "git.log" | "git.show" | "memory.search" | "memory.list" | "memory.get" | "memory.verify",
    params: Record<string, unknown>,
  ): Promise<unknown> {
    let delayMs = 25;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#client.request(method, params);
      } catch (error) {
        const retryable =
          (error instanceof RuntimeRpcError && error.retryable && !isMethodNotFound(error)) ||
          (error instanceof Error && /timed out|temporarily unavailable|broken pipe/i.test(error.message));
        if (!retryable || attempt === 2 || this.#client.health === "fatal") throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }
    throw new Error(`runtime read '${method}' exhausted retries`);
  }
  // ---- filesystem reads ----

  async list(path: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return await this.#stableRead("fs.list", { path, ...options });
  }

  async glob(pattern: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return await this.#stableRead("fs.glob", { pattern, ...options });
  }

  async search(query: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return await this.#stableRead("fs.search", { query, ...options });
  }

  async read(request: ReadRequest): Promise<ReadResponse>;
  async read(path: string, options?: LegacyReadOptions | Record<string, unknown>): Promise<ReadResponse>;
  async read(
    requestOrPath: ReadRequest | string,
    options: Record<string, unknown> = {},
  ): Promise<ReadResponse> {
    const request: ReadRequest = typeof requestOrPath === "string"
      ? { path: requestOrPath, ...options } as ReadRequest
      : requestOrPath;
    const raw = await this.#stableRead("fs.read", { ...request });
    return normalizeReadResponse(raw, request);
  }

  async readMany(request: ReadManyRequest): Promise<ReadManyResponse>;
  async readMany(paths: readonly string[], options?: Record<string, unknown>): Promise<ReadManyResponse>;
  async readMany(
    requestOrPaths: ReadManyRequest | readonly string[],
    options: Record<string, unknown> = {},
  ): Promise<ReadManyResponse> {
    if (Array.isArray(requestOrPaths)) {
      const paths = [...requestOrPaths];
      const raw = await this.#stableRead("fs.read_many", { paths, ...options });
      return normalizeReadManyResponse(raw, paths.map((path) => ({ path })));
    }

    const request = requestOrPaths as ReadManyRequest;
    const items = request.items.map((item) => ({ ...item }));
    // Include legacy paths as a compatibility hint for sidecars that predate
    // per-item ranges. New sidecars use `items`; old ones ignore the extra key.
    const raw = await this.#stableRead("fs.read_many", {
      ...request,
      items,
      paths: items.map((item) => item.path),
    });
    return normalizeReadManyResponse(raw, items);
  }

  /**
   * Return a cheap revision token when the sidecar exposes one, while keeping a
   * checksum-bearing fs.read fallback for legacy runtimes.
   */
  async fingerprint(request: FingerprintRequest): Promise<FingerprintResponse>;
  async fingerprint(path: string, options?: Record<string, unknown>): Promise<FingerprintResponse>;
  async fingerprint(
    requestOrPath: FingerprintRequest | string,
    options: Record<string, unknown> = {},
  ): Promise<FingerprintResponse> {
    const path = typeof requestOrPath === "string" ? requestOrPath : requestOrPath.path;
    const request = {
      path,
      ...options,
      ...(typeof requestOrPath === "string" ? {} : requestOrPath),
    };
    const legacyFingerprint = async (): Promise<FingerprintResponse> => {
      const response = await this.read(path, {
        ...options,
        ...(typeof requestOrPath === "string" ? {} : requestOrPath),
        mode: "preview",
        maxLines: 1,
      });
      return {
        path: response.path,
        revisionToken: response.revisionToken,
        ...(response.checksum !== undefined ? { checksum: response.checksum } : {}),
      };
    };
    try {
      const raw = objectRecord(await this.#stableRead("fs.fingerprint", request));
      const revisionToken = stringValue(raw.revisionToken) ?? stringValue(raw.fingerprint);
      // Some older sidecars answer an unknown method with a generic result rather
      // than JSON-RPC -32601. Treat a tokenless result the same as method-not-found.
      if (revisionToken === undefined) return await legacyFingerprint();
      const checksum = stringValue(raw.checksum);
      return {
        path: stringValue(raw.path) ?? path,
        revisionToken,
        ...(checksum === undefined ? {} : { checksum }),
      };
    } catch (error) {
      // Older sidecars do not know fs.fingerprint. Only that compatibility case
      // falls back to a metadata-only preview; a real NOT_FOUND or permission
      // failure must remain visible to the caller.
      if (!(error instanceof RuntimeRpcError) || error.code !== JSONRPC_ERROR_CODES.methodNotFound) {
        throw error;
      }
      return await legacyFingerprint();
    }
  }

  async fingerprintToken(
    requestOrPath: FingerprintRequest | string,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const response = typeof requestOrPath === "string"
      ? await this.fingerprint(requestOrPath, options)
      : await this.fingerprint(requestOrPath);
    return response.revisionToken;
  }

  // ---- durable memory ----

  /** Recall only fresh memory records bound to the initialized workspace. */
  async searchMemory(request: MemorySearchRequest = {}): Promise<MemorySearchResponse> {
    try {
      return await this.#stableRead("memory.search", { ...request }) as MemorySearchResponse;
    } catch (error) {
      if (!isMethodNotFound(error)) throw error;
      return {
        workspaceIdentityDigest: this.workspaceId ?? "",
        freshEvidenceRequired: true,
        limit: request.limit ?? 32,
        memories: [],
      };
    }
  }

  /**
   * Submit a bounded claim proposal. The runtime—not this facade—binds the
   * workspace, derives timestamps from evidence, and makes retries idempotent.
   */
  async rememberMemory(proposal: MemoryRememberProposal): Promise<MemoryRememberResponse> {
    return await this.#client.request("memory.remember", { ...proposal }) as MemoryRememberResponse;
  }

  /** Inspect active and contested memory; pass statuses to include forgotten rows. */
  async listMemory(request: MemorySearchRequest = {}): Promise<MemoryListResponse> {
    try {
      return await this.#stableRead("memory.list", { ...request }) as MemoryListResponse;
    } catch (error) {
      if (!isMethodNotFound(error)) throw error;
      return { workspaceIdentityDigest: this.workspaceId ?? "", memories: [] };
    }
  }

  async getMemory(id: string): Promise<MemoryRecordResponse> {
    return await this.#stableRead("memory.get", { id }) as MemoryRecordResponse;
  }

  async forgetMemory(request: MemoryForgetRequest): Promise<MemoryRecordResponse> {
    return await this.#client.request("memory.forget", { ...request }) as MemoryRecordResponse;
  }

  async resolveMemoryContest(request: MemoryResolveContestRequest): Promise<MemoryRecordResponse> {
    return await this.#client.request("memory.resolve_contest", {
      ...request,
      loserIds: [...request.loserIds],
    }) as MemoryRecordResponse;
  }

  async verifyMemory(id: string): Promise<MemoryVerifyResponse> {
    return await this.#stableRead("memory.verify", { id }) as MemoryVerifyResponse;
  }

  /** Preflight a structured edit plan without opening a write transaction. */
  async previewEdit(params: EditPreviewRequest): Promise<StructuredEditResponse> {
    return (await this.#client.request("fs.edit.preview", params)) as StructuredEditResponse;
  }

  // ---- transactions ----

  async beginTransaction(options: RuntimeCapabilityBinding & {
    turnId?: string;
    agentId?: string;
    leasePathGlobs?: readonly string[];
    /** §11.2: the approach this transaction belongs to, for checkpoint rollback. */
    checkpointId?: string;
  }): Promise<{ transactionId: string }> {
    return (await this.#client.request("fs.transaction.begin", { ...options })) as {
      transactionId: string;
    };
  }

  async patch(params: Record<string, unknown> & RuntimeCapabilityBinding): Promise<unknown> {
    return await this.#client.request("fs.patch", params);
  }

  /** Re-preflight and atomically stage a structured edit in an open transaction. */
  async applyEdit(params: EditApplyRequest): Promise<StructuredEditResponse> {
    return (await this.#client.request("fs.edit", params)) as StructuredEditResponse;
  }

  async write(params: Record<string, unknown> & RuntimeCapabilityBinding): Promise<unknown> {
    return await this.#client.request("fs.write", params);
  }

  async move(params: Record<string, unknown> & RuntimeCapabilityBinding): Promise<unknown> {
    return await this.#client.request("fs.move", params);
  }

  async delete(params: Record<string, unknown> & RuntimeCapabilityBinding): Promise<unknown> {
    return await this.#client.request("fs.delete", params);
  }

  async commitTransaction(transactionId: string, capability: RuntimeCapabilityBinding): Promise<unknown> {
    return await this.#client.request("fs.transaction.commit", { transactionId, ...capability });
  }

  async rollbackTransaction(transactionId: string, capability: RuntimeCapabilityBinding): Promise<unknown> {
    return await this.#client.request("fs.transaction.rollback", { transactionId, ...capability });
  }

  /**
   * Undo every transaction tagged with one checkpoint (§11.2).
   *
   * `skippedPaths` is the part callers must not ignore: those files still hold the
   * abandoned change because the user edited them after the agent did, and the
   * runtime refuses to overwrite that (§24.1 invariant 9).
   */
  async rollbackToCheckpoint(checkpointId: string): Promise<{
    checkpointId: string;
    transactionsRolledBack: string[];
    revertedPaths: string[];
    skippedPaths: Array<{ path: string; status: string; detail?: string }>;
    discardedStagedOperations: number;
  }> {
    return (await this.#client.request("fs.transaction.rollback_to_checkpoint", {
      checkpointId,
    })) as {
      checkpointId: string;
      transactionsRolledBack: string[];
      revertedPaths: string[];
      skippedPaths: Array<{ path: string; status: string; detail?: string }>;
      discardedStagedOperations: number;
    };
  }

  // ---- processes ----

  async run(
    params: Record<string, unknown> & RuntimeCapabilityBinding,
    signal?: AbortSignal,
  ): Promise<ProcessOutcome> {
    return (await this.#client.request(
      "process.run",
      params,
      signal !== undefined ? { signal } : {},
    )) as ProcessOutcome;
  }

  async startJob(
    params: Record<string, unknown> & RuntimeCapabilityBinding,
  ): Promise<{ jobId: string; display: string }> {
    return (await this.#client.request("process.start", params)) as {
      jobId: string;
      display: string;
    };
  }

  async sendInput(params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    return await this.#client.request("process.input", {
      ...params,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  async stopJob(jobId: string, graceMs?: number, sessionId?: string, operatorCancellation = false): Promise<unknown> {
    return await this.#client.request("process.stop", {
      jobId,
      ...(graceMs !== undefined ? { graceMs } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(operatorCancellation ? { operatorCancellation: true } : {}),
    });
  }

  async jobStatus(jobId?: string, sessionId?: string): Promise<unknown> {
    return await this.#client.request(
      "process.status",
      {
        ...(jobId !== undefined ? { jobId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    );
  }

  // ---- git ----

  async gitStatus(): Promise<GitStatusResult> {
    return (await this.#stableRead("git.status", {})) as GitStatusResult;
  }

  async gitDiff(params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.#stableRead("git.diff", params);
  }

  async gitLog(params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.#stableRead("git.log", params);
  }

  async gitShow(params: Record<string, unknown>): Promise<unknown> {
    return await this.#stableRead("git.show", params);
  }

  async gitCheckpoint(label?: string): Promise<unknown> {
    return await this.#client.request(
      "git.checkpoint",
      label !== undefined ? { label } : {},
    );
  }

  /** List Git worktrees. Unknown-method and non-repo sidecars return an empty list. */
  async listWorktrees(): Promise<{ worktrees: unknown[] }> {
    try {
      const raw = objectRecord(await this.#client.request("worktree.list", {}));
      return { worktrees: Array.isArray(raw.worktrees) ? raw.worktrees : [] };
    } catch (error) {
      if (isWorktreeListUnavailable(error)) return { worktrees: [] };
      throw error;
    }
  }

  async inspectWorktree(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("worktree.inspect", params);
  }

  async createWorktree(params: WorktreeCreateRequest): Promise<unknown> {
    return await this.#client.request("worktree.create", params);
  }

  async removeWorktree(params: WorktreeRemoveRequest): Promise<unknown> {
    return await this.#client.request("worktree.remove", params);
  }

  async previewMerge(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("merge.preview", params);
  }

  // ---- credentials (§9.1) ----

  async storeCredential(
    account: string,
    secret: string,
  ): Promise<{ account: string; backend: string; persistent: boolean; fingerprint: string }> {
    return (await this.#client.request("credential.store", { account, secret })) as {
      account: string;
      backend: string;
      persistent: boolean;
      fingerprint: string;
    };
  }

  /**
   * Take a short-lived lease on a stored credential.
   *
   * §9.1: the secret travels once, in this response, and lives only in this
   * process's memory for the duration of the request that needs it.
   */
  async leaseCredential(account: string, source = "keychain"): Promise<CredentialLease> {
    const raw = (await this.#client.request("credential.lease", { account, source })) as {
      lease: { leaseId: string; account: string; source: string; expiresAtMs: number; fingerprint: string };
      secret: string;
    };
    return { ...raw.lease, secret: raw.secret };
  }

  async deleteCredential(account: string): Promise<{ removed: boolean }> {
    return (await this.#client.request("credential.delete", { account })) as { removed: boolean };
  }

  // ---- sessions ----

  async openSession(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("session.open", params);
  }

  async appendEvents(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("session.append", params);
  }

  async snapshotSession(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("session.snapshot", params);
  }

  async loadSession(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("session.load", params);
  }

  /** Sessions for the initialized workspace, newest first (§18.6, P0-05). */
  async resolveSession(params: { selector: string }): Promise<RuntimeSessionResolveResult> {
    return (await this.#client.request("session.resolve", params)) as RuntimeSessionResolveResult;
  }

  async listSessions(params: { limit?: number; all?: boolean } = {}): Promise<{
    sessions: RuntimeSessionSummary[];
  }> {
    return (await this.#client.request("session.list", params)) as {
      sessions: RuntimeSessionSummary[];
    };
  }

  async setSessionStatus(sessionId: string, status: string): Promise<unknown> {
    return await this.#client.request("session.set_status", { sessionId, status });
  }

  /** The durable journal rendered as §20.10 JSONL (§18.19, P0-05). */
  async exportSession(sessionId: string): Promise<{
    sessionId: string;
    manifest: RuntimeSessionSummary;
    eventCount: number;
    jsonl: string;
  }> {
    return (await this.#client.request("session.export", { sessionId })) as {
      sessionId: string;
      manifest: RuntimeSessionSummary;
      eventCount: number;
      jsonl: string;
    };
  }

  async forkSession(params: {
    sessionId: string;
    newSessionId: string;
    title?: string;
  }): Promise<{ sessionId: string; forkedFrom: string }> {
    return (await this.#client.request("session.fork", params)) as {
      sessionId: string;
      forkedFrom: string;
    };
  }

  async deleteSession(sessionId: string): Promise<{ sessionId: string; deleted: boolean }> {
    return (await this.#client.request("session.delete", { sessionId })) as {
      sessionId: string;
      deleted: boolean;
    };
  }

  // ---- artifacts ----

  async createArtifact(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("artifact.create", params);
  }

  async readArtifact(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("artifact.read", params);
  }

  async verifyUpdate(params: Record<string, unknown>): Promise<unknown> {
    return await this.#client.request("update.verify", params);
  }
}
