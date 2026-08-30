import { describe, expect, test } from "bun:test";

import {
  OpenAiResponsesProvider,
  fakeLease,
  normalizeResponseItem,
  replayableResponseItems,
  sseStream,
  type FetchLike,
  type ModelEvent,
  type ModelRequest,
  type OpenAiProviderOptions,
} from "../src/index.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "req_ptc",
    model: "gpt-5.6",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] }],
    tools: [],
    reasoning: { mode: "standard", effort: "medium", summary: "auto", context: "all_turns" },
    maxOutputTokens: 4_000,
    store: false,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function captureBody(
  modelRequest: ModelRequest,
  providerOptions: Omit<Partial<OpenAiProviderOptions>, "credential"> = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const provider = new OpenAiResponsesProvider({
    credential: fakeLease(),
    ...providerOptions,
    fetchImpl: (async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sseStream([{ type: "response.completed", response: { id: "resp_done" } }]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as FetchLike,
  });
  await collect(provider.stream(modelRequest, new AbortController().signal));
  return captured;
}

const readTool = {
  name: "fs.read",
  description: "Return a bounded file excerpt.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      text: { type: "string" },
    },
    required: ["path", "text"],
    additionalProperties: false,
  },
  allowedCallers: ["programmatic"] as const,
  strict: true as const,
};

describe("Programmatic Tool Calling wire contract", () => {
  test("serializes the explicit hosted tool and eligible function contract", async () => {
    const body = await captureBody(request({
      tools: [readTool],
      hostedTools: [{ type: "programmatic_tool_calling" }],
    }));

    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.allowed_callers).toEqual(["programmatic"]);
    expect(tools[0]?.output_schema).toEqual(readTool.outputSchema);
    expect(tools[1]).toEqual({ type: "programmatic_tool_calling" });
  });

  test("does not expose program-only functions when the backend cannot run PTC", async () => {
    const body = await captureBody(
      request({
        model: "gpt-5.6-sol",
        tools: [readTool],
        hostedTools: [{ type: "programmatic_tool_calling" }],
      }),
      { chatGpt: { accountId: "acct" } },
    );

    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("allowed_callers");
    expect(JSON.stringify(body)).not.toContain("output_schema");
    expect(JSON.stringify(body)).not.toContain("programmatic_tool_calling");
  });

  test("parses program items and preserves nested caller linkage", async () => {
    const provider = new OpenAiResponsesProvider({
      credential: fakeLease(),
      fetchImpl: (async () =>
        new Response(
          sseStream([
            {
              type: "response.output_item.done",
              item_id: "prog_1",
              sequence_number: 1,
              item: {
                type: "program",
                id: "prog_1",
                call_id: "call_prog_1",
                code: "text('ok')",
                fingerprint: "opaque_fingerprint",
              },
            },
            {
              type: "response.output_item.added",
              item_id: "fc_1",
              sequence_number: 2,
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_read_1",
                name: "fs_read",
                arguments: "",
                caller: { type: "program", caller_id: "call_prog_1" },
              },
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "fc_1",
              sequence_number: 3,
              arguments: '{"path":"README.md"}',
            },
            {
              type: "response.output_item.done",
              item_id: "prog_out_1",
              sequence_number: 4,
              item: {
                type: "program_output",
                id: "prog_out_1",
                call_id: "call_prog_1",
                result: '{"status":"complete"}',
                status: "completed",
              },
            },
            { type: "response.completed", sequence_number: 5, response: { id: "resp_1", output: [] } },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        )) as FetchLike,
    });

    const events = await collect(provider.stream(request(), new AbortController().signal));
    const program = events.find(
      (event): event is Extract<ModelEvent, { type: "response.item" }> =>
        event.type === "response.item" && event.item.kind === "program",
    );
    expect(program?.item).toMatchObject({
      kind: "program",
      itemId: "prog_1",
      callId: "call_prog_1",
      code: "text('ok')",
      fingerprint: "opaque_fingerprint",
    });

    const call = events.find(
      (event): event is Extract<ModelEvent, { type: "tool.call.completed" }> =>
        event.type === "tool.call.completed",
    );
    expect(call?.call).toMatchObject({
      callId: "call_read_1",
      caller: { type: "program", callerId: "call_prog_1" },
      callerId: "call_prog_1",
      programId: "call_prog_1",
      argumentsText: '{"path":"README.md"}',
    });

    const programOutput = events.find(
      (event): event is Extract<ModelEvent, { type: "response.item" }> =>
        event.type === "response.item" && event.item.kind === "program_output",
    );
    expect(programOutput?.item).toMatchObject({
      kind: "program_output",
      itemId: "prog_out_1",
      callId: "call_prog_1",
      result: '{"status":"complete"}',
      status: "completed",
    });
  });

  test("serializes every PTC item needed for store:false continuation", async () => {
    const caller = { type: "program" as const, callerId: "call_prog_1" };
    const body = await captureBody(request({
      tools: [readTool],
      hostedTools: [{ type: "programmatic_tool_calling" }],
      input: [
        {
          type: "program",
          itemId: "prog_1",
          callId: "call_prog_1",
          code: "const value = await tools.fs_read({ path: 'README.md' }); text(value.text);",
          fingerprint: "opaque_fingerprint",
        },
        {
          type: "function_call",
          itemId: "fc_1",
          callId: "call_read_1",
          name: "fs.read",
          argumentsText: '{"path":"README.md"}',
          caller,
        },
        {
          type: "function_call_output",
          callId: "call_read_1",
          output: '{"path":"README.md","text":"hello"}',
          caller,
        },
        {
          type: "program_output",
          itemId: "prog_out_1",
          callId: "call_prog_1",
          result: '{"status":"complete"}',
          status: "completed",
        },
      ],
    }));

    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "program",
      id: "prog_1",
      call_id: "call_prog_1",
      code: "const value = await tools.fs_read({ path: 'README.md' }); text(value.text);",
      fingerprint: "opaque_fingerprint",
    });
    expect(input[1]?.caller).toEqual({ type: "program", caller_id: "call_prog_1" });
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_read_1",
      output: '{"path":"README.md","text":"hello"}',
      caller: { type: "program", caller_id: "call_prog_1" },
    });
    expect(input[3]).toEqual({
      type: "program_output",
      id: "prog_out_1",
      call_id: "call_prog_1",
      result: '{"status":"complete"}',
      status: "completed",
    });
  });

  test("response item replay retains program state and caller verbatim", () => {
    const envelopes = [
      normalizeResponseItem({
        type: "program",
        id: "prog_1",
        call_id: "call_prog_1",
        code: "text('ok')",
        fingerprint: "opaque_fingerprint",
      }, { sequence: 0 }),
      normalizeResponseItem({
        type: "function_call",
        id: "fc_1",
        call_id: "call_read_1",
        name: "fs_read",
        arguments: "{}",
        caller: { type: "program", caller_id: "call_prog_1" },
      }, { sequence: 1 }),
      normalizeResponseItem({
        type: "function_call_output",
        call_id: "call_read_1",
        output: "{}",
        caller: { type: "program", caller_id: "call_prog_1" },
      }, { sequence: 2 }),
      normalizeResponseItem({
        type: "program_output",
        id: "prog_out_1",
        call_id: "call_prog_1",
        result: '{"ok":true}',
        status: "completed",
      }, { sequence: 3 }),
    ];

    expect(replayableResponseItems(envelopes)).toEqual([
      {
        type: "program",
        itemId: "prog_1",
        callId: "call_prog_1",
        code: "text('ok')",
        fingerprint: "opaque_fingerprint",
      },
      {
        type: "function_call",
        itemId: "fc_1",
        callId: "call_read_1",
        name: "fs_read",
        argumentsText: "{}",
        caller: { type: "program", callerId: "call_prog_1" },
        callerId: "call_prog_1",
        programId: "call_prog_1",
      },
      {
        type: "function_call_output",
        callId: "call_read_1",
        output: "{}",
        caller: { type: "program", callerId: "call_prog_1" },
        callerId: "call_prog_1",
        programId: "call_prog_1",
      },
      {
        type: "program_output",
        itemId: "prog_out_1",
        callId: "call_prog_1",
        result: '{"ok":true}',
        status: "completed",
      },
    ]);
  });
});
