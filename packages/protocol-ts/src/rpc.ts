/**
 * Runtime RPC contract — PRD §20.1–§20.5.
 *
 * Mirrors `crates/cbc-protocol`. `scripts/check-protocol-drift.ts` asserts the
 * two lists stay identical, satisfying §20.11's drift requirement without a code
 * generator in the build path.
 */

export const PROTOCOL_VERSION = "1.0" as const;

/** §20.4 limits. */
export const LIMITS = {
  maxFrameBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxStringBytes: 4 * 1024 * 1024,
  maxEventPayloadBytes: 1024 * 1024,
  maxOutstandingRequests: 128,
  lengthPrefixBytes: 4,
} as const;

/** §20.5 liveness thresholds. */
export const HEARTBEAT = {
  intervalMs: 5_000,
  degradedMs: 15_000,
  fatalMs: 30_000,
} as const;

/** Shared filesystem read default. Keep this aligned with `cbc-fs`. */
export const DEFAULT_READ_MAX_LINES = 400 as const;

export type ReadMode = "preview" | "exact";

export interface ReadRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly maxLines?: number;
  readonly mode?: ReadMode;
  readonly maxBytes?: number;
  readonly allowAbsolute?: boolean;
  readonly capabilityReceipt?: string;
  readonly capabilitySessionId?: string;
  readonly capabilityActionHash?: string;
}

export interface ReadExcerpt {
  readonly path?: string;
  readonly checksum?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines?: number;
  readonly endOfFile: boolean;
  readonly text: string;
  readonly partial?: boolean;
  readonly omittedBefore?: number;
  readonly omittedAfter?: number;
  readonly truncatedByBytes: boolean;
}

export interface ReadResponse {
  readonly path: string;
  readonly binary?: boolean;
  readonly bytes?: number;
  readonly text?: string | null;
  readonly mode: ReadMode;
  readonly revisionToken: string;
  readonly checksum?: string;
  readonly authoritativeForWrite: boolean;
  readonly excerpt: ReadExcerpt;
  readonly rendered?: string;
  readonly totalLines?: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly partial?: boolean;
  readonly omittedBefore?: number;
  readonly omittedAfter?: number;
  readonly traversedSymlink?: boolean;
  readonly selectedLines?: number;
  readonly truncatedByBytes?: boolean;
  readonly truncated?: boolean;
}

export interface ReadManyRequest {
  /** V2 request shape: each member owns its line range and mode. */
  readonly items?: readonly ReadRequest[];
  /** Legacy request shape retained for existing clients. */
  readonly paths?: readonly string[];
  readonly startLine?: number;
  readonly maxLines?: number;
  readonly mode?: ReadMode;
  readonly maxBytes?: number;
  readonly maxTotalLines?: number;
  readonly maxTotalBytes?: number;
  readonly concurrency?: number;
  readonly limit?: number;
  readonly allowAbsolute?: boolean;
  readonly capabilityReceipt?: string;
  readonly capabilitySessionId?: string;
  readonly capabilityActionHash?: string;
}

export interface ReadManyError {
  readonly path: string;
  readonly code: number;
  readonly message: string;
  readonly taxonomy?: string;
  readonly details?: Record<string, unknown>;
}

export interface ReadManyResponse {
  readonly files: ReadResponse[];
  readonly errors: ReadManyError[];
  readonly truncated: boolean;
  readonly requested: number;
  readonly limit: number;
  readonly totalLines?: number;
  readonly totalBytes?: number;
  readonly maxTotalLines?: number;
  readonly maxTotalBytes?: number;
  readonly concurrency?: number;
}

export interface FingerprintRequest {
  readonly path: string;
  readonly includeChecksum?: boolean;
  readonly allowAbsolute?: boolean;
  readonly capabilityReceipt?: string;
  readonly capabilitySessionId?: string;
  readonly capabilityActionHash?: string;
}

export interface FingerprintResponse {
  readonly path: string;
  readonly revisionToken: string;
  /** Alias retained for callers that use the fingerprint terminology. */
  readonly fingerprint: string;
  readonly bytes: number;
  readonly checksum?: string;
  readonly authoritativeForWrite: boolean;
}


/**
 * Structured edit requests carry the versioned edit-domain wire object without
 * making the protocol package depend on a specific client-side preflight
 * implementation. Rust parses and validates this shape independently.
 */
export interface EditPreviewRequest {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly allowAbsolute?: boolean;
}

export interface EditApplyRequest extends EditPreviewRequest {
  readonly transactionId: string;
  readonly capabilityReceipt: string;
  readonly capabilitySessionId: string;
  readonly capabilityActionHash: string;
}

export interface StructuredEditResolution {
  readonly operationId: string;
  readonly path: string;
  readonly byteRange: { readonly start: number; readonly end: number };
  readonly resolution: Readonly<Record<string, unknown>>;
}

export interface StructuredEditFile {
  readonly kind: "modify" | "create" | "delete" | "move";
  readonly path: string;
  readonly previousPath?: string;
  readonly revisionBefore?: string;
  readonly revisionAfter?: string;
  readonly operationIds: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

export interface StructuredEditPreviewLine {
  readonly path: string;
  readonly kind: "addition" | "deletion" | "context";
  readonly text: string;
}

export interface StructuredEditResponse {
  readonly status: "previewed" | "no_change";
  readonly planId: string;
  readonly planDigest: string;
  readonly resolvedOperations: readonly StructuredEditResolution[];
  readonly files: readonly StructuredEditFile[];
  readonly diffPreview: readonly StructuredEditPreviewLine[];
  readonly transactionId?: string;
  readonly stagedPaths?: readonly string[];
}


/** Live interaction mode enforced by the Rust runtime. */
export type InteractionMode = "build" | "plan";

/** Request payload for `workspace.mode.write`. */
export interface WorkspaceModeWriteRequest {
  readonly mode: InteractionMode;
}

/** Result returned after the runtime installs a live interaction mode. */
export interface WorkspaceModeWriteResponse {
  readonly mode: InteractionMode;
  readonly previousMode?: InteractionMode;
  readonly changed: boolean;
  readonly quiescent?: boolean;
}

/** §20.3 TypeScript → Rust requests. */
export const REQUEST_METHODS = [
  "runtime.initialize",
  "runtime.capabilities",
  "runtime.shutdown",
  "runtime.cancel",
  "runtime.capability.issue",
  "workspace.inspect",
  "workspace.mode.write",
  "workspace.trust.read",
  "workspace.trust.write",
  "workspace.trust.list",
  "workspace.trust.set",
  "workspace.trust.remove",
  "fs.list",
  "fs.glob",
  "fs.search",
  "fs.read",
  "fs.read_many",
  "fs.fingerprint",
  "fs.edit.preview",
  "fs.edit",
  "fs.transaction.begin",
  "fs.patch",
  "fs.write",
  "fs.move",
  "fs.delete",
  "fs.transaction.commit",
  "fs.transaction.rollback",
  "fs.transaction.rollback_to_checkpoint",
  "process.run",
  "process.start",
  "process.input",
  "process.stop",
  "process.status",
  "git.status",
  "git.diff",
  "git.log",
  "git.show",
  "git.checkpoint",
  "credential.store",
  "credential.lease",
  "credential.delete",
  "session.open",
  "session.append",
  "session.snapshot",
  "session.load",
  "session.list",
  "session.resolve",
  "session.set_status",
  "session.export",
  "session.fork",
  "session.delete",
  "memory.search",
  "memory.remember",
  "app.client.upsert",
  "app.subscription.create",
  "app.subscription.ack",
  "app.subscription.state",
  "artifact.create",
  "artifact.read",
  "artifact.delete",
  "update.verify",
] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];

/** §20.3 Rust → TypeScript notifications. */
export const NOTIFICATION_METHODS = [
  "runtime.heartbeat",
  "process.output",
  "process.exited",
  "process.limit_warning",
  "workspace.changed",
  "transaction.conflict",
  "journal.committed",
  "artifact.spilled",
  "sandbox.degraded",
  "runtime.warning",
  "runtime.fatal",
] as const;

export type NotificationMethod = (typeof NOTIFICATION_METHODS)[number];

/** §12.10 tool error taxonomy. */
export const TOOL_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "PATH_OUTSIDE_WORKSPACE",
  "PATH_CHANGED",
  "HASH_MISMATCH",
  "PERMISSION_DENIED",
  "APPROVAL_DENIED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "UNSUPPORTED_ENCODING",
  "OUTPUT_LIMIT",
  "TIMEOUT",
  "CANCELLED",
  "PROCESS_EXIT_NONZERO",
  "SANDBOX_UNAVAILABLE",
  "NETWORK_DENIED",
  "MCP_UNAVAILABLE",
  "TRANSACTION_CONFLICT",
  "PROTOCOL_INCOMPATIBLE",
  "LEASE_VIOLATION",
  "RESOURCE_LIMIT",
  "NOT_INITIALIZED",
  "TOO_MANY_REQUESTS",
  "INTERNAL",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  pathOutsideWorkspace: -32000,
  hashMismatch: -32001,
  pathChanged: -32002,
  notFound: -32003,
  alreadyExists: -32004,
  unsupportedEncoding: -32005,
  outputLimit: -32006,
  timeout: -32007,
  cancelled: -32008,
  processExitNonzero: -32009,
  sandboxUnavailable: -32010,
  networkDenied: -32011,
  transactionConflict: -32012,
  protocolIncompatible: -32013,
  leaseViolation: -32014,
  resourceLimit: -32015,
  notInitialized: -32016,
  tooManyRequests: -32017,
  invalidArgument: -32018,
  permissionDenied: -32019,
} as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: RequestMethod;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: { taxonomy?: ToolErrorCode } & Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: NotificationMethod | string;
  params: unknown;
}

export class RuntimeRpcError extends Error {
  readonly code: number;
  readonly taxonomy: ToolErrorCode;
  readonly data: Record<string, unknown> | undefined;

  constructor(body: JsonRpcErrorBody) {
    super(body.message);
    this.name = "RuntimeRpcError";
    this.code = body.code;
    this.taxonomy = body.data?.taxonomy ?? codeToTaxonomy(body.code);
    this.data = body.data;
  }

  get retryable(): boolean {
    // The runtime may refine a broad taxonomy: for example, a Git command
    // failure is INTERNAL at the transport layer but a missing revision is a
    // deterministic NOT_FOUND and must not be replayed three times.
    if (this.data?.retryable === false) return false;
    if (this.data?.retryable === true) return true;
    // §10.13: timeouts may be retried; validation and permission failures may
    // not, because the model must observe them and choose differently.
    return this.taxonomy === "TIMEOUT" || this.taxonomy === "INTERNAL";
  }
}

export function codeToTaxonomy(code: number): ToolErrorCode {
  const C = JSONRPC_ERROR_CODES;
  switch (code) {
    case C.pathOutsideWorkspace:
      return "PATH_OUTSIDE_WORKSPACE";
    case C.leaseViolation:
      return "LEASE_VIOLATION";
    case C.hashMismatch:
      return "HASH_MISMATCH";
    case C.pathChanged:
      return "PATH_CHANGED";
    case C.notFound:
      return "NOT_FOUND";
    case C.alreadyExists:
      return "ALREADY_EXISTS";
    case C.unsupportedEncoding:
      return "UNSUPPORTED_ENCODING";
    case C.outputLimit:
      return "OUTPUT_LIMIT";
    case C.timeout:
      return "TIMEOUT";
    case C.cancelled:
      return "CANCELLED";
    case C.processExitNonzero:
      return "PROCESS_EXIT_NONZERO";
    case C.sandboxUnavailable:
      return "SANDBOX_UNAVAILABLE";
    case C.networkDenied:
      return "NETWORK_DENIED";
    case C.transactionConflict:
      return "TRANSACTION_CONFLICT";
    case C.protocolIncompatible:
      return "PROTOCOL_INCOMPATIBLE";
    case C.resourceLimit:
      return "RESOURCE_LIMIT";
    case C.notInitialized:
      return "NOT_INITIALIZED";
    case C.tooManyRequests:
      return "TOO_MANY_REQUESTS";
    case C.permissionDenied:
      return "PERMISSION_DENIED";
    case C.invalidParams:
    case C.invalidArgument:
      return "INVALID_ARGUMENT";
    default:
      return "INTERNAL";
  }
}

/** Encode one length-prefixed frame (§20.1). */
export function encodeFrame(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  if (body.byteLength === 0) {
    throw new Error("zero-length frame is not valid");
  }
  if (body.byteLength > LIMITS.maxFrameBytes) {
    throw new Error(
      `frame of ${body.byteLength} bytes exceeds the ${LIMITS.maxFrameBytes} byte limit`,
    );
  }
  const frame = new Uint8Array(LIMITS.lengthPrefixBytes + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, LIMITS.lengthPrefixBytes);
  return frame;
}

/**
 * Incremental frame decoder. Handles a byte stream arriving in arbitrary chunk
 * boundaries, which is exactly what a piped stdio stream does.
 */
export class FrameDecoder {
  #buffer = new Uint8Array(0);
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });

  push(chunk: Uint8Array): void {
    if (this.#buffer.byteLength === 0) {
      this.#buffer = chunk.slice();
      return;
    }
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;
  }

  /** Drain every complete frame currently buffered. */
  *drain(): Generator<string> {
    for (;;) {
      if (this.#buffer.byteLength < LIMITS.lengthPrefixBytes) return;
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      );
      const declared = view.getUint32(0, false);
      if (declared === 0) {
        throw new Error("zero-length frame is not valid");
      }
      if (declared > LIMITS.maxFrameBytes) {
        throw new Error(
          `declared frame length ${declared} exceeds the ${LIMITS.maxFrameBytes} byte limit`,
        );
      }
      const total = LIMITS.lengthPrefixBytes + declared;
      if (this.#buffer.byteLength < total) return;
      const body = this.#buffer.subarray(LIMITS.lengthPrefixBytes, total);
      const payload = this.#decoder.decode(body);
      this.#buffer = this.#buffer.slice(total);
      yield payload;
    }
  }

  get pendingBytes(): number {
    return this.#buffer.byteLength;
  }
}

/** Measure JSON depth so oversized payloads are caught before sending. */
export function jsonDepth(value: unknown, depth = 1): number {
  if (depth > LIMITS.maxJsonDepth + 1) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, jsonDepth(item, depth + 1));
    return max;
  }
  if (typeof value === "object" && value !== null) {
    let max = depth;
    for (const item of Object.values(value)) max = Math.max(max, jsonDepth(item, depth + 1));
    return max;
  }
  return depth;
}

export function isKnownRequestMethod(method: string): method is RequestMethod {
  return (REQUEST_METHODS as readonly string[]).includes(method);
}

export function isKnownNotificationMethod(method: string): method is NotificationMethod {
  return (NOTIFICATION_METHODS as readonly string[]).includes(method);
}

/** Parsed protocol version with the §19.12 compatibility rule. */
export interface ParsedProtocolVersion {
  major: number;
  minor: number;
}

export function parseProtocolVersion(raw: string): ParsedProtocolVersion | undefined {
  const parts = raw.split(".");
  if (parts.length > 2) return undefined;
  const major = Number(parts[0]);
  const minor = parts.length > 1 ? Number(parts[1]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) {
    return undefined;
  }
  return { major, minor };
}

export function isProtocolCompatible(clientRaw: string, runtimeRaw: string): boolean {
  const client = parseProtocolVersion(clientRaw);
  const runtime = parseProtocolVersion(runtimeRaw);
  if (!client || !runtime) return false;
  return client.major === runtime.major;
}
