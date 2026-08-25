/**
 * Current-user-only local transport for the App Protocol.
 *
 * Unix: domain socket (directory 0700, socket 0600) with peer uid checks.
 * Windows: named pipe path \\.\pipe\capybara-code-$uid.
 * Frames are either 4-byte big-endian length-prefixed JSON or NDJSON.
 * Oversized frames are rejected without allocating unbounded buffers.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { userInfo } from "node:os";

export type LocalFrameMode = "length-prefixed" | "ndjson";

export interface LocalTransportOptions {
  readonly path: string;
  readonly maxFrameBytes?: number;
  readonly mode?: LocalFrameMode;
  readonly currentUid?: number;
  readonly onConnection: (connection: LocalConnection) => void;
  readonly onError?: (error: Error) => void;
}

export interface LocalConnection {
  readonly id: string;
  readonly remoteUid?: number;
  send(value: unknown): void;
  close(error?: Error): void;
  onMessage(handler: (value: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
}

export class LocalTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalTransportError";
    this.code = code;
  }
}

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class LocalTransport {
  readonly #options: Required<Pick<LocalTransportOptions, "maxFrameBytes" | "mode">> & LocalTransportOptions;
  readonly #uid: number;
  #server: Server | undefined;
  #nextConnectionId = 0;

  constructor(options: LocalTransportOptions) {
    this.#options = {
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      mode: options.mode ?? "length-prefixed",
      ...options,
    };
    this.#uid = options.currentUid ?? currentUid();
    if (!Number.isSafeInteger(this.#options.maxFrameBytes) || this.#options.maxFrameBytes < 1024) {
      throw new LocalTransportError("DAEMON_TRANSPORT_INVALID", "maxFrameBytes must be >= 1024");
    }
  }

  get path(): string {
    return this.#options.path;
  }

  async listen(): Promise<void> {
    if (this.#server !== undefined) {
      throw new LocalTransportError("DAEMON_TRANSPORT_INVALID", "transport already listening");
    }
    if (process.platform !== "win32") {
      prepareUnixSocketPath(this.#options.path, this.#uid);
    }
    const server = createServer((socket) => this.#accept(socket));
    server.on("error", (error) => {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      try {
        chmodSync(this.#options.path, 0o600);
      } catch (error) {
        server.close();
        throw error;
      }
    }
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (process.platform !== "win32" && existsSync(this.#options.path)) {
      try {
        rmSync(this.#options.path, { force: true });
      } catch {
        // ignore
      }
    }
  }

  #accept(socket: Socket): void {
    const remoteUid = readPeerUid(socket);
    if (remoteUid !== undefined && remoteUid !== this.#uid) {
      socket.destroy(new LocalTransportError(
        "DAEMON_UNAUTHORIZED_CLIENT",
        "peer uid does not match daemon owner",
      ));
      return;
    }
    const connection = new SocketConnection(
      `conn_local_${String(++this.#nextConnectionId)}`,
      socket,
      this.#options.mode,
      this.#options.maxFrameBytes,
      remoteUid,
    );
    this.#options.onConnection(connection);
  }
}

class SocketConnection implements LocalConnection {
  readonly id: string;
  readonly remoteUid?: number;
  readonly #socket: Socket;
  readonly #mode: LocalFrameMode;
  readonly #maxFrameBytes: number;
  readonly #messageHandlers: Array<(value: unknown) => void> = [];
  readonly #closeHandlers: Array<(error?: Error) => void> = [];
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closeError: Error | undefined;

  constructor(
    id: string,
    socket: Socket,
    mode: LocalFrameMode,
    maxFrameBytes: number,
    remoteUid: number | undefined,
  ) {
    this.id = id;
    this.#socket = socket;
    this.#mode = mode;
    this.#maxFrameBytes = maxFrameBytes;
    if (remoteUid !== undefined) this.remoteUid = remoteUid;
    socket.on("data", (chunk: Buffer | string) => {
      this.#onData(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    });
    socket.on("error", (error) => this.close(error));
    socket.on("close", () => this.close(this.#closeError));
  }

  send(value: unknown): void {
    if (this.#closed) {
      throw new LocalTransportError("DAEMON_TRANSPORT_CLOSED", "connection is closed");
    }
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.byteLength > this.#maxFrameBytes) {
      throw new LocalTransportError("DAEMON_FRAME_TOO_LARGE", "outbound frame exceeds maxFrameBytes");
    }
    if (this.#mode === "ndjson") {
      this.#socket.write(Buffer.concat([payload, Buffer.from("\n")]));
      return;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    this.#socket.write(Buffer.concat([header, payload]));
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    this.#socket.destroy();
    for (const handler of this.#closeHandlers) handler(error);
  }

  onMessage(handler: (value: unknown) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.#closeHandlers.push(handler);
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    try {
      if (this.#mode === "ndjson") this.#drainNdjson();
      else this.#drainLengthPrefixed();
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #drainLengthPrefixed(): void {
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > this.#maxFrameBytes) {
        throw new LocalTransportError(
          "DAEMON_FRAME_TOO_LARGE",
          `frame of ${String(length)} bytes exceeds limit ${String(this.#maxFrameBytes)}`,
        );
      }
      if (this.#buffer.byteLength < 4 + length) return;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      this.#emitJson(body);
    }
  }

  #drainNdjson(): void {
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > this.#maxFrameBytes) {
          throw new LocalTransportError(
            "DAEMON_FRAME_TOO_LARGE",
            "ndjson line exceeds maxFrameBytes before delimiter",
          );
        }
        return;
      }
      if (newline > this.#maxFrameBytes) {
        throw new LocalTransportError(
          "DAEMON_FRAME_TOO_LARGE",
          "ndjson line exceeds maxFrameBytes",
        );
      }
      const body = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (body.byteLength === 0) continue;
      this.#emitJson(body);
    }
  }

  #emitJson(body: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      throw new LocalTransportError("DAEMON_FRAME_INVALID", "frame is not valid JSON");
    }
    for (const handler of this.#messageHandlers) handler(value);
  }
}

function prepareUnixSocketPath(socketPath: string, uid: number): void {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = statSync(dir);
  if (typeof stats.uid === "number" && stats.uid !== uid) {
    throw new LocalTransportError(
      "DAEMON_UNAUTHORIZED_CLIENT",
      "socket directory owned by another user",
    );
  }
  chmodSync(dir, 0o700);
  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }
}

function readPeerUid(socket: Socket): number | undefined {
  const maybe = socket as Socket & {
    getPeerCredential?: () => { uid?: number };
  };
  try {
    const credentials = maybe.getPeerCredential?.();
    if (credentials && typeof credentials.uid === "number") return credentials.uid;
  } catch {
    // Platform may not expose peer credentials; uid checks still apply to paths.
  }
  return undefined;
}

function currentUid(): number {
  try {
    return userInfo().uid;
  } catch {
    return 0;
  }
}

export function windowsPipePath(uid = currentUid()): string {
  return `\\\\.\\pipe\\capybara-code-${String(uid)}`;
}
