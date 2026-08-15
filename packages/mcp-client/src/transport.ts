/**
 * MCP transports — PRD §17.3, §17.12, AC-29, AC-30, AC-33.
 *
 * Two transports, with different trust properties:
 *
 * **stdio** launches a local process. §19.6 assigns child supervision to the Rust
 * runtime, so this module never spawns anything itself — it speaks through an
 * injected `StdioChannel` the host wires to `process.start`. That keeps §17.12's
 * "stdio command supply-chain compromise" inside the one process boundary built to
 * contain it.
 *
 * **Streamable HTTP** is network I/O, which §19.4 assigns to TypeScript. HTTPS is
 * the default, redirects are origin-checked, and TLS verification is not
 * configurable — §17.3 states plainly that a project config cannot weaken it.
 */

import { MCP_PROTOCOL_HEADER, MCP_ERROR_CODES, type McpErrorBody } from "./protocol.ts";

export type McpTransportKind = "stdio" | "streamable_http";

export interface McpNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** A server→client request. The handler's answer is sent back verbatim. */
export type ServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<{ result: unknown } | { error: McpErrorBody }>;

export type NotificationHandler = (notification: McpNotification) => void;

export class McpTransportError extends Error {
  readonly kind: "transport";
  readonly retryable: boolean;
  readonly detail: Record<string, unknown> | undefined;

  constructor(message: string, options: { retryable?: boolean; detail?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "McpTransportError";
    this.kind = "transport";
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

/** An error the *server* returned. Distinct from a transport failure (§17.10). */
export class McpProtocolError extends Error {
  readonly kind: "protocol";
  readonly code: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(body: McpErrorBody) {
    super(body.message);
    this.name = "McpProtocolError";
    this.kind = "protocol";
    this.code = body.code;
    this.data = body.data;
  }
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Negotiated revision, sent as request metadata on the modern era (§17.2). */
  readonly protocolVersion?: string;
}

export interface McpTransport {
  readonly kind: McpTransportKind;
  readonly serverName: string;
  start(): Promise<void>;
  request(method: string, params: unknown, options?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  setNotificationHandler(handler: NotificationHandler): void;
  setServerRequestHandler(handler: ServerRequestHandler): void;
  /** Diagnostic lines, e.g. a stdio server's stderr (§17.3). */
  setDiagnosticHandler(handler: (line: string) => void): void;
}

/** §17.3 default per-request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** §17.3 response size cap, so one server cannot exhaust memory (§17.12). */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

/**
 * The stdio pipe, supplied by the host and backed by the Rust process supervisor.
 *
 * MCP stdio frames messages as newline-delimited JSON, so the channel deals in
 * whole lines and this module never parses bytes.
 */
export interface StdioChannel {
  /** Launch the server process. Rejects if the command is not approved. */
  start(): Promise<void>;
  /** Write one newline-delimited JSON message. */
  write(line: string): Promise<void>;
  /** Called for each line the server writes to stdout. */
  onLine(handler: (line: string) => void): void;
  /** Called for each stderr line (§17.3 diagnostic capture). */
  onDiagnostic(handler: (line: string) => void): void;
  /** Called when the process exits, so the client can decide about restart. */
  onExit(handler: (code: number | undefined) => void): void;
  stop(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  method: string;
  abortCleanup?: () => void;
}

/** JSON-RPC over newline-delimited stdio. */
export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  readonly serverName: string;

  readonly #channel: StdioChannel;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #closed = false;
  #notify: NotificationHandler = () => {};
  #serverRequest: ServerRequestHandler | undefined;
  #diagnostic: (line: string) => void = () => {};

  constructor(options: {
    serverName: string;
    channel: StdioChannel;
    timeoutMs?: number;
  }) {
    this.serverName = options.serverName;
    this.#channel = options.channel;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    this.#closed = false;
    this.#channel.onLine((line) => this.#handleLine(line));
    this.#channel.onDiagnostic((line) => this.#diagnostic(line));
    this.#channel.onExit((code) => this.#handleExit(code));
    await this.#channel.start();
  }

  async request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.#closed) {
      throw new McpTransportError(`server '${this.serverName}' is not running`, { retryable: true });
    }
    const id = this.#nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    return await new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.get(id)?.abortCleanup?.();
              this.#pending.delete(id);
              reject(
                new McpTransportError(
                  `'${method}' on server '${this.serverName}' timed out after ${timeoutMs} ms`,
                  { retryable: true },
                ),
              );
            }, timeoutMs)
          : undefined;

      this.#pending.set(id, { resolve, reject, timer, method });

      if (options.signal !== undefined) {
        const onAbort = (): void => {
          this.#settle(id, undefined, new McpTransportError(`'${method}' was cancelled`));
        };
        if (options.signal.aborted) onAbort();
        else {
          options.signal.addEventListener("abort", onAbort, { once: true });
          const pending = this.#pending.get(id);
          if (pending !== undefined) {
            pending.abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
          }
        }
      }

      void this.#channel.write(payload).catch((error: unknown) => {
        this.#settle(
          id,
          undefined,
          new McpTransportError(
            `failed to write to server '${this.serverName}': ${describe(error)}`,
            { retryable: true },
          ),
        );
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    await this.#channel.write(payload);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, undefined, new McpTransportError("the transport was closed"));
    }
    await this.#channel.stop();
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.#notify = handler;
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequest = handler;
  }

  setDiagnosticHandler(handler: (line: string) => void): void {
    this.#diagnostic = handler;
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // §17.12 "malformed JSON server": a stdout line that is not JSON is noise,
      // not a protocol violation worth tearing the connection down for. Some
      // servers print banners.
      this.#diagnostic(`non-JSON stdout: ${trimmed.slice(0, 200)}`);
      return;
    }

    void this.#dispatch(parsed);
  }

  async #dispatch(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;

    // ---- Response to one of our requests ----
    if (record.id !== undefined && record.method === undefined) {
      const id = typeof record.id === "number" ? record.id : Number(record.id);
      if (!Number.isFinite(id)) return;
      if (record.error !== undefined) {
        this.#settle(id, undefined, new McpProtocolError(toErrorBody(record.error)));
      } else {
        this.#settle(id, record.result, undefined);
      }
      return;
    }

    // ---- Server → client request ----
    if (typeof record.method === "string" && record.id !== undefined) {
      const answer =
        this.#serverRequest === undefined
          ? {
              error: {
                code: MCP_ERROR_CODES.methodNotFound,
                message: `'${record.method}' is not supported by this client`,
              },
            }
          : await this.#serverRequest(record.method, record.params);

      const response =
        "error" in answer
          ? { jsonrpc: "2.0", id: record.id, error: answer.error }
          : { jsonrpc: "2.0", id: record.id, result: answer.result };
      await this.#channel.write(JSON.stringify(response)).catch(() => undefined);
      return;
    }

    // ---- Notification ----
    if (typeof record.method === "string") {
      this.#notify({
        method: record.method,
        ...(record.params !== undefined ? { params: record.params } : {}),
      });
    }
  }

  #settle(id: number, result: unknown, error: Error | undefined): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.abortCleanup?.();
    if (error !== undefined) pending.reject(error);
    else pending.resolve(result);
  }

  #handleExit(code: number | undefined): void {
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) {
      this.#settle(
        id,
        undefined,
        new McpTransportError(
          `server '${this.serverName}' exited${code === undefined ? "" : ` with code ${code}`} before responding`,
          { retryable: true },
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface StreamableHttpOptions {
  readonly serverName: string;
  readonly url: string;
  readonly fetchImpl?: HttpFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Supplies the Authorization header value, refreshed per request (§17.9). */
  readonly authorization?: () => Promise<string | undefined>;
  /** Extra headers from config. Cannot include Authorization or override TLS. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Allow `http://` for a loopback development server only. */
  readonly allowInsecureLoopback?: boolean;
}

/**
 * Validate a server URL before any request is made.
 *
 * §17.3 makes HTTPS the default. Plain HTTP is permitted only against loopback and
 * only when the operator asked for it: a development server on `localhost` is not
 * exposed to the network, whereas `http://` to a remote host would send an OAuth
 * bearer token in clear text.
 */
export function validateServerUrl(
  raw: string,
  options: { allowInsecureLoopback?: boolean } = {},
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `'${raw}' is not a valid URL` };
  }

  if (url.protocol === "https:") return { ok: true, url };

  if (url.protocol === "http:") {
    if (options.allowInsecureLoopback === true && isLoopback(url.hostname)) {
      return { ok: true, url };
    }
    return {
      ok: false,
      reason:
        url.hostname.length > 0 && isLoopback(url.hostname)
          ? `'${raw}' uses http://; set allowInsecureLoopback to permit a local development server`
          : `'${raw}' must use https:// (§17.3)`,
    };
  }

  return { ok: false, reason: `unsupported URL scheme '${url.protocol}'` };
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Whether a redirect target is acceptable.
 *
 * §17.3 requires redirect origin checks. Same-origin is fine. A cross-origin
 * redirect is refused because the request carries a bearer token scoped to the
 * original origin, and following it would hand that token to a third party —
 * §17.12's confused-deputy threat in its simplest form.
 */
export function isAllowedRedirect(from: URL, to: URL): boolean {
  if (to.protocol !== "https:") return false;
  return from.origin === to.origin;
}

/** Headers a project config may not set, per §17.3 and §17.5. */
const PROTECTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  MCP_PROTOCOL_HEADER,
]);

export function sanitizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): { headers: Record<string, string>; rejected: string[] } {
  const out: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (PROTECTED_HEADERS.has(key.toLowerCase())) {
      // §17.5: a project server cannot override the credential source.
      rejected.push(key);
      continue;
    }
    out[key] = value;
  }
  return { headers: out, rejected };
}

/**
 * Streamable HTTP transport.
 *
 * The modern era is stateless: every request is a self-contained POST, so there is
 * no session to lose and a failed request can simply be retried (§17.2). A server
 * that answers `text/event-stream` has its events drained for the one response
 * belonging to this request.
 */
export class StreamableHttpTransport implements McpTransport {
  readonly kind = "streamable_http" as const;
  readonly serverName: string;

  readonly #options: StreamableHttpOptions;
  readonly #fetch: HttpFetch;
  readonly #headers: Record<string, string>;
  #url: URL;
  #nextId = 1;
  #closed = false;
  #sessionId: string | undefined;
  #notify: NotificationHandler = () => {};
  #diagnostic: (line: string) => void = () => {};
  #serverRequest: ServerRequestHandler | undefined;
  readonly rejectedHeaders: string[];

  constructor(options: StreamableHttpOptions) {
    const validated = validateServerUrl(options.url, {
      ...(options.allowInsecureLoopback !== undefined
        ? { allowInsecureLoopback: options.allowInsecureLoopback }
        : {}),
    });
    if (!validated.ok) throw new McpTransportError(validated.reason);

    this.serverName = options.serverName;
    this.#options = options;
    this.#url = validated.url;
    this.#fetch = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    const sanitized = sanitizeHeaders(options.headers);
    this.#headers = sanitized.headers;
    this.rejectedHeaders = sanitized.rejected;
  }

  async start(): Promise<void> {
    // Stateless by design: nothing to open. The first `initialize` request
    // establishes whatever state the era needs.
    this.#closed = false;
  }

  async request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.#closed) {
      throw new McpTransportError(`transport for '${this.serverName}' is closed`);
    }

    const id = this.#nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    const response = await this.#send(body, options);
    const message = await this.#readResponse(response, id);

    if (message === undefined) {
      throw new McpTransportError(
        `server '${this.serverName}' returned no response for '${method}'`,
        { retryable: true },
      );
    }
    if (message.error !== undefined) throw new McpProtocolError(toErrorBody(message.error));
    return message.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    // A notification has no id, so the server answers 202 with no body.
    await this.#send(body, {});
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.#notify = handler;
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequest = handler;
  }

  setDiagnosticHandler(handler: (line: string) => void): void {
    this.#diagnostic = handler;
  }

  async #send(body: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.#headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (options.protocolVersion !== undefined) {
      headers[MCP_PROTOCOL_HEADER] = options.protocolVersion;
    }
    if (this.#sessionId !== undefined) headers["mcp-session-id"] = this.#sessionId;

    const token = await this.#options.authorization?.();
    if (token !== undefined && token.length > 0) headers.authorization = token;

    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      let current = this.#url;
      let response: Response;
      let hops = 0;

      for (;;) {
        response = await this.#fetch(current.toString(), {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          // Redirects are inspected here rather than followed blindly, so the
          // origin check below actually runs.
          redirect: "manual",
        });

        if (![301, 302, 303, 307, 308].includes(response.status)) break;

        hops += 1;
        if (hops > 3) {
          throw new McpTransportError(`server '${this.serverName}' redirected too many times`);
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new McpTransportError(
            `server '${this.serverName}' sent a redirect with no Location header`,
          );
        }
        const next = new URL(location, current);
        if (!isAllowedRedirect(current, next)) {
          // §17.12 confused deputy: never carry the token to another origin.
          throw new McpTransportError(
            `server '${this.serverName}' redirected from ${current.origin} to ${next.origin}; a cross-origin redirect is refused because it would leak the authorization header (§17.3)`,
            { detail: { from: current.origin, to: next.origin } },
          );
        }
        current = next;
      }

      const session = response.headers.get("mcp-session-id");
      if (session !== null && session.length > 0) this.#sessionId = session;

      if (!response.ok) {
        throw new McpTransportError(
          `server '${this.serverName}' returned HTTP ${response.status}`,
          {
            retryable: response.status === 429 || response.status >= 500,
            detail: { status: response.status },
          },
        );
      }
      return response;
    } catch (error) {
      if (error instanceof McpTransportError || error instanceof McpProtocolError) throw error;
      throw new McpTransportError(
        `request to server '${this.serverName}' failed: ${describe(error)}`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the response, handling both a plain JSON body and an SSE stream.
   *
   * In the SSE case the stream may carry notifications and server requests
   * interleaved with the response we are waiting for, so each event is dispatched
   * and only the matching id resolves the call.
   */
  async #readResponse(
    response: Response,
    id: number,
  ): Promise<{ result?: unknown; error?: unknown } | undefined> {
    if (response.status === 202) return undefined;

    const maxBytes = this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream")) {
      const text = await readCapped(response, maxBytes, this.serverName);
      if (text.trim().length === 0) return undefined;
      const parsed = parseJson(text, this.serverName);
      return this.#matchOrDispatch(parsed, id);
    }

    const text = await readCapped(response, maxBytes, this.serverName);
    for (const event of parseSseEvents(text)) {
      const parsed = parseJsonOrUndefined(event);
      if (parsed === undefined) continue;
      const matched = this.#matchOrDispatch(parsed, id);
      if (matched !== undefined) return matched;
    }
    return undefined;
  }

  /**
   * Either this is the response we are waiting for, or it is traffic that belongs
   * to the notification/request handlers.
   */
  #matchOrDispatch(
    message: unknown,
    id: number,
  ): { result?: unknown; error?: unknown } | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const record = message as Record<string, unknown>;

    if (record.id !== undefined && record.method === undefined) {
      const messageId = typeof record.id === "number" ? record.id : Number(record.id);
      if (messageId === id) {
        return {
          ...(record.result !== undefined ? { result: record.result } : {}),
          ...(record.error !== undefined ? { error: record.error } : {}),
        };
      }
      return undefined;
    }

    if (typeof record.method === "string" && record.id === undefined) {
      this.#notify({
        method: record.method,
        ...(record.params !== undefined ? { params: record.params } : {}),
      });
      return undefined;
    }

    if (typeof record.method === "string" && this.#serverRequest !== undefined) {
      // A server request arriving inside a response stream cannot be answered on
      // that stream. It is recorded rather than silently dropped.
      this.#diagnostic(
        `server request '${record.method}' arrived inside a response stream and cannot be answered`,
      );
    }
    return undefined;
  }
}

async function readCapped(response: Response, maxBytes: number, serverName: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new McpTransportError(
      `server '${serverName}' declared a ${declared} byte response, over the ${maxBytes} byte cap (§17.3)`,
    );
  }

  const body = response.body;
  if (body === null) return await response.text();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // §17.12 "oversized output server": stop reading rather than buffering it.
        throw new McpTransportError(
          `server '${serverName}' exceeded the ${maxBytes} byte response cap (§17.3)`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/** Split an SSE body into its `data:` payloads. */
export function parseSseEvents(body: string): string[] {
  const events: string[] = [];
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length > 0) events.push(data);
  }
  return events;
}

function parseJson(text: string, serverName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpTransportError(`server '${serverName}' returned a body that is not valid JSON`);
  }
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toErrorBody(raw: unknown): McpErrorBody {
  if (typeof raw !== "object" || raw === null) {
    return { code: MCP_ERROR_CODES.internalError, message: String(raw) };
  }
  const record = raw as Record<string, unknown>;
  return {
    code: typeof record.code === "number" ? record.code : MCP_ERROR_CODES.internalError,
    message: typeof record.message === "string" ? record.message : "server error",
    ...(typeof record.data === "object" && record.data !== null
      ? { data: record.data as Record<string, unknown> }
      : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** §17.3 bounded restart backoff for a stdio server that exits. */
export function restartDelayMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Jitter so several servers failing together do not retry in lockstep.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}
