import type {
  AcpAdapter,
  AcpJsonRpcResponse,
  AcpPeer,
} from "./adapter.ts";

export interface AcpNdjsonServerOptions {
  readonly adapter: AcpAdapter;
  readonly peer?: AcpNdjsonPeer;
  readonly write: (line: string) => Promise<void> | void;
  readonly maxLineBytes?: number;
}

/** ACP stdio framing: one JSON-RPC object per UTF-8 line. */
export class AcpNdjsonServer {
  readonly #adapter: AcpAdapter;
  readonly #write: AcpNdjsonServerOptions["write"];
  readonly #peer: AcpNdjsonPeer | undefined;
  readonly #maxLineBytes: number;
  #buffer = "";

  constructor(options: AcpNdjsonServerOptions) {
    this.#adapter = options.adapter;
    this.#write = options.write;
    this.#peer = options.peer;
    this.#maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1024) {
      throw new TypeError("maxLineBytes must be an integer of at least 1024");
    }
  }

  async push(chunk: string): Promise<void> {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#buffer = "";
      await this.#write(JSON.stringify(parseError()) + "\n");
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      await this.#handleLine(line);
    }
  }

  async end(): Promise<void> {
    const tail = this.#buffer.trim();
    this.#buffer = "";
    if (tail.length > 0) await this.#handleLine(tail);
  }

  async #handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      await this.#write(JSON.stringify(parseError()) + "\n");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      await this.#write(JSON.stringify(parseError()) + "\n");
      return;
    }
    if (this.#peer?.accept(message) === true) return;
    const response = await this.#adapter.handle(message);
    if (response !== undefined) await this.#write(JSON.stringify(response) + "\n");
  }
}

export class AcpNdjsonPeer implements AcpPeer {
  readonly #write: (line: string) => Promise<void> | void;
  readonly #pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }>();
  #nextId = 1_000_000;

  constructor(write: (line: string) => Promise<void> | void) {
    this.#write = write;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.#write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return await result as T;
  }

  accept(message: unknown): boolean {
    const input = typeof message === "object" && message !== null && !Array.isArray(message)
      ? message as Record<string, unknown>
      : undefined;
    if (input === undefined || typeof input.id !== "number" || (!("result" in input) && !("error" in input))) {
      return false;
    }
    const pending = this.#pending.get(input.id);
    if (pending === undefined) return false;
    this.#pending.delete(input.id);
    if ("error" in input) {
      const error = typeof input.error === "object" && input.error !== null
        ? input.error as Record<string, unknown>
        : {};
      pending.reject(new Error(typeof error.message === "string" ? error.message : "ACP client request failed"));
    } else {
      pending.resolve(input.result);
    }
    return true;
  }

  close(reason = "ACP stdio closed"): void {
    for (const pending of this.#pending.values()) pending.reject(new Error(reason));
    this.#pending.clear();
  }
}

function parseError(): AcpJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "invalid ACP JSON" },
  };
}
