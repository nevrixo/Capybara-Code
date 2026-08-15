#!/usr/bin/env bun
/**
 * A well-behaved MCP stdio server — PRD §17.3, §25.13, AC-29.
 *
 * Newline-delimited JSON-RPC on stdio, no dependencies, so a test can spawn it without
 * an install step. It implements just enough of the surface §17.4 lists for CBC to
 * negotiate, build a catalog, and make a call: `initialize`, `tools/list`,
 * `tools/call`, `resources/list`, `resources/read`, and `ping`.
 *
 * The tool set is chosen to exercise §17.7's classifier rather than to be useful:
 * `echo` reads, `write_note` writes, `delete_note` is destructive, and `fetch_url`
 * reaches the network. Those four map onto the four `McpCapabilityRisk` values, so a
 * catalog built from this server should contain one of each.
 */

const REVISION = "2026-07-28";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const notes = new Map<string, string>([["welcome", "the first note"]]);

function reply(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], isError };
}

const TOOLS = [
  {
    name: "echo",
    description: "Return the text you were given. Reads nothing and changes nothing.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { title: "Echo", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_notes",
    description: "List every stored note key.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { title: "List notes", readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Create or update a note.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
      additionalProperties: false,
    },
    annotations: { title: "Write note", readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "delete_note",
    description: "Permanently remove a note.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: { title: "Delete note", readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "fetch_url",
    description: "Fetch a URL and return the body. Reaches the public internet.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { title: "Fetch URL", readOnlyHint: true, openWorldHint: true },
  },
];

const RESOURCES = [
  {
    uri: "note://welcome",
    name: "welcome",
    description: "The first note.",
    mimeType: "text/plain",
  },
];

function handle(message: JsonRpcMessage): void {
  const id = message.id;
  const method = message.method;
  if (id === undefined || method === undefined) return;

  switch (method) {
    case "initialize": {
      const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      reply(id, {
        // §17.2: echo back the revision this server actually speaks. A server that
        // parroted the client's request would make negotiation meaningless.
        protocolVersion: REVISION,
        capabilities: { tools: { listChanged: true }, resources: { subscribe: false } },
        serverInfo: { name: "echo-stdio-fixture", version: "1.0.0" },
        ...(requested !== undefined && requested !== REVISION
          ? { instructions: `Client asked for ${requested}; this server speaks ${REVISION}.` }
          : {}),
      });
      return;
    }

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "resources/list":
      reply(id, { resources: RESOURCES });
      return;

    case "resources/read": {
      const uri = (message.params as { uri?: string } | undefined)?.uri ?? "";
      const key = uri.replace(/^note:\/\//, "");
      const value = notes.get(key);
      if (value === undefined) {
        replyError(id, -32602, `no such resource: ${uri}`);
        return;
      }
      reply(id, { contents: [{ uri, mimeType: "text/plain", text: value }] });
      return;
    }

    case "tools/call": {
      const params = message.params as { name?: string; arguments?: Record<string, unknown> };
      const name = params?.name ?? "";
      const args = params?.arguments ?? {};

      switch (name) {
        case "echo":
          reply(id, textResult(String(args.text ?? "")));
          return;
        case "list_notes":
          reply(id, textResult([...notes.keys()].sort().join("\n")));
          return;
        case "write_note":
          notes.set(String(args.key ?? ""), String(args.value ?? ""));
          reply(id, textResult(`wrote ${String(args.key ?? "")}`));
          return;
        case "delete_note": {
          const removed = notes.delete(String(args.key ?? ""));
          reply(id, textResult(removed ? `deleted ${String(args.key)}` : "nothing to delete"));
          return;
        }
        case "fetch_url":
          // No actual request: a fixture that reached the network would make every test
          // that uses it dependent on connectivity.
          reply(id, textResult(`would fetch ${String(args.url ?? "")} (fixture makes no request)`));
          return;
        default:
          // §17.10: a tool-level failure is `isError`, not a JSON-RPC error, so the
          // model can observe it as a result.
          reply(id, textResult(`unknown tool: ${name}`, true));
          return;
      }
    }

    default:
      replyError(id, -32601, `method not found: ${method}`);
      return;
  }
}

let buffer = "";
for await (const chunk of process.stdin) {
  buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // A malformed line gets no reply: there is no id to answer, and JSON-RPC
        // parse errors on a notification are not addressable.
      }
    }
    newline = buffer.indexOf("\n");
  }
}
