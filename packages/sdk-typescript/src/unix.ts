/**
 * Unix domain socket / named-pipe App Protocol transport.
 *
 * Frames match the daemon LocalTransport: 4-byte big-endian length + JSON.
 */

import { createConnection, type Socket } from "node:net";

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface UnixJsonRpcTransport {
  send(message: unknown): Promise<void>;
  subscribe(handler: (message: unknown) => void): () => void;
  close(): void;
}

export function createUnixTransport(path: string, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): UnixJsonRpcTransport {
  return new UnixSocketTransport(path, maxFrameBytes);
}

class UnixSocketTransport implements UnixJsonRpcTransport {
  readonly #socket: Socket;
  readonly #ready: Promise<void>;
  readonly #maxFrameBytes: number;
  readonly #handlers = new Set<(message: unknown) => void>();
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(path: string, maxFrameBytes: number) {
    this.#maxFrameBytes = maxFrameBytes;
    this.#socket = createConnection(path);
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#socket.once("connect", () => resolve());
      this.#socket.once("error", (error) => reject(error));
    });
    this.#socket.on("data", (chunk: Buffer | string) => {
      this.#onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    this.#socket.on("close", () => {
      this.#closed = true;
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.#closed) throw new Error("unix transport is closed");
    await this.#ready;
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.byteLength > this.#maxFrameBytes) {
      throw new Error("outbound frame exceeds maxFrameBytes");
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(Buffer.concat([header, payload]), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  subscribe(handler: (message: unknown) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#handlers.clear();
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > this.#maxFrameBytes) {
        this.close();
        return;
      }
      if (this.#buffer.byteLength < 4 + length) return;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        const value: unknown = JSON.parse(body.toString("utf8"));
        for (const handler of this.#handlers) handler(value);
      } catch {
        this.close();
        return;
      }
    }
  }
}
