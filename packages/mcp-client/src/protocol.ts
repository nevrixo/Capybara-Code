/**
 * MCP protocol layer — PRD §17.2, §17.4, AC-30, AC-31.
 *
 * §17.2 targets two revisions: the current `2026-07-28` and the legacy
 * `2025-11-25`, with dual-era negotiation between them. An unknown *newer*
 * revision fails closed unless compatibility metadata says otherwise — the same
 * principle §19.12 applies to the runtime RPC, and the reason is identical: a
 * revision we cannot reason about might have moved a security-relevant default.
 *
 * §17.2 also notes that the modern core is stateless and uses request-level
 * metadata, so CBC never treats a connection as conversation identity. That is
 * what lets a server be restarted mid-session (§17.3 bounded backoff) without
 * losing the agent's place.
 */

import { createHash } from "node:crypto";

/** The revision §17.2 names as current. */
export const MCP_REVISION_CURRENT = "2026-07-28" as const;

/** The revision §17.2 names as legacy but supported. */
export const MCP_REVISION_LEGACY = "2025-11-25" as const;

export const SUPPORTED_REVISIONS: readonly string[] = [
  MCP_REVISION_CURRENT,
  MCP_REVISION_LEGACY,
];

/**
 * Which semantics apply. `modern` is stateless with request-level metadata;
 * `legacy` carries session identity on the connection, which is why the client
 * has to know which one it is talking to rather than guessing per call.
 */
export type McpEra = "modern" | "legacy";

export function eraFor(revision: string): McpEra | undefined {
  if (revision === MCP_REVISION_CURRENT) return "modern";
  if (revision === MCP_REVISION_LEGACY) return "legacy";
  return undefined;
}

/** Header name carrying the negotiated revision on Streamable HTTP (§17.3). */
export const MCP_PROTOCOL_HEADER = "mcp-protocol-version";

export interface NegotiationOptions {
  /**
   * Revisions the operator explicitly vouched for beyond `SUPPORTED_REVISIONS`.
   * §17.2's escape hatch: a newer revision is usable only with compatible
   * metadata, and this is where that metadata arrives.
   */
  readonly compatibleRevisions?: readonly string[];
}

export type NegotiationResult =
  | { readonly ok: true; readonly revision: string; readonly era: McpEra; readonly note?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the revision to use.
 *
 * A server that answers with a revision we know is accepted. One that answers
 * with something unknown is refused, with the direction of the mismatch reported
 * so `mcp doctor` can tell "upgrade CBC" apart from "the server is ancient".
 */
export function negotiateRevision(
  serverRevision: string,
  options: NegotiationOptions = {},
): NegotiationResult {
  const era = eraFor(serverRevision);
  if (era !== undefined) {
    return { ok: true, revision: serverRevision, era };
  }

  if ((options.compatibleRevisions ?? []).includes(serverRevision)) {
    // Vouched for by configuration. Modern semantics are the safer assumption for
    // an unknown-but-allowed revision: they require less trust in the connection.
    return {
      ok: true,
      revision: serverRevision,
      era: "modern",
      note: `'${serverRevision}' is not built in; it was accepted from configured compatibility metadata`,
    };
  }

  const newer = isNewerThanSupported(serverRevision);
  if (newer === true) {
    return {
      ok: false,
      reason: `the server requires MCP revision '${serverRevision}', which is newer than this build supports (${SUPPORTED_REVISIONS.join(", ")}); update Capybara Code or add explicit compatibility metadata`,
    };
  }
  if (newer === false) {
    return {
      ok: false,
      reason: `the server requires MCP revision '${serverRevision}', which is older than the supported range (${SUPPORTED_REVISIONS.join(", ")})`,
    };
  }
  return {
    ok: false,
    reason: `the server reported an unrecognizable MCP revision '${serverRevision}'`,
  };
}

/** `true` newer, `false` older, `undefined` unparseable. */
function isNewerThanSupported(revision: string): boolean | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) return undefined;
  // Date-shaped revisions sort lexicographically, which is why this format was
  // chosen upstream.
  const newest = SUPPORTED_REVISIONS.reduce((a, b) => (a > b ? a : b));
  const oldest = SUPPORTED_REVISIONS.reduce((a, b) => (a < b ? a : b));
  if (revision > newest) return true;
  if (revision < oldest) return false;
  // Inside the range but not one of ours: treat as newer so it fails closed.
  return true;
}

// ---------------------------------------------------------------------------
// Client capability declaration
// ---------------------------------------------------------------------------

/**
 * What CBC advertises to a server.
 *
 * §17.4's "disabled by default" list is expressed by *omission*: a capability we
 * do not declare is a capability a well-behaved server will not use. The
 * `setRequestHandler` refusals in `client.ts` are the enforcement for servers
 * that ask anyway.
 */
export interface ClientCapabilities {
  readonly roots: { readonly listChanged: boolean };
  /** Declared so servers can send `notifications/message` (§17.4 logging). */
  readonly logging: Record<string, never>;
}

export function clientCapabilities(): ClientCapabilities {
  return {
    // The workspace root, and only the workspace root (§17.4).
    roots: { listChanged: true },
    logging: {},
    // `sampling` and `elicitation` are deliberately absent: §17.4 disables both,
    // and declaring them would invite requests CBC must then refuse.
  };
}

/** Server-declared capabilities, as far as P0 cares. */
export interface ServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean };
  readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
  readonly prompts?: { readonly listChanged?: boolean };
  readonly logging?: Record<string, unknown>;
  readonly completions?: Record<string, unknown>;
  /** Anything else the server claims, kept for diagnostics. */
  readonly experimental?: Record<string, unknown>;
}

export interface InitializeResponse {
  readonly protocolVersion: string;
  readonly capabilities: ServerCapabilities;
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
  readonly instructions?: string;
}

// ---------------------------------------------------------------------------
// §17.4 unsupported request handling
// ---------------------------------------------------------------------------

/** JSON-RPC error codes plus the MCP-specific ones CBC returns. */
export const MCP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * Server→client methods CBC refuses, with the §17.4 reason.
 *
 * §17.4 requires an *explicit protocol error* rather than a timeout or a silent
 * drop, so a server author can see why their feature did not work.
 */
export const REFUSED_SERVER_METHODS: Readonly<Record<string, string>> = {
  "sampling/createMessage":
    "Capybara Code does not grant servers model access; sampling is disabled (§17.4)",
  "elicitation/create":
    "server-initiated elicitation is disabled in this release because it can cause side effects outside the approval path (§17.4)",
  "tasks/create": "the MCP Tasks extension is not supported in this release (§17.4)",
  "tasks/get": "the MCP Tasks extension is not supported in this release (§17.4)",
  "tasks/list": "the MCP Tasks extension is not supported in this release (§17.4)",
  "tasks/cancel": "the MCP Tasks extension is not supported in this release (§17.4)",
};

export interface McpErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/** Build the §17.4 refusal for an unsupported server request. */
export function refusalFor(method: string): McpErrorBody | undefined {
  const reason = REFUSED_SERVER_METHODS[method];
  if (reason === undefined) return undefined;
  return {
    code: MCP_ERROR_CODES.methodNotFound,
    message: reason,
    data: { method, disabledBy: "client-policy" },
  };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  /**
   * Server-supplied hints. §17.8 treats these as a *hint the classifier may
   * override*, never as an authorization.
   */
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
}

/** One content block in a tool or resource result. */
export type McpContent =
  | { readonly type: "text"; readonly text: string; readonly annotations?: Record<string, unknown> }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
      readonly annotations?: Record<string, unknown>;
    }
  | {
      readonly type: "audio";
      readonly data: string;
      readonly mimeType: string;
      readonly annotations?: Record<string, unknown>;
    }
  | {
      readonly type: "resource";
      readonly resource: { readonly uri: string; readonly mimeType?: string; readonly text?: string };
      readonly annotations?: Record<string, unknown>;
    }
  | {
      readonly type: "resource_link";
      readonly uri: string;
      readonly name?: string;
      readonly mimeType?: string;
    };

export interface McpCallToolResult {
  readonly content?: readonly McpContent[];
  /**
   * §17.10 keeps a *tool* error distinct from a *transport* error: the first is an
   * observation the model should act on, the second is a connection problem the
   * model cannot fix.
   */
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

/** Parse an `initialize` result defensively; a server may send anything. */
export function parseInitializeResponse(raw: unknown): InitializeResponse | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const protocolVersion = record.protocolVersion;
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) return undefined;

  const capabilities =
    typeof record.capabilities === "object" && record.capabilities !== null
      ? (record.capabilities as ServerCapabilities)
      : {};

  const serverInfoRaw = record.serverInfo;
  const serverInfo =
    typeof serverInfoRaw === "object" && serverInfoRaw !== null
      ? (serverInfoRaw as { name?: string; version?: string })
      : undefined;

  return {
    protocolVersion,
    capabilities,
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    ...(typeof record.instructions === "string" ? { instructions: record.instructions } : {}),
  };
}

/** Stable hash of a tool's input schema, for §17.6 change detection. */
export function schemaHash(schema: Record<string, unknown> | undefined): string {
  if (schema === undefined) return createHash("sha256").update("undefined").digest("hex");
  // Key order must not change the hash: a server that serializes its schema
  // differently between calls has not actually changed the schema.
  const canonical = canonicalize(schema);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
